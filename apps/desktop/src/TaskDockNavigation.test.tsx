import { createRef, useLayoutEffect, useState, type RefObject } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { ProjectSessionWorkbench, type ProjectSessionHandle } from "./ProjectSessionWorkbench";
import { WorkspaceViewMemory, WorkspaceViewProvider, type WorkspaceArea } from "./WorkbenchFrame";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "./workbenchCommands";
import type { AttemptDetail, PrepareRequest, TaskActivity, Task } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const project: ProjectView = { sessionToken: "dock-navigation-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(1700), displayName: "Synthetic task navigation", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const receiptAction = fixtureIdentity(1730);
let memory: WorkspaceViewMemory, currentArea: WorkspaceArea, first: AttemptDetail, second: AttemptDetail;
let failAdoption = false;

function detail(base: number, name: string, applied: boolean): AttemptDetail {
  const value = structuredClone(fixture.detail) as AttemptDetail;
  value.taskId = fixtureIdentity(base); value.attemptId = fixtureIdentity(base + 1);
  value.progress = { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, unknown: 0, adopted: applied ? 1 : 0 };
  value.items = [{ scope: { kind: "sample", id: name, locale: "zh-CN" }, resultId: fixtureIdentity(base + 3),
    status: { itemId: fixtureIdentity(base + 2), execution: "succeeded", validation: "valid", adoption: applied ? "committed" : "unapplied",
      cancellationRequested: false, retrySafe: false, diagnostic: null } }];
  value.recovery = { attemptId: value.attemptId, units: [{ unitId: fixtureIdentity(base + 4), itemIds: [value.items[0].status.itemId],
    scopes: [value.items[0].scope], resultIds: [value.items[0].resultId!], remainingItemIds: [],
    actions: applied ? ["view-receipt"] : ["adopt-result"], blockedReason: null, receiptId: applied ? receiptAction : null }] };
  return value;
}
function task(value: AttemptDetail): Task {
  return { taskId: value.taskId, projectId: project.metadata.projectId, operation: value.operation,
    sequence: value.taskId === first.taskId ? "1" : "2", cancellationRevision: "0" };
}
function activity(): TaskActivity {
  return { total: "2", active: "0", attention: "0", saved: "2", rows: [first, second].map(value => ({
    taskId: value.taskId, attemptId: value.attemptId, operation: value.operation, sequence: task(value).sequence, phase: "saved" as const, progress: value.progress,
  })) };
}
function ProductionHarness({ session }: { session: RefObject<ProjectSessionHandle | null> }) {
  const [area, setArea] = useState<WorkspaceArea>("overview");
  const [viewMemory] = useState(() => new WorkspaceViewMemory());
  const [commands] = useState(() => new WorkbenchCommands());
  useLayoutEffect(() => { memory = viewMemory; currentArea = area; });
  return <ApplicationReadProvider><WorkbenchCommandsProvider commands={commands}>
    <WorkspaceViewProvider value={{ area, memory: viewMemory, activate: setArea,
      deactivate: closing => setArea(current => current === closing ? "overview" : current) }}>
      <ProjectSessionWorkbench ref={session} project={project} disabled={false} onActivate={setArea} onCoordinatingChange={() => {}} />
    </WorkspaceViewProvider>
  </WorkbenchCommandsProvider></ApplicationReadProvider>;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function readsFor(command: string, key: string, identity: string) {
  return calls(command).filter(([, args]) => args.request[key] === identity);
}
function dock() { return within(screen.getByRole("complementary", { name: "Background tasks" })); }
function taskPanel() { return within(screen.getByRole("region", { name: "Tasks" })); }
async function openDock() {
  const summary = dock().getByText("Background tasks", { exact: false, selector: "summary" });
  await userEvent.click(summary);
  await waitFor(() => expect(dock().getByRole("button", { name: /Task 1/ })).toBeEnabled());
}
async function openFirst(session = createRef<ProjectSessionHandle>()) {
  render(<ProductionHarness session={session} />); await openDock();
  await userEvent.click(dock().getByRole("button", { name: /Task 1/ }));
  await waitFor(() => expect(taskPanel().getByRole("button", { name: "Cancel remaining work" })).toBeEnabled());
  expect(memory.read("tasks", "taskId")).toBe(first.taskId);
  return session;
}
async function overview(session: RefObject<ProjectSessionHandle | null>) {
  await act(async () => { expect(await session.current!.navigate({ kind: "area", area: "overview" })).toBe(true); });
  await waitFor(() => expect(currentArea).toBe("overview"));
  expect(screen.queryByRole("heading", { name: "Tasks" })).not.toBeInTheDocument();
  await waitFor(() => expect(dock().getByRole("button", { name: /Task 2/ })).toBeEnabled());
}
async function refuseDockRetargeting() {
  const before = calls("read_execution_attempt").length;
  await userEvent.click(dock().getByRole("button", { name: /Task 2/ }));
  await waitFor(() => expect(dock().getByRole("button", { name: /Task 2/ })).toBeEnabled());
  expect(currentArea).toBe("overview"); expect(memory.read("tasks", "taskId")).toBe(first.taskId);
  await userEvent.click(dock().getByRole("button", { name: "All tasks" }));
  await waitFor(() => expect(dock().getByRole("button", { name: "All tasks" })).toBeEnabled());
  expect(currentArea).toBe("overview"); expect(memory.read("tasks", "attemptId")).toBe(first.attemptId);
  expect(calls("read_execution_attempt")).toHaveLength(before);
  expect(readsFor("read_execution_task", "taskId", second.taskId)).toHaveLength(0);
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  first = detail(1710, "Task A entry", true); second = detail(1720, "Task B entry", false); failAdoption = false;
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, payload?: { request: Record<string, unknown> }) => {
    const request = payload?.request ?? {};
    const selected = [first, second].find(value => value.attemptId === request.attemptId || value.taskId === request.taskId);
    if (command === "read_project_changes") return { projectId: project.metadata.projectId, sessionToken: project.sessionToken,
      epoch: fixtureIdentity(1701), sequence: "0", progressSequence: "0", scopes: [], runtime: fixture.status };
    if (command === "read_content_scope") return { revision: "0", currentSnapshot: null };
    if (command === "read_execution_task_activity") return activity();
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task(first), task(second)];
    if (command === "read_execution_task_view" && selected) return task(selected);
    if (command === "read_execution_task" && selected) return [{ attemptId: selected.attemptId, sequence: task(selected).sequence }];
    if (command === "read_execution_attempt" && selected) return structuredClone(selected);
    if (command === "read_execution_continuations") return { receipts: [], next: null };
    if (command === "read_execution_receipt") return { ...fixture.receipt, projectId: project.metadata.projectId,
      attemptId: first.attemptId, actionId: receiptAction, unitId: first.recovery.units[0].unitId,
      changes: [{ kind: "sample-update", id: "Only task A recorded change", revision: "1" }] };
    if (command === "read_execution_output" && selected) return { ...fixture.output, projectId: project.metadata.projectId,
      attemptId: selected.attemptId, itemId: selected.items[0].status.itemId, resultId: selected.items[0].resultId,
      outcome: "succeeded", output: { note: selected === first ? "Only task A saved output" : "Only task B saved output" }, diagnostic: null };
    if (command === "create_execution_identity") return fixtureIdentity(1740);
    if (command === "cancel_execution_task") throw new Error("Synthetic lost cancellation acknowledgement");
    if (command === "prepare_execution_adoption") {
      const original = request as unknown as PrepareRequest;
      return { ...fixture.action, projectId: original.projectId, attemptId: original.attemptId, actionId: original.actionId,
        unitId: original.unitId, resultIds: original.resultIds, operation: first.operation, cancellationRevision: "0", parameters: null };
    }
    if (command === "adopt_execution" && failAdoption) throw new Error("Synthetic lost adoption acknowledgement");
    throw new Error(`Unexpected synthetic task navigation command: ${command}`);
  });
});
afterEach(cleanup);

