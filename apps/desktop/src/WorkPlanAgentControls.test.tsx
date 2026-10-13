import { type ReactNode } from "react";
import { act, cleanup, render as renderUi, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionReadProvider } from "./SessionReadProvider";
import { workPlanToolStatus } from "./testSupport/workPlanToolFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import agentFixture from "../test/fixtures/workPlanAgent.contract.json";
import toolFixture from "../test/fixtures/workPlanAgentTools.contract.json";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import { WorkPlanAgentControls } from "./WorkPlanAgentControls";
import { WorkPlanControls } from "./WorkPlanControls";
import { i18n } from "./i18n";
import type { AttemptDetail, SessionRequest } from "./executionCommands";
import type { WorkPlanAgentToolPrepareRequest } from "./generated/ai.requests";
import type { WorkPlanStatusView } from "./workPlanCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context: SessionRequest = { projectId: agentFixture.requests.open.projectId, sessionToken: agentFixture.requests.open.sessionToken };
function render(ui: ReactNode) { return renderUi(ui, { wrapper: ({ children }) => <SessionReadProvider context={context} bridge={false}>{children}</SessionReadProvider> }); }
let identity: number, detail: AttemptDetail | null, unknown: boolean;
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); identity = 70; detail = null; unknown = false;
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
    if (command === "start_work_plan_agent_generation") return request.generation.attemptId;
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
  unknown = true; const user = userEvent.setup(), blocked = vi.fn();
  render(<WorkPlanAgentControls context={context} status={workPlanToolStatus} open disabled={false} busy={false} run={perform} onBlockedChange={blocked} onGenerated={() => {}} />);
  await user.click(screen.getByRole("checkbox", { name: "barrel" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Reference package" }), toolFixture.spec.handle);
  await user.click(screen.getByRole("button", { name: "Query captured references" }));
  await screen.findByText(/The call may have been queued/);
  expect(screen.getByRole("button", { name: "Generate another candidate for this subset" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Check saved result" }));
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
