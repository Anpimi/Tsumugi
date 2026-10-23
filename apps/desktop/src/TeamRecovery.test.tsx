import { createRef, useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import { AiWorkbench, type AiHandle } from "./AiWorkbench";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { connectionFixture } from "./testSupport/connectionFixture";
import { TeamRecoveryControls } from "./TeamRecoveryControls";
import { TeamExecutionHistory } from "./TeamExecutionHistory";
import { teamRecoveryFixture, teamRecoveryPreviewFixture, teamRecoveryReceiptFixture } from "./testSupport/teamRecoveryFixture";
import { teamDiscussionLimitsForFixture } from "./testSupport/aiFixture";
import { teamContext } from "./testSupport/teamDiscussionFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";
import * as validators from "./generated/ai.validators";
import type { WorkPlanTeamRecoveryPrepareRequest, WorkPlanTeamRecoveryAuthorizeRequest } from "./generated/ai.requests";
import type { WorkPlanTeamRecoveryPreviewView, TeamRecoveryReceipt } from "./generated/ai.responses";
import type { ProjectView } from "./projectCommands";
import { workPlanCommands } from "./workPlanCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: teamContext.sessionToken, locator: "synthetic-recovery", reconciliationState: "settled",
  metadata: { projectId: teamContext.projectId, displayName: "Synthetic recovery", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let source: ReturnType<typeof teamRecoveryFixture>, owner: ReturnType<typeof useAiPreparation>;
let preview: WorkPlanTeamRecoveryPreviewView | null, authorization: WorkPlanTeamRecoveryAuthorizeRequest | null, receipt: TeamRecoveryReceipt | null;
const openTask = vi.fn(async () => true);
function Probe() { const value = useAiPreparation(); useLayoutEffect(() => { owner = value; }); return null; }
function Consumer({ mounted }: { mounted: boolean }) {
  const preparation = useAiPreparation();
  return mounted ? <TeamRecoveryControls context={teamContext} status={source.status} open disabled={false} session={preparation.recovery} onPlan={preparation.recordPlan} onOpenTask={openTask}/> : null;
}
function Harness({ mounted = true }: { mounted?: boolean }) {
  return <AiPreparationSession initialLocale="zh-CN" targetLocales={project.metadata.targetLocales}><Probe/><Consumer mounted={mounted}/></AiPreparationSession>;
}
const calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); source = teamRecoveryFixture(); preview = null; authorization = null; receipt = null; openTask.mockClear(); let identity = 9700;
  invoke.mockReset().mockImplementation(async (command, payload) => {
    const request = payload?.request;
    if (command === "read_context_strategy_default") return null;
    if (command === "read_model_connections") return connectionFixture([]);
    if (command === "read_plugin_text_reviews") return { settingsRevision: "1", entries: [] };
    if (command === "read_work_plan_status") return structuredClone(source.status);
    const unit = source.status.plan.scope[0];
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: unit.sourceSnapshotId };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: unit.sourceSnapshotId, scope: { revision: "1", currentSnapshot: unit.sourceSnapshotId },
      rows: [sourceRowFixture({ unitId: unit.unitId, sourceRevisionId: unit.sourceRevisionId }, { key: unit.nativeKey, text: "Synthetic recovery source" })] });
    if (command === "read_work_plan_team_recovery_state") return structuredClone(source.state);
    if (command === "read_work_plan_team_execution") return structuredClone(source.view);
    if (command === "read_work_plan_team_history") return { planId: source.status.plan.planId, members: [], authorRoles: [], posts: [], nextAfter: null };
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "prepare_work_plan_team_recovery" && validators.validateRequestWorkPlanTeamRecoveryPrepare(request)) {
      preview = teamRecoveryPreviewFixture(request, source); return structuredClone(preview);
    }
    if (command === "authorize_work_plan_team_recovery" && validators.validateRequestWorkPlanTeamRecoveryAuthorize(request) && preview) {
      authorization = structuredClone(request); receipt = teamRecoveryReceiptFixture(request, preview);
      source.state.state = { ...source.state.state, state: "active", lease: receipt.effectiveVersion.lease, effectiveVersion: receipt.effectiveVersion };
      source.status = { ...source.status, state: "active", lease: receipt.effectiveVersion.lease };
      source.view = { ...source.view, effectiveVersion: receipt.effectiveVersion };
      return structuredClone(receipt);
    }
    if (command === "read_work_plan_team_recovery_action") {
      if (!receipt || !authorization) return null;
      const { sessionToken: _session, projectId: _project, preparationId: _preparation, ...recorded } = authorization;
      return { projectId: teamContext.projectId, request: recorded, receipt: structuredClone(receipt) };
    }
    if (command === "end_work_plan_team_recovery" && validators.validateRequestWorkPlanTeamRecoveryAuthorize(request)) {
      const { sessionToken: _session, projectId: _project, preparationId: _preparation, ...recorded } = request;
      return receipt && authorization ? { kind: "authorization-recorded", action: { projectId: teamContext.projectId, request: recorded, receipt: structuredClone(receipt) } }
        : { kind: "preparation-closed", projectId: teamContext.projectId, preparationId: request.preparationId, request: recorded };
    }
    if (command === "start_work_plan" && receipt) return receipt.attemptId;
    if (command === "read_work_plan_start_action" && receipt) return { planId: request.planId, actionId: request.actionId, expectedGeneration: request.expectedGeneration, projectId: teamContext.projectId, taskId: receipt.taskId, attemptId: receipt.attemptId };
    throw new Error(command);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function editing() {
  const user = userEvent.setup();
  const begin = await screen.findByRole("button", { name: i18n.t("ai.recovery.edit") });
  await waitFor(() => expect(begin).toBeEnabled()); await user.click(begin);
  await user.type(screen.getByRole("textbox", { name: i18n.t("ai.recovery.instructions") }), "Human A: revisit the original rejected claim.");
  return user;
}
async function prepare() {
  const user = await editing();
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.prepare") }));
  await screen.findByRole("region", { name: i18n.t("ai.recovery.previewTitle") });
  return user;
}

