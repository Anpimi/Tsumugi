import { commandFailure, type CommandFailure } from "./CommandFailure";
import type { SessionRequest } from "./executionCommands";
import { knowledgeProposalDirty } from "./knowledgeProposalDrafts";
import { jsonIdentity } from "./pluginToolChoices";
import { resourceDraftCommands, type ResourceDraftHead, type ResourceDraftValue, type ResourceDraftPending, type ResourceFactPending, type ResourceDraftResolveTarget, type ResourceDraftDisposition } from "./resourceDraftCommands";
import type { ResourceDraftState, ResourcePending } from "./ResourceDraftSession";
import { DraftKernel, nextEditSeq } from "./app-v2/workspace/draftKernel";
import { DecisionActivityMemo, type DecisionClientAction } from "./app-v2/workspace/decisionActivity";

const same = (left: unknown, right: unknown) => jsonIdentity(left) === jsonIdentity(right);
const sequence = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Resource input sequence is outside the supported range");
  return String(value);
};
const inputSequence = (value: string) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || String(result) !== value) throw new Error("Resource input sequence cannot be restored safely");
  return result;
};

/** The journal contains original business requests, never the session token. */
export function resourcePendingValue(action: ResourcePending): ResourceDraftPending {
  switch (action.kind) {
    case "typed-context": return action.operation === "save"
      ? { kind: "typed-context-save", request: { ...action.request, contextId: action.request.contextId ?? null, subjectId: action.request.subjectId ?? null, expectedRevisionId: action.request.expectedRevisionId ?? null,
        sourceBasis: { ...action.request.sourceBasis, currentSnapshot: action.request.sourceBasis.currentSnapshot ?? null } }, draftKey: action.draftKey, submittedSeq: sequence(action.submittedSeq) }
      : { kind: "typed-context-withdraw", request: action.request, draftKey: action.draftKey, submittedSeq: sequence(action.submittedSeq) };
    case "knowledge-decision": return { kind: action.kind, request: { ...action.request, adoption: action.request.adoption ? { ...action.request.adoption,
      contextId: action.request.adoption.contextId ?? null, subjectId: action.request.adoption.subjectId ?? null, expectedRevisionId: action.request.adoption.expectedRevisionId ?? null,
      sourceBasis: { ...action.request.adoption.sourceBasis, currentSnapshot: action.request.adoption.sourceBasis.currentSnapshot ?? null } } : null },
      draftKey: action.draftKey, submittedSeq: sequence(action.submittedSeq), submittedFields: action.submittedFields };
    case "term": return { kind: action.kind, request: { ...action.request, termId: action.request.termId ?? null, expectedRevisionId: action.request.expectedRevisionId ?? null,
      scopeUnitId: action.request.scopeUnitId ?? null, reason: action.request.reason ?? "" }, submittedSeq: sequence(action.submittedSeq), aliasInput: action.aliasInput };
    case "context": return { kind: action.kind, request: { ...action.request, expectedRevisionId: action.request.expectedRevisionId ?? null }, submittedSeq: sequence(action.submittedSeq) };
    case "correction": return { kind: action.kind, request: action.request, submittedSeq: sequence(action.submittedSeq) };
    case "decision": return { kind: action.kind, request: { ...action.request, expectedRevisionId: action.request.expectedRevisionId ?? null }, locale: action.locale, submittedSeq: action.submittedSeq };
    case "capture": return { kind: action.kind, request: action.request, submittedSeq: action.submittedSeq };
  }
}
export function resourceFactPendingValue(pending: NonNullable<ResourceDraftState["factPending"]>): ResourceFactPending {
  return { request: { ...pending.request, expectedDecisionId: pending.request.expectedDecisionId ?? null }, submittedSeq: sequence(pending.submittedSeq) };
}
function restoredPending(value: ResourceDraftPending, session: SessionRequest): ResourcePending {
  if (value.kind === "typed-context-save" || value.kind === "typed-context-withdraw") return value.kind === "typed-context-save"
    ? { kind: "typed-context", operation: "save", request: value.request, session, draftKey: value.draftKey, submittedSeq: inputSequence(value.submittedSeq) }
    : { kind: "typed-context", operation: "withdraw", request: value.request, session, draftKey: value.draftKey, submittedSeq: inputSequence(value.submittedSeq) };
  if (value.kind === "knowledge-decision") return { ...value, session, submittedSeq: inputSequence(value.submittedSeq) };
  if (value.kind === "term" || value.kind === "context" || value.kind === "correction") return { ...value, session, submittedSeq: inputSequence(value.submittedSeq) };
  return { ...value, session };
}

