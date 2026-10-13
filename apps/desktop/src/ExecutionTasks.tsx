import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import type { CommandError, ProjectView } from "./projectCommands";
import { projectCommands, hasUnknownOutcome } from "./projectCommands";
import { releaseCommands } from "./releaseCommands";
import { SavedPluginBuildSummary } from "./SavedPluginBuildSummary";
import { executionCommands as commands, executionContext, matchesContinuation, type AttemptDetail, type AttemptSummary, type RecoveryAction, type RecoveryUnit, type Receipt, type RuntimeStatus, type Task, type PrepareRequest, type CancelRequest, type ResultEnvelope, type ContinuationRequest, type ContinuationReceipt, type ContinuationPage } from "./executionCommands";

type Confirmation = { action: RecoveryAction | "cancel"; unit?: RecoveryUnit; itemId?: string; sourceAttemptId?: string; task?: Task };
type PendingContinuation = { request: ContinuationRequest; taskId: string; operation: string; checked: boolean; unconfirmed: boolean };
type PendingAdoption = { request: PrepareRequest; operation: string; checked: boolean; unconfirmed: boolean };
type PendingCancellation = { request: CancelRequest; attemptId: string; unconfirmed: boolean };
export interface TasksHandle { allowLeave: () => Promise<boolean> }
export function ExecutionTasks({ project, disabled, onSourcePreview, onTranslationPreview, onAiPreview, onArenaPreview, onSavedBuild, ref }: { project: ProjectView; disabled: boolean; onSourcePreview?: (id: string) => void; onTranslationPreview?: (id: string) => void; onArenaPreview?: (id: string) => void; onAiPreview?: (id: string) => void; onSavedBuild?: (id: string) => boolean; ref?: Ref<TasksHandle> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useWorkbenchView("tasks");
  const [dismissBlocked, setDismissBlocked] = useState(false);
  const dismissBlockedRef = useRef(false);
  const reportDismissBlocked = useCallback((value: boolean) => { dismissBlockedRef.current = value; setDismissBlocked(value); }, []);
  const leaveBlocked = useRef(false);
  const setLeaveBlocked = useCallback((value: boolean) => { leaveBlocked.current = value; }, []);
  const [visited, setVisited] = useState(false);
  useEffect(() => { if (open) setVisited(true); }, [open]);
  useImperativeHandle(ref, () => ({ allowLeave: () => {
    if (leaveBlocked.current) { setVisited(true); setOpen(true); return Promise.resolve(false); }
    return Promise.resolve(true);
  } }));
  return <WorkbenchPanel open={open} title={t("execution.title")} description={project.metadata.displayName}
    onBack={() => { if (!disabled && !dismissBlockedRef.current) setOpen(false); }} backDisabled={disabled || dismissBlocked}>
    {visited ? <TaskContent active={open} disabled={disabled} onSavedBuild={onSavedBuild ? id => { const accepted = onSavedBuild(id); if (accepted) setOpen(false); return accepted; } : undefined} onArenaPreview={id => { setOpen(false); onArenaPreview?.(id); }} onAiPreview={id => { setOpen(false); onAiPreview?.(id); }} key={`${project.metadata.projectId}:${project.sessionToken}`} project={project} onDismissBlockedChange={reportDismissBlocked} onLeaveBlockedChange={setLeaveBlocked} onSourcePreview={id => { setOpen(false); onSourcePreview?.(id); }} onTranslationPreview={id => { setOpen(false); onTranslationPreview?.(id); }} /> : null}
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
  const [pendingAction, setPendingAction] = useState<PendingAdoption | null>(null);
  const [pendingContinuation, setPendingContinuation] = useState<PendingContinuation | null>(null);
  const [pendingCancellation, setPendingCancellation] = useState<PendingCancellation | null>(null);
  const [continuationDeferred, setContinuationDeferred] = useState(false);
  const [continuationCursor, setContinuationCursor] = useState("0");
  const [adoptionDeferred, setAdoptionDeferred] = useState(false);
  const [cancellationDeferred, setCancellationDeferred] = useState(false);
  const actionTrigger = useRef<HTMLElement | null>(null);
  const outputRegion = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => { reportBlocked(); }, [busy, pendingAction, adoptionDeferred, pendingContinuation, continuationDeferred, pendingCancellation, cancellationDeferred, onDismissBlockedChange, onLeaveBlockedChange]);
  useLayoutEffect(() => () => { onDismissBlockedChange?.(false); onLeaveBlockedChange?.(false); }, [onDismissBlockedChange, onLeaveBlockedChange]);
  useEffect(() => { if (output || savedOutput) { outputRegion.current?.focus(); outputRegion.current?.scrollIntoView?.({ block: "nearest" }); } }, [output, savedOutput]);
  const mounted = useRef(true);
  const mutating = useRef<symbol | null>(null), life = useRef(0), historyIntent = useRef(0);
  const ownerContext = useRef(context), currentContext = useRef(context), unavailable = useRef(disabled), visible = useRef(active), sessionInvalid = useRef(false);
  const pendingActionRef = useRef<PendingAdoption | null>(null), pendingContinuationRef = useRef<PendingContinuation | null>(null);
  const pendingCancellationRef = useRef<PendingCancellation | null>(null);
  const continuationDeferredRef = useRef(false), adoptionDeferredRef = useRef(false);
  const cancellationDeferredRef = useRef(false);
  useLayoutEffect(() => { currentContext.current = context; unavailable.current = disabled; visible.current = active; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; life.current++; historyIntent.current++; }; }, []);
  function current(ticket = life.current) {
    return mounted.current && ticket === life.current && currentContext.current.sessionToken === ownerContext.current.sessionToken
      && currentContext.current.projectId === ownerContext.current.projectId;
  }
  function canDispatch(ticket = life.current) { return current(ticket) && !unavailable.current && !sessionInvalid.current; }
  function blocked() { return !canDispatch() || !!mutating.current || pendingActionRef.current !== null || pendingContinuationRef.current !== null || pendingCancellationRef.current !== null; }
  function reportBlocked() {
    onDismissBlockedChange?.(!!mutating.current || (pendingActionRef.current !== null && !adoptionDeferredRef.current) || (pendingContinuationRef.current !== null && !continuationDeferredRef.current)
      || (pendingCancellationRef.current !== null && !cancellationDeferredRef.current));
    onLeaveBlockedChange?.(!!mutating.current || pendingActionRef.current !== null || pendingContinuationRef.current !== null || pendingCancellationRef.current !== null);
  }
  function retainAction(value: PendingAdoption | null) { pendingActionRef.current = value; setPendingAction(value); reportBlocked(); }
  function retainContinuation(value: PendingContinuation | null) { pendingContinuationRef.current = value; setPendingContinuation(value); reportBlocked(); }
  function retainCancellation(value: PendingCancellation | null) { pendingCancellationRef.current = value; setPendingCancellation(value); reportBlocked(); }
  function deferContinuation(value: boolean) { continuationDeferredRef.current = value; setContinuationDeferred(value); reportBlocked(); }
  function deferAdoption(value: boolean) { adoptionDeferredRef.current = value; setAdoptionDeferred(value); reportBlocked(); }
  function deferCancellation(value: boolean) { cancellationDeferredRef.current = value; setCancellationDeferred(value); reportBlocked(); }

  function showError(error: unknown) {
    const value = commandFailure(error,"storage-failed");
    if (value === "session-invalid" || typeof value !== "string" && value.code === "session-invalid") sessionInvalid.current = true;
    setFailure(value);
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
      if (detail && (detail.taskId !== taskId || detail.attemptId !== selected || detail.recovery.attemptId !== selected || detail.operation !== task.operation)) throw new Error("Invalid task attempt scope");
      return { runtime, tasks: [], attempts, detail, task };
    },
  });
  const tasks = projection.data?.tasks ?? [], attempts = projection.data?.attempts ?? [], detail = projection.data?.detail ?? null;
  const currentTask = projection.data?.task ?? null;
  const selection = useRef({ taskId, attemptId: detail?.attemptId ?? null });
  useLayoutEffect(() => { selection.current = { taskId, attemptId: detail?.attemptId ?? null }; }, [taskId, detail?.attemptId]);
  function captureChoice(choice: Confirmation): Confirmation | null {
    if (blocked() || !detail || !currentTask || currentTask.taskId !== detail.taskId || currentTask.operation !== detail.operation) return null;
    return { ...choice, unit: choice.unit ? structuredClone(choice.unit) : undefined, sourceAttemptId: detail.attemptId, task: { ...currentTask } };
  }
  function confirm(choice: Confirmation) {
    const captured = captureChoice(choice); if (!captured) return;
    actionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFailure(null); setMessage(null); setConfirmation(captured);
  }
  function openPreview(id: string, show?: (id: string) => void) { if (!blocked() && visible.current) show?.(id); }
  const continuationHistory = useSessionQuery<ContinuationPage>({
    key: ["execution-continuations", detail?.attemptId ?? null, continuationCursor], scopes: ["execution"], enabled: active && !busy && detail !== null,
    read: async () => {
      if (!detail) throw new Error("No selected execution attempt");
      const selected = detail;
      const page = await commands.continuations({ ...context, sourceAttemptId: selected.attemptId, after: continuationCursor, limit: 50 });
      if (page.receipts.some(record => record.taskId !== selected.taskId || record.operation !== selected.operation)) throw new Error("Invalid continuation history task");
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
    if (blocked()) return; historyIntent.current++;
    setTaskId(id); setAttemptId(null); setContinuationCursor("0"); setAttemptCursor("0"); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null); setFailure(null); setMessage(null);
  }
  function selectAttempt(id: string | null) {
    if (blocked()) return; historyIntent.current++;
    setAttemptId(id); setContinuationCursor("0"); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null);
  }
  async function perform(work: (ticket: number) => Promise<void>) {
    if (mutating.current || !canDispatch()) return;
    const ticket = life.current, flight = Symbol();
    mutating.current = flight; reportBlocked(); setBusy(true); setFailure(null); setMessage(null);
    try { await work(ticket); } catch (error) { if (current(ticket)) showError(error); }
    finally {
      if (mutating.current === flight) {
        mutating.current = null;
        if (current(ticket)) { reportBlocked(); setBusy(false); reads.invalidate(["execution"]); }
      }
    }
  }
  async function execute(choice: Confirmation) {
    if (blocked() || !choice.task || !choice.sourceAttemptId) return;
    // This confirmation, including revision zero and the full unit, owns its
    // target before identity allocation. Current progress cannot rebind it.
    const original = { ...context, attemptId: choice.sourceAttemptId, taskId: choice.task.taskId, operation: choice.task.operation,
      cancellationRevision: choice.task.cancellationRevision, unit: choice.unit ? structuredClone(choice.unit) : undefined, itemId: choice.itemId };
    await perform(async ticket => {
      if (choice.action === "cancel") {
        const requestId = await commands.identity(context);
        if (!canDispatch(ticket)) return;
        const pending: PendingCancellation = { request: { sessionToken: original.sessionToken, projectId: original.projectId, taskId: original.taskId, requestId },
          attemptId: original.attemptId, unconfirmed: false };
        retainCancellation(pending); deferCancellation(false);
        await submitCancellation(pending,ticket);
      } else if (original.unit) {
        const unit = original.unit;
        if (choice.action === "adopt-result") {
          const actionId = await commands.identity(context);
          if (!canDispatch(ticket)) return;
          const pending: PendingAdoption = { request: { sessionToken: original.sessionToken, projectId: original.projectId,
            attemptId: original.attemptId, unitId: unit.unitId, actionId, resultIds: [...unit.resultIds] }, operation: original.operation, checked: false, unconfirmed: false };
          retainAction(pending); deferAdoption(false);
          await submitAdoption(pending, ticket);
        } else if (choice.action === "view-receipt" && unit.receiptId) {
          const result = await commands.receipt({ sessionToken: original.sessionToken, projectId: original.projectId, actionId: unit.receiptId });
          if (result !== null && (result.projectId !== original.projectId || result.attemptId !== original.attemptId || result.unitId !== unit.unitId || result.actionId !== unit.receiptId)) throw new Error("Unconfirmed task receipt");
          if (current(ticket)) setReceipt(result);
        } else if (choice.action === "resume-undispatched" || choice.action === "retry-safe-failure") {
          const actionId = await commands.identity(context);
          if (!canDispatch(ticket)) return;
          const pending: PendingContinuation = {
            request: { sessionToken: original.sessionToken, projectId: original.projectId, action: { actionId, projectId: original.projectId,
              sourceAttemptId: original.attemptId, unitId: unit.unitId, kind: choice.action, itemIds: [...unit.remainingItemIds], expectedCancellationRevision: original.cancellationRevision } },
            taskId: original.taskId, operation: original.operation, checked: false, unconfirmed: false,
          };
          retainContinuation(pending); deferContinuation(false);
          await submitContinuation(pending, ticket);
        } else {
          const result = await commands.recover({ sessionToken: original.sessionToken, projectId: original.projectId,
            attemptId: original.attemptId, unitId: unit.unitId, action: choice.action, itemIds: original.itemId ? [original.itemId] : [...unit.remainingItemIds] });
          if (current(ticket) && result.attemptId !== original.attemptId) { setAttemptId(result.attemptId); setContinuationCursor("0"); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null); }
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
  async function submitCancellation(pending: PendingCancellation, ticket: number) {
    if (!canDispatch(ticket) || pendingCancellationRef.current?.request !== pending.request) return;
    deferCancellation(false);
    try {
      await commands.cancel(pending.request);
      if (current(ticket) && pendingCancellationRef.current?.request === pending.request) { retainCancellation(null); setConfirmation(null); setMessage("done"); }
    } catch (error) {
      if (current(ticket) && pendingCancellationRef.current?.request === pending.request) retainCancellation(pending.unconfirmed || hasUnknownOutcome(error) ? { ...pending, unconfirmed: true } : null);
      throw error;
    }
  }
  async function retryCancellation() {
    const pending = pendingCancellationRef.current;
    if (!pending?.unconfirmed || mutating.current || !canDispatch()) return;
    await perform(ticket => submitCancellation(pending,ticket));
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
  async function retryContinuation() {
    const pending = pendingContinuationRef.current;
    if (!pending?.checked || mutating.current || !canDispatch()) return;
    await perform(ticket => submitContinuation(pending, ticket));
  }
  function checkedAdoptionReceipt(pending: PendingAdoption, result: Receipt) {
    const request = pending.request;
    if (result.projectId !== request.projectId || result.attemptId !== request.attemptId || result.actionId !== request.actionId || result.unitId !== request.unitId) throw new Error("Unconfirmed adoption receipt");
    return result;
  }
  async function submitAdoption(pending: PendingAdoption, ticket: number) {
    if (!canDispatch(ticket) || pendingActionRef.current?.request !== pending.request) return;
    const sending = { ...pending, checked: false }; retainAction(sending); deferAdoption(false);
    try {
      const request = sending.request, action = await commands.prepare(request);
      if (!canDispatch(ticket) || pendingActionRef.current?.request !== request) return;
      const expected = [...request.resultIds].sort(), actual = [...action.resultIds].sort();
      if (action.projectId !== request.projectId || action.attemptId !== request.attemptId || action.actionId !== request.actionId || action.unitId !== request.unitId
        || action.operation !== sending.operation || expected.length !== new Set(expected).size || actual.length !== new Set(actual).size
        || expected.length !== actual.length || expected.some((id,index) => id !== actual[index])) throw new Error("Unconfirmed adoption preparation");
      const result = checkedAdoptionReceipt(sending, await commands.adopt({ sessionToken: request.sessionToken, projectId: request.projectId, actionId: request.actionId }));
      if (current(ticket) && pendingActionRef.current?.request === request) { setReceipt(result); retainAction(null); deferAdoption(false); setConfirmation(null); setMessage("done"); }
    } catch (error) {
      if (current(ticket) && pendingActionRef.current?.request === sending.request) retainAction(sending.unconfirmed || hasUnknownOutcome(error) ? { ...sending, unconfirmed: true } : null);
      throw error;
    }
  }
  async function retryAdoption() {
    const pending = pendingActionRef.current;
    if (!pending?.checked || mutating.current || !canDispatch()) return;
    await perform(ticket => submitAdoption(pending, ticket));
  }
  async function checkReceipt() {
    const pending = pendingActionRef.current;
    if (!pending || mutating.current || !canDispatch()) return;
    retainAction({ ...pending, checked: false });
    await perform(async ticket => {
      const request = pending.request;
      await projectCommands.read({ sessionToken: request.sessionToken });
      if (!canDispatch(ticket)) return;
      const result = await commands.receipt({ sessionToken: request.sessionToken, projectId: request.projectId, actionId: request.actionId });
      if (!current(ticket) || pendingActionRef.current?.request !== request) return;
      if (result !== null) { setReceipt(checkedAdoptionReceipt(pending, result)); retainAction(null); deferAdoption(false); setConfirmation(null); setMessage("done"); }
      else { retainAction({ ...pending, checked: true }); setMessage("noReceipt"); }
    });
  }
  async function viewContinuation(record: ContinuationReceipt) {
    if (blocked() || !detail || continuationHistory.isFetching || continuationHistory.error) return;
    const selected = { taskId: detail.taskId, attemptId: detail.attemptId, operation: detail.operation }, original = structuredClone(record), intent = ++historyIntent.current;
    await perform(async ticket => {
      const found = await commands.continuation({ ...context, actionId: original.action.actionId });
      if (!found || !matchesContinuation(original.action, found) || found.attemptId !== original.attemptId || found.sequence !== original.sequence
        || found.taskId !== original.taskId || found.operation !== original.operation || found.taskId !== selected.taskId || found.operation !== selected.operation
        || found.action.sourceAttemptId !== selected.attemptId || found.requestDigest !== original.requestDigest || found.inputDigest !== original.inputDigest
        || found.sourceInputDigest !== original.sourceInputDigest) throw new Error("Invalid recorded continuation");
      if (canDispatch(ticket) && visible.current && historyIntent.current === intent && selection.current.taskId === selected.taskId && selection.current.attemptId === selected.attemptId) {
        setAttemptId(found.attemptId); setContinuationCursor("0"); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null);
      }
    });
  }
  const controlsBusy = busy || disabled || sessionInvalid.current || context.sessionToken !== ownerContext.current.sessionToken || context.projectId !== ownerContext.current.projectId;
  const navigationBlocked = controlsBusy || pendingAction !== null || pendingContinuation !== null || pendingCancellation !== null;
  const errorKey = failure === "dependency-conflict" ? "conflict" : failure === "outcome-unknown" ? "unknown" : failure === "session-invalid" ? "session" : failure === "cancelled" ? "cancelled" : failure === "output-invalid" ? "invalid" : failure === "busy" ? "busy" : "failed";
  const feedback = <>{failure ? <div role="alert"><p>{t(`execution.errors.${errorKey}`)}</p><CommandFailureDetails failure={failureValue} /></div> : null}{message ? <p role="status">{t(`execution.${message}`)}</p> : null}
    {pendingCancellation ? <div className="execution-recovery">
      <p role="status">{t("execution.cancellationUnconfirmed")}</p>
      <div className="execution-actions"><button className="secondary-button" disabled={controlsBusy || !pendingCancellation.unconfirmed} onClick={() => void retryCancellation()}>{t("execution.retryCancellation")}</button>
        <button className="text-button" disabled={controlsBusy} onClick={() => { if (!mutating.current) { deferCancellation(true); setConfirmation(null); } }}>{t("execution.deferContinuation")}</button>
      </div>
    </div> : null}
    {pendingContinuation ? <div className="execution-recovery">
      {pendingContinuation.unconfirmed ? <p role="status">{t("execution.continuationUnconfirmed")}</p> : null}
      <div className="execution-actions"><button className="secondary-button" disabled={controlsBusy} onClick={() => void checkContinuation()}>{t("execution.checkContinuation")}</button>
        {pendingContinuation.checked ? <button className="secondary-button" disabled={controlsBusy} onClick={() => void retryContinuation()}>{t("execution.retryContinuation")}</button> : null}
        <button className="text-button" disabled={controlsBusy} onClick={() => { if (!mutating.current) { deferContinuation(true); setConfirmation(null); } }}>{t("execution.deferContinuation")}</button>
      </div>
    </div> : null}
    {pendingAction ? <div className="execution-recovery">{pendingAction.unconfirmed ? <p role="status">{t("execution.adoptionUnconfirmed")}</p> : null}
      <div className="execution-actions"><button className="secondary-button" disabled={controlsBusy} onClick={() => void checkReceipt()}>{t("execution.checkReceipt")}</button>
      {pendingAction.checked ? <button className="secondary-button" disabled={controlsBusy} onClick={() => void retryAdoption()}>{t("execution.retryAdoption")}</button> : null}
      <button className="text-button" disabled={controlsBusy} onClick={() => { if (!mutating.current) { deferAdoption(true); setConfirmation(null); } }}>{t("execution.keepOutput")}</button></div></div> : null}</>;
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
        <button className="secondary-button" onClick={() => selectTask(task.taskId)} disabled={navigationBlocked}>
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
              if (action === "adopt-result" && detail.operation === "source-import") openPreview(detail.attemptId,onSourcePreview);
              else if (action === "adopt-result" && detail.operation === "translation-import") openPreview(detail.attemptId,onTranslationPreview);
              else if (action === "adopt-result" && detail.operation === "arena-translation") openPreview(detail.attemptId,onArenaPreview); else if (action === "adopt-result" && detail.operation === "ai-translation") openPreview(detail.attemptId,onAiPreview);
              else if (action === "view-receipt") { const captured=captureChoice({action,unit}); if(captured)void execute(captured); } else confirm({ action, unit });
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
              <button className="text-button" disabled={navigationBlocked || continuationHistory.isFetching || continuationHistory.error !== null} onClick={() => void viewContinuation(record)}>{t("execution.viewContinuation")}</button>
            </li>)}</ul>
            {continuationCursor !== "0" || continuationHistory.data.next !== null ? <div className="execution-actions">
              <button className="text-button" disabled={navigationBlocked || continuationCursor === "0" || continuationHistory.isFetching || continuationHistory.error !== null} onClick={() => { if (!blocked()) { historyIntent.current++; setContinuationCursor("0"); } }}>{t("execution.firstPage")}</button>
              <button className="text-button" disabled={navigationBlocked || continuationHistory.data.next === null || continuationHistory.isFetching || continuationHistory.error !== null} onClick={() => { const next = continuationHistory.data?.next; if (!blocked() && next !== null && next !== undefined) { historyIntent.current++; setContinuationCursor(next); } }}>{t("execution.nextPage")}</button>
            </div> : null}
          </> : null}
        </section>
        <h3>{t("execution.itemResults")}</h3>{detail.operation === "arena-translation" ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => openPreview(detail.attemptId,onArenaPreview)}>{t("arena.open")}</button> : null}{detail.operation === "ai-translation" ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => openPreview(detail.attemptId,onAiPreview)}>{t("ai.results")}</button> : null}
        {detail.operation === "locale-build" && onSavedBuild ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => {
          if (blocked() || !visible.current) return;
          setMessage(onSavedBuild(detail.attemptId) ? null : "savedBuildBlocked");
        }}>{t("releasePlugin.savedOpen")}</button> : null}
        {detail.operation === "source-import" && detail.items.some(item => item.status.validation === "valid") ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => openPreview(detail.attemptId,onSourcePreview)}>{t("source.preview")}</button> : null}
        {detail.operation === "translation-import" && detail.items.some(item => item.status.validation === "valid") ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => openPreview(detail.attemptId,onTranslationPreview)}>{t("translation.preview")}</button> : null}
        <ul className="execution-list">{detail.items.map(item => <li key={item.status.itemId}>
          <div className="execution-item-heading"><strong>{item.scope.id}{item.scope.locale ? ` · ${item.scope.locale}` : ""}</strong>
            {item.resultId ? <button className="text-button" disabled={detail.operation === "locale-build" ? navigationBlocked : controlsBusy} onClick={() => {
              if (detail.operation === "locale-build") {
                if (blocked()) return;
                setSavedOutput({ attemptId: detail.attemptId, itemId: item.status.itemId, resultId: item.resultId! }); return;
              }
              void perform(async ticket => {
                const result = await commands.output({ ...context, attemptId: detail.attemptId, resultId: item.resultId! });
                if (result.projectId !== context.projectId || result.resultId !== item.resultId || result.itemId !== item.status.itemId) throw new Error("Unconfirmed output scope");
                // Core authorizes reused output whose envelope retains its source attempt.
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
          <button className="text-button" disabled={offset === 0 || navigationBlocked} onClick={() => { if (!blocked()) { setOffset(Math.max(0, offset - 100)); setOutput(null); setSavedOutput(null); } }}>{t("execution.previousPage")}</button>
          <button className="text-button" disabled={detail.nextOffset === null || navigationBlocked} onClick={() => { if (!blocked()) { setOffset(detail.nextOffset!); setOutput(null); setSavedOutput(null); } }}>{t("execution.nextPage")}</button>
        </div> : null}
      </> : null}
    </>}
    {receipt ? <section className="execution-receipt" role="status"><h3>{t("execution.receipt")}</h3><ul>{receipt.changes.map(change => <li key={`${change.kind}:${change.id}`}>{change.id} · {t("execution.revision", { number: change.revision })}</li>)}</ul></section> : null}
    <Dialog.Root open={active && confirmation !== null} onOpenChange={open => { if (!open && !mutating.current && !disabled) setConfirmation(null); }}>
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
