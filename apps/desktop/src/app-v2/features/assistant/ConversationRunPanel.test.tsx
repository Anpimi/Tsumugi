import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import executionWire from "../../../../test/fixtures/executionCommands.contract.json";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { canonicalConversationDraft, type ConversationDraftHead } from "../../../conversationDraftCommands";
import type { AttemptDetail } from "../../../executionCommands";
import type { Requests } from "../../../generated/conversations.requests";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { validateResponseProposalWorkPlanReceipt } from "../../../generated/conversations.validators";
import { validateResponseWorkPlanReceipt, validateResponseWorkPlanRun, validateResponseWorkPlanStatus, validateResponseWorkPlanStartSettlement, validateResponseWorkPlanControlSettlement } from "../../../generated/ai.validators";
import { validateResponseAttempt } from "../../../generated/execution.validators";
import type { WorkPlanControlRequest } from "../../../generated/ai.requests";
import type { ProviderBudget } from "../../../generated/ai.responses";
import { i18n } from "../../../i18n";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { connectionFixture } from "../../../testSupport/connectionFixture";
import { conversationWorkPlanFixture } from "../../../testSupport/conversationWorkPlanFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { teamExecutionStatusFixture } from "../../../testSupport/teamExecutionFixture";
import { unreportedTokenTotalsFixture } from "../../../testSupport/usageFixture";
import type { WorkPlanRunView, WorkPlanStatusView } from "../../../workPlanCommands";
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
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function checkedStatus(value: unknown): WorkPlanStatusView {
  if (!validateResponseWorkPlanStatus(value)) throw new Error("Invalid synthetic run status");
  return value;
}
function checkedRun(value: unknown): WorkPlanRunView {
  if (!validateResponseWorkPlanRun(value)) throw new Error("Invalid synthetic run record");
  return value;
}
function checkedAttempt(value: unknown): AttemptDetail {
  if (!validateResponseAttempt(value)) throw new Error("Invalid synthetic execution attempt");
  return value;
}
function cumulativeBudget(): ProviderBudget {
  return { limit: 4, dispatched: 3, legacyHeld: 0, unresolved: 1, usageUnknown: 2,
    promptTokens: "9007199254740993", completionTokens: "73", ...unreportedTokenTotalsFixture(3) };
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
    statusFails: false, connectionFails: false, controlFails: false, journalFails: false,
    controlSettlements: new Map<string, "recorded" | "pending" | "fenced-not-applied">(),
    authorizations: [] as Requests["authorizeProposalWorkPlan"]["authorization"][], controls: [] as WorkPlanControlRequest[],
    journalEvents: [] as string[],
    run: checkedRun({ projectId: context.projectId, planId: link.planId, planDigest: link.planDigest,
      lease: { planId: link.planId, generation: "1" }, state: initialState, lastStart: null, budgetRootTaskId: id(36007), budget: null }),
    runFails: false,
    detail: checkedAttempt({ ...structuredClone(executionWire.detail), attemptId: fixture.prepared.plan.attemptId, taskId: id(36008),
      progress: { total: 8, succeeded: 3, failed: 1, unknown: 1, queued: 1, running: 1, cancelled: 1, adopted: 2 },
      recovery: { ...structuredClone(executionWire.detail.recovery), attemptId: fixture.prepared.plan.attemptId }, nextOffset: 1 }),
  };
  const journal = { active: 0, maximum: 0, acknowledge: vi.fn(async () => {}) };
  const acknowledgements = new Map<string, ConversationDraftHead>();
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "read_context_strategy_default") return null;
    if (command === "list_local_conversation_drafts") return { items: state.head.value ? [{ key, revision: state.head.revision,
      editSeq: state.head.value.editSeq, hasPending: !!state.head.value.pending || !!state.head.value.revocations?.length }] : [], next: null };
    if (command === "read_local_conversation_draft") return structuredClone(state.head);
    if (command === "write_local_conversation_draft" || command === "resolve_local_conversation_draft") {
      journal.active++; journal.maximum = Math.max(journal.maximum, journal.active);
      try {
        expect(journal.active).toBe(1);
        if (state.journalFails) throw { code: "storage-failed", outcome: "unknown", reason: "synthetic-journal-unavailable" };
        const write = request.write ?? request.resolve.write, identity = JSON.stringify({ command, request }), retry = acknowledgements.get(identity);
        if (retry) { await journal.acknowledge(); return structuredClone(retry); }
        expect(write.expectedRevision).toBe(state.head.revision);
        const response: unknown = { key, revision: String(BigInt(state.head.revision) + 1n), writerId: write.writerId,
          value: structuredClone(canonicalConversationDraft(write.value)) };
        if (!validateResponseConversationWritten(response)) throw new Error("Invalid synthetic journal response");
        state.head = response; acknowledgements.set(identity, structuredClone(response));
        state.journalEvents.push(response.value?.revocations?.length ? "revocation" : response.value?.pending?.kind ?? "resolved");
        await journal.acknowledge(); return structuredClone(response);
      } finally { journal.active--; }
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
      state.run = checkedRun({ ...state.run, lease: value.receipt.lease, state: "active" });
      return value;
    }
    if (command === "read_work_plan_status") {
      if (state.statusFails) throw { code: "storage-failed", outcome: "unchanged", reason: "synthetic-read-unavailable" };
      return structuredClone(state.status);
    }
    if (command === "read_work_plan_run") {
      if (state.runFails) throw { code: "storage-failed", outcome: "unchanged", reason: "synthetic-run-record-unavailable" };
      return structuredClone(state.run);
    }
    if (command === "read_work_plan_start_settlement") {
      const { sessionToken: _session, ...original } = request;
      const response: unknown = { request: original, settlement: { projectId: request.projectId, planId: request.planId,
        lease: state.status.lease, state: state.status.state, outcome: { kind: "pending" } } };
      if (!validateResponseWorkPlanStartSettlement(response)) throw new Error("Invalid synthetic start settlement"); return response;
    }
    if (command === "read_work_plan_control_settlement") {
      const { sessionToken: _session, ...original } = request, kind = state.controlSettlements.get(request.actionId) ?? "pending";
      const response: unknown = { request: original, settlement: { projectId: request.projectId, planId: request.planId,
        lease: state.status.lease, state: state.status.state, outcome: kind === "recorded" ? { kind, receipt: {
          actionId: request.actionId, lease: { planId: request.planId, generation: String(BigInt(request.expectedGeneration) + 1n) },
          state: { pause: "paused", stop: "stopped", "take-over": "taken-over", continue: "active" }[request.command as WorkPlanControlRequest["command"]],
          attemptId: request.command === "continue" ? id(36006) : null, parentTask: null,
        } } : { kind } } };
      if (!validateResponseWorkPlanControlSettlement(response)) throw new Error("Invalid synthetic control settlement"); return response;
    }
    if (command === "read_execution_attempt") {
      return structuredClone(state.detail);
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
      const pending = state.head.value?.pending;
      if (pending?.kind !== "work-plan-start") throw new Error("Missing synthetic original start request");
      state.run = checkedRun({ ...state.run, lastStart: { projectId: request.projectId, planId: request.planId, actionId: request.actionId,
        expectedGeneration: request.expectedGeneration, taskId: id(36008), attemptId: pending.expectedAttemptId }, budget: state.run.budget ?? cumulativeBudget() });
      state.detail = checkedAttempt({ ...state.detail, attemptId: pending.expectedAttemptId, taskId: id(36008),
        recovery: { ...state.detail.recovery, attemptId: pending.expectedAttemptId } });
      return pending.expectedAttemptId;
    }
    if (command === "control_work_plan") {
      const { sessionToken: _session, ...recorded } = request;
      if (request.command === "continue") expect(state.head.value?.pending).toMatchObject({ kind: "work-plan-control", request: recorded });
      else expect(state.head.value?.revocations).toContainEqual(expect.objectContaining({ request: {
        projectId: request.projectId, planId: request.planId, actionId: request.actionId, expectedGeneration: request.expectedGeneration, command: request.command,
      } }));
      state.controls.push(structuredClone(request)); state.journalEvents.push(`dispatch-${request.command}`);
      if (state.controlFails) throw { code: "storage-failed", outcome: "unknown", reason: "synthetic-control-acknowledgement-lost" };
      const result: unknown = { actionId: request.actionId, lease: { planId: link.planId, generation: String(BigInt(request.expectedGeneration) + 1n) },
        state: { pause: "paused", stop: "stopped", "take-over": "taken-over", continue: "active" }[request.command as WorkPlanControlRequest["command"]],
        attemptId: request.command === "continue" ? id(36006) : null, parentTask: null };
      if (!validateResponseWorkPlanReceipt(result)) throw new Error("Invalid synthetic control receipt");
      state.status = checkedStatus({ ...state.status, lease: result.lease, state: result.state, expiresAt: request.expiresAt ?? state.status.expiresAt });
      state.run = checkedRun({ ...state.run, lease: result.lease, state: result.state });
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
          await owner.loadWorkPlanStrategyDefault(conversationId, reads);
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
  // A history record is observation data and never seeds the Session's readyRuns.
  const recordEarlierStart = () => {
    state.status = checkedStatus({ ...state.status, lease: { ...state.status.lease, generation: "2" } });
    state.run = checkedRun({ ...state.run, lease: state.status.lease,
      lastStart: { projectId: context.projectId, planId: link.planId, actionId: link.actionId, expectedGeneration: "1",
        taskId: state.detail.taskId, attemptId: state.detail.attemptId }, budget: cumulativeBudget() });
  };
  return { ...fixture, config, link, state, open, recordEarlierStart, journal };
}
async function expand() {
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runShow") }));
  await screen.findByRole("heading", { name: i18n.t("conversation.runStateActive") });
}

