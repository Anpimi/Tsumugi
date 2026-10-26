import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { act, cleanup, render as renderUi, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkPlanAgentControls as ProductionAgentControls, useWorkPlanAgentSession } from "./WorkPlanAgentControls";
import { useWorkPlanGenerationSession } from "./WorkPlanGenerationControls";
import { WorkbenchCommands, WorkbenchCommandsProvider, type AiComponentPrepareCommandPayload } from "./workbenchCommands";
import { SessionReadProvider, useSessionReads, useSessionAlive } from "./SessionReadProvider";
import type { SessionReads } from "./sessionReads";
import { i18n } from "./i18n";
import { generationComponent, generationInventory, generationPackage } from "./testSupport/pluginGenerationFixture";
import { applicationWorkPlanTool, workPlanToolStatus } from "./testSupport/workPlanToolFixture";
import { generationToolFixture } from "./testSupport/generationToolFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import generationFixture from "../test/fixtures/workPlanGenerationComponent.contract.json";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import errorWire from "../test/fixtures/commandErrors.contract.json";
import type { AttemptDetail } from "./executionCommands";
import type { WorkPlanGenerationPrepareRequest } from "./generated/ai.requests";
import { readPluginGenerationChoices } from "./pluginGenerationChoices";
import { jsonIdentity } from "./pluginToolChoices";
import { readCompleteAttempt } from "./executionRead";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: generationFixture.prepare.projectId, sessionToken: generationFixture.prepare.sessionToken };
let reader: SessionReads;
let registry: WorkbenchCommands;
function ReadOwnerProbe() { reader = useSessionReads(); return null; }
function render(ui: ReactNode) { const commands=new WorkbenchCommands(); registry=commands; return renderUi(ui, { wrapper: ({ children }) => <WorkbenchCommandsProvider commands={commands}><SessionReadProvider context={context} bridge={false}><ReadOwnerProbe />{children}</SessionReadProvider></WorkbenchCommandsProvider> }); }
type AgentProps=Omit<Parameters<typeof ProductionAgentControls>[0],"session"|"component"|"ownerBusy"|"run"> & {
  run:(work:(current:()=>boolean)=>Promise<void>)=>Promise<void>; visible?: boolean;
};
function WorkPlanAgentControls({visible = true, ...props}:AgentProps) {
  const session=useWorkPlanAgentSession(()=>true), component=useWorkPlanGenerationSession(()=>true), reads=useSessionReads();
  useLayoutEffect(()=>{reads.client.setQueryData(reads.key(["workPlan",props.status.lease.planId]),props.status);},[props.status,reads]);
  return visible ? <ProductionAgentControls {...props} session={session} component={component} ownerBusy={()=>false}
    run={work=>props.run(current=>work(Object.assign(()=>current(),{fresh:()=>current(),acceptPlan:()=>current()})))}/> : null;
}
let identity: number, original: WorkPlanGenerationPrepareRequest | null, outer: AttemptDetail | null, child: AttemptDetail | null;
let startRead: "saved" | "error";
let startOutcome: "accepted" | "unknown" | "rejected", discardOutcome: boolean, installed: typeof generationPackage;
function execution(state: "queued" | "succeeded" | "unknown", isChild: boolean): AttemptDetail {
  if (!original) throw new Error("Not prepared");
  const attemptId = isChild ? original.generation.attemptId : original.attemptId;
  return { ...executionFixture.detail, taskId: isChild ? original.generation.taskId : fixtureIdentity(200), attemptId,
    operation: isChild ? "ai-translation" : "work-plan-generation-component", nextOffset: null,
    recovery: { attemptId, units: [] },
    progress: { total: 1, succeeded: state === "succeeded" ? 1 : 0, queued: state === "queued" ? 1 : 0,
      running: 0, failed: 0, cancelled: 0, unknown: state === "unknown" ? 1 : 0, adopted: 0 },
    items: [{ resultId: null, scope: { kind: isChild ? "translation-unit" : "work-plan-generation-component",
      id: isChild ? original.generation.unitIds[0] : context.projectId, locale: isChild ? workPlanToolStatus.plan.locale : null },
      status: { validation: "absent", adoption: "unapplied", itemId: fixtureIdentity(isChild ? 201 : 202), execution: state,
        cancellationRequested: false, retrySafe: false, diagnostic: null } }] };
}
function startProof() {
  if (!original) throw new Error("Not prepared");
  return { projectId:context.projectId, taskId:fixtureIdentity(200), attemptId:original.attemptId,
    operation:"work-plan-generation-component",inputDigest:generationFixture.preflight.inputDigest };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); identity = 100; original = null; outer = null; child = null;
  startOutcome = "accepted"; startRead = "saved"; discardOutcome = true; installed = structuredClone(generationPackage);
  failures.length = 0;
  invoke.mockReset(); invoke.mockImplementation(async (command, args) => {
    const request = args?.request;
    if (command === "read_plugin_inventory") return structuredClone(generationInventory);
    if (command === "read_plugin_package") return structuredClone(installed);
    if (command === "read_plugin_generation_component") {
      const contribution = installed.manifest.contributions[0].contribution;
      return { ...structuredClone(generationComponent), componentScope: installed.manifest.components[0].scope, profile: request.profile,
        binding: { ...structuredClone(generationComponent.binding), declaration: contribution.kind === "capability" ? contribution.declaration : generationComponent.binding.declaration } };
    }
    if (command === "open_work_plan_agent_scope") return structuredClone(generationFixture.scope);
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "prepare_work_plan_generation_component") {
      original = structuredClone(request);
      return { ...structuredClone(generationFixture.preflight), attemptId: request.attemptId, generation: request.generation,
        preparedTools: request.toolQueries.map(generationToolFixture),
        taskId: fixtureIdentity(200),
        component: { ...structuredClone(generationComponent), componentScope: installed.manifest.components[0].scope, profile: request.component.profile,
          binding: { ...structuredClone(generationComponent.binding), declaration: installed.manifest.contributions[0].contribution.kind === "capability"
            ? installed.manifest.contributions[0].contribution.declaration : generationComponent.binding.declaration } },
        scope: workPlanToolStatus.plan.scope.filter(unit => request.generation.unitIds.includes(unit.unitId)) };
    }
    if (command === "start_work_plan_generation_component") {
      if (startOutcome === "rejected") throw { ...errorWire.errors[0], code: "busy", stage: "execution-recover", outcome: "rejected" };
      outer = execution("queued", false);
      return startOutcome === "unknown" ? null : request.attemptId;
    }
    if (command === "read_work_plan_generation_component_start") {
      if (startRead === "error") throw new Error("Original component start read unavailable");
      return outer === null ? null : startProof();
    }
    if (command === "discard_work_plan_generation_component") return discardOutcome;
    if (command === "read_execution_task") {
      const detail = request.taskId === fixtureIdentity(200) ? outer : child;
      return detail ? [{ attemptId: detail.attemptId, sequence: "1" }] : [];
    }
    if (command === "read_execution_attempt") return structuredClone(request.attemptId === original?.attemptId ? outer : child);
    throw new Error(command);
  });
});
afterEach(cleanup);
const failures: unknown[] = [];
async function perform(work: (current: () => boolean) => Promise<void>) { try { await work(() => true); } catch (error) { failures.push(error); } }
function controls(status = workPlanToolStatus, generated = vi.fn(), blocked = vi.fn()) {
  return <WorkPlanAgentControls context={context} status={status} open disabled={false} busy={false} run={perform} onGenerated={generated} onBlockedChange={blocked} />;
}
async function prepare() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "barrel" }));
  await user.click(screen.getByRole("button", { name: "Generate with an installed component" }));
  await screen.findByRole("option", { name: "example/generation 0.1.0 · generation.call" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Generation component" }), `${generationPackage.packageDigest}:generation.call`);
  await user.selectOptions(screen.getByRole("combobox", { name: "Component profile" }), jsonIdentity(generationComponent.profile)!);
  await user.selectOptions(screen.getByRole("combobox", { name: "Execution environment" }), generationComponent.environmentDigest);
  await waitFor(() => expect(screen.getByRole("button", { name: "Prepare component generation" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  await screen.findByRole("region", { name: "Review component generation" });
  return user;
}
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: /^I allow this exact component/ }));
  await user.click(screen.getByRole("button", { name: "Start component generation" }));
}
it("offers only installed compatible candidates and requires every explicit choice before read-only preparation", async () => {
  render(controls());
  expect(invoke).not.toHaveBeenCalled();
  const user = await prepare();
  expect(screen.getByRole("heading", { name: "Review component generation" })).toHaveFocus();
  expect(original?.generation).toEqual({ taskId: fixtureIdentity(100), attemptId: fixtureIdentity(101), unitIds: [workPlanToolStatus.plan.scope[0].unitId] });
  expect(original?.component).toEqual(generationFixture.prepare.component);
  expect(Object.keys(original!).sort()).toEqual(["attemptId", "component", "generation", "projectId", "scopeId", "sessionToken", "toolQueries"]);
  expect(original?.toolQueries).toEqual([]);
  expect(screen.getByRole("combobox", { name: "Reference tool for this component" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Start component generation" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "barrel" })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command.startsWith("start_") || command.startsWith("authorize_"))).toBe(false);
  await user.click(screen.getByText("Captured material and sharing"));
  expect(screen.getByText(workPlanToolStatus.plan.preview!.items[0].sourceText)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Discard this component preparation" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Review component generation" })).toBeNull());
  expect(screen.getByRole("checkbox", { name: "barrel" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Generate with an installed component" })).toHaveFocus();
});
it("opens the existing generation results only after the exact child execution is recorded", async () => {
  const generated = vi.fn(), blocked = vi.fn(); render(controls(workPlanToolStatus, generated, blocked));
  const user = await prepare(); await confirm(user);
  expect(failures).toEqual([]);
  expect(await readCompleteAttempt(context, original!.attemptId, "work-plan-generation-component")).toEqual(outer);
  expect(reader.client.getQueryCache().getAll().filter(query => query.state.error).map(query => [query.queryKey, String(query.state.error)])).toEqual([]);
  await screen.findByText("Not started");
  expect(generated).not.toHaveBeenCalled();
  expect(blocked).toHaveBeenLastCalledWith(true);
  child = execution("queued", true); outer = execution("succeeded", false);
  await user.click(screen.getByRole("button", { name: "Refresh execution status" }));
  await waitFor(() => expect(generated).toHaveBeenCalledExactlyOnceWith(fixtureIdentity(101)));
  await screen.findByRole("button", { name: "Keep records and close this component review" });
  await user.click(screen.getByRole("button", { name: "Keep records and close this component review" }));
  expect(invoke.mock.calls.filter(([command]) => command === "start_work_plan_generation_component")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => ["adopt_execution", "control_work_plan", "authorize_plugin_execution"].includes(command))).toBe(false);
});
it("shows a submitted reference result after its original tool call uses the last allowance", async () => {
  usePreparedToolInput();
  const status = structuredClone(workPlanToolStatus);
  status.plan.tools!.maxInvocations = 1;
  status.toolInvocations!.limit = 1;
  const generated = vi.fn(), ui = render(controls(status, generated));
  const user = await chooseComponent(); await chooseReference(user);
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  await screen.findByRole("region", { name: "Prepared reference query" });
  await confirm(user);
  await screen.findByText(/The original component input is recorded/);
  const spent = structuredClone(status);
  spent.toolInvocations!.reserved = 1;
  ui.rerender(controls(spent, generated));
  child = execution("succeeded", true); outer = execution("succeeded", false);
  await user.click(screen.getByRole("button", { name: "Refresh execution status" }));
  await waitFor(() => expect(generated).toHaveBeenCalledExactlyOnceWith(original!.generation.attemptId));
  expect(screen.getByText("Output generated")).toBeInTheDocument();
  expect(screen.getByText(/The original component input is recorded/)).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("ai.component.stale"))).toBeNull();
  expect(screen.queryByText(i18n.t("ai.component.referenceBudget"))).toBeNull();
  expect(screen.queryByText(i18n.t("ai.component.referenceSelection"))).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry the same component start" })).toBeNull();
  expect(invoke.mock.calls.filter(([command]) => command === "start_work_plan_generation_component")).toHaveLength(1);
  expect(failures).toEqual([]);
});
it("keeps an unstarted reference preparation blocked when its tool allowance is spent", async () => {
  usePreparedToolInput();
  const status = structuredClone(workPlanToolStatus);
  status.plan.tools!.maxInvocations = 1;
  status.toolInvocations!.limit = 1;
  const ui = render(controls(status));
  const user = await chooseComponent(); await chooseReference(user);
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  await screen.findByRole("region", { name: "Prepared reference query" });
  await user.click(screen.getByRole("checkbox", { name: /^I allow this exact component/ }));
  expect(screen.getByRole("button", { name: "Start component generation" })).toBeEnabled();
  const spent = structuredClone(status);
  spent.toolInvocations!.reserved = 1;
  ui.rerender(controls(spent));
  expect(screen.getByText(i18n.t("ai.component.stale"))).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start component generation" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Discard this component preparation" })).toBeEnabled();
  expect(invoke.mock.calls.some(([command]) => command === "start_work_plan_generation_component")).toBe(false);
});
it("reconciles an unknown start through original ledger reads without renewing consent or resending", async () => {
  startOutcome = "unknown"; const generated = vi.fn(); render(controls(workPlanToolStatus, generated));
  const user = await prepare(); await confirm(user);
  await screen.findByText(/The original component input is recorded/);
  expect(invoke.mock.calls.filter(([command])=>command === "read_work_plan_generation_component_start")).toHaveLength(1);
  const started = structuredClone(invoke.mock.calls.find(([command]) => command === "start_work_plan_generation_component")![1].request);
  child = execution("queued", true); outer = execution("unknown", false);
  await user.click(screen.getByRole("button", { name: "Refresh execution status" }));
  await waitFor(() => expect(generated).toHaveBeenCalledExactlyOnceWith(original!.generation.attemptId));
  expect(screen.queryByRole("button", { name: "Start component generation" })).toBeNull();
  expect(invoke.mock.calls.filter(([command]) => command === "start_work_plan_generation_component").map(([,args]) => args.request)).toEqual([started]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(4);
});
it("keeps an unknown start unchanged across empty task pages and a wrong child until the exact child is recorded", async () => {
  startRead = "error";
  const originalInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => command === "start_work_plan_generation_component" ? null : originalInvoke(command, args));
  const generated = vi.fn(), blocked = vi.fn(); render(controls(workPlanToolStatus, generated, blocked));
  const user = await prepare(); await confirm(user);
  await screen.findByText(/The action may have run/);
  const started = structuredClone(invoke.mock.calls.find(([command]) => command === "start_work_plan_generation_component")![1].request);
  const prepared = structuredClone(original!);
  const initialReads = () => invoke.mock.calls.filter(([command]) => command === "read_execution_task").length;
  await waitFor(() => expect(initialReads()).toBeGreaterThanOrEqual(2));
  expect(invoke.mock.calls.some(([command]) => command === "read_execution_attempt")).toBe(false);
  expect(generated).not.toHaveBeenCalled();
  expect(blocked).toHaveBeenLastCalledWith(true);
  const proofReads = () => invoke.mock.calls.filter(([command]) => command === "read_work_plan_generation_component_start").length;
  expect(proofReads()).toBe(1);
  await user.click(screen.getByRole("button", { name: "Check original component start" }));
  await waitFor(() => expect(proofReads()).toBe(2));
  expect(invoke.mock.calls.some(([command]) => command === "read_execution_attempt")).toBe(false);
  expect(generated).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Start component generation" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry the same component start" })).toBeNull();
  child = { ...execution("queued", true), taskId: fixtureIdentity(999) };
  await user.click(screen.getByRole("button", { name: "Refresh execution status" }));
  await screen.findByText("The component choices or execution record could not be read. Your preparation and saved results are retained.");
  expect(generated).not.toHaveBeenCalled();
  expect(blocked).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("checkbox", { name: "barrel" })).toBeDisabled();
  child = execution("queued", true); outer = execution("unknown", false); startRead = "saved";
  await user.click(screen.getByRole("button", { name: "Check original component start" }));
  await waitFor(() => expect(generated).toHaveBeenCalledExactlyOnceWith(prepared.generation.attemptId));
  expect(original).toEqual(prepared);
  expect(invoke.mock.calls.filter(([command]) => command === "start_work_plan_generation_component").map(([, args]) => args.request)).toEqual([started]);
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_work_plan_generation_component").map(([, args]) => args.request)).toEqual([prepared]);
  expect(invoke.mock.calls.filter(([command]) => command === "open_work_plan_agent_scope")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(4);
  expect(invoke.mock.calls.some(([command]) => command.startsWith("authorize_") || ["control_work_plan", "adopt_execution"].includes(command))).toBe(false);
});
it("retains the exact grant and expiry when explicitly retrying a definitively rejected start", async () => {
  startOutcome = "rejected"; render(controls()); const user = await prepare(); await confirm(user);
  const retry = await screen.findByRole("button", { name: "Retry the same component start" });
  const started = structuredClone(invoke.mock.calls.find(([command]) => command === "start_work_plan_generation_component")![1].request);
  startOutcome = "accepted"; await user.click(retry);
  await screen.findByText("Not started");
  expect(invoke.mock.calls.filter(([command]) => command === "start_work_plan_generation_component").map(([,args]) => args.request)).toEqual([started, started]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(4);
});
it("revokes start availability when the original plan generation changes and keeps a safe discard path", async () => {
  const ui = render(controls()); const user = await prepare();
  await user.click(screen.getByRole("checkbox", { name: /^I allow this exact component/ }));
  const newer = { ...workPlanToolStatus, state: "paused" as const, lease: { ...workPlanToolStatus.lease, generation: (BigInt(workPlanToolStatus.lease.generation) + 1n).toString() } };
  ui.rerender(controls(newer));
  expect(screen.getByRole("button", { name: "Start component generation" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Discard this component preparation" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Review component generation" })).toBeNull());
  expect(invoke.mock.calls.some(([command]) => command === "start_work_plan_generation_component")).toBe(false);
});
it("keeps a preparation when discard is uncertain or the backend reports it already started", async () => {
  discardOutcome = false; render(controls()); const user = await prepare();
  await user.click(screen.getByRole("button", { name: "Discard this component preparation" }));
  await screen.findByText(/The action may have run/);
  expect(screen.queryByRole("button", { name: "Start component generation" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "barrel" })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "start_work_plan_generation_component")).toBe(false);
});
it("offers Attempt generation components through the existing installed-package discovery", async () => {
  installed.manifest.components[0].scope = "attempt";
  const observed = await readPluginGenerationChoices();
  expect(observed.choices).toHaveLength(1);
  expect(observed.choices[0].provider).toEqual(generationComponent.binding.provider);
  expect(observed.choices[0].supportsPreparedTools).toBe(false);
  expect(observed.runtimes).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "start_work_plan_generation_component")).toBe(false);
});
it("does not offer optional, incompatible, application or non-JavaScript service components", async () => {
  for (const change of ["optional", "version", "scope", "runtime", "data", "permission"] as const) {
    installed = structuredClone(generationPackage);
    const component = installed.manifest.components[0];
    if (change === "optional") component.dependencies[0].required = false;
    if (change === "version") component.dependencies[0].contract.behaviorVersion = 2;
    if (change === "scope") component.scope = "application";
    if (change === "runtime") component.runtime = "native-worker";
    if (change === "permission") installed.manifest.permissions = installed.manifest.permissions.filter(permission => permission.kind !== "project-service");
    const contribution = installed.manifest.contributions[0].contribution;
    if (change === "data" && contribution.kind === "capability") contribution.declaration.outputSchema.behaviorVersion = 2;
    expect((await readPluginGenerationChoices()).choices).toEqual([]);
  }
});
it("renders Chinese accessible actions and preserves captured user material", async () => {
  await i18n.changeLanguage("zh-CN"); render(controls()); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "使用已安装组件生成" }));
  await screen.findByRole("option", { name: "example/generation 0.1.0 · generation.call" });
  expect(screen.getByRole("combobox", { name: "生成组件" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "组件 profile" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "供此组件使用的参考工具" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "第二条 👩🏽‍💻 é" })).toBeInTheDocument();
});

