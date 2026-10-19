import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { AiPreparationSession, useAiPreparation, defaultPlanOptions } from "./AiPreparationSession";
import { AiWorkbench } from "./AiWorkbench";
import { TeamExecutionDisclosure } from "./TeamExecutionDisclosure";
import { TeamExecutionHistory } from "./TeamExecutionHistory";
import { teamRecoveryFixture } from "./testSupport/teamRecoveryFixture";
import { teamExecutionStatusFixture, teamExecutionViewFixture } from "./testSupport/teamExecutionFixture";
import { teamContext } from "./testSupport/teamDiscussionFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { connectionFixture } from "./testSupport/connectionFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { teamDiscussionLimitsForFixture } from "./testSupport/aiFixture";
import { workPlanCommands, type WorkPlanView, type WorkPlanStatusView } from "./workPlanCommands";
import type { WorkPlanPrepareRequest } from "./generated/ai.requests";
import type { ProjectView } from "./projectCommands";
import * as validators from "./generated/ai.validators";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: teamContext.sessionToken, locator: "synthetic-team", reconciliationState: "settled",
  metadata: { projectId: teamContext.projectId, displayName: "Synthetic bounded team", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let owner: ReturnType<typeof useAiPreparation>, status: WorkPlanStatusView;
let connections: ReturnType<typeof connectionFixture>;
const savedConfig = { ...teamExecutionStatusFixture().plan.preview!.config, model: "Saved reviewer", connectionProfile: {
  storeId: fixtureIdentity(9400), profileId: fixtureIdentity(9401), revision: "1", digest: "a".repeat(64) } };
function Probe() { const value = useAiPreparation(); useLayoutEffect(() => { owner = value; }); return null; }
function Harness({ project: current }: { project: ProjectView }) {
  return <AiPreparationSession initialLocale="zh-CN" targetLocales={current.metadata.targetLocales}><Probe/>
    <AiWorkbench project={current} disabled={false} onOpenTranslation={async () => false}/>
  </AiPreparationSession>;
}
function prepareFixture(request: WorkPlanPrepareRequest): WorkPlanView {
  if (!request.config) throw new Error("Expected synthetic assisted plan");
  const plan = structuredClone(status.plan), preview = { ...structuredClone(plan.preview!), config: structuredClone(request.config) };
  const options = structuredClone(request.options);
  plan.options = { ...options, advisoryChecks: options.advisoryChecks.map(check => ({ ...check, execution: { ...check.execution, profile: check.execution.profile ?? null } })) };
  plan.preview = preview;
  plan.teamDiscussionLimits = request.options.teamDiscussions ? teamDiscussionLimitsForFixture(request.options.teamDiscussions) : null;
  if (plan.options.teamExecution) plan.memberPreviews = plan.options.teamExecution.members.map(member => ({ memberId: member.memberId,
    preview: { ...structuredClone(preview), config: structuredClone(member.config), items: preview.items.map(item => ({ ...structuredClone(item),
      terms: member.config.shareTerms ? item.terms : [], context: member.config.shareContext ? item.context : null,
      projectContext: member.config.shareContext ? item.projectContext : { kind: "not-selected" },
      sourceContext: { kind: "not-selected" }, omissions: [!member.config.shareTerms ? "terms-not-shared" : "", !member.config.shareContext ? "context-not-shared" : ""].filter(Boolean) })) } }));
  else delete plan.memberPreviews;
  expect(validators.validateResponseWorkPlan(plan)).toBe(true); return plan;
}
const calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); status = teamExecutionStatusFixture(); connections = connectionFixture([savedConfig]);
  let identity = 9450;
  invoke.mockReset().mockImplementation(async (command, payload) => {
    const request = payload?.request, unit = status.plan.scope[0];
    if (command === "read_context_strategy_default") return null;
    if (command === "read_model_connections") return structuredClone(connections);
    if (command === "read_plugin_text_reviews") return { settingsRevision: "1", entries: [] };
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: unit.sourceSnapshotId };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: unit.sourceSnapshotId,
      scope: { revision: "1", currentSnapshot: unit.sourceSnapshotId }, rows: [sourceRowFixture({ unitId: unit.unitId, sourceRevisionId: unit.sourceRevisionId }, { key: unit.nativeKey, text: "Synthetic original source" })] });
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "prepare_work_plan" && validators.validateRequestWorkPlanPrepare(request)) return prepareFixture(request);
    if (command === "read_work_plan_status") return structuredClone(status);
    if (command === "read_work_plan_team_history") return { planId: request.planId, members: [], authorRoles: [], posts: [], nextAfter: null };
    if (command === "read_work_plan_team_recovery_state") {
      const recovery = teamRecoveryFixture().state;
      return { ...recovery, state: { ...recovery.state, planId: status.plan.planId, lease: status.lease, state: status.state, expiresAtMs: (BigInt(status.expiresAt) * 1000n).toString() } };
    }
    if (command === "read_work_plan_team_execution") return teamExecutionViewFixture();
    throw new Error(command);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function openTeam() {
  const user = userEvent.setup(); render(<Harness project={project}/>);
  await user.click(screen.getByRole("button", { name: "AI work" }));
  await screen.findByRole("checkbox", { name: "barrel: Synthetic original source" });
  act(() => { owner.setConfig(status.plan.preview!.config); owner.setOptions({ ...defaultPlanOptions,
    stages: defaultPlanOptions.stages.map(stage => stage.stage === "checks" ? { ...stage, mode: "manual" } : stage) }); });
  await user.click(screen.getByRole("checkbox", { name: "barrel: Synthetic original source" }));
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.team.enable") }));
  const first = within(screen.getByRole("group", { name: "Member 1" }));
  await user.type(first.getByRole("textbox", { name: "Member name" }), "Translator A");
  await user.type(first.getByRole("textbox", { name: "Role and responsibilities" }), "Translate and revisit original objections.");
  return user;
}

