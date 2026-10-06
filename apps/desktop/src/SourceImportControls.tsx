import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { PluginPermissions } from "./PluginManager";
import { pluginCommands, type PluginSourceRequest, type PluginSourceView, type PluginInventoryView } from "./pluginCommands";
import { sourceCommands, type PluginCaptureRequest, type PluginSourceSelection, type PluginSourcePreflight, type PluginStartRequest, type SourceCheckPrepareRequest, type SourceCheckReview, type SourceCheckFinishRequest } from "./sourceCommands";
import { executionCommands, executionContext, type AttemptDetail } from "./executionCommands";
import { useSessionQuery } from "./SessionReadProvider";
import type { ProjectView } from "./projectCommands";

interface SourceChoice { key: string; label: string; package: PluginSourceRequest["package"]; resourceId: string }
export interface SourceImportState { busy: boolean; pending: boolean; hasDraft: boolean }
export interface SourceImportHandle { discard: () => Promise<void> }
function uncertain(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  return code === "outcome-unknown" || code === "storage-failed" || !code;
}
function ExecutionReview({ source, checker }: { source: PluginSourceView; checker: boolean }) {
  const { t } = useTranslation();
  const capability = checker ? source.checker : source.extractor;
  return <section aria-label={t("sourcePlugin.executionReview")}>
    <p>{source.declaration.displayName} · {capability.provider.plugin.id} {capability.provider.plugin.version}</p>
    <p>{t("sourcePlugin.runtimeDetails", { version: source.environment.toolVersion, system: source.environment.platform.operatingSystem, architecture: source.environment.platform.architecture })}</p>
    <PluginPermissions permissions={capability.declaration.permissions} />
    <p>{t("sourcePlugin.unsandboxed")}</p>
    <details><summary>{t("sourcePlugin.fixedDetails")}</summary><dl>
      <dt>{t("sourcePlugin.packageDigest")}</dt><dd><code>{capability.provider.packageDigest}</code></dd>
      <dt>{t("sourcePlugin.runtimeDigest")}</dt><dd><code>{source.environmentDigest}</code></dd>
      <dt>{t("sourcePlugin.profile")}</dt><dd><code>{source.declaration.profile.id}</code> ({source.declaration.profile.schemaVersion}/{source.declaration.profile.behaviorVersion})</dd>
    </dl></details>
  </section>;
}

/** Local preparation and consent remain mounted across workbench view changes.
 * Core owns execution, grants, validation and adoption; no task status is invented. */
