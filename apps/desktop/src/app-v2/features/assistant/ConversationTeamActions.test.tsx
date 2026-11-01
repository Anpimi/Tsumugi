import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalConversationDraft, type ConversationDraftHead, type ConversationDraftResolveTarget, type conversationDraftCommands } from "../../../conversationDraftCommands";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { validateResponseProposalWorkPlanLink } from "../../../generated/conversations.validators";
import { validateResponseWorkPlanTeamExecution } from "../../../generated/ai.validators";
import { i18n } from "../../../i18n";
import { conversationTeamActionsEn } from "../../../i18n/conversationTeamActions";
import { jsonIdentity } from "../../../pluginToolChoices";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { humanTeamMessageFixture, teamGuidanceFixture } from "../../../testSupport/teamGuidanceFixture";
import { publishedTeamFixture, teamContext } from "../../../testSupport/teamDiscussionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { ConversationSession } from "./ConversationSession";
import { ConversationTeamActions } from "./ConversationTeamActions";
import { ConversationMemberRoutes, type ConversationMemberRoute } from "./ConversationMemberRoutes";

const invoke = vi.hoisted(() => vi.fn<(command: string, args: unknown) => Promise<unknown>>(async () => { throw new Error("Unexpected native or external request"); }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
type Ports = NonNullable<ConstructorParameters<typeof ConversationSession>[3]>;
type Port<K extends keyof Ports> = NonNullable<Ports[K]>;
type Write = Parameters<typeof conversationDraftCommands.write>[0]["write"];
type TextKey = keyof typeof conversationTeamActionsEn;
const t = (key: TextKey, values: Record<string, string | number> = {}) => i18n.t(`conversationTeamActions.${key}`, values);
const disposals: (() => void)[] = [];
function checked<T>(value: unknown, validate: (value: unknown) => value is T): T {
  if (!validate(value)) throw new Error("Invalid synthetic team action fixture"); return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}

async function harness() {
  const context = { ...teamContext }, { status, view: initialView } = teamGuidanceFixture(), conversationId = id(63600);
  let view = initialView, mounted = true, current = true, identity = 63700;
  const link = checked({ projectId: context.projectId, conversationId, planId: status.plan.planId, planDigest: status.plan.digest,
    actionId: view.effectiveVersion.actionId, proposalId: id(63601), revisionId: id(63602), ordinal: "1" }, validateResponseProposalWorkPlanLink);
  let head: ConversationDraftHead = checked({ key: { projectId: context.projectId, conversationId }, revision: "1", writerId: id(63603),
    value: { text: "", editSeq: "0", pending: null } }, validateResponseConversationWritten);
  const acknowledgements = new Map<string, ConversationDraftHead>();
  const commit = async (kind: "write" | "resolve", write: Write, target?: ConversationDraftResolveTarget) => {
    const operation = jsonIdentity({ kind, write, target }); if (!operation) throw new Error("Synthetic journal operation required");
    const acknowledged = acknowledgements.get(operation); if (acknowledged) return structuredClone(acknowledged);
    expect(write.key).toEqual(head.key); expect(write.expectedRevision).toBe(head.revision);
    if (kind === "write" && head.value?.pending) expect(write.value.pending).toEqual(head.value.pending);
    if (target?.kind === "pending") { expect(target.pending).toEqual(head.value?.pending); expect(write.value.pending).toBeNull(); }
    head = checked({ key: structuredClone(write.key), revision: String(BigInt(head.revision) + 1n), writerId: write.writerId,
      value: canonicalConversationDraft(structuredClone(write.value)) }, validateResponseConversationWritten);
    acknowledgements.set(operation, structuredClone(head)); return structuredClone(head);
  };
  const ports = {
    now: () => Date.now(), identity: () => id(identity++),
    list: vi.fn<Port<"list">>(async () => ({ items: head.value ? [{ key: head.key, revision: head.revision, editSeq: head.value.editSeq,
      hasPending: !!head.value.pending || !!head.value.revocations?.length }] : [], next: null })),
    read: vi.fn<Port<"read">>(async () => structuredClone(head)),
    write: vi.fn<Port<"write">>(async request => commit("write", request.write)),
    resolve: vi.fn<Port<"resolve">>(async request => {
      const target = request.resolve.target;
      if (target.kind === "revocation") return commit("resolve", request.resolve.write, target);
      const decoded = checked({ key: head.key, revision: "1", writerId: request.resolve.write.writerId,
        value: { ...request.resolve.write.value, pending: target.pending } }, validateResponseConversationWritten);
      if (!decoded.value?.pending) throw new Error("Original pending request required");
      return commit("resolve", request.resolve.write, { kind: "pending", pending: decoded.value.pending });
    }),
    readProposalWorkPlan: vi.fn<Port<"readProposalWorkPlan">>(async () => structuredClone(link)),
    planStatus: vi.fn<Port<"planStatus">>(async () => structuredClone(status)),
    readTeamExecution: vi.fn<Port<"readTeamExecution">>(async () => structuredClone(view)),
    sendTeamMessage: vi.fn<Port<"sendTeamMessage">>(async request => humanTeamMessageFixture(request)),
    publishTeam: vi.fn<Port<"publishTeam">>(async request => publishedTeamFixture(request)),
  } satisfies Ports;
  const owner = new ConversationSession(context, vi.fn(), vi.fn(), ports), gate = new InteractionGate(), refresh = vi.fn();
  gate.setVisibleOwner("conversation"); await owner.initialize(); expect(await owner.open(conversationId)).toBe(true);
  const input = () => { const value = owner.getSnapshot().inputs.get(conversationId); if (!value) throw new Error("Conversation input required"); return value; };
  const proof = () => current && gate.canDispatch({ viewId: "conversation", source: "button" });
  let memberRoutes: readonly ConversationMemberRoute[] = [];
  const registry = { register: (_key: string, routes: readonly ConversationMemberRoute[]) => { memberRoutes = routes; return () => { if (memberRoutes === routes) memberRoutes = []; }; } };
  function Surface() {
    useSyncExternalStore(owner.subscribe, owner.getSnapshot); useSyncExternalStore(gate.subscribe, gate.getSnapshot);
    return mounted ? <ConversationMemberRoutes.Provider value={registry}><ConversationTeamActions owner={owner} input={input()} link={link} status={status} view={view}
      current={proof} visible disabled={false} gate={gate} viewId="conversation" refresh={refresh}/></ConversationMemberRoutes.Provider> : null;
  }
  const rendered = render(<Surface/>), user = userEvent.setup();
  disposals.push(() => { owner.retire(); gate.dispose(); });
  return { owner, gate, input, link, status, ports, user, refresh, view: initialView, memberRoutes: () => memberRoutes, head: () => structuredClone(head),
    setMounted(value: boolean) { mounted = value; rendered.rerender(<Surface/>); },
    setCurrent(value: boolean) { current = value; rendered.rerender(<Surface/>); },
    setView(value: typeof initialView) { view = checked(value, validateResponseWorkPlanTeamExecution); rendered.rerender(<Surface/>); } };
}
type Harness = Awaited<ReturnType<typeof harness>>;
function group(key: "guidanceTitle" | "discussionTitle") { return within(screen.getByRole("group", { name: t(key) })); }
async function expand(h: Harness) { await h.user.click(screen.getByRole("button", { name: t("show") })); }
async function chooseGuidance(h: Harness, member = h.view.roster[0]) {
  await h.user.click(group("guidanceTitle").getByRole("button", { name: t("memberChoice", { member: t("chooseMember") }) }));
  await h.user.click(await screen.findByRole("menuitem", { name: member.displayName }));
  await h.user.click(group("guidanceTitle").getByRole("button", { name: t("entryChoice", { entry: t("chooseEntry") }) }));
  await h.user.click(await screen.findByRole("menuitem", { name: h.status.plan.scope[0].nativeKey }));
}
async function choosePublication(h: Harness) {
  await h.user.click(group("discussionTitle").getByRole("button", { name: t("entryChoice", { entry: t("chooseEntry") }) }));
  await h.user.click(await screen.findByRole("menuitem", { name: h.status.plan.scope[0].nativeKey }));
}
async function flush(h: Harness) { await act(async () => { expect(await h.owner.flush()).toBe(true); }); }
beforeEach(async () => { invoke.mockClear(); await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); expect(invoke).not.toHaveBeenCalled(); });

describe("conversation team inputs", () => {
  it.each([
    ["en-US", "Guidance text", "Send this guidance", "Discussion text", "Post this discussion",
      "Unfinished text stays on this computer. Editing or reopening it does not send it.",
      "Send this text to the selected member for a later permitted request. Sending it does not wake an idle member or start new work."],
    ["zh-CN", "指导正文", "发送这段指导", "讨论正文", "发表这段讨论",
      "没写完的内容会保存在本机。编辑或重新打开都不会发送。",
      "这段文字会发给所选成员，供后续获准的请求使用。发送不会唤醒空闲成员，也不会启动新工作。"],
  ])("previews the actual member and target before two explicit actions in %s", async (language, guidanceName, sendName, discussionName, publishName, localHelp, guidanceHelp) => {
    await i18n.changeLanguage(language); const h = await harness(); await expand(h);
    expect(screen.getByText(localHelp)).toBeVisible(); expect(screen.getByText(guidanceHelp)).toBeVisible();
    const guidance = screen.getByRole("textbox", { name: guidanceName }), discussion = screen.getByRole("textbox", { name: discussionName });
    expect(screen.getByRole("button", { name: sendName })).toBeDisabled(); expect(screen.getByRole("button", { name: publishName })).toBeDisabled();
    await chooseGuidance(h, h.view.roster[1]); await choosePublication(h);
    const member = h.view.roster[1], unit = h.status.plan.scope[0];
    await h.user.click(group("guidanceTitle").getByText(t("viewRole")));
    expect(group("guidanceTitle").getByText("Read original reasons and challenge incomplete evidence.")).toBeVisible();
    expect(group("guidanceTitle").getByText(t("destination", { name: member.displayName, endpoint: member.config.endpoint, model: member.config.model }))).toBeVisible();
    expect(group("guidanceTitle").getByText(t("target", { entry: unit.nativeKey, locale: h.status.plan.locale }))).toBeVisible();
    await h.user.type(guidance, "Revisit the original objection 中文."); await h.user.type(discussion, "Keep the original reasoning 中文."); await flush(h);
    expect(h.ports.sendTeamMessage).not.toHaveBeenCalled(); expect(h.ports.publishTeam).not.toHaveBeenCalled();
    await h.user.click(screen.getByRole("button", { name: sendName }));
    await waitFor(() => expect(guidance).toHaveValue(""));
    expect(h.ports.sendTeamMessage).toHaveBeenCalledOnce();
    expect(h.ports.sendTeamMessage.mock.calls[0][0].message).toMatchObject({ recipientMemberId: member.memberId,
      expectedRecipientRoleVersionId: member.roleVersionId, target: { unitId: unit.unitId, locale: h.status.plan.locale,
        sourceSnapshotId: unit.sourceSnapshotId, sourceRevisionId: unit.sourceRevisionId }, body: "Revisit the original objection 中文." });
    await waitFor(() => expect(screen.getByRole("button", { name: publishName })).toBeEnabled());
    await h.user.click(screen.getByRole("button", { name: publishName })); await waitFor(() => expect(discussion).toHaveValue(""));
    expect(h.ports.publishTeam).toHaveBeenCalledOnce(); expect(h.ports.publishTeam.mock.calls[0][0].publication.body).toBe("Keep the original reasoning 中文.");
  });

  it("keeps unsent text and pending B across closing and reopening without sending or clearing the original request", async () => {
    const h = await harness(); await expand(h); await chooseGuidance(h); await choosePublication(h);
    await h.user.type(screen.getByRole("textbox", { name: t("guidanceBody") }), "Guidance A");
    await h.user.type(screen.getByRole("textbox", { name: t("discussionBody") }), "Unsent discussion"); await flush(h);
    h.setMounted(false); h.setMounted(true);
    expect(screen.getByRole("status")).toHaveTextContent(t("draftKept")); expect(h.ports.sendTeamMessage).not.toHaveBeenCalled();
    await expand(h); expect(screen.getByRole("textbox", { name: t("guidanceBody") })).toHaveValue("Guidance A");
    const business = deferred<void>(); h.ports.sendTeamMessage.mockImplementationOnce(async request => { await business.promise; return humanTeamMessageFixture(request); });
    await h.user.click(screen.getByRole("button", { name: t("sendGuidance") })); await waitFor(() => expect(h.ports.sendTeamMessage).toHaveBeenCalledOnce());
    const original = structuredClone(h.input().value.pending);
    const guidance = screen.getByRole("textbox", { name: t("guidanceBody") }); await h.user.clear(guidance); await h.user.type(guidance, "Guidance B");
    expect(screen.getByText(t("pendingHelp"))).toBeVisible();
    for (const key of ["clearGuidance", "clearDiscussion"] as const) {
      const clear = screen.getByRole("button", { name: t(key) }); expect(clear).toBeDisabled(); fireEvent.click(clear);
    }
    expect(h.input().value.pending).toEqual(original); h.setMounted(false); h.setMounted(true); await expand(h);
    expect(screen.getByRole("textbox", { name: t("guidanceBody") })).toHaveValue("Guidance B");
    expect(screen.getByRole("textbox", { name: t("discussionBody") })).toHaveValue("Unsent discussion");
    expect(h.ports.sendTeamMessage).toHaveBeenCalledOnce(); expect(h.ports.publishTeam).not.toHaveBeenCalled();
    await act(async () => { business.resolve(); }); await waitFor(() => expect(h.input().value.pending).toBeNull()); await flush(h);
    expect(screen.getByRole("textbox", { name: t("guidanceBody") })).toHaveValue("Guidance B");
    expect(h.head().value?.teamDrafts?.[0].guidance?.body).toBe("Guidance B"); expect(h.ports.sendTeamMessage.mock.calls[0][0].message.body).toBe("Guidance A");
  });

  it("keeps input and offers a fresh review after preparation fails without a dispatched request", async () => {
    const h = await harness(); await expand(h); await chooseGuidance(h);
    const field = screen.getByRole("textbox", { name: t("guidanceBody") });
    await h.user.type(field, "Retained retry text"); await flush(h);
    h.ports.readProposalWorkPlan.mockRejectedValueOnce(new Error("Synthetic plan read unavailable"));
    await h.user.click(screen.getByRole("button", { name: t("sendGuidance") }));
    await screen.findByText(t("prepareFailed")); expect(field).toHaveValue("Retained retry text");
    expect(h.input().value.pending).toBeNull(); expect(h.ports.sendTeamMessage).not.toHaveBeenCalled();
    await h.user.click(screen.getByRole("button", { name: t("recheck") }));
    expect(h.refresh).toHaveBeenCalledOnce(); expect(h.input().failure).toBeNull();
    expect(h.ports.sendTeamMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: t("sendGuidance") })).toBeEnabled());
    await h.user.click(screen.getByRole("button", { name: t("sendGuidance") }));
    await waitFor(() => expect(field).toHaveValue(""));
    expect(h.ports.sendTeamMessage).toHaveBeenCalledOnce();
    expect(h.ports.sendTeamMessage.mock.calls[0][0].message.body).toBe("Retained retry text");
  });

  it("blocks composing input and a proof that becomes stale during the original team read", async () => {
    const h = await harness(); await expand(h); await chooseGuidance(h);
    const field = screen.getByRole("textbox", { name: t("guidanceBody") }); await h.user.type(field, "Keep this input"); await flush(h);
    fireEvent.compositionStart(field); const send = screen.getByRole("button", { name: t("sendGuidance") }); expect(send).toBeDisabled();
    fireEvent.click(send); expect(h.ports.readProposalWorkPlan).not.toHaveBeenCalled(); expect(h.ports.sendTeamMessage).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field); expect(h.gate.getSnapshot().composingOwners).toHaveLength(0); await waitFor(() => expect(send).toBeEnabled());
    const read = deferred<typeof h.view>(); h.ports.readTeamExecution.mockImplementationOnce(async () => read.promise);
    await h.user.click(send); await waitFor(() => expect(h.ports.readTeamExecution).toHaveBeenCalledOnce()); h.setCurrent(false);
    await act(async () => { read.resolve(structuredClone(h.view)); }); await waitFor(() => expect(h.input().busy).toBeNull());
    expect(screen.getByText(t("refreshFirst"))).toBeVisible(); fireEvent.click(send); expect(h.ports.readTeamExecution).toHaveBeenCalledOnce();
    h.setCurrent(true);
    const roleRead = deferred<typeof h.view>(); h.ports.readTeamExecution.mockImplementationOnce(async () => roleRead.promise);
    await waitFor(() => expect(screen.getByRole("button", { name: t("sendGuidance") })).toBeEnabled());
    await h.user.click(screen.getByRole("button", { name: t("sendGuidance") }));
    await waitFor(() => expect(h.ports.readTeamExecution).toHaveBeenCalledTimes(2));
    const changed = structuredClone(h.view), changedRole = structuredClone(changed.members[0]);
    changed.roster[0].roleVersionId = id(63630); changed.roster[0].role = "A different approved role";
    changedRole.generation = "2"; changedRole.request.roleVersionId = id(63630); changedRole.request.role = changed.roster[0].role;
    changed.members[0] = changedRole; changed.roleVersions.push(changedRole);
    h.status.lease = { ...h.status.lease, generation: "2" };
    changed.effectiveVersion = { actionId: id(63631), digest: "d".repeat(64), lease: structuredClone(h.status.lease) };
    h.setView(changed);
    await act(async () => { roleRead.resolve(structuredClone(h.view)); }); await waitFor(() => expect(h.input().busy).toBeNull());
    expect(h.ports.sendTeamMessage).not.toHaveBeenCalled(); expect(h.input().value.pending).toBeNull(); expect(field).toHaveValue("Keep this input");
    expect(screen.queryByText(t("refreshFirst"))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("sendGuidance") })).toBeEnabled(); await flush(h);
  });

  it("counts UTF-8 bytes at the field and retains oversized guidance and discussion", async () => {
    const h = await harness(); await expand(h); await chooseGuidance(h); await choosePublication(h);
    const discussionMaximum = h.status.plan.teamDiscussionLimits?.maxPostBytes; if (!discussionMaximum) throw new Error("Synthetic discussion limit required");
    for (const [bodyKey, sendKey, maximum] of [["guidanceBody", "sendGuidance", h.view.messageLimits.maxBodyBytes], ["discussionBody", "publishDiscussion", discussionMaximum]] as const) {
      const body = "界".repeat(Math.floor(maximum / 3) + 1), field = screen.getByRole("textbox", { name: t(bodyKey) });
      expect(body.length).toBeLessThan(maximum); expect(new TextEncoder().encode(body).length).toBeGreaterThan(maximum);
      fireEvent.change(field, { target: { value: body } }); expect(field).toHaveValue(body); expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAccessibleDescription(t("bodyTooLong", { count: maximum })); expect(screen.getByRole("button", { name: t(sendKey) })).toBeDisabled();
    }
    await flush(h); h.setMounted(false); h.setMounted(true); await expand(h);
    expect(screen.getByRole("textbox", { name: t("guidanceBody") })).toHaveValue(h.owner.teamDraft(h.link.conversationId, h.link.planId)?.guidance?.body);
    expect(screen.getByRole("textbox", { name: t("discussionBody") })).toHaveAttribute("aria-invalid", "true");
    expect(h.ports.sendTeamMessage).not.toHaveBeenCalled(); expect(h.ports.publishTeam).not.toHaveBeenCalled();
  });

  it("shows the newly read recipient role and destination without granting a send on refresh", async () => {
    const h = await harness(); await expand(h); await chooseGuidance(h);
    await h.user.type(screen.getByRole("textbox", { name: t("guidanceBody") }), "Unsent original question"); await flush(h);
    const next = structuredClone(h.view), member = next.roster[0]; member.roleVersionId = id(63610); member.displayName = "Translator revised";
    member.role = "Explain the new source evidence before revising. ".repeat(100); member.config.endpoint = "http://127.0.0.1:4002/v1/chat/completions"; member.config.model = "synthetic-revised-model";
    next.effectiveVersion = { ...next.effectiveVersion, actionId: id(63611), digest: "d".repeat(64) }; h.setView(next);
    const role = group("guidanceTitle").getByText(member.role, { normalizer: value => value });
    expect(role).not.toBeVisible(); await h.user.click(group("guidanceTitle").getByText(t("viewRole"))); expect(role).toBeVisible();
    expect(group("guidanceTitle").getByText(t("destination", { name: member.displayName, endpoint: member.config.endpoint, model: member.config.model }))).toBeVisible();
    expect(group("guidanceTitle").queryByText("Translate and revisit rejected candidates.")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: t("guidanceBody") })).toHaveValue("Unsent original question");
    expect(h.ports.sendTeamMessage).not.toHaveBeenCalled(); expect(h.ports.publishTeam).not.toHaveBeenCalled(); expect(h.ports.readTeamExecution).not.toHaveBeenCalled();
  });

  it("restores an original reply draft and removes only the explicitly cleared sub-draft", async () => {
    const h = await harness();
    act(() => {
      h.owner.editTeamGuidance(h.link, { memberId: h.view.roster[0].memberId, unitId: h.status.plan.scope[0].unitId, body: "Separate guidance" });
      h.owner.editTeamPublication(h.link, { unitId: h.status.plan.scope[0].unitId, body: "Reply draft 中文", replyTo: id(63620) });
      h.owner.edit(h.link.conversationId, "Separate conversation input");
    }); await flush(h);
    expect(screen.getByRole("button", { name: t("hide") })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(t("replyKept"))).toBeVisible(); await h.user.click(screen.getByRole("button", { name: t("removeReply") }));
    expect(h.owner.teamDraft(h.link.conversationId, h.link.planId)?.publication?.replyTo).toBeNull();
    expect(screen.getByRole("textbox", { name: t("discussionBody") })).toHaveValue("Reply draft 中文"); await flush(h);
    await h.user.click(screen.getByRole("button", { name: t("clearGuidance") })); await flush(h);
    expect(screen.getByRole("textbox", { name: t("guidanceBody") })).toHaveValue(""); expect(screen.getByRole("textbox", { name: t("discussionBody") })).toHaveValue("Reply draft 中文");
    expect(h.input().value.text).toBe("Separate conversation input"); expect(h.owner.teamDraft(h.link.conversationId, h.link.planId)?.guidance).toBeNull();
    expect(h.ports.sendTeamMessage).not.toHaveBeenCalled(); expect(h.ports.publishTeam).not.toHaveBeenCalled();
  });
});


