import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { canonicalConversationDraft, type ConversationDraftHead } from "../../../conversationDraftCommands";
import type { Requests } from "../../../generated/conversations.requests";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { validateResponseProposalWorkPlanReceipt } from "../../../generated/conversations.validators";
import { validateResponseWorkPlanReceipt, validateResponseWorkPlanStatus } from "../../../generated/ai.validators";
import type { WorkPlanControlRequest } from "../../../generated/ai.requests";
import { i18n } from "../../../i18n";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { connectionFixture } from "../../../testSupport/connectionFixture";
import { conversationWorkPlanFixture } from "../../../testSupport/conversationWorkPlanFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import type { WorkPlanStatusView } from "../../../workPlanCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { ConversationRunPanel } from "./ConversationRunPanel";
import { ConversationSession } from "./ConversationSession";
import type { ConversationPlanLink } from "./conversationRun";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: id(36001), sessionToken: "conversation-run-dom" }, conversationId = id(36002);
const key = { projectId: context.projectId, conversationId };
const disposals: (() => void)[] = [];
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("zh-CN"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });

function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function checkedStatus(value: unknown): WorkPlanStatusView {
  if (!validateResponseWorkPlanStatus(value)) throw new Error("Invalid synthetic run status");
  return value;
}
function harness({ state: initialState = "active", connection = false, unknownStart = false }: {
  state?: WorkPlanStatusView["state"]; connection?: boolean; unknownStart?: boolean;
} = {}) {
  const base = conversationWorkPlanFixture(key);
  const config = { ...base.config, maxRequests: 4, maxOutputTokens: 73, ...(connection ? {
    connectionProfile: { storeId: id(36003), profileId: id(36004), revision: "1", digest: "a".repeat(64) },
  } : {}) };
  const fixture = conversationWorkPlanFixture(key, config);
  const link: ConversationPlanLink = { ...fixture.prepared.proposal, planId: fixture.prepared.plan.planId,
    planDigest: fixture.prepared.plan.digest, actionId: id(36005), ordinal: "1" };
  const state = {
    head: { key, revision: "0", writerId: null, value: null } as ConversationDraftHead,
    status: checkedStatus({ plan: fixture.prepared.plan, lease: { planId: link.planId, generation: "1" }, state: initialState,
      effects: ["save-candidate"], expiresAt: String(Math.floor(Date.now() / 1000) + 3600), toolInvocations: null }),
    statusFails: false, connectionFails: false,
    authorizations: [] as Requests["authorizeProposalWorkPlan"]["authorization"][], controls: [] as WorkPlanControlRequest[],
    journalEvents: [] as string[],
  };
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "list_local_conversation_drafts") return { items: state.head.value ? [{ key, revision: state.head.revision,
      editSeq: state.head.value.editSeq, hasPending: !!state.head.value.pending }] : [], next: null };
    if (command === "read_local_conversation_draft") return structuredClone(state.head);
    if (command === "write_local_conversation_draft" || command === "resolve_local_conversation_draft") {
      const write = request.write ?? request.resolve.write;
      const response: unknown = { key, revision: String(BigInt(state.head.revision) + 1n), writerId: write.writerId,
        value: structuredClone(canonicalConversationDraft(write.value)) };
      if (!validateResponseConversationWritten(response)) throw new Error("Invalid synthetic journal response");
      state.head = response; state.journalEvents.push(response.value?.pending?.kind ?? "resolved");
      return structuredClone(response);
    }
    if (command === "validate_conversation_proposal") return structuredClone(fixture.revision);
    if (command === "read_conversation_planning") return structuredClone(fixture.run);
    if (command === "prepare_conversation_proposal_work_plan") return conversationWorkPlanFixture(key, request.config).prepared;
    if (command === "authorize_conversation_proposal_work_plan") {
      expect(state.head.value?.pending).toMatchObject({ kind: "proposal-work-plan", request: request.authorization });
      state.authorizations.push(structuredClone(request.authorization));
      const value: unknown = { link: { ...link, actionId: request.authorization.actionId }, receipt: {
        actionId: request.authorization.actionId, lease: { planId: link.planId, generation: "1" }, state: "active",
        attemptId: fixture.prepared.plan.attemptId, parentTask: null,
      } };
      if (!validateResponseProposalWorkPlanReceipt(value)) throw new Error("Invalid synthetic authorization receipt");
      state.status = checkedStatus({ ...state.status, lease: value.receipt.lease, state: "active", expiresAt: request.authorization.expiresAt });
      return value;
    }
    if (command === "read_work_plan_status") {
      if (state.statusFails) throw { code: "storage-failed", outcome: "unchanged", reason: "synthetic-read-unavailable" };
      return structuredClone(state.status);
    }
    if (command === "read_model_connections") {
      if (state.connectionFails) throw { code: "storage-failed", outcome: "unchanged", reason: "synthetic-connection-unavailable" };
      return connectionFixture([config]);
    }
    if (command === "start_work_plan") {
      expect(state.head.value?.pending).toMatchObject({ kind: "work-plan-start", request: {
        projectId: request.projectId, planId: request.planId, actionId: request.actionId, expectedGeneration: request.expectedGeneration,
      } });
      state.journalEvents.push("dispatch-start");
      if (unknownStart) throw { code: "storage-failed", outcome: "unknown", reason: "synthetic-start-acknowledgement-lost" };
      return state.head.value?.pending?.kind === "work-plan-start" ? state.head.value.pending.expectedAttemptId : null;
    }
    if (command === "control_work_plan") {
      const { sessionToken: _session, ...recorded } = request;
      expect(state.head.value?.pending).toMatchObject({ kind: "work-plan-control", request: recorded });
      state.controls.push(structuredClone(request)); state.journalEvents.push(`dispatch-${request.command}`);
      const result: unknown = { actionId: request.actionId, lease: { planId: link.planId, generation: String(BigInt(request.expectedGeneration) + 1n) },
        state: { pause: "paused", stop: "stopped", "take-over": "taken-over", continue: "active" }[request.command as WorkPlanControlRequest["command"]],
        attemptId: request.command === "continue" ? id(36006) : null, parentTask: null };
      if (!validateResponseWorkPlanReceipt(result)) throw new Error("Invalid synthetic control receipt");
      state.status = checkedStatus({ ...state.status, lease: result.lease, state: result.state, expiresAt: request.expiresAt ?? state.status.expiresAt });
      return result;
    }
    throw new Error(`Unexpected synthetic command: ${command}`);
  });
  const open = async () => {
    const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("entries");
    const owner = new ConversationSession(context, () => reads.invalidate(["execution"]), () => {});
    expect(await owner.initialize()).toBe(true); expect(await owner.open(conversationId)).toBe(true);
    function Content({ visible }: { visible: boolean }) {
      const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot), input = snapshot.inputs.get(conversationId);
      if (!input) throw new Error("Synthetic conversation input missing");
      return <ConversationRunPanel owner={owner} input={input} link={link} visible={visible} disabled={false} gate={gate} viewId="entries"/>;
    }
    const content = (visible = true) => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
      <Content visible={visible}/>
    </SessionReadProvider></ApplicationReadProvider>;
    const view = render(content());
    let retired = false;
    const retire = () => { if (!retired) { retired = true; owner.retire(); reads.retire(); gate.dispose(); } };
    disposals.push(retire);
    return { owner, reads, gate, view, retire, visible: (visible: boolean) => view.rerender(content(visible)),
      input: () => owner.getSnapshot().inputs.get(conversationId)!,
      authorize: async () => {
        await act(async () => {
          owner.beginWorkPlan(fixture.revision); owner.setWorkPlanConfig(conversationId, config);
          await owner.prepareWorkPlan(conversationId);
          expect(owner.getSnapshot().inputs.get(conversationId)?.workPlan.prepared).not.toBeNull();
          owner.setWorkPlanConsent(conversationId, true);
          await owner.authorizeWorkPlan(conversationId, { effects: ["save-candidate"], checkerExecutions: [], toolExecution: false, applicationToolExecutions: [] });
          expect(await owner.flush()).toBe(true);
        });
        expect(state.authorizations).toHaveLength(1);
      },
      flush: async () => { await act(async () => { expect(await owner.flush()).toBe(true); }); },
    };
  };
  return { ...fixture, config, link, state, open };
}
async function expand() {
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runShow") }));
  await screen.findByRole("heading", { name: i18n.t("conversation.runStateActive") });
}

