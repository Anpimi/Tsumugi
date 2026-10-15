import { useSessionQuery, useSessionReads, useSessionAlive } from "./SessionReadProvider";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView, useWorkbenchState, useWorkbenchRef } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { reviewCommands, type ReviewSummaryPage, type ReviewSummary, type ReviewTarget, type ReviewEditorSnapshot, type ReviewNeighbor } from "./reviewCommands";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { CommandError, ProjectView } from "./projectCommands";
import { executionCommands as execution, executionContext } from "./executionCommands";
import { sourceCommands, type ContentPage, type ContentRow, type ContentScope } from "./sourceCommands";
import { translationCommands as commands, translationHistoryAfter, type TranslationHistory, type TranslationPreview, type TranslationPreviewRow, type TranslationRevision, type TranslationDecision } from "./translationCommands";
import { useTranslationImportSession } from "./TranslationImportSession";
import { WorkProtectionControl, editingProtectionScope } from "./WorkProtectionControl";
import { PluginTranslationControls } from "./PluginTranslationControls";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useWorkbenchCommands, type CommandAvailability, type TranslationImportPreviewCommandPayload, type TranslationImportRowTarget,
  type TranslationImportRowCommandPayload, type TranslationImportBatchCommandPayload, type TranslationImportPendingCommandPayload,
  type TranslationRevisionCommandPayload, type TranslationSelectionPendingCommandPayload, type TranslationContentRowCommandPayload } from "./workbenchCommands";
import { contentSelectionIds, fixedContentSelection, type ContentSelection } from "./contentSelection";
import { EditorMemoryReferences } from "./EditorMemoryReferences";
import { EditorSourceContext } from "./EditorSourceContext";
import { validateResponseHistory } from "./generated/translation.validators";
import { validateResponseEditor } from "./generated/review.validators";
import type { ChangeScope } from "./sessionReads";
import type { QueryKey } from "@tanstack/react-query";

export interface EditorTarget { unitId: string; sourceRevisionId: string; key: string; sourceText: string }
type EditorReadIntent = { id: number; unitId: string; locale: string };
type ListReadIntent = { id: number; scopeId: string; locale: string; query: string; after: number };
type ListReadProof = { intent: ListReadIntent; query: object; data: ReviewSummaryPage; epoch: string };
type HistoryReadIntent = EditorReadIntent & { after: string };
type EditorActivation = { target: EditorTarget; locale: string; suggestedText?: string };
type LeaveIntent = { kind: "import-project" } | { kind: "close" } | { kind: "project" } | { kind: "switch"; target: EditorTarget; after?: number };
export interface TranslationHandle {
  showAttempt: (id: string) => void;
  openUnit: (target: EditorTarget, locale: string, suggestedText?: string) => boolean;
  allowLeave: (current?: () => boolean) => Promise<boolean>;
  allowNavigate: () => Promise<boolean>;
  saveCurrent: () => void;
}

function errorStage(error: unknown): string {
  const value = error as Partial<CommandError> | null;
  return value?.reason ?? value?.field ?? value?.code ?? "failed";
}
function errorKey(stage: string) {
  if (stage === "query-limit") return "query";
  if (stage === "source-changed") return "changed";
  if (stage === "review-scope-source-changed") return "sourceScope";
  if (stage === "review-scope-expired") return "scopeExpired";
  if (stage === "navigation-edited") return "navigationEdited";
  if (stage === "invalid-save-receipt" || stage === "invalid-import-receipt") return "unknown";
  if (stage === "save-list-refresh") return "saveRefresh";
  if (stage.includes("source")) return "source";
  if (stage.includes("locale")) return "locale";
  if (stage.includes("selection") || stage === "stale-preview") return "selection";
  if (stage.includes("incomplete")) return "incomplete";
  if (stage.includes("format") || stage.includes("json") || stage.includes("string")) return "format";
  if (stage.includes("language")) return "mapping";
  if (stage === "busy" || stage === "input-busy") return "busy";
  if (stage.includes("unknown") || stage === "outcome-unknown") return "unknown";
  return "failed";
}
const targetFromSource = (row: ContentRow): EditorTarget | null => row.unitId && row.sourceRevisionId
  ? { unitId: row.unitId, sourceRevisionId: row.sourceRevisionId, key: row.occurrence.key, sourceText: row.occurrence.text }
  : null;
const targetFromTranslation = (row: TranslationPreviewRow): EditorTarget | null => row.unitId && row.sourceRevisionId
  ? { unitId: row.unitId, sourceRevisionId: row.sourceRevisionId, key: row.entry.nativeKey, sourceText: row.sourceText ?? "" }
  : null;

