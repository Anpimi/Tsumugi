import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { QueryKey } from "@tanstack/react-query";
import { Button } from "../../../design-system/Button";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { Field } from "../../../design-system/Field";
import { Menu } from "../../../design-system/Menu";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { PluginPermissions } from "../../../PluginPermissions";
import { commandFailure, type CommandFailure } from "../../../CommandFailure";
import { approvedPluginEnvironments, matchingPluginEnvironments, pluginEnvironmentVersion } from "../../../pluginEnvironments";
import { pluginCommands, readEnabledPluginPackages, type PluginTranslationView } from "../../../pluginCommands";
import { translationCommands, matchesTranslationEnvironment } from "../../../translationCommands";
import { executionContext, type AttemptDetail } from "../../../executionCommands";
import { readCompleteAttempt } from "../../../executionRead";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import type { useTranslationImportSession } from "../../../TranslationImportSession";
import type { useExecutionTaskSession } from "../../../ExecutionTaskSession";
import type { ProjectView } from "../../../projectCommands";
import type { WorkbenchCommands, CommandAvailability, TranslationImportSetupCommandPayload, TranslationImportConsentCommandPayload,
  TranslationImportStartPendingCommandPayload, TranslationPluginCommandPayload, TranslationPluginPendingCommandPayload,
  ExecutionCancellationCommandPayload, ExecutionCancellationRetryCommandPayload } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import styles from "./ImportPreparation.module.css";

export interface ImportPreparationProps {
  project: ProjectView;
  owner: ReturnType<typeof useTranslationImportSession>;
  tasks: ReturnType<typeof useExecutionTaskSession>;
  commands: WorkbenchCommands;
  gate: InteractionGate;
  viewId: string | null;
  disabled: boolean;
  visible: boolean;
}

const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const sameProfile = (left: PluginTranslationView["declaration"]["profile"], right: PluginTranslationView["declaration"]["profile"]) =>
  left.id === right.id && left.schemaVersion === right.schemaVersion && left.behaviorVersion === right.behaviorVersion;
const running = (detail: AttemptDetail | null | undefined) => !!detail?.items.some(row => row.status.execution === "queued" || row.status.execution === "dispatched");

function ExecutionReview({ view, checker }: { view: PluginTranslationView; checker: boolean }) {
  const { t } = useTranslation();
  const [details, setDetails] = useState(false), detailsId = useId();
  const capability = checker ? view.checker : view.extractor;
  return <section className={styles.review} aria-label={t(checker ? "translationPlugin.checkReview" : "translationPlugin.producerReview")}>
    <h4>{t(checker ? "translationPlugin.checkReview" : "translationPlugin.producerReview")}</h4>
    <p>{view.declaration.displayName} · {capability.provider.plugin.id} {capability.provider.plugin.version}</p>
    <p>{t(view.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeDetails" : "sourcePlugin.nativeRuntimeDetails", {
      version: pluginEnvironmentVersion(view.environment), system: view.environment.platform.operatingSystem, architecture: view.environment.platform.architecture })}</p>
    <PluginPermissions permissions={capability.declaration.permissions} />
    <Banner tone="warning">{t("sourcePlugin.unsandboxed")}</Banner>
    <Button size="sm" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(value => !value)}>
      {t(details ? "workbenchV2.importPreparationHideDetails" : "workbenchV2.importPreparationReviewDetails")}
    </Button>
    {details ? <dl id={detailsId} className={styles.diagnostics}>
      <dt>{t("sourcePlugin.packageDigest")}</dt><dd><code>{capability.provider.packageDigest}</code></dd>
      <dt>{t("sourcePlugin.runtimeDigest")}</dt><dd><code>{view.environmentDigest}</code></dd>
      <dt>{t("translationPlugin.profile")}</dt><dd><code>{view.declaration.profile.id}</code> ({view.declaration.profile.schemaVersion}/{view.declaration.profile.behaviorVersion})</dd>
    </dl> : null}
  </section>;
}

function FailureDetails({ failure }: { failure: CommandFailure }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), id = useId();
  return <>
    {typeof failure !== "string" && failure.recoveryGuidance ? <p>{t(`commandError.recovery.${failure.recoveryGuidance}`)}</p> : null}
    <Button size="sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{t("workbenchV2.importPreparationDiagnostics")}</Button>
    {open ? <div id={id} className={styles.diagnostics}>
      <TokenizedText text={typeof failure === "string" ? failure : t("commandError.classification", { code: failure.code, stage: failure.stage, outcome: failure.outcome })} />
      {typeof failure !== "string" && failure.diagnosticId ? <p>{t("commandError.diagnosticId")} <code>{failure.diagnosticId}</code></p> : null}
      {typeof failure !== "string" && (failure.reason || failure.field) ? <p><TokenizedText text={failure.reason ?? failure.field ?? ""} /></p> : null}
    </div> : null}
  </>;
}