function exhaustRecoveryCapacity(limit: "activations" | "completions" | "budget") {
  const limits = source.status.plan.options.teamExecution!.limits;
  if (limit === "activations") source.state.state.activations = limits.maxActivations;
  else if (limit === "completions") {
    source.state.state.activations = limits.maxNoProgress;
    source.state.state.unconfirmedCompletions = limits.maxNoProgress;
  } else {
    source.state.state.budget.dispatched = source.state.state.budget.limit - 1;
    source.state.state.budget.legacyHeld = 1;
    source.view.budget = structuredClone(source.state.state.budget);
  }
}
it.each((["en-US", "zh-CN"] as const).flatMap(locale =>
  (["activations", "completions", "budget"] as const).map(limit => [locale, limit] as const)))
  ("blocks cumulative recovery capacity at the %s %s ceiling while preserving history", async (locale, limit) => {
    await i18n.changeLanguage(locale); exhaustRecoveryCapacity(limit);
    expect(validators.validateResponseWorkPlanTeamRecoveryState(source.state)).toBe(true);
    render(<Harness/>, project);
    const begin = await screen.findByRole("button", { name: i18n.t("ai.recovery.edit") });
    await waitFor(() => expect(begin).toBeDisabled());
    expect(await screen.findByText(i18n.t("ai.recovery.exhausted"))).toBeVisible();
    expect(screen.queryByText(i18n.t("ai.recovery.available"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("ai.recovery.draining"))).not.toBeInTheDocument();
    await userEvent.setup().click(begin);
    expect(owner.recovery.current().draft).toBeNull();
    expect(calls("prepare_work_plan_team_recovery")).toHaveLength(0);
    expect(calls("authorize_work_plan_team_recovery")).toHaveLength(0);
  });
it("blocks cumulative recovery capacity before preparing an existing draft without clearing its input", async () => {
  render(<Harness/>, project); const user = await editing();
  expect(screen.getByRole("button", { name: i18n.t("ai.recovery.prepare") })).toBeEnabled();
  exhaustRecoveryCapacity("budget");
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.refresh") }));
  expect(await screen.findByText(i18n.t("ai.recovery.exhausted"))).toBeVisible();
  const button = screen.getByRole("button", { name: i18n.t("ai.recovery.prepare") }); expect(button).toBeDisabled();
  await user.click(button);
  await act(async () => { await owner.recovery.prepare(source.status.plan, source.view, source.state, source.status.effects); });
  expect(calls("prepare_work_plan_team_recovery")).toHaveLength(0);
  expect(screen.getByRole("textbox", { name: i18n.t("ai.recovery.instructions") })).toHaveValue("Human A: revisit the original rejected claim.");
});
it("keeps receipt-first unknown recovery available after cumulative recovery capacity is exhausted", async () => {
  render(<Harness/>, project); const user = await prepare(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "authorize_work_plan_team_recovery"
    ? Promise.reject({ outcome: "unknown" }) : original(command, payload));
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.recovery.consent") }));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.authorize") }));
  await screen.findByText(i18n.t("ai.recovery.unknown"));
  const request = structuredClone(owner.recovery.current().pending!.request);
  exhaustRecoveryCapacity("activations");
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.refresh") }));
  expect(await screen.findByText(i18n.t("ai.recovery.exhausted"))).toBeVisible();
  expect(screen.getByRole("button", { name: i18n.t("ai.recovery.endPreparation") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.check") }));
  await screen.findByText(i18n.t("ai.recovery.notices.absent"));
  expect(calls("read_work_plan_team_recovery_action")[0][1].request).toEqual(request);
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.endPreparation") }));
  await screen.findByText(i18n.t("ai.recovery.notices.closed"));
  expect(calls("end_work_plan_team_recovery")[0][1].request).toEqual(request);
  expect(calls("authorize_work_plan_team_recovery")).toHaveLength(1);
  expect(owner.recovery.current().pending).toBeNull();
  expect(owner.recovery.current().draft!.instructions).toBe("Human A: revisit the original rejected claim.");
});
it("distinguishes stopped producers from mismatched recovery observations", async () => {
  source.view.effectiveVersion = { ...source.view.effectiveVersion, digest: "c".repeat(64) };
  render(<Harness/>, project);
  await screen.findByRole("button", { name: i18n.t("ai.recovery.edit") });
  expect(await screen.findByText(i18n.t("ai.recovery.refreshRequired"))).toBeVisible();
  expect(screen.queryByText(i18n.t("ai.recovery.draining"))).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: i18n.t("ai.recovery.edit") })).toBeDisabled();
});

