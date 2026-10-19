import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model, UserMessage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

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
export interface MemberHttpRequest {
  basis: MemberBasis;
  requestId: string;
  url: string;
  body: string;
  signal: AbortSignal;
}
export interface MemberPorts {
  /** Await the application's request capture/current-authorization check. */
  prepare(request: PreparedMemberRequest, signal?: AbortSignal): Promise<string>;
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
  model: Model<"openai-completions">;
  /** Exact authorized endpoint, including the chat/completions suffix. */
  endpoint: string;
  systemPrompt: string;
  context: AgentMessage[];
  tools: AgentTool[];
  maxTurns: number;
  ports: MemberPorts;
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

  constructor(options: MemberOptions) {
    if (options.model.api !== "openai-completions" || !Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) {
      throw new Error("Unsupported member execution profile");
    }
    const endpoint = new URL(options.endpoint);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search
      || endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
      throw new Error("Invalid controlled model endpoint");
    }
    const base = options.model.baseUrl.replace(/\/$/, "");
    if (`${base}/chat/completions` !== endpoint.href || options.model.headers && Object.keys(options.model.headers).length) {
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
        const requestId = await this.ports.prepare({ basis: this.basis, messages: structuredClone(context.messages) }, signal);
        if (typeof requestId !== "string" || !requestId.length) throw new Error("Missing original model request identity");
        this.requestIdentity = Object.freeze({ basis: this.basis, requestId });
      },
      streamFn: (_selected, context, runtime) => {
        return streamSimple(model, context, {
          ...(runtime?.signal ? { signal: runtime.signal } : {}),
          apiKey: "controlled-host-transport",
          env: {},
          maxRetries: 0,
          onProviderStreamEvent: event => this.ports.providerEvent(this.identity(), event),
          transport: "sse",
          maxTokens: model.maxTokens,
          fetch: (input, init) => this.fetch(input, init),
        });
      },
      beforeToolCall: (context, signal) => this.ports.beforeToolCall(this.identity(), context, signal),
      afterToolCall: (context, signal) => this.ports.afterToolCall(this.identity(), context, signal),
      finishTurn: async (turn, signal) => {
        const decision = await this.ports.finishTurn(this.identity(), turn, signal);
        if (++this.turns >= maxTurns) {
          this.turnLimitReached = turn.message.stopReason === "toolUse" || decision?.action === "continue";
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
    this.agent.clearAllQueues();
    this.agent.abort();
    await this.agent.waitForIdle();
  }
}
