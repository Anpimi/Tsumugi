import { useLayoutEffect, type ReactNode } from "react";
import { act, cleanup, render as renderUi, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionReadProvider, useSessionReads } from "./SessionReadProvider";
import { workPlanToolStatus } from "./testSupport/workPlanToolFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import agentFixture from "../test/fixtures/workPlanAgent.contract.json";
import toolFixture from "../test/fixtures/workPlanAgentTools.contract.json";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import errorWire from "../test/fixtures/commandErrors.contract.json";
import type { SessionReads } from "./sessionReads";
import { WorkPlanAgentControls as ProductionAgentControls, useWorkPlanAgentSession } from "./WorkPlanAgentControls";
import { useWorkPlanGenerationSession } from "./WorkPlanGenerationControls";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "./workbenchCommands";
import { WorkPlanControls as ProductionWorkPlanControls, useWorkPlanControlSession } from "./WorkPlanControls";
import { i18n } from "./i18n";
import type { AttemptDetail, SessionRequest } from "./executionCommands";
import type { WorkPlanAgentToolPrepareRequest } from "./generated/ai.requests";
import type { WorkPlanStatusView } from "./workPlanCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context: SessionRequest = { projectId: agentFixture.requests.open.projectId, sessionToken: agentFixture.requests.open.sessionToken };
let registry: WorkbenchCommands, reads: SessionReads, agent: ReturnType<typeof useWorkPlanAgentSession>;
function render(ui: ReactNode) { const commands=new WorkbenchCommands(); registry=commands; return renderUi(ui, { wrapper: ({ children }) => <WorkbenchCommandsProvider commands={commands}><SessionReadProvider context={context} bridge={false}>{children}</SessionReadProvider></WorkbenchCommandsProvider> }); }
type AgentProps=Omit<Parameters<typeof ProductionAgentControls>[0],"session"|"component"|"ownerBusy"|"run"> & {
  run:(work:(current:()=>boolean)=>Promise<void>)=>Promise<void>; visible?: boolean;
};
function WorkPlanAgentControls({visible=true,...props}:AgentProps) {
  const session=useWorkPlanAgentSession(()=>true), component=useWorkPlanGenerationSession(()=>true), currentReads=useSessionReads();
  useLayoutEffect(()=>{agent=session;reads=currentReads;});
  useLayoutEffect(()=>{currentReads.client.setQueryData(currentReads.key(["workPlan",props.status.lease.planId]),props.status);},[props.status,currentReads]);
  return visible ? <ProductionAgentControls {...props} session={session} component={component} ownerBusy={()=>false}
    run={work=>props.run(current=>work(Object.assign(()=>current(),{fresh:()=>current(),acceptPlan:()=>current()})))}/> : null;
}
type ControlProps=Omit<Parameters<typeof ProductionWorkPlanControls>[0],"session"|"editSeq"|"open"|"canFresh"|"ownerBusy"|"run"|"onOpenTranslation"> & {
  run:(work:(current:()=>boolean)=>Promise<void>)=>Promise<void>;onOpenTranslation:()=>unknown;
};
function WorkPlanControls(props:ControlProps) {
  const session=useWorkPlanControlSession(()=>true), reads=useSessionReads();
  useLayoutEffect(()=>{if(props.status)reads.client.setQueryData(reads.key(["workPlan",props.status.lease.planId]),props.status);},[props.status,reads]);
  return <ProductionWorkPlanControls {...props} session={session} editSeq={0} open canFresh={()=>true} ownerBusy={()=>false}
    run={work=>props.run(current=>work(Object.assign(()=>current(),{fresh:()=>current(),acceptPlan:()=>current()})))} onOpenTranslation={async()=>{await props.onOpenTranslation();return true;}}/>;
}
let identity: number, detail: AttemptDetail | null, unknown: boolean;
let reconciliation: "enqueued"|"active"|"not-enqueued"|"error";
let reconcileAck: ((request:Record<string,unknown>)=>Promise<unknown>)|null;
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); identity = 70; detail = null; unknown = false; reconciliation="enqueued";reconcileAck=null;
  invoke.mockReset(); invoke.mockImplementation(async (command, args) => {
    const request = args?.request;
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "open_work_plan_agent_scope") return structuredClone(agentFixture.responses.scope);
    if (command === "prepare_work_plan_agent_tool") {
      const preparing = request as WorkPlanAgentToolPrepareRequest;
      return { ...toolFixture.responses.prepared, taskId: preparing.tool.taskId, attemptId: preparing.tool.attemptId, toolHandle: preparing.tool.toolHandle, scope: workPlanToolStatus.plan.scope.filter(unit => preparing.tool.unitIds.includes(unit.unitId)) };
    }
    if (command === "start_work_plan_agent_tool") {
      detail = { ...executionFixture.detail, attemptId: request.tool.attemptId, taskId: request.tool.taskId, operation: "plugin-tool-query", nextOffset: null,
        recovery: { attemptId: request.tool.attemptId, units: [] },
        progress: { total: request.tool.unitIds.length, succeeded: request.tool.unitIds.length, queued: 0, running: 0, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
        items: request.tool.unitIds.map((id: string, index: number) => ({ scope: { kind: "unit", id, locale: "zh-CN" }, resultId: fixtureIdentity(80 + index),
          status: { itemId: fixtureIdentity(90 + index), execution: "succeeded", adoption: "unapplied", validation: "pending", cancellationRequested: false, retrySafe: false, diagnostic: null } })) };
      return unknown ? null : request.tool.attemptId;
    }
    if (command === "prepare_work_plan_agent_generation") return { ...agentFixture.responses.generation,
      taskId: request.generation.taskId, attemptId: request.generation.attemptId,
      scope: workPlanToolStatus.plan.scope.filter(unit => request.generation.unitIds.includes(unit.unitId)) };
    if (command === "start_work_plan_agent_generation") return unknown ? null : request.generation.attemptId;
    if (command === "reconcile_work_plan_agent_execution") {
      if(reconcileAck)return reconcileAck(request);
      if(reconciliation === "error")throw new Error("Original Agent read unavailable");
      return {identity:{lease:request.lease,taskId:request.taskId,attemptId:request.attemptId,inputDigest:request.inputDigest},outcome:reconciliation};
    }
    if (command === "read_execution_attempt") return structuredClone(detail);
    if (command === "read_execution_output") {
      const item = detail?.items.find(item => item.resultId === request.resultId);
      return { ...executionFixture.output, projectId: context.projectId, attemptId: request.attemptId, resultId: request.resultId,
        itemId: item?.status.itemId, outcome: "succeeded", plugin: null,
        output: { results: [{ entries: [{ value: "<script>reference only</script>", note: "Unadopted 👩🏽‍💻 e\u0301" }] }] } };
    }
    throw new Error(command);
  });
});
afterEach(cleanup);
async function perform(work: (current: () => boolean) => Promise<void>) { try { await work(() => true); } catch { /* The enclosing workbench renders failures. */ } }

