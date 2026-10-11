import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, type CancelRequest } from "./executionCommands";
import { validateRequestCancel, validateResponseIdentity } from "./generated/execution.validators";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionReads } from "./SessionReadProvider";

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
interface TaskSession {
  state: Cancellations;
  current: (taskId: string) => Cancellation | undefined;
  canCancel: (target: CancellationTarget, proof?: () => boolean) => boolean;
  cancel: (target: CancellationTarget, proof?: () => boolean) => Promise<void>;
  retry: (taskId: string) => Promise<void>;
  unresolved: () => boolean;
}
const TaskContext = createContext<TaskSession | null>(null);
export function useExecutionTaskSession() {
  const owner = useContext(TaskContext);
  if (!owner) throw new Error("Task cancellation requires a project session owner");
  return owner;
}
const unresolved = (value: Cancellation) => value.phase === "preparing" || value.phase === "pending" || value.phase === "unknown";

/** Own original cancellation requests independently of their workspace consumers. */
export function ExecutionTaskSession({ project, children }: { project: ProjectView; children: ReactNode }) {
  const reads = useSessionReads();
  const [session] = useState(() => Object.freeze(executionContext(project)));
  const [state, setState] = useState<Cancellations>(() => Object.freeze({}));
  const stateRef = useRef(state), projectRef = useRef(project), mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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
      || !validateRequestCancel({ ...session, taskId: target.taskId, requestId: target.taskId })) return false;
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
    if (!live() || original?.phase !== "unknown" || !validateRequestCancel(original.request)) return;
    const pending: PendingCancellation = { target: original.target, phase: "pending", request: original.request, revision: null, failure: null };
    replace(taskId, pending);
    await dispatch(pending, true);
  }
  return <TaskContext.Provider value={{ state, current, canCancel, cancel, retry, unresolved: () => Object.values(stateRef.current).some(unresolved) }}>{children}</TaskContext.Provider>;
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
