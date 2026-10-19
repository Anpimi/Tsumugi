import { createRef, useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { TeamExecutionHistory } from "./TeamExecutionHistory";
import { TeamWorkToolHistory } from "./TeamWorkToolHistory";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import { AiWorkbench, type AiHandle } from "./AiWorkbench";
import { checkedTeamToolHistoryTask, workPlanCommands, type TeamWorkToolHistory as ToolHistory, type TeamWorkReference } from "./workPlanCommands";
import { teamRecoveryFixture, teamRecoveryPreviewFixture } from "./testSupport/teamRecoveryFixture";
import { teamToolHistoryFixture } from "./testSupport/teamToolHistoryFixture";
import { teamContext } from "./testSupport/teamDiscussionFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { connectionFixture } from "./testSupport/connectionFixture";
import type { ProjectView } from "./projectCommands";
import type { WorkPlanTeamWorkToolsRequest } from "./generated/ai.requests";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: teamContext.sessionToken, locator: "synthetic-tool-history", reconciliationState: "settled",
  metadata: { projectId: teamContext.projectId, displayName: "Synthetic tool history", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let source: ReturnType<typeof teamRecoveryFixture>, owner: ReturnType<typeof useAiPreparation>;
const work = (): TeamWorkReference => { const value = source.view.works[0].receipt; return { taskId: value.taskId, attemptId: value.attemptId, inputDigest: value.inputDigest }; };
const request = (): WorkPlanTeamWorkToolsRequest => ({ ...teamContext, planId: source.status.plan.planId, work: work(), after: null, limit: 16 });
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function firstAttempt(page: ToolHistory) {
  const row = page.attempts[0];
  if (!row) throw new Error("Expected an exact synthetic tool attempt");
  return row;
}
function Probe() { const value = useAiPreparation(); useLayoutEffect(() => { owner = value; }); return null; }
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); source = teamRecoveryFixture(); let identity = 10500;
  invoke.mockReset().mockImplementation(async (command, payload) => {
    const input = payload?.request, unit = source.status.plan.scope[0];
    if (command === "read_context_strategy_default") return null;
    if (command === "read_model_connections") return connectionFixture([]);
    if (command === "read_plugin_text_reviews") return { settingsRevision: "1", entries: [] };
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: unit.sourceSnapshotId };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: unit.sourceSnapshotId, scope: { revision: "1", currentSnapshot: unit.sourceSnapshotId }, rows: [sourceRowFixture({ unitId: unit.unitId, sourceRevisionId: unit.sourceRevisionId }, { key: unit.nativeKey, text: "Original synthetic tool scope" })] });
    if (command === "read_work_plan_status") return structuredClone(source.status);
    if (command === "read_work_plan_team_execution") return structuredClone(source.view);
    if (command === "read_work_plan_team_recovery_state") return structuredClone(source.state);
    if (command === "read_work_plan_team_history") return { planId: source.status.plan.planId, members: [], authorRoles: [], posts: [], nextAfter: null };
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "prepare_work_plan_team_recovery") return teamRecoveryPreviewFixture(input, source);
    if (command === "authorize_work_plan_team_recovery") throw { outcome: "unknown" };
    if (command === "read_work_plan_team_work_tools") return teamToolHistoryFixture(input);
    throw new Error(command);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["en-US", "zh-CN"])("opens exact captured tool history on demand from stopped or paused original team work in %s", async locale => {
  await i18n.changeLanguage(locale);
  source.status.state = locale === "en-US" ? "paused" : "stopped"; source.status.expiresAt = "1";
  const user = userEvent.setup(), openTask = vi.fn(async (_taskId: string, _attemptId: string) => true);
  render(<TeamExecutionHistory context={teamContext} status={source.status} open onReadPost={() => {}} onOpenToolTask={async (original, row) => {
    expect(checkedTeamToolHistoryTask(teamContext, source.status.plan.planId, original, row)).toBe(true);
    return openTask(row.reference.taskId, row.reference.attemptId);
  }}/>, project);
  await screen.findByText("Read the complete original objection before deciding."); expect(calls("read_work_plan_team_work_tools")).toHaveLength(0);
  await user.click(screen.getByText(i18n.t("ai.teamTools.title"), { exact: true }));
  const page = await screen.findByRole("region", { name: i18n.t("ai.teamTools.title") });
  const fixture = teamToolHistoryFixture(request()), row = firstAttempt(fixture);
  expect(await within(page).findByRole("heading", { name: row.name })).toBeVisible();
  expect(within(page).getByText(i18n.t("ai.teamTools.entries", { entries: source.status.plan.scope[0].nativeKey, locale: source.status.plan.locale }))).toBeVisible();
  expect(within(page).getByText(i18n.t("ai.teamTools.resultHelp"))).toBeVisible();
  await user.click(within(page).getByRole("button", { name: i18n.t("ai.teamTools.openTask", { name: row.name }) }));
  expect(openTask).toHaveBeenCalledExactlyOnceWith(row.reference.taskId, row.reference.attemptId);
  expect(calls("read_work_plan_team_work_tools")[0][1].request).toEqual(request());
  expect(calls("start_work_plan")).toHaveLength(0); expect(calls("start_work_plan_agent_tool")).toHaveLength(0);
});