it("observes only after expansion, keeps history powerless and recovers a failed status refresh", async () => {
  const h = harness(); await h.open();
  expect(screen.getByRole("button", { name: i18n.t("conversation.runShow") })).toHaveAttribute("aria-expanded", "false");
  expect(calls("read_work_plan_status")).toHaveLength(0);
  expect(calls("read_work_plan_run")).toHaveLength(0); expect(calls("read_execution_attempt")).toHaveLength(0);
  await expand();
  expect(await screen.findByText(i18n.t("conversation.runNotStarted"))).toBeVisible();
  expect(screen.getByText(i18n.t("conversation.runBudgetMissing"))).toBeVisible();
  expect(calls("read_execution_attempt")).toHaveLength(0);
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
  await screen.findByText(i18n.t("conversation.runNotStarted"));
  expect(screen.getByText(i18n.t("conversation.runEventAuthorized"))).toBeVisible();
  expect(calls("read_execution_attempt")).toHaveLength(0);
  const start = screen.getByRole("button", { name: i18n.t("conversation.runStart") });
  await waitFor(() => expect(start).toBeEnabled()); fireEvent.click(start); fireEvent.click(start);
  await waitFor(() => expect(session.input().notice).toBe("runStarted")); await session.flush();
  expect(calls("start_work_plan")).toHaveLength(1);
  expect(calls("start_work_plan")[0][1].request).toMatchObject({ actionId: h.state.authorizations[0].actionId, expectedGeneration: "1", planId: h.link.planId });
  expect(h.state.journalEvents.indexOf("work-plan-start")).toBeLessThan(h.state.journalEvents.indexOf("dispatch-start"));
  expect(h.state.head.value?.pending).toBeNull(); expect(start).toBeDisabled();
  expect(await screen.findByText(i18n.t("conversation.runProgressCounts", { ...h.state.detail.progress }))).toBeVisible();
  expect(screen.getByText(i18n.t("conversation.runEventStarted"))).toBeVisible();
  expect(h.state.detail.items).toHaveLength(1);
  expect(calls("read_execution_attempt")[0][1].request).toEqual({ ...context, attemptId: h.prepared.plan.attemptId, offset: 0, limit: 1 });
  expect(screen.getByText(i18n.t("conversation.runProgressResultHelp"))).toBeVisible();
  expect(screen.queryByText(i18n.t("conversation.runNotStarted"))).not.toBeInTheDocument();
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

it("retains an unresolved original start while an independent pause waits for its durable acknowledgement", async () => {
  const h = harness({ unknownStart: true }), session = await h.open(); await session.authorize(); await expand();
  const start = screen.getByRole("button", { name: i18n.t("conversation.runStart") });
  await waitFor(() => expect(start).toBeEnabled()); fireEvent.click(start);
  await screen.findByText(i18n.t("conversation.runPending"));
  await waitFor(() => expect(session.input().outcome).toBe("unknown"));
  const original = structuredClone(h.state.head.value?.pending);
  expect(original?.kind).toBe("work-plan-start");
  const pause = screen.getByRole("button", { name: i18n.t("conversation.runPause") });
  expect(start).toBeDisabled(); expect(pause).toBeEnabled(); fireEvent.click(start);
  const durable = deferred<void>(); h.journal.acknowledge.mockImplementationOnce(async () => durable.promise);
  fireEvent.click(pause); await waitFor(() => expect(session.input().journalBusy).toBe(true));
  expect(pause).toBeDisabled(); expect(screen.getByRole("button", { name: i18n.t("conversation.runStop") })).toBeDisabled();
  expect(calls("control_work_plan")).toHaveLength(0);
  act(() => session.owner.edit(conversationId, "Message B while pause is being saved"));
  await act(async () => { durable.resolve(); });
  await screen.findByRole("heading", { name: i18n.t("conversation.runStatePaused") }); await session.flush();
  expect(h.state.head.value?.pending).toEqual(original);
  expect(h.state.head.value?.text).toBe("Message B while pause is being saved");
  expect(calls("start_work_plan")).toHaveLength(1); expect(calls("control_work_plan")).toHaveLength(1);
  expect(h.state.controls[0]).toMatchObject({ command: "pause", confirmed: false, expectedGeneration: "1", expiresAt: null });
  expect(session.input().notice).toBe("runPaused"); expect(h.journal.maximum).toBe(1);
});

it.each(["recorded", "fenced-not-applied"] as const)("checks a reopened unknown withdrawal as %s without replaying or presenting the other settlement", async kind => {
  const h = harness({ unknownStart: true }), first = await h.open(); await first.authorize(); await expand();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runStart") }));
  await waitFor(() => expect(first.input().outcome).toBe("unknown"));
  const primary = structuredClone(first.input().value.pending); h.state.controlFails = true;
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runPause") }));
  const unknown = await screen.findByRole("region", { name: i18n.t("conversation.runRevocationPause") });
  await within(unknown).findByText(i18n.t("conversation.runRevocationUnknown"));
  const slot = first.input().value.revocations?.[0]; if (!slot) throw new Error("Missing synthetic unknown pause");
  act(() => first.owner.edit(conversationId, "Message B retained across reopening")); await first.flush();
  first.view.unmount(); first.retire();
  h.state.controlSettlements.set(slot.request.actionId, kind);
  h.state.status = checkedStatus({ ...h.state.status, lease: { ...h.state.status.lease, generation: "2" }, state: kind === "recorded" ? "paused" : "stopped" });
  const reopened = await h.open();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runShow") }));
  const row = await screen.findByRole("region", { name: i18n.t("conversation.runRevocationPause") });
  expect(calls("read_work_plan_control_settlement")).toHaveLength(0); expect(calls("control_work_plan")).toHaveLength(1);
  fireEvent.click(within(row).getByRole("button", { name: i18n.t("conversation.runRevocationCheck") }));
  await waitFor(() => expect(screen.queryByRole("region", { name: i18n.t("conversation.runRevocationPause") })).not.toBeInTheDocument());
  await reopened.flush();
  expect(reopened.input().notice).toBe(kind === "recorded" ? "runPaused" : "runNotApplied");
  expect(reopened.input().notice).not.toBe(kind === "recorded" ? "runNotApplied" : "runPaused");
  expect(reopened.input().value).toMatchObject({ pending: primary, text: "Message B retained across reopening" });
  expect(reopened.input().readyRuns.size).toBe(0);
  expect(calls("read_work_plan_control_settlement")[0][1].request).toEqual({ ...context, ...slot.request,
    confirmed: false, checkerExecutions: [], toolExecution: false, applicationToolExecutions: [], expiresAt: null });
  expect(calls("resolve_local_conversation_draft").at(-1)?.[1].request.resolve).toMatchObject({ target: { kind: "revocation", revocation: slot }, disposition: kind });
  expect(calls("control_work_plan")).toHaveLength(1); expect(calls("start_work_plan")).toHaveLength(1);
});

it("blocks withdrawing controls after a journal error and requires explicit retry after journal recovery", async () => {
  const h = harness({ unknownStart: true }), session = await h.open(); await session.authorize(); await expand();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runStart") }));
  await waitFor(() => expect(session.input().outcome).toBe("unknown"));
  h.state.journalFails = true;
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runPause") }));
  await waitFor(() => expect(session.input().failure?.kind).toBe("journal"));
  const row = screen.getByRole("region", { name: i18n.t("conversation.runRevocationPause") });
  expect(within(row).getByRole("button", { name: i18n.t("conversation.runRevocationCheck") })).toBeDisabled();
  expect(screen.getByRole("button", { name: i18n.t("conversation.runStop") })).toBeDisabled();
  expect(screen.getByRole("button", { name: i18n.t("conversation.runTakeOver") })).toBeDisabled();
  expect(calls("control_work_plan")).toHaveLength(0);
  h.state.journalFails = false; await act(async () => { await session.owner.retryJournal(conversationId); });
  expect(calls("control_work_plan")).toHaveLength(0);
  fireEvent.click(within(row).getByRole("button", { name: i18n.t("conversation.runRevocationCheck") }));
  await within(row).findByText(i18n.t("conversation.runRevocationAbsent"));
  expect(calls("control_work_plan")).toHaveLength(0);
  fireEvent.click(within(row).getByRole("button", { name: i18n.t("conversation.runRevocationRetry") }));
  await screen.findByRole("heading", { name: i18n.t("conversation.runStatePaused") }); await session.flush();
  expect(calls("control_work_plan")).toHaveLength(1); expect(calls("start_work_plan")).toHaveLength(1);
  expect(session.input().value.pending?.kind).toBe("work-plan-start");
});

it("keeps the earlier started work and cumulative unknown usage after confirming continuation without a new start", async () => {
  const h = harness({ state: "paused" }); h.recordEarlierStart();
  const earlier = structuredClone(h.state.run.lastStart), budget = structuredClone(h.state.run.budget);
  if (!budget || !earlier) throw new Error("Missing synthetic started work and cumulative budget");
  const session = await h.open();
  expect(calls("read_execution_attempt")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runShow") }));
  expect(await screen.findByText(i18n.t("conversation.runEarlierStart"))).toBeVisible();
  await screen.findByText(i18n.t("conversation.runProgressCounts", { ...h.state.detail.progress }));
  const usage = within(screen.getByRole("region", { name: i18n.t("conversation.runBudgetTitle") }));
  expect(usage.getByText(i18n.t("ai.budgetSummary", { limit: String(budget.limit), dispatched: String(budget.dispatched), unresolved: String(budget.unresolved), usageUnknown: String(budget.usageUnknown) }))).toBeVisible();
  expect(usage.getByText(i18n.t("ai.budgetUsage", { ...budget }))).toBeVisible();
  fireEvent.click(usage.getByText(i18n.t("ai.usageDetails.title")));
  expect(usage.getAllByText(i18n.t("ai.usageDetails.partial", { tokens: "0", requests: "3" }))).toHaveLength(3);
  expect(usage.queryByText(i18n.t("ai.usageDetails.reported", { tokens: "0" }))).not.toBeInTheDocument();
  expect(usage.getByText(i18n.t("ai.usageDetails.billingUnknown"))).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runReviewContinue") }));
  const review = within(screen.getByRole("region", { name: i18n.t("conversation.runContinueTitle") }));
  fireEvent.click(review.getByRole("checkbox", { name: i18n.t("conversation.runConsent") }));
  fireEvent.click(review.getByRole("button", { name: i18n.t("conversation.runConfirmContinue") }));
  await screen.findByRole("heading", { name: i18n.t("conversation.runStateActive") }); await session.flush();
  expect(await screen.findByText(i18n.t("conversation.runEarlierStart"))).toBeVisible();
  expect(h.state.run.lastStart).toEqual(earlier); expect(h.state.run.budget).toEqual(budget);
  expect(usage.getByText(i18n.t("ai.budgetUsage", { ...budget }))).toBeVisible();
  expect(calls("read_execution_attempt").every(([, { request }]) => request.attemptId === earlier.attemptId && request.offset === 0 && request.limit === 1)).toBe(true);
  expect(calls("start_work_plan")).toHaveLength(0);
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("conversation.runStart") })).toBeEnabled());
});

