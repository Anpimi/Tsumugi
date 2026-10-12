import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import type { CommandError, ProjectView } from "./projectCommands";
import { projectCommands, hasUnknownOutcome } from "./projectCommands";
import { releaseCommands } from "./releaseCommands";
import { SavedPluginBuildSummary } from "./SavedPluginBuildSummary";
import { executionCommands as commands, executionContext, matchesContinuation, type AttemptDetail, type AttemptSummary, type RecoveryAction, type RecoveryUnit, type Receipt, type RuntimeStatus, type Task, type PrepareRequest, type ResultEnvelope, type ContinuationRequest, type ContinuationReceipt, type ContinuationPage } from "./executionCommands";

type Confirmation = { action: RecoveryAction | "cancel"; unit?: RecoveryUnit; itemId?: string; sourceAttemptId?: string; task?: Task };
type PendingContinuation = { request: ContinuationRequest; taskId: string; operation: string; checked: boolean; unconfirmed: boolean };
export interface TasksHandle { allowLeave: () => Promise<boolean> }
export function ExecutionTasks({ project, disabled, onSourcePreview, onTranslationPreview, onAiPreview, onArenaPreview, onSavedBuild, ref }: { project: ProjectView; disabled: boolean; onSourcePreview?: (id: string) => void; onTranslationPreview?: (id: string) => void; onArenaPreview?: (id: string) => void; onAiPreview?: (id: string) => void; onSavedBuild?: (id: string) => boolean; ref?: Ref<TasksHandle> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useWorkbenchView("tasks");
  const [dismissBlocked, setDismissBlocked] = useState(false);
  const dismissBlockedRef = useRef(false);
  const reportDismissBlocked = useCallback((blocked: boolean) => { dismissBlockedRef.current = blocked; setDismissBlocked(blocked); }, []);
  const leaveBlocked = useRef(false);
  const reportLeaveBlocked = useCallback((blocked: boolean) => { leaveBlocked.current = blocked; }, []);
  const [visited, setVisited] = useState(false);
  useEffect(() => { if (open) setVisited(true); }, [open]);
  useImperativeHandle(ref, () => ({ allowLeave: () => Promise.resolve(!leaveBlocked.current) }));
  return <WorkbenchPanel open={open} title={t("execution.title")} description={project.metadata.displayName}
    onBack={() => { if (!disabled && !dismissBlockedRef.current) setOpen(false); }} backDisabled={disabled || dismissBlocked}>
    {visited ? <TaskContent active={open} disabled={disabled} onSavedBuild={onSavedBuild ? id => { const accepted = onSavedBuild(id); if (accepted) setOpen(false); return accepted; } : undefined} onArenaPreview={id => { setOpen(false); onArenaPreview?.(id); }} onAiPreview={id => { setOpen(false); onAiPreview?.(id); }} key={`${project.metadata.projectId}:${project.sessionToken}`} project={project} onDismissBlockedChange={reportDismissBlocked} onLeaveBlockedChange={reportLeaveBlocked} onSourcePreview={id => { setOpen(false); onSourcePreview?.(id); }} onTranslationPreview={id => { setOpen(false); onTranslationPreview?.(id); }} /> : null}
  </WorkbenchPanel>;
}

export function TaskContent({ project, active = true, disabled = false, onDismissBlockedChange, onLeaveBlockedChange, onSourcePreview, onTranslationPreview, onAiPreview, onArenaPreview, onSavedBuild }: { project: ProjectView; active?: boolean; disabled?: boolean; onDismissBlockedChange?: (blocked: boolean) => void; onLeaveBlockedChange?: (blocked: boolean) => void; onSourcePreview?: (id: string) => void; onTranslationPreview?: (id: string) => void; onArenaPreview?: (id: string) => void; onAiPreview?: (id: string) => void; onSavedBuild?: (id: string) => boolean }) {
  const { t } = useTranslation();
  const context = executionContext(project);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [cursor, setCursor] = useState("0");
  const [attemptCursor, setAttemptCursor] = useState("0");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failureValue, setFailure] = useState<CommandFailure | null>(null);
  const failure = typeof failureValue === "string" ? failureValue : failureValue?.code ?? null;
  const [message, setMessage] = useState<"done" | "noReceipt" | "queryStarted" | "noContinuation" | "savedBuildBlocked" | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [output, setOutput] = useState<ResultEnvelope | null>(null);
  const [savedOutput, setSavedOutput] = useState<{ attemptId: string; itemId: string; resultId: string } | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [pendingAction, setPendingAction] = useState<PrepareRequest | null>(null);
  const [pendingContinuation, setPendingContinuation] = useState<PendingContinuation | null>(null);
  const [continuationDeferred, setContinuationDeferred] = useState(false);
  const [continuationCursor, setContinuationCursor] = useState("0");
  const [receiptChecked, setReceiptChecked] = useState(false);
  const actionTrigger = useRef<HTMLElement | null>(null);
  const outputRegion = useRef<HTMLDivElement | null>(null);
  useEffect(() => { onDismissBlockedChange?.(busy || pendingAction !== null || (pendingContinuation !== null && !continuationDeferred)); return () => onDismissBlockedChange?.(false); }, [busy, pendingAction, pendingContinuation, continuationDeferred, onDismissBlockedChange]);
  useEffect(() => { onLeaveBlockedChange?.(busy || pendingAction !== null || pendingContinuation !== null); return () => onLeaveBlockedChange?.(false); }, [busy, pendingAction, pendingContinuation, onLeaveBlockedChange]);
  useEffect(() => { if (output || savedOutput) { outputRegion.current?.focus(); outputRegion.current?.scrollIntoView?.({ block: "nearest" }); } }, [output, savedOutput]);
  function confirm(choice: Confirmation) { if (blocked()) return; actionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setFailure(null); setMessage(null); setConfirmation({ ...choice, unit: choice.unit ? structuredClone(choice.unit) : undefined, sourceAttemptId: detail?.attemptId, task: currentTask ? { ...currentTask } : undefined }); }
  const mounted = useRef(true);
  const mutating = useRef(false);
  const life = useRef(0);
  const ownerContext = useRef(context);
  const currentContext = useRef(context); currentContext.current = context;
  const unavailable = useRef(disabled); unavailable.current = disabled;
  const sessionInvalid = useRef(false);
  const pendingActionRef = useRef<PrepareRequest | null>(null);
  const pendingContinuationRef = useRef<PendingContinuation | null>(null);
  const deferredRef = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; life.current++; }; }, []);
  function current(ticket = life.current) {
    return mounted.current && ticket === life.current && currentContext.current.sessionToken === ownerContext.current.sessionToken
      && currentContext.current.projectId === ownerContext.current.projectId;
  }
  function canDispatch(ticket = life.current) { return current(ticket) && !unavailable.current && !sessionInvalid.current; }
  function blocked() { return !canDispatch() || mutating.current || pendingActionRef.current !== null || pendingContinuationRef.current !== null; }
  function reportBlocked() {
    onDismissBlockedChange?.(mutating.current || pendingActionRef.current !== null || (pendingContinuationRef.current !== null && !deferredRef.current));
    onLeaveBlockedChange?.(mutating.current || pendingActionRef.current !== null || pendingContinuationRef.current !== null);
  }
  function retainAction(value: PrepareRequest | null) { pendingActionRef.current = value; setPendingAction(value); reportBlocked(); }
  function retainContinuation(value: PendingContinuation | null) { pendingContinuationRef.current = value; setPendingContinuation(value); reportBlocked(); }
  function deferContinuation(value: boolean) { deferredRef.current = value; setContinuationDeferred(value); reportBlocked(); }

  function showError(error: unknown) {
    const failure = commandFailure(error,"storage-failed");
    if (typeof failure !== "string" && failure.code === "session-invalid") sessionInvalid.current = true;
    if (failure === "session-invalid") sessionInvalid.current = true;
    setFailure(failure);
  }
  const reads = useSessionReads();
  const projection = useSessionQuery<{ runtime: RuntimeStatus; tasks: Task[]; attempts: AttemptSummary[]; detail: AttemptDetail | null; task: Task | null }>({
    key: ["tasks", taskId, attemptId, cursor, attemptCursor, offset], scopes: ["execution", "source", "translation", "release"], enabled: active && !busy,
    read: async () => {
      const status = () => reads.client.getQueryData<RuntimeStatus>(reads.key(["runtime"])) ?? commands.status(context);
      if (!taskId) {
        const [runtime, tasks] = await Promise.all([status(), commands.list({ ...context, after: cursor, limit: 50 })]);
        return { runtime, tasks, attempts: [], detail: null, task: null };
      }
      const [runtime, attempts, task] = await Promise.all([status(), commands.task({ ...context, taskId, after: attemptCursor, limit: 100 }), commands.taskView({ ...context, taskId })]);
      const selected = attemptId ?? attempts.at(-1)?.attemptId;
      const detail = selected ? await commands.attempt({ ...context, attemptId: selected, offset, limit: 100 }) : null;
      return { runtime, tasks: [], attempts, detail, task };
    },
  });
  const tasks = projection.data?.tasks ?? [], attempts = projection.data?.attempts ?? [], detail = projection.data?.detail ?? null;
  const currentTask = projection.data?.task ?? null;
  const selection = useRef({ taskId, attemptId: detail?.attemptId ?? null });
  selection.current = { taskId, attemptId: detail?.attemptId ?? null };
  const continuationHistory = useSessionQuery<ContinuationPage>({
    key: ["execution-continuations", detail?.attemptId ?? null, continuationCursor], scopes: ["execution"], enabled: active && !busy && detail !== null,
    read: async () => {
      if (!detail) throw new Error("No selected execution attempt");
      const selected = detail;
      const page = await commands.continuations({ ...context, sourceAttemptId: selected.attemptId, after: continuationCursor, limit: 50 });
      if (page.receipts.some(record => record.taskId !== selected.taskId || record.operation !== selected.operation)) throw new Error("Invalid continuation task scope");
      return page;
    },
  });
  const loading = projection.isPending && active && !busy;
  const savedOutputRead = useSessionQuery({ key: ["saved-plugin-build-output", savedOutput?.attemptId ?? null, savedOutput?.itemId ?? null, savedOutput?.resultId ?? null],
    scopes: ["execution", "release"], enabled: active && detail?.operation === "locale-build" && !!savedOutput,
    read: async () => {
      if (!detail || !savedOutput) throw new Error("No saved build result selected");
      const selected = detail, expected = savedOutput;
      const saved = await releaseCommands.savedBuild({ ...context, attemptId: selected.attemptId });
      const locale = saved.locales.find(locale => locale.itemId === expected.itemId);
      const item = selected.items.find(item => item.status.itemId === expected.itemId);
      if (saved.taskId !== selected.taskId || expected.attemptId !== selected.attemptId
        || !locale || !item || locale.choice.locale !== item.scope.locale || locale.result?.resultId !== expected.resultId
        || item.resultId !== expected.resultId || locale.result.outcome !== item.status.execution) throw new Error("Saved build result identity changed");
      return saved;
    } });
  useEffect(() => { const error = projection.error ?? projection.data?.runtime.error; if (error) showError(error); }, [projection.error, projection.data?.runtime.error]);

  function selectTask(id: string | null) {
    if (blocked()) return;
    setTaskId(id); setAttemptId(null); setContinuationCursor("0"); setAttemptCursor("0"); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null); setFailure(null); setMessage(null);
  }
  function selectAttempt(id: string | null) {
    if (blocked()) return;
    setAttemptId(id); setContinuationCursor("0"); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null);
  }
  async function viewContinuation(record: ContinuationReceipt) {
    if (blocked() || !detail || continuationHistory.isFetching || continuationHistory.error) return;
    const selected = { taskId: detail.taskId, attemptId: detail.attemptId, operation: detail.operation };
    await perform(async ticket => {
      // Each explicit choice performs a fresh exact read, including repeat choices.
      const found = await commands.continuation({ ...context, actionId: record.action.actionId });
      if (!found || !matchesContinuation(record.action, found) || found.attemptId !== record.attemptId || found.sequence !== record.sequence
        || found.taskId !== selected.taskId || found.operation !== selected.operation || found.action.sourceAttemptId !== selected.attemptId
        || found.requestDigest !== record.requestDigest || found.inputDigest !== record.inputDigest || found.sourceInputDigest !== record.sourceInputDigest) throw new Error("Invalid recorded continuation");
      if (canDispatch(ticket) && selection.current.taskId === selected.taskId && selection.current.attemptId === selected.attemptId) {
        setAttemptId(found.attemptId); setContinuationCursor("0"); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null);
      }
    });
  }
  async function perform(work: (ticket: number) => Promise<void>) {
    if (mutating.current || !canDispatch()) return;
    const ticket = life.current;
    mutating.current = true; reportBlocked(); setBusy(true); setFailure(null); setMessage(null);
    try { await work(ticket); } catch (error) { if (current(ticket)) showError(error); }
    finally { mutating.current = false; if (current(ticket)) { reportBlocked(); setBusy(false); reads.invalidate(["execution"]); } }
  }
  async function execute(choice: Confirmation) {
    if (!detail || blocked()) return;
    const selected = detail;
    // Confirmation owns this scope, including revision zero, before identity allocation.
    const original = choice.unit && choice.task && choice.sourceAttemptId ? {
      projectId: context.projectId, sourceAttemptId: choice.sourceAttemptId, unitId: choice.unit.unitId,
      itemIds: [...choice.unit.remainingItemIds], expectedCancellationRevision: choice.task.cancellationRevision,
      taskId: choice.task.taskId, operation: choice.task.operation,
    } : null;
    await perform(async ticket => {
      if (choice.action === "cancel") {
        const requestId = await commands.identity(context);
        if (!canDispatch(ticket)) return;
        await commands.cancel({ ...context, taskId: selected.taskId, requestId });
      } else if (choice.unit) {
        const unit = choice.unit;
        if (choice.action === "adopt-result") {
          const actionId = await commands.identity(context);
          if (!canDispatch(ticket)) return;
          const prepared = { ...context, attemptId: selected.attemptId, unitId: unit.unitId, actionId, resultIds: unit.resultIds };
          retainAction(prepared); setReceiptChecked(false);
          await commands.prepare(prepared);
          if (!canDispatch(ticket)) return;
          const result = await commands.adopt({ ...context, actionId });
          if (current(ticket)) { setReceipt(result); retainAction(null); }
        } else if (choice.action === "view-receipt" && unit.receiptId) {
          const result = await commands.receipt({ ...context, actionId: unit.receiptId });
          if (current(ticket)) setReceipt(result);
        } else if (choice.action === "resume-undispatched" || choice.action === "retry-safe-failure") {
          if (!original || original.sourceAttemptId !== selected.attemptId || original.taskId !== selected.taskId || original.operation !== selected.operation) throw new Error("Missing continuation authority");
          const actionId = await commands.identity(context);
          if (!canDispatch(ticket)) return;
          const pending: PendingContinuation = {
            request: { ...context, action: { actionId, projectId: original.projectId, sourceAttemptId: original.sourceAttemptId, unitId: original.unitId, kind: choice.action, itemIds: original.itemIds, expectedCancellationRevision: original.expectedCancellationRevision } },
            taskId: original.taskId, operation: original.operation, checked: false, unconfirmed: false,
          };
          retainContinuation(pending); deferContinuation(false);
          await submitContinuation(pending, ticket);
        } else {
          const result = await commands.recover({ ...context, attemptId: selected.attemptId, unitId: unit.unitId, action: choice.action, itemIds: choice.itemId ? [choice.itemId] : unit.remainingItemIds });
          if (current(ticket) && result.attemptId !== selected.attemptId) { setAttemptId(result.attemptId); setContinuationCursor("0"); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null); }
          if (current(ticket) && result.queryStarted) setMessage("queryStarted");
        }
      }
      if (current(ticket)) { setConfirmation(null); if (choice.action !== "query-outcome") setMessage("done"); }
    });
  }
  function acceptContinuation(pending: PendingContinuation, result: ContinuationReceipt, ticket: number) {
    if (!matchesContinuation(pending.request.action, result) || result.taskId !== pending.taskId || result.operation !== pending.operation) throw new Error("Unconfirmed continuation scope");
    if (!current(ticket) || pendingContinuationRef.current?.request !== pending.request) return;
    retainContinuation(null); deferContinuation(false); setConfirmation(null);
    setAttemptId(result.attemptId); setContinuationCursor("0"); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null); setMessage("done");
  }
  async function submitContinuation(pending: PendingContinuation, ticket: number) {
    if (!canDispatch(ticket) || pendingContinuationRef.current?.request !== pending.request) return;
    // Every new unknown removes the permission obtained by an earlier lookup.
    const sending = { ...pending, checked: false };
    retainContinuation(sending); deferContinuation(false);
    try { acceptContinuation(sending, await commands.continue(sending.request), ticket); }
    catch (error) {
      if (current(ticket) && pendingContinuationRef.current?.request === sending.request) retainContinuation(sending.unconfirmed || hasUnknownOutcome(error) ? { ...sending, unconfirmed: true } : null);
      throw error;
    }
  }
  async function checkContinuation() {
    const pending = pendingContinuationRef.current;
    if (!pending || mutating.current || !canDispatch()) return;
    retainContinuation({ ...pending, checked: false });
    await perform(async ticket => {
      const result = await commands.continuation({ sessionToken: pending.request.sessionToken, projectId: pending.request.projectId, actionId: pending.request.action.actionId });
      if (result !== null) acceptContinuation(pending, result, ticket);
      else if (current(ticket) && pendingContinuationRef.current?.request === pending.request) { retainContinuation({ ...pending, checked: true }); setMessage("noContinuation"); }
    });
  }
  async function checkReceipt() {
    const pending = pendingActionRef.current;
    if (!pending || mutating.current || !canDispatch()) return;
    setReceiptChecked(false);
    await perform(async ticket => {
      await projectCommands.read({ sessionToken: context.sessionToken });
      if (!canDispatch(ticket)) return;
      const result = await commands.receipt({ ...context, actionId: pending.actionId });
      if (!current(ticket) || pendingActionRef.current !== pending) return;
      setReceipt(result); setReceiptChecked(true);
      if (result) { retainAction(null); setConfirmation(null); setMessage("done"); } else setMessage("noReceipt");
    });
  }
  const controlsBusy = busy || disabled || sessionInvalid.current;
  const navigationBlocked = controlsBusy || pendingAction !== null || pendingContinuation !== null;
  const errorKey = failure === "dependency-conflict" ? "conflict" : failure === "outcome-unknown" ? "unknown" : failure === "session-invalid" ? "session" : failure === "cancelled" ? "cancelled" : failure === "output-invalid" ? "invalid" : failure === "busy" ? "busy" : "failed";
  const feedback = <>{failure ? <div role="alert"><p>{t(`execution.errors.${errorKey}`)}</p><CommandFailureDetails failure={failureValue} /></div> : null}{message ? <p role="status">{t(`execution.${message}`)}</p> : null}
    {pendingContinuation ? <div className="execution-recovery">
      {pendingContinuation.unconfirmed ? <p role="status">{t("execution.continuationUnconfirmed")}</p> : null}
      <div className="execution-actions"><button className="secondary-button" disabled={controlsBusy} onClick={() => void checkContinuation()}>{t("execution.checkContinuation")}</button>
        {pendingContinuation.checked ? <button className="secondary-button" disabled={controlsBusy} onClick={() => {
          const pending = pendingContinuationRef.current;
          if (pending?.checked) void perform(ticket => submitContinuation(pending, ticket));
        }}>{t("execution.retryContinuation")}</button> : null}
        <button className="text-button" disabled={controlsBusy} onClick={() => { if (mutating.current || !current()) return; deferContinuation(true); setConfirmation(null); }}>{t("execution.deferContinuation")}</button>
      </div>
    </div> : null}
    {pendingAction ? <div className="execution-actions"><button className="secondary-button" disabled={controlsBusy} onClick={() => void checkReceipt()}>{t("execution.checkReceipt")}</button>
      {receiptChecked ? <button className="secondary-button" disabled={controlsBusy} onClick={() => {
        const pending = pendingActionRef.current;
        if (!pending || !receiptChecked) return;
        void perform(async ticket => { setReceiptChecked(false); await commands.prepare(pending); if (!canDispatch(ticket)) return;
          const result = await commands.adopt({ ...context, actionId: pending.actionId });
          if (current(ticket) && pendingActionRef.current === pending) { setReceipt(result); retainAction(null); setConfirmation(null); setMessage("done"); }
        });
      }}>{t("execution.retryAdoption")}</button> : null}
      <button className="text-button" disabled={controlsBusy} onClick={() => { if (mutating.current || !current()) return; retainAction(null); setConfirmation(null); }}>{t("execution.keepOutput")}</button></div> : null}</>;
  const titleFor = (action: Confirmation["action"]) => action === "cancel" ? t("execution.cancel") : t(`execution.actions.${action}`);
  const confirmationCount = confirmation?.itemId ? 1 : confirmation?.unit?.itemIds.length ?? 0;
  const blockedKey = (reason: string) => reason === "external-new-consent" ? "externalConsent" : reason === "outcome-unknown" ? "unknown" : reason === "scope-removed" ? "scopeRemoved" : reason === "output-invalid" ? "invalid" : reason === "retry-not-safe" ? "retryUnsafe" : "blocked";
  return <div className="execution-content" aria-busy={busy || loading}>
    {!confirmation ? feedback : null}
    <div className="execution-actions">
      {taskId ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => selectTask(null)}>{t("execution.allTasks")}</button> : null}
      <button className="secondary-button" disabled={controlsBusy} onClick={() => void perform(async () => { await projectCommands.read({ sessionToken: context.sessionToken }); })}>{t("execution.refresh")}</button>
    </div>
    {loading ? <p role="status">{t("execution.loading")}</p> : null}
    {!taskId ? <>
      {!loading && tasks.length === 0 ? <p>{t("execution.empty")}</p> : null}
      {tasks.length > 0 ? <p>{t("execution.listHelp")}</p> : null}
      <ul className="execution-list">{tasks.map(task => <li key={task.taskId}>
        <button className="secondary-button" onClick={() => selectTask(task.taskId)} disabled={controlsBusy}>
          {t(task.operation === "source-import" ? "source.title" : task.operation === "translation-import" ? "translation.title" : task.operation === "ai-translation" ? "ai.title" : task.operation === "locale-build" ? "release.title" : task.operation === "sample-update" ? "execution.sampleOperation" : "execution.operation")} · {t("execution.taskNumber", { number: task.sequence })}
        </button>
      </li>)}</ul>
      {cursor !== "0" || tasks.length === 50 ? <div className="execution-actions">
        <button className="text-button" disabled={cursor === "0" || navigationBlocked} onClick={() => { if (!blocked()) setCursor("0"); }}>{t("execution.firstPage")}</button>
        <button className="text-button" disabled={tasks.length < 50 || navigationBlocked} onClick={() => { if (!blocked()) setCursor(tasks.at(-1)!.sequence); }}>{t("execution.nextPage")}</button>
      </div> : null}
    </> : <>
      <label className="field execution-attempt">{t("execution.attempt")}
        <select disabled={navigationBlocked} value={attemptId ?? detail?.attemptId ?? ""} onChange={event => {
          selectAttempt(event.target.value);
        }}>
          {attempts.map(attempt => <option key={attempt.attemptId} value={attempt.attemptId}>{t("execution.attemptNumber", { number: attempt.sequence })}</option>)}
          {detail && !attempts.some(attempt => attempt.attemptId === detail.attemptId) ? <option value={detail.attemptId}>{t("execution.currentAttempt")}</option> : null}
        </select>
      </label>
      {attemptCursor !== "0" || attempts.length === 100 ? <div className="execution-actions">
        <button className="text-button" disabled={attemptCursor === "0" || navigationBlocked} onClick={() => { if (blocked()) return; setAttemptCursor("0"); selectAttempt(null); }}>{t("execution.firstPage")}</button>
        <button className="text-button" disabled={attempts.length < 100 || navigationBlocked} onClick={() => { if (blocked()) return; setAttemptCursor(attempts.at(-1)!.sequence); selectAttempt(null); }}>{t("execution.nextPage")}</button>
      </div> : null}
      {detail ? <>
        <section className="execution-summary" aria-label={t("execution.summary")}>
          <strong>{t("execution.progress", { generated: detail.progress.succeeded, adopted: detail.progress.adopted, total: detail.progress.total })}</strong>
          <p>{t("execution.statusCounts", { failed: detail.progress.failed, unknown: detail.progress.unknown, running: detail.progress.running, queued: detail.progress.queued, cancelled: detail.progress.cancelled })}</p>
          <small>{t("execution.applicationHelp")}</small>
        </section>
        <section aria-label={t("execution.nextSteps")}>
          <div className="execution-section-heading"><h3>{t("execution.nextSteps")}</h3>
            <button className="text-button" disabled={navigationBlocked} onClick={() => confirm({ action: "cancel" })}>{t("execution.cancel")}</button>
          </div>
          {detail.recovery.units.map(unit => <section className="execution-unit" key={unit.unitId}>
            <details><summary>{t("execution.groupScope", { count: unit.itemIds.length })}</summary>
              <ul>{unit.scopes.map((scope, index) => <li key={unit.itemIds[index]}>{scope.id}{scope.locale ? ` · ${scope.locale}` : ""}</li>)}</ul>
            </details>
            {unit.blockedReason ? <p>{t(unit.blockedReason === "continued-in-new-attempt" ? "execution.continued" : unit.blockedReason === "still-running" ? "execution.running" : `execution.errors.${blockedKey(unit.blockedReason)}`)}</p> : null}
            <div className="execution-actions">{unit.actions.map(action => action === "query-outcome" ? unit.remainingItemIds.map(id =>
              <button className="secondary-button" key={id} disabled={navigationBlocked} onClick={() => confirm({ action, unit, itemId: id })}>{t(`execution.actions.${action}`)} · {unit.scopes[unit.itemIds.indexOf(id)]?.id}</button>
            ) : <button className={action === "adopt-result" || action === "retry-safe-failure" || action === "resume-undispatched" ? "primary-button" : "secondary-button"} key={action} disabled={navigationBlocked || ((action === "resume-undispatched" || action === "retry-safe-failure") && currentTask === null)} onClick={() => {
              if (blocked()) return;
              if (action === "adopt-result" && detail.operation === "source-import") onSourcePreview?.(detail.attemptId);
              else if (action === "adopt-result" && detail.operation === "translation-import") onTranslationPreview?.(detail.attemptId);
              else if (action === "adopt-result" && detail.operation === "arena-translation") onArenaPreview?.(detail.attemptId); else if (action === "adopt-result" && detail.operation === "ai-translation") onAiPreview?.(detail.attemptId); else if (action === "view-receipt") void execute({ action, unit }); else confirm({ action, unit });
            }}>{t(action === "adopt-result" && detail.operation === "source-import" ? "source.preview" : action === "adopt-result" && detail.operation === "translation-import" ? "translation.preview" : `execution.actions.${action}`)}</button>)}</div>
          </section>)}
        </section>
        <section aria-label={t("execution.continuationHistory")}>
          <h3>{t("execution.continuationHistory")}</h3>
          {continuationHistory.isPending ? <p role="status">{t("execution.loading")}</p> : null}
          {continuationHistory.error ? <p role="alert">{t("execution.continuationHistoryFailed")}</p> : null}
          {continuationHistory.data ? <>
            {continuationHistory.data.receipts.length === 0 && continuationCursor === "0" ? <p>{t("execution.noContinuationHistory")}</p> : null}
            <ul>{continuationHistory.data.receipts.map(record => <li key={record.action.actionId}>
              {t(`execution.actions.${record.action.kind}`)} · {t("execution.continuationItems", { count: record.action.itemIds.length })}
              <button className="text-button" disabled={navigationBlocked || continuationHistory.isFetching || !!continuationHistory.error} onClick={() => void viewContinuation(record)}>{t("execution.viewContinuation")}</button>
            </li>)}</ul>
            {continuationCursor !== "0" || continuationHistory.data.next !== null ? <div className="execution-actions">
              <button className="text-button" disabled={navigationBlocked || continuationCursor === "0" || continuationHistory.isFetching || !!continuationHistory.error} onClick={() => { if (!blocked()) setContinuationCursor("0"); }}>{t("execution.firstPage")}</button>
              <button className="text-button" disabled={navigationBlocked || continuationHistory.data.next === null || continuationHistory.isFetching || !!continuationHistory.error} onClick={() => { if (blocked()) return; const next = continuationHistory.data?.next; if (next) setContinuationCursor(next); }}>{t("execution.nextPage")}</button>
            </div> : null}
          </> : null}
        </section>
        <h3>{t("execution.itemResults")}</h3>{detail.operation === "arena-translation" ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => { if (!blocked()) onArenaPreview?.(detail.attemptId); }}>{t("arena.open")}</button> : null}{detail.operation === "ai-translation" ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => { if (!blocked()) onAiPreview?.(detail.attemptId); }}>{t("ai.results")}</button> : null}
        {detail.operation === "locale-build" && onSavedBuild ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => {
          if (blocked()) return;
          setMessage(onSavedBuild(detail.attemptId) ? null : "savedBuildBlocked");
        }}>{t("releasePlugin.savedOpen")}</button> : null}
        {detail.operation === "source-import" && detail.items.some(item => item.status.validation === "valid") ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => { if (!blocked()) onSourcePreview?.(detail.attemptId); }}>{t("source.preview")}</button> : null}
        {detail.operation === "translation-import" && detail.items.some(item => item.status.validation === "valid") ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => { if (!blocked()) onTranslationPreview?.(detail.attemptId); }}>{t("translation.preview")}</button> : null}
        <ul className="execution-list">{detail.items.map(item => <li key={item.status.itemId}>
          <div className="execution-item-heading"><strong>{item.scope.id}{item.scope.locale ? ` · ${item.scope.locale}` : ""}</strong>
            {item.resultId ? <button className="text-button" disabled={navigationBlocked} onClick={() => {
              if (blocked()) return;
              if (detail.operation === "locale-build") { setSavedOutput({ attemptId: detail.attemptId, itemId: item.status.itemId, resultId: item.resultId! }); return; }
              void perform(async ticket => {
                const result = await commands.output({ ...context, attemptId: detail.attemptId, resultId: item.resultId! });
                if (current(ticket)) setOutput(result);
              });
            }}>{t(item.status.execution === "succeeded" ? "execution.output" : "execution.failureDetails")}</button> : null}
          </div>
          <p>{t(`execution.states.${item.status.execution}`)} · {t(`execution.adoption.${item.status.adoption}`)}</p>
          {item.status.validation === "invalid" ? <p>{t("execution.errors.invalid")}</p> : null}
          {item.status.cancellationRequested ? <small>{t("execution.cancellationRequested")}</small> : null}
          {(detail.operation === "locale-build" ? savedOutput?.attemptId === detail.attemptId && savedOutput.itemId === item.status.itemId && savedOutput.resultId === item.resultId : output?.itemId === item.status.itemId && output.resultId === item.resultId) ? <div className="execution-result" ref={outputRegion} tabIndex={-1} role="region" aria-label={t("execution.resultFor", { name: item.scope.id })}>
            <h4>{t("execution.resultFor", { name: item.scope.id })}</h4>
            {detail.operation === "locale-build" ? <>
              {savedOutputRead.isFetching ? <p role="status">{t("execution.loading")}</p> : null}
              {savedOutputRead.error ? <div role="alert"><p>{t("releasePlugin.savedReadFailed")}</p><CommandFailureDetails failure={commandFailure(savedOutputRead.error)} /><button disabled={savedOutputRead.isFetching} onClick={() => void savedOutputRead.refetch()}>{t("releasePlugin.savedRefresh")}</button></div> : null}
              {!savedOutputRead.error && savedOutputRead.data ? <SavedPluginBuildSummary build={savedOutputRead.data} itemId={item.status.itemId} /> : null}
            </> : output && output.output !== null ? <pre className="execution-output">{JSON.stringify(output.output, null, 2)}</pre> : <p>{t("execution.noOutput")}</p>}
            {detail.operation !== "locale-build" && output?.diagnostic ? <>{output.outcome !== "succeeded" ? <p>{t(output.diagnostic.retrySafe ? "execution.safeFailure" : "execution.unsafeFailure")}</p> : null}
              <details><summary>{t("execution.diagnostic")}</summary><code>{output.diagnostic.code}</code></details></> : null}
          </div> : null}
        </li>)}</ul>
        {offset > 0 || detail.nextOffset !== null ? <div className="execution-actions">
          <button className="text-button" disabled={offset === 0 || navigationBlocked} onClick={() => { if (blocked()) return; setOffset(Math.max(0, offset - 100)); setOutput(null); setSavedOutput(null); }}>{t("execution.previousPage")}</button>
          <button className="text-button" disabled={detail.nextOffset === null || navigationBlocked} onClick={() => { if (blocked()) return; setOffset(detail.nextOffset!); setOutput(null); setSavedOutput(null); }}>{t("execution.nextPage")}</button>
        </div> : null}
      </> : null}
    </>}
    {receipt ? <section className="execution-receipt" role="status"><h3>{t("execution.receipt")}</h3><ul>{receipt.changes.map(change => <li key={`${change.kind}:${change.id}`}>{change.id} · {t("execution.revision", { number: change.revision })}</li>)}</ul></section> : null}
    <Dialog.Root open={confirmation !== null} onOpenChange={open => { if (!open && !mutating.current && !disabled) setConfirmation(null); }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop" />
        <Dialog.Content className="confirm-dialog execution-confirm-dialog" onCloseAutoFocus={event => { event.preventDefault(); actionTrigger.current?.focus(); }} onEscapeKeyDown={event => { if (mutating.current || disabled) event.preventDefault(); }} onPointerDownOutside={event => event.preventDefault()}>
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
          <div className="form-actions"><button className="secondary-button" disabled={controlsBusy} onClick={() => { if (!mutating.current && !disabled) setConfirmation(null); }}>{t("execution.back")}</button>
            <button className="primary-button" disabled={navigationBlocked} onClick={() => { if (confirmation) void execute(confirmation); }}>{busy ? t("execution.working") : confirmation ? titleFor(confirmation.action) : t("execution.confirm")}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