it("requires actual drain and a live original deadline, refreshes readiness without granting consent and preserves stable member identity", async () => {
  source.state.runtime!.producersDrained = false; render(<Harness/>, project);
  const button = await screen.findByRole("button", { name: i18n.t("ai.recovery.edit") }); expect(button).toBeDisabled();
  expect(await screen.findByText(i18n.t("ai.recovery.draining"))).toBeVisible(); expect(calls("prepare_work_plan_team_recovery")).toHaveLength(0);
  source.state.runtime!.producersDrained = true;
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.refresh") }));
  await waitFor(() => expect(button).toBeEnabled()); await user.click(button);
  const original = structuredClone(source.view.roster[0]);
  const first = within(screen.getByRole("group", { name: "Member 1" })); await user.type(first.getByRole("textbox", { name: i18n.t("ai.team.role") }), " Additional human boundary.");
  await user.type(screen.getByRole("textbox", { name: i18n.t("ai.recovery.instructions") }), "Explicit new translation work.");
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.prepare") }));
  const consent = await screen.findByRole("checkbox", { name: i18n.t("ai.recovery.consent") }); expect(consent).not.toBeChecked();
  const request: unknown = calls("prepare_work_plan_team_recovery")[0][1].request;
  if (!validators.validateRequestWorkPlanTeamRecoveryPrepare(request)) throw new Error("Expected typed prepare request");
  expect(request.recovery.members[0].memberId).toBe(original.memberId); expect(request.recovery.members[0].roleVersionId).not.toBe(original.roleVersionId);
  const second = request.recovery.members[1];
  if (!second) throw new Error("Expected both captured fixture members");
  expect(second.roleVersionId).toBe(source.view.roster[1].roleVersionId);
  expect(preview?.preview.limits).toEqual(source.status.plan.options.teamExecution!.limits); expect(calls("authorize_work_plan_team_recovery")).toHaveLength(0);
  source.state.runtime = null; await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.refresh") }));
  expect(await screen.findByText(i18n.t("ai.recovery.newPlan"))).toBeVisible(); await waitFor(() => expect(owner.recovery.current().capture).toBeNull());
  expect(owner.recovery.current().draft!.instructions).toBe("Explicit new translation work.");
});

