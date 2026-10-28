import { commandFailure, type CommandFailure } from "../../../CommandFailure";
import { conversationCommands, isConversationMessageText } from "../../../conversationCommands";
import { conversationDraftCommands, type ConversationDraftHead, type ConversationDraftKey, type ConversationDraftPending, type ConversationDraftSummary, type ConversationDraftValue } from "../../../conversationDraftCommands";
import type { SessionRequest } from "../../../executionCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import type { LifecycleParticipant } from "../../platform/projectLifecycle";
import { DraftKernel, nextEditSeq } from "../../workspace/draftKernel";

type Ports = typeof conversationDraftCommands & Pick<typeof conversationCommands, "create" | "append" | "recoverCreate" | "recoverMessage" | "recoverPlanning" | "recoverProposalCapture" | "recoverProposalRevision" | "recoverProposalWorkPlan"> & { identity: () => string };
type JournalWrite = Omit<Parameters<Ports["write"]>[0]["write"], "value"> & { value: ConversationDraftValue };
type JournalJob = { kind: "write"; request: { sessionToken: string; write: JournalWrite } }
  | { kind: "resolve"; request: { sessionToken: string; resolve: { write: JournalWrite; pending: ConversationDraftPending } }; submitted: ConversationDraftPending };
export interface ConversationInput {
  key: ConversationDraftKey;
  head: ConversationDraftHead;
  value: ConversationDraftValue;
  dirty: boolean;
  busy: "journal" | "submit" | "check" | null;
  outcome: "recorded" | "unknown" | "absent" | "mismatch" | null;
  notice: "threadCreated" | "messageSaved" | "planningRecorded" | "proposalRecorded" | "workPlanRecorded" | null;
  failure: { kind: "journal" | "action"; cause: CommandFailure } | null;
}
export interface ConversationSessionSnapshot {
  hydration: "idle" | "loading" | "ready" | "failed";
  failure: CommandFailure | null;
  inputFailure: { conversationId: string; cause: CommandFailure } | null;
  activeId: string | null;
  inputs: ReadonlyMap<string, ConversationInput>;
  summaries: readonly ConversationDraftSummary[];
  next: ConversationDraftKey | null;
  retired: boolean;
}
interface RecordState { input: ConversationInput; job: JournalJob | null; writing: Promise<boolean> | null; action: boolean }
const same = (a: unknown, b: unknown) => jsonIdentity(a) === jsonIdentity(b);