it("observes only after expansion, keeps history powerless and recovers a failed status refresh", async () => {
  const h = harness(); await h.open();
  expect(screen.getByRole("button", { name: i18n.t("conversation.runShow") })).toHaveAttribute("aria-expanded", "false");
  expect(calls("read_work_plan_status")).toHaveLength(0);
  await expand();
  expect(screen.getByText(i18n.t("conversation.runProgressUnknown"))).toBeVisible();
  expect(screen.getByText(i18n.t("conversation.runUsageUnknown"))).toBeVisible();
  expect(screen.getByText(i18n.t("conversation.runNeedsConfirmation"))).toBeVisible();
  const start = screen.getByRole("button", { name: i18n.t("conversation.runStart") });
  expect(start).toBeDisabled(); fireEvent.click(start);
  expect(calls("start_work_plan")).toHaveLength(0);
  h.state.statusFails = true; fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runRefresh") }));
  await screen.findByText(i18n.t("conversation.runReadFailed"));
  expect(screen.queryByRole("button", { name: i18n.t("conversation.runPause") })).not.toBeInTheDocument();
  h.state.statusFails = false; fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runRefresh") }));
  await screen.findByRole("button", { name: i18n.t("conversation.runPause") });
  expect(screen.queryByText(i18n.t("conversation.runReadFailed"))).not.toBeInTheDocument();
  expect(calls("control_work_plan")).toHaveLength(0);
});