/** Preparation borrows the stable import and task owners; hiding this view never cancels their work. */
export default function ImportPreparation({ project, owner, tasks, commands, gate, viewId, disabled, visible }: ImportPreparationProps) {
  const { t } = useTranslation(), reads = useSessionReads(), state = owner.state;
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const [choiceKey, setChoiceKey] = useState(""), [runtimeDigest, setRuntimeDigest] = useState(""), [scopeIndex, setScopeIndex] = useState(0), [refresh, setRefresh] = useState(0);
  const mounted = useRef(false), committed = useRef({ project, disabled, visible, viewId });
  const inputOwner = `import-preparation-${useId()}`;
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; gate.releaseOwner(inputOwner); }; }, [gate, inputOwner]);
  useLayoutEffect(() => { committed.current = { project, disabled, visible, viewId }; });
  const context = executionContext(project), commandScope = { ...context, area: "translation" as const };
  const targetLocale = state.targetLocale, translation = state.translation;
  const inventoryKey = ["translation-plugin-inventory", refresh];
  const inventory = useSessionQuery({ key: inventoryKey, scopes: [], enabled: visible && !disabled && !reads.retired, read: async () => {
    const value = await pluginCommands.inventory(), packages = await readEnabledPluginPackages(value);
    return { choices: packages.flatMap(item => item.manifest.contributions.flatMap(contribution => contribution.contribution.kind === "resource"
      && contribution.contribution.schema.id === "tsumugi.translation-import-declaration" && contribution.contribution.schema.schemaVersion === 1 && contribution.contribution.schema.behaviorVersion === 1
      ? [{ key: `${item.packageDigest}:${contribution.id}`, label: `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${contribution.id}`,
        package: { plugin: item.manifest.plugin, packageDigest: item.packageDigest }, resourceId: contribution.id, runtimeKinds: item.manifest.components.map(component => component.runtime) }] : [])),
      runtimes: approvedPluginEnvironments(value) };
  } });
  const choices = inventory.data?.choices ?? [], environments = inventory.data?.runtimes ?? [];
  const effectiveChoice = translation ? `${translation.package.packageDigest}:${translation.resourceId}` : choiceKey;
  const choice = choices.find(value => value.key === effectiveChoice), runtimes = matchingPluginEnvironments(environments, choice?.runtimeKinds ?? []);
  const effectiveRuntime = translation?.environmentDigest ?? runtimeDigest;
  const runtime = runtimes.find(value => value.environmentDigest === effectiveRuntime);
  const sourceKey = ["translation-plugin-source", targetLocale];
  const source = useSessionQuery({ key: sourceKey, scopes: ["source"], enabled: visible && !!targetLocale && !reads.retired,
    read: () => translationCommands.pluginSource({ ...context, targetLocale }) });
  const environmentKey = ["translation-plugin-environment", translation, refresh];
  const environment = useSessionQuery({ key: environmentKey, scopes: [], enabled: visible && !disabled && !!translation && !!inventory.data && !inventory.isFetching && !inventory.error && !reads.retired,
    read: async () => {
      if (!translation) throw new Error("Translation import requires a package and runtime");
      const value = await pluginCommands.translation(translation);
      if (!matchesTranslationEnvironment(value, translation)) throw new Error("Translation environment identity changed");
      return value;
    } });
  const filesKey = ["translation-files", state.folder?.selectionId];
  const files = useSessionQuery({ key: filesKey, scopes: ["source"], enabled: visible && !!state.folder && !reads.retired,
    read: () => state.folder ? translationCommands.pluginFiles({ ...context, selectionId: state.folder.selectionId }) : Promise.resolve([]) });
  // These are the same exact keys as the stable session's sidecar observers.
  const producerKey = ["translation-plugin-producer", state.extractionAttempt];
  const producer = useSessionQuery({ key: producerKey, scopes: ["execution"], enabled: !!state.extractionAttempt && !reads.retired, refetchOnMount: false,
    read: () => state.extractionAttempt ? readCompleteAttempt(context, state.extractionAttempt, "translation-extract") : Promise.resolve(null) });
  const checkerKey = ["translation-plugin-checker", state.checkAttempt];
  const checker = useSessionQuery({ key: checkerKey, scopes: ["execution"], enabled: !!state.checkAttempt && !reads.retired, refetchOnMount: false,
    read: () => state.checkAttempt ? readCompleteAttempt(context, state.checkAttempt, "translation-semantic-check") : Promise.resolve(null) });
  const projectionKey = ["translation-plugin-projection", state.attempt];
  const projection = useSessionQuery({ key: projectionKey, scopes: ["execution"], enabled: !!state.attempt && !reads.retired, refetchOnMount: false,
    read: () => state.attempt ? readCompleteAttempt(context, state.attempt, "translation-import") : Promise.resolve(null) });
  const item = producer.data?.items.length === 1 ? producer.data.items[0] : null;
  const checkedItem = checker.data?.items.length === 1 ? checker.data.items[0] : null;
  const nativeScope = source.data?.nativeScopes[scopeIndex];
  const environmentChanged = !!state.preflight && !!environment.data && !same(state.preflight.translation, environment.data);
  useLayoutEffect(() => {
    if (!environmentChanged) return;
    if (owner.current().producerConsent !== null) owner.consentProducer(false);
    if (owner.current().checkerConsent !== null) owner.consentChecker(false);
  }, [environmentChanged, owner]);

  function live() {
    const value = committed.current, current = owner.current();
    return mounted.current && !reads.retired && value.visible && !value.disabled
      && value.viewId === viewId && reads.context.sessionToken === context.sessionToken && reads.context.projectId === context.projectId
      && value.project.sessionToken === context.sessionToken && value.project.metadata.projectId === context.projectId
      && gate.canDispatch({ viewId: value.viewId, source: "button" })
      && current.targetLocale === targetLocale && value.project.metadata.targetLocales.includes(current.targetLocale);
  }
  function common(recovery = false): CommandAvailability {
    const current = owner.current();
    if (reads.retired || !visible || disabled || reads.context.sessionToken !== context.sessionToken || reads.context.projectId !== context.projectId
      || !gate.canDispatch({ viewId, source: "button" })) return { enabled: false, reason: "hidden" };
    if (!recovery && (current.targetLocale !== targetLocale || !project.metadata.targetLocales.includes(current.targetLocale))) return unavailable;
    if (current.busy) return { enabled: false, reason: "busy" };
    return !recovery && owner.hasPending() ? { enabled: false, reason: "pending-action" } : { enabled: true };
  }
  function ready(key: QueryKey, expected: unknown) {
    const record = reads.client.getQueryState(reads.key(key));
    return !!record && record.status === "success" && record.error === null && record.fetchStatus === "idle" && !record.isInvalidated && same(record.data, expected);
  }
  function preparationReady() {
    const current = owner.current();
    return ready(inventoryKey, inventory.data) && ready(sourceKey, source.data) && ready(environmentKey, environment.data)
      && !!nativeScope && !!environment.data && !!source.data && !!current.translation && same(current.translation, translation)
      && sameProfile(environment.data.declaration.profile, source.data.profile) && runtimes.some(value => value.environmentDigest === effectiveRuntime)
      && (!current.folder || same(current.folder.source, source.data) && same(current.folder.nativeScope, nativeScope) && matchesTranslationEnvironment(current.folder.translation, current.translation))
      && (!current.preflight || same(current.preflight.translation, environment.data));
  }
  function canEdit() { return common().enabled && !owner.current().preflight && !owner.current().extractionAttempt && !owner.hasActive(); }
  function selectPackage(key: string, digest: string) {
    if (!canEdit() || !ready(inventoryKey, inventory.data)) return;
    const selected = choices.find(value => value.key === key);
    if (!selected || digest && !matchingPluginEnvironments(environments, selected.runtimeKinds).some(value => value.environmentDigest === digest)) return;
    setChoiceKey(key); setRuntimeDigest(digest);
    owner.setTranslation(digest ? { package: selected.package, resourceId: selected.resourceId, environmentDigest: digest } : null);
  }
  function setupPayload(): TranslationImportSetupCommandPayload {
    const current = owner.current();
    return { kind: "translation-import-setup", editSeq: current.editSeq, locale: current.targetLocale, selectionId: current.folder?.selectionId ?? null, fileName: current.fileName };
  }
  function setupAvailability(input?: TranslationImportSetupCommandPayload, capture = false): CommandAvailability {
    const allowed = common(), current = owner.current();
    return allowed.enabled && input && same(input, setupPayload()) && !current.preflight && !current.extractionAttempt && !owner.hasActive() && preparationReady()
      && (!capture || !!current.folder && !!current.fileName && current.confirmed && ready(filesKey, files.data) && files.data?.includes(current.fileName)) ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function consentPayload(confirmed = owner.current().confirmed): TranslationImportConsentCommandPayload | null {
    const current = owner.current();
    return current.folder ? { ...setupPayload(), kind: "translation-import-consent", sourceSnapshotId: current.preflight?.source.sourceSnapshotId ?? current.folder.source.sourceSnapshotId,
      fileDigest: current.preflight?.file.sha256 ?? null, inputDigest: current.preflight?.inputDigest ?? null,
      producerConsent: !!current.preflight && current.producerConsent === current.preflight.inputDigest, confirmed } : null;
  }
  function consentAvailability(input?: TranslationImportConsentCommandPayload, start = false): CommandAvailability {
    const allowed = common(), current = owner.current(), expected = consentPayload(input?.confirmed);
    return allowed.enabled && input && expected && same(input, expected) && preparationReady() && !!current.fileName && !current.extractionAttempt
      && (start ? !!current.preflight && input.confirmed && input.producerConsent : !current.preflight && ready(filesKey, files.data) && files.data?.includes(current.fileName)) ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function pluginPayload(): TranslationPluginCommandPayload {
    const current = owner.current();
    return { kind: "translation-plugin", editSeq: current.editSeq, extractionAttemptId: current.extractionAttempt ?? "", extractionResultId: item?.resultId ?? null,
      checkAttemptId: current.checkReview?.attemptId ?? null, checkInputDigest: current.checkReview?.inputDigest ?? null, checkResultId: checkedItem?.resultId ?? null,
      projectionAttemptId: current.projection?.attemptId ?? null, projectionInputDigest: current.projection?.inputDigest ?? null,
      checkerConsent: !!current.checkReview && current.checkerConsent === current.checkReview.inputDigest };
  }
  function pluginAvailability(input?: TranslationPluginCommandPayload, phase: "prepare-check" | "start-check" | "finish-check" | "prepare-projection" | "start-projection" = "prepare-check"): CommandAvailability {
    const allowed = common(), current = owner.current();
    if (!allowed.enabled) return allowed;
    if (!input || !same(input, pluginPayload()) || !current.extractionAttempt || producer.data?.attemptId !== current.extractionAttempt) return unavailable;
    if (phase === "finish-check") return ready(checkerKey, checker.data) && checker.data?.attemptId === current.checkAttempt && current.checkReview?.attemptId === current.checkAttempt
      && checkedItem?.status.execution === "succeeded" && !checkedItem.status.cancellationRequested && !!checkedItem.resultId ? allowed : unavailable;
    if (phase === "start-projection") return current.projection && !current.attempt ? allowed : unavailable;
    if (!preparationReady() || !ready(producerKey, producer.data) || !item?.resultId || item.status.execution !== "succeeded" || item.status.cancellationRequested) return unavailable;
    if (phase === "start-check") return !!current.checkReview && !current.checkAttempt && current.checkerConsent === current.checkReview.inputDigest ? allowed : unavailable;
    if (phase === "prepare-projection") return item.status.validation === "valid" && !current.projection ? allowed : unavailable;
    return item.status.validation !== "valid" && !running(checker.data) && (!current.checkReview || checkedItem &&
      (checkedItem.status.cancellationRequested || ["failed", "unknown", "cancelled-before-dispatch"].includes(checkedItem.status.execution))) ? allowed : unavailable;
  }
  function startPendingAvailability(input?: TranslationImportStartPendingCommandPayload, retry = false): CommandAvailability {
    const allowed = common(true), current = owner.current();
    return allowed.enabled && current.pendingStart && input && same(input.request, current.pendingStart) && (!retry || current.startRetryAllowed) ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function pluginPendingAvailability(input?: TranslationPluginPendingCommandPayload, retry = false): CommandAvailability {
    const allowed = common(true), current = owner.current();
    return allowed.enabled && current.pendingPlugin && input && same(input, { kind: "translation-plugin-pending", ...current.pendingPlugin })
      && (!retry || !["start-check", "start-projection"].includes(input.pendingKind) || current.startRetryAllowed) ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function proof(extra: [QueryKey, unknown][] = []) {
    const capturedTranslation = owner.current().translation;
    const dependencies: [QueryKey, unknown][] = [[inventoryKey, inventory.data], [sourceKey, source.data], [environmentKey, environment.data], ...extra];
    const witnesses = dependencies.map(([queryKey, data]) => {
      const witness = reads.watchExactQuery(queryKey);
      return { queryKey, data, witness, original: witness.current() };
    });
    return { current: () => live() && same(owner.current().translation, capturedTranslation) && witnesses.every(({ queryKey, data, witness, original }) => {
      const record = witness.current();
      return !!record && record === original && reads.client.getQueryCache().find({ queryKey: reads.key(queryKey), exact: true }) === record
        && record.state.status === "success" && record.state.error === null && record.state.fetchStatus === "idle" && !record.state.isInvalidated && same(record.state.data, data);
    }), dispose: () => witnesses.forEach(({ witness }) => witness.dispose()) };
  }
  const attemptReads = [[producerKey, producer.data], [checkerKey, checker.data], [projectionKey, projection.data]] as const;
  function cancellationAvailability(input?: ExecutionCancellationCommandPayload): CommandAvailability {
    const allowed = common(), current = owner.current();
    if (!allowed.enabled) return allowed;
    const match = attemptReads.find(([, detail]) => detail?.attemptId === input?.attemptId && detail?.taskId === input?.taskId);
    return input && input.origin === "tasks" && [current.extractionAttempt, current.checkAttempt, current.attempt].includes(input.attemptId)
      && match && ready(match[0], match[1]) && running(match[1]) && tasks.canCancel(input) ? allowed : unavailable;
  }
  function cancellationRecovery(input?: ExecutionCancellationRetryCommandPayload, retry = false): CommandAvailability {
    const allowed = common(true), current = input ? tasks.current(input.taskId) : undefined;
    return allowed.enabled && input && current?.phase === "unknown" && current.request.requestId === input.requestId && same(current.target, { taskId: input.taskId, attemptId: input.attemptId, origin: input.origin })
      && [owner.current().extractionAttempt, owner.current().checkAttempt, owner.current().attempt].includes(input.attemptId) && (!retry || current.retryAllowed) ? allowed : allowed.enabled ? unavailable : allowed;
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const meta = { category: "translation" as const, scope: commandScope, binding: null, confirmation: "none" as const, risk: "captures-translation-import" as const };
    const removals = [
      commands.register({ ...meta, id: "translation.refresh-import", nameKey: "translationPlugin.refresh", risk: "reads-execution", availability: () => common(true), handler: () => { setRefresh(value => value + 1); reads.invalidate(["source", "execution"]); } }),
      commands.register({ ...meta, id: "translation.reset-import", nameKey: "translationPlugin.newInput", availability: () => common().enabled && !owner.hasActive() ? { enabled: true } : unavailable, handler: () => { owner.resetPlugin(); } }),
      commands.register({ ...meta, id: "translation.choose-import-folder", nameKey: "translation.chooseFolder", payloadKind: "translation-import-setup", availability: input => setupAvailability(input), handler: () => {
        if (!translation || !source.data || !nativeScope) return;
        const captured = proof(); void owner.chooseFolder({ translation, source: source.data, nativeScope }, captured.current).finally(captured.dispose);
      } }),
      commands.register({ ...meta, id: "translation.inspect-import", nameKey: "translation.inspect", payloadKind: "translation-import-setup", availability: input => setupAvailability(input, true), handler: () => {
        const captured = proof([[filesKey, files.data]]); void owner.preflight(captured.current, captured.dispose);
      } }),
      commands.register({ ...meta, id: "translation.confirm-import-language", nameKey: "translation.languageConfirm", payloadKind: "translation-import-consent", availability: input => consentAvailability(input), handler: input => owner.confirmLanguage(input.confirmed) }),
      commands.register({ ...meta, id: "translation.start-import", nameKey: "translation.start", payloadKind: "translation-import-consent", availability: input => consentAvailability(input, true), handler: () => {
        const captured = proof(); void owner.start(captured.current, captured.dispose);
      } }),
      commands.register({ ...meta, id: "translation.check-import-start", nameKey: "execution.checkPluginStart", risk: "reads-execution", payloadKind: "translation-import-start-pending", availability: input => startPendingAvailability(input), handler: () => void owner.checkStart() }),
      commands.register({ ...meta, id: "translation.retry-import-start", nameKey: "execution.retryPluginStart", payloadKind: "translation-import-start-pending", availability: input => startPendingAvailability(input, true), handler: () => void owner.retryStart() }),
      commands.register({ ...meta, id: "translation.prepare-import-check", nameKey: "translationPlugin.prepareCheck", payloadKind: "translation-plugin", availability: input => pluginAvailability(input), handler: input => {
        if (!input.extractionResultId) return;
        const captured = proof([[producerKey, producer.data]]); void owner.prepareCheck(input.extractionResultId, captured.current).finally(captured.dispose);
      } }),
      commands.register({ ...meta, id: "translation.start-import-check", nameKey: "translationPlugin.startCheck", payloadKind: "translation-plugin", availability: input => pluginAvailability(input, "start-check"), handler: () => {
        const captured = proof([[producerKey, producer.data]]); void owner.startCheck(captured.current).finally(captured.dispose);
      } }),
      commands.register({ ...meta, id: "translation.finish-import-check", nameKey: "translationPlugin.recordCheck", payloadKind: "translation-plugin", availability: input => pluginAvailability(input, "finish-check"), handler: input => { if (input.checkResultId) void owner.finishCheck(input.checkResultId); } }),
      commands.register({ ...meta, id: "translation.prepare-import-projection", nameKey: "translationPlugin.preparePreview", payloadKind: "translation-plugin", availability: input => pluginAvailability(input, "prepare-projection"), handler: input => {
        if (!input.extractionResultId) return;
        const captured = proof([[producerKey, producer.data]]); void owner.prepareProjection(input.extractionResultId, captured.current).finally(captured.dispose);
      } }),
      commands.register({ ...meta, id: "translation.start-import-projection", nameKey: "translationPlugin.openPreview", payloadKind: "translation-plugin", availability: input => pluginAvailability(input, "start-projection"), handler: () => void owner.startProjection() }),
      commands.register({ ...meta, id: "translation.check-import-plugin-start", nameKey: "execution.checkPluginStart", risk: "reads-execution", payloadKind: "translation-plugin-pending", availability: input => input?.pendingKind === "start-check" ? pluginPendingAvailability(input) : unavailable, handler: () => void owner.checkPluginStart() }),
      commands.register({ ...meta, id: "translation.check-import-projection-start", nameKey: "execution.checkPluginStart", risk: "reads-execution", payloadKind: "translation-plugin-pending", availability: input => input?.pendingKind === "start-projection" ? pluginPendingAvailability(input) : unavailable, handler: () => void owner.checkProjectionStart() }),
      commands.register({ ...meta, id: "translation.retry-import-plugin", nameKey: "translationPlugin.retryOriginal", payloadKind: "translation-plugin-pending", availability: input => pluginPendingAvailability(input, true), handler: () => void owner.retryPlugin() }),
      commands.register({ ...meta, id: "tasks.cancel-task", nameKey: "execution.cancel", risk: "cancels-execution-task", payloadKind: "execution-cancellation", availability: input => cancellationAvailability(input), handler: input => {
        const detail = attemptReads.find(([, value]) => value?.attemptId === input.attemptId && value.taskId === input.taskId)?.[1];
        if (detail) void owner.cancelTask(detail);
      } }),
      commands.register({ ...meta, id: "tasks.check-cancellation", nameKey: "execution.checkCancellation", risk: "reads-execution", payloadKind: "execution-cancellation-retry", availability: input => cancellationRecovery(input), handler: input => void tasks.checkCancellation(input.taskId) }),
      commands.register({ ...meta, id: "tasks.retry-cancellation", nameKey: "execution.retryCancellation", risk: "cancels-execution-task", payloadKind: "execution-cancellation-retry", availability: input => cancellationRecovery(input, true), handler: input => void tasks.retry(input.taskId) }),
    ];
    return () => removals.forEach(remove => remove());
  });

  const locked = !common().enabled, draftLocked = !canEdit();
  const setup = setupPayload(), consent = consentPayload(), command = pluginPayload();
  const startPending: TranslationImportStartPendingCommandPayload | null = state.pendingStart ? { kind: "translation-import-start-pending", request: state.pendingStart } : null;
  const pending: TranslationPluginPendingCommandPayload | null = state.pendingPlugin ? { kind: "translation-plugin-pending", ...state.pendingPlugin } : null;
  const readFailure = inventory.error ?? source.error ?? environment.error ?? files.error ?? producer.error ?? checker.error ?? projection.error;
  const failure = state.failure ?? (readFailure ? commandFailure(readFailure) : null);
  const working = owner.hasActive();
  const cancellations = Object.values(tasks.state).filter(value => [state.extractionAttempt, state.checkAttempt, state.attempt].includes(value.target.attemptId));
  if (!visible) return null;
  return <section className={styles.preparation} aria-label={t("workbenchV2.importPreparationTitle")} aria-busy={state.busy || inventory.isFetching || environment.isFetching}>
    <header className={styles.header}><h3>{t("workbenchV2.importPreparationTitle")}</h3><p>{t("workbenchV2.importPreparationHelp")}</p></header>
    {disabled ? <Banner tone="info">{t("workbenchV2.importPreparationReadOnly")}</Banner> : null}
    {failure ? <ErrorState title={t("translationPlugin.failed")} description={readFailure ? t("workbenchV2.importPreparationReadFailed") : undefined} action={<>
      <FailureDetails failure={failure} />
      {readFailure ? <Button onClick={() => commands.dispatch("translation.refresh-import", commandScope)} disabled={!common(true).enabled}>{t("workbenchV2.importPreparationRetryRead")}</Button> : null}
    </>} /> : null}
    <div className={styles.fields}>
      <Field label={t("workbenchV2.importPreparationTarget")}>{props => <Menu align="start" trigger={<Button {...props} variant="secondary" disabled={draftLocked}>{targetLocale || t("workbenchV2.importPreparationChooseTarget")}</Button>}
        items={project.metadata.targetLocales.map(locale => ({ id: locale, label: locale, onSelect: () => { if (canEdit()) owner.setTarget(locale); } }))} />}</Field>
      <Field label={t("translationPlugin.package")}>{props => <Menu align="start" trigger={<Button {...props} variant="secondary" disabled={draftLocked || !inventory.data || choices.length === 0}>{choice?.label ?? t("translationPlugin.choosePackage")}</Button>}
        items={choices.map(value => ({ id: value.key, label: value.label, onSelect: () => selectPackage(value.key, "") }))} />}</Field>
      <Field label={t("sourcePlugin.runtime")}>{props => <Menu align="start" trigger={<Button {...props} variant="secondary" disabled={draftLocked || !choice || runtimes.length === 0}>{runtime ? t(runtime.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption", {
        version: pluginEnvironmentVersion(runtime.environment), system: runtime.environment.platform.operatingSystem, architecture: runtime.environment.platform.architecture }) : t("sourcePlugin.chooseRuntime")}</Button>}
        items={runtimes.map(value => ({ id: value.environmentDigest, label: t(value.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption", { version: pluginEnvironmentVersion(value.environment), system: value.environment.platform.operatingSystem, architecture: value.environment.platform.architecture }), onSelect: () => selectPackage(effectiveChoice, value.environmentDigest) }))} />}</Field>
      {(source.data?.nativeScopes.length ?? 0) > 1 ? <Field label={t("translationPlugin.scope")}>{props => <Menu align="start" trigger={<Button {...props} variant="secondary" disabled={draftLocked}>{nativeScope ? `${nativeScope.namespace} · ${nativeScope.policy.id}` : t("translationPlugin.scope")}</Button>}
        items={(source.data?.nativeScopes ?? []).map((value, index) => ({ id: `${value.namespace}:${value.policy.id}`, label: `${value.namespace} · ${value.policy.id}`, onSelect: () => { if (canEdit() && ready(sourceKey, source.data) && owner.resetPlugin()) setScopeIndex(index); } }))} />}</Field> : null}
    </div>
    <div className={styles.actions}><Button size="sm" disabled={!common(true).enabled} onClick={() => commands.dispatch("translation.refresh-import", commandScope)}>{t("translationPlugin.refresh")}</Button></div>
    {inventory.isPending || inventory.isFetching || environment.isFetching ? <LoadingState label={t("execution.loading")} />
      : inventory.isSuccess && choices.length === 0 ? <EmptyState title={t("workbenchV2.importPreparationNoPlugins")} />
        : choice && runtimes.length === 0 ? <EmptyState title={t("workbenchV2.importPreparationNoRuntimes")} />
          : source.isSuccess && source.data.nativeScopes.length === 0 ? <EmptyState title={t("workbenchV2.importPreparationNoSource")} /> : null}
    {environmentChanged ? <Banner tone="warning">{t("translationPlugin.environmentChanged")}</Banner> : null}
    {!preparationReady() && !readFailure && !inventory.isFetching && !source.isFetching && !environment.isFetching && !!translation && runtimes.length > 0 ? <Banner tone="info">{t("workbenchV2.importPreparationNotReady")}</Banner> : null}
    {!state.preflight && !state.extractionAttempt ? <>
      {environment.data ? <p className={styles.secondary}>{t("translationPlugin.material", { directory: environment.data.declaration.material.logicalDirectory, extension: environment.data.declaration.material.extension, bytes: String(environment.data.declaration.material.maxBytes) })}</p> : null}
      <div className={styles.actions}><Button variant="secondary" disabled={!setupAvailability(setup).enabled} onClick={() => commands.dispatch("translation.choose-import-folder", commandScope, setup)}>{t("translation.chooseFolder")}</Button></div>
      {state.folder ? <>
        <p><TokenizedText text={t("translation.folder", { name: state.folder.folderName })} /></p>
        {files.isFetching ? <LoadingState label={t("execution.loading")} /> : files.isSuccess && files.data.length === 0 ? <EmptyState title={t("translation.noFiles")} /> : null}
        {files.data?.length ? <Field label={t("translation.file")}>{props => <Menu align="start" trigger={<Button {...props} variant="secondary" disabled={draftLocked || !ready(filesKey, files.data)}>{state.fileName || t("translation.file")}</Button>}
          items={files.data.map(file => ({ id: file, label: file, onSelect: () => { if (canEdit() && ready(filesKey, files.data) && files.data?.includes(file)) owner.setFile(file); } }))} />}</Field> : null}
        {consent && state.fileName ? <label className={styles.check}><input type="checkbox" checked={state.confirmed} disabled={!consentAvailability(consent).enabled}
          onChange={event => commands.dispatch("translation.confirm-import-language", commandScope, { ...consent, confirmed: event.target.checked })} />{t("translationPlugin.languageConfirm", { file: state.fileName, target: state.folder.targetLocale })}</label> : null}
        <div className={styles.actions}><Button variant="primary" disabled={!setupAvailability(setup, true).enabled} onClick={() => commands.dispatch("translation.inspect-import", commandScope, setup)}>{t("translationPlugin.capture")}</Button></div>
      </> : null}
    </> : null}
    {state.preflight ? <>
      <p>{t("translationPlugin.captured", { file: state.preflight.file.logicalPath, bytes: String(state.preflight.file.byteLength), target: state.preflight.targetLocale })}</p>
      {!state.extractionAttempt ? <>
        <ExecutionReview key={state.preflight.inputDigest} view={state.preflight.translation} checker={false} />
        <label className={styles.check}><input type="checkbox" checked={state.producerConsent === state.preflight.inputDigest} disabled={locked || !preparationReady()}
          onChange={event => { if (common().enabled && preparationReady() && owner.current().preflight === state.preflight) owner.consentProducer(event.target.checked); }} />{t("translationPlugin.producerConsent")}</label>
        <div className={styles.actions}><Button variant="primary" disabled={!consent || !consentAvailability(consent, true).enabled} onClick={() => { if (consent) commands.dispatch("translation.start-import", commandScope, consent); }}>{t("translation.start")}</Button></div>
      </> : null}
    </> : null}
    {state.busy || working ? <Banner role="status">{t("execution.working")}</Banner> : null}
    {item ? <p role="status">{t(`execution.states.${item.status.execution}`)} · {t(`releasePlugin.validation.${item.status.validation}`)}</p> : null}
    {item?.status.diagnostic ? <Banner tone="warning"><TokenizedText text={item.status.diagnostic} /></Banner> : null}
    {state.extractionAttempt && item?.status.validation !== "valid" ? <div className={styles.actions}><Button variant="secondary" disabled={!pluginAvailability(command).enabled} onClick={() => commands.dispatch("translation.prepare-import-check", commandScope, command)}>{t("translationPlugin.prepareCheck")}</Button></div> : null}
    {state.checkReview && !state.checkAttempt ? <>
      <ExecutionReview key={state.checkReview.inputDigest} view={state.checkReview.translation} checker />
      <p>{t("translationPlugin.rules", { count: state.checkReview.rules.length })}</p>
      <label className={styles.check}><input type="checkbox" checked={state.checkerConsent === state.checkReview.inputDigest} disabled={locked || !preparationReady()}
        onChange={event => { if (common().enabled && preparationReady() && owner.current().checkReview === state.checkReview) owner.consentChecker(event.target.checked); }} />{t("translationPlugin.checkerConsent")}</label>
      <div className={styles.actions}><Button variant="primary" disabled={!pluginAvailability(command, "start-check").enabled} onClick={() => commands.dispatch("translation.start-import-check", commandScope, command)}>{t("translationPlugin.startCheck")}</Button></div>
    </> : null}
    {checkedItem ? <p role="status">{t(`execution.states.${checkedItem.status.execution}`)}</p> : null}
    {checkedItem?.status.diagnostic ? <Banner tone="warning"><TokenizedText text={checkedItem.status.diagnostic} /></Banner> : null}
    {checkedItem?.status.execution === "succeeded" ? <div className={styles.actions}><Button variant="primary" disabled={!pluginAvailability(command, "finish-check").enabled} onClick={() => commands.dispatch("translation.finish-import-check", commandScope, command)}>{t("translationPlugin.recordCheck")}</Button></div> : null}
    {item?.status.validation === "invalid" ? <Banner tone="error" role="alert">{t("translationPlugin.invalid")}</Banner> : null}
    {item?.status.validation === "valid" && !state.projection ? <div className={styles.actions}><Button variant="primary" disabled={!pluginAvailability(command, "prepare-projection").enabled} onClick={() => commands.dispatch("translation.prepare-import-projection", commandScope, command)}>{t("translationPlugin.preparePreview")}</Button></div> : null}
    {state.projection && !state.attempt ? <><p>{t("translationPlugin.checked", { target: state.projection.targetLocale })}</p><div className={styles.actions}><Button variant="primary" disabled={!pluginAvailability(command, "start-projection").enabled} onClick={() => commands.dispatch("translation.start-import-projection", commandScope, command)}>{t("translationPlugin.openPreview")}</Button></div></> : null}
    {pending ? <Banner tone="warning" role="status">
      <p>{t(state.checkingStart ? "execution.checkingPluginStart" : "translationPlugin.unknown")}</p>
      {pending.pendingKind === "start-check" || pending.pendingKind === "start-projection" ? <>
        <Button variant="secondary" disabled={!pluginPendingAvailability(pending).enabled} onClick={() => commands.dispatch(pending.pendingKind === "start-projection" ? "translation.check-import-projection-start" : "translation.check-import-plugin-start", commandScope, pending)}>{t("execution.checkPluginStart")}</Button>
        {state.startRetryAllowed ? <><p>{t(pending.pendingKind === "start-projection" ? "translationPlugin.projectionStartMissing" : "execution.pluginStartMissing")}</p><Button variant="secondary" disabled={!pluginPendingAvailability(pending, true).enabled} onClick={() => commands.dispatch("translation.retry-import-plugin", commandScope, pending)}>{t("execution.retryPluginStart")}</Button></> : null}
      </> : <Button variant="secondary" disabled={!pluginPendingAvailability(pending, true).enabled} onClick={() => commands.dispatch("translation.retry-import-plugin", commandScope, pending)}>{t("translationPlugin.retryOriginal")}</Button>}
    </Banner> : null}
    {startPending ? <Banner tone="warning" role="status"><p>{t(state.checkingStart ? "execution.checkingPluginStart" : "translation.startUnknown")}</p>
      <Button variant="secondary" disabled={!startPendingAvailability(startPending).enabled} onClick={() => commands.dispatch("translation.check-import-start", commandScope, startPending)}>{t("execution.checkPluginStart")}</Button>
      {state.startRetryAllowed ? <><p>{t("execution.pluginStartMissing")}</p><Button variant="secondary" disabled={!startPendingAvailability(startPending, true).enabled} onClick={() => commands.dispatch("translation.retry-import-start", commandScope, startPending)}>{t("execution.retryPluginStart")}</Button></> : null}
    </Banner> : null}
    {attemptReads.map(([, detail]) => detail && running(detail) ? <div key={detail.attemptId} className={styles.actions}>
      <Button variant="secondary" disabled={!cancellationAvailability({ kind: "execution-cancellation", taskId: detail.taskId, attemptId: detail.attemptId, origin: "tasks" }).enabled}
        onClick={() => commands.dispatch("tasks.cancel-task", commandScope, { kind: "execution-cancellation", taskId: detail.taskId, attemptId: detail.attemptId, origin: "tasks" })}>{t("execution.cancel")}</Button>
      <p className={styles.secondary}>{t("workbenchV2.importPreparationCancelHelp")}</p>
    </div> : null)}
    {cancellations.map(value => {
      const intent: ExecutionCancellationRetryCommandPayload | null = value.phase === "unknown" ? { kind: "execution-cancellation-retry", ...value.target, requestId: value.request.requestId } : null;
      return <Banner key={value.target.taskId} tone={value.phase === "recorded" ? "info" : "warning"} role="status">
        <p>{t(value.phase === "recorded" ? "execution.cancelRecorded" : value.phase === "checking" ? "execution.checkingCancellation" : value.phase === "unknown" ? "execution.cancelUnknown" : value.phase === "rejected" ? value.request ? "execution.cancelRejected" : "execution.cancelPreparationFailed" : "execution.cancelPending")}</p>
        {value.failure ? <FailureDetails failure={value.failure} /> : null}
        {intent ? <Button variant="secondary" disabled={!cancellationRecovery(intent).enabled} onClick={() => commands.dispatch("tasks.check-cancellation", commandScope, intent)}>{t("execution.checkCancellation")}</Button> : null}
        {intent && value.phase === "unknown" && value.retryAllowed ? <><p>{t("execution.noCancellation")}</p><Button variant="secondary" disabled={!cancellationRecovery(intent, true).enabled} onClick={() => commands.dispatch("tasks.retry-cancellation", commandScope, intent)}>{t("execution.retryCancellation")}</Button></> : null}
      </Banner>;
    })}
    {state.folder ? <div className={styles.actions}><Button size="sm" disabled={locked || working} onClick={() => commands.dispatch("translation.reset-import", commandScope)}>{t("translationPlugin.newInput")}</Button></div> : null}
  </section>;
}
