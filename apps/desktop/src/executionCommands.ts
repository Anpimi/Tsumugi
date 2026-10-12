import type { ProjectView } from "./projectCommands";
import { checkedInvoke } from "./ipc";
import type { SessionRequest, ListRequest, TaskRequest, AttemptRequest, OutputRequest, CancelRequest, RecoveryRequest, PrepareRequest, AdoptRequest } from "./generated/execution.requests";
import { validateResponseIdentity, validateResponseStatus, validateResponseTasks, validateResponseAttempts, validateResponseAttempt, validateResponseOutput, validateResponseCancellation, validateResponseRecovery, validateResponseAction, validateResponseAdoption, validateResponseReceipt } from "./generated/execution.validators";
import type { AdoptionAction, AdoptionReceipt } from "./generated/execution.responses";

export type { SessionRequest, ListRequest, TaskRequest, AttemptRequest, OutputRequest, CancelRequest, RecoveryRequest, PrepareRequest, AdoptRequest } from "./generated/execution.requests";
export type { TaskView as Task, AdoptionReceipt as Receipt, AttemptSummary, ExecutionState, ItemStatus, Scope, ItemView, Progress, RecoveryUnit, AttemptDetail, RuntimeStatus, RecoveryView, AdoptionAction, ResultEnvelope, RecoveryAction } from "./generated/execution.responses";

export const executionContext = (project: ProjectView): SessionRequest => ({ sessionToken: project.sessionToken, projectId: project.metadata.projectId });

/** Compare canonical sets without hiding duplicate, missing or additional results. */
export function sameExecutionIds(left: readonly string[], right: readonly string[]) {
  const leftSet = new Set(left), rightSet = new Set(right);
  return left.length === right.length && leftSet.size === left.length && rightSet.size === right.length
    && left.every(id => rightSet.has(id));
}

export function confirmExecutionAction(request: PrepareRequest, operation: string, value: unknown, previous?: AdoptionAction | null): AdoptionAction {
  if (!validateResponseAction(value) || value.projectId !== request.projectId || value.attemptId !== request.attemptId
    || value.actionId !== request.actionId || value.unitId !== request.unitId || value.operation !== operation
    || value.parameters !== null || !sameExecutionIds(value.resultIds, request.resultIds)
    || (previous && value.cancellationRevision !== previous.cancellationRevision)) throw new Error("Invalid execution preparation acknowledgement");
  return value;
}

export function confirmExecutionReceipt(request: PrepareRequest, value: unknown, previous?: AdoptionReceipt | null): AdoptionReceipt {
  if (!validateResponseAdoption(value) || value.projectId !== request.projectId || value.attemptId !== request.attemptId
    || value.actionId !== request.actionId || value.unitId !== request.unitId
    || (previous && (value.requestDigest !== previous.requestDigest || value.changes.length !== previous.changes.length
      || value.changes.some((change, index) => {
        const prior = previous.changes[index];
        return change.kind !== prior.kind || change.id !== prior.id || change.revision !== prior.revision;
      })))) throw new Error("Invalid execution receipt acknowledgement");
  // The digest binds Core's full frozen input. The frontend cannot reconstruct it.
  return value;
}

export const executionCommands = {
  identity: (request: SessionRequest) => checkedInvoke("create_execution_identity", request, validateResponseIdentity),
  status: (request: SessionRequest) => checkedInvoke("execution_status", request, validateResponseStatus),
  list: (request: ListRequest) => checkedInvoke("list_execution_tasks", request, validateResponseTasks),
  task: (request: TaskRequest) => checkedInvoke("read_execution_task", request, validateResponseAttempts),
  attempt: (request: AttemptRequest) => checkedInvoke("read_execution_attempt", request, validateResponseAttempt),
  output: (request: OutputRequest) => checkedInvoke("read_execution_output", request, validateResponseOutput),
  // The scalar wire type allows zero, but a persisted cancellation increments it.
  cancel: (request: CancelRequest) => checkedInvoke("cancel_execution_task", request,
    (value): value is string => validateResponseCancellation(value) && value !== "0"),
  recover: (request: RecoveryRequest) => checkedInvoke("recover_execution", request, validateResponseRecovery),
  prepare: (request: PrepareRequest) => checkedInvoke("prepare_execution_adoption", request, validateResponseAction),
  adopt: (request: AdoptRequest) => checkedInvoke("adopt_execution", request, validateResponseAdoption),
  receipt: (request: AdoptRequest) => checkedInvoke("read_execution_receipt", request, validateResponseReceipt),
  quiesce: (request: SessionRequest) => checkedInvoke("quiesce_execution", request, validateResponseStatus),
};
