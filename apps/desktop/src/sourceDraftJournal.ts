import { commandFailure, type CommandFailure } from "./CommandFailure";
import type { SessionRequest } from "./executionCommands";
import { jsonIdentity } from "./pluginToolChoices";
import { sourceDraftCommands, canonicalSourceDraft, type SourceDraftHead, type SourceDraftValue, type SourceDraftPending,
  type SourceDraftHookStop, type SourceDraftResolveTarget, type SourceDraftDisposition } from "./sourceDraftCommands";
import type { SourceDraftState } from "./SourceDraftSession";
import type { SourceMaintenanceHookState } from "./SourceMaintenanceHook";
import { DraftKernel, nextEditSeq } from "./app-v2/workspace/draftKernel";
import { DecisionActivityMemo, type DecisionClientAction } from "./app-v2/workspace/decisionActivity";

export interface SourceDraftInputs { source: SourceDraftState; hook: SourceMaintenanceHookState }
const same = (left: unknown, right: unknown) => jsonIdentity(left) === jsonIdentity(right);
const sequence = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Source input sequence is outside the supported range");
  return String(value);
};
export function sourceInputSequence(value: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || String(result) !== value) throw new Error("Source input sequence cannot be restored safely");
  return result;
}
function noToken<T extends SessionRequest>(value: T): Omit<T, "sessionToken"> { const { sessionToken: _token, ...request } = value; return request; }

