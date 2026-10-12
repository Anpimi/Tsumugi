import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionTasks, type TasksHandle } from "./ExecutionTasks";
import { i18n } from "./i18n";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { ProjectView } from "./projectCommands";
import type { AttemptDetail, ContinuationRequest, ContinuationReceipt } from "./executionCommands";
import { createRef, useLayoutEffect, type RefObject } from "react";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { useSessionReads } from "./SessionReadProvider";
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
it("retains the original cancellation after a complete Tasks remount and blocks project leave", async () => {
  const ref = createRef<TasksHandle>(), user = userEvent.setup();
  let cancelCount = 0;
  invoke.mockImplementation(async (command: string) => {
    if (command === "execution_status") return fixture.status;
    if (command === "read_execution_continuations") return Promise.resolve({ receipts: [], next: null });
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task") return [fixture.summary];
    if (command === "read_execution_attempt") return detail();
    if (command === "create_execution_identity") return fixtureIdentity(201);
    if (command === "cancel_execution_task") { if (++cancelCount === 1) throw new Error("Disconnected"); return "4"; }
    throw new Error(command);
  });
  const view = render(<ExecutionTasks ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: /Sample update/ }));
  await user.click(await screen.findByRole("button", { name: "Cancel remaining work" }));
  await user.click(within(screen.getByRole("dialog", { name: "Cancel remaining work" })).getByRole("button", { name: "Cancel remaining work" }));
  await screen.findByRole("button", { name: "Retry the original cancellation" });
  await act(async () => { expect(await ref.current!.allowLeave()).toBe(false); });
  expect(await ref.current!.allowNavigate()).toBe(true);
  view.rerender(null, project);
  view.rerender(<ExecutionTasks ref={ref} project={project} disabled={false} />);
  await act(async () => { expect(await ref.current!.allowLeave()).toBe(false); });
  await user.click(await screen.findByRole("button", { name: "Retry the original cancellation" }));
  await screen.findByText(/Cancellation request recorded/);
  expect(await ref.current!.allowLeave()).toBe(true);
  const requests = invoke.mock.calls.filter(([name]) => name === "cancel_execution_task").map(([, payload]) => payload.request);
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toEqual({ sessionToken: project.sessionToken, projectId: project.metadata.projectId, taskId: task.taskId, requestId: fixtureIdentity(201) });
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
});
it("opens previously unvisited Tasks when another workspace has an unknown cancellation and retries that original request", async () => {
  const ref = createRef<TasksHandle>(), user = userEvent.setup();
  let owner!: ReturnType<typeof useExecutionTaskSession>, cancelCount = 0;
  function UnvisitedTasks() {
    const value = useExecutionTaskSession();
    useLayoutEffect(() => { owner = value; });
    return <ExecutionTasks ref={ref} project={project} disabled={false} />;
  }
  invoke.mockImplementation(async (command: string) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [];
    if (command === "create_execution_identity") return fixtureIdentity(202);
    if (command === "cancel_execution_task") { if (++cancelCount === 1) throw new Error("Disconnected"); return "5"; }
    throw new Error(command);
  });
  render(<UnvisitedTasks />, project);
  await act(async () => { await owner.cancel({ taskId: task.taskId, attemptId: fixture.detail.attemptId, origin: "ai" }); });
  expect(screen.queryByRole("heading", { name: "Tasks" })).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([name]) => name === "list_execution_tasks")).toBe(false);
  await act(async () => { expect(await ref.current!.allowLeave()).toBe(false); });
  expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
  await user.click(await screen.findByRole("button", { name: "Retry the original cancellation" }));
  await screen.findByText(/Cancellation request recorded/);
  expect(await ref.current!.allowLeave()).toBe(true);
  const request = { ...fixture.session, taskId: task.taskId, requestId: fixtureIdentity(202) };
  expect(invoke.mock.calls.filter(([name]) => name === "cancel_execution_task").map(([, payload]) => payload.request)).toEqual([request, request]);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
});
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
  await screen.findByText(/outputs generated/);
  await screen.findByText(i18n.t("execution.noContinuationHistory"));
  return user;
}
function taskReplies(replies: Record<string, () => unknown>) {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => replies[command] ? replies[command]() : original(command, payload));
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
  taskReplies({ create_execution_identity: () => fixture.prepare.actionId, prepare_execution_adoption: () => ({ ...fixture.action, parameters: null }),
    adopt_execution: () => Promise.reject({ code: "outcome-unknown", outcome: "unknown", stage: "execution-adopt", recoveryRequired: true }) });
  await user.click(within(screen.getByRole("dialog", { name: "Apply saved results" })).getByRole("button", { name: "Apply saved results" }));
  const check = await screen.findByRole("button", { name: "Check recorded outcome" });
  taskReplies({ read_execution_receipt: () => fixture.receipt });
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
  value.items[0].status.execution = "succeeded"; value.items[0].status.validation = "valid"; value.items[0].resultId = fixture.prepare.resultIds[0];
  value.recovery.units[0].actions = ["adopt-result"];
  value.recovery.units[0].resultIds = fixture.prepare.resultIds;
  value.recovery.units[0].blockedReason = null;
  const user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: "Apply saved results" }));
  let replay = false;
  taskReplies({ create_execution_identity: () => fixture.prepare.actionId,
    prepare_execution_adoption: () => replay ? { ...fixture.action, parameters: null } : Promise.reject(new Error("Lost preparation ACK")),
    adopt_execution: () => fixture.receipt, read_execution_receipt: () => null });
  await user.click(within(screen.getByRole("dialog", { name: "Apply saved results" })).getByRole("button", { name: "Apply saved results" }));
  const check = await screen.findByRole("button", { name: "Check recorded outcome" });
  await user.click(check);
  const retry = await screen.findByRole("button", { name: "Retry the same application" });
  replay = true;
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
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Retry eligible failures" })).getByRole("button", { name: "Retry eligible failures" })).toBeEnabled());
  taskReplies({ create_execution_identity: () => fixtureIdentity(6) });
  const replies = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: ContinuationRequest }) => command === "continue_execution"
    ? Promise.resolve(continuationResult(payload.request)) : replies(command, payload));
  await user.click(within(screen.getByRole("dialog", { name: "Retry eligible failures" })).getByRole("button", { name: "Retry eligible failures" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Result for Sample A" })).not.toBeInTheDocument());
});

it("confirms only the selected unknown item and describes checking without generation", async () => {
  const value = detail();
  value.recovery.units[0].itemIds.push(fixtureIdentity(4));
  value.recovery.units[0].scopes.push({ kind: "sample", id: "Other item", locale: "zh-CN" });
  value.items.push({ ...structuredClone(value.items[0]), status: { ...value.items[0].status, itemId: fixtureIdentity(4) }, scope: { kind: "sample", id: "Other item", locale: "zh-CN" } });
  value.progress.total = 2; value.progress.unknown = 2;
  const user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: /Check earlier request ·/ }));
  const dialog = screen.getByRole("dialog", { name: "Check earlier request" });
  expect(within(dialog).getByText(/these 1 selected items/)).toBeInTheDocument();
  expect(within(dialog).getByText(/does not generate results again/)).toBeInTheDocument();
  expect(within(dialog).queryByText("Other item")).not.toBeInTheDocument();
});

