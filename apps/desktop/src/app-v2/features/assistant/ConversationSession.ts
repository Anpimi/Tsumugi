import { commandFailure, type CommandFailure } from "../../../CommandFailure";
import { conversationCommands, isConversationMessageText, type PreparedConversationPlanning } from "../../../conversationCommands";
import { defaultAiConfig, editedAiConfig, validAiLimits, type AiConfig } from "../../../aiCommands";
import { conversationDraftCommands, type ConversationDraftHead, type ConversationDraftKey, type ConversationDraftPending, type ConversationDraftSummary, type ConversationDraftValue } from "../../../conversationDraftCommands";
import type { SessionRequest } from "../../../executionCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import type { LifecycleParticipant } from "../../platform/projectLifecycle";
import { DraftKernel, nextEditSeq } from "../../workspace/draftKernel";
import { copyWorkspaceSelection, workspaceSelectionIds, type WorkspaceSelection } from "../../workspace/workspaceSelection";
import { checkPlanningSelection, planningSelectionMatchesPreview, planningSelectionScope } from "./planningSelection";
import { reviewCommands } from "../../../reviewCommands";

type Ports = typeof conversationDraftCommands & Pick<typeof conversationCommands, "create" | "append" | "recoverCreate" | "recoverMessage" | "preparePlanning" | "validatePlanning" | "startPlanning" | "recoverPlanning" | "recoverProposalCapture" | "recoverProposalRevision" | "recoverProposalWorkPlan"> & { identity: () => string; now: () => number; captureSelection: typeof reviewCommands.captureScope };
type JournalWrite = Omit<Parameters<Ports["write"]>[0]["write"], "value"> & { value: ConversationDraftValue };
type JournalJob = { kind: "write"; request: { sessionToken: string; write: JournalWrite } }
  | { kind: "resolve"; request: { sessionToken: string; resolve: { write: JournalWrite; pending: ConversationDraftPending } }; submitted: ConversationDraftPending };
