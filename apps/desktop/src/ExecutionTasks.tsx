import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { TaskCancellationFeedback, useExecutionTaskSession, type CancellationTarget } from "./ExecutionTaskSession";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { WorkbenchPanel, useWorkbenchView, useWorkbenchState, useWorkbenchRef, useWorkspaceView } from "./WorkbenchFrame";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import type { ProjectView } from "./projectCommands";
import { releaseCommands } from "./releaseCommands";
import { SavedPluginBuildSummary } from "./SavedPluginBuildSummary";
import { executionCommands as commands, executionContext, matchesContinuation, type AttemptDetail, type AttemptSummary, type RecoveryAction, type RecoveryUnit, type Receipt, type RuntimeStatus, type Task, type ExecutionOutputView, type ContinuationPage, type ContinuationReceipt } from "./executionCommands";
import { ExecutionDiagnosticDetails } from "./ExecutionDiagnosticDetails";
import { useWorkbenchCommands, type CommandAvailability, type TaskActionCommandPayload, type TaskConfirmedCommandPayload, type TaskPendingCommandPayload,
  type TaskHistoryCommandPayload, type TaskReceiptCommandPayload, type TaskOutputCommandPayload, type TaskPreviewCommandPayload,
  type ExecutionCancellationCommandPayload, type ExecutionCancellationRetryCommandPayload, type TaskSavedBuildCommandPayload } from "./workbenchCommands";

type Confirmation = { action: RecoveryAction | "cancel"; unit?: RecoveryUnit; itemId?: string; cancellation?: CancellationTarget };
type HistorySelection = { id: number; record: ContinuationReceipt };
const actionCommands = { "adopt-result": "tasks.adopt-result", "resume-undispatched": "tasks.resume-undispatched",
  "retry-safe-failure": "tasks.retry-safe-failure", "validate-output": "tasks.validate-output", "query-outcome": "tasks.query-outcome" } as const;
function sameContinuationRecord(record: ContinuationReceipt, found: ContinuationReceipt) {
  return matchesContinuation(record.action, found) && found.attemptId === record.attemptId
    && found.taskId === record.taskId && found.operation === record.operation && found.sequence === record.sequence
    && found.requestDigest === record.requestDigest && found.inputDigest === record.inputDigest && found.sourceInputDigest === record.sourceInputDigest;
}
export interface TasksHandle { allowLeave: () => Promise<boolean>; allowNavigate: () => Promise<boolean> }
export function ExecutionTasks({ project, disabled, onSourcePreview, onTranslationPreview, onAiPreview, onArenaPreview, onSavedBuild, ref }: { project: ProjectView; disabled: boolean; onSourcePreview?: (id: string) => void; onTranslationPreview?: (id: string) => void; onArenaPreview?: (id: string) => void; onAiPreview?: (id: string) => void; onSavedBuild?: (id: string) => Promise<boolean>; ref?: Ref<TasksHandle> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useWorkbenchView("tasks");
  const { memory } = useWorkspaceView();
  const cancellations = useExecutionTaskSession(), sessionReads = useSessionReads();
  const routeLife = useRef(0), routeMounted = useRef(false);
  useLayoutEffect(()=>{routeMounted.current=true;routeLife.current++;return()=>{routeMounted.current=false;routeLife.current++;};},[project.sessionToken,project.metadata.projectId]);
  const [acceptedRoute, setAcceptedRoute] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (acceptedRoute === null) return;
    setAcceptedRoute(null);
    // The destination must commit before a redundant close can consult the current view.
    if (routeMounted.current && routeLife.current === acceptedRoute && !sessionReads.retired && open) setOpen(false);
  }, [acceptedRoute, open, sessionReads, setOpen]);
  const [dismissBlocked, setDismissBlocked] = useState(false);
  const [visited, setVisited] = useWorkbenchState("tasks", "visited", false);
  useEffect(() => { if (open) setVisited(true); }, [open]);
  useImperativeHandle(ref, () => ({ allowNavigate: () => Promise.resolve(true), allowLeave: () => {
    if (cancellations.unresolved()) { memory.write("tasks", "showOwnerDialog", true); setVisited(true); setOpen(true); return Promise.resolve(false); }
    return Promise.resolve(!dismissBlocked);
  } }));
  return <WorkbenchPanel open={open} title={t("execution.title")} description={project.metadata.displayName}
    onBack={() => setOpen(false)} backDisabled={disabled}>
    {visited ? <TaskContent active={open} disabled={disabled} onArenaPreview={onArenaPreview} onAiPreview={onAiPreview} onSavedBuild={onSavedBuild ? async id => { const ticket = routeLife.current; const accepted = await onSavedBuild(id); if (accepted && routeMounted.current && routeLife.current === ticket && !sessionReads.retired) setAcceptedRoute(ticket); return accepted; } : undefined} key={project.sessionToken} project={project} onDismissBlockedChange={setDismissBlocked} onSourcePreview={onSourcePreview} onTranslationPreview={onTranslationPreview} /> : null}
  </WorkbenchPanel>;
}

