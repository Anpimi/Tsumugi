import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import { TeamDiscussionHistory } from "./TeamDiscussionHistory";
import { i18n } from "./i18n";
import { teamContext, teamStatusFixture, teamHistoryFixture, teamPostFixture, publishedTeamFixture } from "./testSupport/teamDiscussionFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { validateRequestWorkPlanTeamPublish } from "./generated/ai.validators";
import type { ProjectView } from "./projectCommands";
import type { WorkPlanStatusView, TeamDiscussionPost } from "./workPlanCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: teamContext.sessionToken, locator: "isolated-team", reconciliationState: "settled",
  metadata: { projectId: teamContext.projectId, displayName: "Synthetic team history", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let status: WorkPlanStatusView, owner: ReturnType<typeof useAiPreparation>["discussions"];
function Probe() { const value = useAiPreparation(); useLayoutEffect(() => { owner = value.discussions; }); return null; }
function Consumer({ value, writable, context }: { value: WorkPlanStatusView; writable: boolean; context: typeof teamContext }) {
  const preparation = useAiPreparation();
  return <TeamDiscussionHistory context={context} status={value} open writable={writable} session={preparation.discussions}/>;
}
function BoundHarness({ project: current = project, value = status, mounted = true, writable = true }: {
  project?: ProjectView; value?: WorkPlanStatusView; mounted?: boolean; writable?: boolean;
}) {
  return <AiPreparationSession initialLocale="zh-CN" targetLocales={current.metadata.targetLocales}><Probe/>{mounted ? <Consumer value={value} writable={writable} context={{projectId:current.metadata.projectId,sessionToken:current.sessionToken}}/> : null}</AiPreparationSession>;
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); status = teamStatusFixture();
  let identity = 8200;
  invoke.mockReset().mockImplementation(async (command, payload) => {
    const request = payload?.request;
    if (command === "read_context_strategy_default") return null;
    if (command === "read_work_plan_team_history") return request.planId === status.plan.planId
      ? teamHistoryFixture(request.after === "1") : { planId: request.planId, members: [], authorRoles: [], posts: [], nextAfter: null };
    if (command === "read_work_plan_team_post") return teamPostFixture();
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "read_work_plan_team_publication_action") return null;
    if (command === "publish_work_plan_team_discussion" && validateRequestWorkPlanTeamPublish(request)) return publishedTeamFixture(request);
    throw new Error(command);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(["en-US", "zh-CN"])("reads paused history with original roles, complete text and bounded pages in %s", async locale => {
  await i18n.changeLanguage(locale); const user = userEvent.setup();
  render(<BoundHarness project={project} value={{ ...status, state: "paused" }} writable={false}/>);
  await screen.findByText("Original role: preserve the missing reason.");
  expect(screen.getByText("Current role: later duties.")).toBeInTheDocument();
  expect(screen.getByText("<script>untrusted text</script> Keep the complete original reason.")).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByRole("heading", { name: "barrel · zh-CN" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: i18n.t("ai.teamHistory.publish") })).toBeDisabled();
  await user.click(screen.getByText(i18n.t("ai.teamHistory.references"), { selector: "summary" }));
  for (const reference of teamPostFixture().publication.references) if (reference.kind === "translation-revision") expect(screen.getByText(reference.revisionId)).toBeInTheDocument();
  expect(screen.getByText(i18n.t("ai.teamHistory.translationVersion"))).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: i18n.t("ai.teamHistory.nextPage") }));
  await screen.findByText("A human reply remains a suggestion.");
  expect(calls("read_work_plan_team_history").at(-1)![1].request).toMatchObject({ after: "1", limit: 16 });
  await user.click(screen.getByRole("button", { name: i18n.t("ai.teamHistory.readReply") }));
  const original = await screen.findByRole("region", { name: i18n.t("ai.teamHistory.originalPost") });
  await within(original).findByText("Original role: preserve the missing reason.");
  expect(calls("publish_work_plan_team_discussion")).toHaveLength(0);
});

