import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionReadProvider, useSessionReads } from "./SessionReadProvider";
import { TaskDock, type TaskDockHandle } from "./TaskDock";
import { executionContext, type TaskActivity, type TaskActivityRow } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";
import { createRef, useLayoutEffect, type Ref } from "react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "dock-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(950), displayName: "Dock fixture", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const row: TaskActivityRow = { taskId: fixtureIdentity(951), attemptId: fixtureIdentity(952), operation: "ai-translation", sequence: "7", phase: "active",
  progress: { total: 4, running: 1, queued: 1, succeeded: 1, failed: 0, cancelled: 0, unknown: 1, adopted: 0 } };
const activity: TaskActivity = { total: "100", active: "2", attention: "3", saved: "95", rows: [row] };
let reads: ReturnType<typeof useSessionReads>;
function Probe() { const value = useSessionReads(); useLayoutEffect(() => { reads = value; }); return null; }
function Harness({ value = project, disabled = false, onOpen = vi.fn(), dockRef }: { value?: ProjectView; disabled?: boolean; onOpen?: (row?: TaskActivityRow) => void; dockRef?: Ref<TaskDockHandle> }) {
  return <SessionReadProvider key={value.sessionToken} context={executionContext(value)} bridge={false}>
    <Probe/><TaskDock ref={dockRef} project={value} disabled={disabled} onOpen={onOpen}/>
  </SessionReadProvider>;
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); invoke.mockResolvedValue(activity); });
afterEach(cleanup);
async function expand() { await userEvent.click(screen.getByText("Background tasks", { exact: false, selector: "summary" })); }

it.each(["loading", "empty", "failure"] as const)("reveals the original %s dock synchronously without reading or routing again", async state => {
  const ref = createRef<TaskDockHandle>(), onOpen = vi.fn(), user = userEvent.setup();
  const empty: TaskActivity = { total: "0", active: "0", attention: "0", saved: "0", rows: [] };
  let complete!: (value: TaskActivity) => void;
  if (state === "loading") invoke.mockImplementationOnce(() => new Promise<TaskActivity>(resolve => { complete = resolve; }));
  else if (state === "failure") invoke.mockRejectedValueOnce(new Error("Synthetic activity read unavailable"));
  else invoke.mockResolvedValueOnce(empty);
  render(<><button type="button">Other work</button><Harness dockRef={ref} onOpen={onOpen}/></>);
  const summary = screen.getByText("Background tasks", { exact: false, selector: "summary" }), details = summary.closest("details")!;
  await within(summary).findByText(state === "loading" ? "Loading tasks…" : state === "failure" ? "Status unavailable" : "No tasks yet");
  expect(details).not.toHaveAttribute("open");
  const before = invoke.mock.calls.length, scroll = vi.spyOn(summary, "scrollIntoView");
  act(() => { expect(ref.current!.reveal()).toBe(true); });
  expect(details).toHaveAttribute("open"); expect(summary).toHaveFocus();
  expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
  act(() => { expect(ref.current!.reveal()).toBe(true); });
  expect(details).toHaveAttribute("open"); expect(summary).toHaveFocus();
  expect(invoke.mock.calls).toHaveLength(before); expect(onOpen).not.toHaveBeenCalled();
  if (state === "failure") {
    expect(screen.getByRole("alert")).toHaveTextContent("Your current work is kept");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/Showing 1 of 100 tasks/);
    expect(invoke.mock.calls).toHaveLength(before + 1);
    expect(invoke.mock.calls.every(([command]) => command === "read_execution_task_activity")).toBe(true);
  }
  await user.click(summary); expect(details).not.toHaveAttribute("open");
  const outside = screen.getByRole("button", { name: "Other work" }); outside.focus();
  if (state === "loading") { await act(async () => { complete(empty); }); await screen.findByText("No tasks yet"); }
  expect(details).not.toHaveAttribute("open"); expect(outside).toHaveFocus(); expect(onOpen).not.toHaveBeenCalled();
});

it("rejects disabled, retired and disconnected presentation handles", async () => {
  const ref = createRef<TaskDockHandle>(), user = userEvent.setup();
  const view = render(<Harness dockRef={ref} disabled/>);
  await screen.findByText(/2 active or queued/);
  const summary = screen.getByText("Background tasks", { exact: false, selector: "summary" }), details = summary.closest("details")!;
  act(() => { expect(ref.current!.reveal()).toBe(false); }); expect(details).not.toHaveAttribute("open");
  view.rerender(<Harness dockRef={ref}/>);
  const retained = ref.current!;
  act(() => { expect(retained.reveal()).toBe(true); }); expect(summary).toHaveFocus();
  await user.click(summary); expect(details).not.toHaveAttribute("open");
  act(() => { reads.retire(); expect(retained.reveal()).toBe(false); }); expect(details).not.toHaveAttribute("open");
  view.unmount(); expect(retained.reveal()).toBe(false);
  expect(invoke.mock.calls).toHaveLength(1);
});

