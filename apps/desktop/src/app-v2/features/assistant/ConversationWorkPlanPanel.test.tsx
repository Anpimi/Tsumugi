import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { canonicalConversationDraft, type ConversationDraftHead } from "../../../conversationDraftCommands";
import type { ConversationProposalRevision } from "../../../conversationCommands";
import type { Requests } from "../../../generated/conversations.requests";
import type { Responses } from "../../../generated/conversations.responses";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { i18n } from "../../../i18n";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { connectionFixture } from "../../../testSupport/connectionFixture";
import { conversationWorkPlanFixture } from "../../../testSupport/conversationWorkPlanFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import ConversationPanel from "./ConversationPanel";
import { ConversationSession } from "./ConversationSession";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: id(35001), sessionToken: "work-plan-dom" }, conversationId = id(35002);
const key = { projectId: context.projectId, conversationId };
const disposals: (() => void)[] = [];
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("zh-CN"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });

function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function expectNoExecution() {
  const allowed = ["list_project_conversations", "read_project_conversation_messages", "read_conversation_planning_attempts", "read_conversation_planning",
    "read_conversation_proposal_revisions", "read_conversation_proposal", "validate_conversation_proposal", "read_conversation_proposal_work_plans",
    "list_local_conversation_drafts", "read_local_conversation_draft", "write_local_conversation_draft", "resolve_local_conversation_draft",
    "read_model_connections", "read_context_strategy_default", "prepare_conversation_proposal_work_plan", "authorize_conversation_proposal_work_plan", "recover_conversation_proposal_work_plan"];
  expect(invoke.mock.calls.map(([command]) => command).filter(command => !allowed.includes(command))).toEqual([]);
}
function harness({ questions = false, unknown = false } = {}) {
  const fixture = conversationWorkPlanFixture(key);
  if (fixture.revision.content.kind !== "proposal") throw new Error("Synthetic saved version must be a proposal");
  if (questions) fixture.revision.content.questions = ["清晨的时间是否需要再核对？"];
  const config = { ...fixture.config, connectionProfile: { storeId: id(35003), profileId: id(35004), revision: "1", digest: "a".repeat(64) } };
  const connections = connectionFixture([config]);
  const state: {
    head: ConversationDraftHead;
    revisions: ConversationProposalRevision[];
    links: Responses["proposalWorkPlanLink"][];
    authorizations: Requests["authorizeProposalWorkPlan"]["authorization"][];
    recovery: "pending" | "recorded";
  } = {
    head: { key, revision: "0", writerId: null, value: null },
    revisions: [structuredClone(fixture.revision)], links: [], authorizations: [], recovery: "pending",
  };
  function link(authorization: Requests["authorizeProposalWorkPlan"]["authorization"]): Responses["proposalWorkPlanLink"] {
    return { ...key, proposalId: authorization.proposal.proposalId, revisionId: authorization.proposal.revisionId,
      planId: authorization.planId, planDigest: authorization.planDigest, actionId: authorization.actionId, ordinal: "1" };
  }
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "list_project_conversations") return { projectId: context.projectId, rows: [{ ...key, title: "工作计划对话", ordinal: "1" }], nextAfter: null };
    if (command === "read_project_conversation_messages") return { ...key, rows: fixture.run.preview.selectedMessages, nextAfter: null };
    if (command === "read_conversation_planning_attempts") return { ...key,
      rows: [{ attemptId: fixture.revision.origin.attemptId, taskId: fixture.run.receipt.consent.taskId, sequence: "1" }], nextAfter: null };
    if (command === "read_conversation_planning") return structuredClone(fixture.run);
    if (command === "read_conversation_proposal_revisions") return { ...key, rows: structuredClone(state.revisions), nextAfter: null };
    if (command === "read_conversation_proposal_work_plans") return { ...key, rows: structuredClone(state.links), nextAfter: null };
    if (command === "read_conversation_proposal" || command === "validate_conversation_proposal") {
      const revision = request.revisionId === null ? state.revisions.at(-1) : state.revisions.find(item => item.revisionId === request.revisionId);
      if (!revision) throw new Error("Synthetic proposal version not found");
      return structuredClone(revision);
    }
    if (command === "list_local_conversation_drafts") return { items: state.head.value ? [{ key, revision: state.head.revision,
      editSeq: state.head.value.editSeq, hasPending: !!state.head.value.pending }] : [], next: null };
    if (command === "read_local_conversation_draft") return structuredClone(state.head);
    if (command === "write_local_conversation_draft" || command === "resolve_local_conversation_draft") {
      const write = request.write ?? request.resolve.write;
      const response: unknown = { key, revision: String(BigInt(state.head.revision) + 1n), writerId: write.writerId,
        value: structuredClone(canonicalConversationDraft(write.value)) };
      if (!validateResponseConversationWritten(response)) throw new Error("Invalid synthetic journal response");
      state.head = response;
      return structuredClone(state.head);
    }
    if (command === "read_model_connections") return structuredClone(connections);
    if (command === "read_context_strategy_default") return null;
    if (command === "prepare_conversation_proposal_work_plan") return conversationWorkPlanFixture(key, request.config).prepared;
    if (command === "authorize_conversation_proposal_work_plan") {
      expect(state.head.value?.pending).toMatchObject({ kind: "proposal-work-plan", request: request.authorization });
      expect(state.head.value?.pending?.request).toEqual(request.authorization);
      state.authorizations.push(structuredClone(request.authorization));
      if (unknown) throw { outcome: "unknown", code: "storage-failed", reason: "synthetic-acknowledgement-lost" };
      const recorded = link(request.authorization); state.links = [recorded];
      return { link: recorded, receipt: { actionId: recorded.actionId, lease: { planId: recorded.planId, generation: "1" }, state: "active",
        attemptId: fixture.prepared.plan.attemptId, parentTask: null } };
    }
    if (command === "recover_conversation_proposal_work_plan") {
      expect(request.authorization).toEqual(state.authorizations[0]);
      if (state.recovery === "pending") return { request: structuredClone(request.authorization), outcome: { kind: "pending", replay: "blocked" } };
      const recorded = link(request.authorization); state.links = [recorded];
      return { request: structuredClone(request.authorization), outcome: { kind: "recorded", receipt: recorded } };
    }
    throw new Error(`Unexpected synthetic command: ${command}`);
  });
  const open = async () => {
    const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("entries");
    const owner = new ConversationSession(context, () => reads.invalidate(["project"]), () => {});
    expect(await owner.initialize()).toBe(true); expect(await owner.open(conversationId)).toBe(true);
    const content = (visible = true) => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
      <ConversationPanel owner={owner} visible={visible} disabled={false} gate={gate} viewId="entries"/>
    </SessionReadProvider></ApplicationReadProvider>;
    const view = render(content());
    let retired = false;
    const retire = () => { if (!retired) { retired = true; owner.retire(); reads.retire(); gate.dispose(); } };
    disposals.push(retire);
    return { owner, reads, gate, view, retire, visible: (visible: boolean) => view.rerender(content(visible)),
      flush: async () => { await act(async () => { expect(await owner.flush()).toBe(true); }); } };
  };
  return { ...fixture, config, state, open };
}
async function reviewSavedPlan() {
  const entry = await screen.findByRole("button", { name: i18n.t("conversation.planReviewOpen") });
  entry.focus(); fireEvent.click(entry);
  const region = await screen.findByRole("region", { name: i18n.t("conversation.planTitle") });
  expect(region).toHaveFocus();
  return { entry, region, panel: within(region) };
}
async function chooseConnection(panel: ReturnType<typeof within>) {
  const option = await panel.findByRole("option", { name: "Synthetic synthetic-model · synthetic-model" });
  await waitFor(() => expect(option).toBeEnabled());
  fireEvent.change(panel.getByRole("combobox", { name: i18n.t("connections.choose") }), { target: { value: id(35004) } });
  fireEvent.change(panel.getByRole("spinbutton", { name: i18n.t("ai.maxRequests") }), { target: { value: "4" } });
  fireEvent.change(panel.getByRole("spinbutton", { name: i18n.t("ai.maxOutputTokens") }), { target: { value: "73" } });
  fireEvent.click(panel.getByRole("checkbox", { name: i18n.t("ai.shareTerms") }));
  fireEvent.click(panel.getByRole("checkbox", { name: i18n.t("ai.shareContext") }));
}
function finalConsent(panel: ReturnType<typeof within>) {
  return panel.getByRole("checkbox", { name: (name: string) => name.includes(i18n.t("ai.consent")) });
}
async function prepare(panel: ReturnType<typeof within>) {
  const button = panel.getByRole("button", { name: i18n.t("conversation.planPrepare") });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
  const region = await panel.findByRole("region", { name: i18n.t("conversation.planPreview") });
  await waitFor(() => expect(finalConsent(panel)).toBeEnabled());
  return within(region);
}

