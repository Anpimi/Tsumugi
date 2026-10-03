import { reviewReasonKey } from "./reviewLabels";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { executionCommands, executionContext } from "./executionCommands";
import { reviewCommands, type Eligibility } from "./reviewCommands";
import { sourceCommands } from "./sourceCommands";
import { releaseCommands, type BuildRequest, type ExportRequest, type DeliveryPreview, type DeliverySelection, type DeliveryView, type ReleaseView } from "./releaseCommands";

function suggestedFile(locale: string) { return locale === "zh-CN" ? "zh.json" : ""; }
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

export interface ReleaseHandle { allowLeave: () => Promise<boolean> }
type PendingRelease = { kind: "build"; request: BuildRequest } | { kind: "export"; request: ExportRequest };
export function ReleaseWorkbench({ project, disabled, ref, onOpenTranslation }: { project: ProjectView; disabled: boolean; ref?: Ref<ReleaseHandle>; onOpenTranslation?: (target: import("./TranslationWorkbench").EditorTarget, locale: string) => boolean }) {
  const { t } = useTranslation();
  const session = executionContext(project);
  const [open, setOpen] = useWorkbenchView("release");
  const [domain, setDomain] = useState<string | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(project.metadata.targetLocales.map(locale => [locale, suggestedFile(locale)])));
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [releases, setReleases] = useState<ReleaseView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selection, setSelection] = useState<DeliverySelection | null>(null);
  const [preview, setPreview] = useState<DeliveryPreview | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [deliveries, setDeliveries] = useState<DeliveryView[]>([]);
  const [attempt, setAttempt] = useState<string | null>(null);
  const [result, setResult] = useState<DeliveryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingRelease | null>(null);
  const pendingRef = useRef(pending);
  const [buildMissing, setBuildMissing] = useState(false);
  const [exportMissing, setExportMissing] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const mutating = useRef(false);
  useImperativeHandle(ref, () => ({ allowLeave: () => Promise.resolve(!mutating.current && !pendingRef.current) }));
  const errorRegion = useRef<HTMLDivElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { if (error || historyError) { errorRegion.current?.focus(); errorRegion.current?.scrollIntoView({ block: "nearest" }); } }, [error, historyError]);
  useEffect(() => {
    if (!open) return;
    const ticket = ++generation.current;
    void Promise.all([releaseCommands.releases(session), sourceCommands.integration(session)]).then(([rows, integration]) => {
      if (mounted.current && ticket === generation.current) { setReleases(rows); setDomain(integration.id); if (integration.id === "webvtt") setNames(previous => Object.fromEntries(Object.entries(previous).map(([locale, name]) => [locale, name === suggestedFile(locale) ? `${locale}.vtt` : name]))); }
    }).catch(failure => { if (mounted.current && ticket === generation.current) setError(errorCode(failure)); });
    return () => { generation.current++; };
  }, [open, project.sessionToken]);
  const vtt = domain === "webvtt";
  const chosen = releases.find(item => item.releaseId === selected) ?? null;

  async function run(work: (ticket: number) => Promise<void>) {
    if (mutating.current) return;
    mutating.current = true; const ticket = ++generation.current; setBusy(true); setError(null);
    try { await work(ticket); }
    catch (failure) { if (mounted.current && ticket === generation.current) setError(pendingRef.current && hasUnknownOutcome(failure) ? "outcome-unknown" : errorCode(failure)); }
    finally { mutating.current = false; if (mounted.current && ticket === generation.current) setBusy(false); }
  }
  function current(ticket: number) { return mounted.current && ticket === generation.current; }
  function updatePending(value: PendingRelease | null) { pendingRef.current = value; setPending(value); }
  const locked = busy || !!pending;
  function setLanguage(locale: string, checked: boolean) {
    setLanguages(previous => checked ? [...previous, locale] : previous.filter(item => item !== locale));
    setEligibility(null);
  }
  async function assess() {
    await run(async ticket => {
      const value = await reviewCommands.eligibility({ ...session, locales: languages });
      if (current(ticket)) setEligibility(value);
    });
  }
  async function build() {
    if (!eligibility?.ready || languages.length === 0 || languages.some(locale => !names[locale]?.trim())) return;
    await run(async ticket => {
      const attemptId = await executionCommands.identity(session);
      await submitBuild({ ...session, attemptId, expectedEligibilityBasis: eligibility.basis,
        choices: languages.map(locale => ({ locale, fileName: vtt ? names[locale].trim() : `i18n/${names[locale].trim()}` })) }, ticket);
    });
  }
  async function submitBuild(request: BuildRequest, ticket: number) {
    if (current(ticket)) { updatePending({ kind: "build", request }); setBuildMissing(false); }
    try {
      await releaseCommands.start(request);
      if (current(ticket)) { setAttempt(request.attemptId); updatePending(null); }
    } catch (failure) {
      if (current(ticket) && !hasUnknownOutcome(failure)) updatePending(null);
      throw failure;
    } finally { if (current(ticket)) setEligibility(null); }
  }
  async function checkBuild() {
    if (pending?.kind !== "build") return;
    const request = pending.request;
    await run(async ticket => {
      if (current(ticket)) setBuildMissing(false);
      const saved = await releaseCommands.buildAttempt(request);
      if (current(ticket)) {
        if (saved) { setAttempt(request.attemptId); updatePending(null); }
        else setBuildMissing(true);
      }
    });
  }
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
      if (current(ticket)) setReleases(rows);
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
  function blockerLabel(code: string) { return t(reviewReasonKey(code)); }
  async function openBlocker(unitId: string, locale: string) {
    await run(async ticket => {
      const target = await reviewCommands.target({ ...session, unitId, locale });
      if (current(ticket) && onOpenTranslation?.({ unitId: target.unitId, sourceRevisionId: target.sourceRevisionId, key: target.nativeKey, sourceText: target.sourceText }, locale)) setOpen(false);
    });
  }
  const mappingReady = languages.length > 0 && languages.every(locale => names[locale]?.trim());
  const hasConflict = preview?.files.some(file => file.state === "conflict") ?? false;
  return <WorkbenchPanel open={open} title={t("release.title")} description={t(vtt ? "release.webvttDescription" : "release.description")} className="source-dialog release-dialog" onBack={() => { if (!locked) setOpen(false); }} backDisabled={disabled || locked}>
      <div className="execution-content" aria-busy={busy}>
        {error || historyError ? <div className="release-alert" role="alert" ref={errorRegion} tabIndex={-1}>
          {error ? <p>{t("release.error", { reason: t(errorReasons[error as keyof typeof errorReasons] ?? "release.errorUnknown") })}</p> : null}
          {historyError ? <><p>{t("release.historyFailed")}</p>{chosen ? <button disabled={locked} onClick={() => void run(ticket => refreshDeliveries(chosen.releaseId, ticket))}>{t("release.refreshDeliveries")}</button> : null}</> : null}
        </div> : null}
        {pending?.kind === "build" ? <section role="status"><p>{t(buildMissing ? "release.buildMissing" : "release.buildUnknown")}</p>
          <button disabled={busy} onClick={() => void checkBuild()}>{t("release.checkBuild")}</button>
          {buildMissing ? <button disabled={busy} onClick={() => void run(ticket => submitBuild(pending.request, ticket))}>{t("release.retryBuild")}</button> : null}
        </section> : null}
        {pending?.kind === "export" ? <section role="status"><p>{t("release.exportUnknown")}</p><button disabled={busy} onClick={() => void checkExport()}>{t("release.checkExport")}</button></section> : null}
        {exportMissing ? <p role="status">{t("release.exportMissing")}</p> : null}
        <section><h3>{t("release.prepare")}</h3><p>{t(vtt ? "release.webvttScope" : "release.scope")}</p>
          <fieldset><legend>{t("release.languages")}</legend>{project.metadata.targetLocales.map(locale => <label key={locale} className="release-locale"><input type="checkbox" checked={languages.includes(locale)} disabled={locked} onChange={event => setLanguage(locale, event.target.checked)} />{locale}</label>)}</fieldset>
          {languages.map(locale => <label className="release-mapping" key={locale}>{t(vtt ? "release.webvttFileName" : "release.fileName", { locale })}<span>{vtt ? "" : "i18n/"}</span><input aria-label={t(vtt ? "release.webvttFileName" : "release.fileName", { locale })} value={names[locale] ?? ""} disabled={locked || !domain} onChange={event => { setNames(previous => ({ ...previous, [locale]: event.target.value })); setEligibility(null); }} placeholder={vtt ? "zh-CN.vtt" : "zh.json"} /></label>)}
          <p>{t("release.policy")}</p>
          <div className="form-actions"><button className="secondary-button" disabled={locked || !mappingReady || !domain} onClick={() => void assess()}>{t("release.check")}</button><button className="primary-button" disabled={locked || !mappingReady || !eligibility?.ready || !domain} onClick={() => void build()}>{t("release.build")}</button></div>
          {eligibility ? <div role="status"><p>{t(eligibility.ready ? "release.ready" : "release.blocked", { count: eligibility.locales.reduce((sum, item) => sum + item.blockerCount, 0) })}</p><p>{t("release.source", { id: eligibility.sourceSnapshotId })} · {eligibility.policyVersion}</p>
            {eligibility.locales.map(item => <div key={item.locale}><strong>{item.locale}</strong>: {t("release.coverage", { count: item.checkedUnits })}{item.blockers.map((reason, index) => <div className="release-blocker" key={`${reason.unitId}:${index}`}>{reason.nativeKey}: {blockerLabel(reason.code)} {onOpenTranslation ? <button type="button" className="text-button" disabled={locked} onClick={() => void openBlocker(reason.unitId, item.locale)}>{t("translation.openEditor")}</button> : null}<details><summary>{t("execution.diagnostic")}</summary>{reason.code}</details></div>)}{item.exceptions.map((reason, index) => <p key={`exception:${reason.unitId}:${index}`}>{t("release.exception", { key: reason.nativeKey, reason: reason.code })}</p>)}</div>)}
          </div> : null}
          {attempt ? <p role="status">{t("release.started", { id: attempt })}</p> : null}
        </section>
        <section><div className="execution-actions"><h3>{t("release.history")}</h3><button className="secondary-button" disabled={locked} onClick={() => void refreshReleases()}>{t("release.refresh")}</button></div>
          {releases.length === 0 ? <p>{t("release.empty")}</p> : <ul>{releases.map(item => <li key={item.releaseId}><button className="text-button" disabled={locked} onClick={() => void selectRelease(item.releaseId)}>{item.createdAt} · {item.artifacts.map(file => file.locale).join(", ")}</button></li>)}</ul>}
          {chosen ? <div><h4>{t("release.selected")}</h4><p>{t("release.source", { id: chosen.sourceSnapshotId })} · {chosen.policyVersion}</p><ul>{chosen.artifacts.map(file => <li key={file.locale}>{file.locale} → {file.fileName} · {file.entryCount} · <code>{file.sha256}</code></li>)}</ul>
            <details><summary>{t("release.evidence")}</summary>
              <p>{t("release.manifestDigest", { digest: chosen.manifestSha256 })}</p>
              <p>{t("release.toolVersions", { builder: chosen.builderVersion, validator: chosen.validatorVersion })}</p>
              <p>{t("release.eligibilityBasis", { basis: chosen.eligibilityBasis })}</p>
              <ul>{chosen.sourceFiles.map(file => <li key={file.logicalPath}>{file.logicalPath} · <code>{file.sha256}</code></li>)}</ul>
              <h5>{t("release.exceptions")}</h5>{chosen.exceptions.length === 0 ? <p>{t("release.noExceptions")}</p> : <ul>{chosen.exceptions.map((item, index) => <li key={`${item.locale}:${item.nativeKey}:${index}`}>{item.locale} · {item.nativeKey} · {t(`release.exceptionKind.${item.kind}`)}</li>)}</ul>}
            </details>
            <div className="form-actions"><button className="secondary-button" disabled={busy || pending?.kind === "build"} onClick={() => void chooseFolder()}>{t("release.chooseFolder")}</button>{selection ? <button className="secondary-button" disabled={locked} onClick={() => void previewFolder()}>{t("release.preview")}</button> : null}</div>
            {selection ? <p>{t(vtt ? "release.webvttDestination" : "release.destination", { name: selection.folderName })}</p> : null}
            {preview ? <div><h4>{t("release.previewTitle")}</h4><p>{t(vtt ? "release.webvttDestination" : "release.destination", { name: preview.folderName })}</p><ul>{preview.files.map(file => <li key={file.locale}>{file.fileName} · {t(`release.fileState.${file.state}`)} · <code>{file.expectedSha256}</code></li>)}</ul>
              {hasConflict ? <label><input type="checkbox" checked={overwrite} disabled={locked} onChange={event => setOverwrite(event.target.checked)} />{t("release.overwrite")}</label> : null}
              <div className="form-actions"><button className="primary-button" disabled={locked || (hasConflict && !overwrite)} onClick={() => void exportFiles()}>{t("release.export")}</button></div></div> : null}
            {result ? <div role="status"><p>{t(`release.deliveryState.${result.state}`)}</p>{(result.state === "pending" || result.state === "unknown") && selection ? <button disabled={locked} onClick={() => void reconcile(result.actionId)}>{t("release.checkPending")}</button> : null}</div> : null}
            <h4>{t("release.deliveries")}</h4>{deliveries.length === 0 ? historyError ? null : <p>{t("release.noDeliveries")}</p> : <ul>{deliveries.map(delivery => <li key={delivery.deliveryId}>{delivery.createdAt} · {t(`release.deliveryState.${delivery.state}`)} · {delivery.directory} · {t(delivery.overwriteConflicts ? "release.overwriteAllowed" : "release.overwriteNotAllowed")}{(delivery.state === "pending" || delivery.state === "unknown") && selection && delivery.actionId !== result?.actionId ? <button className="secondary-button" disabled={locked} onClick={() => void reconcile(delivery.actionId)}>{t("release.checkPending")}</button> : null}<ul>{delivery.files.map(file => <li key={file.locale}>{file.fileName}: {t(`release.deliveryState.${file.state}`)}{file.actualSha256 ? <> · <code>{file.actualSha256}</code></> : null}</li>)}</ul></li>)}</ul>}
          </div> : null}
        </section>
      </div>
    </WorkbenchPanel>;
}
