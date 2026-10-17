import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { BuildExecutionReview } from "./BuildExecutionReview";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import { TaskCancellationFeedback, useExecutionTaskSession } from "./ExecutionTaskSession";
import { useReleaseDraftSession, type ReleaseReadProof } from "./ReleaseDraftSession";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { releaseCommands, sameArtifactWorkflowMaterialization, type ArtifactCheckWorkflowObservation } from "./releaseCommands";
import type { AttemptDetail } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { enUS } from "./i18n/en-US";
import { useWorkbenchCommands, type CommandAvailability, type ReleaseWorkflowCommandPayload,
  type ReleaseWorkflowConsentCommandPayload, type ReleaseWorkflowPrepareCommandPayload,
  type ExecutionCancellationCommandPayload, type ExecutionCancellationRetryCommandPayload } from "./workbenchCommands";

export function ArtifactCheckWorkflowControls({ project, open, disabled, detail, buildKey, readProof }: {
  project: ProjectView; open: boolean; disabled: boolean; detail: AttemptDetail | null;
  buildKey: readonly unknown[]; readProof: () => ReleaseReadProof;
}) {
  const { t } = useTranslation(), owner = useReleaseDraftSession(), reads = useSessionReads(), registry = useWorkbenchCommands(), tasks = useExecutionTaskSession();
  const mounted = useRef(false), errorRegion = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const capture = owner.workflow, request = owner.workflowReadRequest();
  const key = request ? owner.workflowReadKey(request) : ["release-check-workflow", null];
  const status = useSessionQuery({ key, scopes: ["execution", "release"], enabled: open && request !== null && !owner.busy,
    read: () => { if (!request) throw new Error("No captured artifact workflow"); return releaseCommands.readWorkflow(request); } });
  const query = reads.client.getQueryState(reads.key(key));
  const observation: ArtifactCheckWorkflowObservation | undefined = query?.status === "success" && !query.error
    && !query.isInvalidated && query.fetchStatus === "idle" ? status.data : undefined;
  const materializationChanged = !!capture?.review && !!observation?.view?.materializationDigest
    && !sameArtifactWorkflowMaterialization(capture.review, observation.view);
  // A read can settle an original uncertain command. It never starts a step.
  useEffect(() => { if (open && request && observation) owner.observeWorkflow(request, observation); });
  useEffect(() => { if (open && status.error) errorRegion.current?.focus(); }, [open, status.error]);
  // The finite Host intent is not a reliable change event. Poll only its read
  // projection while visible and progressing; errors require an explicit retry.
  useEffect(() => {
    if (!open || !request || owner.busy || status.isFetching || status.error) return;
    const progressing = observation?.view?.phase === "preparing" || observation?.view?.phase === "running"
      || observation?.callbacksDrained === false || !capture?.review && !capture?.safety?.admissionClosed;
    if (!progressing) return;
    const timer = setTimeout(() => {
      if (mounted.current && !reads.retired && JSON.stringify(request) === JSON.stringify(owner.workflowReadRequest())) void status.refetch();
    }, 1000);
    return () => clearTimeout(timer);
  }, [open, capture?.request.preparation.identity.workflowId, capture?.start?.start.materializationDigest,
    owner.busy, status.isFetching, status.error, status.dataUpdatedAt, observation?.view?.phase, observation?.callbacksDrained,
    capture?.review?.materializationDigest, capture?.safety?.admissionClosed]);
  const view = materializationChanged ? capture?.review : observation?.view ?? capture?.review;
  const task = observation ? observation.currentTask : capture?.safety?.currentTask ?? null;
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "release" as const };
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const no: CommandAvailability = { enabled: false, reason: "unavailable" };
  function currentObservation() {
    const current = reads.client.getQueryState(reads.key(key));
    return !!observation && current?.status === "success" && !current.error && !current.isInvalidated
      && current.fetchStatus === "idle" && reads.client.getQueryData(reads.key(key)) === observation;
  }
  function gate(recovery = false): CommandAvailability {
    if (!mounted.current || !open || reads.retired || reads.context.projectId !== scope.projectId || reads.context.sessionToken !== scope.sessionToken)
      return { enabled: false, reason: "hidden" };
    if (disabled) return no;
    if (owner.current().busy && !(recovery && owner.current().workflow?.pending)) return { enabled: false, reason: "busy" };
    if (!recovery && (owner.reserved() || tasks.unresolved())) return { enabled: false, reason: "pending-action" };
    return { enabled: true };
  }
  function preparePayload(): ReleaseWorkflowPrepareCommandPayload | undefined {
    const value = owner.current(), prepared = value.prepared;
    if (!prepared || !detail || detail.attemptId !== value.attempt || detail.items.some(item => !item.resultId)) return undefined;
    return { kind: "release-workflow-prepare", editSeq: value.editSeq, buildAttemptId: detail.attemptId,
      buildInputDigest: prepared.review.inputDigest, build: structuredClone(prepared.request.build),
      buildResults: detail.items.flatMap(item => item.resultId ? [{ itemId: item.status.itemId, resultId: item.resultId }] : []) };
  }
  function prepareAvailability(payload?: ReleaseWorkflowPrepareCommandPayload): CommandAvailability {
    const allowed = gate(); if (!allowed.enabled) return allowed;
    const value = owner.current(), buildQuery = reads.client.getQueryState(reads.key(buildKey));
    return payload && same(payload, preparePayload()) && !value.workflow && !value.checkReview && !value.checkAttempt
      && !value.buildReceipt && detail && detail.nextOffset === null && detail.items.length > 0 && detail.items.length <= 16
      && detail.items.length === detail.progress.total && detail.items.every(item => item.resultId && item.status.execution === "succeeded" && !item.status.cancellationRequested)
      && buildQuery?.status === "success" && !buildQuery.error && !buildQuery.isInvalidated && buildQuery.fetchStatus === "idle"
      && reads.client.getQueryData(reads.key(buildKey)) === detail ? { enabled: true } : no;
  }
  function controlPayload(): ReleaseWorkflowCommandPayload | undefined {
    const value = owner.current().workflow;
    return value ? { kind: "release-workflow", identity: structuredClone(value.request.preparation.identity),
      materializationDigest: value.review?.materializationDigest ?? null, approvedAttemptIds: [...value.approved] } : undefined;
  }
  function controlAvailability(payload?: ReleaseWorkflowCommandPayload, action: "run" | "stop" | "check" | "close" = "check"): CommandAvailability {
    const allowed = gate(action !== "run"); if (!allowed.enabled) return allowed;
    const value = owner.current().workflow;
    if (!payload || !value || !same(payload, controlPayload())) return no;
    if (action === "run") return !value.start && !value.stop && value.review?.phase === "prepared" && value.approved.length > 0
      && !materializationChanged && currentObservation() && observation?.kind === "current"
      && observation.view?.phase === "prepared" && !observation.admissionClosed ? { enabled: true } : no;
    if (action === "stop") return !owner.current().workflowStopBusy && !(value.safety?.admissionClosed && value.safety.callbacksDrained) ? { enabled: true } : no;
    if (action === "close") return !owner.current().workflowControlBusy && !value.pending && !value.stopPending && value.safety?.admissionClosed && value.safety.callbacksDrained ? { enabled: true } : no;
    return { enabled: true };
  }
  function consentPayload(attemptId: string | null, approved: boolean): ReleaseWorkflowConsentCommandPayload | undefined {
    const value = owner.current().workflow;
    return value?.review?.materializationDigest ? { kind: "release-workflow-consent", identity: structuredClone(value.request.preparation.identity),
      materializationDigest: value.review.materializationDigest, attemptId, approved } : undefined;
  }
  function consentAvailability(payload?: ReleaseWorkflowConsentCommandPayload): CommandAvailability {
    const allowed = gate(); if (!allowed.enabled) return allowed;
    const value = owner.current().workflow;
    return payload && value?.review && !value.start && !value.stop && value.review.phase === "prepared"
      && !materializationChanged && currentObservation() && observation?.kind === "current" && observation.view?.phase === "prepared" && !observation.admissionClosed
      && same(payload, consentPayload(payload.attemptId, payload.approved))
      && (payload.attemptId === null || value.review.steps.some(item => item.step.attemptId === payload.attemptId)) ? { enabled: true } : no;
  }
  function cancellation(): ExecutionCancellationCommandPayload | undefined {
    return task ? { kind: "execution-cancellation", origin: "release", taskId: task.taskId, attemptId: task.attemptId } : undefined;
  }
  function cancelAvailability(payload?: ExecutionCancellationCommandPayload): CommandAvailability {
    const allowed = gate(true); if (!allowed.enabled) return allowed;
    return payload && task && same(payload, cancellation()) && tasks.canCancel(payload) ? { enabled: true } : no;
  }
  function retryAvailability(payload?: ExecutionCancellationRetryCommandPayload,retry=true): CommandAvailability {
    const allowed = gate(true); if (!allowed.enabled) return allowed;
    const value = payload && tasks.current(payload.taskId);
    return payload && value?.phase === "unknown" && (!retry || value.retryAllowed) && value.target.origin === "release" && value.target.attemptId === payload.attemptId
      && value.request.requestId === payload.requestId && task?.taskId === payload.taskId && task.attemptId === payload.attemptId ? { enabled: true } : no;
  }
  useLayoutEffect(() => {
    const meta = { category: "release" as const, scope, binding: null, confirmation: "none" as const };
    const remove = [
      registry.register({ ...meta, id: "release.prepare-check-workflow", nameKey: "releaseWorkflow.prepare", risk: "captures-release", payloadKind: "release-workflow-prepare",
        availability: prepareAvailability, handler: () => { if (detail) void owner.prepareWorkflow(detail, readProof()); } }),
      registry.register({ ...meta, id: "release.confirm-workflow-checker", nameKey: "releaseWorkflow.consent", risk: "captures-release", payloadKind: "release-workflow-consent",
        availability: consentAvailability, handler: payload => owner.setWorkflowConsent(payload.attemptId, payload.approved) }),
      registry.register({ ...meta, id: "release.run-check-workflow", nameKey: "releaseWorkflow.run", risk: "runs-release-build", confirmation: "required", payloadKind: "release-workflow",
        availability: payload => controlAvailability(payload, "run"), handler: () => { void owner.startWorkflow(); } }),
      registry.register({ ...meta, id: "release.stop-check-workflow", nameKey: "releaseWorkflow.stop", risk: "reconciles-release", payloadKind: "release-workflow",
        availability: payload => controlAvailability(payload, "stop"), handler: () => { void owner.stopWorkflow(); } }),
      registry.register({ ...meta, id: "release.check-check-workflow", nameKey: "releaseWorkflow.refresh", risk: "reconciles-release", payloadKind: "release-workflow",
        availability: payload => controlAvailability(payload), handler: () => { void owner.reconcileWorkflow(); } }),
      registry.register({ ...meta, id: "release.close-check-workflow", nameKey: "releaseWorkflow.close", risk: "captures-release", payloadKind: "release-workflow",
        availability: payload => controlAvailability(payload, "close"), handler: () => { owner.closeWorkflow(); } }),
      registry.register({ ...meta, id: "release.cancel-workflow-task", nameKey: "execution.cancel", risk: "cancels-execution-task", payloadKind: "execution-cancellation",
        availability: cancelAvailability, handler: payload => { void tasks.cancel(payload); } }),
      registry.register({ ...meta, id: "release.retry-workflow-cancellation", nameKey: "execution.retryCancellation", risk: "retries-execution-action", payloadKind: "execution-cancellation-retry",
        availability: retryAvailability, handler: payload => { void tasks.retry(payload.taskId); } }),
      registry.register({ ...meta, id: "release.check-workflow-cancellation", nameKey: "execution.checkCancellation", risk: "reads-execution", payloadKind: "execution-cancellation-retry",
        availability: payload => retryAvailability(payload,false), handler: payload => { void tasks.checkCancellation(payload.taskId); } }),
    ];
    return () => remove.forEach(dispose => dispose());
  });
  function dispatchControl(id: "release.run-check-workflow" | "release.stop-check-workflow" | "release.check-check-workflow" | "release.close-check-workflow") {
    const payload = controlPayload(); if (payload) registry.dispatch(id, scope, payload);
  }
  if (!detail && !capture) return null;
  const allApproved = !!capture?.review?.steps.length && capture.review.steps.every(item => capture.approved.includes(item.step.attemptId));
  return <section aria-label={t("releaseWorkflow.title")}>
    <h4>{t("releaseWorkflow.title")}</h4><p>{t("releaseWorkflow.help")}</p>
    {!capture ? <button className="secondary-button" disabled={!prepareAvailability(preparePayload()).enabled} onClick={() => {
      const payload = preparePayload(); if (payload) registry.dispatch("release.prepare-check-workflow", scope, payload);
    }}>{t("releaseWorkflow.prepare")}</button> : <>
      {!capture.review && !capture.stop && !capture.safety?.admissionClosed && !status.error
        && (observation?.view?.phase === "preparing" || capture.pending === "prepare" && !capture.uncertain && !owner.failure)
        ? <p role="status">{t("releaseWorkflow.materializing")}</p> : null}
      {capture.pending || capture.stopPending ? <p role="status">{t("releaseWorkflow.pending")}</p> : null}
      {status.error ? <div role="alert" ref={errorRegion} tabIndex={-1}><p>{t("releaseWorkflow.readFailed")}</p><CommandFailureDetails failure={commandFailure(status.error)}/></div> : null}
      {materializationChanged ? <p role="alert">{t("releaseWorkflow.readFailed")}</p> : null}
      {observation?.view ? <p role="status">{t(`releaseWorkflow.phase.${observation.view.phase}`)}</p> : null}
      {observation?.view?.error ? <CommandFailureDetails failure={observation.view.error}/> : null}
      {observation && observation.kind !== "current" ? <p role="status">{t("releaseWorkflow.retired")}</p> : null}
      {capture.review && !capture.start && !capture.stop && (!observation || observation.kind === "current") ? <label><input type="checkbox" checked={allApproved}
        disabled={!consentAvailability(consentPayload(null, !allApproved)).enabled} onChange={event => { const payload = consentPayload(null, event.target.checked); if (payload) registry.dispatch("release.confirm-workflow-checker", scope, payload); }}/>{t("releaseWorkflow.consentAll")}</label> : null}
      {view?.steps.length ? <ol>{view.steps.map(item => {
        const historical = !!observation && observation.view === null;
        const originalResult = historical ? observation.steps.find(result => result.step.attemptId === item.step.attemptId) : undefined;
        const proof = historical ? originalResult?.proof ?? null : item.proof;
        return <li key={item.step.attemptId}>
        <h5>{item.step.locale}</h5>{!historical ? <p>{t(`releaseWorkflow.step.${item.phase}`)}</p>
          : originalResult ? <p>{originalResult.execution ? t(`execution.states.${originalResult.execution}`)
            : t(originalResult.outcome === "not-enqueued" ? "releaseWorkflow.step.not-started" : "releaseWorkflow.step.waiting")}</p> : null}
        <ul>{item.review.artifacts.map(artifact => <li key={artifact.id}>{artifact.logicalPath} · {t("releasePlugin.bytes", { count: artifact.byteLength })}<details><summary>{t("source.fingerprint")}</summary><code>{artifact.sha256}</code></details></li>)}</ul>
        <BuildExecutionReview build={item.review.build} checker/>
        <details><summary>{t("sourcePlugin.fixedDetails")}</summary><dl>
          <dt>{t("releaseWorkflow.input")}</dt><dd><code>{item.step.inputDigest}</code></dd>
          <dt>{t("releaseWorkflow.buildResult")}</dt><dd><code>{item.step.buildResultId}</code></dd>
        </dl></details>
        {!historical && !capture.start && !capture.stop ? <label><input type="checkbox" checked={capture.approved.includes(item.step.attemptId)}
          disabled={!consentAvailability(consentPayload(item.step.attemptId, true)).enabled} onChange={event => { const payload = consentPayload(item.step.attemptId, event.target.checked); if (payload) registry.dispatch("release.confirm-workflow-checker", scope, payload); }}/>{t("releaseWorkflow.consentFor", { defaultValue: enUS.releaseWorkflow.consentFor, locale: item.step.locale })}</label> : null}
        {proof ? <p>{t(proof.valid ? "releaseWorkflow.proofPassed" : proof.checks === null ? "releaseWorkflow.proofUnavailable" : "releaseWorkflow.proofFailed")}</p> : null}
        {proof?.checks ? <details><summary>{t("execution.diagnostic")}</summary><pre>{JSON.stringify(proof.checks, null, 2)}</pre></details> : null}
        {item.error ? <CommandFailureDetails failure={item.error}/> : null}
      </li>; })}</ol> : null}
      {!capture.start && !capture.stop ? <button className="primary-button" disabled={!controlAvailability(controlPayload(), "run").enabled} onClick={() => dispatchControl("release.run-check-workflow")}>{t("releaseWorkflow.run")}</button> : null}
      <button className="secondary-button" disabled={!controlAvailability(controlPayload(), "stop").enabled} onClick={() => dispatchControl("release.stop-check-workflow")}>{t("releaseWorkflow.stop")}</button>
      <p>{t("releaseWorkflow.stopHelp")}</p>
      {task ? <section aria-label={t("releaseWorkflow.currentTask")}><p>{t("releaseWorkflow.currentTask")} · {view?.steps.find(item => item.step.attemptId === task.attemptId)?.step.locale}</p><details><summary>{t("execution.diagnostic")}</summary><code>{task.taskId}</code></details><button disabled={!cancelAvailability(cancellation()).enabled} onClick={() => { const payload = cancellation(); if (payload) registry.dispatch("release.cancel-workflow-task", scope, payload); }}>{t("execution.cancel")}</button>
        <TaskCancellationFeedback origin="release" taskId={task.taskId} visible={open} disabled={owner.busy} retryCommand={{ available: intent => retryAvailability({ ...intent, kind: "execution-cancellation-retry" }).enabled,
          dispatch: intent => { registry.dispatch("release.retry-workflow-cancellation", scope, { ...intent, kind: "execution-cancellation-retry" }); } }} checkCommand={{available:intent=>retryAvailability({...intent,kind:"execution-cancellation-retry"},false).enabled,
            dispatch:intent=>{registry.dispatch("release.check-workflow-cancellation",scope,{...intent,kind:"execution-cancellation-retry"});}}}/></section> : null}
      {capture.safety?.admissionClosed && !capture.safety.callbacksDrained ? <p role="status">{t("releaseWorkflow.draining")}</p> : null}
      <button className="secondary-button" disabled={!controlAvailability(controlPayload()).enabled} onClick={() => dispatchControl("release.check-check-workflow")}>{t("releaseWorkflow.refresh")}</button>
      <button className="text-button" disabled={!controlAvailability(controlPayload(), "close").enabled} onClick={() => dispatchControl("release.close-check-workflow")}>{t("releaseWorkflow.close")}</button>
      <p>{t("releaseWorkflow.manualRelease")}</p>
    </>}
  </section>;
}
