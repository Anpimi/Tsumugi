import type { ContinuationAction, ContinuationReceipt, ContinuationPage, TaskView } from "./generated/execution.responses";
import type { ProjectView } from "./projectCommands";
import { checkedInvoke } from "./ipc";
import type { SessionRequest, ListRequest, TaskRequest, AttemptRequest, OutputRequest, CancelRequest, RecoveryRequest, ContinuationRequest, ContinuationReadRequest, ContinuationListRequest, TaskViewRequest, PrepareRequest, AdoptRequest, PluginToolPrepareRequest, PluginStartRequest, PluginToolDiscardRequest } from "./generated/execution.requests";
import { validateResponseIdentity, validateResponseStatus, validateResponseTasks, validateResponseAttempts, validateResponseAttempt, validateResponseOutput, validateResponseCancellation, validateResponseRecovery, validateResponseContinuation, validateResponseContinuationReceipt, validateResponseContinuations, validateResponseTaskView, validateResponseAction, validateResponseAdoption, validateResponseReceipt, validateResponseToolPreflight, validateResponseToolDiscarded } from "./generated/execution.validators";

export type { SessionRequest, ListRequest, TaskRequest, AttemptRequest, OutputRequest, CancelRequest, RecoveryRequest, ContinuationRequest, ContinuationReadRequest, ContinuationListRequest, TaskViewRequest, PrepareRequest, AdoptRequest, PluginToolPrepareRequest, PluginStartRequest, PluginToolDiscardRequest } from "./generated/execution.requests";
export type { TaskView as Task, AdoptionReceipt as Receipt, AttemptSummary, ExecutionState, ItemStatus, Scope, ItemView, Progress, RecoveryUnit, AttemptDetail, RuntimeStatus, RecoveryView, AdoptionAction, ResultEnvelope, RecoveryAction, ContinuationAction, ContinuationReceipt, ContinuationPage, PluginToolPreflight, PluginToolItem } from "./generated/execution.responses";

export const executionContext = (project: ProjectView): SessionRequest => ({ sessionToken: project.sessionToken, projectId: project.metadata.projectId });

export function matchesContinuation(action: ContinuationAction, receipt: ContinuationReceipt): boolean {
  const recorded = receipt.action;
  const selected = [...action.itemIds].sort(), original = [...recorded.itemIds].sort();
  return recorded.actionId === action.actionId && recorded.projectId === action.projectId
    && recorded.sourceAttemptId === action.sourceAttemptId && recorded.unitId === action.unitId
    && recorded.kind === action.kind && recorded.expectedCancellationRevision === action.expectedCancellationRevision
    && selected.length === new Set(selected).size && selected.length === original.length
    && selected.every((id, index) => id === original[index]);
}
function assertContinuation(receipt: ContinuationReceipt, projectId: string, actionId?: string) {
  if (receipt.action.projectId !== projectId || (actionId !== undefined && receipt.action.actionId !== actionId)
    || receipt.attemptId === receipt.action.sourceAttemptId || BigInt(receipt.sequence) < 1n
    || receipt.action.itemIds.length < 1 || receipt.action.itemIds.length > 2000 || new Set(receipt.action.itemIds).size !== receipt.action.itemIds.length || ![receipt.requestDigest, receipt.sourceInputDigest, receipt.inputDigest].every(digest => /^[a-f0-9]{64}$/.test(digest))) {
    throw new Error("Invalid continuation association");
  }
}
async function continueExecution(request: ContinuationRequest): Promise<ContinuationReceipt> {
  const receipt = await checkedInvoke("continue_execution", request, validateResponseContinuation);
  assertContinuation(receipt, request.projectId, request.action.actionId);
  if (!matchesContinuation(request.action, receipt)) throw new Error("Unconfirmed continuation acknowledgement");
  return receipt;
}
async function readContinuation(request: ContinuationReadRequest): Promise<ContinuationReceipt | null> {
  const receipt = await checkedInvoke("read_execution_continuation", request, validateResponseContinuationReceipt);
  if (receipt) assertContinuation(receipt, request.projectId, request.actionId);
  return receipt;
}
async function readContinuations(request: ContinuationListRequest): Promise<ContinuationPage> {
  const page = await checkedInvoke("read_execution_continuations", request, validateResponseContinuations);
  let previous = BigInt(request.after);
  const actions = new Set<string>(), attempts = new Set<string>();
  for (const receipt of page.receipts) {
    assertContinuation(receipt, request.projectId);
    if (receipt.action.sourceAttemptId !== request.sourceAttemptId || BigInt(receipt.sequence) <= previous) throw new Error("Invalid continuation history scope");
    if (actions.has(receipt.action.actionId) || attempts.has(receipt.attemptId)) throw new Error("Duplicate continuation history");
    actions.add(receipt.action.actionId); attempts.add(receipt.attemptId);
    previous = BigInt(receipt.sequence);
  }
  if (page.receipts.length > request.limit || (page.next === null ? page.receipts.length === request.limit : page.receipts.length !== request.limit || page.next !== page.receipts.at(-1)?.sequence)) throw new Error("Invalid continuation history cursor");
  return page;
}
async function readTaskView(request: TaskViewRequest): Promise<TaskView> {
  const task = await checkedInvoke("read_execution_task_view", request, validateResponseTaskView);
  if (task.taskId !== request.taskId || task.projectId !== request.projectId) throw new Error("Invalid task view scope");
  return task;
}

export const executionCommands = {
  identity: (request: SessionRequest) => checkedInvoke("create_execution_identity", request, validateResponseIdentity),
  status: (request: SessionRequest) => checkedInvoke("execution_status", request, validateResponseStatus),
  list: (request: ListRequest) => checkedInvoke("list_execution_tasks", request, validateResponseTasks),
  task: (request: TaskRequest) => checkedInvoke("read_execution_task", request, validateResponseAttempts),
  attempt: (request: AttemptRequest) => checkedInvoke("read_execution_attempt", request, validateResponseAttempt),
  output: (request: OutputRequest) => checkedInvoke("read_execution_output", request, validateResponseOutput),
  cancel: (request: CancelRequest) => checkedInvoke("cancel_execution_task", request, validateResponseCancellation),
  continue: continueExecution,
  continuation: readContinuation,
  continuations: readContinuations,
  taskView: readTaskView,
  recover: (request: RecoveryRequest) => checkedInvoke("recover_execution", request, validateResponseRecovery),
  prepare: (request: PrepareRequest) => checkedInvoke("prepare_execution_adoption", request, validateResponseAction),
  adopt: (request: AdoptRequest) => checkedInvoke("adopt_execution", request, validateResponseAdoption),
  receipt: (request: AdoptRequest) => checkedInvoke("read_execution_receipt", request, validateResponseReceipt),
  quiesce: (request: SessionRequest) => checkedInvoke("quiesce_execution", request, validateResponseStatus),
  prepareTool: (request: PluginToolPrepareRequest) => checkedInvoke("prepare_plugin_tool", request, validateResponseToolPreflight),
  startTool: (request: PluginStartRequest) => checkedInvoke("start_plugin_tool", request, validateResponseIdentity),
  discardTool: (request: PluginToolDiscardRequest) => checkedInvoke("discard_plugin_tool_preflight", request, validateResponseToolDiscarded),
};
