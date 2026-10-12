import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { executionCommands, executionContext } from "./executionCommands";
import { releaseCommands, type ExportRequest, type DeliveryPreview, type DeliverySelection, type DeliveryView, type ReleaseView } from "./releaseCommands";
import { PluginBuildControls, type PluginBuildHandle, type PluginBuildState } from "./PluginBuildControls";
function errorCode(error: unknown) { return (error as { code?: string } | null)?.code ?? "storage-failed"; }
const errorReasons = {
  "destination-conflict": "release.errorDestination",
  "dependency-conflict": "release.errorDependency",
  "invalid-input": "release.errorInput",
  "permission-denied": "release.errorPermission",
  "session-invalid": "release.errorSession",
  "limit-exceeded": "release.errorLimit",
  "outcome-unknown": "release.errorOutcomeUnknown",
} as const;

export interface ReleaseHandle { allowLeave: () => Promise<boolean>; allowNavigate: () => Promise<boolean>; showSavedBuild: (attemptId: string) => boolean }
type PendingRelease = { kind: "export"; request: ExportRequest };
export function ReleaseWorkbench({ project, disabled, ref, onOpenTranslation }: { project: ProjectView; disabled: boolean; ref?: Ref<ReleaseHandle>; onOpenTranslation?: (target: import("./TranslationWorkbench").EditorTarget, locale: string) => boolean }) {
  const { t } = useTranslation();
  const session = executionContext(project);
  const [open, setOpen] = useWorkbenchView("release");
  const buildControls = useRef<PluginBuildHandle>(null);
  const [buildState, setBuildState] = useState<PluginBuildState>({ busy: false, pending: false });
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [releases, setReleases] = useState<ReleaseView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selection, setSelection] = useState<DeliverySelection | null>(null);
  const [preview, setPreview] = useState<DeliveryPreview | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [deliveries, setDeliveries] = useState<DeliveryView[]>([]);
  const [result, setResult] = useState<DeliveryView | null>(null);
  const [errorValue, setError] = useState<CommandFailure | null>(null);
  const error = typeof errorValue === "string" ? errorValue : errorValue?.code ?? null;
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingRelease | null>(null);
  const pendingRef = useRef(pending);
  const [exportMissing, setExportMissing] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const mutating = useRef(false);
  useImperativeHandle(ref, () => ({
    showSavedBuild(id) {
      if (disabled || mutating.current || pendingRef.current || !buildControls.current?.showSavedBuild(id)) return false;
      setOpen(true);
      return true;
    },
    allowLeave() {
      if (mutating.current || pendingRef.current) { setOpen(true); return Promise.resolve(false); }
      return buildControls.current?.allowLeave() ?? Promise.resolve(true);
    },
    allowNavigate: () => mutating.current || pendingRef.current ? Promise.resolve(false) : buildControls.current?.allowNavigate() ?? Promise.resolve(true),
  }));
  const errorRegion = useRef<HTMLDivElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { if (error || historyError) { errorRegion.current?.focus(); errorRegion.current?.scrollIntoView({ block: "nearest" }); } }, [error, historyError]);
  useEffect(() => {
    if (!open) return;
    const ticket = ++generation.current;
    void releaseCommands.releases(session).then(rows => {
      if (mounted.current && ticket === generation.current) { setReleases(rows); setHistoryLoaded(true); }
    }).catch(failure => { if (mounted.current && ticket === generation.current) setError(commandFailure(failure, errorCode(failure))); });
    return () => { generation.current++; };
  }, [open, project.sessionToken]);
  const chosen = releases.find(item => item.releaseId === selected) ?? null;

  async function run(work: (ticket: number) => Promise<void>) {
    if (mutating.current) return;
    mutating.current = true; const ticket = ++generation.current; setBusy(true); setError(null);
    try { await work(ticket); }
    catch (failure) { if (mounted.current && ticket === generation.current) {
      const notice = commandFailure(failure, errorCode(failure));
      setError(pendingRef.current && hasUnknownOutcome(failure) && typeof notice === "string" ? "outcome-unknown" : notice);
    } }
    finally { mutating.current = false; if (mounted.current && ticket === generation.current) setBusy(false); }
  }
  function current(ticket: number) { return mounted.current && ticket === generation.current; }
  function updatePending(value: PendingRelease | null) { pendingRef.current = value; setPending(value); }
  const locked = busy || !!pending || buildState.busy || buildState.pending;
  async function refreshDeliveries(releaseId: string, ticket: number) {
    try {
      const rows = await releaseCommands.deliveries({ ...session, releaseId });
      if (current(ticket)) { setDeliveries(rows); setHistoryError(false); }
    } catch {
      if (current(ticket)) setHistoryError(true);
    }
  }
  async function refreshReleases() {
    await run(async ticket => {
      const rows = await releaseCommands.releases(session);
      if (current(ticket)) { setReleases(rows); setHistoryLoaded(true); }
    });
  }
  async function chooseFolder() {
    await run(async ticket => {
      const folder = await releaseCommands.choose(session);
      if (current(ticket) && folder) { setSelection(folder); setPreview(null); setOverwrite(false); setResult(null); }
    });
  }
  async function previewFolder() {
    if (!chosen || !selection) return;
    await run(async ticket => {
      if (current(ticket)) { setPreview(null); setOverwrite(false); setResult(null); }
      const value = await releaseCommands.preview({ ...session, releaseId: chosen.releaseId, selectionId: selection.selectionId });
      if (current(ticket)) { setPreview(value); setOverwrite(false); setResult(null); }
    });
  }
  async function exportFiles() {
    if (!chosen || !selection || !preview) return;
    await run(async ticket => {
      const actionId = await executionCommands.identity(session);
      const request = { ...session, releaseId: chosen.releaseId, selectionId: selection.selectionId,
        previewId: preview.previewId, actionId, overwriteConflicts: overwrite };
      if (current(ticket)) { updatePending({ kind: "export", request }); setExportMissing(false); }
      try {
        const delivery = await releaseCommands.export(request);
        if (current(ticket)) { setResult(delivery); updatePending(null); }
      } catch (failure) {
        if (current(ticket) && !hasUnknownOutcome(failure)) updatePending(null);
        throw failure;
      } finally {
        if (current(ticket)) { setPreview(null); setOverwrite(false); }
        await refreshDeliveries(chosen.releaseId, ticket);
      }
    });
  }
  async function checkExport() {
    if (pending?.kind !== "export") return;
    const request = pending.request;
    await run(async ticket => {
      const saved = await releaseCommands.deliveryAction({ ...session, actionId: request.actionId,
        selectionId: selection?.selectionId ?? request.selectionId });
      if (saved && (saved.releaseId !== request.releaseId || saved.overwriteConflicts !== request.overwriteConflicts)) throw new Error("Invalid export action confirmation");
      if (current(ticket)) { updatePending(null); setResult(saved); setExportMissing(saved === null); }
      await refreshDeliveries(request.releaseId, ticket);
    });
  }
  async function reconcile(actionId: string) {
    if (!selection || !chosen) return;
    await run(async ticket => {
      const confirmed = await releaseCommands.reconcile({ ...session, actionId, selectionId: selection.selectionId });
      if (confirmed.releaseId !== chosen.releaseId) throw new Error("Invalid export release confirmation");
      if (current(ticket)) setResult(confirmed);
      await refreshDeliveries(chosen.releaseId, ticket);
    });
  }
  async function selectRelease(id: string) {
    setSelected(id); setSelection(null); setPreview(null); setResult(null); setDeliveries([]); setHistoryError(false); setExportMissing(false);
    await run(async ticket => {
      await refreshDeliveries(id, ticket);
    });
  }
  async function recordedRelease(actionId: string) {
    await run(async ticket => {
      const rows = await releaseCommands.releases(session);
      if (!current(ticket)) return;
      setReleases(rows); setHistoryLoaded(true);
      const saved = rows.find(row => row.actionId === actionId);
      if (saved) { setSelected(saved.releaseId); setSelection(null); setPreview(null); setResult(null); await refreshDeliveries(saved.releaseId, ticket); }
    });
  }
  const hasConflict = preview?.files.some(file => file.state === "conflict") ?? false;
  return <WorkbenchPanel open={open} title={t("release.title")} description={t("release.description")} className="source-dialog release-dialog" onBack={() => { if (!locked) setOpen(false); }} backDisabled={disabled || locked}>
      <div className="execution-content" aria-busy={busy}>
        {error || historyError ? <div className="release-alert" role="alert" ref={errorRegion} tabIndex={-1}>
          {error ? <p>{t("release.error", { reason: t(errorReasons[error as keyof typeof errorReasons] ?? "release.errorUnknown") })}</p> : null}
          <CommandFailureDetails failure={errorValue} />
          {historyError ? <><p>{t("release.historyFailed")}</p>{chosen ? <button disabled={locked} onClick={() => void run(ticket => refreshDeliveries(chosen.releaseId, ticket))}>{t("release.refreshDeliveries")}</button> : null}</> : null}
        </div> : null}
        {pending?.kind === "export" ? <section role="status"><p>{t("release.exportUnknown")}</p><button disabled={busy} onClick={() => void checkExport()}>{t("release.checkExport")}</button></section> : null}
        {exportMissing ? <p role="status">{t("release.exportMissing")}</p> : null}
        <PluginBuildControls key={project.sessionToken} ref={buildControls} project={project} open={open} disabled={disabled || busy || !!pending} onState={setBuildState} onRecorded={recordedRelease} onAttention={() => setOpen(true)} onOpenTranslation={onOpenTranslation ? (target, locale) => { const opened = onOpenTranslation(target, locale); if (opened) setOpen(false); return opened; } : undefined} />
        <section><div className="execution-actions"><h3>{t("release.history")}</h3><button className="secondary-button" disabled={locked} onClick={() => void refreshReleases()}>{t("release.refresh")}</button></div>
          {releases.length === 0 ? <p>{t(historyLoaded ? "release.empty" : "execution.working")}</p> : <ul>{releases.map(item => <li key={item.releaseId}><button className="text-button" disabled={locked} onClick={() => void selectRelease(item.releaseId)}>{item.createdAt} · {[...new Set(item.artifacts.map(file => file.locale))].join(", ")}</button></li>)}</ul>}
          {chosen ? <div><h4>{t("release.selected")}</h4><p>{t("release.source", { id: chosen.sourceSnapshotId })} · {chosen.policyVersion}</p><ul>{chosen.artifacts.map(file => <li key={`${file.locale}:${file.fileName}`}>{file.locale} → {file.fileName} · {file.entryCount} · <code>{file.sha256}</code></li>)}</ul>
            <details><summary>{t("release.evidence")}</summary>
              <p>{t("release.manifestDigest", { digest: chosen.manifestSha256 })}</p>
              <p>{t("release.toolVersions", { builder: chosen.builderVersion, validator: chosen.validatorVersion })}</p>
              <p>{t("release.eligibilityBasis", { basis: chosen.eligibilityBasis })}</p>
              <ul>{chosen.sourceFiles.map(file => <li key={file.logicalPath}>{file.logicalPath} · <code>{file.sha256}</code></li>)}</ul>
              <h5>{t("release.exceptions")}</h5>{chosen.exceptions.length === 0 ? <p>{t("release.noExceptions")}</p> : <ul>{chosen.exceptions.map((item, index) => <li key={`${item.locale}:${item.nativeKey}:${index}`}>{item.locale} · {item.nativeKey} · {t(`release.exceptionKind.${item.kind}`)}</li>)}</ul>}
            </details>
            <div className="form-actions"><button className="secondary-button" disabled={busy || buildState.busy || buildState.pending} onClick={() => void chooseFolder()}>{t("release.chooseFolder")}</button>{selection ? <button className="secondary-button" disabled={locked} onClick={() => void previewFolder()}>{t("release.preview")}</button> : null}</div>
            {selection ? <p>{t("release.destination", { name: selection.folderName })}</p> : null}
            {preview ? <div><h4>{t("release.previewTitle")}</h4><p>{t("release.destination", { name: preview.folderName })}</p><ul>{preview.files.map(file => <li key={`${file.locale}:${file.fileName}`}>{file.fileName} · {t(`release.fileState.${file.state}`)} · <code>{file.expectedSha256}</code></li>)}</ul>
              {hasConflict ? <label><input type="checkbox" checked={overwrite} disabled={locked} onChange={event => setOverwrite(event.target.checked)} />{t("release.overwrite")}</label> : null}
              <div className="form-actions"><button className="primary-button" disabled={locked || (hasConflict && !overwrite)} onClick={() => void exportFiles()}>{t("release.export")}</button></div></div> : null}
            {result ? <div role="status"><p>{t(`release.deliveryState.${result.state}`)}</p>{(result.state === "pending" || result.state === "unknown") && selection ? <button disabled={locked} onClick={() => void reconcile(result.actionId)}>{t("release.checkPending")}</button> : null}</div> : null}
            <h4>{t("release.deliveries")}</h4>{deliveries.length === 0 ? historyError ? null : <p>{t("release.noDeliveries")}</p> : <ul>{deliveries.map(delivery => <li key={delivery.deliveryId}>{delivery.createdAt} · {t(`release.deliveryState.${delivery.state}`)} · {delivery.directory} · {t(delivery.overwriteConflicts ? "release.overwriteAllowed" : "release.overwriteNotAllowed")}{(delivery.state === "pending" || delivery.state === "unknown") && selection && delivery.actionId !== result?.actionId ? <button className="secondary-button" disabled={locked} onClick={() => void reconcile(delivery.actionId)}>{t("release.checkPending")}</button> : null}<ul>{delivery.files.map(file => <li key={`${file.locale}:${file.fileName}`}>{file.fileName}: {t(`release.deliveryState.${file.state}`)}{file.actualSha256 ? <> · <code>{file.actualSha256}</code></> : null}</li>)}</ul></li>)}</ul>}
          </div> : null}
        </section>
      </div>
    </WorkbenchPanel>;
}
