import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, type AdoptionAction, type AttemptDetail, type Receipt } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionReads, useSessionAlive } from "./SessionReadProvider";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { jsonIdentity } from "./pluginToolChoices";
import type { PluginSourceRequest } from "./pluginCommands";
import { useSourceMaintenanceHook } from "./SourceMaintenanceHook";
import { SourceDraftJournal, restoreSourceDraft, sourcePendingValue, sourceHookStopValue, sourceDraftValue, type SourceDraftInputs, type SourceJournalState } from "./sourceDraftJournal";
import { sourceDraftCommands, type SourceDraftValue, type SourceDraftResolveTarget, type SourceDraftDisposition, type SourceDraftObservation } from "./sourceDraftCommands";
import { sourceCommands, confirmSourceAction, confirmSourceReceipt, sameSourceConfirmation, type ContentPage, type ContentScope, type LineageChoice,
  sameSourceEnvironment, sourceRequest, type PluginCaptureRequest, type PluginStartRequest, type SourceCheckPrepareRequest, type SourceCheckFinishRequest, type SourceCheckReview,
  type Preflight, type SourceAdoptRequest, type SourceChangePage, type SourceImpactSummary, type SourceSelection, type PluginStartRequest as StartRequest } from "./sourceCommands";

export type SourcePluginPending =
  | { pendingKind: "capture"; request: PluginCaptureRequest }
  | { pendingKind: "prepare-check"; request: SourceCheckPrepareRequest }
  | { pendingKind: "start-check"; request: PluginStartRequest }
  | { pendingKind: "finish-check"; request: SourceCheckFinishRequest };