it("keeps dynamic dispatch independent of discussion sharing and shows actual narrowed defaults and initial work", async () => {
  const user = userEvent.setup(); render(<Harness project={project}/>);
  await user.click(screen.getByRole("button", { name: "AI work" }));
  const toggle = screen.getByRole("checkbox", { name: i18n.t("ai.team.enable") }); expect(toggle).not.toBeChecked();
  act(() => { owner.setConfig({ ...status.plan.preview!.config, maxRequests: 2, concurrency: 2 }); owner.setOptions({ ...owner.current().options, teamDiscussions: { profile: "current-plan-1" } }); });
  expect(toggle).not.toBeChecked(); await user.click(toggle);
  expect(screen.getByRole("spinbutton", { name: i18n.t("ai.team.maxActivations") })).toHaveValue(2);
  expect(screen.getByRole("spinbutton", { name: i18n.t("ai.team.maxConcurrency") })).toHaveValue(2);
  expect(screen.getByRole("spinbutton", { name: "Limit on completed work without confirmed progress" })).toHaveValue(2);
  expect(screen.getByText(i18n.t("ai.team.completionLimitHelp"))).toBeVisible();
  expect(screen.getByText(i18n.t("ai.team.initialHelp"))).toBeVisible();
  expect(calls("prepare_work_plan")).toHaveLength(0); expect(calls("authorize_work_plan")).toHaveLength(0);
});

it("invalidates all captured member material and consent when an independently selected member connection changes", async () => {
  const user = await openTeam();
  const completedLimit = screen.getByRole("spinbutton", { name: "Limit on completed work without confirmed progress" });
  expect(completedLimit).toHaveValue(3);
  await user.clear(completedLimit); await user.type(completedLimit, "8");
  expect(screen.getByRole("checkbox", { name: i18n.t("ai.discussions.enable") })).not.toBeChecked();
  expect(screen.getByText(i18n.t("ai.team.discussionRequired"))).toBeVisible();
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.discussions.enable") }));
  const member = within(screen.getByRole("group", { name: "Member 1" }));
  await member.findByRole("option", { name: "Synthetic Saved reviewer · Saved reviewer" });
  await user.selectOptions(member.getByRole("combobox", { name: "Member model connection" }), savedConfig.connectionProfile.profileId);
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  await screen.findByRole("region", { name: i18n.t("ai.team.capturedTitle") });
  expect(screen.getByText("Up to 12 total member activations; at most 1 active members; stop after 8 completed work items without confirmed progress.")).toBeVisible();
  const consent = screen.getByRole("checkbox", { name: i18n.t("ai.team.consent") }); expect(consent).not.toBeChecked(); await user.click(consent);
  connections.snapshot.revision = "2"; connections.basis.revision = "2"; connections.snapshot.profiles[0].revision = "2";
  connections.references[0].revision = "2"; connections.references[0].digest = "b".repeat(64);
  await user.click(member.getByRole("button", { name: "Read current connections" }));
  await waitFor(() => expect(owner.current().preparedPlan).toBeNull()); expect(owner.current().consent).toBe(false);
  expect(owner.current().teamDraft!.members[0].config.connectionProfile?.revision).toBe("1");
  expect(owner.current().teamDraft!.members[0].role).toBe("Translate and revisit original objections.");
  expect(calls("authorize_work_plan")).toHaveLength(0);
});

