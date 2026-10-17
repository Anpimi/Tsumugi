import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionTasks, type TasksHandle } from "./ExecutionTasks";
import { i18n } from "./i18n";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { hasUnknownOutcome, isCommandError, type CommandError, type ProjectView } from "./projectCommands";
import { savedPluginBuild } from "./testSupport/pluginBuildFixture";
import type { SavedPluginBuildView } from "./releaseCommands";
import type { AttemptDetail, ContinuationRequest, ContinuationReceipt } from "./executionCommands";
import { createRef, useLayoutEffect, type RefObject } from "react";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { useSessionReads } from "./SessionReadProvider";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session-1", locator: "C:\\isolated\\project", metadata: { projectId: fixture.session.projectId, displayName: "Demo", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" }, reconciliationState: "settled" };
const task = { taskId: fixture.detail.taskId, projectId: fixture.session.projectId, operation: "sample-update", sequence: "1", cancellationRevision: "0" };
function detail(): AttemptDetail { return structuredClone(fixture.detail) as AttemptDetail; }
function savedBuildDetail(saved: SavedPluginBuildView): AttemptDetail {
  return { attemptId: saved.attemptId, taskId: saved.taskId, operation: "locale-build", nextOffset: null,
    items: saved.locales.map(locale => ({ scope: { kind: "release-build", id: saved.sourceSnapshotId, locale: locale.choice.locale }, status: locale.status, resultId: locale.result?.resultId ?? null })),
    progress: { total: saved.locales.length, queued: 0, running: 0, succeeded: saved.locales.length, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
    recovery: { attemptId: saved.attemptId, units: [{ unitId: fixtureIdentity(830), itemIds: saved.locales.map(locale => locale.itemId), scopes: saved.locales.map(locale => ({ kind: "release-build", id: saved.sourceSnapshotId, locale: locale.choice.locale })),
      resultIds: saved.locales.flatMap(locale => locale.result ? [locale.result.resultId] : []), remainingItemIds: [], actions: [], blockedReason: "external-new-consent", receiptId: null }] } };
}
async function openSavedBuild(options: { saved?: SavedPluginBuildView; onSavedBuild?: (id: string) => Promise<boolean>; read?: () => Promise<SavedPluginBuildView> } = {}) {
  const saved = { ...structuredClone(options.saved ?? savedPluginBuild), projectId: project.metadata.projectId };
  const value = savedBuildDetail(saved);
  invoke.mockImplementation(async (command: string) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [{ ...task, taskId: saved.taskId, operation: "locale-build" }];
    if (command === "read_execution_task") return [{ attemptId: saved.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return value;
    if (command === "read_execution_task_view") return { ...task, taskId: saved.taskId, operation: "locale-build" };
    if (command === "read_execution_continuations") return { receipts: [], next: null };
    if (command === "read_saved_plugin_build") return options.read ? options.read() : saved;
    if (command === "read_execution_cancellation_action") return null;
    throw new Error(`Unexpected command: ${command}`);
  });
  const user = userEvent.setup();
  render(<ExecutionTasks project={project} disabled={false} onSavedBuild={options.onSavedBuild} />);
  await user.click(screen.getByRole("button", { name: i18n.t("execution.title") }));
  await user.click(await screen.findByRole("button", { name: `${i18n.t("release.title")} · ${i18n.t("execution.taskNumber", { number: "1" })}` }));
  await screen.findByRole("button", { name: i18n.t("execution.output") });
  return { user, saved };
}
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
    if (command === "read_execution_task_view") return task;
    if (command === "read_execution_task") return [fixture.summary];
    if (command === "read_execution_attempt") return detail();
    if (command === "create_execution_identity") return fixtureIdentity(201);
    if (command === "cancel_execution_task") { if (++cancelCount === 1) throw new Error("Disconnected"); return "4"; }
    if (command === "read_execution_cancellation_action") return null;
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
    if (command === "read_execution_cancellation_action") return null;
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
async function mountTasks(value = detail(), ref?: RefObject<TasksHandle | null>) {
  invoke.mockImplementation(async (command: string, args: { request: { attemptId?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [{ ...task, taskId: value.taskId, operation: value.operation }];
    if (command === "read_execution_task") return [{ attemptId: value.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") {
      const captured = structuredClone(value);
      return { ...captured, attemptId: args.request.attemptId, recovery: { ...captured.recovery, attemptId: args.request.attemptId } };
    }
    if (command === "read_execution_task_view") return { ...task, taskId: value.taskId, operation: value.operation };
    if (command === "read_execution_cancellation_action") return null;
    if (command === "read_execution_continuations") return { receipts: [], next: null };
    throw new Error(`Unexpected command: ${command}`);
  });
  const user = userEvent.setup();
  const view = render(<ExecutionTasks project={project} disabled={false} ref={ref} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: /Task 1/ }));
  await screen.findByRole("region", { name: "Execution summary" });
  return { user, view };
}
async function openTasks(value = detail(), ref?: RefObject<TasksHandle | null>) { return (await mountTasks(value,ref)).user; }
function taskReplies(replies: Record<string, () => unknown>) {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => replies[command] ? replies[command]() : command === "read_execution_cancellation_action" ? Promise.resolve(null) : original(command, payload));
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
  taskReplies({ read_execution_adoption_action: () => ({action:{...fixture.action,parameters:null},receipt:fixture.receipt}) });
  await user.click(check);
  await screen.findByRole("heading", { name: "Recorded changes" });
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "recover_execution")).toBe(false);
  const prepared = invoke.mock.calls.find(([command]) => command === "prepare_execution_adoption")![1].request;
  expect(invoke).toHaveBeenCalledWith("read_execution_adoption_action", { request: prepared });
});
it("discards a previous selection's late detail response", async () => {
  let resolveOld!: (value: AttemptDetail) => void;
  const old = new Promise<AttemptDetail>(resolve => { resolveOld = resolve; });
  const fresh = detail(); fresh.attemptId = fixtureIdentity(1); fresh.items[0].scope.id = "New selection";
  fresh.taskId = fixtureIdentity(2); fresh.recovery.attemptId = fresh.attemptId;
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
    adopt_execution: () => fixture.receipt, read_execution_adoption_action: () => null });
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
  const literalDetail = '<img src=x onerror="fetch(\'https://example.invalid\')"> https://example.invalid';
  invoke.mockResolvedValueOnce({ ...fixture.output,
    sourceFailure: { code: "invalid-source", artifactId: "captured-1", detail: literalDetail } });
  await user.click(screen.getByRole("button", { name: "View failure details" }));
  const result = await screen.findByRole("region", { name: "Result for Sample A" });
  expect(within(result).getByText(/did not generate usable output/)).toBeInTheDocument();
  expect(within(result).queryByText("null")).not.toBeInTheDocument();
  expect(result).toHaveFocus();
  expect(result.closest("li")).toContainElement(screen.getByText("Sample A · zh-CN", { selector: "strong" }));
  await user.click(within(result).getByText("Technical details"));
  expect(within(result).getByText(literalDetail, { exact: false })).toBeVisible();
  expect(within(result).getByText("captured-1")).toBeVisible();
  expect(result.querySelector("img")).toBeNull();
  expect(within(result).queryByRole("link")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry eligible failures" }));
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Retry eligible failures" })).getByRole("button", { name: "Retry eligible failures" })).toBeEnabled());
  taskReplies({ create_execution_identity: () => fixtureIdentity(6) });
  const replies = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: ContinuationRequest }) => command === "continue_execution"
    ? Promise.resolve(continuationResult(payload.request)) : replies(command, payload));
  await user.click(within(screen.getByRole("dialog", { name: "Retry eligible failures" })).getByRole("button", { name: "Retry eligible failures" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Result for Sample A" })).not.toBeInTheDocument());
});

it("keeps a successful output's warning separate from failure retry guidance", async () => {
  const value = detail();
  value.items[0].status.execution = "succeeded";
  value.items[0].status.validation = "valid";
  value.items[0].resultId = fixture.prepare.resultIds[0];
  const user = await openTasks(value);
  invoke.mockResolvedValueOnce({ ...fixture.output, outcome: "succeeded", output: { complete: true }, diagnostic: { code: "source-template", retrySafe: false } });
  await user.click(screen.getByRole("button", { name: "View saved output" }));
  const result = await screen.findByRole("region", { name: "Result for Sample A" });
  expect(within(result).getByText(/"complete": true/)).toBeInTheDocument();
  expect(within(result).queryByText(i18n.t("execution.unsafeFailure"))).not.toBeInTheDocument();
  await user.click(within(result).getByText("Technical details"));
  expect(within(result).getByText("source-template")).toBeVisible();
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

it.each(["en-US", "zh-CN"])("shows every saved plugin artifact and original target count without generic checking in %s", async language => {
  await i18n.changeLanguage(language);
  const { user, saved } = await openSavedBuild();
  await user.click(screen.getByRole("button", { name: i18n.t("execution.output") }));
  const summary = await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  expect(within(summary).getByText(i18n.t("releasePlugin.savedTargets", { count: 2 }))).toBeInTheDocument();
  expect(within(summary).getByText(i18n.t("releasePlugin.savedReadOnly"))).toBeInTheDocument();
  const artifacts = within(summary).getByRole("list", { name: i18n.t("releasePlugin.savedArtifacts", { locale: "zh-CN" }) });
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(2);
  for (const artifact of saved.locales[0].result!.artifacts) {
    expect(within(artifacts).getByText(artifact.logicalPath, { selector: "strong" })).toBeInTheDocument();
    expect(within(artifacts).getByText(`${i18n.t("releasePlugin.savedRole", { role: artifact.role })} · ${i18n.t("releasePlugin.bytes", { count: artifact.byteLength })}`)).toBeInTheDocument();
    expect(within(artifacts).getByLabelText(i18n.t("releasePlugin.savedSha", { path: artifact.logicalPath }))).toHaveTextContent(artifact.sha256);
  }
  expect(screen.queryByRole("button", { name: i18n.t("execution.actions.validate-output") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.every(([command]) => ["execution_status", "list_execution_tasks", "read_execution_task", "read_execution_task_view", "read_execution_attempt", "read_execution_continuations", "read_saved_plugin_build"].includes(command))).toBe(true);
  expect(invoke).toHaveBeenCalledWith("read_saved_plugin_build", { request: { sessionToken: project.sessionToken, projectId: project.metadata.projectId, attemptId: saved.attemptId } });
});

it.each(["task", "item", "result"] as const)("refuses a saved build with a different %s and recovers by reading the same selection", async mismatch => {
  const correct = { ...structuredClone(savedPluginBuild), projectId: project.metadata.projectId };
  const wrong = structuredClone(correct);
  if (mismatch === "task") wrong.taskId = fixtureIdentity(888);
  if (mismatch === "item") { wrong.locales[0].itemId = fixtureIdentity(888); wrong.locales[0].status.itemId = fixtureIdentity(888); }
  if (mismatch === "result") wrong.locales[0].result!.resultId = fixtureIdentity(888);
  let response = wrong;
  const { user } = await openSavedBuild({ read: async () => response });
  await user.click(screen.getByRole("button", { name: i18n.t("execution.output") }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(i18n.t("releasePlugin.savedReadFailed"));
  expect(screen.queryByRole("region", { name: i18n.t("releasePlugin.savedTitle") })).not.toBeInTheDocument();
  expect(screen.getByText(`${correct.sourceSnapshotId} · zh-CN`, { selector: "strong" })).toBeInTheDocument();
  response = correct;
  await user.click(within(alert).getByRole("button", { name: i18n.t("releasePlugin.savedRefresh") }));
  await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  expect(invoke.mock.calls.filter(([command]) => command === "read_saved_plugin_build").map(([, args]) => args.request.attemptId)).toEqual([correct.attemptId, correct.attemptId]);
});

it("shows a continued build's reused result through its logical saved attempt without requiring a rewritten output frame", async () => {
  const continued = { ...structuredClone(savedPluginBuild), attemptId: fixtureIdentity(891) };
  const originalResult = continued.locales[0].result!.resultId;
  const { user, saved } = await openSavedBuild({ saved: continued });
  await user.click(screen.getByRole("button", { name: i18n.t("execution.output") }));
  const summary = await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  const artifacts = within(summary).getByRole("list", { name: i18n.t("releasePlugin.savedArtifacts", { locale: "zh-CN" }) });
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(2);
  for (const artifact of saved.locales[0].result!.artifacts) {
    expect(within(artifacts).getByLabelText(i18n.t("releasePlugin.savedSha", { path: artifact.logicalPath }))).toHaveTextContent(artifact.sha256);
  }
  expect(saved.locales[0].result!.resultId).toBe(originalResult);
  expect(invoke).toHaveBeenCalledWith("read_saved_plugin_build", { request: { sessionToken: project.sessionToken, projectId: project.metadata.projectId, attemptId: continued.attemptId } });
  expect(invoke.mock.calls.some(([command]) => command === "read_execution_output" || command === "start_plugin_build" || command === "create_execution_identity")).toBe(false);
});

it("keeps Tasks open when the saved-build owner refuses navigation and forwards the exact attempt on acceptance", async () => {
  const navigate = vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(false);
  const { user, saved } = await openSavedBuild({ onSavedBuild: navigate });
  const route = screen.getByRole("button", { name: i18n.t("releasePlugin.savedOpen") });
  await user.click(route);
  expect(navigate).toHaveBeenLastCalledWith(saved.attemptId);
  expect(await screen.findByText(i18n.t("execution.savedBuildBlocked"))).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: i18n.t("execution.title") })).toBeVisible();
  navigate.mockResolvedValue(true);
  await user.click(route);
  expect(navigate.mock.calls).toEqual([[saved.attemptId], [saved.attemptId]]);
  expect(screen.queryByRole("heading", { name: i18n.t("execution.title") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.every(([command]) => command.startsWith("read_") || command === "execution_status" || command === "list_execution_tasks")).toBe(true);
});

it("retains saved Plugin build evidence while recovering the exact original unknown cancellation", async () => {
  const navigate = vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(true);
  const { user, saved } = await openSavedBuild({ onSavedBuild: navigate });
  await user.click(screen.getByRole("button", { name: i18n.t("execution.output") }));
  await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  const original = invoke.getMockImplementation()!;
  const rejection: CommandError = { code: "busy", stage: "execution-cancel", outcome: "rejected", recoveryRequired: false, reason: "execution-storage" };
  expect(isCommandError(rejection)).toBe(true);
  expect(hasUnknownOutcome(rejection)).toBe(false);
  let sent = 0;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? Promise.resolve(fixtureIdentity(920))
    : command === "cancel_execution_task" ? ++sent === 1 ? Promise.reject(new Error("Cancellation ACK lost"))
      : sent === 2 ? Promise.reject(rejection) : Promise.resolve("1")
      : original(command, payload));
  await user.click(screen.getByRole("button", { name: i18n.t("execution.cancel") }));
  await user.click(within(screen.getByRole("dialog", { name: i18n.t("execution.cancel") })).getByRole("button", { name: i18n.t("execution.cancel") }));
  await screen.findByRole("button", { name: i18n.t("execution.retryCancellation") });
  await user.click(screen.getByRole("button", { name: i18n.t("execution.deferContinuation") }));
  expect(screen.getByRole("button", { name: i18n.t("execution.allTasks") })).toBeDisabled();
  const route = screen.getByRole("button", { name: i18n.t("releasePlugin.savedOpen") });
  expect(route).toBeDisabled();
  await user.click(route);
  expect(navigate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: i18n.t("execution.retryCancellation") }));
  await waitFor(() => expect(sent).toBe(2));
  expect(screen.queryByRole("button",{name:i18n.t("execution.retryCancellation")})).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:i18n.t("execution.checkCancellation")}));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("execution.retryCancellation") })).toBeEnabled());
  expect(screen.getByText(i18n.t("execution.cancellationUnconfirmed"))).toBeInTheDocument();
  expect(screen.getByRole("button", { name: i18n.t("execution.allTasks") })).toBeDisabled();
  const artifacts = within(screen.getByRole("region", { name: i18n.t("releasePlugin.savedTitle") })).getByRole("list", { name: i18n.t("releasePlugin.savedArtifacts", { locale: "zh-CN" }) });
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(saved.locales[0].result!.artifacts.length);
  for (const artifact of saved.locales[0].result!.artifacts) {
    expect(within(artifacts).getByLabelText(i18n.t("releasePlugin.savedSha", { path: artifact.logicalPath }))).toHaveTextContent(artifact.sha256);
  }
  await user.click(screen.getByRole("button", { name: i18n.t("execution.retryCancellation") }));
  await waitFor(() => expect(screen.queryByRole("button", { name: i18n.t("execution.retryCancellation") })).not.toBeInTheDocument());
  expect(invoke.mock.calls.filter(([command]) => command === "cancel_execution_task").map(([, args]) => args.request)).toEqual(Array(3).fill({ ...fixture.session, taskId: saved.taskId, requestId: fixtureIdentity(920) }));
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "read_execution_output" || command === "start_plugin_build")).toBe(false);
  expect(screen.getByRole("region", { name: i18n.t("releasePlugin.savedTitle") })).toBeInTheDocument();
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
    if (command === "read_execution_task_view") return Promise.resolve(task);
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
  const value = applicationDetail(), user = userEvent.setup(), ref = createRef<TasksHandle>(); let lookups=0;
  invoke.mockImplementation(async command => {
    if (command === "execution_status") return fixture.status;
    if (command === "read_execution_continuations") return Promise.resolve({ receipts: [], next: null });
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task_view") return task;
    if (command === "read_execution_task") return [fixture.summary];
    if (command === "read_execution_attempt") return value;
    if (command === "create_execution_identity") return fixture.prepare.actionId;
    if (command === "prepare_execution_adoption") return { ...fixture.action, parameters: null };
    if (command === "adopt_execution") throw new Error("Lost adoption ACK");
    if (command === "read_execution_adoption_action") {if(++lookups===1)throw new Error("Automatic lookup unavailable");return {action:{...fixture.action,parameters:null},receipt:fixture.receipt};}
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
  expect(invoke.mock.calls.filter(([name]) => name === "read_execution_adoption_action").map(([, payload]) => payload.request)).toEqual([fixture.prepare,fixture.prepare]);
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
    if (command === "read_execution_task_view") return task;
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
  taskReplies({ continue_execution: () => Promise.reject(new Error("second ACK lost")), read_execution_continuation: () => Promise.reject(new Error("Automatic lookup unavailable")) });
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
  const view = await screen.findByRole("button", { name: "View continued work" });
  await waitFor(() => expect(view).toBeEnabled());
  await user.click(view);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_execution_attempt", { request: { ...fixture.session, attemptId: saved.attemptId, offset: 0, limit: 100 } }));
  expect(invoke.mock.calls.some(([command]) => command === "continue_execution" || command === "create_execution_identity")).toBe(false);
  expect(await handle.current!.allowLeave()).toBe(true);
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("captures the complete revision-zero recovery before identity await and reserves it synchronously", async () => {
  const value = detail(); value.recovery.units[0].actions = ["resume-undispatched"];
  const handle = createRef<TasksHandle>();
  const user = await openTasks(value, handle);
  const identity = deferred<string>();
  const read = invoke.getMockImplementation()!;
  let sent: ContinuationRequest | undefined;
  invoke.mockImplementation(async (command: string, args: { request: ContinuationRequest }) => {
    if (command === "create_execution_identity") return identity.promise;
    if (command === "continue_execution") { sent = args.request; throw new Error("lost ACK"); }
    return read(command, args);
  });
  await user.click(screen.getByRole("button", { name: "Continue remaining work" }));
  const submit = within(screen.getByRole("dialog")).getByRole("button", { name: "Continue remaining work" });
  await act(async () => { submit.click(); submit.click(); expect(await handle.current!.allowLeave()).toBe(false); });
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  const original = structuredClone(value.recovery.units[0]);
  task.cancellationRevision = "9";
  value.recovery.units[0].remainingItemIds = [fixtureIdentity(908)];
  value.recovery.units[0].unitId = fixtureIdentity(909);
  try {
    await act(async () => { identity.resolve(fixtureIdentity(906)); await identity.promise; });
    await screen.findByRole("button", { name: "Check original recovery request" });
    expect(sent).toEqual({ ...fixture.session, action: { actionId: fixtureIdentity(906), projectId: project.metadata.projectId,
      sourceAttemptId: value.attemptId, unitId: original.unitId, kind: "resume-undispatched", itemIds: original.remainingItemIds, expectedCancellationRevision: "0" } });
    expect(invoke.mock.calls.filter(([command]) => command === "continue_execution")).toHaveLength(1);
  } finally { task.cancellationRevision = "0"; }
});

it.each(["identity", "ack"] as const)("discards a replaced session's late continuation %s without dispatching into its replacement", async stage => {
  const value = detail(); value.recovery.units[0].actions = ["resume-undispatched"];
  const user = await openTasks(value);
  const response = deferred<string | ContinuationReceipt>();
  const read = invoke.getMockImplementation()!;
  let original: ContinuationRequest | undefined;
  invoke.mockImplementation(async (command: string, args: { request: ContinuationRequest }) => {
    if (command === "create_execution_identity") return stage === "identity" ? response.promise : fixtureIdentity(906);
    if (command === "continue_execution") { original = args.request; return response.promise; }
    return read(command, args);
  });
  await user.click(screen.getByRole("button", { name: "Continue remaining work" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Continue remaining work" }));
  cleanup();
  const replacement = { ...project, sessionToken: "session-2" };
  render(<ExecutionTasks project={replacement} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await screen.findByRole("button", { name: "Sample update · Task 1" });
  const callsBefore = invoke.mock.calls.length;
  await act(async () => { response.resolve(stage === "identity" ? fixtureIdentity(906) : continuationResult(original!)); await response.promise; });
  expect(invoke.mock.calls.slice(callsBefore).some(([command]) => command === "continue_execution" || command === "read_execution_attempt")).toBe(false);
  expect(invoke.mock.calls.filter(([command]) => command === "continue_execution")).toHaveLength(stage === "identity" ? 0 : 1);
  expect(screen.queryByRole("button", { name: "Check original recovery request" })).not.toBeInTheDocument();
  expect(screen.queryByText(i18n.t("execution.done"))).not.toBeInTheDocument();
});

it("does not dispatch a continuation when its retained owner becomes unavailable during identity allocation", async () => {
  const value = detail(); value.recovery.units[0].actions = ["resume-undispatched"];
  const identity = deferred<string>();
  invoke.mockImplementation(async (command: string) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task_view") return task;
    if (command === "read_execution_task") return [{ attemptId: value.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return value;
    if (command === "read_execution_continuations") return { receipts: [], next: null };
    if (command === "create_execution_identity") return identity.promise;
    throw new Error(`Unexpected command: ${command}`);
  });
  const user = userEvent.setup(); const view = render(<ExecutionTasks project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: "Sample update · Task 1" }));
  await user.click(await screen.findByRole("button", { name: "Continue remaining work" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Continue remaining work" }));
  view.rerender(<ExecutionTasks project={project} disabled />);
  await act(async () => { identity.resolve(fixtureIdentity(906)); await identity.promise; });
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue remaining work" })).toBeDisabled();
  expect(screen.getByRole("button", { name: i18n.t("workbench.backOverview") })).toBeDisabled();
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "continue_execution")).toBe(false);
  expect(screen.queryByText(i18n.t("execution.done"))).not.toBeInTheDocument();
});

it.each(["wrong", "absent", "rejected"] as const)("requires another fresh exact read after a successful history choice when the repeated lookup is %s", async result => {
  const value = detail(); value.recovery.units[0].actions = [];
  const record = continuationResult({ ...fixture.continuation, action: { ...fixture.continuation.action, kind: "resume-undispatched", expectedCancellationRevision: "0" } });
  const later = deferred<ContinuationReceipt | null>();
  let lookups = 0;
  invoke.mockImplementation(async (command: string, args: { request: { attemptId?: string; sourceAttemptId?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task_view") return task;
    if (command === "read_execution_task") return [{ attemptId: value.attemptId, sequence: "1" }, { attemptId: record.attemptId, sequence: record.sequence }];
    if (command === "read_execution_attempt") return { ...value, attemptId: args.request.attemptId, recovery: { ...value.recovery, attemptId: args.request.attemptId }, items: value.items.map(item => ({ ...item, scope: { ...item.scope, id: args.request.attemptId === record.attemptId ? "Continued item" : "Original item" } })) };
    if (command === "read_execution_continuations") return { receipts: args.request.sourceAttemptId === value.attemptId ? [record] : [], next: null };
    if (command === "read_execution_continuation") return ++lookups === 1 ? record : later.promise;
    throw new Error(`Unexpected command: ${command}`);
  });
  const user = userEvent.setup(); render(<ExecutionTasks project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: "Sample update · Task 1" }));
  await screen.findByText("Continued item · zh-CN", { selector: "strong" });
  await user.selectOptions(screen.getByRole("combobox"), value.attemptId);
  await screen.findByText("Original item · zh-CN", { selector: "strong" });
  const first = await screen.findByRole("button", { name: "View continued work" });
  await waitFor(() => expect(first).toBeEnabled()); await user.click(first);
  await screen.findByText("Continued item · zh-CN", { selector: "strong" });
  await user.selectOptions(screen.getByRole("combobox"), value.attemptId);
  const again = await screen.findByRole("button", { name: "View continued work" });
  await waitFor(() => expect(again).toBeEnabled());
  await user.click(again);
  expect(lookups).toBe(2);
  expect(screen.getByText("Original item · zh-CN", { selector: "strong" })).toBeInTheDocument();
  const continuedReads = () => invoke.mock.calls.filter(([command, args]) => command === "read_execution_attempt" && args.request.attemptId === record.attemptId).length;
  const before = continuedReads();
  await act(async () => {
    if (result === "rejected") later.reject({ code: "storage-failed" });
    else later.resolve(result === "absent" ? null : { ...record, requestDigest: "d".repeat(64) });
    await later.promise.catch(() => undefined);
  });
  await screen.findByRole("alert");
  expect(screen.getByText("Original item · zh-CN", { selector: "strong" })).toBeInTheDocument();
  expect(continuedReads()).toBe(before);
  expect(invoke.mock.calls.some(([command]) => command === "continue_execution" || command === "create_execution_identity")).toBe(false);
});

it("keeps a plugin continuation pending across deferral and rejects saved-build routing without clearing its saved output", async () => {
  const navigate = vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(true);
  const saved = { ...structuredClone(savedPluginBuild), projectId: project.metadata.projectId };
  saved.locales[0].status.execution = "failed"; saved.locales[0].status.retrySafe = true;
  saved.locales[0].status.validation = "absent"; saved.locales[0].status.diagnostic = "known-build-failure";
  saved.locales[0].result!.outcome = "failed"; saved.locales[0].result!.artifacts = [];
  const value = savedBuildDetail(saved); value.recovery.units[0].actions = ["retry-safe-failure"];
  value.recovery.units[0].remainingItemIds = [value.items[0].status.itemId];
  value.recovery.units[0].blockedReason = null;
  value.progress.succeeded = 0; value.progress.failed = 1;
  const next = fixtureIdentity(918);
  let pending: ContinuationRequest | undefined;
  invoke.mockImplementation(async (command: string, args: { request: ContinuationRequest & { attemptId?: string; sourceAttemptId?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [{ ...task, taskId: saved.taskId, operation: "locale-build" }];
    if (command === "read_execution_task_view") return { ...task, taskId: saved.taskId, operation: "locale-build" };
    if (command === "read_execution_task") return [{ attemptId: saved.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return { ...value, attemptId: args.request.attemptId, recovery: { ...value.recovery, attemptId: args.request.attemptId } };
    if (command === "read_execution_continuations") return { receipts: [], next: null };
    if (command === "read_saved_plugin_build") return saved;
    if (command === "create_execution_identity") return fixtureIdentity(919);
    if (command === "continue_execution") { pending = args.request; throw new Error("lost ACK"); }
    if (command === "read_execution_continuation") {
      if(invoke.mock.calls.filter(([name])=>name==="read_execution_continuation").length===1)throw new Error("Automatic lookup unavailable");
      return { ...continuationResult(pending!), attemptId: next, taskId: saved.taskId, operation: "locale-build" };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const user = userEvent.setup(); const handle = createRef<TasksHandle>();
  render(<ExecutionTasks project={project} disabled={false} onSavedBuild={navigate} ref={handle} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: `${i18n.t("release.title")} · ${i18n.t("execution.taskNumber", { number: "1" })}` }));
  await user.click(await screen.findByRole("button", { name: i18n.t("execution.failureDetails") }));
  await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  await user.click(screen.getByRole("button", { name: "Retry eligible failures" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Retry eligible failures" }));
  await user.click(await screen.findByRole("button", { name: "Keep request and return" }));
  const route = screen.getByRole("button", { name: i18n.t("releasePlugin.savedOpen") });
  expect(route).toBeDisabled(); expect(screen.getByRole("combobox")).toBeDisabled();
  await user.click(route); expect(navigate).not.toHaveBeenCalled();
  expect(await handle.current!.allowLeave()).toBe(false);
  expect(screen.getByRole("region", { name: i18n.t("releasePlugin.savedTitle"), hidden: true })).toBeInTheDocument();
  await user.click(within(screen.getByRole("dialog", { name: "Retry eligible failures" })).getByRole("button", { name: "Keep request and return" }));
  await user.click(screen.getByRole("button", { name: i18n.t("workbench.backOverview") }));
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: "Check original recovery request" }));
  await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue(next));
  expect(screen.queryByRole("region", { name: i18n.t("releasePlugin.savedTitle") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "continue_execution")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_build" || command === "recover_execution")).toBe(false);
});

it("pages continuation history independently of result items and confirms its full-page terminal cursor", async () => {
  const value = detail(); value.recovery.units[0].actions = []; value.nextOffset = 100;
  const records = Array.from({ length: 50 }, (_, index) => {
    const action: ContinuationRequest["action"] = { ...fixture.continuation.action, kind: "resume-undispatched", actionId: fixtureIdentity(1000 + index), expectedCancellationRevision: "0" };
    return { ...continuationResult({ ...fixture.session, action }), sequence: String(index + 2), attemptId: fixtureIdentity(1100 + index) };
  });
  invoke.mockImplementation(async (command: string, args: { request: { after?: string; offset?: number; sourceAttemptId?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task_view") return task;
    if (command === "read_execution_task") return [{ attemptId: value.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return args.request.offset === 0 ? value : { ...value, items: [], nextOffset: null };
    if (command === "read_execution_continuations") return args.request.after === "0" ? { receipts: records, next: "51" } : { receipts: [], next: null };
    throw new Error(`Unexpected command: ${command}`);
  });
  const user = userEvent.setup(); render(<ExecutionTasks project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: "Sample update · Task 1" }));
  const history = await screen.findByRole("region", { name: "Recorded recovery requests" });
  await waitFor(() => expect(within(history).getAllByRole("button", { name: "View continued work" })).toHaveLength(50));
  const nextHistory = within(history).getByRole("button", { name: "Next page" });
  await waitFor(() => expect(nextHistory).toBeEnabled()); await user.click(nextHistory);
  await waitFor(() => expect(within(history).queryAllByRole("button", { name: "View continued work" })).toHaveLength(0));
  expect(invoke).toHaveBeenCalledWith("read_execution_continuations", { request: { ...fixture.session, sourceAttemptId: value.attemptId, after: "51", limit: 50 } });
  expect(screen.getByText("Sample A · zh-CN", { selector: "strong" })).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "read_execution_attempt").every(([, args]) => args.request.offset === 0)).toBe(true);
  await user.click(within(history).getByRole("button", { name: "First page" }));
  await waitFor(() => expect(within(history).getAllByRole("button", { name: "View continued work" })).toHaveLength(50));
  expect(invoke.mock.calls.some(([command]) => command === "read_execution_continuation" || command === "continue_execution" || command === "create_execution_identity")).toBe(false);
});

function continuationDetail() {
  const value=detail();value.recovery.units[0].actions=["resume-undispatched"];value.recovery.units[0].blockedReason=null;
  value.items[0].status.execution="queued";value.progress.queued=1;value.progress.unknown=0;return value;
}
function capturedApplicationDetail() {
  const value=detail();value.recovery.units[0].actions=["adopt-result"];value.recovery.units[0].blockedReason=null;
  value.recovery.units[0].resultIds=[...fixture.prepare.resultIds];value.items[0].resultId=fixture.prepare.resultIds[0];
  value.items[0].status.execution="succeeded";value.items[0].status.validation="valid";value.progress.succeeded=1;value.progress.unknown=0;return value;
}

it("locks synchronously and keeps the confirmed revision-zero scope after current Task facts change before identity completes", async () => {
  const value=continuationDetail(),handle=createRef<TasksHandle>(),{user}=await mountTasks(value,handle),originalUnit=structuredClone(value.recovery.units[0]);
  await user.click(screen.getByRole("button",{name:"Continue remaining work"}));
  const original=invoke.getMockImplementation()!,identity=deferred<string>();
  invoke.mockImplementation((command:string,payload:unknown)=>command==="create_execution_identity"?identity.promise
    :command==="read_execution_task_view"?Promise.resolve({...task,cancellationRevision:"2"})
    :command==="continue_execution"?Promise.reject({code:"cancelled",outcome:"rejected",stage:"execution-recover",recoveryRequired:false,reason:"continuation-cancellation-basis"})
    :original(command,payload));
  await refreshWorkbenchReads();await waitFor(()=>expect(invoke.mock.calls.filter(([name])=>name==="read_execution_task_view").length).toBeGreaterThan(1));
  value.recovery.units[0].unitId=fixtureIdentity(60);value.recovery.units[0].remainingItemIds=[fixtureIdentity(61)];
  const submit=within(screen.getByRole("dialog",{name:"Continue remaining work"})).getByRole("button",{name:"Continue remaining work"});
  act(()=>{submit.click();submit.click();});
  expect(invoke.mock.calls.filter(([name])=>name==="create_execution_identity")).toHaveLength(1);
  expect(await handle.current!.allowLeave()).toBe(false);
  await act(async()=>{identity.resolve(fixtureIdentity(62));});
  await screen.findByRole("alert");
  const requests=invoke.mock.calls.filter(([name])=>name==="continue_execution").map(([,args])=>args.request);
  expect(requests).toEqual([{...fixture.session,action:{actionId:fixtureIdentity(62),projectId:fixture.session.projectId,
    sourceAttemptId:fixture.detail.attemptId,unitId:originalUnit.unitId,kind:"resume-undispatched",itemIds:originalUnit.remainingItemIds,expectedCancellationRevision:"0"}}]);
  expect(invoke.mock.calls.some(([name])=>name==="recover_execution")).toBe(false);
});

it.each(["identity","prepare","ack"] as const)("blocks the next adoption write and late owner updates when the session is replaced during %s", async stage => {
  const value=capturedApplicationDetail(),handle=createRef<TasksHandle>(),{user,view}=await mountTasks(value,handle),response=deferred<unknown>(),original=invoke.getMockImplementation()!;
  await user.click(screen.getByRole("button",{name:"Apply saved results"}));
  const waiting=stage==="identity"?"create_execution_identity":stage==="prepare"?"prepare_execution_adoption":"adopt_execution";
  invoke.mockImplementation((command:string,payload:unknown)=>command===waiting?response.promise
    :command==="create_execution_identity"?Promise.resolve(fixture.prepare.actionId):command==="prepare_execution_adoption"?Promise.resolve({...fixture.action,parameters:null}):original(command,payload));
  act(()=>within(screen.getByRole("dialog",{name:"Apply saved results"})).getByRole("button",{name:"Apply saved results"}).click());
  await waitFor(()=>expect(invoke.mock.calls.filter(([name])=>name===waiting)).toHaveLength(1));
  expect(await handle.current!.allowLeave()).toBe(false);
  const replacement={...project,sessionToken:"replacement-session"};view.rerender(<ExecutionTasks project={replacement} disabled={false} ref={handle}/>);
  await act(async()=>{response.resolve(stage==="identity"?fixture.prepare.actionId:stage==="prepare"?{...fixture.action,parameters:null}:fixture.receipt);});
  expect(invoke.mock.calls.filter(([name])=>name==="adopt_execution")).toHaveLength(stage==="ack"?1:0);
  expect(invoke.mock.calls.filter(([name])=>name==="prepare_execution_adoption")).toHaveLength(stage==="identity"?0:1);
  expect(screen.queryByRole("heading",{name:"Recorded changes"})).not.toBeInTheDocument();
  expect(await handle.current!.allowLeave()).toBe(true);
});

it("keeps an uncertain application across Keep output and requires actual absence before an exact replay whose rejection remains unknown", async () => {
  const captured=capturedApplicationDetail(),handle=createRef<TasksHandle>(),{user}=await mountTasks(captured,handle);
  await user.click(screen.getByRole("button",{name:"Apply saved results"}));
  taskReplies({create_execution_identity:()=>fixture.prepare.actionId,prepare_execution_adoption:()=>Promise.reject(new Error("Preparation ACK lost"))});
  await user.click(within(screen.getByRole("dialog",{name:"Apply saved results"})).getByRole("button",{name:"Apply saved results"}));
  await screen.findByRole("button",{name:"Check recorded outcome"});
  await user.click(screen.getByRole("button",{name:"Keep output and return"}));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:i18n.t("workbench.backOverview")}));
  let leaveAllowed!:boolean;await act(async()=>{leaveAllowed=await handle.current!.allowLeave();});expect(leaveAllowed).toBe(false);
  const check=await screen.findByRole("button",{name:"Check recorded outcome"});
  taskReplies({read_execution_adoption_action:()=>({action:{...fixture.action,parameters:null},receipt:{...fixture.receipt,unitId:fixtureIdentity(70)}})});
  await user.click(check);await screen.findByRole("alert");
  expect(screen.queryByRole("button",{name:"Retry the same application"})).not.toBeInTheDocument();
  taskReplies({read_execution_adoption_action:()=>null});
  const nextCheck=await screen.findByRole("button",{name:"Check recorded outcome"});
  expect(nextCheck).toBeEnabled();await user.click(nextCheck);
  const retry=await screen.findByRole("button",{name:"Retry the same application"});
  expect(invoke.mock.calls.filter(([name])=>name==="read_execution_adoption_action").map(([,args])=>args.request)).toEqual([
    fixture.prepare,fixture.prepare,fixture.prepare,
  ]);
  const replayRejection:CommandError={code:"cancelled",outcome:"rejected",stage:"execution-adopt",recoveryRequired:false,reason:"action-cancellation-basis"};
  expect(isCommandError(replayRejection)).toBe(true);expect(hasUnknownOutcome(replayRejection)).toBe(false);
  taskReplies({prepare_execution_adoption:()=>Promise.reject(replayRejection)});
  await user.click(retry);await screen.findByText(i18n.t("execution.adoptionUnconfirmed"));
  const original=screen.getByRole("region",{name:i18n.t("execution.originalAction")});
  expect(JSON.parse(original.querySelector("pre")?.textContent??"")).toEqual({taskId:captured.taskId,operation:captured.operation,
    unit:captured.recovery.units[0],request:fixture.prepare});
  expect(screen.queryByRole("button",{name:"Retry the same application"})).not.toBeInTheDocument();
  expect(within(original).getByRole("button",{name:"Check recorded outcome"})).toBeEnabled();
  expect(screen.getByRole("button",{name:"All tasks",hidden:true})).toBeDisabled();expect(await handle.current!.allowLeave()).toBe(false);
  const requests=invoke.mock.calls.filter(([name])=>name==="prepare_execution_adoption").map(([,args])=>args.request);
  expect(requests).toEqual([fixture.prepare,fixture.prepare]);expect(invoke.mock.calls.filter(([name])=>name==="create_execution_identity")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name])=>name==="read_execution_adoption_action").map(([,args])=>args.request)).toEqual([
    fixture.prepare,fixture.prepare,fixture.prepare,
  ]);
  expect(invoke.mock.calls.filter(([name])=>name==="adopt_execution")).toHaveLength(0);
  expect(invoke.mock.calls.filter(([name])=>name==="recover_execution")).toHaveLength(0);
});

it.each(["sequence","task","operation","null","rejected"] as const)("performs a new exact history lookup after a successful earlier choice and rejects a deferred %s", async outcome => {
  const value=detail();value.recovery.units[0].actions=[];
  const {user}=await mountTasks(value),original=invoke.getMockImplementation()!;
  const request:ContinuationRequest={...fixture.continuation,action:{...fixture.continuation.action,kind:"resume-undispatched",expectedCancellationRevision:"0"}},record=continuationResult(request);
  invoke.mockImplementation((command:string,payload:{request:{sourceAttemptId?:string}})=>command==="read_execution_continuations"?
    Promise.resolve({receipts:payload.request.sourceAttemptId===value.attemptId?[record]:[],next:null}):command==="read_execution_continuation"?Promise.resolve(record):original(command,payload));
  await refreshWorkbenchReads();await user.click(await screen.findByRole("button",{name:"View continued work"}));
  await waitFor(()=>expect(screen.getByRole("combobox")).toHaveValue(record.attemptId));
  await user.selectOptions(screen.getByRole("combobox"),value.attemptId);
  const choose=await screen.findByRole("button",{name:"View continued work"});await waitFor(()=>expect(choose).toBeEnabled());
  const pending=deferred<ContinuationReceipt|null>(),before=invoke.mock.calls.filter(([name])=>name==="read_execution_continuation").length,withHistory=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="read_execution_continuation"?pending.promise:withHistory(command,payload));
  await user.click(choose);await waitFor(()=>expect(invoke.mock.calls.filter(([name])=>name==="read_execution_continuation")).toHaveLength(before+1));
  await act(async()=>{
    if(outcome==="null")pending.resolve(null);else if(outcome==="rejected")pending.reject(new Error("Exact lookup failed"));
    else pending.resolve({...record,...(outcome==="sequence"?{sequence:"3"}:outcome==="task"?{taskId:fixtureIdentity(80)}:{operation:"other-operation"})});
  });
  await screen.findByRole("alert");expect(screen.getByRole("combobox")).toHaveValue(value.attemptId);
  expect(invoke.mock.calls.some(([name])=>name==="continue_execution"||name==="create_execution_identity")).toBe(false);
});

it("keeps the history cursor separate from item paging and reads a bounded empty terminal page without false absence", async () => {
  const value=detail();value.recovery.units[0].actions=[];const{user}=await mountTasks(value),original=invoke.getMockImplementation()!;
  const records=Array.from({length:50},(_,index)=>({...fixture.continuationReceipt,sequence:String(index+2),attemptId:fixtureIdentity(200+index),
    action:{...fixture.continuationReceipt.action,kind:"resume-undispatched" as const,actionId:fixtureIdentity(100+index),expectedCancellationRevision:"0"}}));
  invoke.mockImplementation((command:string,payload:{request:{after?:string}})=>command==="read_execution_continuations"?Promise.resolve(payload.request.after==="0"?
    {receipts:records,next:records.at(-1)!.sequence}:{receipts:[],next:null}):original(command,payload));
  await refreshWorkbenchReads();const history=screen.getByRole("heading",{name:"Recorded recovery requests"}).closest("section")!;
  await waitFor(()=>expect(within(history).getAllByRole("button",{name:"View continued work"})).toHaveLength(50));
  await user.click(within(history).getByRole("button",{name:"Next page"}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("read_execution_continuations",{request:{...fixture.session,sourceAttemptId:value.attemptId,after:records.at(-1)!.sequence,limit:50}}));
  await waitFor(()=>expect(within(history).queryByRole("button",{name:"View continued work"})).not.toBeInTheDocument());
  expect(within(history).getByRole("button",{name:"First page"})).toBeEnabled();
  expect(within(history).queryByText(i18n.t("execution.noContinuationHistory"))).not.toBeInTheDocument();
  const offsets=invoke.mock.calls.filter(([name])=>name==="read_execution_attempt").map(([,args])=>args.request.offset);
  expect(offsets.length).toBeGreaterThan(0);expect(offsets.every(offset=>offset===0)).toBe(true);
});

it.each(["source-import","translation-import","ai-translation","arena-translation"] as const)("routes %s application to its original preview owner without an execution adoption", async operation => {
  const value=capturedApplicationDetail();value.operation=operation;const{user,view}=await mountTasks(value);
  const source=vi.fn(),translation=vi.fn(),ai=vi.fn(),arena=vi.fn();
  view.rerender(<ExecutionTasks project={project} disabled={false} onSourcePreview={source} onTranslationPreview={translation} onAiPreview={ai} onArenaPreview={arena}/>);
  const label=operation==="source-import"?i18n.t("source.preview"):operation==="translation-import"?i18n.t("translation.preview"):i18n.t("execution.actions.adopt-result");
  await user.click(screen.getAllByRole("button",{name:label})[0]);
  const expected=operation==="source-import"?source:operation==="translation-import"?translation:operation==="ai-translation"?ai:arena;
  expect(expected).toHaveBeenCalledExactlyOnceWith(value.attemptId);
  expect([source,translation,ai,arena].filter(callback=>callback!==expected).every(callback=>callback.mock.calls.length===0)).toBe(true);
  expect(invoke.mock.calls.some(([name])=>name==="create_execution_identity"||name==="prepare_execution_adoption"||name==="adopt_execution")).toBe(false);
});

it("retains an authorized reused output while keeping an unknown original application for later recovery", async () => {
  const{user}=await mountTasks(capturedApplicationDetail());
  invoke.mockResolvedValueOnce({...fixture.output,attemptId:fixtureIdentity(90),outcome:"succeeded",output:{saved:"Original output"},diagnostic:null});
  await user.click(screen.getByRole("button",{name:"View saved output"}));
  const result=await screen.findByRole("region",{name:"Result for Sample A"});expect(within(result).getByText(/Original output/)).toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"Apply saved results"}));
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockRejectedValueOnce(new Error("Preparation ACK lost"));
  await user.click(within(screen.getByRole("dialog",{name:"Apply saved results"})).getByRole("button",{name:"Apply saved results"}));
  await user.click(await screen.findByRole("button",{name:"Keep output and return"}));
  expect(screen.getByRole("button",{name:"Check recorded outcome"})).toBeInTheDocument();
  expect(within(screen.getByRole("region",{name:"Result for Sample A"})).getByText(/Original output/)).toBeInTheDocument();
  expect(invoke.mock.calls.find(([name])=>name==="read_execution_output")![1].request).toEqual(fixture.outputRequest);
});

it("preserves the original unknown cancellation through malformed ACK and later rejection and only replays that request", async () => {
  const handle=createRef<TasksHandle>(),{user}=await mountTasks(detail(),handle),original=invoke.getMockImplementation()!;let sent=0;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="create_execution_identity"?Promise.resolve(fixtureIdentity(95))
    :command==="cancel_execution_task"?++sent===1?Promise.reject(new Error("Cancel ACK lost")):sent===2?Promise.resolve("0")
    :sent===3?Promise.reject({code:"busy",outcome:"rejected",stage:"execution-cancel",recoveryRequired:false,reason:"execution-storage"}):Promise.resolve("1")
    :original(command,payload));
  await user.click(screen.getByRole("button",{name:"Cancel remaining work"}));
  await user.click(within(screen.getByRole("dialog",{name:"Cancel remaining work"})).getByRole("button",{name:"Cancel remaining work"}));
  await screen.findByRole("button",{name:"Retry the original cancellation"});
  await user.click(screen.getByRole("button",{name:"Keep request and return"}));
  expect(screen.getByRole("button",{name:"Cancel remaining work"})).toBeDisabled();expect(screen.getByRole("button",{name:"All tasks"})).toBeDisabled();
  expect(await handle.current!.allowLeave()).toBe(false);
  await user.click(screen.getByRole("button",{name:"Retry the original cancellation"}));
  await waitFor(()=>expect(sent).toBe(2));await waitFor(()=>expect(screen.getByRole("button",{name:"Retry the original cancellation"})).toBeEnabled());
  expect(screen.getByText(i18n.t("execution.cancellationUnconfirmed"))).toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"Retry the original cancellation"}));
  await waitFor(()=>expect(sent).toBe(3));expect(screen.queryByRole("button",{name:"Retry the original cancellation"})).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:i18n.t("execution.checkCancellation")}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Retry the original cancellation"})).toBeEnabled());
  expect(await handle.current!.allowLeave()).toBe(false);expect(screen.getByRole("button",{name:"Cancel remaining work"})).toBeDisabled();
  await user.click(screen.getByRole("button",{name:"Retry the original cancellation"}));
  await waitFor(()=>expect(screen.queryByRole("button",{name:"Retry the original cancellation"})).not.toBeInTheDocument());
  const request={...fixture.session,taskId:fixture.detail.taskId,requestId:fixtureIdentity(95)};
  expect(invoke.mock.calls.filter(([name])=>name==="cancel_execution_task").map(([,args])=>args.request)).toEqual([request,request,request,request]);
  expect(invoke.mock.calls.filter(([name])=>name==="create_execution_identity")).toHaveLength(1);expect(await handle.current!.allowLeave()).toBe(true);
});

