import { useSyncExternalStore } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { canonicalConversationDraft, type ConversationDraftHead } from "../../../conversationDraftCommands";
import { validateRequestWorkPlanTeamRecoveryPrepare, validateRequestWorkPlanTeamRecoveryAuthorize } from "../../../generated/ai.validators";
import type { WorkPlanTeamRecoveryPreviewView } from "../../../generated/ai.responses";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { i18n } from "../../../i18n";
import { conversationTeamRecoveryEn, conversationTeamRecoveryZh } from "../../../i18n/conversationTeamRecovery";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { connectionFixture } from "../../../testSupport/connectionFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { teamContext } from "../../../testSupport/teamDiscussionFixture";
import { teamRecoveryFixture, teamRecoveryPreviewFixture, teamRecoveryReceiptFixture } from "../../../testSupport/teamRecoveryFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { ConversationSession } from "./ConversationSession";
import { ConversationTeamRecovery } from "./ConversationTeamRecovery";
import type { ConversationPlanLink } from "./conversationRun";
import { initialConversationRecoveryDraft } from "./conversationRecovery";

const invoke = vi.hoisted(() => vi.fn<(command: string, args: unknown) => Promise<unknown>>(async () => { throw new Error("Unexpected native or external request"); }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
type TextKey = keyof typeof conversationTeamRecoveryEn;
const t = (key: TextKey, values: Record<string, string | number> = {}) => i18n.t(`conversationTeamRecovery.${key}`, values);
const disposals: (() => void)[] = [];
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });

async function harness(unresolved = false) {
  const source = teamRecoveryFixture(), context = { ...teamContext }, conversationId = id(65100), key = { projectId: context.projectId, conversationId };
  // Pausing advances the current lease without rewriting the earlier effective roster or its historical roles.
  source.status.lease = { ...source.status.lease, generation: String(BigInt(source.view.effectiveVersion.lease.generation) + 1n) };
  source.state.state.lease = structuredClone(source.status.lease);
  const link: ConversationPlanLink = { ...key, planId: source.status.plan.planId, planDigest: source.status.plan.digest,
    actionId: source.view.effectiveVersion.actionId, proposalId: id(65101), revisionId: id(65102), ordinal: "1" };
  const draft = initialConversationRecoveryDraft(source.status.plan, source.view, "1");
  draft.instructions = "Saved human A {{literal}} 中文 instructions.";
  if (unresolved) source.state.state.unresolvedWork = [{ taskId: id(65103), attemptId: id(65104), inputDigest: "c".repeat(64) }];
  let head: ConversationDraftHead = { key, revision: "1", writerId: id(65105), value: { text: "Unrelated conversation text", editSeq: "1", pending: null,
    teamDrafts: [{ planId: link.planId, planDigest: link.planDigest, guidance: null, publication: null, recovery: draft }] } };
  const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("conversation");
  const owner = new ConversationSession(context, () => reads.invalidate(["project"]), vi.fn(), {
    identity: () => id(65106), list: async () => ({ items: [], next: null }), read: async () => structuredClone(head),
    resolve: async request => {
      const candidate: unknown = { key, revision: String(BigInt(head.revision) + 1n), writerId: request.resolve.write.writerId,
        value: canonicalConversationDraft(structuredClone(request.resolve.write.value)) };
      if (!validateResponseConversationWritten(candidate)) throw new Error("Invalid synthetic resolve acknowledgement");
      head = candidate; return structuredClone(head);
    },
    write: async request => {
      const candidate: unknown = { key: structuredClone(request.write.key), revision: String(BigInt(head.revision) + 1n), writerId: request.write.writerId,
        value: canonicalConversationDraft(structuredClone(request.write.value)) };
      if (!validateResponseConversationWritten(candidate)) throw new Error("Valid synthetic conversation journal response required");
      head = candidate;
      return structuredClone(head);
    },
  });
  let capture: WorkPlanTeamRecoveryPreviewView | null = null;
  invoke.mockImplementation(async (command, args) => {
    const request = args && typeof args === "object" && "request" in args ? args.request : null;
    if (command === "read_conversation_proposal_work_plan") return structuredClone(link);
    if (command === "read_work_plan_status") return structuredClone(source.status);
    if (command === "prepare_work_plan_team_recovery") {
      if (!validateRequestWorkPlanTeamRecoveryPrepare(request)) throw new Error("Invalid synthetic prepare tuple");
      capture = teamRecoveryPreviewFixture(request, source); return structuredClone(capture);
    }
    if (command === "authorize_work_plan_team_recovery") {
      if (!capture || !validateRequestWorkPlanTeamRecoveryAuthorize(request)) throw new Error("Invalid synthetic confirmation tuple");
      const receipt = teamRecoveryReceiptFixture(request, capture);
      source.status.state = "active"; source.status.lease = structuredClone(receipt.effectiveVersion.lease);
      source.state.state.state = "active"; source.state.state.lease = structuredClone(receipt.effectiveVersion.lease);
      source.state.state.effectiveVersion = structuredClone(receipt.effectiveVersion); source.view.effectiveVersion = structuredClone(receipt.effectiveVersion);
      return receipt;
    }
    if (command === "start_work_plan") {
      if (!capture) throw new Error("Missing synthetic prepared work"); return capture.preview.attemptId;
    }
    if (command === "read_model_connections") return connectionFixture([]);
    if (command === "read_work_plan_team_recovery_state") return structuredClone(source.state);
    if (command === "read_work_plan_team_execution") return structuredClone(source.view);
    if (command === "read_work_plan_team_history") return { planId: link.planId, members: [], authorRoles: [], posts: [], nextAfter: null };
    throw new Error(`Unexpected synthetic recovery command: ${command}`);
  });
  await owner.initialize(); expect(await owner.open(conversationId)).toBe(true);
  let mounted = true, current = true;
  const input = () => { const value = owner.getSnapshot().inputs.get(conversationId); if (!value) throw new Error("Synthetic conversation input missing"); return value; };
  function Surface() {
    useSyncExternalStore(owner.subscribe, owner.getSnapshot); useSyncExternalStore(gate.subscribe, gate.getSnapshot);
    return mounted ? <ConversationTeamRecovery owner={owner} input={input()} link={link} status={source.status} visible disabled={false}
      current={() => current && gate.canDispatch({ viewId: "conversation", source: "button" })} gate={gate} viewId="conversation"/> : null;
  }
  const content = () => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}><Surface/></SessionReadProvider></ApplicationReadProvider>;
  const rendered = render(content()), user = userEvent.setup();
  disposals.push(() => { owner.retire(); reads.retire(); gate.dispose(); });
  return { source, owner, link, user, input, head: () => structuredClone(head),
    mounted(value: boolean) { mounted = value; rendered.rerender(content()); },
    current(value: boolean) { current = value; rendered.rerender(content()); } };
}
async function expand(h: Awaited<ReturnType<typeof harness>>) {
  await h.user.click(screen.getByRole("button", { name: t("show") }));
  await screen.findByRole("textbox", { name: t("instructions") });
  await waitFor(() => expect(screen.queryByText(t("loading"))).not.toBeInTheDocument());
}