/** Only an original frozen request, without the session's native authority. */
export function sourcePendingValue(value: SourceDraftState): SourceDraftPending | null {
  if (!value.pendingStart && !value.pendingPlugin && !value.pendingApply) return null;
  if (!value.submission) throw new Error("Source request is missing its original input sequence");
  const sequences = { submittedSeq: value.submission.submittedSeq, submittedMappingSeq: sequence(value.submission.submittedMappingSeq) };
  if (value.pendingStart) return { kind: "start", request: noToken(value.pendingStart), ...sequences };
  if (value.pendingApply) {
    if (!value.pendingApplyUnitId) throw new Error("Source adoption has no original unit");
    const request = noToken(value.pendingApply), confirmation = request.confirmation;
    return { kind: "adopt", unitId: value.pendingApplyUnitId, request: { ...request, confirmation: { ...confirmation,
      expectedCurrentSnapshot: confirmation.expectedCurrentSnapshot ?? null, actor: confirmation.actor ?? null, lineage: confirmation.lineage ?? [],
      lineageBaseSnapshot: confirmation.lineageBaseSnapshot ?? null, maintenanceHook: confirmation.maintenanceHook ?? null } }, ...sequences };
  }
  const pending = value.pendingPlugin;
  if (!pending) throw new Error("Source request changed while it was being retained");
  switch (pending.pendingKind) {
    case "capture": return { kind: "capture", request: noToken(pending.request), ...sequences };
    case "prepare-check": return { kind: "prepare-check", request: noToken(pending.request), ...sequences };
    case "start-check": return { kind: "start-check", request: noToken(pending.request), ...sequences };
    case "finish-check": return { kind: "finish-check", request: noToken(pending.request), ...sequences };
  }
}
export function sourceHookStopValue(value: SourceMaintenanceHookState): SourceDraftHookStop | null {
  return value.stop && (value.stop.pending || value.stop.unknown)
    ? { request: noToken(value.stop.request), submittedSeq: value.stop.submittedSeq } : null;
}
export function sourceDraftValue(inputs: SourceDraftInputs, editSeq: string): SourceDraftValue {
  const { source: value, hook } = inputs;
  return canonicalSourceDraft({ editSeq, mappingSeq: sequence(value.editSeq), domain: value.domain, source: value.source,
    sourceLanguage: value.sourceLanguage, declared: value.declared, selectionLabel: value.selection?.folderName ?? value.selectionLabel,
    updating: value.updating, attemptId: value.attempt, checkAttemptId: value.checkAttempt,
    captureRequest: value.captureRequest, checkPrepareRequest: value.checkPrepareRequest, comparisonRef: value.comparisonRef,
    lineage: Object.values(value.lineage).sort((left, right) => left.newOrdinal - right.newOrdinal), actor: value.actor,
    filter: value.filter, appliedFilter: value.appliedFilter, manualOrdinal: value.manualOrdinal, historicalQuery: value.historicalQuery,
    previewAfter: value.previewAfter, comparisonAfter: value.comparisonAfter, historicalSearch: value.historicalSearch,
    receiptRef: value.receiptRef, pickerUncertain: value.pickerUncertain,
    hook: { locale: hook.locale, enabledIntent: hook.enabled, sourceActionId: hook.sourceActionId },
    pending: sourcePendingValue(value), hookStop: sourceHookStopValue(hook) });
}
export function restoreSourceDraft(initial: SourceDraftInputs, value: SourceDraftValue, session: SessionRequest): SourceDraftInputs {
  const pending = value.pending;
  const source: SourceDraftState = { ...initial.source, domain: value.domain, source: value.source, sourceLanguage: value.sourceLanguage,
    declared: value.declared && value.sourceLanguage === initial.source.sourceLanguage, selectionLabel: value.selectionLabel, updating: value.updating, attempt: value.attemptId,
    checkAttempt: value.checkAttemptId, captureRequest: value.captureRequest, checkPrepareRequest: value.checkPrepareRequest,
    comparisonRef: value.comparisonRef, receiptRef: value.receiptRef, pickerUncertain: value.pickerUncertain,
    editSeq: sourceInputSequence(value.mappingSeq), lineage: Object.fromEntries(value.lineage.map(choice => [choice.newOrdinal, choice])),
    actor: value.actor, filter: value.filter, appliedFilter: value.appliedFilter, manualOrdinal: value.manualOrdinal,
    historicalQuery: value.historicalQuery, previewAfter: value.previewAfter, comparisonAfter: value.comparisonAfter, historicalSearch: value.historicalSearch,
    preparationExpired: !!value.captureRequest || !!value.checkPrepareRequest || value.selectionLabel !== null,
    submission: pending ? { submittedSeq: pending.submittedSeq, submittedMappingSeq: sourceInputSequence(pending.submittedMappingSeq) } : null,
    pendingUncertain: pending !== null, pendingObserved: null, recoveredPending: pending !== null,
    pendingStart: pending?.kind === "start" ? { ...pending.request, sessionToken: session.sessionToken } : null,
    pendingApply: pending?.kind === "adopt" ? { ...pending.request, sessionToken: session.sessionToken } : null,
    pendingApplyUnitId: pending?.kind === "adopt" ? pending.unitId : null,
    pendingPlugin: pending?.kind === "capture" ? { pendingKind: "capture", request: { ...pending.request, sessionToken: session.sessionToken } }
      : pending?.kind === "prepare-check" ? { pendingKind: "prepare-check", request: { ...pending.request, sessionToken: session.sessionToken } }
      : pending?.kind === "start-check" ? { pendingKind: "start-check", request: { ...pending.request, sessionToken: session.sessionToken } }
      : pending?.kind === "finish-check" ? { pendingKind: "finish-check", request: { ...pending.request, sessionToken: session.sessionToken } } : null,
    // Cached preparation, consent and live proofs are deliberately not restored.
    selection: null, preflight: null, checkReview: null, preview: null, comparison: null, estimate: null,
    confirmed: false, producerConsent: null, checkerConsent: null, preparedAction: null, receipt: null,
    stale: value.comparisonRef !== null, receiptChecked: false, startRetryAllowed: false };
  return { source, hook: { ...initial.hook, locale: value.hook.locale, enabled: value.hook.enabledIntent,
    activation: null, sourceActionId: value.hook.sourceActionId, originalActivation: null, originalRequest: null,
    stop: value.hookStop ? { request: { ...value.hookStop.request, sessionToken: session.sessionToken }, submittedSeq: value.hookStop.submittedSeq,
      pending: false, unknown: true, notKnown: false, ended: false } : null } };
}