it("blocks close and ignores a late original cancellation ACK after an actual session replacement", async () => {
  const handle=createRef<TasksHandle>(),{user,view}=await mountTasks(detail(),handle),original=invoke.getMockImplementation()!,ack=deferred<string>();let sent=0;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="create_execution_identity"?Promise.resolve(fixtureIdentity(96))
    :command==="cancel_execution_task"?++sent===1?Promise.reject(new Error("Cancel ACK lost")):ack.promise:original(command,payload));
  await user.click(screen.getByRole("button",{name:"Cancel remaining work"}));
  await user.click(within(screen.getByRole("dialog",{name:"Cancel remaining work"})).getByRole("button",{name:"Cancel remaining work"}));
  await user.click(await screen.findByRole("button",{name:"Keep request and return"}));
  const retry=screen.getByRole("button",{name:"Retry the original cancellation"});
  act(()=>{retry.click();retry.click();});await waitFor(()=>expect(sent).toBe(2));expect(await handle.current!.allowLeave()).toBe(false);
  const replacement={...project,sessionToken:"new-cancellation-session"};view.rerender(<ExecutionTasks project={replacement} disabled={false} ref={handle}/>);
  await act(async()=>{ack.resolve("1");});
  expect(screen.queryByText(i18n.t("execution.cancellationUnconfirmed"))).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name])=>name==="create_execution_identity")).toHaveLength(1);
  const requests=invoke.mock.calls.filter(([name])=>name==="cancel_execution_task").map(([,args])=>args.request);
  expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);expect(await handle.current!.allowLeave()).toBe(true);
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
    if (command === "read_execution_task_view") return task;
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
    if (command === "read_execution_task_view") return task;
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
    if (command === "read_execution_task_view") return { ...task,taskId:payload.request.taskId };
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
    if (command === "read_execution_task_view") return task;
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
