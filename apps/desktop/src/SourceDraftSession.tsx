import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, type AdoptionAction, type AttemptDetail, type Receipt } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionReads, useSessionAlive } from "./SessionReadProvider";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { sourceCommands, confirmSourceAction, confirmSourceReceipt, sameSourceConfirmation, type ContentPage, type ContentScope, type LineageChoice,
  type Preflight, type SourceAdoptRequest, type SourceChangePage, type SourceImpactSummary, type SourceSelection, type StartRequest } from "./sourceCommands";

export interface SourceDraftState {
  domain: string;
  selection: SourceSelection | null;
  sourceLanguage: string;
  declared: boolean;
  preflight: Preflight | null;
  attempt: string | null;
  preview: ContentPage | null;
  comparison: SourceChangePage | null;
  updating: boolean;
  lineage: Record<number, LineageChoice>;
  actor: string;
  filter: string;
  appliedFilter: string;
  manualOrdinal: number | null;
  historicalQuery: string;
  previewAfter: number;
  comparisonAfter: number;
  historicalSearch: { snapshotId: string; query: string; after: number; newOrdinal: number } | null;
  estimate: SourceImpactSummary[] | null;
  confirmed: boolean;
  stale: boolean;
  editSeq: number;
  pendingStart: StartRequest | null;
  pendingApply: SourceAdoptRequest | null;
  preparedAction: AdoptionAction | null;
  receiptChecked: boolean;
  busyMutation: boolean;
  failure: CommandFailure | null;
  receipt: Receipt | null;
  completionVersion: number;
}
type ReadyIdentity = { attemptId: string; resultId: string; unitId: string };
type DraftFields = Pick<SourceDraftState, "lineage" | "actor" | "filter" | "appliedFilter" | "manualOrdinal" | "historicalQuery">;
interface SourceSession {
  state: SourceDraftState;
  current: () => SourceDraftState;
  inFlight: () => boolean;
  setDomain: (domain: string) => void;
  declare: (declared: boolean) => void;
  edit: <K extends keyof DraftFields>(key: K, value: DraftFields[K] | ((before: DraftFields[K]) => DraftFields[K])) => void;
  confirm: (confirmed: boolean) => void;
  select: () => Promise<void>;
  preflight: () => Promise<void>;
  start: (proof?: () => boolean) => Promise<void>;
  retryStart: () => Promise<void>;
  apply: (proof?: () => boolean) => Promise<void>;
  checkReceipt: () => Promise<void>;
  retryApply: () => Promise<void>;
  keepOutput: () => void;
  estimate: (isCurrent: () => boolean) => Promise<void>;
  discard: () => Promise<boolean>;
  showAttempt: (id: string) => boolean;
  beginUpdate: () => void;
  ready: (page: ContentPage | SourceChangePage, detail: AttemptDetail) => void;
  page: (page: ContentPage | SourceChangePage, query?: string, refresh?: boolean) => void;
  pageIntent: (after: number, query?: string) => void;
  historyIntent: (query: string, after: number) => void;
  showCurrent: () => void;
  cancelTask: (taskId: string, proof?: () => boolean) => Promise<void>;
}
const SourceContext = createContext<SourceSession | null>(null);
export function useSourceDraftSession() {
  const owner = useContext(SourceContext);
  if (!owner) throw new Error("Source preparation requires a project session owner");
  return owner;
}
function sameScope(left: ContentScope, right: ContentScope) { return left.revision === right.revision && left.currentSnapshot === right.currentSnapshot; }
function sameBasis(left: ContentPage | SourceChangePage, right: ContentPage | SourceChangePage) {
  return left.attemptId === right.attemptId && left.resultId === right.resultId && sameScope(left.scope, right.scope)
    && sameSourceConfirmation(left.confirmation, right.confirmation);
}
function metadataKey(project: ProjectView) { return project.metadata.sourceLocale; }
function invalidAcknowledgement() { throw new Error("Invalid source action acknowledgement"); }