it("starts only after a fresh direct authorization and journals the original request before dispatch", async () => {
  const h = harness(), session = await h.open(); await session.authorize();
  expect(calls("start_work_plan")).toHaveLength(0);
  expect(calls("read_work_plan_status")).toHaveLength(0);
  await expand();
  const start = screen.getByRole("button", { name: i18n.t("conversation.runStart") });
  await waitFor(() => expect(start).toBeEnabled()); fireEvent.click(start); fireEvent.click(start);
  await waitFor(() => expect(session.input().notice).toBe("runStarted")); await session.flush();
  expect(calls("start_work_plan")).toHaveLength(1);
  expect(calls("start_work_plan")[0][1].request).toMatchObject({ actionId: h.state.authorizations[0].actionId, expectedGeneration: "1", planId: h.link.planId });
  expect(h.state.journalEvents.indexOf("work-plan-start")).toBeLessThan(h.state.journalEvents.indexOf("dispatch-start"));
  expect(h.state.head.value?.pending).toBeNull(); expect(start).toBeDisabled();
});

it("allows pause and stop without a current connection or renewed execution consent, and never continues a stopped plan", async () => {
  const h = harness({ connection: true }), session = await h.open(); h.state.connectionFails = true;
  await expand(); await screen.findByText(i18n.t("conversation.runConnectionChanged"));
  const pause = screen.getByRole("button", { name: i18n.t("conversation.runPause") });
  expect(pause).toBeEnabled(); fireEvent.click(pause);
  await screen.findByRole("heading", { name: i18n.t("conversation.runStatePaused") }); await session.flush();
  expect(h.state.controls[0]).toMatchObject({ command: "pause", confirmed: false, expiresAt: null, checkerExecutions: [], toolExecution: false, applicationToolExecutions: [] });
  expect(screen.getByText(i18n.t("conversation.runControlHelp"))).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runStop") }));
  await screen.findByRole("heading", { name: i18n.t("conversation.runStateStopped") }); await session.flush();
  expect(h.state.controls.map(request => request.command)).toEqual(["pause", "stop"]);
  expect(screen.getByText(i18n.t("conversation.runStoppedHelp"))).toBeVisible();
  expect(screen.queryByRole("button", { name: i18n.t("conversation.runReviewContinue") })).not.toBeInTheDocument();
  expect(calls("start_work_plan")).toHaveLength(0);
});