it("keeps newer B through uncertain authorization, exact original action lookup, pane remount and recovery start", async () => {
  const rendered = render(<Harness/>, project), user = await prepare(), original = invoke.getMockImplementation()!;
  let first = true;
  invoke.mockImplementation(async (command, payload) => {
    if (command === "authorize_work_plan_team_recovery" && first) { first = false; throw { outcome: "unknown", reason: "synthetic-transport" }; }
    return original(command, payload);
  });
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.recovery.consent") }));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.authorize") }));
  await screen.findByText(i18n.t("ai.recovery.unknown"));
  const field = screen.getByRole("textbox", { name: i18n.t("ai.recovery.instructions") }); await user.clear(field); await user.type(field, "Newer B must remain unsubmitted.");
  const originalRequest = structuredClone(owner.recovery.current().pending!.request);
  rendered.rerender(<Harness mounted={false}/>); expect(owner.recovery.blocked()).toBe(true); expect(owner.reset()).toBe(false);
  rendered.rerender(<Harness/>); await screen.findByText(i18n.t("ai.recovery.unknown"));
  expect(screen.getByRole("textbox", { name: i18n.t("ai.recovery.instructions") })).toHaveValue("Newer B must remain unsubmitted.");
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.check") }));
  expect(await screen.findByText(i18n.t("ai.recovery.notices.absent"))).toBeVisible();
  expect(calls("read_work_plan_team_recovery_action")[0][1].request).toEqual(originalRequest);
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.retry") }));
  await screen.findByText(i18n.t("ai.recovery.authorized"));
  expect(calls("authorize_work_plan_team_recovery")[1][1].request).toEqual(originalRequest);
  expect(owner.recovery.current().draft!.instructions).toBe("Newer B must remain unsubmitted.");
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("ai.recovery.start") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.start") }));
  await screen.findByText(i18n.t("ai.recovery.notices.newer"));
  await waitFor(() => expect(owner.recovery.blocked()).toBe(false));
  expect(owner.current().attempt).toBe(receipt?.attemptId); expect(owner.current().startedPlan?.taskId).toBe(receipt?.taskId);
  expect(owner.recovery.current().draft!.instructions).toBe("Newer B must remain unsubmitted."); expect(owner.recovery.hasDraft()).toBe(true);
  expect(calls("read_ai_translation")).toHaveLength(0);
});

it("discards a late readonly preview after editing B and keeps the original draft when source evidence changes", async () => {
  render(<Harness/>, project); const user = await editing(), pending = deferred<WorkPlanTeamRecoveryPreviewView>(), original = invoke.getMockImplementation()!;
  let request: WorkPlanTeamRecoveryPrepareRequest | null = null;
  invoke.mockImplementation((command, payload) => { if (command === "prepare_work_plan_team_recovery" && validators.validateRequestWorkPlanTeamRecoveryPrepare(payload.request)) { request = payload.request; return pending.promise; } return original(command, payload); });
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.prepare") })); await waitFor(() => expect(request).not.toBeNull());
  await user.type(screen.getByRole("textbox", { name: i18n.t("ai.recovery.instructions") }), " Newer B.");
  await act(async () => { pending.resolve(teamRecoveryPreviewFixture(request!, source)); });
  await waitFor(() => expect(owner.recovery.current().preparing).toBe(false));
  expect(owner.recovery.current().capture).toBeNull(); expect(owner.recovery.current().draft!.instructions).toContain("Newer B.");
  invoke.mockImplementation(original); await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.prepare") }));
  await screen.findByRole("checkbox", { name: i18n.t("ai.recovery.consent") }); await refreshWorkbenchReads(["source"]);
  expect(owner.recovery.current().capture).toBeNull(); expect(owner.recovery.current().draft!.instructions).toContain("Newer B.");
});

