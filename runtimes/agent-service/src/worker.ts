import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, TextContent, TSchema } from "@earendil-works/pi-ai";
import { MemberKernel } from "./member.js";
import { FrameDecoder, encodeFrame } from "./codec.js";
import type { MemberBody, MemberCall, MemberFrame, MemberReply, Usage } from "./generated/frame.js";
import { MEMBER_PROFILE } from "./generated/profile.js";

type Start = Extract<MemberBody, { kind: "start" }>;
type ReplyKind = MemberReply["kind"];
interface Pending {
  call: MemberCall;
  kind: ReplyKind;
  resolve(reply: MemberReply): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort?: () => void;
  request?: number;
  cancelled: boolean;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const abortError = () => new DOMException("Controlled member operation cancelled", "AbortError");
const recording = (call: MemberCall) => call.method === "event" || call.method === "usage";
const field = (value: Record<string, unknown> | undefined, key: string) => value && Object.hasOwn(value, key) ? value[key] : undefined;
const tokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function wireMessage(message: AgentMessage) {
  if (message.role !== "assistant") return message;
  // Pi's normalized counts and synthetic prices are not application receipts.
  // Keep them in Pi's history, without adding a second accounting projection.
  const { usage: _usage, ...projected } = message;
  return projected;
}

function wireEvent(event: AgentEvent) {
  switch (event.type) {
    case "message_start":
    case "message_end":
    case "turn_end":
      return { ...event, message: wireMessage(event.message) };
    case "message_update": {
      const update = event.assistantMessageEvent;
      const assistantMessageEvent = "partial" in update ? { ...update, partial: wireMessage(update.partial) }
        : "message" in update ? { ...update, message: wireMessage(update.message) }
        : { ...update, error: wireMessage(update.error) };
      return { ...event, message: wireMessage(event.message), assistantMessageEvent };
    }
    case "agent_end":
      return { ...event, messages: event.messages.map(wireMessage) };
    default:
      return event;
  }
}

function observedUsage(event: unknown): Usage | null | undefined {
  if (!object(event)) return undefined;
  if (["response.completed", "response.failed", "response.incomplete"].includes(String(event.type))) {
    const response = object(event.response) ? event.response : undefined;
    const raw = field(response, "usage");
    if (!object(raw)) return null;
    const input = field(raw, "input_tokens"), output = field(raw, "output_tokens");
    if (!tokens(input) || !tokens(output)) return null;
    const inputDetails = object(raw.input_tokens_details) ? raw.input_tokens_details : undefined;
    const outputDetails = object(raw.output_tokens_details) ? raw.output_tokens_details : undefined;
    const detail = (value: unknown, total: number) => tokens(value) && value <= total ? value.toString(10) : null;
    return { promptTokens: input, completionTokens: output,
      cacheReadTokens: detail(field(inputDetails, "cached_tokens"), input), cacheWriteTokens: null,
      reasoningTokens: detail(field(outputDetails, "reasoning_tokens"), output) };
  }
  const choice = Array.isArray(event.choices) && object(event.choices[0]) ? event.choices[0] : undefined;
  if (!Object.hasOwn(event, "usage") && !(choice && Object.hasOwn(choice, "usage"))) return undefined;
  // Follow Pi's current Chat Completions carrier priority, before its usage
  // normalization turns missing provider fields into zeroes.
  const top = field(event, "usage"), raw = top || field(choice, "usage");
  if (!object(raw)) return null;
  const input = field(raw, "prompt_tokens"), output = field(raw, "completion_tokens");
  if (!tokens(input) || !tokens(output)) return null;
  const prompt = field(raw, "prompt_tokens_details"), completion = field(raw, "completion_tokens_details");
  const promptDetails = object(prompt) ? prompt : undefined;
  const outputDetails = object(completion) ? completion : undefined;
  const detail = (value: unknown, total: number) => tokens(value) && value <= total ? value.toString(10) : null;
  return {
    // Raw prompt includes cache counts; raw completion includes reasoning.
    // Detail counts may overlap and never increase these original totals.
    promptTokens: input, completionTokens: output,
    cacheReadTokens: detail(field(promptDetails, "cached_tokens") ?? field(raw, "prompt_cache_hit_tokens") ?? field(raw, "cached_tokens"), input),
    cacheWriteTokens: detail(field(promptDetails, "cache_write_tokens"), input),
    reasoningTokens: detail(field(outputDetails, "reasoning_tokens"), output),
  };
}

function content(value: unknown): (TextContent | ImageContent)[] {
  if (!Array.isArray(value) || !value.every(block => object(block)
    && (block.type === "text" && typeof block.text === "string"
      || block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"))) {
    throw new Error("Invalid controlled tool content");
  }
  return value as (TextContent | ImageContent)[];
}

function transcript(value: unknown): AgentMessage[] {
  if (!Array.isArray(value) || !value.every(message => object(message)
    && ["system", "user", "assistant", "toolResult"].includes(String(message.role))
    && (typeof message.content === "string" && ["system", "user"].includes(String(message.role)) || Array.isArray(message.content))
    && (message.timestamp === undefined || Number.isSafeInteger(message.timestamp) && Number(message.timestamp) >= 0))) {
    throw new Error("Invalid captured member transcript");
  }
  // This is a frozen projection supplied by the trusted transcript owner. It is
  // preserved verbatim; no other member's text is manufactured as local history.
  return structuredClone(value) as AgentMessage[];
}

class Worker {
  private session: string | undefined;
  private inputSequence = 0;
  private outputSequence = 0;
  private nextRequest = 1;
  private outputBytes = 0;
  private writes: Promise<void> = Promise.resolve();
  private active: Pending | undefined;
  private readonly queue: Pending[] = [];
  private kernel: MemberKernel | undefined;
  private state: "waiting" | "running" | "result" | "closing" | "closed" | "fault" = "waiting";
  private deadline: NodeJS.Timeout | undefined;
  private closeDeadline: NodeJS.Timeout | undefined;
  private currentRequest: string | undefined;
  private readonly usage = new Map<string, { value: Usage | null; reported: boolean; response: boolean }>();
  private usageFlush: Promise<void> = Promise.resolve();

  receive(frame: MemberFrame): void {
    if (frame.protocolVersion !== MEMBER_PROFILE.protocolVersion || frame.sequence !== this.inputSequence++) throw new Error("Invalid member sequence");
    if (this.state === "waiting") {
      if (frame.body.kind !== "start") throw new Error("Missing member start");
      this.session = frame.sessionId;
      this.state = "running";
      void this.start(frame.body).catch(() => {
        if (this.state !== "closing" && this.state !== "closed") return this.fault("member-execution-failed");
      });
      return;
    }
    if (frame.sessionId !== this.session || this.state === "closed" || this.state === "fault") throw new Error("Invalid member session");
    const body = frame.body;
    if (body.kind === "reply") {
      const active = this.active;
      if (!active || body.request !== active.request) throw new Error("Unexpected member reply");
      if (body.reply.kind !== active.kind && body.reply.kind !== "rejected") throw new Error("Mismatched member reply");
      this.active = undefined;
      this.detach(active);
      if (!active.cancelled) {
        if (body.reply.kind === "rejected") active.reject(new Error(`Controlled operation rejected: ${body.reply.error.code}`));
        else active.resolve(body.reply);
      }
      this.pump();
      return;
    }
    if (body.kind === "close" && this.state !== "closing") { void this.close(); return; }
    if (body.kind === "guide" && this.state === "running") {
      if (!this.kernel) throw new Error("Member has not become ready");
      this.kernel.guide({ role: "user", content: body.text, timestamp: Date.now() });
      return;
    }
    throw new Error("Unexpected member control frame");
  }

  private send(body: MemberBody): Promise<void> {
    if (!this.session || this.outputSequence > 0xffffffff) return Promise.reject(new Error("Member output sequence limit"));
    const bytes = encodeFrame({ protocolVersion: MEMBER_PROFILE.protocolVersion, sessionId: this.session, sequence: this.outputSequence, body });
    if (this.outputBytes + bytes.length > MEMBER_PROFILE.maxSessionBytes) return Promise.reject(new Error("Member output limit"));
    this.outputSequence++;
    this.outputBytes += bytes.length;
    this.writes = this.writes.then(() => new Promise<void>((resolve, reject) => {
      process.stdout.write(bytes, error => error ? reject(error) : resolve());
    }));
    return this.writes;
  }

  private rpc<K extends ReplyKind>(call: MemberCall, kind: K, signal?: AbortSignal): Promise<Extract<MemberReply, { kind: K }>> {
    if (signal?.aborted || this.state === "fault" || this.state === "closed" || this.state === "closing" && !recording(call)) return Promise.reject(abortError());
    if (this.queue.length >= 64) return Promise.reject(new Error("Member operation queue limit"));
    const response = new Promise<MemberReply>((resolve, reject) => {
      const pending: Pending = { call, kind, resolve, reject, cancelled: false, ...(signal ? { signal } : {}) };
      pending.abort = () => {
        pending.cancelled = true;
        this.detach(pending);
        reject(abortError());
        const index = this.queue.indexOf(pending);
        if (index !== -1) this.queue.splice(index, 1);
        // An admitted slot remains reserved until its original reply arrives.
        // This prevents a cancelled HTTP operation and a later record from
        // appearing concurrently at the trusted parent's serialized boundary.
      };
      signal?.addEventListener("abort", pending.abort, { once: true });
      this.queue.push(pending);
      this.pump();
    });
    return response as Promise<Extract<MemberReply, { kind: K }>>;
  }

  private detach(pending: Pending): void {
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
  }
  private pump(): void {
    if (this.active || this.state === "fault" || this.state === "closed") return;
    const pending = this.queue.shift();
    if (!pending) return;
    if (this.nextRequest > 0xffffffff) { pending.reject(new Error("Member operation identity limit")); void this.fault("member-request-limit"); return; }
    pending.request = this.nextRequest++;
    this.active = pending;
    try {
      void this.send({ kind: "request", request: pending.request, call: pending.call }).catch(() => this.fault("member-output-failed"));
    } catch {
      // Encoding can reject before returning a promise. The admitted slot must
      // fail immediately instead of stranding later records behind it.
      void this.fault("member-output-failed");
    }
  }

  private flushUsage(): Promise<void> {
    this.usageFlush = this.usageFlush.then(async () => {
      for (const [requestId, usage] of this.usage) {
        if (usage.reported || !usage.response) continue;
        await this.rpc({ method: "usage", requestId, usage: usage.value }, "recorded");
        usage.reported = true;
      }
    });
    return this.usageFlush;
  }

  private async start(start: Start): Promise<void> {
    if (!start.timeoutMs || start.timeoutMs > 0x7fffffff || !start.maxTurns) throw new Error("Invalid member limits");
    if (start.profile.contextTokens != null && (!Number.isSafeInteger(start.profile.contextTokens) || start.profile.contextTokens < 1)) {
      throw new Error("Invalid captured model capacity");
    }
    const endpoint = new URL(start.profile.endpoint);
    const subscription = start.profile.tokenField === "chatgpt_subscription";
    if (subscription ? endpoint.href !== "https://api.openai.com/v1/responses" || start.profile.maxOutputTokens !== 0
      : !endpoint.pathname.endsWith("/chat/completions") || start.profile.maxOutputTokens < 1 || start.profile.maxOutputTokens > 16384) {
      throw new Error("Unsupported controlled endpoint or output limit");
    }
    const common = {
      id: start.profile.model, name: start.profile.model, input: ["text"] as ("text")[], reasoning: false,
      // Zero is unknown metadata; subscription requests are bounded by request
      // count and plan quota. Pi omits the unsupported output-token parameter.
      contextWindow: start.profile.contextTokens ?? 0, maxTokens: start.profile.maxOutputTokens,
      // These are unpriced metadata, never a statement of subscription charges.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const model: Model<"openai-completions"> | Model<"openai-responses"> = subscription ? {
      ...common, api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1",
      compat: { supportsDeveloperRole: false, supportsMaxOutputTokens: false },
    } : {
      ...common, api: "openai-completions", provider: "controlled",
      baseUrl: endpoint.href.slice(0, -"/chat/completions".length),
      compat: { maxTokensField: start.profile.tokenField as "max_tokens" | "max_completion_tokens", supportsDeveloperRole: false, supportsStore: false },
    };
    const names = new Set<string>();
    const tools: AgentTool[] = start.tools.map(tool => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name) || !object(tool.parameters)) throw new Error("Invalid captured tool definition");
      names.add(tool.name);
      return { name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters as TSchema,
        execute: async (callId, args, signal) => {
          if (!this.currentRequest) throw new Error("Tool has no model request identity");
          const reply = await this.rpc({ method: "execute-tool", requestId: this.currentRequest, callId, name: tool.name, arguments: args }, "tool-result", signal);
          return { content: content(reply.content), details: reply.details, isError: reply.isError };
        } };
    });
    this.kernel = new MemberKernel({
      basis: { memberId: start.memberId, workItemId: start.workItemId, contextVersion: start.contextVersion },
      model, endpoint: start.profile.endpoint, systemPrompt: start.systemPrompt, context: transcript(start.context), tools, maxTurns: start.maxTurns,
      ports: {
        prepare: async (request, signal) => {
          await this.flushUsage();
          const reply = await this.rpc({ method: "prepare", messages: request.messages.map(wireMessage) }, "prepared", signal);
          this.currentRequest = reply.requestId;
          this.usage.set(reply.requestId, { value: null, reported: false, response: false });
          return { requestId: reply.requestId, sharedView: reply.sharedView };
        },
        request: async request => {
          const reply = await this.rpc({ method: "http", requestId: request.requestId, endpoint: request.url, body: request.body }, "http", request.signal);
          if (reply.requestId !== request.requestId || reply.status < 200 || reply.status > 599) throw new Error("Invalid controlled HTTP response");
          this.usage.get(request.requestId)!.response = true;
          return new Response(reply.body, { status: reply.status, headers: reply.contentType ? { "content-type": reply.contentType } : {} });
        },
        providerEvent: async (identity, event) => {
          const usage = this.usage.get(identity.requestId);
          if (!usage || !usage.response || usage.reported) throw new Error("Provider event has no active request");
          const observed = observedUsage(event);
          if (observed !== undefined) usage.value = observed;
        },
        beforeToolCall: async (identity, context, signal) => {
          const reply = await this.rpc({ method: "before-tool", requestId: identity.requestId,
            callId: context.toolCall.id, name: context.toolCall.name, arguments: context.args }, "tool-admission", signal);
          return { block: reply.block, ...(reply.reason != null ? { reason: reply.reason } : {}) };
        },
        afterToolCall: async (identity, context, signal) => {
          const reply = await this.rpc({ method: "after-tool", requestId: identity.requestId,
            callId: context.toolCall.id, name: context.toolCall.name, result: context.result, isError: context.isError }, "tool-finalized", signal);
          return { ...(reply.content != null ? { content: content(reply.content) } : {}), ...(reply.isError != null ? { isError: reply.isError } : {}) };
        },
        finishTurn: async (identity, turn, signal) => {
          await this.flushUsage();
          const reply = await this.rpc({ method: "finish-turn", requestId: identity.requestId, stopReason: turn.message.stopReason }, "turn", signal);
          return reply.action === "normal" ? undefined : { action: reply.action };
        },
        event: async (identity, event) => {
          if (event.type === "message_end" && event.message.role === "assistant") await this.flushUsage();
          // Event records remain required while an aborted loop drains. An
          // aborted Pi signal cannot be used to skip application acknowledgments.
          await this.rpc({ method: "event", requestId: identity?.requestId ?? null, event: wireEvent(event) }, "recorded");
        },
      },
    });
    this.deadline = setTimeout(() => { void this.fault("member-deadline-exceeded"); }, start.timeoutMs);
    await this.send({ kind: "ready" });
    const result = await this.kernel.prompt({ role: "user", content: start.input, timestamp: Date.now() });
    await this.flushUsage();
    if (this.state !== "running") return;
    this.state = "result";
    await this.send({ kind: "result", messages: result.messages.map(wireMessage), turnLimitReached: result.turnLimitReached });
  }