it.each(["work", "project", "cursor", "result-count"])("rejects a mismatched tool-history %s before displaying or opening it", async changed => {
  invoke.mockImplementation(async (_command, payload) => {
    const value = teamToolHistoryFixture(payload.request);
    if (changed === "work") value.work.inputDigest = "f".repeat(64);
    if (changed === "project") value.projectId = fixtureIdentity(10600);
    if (changed === "cursor") value.nextAfter = "999";
    if (changed === "result-count") firstAttempt(value).storedResultItems = 2;
    return value;
  });
  const user = userEvent.setup(), openTask = vi.fn(async () => true);
  render(<TeamWorkToolHistory context={teamContext} plan={source.status.plan} work={work()} open current onOpenTask={openTask}/>, project);
  await user.click(screen.getByText(i18n.t("ai.teamTools.title"), { exact: true }));
  const failure = await screen.findByRole("alert"); expect(failure).toHaveTextContent(i18n.t("ai.teamTools.failed"));
  expect(screen.queryByRole("heading", { name: "Captured glossary query 中文" })).not.toBeInTheDocument(); expect(openTask).not.toHaveBeenCalled();
});

it("refreshes unknown progress into a stored result without losing its exact navigation witness and blocks stale or failed rows", async () => {
  let reads = 0; const pending = deferred<ToolHistory>();
  invoke.mockImplementation((_command, payload) => ++reads === 1 ? teamToolHistoryFixture(payload.request, "unknown") : reads === 2 ? pending.promise : Promise.reject(new Error("Synthetic read unavailable")));
  const user = userEvent.setup(), openTask = vi.fn(async (_taskId: string, _attemptId: string) => true);
  render(<TeamWorkToolHistory context={teamContext} plan={source.status.plan} work={work()} open current onOpenTask={async (original, row) => {
    expect(checkedTeamToolHistoryTask(teamContext, source.status.plan.planId, original, row)).toBe(true);
    return openTask(row.reference.taskId, row.reference.attemptId);
  }}/>, project);
  await user.click(screen.getByText(i18n.t("ai.teamTools.title"), { exact: true }));
  await screen.findByText(i18n.t("ai.teamTools.unknown"));
  const name = i18n.t("ai.teamTools.openTask", { name: "Captured glossary query 中文" });
  await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: i18n.t("ai.teamTools.refresh") }));
  expect(screen.getByRole("button", { name })).toBeDisabled(); expect(screen.getByText(i18n.t("ai.teamTools.loading"))).toBeVisible();
  await act(async () => { pending.resolve(teamToolHistoryFixture(request())); });
  await screen.findByText(i18n.t("ai.teamTools.recorded", { count: 1 }));
  await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
  await user.click(screen.getByRole("button", { name })); expect(openTask).toHaveBeenCalledExactlyOnceWith(fixtureIdentity(10400), fixtureIdentity(10401));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.teamTools.refresh") }));
  expect(await screen.findByRole("alert")).toHaveFocus(); expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
});

it("pages within the full original work identity and reports an empty page without replaying anything", async () => {
  invoke.mockImplementation(async (_command, payload) => {
    const value = teamToolHistoryFixture(payload.request); if (payload.request.after === null) value.nextAfter = firstAttempt(value).sequence;
    else value.attempts = []; return value;
  });
  const user = userEvent.setup(); render(<TeamWorkToolHistory context={teamContext} plan={source.status.plan} work={work()} open current/>, project);
  await user.click(screen.getByText(i18n.t("ai.teamTools.title"), { exact: true })); await screen.findByRole("heading", { name: "Captured glossary query 中文" });
  await user.click(screen.getByRole("button", { name: i18n.t("ai.teamTools.nextPage") }));
  await screen.findByText(i18n.t("ai.teamTools.empty"));
  expect(calls("read_work_plan_team_work_tools")[1][1].request).toEqual({ ...request(), after: "7" });
  await user.click(screen.getByRole("button", { name: i18n.t("ai.teamTools.firstPage") }));
  await screen.findByRole("heading", { name: "Captured glossary query 中文" });
  expect(invoke.mock.calls.every(([command]) => command === "read_work_plan_team_work_tools")).toBe(true);
});