it("queries only the selected captured material and presents unadopted structured output through the original ledger", async () => {
  const user = userEvent.setup(), generated = vi.fn();
  render(<WorkPlanAgentControls context={context} status={workPlanToolStatus} open disabled={false} busy={false} run={perform} onBlockedChange={() => {}} onGenerated={generated} />);
  expect(screen.getByRole("button", { name: "Query captured references" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "barrel" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Reference package" }), toolFixture.spec.handle);
  await user.click(screen.getByRole("button", { name: "Query captured references" }));
  const results = await screen.findByRole("region", { name: "Query results" });
  await within(results).findByText("<script>reference only</script>");
  expect(results.querySelector("script")).toBeNull();
  const request = invoke.mock.calls.find(([command]) => command === "prepare_work_plan_agent_tool")?.[1].request;
  expect(request.tool).toEqual({ taskId: fixtureIdentity(70), attemptId: fixtureIdentity(71), toolHandle: toolFixture.spec.handle, unitIds: [workPlanToolStatus.plan.scope[0].unitId] });
  expect(invoke.mock.calls.some(([command]) => ["authorize_plugin_execution", "prepare_plugin_tool", "adopt_execution", "save_term", "control_work_plan"].includes(command))).toBe(false);
  await user.click(screen.getByRole("button", { name: "Generate another candidate for this subset" }));
  await waitFor(() => expect(generated).toHaveBeenCalledWith(fixtureIdentity(73)));
  const generation = invoke.mock.calls.find(([command]) => command === "prepare_work_plan_agent_generation")?.[1].request.generation;
  expect(Object.keys(generation).sort()).toEqual(["attemptId", "taskId", "unitIds"]);
  expect(generation.unitIds).toEqual(request.tool.unitIds);
});

it("reconciles an uncertain start by reading its original attempt without another call or consent renewal", async () => {
  unknown = true; reconciliation="error"; const user = userEvent.setup(), blocked = vi.fn();
  render(<WorkPlanAgentControls context={context} status={workPlanToolStatus} open disabled={false} busy={false} run={perform} onBlockedChange={blocked} onGenerated={() => {}} />);
  await user.click(screen.getByRole("checkbox", { name: "barrel" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Reference package" }), toolFixture.spec.handle);
  await user.click(screen.getByRole("button", { name: "Query captured references" }));
  await screen.findByText(/The call may have been queued/);
  expect(screen.getByRole("button", { name: "Generate another candidate for this subset" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([command]) => command === "reconcile_work_plan_agent_execution")).toHaveLength(1);
  reconciliation="enqueued";await user.click(screen.getByRole("button",{name:"Check original Agent start"}));
  await waitFor(() => expect(screen.queryByText(/The call may have been queued/)).toBeNull());
  expect(invoke.mock.calls.filter(([command]) => command === "start_work_plan_agent_tool")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "open_work_plan_agent_scope")).toHaveLength(1);
  expect(blocked).toHaveBeenCalledWith(false);
});

it("disables new delegated calls when the original plan is paused", async () => {
  const user = userEvent.setup();
  const status: WorkPlanStatusView = { ...workPlanToolStatus, state: "paused" };
  render(<WorkPlanAgentControls context={context} status={status} open disabled={false} busy={false} run={perform} onBlockedChange={() => {}} onGenerated={() => {}} />);
  expect(screen.getByRole("checkbox", { name: "barrel" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Query captured references" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Query captured references" }));
  expect(invoke.mock.calls.some(([command]) => command === "open_work_plan_agent_scope")).toBe(false);
});

it("preserves exhausted reservations and explains why a larger subset cannot query", async () => {
  const user = userEvent.setup();
  render(<WorkPlanAgentControls context={context} status={{ ...workPlanToolStatus, toolInvocations: { reserved: 2, limit: 2 } }} open disabled={false} busy={false} run={perform} onBlockedChange={() => {}} onGenerated={() => {}} />);
  await user.click(screen.getByRole("checkbox", { name: "barrel" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Reference package" }), toolFixture.spec.handle);
  expect(screen.getByText(/only 0 remain/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Query captured references" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Generate another candidate for this subset" })).toBeEnabled();
  expect(invoke).not.toHaveBeenCalled();
});

it("requires independent local tool consent and invalidates it when the captured plan changes", async () => {
  const user = userEvent.setup();
  const properties = { context, prepared: workPlanToolStatus.plan, status: null, busy: false, disabled: false, consent: true,
    refresh: async () => workPlanToolStatus, run: perform, onPlan: () => {}, onStarted: () => {}, onBlockedChange: () => {}, onOpenTranslation: () => {} };
  const view = render(<WorkPlanControls {...properties} />);
  expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I allow these exact plugins/ }));
  expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeEnabled();
  await act(async () => view.rerender(<WorkPlanControls {...properties} prepared={{ ...workPlanToolStatus.plan, digest: "changed-capture" }} />));
  expect(screen.getByRole("checkbox", { name: /I allow these exact plugins/ })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeDisabled();
});

const agentProps = (generated=vi.fn())=>({context,status:workPlanToolStatus,open:true,disabled:false,busy:false,run:perform,onBlockedChange:vi.fn(),onGenerated:generated});
async function startOriginal(kind:"generation"|"tool") {
  const user=userEvent.setup();await user.click(screen.getByRole("checkbox",{name:"barrel"}));
  if(kind === "tool")await user.selectOptions(screen.getByRole("combobox",{name:"Reference package"}),toolFixture.spec.handle);
  await user.click(screen.getByRole("button",{name:kind === "tool"?"Query captured references":"Generate another candidate for this subset"}));
  return user;
}
function pendingPayload(){const value=agent.current().pending!;return {kind:"ai-agent-pending" as const,operation:value.kind,
  scopeId:value.prepared.scopeId,taskId:value.request.taskId,attemptId:value.request.attemptId,inputDigest:value.request.inputDigest,
  unitIds:value.unitIds,toolHandle:value.kind === "tool"?value.prepared.toolHandle:null};}
const calls=(command:string)=>invoke.mock.calls.filter(([name])=>name === command);

it.each(["generation","tool"] as const)("automatically confirms original %s once without another start, scope or identity",async kind=>{
  unknown=true;const generated=vi.fn();render(<WorkPlanAgentControls {...agentProps(generated)}/>);await startOriginal(kind);
  await waitFor(()=>expect(agent.current().pending).toBeNull());
  expect(calls("reconcile_work_plan_agent_execution")).toHaveLength(1);
  expect(calls("start_work_plan_agent_"+kind)).toHaveLength(1);expect(calls("open_work_plan_agent_scope")).toHaveLength(1);
  expect(calls("create_execution_identity")).toHaveLength(2);
  if(kind === "generation")expect(generated).toHaveBeenCalledExactlyOnceWith(calls("start_work_plan_agent_generation")[0][1].request.generation.attemptId);
  else expect(await screen.findByText("The original tool call is recorded. Current progress and output are shown separately.")).toBeInTheDocument();
});

it.each(["generation","tool"] as const)("permits only explicit original %s retry after proven absence and retains newer selections",async kind=>{
  unknown=true;reconciliation="active";const generated=vi.fn();render(<WorkPlanAgentControls {...agentProps(generated)}/>);const user=await startOriginal(kind);
  const retry=await screen.findByRole("button",{name:"Retry same action"});
  const original=structuredClone(calls("start_work_plan_agent_"+kind)[0][1].request);
  act(()=>agent.update(before=>({...before,selected:[],toolHandle:"Kept newer B"})));
  unknown=false;await user.click(retry);await waitFor(()=>expect(agent.current().pending).toBeNull());
  expect(agent.current().selected).toEqual([]);expect(agent.current().toolHandle).toBe("Kept newer B");
  expect(calls("start_work_plan_agent_"+kind).map(([,args])=>args.request)).toEqual([original,original]);
  expect(calls("create_execution_identity")).toHaveLength(2);expect(calls("reconcile_work_plan_agent_execution")).toHaveLength(1);
});

it("preserves prior unknown after a later formal rejection and forbids a blind retry",async()=>{
  unknown=true;reconciliation="active";render(<WorkPlanAgentControls {...agentProps()}/>);const user=await startOriginal("generation");
  const retry=await screen.findByRole("button",{name:"Retry same action"}),original=agent.current().pending!;
  const base=invoke.getMockImplementation()!;
  invoke.mockImplementation((command,args)=>command === "start_work_plan_agent_generation"
    ? Promise.reject({...errorWire.errors[0],code:"permission-denied",stage:"execution-recover",outcome:"rejected"}) : base(command,args));
  await user.click(retry);await waitFor(()=>expect(agent.current().pending?.retryAllowed).toBe(false));
  expect(agent.current().pending?.request).toBe(original.request);expect(agent.current().pending?.uncertain).toBe(true);
  expect(calls("reconcile_work_plan_agent_execution")).toHaveLength(1);expect(calls("create_execution_identity")).toHaveLength(2);
  expect(screen.queryByRole("button",{name:"Retry same action"})).toBeNull();
});

it("keeps wrong original proof unknown despite visible tool output, then checks the identical request manually",async()=>{
  unknown=true;const props=agentProps();reconcileAck=async request=>({identity:{lease:request.lease,taskId:fixtureIdentity(999),attemptId:request.attemptId,inputDigest:request.inputDigest},outcome:"enqueued"});
  render(<WorkPlanAgentControls {...props}/>);const user=await startOriginal("tool");await screen.findByRole("button",{name:"Check original Agent start"});
  await waitFor(()=>expect(agent.current().pending?.checking).toBe(false));
  expect(agent.current().pending?.uncertain).toBe(true);expect(agent.current().pending?.retryAllowed).toBe(false);
  expect(screen.queryByText("The original tool call is recorded. Current progress and output are shown separately.")).toBeNull();
  const payload=pendingPayload(),scope={...context,area:"ai" as const};
  expect(registry.dispatch("ai.agent.reconcile",scope,{...payload,attemptId:fixtureIdentity(998)})).toBe(false);
  reconcileAck=null;await user.click(screen.getByRole("button",{name:"Check original Agent start"}));
  await waitFor(()=>expect(agent.current().pending).toBeNull());
  const reads=calls("reconcile_work_plan_agent_execution").map(([,args])=>args.request);expect(reads).toHaveLength(2);expect(reads[1]).toEqual(reads[0]);
  expect(calls("start_work_plan_agent_tool")).toHaveLength(1);
});

it("keeps one pure read across hidden or removed consumers and preserves B after the old lease changes",async()=>{
  unknown=true;const props=agentProps();let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});reconcileAck=()=>pending;
  const ui=render(<WorkPlanAgentControls {...props}/>);await startOriginal("generation");await screen.findByText("Checking the original Agent start…");
  const original=agent.current().pending!,payload=pendingPayload(),scope={...context,area:"ai" as const};
  expect(registry.describe("ai.agent.reconcile",scope,payload)?.availability).toMatchObject({enabled:false,reason:"busy"});
  expect(registry.dispatch("ai.agent.reconcile",scope,payload)).toBe(false);expect(registry.dispatch("ai.agent.retry",scope,payload)).toBe(false);
  ui.rerender(<WorkPlanAgentControls {...props} open={false}/>);
  expect(registry.describe("ai.agent.reconcile",scope,payload)?.availability).toMatchObject({enabled:false,reason:"hidden"});
  act(()=>agent.update(before=>({...before,selected:[],toolHandle:"Newer B while hidden"})));
  const changed={...props,status:{...workPlanToolStatus,state:"paused" as const,lease:{...workPlanToolStatus.lease,generation:"2"}}};
  ui.rerender(<WorkPlanAgentControls {...changed} visible={false}/>);
  await act(async()=>{finish({identity:{lease:original.request.lease,taskId:original.request.taskId,attemptId:original.request.attemptId,inputDigest:original.request.inputDigest},outcome:"enqueued"});await pending;});
  ui.rerender(<WorkPlanAgentControls {...changed}/>);expect(agent.current().pending).toBeNull();expect(agent.current().toolHandle).toBe("Newer B while hidden");
  expect(props.onGenerated).toHaveBeenCalledExactlyOnceWith(original.request.attemptId);
  expect(calls("reconcile_work_plan_agent_execution")).toHaveLength(1);expect(calls("create_execution_identity")).toHaveLength(2);
});

it("ends only a proven non-enqueued original call after explicit acknowledgement",async()=>{
  unknown=true;reconciliation="not-enqueued";render(<WorkPlanAgentControls {...agentProps()}/>);const user=await startOriginal("tool");
  const end=await screen.findByRole("button",{name:"Close unqueued setup"});expect(agent.current().pending).not.toBeNull();
  act(()=>agent.update(before=>({...before,selected:[],toolHandle:"Kept B"})));await user.click(end);await waitFor(()=>expect(agent.current().pending).toBeNull());
  expect(agent.current().toolRun).toBeNull();expect(agent.current().toolHandle).toBe("Kept B");
  expect(calls("start_work_plan_agent_tool")).toHaveLength(1);expect(calls("create_execution_identity")).toHaveLength(2);
});

it("ignores a late original proof after project retirement",async()=>{
  unknown=true;let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});reconcileAck=()=>pending;
  const props=agentProps();render(<WorkPlanAgentControls {...props}/>);await startOriginal("generation");await screen.findByText("Checking the original Agent start…");
  const original=agent.current().pending!;await act(async()=>{reads.retire();finish({identity:{lease:original.request.lease,taskId:original.request.taskId,attemptId:original.request.attemptId,inputDigest:original.request.inputDigest},outcome:"enqueued"});await pending;});
  expect(agent.current().pending?.request).toBe(original.request);expect(props.onGenerated).not.toHaveBeenCalled();expect(calls("start_work_plan_agent_generation")).toHaveLength(1);
});