function applicationDetail(): AttemptDetail {
  const value = detail();
  Object.assign(value.items[0].status, { execution: "succeeded", validation: "valid", cancellationRequested: false });
  value.items[0].resultId = fixture.prepare.resultIds[0];
  Object.assign(value.progress, { succeeded: 1, unknown: 0 });
  Object.assign(value.recovery.units[0], { actions: ["adopt-result"], resultIds: [...fixture.prepare.resultIds], remainingItemIds: [], blockedReason: null });
  return value;
}

it("settles actual TaskContent adoption after a complete consumer unmount during identity", async () => {
  const value = applicationDetail(), ref = createRef<TasksHandle>(), user = userEvent.setup();
  let identify!: (value: unknown) => void;
  invoke.mockImplementation((command: string) => {
    if (command === "execution_status") return Promise.resolve(fixture.status);
    if (command === "read_execution_continuations") return Promise.resolve({ receipts: [], next: null });
    if (command === "list_execution_tasks") return Promise.resolve([task]);
    if (command === "read_execution_task") return Promise.resolve([fixture.summary]);
    if (command === "read_execution_attempt") return Promise.resolve(value);
    if (command === "create_execution_identity") return new Promise(resolve => { identify = resolve; });
    if (command === "prepare_execution_adoption") return Promise.resolve({ ...fixture.action, parameters: null });
    if (command === "adopt_execution") return Promise.resolve(fixture.receipt);
    return Promise.reject(new Error(command));
  });
  const view = render(<ExecutionTasks ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: /Sample update/ }));
  await user.click(await screen.findByRole("button", { name: "Apply saved results" }));
  await user.click(within(screen.getByRole("dialog", { name: "Apply saved results" })).getByRole("button", { name: "Apply saved results" }));
  expect(identify).toBeDefined(); view.rerender(null, project);
  await act(async () => { identify(fixture.prepare.actionId); });
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1));
  view.rerender(<ExecutionTasks ref={ref} project={project} disabled={false} />);
  await screen.findByRole("heading", { name: "Recorded changes" });
  expect(await ref.current!.allowLeave()).toBe(true);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  expect(invoke.mock.calls.find(([name]) => name === "prepare_execution_adoption")![1].request).toEqual(fixture.prepare);
  expect(invoke.mock.calls.find(([name]) => name === "adopt_execution")![1].request).toEqual(fixture.adopt);
});