it("retains the original unknown request and newer body/target across pane and plan switches", async () => {
  const user = userEvent.setup(), pending = deferred<TeamDiscussionPost>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "publish_work_plan_team_discussion" ? pending.promise : original(command, payload));
  const second = { ...status.plan.scope[0], unitId: fixtureIdentity(8100), sourceRevisionId: fixtureIdentity(8101), nativeKey: "second" };
  status = { ...status, plan: { ...status.plan, scope: [...status.plan.scope, second] } };
  const ui = render(<BoundHarness project={project}/>);
  await screen.findByText("Original role: preserve the missing reason.");
  await user.type(screen.getByRole("textbox", { name: "Note text" }), "Original note A");
  await user.click(screen.getByRole("button", { name: "Publish note" }));
  await waitFor(() => expect(calls("publish_work_plan_team_discussion")).toHaveLength(1));
  const request = structuredClone(calls("publish_work_plan_team_discussion")[0][1].request);
  await user.clear(screen.getByRole("textbox", { name: "Note text" }));
  await user.type(screen.getByRole("textbox", { name: "Note text" }), "New draft B");
  await user.selectOptions(screen.getByRole("combobox", { name: "Original entry for this note" }), second.unitId);
  ui.rerender(<BoundHarness project={project} mounted={false}/>);
  await act(async () => { pending.reject(new Error("Synthetic lost acknowledgement")); });
  expect(owner.current(status.plan.planId).pending?.request).toEqual(request);
  const other = { ...status, plan: { ...status.plan, planId: fixtureIdentity(8110) }, lease: { ...status.lease, planId: fixtureIdentity(8110) } };
  ui.rerender(<BoundHarness project={project} value={other}/>);
  expect(screen.getByRole("textbox", { name: "Note text" })).toHaveValue("");
  ui.rerender(<BoundHarness project={project} value={{ ...status, state: "paused" }} writable={false}/>);
  expect(screen.getByRole("textbox", { name: "Note text" })).toHaveValue("New draft B");
  expect(screen.getByRole("combobox", { name: "Original entry for this note" })).toHaveValue(second.unitId);
  expect(screen.getByRole("button", { name: "Retry original publication" })).toBeDisabled();
  invoke.mockImplementation((command, payload) => command === "read_work_plan_team_publication_action" ? Promise.resolve(publishedTeamFixture(request)) : original(command, payload));
  await user.click(screen.getByRole("button", { name: "Check original publication" }));
  await screen.findByText(i18n.t("ai.teamHistory.recorded"));
  expect(calls("read_work_plan_team_publication_action").at(-1)![1].request).toEqual(request);
  expect(screen.getByRole("textbox", { name: "Note text" })).toHaveValue("New draft B");
  expect(owner.current(status.plan.planId).pending).toBeNull();
  expect(calls("publish_work_plan_team_discussion")).toHaveLength(1);
});

