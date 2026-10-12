import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionTasks, type TasksHandle } from "./ExecutionTasks";
import { i18n } from "./i18n";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { ProjectView } from "./projectCommands";
import { createRef, type RefObject } from "react";
import type { AttemptDetail, ContinuationRequest, ContinuationReceipt } from "./executionCommands";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session-1", locator: "C:\\isolated\\project", metadata: { projectId: fixture.session.projectId, displayName: "Demo", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" }, reconciliationState: "settled" };
const task = { taskId: fixture.detail.taskId, projectId: fixture.session.projectId, operation: "sample-update", sequence: "1", cancellationRevision: "0" };
function detail(): AttemptDetail { return structuredClone(fixture.detail) as AttemptDetail; }
function continuationResult(request: ContinuationRequest): ContinuationReceipt {
  return { ...fixture.continuationReceipt, sequence: "2", action: { ...request.action, itemIds: [...request.action.itemIds].sort() }, attemptId: fixtureIdentity(3), taskId: task.taskId, operation: task.operation };
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function openTasks(value = detail(), ref?: RefObject<TasksHandle | null>) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task") return [{ attemptId: value.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return value;
    if (command === "read_execution_task_view") return task;
    if (command === "read_execution_continuations") return { receipts: [], next: null };
    throw new Error(`Unexpected command: ${command}`);
  });
  const user = userEvent.setup();
  render(<ExecutionTasks project={project} disabled={false} ref={ref} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: /Sample update/ }));
  await screen.findByText(/0 of 1 outputs/);
  return user;
}
it("offers only evidence-backed actions for an unknown result and confirms the exact item", async () => {
  const user = await openTasks();
  expect(screen.queryByRole("button", { name: "Retry eligible failures" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply saved results" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Check earlier request ·/ }));
  const dialog = screen.getByRole("dialog", { name: "Check earlier request" });
  expect(within(dialog).getByText(/Sample A/)).toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command === "recover_execution")).toBe(false);
  invoke.mockResolvedValueOnce({ attemptId: fixture.detail.attemptId, queryStarted: true });
  await user.click(within(dialog).getByRole("button", { name: "Check earlier request" }));
  expect(invoke).toHaveBeenCalledWith("recover_execution", { request: fixture.recover });
  await screen.findByText(/Outcome check requested/);
  await user.click(screen.getByRole("button", { name: /Check earlier request ·/ }));
  expect(within(screen.getByRole("dialog", { name: "Check earlier request" })).queryByText(/Outcome check requested/)).not.toBeInTheDocument();
});
it("keeps an uncertain adoption recoverable inside the confirmation dialog without regenerating", async () => {
  const value = detail(); value.items[0].status.execution = "succeeded"; value.items[0].status.validation = "valid"; value.items[0].resultId = fixture.prepare.resultIds[0];
  value.recovery.units[0].actions = ["adopt-result"]; value.recovery.units[0].resultIds = fixture.prepare.resultIds; value.recovery.units[0].blockedReason = null;
  const user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: "Apply saved results" }));
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockResolvedValueOnce(fixture.action).mockRejectedValueOnce({ code: "outcome-unknown", outcome: "unknown", stage: "execution-adopt", recoveryRequired: true });
  await user.click(within(screen.getByRole("dialog", { name: "Apply saved results" })).getByRole("button", { name: "Apply saved results" }));
  const check = await screen.findByRole("button", { name: "Check recorded outcome" });
  invoke.mockResolvedValueOnce(project).mockResolvedValueOnce(fixture.receipt);
  await user.click(check);
  await screen.findByRole("heading", { name: "Recorded changes" });
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "recover_execution")).toBe(false);
  const prepared = invoke.mock.calls.find(([command]) => command === "prepare_execution_adoption")![1].request;
  expect(invoke).toHaveBeenCalledWith("read_execution_receipt", { request: { ...fixture.session, actionId: prepared.actionId } });
});
it("discards a previous selection's late detail response", async () => {
  let resolveOld!: (value: AttemptDetail) => void;
  const old = new Promise<AttemptDetail>(resolve => { resolveOld = resolve; });
  const fresh = detail(); fresh.attemptId = fixtureIdentity(1); fresh.items[0].scope.id = "New selection";
  fresh.recovery.units[0].scopes[0].id = "New selection";
  invoke.mockImplementation(async (command: string, args: { request: { taskId?: string; attemptId?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task, { ...task, taskId: fixtureIdentity(2), sequence: "2" }];
    if (command === "read_execution_task") return [{ attemptId: args.request.taskId === fixtureIdentity(2) ? fresh.attemptId : fixture.detail.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return args.request.attemptId === fresh.attemptId ? fresh : old;
    if (command === "read_execution_task_view") return { ...task, taskId: args.request.taskId };
    if (command === "read_execution_continuations") return { receipts: [], next: null };
  });
  const user = userEvent.setup(); render(<ExecutionTasks project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: "Sample update · Task 1" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_execution_attempt")).toBe(true));
  await user.click(screen.getByRole("button", { name: "All tasks" }));
  await user.click(await screen.findByRole("button", { name: "Sample update · Task 2" }));
  await screen.findByText("New selection · zh-CN", { selector: "strong" });
  await act(async () => { resolveOld(detail()); await old; });
  expect(screen.getByText("New selection · zh-CN", { selector: "strong" })).toBeInTheDocument();
  expect(screen.queryByText("Sample A · zh-CN")).not.toBeInTheDocument();
});
it("preserves keyboard return focus and Chinese task messages", async () => {
  await i18n.changeLanguage("zh-CN");
  invoke.mockImplementation(async command => command === "execution_status" ? fixture.status : []);
  const user = userEvent.setup(); render(<ExecutionTasks project={project} disabled={false} />);
  const trigger = screen.getByRole("button", { name: "任务" }); trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByText(/此项目暂无任务/);
  await user.click(screen.getByRole("button", { name: "返回概览" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "项目概览" })).toHaveFocus());
});

it("retries uncertain preparation with the original request after checking its receipt", async () => {
  const value = detail();
  value.recovery.units[0].actions = ["adopt-result"];
  value.recovery.units[0].resultIds = fixture.prepare.resultIds;
  value.recovery.units[0].blockedReason = null;
  const user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: "Apply saved results" }));
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockRejectedValueOnce({ code: "outcome-unknown" });
  await user.click(within(screen.getByRole("dialog", { name: "Apply saved results" })).getByRole("button", { name: "Apply saved results" }));
  const check = await screen.findByRole("button", { name: "Check recorded outcome" });
  invoke.mockResolvedValueOnce(project).mockResolvedValueOnce(null);
  await user.click(check);
  const retry = await screen.findByRole("button", { name: "Retry the same application" });
  invoke.mockResolvedValueOnce(fixture.action).mockResolvedValueOnce(fixture.receipt);
  await user.click(retry);
  await screen.findByRole("heading", { name: "Recorded changes" });
  const preparations = invoke.mock.calls.filter(([command]) => command === "prepare_execution_adoption");
  expect(preparations).toHaveLength(2);
  expect(preparations[1][1]).toEqual(preparations[0][1]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "recover_execution")).toBe(false);
});

