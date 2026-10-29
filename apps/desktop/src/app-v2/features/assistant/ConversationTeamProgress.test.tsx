import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateResponseWorkPlanTeamExecution, validateResponseWorkPlanTeamHistory, validateResponseWorkPlanTeamPost } from "../../../generated/ai.validators";
import { validateResponseProposalWorkPlanLink } from "../../../generated/conversations.validators";
import { i18n } from "../../../i18n";
import { conversationTeamEn } from "../../../i18n/conversationTeam";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { teamContext, teamHistoryFixture, teamPostFixture } from "../../../testSupport/teamDiscussionFixture";
import { teamExecutionStatusFixture, teamExecutionViewFixture } from "../../../testSupport/teamExecutionFixture";
import { teamToolHistoryFixture } from "../../../testSupport/teamToolHistoryFixture";
import type { TeamExecutionView, TeamWorkReference } from "../../../workPlanCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { ConversationTeamProgress } from "./ConversationTeamProgress";
import type { OpenConversationTeamCandidate } from "./conversationTeamReads";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
type TextKey = { [K in keyof typeof conversationTeamEn]: typeof conversationTeamEn[K] extends string ? K : never }[keyof typeof conversationTeamEn];
const t = (key: TextKey, values: Record<string, string | number> = {}) => i18n.t(`conversationTeam.${key}`, values);
const disposals: (() => void)[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function checked<T>(value: unknown, validate: (value: unknown) => value is T): T {
  if (!validate(value)) throw new Error("Invalid synthetic team UI fixture"); return value;
}
function fixture() {
  const context = { ...teamContext }, status = teamExecutionStatusFixture(), page = teamExecutionViewFixture(), review = page.works[0];
  const member = page.roster[0], target = review.target;
  const candidate: TeamExecutionView["works"][number] = { ...structuredClone(review), sequence: "2", origin: { kind: "start", actionId: id(63201) }, author: null, request: null,
    receipt: { ...review.receipt, intentId: id(63201), memberId: member.memberId, roleVersionId: member.roleVersionId, taskId: id(63202), attemptId: id(63203) },
    candidateRevisionId: id(63204), output: { outcome: { kind: "translation", unitId: target.unitId, targetLocale: target.locale, text: "" }, usage: null, usageIncomplete: true, requests: 1 } };
  const unknown: TeamExecutionView["works"][number] = { ...structuredClone(candidate), sequence: "3", origin: { kind: "start", actionId: id(63205) },
    receipt: { ...candidate.receipt, intentId: id(63205), taskId: id(63206), attemptId: id(63207) }, execution: "unknown", validation: "absent", output: null, candidateRevisionId: null };
  page.works = [review, candidate, unknown]; page.nextWorkAfter = "3";
  const addressed = { ...structuredClone(page.messages[0]), sequence: "2", messageId: id(63208), body: "Addressed B; not recorded as model input." };
  page.messages.push(addressed); page.nextMessageAfter = "2";
  const nextWork = { ...structuredClone(unknown), sequence: "4", origin: { kind: "start" as const, actionId: id(63209) }, receipt: { ...unknown.receipt, intentId: id(63209), taskId: id(63210), attemptId: id(63211) } };
  const nextMessage = { ...structuredClone(addressed), sequence: "3", messageId: id(63212), body: "Next saved message C." };
  const link = checked({ projectId: context.projectId, conversationId: id(63213), proposalId: id(63214), revisionId: id(63215), ordinal: "1",
    planId: status.plan.planId, planDigest: status.plan.digest, actionId: page.effectiveVersion.actionId }, validateResponseProposalWorkPlanLink);
  const post = teamPostFixture(); post.sequence = "24"; post.author = structuredClone(page.messages[0].sender); post.publication.target = structuredClone(target);
  const earlier = { ...structuredClone(post), sequence: "1", publication: { ...structuredClone(post.publication), postId: id(63216), body: "Earlier saved team discussion." } };
  const baseHistory = teamHistoryFixture(), history = checked({ ...baseHistory, planId: link.planId, members: structuredClone(page.members), authorRoles: structuredClone(page.roleVersions),
    posts: [earlier], nextAfter: "1" }, validateResponseWorkPlanTeamHistory);
  return { context, status, link, page: checked(page, validateResponseWorkPlanTeamExecution), candidate, unknown, nextWork, nextMessage,
    post: checked(post, validateResponseWorkPlanTeamPost), history };
}
type Fixture = ReturnType<typeof fixture>;
type ReadRequest = { projectId: string; planId: string; afterWork?: string | null; afterMessage?: string | null; after?: string | null; postId?: string; work?: TeamWorkReference };
function response(h: Fixture, command: string, request: ReadRequest): unknown {
  if (command === "read_work_plan_team_execution") {
    const page = structuredClone(h.page);
    if (request.afterWork !== null) { page.works = [structuredClone(h.nextWork)]; page.nextWorkAfter = null; }
    if (request.afterMessage !== null) { page.messages = [structuredClone(h.nextMessage)]; page.consumptions = []; page.nextMessageAfter = null; }
    return page;
  }
  if (command === "read_work_plan_team_history") return request.after === null ? structuredClone(h.history) : { ...structuredClone(h.history), posts: [structuredClone(h.post)], nextAfter: null };
  if (command === "read_work_plan_team_post") return structuredClone(h.post);
  if (command === "read_work_plan_team_work_tools") {
    if (!request.work) throw new Error("Original work reference required");
    const tools = teamToolHistoryFixture({ projectId: request.projectId, planId: request.planId, work: request.work, after: request.after ?? null }, "unknown");
    const first = tools.attempts[0];
    if (!first) throw new Error("Synthetic tool history requires a saved attempt");
    tools.nextAfter = request.after === null ? first.sequence : null; return tools;
  }
  throw new Error(`Unexpected team UI mutation or external request: ${command}`);
}
function harness(callback = vi.fn<OpenConversationTeamCandidate>(async () => true)) {
  const h = fixture(), reads = new SessionReads(h.context), gate = new InteractionGate(); gate.setVisibleOwner("conversation");
  invoke.mockImplementation(async (command: string, { request }: { request: ReadRequest }) => response(h, command, request));
  const props = { context: h.context, link: h.link, status: h.status, visible: true,
    canRead: () => gate.canDispatch({ viewId: "conversation", source: "button" }), onOpenCandidate: callback };
  const tree = () => <SessionReadProvider context={h.context} reads={reads} bridge={false}><label>Other draft<input aria-label="Other draft" defaultValue="Retained B"/></label><ConversationTeamProgress {...props}/></SessionReadProvider>;
  const rendered = render(tree()), dispose = () => { rendered.unmount(); reads.retire(); gate.dispose(); }; disposals.push(dispose);
  return { ...h, callback, reads, gate, rendered, dispose,
    visible(value: boolean) { props.visible = value; rendered.rerender(tree()); },
    statusChanged() { props.status = { ...structuredClone(props.status), lease: { ...props.status.lease, generation: "4" }, state: "paused" }; rendered.rerender(tree()); },
    executionKey() { return reads.key(["conversation-team-execution", h.link.conversationId, h.link.planId, JSON.stringify([h.context, h.link, props.status]), null, null]); } };
}
async function expand() {
  const trigger = screen.getByRole("button", { name: t("show") }); trigger.focus(); fireEvent.click(trigger);
  await screen.findByRole("button", { name: t("openCandidate") });
}
function section(key: TextKey) { return screen.getByRole("region", { name: t(key) }); }
const allowedReads = new Set(["read_work_plan_team_execution", "read_work_plan_team_history", "read_work_plan_team_post", "read_work_plan_team_work_tools"]);
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); expect(invoke.mock.calls.every(([command]) => allowedReads.has(command))).toBe(true); });

