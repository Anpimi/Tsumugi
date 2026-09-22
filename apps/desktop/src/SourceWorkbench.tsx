import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { CommandError, ProjectView } from "./projectCommands";
import type { UiMessages } from "./i18n/types";
import { pollExecutionProjection } from "./executionCommands";
import { executionCommands as execution, executionContext, type AttemptDetail } from "./executionCommands";
import { sourceCommands as commands, type ContentPage, type Preflight, type SourceAdoptRequest, type SourceSelection, type StartRequest, type IntegrationDescriptor } from "./sourceCommands";

export interface SourceHandle { showAttempt: (id: string) => void; allowLeave: () => Promise<boolean> }
export function SourceWorkbench({ project, disabled, ref }: { project: ProjectView; disabled: boolean; ref?: Ref<SourceHandle> }) {
  const { t } = useTranslation();
  const context = executionContext(project);
  const [open, setOpen] = useState(false);
  const [integration, setIntegration] = useState<IntegrationDescriptor | null>(null);
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [declared, setDeclared] = useState(false);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [attempt, setAttempt] = useState<string | null>(null);
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [page, setPage] = useState<ContentPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pendingStart, setPendingStart] = useState<StartRequest | null>(null);
  const [pendingApply, setPendingApply] = useState<SourceAdoptRequest | null>(null);
  const [receiptChecked, setReceiptChecked] = useState(false);
  const [leave, setLeave] = useState(false);
  const leaveResolver = useRef<((answer: boolean) => void) | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const mutation = useRef(false);
  const first = useRef<HTMLHeadingElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; leaveResolver.current?.(false); }; }, []);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    void commands.integration(context).then(value => { if (!stale) setIntegration(value); }, error => { if (!stale) showError(error); });
    return () => { stale = true; };
  }, [open, project.sessionToken]);
  useImperativeHandle(ref, () => ({
    showAttempt(id) { if (mutation.current || pendingApply || pendingStart) { setOpen(true); return; } sequence.current++; setAttempt(id); setPage(null); setDetail(null); setConfirmed(false); setFailure(null); setOpen(true); },
    allowLeave() { if (!selection && !busy && !pendingApply && !pendingStart) return Promise.resolve(true); setLeave(true); return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; }); },
  }));
  function showError(error: unknown) {
    const value = error as Partial<CommandError> | null;
    setFailure(value?.field ?? value?.code ?? "failed");
  }
  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true;
    const ticket = ++sequence.current;
    const current = () => mounted.current && sequence.current === ticket;
    setBusy(true); setFailure(null);
    try { await work(current); } catch (error) { if (current()) showError(error); }
    finally { mutation.current = false; if (mounted.current) setBusy(false); }
  }
  // Poll persisted execution. Closing this view does not cancel a task.
  useEffect(() => {
    if (!open || busy || !attempt || page) return;
    const ticket = ++sequence.current;
    const current = () => mounted.current && ticket === sequence.current;
    async function read() {
      try {
        const next = await execution.attempt({ ...context, attemptId: attempt!, offset: 0, limit: 1 });
        if (!current()) return;
        setDetail(next);
        const result = next.items[0];
        if (result?.resultId && result.status.validation === "valid" && result.status.execution === "succeeded") {
          const preview = await commands.preview({ ...context, attemptId: attempt!, resultId: result.resultId, after: 0, limit: 50 });
          if (current()) { setPage(preview); setFailure(null); }
        } else if (result?.status.execution === "failed" || result?.status.validation === "invalid") {
          setFailure(result.status.diagnostic ?? "output-invalid");
        } else if (result?.status.execution === "unknown" || result?.status.execution === "cancelled-before-dispatch") {
          setFailure(result.status.execution);
        } else return true;
      } catch (error) { if (current()) showError(error); }
      return false;
    }
    const stop = pollExecutionProjection(read, current, 750);
    return () => { sequence.current++; stop(); };
  }, [open, busy, attempt, page, project.sessionToken]);
  useEffect(() => { if (page) first.current?.focus(); }, [page]);
  async function loadCurrent(current: () => boolean) {
    const scope = await commands.scope(context);
    const next = scope.currentSnapshot ? await commands.content({ ...context, snapshotId: scope.currentSnapshot, after: 0, limit: 50 }) : null;
    if (current()) { setPage(next); if (next) { setAttempt(null); setSelection(null); setPreflight(null); } }
  }
  async function start(request: StartRequest, current: () => boolean) {
    const id = await commands.start(request);
    if (current()) { setAttempt(id); setPendingStart(null); setSelection(null); setPreflight(null); setPage(null); setDetail(null); }
  }
  async function applied(request: SourceAdoptRequest, current: () => boolean) {
    await commands.prepare(request);
    const receipt = await execution.adopt({ ...context, actionId: request.actionId });
    const snapshot = receipt.changes.find(change => change.kind === "source-snapshot")?.id;
    if (!snapshot) throw { code: "output-invalid" };
    const next = await commands.content({ ...context, snapshotId: snapshot, after: 0, limit: 50 });
    if (current()) { setPage(next); setPendingApply(null); setAttempt(null); setConfirmed(false); setSelection(null); }
  }
  const knownErrors: Record<string, keyof UiMessages["source"]["errors"]> = {
    "unsupported-encoding": "encoding", "source-changed": "changed", "duplicate-native-key": "duplicate", "empty-source": "empty", "capture-timeout": "timeout", "extract-timeout": "unknown", "source-corrupt": "invalid", "stale-preview": "conflict", "language-required": "language",
    "unsupported-format": "format", "missing-companion": "missing", "language-conflict": "language", "limit-exceeded": "limit", "input-limit": "limit", "unauthorized-selection": "selection", "session-invalid": "selection", "input-busy": "busy", busy: "busy", "source-already-present": "conflict", "dependency-conflict": "conflict", "output-invalid": "invalid", "invalid-structure": "invalid", "invalid-json": "invalid", "source-value-not-string": "stringValue", cancelled: "cancelled", "cancelled-before-dispatch": "cancelled", unknown: "unknown", "outcome-unknown": "unknown",
  };
  const locked = busy || pendingStart !== null || pendingApply !== null;
  const warnings = page?.diagnostics ?? preflight?.diagnostics ?? [];
  return <>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="navigation-item" disabled={disabled} onClick={() => { if (!attempt && !page) void perform(loadCurrent); }}>{t("source.title")}</Dialog.Trigger>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="execution-dialog source-dialog">
        <div className="execution-heading"><div><Dialog.Title>{t("source.title")}</Dialog.Title><Dialog.Description>{t("source.description")}</Dialog.Description></div><Dialog.Close className="secondary-button">{t("execution.back")}</Dialog.Close></div>
        <div className="execution-content" aria-busy={busy}>
          {integration ? <><p>{t("source.profile", { version: integration.version, profile: integration.formatProfiles.join(", ") })}</p>{!integration.available ? <p role="alert">{t("source.unavailable")}</p> : null}</> : <p role="status">{t("source.loadingIntegration")}</p>}
          {failure ? <div role="alert"><p>{t(`source.errors.${knownErrors[failure] ?? "failed"}`)}</p><details><summary>{t("execution.diagnostic")}</summary><code>{failure}</code></details></div> : null}
          {busy ? <p role="status">{t("execution.working")}</p> : null}
          {warnings.includes("source-template") ? <p role="status">{t("source.templateWarning")}</p> : null}
          {!page?.snapshotId && !page?.scope.currentSnapshot ? <section aria-label={t("source.select")}>
            <p>{t("source.support")}</p>
            <button className="secondary-button" disabled={locked || !integration?.available} onClick={() => void perform(async current => {
              const next = await commands.select(context);
              if (current()) { setSelection(next); setPreflight(null); setDeclared(false); setConfirmed(false); if (next) { setPage(null); setAttempt(null); setDetail(null); } }
            })}>{t("source.select")}</button>
            {selection ? <>
              <p>{selection.folderName}</p>
              <label className="source-check"><input type="checkbox" checked={declared} disabled={locked} onChange={event => { setDeclared(event.target.checked); setPreflight(null); }} />{t("source.language", { language: project.metadata.sourceLocale })}</label>
              <p>{t("source.languageHelp")}</p>
              <button className="secondary-button" disabled={locked || !declared} onClick={() => void perform(async current => {
                const result = await commands.preflight({ ...context, selectionId: selection.selectionId, sourceLanguage: project.metadata.sourceLocale });
                if (current()) setPreflight(result);
              })}>{t("source.preflight")}</button>
              {preflight ? <><p>{t("source.preflightResult", { namespace: preflight.namespace, count: preflight.count })}</p>
                <button className="primary-button" disabled={locked} onClick={() => void perform(async current => {
                  const request = { ...context, selectionId: selection.selectionId, sourceLanguage: project.metadata.sourceLocale, attemptId: await execution.identity(context) };
                  if (!current()) return;
                  setPendingStart(request); await start(request, current);
                })}>{t("source.start")}</button></> : null}
              <button className="text-button" disabled={locked} onClick={() => void perform(async current => { await commands.cancelCapture(context); if (current()) { setSelection(null); setPreflight(null); setDeclared(false); } })}>{t("source.discard")}</button>
            </> : null}
          </section> : null}
          {pendingStart ? <section><p>{t("source.startUnknown")}</p><button className="secondary-button" disabled={busy} onClick={() => void perform(current => start(pendingStart, current))}>{t("source.checkStart")}</button></section> : null}
          {attempt && !page ? <section><p role="status">{t("source.savedTask")}</p><p>{t("source.taskHelp")}</p>
            {detail ? <button className="secondary-button" disabled={locked} onClick={() => void perform(async () => { await execution.cancel({ ...context, taskId: detail.taskId, requestId: await execution.identity(context) }); })}>{t("execution.cancel")}</button> : null}
            <button className="secondary-button" disabled={locked} onClick={() => void perform(async current => { if (current()) setDetail(null); })}>{t("execution.refresh")}</button>
          </section> : null}
          {page ? <section>
            <h3 ref={first} tabIndex={-1}>{t(page.snapshotId ? "source.imported" : "source.preview")}</h3>
            <p role="status">{t("source.range", { namespace: page.namespace, count: page.total, language: page.confirmation.sourceLanguage })}</p>
            <ul>{page.coverage.map(file => <li key={file.artifactId}>{file.logicalPath}<details><summary>{t("source.fingerprint")}</summary><code>{file.sha256}</code></details></li>)}</ul>
            <p>{t("source.identityHelp")}</p>
            <div className="source-table-scroll"><table className="source-table"><caption>{t("source.pageRange", { first: String((page.rows[0]?.occurrence.ordinal ?? 0) + 1), last: String((page.rows.at(-1)?.occurrence.ordinal ?? -1) + 1), total: String(page.total) })}</caption><thead><tr><th scope="col">{t("source.key")}</th><th scope="col">{t("source.text")}</th></tr></thead><tbody>{page.rows.map(row => <tr key={row.occurrence.ordinal}><th scope="row">{row.occurrence.key}<details><summary>{t("source.origin")}</summary><p>{row.occurrence.namespace}</p><p>{t("source.bytes", { start: String(row.occurrence.valueByteRange[0]), end: String(row.occurrence.valueByteRange[1]) })}</p>{row.unitId ? <code>{row.unitId}</code> : null}</details></th><td><pre>{row.occurrence.text || t("source.emptyText")}</pre></td></tr>)}</tbody></table></div>
            <div className="execution-actions">{[0, page.nextOrdinal].map((after, index) => after !== null ? <button className="secondary-button" key={index} disabled={locked || (index === 0 && page.rows[0]?.occurrence.ordinal === 0)} onClick={() => void perform(async current => {
              const next = page.snapshotId ? await commands.content({ ...context, snapshotId: page.snapshotId, after, limit: 50 }) : await commands.preview({ ...context, attemptId: page.attemptId, resultId: page.resultId, after, limit: 50 });
              if (current()) setPage(next);
            })}>{t(index === 0 ? "execution.firstPage" : "execution.nextPage")}</button> : null)}</div>
            {!page.snapshotId ? <>
              <label className="source-check"><input type="checkbox" disabled={locked || page.scope.currentSnapshot !== null} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("source.confirm", { count: page.total, language: page.confirmation.sourceLanguage })}</label>
              <p>{t("source.applyHelp")}</p>
              {page.scope.currentSnapshot ? <p>{t("source.errors.conflict")}</p> : null}
              <button className="primary-button" disabled={locked || !confirmed || page.scope.currentSnapshot !== null} onClick={() => void perform(async current => {
                const request = { ...context, attemptId: page.attemptId, resultId: page.resultId, actionId: await execution.identity(context), confirmation: page.confirmation };
                if (!current()) return;
                setPendingApply(request); setReceiptChecked(false); await applied(request, current);
              })}>{t("source.apply")}</button>
            </> : null}
          </section> : null}
          {pendingApply ? <section><p>{t("source.applyUnknown")}</p><button className="secondary-button" disabled={busy} onClick={() => void perform(async current => {
            const receipt = await execution.receipt({ ...context, actionId: pendingApply.actionId });
            if (!current()) return;
            setReceiptChecked(true);
            if (receipt) { await loadCurrent(current); if (current()) setPendingApply(null); }
          })}>{t("execution.checkReceipt")}</button>{receiptChecked ? <button className="secondary-button" disabled={busy} onClick={() => void perform(current => applied(pendingApply, current))}>{t("execution.retryAdoption")}</button> : null}
            <button className="text-button" disabled={busy} onClick={() => { setPendingApply(null); setConfirmed(false); }}>{t("execution.keepOutput")}</button>
          </section> : null}
          <button className="text-button" disabled={locked} onClick={() => void perform(loadCurrent)}>{t("source.viewCurrent")}</button>
          <p>{t("source.draftHelp")}</p>
        </div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <Dialog.Root open={leave} onOpenChange={next => { if (!next) { setLeave(false); leaveResolver.current?.(false); leaveResolver.current = null; } }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()}>
        <Dialog.Title>{t("source.leaveTitle")}</Dialog.Title><Dialog.Description>{t("source.leaveHelp")}</Dialog.Description>
        <div className="form-actions"><button className="secondary-button" onClick={() => { setLeave(false); leaveResolver.current?.(false); leaveResolver.current = null; }}>{t("source.keep")}</button>
          <button className="primary-button" onClick={() => { sequence.current++; void commands.cancelCapture(context).then(() => { setSelection(null); setPreflight(null); setLeave(false); leaveResolver.current?.(true); leaveResolver.current = null; }, error => { showError(error); setLeave(false); setOpen(true); leaveResolver.current?.(false); leaveResolver.current = null; }); }}>{t("source.leave")}</button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </>;
}
