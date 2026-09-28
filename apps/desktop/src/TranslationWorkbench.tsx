import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { CommandError, ProjectView } from "./projectCommands";
import { executionCommands as execution, executionContext } from "./executionCommands";
import { sourceCommands, type ContentPage, type ContentRow, type SourceSelection } from "./sourceCommands";
import { translationCommands as commands, type TranslationAdoptRequest, type TranslationHistory, type TranslationPreflight, type TranslationPreview, type TranslationPreviewRow, type TranslationSaveRequest, type TranslationStartRequest } from "./translationCommands";
import type { TranslationDecision } from "./translationCommands";
import { resourceCommands, type ContextRevision, type TermResolution } from "./resourceCommands";

export interface EditorTarget { unitId: string; sourceRevisionId: string; key: string; sourceText: string }
interface BatchOutcome { applied: number; conflicted: number; failed: number; unknown: number }
interface BatchDetail { key: string; status: "applied" | "conflicted" | "failed" | "unknown" }
type LeaveIntent = { kind: "close" } | { kind: "project" } | { kind: "switch"; target: EditorTarget };
export interface TranslationHandle {
  showAttempt: (id: string) => void;
  openUnit: (target: EditorTarget, locale: string, suggestedText?: string) => boolean;
  allowLeave: () => Promise<boolean>;
}

