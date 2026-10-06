import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { PluginPermissions } from "./PluginManager";
import { pluginCommands, type PluginTranslationRequest, type PluginTranslationView } from "./pluginCommands";
import { translationCommands as commands, type PluginTranslationCaptureRequest, type PluginTranslationPreflight, type PluginTranslationSelection, type PluginStartRequest, type TranslationCheckPrepareRequest, type TranslationCheckFinishRequest, type TranslationCheckReview, type TranslationProjectionPrepareRequest, type TranslationProjectionReview, type TranslationProjectionStartRequest } from "./translationCommands";
import { executionCommands, executionContext, type AttemptDetail, type CancelRequest } from "./executionCommands";
import { readCompleteAttempt } from "./executionRead";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";

export interface PluginTranslationState { busy: boolean; pending: boolean; hasDraft: boolean }
export interface PluginTranslationHandle { allowLeave: () => Promise<boolean>; allowNavigate: () => boolean }
type Intent =
  | { kind: "capture"; request: PluginTranslationCaptureRequest }
  | { kind: "start" | "start-check"; request: PluginStartRequest }
  | { kind: "prepare-check"; request: TranslationCheckPrepareRequest }
  | { kind: "finish-check"; request: TranslationCheckFinishRequest }
  | { kind: "prepare-projection"; request: TranslationProjectionPrepareRequest }
  | { kind: "start-projection"; request: TranslationProjectionStartRequest }
  | { kind: "cancel"; request: CancelRequest };
const sameProfile = (left: PluginTranslationView["declaration"]["profile"], right: PluginTranslationView["declaration"]["profile"]) => left.id === right.id && left.schemaVersion === right.schemaVersion && left.behaviorVersion === right.behaviorVersion;
function matchesEnvironment(view: PluginTranslationView, request: PluginTranslationRequest) {
  return view.resourceId === request.resourceId && view.environmentDigest === request.environmentDigest && [view.extractor.provider, view.checker.provider].every(provider => provider.packageDigest === request.package.packageDigest && provider.plugin.id === request.package.plugin.id && provider.plugin.version === request.package.plugin.version && provider.plugin.publisher === request.package.plugin.publisher);
}

function ExecutionReview({ view, checker }: { view: PluginTranslationView; checker: boolean }) {
  const { t } = useTranslation(), capability = checker ? view.checker : view.extractor;
  return <section aria-label={t(checker ? "translationPlugin.checkReview" : "translationPlugin.producerReview")}>
    <p>{view.declaration.displayName} · {capability.provider.plugin.id} {capability.provider.plugin.version}</p>
    <p>{t("sourcePlugin.runtimeDetails", { version: view.environment.toolVersion, system: view.environment.platform.operatingSystem, architecture: view.environment.platform.architecture })}</p>
    <PluginPermissions permissions={capability.declaration.permissions} /><p>{t("sourcePlugin.unsandboxed")}</p>
    <details><summary>{t("sourcePlugin.fixedDetails")}</summary><dl>
      <dt>{t("sourcePlugin.packageDigest")}</dt><dd><code>{capability.provider.packageDigest}</code></dd>
      <dt>{t("sourcePlugin.runtimeDigest")}</dt><dd><code>{view.environmentDigest}</code></dd>
      <dt>{t("translationPlugin.profile")}</dt><dd><code>{view.declaration.profile.id}</code> ({view.declaration.profile.schemaVersion}/{view.declaration.profile.behaviorVersion})</dd>
    </dl></details>
  </section>;
}

/** Controls stay mounted with the workbench. Original requests survive unknown
 * acknowledgements; all qualification and mutation authority remains in Core. */
