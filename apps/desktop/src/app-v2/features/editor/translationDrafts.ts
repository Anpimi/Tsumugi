import { draftCommands, sameDraftKey, sameDraftBasis, sameDraftMerge, sameDraftValue, type DraftBasis, type DraftHead, type DraftKey, type DraftMergeOrigin, type DraftPending, type DraftReadView, type DraftSummary, type DraftValue } from "../../../draftCommands";
import { arenaCommands, type ComparisonView } from "../../../arenaCommands";
import { comparisonBasis, confirmComparisonRead } from "../../../arenaComparison";
import { executionCommands, type SessionRequest } from "../../../executionCommands";
import { hasUnknownOutcome } from "../../../projectCommands";
import { resourceCommands, type TmSuggestion } from "../../../resourceCommands";
import type { SessionReads } from "../../../sessionReads";
import { translationCommands, type TranslationCandidateSliceRow, type TranslationRevision, type TranslationSaveReceipt, type TranslationSelection } from "../../../translationCommands";
import { readCandidateSliceRows } from "../candidates/candidateBatchReads";
import type { LeaveIntent, LifecycleParticipant } from "../../platform/projectLifecycle";
import { DraftKernel, nextEditSeq } from "../../workspace/draftKernel";

export interface DraftFailure {
  kind: "read" | "journal" | "journal-conflict" | "confirmation" | "recovery" | "basis-conflict";
  cause: unknown;
}
export interface DraftEntry {
  key: DraftKey;
  head: DraftHead;
  value: DraftValue | null;
  current: DraftReadView["current"];
  durableSeq: string | null;
  journalPending: boolean;
  busy: boolean;
  checking: boolean;
  recovery: "unchecked" | "pending" | "mismatch" | null;
  replayAllowed: boolean;
  failure: DraftFailure | null;
  currentFailure: unknown | null;
  basisCurrent: boolean;
  newerInputAfterConfirmation: boolean;
}
export interface TranslationDraftSnapshot {
  hydration: "idle" | "loading" | "ready" | "failed";
  revision: number;
  failure: DraftFailure | null;
  retired: boolean;
  mutationReserved: boolean;
  summaries: readonly DraftSummary[];
}
export interface TranslationDraftPorts {
  read: typeof draftCommands.read;
  readMany: typeof draftCommands.readMany;
  write: typeof draftCommands.write;
  clear: typeof draftCommands.clear;
  list: typeof draftCommands.list;
  identity: typeof executionCommands.identity;
  save: typeof translationCommands.save;
  select: typeof translationCommands.select;
  recoverSave: typeof translationCommands.recoverSave;
  recoverSelection: typeof translationCommands.recoverSelection;
  history: typeof translationCommands.history;
  candidateSlice: typeof translationCommands.candidateSlice;
  suggestions: typeof resourceCommands.suggestions;
  comparison: typeof arenaCommands.comparison;
  merge: typeof arenaCommands.merge;
  recoverMerge: typeof arenaCommands.recoverMerge;
  writerId: () => string;
}
export interface TranslationDraftOptions {
  context: SessionRequest;
  reads: Pick<SessionReads, "invalidate">;
  onReveal?: (key: DraftKey) => void;
  ports?: Partial<TranslationDraftPorts>;
}
export interface ConfirmationResult { confirmed: boolean; savedCurrent: boolean }
export interface RevisionStageCapture { editSeq: string; basis: DraftBasis }
export interface RevisionStageResult { staged: boolean; durable: boolean }
export interface CandidateBatchStage { row: TranslationCandidateSliceRow; capture: RevisionStageCapture }
export interface CandidateBatchStageResult extends RevisionStageResult { key: DraftKey }
interface RecordState {
  entry: DraftEntry;
  needsWrite: boolean;
  writing: boolean;
  scheduled: boolean;
  flush: Promise<boolean> | null;
  reading: Promise<DraftEntry | undefined> | null;
  writeAttempt: { expectedRevision: string; value: DraftValue } | null;
  clearAttempt: { expectedRevision: string } | null;
}
const unconfirmed = (): ConfirmationResult => ({ confirmed: false, savedCurrent: false });
const identity = (key: DraftKey) => JSON.stringify([key.projectId, key.unitId, key.locale]);
function freezeValue(value: DraftValue | null) {
  if (!value) return;
  Object.freeze(value.basis);
  if (value.merge) { Object.freeze(value.merge.contributors); Object.freeze(value.merge); }
  if (value.pending?.kind === "merge") { Object.freeze(value.pending.merge.contributors); Object.freeze(value.pending.merge); }
  if (value.pending) { Object.freeze(value.pending.request); Object.freeze(value.pending); }
  Object.freeze(value);
}
function mergeMatches(view: ComparisonView, origin: DraftMergeOrigin, key: DraftKey, basis: DraftBasis, currentBasis = true) {
  confirmComparisonRead(view, origin.comparisonId);
  return view.unitId === key.unitId && view.locale === key.locale && view.sourceRevisionId === basis.sourceRevisionId
    && view.selectionId === basis.selectionId && view.selectedRevisionId === basis.revisionId && view.selectedText === basis.text
    && (!currentBasis || view.basis === origin.expectedBasis) && view.rows.length === origin.contributors.length
    && view.rows.every((row, index) => row.revisionId === origin.contributors[index]
      && row.basisCurrent && row.sourceRevisionId === basis.sourceRevisionId && row.candidateDisposition !== "rejected");
}
function sameBatchCandidate(left: TranslationCandidateSliceRow, right: TranslationCandidateSliceRow) {
  const a = left.revisions[0], b = right.revisions[0];
  return left.candidateCount === 1 && right.candidateCount === 1 && left.revisions.length === 1 && right.revisions.length === 1
    && left.target.unitId === right.target.unitId && left.target.locale === right.target.locale && left.target.basis === right.target.basis
    && left.target.sourceSnapshotId === right.target.sourceSnapshotId && left.target.sourceRevisionId === right.target.sourceRevisionId
    && left.target.sourceText === right.target.sourceText && left.target.selectionId === right.target.selectionId
    && left.target.revisionId === right.target.revisionId && left.target.translationText === right.target.translationText
    && left.selectedOriginKind === right.selectedOriginKind && left.protection.unitId === right.protection.unitId
    && left.protection.locale === right.protection.locale && left.protection.revision === right.protection.revision
    && left.protection.protected === right.protection.protected && a.revisionId === b.revisionId && a.text === b.text
    && a.ordinal === b.ordinal && a.actionId === b.actionId && a.sourceRevisionId === b.sourceRevisionId
    && (a.candidateDecision?.request.actionId ?? null) === (b.candidateDecision?.request.actionId ?? null);
}
function immutableEntry(entry: DraftEntry): DraftEntry {
  freezeValue(entry.value); freezeValue(entry.head.value);
  Object.freeze(entry.key); Object.freeze(entry.head.key); Object.freeze(entry.head);
  if (entry.current.kind === "current") Object.freeze(entry.current.basis);
  Object.freeze(entry.current);
  return Object.freeze(entry);
}

