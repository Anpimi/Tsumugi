import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, type AdoptionAction, type AttemptDetail, type Receipt } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionReads, useSessionAlive } from "./SessionReadProvider";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import type { PluginSourceRequest } from "./pluginCommands";
import { useSourceMaintenanceHook } from "./SourceMaintenanceHook";
import { sourceCommands, confirmSourceAction, confirmSourceReceipt, sameSourceConfirmation, type ContentPage, type ContentScope, type LineageChoice,
  sameSourceEnvironment, sourceRequest, type PluginCaptureRequest, type PluginStartRequest, type SourceCheckPrepareRequest, type SourceCheckFinishRequest, type SourceCheckReview,
  type Preflight, type SourceAdoptRequest, type SourceChangePage, type SourceImpactSummary, type SourceSelection, type PluginStartRequest as StartRequest } from "./sourceCommands";

export type SourcePluginPending =
  | { pendingKind: "capture"; request: PluginCaptureRequest }
  | { pendingKind: "prepare-check"; request: SourceCheckPrepareRequest }
  | { pendingKind: "start-check"; request: PluginStartRequest }
  | { pendingKind: "finish-check"; request: SourceCheckFinishRequest };

export interface SourceDraftState {
  domain: string;
  source: PluginSourceRequest | null;
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
  checkingStart: boolean;
  startRetryAllowed: boolean;
  pendingPlugin: SourcePluginPending | null;
  producerConsent: string | null;
  checkReview: SourceCheckReview | null;
  checkerConsent: string | null;
  checkAttempt: string | null;
  pendingApply: SourceAdoptRequest | null;
  pendingApplyUnitId: string | null;
  preparedAction: AdoptionAction | null;
  receiptChecked: boolean;
  checkingReceipt: boolean;
  busyMutation: boolean;
  failure: CommandFailure | null;
  receipt: Receipt | null;
  completionVersion: number;
}
type ReadyIdentity = { attemptId: string; resultId: string; unitId: string; qualified: boolean };
type DraftFields = Pick<SourceDraftState, "lineage" | "actor" | "filter" | "appliedFilter" | "manualOrdinal" | "historicalQuery">;
interface SourceSession {
  hook: ReturnType<typeof useSourceMaintenanceHook>;
  state: SourceDraftState;
  current: () => SourceDraftState;
  inFlight: () => boolean;
  hasPending: () => boolean;
  qualified: () => boolean;
  setSource: (source: PluginSourceRequest | null) => void;
  consentProducer: (value: boolean) => void;
  consentChecker: (value: boolean) => void;
  setDomain: (domain: string) => void;
  declare: (declared: boolean) => void;
  edit: <K extends keyof DraftFields>(key: K, value: DraftFields[K] | ((before: DraftFields[K]) => DraftFields[K])) => void;
  confirm: (confirmed: boolean) => void;
  select: () => Promise<void>;
  preflight: (proof?: () => boolean, dispose?: () => void) => Promise<void>;
  start: (proof?: () => boolean, dispose?: () => void) => Promise<void>;
  retryStart: () => Promise<void>;
  checkStart: () => Promise<void>;
  checkPluginStart: () => Promise<void>;
  prepareCheck: (proposal: { attemptId: string; resultId: string }, proof?: () => boolean, dispose?: () => void) => Promise<void>;
  startCheck: (proof?: () => boolean, dispose?: () => void) => Promise<void>;
  finishCheck: (resultId: string) => Promise<void>;
  retryPlugin: () => Promise<void>;
  apply: (proof?: () => boolean, dispose?: () => void) => Promise<void>;
  checkReceipt: () => Promise<void>;
  retryApply: () => Promise<void>;
  keepOutput: () => void;
  estimate: (isCurrent: () => boolean) => Promise<void>;
  discard: () => Promise<boolean>;
  canDiscard: () => boolean;
  showAttempt: (id: string) => boolean;
  beginUpdate: () => void;
  ready: (page: ContentPage | SourceChangePage, detail: AttemptDetail) => void;
  page: (page: ContentPage | SourceChangePage, query?: string, refresh?: boolean) => void;
  pageIntent: (after: number, query?: string) => void;
  historyIntent: (query: string, after: number) => void;
  showCurrent: () => void;
  cancelTask: (taskId: string, proof?: () => boolean, originalAttempt?: string) => Promise<void>;
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
  const [state, setState] = useState<SourceDraftState>(() => ({ domain: "", source: null, selection: null,
    sourceLanguage: project.metadata.sourceLocale, declared: false, preflight: null, attempt: null, preview: null,
    comparison: null, updating: false, lineage: {}, actor: "", filter: "", appliedFilter: "", manualOrdinal: null,
    historicalQuery: "", previewAfter: 0, comparisonAfter: 0, historicalSearch: null, estimate: null, confirmed: false, stale: false, editSeq: 0, pendingStart: null, checkingStart: false, startRetryAllowed: false,
    pendingApply: null, pendingApplyUnitId: null, pendingPlugin: null, producerConsent: null, checkReview: null, checkerConsent: null, checkAttempt: null,
    preparedAction: null, receiptChecked: false, checkingReceipt: false, busyMutation: false, failure: null, receipt: null, completionVersion: 0 }));
  const stateRef = useRef(state), projectRef = useRef(project), mounted = useSessionAlive(), flight = useRef(0);
  const readCleanup = useRef<(() => void) | null>(null);
  const captureFlight = useRef(0), pendingReceipt = useRef<{ request: SourceAdoptRequest; receipt: Receipt } | null>(null);
  const basisVersion = useRef(0), identity = useRef<ReadyIdentity | null>(null), submittedSeq = useRef(0), submittedVersion = useRef(0);
  const metadata = metadataKey(project), committedMetadata = useRef(metadata);
  function current() { return stateRef.current; }
  function live() { return mounted.current && !reads.retired && projectRef.current.sessionToken === session.sessionToken && projectRef.current.metadata.projectId === session.projectId; }
  function update(change: (before: SourceDraftState) => SourceDraftState) {
    if (!live()) return;
    const next = change(current()); stateRef.current = next; setState(next);
  }
  const hook = useSourceMaintenanceHook(project, { live, changed: () => {
    basisVersion.current++;
    update(before => ({ ...before, editSeq: before.editSeq + 1, confirmed: false, estimate: null }));
  }, canSelect: () => !flight.current && !current().pendingStart && !current().pendingApply && !current().pendingPlugin });
  function revoke() {
    basisVersion.current++;
    update(before => ({ ...before, stale: !!(before.preview || before.comparison), estimate: null, confirmed: false, producerConsent: null, checkerConsent: null }));
  }
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; readCleanup.current?.(); readCleanup.current = null; flight.current = 0; captureFlight.current = 0; basisVersion.current++; }; }, []);
  useLayoutEffect(() => {
    projectRef.current = project;
    if (committedMetadata.current !== metadata) {
      committedMetadata.current = metadata; revoke();
      if (current().sourceLanguage !== project.metadata.sourceLocale) update(before => ({ ...before, declared: false }));
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
  function hasPending() { return !!current().pendingStart || !!current().pendingApply || !!current().pendingPlugin || hook.blocked(); }
  function reserved() { return flight.current !== 0 || hasPending(); }
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
  async function withReadCleanup(dispose: (() => void) | undefined, work: () => Promise<void>) {
    if (!live() || flight.current) { dispose?.(); return; }
    let disposed = false;
    const cleanup = () => { if (!disposed) { disposed = true; dispose?.(); } };
    readCleanup.current = cleanup;
    try { await work(); } finally { cleanup(); if (readCleanup.current === cleanup) readCleanup.current = null; }
  }
  function setDomain(domain: string) {
    if (reserved()) return;
    basisVersion.current++;
    update(before => ({ ...before, domain, selection: null, preflight: null, declared: false, confirmed: false, failure: null }));
  }
  function setSource(source: PluginSourceRequest | null) {
    if (reserved() || JSON.stringify(source) === JSON.stringify(current().source)) return;
    basisVersion.current++;
    update(before => ({ ...before, source, selection: null, preflight: null, declared: false, confirmed: false,
      producerConsent: null, checkReview: null, checkerConsent: null, checkAttempt: null, failure: null }));
  }
  function consentProducer(value: boolean) {
    if (!reserved() && current().preflight) update(before => ({ ...before, producerConsent: value ? before.preflight!.inputDigest : null }));
  }
  function consentChecker(value: boolean) {
    if (!reserved() && current().checkReview) update(before => ({ ...before, checkerConsent: value ? before.checkReview!.inputDigest : null }));
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
    if (reserved() || !identity.current?.qualified || current().stale || (current().comparison && !current().estimate)) return;
    update(before => ({ ...before, confirmed }));
  }
  async function select() {
    await run(async () => {
      const source = current().source;
      if (!source) return;
      const selection = await sourceCommands.selectPlugin({ ...session, source });
      if (!live()) return;
      if (selection && !sameSourceEnvironment(selection.source, source)) invalidAcknowledgement();
      basisVersion.current++; identity.current = null;
      update(before => ({ ...before, selection, sourceLanguage: projectRef.current.metadata.sourceLocale, declared: false,
        preflight: null, producerConsent: null, checkReview: null, checkerConsent: null, checkAttempt: null, confirmed: false,
        ...(selection ? { preview: null, comparison: null, lineage: {}, attempt: null, receipt: null } : {}) }));
    });
  }
  async function preflight(proof: () => boolean = live, dispose?: () => void) {
    return withReadCleanup(dispose, async () => {
    const start = current(); if (!start.selection || !start.declared || !proof()) return;
    const version = basisVersion.current, meta = metadataKey(projectRef.current);
    await run(async () => {
      const attemptId = await executionCommands.identity(session);
      if (!live() || !proof() || version !== basisVersion.current || meta !== metadataKey(projectRef.current) || current().selection !== start.selection) return;
      await dispatchPlugin({ pendingKind: "capture", request: { ...session, selectionId: start.selection!.selectionId,
        sourceLanguage: start.sourceLanguage, attemptId } });
    }, false, () => live() && proof() && version === basisVersion.current && meta === metadataKey(projectRef.current) && current().selection === start.selection, true);
    });
  }
  function freshCurrent(start: SourceDraftState, version: number, meta: string) {
    return live() && version === basisVersion.current && meta === metadataKey(projectRef.current)
      && current().editSeq === start.editSeq && current().selection === start.selection && current().declared === start.declared
      && current().preview === start.preview && current().comparison === start.comparison && current().confirmed === start.confirmed;
  }
  function acceptStart(request: StartRequest) {
    if (!live() || current().pendingStart !== request) return;
    identity.current = null;
    update(before => ({ ...before, attempt: request.attemptId, pendingStart: null, checkingStart: false, startRetryAllowed: false,
      ...(before.preflight?.attemptId === request.attemptId ? { selection: null, preflight: null } : {}),
      ...(before.editSeq === submittedSeq.current ? { preview: null, comparison: null, lineage: {}, filter: "", appliedFilter: "", manualOrdinal: null, estimate: null } : {}),
      confirmed: false, stale: before.stale || submittedVersion.current !== basisVersion.current, receipt: null, failure: null,
      completionVersion: before.completionVersion + 1 }));
  }
  async function readStart(request: PluginStartRequest, checker: boolean) {
    const intent = current().pendingPlugin;
    const original = () => live() && (checker ? intent?.pendingKind === "start-check" && current().pendingPlugin === intent : current().pendingStart === request);
    if (!original()) return;
    update(before => ({ ...before, checkingStart: true, startRetryAllowed: false }));
    try {
      const value = await executionCommands.pluginStartAction({ ...session, attemptId: request.attemptId, inputDigest: request.inputDigest,
        operation: checker ? "source-semantic-check" : "source-import" });
      if (!original()) return;
      if (value) {
        if (checker) update(before => ({ ...before, checkAttempt: request.attemptId, pendingPlugin: null, checkingStart: false, startRetryAllowed: false, failure: null }));
        else acceptStart(request);
        reads.invalidate(["execution"], false);
      } else update(before => ({ ...before, startRetryAllowed: true }));
    } finally { if (original()) update(before => ({ ...before, checkingStart: false })); }
  }
  async function dispatchStart(request: StartRequest, recovering = false) {
    if (!live()) return;
    Object.freeze(request);
    update(before => ({ ...before, pendingStart: request, startRetryAllowed: false }));
    try {
      const attempt = await sourceCommands.startPlugin(request);
      if (!live() || current().pendingStart !== request) return;
      if (attempt !== request.attemptId) invalidAcknowledgement();
      acceptStart(request);
    } catch (error) {
      if (!live() || current().pendingStart !== request) return;
      if (hasUnknownOutcome(error)) {
        await readStart(request, false);
        if (!live() || current().pendingStart !== request) return;
      } else if (!recovering) update(before => ({ ...before, pendingStart: null }));
      // A definite retry rejection classifies this invocation only. It cannot
      // revoke the first unknown dispatch or restore checked-absence evidence.
      throw error;
    }
  }
  async function start(proof: () => boolean = live, dispose?: () => void) {
    return withReadCleanup(dispose, async () => {
    const before = current(), version = basisVersion.current, meta = metadataKey(projectRef.current);
    if (!proof() || !before.selection || !before.declared || !before.preflight || before.producerConsent !== before.preflight.inputDigest
      || before.sourceLanguage !== projectRef.current.metadata.sourceLocale) return;
    await run(async () => {
      const scope = await sourceCommands.scope(session);
      if (!proof() || !freshCurrent(before, version, meta)) return;
      const grantId = await executionCommands.identity(session);
      if (!proof() || !freshCurrent(before, version, meta)) return;
      const latest = await sourceCommands.scope(session);
      if (!proof() || !freshCurrent(before, version, meta) || !sameScope(scope, latest)) { revoke(); return; }
      submittedSeq.current = before.editSeq; submittedVersion.current = version;
      await dispatchStart({ ...session, attemptId: before.preflight!.attemptId, inputDigest: before.preflight!.inputDigest,
        grantId, expiresAtMs: String(Date.now() + 600_000), unsandboxedExecution: true });
    });
    });
  }
  async function dispatchPlugin(intent: SourcePluginPending, recovering = false) {
    if (!live()) return;
    update(before => ({ ...before, pendingPlugin: intent, startRetryAllowed: false }));
    try {
      switch (intent.pendingKind) {
        case "capture": {
          const selection = current().selection;
          if (!selection || selection.selectionId !== intent.request.selectionId) invalidAcknowledgement();
          const result = await sourceCommands.capturePlugin(intent.request);
          if (!live() || current().pendingPlugin !== intent) return;
          if (result.attemptId !== intent.request.attemptId || result.sourceLanguage !== intent.request.sourceLanguage
            || !sameSourceEnvironment(result.source, sourceRequest(selection!.source))
            || JSON.stringify(result.source) !== JSON.stringify(selection!.source)) invalidAcknowledgement();
          update(before => ({ ...before, preflight: result, producerConsent: null }));
          break;
        }
        case "prepare-check": {
          const result = await sourceCommands.prepareCheck(intent.request);
          if (!live() || current().pendingPlugin !== intent) return;
          if (result.attemptId !== intent.request.attemptId || result.sourceAttemptId !== intent.request.sourceAttemptId
            || result.sourceResultId !== intent.request.sourceResultId || !sameSourceEnvironment(result.source, intent.request.source)) invalidAcknowledgement();
          update(before => ({ ...before, checkReview: result, checkerConsent: null, checkAttempt: null }));
          break;
        }
        case "start-check": {
          const attempt = await sourceCommands.startCheck(intent.request);
          if (!live() || current().pendingPlugin !== intent) return;
          if (attempt !== intent.request.attemptId) invalidAcknowledgement();
          update(before => ({ ...before, checkAttempt: attempt }));
          break;
        }
        case "finish-check":
          await sourceCommands.finishCheck(intent.request);
          if (!live() || current().pendingPlugin !== intent) return;
          reads.invalidate(["execution"]);
          break;
      }
      if (live()) update(before => before.pendingPlugin === intent ? { ...before, pendingPlugin: null } : before);
    } catch (error) {
      if (!recovering && !hasUnknownOutcome(error)) update(before => before.pendingPlugin === intent ? { ...before, pendingPlugin: null } : before);
      else if (intent.pendingKind === "start-check") {
        await readStart(intent.request, true);
        if (!live() || current().pendingPlugin !== intent) return;
      }
      throw error;
    }
  }
  async function prepareCheck(proposal: { attemptId: string; resultId: string }, proof: () => boolean = live, dispose?: () => void) {
    return withReadCleanup(dispose, async () => {
    const before = current(), version = basisVersion.current;
    const source = before.preflight ? sourceRequest(before.preflight.source) : before.source;
    if (!source || before.attempt !== proposal.attemptId || !proof()) return;
    await run(async () => {
      const attemptId = await executionCommands.identity(session);
      if (!live() || !proof() || version !== basisVersion.current || current().attempt !== proposal.attemptId) return;
      await dispatchPlugin({ pendingKind: "prepare-check", request: { ...session, source, attemptId,
        sourceAttemptId: proposal.attemptId, sourceResultId: proposal.resultId } });
    });
    });
  }
  async function startCheck(proof: () => boolean = live, dispose?: () => void) {
    return withReadCleanup(dispose, async () => {
    const review = current().checkReview, version = basisVersion.current;
    if (!review || current().checkerConsent !== review.inputDigest || current().checkAttempt || !proof()) return;
    await run(async () => {
      const grantId = await executionCommands.identity(session);
      if (!live() || !proof() || version !== basisVersion.current || current().checkReview !== review
        || current().checkerConsent !== review.inputDigest) return;
      await dispatchPlugin({ pendingKind: "start-check", request: { ...session, attemptId: review.attemptId,
        inputDigest: review.inputDigest, grantId, expiresAtMs: String(Date.now() + 600_000), unsandboxedExecution: true } });
    });
    });
  }
  async function finishCheck(resultId: string) {
    const review = current().checkReview;
    if (!review || current().checkAttempt !== review.attemptId) return;
    await run(() => dispatchPlugin({ pendingKind: "finish-check", request: { ...session, attemptId: review.attemptId, resultId } }));
  }
  async function retryPlugin() {
    const original = current().pendingPlugin;
    if (original && (original.pendingKind !== "start-check" || current().startRetryAllowed)) await run(() => dispatchPlugin(original, true), true);
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
      return { ...before, receipt, pendingApply: null, pendingApplyUnitId: null, preparedAction: null, receiptChecked: false, checkingReceipt: false, confirmed: false,
        estimate: null, failure: null, stale: newer, ...(newer ? {} : { preview: null, comparison: null, lineage: {}, actor: "", attempt: null, selection: null, preflight: null, updating: false }),
        completionVersion: before.completionVersion + 1 };
    });
    pendingReceipt.current = null;
    if (current().editSeq === submittedSeq.current) hook.discardDraft();
    if (request.confirmation.maintenanceHook) void hook.read();
  }
  function verifyAction(request: SourceAdoptRequest, unitId: string, action: AdoptionAction) {
    confirmSourceAction(request, unitId, action);
    if (current().preparedAction && current().preparedAction!.cancellationRevision !== action.cancellationRevision) invalidAcknowledgement();
  }
  async function lookupAdoption(request: SourceAdoptRequest, unitId: string) {
    const ticket = flight.current;
    const currentRequest = () => live() && flight.current === ticket && !!ticket
      && current().pendingApply === request && current().pendingApplyUnitId === unitId;
    if (!currentRequest()) return;
    update(before => ({ ...before, checkingReceipt: true, receiptChecked: false, failure: null }));
    try {
      const value = await sourceCommands.adoptionAction({ adoption: request, unitId });
      if (!currentRequest()) return;
      if (value === null) {
        if (pendingReceipt.current?.request === request) invalidAcknowledgement();
        update(before => ({ ...before, receiptChecked: true }));
        return;
      }
      // Keep the first matching receipt fixed even if its action proof is bad.
      if (value.receipt !== null) verifyReceipt(request, value.receipt, unitId);
      verifyAction(request, unitId, value.action);
      if (value.receipt === null && pendingReceipt.current?.request === request) invalidAcknowledgement();
      update(before => ({ ...before, preparedAction: value.action }));
      if (value.receipt !== null) settlement(request, value.receipt, unitId);
      else update(before => ({ ...before, receiptChecked: true }));
    } finally {
      if (currentRequest()) update(before => ({ ...before, checkingReceipt: false }));
    }
  }
  async function dispatchApply(request: SourceAdoptRequest, unitId: string, recovering = false) {
    if (!live()) return;
    if (pendingReceipt.current?.request !== request) pendingReceipt.current = null;
    update(before => ({ ...before, pendingApply: request, pendingApplyUnitId: unitId, receiptChecked: false }));
    hook.capture(request);
    let writeFailure: CommandFailure | null = null;
    try {
      const action = await sourceCommands.prepare(request);
      if (!live() || current().pendingApply !== request || current().pendingApplyUnitId !== unitId) return;
      verifyAction(request, unitId, action);
      update(before => before.pendingApply === request ? { ...before, preparedAction: action } : before);
      const receipt = await executionCommands.adopt({ projectId: request.projectId, sessionToken: request.sessionToken, actionId: request.actionId });
      if (live() && current().pendingApply === request && current().pendingApplyUnitId === unitId) settlement(request, receipt, unitId);
      return;
    } catch (error) {
      if (!live() || current().pendingApply !== request) return;
      if (!hasUnknownOutcome(error)) {
        if (!recovering) update(before => ({ ...before, pendingApply: null, pendingApplyUnitId: null, preparedAction: null, receiptChecked: false }));
        throw error;
      }
      writeFailure = commandFailure(error);
    }
    // A failed lookup is not another lost write acknowledgement.
    try {
      await lookupAdoption(request, unitId);
      if (live() && current().pendingApply === request) update(before => ({ ...before, failure: writeFailure }));
    } catch (error) { if (live() && current().pendingApply === request) fail(error); }
  }
  function adoptionRequest(before: SourceDraftState): Omit<SourceAdoptRequest, "actionId"> | null {
    const basis = before.comparison ?? before.preview;
    if (!basis || !identity.current?.qualified || basis.resultId !== identity.current.resultId || basis.attemptId !== identity.current.attemptId || !hook.canPrepare()) return null;
    return { ...session, attemptId: basis.attemptId, resultId: basis.resultId, confirmation: structuredClone({ ...basis.confirmation,
      maintenanceHook: hook.current().enabled ? hook.current().activation : null,
      ...(before.comparison ? { lineage: Object.values(before.lineage), actor: before.actor.trim() || null } : {}) }) };
  }
  async function apply(proof: () => boolean = live, dispose?: () => void) {
    return withReadCleanup(dispose, async () => {
    const before = current(), version = basisVersion.current, meta = metadataKey(projectRef.current), request = adoptionRequest(before), unitId = identity.current?.unitId;
    if (!proof() || !request || !unitId || request.confirmation.sourceLanguage !== projectRef.current.metadata.sourceLocale || before.receipt || before.stale || !before.confirmed || (before.comparison && (!before.estimate || (Object.keys(before.lineage).length > 0
      && (!before.actor.trim() || Object.values(before.lineage).some(choice => !choice.reason.trim())))))) return;
    await run(async () => {
      const actionId = await executionCommands.identity(session);
      if (!proof() || !freshCurrent(before, version, meta)) return;
      const scope = await sourceCommands.scope(session);
      const basis = before.comparison ?? before.preview!;
      if (!proof() || !freshCurrent(before, version, meta) || !sameScope(scope, basis.scope)) { revoke(); return; }
      submittedSeq.current = before.editSeq; submittedVersion.current = version;
      await dispatchApply({ ...request, actionId }, unitId);
    });
    });
  }
  async function checkReceipt() {
    const request = current().pendingApply, unitId = current().pendingApplyUnitId, previousFailure = current().failure;
    if (!request || !unitId) return;
    await run(async () => {
      await lookupAdoption(request, unitId);
      if (live() && current().pendingApply === request) update(before => ({ ...before, failure: previousFailure }));
    }, true);
  }
  async function retryApply() {
    const request = current().pendingApply, unitId = current().pendingApplyUnitId;
    if (request && unitId && current().receiptChecked) await run(() => dispatchApply(request, unitId, true), true);
  }
  function keepOutput() { if (!flight.current && current().receiptChecked) { pendingReceipt.current = null; update(before => ({ ...before, pendingApply: null, pendingApplyUnitId: null, preparedAction: null, receiptChecked: false, confirmed: false })); } }
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
  function canDiscard() {
    return live() && !hook.blocked() && !current().pendingStart && !current().pendingApply
      && (!current().pendingPlugin || current().pendingPlugin?.pendingKind === "capture" && !!captureFlight.current && captureFlight.current === flight.current)
      && (!flight.current || captureFlight.current === flight.current);
  }
  async function discard() {
    // Only explicit capture cancellation can interrupt a reserved preflight.
    if (!canDiscard()) return false;
    basisVersion.current++;
    const ticket = ++nextTicket.current; flight.current = ticket; captureFlight.current = 0;
    update(before => ({ ...before, busyMutation: true, failure: null }));
    try {
      await sourceCommands.cancelCapture(session);
      if (!live()) return false;
      identity.current = null;
      hook.discardDraft();
      update(before => ({ ...before, selection: null, preflight: null, attempt: null, pendingPlugin: null, producerConsent: null, checkReview: null, checkerConsent: null, checkAttempt: null, declared: false, lineage: {}, actor: "", filter: "", appliedFilter: "", manualOrdinal: null, historicalQuery: "", comparison: null, preview: null,
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
    identity.current = { attemptId: page.attemptId, resultId: page.resultId, unitId: unit.unitId, qualified: item.status.execution === "succeeded" && item.status.validation === "valid" && !item.status.cancellationRequested };
    if ((current().comparison ?? current().preview) === page) { update(before => ({ ...before, confirmed: identity.current?.qualified ? before.confirmed : false })); return; }
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
    update(before => ({ ...before, preview: null, comparison: null, updating: false, confirmed: false, attempt: null, selection: null, preflight: null, failure: null }));
  }
  async function cancelTask(taskId: string, proof: () => boolean = live, originalAttempt = current().attempt ?? "") {
    if (!live() || reserved() || !proof() || ![current().attempt, current().checkAttempt].includes(originalAttempt)) return;
    await tasks.cancel({ taskId, attemptId: originalAttempt, origin: "source" }, () => live() && proof());
  }
  return <SourceContext.Provider value={{ state, hook, current, inFlight: () => !!flight.current, hasPending, qualified: () => identity.current?.qualified === true, setSource, consentProducer, consentChecker, setDomain, declare, edit, confirm,
    select, preflight, start, retryStart: async () => { const request = current().pendingStart; if (request && current().startRetryAllowed) await run(() => dispatchStart(request, true), true); },
    checkStart: async () => { const request = current().pendingStart; if (request) await run(() => readStart(request, false), true); },
    checkPluginStart: async () => { const pending = current().pendingPlugin; if (pending?.pendingKind === "start-check") await run(() => readStart(pending.request, true), true); },
    prepareCheck, startCheck, finishCheck, retryPlugin,
    apply, checkReceipt, retryApply, keepOutput, estimate, discard, canDiscard, showAttempt, beginUpdate, ready, page, pageIntent, historyIntent, showCurrent, cancelTask }}>{children}</SourceContext.Provider>;
}