it("discards a late read-only preparation A without overwriting a newer team draft B", async () => {
  const user = await openTeam(); await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.discussions.enable") }));
  const original = invoke.getMockImplementation()!; let resolve!: (value: WorkPlanView) => void, capture: WorkPlanView | null = null;
  invoke.mockImplementation((command, payload) => command === "prepare_work_plan" ? new Promise(done => { capture = prepareFixture(payload.request); resolve = done; }) : original(command, payload));
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  await waitFor(() => expect(capture).not.toBeNull());
  act(() => { const draft = owner.current().teamDraft!; owner.setTeamDraft({ ...draft, members: draft.members.map(member => ({ ...member, displayName: "Newer B" })) }); });
  await act(async () => { resolve(capture!); });
  await waitFor(() => expect(owner.current().busy).toBe(false));
  expect(owner.current().preparedPlan).toBeNull(); expect(owner.current().teamDraft!.members[0].displayName).toBe("Newer B");
  expect(owner.current().consent).toBe(false); expect(calls("authorize_work_plan")).toHaveLength(0);
});

it.each(["en-US", "zh-CN"])("shows separately captured destination material and retained work/messages without promoting review or request consumption in %s", async locale => {
  await i18n.changeLanguage(locale); const user = userEvent.setup(), readPost = vi.fn(), openTask = vi.fn(async () => true);
  const rendered = render(<TeamExecutionDisclosure plan={status.plan}/>, project);
  expect(screen.getByText(i18n.t("ai.team.completionLimitHelp"))).toBeVisible();
  const second = within(screen.getByRole("region", { name: "Reviewer B" }));
  expect(second.getByText(/synthetic-review-model/)).toBeInTheDocument();
  expect(second.getByText(i18n.t("ai.terms-not-shared"))).toBeInTheDocument();
  expect(second.queryByText("Translator note 中文 👩🏽‍💻 é")).not.toBeInTheDocument();
  rendered.rerender(<TeamExecutionHistory context={teamContext} status={{ ...status, state: "paused" }} open onOpenTask={openTask} onReadPost={readPost}/>);
  await screen.findByText("Read the complete original objection before deciding.");
  expect(screen.getByText(i18n.t("ai.team.verdicts.revise"))).toBeVisible();
  expect(screen.getByText(i18n.t("ai.team.validation.valid"))).toBeVisible();
  expect(screen.getByText(i18n.t("ai.team.requestedBy", { member: "Translator A" }))).toBeVisible();
  expect(screen.getByText(i18n.t("ai.team.included", { count: 1 }))).toBeVisible();
  expect(screen.getByText(i18n.t("ai.team.stops.needs-reconciliation"))).toBeVisible();
  const original = invoke.getMockImplementation()!, stopped = teamExecutionViewFixture(); stopped.stopReason = "no-progress";
  invoke.mockImplementation((command, payload) => command === "read_work_plan_team_execution" ? structuredClone(stopped) : original(command, payload));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.team.refresh") }));
  expect(await screen.findByText(i18n.t("ai.team.stops.no-progress"))).toBeVisible();
  await user.click(screen.getAllByRole("button", { name: i18n.t("ai.team.readReason") })[0]); expect(readPost).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: i18n.t("ai.team.openTask") }));
  expect(openTask).toHaveBeenCalledWith(teamExecutionViewFixture().works[0].receipt.taskId, teamExecutionViewFixture().works[0].receipt.attemptId);
  expect(calls("read_ai_translation")).toHaveLength(0); expect(calls("start_work_plan")).toHaveLength(0);
});

