import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { QueryKey, UseQueryResult } from "@tanstack/react-query";
import { PluginPermissions } from "./PluginPermissions";
import { matchingPluginEnvironments, pluginEnvironmentVersion } from "./pluginEnvironments";
import type { PluginSourceView } from "./pluginCommands";
import { executionContext, type AttemptDetail } from "./executionCommands";
import { readCompleteAttempt } from "./executionRead";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { TaskCancellationFeedback } from "./ExecutionTaskSession";
import { useSourceDraftSession } from "./SourceDraftSession";
import { sourceReads, sourceKeys, type SourceInventory } from "./sourceQueries";
import { sameSourceEnvironment, sourceRequest } from "./sourceCommands";
import { useWorkbenchState } from "./WorkbenchFrame";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import { ExecutionDiagnosticDetails } from "./ExecutionDiagnosticDetails";
import { useSourceFailureOutput } from "./useSourceFailureOutput";
import { useWorkbenchCommands, type CommandAvailability, type SourceSelectionCommandPayload, type SourceCaptureCommandPayload,
  type SourceCheckCommandPayload, type SourceTaskCommandPayload, type SourcePluginPendingCommandPayload } from "./workbenchCommands";
import type { ProjectView } from "./projectCommands";

function ExecutionReview({ source, checker }: { source: PluginSourceView; checker: boolean }) {
  const { t } = useTranslation(), capability = checker ? source.checker : source.extractor;
  return <section aria-label={t("sourcePlugin.executionReview")}>
    <p>{source.declaration.displayName} · {capability.provider.plugin.id} {capability.provider.plugin.version}</p>
    <p>{t(source.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeDetails" : "sourcePlugin.nativeRuntimeDetails", { version: pluginEnvironmentVersion(source.environment), system: source.environment.platform.operatingSystem, architecture: source.environment.platform.architecture })}</p>
    <PluginPermissions permissions={capability.declaration.permissions} /><p>{t("sourcePlugin.unsandboxed")}</p>
    <details><summary>{t("sourcePlugin.fixedDetails")}</summary><dl>
      <dt>{t("sourcePlugin.packageDigest")}</dt><dd><code>{capability.provider.packageDigest}</code></dd>
      <dt>{t("sourcePlugin.runtimeDigest")}</dt><dd><code>{source.environmentDigest}</code></dd>
      <dt>{t("sourcePlugin.profile")}</dt><dd><code>{source.declaration.profile.id}</code> ({source.declaration.profile.schemaVersion}/{source.declaration.profile.behaviorVersion})</dd>
    </dl></details>
  </section>;
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };

/** Fixed captures and original requests belong to the project session. */
export function SourceImportControls({ project, open, canCapture, proposal, validation, disabled, onValidated, onOpenExtensions,
  inventory, environmentRead, selectionAvailability, captureAvailability, discardAvailability }: {
  project: ProjectView; open: boolean; canCapture: boolean; proposal: { attemptId: string; resultId: string } | null;
  validation: AttemptDetail["items"][number]["status"]["validation"]; disabled: boolean;
  onValidated: () => Promise<void>; onOpenExtensions?: () => void;
  inventory: UseQueryResult<SourceInventory, Error>; environmentRead: UseQueryResult<PluginSourceView, Error>;
  selectionAvailability: (input: SourceSelectionCommandPayload) => CommandAvailability;
  captureAvailability: (input: SourceCaptureCommandPayload, start: boolean) => CommandAvailability;
  discardAvailability: () => CommandAvailability;
}) {
  const { t } = useTranslation(), owner = useSourceDraftSession(), reads = useSessionReads(), registry = useWorkbenchCommands();
  const context = executionContext(project), commandScope = { ...context, area: "source" as const };
  const [choiceKey, setChoiceKey] = useWorkbenchState("source", "pluginChoice", "");
  const [runtimeDigest, setRuntimeDigest] = useWorkbenchState("source", "pluginRuntime", "");
  const [refresh, setRefresh] = useWorkbenchState("source", "pluginRefresh", 0);
  const committed = useRef({ project, open, disabled, canCapture, proposal, validation });
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { committed.current = { project, open, disabled, canCapture, proposal, validation }; });
  const state = owner.state, source = state.source;
  const inventoryKey = sourceKeys.inventory(refresh);
  const choices = inventory.data?.choices ?? [], environments = inventory.data?.environments ?? [];
  const effectiveChoice = source ? `${source.package.packageDigest}:${source.resourceId}` : choiceKey;
  const choice = choices.find(item => item.key === effectiveChoice), runtimes = matchingPluginEnvironments(environments, choice?.runtimeKinds ?? []);
  const effectiveRuntime = source?.environmentDigest ?? runtimeDigest;
  const environmentOptions = sourceReads.integration(context, source);
  const environment = !environmentRead.error && environmentRead.data && source && sameSourceEnvironment(environmentRead.data, source) ? environmentRead.data : null;
  const checkKey = ["source-check", state.checkAttempt];
  const checkRead = useSessionQuery({ key: checkKey, scopes: ["execution"], enabled: open && !!state.checkAttempt,
    read: () => state.checkAttempt ? readCompleteAttempt(context, state.checkAttempt, "source-semantic-check") : Promise.resolve(null) });
  const checkedItem = checkRead.data?.items.length === 1 ? checkRead.data.items[0] : null;
  const failedCheck = checkRead.data?.attemptId === state.checkAttempt && checkedItem?.status.execution === "failed"
    && checkedItem.resultId && state.checkAttempt
    ? { attemptId: state.checkAttempt, resultId: checkedItem.resultId, itemId: checkedItem.status.itemId } : null;
  const checkFailureOutput = useSourceFailureOutput(project, open, failedCheck);
  const checkActive = !!state.checkAttempt && (!checkedItem || checkedItem.status.execution === "queued" || checkedItem.status.execution === "dispatched");
  const error = inventory.error ?? environmentRead.error ?? checkRead.error;
  const pending = state.pendingPlugin;
  const locked = disabled || state.busyMutation || owner.hasPending() || checkActive;
  function sameView() { const value = committed.current; return mounted.current && !reads.retired && value.open
    && value.project.sessionToken === context.sessionToken && value.project.metadata.projectId === context.projectId; }
  function live() { return sameView() && !committed.current.disabled; }
  function ready(key: QueryKey) { const record = reads.client.getQueryState(reads.key(key));
    return record?.status === "success" && record.error === null && record.fetchStatus === "idle" && !record.isInvalidated; }
  function common(recovery = false, rendering = false): CommandAvailability {
    if (rendering ? !open || disabled || reads.retired : !live()) return { enabled: false, reason: "hidden" };
    if (owner.inFlight()) return { enabled: false, reason: "busy" };
    return !recovery && owner.hasPending() ? { enabled: false, reason: "pending-action" } : { enabled: true };
  }
  function selected(key: string, digest: string) {
    if (locked) return;
    setChoiceKey(key); setRuntimeDigest(digest);
    const selected = choices.find(item => item.key === key);
    owner.setSource(selected && digest ? { package: selected.package, resourceId: selected.resourceId, environmentDigest: digest } : null);
  }
  function selectionPayload(): SourceSelectionCommandPayload | null { return source ? { kind: "source-selection", request: { ...context, source } } : null; }
  function capturePayload(): SourceCaptureCommandPayload { return { kind: "source-capture", selectionId: state.selection?.selectionId ?? "",
    sourceLanguage: state.sourceLanguage, attemptId: state.preflight?.attemptId ?? null, inputDigest: state.preflight?.inputDigest ?? null,
    producerConsent: !!state.preflight && state.producerConsent === state.preflight.inputDigest }; }
  function checkPayload(): SourceCheckCommandPayload | null {
    const review = state.checkReview, selected = review ? sourceRequest(review.source) : source;
    if (!proposal || !selected) return null;
    return { kind: "source-check", source: selected, sourceAttemptId: proposal.attemptId, sourceResultId: proposal.resultId,
      checkAttemptId: review?.attemptId ?? null, inputDigest: review?.inputDigest ?? null, checkResultId: checkedItem?.resultId ?? null,
      checkerConsent: !!review && state.checkerConsent === review.inputDigest };
  }
  function checkAvailability(input?: SourceCheckCommandPayload, phase: "prepare" | "start" | "finish" = "prepare", rendering = false): CommandAvailability {
    const allowed = common(false, rendering), expected = checkPayload(), value = rendering ? { proposal, validation } : committed.current;
    if (!allowed.enabled) return allowed;
    if (!input || !expected || JSON.stringify(input) !== JSON.stringify(expected) || !value.proposal
      || value.proposal.attemptId !== owner.current().attempt || value.validation === "valid") return unavailable;
    if (phase === "finish") return ready(checkKey) && checkedItem?.status.execution === "succeeded"
      && !checkedItem.status.cancellationRequested && !!input.checkResultId ? allowed : unavailable;
    if (!ready(inventoryKey) || !ready(environmentOptions.key) || !environment || !runtimes.some(item => item.environmentDigest === effectiveRuntime)) return unavailable;
    if (phase === "start") return !state.checkAttempt && !!state.checkReview && state.checkerConsent === state.checkReview.inputDigest
      && JSON.stringify(state.checkReview.source) === JSON.stringify(environment) ? allowed : unavailable;
    return !checkActive && (!state.checkReview || !!checkedItem && ["failed", "unknown", "cancelled-before-dispatch"].includes(checkedItem.status.execution)) ? allowed : unavailable;
  }
  function pendingPayload(): SourcePluginPendingCommandPayload | null { return pending ? { kind: "source-plugin-pending", ...pending } : null; }
  function retryAvailability(input?: SourcePluginPendingCommandPayload, rendering = false): CommandAvailability {
    const allowed = common(true, rendering), expected = pendingPayload();
    return allowed.enabled && input && expected && JSON.stringify(input) === JSON.stringify(expected) ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function proof() {
    const captured = environment, request = source, witness = reads.watchExactQuery(environmentOptions.key);
    return { current: () => !reads.retired && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
      && JSON.stringify(owner.current().source) === JSON.stringify(request) && (() => { const query = witness.current();
        return !query || query.state.status === "success" && query.state.error === null && !query.state.isInvalidated && JSON.stringify(query.state.data) === JSON.stringify(captured); })(), dispose: witness.dispose };
  }
  useLayoutEffect(() => {
    const meta = { scope: commandScope, category: "source" as const, binding: null, risk: "captures-source" as const, confirmation: "none" as const };
    const unregister = [
      registry.register({ ...meta, id: "source.prepare-check", nameKey: "sourcePlugin.prepareCheck", payloadKind: "source-check", availability: input => checkAvailability(input, "prepare"), handler: input => { const captured = proof(); void owner.prepareCheck({ attemptId: input.sourceAttemptId, resultId: input.sourceResultId }, captured.current, captured.dispose); } }),
      registry.register({ ...meta, id: "source.start-check", nameKey: "sourcePlugin.startCheck", payloadKind: "source-check", availability: input => checkAvailability(input, "start"), handler: () => { const captured = proof(); void owner.startCheck(captured.current, captured.dispose); } }),
      registry.register({ ...meta, id: "source.finish-check", nameKey: "sourcePlugin.recordCheck", payloadKind: "source-check", availability: input => checkAvailability(input, "finish"), handler: input => { if (input.checkResultId) void owner.finishCheck(input.checkResultId).then(() => { if (sameView()) return onValidated(); }); } }),
      registry.register({ ...meta, id: "source.retry-plugin-request", nameKey: "sourcePlugin.retryOriginal", payloadKind: "source-plugin-pending", availability: retryAvailability, handler: () => void owner.retryPlugin().then(() => { if (sameView()) return onValidated(); }) }),
    ];
    return () => unregister.forEach(cleanup => cleanup());
  });
  const cancellation: SourceTaskCommandPayload | null = checkRead.data && checkRead.data.attemptId === state.checkAttempt ? { kind: "source-task", taskId: checkRead.data.taskId, attemptId: checkRead.data.attemptId } : null;
  const selectionCommand = selectionPayload(), checkCommand = checkPayload(), retryCommand = pendingPayload();
  return <section aria-label={t("sourcePlugin.importControls")} aria-busy={state.busyMutation || inventory.isFetching || environmentRead.isFetching}>
    {error ? <div role="alert"><p>{t("sourcePlugin.failed")}</p><CommandFailureDetails failure={commandFailure(error)} /></div> : null}
    {inventory.isFetching || environmentRead.isFetching || state.busyMutation ? <p role="status">{t("execution.working")}</p> : null}
    {canCapture || proposal && validation !== "valid" ? <>
      <label className="source-field">{t("source.integration")}<select value={effectiveChoice} disabled={locked || inventory.isFetching} onChange={event => selected(event.target.value, "")}>
        <option value="">{t("sourcePlugin.choosePackage")}</option>{choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select></label>
      <label className="source-field">{t("sourcePlugin.runtime")}<select value={effectiveRuntime} disabled={locked || inventory.isFetching || !choice} onChange={event => selected(effectiveChoice, event.target.value)}>
        <option value="">{t("sourcePlugin.chooseRuntime")}</option>{runtimes.map(item => <option key={item.environmentDigest} value={item.environmentDigest}>{t(item.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption", { version: pluginEnvironmentVersion(item.environment), system: item.environment.platform.operatingSystem, architecture: item.environment.platform.architecture })}</option>)}
      </select></label>
      <button className="secondary-button" disabled={locked || inventory.isFetching || environmentRead.isFetching} onClick={() => {
        void reads.client.invalidateQueries({ queryKey: reads.key(environmentOptions.key), exact: true, refetchType: "none" });
        setRefresh(value => value + 1);
      }}>{t("sourcePlugin.refresh")}</button>
      {!environment && !inventory.isFetching && !environmentRead.isFetching ? <p role="status">{t("sourcePlugin.unavailable")}</p> : null}
      {onOpenExtensions ? <button className="text-button" disabled={state.busyMutation} onClick={onOpenExtensions}>{t("plugins.open")}</button> : null}
    </> : null}
    {canCapture ? <>
      {environment ? <ul>{environment.declaration.materials.map(file => <li key={file.logicalPath}>{t("sourcePlugin.material", { path: file.logicalPath, bytes: String(file.maxBytes) })}</li>)}</ul> : null}
      <button className="secondary-button" disabled={!selectionCommand || !selectionAvailability(selectionCommand).enabled} onClick={() => { if (selectionCommand) registry.dispatch("source.select", commandScope, selectionCommand); }}>{t("sourcePlugin.chooseFolder")}</button>
      {state.selection ? <><p>{state.selection.folderName}</p>
        <label className="source-check"><input type="checkbox" checked={state.declared} disabled={locked} onChange={event => owner.declare(event.target.checked)} />{t("source.language", { language: project.metadata.sourceLocale })}</label>
        <button className="secondary-button" disabled={!captureAvailability(capturePayload(), false).enabled} onClick={() => registry.dispatch("source.preflight", commandScope, capturePayload())}>{t("source.preflight")}</button>
        {state.preflight ? <><p>{t("sourcePlugin.captured", { count: state.preflight.files.length, language: state.preflight.sourceLanguage })}</p>
          <ul>{state.preflight.files.map(file => <li key={file.logicalPath}>{t("sourcePlugin.capturedFile", { path: file.logicalPath, bytes: String(file.byteLength) })}<details><summary>{t("source.fingerprint")}</summary><code>{file.sha256}</code></details></li>)}</ul>
          <ExecutionReview source={state.preflight.source} checker={false} /><label className="source-check"><input type="checkbox" checked={state.producerConsent === state.preflight.inputDigest} disabled={locked} onChange={event => owner.consentProducer(event.target.checked)} />{t("sourcePlugin.producerConsent")}</label>
          <button className="primary-button" disabled={!captureAvailability(capturePayload(), true).enabled} onClick={() => registry.dispatch("source.start", commandScope, capturePayload())}>{t("source.start")}</button>
        </> : null}
        <button className="text-button" disabled={!discardAvailability().enabled} onClick={() => registry.dispatch("source.discard", commandScope)}>{t("source.discard")}</button>
      </> : null}
    </> : null}
    {proposal ? <section aria-label={t("sourcePlugin.semanticChecks")}><p role="status">{t(validation === "valid" ? "sourcePlugin.validated" : validation === "invalid" ? "sourcePlugin.invalid" : "sourcePlugin.checkRequired")}</p>
      {checkCommand && validation !== "valid" ? <>
        <button className="secondary-button" disabled={!checkAvailability(checkCommand, "prepare", true).enabled} onClick={() => registry.dispatch("source.prepare-check", commandScope, checkCommand)}>{t("sourcePlugin.prepareCheck")}</button>
        {state.checkReview && !state.checkAttempt ? <><ExecutionReview source={state.checkReview.source} checker /><p>{t("sourcePlugin.rules", { count: state.checkReview.rules.length })}</p>
          <label className="source-check"><input type="checkbox" checked={state.checkerConsent === state.checkReview.inputDigest} disabled={locked} onChange={event => owner.consentChecker(event.target.checked)} />{t("sourcePlugin.checkerConsent")}</label>
          <button className="primary-button" disabled={!checkAvailability(checkCommand, "start", true).enabled} onClick={() => registry.dispatch("source.start-check", commandScope, checkCommand)}>{t("sourcePlugin.startCheck")}</button></> : null}
        {checkedItem && (checkedItem.status.cancellationRequested || ["failed", "unknown", "cancelled-before-dispatch"].includes(checkedItem.status.execution)) ? <p role="status">{t("sourcePlugin.checkFailed")}</p> : null}
        {cancellation && checkActive ? <div><button className="secondary-button" disabled={!registry.describe("source.cancel-task", commandScope, cancellation)?.availability.enabled} onClick={() => registry.dispatch("source.cancel-task", commandScope, cancellation)}>{t("execution.cancel")}</button>
          <TaskCancellationFeedback origin="source" taskId={cancellation.taskId} disabled={disabled || owner.inFlight()} visible={open} /></div> : null}
        {checkedItem ? <p role="status">{t(`execution.states.${checkedItem.status.execution}`)}</p> : null}
        {checkedItem?.status.diagnostic || failedCheck && checkFailureOutput.data?.sourceFailure ? <ExecutionDiagnosticDetails
          code={checkedItem?.status.diagnostic}
          sourceFailure={failedCheck && checkFailureOutput.status === "success" && !checkFailureOutput.isFetching && !checkFailureOutput.error
            && checkFailureOutput.data?.projectId === context.projectId && checkFailureOutput.data?.resultId === failedCheck.resultId
            && checkFailureOutput.data?.itemId === failedCheck.itemId ? checkFailureOutput.data.sourceFailure : undefined} /> : null}
        {failedCheck && checkFailureOutput.error ? <div role="alert"><p>{t("execution.failureReadFailed")}</p>
          <CommandFailureDetails failure={commandFailure(checkFailureOutput.error)} />
          <button className="secondary-button" disabled={checkFailureOutput.isFetching} onClick={() => void checkFailureOutput.refetch()}>{t("source.retryRead")}</button>
        </div> : null}
        {checkedItem?.status.execution === "succeeded" ? <button className="primary-button" disabled={!checkAvailability(checkCommand, "finish", true).enabled} onClick={() => registry.dispatch("source.finish-check", commandScope, checkCommand)}>{t("sourcePlugin.recordCheck")}</button> : null}
      </> : null}
    </section> : null}
    {proposal ? <button className="text-button" disabled={locked || !discardAvailability().enabled} onClick={() => registry.dispatch("source.discard", commandScope)}>{t("sourcePlugin.newInput")}</button> : null}
    {retryCommand ? <section role="status"><p>{t(retryCommand.pendingKind === "finish-check" ? "sourcePlugin.checkCommitUnknown" : "sourcePlugin.operationUnknown")}</p><button className="secondary-button" disabled={!retryAvailability(retryCommand, true).enabled} onClick={() => registry.dispatch("source.retry-plugin-request", commandScope, retryCommand)}>{t(retryCommand.pendingKind === "finish-check" ? "sourcePlugin.reconcileCheck" : "sourcePlugin.retryOriginal")}</button></section> : null}
  </section>;
}
