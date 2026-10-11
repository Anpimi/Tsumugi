import { useSessionQuery } from "./SessionReadProvider";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { reviewCommands, type ReviewSummaryPage, type ReviewSummary, type ReviewTarget } from "./reviewCommands";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { CommandError, ProjectView } from "./projectCommands";
import { executionCommands as execution, executionContext } from "./executionCommands";
import { sourceCommands, type ContentPage, type ContentRow } from "./sourceCommands";
import { translationCommands as commands, translationHistoryAfter, type TranslationHistory, type TranslationPreview, type TranslationPreviewRow } from "./translationCommands";
import { useTranslationImportSession } from "./TranslationImportSession";
import { type ContextRevision, type TermResolution } from "./resourceCommands";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useWorkbenchCommands } from "./workbenchCommands";

export interface EditorTarget { unitId: string; sourceRevisionId: string; key: string; sourceText: string }
type LeaveIntent = { kind: "close" } | { kind: "project" } | { kind: "switch"; target: EditorTarget; after?: number };
export interface TranslationHandle {
  showAttempt: (id: string) => void;
  openUnit: (target: EditorTarget, locale: string, suggestedText?: string) => boolean;
  allowLeave: () => Promise<boolean>;
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

export function TranslationWorkbench({ project, disabled, ref }: { project: ProjectView; disabled: boolean; ref?: Ref<TranslationHandle> }) {
  const { t } = useTranslation();
  const context = executionContext(project);
  const draftSession = useTranslationDraftSession();
  const importSession = useTranslationImportSession();
  const importState = importSession.state;
  const commandRegistry = useWorkbenchCommands();
  const editorDraft = draftSession.draft;
  const [open, setOpen] = useWorkbenchView("translation");
  const [tab, setTab] = useState<"import" | "edit">(importState.attempt || importState.folder || importState.pendingStart || importState.uncertain.length ? "import" : "edit");
  const [sourcePage, setSourcePage] = useState<ContentPage | null>(null);
  const [sourceMissing, setSourceMissing] = useState(false);
  const [list, setList] = useState<ReviewSummaryPage | null>(null);
  const listScope = useRef<{ id: string; locale: string; query: string } | null>(null);
  const [navigationEnd, setNavigationEnd] = useState(false);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [listAfter, setListAfter] = useState(0);
  const listBasis = useRef<string | null>(null);
  const listPosition = useRef({ query: "", after: 0 });
  const [targetLocale, setTargetLocale] = useState(editorDraft?.locale ?? importState.targetLocale);
  const { folder, fileName, preflight, confirmed, pendingStart, attempt, preview, selectIfEmpty,
    batchProgress, batchOutcome, batchDetails, uncertain, receiptMessage, rowAction, batchCapture } = importState;
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [history, setHistory] = useState<TranslationHistory | null>(null);
  const [historyStale, setHistoryStale] = useState(false);
  const [editorResources, setEditorResources] = useState<{ terms: TermResolution | null; context: ContextRevision | null; failed: boolean } | null>(null);
  const [localBusy, setBusy] = useState(false);
  const [failureValue, setFailure] = useState<CommandFailure | null>(null);
  const effectiveFailureValue = editorDraft?.failure ?? importState.failure ?? failureValue;
  const failure = failureReason(effectiveFailureValue);
  const [leaveIntent, setLeaveIntent] = useState<LeaveIntent | null>(null);
  const leaveResolver = useRef<((value: boolean) => void) | null>(null);
  const mounted = useRef(false);
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
  useLayoutEffect(() => { saveNextViewEpoch.current++; }, [open, tab, targetLocale, targetAvailable]);
  const canRebaseTarget = !dirty && !busy && !pendingSave && !pendingSelection && !pendingStart && !attempt
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
  useEffect(() => {
    if (!open || !targetAvailable) return;
    const locale = targetLocale;
    const ticket = ++sourceLoad.current;
    void (async () => {
      try {
        const scope = await sourceCommands.scope(context);
        if (!currentLocale(locale)) return;
        const page = scope.currentSnapshot
          ? await sourceCommands.content({ ...context, snapshotId: scope.currentSnapshot, after: 0, limit: 1 }) : null;
        if (!currentLocale(locale)) return;
        const changed = listBasis.current !== scope.currentSnapshot;
        const position = changed ? { query: "", after: 0 } : listPosition.current;
        const retained = changed ? null : listScope.current;
        const next = page ? await reviewCommands.summaryPage({ ...context, locale,
          query: position.query, afterOrdinal: position.after, limit: 50,
          scopeId: retained?.locale === locale && retained.query === position.query ? retained.id : null }) : null;
        if (mounted.current && sourceLoad.current === ticket && currentLocale(locale)) {
          setSourceMissing(!page); setSourcePage(page); setList(next);
          listScope.current = next ? { id: next.scopeId, locale, query: position.query } : null;
          if (changed) { setQuery(""); setAppliedQuery(""); setListAfter(0); listPosition.current = position; }
          listBasis.current = scope.currentSnapshot;
          if (page?.namespace === "webvtt:source") setTab("edit");
        }
      } catch (error) { if (mounted.current && sourceLoad.current === ticket && currentLocale(locale)) setFailure(commandFailure(error)); }
    })();
    return () => { sourceLoad.current++; };
  }, [open, targetLocale, targetScope, project.sessionToken]);
  useEffect(() => {
    const retained = draftSession.current();
    if (!open || !targetAvailable || !retained || editorTarget || running.current) return;
    if (targetLocale !== retained.locale) { setTargetLocale(retained.locale); return; }
    void perform(async current => {
      const snapshot = await reviewCommands.editorSnapshot({ ...context, unitId: retained.unitId, locale: retained.locale });
      const latest = draftSession.current();
      if (!current() || !latest || latest.unitId !== retained.unitId || latest.locale !== retained.locale) return;
      setEditorTarget(listTarget(snapshot.target));
      setHistory(snapshot.translations);
      setEditorResources({ terms: snapshot.terms, context: snapshot.context, failed: false });
      setHistoryStale(snapshot.target.sourceRevisionId !== latest.sourceRevisionId
        || (snapshot.translations.current?.eventId ?? null) !== latest.baseSelectionId);
      setTab("edit");
    });
  }, [open, targetLocale, targetScope, editorTarget?.unitId, editorDraft?.unitId, project.sessionToken]);
  useEffect(() => {
    if (!open || !targetAvailable || !editorTarget || dirty || pendingSave || running.current) return;
    const unitId = editorTarget.unitId;
    const retained = draftSession.current();
    void perform(async current => {
      const canRefresh = () => current() && draftSession.current()?.editSeq === retained?.editSeq
        && draftSession.current()?.text === retained?.text;
      if (canRefresh()) await openEditor({ ...editorTarget, unitId }, canRefresh);
    });
  }, [open, targetLocale, project.sessionToken]);
  async function loadList(after: number, search: string, current: () => boolean, fresh = false) {
    const locale = targetLocale;
    if (!currentLocale(locale)) return;
    if (new TextEncoder().encode(search).length > 256) { setFailure("query-limit"); return; }
    const retained = fresh ? null : listScope.current;
    const next = await reviewCommands.summaryPage({ ...context, locale, query: search,
      afterOrdinal: after, limit: 50, scopeId: retained?.locale === locale && retained.query === search ? retained.id : null });
    if (current() && currentLocale(locale)) {
      setList(next); setListAfter(after); setAppliedQuery(search); setNavigationEnd(false);
      listPosition.current = { query: search, after };
      listScope.current = { id: next.scopeId, locale, query: search };
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
      : check.outcome === "cancelled" ? "review.checkCancelled" : check.hasFindings ? "review.findings" : "review.passed");
  }
  useEffect(() => { if (open) heading.current?.focus(); }, [open, tab]);
  useEffect(() => { if (entryList.current) entryList.current.scrollTop = 0; }, [listAfter, appliedQuery, targetLocale]);
  useEffect(() => {
    if (open && tab === "edit") draftField.current?.focus({ preventScroll: true });
  }, [open, tab, editorTarget?.unitId]);
  const commandScope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "translation" as const };
  function saveAvailability() {
    if (!open || tab !== "edit" || disabled || leaveIntent) return { enabled: false, reason: "hidden" as const };
    if (busy || running.current) return { enabled: false, reason: "busy" as const };
    const capture = draftSession.current();
    if (capture?.pending || capture?.pendingSelection || capture?.saving || draftSession.mutationReserved) return { enabled: false, reason: "pending-action" as const };
    if (!targetAvailable || !capture || capture.locale !== targetLocale) return { enabled: false, reason: "unavailable" as const };
    if (capture.text === (capture.baseText ?? "") && !capture.newerDraftSaved) return { enabled: false, reason: "no-changes" as const };
    return { enabled: true };
  }
  function retryAvailability() {
    if (!open || tab !== "edit" || disabled || leaveIntent) return { enabled: false, reason: "hidden" as const };
    if (busy || running.current) return { enabled: false, reason: "busy" as const };
    if (!pendingSave || pendingSelection) return { enabled: false, reason: "unavailable" as const };
    if (!targetAvailable) return { enabled: false, reason: "unavailable" as const };
    return { enabled: true };
  }
  function reconcileAvailability() {
    if (!open || tab !== "edit" || disabled || leaveIntent) return { enabled: false, reason: "hidden" as const };
    if (busy || running.current) return { enabled: false, reason: "busy" as const };
    if (!pendingSave || pendingSelection) return { enabled: false, reason: "unavailable" as const };
    return { enabled: true };
  }
  function saveAndNextAvailability() {
    const capture = draftSession.current();
    const available = capture?.pending ? retryAvailability() : saveAvailability();
    if (!available.enabled) return available;
    const scope = listScope.current;
    if (!capture || capture.locale !== targetLocale || !editorTarget || editorTarget.unitId !== capture.unitId || !list?.total || !scope
      || scope.id !== list.scopeId || scope.locale !== capture.locale || scope.query !== appliedQuery) {
      return { enabled: false, reason: "unavailable" as const };
    }
    return available;
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
    return () => { removeReconcile(); removeRetry(); removeSaveNext(); removeSave(); };
  });
  useImperativeHandle(ref, () => ({
    saveCurrent() {
      commandRegistry.dispatch("translation.save", commandScope);
    },
    showAttempt(id) {
      if (running.current || draftSession.current()?.saving || draftSession.current()?.selecting || dirty || pendingSave || pendingSelection || pendingStart || importState.busy || uncertain.length) { setOpen(true); return; }
      generation.current++;
      setEditorTarget(null); setHistory(null); draftSession.clear();
      if (!importSession.showAttempt(id)) return;
      setTargetLocale(importSession.current().targetLocale); setTab("import"); setFailure(null); setOpen(true);
    },
    openUnit(target, locale, suggestedText) {
      if (!localeAvailable(locale)) {
        setOpen(true); setFailure("target-locale");
        return false;
      }
      if (running.current || draftSession.current()?.saving || draftSession.current()?.selecting || dirty || pendingSave || pendingSelection || pendingStart || importState.busy || uncertain.length) {
        setOpen(true);
        return false;
      }
      if (locale !== targetLocale) changeTarget(locale);
      setOpen(true);
      void perform(current => openEditor(target, current, locale, suggestedText));
      return true;
    },
    allowLeave() {
      if (running.current || importSession.current().busy || draftSession.current()?.saving || draftSession.current()?.selecting) { setOpen(true); return Promise.resolve(false); }
      if (pendingSave || pendingSelection || pendingStart || uncertain.length) { setOpen(true); setFailure("outcome-unknown"); return Promise.resolve(false); }
      if (!dirty) return Promise.resolve(true);
      setOpen(true);
      setLeaveIntent({ kind: "project" });
      return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
    },
    allowNavigate() {
      if (leaveIntent || rowAction || batchCapture || (running.current && !editorDraft?.saving)) return Promise.resolve(false);
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
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  function changeTarget(locale: string) {
    if (locale && !localeAvailable(locale)) return;
    if (!importSession.setTarget(locale)) return;
    selectedLocale.current = locale;
    setTargetLocale(locale);
    setList(null); listScope.current = null; listPosition.current = { query: "", after: 0 };
    setQuery(""); setAppliedQuery(""); setListAfter(0); setNavigationEnd(false);
    if (editorTarget) { setEditorTarget(null); setHistory(null); setEditorResources(null); }
    if (editorDraft) draftSession.clear();
  }
  const filesRead = useSessionQuery<string[]>({ key: ["translation-files", folder?.selectionId ?? null], scopes: [],
    enabled: open && tab === "import" && !!folder,
    read: () => commands.files({ ...context, selectionId: folder!.selectionId }) });
  const files = filesRead.data ?? [];
  useEffect(() => {
    if (!fileName && filesRead.data?.length && importSession.current().folder?.selectionId === folder?.selectionId) importSession.setFile(filesRead.data[0]);
  }, [filesRead.data, folder?.selectionId, fileName, importState.busy]);
  useEffect(() => { if (filesRead.error) setFailure(commandFailure(filesRead.error)); }, [filesRead.error]);
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
  async function openEditor(target: EditorTarget, current: () => boolean, locale = targetLocale, suggestedText?: string) {
    if (!currentLocale(locale)) return;
    const retained = draftSession.current();
    const snapshot = await reviewCommands.editorSnapshot({ ...context, unitId: target.unitId, locale });
    const next = snapshot.translations;
    if (!currentLocale(locale)) return;
    if (current() && (draftSession.current()?.editSeq !== retained?.editSeq
      || draftSession.current()?.text !== retained?.text)) { setFailure("navigation-edited"); return; }
    if (current()) {
      const nextTarget = listTarget(snapshot.target);
      if (!draftSession.begin({ ...nextTarget, locale }, next.current, next.currentText, suggestedText)) {
        setFailure("navigation-edited"); return;
      }
      setEditorTarget(nextTarget); setHistory(next); setNavigationEnd(false);
      setHistoryStale(false);
      setEditorResources({ terms: snapshot.terms, context: snapshot.context, failed: false });
      setTab("edit");
    }
  }
  function chooseEditor(target: EditorTarget) {
    if (!targetAvailable) return;
    if (pendingSave || pendingSelection) { setFailure("outcome-unknown"); return; }
    if (dirty) { setLeaveIntent({ kind: "switch", target }); return; }
    void perform(current => openEditor(target, current));
  }
  async function saveDraft(current: () => boolean) {
    const result = await draftSession.save();
    if (result.saved && current() && currentLocale(targetLocale)) {
      setHistoryStale(true);
      try { await loadList(listAfter, appliedQuery, current); }
      catch { if (current()) setFailure("save-list-refresh"); }
    }
    return result;
  }
  async function checkSavedAction(current: () => boolean) {
    const result = await draftSession.checkSavedAction();
    if (result.saved && current() && currentLocale(targetLocale)) {
      setHistoryStale(true);
      try { await loadList(listAfter, appliedQuery, current); }
      catch { if (current()) setFailure("save-list-refresh"); }
    }
  }
  async function navigateEntry(direction: -1 | 1, current: () => boolean, afterSave = false) {
    const locale = targetLocale;
    if (!editorTarget || !listScope.current || !currentLocale(locale)) return;
    const retained = draftSession.current();
    const unchanged = () => current() && currentLocale(locale)
      && draftSession.current()?.editSeq === retained?.editSeq && draftSession.current()?.text === retained?.text;
    const neighbor = await reviewCommands.neighbor({ ...context, unitId: editorTarget.unitId,
      locale, scopeId: listScope.current.id, direction });
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
  async function selectRevision(revisionId: string, current: () => boolean) {
    const locale = targetLocale, revision = history?.rows.find(value => value.revisionId === revisionId);
    const basis = draftSession.current();
    if (!revision || !basis || !editorTarget || dirty || pendingSave || pendingSelection || !currentLocale(locale)) return;
    const selected = await draftSession.selectRevision(revision, () => current() && currentLocale(locale)
      && editorTarget.unitId === basis.unitId && history?.rows.some(value => value === revision) === true);
    if (!selected || !current() || !currentLocale(locale)) return;
    setHistoryStale(true);
    try { await refreshHistory(current); await loadList(listAfter, appliedQuery, current); }
    catch { if (current()) setFailure("save-list-refresh"); }
  }
  async function checkSelection(current: () => boolean, retry = false) {
    const selected = retry ? await draftSession.retrySelection() : await draftSession.checkSelection();
    if (!selected || !current() || !currentLocale(targetLocale)) return;
    setHistoryStale(true);
    try { await refreshHistory(current); await loadList(listAfter, appliedQuery, current); }
    catch { if (current()) setFailure("save-list-refresh"); }
  }
  async function refreshHistory(current: () => boolean) {
    const locale = targetLocale;
    if (!editorTarget || !currentLocale(locale)) return;
    const first = await commands.history({ ...context, unitId: editorTarget.unitId, locale, afterOrdinal: "0", limit: 1 });
    if (!currentLocale(locale)) return;
    const next = await commands.history({ ...context, unitId: editorTarget.unitId, locale, afterOrdinal: translationHistoryAfter(first.total, 100), limit: 100 });
    if (current() && currentLocale(locale)) { setHistory(next); setHistoryStale(false); }
  }
  function requestClose() {
    if (leaveIntent || rowAction || batchCapture || (running.current && !editorDraft?.saving)) return;
    generation.current++; setOpen(false);
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
    setLeaveIntent(null);
    if (!discard) { leaveResolver.current?.(false); leaveResolver.current = null; return; }
    setHistory(null); setEditorTarget(null); draftSession.clear();
    if (intent?.kind === "project") { leaveResolver.current?.(true); leaveResolver.current = null; }
    if (intent?.kind === "close") setOpen(false);
    if (intent?.kind === "switch") void perform(current => switchEditor(intent, current));
  }
  async function saveAndLeave(current: () => boolean) {
    if (!targetAvailable) return;
    const intent = leaveIntent;
    const result = await saveDraft(current);
    if (!result.savedCurrent) return;
    if (!current()) return;
    if (!currentLocale(targetLocale)) {
      setLeaveIntent(null);
      leaveResolver.current?.(false); leaveResolver.current = null;
      return;
    }
    if (!draftSession.unchanged(result.submittedSeq, result.submittedText)) return;
    setLeaveIntent(null);
    if (intent?.kind === "project") { leaveResolver.current?.(true); leaveResolver.current = null; }
    if (intent?.kind === "close") setOpen(false);
    if (intent?.kind === "switch") await switchEditor(intent, current);
  }
  const canImport = Boolean(sourcePage && targetAvailable && fileName);
  return <>
    {open ? <WorkbenchPanel open={open} title={t("translation.title")} description={t("translation.description")} className="source-dialog translation-workbench" onBack={requestClose} backDisabled={disabled || (localBusy && !editorDraft?.saving)}>
        <div className="execution-content" aria-busy={busy}>
          {failure ? <div role="alert"><p>{t(`translation.errors.${errorKey(failure)}`)}</p><CommandFailureDetails failure={effectiveFailureValue} />{typeof effectiveFailureValue === "string" ? <details><summary>{t("execution.diagnostic")}</summary><code>{failure}</code></details> : null}</div> : null}
          {saveReceiptCheck ? <p role="status">{t(editorDraft?.receiptKind === "selection" ? saveReceiptCheck === "found" ? "translation.selectionActionFound" : "translation.selectionActionMissing" : saveReceiptCheck === "found" ? "translation.savedActionFound" : "translation.savedActionMissing")}</p> : null}
          {targetUnavailable ? <div role="alert"><p>{t(editorDraft ? "translation.removedTargetDraft" : "translation.removedTargetImport", { locale: targetLocale })}</p><button className="secondary-button" type="button" disabled={localBusy && !editorDraft?.saving} onClick={() => setOpen(false)}>{t("translation.returnToSettings")}</button></div> : null}
          {busy ? <p role="status">{t("execution.working")}</p> : null}
          {sourceMissing ? <p role="status">{t("translation.noSource")}</p> : null}
          {!project.metadata.targetLocales.length ? <p role="status">{t("translation.noTargets")}</p> : null}
          <div className="execution-actions">{sourcePage?.namespace !== "webvtt:source" ? <button className="secondary-button" aria-current={tab === "import" ? "page" : undefined} onClick={() => setTab("import")}>{t("translation.importTab")}</button> : null}<button className="secondary-button" aria-current={tab === "edit" ? "page" : undefined} onClick={() => setTab("edit")}>{t("translation.editTab")}</button></div>
          {sourcePage && (project.metadata.targetLocales.length || targetUnavailable) ? <label>{t("translation.target")}<select value={targetLocale} disabled={busy || dirty || !!pendingSave || !!pendingSelection || !!pendingStart || uncertain.length > 0} onChange={event => changeTarget(event.target.value)}>{targetUnavailable ? <option value={targetLocale} disabled>{t("translation.removedTargetOption", { locale: targetLocale })}</option> : null}{project.metadata.targetLocales.map(locale => <option key={locale} value={locale}>{locale}</option>)}</select></label> : null}
          {tab === "import" && targetLocale && ((sourcePage && sourcePage.namespace !== "webvtt:source") || preview || preflight || pendingStart) ? <>
            <section><button className="secondary-button" disabled={busy || !targetAvailable || uncertain.length > 0} onClick={() => void importSession.chooseFolder()}>{t("translation.chooseFolder")}</button>
              {filesRead.error ? <p role="status">{t("translation.filesUnavailable")} <button className="text-button" onClick={() => void filesRead.refetch()}>{t("execution.refresh")}</button></p> : null}
              {folder ? <><p>{t("translation.folder", { name: folder.folderName })}</p>{files.length ? <label>{t("translation.file")}<select value={fileName} disabled={busy || !!pendingStart || uncertain.length > 0} onChange={event => importSession.setFile(event.target.value)}>{fileName && !files.includes(fileName) ? <option value={fileName} disabled>{fileName}</option> : null}{files.map(file => <option key={file} value={file}>{file}</option>)}</select></label> : <p role="status">{t(filesRead.isFetching ? "execution.loading" : filesRead.error ? "translation.filesUnavailable" : "translation.noFiles")}</p>}
                <button className="secondary-button" disabled={busy || !canImport} onClick={() => void importSession.preflight()}>{t("translation.inspect")}</button>
              </> : null}
              {preflight ? <><p>{t("translation.preflight", { count: preflight.count, file: preflight.fileName })}</p><label className="source-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => importSession.confirmLanguage(event.target.checked)} />{t("translation.languageConfirm", { file: preflight.fileName, target: preflight.targetLocale, declared: preflight.declaredLocale })}</label>
                <button className="primary-button" disabled={busy || !targetAvailable || !localeAvailable(preflight.targetLocale) || !confirmed || !!pendingStart || !!attempt} onClick={() => void importSession.start(() => currentLocale(targetLocale))}>{t("translation.start")}</button></> : null}
              {pendingStart ? <div role="status"><p>{t("translation.startUnknown")}</p><button className="secondary-button" disabled={busy} onClick={() => void importSession.retryStart()}>{t("translation.checkStart")}</button></div> : null}
              {attempt && !preview ? <p role="status">{t("translation.progress", { count: preflight?.count ?? 0 })}</p> : null}
            </section>
            {preview ? <section><h3>{t("translation.preview")}</h3><p>{t("translation.counts", { unique: String(preview.unique), unmatched: String(preview.unmatched), conflicts: String(preview.selectedConflicts), changed: String(preview.sourceChanged) })}</p><p>{preview.logicalPath} · {preview.targetLocale}</p>{preview.sourceChanged ? <p role="alert">{t("translation.sourceChanged")}</p> : null}
              <div className="source-table-scroll"><table className="source-table"><caption>{t("translation.page", { first: String((preview.rows[0]?.entry.ordinal ?? 0) + 1), last: String((preview.rows.at(-1)?.entry.ordinal ?? -1) + 1), total: String(preview.total) })}</caption><thead><tr><th scope="col">{t("translation.key")}</th><th scope="col">{t("translation.sourceText")}</th><th scope="col">{t("translation.importedText")}</th><th scope="col">{t("translation.selectedText")}</th><th scope="col">{t("translation.match")}</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.entry.ordinal}><th scope="row">{row.entry.nativeKey}<details><summary>{t("translation.evidence")}</summary><p>{preview.logicalPath} · {row.entry.valueByteRange[0]}–{row.entry.valueByteRange[1]}</p><code>{preview.fileDigest}</code></details></th><td><pre>{row.sourceText === "" ? t("translation.empty") : row.sourceText}</pre></td><td><pre>{row.entry.text === "" ? t("translation.empty") : row.entry.text}</pre></td><td><pre>{row.currentText === "" ? t("translation.empty") : row.currentText}</pre></td><td>{t(`translation.status.${row.status}`)}{row.status === "unique" || row.status === "selected-conflict" ? <div className="translation-row-actions"><button className="text-button" disabled={busy || !targetAvailable || preview.targetLocale !== targetLocale || importState.stale || draftSession.mutationReserved} onClick={() => importSession.chooseRow(row, "candidate-only")}>{t("translation.addCandidate")}</button><button className="text-button" disabled={busy || !targetAvailable || preview.targetLocale !== targetLocale || importState.stale || draftSession.mutationReserved} onClick={() => importSession.chooseRow(row, row.status === "unique" ? "select-if-empty" : "replace")}>{t(row.status === "unique" ? "translation.selectImported" : "translation.replaceSelected")}</button></div> : null}{targetFromTranslation(row) ? <button className="text-button" disabled={busy || !targetAvailable} onClick={() => chooseEditor(targetFromTranslation(row)!)}>{t("translation.openEditor")}</button> : null}</td></tr>)}</tbody></table></div>
              <div className="execution-actions"><button className="secondary-button" disabled={busy} onClick={() => void importSession.page(0, true)}>{t("translation.refreshPreview")}</button>{preview.nextOrdinal !== null ? <button className="secondary-button" disabled={busy} onClick={() => void importSession.page(preview.nextOrdinal!)}>{t("execution.nextPage")}</button> : null}</div>
              {importState.stale ? <p role="alert">{t("translation.previewStale")}</p> : null}
              <p>{t("translation.applyHelp")}</p><label className="source-check"><input type="checkbox" checked={selectIfEmpty} disabled={busy} onChange={event => importSession.setStrategy(event.target.checked)} />{t("translation.selectIfEmpty")}</label>
              <button className="primary-button" disabled={busy || !targetAvailable || preview.targetLocale !== targetLocale || preview.unique === 0 || preview.sourceChanged > 0 || importState.stale || draftSession.mutationReserved} onClick={() => void importSession.captureBatch()}>{t("translation.apply", { count: preview.unique })}</button>
              {batchProgress ? <p role="status">{t("translation.applying", { done: String(batchProgress.done), total: String(batchProgress.total) })}</p> : null}
              {batchOutcome ? <><p role="status">{t("translation.outcome", { applied: String(batchOutcome.applied), conflicted: String(batchOutcome.conflicted), failed: String(batchOutcome.failed), unknown: String(batchOutcome.unknown) })}</p><details><summary>{t("translation.batchDetails")}</summary><ul>{batchDetails.map((item, index) => <li key={`${item.key}:${index}`}>{item.key}: {t(`translation.batchStatus.${item.status}`)}</li>)}</ul></details></> : null}
              {uncertain.map(pending => <div key={pending.request.actionId} role="status"><p>{pending.key}</p><button className="secondary-button" disabled={busy} onClick={() => void importSession.checkReceipt(pending.request.actionId)}>{t("translation.checkReceipt")}</button><button className="secondary-button" disabled={busy || !pending.receiptChecked} onClick={() => void importSession.retryAction(pending.request.actionId)}>{t("translation.retryAction")}</button></div>)}
              {receiptMessage ? <p role="status">{t(receiptMessage === "found" ? "translation.receiptFound" : "translation.receiptMissing")}</p> : null}
            </section> : null}
          </> : null}
          {tab === "edit" && targetLocale ? <section className="translation-workspace" aria-label={t("translation.editor")}>
            <form className="translation-search" onSubmit={event => { event.preventDefault(); if (!busy && targetAvailable) void perform(current => loadList(0, query.trim(), current, true)); }}>
              <input aria-label={t("workbench.search")} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("workbench.search")} aria-invalid={failure === "query-limit" || undefined} />
              <button className="secondary-button" type="submit" disabled={busy || !targetAvailable}>{t("workbench.searchAction")}</button>
              <span role="status">{list ? t("workbench.results", { count: list.total }) : t("execution.loading")}</span>
            </form>
            <div className="translation-columns">
              <div className="translation-entry-list" aria-label={t("translation.chooseUnit")}>
                <ul ref={entryList}>{list?.rows.map(row => <li key={row.unitId}><button className="translation-entry" aria-label={row.nativeKey}
                  aria-current={displayedTarget?.unitId === row.unitId ? "true" : undefined} disabled={busy || !targetAvailable} onClick={() => chooseEditor(listTarget(row))}>
                  <strong>{row.nativeKey}</strong><span className="entry-source">{row.sourcePreview || t("translation.empty")}</span>
                  <span className="entry-translation">{row.translationPreview === null ? t("workbench.unselected") : row.translationPreview || t("translation.empty")}</span>
                  <span className="entry-status">{row.selectionId ? t("workbench.selected") : t("workbench.unselected")} · {reviewState(row)} · {qaState(row)}</span>
                </button></li>)}</ul>
                {list?.rows.length === 0 ? <p>{t("translation.noUnit")}</p> : null}
                <div className="entry-pagination"><button className="text-button" disabled={busy || !targetAvailable || listAfter === 0} onClick={() => void perform(current => loadList(0, appliedQuery, current))}>{t("execution.firstPage")}</button>
                {list?.nextOrdinal != null ? <button className="text-button" disabled={busy || !targetAvailable} onClick={() => void perform(current => loadList(list.nextOrdinal!, appliedQuery, current))}>{t("execution.nextPage")}</button> : null}</div>
              </div>
              {editorDraft && displayedTarget ? <div className="translation-detail">
                <div className="translation-editor">
                  <div className="execution-section-heading"><h2>{displayedTarget.key}</h2><span role="status" className="draft-state">{t(editorDraft.saving ? "workbench.saving" : dirty ? "workbench.unsaved" : editorDraft.baseSelectionId ? "workbench.saved" : "workbench.unselected")}</span></div>
                  <div className="entry-neighbors">{([-1, 1] as const).map(delta => {
                    const index = list?.rows.findIndex(row => row.unitId === displayedTarget.unitId) ?? -1;
                    const boundary = index >= 0 && (delta < 0 ? index === 0 && listAfter === 0
                      : index === (list?.rows.length ?? 0) - 1 && list?.nextOrdinal === null);
                    return <button key={delta} type="button" className="text-button"
                      disabled={busy || !targetAvailable || !!pendingSave || !editorTarget || !history || !list?.total || boundary}
                      onClick={() => void perform(current => navigateEntry(delta, current))}>
                      {t(delta < 0 ? "workbench.previousEntry" : "workbench.nextEntry")}
                    </button>;
                  })}</div>
                  {navigationEnd ? <p role="status">{t("workbench.scopeEnd")}</p> : null}
                  <section className="editor-source"><h3>{t("translation.sourceText")}</h3><pre>{displayedTarget.sourceText || t("translation.empty")}</pre></section>
                  <details className="selected-translation"><summary>{t("translation.current")}</summary><pre>{editorDraft?.baseSelectionId ? editorDraft.baseText || t("translation.empty") : t("translation.noSelection")}</pre></details>
                  <label>{t("translation.draft")}<textarea ref={draftField} value={draft} onChange={event => draftSession.edit(event.target.value)} /></label>
                  <div className="editor-save-bar"><p>{t("translation.draftHelp")}</p><div className="execution-actions"><button className="primary-button" disabled={pendingSave ? !retryAvailability().enabled : !saveAvailability().enabled} onClick={() => commandRegistry.dispatch(pendingSave ? "translation.retry-save" : "translation.save", commandScope)}>{pendingSave ? t("translation.retryAction") : t("translation.save")}</button>{pendingSave ? <button className="secondary-button" disabled={!reconcileAvailability().enabled} onClick={() => commandRegistry.dispatch("translation.reconcile-save", commandScope)}>{t("translation.checkSavedAction")}</button> : null}<button className="secondary-button" disabled={!saveAndNextAvailability().enabled} onClick={() => commandRegistry.dispatch("translation.save-and-next", commandScope)}>{t("workbench.saveAndNext")}</button><button className="text-button" disabled={busy || !dirty || !!pendingSave || !!pendingSelection} onClick={() => draftSession.revert()}>{t("translation.discardDraft")}</button></div></div>
                  {pendingSelection ? <div role="status"><p>{t("translation.selectionUnknown")}</p><button className="secondary-button" disabled={busy} onClick={() => void perform(current => checkSelection(current))}>{t("translation.checkSelection")}</button><button className="secondary-button" disabled={busy || !pendingSelection.receiptChecked} onClick={() => void perform(current => checkSelection(current, true))}>{t("translation.retrySelection")}</button></div> : null}
                  {newerDraftSaved ? <p role="status">{t("translation.savedNewerDraft")}</p> : null}
                </div>
                {history ? <details className="editor-references"><summary>{t("workbench.references")}</summary>
              <section aria-label={t("resource.editorReference")}><h5>{t("resource.editorReference")}</h5><p>{t("resource.editorReferenceHelp")}</p>
                {editorResources?.failed ? <p role="status">{t("resource.editorLoadFailed")}</p> : null}
                {editorResources?.terms ? <><h6>{t("resource.applicableTerms")}</h6>{editorResources.terms.entries.length ? <ul>{editorResources.terms.entries.map(entry => <li key={entry.source}>{entry.source}: {entry.selected ? <>{entry.selected.target} · {entry.selected.originKind === "manual" ? t("resource.manual") : t("resource.external")} · {entry.selected.reason}</> : t("resource.conflict")}</li>)}</ul> : <p>{t("resource.noApplicableTerms")}</p>}</> : null}
                {editorResources && !editorResources.failed ? <><h6>{t("resource.manualContext")}</h6>{editorResources.context ? <p>{editorResources.context.text} · {editorResources.context.reason}</p> : <p>{t("resource.noManualContext")}</p>}</> : null}
              </section>
              <div className="execution-section-heading"><h4>{t("translation.history")}</h4><button className="text-button" disabled={busy || !targetAvailable || !!pendingSave || !editorTarget} onClick={() => void perform(refreshHistory)}>{t("translation.refreshHistory")}</button></div>{historyStale ? <p role="status">{t("translation.historyStale")}</p> : null}{history.rows.length ? <ul>{history.rows.map(revision => <li key={revision.revisionId}><p>{revision.ordinal}: {revision.text === "" ? t("translation.empty") : revision.text}</p><p>{revision.originKind === "import" ? t("translation.importOrigin", { file: revision.logicalPath ?? "" }) : revision.originKind === "ai" ? t("ai.origin") : t("translation.manualOrigin")}</p>{revision.originKind === "import" ? <details><summary>{t("translation.evidence")}</summary><p>{t("translation.key")}: {revision.nativeKey}</p><p>{t("translation.file")}: {revision.logicalPath}</p><code>{revision.fileDigest}</code></details> : null}<button className="secondary-button" disabled={busy || !targetAvailable || dirty || !!pendingSave || !!pendingSelection || draftSession.mutationReserved || editorDraft?.baseRevisionId === revision.revisionId} onClick={() => void perform(current => selectRevision(revision.revisionId, current))}>{t("translation.selectRevision")}</button></li>)}</ul> : historyStale ? null : <p>{t("translation.noHistory")}</p>}
              <div className="execution-actions"><button className="secondary-button" disabled={busy || !targetAvailable || history.rows[0]?.ordinal === "1"} onClick={() => void perform(async current => { const locale = targetLocale; if (!currentLocale(locale)) return; const next = await commands.history({ ...context, unitId: displayedTarget.unitId, locale, afterOrdinal: translationHistoryAfter(history.rows[0]?.ordinal ?? "1", 101), limit: 100 }); if (current() && currentLocale(locale)) { setHistory(next); setHistoryStale(false); } })}>{t("translation.earlier")}</button>{history.nextOrdinal !== null ? <button className="secondary-button" disabled={busy || !targetAvailable} onClick={() => void perform(async current => { const locale = targetLocale; if (!currentLocale(locale)) return; const next = await commands.history({ ...context, unitId: displayedTarget.unitId, locale, afterOrdinal: history.nextOrdinal!, limit: 100 }); if (current() && currentLocale(locale)) { setHistory(next); setHistoryStale(false); } })}>{t("translation.later")}</button> : null}</div>
                </details> : null}
              </div> : <div className="editor-empty"><h2>{t("workbench.chooseEntry")}</h2><p>{t("workbench.chooseEntryHelp")}</p></div>}
            </div>
          </section> : null}
        </div>
      </WorkbenchPanel> : null}
    <Dialog.Root open={batchCapture !== null} onOpenChange={value => { if (!value && !importState.busy) importSession.cancelConfirmation(); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop" /><Dialog.Content className="confirm-dialog execution-confirm-dialog" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (importState.busy) event.preventDefault(); }}><Dialog.Title>{t("translation.batchConfirm")}</Dialog.Title><Dialog.Description>{t("translation.batchScope", { total: String(batchCapture?.preview.total ?? 0), matches: String(batchCapture?.eligible.length ?? 0), excluded: String(batchCapture?.excluded ?? 0) })}</Dialog.Description><p>{t(batchCapture?.decision === "select-if-empty" ? "translation.batchSelect" : "translation.batchCandidates")}</p>{importState.stale ? <p role="alert">{t("translation.previewStale")}</p> : null}{failure ? <p role="alert">{t(`translation.errors.${errorKey(failure)}`)}</p> : null}<div className="form-actions"><button className="secondary-button" disabled={importState.busy} onClick={() => importSession.cancelConfirmation()}>{t("execution.back")}</button><button className="primary-button" disabled={busy || importState.stale || !targetAvailable || draftSession.mutationReserved} onClick={() => void importSession.applyBatch(() => currentLocale(targetLocale))}>{t("translation.batchStart")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={rowAction !== null} onOpenChange={value => { if (!value && !busy) importSession.cancelConfirmation(); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop" /><Dialog.Content className="confirm-dialog execution-confirm-dialog" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}><Dialog.Title>{t(rowAction?.decision === "replace" ? "translation.replaceSelected" : rowAction?.decision === "select-if-empty" ? "translation.selectImported" : "translation.addCandidate")}</Dialog.Title><Dialog.Description>{t("translation.rowActionHelp", { key: rowAction?.row.entry.nativeKey ?? "" })}</Dialog.Description>{rowAction ? <div className="translation-action-compare"><p>{t("translation.importedText")}: {rowAction.row.entry.text === "" ? t("translation.empty") : rowAction.row.entry.text}</p><p>{t("translation.selectedText")}: {rowAction.row.currentText === null ? t("translation.noSelection") : rowAction.row.currentText === "" ? t("translation.empty") : rowAction.row.currentText}</p></div> : null}{targetUnavailable ? <p role="alert">{t("translation.removedTargetImport", { locale: targetLocale })}</p> : null}{importState.stale ? <p role="alert">{t("translation.previewStale")}</p> : null}{failure ? <p role="alert">{t(`translation.errors.${errorKey(failure)}`)}</p> : null}<div className="form-actions"><button className="secondary-button" disabled={busy} onClick={() => importSession.cancelConfirmation()}>{t("execution.back")}</button><button className="primary-button" disabled={busy || !targetAvailable || !preview || preview.targetLocale !== targetLocale || importState.stale || draftSession.mutationReserved} onClick={() => void importSession.applyRow(() => currentLocale(targetLocale))}>{t(rowAction?.decision === "replace" ? "translation.replaceSelected" : rowAction?.decision === "select-if-empty" ? "translation.selectImported" : "translation.addCandidate")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={leaveIntent !== null} onOpenChange={value => { if (!value && !busy) resolveLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}><Dialog.Title>{t("translation.leaveTitle")}</Dialog.Title><Dialog.Description>{t("translation.leaveHelp")}</Dialog.Description>{targetUnavailable ? <p role="alert">{t("translation.removedTargetDraft", { locale: targetLocale })}</p> : null}{failure ? <p role="alert">{t(`translation.errors.${errorKey(failure)}`)}</p> : null}{newerDraftSaved ? <p role="status">{t("translation.savedNewerDraft")}</p> : null}<div className="form-actions"><button className="secondary-button" disabled={busy} onClick={() => resolveLeave(false)}>{t("translation.stay")}</button><button className="secondary-button" disabled={busy || !!pendingSave || !!pendingSelection} onClick={() => resolveLeave(true)}>{t("translation.discard")}</button><button className="primary-button" disabled={busy || !targetAvailable} onClick={() => void perform(saveAndLeave)}>{pendingSave ? t("translation.retryAction") : t("translation.saveAndContinue")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