it("clears task A output and receipt when the production Dock opens B, and All tasks returns to the list", async () => {
  const session = await openFirst();
  await userEvent.click(taskPanel().getByRole("button", { name: "View saved output" }));
  expect(await screen.findByText(/Only task A saved output/)).toBeVisible();
  await userEvent.click(taskPanel().getByRole("button", { name: "View recorded changes" }));
  expect(await screen.findByText(/Only task A recorded change/)).toBeVisible();
  expect(memory.read("tasks", "outputSelection")).not.toBeNull();
  expect(memory.read("tasks", "receiptSelection")).not.toBeNull();
  await overview(session);
  const outputsBefore = readsFor("read_execution_output", "attemptId", first.attemptId).length;
  const receiptsBefore = calls("read_execution_receipt").length;
  await userEvent.click(dock().getByRole("button", { name: /Task 2/ }));
  await waitFor(() => expect(taskPanel().getByText(/Task B entry/, { selector: "strong" })).toBeVisible());
  expect(memory.read("tasks", "taskId")).toBe(second.taskId);
  for (const key of ["outputSelection", "savedOutput", "receiptSelection", "confirmation", "historySelection"]) {
    expect(memory.read("tasks", key)).toBeNull();
  }
  expect(screen.queryByText(/Only task A recorded change/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Only task A saved output/)).not.toBeInTheDocument();
  expect(readsFor("read_execution_output", "attemptId", first.attemptId)).toHaveLength(outputsBefore);
  expect(calls("read_execution_receipt")).toHaveLength(receiptsBefore);
  await userEvent.click(dock().getByRole("button", { name: "All tasks" }));
  await waitFor(() => expect(taskPanel().getByRole("button", { name: /Sample update.*Task 1/ })).toBeVisible());
  expect(taskPanel().getByRole("button", { name: /Sample update.*Task 2/ })).toBeVisible();
  expect(memory.read("tasks", "taskId")).toBeNull(); expect(memory.read("tasks", "attemptId")).toBeNull();
  expect(memory.read("tasks", "cursor")).toBe("0");
  expect(taskPanel().queryByRole("region", { name: "Execution summary" })).not.toBeInTheDocument();
  expect(calls("list_execution_tasks").length).toBeGreaterThan(0);
});