it("discloses the fixed continuation material and cumulative budget, clears consent on expiry edits and confirms without starting", async () => {
  const h = harness({ state: "paused" }), session = await h.open();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runShow") }));
  fireEvent.click(await screen.findByRole("button", { name: i18n.t("conversation.runReviewContinue") }));
  const panel = within(screen.getByRole("region", { name: i18n.t("conversation.runContinueTitle") }));
  expect(panel.getByText(i18n.t("conversation.runScope", { count: 1, locale: "zh-CN" }))).toBeVisible();
  expect(panel.getByText("Barrel {name}")).toBeVisible();
  expect(panel.getByText("barrel → 木桶 👩🏽‍💻 é")).toBeVisible();
  expect(panel.getByText("Translator note 中文 👩🏽‍💻 é")).toBeVisible();
  expect(panel.getByText(i18n.t("conversation.runDestination", { endpoint: h.config.endpoint, model: h.config.model }))).toBeVisible();
  expect(panel.getByText(i18n.t("conversation.runEffectSaveCandidate"))).toBeVisible();
  expect(panel.getByText(i18n.t("conversation.runCumulativeBudget"))).toBeVisible();
  expect(panel.getByText(i18n.t("connections.invocationSummary", { items: String(h.config.maxItems), requests: "4", concurrency: String(h.config.concurrency),
    tokens: "73", retries: String(h.config.maxRetries), timeout: String(h.config.timeoutSeconds) }))).toBeVisible();
  const consent = panel.getByRole("checkbox", { name: i18n.t("conversation.runConsent") });
  const confirm = panel.getByRole("button", { name: i18n.t("conversation.runConfirmContinue") });
  expect(consent).not.toBeChecked(); expect(confirm).toBeDisabled();
  expect(panel.getByText(i18n.t("conversation.runContinueNoStart"))).toBeVisible();
  fireEvent.click(consent);
  const minutes = panel.getByRole("spinbutton", { name: i18n.t("conversation.runMinutes") });
  fireEvent.change(minutes, { target: { value: "0" } });
  expect(consent).not.toBeChecked(); expect(consent).toBeDisabled(); expect(confirm).toBeDisabled();
  expect(panel.getByText(i18n.t("conversation.runMinutesInvalid"))).toBeVisible();
  fireEvent.change(minutes, { target: { value: "7" } }); expect(consent).not.toBeChecked();
  fireEvent.click(consent); const before = Math.floor(Date.now() / 1000); fireEvent.click(confirm);
  await screen.findByRole("heading", { name: i18n.t("conversation.runStateActive") }); await session.flush();
  expect(h.state.controls).toHaveLength(1);
  expect(h.state.controls[0]).toMatchObject({ command: "continue", confirmed: true, checkerExecutions: [], toolExecution: false, applicationToolExecutions: [] });
  expect(Number(h.state.controls[0].expiresAt)).toBeGreaterThanOrEqual(before + 420);
  expect(Number(h.state.controls[0].expiresAt)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 420);
  expect(h.state.status.plan.preview?.config).toEqual(h.config);
  expect(calls("start_work_plan")).toHaveLength(0);
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("conversation.runStart") })).toBeEnabled());
});

it("blocks dispatch during composition, another dialog, collapse and hiding while releasing the input owner", async () => {
  const h = harness(), session = await h.open(); await session.authorize(); await expand();
  let start = screen.getByRole("button", { name: i18n.t("conversation.runStart") });
  await waitFor(() => expect(start).toBeEnabled());
  start.focus(); expect(session.gate.getSnapshot().inputOwner).not.toBeNull();
  fireEvent.compositionStart(start); fireEvent.click(start);
  expect(calls("start_work_plan")).toHaveLength(0);
  fireEvent.compositionEnd(start);
  const closeDialog = session.gate.pushDialog("another-dialog"); fireEvent.click(start); closeDialog();
  expect(calls("start_work_plan")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runHide") })); fireEvent.click(start);
  expect(session.gate.getSnapshot().inputOwner).toBeNull();
  expect(session.gate.getSnapshot().composingOwners).toEqual([]);
  expect(calls("control_work_plan")).toHaveLength(0); expect(calls("start_work_plan")).toHaveLength(0);
  await expand(); start = screen.getByRole("button", { name: i18n.t("conversation.runStart") });
  start.focus(); fireEvent.compositionStart(start); session.visible(false); fireEvent.click(start);
  expect(session.gate.getSnapshot().inputOwner).toBeNull(); expect(session.gate.getSnapshot().composingOwners).toEqual([]);
  expect(calls("start_work_plan")).toHaveLength(0);
  session.visible(true);
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("conversation.runStart") })).toBeEnabled());
  expect(session.owner.canStartRun(conversationId, h.state.status)).toBe(true);
});

it("retains an unresolved original start and prevents a second start or control request", async () => {
  const h = harness({ unknownStart: true }), session = await h.open(); await session.authorize(); await expand();
  const start = screen.getByRole("button", { name: i18n.t("conversation.runStart") });
  await waitFor(() => expect(start).toBeEnabled()); fireEvent.click(start);
  await screen.findByText(i18n.t("conversation.runPending"));
  await waitFor(() => expect(session.input().outcome).toBe("unknown"));
  const original = structuredClone(h.state.head.value?.pending);
  expect(original?.kind).toBe("work-plan-start");
  const pause = screen.getByRole("button", { name: i18n.t("conversation.runPause") });
  expect(start).toBeDisabled(); expect(pause).toBeDisabled(); fireEvent.click(start); fireEvent.click(pause);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runRefresh") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("conversation.runRefresh") })).toBeEnabled());
  expect(h.state.head.value?.pending).toEqual(original);
  expect(calls("start_work_plan")).toHaveLength(1); expect(calls("control_work_plan")).toHaveLength(0);
});