it.each(["en-US", "zh-CN"] as const)("opens kept input without restoring permission or changing user text in %s", async locale => {
  await i18n.changeLanguage(locale); const h = await harness(); await expand(h);
  expect(screen.getByRole("textbox", { name: t("instructions") })).toHaveValue("Saved human A {{literal}} 中文 instructions.");
  expect(screen.getByText(t("localHelp"))).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: t("consent") })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: t("start") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => /authorize|prepare|start/.test(command))).toBe(false);
});

it("requires explicit selection of every unresolved original reference before preparing", async () => {
  const h = await harness(true); await expand(h);
  const prepare = screen.getByRole("button", { name: t("prepare") });
  await waitFor(() => expect(prepare).toBeDisabled());
  const unresolved = within(screen.getByRole("group", { name: t("unresolved") }));
  await h.user.click(unresolved.getByRole("checkbox", { name: t("priorWork", { number: 1 }) }));
  await waitFor(() => expect(prepare).toBeEnabled());
  expect(h.input().value.teamDrafts?.[0]?.recovery?.priorWork).toEqual(h.source.state.state.unresolvedWork);
});

it("keeps an explicitly authorized continuation available through its own project refresh and starts only on request", async () => {
  const h = await harness(); await expand(h);
  const prepare = screen.getByRole("button", { name: t("prepare") }); await waitFor(() => expect(prepare).toBeEnabled());
  await h.user.click(prepare); const consent = await screen.findByRole("checkbox", { name: t("consent") });
  await h.user.click(consent);
  const authorize = screen.getByRole("button", { name: t("authorize") }); await waitFor(() => expect(authorize).toBeEnabled());
  await h.user.click(authorize);
  const start = await screen.findByRole("button", { name: t("start") }); await waitFor(() => expect(start).toBeEnabled());
  expect(invoke.mock.calls.filter(([command]) => command === "start_work_plan")).toHaveLength(0);
  await h.user.click(start); await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "start_work_plan")).toHaveLength(1));
  await waitFor(() => expect(h.head().value?.pending).toBeNull());
  expect(h.head().value?.teamDrafts?.[0]?.recoveryRecorded).toBeTruthy();
});

it("persists newer input through collapsing and remounting without starting work", async () => {
  const h = await harness(); await expand(h);
  const input = screen.getByRole("textbox", { name: t("instructions") });
  await h.user.clear(input); await h.user.paste("Newer human B {{literal}} 日本語");
  await waitFor(() => expect(h.head().value?.teamDrafts?.[0]?.recovery?.instructions).toBe("Newer human B {{literal}} 日本語"));
  await h.user.click(screen.getByRole("button", { name: t("hide") }));
  expect(screen.queryByRole("textbox", { name: t("instructions") })).not.toBeInTheDocument();
  act(() => h.mounted(false)); act(() => h.mounted(true)); await expand(h);
  expect(screen.getByRole("textbox", { name: t("instructions") })).toHaveValue("Newer human B {{literal}} 日本語");
  expect(h.head().value?.text).toBe("Unrelated conversation text");
  expect(invoke.mock.calls.some(([command]) => /authorize|prepare|start/.test(command))).toBe(false);
});

it("keeps inputs editable when observation becomes stale while blocking a new request", async () => {
  const h = await harness(); await expand(h); act(() => h.current(false));
  const input = screen.getByRole("textbox", { name: t("instructions") });
  expect(input).not.toHaveAttribute("readonly");
  await h.user.type(input, " B");
  expect(screen.getByRole("button", { name: t("prepare") })).toBeDisabled();
  await waitFor(() => expect(h.head().value?.teamDrafts?.[0]?.recovery?.instructions).toBe("Saved human A {{literal}} 中文 instructions. B"));
});

it("retains independent English and Chinese action and consequence anchors", () => {
  expect(conversationTeamRecoveryEn.authorize).toBe("Authorize this continuation");
  expect(conversationTeamRecoveryZh.start).toBe("启动这次续作");
  expect(conversationTeamRecoveryZh.closeHelp).toContain("单独关闭不能证明它从未执行");
});
