import { createRef, useLayoutEffect, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSessionWorkbench, type ProjectSessionHandle } from "./ProjectSessionWorkbench";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { WorkspaceViewMemory, WorkspaceViewProvider, type WorkspaceArea } from "./WorkbenchFrame";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "./workbenchCommands";
import * as aiOwner from "./AiPreparationSession";
import { openWorkPlanAgent, type WorkPlanStatusView } from "./workPlanCommands";
import { workPlanToolStatus } from "./testSupport/workPlanToolFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { connectionFixture } from "./testSupport/connectionFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import agent from "../test/fixtures/workPlanAgent.contract.json";
import execution from "../test/fixtures/executionCommands.contract.json";
import type { ProjectView } from "./projectCommands";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const project: ProjectView = { sessionToken: agent.requests.open.sessionToken, locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: agent.requests.open.projectId, displayName: "Child history", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const actual = aiOwner.useAiPreparation, handle = createRef<ProjectSessionHandle>();
let ai: ReturnType<typeof actual>, area: WorkspaceArea, memory: WorkspaceViewMemory, status: WorkPlanStatusView;
async function originalChild() {
  const parent = await openWorkPlanAgent(agent.requests.open, status.plan.scope, status.plan.tools?.entries ?? []);
  const consumer = await parent.delegate({ unitIds: [status.plan.scope[0].unitId], toolHandles: [] });
  const prepared = await consumer.prepare(agent.requests.prepare.generation);
  return { consumer, prepared };
}
function Harness() {
  const [current, show] = useState<WorkspaceArea>("overview"), [retained] = useState(() => new WorkspaceViewMemory());
  const [commands] = useState(() => new WorkbenchCommands());
  useLayoutEffect(() => { area = current; memory = retained; });
  return <ApplicationReadProvider><WorkbenchCommandsProvider commands={commands}><WorkspaceViewProvider value={{ area: current, memory: retained,
    activate: show, deactivate: closing => show(before => before === closing ? "overview" : before) }}>
    <ProjectSessionWorkbench ref={handle} project={project} disabled={false} onActivate={show} onCoordinatingChange={() => {}} />
  </WorkspaceViewProvider></WorkbenchCommandsProvider></ApplicationReadProvider>;
}
const calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); vi.restoreAllMocks(); status = structuredClone(workPlanToolStatus);
  vi.spyOn(aiOwner, "useAiPreparation").mockImplementation(() => { const value = actual(); ai = value; return value; });
  invoke.mockReset().mockImplementation(async (command, { request }) => {
    if (command === "read_context_strategy_default") return null;
    if (command === "read_project_changes") return { projectId: project.metadata.projectId, sessionToken: project.sessionToken,
      epoch: fixtureIdentity(4000), sequence: "0", progressSequence: "0", scopes: [], runtime: execution.status };
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: status.plan.scope[0].sourceSnapshotId };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: status.plan.scope[0].sourceSnapshotId,
      scope: { revision: "1", currentSnapshot: status.plan.scope[0].sourceSnapshotId }, rows: status.plan.scope.map(unit =>
        sourceRowFixture({ unitId: unit.unitId, sourceRevisionId: unit.sourceRevisionId }, { key: unit.nativeKey })) });
    if (command === "read_execution_task_activity") return { total: "1", active: "0", attention: "1", saved: "0", rows: [{
      taskId: agent.responses.generation.taskId, attemptId: agent.responses.generation.attemptId, operation: "ai-translation", sequence: "1", phase: "attention", progress: { ...agent.responses.generationAttempt.progress, succeeded: 0, unknown: 1 } }] };
    if (command === "read_model_connections") return connectionFixture([]);
    if (command === "read_plugin_text_reviews") return { settingsRevision: "1", entries: [] };
    if (command === "read_work_plan_status") return structuredClone(status);
    if (command === "open_work_plan_agent_scope") return structuredClone(agent.responses.scope);
    if (command === "delegate_work_plan_agent_scope") return { ...structuredClone(agent.responses.child), delegation: { ...request.delegation, parentScopeId: request.scopeId } };
    if (command === "prepare_work_plan_agent_generation") return { ...structuredClone(agent.responses.generation), scopeId: agent.responses.child.scopeId };
    if (command === "read_execution_attempt") return { ...structuredClone(agent.responses.generationAttempt), progress: { ...agent.responses.generationAttempt.progress, succeeded: 0, unknown: 1 },
      items: agent.responses.generationAttempt.items.map(item => ({ ...item, resultId: null, status: { ...item.status, execution: "unknown" } })) };
    if (command === "execution_status") return execution.status;
    if (command === "read_execution_task") return [{ attemptId: agent.responses.generation.attemptId, sequence: "1" }];
    if (command === "read_execution_task_view") return { ...execution.task, taskId: request.taskId, projectId: project.metadata.projectId, operation: "ai-translation", sequence: "1", cancellationRevision: "0" };
    if (command === "read_execution_continuations") return { receipts: [], next: null };
    throw new Error(`Unexpected child history command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("opens only the explicitly requested child Task through production navigation, retains unknown and B, and returns to the same consumer", async () => {
  render(<Harness />);
  const captured = await originalChild();
  act(() => {
    ai.recordPlan(status.plan.planId); ai.setConfig(before => ({ ...before, model: "Retained manual B" }));
    ai.agent.update(before => ({ ...before, child: { ...before.child, children: [{ consumer: captured.consumer, status, accepted: true, toolHandle: "", runs: [
      { kind: "generation", prepared: captured.prepared, phase: "unknown", retryAllowed: false,
        request: { projectId: project.metadata.projectId, sessionToken: project.sessionToken, lease: status.lease,
          taskId: captured.prepared.taskId, attemptId: captured.prepared.attemptId, inputDigest: captured.prepared.inputDigest } } ] }] } }));
  });
  await act(async () => { expect(await handle.current!.navigate({ kind: "area", area: "ai" })).toBe(true); });
  await screen.findByRole("button", { name: "Inspect this child’s task history" });
  await act(async () => { expect(await handle.current!.navigate({ kind: "task", taskId: fixtureIdentity(4001), attemptId: captured.prepared.attemptId })).toBe(false); });
  expect(area).toBe("ai");
  await act(async () => { expect(await handle.current!.prepareExit()).toBeNull(); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Inspect this child’s task history" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Inspect this child’s task history" }));
  await waitFor(() => expect(area).toBe("tasks"));
  expect(memory.read("tasks", "taskId")).toBe(captured.prepared.taskId); expect(memory.read("tasks", "attemptId")).toBe(captured.prepared.attemptId);
  expect(ai.agent.current().child.children[0].runs[0].phase).toBe("unknown");
  await act(async () => { expect(await handle.current!.navigate({ kind: "area", area: "ai" })).toBe(true); });
  await screen.findByRole("button", { name: "Inspect this child’s task history" });
  expect(ai.agent.current().child.children[0].consumer).toBe(captured.consumer);
  expect(ai.agent.current().child.children[0].runs[0].prepared).toBe(captured.prepared);
  expect(ai.current().config.model).toBe("Retained manual B"); expect(ai.current().dirty).toBe(true);
  await act(async () => { expect(await handle.current!.navigate({ kind: "area", area: "resources" })).toBe(false); });
  expect(area).toBe("ai");
  expect(calls("start_work_plan_agent_generation")).toHaveLength(0); expect(calls("read_execution_output")).toHaveLength(0);
  expect(calls("authorize_work_plan")).toHaveLength(0); expect(calls("control_work_plan")).toHaveLength(0);
});

it("keeps original Stop and Take over controls reachable for an expired Active plan with a child unknown", async () => {
  render(<Harness />); const captured = await originalChild();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime((Number(status.expiresAt) + 1) * 1000);
  act(() => {
    ai.recordPlan(status.plan.planId);
    ai.agent.update(before => ({ ...before, child: { ...before.child, children: [{ consumer: captured.consumer, status, accepted: true, toolHandle: "", runs: [{
      kind: "generation", prepared: captured.prepared, phase: "unknown", retryAllowed: false,
      request: { projectId: project.metadata.projectId, sessionToken: project.sessionToken, lease: status.lease,
        taskId: captured.prepared.taskId, attemptId: captured.prepared.attemptId, inputDigest: captured.prepared.inputDigest }
    }] }] } }));
  });
  await act(async () => { expect(await handle.current!.navigate({ kind: "area", area: "ai" })).toBe(true); });
  await screen.findByRole("button", { name: i18n.t("ai.plan.stop") });
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("ai.plan.stop") })).toBeEnabled());
  expect(screen.getByRole("button", { name: i18n.t("ai.plan.takeOver") })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Generate within this child" })).toBeDisabled();
  expect(ai.reserved()).toBe(true); expect(calls("control_work_plan")).toHaveLength(0);
});
