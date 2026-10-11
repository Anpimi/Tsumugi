import { createRef, useLayoutEffect } from "react";
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { TaskCancellationFeedback, useExecutionTaskSession, type CancellationTarget } from "./ExecutionTaskSession";
import type { ProjectView } from "./projectCommands";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";
import { ExecutionTasks, type TasksHandle } from "./ExecutionTasks";
import { executionCommands } from "./executionCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { ...fixture.session, locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixture.session.projectId, displayName: "Tasks", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const target: CancellationTarget = { taskId: fixture.detail.taskId, attemptId: fixture.detail.attemptId, origin: "tasks" };
let owner: ReturnType<typeof useExecutionTaskSession>;
function Probe() {
  const value = useExecutionTaskSession();
  useLayoutEffect(() => { owner = value; });
  return <TaskCancellationFeedback origin="tasks" />;
}
function FailedReadProbe() {
  const reads = useSessionReads();
  const query = useSessionQuery({ key: ["cancellation-test-status"], scopes: ["execution"], enabled: true, read: () => executionCommands.status(reads.context) });
  return <output aria-label="Task read">{query.error ? "Read failed" : "Reading"}</output>;
}
function ResumedAttemptProbe() {
  const reads = useSessionReads();
  const query = useSessionQuery({ key: ["cancellation-test-resume"], scopes: ["execution"], enabled: true,
    read: () => executionCommands.task({ ...reads.context, taskId: target.taskId, after: "0", limit: 50 }) });
  return <output aria-label="Current task attempt">{query.data?.at(-1)?.attemptId ?? "Reading"}</output>;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  invoke.mockReset();
  let identity = 90;
  invoke.mockImplementation(async command => {
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "cancel_execution_task") return "1";
    throw new Error(command);
  });
});
afterEach(cleanup);

it("reserves synchronously across consumers and keeps different tasks independent", async () => {
  render(<Probe />, project);
  let identify!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" && calls(command).length === 1
    ? new Promise(resolve => { identify = resolve; }) : original(command, payload));
  let first!: Promise<void>, second!: Promise<void>;
  act(() => {
    first = owner.cancel(target);
    void owner.cancel({ ...target, origin: "ai" });
    void owner.cancel({ ...target, attemptId: fixtureIdentity(110), origin: "arena" });
    second = owner.cancel({ ...target, taskId: fixtureIdentity(111), origin: "source" });
  });
  expect(calls("create_execution_identity")).toHaveLength(2);
  await act(async () => { await second; identify(fixtureIdentity(112)); await first; });
  expect(calls("cancel_execution_task").map(([, payload]) => payload.request.taskId)).toEqual([fixtureIdentity(111), target.taskId]);
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "1", request: { taskId: target.taskId, requestId: fixtureIdentity(112) } });
});

it("continues the captured cancellation when the consumer unmounts during identity preparation", async () => {
  const view = render(<Probe />, project);
  let identify!: (value: unknown) => void;
  invoke.mockImplementation(command => command === "create_execution_identity" ? new Promise(resolve => { identify = resolve; }) : Promise.resolve("7"));
  let pending!: Promise<void>;
  act(() => { pending = owner.cancel(target); });
  view.rerender(null, project);
  await act(async () => { identify(fixtureIdentity(113)); await pending; });
  expect(calls("cancel_execution_task")).toHaveLength(1);
  expect(calls("cancel_execution_task")[0][1].request).toEqual({ ...fixture.session, taskId: target.taskId, requestId: fixtureIdentity(113) });
  view.rerender(<Probe />, project);
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "7" });
  expect(screen.getByText(/Cancellation request recorded/)).toBeInTheDocument();
});
it("captures a mutable caller's original target before identity and protects its original request", async () => {
  render(<Probe />, project);
  let identify!: (value: unknown) => void;
  invoke.mockImplementation(command => command === "create_execution_identity" ? new Promise(resolve => { identify = resolve; })
    : Promise.reject(new Error("Disconnected")));
  const projection = { ...target };
  let pending!: Promise<void>;
  act(() => { pending = owner.cancel(projection); });
  projection.taskId = fixtureIdentity(130); projection.attemptId = fixtureIdentity(131);
  await act(async () => { identify(fixtureIdentity(132)); await pending; });
  const original = owner.current(target.taskId)?.request;
  expect(original).toMatchObject({ taskId: target.taskId, requestId: fixtureIdentity(132) });
  expect(Object.isFrozen(original)).toBe(true);
  expect(owner.current(projection.taskId)).toBeUndefined();
  invoke.mockResolvedValueOnce("4");
  await act(async () => { await owner.retry(target.taskId); });
  expect(calls("cancel_execution_task").map(([, payload]) => payload.request)).toEqual([original, original]);
});

