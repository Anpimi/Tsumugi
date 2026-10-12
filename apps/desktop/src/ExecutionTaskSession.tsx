import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, confirmExecutionAction, confirmExecutionReceipt, sameExecutionIds, type CancelRequest, type AttemptDetail, type RecoveryAction, type RecoveryUnit, type ItemView, type PrepareRequest, type AdoptionAction, type Receipt, type RecoveryRequest, type RecoveryView } from "./executionCommands";
import { validateRequestCancel, validateRequestPrepare, validateRequestRecovery, validateResponseIdentity, validateResponseAttempt } from "./generated/execution.validators";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionReads, useSessionAlive } from "./SessionReadProvider";
import { useTranslationDraftSession } from "./TranslationDraftSession";

type Origin = "tasks" | "source" | "ai" | "arena";
export interface CancellationTarget { readonly taskId: string; readonly attemptId: string; readonly origin: Origin }
type Cancellation = { target: CancellationTarget } & (
  | { phase: "preparing"; request: null; revision: null; failure: null }
  | { phase: "pending"; request: CancelRequest; revision: null; failure: null }
  | { phase: "unknown"; request: CancelRequest; revision: null; failure: CommandFailure }
  | { phase: "recorded"; request: CancelRequest; revision: string; failure: null }
  | { phase: "rejected"; request: CancelRequest | null; revision: null; failure: CommandFailure }
);
type Cancellations = Readonly<Record<string, Cancellation>>;
type PendingCancellation = Extract<Cancellation, { phase: "pending" }>;
type TaskAction = Exclude<RecoveryAction, "view-receipt">;
export interface TaskIntent {
  readonly taskId: string;
  readonly attemptId: string;
  readonly operation: string;
  readonly action: TaskAction;
  readonly unit: RecoveryUnit;
  readonly itemId?: string;
  readonly items: readonly ItemView[];
}
export interface TaskActivity {
  readonly intent: TaskIntent;
  readonly phase: "capturing" | "confirming" | "identifying" | "preparing" | "adopting" | "recovering" | "checking" | "unknown" | "recorded" | "rejected";
  readonly prepare: PrepareRequest | null;
  readonly proof: AdoptionAction | null;
  readonly receipt: Receipt | null;
  readonly recoveryRequest: RecoveryRequest | null;
  readonly recovery: RecoveryView | null;
  readonly retryAllowed: boolean;
  readonly uncertain: boolean;
  readonly failure: CommandFailure | null;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const activityBusy = (value: TaskActivity | null) => !!value && ["capturing", "identifying", "preparing", "adopting", "recovering", "checking"].includes(value.phase);
const activityUnresolved = (value: TaskActivity | null) => activityBusy(value) || value?.phase === "unknown";
const sameScope = (left: ItemView["scope"], right: ItemView["scope"]) => left.id === right.id && left.kind === right.kind && left.locale === right.locale;
function sameUnit(left: RecoveryUnit, right: RecoveryUnit) {
  return left.unitId === right.unitId && left.receiptId === right.receiptId && left.blockedReason === right.blockedReason
    && left.itemIds.length === right.itemIds.length && left.itemIds.every((id, index) => id === right.itemIds[index])
    && left.scopes.length === right.scopes.length && left.scopes.every((scope, index) => sameScope(scope, right.scopes[index]))
    && sameExecutionIds(left.remainingItemIds, right.remainingItemIds) && sameExecutionIds(left.resultIds, right.resultIds)
    && sameExecutionIds(left.actions, right.actions);
}
interface TaskSession {
  state: Cancellations;
  current: (taskId: string) => Cancellation | undefined;
  canCancel: (target: CancellationTarget, proof?: () => boolean) => boolean;
  cancel: (target: CancellationTarget, proof?: () => boolean) => Promise<void>;
  retry: (taskId: string) => Promise<void>;
  unresolved: () => boolean;
  activity: TaskActivity | null;
  currentActivity: () => TaskActivity | null;
  begin: (detail: AttemptDetail, unit: RecoveryUnit, action: TaskAction, offset: number, itemId?: string) => Promise<void>;
  submit: () => Promise<void>;
  checkAdoption: () => Promise<void>;
  retryAdoption: () => Promise<void>;
  dismiss: () => void;
  busy: boolean;
}
const TaskContext = createContext<TaskSession | null>(null);
export function useExecutionTaskSession() {
  const owner = useContext(TaskContext);
  if (!owner) throw new Error("Task cancellation requires a project session owner");
  return owner;
}
const unresolved = (value: Cancellation) => value.phase === "preparing" || value.phase === "pending" || value.phase === "unknown";

/** Own fixed task decisions and original requests independently of their consumers. */
export function ExecutionTaskSession({ project, children }: { project: ProjectView; children: ReactNode }) {
  const reads = useSessionReads();
  const translation = useTranslationDraftSession();
  const [session] = useState(() => Object.freeze(executionContext(project)));
  const [state, setState] = useState<Cancellations>(() => Object.freeze({}));
  const stateRef = useRef(state), projectRef = useRef(project), mounted = useSessionAlive();
  const [activity, setActivity] = useState<TaskActivity | null>(null);
  const activityRef = useRef<TaskActivity | null>(null);
  const reservation = useRef<symbol | null>(null);
  useLayoutEffect(() => { mounted.current = true; return () => {
    mounted.current = false; const token = reservation.current; reservation.current = null; if (token) translation.releaseMutation(token);
  }; }, []);
  useLayoutEffect(() => { projectRef.current = project; }, [project]);
  function live() {
    return mounted.current && projectRef.current.sessionToken === session.sessionToken && projectRef.current.metadata.projectId === session.projectId
      && reads.context.sessionToken === session.sessionToken && reads.context.projectId === session.projectId;
  }
  function current(taskId: string) { return stateRef.current[taskId]; }
  function replace(taskId: string, value: Cancellation | null) {
    if (!live()) return;
    const next = { ...stateRef.current };
    if (value) next[taskId] = Object.freeze(value); else delete next[taskId];
    stateRef.current = Object.freeze(next); setState(stateRef.current);
  }
  function canCancel(target: CancellationTarget, proof: () => boolean = live) {
    if (!live() || !proof() || !validateResponseIdentity(session.projectId) || !validateResponseIdentity(target.taskId) || !validateResponseIdentity(target.attemptId)
      || !validateRequestCancel({ ...session, taskId: target.taskId, requestId: target.taskId })
      || (activityRef.current?.intent.taskId === target.taskId && activityRef.current.phase !== "recorded" && activityRef.current.phase !== "rejected")) return false;
    const previous = current(target.taskId);
    return !previous || (!unresolved(previous) && !(previous.phase === "recorded" && previous.target.attemptId === target.attemptId));
  }
  async function dispatch(value: PendingCancellation, retryingUnknown = false) {
    const { taskId } = value.request;
    try {
      const revision = await executionCommands.cancel(value.request);
      if (live() && current(taskId) === value) replace(taskId, { target: value.target, phase: "recorded", request: value.request, revision, failure: null });
    } catch (error) {
      if (live() && current(taskId) === value) {
        const failure = commandFailure(error, "outcome-unknown");
        // Rejecting a replay cannot disprove the earlier uncertain invocation.
        replace(taskId, retryingUnknown || hasUnknownOutcome(error)
          ? { target: value.target, phase: "unknown", request: value.request, revision: null, failure }
          : { target: value.target, phase: "rejected", request: value.request, revision: null, failure });
      }
    } finally {
      if (live()) reads.invalidate(["execution"]);
    }
  }
  async function cancel(target: CancellationTarget, proof: () => boolean = live) {
    if (!canCancel(target, proof)) return;
    // Reserve before the first identity await, including calls from another view.
    const captured = Object.freeze({ ...target }), taskId = captured.taskId;
    const reserved: Cancellation = { target: captured, phase: "preparing", request: null, revision: null, failure: null };
    replace(taskId, reserved);
    try {
      const requestId = await executionCommands.identity(session);
      if (!live() || current(taskId) !== reserved) return;
      if (!proof()) { replace(taskId, null); return; }
      const request = Object.freeze({ ...session, taskId, requestId });
      if (!validateRequestCancel(request)) throw new Error("Invalid cancellation request");
      const pending: PendingCancellation = { target: reserved.target, phase: "pending", request, revision: null, failure: null };
      replace(taskId, pending);
      await dispatch(pending);
    } catch (error) {
      if (live() && current(taskId) === reserved) replace(taskId, { target: reserved.target, phase: "rejected", request: null,
        revision: null, failure: commandFailure(error) });
    }
  }
  async function retry(taskId: string) {
    const original = current(taskId);
    if (!live() || original?.phase !== "unknown" || !validateRequestCancel(original.request)
      || (activityRef.current?.intent.taskId === taskId && activityUnresolved(activityRef.current))) return;
    const pending: PendingCancellation = { target: original.target, phase: "pending", request: original.request, revision: null, failure: null };
    replace(taskId, pending);
    await dispatch(pending, true);
  }
  function updateActivity(value: TaskActivity | null) {
    if (!live()) return;
    activityRef.current = value ? freeze(value) : null;
    setActivity(activityRef.current);
  }
  function holds(value: TaskActivity) { return live() && activityRef.current === value; }
  function change(value: TaskActivity, patch: Partial<TaskActivity>) {
    const next = { ...value, ...patch };
    updateActivity(next);
    return next;
  }
  function release() {
    const token = reservation.current; reservation.current = null;
    if (token) translation.releaseMutation(token);
  }
  function dismiss() { if (live() && !activityUnresolved(activityRef.current)) { updateActivity(null); release(); } }
  function cancellationBlocks(taskId: string) {
    const value = current(taskId);
    // A settled cancellation does not replace Core's basis for a new explicit action.
    return !!value && unresolved(value);
  }
  function canBegin() { return live() && !activityUnresolved(activityRef.current) && activityRef.current?.phase !== "confirming"; }

  async function begin(detail: AttemptDetail, unit: RecoveryUnit, action: TaskAction, offset: number, itemId?: string) {
    if (!canBegin() || cancellationBlocks(detail.taskId)) return;
    // These domains require their own preview and complete authorization flow.
    if (action === "adopt-result" && ["source-import", "translation-import", "ai-translation", "arena-translation"].includes(detail.operation)) return;
    const intent: TaskIntent = freeze({ taskId: detail.taskId, attemptId: detail.attemptId, operation: detail.operation, action,
      unit: structuredClone(unit), ...(itemId ? { itemId } : {}), items: [] });
    let value: TaskActivity = { intent, phase: "capturing", prepare: null, proof: null, receipt: null,
      recoveryRequest: null, recovery: null, retryAllowed: false, uncertain: false, failure: null };
    updateActivity(value);
    try {
      if (!validateResponseAttempt(detail) || !validateResponseIdentity(detail.taskId) || !validateResponseIdentity(session.projectId)
        || detail.recovery.attemptId !== intent.attemptId || !unit.actions.includes(action)
        || !sameExecutionIds(unit.itemIds, unit.itemIds) || unit.itemIds.length === 0 || unit.scopes.length !== unit.itemIds.length
        || !sameExecutionIds(unit.remainingItemIds, unit.remainingItemIds) || unit.remainingItemIds.some(id => !unit.itemIds.includes(id))
        || !sameExecutionIds(unit.resultIds, unit.resultIds)
        || (action === "query-outcome" && (!itemId || !unit.remainingItemIds.includes(itemId)))
        || (action !== "query-outcome" && itemId !== undefined)) throw new Error("Invalid task confirmation scope");
      const items: ItemView[] = [];
      let pageOffset = 0;
      const total = detail.progress.total, initial = structuredClone(detail);
      do {
        const page = pageOffset === offset ? initial : await executionCommands.attempt({ ...session, attemptId: intent.attemptId, offset: pageOffset, limit: 100 });
        if (!holds(value)) return;
        if (page.attemptId !== intent.attemptId || page.taskId !== intent.taskId || page.operation !== intent.operation
          || page.recovery.attemptId !== intent.attemptId || page.progress.total !== total || page.items.length > 100
          || pageOffset + page.items.length > total
          || (page.nextOffset !== null ? page.nextOffset !== pageOffset + page.items.length || page.nextOffset <= pageOffset : pageOffset + page.items.length !== total)) throw new Error("Invalid task confirmation page");
        const members = page.items.filter(item => intent.unit.itemIds.includes(item.status.itemId));
        const returnedUnit = page.recovery.units.filter(candidate => candidate.unitId === intent.unit.unitId);
        if (members.length && (returnedUnit.length !== 1 || !sameUnit(returnedUnit[0], intent.unit))) throw new Error("Task confirmation scope changed");
        items.push(...page.items);
        if (page.nextOffset === null) break;
        pageOffset = page.nextOffset;
      } while (true);
      if (!sameExecutionIds(items.map(item => item.status.itemId), items.map(item => item.status.itemId))) throw new Error("Duplicate task confirmation items");
      const selected = intent.unit.itemIds.map((id, index) => {
        const item = items.find(candidate => candidate.status.itemId === id);
        if (!item || !sameScope(item.scope, intent.unit.scopes[index])) throw new Error("Missing task confirmation item");
        return item;
      });
      if (action === "adopt-result" && (!sameExecutionIds(selected.flatMap(item => item.resultId ? [item.resultId] : []), intent.unit.resultIds)
        || selected.some(item => item.status.execution !== "succeeded" || item.status.validation !== "valid"))) throw new Error("Invalid task result coverage");
      value = change(value, { phase: "confirming", intent: freeze({ ...intent, items: structuredClone(selected) }) });
    } catch (error) {
      if (holds(value)) change(value, { phase: "rejected", failure: commandFailure(error, "output-invalid") });
    }
  }
  function fail(value: TaskActivity, error: unknown, dispatched: boolean) {
    if (!holds(value)) return;
    const uncertain = value.uncertain || (dispatched && hasUnknownOutcome(error));
    change(value, { phase: uncertain ? "unknown" : "rejected", uncertain, retryAllowed: false, failure: commandFailure(error, dispatched ? "outcome-unknown" : "failed") });
    if (!uncertain) release();
  }
  function settle(value: TaskActivity, receipt: Receipt) {
    if (!holds(value) || !value.proof || !value.prepare) return;
    const checked = confirmExecutionReceipt(value.prepare, receipt, value.receipt);
    change(value, { phase: "recorded", receipt: freeze(structuredClone(checked)), uncertain: false, retryAllowed: false, failure: null });
    release();
    // Generic change kinds belong to their handlers, so do not guess a domain mapping.
    reads.invalidate(["project"]);
  }
  async function dispatchAdoption(start: TaskActivity) {
    if (!holds(start) || !start.prepare || !reservation.current) return;
    let value = change(start, { phase: "preparing", retryAllowed: false, failure: null });
    try {
      const action = await executionCommands.prepare(value.prepare!);
      if (!holds(value)) return;
      const proof = freeze(structuredClone(confirmExecutionAction(value.prepare!, value.intent.operation, action, value.proof)));
      value = change(value, { proof });
      if (value.receipt) { settle(value, value.receipt); return; }
      value = change(value, { phase: "adopting" });
      const receipt = await executionCommands.adopt(freeze({ ...session, actionId: value.prepare!.actionId }));
      if (holds(value)) settle(value, receipt);
    } catch (error) { fail(value, error, true); }
  }
  async function submit() {
    const start = activityRef.current;
    if (!live() || start?.phase !== "confirming" || cancellationBlocks(start.intent.taskId)) return;
    if (start.intent.action !== "adopt-result") {
      const request: RecoveryRequest = freeze({ ...session, attemptId: start.intent.attemptId, unitId: start.intent.unit.unitId,
        action: start.intent.action, itemIds: [...(start.intent.itemId ? [start.intent.itemId] : start.intent.unit.remainingItemIds)] });
      if (!validateRequestRecovery(request)) return;
      const value = change(start, { phase: "recovering", recoveryRequest: request, failure: null });
      try {
        const result = await executionCommands.recover(request);
        if (!holds(value)) return;
        const sameAttempt = result.attemptId === request.attemptId;
        if (request.action === "query-outcome" ? !sameAttempt || !result.queryStarted
          : request.action === "validate-output" ? !sameAttempt || result.queryStarted : sameAttempt || result.queryStarted) throw new Error("Invalid task recovery acknowledgement");
        change(value, { phase: "recorded", recovery: freeze(structuredClone(result)), failure: null });
        reads.invalidate(["execution"]);
      } catch (error) { fail(value, error, true); }
      return;
    }
    const token = translation.reserveMutation();
    if (!token) { change(start, { failure: "busy" }); return; }
    reservation.current = token;
    let value = change(start, { phase: "identifying", failure: null });
    try {
      const actionId = await executionCommands.identity(session);
      if (!holds(value)) return;
      if (!validateResponseIdentity(actionId) || cancellationBlocks(value.intent.taskId)) throw new Error("Invalid task adoption identity");
      const request: PrepareRequest = freeze({ ...session, attemptId: value.intent.attemptId, unitId: value.intent.unit.unitId,
        actionId, resultIds: [...value.intent.unit.resultIds] });
      if (!validateRequestPrepare(request)) throw new Error("Invalid task adoption request");
      value = change(value, { prepare: request });
      await dispatchAdoption(value);
    } catch (error) { fail(value, error, false); }
  }
  async function checkAdoption() {
    const start = activityRef.current;
    if (!live() || start?.phase !== "unknown" || !start.prepare || start.intent.action !== "adopt-result") return;
    let value = change(start, { phase: "checking", retryAllowed: false, failure: null });
    try {
      const receipt = await executionCommands.receipt(freeze({ ...session, actionId: value.prepare!.actionId }));
      if (!holds(value)) return;
      if (receipt === null) {
        if (value.receipt) throw new Error("Previously recorded task receipt is missing");
        change(value, { phase: "unknown", retryAllowed: true });
        return;
      }
      const checked = freeze(structuredClone(confirmExecutionReceipt(value.prepare!, receipt, value.receipt)));
      value = change(value, { receipt: checked });
      if (!value.proof) {
        const action = await executionCommands.prepare(value.prepare!);
        if (!holds(value)) return;
        value = change(value, { proof: freeze(structuredClone(confirmExecutionAction(value.prepare!, value.intent.operation, action))) });
      }
      settle(value, checked);
    } catch (error) { fail(value, error, true); }
  }
  async function retryAdoption() {
    const value = activityRef.current;
    if (!live() || value?.phase !== "unknown" || !value.retryAllowed || value.receipt || !value.prepare || !reservation.current) return;
    await dispatchAdoption(value);
  }

  return <TaskContext.Provider value={{ state, current, canCancel, cancel, retry, activity, currentActivity: () => activityRef.current,
    begin, submit, checkAdoption, retryAdoption, dismiss, busy: activityBusy(activity),
    unresolved: () => Object.values(stateRef.current).some(unresolved) || activityUnresolved(activityRef.current) }}>{children}</TaskContext.Provider>;
}

/** All recovery buttons use the owner's original request, never the current projection. */
export function TaskCancellationFeedback({ origin, taskId, disabled = false, visible = true }: { origin: Origin; taskId?: string; disabled?: boolean; visible?: boolean }) {
  const owner = useExecutionTaskSession(), { t } = useTranslation(), errorRegion = useRef<HTMLDivElement>(null);
  const entries = Object.values(owner.state).filter(value => origin === "tasks" || unresolved(value) || value.target.taskId === taskId || value.target.origin === origin);
  const failure = entries.find(value => value.failure !== null);
  useLayoutEffect(() => { if (visible && failure) errorRegion.current?.focus(); }, [visible, failure]);
  if (!visible) return null;
  return <>{entries.map(value => {
    const reason = failureReason(value.failure);
    const errorKey = reason === "busy" ? "busy" : reason === "session-invalid" ? "session" : reason === "dependency-conflict" ? "conflict" : reason === "outcome-unknown" ? "unknown" : "failed";
    return <section key={value.target.taskId} aria-label={t("execution.cancelStatus")}>
      {value.failure ? <div role="alert" tabIndex={-1} ref={value === failure ? errorRegion : undefined}>
        <p>{t(reason === "busy" && (value.target.origin === "ai" || value.target.origin === "arena") ? "ai.errors.busy" : `execution.errors.${errorKey}`)}</p><CommandFailureDetails failure={value.failure} />
      </div> : null}
      <p role="status">{t(value.phase === "recorded" ? "execution.cancelRecorded" : value.phase === "unknown" ? "execution.cancelUnknown"
        : value.phase === "rejected" ? value.request ? "execution.cancelRejected" : "execution.cancelPreparationFailed" : "execution.cancelPending")}</p>
      {value.phase === "unknown" ? <button className="secondary-button" disabled={disabled} onClick={() => void owner.retry(value.request.taskId)}>{t("execution.retryCancellation")}</button> : null}
      <details><summary>{t("execution.diagnostic")}</summary>
        <p>{t("execution.cancelTaskIdentity")} <code>{value.target.taskId}</code></p>
        {value.request ? <p>{t("execution.cancelRequestIdentity")} <code>{value.request.requestId}</code></p> : null}
        {value.revision ? <p>{t("execution.revision", { number: value.revision })}</p> : null}
      </details>
    </section>;
  })}</>;
}
