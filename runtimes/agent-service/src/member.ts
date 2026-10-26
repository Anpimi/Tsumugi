import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model, UserMessage } from "@earendil-works/pi-ai";
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { MemberSharedView } from "./generated/frame.js";

/** Captured by the application. These references never grant execution rights. */
export interface MemberBasis {
  memberId: string;
  workItemId: string;
  contextVersion: string;
}
export interface PreparedMemberRequest {
  basis: MemberBasis;
  messages: AgentMessage[];
}
export interface PreparedMemberRequestResult {
  requestId: string;
  sharedView: MemberSharedView | null;
}
export interface MemberHttpRequest {
  basis: MemberBasis;
  requestId: string;
  url: string;
  body: string;
  signal: AbortSignal;
}
export interface MemberPorts {
  /** Await the application's request capture/current-authorization check. */
  prepare(request: PreparedMemberRequest, signal?: AbortSignal): Promise<PreparedMemberRequestResult>;
  /** The trusted host owns credentials, physical-attempt budgets, IO and usage. */
  request(request: MemberHttpRequest): Promise<Response>;
  providerEvent(identity: MemberRequestIdentity, event: unknown): Promise<void>;
  beforeToolCall(identity: MemberRequestIdentity, ...args: Parameters<NonNullable<AgentOptions["beforeToolCall"]>>): ReturnType<NonNullable<AgentOptions["beforeToolCall"]>>;
  afterToolCall(identity: MemberRequestIdentity, ...args: Parameters<NonNullable<AgentOptions["afterToolCall"]>>): ReturnType<NonNullable<AgentOptions["afterToolCall"]>>;
  finishTurn(identity: MemberRequestIdentity, ...args: Parameters<NonNullable<AgentOptions["finishTurn"]>>): ReturnType<NonNullable<AgentOptions["finishTurn"]>>;
  /** Acknowledged application records; a Pi event is not a business receipt. */
  event(identity: MemberRequestIdentity | null, event: AgentEvent, signal: AbortSignal): Promise<void>;
}
export interface MemberRequestIdentity { basis: MemberBasis; requestId: string }
export interface MemberOptions {
  basis: MemberBasis;
  model: Model<"openai-completions"> | Model<"openai-responses">;
  /** Exact authorized endpoint for the captured transport profile. */
  endpoint: string;
  systemPrompt: string;
  context: AgentMessage[];
  tools: AgentTool[];
  maxTurns: number;
  ports: MemberPorts;
}

/** The subscription preview requires developer messages and namespaced tools.
 * Pi still owns message/tool serialization; its public payload hook adapts only
 * these documented carrier requirements, without changing the agent transcript.
 */
function subscriptionPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || !("input" in payload) || !Array.isArray(payload.input)) {
    throw new Error("Invalid Pi Responses payload");
  }
  const input = payload.input.map(item => {
    if (item !== null && typeof item === "object" && "role" in item && item.role === "system") {
      return { ...item, role: "developer" };
    }
    return item;
  });
  const tools = "tools" in payload ? payload.tools : undefined;
  if (tools !== undefined && (!Array.isArray(tools) || !tools.length)) throw new Error("Invalid Pi Responses tools");
  return { ...payload, input, ...(tools ? { tools: [{ type: "namespace", name: "tsumugi",
    description: "Tools admitted for this captured task.", tools }] } : {}) };
}

function responseRefusal(event: unknown): boolean {
  if (event === null || typeof event !== "object" || !("type" in event) || typeof event.type !== "string") return false;
  if (event.type.startsWith("response.refusal.")) return true;
  const hasRefusal = (item: unknown) => item !== null && typeof item === "object" && "content" in item
    && Array.isArray(item.content) && item.content.some(block => block !== null && typeof block === "object"
      && "type" in block && block.type === "refusal");
  if (event.type === "response.output_item.done" && "item" in event) return hasRefusal(event.item);
  return event.type === "response.completed" && "response" in event && event.response !== null
    && typeof event.response === "object" && "output" in event.response && Array.isArray(event.response.output)
    && event.response.output.some(hasRefusal);
}

/** One Pi execution instance. The host remains the authorization/mutation owner. */
export class MemberKernel {
  private readonly agent: Agent;
  private readonly basis: MemberBasis;
  private readonly ports: MemberPorts;
  private readonly endpoint: string;
  private running = false;
  private closed = false;
  private turns = 0;
  private turnLimitReached = false;
  private requestIdentity: MemberRequestIdentity | null = null;
  private sharedView: Readonly<MemberSharedView> | null = null;