it("ignores a late page for work A after the displayed original work changes to B", async () => {
  const old = deferred<ToolHistory>(), a = request(), b = { ...work(), taskId: fixtureIdentity(10610), attemptId: fixtureIdentity(10611), inputDigest: "b".repeat(64) };
  invoke.mockImplementation((_command, payload) => payload.request.work.attemptId === a.work.attemptId ? old.promise : teamToolHistoryFixture(payload.request));
  const user = userEvent.setup(), rendered = render(<TeamWorkToolHistory context={teamContext} plan={source.status.plan} work={a.work} open current/>, project);
  await user.click(screen.getByText(i18n.t("ai.teamTools.title"), { exact: true })); await waitFor(() => expect(calls("read_work_plan_team_work_tools")).toHaveLength(1));
  rendered.rerender(<TeamWorkToolHistory context={teamContext} plan={source.status.plan} work={b} open current/>);
  await screen.findByRole("heading", { name: "Captured glossary query 中文" });
  const late = teamToolHistoryFixture(a); firstAttempt(late).name = "Late other work must stay hidden";
  await act(async () => { old.resolve(late); });
  expect(screen.queryByRole("heading", { name: "Late other work must stay hidden" })).not.toBeInTheDocument();
  expect(calls("read_work_plan_team_work_tools")[1][1].request.work).toEqual(b);
});

it("binds a navigation witness to the exact context and original work, rejecting copies and changed row identities", async () => {
  const value = await workPlanCommands.teamWorkTools(request()), row = firstAttempt(value);
  expect(checkedTeamToolHistoryTask(teamContext, source.status.plan.planId, work(), row)).toBe(true);
  expect(checkedTeamToolHistoryTask({ ...teamContext, sessionToken: "other-session" }, source.status.plan.planId, work(), row)).toBe(false);
  expect(checkedTeamToolHistoryTask(teamContext, source.status.plan.planId, { ...work(), inputDigest: "f".repeat(64) }, row)).toBe(false);
  expect(checkedTeamToolHistoryTask(teamContext, source.status.plan.planId, work(), structuredClone(row))).toBe(false);
  row.reference.attemptId = fixtureIdentity(10620);
  expect(checkedTeamToolHistoryTask(teamContext, source.status.plan.planId, work(), row)).toBe(false);
});

it("uses the actual AI navigation guard for a checked tool task while preserving recovery B and the unknown original action", async () => {
  const handle = createRef<AiHandle>(), user = userEvent.setup(), opened = vi.fn();
  const pane = <AiWorkbench project={project} disabled={false} ref={handle} onOpenTranslation={async () => false} onOpenTask={async (taskId, attemptId) => {
      expect(await handle.current!.allowNavigate({ kind: "task", taskId: fixtureIdentity(10630), attemptId })).toBe(false);
      const allowed = await handle.current!.allowNavigate({ kind: "task", taskId, attemptId }); opened(taskId, attemptId, allowed); return allowed;
    }}/>;
  const rendered = render(<AiPreparationSession initialLocale="zh-CN" targetLocales={project.metadata.targetLocales}><Probe/>{pane}</AiPreparationSession>, project);
  await user.click(screen.getByRole("button", { name: "AI work" })); await act(async () => { owner.recordPlan(source.status.plan.planId); });
  const begin = await screen.findByRole("button", { name: i18n.t("ai.recovery.edit") }); await waitFor(() => expect(begin).toBeEnabled()); await user.click(begin);
  const instructions = screen.getByRole("textbox", { name: i18n.t("ai.recovery.instructions") }); await user.type(instructions, "Submitted human A");
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.prepare") })); await user.click(await screen.findByRole("checkbox", { name: i18n.t("ai.recovery.consent") }));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.authorize") })); await screen.findByText(i18n.t("ai.recovery.unknown"));
  await user.clear(instructions); await user.type(instructions, "Newer B must remain after exact history navigation.");
  const original = owner.recovery.current().pending, originalRequest = structuredClone(original!.request);
  await user.click(screen.getByText(i18n.t("ai.teamTools.title"), { exact: true }));
  const link = await screen.findByRole("button", { name: i18n.t("ai.teamTools.openTask", { name: "Captured glossary query 中文" }) }); await waitFor(() => expect(link).toBeEnabled()); await user.click(link);
  await waitFor(() => expect(opened).toHaveBeenCalledExactlyOnceWith(fixtureIdentity(10400), fixtureIdentity(10401), true));
  expect(owner.recovery.current().pending).toBe(original); expect(owner.recovery.current().pending!.request).toEqual(originalRequest);
  expect(owner.recovery.current().draft!.instructions).toBe("Newer B must remain after exact history navigation.");
  expect(await handle.current!.allowNavigate({ kind: "task", taskId: fixtureIdentity(10400), attemptId: fixtureIdentity(10401) })).toBe(false);
  rendered.rerender(<AiPreparationSession initialLocale="zh-CN" targetLocales={project.metadata.targetLocales}><Probe/></AiPreparationSession>);
  expect(owner.recovery.current().pending).toBe(original);
  rendered.rerender(<AiPreparationSession initialLocale="zh-CN" targetLocales={project.metadata.targetLocales}><Probe/>{pane}</AiPreparationSession>);
  expect(await screen.findByRole("textbox", { name: i18n.t("ai.recovery.instructions") })).toHaveValue("Newer B must remain after exact history navigation.");
  expect(owner.recovery.current().pending!.request).toEqual(originalRequest);
  expect(calls("start_work_plan")).toHaveLength(0); expect(calls("start_work_plan_agent_tool")).toHaveLength(0);
});
