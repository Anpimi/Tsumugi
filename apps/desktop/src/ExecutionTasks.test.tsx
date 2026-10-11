import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionTasks } from "./ExecutionTasks";
import { i18n } from "./i18n";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { ProjectView } from "./projectCommands";
import type { AttemptDetail } from "./executionCommands";
import { createRef, useLayoutEffect } from "react";
import type { TasksHandle } from "./ExecutionTasks";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session-1", locator: "C:\\isolated\\project", metadata: { projectId: fixture.session.projectId, displayName: "Demo", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" }, reconciliationState: "settled" };
const task = { taskId: fixture.detail.taskId, projectId: fixture.session.projectId, operation: "sample-update", sequence: "1", cancellationRevision: "0" };
function detail(): AttemptDetail { return structuredClone(fixture.detail) as AttemptDetail; }
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("retains the original cancellation after a complete Tasks remount and blocks project leave", async () => {
  const ref = createRef<TasksHandle>(), user = userEvent.setup();
  let cancelCount = 0;
  invoke.mockImplementation(async (command: string) => {
    if (command === "execution_status") return fixture.status;
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
async function openTasks(value = detail()) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task") return [{ attemptId: value.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return value;
    throw new Error(`Unexpected command: ${command}`);
  });
  const user = userEvent.setup();
  render(<ExecutionTasks project={project} disabled={false} />);
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
  invoke.mockResolvedValueOnce({ attemptId: fixtureIdentity(3), queryStarted: false });
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
