import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, type AdoptionAction, type AttemptDetail, type Receipt } from "./executionCommands";
import { hasUnknownOutcome, isCommandError, type ProjectView } from "./projectCommands";
import { useSessionReads } from "./SessionReadProvider";
import { sourceCommands, type SourceSelection } from "./sourceCommands";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { translationCommands, confirmTranslationAction, confirmTranslationReceipt, type TranslationAdoptRequest, type TranslationDecision,
  type TranslationPreflight, type TranslationPreview, type TranslationPreviewRow, type TranslationStartRequest } from "./translationCommands";

export interface TranslationImportPending {
  request: TranslationAdoptRequest;
  recoveryUnitId: string;
  previousSelectionSequence: string | null;
  key: string;
  prepared: AdoptionAction | null;
  receiptChecked: boolean;
  receipt: Receipt | null;
}
export interface TranslationBatchOutcome { applied: number; conflicted: number; failed: number; unknown: number }
type BatchStatus = keyof TranslationBatchOutcome;
export interface TranslationBatchDetail { key: string; actionId: string; status: BatchStatus }
interface BatchCapture { preview: TranslationPreview; rows: TranslationPreviewRow[]; eligible: TranslationPreviewRow[]; excluded: number; decision: TranslationDecision; editSeq: number }
interface RowCapture { preview: TranslationPreview; row: TranslationPreviewRow; decision: TranslationDecision; editSeq: number }
export interface TranslationImportState {
  folder: SourceSelection | null;
  fileName: string;
  targetLocale: string;
  preflight: TranslationPreflight | null;
  confirmed: boolean;
  pendingStart: TranslationStartRequest | null;
  attempt: string | null;
  preview: TranslationPreview | null;
  selectIfEmpty: boolean;
  rowAction: RowCapture | null;
  batchCapture: BatchCapture | null;
  batchProgress: { done: number; total: number } | null;
  batchOutcome: TranslationBatchOutcome | null;
  batchDetails: TranslationBatchDetail[];
  uncertain: TranslationImportPending[];
  receiptMessage: "found" | "missing" | null;
  busy: boolean;
  stale: boolean;
  editSeq: number;
  completionVersion: number;
  failure: CommandFailure | null;
}
interface ImportSession {
  state: TranslationImportState;
  current: () => TranslationImportState;
  setTarget: (locale: string) => boolean;
  setFile: (file: string) => void;
  confirmLanguage: (value: boolean) => void;
  setStrategy: (value: boolean) => void;
  chooseFolder: () => Promise<void>;
  preflight: () => Promise<void>;
  start: (proof?: () => boolean) => Promise<void>;
  retryStart: () => Promise<void>;
  showAttempt: (id: string) => boolean;
  ready: (page: TranslationPreview) => void;
  page: (after: number, refresh?: boolean) => Promise<void>;
  chooseRow: (row: TranslationPreviewRow, decision: TranslationDecision) => void;
  cancelConfirmation: () => void;
  applyRow: (proof?: () => boolean) => Promise<void>;
  captureBatch: () => Promise<void>;
  applyBatch: (proof?: () => boolean) => Promise<void>;
  checkReceipt: (actionId: string) => Promise<void>;
  retryAction: (actionId: string) => Promise<void>;
}
const ImportContext = createContext<ImportSession | null>(null);
export function useTranslationImportSession() {
  const owner = useContext(ImportContext);
  if (!owner) throw new Error("Translation import requires a project session owner");
  return owner;
}
function invalid(message = "Invalid translation import basis") {
  return Object.assign(new Error(message), { outcome: "unknown", reason: "invalid-import-receipt" });
}
function sameBasis(left: TranslationPreview, right: TranslationPreview) {
  const fields = (page: TranslationPreview) => ({ attemptId: page.attemptId, bundleId: page.bundleId,
    fixedSourceSnapshotId: page.fixedSourceSnapshotId, currentSourceSnapshotId: page.currentSourceSnapshotId,
    resultDigest: page.resultDigest, fileDigest: page.fileDigest, logicalPath: page.logicalPath, declaredLocale: page.declaredLocale,
    targetLocale: page.targetLocale, basis: page.basis, total: page.total, unique: page.unique, unmatched: page.unmatched,
    ambiguous: page.ambiguous, selectedConflicts: page.selectedConflicts, sourceChanged: page.sourceChanged, applied: page.applied });
  return JSON.stringify(fields(left)) === JSON.stringify(fields(right));
}
function metadata(project: ProjectView, locale: string) { return `${project.metadata.sourceLocale}\u0000${project.metadata.targetLocales.includes(locale)}`; }
function sameRow(left: TranslationPreviewRow, right: TranslationPreviewRow) { return JSON.stringify(left) === JSON.stringify(right); }
function eligible(row: TranslationPreviewRow) { return row.status === "unique" && !!row.unitId && !!row.occurrenceId && !!row.sourceRevisionId && row.currentSelection === null; }