describe("conversation team records", () => {
  it.each([
    ["en-US", "Result unconfirmed", "Read records here. Use the run controls above to pause, stop or take over."],
    ["zh-CN", "结果待核对", "这里只回看记录。暂停、停止或接管请使用上方的运行控制。"],
  ])("reads actual roles, uncertain work and message inclusion without inventing team totals in %s", async (language, unknownLabel, readOnly) => {
    await i18n.changeLanguage(language); const h = harness(); expect(invoke).not.toHaveBeenCalled(); await expand();
    const members = section("members"), work = section("works"), messages = section("messages");
    expect(within(members).getByText("Translator A")).toBeVisible(); expect(within(members).getByText("Reviewer B")).toBeVisible();
    const roles = within(members).getAllByText(t("memberRole")); fireEvent.click(roles[1]);
    expect(within(members).getByText("Read original reasons and challenge incomplete evidence.")).toBeVisible();
    expect(within(members).getByText(/synthetic-review-model/)).toBeVisible();
    expect(within(work).getAllByRole("article")).toHaveLength(3); expect(within(work).getByText(`${unknownLabel} · ${i18n.t("conversationTeam.validation.absent")}`)).toBeVisible();
    expect(within(work).getAllByRole("button", { name: t("openCandidate") })).toHaveLength(1);
    fireEvent.click(within(work).getByText(t("fullText"))); expect(within(work).getByText(t("emptyTranslation"))).toBeVisible();
    expect(within(messages).getByText(t("included", { count: 1 }))).toBeVisible(); expect(within(messages).getByText(t("addressed"))).toBeVisible();
    expect(screen.getByText(readOnly)).toBeVisible(); expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("read_work_plan_team_execution", { request: { ...h.context, planId: h.link.planId, afterWork: null, afterMessage: null, limit: 16 } });
  });

  it("pages work, messages and original tool references independently using the saved work identity", async () => {
    const h = harness(); await expand(); const work = within(section("works")).getAllByRole("article")[0];
    fireEvent.click(within(work).getByRole("button", { name: t("readTools") }));
    await within(work).findByRole("heading", { name: "Captured glossary query 中文" });
    expect(within(work).getByText(t("toolsCounts", { succeeded: 0, unknown: 1, saved: 0 }))).toBeVisible();
    fireEvent.click(within(work).getByRole("button", { name: t("nextTools") }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_work_plan_team_work_tools", { request: { ...h.context, planId: h.link.planId,
      work: { taskId: h.page.works[0].receipt.taskId, attemptId: h.page.works[0].receipt.attemptId, inputDigest: h.page.works[0].receipt.inputDigest }, after: "7", limit: 16 } }));
    await waitFor(() => expect(within(work).getByRole("button", { name: t("nextTools") })).toBeDisabled());
    fireEvent.click(within(work).getByRole("button", { name: t("firstTools") }));
    await waitFor(() => expect(within(work).getByRole("button", { name: t("nextTools") })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: t("nextWork") }));
    await waitFor(() => expect(within(section("works")).getAllByRole("article")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: t("openCandidate") })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("nextMessage") })); await screen.findByText("Next saved message C.");
    expect(invoke).toHaveBeenCalledWith("read_work_plan_team_execution", { request: { ...h.context, planId: h.link.planId, afterWork: "3", afterMessage: "2", limit: 16 } });
    fireEvent.click(screen.getByRole("button", { name: t("firstWork") })); await screen.findByRole("button", { name: t("openCandidate") });
    expect(screen.getByText("Next saved message C.")).toBeVisible();
    expect(invoke).toHaveBeenCalledWith("read_work_plan_team_execution", { request: { ...h.context, planId: h.link.planId, afterWork: null, afterMessage: "2", limit: 16 } });
    h.page.effectiveVersion.digest = "d".repeat(64);
    fireEvent.click(screen.getByRole("button", { name: t("refresh") })); await screen.findByText(t("changed"));
    expect(screen.getByRole("button", { name: t("openCandidate") })).toBeDisabled();
    const firstReads = () => invoke.mock.calls.filter(([command, args]) => command === "read_work_plan_team_execution" && args.request.afterWork === null && args.request.afterMessage === null).length;
    const previousFirstReads = firstReads(); fireEvent.click(screen.getByRole("button", { name: t("firstPages") }));
    await waitFor(() => expect(firstReads()).toBe(previousFirstReads + 1));
    await waitFor(() => expect(screen.getByRole("button", { name: t("openCandidate") })).toBeEnabled());
    expect(screen.getByRole("button", { name: t("firstMessage") })).toBeDisabled(); expect(screen.queryByText(t("changed"))).not.toBeInTheDocument();
  });

  it("opens an exact discussion beyond the first history page without replacing a newer draft or taking its focus", async () => {
    const h = harness(), pending = deferred<unknown>();
    invoke.mockImplementation(async (command: string, { request }: { request: ReadRequest }) => command === "read_work_plan_team_post" ? pending.promise : response(h, command, request));
    await expand(); fireEvent.click(screen.getByRole("button", { name: t("showHistory") })); await within(section("history")).findByText("Earlier saved team discussion.");
    expect(within(section("history")).queryByText(h.post.publication.body, { normalizer: value => value })).not.toBeInTheDocument();
    const trigger = within(section("works")).getByRole("button", { name: t("readReason") }); trigger.focus(); fireEvent.click(trigger);
    const draft = screen.getByRole("textbox", { name: "Other draft" }); draft.focus(); fireEvent.change(draft, { target: { value: "Newer B" } });
    await act(async () => { pending.resolve(structuredClone(h.post)); await pending.promise; });
    await within(section("originalPost")).findByText(h.post.publication.body, { normalizer: value => value });
    expect(invoke).toHaveBeenCalledWith("read_work_plan_team_post", { request: { ...h.context, planId: h.link.planId, postId: h.post.publication.postId } });
    expect(invoke).toHaveBeenCalledWith("read_work_plan_team_history", { request: { ...h.context, planId: h.link.planId, after: "23", limit: 16 } });
    expect(draft).toHaveFocus(); expect(draft).toHaveValue("Newer B"); expect(section("originalPost").querySelector("script")).toBeNull();
    fireEvent.click(within(section("history")).getByRole("button", { name: t("nextHistory") })); await within(section("history")).findByText(h.post.publication.body, { normalizer: value => value });
    expect(draft).toHaveFocus(); expect(draft).toHaveValue("Newer B");
  });

  it("passes only the saved candidate and revokes late navigation after equal cache writes, status changes or hiding", async () => {
    for (const change of ["same-data", "status", "hide"] as const) {
      const pending = deferred<boolean>(), navigate = vi.fn(), callback = vi.fn<OpenConversationTeamCandidate>(async (_target, current) => {
        await pending.promise; if (!current()) return false; navigate(); return true;
      }), h = harness(callback); await expand();
      fireEvent.click(screen.getByRole("button", { name: t("openCandidate") })); await waitFor(() => expect(callback).toHaveBeenCalledOnce());
      const [target, current] = callback.mock.calls[0]; expect(current()).toBe(true);
      expect(target).toMatchObject({ projectId: h.context.projectId, conversationId: h.link.conversationId, planId: h.link.planId, planDigest: h.link.planDigest,
        revisionId: h.candidate.candidateRevisionId, effectiveVersion: h.page.effectiveVersion, work: h.candidate });
      act(() => { if (change === "same-data") h.reads.client.setQueryData(h.executionKey(), h.reads.client.getQueryData(h.executionKey())); else if (change === "status") h.statusChanged(); else h.visible(false); });
      expect(current()).toBe(false); const draft = screen.getByRole("textbox", { name: "Other draft" }); draft.focus();
      await act(async () => { pending.resolve(false); await pending.promise; });
      expect(navigate).not.toHaveBeenCalled(); expect(screen.queryByText(t("candidateChanged"))).not.toBeInTheDocument(); expect(draft).toHaveFocus(); expect(draft).toHaveValue("Retained B"); h.dispose();
    }
  });

  it("keeps read failures distinct from empty pages and recovers without business writes or draft loss", async () => {
    const h = harness(); invoke.mockRejectedValueOnce(new Error("Team record temporarily unavailable"));
    fireEvent.click(screen.getByRole("button", { name: t("show") })); await screen.findByText(t("failed"));
    expect(screen.queryByText(t("noWork"))).not.toBeInTheDocument();
    const draft = screen.getByRole("textbox", { name: "Other draft" }); draft.focus();
    fireEvent.click(screen.getByRole("button", { name: t("refresh") })); await screen.findByRole("button", { name: t("openCandidate") });
    h.callback.mockResolvedValueOnce(false); fireEvent.click(screen.getByRole("button", { name: t("openCandidate") })); await screen.findByText(t("candidateChanged"));
    expect(draft).toHaveFocus(); expect(draft).toHaveValue("Retained B");
    fireEvent.click(screen.getByRole("button", { name: t("refresh") })); await waitFor(() => expect(screen.queryByText(t("candidateChanged"))).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: t("openCandidate") })).toBeEnabled());
    invoke.mockRejectedValueOnce(new Error("Discussion temporarily unavailable")); fireEvent.click(screen.getByRole("button", { name: t("showHistory") }));
    await within(section("history")).findByText(t("historyFailed")); expect(within(section("history")).queryByText(t("noPosts"))).not.toBeInTheDocument();
    fireEvent.click(within(section("history")).getByRole("button", { name: t("refreshHistory") })); await within(section("history")).findByText("Earlier saved team discussion.");
    expect(draft).toHaveFocus(); expect(draft).toHaveValue("Retained B");
  });
});
