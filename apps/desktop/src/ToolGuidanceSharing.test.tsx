import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolGuidanceSharing } from "./ToolGuidanceSharing";
import { TeamExecutionDisclosure } from "./TeamExecutionDisclosure";
import { TeamRecoveryDisclosure } from "./TeamRecoveryDisclosure";
import { workPlanToolStatus } from "./testSupport/workPlanToolFixture";
import { teamExecutionStatusFixture } from "./testSupport/teamExecutionFixture";
import { teamRecoveryFixture, teamRecoveryPreviewFixture } from "./testSupport/teamRecoveryFixture";
import { teamContext } from "./testSupport/teamDiscussionFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { WorkPlanTeamRecoveryPrepareRequest } from "./generated/ai.requests";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });
afterEach(cleanup);

function capturedTool() {
  const tool = workPlanToolStatus.plan.tools?.entries[0];
  if (!tool?.binding.declaration.skill || !tool.binding.resources.length) throw new Error("Expected captured Skill and supporting Resource declarations");
  return structuredClone(tool);
}

it.each(["en-US", "zh-CN"])("keeps old guidance human-only and discloses only captured declarations without reading text in %s", async locale => {
  await i18n.changeLanguage(locale);
  const plan = structuredClone(workPlanToolStatus.plan), config = plan.preview?.config;
  if (!config) throw new Error("Expected the captured model destination");
  delete plan.options.toolGuidance;
  const view = render(<ToolGuidanceSharing plan={plan} config={config}/>);
  expect(screen.getByText(i18n.t("ai.toolGuidanceSharing.humanOnly"))).toBeVisible();
  expect(screen.queryByRole("region", { name: i18n.t("ai.toolGuidanceSharing.title") })).not.toBeInTheDocument();
  plan.options.toolGuidance = { profile: "declared-tools-1" };
  const tool = capturedTool(), skillId = tool.binding.declaration.skill, hostile = "Untrusted <script>expandPermission()</script> [read files](https://example.test)";
  if (!skillId) throw new Error("Expected the captured Skill declaration");
  tool.binding.declaration.description = hostile;
  const withoutGuidance = capturedTool(); withoutGuidance.handle = fixtureIdentity(16903);
  withoutGuidance.binding.declaration.title = "Reference tool without guidance";
  withoutGuidance.binding.declaration.skill = null; withoutGuidance.binding.declaration.supportingResources = []; withoutGuidance.binding.resources = [];
  plan.tools = { maxInvocations: 2, entries: [tool, withoutGuidance] };
  view.rerender(<ToolGuidanceSharing plan={plan} config={config}/>);
  const disclosure = screen.getByRole("region", { name: i18n.t("ai.toolGuidanceSharing.title") });
  expect(within(disclosure).getByText(i18n.t("ai.toolGuidanceSharing.destination", { endpoint: config.endpoint, model: config.model }))).toBeVisible();
  expect(within(disclosure).getByText(i18n.t("ai.toolGuidanceSharing.disclosure"))).toBeVisible();
  expect(within(disclosure).getByText(i18n.t("ai.toolGuidanceSharing.bounds"))).toBeVisible();
  expect(within(disclosure).getByText(hostile)).toBeVisible();
  expect(within(disclosure).getByText(withoutGuidance.binding.declaration.title)).toBeVisible();
  expect(within(disclosure).getByText(i18n.t("ai.toolGuidance.noSkill"))).toBeVisible();
  expect(within(disclosure).getByText(i18n.t("ai.toolGuidance.noReferences"))).toBeVisible();
  expect(disclosure.querySelector("script,a,img,iframe")).toBeNull();
  expect(within(disclosure).getByText(i18n.t("ai.toolGuidanceSharing.skill", { id: skillId }))).toBeVisible();
  for (const resource of tool.binding.resources) expect(within(disclosure).getByText(i18n.t("ai.toolGuidanceSharing.resource", {
    id: resource.contributionId, contract: resource.schema.id, schema: String(resource.schema.schemaVersion), behavior: String(resource.schema.behaviorVersion),
  }))).toBeVisible();
  expect(invoke).not.toHaveBeenCalled();
});