export function TaskContent({ project, active = true, disabled = false, onDismissBlockedChange, onSourcePreview, onTranslationPreview, onAiPreview, onArenaPreview, onSavedBuild }: { project: ProjectView; active?: boolean; disabled?: boolean; onDismissBlockedChange?: (blocked: boolean) => void; onSourcePreview?: (id: string) => void; onTranslationPreview?: (id: string) => void; onArenaPreview?: (id: string) => void; onAiPreview?: (id: string) => void; onSavedBuild?: (id: string) => Promise<boolean> }) {
  const { t } = useTranslation();
  const context = executionContext(project);
  const cancellations = useExecutionTaskSession();
  const registry = useWorkbenchCommands();
  const mounted = useRef(true), sessionInvalid = useRef(false);
  const dispatchDisabled = useRef(disabled);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { dispatchDisabled.current = disabled; }, [disabled]);
  // A mounted caller can lose permission; hiding its view does not revoke the owner's fixed decision.
  const continueCaptured = () => !mounted.current || !dispatchDisabled.current;
  const [taskId, setTaskId] = useWorkbenchState<string | null>("tasks", "taskId", null);
  const [attemptId, setAttemptId] = useWorkbenchState<string | null>("tasks", "attemptId", null);
  const [cursor, setCursor] = useWorkbenchState("tasks", "cursor", "0");
  const [attemptCursor, setAttemptCursor] = useWorkbenchState("tasks", "attemptCursor", "0");
  const [continuationCursor, setContinuationCursor] = useWorkbenchState("tasks", "continuationCursor", "0");
  const [historySelection, setHistorySelection] = useWorkbenchState<HistorySelection | null>("tasks", "historySelection", null);
  const historyIntent = useWorkbenchRef("tasks", "historyIntent", 0);
  const [offset, setOffset] = useWorkbenchState("tasks", "offset", 0);
  const busy = cancellations.busy;
  const activity = cancellations.activity;
  const pendingAction = activity?.phase === "unknown" || cancellations.busy ? activity : null;
  const [showOwnerDialog, setShowOwnerDialog] = useWorkbenchState("tasks", "showOwnerDialog", true);
  const [failureValue, setFailure] = useState<CommandFailure | null>(null);
  const [message, setMessage] = useState<"done" | "noReceipt" | "queryStarted" | "savedBuildBlocked" | null>(null);
  const [localConfirmation, setConfirmation] = useWorkbenchState<Confirmation | null>("tasks", "confirmation", null);
  const ownerConfirmation = activity && showOwnerDialog && activity.phase !== "recorded" && activity.phase !== "rejected"
    ? { action: activity.intent.action, unit: activity.intent.unit, itemId: activity.intent.itemId } : null;
  const confirmation: Confirmation | null = localConfirmation ?? ownerConfirmation;
  const [outputSelection, setOutput] = useWorkbenchState<{ attemptId: string; itemId: string; resultId: string } | null>("tasks", "outputSelection", null);
  const [savedOutput, setSavedOutput] = useWorkbenchState<{ attemptId: string; itemId: string; resultId: string } | null>("tasks", "savedOutput", null);
  const savedRoute = useRef(false);
  const [routing, setRouting] = useState(false);
  const [receiptSelection, setReceipt] = useWorkbenchState<{ attemptId: string; unitId: string; actionId: string } | null>("tasks", "receiptSelection", null);

  const actionTrigger = useRef<HTMLElement | null>(null);
  const outputRegion = useRef<HTMLDivElement | null>(null);
  const handledRecovery = useWorkbenchRef<string | null>("tasks", "handledRecovery", null);
  useEffect(() => { onDismissBlockedChange?.(busy || cancellations.unresolved()); return () => onDismissBlockedChange?.(false); }, [busy, activity, cancellations.state, onDismissBlockedChange]);
  function rememberTrigger() {
    actionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFailure(null); setMessage(null); setShowOwnerDialog(true);
  }
  function closeConfirmation() {
    setConfirmation(null); setShowOwnerDialog(false); cancellations.dismiss();
  }
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
  const continuationHistory = useSessionQuery<ContinuationPage>({
    key: ["execution-continuations", detail?.attemptId ?? null, continuationCursor], scopes: ["execution"], enabled: active && !busy && detail !== null,
    read: () => {
      if (!detail) throw new Error("No selected execution attempt");
      return commands.continuations({ ...context, sourceAttemptId: detail.attemptId, after: continuationCursor, limit: 50 }).then(page => {
        if (page.receipts.some(receipt => receipt.taskId !== detail.taskId || receipt.operation !== detail.operation)) throw new Error("Invalid continuation history task");
        return page;
      });
    },
  });
  const selectedContinuation = useSessionQuery<HistorySelection>({
    key: ["execution-continuation", historySelection], scopes: ["execution"], enabled: active && !busy && pendingAction === null && historySelection !== null,
    read: async () => {
      if (!historySelection) throw new Error("No recorded continuation selected");
      const found = await commands.continuation({ ...context, actionId: historySelection.record.action.actionId });
      if (!found || !sameContinuationRecord(historySelection.record, found)) throw new Error("Invalid recorded continuation");
      return { id: historySelection.id, record: found };
    },
  });
  useEffect(() => {
    const found = selectedContinuation.data;
    // A previous successful lookup cannot complete a new selection or a remount's fresh read.
    if (!active || !mounted.current || reads.retired || busy || pendingAction || selectedContinuation.status !== "success" || selectedContinuation.fetchStatus !== "idle"
      || selectedContinuation.isFetching || selectedContinuation.error !== null || !found || !historySelection
      || found.id !== historySelection.id || !sameContinuationRecord(historySelection.record, found.record)
      || !detail || detail.attemptId !== historySelection.record.action.sourceAttemptId || detail.taskId !== historySelection.record.taskId
      || detail.operation !== historySelection.record.operation) return;
    setAttemptId(found.record.attemptId); setContinuationCursor("0"); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null); setHistorySelection(null);
  }, [selectedContinuation.data, selectedContinuation.status, selectedContinuation.fetchStatus, selectedContinuation.isFetching,
    selectedContinuation.error, historySelection, active, busy, pendingAction, detail?.attemptId, detail?.taskId, detail?.operation]);
  const cancelTarget: CancellationTarget | null = detail ? { taskId: detail.taskId, attemptId: detail.attemptId, origin: "tasks" } : null;
  const cancellation = confirmation?.cancellation ? cancellations.current(confirmation.cancellation.taskId) : undefined;
  const cancelling = cancellation?.phase === "preparing" || cancellation?.phase === "pending" || cancellation?.phase === "checking";
  useEffect(() => { if (cancellation?.phase === "recorded" || cancellation?.phase === "rejected") setConfirmation(null); }, [cancellation]);
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
    if (!gate().enabled) return;
    setTaskId(id); setAttemptId(null); setAttemptCursor("0"); setContinuationCursor("0"); setHistorySelection(null); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null); setFailure(null);
  }
  const recovered = activity?.phase === "recorded" ? activity.recovery : null;
  const continued = activity?.phase === "recorded" ? activity.continuation : null;
  useEffect(() => {
    if ((recovered || continued) && activity) {
      const marker = `${activity.intent.attemptId}:${continued?.action.actionId ?? activity.prepare?.actionId ?? ""}:${continued?.attemptId ?? recovered!.attemptId}`;
      if (handledRecovery.current === marker) return;
      handledRecovery.current = marker;
      setTaskId(activity.intent.taskId);
      setAttemptId(continued?.attemptId ?? recovered!.attemptId); setContinuationCursor("0"); setHistorySelection(null); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null);
      setMessage(recovered?.queryStarted ? "queryStarted" : "done");
    }
  }, [recovered, continued]);
  const outputQuery = useSessionQuery<ExecutionOutputView>({ key: ["task-output", outputSelection], scopes: ["execution"], enabled: active && outputSelection !== null,
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
  const output = outputQuery.error ? null : outputQuery.data ?? null;
  const shownReceipt = receiptSelection ? receiptQuery.data : activity?.phase === "recorded" ? activity.receipt : null;
  useEffect(() => { if (output) { outputRegion.current?.focus(); outputRegion.current?.scrollIntoView?.({ block: "nearest" }); } }, [output]);
  useEffect(() => { const error = outputQuery.error ?? receiptQuery.error ?? selectedContinuation.error; if (error) showError(error); }, [outputQuery.error, receiptQuery.error, selectedContinuation.error]);
  const ownerFailure = activity?.failure ?? null;
  const displayedFailure = ownerFailure ?? failureValue;
  const displayedCode = typeof displayedFailure === "string" ? displayedFailure : displayedFailure?.code ?? null;
  const errorKey = displayedCode === "dependency-conflict" ? "conflict" : displayedCode === "outcome-unknown" ? "unknown" : displayedCode === "session-invalid" ? "session" : displayedCode === "cancelled" ? "cancelled" : displayedCode === "output-invalid" ? "invalid" : displayedCode === "busy" ? "busy" : "failed";
  const errorRegion = useRef<HTMLDivElement>(null);
  useEffect(() => { if (active && displayedFailure) errorRegion.current?.focus(); }, [active, displayedFailure]);
  const commandScope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "tasks" as const };
  const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
  const projectionKey = ["tasks",taskId,attemptId,cursor,attemptCursor,offset];
  function gate(allowOriginal = false): CommandAvailability {
    if (!active || !mounted.current || reads.retired || reads.context.projectId !== commandScope.projectId || reads.context.sessionToken !== commandScope.sessionToken) return { enabled: false, reason: "hidden" };
    const current = cancellations.currentActivity();
    if (current && ["capturing","identifying","preparing","adopting","recovering","checking"].includes(current.phase)) return { enabled: false, reason: "busy" };
    if (disabled || savedRoute.current || sessionInvalid.current) return unavailable;
    if (!allowOriginal && (cancellations.unresolved() || current && ["confirming","unknown"].includes(current.phase))) return { enabled: false, reason: "pending-action" };
    return { enabled: true };
  }
  function currentRead<T>(key: readonly unknown[]): T | undefined {
    const query = reads.client.getQueryState(reads.key(key));
    return query?.status === "success" && query.error === null && query.fetchStatus === "idle" && !query.isInvalidated
      ? reads.client.getQueryData<T>(reads.key(key)) : undefined;
  }
  function currentDetail(retained = false) {
    const key = reads.key(projectionKey), query = reads.client.getQueryState(key);
    const value = retained && query && query.dataUpdateCount > 0 ? reads.client.getQueryData<NonNullable<typeof projection.data>>(key) : currentRead<NonNullable<typeof projection.data>>(projectionKey);
    const selected = value?.detail;
    return value && selected && selected.taskId === taskId && selected.recovery.attemptId === selected.attemptId
      && selected.attemptId === (attemptId ?? value.attempts.at(-1)?.attemptId)
      && value.task?.taskId === selected.taskId && value.task.operation === selected.operation ? selected : undefined;
  }
  function idsEqual(left: readonly string[], right: readonly string[]) { return left.length === right.length && left.every((id,index) => id === right[index]); }
  function actionPayload(value: Pick<AttemptDetail,"taskId"|"attemptId"|"operation">, unit: RecoveryUnit, action: TaskActionCommandPayload["action"], itemId?: string): TaskActionCommandPayload {
    return { kind: "task-action",taskId:value.taskId,attemptId:value.attemptId,operation:value.operation,unitId:unit.unitId,action,
      itemIds:[...unit.itemIds],remainingItemIds:[...unit.remainingItemIds],resultIds:[...unit.resultIds],offset,itemId:itemId ?? null };
  }
  function matchesAction(payload: TaskActionCommandPayload | TaskConfirmedCommandPayload, value: {taskId:string;attemptId:string;operation:string;action:TaskActionCommandPayload["action"];unit:RecoveryUnit;itemId?:string}) {
    return payload.taskId === value.taskId && payload.attemptId === value.attemptId && payload.operation === value.operation && payload.unitId === value.unit.unitId
      && payload.action === value.action && payload.itemId === (value.itemId ?? null) && idsEqual(payload.itemIds,value.unit.itemIds)
      && idsEqual(payload.remainingItemIds,value.unit.remainingItemIds) && idsEqual(payload.resultIds,value.unit.resultIds);
  }
  function actionAvailability(payload?: TaskActionCommandPayload, expected?: TaskActionCommandPayload["action"]): CommandAvailability {
    const allowed = gate(); if (!allowed.enabled) return allowed;
    const value = currentDetail(), unit = value?.recovery.units.find(unit => unit.unitId === payload?.unitId);
    return payload && value && unit && payload.action === expected && payload.offset === offset && unit.actions.includes(payload.action)
      && matchesAction(payload,{...value,unit,action:payload.action,itemId:payload.itemId ?? undefined}) && cancellations.canBegin(value.taskId)
      && (payload.action !== "query-outcome" || !!payload.itemId && unit.remainingItemIds.includes(payload.itemId))
      && !(payload.action === "adopt-result" && ["source-import","translation-import","ai-translation","arena-translation"].includes(value.operation)) ? {enabled:true} : unavailable;
  }
  function beginAction(payload: TaskActionCommandPayload) {
    const value = currentDetail(), unit = value?.recovery.units.find(unit => unit.unitId === payload.unitId);
    if (!value || !unit) return; rememberTrigger();
    void cancellations.beginFromQuery(projectionKey,value,unit,payload.action,payload.offset,payload.itemId ?? undefined);
  }
  function confirmedPayload(): TaskConfirmedCommandPayload | undefined {
    const value = cancellations.currentActivity(); if (!value) return undefined;
    const {offset:_offset,...scope} = actionPayload(value.intent,value.intent.unit,value.intent.action,value.intent.itemId);
    return {...scope,kind:"task-confirmed",cancellationRevision:value.intent.cancellationRevision};
  }
  function submitAvailability(payload?: TaskConfirmedCommandPayload): CommandAvailability {
    const allowed = gate(true); if (!allowed.enabled) return allowed; const value = cancellations.currentActivity();
    return !localConfirmation && showOwnerDialog && payload && value?.phase === "confirming" && matchesAction(payload,value.intent) && payload.cancellationRevision === value.intent.cancellationRevision
      && cancellations.canSubmit() ? {enabled:true} : unavailable;
  }
  function cancellationPayload(target: CancellationTarget): ExecutionCancellationCommandPayload { return {...target,kind:"execution-cancellation"}; }
  function sameCancellation(payload: CancellationTarget, target: CancellationTarget) { return payload.taskId === target.taskId && payload.attemptId === target.attemptId && payload.origin === target.origin; }
  function cancellationAvailability(payload?: ExecutionCancellationCommandPayload, confirmed = false): CommandAvailability {
    const allowed = gate(true); if (!allowed.enabled) return allowed;
    if (!payload || payload.origin !== "tasks") return unavailable;
    const activity = cancellations.currentActivity(); if (activity?.phase === "unknown") return {enabled:false,reason:"pending-action"};
    const target = confirmed ? localConfirmation?.cancellation : currentDetail(true);
    return target && ("origin" in target ? sameCancellation(payload,target) : payload.taskId === target.taskId && payload.attemptId === target.attemptId)
      && cancellations.canCancel(payload) ? {enabled:true} : unavailable;
  }
  function cancellationRetryAvailability(payload?: ExecutionCancellationRetryCommandPayload,retry=true): CommandAvailability {
    const allowed = gate(true); if (!allowed.enabled) return allowed; const value = payload && cancellations.current(payload.taskId);
    const activity = cancellations.currentActivity();
    if (activity && activity.intent.taskId === payload?.taskId && activity.phase !== "recorded" && activity.phase !== "rejected") return unavailable;
    return payload && value?.phase === "unknown" && (!retry || value.retryAllowed) && sameCancellation(payload,value.target) && payload.requestId === value.request.requestId ? {enabled:true} : unavailable;
  }
  function pendingPayload(): TaskPendingCommandPayload | undefined {
    const value = cancellations.currentActivity(); if (!value) return undefined;
    const target = {taskId:value.intent.taskId,attemptId:value.intent.attemptId,operation:value.intent.operation,unitId:value.intent.unit.unitId};
    if (value.prepare) return {...target,kind:"task-pending",requestKind:"adoption",actionId:value.prepare.actionId,resultIds:[...value.prepare.resultIds]};
    if (value.continuationRequest) { const action = value.continuationRequest.action; return {...target,kind:"task-pending",requestKind:"continuation",actionId:action.actionId,
      action:action.kind,itemIds:[...action.itemIds],expectedCancellationRevision:action.expectedCancellationRevision}; }
  }
  function pendingAvailability(payload: TaskPendingCommandPayload | undefined, kind: "adoption" | "continuation", retry = false): CommandAvailability {
    const allowed = gate(true); if (!allowed.enabled) return allowed; const value = cancellations.currentActivity(), original = pendingPayload();
    if (!payload || value?.phase !== "unknown" || !original || original.requestKind !== kind || payload.requestKind !== kind || retry && !value.retryAllowed
      || payload.taskId !== original.taskId || payload.attemptId !== original.attemptId || payload.operation !== original.operation
      || payload.unitId !== original.unitId || payload.actionId !== original.actionId) return unavailable;
    return payload.requestKind === "adoption" && original.requestKind === "adoption" ? idsEqual(payload.resultIds,original.resultIds) ? {enabled:true} : unavailable
      : payload.requestKind === "continuation" && original.requestKind === "continuation" && payload.action === original.action
        && payload.expectedCancellationRevision === original.expectedCancellationRevision && idsEqual(payload.itemIds,original.itemIds) ? {enabled:true} : unavailable;
  }
  function historyPayload(record: ContinuationReceipt): TaskHistoryCommandPayload {
    const action = record.action; return {kind:"task-history",taskId:record.taskId,sourceAttemptId:action.sourceAttemptId,operation:record.operation,actionId:action.actionId,
      unitId:action.unitId,action:action.kind,itemIds:[...action.itemIds],expectedCancellationRevision:action.expectedCancellationRevision,attemptId:record.attemptId,
      sequence:record.sequence,requestDigest:record.requestDigest,sourceInputDigest:record.sourceInputDigest,inputDigest:record.inputDigest,cursor:continuationCursor};
  }
  function historyRecord(payload: TaskHistoryCommandPayload) {
    const value = currentDetail(), page = value && currentRead<ContinuationPage>(["execution-continuations",value.attemptId,continuationCursor]);
    return value && payload.sourceAttemptId === value.attemptId && payload.taskId === value.taskId && payload.operation === value.operation && payload.cursor === continuationCursor
      ? page?.receipts.find(record => { const actual = historyPayload(record); return actual.actionId === payload.actionId && actual.unitId === payload.unitId && actual.action === payload.action
        && idsEqual(actual.itemIds,payload.itemIds) && actual.expectedCancellationRevision === payload.expectedCancellationRevision && actual.attemptId === payload.attemptId
        && actual.sequence === payload.sequence && actual.requestDigest === payload.requestDigest && actual.sourceInputDigest === payload.sourceInputDigest && actual.inputDigest === payload.inputDigest; }) : undefined;
  }
  function historyAvailability(payload?: TaskHistoryCommandPayload): CommandAvailability {
    const allowed = gate(); if (!allowed.enabled) return allowed;
    return payload && !selectedContinuation.isFetching && historyRecord(payload) ? {enabled:true} : unavailable;
  }
  function receiptPayload(value: AttemptDetail, unit: RecoveryUnit): TaskReceiptCommandPayload | undefined {
    return unit.receiptId ? {kind:"task-receipt",taskId:value.taskId,attemptId:value.attemptId,operation:value.operation,unitId:unit.unitId,actionId:unit.receiptId} : undefined;
  }
  function receiptAvailability(payload?: TaskReceiptCommandPayload): CommandAvailability {
    const allowed = gate(); if (!allowed.enabled) return allowed; const value = currentDetail();
    return payload && value && payload.taskId === value.taskId && payload.attemptId === value.attemptId && payload.operation === value.operation
      && value.recovery.units.some(unit => unit.unitId === payload.unitId && unit.receiptId === payload.actionId && unit.actions.includes("view-receipt")) ? {enabled:true} : unavailable;
  }
  function outputPayload(value: AttemptDetail, item: AttemptDetail["items"][number]): TaskOutputCommandPayload | undefined {
    return item.resultId ? {kind:"task-output",taskId:value.taskId,attemptId:value.attemptId,operation:value.operation,itemId:item.status.itemId,resultId:item.resultId} : undefined;
  }
  function outputAvailability(payload?: TaskOutputCommandPayload): CommandAvailability {
    const allowed = gate(true); if (!allowed.enabled) return allowed; const value = currentDetail();
    return payload && value && payload.taskId === value.taskId && payload.attemptId === value.attemptId && payload.operation === value.operation
      && value.items.some(item => item.status.itemId === payload.itemId && item.resultId === payload.resultId) ? {enabled:true} : unavailable;
  }
  function previewPayload(value: AttemptDetail, unitId: string | null = null): TaskPreviewCommandPayload | undefined {
    const area = value.operation === "source-import" ? "source" : value.operation === "translation-import" ? "translation"
      : value.operation === "ai-translation" ? "ai" : value.operation === "arena-translation" ? "arena" : undefined;
    return area ? {kind:"task-preview",taskId:value.taskId,attemptId:value.attemptId,operation:value.operation,area,unitId} : undefined;
  }
  function previewAvailability(payload?: TaskPreviewCommandPayload): CommandAvailability {
    const allowed = gate(); if (!allowed.enabled) return allowed; const value = currentDetail(), actual = value && previewPayload(value,payload?.unitId ?? null);
    if (!payload || !value || !actual || actual.taskId !== payload.taskId || actual.attemptId !== payload.attemptId || actual.operation !== payload.operation || actual.area !== payload.area) return unavailable;
    const callback = payload.area === "source" ? onSourcePreview : payload.area === "translation" ? onTranslationPreview : payload.area === "ai" ? onAiPreview : onArenaPreview;
    return callback && (payload.unitId ? value.recovery.units.some(unit => unit.unitId === payload.unitId && unit.actions.includes("adopt-result"))
      : payload.area === "ai" || payload.area === "arena" || value.items.some(item => item.status.validation === "valid")) ? {enabled:true} : unavailable;
  }
  function savedBuildPayload(value: AttemptDetail, item?: AttemptDetail["items"][number]): TaskSavedBuildCommandPayload {
    return { kind: "task-saved-build", taskId: value.taskId, attemptId: value.attemptId, operation: "locale-build",
      itemId: item?.status.itemId ?? null, resultId: item?.resultId ?? null };
  }
  function savedBuildAvailability(payload?: TaskSavedBuildCommandPayload): CommandAvailability {
    const allowed = gate(); if (!allowed.enabled) return allowed;
    const value = currentDetail();
    return payload && onSavedBuild && value?.operation === "locale-build" && payload.taskId === value.taskId && payload.attemptId === value.attemptId
      && (payload.itemId === null ? payload.resultId === null : value.items.some(item => item.status.itemId === payload.itemId && item.resultId === payload.resultId && item.resultId !== null))
      ? { enabled: true } : unavailable;
  }
  async function openSavedBuild(payload: TaskSavedBuildCommandPayload) {
    if (!savedBuildAvailability(payload).enabled || savedRoute.current) return;
    savedRoute.current = true; setRouting(true);
    try {
      const accepted = await onSavedBuild?.(payload.attemptId);
      if (mounted.current && !reads.retired && !accepted) setMessage("savedBuildBlocked");
    } catch (error) { if (mounted.current && !reads.retired) showError(error); }
    finally { savedRoute.current = false; if (mounted.current && !reads.retired) setRouting(false); }
  }
  useLayoutEffect(() => {
    const metadata = {category:"tasks" as const,scope:commandScope,binding:null,confirmation:"none" as const};
    const remove = [
      registry.register({...metadata,id:"tasks.adopt-result",nameKey:"execution.actions.adopt-result",risk:"captures-execution-action",payloadKind:"task-action",availability:payload=>actionAvailability(payload,"adopt-result"),handler:beginAction}),
      registry.register({...metadata,id:"tasks.resume-undispatched",nameKey:"execution.actions.resume-undispatched",risk:"captures-execution-action",payloadKind:"task-action",availability:payload=>actionAvailability(payload,"resume-undispatched"),handler:beginAction}),
      registry.register({...metadata,id:"tasks.retry-safe-failure",nameKey:"execution.actions.retry-safe-failure",risk:"captures-execution-action",payloadKind:"task-action",availability:payload=>actionAvailability(payload,"retry-safe-failure"),handler:beginAction}),
      registry.register({...metadata,id:"tasks.validate-output",nameKey:"execution.actions.validate-output",risk:"captures-execution-action",payloadKind:"task-action",availability:payload=>actionAvailability(payload,"validate-output"),handler:beginAction}),
      registry.register({...metadata,id:"tasks.query-outcome",nameKey:"execution.actions.query-outcome",risk:"captures-execution-action",payloadKind:"task-action",availability:payload=>actionAvailability(payload,"query-outcome"),handler:beginAction}),
      registry.register({...metadata,id:"tasks.submit-action",nameKey:"execution.confirm",risk:"writes-execution",confirmation:"required",payloadKind:"task-confirmed",availability:submitAvailability,handler:()=>{void cancellations.submit(continueCaptured);}}),
      registry.register({...metadata,id:"tasks.confirm-cancellation",nameKey:"execution.cancel",risk:"cancels-execution-task",payloadKind:"execution-cancellation",availability:payload=>cancellationAvailability(payload),handler:payload=>{rememberTrigger();setConfirmation({action:"cancel",cancellation:{taskId:payload.taskId,attemptId:payload.attemptId,origin:payload.origin}});}}),
      registry.register({...metadata,id:"tasks.cancel-task",nameKey:"execution.cancel",risk:"cancels-execution-task",confirmation:"required",payloadKind:"execution-cancellation",availability:payload=>cancellationAvailability(payload,true),handler:({taskId,attemptId,origin})=>{void cancellations.cancel({taskId,attemptId,origin});}}),
      registry.register({...metadata,id:"tasks.retry-cancellation",nameKey:"execution.retryCancellation",risk:"retries-execution-action",payloadKind:"execution-cancellation-retry",availability:cancellationRetryAvailability,handler:payload=>{void cancellations.retry(payload.taskId);}}),
      registry.register({...metadata,id:"tasks.check-cancellation",nameKey:"execution.checkCancellation",risk:"reads-execution",payloadKind:"execution-cancellation-retry",availability:payload=>cancellationRetryAvailability(payload,false),handler:payload=>{void cancellations.checkCancellation(payload.taskId);}}),
      registry.register({...metadata,id:"tasks.reconcile-adoption",nameKey:"execution.checkReceipt",risk:"reads-execution",payloadKind:"task-pending",availability:payload=>pendingAvailability(payload,"adoption"),handler:()=>{void cancellations.checkAdoption();}}),
      registry.register({...metadata,id:"tasks.retry-adoption",nameKey:"execution.retryAdoption",risk:"retries-execution-action",payloadKind:"task-pending",availability:payload=>pendingAvailability(payload,"adoption",true),handler:()=>{void cancellations.retryAdoption();}}),
      registry.register({...metadata,id:"tasks.reconcile-continuation",nameKey:"execution.checkContinuation",risk:"reads-execution",payloadKind:"task-pending",availability:payload=>pendingAvailability(payload,"continuation"),handler:()=>{void cancellations.checkContinuation();}}),
      registry.register({...metadata,id:"tasks.retry-continuation",nameKey:"execution.retryContinuation",risk:"retries-execution-action",payloadKind:"task-pending",availability:payload=>pendingAvailability(payload,"continuation",true),handler:()=>{void cancellations.retryContinuation();}}),
      registry.register({...metadata,id:"tasks.view-continuation",nameKey:"execution.viewContinuation",risk:"reads-execution",payloadKind:"task-history",availability:historyAvailability,handler:payload=>{const record=historyRecord(payload);if(record){setFailure(null);setHistorySelection({id:++historyIntent.current,record:structuredClone(record)});}}}),
      registry.register({...metadata,id:"tasks.view-receipt",nameKey:"execution.actions.view-receipt",risk:"reads-execution",payloadKind:"task-receipt",availability:receiptAvailability,handler:payload=>{setReceipt({attemptId:payload.attemptId,unitId:payload.unitId,actionId:payload.actionId});}}),
      registry.register({...metadata,id:"tasks.open-saved-build",nameKey:"releasePlugin.savedOpen",risk:"reads-execution",payloadKind:"task-saved-build",availability:savedBuildAvailability,handler:payload=>{void openSavedBuild(payload);}}),
      registry.register({...metadata,id:"tasks.view-output",nameKey:"execution.output",risk:"reads-execution",payloadKind:"task-output",availability:outputAvailability,handler:payload=>{if(payload.operation === "locale-build")setSavedOutput({attemptId:payload.attemptId,itemId:payload.itemId,resultId:payload.resultId});else setOutput({attemptId:payload.attemptId,itemId:payload.itemId,resultId:payload.resultId});}}),
      registry.register({...metadata,id:"tasks.open-preview",nameKey:"execution.actions.adopt-result",risk:"opens-execution-preview",payloadKind:"task-preview",availability:previewAvailability,handler:payload=>{
        if(payload.area==="source")onSourcePreview?.(payload.attemptId);else if(payload.area==="translation")onTranslationPreview?.(payload.attemptId);
        else if(payload.area==="ai")onAiPreview?.(payload.attemptId);else onArenaPreview?.(payload.attemptId);
      }}),
    ]; return () => remove.forEach(dispose=>dispose());
  });
  const feedback = <><TaskCancellationFeedback origin="tasks" taskId={taskId ?? undefined} disabled={busy} visible={active} retryCommand={{
    available:intent=>cancellationRetryAvailability({...intent,kind:"execution-cancellation-retry"}).enabled,
    dispatch:intent=>{registry.dispatch("tasks.retry-cancellation",commandScope,{...intent,kind:"execution-cancellation-retry"});},
  }} checkCommand={{available:intent=>cancellationRetryAvailability({...intent,kind:"execution-cancellation-retry"},false).enabled,
    dispatch:intent=>{registry.dispatch("tasks.check-cancellation",commandScope,{...intent,kind:"execution-cancellation-retry"});}}} />
    {Object.values(cancellations.state).some(value=>value.phase === "unknown") ? <>
      <p role="status">{t("execution.cancellationUnconfirmed")}</p>
      {confirmation?.action === "cancel" ? <button className="text-button" onClick={closeConfirmation}>{t("execution.deferContinuation")}</button> : null}
    </> : null}
    {displayedFailure ? <div role="alert" tabIndex={-1} ref={errorRegion}><p>{t(`execution.errors.${errorKey}`)}</p><CommandFailureDetails failure={displayedFailure} /></div> : null}
    {activity?.phase === "capturing" ? <p role="status">{t("execution.capturing")}</p> : null}
    {activity?.phase === "checking" && activity.prepare ? <p role="status">{t("execution.checkingAdoption")}</p> : null}
    {activity?.phase === "checking" && activity.continuationRequest ? <p role="status">{t("execution.checkingContinuation")}</p> : null}
    {activity?.phase === "unknown" ? <section aria-label={t("execution.originalAction")}>
      <p role="status">{t(activity.continuationRequest ? "execution.continuationUnconfirmed" : activity.intent.action === "adopt-result"
        ? activity.uncertain && typeof activity.failure === "object" && activity.failure?.outcome === "rejected" ? "execution.adoptionUnconfirmed" : "execution.adoptionUnknown"
        : "execution.recoveryUnknown")}</p>
      <ul>{activity.intent.unit.scopes.map((scope, index) => <li key={activity.intent.unit.itemIds[index]}>{scope.id}{scope.locale ? ` · ${scope.locale}` : ""}</li>)}</ul>
      <details><summary>{t("execution.diagnostic")}</summary><pre>{JSON.stringify({ taskId: activity.intent.taskId, operation: activity.intent.operation,
        unit: activity.intent.unit, request: activity.continuationRequest ?? activity.prepare ?? activity.recoveryRequest }, null, 2)}</pre></details>
      {activity.prepare ? <div className="execution-actions">
        <button className="secondary-button" disabled={!pendingAvailability(pendingPayload(),"adoption").enabled} onClick={() => { const payload=pendingPayload();if(payload)registry.dispatch("tasks.reconcile-adoption",commandScope,payload); }}>{t("execution.checkReceipt")}</button>
        {activity.retryAllowed ? <><p role="status">{t("execution.noReceipt")}</p><button className="secondary-button" disabled={!pendingAvailability(pendingPayload(),"adoption",true).enabled} onClick={() => { const payload=pendingPayload();if(payload)registry.dispatch("tasks.retry-adoption",commandScope,payload); }}>{t("execution.retryAdoption")}</button></> : null}
      </div> : null}
      {activity.continuationRequest ? <div className="execution-actions">
        <button className="secondary-button" disabled={!pendingAvailability(pendingPayload(),"continuation").enabled} onClick={() => { const payload=pendingPayload();if(payload)registry.dispatch("tasks.reconcile-continuation",commandScope,payload); }}>{t("execution.checkContinuation")}</button>
        {activity.retryAllowed ? <><p role="status">{t("execution.noContinuation")}</p><button className="secondary-button" disabled={!pendingAvailability(pendingPayload(),"continuation",true).enabled} onClick={() => { const payload=pendingPayload();if(payload)registry.dispatch("tasks.retry-continuation",commandScope,payload); }}>{t("execution.retryContinuation")}</button></> : null}
      </div> : null}
      <button className="text-button" disabled={busy} onClick={() => { setConfirmation(null); setShowOwnerDialog(false); }}>{t(activity.continuationRequest ? "execution.deferContinuation" : "execution.keepOutput")}</button>
    </section> : null}
    {activity?.phase === "recorded" && activity.receipt ? <p role="status">{t("execution.adoptionRecorded")}</p> : message ? <p role="status">{t(`execution.${message}`)}</p> : null}</>;
  const titleFor = (action: Confirmation["action"]) => action === "cancel" ? t("execution.cancel")
    : action === "adopt-result" && activity?.intent.operation === "ai-semantic-review" ? t("semanticReview.confirmRecord") : t(`execution.actions.${action}`);
  const confirmationCount = confirmation?.itemId ? 1 : confirmation?.unit?.itemIds.length ?? 0;
  const blockedKey = (reason: string) => reason === "external-new-consent" ? "externalConsent" : reason === "outcome-unknown" ? "unknown" : reason === "scope-removed" ? "scopeRemoved" : reason === "output-invalid" ? "invalid" : reason === "retry-not-safe" ? "retryUnsafe" : "blocked";
  const navigationBlocked = !gate().enabled;
  return <div className="execution-content" aria-busy={busy || cancelling || loading || routing}>
    {!confirmation ? feedback : null}
    <div className="execution-actions">
      {taskId ? <button className="secondary-button" disabled={navigationBlocked} onClick={() => selectTask(null)}>{t("execution.allTasks")}</button> : null}
      <button className="secondary-button" disabled={busy} onClick={() => reads.invalidate(["execution"], false)}>{t("execution.refresh")}</button>
    </div>
    {loading ? <p role="status">{t("execution.loading")}</p> : null}
    {!taskId ? <>
      {!loading && tasks.length === 0 ? <p>{t("execution.empty")}</p> : null}
      {tasks.length > 0 ? <p>{t("execution.listHelp")}</p> : null}
      <ul className="execution-list">{tasks.map(task => <li key={task.taskId}>
        <button className="secondary-button" onClick={() => selectTask(task.taskId)} disabled={navigationBlocked}>
          {t(task.operation === "source-import" ? "source.title" : task.operation === "translation-import" ? "translation.title" : task.operation === "ai-translation" ? "ai.title" : task.operation === "ai-semantic-review" ? "semanticReview.title" : task.operation === "locale-build" ? "release.title" : task.operation === "sample-update" ? "execution.sampleOperation" : "execution.operation")} · {t("execution.taskNumber", { number: task.sequence })}
        </button>
      </li>)}</ul>
      {cursor !== "0" || tasks.length === 50 ? <div className="execution-actions">
        <button className="text-button" disabled={cursor === "0" || navigationBlocked} onClick={() => { if (gate().enabled) setCursor("0"); }}>{t("execution.firstPage")}</button>
        <button className="text-button" disabled={tasks.length < 50 || navigationBlocked} onClick={() => { if (gate().enabled) setCursor(tasks.at(-1)!.sequence); }}>{t("execution.nextPage")}</button>
      </div> : null}
    </> : <>
      <label className="field execution-attempt">{t("execution.attempt")}
        <select disabled={navigationBlocked} value={attemptId ?? detail?.attemptId ?? ""} onChange={event => {
          setAttemptId(event.target.value); setContinuationCursor("0"); setHistorySelection(null); setOffset(0); setOutput(null); setSavedOutput(null); setReceipt(null);
        }}>
          {attempts.map(attempt => <option key={attempt.attemptId} value={attempt.attemptId}>{t("execution.attemptNumber", { number: attempt.sequence })}</option>)}
          {detail && !attempts.some(attempt => attempt.attemptId === detail.attemptId) ? <option value={detail.attemptId}>{t("execution.currentAttempt")}</option> : null}
        </select>
      </label>
      {attemptCursor !== "0" || attempts.length === 100 ? <div className="execution-actions">
        <button className="text-button" disabled={attemptCursor === "0" || navigationBlocked} onClick={() => { setAttemptCursor("0"); setAttemptId(null); setContinuationCursor("0"); setHistorySelection(null); }}>{t("execution.firstPage")}</button>
        <button className="text-button" disabled={attempts.length < 100 || navigationBlocked} onClick={() => { setAttemptCursor(attempts.at(-1)!.sequence); setAttemptId(null); setContinuationCursor("0"); setHistorySelection(null); }}>{t("execution.nextPage")}</button>
      </div> : null}
      {detail ? <>
        <section className="execution-summary" aria-label={t("execution.summary")}>
          <strong>{t("execution.progress", { generated: detail.progress.succeeded, adopted: detail.progress.adopted, total: detail.progress.total })}</strong>
          <p>{t("execution.statusCounts", { failed: detail.progress.failed, unknown: detail.progress.unknown, running: detail.progress.running, queued: detail.progress.queued, cancelled: detail.progress.cancelled })}</p>
          <small>{t("execution.applicationHelp")}</small>
        </section>
        <section aria-label={t("execution.nextSteps")}>
          <div className="execution-section-heading"><h3>{t("execution.nextSteps")}</h3>
            <button className="text-button" disabled={!cancelTarget || !cancellationAvailability(cancellationPayload(cancelTarget)).enabled} onClick={() => { if(cancelTarget)registry.dispatch("tasks.confirm-cancellation",commandScope,cancellationPayload(cancelTarget)); }}>{t("execution.cancel")}</button>
          </div>
          {detail.recovery.units.map(unit => <section className="execution-unit" key={unit.unitId}>
            <details><summary>{t("execution.groupScope", { count: unit.itemIds.length })}</summary>
              <ul>{unit.scopes.map((scope, index) => <li key={unit.itemIds[index]}>{scope.id}{scope.locale ? ` · ${scope.locale}` : ""}</li>)}</ul>
            </details>
            {unit.blockedReason ? <p>{t(unit.blockedReason === "continued-in-new-attempt" ? "execution.continued" : unit.blockedReason === "still-running" ? "execution.running" : `execution.errors.${blockedKey(unit.blockedReason)}`)}</p> : null}
            <div className="execution-actions">{unit.actions.map(action => action === "query-outcome" ? unit.remainingItemIds.map(id =>
              <button className="secondary-button" key={id} disabled={!actionAvailability(actionPayload(detail,unit,action,id),action).enabled} onClick={() => { registry.dispatch("tasks.query-outcome",commandScope,actionPayload(detail,unit,action,id)); }}>{t(`execution.actions.${action}`)} · {unit.scopes[unit.itemIds.indexOf(id)]?.id}</button>
            ) : <button className={action === "adopt-result" || action === "retry-safe-failure" || action === "resume-undispatched" ? "primary-button" : "secondary-button"} key={action} disabled={action === "view-receipt" ? !receiptAvailability(receiptPayload(detail,unit)).enabled
              : action === "adopt-result" && previewPayload(detail,unit.unitId) ? !previewAvailability(previewPayload(detail,unit.unitId)).enabled
              : !actionAvailability(actionPayload(detail,unit,action),action).enabled} onClick={() => {
              if(action === "view-receipt"){const payload=receiptPayload(detail,unit);if(payload)registry.dispatch("tasks.view-receipt",commandScope,payload);}
              else if(action === "adopt-result" && previewPayload(detail,unit.unitId)){const payload=previewPayload(detail,unit.unitId);if(payload)registry.dispatch("tasks.open-preview",commandScope,payload);}
              else registry.dispatch(actionCommands[action],commandScope,actionPayload(detail,unit,action));
            }}>{t(action === "adopt-result" && detail.operation === "source-import" ? "source.preview" : action === "adopt-result" && detail.operation === "translation-import" ? "translation.preview" : action === "adopt-result" && detail.operation === "ai-semantic-review" ? "semanticReview.record" : `execution.actions.${action}`)}</button>)}</div>
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
              <button className="text-button" disabled={!historyAvailability(historyPayload(record)).enabled}
                onClick={() => { registry.dispatch("tasks.view-continuation",commandScope,historyPayload(record)); }}>{t("execution.viewContinuation")}</button>
            </li>)}</ul>
            {continuationCursor !== "0" || continuationHistory.data.next !== null ? <div className="execution-actions">
              <button className="text-button" disabled={busy || pendingAction !== null || continuationCursor === "0"} onClick={() => setContinuationCursor("0")}>{t("execution.firstPage")}</button>
              <button className="text-button" disabled={busy || pendingAction !== null || continuationHistory.data.next === null} onClick={() => { const next = continuationHistory.data?.next; if (next) setContinuationCursor(next); }}>{t("execution.nextPage")}</button>
            </div> : null}
          </> : null}
        </section>
        {detail.operation === "locale-build" && onSavedBuild ? <button className="secondary-button" disabled={!savedBuildAvailability(savedBuildPayload(detail)).enabled} onClick={() => registry.dispatch("tasks.open-saved-build",commandScope,savedBuildPayload(detail))}>{t("releasePlugin.savedOpen")}</button> : null}
        <h3>{t("execution.itemResults")}</h3>{detail.operation === "arena-translation" ? <button className="secondary-button" disabled={!previewAvailability(previewPayload(detail)).enabled} onClick={() => { const payload=previewPayload(detail);if(payload)registry.dispatch("tasks.open-preview",commandScope,payload); }}>{t("arena.open")}</button> : null}{detail.operation === "ai-translation" ? <button className="secondary-button" disabled={!previewAvailability(previewPayload(detail)).enabled} onClick={() => { const payload=previewPayload(detail);if(payload)registry.dispatch("tasks.open-preview",commandScope,payload); }}>{t("ai.results")}</button> : null}
        {detail.operation === "source-import" && detail.items.some(item => item.status.validation === "valid") ? <button className="secondary-button" disabled={!previewAvailability(previewPayload(detail)).enabled} onClick={() => { const payload=previewPayload(detail);if(payload)registry.dispatch("tasks.open-preview",commandScope,payload); }}>{t("source.preview")}</button> : null}
        {detail.operation === "translation-import" && detail.items.some(item => item.status.validation === "valid") ? <button className="secondary-button" disabled={!previewAvailability(previewPayload(detail)).enabled} onClick={() => { const payload=previewPayload(detail);if(payload)registry.dispatch("tasks.open-preview",commandScope,payload); }}>{t("translation.preview")}</button> : null}
        <ul className="execution-list">{detail.items.map(item => <li key={item.status.itemId}>
          <div className="execution-item-heading"><strong>{item.scope.id}{item.scope.locale ? ` · ${item.scope.locale}` : ""}</strong>
            {item.resultId ? <button className="text-button" disabled={!outputAvailability(outputPayload(detail,item)).enabled} onClick={() => { const payload=outputPayload(detail,item);if(payload)registry.dispatch("tasks.view-output",commandScope,payload); }}>{t(item.status.execution === "succeeded" ? "execution.output" : "execution.failureDetails")}</button> : null}
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
            {detail.operation !== "locale-build" && (output?.diagnostic || output?.sourceFailure) ? <>{output?.diagnostic && output.outcome !== "succeeded" ? <p>{t(output.diagnostic.retrySafe ? "execution.safeFailure" : "execution.unsafeFailure")}</p> : null}
              <ExecutionDiagnosticDetails code={output?.diagnostic?.code} sourceFailure={output?.sourceFailure} /></> : null}
          </div> : null}
        </li>)}</ul>
        {offset > 0 || detail.nextOffset !== null ? <div className="execution-actions">
          <button className="text-button" disabled={offset === 0 || navigationBlocked} onClick={() => { if (gate().enabled) { setOffset(Math.max(0, offset - 100)); setOutput(null); setSavedOutput(null); } }}>{t("execution.previousPage")}</button>
          <button className="text-button" disabled={detail.nextOffset === null || navigationBlocked} onClick={() => { if (gate().enabled) { setOffset(detail.nextOffset!); setOutput(null); setSavedOutput(null); } }}>{t("execution.nextPage")}</button>
        </div> : null}
      </> : null}
    </>}
    {shownReceipt ? <section className="execution-receipt" role="status"><h3>{t("execution.receipt")}</h3>{shownReceipt.changes.length === 0 ? <p>{t("execution.noChanges")}</p> : <ul>{shownReceipt.changes.map((change, index) => <li key={`${index}:${change.kind}:${change.id}`}>{change.id} · {t("execution.revision", { number: change.revision })}</li>)}</ul>}</section> : null}
    <Dialog.Root open={active && confirmation !== null} onOpenChange={open => { if (!open && !busy && !cancelling) closeConfirmation(); }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop" />
        <Dialog.Content className="confirm-dialog execution-confirm-dialog" onCloseAutoFocus={event => { event.preventDefault(); actionTrigger.current?.focus(); }} onEscapeKeyDown={event => { if (busy || cancelling) event.preventDefault(); }} onPointerDownOutside={event => event.preventDefault()}>
          <Dialog.Title>{confirmation ? titleFor(confirmation.action) : t("execution.nextSteps")}</Dialog.Title>
          <Dialog.Description>{confirmation?.action === "cancel" ? t("execution.cancelHelp")
            : confirmation?.action === "adopt-result" && activity?.intent.operation === "ai-semantic-review" ? t("semanticReview.recordHelp") : confirmation ? t(`execution.actionHelp.${confirmation.action}`, {
            count: confirmationCount, remaining: confirmation.unit?.remainingItemIds.length ?? 0,
            reused: (confirmation.unit?.itemIds.length ?? 0) - (confirmation.unit?.remainingItemIds.length ?? 0),
          }) : null}</Dialog.Description>
          <ul>{confirmation?.unit?.scopes.map((scope, index) => !confirmation.itemId || confirmation.unit?.itemIds[index] === confirmation.itemId ? <li key={index}>
            {scope.id}{scope.locale ? ` · ${scope.locale}` : ""}
            {confirmation.action === "resume-undispatched" || confirmation.action === "retry-safe-failure" ? <small> · {t(confirmation.unit!.remainingItemIds.includes(confirmation.unit!.itemIds[index]) ? "execution.willRun" : "execution.reuse")}</small> : null}
          </li> : null)}</ul>
          {feedback}
          <div className="form-actions"><button className="secondary-button" disabled={busy || cancelling} onClick={closeConfirmation}>{t("execution.back")}</button>
            <button className="primary-button" disabled={confirmation?.action === "cancel" ? !confirmation.cancellation || !cancellationAvailability(cancellationPayload(confirmation.cancellation),true).enabled : !submitAvailability(confirmedPayload()).enabled} onClick={() => {
              if(confirmation?.action === "cancel"){if(confirmation.cancellation)registry.dispatch("tasks.cancel-task",commandScope,cancellationPayload(confirmation.cancellation));}
              else {const payload=confirmedPayload();if(payload)registry.dispatch("tasks.submit-action",commandScope,payload);}
            }}>{busy || cancelling ? t("execution.working") : confirmation ? titleFor(confirmation.action) : t("execution.confirm")}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
