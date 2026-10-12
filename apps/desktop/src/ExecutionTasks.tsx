import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { TaskCancellationFeedback, useExecutionTaskSession, type CancellationTarget } from "./ExecutionTaskSession";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import type { ProjectView } from "./projectCommands";
import { executionCommands as commands, executionContext, type AttemptDetail, type AttemptSummary, type RecoveryAction, type RecoveryUnit, type Receipt, type RuntimeStatus, type Task, type ResultEnvelope } from "./executionCommands";

type Confirmation = { action: RecoveryAction | "cancel"; unit?: RecoveryUnit; itemId?: string; cancellation?: CancellationTarget };
export interface TasksHandle { allowLeave: () => Promise<boolean>; allowNavigate: () => Promise<boolean> }
export function ExecutionTasks({ project, disabled, onSourcePreview, onTranslationPreview, onAiPreview, onArenaPreview, ref }: { project: ProjectView; disabled: boolean; onSourcePreview?: (id: string) => void; onTranslationPreview?: (id: string) => void; onArenaPreview?: (id: string) => void; onAiPreview?: (id: string) => void; ref?: Ref<TasksHandle> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useWorkbenchView("tasks");
  const cancellations = useExecutionTaskSession();
  const [dismissBlocked, setDismissBlocked] = useState(false);
  const [visited, setVisited] = useState(false);
  useEffect(() => { if (open) setVisited(true); }, [open]);
  useImperativeHandle(ref, () => ({ allowNavigate: () => Promise.resolve(true), allowLeave: () => {
    if (cancellations.unresolved()) { setVisited(true); setOpen(true); return Promise.resolve(false); }
    return Promise.resolve(!dismissBlocked);
  } }));
  return <WorkbenchPanel open={open} title={t("execution.title")} description={project.metadata.displayName}
    onBack={() => setOpen(false)} backDisabled={disabled}>
    {visited ? <TaskContent active={open} disabled={disabled} onArenaPreview={id => { setOpen(false); onArenaPreview?.(id); }} onAiPreview={id => { setOpen(false); onAiPreview?.(id); }} key={project.sessionToken} project={project} onDismissBlockedChange={setDismissBlocked} onSourcePreview={id => { setOpen(false); onSourcePreview?.(id); }} onTranslationPreview={id => { setOpen(false); onTranslationPreview?.(id); }} /> : null}
  </WorkbenchPanel>;
}

export function TaskContent({ project, active = true, disabled = false, onDismissBlockedChange, onSourcePreview, onTranslationPreview, onAiPreview, onArenaPreview }: { project: ProjectView; active?: boolean; disabled?: boolean; onDismissBlockedChange?: (blocked: boolean) => void; onSourcePreview?: (id: string) => void; onTranslationPreview?: (id: string) => void; onArenaPreview?: (id: string) => void; onAiPreview?: (id: string) => void }) {
  const { t } = useTranslation();
  const context = executionContext(project);
  const cancellations = useExecutionTaskSession();
  const [taskId, setTaskId] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [cursor, setCursor] = useState("0");
  const [attemptCursor, setAttemptCursor] = useState("0");
  const [offset, setOffset] = useState(0);
  const busy = cancellations.busy;
  const activity = cancellations.activity;
  const pendingAction = activity?.phase === "unknown" || cancellations.busy ? activity : null;
  const [showOwnerDialog, setShowOwnerDialog] = useState(true);
  const [failureValue, setFailure] = useState<CommandFailure | null>(null);
  const [message, setMessage] = useState<"done" | "noReceipt" | "queryStarted" | null>(null);
  const [localConfirmation, setConfirmation] = useState<Confirmation | null>(null);
  const ownerConfirmation = activity && showOwnerDialog && activity.phase !== "recorded" && activity.phase !== "rejected"
    ? { action: activity.intent.action, unit: activity.intent.unit, itemId: activity.intent.itemId } : null;
  const confirmation: Confirmation | null = localConfirmation ?? ownerConfirmation;
  const [outputSelection, setOutput] = useState<{ attemptId: string; itemId: string; resultId: string } | null>(null);
  const [receiptSelection, setReceipt] = useState<{ attemptId: string; unitId: string; actionId: string } | null>(null);

  const actionTrigger = useRef<HTMLElement | null>(null);
  const outputRegion = useRef<HTMLDivElement | null>(null);
  useEffect(() => { onDismissBlockedChange?.(busy || cancellations.unresolved()); return () => onDismissBlockedChange?.(false); }, [busy, activity, cancellations.state, onDismissBlockedChange]);
  function confirm(choice: Confirmation) {
    actionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFailure(null); setMessage(null); setShowOwnerDialog(true);
    if (choice.action === "cancel" && detail) setConfirmation({ ...choice, cancellation: { taskId: detail.taskId, attemptId: detail.attemptId, origin: "tasks" } });
    else if (detail && choice.unit && choice.action !== "view-receipt" && choice.action !== "cancel")
      void cancellations.begin(detail, choice.unit, choice.action, offset, choice.itemId);
  }
  function closeConfirmation() {
    setConfirmation(null); setShowOwnerDialog(false); cancellations.dismiss();
  }
  function showError(error: unknown) {
    setFailure(commandFailure(error,"storage-failed"));
  }
  const reads = useSessionReads();
  const projection = useSessionQuery<{ runtime: RuntimeStatus; tasks: Task[]; attempts: AttemptSummary[]; detail: AttemptDetail | null }>({
    key: ["tasks", taskId, attemptId, cursor, attemptCursor, offset], scopes: ["execution", "source", "translation", "release"], enabled: active && !busy,
    read: async () => {
      const status = () => reads.client.getQueryData<RuntimeStatus>(reads.key(["runtime"])) ?? commands.status(context);
      if (!taskId) {
        const [runtime, tasks] = await Promise.all([status(), commands.list({ ...context, after: cursor, limit: 50 })]);
        return { runtime, tasks, attempts: [], detail: null };
      }
      const [runtime, attempts] = await Promise.all([status(), commands.task({ ...context, taskId, after: attemptCursor, limit: 100 })]);
      const selected = attemptId ?? attempts.at(-1)?.attemptId;
      const detail = selected ? await commands.attempt({ ...context, attemptId: selected, offset, limit: 100 }) : null;
      return { runtime, tasks: [], attempts, detail };
    },
  });
  const tasks = projection.data?.tasks ?? [], attempts = projection.data?.attempts ?? [], detail = projection.data?.detail ?? null;
  const cancelTarget: CancellationTarget | null = detail ? { taskId: detail.taskId, attemptId: detail.attemptId, origin: "tasks" } : null;
  const cancellation = confirmation?.cancellation ? cancellations.current(confirmation.cancellation.taskId) : undefined;
  const cancelling = cancellation?.phase === "preparing" || cancellation?.phase === "pending";
  useEffect(() => { if (cancellation?.phase === "recorded" || cancellation?.phase === "rejected") setConfirmation(null); }, [cancellation]);
  const loading = projection.isPending && active && !busy;
  useEffect(() => { const error = projection.error ?? projection.data?.runtime.error; if (error) showError(error); }, [projection.error, projection.data?.runtime.error]);

  function selectTask(id: string | null) {
    setTaskId(id); setAttemptId(null); setAttemptCursor("0"); setOffset(0); setOutput(null); setReceipt(null); setFailure(null);
  }
  async function execute(choice: Confirmation) {
    if (choice.action === "cancel") {
      if (!choice.cancellation || disabled || busy || pendingAction || !cancellations.canCancel(choice.cancellation)) return;
      await cancellations.cancel(choice.cancellation);
      return;
    }
    if (disabled) return;
    if (choice.action === "view-receipt" && choice.unit?.receiptId && detail) {
      setReceipt({ attemptId: detail.attemptId, unitId: choice.unit.unitId, actionId: choice.unit.receiptId });
      return;
    }
    await cancellations.submit();
  }
  const recovered = activity?.phase === "recorded" ? activity.recovery : null;
  useEffect(() => {
    if (recovered && activity) {
      setTaskId(activity.intent.taskId);
      setAttemptId(recovered.attemptId); setOffset(0); setOutput(null); setReceipt(null);
      setMessage(recovered.queryStarted ? "queryStarted" : "done");
    }
  }, [recovered]);
  const outputQuery = useSessionQuery<ResultEnvelope>({ key: ["task-output", outputSelection], scopes: ["execution"], enabled: active && outputSelection !== null,
    read: async () => {
      if (!outputSelection) throw new Error("No task output selected");
      const result = await commands.output({ ...context, attemptId: outputSelection.attemptId, resultId: outputSelection.resultId });
      // A reused result retains the source attempt identity; Host authorizes its association.
      if (result.projectId !== context.projectId || result.resultId !== outputSelection.resultId || result.itemId !== outputSelection.itemId) throw new Error("Invalid task output association");
      return result;
    } });
  const receiptQuery = useSessionQuery<Receipt | null>({ key: ["task-receipt", receiptSelection], scopes: ["execution"], enabled: active && receiptSelection !== null,
    read: async () => {
      if (!receiptSelection) throw new Error("No task receipt selected");
      const result = await commands.receipt({ ...context, actionId: receiptSelection.actionId });
      if (result && (result.projectId !== context.projectId || result.attemptId !== receiptSelection.attemptId
        || result.unitId !== receiptSelection.unitId || result.actionId !== receiptSelection.actionId)) throw new Error("Invalid task receipt association");
      return result;
    } });
  const output = outputQuery.data ?? null;
  const shownReceipt = receiptSelection ? receiptQuery.data : activity?.phase === "recorded" ? activity.receipt : null;
  useEffect(() => { if (output) { outputRegion.current?.focus(); outputRegion.current?.scrollIntoView?.({ block: "nearest" }); } }, [output]);
  useEffect(() => { const error = outputQuery.error ?? receiptQuery.error; if (error) showError(error); }, [outputQuery.error, receiptQuery.error]);
  const ownerFailure = activity?.failure ?? null;
  const displayedFailure = ownerFailure ?? failureValue;
  const displayedCode = typeof displayedFailure === "string" ? displayedFailure : displayedFailure?.code ?? null;
  const errorKey = displayedCode === "dependency-conflict" ? "conflict" : displayedCode === "outcome-unknown" ? "unknown" : displayedCode === "session-invalid" ? "session" : displayedCode === "cancelled" ? "cancelled" : displayedCode === "output-invalid" ? "invalid" : displayedCode === "busy" ? "busy" : "failed";
  const errorRegion = useRef<HTMLDivElement>(null);
  useEffect(() => { if (active && displayedFailure) errorRegion.current?.focus(); }, [active, displayedFailure]);
  const feedback = <><TaskCancellationFeedback origin="tasks" taskId={taskId ?? undefined} disabled={busy || pendingAction !== null} visible={active} />
    {displayedFailure ? <div role="alert" tabIndex={-1} ref={errorRegion}><p>{t(`execution.errors.${errorKey}`)}</p><CommandFailureDetails failure={displayedFailure} /></div> : null}
    {activity?.phase === "capturing" ? <p role="status">{t("execution.capturing")}</p> : null}
    {activity?.phase === "unknown" ? <section aria-label={t("execution.originalAction")}>
      <p role="status">{t(activity.intent.action === "adopt-result" ? "execution.adoptionUnknown" : "execution.recoveryUnknown")}</p>
      <ul>{activity.intent.unit.scopes.map((scope, index) => <li key={activity.intent.unit.itemIds[index]}>{scope.id}{scope.locale ? ` · ${scope.locale}` : ""}</li>)}</ul>
      <details><summary>{t("execution.diagnostic")}</summary><pre>{JSON.stringify({ taskId: activity.intent.taskId, operation: activity.intent.operation,
        unit: activity.intent.unit, request: activity.prepare ?? activity.recoveryRequest }, null, 2)}</pre></details>
      {activity.prepare ? <div className="execution-actions">
        <button className="secondary-button" disabled={busy || disabled} onClick={() => void cancellations.checkAdoption()}>{t("execution.checkReceipt")}</button>
        {activity.retryAllowed ? <><p role="status">{t("execution.noReceipt")}</p><button className="secondary-button" disabled={busy || disabled} onClick={() => void cancellations.retryAdoption()}>{t("execution.retryAdoption")}</button></> : null}
      </div> : null}
      <button className="text-button" disabled={busy} onClick={() => { setConfirmation(null); setShowOwnerDialog(false); }}>{t("execution.keepOutput")}</button>
    </section> : null}
    {activity?.phase === "recorded" && activity.receipt ? <p role="status">{t("execution.adoptionRecorded")}</p> : message ? <p role="status">{t(`execution.${message}`)}</p> : null}</>;
  const titleFor = (action: Confirmation["action"]) => action === "cancel" ? t("execution.cancel") : t(`execution.actions.${action}`);
  const confirmationCount = confirmation?.itemId ? 1 : confirmation?.unit?.itemIds.length ?? 0;
  const blockedKey = (reason: string) => reason === "external-new-consent" ? "externalConsent" : reason === "outcome-unknown" ? "unknown" : reason === "scope-removed" ? "scopeRemoved" : reason === "output-invalid" ? "invalid" : reason === "retry-not-safe" ? "retryUnsafe" : "blocked";
  return <div className="execution-content" aria-busy={busy || cancelling || loading}>
    {!confirmation ? feedback : null}
    <div className="execution-actions">
      {taskId ? <button className="secondary-button" disabled={busy || pendingAction !== null} onClick={() => selectTask(null)}>{t("execution.allTasks")}</button> : null}
      <button className="secondary-button" disabled={busy} onClick={() => reads.invalidate(["execution"], false)}>{t("execution.refresh")}</button>
    </div>
    {loading ? <p role="status">{t("execution.loading")}</p> : null}
    {!taskId ? <>
      {!loading && tasks.length === 0 ? <p>{t("execution.empty")}</p> : null}
      {tasks.length > 0 ? <p>{t("execution.listHelp")}</p> : null}
      <ul className="execution-list">{tasks.map(task => <li key={task.taskId}>
        <button className="secondary-button" onClick={() => selectTask(task.taskId)} disabled={busy}>
          {t(task.operation === "source-import" ? "source.title" : task.operation === "translation-import" ? "translation.title" : task.operation === "ai-translation" ? "ai.title" : task.operation === "locale-build" ? "release.title" : task.operation === "sample-update" ? "execution.sampleOperation" : "execution.operation")} · {t("execution.taskNumber", { number: task.sequence })}
        </button>
      </li>)}</ul>
      {cursor !== "0" || tasks.length === 50 ? <div className="execution-actions">
        <button className="text-button" disabled={cursor === "0" || busy} onClick={() => setCursor("0")}>{t("execution.firstPage")}</button>
        <button className="text-button" disabled={tasks.length < 50 || busy} onClick={() => setCursor(tasks.at(-1)!.sequence)}>{t("execution.nextPage")}</button>
      </div> : null}
    </> : <>
      <label className="field execution-attempt">{t("execution.attempt")}
        <select disabled={busy || pendingAction !== null} value={attemptId ?? detail?.attemptId ?? ""} onChange={event => {
          setAttemptId(event.target.value); setOffset(0); setOutput(null); setReceipt(null);
        }}>
          {attempts.map(attempt => <option key={attempt.attemptId} value={attempt.attemptId}>{t("execution.attemptNumber", { number: attempt.sequence })}</option>)}
          {detail && !attempts.some(attempt => attempt.attemptId === detail.attemptId) ? <option value={detail.attemptId}>{t("execution.currentAttempt")}</option> : null}
        </select>
      </label>
      {attemptCursor !== "0" || attempts.length === 100 ? <div className="execution-actions">
        <button className="text-button" disabled={attemptCursor === "0" || busy || pendingAction !== null} onClick={() => { setAttemptCursor("0"); setAttemptId(null); }}>{t("execution.firstPage")}</button>
        <button className="text-button" disabled={attempts.length < 100 || busy || pendingAction !== null} onClick={() => { setAttemptCursor(attempts.at(-1)!.sequence); setAttemptId(null); }}>{t("execution.nextPage")}</button>
      </div> : null}
      {detail ? <>
        <section className="execution-summary" aria-label={t("execution.summary")}>
          <strong>{t("execution.progress", { generated: detail.progress.succeeded, adopted: detail.progress.adopted, total: detail.progress.total })}</strong>
          <p>{t("execution.statusCounts", { failed: detail.progress.failed, unknown: detail.progress.unknown, running: detail.progress.running, queued: detail.progress.queued, cancelled: detail.progress.cancelled })}</p>
          <small>{t("execution.applicationHelp")}</small>
        </section>
        <section aria-label={t("execution.nextSteps")}>
          <div className="execution-section-heading"><h3>{t("execution.nextSteps")}</h3>
            <button className="text-button" disabled={disabled || busy || pendingAction !== null || !cancelTarget || !cancellations.canCancel(cancelTarget)} onClick={() => confirm({ action: "cancel" })}>{t("execution.cancel")}</button>
          </div>
          {detail.recovery.units.map(unit => <section className="execution-unit" key={unit.unitId}>
            <details><summary>{t("execution.groupScope", { count: unit.itemIds.length })}</summary>
              <ul>{unit.scopes.map((scope, index) => <li key={unit.itemIds[index]}>{scope.id}{scope.locale ? ` · ${scope.locale}` : ""}</li>)}</ul>
            </details>
            {unit.blockedReason ? <p>{t(unit.blockedReason === "continued-in-new-attempt" ? "execution.continued" : unit.blockedReason === "still-running" ? "execution.running" : `execution.errors.${blockedKey(unit.blockedReason)}`)}</p> : null}
            <div className="execution-actions">{unit.actions.map(action => action === "query-outcome" ? unit.remainingItemIds.map(id =>
              <button className="secondary-button" key={id} disabled={disabled || busy || pendingAction !== null || activity?.phase === "confirming"} onClick={() => confirm({ action, unit, itemId: id })}>{t(`execution.actions.${action}`)} · {unit.scopes[unit.itemIds.indexOf(id)]?.id}</button>
            ) : <button className={action === "adopt-result" || action === "retry-safe-failure" || action === "resume-undispatched" ? "primary-button" : "secondary-button"} key={action} disabled={disabled || busy || pendingAction !== null || activity?.phase === "confirming"} onClick={() => {
              if (action === "adopt-result" && detail.operation === "source-import") onSourcePreview?.(detail.attemptId);
              else if (action === "adopt-result" && detail.operation === "translation-import") onTranslationPreview?.(detail.attemptId);
              else if (action === "adopt-result" && detail.operation === "arena-translation") onArenaPreview?.(detail.attemptId); else if (action === "adopt-result" && detail.operation === "ai-translation") onAiPreview?.(detail.attemptId); else if (action === "view-receipt") void execute({ action, unit }); else confirm({ action, unit });
            }}>{t(action === "adopt-result" && detail.operation === "source-import" ? "source.preview" : action === "adopt-result" && detail.operation === "translation-import" ? "translation.preview" : `execution.actions.${action}`)}</button>)}</div>
          </section>)}
        </section>
        <h3>{t("execution.itemResults")}</h3>{detail.operation === "arena-translation" ? <button className="secondary-button" disabled={busy || pendingAction !== null} onClick={() => onArenaPreview?.(detail.attemptId)}>{t("arena.open")}</button> : null}{detail.operation === "ai-translation" ? <button className="secondary-button" disabled={busy || pendingAction !== null} onClick={() => onAiPreview?.(detail.attemptId)}>{t("ai.results")}</button> : null}
        {detail.operation === "source-import" && detail.items.some(item => item.status.validation === "valid") ? <button className="secondary-button" disabled={busy || pendingAction !== null} onClick={() => onSourcePreview?.(detail.attemptId)}>{t("source.preview")}</button> : null}
        {detail.operation === "translation-import" && detail.items.some(item => item.status.validation === "valid") ? <button className="secondary-button" disabled={busy || pendingAction !== null} onClick={() => onTranslationPreview?.(detail.attemptId)}>{t("translation.preview")}</button> : null}
        <ul className="execution-list">{detail.items.map(item => <li key={item.status.itemId}>
          <div className="execution-item-heading"><strong>{item.scope.id}{item.scope.locale ? ` · ${item.scope.locale}` : ""}</strong>
            {item.resultId ? <button className="text-button" disabled={busy} onClick={() => setOutput({ attemptId: detail.attemptId, itemId: item.status.itemId, resultId: item.resultId! })}>{t(item.status.execution === "succeeded" ? "execution.output" : "execution.failureDetails")}</button> : null}
          </div>
          <p>{t(`execution.states.${item.status.execution}`)} · {t(`execution.adoption.${item.status.adoption}`)}</p>
          {item.status.validation === "invalid" ? <p>{t("execution.errors.invalid")}</p> : null}
          {item.status.cancellationRequested ? <small>{t("execution.cancellationRequested")}</small> : null}
          {output?.itemId === item.status.itemId && output.resultId === item.resultId ? <div className="execution-result" ref={outputRegion} tabIndex={-1} role="region" aria-label={t("execution.resultFor", { name: item.scope.id })}>
            <h4>{t("execution.resultFor", { name: item.scope.id })}</h4>
            {output.output !== null ? detail.operation === "locale-build" ? <p>{t("release.outputSummary", {
              file: (output.output as { fileName: string }).fileName,
              count: (output.output as { entryCount: number }).entryCount,
              digest: (output.output as { sha256: string }).sha256,
            })}</p> : <pre className="execution-output">{JSON.stringify(output.output, null, 2)}</pre> : <p>{t("execution.noOutput")}</p>}
            {output.diagnostic ? <><p>{t(output.diagnostic.retrySafe ? "execution.safeFailure" : "execution.unsafeFailure")}</p>
              <details><summary>{t("execution.diagnostic")}</summary><code>{output.diagnostic.code}</code></details></> : null}
          </div> : null}
        </li>)}</ul>
        {offset > 0 || detail.nextOffset !== null ? <div className="execution-actions">
          <button className="text-button" disabled={offset === 0 || busy} onClick={() => { setOffset(Math.max(0, offset - 100)); setOutput(null); }}>{t("execution.previousPage")}</button>
          <button className="text-button" disabled={detail.nextOffset === null || busy} onClick={() => { setOffset(detail.nextOffset!); setOutput(null); }}>{t("execution.nextPage")}</button>
        </div> : null}
      </> : null}
    </>}
    {shownReceipt ? <section className="execution-receipt" role="status"><h3>{t("execution.receipt")}</h3>{shownReceipt.changes.length === 0 ? <p>{t("execution.noChanges")}</p> : <ul>{shownReceipt.changes.map((change, index) => <li key={`${index}:${change.kind}:${change.id}`}>{change.id} · {t("execution.revision", { number: change.revision })}</li>)}</ul>}</section> : null}
    <Dialog.Root open={active && confirmation !== null} onOpenChange={open => { if (!open && !busy && !cancelling) closeConfirmation(); }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop" />
        <Dialog.Content className="confirm-dialog execution-confirm-dialog" onCloseAutoFocus={event => { event.preventDefault(); actionTrigger.current?.focus(); }} onEscapeKeyDown={event => { if (busy || cancelling) event.preventDefault(); }} onPointerDownOutside={event => event.preventDefault()}>
          <Dialog.Title>{confirmation ? titleFor(confirmation.action) : t("execution.nextSteps")}</Dialog.Title>
          <Dialog.Description>{confirmation?.action === "cancel" ? t("execution.cancelHelp") : confirmation ? t(`execution.actionHelp.${confirmation.action}`, {
            count: confirmationCount, remaining: confirmation.unit?.remainingItemIds.length ?? 0,
            reused: (confirmation.unit?.itemIds.length ?? 0) - (confirmation.unit?.remainingItemIds.length ?? 0),
          }) : null}</Dialog.Description>
          <ul>{confirmation?.unit?.scopes.map((scope, index) => !confirmation.itemId || confirmation.unit?.itemIds[index] === confirmation.itemId ? <li key={index}>
            {scope.id}{scope.locale ? ` · ${scope.locale}` : ""}
            {confirmation.action === "resume-undispatched" || confirmation.action === "retry-safe-failure" ? <small> · {t(confirmation.unit!.remainingItemIds.includes(confirmation.unit!.itemIds[index]) ? "execution.willRun" : "execution.reuse")}</small> : null}
          </li> : null)}</ul>
          {feedback}
          <div className="form-actions"><button className="secondary-button" disabled={busy || cancelling} onClick={closeConfirmation}>{t("execution.back")}</button>
            <button className="primary-button" disabled={disabled || busy || cancelling || pendingAction !== null || (ownerConfirmation !== null && activity?.phase !== "confirming") || (confirmation?.action === "cancel" && (disabled || !confirmation.cancellation || !cancellations.canCancel(confirmation.cancellation)))} onClick={() => { if (confirmation) void execute(confirmation); }}>{busy || cancelling ? t("execution.working") : confirmation ? titleFor(confirmation.action) : t("execution.confirm")}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