export interface SourceJournalState {
  hydration: "idle" | "loading" | "ready" | "failed";
  dirty: boolean; busy: boolean; failure: CommandFailure | null; conflict: SourceDraftHead | null; retired: boolean; restored: boolean;
}
type Ports = typeof sourceDraftCommands;
type Write = Parameters<Ports["write"]>[0];
type Resolve = Parameters<Ports["resolve"]>[0];
type Change = (before: SourceDraftInputs) => SourceDraftInputs;
type Job = { kind: "write"; request: Write } | { kind: "resolve"; request: Resolve; apply: Change };

/** Serializes the original Source owner's local frames, without running source actions. */
export class SourceDraftJournal {
  private readonly kernel = new DraftKernel();
  private readonly writerId = crypto.randomUUID();
  private head: SourceDraftHead | null = null;
  private editSeq = "0";
  private desired = "";
  private scheduled = false;
  private writing: Promise<boolean> | null = null;
  private loading: Promise<boolean> | null = null;
  private job: Job | null = null;
  private state: SourceJournalState = { hydration: "idle", dirty: false, busy: false, failure: null, conflict: null, retired: false, restored: false };
  private readonly activity = new DecisionActivityMemo(this.writerId);
  private readonly listeners = new Set<() => void>();
  constructor(private readonly session: SessionRequest, private readonly access: {
    live: () => boolean; current: () => SourceDraftInputs; hydrate: (value: SourceDraftValue) => void;
    apply: (change: Change) => void; publish: (state: SourceJournalState) => void; persisted: () => void;
  }, private readonly ports: Ports = sourceDraftCommands) {}
  getSnapshot = () => this.state;
  sequence = () => this.editSeq;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getDecisionActivity = () => this.activity.getSnapshot();
  submission() {
    const inputs = this.access.current(), pending = sourcePendingValue(inputs.source), stop = sourceHookStopValue(inputs.hook);
    const actions: DecisionClientAction[] = [];
    if (pending) actions.push({ key: { kind: "source" }, slot: "primary", submittedSeq: pending.submittedSeq,
      actionId: pending.kind === "adopt" ? pending.request.actionId : pending.kind === "finish-check" ? pending.request.resultId : pending.request.attemptId });
    if (stop) actions.push({ key: { kind: "source" }, slot: "source-hook-stop", submittedSeq: stop.submittedSeq, actionId: stop.request.stop.actionId });
    this.activity.observe(actions, !this.kernel.live); this.listeners.forEach(listener => listener());
  }
  private live() { return this.kernel.live && this.access.live(); }
  private publish(patch: Partial<SourceJournalState>) { this.state = { ...this.state, ...patch }; this.access.publish(this.state); this.listeners.forEach(listener => listener()); }
  initialize(): Promise<boolean> {
    if (!this.live()) return Promise.resolve(false);
    if (this.loading) return this.loading;
    if (this.head && this.state.hydration === "ready") return Promise.resolve(true);
    this.publish({ hydration: "loading", failure: null });
    this.loading = this.ports.read({ sessionToken: this.session.sessionToken, key: { projectId: this.session.projectId } }).then(head => {
      if (!this.live()) return false;
      if (head.value) this.access.hydrate(head.value);
      this.head = head; this.editSeq = head.value?.editSeq ?? "0";
      this.desired = jsonIdentity(sourceDraftValue(this.access.current(), this.editSeq)) ?? "";
      this.publish({ hydration: "ready", dirty: false, failure: null, restored: head.value !== null }); this.submission(); return true;
    }).catch(error => { if (this.live()) this.publish({ hydration: "failed", failure: commandFailure(error) }); return false;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }
  observe() {
    if (!this.live() || this.state.hydration !== "ready") return;
    const encoded = jsonIdentity(sourceDraftValue(this.access.current(), this.editSeq));
    if (encoded === this.desired) return;
    this.editSeq = nextEditSeq(this.editSeq); this.desired = jsonIdentity(sourceDraftValue(this.access.current(), this.editSeq)) ?? "";
    this.publish({ dirty: true }); this.submission();
    if (!this.scheduled && !this.job && !this.state.failure && !this.state.conflict) {
      this.scheduled = true; queueMicrotask(() => { this.scheduled = false; if (this.live()) void this.flush(); });
    }
  }
  private write(value: SourceDraftValue): Write {
    if (!this.head) throw new Error("Source input has not loaded");
    return { sessionToken: this.session.sessionToken, write: { key: this.head.key, expectedRevision: this.head.revision, writerId: this.writerId, value } };
  }
  private accept(job: Job, head: SourceDraftHead) {
    this.head = head; this.job = null;
    if (job.kind === "resolve") this.access.apply(job.apply);
    const value = sourceDraftValue(this.access.current(), this.editSeq); this.desired = jsonIdentity(value) ?? "";
    this.publish({ busy: false, failure: null, conflict: null, dirty: !same(value, head.value) }); this.submission(); this.access.persisted();
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
    while (this.live() && this.state.dirty) if (!await this.execute({ kind: "write", request: this.write(sourceDraftValue(this.access.current(), this.editSeq)) })) return false;
    return this.live();
  }
  async flush(): Promise<boolean> {
    while (this.writing) if (!await this.writing) return false;
    if (!this.live()) return false;
    const flight = this.kernel.enqueue("source", () => this.flushCurrent()); this.writing = flight;
    try { return await flight; } catch (error) { if (this.live()) this.publish({ failure: commandFailure(error) }); return false; }
    finally { if (this.writing === flight) this.writing = null; }
  }
  async resolve(target: SourceDraftResolveTarget, disposition: SourceDraftDisposition, apply: Change): Promise<boolean> {
    while (this.writing) if (!await this.writing) return false;
    const flight = this.kernel.enqueue("source", async () => {
      if (!await this.flushCurrent()) return false;
      const before = this.access.current(), actual = target.kind === "primary" ? sourcePendingValue(before.source) : sourceHookStopValue(before.hook);
      if (!same(actual, target.pending)) return false;
      this.editSeq = nextEditSeq(this.editSeq);
      const request: Resolve = { sessionToken: this.session.sessionToken, resolve: { write: this.write(sourceDraftValue(apply(before), this.editSeq)).write, target, disposition } };
      if (!await this.execute({ kind: "resolve", request, apply })) return false;
      return this.flushCurrent();
    });
    this.writing = flight;
    try { return await flight; } catch (error) { if (this.live()) this.publish({ failure: commandFailure(error) }); return false; }
    finally { if (this.writing === flight) this.writing = null; }
  }
  async retry(): Promise<boolean> {
    if (!this.live() || this.writing || this.state.busy) return false;
    if (this.state.hydration !== "ready") return this.initialize();
    const job = this.job; this.publish({ busy: true });
    const flight = this.kernel.enqueue("source", async () => {
      const head = await this.ports.read({ sessionToken: this.session.sessionToken, key: { projectId: this.session.projectId } });
      if (!this.live()) return false;
      const frame = job?.kind === "write" ? job.request.write : job?.request.resolve.write;
      if (job && frame && head.writerId === frame.writerId && same(head.value, frame.value)) this.accept(job, head);
      else if (head.revision !== this.head?.revision) { this.publish({ busy: false, conflict: head }); return false; }
      else { this.publish({ busy: false, failure: null }); if (job && !await this.execute(job)) return false; }
      return this.flushCurrent();
    });
    this.writing = flight;
    try { return await flight; } catch (error) { if (this.live()) this.publish({ busy: false, failure: commandFailure(error) }); return false; }
    finally { if (this.writing === flight) this.writing = null; }
  }
  async keepLocal(expected: SourceDraftValue, stored: SourceDraftHead): Promise<boolean> {
    if (!this.live() || this.writing || this.state.conflict !== stored) return false;
    const local = sourceDraftValue(this.access.current(), this.editSeq);
    if (!same(local, expected) || !same(local.pending, stored.value?.pending ?? null) || !same(local.hookStop, stored.value?.hookStop ?? null)) return false;
    this.head = stored; this.job = null; this.publish({ conflict: null, failure: null, dirty: true }); return this.flush();
  }
  retire() { this.kernel.retire(); this.submission(); this.publish({ retired: true, busy: false }); }
}