export interface ConversationInput {
  key: ConversationDraftKey;
  head: ConversationDraftHead;
  value: ConversationDraftValue;
  dirty: boolean;
  busy: "journal" | "submit" | "check" | null;
  outcome: "recorded" | "unknown" | "absent" | "blocked" | "mismatch" | null;
  notice: "threadCreated" | "messageSaved" | "planningRecorded" | "proposalRecorded" | "workPlanRecorded" | null;
  failure: { kind: "journal" | "action"; cause: CommandFailure } | null;
  planning: ConversationPlanningInput;
}
export interface ConversationPlanningInput {
  open: boolean;
  sequence: number;
  config: AiConfig;
  messageIds: readonly string[];
  selection: WorkspaceSelection | null;
  prepared: PreparedConversationPlanning | null;
  consent: boolean;
  busy: "prepare" | "start" | null;
  failure: { kind: "selection" | "request"; cause: CommandFailure } | null;
}
function planningConfig(config: AiConfig, selection: WorkspaceSelection | null): AiConfig {
  return { ...config, maxItems: selection ? workspaceSelectionIds(selection).length : 1, maxRequests: 1, concurrency: 1, maxRetries: 0,
    ...(!selection ? { shareTerms: false, shareContext: false, contextStrategy: null, sourceContext: structuredClone(defaultAiConfig.sourceContext) } : {}) };
}
function planningInput(): ConversationPlanningInput {
  return { open: false, sequence: 0, config: planningConfig(structuredClone(defaultAiConfig), null),
    messageIds: [], selection: null, prepared: null, consent: false, busy: null, failure: null };
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
      preparePlanning: conversationCommands.preparePlanning, validatePlanning: conversationCommands.validatePlanning, startPlanning: conversationCommands.startPlanning,
      captureSelection: request => reviewCommands.captureScope(request),
      identity: () => crypto.randomUUID(), now: () => Date.now(), ...ports };
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
      this.records.set(conversationId, { input: { key, head, value, dirty: false, busy: null, outcome: value.pending ? "unknown" : null, notice: null, failure: null, planning: planningInput() }, job: null, writing: null, action: false });
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
      dirty: true, busy: null, outcome: null, notice: null, failure: null, planning: planningInput() }, job: null, writing: null, action: false };
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
  setPlanningOpen(conversationId: string, open: boolean) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live) return;
    this.update(record, { planning: { ...record.input.planning, open, ...(!open ? { consent: false } : {}) } });
  }
  private editPlanning(record: RecordState, patch: Partial<ConversationPlanningInput>) {
    this.update(record, { planning: { ...record.input.planning, ...patch, sequence: record.input.planning.sequence + 1, prepared: null, consent: false, failure: null } });
  }
  setPlanningMessages(conversationId: string, messageIds: readonly string[]) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live || messageIds.length > 16 || new Set(messageIds).size !== messageIds.length) return;
    this.editPlanning(record, { messageIds: [...messageIds] });
  }
  setPlanningSelection(conversationId: string, selected: WorkspaceSelection | null): boolean {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live) return false;
    const selection = copyWorkspaceSelection(selected);
    try { planningSelectionScope(this.context, selection); } catch { return false; }
    this.editPlanning(record, { selection, config: planningConfig(record.input.planning.config, selection) });
    return true;
  }
  setPlanningConfig(conversationId: string, change: AiConfig | ((before: AiConfig) => AiConfig)) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live) return;
    const previous = record.input.planning.config;
    const edited = editedAiConfig(previous, typeof change === "function" ? change(previous) : change);
    const config = planningConfig(edited, record.input.planning.selection);
    this.editPlanning(record, { config });
  }
  invalidatePlanning(conversationId: string) {
    const record = this.records.get(conversationId);
    if (record && this.kernel.live && (record.input.planning.prepared || record.input.planning.consent || record.input.planning.busy === "prepare")) this.editPlanning(record, {});
  }
  setPlanningConsent(conversationId: string, consent: boolean) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live) return;
    this.update(record, { planning: { ...record.input.planning, consent: consent && !!record.input.planning.prepared } });
  }
  private canPrepare(record: RecordState) {
    const { planning, value, busy, failure } = record.input;
    return this.kernel.live && !record.action && !busy && !value.pending && !failure
      && planning.messageIds.length > 0 && planning.messageIds.length <= 16 && validAiLimits(planning.config)
      && !!planning.config.endpoint.trim() && !!planning.config.model.trim();
  }
  async preparePlanning(conversationId: string, current: () => boolean = () => true) {
    const record = this.records.get(conversationId); if (!record || !this.canPrepare(record) || !current()) return;
    const before = record.input.planning;
    let failureKind: "selection" | "request" = "selection";
    record.action = true;
    this.update(record, { planning: { ...before, busy: "prepare", prepared: null, consent: false, failure: null } });
    try {
      const live = () => this.kernel.live && record.input.planning.sequence === before.sequence && current();
      const scope = await checkPlanningSelection(this.context, before.selection, live, this.ports.captureSelection);
      if (!live()) return;
      failureKind = "request";
      const prepared = await this.ports.preparePlanning({ ...this.context, conversationId, config: structuredClone(before.config),
        selectedMessageIds: [...before.messageIds], scope });
      if (!live()) return;
      failureKind = "selection";
      if (!planningSelectionMatchesPreview(before.selection, prepared)) throw new Error("The planning source selection has changed");
      await checkPlanningSelection(this.context, before.selection, live, this.ports.captureSelection);
      if (!live()) return;
      // Host retains one capture. Another thread's earlier preview cannot remain confirmable.
      for (const other of this.records.values()) if (other !== record && other.input.planning.prepared) this.editPlanning(other, {});
      this.update(record, { planning: { ...record.input.planning, prepared } });
    } catch (error) { if (this.kernel.live && record.input.planning.sequence === before.sequence) this.update(record, { planning: { ...record.input.planning, failure: { kind: failureKind, cause: commandFailure(error) } } });
    } finally {
      record.action = false;
      if (this.kernel.live) {
        this.update(record, { planning: { ...record.input.planning, busy: null } });
        if (record.input.dirty && !record.input.failure && !record.job) void this.persist(record);
      }
    }
  }
  async startPlanning(conversationId: string, current: () => boolean = () => true) {
    const record = this.records.get(conversationId), before = record?.input.planning, prepared = before?.prepared;
    if (!record || !before || !prepared || !before.consent || !this.canPrepare(record) || !current()) return;
    record.action = true;
    this.update(record, { planning: { ...before, busy: "start", failure: null } });
    try {
      await this.ports.validatePlanning({ ...this.context, preparationId: prepared.preparationId }, prepared);
      if (!this.kernel.live || record.input.planning.sequence !== before.sequence || !record.input.planning.consent || !current()) {
        if (this.kernel.live) this.invalidatePlanning(conversationId);
        return;
      }
      const actionId = this.ports.identity(), editSeq = nextEditSeq(record.input.value.editSeq);
      const consent = { actionId, attemptId: actionId, taskId: this.ports.identity(), previewDigest: prepared.previewDigest,
        expiresAtMs: String(this.ports.now() + Math.min(prepared.preview.config.timeoutSeconds, 120) * 1000), shareMessages: true, shareUnits: prepared.preview.scope.kind === "units" };
      const pending: ConversationDraftPending = { kind: "planning", preparationId: prepared.preparationId, submittedSeq: editSeq,
        request: { ...record.input.key, consent } };
      this.changed++;
      this.update(record, { value: { ...record.input.value, editSeq, pending }, dirty: true, outcome: null, notice: null,
        planning: { ...record.input.planning, prepared: null, consent: false } });
      if (!await this.persist(record) || !this.kernel.live) return;
      this.update(record, { busy: "submit", failure: null });
      await this.ports.startPlanning({ ...this.context, conversationId, preparationId: prepared.preparationId, consent });
      if (!this.kernel.live) return;
      this.onRecorded(); this.update(record, { busy: null, outcome: "recorded" });
      await this.resolve(record, pending);
    } catch (error) {
      if (!this.kernel.live) return;
      if (record.input.value.pending?.kind === "planning") this.update(record, { busy: null, outcome: "unknown", failure: { kind: "action", cause: commandFailure(error) } });
      else if (record.input.planning.sequence === before.sequence) this.update(record, { planning: { ...record.input.planning, prepared: null, consent: false, failure: { kind: "request", cause: commandFailure(error) } } });
    } finally {
      record.action = false;
      if (this.kernel.live) {
        this.update(record, { planning: { ...record.input.planning, busy: null } });
        if (record.input.dirty && !record.input.failure && !record.job) void this.persist(record);
      }
    }
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
      this.update(record, { busy: null, outcome: outcome.kind === "recorded" ? "recorded" : outcome.kind === "mismatch" ? "mismatch" : outcome.replay === "explicit-same-request" ? "absent" : "blocked" });
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