it("reviews saved scope, material, budget and effects before recording exactly one confirmation without starting work", async () => {
  const h = harness(), session = await h.open(), { panel, region } = await reviewSavedPlan();
  await chooseConnection(panel);
  const prepareButton = panel.getByRole("button", { name: i18n.t("conversation.planPrepare") });
  fireEvent.compositionStart(region); fireEvent.click(prepareButton);
  expect(calls("validate_conversation_proposal")).toHaveLength(0);
  fireEvent.compositionEnd(region);
  const closeOther = session.gate.pushDialog("another-dialog"); fireEvent.click(prepareButton); closeOther();
  expect(calls("prepare_conversation_proposal_work_plan")).toHaveLength(0);
  const preview = await prepare(panel);
  expect(preview.getByText("1 个条目 → zh-CN")).toBeInTheDocument();
  expect(within(preview.getByRole("region", { name: "条目与步骤" })).getByText("barrel")).toBeInTheDocument();
  const material = within(preview.getByRole("region", { name: "将分享给模型的实际材料" }));
  expect(material.getByText("Barrel {name}")).toBeInTheDocument();
  expect(material.getByText("barrel → 木桶 👩🏽‍💻 é")).toBeInTheDocument();
  expect(material.getByText("Translator note 中文 👩🏽‍💻 é")).toBeInTheDocument();
  expect(preview.getByText(/http:\/\/127\.0\.0\.1:4000\/v1\/chat\/completions/)).toBeInTheDocument();
  expect(preview.getByText(/4.*73|73.*4/)).toBeInTheDocument();
  expect(preview.getByText(i18n.t("conversation.planResourcesManual"))).toBeInTheDocument();
  expect(preview.getByText(i18n.t("conversation.planDeliveryManual"))).toBeInTheDocument();
  const confirm = panel.getByRole("button", { name: i18n.t("conversation.planConfirm") });
  expect(confirm).toBeDisabled(); fireEvent.click(confirm); expect(h.state.authorizations).toHaveLength(0);
  fireEvent.change(panel.getByRole("spinbutton", { name: i18n.t("conversation.planMinutes") }), { target: { value: "5" } });
  fireEvent.click(finalConsent(panel));
  fireEvent.compositionStart(region); fireEvent.click(confirm); fireEvent.compositionEnd(region);
  expect(h.state.authorizations).toHaveLength(0);
  const beforeConfirmation = Math.floor(Date.now() / 1000);
  fireEvent.click(confirm); fireEvent.click(confirm);
  await screen.findByText(i18n.t("conversation.workPlanRecorded")); await session.flush();
  expect(h.state.authorizations).toHaveLength(1);
  expect(h.state.authorizations[0]).toMatchObject({ proposal: h.prepared.proposal, planId: h.prepared.plan.planId,
    planDigest: h.prepared.plan.digest, confirmed: true, effects: ["save-candidate"], checkerExecutions: [], toolExecution: false, applicationToolExecutions: [] });
  const expires = Number(h.state.authorizations[0].expiresAt);
  expect(expires).toBeGreaterThanOrEqual(beforeConfirmation + 300);
  expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
  expect(h.state.head.value?.pending).toBeNull();
  expect(within(await screen.findByRole("region", { name: i18n.t("conversation.planHistory") })).getByText("根据第 1 版提议确认")).toBeInTheDocument();
  expectNoExecution();
});

