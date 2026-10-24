import { createRef, useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshWorkbenchReads, renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import { AiWorkbench, type AiHandle } from "./AiWorkbench";
import { TeamExecutionHistory } from "./TeamExecutionHistory";
import { teamGuidanceFixture, humanTeamMessageFixture } from "./testSupport/teamGuidanceFixture";
import { teamContext } from "./testSupport/teamDiscussionFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { connectionFixture } from "./testSupport/connectionFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { sourceKeys } from "./sourceQueries";
import { teamRecoveryFixture } from "./testSupport/teamRecoveryFixture";
import { workPlanCommands, type TeamExecutionView, type WorkPlanStatusView } from "./workPlanCommands";
import { executionContext, type SessionRequest } from "./executionCommands";
import type { WorkPlanTeamMessageRequest } from "./generated/ai.requests";
import type { TeamMessage } from "./generated/ai.responses";
import type { CommandError, ProjectView } from "./projectCommands";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: teamContext.sessionToken, locator: "synthetic-guidance", reconciliationState: "settled",
  metadata: { projectId: teamContext.projectId, displayName: "Synthetic directed guidance", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let source: ReturnType<typeof teamGuidanceFixture>, owner: ReturnType<typeof useAiPreparation>;
function Probe() { const value = useAiPreparation(); useLayoutEffect(() => { owner = value; }); return null; }
function Consumer({ status, writable, context }: { status: WorkPlanStatusView; writable: boolean; context: SessionRequest }) {
  const session = useAiPreparation();
  return <TeamExecutionHistory context={context} status={status} open guidance={session.guidance} guidanceWritable={writable} onReadPost={() => {}}/>;
}
function Harness({ value = source.status, mounted = true, writable = true, project: current = project }: {
  value?: WorkPlanStatusView; mounted?: boolean; writable?: boolean; project?: ProjectView;
}) {
  return <AiPreparationSession initialLocale="zh-CN" targetLocales={current.metadata.targetLocales}><Probe/>
    {mounted ? <Consumer status={value} writable={writable} context={executionContext(current)}/> : null}</AiPreparationSession>;
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
const form = () => within(screen.getByRole("region", { name: i18n.t("ai.guidance.title") }));
const rejected = (reason: string): CommandError => ({ code: "cancelled", stage: "execution-recover", outcome: "rejected", recoveryRequired: false, reason });
async function draft(body = "Guidance A") {
  const user = userEvent.setup(), fields = form(), recipient = source.view.roster[1], target = source.status.plan.scope[0];
  if (!recipient || !target) throw new Error("Expected the captured reviewer and entry");
  await user.selectOptions(fields.getByRole("combobox", { name: i18n.t("ai.guidance.recipient") }), recipient.memberId);
  await user.selectOptions(fields.getByRole("combobox", { name: i18n.t("ai.guidance.target") }), target.unitId);
  await user.type(fields.getByRole("textbox", { name: i18n.t("ai.guidance.body") }), body);
  return user;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); source = teamGuidanceFixture(); let identity = 15000;
  invoke.mockReset().mockImplementation(async (command, payload) => {
    if (command === "read_context_strategy_default") return null;
    if (command === "read_model_connections") return connectionFixture([]);
    if (command === "read_plugin_text_reviews") return { settingsRevision: "1", entries: [] };
    if (command === "read_work_plan_status") return structuredClone(source.status);
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: source.status.plan.scope[0].sourceSnapshotId };
    if (command === "read_source_content") { const unit = source.status.plan.scope[0]; return sourcePageFixture({ snapshotId: unit.sourceSnapshotId,
      scope: { revision: "1", currentSnapshot: unit.sourceSnapshotId }, rows: [sourceRowFixture({ unitId: unit.unitId, sourceRevisionId: unit.sourceRevisionId }, { key: unit.nativeKey, text: "Synthetic guidance source" })] }); }
    if (command === "read_work_plan_team_history") return { planId: source.status.plan.planId, members: [], authorRoles: [], posts: [], nextAfter: null };
    if (command === "read_work_plan_team_recovery_state") { const value = teamRecoveryFixture().state; return { ...value, state: { ...value.state,
      state: source.status.state, lease: source.status.lease, effectiveVersion: source.view.effectiveVersion } }; }
    if (command === "read_work_plan_team_execution") return structuredClone(source.view);
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "send_work_plan_team_message") { const value = humanTeamMessageFixture(payload.request); source.view.messages.push(value); return value; }
    if (command === "read_work_plan_team_message_action") return null;
    throw new Error(command);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(["en-US", "zh-CN"])("discloses the current recipient and shares only explicit guidance without claiming request inclusion in %s", async locale => {
  await i18n.changeLanguage(locale); render(<Harness project={project}/>);
  await screen.findByText("Read the complete original objection before deciding.");
  const user = await draft("<script>Keep this complete human guidance 中文 👩🏽‍💻</script>");
  expect(form().getByText(i18n.t("ai.discussions.destination", { endpoint: source.view.roster[1].config.endpoint, model: source.view.roster[1].config.model }))).toBeVisible();
  expect(form().getByText("Read original reasons and challenge incomplete evidence.")).toBeVisible();
  await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.send") }));
  expect(await screen.findByText(i18n.t("ai.guidance.recorded"))).toBeVisible();
  expect(calls("send_work_plan_team_message")).toHaveLength(1);
  const request = calls("send_work_plan_team_message")[0][1].request;
  expect(request.message).toEqual({ messageId: fixtureIdentity(15000), recipientMemberId: source.view.roster[1].memberId,
    expectedRecipientRoleVersionId: source.view.roster[1].roleVersionId, target: source.view.works[0].target,
    body: "<script>Keep this complete human guidance 中文 👩🏽‍💻</script>" });
  expect(request.lease).toEqual(source.status.lease);
  expect(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") })).toHaveValue("");
  expect(document.querySelector("script")).toBeNull();
  expect(await screen.findByRole("heading", { name: `${i18n.t("ai.teamHistory.localUser")} → Reviewer B` })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Translator A → Reviewer B" })).toBeVisible();
  expect(screen.getByText(i18n.t("ai.team.addressed"))).toBeVisible();
  for (const command of ["start_work_plan", "prepare_work_plan", "generate_ai_translation"]) expect(calls(command)).toHaveLength(0);
});

it("keeps unknown A and newer B across pane and active-plan switches without admitting a second guidance request", async () => {
  const pending = deferred<TeamMessage>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "send_work_plan_team_message" ? pending.promise : original(command, payload));
  const ui = render(<Harness project={project}/>); await screen.findByText("Read the complete original objection before deciding.");
  const user = await draft(); await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.send") }));
  await waitFor(() => expect(calls("send_work_plan_team_message")).toHaveLength(1));
  const request = structuredClone(calls("send_work_plan_team_message")[0][1].request);
  await user.clear(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") }));
  await user.type(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") }), "Newer draft B");
  ui.rerender(<Harness project={project} mounted={false}/>);
  await act(async () => { pending.reject(new Error("Synthetic lost acknowledgement")); });
  expect(owner.guidance.current(source.status.plan.planId).pending?.request).toEqual(request);
  const other = { ...source.status, plan: { ...source.status.plan, planId: fixtureIdentity(15050) }, lease: { ...source.status.lease, planId: fixtureIdentity(15050) } };
  const otherView: TeamExecutionView = { ...structuredClone(source.view), planId: other.plan.planId,
    effectiveVersion: { ...source.view.effectiveVersion, lease: other.lease },
    members: source.view.members.map(value => ({ ...value, planId: other.plan.planId })),
    roleVersions: source.view.roleVersions.map(value => ({ ...value, planId: other.plan.planId })), works: [], messages: [], consumptions: [] };
  invoke.mockImplementation((command, payload) => {
    if (command === "read_work_plan_team_execution" && payload.request.planId === other.plan.planId) return structuredClone(otherView);
    return original(command, payload);
  });
  ui.rerender(<Harness project={project} value={other}/>);
  expect(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") })).toHaveValue("");
  await screen.findByText(i18n.t("ai.team.noWork"));
  await draft("Other plan input");
  expect(form().getByRole("button", { name: i18n.t("ai.guidance.send") })).toBeDisabled();
  await act(async () => { await owner.guidance.send(other, otherView, true,
    owner.guidance.current(other.plan.planId).draft.editSeq); });
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("send_work_plan_team_message")).toHaveLength(1);
  ui.rerender(<Harness project={project} value={{ ...source.status, state: "stopped", lease: { ...source.status.lease, generation: "2" } }} writable={false}/>);
  expect(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") })).toHaveValue("Newer draft B");
  invoke.mockImplementation((command, payload) => command === "read_work_plan_team_message_action" ? humanTeamMessageFixture(request) : original(command, payload));
  await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.check") }));
  expect(await screen.findByText(i18n.t("ai.guidance.newer"))).toBeVisible();
  expect(calls("read_work_plan_team_message_action").at(-1)?.[1].request).toEqual(request);
  expect(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") })).toHaveValue("Newer draft B");
  expect(owner.guidance.blocked()).toBe(false); expect(calls("send_work_plan_team_message")).toHaveLength(1);
});

it("keeps null, failed lookups and generic retry rejections unknown and retries only the same message identity", async () => {
  const original = invoke.getMockImplementation()!; let writes = 0, reads = 0;
  invoke.mockImplementation((command, payload) => {
    if (command === "send_work_plan_team_message" && ++writes === 1) throw new Error("Synthetic lost reply");
    if (command === "send_work_plan_team_message" && writes === 2) throw rejected("work-plan-control");
    if (command === "read_work_plan_team_message_action" && ++reads === 1) throw new Error("Synthetic read failure");
    return original(command, payload);
  });
  render(<Harness project={project}/>); await screen.findByText("Read the complete original objection before deciding.");
  const user = await draft(); await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.send") }));
  await screen.findByText(i18n.t("ai.guidance.unknown"));
  await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.check") }));
  await waitFor(() => expect(form().getByRole("alert")).toHaveFocus());
  expect(form().getByRole("button", { name: i18n.t("ai.guidance.retry") })).toBeDisabled();
  await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.check") }));
  await screen.findByText(i18n.t("ai.guidance.absent"));
  expect(owner.guidance.blocked()).toBe(true); expect(owner.reset()).toBe(false);
  await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.retry") }));
  await waitFor(() => expect(form().getByRole("alert")).toHaveFocus());
  expect(owner.guidance.current(source.status.plan.planId).pending?.phase).toBe("unknown");
  await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.check") }));
  await screen.findByText(i18n.t("ai.guidance.absent"));
  await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.retry") }));
  await screen.findByText(i18n.t("ai.guidance.recorded"));
  const sent = calls("send_work_plan_team_message"); expect(sent).toHaveLength(3);
  expect(sent.slice(1).map(([, payload]) => payload.request)).toEqual([sent[0][1].request, sent[0][1].request]);
  expect(calls("create_execution_identity")).toHaveLength(1);
});

it("keeps B on actual AI exit and reconciles an uncertain Stop before same-ID guidance retry confirms the original lease is closed", async () => {
  const original = invoke.getMockImplementation()!, handle = createRef<AiHandle>(), user = userEvent.setup(); let writes = 0, controlReads = 0;
  invoke.mockImplementation((command, payload) => {
    if (command === "send_work_plan_team_message") {
      if (++writes === 1) throw new Error("Synthetic lost acknowledgement");
      throw rejected("team-human-message-lease-closed");
    }
    if (command === "control_work_plan") {
      const request = payload.request;
      source.status = { ...source.status, state: "stopped", lease: { ...source.status.lease, generation: (BigInt(request.expectedGeneration) + 1n).toString() } };
      source.view.effectiveVersion.lease = source.status.lease;
      throw new Error("Synthetic lost Stop acknowledgement");
    }
    if (command === "read_work_plan_control_action") {
      if (++controlReads === 1) throw new Error("Synthetic failed first Stop lookup");
      const request = payload.request;
      return { projectId: request.projectId, request: { kind: "control", planId: request.planId, actionId: request.actionId,
        expectedGeneration: request.expectedGeneration, command: request.command, confirmed: request.confirmed, expiresAt: request.expiresAt ?? null },
        receipt: { actionId: request.actionId, attemptId: null, lease: source.status.lease, parentTask: null, state: "stopped" } };
    }
    return original(command, payload);
  });
  render(<AiPreparationSession initialLocale="zh-CN" targetLocales={project.metadata.targetLocales}><Probe/>
    <AiWorkbench project={project} disabled={false} ref={handle} onOpenTranslation={async () => false}/>
  </AiPreparationSession>, project);
  await user.click(screen.getByRole("button", { name: "AI work" }));
  await act(async () => { owner.recordPlan(source.status.plan.planId); });
  await screen.findByText("Read the complete original objection before deciding.");
  await draft(); await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.send") }));
  await screen.findByText(i18n.t("ai.guidance.unknown"));
  const request = structuredClone(calls("send_work_plan_team_message")[0][1].request);
  await user.clear(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") }));
  await user.type(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") }), "Retained new B");
  await act(async () => { owner.recordPlan(fixtureIdentity(15100)); });
  let allowed = true; await act(async () => { allowed = await handle.current!.allowLeave(); });
  expect(allowed).toBe(false); expect(owner.current().planId).toBe(request.lease.planId);
  const stop = await screen.findByRole("button", { name: i18n.t("ai.plan.stop") });
  await waitFor(() => expect(stop).toBeEnabled()); await user.click(stop);
  await waitFor(() => expect(calls("control_work_plan")).toHaveLength(1));
  await waitFor(() => expect(owner.current().busy).toBe(false));
  expect(owner.guidance.current(request.lease.planId).pending?.request).toEqual(request);
  expect(owner.planControl.current().pending?.kind).toBe("control");
  const controls = within(screen.getByRole("region", { name: i18n.t("ai.plan.controls") }));
  await user.click(controls.getByRole("button", { name: i18n.t("ai.reconcile") }));
  await waitFor(() => expect(owner.planControl.current().pending).toBeNull());
  expect(calls("read_work_plan_control_action")).toHaveLength(2);
  expect(calls("read_work_plan_control_action").at(-1)?.[1].request).toEqual(calls("control_work_plan")[0][1].request);
  await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.check") }));
  await screen.findByText(i18n.t("ai.guidance.absent"));
  expect(owner.guidance.blocked()).toBe(true);
  await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.retry") }));
  await screen.findByText(i18n.t("ai.guidance.closed"));
  expect(owner.guidance.blocked()).toBe(false);
  expect(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") })).toHaveValue("Retained new B");
  expect(calls("send_work_plan_team_message").map(([, payload]) => payload.request)).toEqual([request, request]);
  expect(form().getByRole("button", { name: i18n.t("ai.guidance.send") })).toBeDisabled();
  let leaving!: Promise<boolean>; await act(async () => { leaving = handle.current!.allowLeave(); });
  const dialog = await screen.findByRole("dialog", { name: i18n.t("ai.unsaved") });
  expect(within(dialog).getByText(i18n.t("ai.unsavedDescription"))).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: i18n.t("ai.stay") })); expect(await leaving).toBe(false);
  expect(calls("start_work_plan")).toHaveLength(0);
});

it("rechecks fresh roster scope and destination while preserving input through a pending team read", async () => {
  const original = invoke.getMockImplementation()!, refreshed = deferred<TeamExecutionView>();
  render(<Harness project={project}/>); await screen.findByText("Read the complete original objection before deciding.");
  const user = await draft();
  const readsBefore = calls("read_work_plan_team_execution").length;
  invoke.mockImplementation((command, payload) => command === "read_work_plan_team_execution" ? refreshed.promise : original(command, payload));
  await refreshWorkbenchReads();
  await waitFor(() => expect(calls("read_work_plan_team_execution")).toHaveLength(readsBefore + 1));
  await waitFor(() => expect(form().getByRole("button", { name: i18n.t("ai.guidance.send") })).toBeDisabled());
  const recipient = source.view.roster[1], role = source.view.members[1];
  if (!recipient || !role) throw new Error("Expected current reviewer");
  recipient.config.model = "changed-review-destination"; recipient.roleVersionId = fixtureIdentity(15105);
  role.config.model = recipient.config.model; role.request.roleVersionId = recipient.roleVersionId;
  source.view.roleVersions.push(structuredClone(role));
  await act(async () => { refreshed.resolve(structuredClone(source.view)); });
  expect(await form().findByText(i18n.t("ai.discussions.destination", { endpoint: recipient.config.endpoint, model: recipient.config.model }))).toBeVisible();
  expect(screen.getByRole("heading", { name: "Translator A → Reviewer B" })).toBeVisible();
  source.view.roster = source.view.roster.filter(member => member.memberId !== recipient.memberId);
  source.view.members = source.view.members.filter(member => member.request.memberId !== recipient.memberId);
  source.view.retiredMemberIds.push(recipient.memberId);
  invoke.mockImplementation(original); await refreshWorkbenchReads();
  await form().findByText(i18n.t("ai.guidance.previousRecipient"));
  expect(form().getByText(i18n.t("ai.guidance.previousTarget"))).toBeVisible();
  expect(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") })).toHaveValue("Guidance A");
  expect(form().getByRole("button", { name: i18n.t("ai.guidance.send") })).toBeDisabled();
  expect(calls("send_work_plan_team_message")).toHaveLength(0);
  await user.tab();
});

it("blocks new sends at closed request limits while allowing guidance to an active loop at the activation ceiling", async () => {
  render(<Harness project={project}/>); await screen.findByText("Read the complete original objection before deciding.");
  await draft();
  for (const reason of ["activation-limit", "no-progress", "expired", "budget-exhausted", "needs-reconciliation"] as const) {
    source.view.stopReason = reason; await refreshWorkbenchReads();
    await waitFor(() => expect(form().getByRole("button", { name: i18n.t("ai.guidance.send") })).toHaveProperty("disabled", reason !== "activation-limit"));
  }
  expect(calls("send_work_plan_team_message")).toHaveLength(0);
});

it("isolates a new project session from the old guidance owner and its late acknowledgement", async () => {
  const original = invoke.getMockImplementation()!, pending = deferred<TeamMessage>();
  invoke.mockImplementation((command, payload) => command === "send_work_plan_team_message" ? pending.promise : original(command, payload));
  const ui = render(<Harness project={project}/>); await screen.findByText("Read the complete original objection before deciding.");
  const user = await draft(); await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.send") }));
  await waitFor(() => expect(calls("send_work_plan_team_message")).toHaveLength(1));
  const oldOwner = owner, request = structuredClone(calls("send_work_plan_team_message")[0][1].request);
  const nextProject = { ...project, sessionToken: fixtureIdentity(15110), metadata: { ...project.metadata, projectId: fixtureIdentity(15111) } };
  ui.rerender(<Harness project={nextProject}/>);
  await waitFor(() => expect(owner).not.toBe(oldOwner));
  expect(owner.guidance.blocked()).toBe(false);
  expect(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") })).toHaveValue("");
  await user.type(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") }), "Other project draft");
  await act(async () => { pending.resolve(humanTeamMessageFixture(request)); });
  expect(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") })).toHaveValue("Other project draft");
  expect(form().queryByText(i18n.t("ai.guidance.recorded"))).not.toBeInTheDocument();
  expect(calls("send_work_plan_team_message")).toHaveLength(1);
});

it("uses the Core message byte limit and rejects stale recipient facts without retargeting the draft", async () => {
  source.view.messageLimits.maxBodyBytes = 8;
  const ui = render(<Harness project={project}/>); await screen.findByText("Read the complete original objection before deciding.");
  const user = await draft("界界界");
  expect(form().getByRole("button", { name: i18n.t("ai.guidance.send") })).toBeDisabled();
  expect(form().getByText(i18n.t("ai.guidance.tooLarge"))).toBeVisible();
  await user.clear(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") }));
  await user.type(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") }), "界界");
  expect(form().getByRole("button", { name: i18n.t("ai.guidance.send") })).toBeEnabled();
  ui.rerender(<Harness project={project} writable={false}/>);
  expect(form().getByRole("button", { name: i18n.t("ai.guidance.send") })).toBeDisabled();
  expect(form().getByRole("textbox", { name: i18n.t("ai.guidance.body") })).toHaveValue("界界");
  expect(calls("send_work_plan_team_message")).toHaveLength(0);
});

it("reserves other AI mutations for unknown guidance and refuses guidance during an existing authorization", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "send_work_plan_team_message" ? Promise.reject(new Error("Synthetic unknown")) : original(command, payload));
  render(<Harness project={project}/>); await screen.findByText("Read the complete original objection before deciding.");
  const user = await draft();
  const blocker = { kind: "start" as const, request: { ...teamContext, planId: source.status.plan.planId, actionId: fixtureIdentity(15080), expectedGeneration: source.status.lease.generation },
    prepared: source.status.plan, attemptId: source.status.plan.attemptId!, editSeq: 0, uncertain: true, retryAllowed: false, checking: false, failure: null, receipt: null };
  act(() => { owner.planControl.update(before => ({ ...before, pending: blocker })); });
  expect(form().getByRole("button", { name: i18n.t("ai.guidance.send") })).toBeDisabled();
  act(() => { owner.planControl.update(before => ({ ...before, pending: null })); });
  await user.click(form().getByRole("button", { name: i18n.t("ai.guidance.send") }));
  await screen.findByText(i18n.t("ai.guidance.unknown"));
  expect(owner.reserved()).toBe(true); expect(owner.guidance.discard()).toBe(false);
  const unit = source.status.plan.scope[0], mutation = vi.fn(async () => {});
  await act(async () => { await owner.runWorkPlan(mutation, source.status.plan.planId,
    sourceKeys.content(unit.sourceSnapshotId, 0, { revision: "1", currentSnapshot: unit.sourceSnapshotId })); });
  expect(mutation).not.toHaveBeenCalled(); expect(owner.canPreview()).toBe(false);
});

it("rejects a changed author, recipient role, target, body or references in both exact message ACK paths", async () => {
  const member = source.view.roster[1], work = source.view.works[0];
  if (!member || !work) throw new Error("Expected captured guidance target");
  const request: WorkPlanTeamMessageRequest = { ...teamContext, lease: source.status.lease, message: { messageId: fixtureIdentity(15090),
    recipientMemberId: member.memberId, expectedRecipientRoleVersionId: member.roleVersionId, target: work.target, body: "Exact guidance" } };
  const valid = humanTeamMessageFixture(request);
  if (valid.sender.kind !== "human") throw new Error("Expected the trusted human author");
  for (const value of [{ ...valid, body: "Changed" }, { ...valid, recipientRoleVersionId: fixtureIdentity(15091) },
    { ...valid, target: { ...valid.target, unitId: fixtureIdentity(15092) } }, { ...valid, postIds: [fixtureIdentity(15093)] },
    { ...valid, causeMessageId: fixtureIdentity(15094) }, { ...valid, messageId: fixtureIdentity(15095) },
    { ...valid, sender: { ...valid.sender, actor: "someone-else" } },
    { ...valid, sender: { ...valid.sender, binding: { ...valid.sender.binding, lease: { ...valid.sender.binding.lease, generation: "99" } } } }]) {
    invoke.mockResolvedValueOnce(value);
    await expect(workPlanCommands.sendTeamMessage(request)).rejects.toMatchObject({ outcome: "unknown" });
    invoke.mockResolvedValueOnce(value);
    await expect(workPlanCommands.teamMessageAction(request)).rejects.toMatchObject({ outcome: "unknown" });
  }
});
