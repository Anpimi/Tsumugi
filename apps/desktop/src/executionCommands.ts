import type { ProjectView } from "./projectCommands";
import { checkedInvoke } from "./ipc";
import type { SessionRequest, ListRequest, TaskRequest, AttemptRequest, OutputRequest, CancelRequest, RecoveryRequest, PrepareRequest, AdoptRequest } from "./generated/execution.requests";
import { validateResponseIdentity, validateResponseStatus, validateResponseTasks, validateResponseAttempts, validateResponseAttempt, validateResponseOutput, validateResponseCancellation, validateResponseRecovery, validateResponseAction, validateResponseAdoption, validateResponseReceipt } from "./generated/execution.validators";

export type { SessionRequest, ListRequest, TaskRequest, AttemptRequest, OutputRequest, CancelRequest, RecoveryRequest, PrepareRequest, AdoptRequest } from "./generated/execution.requests";
export type { TaskView as Task, AdoptionReceipt as Receipt, AttemptSummary, ExecutionState, ItemStatus, Scope, ItemView, Progress, RecoveryUnit, AttemptDetail, RuntimeStatus, RecoveryView, AdoptionAction, ResultEnvelope, RecoveryAction } from "./generated/execution.responses";

export const executionContext = (project: ProjectView): SessionRequest => ({ sessionToken: project.sessionToken, projectId: project.metadata.projectId });

export const executionCommands = {
  identity: (request: SessionRequest) => checkedInvoke("create_execution_identity", request, validateResponseIdentity),
  status: (request: SessionRequest) => checkedInvoke("execution_status", request, validateResponseStatus),
  list: (request: ListRequest) => checkedInvoke("list_execution_tasks", request, validateResponseTasks),
  task: (request: TaskRequest) => checkedInvoke("read_execution_task", request, validateResponseAttempts),
  attempt: (request: AttemptRequest) => checkedInvoke("read_execution_attempt", request, validateResponseAttempt),
  output: (request: OutputRequest) => checkedInvoke("read_execution_output", request, validateResponseOutput),
  cancel: (request: CancelRequest) => checkedInvoke("cancel_execution_task", request, validateResponseCancellation),
  recover: (request: RecoveryRequest) => checkedInvoke("recover_execution", request, validateResponseRecovery),
  prepare: (request: PrepareRequest) => checkedInvoke("prepare_execution_adoption", request, validateResponseAction),
  adopt: (request: AdoptRequest) => checkedInvoke("adopt_execution", request, validateResponseAdoption),
  receipt: (request: AdoptRequest) => checkedInvoke("read_execution_receipt", request, validateResponseReceipt),
  quiesce: (request: SessionRequest) => checkedInvoke("quiesce_execution", request, validateResponseStatus),
};