export function PluginTranslationControls({ project, open, targetLocale, disabled, onState, onProjected, onReset, onAttention, ref }: {
  project: ProjectView; open: boolean; targetLocale: string; disabled: boolean;
  onState: (state: PluginTranslationState) => void; onProjected: (attempt: string) => void;
  onReset: () => void; onAttention: () => void; ref?: Ref<PluginTranslationHandle>;
}) {
  const { t } = useTranslation(), context = executionContext(project), reads = useSessionReads();
  const [choiceKey, setChoiceKey] = useState(""), [runtimeDigest, setRuntimeDigest] = useState("");
  const [scopeIndex, setScopeIndex] = useState("0"), [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<PluginTranslationSelection | null>(null);
  const [files, setFiles] = useState<string[]>([]), [fileName, setFileName] = useState("");
  const [languageConfirmed, setLanguageConfirmed] = useState(false);
  const [prepared, setPrepared] = useState<PluginTranslationPreflight | null>(null);
  const [producerConsent, setProducerConsent] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<string | null>(null);
  const [checkReview, setCheckReview] = useState<TranslationCheckReview | null>(null);
  const [checkConsent, setCheckConsent] = useState<string | null>(null), [checkAttempt, setCheckAttempt] = useState<string | null>(null);
  const [projection, setProjection] = useState<TranslationProjectionReview | null>(null), [projected, setProjected] = useState<string | null>(null);
  const [pending, setPending] = useState<Intent | null>(null), pendingRef = useRef<Intent | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<CommandFailure | null>(null), [leave, setLeave] = useState(false);
  const mounted = useRef(true), running = useRef(false), sequence = useRef(0), errorRegion = useRef<HTMLDivElement>(null);
  const leaveResolver = useRef<((answer: boolean) => void) | null>(null), leaveTrigger = useRef<HTMLElement | null>(null);
  const inventory = useSessionQuery({ key: ["translation-plugin-inventory", refresh], scopes: [], enabled: open && !disabled,
    read: async () => {
      const value = await pluginCommands.inventory();
      const enabled = value.packages.filter(item => item.state === "sealed" && value.packageDecisions.some(decision => decision.enabled && decision.packageDigest === item.packageDigest && decision.plugin.id === item.plugin.id && decision.plugin.version === item.plugin.version && decision.plugin.publisher === item.plugin.publisher));
      const packages = await Promise.all(enabled.map(item => pluginCommands.package({ plugin: item.plugin, packageDigest: item.packageDigest })));
      const choices = packages.flatMap(item => item.manifest.contributions.flatMap(contribution => contribution.contribution.kind === "resource" && contribution.contribution.schema.id === "tsumugi.translation-import-declaration" && contribution.contribution.schema.schemaVersion === 1 && contribution.contribution.schema.behaviorVersion === 1 ? [{ key: `${item.packageDigest}:${contribution.id}`, label: `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${contribution.id}`, package: { plugin: item.manifest.plugin, packageDigest: item.packageDigest }, resourceId: contribution.id }] : []));
      return { choices, runtimes: value.runtimes.filter(item => item.state === "sealed" && value.runtimeDecisions.some(decision => decision.environmentDigest === item.environmentDigest)) };
    } });
  const choices = inventory.data?.choices ?? [], runtimes = inventory.data?.runtimes ?? [];
  const effectiveChoice = choiceKey || choices[0]?.key || "", effectiveRuntime = runtimeDigest || runtimes[0]?.environmentDigest || "";
  const choice = choices.find(item => item.key === effectiveChoice);
  const translation: PluginTranslationRequest | null = choice && effectiveRuntime ? { package: choice.package, resourceId: choice.resourceId, environmentDigest: effectiveRuntime } : null;
  const source = useSessionQuery({ key: ["translation-plugin-source", targetLocale], scopes: ["source"], enabled: open && !!targetLocale,
    read: () => commands.pluginSource({ ...context, targetLocale }) });
  const environment = useSessionQuery({ key: ["translation-plugin-environment", effectiveChoice, effectiveRuntime, refresh, inventory.dataUpdatedAt], scopes: [], enabled: open && !disabled && !!translation && !inventory.error && !inventory.isFetching,
    read: async () => { const value = await pluginCommands.translation(translation!); if (!matchesEnvironment(value, translation!)) throw new Error("Translation environment identity changed"); return value; } });
  const nativeScope = source.data?.nativeScopes[Number(scopeIndex)];
  const unavailable = !!inventory.error || !!environment.error || !choice || !effectiveRuntime || !runtimes.some(item => item.environmentDigest === effectiveRuntime) || !environment.data || !source.data || !sameProfile(environment.data.declaration.profile, source.data.profile) || !nativeScope;
  const producer = useSessionQuery({ key: ["translation-plugin-producer", attempt], scopes: ["execution"], enabled: open && !!attempt && !busy,
    read: () => readCompleteAttempt(context, attempt!, "translation-extract") });
  const check = useSessionQuery({ key: ["translation-plugin-checker", checkAttempt], scopes: ["execution"], enabled: open && !!checkAttempt && !busy,
    read: () => readCompleteAttempt(context, checkAttempt!, "translation-semantic-check") });
  const projectionRead = useSessionQuery({ key: ["translation-plugin-projection", projected], scopes: ["execution"], enabled: open && !!projected && !busy,
    read: () => readCompleteAttempt(context, projected!, "translation-import") });
  const item = producer.data?.items.length === 1 ? producer.data.items[0] : null, checkedItem = check.data?.items.length === 1 ? check.data.items[0] : null;
  const active = (id: string | null, value: AttemptDetail | null | undefined) => !!id && (!value || value.items.some(row => row.status.execution === "queued" || row.status.execution === "dispatched"));
  const working = active(attempt, producer.data) || active(checkAttempt, check.data) || active(projected, projectionRead.data);
  const locked = disabled || busy || !!pending, draftLocked = locked || !!prepared || !!attempt;
  const hasDraft = !!selection && !projected;
  const sourceChanged = !!selection && !!source.data && selection.source.sourceSnapshotId !== source.data.sourceSnapshotId;
  const environmentChanged = !!prepared && !!environment.data && JSON.stringify(prepared.translation) !== JSON.stringify(environment.data);
  const preparationBlocked = unavailable || sourceChanged || environmentChanged || inventory.isFetching || environment.isFetching;
  const canCheck = !!item?.resultId && item.status.execution === "succeeded" && item.status.validation !== "valid" && !item.status.cancellationRequested;
  const retryCheck = !!checkedItem && (checkedItem.status.cancellationRequested || checkedItem.status.execution === "failed" || checkedItem.status.execution === "unknown" || checkedItem.status.execution === "cancelled-before-dispatch");
  const canProject = !!item?.resultId && item.status.execution === "succeeded" && item.status.validation === "valid" && !item.status.cancellationRequested;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; leaveResolver.current?.(false); }; }, []);
  useEffect(() => { onState({ busy: busy || working, pending: !!pending, hasDraft }); }, [busy, working, !!pending, hasDraft, onState]);
  useEffect(() => { if (failure && open) errorRegion.current?.focus(); }, [failure, open]);
  useEffect(() => { const error = inventory.error ?? environment.error ?? source.error ?? producer.error ?? check.error ?? projectionRead.error; if (error) setFailure(commandFailure(error)); }, [inventory.error, environment.error, source.error, producer.error, check.error, projectionRead.error]);

  function retain(intent: Intent | null) { pendingRef.current = intent; setPending(intent); }
  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setFailure(null);
    const ticket = ++sequence.current, current = () => mounted.current && sequence.current === ticket;
    try { await work(current); } catch (error) { if (current()) setFailure(commandFailure(error)); }
    finally { running.current = false; if (mounted.current) { setBusy(false); reads.invalidate(["execution"]); } }
  }
  async function submit(intent: Intent, current: () => boolean) {
    if (!current()) return;
    retain(intent);
    try {
      switch (intent.kind) {
        case "capture": {
          const value = await commands.preflightPlugin(intent.request);
          if (value.attemptId !== intent.request.attemptId || !selection || value.targetLocale !== selection.targetLocale || JSON.stringify(value.source) !== JSON.stringify(selection.source) || JSON.stringify(value.translation) !== JSON.stringify(selection.translation)) throw new Error("Translation capture identity changed");
          if (current()) { setPrepared(value); setProducerConsent(null); retain(null); }
          break;
        }
        case "start": case "start-check": {
          const id = intent.kind === "start" ? await commands.startPlugin(intent.request) : await commands.startCheck(intent.request);
          if (id !== intent.request.attemptId) throw new Error("Translation attempt identity changed");
          if (current()) { if (intent.kind === "start") setAttempt(id); else setCheckAttempt(id); retain(null); }
          break;
        }
        case "prepare-check": {
          const value = await commands.prepareCheck(intent.request);
          if (value.attemptId !== intent.request.attemptId || value.translationAttemptId !== intent.request.translationAttemptId || value.translationResultId !== intent.request.translationResultId || !matchesEnvironment(value.translation, intent.request.translation)) throw new Error("Translation check identity changed");
          if (current()) { setCheckReview(value); setCheckConsent(null); setCheckAttempt(null); retain(null); }
          break;
        }
        case "finish-check": await commands.finishCheck(intent.request); if (current()) { setCheckReview(null); setCheckConsent(null); retain(null); } break;
        case "prepare-projection": {
          const value = await commands.prepareProjection(intent.request);
          if (value.attemptId !== intent.request.attemptId || value.translationAttemptId !== intent.request.translationAttemptId || value.translationResultId !== intent.request.translationResultId) throw new Error("Translation projection identity changed");
          if (current()) { setProjection(value); retain(null); }
          break;
        }
        case "start-projection": {
          const id = await commands.startProjection(intent.request);
          if (id !== intent.request.attemptId) throw new Error("Translation preview identity changed");
          if (current()) { setProjected(id); onProjected(id); retain(null); }
          break;
        }
        case "cancel": await executionCommands.cancel(intent.request); if (current()) retain(null); break;
      }
    } catch (error) { if (current() && !hasUnknownOutcome(error)) { retain(null); setProducerConsent(null); setCheckConsent(null); } throw error; }
  }
  async function authorize(review: { attemptId: string; inputDigest: string }): Promise<PluginStartRequest> {
    return { ...context, attemptId: review.attemptId, inputDigest: review.inputDigest, grantId: await executionCommands.identity(context), expiresAtMs: String(Date.now() + 600_000), unsandboxedExecution: true };
  }
  function reset() {
    setSelection(null); setFiles([]); setFileName(""); setLanguageConfirmed(false); setPrepared(null); setProducerConsent(null); setAttempt(null); setCheckReview(null); setCheckConsent(null); setCheckAttempt(null); setProjection(null); setProjected(null); setFailure(null); onReset();
  }
  async function choose(current: () => boolean) {
    if (!translation || !source.data || !nativeScope || unavailable) return;
    const selected = await commands.selectPlugin({ ...context, translation, targetLocale, expectedSourceSnapshotId: source.data.sourceSnapshotId, nativeScope });
    if (!current() || !selected) return;
    if (selected.targetLocale !== targetLocale || JSON.stringify(selected.source) !== JSON.stringify(source.data) || !matchesEnvironment(selected.translation, translation) || selected.nativeScope.namespace !== nativeScope.namespace || !sameProfile(selected.nativeScope.policy, nativeScope.policy)) throw new Error("Translation selection identity changed");
    reset(); setChoiceKey(effectiveChoice); setRuntimeDigest(effectiveRuntime); setSelection(selected);
    const found = await commands.pluginFiles({ ...context, selectionId: selected.selectionId });
    if (current()) { setFiles(found); setFileName(found[0] ?? ""); }
  }
  function answerLeave(answer: boolean) { setLeave(false); leaveResolver.current?.(answer); leaveResolver.current = null; }
  useImperativeHandle(ref, () => ({
    allowNavigate: () => !running.current && !pendingRef.current,
    allowLeave() {
      if (running.current || pendingRef.current || working) { onAttention(); return Promise.resolve(false); }
      if (!hasDraft) return Promise.resolve(true);
      onAttention(); leaveTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setLeave(true); return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
    },
  }));
  async function cancel(detail: AttemptDetail, current: () => boolean) { await submit({ kind: "cancel", request: { ...context, taskId: detail.taskId, requestId: await executionCommands.identity(context) } }, current); }
  return <>
    <section aria-label={t("translationPlugin.controls")} aria-busy={busy || inventory.isFetching || environment.isFetching}>
      <h3>{t("translationPlugin.controls")}</h3>
      {failure ? <div ref={errorRegion} role="alert" tabIndex={-1}><p>{t("translationPlugin.failed")}</p><CommandFailureDetails failure={failure} /></div> : null}
      {inventory.isFetching || environment.isFetching || busy || working ? <p role="status">{t("execution.working")}</p> : null}
      <label className="source-field">{t("translationPlugin.package")}<select value={effectiveChoice} disabled={draftLocked} onChange={event => { setChoiceKey(event.target.value); setLanguageConfirmed(false); }}>
        {!choice ? <option value={effectiveChoice}>{t("translationPlugin.choosePackage")}</option> : null}{choices.map(value => <option key={value.key} value={value.key}>{value.label}</option>)}
      </select></label>
      <label className="source-field">{t("sourcePlugin.runtime")}<select value={effectiveRuntime} disabled={draftLocked} onChange={event => { setRuntimeDigest(event.target.value); setLanguageConfirmed(false); }}>
        {!runtimes.some(value => value.environmentDigest === effectiveRuntime) ? <option value={effectiveRuntime}>{t("sourcePlugin.chooseRuntime")}</option> : null}
        {runtimes.map(value => <option key={value.environmentDigest} value={value.environmentDigest}>{t("sourcePlugin.runtimeOption", { version: value.environment.toolVersion, system: value.environment.platform.operatingSystem, architecture: value.environment.platform.architecture })}</option>)}
      </select></label>
      <button className="secondary-button" disabled={locked} onClick={() => { setFailure(null); setRefresh(value => value + 1); reads.invalidate(["execution", "source"]); }}>{t("translationPlugin.refresh")}</button>
      {sourceChanged ? <p role="alert">{t("translation.sourceChanged")}</p> : null}
      {environmentChanged ? <p role="alert">{t("translationPlugin.environmentChanged")}</p> : null}
      {unavailable && !inventory.isFetching && !environment.isFetching ? <p role="status">{t("translationPlugin.unavailable")}</p> : null}
      {(source.data?.nativeScopes.length ?? 0) > 1 ? <label className="source-field">{t("translationPlugin.scope")}<select value={scopeIndex} disabled={draftLocked} onChange={event => { setScopeIndex(event.target.value); setSelection(null); setFiles([]); setFileName(""); setLanguageConfirmed(false); }}>{source.data?.nativeScopes.map((value, index) => <option value={String(index)} key={`${value.namespace}:${value.policy.id}:${value.policy.schemaVersion}:${value.policy.behaviorVersion}`}>{value.namespace} · {value.policy.id}</option>)}</select></label> : null}
      {!prepared && !attempt ? <>
        {environment.data ? <p>{t("translationPlugin.material", { directory: environment.data.declaration.material.logicalDirectory, extension: environment.data.declaration.material.extension, bytes: String(environment.data.declaration.material.maxBytes) })}</p> : null}
        <button className="secondary-button" disabled={draftLocked || unavailable || inventory.isFetching || environment.isFetching} onClick={() => void perform(choose)}>{t("translation.chooseFolder")}</button>
        {selection ? <><p>{t("translation.folder", { name: selection.folderName })}</p>{files.length ? <label className="source-field">{t("translation.file")}<select value={fileName} disabled={draftLocked} onChange={event => { setFileName(event.target.value); setLanguageConfirmed(false); }}>{files.map(file => <option key={file} value={file}>{file}</option>)}</select></label> : <p role="status">{t("translation.noFiles")}</p>}
          <label className="source-check"><input type="checkbox" checked={languageConfirmed} disabled={draftLocked || !fileName || selection.targetLocale !== targetLocale} onChange={event => setLanguageConfirmed(event.target.checked)} />{t("translationPlugin.languageConfirm", { file: fileName, target: selection.targetLocale })}</label>
          <button className="primary-button" disabled={draftLocked || sourceChanged || !languageConfirmed || !fileName || selection.targetLocale !== targetLocale} onClick={() => void perform(async current => { await submit({ kind: "capture", request: { ...context, selectionId: selection.selectionId, fileName, languageConfirmed: true, attemptId: await executionCommands.identity(context) } }, current); })}>{t("translationPlugin.capture")}</button>
        </> : null}
      </> : null}
      {prepared ? <><p>{t("translationPlugin.captured", { file: prepared.file.logicalPath, bytes: String(prepared.file.byteLength), target: prepared.targetLocale })}</p>
        {!attempt ? <><ExecutionReview view={prepared.translation} checker={false} /><label className="source-check"><input type="checkbox" checked={producerConsent === prepared.inputDigest} disabled={locked} onChange={event => setProducerConsent(event.target.checked ? prepared.inputDigest : null)} />{t("translationPlugin.producerConsent")}</label>
          <button className="primary-button" disabled={locked || preparationBlocked || producerConsent !== prepared.inputDigest} onClick={() => void perform(async current => { await submit({ kind: "start", request: await authorize(prepared) }, current); })}>{t("translation.start")}</button></> : null}
      </> : null}
      {item ? <p role="status">{t(`execution.states.${item.status.execution}`)} · {t(`releasePlugin.validation.${item.status.validation}`)}</p> : null}
      {item?.status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary>{item.status.diagnostic}</details> : null}
      {canCheck && prepared && attempt && (!checkReview || retryCheck) ? <button className="secondary-button" disabled={locked || preparationBlocked || active(checkAttempt, check.data)} onClick={() => void perform(async current => { await submit({ kind: "prepare-check", request: { ...context, translationAttemptId: attempt, translationResultId: item!.resultId!, attemptId: await executionCommands.identity(context), translation: { package: { plugin: prepared.translation.extractor.provider.plugin, packageDigest: prepared.translation.extractor.provider.packageDigest }, resourceId: prepared.translation.resourceId, environmentDigest: prepared.translation.environmentDigest } } }, current); })}>{t("translationPlugin.prepareCheck")}</button> : null}
      {checkReview && !checkAttempt ? <><ExecutionReview view={checkReview.translation} checker /><p>{t("translationPlugin.rules", { count: checkReview.rules.length })}</p>
        <label className="source-check"><input type="checkbox" checked={checkConsent === checkReview.inputDigest} disabled={locked} onChange={event => setCheckConsent(event.target.checked ? checkReview.inputDigest : null)} />{t("translationPlugin.checkerConsent")}</label>
        <button className="primary-button" disabled={locked || preparationBlocked || checkConsent !== checkReview.inputDigest} onClick={() => void perform(async current => { await submit({ kind: "start-check", request: await authorize(checkReview) }, current); })}>{t("translationPlugin.startCheck")}</button>
      </> : null}
      {checkedItem ? <p role="status">{t(`execution.states.${checkedItem.status.execution}`)}</p> : null}
      {checkedItem?.status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary>{checkedItem.status.diagnostic}</details> : null}
      {checkReview && checkedItem?.resultId && checkedItem.status.execution === "succeeded" && !checkedItem.status.cancellationRequested ? <button className="primary-button" disabled={locked} onClick={() => void perform(async current => { await submit({ kind: "finish-check", request: { ...context, translationAttemptId: checkReview.translationAttemptId, translationResultId: checkReview.translationResultId, attemptId: checkReview.attemptId, resultId: checkedItem.resultId! } }, current); })}>{t("translationPlugin.recordCheck")}</button> : null}
      {item?.status.validation === "invalid" ? <p role="alert">{t("translationPlugin.invalid")}</p> : null}
      {canProject && !projection && attempt ? <button className="primary-button" disabled={locked || preparationBlocked} onClick={() => void perform(async current => { await submit({ kind: "prepare-projection", request: { ...context, translationAttemptId: attempt, translationResultId: item!.resultId!, attemptId: await executionCommands.identity(context) } }, current); })}>{t("translationPlugin.preparePreview")}</button> : null}
      {projection && !projected ? <><p>{t("translationPlugin.checked", { target: projection.targetLocale })}</p><button className="primary-button" disabled={locked} onClick={() => void perform(async current => { await submit({ kind: "start-projection", request: { ...context, attemptId: projection.attemptId, inputDigest: projection.inputDigest } }, current); })}>{t("translationPlugin.openPreview")}</button></> : null}
      {pending ? <div role="status"><p>{t("translationPlugin.unknown")}</p><button className="secondary-button" disabled={disabled || busy} onClick={() => void perform(current => submit(pending, current))}>{t("translationPlugin.retryOriginal")}</button></div> : null}
      {[producer.data, check.data, projectionRead.data].map(detail => detail && detail.items.some(row => row.status.execution === "queued" || row.status.execution === "dispatched") ? <button className="secondary-button" key={detail.attemptId} disabled={locked} onClick={() => void perform(current => cancel(detail, current))}>{t("execution.cancel")}</button> : null)}
      {selection ? <button className="text-button" disabled={locked || working} onClick={reset}>{t("translationPlugin.newInput")}</button> : null}
    </section>
    <Dialog.Root open={leave} onOpenChange={value => { if (!value) answerLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onCloseAutoFocus={event => { event.preventDefault(); if (leaveTrigger.current?.isConnected && !leaveTrigger.current.closest("[hidden]")) leaveTrigger.current.focus(); }}><Dialog.Title>{t("translationPlugin.leaveTitle")}</Dialog.Title><Dialog.Description>{t("translationPlugin.leaveHelp")}</Dialog.Description><div className="form-actions"><button className="secondary-button" onClick={() => answerLeave(false)}>{t("translation.stay")}</button><button className="primary-button" onClick={() => { reset(); answerLeave(true); }}>{t("translation.discard")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