it("rejects a different plan digest and mismatched attempt associations or contradictory progress without displaying their data", async () => {
  const h = harness(); h.recordEarlierStart(); h.state.run.planDigest = "b".repeat(64);
  await h.open(); await expand();
  await screen.findByText(i18n.t("conversation.runRecordFailed"));
  expect(calls("read_execution_attempt")).toHaveLength(0);
  expect(screen.queryByRole("region", { name: i18n.t("conversation.runBudgetTitle") })).not.toBeInTheDocument();
  h.state.run.planDigest = h.link.planDigest;
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runRefreshRecord") }));
  const original = structuredClone(h.state.detail), progress = i18n.t("conversation.runProgressCounts", { ...original.progress });
  await screen.findByText(progress);
  const changes: ((value: AttemptDetail) => AttemptDetail)[] = [
    value => ({ ...value, taskId: id(36009) }),
    value => ({ ...value, attemptId: id(36010) }),
    value => ({ ...value, recovery: { ...value.recovery, attemptId: id(36011) } }),
    value => ({ ...value, progress: { ...value.progress, total: value.progress.total + 1 } }),
  ];
  for (const change of changes) {
    h.state.detail = checkedAttempt(change(structuredClone(original)));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runRefreshProgress") }));
    await screen.findByText(i18n.t("conversation.runProgressFailed"));
    expect(screen.queryByText(progress)).not.toBeInTheDocument();
    h.state.detail = structuredClone(original);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runRefreshProgress") }));
    await screen.findByText(progress);
    expect(screen.queryByText(i18n.t("conversation.runProgressFailed"))).not.toBeInTheDocument();
  }
  expect(calls("start_work_plan")).toHaveLength(0); expect(calls("control_work_plan")).toHaveLength(0);
});