it("retains unknown original identity across remount, new attempts and pure reads", async () => {
  const view = render(<Probe />, project);
  let replay = false;
  invoke.mockImplementation(async command => {
    if (command === "create_execution_identity") return fixtureIdentity(114);
    if (command === "cancel_execution_task") { if (replay) return "8"; throw new Error("Transport disconnected"); }
    if (command === "read_execution_task") return [{ ...fixture.summary, attemptId: fixtureIdentity(115), sequence: "2" }];
    throw new Error(command);
  });
  await act(async () => { await owner.cancel(target); });
  const request = owner.current(target.taskId)?.request;
  expect(owner.current(target.taskId)?.phase).toBe("unknown");
  view.rerender(null, project);
  await refreshWorkbenchReads();
  view.rerender(<><Probe /><ResumedAttemptProbe /></>, project);
  await screen.findByText(fixtureIdentity(115));
  expect(calls("read_execution_task")[0][1].request).toEqual({ ...fixture.session, taskId: target.taskId, after: "0", limit: 50 });
  await act(async () => { await owner.cancel({ ...target, attemptId: fixtureIdentity(115), origin: "arena" }); });
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("cancel_execution_task")).toHaveLength(1);
  expect(owner.current(target.taskId)?.request).toEqual(request);
  expect(screen.getByRole("button", { name: "Retry the original cancellation" })).toBeEnabled();
  replay = true;
  await act(async () => { await owner.retry(target.taskId); });
  expect(calls("cancel_execution_task").map(([, payload]) => payload.request)).toEqual([request, request]);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "8", target });
});

it("settles a late checked ACK after consumer unmount without depending on later reads", async () => {
  const view = render(<Probe />, project);
  let finish!: (value: unknown) => void;
  invoke.mockImplementation(command => command === "create_execution_identity" ? Promise.resolve(fixtureIdentity(116))
    : new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = owner.cancel(target); await Promise.resolve(); });
  expect(calls("cancel_execution_task")).toHaveLength(1);
  view.rerender(null, project);
  await act(async () => { finish("9007199254740993"); await pending; });
  invoke.mockRejectedValue(new Error("Later task read failed"));
  view.rerender(<><Probe /><FailedReadProbe /></>, project);
  await screen.findByText("Read failed");
  expect(calls("execution_status")).toHaveLength(1);
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "9007199254740993" });
  expect(screen.queryByRole("button", { name: "Retry the original cancellation" })).not.toBeInTheDocument();
});

it("keeps a zero acknowledgement unknown until an exact explicit replay returns a positive revision", async () => {
  render(<Probe />, project);
  invoke.mockResolvedValueOnce(fixtureIdentity(117)).mockResolvedValueOnce("0");
  await act(async () => { await owner.cancel(target); });
  expect(owner.current(target.taskId)?.phase).toBe("unknown");
  const original = owner.current(target.taskId)?.request;
  invoke.mockResolvedValueOnce("2");
  await act(async () => { await owner.retry(target.taskId); });
  expect(calls("cancel_execution_task").map(([, payload]) => payload.request)).toEqual([original, original]);
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "2" });
});
it("shows original cancellation recovery and checked confirmation in Chinese", async () => {
  await i18n.changeLanguage("zh-CN");
  render(<Probe />, project);
  invoke.mockResolvedValueOnce(fixtureIdentity(133)).mockResolvedValueOnce("0");
  await act(async () => { await owner.cancel(target); });
  expect(screen.getByRole("button", { name: "重试原取消请求" })).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveFocus();
  expect(screen.getByText(/仅凭任务进度无法确认这个请求/)).toBeInTheDocument();
  invoke.mockResolvedValueOnce("4");
  await act(async () => { await owner.retry(target.taskId); });
  expect(screen.getByText(/取消请求已记录/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重试原取消请求" })).not.toBeInTheDocument();
});

it("releases only a verified rejection and preserves it through read invalidation", async () => {
  render(<Probe />, project);
  const error = { code: "busy", outcome: "rejected", stage: "execution-cancel", recoveryRequired: false };
  invoke.mockResolvedValueOnce(fixtureIdentity(118)).mockRejectedValueOnce(error);
  await act(async () => { await owner.cancel(target); });
  expect(owner.current(target.taskId)).toMatchObject({ phase: "rejected", failure: error });
  await refreshWorkbenchReads();
  expect(owner.current(target.taskId)?.phase).toBe("rejected");
  await act(async () => { await owner.retry(target.taskId); });
  expect(calls("cancel_execution_task")).toHaveLength(1);
  await act(async () => { await owner.cancel(target); });
  expect(calls("create_execution_identity")).toHaveLength(2);
  expect(calls("cancel_execution_task")).toHaveLength(2);
});
it("retains original uncertainty when a replay is formally rejected and blocks fresh requests until a positive ACK", async () => {
  render(<Probe />, project);
  invoke.mockResolvedValueOnce(fixtureIdentity(134)).mockRejectedValueOnce(new Error("Disconnected after recording"));
  await act(async () => { await owner.cancel(target); });
  const original = owner.current(target.taskId)?.request;
  expect(original).toEqual({ ...fixture.session, taskId: target.taskId, requestId: fixtureIdentity(134) });
  expect(owner.current(target.taskId)?.phase).toBe("unknown");
  const rejectedReplay = { code: "busy", outcome: "rejected", stage: "execution-cancel", recoveryRequired: false };
  invoke.mockRejectedValueOnce(rejectedReplay);
  await act(async () => { await owner.retry(target.taskId); });
  expect(owner.current(target.taskId)).toMatchObject({ phase: "unknown", failure: rejectedReplay });
  expect(owner.current(target.taskId)?.request).toBe(original);
  expect(owner.unresolved()).toBe(true);
  expect(screen.getByRole("button", { name: "Retry the original cancellation" })).toBeEnabled();
  const resumed = { ...target, attemptId: fixtureIdentity(135) };
  expect(owner.canCancel(target)).toBe(false); expect(owner.canCancel(resumed)).toBe(false);
  await act(async () => { await owner.cancel(target); await owner.cancel(resumed); });
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("cancel_execution_task")).toHaveLength(2);
  invoke.mockResolvedValueOnce("6");
  await act(async () => { await owner.retry(target.taskId); });
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "6", target, request: original });
  expect(owner.unresolved()).toBe(false);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("cancel_execution_task").map(([, payload]) => payload.request)).toEqual([original, original, original]);
});