export function resourceDraftValue(state: ResourceDraftState, editSeq: string): ResourceDraftValue {
  const knowledge = Object.values(state.knowledgeDrafts).filter(draft => knowledgeProposalDirty(draft) || state.pending?.kind === "knowledge-decision" && state.pending.draftKey === draft.key);
  return { ...(state.proposalEditDraft ? { proposalEditDraft: { ...state.proposalEditDraft, editSeq: sequence(state.proposalEditDraft.editSeq) } } : {}), editSeq, locale: state.locale, selectedTerm: state.selectedTerm,
    termDraft: { ...state.termDraft, scopeUnitId: state.termDraft.scopeUnitId ?? null, reason: state.termDraft.reason ?? "" },
    aliasInput: state.aliasInput, termSeq: sequence(state.termSeq), newerTerm: state.newerTerm,
    selectedUnit: state.selectedUnit, contextRevision: state.contextRevision, contextDraft: state.contextDraft, contextReason: state.contextReason,
    contextSeq: sequence(state.contextSeq), newerContext: state.newerContext,
    correctionDraft: state.correctionDraft ? { ...state.correctionDraft, editSeq: sequence(state.correctionDraft.editSeq) } : null,
    factDraft: state.factDraft ? { ...state.factDraft, editSeq: sequence(state.factDraft.editSeq) } : null,
    typedDrafts: Object.values(state.typedDrafts).map(({ failure: _failure, notice: _notice, ...draft }) => ({ ...draft, editSeq: sequence(draft.editSeq) })),
    typedActiveKey: state.typedActiveKey,
    knowledgeDrafts: knowledge.map(({ preview: _preview, confirmWiderScope: _confirmation, failure: _failure, ...draft }) => ({ ...draft, editSeq: sequence(draft.editSeq) })),
    knowledgeActiveKey: knowledge.some(draft => draft.key === state.knowledgeActiveKey) ? state.knowledgeActiveKey : null,
    previewCaptureId: state.previewCapture?.captureId ?? state.previewCaptureId, fixedContextId: state.fixedContext?.captureId ?? state.fixedContextId,
    pickerUnknown: state.pickerUnknown || state.notice === "pickerUnknown",
    pending: state.pending ? resourcePendingValue(state.pending) : null,
    factPending: state.factPending ? resourceFactPendingValue(state.factPending) : null };
}
export function restoreResourceDraft(initial: ResourceDraftState, value: ResourceDraftValue, session: SessionRequest): ResourceDraftState {
  return { ...initial, proposalEditDraft: value.proposalEditDraft ? { ...value.proposalEditDraft, editSeq: inputSequence(value.proposalEditDraft.editSeq) } : null, locale: value.locale, selectedTerm: value.selectedTerm, termDraft: value.termDraft, aliasInput: value.aliasInput,
    termSeq: inputSequence(value.termSeq), newerTerm: value.newerTerm, selectedUnit: value.selectedUnit, contextRevision: value.contextRevision,
    contextDraft: value.contextDraft, contextReason: value.contextReason, contextSeq: inputSequence(value.contextSeq), newerContext: value.newerContext,
    correctionDraft: value.correctionDraft ? { ...value.correctionDraft, evidence: { ...value.correctionDraft.evidence, current: false }, editSeq: inputSequence(value.correctionDraft.editSeq) } : null,
    factDraft: value.factDraft ? { ...value.factDraft, editSeq: inputSequence(value.factDraft.editSeq) } : null,
    typedDrafts: Object.fromEntries(value.typedDrafts.map(draft => [draft.key, { ...draft, editSeq: inputSequence(draft.editSeq), notice: null, failure: null }])), typedActiveKey: value.typedActiveKey,
    knowledgeDrafts: Object.fromEntries(value.knowledgeDrafts.map(draft => [draft.key, { ...draft, editSeq: inputSequence(draft.editSeq), preview: null, confirmWiderScope: false, failure: null }])), knowledgeActiveKey: value.knowledgeActiveKey,
    previewCaptureId: value.previewCaptureId, fixedContextId: value.fixedContextId, previewNeedsRefresh: value.previewCaptureId !== null,
    pickerUnknown: value.pickerUnknown, notice: value.pickerUnknown ? "pickerUnknown" : null,
    pending: value.pending ? restoredPending(value.pending, session) : null, pendingUncertain: value.pending !== null,
    pendingRecorded: false, pendingCheckedMissing: false,
    factPending: value.factPending ? { request: value.factPending.request, submittedSeq: inputSequence(value.factPending.submittedSeq) } : null, factCheckedMissing: false };
}