/** Fixed preparation and original actions live as long as the project session. */
export function SourceDraftSession({ project, children }: { project: ProjectView; children: ReactNode }) {
  const reads = useSessionReads(), tasks = useExecutionTaskSession();
  const [session] = useState(() => executionContext(project));
  const [state, setState] = useState<SourceDraftState>(() => ({ domain: "stardew-smapi", selection: null,
    sourceLanguage: project.metadata.sourceLocale, declared: false, preflight: null, attempt: null, preview: null,
    comparison: null, updating: false, lineage: {}, actor: "", filter: "", appliedFilter: "", manualOrdinal: null,
    historicalQuery: "", previewAfter: 0, comparisonAfter: 0, historicalSearch: null, estimate: null, confirmed: false, stale: false, editSeq: 0, pendingStart: null,
    pendingApply: null, preparedAction: null, receiptChecked: false, busyMutation: false, failure: null, receipt: null, completionVersion: 0 }));
  const stateRef = useRef(state), projectRef = useRef(project), mounted = useSessionAlive(), flight = useRef(0);
  const captureFlight = useRef(0), pendingReceipt = useRef<{ request: SourceAdoptRequest; receipt: Receipt } | null>(null);
  const basisVersion = useRef(0), identity = useRef<ReadyIdentity | null>(null), submittedSeq = useRef(0);
  const metadata = metadataKey(project), committedMetadata = useRef(metadata);
  function current() { return stateRef.current; }
  function live() { return mounted.current && projectRef.current.sessionToken === session.sessionToken && projectRef.current.metadata.projectId === session.projectId; }
  function update(change: (before: SourceDraftState) => SourceDraftState) {
    if (!live()) return;
    const next = change(current()); stateRef.current = next; setState(next);
  }
  function revoke() {
    basisVersion.current++;
    update(before => ({ ...before, stale: !!(before.preview || before.comparison), estimate: null, confirmed: false }));
  }
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; flight.current = 0; captureFlight.current = 0; basisVersion.current++; }; }, []);
  useLayoutEffect(() => {
    projectRef.current = project;
    if (committedMetadata.current !== metadata) {
      committedMetadata.current = metadata; revoke();
      if (current().sourceLanguage !== project.metadata.sourceLocale) update(before => ({ ...before, declared: false, preflight: null }));
    }
  }, [project, metadata]);
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.includes("source")) revoke();
    else if (scopes.some(scope => scope === "translation" || scope === "resources" || scope === "review")) {
      basisVersion.current++; update(before => ({ ...before, estimate: null, confirmed: false }));
    }
    if (scopes.includes("project") && !scopes.includes("source")) {
      const basis = current().comparison ?? current().preview;
      if (basis) void sourceCommands.scope(session).then(scope => {
        if (live() && (current().comparison ?? current().preview) === basis && !sameScope(scope, basis.scope)) revoke();
      }).catch(() => { /* A read failure cannot change an original action or its confirmation. */ });
    }
  }), [reads]);
  function reserved() { return flight.current !== 0 || !!current().pendingStart || !!current().pendingApply; }
  function reserve(pending = false) {
    if (!live() || flight.current || (!pending && reserved())) return 0;
    const ticket = ++nextTicket.current; flight.current = ticket;
    update(before => ({ ...before, busyMutation: true, failure: null })); return ticket;
  }
  const nextTicket = useRef(0);
  function release(ticket: number) {
    if (flight.current !== ticket) return;
    flight.current = 0; update(before => ({ ...before, busyMutation: false }));
  }
  function fail(error: unknown) { update(before => ({ ...before, failure: commandFailure(error) })); }
  async function run(work: () => Promise<void>, pending = false, isCurrent: () => boolean = live, capture = false) {
    const ticket = reserve(pending); if (!ticket) return;
    if (capture) captureFlight.current = ticket;
    try { await work(); } catch (error) { if (flight.current === ticket && isCurrent()) fail(error); }
    finally { if (captureFlight.current === ticket) captureFlight.current = 0; release(ticket); }
  }
  function setDomain(domain: string) {
    if (reserved()) return;
    basisVersion.current++;
    update(before => ({ ...before, domain, selection: null, preflight: null, declared: false, confirmed: false, failure: null }));
  }
  function declare(declared: boolean) {
    if (reserved()) return;
    basisVersion.current++;
    update(before => ({ ...before, declared, sourceLanguage: projectRef.current.metadata.sourceLocale, preflight: null, confirmed: false }));
  }
  function edit<K extends keyof DraftFields>(key: K, value: DraftFields[K] | ((before: DraftFields[K]) => DraftFields[K])) {
    update(before => {
      const next = typeof value === "function" ? value(before[key]) : value;
      const decision = key === "lineage" || key === "actor";
      return { ...before, [key]: next, editSeq: before.editSeq + (decision ? 1 : 0),
        estimate: decision ? null : before.estimate, confirmed: decision ? false : before.confirmed };
    });
  }
  function confirm(confirmed: boolean) {
    if (reserved() || current().stale || (current().comparison && !current().estimate)) return;
    update(before => ({ ...before, confirmed }));
  }
  async function select() {
    const domain = current().domain;
    await run(async () => {
      const selection = await sourceCommands.select(session, domain);
      if (!live()) return;
      basisVersion.current++; identity.current = null;
      update(before => ({ ...before, selection, sourceLanguage: projectRef.current.metadata.sourceLocale, declared: false,
        preflight: null, confirmed: false, ...(selection ? { preview: null, comparison: null, lineage: {}, attempt: null, receipt: null } : {}) }));
    });
  }
  async function preflight() {
    const start = current(); if (!start.selection || !start.declared) return;
    const version = basisVersion.current, meta = metadataKey(projectRef.current);
    await run(async () => {
      const result = await sourceCommands.preflight({ ...session, selectionId: start.selection!.selectionId, sourceLanguage: start.sourceLanguage });
      if (!live() || version !== basisVersion.current || meta !== metadataKey(projectRef.current) || current().selection !== start.selection) return;
      if (result.sourceLanguage !== start.sourceLanguage) invalidAcknowledgement();
      update(before => ({ ...before, preflight: result }));
    }, false, () => live() && version === basisVersion.current && meta === metadataKey(projectRef.current) && current().selection === start.selection, true);
  }
  function freshCurrent(start: SourceDraftState, version: number, meta: string) {
    return live() && version === basisVersion.current && meta === metadataKey(projectRef.current)
      && current().editSeq === start.editSeq && current().selection === start.selection && current().declared === start.declared
      && current().preview === start.preview && current().comparison === start.comparison && current().confirmed === start.confirmed;
  }
  async function dispatchStart(request: StartRequest) {
    if (!live()) return;
    update(before => ({ ...before, pendingStart: request }));
    try {
      const attempt = await sourceCommands.start(request);
      if (!live()) return;
      if (attempt !== request.attemptId) invalidAcknowledgement();
      identity.current = null;
      update(before => before.pendingStart !== request ? before : ({ ...before, attempt, pendingStart: null, selection: null, preflight: null,
        preview: null, comparison: null, ...(before.editSeq === submittedSeq.current ? { lineage: {}, filter: "", appliedFilter: "", manualOrdinal: null } : {}), estimate: null, confirmed: false,
        stale: false, receipt: null, failure: null, completionVersion: before.completionVersion + 1 }));
    } catch (error) {
      if (!hasUnknownOutcome(error)) update(before => before.pendingStart === request ? { ...before, pendingStart: null } : before);
      throw error;
    }
  }
  async function start(proof: () => boolean = live) {
    const before = current(), version = basisVersion.current, meta = metadataKey(projectRef.current);
    if (!proof() || !before.selection || !before.declared || !before.preflight || before.sourceLanguage !== projectRef.current.metadata.sourceLocale) return;
    const request = { ...session, selectionId: before.selection.selectionId, sourceLanguage: before.sourceLanguage };
    await run(async () => {
      const scope = await sourceCommands.scope(session);
      if (!proof() || !freshCurrent(before, version, meta)) return;
      const attemptId = await executionCommands.identity(session);
      if (!proof() || !freshCurrent(before, version, meta)) return;
      const latest = await sourceCommands.scope(session);
      if (!proof() || !freshCurrent(before, version, meta) || !sameScope(scope, latest)) { revoke(); return; }
      submittedSeq.current = before.editSeq;
      await dispatchStart({ ...request, attemptId });
    });
  }
  function verifyReceipt(request: SourceAdoptRequest, receipt: Receipt, unitId: string) {
    const snapshotId = confirmSourceReceipt(request, unitId, receipt);
    const known = pendingReceipt.current;
    if (known?.request === request && (known.receipt.requestDigest !== receipt.requestDigest || known.receipt.changes[0].id !== snapshotId)) invalidAcknowledgement();
    pendingReceipt.current = { request, receipt };
    return snapshotId;
  }
  function settlement(request: SourceAdoptRequest, receipt: Receipt, unitId: string) {
    verifyReceipt(request, receipt, unitId);
    update(before => {
      if (before.pendingApply !== request) return before;
      const newer = before.editSeq !== submittedSeq.current;
      return { ...before, receipt, pendingApply: null, preparedAction: null, receiptChecked: false, confirmed: false,
        estimate: null, failure: null, stale: newer, ...(newer ? {} : { preview: null, comparison: null, lineage: {}, actor: "", attempt: null, selection: null, preflight: null, updating: false }),
        completionVersion: before.completionVersion + 1 };
    });
    pendingReceipt.current = null;
  }
  async function dispatchApply(request: SourceAdoptRequest, unitId: string) {
    if (!live()) return;
    if (pendingReceipt.current?.request !== request) pendingReceipt.current = null;
    update(before => ({ ...before, pendingApply: request, receiptChecked: false }));
    try {
      const action = await sourceCommands.prepare(request);
      if (!live()) return;
      confirmSourceAction(request, unitId, action);
      if (current().preparedAction && current().preparedAction!.cancellationRevision !== action.cancellationRevision) invalidAcknowledgement();
      update(before => before.pendingApply === request ? { ...before, preparedAction: action } : before);
      const receipt = await executionCommands.adopt({ projectId: request.projectId, sessionToken: request.sessionToken, actionId: request.actionId });
      if (live()) settlement(request, receipt, unitId);
    } catch (error) {
      if (!hasUnknownOutcome(error)) update(before => before.pendingApply === request ? { ...before, pendingApply: null, preparedAction: null, receiptChecked: false } : before);
      throw error;
    }
  }
  function adoptionRequest(before: SourceDraftState): Omit<SourceAdoptRequest, "actionId"> | null {
    const basis = before.comparison ?? before.preview;
    if (!basis || !identity.current || basis.resultId !== identity.current.resultId || basis.attemptId !== identity.current.attemptId) return null;
    return { ...session, attemptId: basis.attemptId, resultId: basis.resultId, confirmation: structuredClone({ ...basis.confirmation,
      ...(before.comparison ? { lineage: Object.values(before.lineage), actor: before.actor.trim() || null } : {}) }) };
  }
  async function apply(proof: () => boolean = live) {
    const before = current(), version = basisVersion.current, meta = metadataKey(projectRef.current), request = adoptionRequest(before), unitId = identity.current?.unitId;
    if (!proof() || !request || !unitId || request.confirmation.sourceLanguage !== projectRef.current.metadata.sourceLocale || before.receipt || before.stale || !before.confirmed || (before.comparison && (!before.estimate || (Object.keys(before.lineage).length > 0
      && (!before.actor.trim() || Object.values(before.lineage).some(choice => !choice.reason.trim())))))) return;
    await run(async () => {
      const actionId = await executionCommands.identity(session);
      if (!proof() || !freshCurrent(before, version, meta)) return;
      const scope = await sourceCommands.scope(session);
      const basis = before.comparison ?? before.preview!;
      if (!proof() || !freshCurrent(before, version, meta) || !sameScope(scope, basis.scope)) { revoke(); return; }
      submittedSeq.current = before.editSeq;
      await dispatchApply({ ...request, actionId }, unitId);
    });
  }
  async function checkReceipt() {
    const request = current().pendingApply, unitId = identity.current?.unitId;
    if (!request || !unitId) return;
    await run(async () => {
      update(before => ({ ...before, receiptChecked: false }));
      const receipt = await executionCommands.receipt({ projectId: request.projectId, sessionToken: request.sessionToken, actionId: request.actionId });
      if (!live() || current().pendingApply !== request) return;
      if (receipt) {
        verifyReceipt(request, receipt, unitId);
        // A receipt digest cannot be reconstructed here. Recover the original
        // action when its preparation acknowledgement was never verified.
        if (!current().preparedAction) {
          const action = await sourceCommands.prepare(request);
          if (!live() || current().pendingApply !== request) return;
          confirmSourceAction(request, unitId, action);
          update(before => ({ ...before, preparedAction: action }));
        }
        settlement(request, receipt, unitId);
      }
      else {
        if (pendingReceipt.current?.request === request) invalidAcknowledgement();
        update(before => ({ ...before, receiptChecked: true }));
      }
    }, true);
  }
  async function retryApply() {
    const request = current().pendingApply, unitId = identity.current?.unitId;
    if (request && unitId && current().receiptChecked) await run(() => dispatchApply(request, unitId), true);
  }
  function keepOutput() { if (!flight.current && current().receiptChecked) update(before => ({ ...before, pendingApply: null, preparedAction: null, receiptChecked: false, confirmed: false })); }
  async function estimate(isCurrent: () => boolean) {
    const before = current(), request = adoptionRequest(before), version = basisVersion.current;
    if (!request || !before.comparison || before.stale) return;
    await run(async () => {
      const actionId = await executionCommands.identity(session);
      if (!live() || !isCurrent() || version !== basisVersion.current || current().editSeq !== before.editSeq) return;
      const result = await sourceCommands.estimate({ ...request, actionId });
      if (live() && isCurrent() && version === basisVersion.current && current().editSeq === before.editSeq) update(value => ({ ...value, estimate: result, confirmed: false }));
    }, false, () => live() && isCurrent() && version === basisVersion.current && current().editSeq === before.editSeq);
  }
  async function discard() {
    if (!live() || current().pendingApply || current().pendingStart) return false;
    // Only explicit capture cancellation can interrupt a reserved preflight.
    if (flight.current && captureFlight.current !== flight.current) return false;
    basisVersion.current++;
    const ticket = ++nextTicket.current; flight.current = ticket; captureFlight.current = 0;
    update(before => ({ ...before, busyMutation: true }));
    try {
      await sourceCommands.cancelCapture(session);
      if (!live()) return false;
      identity.current = null;
      update(before => ({ ...before, selection: null, preflight: null, declared: false, lineage: {}, actor: "", filter: "", appliedFilter: "", manualOrdinal: null, historicalQuery: "", comparison: null, preview: null,
        previewAfter: 0, comparisonAfter: 0, historicalSearch: null, estimate: null, confirmed: false, stale: false, editSeq: before.editSeq + 1 }));
      return true;
    } catch (error) { if (live()) fail(error); return false; }
    finally { release(ticket); }
  }
  function showAttempt(attempt: string) {
    if (reserved()) return false;
    basisVersion.current++; identity.current = null;
    update(before => ({ ...before, attempt, preview: null, comparison: null, lineage: {}, estimate: null, filter: "", appliedFilter: "",
      manualOrdinal: null, previewAfter: 0, comparisonAfter: 0, historicalSearch: null, confirmed: false, stale: false, failure: null, receipt: null, editSeq: before.editSeq + 1 })); return true;
  }
  function beginUpdate() {
    if (reserved()) return;
    basisVersion.current++; identity.current = null;
    update(before => ({ ...before, preview: null, comparison: null, lineage: {}, updating: true, confirmed: false, selection: null, preflight: null, failure: null, receipt: null }));
  }
  function ready(page: ContentPage | SourceChangePage, detail: AttemptDetail) {
    if (reserved() || current().attempt !== page.attemptId || detail.attemptId !== page.attemptId || detail.operation !== "source-import") return;
    if (page.scope.revision !== page.confirmation.expectedContentRevision || page.scope.currentSnapshot !== (page.confirmation.expectedCurrentSnapshot ?? null)) {
      fail(new Error("Invalid source preview basis")); return;
    }
    const item = detail.items.find(value => value.resultId === page.resultId);
    const unit = detail.recovery.units.find(value => item && value.itemIds.includes(item.status.itemId) && value.resultIds.includes(page.resultId));
    if (!item || !unit || detail.recovery.attemptId !== page.attemptId || detail.items.length !== 1 || unit.resultIds.length !== 1
      || unit.itemIds.length !== 1 || unit.scopes.length !== 1 || unit.scopes[0].kind !== "source" || unit.scopes[0].locale !== null
      || item.scope.kind !== "source" || item.scope.locale !== null || unit.scopes[0].id !== item.scope.id || detail.recovery.units.length !== 1) {
      fail(new Error("Invalid source attempt association")); return;
    }
    if (identity.current && (identity.current.attemptId !== page.attemptId || identity.current.resultId !== page.resultId || identity.current.unitId !== unit.unitId)) {
      fail(new Error("Invalid source attempt association")); return;
    }
    identity.current = { attemptId: page.attemptId, resultId: page.resultId, unitId: unit.unitId };
    update(before => ({ ...before, ...( "previousSnapshotId" in page ? { comparison: page, preview: null, updating: true } : { preview: page, comparison: null }),
      previewAfter: 0, comparisonAfter: 0, historicalSearch: null, stale: page.confirmation.sourceLanguage !== projectRef.current.metadata.sourceLocale, confirmed: false, estimate: null, failure: null }));
  }
  function page(next: ContentPage | SourceChangePage, query = current().appliedFilter, refresh = false) {
    const before = current(), old = before.comparison ?? before.preview;
    if (reserved() || !old || old.attemptId !== next.attemptId || old.resultId !== next.resultId) return;
    const changed = !sameBasis(old, next);
    if (changed && !refresh) { revoke(); fail("stale-preview"); return; }
    if (changed && Object.keys(before.lineage).length > 0 && "previousSnapshotId" in old && "previousSnapshotId" in next && old.previousSnapshotId !== next.previousSnapshotId) {
      revoke(); fail("stale-preview"); return;
    }
    basisVersion.current++;
    update(value => ({ ...value, ...( "previousSnapshotId" in next ? { comparison: next, appliedFilter: query } : { preview: next }),
      ...(refresh ? { previewAfter: 0, comparisonAfter: 0, historicalSearch: null } : {}), stale: refresh ? next.confirmation.sourceLanguage !== projectRef.current.metadata.sourceLocale : value.stale, estimate: changed || refresh ? null : value.estimate,
      confirmed: changed || refresh ? false : value.confirmed }));
  }
  function pageIntent(after: number, query = current().appliedFilter) {
    if (reserved() || !Number.isSafeInteger(after) || after < 0) return;
    update(before => before.comparison ? { ...before, comparisonAfter: after, appliedFilter: query }
      : before.preview ? { ...before, previewAfter: after } : before);
  }
  function historyIntent(query: string, after: number) {
    const before = current();
    if (reserved() || !before.comparison || before.manualOrdinal === null || !Number.isSafeInteger(after) || after < 0) return;
    update(value => ({ ...value, historicalSearch: { snapshotId: before.comparison!.previousSnapshotId, newOrdinal: before.manualOrdinal!, query, after } }));
  }
  function showCurrent() {
    if (reserved() || Object.keys(current().lineage).length) return;
    update(before => ({ ...before, preview: null, comparison: null, updating: false, confirmed: false, attempt: null, selection: null, preflight: null }));
  }
  async function cancelTask(taskId: string, proof: () => boolean = live) {
    if (!live() || reserved() || !proof()) return;
    await tasks.cancel({ taskId, attemptId: current().attempt ?? "", origin: "source" }, () => live() && proof());
  }
  return <SourceContext.Provider value={{ state, current, inFlight: () => !!flight.current, setDomain, declare, edit, confirm,
    select, preflight, start, retryStart: async () => { const request = current().pendingStart; if (request) await run(() => dispatchStart(request), true); },
    apply, checkReceipt, retryApply, keepOutput, estimate, discard, showAttempt, beginUpdate, ready, page, pageIntent, historyIntent, showCurrent, cancelTask }}>{children}</SourceContext.Provider>;
}