  private cancelOperations(): void {
    for (const pending of [...this.queue, ...(this.active ? [this.active] : [])]) {
      if (recording(pending.call)) continue;
      pending.cancelled = true;
      this.detach(pending);
      pending.reject(abortError());
      const index = this.queue.indexOf(pending);
      if (index !== -1) this.queue.splice(index, 1);
    }
  }

  private async close(): Promise<void> {
    this.state = "closing";
    this.cancelOperations();
    this.closeDeadline = setTimeout(() => { void this.fault("member-close-unacknowledged"); }, 2000);
    try {
      await this.kernel?.close();
      await this.flushUsage();
      if (this.state !== "closing") return;
      if (this.active || this.queue.length) throw new Error("Member operations remain during close");
      await this.send({ kind: "closed" });
      this.state = "closed";
      if (this.deadline) clearTimeout(this.deadline);
      if (this.closeDeadline) clearTimeout(this.closeDeadline);
      process.exit(0);
    } catch { await this.fault("member-close-failed"); }
  }

  async fault(code: string): Promise<void> {
    if (this.state === "fault" || this.state === "closed") return;
    this.state = "fault";
    if (this.deadline) clearTimeout(this.deadline);
    if (this.closeDeadline) clearTimeout(this.closeDeadline);
    for (const pending of [...this.queue, ...(this.active ? [this.active] : [])]) {
      this.detach(pending);
      pending.reject(abortError());
    }
    this.active = undefined;
    this.queue.length = 0;
    // The fault is the parent's cue to revoke and drain its original request.
    // Never write raw provider errors, request bodies or ambient data to stderr.
    const exitDeadline = setTimeout(() => process.exit(1), 500);
    try { if (this.session) await this.send({ kind: "fault", code }); } catch { /* Pipe failure has no secondary output channel. */ }
    clearTimeout(exitDeadline);
    process.exit(1);
  }
}

const worker = new Worker();
const decoder = new FrameDecoder();
process.stdin.on("data", (chunk: Buffer) => {
  try { decoder.push(chunk, frame => worker.receive(frame)); }
  catch { void worker.fault("member-protocol-invalid"); }
});
process.stdin.on("end", () => {
  try { decoder.finish(); } catch { void worker.fault("member-frame-truncated"); return; }
  void worker.fault("member-parent-disconnected");
});
process.stdin.on("error", () => { void worker.fault("member-input-failed"); });
process.stdout.on("error", () => { void worker.fault("member-output-failed"); });
process.on("uncaughtException", () => { void worker.fault("member-runtime-failed"); });
process.on("unhandledRejection", () => { void worker.fault("member-runtime-failed"); });