it("deduplicates recorded clicks for the captured attempt and creates a fresh request only for a new attempt", async () => {
  render(<Probe />, project);
  await act(async () => { await owner.cancel(target); await owner.cancel(target); await owner.retry(target.taskId); });
  expect(calls("cancel_execution_task")).toHaveLength(1);
  expect(calls("create_execution_identity")).toHaveLength(1);
  await act(async () => { await owner.cancel({ ...target, attemptId: fixtureIdentity(119) }); });
  expect(calls("cancel_execution_task")).toHaveLength(2);
  const requests = calls("cancel_execution_task").map(([, payload]) => payload.request);
  expect(requests[0].taskId).toBe(requests[1].taskId);
  expect(requests[0].requestId).not.toBe(requests[1].requestId);
  expect(requests.every(request => !Object.hasOwn(request, "attemptId"))).toBe(true);
});
it("keeps the existing Tasks project-leave guard active for another workspace's unresolved cancellation", async () => {
  const view = render(<Probe />, project), ref = createRef<TasksHandle>();
  invoke.mockResolvedValueOnce(fixtureIdentity(123)).mockRejectedValueOnce(new Error("Disconnected"));
  await act(async () => { await owner.cancel({ ...target, origin: "ai" }); });
  invoke.mockImplementation(async command => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [];
    if (command === "cancel_execution_task") return "5";
    throw new Error(command);
  });
  view.rerender(<ExecutionTasks ref={ref} project={project} disabled={false} />);
  await act(async () => { expect(await ref.current!.allowLeave()).toBe(false); });
  expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry the original cancellation" })).toBeEnabled();
  await act(async () => { await owner.retry(target.taskId); });
  expect(await ref.current!.allowLeave()).toBe(true);
});

it("checks original project, session, task, attempt and explicit business proof before dispatch", async () => {
  const view = render(<Probe />, project);
  await act(async () => {
    await owner.cancel({ ...target, taskId: "bad-task" });
    await owner.cancel({ ...target, attemptId: "bad-attempt" });
    await owner.cancel(target, () => false);
  });
  expect(invoke).not.toHaveBeenCalled();
  let identify!: (value: unknown) => void, proof = true;
  invoke.mockImplementation(() => new Promise(resolve => { identify = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = owner.cancel(target, () => proof); });
  proof = false;
  await act(async () => { identify(fixtureIdentity(120)); await pending; });
  expect(calls("cancel_execution_task")).toHaveLength(0);
  expect(owner.current(target.taskId)).toBeUndefined();
  view.rerender(<Probe />, { ...project, metadata: { ...project.metadata, projectId: "bad-project" } });
  await act(async () => { await owner.cancel(target); });
  expect(calls("create_execution_identity")).toHaveLength(1);
});

it.each(["identity", "ack"] as const)("ignores late %s after the actual session owner is destroyed", async stage => {
  const view = render(<Probe />, project);
  let finish!: (value: unknown) => void;
  invoke.mockImplementation(command => stage === "identity" || command === "cancel_execution_task"
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(fixtureIdentity(121)));
  let pending!: Promise<void>;
  await act(async () => { pending = owner.cancel(target); await Promise.resolve(); });
  const previous = owner;
  view.rerender(<Probe />, { ...project, sessionToken: "replacement-session" });
  await act(async () => { finish(stage === "identity" ? fixtureIdentity(122) : "3"); await pending; });
  expect(calls("cancel_execution_task")).toHaveLength(stage === "identity" ? 0 : 1);
  expect(owner.current(target.taskId)).toBeUndefined();
  expect(previous).not.toBe(owner);
  expect(owner.unresolved()).toBe(false);
});