it("explicitly includes an unresolved task outside the first page and retains optional references across work pages", async () => {
  const unresolved = { taskId: fixtureIdentity(9800), attemptId: fixtureIdentity(9801), inputDigest: "f".repeat(64) };
  source.state.state.unresolvedWork = [unresolved]; source.view.nextWorkAfter = "1";
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "read_work_plan_team_execution" && payload.request.afterWork === "1"
    ? { ...structuredClone(source.view), works: [], nextWorkAfter: null } : original(command, payload));
  render(<Harness/>, project); const user = await editing();
  expect(screen.getByRole("button", { name: i18n.t("ai.recovery.prepare") })).toBeDisabled();
  const required = screen.getByRole("checkbox", { name: i18n.t("ai.recovery.unresolvedItem", { number: "1" }) }); expect(required).not.toBeChecked();
  await user.click(required); await user.click(screen.getByRole("button", { name: i18n.t("ai.team.openTask") })); expect(openTask).toHaveBeenCalledWith(unresolved.taskId, unresolved.attemptId);
  const other = screen.getByRole("checkbox", { name: `${source.status.plan.scope[0].nativeKey} · ${source.status.plan.locale} · ${i18n.t("ai.states.succeeded")}` });
  await user.click(other);
  await user.click(screen.getByRole("button", { name: i18n.t("ai.team.nextWorks") }));
  await waitFor(() => expect(calls("read_work_plan_team_execution").some(([, payload]) => payload.request.afterWork === "1")).toBe(true));
  expect(owner.recovery.current().draft!.priorWork).toHaveLength(2);
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("ai.recovery.prepare") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.prepare") }));
  await screen.findByRole("region", { name: i18n.t("ai.recovery.previewTitle") });
  expect(preview?.preview.work.priorWork).toContainEqual(unresolved);
  expect(screen.getAllByText(i18n.t("ai.recovery.unresolvedHelp"))).toHaveLength(2);
  expect(calls("authorize_work_plan_team_recovery")).toHaveLength(0);
});

it("atomically closes only a checked absent preparation after source-only invalidation with the same paused lease, keeping B", async () => {
  render(<Harness/>, project); const user = await prepare(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "authorize_work_plan_team_recovery" ? Promise.reject({ outcome: "unknown" }) : original(command, payload));
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.recovery.consent") })); await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.authorize") }));
  await screen.findByText(i18n.t("ai.recovery.unknown"));
  await user.type(screen.getByRole("textbox", { name: i18n.t("ai.recovery.instructions") }), " B kept.");
  const request = structuredClone(owner.recovery.current().pending!.request), lease = structuredClone(source.state.state.lease);
  await refreshWorkbenchReads(["source"]);
  expect(screen.getByRole("button", { name: i18n.t("ai.recovery.endPreparation") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.check") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("ai.recovery.endPreparation") })).toBeEnabled());
  expect(owner.recovery.blocked()).toBe(true);
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.endPreparation") }));
  await screen.findByText(i18n.t("ai.recovery.notices.closed"));
  expect(calls("end_work_plan_team_recovery")[0][1].request).toEqual(request); expect(source.state.state.lease).toEqual(lease);
  expect(owner.recovery.blocked()).toBe(false); expect(owner.recovery.current().draft!.instructions).toContain("B kept."); expect(calls("authorize_work_plan_team_recovery")).toHaveLength(1);
});

it.each(["old-plan-digest", "different-work"])("rejects a recovery receipt with %s instead of the captured work identity", async mismatch => {
  render(<Harness/>, project); const user = await prepare(); await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.recovery.consent") }));
  if (!preview) throw new Error("Expected the captured new work");
  expect(preview.preview.inputDigest).not.toBe(source.status.plan.digest);
  const workId = fixtureIdentity(9998); expect(workId).not.toBe(preview.preview.work.workId);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    const value = await original(command, payload);
    if (command !== "authorize_work_plan_team_recovery") return value;
    return mismatch === "old-plan-digest" ? { ...value, inputDigest: source.status.plan.digest } : { ...value, workId };
  });
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.authorize") })); await screen.findByText(i18n.t("ai.recovery.unknown"));
  expect(owner.recovery.current().ready).toBeNull(); expect(calls("start_work_plan")).toHaveLength(0);
});

it("uses exact historical roles and the trusted human origin for a later work while showing the current roster separately", async () => {
  const current = source.view.roster[0], oldRole = source.view.roleVersions.find(role => role.request.memberId === current.memberId)!;
  source.view.members = source.view.members.map(role => role.request.memberId === current.memberId ? { ...role, request: { ...role.request, displayName: "Current renamed member", role: "Current later duties", roleVersionId: fixtureIdentity(9900) } } : role);
  source.view.roster = source.view.roster.map(member => member.memberId === current.memberId ? { ...member, displayName: "Current renamed member", roleVersionId: fixtureIdentity(9900) } : member);
  const work = source.view.works[0];
  work.origin = { kind: "human-continuation", actionId: fixtureIdentity(9901), work: { workId: work.receipt.intentId, memberId: work.receipt.memberId,
    target: work.target, kind: "review", instructions: "Human request preserved verbatim.", postIds: [], priorWork: [] } }; work.author = null; work.request = null;
  render(<TeamExecutionHistory context={teamContext} status={source.status} open onReadPost={() => {}}/>, project);
  expect(await screen.findByText("Human request preserved verbatim.")).toBeVisible(); expect(screen.getByText(i18n.t("ai.recovery.humanRequester"))).toBeVisible();
  expect(screen.getByText("Current renamed member")).toBeVisible(); expect(screen.getByRole("heading", { name: `${oldRole.request.displayName} → Reviewer B` })).toBeVisible();
  expect(screen.queryByText(i18n.t("ai.team.initialWork"))).not.toBeInTheDocument();
});