it("keeps pause and stop available through failed or out-of-date run reads and stops observation while hidden", async () => {
  const h = harness(); h.recordEarlierStart(); h.state.runFails = true;
  const session = await h.open(); await expand();
  await screen.findByText(i18n.t("conversation.runRecordFailed"));
  expect(calls("read_execution_attempt")).toHaveLength(0);
  const pause = screen.getByRole("button", { name: i18n.t("conversation.runPause") });
  expect(pause).toBeEnabled(); fireEvent.click(pause);
  await screen.findByRole("heading", { name: i18n.t("conversation.runStatePaused") }); await session.flush();
  h.state.runFails = false; h.state.run = checkedRun({ ...h.state.run, state: "active" });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.runRefreshRecord") }));
  await screen.findByText(i18n.t("conversation.runRecordChanged"));
  expect(screen.queryByRole("region", { name: i18n.t("conversation.runProgressTitle") })).not.toBeInTheDocument();
  expect(calls("read_execution_attempt")).toHaveLength(0);
  const stop = screen.getByRole("button", { name: i18n.t("conversation.runStop") });
  expect(stop).toBeEnabled(); fireEvent.click(stop);
  await screen.findByRole("heading", { name: i18n.t("conversation.runStateStopped") }); await session.flush();
  await screen.findByText(i18n.t("conversation.runProgressCounts", { ...h.state.detail.progress }));
  await waitFor(() => expect(session.reads.client.isFetching()).toBe(0));
  const refreshStatus = screen.getByRole("button", { name: i18n.t("conversation.runRefresh") });
  const refreshProgress = screen.getByRole("button", { name: i18n.t("conversation.runRefreshProgress") });
  const observedCommands = ["read_work_plan_status", "read_work_plan_run", "read_execution_attempt"];
  const before = observedCommands.map(command => calls(command).length);
  session.visible(false); fireEvent.click(refreshStatus); fireEvent.click(refreshProgress);
  act(() => session.reads.invalidate(["execution"]));
  expect(observedCommands.map(command => calls(command).length)).toEqual(before);
  expect(h.state.controls.map(request => request.command)).toEqual(["pause", "stop"]);
  expect(calls("start_work_plan")).toHaveLength(0);
});