/** A project-session owner. Views borrow entries; they never own their lifetime. */
export class TranslationDrafts {
  private readonly context: SessionRequest;
  private readonly ports: TranslationDraftPorts;
  private readonly writerId: string;
  private readonly kernel = new DraftKernel();
  private readonly records = new Map<string, RecordState>();
  private readonly opening = new Map<string, Promise<DraftEntry | undefined>>();
  private readonly listeners = new Set<() => void>();
  private hydration: Promise<boolean> | null = null;
  private inputRevision = 0;
  private retiredReservation = false;
  private navigationReservation: symbol | null = null;
  private state: TranslationDraftSnapshot = { hydration: "idle", revision: 0, failure: null, retired: false, mutationReserved: false, summaries: [] };

  constructor(private readonly options: TranslationDraftOptions) {
    this.context = Object.freeze({ ...options.context });
    this.ports = { ...draftCommands, identity: executionCommands.identity, save: translationCommands.save,
      select: translationCommands.select, recoverSave: translationCommands.recoverSave,
      recoverSelection: translationCommands.recoverSelection, history: translationCommands.history, candidateSlice: translationCommands.candidateSlice,
      suggestions: resourceCommands.suggestions,
      comparison: arenaCommands.comparison, merge: arenaCommands.merge, recoverMerge: arenaCommands.recoverMerge,
      writerId: () => crypto.randomUUID(), ...options.ports };
    this.writerId = this.ports.writerId();
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getEntry = (key: DraftKey): DraftEntry | undefined => this.records.get(identity(key))?.entry;
  private validKey(key: DraftKey) { return key.projectId === this.context.projectId; }
  private summaries(source: readonly DraftSummary[]): readonly DraftSummary[] {
    // Unopened entries retain the Host's metadata. Loaded entries project their
    // actual owner state, including input that has not reached the disk yet.
    const projection = new Map(source.map(summary => [identity(summary.key), summary]));
    for (const [id, record] of this.records) {
      const { value, head, key } = record.entry;
      if (value && (head.value !== null || record.needsWrite || record.writing)) projection.set(id, {
        key, revision: head.revision, editSeq: value.editSeq, sourceRevisionId: value.basis.sourceRevisionId, hasPending: value.pending !== null,
      });
      else projection.delete(id);
    }
    return [...projection.values()].sort((a, b) => a.key.locale.localeCompare(b.key.locale) || a.key.unitId.localeCompare(b.key.unitId));
  }
  private notify(patch: Partial<TranslationDraftSnapshot> = {}) {
    if (!this.kernel.live) return;
    this.state = { ...this.state, ...patch, summaries: this.summaries(patch.summaries ?? this.state.summaries),
      revision: this.state.revision + 1, mutationReserved: this.kernel.reserved };
    this.listeners.forEach(listener => listener());
  }
  private update(record: RecordState, patch: Partial<DraftEntry> = {}) {
    if (!this.kernel.live) return;
    const entry = { ...record.entry, ...patch };
    entry.basisCurrent = entry.value !== null && entry.current.kind === "current" && sameDraftBasis(entry.value.basis, entry.current.basis);
    entry.journalPending = record.needsWrite || record.writing;
    record.entry = immutableEntry(entry);
    this.notify();
  }
  private pending() { return [...this.records.values()].some(record => record.entry.value?.pending); }

  private observe(record: RecordState, view: DraftReadView) {
    const changed = record.entry.head.revision !== view.head.revision;
    const written = record.writeAttempt && view.head.writerId === this.writerId && view.head.value
      && sameDraftValue(record.writeAttempt.value, view.head.value);
    const cleared = record.clearAttempt && view.head.value === null
      && BigInt(view.head.revision) === BigInt(record.clearAttempt.expectedRevision) + 1n;
    if (changed && (written || cleared)) {
      record.writeAttempt = null; record.clearAttempt = null;
      record.needsWrite = view.head.value !== null
        ? !record.entry.value || !sameDraftValue(record.entry.value, view.head.value) : record.needsWrite;
      this.update(record, { head: view.head, current: view.current, currentFailure: null,
        durableSeq: view.head.value?.editSeq ?? null, failure: null });
    } else this.update(record, { current: view.current, currentFailure: null,
      ...(changed ? { failure: { kind: "journal-conflict" as const, cause: new Error("Draft head changed in another writer") } }
        : record.entry.failure?.kind === "read" ? { failure: null } : {}) });
  }

  private acceptRead(view: DraftReadView): DraftEntry {
    const key = view.head.key, id = identity(key), record = this.records.get(id);
    if (record) { this.observe(record, view); return record.entry; }
    const value = view.head.value ?? (view.current.kind === "current"
      ? { basis: view.current.basis, text: view.current.basis.text ?? "", editSeq: "0", pending: null } : null);
    const created: RecordState = { needsWrite: false, writing: false, scheduled: false, flush: null, reading: null, writeAttempt: null, clearAttempt: null,
      entry: { key: { ...key }, head: view.head, value, current: view.current,
        durableSeq: view.head.value?.editSeq ?? null, journalPending: false, busy: false, checking: false,
        recovery: value?.pending ? "unchecked" : null, replayAllowed: false, failure: null, currentFailure: null,
        basisCurrent: !!value && view.current.kind === "current" && sameDraftBasis(value.basis, view.current.basis), newerInputAfterConfirmation: false } };
    created.entry = immutableEntry(created.entry);
    this.records.set(id, created); this.notify(); return created.entry;
  }

  initialize(): Promise<boolean> {
    if (!this.kernel.live) return Promise.resolve(false);
    if (this.hydration) return this.hydration;
    if (this.state.hydration === "ready") return Promise.resolve(true);
    this.notify({ hydration: "loading", failure: null });
    const loading = (async () => {
      const summaries: DraftSummary[] = [];
      let after: DraftKey | null = null;
      try {
        do {
          const page = await this.ports.list({ ...this.context, after, limit: 100 });
          if (!this.kernel.live) return false;
          summaries.push(...page.items);
          for (const summary of page.items) if (summary.hasPending) {
            if (!await this.open(summary.key)) throw new Error("Pending draft could not be loaded");
          }
          after = page.next;
        } while (after !== null);
        this.notify({ hydration: "ready", summaries, failure: null }); return true;
      } catch (cause) {
        this.notify({ hydration: "failed", failure: { kind: "read", cause } }); return false;
      }
    })();
    this.hydration = loading;
    void loading.finally(() => { if (this.hydration === loading) this.hydration = null; });
    return loading;
  }

  open(key: DraftKey): Promise<DraftEntry | undefined> {
    if (!this.kernel.live || !this.validKey(key)) return Promise.resolve(undefined);
    const id = identity(key), existing = this.records.get(id);
    if (existing?.reading) return existing.reading;
    const waiting = this.opening.get(id); if (waiting) return waiting;
    const reading = this.kernel.enqueue(id, async () => {
      try {
        const view = await this.ports.read({ sessionToken: this.context.sessionToken, key });
        if (!this.kernel.live) return undefined;
        return this.acceptRead(view);
      } catch (cause) {
        const record = this.records.get(id);
        if (record) this.update(record, { currentFailure: cause });
        else this.notify({ failure: { kind: "read", cause } });
        return undefined;
      }
    }).catch(() => undefined);
    this.opening.set(id, reading);
    if (existing) existing.reading = reading;
    void reading.finally(() => {
      if (this.opening.get(id) === reading) this.opening.delete(id);
      if (existing?.reading === reading) existing.reading = null;
    });
    return reading;
  }

  /** A batch borrows the same heads as row editors. Later row reads or input
   * win over this observation; no batch response replaces an input value. */
  async openMany(keys: readonly DraftKey[]): Promise<(DraftEntry | undefined)[]> {
    if (!keys.length || keys.length > 50 || keys.some(key => !this.validKey(key) || key.locale !== keys[0].locale)
      || new Set(keys.map(identity)).size !== keys.length) throw new Error("Invalid batch draft members");
    if (!this.kernel.live) return keys.map(() => undefined);
    const captured = keys.map(key => this.records.get(identity(key))?.entry), views: DraftReadView[] = [];
    try {
      while (views.length < keys.length) {
        const remaining = keys.slice(views.length);
        const page = await this.ports.readMany({ ...this.context, locale: keys[0].locale, unitIds: remaining.map(key => key.unitId) });
        if (!this.kernel.live) return keys.map(() => undefined);
        if (!page.items.length || page.items.length > remaining.length || page.items.some((view, index) => !sameDraftKey(view.head.key, remaining[index]))
          || (page.nextAfter === null ? page.items.length !== remaining.length : page.nextAfter !== page.items.length || page.items.length >= remaining.length)) {
          throw new Error("Draft batch page does not match its members");
        }
        views.push(...page.items);
      }
      return await Promise.all(keys.map((key, index) => this.kernel.enqueue(identity(key), async () => {
        const current = this.records.get(identity(key))?.entry;
        return current !== captured[index] ? current : this.acceptRead(views[index]);
      })));
    } catch (cause) {
      if (this.kernel.live) {
        for (const [index, key] of keys.entries()) {
          const record = this.records.get(identity(key));
          if (record && record.entry === captured[index]) this.update(record, { currentFailure: cause });
        }
        this.notify({ failure: { kind: "read", cause } });
      }
      return keys.map(() => undefined);
    }
  }

  edit(key: DraftKey, text: string): boolean {
    const record = this.records.get(identity(key));
    if (!this.kernel.live || !record?.entry.value) return false;
    this.inputRevision++; record.needsWrite = true;
    this.update(record, { value: { ...record.entry.value, text, editSeq: nextEditSeq(record.entry.value.editSeq) }, newerInputAfterConfirmation: false });
    this.schedule(record); return true;
  }
  private schedule(record: RecordState) {
    if (record.scheduled || !this.kernel.live) return;
    record.scheduled = true;
    queueMicrotask(() => { record.scheduled = false; if (this.kernel.live) void this.flush(record.entry.key); });
  }

  async flush(key?: DraftKey): Promise<boolean> {
    if (!this.kernel.live) return false;
    if (!key) return (await Promise.all([...this.records.values()].map(record => this.flush(record.entry.key)))).every(Boolean);
    const record = this.records.get(identity(key)); if (!record) return false;
    if (record.flush) return record.flush;
    if (!record.needsWrite && !record.clearAttempt && record.entry.failure?.kind !== "journal") return record.entry.failure?.kind !== "journal-conflict";
    const flushing = this.kernel.enqueue(identity(key), async () => {
      if (record.clearAttempt || !record.needsWrite && record.entry.failure?.kind === "journal") {
        try {
          const view = await this.ports.read({ sessionToken: this.context.sessionToken, key: record.entry.key });
          if (!this.kernel.live) return false;
          this.observe(record, view);
          if (record.entry.failure?.kind === "journal-conflict") return false;
          // A failed optional cleanup may leave an already durable draft intact.
          if (!record.needsWrite) { record.clearAttempt = null; this.update(record, { failure: null }); }
        } catch (cause) { this.update(record, { failure: { kind: "journal", cause } }); return false; }
      }
      while (this.kernel.live && record.needsWrite) {
        if (record.entry.failure?.kind === "journal-conflict") return false;
        const attempt = record.writeAttempt ?? (record.entry.value ? { value: record.entry.value, expectedRevision: record.entry.head.revision } : null);
        if (!attempt) return false;
        const { value, expectedRevision } = attempt;
        record.writeAttempt = attempt;
        record.writing = true; this.update(record);
        try {
          const head = await this.ports.write({ sessionToken: this.context.sessionToken,
            write: { key: record.entry.key, expectedRevision, writerId: this.writerId, value } });
          if (!this.kernel.live) return false;
          record.writeAttempt = null;
          record.needsWrite = !record.entry.value || !sameDraftValue(record.entry.value, value);
          this.update(record, { head, durableSeq: value.editSeq,
            ...(record.entry.failure?.kind === "journal" ? { failure: null } : {}) });
        } catch (cause) {
          if (!hasUnknownOutcome(cause)) record.writeAttempt = null;
          this.update(record, { failure: { kind: "journal", cause } }); return false;
        } finally { record.writing = false; this.update(record); }
      }
      return this.kernel.live && !record.needsWrite;
    }).catch(() => false);
    record.flush = flushing;
    void flushing.finally(() => { if (record.flush === flushing) record.flush = null; });
    return flushing;
  }

  reserveMutation(mode: "exclusive" | "retained-for-navigation" = "exclusive"): symbol | null {
    if (this.state.hydration !== "ready" || this.pending()) return null;
    const token = this.kernel.reserve();
    if (token) { this.navigationReservation = mode === "retained-for-navigation" ? token : null; this.notify(); }
    return token;
  }
  ownsMutation(token: symbol) { return this.kernel.owns(token); }
  releaseMutation(token: symbol) { if (this.navigationReservation === token) this.navigationReservation = null; this.kernel.release(token); this.notify(); }

  private fresh(record: RecordState) {
    return this.kernel.live && !!record.entry.value && !record.entry.busy && !record.entry.value.pending
      && record.entry.basisCurrent && record.entry.currentFailure === null && record.entry.failure?.kind !== "journal-conflict"
      && !(record.entry.value.merge && record.entry.failure?.kind === "basis-conflict");
  }
  /** Candidate adoption only creates local input. Formal revision creation remains confirm's job. */
  async stageRevision(key: DraftKey, revision: TranslationRevision, expected: RevisionStageCapture, proof: () => boolean): Promise<RevisionStageResult> {
    const target = { ...key };
    const selected = { revisionId: revision.revisionId, text: revision.text, ordinal: revision.ordinal,
      decisionId: revision.candidateDecision?.request.actionId ?? null };
    if (revision.unitId !== target.unitId || revision.locale !== target.locale || revision.sourceRevisionId !== expected.basis.sourceRevisionId
      || revision.revisionId === expected.basis.revisionId || revision.candidateDecision?.request.disposition === "rejected") return { staged: false, durable: false };
    return this.stageInput(target, expected, proof, async capture => {
      const history = await this.ports.history({ ...this.context, unitId: target.unitId, locale: target.locale,
        afterOrdinal: (BigInt(selected.ordinal) - 1n).toString(), limit: 1 });
      const candidate = history.rows.find(row => row.revisionId === selected.revisionId);
      if (history.unitId !== target.unitId || history.locale !== target.locale || !candidate
        || candidate.unitId !== target.unitId || candidate.locale !== target.locale || candidate.text !== selected.text
        || candidate.sourceRevisionId !== capture.basis.sourceRevisionId || candidate.ordinal !== selected.ordinal
        || candidate.candidateDecision?.request.disposition === "rejected"
        || (candidate.candidateDecision?.request.actionId ?? null) !== selected.decisionId
        || (history.current?.eventId ?? null) !== capture.basis.selectionId
        || (history.current?.revisionId ?? null) !== capture.basis.revisionId || history.currentText !== capture.basis.text) return null;
      return candidate.text;
    });
  }
  /** Bulk adoption stays inside this input owner. Its reads are bounded batches;
   * each journal write retains the ordinary per-head CAS and writer identity. */
  async stageCandidateBatch(items: readonly CandidateBatchStage[], proof: () => boolean): Promise<readonly CandidateBatchStageResult[]> {
    if (!items.length || items.length > 50 || new Set(items.map(item => item.row.target.unitId)).size !== items.length
      || items.some(item => item.row.target.locale !== items[0].row.target.locale
        || item.row.target.sourceSnapshotId !== items[0].row.target.sourceSnapshotId)) throw new Error("Invalid candidate stage batch");
    const captured = structuredClone(items);
    const keys = captured.map(({ row }) => ({ projectId: this.context.projectId, unitId: row.target.unitId, locale: row.target.locale }));
    const results = keys.map(key => ({ key, staged: false, durable: false }));
    const token = proof() ? this.reserveMutation() : null;
    if (!token) return results;
    const current = () => this.kernel.owns(token) && proof();
    try {
      const fresh = await readCandidateSliceRows({ ...this.context, locale: keys[0].locale,
        sourceSnapshotId: captured[0].row.target.sourceSnapshotId, unitIds: keys.map(key => key.unitId), state: "available" }, this.ports.candidateSlice, current);
      if (!current()) return results;
      const opened = await this.openMany(keys);
      if (!current()) return results;
      for (const [index, item] of captured.entries()) {
        if (!current()) break;
        const key = keys[index], record = this.records.get(identity(key)), row = fresh.rows[index], value = record?.entry.value;
        if (!opened[index] || !record || !value || !row || !this.fresh(record) || record.entry.failure !== null || record.entry.journalPending || record.entry.head.value !== null
          || value.pending || value.merge || value.editSeq !== item.capture.editSeq || !sameDraftBasis(value.basis, item.capture.basis)
          || value.text !== (value.basis.text ?? "") || record.entry.current.kind !== "current"
          || record.entry.current.sourceText !== row.target.sourceText || !sameBatchCandidate(item.row, row)
          || row.protection.protected || row.selectedOriginKind !== null && row.selectedOriginKind !== "ai"
          || !sameDraftBasis(value.basis, { sourceRevisionId: row.target.sourceRevisionId, selectionId: row.target.selectionId,
            revisionId: row.target.revisionId, text: row.target.translationText })) continue;
        if (!this.edit(key, row.revisions[0].text)) continue;
        results[index] = { key, staged: true, durable: await this.flush(key) };
        if (!results[index].durable) break;
      }
      return results;
    } finally { this.releaseMutation(token); }
  }
  async stageSuggestion(key: DraftKey, suggestion: TmSuggestion, expected: RevisionStageCapture, proof: () => boolean): Promise<RevisionStageResult> {
    const target = { ...key }, selected = { ...suggestion };
    if (selected.targetLocale !== target.locale) return { staged: false, durable: false };
    return this.stageInput(target, expected, proof, async () => {
      const suggestions = await this.ports.suggestions({ ...this.context, unitId: target.unitId, locale: target.locale, offset: 0, limit: 20 });
      // A TM match retains its donor identity. Equal text from a different unit
      // cannot replace the suggestion that the user actually inspected.
      const candidate = suggestions.find(row => row.translationRevisionId === selected.translationRevisionId);
      return candidate && candidate.unitId === selected.unitId && candidate.sourceRevisionId === selected.sourceRevisionId
        && candidate.sourceText === selected.sourceText && candidate.translationText === selected.translationText
        && candidate.targetLocale === selected.targetLocale && candidate.originKind === selected.originKind
        && candidate.matchKind === selected.matchKind && candidate.scorePercent === selected.scorePercent
        && candidate.isCurrentSelection === selected.isCurrentSelection && candidate.hasHumanApproval === selected.hasHumanApproval
        ? candidate.translationText : null;
    });
  }
  async stageMerge(key: DraftKey, view: ComparisonView, text: string, expected: RevisionStageCapture, proof: () => boolean): Promise<RevisionStageResult> {
    if (view.comparisonId === null) return { staged: false, durable: false };
    const origin: DraftMergeOrigin = { comparisonId: view.comparisonId, contributors: view.rows.map(row => row.revisionId), expectedBasis: view.basis };
    const target = { ...key }, captured = comparisonBasis(view);
    if (!mergeMatches(view, origin, target, expected.basis)) return { staged: false, durable: false };
    return this.stageInput(target, expected, proof, async capture => {
      const current = await this.ports.comparison({ ...this.context, comparisonId: origin.comparisonId });
      return comparisonBasis(current) === captured && mergeMatches(current, origin, target, capture.basis) ? text : null;
    }, origin);
  }
  /** Explicitly rechecks the original contributors while retaining the user's current text. */
  async refreshMerge(key: DraftKey): Promise<boolean> {
    const record = this.records.get(identity(key)), before = record?.entry.value;
    if (!record || !before?.merge || record.entry.busy || before.pending || record.entry.failure?.kind === "journal-conflict") return false;
    const token = this.reserveMutation(); if (!token) return false;
    const unchanged = () => this.kernel.owns(token) && !!record.entry.value && record.entry.value.editSeq === before.editSeq
      && record.entry.value.text === before.text && sameDraftBasis(record.entry.value.basis, before.basis) && sameDraftMerge(record.entry.value.merge, before.merge);
    this.update(record, { busy: true });
    try {
      const view = await this.ports.comparison({ ...this.context, comparisonId: before.merge.comparisonId });
      if (!unchanged()) return false;
      await this.open(key);
      if (!unchanged() || record.entry.current.kind !== "current" || record.entry.currentFailure !== null) return false;
      if (!mergeMatches(view, before.merge, key, record.entry.current.basis, false)) {
        this.update(record, { failure: { kind: "basis-conflict", cause: new Error("Merge contributors changed") } }); return false;
      }
      this.inputRevision++; record.needsWrite = true;
      this.update(record, { value: { ...before, basis: record.entry.current.basis, merge: { ...before.merge, expectedBasis: view.basis }, editSeq: nextEditSeq(before.editSeq) }, failure: null });
      return await this.flush(key);
    } catch (cause) { this.update(record, { failure: { kind: "read", cause } }); return false; }
    finally { this.releaseMutation(token); this.update(record, { busy: false }); }
  }
  private async stageInput(key: DraftKey, expected: RevisionStageCapture, proof: () => boolean,
    readText: (capture: RevisionStageCapture) => Promise<string | null>, merge?: DraftMergeOrigin): Promise<RevisionStageResult> {
    const declined = (): RevisionStageResult => ({ staged: false, durable: false });
    const record = this.records.get(identity(key));
    if (!record || !this.validKey(key) || !this.fresh(record) || record.entry.current.kind !== "current") return declined();
    const capture = { editSeq: expected.editSeq, basis: { ...expected.basis } }, sourceText = record.entry.current.sourceText;
    const unchanged = () => this.kernel.live && proof() && !!record.entry.value
      && record.entry.value.editSeq === capture.editSeq && sameDraftBasis(record.entry.value.basis, capture.basis)
      && record.entry.value.text === (capture.basis.text ?? "") && !record.entry.value.pending && !record.entry.value.merge
      && record.entry.current.kind === "current" && record.entry.current.sourceText === sourceText
      && record.entry.basisCurrent && record.entry.currentFailure === null && record.entry.failure?.kind !== "journal-conflict";
    if (!unchanged()) return declined();
    const token = this.reserveMutation(); if (!token) return declined();
    this.update(record, { busy: true });
    try {
      const text = await readText(capture);
      if (text === null || !this.kernel.owns(token) || !unchanged()) return declined();
      // Wait out an earlier read, then issue a new one. Its stale snapshot cannot
      // authorize adoption after the source, locale, or selection has changed.
      const reading = this.opening.get(identity(key)); if (reading) await reading;
      if (!this.kernel.owns(token) || !unchanged()) return declined();
      await this.open(key);
      if (!this.kernel.owns(token) || !unchanged()) return declined();
      if (!this.edit(key, text)) return declined();
      if (merge) this.update(record, { value: { ...record.entry.value!, merge } });
      return { staged: true, durable: await this.flush(key) };
    } catch (cause) {
      this.update(record, { failure: { kind: "read", cause } }); return declined();
    } finally { this.releaseMutation(token); this.update(record, { busy: false }); }
  }
  confirm(key: DraftKey): Promise<ConfirmationResult> { return this.start(key); }
  selectRevision(key: DraftKey, revision: TranslationRevision): Promise<ConfirmationResult> {
    const value = this.getEntry(key)?.value;
    if (!value || value.merge || value.text !== (value.basis.text ?? "") || revision.unitId !== key.unitId || revision.locale !== key.locale
      || revision.candidateDecision?.request.disposition === "rejected") return Promise.resolve(unconfirmed());
    return this.start(key, revision);
  }
  private async start(key: DraftKey, revision?: TranslationRevision): Promise<ConfirmationResult> {
    const record = this.records.get(identity(key));
    if (!record || !this.fresh(record)) return unconfirmed();
    const token = this.reserveMutation(); if (!token) return unconfirmed();
    const start = record.entry.value!;
    this.update(record, { busy: true, failure: null, replayAllowed: false });
    try {
      const actionId = await this.ports.identity(this.context);
      if (!this.kernel.owns(token)) return unconfirmed();
      // This read starts after identity allocation. An older UI read cannot
      // authorize a removed locale or silently rebind a changed source.
      const previousRead = this.opening.get(identity(key));
      if (previousRead) await previousRead;
      await this.open(key);
      if (!this.kernel.owns(token)) return unconfirmed();
      if (!record.entry.basisCurrent || record.entry.currentFailure !== null || !sameDraftBasis(record.entry.value!.basis, start.basis)) {
        this.update(record, { failure: { kind: "basis-conflict", cause: new Error("Translation basis changed") } }); return unconfirmed();
      }
      if (start.merge && !mergeMatches(await this.ports.comparison({ ...this.context, comparisonId: start.merge.comparisonId }), start.merge, key, start.basis)) {
        this.update(record, { failure: { kind: "basis-conflict", cause: new Error("Merge basis changed") } }); return unconfirmed();
      }
      if (!this.kernel.owns(token)) return unconfirmed();
      const request = { projectId: this.context.projectId, actionId, unitId: key.unitId, locale: key.locale,
        sourceRevisionId: start.basis.sourceRevisionId, expectedSelectionId: start.basis.selectionId };
      const pending: DraftPending = revision
        ? { kind: "selection", request: { ...request, revisionId: revision.revisionId }, submittedSeq: start.editSeq, text: revision.text }
        : start.merge ? { kind: "merge", request: { ...request, text: start.text }, merge: { contributors: [...start.merge.contributors], expectedBasis: start.merge.expectedBasis }, submittedSeq: start.editSeq }
          : { kind: "save", request: { ...request, text: start.text }, submittedSeq: start.editSeq };
      record.needsWrite = true;
      this.update(record, { value: { ...record.entry.value!, pending }, recovery: "unchecked" });
      if (!await this.flush(key) || !this.kernel.owns(token)) return unconfirmed();
      return await this.dispatch(record, pending, false);
    } catch (cause) { this.update(record, { failure: { kind: "confirmation", cause } }); return unconfirmed(); }
    finally { this.releaseMutation(token); this.update(record, { busy: false }); }
  }

  private async dispatch(record: RecordState, pending: DraftPending, recovering: boolean): Promise<ConfirmationResult> {
    let receipt: TranslationSaveReceipt | TranslationSelection;
    this.update(record, { replayAllowed: false, failure: null });
    try {
      receipt = pending.kind === "save"
        ? await this.ports.save({ ...pending.request, sessionToken: this.context.sessionToken })
        : pending.kind === "merge" ? await this.ports.merge({ ...pending.request, sessionToken: this.context.sessionToken, merge: pending.merge })
          : await this.ports.select({ ...pending.request, sessionToken: this.context.sessionToken });
    } catch (cause) {
      if (!this.kernel.live || record.entry.value?.pending !== pending) return unconfirmed();
      if (!recovering && !hasUnknownOutcome(cause)) {
        record.needsWrite = true;
        this.update(record, { value: { ...record.entry.value, pending: null }, recovery: null, failure: { kind: "confirmation", cause } });
        await this.flush(record.entry.key); return unconfirmed();
      }
      this.update(record, { recovery: "unchecked", failure: { kind: "confirmation", cause } });
      if (!hasUnknownOutcome(cause)) return unconfirmed();
      // Query once. A failed query can never re-enter the write catch.
      return this.lookup(record, pending);
    }
    return this.settle(record, pending, receipt);
  }

  async recover(key: DraftKey): Promise<ConfirmationResult> {
    const record = this.records.get(identity(key)), pending = record?.entry.value?.pending;
    if (!this.kernel.live || !record || !pending || record.entry.busy) return unconfirmed();
    this.update(record, { busy: true });
    try { return await this.lookup(record, pending); }
    finally { this.update(record, { busy: false }); }
  }
  private async lookup(record: RecordState, pending: DraftPending): Promise<ConfirmationResult> {
    this.update(record, { checking: true, replayAllowed: false });
    try {
      const result = pending.kind === "save"
        ? await this.ports.recoverSave({ ...pending.request, sessionToken: this.context.sessionToken })
        : pending.kind === "merge" ? await this.ports.recoverMerge({ ...pending.request, sessionToken: this.context.sessionToken, merge: pending.merge })
          : await this.ports.recoverSelection({ ...pending.request, sessionToken: this.context.sessionToken });
      if (!this.kernel.live || record.entry.value?.pending !== pending) return unconfirmed();
      if (result.outcome.kind === "recorded") return this.settle(record, pending, result.outcome.receipt);
      this.update(record, { recovery: result.outcome.kind,
        replayAllowed: result.outcome.kind === "pending" && result.outcome.replay === "explicit-same-request", failure: null });
      return unconfirmed();
    } catch (cause) {
      this.update(record, { recovery: "unchecked", replayAllowed: false, failure: { kind: "recovery", cause } }); return unconfirmed();
    } finally { this.update(record, { checking: false }); }
  }
  async replay(key: DraftKey): Promise<ConfirmationResult> {
    const record = this.records.get(identity(key)), pending = record?.entry.value?.pending;
    if (!this.kernel.live || !record || !pending || record.entry.busy || !record.entry.replayAllowed) return unconfirmed();
    const token = this.kernel.reserve(); if (!token) return unconfirmed();
    this.update(record, { busy: true, replayAllowed: false });
    try {
      if (!await this.flush(key) || !this.kernel.owns(token)) return unconfirmed();
      return await this.dispatch(record, pending, true);
    } finally { this.releaseMutation(token); this.update(record, { busy: false }); }
  }

  private async settle(record: RecordState, pending: DraftPending, receipt: TranslationSaveReceipt | TranslationSelection): Promise<ConfirmationResult> {
    const before = record.entry.value;
    if (!this.kernel.live || before?.pending !== pending) return unconfirmed();
    const selection = "selection" in receipt ? receipt.selection : receipt;
    const text = pending.kind === "selection" ? pending.text : pending.request.text;
    const basis: DraftBasis = { sourceRevisionId: pending.request.sourceRevisionId,
      selectionId: selection.eventId, revisionId: selection.revisionId, text };
    const sameInput = before.editSeq === pending.submittedSeq && (pending.kind === "selection" || before.text === text);
    record.needsWrite = true;
    this.update(record, { value: { ...before, basis, text: sameInput ? text : before.text, pending: null,
      ...(pending.kind === "merge" && sameInput ? { merge: null } : {}) }, recovery: null,
      replayAllowed: false, failure: pending.kind === "merge" && !sameInput
        ? { kind: "basis-conflict", cause: new Error("Merge sources need rechecking for newer input") } : null, newerInputAfterConfirmation: !sameInput });
    this.options.reads.invalidate(["translation", "review"], false);
    const durable = await this.flush(record.entry.key);
    if (!this.kernel.live) return unconfirmed();
    // Historical receipts do not describe the current selection. Observe it separately.
    await this.open(record.entry.key);
    const value = record.entry.value;
    if (durable && sameInput && value && value.editSeq === pending.submittedSeq && value.text === text && record.entry.basisCurrent)
      await this.clearRecord(record, false);
    return { confirmed: true, savedCurrent: durable && !record.needsWrite && record.entry.value?.editSeq === pending.submittedSeq
      && record.entry.value.text === text && record.entry.currentFailure === null && record.entry.basisCurrent };
  }

  async rebase(key: DraftKey): Promise<boolean> {
    const record = this.records.get(identity(key));
    if (!this.kernel.live || !record?.entry.value || record.entry.busy || record.entry.value.pending || record.entry.failure?.kind === "journal-conflict") return false;
    if (record.entry.value.merge) return this.refreshMerge(key);
    const before = record.entry.value;
    if (!await this.open(key) || !this.kernel.live || record.entry.value !== before || record.entry.current.kind !== "current") return false;
    this.inputRevision++; record.needsWrite = true;
    this.update(record, { value: { ...before, basis: record.entry.current.basis, editSeq: nextEditSeq(before.editSeq) }, failure: null, newerInputAfterConfirmation: false });
    return this.flush(key);
  }

  discard(key: DraftKey): Promise<boolean> {
    const record = this.records.get(identity(key));
    return !this.kernel.live || !record || record.entry.busy || record.entry.value?.pending
      ? Promise.resolve(false) : this.clearRecord(record, true);
  }
  private async clearRecord(record: RecordState, discard: boolean): Promise<boolean> {
    const value = record.entry.value;
    if (!value || value.pending) return false;
    if ((record.writeAttempt || record.clearAttempt) && !await this.flush(record.entry.key)) return false;
    return this.kernel.enqueue(identity(record.entry.key), async () => {
      if (record.entry.value !== value || value.pending || record.entry.failure?.kind === "journal-conflict") return false;
      record.writing = true; this.update(record);
      try {
        record.clearAttempt = { expectedRevision: record.entry.head.revision };
        const head = await this.ports.clear({ sessionToken: this.context.sessionToken,
          clear: { key: record.entry.key, expectedRevision: record.entry.head.revision } });
        if (!this.kernel.live) return false;
        record.clearAttempt = null;
        const unchanged = record.entry.value === value;
        record.needsWrite = !unchanged;
        const current = record.entry.current;
        const reset = discard && unchanged ? current.kind === "current"
          ? { basis: current.basis, text: current.basis.text ?? "", editSeq: nextEditSeq(value.editSeq), pending: null } : null : record.entry.value;
        if (discard && unchanged) this.inputRevision++;
        this.update(record, { head, value: reset, durableSeq: null, failure: null,
          ...(discard && unchanged ? { newerInputAfterConfirmation: false } : {}) });
        if (!unchanged) this.schedule(record);
        return unchanged;
      } catch (cause) {
        if (!hasUnknownOutcome(cause)) record.clearAttempt = null;
        this.update(record, { failure: { kind: "journal", cause } }); return false;
      }
      finally { record.writing = false; this.update(record); }
    }).catch(() => false);
  }

  lifecycleParticipant(onReveal = this.options.onReveal): LifecycleParticipant {
    const unresolved = () => [...this.records.values()].find(record => record.entry.value?.pending || record.entry.journalPending || record.entry.failure?.kind === "journal" || record.entry.failure?.kind === "journal-conflict");
    const navigation = (intent: LeaveIntent) => intent.kind === "navigate" || intent.kind === "language" || intent.kind === "close-view";
    const retainsReservation = (intent: LeaveIntent) => navigation(intent) && this.navigationReservation !== null && this.kernel.owns(this.navigationReservation);
    return { id: "translation-drafts", area: "translation", scope: { kind: "project", ...this.context },
      inspect: intent => {
        if (intent.kind === "restore") return { status: "ready", revision: "initial-presentation" };
        // Retiring execution cannot revoke a permit for unchanged durable input
        // while the checked Core close is followed by application drain.
        const reserved = this.kernel.reserved || this.retiredReservation;
        const retained = retainsReservation(intent);
        return { status: this.state.hydration !== "ready" || reserved && !retained || this.pending() ? "blocked" : unresolved() ? "dirty" : "ready",
          revision: JSON.stringify([this.state.hydration, this.inputRevision, reserved, retained,
            [...this.records.values()].map(({ entry }) => [identity(entry.key), entry.value?.editSeq, entry.value?.pending, entry.journalPending, entry.failure?.kind])]) };
      },
      prepareLeave: async (intent, proof, current) => {
        if (!proof() || !current() || this.state.hydration !== "ready" || this.pending() || this.retiredReservation
          || this.kernel.reserved && !retainsReservation(intent)) return false;
        const input = this.inputRevision, token = navigation(intent) ? this.navigationReservation : null;
        const flushed = await this.flush();
        // The coordinator accepts this owner's flush; later input still revokes its permit.
        return flushed && current() && this.kernel.live && input === this.inputRevision && !this.pending() && !unresolved()
          && (!this.kernel.reserved || token !== null && this.navigationReservation === token && this.kernel.owns(token));
      },
      reveal: () => { const record = unresolved(); if (record) onReveal?.(record.entry.key); },
    };
  }

  retire() {
    if (!this.kernel.live) return;
    this.retiredReservation = this.kernel.reserved;
    this.navigationReservation = null;
    this.kernel.retire();
    this.state = { ...this.state, retired: true, revision: this.state.revision + 1, mutationReserved: false };
    this.listeners.forEach(listener => listener());
  }
}