it("keeps the original uncertain application after Keep output and a full remount", async () => {
  const value = applicationDetail(), user = userEvent.setup(), ref = createRef<TasksHandle>();
  invoke.mockImplementation(async command => {
    if (command === "execution_status") return fixture.status;
    if (command === "read_execution_continuations") return Promise.resolve({ receipts: [], next: null });
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task") return [fixture.summary];
    if (command === "read_execution_attempt") return value;
    if (command === "create_execution_identity") return fixture.prepare.actionId;
    if (command === "prepare_execution_adoption") return { ...fixture.action, parameters: null };
    if (command === "adopt_execution") throw new Error("Lost adoption ACK");
    if (command === "read_execution_receipt") return fixture.receipt;
    throw new Error(command);
  });
  const view = render(<ExecutionTasks ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" })); await user.click(await screen.findByRole("button", { name: /Sample update/ }));
  await user.click(await screen.findByRole("button", { name: "Apply saved results" }));
  await user.click(within(screen.getByRole("dialog", { name: "Apply saved results" })).getByRole("button", { name: "Apply saved results" }));
  await user.click(await screen.findByRole("button", { name: "Keep output and return" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByText(i18n.t("execution.adoptionUnknown"))).toBeInTheDocument();
  await act(async () => { expect(await ref.current!.allowLeave()).toBe(false); });
  view.rerender(null, project); view.rerender(<ExecutionTasks ref={ref} project={project} disabled={false} />);
  await screen.findByRole("dialog", { name: "Apply saved results" });
  await user.click(screen.getByRole("button", { name: "Check recorded outcome" }));
  await screen.findByRole("heading", { name: "Recorded changes" });
  expect(await ref.current!.allowLeave()).toBe(true);
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "read_execution_receipt").map(([, payload]) => payload.request)).toEqual([fixture.adopt]);
});

it("opens unvisited Tasks for owner adoption recovery and retains its full original scope", async () => {
  const ref = createRef<TasksHandle>(), user = userEvent.setup();
  let owner!: ReturnType<typeof useExecutionTaskSession>;
  function Unvisited() { const value = useExecutionTaskSession(); useLayoutEffect(() => { owner = value; }); return <ExecutionTasks ref={ref} project={project} disabled={false} />; }
  invoke.mockImplementation(async command => {
    if (command === "create_execution_identity") return fixture.prepare.actionId;
    if (command === "prepare_execution_adoption") throw new Error("Lost prepare ACK");
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [];
    throw new Error(command);
  });
  render(<Unvisited />, project);
  const value = applicationDetail();
  await act(async () => { await owner.begin(value, value.recovery.units[0], "adopt-result", 0); await owner.submit(); });
  expect(invoke.mock.calls.some(([name]) => name === "list_execution_tasks")).toBe(false);
  await act(async () => { expect(await ref.current!.allowLeave()).toBe(false); });
  const dialog = await screen.findByRole("dialog", { name: "Apply saved results" });
  expect(within(within(dialog).getByRole("region", { name: "Original task action" })).getByText("Sample A · zh-CN", { selector: "li" })).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Keep output and return" }));
  expect(owner.activity?.prepare).toEqual(fixture.prepare); expect(owner.unresolved()).toBe(true);
  expect(screen.getByRole("button", { name: "Check recorded outcome" })).toBeEnabled();
});

it("keeps an unknown recovery action after progress refresh and offers no unproven retry", async () => {
  const value = detail(), user = await openTasks(value);
  taskReplies({ recover_execution: () => Promise.reject(new Error("Recovery ACK lost")) });
  await user.click(screen.getByRole("button", { name: /Check earlier request ·/ }));
  await user.click(within(screen.getByRole("dialog", { name: "Check earlier request" })).getByRole("button", { name: "Check earlier request" }));
  await screen.findByText(i18n.t("execution.recoveryUnknown"));
  await user.click(screen.getByRole("button", { name: "Keep output and return" }));
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByText(i18n.t("execution.recoveryUnknown"))).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry the same application" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check recorded outcome" })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "recover_execution")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(0);
});

