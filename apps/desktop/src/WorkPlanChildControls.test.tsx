import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import { WorkPlanChildControls } from "./WorkPlanChildControls";
import { useSessionReads } from "./SessionReadProvider";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { workPlanToolStatus } from "./testSupport/workPlanToolFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import wire from "../test/fixtures/workPlanAgent.contract.json";
import errorWire from "../test/fixtures/commandErrors.contract.json";
import toolWire from "../test/fixtures/workPlanAgentTools.contract.json";
import type { ProjectView } from "./projectCommands";
import type { AttemptDetail } from "./executionCommands";
import type { WorkPlanStatusView } from "./workPlanCommands";
import { i18n } from "./i18n";
import { validateResponseAttempt } from "./generated/execution.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: wire.requests.open.projectId, sessionToken: wire.requests.open.sessionToken };
const project: ProjectView = { sessionToken: context.sessionToken, locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: context.projectId, displayName: "Subsets", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let owner: ReturnType<typeof useAiPreparation>, reads: ReturnType<typeof useSessionReads>, status: WorkPlanStatusView;
let attempts: Map<string, AttemptDetail>, serial: number, queued: boolean, unknown: boolean, missing: boolean;
let holdDelegate: Promise<void> | null, history: ReturnType<typeof vi.fn<(taskId: string, attemptId: string) => Promise<boolean>>>;
let reconcileAck: ((request: Record<string, unknown>) => Promise<unknown>) | null;
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
function Panel({ shown, value }: { shown: boolean; value: WorkPlanStatusView }) {
  const preparation = useAiPreparation(), query = useSessionReads();
  useLayoutEffect(() => { owner = preparation; reads = query; });
  useLayoutEffect(() => {
    query.client.setQueryData(query.key(["workPlan", value.lease.planId]), value);
    query.client.setQueryData(query.key(["source-scope"]), { revision: "1", currentSnapshot: value.plan.scope[0].sourceSnapshotId });
    query.client.setQueryData(query.key(["child-content"]), sourcePageFixture({ snapshotId: value.plan.scope[0].sourceSnapshotId,
      scope: { revision: "1", currentSnapshot: value.plan.scope[0].sourceSnapshotId }, rows: value.plan.scope.map(unit =>
        sourceRowFixture({ unitId: unit.unitId, sourceRevisionId: unit.sourceRevisionId }, { key: unit.nativeKey })) }));
  }, [query, value]);
  return shown ? <WorkPlanChildControls context={context} status={value} open disabled={false} busy={preparation.busy}
    session={preparation.agent} canRun={preparation.canRunChild} onOpenTask={history}
    run={(work, recovery) => preparation.runChildWorkPlan(work, value.lease.planId, ["child-content"], recovery)} /> : null;
}
function Harness({ shown = true, value = status }: { shown?: boolean; value?: WorkPlanStatusView }) {
  return <AiPreparationSession initialLocale="zh-CN" targetLocales={project.metadata.targetLocales}><Panel shown={shown} value={value} /></AiPreparationSession>;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); status = structuredClone(workPlanToolStatus);
  attempts = new Map(); serial = 3000; queued = false; unknown = false; missing = false; holdDelegate = null; reconcileAck = null; history = vi.fn(async () => true);
  invoke.mockReset().mockImplementation(async (command, { request }) => {
    if (command === "create_execution_identity") return fixtureIdentity(serial++);
    if (command === "open_work_plan_agent_scope") return { ...structuredClone(wire.responses.scope), lease: status.lease, scope: status.plan.scope };
    if (command === "delegate_work_plan_agent_scope") {
      if (holdDelegate) await holdDelegate;
      return { ...structuredClone(wire.responses.child), scopeId: fixtureIdentity(serial++), lease: status.lease,
        delegation: { ...structuredClone(request.delegation), parentScopeId: request.scopeId }, scope: status.plan.scope.filter(unit => request.delegation.unitIds.includes(unit.unitId)) };
    }
    if (command === "prepare_work_plan_agent_generation" || command === "prepare_work_plan_agent_tool") {
      const selecting = request.generation ?? request.tool;
      return { ...structuredClone(request.generation ? wire.responses.generation : toolWire.responses.prepared), scopeId: request.scopeId,
        taskId: selecting.taskId, attemptId: selecting.attemptId, scope: status.plan.scope.filter(unit => selecting.unitIds.includes(unit.unitId)) };
    }
    if (command === "start_work_plan_agent_generation" || command === "start_work_plan_agent_tool") {
      const selecting = request.generation ?? request.tool;
      const candidate: unknown = { ...structuredClone(wire.responses.generationAttempt), taskId: selecting.taskId, attemptId: selecting.attemptId,
        operation: request.generation ? "ai-translation" : "plugin-tool-query", recovery: { attemptId: selecting.attemptId, units: [] },
        progress: { total: selecting.unitIds.length, succeeded: queued ? 0 : selecting.unitIds.length, queued: queued ? selecting.unitIds.length : 0, running: 0, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
        items: selecting.unitIds.map((id: string) => ({ ...structuredClone(wire.responses.generationAttempt.items[0]), scope: { kind: "translation-unit", id, locale: "zh-CN" },
          status: { ...structuredClone(wire.responses.generationAttempt.items[0].status), itemId: fixtureIdentity(serial++), execution: queued ? "queued" : "succeeded" }, resultId: queued ? null : fixtureIdentity(serial++) })) };
      if (!validateResponseAttempt(candidate) || !candidate) throw new Error("Invalid synthetic child lifecycle");
      if (!missing) attempts.set(selecting.attemptId, candidate);
      return unknown ? null : selecting.attemptId;
    }
    if (command === "read_execution_attempt") return structuredClone(attempts.get(request.attemptId) ?? null);
    if (command === "reconcile_work_plan_agent_execution") return reconcileAck ? reconcileAck(request) : {
      identity: { lease: request.lease, taskId: request.taskId, attemptId: request.attemptId, inputDigest: request.inputDigest },
      outcome: attempts.has(request.attemptId) ? "enqueued" : "active" };
    if (command === "read_work_plan_agent_generation_attempt" || command === "read_work_plan_agent_tool_attempt") {
      const selecting = request.generation ?? request.tool, detail = attempts.get(selecting.attemptId);
      if (!detail) throw new Error("Synthetic scoped result missing");
      return structuredClone(detail);
    }
    if (command === "read_work_plan_agent_generation_output" || command === "read_work_plan_agent_tool_output") {
      const selecting = request.generation ?? request.tool;
      const item = attempts.get(selecting.attemptId)?.items.find(item => item.status.itemId === request.itemId && item.resultId === request.resultId);
      if (!item) throw new Error("Expected an exact original child result");
      const plugin = request.generation ? undefined : structuredClone(toolWire.responses.output.plugin);
      if (plugin) {
        plugin.result.context.attemptId = selecting.attemptId; plugin.result.context.itemId = request.itemId;
        plugin.result.context.projectId = context.projectId; plugin.result.resultId = request.resultId;
      }
      const value = { ...structuredClone(request.generation ? wire.responses.generationOutput : toolWire.responses.output), projectId: context.projectId,
        attemptId: selecting.attemptId, itemId: request.itemId, resultId: request.resultId,
        ...(plugin ? { plugin } : {}), output: request.generation ? { ...wire.responses.generationOutput.output, unitId: item.scope.id, text: "Child candidate 👩🏽‍💻 é" } : {} };
      return value;
    }
    if (command === "read_work_plan_agent_guidance") {
      const child = owner.agent.current().child.children.find(value => value.consumer.scope.scopeId === request.scopeId);
      if (!child) throw new Error("Not an original child");
      return { scopeId: request.scopeId, parentTask: child.consumer.scope.parentTask, tools: status.plan.tools?.entries.filter(tool => child.consumer.scope.delegation?.toolHandles.includes(tool.handle)) ?? [] };
    }
    if (command === "read_work_plan_agent_skill") return { scopeId: request.scopeId, parentTask: wire.responses.scope.parentTask, tool: toolWire.spec,
      content: { kind: "skill", contributionId: toolWire.spec.binding.declaration.skill, text: "# Child guidance <script>not executed</script>" } };
    throw new Error(`Unexpected child command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function createChild(index: number, tool = false) {
  const user = userEvent.setup(), units = screen.getByRole("group", { name: "Child entries" });
  for (const [position, unit] of status.plan.scope.entries()) {
    const box = within(units).getByRole("checkbox", { name: unit.nativeKey });
    if (!(box instanceof HTMLInputElement)) throw new Error("Expected a child unit checkbox");
    if (box.checked !== (position === index)) await user.click(box);
  }
  const tools = screen.getByRole("group", { name: "Child reference tools (optional)" });
  for (const box of within(tools).queryAllByRole("checkbox")) {
    if (!(box instanceof HTMLInputElement)) throw new Error("Expected a child tool checkbox");
    if (box.checked !== tool) await user.click(box);
  }
  await user.click(screen.getByRole("button", { name: "Create child session" }));
  await waitFor(() => expect(owner.agent.current().child.children).toHaveLength(calls("delegate_work_plan_agent_scope").length));
  return user;
}

it("keeps two known queued children usable under the same root limits while preserving each original consumer", async () => {
  queued = true; render(<Harness />, project);
  const user = await createChild(0), first = screen.getByRole("region", { name: "Child session 1" });
  await user.click(within(first).getByRole("button", { name: "Generate within this child" }));
  await waitFor(() => expect(owner.agent.current().child.children[0].runs[0]?.phase).toBe("queued"));
  expect(owner.reserved()).toBe(true); expect(owner.canRunChild()).toBe(true);
  await createChild(1);
  const second = screen.getByRole("region", { name: "Child session 2" });
  await user.click(within(second).getByRole("button", { name: "Generate within this child" }));
  await waitFor(() => expect(calls("start_work_plan_agent_generation")).toHaveLength(2));
  const children = owner.agent.current().child.children;
  expect(children[0].consumer).not.toBe(children[1].consumer);
  expect(children.map(child => child.consumer.scope.parentTask)).toEqual([wire.responses.scope.parentTask, wire.responses.scope.parentTask]);
  expect(calls("prepare_work_plan_agent_generation").map(([, args]) => args.request.scopeId)).toEqual(children.map(child => child.consumer.scope.scopeId));
  expect(calls("read_execution_output")).toHaveLength(0);
  expect(calls("authorize_work_plan")).toHaveLength(0); expect(calls("control_work_plan")).toHaveLength(0);
});

it("uses exact child result readers and guidance, and shows malformed structured output without a root or human fallback", async () => {
  render(<Harness />, project); const user = await createChild(0, true), child = screen.getByRole("region", { name: "Child session 1" });
  await user.click(within(child).getByRole("button", { name: "Show guidance directory" }));
  await within(child).findByRole("button", { name: "Read tool Skill" });
  await user.click(within(child).getByRole("button", { name: "Read tool Skill" }));
  await within(child).findByText("# Child guidance <script>not executed</script>");
  expect(child.querySelector("script, a")).toBeNull();
  await user.click(within(child).getByRole("button", { name: "Generate within this child" }));
  await within(child).findByText(/Child candidate/);
  await waitFor(() => expect(within(child).getByRole("combobox", { name: "Child reference package" })).toBeEnabled());
  await user.selectOptions(within(child).getByRole("combobox", { name: "Child reference package" }), toolWire.spec.handle);
  await user.click(within(child).getByRole("button", { name: "Query within this child" }));
  await within(child).findByText(i18n.t("toolQuery.invalidResult"));
  const scopeId = owner.agent.current().child.children[0].consumer.scope.scopeId;
  for (const name of ["read_work_plan_agent_guidance", "read_work_plan_agent_skill", "read_work_plan_agent_generation_output", "read_work_plan_agent_tool_output"]) {
    expect(calls(name).length).toBeGreaterThan(0);
    expect(calls(name).every(([, args]) => args.request.scopeId === scopeId)).toBe(true);
  }
  expect(calls("open_work_plan_agent_scope")).toHaveLength(1); expect(calls("read_execution_output")).toHaveLength(0);
});

it("retains the same child and original unknown request over consumer unmount, manual history and exact retry", async () => {
  unknown = true; missing = true; const view = render(<Harness />, project), user = await createChild(0);
  await user.click(screen.getByRole("button", { name: "Generate within this child" }));
  await screen.findByText(/The call may have been queued/);
  const before = owner.agent.current().child.children[0], original = before.runs[0];
  expect(owner.canRunChild()).toBe(false); expect(owner.reserved()).toBe(true);
  view.rerender(<Harness shown={false} />); view.rerender(<Harness />);
  expect(owner.agent.current().child.children[0].consumer).toBe(before.consumer);
  expect(owner.agent.current().child.children[0].runs[0].prepared).toBe(original.prepared);
  await user.click(screen.getByRole("button", { name: "Inspect this child’s task history" }));
  expect(history).toHaveBeenCalledWith(original.prepared.taskId, original.prepared.attemptId);
  await user.click(screen.getByRole("button", { name: "Check original Agent start" }));
  await screen.findByRole("button", { name: "Retry same action" });
  unknown = false; missing = false;
  await user.click(screen.getByRole("button", { name: "Retry same action" }));
  await screen.findByText(/Child candidate/);
  expect(calls("start_work_plan_agent_generation")[1][1]).toEqual(calls("start_work_plan_agent_generation")[0][1]);
  expect(calls("delegate_work_plan_agent_scope")).toHaveLength(1);
});

it("preserves newer choices and requires explicit use after a late child acknowledgement", async () => {
  let release!: () => void; holdDelegate = new Promise(done => { release = done; });
  render(<Harness />, project); const user = userEvent.setup();
  await user.click(within(screen.getByRole("group", { name: "Child entries" })).getByRole("checkbox", { name: "barrel" }));
  await user.click(screen.getByRole("button", { name: "Create child session" }));
  await waitFor(() => expect(calls("delegate_work_plan_agent_scope")).toHaveLength(1));
  act(() => { owner.setConfig(before => ({ ...before, model: "Kept newer B" })); owner.agent.update(before => ({ ...before, child: { ...before.child, unitIds: [status.plan.scope[1].unitId], editSeq: before.child.editSeq + 1 } })); });
  await act(async () => release());
  await screen.findByText(/Your choices changed/);
  expect(owner.current().config.model).toBe("Kept newer B"); expect(owner.agent.current().child.unitIds).toEqual([status.plan.scope[1].unitId]);
  expect(screen.getByRole("button", { name: "Generate within this child" })).toBeDisabled();
  expect(calls("prepare_work_plan_agent_generation")).toHaveLength(0);
});

it("ends only an explicitly expired pure-delegation uncertainty, keeps B and does not open another scope", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  status = { ...status, expiresAt: String(Math.floor(Date.now() / 1000) + 2) };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name, args) => name === "delegate_work_plan_agent_scope" ? null : original(name, args));
  render(<Harness />, project);
  act(() => {
    owner.setConfig(before => ({ ...before, model: "Kept AI draft B" }));
    owner.agent.update(before => ({ ...before, child: { ...before.child, unitIds: [status.plan.scope[0].unitId] } }));
  });
  const create = screen.getByRole("button", { name: "Create child session" });
  expect(create).toBeEnabled();
  // This timer test owns setTimeout. A native click respects disabled controls
  // without waiting on Testing Library's separate zero-delay async wrapper.
  await act(async () => { create.click(); });
  expect(owner.agent.current().child.pending?.uncertain).toBe(true);
  expect(screen.queryByRole("button", { name: "End this inactive child preparation" })).toBeNull();
  await act(async () => vi.advanceTimersByTime(2100));
  expect(screen.getByText(/may have been created, but its captured deadline has passed/)).toBeVisible();
  const end = screen.getByRole("button", { name: "End this inactive child preparation" });
  expect(end).toBeEnabled();
  await act(async () => { end.click(); });
  expect(owner.agent.current().child.pending).toBeNull(); expect(owner.agent.current().child.unitIds).toEqual([status.plan.scope[0].unitId]);
  expect(owner.current().config.model).toBe("Kept AI draft B"); expect(owner.current().dirty).toBe(true);
  expect(calls("open_work_plan_agent_scope")).toHaveLength(1); expect(calls("start_work_plan_agent_generation")).toHaveLength(0);
});

it("keeps task uncertainty reserved after permission retirement without offering the pure-delegation ending", async () => {
  reconcileAck=async()=>{throw new Error("Original read unavailable before permission retirement");};
  unknown = true; render(<Harness />, project); const user = await createChild(0);
  await user.click(screen.getByRole("button", { name: "Generate within this child" }));
  await screen.findByText(/The call may have been queued/);
  const run = owner.agent.current().child.children[0].runs[0];
  act(() => reads.client.setQueryData(reads.key(["workPlan", status.lease.planId]), { ...status, state: "stopped", lease: { ...status.lease, generation: "9007199254740994" } }));
  expect(owner.reserved()).toBe(true); expect(owner.agent.current().child.children[0].runs[0].prepared).toBe(run.prepared);
  expect(screen.queryByRole("button", { name: "End this inactive child preparation" })).toBeNull();
  expect(calls("read_execution_output")).toHaveLength(0);
});

it("does not end an active unknown delegation after a failed status read, but permits explicit ending after a fresh revoked status", async () => {
  const implementation = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => command === "delegate_work_plan_agent_scope" ? null : implementation(command, args));
  render(<Harness />, project); const user = userEvent.setup();
  await user.click(within(screen.getByRole("group", { name: "Child entries" })).getByRole("checkbox", { name: "barrel" }));
  await user.click(screen.getByRole("button", { name: "Create child session" }));
  await screen.findByText(/The child session acknowledgement is uncertain/);
  const pending = owner.agent.current().child.pending;
  await act(async () => { try { await reads.client.fetchQuery({ queryKey: reads.key(["workPlan", status.lease.planId]), retry: false, staleTime: 0,
    queryFn: async () => { throw new Error("Synthetic failed status read"); } }); } catch { /* Keep the actual failed Query fact. */ } });
  expect(screen.queryByRole("button", { name: "End this inactive child preparation" })).toBeNull();
  expect(owner.agent.current().child.pending).toBe(pending);
  act(() => reads.client.setQueryData(reads.key(["workPlan", status.lease.planId]), { ...status, state: "taken-over", lease: { ...status.lease, generation: "9007199254740994" } }));
  await user.click(await screen.findByRole("button", { name: "End this inactive child preparation" }));
  expect(owner.agent.current().child.pending).toBeNull(); expect(calls("open_work_plan_agent_scope")).toHaveLength(1);
  expect(calls("start_work_plan_agent_generation")).toHaveLength(0);
});

it.each(["active", "enqueued", "not-enqueued", "wrong-ack"] as const)("reconciles only the original %s request and preserves B until an explicit safe ending", async outcome => {
  unknown = true; missing = outcome !== "enqueued";
  reconcileAck=async()=>{throw new Error("First bounded original read unavailable");};
  render(<Harness />, project); const user = await createChild(0);
  await user.click(screen.getByRole("button", { name: "Generate within this child" }));
  await screen.findByText(/The call may have been queued/);
  const original = owner.agent.current().child.children[0].runs[0];
  if (outcome !== "active") act(() => reads.client.setQueryData(reads.key(["workPlan", status.lease.planId]), {
    ...status, state: "stopped", lease: { ...status.lease, generation: "9007199254740994" } }));
  let finish!: (value: unknown) => void;
  reconcileAck = () => new Promise(done => { finish = done; });
  await user.click(screen.getByRole("button", { name: "Check original Agent start" }));
  await waitFor(() => expect(calls("reconcile_work_plan_agent_execution")).toHaveLength(2));
  act(() => owner.setConfig(before => ({ ...before, model: "Newer B during reconciliation" })));
  const receipt = { identity: { lease: original.request.lease, taskId: original.request.taskId,
    attemptId: original.request.attemptId, inputDigest: outcome === "wrong-ack" ? "b".repeat(64) : original.request.inputDigest }, outcome: outcome === "wrong-ack" ? "not-enqueued" : outcome };
  await act(async () => finish(receipt));
  expect(calls("reconcile_work_plan_agent_execution")[1][1].request).toEqual(original.request);
  if (outcome === "not-enqueued") {
    const button = await screen.findByRole("button", { name: "End this unqueued preparation" });
    expect(owner.reserved()).toBe(true); expect(owner.agent.current().child.children[0].runs[0].phase).toBe("unknown");
    await user.click(button);
    expect(owner.agent.current().child.children[0].runs[0].phase).toBe("not-enqueued"); expect(owner.reserved()).toBe(false);
    expect(owner.agent.current().child.children[0].runs[0].prepared).toBe(original.prepared);
  } else {
    expect(screen.queryByRole("button", { name: "End this unqueued preparation" })).toBeNull();
    expect(owner.agent.current().child.children[0].runs[0].phase).toBe(outcome === "enqueued" ? "queued" : "unknown");
  }
  expect(owner.current().config.model).toBe("Newer B during reconciliation");
  expect(calls("start_work_plan_agent_generation")).toHaveLength(1); expect(calls("control_work_plan")).toHaveLength(0);
});

it("keeps an elapsed-deadline start unknown after Active reconciliation and requires explicit plan control", async () => {
  unknown = true; missing = true;
  const view = render(<Harness />, project), user = await createChild(0);
  await user.click(screen.getByRole("button", { name: "Generate within this child" })); await screen.findByText(/The call may have been queued/);
  view.rerender(<Harness value={{ ...status, expiresAt: "1" }} />);
  await user.click(screen.getByRole("button", { name: "Check original Agent start" }));
  await screen.findByText(/An elapsed deadline or a missing task read cannot release it/);
  expect(owner.reserved()).toBe(true); expect(screen.queryByRole("button", { name: "End this unqueued preparation" })).toBeNull();
  expect(screen.queryByRole("button", { name: "End this inactive child preparation" })).toBeNull();
  expect(calls("control_work_plan")).toHaveLength(0);
});

it("does not attach a late reconciliation to a replacement run", async () => {
  unknown = true; missing = true; render(<Harness />, project); const user = await createChild(0);
  await user.click(screen.getByRole("button", { name: "Generate within this child" })); await screen.findByText(/The call may have been queued/);
  const original = owner.agent.current().child.children[0].runs[0];
  let finish!: (value: unknown) => void;
  reconcileAck = () => new Promise(done => { finish = done; });
  await user.click(screen.getByRole("button", { name: "Check original Agent start" }));
  await waitFor(() => expect(calls("reconcile_work_plan_agent_execution")).toHaveLength(2));
  act(() => owner.agent.update(before => ({ ...before, child: { ...before.child, children: before.child.children.map(child => ({ ...child,
    runs: child.runs.map(run => run.kind === "generation" ? { ...run, prepared: structuredClone(run.prepared) }
      : { ...run, prepared: structuredClone(run.prepared) }) })) } })));
  await act(async () => finish({ identity: { lease: original.request.lease, taskId: original.request.taskId,
    attemptId: original.request.attemptId, inputDigest: original.request.inputDigest }, outcome: "not-enqueued" }));
  expect(owner.agent.current().child.children[0].runs[0].reconciliation).toBeUndefined();
  expect(screen.queryByRole("button", { name: "End this unqueued preparation" })).toBeNull(); expect(owner.reserved()).toBe(true);
});

it("automatically confirms one original child enqueue without replaying or granting another scope",async()=>{
  unknown=true;render(<Harness/>,project);const user=await createChild(0);
  await user.click(screen.getByRole("button",{name:"Generate within this child"}));
  await waitFor(()=>expect(owner.agent.current().child.children[0].runs[0].phase).toBe("queued"));
  const action=owner.agent.current().child.children[0].runs[0];
  expect(calls("reconcile_work_plan_agent_execution").map(([,args])=>args.request)).toEqual([action.request]);
  expect(calls("start_work_plan_agent_generation")).toHaveLength(1);expect(calls("delegate_work_plan_agent_scope")).toHaveLength(1);
  expect(action.retryAllowed).toBe(false);expect(action.checking).toBe(false);
});

it("retains child uncertainty after an explicit original retry receives a formal rejection",async()=>{
  unknown=true;missing=true;render(<Harness/>,project);const user=await createChild(0);
  await user.click(screen.getByRole("button",{name:"Generate within this child"}));
  const retry=await screen.findByRole("button",{name:"Retry same action"}),original=owner.agent.current().child.children[0].runs[0];
  const base=invoke.getMockImplementation()!;
  invoke.mockImplementation((command,args)=>command === "start_work_plan_agent_generation"
    ? Promise.reject({...errorWire.errors[0],code:"permission-denied",stage:"execution-recover",outcome:"rejected"}) : base(command,args));
  await user.click(retry);await waitFor(()=>expect(owner.agent.current().child.children[0].runs[0].retryAllowed).toBe(false));
  const retained=owner.agent.current().child.children[0].runs[0];expect(retained.phase).toBe("unknown");expect(retained.request).toBe(original.request);
  expect(calls("reconcile_work_plan_agent_execution")).toHaveLength(1);expect(calls("start_work_plan_agent_generation")[1][1]).toEqual(calls("start_work_plan_agent_generation")[0][1]);
  expect(owner.reserved()).toBe(true);expect(screen.queryByRole("button",{name:"Retry same action"})).toBeNull();
});