export function SourceImportControls({ project, open, canCapture, proposal, validation, disabled, onStarted, onValidated, onState, ref }: {
  project: ProjectView; open: boolean; canCapture: boolean; proposal: { attemptId: string; resultId: string } | null;
  validation: AttemptDetail["items"][number]["status"]["validation"]; disabled: boolean; onStarted: (attempt: string) => void; onValidated: () => Promise<void>;
  onState: (state: SourceImportState) => void; ref?: Ref<SourceImportHandle>;
}) {
  const { t } = useTranslation();
  const context = executionContext(project);
  const validated = validation === "valid";
  const [choices, setChoices] = useState<SourceChoice[]>([]);
  const [runtimes, setRuntimes] = useState<PluginInventoryView["runtimes"]>([]);
  const [choiceKey, setChoiceKey] = useState("");
  const [runtimeDigest, setRuntimeDigest] = useState("");
  const [environment, setEnvironment] = useState<PluginSourceView | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [inventoryReady, setInventoryReady] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<PluginSourceSelection | null>(null);
  const [declared, setDeclared] = useState(false);
  const [captureIntent, setCaptureIntent] = useState<PluginCaptureRequest | null>(null);
  const [preflight, setPreflight] = useState<PluginSourcePreflight | null>(null);
  const [consent, setConsent] = useState<string | null>(null);
  const [startIntent, setStartIntent] = useState<PluginStartRequest | null>(null);
  const [checkPrepare, setCheckPrepare] = useState<SourceCheckPrepareRequest | null>(null);
  const [checkReview, setCheckReview] = useState<SourceCheckReview | null>(null);
  const [checkConsent, setCheckConsent] = useState<string | null>(null);
  const [checkIntent, setCheckIntent] = useState<PluginStartRequest | null>(null);
  const [checkAttempt, setCheckAttempt] = useState<string | null>(null);
  const [finishIntent, setFinishIntent] = useState<SourceCheckFinishRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CommandFailure | null>(null);
  const running = useRef(false), mounted = useRef(true), sequence = useRef(0);
  const errorRegion = useRef<HTMLDivElement>(null);
  const choice = choices.find(item => item.key === choiceKey);
  const sourceChoice: PluginSourceRequest | null = choice && runtimeDigest ? { package: choice.package, resourceId: choice.resourceId, environmentDigest: runtimeDigest } : null;
  const pending = !!startIntent || !!checkIntent || !!finishIntent;
  const locked = disabled || busy || pending;
  const checkRead = useSessionQuery<AttemptDetail | null>({ key: ["source-check", checkAttempt, 0, 100], scopes: ["execution"], enabled: open && !!checkAttempt && !busy,
    read: () => executionCommands.attempt({ ...context, attemptId: checkAttempt!, offset: 0, limit: 100 }) });
  const checkItem = checkRead.data?.items[0];
  const checkActive = !!checkAttempt && (!checkItem || checkItem.status.execution === "queued" || checkItem.status.execution === "dispatched");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => { onState({ busy: busy || checkActive, pending, hasDraft: !!selection || !!checkReview && !checkAttempt && !validated }); }, [busy, checkActive, pending, !!selection, !!checkReview, checkAttempt, validated, onState]);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true); setInventoryReady(false);
    void (async () => {
      try {
        const inventory = await pluginCommands.inventory();
        const enabled = inventory.packages.filter(item => item.state === "sealed" && inventory.packageDecisions.some(decision => decision.enabled && decision.packageDigest === item.packageDigest && decision.plugin.id === item.plugin.id && decision.plugin.version === item.plugin.version && decision.plugin.publisher === item.plugin.publisher));
        const packages = await Promise.all(enabled.map(item => pluginCommands.package({ plugin: item.plugin, packageDigest: item.packageDigest })));
        const next = packages.flatMap(item => item.manifest.contributions.flatMap(contribution => contribution.contribution.kind === "resource" && contribution.contribution.schema.id === "tsumugi.source-import-declaration" && contribution.contribution.schema.schemaVersion === 1 && contribution.contribution.schema.behaviorVersion === 1 ? [{ key: `${item.packageDigest}:${contribution.id}`, label: `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${contribution.id}`, package: { plugin: item.manifest.plugin, packageDigest: item.packageDigest }, resourceId: contribution.id }] : []));
        const environments = inventory.runtimes.filter(item => item.state === "sealed" && inventory.runtimeDecisions.some(decision => decision.environmentDigest === item.environmentDigest));
        if (!stale) { setInventoryReady(true); setChoices(next); setRuntimes(environments); setChoiceKey(current => current || next[0]?.key || ""); setRuntimeDigest(current => current || environments[0]?.environmentDigest || ""); }
      } catch (error) { if (!stale) setFailure(commandFailure(error)); }
      finally { if (!stale) setLoading(false); }
    })();
    return () => { stale = true; };
  }, [open, project.sessionToken, refresh]);
  useEffect(() => {
    if (!open || !choice || !runtimeDigest) { setEnvironment(null); setEnvironmentLoading(false); return; }
    let stale = false;
    setEnvironment(null); setEnvironmentLoading(true);
    void pluginCommands.source({ package: choice.package, resourceId: choice.resourceId, environmentDigest: runtimeDigest })
      .then(value => { if (!stale) setEnvironment(value); }, error => { if (!stale) setFailure(commandFailure(error)); })
      .finally(() => { if (!stale) setEnvironmentLoading(false); });
    return () => { stale = true; };
  }, [open, project.sessionToken, choice?.key, runtimeDigest, refresh]);
  useEffect(() => { if (failure && open) errorRegion.current?.focus(); }, [failure, open]);
  useEffect(() => { if (checkRead.error) setFailure(commandFailure(checkRead.error)); }, [checkRead.error]);
  useEffect(() => {
    if (checkReview && proposal && (checkReview.sourceAttemptId !== proposal.attemptId || checkReview.sourceResultId !== proposal.resultId) && !pending) {
      setCheckReview(null); setCheckPrepare(null); setCheckAttempt(null); setCheckConsent(null); checkRead.setData(null);
    }
  }, [proposal?.attemptId, proposal?.resultId, pending, checkReview]);

  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setFailure(null);
    const ticket = ++sequence.current;
    const current = () => mounted.current && sequence.current === ticket;
    try { await work(current); }
    catch (error) { if (current()) setFailure(commandFailure(error)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  async function discard() {
    await sourceCommands.cancelCapture(context);
    sequence.current++;
    if (mounted.current) { setSelection(null); setCaptureIntent(null); setPreflight(null); setConsent(null); setDeclared(false); setCheckPrepare(null); setCheckReview(null); setCheckConsent(null); }
  }
  useImperativeHandle(ref, () => ({ discard }));
  function changed() { sequence.current++; setSelection(null); setPreflight(null); setCaptureIntent(null); setConsent(null); setDeclared(false); setCheckReview(null); setCheckPrepare(null); setCheckConsent(null); setFailure(null); }
  async function authorize(view: { attemptId: string; inputDigest: string }): Promise<PluginStartRequest> {
    return { ...context, attemptId: view.attemptId, inputDigest: view.inputDigest, grantId: await executionCommands.identity(context), expiresAtMs: String(Date.now() + 600_000), unsandboxedExecution: true };
  }
  async function start(request: PluginStartRequest, checker: boolean, current: () => boolean) {
    try {
      const attempt = checker ? await sourceCommands.startCheck(request) : await sourceCommands.startPlugin(request);
      if (!current()) return;
      if (checker) { setCheckIntent(null); setCheckAttempt(attempt); checkRead.setData(null); }
      else { setStartIntent(null); setSelection(null); setPreflight(null); setCaptureIntent(null); setConsent(null); onStarted(attempt); }
    } catch (error) {
      if (current() && !uncertain(error)) { if (checker) setCheckIntent(null); else setStartIntent(null); }
      throw error;
    }
  }
  async function finish(request: SourceCheckFinishRequest, current: () => boolean) {
    try {
      await sourceCommands.finishCheck(request);
      if (current()) { await onValidated(); if (current()) setFinishIntent(null); }
    } catch (error) { if (current() && !uncertain(error)) setFinishIntent(null); throw error; }
  }
  const unavailable = !loading && (!inventoryReady || !choices.length || !runtimes.length);
  return <section aria-label={t("sourcePlugin.importControls")} aria-busy={busy || loading || environmentLoading}>
    {failure ? <div ref={errorRegion} role="alert" tabIndex={-1}><p>{t("sourcePlugin.failed")}</p><CommandFailureDetails failure={failure} /></div> : null}
    {busy || loading || environmentLoading ? <p role="status">{t("execution.working")}</p> : null}
    {canCapture || (proposal && !validated) ? <>
      <label className="source-field">{t("source.integration")}<select value={choiceKey} disabled={locked || checkActive || loading} onChange={event => { changed(); setChoiceKey(event.target.value); }}>
        {!choices.some(item => item.key === choiceKey) ? <option value={choiceKey}>{t("sourcePlugin.choosePackage")}</option> : null}
        {choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select></label>
      <label className="source-field">{t("sourcePlugin.runtime")}<select value={runtimeDigest} disabled={locked || checkActive || loading} onChange={event => { changed(); setRuntimeDigest(event.target.value); }}>
        {!runtimes.some(item => item.environmentDigest === runtimeDigest) ? <option value={runtimeDigest}>{t("sourcePlugin.chooseRuntime")}</option> : null}
        {runtimes.map(item => <option key={item.environmentDigest} value={item.environmentDigest}>{t("sourcePlugin.runtimeOption", { version: item.environment.toolVersion, system: item.environment.platform.operatingSystem, architecture: item.environment.platform.architecture })}</option>)}
      </select></label>
      <button className="secondary-button" disabled={locked || checkActive} onClick={() => { setFailure(null); setRefresh(value => value + 1); }}>{t("sourcePlugin.refresh")}</button>
      {unavailable ? <p role="status">{t("sourcePlugin.unavailable")}</p> : null}
      {environment ? <p>{environment.declaration.displayName}</p> : null}
    </> : null}
    {canCapture ? <>
      {environment ? <ul>{environment.declaration.materials.map(file => <li key={file.logicalPath}>{t("sourcePlugin.material", { path: file.logicalPath, bytes: String(file.maxBytes) })}</li>)}</ul> : null}
      <button className="secondary-button" disabled={locked || !environment || unavailable} onClick={() => void perform(async current => {
        if (!sourceChoice) return;
        const next = await sourceCommands.selectPlugin({ ...context, source: sourceChoice });
        if (current()) { setSelection(next); setPreflight(null); setCaptureIntent(null); setConsent(null); setDeclared(false); }
      })}>{t("sourcePlugin.chooseFolder")}</button>
      {selection ? <>
        <p>{selection.folderName}</p>
        <label className="source-check"><input type="checkbox" checked={declared} disabled={locked} onChange={event => { setDeclared(event.target.checked); setPreflight(null); setCaptureIntent(null); setConsent(null); }} />{t("source.language", { language: project.metadata.sourceLocale })}</label>
        <button className="secondary-button" disabled={locked || !declared} onClick={() => void perform(async current => {
          const request = !preflight && captureIntent ? captureIntent : { ...context, selectionId: selection.selectionId, sourceLanguage: project.metadata.sourceLocale, attemptId: await executionCommands.identity(context) };
          if (!current()) return;
          setCaptureIntent(request);
          const captured = await sourceCommands.capturePlugin(request);
          if (current()) { setPreflight(captured); setConsent(null); }
        })}>{t("source.preflight")}</button>
        {preflight ? <>
          <p>{t("sourcePlugin.captured", { count: preflight.files.length, language: preflight.sourceLanguage })}</p>
          <ul>{preflight.files.map(file => <li key={file.logicalPath}>{t("sourcePlugin.capturedFile", { path: file.logicalPath, bytes: String(file.byteLength) })}<details><summary>{t("source.fingerprint")}</summary><code>{file.sha256}</code></details></li>)}</ul>
          <ExecutionReview source={preflight.source} checker={false} />
          <label className="source-check"><input type="checkbox" checked={consent === preflight.inputDigest} disabled={locked} onChange={event => setConsent(event.target.checked ? preflight.inputDigest : null)} />{t("sourcePlugin.producerConsent")}</label>
          <button className="primary-button" disabled={locked || !environment || unavailable || consent !== preflight.inputDigest} onClick={() => void perform(async current => {
            const request = await authorize(preflight); if (!current()) return;
            setStartIntent(request); await start(request, false, current);
          })}>{t("source.start")}</button>
        </> : null}
        <button className="text-button" disabled={locked} onClick={() => void perform(async () => { await discard(); })}>{t("source.discard")}</button>
      </> : null}
    </> : null}
    {startIntent && !busy ? <section><p>{t("source.startUnknown")}</p><button disabled={busy} className="secondary-button" onClick={() => void perform(current => start(startIntent, false, current))}>{t("source.checkStart")}</button></section> : null}
    {proposal ? <section aria-label={t("sourcePlugin.semanticChecks")}>
      <p role="status">{t(validated ? "sourcePlugin.validated" : validation === "invalid" ? "sourcePlugin.invalid" : "sourcePlugin.checkRequired")}</p>
      {!validated ? <>
        <button className="secondary-button" disabled={locked || !environment || !sourceChoice || unavailable || checkActive} onClick={() => void perform(async current => {
          if (!sourceChoice) return;
          const request = checkPrepare?.sourceAttemptId === proposal.attemptId && checkPrepare.sourceResultId === proposal.resultId && !checkAttempt ? checkPrepare : { ...context, sourceAttemptId: proposal.attemptId, sourceResultId: proposal.resultId, attemptId: await executionCommands.identity(context), source: sourceChoice };
          if (!current()) return;
          setCheckPrepare(request);
          const review = await sourceCommands.prepareCheck(request);
          if (current()) { setCheckReview(review); setCheckAttempt(null); checkRead.setData(null); setCheckConsent(null); }
        })}>{t("sourcePlugin.prepareCheck")}</button>
        {checkReview && !checkAttempt ? <>
          <ExecutionReview source={checkReview.source} checker />
          <p>{t("sourcePlugin.rules", { count: checkReview.rules.length })}</p>
          <label className="source-check"><input type="checkbox" checked={checkConsent === checkReview.inputDigest} disabled={locked} onChange={event => setCheckConsent(event.target.checked ? checkReview.inputDigest : null)} />{t("sourcePlugin.checkerConsent")}</label>
          <button className="primary-button" disabled={locked || !environment || unavailable || checkConsent !== checkReview.inputDigest} onClick={() => void perform(async current => {
            const request = await authorize(checkReview); if (!current()) return;
            setCheckIntent(request); await start(request, true, current);
          })}>{t("sourcePlugin.startCheck")}</button>
        </> : null}
        {checkAttempt ? <>
          <p role="status">{t(checkItem?.status.execution === "succeeded" ? "sourcePlugin.checkReceived" : checkItem?.status.execution === "failed" || checkItem?.status.execution === "unknown" || checkItem?.status.execution === "cancelled-before-dispatch" ? "sourcePlugin.checkFailed" : "sourcePlugin.checkRunning")}</p>
          {checkItem?.status.execution === "succeeded" && checkItem.resultId ? <button className="primary-button" disabled={locked} onClick={() => void perform(async current => {
            const request = { ...context, attemptId: checkAttempt, resultId: checkItem.resultId! }; setFinishIntent(request); await finish(request, current);
          })}>{t("sourcePlugin.recordCheck")}</button> : null}
          <button className="secondary-button" disabled={locked} onClick={() => void checkRead.refetch()}>{t("execution.refresh")}</button>
          {checkRead.data ? <button className="secondary-button" disabled={locked} onClick={() => void perform(async () => { await executionCommands.cancel({ ...context, taskId: checkRead.data!.taskId, requestId: await executionCommands.identity(context) }); })}>{t("execution.cancel")}</button> : null}
        </> : null}
      </> : null}
    </section> : null}
    {checkIntent && !busy ? <section><p>{t("sourcePlugin.checkStartUnknown")}</p><button className="secondary-button" onClick={() => void perform(current => start(checkIntent, true, current))}>{t("source.checkStart")}</button></section> : null}
    {finishIntent && !busy ? <section><p>{t("sourcePlugin.checkCommitUnknown")}</p><button className="secondary-button" onClick={() => void perform(current => finish(finishIntent, current))}>{t("sourcePlugin.reconcileCheck")}</button></section> : null}
  </section>;
}