it("keeps failed checks and missing records uncertain, then retries only the exact live original request", async () => {
  const user = userEvent.setup(), original = invoke.getMockImplementation()!;
  let writes = 0, checks = 0;
  invoke.mockImplementation((command, payload) => {
    if (command === "publish_work_plan_team_discussion" && ++writes === 1) return Promise.reject(new Error("Synthetic lost acknowledgement"));
    if (command === "read_work_plan_team_publication_action" && ++checks === 1) return Promise.reject(new Error("Synthetic read failure"));
    return original(command, payload);
  });
  const ui = render(<BoundHarness project={project}/>);
  await user.type(screen.getByRole("textbox", { name: "Note text" }), "Original note A");
  await user.click(screen.getByRole("button", { name: "Publish note" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check original publication" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Check original publication" }));
  await waitFor(() => expect(checks).toBe(1));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check original publication" })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "Note text" })).toHaveValue("Original note A");
  expect(screen.getByRole("button", { name: "Retry original publication" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Check original publication" }));
  await screen.findByText(i18n.t("ai.teamHistory.absent"));
  expect(calls("publish_work_plan_team_discussion")).toHaveLength(1);
  ui.rerender(<BoundHarness project={project} value={{ ...status, state: "paused" }} writable={false}/>);
  expect(screen.getByRole("button", { name: "Retry original publication" })).toBeDisabled();
  ui.rerender(<BoundHarness project={project}/>);
  await user.click(screen.getByRole("button", { name: "Retry original publication" }));
  await screen.findByText(i18n.t("ai.teamHistory.recorded"));
  const writesMade = calls("publish_work_plan_team_discussion");
  expect(writesMade).toHaveLength(2); expect(writesMade[1][1].request).toEqual(writesMade[0][1].request);
  expect(calls("create_execution_identity")).toHaveLength(1);
});

it("keeps another project session isolated from a late publication acknowledgement", async () => {
  const user = userEvent.setup(), pending = deferred<TeamDiscussionPost>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "publish_work_plan_team_discussion" ? pending.promise : original(command, payload));
  const ui = render(<BoundHarness project={project}/>);
  await user.type(screen.getByRole("textbox", { name: "Note text" }), "Original note A");
  await user.click(screen.getByRole("button", { name: "Publish note" }));
  await waitFor(() => expect(calls("publish_work_plan_team_discussion")).toHaveLength(1));
  const request = calls("publish_work_plan_team_discussion")[0][1].request;
  const otherProject = { ...project, sessionToken: "another-team-session", metadata: { ...project.metadata, projectId: fixtureIdentity(8800) } };
  const otherStatus = { ...status, plan: { ...status.plan, planId: fixtureIdentity(8801) }, lease: { ...status.lease, planId: fixtureIdentity(8801) } };
  ui.rerender(<BoundHarness project={otherProject} value={otherStatus}/>);
  await user.type(screen.getByRole("textbox", { name: "Note text" }), "Other project B");
  await act(async () => { pending.resolve(publishedTeamFixture(request)); });
  expect(screen.getByRole("textbox", { name: "Note text" })).toHaveValue("Other project B");
  expect(owner.current(otherStatus.plan.planId).pending).toBeNull();
  expect(screen.queryByText(i18n.t("ai.teamHistory.recorded"))).not.toBeInTheDocument();
});

it("does not enable discussion sharing and counts note limits as UTF-8 bytes", async () => {
  const ui = render(<BoundHarness project={project} value={{ ...status, plan: { ...status.plan, options: { ...status.plan.options, teamDiscussions: undefined }, teamDiscussionLimits: undefined } }}/>);
  await screen.findByText(i18n.t("ai.teamHistory.disabled"));
  expect(screen.queryByRole("textbox", { name: "Note text" })).not.toBeInTheDocument();
  ui.rerender(<BoundHarness project={project}/>);
  const bytes = status.plan.teamDiscussionLimits!.maxPostBytes;
  fireEvent.change(screen.getByRole("textbox", { name: "Note text" }), { target: { value: "界".repeat(Math.floor(bytes / 3) + 1) } });
  expect(screen.getByRole("button", { name: "Publish note" })).toBeDisabled();
  expect(calls("create_execution_identity")).toHaveLength(0);
});

it("ends only a checked-absent retry after its lease changes and keeps B for an explicit new publication", async () => {
  const user = userEvent.setup(), original = invoke.getMockImplementation()!;
  let writes = 0;
  invoke.mockImplementation((command, payload) => command === "publish_work_plan_team_discussion" && ++writes === 1
    ? Promise.reject(new Error("Synthetic lost acknowledgement")) : original(command, payload));
  const second = { ...status.plan.scope[0], unitId: fixtureIdentity(8500), sourceRevisionId: fixtureIdentity(8501), nativeKey: "second" };
  status = { ...status, plan: { ...status.plan, scope: [...status.plan.scope, second] } };
  const ui = render(<BoundHarness project={project}/>);
  await user.type(screen.getByRole("textbox", { name: "Note text" }), "Original note A");
  await user.click(screen.getByRole("button", { name: "Publish note" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check original publication" })).toBeEnabled());
  await user.clear(screen.getByRole("textbox", { name: "Note text" }));
  await user.type(screen.getByRole("textbox", { name: "Note text" }), "New draft B");
  await user.selectOptions(screen.getByRole("combobox", { name: "Original entry for this note" }), second.unitId);
  expect(screen.queryByRole("button", { name: "Keep draft and end this retry" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Check original publication" }));
  await screen.findByText(i18n.t("ai.teamHistory.absent"));
  ui.rerender(<BoundHarness project={project} writable={false}/>);
  expect(screen.queryByRole("button", { name: "Keep draft and end this retry" })).not.toBeInTheDocument();
  const renewed = { ...status, lease: { ...status.lease, generation: "5" } };
  ui.rerender(<BoundHarness project={project} value={renewed} writable={false}/>);
  await user.click(screen.getByRole("button", { name: "Keep draft and end this retry" }));
  expect(screen.getByRole("textbox", { name: "Note text" })).toHaveValue("New draft B");
  expect(screen.getByRole("combobox", { name: "Original entry for this note" })).toHaveValue(second.unitId);
  expect(calls("publish_work_plan_team_discussion")).toHaveLength(1);
  ui.rerender(<BoundHarness project={project} value={renewed}/>);
  await user.click(screen.getByRole("button", { name: "Publish note" }));
  await screen.findByText(i18n.t("ai.teamHistory.recorded"));
  const first = calls("publish_work_plan_team_discussion")[0][1].request, next = calls("publish_work_plan_team_discussion")[1][1].request;
  expect(next.lease).toEqual(renewed.lease); expect(next.publication.body).toBe("New draft B");
  expect(next.publication.target.unitId).toBe(second.unitId);
  expect(next.publication.postId).not.toBe(first.publication.postId);
});

it("updates retry availability and the safe local exit when the original permission expires while idle", async () => {
  const now = Date.now(); vi.useFakeTimers(); vi.setSystemTime(now);
  status = { ...status, expiresAt: String(Math.floor(now / 1000) + 1) };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "publish_work_plan_team_discussion"
    ? Promise.reject(new Error("Synthetic lost acknowledgement")) : original(command, payload));
  render(<BoundHarness project={project}/>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  fireEvent.change(screen.getByRole("textbox", { name: "Note text" }), { target: { value: "Original note A" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Publish note" })); await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check original publication" })); await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole("button", { name: "Retry original publication" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Keep draft and end this retry" })).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(screen.getByRole("button", { name: "Retry original publication" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Keep draft and end this retry" })).toBeEnabled();
  expect(calls("publish_work_plan_team_discussion")).toHaveLength(1);
});
