import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { PluginPermissions } from "./PluginManager";
import { approvedPluginEnvironments, matchingPluginEnvironments, pluginEnvironmentVersion, type PluginComponentRuntime, type PluginEnvironmentChoice } from "./pluginEnvironments";
import { pluginCommands, type PluginBuildRequest, type PluginBuildView } from "./pluginCommands";
import { releaseCommands, type PluginBuildPrepareRequest, type PluginBuildReview, type ArtifactCheckPrepareRequest, type ArtifactCheckReview, type ArtifactCheckFinishRequest, type PluginStartRequest } from "./releaseCommands";
import { executionCommands, executionContext, type AttemptDetail, type PrepareRequest, type CancelRequest, type Receipt } from "./executionCommands";
import { hasUnknownOutcome, projectCommands, type ProjectView } from "./projectCommands";
import { reviewCommands, type Eligibility } from "./reviewCommands";
import { readCompleteAttempt } from "./executionRead";
import { reviewReasonKey } from "./reviewLabels";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import type { EditorTarget } from "./TranslationWorkbench";

interface BuildChoice { key: string; label: string; package: PluginBuildRequest["package"]; resourceId: string; runtimeKinds: PluginComponentRuntime[] }
export interface PluginBuildState { busy: boolean; pending: boolean }
export interface PluginBuildHandle { allowLeave: () => Promise<boolean>; allowNavigate: () => Promise<boolean> }
type Intent =
  | { kind: "prepare-build"; request: PluginBuildPrepareRequest }
  | { kind: "prepare-check"; request: ArtifactCheckPrepareRequest }
  | { kind: "start-build" | "start-check"; request: PluginStartRequest }
  | { kind: "finish-check"; request: ArtifactCheckFinishRequest }
  | { kind: "cancel"; request: CancelRequest }
  | { kind: "adopt"; request: PrepareRequest; prepared: boolean };