it("shows a reused output from its source attempt without rejecting its authorized current association", async () => {
  const value = applicationDetail(), user = await openTasks(value);
  taskReplies({ read_execution_output: () => ({ ...fixture.output, attemptId: fixtureIdentity(800), outcome: "succeeded", output: { text: "Reused saved output" }, diagnostic: null }) });
  await user.click(screen.getByRole("button", { name: "View saved output" }));
  const result = await screen.findByRole("region", { name: "Result for Sample A" });
  expect(within(result).getByText(/Reused saved output/)).toBeInTheDocument();
  expect(invoke.mock.calls.find(([name]) => name === "read_execution_output")![1].request).toEqual(fixture.outputRequest);
});

it("keeps the confirmed original attempt and unit when a later Query projects a newer attempt", async () => {
  const value = applicationDetail(), user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: "Apply saved results" }));
  const fresh = applicationDetail(); fresh.attemptId = fixtureIdentity(810); fresh.recovery.attemptId = fresh.attemptId;
  fresh.recovery.units[0].unitId = fixtureIdentity(811); fresh.recovery.units[0].scopes[0].id = "Newer group";
  fresh.items[0].scope.id = "Newer group";
  taskReplies({ read_execution_task: () => [{ attemptId: fresh.attemptId, sequence: "2" }], read_execution_attempt: () => fresh,
    create_execution_identity: () => fixture.prepare.actionId, prepare_execution_adoption: () => ({ ...fixture.action, parameters: null }),
    adopt_execution: () => Promise.reject({ code: "permission-denied", outcome: "rejected", stage: "execution-adopt", recoveryRequired: false, reason: "continued-in-new-attempt" }) });
  await refreshWorkbenchReads();
  await waitFor(() => expect(invoke.mock.calls.some(([name, payload]) => name === "read_execution_attempt" && payload.request.attemptId === fresh.attemptId)).toBe(true));
  const dialog = screen.getByRole("dialog", { name: "Apply saved results" });
  expect(within(dialog).getByText("Sample A · zh-CN", { selector: "li" })).toBeInTheDocument();
  expect(within(dialog).queryByText("Newer group · zh-CN")).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Apply saved results" }));
  await screen.findByRole("alert");
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_execution_adoption").map(([, payload]) => payload.request)).toEqual([fixture.prepare]);
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution").map(([, payload]) => payload.request)).toEqual([fixture.adopt]);
});