export function TranslationWorkbench({ project, disabled, onQueryText, onOpenExtensions, aiSelection, onPrepareSelection, ref }: {
  project: ProjectView; disabled: boolean; onOpenExtensions?: () => void; onQueryText?: (text: string) => boolean | Promise<boolean>;
  aiSelection?: { count: number; locale: string; editSeq: number; available: boolean };
  onPrepareSelection?: (selection: ContentSelection, expectedEditSeq: number) => Promise<boolean>; ref?: Ref<TranslationHandle>
}) {
  const { t } = useTranslation();
  const context = executionContext(project);
  const draftSession = useTranslationDraftSession();
  const importSession = useTranslationImportSession();
  const importState = importSession.state;
  const commandRegistry = useWorkbenchCommands();
  const editorDraft = draftSession.draft;
  const [open, setOpen] = useWorkbenchView("translation");
  const [tab, setTab] = useWorkbenchState<"import" | "edit">("translation", "tab", importState.attempt || importState.folder || importState.pendingStart || importState.pendingPlugin || importState.uncertain.length ? "import" : "edit");
  const reads = useSessionReads();
  const semanticEpoch = useRef<Partial<Record<ChangeScope, number>>>({});
  useLayoutEffect(() => reads.subscribeChanges(scopes => {
    for (const scope of scopes) semanticEpoch.current[scope] = (semanticEpoch.current[scope] ?? 0) + 1;
  }), [reads]);
  function readEpoch(scopes: ChangeScope[]) { return [semanticEpoch.current.project ?? 0, ...scopes.map(scope => semanticEpoch.current[scope] ?? 0)].join(":"); }
  const readSequence = useWorkbenchRef("translation", "readSequence", 0);
  const [listIntent, setListIntent] = useWorkbenchState<ListReadIntent | null>("translation", "listReadIntent", null);
  const [readyListRead, setReadyListRead] = useState<ListReadProof | null>(null);
  const [editorIntent, setEditorIntent] = useWorkbenchState<EditorReadIntent | null>("translation", "editorReadIntent", null);
  const [readyEditorRead, setReadyEditorRead] = useState<number | null>(null);
  // Keep only the source identity that established the retained draft. A later
  // editor read can fail when that unit disappears from the current source.
  const draftSourceBasis = useWorkbenchRef<{ projectId: string; sessionToken: string; unitId: string;
    locale: string; sourceRevisionId: string; sourceSnapshotId: string } | null>("translation", "draftSourceBasis", null);
  const [editorActivation, setEditorActivation] = useState<EditorActivation | null>(null);
  const [historyIntent, setHistoryIntent] = useWorkbenchState<HistoryReadIntent | null>("translation", "historyReadIntent", null);
  const listScope = useWorkbenchRef<{ id: string; locale: string; query: string } | null>("translation", "listScope", null);
  const [navigationEnd, setNavigationEnd] = useWorkbenchState("translation", "navigationEnd", false);
  const [referencesOpen, setReferencesOpen] = useWorkbenchState("translation", "referencesOpen", false);
  const [query, setQuery] = useWorkbenchState("translation", "query", "");
  const [appliedQuery, setAppliedQuery] = useWorkbenchState("translation", "appliedQuery", "");
  const [contentSelection, setContentSelection] = useWorkbenchState<ContentSelection | null>("translation", "contentSelection", null);
  const selectionVersion = useWorkbenchRef("translation", "contentSelectionVersion", 0);
  const selectionTransfer = useRef<ContentSelection | null>(null);
  const [selectionAction, setSelectionAction] = useState<
    { kind: "capture"; value: ContentSelection; version: number; listReadId: number }
    | { kind: "ai"; value: ContentSelection; version: number; aiEditSeq: number; previousCount: number; previousLocale: string } | null>(null);
  const selectedIds = useMemo(() => contentSelection ? new Set(contentSelectionIds(contentSelection)) : new Set<string>(), [contentSelection]);
  const selectionMembers = useMemo(() => new Set(contentSelection?.capture.units.map(unit => unit.unitId)), [contentSelection]);
  const [listAfter, setListAfter] = useWorkbenchState("translation", "listAfter", 0);
  const listBasis = useWorkbenchRef<string | null>("translation", "listBasis", null);
  const listPosition = useWorkbenchRef("translation", "listPosition", { query: "", after: 0 });
  const [targetLocale, setTargetLocale] = useWorkbenchState("translation", "targetLocale", editorDraft?.locale ?? importState.targetLocale);
  const { attempt, preview, selectIfEmpty,
    batchProgress, batchOutcome, batchDetails, uncertain, receiptMessage, rowAction, batchCapture } = importState;
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(() => editorDraft ? { unitId: editorDraft.unitId, sourceRevisionId: editorDraft.sourceRevisionId, key: editorDraft.key, sourceText: editorDraft.sourceText } : null);
  const [localBusy, setBusy] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const readRunning = useRef(false);
  const readFlight = useRef<symbol | null>(null);
  const latestListRead = useRef(0);
  const [hasDraftSelection, setHasDraftSelection] = useState(false);
  const [composing, setComposing] = useState(false);
  const [editingReady, setEditingReady] = useState<{ scope: string; ready: boolean } | null>(null);
  const protectionBlocked = draftSession.protection.blocked();
  const [queryUnavailable, setQueryUnavailable] = useState(false);
  const [failureValue, setFailure] = useState<CommandFailure | null>(null);
  const effectiveFailureValue = editorDraft?.failure ?? importState.failure ?? failureValue;
  const failure = failureReason(effectiveFailureValue);
  const [leaveIntent, setLeaveIntent] = useState<LeaveIntent | null>(null);
  const leaveProof = useRef<(() => boolean) | null>(null);
  const leaveResolver = useRef<((value: boolean) => void) | null>(null);
  const mounted = useSessionAlive();
  const generation = useRef(0);
  const saveNextViewEpoch = useRef(0);
  const sourceLoad = useRef(0);
  const running = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const entryList = useRef<HTMLUListElement>(null);
  const draftField = useRef<HTMLTextAreaElement>(null);
  const draft = editorDraft?.text ?? "";
  const pendingSave = editorDraft?.pending?.request ?? null;
  const pendingSelection = editorDraft?.pendingSelection ?? null;
  const saveReceiptCheck = editorDraft?.receiptCheck ?? null;
  const newerDraftSaved = editorDraft?.newerDraftSaved ?? false;
  const dirty = !!editorDraft && (draft !== (editorDraft.baseText ?? "") || editorDraft.newerDraftSaved);
  const busy = localBusy || importState.busy || !!editorDraft?.saving || !!editorDraft?.selecting;
  const displayedTarget = editorDraft ? { unitId: editorDraft.unitId, sourceRevisionId: editorDraft.sourceRevisionId,
    key: editorDraft.key, sourceText: editorDraft.sourceText } : editorTarget;
  const targetScope = project.metadata.targetLocales.join("\u0000");
  const availableLocales = useRef(project.metadata.targetLocales);
  const selectedLocale = useRef(targetLocale);
    useLayoutEffect(() => {
    availableLocales.current = project.metadata.targetLocales;
    selectedLocale.current = targetLocale;
  }, [targetScope, targetLocale, attempt]);
  const localeAvailable = (locale: string) => locale !== "" && availableLocales.current.includes(locale);
  const currentLocale = (locale: string) => selectedLocale.current === locale && localeAvailable(locale);
  const targetAvailable = targetLocale !== "" && project.metadata.targetLocales.includes(targetLocale);
  const targetUnavailable = targetLocale !== "" && !targetAvailable;
  useLayoutEffect(() => { saveNextViewEpoch.current++; readRunning.current = false; readFlight.current = null; setReadBusy(false); if (!open || !targetAvailable) setReadyListRead(null); }, [open, tab, targetLocale, targetAvailable]);
  useLayoutEffect(() => { if (!open || tab !== "edit" || !targetAvailable) { setReadyEditorRead(null); setEditorIntent(null); setEditorActivation(null); } }, [open, tab, targetAvailable]);
  const canRebaseTarget = !dirty && !busy && !pendingSave && !pendingSelection && !protectionBlocked && !importSession.hasPending() && !importSession.hasActive() && !attempt && !importState.extractionAttempt
    && uncertain.length === 0 && !rowAction && batchProgress === null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; sourceLoad.current++; leaveResolver.current?.(false); };
  }, []);
  useEffect(() => {
    if (targetAvailable || !canRebaseTarget) return;
    const next = project.metadata.targetLocales[0] ?? "";
    if (next !== targetLocale) changeTarget(next);
  }, [targetLocale, targetScope, targetAvailable, canRebaseTarget]);
  const sourceScopeKey = ["translation-source-scope"];
  const sourceRead = useSessionQuery<ContentScope>({ key: sourceScopeKey, scopes: ["source"], enabled: open && targetAvailable,
    refetchOnMount: false, read: () => sourceCommands.scope(context) });
  const source = sourceRead.data;
  const contentKey = ["translation-source-content", source?.revision ?? null, source?.currentSnapshot ?? null, 0, 1];
  async function readContent(scope: ContentScope) {
    if (!scope.currentSnapshot) throw new Error("No current source snapshot");
    const page = await sourceCommands.content({ ...context, snapshotId: scope.currentSnapshot, after: 0, limit: 1 });
    if (page.snapshotId !== scope.currentSnapshot || page.scope.currentSnapshot !== scope.currentSnapshot || page.scope.revision !== scope.revision) throw { reason: "source-changed" };
    return page;
  }
  const contentRead = useSessionQuery<ContentPage>({ key: contentKey, scopes: ["source"], refetchOnMount: false,
    enabled: open && targetAvailable && !!source?.currentSnapshot && !sourceRead.error,
    read: () => { if (!source) throw new Error("No current source scope"); return readContent(source); } });
  const sourcePage = !sourceRead.error && !contentRead.error ? contentRead.data ?? null : null;
  const sourceMissing = sourceRead.isSuccess && !sourceRead.isFetching && source?.currentSnapshot === null;
  const listKey = (intent: ListReadIntent | null): QueryKey => ["translation-list", intent];
  async function readList(intent: ListReadIntent) {
    const page = await reviewCommands.summaryPage({ ...context, locale: intent.locale, query: intent.query,
      afterOrdinal: intent.after, limit: 50, scopeId: intent.scopeId });
    if (page.scopeId !== intent.scopeId || page.rows.some(row => row.locale !== intent.locale || row.sourceSnapshotId !== page.sourceSnapshotId)) throw { reason: "review-scope-source-changed" };
    return page;
  }
  const listRead = useSessionQuery<ReviewSummaryPage>({ key: listKey(listIntent), scopes: ["source", "translation", "resources", "review"],
    refetchOnMount: query => query.state.isInvalidated,
    enabled: open && targetAvailable && !!listIntent && listIntent.locale === targetLocale,
    read: () => { if (!listIntent) throw new Error("No fixed entry scope"); return readList(listIntent); } });
  const list = listIntent?.locale === targetLocale && !listRead.error ? listRead.data ?? null : null;
  const editorKey = (intent: EditorReadIntent | null): QueryKey => ["translation-editor", intent];
  async function readEditor(intent: EditorReadIntent) {
    const snapshot = await reviewCommands.editorSnapshot({ ...context, unitId: intent.unitId, locale: intent.locale });
    if (snapshot.target.unitId !== intent.unitId || snapshot.target.locale !== intent.locale || snapshot.translations.unitId !== intent.unitId
      || snapshot.translations.locale !== intent.locale || snapshot.terms.unitId !== intent.unitId || snapshot.terms.locale !== intent.locale
      || (snapshot.context && (snapshot.context.unitId !== intent.unitId || snapshot.context.locale !== intent.locale))) throw { reason: "selection" };
    return snapshot;
  }
  const editorRead = useSessionQuery<ReviewEditorSnapshot>({ key: editorKey(editorIntent), scopes: ["source", "translation", "resources", "review"], refetchOnMount: false,
    enabled: open && tab === "edit" && targetAvailable && !!editorIntent && editorIntent.locale === targetLocale,
    read: () => { if (!editorIntent) throw new Error("No editor selection"); return readEditor(editorIntent); } });
  const snapshot = editorIntent?.unitId === displayedTarget?.unitId && editorIntent?.locale === targetLocale && !editorRead.error ? editorRead.data ?? null : null;
  const historyKey = (intent: HistoryReadIntent | null): QueryKey => ["translation-history", intent, 100];
  async function readHistory(intent: HistoryReadIntent) {
    const value = await commands.history({ ...context, unitId: intent.unitId, locale: intent.locale, afterOrdinal: intent.after, limit: 100 });
    if (value.unitId !== intent.unitId || value.locale !== intent.locale) throw { reason: "selection" };
    return value;
  }
  const historyRead = useSessionQuery<TranslationHistory>({ key: historyKey(historyIntent), scopes: ["source", "translation"], refetchOnMount: false,
    enabled: open && tab === "edit" && targetAvailable && !!historyIntent && !!editorIntent && historyIntent.id > editorIntent.id
      && historyIntent.unitId === displayedTarget?.unitId && historyIntent.locale === targetLocale,
    read: () => { if (!historyIntent) throw new Error("No translation history selection"); return readHistory(historyIntent); } });
  const historySelected = !!historyIntent && !!editorIntent && historyIntent.id > editorIntent.id
    && historyIntent.unitId === displayedTarget?.unitId && historyIntent.locale === targetLocale;
  const history = historySelected ? !historyRead.error ? historyRead.data ?? null : null : snapshot?.translations ?? null;
  const historyStale = !!editorDraft && (!snapshot || snapshot.target.sourceRevisionId !== editorDraft.sourceRevisionId
    || !history || (history.current?.eventId ?? null) !== editorDraft.baseSelectionId);
  const editorResources = snapshot;
  useEffect(() => {
    const error = sourceRead.error ?? contentRead.error ?? listRead.error ?? editorRead.error ?? historyRead.error;
    if (error) setFailure(commandFailure(error));
  }, [sourceRead.error, contentRead.error, listRead.error, editorRead.error, historyRead.error]);
  async function freshRead<T>(key: QueryKey, scopes: ChangeScope[], read: () => Promise<T>) {
    const epoch = readEpoch(scopes);
    await reads.client.fetchQuery({ queryKey: reads.key(key), meta: { scopes }, staleTime: 0, queryFn: async ({ signal }) => {
      if (!mounted.current || reads.retired) throw new Error("Read cancelled");
      const value = await read();
      if (signal.aborted || !mounted.current || reads.retired) throw new Error("Read cancelled");
      return value;
    } });
    if (readEpoch(scopes) !== epoch) {
      await reads.client.invalidateQueries({ queryKey: reads.key(key), exact: true, refetchType: "none" });
      throw new Error("Read facts changed during confirmation");
    }
    const result = reads.client.getQueryState<T>(reads.key(key));
    if (result?.status !== "success" || result.fetchStatus !== "idle" || result.isInvalidated || result.error !== null || result.data === undefined) {
      throw new Error("Read remains unconfirmed");
    }
    // Query may structurally share a fresh response with its earlier snapshot.
    return result.data;
  }
  function checkedRead<T>(key: QueryKey, value: T) {
    const result = reads.client.getQueryState<T>(reads.key(key));
    return !reads.retired && result?.status === "success" && result.fetchStatus === "idle" && !result.isInvalidated && result.error === null && result.data === value;
  }
  const retainedSourceChanged = !!editorDraft && !!source && !!draftSourceBasis.current
    && draftSourceBasis.current.projectId === context.projectId && draftSourceBasis.current.sessionToken === context.sessionToken
    && draftSourceBasis.current.unitId === editorDraft.unitId && draftSourceBasis.current.locale === editorDraft.locale
    && draftSourceBasis.current.sourceRevisionId === editorDraft.sourceRevisionId
    && checkedRead(sourceScopeKey, source) && source.currentSnapshot !== draftSourceBasis.current.sourceSnapshotId;
  function confirmedList() {
    if (!listIntent || !readyListRead || readyListRead.intent !== listIntent || reads.retired) return false;
    const query = reads.client.getQueryCache().find({ queryKey: reads.key(listKey(listIntent)), exact: true });
    return !!query && query === readyListRead.query && query.state.status === "success" && query.state.fetchStatus === "idle"
      && !query.state.isInvalidated && query.state.error === null && query.state.data === readyListRead.data
      && readEpoch(["source", "translation", "resources", "review"]) === readyListRead.epoch;
  }
  function selectionSourceCurrent(value: ContentSelection) {
    return value.projectId === context.projectId && value.sessionToken === context.sessionToken && currentLocale(value.capture.locale)
      && !!source && checkedRead(sourceScopeKey, source) && source.currentSnapshot === value.capture.sourceSnapshotId;
  }
  function selectionGate(): CommandAvailability {
    return open && tab === "edit" && !disabled && !busy && !readBusy && !readRunning.current && !composing && !leaveIntent
      && !selectionAction && !protectionBlocked && !reads.retired && targetAvailable && confirmedList()
      ? { enabled: true } : { enabled: false, reason: "unavailable" };
  }
  function contentRowPayload(row: ReviewSummary, checked: boolean): TranslationContentRowCommandPayload | undefined {
    return list && listIntent ? { kind: "translation-content-row", unitId: row.unitId, scopeId: list.scopeId, locale: targetLocale,
      sourceSnapshotId: list.sourceSnapshotId, listReadId: listIntent.id, selectionVersion: selectionVersion.current, checked } : undefined;
  }
  function contentRowAvailability(payload?: TranslationContentRowCommandPayload): CommandAvailability {
    const gate = selectionGate(); if (!gate.enabled) return gate;
    return payload && payload.listReadId === listIntent?.id && payload.scopeId === list?.scopeId && payload.locale === targetLocale
      && payload.sourceSnapshotId === list.sourceSnapshotId && payload.selectionVersion === selectionVersion.current
      && list.rows.some(row => row.unitId === payload.unitId)
      && (!contentSelection || selectionSourceCurrent(contentSelection) && selectionMembers.has(payload.unitId))
      ? { enabled: true } : { enabled: false, reason: "unavailable" };
  }
  function chooseContentSelection(value: ContentSelection | null) {
    selectionVersion.current++; setContentSelection(value); setSelectionAction(null);
  }
  async function captureContentSelection(current: () => boolean, unitId?: string) {
    const intent = listIntent, page = list, version = selectionVersion.current;
    if (!intent || !page || !confirmedList()) return;
    const epoch = readEpoch(["source", "translation", "resources", "review"]);
    const capture = await reviewCommands.captureScope({ ...context, locale: intent.locale, scopeId: intent.scopeId, excluded: [] });
    if (!current() || version !== selectionVersion.current) return;
    if (!confirmedList() || listIntent !== intent || readEpoch(["source", "translation", "resources", "review"]) !== epoch
      || capture.query !== intent.query || capture.sourceSnapshotId !== page.sourceSnapshotId || capture.units.length !== page.total
      || unitId !== undefined && !capture.units.some(unit => unit.unitId === unitId)) throw { reason: "review-scope-source-changed" };
    const value = fixedContentSelection({ ...context, capture, excluded: unitId === undefined ? [] : capture.units.filter(unit => unit.unitId !== unitId).map(unit => unit.unitId) });
    if (!selectionSourceCurrent(value)) throw { reason: "review-scope-source-changed" };
    if (unitId === undefined) setSelectionAction({ kind: "capture", value, version, listReadId: intent.id });
    else chooseContentSelection(value);
  }
  function toggleContentSelection(payload: TranslationContentRowCommandPayload) {
    if (!contentRowAvailability(payload).enabled) return;
    if (!contentSelection) { if (payload.checked) void performRead(current => captureContentSelection(current, payload.unitId)); return; }
    const excluded = payload.checked ? contentSelection.excluded.filter(id => id !== payload.unitId)
      : [...contentSelection.excluded.filter(id => id !== payload.unitId), payload.unitId];
    chooseContentSelection(fixedContentSelection({ ...contentSelection, excluded }));
  }
  function selectionConfirmationCurrent() {
    return !!selectionAction && selectionAction.version === selectionVersion.current && open && tab === "edit" && !disabled
      && !busy && !readBusy && !composing && !leaveIntent && !reads.retired && selectionSourceCurrent(selectionAction.value)
      && (selectionAction.kind === "capture" ? selectionAction.listReadId === listIntent?.id && confirmedList()
        : selectionAction.value === contentSelection && aiSelection?.available && aiSelection.editSeq === selectionAction.aiEditSeq);
  }
  function prepareSelectionAvailability(): CommandAvailability {
    return selectionGate().enabled && !!onPrepareSelection && !!aiSelection?.available && !!contentSelection
      && selectionSourceCurrent(contentSelection) && selectedIds.size > 0 && selectedIds.size <= 100
      ? { enabled: true } : { enabled: false, reason: "unavailable" };
  }
  async function confirmSelectedAi() {
    const action = selectionAction;
    if (action?.kind !== "ai" || !selectionConfirmationCurrent() || !onPrepareSelection) return;
    // The navigation owner checks this same selection and AI edit sequence again.
    selectionTransfer.current = action.value;
    setSelectionAction(null);
    try { if (!await onPrepareSelection(action.value, action.aiEditSeq) && mounted.current) setFailure("navigation-edited"); }
    catch (error) { if (mounted.current) setFailure(commandFailure(error)); }
    finally { selectionTransfer.current = null; }
  }
  useEffect(() => {
    if (!open || !targetAvailable) return;
    const locale = targetLocale, ticket = ++sourceLoad.current;
    const current = () => mounted.current && sourceLoad.current === ticket && currentLocale(locale);
    void refreshSource(current).catch(error => { if (current()) setFailure(commandFailure(error)); });
    return () => { sourceLoad.current++; };
  }, [open, targetLocale, targetScope, project.sessionToken]);
  async function refreshSource(current: () => boolean) {
    const scope = await freshRead(sourceScopeKey, ["source"], () => sourceCommands.scope(context));
    if (!current()) return;
    const page = scope.currentSnapshot ? await freshRead(["translation-source-content", scope.revision, scope.currentSnapshot, 0, 1], ["source"], () => readContent(scope)) : null;
    if (!current()) return;
    if (page) {
      const position = listPosition.current;
      await loadList(position.after, position.query, current);

    } else setListIntent(null);
  }
  useEffect(() => {
    if (!open || tab !== "edit" || !targetAvailable) return;
    if (editorActivation) {
      if (editorActivation.locale !== targetLocale) return;
      // Start after the requested view commits, so its activation does not
      // invalidate the fresh read that confirms the explicit selection.
      setEditorActivation(null);
      readRunning.current = false;
      void performRead(current => openEditor(editorActivation.target, current, editorActivation.locale, editorActivation.suggestedText));
      return;
    }
    const retained = draftSession.current();
    if (!retained || retained.locale !== targetLocale) return;
    const target = { unitId: retained.unitId, sourceRevisionId: retained.sourceRevisionId, key: retained.key, sourceText: retained.sourceText };
    void performRead(async current => {
      if (!retained.pending && !retained.pendingSelection && !retained.saving && !retained.selecting
        && retained.text === (retained.baseText ?? "") && !retained.newerDraftSaved) await openEditor(target, current, retained.locale, undefined, true);
      else await refreshEditorReference(target, current, retained.locale);
      if (current() && historyIntent?.unitId === retained.unitId && historyIntent.locale === retained.locale) await loadHistory(historyIntent.after, current);
    });
  }, [open, tab, targetLocale, targetScope, project.sessionToken, editorActivation]);
  async function loadList(after: number, search: string, current: () => boolean, fresh = false) {
    const locale = targetLocale;
    if (!currentLocale(locale) || !current()) return;
    if (new TextEncoder().encode(search).length > 256) { setFailure("query-limit"); return; }
    // A retained page is a projection, not confirmation of this read intent.
    setReadyListRead(null);
    const retained = fresh ? null : listScope.current;
    const scopeId = retained?.locale === locale && retained.query === search ? retained.id : null;
    const dependencies: ChangeScope[] = ["source", "translation", "resources", "review"];
    const id = ++readSequence.current; latestListRead.current = id;
    await reads.synchronizeFresh();
    if (!current() || !currentLocale(locale) || reads.retired || latestListRead.current !== id) return;
    const captureEpoch = readEpoch(dependencies);
    let intent: ListReadIntent, next: ReviewSummaryPage;
    if (scopeId === null) {
      // Null scope creates a Host capture and is never an automatic Query function.
      next = await reviewCommands.summaryPage({ ...context, locale, query: search, afterOrdinal: after, limit: 50, scopeId: null });
      if (!current() || !currentLocale(locale) || reads.retired || latestListRead.current !== id) return;
      if (next.rows.some(row => row.locale !== locale || row.sourceSnapshotId !== next.sourceSnapshotId)) throw { reason: "selection" };
      intent = { id, locale, query: search, after, scopeId: next.scopeId };
      // Notifications must find the dependencies before the seed is published,
      // including the interval before its observer subscribes.
      const query = reads.client.getQueryCache().build(reads.client, { queryKey: reads.key(listKey(intent)),
        meta: { scopes: dependencies }, queryFn: () => readList(intent) });
      next = query.setData(next);
      if (readEpoch(dependencies) !== captureEpoch) {
        // The capture's key did not exist when the notification arrived. Recheck
        // that same fixed scope; automatic refresh must never allocate a new one.
        await reads.client.invalidateQueries({ queryKey: reads.key(listKey(intent)), exact: true, refetchType: "none" });
        const beforeRead = readEpoch(dependencies);
        next = await freshRead(listKey(intent), ["source", "translation", "resources", "review"], () => readList(intent));
        if (readEpoch(dependencies) !== beforeRead) {
          await reads.client.invalidateQueries({ queryKey: reads.key(listKey(intent)), exact: true, refetchType: "none" });
          throw new Error("Entry facts changed during confirmation");
        }
      }
    } else {
      intent = { id, locale, query: search, after, scopeId };
      next = await freshRead(listKey(intent), ["source", "translation", "resources", "review"], () => readList(intent));
    }
    if (current() && currentLocale(locale) && latestListRead.current === id && checkedRead(listKey(intent), next)) {
      const query = reads.client.getQueryCache().find({ queryKey: reads.key(listKey(intent)), exact: true });
      if (!query) return;
      setListIntent(intent); setListAfter(after); setAppliedQuery(search); setNavigationEnd(false);
      // A routine focus check may reread identical data without a semantic
      // change. Preserve only that original Query and exact data confirmation;
      // changed facts, replacement records and semantic notifications revoke it.
      setReadyListRead({ intent, query, data: next, epoch: readEpoch(dependencies) });
      listPosition.current = { query: search, after };
      listScope.current = { id: next.scopeId, locale, query: search };
      listBasis.current = next.sourceSnapshotId;
    }
  }
  function listTarget(row: ReviewTarget | ReviewSummary): EditorTarget {
    return { unitId: row.unitId, sourceRevisionId: row.sourceRevisionId, key: row.nativeKey,
      sourceText: "sourceText" in row ? row.sourceText : row.sourcePreview };
  }
  function reviewState(row: ReviewSummary) {
    return t(row.currentDecision?.basis === row.basis
      ? row.currentDecision.kind === "approve" ? "review.currentApproval" : "review.changesRequested" : "workbench.reviewPending");
  }
  function qaState(row: ReviewSummary) {
    const check = row.currentCheck;
    return t(!check || check.basis !== row.basis ? "workbench.qaPending" : check.outcome === "failed" ? "review.checkFailed"
      : check.outcome === "cancelled" ? "review.checkCancelled" : check.outcome === "unknown" ? "review.checkUnknown"
      : check.hasIncomplete ? "review.qaUnavailable" : check.hasFindings ? "review.findings" : "review.passed");
  }
  useEffect(() => { if (open) heading.current?.focus(); }, [open, tab]);
  useEffect(() => { setHasDraftSelection(false); setQueryUnavailable(false); }, [editorTarget?.unitId, targetLocale]);
  useEffect(() => { if (entryList.current) entryList.current.scrollTop = 0; }, [listAfter, appliedQuery, targetLocale]);
  useEffect(() => {
    if (!open || tab !== "edit") return;
    const input = draftField.current;
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: "nearest" });
  }, [open, tab, editorTarget?.unitId]);
  const commandScope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "translation" as const };
  function saveAvailability() {
    if (!open || tab !== "edit" || disabled || leaveIntent) return { enabled: false, reason: "hidden" as const };
    if (composing || busy || running.current || draftSession.protection.blocked()) return { enabled: false, reason: "busy" as const };
    const capture = draftSession.current();
    if (capture?.pending || capture?.pendingSelection || capture?.saving || draftSession.mutationReserved) return { enabled: false, reason: "pending-action" as const };
    if (!targetAvailable || !capture || capture.locale !== targetLocale || !editingReady?.ready || editingReady.scope !== editingProtectionScope(context, capture, capture.locale)) return { enabled: false, reason: "unavailable" as const };
    if (capture.text === (capture.baseText ?? "") && !capture.newerDraftSaved) return { enabled: false, reason: "no-changes" as const };
    return { enabled: true };
  }
  function retryAvailability() {
    if (!open || tab !== "edit" || disabled || leaveIntent) return { enabled: false, reason: "hidden" as const };
    if (composing || busy || running.current || draftSession.protection.blocked()) return { enabled: false, reason: "busy" as const };
    if (!pendingSave || pendingSelection) return { enabled: false, reason: "unavailable" as const };
    if (!targetAvailable) return { enabled: false, reason: "unavailable" as const };
    return { enabled: true };
  }
  function reconcileAvailability() {
    if (!open || tab !== "edit" || disabled || leaveIntent) return { enabled: false, reason: "hidden" as const };
    if (composing || busy || running.current || draftSession.protection.blocked()) return { enabled: false, reason: "busy" as const };
    if (!pendingSave || pendingSelection) return { enabled: false, reason: "unavailable" as const };
    return { enabled: true };
  }
  function saveAndNextAvailability() {
    const capture = draftSession.current();
    const available = capture?.pending ? retryAvailability() : saveAvailability();
    if (!available.enabled) return available;
    const scope = listScope.current;
    if (sourceRead.isFetching || sourceRead.error || contentRead.error || editorRead.isFetching || editorRead.error || listRead.isFetching || listRead.error
      || !confirmedList() || readyEditorRead !== editorIntent?.id || !snapshot || !capture || snapshot.target.sourceRevisionId !== capture.sourceRevisionId
      || capture.locale !== targetLocale || !editorTarget || editorTarget.unitId !== capture.unitId || !list?.total || !scope
      || scope.id !== list.scopeId || scope.locale !== capture.locale || scope.query !== appliedQuery) {
      return { enabled: false, reason: "unavailable" as const };
    }
    return available;
  }
  const unavailableCommand: CommandAvailability = { enabled: false, reason: "unavailable" };
  function sameCommandValue(left: unknown, right: unknown): boolean {
    if (Object.is(left,right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((value,index)=>sameCommandValue(value,right[index]));
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const keys=Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key=>Object.prototype.hasOwnProperty.call(right,key)
      && sameCommandValue(Reflect.get(left,key),Reflect.get(right,key)));
  }
  function businessGate(area: "import" | "edit", recovery = false): CommandAvailability {
    if (!mounted.current || reads.retired || !open || tab !== area || disabled || leaveIntent
      || reads.context.projectId !== commandScope.projectId || reads.context.sessionToken !== commandScope.sessionToken) return { enabled: false, reason: "hidden" };
    const imported = importSession.current(), draft = draftSession.current();
    if (draftSession.protection.blocked() || running.current || localBusy || imported.busy || draft?.saving || draft?.selecting) return { enabled: false, reason: "busy" };
    if (!recovery && (importSession.hasPending() || draft?.pending || draft?.pendingSelection)) return { enabled: false, reason: "pending-action" };
    if (!recovery && (!targetAvailable || (area === "import" && imported.targetLocale !== targetLocale))) return unavailableCommand;
    return { enabled: true };
  }
  function sourceReady(snapshotId?: string) {
    const value = reads.client.getQueryState<ContentScope>(reads.key(sourceScopeKey));
    return value?.status === "success" && value.error === null && value.fetchStatus === "idle" && !value.isInvalidated
      && !!value.data?.currentSnapshot && (!snapshotId || value.data.currentSnapshot === snapshotId);
  }
  function sourceFlightProof() {
    const captured = reads.client.getQueryData<ContentScope>(reads.key(sourceScopeKey));
    const witness = reads.watchExactQuery(sourceScopeKey);
    return { current: () => {
      const query = witness.current();
      return !reads.retired && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
        && captured !== undefined && (!query || query.state.status === "success" && query.state.error === null
          && !query.state.isInvalidated && sameCommandValue(query.state.data, captured));
    }, dispose: witness.dispose };
  }
  function importPreviewTarget(value: TranslationPreview, editSeq = importSession.current().editSeq) {
    return { editSeq, attemptId: value.attemptId, bundleId: value.bundleId, basis: value.basis, locale: value.targetLocale,
      fixedSourceSnapshotId: value.fixedSourceSnapshotId, currentSourceSnapshotId: value.currentSourceSnapshotId,
      fileDigest: value.fileDigest, previewResultDigest: value.resultDigest };
  }
  function importRowTarget(row: TranslationPreviewRow): TranslationImportRowTarget | undefined {
    return row.unitId && row.occurrenceId && row.sourceRevisionId ? { ordinal: row.entry.ordinal, itemId: row.itemId, resultId: row.resultId,
      resultDigest: row.resultDigest, unitId: row.unitId, occurrenceId: row.occurrenceId, sourceRevisionId: row.sourceRevisionId,
      expectedSelectionId: row.currentSelection?.eventId ?? null } : undefined;
  }
  function importRowPayload(row: TranslationPreviewRow, decision: TranslationDecision, captured = importSession.current().preview,
    editSeq = importSession.current().editSeq): TranslationImportRowCommandPayload | undefined {
    const target = importRowTarget(row);
    return target && captured ? { kind: "translation-import-row", ...importPreviewTarget(captured, editSeq), ...target, decision } : undefined;
  }
  function rowCommandTarget(payload: TranslationImportRowCommandPayload, applying = false) {
    const value = importSession.current(), capture = value.rowAction, basis = applying ? capture?.preview : value.preview;
    const row = applying ? capture?.row : basis?.rows.find(row => sameCommandValue(importRowTarget(row), {
      ordinal: payload.ordinal, itemId: payload.itemId, resultId: payload.resultId, resultDigest: payload.resultDigest, unitId: payload.unitId,
      occurrenceId: payload.occurrenceId, sourceRevisionId: payload.sourceRevisionId, expectedSelectionId: payload.expectedSelectionId }));
    if (!row || !basis) return undefined;
    if (applying) return capture && sameCommandValue(payload, importRowPayload(row, capture.decision, basis, capture.editSeq)) ? row : undefined;
    return sameCommandValue(payload, importRowPayload(row, payload.decision, basis, value.editSeq)) ? row : undefined;
  }
  function importRowAvailability(payload?: TranslationImportRowCommandPayload, applying = false): CommandAvailability {
    const allowed = businessGate("import"); if (!allowed.enabled) return allowed;
    const value = importSession.current(), row = payload ? rowCommandTarget(payload, applying) : undefined;
    return payload && row && !value.stale && !draftSession.mutationReserved
      && payload.fixedSourceSnapshotId === payload.currentSourceSnapshotId && payload.editSeq === value.editSeq
      && payload.locale === targetLocale && (row.status === "unique" || row.status === "selected-conflict")
      && (payload.decision === "replace" ? !!row.currentSelection : payload.decision !== "select-if-empty" || !row.currentSelection)
      ? { enabled: true } : unavailableCommand;
  }
  function importPreviewPayload(): TranslationImportPreviewCommandPayload | undefined {
    const value = importSession.current();
    return value.preview ? { kind: "translation-import-preview", ...importPreviewTarget(value.preview), selectIfEmpty: value.selectIfEmpty } : undefined;
  }
  function importPreviewAvailability(payload?: TranslationImportPreviewCommandPayload): CommandAvailability {
    const allowed = businessGate("import"); if (!allowed.enabled) return allowed;
    const value = importSession.current();
    return payload && sameCommandValue(payload, importPreviewPayload()) && !!value.preview?.unique && !value.preview.sourceChanged
      && !value.stale && !draftSession.mutationReserved
      && payload.fixedSourceSnapshotId === payload.currentSourceSnapshotId ? { enabled: true } : unavailableCommand;
  }
  function importBatchPayload(): TranslationImportBatchCommandPayload | undefined {
    const capture = importSession.current().batchCapture; if (!capture || capture.decision === "replace") return undefined;
    const rows = capture.eligible.map(importRowTarget); if (rows.some(row => !row)) return undefined;
    return { kind: "translation-import-batch", ...importPreviewTarget(capture.preview, capture.editSeq), decision: capture.decision,
      rows: rows.filter((row): row is TranslationImportRowTarget => !!row), excluded: capture.excluded };
  }
  function importBatchAvailability(payload?: TranslationImportBatchCommandPayload): CommandAvailability {
    const allowed = businessGate("import"); if (!allowed.enabled) return allowed;
    return payload && sameCommandValue(payload, importBatchPayload()) && payload.editSeq === importSession.current().editSeq
      && !importSession.current().stale && !draftSession.mutationReserved
      && payload.fixedSourceSnapshotId === payload.currentSourceSnapshotId ? { enabled: true } : unavailableCommand;
  }
  function importPendingPayload(actionId: string): TranslationImportPendingCommandPayload | undefined {
    const value = importSession.current().uncertain.find(pending => pending.request.actionId === actionId);
    return value ? { kind: "translation-import-pending", request: structuredClone(value.request), recoveryUnitId: value.recoveryUnitId,
      previousSelectionSequence: value.previousSelectionSequence } : undefined;
  }
  function importPendingAvailability(payload?: TranslationImportPendingCommandPayload, retry = false): CommandAvailability {
    const allowed = businessGate("import", true); if (!allowed.enabled) return allowed;
    const pending = payload && importSession.current().uncertain.find(value => value.request.actionId === payload.request.actionId);
    return payload && pending && sameCommandValue(payload, importPendingPayload(payload.request.actionId)) && (!retry || pending.receiptChecked)
      ? { enabled: true } : unavailableCommand;
  }
  function revisionPayload(revision: TranslationRevision): TranslationRevisionCommandPayload | undefined {
    const value = draftSession.current();
    return value ? { kind: "translation-revision", unitId: value.unitId, locale: value.locale, sourceRevisionId: value.sourceRevisionId,
      expectedSelectionId: value.baseSelectionId, editSeq: value.editSeq, revisionId: revision.revisionId, revisionActionId: revision.actionId,
      revisionOrdinal: revision.ordinal, revisionSourceRevisionId: revision.sourceRevisionId, revisionSourceSnapshotId: revision.sourceSnapshotId } : undefined;
  }
  function revisionTarget(payload: TranslationRevisionCommandPayload) {
    return history?.rows.find(row => sameCommandValue(payload, revisionPayload(row)));
  }
  function revisionAvailability(payload?: TranslationRevisionCommandPayload): CommandAvailability {
    const allowed = businessGate("edit"); if (!allowed.enabled) return allowed;
    const value = draftSession.current(), revision = payload && revisionTarget(payload);
    return payload && value && revision && value.text === (value.baseText ?? "") && !value.newerDraftSaved
      && !draftSession.mutationReserved && payload.locale === targetLocale && editorTarget?.unitId === value.unitId && !historyStale
      && value.baseRevisionId !== payload.revisionId && !!snapshot && checkedRead(editorKey(editorIntent), snapshot)
      && (!historySelected || !!history && checkedRead(historyKey(historyIntent), history)) && sourceReady()
      ? { enabled: true } : unavailableCommand;
  }
  function selectionPendingPayload(): TranslationSelectionPendingCommandPayload | undefined {
    const value = draftSession.current()?.pendingSelection;
    return value ? { kind: "translation-selection-pending", request: structuredClone(value.request), submittedSeq: value.submittedSeq } : undefined;
  }
  function selectionPendingAvailability(payload?: TranslationSelectionPendingCommandPayload, retry = false): CommandAvailability {
    const allowed = businessGate("edit", true); if (!allowed.enabled) return allowed;
    const value = draftSession.current()?.pendingSelection;
    return payload && value && sameCommandValue(payload, selectionPendingPayload()) && (!retry || value.receiptChecked)
      ? { enabled: true } : unavailableCommand;
  }
  function revisionFlightProof(revision: TranslationRevision) {
    const sourceProof = sourceFlightProof(), editorWitness = reads.watchExactQuery(editorKey(editorIntent));
    const historyWitness = historySelected ? reads.watchExactQuery(historyKey(historyIntent)) : null, before = draftSession.current();
    function matches(value: TranslationHistory) {
      return !!before && value.unitId === before.unitId && value.locale === before.locale
        && (value.current?.eventId ?? null) === before.baseSelectionId && value.rows.some(row => sameCommandValue(row, revision));
    }
    return { current: () => {
      const editor = editorWitness.current(), selectedHistory = historyWitness?.current();
      return sourceProof.current() && !!before && (!editor || editor.state.status === "success" && editor.state.error === null
        && validateResponseEditor(editor.state.data) && editor.state.data.target.unitId === before.unitId
        && editor.state.data.target.locale === before.locale && editor.state.data.target.sourceRevisionId === before.sourceRevisionId
        && editor.state.data.target.selectionId === before.baseSelectionId && (historyWitness !== null || matches(editor.state.data.translations)))
        && (!selectedHistory || selectedHistory.state.status === "success" && selectedHistory.state.error === null
          && validateResponseHistory(selectedHistory.state.data) && matches(selectedHistory.state.data));
    }, dispose: () => { sourceProof.dispose(); editorWitness.dispose(); historyWitness?.dispose(); } };
  }
  useLayoutEffect(() => {
    const removeSave = commandRegistry.register({
      id: "translation.save", nameKey: "translation.save", category: "translation", scope: commandScope,
      binding: "Mod+S", risk: "writes-translation", confirmation: "none", availability: saveAvailability,
      handler: () => { void perform(saveDraft); },
    });
    const removeSaveNext = commandRegistry.register({
      id: "translation.save-and-next", nameKey: "workbench.saveAndNext", category: "translation", scope: commandScope,
      binding: null, risk: "writes-translation", confirmation: "none", availability: saveAndNextAvailability,
      handler: () => { void perform(saveAndNext); },
    });
    const removeRetry = commandRegistry.register({
      id: "translation.retry-save", nameKey: "translation.retryAction", category: "translation", scope: commandScope,
      binding: null, risk: "writes-translation", confirmation: "none", availability: retryAvailability,
      handler: () => { void perform(saveDraft); },
    });
    const removeReconcile = commandRegistry.register({
      id: "translation.reconcile-save", nameKey: "translation.checkSavedAction", category: "translation", scope: commandScope,
      binding: null, risk: "writes-translation", confirmation: "none", availability: reconcileAvailability,
      handler: () => { void perform(checkSavedAction); },
    });
    const metadata = { category: "translation" as const, scope: commandScope, binding: null, confirmation: "none" as const };
    const removeBusiness = [
      commandRegistry.register({ ...metadata, id: "translation.capture-content-selection", nameKey: "workbench.selectAllMatching", risk: "captures-content-selection",
        availability: () => selectionGate().enabled && !!list?.total ? { enabled: true } : unavailableCommand,
        handler: () => { void performRead(current => captureContentSelection(current)); } }),
      commandRegistry.register({ ...metadata, id: "translation.toggle-content-selection", nameKey: "workbench.selectEntry", risk: "captures-content-selection",
        payloadKind: "translation-content-row", availability: contentRowAvailability, handler: toggleContentSelection }),
      commandRegistry.register({ ...metadata, id: "translation.clear-content-selection", nameKey: "workbench.clearContentSelection", risk: "captures-content-selection",
        availability: () => open && tab === "edit" && !disabled && !reads.retired && !!contentSelection && !selectionAction ? { enabled: true } : unavailableCommand,
        handler: () => chooseContentSelection(null) }),
      commandRegistry.register({ ...metadata, id: "translation.prepare-selected-ai", nameKey: "workbench.prepareSelectedAi", risk: "captures-ai",
        confirmation: "required", availability: prepareSelectionAvailability, handler: () => {
          if (contentSelection && aiSelection) setSelectionAction({ kind: "ai", value: contentSelection, version: selectionVersion.current,
            aiEditSeq: aiSelection.editSeq, previousCount: aiSelection.count, previousLocale: aiSelection.locale });
        } }),
      commandRegistry.register({ ...metadata, id: "translation.choose-import-row", nameKey: "translation.addCandidate", risk: "captures-translation-import",
        payloadKind: "translation-import-row", availability: payload => importRowAvailability(payload), handler: payload => {
          const row=rowCommandTarget(payload); if(row)importSession.chooseRow(row,payload.decision);
        } }),
      commandRegistry.register({ ...metadata, id: "translation.apply-import-row", nameKey: "translation.selectImported", risk: "writes-translation",
        confirmation: "required", payloadKind: "translation-import-row", availability: payload => importRowAvailability(payload,true),
        handler: () => { void importSession.applyRow(); } }),
      commandRegistry.register({ ...metadata, id: "translation.capture-import-batch", nameKey: "translation.apply", risk: "captures-translation-import",
        payloadKind: "translation-import-preview", availability: importPreviewAvailability,
        handler: () => { void importSession.captureBatch(); } }),
      commandRegistry.register({ ...metadata, id: "translation.apply-import-batch", nameKey: "translation.batchStart", risk: "writes-translation",
        confirmation: "required", payloadKind: "translation-import-batch", availability: importBatchAvailability,
        handler: () => { void importSession.applyBatch(); } }),
      commandRegistry.register({ ...metadata, id: "translation.check-import-receipt", nameKey: "translation.checkReceipt", risk: "reconciles-execution-action",
        payloadKind: "translation-import-pending", availability: payload => importPendingAvailability(payload), handler: payload => { void importSession.checkReceipt(payload.request.actionId); } }),
      commandRegistry.register({ ...metadata, id: "translation.retry-import-action", nameKey: "translation.retryAction", risk: "retries-execution-action",
        payloadKind: "translation-import-pending", availability: payload => importPendingAvailability(payload,true), handler: payload => { void importSession.retryAction(payload.request.actionId); } }),
      commandRegistry.register({ ...metadata, id: "translation.select-revision", nameKey: "translation.selectRevision", risk: "writes-translation",
        payloadKind: "translation-revision", availability: revisionAvailability, handler: payload => { void perform(current => selectRevision(payload,current)); } }),
      commandRegistry.register({ ...metadata, id: "translation.check-selection", nameKey: "translation.checkSelection", risk: "reconciles-execution-action",
        payloadKind: "translation-selection-pending", availability: payload => selectionPendingAvailability(payload), handler: () => { void perform(current => checkSelection(current)); } }),
      commandRegistry.register({ ...metadata, id: "translation.retry-selection", nameKey: "translation.retrySelection", risk: "retries-execution-action",
        payloadKind: "translation-selection-pending", availability: payload => selectionPendingAvailability(payload,true), handler: () => { void perform(current => checkSelection(current,true)); } }),
    ];
    return () => { removeBusiness.forEach(dispose=>dispose()); removeReconcile(); removeRetry(); removeSaveNext(); removeSave(); };
  });
  useImperativeHandle(ref, () => ({
    saveCurrent() {
      commandRegistry.dispatch("translation.save", commandScope);
    },
    showAttempt(id) {
      if (composing || draftSession.protection.blocked() || running.current || readRunning.current || draftSession.current()?.saving || draftSession.current()?.selecting || dirty || pendingSave || pendingSelection || importSession.hasPending() || importSession.hasActive() || importState.busy) { setOpen(true); return; }
      generation.current++;
      setEditorTarget(null); setEditorIntent(null); setHistoryIntent(null); draftSession.clear();
      if (!importSession.showAttempt(id)) return;
      setTargetLocale(importSession.current().targetLocale); setTab("import"); setFailure(null); setOpen(true);
    },
    openUnit(target, locale, suggestedText) {
      if (!localeAvailable(locale)) {
        setOpen(true); setFailure("target-locale");
        return false;
      }
      if (composing || draftSession.protection.blocked() || running.current || readRunning.current || draftSession.current()?.saving || draftSession.current()?.selecting || dirty || pendingSave || pendingSelection || importSession.hasPending() || importSession.hasActive() || importState.busy) {
        setOpen(true);
        return false;
      }
      if (locale !== targetLocale) changeTarget(locale);
      setTab("edit"); setOpen(true);
      readRunning.current = true; setReadBusy(true);
      setEditorActivation({ target, locale, suggestedText });
      return true;
    },
    allowLeave(current: () => boolean = () => true) {
      leaveProof.current = current;
      const manual = draftSession.current(), imported = importSession.current();
      if (composing || draftSession.protection.blocked() || importSession.hasActive() || imported.busy || manual?.saving || manual?.selecting) { setOpen(true); return Promise.resolve(false); }
      if (manual?.pending || manual?.pendingSelection || importSession.hasPending()) { setOpen(true); setFailure("outcome-unknown"); return Promise.resolve(false); }
      // Remounting starts view reads. Stop their UI continuation, while the
      // independent owners above retain authority over actual business work.
      generation.current++; running.current = false; readRunning.current = false; readFlight.current = null; setEditorActivation(null); setReadBusy(false); setBusy(false);
      if ((!manual || (manual.text === (manual.baseText ?? "") && !manual.newerDraftSaved)) && (imported.folder || imported.preflight) && !imported.attempt) {
        setOpen(true); setTab("import"); setLeaveIntent({ kind: "import-project" });
        return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
      }
      if (!manual || (manual.text === (manual.baseText ?? "") && !manual.newerDraftSaved)) return Promise.resolve(true);
      setOpen(true);
      setLeaveIntent({ kind: "project" });
      return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
    },
    allowNavigate() {
      const confirmingSelection = selectionAction !== null && (selectionAction.kind !== "ai" || selectionTransfer.current !== selectionAction.value
        || contentSelection !== selectionAction.value || selectionVersion.current !== selectionAction.version);
      if (composing || draftSession.protection.blocked() || leaveIntent || confirmingSelection || rowAction || batchCapture || (running.current && !editorDraft?.saving)) return Promise.resolve(false);
      return Promise.resolve(true);
    },
  }));

  async function perform(work: (current: () => boolean) => Promise<unknown>) {
    if (running.current) return;
    running.current = true;
    const ticket = ++generation.current;
    const current = () => mounted.current && generation.current === ticket;
    setBusy(true); setFailure(null);
    try { await work(current); } catch (error) { if (current()) setFailure(commandFailure(error)); }
    finally { if (generation.current === ticket) { running.current = false; if (mounted.current) setBusy(false); } }
  }
  async function performRead(work: (current: () => boolean) => Promise<unknown>) {
    if (running.current || readRunning.current) return;
    readRunning.current = true; setReadBusy(true);
    const flight = Symbol("translation-view-read"); readFlight.current = flight;
    const ticket = ++generation.current, epoch = saveNextViewEpoch.current;
    const current = () => mounted.current && !reads.retired && generation.current === ticket && saveNextViewEpoch.current === epoch;
    setFailure(null);
    try { await work(current); } catch (error) { if (current()) setFailure(commandFailure(error)); }
    finally { if (readFlight.current === flight) { readFlight.current = null; readRunning.current = false; if (mounted.current) setReadBusy(false); } }
  }
  function endMutationWait(current: () => boolean) {
    if (current()) { running.current = false; setBusy(false); }
  }
  function changeTarget(locale: string) {
    if (locale && !localeAvailable(locale)) return;
    if (!importSession.setTarget(locale)) return;
    selectedLocale.current = locale;
    setEditorActivation(null);
    setTargetLocale(locale);
    setReadyListRead(null);
    setListIntent(null); listScope.current = null; listPosition.current = { query: "", after: 0 };
    setQuery(""); setAppliedQuery(""); setListAfter(0); setNavigationEnd(false);
    if (editorTarget) { setEditorTarget(null); setEditorIntent(null); setHistoryIntent(null); }
    if (editorDraft) draftSession.clear();
  }
  const importRead = useSessionQuery<TranslationPreview | null>({ key: ["translation-import-preview", attempt, 0, 50, null], scopes: ["execution", "translation"], enabled: open && !importState.busy && !!attempt && !preview,
    read: async () => {
      try { return await commands.preview({ ...context, attemptId: attempt!, after: 0, limit: 50, basis: null }); }
      catch (error) { if (errorStage(error) === "translation-incomplete") return null; throw error; }
    } });
  useEffect(() => {
    if (!importRead.data || importRead.data.attemptId !== importSession.current().attempt || importSession.current().preview) return;
    importSession.ready(importRead.data);
    selectedLocale.current = importRead.data.targetLocale;
    setTargetLocale(importRead.data.targetLocale); setFailure(null);
  }, [importRead.data, targetScope]);
  useEffect(() => { if (importRead.error && !preview) setFailure(commandFailure(importRead.error)); }, [importRead.error, preview]);
  async function refreshEditorReference(target: EditorTarget, current: () => boolean, locale = targetLocale) {
    if (!currentLocale(locale) || !current()) return null;
    const intent: EditorReadIntent = { id: ++readSequence.current, unitId: target.unitId, locale };
    setReadyEditorRead(null);
    setEditorIntent(intent);
    const snapshot = await freshRead(editorKey(intent), ["source", "translation", "resources", "review"], () => readEditor(intent));
    if (!current() || !currentLocale(locale) || !checkedRead(editorKey(intent), snapshot)) return null;
    setReadyEditorRead(intent.id);
    return { intent, snapshot };
  }
  async function openEditor(target: EditorTarget, current: () => boolean, locale = targetLocale, suggestedText?: string, preserveEdited = false) {
    if (!currentLocale(locale)) return;
    const retained = draftSession.current();
    const result = await refreshEditorReference(target, current, locale);
    if (!result || !current() || !currentLocale(locale) || !checkedRead(editorKey(result.intent), result.snapshot)) return;
    const { snapshot } = result;
    if (draftSession.current()?.editSeq !== retained?.editSeq || draftSession.current()?.text !== retained?.text) {
      if (current() && !preserveEdited) setFailure("navigation-edited"); return;
    }
    const nextTarget = listTarget(snapshot.target), next = snapshot.translations;
    if (!draftSession.begin({ ...nextTarget, locale }, next.current, next.currentText, suggestedText)) { setFailure("navigation-edited"); return; }
    draftSourceBasis.current = { ...context, unitId: nextTarget.unitId, locale,
      sourceRevisionId: nextTarget.sourceRevisionId, sourceSnapshotId: snapshot.target.sourceSnapshotId };
    setEditorTarget(nextTarget); setHistoryIntent(null); setNavigationEnd(false); setTab("edit");
  }
  function chooseEditor(target: EditorTarget) {
    if (!targetAvailable) return;
    if (pendingSave || pendingSelection) { setFailure("outcome-unknown"); return; }
    if (dirty) { setLeaveIntent({ kind: "switch", target }); return; }
    void performRead(current => openEditor(target, current));
  }
  async function saveDraft(current: () => boolean) {
    const result = await draftSession.save();
    endMutationWait(current);
    if (result.saved && current() && currentLocale(targetLocale)) {
      try { await loadList(listAfter, appliedQuery, current); }
      catch { if (current()) setFailure("save-list-refresh"); }
    }
    return result;
  }
  async function checkSavedAction(current: () => boolean) {
    const result = await draftSession.checkSavedAction();
    endMutationWait(current);
    if (result.saved && current() && currentLocale(targetLocale)) {
      try { await loadList(listAfter, appliedQuery, current); }
      catch { if (current()) setFailure("save-list-refresh"); }
    }
    return false;
  }
  async function navigateEntry(direction: -1 | 1, current: () => boolean, afterSave = false) {
    const locale = targetLocale;
    if (!editorTarget || !listScope.current || !currentLocale(locale)) return;
    const retained = draftSession.current();
    const unchanged = () => current() && currentLocale(locale)
      && draftSession.current()?.editSeq === retained?.editSeq && draftSession.current()?.text === retained?.text;
    const request = { ...context, unitId: editorTarget.unitId, locale, scopeId: listScope.current.id, direction };
    const key = ["translation-neighbor", request.unitId, locale, request.scopeId, direction, ++readSequence.current];
    const neighbor = await freshRead<ReviewNeighbor>(key, ["source", "translation", "review"], () => reviewCommands.neighbor(request));
    if (!checkedRead(key, neighbor) || neighbor.sourceSnapshotId !== listBasis.current) throw { reason: "review-scope-source-changed" };
    if (!currentLocale(locale)) return;
    if (!unchanged()) { if (current()) setFailure("navigation-edited"); return; }
    if (neighbor.unitId === null || neighbor.afterOrdinal === null) { setNavigationEnd(direction > 0); return; }
    const nextTarget = { ...editorTarget, unitId: neighbor.unitId };
    if (dirty && !afterSave) { setLeaveIntent({ kind: "switch", target: nextTarget, after: neighbor.afterOrdinal }); return; }
    await loadList(neighbor.afterOrdinal, appliedQuery, unchanged);
    if (unchanged()) await openEditor(nextTarget, unchanged);
    else if (current()) setFailure("navigation-edited");
  }
  async function saveAndNext(current: () => boolean) {
    if (!targetAvailable) return;
    const epoch = saveNextViewEpoch.current;
    // The owner settles the original save; leaving this view only cancels its navigation.
    const currentView = () => current() && saveNextViewEpoch.current === epoch;
    const result = await saveDraft(currentView);
    if (result.savedCurrent && currentView() && currentLocale(targetLocale)
      && draftSession.unchanged(result.submittedSeq, result.submittedText)) await navigateEntry(1, currentView, true);
  }
  async function selectRevision(payload: TranslationRevisionCommandPayload, current: () => boolean) {
    const locale = targetLocale, revision = revisionTarget(payload);
    const basis = draftSession.current();
    if (!revision || !basis || !editorTarget || dirty || pendingSave || pendingSelection || !currentLocale(locale)) return;
    const proof = revisionFlightProof(revision);
    // Query evidence follows this fixed business wait; only the UI refresh is tied to the consumer.
    const selected = await draftSession.selectRevision(revision, proof.current, proof.dispose);
    endMutationWait(current);
    if (!selected || !current() || !currentLocale(locale)) return;
    try { await refreshHistory(current); await loadList(listAfter, appliedQuery, current); }
    catch { if (current()) setFailure("save-list-refresh"); }
  }
  async function checkSelection(current: () => boolean, retry = false) {
    const selected = retry ? await draftSession.retrySelection() : await draftSession.checkSelection();
    endMutationWait(current);
    if (!selected || !current() || !currentLocale(targetLocale)) return;
    try { await refreshHistory(current); await loadList(listAfter, appliedQuery, current); }
    catch { if (current()) setFailure("save-list-refresh"); }
  }
  async function loadHistory(after: string, current: () => boolean) {
    const locale = targetLocale, target = editorTarget;
    if (!target || !currentLocale(locale) || !current()) return;
    const intent: HistoryReadIntent = { id: ++readSequence.current, unitId: target.unitId, locale, after };
    setHistoryIntent(intent);
    const value = await freshRead(historyKey(intent), ["source", "translation"], () => readHistory(intent));
    if (!current() || !currentLocale(locale) || !checkedRead(historyKey(intent), value)) return;
  }
  async function refreshHistory(current: () => boolean) {
    const locale = targetLocale, target = editorTarget;
    if (!target || !currentLocale(locale) || !current()) return;
    const key = ["translation-history-head", target.unitId, locale, 0, 1, ++readSequence.current];
    const first = await freshRead(key, ["source", "translation"], () => commands.history({ ...context, unitId: target.unitId, locale, afterOrdinal: "0", limit: 1 }));
    if (!current() || !currentLocale(locale) || !checkedRead(key, first)) return;
    if (first.unitId !== target.unitId || first.locale !== locale) throw { reason: "selection" };
    await loadHistory(translationHistoryAfter(first.total, 100), current);
  }
  async function queryEditorText(text: string) {
    if (!onQueryText || composing || draftSession.protection.blocked() || !text) return;
    await performRead(async current => {
      const captured = draftSession.current();
      let accepted = false;
      try { accepted = await onQueryText(text); } catch { /* A failed destination retains the editor input. */ }
      const latest = draftSession.current();
      if (current() && latest && captured && latest.unitId === captured.unitId && latest.locale === captured.locale
        && latest.sourceRevisionId === captured.sourceRevisionId) setQueryUnavailable(!accepted);
    });
  }
  function requestClose() {
    if (composing || draftSession.protection.blocked() || leaveIntent || rowAction || batchCapture || (running.current && !editorDraft?.saving)) return;
    generation.current++; setEditorActivation(null); setReadyEditorRead(null); setEditorIntent(null); setOpen(false);
  }
  async function switchEditor(intent: Extract<LeaveIntent, { kind: "switch" }>, current: () => boolean) {
    const retained = draftSession.current();
    const unchanged = () => current() && draftSession.current()?.editSeq === retained?.editSeq
      && draftSession.current()?.text === retained?.text;
    if (intent.after !== undefined) await loadList(intent.after, appliedQuery, unchanged);
    if (unchanged()) await openEditor(intent.target, current);
    else if (current()) setFailure("navigation-edited");
  }
  function resolveLeave(discard: boolean) {
    const intent = leaveIntent;
    if (discard && (intent?.kind === "project" || intent?.kind === "import-project") && leaveProof.current && !leaveProof.current()) { setFailure("navigation-edited"); leaveResolver.current?.(false); leaveResolver.current = null; leaveProof.current = null; setLeaveIntent(null); return; }
    setLeaveIntent(null);
    if (!discard) { leaveResolver.current?.(false); leaveResolver.current = null; leaveProof.current = null; return; }
    if (intent?.kind === "import-project" && !importSession.resetPlugin()) return;
    setHistoryIntent(null); setEditorIntent(null); setEditorTarget(null); draftSession.clear();
    if (intent?.kind === "project" || intent?.kind === "import-project") { leaveResolver.current?.(true); leaveResolver.current = null; leaveProof.current = null; }
    if (intent?.kind === "close") setOpen(false);
    if (intent?.kind === "switch") void performRead(current => switchEditor(intent, current));
  }
  async function saveAndLeave(current: () => boolean) {
    if (!targetAvailable) return;
    if (leaveProof.current && !leaveProof.current()) { setFailure("navigation-edited"); return; }
    const intent = leaveIntent;
    const result = await saveDraft(current);
    if (!result.savedCurrent) return;
    if (!current() || (leaveProof.current && !leaveProof.current())) return;
    if (!currentLocale(targetLocale)) {
      setLeaveIntent(null);
      leaveResolver.current?.(false); leaveResolver.current = null; leaveProof.current = null;
      return;
    }
    if (!draftSession.unchanged(result.submittedSeq, result.submittedText)) return;
    setLeaveIntent(null);
    if (intent?.kind === "project" || intent?.kind === "import-project") { leaveResolver.current?.(true); leaveResolver.current = null; leaveProof.current = null; }
    if (intent?.kind === "close") setOpen(false);
    if (intent?.kind === "switch") await switchEditor(intent, current);
  }
  return <>
    <Dialog.Root open={selectionAction !== null} onOpenChange={value => { if (!value) setSelectionAction(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop" /><Dialog.Content className="confirm-dialog execution-confirm-dialog">
      <Dialog.Title>{t(selectionAction?.kind === "ai" ? "workbench.prepareSelectedAi" : "workbench.confirmContentSelection")}</Dialog.Title>
      <Dialog.Description>{selectionAction ? t("workbench.fixedContentRange", { count: contentSelectionIds(selectionAction.value).length,
        excluded: String(selectionAction.value.excluded.length), locale: selectionAction.value.capture.locale,
        query: selectionAction.value.capture.query || t("workbench.allEntries") }) : ""}</Dialog.Description>
      <p>{selectionAction?.kind === "ai" ? t("workbench.replaceAiSelection", { count: selectionAction.previousCount, locale: selectionAction.previousLocale })
        : t("workbench.replaceContentSelection", { count: selectedIds.size })}</p>
      {!selectionConfirmationCurrent() ? <p role="alert">{t("workbench.contentConfirmationChanged")}</p> : null}
      <div className="form-actions"><button className="secondary-button" onClick={() => setSelectionAction(null)}>{t("translation.stay")}</button>
        <button className="primary-button" disabled={!selectionConfirmationCurrent()} onClick={() => {
          if (!selectionConfirmationCurrent() || !selectionAction) return;
          if (selectionAction.kind === "ai") void confirmSelectedAi(); else chooseContentSelection(selectionAction.value);
        }}>{t(selectionAction?.kind === "ai" ? "workbench.openAiPreparation" : "workbench.confirmContentSelection")}</button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    {open ? <WorkbenchPanel open={open} title={t("translation.title")} description={t("translation.description")} className="source-dialog translation-workbench" onBack={requestClose} backDisabled={disabled || composing || protectionBlocked || (localBusy && !editorDraft?.saving)}>
        <div className="execution-content" aria-busy={busy}>
          {failure ? <div role="alert"><p>{t(`translation.errors.${errorKey(failure)}`)}</p><CommandFailureDetails failure={effectiveFailureValue} />{typeof effectiveFailureValue === "string" ? <details><summary>{t("execution.diagnostic")}</summary><code>{failure}</code></details> : null}</div> : null}
          {saveReceiptCheck ? <p role="status">{t(editorDraft?.receiptKind === "selection" ? saveReceiptCheck === "found" ? "translation.selectionActionFound" : "translation.selectionActionMissing" : saveReceiptCheck === "found" ? "translation.savedActionFound" : "translation.savedActionMissing")}</p> : null}
          {targetUnavailable ? <div role="alert"><p>{t(editorDraft ? "translation.removedTargetDraft" : "translation.removedTargetImport", { locale: targetLocale })}</p><button className="secondary-button" type="button" disabled={localBusy && !editorDraft?.saving} onClick={() => setOpen(false)}>{t("translation.returnToSettings")}</button></div> : null}
          {busy ? <p role="status">{t("execution.working")}</p> : null}
          {sourceRead.isFetching || contentRead.isFetching ? <p role="status">{t("execution.loading")}</p> : null}
          {sourceMissing ? <p role="status">{t("translation.noSource")}</p> : null}
          {sourceRead.error || contentRead.error ? <button className="secondary-button" disabled={busy || readBusy || composing || protectionBlocked || !targetAvailable} onClick={() => void performRead(refreshSource)}>{t("execution.refresh")}</button> : null}
          {!project.metadata.targetLocales.length ? <p role="status">{t("translation.noTargets")}</p> : null}
          <div className="execution-actions"><button className="secondary-button" aria-current={tab === "import" ? "page" : undefined} onClick={() => setTab("import")}>{t("translation.importTab")}</button><button className="secondary-button" aria-current={tab === "edit" ? "page" : undefined} onClick={() => setTab("edit")}>{t("translation.editTab")}</button></div>
          {sourcePage && (project.metadata.targetLocales.length || targetUnavailable) ? <label>{t("translation.target")}<select value={targetLocale} disabled={busy || dirty || !!pendingSave || !!pendingSelection || protectionBlocked || importSession.hasPending() || importSession.hasActive()} onChange={event => changeTarget(event.target.value)}>{targetUnavailable ? <option value={targetLocale} disabled>{t("translation.removedTargetOption", { locale: targetLocale })}</option> : null}{project.metadata.targetLocales.map(locale => <option key={locale} value={locale}>{locale}</option>)}</select></label> : null}
          {tab === "import" && targetLocale ? <>
            <PluginTranslationControls project={project} open={open && tab === "import"} targetLocale={targetLocale} disabled={disabled || localBusy || !!leaveIntent || !!pendingSave || !!pendingSelection || dirty} onOpenExtensions={onOpenExtensions} />
            {preview ? <section><h3>{t("translation.preview")}</h3><p>{t("translation.counts", { unique: String(preview.unique), unmatched: String(preview.unmatched), conflicts: String(preview.selectedConflicts), changed: String(preview.sourceChanged) })}</p><p>{preview.logicalPath} · {preview.targetLocale}</p>{preview.sourceChanged ? <p role="alert">{t("translation.sourceChanged")}</p> : null}
              {preview.total === 0 ? <p role="status">{t("translationPlugin.emptyFile")}</p> : <div className="source-table-scroll"><table className="source-table"><caption>{t("translation.page", { first: String((preview.rows[0]?.entry.ordinal ?? 0) + 1), last: String((preview.rows.at(-1)?.entry.ordinal ?? -1) + 1), total: String(preview.total) })}</caption><thead><tr><th scope="col">{t("translation.key")}</th><th scope="col">{t("translation.sourceText")}</th><th scope="col">{t("translation.importedText")}</th><th scope="col">{t("translation.selectedText")}</th><th scope="col">{t("translation.match")}</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.entry.ordinal}><th scope="row">{row.entry.nativeKey}<details><summary>{t("translation.evidence")}</summary><p>{preview.logicalPath} · {row.entry.valueByteRange[0]}–{row.entry.valueByteRange[1]}</p><code>{preview.fileDigest}</code></details></th><td><pre>{row.sourceText === "" ? t("translation.empty") : row.sourceText}</pre></td><td><pre>{row.entry.text === "" ? t("translation.empty") : row.entry.text}</pre></td><td><pre>{row.currentText === "" ? t("translation.empty") : row.currentText}</pre></td><td>{t(`translation.status.${row.status}`)}{row.status === "unique" || row.status === "selected-conflict" ? <div className="translation-row-actions"><button className="text-button" disabled={!importRowAvailability(importRowPayload(row,"candidate-only")).enabled} onClick={() => {const payload=importRowPayload(row,"candidate-only");if(payload)commandRegistry.dispatch("translation.choose-import-row",commandScope,payload);}}>{t("translation.addCandidate")}</button><button className="text-button" disabled={!importRowAvailability(importRowPayload(row,row.status === "unique" ? "select-if-empty" : "replace")).enabled} onClick={() => {const payload=importRowPayload(row,row.status === "unique" ? "select-if-empty" : "replace");if(payload)commandRegistry.dispatch("translation.choose-import-row",commandScope,payload);}}>{t(row.status === "unique" ? "translation.selectImported" : "translation.replaceSelected")}</button></div> : null}{targetFromTranslation(row) ? <button className="text-button" disabled={busy || readBusy || composing || protectionBlocked || !targetAvailable} onClick={() => chooseEditor(targetFromTranslation(row)!)}>{t("translation.openEditor")}</button> : null}</td></tr>)}</tbody></table></div>}
              <div className="execution-actions"><button className="secondary-button" disabled={busy} onClick={() => void importSession.page(0, true)}>{t("translation.refreshPreview")}</button>{preview.nextOrdinal !== null ? <button className="secondary-button" disabled={busy} onClick={() => void importSession.page(preview.nextOrdinal!)}>{t("execution.nextPage")}</button> : null}</div>
              {importState.stale ? <p role="alert">{t("translation.previewStale")}</p> : null}
              <p>{t("translation.applyHelp")}</p><label className="source-check"><input type="checkbox" checked={selectIfEmpty} disabled={busy} onChange={event => importSession.setStrategy(event.target.checked)} />{t("translation.selectIfEmpty")}</label>
              <button className="primary-button" disabled={!importPreviewAvailability(importPreviewPayload()).enabled} onClick={() => {const payload=importPreviewPayload();if(payload)commandRegistry.dispatch("translation.capture-import-batch",commandScope,payload);}}>{t("translation.apply", { count: preview.unique })}</button>
              {batchProgress ? <p role="status">{t("translation.applying", { done: String(batchProgress.done), total: String(batchProgress.total) })}</p> : null}
              {batchOutcome ? <><p role="status">{t("translation.outcome", { applied: String(batchOutcome.applied), conflicted: String(batchOutcome.conflicted), failed: String(batchOutcome.failed), unknown: String(batchOutcome.unknown) })}</p><details><summary>{t("translation.batchDetails")}</summary><ul>{batchDetails.map((item, index) => <li key={`${item.key}:${index}`}>{item.key}: {t(`translation.batchStatus.${item.status}`)}</li>)}</ul></details></> : null}
              {uncertain.map(pending => <div key={pending.request.actionId} role="status"><p>{pending.key}</p><button className="secondary-button" disabled={!importPendingAvailability(importPendingPayload(pending.request.actionId)).enabled} onClick={() => {const payload=importPendingPayload(pending.request.actionId);if(payload)commandRegistry.dispatch("translation.check-import-receipt",commandScope,payload);}}>{t("translation.checkReceipt")}</button><button className="secondary-button" disabled={!importPendingAvailability(importPendingPayload(pending.request.actionId),true).enabled} onClick={() => {const payload=importPendingPayload(pending.request.actionId);if(payload)commandRegistry.dispatch("translation.retry-import-action",commandScope,payload);}}>{t("translation.retryAction")}</button></div>)}
              {receiptMessage ? <p role="status">{t(receiptMessage === "found" ? "translation.receiptFound" : "translation.receiptMissing")}</p> : null}
            </section> : null}
          </> : null}
          {tab === "edit" && targetLocale ? <section className="translation-workspace" aria-label={t("translation.editor")}>
            <form className="translation-search" onSubmit={event => { event.preventDefault(); if (!busy && !readBusy && targetAvailable) void performRead(current => loadList(0, query.trim(), current, true)); }}>
              <input aria-label={t("workbench.search")} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("workbench.search")} aria-invalid={failure === "query-limit" || undefined} />
              <button className="secondary-button" type="submit" disabled={busy || readBusy || composing || protectionBlocked || !targetAvailable}>{t("workbench.searchAction")}</button>
              <span role="status">{listRead.error ? t("translation.errors.failed") : list ? t("workbench.results", { count: list.total }) : t("execution.loading")}</span>
            </form>
            <div className="content-selection-toolbar" role="group" aria-label={t("workbench.contentSelection")}>
              <span role="status">{contentSelection ? t("workbench.fixedContentRange", { count: selectedIds.size, excluded: String(contentSelection.excluded.length),
                locale: contentSelection.capture.locale, query: contentSelection.capture.query || t("workbench.allEntries") }) : t("workbench.noContentSelection")}</span>
              <div className="execution-actions"><button className="secondary-button" disabled={!selectionGate().enabled || !list?.total}
                onClick={() => commandRegistry.dispatch("translation.capture-content-selection", commandScope)}>{t("workbench.selectAllMatching")}</button>
                <button className="text-button" disabled={!contentSelection || !!selectionAction || disabled}
                  onClick={() => commandRegistry.dispatch("translation.clear-content-selection", commandScope)}>{t("workbench.clearContentSelection")}</button>
                {onPrepareSelection ? <button className="secondary-button" disabled={!prepareSelectionAvailability().enabled}
                  onClick={() => commandRegistry.dispatch("translation.prepare-selected-ai", commandScope)}>{t("workbench.prepareSelectedAi")}</button> : null}</div>
              {contentSelection && !selectionSourceCurrent(contentSelection) ? <p role="status">{t("workbench.contentSelectionChanged")}</p> : null}
              {selectedIds.size > 100 ? <p role="status">{t("workbench.contentSelectionAiLimit")}</p> : null}
              {onPrepareSelection && !aiSelection?.available ? <p role="status">{t("workbench.contentSelectionAiBusy")}</p> : null}
            </div>
            <div className="translation-columns">
              <div className="translation-entry-list" aria-label={t("translation.chooseUnit")}>
                <ul ref={entryList}>{list?.rows.map(row => <li className="content-selection-row" key={row.unitId}>
                  <input type="checkbox" aria-label={t("workbench.selectEntry", { key: row.nativeKey })} checked={contentSelection?.capture.locale === targetLocale && selectedIds.has(row.unitId)}
                    disabled={!contentRowAvailability(contentRowPayload(row, !selectedIds.has(row.unitId))).enabled}
                    title={contentSelection && !selectionMembers.has(row.unitId) ? t("workbench.outsideContentSelection") : undefined}
                    onChange={event => { const payload = contentRowPayload(row, event.target.checked); if (payload) commandRegistry.dispatch("translation.toggle-content-selection", commandScope, payload); }} />
                  <button className="translation-entry" aria-label={row.nativeKey}
                  aria-current={displayedTarget?.unitId === row.unitId ? "true" : undefined} disabled={busy || readBusy || composing || protectionBlocked || !targetAvailable} onClick={() => chooseEditor(listTarget(row))}>
                  <strong>{row.nativeKey}</strong><span className="entry-source">{row.sourcePreview || t("translation.empty")}</span>
                  <span className="entry-translation">{row.translationPreview === null ? t("workbench.unselected") : row.translationPreview || t("translation.empty")}</span>
                  <span className="entry-status">{row.selectionId ? t("workbench.selected") : t("workbench.unselected")} · {reviewState(row)} · {qaState(row)}</span>
                </button></li>)}</ul>
                {list?.rows.length === 0 ? <p>{t("translation.noUnit")}</p> : null}
                <div className="entry-pagination"><button className="text-button" disabled={busy || readBusy || !targetAvailable || listAfter === 0} onClick={() => void performRead(current => loadList(0, appliedQuery, current))}>{t("execution.firstPage")}</button>
                {list?.nextOrdinal != null ? <button className="text-button" disabled={busy || readBusy || composing || protectionBlocked || !targetAvailable} onClick={() => void performRead(current => loadList(list.nextOrdinal!, appliedQuery, current))}>{t("execution.nextPage")}</button> : null}</div>
              </div>
              {editorDraft && displayedTarget ? <div className="translation-detail">
                <div className="translation-editor">
                  <div className="translation-editor-content">
                  {editorRead.isFetching || historyRead.isFetching ? <p role="status">{t("execution.loading")}</p> : null}
                  <div className="execution-section-heading"><h2>{displayedTarget.key}</h2><span role="status" className="draft-state">{t(editorDraft.saving ? "workbench.saving" : dirty ? "workbench.unsaved" : editorDraft.baseSelectionId ? "workbench.saved" : "workbench.unselected")}</span>
                    <button className="text-button" disabled={busy || readBusy || composing || protectionBlocked || dirty || !!pendingSave || !!pendingSelection || !targetAvailable}
                      onClick={() => void performRead(current => openEditor(displayedTarget, current))}>{t("protection.refreshEntry")}</button></div>
                  <div className="entry-neighbors">{([-1, 1] as const).map(delta => {
                    const index = list?.rows.findIndex(row => row.unitId === displayedTarget.unitId) ?? -1;
                    const boundary = index >= 0 && (delta < 0 ? index === 0 && listAfter === 0
                      : index === (list?.rows.length ?? 0) - 1 && list?.nextOrdinal === null);
                    return <button key={delta} type="button" className="text-button"
                      disabled={busy || readBusy || !targetAvailable || !!pendingSave || !confirmedList() || readyEditorRead !== editorIntent?.id || !editorTarget || !history || !list?.total || editorRead.isFetching || listRead.isFetching || !!editorRead.error || !!listRead.error || boundary}
                      onClick={() => void performRead(current => navigateEntry(delta, current))}>
                      {t(delta < 0 ? "workbench.previousEntry" : "workbench.nextEntry")}
                    </button>;
                  })}</div>
                  {navigationEnd ? <p role="status">{t("workbench.scopeEnd")}</p> : null}
                  <section className="editor-source"><h3>{t("translation.sourceText")}</h3><pre>{displayedTarget.sourceText || t("translation.empty")}</pre></section>
                  {onQueryText ? <div className="execution-actions"><p>{t("toolQuery.editorHelp")}</p><button className="text-button" disabled={busy || readBusy || composing || protectionBlocked || !!pendingSave || !!pendingSelection} onClick={() => { void queryEditorText(displayedTarget.sourceText); }}>{t("toolQuery.querySource")}</button>
                    <button className="text-button" disabled={busy || readBusy || composing || protectionBlocked || !!pendingSave || !!pendingSelection || !hasDraftSelection} onClick={() => {
                      const input = draftField.current; if (input && input.selectionStart < input.selectionEnd) void queryEditorText(input.value.slice(input.selectionStart, input.selectionEnd));
                    }}>{t("toolQuery.querySelection")}</button></div> : null}
                  {queryUnavailable ? <p role="status">{t("toolQuery.editorUnavailable")}</p> : null}
                  <details className="selected-translation"><summary>{t("translation.current")}</summary><pre>{editorDraft?.baseSelectionId ? editorDraft.baseText || t("translation.empty") : t("translation.noSelection")}</pre></details>
                  <WorkProtectionControl session={draftSession.protection} context={context} target={displayedTarget} locale={targetLocale}
                    selectionId={editorDraft.baseSelectionId} selectionText={editorDraft.baseText} open={open && tab === "edit"} disabled={disabled || !!pendingSave || !!pendingSelection}
                    draftBlocked={dirty || !!pendingSave || !!pendingSelection} run={perform} onBlockedChange={() => {}}
                    onEditingReadyChange={(scope, ready) => setEditingReady(before => before?.scope === scope && before.ready === ready ? before : { scope, ready })} />
                  <label>{t("translation.draft")}<textarea ref={draftField} value={draft}
                    readOnly={protectionBlocked || editingReady?.scope !== editingProtectionScope(context, displayedTarget, targetLocale) || !editingReady.ready}
                    onCompositionStart={event => {
                      setComposing(true);
                      // Composition is newer input even before its first text
                      // change. A pending immutable selection cannot replace it.
                      if (!event.currentTarget.readOnly) draftSession.edit(event.currentTarget.value);
                    }} onCompositionEnd={() => setComposing(false)}
                    onSelect={event => setHasDraftSelection(event.currentTarget.selectionStart < event.currentTarget.selectionEnd)}
                    onChange={event => draftSession.edit(event.target.value)} /></label>
                  </div>
                  <div className="editor-save-bar"><p>{t("translation.draftHelp")}</p><div className="execution-actions"><button className="primary-button" disabled={pendingSave ? !retryAvailability().enabled : !saveAvailability().enabled} onClick={() => commandRegistry.dispatch(pendingSave ? "translation.retry-save" : "translation.save", commandScope)}>{pendingSave ? t("translation.retryAction") : t("translation.save")}</button>{pendingSave ? <button className="secondary-button" disabled={!reconcileAvailability().enabled} onClick={() => commandRegistry.dispatch("translation.reconcile-save", commandScope)}>{t("translation.checkSavedAction")}</button> : null}<button className="secondary-button" disabled={!saveAndNextAvailability().enabled} onClick={() => commandRegistry.dispatch("translation.save-and-next", commandScope)}>{t("workbench.saveAndNext")}</button><button className="text-button" disabled={busy || !dirty || !!pendingSave || !!pendingSelection} onClick={() => draftSession.revert()}>{t("translation.discardDraft")}</button></div>
                  {pendingSelection ? <div role="status"><p>{t("translation.selectionUnknown")}</p><button className="secondary-button" disabled={!selectionPendingAvailability(selectionPendingPayload()).enabled} onClick={() => {const payload=selectionPendingPayload();if(payload)commandRegistry.dispatch("translation.check-selection",commandScope,payload);}}>{t("translation.checkSelection")}</button><button className="secondary-button" disabled={!selectionPendingAvailability(selectionPendingPayload(),true).enabled} onClick={() => {const payload=selectionPendingPayload();if(payload)commandRegistry.dispatch("translation.retry-selection",commandScope,payload);}}>{t("translation.retrySelection")}</button></div> : null}
                  {newerDraftSaved ? <p role="status">{t("translation.savedNewerDraft")}</p> : null}
                  </div>
                </div>
                <details className="editor-references" open={referencesOpen} onToggle={event => setReferencesOpen(event.currentTarget.open)}><summary>{t("workbench.references")}</summary>
              <section aria-label={t("resource.editorReference")}><h5>{t("resource.editorReference")}</h5><p>{t("resource.editorReferenceHelp")}</p>
                {editorRead.error ? <p role="status">{t("resource.editorLoadFailed")}</p> : null}
                {editorResources?.terms ? <><h6>{t("resource.applicableTerms")}</h6>{editorResources.terms.entries.length ? <ul>{editorResources.terms.entries.map(entry => <li key={entry.source}>{entry.source}: {entry.selected ? <>{entry.selected.target} · {entry.selected.originKind === "manual" ? t("resource.manual") : t("resource.external")} · {entry.selected.reason}</> : t("resource.conflict")}</li>)}</ul> : <p>{t("resource.noApplicableTerms")}</p>}</> : null}
                {editorResources ? <><h6>{t("resource.manualContext")}</h6>{editorResources.context ? <p>{editorResources.context.text} · {editorResources.context.reason}</p> : <p>{t("resource.noManualContext")}</p>}</> : null}
              </section>
              <EditorMemoryReferences context={context} target={displayedTarget} locale={targetLocale} draftText={draft}
                enabled={referencesOpen && open && tab === "edit" && targetAvailable && !!snapshot && snapshot.target.sourceRevisionId === displayedTarget.sourceRevisionId
                  && readyEditorRead === editorIntent?.id && checkedRead(editorKey(editorIntent), snapshot)} />
              <EditorSourceContext context={context} enabled={referencesOpen && open && tab === "edit" && targetAvailable}
                sourceChanged={retainedSourceChanged || !!snapshot && !!editorDraft && snapshot.target.unitId === editorDraft.unitId
                  && snapshot.target.locale === editorDraft.locale && snapshot.target.sourceRevisionId !== editorDraft.sourceRevisionId}
                scope={snapshot && editorDraft && editorIntent && readyEditorRead === editorIntent.id
                  && snapshot.target.unitId === displayedTarget.unitId && snapshot.target.sourceRevisionId === displayedTarget.sourceRevisionId
                  && snapshot.target.unitId === editorDraft.unitId && snapshot.target.locale === editorDraft.locale
                  && editorDraft.locale === targetLocale && snapshot.target.sourceRevisionId === editorDraft.sourceRevisionId
                  && checkedRead(editorKey(editorIntent), snapshot)
                  ? { projectId: context.projectId, sourceSnapshotId: snapshot.target.sourceSnapshotId,
                      unitId: snapshot.target.unitId, sourceRevisionId: snapshot.target.sourceRevisionId, locale: snapshot.target.locale }
                  : null} />
              <section aria-label={t("translation.history")}><div className="execution-section-heading"><h4>{t("translation.history")}</h4><button className="text-button" disabled={busy || readBusy || !targetAvailable || !!pendingSave || !editorTarget} onClick={() => void performRead(refreshHistory)}>{t("translation.refreshHistory")}</button></div>{historyRead.error && historyIntent ? <button className="secondary-button" disabled={busy || readBusy || composing || protectionBlocked || !targetAvailable} onClick={() => void performRead(current => loadHistory(historyIntent.after, current))}>{t("execution.refresh")}</button> : null}{historyStale ? <p role="status">{t("translation.historyStale")}</p> : null}{history?.rows.length ? <ul>{history.rows.map(revision => <li key={revision.revisionId}><p>{revision.ordinal}: {revision.text === "" ? t("translation.empty") : revision.text}</p><p>{revision.originKind === "import" ? t("translation.importOrigin", { file: revision.logicalPath ?? "" }) : revision.originKind === "ai" ? t("ai.origin") : t("translation.manualOrigin")}</p>{revision.originKind === "import" ? <details><summary>{t("translation.evidence")}</summary><p>{t("translation.key")}: {revision.nativeKey}</p><p>{t("translation.file")}: {revision.logicalPath}</p><code>{revision.fileDigest}</code></details> : null}<button className="secondary-button" disabled={!revisionAvailability(revisionPayload(revision)).enabled} onClick={() => {const payload=revisionPayload(revision);if(payload)commandRegistry.dispatch("translation.select-revision",commandScope,payload);}}>{t("translation.selectRevision")}</button></li>)}</ul> : historyStale ? null : <p>{t("translation.noHistory")}</p>}
              {history ? <div className="execution-actions"><button className="secondary-button" disabled={busy || readBusy || !targetAvailable || historyRead.isFetching || history.rows[0]?.ordinal === "1"} onClick={() => void performRead(current => loadHistory(translationHistoryAfter(history.rows[0]?.ordinal ?? "1", 101), current))}>{t("translation.earlier")}</button>{history.nextOrdinal !== null ? <button className="secondary-button" disabled={busy || readBusy || !targetAvailable || historyRead.isFetching} onClick={() => void performRead(current => loadHistory(history.nextOrdinal!, current))}>{t("translation.later")}</button> : null}</div> : null}</section>
                </details>
              </div> : <div className="editor-empty"><h2>{t("workbench.chooseEntry")}</h2><p>{t("workbench.chooseEntryHelp")}</p></div>}
            </div>
          </section> : null}
        </div>
      </WorkbenchPanel> : null}
    <Dialog.Root open={batchCapture !== null} onOpenChange={value => { if (!value && !importState.busy) importSession.cancelConfirmation(); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop" /><Dialog.Content className="confirm-dialog execution-confirm-dialog" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (importState.busy) event.preventDefault(); }}><Dialog.Title>{t("translation.batchConfirm")}</Dialog.Title><Dialog.Description>{t("translation.batchScope", { total: String(batchCapture?.preview.total ?? 0), matches: String(batchCapture?.eligible.length ?? 0), excluded: String(batchCapture?.excluded ?? 0) })}</Dialog.Description><p>{t(batchCapture?.decision === "select-if-empty" ? "translation.batchSelect" : "translation.batchCandidates")}</p>{importState.stale ? <p role="alert">{t("translation.previewStale")}</p> : null}{failure ? <p role="alert">{t(`translation.errors.${errorKey(failure)}`)}</p> : null}<div className="form-actions"><button className="secondary-button" disabled={importState.busy} onClick={() => importSession.cancelConfirmation()}>{t("execution.back")}</button><button className="primary-button" disabled={!importBatchAvailability(importBatchPayload()).enabled} onClick={() => {const payload=importBatchPayload();if(payload)commandRegistry.dispatch("translation.apply-import-batch",commandScope,payload);}}>{t("translation.batchStart")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={rowAction !== null} onOpenChange={value => { if (!value && !busy) importSession.cancelConfirmation(); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop" /><Dialog.Content className="confirm-dialog execution-confirm-dialog" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}><Dialog.Title>{t(rowAction?.decision === "replace" ? "translation.replaceSelected" : rowAction?.decision === "select-if-empty" ? "translation.selectImported" : "translation.addCandidate")}</Dialog.Title><Dialog.Description>{t("translation.rowActionHelp", { key: rowAction?.row.entry.nativeKey ?? "" })}</Dialog.Description>{rowAction ? <div className="translation-action-compare"><p>{t("translation.importedText")}: {rowAction.row.entry.text === "" ? t("translation.empty") : rowAction.row.entry.text}</p><p>{t("translation.selectedText")}: {rowAction.row.currentText === null ? t("translation.noSelection") : rowAction.row.currentText === "" ? t("translation.empty") : rowAction.row.currentText}</p></div> : null}{targetUnavailable ? <p role="alert">{t("translation.removedTargetImport", { locale: targetLocale })}</p> : null}{importState.stale ? <p role="alert">{t("translation.previewStale")}</p> : null}{failure ? <p role="alert">{t(`translation.errors.${errorKey(failure)}`)}</p> : null}<div className="form-actions"><button className="secondary-button" disabled={busy} onClick={() => importSession.cancelConfirmation()}>{t("execution.back")}</button><button className="primary-button" disabled={!importRowAvailability(rowAction ? importRowPayload(rowAction.row,rowAction.decision,rowAction.preview,rowAction.editSeq) : undefined,true).enabled} onClick={() => {const capture=importSession.current().rowAction;const payload=capture ? importRowPayload(capture.row,capture.decision,capture.preview,capture.editSeq) : undefined;if(payload)commandRegistry.dispatch("translation.apply-import-row",commandScope,payload);}}>{t(rowAction?.decision === "replace" ? "translation.replaceSelected" : rowAction?.decision === "select-if-empty" ? "translation.selectImported" : "translation.addCandidate")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={leaveIntent !== null} onOpenChange={value => { if (!value && !busy) resolveLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onCloseAutoFocus={event => { if (open && tab === "edit" && mounted.current && draftField.current) { event.preventDefault(); draftField.current.focus({ preventScroll: true }); } }} onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}><Dialog.Title>{t(leaveIntent?.kind === "import-project" ? "translationPlugin.leaveTitle" : "translation.leaveTitle")}</Dialog.Title><Dialog.Description>{t(leaveIntent?.kind === "import-project" ? "translationPlugin.leaveHelp" : "translation.leaveHelp")}</Dialog.Description>{targetUnavailable ? <p role="alert">{t("translation.removedTargetDraft", { locale: targetLocale })}</p> : null}{failure ? <p role="alert">{t(`translation.errors.${errorKey(failure)}`)}</p> : null}{newerDraftSaved ? <p role="status">{t("translation.savedNewerDraft")}</p> : null}<div className="form-actions"><button className="secondary-button" disabled={busy} onClick={() => resolveLeave(false)}>{t("translation.stay")}</button><button className="secondary-button" disabled={busy || !!pendingSave || !!pendingSelection} onClick={() => resolveLeave(true)}>{t("translation.discard")}</button><button className="primary-button" disabled={busy || composing || protectionBlocked || !editingReady?.ready || !targetAvailable || leaveIntent?.kind === "import-project"} onClick={() => void perform(saveAndLeave)}>{pendingSave ? t("translation.retryAction") : t("translation.saveAndContinue")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