  constructor(options: MemberOptions) {
    if (!["openai-completions", "openai-responses"].includes(options.model.api) || !Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) {
      throw new Error("Unsupported member execution profile");
    }
    const endpoint = new URL(options.endpoint);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search
      || endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
      throw new Error("Invalid controlled model endpoint");
    }
    const base = options.model.baseUrl.replace(/\/$/, "");
    const subscription = options.model.api === "openai-responses";
    if ((subscription && (endpoint.href !== "https://api.openai.com/v1/responses"
        || options.model.provider !== "openai" || options.model.maxTokens !== 0)
      || `${base}/${subscription ? "responses" : "chat/completions"}` !== endpoint.href)
      || options.model.headers && Object.keys(options.model.headers).length) {
      throw new Error("Model endpoint or headers do not match the controlled profile");
    }
    this.endpoint = endpoint.href;
    this.basis = Object.freeze(structuredClone(options.basis));
    this.ports = options.ports;
    const model = structuredClone(options.model), maxTurns = options.maxTurns;
    this.agent = new Agent({
      initialState: { model, systemPrompt: options.systemPrompt, messages: structuredClone(options.context), tools: [...options.tools], thinkingLevel: "off" },
      transport: "sse",
      toolExecution: "sequential",
      // No ambient credentials, provider catalog, extensions or arbitrary file tools.
      getApiKey: () => undefined,
      prepareRequest: async ({ context }, signal) => {
        if (this.closed) throw new Error("Member admission has closed");
        this.requestIdentity = null;
        this.sharedView = null;
        const prepared = await this.ports.prepare({ basis: this.basis, messages: structuredClone(context.messages) }, signal);
        if (this.closed || signal?.aborted) throw new DOMException("Member preparation cancelled", "AbortError");
        const { requestId, sharedView } = prepared;
        if (typeof requestId !== "string" || !requestId.length) throw new Error("Missing original model request identity");
        if (sharedView !== null && (typeof sharedView.viewId !== "string" || !sharedView.viewId.length || typeof sharedView.utf8 !== "string")) {
          throw new Error("Invalid captured shared view");
        }
        this.sharedView = sharedView === null ? null : Object.freeze(structuredClone(sharedView));
        this.requestIdentity = Object.freeze({ basis: this.basis, requestId });
      },
      transformContext: async messages => {
        this.identity();
        if (!this.sharedView) return messages;
        // Core owns the frozen data, its real authors/sources and sharing basis.
        // This projection never enters Pi's local transcript or replaces input
        // and tool pairs already accepted by its execution loop.
        let leading = 0;
        while (messages[leading]?.role === "system") leading++;
        const shared: UserMessage = { role: "user", content: this.sharedView.utf8, timestamp: 0 };
        return [...messages.slice(0, leading), shared, ...messages.slice(leading)];
      },
      streamFn: (_selected, context, runtime) => {
        let refused = false;
        const streamOptions = {
          ...(runtime?.signal ? { signal: runtime.signal } : {}),
          apiKey: "controlled-host-transport",
          env: {},
          maxRetries: 0,
          ...(model.api === "openai-responses" ? { onPayload: subscriptionPayload } : {}),
          onProviderStreamEvent: async (event: unknown) => {
            await this.ports.providerEvent(this.identity(), event);
            if (model.api === "openai-responses") refused ||= responseRefusal(event);
            if (refused && event !== null && typeof event === "object" && "type" in event && event.type === "response.completed") {
              throw new Error("The controlled model refused the request");
            }
          },
          transport: "sse" as const,
          maxTokens: model.maxTokens,
          fetch: (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => this.fetch(input, init),
        };
        return model.api === "openai-responses"
          ? streamResponses(model, context, streamOptions)
          : streamCompletions(model, context, streamOptions);
      },
      beforeToolCall: (context, signal) => this.ports.beforeToolCall(this.identity(), context, signal),
      afterToolCall: (context, signal) => this.ports.afterToolCall(this.identity(), context, signal),
      finishTurn: async (turn, signal) => {
        const decision = await this.ports.finishTurn(this.identity(), turn, signal);
        if (++this.turns >= maxTurns) {
          this.turnLimitReached = decision?.action !== "end"
            && (turn.message.stopReason === "toolUse" || decision?.action === "continue");
          return { action: "end" };
        }
        return decision ?? undefined;
      },
    });
    this.agent.subscribe((event, signal) => this.ports.event(this.requestIdentity, event, signal));
  }

  private identity(): MemberRequestIdentity {
    if (!this.requestIdentity) throw new Error("Member has no prepared model request");
    return this.requestIdentity;
  }

  private async fetch(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    if (this.closed || request.url !== this.endpoint || request.method !== "POST" || request.signal.aborted) {
      throw new Error("Model request is outside the captured member profile");
    }
    const body = await request.text();
    if (this.closed || request.signal.aborted) throw new Error("Member request was cancelled before dispatch");
    // Never pass SDK authentication or arbitrary headers to the host. It binds its
    // own destination/credentials and checks authorization at every real attempt.
    return this.ports.request({ ...this.identity(), url: this.endpoint, body, signal: request.signal });
  }

  async prompt(input: UserMessage) {
    if (this.closed || this.running) throw new Error("Member is closed or already running");
    this.running = true;
    this.turns = 0;
    this.turnLimitReached = false;
    this.requestIdentity = null;
    this.sharedView = null;
    try {
      await this.agent.prompt(structuredClone(input));
      await this.agent.waitForIdle();
      return { messages: structuredClone(this.agent.state.messages), turnLimitReached: this.turnLimitReached };
    } finally {
      this.running = false;
    }
  }

  /** Caller supplies a freshly authorized, source-labelled user message. */
  guide(message: UserMessage) {
    if (this.closed || !this.running) throw new Error("Member is not accepting guidance");
    this.agent.steer(structuredClone(message));
  }

  /** The application must persist revocation before closing local admission. */
  async close() {
    this.closed = true;
    this.sharedView = null;
    this.agent.clearAllQueues();
    this.agent.abort();
    await this.agent.waitForIdle();
  }
}