export interface SourceDraftState {
  selectionLabel: string | null;
  captureRequest: SourceDraftValue["captureRequest"];
  checkPrepareRequest: SourceDraftValue["checkPrepareRequest"];
  comparisonRef: SourceDraftValue["comparisonRef"];
  receiptRef: SourceDraftValue["receiptRef"];
  pickerUncertain: boolean;
  preparationExpired: boolean;
  submission: { submittedSeq: string; submittedMappingSeq: number } | null;
  pendingUncertain: boolean;
  recoveredPending: boolean;
  pendingObserved: SourceDraftObservation | null;
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
export interface SourceSession {
  journal: SourceJournalState;
  flush: () => Promise<boolean>;
  retryJournal: () => Promise<boolean>;
  keepLocal: (expected: SourceDraftValue) => Promise<boolean>;
  draftValue: () => SourceDraftValue;
  blocked: () => boolean;
  hasDraft: () => boolean;
  subscribe: SourceDraftJournal["subscribe"];
  getDecisionActivity: SourceDraftJournal["getDecisionActivity"];
  checkPending: () => Promise<void>;
  cancelPendingStart: () => Promise<void>;
  readPreparation: (kind: "capture" | "prepare-check") => Promise<void>;
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
  selectDropped: (dropTicket: string) => Promise<void>;
  preflight: (proof?: () => boolean, dispose?: () => void) => Promise<void>;
  start: (proof?: () => boolean, dispose?: () => void) => Promise<void>;
  retryStart: () => Promise<void>;
  checkStart: () => Promise<void>;
  checkPluginStart: () => Promise<void>;
  prepareCheck: (proposal: { attemptId: string; resultId: string }, proof?: () => boolean, dispose?: () => void) => Promise<void>;
  startCheck: (proof?: () => boolean, dispose?: () => void) => Promise<void>;
  finishCheck: (resultId: string) => Promise<void>;
  canRetryPlugin: () => boolean;
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
/** Shares the retained Source owner with sibling presentations. */
export function SourceDraftHandleProvider({ value, children }: { value: SourceSession; children: ReactNode }) {
  return <SourceContext.Provider value={value}>{children}</SourceContext.Provider>;
}
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
function invalidAcknowledgement(): never { throw new Error("Invalid source action acknowledgement"); }

/** Fixed preparation and original actions live as long as the project session. */
export function SourceDraftSession({ project, children }: { project: ProjectView; children: ReactNode }) {
  const reads = useSessionReads(), tasks = useExecutionTaskSession();
  const [session] = useState(() => executionContext(project));
  const [state, setState] = useState<SourceDraftState>(() => ({ domain: "", source: null, selection: null,
    selectionLabel: null, captureRequest: null, checkPrepareRequest: null, comparisonRef: null, receiptRef: null,
    pickerUncertain: false, preparationExpired: false, submission: null, pendingUncertain: false, recoveredPending: false, pendingObserved: null,
    sourceLanguage: project.metadata.sourceLocale, declared: false, preflight: null, attempt: null, preview: null,
    comparison: null, updating: false, lineage: {}, actor: "", filter: "", appliedFilter: "", manualOrdinal: null,
    historicalQuery: "", previewAfter: 0, comparisonAfter: 0, historicalSearch: null, estimate: null, confirmed: false, stale: false, editSeq: 0, pendingStart: null, checkingStart: false, startRetryAllowed: false,
    pendingApply: null, pendingApplyUnitId: null, pendingPlugin: null, producerConsent: null, checkReview: null, checkerConsent: null, checkAttempt: null,
    preparedAction: null, receiptChecked: false, checkingReceipt: false, busyMutation: false, failure: null, receipt: null, completionVersion: 0 }));
  const stateRef = useRef(state), projectRef = useRef(project), mounted = useSessionAlive(), flight = useRef(0);
  const readCleanup = useRef<(() => void) | null>(null);
  const captureFlight = useRef(0), pendingReceipt = useRef<{ request: SourceAdoptRequest; receipt: Receipt } | null>(null);
  const nativeSelectionAttempted = useRef(false);
  const basisVersion = useRef(0), identity = useRef<ReadyIdentity | null>(null), submittedVersion = useRef(0);
  const metadata = metadataKey(project), committedMetadata = useRef(metadata);
  const journalRef = useRef<SourceDraftJournal | null>(null);
  const [journalState, setJournalState] = useState<SourceJournalState>({ hydration: "idle", dirty: false, busy: false, failure: null, conflict: null, retired: false, restored: false });
  function current() { return stateRef.current; }
  function sessionLive() { return mounted.current && !reads.retired && projectRef.current.sessionToken === session.sessionToken && projectRef.current.metadata.projectId === session.projectId; }
  function live() { return sessionLive() && journalRef.current?.getSnapshot().hydration === "ready"; }
  function update(change: (before: SourceDraftState) => SourceDraftState) {
    if (!live()) return;
    const next = change(current()); stateRef.current = next; setState(next); journalRef.current?.observe();
  }
  const hook = useSourceMaintenanceHook(project, { live, changed: () => {
    basisVersion.current++;
    update(before => ({ ...before, editSeq: before.editSeq + 1, confirmed: false, estimate: null }));
  }, canSelect: () => !flight.current && !current().pendingStart && !current().pendingApply && !current().pendingPlugin,
    observed: () => journalRef.current?.observe(), sequence: () => {
      if (!journalRef.current) throw new Error("Source draft journal has not loaded");
      return journalRef.current.sequence();
    },
    checkpointStop: () => journalRef.current?.flush() ?? Promise.resolve(false),
    resolveStop: async (change, disposition) => {
      const pending = sourceHookStopValue(hook.current());
      return !!pending && await journal.resolve({ kind: "hook-stop", pending }, disposition, before => ({ ...before, hook: change(before.hook) }));
    } });
  function inputs(): SourceDraftInputs { return { source: current(), hook: hook.current() }; }
  function install(value: SourceDraftInputs) {
    stateRef.current = value.source; setState(value.source);
    if (value.hook !== hook.current()) hook.restore(value.hook);
  }
  const [journal] = useState(() => new SourceDraftJournal(session, { live: sessionLive, current: inputs,
    hydrate: value => install(restoreSourceDraft(inputs(), value, session)), apply: change => install(change(inputs())),
    publish: setJournalState, persisted: () => { void reads.client.invalidateQueries({ queryKey: reads.key(["workbench-decisions"]), refetchType: "active" }); } }));
  journalRef.current = journal;
  useLayoutEffect(() => {
    mounted.current = true; void journal.initialize();
    return () => { mounted.current = false; queueMicrotask(() => { if (!mounted.current) journal.retire(); }); };
  }, [journal]);
  function frozenSubmission() { return { submittedSeq: journal.sequence(), submittedMappingSeq: current().editSeq }; }
  function blocked() { const value = journal.getSnapshot(); return !live() || !!value.failure || !!value.conflict || value.busy || reserved(); }
  function hasDraft() { const value = current(); return !!value.selection || !!value.selectionLabel || !!value.captureRequest || !!value.checkPrepareRequest
    || !value.source && value.domain !== "" || Object.keys(value.lineage).length > 0 || value.actor !== "" || value.filter !== "" || value.historicalQuery !== "" || hook.hasDraft(); }
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
    if (!live() || journal.getSnapshot().failure || journal.getSnapshot().conflict || flight.current || (!pending && reserved())) return 0;
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
    if (reserved() || Object.keys(current().lineage).length || current().actor !== "") return;
    basisVersion.current++;
    update(before => ({ ...before, domain, selection: null, preflight: null, declared: false, confirmed: false, failure: null }));
  }
  function setSource(source: PluginSourceRequest | null) {
    if (reserved() || Object.keys(current().lineage).length || current().actor !== "" || JSON.stringify(source) === JSON.stringify(current().source)) return;
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
  async function select(dropTicket?: string) {
    if (Object.keys(current().lineage).length || current().actor !== "" || current().attempt) return;
    await run(async () => {
      const source = current().source;
      if (!source) return;
      let selection: SourceSelection | null;
      nativeSelectionAttempted.current = true;
      try { selection = dropTicket ? await sourceCommands.selectDropped({ ...session, source, dropTicket }) : await sourceCommands.selectPlugin({ ...session, source }); }
      catch (error) { if (hasUnknownOutcome(error)) update(before => ({ ...before, pickerUncertain: true })); throw error; }
      if (!live() || !selection) return;
      if (!sameSourceEnvironment(selection.source, source)) invalidAcknowledgement();
      basisVersion.current++; identity.current = null;
      update(before => ({ ...before, selection, selectionLabel: selection?.folderName ?? before.selectionLabel, preparationExpired: false,
        pickerUncertain: false, captureRequest: null, checkPrepareRequest: null, comparisonRef: null, sourceLanguage: projectRef.current.metadata.sourceLocale, declared: false,
        preflight: null, producerConsent: null, checkReview: null, checkerConsent: null, checkAttempt: null, confirmed: false,
        ...(selection ? { preview: null, comparison: null, lineage: {}, attempt: null, receipt: null } : {}) }));
    });
  }
  async function preflight(proof: () => boolean = live, dispose?: () => void) {
    return withReadCleanup(dispose, async () => {
    const start = current(); if (!start.selection || !start.declared || !proof()) return;
    const version = basisVersion.current, meta = metadataKey(projectRef.current), submission = frozenSubmission();
    await run(async () => {
      const attemptId = await executionCommands.identity(session);
      if (!live() || !proof() || version !== basisVersion.current || meta !== metadataKey(projectRef.current) || current().selection !== start.selection) return;
      await dispatchPlugin({ pendingKind: "capture", request: { ...session, selectionId: start.selection!.selectionId,
        sourceLanguage: start.sourceLanguage, attemptId } }, false, submission);
    }, false, () => live() && proof() && version === basisVersion.current && meta === metadataKey(projectRef.current) && current().selection === start.selection, true);
    });
  }
  function freshCurrent(start: SourceDraftState, version: number, meta: string) {
    return live() && version === basisVersion.current && meta === metadataKey(projectRef.current)
      && current().editSeq === start.editSeq && current().selection === start.selection && current().declared === start.declared
      && current().preview === start.preview && current().comparison === start.comparison && current().confirmed === start.confirmed;
  }
  async function resolvePrimary(disposition: SourceDraftDisposition, change: (before: SourceDraftState) => SourceDraftState) {
    const pending = sourcePendingValue(current()); if (!pending) return false;
    return journal.resolve({ kind: "primary", pending }, disposition, before => ({ ...before, source: change(before.source) }));
  }
  function clearPrimary(before: SourceDraftState): SourceDraftState {
    return { ...before, pendingStart: null, pendingPlugin: null, pendingApply: null, pendingApplyUnitId: null, submission: null,
      pendingUncertain: false, pendingObserved: null, recoveredPending: false, preparedAction: null, receiptChecked: false, startRetryAllowed: false };
  }
  function clearClosedStart(before: SourceDraftState, checker: boolean): SourceDraftState {
    const attempt = checker ? before.pendingPlugin?.request.attemptId : before.pendingStart?.attemptId;
    return { ...clearPrimary(before), producerConsent: null, checkerConsent: null, confirmed: false,
      ...(checker && before.checkReview?.attemptId === attempt ? { checkReview: null, checkPrepareRequest: null } : {}),
      ...(!checker && before.preflight?.attemptId === attempt ? { preflight: null, captureRequest: null } : {}) };
  }
  async function acceptStart(request: StartRequest) {
    if (!live() || current().pendingStart !== request) return;
    identity.current = null;
    await resolvePrimary("recorded", before => ({ ...clearPrimary(before), attempt: request.attemptId, checkingStart: false,
      ...(before.preflight?.attemptId === request.attemptId ? { selection: null, preflight: null } : {}),
      ...(before.editSeq === before.submission?.submittedMappingSeq ? { preview: null, comparison: null, lineage: {}, filter: "", appliedFilter: "", manualOrdinal: null, estimate: null } : {}),
      confirmed: false, producerConsent: null, stale: before.stale || before.recoveredPending || submittedVersion.current !== basisVersion.current, receipt: null, failure: null,
      completionVersion: before.completionVersion + 1 }));
  }
  async function readStart(request: PluginStartRequest, checker: boolean) {
    if (checker ? current().pendingPlugin?.request !== request : current().pendingStart !== request) return;
    await observePending(true);
  }
  async function dispatchStart(request: StartRequest, recovering = false, submission = current().submission) {
    if (!live()) return;
    if (!submission) throw new Error("Source start has no original input sequence");
    Object.freeze(request);
    update(before => ({ ...before, pendingStart: request, submission, startRetryAllowed: false, pendingUncertain: false }));
    if (!await journal.flush() || !live() || current().pendingStart !== request) return;
    try {
      const attempt = await sourceCommands.startPlugin(request);
      if (!live() || current().pendingStart !== request) return;
      if (attempt !== request.attemptId) invalidAcknowledgement();
      await acceptStart(request);
    } catch (error) {
      if (!live() || current().pendingStart !== request) return;
      if (hasUnknownOutcome(error)) {
        update(before => ({ ...before, pendingUncertain: true })); await observePending(false);
        if (!live() || current().pendingStart !== request) return;
      } else if (!recovering) await resolvePrimary("confirmed-not-applied", before => clearClosedStart(before, false));
      // A definite retry rejection classifies this invocation only. It cannot
      // revoke the first unknown dispatch or restore checked-absence evidence.
      throw error;
    }
  }
  async function start(proof: () => boolean = live, dispose?: () => void) {
    return withReadCleanup(dispose, async () => {
    const before = current(), version = basisVersion.current, meta = metadataKey(projectRef.current), submission = frozenSubmission();
    if (!proof() || !before.declared || !before.preflight || before.producerConsent !== before.preflight.inputDigest
      || before.sourceLanguage !== projectRef.current.metadata.sourceLocale) return;
    await run(async () => {
      const scope = await sourceCommands.scope(session);
      if (!proof() || !freshCurrent(before, version, meta)) return;
      const grantId = await executionCommands.identity(session);
      if (!proof() || !freshCurrent(before, version, meta)) return;
      const latest = await sourceCommands.scope(session);
      if (!proof() || !freshCurrent(before, version, meta) || !sameScope(scope, latest)) { revoke(); return; }
      submittedVersion.current = version;
      await dispatchStart({ ...session, attemptId: before.preflight!.attemptId, inputDigest: before.preflight!.inputDigest,
        startMetadata: before.preflight!.startMetadata, grantId, expiresAtMs: String(Date.now() + 600_000), unsandboxedExecution: true }, false, submission);
    });
    });
  }
  async function dispatchPlugin(intent: SourcePluginPending, recovering = false, submission = current().submission) {
    if (!live()) return;
    if (!submission) throw new Error("Source preparation has no original input sequence");
    const reservation = flight.current;
    update(before => ({ ...before, pendingPlugin: intent, submission, startRetryAllowed: false, pendingUncertain: false, pendingObserved: null }));
    if (!await journal.flush() || !live() || flight.current !== reservation || current().pendingPlugin !== intent) return;
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
          const { sessionToken: _token, ...captureRequest } = intent.request;
          await resolvePrimary("recorded", before => ({ ...clearPrimary(before), preflight: result, captureRequest, preparationExpired: false, producerConsent: null }));
          break;
        }
        case "prepare-check": {
          const result = await sourceCommands.prepareCheck(intent.request);
          if (!live() || current().pendingPlugin !== intent) return;
          if (result.attemptId !== intent.request.attemptId || result.sourceAttemptId !== intent.request.sourceAttemptId
            || result.sourceResultId !== intent.request.sourceResultId || !sameSourceEnvironment(result.source, intent.request.source)) invalidAcknowledgement();
          const { sessionToken: _token, ...checkPrepareRequest } = intent.request;
          await resolvePrimary("recorded", before => ({ ...clearPrimary(before), checkReview: result, checkPrepareRequest, preparationExpired: false, checkerConsent: null, checkAttempt: null }));
          break;
        }
        case "start-check": {
          const attempt = await sourceCommands.startCheck(intent.request);
          if (!live() || current().pendingPlugin !== intent) return;
          if (attempt !== intent.request.attemptId) invalidAcknowledgement();
          await resolvePrimary("recorded", before => ({ ...clearPrimary(before), checkAttempt: attempt, checkerConsent: null }));
          break;
        }
        case "finish-check":
          await sourceCommands.finishCheck(intent.request);
          if (!live() || current().pendingPlugin !== intent) return;
          await resolvePrimary("recorded", clearPrimary);
          reads.invalidate(["execution"]);
          break;
      }
    } catch (error) {
      if (!hasUnknownOutcome(error)) {
        if (!recovering && intent.pendingKind === "start-check") await resolvePrimary("confirmed-not-applied", before => clearClosedStart(before, true));
        else if (!recovering && (intent.pendingKind === "capture" || intent.pendingKind === "prepare-check")) {
          const pending = sourcePendingValue(current());
          if (pending) {
            const { observation } = await sourceDraftCommands.observe({ sessionToken: session.sessionToken, key: { projectId: session.projectId }, target: { kind: "primary", pending } });
            if (observation.kind === "preparation-expired") await resolvePrimary("preparation-expired", before => ({ ...clearPrimary(before),
              preflight: null, checkReview: null, producerConsent: null, checkerConsent: null, confirmed: false, preparationExpired: true }));
            else if (observation.kind === "capture" || observation.kind === "check-prepared") await settleObservation(observation);
            else update(before => ({ ...before, pendingUncertain: true, pendingObserved: observation }));
          }
        }
        else update(before => ({ ...before, pendingUncertain: true }));
      } else {
        update(before => ({ ...before, pendingUncertain: true })); await observePending(false);
        if (!live() || current().pendingPlugin !== intent) return;
      }
      throw error;
    }
  }
  async function prepareCheck(proposal: { attemptId: string; resultId: string }, proof: () => boolean = live, dispose?: () => void) {
    return withReadCleanup(dispose, async () => {
    const before = current(), version = basisVersion.current, submission = frozenSubmission();
    const source = before.preflight ? sourceRequest(before.preflight.source) : before.source;
    if (!source || before.attempt !== proposal.attemptId || !proof()) return;
    await run(async () => {
      const attemptId = await executionCommands.identity(session);
      if (!live() || !proof() || version !== basisVersion.current || current().attempt !== proposal.attemptId) return;
      await dispatchPlugin({ pendingKind: "prepare-check", request: { ...session, source, attemptId,
        sourceAttemptId: proposal.attemptId, sourceResultId: proposal.resultId } }, false, submission);
    });
    });
  }
  async function startCheck(proof: () => boolean = live, dispose?: () => void) {
    return withReadCleanup(dispose, async () => {
    const review = current().checkReview, version = basisVersion.current, submission = frozenSubmission();
    if (!review || current().checkerConsent !== review.inputDigest || current().checkAttempt || !proof()) return;
    await run(async () => {
      const grantId = await executionCommands.identity(session);
      if (!live() || !proof() || version !== basisVersion.current || current().checkReview !== review
        || current().checkerConsent !== review.inputDigest) return;
      await dispatchPlugin({ pendingKind: "start-check", request: { ...session, attemptId: review.attemptId,
        inputDigest: review.inputDigest, startMetadata: review.startMetadata, grantId, expiresAtMs: String(Date.now() + 600_000), unsandboxedExecution: true } }, false, submission);
    });
    });
  }
  async function finishCheck(resultId: string) {
    const attemptId = current().checkAttempt;
    if (!attemptId) return;
    const submission = frozenSubmission();
    await run(() => dispatchPlugin({ pendingKind: "finish-check", request: { ...session, attemptId, resultId } }, false, submission));
  }
  async function retryPlugin() {
    const original = current().pendingPlugin;
    if (original && canRetryPlugin()) await run(() => dispatchPlugin(original, true), true);
  }
  function originalStartPermission(request: StartRequest, checker: boolean) {
    const value = current();
    if (value.recoveredPending || !live() || !request.unsandboxedExecution || BigInt(request.expiresAtMs) <= BigInt(Date.now())) return false;
    return checker ? value.checkReview?.attemptId === request.attemptId && value.checkReview.inputDigest === request.inputDigest
        && jsonIdentity(value.checkReview.startMetadata) === jsonIdentity(request.startMetadata)
      : value.preflight?.attemptId === request.attemptId && value.preflight.inputDigest === request.inputDigest
        && jsonIdentity(value.preflight.startMetadata) === jsonIdentity(request.startMetadata);
  }
  function canRetryPlugin() {
    const value = current(), pending = value.pendingPlugin;
    if (!pending || value.pendingObserved?.kind !== "pending" || !live()
      || value.recoveredPending && pending.pendingKind !== "finish-check") return false;
    switch (pending.pendingKind) {
      case "capture": return value.selection?.selectionId === pending.request.selectionId;
      case "prepare-check": return !!value.source && jsonIdentity(value.source) === jsonIdentity(pending.request.source) && value.attempt === pending.request.sourceAttemptId;
      case "start-check": return value.startRetryAllowed && originalStartPermission(pending.request, true);
      case "finish-check": return value.checkAttempt === pending.request.attemptId;
    }
  }
  function verifyReceipt(request: SourceAdoptRequest, receipt: Receipt, unitId: string) {
    const snapshotId = confirmSourceReceipt(request, unitId, receipt);
    const known = pendingReceipt.current;
    if (known?.request === request && (known.receipt.requestDigest !== receipt.requestDigest || known.receipt.changes[0].id !== snapshotId)) invalidAcknowledgement();
    pendingReceipt.current = { request, receipt };
    return snapshotId;
  }
  async function settlement(request: SourceAdoptRequest, receipt: Receipt, unitId: string) {
    const snapshotId = verifyReceipt(request, receipt, unitId), submitted = current().submission?.submittedMappingSeq;
    const accepted = await resolvePrimary("recorded", before => {
      if (before.pendingApply !== request) return before;
      const newer = before.editSeq !== submitted;
      return { ...clearPrimary(before), receipt, receiptRef: { actionId: request.actionId, unitId, snapshotId, attemptId: request.attemptId, resultId: request.resultId },
        checkingReceipt: false, confirmed: false, estimate: null, failure: null, stale: newer,
        ...(newer ? {} : { preview: null, comparison: null, lineage: {}, actor: "", attempt: null, selection: null, selectionLabel: null,
          preflight: null, captureRequest: null, checkPrepareRequest: null, updating: false }),
        completionVersion: before.completionVersion + 1 };
    });
    if (!accepted) return;
    pendingReceipt.current = null;
    if (current().editSeq === submitted) hook.discardDraft();
    if (request.confirmation.maintenanceHook) void hook.read();
  }
  async function settleObservation(observation: SourceDraftObservation) {
    const pending = sourcePendingValue(current()); if (!pending) return;
    switch (observation.kind) {
      case "pending": return;
      case "preparation-expired":
        await resolvePrimary("preparation-expired", before => ({ ...clearPrimary(before), selection: null, preflight: null,
          checkReview: null, producerConsent: null, checkerConsent: null, confirmed: false, preparationExpired: true })); return;
      case "confirmed-not-applied":
        await resolvePrimary("confirmed-not-applied", before => pending.kind === "start" || pending.kind === "start-check"
          ? clearClosedStart(before, pending.kind === "start-check") : { ...clearPrimary(before), confirmed: false }); return;
      case "capture": {
        if (pending.kind !== "capture") invalidAcknowledgement();
        const captureRequest = pending.request;
        await resolvePrimary("recorded", before => ({ ...clearPrimary(before), captureRequest, preflight: observation.view,
          preparationExpired: false, producerConsent: null, failure: null })); return;
      }
      case "check-prepared": {
        if (pending.kind !== "prepare-check") invalidAcknowledgement();
        const checkPrepareRequest = pending.request;
        await resolvePrimary("recorded", before => ({ ...clearPrimary(before), checkPrepareRequest, checkReview: observation.view,
          preparationExpired: false, checkerConsent: null, failure: null })); return;
      }
      case "started":
        if (pending.kind === "start" && current().pendingStart) await acceptStart(current().pendingStart!);
        else if (pending.kind === "start-check") await resolvePrimary("recorded", before => ({ ...clearPrimary(before), checkAttempt: pending.request.attemptId, checkerConsent: null, failure: null }));
        else invalidAcknowledgement();
        reads.invalidate(["execution"], false); return;
      case "check-finished":
        if (pending.kind !== "finish-check") invalidAcknowledgement();
        await resolvePrimary("recorded", clearPrimary); reads.invalidate(["execution"], false); return;
      case "adoption-prepared":
        if (pending.kind !== "adopt") invalidAcknowledgement();
        verifyAction({ ...pending.request, sessionToken: session.sessionToken }, pending.unitId, observation.value.action);
        update(before => ({ ...before, preparedAction: observation.value.action, receiptChecked: true })); return;
      case "adopted": {
        const original = current().pendingApply;
        if (pending.kind !== "adopt" || !original || !observation.value.receipt) invalidAcknowledgement();
        await settlement(original, observation.value.receipt!, pending.unitId); return;
      }
      case "hook-stopped": invalidAcknowledgement();
    }
  }
  async function observePending(explicit: boolean) {
    const pending = sourcePendingValue(current()); if (!pending || !live()) return;
    const reservation = flight.current, originalContinuation = reservation !== 0 && !current().recoveredPending;
    const target: SourceDraftResolveTarget = { kind: "primary", pending };
    update(before => ({ ...before, startRetryAllowed: false, receiptChecked: false,
      checkingStart: pending.kind === "start" || pending.kind === "start-check", checkingReceipt: pending.kind === "adopt" }));
    try {
      const result = await sourceDraftCommands.observe({ sessionToken: session.sessionToken, key: { projectId: session.projectId }, target });
      if (!live() || jsonIdentity(sourcePendingValue(current())) !== jsonIdentity(pending) || jsonIdentity(result.target) !== jsonIdentity(target)) return;
      const observation = result.observation;
      if (pending.kind === "adopt") {
        const request = current().pendingApply;
        if (!request) invalidAcknowledgement();
        if (observation.kind === "adopted") {
          if (!observation.value.receipt) invalidAcknowledgement();
          // A matching receipt remains evidence even if its accompanying action
          // is invalid. Later observations may not change or erase it.
          verifyReceipt(request, observation.value.receipt, pending.unitId);
          verifyAction(request, pending.unitId, observation.value.action);
        } else {
          if (pendingReceipt.current?.request === request) invalidAcknowledgement();
          if (observation.kind === "adoption-prepared") verifyAction(request, pending.unitId, observation.value.action);
        }
      }
      update(before => ({ ...before, pendingObserved: observation }));
      const sameContinuation = originalContinuation && flight.current === reservation && !current().recoveredPending;
      if (observation.kind === "pending") {
        update(before => ({ ...before, receiptChecked: pending.kind === "adopt" && !before.recoveredPending,
          startRetryAllowed: pending.kind === "start" && !!before.pendingStart ? originalStartPermission(before.pendingStart, false)
            : pending.kind === "start-check" && before.pendingPlugin?.pendingKind === "start-check" ? originalStartPermission(before.pendingPlugin.request, true) : false }));
      } else if (explicit || observation.kind === "adoption-prepared" || sameContinuation
        && observation.kind !== "preparation-expired" && observation.kind !== "confirmed-not-applied") await settleObservation(observation);
    } finally { if (live()) update(before => ({ ...before, checkingStart: false, checkingReceipt: false })); }
  }
  async function checkPending() {
    if (!live() || flight.current) return;
    if (sourcePendingValue(current())) { await run(() => observePending(true), true); return; }
    const pending = sourceHookStopValue(hook.current()); if (!pending) return;
    await run(async () => {
      const target: SourceDraftResolveTarget = { kind: "hook-stop", pending };
      const result = await sourceDraftCommands.observe({ sessionToken: session.sessionToken, key: { projectId: session.projectId }, target });
      if (!live() || jsonIdentity(sourceHookStopValue(hook.current())) !== jsonIdentity(pending)) return;
      if (result.observation.kind !== "hook-stopped" && result.observation.kind !== "confirmed-not-applied") return;
      const recorded = result.observation.kind === "hook-stopped";
      await journal.resolve(target, recorded ? "recorded" : "confirmed-not-applied", before => ({ ...before,
        hook: { ...before.hook, stopping: false, stopFailure: null, closed: recorded || before.hook.closed,
          stop: before.hook.stop ? { ...before.hook.stop, pending: false, unknown: false, notKnown: !recorded } : null } }));
    }, true);
  }
  async function cancelPendingStart() {
    const pending = sourcePendingValue(current());
    if (!pending || (pending.kind !== "start" && pending.kind !== "start-check") || flight.current) return;
    await run(async () => {
      await resolvePrimary("confirmed-not-applied", before => clearClosedStart(before, pending.kind === "start-check"));
    }, true);
  }
  async function readPreparation(kind: "capture" | "prepare-check") {
    const value = current(), capture = value.captureRequest, check = value.checkPrepareRequest;
    const reference = kind === "capture" && capture ? { kind: "capture" as const, request: capture }
      : kind === "prepare-check" && check ? { kind: "prepare-check" as const, request: check } : null;
    if (!reference || reserved()) return;
    const request = reference.request;
    await run(async () => {
      const result = await sourceDraftCommands.preparation({ sessionToken: session.sessionToken, key: { projectId: session.projectId }, reference });
      if (!live() || (kind === "capture" ? current().captureRequest : current().checkPrepareRequest) !== request) return;
      const observation = result.observation;
      if (observation.kind === "capture") update(before => ({ ...before, preflight: observation.view, producerConsent: null, preparationExpired: false }));
      else if (observation.kind === "check-prepared") update(before => ({ ...before, checkReview: observation.view, checkerConsent: null, preparationExpired: false }));
      else if (observation.kind === "preparation-expired") update(before => ({ ...before, preparationExpired: true, preflight: null, checkReview: null }));
    });
  }
  function verifyAction(request: SourceAdoptRequest, unitId: string, action: AdoptionAction) {
    confirmSourceAction(request, unitId, action);
    if (current().preparedAction && current().preparedAction!.cancellationRevision !== action.cancellationRevision) invalidAcknowledgement();
  }
  async function lookupAdoption(request: SourceAdoptRequest, unitId: string) {
    if (current().pendingApply === request && current().pendingApplyUnitId === unitId) await observePending(true);
  }
  async function dispatchApply(request: SourceAdoptRequest, unitId: string, recovering = false, submission = current().submission) {
    if (!live()) return;
    if (!submission) throw new Error("Source adoption has no original input sequence");
    if (pendingReceipt.current?.request !== request) pendingReceipt.current = null;
    update(before => ({ ...before, pendingApply: request, pendingApplyUnitId: unitId, submission, receiptChecked: false, pendingUncertain: false }));
    if (!await journal.flush() || !live() || current().pendingApply !== request) return;
    hook.capture(request);
    let writeFailure: CommandFailure | null = null;
    try {
      const action = await sourceCommands.prepare(request);
      if (!live() || current().pendingApply !== request || current().pendingApplyUnitId !== unitId) return;
      verifyAction(request, unitId, action);
      update(before => before.pendingApply === request ? { ...before, preparedAction: action } : before);
      const receipt = await executionCommands.adopt({ projectId: request.projectId, sessionToken: request.sessionToken, actionId: request.actionId });
      if (live() && current().pendingApply === request && current().pendingApplyUnitId === unitId) await settlement(request, receipt, unitId);
      return;
    } catch (error) {
      if (!live() || current().pendingApply !== request) return;
      if (!hasUnknownOutcome(error)) {
        if (!recovering) await resolvePrimary("confirmed-not-applied", clearPrimary);
        throw error;
      }
      writeFailure = commandFailure(error);
      update(before => ({ ...before, pendingUncertain: true }));
    }
    // A failed lookup is not another lost write acknowledgement.
    try {
      await observePending(false);
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
    const before = current(), version = basisVersion.current, meta = metadataKey(projectRef.current), request = adoptionRequest(before), unitId = identity.current?.unitId, submission = frozenSubmission();
    if (!proof() || !request || !unitId || request.confirmation.sourceLanguage !== projectRef.current.metadata.sourceLocale || before.receipt || before.stale || !before.confirmed || (before.comparison && (!before.estimate || (Object.keys(before.lineage).length > 0
      && (!before.actor.trim() || Object.values(before.lineage).some(choice => !choice.reason.trim())))))) return;
    await run(async () => {
      const actionId = await executionCommands.identity(session);
      if (!proof() || !freshCurrent(before, version, meta)) return;
      const scope = await sourceCommands.scope(session);
      const basis = before.comparison ?? before.preview!;
      if (!proof() || !freshCurrent(before, version, meta) || !sameScope(scope, basis.scope)) { revoke(); return; }
      submittedVersion.current = version;
      await dispatchApply({ ...request, actionId }, unitId, false, submission);
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
  function keepOutput() { if (!flight.current && current().receiptChecked && current().pendingObserved?.kind === "confirmed-not-applied") void resolvePrimary("confirmed-not-applied", clearPrimary); }
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
    const capturing = !!flight.current && captureFlight.current === flight.current && current().pendingPlugin?.pendingKind === "capture"
      && !current().recoveredPending && !current().pendingStart && !current().pendingApply && !hook.blocked();
    return live() && !journal.getSnapshot().failure && !journal.getSnapshot().conflict && (!hasPending() || capturing)
      && (!flight.current || captureFlight.current === flight.current);
  }
  async function discard() {
    if (!canDiscard()) return false;
    const pending = sourcePendingValue(current()), clickedSeq = current().editSeq;
    basisVersion.current++;
    const ticket = ++nextTicket.current; flight.current = ticket; captureFlight.current = 0;
    update(before => ({ ...before, busyMutation: true, failure: null }));
    try {
      if (nativeSelectionAttempted.current || current().selection || current().preflight) await sourceCommands.cancelCapture(session);
      if (!live()) return false;
      if (pending) {
        const target: SourceDraftResolveTarget = { kind: "primary", pending };
        const result = await sourceDraftCommands.observe({ sessionToken: session.sessionToken, key: { projectId: session.projectId }, target });
        if (!live() || jsonIdentity(sourcePendingValue(current())) !== jsonIdentity(pending)) return false;
        const observation = result.observation;
        update(before => ({ ...before, pendingObserved: observation }));
        if (observation.kind !== "capture" && observation.kind !== "preparation-expired") return false;
        if (!await journal.resolve(target, observation.kind === "capture" ? "recorded" : "preparation-expired", before => ({ ...before, source: clearPrimary(before.source) }))) return false;
      }
      // Settlement above preserves all current input. Discard only the version
      // the person actually chose, never text entered while cancellation waited.
      if (current().editSeq !== clickedSeq) return false;
      identity.current = null;
      nativeSelectionAttempted.current = false;
      hook.discardDraft();
      update(before => ({ ...before, selection: null, selectionLabel: null, captureRequest: null, checkPrepareRequest: null, comparisonRef: null, preparationExpired: false,
        preflight: null, attempt: null, domain: "", producerConsent: null, checkReview: null, checkerConsent: null, checkAttempt: null, declared: false, lineage: {}, actor: "", filter: "", appliedFilter: "", manualOrdinal: null, historicalQuery: "", comparison: null, preview: null,
        previewAfter: 0, comparisonAfter: 0, historicalSearch: null, estimate: null, confirmed: false, stale: false, editSeq: before.editSeq + 1 }));
      return await journal.flush();
    } catch (error) { if (live()) fail(error); return false; }
    finally { release(ticket); }
  }
  function showAttempt(attempt: string) {
    const before = current();
    const humanInput = Object.keys(before.lineage).length > 0 || before.actor !== "" || before.filter !== "" || before.historicalQuery !== "" || hook.hasDraft();
    if (reserved() || before.attempt !== attempt && (humanInput || !before.attempt && hasDraft())) return false;
    if (current().attempt === attempt) return true;
    basisVersion.current++; identity.current = null;
    update(before => ({ ...before, attempt, preview: null, comparison: null, lineage: {}, estimate: null, filter: "", appliedFilter: "",
      comparisonRef: null, manualOrdinal: null, previewAfter: 0, comparisonAfter: 0, historicalSearch: null, confirmed: false, stale: false, failure: null, receipt: null, editSeq: before.editSeq + 1 })); return true;
  }
  function beginUpdate() {
    if (reserved()) return;
    basisVersion.current++; identity.current = null;
    update(before => ({ ...before, preview: null, comparison: null, comparisonRef: null, lineage: {}, updating: true, confirmed: false,
      selection: null, selectionLabel: null, preflight: null, captureRequest: null, checkPrepareRequest: null, failure: null, receipt: null }));
  }
  function ready(page: ContentPage | SourceChangePage, detail: AttemptDetail) {
    if (reserved() || current().attempt !== page.attemptId || detail.attemptId !== page.attemptId || detail.operation !== "source-import") return;
    if (page.scope.revision !== page.confirmation.expectedContentRevision || page.scope.currentSnapshot !== (page.confirmation.expectedCurrentSnapshot ?? null)) {
      fail(new Error("Invalid source preview basis")); return;
    }
    const retained = current().comparisonRef;
    if (retained && retained.attemptId === page.attemptId && retained.resultId === page.resultId && Object.keys(current().lineage).length
      && retained.previousSnapshotId !== ("previousSnapshotId" in page ? page.previousSnapshotId : null)) { fail("stale-preview"); return; }
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
      comparisonRef: { attemptId: page.attemptId, resultId: page.resultId, previousSnapshotId: "previousSnapshotId" in page ? page.previousSnapshotId : null,
        expectedContentRevision: page.scope.revision, expectedCurrentSnapshot: page.scope.currentSnapshot },
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
      comparisonRef: { attemptId: next.attemptId, resultId: next.resultId, previousSnapshotId: "previousSnapshotId" in next ? next.previousSnapshotId : null,
        expectedContentRevision: next.scope.revision, expectedCurrentSnapshot: next.scope.currentSnapshot },
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
  return <SourceContext.Provider value={{ state, hook, journal: journalState, flush: () => journal.flush(), retryJournal: () => journal.retry(),
    keepLocal: expected => { const conflict = journal.getSnapshot().conflict; return conflict ? journal.keepLocal(expected, conflict) : Promise.resolve(false); },
    draftValue: () => sourceDraftValue(inputs(), journal.sequence()), blocked, hasDraft, subscribe: journal.subscribe, getDecisionActivity: journal.getDecisionActivity, checkPending, readPreparation,
    current, inFlight: () => !!flight.current, hasPending, qualified: () => identity.current?.qualified === true, setSource, consentProducer, consentChecker, setDomain, declare, edit, confirm,
    select: () => select(), selectDropped: ticket => select(ticket), preflight, start, retryStart: async () => { const request = current().pendingStart; if (request && current().startRetryAllowed && originalStartPermission(request, false)) await run(() => dispatchStart(request, true), true); },
    checkStart: async () => { const request = current().pendingStart; if (request) await run(() => readStart(request, false), true); },
    checkPluginStart: async () => { const pending = current().pendingPlugin; if (pending?.pendingKind === "start-check") await run(() => readStart(pending.request, true), true); },
    prepareCheck, startCheck, finishCheck, canRetryPlugin, retryPlugin,
    apply, checkReceipt, retryApply, keepOutput, estimate, discard, canDiscard, showAttempt, beginUpdate, ready, page, pageIntent, historyIntent, showCurrent, cancelTask, cancelPendingStart }}>{children}</SourceContext.Provider>;
}