it("shows the team's accumulated root budget without presenting one root attempt as the whole team's progress", async () => {
  const h = harness(), team = teamExecutionStatusFixture(), budget = { ...cumulativeBudget(), limit: 20 };
  expect(team.plan.planId).toBe(h.link.planId); expect(team.plan.digest).toBe(h.link.planDigest);
  h.state.status = checkedStatus({ ...team, expiresAt: h.state.status.expiresAt }); h.recordEarlierStart();
  h.state.run = checkedRun({ ...h.state.run, budget });
  await h.open(); await expand();
  expect(await screen.findByRole("button", { name: i18n.t("conversationTeam.show") })).toHaveAttribute("aria-expanded", "false");
  const usage = within(screen.getByRole("region", { name: i18n.t("conversation.runBudgetTitle") }));
  expect(usage.getByText(i18n.t("ai.budgetSummary", { limit: String(budget.limit), dispatched: String(budget.dispatched), unresolved: String(budget.unresolved), usageUnknown: String(budget.usageUnknown) }))).toBeVisible();
  expect(usage.getByText(i18n.t("ai.usageDetails.billingUnknown"))).toBeVisible();
  expect(screen.queryByRole("region", { name: i18n.t("conversation.runProgressTitle") })).not.toBeInTheDocument();
  expect(calls("read_execution_attempt")).toHaveLength(0);
  expect(invoke.mock.calls.map(([command]) => command).filter(command => ![
    "list_local_conversation_drafts", "read_local_conversation_draft", "read_work_plan_status", "read_work_plan_run",
  ].includes(command))).toEqual([]);
});