function BuildExecutionReview({ build, checker }: { build: PluginBuildView; checker: boolean }) {
  const { t } = useTranslation();
  const capability = checker ? build.checker : build.builder;
  return <section aria-label={t(checker ? "releasePlugin.checkReview" : "releasePlugin.buildReview")}>
    <p>{build.declaration.displayName} · {capability.provider.plugin.id} {capability.provider.plugin.version}</p>
    <p>{t(build.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeDetails" : "sourcePlugin.nativeRuntimeDetails", { version: pluginEnvironmentVersion(build.environment), system: build.environment.platform.operatingSystem, architecture: build.environment.platform.architecture })}</p>
    <PluginPermissions permissions={capability.declaration.permissions} />
    <p>{t("sourcePlugin.unsandboxed")}</p>
    <details><summary>{t("sourcePlugin.fixedDetails")}</summary><dl>
      <dt>{t("sourcePlugin.packageDigest")}</dt><dd><code>{capability.provider.packageDigest}</code></dd>
      <dt>{t("sourcePlugin.runtimeDigest")}</dt><dd><code>{build.environmentDigest}</code></dd>
      <dt>{t("sourcePlugin.profile")}</dt><dd><code>{build.declaration.profile.id}</code> ({build.declaration.profile.schemaVersion}/{build.declaration.profile.behaviorVersion})</dd>
    </dl></details>
  </section>;
}

/** Core owns grants, fixed build inputs, independent proofs and release receipts.
 * These controls retain drafts and exact in-flight identities across view changes. */
export function PluginBuildControls({ project, open, disabled, onState, onRecorded, onAttention, onOpenTranslation, ref }: {
  project: ProjectView; open: boolean; disabled: boolean; onState: (state: PluginBuildState) => void;
  onRecorded: (actionId: string) => Promise<void>; onAttention: () => void;
  onOpenTranslation?: (target: EditorTarget, locale: string) => boolean; ref?: Ref<PluginBuildHandle>;
}) {
  const { t } = useTranslation();
  const context = executionContext(project), reads = useSessionReads();
  const [choices, setChoices] = useState<BuildChoice[]>([]);
  const [environments, setEnvironments] = useState<PluginEnvironmentChoice[]>([]);
  const [choiceKey, setChoiceKey] = useState("");
  const [runtimeDigest, setRuntimeDigest] = useState("");
  const [environment, setEnvironment] = useState<PluginBuildView | null>(null);
  const [loading, setLoading] = useState(false);
  const [inventoryReady, setInventoryReady] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [languages, setLanguages] = useState<string[]>([]);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [prepared, setPrepared] = useState<{ request: PluginBuildPrepareRequest; review: PluginBuildReview } | null>(null);
  const [buildConsent, setBuildConsent] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<string | null>(null);
  const [checkReview, setCheckReview] = useState<ArtifactCheckReview | null>(null);
  const [checkConsent, setCheckConsent] = useState<string | null>(null);
  const [checkAttempt, setCheckAttempt] = useState<string | null>(null);
  const [pending, setPending] = useState<Intent | null>(null);
  const pendingRef = useRef<Intent | null>(null);
  const [receiptChecked, setReceiptChecked] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CommandFailure | null>(null);
  const [leave, setLeave] = useState(false);
  const leaveResolver = useRef<((answer: boolean) => void) | null>(null);
  const leaveTrigger = useRef<HTMLElement | null>(null);
  const restoreLeaveFocus = useRef(false);
  const running = useRef(false), mounted = useRef(true), sequence = useRef(0);
  const errorRegion = useRef<HTMLDivElement>(null);
  const choice = choices.find(item => item.key === choiceKey);
  const runtimes = matchingPluginEnvironments(environments, choice?.runtimeKinds ?? []);
  const environmentAvailable = runtimes.some(item => item.environmentDigest === runtimeDigest);
  const buildChoice: PluginBuildRequest | null = choice && runtimeDigest ? { package: choice.package, resourceId: choice.resourceId, environmentDigest: runtimeDigest } : null;
  const buildRead = useSessionQuery({ key: ["release-plugin-build", attempt], scopes: ["execution"], enabled: open && !!attempt && !busy,
    read: () => attempt ? readCompleteAttempt(context, attempt, "locale-build") : Promise.resolve(null) });
  const checkRead = useSessionQuery({ key: ["release-artifact-check", checkAttempt], scopes: ["execution"], enabled: open && !!checkAttempt && !busy,
    read: () => checkAttempt ? readCompleteAttempt(context, checkAttempt, "artifact-semantic-check") : Promise.resolve(null) });
  const detail = buildRead.data, checkDetail = checkRead.data, checkItem = checkDetail?.items[0];
  const checkActive = !!checkAttempt && (!checkDetail || checkDetail.items.some(item => item.status.execution === "queued" || item.status.execution === "dispatched"));
  const buildActive = !!attempt && (!detail || detail.items.some(item => item.status.execution === "queued" || item.status.execution === "dispatched"));
  const locked = disabled || busy || !!pending;
  const draftLocked = locked || !!prepared || !!attempt;
  const hasDraft = !attempt && (languages.length > 0 || Object.values(paths).some(value => value.length > 0) || !!prepared);
  const unavailable = !loading && (!inventoryReady || !choice || !environmentAvailable);
  const outputPaths = (locale: string) => (paths[locale] ?? "").split(/\r?\n/).filter(path => path.length > 0);
  const mappingReady = languages.length > 0 && languages.every(locale => outputPaths(locale).length > 0);
  const unit = detail?.recovery.units.length === 1 ? detail.recovery.units[0] : null;
  const complete = !!prepared && !!detail && detail.items.length === prepared.review.choices.length
    && prepared.review.choices.every(({ locale }) => detail.items.filter(item => item.scope.locale === locale).length === 1)
    && detail.items.every(item => item.resultId && item.status.execution === "succeeded" && item.status.validation === "valid" && !item.status.cancellationRequested);
  const canRecord = complete && !!unit?.actions.includes("adopt-result") && unit.resultIds.length === detail?.items.length
    && unit.resultIds.every(id => detail?.items.some(item => item.resultId === id));

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; leaveResolver.current?.(false); }; }, []);
  useEffect(() => { onState({ busy, pending: !!pending }); }, [busy, !!pending, onState]);
  useEffect(() => { if (failure && open) errorRegion.current?.focus(); }, [failure, open]);
  useEffect(() => { const error = buildRead.error ?? checkRead.error; if (error) setFailure(commandFailure(error)); }, [buildRead.error, checkRead.error]);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true); setInventoryReady(false);
    void (async () => {
      try {
        const inventory = await pluginCommands.inventory();
        const enabled = inventory.packages.filter(item => item.state === "sealed" && inventory.packageDecisions.some(decision => decision.enabled && decision.packageDigest === item.packageDigest && decision.plugin.id === item.plugin.id && decision.plugin.version === item.plugin.version && decision.plugin.publisher === item.plugin.publisher));
        const packages = await Promise.all(enabled.map(item => pluginCommands.package({ plugin: item.plugin, packageDigest: item.packageDigest })));
        const next = packages.flatMap(item => item.manifest.contributions.flatMap(contribution => contribution.contribution.kind === "resource" && contribution.contribution.schema.id === "tsumugi.build-declaration" && contribution.contribution.schema.schemaVersion === 1 && contribution.contribution.schema.behaviorVersion === 1 ? [{ key: `${item.packageDigest}:${contribution.id}`, label: `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${contribution.id}`, package: { plugin: item.manifest.plugin, packageDigest: item.packageDigest }, resourceId: contribution.id, runtimeKinds: item.manifest.components.map(component => component.runtime) }] : []));
        const environments = approvedPluginEnvironments(inventory);
        if (!stale) { setChoices(next); setEnvironments(environments); setInventoryReady(true); setChoiceKey(value => value || next[0]?.key || ""); setRuntimeDigest(value => value || matchingPluginEnvironments(environments, next[0]?.runtimeKinds ?? [])[0]?.environmentDigest || ""); }
      } catch (error) { if (!stale) setFailure(commandFailure(error)); }
      finally { if (!stale) setLoading(false); }
    })();
    return () => { stale = true; };
  }, [open, project.sessionToken, refresh]);
  useEffect(() => {
    setEnvironment(null);
    if (!open || !choice || !environmentAvailable || unavailable) return;
    let stale = false;
    void pluginCommands.build({ package: choice.package, resourceId: choice.resourceId, environmentDigest: runtimeDigest }).then(value => {
      if (value.resourceId !== choice.resourceId || value.environmentDigest !== runtimeDigest || [value.builder.provider, value.checker.provider].some(provider => provider.packageDigest !== choice.package.packageDigest || provider.plugin.id !== choice.package.plugin.id || provider.plugin.version !== choice.package.plugin.version || provider.plugin.publisher !== choice.package.plugin.publisher)) throw new Error("Build environment identity changed");
      if (!stale) setEnvironment(value);
    }).catch(error => { if (!stale) setFailure(commandFailure(error)); });
    return () => { stale = true; };
  }, [open, project.sessionToken, choice?.key, runtimeDigest, environmentAvailable, refresh, unavailable]);

  function updatePending(value: Intent | null) { pendingRef.current = value; setPending(value); setReceiptChecked(false); }
  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setFailure(null);
    const ticket = ++sequence.current, current = () => mounted.current && sequence.current === ticket;
    try { await work(current); }
    catch (error) { if (current()) setFailure(commandFailure(error)); }
    finally { running.current = false; if (mounted.current) { setBusy(false); reads.invalidate(["execution"]); } }
  }
  async function recorded(value: Receipt, current: () => boolean) {
    if (!current()) return;
    setReceipt(value); updatePending(null);
    await onRecorded(value.actionId);
  }
  async function submit(intent: Intent, current: () => boolean) {
    if (!current()) return;
    updatePending(intent);
    try {
      switch (intent.kind) {
        case "prepare-build": {
          const review = await releaseCommands.preparePlugin(intent.request);
          if (current()) { setPrepared({ request: intent.request, review }); setBuildConsent(null); updatePending(null); }
          break;
        }
        case "prepare-check": {
          const review = await releaseCommands.prepareCheck(intent.request);
          if (current()) { setCheckReview(review); setCheckAttempt(null); setCheckConsent(null); updatePending(null); }
          break;
        }
        case "start-build":
        case "start-check": {
          const id = intent.kind === "start-build" ? await releaseCommands.startPlugin(intent.request) : await releaseCommands.startCheck(intent.request);
          if (current()) { if (intent.kind === "start-build") setAttempt(id); else setCheckAttempt(id); updatePending(null); }
          break;
        }
        case "finish-check": {
          await releaseCommands.finishCheck(intent.request);
          if (current()) { setCheckReview(null); setCheckAttempt(null); setCheckConsent(null); updatePending(null); }
          break;
        }
        case "cancel": {
          await executionCommands.cancel(intent.request);
          if (current()) updatePending(null);
          break;
        }
        case "adopt": {
          if (!intent.prepared) {
            const action = await executionCommands.prepare(intent.request);
            if (action.actionId !== intent.request.actionId || action.attemptId !== intent.request.attemptId || action.unitId !== intent.request.unitId || action.projectId !== intent.request.projectId || action.operation !== "locale-build" || new Set(action.resultIds).size !== intent.request.resultIds.length || action.resultIds.length !== intent.request.resultIds.length || action.resultIds.some(id => !intent.request.resultIds.includes(id))) throw new Error("Release adoption identity changed");
            if (!current()) return;
            updatePending({ ...intent, prepared: true });
          }
          const value = await executionCommands.adopt({ ...context, actionId: intent.request.actionId });
          if (value.actionId !== intent.request.actionId || value.attemptId !== intent.request.attemptId || value.unitId !== intent.request.unitId || value.projectId !== context.projectId) throw new Error("Release receipt identity changed");
          await recorded(value, current);
          break;
        }
      }
    } catch (error) {
      if (current() && !hasUnknownOutcome(error)) { updatePending(null); if (intent.kind === "start-build") setBuildConsent(null); if (intent.kind === "start-check") setCheckConsent(null); }
      throw error;
    }
  }
  async function authorize(review: { attemptId: string; inputDigest: string }): Promise<PluginStartRequest> {
    return { ...context, attemptId: review.attemptId, inputDigest: review.inputDigest, grantId: await executionCommands.identity(context), expiresAtMs: String(Date.now() + 600_000), unsandboxedExecution: true };
  }
  function reset() {
    setPrepared(null); setBuildConsent(null); setAttempt(null); setCheckReview(null); setCheckConsent(null); setCheckAttempt(null); setEligibility(null); setReceipt(null);
  }
  async function discard(current: () => boolean, clearDraft: boolean) {
    await releaseCommands.cancelPluginPreparation(context);
    if (current()) { reset(); updatePending(null); if (clearDraft) { setLanguages([]); setPaths({}); } }
  }
  function answerLeave(answer: boolean) { restoreLeaveFocus.current = !answer; setLeave(false); leaveResolver.current?.(answer); leaveResolver.current = null; }
  useImperativeHandle(ref, () => ({
    allowNavigate: () => Promise.resolve(!running.current && !pendingRef.current),
    allowLeave() {
      if (running.current || pendingRef.current) { onAttention(); return Promise.resolve(false); }
      if (!hasDraft) return Promise.resolve(true);
      leaveTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      restoreLeaveFocus.current = true;
      setLeave(true); return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
    },
  }));
  async function cancelTask(detail: AttemptDetail, current: () => boolean) {
    const request = { ...context, taskId: detail.taskId, requestId: await executionCommands.identity(context) };
    await submit({ kind: "cancel", request }, current);
  }

  return <>
    <section aria-label={t("release.prepare")} aria-busy={busy || loading}>
      <h3>{t("release.prepare")}</h3><p>{t("release.scope")}</p>
      {failure ? <div ref={errorRegion} role="alert" tabIndex={-1}><p>{t("releasePlugin.failed")}</p><CommandFailureDetails failure={failure} />{typeof failure === "string" ? <details><summary>{t("execution.diagnostic")}</summary><code>{failure}</code></details> : null}</div> : null}
      {busy || loading ? <p role="status">{t("execution.working")}</p> : null}
      <label className="source-field">{t("releasePlugin.builder")}<select value={choiceKey} disabled={draftLocked || loading} onChange={event => { const key = event.target.value; setChoiceKey(key); const matching = matchingPluginEnvironments(environments, choices.find(item => item.key === key)?.runtimeKinds ?? []); setRuntimeDigest(current => matching.some(item => item.environmentDigest === current) ? current : matching[0]?.environmentDigest ?? ""); setEligibility(null); setBuildConsent(null); }}>
        {!choice ? <option value={choiceKey}>{t("releasePlugin.chooseBuilder")}</option> : null}
        {choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select></label>
      <label className="source-field">{t("sourcePlugin.runtime")}<select value={runtimeDigest} disabled={draftLocked || loading} onChange={event => { setRuntimeDigest(event.target.value); setEligibility(null); setBuildConsent(null); }}>
        {!runtimes.some(item => item.environmentDigest === runtimeDigest) ? <option value={runtimeDigest}>{t("sourcePlugin.chooseRuntime")}</option> : null}
        {runtimes.map(item => <option key={item.environmentDigest} value={item.environmentDigest}>{t(item.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption", { version: pluginEnvironmentVersion(item.environment), system: item.environment.platform.operatingSystem, architecture: item.environment.platform.architecture })}</option>)}
      </select></label>
      <button className="secondary-button" disabled={locked || !!prepared || !!attempt} onClick={() => { setFailure(null); setEligibility(null); setRefresh(value => value + 1); }}>{t("releasePlugin.refresh")}</button>
      {unavailable ? <p role="status">{t("releasePlugin.unavailable")}</p> : null}
      {environment ? <p>{t("releasePlugin.limits", { name: environment.declaration.displayName, count: environment.declaration.outputLimits.maxArtifacts, bytes: String(environment.declaration.outputLimits.maxTotalBytes) })}</p> : null}
      <fieldset><legend>{t("release.languages")}</legend>{project.metadata.targetLocales.map(locale => <label key={locale} className="release-locale"><input type="checkbox" checked={languages.includes(locale)} disabled={draftLocked} onChange={event => { const checked = event.target.checked; setLanguages(previous => checked ? [...previous, locale] : previous.filter(item => item !== locale)); setEligibility(null); }} />{locale}</label>)}</fieldset>
      {languages.map(locale => <label className="source-field" key={locale}>{t("releasePlugin.paths", { locale })}<textarea value={paths[locale] ?? ""} disabled={draftLocked} onChange={event => { setPaths(previous => ({ ...previous, [locale]: event.target.value })); setEligibility(null); }} /></label>)}
      <p>{t("releasePlugin.pathHelp")}</p><p>{t("release.policy")}</p>
      <div className="form-actions"><button className="secondary-button" disabled={draftLocked || loading || !mappingReady || !environment || unavailable} onClick={() => void perform(async current => {
        const value = await reviewCommands.eligibility({ ...context, locales: languages });
        if (current()) setEligibility(value);
      })}>{t("release.check")}</button><button className="primary-button" disabled={draftLocked || loading || !mappingReady || !eligibility?.ready || !environment || unavailable} onClick={() => void perform(async current => {
        if (!buildChoice || !eligibility) return;
        const request = { ...context, attemptId: await executionCommands.identity(context), expectedEligibilityBasis: eligibility.basis, build: buildChoice, choices: languages.map(locale => ({ locale, outputPaths: outputPaths(locale), configuration: [] })) };
        await submit({ kind: "prepare-build", request }, current);
      })}>{t("releasePlugin.capture")}</button></div>
      {eligibility ? <div role="status"><p>{t(eligibility.ready ? "release.ready" : "release.blocked", { count: eligibility.ready ? eligibility.locales.reduce((sum, item) => sum + item.exceptionCount, 0) : eligibility.locales.reduce((sum, item) => sum + item.blockerCount, 0) })}</p>
        <p>{t("release.source", { id: eligibility.sourceSnapshotId })} · {eligibility.policyVersion}</p>
        {eligibility.locales.map(item => <div key={item.locale}><strong>{item.locale}</strong>: {t("release.coverage", { count: item.checkedUnits })}{item.blockers.map((reason, index) => <div className="release-blocker" key={`${reason.unitId}:${index}`}>{reason.nativeKey}: {t(reviewReasonKey(reason.code))} {onOpenTranslation ? <button className="text-button" disabled={locked} onClick={() => void perform(async current => { const target = await reviewCommands.target({ ...context, unitId: reason.unitId, locale: item.locale }); if (current()) onOpenTranslation({ unitId: target.unitId, sourceRevisionId: target.sourceRevisionId, key: target.nativeKey, sourceText: target.sourceText }, item.locale); })}>{t("translation.openEditor")}</button> : null}</div>)}{item.exceptions.map((reason, index) => <p key={`${reason.unitId}:${index}`}>{t("release.exception", { key: reason.nativeKey, reason: reason.code })}</p>)}</div>)}
      </div> : null}
      {prepared ? <>
        <h4>{t("releasePlugin.fixedBuild")}</h4><p>{t("release.source", { id: prepared.review.sourceSnapshotId })}</p>
        <ul>{prepared.review.choices.map(({ locale, outputPaths }) => <li key={locale}>{locale}<ul>{outputPaths.map(path => <li key={path}>{path}</li>)}</ul></li>)}</ul>
        {!attempt ? <><BuildExecutionReview build={prepared.review.build} checker={false} />
          <label className="source-check"><input type="checkbox" checked={buildConsent === prepared.review.inputDigest} disabled={locked} onChange={event => setBuildConsent(event.target.checked ? prepared.review.inputDigest : null)} />{t("releasePlugin.builderConsent")}</label>
          <button className="primary-button" disabled={locked || buildConsent !== prepared.review.inputDigest} onClick={() => void perform(async current => { const request = await authorize(prepared.review); await submit({ kind: "start-build", request }, current); })}>{t("release.build")}</button>
          <button className="text-button" disabled={locked} onClick={() => void perform(current => discard(current, false))}>{t("releasePlugin.discard")}</button>
        </> : null}
      </> : null}
      {attempt ? <section aria-label={t("releasePlugin.results")}>
        <h4>{t("releasePlugin.results")}</h4><p>{t("release.started", { id: attempt })}</p>
        {detail ? <ul>{detail.items.map(item => <li key={item.status.itemId}>{item.scope.locale} · {t(`execution.states.${item.status.execution}`)} · {t(`releasePlugin.validation.${item.status.validation}`)}
          {item.status.cancellationRequested ? <p>{t("releasePlugin.cancelled")}</p> : null}
          {item.status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary>{item.status.diagnostic}</details> : null}
          {item.scope.locale !== null && item.resultId && item.status.execution === "succeeded" && item.status.validation !== "valid" && !item.status.cancellationRequested && prepared ? <button className="secondary-button" disabled={locked || checkActive} onClick={() => void perform(async current => {
            const request = { ...context, buildAttemptId: attempt, buildResultId: item.resultId!, attemptId: await executionCommands.identity(context), build: prepared.request.build };
            await submit({ kind: "prepare-check", request }, current);
          })}>{t("releasePlugin.prepareCheck", { locale: item.scope.locale })}</button> : null}
        </li>)}</ul> : <p role="status">{t("releasePlugin.waiting")}</p>}
        <button className="secondary-button" disabled={locked} onClick={() => void buildRead.refetch()}>{t("execution.refresh")}</button>
        {detail && buildActive ? <><p>{t("execution.cancelHelp")}</p><button className="secondary-button" disabled={locked} onClick={() => void perform(current => cancelTask(detail, current))}>{t("execution.cancel")}</button></> : null}
      </section> : null}
      {checkReview ? <section aria-label={t("releasePlugin.artifacts")}>
        <h4>{t("releasePlugin.checkLocale", { locale: checkReview.locale })}</h4>
        <ul>{checkReview.artifacts.map(file => <li key={`${file.id}:${file.logicalPath}`}>{file.logicalPath} · {t("releasePlugin.bytes", { count: file.byteLength })}<details><summary>{t("source.fingerprint")}</summary><code>{file.sha256}</code></details></li>)}</ul>
        <p>{t("releasePlugin.rules", { count: checkReview.requirements.length })}</p>
        {!checkAttempt ? <><BuildExecutionReview build={checkReview.build} checker />
          <label className="source-check"><input type="checkbox" checked={checkConsent === checkReview.inputDigest} disabled={locked} onChange={event => setCheckConsent(event.target.checked ? checkReview.inputDigest : null)} />{t("releasePlugin.checkerConsent")}</label>
          <button className="primary-button" disabled={locked || checkConsent !== checkReview.inputDigest} onClick={() => void perform(async current => { const request = await authorize(checkReview); await submit({ kind: "start-check", request }, current); })}>{t("releasePlugin.startCheck")}</button>
        </> : <>
          <p role="status">{t(checkItem?.status.execution === "succeeded" ? "releasePlugin.checkReceived" : checkActive ? "releasePlugin.checkRunning" : "releasePlugin.checkFailed")}</p>
          {checkItem?.status.execution === "succeeded" && checkItem.resultId && !checkItem.status.cancellationRequested ? <button className="primary-button" disabled={locked} onClick={() => void perform(current => submit({ kind: "finish-check", request: { ...context, attemptId: checkAttempt, resultId: checkItem.resultId! } }, current))}>{t("releasePlugin.recordCheck")}</button> : null}
          <button className="secondary-button" disabled={locked} onClick={() => void checkRead.refetch()}>{t("execution.refresh")}</button>
          {checkDetail && checkActive ? <><p>{t("execution.cancelHelp")}</p><button className="secondary-button" disabled={locked} onClick={() => void perform(current => cancelTask(checkDetail, current))}>{t("execution.cancel")}</button></> : null}
        </>}
      </section> : null}
      {canRecord && unit && attempt && !receipt ? <><p role="status">{t("releasePlugin.allChecked")}</p><button className="primary-button" disabled={locked} onClick={() => void perform(async current => {
        const request = { ...context, attemptId: attempt, unitId: unit.unitId, resultIds: unit.resultIds, actionId: await executionCommands.identity(context) };
        await submit({ kind: "adopt", request, prepared: false }, current);
      })}>{t("releasePlugin.recordRelease")}</button></> : null}
      {receipt ? <p role="status">{t("releasePlugin.recorded")}</p> : null}
      {attempt && !buildActive && !checkActive ? <button className="secondary-button" disabled={locked} onClick={() => void perform(current => discard(current, false))}>{t("releasePlugin.newBuild")}</button> : null}
      {pending && !busy ? <section role="status"><p>{t("releasePlugin.unknown")}</p>
        <button className="secondary-button" onClick={() => void perform(async current => {
          if (pending.kind !== "adopt") { await submit(pending, current); return; }
          await projectCommands.read({ sessionToken: context.sessionToken });
          const value = await executionCommands.receipt({ ...context, actionId: pending.request.actionId });
          if (value) {
            if (value.actionId !== pending.request.actionId || value.attemptId !== pending.request.attemptId || value.unitId !== pending.request.unitId || value.projectId !== context.projectId) throw new Error("Release receipt identity changed");
            await recorded(value, current);
          } else if (current()) setReceiptChecked(true);
        })}>{t("releasePlugin.reconcile")}</button>
        {pending.kind === "adopt" && receiptChecked ? <><p>{t("execution.noReceipt")}</p><button className="secondary-button" onClick={() => void perform(current => submit(pending, current))}>{t("execution.retryAdoption")}</button></> : null}
        {pending.kind === "prepare-build" || pending.kind === "prepare-check" ? <button className="secondary-button" onClick={() => void perform(current => discard(current, false))}>{t("releasePlugin.discard")}</button> : null}
      </section> : null}
    </section>
    <Dialog.Root open={leave} onOpenChange={next => { if (!next && !running.current) answerLeave(false); }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()} onCloseAutoFocus={event => { if (restoreLeaveFocus.current && leaveTrigger.current?.isConnected) { event.preventDefault(); leaveTrigger.current.focus(); } }}>
        <Dialog.Title>{t("releasePlugin.leaveTitle")}</Dialog.Title><Dialog.Description>{t("releasePlugin.leaveHelp")}</Dialog.Description>
        {failure ? <div role="alert"><p>{t("releasePlugin.failed")}</p><CommandFailureDetails failure={failure} />{typeof failure === "string" ? <details><summary>{t("execution.diagnostic")}</summary><code>{failure}</code></details> : null}</div> : null}
        <div className="form-actions"><button className="secondary-button" disabled={busy} onClick={() => answerLeave(false)}>{t("source.keep")}</button>
          <button className="primary-button" disabled={busy} onClick={() => void perform(async current => { await discard(current, true); if (current()) answerLeave(true); })}>{t("source.leave")}</button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </>;
}