it("includes the complete cross-page consistency group before applying any of its saved results", async () => {
  const base = applicationDetail(), first = structuredClone(base.items[0]);
  const items = Array.from({ length: 101 }, (_, index) => ({ ...structuredClone(first),
    status: { ...first.status, itemId: index === 0 ? first.status.itemId : fixtureIdentity(900 + index) },
    resultId: index === 0 ? first.resultId : fixtureIdentity(1100 + index), scope: { ...first.scope, id: `Item ${index}` } }));
  const unit = { ...base.recovery.units[0], itemIds: [items[0].status.itemId, items[100].status.itemId],
    scopes: [items[0].scope, items[100].scope], resultIds: [items[100].resultId!, items[0].resultId!] };
  invoke.mockImplementation(async (command: string, payload: { request: { offset?: number } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "read_execution_continuations") return Promise.resolve({ receipts: [], next: null });
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task") return [fixture.summary];
    if (command === "read_execution_attempt") { const offset = payload.request.offset ?? 0; return { ...base, progress: { ...base.progress, total: 101, succeeded: 101 },
      items: items.slice(offset, offset + 100), nextOffset: offset === 0 ? 100 : null, recovery: { attemptId: base.attemptId, units: [unit] } }; }
    if (command === "create_execution_identity") return fixture.prepare.actionId;
    if (command === "prepare_execution_adoption") return { ...fixture.action, parameters: null, resultIds: [...unit.resultIds].sort() };
    if (command === "adopt_execution") return fixture.receipt;
    throw new Error(command);
  });
  const user = userEvent.setup(); render(<ExecutionTasks project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" })); await user.click(await screen.findByRole("button", { name: /Sample update/ }));
  await user.click(await screen.findByRole("button", { name: "Apply saved results" }));
  const dialog = await screen.findByRole("dialog", { name: "Apply saved results" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Apply saved results" })).toBeEnabled());
  expect(within(dialog).getByText(/these 2 items together/)).toBeInTheDocument();
  expect(within(dialog).getByText("Item 0 · zh-CN", { selector: "li" })).toBeInTheDocument();
  expect(within(dialog).getByText("Item 100 · zh-CN", { selector: "li" })).toBeInTheDocument();
  expect(invoke.mock.calls.some(([name, payload]) => name === "read_execution_attempt" && payload.request.offset === 100 && payload.request.limit === 100)).toBe(true);
  await user.click(within(dialog).getByRole("button", { name: "Apply saved results" }));
  await screen.findByRole("heading", { name: "Recorded changes" });
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_execution_adoption").map(([, payload]) => payload.request))
    .toEqual([{ ...fixture.prepare, resultIds: unit.resultIds }]);
});

it("confirms a generic action with no changes and a zero cancellation basis using Chinese feedback", async () => {
  const user = await openTasks(applicationDetail());
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  taskReplies({ create_execution_identity: () => fixture.prepare.actionId,
    prepare_execution_adoption: () => ({ ...fixture.action, parameters: null, cancellationRevision: "0" }),
    adopt_execution: () => ({ ...fixture.receipt, changes: [] }) });
  await user.click(screen.getByRole("button", { name: "应用保存的结果" }));
  await user.click(within(screen.getByRole("dialog", { name: "应用保存的结果" })).getByRole("button", { name: "应用保存的结果" }));
  await screen.findByRole("heading", { name: "已记录的变更" });
  expect(screen.getByText("此操作已记录，没有产生项目变更。")).toBeInTheDocument();
  expect(screen.getByText(/原应用操作已确认/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "核对已记录结果" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重试原应用请求" })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution").map(([, payload]) => payload.request)).toEqual([fixture.adopt]);
});
it("keeps the complete original recovery after lost ACK, wrong lookup and later rejection", async () => {
  const value = detail();
  value.recovery.units[0].actions = ["resume-undispatched"];
  value.recovery.units[0].blockedReason = null;
  value.progress.unknown = 0; value.progress.queued = 1;
  value.items[0].status.execution = "queued";
  const user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: "Continue remaining work" }));
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Continue remaining work" })).getByRole("button", { name: "Continue remaining work" })).toBeEnabled());
  taskReplies({ create_execution_identity: () => fixtureIdentity(6), continue_execution: () => Promise.reject(new Error("lost ACK")) });
  await user.click(within(screen.getByRole("dialog", { name: "Continue remaining work" })).getByRole("button", { name: "Continue remaining work" }));
  const check = await screen.findByRole("button", { name: "Check original recovery request" });
  const original = invoke.mock.calls.find(([command]) => command === "continue_execution")![1].request as ContinuationRequest;
  expect(original.action).toMatchObject({ kind: "resume-undispatched", expectedCancellationRevision: "0", itemIds: value.recovery.units[0].remainingItemIds });
  expect(screen.queryByRole("button", { name: "Retry the same recovery request" })).not.toBeInTheDocument();
  // A shaped but unrelated receipt cannot acknowledge the pending original intent.
  taskReplies({ read_execution_continuation: () => ({ ...continuationResult(original), action: { ...original.action, unitId: fixtureIdentity(8) } }) });
  await user.click(check);
  expect(await screen.findByText(/original recovery request is still unconfirmed/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry the same recovery request" })).not.toBeInTheDocument();
  taskReplies({ read_execution_continuation: () => null });
  await user.click(screen.getByRole("button", { name: "Check original recovery request" }));
  const retry = await screen.findByRole("button", { name: "Retry the same recovery request" });
  taskReplies({ continue_execution: () => Promise.reject({ code: "cancelled", outcome: "rejected", stage: "execution-recover", recoveryRequired: false, reason: "continuation-cancellation-basis" }) });
  await user.click(retry);
  expect(await screen.findByText(/original recovery request is still unconfirmed/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry the same recovery request" })).not.toBeInTheDocument();
  const writes = invoke.mock.calls.filter(([command]) => command === "continue_execution");
  expect(writes).toHaveLength(2); expect(writes[1][1]).toEqual(writes[0][1]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  taskReplies({ read_execution_continuation: () => continuationResult(original) });
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
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Continue remaining work" })).getByRole("button", { name: "Continue remaining work" })).toBeEnabled());
  taskReplies({ create_execution_identity: () => fixtureIdentity(6), continue_execution: () => Promise.reject(new Error("lost ACK")) });
  await user.click(within(screen.getByRole("dialog", { name: "Continue remaining work" })).getByRole("button", { name: "Continue remaining work" }));
  taskReplies({ read_execution_continuation: () => null });
  await user.click(await screen.findByRole("button", { name: "Check original recovery request" }));
  taskReplies({ continue_execution: () => Promise.reject(new Error("second ACK lost")) });
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

function recordedContinuation(index: number): ContinuationReceipt {
  return { ...fixture.continuationReceipt, taskId: task.taskId, operation: task.operation,
    sequence: (9007199254740993n + BigInt(index)).toString(), attemptId: fixtureIdentity(1600 + index),
    action: { ...fixture.continuationReceipt.action, kind: "resume-undispatched", actionId: fixtureIdentity(1500 + index), expectedCancellationRevision: "0" } };
}

it("retains exact continuation history pagination across a complete consumer remount without treating a terminal page as absence", async () => {
  const value = detail(), records = Array.from({ length: 50 }, (_, index) => recordedContinuation(index));
  const next = records.at(-1)!.sequence;
  invoke.mockImplementation(async (command: string, payload: { request: { after?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task") return [fixture.summary];
    if (command === "read_execution_attempt") return value;
    if (command === "read_execution_continuations") return payload.request.after === "0" ? { receipts: records, next } : { receipts: [], next: null };
    throw new Error(command);
  });
  const user = userEvent.setup(), view = render(<ExecutionTasks project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: /Sample update/ }));
  const history = await screen.findByRole("region", { name: "Recorded recovery requests" });
  await waitFor(() => expect(within(history).getAllByRole("button", { name: "View continued work" })).toHaveLength(50));
  await user.click(within(history).getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(within(history).getByRole("button", { name: "First page" })).toBeEnabled());
  await waitFor(() => expect(within(history).queryByRole("button", { name: "View continued work" })).not.toBeInTheDocument());
  expect(within(history).queryByText(i18n.t("execution.noContinuationHistory"))).not.toBeInTheDocument();
  view.rerender(null, project); view.rerender(<ExecutionTasks project={project} disabled={false} />);
  const reopened = await screen.findByRole("region", { name: "Recorded recovery requests" });
  await waitFor(() => expect(within(reopened).getByRole("button", { name: "First page" })).toBeEnabled());
  expect(within(reopened).queryByText(i18n.t("execution.noContinuationHistory"))).not.toBeInTheDocument();
  await user.click(within(reopened).getByRole("button", { name: "First page" }));
  await waitFor(() => expect(within(reopened).getAllByRole("button", { name: "View continued work" })).toHaveLength(50));
  expect(invoke.mock.calls.filter(([command]) => command === "read_execution_continuations").map(([, payload]) => payload.request))
    .toContainEqual({ ...fixture.session, sourceAttemptId: value.attemptId, after: next, limit: 50 });
  expect(invoke.mock.calls.some(([command]) => command === "continue_execution" || command === "create_execution_identity")).toBe(false);
});

it.each(["action", "attempt", "task", "operation", "digest", "sequence"] as const)("rejects a changed recorded continuation %s without navigating or resubmitting", async field => {
  const value = detail(), saved = recordedContinuation(0), found = structuredClone(saved);
  if (field === "action") found.action.unitId = fixtureIdentity(1700);
  if (field === "attempt") found.attemptId = fixtureIdentity(1701);
  if (field === "task") found.taskId = fixtureIdentity(1702);
  if (field === "operation") found.operation = "another-operation";
  if (field === "digest") found.sourceInputDigest = "d".repeat(64);
  if (field === "sequence") found.sequence = "9007199254740994";
  invoke.mockImplementation(async (command: string) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task") return [fixture.summary];
    if (command === "read_execution_attempt") return value;
    if (command === "read_execution_continuations") return { receipts: [saved], next: null };
    if (command === "read_execution_continuation") return found;
    throw new Error(command);
  });
  const user = userEvent.setup(); render(<ExecutionTasks project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" })); await user.click(await screen.findByRole("button", { name: /Sample update/ }));
  await user.click(await screen.findByRole("button", { name: "View continued work" }));
  await screen.findByRole("alert");
  expect(invoke).toHaveBeenCalledWith("read_execution_continuation", { request: { ...fixture.session, actionId: saved.action.actionId } });
  expect(invoke.mock.calls.filter(([command]) => command === "read_execution_attempt").every(([, payload]) => payload.request.attemptId === value.attemptId)).toBe(true);
  expect(invoke.mock.calls.some(([command]) => command === "continue_execution" || command === "create_execution_identity")).toBe(false);
});

it("ignores a late exact-history lookup after a different Task selection", async () => {
  const saved = recordedContinuation(0), value = detail(), fresh = detail();
  fresh.taskId = fixtureIdentity(1710); fresh.attemptId = fixtureIdentity(1711); fresh.recovery.attemptId = fresh.attemptId;
  fresh.items[0].scope.id = "Fresh task item"; fresh.recovery.units[0].scopes[0].id = "Fresh task item";
  let finish!: (receipt: ContinuationReceipt) => void;
  const pending = new Promise<ContinuationReceipt>(resolve => { finish = resolve; });
  invoke.mockImplementation(async (command: string, payload: { request: { taskId?: string; attemptId?: string; sourceAttemptId?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task, { ...task, taskId: fresh.taskId, sequence: "2" }];
    if (command === "read_execution_task") return [{ attemptId: payload.request.taskId === fresh.taskId ? fresh.attemptId : value.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return payload.request.attemptId === fresh.attemptId ? fresh : value;
    if (command === "read_execution_continuations") return payload.request.sourceAttemptId === value.attemptId ? { receipts: [saved], next: null } : { receipts: [], next: null };
    if (command === "read_execution_continuation") return pending;
    throw new Error(command);
  });
  const user = userEvent.setup(); render(<ExecutionTasks project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" })); await user.click(await screen.findByRole("button", { name: "Sample update · Task 1" }));
  await user.click(await screen.findByRole("button", { name: "View continued work" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "read_execution_continuation")).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: "All tasks" }));
  await user.click(await screen.findByRole("button", { name: "Sample update · Task 2" }));
  await screen.findByText("Fresh task item · zh-CN", { selector: "strong" });
  await act(async () => { finish(saved); await pending; });
  expect(screen.getByText("Fresh task item · zh-CN", { selector: "strong" })).toBeInTheDocument();
  expect(invoke.mock.calls.some(([command, payload]) => command === "read_execution_attempt" && payload.request.attemptId === saved.attemptId)).toBe(false);
  expect(invoke.mock.calls.some(([command]) => command === "continue_execution" || command === "create_execution_identity")).toBe(false);
});

it.each(["mismatch", "null", "rejected"] as const)("awaits a fresh repeated history selection despite a successful cache before a deferred %s", async outcome => {
  const saved = recordedContinuation(0), original = detail(), continued = detail();
  original.items[0].scope.id = "Original history item"; original.recovery.units[0].scopes[0].id = "Original history item";
  continued.attemptId = saved.attemptId; continued.recovery.attemptId = saved.attemptId;
  continued.items[0].scope.id = "Continued history item"; continued.recovery.units[0].scopes[0].id = "Continued history item";
  let finish!: (value: ContinuationReceipt | null) => void, reject!: (reason: unknown) => void;
  const deferred = new Promise<ContinuationReceipt | null>((resolve, fail) => { finish = resolve; reject = fail; });
  let lookups = 0;
  invoke.mockImplementation(async (command: string, payload: { request: { attemptId?: string; sourceAttemptId?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task") return lookups === 0 ? [fixture.summary]
      : [fixture.summary, { attemptId: saved.attemptId, sequence: "2" }];
    if (command === "read_execution_attempt") return payload.request.attemptId === saved.attemptId ? continued : original;
    if (command === "read_execution_continuations") return payload.request.sourceAttemptId === original.attemptId ? { receipts: [saved], next: null } : { receipts: [], next: null };
    if (command === "read_execution_continuation") return ++lookups === 1 ? saved : deferred;
    throw new Error(command);
  });
  let reads!: ReturnType<typeof useSessionReads>;
  function TasksWithReads() {
    const value = useSessionReads(); useLayoutEffect(() => { reads = value; });
    return <ExecutionTasks project={project} disabled={false} />;
  }
  const user = userEvent.setup(); render(<TasksWithReads />, project);
  await user.click(screen.getByRole("button", { name: "Tasks" })); await user.click(await screen.findByRole("button", { name: /Sample update/ }));
  await user.click(await screen.findByRole("button", { name: "View continued work" }));
  await screen.findByText("Continued history item · zh-CN", { selector: "strong" });
  const cached = reads.client.getQueryCache().findAll({ queryKey: reads.key(["execution-continuation"]) })
    .find(query => query.state.status === "success");
  expect(cached).toBeDefined();
  const cachedData = cached!.state.data;
  expect(cachedData).toBeDefined();
  await user.selectOptions(screen.getByRole("combobox", { name: "Execution history" }), original.attemptId);
  await screen.findByText("Original history item · zh-CN", { selector: "strong" });
  const destinationReads = () => invoke.mock.calls.filter(([command, payload]) => command === "read_execution_attempt" && payload.request.attemptId === saved.attemptId).length;
  const previousReads = destinationReads();
  await user.click(await screen.findByRole("button", { name: "View continued work" }));
  await waitFor(() => expect(lookups).toBe(2));
  // The original selection must stay visible while this selection's exact read is still unresolved.
  expect(screen.getByRole("combobox", { name: "Execution history" })).toHaveValue(original.attemptId);
  expect(screen.getByText("Original history item · zh-CN", { selector: "strong" })).toBeInTheDocument();
  expect(destinationReads()).toBe(previousReads);
  expect(reads.client.getQueryData(cached!.queryKey)).toEqual(cachedData);
  await act(async () => {
    if (outcome === "mismatch") finish({ ...saved, requestDigest: "d".repeat(64) });
    else if (outcome === "null") finish(null);
    else reject({ code: "dependency-conflict", outcome: "rejected", stage: "execution-read", recoveryRequired: false });
    await deferred.catch(() => {});
  });
  await screen.findByRole("alert");
  expect(screen.getByRole("combobox", { name: "Execution history" })).toHaveValue(original.attemptId);
  expect(screen.getByText("Original history item · zh-CN", { selector: "strong" })).toBeInTheDocument();
  expect(destinationReads()).toBe(previousReads);
  expect(reads.client.getQueryData(cached!.queryKey)).toEqual(cachedData);
  expect(invoke.mock.calls.filter(([command]) => command === "read_execution_continuation").map(([, payload]) => payload.request))
    .toEqual(Array(2).fill({ ...fixture.session, actionId: saved.action.actionId }));
  expect(invoke.mock.calls.some(([command]) => command === "continue_execution" || command === "create_execution_identity")).toBe(false);
});