it("requires an explicit no-profile choice for a profile-independent installed declaration", async () => {
  const contribution = installed.manifest.contributions[0].contribution;
  if (contribution.kind !== "capability") throw new Error("Expected generation declaration");
  contribution.declaration.profiles = [];
  render(controls()); const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "barrel" }));
  await user.click(screen.getByRole("button", { name: "Generate with an installed component" }));
  await screen.findByRole("option", { name: "example/generation 0.1.0 · generation.call" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Generation component" }), `${installed.packageDigest}:generation.call`);
  await user.selectOptions(screen.getByRole("combobox", { name: "Execution environment" }), generationComponent.environmentDigest);
  expect(screen.getByRole("button", { name: "Prepare component generation" })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "read_plugin_generation_component")).toBe(false);
  await user.selectOptions(screen.getByRole("combobox", { name: "Component profile" }), "none");
  await waitFor(() => expect(screen.getByRole("button", { name: "Prepare component generation" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  await screen.findByRole("region", { name: "Review component generation" });
  expect(original?.component.profile).toBeNull();
});
it("keeps a late preparation tied to its original lease when plan control changes during preparation", async () => {
  const originalInvoke = invoke.getMockImplementation()!;
  let finish: ((value: unknown) => void) | undefined;
  invoke.mockImplementation(async (command, args) => {
    const value = await originalInvoke(command, args);
    return command === "prepare_work_plan_generation_component" ? new Promise(resolve => { finish = () => resolve(value); }) : value;
  });
  const ui = render(controls()); const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "barrel" }));
  await user.click(screen.getByRole("button", { name: "Generate with an installed component" }));
  await screen.findByRole("option", { name: "example/generation 0.1.0 · generation.call" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Generation component" }), `${installed.packageDigest}:generation.call`);
  await user.selectOptions(screen.getByRole("combobox", { name: "Component profile" }), jsonIdentity(generationComponent.profile)!);
  await user.selectOptions(screen.getByRole("combobox", { name: "Execution environment" }), generationComponent.environmentDigest);
  await waitFor(() => expect(screen.getByRole("button", { name: "Prepare component generation" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  ui.rerender(controls({ ...workPlanToolStatus, state: "paused" }));
  finish!(null);
  await screen.findByRole("region", { name: "Review component generation" });
  expect(screen.getByRole("checkbox", { name: /^I allow this exact component/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Start component generation" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_work_plan_generation_component")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "start_work_plan_generation_component")).toBe(false);
});
it("refuses a child record belonging to another task and retains the original action for checking", async () => {
  const generated = vi.fn(); render(controls(workPlanToolStatus, generated)); const user = await prepare(); await confirm(user);
  child = { ...execution("queued", true), taskId: fixtureIdentity(999) };
  await user.click(screen.getByRole("button", { name: "Refresh execution status" }));
  await screen.findByText("The component choices or execution record could not be read. Your preparation and saved results are retained.");
  expect(generated).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "barrel" })).toBeDisabled();
});
it("can confirm an uncertain discard with the same original preparation identity without starting work", async () => {
  const originalInvoke = invoke.getMockImplementation()!; let first = true;
  invoke.mockImplementation(async (command, args) => {
    if (command === "discard_work_plan_generation_component" && first) { first = false; throw new Error("Synthetic reply lost"); }
    return originalInvoke(command, args);
  });
  render(controls()); const user = await prepare();
  await user.click(screen.getByRole("button", { name: "Discard this component preparation" }));
  await screen.findByText(/The action may have run/);
  expect(screen.queryByRole("button", { name: "Start component generation" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Discard this component preparation" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Review component generation" })).toBeNull());
  const discarded = invoke.mock.calls.filter(([command]) => command === "discard_work_plan_generation_component").map(([, args]) => args.request);
  expect(discarded).toHaveLength(2); expect(discarded[0]).toEqual(discarded[1]);
  expect(invoke.mock.calls.some(([command]) => command === "start_work_plan_generation_component")).toBe(false);
});


let stableComponent:ReturnType<typeof useWorkPlanGenerationSession>;
function StableComponentConsumer({mounted=true}:{mounted?:boolean}) {
  const reads=useSessionReads(),alive=useSessionAlive(),flight=useRef(false),[busy,setBusy]=useState(false);
  useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const agent=useWorkPlanAgentSession(()=>alive.current),component=useWorkPlanGenerationSession(()=>alive.current);
  useLayoutEffect(()=>{stableComponent=component;reads.client.setQueryData(reads.key(["workPlan",workPlanToolStatus.lease.planId]),workPlanToolStatus);},[reads]);
  async function run(work:Parameters<Parameters<typeof ProductionAgentControls>[0]["run"]>[0]) {
    if(!alive.current||flight.current)return;
    flight.current=true;setBusy(true);
    try{await work(Object.assign(()=>alive.current,{fresh:()=>alive.current,acceptPlan:()=>alive.current}));}
    catch(error){failures.push(error);}
    finally{flight.current=false;if(alive.current)setBusy(false);}
  }
  return mounted?<ProductionAgentControls context={context} status={workPlanToolStatus} open disabled={false} busy={busy}
    session={agent} component={component} ownerBusy={()=>flight.current} run={run} onBlockedChange={()=>{}} onGenerated={()=>{}}/>:null;
}
async function chooseComponent() {
  const user=userEvent.setup();
  await user.click(screen.getByRole("checkbox",{name:"barrel"}));
  await user.click(screen.getByRole("button",{name:"Generate with an installed component"}));
  await screen.findByRole("option",{name:"example/generation 0.1.0 · generation.call"});
  await user.selectOptions(screen.getByRole("combobox",{name:"Generation component"}),`${installed.packageDigest}:generation.call`);
  await user.selectOptions(screen.getByRole("combobox",{name:"Component profile"}),jsonIdentity(generationComponent.profile)!);
  await user.selectOptions(screen.getByRole("combobox",{name:"Execution environment"}),generationComponent.environmentDigest);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Prepare component generation"})).toBeEnabled());
  return user;
}
function usePreparedToolInput() {
  const contribution = installed.manifest.contributions[0].contribution;
  if (contribution.kind !== "capability") throw new Error("Expected generation capability");
  contribution.declaration.inputSchema.id = "tsumugi.generation-component-input";
  const contract = workPlanToolStatus.plan.tools!.entries[0].binding.capability.declaration.contract;
  installed.manifest.components[0].dependencies.push({ contract: structuredClone(contract), required: false, selection: "single" });
  contribution.declaration.permissions = [...contribution.declaration.permissions, { kind: "project-service", contract: structuredClone(contract) }];
  installed.manifest.permissions = [...installed.manifest.permissions, { kind: "project-service", contract: structuredClone(contract) }];
}
async function chooseReference(user: ReturnType<typeof userEvent.setup>) {
  const tool = workPlanToolStatus.plan.tools!.entries[0];
  await user.selectOptions(screen.getByRole("combobox", { name: "Reference tool for this component" }), tool.handle);
  expect(screen.getByRole("button", { name: "Prepare component generation" })).toBeDisabled();
  await user.selectOptions(screen.getByRole("combobox", { name: "Original entry for the reference query" }), workPlanToolStatus.plan.scope[0].unitId);
  return tool;
}
it("discovers opt-in Project and Attempt callers while refusing Application callers", async () => {
  usePreparedToolInput();
  for (const scope of ["project", "attempt"] as const) {
    installed.manifest.components[0].scope = scope;
    expect((await readPluginGenerationChoices()).choices[0].supportsPreparedTools).toBe(true);
  }
  installed.manifest.components[0].scope = "application";
  expect((await readPluginGenerationChoices()).choices).toEqual([]);
});
it("keeps the opt-in input free of reference queries until a human selects a tool and an original entry", async () => {
  usePreparedToolInput(); render(controls());
  const user = await chooseComponent();
  expect(screen.getByRole("combobox", { name: "Reference tool for this component" })).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  await screen.findByRole("region", { name: "Review component generation" });
  expect(original?.toolQueries).toEqual([]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(3);
  expect(screen.queryByRole("region", { name: "Prepared reference query" })).toBeNull();
});
it.each(["dependency", "permission", "version"] as const)("keeps a reference tool unavailable when its caller's %s declaration does not match", async reason => {
  usePreparedToolInput();
  const contribution = installed.manifest.contributions[0].contribution;
  if (contribution.kind !== "capability") throw new Error("Expected generation capability");
  const contract = workPlanToolStatus.plan.tools!.entries[0].binding.capability.declaration.contract;
  if (reason === "dependency") installed.manifest.components[0].dependencies = installed.manifest.components[0].dependencies.filter(dependency => dependency.contract.id !== contract.id);
  if (reason === "permission") contribution.declaration.permissions = contribution.declaration.permissions.filter(permission => permission.kind !== "project-service" || permission.contract.id !== contract.id);
  if (reason === "version") installed.manifest.components[0].dependencies[1].contract.behaviorVersion++;
  render(controls()); const user = await chooseComponent();
  expect(within(screen.getByRole("combobox", { name: "Reference tool for this component" })).getByRole("option", { name: "Reference lookup" })).toBeDisabled();
  expect(screen.getByText(/does not declare both the dependency and permission/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  await screen.findByRole("region", { name: "Review component generation" });
  expect(original?.toolQueries).toEqual([]);
  expect(invoke.mock.calls.some(([command]) => command.startsWith("authorize_"))).toBe(false);
});
it.each(["project", "attempt"] as const)("prepares one exact tool query for a %s caller and reviews its frozen input before independent component consent", async scope => {
  usePreparedToolInput(); installed.manifest.components[0].scope = scope;
  render(controls()); const user = await chooseComponent(), tool = await chooseReference(user);
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  const review = await screen.findByRole("region", { name: "Prepared reference query" });
  const query = { taskId: fixtureIdentity(103), attemptId: fixtureIdentity(104), toolHandle: tool.handle, unitIds: [workPlanToolStatus.plan.scope[0].unitId] as [string] };
  expect(original?.toolQueries).toEqual([query]);
  expect(original?.generation).toEqual({ taskId: fixtureIdentity(100), attemptId: fixtureIdentity(101), unitIds: query.unitIds });
  expect(original?.attemptId).toBe(fixtureIdentity(102));
  const capturedQuery = original?.toolQueries[0];
  if (!capturedQuery) throw new Error("Expected one captured reference query");
  expect(Object.keys(capturedQuery).sort()).toEqual(["attemptId", "taskId", "toolHandle", "unitIds"]);
  expect(within(review).getByText(generationToolFixture(query).input.utf8)).toBeInTheDocument();
  expect(within(review).getByText("Original plan entry: barrel")).toBeInTheDocument();
  expect(within(review).getByText(/generation component receives the complete reference query/)).toBeInTheDocument();
  expect(within(review).getByText(/original plan’s independent tool permission/)).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Reference tool for this component" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Start component generation" })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command.startsWith("start_") || command.startsWith("authorize_"))).toBe(false);
  await confirm(user); await screen.findByText("Not started");
  const start = invoke.mock.calls.find(([command]) => command === "start_work_plan_generation_component")![1].request;
  expect(start.inputDigest).toBe(generationFixture.preflight.inputDigest);
  expect(start.unsandboxedExecution).toBe(true);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(6);
  expect(invoke.mock.calls.some(([command]) => command.startsWith("authorize_"))).toBe(false);
  expect(failures).toEqual([]);
});

it.each([false, true])("reviews the exact Application service and blocks a retired instance without replacing it (Native: %s)", async native => {
  usePreparedToolInput();
  const status = structuredClone(workPlanToolStatus), tool = applicationWorkPlanTool(undefined, native);
  status.plan.tools!.entries = [tool];
  let instanceState: "reserved" | "stopped" = "reserved";
  const originalInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    if (command === "read_application_plugin_instance") return { basis: structuredClone(args.request.basis), state: instanceState };
    const response = await originalInvoke(command, args);
    return command === "prepare_work_plan_generation_component" ? { ...response,
      preparedTools: [{ ...response.preparedTools[0], tool: structuredClone(tool) }] } : response;
  });
  render(controls(status)); const user = await chooseComponent(); await chooseReference(user);
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  const review = await screen.findByRole("region", { name: "Prepared reference query" });
  await within(review).findByText(i18n.t("toolQuery.applicationStates.reserved"));
  expect(within(review).getByText(i18n.t("toolQuery.applicationCapabilities"))).toBeVisible();
  if (!native) expect(within(review).getByText("secondary.call")).toBeVisible();
  expect(within(review).getByText(i18n.t("ai.tools.applicationStopHelp"))).toBeVisible();
  await user.click(screen.getByRole("checkbox", { name: /^I allow this exact component/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Start component generation" })).toBeEnabled());
  instanceState = "stopped";
  await user.click(screen.getByRole("button", { name: i18n.t("toolQuery.applicationRefresh") }));
  await screen.findByText(i18n.t("ai.tools.applicationRetired"));
  expect(screen.getByRole("button", { name: "Start component generation" })).toBeDisabled();
  const instanceReads = invoke.mock.calls.filter(([command]) => command === "read_application_plugin_instance");
  expect(instanceReads.every(([, args]) => jsonIdentity(args.request.basis) === jsonIdentity(tool.execution.applicationScope))).toBe(true);
  await user.click(screen.getByRole("button", { name: "Discard this component preparation" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Review component generation" })).toBeNull());
  expect(invoke.mock.calls.some(([command]) => command.startsWith("start_") || command.startsWith("authorize_"))).toBe(false);
  expect(failures).toEqual([]);
});
it("invalidates a registry preparation when its explicit tool or original entry changes", async () => {
  usePreparedToolInput(); render(controls()); const user = await chooseComponent(), tool = await chooseReference(user);
  const payload: AiComponentPrepareCommandPayload = { kind: "ai-component-prepare", planId: workPlanToolStatus.lease.planId,
    expectedGeneration: workPlanToolStatus.lease.generation, unitIds: [workPlanToolStatus.plan.scope[0].unitId], component: generationFixture.prepare.component,
    toolQuery: { toolHandle: tool.handle, unitId: workPlanToolStatus.plan.scope[0].unitId } };
  const scope = { ...context, area: "ai" as const };
  expect(registry.describe("ai.component.prepare", scope, payload)?.availability.enabled).toBe(true);
  await user.click(screen.getByRole("checkbox", { name: "barrel" }));
  expect(screen.getByText(/Choose a compatible tool and one currently selected original entry/)).toBeInTheDocument();
  expect(registry.dispatch("ai.component.prepare", scope, payload)).toBe(false);
  await user.click(screen.getByRole("checkbox", { name: "barrel" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Reference tool for this component" }), "");
  expect(registry.dispatch("ai.component.prepare", scope, payload)).toBe(false);
  expect(invoke.mock.calls.some(([command]) => command === "prepare_work_plan_generation_component")).toBe(false);
});
it("discards a late Host capture when the explicit reference selection changed during preparation", async () => {
  usePreparedToolInput(); render(controls()); const user = await chooseComponent(); await chooseReference(user);
  const originalInvoke = invoke.getMockImplementation()!;
  let finish!: () => void;
  invoke.mockImplementation(async (command, args) => {
    const value = await originalInvoke(command, args);
    return command === "prepare_work_plan_generation_component" ? new Promise(resolve => { finish = () => resolve(value); }) : value;
  });
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  await user.selectOptions(screen.getByRole("combobox", { name: "Reference tool for this component" }), "");
  await act(async () => finish());
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "discard_work_plan_generation_component")).toHaveLength(1));
  expect(invoke.mock.calls.find(([command]) => command === "discard_work_plan_generation_component")![1].request.attemptId).toBe(original!.attemptId);
  expect(screen.queryByRole("region", { name: "Review component generation" })).toBeNull();
  expect(invoke.mock.calls.some(([command]) => command.startsWith("start_"))).toBe(false);
});
it.each(["consent", "scope", "effect", "budget"] as const)("explains unavailable reference %s without granting permission through the component", async reason => {
  usePreparedToolInput(); const status = structuredClone(workPlanToolStatus);
  if (reason === "consent") status.effects = status.effects.filter(effect => effect !== "query-tools");
  if (reason === "scope") status.plan.tools!.entries[0].execution.componentScope = "attempt";
  if (reason === "effect") status.plan.tools!.entries[0].binding.capability.declaration.effect = "external";
  if (reason === "budget") status.toolInvocations!.reserved = status.toolInvocations!.limit;
  render(controls(status)); const user = await chooseComponent();
  expect(within(screen.getByRole("combobox", { name: "Reference tool for this component" })).getByRole("option", { name: "Reference lookup" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Prepare component generation" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  await screen.findByRole("region", { name: "Review component generation" });
  expect(original?.toolQueries).toEqual([]);
  expect(invoke.mock.calls.some(([command]) => command.startsWith("authorize_"))).toBe(false);
});
it("rechecks the original tool authority before component start and retains safe disposal", async () => {
  usePreparedToolInput(); const ui = render(controls()), user = await chooseComponent(); await chooseReference(user);
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  await screen.findByRole("region", { name: "Review component generation" });
  await user.click(screen.getByRole("checkbox", { name: /^I allow this exact component/ }));
  ui.rerender(controls({ ...workPlanToolStatus, effects: workPlanToolStatus.effects.filter(effect => effect !== "query-tools") }));
  expect(screen.getByRole("button", { name: "Start component generation" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Discard this component preparation" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Review component generation" })).toBeNull());
  expect(invoke.mock.calls.some(([command]) => command.startsWith("start_"))).toBe(false);
});
it("keeps an uncertain component start bound to its original reference query and consent", async () => {
  usePreparedToolInput(); startOutcome = "unknown"; startRead = "error"; render(controls()); const user = await chooseComponent(); await chooseReference(user);
  await user.click(screen.getByRole("button", { name: "Prepare component generation" }));
  await screen.findByRole("region", { name: "Review component generation" });
  const captured = structuredClone(original!);
  await confirm(user); await screen.findByText(/The action may have run/);
  const started = structuredClone(invoke.mock.calls.find(([command]) => command === "start_work_plan_generation_component")![1].request);
  await user.click(screen.getByRole("button", { name: "Check original component start" }));
  expect(original).toEqual(captured);
  expect(screen.getByRole("combobox", { name: "Reference tool for this component" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([command]) => command === "start_work_plan_generation_component").map(([, args]) => args.request)).toEqual([started]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(6);
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_work_plan_generation_component").map(([, args]) => args.request)).toEqual([captured]);
});
it.each(["eviction","error","contradiction","destroyed"] as const)("keeps component metadata witness ownership through %s during identity",async phase=>{
  const ui=render(<StableComponentConsumer/>),user=await chooseComponent(),originalInvoke=invoke.getMockImplementation()!;
  const cache=reader.client.getQueryCache(),inventory=reader.client.getQueryState(reader.key(["generation-component-inventory",0]));
  if(inventory?.status!=="success")throw new Error("Expected original component inventory");
  const queryKey=reader.key(["generation-component-environment",`${installed.packageDigest}:generation.call`,jsonIdentity(generationComponent.profile),generationComponent.environmentDigest,0,inventory.dataUpdatedAt]);
  const record=cache.find({queryKey,exact:true});
  if(!record)throw new Error("Expected exact component metadata read");
  expect(record.queryKey).toEqual(queryKey);expect(record.state.status).toBe("success");expect(record.state.fetchStatus).toBe("idle");
  const originalMetadata=record.state.data;
  expect(originalMetadata).toEqual(generationComponent);
  const counts={subscribed:0,disposed:0},subscribe=cache.subscribe;
  vi.spyOn(cache,"subscribe").mockImplementation(listener=>{counts.subscribed++;const release=subscribe(listener);return()=>{counts.disposed++;release();};});
  let resolve!:(id:string)=>void,identities=0;
  invoke.mockImplementation((command,args)=>command==="create_execution_identity"&&++identities===1?new Promise<string>(done=>{resolve=done;}):originalInvoke(command,args));
  await user.click(screen.getByRole("button",{name:"Prepare component generation"}));
  await waitFor(()=>expect(resolve).toBeTypeOf("function"));
  expect(counts.subscribed).toBe(2);
  if(phase==="destroyed")ui.unmount();
  else ui.rerender(<StableComponentConsumer mounted={false}/>);
  act(()=>reader.client.removeQueries({queryKey,exact:true}));
  if(phase==="error")await act(async()=>{await expect(reader.client.fetchQuery({queryKey,retry:false,queryFn:async()=>{throw new Error("Replacement component unavailable");}})).rejects.toThrow("Replacement component unavailable");});
  if(phase==="contradiction")await act(async()=>{await reader.client.fetchQuery({queryKey,retry:false,queryFn:async()=>({...generationComponent,runtimeOrigin:{...generationComponent.runtimeOrigin,sourceId:"different-runtime"}})});});
  act(()=>reader.client.removeQueries({queryKey,exact:true}));
  if(phase==="destroyed")expect(counts.disposed).toBe(2);
  await act(async()=>resolve(fixtureIdentity(980)));
  await waitFor(()=>expect(counts.disposed).toBe(2));
  expect(invoke.mock.calls.filter(([name])=>name==="prepare_work_plan_generation_component")).toHaveLength(phase==="eviction"?1:0);
  expect(invoke.mock.calls.some(([name])=>name==="start_work_plan_generation_component")).toBe(false);
  if(phase==="eviction") {
    ui.rerender(<StableComponentConsumer/>);
    const review=await screen.findByRole("region",{name:"Review component generation"});
    expect(review).toBeInTheDocument();
    expect(within(review).getByText(`${generationComponent.binding.provider.plugin.publisher}/${generationComponent.binding.provider.plugin.id} ${generationComponent.binding.provider.plugin.version} · ${generationComponent.binding.provider.contributionId}`)).toBeInTheDocument();
    expect(stableComponent.current().operation?.prepared.generation.unitIds).toEqual([workPlanToolStatus.plan.scope[0].unitId]);
    expect(screen.getByRole("button",{name:"Start component generation"})).toBeDisabled();
  } else expect(stableComponent.current().operation).toBeNull();
  const subscriptions=counts.subscribed;
  act(()=>reader.client.setQueryData(queryKey,originalMetadata));
  expect(counts.subscribed).toBe(subscriptions);expect(counts.disposed).toBe(2);
});

it("pins confirmed original enqueue even when current execution progress cannot be read", async () => {
  startOutcome = "unknown";
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation((command,args)=>command === "read_execution_task" ? Promise.reject(new Error("Current status unavailable")) : base(command,args));
  render(controls()); const user=await prepare(); await confirm(user);
  await screen.findByText(/The original component input is recorded/);
  await screen.findByText("The component choices or execution record could not be read. Your preparation and saved results are retained.");
  expect(screen.queryByRole("button",{name:"Retry the same component start"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Check original component start"})).toBeNull();
  expect(invoke.mock.calls.filter(([command])=>command === "read_work_plan_generation_component_start")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command])=>command === "start_work_plan_generation_component")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command])=>command === "prepare_work_plan_generation_component")).toHaveLength(1);
});

it.each(["accepted","rejected"] as const)("only retries proven missing using identical original consent, preserving unknown after %s",async outcome=>{
  const base=invoke.getMockImplementation()!;let starts=0;
  invoke.mockImplementation((command,args)=>command === "start_work_plan_generation_component" && starts++ === 0
    ? Promise.resolve(null) : base(command,args));
  render(controls());const user=await prepare();await confirm(user);
  const retry=await screen.findByRole("button",{name:"Retry the same component start"});
  expect(await screen.findByText(/No saved input was found/)).toBeInTheDocument();
  const originalStart=structuredClone(invoke.mock.calls.find(([command])=>command === "start_work_plan_generation_component")![1].request);
  startOutcome=outcome;await user.click(retry);
  if(outcome === "accepted") await screen.findByText(/The original component input is recorded/);
  else {
    await screen.findByText(/The action may have run/);
    expect(screen.getByRole("button",{name:"Check original component start"})).toBeEnabled();
    expect(screen.queryByRole("button",{name:"Retry the same component start"})).toBeNull();
  }
  expect(invoke.mock.calls.filter(([command])=>command === "start_work_plan_generation_component").map(([,args])=>args.request)).toEqual([originalStart,originalStart]);
  expect(invoke.mock.calls.filter(([command])=>command === "read_work_plan_generation_component_start")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command])=>command === "create_execution_identity")).toHaveLength(4);
});

it("keeps a substituted original proof unknown despite finished progress, then uses the same pure reader manually",async()=>{
  startOutcome="unknown";const base=invoke.getMockImplementation()!;let wrong=true;
  invoke.mockImplementation((command,args)=>command === "read_work_plan_generation_component_start"
    ? Promise.resolve({...startProof(),...(wrong?{taskId:fixtureIdentity(999)}:{})}) : base(command,args));
  const generated=vi.fn(),blocked=vi.fn();render(controls(workPlanToolStatus,generated,blocked));
  const user=await prepare();await confirm(user);await screen.findByText(/The action may have run/);
  child=execution("queued",true);outer=execution("succeeded",false);
  await user.click(screen.getByRole("button",{name:"Refresh execution status"}));
  await screen.findByText("Output generated");
  expect(generated).not.toHaveBeenCalled();expect(blocked).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("button",{name:"Keep records and close this component review"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Retry the same component start"})).toBeNull();
  wrong=false;await user.click(screen.getByRole("button",{name:"Check original component start"}));
  await screen.findByText(/The original component input is recorded/);
  await waitFor(()=>expect(generated).toHaveBeenCalledExactlyOnceWith(original!.generation.attemptId));
  const proofs=invoke.mock.calls.filter(([command])=>command === "read_work_plan_generation_component_start").map(([,args])=>args.request);
  expect(proofs).toHaveLength(2);expect(proofs[1]).toEqual(proofs[0]);
  expect(invoke.mock.calls.filter(([command])=>command === "start_work_plan_generation_component")).toHaveLength(1);
});

it("retains one original read flight across hidden and removed consumers with exact Registry gates",async()=>{
  startOutcome="unknown";const base=invoke.getMockImplementation()!;let finish!:(value:unknown)=>void;
  const pending=new Promise<unknown>(resolve=>{finish=resolve;});
  invoke.mockImplementation((command,args)=>command === "read_work_plan_generation_component_start" ? pending : base(command,args));
  const props={context,status:workPlanToolStatus,open:true,disabled:false,busy:false,run:perform,onGenerated:vi.fn(),onBlockedChange:vi.fn()};
  const ui=render(<WorkPlanAgentControls {...props}/>);const user=await prepare();await confirm(user);
  await screen.findByText("Checking the original component start…");
  const scope={...context,area:"ai" as const},payload={kind:"ai-component" as const,scopeId:original!.scopeId,attemptId:original!.attemptId,inputDigest:generationFixture.preflight.inputDigest};
  expect(registry.describe("ai.component.check-start",scope,payload)?.availability).toMatchObject({enabled:false,reason:"busy"});
  expect(registry.dispatch("ai.component.check-start",scope,payload)).toBe(false);
  expect(registry.dispatch("ai.component.retry-start",scope,payload)).toBe(false);
  ui.rerender(<WorkPlanAgentControls {...props} open={false}/>);
  expect(registry.describe("ai.component.check-start",scope,payload)?.availability).toMatchObject({enabled:false,reason:"hidden"});
  const changed={...props,status:{...workPlanToolStatus,state:"paused" as const,lease:{...workPlanToolStatus.lease,generation:"2"}}};
  ui.rerender(<WorkPlanAgentControls {...changed} visible={false}/>);
  const proof=startProof();await act(async()=>{finish(proof);await pending;});
  ui.rerender(<WorkPlanAgentControls {...changed}/>);
  await screen.findByText(/The original component input is recorded/);
  expect(screen.getByText("The original plan or captured entries changed. This preparation cannot start. Discard it and review the current plan.")).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command])=>command === "read_work_plan_generation_component_start")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command])=>command === "start_work_plan_generation_component")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command])=>command === "create_execution_identity")).toHaveLength(4);
});

it("ignores a late original proof after the project session retires",async()=>{
  startOutcome="unknown";const base=invoke.getMockImplementation()!;let finish!:(value:unknown)=>void;
  const pending=new Promise<unknown>(resolve=>{finish=resolve;});
  invoke.mockImplementation((command,args)=>command === "read_work_plan_generation_component_start" ? pending : base(command,args));
  const generated=vi.fn();render(controls(workPlanToolStatus,generated));const user=await prepare();await confirm(user);
  await screen.findByText("Checking the original component start…");
  const proof=startProof();await act(async()=>{reader.retire();finish(proof);await pending;});
  expect(screen.queryByText(/The original component input is recorded/)).toBeNull();
  expect(generated).not.toHaveBeenCalled();
  expect(invoke.mock.calls.filter(([command])=>command === "start_work_plan_generation_component")).toHaveLength(1);
});
