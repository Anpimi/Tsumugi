import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { QueryKey } from "@tanstack/react-query";
import { PluginPermissions } from "./PluginPermissions";
import { approvedPluginEnvironments, matchingPluginEnvironments, pluginEnvironmentVersion } from "./pluginEnvironments";
import { pluginCommands, readEnabledPluginPackages, type PluginTranslationView } from "./pluginCommands";
import { translationCommands as commands, matchesTranslationEnvironment } from "./translationCommands";
import { executionContext } from "./executionCommands";
import { readCompleteAttempt } from "./executionRead";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { useTranslationImportSession } from "./TranslationImportSession";
import { useExecutionTaskSession, TaskCancellationFeedback } from "./ExecutionTaskSession";
import { useWorkbenchState } from "./WorkbenchFrame";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { useWorkbenchCommands, type CommandAvailability, type TranslationImportSetupCommandPayload, type TranslationImportConsentCommandPayload,
  type TranslationImportStartPendingCommandPayload, type TranslationPluginCommandPayload, type TranslationPluginPendingCommandPayload } from "./workbenchCommands";
import type { ProjectView } from "./projectCommands";

const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
const sameProfile = (left: PluginTranslationView["declaration"]["profile"], right: PluginTranslationView["declaration"]["profile"]) => left.id === right.id && left.schemaVersion === right.schemaVersion && left.behaviorVersion === right.behaviorVersion;
function ExecutionReview({ view, checker }: { view: PluginTranslationView; checker: boolean }) {
  const { t } = useTranslation(), capability = checker ? view.checker : view.extractor;
  return <section aria-label={t(checker ? "translationPlugin.checkReview" : "translationPlugin.producerReview")}>
    <p>{view.declaration.displayName} · {capability.provider.plugin.id} {capability.provider.plugin.version}</p>
    <p>{t(view.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeDetails" : "sourcePlugin.nativeRuntimeDetails", { version: pluginEnvironmentVersion(view.environment), system: view.environment.platform.operatingSystem, architecture: view.environment.platform.architecture })}</p>
    <PluginPermissions permissions={capability.declaration.permissions} /><p>{t("sourcePlugin.unsandboxed")}</p>
    <details><summary>{t("sourcePlugin.fixedDetails")}</summary><dl><dt>{t("sourcePlugin.packageDigest")}</dt><dd><code>{capability.provider.packageDigest}</code></dd>
      <dt>{t("sourcePlugin.runtimeDigest")}</dt><dd><code>{view.environmentDigest}</code></dd><dt>{t("translationPlugin.profile")}</dt><dd><code>{view.declaration.profile.id}</code> ({view.declaration.profile.schemaVersion}/{view.declaration.profile.behaviorVersion})</dd></dl></details>
  </section>;
}

/** Preparation and unknown requests remain in the stable import owner. */
export function PluginTranslationControls({ project, open, targetLocale, disabled, onOpenExtensions }: { project: ProjectView; open: boolean; targetLocale: string; disabled: boolean; onOpenExtensions?: () => void }) {
  const { t } = useTranslation(), owner = useTranslationImportSession(), tasks = useExecutionTaskSession(), reads = useSessionReads(), registry = useWorkbenchCommands();
  const context = executionContext(project), commandScope = { ...context, area: "translation" as const }, state = owner.state;
  const [choiceKey, setChoiceKey] = useWorkbenchState("translation", "import.pluginChoice", "");
  const [runtimeDigest, setRuntimeDigest] = useWorkbenchState("translation", "import.pluginRuntime", "");
  const [scopeIndex, setScopeIndex] = useWorkbenchState("translation", "import.nativeScope", "0");
  const [refresh, setRefresh] = useWorkbenchState("translation", "import.pluginRefresh", 0);
  const alive = useRef(false), committed = useRef({ project, open, targetLocale, disabled });
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => { committed.current = { project, open, targetLocale, disabled }; });
  const inventoryKey = ["translation-plugin-inventory", refresh];
  const inventory = useSessionQuery({ key: inventoryKey, scopes: [], enabled: open && !disabled, read: async () => {
    const value = await pluginCommands.inventory(), packages = await readEnabledPluginPackages(value);
    return { choices: packages.flatMap(item => item.manifest.contributions.flatMap(contribution => contribution.contribution.kind === "resource"
      && contribution.contribution.schema.id === "tsumugi.translation-import-declaration" && contribution.contribution.schema.schemaVersion === 1 && contribution.contribution.schema.behaviorVersion === 1
      ? [{ key: `${item.packageDigest}:${contribution.id}`, label: `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${contribution.id}`,
        package: { plugin: item.manifest.plugin, packageDigest: item.packageDigest }, resourceId: contribution.id, runtimeKinds: item.manifest.components.map(component => component.runtime) }] : [])),
      runtimes: approvedPluginEnvironments(value) };
  } });
  const choices = inventory.data?.choices ?? [], environments = inventory.data?.runtimes ?? [];
  const effectiveChoice = state.translation ? `${state.translation.package.packageDigest}:${state.translation.resourceId}` : choiceKey;
  const choice = choices.find(value => value.key === effectiveChoice), runtimes = matchingPluginEnvironments(environments, choice?.runtimeKinds ?? []);
  const effectiveRuntime = state.translation?.environmentDigest ?? runtimeDigest, translation = state.translation;
  const sourceKey = ["translation-plugin-source", targetLocale];
  const source = useSessionQuery({ key: sourceKey, scopes: ["source"], enabled: open && !!targetLocale,
    read: () => commands.pluginSource({ ...context, targetLocale }) });
  const environmentKey = ["translation-plugin-environment", translation, refresh];
  const environment = useSessionQuery({ key: environmentKey, scopes: [],
    enabled: open && !disabled && !!translation && !!inventory.data && !inventory.isFetching && !inventory.error,
    read: async () => { if (!translation) throw new Error("Translation import requires an explicit package and runtime");
      const view = await pluginCommands.translation(translation); if (!matchesTranslationEnvironment(view, translation)) throw new Error("Translation environment identity changed"); return view; } });
  const nativeScope = source.data?.nativeScopes[Number(scopeIndex)];
  const environmentChanged = !!state.preflight && !!environment.data && JSON.stringify(state.preflight.translation) !== JSON.stringify(environment.data);
  useLayoutEffect(() => {
    if (environmentChanged) { owner.consentProducer(false); owner.consentChecker(false); }
  }, [environmentChanged]);
  const files = useSessionQuery({ key: ["translation-files", state.folder?.selectionId], scopes: ["source"], enabled: open && !!state.folder,
    read: () => state.folder ? commands.pluginFiles({ ...context, selectionId: state.folder.selectionId }) : Promise.resolve([]) });
  const producerKey = ["translation-plugin-producer", state.extractionAttempt];
  const producer = useSessionQuery({ key: producerKey, scopes: ["execution"], enabled: open && !!state.extractionAttempt,
    read: () => state.extractionAttempt ? readCompleteAttempt(context, state.extractionAttempt, "translation-extract") : Promise.resolve(null) });
  const checkKey = ["translation-plugin-checker", state.checkAttempt];
  const check = useSessionQuery({ key: checkKey, scopes: ["execution"], enabled: open && !!state.checkAttempt,
    read: () => state.checkAttempt ? readCompleteAttempt(context, state.checkAttempt, "translation-semantic-check") : Promise.resolve(null) });
  const projectionKey = ["translation-plugin-projection", state.attempt];
  const projection = useSessionQuery({ key: projectionKey, scopes: ["execution"], enabled: open && !!state.attempt,
    read: () => state.attempt ? readCompleteAttempt(context, state.attempt, "translation-import") : Promise.resolve(null) });
  const item = producer.data?.items.length === 1 ? producer.data.items[0] : null, checkedItem = check.data?.items.length === 1 ? check.data.items[0] : null;
  function active(id: string | null, detail: typeof producer.data) { return !!id && (!detail || detail.items.some(row => row.status.execution === "queued" || row.status.execution === "dispatched")); }
  const working = active(state.extractionAttempt, producer.data) || active(state.checkAttempt, check.data) || active(state.attempt, projection.data);
  const locked = disabled || state.busy || owner.hasPending(), draftLocked = locked || !!state.preflight || !!state.extractionAttempt;
  const failure = inventory.error ?? source.error ?? environment.error ?? files.error ?? producer.error ?? check.error ?? projection.error;
  function ready(key: QueryKey) { const record = reads.client.getQueryState(reads.key(key)); return record?.status === "success" && record.error === null && record.fetchStatus === "idle" && !record.isInvalidated; }
  function live(recovery = false) { const value = committed.current; return alive.current && !reads.retired && value.open && !value.disabled
    && value.project.sessionToken === context.sessionToken && value.project.metadata.projectId === context.projectId
    && (recovery || value.targetLocale === owner.current().targetLocale && value.project.metadata.targetLocales.includes(value.targetLocale)); }
  function common(recovery = false): CommandAvailability {
    if (!live(recovery)) return { enabled: false, reason: "hidden" };
    if (owner.current().busy) return { enabled: false, reason: "busy" };
    return !recovery && owner.hasPending() ? { enabled: false, reason: "pending-action" } : { enabled: true };
  }
  function preparationReady() { return ready(inventoryKey) && ready(sourceKey) && ready(environmentKey) && !!nativeScope && !!environment.data && !!source.data
    && sameProfile(environment.data.declaration.profile, source.data.profile) && runtimes.some(value => value.environmentDigest === effectiveRuntime)
    && (!state.folder || state.folder.source.sourceSnapshotId === source.data.sourceSnapshotId)
    && (!state.preflight || JSON.stringify(state.preflight.translation) === JSON.stringify(environment.data)); }
  function selected(key: string, digest: string) {
    if (draftLocked) return;
    setChoiceKey(key); setRuntimeDigest(digest);
    const selected = choices.find(value => value.key === key);
    owner.setTranslation(selected && digest ? { package: selected.package, resourceId: selected.resourceId, environmentDigest: digest } : null);
  }
  function setupPayload(): TranslationImportSetupCommandPayload { return { kind: "translation-import-setup", editSeq: state.editSeq, locale: state.targetLocale, selectionId: state.folder?.selectionId ?? null, fileName: state.fileName }; }
  function setupAvailability(input?: TranslationImportSetupCommandPayload, capture = false): CommandAvailability {
    const allowed = common(); return allowed.enabled && input && JSON.stringify(input) === JSON.stringify(setupPayload()) && preparationReady()
      && (!capture || !!state.folder && !!state.fileName && state.confirmed && ready(["translation-files", state.folder.selectionId]) && files.data?.includes(state.fileName)) ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function consentPayload(confirmed = state.confirmed): TranslationImportConsentCommandPayload | null {
    return state.folder ? { ...setupPayload(), kind: "translation-import-consent", sourceSnapshotId: state.preflight?.source.sourceSnapshotId ?? state.folder.source.sourceSnapshotId,
      fileDigest: state.preflight?.file.sha256 ?? null, inputDigest: state.preflight?.inputDigest ?? null,
      producerConsent: !!state.preflight && state.producerConsent === state.preflight.inputDigest, confirmed } : null;
  }
  function consentAvailability(input?: TranslationImportConsentCommandPayload, start = false): CommandAvailability {
    const allowed = common(), expected = consentPayload(input?.confirmed);
    return allowed.enabled && input && expected && JSON.stringify(input) === JSON.stringify(expected) && preparationReady() && !!state.fileName
      && (!start || !!state.preflight && input.confirmed && input.producerConsent && !state.extractionAttempt) ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function pluginPayload(): TranslationPluginCommandPayload { return { kind: "translation-plugin", editSeq: state.editSeq, extractionAttemptId: state.extractionAttempt ?? "",
    extractionResultId: item?.resultId ?? null, checkAttemptId: state.checkReview?.attemptId ?? null, checkInputDigest: state.checkReview?.inputDigest ?? null,
    checkResultId: checkedItem?.resultId ?? null, projectionAttemptId: state.projection?.attemptId ?? null, projectionInputDigest: state.projection?.inputDigest ?? null,
    checkerConsent: !!state.checkReview && state.checkerConsent === state.checkReview.inputDigest }; }
  function pluginAvailability(input?: TranslationPluginCommandPayload, phase: "prepare-check" | "start-check" | "finish-check" | "prepare-projection" | "start-projection" = "prepare-check"): CommandAvailability {
    const allowed = common(); if (!allowed.enabled) return allowed;
    if (!input || JSON.stringify(input) !== JSON.stringify(pluginPayload()) || !state.extractionAttempt || producer.data?.attemptId !== state.extractionAttempt) return unavailable;
    if (phase === "finish-check") return ready(checkKey) && checkedItem?.status.execution === "succeeded" && !checkedItem.status.cancellationRequested && !!checkedItem.resultId ? allowed : unavailable;
    if (phase === "start-projection") return state.projection && !state.attempt ? allowed : unavailable;
    if (!preparationReady() || !ready(producerKey) || !item?.resultId || item.status.execution !== "succeeded" || item.status.cancellationRequested) return unavailable;
    if (phase === "start-check") return !!state.checkReview && !state.checkAttempt && state.checkerConsent === state.checkReview.inputDigest ? allowed : unavailable;
    if (phase === "prepare-projection") return item.status.validation === "valid" && !state.projection ? allowed : unavailable;
    return item.status.validation !== "valid" && !active(state.checkAttempt, check.data)
      && (!state.checkReview || checkedItem && (checkedItem.status.cancellationRequested || ["failed", "unknown", "cancelled-before-dispatch"].includes(checkedItem.status.execution))) ? allowed : unavailable;
  }
  function pendingPayload(): TranslationPluginPendingCommandPayload | null { return state.pendingPlugin ? { kind: "translation-plugin-pending", ...state.pendingPlugin } : null; }
  function startPendingAvailability(input?: TranslationImportStartPendingCommandPayload, retry = false): CommandAvailability {
    const allowed = common(true);
    return allowed.enabled && !!owner.current().pendingStart && input && JSON.stringify(input.request) === JSON.stringify(owner.current().pendingStart)
      && (!retry || owner.current().startRetryAllowed) ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function pluginPendingAvailability(input?: TranslationPluginPendingCommandPayload, retry = false): CommandAvailability {
    const allowed = common(true), expected = pendingPayload();
    return allowed.enabled && input && expected && JSON.stringify(input) === JSON.stringify(expected)
      && (!retry || !["start-check", "start-projection"].includes(input.pendingKind) || owner.current().startRetryAllowed) ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function proof() {
    const capturedSource = source.data, capturedEnvironment = environment.data, capturedTranslation = state.translation;
    const sourceWitness = reads.watchExactQuery(sourceKey), environmentWitness = reads.watchExactQuery(environmentKey);
    return { current: () => !reads.retired && reads.context.sessionToken === context.sessionToken && reads.context.projectId === context.projectId && JSON.stringify(owner.current().translation) === JSON.stringify(capturedTranslation)
      && [sourceWitness.current(), environmentWitness.current()].every((record, index) => !record || record.state.status === "success" && record.state.error === null
        && JSON.stringify(record.state.data) === JSON.stringify(index === 0 ? capturedSource : capturedEnvironment)),
      dispose: () => { sourceWitness.dispose(); environmentWitness.dispose(); } };
  }
  useLayoutEffect(() => {
    const meta = { category: "translation" as const, scope: commandScope, binding: null, confirmation: "none" as const, risk: "captures-translation-import" as const };
    const removals = [
      registry.register({ ...meta, id: "translation.choose-import-folder", nameKey: "translation.chooseFolder", payloadKind: "translation-import-setup", availability: input => setupAvailability(input), handler: () => {
        if (!translation || !source.data || !nativeScope) return; const captured = proof();
        void owner.chooseFolder({ translation, source: source.data, nativeScope }, captured.current).finally(captured.dispose);
      } }),
      registry.register({ ...meta, id: "translation.inspect-import", nameKey: "translation.inspect", payloadKind: "translation-import-setup", availability: input => setupAvailability(input, true), handler: () => { const captured = proof(); void owner.preflight(captured.current, captured.dispose); } }),
      registry.register({ ...meta, id: "translation.confirm-import-language", nameKey: "translation.languageConfirm", payloadKind: "translation-import-consent", availability: input => consentAvailability(input), handler: input => owner.confirmLanguage(input.confirmed) }),
      registry.register({ ...meta, id: "translation.start-import", nameKey: "translation.start", payloadKind: "translation-import-consent", availability: input => consentAvailability(input, true), handler: () => { const captured = proof(); void owner.start(captured.current, captured.dispose); } }),
      registry.register({ ...meta, id: "translation.check-import-start", nameKey: "execution.checkPluginStart", risk: "reads-execution", payloadKind: "translation-import-start-pending", availability: input => startPendingAvailability(input), handler: () => void owner.checkStart() }),
      registry.register({ ...meta, id: "translation.retry-import-start", nameKey: "execution.retryPluginStart", payloadKind: "translation-import-start-pending", availability: input => startPendingAvailability(input, true), handler: () => void owner.retryStart() }),
      registry.register({ ...meta, id: "translation.prepare-import-check", nameKey: "translationPlugin.prepareCheck", payloadKind: "translation-plugin", availability: input => pluginAvailability(input), handler: input => { if (!input.extractionResultId) return; const captured = proof(); void owner.prepareCheck(input.extractionResultId, captured.current).finally(captured.dispose); } }),
      registry.register({ ...meta, id: "translation.start-import-check", nameKey: "translationPlugin.startCheck", payloadKind: "translation-plugin", availability: input => pluginAvailability(input, "start-check"), handler: () => { const captured = proof(); void owner.startCheck(captured.current).finally(captured.dispose); } }),
      registry.register({ ...meta, id: "translation.finish-import-check", nameKey: "translationPlugin.recordCheck", payloadKind: "translation-plugin", availability: input => pluginAvailability(input, "finish-check"), handler: input => { if (input.checkResultId) void owner.finishCheck(input.checkResultId); } }),
      registry.register({ ...meta, id: "translation.prepare-import-projection", nameKey: "translationPlugin.preparePreview", payloadKind: "translation-plugin", availability: input => pluginAvailability(input, "prepare-projection"), handler: input => { if (!input.extractionResultId) return; const captured = proof(); void owner.prepareProjection(input.extractionResultId, captured.current).finally(captured.dispose); } }),
      registry.register({ ...meta, id: "translation.start-import-projection", nameKey: "translationPlugin.openPreview", payloadKind: "translation-plugin", availability: input => pluginAvailability(input, "start-projection"), handler: () => void owner.startProjection() }),
      registry.register({ ...meta, id: "translation.check-import-plugin-start", nameKey: "execution.checkPluginStart", risk: "reads-execution", payloadKind: "translation-plugin-pending", availability: input => input?.pendingKind === "start-check" ? pluginPendingAvailability(input) : unavailable, handler: () => void owner.checkPluginStart() }),
      registry.register({ ...meta, id: "translation.check-import-projection-start", nameKey: "execution.checkPluginStart", risk: "reads-execution", payloadKind: "translation-plugin-pending", availability: input => input?.pendingKind === "start-projection" ? pluginPendingAvailability(input) : unavailable, handler: () => void owner.checkProjectionStart() }),
      registry.register({ ...meta, id: "translation.retry-import-plugin", nameKey: "translationPlugin.retryOriginal", payloadKind: "translation-plugin-pending", availability: input => pluginPendingAvailability(input, true), handler: () => void owner.retryPlugin() }),
    ];
    return () => removals.forEach(remove => remove());
  });
  const command = pluginPayload(), consent = consentPayload(), pending = pendingPayload();
  const startPending: TranslationImportStartPendingCommandPayload | null = state.pendingStart ? { kind: "translation-import-start-pending", request: state.pendingStart } : null;
  return <section aria-label={t("translationPlugin.controls")} aria-busy={state.busy || inventory.isFetching || environment.isFetching}>
    <h3>{t("translationPlugin.controls")}</h3>
    {failure ? <div role="alert"><p>{t("translationPlugin.failed")}</p><CommandFailureDetails failure={commandFailure(failure)} /></div> : null}
    {inventory.isFetching || environment.isFetching || state.busy || working ? <p role="status">{t("execution.working")}</p> : null}
    <label className="source-field">{t("translationPlugin.package")}<select value={effectiveChoice} disabled={draftLocked} onChange={event => selected(event.target.value, "")}><option value="">{t("translationPlugin.choosePackage")}</option>{choices.map(value => <option key={value.key} value={value.key}>{value.label}</option>)}</select></label>
    <label className="source-field">{t("sourcePlugin.runtime")}<select value={effectiveRuntime} disabled={draftLocked || !choice} onChange={event => selected(effectiveChoice, event.target.value)}><option value="">{t("sourcePlugin.chooseRuntime")}</option>{runtimes.map(value => <option key={value.environmentDigest} value={value.environmentDigest}>{t(value.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption", { version: pluginEnvironmentVersion(value.environment), system: value.environment.platform.operatingSystem, architecture: value.environment.platform.architecture })}</option>)}</select></label>
    <button className="secondary-button" disabled={locked} onClick={() => { setRefresh(value => value + 1); reads.invalidate(["execution", "source"]); }}>{t("translationPlugin.refresh")}</button>
    {environmentChanged ? <p role="alert">{t("translationPlugin.environmentChanged")}</p> : null}
    {!preparationReady() && !inventory.isFetching && !environment.isFetching ? <p role="status">{t("translationPlugin.unavailable")}</p> : null}
    {onOpenExtensions ? <button className="text-button" disabled={state.busy} onClick={onOpenExtensions}>{t("plugins.open")}</button> : null}
    {(source.data?.nativeScopes.length ?? 0) > 1 ? <label className="source-field">{t("translationPlugin.scope")}<select value={scopeIndex} disabled={draftLocked} onChange={event => { if (owner.resetPlugin()) setScopeIndex(event.target.value); }}>{source.data?.nativeScopes.map((value,index) => <option key={`${value.namespace}:${value.policy.id}`} value={String(index)}>{value.namespace} · {value.policy.id}</option>)}</select></label> : null}
    {!state.preflight && !state.extractionAttempt ? <>
      {environment.data ? <p>{t("translationPlugin.material", { directory: environment.data.declaration.material.logicalDirectory, extension: environment.data.declaration.material.extension, bytes: String(environment.data.declaration.material.maxBytes) })}</p> : null}
      <button className="secondary-button" disabled={!setupAvailability(setupPayload()).enabled} onClick={() => registry.dispatch("translation.choose-import-folder", commandScope, setupPayload())}>{t("translation.chooseFolder")}</button>
      {state.folder ? <><p>{t("translation.folder", { name: state.folder.folderName })}</p>
        {files.data?.length ? <label className="source-field">{t("translation.file")}<select value={state.fileName} disabled={draftLocked} onChange={event => owner.setFile(event.target.value)}><option value="">{t("translation.file")}</option>{files.data.map(file => <option key={file} value={file}>{file}</option>)}</select></label>
          : files.isPending || files.isFetching ? <p role="status">{t("execution.loading")}</p>
          : files.isSuccess ? <p role="status">{t("translation.noFiles")}</p> : null}
        {consent ? <label className="source-check"><input type="checkbox" checked={state.confirmed} disabled={!consentAvailability(consent).enabled} onChange={event => registry.dispatch("translation.confirm-import-language", commandScope, { ...consent, confirmed: event.target.checked })} />{t("translationPlugin.languageConfirm", { file: state.fileName, target: state.folder.targetLocale })}</label> : null}
        <button className="primary-button" disabled={!setupAvailability(setupPayload(), true).enabled} onClick={() => registry.dispatch("translation.inspect-import", commandScope, setupPayload())}>{t("translationPlugin.capture")}</button>
      </> : null}
    </> : null}
    {state.preflight ? <><p>{t("translationPlugin.captured", { file: state.preflight.file.logicalPath, bytes: String(state.preflight.file.byteLength), target: state.preflight.targetLocale })}</p>
      {!state.extractionAttempt ? <><ExecutionReview view={state.preflight.translation} checker={false} /><label className="source-check"><input type="checkbox" checked={state.producerConsent === state.preflight.inputDigest} disabled={locked} onChange={event => owner.consentProducer(event.target.checked)} />{t("translationPlugin.producerConsent")}</label><button className="primary-button" disabled={!consent || !consentAvailability(consent, true).enabled} onClick={() => { if (consent) registry.dispatch("translation.start-import", commandScope, consent); }}>{t("translation.start")}</button></> : null}
    </> : null}
    {item ? <p role="status">{t(`execution.states.${item.status.execution}`)} · {t(`releasePlugin.validation.${item.status.validation}`)}</p> : null}
    {item?.status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary>{item.status.diagnostic}</details> : null}
    {state.extractionAttempt && item?.status.validation !== "valid" ? <button className="secondary-button" disabled={!pluginAvailability(command).enabled} onClick={() => registry.dispatch("translation.prepare-import-check", commandScope, command)}>{t("translationPlugin.prepareCheck")}</button> : null}
    {state.checkReview && !state.checkAttempt ? <><ExecutionReview view={state.checkReview.translation} checker /><p>{t("translationPlugin.rules", { count: state.checkReview.rules.length })}</p><label className="source-check"><input type="checkbox" checked={state.checkerConsent === state.checkReview.inputDigest} disabled={locked} onChange={event => owner.consentChecker(event.target.checked)} />{t("translationPlugin.checkerConsent")}</label><button className="primary-button" disabled={!pluginAvailability(command, "start-check").enabled} onClick={() => registry.dispatch("translation.start-import-check", commandScope, command)}>{t("translationPlugin.startCheck")}</button></> : null}
    {checkedItem ? <p role="status">{t(`execution.states.${checkedItem.status.execution}`)}</p> : null}
    {checkedItem?.status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary>{checkedItem.status.diagnostic}</details> : null}
    {checkedItem?.status.execution === "succeeded" ? <button className="primary-button" disabled={!pluginAvailability(command, "finish-check").enabled} onClick={() => registry.dispatch("translation.finish-import-check", commandScope, command)}>{t("translationPlugin.recordCheck")}</button> : null}
    {item?.status.validation === "invalid" ? <p role="alert">{t("translationPlugin.invalid")}</p> : null}
    {item?.status.validation === "valid" && !state.projection ? <button className="primary-button" disabled={!pluginAvailability(command, "prepare-projection").enabled} onClick={() => registry.dispatch("translation.prepare-import-projection", commandScope, command)}>{t("translationPlugin.preparePreview")}</button> : null}
    {state.projection && !state.attempt ? <><p>{t("translationPlugin.checked", { target: state.projection.targetLocale })}</p><button className="primary-button" disabled={!pluginAvailability(command, "start-projection").enabled} onClick={() => registry.dispatch("translation.start-import-projection", commandScope, command)}>{t("translationPlugin.openPreview")}</button></> : null}
    {pending ? <div role="status"><p>{t(state.checkingStart ? "execution.checkingPluginStart" : "translationPlugin.unknown")}</p>
      {pending.pendingKind === "start-check" || pending.pendingKind === "start-projection" ? <><button className="secondary-button" disabled={!pluginPendingAvailability(pending).enabled} onClick={() => registry.dispatch(pending.pendingKind === "start-projection" ? "translation.check-import-projection-start" : "translation.check-import-plugin-start", commandScope, pending)}>{t("execution.checkPluginStart")}</button>
        {state.startRetryAllowed ? <><p>{t(pending.pendingKind === "start-projection" ? "translationPlugin.projectionStartMissing" : "execution.pluginStartMissing")}</p><button className="secondary-button" disabled={!pluginPendingAvailability(pending, true).enabled} onClick={() => registry.dispatch("translation.retry-import-plugin", commandScope, pending)}>{t("execution.retryPluginStart")}</button></> : null}</>
        : <button className="secondary-button" disabled={!pluginPendingAvailability(pending, true).enabled} onClick={() => registry.dispatch("translation.retry-import-plugin", commandScope, pending)}>{t("translationPlugin.retryOriginal")}</button>}
    </div> : null}
    {startPending ? <div role="status"><p>{t(state.checkingStart ? "execution.checkingPluginStart" : "translation.startUnknown")}</p>
      <button className="secondary-button" disabled={!startPendingAvailability(startPending).enabled} onClick={() => registry.dispatch("translation.check-import-start", commandScope, startPending)}>{t("execution.checkPluginStart")}</button>
      {state.startRetryAllowed ? <><p>{t("execution.pluginStartMissing")}</p><button className="secondary-button" disabled={!startPendingAvailability(startPending, true).enabled} onClick={() => registry.dispatch("translation.retry-import-start", commandScope, startPending)}>{t("execution.retryPluginStart")}</button></> : null}
    </div> : null}
    {[producer.data, check.data, projection.data].map(detail => detail && detail.items.some(row => row.status.execution === "queued" || row.status.execution === "dispatched") ? <div key={detail.attemptId}><button className="secondary-button" disabled={locked || !tasks.canCancel({ taskId: detail.taskId, attemptId: detail.attemptId, origin: "tasks" })} onClick={() => void owner.cancelTask(detail)}>{t("execution.cancel")}</button><TaskCancellationFeedback origin="tasks" taskId={detail.taskId} disabled={locked} visible={open} /></div> : null)}
    {state.folder ? <button className="text-button" disabled={locked || working} onClick={() => owner.resetPlugin()}>{t("translationPlugin.newInput")}</button> : null}
  </section>;
}