it("protects a new recovery draft on actual AI exit and returns an unresolved action to its original plan", async () => {
  const handle = createRef<AiHandle>(), user = userEvent.setup();
  render(<AiPreparationSession initialLocale="zh-CN" targetLocales={project.metadata.targetLocales}><Probe/>
    <AiWorkbench project={project} disabled={false} ref={handle} onOpenTranslation={async () => false}/>
  </AiPreparationSession>, project);
  await user.click(screen.getByRole("button", { name: "AI work" }));
  await act(async () => { owner.recordPlan(source.status.plan.planId); });
  await editing();
  let leaving!: Promise<boolean>;
  await act(async () => { leaving = handle.current!.allowLeave(); });
  const dialog = await screen.findByRole("dialog", { name: i18n.t("ai.unsaved") });
  expect(within(dialog).getByText(i18n.t("ai.unsavedDescription"))).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: i18n.t("ai.stay") })); expect(await leaving).toBe(false);
  expect(owner.recovery.current().draft!.instructions).toContain("Human A");
  const recovery = within(screen.getByRole("region", { name: i18n.t("ai.recovery.title") }));
  await user.click(recovery.getByRole("button", { name: i18n.t("ai.recovery.prepare") }));
  await user.click(await recovery.findByRole("checkbox", { name: i18n.t("ai.recovery.consent") }));
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "authorize_work_plan_team_recovery" ? Promise.reject({ outcome: "unknown" }) : original(command, payload));
  await user.click(recovery.getByRole("button", { name: i18n.t("ai.recovery.authorize") })); await recovery.findByText(i18n.t("ai.recovery.unknown"));
  await act(async () => { owner.recordPlan(fixtureIdentity(9999)); });
  let allowed = true; await act(async () => { allowed = await handle.current!.allowLeave(); });
  expect(allowed).toBe(false); expect(owner.current().planId).toBe(source.status.plan.planId); expect(owner.recovery.current().pending).not.toBeNull();
});


it.each(["en-US", "zh-CN"])("discloses the new capture's exact existing cited text and destination sharing with consent off in %s", async locale => {
  await i18n.changeLanguage(locale); const policy = { profile: "current-plan-2" as const };
  source.status.plan.options.teamDiscussions = policy; source.status.plan.teamDiscussionLimits = teamDiscussionLimitsForFixture(policy);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    const value = await original(command, payload);
    if (command === "prepare_work_plan_team_recovery" && validators.validateResponseWorkPlanTeamRecoveryPreview(value)) {
      const view = value.preview.discussionPreviews[0], post = view.posts[0];
      const referenceIndex = post.publication.references.findIndex(reference => reference.kind === "translation-revision");
      const reference = post.publication.references[referenceIndex];
      if (!reference || reference.kind !== "translation-revision") throw new Error("Expected exact synthetic cited translation");
      view.artifacts.push({ kind: "untrusted-team-artifact", postId: post.publication.postId, referenceIndex, target: view.target,
        artifact: { kind: "translation-revision", revisionId: reference.revisionId, text: "Exact earlier cited text 中文—not the selected translation." } });
      preview = value;
    }
    return value;
  });
  render(<Harness/>, project); await prepare();
  expect(screen.getByRole("checkbox", { name: i18n.t("ai.recovery.artifactConsent") })).not.toBeChecked();
  expect(screen.getByText("Exact earlier cited text 中文—not the selected translation.")).toBeVisible();
  const captured = within(screen.getByRole("region", { name: i18n.t("ai.recovery.previewTitle") }));
  const reviewer = within(captured.getByRole("region", { name: "Reviewer B" }));
  expect(reviewer.queryByText("Exact earlier cited text 中文—not the selected translation.")).not.toBeInTheDocument();
  expect(reviewer.queryByText("Translator note 中文 👩🏽‍💻 é")).not.toBeInTheDocument();
  expect(calls("authorize_work_plan_team_recovery")).toHaveLength(0); expect(calls("start_work_plan")).toHaveLength(0);
});