/** Fixed user decisions and original mutation continuations outlive their view. */
export function TranslationImportSession({ project, children }: { project: ProjectView; children: ReactNode }) {
  const drafts = useTranslationDraftSession(), reads = useSessionReads();
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [session] = useState(() => executionContext(project));
  const [state, setState] = useState<TranslationImportState>(() => ({ folder: null, fileName: "",
    targetLocale: project.metadata.targetLocales[0] ?? "", preflight: null, confirmed: false, pendingStart: null,
    attempt: null, preview: null, selectIfEmpty: false, rowAction: null, batchCapture: null, batchProgress: null,
    batchOutcome: null, batchDetails: [], uncertain: [], receiptMessage: null, busy: false, stale: false,
    editSeq: 0, completionVersion: 0, failure: null }));
  const stateRef = useRef(state), projectRef = useRef(project), mounted = useRef(false), flight = useRef(false);
  const version = useRef(0), mutation = useRef<symbol | null>(null), currentMeta = useRef(metadata(project, state.targetLocale));
  function current() { return stateRef.current; }
  function live() { return mounted.current && projectRef.current.sessionToken === session.sessionToken && projectRef.current.metadata.projectId === session.projectId; }
  function update(change: (before: TranslationImportState) => TranslationImportState) {
    if (!live()) return;
    const next = change(current()); stateRef.current = next; setState(next);
  }
  function revoke() { version.current++; update(before => ({ ...before, stale: !!before.preview, confirmed: false })); }
  useLayoutEffect(() => { mounted.current = true; return () => {
    mounted.current = false; version.current++;
    if (mutation.current) draftsRef.current.releaseMutation(mutation.current);
    mutation.current = null;
  }; }, []);
  useLayoutEffect(() => {
    projectRef.current = project;
    const next = metadata(project, current().targetLocale);
    if (next !== currentMeta.current) { currentMeta.current = next; revoke(); update(before => ({ ...before, preflight: null })); }
  }, [project]);
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.includes("source")) revoke();
    if (scopes.includes("project") && !scopes.includes("source")) {
      const basis = current().preview;
      if (basis) void sourceCommands.scope(session).then(scope => {
        if (live() && current().preview === basis && scope.currentSnapshot !== basis.currentSourceSnapshotId) revoke();
      }).catch(() => { /* Pure read failure cannot change the original action. */ });
    }
  }), [reads]);
  function pending() { return !!current().pendingStart || current().uncertain.length > 0; }
  function editable() { return live() && !flight.current && !pending(); }
  async function run(work: () => Promise<void>, recovery = false) {
    if (!live() || flight.current || (!recovery && pending())) return;
    flight.current = true; update(before => ({ ...before, busy: true, failure: null }));
    try { await work(); } catch (error) { if (live()) update(before => ({ ...before, failure: commandFailure(error) })); }
    finally { flight.current = false; update(before => ({ ...before, busy: false })); }
  }
  function available(locale = current().targetLocale) { return !!locale && projectRef.current.metadata.targetLocales.includes(locale); }
  function fresh(before: TranslationImportState, ticket: number, meta: string, proof: () => boolean) {
    return live() && proof() && version.current === ticket && current().editSeq === before.editSeq
      && current().targetLocale === before.targetLocale && metadata(projectRef.current, before.targetLocale) === meta
      && available(before.targetLocale) && !current().stale;
  }
  function resetPreparation(before: TranslationImportState) {
    return { ...before, preflight: null, confirmed: false, attempt: null, preview: null, rowAction: null,
      batchCapture: null, batchOutcome: null, batchDetails: [], receiptMessage: null, stale: false, editSeq: before.editSeq + 1 };
  }
  function setTarget(locale: string) {
    if (!editable() || (locale && !available(locale))) return false;
    if (locale === current().targetLocale) return true;
    version.current++; currentMeta.current = metadata(projectRef.current, locale);
    update(before => ({ ...resetPreparation(before), targetLocale: locale })); return true;
  }
  function setFile(fileName: string) { if (editable() && fileName !== "") { version.current++; update(before => ({ ...resetPreparation(before), fileName })); } }
  function confirmLanguage(confirmed: boolean) {
    if (editable() && current().preflight && available()) update(before => ({ ...before, confirmed, editSeq: before.editSeq + 1 }));
  }
  function setStrategy(selectIfEmpty: boolean) {
    if (editable()) update(before => ({ ...before, selectIfEmpty, batchCapture: null, editSeq: before.editSeq + 1 }));
  }
  async function chooseFolder() {
    if (!available()) return;
    await run(async () => {
      const folder = await translationCommands.selectFolder(session);
      if (!live()) return;
      version.current++;
      update(before => ({ ...resetPreparation(before), folder, fileName: "" }));
    });
  }
  async function preflight() {
    const before = current(), ticket = version.current, meta = metadata(projectRef.current, before.targetLocale);
    if (!before.folder || !before.fileName || !available()) return;
    await run(async () => {
      const checked = await translationCommands.preflight({ ...session, selectionId: before.folder!.selectionId, fileName: before.fileName, targetLocale: before.targetLocale });
      if (!live() || ticket !== version.current || meta !== metadata(projectRef.current, before.targetLocale) || current().folder !== before.folder) return;
      if (checked.fileName !== before.fileName || checked.targetLocale !== before.targetLocale) throw invalid();
      update(value => ({ ...value, preflight: checked, confirmed: false }));
    });
  }
  async function dispatchStart(request: TranslationStartRequest) {
    if (!live()) return;
    update(before => ({ ...before, pendingStart: request }));
    try {
      const attempt = await translationCommands.start(request);
      if (!live()) return;
      if (attempt !== request.attemptId) throw invalid();
      update(before => before.pendingStart === request ? { ...before, attempt, pendingStart: null, preview: null,
        batchCapture: null, rowAction: null, batchOutcome: null, batchDetails: [], stale: false, failure: null } : before);
    } catch (error) {
      if (!hasUnknownOutcome(error)) update(before => before.pendingStart === request ? { ...before, pendingStart: null } : before);
      throw error;
    }
  }
  async function start(proof: () => boolean = live) {
    const before = current(), ticket = version.current, meta = metadata(projectRef.current, before.targetLocale);
    if (!before.folder || !before.preflight || !before.confirmed || before.attempt || !available() || !proof()) return;
    await run(async () => {
      const scope = await sourceCommands.scope(session);
      if (!fresh(before, ticket, meta, proof) || scope.currentSnapshot !== before.preflight!.sourceSnapshotId) return;
      const attemptId = await executionCommands.identity(session);
      if (!fresh(before, ticket, meta, proof)) return;
      const latest = await sourceCommands.scope(session);
      if (!fresh(before, ticket, meta, proof) || latest.currentSnapshot !== scope.currentSnapshot || latest.revision !== scope.revision) { revoke(); return; }
      await dispatchStart({ ...session, attemptId, selectionId: before.folder!.selectionId, fileName: before.preflight!.fileName,
        targetLocale: before.preflight!.targetLocale, expectedFileDigest: before.preflight!.fileDigest,
        expectedSourceSnapshotId: before.preflight!.sourceSnapshotId, languageConfirmed: true });
    });
  }
  async function retryStart() { const request = current().pendingStart; if (request) await run(() => dispatchStart(request), true); }
  function showAttempt(attempt: string) {
    if (!editable()) return false;
    version.current++; update(before => ({ ...resetPreparation(before), attempt })); return true;
  }
  function ready(page: TranslationPreview) {
    if (!editable() || current().attempt !== page.attemptId || current().preview) return;
    currentMeta.current = metadata(projectRef.current, page.targetLocale);
    update(before => ({ ...before, preview: structuredClone(page), targetLocale: page.targetLocale,
      stale: !available(page.targetLocale) || page.fixedSourceSnapshotId !== page.currentSourceSnapshotId || page.sourceChanged > 0 }));
  }
  async function page(after: number, refresh = false) {
    const before = current(), basis = before.preview;
    if (!basis || !Number.isSafeInteger(after) || after < 0) return;
    await run(async () => {
      const next = await translationCommands.preview({ ...session, attemptId: basis.attemptId, after, limit: 50, basis: refresh ? null : basis.basis });
      if (!live() || current().preview !== basis) return;
      if (next.attemptId !== basis.attemptId || (!refresh && !sameBasis(basis, next))) { revoke(); throw invalid(); }
      version.current++;
      update(value => ({ ...value, preview: structuredClone(next), rowAction: refresh ? null : value.rowAction,
        batchCapture: refresh ? null : value.batchCapture, editSeq: value.editSeq + (refresh ? 1 : 0),
        stale: refresh ? !available(next.targetLocale) || next.fixedSourceSnapshotId !== next.currentSourceSnapshotId || next.sourceChanged > 0 : value.stale }));
    });
  }
  function chooseRow(row: TranslationPreviewRow, decision: TranslationDecision) {
    const before = current();
    if (!editable() || !before.preview || before.stale || !available() || !before.preview.rows.some(value => sameRow(value, row))
      || !(row.status === "unique" || row.status === "selected-conflict") || !row.unitId || !row.occurrenceId || !row.sourceRevisionId) return;
    if (decision === "replace" ? !row.currentSelection : decision === "select-if-empty" && row.currentSelection) return;
    update(value => ({ ...value, rowAction: { preview: structuredClone(before.preview!), row: structuredClone(row), decision, editSeq: before.editSeq } }));
  }
  function cancelConfirmation() { if (!flight.current) update(before => ({ ...before, rowAction: null, batchCapture: null })); }
  async function whole(basis: TranslationPreview) {
    const rows: TranslationPreviewRow[] = [], ordinals = new Set<number>(), items = new Set<string>(), results = new Set<string>();
    let after = 0;
    while (true) {
      if (!live()) return null;
      const next = await translationCommands.preview({ ...session, attemptId: basis.attemptId, after, limit: 100, basis: basis.basis });
      if (!sameBasis(basis, next)) throw invalid();
      for (const row of next.rows) {
        if (row.entry.ordinal < after || ordinals.has(row.entry.ordinal) || items.has(row.itemId) || results.has(row.resultId)) throw invalid();
        rows.push(row); ordinals.add(row.entry.ordinal); items.add(row.itemId); results.add(row.resultId);
      }
      if (next.nextOrdinal === null) break;
      if (next.nextOrdinal <= after || !next.rows.length) throw invalid();
      after = next.nextOrdinal;
    }
    const counts = { unique: 0, unmatched: 0, ambiguous: 0, "selected-conflict": 0, "source-changed": 0, applied: 0 };
    rows.forEach(row => counts[row.status]++);
    if (rows.length !== basis.total || counts.unique !== basis.unique || counts.unmatched !== basis.unmatched
      || counts.ambiguous !== basis.ambiguous || counts["selected-conflict"] !== basis.selectedConflicts
      || counts["source-changed"] !== basis.sourceChanged || counts.applied !== basis.applied
      || rows.some(row => row.status === "unique" && !eligible(row))) throw invalid();
    return rows;
  }
  async function captureBatch() {
    const before = current(), basis = before.preview, ticket = version.current, meta = metadata(projectRef.current, before.targetLocale);
    if (!basis || before.stale || !available() || !basis.unique) return;
    await run(async () => {
      const rows = await whole(basis);
      if (!rows || !fresh(before, ticket, meta, live)) return;
      const selected = rows.filter(eligible);
      update(value => ({ ...value, batchCapture: { preview: structuredClone(basis), rows: structuredClone(rows), eligible: structuredClone(selected),
        excluded: rows.length - selected.length, decision: before.selectIfEmpty ? "select-if-empty" : "candidate-only", editSeq: before.editSeq } }));
    });
  }
  async function recoveryUnits(basis: TranslationPreview, rows: TranslationPreviewRow[]) {
    const details: AttemptDetail[] = []; let offset = 0;
    while (true) {
      if (!live()) return null;
      const detail = await executionCommands.attempt({ ...session, attemptId: basis.attemptId, offset, limit: 100 });
      if (detail.attemptId !== basis.attemptId || detail.operation !== "translation-import" || detail.recovery.attemptId !== basis.attemptId) throw invalid();
      details.push(detail);
      if (detail.nextOffset === null) break;
      if (detail.nextOffset <= offset) throw invalid();
      offset = detail.nextOffset;
    }
    const units = new Map<string, string>();
    for (const row of rows) {
      const items = details.flatMap(detail => detail.items).filter(item => item.status.itemId === row.itemId && item.resultId === row.resultId);
      const item = items[0];
      const detail = details.find(page => page.items.some(value => value.status.itemId === row.itemId && value.resultId === row.resultId));
      const matching = (detail?.recovery.units ?? []).filter(unit => unit.itemIds.length === 1 && unit.itemIds[0] === row.itemId
        && unit.resultIds.length === 1 && unit.resultIds[0] === row.resultId);
      const unit = matching[0];
      const scopeId = `${basis.bundleId}:${row.entry.ordinal}`;
      if (items.length !== 1 || matching.length !== 1 || !unit || item.scope.kind !== "translation-entry" || item.scope.id !== scopeId
        || item.scope.locale !== basis.targetLocale || unit.scopes.length !== 1 || unit.scopes[0].kind !== item.scope.kind
        || unit.scopes[0].id !== item.scope.id || unit.scopes[0].locale !== item.scope.locale) throw invalid();
      units.set(row.itemId, unit.unitId);
    }
    return units;
  }
  function reserveMutation() {
    if (mutation.current) return false;
    const token = draftsRef.current.reserveMutation();
    if (!token) { update(before => ({ ...before, failure: "input-busy" })); return false; }
    mutation.current = token; return true;
  }
  function releaseMutation() {
    if (!mutation.current || current().uncertain.length || current().batchProgress) return;
    draftsRef.current.releaseMutation(mutation.current); mutation.current = null;
  }
  function original(basis: TranslationPreview, row: TranslationPreviewRow, decision: TranslationDecision, actionId: string, recoveryUnitId: string): TranslationImportPending {
    if (!row.unitId || !row.occurrenceId || !row.sourceRevisionId) throw invalid();
    return { request: { ...session, actionId, attemptId: basis.attemptId, itemId: row.itemId, resultId: row.resultId,
      confirmation: { resultDigest: row.resultDigest, sourceSnapshotId: basis.fixedSourceSnapshotId, occurrenceId: row.occurrenceId,
        sourceRevisionId: row.sourceRevisionId, targetUnitId: row.unitId, expectedSelectionId: row.currentSelection?.eventId ?? null, decision } },
      recoveryUnitId, previousSelectionSequence: row.currentSelection?.sequence ?? null, key: row.entry.nativeKey,
      prepared: null, receiptChecked: false, receipt: null };
  }
  function replacePending(pending: TranslationImportPending) {
    update(before => ({ ...before, uncertain: before.uncertain.some(value => value.request.actionId === pending.request.actionId)
      ? before.uncertain.map(value => value.request.actionId === pending.request.actionId ? pending : value) : [...before.uncertain, pending] }));
  }
  function verifyReceipt(pending: TranslationImportPending, receipt: Receipt) {
    confirmTranslationReceipt(pending.request, pending.recoveryUnitId, receipt, pending.previousSelectionSequence);
    if (pending.receipt && (pending.receipt.requestDigest !== receipt.requestDigest
      || JSON.stringify(pending.receipt.changes) !== JSON.stringify(receipt.changes))) throw invalid();
    return { ...pending, receipt: structuredClone(receipt) };
  }
  function settle(pending: TranslationImportPending, receipt: Receipt) {
    const checked = verifyReceipt(pending, receipt);
    update(before => ({ ...before, uncertain: before.uncertain.filter(value => value.request.actionId !== pending.request.actionId),
      receiptMessage: "found", stale: true, completionVersion: before.completionVersion + 1, failure: null,
      batchDetails: before.batchDetails.map(value => value.actionId === pending.request.actionId ? { ...value, status: "applied" } : value),
      batchOutcome: before.batchOutcome && before.batchDetails.some(value => value.actionId === pending.request.actionId && value.status === "unknown")
        ? { ...before.batchOutcome, unknown: before.batchOutcome.unknown - 1, applied: before.batchOutcome.applied + 1 } : before.batchOutcome }));
    releaseMutation(); return checked;
  }
  async function dispatch(pending: TranslationImportPending): Promise<BatchStatus> {
    if (!live()) return "failed";
    let original = { ...pending, receiptChecked: false };
    replacePending(original);
    try {
      const prepared = await translationCommands.prepare(original.request);
      if (!live()) return "unknown";
      confirmTranslationAction(original.request, original.recoveryUnitId, prepared);
      if (original.prepared && original.prepared.cancellationRevision !== prepared.cancellationRevision) throw invalid();
      original = { ...original, prepared }; replacePending(original);
      const receipt = await executionCommands.adopt({ ...session, actionId: original.request.actionId });
      if (!live()) return "unknown";
      settle(original, receipt); return "applied";
    } catch (error) {
      if (!live()) return "unknown";
      if (hasUnknownOutcome(error)) { replacePending(original); update(before => ({ ...before, failure: commandFailure(error) })); return "unknown"; }
      update(before => ({ ...before, uncertain: before.uncertain.filter(value => value.request.actionId !== original.request.actionId), failure: commandFailure(error) }));
      return isCommandError(error) && error.code === "dependency-conflict" ? "conflicted" : "failed";
    }
  }
  async function validateFreshBasis(before: TranslationImportState, basis: TranslationPreview, ticket: number, meta: string, proof: () => boolean) {
    const scope = await sourceCommands.scope(session);
    if (!fresh(before, ticket, meta, proof)) return false;
    if (scope.currentSnapshot !== basis.currentSourceSnapshotId || basis.currentSourceSnapshotId !== basis.fixedSourceSnapshotId) { revoke(); return false; }
    return true;
  }
  async function checkedRow(capture: RowCapture) {
    if (!live()) return false;
    const page = await translationCommands.preview({ ...session, attemptId: capture.preview.attemptId,
      after: capture.row.entry.ordinal, limit: 1, basis: capture.preview.basis });
    if (!sameBasis(capture.preview, page) || page.rows.length !== 1 || !sameRow(page.rows[0], capture.row)) throw invalid();
    return true;
  }
  async function applyRow(proof: () => boolean = live) {
    const before = current(), capture = before.rowAction, ticket = version.current, meta = metadata(projectRef.current, before.targetLocale);
    if (!capture || capture.editSeq !== before.editSeq || before.stale || !available() || !proof() || !editable() || !reserveMutation()) return;
    await run(async () => {
      try {
        if (!await checkedRow(capture) || !await validateFreshBasis(before, capture.preview, ticket, meta, proof)) return;
        const units = await recoveryUnits(capture.preview, [capture.row]);
        if (!units || !fresh(before, ticket, meta, proof)) return;
        const actionId = await executionCommands.identity(session);
        if (!fresh(before, ticket, meta, proof)) return;
        if (!await checkedRow(capture) || !await validateFreshBasis(before, capture.preview, ticket, meta, proof)) return;
        const request = original(capture.preview, capture.row, capture.decision, actionId, units.get(capture.row.itemId)!);
        update(value => ({ ...value, rowAction: null }));
        await dispatch(request);
      } finally { releaseMutation(); }
    });
  }
  async function applyBatch(proof: () => boolean = live) {
    const before = current(), capture = before.batchCapture, ticket = version.current, meta = metadata(projectRef.current, before.targetLocale);
    if (!capture || capture.editSeq !== before.editSeq || before.stale || !available() || !proof() || !editable() || !reserveMutation()) return;
    await run(async () => {
      try {
        const rows = await whole(capture.preview);
        if (!rows || JSON.stringify(rows) !== JSON.stringify(capture.rows) || !await validateFreshBasis(before, capture.preview, ticket, meta, proof)) return;
        const units = await recoveryUnits(capture.preview, capture.eligible);
        if (!units || !fresh(before, ticket, meta, proof)) return;
        const requests: TranslationImportPending[] = [];
        for (const row of capture.eligible) {
          const actionId = await executionCommands.identity(session);
          if (!fresh(before, ticket, meta, proof)) return;
          requests.push(original(capture.preview, row, capture.decision, actionId, units.get(row.itemId)!));
        }
        const latest = await whole(capture.preview);
        if (!latest || JSON.stringify(latest) !== JSON.stringify(capture.rows) || !await validateFreshBasis(before, capture.preview, ticket, meta, proof)) return;
        update(value => ({ ...value, batchCapture: null, batchProgress: { done: 0, total: requests.length }, batchOutcome: null, batchDetails: [] }));
        const outcome: TranslationBatchOutcome = { applied: 0, conflicted: 0, failed: 0, unknown: 0 }, details: TranslationBatchDetail[] = [];
        for (const request of requests) {
          if (!live()) return;
          const status = await dispatch(request);
          if (!live()) return;
          outcome[status]++; details.push({ key: request.key, actionId: request.request.actionId, status });
          update(value => ({ ...value, batchProgress: { done: details.length, total: requests.length }, batchDetails: [...details], batchOutcome: { ...outcome } }));
        }
      } finally { update(value => ({ ...value, batchProgress: null })); releaseMutation(); }
    });
  }
  async function checkReceipt(actionId: string) {
    const pending = current().uncertain.find(value => value.request.actionId === actionId); if (!pending) return;
    await run(async () => {
      let original = { ...pending, receiptChecked: false }; replacePending(original);
      const receipt = await executionCommands.receipt({ ...session, actionId });
      if (!live()) return;
      if (!receipt) {
        if (original.receipt) throw invalid();
        replacePending({ ...original, receiptChecked: true }); update(before => ({ ...before, receiptMessage: "missing" })); return;
      }
      original = verifyReceipt(original, receipt); replacePending(original);
      if (!original.prepared) {
        const prepared = await translationCommands.prepare(original.request);
        if (!live()) return;
        confirmTranslationAction(original.request, original.recoveryUnitId, prepared);
        original = { ...original, prepared }; replacePending(original);
      }
      settle(original, receipt);
    }, true);
  }
  async function retryAction(actionId: string) {
    const pending = current().uncertain.find(value => value.request.actionId === actionId);
    if (pending?.receiptChecked) await run(async () => { await dispatch(pending); releaseMutation(); }, true);
  }
  return <ImportContext.Provider value={{ state, current, setTarget, setFile, confirmLanguage, setStrategy, chooseFolder,
    preflight, start, retryStart, showAttempt, ready, page, chooseRow, cancelConfirmation, applyRow, captureBatch, applyBatch, checkReceipt, retryAction }}>{children}</ImportContext.Provider>;
}