it("keeps an unknown cancellation in its real session owner when Dock navigation is attempted elsewhere", async () => {
  const session = await openFirst();
  await userEvent.click(taskPanel().getByRole("button", { name: "Cancel remaining work" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel remaining work" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel remaining work" }));
  await within(dialog).findByRole("button", { name: "Retry the original cancellation" });
  await userEvent.click(within(dialog).getByRole("button", { name: i18n.t("execution.back") }));
  await overview(session); await refuseDockRetargeting();
  expect(calls("cancel_execution_task")).toHaveLength(1);
  expect(calls("create_execution_identity")).toHaveLength(1);
});

it("preserves the actual confirming task decision across workspaces and refuses Dock retargeting", async () => {
  first = detail(1710, "Task A entry", false);
  const session = await openFirst();
  await userEvent.click(taskPanel().getByRole("button", { name: "Apply saved results" }));
  await screen.findByRole("dialog", { name: "Apply saved results" });
  await overview(session); await refuseDockRetargeting();
  await act(async () => { expect(await session.current!.navigate({ kind: "area", area: "tasks" })).toBe(true); });
  const original = await screen.findByRole("dialog", { name: "Apply saved results" });
  expect(within(original).getByText(/Task A entry/)).toBeVisible();
  expect(calls("create_execution_identity")).toHaveLength(0);
  expect(calls("prepare_execution_adoption")).toHaveLength(0); expect(calls("adopt_execution")).toHaveLength(0);
});

it("retains an uncertain original adoption without new execution when Dock task or list navigation is attempted", async () => {
  first = detail(1710, "Task A entry", false); failAdoption = true;
  const session = await openFirst();
  await userEvent.click(taskPanel().getByRole("button", { name: "Apply saved results" }));
  const dialog = await screen.findByRole("dialog", { name: "Apply saved results" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Apply saved results" }));
  await within(dialog).findByRole("button", { name: "Check recorded outcome" });
  await userEvent.click(within(dialog).getByRole("button", { name: i18n.t("execution.back") }));
  await overview(session); await refuseDockRetargeting();
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("prepare_execution_adoption")).toHaveLength(1); expect(calls("adopt_execution")).toHaveLength(1);
});