function errorStage(error: unknown): string {
  const value = error as Partial<CommandError> | null;
  return value?.field ?? value?.code ?? "failed";
}
function errorKey(stage: string) {
  if (stage === "source-changed") return "changed";
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
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"import" | "edit">("import");
  const [sourcePage, setSourcePage] = useState<ContentPage | null>(null);
  const [sourceMissing, setSourceMissing] = useState(false);
  const [targetLocale, setTargetLocale] = useState(project.metadata.targetLocales[0] ?? "");
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
  const [editorResources, setEditorResources] = useState<{ terms: TermResolution | null; context: ContextRevision | null; failed: boolean } | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingSave, setPendingSave] = useState<TranslationSaveRequest | null>(null);
  const [newerDraftSaved, setNewerDraftSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [leaveIntent, setLeaveIntent] = useState<LeaveIntent | null>(null);
  const leaveResolver = useRef<((value: boolean) => void) | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const sourceLoad = useRef(0);
  const pollGeneration = useRef(0);
  const running = useRef(false);
  const draftRef = useRef("");
  const heading = useRef<HTMLHeadingElement>(null);
  const dirty = editorTarget !== null && draft !== (history?.currentText ?? "");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; sourceLoad.current++; pollGeneration.current++; leaveResolver.current?.(false); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const ticket = ++sourceLoad.current;
    void (async () => {
      try {
        const scope = await sourceCommands.scope(context);
        const page = scope.currentSnapshot
          ? await sourceCommands.content({ ...context, snapshotId: scope.currentSnapshot, after: 0, limit: 50 })
          : null;
        if (mounted.current && sourceLoad.current === ticket) {
          setSourceMissing(!page);
          setSourcePage(page);
        }
      } catch (error) {
        if (mounted.current && sourceLoad.current === ticket) setFailure(errorStage(error));
      }
    })();
    return () => { sourceLoad.current++; };
  }, [open, project.sessionToken]);
  useEffect(() => { if (open) heading.current?.focus(); }, [open, tab]);
  useImperativeHandle(ref, () => ({
    showAttempt(id) {
      if (running.current || dirty || pendingSave || uncertain.length) { setOpen(true); return; }
      generation.current++;
      setEditorTarget(null); setHistory(null); setDraft(""); draftRef.current = "";
      setTab("import"); setAttempt(id); setPreview(null); setFailure(null); setBatchOutcome(null); setOpen(true);
    },
    openUnit(target, locale, suggestedText) {
      if (running.current || dirty || pendingSave || uncertain.length) {
        setOpen(true);
        return false;
      }
      setTargetLocale(locale);
      setOpen(true);
      void perform(current => openEditor(target, current, locale, suggestedText));
      return true;
    },
    allowLeave() {
      if (running.current) { setOpen(true); return Promise.resolve(false); }
      if (pendingSave || uncertain.length) { setOpen(true); setFailure("outcome-unknown"); return Promise.resolve(false); }
      if (!dirty) return Promise.resolve(true);
      setOpen(true);
      setLeaveIntent({ kind: "project" });
      return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
    },
  }));

  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (running.current) return;
    running.current = true;
    const ticket = ++generation.current;
    const current = () => mounted.current && generation.current === ticket;
    setBusy(true); setFailure(null);
    try { await work(current); } catch (error) { if (current()) setFailure(errorStage(error)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  function changeTarget(locale: string) {
    setTargetLocale(locale); setPreflight(null); setConfirmed(false); setPreview(null); setAttempt(null); setPendingStart(null);
    if (editorTarget) { setEditorTarget(null); setHistory(null); setEditorResources(null); setDraft(""); draftRef.current = ""; }
  }
  async function chooseFolder(current: () => boolean) {
    const selected = await commands.selectFolder(context);
    if (!current()) return;
    setFolder(selected); setFiles([]); setFileName(""); setPreflight(null); setConfirmed(false); setPreview(null); setAttempt(null); setPendingStart(null);
    if (selected) {
      const found = await commands.files({ ...context, selectionId: selected.selectionId });
      if (current()) { setFiles(found); setFileName(found[0] ?? ""); }
    }
  }
  async function startImport(request: TranslationStartRequest, current: () => boolean) {
    try {
      const id = await commands.start(request);
      if (current()) { setAttempt(id); setPendingStart(null); setPreview(null); setBatchOutcome(null); }
    } catch (error) {
      if (current() && !errorStage(error).includes("unknown")) setPendingStart(null);
      throw error;
    }
  }
  useEffect(() => {
    if (!open || !attempt || preview || busy) return;
    const ticket = ++pollGeneration.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (stopped) return;
      try {
        const next = await commands.preview({ ...context, attemptId: attempt!, after: 0, limit: 50, basis: null });
        if (!stopped && mounted.current && pollGeneration.current === ticket) { setTargetLocale(next.targetLocale); setPreview(next); setFailure(null); return; }
      } catch (error) {
        const stage = errorStage(error);
        if (stage !== "translation-incomplete" && !stopped && mounted.current && pollGeneration.current === ticket) {
          setFailure(stage); return;
        }
      }
      if (!stopped && pollGeneration.current === ticket) timer = setTimeout(() => void poll(), 800);
    }
    void poll();
    return () => { stopped = true; pollGeneration.current++; clearTimeout(timer); };
  }, [open, attempt, preview, busy, project.sessionToken]);
  async function loadPreview(after: number, basis: string | null, current: () => boolean) {
    if (!attempt) return;
    const next = await commands.preview({ ...context, attemptId: attempt, after, limit: 50, basis });
    if (current()) setPreview(next);
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
    if (!preview || !attempt) return;
    const first = await commands.preview({ ...context, attemptId: attempt, after: 0, limit: 100, basis: null });
    const rows = (await allPreviewRows(first)).filter(row => row.status === "unique" && row.unitId && row.occurrenceId && row.sourceRevisionId);
    if (!current()) return;
    const outcome: BatchOutcome = { applied: 0, conflicted: 0, failed: 0, unknown: 0 };
    const details: BatchDetail[] = [];
    setBatchProgress({ done: 0, total: rows.length });
    try {
      for (const [index, row] of rows.entries()) {
        if (!current()) return;
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
        await commands.prepare(request);
        await execution.adopt({ ...context, actionId: request.actionId });
        outcome.applied++;
        details.push({ key: row.entry.nativeKey, status: "applied" });
        } catch (error) {
          const code = (error as Partial<CommandError> | null)?.code;
          if (code === "outcome-unknown" || errorStage(error).includes("unknown")) { outcome.unknown++; details.push({ key: row.entry.nativeKey, status: "unknown" }); setUncertain(list => [...list, request]); }
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
    if (!preview || !attempt || !rowAction) return;
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
      await commands.prepare(request);
      await execution.adopt({ ...context, actionId: request.actionId });
      if (current()) { setRowAction(null); await loadPreview(0, null, current); }
    } catch (error) {
      if (current() && errorStage(error).includes("unknown")) {
        setUncertain(list => [...list, request]);
        setRowAction(null);
      }
      throw error;
    }
  }
  async function openEditor(target: EditorTarget, current: () => boolean, locale = targetLocale, suggestedText?: string) {
    setEditorResources(null);
    const first = await commands.history({ ...context, unitId: target.unitId, locale, afterOrdinal: 0, limit: 1 });
    const after = Math.max(0, first.total - 100);
    const next = await commands.history({ ...context, unitId: target.unitId, locale, afterOrdinal: after, limit: 100 });
    const [terms, note] = await Promise.allSettled([
      resourceCommands.resolve({ ...context, unitId: target.unitId, locale }),
      resourceCommands.context({ ...context, unitId: target.unitId, locale }),
    ]);
    if (current()) {
      setEditorTarget(target); setHistory(next); setPendingSave(null); setNewerDraftSaved(false);
      setEditorResources({ terms: terms.status === "fulfilled" ? terms.value : null, context: note.status === "fulfilled" ? note.value : null, failed: terms.status === "rejected" || note.status === "rejected" });
      draftRef.current = suggestedText ?? next.currentText ?? ""; setDraft(draftRef.current); setTab("edit");
    }
  }
  function chooseEditor(target: EditorTarget) {
    if (pendingSave) { setFailure("outcome-unknown"); return; }
    if (dirty) { setLeaveIntent({ kind: "switch", target }); return; }
    void perform(current => openEditor(target, current));
  }
  async function saveDraft(current: () => boolean) {
    if (!editorTarget || !history) return;
    const submitted = draftRef.current;
    const request = pendingSave ?? {
      ...context, actionId: await execution.identity(context), unitId: editorTarget.unitId,
      locale: targetLocale, sourceRevisionId: editorTarget.sourceRevisionId,
      expectedSelectionId: history.current?.eventId ?? null, text: submitted,
    };
    if (!current()) return;
    setPendingSave(request);
    try {
      await commands.save(request);
    } catch (error) {
      if (!errorStage(error).includes("unknown") && current()) setPendingSave(null);
      throw error;
    }
    const first = await commands.history({ ...context, unitId: request.unitId, locale: request.locale, afterOrdinal: 0, limit: 1 });
    const next = await commands.history({ ...context, unitId: request.unitId, locale: request.locale, afterOrdinal: Math.max(0, first.total - 100), limit: 100 });
    if (current() && editorTarget.unitId === request.unitId && targetLocale === request.locale) {
      setHistory(next); setPendingSave(null);
      const newer = draftRef.current !== request.text;
      setNewerDraftSaved(newer);
      if (!newer) { draftRef.current = next.currentText ?? ""; setDraft(draftRef.current); }
    }
  }
  async function selectRevision(revisionId: string, current: () => boolean) {
    if (!editorTarget || !history || dirty || pendingSave) return;
    const request = { ...context, actionId: await execution.identity(context), unitId: editorTarget.unitId,
      locale: targetLocale, sourceRevisionId: editorTarget.sourceRevisionId,
      expectedSelectionId: history.current?.eventId ?? null, revisionId };
    await commands.select(request);
    const next = await commands.history({ ...context, unitId: request.unitId, locale: request.locale,
      afterOrdinal: Math.max(0, history.total - 100), limit: 100 });
    if (current()) { setHistory(next); draftRef.current = next.currentText ?? ""; setDraft(draftRef.current); }
  }
  async function refreshHistory(current: () => boolean) {
    if (!editorTarget) return;
    const first = await commands.history({ ...context, unitId: editorTarget.unitId, locale: targetLocale, afterOrdinal: 0, limit: 1 });
    const next = await commands.history({ ...context, unitId: editorTarget.unitId, locale: targetLocale, afterOrdinal: Math.max(0, first.total - 100), limit: 100 });
    if (current()) setHistory(next);
  }
  function requestClose() {
    if (running.current || leaveIntent) return;
    if (pendingSave || uncertain.length) { setFailure("outcome-unknown"); return; }
    if (dirty) setLeaveIntent({ kind: "close" });
    else { generation.current++; setOpen(false); }
  }
  function resolveLeave(discard: boolean) {
    const intent = leaveIntent;
    setLeaveIntent(null);
    if (!discard) { leaveResolver.current?.(false); leaveResolver.current = null; return; }
    setPendingSave(null); setHistory(null); setEditorTarget(null); setDraft(""); draftRef.current = "";
    if (intent?.kind === "project") { leaveResolver.current?.(true); leaveResolver.current = null; }
    if (intent?.kind === "close") setOpen(false);
    if (intent?.kind === "switch") void perform(current => openEditor(intent.target, current));
  }
  async function saveAndLeave(current: () => boolean) {
    const intent = leaveIntent;
    const submitted = pendingSave?.text ?? draftRef.current;
    await saveDraft(current);
    if (!current() || draftRef.current !== submitted) return;
    setLeaveIntent(null);
    if (intent?.kind === "project") { leaveResolver.current?.(true); leaveResolver.current = null; }
    if (intent?.kind === "close") setOpen(false);
    if (intent?.kind === "switch") await openEditor(intent.target, current);
  }
  const canImport = Boolean(sourcePage && targetLocale && fileName);
  return <>
    <Dialog.Root open={open} onOpenChange={value => { if (value) setOpen(true); else requestClose(); }}>
      <Dialog.Trigger className="navigation-item" disabled={disabled}>{t("translation.title")}</Dialog.Trigger>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="execution-dialog source-dialog">
        <div className="execution-heading"><div><Dialog.Title ref={heading} tabIndex={-1}>{t("translation.title")}</Dialog.Title><Dialog.Description>{t("translation.description")}</Dialog.Description></div><Dialog.Close className="secondary-button">{t("execution.back")}</Dialog.Close></div>
        <div className="execution-content" aria-busy={busy}>
          {failure ? <div role="alert"><p>{t(`translation.errors.${errorKey(failure)}`)}</p><details><summary>{t("execution.diagnostic")}</summary><code>{failure}</code></details></div> : null}
          {busy ? <p role="status">{t("execution.working")}</p> : null}
          {sourceMissing ? <p role="status">{t("translation.noSource")}</p> : null}
          {!project.metadata.targetLocales.length ? <p role="status">{t("translation.noTargets")}</p> : null}
          <div className="execution-actions"><button className="secondary-button" aria-current={tab === "import" ? "page" : undefined} onClick={() => setTab("import")}>{t("translation.importTab")}</button><button className="secondary-button" aria-current={tab === "edit" ? "page" : undefined} onClick={() => setTab("edit")}>{t("translation.editTab")}</button></div>
          {sourcePage && project.metadata.targetLocales.length ? <label>{t("translation.target")}<select value={targetLocale} disabled={busy || dirty || !!pendingSave || uncertain.length > 0} onChange={event => changeTarget(event.target.value)}>{project.metadata.targetLocales.map(locale => <option key={locale} value={locale}>{locale}</option>)}</select></label> : null}
          {tab === "import" && sourcePage && targetLocale ? <>
            <section><button className="secondary-button" disabled={busy || uncertain.length > 0} onClick={() => void perform(chooseFolder)}>{t("translation.chooseFolder")}</button>
              {folder ? <><p>{t("translation.folder", { name: folder.folderName })}</p>{files.length ? <label>{t("translation.file")}<select value={fileName} disabled={busy || uncertain.length > 0} onChange={event => { setFileName(event.target.value); setPreflight(null); setConfirmed(false); setAttempt(null); setPreview(null); setPendingStart(null); }}>{files.map(file => <option key={file} value={file}>{file}</option>)}</select></label> : <p role="status">{t("translation.noFiles")}</p>}
                <button className="secondary-button" disabled={busy || !canImport} onClick={() => void perform(async current => { const checked = await commands.preflight({ ...context, selectionId: folder.selectionId, fileName, targetLocale }); if (current()) { setPreflight(checked); setConfirmed(false); } })}>{t("translation.inspect")}</button>
              </> : null}
              {preflight ? <><p>{t("translation.preflight", { count: preflight.count, file: preflight.fileName })}</p><label className="source-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{t("translation.languageConfirm", { file: preflight.fileName, target: preflight.targetLocale, declared: preflight.declaredLocale })}</label>
                <button className="primary-button" disabled={busy || !confirmed || !!pendingStart || !!attempt} onClick={() => void perform(async current => { const request: TranslationStartRequest = { ...context, selectionId: folder!.selectionId, fileName: preflight.fileName, targetLocale: preflight.targetLocale, languageConfirmed: true, expectedFileDigest: preflight.fileDigest, expectedSourceSnapshotId: preflight.sourceSnapshotId, attemptId: await execution.identity(context) }; if (!current()) return; setPendingStart(request); await startImport(request, current); })}>{t("translation.start")}</button></> : null}
              {pendingStart ? <div role="status"><p>{t("translation.startUnknown")}</p><button className="secondary-button" disabled={busy} onClick={() => void perform(current => startImport(pendingStart, current))}>{t("translation.checkStart")}</button></div> : null}
              {attempt && !preview ? <p role="status">{t("translation.progress", { count: preflight?.count ?? 0 })}</p> : null}
            </section>
            {preview ? <section><h3>{t("translation.preview")}</h3><p>{t("translation.counts", { unique: String(preview.unique), unmatched: String(preview.unmatched), conflicts: String(preview.selectedConflicts), changed: String(preview.sourceChanged) })}</p><p>{preview.logicalPath} · {preview.targetLocale}</p>{preview.sourceChanged ? <p role="alert">{t("translation.sourceChanged")}</p> : null}
              <div className="source-table-scroll"><table className="source-table"><caption>{t("translation.page", { first: String((preview.rows[0]?.entry.ordinal ?? 0) + 1), last: String((preview.rows.at(-1)?.entry.ordinal ?? -1) + 1), total: String(preview.total) })}</caption><thead><tr><th scope="col">{t("translation.key")}</th><th scope="col">{t("translation.sourceText")}</th><th scope="col">{t("translation.importedText")}</th><th scope="col">{t("translation.selectedText")}</th><th scope="col">{t("translation.match")}</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.entry.ordinal}><th scope="row">{row.entry.nativeKey}<details><summary>{t("translation.evidence")}</summary><p>{preview.logicalPath} · {row.entry.valueByteRange[0]}–{row.entry.valueByteRange[1]}</p><code>{preview.fileDigest}</code></details></th><td><pre>{row.sourceText === "" ? t("translation.empty") : row.sourceText}</pre></td><td><pre>{row.entry.text === "" ? t("translation.empty") : row.entry.text}</pre></td><td><pre>{row.currentText === "" ? t("translation.empty") : row.currentText}</pre></td><td>{t(`translation.status.${row.status}`)}{row.status === "unique" || row.status === "selected-conflict" ? <div className="translation-row-actions"><button className="text-button" disabled={busy} onClick={() => setRowAction({ row, decision: "candidate-only" })}>{t("translation.addCandidate")}</button><button className="text-button" disabled={busy} onClick={() => setRowAction({ row, decision: row.status === "unique" ? "select-if-empty" : "replace" })}>{t(row.status === "unique" ? "translation.selectImported" : "translation.replaceSelected")}</button></div> : null}{targetFromTranslation(row) ? <button className="text-button" disabled={busy} onClick={() => chooseEditor(targetFromTranslation(row)!)}>{t("translation.openEditor")}</button> : null}</td></tr>)}</tbody></table></div>
              <div className="execution-actions"><button className="secondary-button" disabled={busy} onClick={() => void perform(current => loadPreview(0, null, current))}>{t("translation.refreshPreview")}</button>{preview.nextOrdinal !== null ? <button className="secondary-button" disabled={busy} onClick={() => void perform(current => loadPreview(preview.nextOrdinal!, preview.basis, current))}>{t("execution.nextPage")}</button> : null}</div>
              <p>{t("translation.applyHelp")}</p><label className="source-check"><input type="checkbox" checked={selectIfEmpty} disabled={busy} onChange={event => setSelectIfEmpty(event.target.checked)} />{t("translation.selectIfEmpty")}</label>
              <button className="primary-button" disabled={busy || preview.unique === 0 || preview.sourceChanged > 0} onClick={() => void perform(applyBatch)}>{t("translation.apply", { count: preview.unique })}</button>
              {batchProgress ? <p role="status">{t("translation.applying", { done: String(batchProgress.done), total: String(batchProgress.total) })}</p> : null}
              {batchOutcome ? <><p role="status">{t("translation.outcome", { applied: String(batchOutcome.applied), conflicted: String(batchOutcome.conflicted), failed: String(batchOutcome.failed), unknown: String(batchOutcome.unknown) })}</p><details><summary>{t("translation.batchDetails")}</summary><ul>{batchDetails.map((item, index) => <li key={`${item.key}:${index}`}>{item.key}: {t(`translation.batchStatus.${item.status}`)}</li>)}</ul></details></> : null}
              {uncertain.map(request => <div key={request.actionId} role="status"><button className="secondary-button" disabled={busy} onClick={() => void perform(async current => { const receipt = await execution.receipt({ ...context, actionId: request.actionId }); if (current()) { setReceiptMessage(receipt ? "found" : "missing"); if (receipt) { setUncertain(list => list.filter(item => item.actionId !== request.actionId)); await loadPreview(0, null, current); } } })}>{t("translation.checkReceipt")}</button><button className="secondary-button" disabled={busy} onClick={() => void perform(async current => { await commands.prepare(request); await execution.adopt({ ...context, actionId: request.actionId }); if (current()) { setUncertain(list => list.filter(item => item.actionId !== request.actionId)); await loadPreview(0, null, current); } })}>{t("translation.retryAction")}</button></div>)}
              {receiptMessage ? <p role="status">{t(receiptMessage === "found" ? "translation.receiptFound" : "translation.receiptMissing")}</p> : null}
            </section> : null}
          </> : null}
          {tab === "edit" && sourcePage && targetLocale ? <section><h3>{t("translation.editor")}</h3><p>{t("translation.chooseUnit")}</p>{sourcePage.rows.length ? <div className="source-table-scroll"><ul>{sourcePage.rows.map(row => <li key={row.occurrence.ordinal}><button className="text-button" disabled={busy || !row.unitId} onClick={() => { const target = targetFromSource(row); if (target) chooseEditor(target); }}>{row.occurrence.key}</button></li>)}</ul></div> : <p>{t("translation.noUnit")}</p>}
            <div className="execution-actions"><button className="secondary-button" disabled={busy || sourcePage.rows[0]?.occurrence.ordinal === 0} onClick={() => void perform(async current => { const next = await sourceCommands.content({ ...context, snapshotId: sourcePage.snapshotId!, after: 0, limit: 50 }); if (current()) setSourcePage(next); })}>{t("execution.firstPage")}</button>{sourcePage.nextOrdinal !== null ? <button className="secondary-button" disabled={busy} onClick={() => void perform(async current => { const next = await sourceCommands.content({ ...context, snapshotId: sourcePage.snapshotId!, after: sourcePage.nextOrdinal!, limit: 50 }); if (current()) setSourcePage(next); })}>{t("execution.nextPage")}</button> : null}</div>
            {editorTarget && history ? <div className="translation-editor"><h4>{editorTarget.key}</h4><p>{t("translation.sourceText")}: {editorTarget.sourceText === "" ? t("translation.empty") : editorTarget.sourceText}</p><p>{t("translation.current")}: {history.current ? (history.currentText === "" ? t("translation.empty") : history.currentText) : t("translation.noSelection")}</p>
              <section aria-label={t("resource.editorReference")}><h5>{t("resource.editorReference")}</h5><p>{t("resource.editorReferenceHelp")}</p>
                {editorResources?.failed ? <p role="status">{t("resource.editorLoadFailed")}</p> : null}
                {editorResources?.terms ? <><h6>{t("resource.applicableTerms")}</h6>{editorResources.terms.entries.length ? <ul>{editorResources.terms.entries.map(entry => <li key={entry.source}>{entry.source}: {entry.selected ? <>{entry.selected.target} · {entry.selected.originKind === "manual" ? t("resource.manual") : t("resource.external")} · {entry.selected.reason}</> : t("resource.conflict")}</li>)}</ul> : <p>{t("resource.noApplicableTerms")}</p>}</> : null}
                {editorResources && !editorResources.failed ? <><h6>{t("resource.manualContext")}</h6>{editorResources.context ? <p>{editorResources.context.text} · {editorResources.context.reason}</p> : <p>{t("resource.noManualContext")}</p>}</> : null}
              </section>
              <label>{t("translation.draft")}<textarea value={draft} onChange={event => { draftRef.current = event.target.value; setDraft(event.target.value); setNewerDraftSaved(false); }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!busy) void perform(saveDraft); } }} /></label><p>{t("translation.draftHelp")}</p>
              <div className="execution-actions"><button className="primary-button" disabled={busy || (!dirty && !pendingSave)} onClick={() => void perform(saveDraft)}>{pendingSave ? t("translation.retryAction") : t("translation.save")}</button><button className="text-button" disabled={busy || !dirty || !!pendingSave} onClick={() => { draftRef.current = history.currentText ?? ""; setDraft(draftRef.current); }}>{t("translation.discardDraft")}</button></div>
              {newerDraftSaved ? <p role="status">{t("translation.savedNewerDraft")}</p> : null}
              <div className="execution-section-heading"><h4>{t("translation.history")}</h4><button className="text-button" disabled={busy || !!pendingSave} onClick={() => void perform(refreshHistory)}>{t("translation.refreshHistory")}</button></div>{history.rows.length ? <ul>{history.rows.map(revision => <li key={revision.revisionId}><p>{revision.ordinal}: {revision.text === "" ? t("translation.empty") : revision.text}</p><p>{revision.originKind === "import" ? t("translation.importOrigin", { file: revision.logicalPath ?? "" }) : t("translation.manualOrigin")}</p>{revision.originKind === "import" ? <details><summary>{t("translation.evidence")}</summary><p>{t("translation.key")}: {revision.nativeKey}</p><p>{t("translation.file")}: {revision.logicalPath}</p><code>{revision.fileDigest}</code></details> : null}<button className="secondary-button" disabled={busy || dirty || !!pendingSave || history.current?.revisionId === revision.revisionId} onClick={() => void perform(current => selectRevision(revision.revisionId, current))}>{t("translation.selectRevision")}</button></li>)}</ul> : <p>{t("translation.noHistory")}</p>}
              <div className="execution-actions"><button className="secondary-button" disabled={busy || history.rows[0]?.ordinal === 1} onClick={() => void perform(async current => { const next = await commands.history({ ...context, unitId: editorTarget.unitId, locale: targetLocale, afterOrdinal: Math.max(0, (history.rows[0]?.ordinal ?? 1) - 101), limit: 100 }); if (current()) setHistory(next); })}>{t("translation.earlier")}</button>{history.nextOrdinal !== null ? <button className="secondary-button" disabled={busy} onClick={() => void perform(async current => { const next = await commands.history({ ...context, unitId: editorTarget.unitId, locale: targetLocale, afterOrdinal: history.nextOrdinal!, limit: 100 }); if (current()) setHistory(next); })}>{t("translation.later")}</button> : null}</div>
            </div> : null}
          </section> : null}
        </div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <Dialog.Root open={rowAction !== null} onOpenChange={value => { if (!value && !busy) setRowAction(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop" /><Dialog.Content className="confirm-dialog execution-confirm-dialog" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}><Dialog.Title>{t(rowAction?.decision === "replace" ? "translation.replaceSelected" : rowAction?.decision === "select-if-empty" ? "translation.selectImported" : "translation.addCandidate")}</Dialog.Title><Dialog.Description>{t("translation.rowActionHelp", { key: rowAction?.row.entry.nativeKey ?? "" })}</Dialog.Description>{rowAction ? <div className="translation-action-compare"><p>{t("translation.importedText")}: {rowAction.row.entry.text === "" ? t("translation.empty") : rowAction.row.entry.text}</p><p>{t("translation.selectedText")}: {rowAction.row.currentText === null ? t("translation.noSelection") : rowAction.row.currentText === "" ? t("translation.empty") : rowAction.row.currentText}</p></div> : null}{failure ? <p role="alert">{t(`translation.errors.${errorKey(failure)}`)}</p> : null}<div className="form-actions"><button className="secondary-button" disabled={busy} onClick={() => setRowAction(null)}>{t("execution.back")}</button><button className="primary-button" disabled={busy} onClick={() => void perform(applyRow)}>{t(rowAction?.decision === "replace" ? "translation.replaceSelected" : rowAction?.decision === "select-if-empty" ? "translation.selectImported" : "translation.addCandidate")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={leaveIntent !== null} onOpenChange={value => { if (!value && !busy) resolveLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}><Dialog.Title>{t("translation.leaveTitle")}</Dialog.Title><Dialog.Description>{t("translation.leaveHelp")}</Dialog.Description>{failure ? <p role="alert">{t(`translation.errors.${errorKey(failure)}`)}</p> : null}{newerDraftSaved ? <p role="status">{t("translation.savedNewerDraft")}</p> : null}<div className="form-actions"><button className="secondary-button" disabled={busy} onClick={() => resolveLeave(false)}>{t("translation.stay")}</button><button className="secondary-button" disabled={busy || !!pendingSave} onClick={() => resolveLeave(true)}>{t("translation.discard")}</button><button className="primary-button" disabled={busy} onClick={() => void perform(saveAndLeave)}>{pendingSave ? t("translation.retryAction") : t("translation.saveAndContinue")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