it("retains an unknown close and its exact original request until an explicit same-close result, preserving later B", async () => {
  render(<Harness/>, project); const user = await prepare(), original = invoke.getMockImplementation()!;
  let endings = 0;
  const late = deferred<Awaited<ReturnType<typeof workPlanCommands.endTeamRecovery>>>();
  invoke.mockImplementation((command, payload) => {
    if (command === "authorize_work_plan_team_recovery") return Promise.reject({ outcome: "unknown" });
    if (command === "end_work_plan_team_recovery") { endings++; return endings === 1 ? Promise.reject({ outcome: "unknown" }) : late.promise; }
    return original(command, payload);
  });
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.recovery.consent") }));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.authorize") })); await screen.findByText(i18n.t("ai.recovery.unknown"));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.check") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("ai.recovery.endPreparation") })).toBeEnabled());
  const request = structuredClone(owner.recovery.current().pending!.request);
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.endPreparation") }));
  await screen.findByText(i18n.t("ai.recovery.closeUnknown")); expect(owner.recovery.current().pending?.kind).toBe("close");
  expect(screen.getByRole("button", { name: i18n.t("ai.recovery.retryClose") })).toBeEnabled();
  expect(owner.reset()).toBe(false); expect(calls("end_work_plan_team_recovery")[0][1].request).toEqual(request);
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.check") }));
  await screen.findByText(i18n.t("ai.recovery.notices.closeAbsent"));
  expect(owner.recovery.current().pending).not.toBeNull(); expect(owner.recovery.blocked()).toBe(true);
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.retryClose") }));
  const field = screen.getByRole("textbox", { name: i18n.t("ai.recovery.instructions") });
  await user.clear(field); await user.type(field, "B typed after ending began must survive its late response.");
  const closing = owner.recovery.current().pending;
  if (closing?.kind !== "close") throw new Error("Expected the exact original close");
  const { sessionToken: _session, projectId: _project, preparationId: _preparation, ...recorded } = closing.request;
  await act(async () => { late.resolve({ kind: "preparation-closed", projectId: teamContext.projectId, preparationId: closing.request.preparationId, request: recorded }); });
  await screen.findByText(i18n.t("ai.recovery.notices.closed")); expect(owner.recovery.blocked()).toBe(false);
  expect(owner.recovery.current().draft!.instructions).toBe("B typed after ending began must survive its late response.");
  expect(calls("end_work_plan_team_recovery")[1][1].request).toEqual(request); expect(calls("authorize_work_plan_team_recovery")).toHaveLength(1);
});

it("shows an exact authorization discovered while ending instead of claiming closure or starting work, retaining B", async () => {
  render(<Harness/>, project); const user = await prepare(), original = invoke.getMockImplementation()!;
  let attempted: WorkPlanTeamRecoveryAuthorizeRequest | null = null;
  invoke.mockImplementation(async (command, payload) => {
    if (command === "authorize_work_plan_team_recovery" && validators.validateRequestWorkPlanTeamRecoveryAuthorize(payload.request)) {
      attempted = structuredClone(payload.request); throw { outcome: "unknown" };
    }
    if (command === "end_work_plan_team_recovery") {
      if (!attempted) throw new Error("Expected the exact original authorization");
      await original("authorize_work_plan_team_recovery", { request: attempted });
    }
    return original(command, payload);
  });
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.recovery.consent") }));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.authorize") })); await screen.findByText(i18n.t("ai.recovery.unknown"));
  await user.type(screen.getByRole("textbox", { name: i18n.t("ai.recovery.instructions") }), " Newer B remains a draft.");
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.check") })); await screen.findByText(i18n.t("ai.recovery.notices.absent"));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.recovery.endPreparation") }));
  await screen.findByText(i18n.t("ai.recovery.authorized"));
  expect(owner.recovery.current().ready?.receipt).toEqual(receipt); expect(owner.recovery.current().pending).toBeNull();
  expect(owner.recovery.current().draft!.instructions).toContain("Newer B remains a draft.");
  expect(screen.queryByText(i18n.t("ai.recovery.notices.closed"))).not.toBeInTheDocument(); expect(calls("start_work_plan")).toHaveLength(0);
  expect(calls("end_work_plan_team_recovery")[0][1].request).toEqual(attempted);
});