export interface ResourceJournalState {
  hydration: "idle" | "loading" | "ready" | "failed";
  dirty: boolean; busy: boolean; failure: CommandFailure | null; conflict: ResourceDraftHead | null; retired: boolean; restored: boolean;
}
type Ports = typeof resourceDraftCommands;
type Write = Parameters<Ports["write"]>[0];
type Resolve = Parameters<Ports["resolve"]>[0];
type Job = { kind: "write"; request: Write } | { kind: "resolve"; request: Resolve; apply: (state: ResourceDraftState) => ResourceDraftState };

/** Persistence ordering only. ResourceDraftSession remains the sole input/action owner. */
export class ResourceDraftJournal {
  private readonly kernel = new DraftKernel();
  readonly writerId = crypto.randomUUID();
  private readonly activity = new DecisionActivityMemo(this.writerId);
  private readonly listeners = new Set<() => void>();
  private head: ResourceDraftHead | null = null;
  private editSeq = "0";
  private desired = "";
  private job: Job | null = null;
  private loading: Promise<boolean> | null = null;
  private writing: Promise<boolean> | null = null;
  private scheduled = false;
  private state: ResourceJournalState = { hydration: "idle", dirty: false, busy: false, failure: null, conflict: null, retired: false, restored: false };
  constructor(readonly session: SessionRequest, private readonly access: {
    current: () => ResourceDraftState; apply: (change: (state: ResourceDraftState) => ResourceDraftState) => void;
    hydrate: (value: ResourceDraftValue) => void; publish: (state: ResourceJournalState) => void; live: () => boolean;
    persisted: () => void;
  }, private readonly ports: Ports = resourceDraftCommands) {}
  getSnapshot = () => this.state;
  getInputSequence = () => this.editSeq;
  getDecisionActivity = () => this.activity.getSnapshot();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  submission(primary: ResourcePending | null, fact: ResourceDraftState["factPending"] = null) {
    const actions: DecisionClientAction[] = primary ? [{ key: { kind: "resource" }, slot: "primary", actionId: primary.request.actionId, submittedSeq: String(primary.submittedSeq) }]
      : fact ? [{ key: { kind: "resource" }, slot: "resource-fact", actionId: fact.request.actionId, submittedSeq: String(fact.submittedSeq) }] : [];
    this.activity.observe(actions, !this.kernel.live); this.listeners.forEach(listener => listener());
  }
  private live() { return this.kernel.live && this.access.live(); }
  private publish(patch: Partial<ResourceJournalState>) { this.state = { ...this.state, ...patch }; this.access.publish(this.state); this.listeners.forEach(listener => listener()); }
  initialize(): Promise<boolean> {
    if (!this.live()) return Promise.resolve(false);
    if (this.loading) return this.loading;
    if (this.head && this.state.hydration === "ready") return Promise.resolve(true);
    this.publish({ hydration: "loading", failure: null });
    this.loading = this.ports.read({ sessionToken: this.session.sessionToken, key: { projectId: this.session.projectId } }).then(head => {
      if (!this.live()) return false;
      if (head.value) this.access.hydrate(head.value);
      this.head = head; this.editSeq = head.value?.editSeq ?? "0";
      this.desired = jsonIdentity(resourceDraftValue(this.access.current(), this.editSeq)) ?? "";
      this.publish({ hydration: "ready", dirty: false, failure: null, restored: head.value !== null }); return true;
    }).catch(error => { if (this.live()) this.publish({ hydration: "failed", failure: commandFailure(error) }); return false;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }
  observe() {
    if (!this.live() || this.state.hydration !== "ready") return;
    const encoded = jsonIdentity(resourceDraftValue(this.access.current(), this.editSeq));
    if (encoded === this.desired) return;
    this.editSeq = nextEditSeq(this.editSeq); this.desired = jsonIdentity(resourceDraftValue(this.access.current(), this.editSeq)) ?? "";
    this.publish({ dirty: true });
    if (!this.scheduled && !this.job && !this.state.failure && !this.state.conflict) {
      this.scheduled = true;
      queueMicrotask(() => { this.scheduled = false; if (this.live()) void this.flush(); });
    }
  }
  private write(value: ResourceDraftValue): Write {
    if (!this.head) throw new Error("Resource input has not loaded");
    return { sessionToken: this.session.sessionToken, write: { key: this.head.key, expectedRevision: this.head.revision, writerId: this.writerId, value } };
  }
  private accept(job: Job, head: ResourceDraftHead) {
    this.head = head; this.job = null;
    if (job.kind === "resolve") this.access.apply(job.apply);
    const value = resourceDraftValue(this.access.current(), this.editSeq);
    this.desired = jsonIdentity(value) ?? "";
    this.publish({ busy: false, failure: null, conflict: null, dirty: !same(value, head.value) });
    this.access.persisted();
  }
  private async execute(job: Job): Promise<boolean> {
    if (!this.live()) return false;
    this.job = job; this.publish({ busy: true });
    try {
      const head = job.kind === "write" ? await this.ports.write(job.request) : await this.ports.resolve(job.request);
      if (!this.live()) return false;
      this.accept(job, head); return true;
    } catch (error) { if (this.live()) this.publish({ busy: false, failure: commandFailure(error) }); return false; }
  }
  private async flushCurrent(): Promise<boolean> {
    if (!this.live() || this.state.hydration !== "ready" || this.job || this.state.failure || this.state.conflict) return false;
    while (this.live() && this.state.dirty) if (!await this.execute({ kind: "write", request: this.write(resourceDraftValue(this.access.current(), this.editSeq)) })) return false;
    return this.live();
  }
  async flush(): Promise<boolean> {
    while (this.writing) if (!await this.writing) return false;
    if (!this.live()) return false;
    const flight = this.kernel.enqueue("resource", () => this.flushCurrent()); this.writing = flight;
    try { return await flight; }
    catch (error) { if (this.live()) this.publish({ failure: commandFailure(error) }); return false; }
    finally { if (this.writing === flight) this.writing = null; }
  }
  async resolve(target: ResourceDraftResolveTarget, disposition: ResourceDraftDisposition, apply: (state: ResourceDraftState) => ResourceDraftState): Promise<boolean> {
    while (this.writing) if (!await this.writing) return false;
    const flight = this.kernel.enqueue("resource", async () => {
      if (!await this.flushCurrent()) return false;
      const before = this.access.current();
      const actual = target.kind === "primary" ? before.pending && resourcePendingValue(before.pending) : before.factPending && resourceFactPendingValue(before.factPending);
      if (!same(actual, target.pending)) return false;
      this.editSeq = nextEditSeq(this.editSeq);
      const request: Resolve = { sessionToken: this.session.sessionToken, resolve: { write: this.write(resourceDraftValue(apply(before), this.editSeq)).write, target, disposition } };
      if (!await this.execute({ kind: "resolve", request, apply })) return false;
      return this.flushCurrent();
    });
    this.writing = flight;
    try { return await flight; }
    catch (error) { if (this.live()) this.publish({ failure: commandFailure(error) }); return false; }
    finally { if (this.writing === flight) this.writing = null; }
  }
  async retry(): Promise<boolean> {
    if (!this.live() || this.writing || this.state.busy) return false;
    if (this.state.hydration !== "ready") return this.initialize();
    const job = this.job;
    this.publish({ busy: true });
    const flight = this.kernel.enqueue("resource", async () => {
      const head = await this.ports.read({ sessionToken: this.session.sessionToken, key: { projectId: this.session.projectId } });
      if (!this.live()) return false;
      const frame = job?.kind === "write" ? job.request.write : job?.request.resolve.write;
      if (job && frame && head.writerId === frame.writerId && same(head.value, frame.value)) this.accept(job, head);
      else if (head.revision !== this.head?.revision) { this.publish({ busy: false, conflict: head }); return false; }
      else {
        this.publish({ busy: false, failure: null });
        if (job && !await this.execute(job)) return false;
      }
      return this.flushCurrent();
    });
    this.writing = flight;
    try { return await flight; }
    catch (error) { if (this.live()) this.publish({ busy: false, failure: commandFailure(error) }); return false; }
    finally { if (this.writing === flight) this.writing = null; }
  }
  async keepLocal(expected: ResourceDraftState, stored: ResourceDraftHead): Promise<boolean> {
    if (!this.live() || this.writing || this.state.conflict !== stored || this.access.current() !== expected) return false;
    const local = resourceDraftValue(expected, this.editSeq);
    if (!same(local.pending, stored.value?.pending ?? null) || !same(local.factPending, stored.value?.factPending ?? null)) return false;
    this.head = stored; this.job = null; this.publish({ conflict: null, failure: null, dirty: true });
    return this.flush();
  }
  retire() { this.kernel.retire(); this.submission(null); this.publish({ retired: true, busy: false }); }
}