it("requires renewed consent after duration, configuration and source changes, and closes hidden preparation safely", async () => {
  const h = harness(), session = await h.open(), { panel, entry } = await reviewSavedPlan();
  await chooseConnection(panel); await prepare(panel);
  fireEvent.click(finalConsent(panel));
  fireEvent.change(panel.getByRole("spinbutton", { name: i18n.t("conversation.planMinutes") }), { target: { value: "0" } });
  expect(finalConsent(panel)).not.toBeChecked(); expect(finalConsent(panel)).toBeDisabled();
  expect(panel.getByText(i18n.t("conversation.planMinutesInvalid"))).toBeInTheDocument();
  fireEvent.change(panel.getByRole("spinbutton", { name: i18n.t("conversation.planMinutes") }), { target: { value: "30" } });
  expect(finalConsent(panel)).not.toBeChecked(); fireEvent.click(finalConsent(panel));
  fireEvent.change(panel.getByRole("spinbutton", { name: i18n.t("ai.maxRequests") }), { target: { value: "3" } });
  expect(panel.queryByRole("region", { name: i18n.t("conversation.planPreview") })).not.toBeInTheDocument();
  await prepare(panel); expect(finalConsent(panel)).not.toBeChecked(); fireEvent.click(finalConsent(panel));
  act(() => session.reads.invalidate(["source"]));
  expect(panel.queryByRole("region", { name: i18n.t("conversation.planPreview") })).not.toBeInTheDocument();
  await prepare(panel); expect(finalConsent(panel)).not.toBeChecked();
  fireEvent.click(panel.getByRole("button", { name: i18n.t("conversation.planClose") }));
  expect(entry).toHaveFocus();
  entry.focus(); fireEvent.click(entry);
  const currentPanel = within(await screen.findByRole("region", { name: i18n.t("conversation.planTitle") }));
  await prepare(currentPanel); fireEvent.click(finalConsent(currentPanel));
  const oldConfirm = currentPanel.getByRole("button", { name: i18n.t("conversation.planConfirm") });
  session.visible(false); fireEvent.click(oldConfirm);
  expect(h.state.authorizations).toHaveLength(0);
  expect(session.owner.getSnapshot().inputs.get(conversationId)?.workPlan.prepared).toBeNull();
  session.visible(true);
  const reopened = within(await screen.findByRole("region", { name: i18n.t("conversation.planTitle") }));
  expect(reopened.queryByRole("button", { name: i18n.t("conversation.planConfirm") })).not.toBeInTheDocument();
  fireEvent.click(reopened.getByRole("button", { name: i18n.t("conversation.planClose") }));
  await waitFor(() => expect(screen.queryByRole("region", { name: i18n.t("conversation.planTitle") })).not.toBeInTheDocument());
  expect(h.state.authorizations).toHaveLength(0); expectNoExecution();
});