it("does not reveal the replacement dock through a retained old-session handle", async () => {
  const ref = createRef<TaskDockHandle>(), user = userEvent.setup();
  const view = render(<Harness dockRef={ref}/>);
  await screen.findByText(/2 active or queued/); const original = ref.current!;
  invoke.mockResolvedValue({ total: "0", active: "0", attention: "0", saved: "0", rows: [] });
  view.rerender(<Harness dockRef={ref} value={{ ...project, sessionToken: "new-session" }}/>);
  await screen.findByText("No tasks yet");
  const summary = screen.getByText("Background tasks", { exact: false, selector: "summary" }), details = summary.closest("details")!;
  act(() => { expect(original.reveal()).toBe(false); }); expect(details).not.toHaveAttribute("open");
  act(() => { expect(ref.current!.reveal()).toBe(true); }); expect(summary).toHaveFocus();
  await user.click(summary); expect(details).not.toHaveAttribute("open");
  expect(invoke.mock.calls).toHaveLength(2);
});

it("shows ledger totals independently of its bounded rows and opens the exact task without executing it", async () => {
  const onOpen = vi.fn(); render(<Harness onOpen={onOpen}/>);
  await screen.findByText("2 active or queued · 3 need review · 95 have saved outputs"); await expand();
  expect(screen.getByText(/Showing 1 of 100 tasks/)).toBeVisible();
  expect(screen.getByText(/1 running · 1 queued/)).toHaveTextContent("1 uncertain");
  await userEvent.click(screen.getByRole("button", { name: /Task 7/ }));
  expect(onOpen).toHaveBeenCalledWith(row);
  await userEvent.click(screen.getByRole("button", { name: "All tasks" }));
  expect(onOpen).toHaveBeenLastCalledWith();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_execution_task_activity"]);
  expect(invoke.mock.calls[0][1]).toEqual({ request: { ...executionContext(project), limit: 12 } });
});

it("distinguishes loading and read failure from an empty project, and retries only the read", async () => {
  let fail!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(<Harness/>);
  expect(within(screen.getByText("Background tasks", { exact: false, selector: "summary" })).getByText("Loading tasks…")).toBeVisible();
  expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();
  await act(async () => { fail({ code: "busy", outcome: "rejected" }); });
  await screen.findByText("Status unavailable"); await expand();
  expect(screen.getByRole("alert")).toHaveTextContent("Your current work is kept");
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(/Showing 1 of 100 tasks/);
  expect(invoke.mock.calls).toHaveLength(2);
  expect(invoke.mock.calls.every(([command]) => command === "read_execution_task_activity")).toBe(true);
});

it("disables stale row navigation while execution changes refresh current ledger facts", async () => {
  const onOpen = vi.fn(); render(<Harness onOpen={onOpen}/>);
  await screen.findByText(/2 active or queued/); await expand();
  let complete!: (value: TaskActivity) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  act(() => reads.invalidate(["execution"]));
  await waitFor(() => expect(invoke.mock.calls).toHaveLength(2));
  const button = screen.getByRole("button", { name: /Task 7/ });
  expect(button).toBeDisabled(); await userEvent.click(button); expect(onOpen).not.toHaveBeenCalled();
  const next = { ...row, phase: "attention" as const, progress: { ...row.progress, running: 0, queued: 0, unknown: 3 } };
  await act(async () => complete({ ...activity, active: "0", attention: "5", rows: [next] }));
  const group = await screen.findByRole("region", { name: "Needs review" });
  expect(within(group).getByText(/3 uncertain/)).toBeVisible();
  expect(screen.queryByRole("region", { name: "Active or queued" })).not.toBeInTheDocument();
});

it("ignores a late old-session response and blocks navigation after retirement", async () => {
  let complete!: (value: TaskActivity) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const onOpen = vi.fn(), view = render(<Harness onOpen={onOpen}/>);
  await waitFor(() => expect(invoke.mock.calls).toHaveLength(1));
  invoke.mockResolvedValue({ total: "0", active: "0", attention: "0", saved: "0", rows: [] });
  view.rerender(<Harness value={{ ...project, sessionToken: "new-session" }} onOpen={onOpen}/>);
  await screen.findByText("No tasks yet");
  await act(async () => complete(activity));
  expect(screen.queryByText(/2 active or queued/)).not.toBeInTheDocument();
  await expand(); act(() => reads.retire());
  await userEvent.click(screen.getByRole("button", { name: "All tasks" }));
  expect(onOpen).not.toHaveBeenCalled();
});