it("routes a named member from its exact current roster into the existing guidance draft without sending", async () => {
  const h = await harness(), member = h.view.roster[0];
  const route = h.memberRoutes().find(value => value.name === member.displayName);
  expect(route?.key).toContain(member.roleVersionId);
  expect(route?.current()).toBe(true);
  act(() => route?.open("New local guidance"));
  expect(h.input().value.teamDrafts?.[0]?.guidance?.body).toBe("New local guidance");
  act(() => route?.open("Do not overwrite the earlier draft"));
  expect(h.input().value.teamDrafts?.[0]?.guidance?.body).toBe("New local guidance");
  expect(group("guidanceTitle").getByRole("button", { name: t("memberChoice", { member: member.displayName }) })).toBeVisible();
  expect(h.input().value.teamDrafts?.[0]?.guidance?.memberId).toBe(member.memberId);
  expect(h.ports.sendTeamMessage).not.toHaveBeenCalled();
  expect(h.ports.publishTeam).not.toHaveBeenCalled();
  await flush(h);
  act(() => h.setCurrent(false));
  expect(route?.current()).toBe(false);
  act(() => route?.open());
  expect(h.ports.sendTeamMessage).not.toHaveBeenCalled();
  act(() => h.setMounted(false)); expect(route?.current()).toBe(false);
});