it.each(["en-US", "zh-CN"])("filters guidance sharing by each captured member's tool subset and actual destination in %s", async locale => {
  await i18n.changeLanguage(locale);
  const { plan } = teamExecutionStatusFixture(), policy = plan.options.teamExecution, tool = capturedTool();
  const firstMember = policy?.members[0], secondMember = policy?.members[1];
  if (!policy || !firstMember || !secondMember) throw new Error("Expected the captured team roster");
  plan.tools = { maxInvocations: 2, entries: [tool] }; plan.options.toolGuidance = { profile: "declared-tools-1" };
  firstMember.toolHandles = []; secondMember.toolHandles = [tool.handle];
  render(<TeamExecutionDisclosure plan={plan}/>);
  const first = within(screen.getByRole("region", { name: firstMember.displayName }));
  const second = within(screen.getByRole("region", { name: secondMember.displayName }));
  expect(first.queryByRole("region", { name: i18n.t("ai.toolGuidanceSharing.title") })).not.toBeInTheDocument();
  const sharing = second.getByRole("region", { name: i18n.t("ai.toolGuidanceSharing.title") });
  expect(within(sharing).getByText(i18n.t("ai.toolGuidanceSharing.destination", { endpoint: secondMember.config.endpoint, model: secondMember.config.model }))).toBeVisible();
  expect(within(sharing).getByText(tool.binding.declaration.title)).toBeVisible();
  expect(screen.getAllByRole("region", { name: i18n.t("ai.toolGuidanceSharing.title") })).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalled();
});

it.each(["en-US", "zh-CN"])("retains the original recovery policy while showing the newly captured destination in %s", async locale => {
  await i18n.changeLanguage(locale);
  const source = teamRecoveryFixture(), { plan } = source.status, policy = plan.options.teamExecution, tool = capturedTool(), unit = plan.scope[0];
  const originalFirst = policy?.members[0], originalRecipient = policy?.members[1];
  if (!policy || !originalFirst || !originalRecipient || !unit) throw new Error("Expected the captured team work scope");
  plan.tools = { maxInvocations: 2, entries: [tool] }; delete plan.options.toolGuidance;
  const firstMember = structuredClone(originalFirst), recipient = structuredClone(originalRecipient);
  const members: WorkPlanTeamRecoveryPrepareRequest["recovery"]["members"] = [firstMember, recipient];
  firstMember.toolHandles = []; recipient.toolHandles = [tool.handle];
  recipient.roleVersionId = fixtureIdentity(16902);
  recipient.config = { ...recipient.config, endpoint: "http://127.0.0.1:4009/v1/chat/completions", model: "Recovery captured model" };
  const request: WorkPlanTeamRecoveryPrepareRequest = { ...teamContext, preparationId: fixtureIdentity(16900), recovery: {
    projectId: teamContext.projectId, planId: plan.planId, expectedLease: source.status.lease, expectedEffectiveVersion: source.view.effectiveVersion, members,
    work: { workId: fixtureIdentity(16901), memberId: recipient.memberId, kind: "review", instructions: "Review only this captured original entry.", postIds: [], priorWork: [],
      target: { unitId: unit.unitId, locale: plan.locale, sourceRevisionId: unit.sourceRevisionId, sourceSnapshotId: unit.sourceSnapshotId } },
  } };
  const preview = teamRecoveryPreviewFixture(request, source).preview;
  const view = render(<TeamRecoveryDisclosure plan={plan} preview={preview} unresolvedWork={[]}/>);
  expect(screen.getByText(i18n.t("ai.toolGuidanceSharing.humanOnly"))).toBeVisible();
  expect(screen.queryByRole("region", { name: i18n.t("ai.toolGuidanceSharing.title") })).not.toBeInTheDocument();
  const enabledPlan = { ...plan, options: { ...plan.options, toolGuidance: { profile: "declared-tools-1" as const } } };
  view.rerender(<TeamRecoveryDisclosure plan={enabledPlan} preview={preview} unresolvedWork={[]}/>);
  const sharing = screen.getByRole("region", { name: i18n.t("ai.toolGuidanceSharing.title") });
  expect(within(sharing).getByText(i18n.t("ai.toolGuidanceSharing.destination", { endpoint: recipient.config.endpoint, model: recipient.config.model }))).toBeVisible();
  expect(within(sharing).queryByText(i18n.t("ai.toolGuidanceSharing.destination", { endpoint: originalRecipient.config.endpoint, model: originalRecipient.config.model }))).not.toBeInTheDocument();
  expect(plan.options.toolGuidance).toBeUndefined(); expect(invoke).not.toHaveBeenCalled();
});

it("makes tools without declared guidance explicit instead of inventing a reader or preloading other text", () => {
  const plan = structuredClone(workPlanToolStatus.plan), config = plan.preview?.config, tool = capturedTool();
  if (!config) throw new Error("Expected captured model");
  tool.binding.declaration.skill = null; tool.binding.declaration.supportingResources = []; tool.binding.resources = [];
  plan.tools = { maxInvocations: 2, entries: [tool] }; plan.options.toolGuidance = { profile: "declared-tools-1" };
  render(<ToolGuidanceSharing plan={plan} config={config}/>);
  expect(screen.getByText(i18n.t("ai.toolGuidanceSharing.noDeclared"))).toBeVisible();
  expect(invoke).not.toHaveBeenCalled();
});
