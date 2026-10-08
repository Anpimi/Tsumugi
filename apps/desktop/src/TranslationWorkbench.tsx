import { useSessionQuery } from "./SessionReadProvider";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { hasUnknownOutcome } from "./projectCommands";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { reviewCommands, type ReviewSummaryPage, type ReviewSummary, type ReviewTarget } from "./reviewCommands";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { CommandError, ProjectView } from "./projectCommands";
import { executionCommands as execution, executionContext } from "./executionCommands";
import { sourceCommands, type ContentPage, type ContentRow, type SourceSelection } from "./sourceCommands";
import { translationCommands as commands, translationHistoryAfter, type TranslationAdoptRequest, type TranslationHistory, type TranslationPreflight, type TranslationPreview, type TranslationPreviewRow, type TranslationStartRequest } from "./translationCommands";
import type { TranslationDecision } from "./translationCommands";
import { type ContextRevision, type TermResolution } from "./resourceCommands";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useWorkbenchCommands } from "./workbenchCommands";

export interface EditorTarget { unitId: string; sourceRevisionId: string; key: string; sourceText: string }
interface BatchOutcome { applied: number; conflicted: number; failed: number; unknown: number }
interface BatchDetail { key: string; status: "applied" | "conflicted" | "failed" | "unknown" }
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
  if (stage === "invalid-save-receipt") return "unknown";
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
  const commandRegistry = useWorkbenchCommands();
  const editorDraft = draftSession.draft;
  const [open, setOpen] = useWorkbenchView("translation");
  const [tab, setTab] = useState<"import" | "edit">("edit");
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
  const [targetLocale, setTargetLocale] = useState(editorDraft?.locale ?? project.metadata.targetLocales[0] ?? "");
  const [folder, setFolder] = useState<SourceSelection | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [preflight, setPreflight] = useState<TranslationPreflight | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pendingStart, setPendingStart] = useState<TranslationStartRequest | null>(null);
  const [attempt, setAttempt] = useState<string | null>(null);
  const [preview, setPreview] = useState<TranslationPreview | null>(null);
  const [selectIfEmpty, setSelectIfEmpty] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchOutcome, setBatchOutcome] = useState<BatchOutcome | null>(null);
  const [batchDetails, setBatchDetails] = useState<BatchDetail[]>([]);
  const [uncertain, setUncertain] = useState<TranslationAdoptRequest[]>([]);
  const [receiptMessage, setReceiptMessage] = useState<"found" | "missing" | null>(null);
  const [rowAction, setRowAction] = useState<{ row: TranslationPreviewRow; decision: TranslationDecision } | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [history, setHistory] = useState<TranslationHistory | null>(null);
  const [historyStale, setHistoryStale] = useState(false);
  const [editorResources, setEditorResources] = useState<{ terms: TermResolution | null; context: ContextRevision | null; failed: boolean } | null>(null);
  const [localBusy, setBusy] = useState(false);
  const [failureValue, setFailure] = useState<CommandFailure | null>(null);
  const effectiveFailureValue = editorDraft?.failure ?? failureValue;
  const failure = failureReason(effectiveFailureValue);
  const [leaveIntent, setLeaveIntent] = useState<LeaveIntent | null>(null);
  const leaveResolver = useRef<((value: boolean) => void) | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const sourceLoad = useRef(0);
  const running = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const entryList = useRef<HTMLUListElement>(null);
  const draftField = useRef<HTMLTextAreaElement>(null);
  const draft = editorDraft?.text ?? "";
  const pendingSave = editorDraft?.pending?.request ?? null;
  const saveReceiptCheck = editorDraft?.receiptCheck ?? null;
  const newerDraftSaved = editorDraft?.newerDraftSaved ?? false;
  const dirty = !!editorDraft && (draft !== (editorDraft.baseText ?? "") || editorDraft.newerDraftSaved);
  const busy = localBusy || !!editorDraft?.saving;
  const displayedTarget = editorDraft ? { unitId: editorDraft.unitId, sourceRevisionId: editorDraft.sourceRevisionId,
    key: editorDraft.key, sourceText: editorDraft.sourceText } : editorTarget;
  const targetScope = project.metadata.targetLocales.join("\u0000");
  const availableLocales = useRef(project.metadata.targetLocales);
  const selectedLocale = useRef(targetLocale);
  const selectedAttempt = useRef(attempt);
  useLayoutEffect(() => {
    availableLocales.current = project.metadata.targetLocales;
    selectedLocale.current = targetLocale;
    selectedAttempt.current = attempt;
  }, [targetScope, targetLocale, attempt]);
  const localeAvailable = (locale: string) => locale !== "" && availableLocales.current.includes(locale);
  const currentLocale = (locale: string) => selectedLocale.current === locale && localeAvailable(locale);
  const targetAvailable = targetLocale !== "" && project.metadata.targetLocales.includes(targetLocale);
  const targetUnavailable = targetLocale !== "" && !targetAvailable;
  const canRebaseTarget = !dirty && !busy && !pendingSave && !pendingStart && !attempt
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
    if (capture?.pending || capture?.saving || uncertain.length) return { enabled: false, reason: "pending-action" as const };
    if (!targetAvailable || !capture || capture.locale !== targetLocale) return { enabled: false, reason: "unavailable" as const };
    if (capture.text === (capture.baseText ?? "") && !capture.newerDraftSaved) return { enabled: false, reason: "no-changes" as const };
    return { enabled: true };
  }
  function retryAvailability() {
    if (!open || tab !== "edit" || disabled || leaveIntent) return { enabled: false, reason: "hidden" as const };
    if (busy || running.current) return { enabled: false, reason: "busy" as const };
    if (!pendingSave) return { enabled: false, reason: "unavailable" as const };
    if (!targetAvailable) return { enabled: false, reason: "unavailable" as const };
    return { enabled: true };
  }
  function reconcileAvailability() {
    if (!open || tab !== "edit" || disabled || leaveIntent) return { enabled: false, reason: "hidden" as const };
    if (busy || running.current) return { enabled: false, reason: "busy" as const };
    if (!pendingSave) return { enabled: false, reason: "unavailable" as const };
    return { enabled: true };
  }
  useLayoutEffect(() => {
    const removeSave = commandRegistry.register({
      id: "translation.save", nameKey: "translation.save", category: "translation", scope: commandScope,
      binding: "Mod+S", risk: "writes-translation", confirmation: "none", availability: saveAvailability,
      handler: () => { void perform(saveDraft); },
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
    return () => { removeReconcile(); removeRetry(); removeSave(); };
  });
  useImperativeHandle(ref, () => ({
    saveCurrent() {
      commandRegistry.dispatch("translation.save", commandScope);
    },
    showAttempt(id) {
      if (running.current || draftSession.current()?.saving || dirty || pendingSave || pendingStart || uncertain.length) { setOpen(true); return; }
      generation.current++;
      setEditorTarget(null); setHistory(null); draftSession.clear();
      selectedAttempt.current = id;
      setTab("import"); setAttempt(id); setPreview(null); setFailure(null); setBatchOutcome(null); setOpen(true);
    },
    openUnit(target, locale, suggestedText) {
      if (!localeAvailable(locale)) {
        setOpen(true); setFailure("target-locale");
        return false;
      }
      if (running.current || draftSession.current()?.saving || dirty || pendingSave || pendingStart || uncertain.length) {
        setOpen(true);
        return false;
      }
      if (locale !== targetLocale) changeTarget(locale);
      setOpen(true);
      void perform(current => openEditor(target, current, locale, suggestedText));
      return true;
    },
    allowLeave() {
      if (running.current || draftSession.current()?.saving) { setOpen(true); return Promise.resolve(false); }
      if (pendingSave || pendingStart || uncertain.length) { setOpen(true); setFailure("outcome-unknown"); return Promise.resolve(false); }
      if (!dirty) return Promise.resolve(true);
      setOpen(true);
      setLeaveIntent({ kind: "project" });
      return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
    },
    allowNavigate() {
      if (leaveIntent || rowAction || pendingStart || uncertain.length || (running.current && !editorDraft?.saving)) return Promise.resolve(false);
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
    selectedLocale.current = locale;
    selectedAttempt.current = null;
    setTargetLocale(locale); setPreflight(null); setConfirmed(false); setPreview(null); setAttempt(null); setPendingStart(null);
    setList(null); listScope.current = null; listPosition.current = { query: "", after: 0 };
    setQuery(""); setAppliedQuery(""); setListAfter(0); setNavigationEnd(false);
    if (editorTarget) { setEditorTarget(null); setHistory(null); setEditorResources(null); }
    if (editorDraft) draftSession.clear();
  }
  async function chooseFolder(current: () => boolean) {
    const locale = targetLocale;
    if (!currentLocale(locale)) return;
    const selected = await commands.selectFolder(context);
    if (!current() || !currentLocale(locale)) return;
    setFolder(selected); setFiles([]); setFileName(""); setPreflight(null); setConfirmed(false); setPreview(null); setAttempt(null); setPendingStart(null);
    if (selected) {
      const found = await commands.files({ ...context, selectionId: selected.selectionId });
      if (current() && currentLocale(locale)) { setFiles(found); setFileName(found[0] ?? ""); }
    }
  }
  async function startImport(request: TranslationStartRequest, current: () => boolean) {
    if (!localeAvailable(request.targetLocale)) return;
    try {
      const id = await commands.start(request);
      if (current()) { selectedAttempt.current = id; setAttempt(id); setPendingStart(null); setPreview(null); setBatchOutcome(null); }
    } catch (error) {
      if (current() && !hasUnknownOutcome(error)) setPendingStart(null);
      throw error;
    }
  }
  const importRead = useSessionQuery<TranslationPreview | null>({ key: ["translation-import-preview", attempt, 0, 50, null], scopes: ["execution", "translation"], enabled: open && !busy && !!attempt && !preview,
    read: async () => {
      try { return await commands.preview({ ...context, attemptId: attempt!, after: 0, limit: 50, basis: null }); }
      catch (error) { if (errorStage(error) === "translation-incomplete") return null; throw error; }
    } });
  useEffect(() => {
    if (!importRead.data || importRead.data.attemptId !== selectedAttempt.current) return;
    selectedLocale.current = importRead.data.targetLocale;
    setTargetLocale(importRead.data.targetLocale);
    setPreview(importRead.data); setFailure(null);
  }, [importRead.data, targetScope]);
  useEffect(() => { if (importRead.error) setFailure(commandFailure(importRead.error)); }, [importRead.error]);
  async function loadPreview(after: number, basis: string | null, current: () => boolean) {
    if (!attempt) return;
    const requestedAttempt = attempt;
    const next = await commands.preview({ ...context, attemptId: requestedAttempt, after, limit: 50, basis });
    if (current() && selectedAttempt.current === requestedAttempt) setPreview(next);
  }
  async function allPreviewRows(first: TranslationPreview): Promise<TranslationPreviewRow[]> {
    const rows = [...first.rows];
    let after = first.nextOrdinal;
    while (after !== null) {
      const page = await commands.preview({ ...context, attemptId: first.attemptId, after, limit: 100, basis: first.basis });
      rows.push(...page.rows);
      after = page.nextOrdinal;
    }
    return rows;
  }
  async function applyBatch(current: () => boolean) {
    if (!preview || !attempt || !currentLocale(targetLocale) || preview.targetLocale !== targetLocale) return;
    const first = await commands.preview({ ...context, attemptId: attempt, after: 0, limit: 100, basis: null });
    if (!current() || !currentLocale(targetLocale) || first.targetLocale !== targetLocale) return;
    const rows = (await allPreviewRows(first)).filter(row => row.status === "unique" && row.unitId && row.occurrenceId && row.sourceRevisionId);
    if (!current() || !currentLocale(targetLocale) || first.targetLocale !== targetLocale) return;
    const outcome: BatchOutcome = { applied: 0, conflicted: 0, failed: 0, unknown: 0 };
    const details: BatchDetail[] = [];
    setBatchProgress({ done: 0, total: rows.length });
    try {
      for (const [index, row] of rows.entries()) {
        if (!current()) return;
        if (!currentLocale(targetLocale) || first.targetLocale !== targetLocale) break;
        const request: TranslationAdoptRequest = {
          ...context, attemptId: attempt, itemId: row.itemId, resultId: row.resultId,
          actionId: await execution.identity(context),
          confirmation: {
            resultDigest: row.resultDigest, sourceSnapshotId: first.fixedSourceSnapshotId,
            occurrenceId: row.occurrenceId!, sourceRevisionId: row.sourceRevisionId!,
            targetUnitId: row.unitId!, expectedSelectionId: null,
            decision: selectIfEmpty ? "select-if-empty" : "candidate-only",
          },
        };
        try {
        if (!current() || !currentLocale(targetLocale) || first.targetLocale !== targetLocale) break;
        await commands.prepare(request);
        if (!current() || !currentLocale(targetLocale) || first.targetLocale !== targetLocale) break;
        await execution.adopt({ ...context, actionId: request.actionId });
        outcome.applied++;
        details.push({ key: row.entry.nativeKey, status: "applied" });
        } catch (error) {
          const code = (error as Partial<CommandError> | null)?.code;
          if (hasUnknownOutcome(error)) { outcome.unknown++; details.push({ key: row.entry.nativeKey, status: "unknown" }); setUncertain(list => [...list, request]); }
          else if (code === "dependency-conflict") { outcome.conflicted++; details.push({ key: row.entry.nativeKey, status: "conflicted" }); }
          else { outcome.failed++; details.push({ key: row.entry.nativeKey, status: "failed" }); }
        }
        if (current()) setBatchProgress({ done: index + 1, total: rows.length });
      }
      if (current()) {
        setBatchOutcome(outcome);
        setBatchDetails(details);
        await loadPreview(0, null, current);
      }
    } finally {
      if (current()) setBatchProgress(null);
    }
  }
  async function applyRow(current: () => boolean) {
    if (!preview || !attempt || !rowAction || !currentLocale(targetLocale) || preview.targetLocale !== targetLocale) return;
    const { row, decision } = rowAction;
    if (!row.unitId || !row.occurrenceId || !row.sourceRevisionId) return;
    const request: TranslationAdoptRequest = {
      ...context, attemptId: attempt, itemId: row.itemId, resultId: row.resultId,
      actionId: await execution.identity(context),
      confirmation: {
        resultDigest: row.resultDigest, sourceSnapshotId: preview.fixedSourceSnapshotId,
        occurrenceId: row.occurrenceId, sourceRevisionId: row.sourceRevisionId,
        targetUnitId: row.unitId, expectedSelectionId: row.currentSelection?.eventId ?? null,
        decision,
      },
    };
    try {
      if (!current() || !currentLocale(targetLocale) || preview.targetLocale !== targetLocale) return;
      await commands.prepare(request);
      if (!current() || !currentLocale(targetLocale) || preview.targetLocale !== targetLocale) return;
      await execution.adopt({ ...context, actionId: request.actionId });
      if (current()) { setRowAction(null); await loadPreview(0, null, current); }
    } catch (error) {
      if (current() && hasUnknownOutcome(error)) {
        setUncertain(list => [...list, request]);
        setRowAction(null);
      }
      throw error;
    }
  }
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
    if (pendingSave) { setFailure("outcome-unknown"); return; }
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
    const result = await saveDraft(current);
    if (result.savedCurrent && current() && currentLocale(targetLocale)
      && draftSession.unchanged(result.submittedSeq, result.submittedText)) await navigateEntry(1, current, true);
  }
  async function selectRevision(revisionId: string, current: () => boolean) {
    const locale = targetLocale;
    const basis = draftSession.current();
    if (!editorTarget || !history || !basis || dirty || pendingSave || !currentLocale(locale)) return;
    const request = { ...context, actionId: await execution.identity(context), unitId: editorTarget.unitId,
      locale, sourceRevisionId: basis.sourceRevisionId,
      expectedSelectionId: basis.baseSelectionId, revisionId };
    if (!current() || !currentLocale(locale)) return;
    await commands.select(request);
    if (!currentLocale(locale)) { if (current()) setHistoryStale(true); return; }
    const next = await commands.history({ ...context, unitId: request.unitId, locale: request.locale,
      afterOrdinal: translationHistoryAfter(history.total, 100), limit: 100 });
    if (current() && currentLocale(locale)) { setHistory(next); draftSession.selected(next.current, next.currentText, basis.editSeq); setHistoryStale(false); await loadList(listAfter, appliedQuery, current); }
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
    if (leaveIntent || pendingStart || uncertain.length || (running.current && !editorDraft?.saving)) return;
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
    {open ? <WorkbenchPanel open={open} title={t("translation.title")} description={t("translation.description")} className="source-dialog translation-workbench" onBack={requestClose} backDisabled={disabled || (busy && !editorDraft?.saving)}>
        <div className="execution-content" aria-busy={busy}>
          {failure ? <div role="alert"><p>{t(`translation.errors.${errorKey(failure)}`)}</p><CommandFailureDetails failure={effectiveFailureValue} />{typeof effectiveFailureValue === "string" ? <details><summary>{t("execution.diagnostic")}</summary><code>{failure}</code></details> : null}</div> : null}
          {saveReceiptCheck ? <p role="status">{t(saveReceiptCheck === "found" ? "translation.savedActionFound" : "translation.savedActionMissing")}</p> : null}
          {targetUnavailable ? <div role="alert"><p>{t(editorDraft ? "translation.removedTargetDraft" : "translation.removedTargetImport", { locale: targetLocale })}</p><button className="secondary-button" type="button" disabled={busy && !editorDraft?.saving} onClick={() => setOpen(false)}>{t("translation.returnToSettings")}</button></div> : null}
          {busy ? <p role="status">{t("execution.working")}</p> : null}
          {sourceMissing ? <p role="status">{t("translation.noSource")}</p> : null}
          {!project.metadata.targetLocales.length ? <p role="status">{t("translation.noTargets")}</p> : null}
          <div className="execution-actions">{sourcePage?.namespace !== "webvtt:source" ? <button className="secondary-button" aria-current={tab === "import" ? "page" : undefined} onClick={() => setTab("import")}>{t("translation.importTab")}</button> : null}<button className="secondary-button" aria-current={tab === "edit" ? "page" : undefined} onClick={() => setTab("edit")}>{t("translation.editTab")}</button></div>
          {sourcePage && (project.metadata.targetLocales.length || targetUnavailable) ? <label>{t("translation.target")}<select value={targetLocale} disabled={busy || dirty || !!pendingSave || !!pendingStart || uncertain.length > 0} onChange={event => changeTarget(event.target.value)}>{targetUnavailable ? <option value={targetLocale} disabled>{t("translation.removedTargetOption", { locale: targetLocale })}</option> : null}{project.metadata.targetLocales.map(locale => <option key={locale} value={locale}>{locale}</option>)}</select></label> : null}
          {tab === "import" && sourcePage && sourcePage.namespace !== "webvtt:source" && targetLocale ? <>
            <section><button className="secondary-button" disabled={busy || !targetAvailable || uncertain.length > 0} onClick={() => void perform(chooseFolder)}>{t("translation.chooseFolder")}</button>
              {folder ? <><p>{t("translation.folder", { name: folder.folderName })}</p>{files.length ? <label>{t("translation.file")}<select value={fileName} disabled={busy || !!pendingStart || uncertain.length > 0} onChange={event => { selectedAttempt.current = null; setFileName(event.target.value); setPreflight(null); setConfirmed(false); setAttempt(null); setPreview(null); }}>{files.map(file => <option key={file} value={file}>{file}</option>)}</select></label> : <p role="status">{t("translation.noFiles")}</p>}
                <button className="secondary-button" disabled={busy || !canImport} onClick={() => void perform(async current => { const locale = targetLocale; if (!currentLocale(locale)) return; const checked = await commands.preflight({ ...context, selectionId: folder.selectionId, fileName, targetLocale: locale }); if (current() && currentLocale(locale) && localeAvailable(checked.targetLocale)) { setPreflight(checked); setConfirmed(false); } })}>{t("translation.inspect")}</button>
              </> : null}
              {preflight ? <><p>{t("translation.preflight", { count: preflight.count, file: preflight.fileName })}</p><label className="source-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{t("translation.languageConfirm", { file: preflight.fileName, target: preflight.targetLocale, declared: preflight.declaredLocale })}</label>
                <button className="primary-button" disabled={busy || !targetAvailable || !localeAvailable(preflight.targetLocale) || !confirmed || !!pendingStart || !!attempt} onClick={() => void perform(async current => { if (!currentLocale(targetLocale) || !localeAvailable(preflight.targetLocale)) return; const request: TranslationStartRequest = { ...context, selectionId: folder!.selectionId, fileName: preflight.fileName, targetLocale: preflight.targetLocale, languageConfirmed: true, expectedFileDigest: preflight.fileDigest, expectedSourceSnapshotId: preflight.sourceSnapshotId, attemptId: await execution.identity(context) }; if (!current() || !currentLocale(targetLocale) || !localeAvailable(request.targetLocale)) return; setPendingStart(request); await startImport(request, current); })}>{t("translation.start")}</button></> : null}
              {pendingStart ? <div role="status"><p>{t("translation.startUnknown")}</p><button className="secondary-button" disabled={busy || !localeAvailable(pendingStart.targetLocale)} onClick={() => void perform(current => startImport(pendingStart, current))}>{t("translation.checkStart")}</button></div> : null}
              {attempt && !preview ? <p role="status">{t("translation.progress", { count: preflight?.count ?? 0 })}</p> : null}
            </section>
            {preview ? <section><h3>{t("translation.preview")}</h3><p>{t("translation.counts", { unique: String(preview.unique), unmatched: String(preview.unmatched), conflicts: String(preview.selectedConflicts), changed: String(preview.sourceChanged) })}</p><p>{preview.logicalPath} · {preview.targetLocale}</p>{preview.sourceChanged ? <p role="alert">{t("translation.sourceChanged")}</p> : null}
              <div className="source-table-scroll"><table className="source-table"><caption>{t("translation.page", { first: String((preview.rows[0]?.entry.ordinal ?? 0) + 1), last: String((preview.rows.at(-1)?.entry.ordinal ?? -1) + 1), total: String(preview.total) })}</caption><thead><tr><th scope="col">{t("translation.key")}</th><th scope="col">{t("translation.sourceText")}</th><th scope="col">{t("translation.importedText")}</th><th scope="col">{t("translation.selectedText")}</th><th scope="col">{t("translation.match")}</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.entry.ordinal}><th scope="row">{row.entry.nativeKey}<details><summary>{t("translation.evidence")}</summary><p>{preview.logicalPath} · {row.entry.valueByteRange[0]}–{row.entry.valueByteRange[1]}</p><code>{preview.fileDigest}</code></details></th><td><pre>{row.sourceText === "" ? t("translation.empty") : row.sourceText}</pre></td><td><pre>{row.entry.text === "" ? t("translation.empty") : row.entry.text}</pre></td><td><pre>{row.currentText === "" ? t("translation.empty") : row.currentText}</pre></td><td>{t(`translation.status.${row.status}`)}{row.status === "unique" || row.status === "selected-conflict" ? <div className="translation-row-actions"><button className="text-button" disabled={busy || !targetAvailable || preview.targetLocale !== targetLocale} onClick={() => setRowAction({ row, decision: "candidate-only" })}>{t("translation.addCandidate")}</button><button className="text-button" disabled={busy || !targetAvailable || preview.targetLocale !== targetLocale} onClick={() => setRowAction({ row, decision: row.status === "unique" ? "select-if-empty" : "replace" })}>{t(row.status === "unique" ? "translation.selectImported" : "translation.replaceSelected")}</button></div> : null}{targetFromTranslation(row) ? <button className="text-button" disabled={busy || !targetAvailable} onClick={() => chooseEditor(targetFromTranslation(row)!)}>{t("translation.openEditor")}</button> : null}</td></tr>)}</tbody></table></div>
              <div className="execution-actions"><button className="secondary-button" disabled={busy} onClick={() => void perform(current => loadPreview(0, null, current))}>{t("translation.refreshPreview")}</button>{preview.nextOrdinal !== null ? <button className="secondary-button" disabled={busy} onClick={() => void perform(current => loadPreview(preview.nextOrdinal!, preview.basis, current))}>{t("execution.nextPage")}</button> : null}</div>
              <p>{t("translation.applyHelp")}</p><label className="source-check"><input type="checkbox" checked={selectIfEmpty} disabled={busy} onChange={event => setSelectIfEmpty(event.target.checked)} />{t("translation.selectIfEmpty")}</label>
              <button className="primary-button" disabled={busy || !targetAvailable || preview.targetLocale !== targetLocale || preview.unique === 0 || preview.sourceChanged > 0} onClick={() => void perform(applyBatch)}>{t("translation.apply", { count: preview.unique })}</button>
              {batchProgress ? <p role="status">{t("translation.applying", { done: String(batchProgress.done), total: String(batchProgress.total) })}</p> : null}
              {batchOutcome ? <><p role="status">{t("translation.outcome", { applied: String(batchOutcome.applied), conflicted: String(batchOutcome.conflicted), failed: String(batchOutcome.failed), unknown: String(batchOutcome.unknown) })}</p><details><summary>{t("translation.batchDetails")}</summary><ul>{batchDetails.map((item, index) => <li key={`${item.key}:${index}`}>{item.key}: {t(`translation.batchStatus.${item.status}`)}</li>)}</ul></details></> : null}
              {uncertain.map(request => <div key={request.actionId} role="status"><button className="secondary-button" disabled={busy} onClick={() => void perform(async current => { const receipt = await execution.receipt({ ...context, actionId: request.actionId }); if (current()) { setReceiptMessage(receipt ? "found" : "missing"); if (receipt) { setUncertain(list => list.filter(item => item.actionId !== request.actionId)); await loadPreview(0, null, current); } } })}>{t("translation.checkReceipt")}</button><button className="secondary-button" disabled={busy || !targetAvailable || preview.targetLocale !== targetLocale} onClick={() => void perform(async current => { if (!currentLocale(targetLocale) || preview.targetLocale !== targetLocale) return; await commands.prepare(request); if (!current() || !currentLocale(targetLocale) || preview.targetLocale !== targetLocale) return; await execution.adopt({ ...context, actionId: request.actionId }); if (current()) { setUncertain(list => list.filter(item => item.actionId !== request.actionId)); await loadPreview(0, null, current); } })}>{t("translation.retryAction")}</button></div>)}
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
                  <div className="editor-save-bar"><p>{t("translation.draftHelp")}</p><div className="execution-actions"><button className="primary-button" disabled={pendingSave ? !retryAvailability().enabled : !saveAvailability().enabled} onClick={() => commandRegistry.dispatch(pendingSave ? "translation.retry-save" : "translation.save", commandScope)}>{pendingSave ? t("translation.retryAction") : t("translation.save")}</button>{pendingSave ? <button className="secondary-button" disabled={!reconcileAvailability().enabled} onClick={() => commandRegistry.dispatch("translation.reconcile-save", commandScope)}>{t("translation.checkSavedAction")}</button> : null}<button className="secondary-button" disabled={busy || !targetAvailable || (!dirty && !pendingSave) || !list?.total} onClick={() => void perform(saveAndNext)}>{t("workbench.saveAndNext")}</button><button className="text-button" disabled={busy || !dirty || !!pendingSave} onClick={() => draftSession.revert()}>{t("translation.discardDraft")}</button></div></div>
                  {newerDraftSaved ? <p role="status">{t("translation.savedNewerDraft")}</p> : null}
                </div>
                {history ? <details className="editor-references"><summary>{t("workbench.references")}</summary>
              <section aria-label={t("resource.editorReference")}><h5>{t("resource.editorReference")}</h5><p>{t("resource.editorReferenceHelp")}</p>
                {editorResources?.failed ? <p role="status">{t("resource.editorLoadFailed")}</p> : null}
                {editorResources?.terms ? <><h6>{t("resource.applicableTerms")}</h6>{editorResources.terms.entries.length ? <ul>{editorResources.terms.entries.map(entry => <li key={entry.source}>{entry.source}: {entry.selected ? <>{entry.selected.target} · {entry.selected.originKind === "manual" ? t("resource.manual") : t("resource.external")} · {entry.selected.reason}</> : t("resource.conflict")}</li>)}</ul> : <p>{t("resource.noApplicableTerms")}</p>}</> : null}
                {editorResources && !editorResources.failed ? <><h6>{t("resource.manualContext")}</h6>{editorResources.context ? <p>{editorResources.context.text} · {editorResources.context.reason}</p> : <p>{t("resource.noManualContext")}</p>}</> : null}
              </section>
              <div className="execution-section-heading"><h4>{t("translation.history")}</h4><button className="text-button" disabled={busy || !targetAvailable || !!pendingSave || !editorTarget} onClick={() => void perform(refreshHistory)}>{t("translation.refreshHistory")}</button></div>{historyStale ? <p role="status">{t("translation.historyStale")}</p> : null}{history.rows.length ? <ul>{history.rows.map(revision => <li key={revision.revisionId}><p>{revision.ordinal}: {revision.text === "" ? t("translation.empty") : revision.text}</p><p>{revision.originKind === "import" ? t("translation.importOrigin", { file: revision.logicalPath ?? "" }) : revision.originKind === "ai" ? t("ai.origin") : t("translation.manualOrigin")}</p>{revision.originKind === "import" ? <details><summary>{t("translation.evidence")}</summary><p>{t("translation.key")}: {revision.nativeKey}</p><p>{t("translation.file")}: {revision.logicalPath}</p><code>{revision.fileDigest}</code></details> : null}<button className="secondary-button" disabled={busy || !targetAvailable || dirty || !!pendingSave || editorDraft?.baseRevisionId === revision.revisionId} onClick={() => void perform(current => selectRevision(revision.revisionId, current))}>{t("translation.selectRevision")}</button></li>)}</ul> : historyStale ? null : <p>{t("translation.noHistory")}</p>}
              <div className="execution-actions"><button className="secondary-button" disabled={busy || !targetAvailable || history.rows[0]?.ordinal === "1"} onClick={() => void perform(async current => { const locale = targetLocale; if (!currentLocale(locale)) return; const next = await commands.history({ ...context, unitId: displayedTarget.unitId, locale, afterOrdinal: translationHistoryAfter(history.rows[0]?.ordinal ?? "1", 101), limit: 100 }); if (current() && currentLocale(locale)) { setHistory(next); setHistoryStale(false); } })}>{t("translation.earlier")}</button>{history.nextOrdinal !== null ? <button className="secondary-button" disabled={busy || !targetAvailable} onClick={() => void perform(async current => { const locale = targetLocale; if (!currentLocale(locale)) return; const next = await commands.history({ ...context, unitId: displayedTarget.unitId, locale, afterOrdinal: history.nextOrdinal!, limit: 100 }); if (current() && currentLocale(locale)) { setHistory(next); setHistoryStale(false); } })}>{t("translation.later")}</button> : null}</div>
                </details> : null}
              </div> : <div className="editor-empty"><h2>{t("workbench.chooseEntry")}</h2><p>{t("workbench.chooseEntryHelp")}</p></div>}
            </div>
          </section> : null}
        </div>
      </WorkbenchPanel> : null}
    <Dialog.Root open={rowAction !== null} onOpenChange={value => { if (!value && !busy) setRowAction(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop" /><Dialog.Content className="confirm-dialog execution-confirm-dialog" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}><Dialog.Title>{t(rowAction?.decision === "replace" ? "translation.replaceSelected" : rowAction?.decision === "select-if-empty" ? "translation.selectImported" : "translation.addCandidate")}</Dialog.Title><Dialog.Description>{t("translation.rowActionHelp", { key: rowAction?.row.entry.nativeKey ?? "" })}</Dialog.Description>{rowAction ? <div className="translation-action-compare"><p>{t("translation.importedText")}: {rowAction.row.entry.text === "" ? t("translation.empty") : rowAction.row.entry.text}</p><p>{t("translation.selectedText")}: {rowAction.row.currentText === null ? t("translation.noSelection") : rowAction.row.currentText === "" ? t("translation.empty") : rowAction.row.currentText}</p></div> : null}{targetUnavailable ? <p role="alert">{t("translation.removedTargetImport", { locale: targetLocale })}</p> : null}{failure ? <p role="alert">{t(`translation.errors.${errorKey(failure)}`)}</p> : null}<div className="form-actions"><button className="secondary-button" disabled={busy} onClick={() => setRowAction(null)}>{t("execution.back")}</button><button className="primary-button" disabled={busy || !targetAvailable || !preview || preview.targetLocale !== targetLocale} onClick={() => void perform(applyRow)}>{t(rowAction?.decision === "replace" ? "translation.replaceSelected" : rowAction?.decision === "select-if-empty" ? "translation.selectImported" : "translation.addCandidate")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={leaveIntent !== null} onOpenChange={value => { if (!value && !busy) resolveLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}><Dialog.Title>{t("translation.leaveTitle")}</Dialog.Title><Dialog.Description>{t("translation.leaveHelp")}</Dialog.Description>{targetUnavailable ? <p role="alert">{t("translation.removedTargetDraft", { locale: targetLocale })}</p> : null}{failure ? <p role="alert">{t(`translation.errors.${errorKey(failure)}`)}</p> : null}{newerDraftSaved ? <p role="status">{t("translation.savedNewerDraft")}</p> : null}<div className="form-actions"><button className="secondary-button" disabled={busy} onClick={() => resolveLeave(false)}>{t("translation.stay")}</button><button className="secondary-button" disabled={busy || !!pendingSave} onClick={() => resolveLeave(true)}>{t("translation.discard")}</button><button className="primary-button" disabled={busy || !targetAvailable} onClick={() => void perform(saveAndLeave)}>{pendingSave ? t("translation.retryAction") : t("translation.saveAndContinue")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