it("keeps unanswered questions and unsaved proposal edits visible and prevents preparation", async () => {
  for (const kind of ["questions", "draft"] as const) {
    const h = harness({ questions: kind === "questions" }), session = await h.open();
    if (kind === "draft") {
      fireEvent.click(await screen.findByRole("button", { name: i18n.t("conversation.proposalEdit") }));
      const editor = within(await screen.findByRole("region", { name: i18n.t("conversation.proposalEditor") }));
      fireEvent.change(editor.getByRole("textbox", { name: i18n.t("conversation.proposalSummary") }), { target: { value: "尚未保存的新目标 🙂" } });
      await session.flush();
    }
    const { panel } = await reviewSavedPlan(); await chooseConnection(panel);
    expect(panel.getByText(kind === "questions" ? i18n.t("conversation.planUnresolvedQuestions", { count: 1 }) : i18n.t("conversation.planUnsavedProposal"))).toBeInTheDocument();
    if (kind === "questions") expect(panel.getByText("清晨的时间是否需要再核对？")).toBeInTheDocument();
    const button = panel.getByRole("button", { name: i18n.t("conversation.planPrepare") }); expect(button).toBeDisabled(); fireEvent.click(button);
    expect(calls("prepare_conversation_proposal_work_plan")).toHaveLength(0);
    expect(h.state.authorizations).toHaveLength(0); expectNoExecution();
    session.view.unmount(); session.retire();
  }
});

it("retains the complete unknown request for lookup only and reopens history without restoring permission", async () => {
  const h = harness({ unknown: true }), first = await h.open(), { panel } = await reviewSavedPlan();
  await chooseConnection(panel); await prepare(panel); fireEvent.click(finalConsent(panel));
  fireEvent.click(panel.getByRole("button", { name: i18n.t("conversation.planConfirm") }));
  await screen.findByRole("button", { name: i18n.t("conversation.check") });
  const original = structuredClone(h.state.authorizations[0]); expect(original).toBeDefined();
  expect(h.state.head.value?.pending).toMatchObject({ kind: "proposal-work-plan", request: original });
  expect(screen.queryByRole("button", { name: i18n.t("conversation.retryOriginal") })).not.toBeInTheDocument();
  first.view.unmount(); first.retire();
  const reopened = await h.open();
  expect(screen.queryByRole("region", { name: i18n.t("conversation.planPreview") })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: i18n.t("conversation.check") }));
  await screen.findByText(i18n.t("conversation.absentBlocked"));
  expect(calls("recover_conversation_proposal_work_plan")[0][1].request.authorization).toEqual(original);
  expect(h.state.head.value?.pending?.request).toEqual(original);
  expect(screen.queryByRole("button", { name: i18n.t("conversation.retryOriginal") })).not.toBeInTheDocument();
  h.state.recovery = "recorded"; fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.check") }));
  await screen.findByText(i18n.t("conversation.workPlanRecorded")); await reopened.flush();
  const history = within(await screen.findByRole("region", { name: i18n.t("conversation.planHistory") }));
  await history.findByText("根据第 1 版提议确认");
  expect(history.getByText(i18n.t("conversation.planHistoryHelp"))).toBeInTheDocument();
  expect(h.state.head.value?.pending).toBeNull(); expect(h.state.authorizations).toEqual([original]);
  fireEvent.click(await screen.findByRole("button", { name: i18n.t("conversation.planReviewOpen") }));
  expect(screen.queryByRole("region", { name: i18n.t("conversation.planPreview") })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("conversation.planConfirm") })).not.toBeInTheDocument();
  expect(calls("recover_conversation_proposal_work_plan")).toHaveLength(2); expectNoExecution();
});