/** Retains local input and original requests for one project session. It never restores permission. */
export class ConversationSession {
  private readonly ports: Ports;
  private readonly writerId: string;
  private readonly kernel = new DraftKernel();
  private readonly records = new Map<string, RecordState>();
  private readonly listeners = new Set<() => void>();
  private opening = new Map<string, Promise<boolean>>();
  private loading: Promise<boolean> | null = null;
  private changed = 0;
  private state: ConversationSessionSnapshot = { hydration: "idle", failure: null, inputFailure: null, activeId: null, inputs: new Map(), summaries: [], next: null, retired: false };
  constructor(readonly context: SessionRequest, private readonly onRecorded: () => void, private readonly onReveal: () => void, ports: Partial<Ports> = {}) {
    this.ports = { ...conversationDraftCommands, create: conversationCommands.create, append: conversationCommands.append,
      recoverCreate: conversationCommands.recoverCreate, recoverMessage: conversationCommands.recoverMessage,
      recoverPlanning: conversationCommands.recoverPlanning, recoverProposalCapture: conversationCommands.recoverProposalCapture,
      recoverProposalRevision: conversationCommands.recoverProposalRevision, recoverProposalWorkPlan: conversationCommands.recoverProposalWorkPlan,
      identity: () => crypto.randomUUID(), ...ports };
    this.writerId = this.ports.identity();
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ConversationSessionSnapshot> = {}) {
    this.state = { ...this.state, ...patch, inputs: new Map([...this.records].map(([id, record]) => [id, record.input])) };
    this.listeners.forEach(listener => listener());
  }
  private update(record: RecordState, patch: Partial<ConversationInput>) { record.input = { ...record.input, ...patch }; this.publish(); }
  initialize(more = false): Promise<boolean> {
    if (!this.kernel.live) return Promise.resolve(false);
    if (this.loading) return this.loading;
    this.publish({ hydration: "loading", failure: null });
    const after = more ? this.state.next : null;
    this.loading = this.ports.list({ ...this.context, after, limit: 50 }).then(page => {
      if (!this.kernel.live) return false;
      this.publish({ hydration: "ready", summaries: more ? [...this.state.summaries, ...page.items] : page.items, next: page.next }); return true;
    }).catch(error => { if (this.kernel.live) this.publish({ hydration: "failed", failure: commandFailure(error) }); return false;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }
  async open(conversationId: string): Promise<boolean> {
    if (!this.kernel.live) return false;
    this.publish({ activeId: conversationId, inputFailure: null });
    if (this.records.has(conversationId)) return true;
    const existing = this.opening.get(conversationId); if (existing) return existing;
    const key = { projectId: this.context.projectId, conversationId };
    const flight = this.ports.read({ sessionToken: this.context.sessionToken, key }).then(head => {
      if (!this.kernel.live) return false;
      const value = head.value ?? { text: "", editSeq: "0", pending: null };
      this.records.set(conversationId, { input: { key, head, value, dirty: false, busy: null, outcome: value.pending ? "unknown" : null, notice: null, failure: null }, job: null, writing: null, action: false });
      this.publish(this.state.activeId === conversationId ? { inputFailure: null } : {}); return true;
    }).catch(error => { if (this.kernel.live && this.state.activeId === conversationId) this.publish({ inputFailure: { conversationId, cause: commandFailure(error) } }); return false;
    }).finally(() => { this.opening.delete(conversationId); });
    this.opening.set(conversationId, flight); return flight;
  }
  async create(): Promise<void> {
    if (!this.kernel.live || this.state.hydration !== "ready" || [...this.records.values()].some(record => record.action && record.input.value.pending?.kind === "create")) return;
    const conversationId = this.ports.identity(), key = { projectId: this.context.projectId, conversationId };
    const pending: ConversationDraftPending = { kind: "create", submittedSeq: "1", request: { ...key, actionId: this.ports.identity(), title: null } };
    const record: RecordState = { input: { key, head: { key, revision: "0", writerId: null, value: null }, value: { text: "", editSeq: "1", pending },
      dirty: true, busy: null, outcome: null, notice: null, failure: null }, job: null, writing: null, action: false };
    this.records.set(conversationId, record); this.changed++; this.publish({ activeId: conversationId });
    await this.submit(record);
  }
  edit(conversationId: string, text: string) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live || text === record.input.value.text) return;
    const value = { ...record.input.value, text, editSeq: nextEditSeq(record.input.value.editSeq) };
    this.changed++; this.update(record, { value, dirty: true, notice: null });
    if (!record.input.failure && !record.action) void this.persist(record);
  }
  async append(conversationId: string) {
    const record = this.records.get(conversationId);
    if (!record || !this.kernel.live || record.action || record.input.busy || record.input.value.pending || record.input.failure) return;
    const text = record.input.value.text;
    if (!isConversationMessageText(text)) return;
    const editSeq = nextEditSeq(record.input.value.editSeq);
    const pending: ConversationDraftPending = { kind: "append", submittedSeq: editSeq,
      request: { ...record.input.key, actionId: this.ports.identity(), messageId: this.ports.identity(), body: text } };
    this.changed++; this.update(record, { value: { text, editSeq, pending }, dirty: true, outcome: null, notice: null, failure: null });
    await this.submit(record);
  }
  private writeJob(record: RecordState): JournalJob {
    return { kind: "write", request: { sessionToken: this.context.sessionToken, write: {
      key: record.input.key, expectedRevision: record.input.head.revision, writerId: this.writerId, value: structuredClone(record.input.value) } } };
  }
  private async executeJob(record: RecordState, job: JournalJob): Promise<boolean> {
    this.update(record, { busy: "journal" });
    try {
      const head = job.kind === "write" ? await this.ports.write(job.request) : await this.ports.resolve(job.request);
      const submitted = job.kind === "write" ? job.request.write.value : job.request.resolve.write.value;
      let value = record.input.value;
      if (job.kind === "resolve") value = value.editSeq === submitted.editSeq ? submitted : { ...value, pending: null };
      record.job = null;
      this.update(record, { head, value, dirty: !same(head.value, value), busy: null, failure: null,
        ...(job.kind === "resolve" ? { outcome: "recorded" as const, notice: this.recordedNotice(job.submitted) } : {}) });
      return true;
    } catch (error) {
      record.job = job;
      this.update(record, { busy: null, failure: { kind: "journal", cause: commandFailure(error) } }); return false;
    }
  }
  private persist(record: RecordState): Promise<boolean> {
    if (record.writing) return record.writing;
    if (!this.kernel.live || record.job || record.input.failure?.kind === "journal") return Promise.resolve(false);
    const flight = this.kernel.enqueue(record.input.key.conversationId, async () => {
      while (this.kernel.live && record.input.dirty) if (!await this.executeJob(record, this.writeJob(record))) return false;
      return !record.input.dirty;
    }).finally(() => { if (record.writing === flight) record.writing = null; });
    record.writing = flight; return flight;
  }
  async retryJournal(conversationId: string) {
    const record = this.records.get(conversationId);
    if (!record || !this.kernel.live || record.action || record.writing || record.input.busy) return;
    const job = record.job;
    if (!job) { this.update(record, { failure: null }); await this.persist(record); return; }
    record.writing = this.kernel.enqueue(conversationId, () => this.executeJob(record, job));
    const success = await record.writing; record.writing = null;
    if (success && record.input.dirty) await this.persist(record);
  }
  private async resolve(record: RecordState, pending: ConversationDraftPending) {
    // The original action is settled. Newer input remains independent of its submitted text.
    if (!await this.persist(record)) return;
    const current = record.input.value;
    const text = pending.kind === "append" && current.editSeq === pending.submittedSeq ? "" : current.text;
    const value = { text, editSeq: nextEditSeq(current.editSeq), pending: null };
    this.changed++; this.update(record, { value: { ...value, pending }, dirty: true });
    const job: JournalJob = { kind: "resolve", submitted: pending, request: { sessionToken: this.context.sessionToken,
      resolve: { write: { key: record.input.key, expectedRevision: record.input.head.revision, writerId: this.writerId, value }, pending } } };
    if (await this.executeJob(record, job) && record.input.dirty) await this.persist(record);
  }
  private async submit(record: RecordState) {
    const kind = record.input.value.pending?.kind;
    if (!this.kernel.live || record.action || kind !== "create" && kind !== "append") return;
    record.action = true;
    try {
      if (!await this.persist(record)) return;
      const pending = record.input.value.pending; if (!pending) return;
      this.update(record, { busy: "submit", failure: null });
      if (pending.kind === "create") await this.ports.create({ sessionToken: this.context.sessionToken, ...pending.request });
      else if (pending.kind === "append") await this.ports.append({ sessionToken: this.context.sessionToken, ...pending.request });
      else return;
      this.onRecorded(); this.update(record, { busy: null, outcome: "recorded" });
      await this.resolve(record, pending);
    } catch (error) { this.update(record, { busy: null, outcome: "unknown", failure: { kind: "action", cause: commandFailure(error) } });
    } finally { record.action = false; if (this.kernel.live && record.input.dirty && !record.input.failure && !record.job) void this.persist(record); }
  }
  async check(conversationId: string) {
    const record = this.records.get(conversationId), pending = record?.input.value.pending;
    if (!record || !pending || !this.kernel.live || record.action || record.input.busy || record.job) return;
    record.action = true; this.update(record, { busy: "check", failure: null });
    try {
      const recovery = await this.recover(pending);
      const outcome = recovery.outcome;
      this.update(record, { busy: null, outcome: outcome.kind === "recorded" ? "recorded" : outcome.kind === "mismatch" ? "mismatch" : outcome.replay === "explicit-same-request" ? "absent" : "unknown" });
      if (outcome.kind === "recorded") { this.onRecorded(); await this.resolve(record, pending); }
    } catch (error) { this.update(record, { busy: null, outcome: "unknown", failure: { kind: "action", cause: commandFailure(error) } });
    } finally { record.action = false; }
  }
  async retry(conversationId: string) {
    const record = this.records.get(conversationId);
    if (record?.input.outcome === "absent" && !record.job && ["create", "append"].includes(record.input.value.pending?.kind ?? "")) await this.submit(record);
  }
  private recordedNotice(pending: ConversationDraftPending): NonNullable<ConversationInput["notice"]> {
    switch (pending.kind) {
      case "create": return "threadCreated";
      case "append": return "messageSaved";
      case "planning": return "planningRecorded";
      case "proposal-capture": case "proposal-revision": return "proposalRecorded";
      case "proposal-work-plan": return "workPlanRecorded";
    }
  }
  private recover(pending: ConversationDraftPending) {
    const sessionToken = this.context.sessionToken;
    switch (pending.kind) {
      case "create": return this.ports.recoverCreate({ sessionToken, ...pending.request });
      case "append": return this.ports.recoverMessage({ sessionToken, ...pending.request });
      case "planning": return this.ports.recoverPlanning({ sessionToken, ...pending.request });
      case "proposal-capture": return this.ports.recoverProposalCapture({ sessionToken, ...pending.request });
      case "proposal-revision": return this.ports.recoverProposalRevision({ sessionToken, ...pending.request });
      case "proposal-work-plan": return this.ports.recoverProposalWorkPlan({ sessionToken, projectId: this.context.projectId, authorization: pending.request });
    }
  }
  async flush(): Promise<boolean> {
    const records = [...this.records.values()];
    if (records.some(record => record.action || record.job || record.input.failure?.kind === "journal")) return false;
    return (await Promise.all(records.map(record => this.persist(record)))).every(Boolean);
  }
  lifecycleParticipant(): LifecycleParticipant {
    return { id: "conversation-input", area: "tasks", scope: { kind: "project", ...this.context },
      inspect: intent => {
        if (["navigate", "language", "close-view", "restore"].includes(intent.kind)) return { status: "ready", revision: "retained-conversation-input" };
        const records = [...this.records.values()];
        return { status: records.some(record => record.action) ? "blocked" : records.some(record => record.input.dirty || record.job) ? "dirty" : "ready",
          revision: JSON.stringify([this.changed, records.map(record => [record.input.key.conversationId, record.input.head.revision, record.input.dirty, record.action])]) };
      },
      prepareLeave: async (_intent, proof, current) => {
        const changed = this.changed;
        return proof() && current() && await this.flush() && current() && changed === this.changed;
      }, reveal: this.onReveal };
  }
  retire() { if (this.kernel.live) { this.kernel.retire(); this.publish({ retired: true }); } }
}