it("shows named failure details beside the item and focuses the readable result", async () => {
  const value = detail();
  value.items[0].status.execution = "failed";
  value.items[0].status.retrySafe = true;
  value.items[0].resultId = fixture.prepare.resultIds[0];
  value.progress.failed = 1; value.progress.unknown = 0;
  value.recovery.units[0].actions = ["retry-safe-failure"];
  value.recovery.units[0].blockedReason = null;
  const user = await openTasks(value);
  expect(screen.getByRole("region", { name: "Available actions" }).compareDocumentPosition(screen.getByRole("heading", { name: "Item results" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  invoke.mockResolvedValueOnce(fixture.output);
  await user.click(screen.getByRole("button", { name: "View failure details" }));
  const result = await screen.findByRole("region", { name: "Result for Sample A" });
  expect(within(result).getByText(/did not generate usable output/)).toBeInTheDocument();
  expect(within(result).queryByText("null")).not.toBeInTheDocument();
  expect(result).toHaveFocus();
  expect(result.closest("li")).toContainElement(screen.getByText("Sample A · zh-CN", { selector: "strong" }));
  await user.click(screen.getByRole("button", { name: "Retry eligible failures" }));
  invoke.mockResolvedValueOnce(fixtureIdentity(6)).mockImplementationOnce(async (_command, args: { request: ContinuationRequest }) => continuationResult(args.request));
  await user.click(within(screen.getByRole("dialog", { name: "Retry eligible failures" })).getByRole("button", { name: "Retry eligible failures" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Result for Sample A" })).not.toBeInTheDocument());
});

it("confirms only the selected unknown item and describes checking without generation", async () => {
  const value = detail();
  value.recovery.units[0].itemIds.push(fixtureIdentity(4));
  value.recovery.units[0].scopes.push({ kind: "sample", id: "Other item", locale: "zh-CN" });
  const user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: /Check earlier request ·/ }));
  const dialog = screen.getByRole("dialog", { name: "Check earlier request" });
  expect(within(dialog).getByText(/these 1 selected items/)).toBeInTheDocument();
  expect(within(dialog).getByText(/does not generate results again/)).toBeInTheDocument();
  expect(within(dialog).queryByText("Other item")).not.toBeInTheDocument();
});

it("keeps the complete original recovery after lost ACK, wrong lookup and later rejection", async () => {
  const value = detail();
  value.recovery.units[0].actions = ["resume-undispatched"];
  value.recovery.units[0].blockedReason = null;
  value.progress.unknown = 0; value.progress.queued = 1;
  value.items[0].status.execution = "queued";
  const user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: "Continue remaining work" }));
  invoke.mockResolvedValueOnce(fixtureIdentity(6)).mockRejectedValueOnce(new Error("lost ACK"));
  await user.click(within(screen.getByRole("dialog", { name: "Continue remaining work" })).getByRole("button", { name: "Continue remaining work" }));
  const check = await screen.findByRole("button", { name: "Check original recovery request" });
  const original = invoke.mock.calls.find(([command]) => command === "continue_execution")![1].request as ContinuationRequest;
  expect(original.action).toMatchObject({ kind: "resume-undispatched", expectedCancellationRevision: "0", itemIds: value.recovery.units[0].remainingItemIds });
  expect(screen.queryByRole("button", { name: "Retry the same recovery request" })).not.toBeInTheDocument();
  // A shaped but unrelated receipt cannot acknowledge the pending original intent.
  invoke.mockResolvedValueOnce({ ...continuationResult(original), action: { ...original.action, unitId: fixtureIdentity(8) } });
  await user.click(check);
  expect(await screen.findByText(/original recovery request is still unconfirmed/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry the same recovery request" })).not.toBeInTheDocument();
  invoke.mockResolvedValueOnce(null);
  await user.click(screen.getByRole("button", { name: "Check original recovery request" }));
  const retry = await screen.findByRole("button", { name: "Retry the same recovery request" });
  invoke.mockRejectedValueOnce({ code: "cancelled", outcome: "rejected", stage: "execution-recover", recoveryRequired: false, reason: "continuation-cancellation-basis" });
  await user.click(retry);
  expect(await screen.findByText(/original recovery request is still unconfirmed/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry the same recovery request" })).not.toBeInTheDocument();
  const writes = invoke.mock.calls.filter(([command]) => command === "continue_execution");
  expect(writes).toHaveLength(2); expect(writes[1][1]).toEqual(writes[0][1]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  invoke.mockResolvedValueOnce(continuationResult(original));
  await user.click(screen.getByRole("button", { name: "Check original recovery request" }));
  await waitFor(() => expect(screen.queryByText(/original recovery request is still unconfirmed/)).not.toBeInTheDocument());
  expect(invoke.mock.calls.filter(([command]) => command === "continue_execution")).toHaveLength(2);
  expect(invoke.mock.calls.some(([command]) => command === "recover_execution")).toBe(false);
});

it("resets replay permission after a second unknown and keeps deferred request on return", async () => {
  const value = detail(); value.recovery.units[0].actions = ["resume-undispatched"];
  const handle = createRef<TasksHandle>();
  const user = await openTasks(value, handle);
  await user.click(screen.getByRole("button", { name: "Continue remaining work" }));
  invoke.mockResolvedValueOnce(fixtureIdentity(6)).mockRejectedValueOnce(new Error("lost ACK"));
  await user.click(within(screen.getByRole("dialog", { name: "Continue remaining work" })).getByRole("button", { name: "Continue remaining work" }));
  invoke.mockResolvedValueOnce(null);
  await user.click(await screen.findByRole("button", { name: "Check original recovery request" }));
  invoke.mockRejectedValueOnce(new Error("second ACK lost"));
  await user.click(await screen.findByRole("button", { name: "Retry the same recovery request" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry the same recovery request" })).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "Keep request and return" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check original recovery request" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue remaining work" })).toBeDisabled();
  expect(await handle.current!.allowLeave()).toBe(false);
  const writes = invoke.mock.calls.filter(([command]) => command === "continue_execution");
  expect(writes[1][1]).toEqual(writes[0][1]);
});

it("finds a saved original continuation after reopening without resubmitting it", async () => {
  const value = detail();
  value.recovery.units[0].actions = []; value.recovery.units[0].blockedReason = "continued-in-new-attempt";
  const original: ContinuationRequest = { ...fixture.continuation, action: { ...fixture.continuation.action, kind: "resume-undispatched", expectedCancellationRevision: "0" } };
  const saved = continuationResult(original);
  invoke.mockImplementation(async (command: string, args: { request: { attemptId?: string; sourceAttemptId?: string; after?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks" || command === "read_execution_task_view") return command === "list_execution_tasks" ? [task] : task;
    if (command === "read_execution_task") return [{ attemptId: value.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return args.request.attemptId === saved.attemptId ? { ...value, attemptId: saved.attemptId, recovery: { ...value.recovery, attemptId: saved.attemptId } } : value;
    if (command === "read_execution_continuations") return args.request.after === "0" && args.request.sourceAttemptId === saved.action.sourceAttemptId ? { receipts: [saved], next: null } : { receipts: [], next: null };
    if (command === "read_execution_continuation") return saved;
    throw new Error(`Unexpected command: ${command}`);
  });
  const handle = createRef<TasksHandle>();
  const user = userEvent.setup(); render(<ExecutionTasks project={project} disabled={false} ref={handle} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: /Sample update/ }));
  await user.click(await screen.findByRole("button", { name: "View continued work" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_execution_attempt", { request: { ...fixture.session, attemptId: saved.attemptId, offset: 0, limit: 100 } }));
  expect(invoke.mock.calls.some(([command]) => command === "continue_execution" || command === "create_execution_identity")).toBe(false);
  expect(await handle.current!.allowLeave()).toBe(true);
});