it.each(["invalid", "pending", "absent"] as const)("keeps a succeeded execution with %s validation readable without claiming an accepted result", async validation => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "read_work_plan_team_execution" ? teamExecutionViewFixture(validation) : original(command, payload));
  render(<TeamExecutionHistory context={teamContext} status={status} open onReadPost={() => {}}/>, project);
  expect(await screen.findByText(i18n.t(`ai.team.validation.${validation}`))).toBeVisible();
  expect(screen.getByText("Read the complete original objection before deciding.")).toBeVisible();
  expect(screen.queryByText(i18n.t("ai.team.verdicts.revise"))).not.toBeInTheDocument();
  expect(screen.queryByText(i18n.t("ai.team.candidateSaved"))).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("routes a started team to original team facts and allows explicit preparation after pause without offering legacy Continue", async () => {
  const user = await openTeam();
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.discussions.enable") }));
  status.state = "paused";
  act(() => { owner.recordPlanStart(status.plan.attemptId!, status.plan.planId, status.plan, status.lease.generation, owner.current().editSeq); });
  await screen.findByText("Read the complete original objection before deciding.");
  expect(await screen.findByText(i18n.t("ai.recovery.available"))).toBeVisible();
  expect(screen.queryByRole("button", { name: i18n.t("ai.plan.continue") })).not.toBeInTheDocument();
  expect(calls("read_ai_translation")).toHaveLength(0);
  expect(screen.getByRole("combobox", { name: i18n.t("ai.team.initial") })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  await waitFor(() => expect(owner.current().preparedPlan?.options.teamExecution).toBeDefined());
  expect(owner.current().startedPlan).toBeNull(); expect(owner.current().consent).toBe(false);
  expect(calls("authorize_work_plan")).toHaveLength(0); expect(calls("start_work_plan")).toHaveLength(0);
});

it("keeps discussion-only team consent separate from an explicitly selected referenced-text profile", async () => {
  const user = await openTeam(); await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.discussions.enable") }));
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  const consent = await screen.findByRole("checkbox", { name: i18n.t("ai.team.consent") });
  expect(screen.queryByText(i18n.t("ai.team.artifactCostUnknown"))).not.toBeInTheDocument();
  await user.click(consent);
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.discussions.enableArtifacts") }));
  expect(owner.current().preparedPlan).toBeNull(); expect(owner.current().consent).toBe(false);
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  expect(await screen.findByRole("checkbox", { name: i18n.t("ai.team.artifactConsent") })).not.toBeChecked();
  expect(screen.queryByRole("checkbox", { name: i18n.t("ai.team.consent") })).not.toBeInTheDocument();
});

it("releases only the preparation lock when a team's original permission expires while idle", async () => {
  await openTeam();
  const now = Date.now(); vi.useFakeTimers(); vi.setSystemTime(now);
  status.expiresAt = String(Math.floor(now / 1000) + 1);
  act(() => { owner.recordPlanStart(status.plan.attemptId!, status.plan.planId, status.plan, status.lease.generation, owner.current().editSeq); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole("combobox", { name: i18n.t("ai.team.initial") })).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(screen.getByRole("combobox", { name: i18n.t("ai.team.initial") })).toBeEnabled();
  expect(screen.getByText(i18n.t("ai.team.reprepare"))).toBeVisible();
  expect(calls("authorize_work_plan")).toHaveLength(0); expect(calls("start_work_plan")).toHaveLength(0);
  expect(calls("read_ai_translation")).toHaveLength(0);
});

it("rejects a changed member preview or team read identity at the typed IPC boundary", async () => {
  const request = { ...teamContext, config: status.plan.preview!.config, locale: status.plan.locale, unitIds: status.plan.scope.map(unit => unit.unitId),
    options: status.plan.options, advisoryChecks: [], maintenance: null, toolSelection: null };
  invoke.mockResolvedValueOnce({ ...status.plan, memberPreviews: status.plan.memberPreviews!.slice(0, 1) });
  await expect(workPlanCommands.prepare(request)).rejects.toMatchObject({ outcome: "unknown", reason: "invalid-work-plan-acknowledgement" });
  invoke.mockResolvedValueOnce({ ...teamExecutionViewFixture(), planId: fixtureIdentity(9499) });
  await expect(workPlanCommands.teamExecution({ ...teamContext, planId: status.plan.planId, afterWork: null, afterMessage: null, limit: 16 })).rejects.toMatchObject({ outcome: "unknown" });
  const changedRecipient = teamExecutionViewFixture();
  changedRecipient.works[0].request!.recipientMemberId = changedRecipient.works[0].author!.memberId;
  invoke.mockResolvedValueOnce(changedRecipient);
  await expect(workPlanCommands.teamExecution({ ...teamContext, planId: status.plan.planId, afterWork: null, afterMessage: null, limit: 16 })).rejects.toMatchObject({ outcome: "unknown" });
});
