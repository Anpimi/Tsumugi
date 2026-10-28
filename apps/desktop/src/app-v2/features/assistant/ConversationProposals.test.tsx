import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { SessionReads } from "../../../sessionReads";
import { canonicalConversationDraft, type ConversationDraftHead } from "../../../conversationDraftCommands";
import type { ConversationProposalRevision } from "../../../conversationCommands";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { conversationProposalFixture, knowledgeProposalFixture } from "../../../testSupport/conversationProposalFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import ConversationPanel from "./ConversationPanel";
import { ConversationSession } from "./ConversationSession";
import type { ConversationProposalTarget, OpenKnowledgeProposal } from "./conversationNavigation";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: id(34001), sessionToken: "proposal-dom" }, conversationId = id(34002);
const key = { projectId: context.projectId, conversationId };
const disposals: (() => void)[] = [];
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("zh-CN"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function expectNoExecution() {
  expect(invoke.mock.calls.map(([command]) => command).filter(command => ![
    "list_project_conversations", "read_project_conversation_messages", "read_conversation_planning_attempts", "read_conversation_planning",
    "read_conversation_proposal_revisions", "read_conversation_proposal", "validate_conversation_proposal",
    "list_local_conversation_drafts", "read_local_conversation_draft", "write_local_conversation_draft", "resolve_local_conversation_draft",
    "capture_conversation_proposal", "revise_conversation_proposal", "read_conversation_proposal_work_plans",
  ].includes(command))).toEqual([]);
}
function harness(saved = true, knowledge = false) {
  const planFixture = conversationProposalFixture(key);
  if (planFixture.revision.content.kind !== "proposal") throw new Error("Synthetic history must contain a proposal");
  const content = planFixture.revision.content, fixture = knowledge ? knowledgeProposalFixture(key) : planFixture;
  const state = {
    head: { key, revision: "0", writerId: null, value: null } as ConversationDraftHead,
    revisions: saved ? [structuredClone(fixture.revision)] : [] as ConversationProposalRevision[],
    revisionWait: null as ReturnType<typeof deferred> | null,
    readWaits: new Map<string, ReturnType<typeof deferred>>(), readFailures: new Set<string>(),
  };
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "list_project_conversations") return { projectId: context.projectId,
      rows: [{ ...key, title: "夜行对话", ordinal: "1" }], nextAfter: null };
    if (command === "read_project_conversation_messages") return { projectId: context.projectId, conversationId: request.conversationId,
      rows: request.conversationId === conversationId ? fixture.run.preview.selectedMessages : [], nextAfter: null };
    if (command === "read_conversation_planning_attempts") return { projectId: context.projectId, conversationId: request.conversationId,
      rows: request.conversationId === conversationId ? [{ attemptId: fixture.run.receipt.consent.attemptId, taskId: fixture.run.receipt.consent.taskId, sequence: "1" }] : [], nextAfter: null };
    if (command === "read_conversation_planning") return structuredClone(fixture.run);
    if (command === "read_conversation_proposal_revisions") {
      const remaining = state.revisions.filter(revision => revision.conversationId === request.conversationId && BigInt(revision.ordinal) > BigInt(request.after ?? "0"));
      const rows = remaining.slice(0, request.limit);
      return { projectId: context.projectId, conversationId: request.conversationId, rows: structuredClone(rows), nextAfter: remaining.length > rows.length ? rows.at(-1)?.ordinal : null };
    }
    if (command === "read_conversation_proposal_work_plans") return { projectId: context.projectId, conversationId: request.conversationId, rows: [], nextAfter: null };
    if (command === "read_conversation_proposal" || command === "validate_conversation_proposal") {
      const revision = request.revisionId === null ? [...state.revisions].reverse().find(item => item.conversationId === request.conversationId && item.proposalId === request.proposalId)
        : state.revisions.find(item => item.conversationId === request.conversationId && item.proposalId === request.proposalId && item.revisionId === request.revisionId);
      if (!revision) throw new Error("Synthetic proposal version not found");
      const result = structuredClone(revision);
      if (request.revisionId !== null) {
        if (state.readFailures.has(request.revisionId)) throw new Error("Synthetic proposal read failed");
        await state.readWaits.get(request.revisionId)?.promise;
      }
      return result;
    }
    if (command === "list_local_conversation_drafts") return { items: state.head.value ? [{ key, revision: state.head.revision,
      editSeq: state.head.value.editSeq, hasPending: !!state.head.value.pending }] : [], next: null };
    if (command === "read_local_conversation_draft") return request.key.conversationId === conversationId ? structuredClone(state.head)
      : { key: request.key, revision: "0", writerId: null, value: null };
    if (command === "write_local_conversation_draft" || command === "resolve_local_conversation_draft") {
      const write = request.write ?? request.resolve.write;
      const response: unknown = { key, revision: String(BigInt(state.head.revision) + 1n), writerId: write.writerId,
        value: structuredClone(canonicalConversationDraft(write.value)) };
      if (!validateResponseConversationWritten(response)) throw new Error("Invalid synthetic journal response");
      state.head = response;
      return structuredClone(state.head);
    }
    if (command === "capture_conversation_proposal") {
      const { sessionToken: _, ...original } = request;
      expect(state.head.value?.pending).toMatchObject({ kind: "proposal-capture", request: original });
      const revision = { ...structuredClone(fixture.revision), proposalId: request.proposalId, revisionId: request.revisionId };
      state.revisions.push(revision); return structuredClone(revision);
    }
    if (command === "revise_conversation_proposal") {
      const submitted = structuredClone(request);
      const { sessionToken: _, ...original } = submitted;
      expect(state.head.value?.pending).toMatchObject({ kind: "proposal-revision", request: original });
      if (state.revisionWait) await state.revisionWait.promise;
      const base = state.revisions.find(item => item.revisionId === submitted.expectedRevisionId);
      if (!base) throw new Error("Synthetic proposal basis not found");
      const revision: ConversationProposalRevision = { ...base, revisionId: submitted.revisionId, previousRevisionId: base.revisionId,
        revision: String(BigInt(base.revision) + 1n), ordinal: String(state.revisions.length + 1), content: submitted.content };
      state.revisions.push(revision); return structuredClone(revision);
    }
    throw new Error(`Unexpected synthetic command: ${command}`);
  });
  const open = async (initialTarget: ConversationProposalTarget | null = null, options: { strict?: boolean; visible?: boolean; onOpenKnowledgeProposal?: OpenKnowledgeProposal } = {}) => {
    const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("entries");
    const owner = new ConversationSession(context, () => reads.invalidate(["project"]), () => {});
    expect(await owner.initialize()).toBe(true); expect(await owner.open(conversationId)).toBe(true);
    let target = initialTarget, visible = options.visible ?? true;
    const tree = () => {
      const content = <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
        <ConversationPanel owner={owner} visible={visible} disabled={false} gate={gate} viewId="entries" proposalTarget={target} onOpenKnowledgeProposal={options.onOpenKnowledgeProposal}/>
      </SessionReadProvider></ApplicationReadProvider>;
      return options.strict ? <StrictMode>{content}</StrictMode> : content;
    };
    const view = render(tree());
    const show = (next: ConversationProposalTarget | null = target, nextVisible = visible) => { target = next; visible = nextVisible; view.rerender(tree()); };
    const retire = () => { owner.retire(); reads.retire(); gate.dispose(); };
    disposals.push(retire);
    return { owner, gate, reads, view, show, retire, flush: async () => { await act(async () => { expect(await owner.flush()).toBe(true); }); } };
  };
  const edit = async () => {
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("conversation.proposalEdit") }));
    const editor = await screen.findByRole("region", { name: i18n.t("conversation.proposalEditor") });
    expect(editor).toHaveFocus();
    await waitFor(() => expect(within(editor).getByRole("button", { name: i18n.t("conversation.proposalSaveVersion") })).toBeEnabled());
    return within(editor);
  };
  return { ...fixture, content, state, open, edit };
}

it("reads an existing planning result and captures it once only after an explicit save, without model or execution commands", async () => {
  const h = harness(false), session = await h.open();
  const reply = within(await screen.findByRole("region", { name: "助理回复" }));
  expect(reply.getByText(h.revision.content.summary)).toBeInTheDocument();
  expect(calls("capture_conversation_proposal")).toHaveLength(0);
  expectNoExecution();
  const save = reply.getByRole("button", { name: "保存为提议" });
  fireEvent.click(save); fireEvent.click(save);
  await screen.findByText("这条回复已保存为提议，可以在下方查看版本。");
  await session.flush();
  const history = within(await screen.findByRole("region", { name: "已保存的提议版本" }));
  expect(history.getByText(h.revision.content.summary)).toBeInTheDocument();
  expect(calls("capture_conversation_proposal")).toHaveLength(1);
  expect(calls("revise_conversation_proposal")).toHaveLength(0);
  expect(h.state.head.value?.pending).toBeNull();
  expectNoExecution();
});

it("captures a knowledge result as its own proposal kind without creating a work plan", async () => {
  const h = harness(false, true), session = await h.open();
  const reply = within(await screen.findByRole("region", { name: i18n.t("conversation.reply") }));
  expect(reply.getByRole("heading", { name: "知识提议" })).toBeVisible();
  expect(reply.getByText("Keep a calm tone.")).toBeVisible();
  fireEvent.click(reply.getByRole("button", { name: i18n.t("conversation.proposalCapture") }));
  await screen.findByText(i18n.t("conversation.proposalRecorded")); await session.flush();
  const history = within(await screen.findByRole("region", { name: i18n.t("conversation.proposalHistory") }));
  expect(history.getByText("Mara", { exact: false })).toBeVisible();
  expect(history.queryByRole("button", { name: i18n.t("conversation.planReviewOpen") })).toBeNull();
  expect(h.state.revisions[0].content.kind).toBe("knowledge-proposal"); expect(calls("capture_conversation_proposal")).toHaveLength(1);
  expectNoExecution();
});

it.each(["en-US", "zh-CN"])("keeps knowledge edits B through A, mounted language changes and local reopening in %s", async locale => {
  await i18n.changeLanguage(locale);
  const onOpen = vi.fn<OpenKnowledgeProposal>(async () => true), h = harness(true, true), first = await h.open(null, { onOpenKnowledgeProposal: onOpen });
  const history = within(await screen.findByRole("region", { name: i18n.t("conversation.proposalHistory") }));
  fireEvent.click(history.getByRole("button", { name: i18n.t("conversation.knowledgeOpenReview") }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
  expect(onOpen.mock.calls[0][0]).toEqual({ ...key, proposalId: h.revision.proposalId, revisionId: h.revision.revisionId });
  const editor = await h.edit(), field = editor.getByRole("textbox", { name: i18n.t("conversation.knowledgeText", { number: 1 }) });
  fireEvent.change(field, { target: { value: "Saved A: keep Mara’s voice." } });
  h.state.revisionWait = deferred(); fireEvent.click(editor.getByRole("button", { name: i18n.t("conversation.proposalSaveVersion") }));
  await waitFor(() => expect(calls("revise_conversation_proposal")).toHaveLength(1));
  fireEvent.change(field, { target: { value: "New B 人工输入 stays unchanged" } });
  await act(async () => { await i18n.changeLanguage(locale === "en-US" ? "zh-CN" : "en-US"); });
  expect(editor.getByRole("textbox", { name: i18n.t("conversation.knowledgeText", { number: 1 }) })).toBe(field);
  expect(field).toHaveValue("New B 人工输入 stays unchanged");
  await act(async () => { h.state.revisionWait?.resolve(); });
  await waitFor(() => {
    const input = first.owner.getSnapshot().inputs.get(conversationId);
    expect({ revisions: h.state.revisions.length, failure: input?.failure, notice: input?.notice,
      pending: input?.value.pending, journalPending: h.state.head.value?.pending }).toEqual({
      revisions: 2, failure: null, notice: "proposalRecorded", pending: null, journalPending: null,
    });
  });
  await screen.findByText(i18n.t("conversation.proposalRecorded")); await first.flush();
  expect(field).toHaveValue("New B 人工输入 stays unchanged");
  expect(h.state.revisions.at(-1)?.content).toMatchObject({ kind: "knowledge-proposal", entries: [{ name: "Mara", text: "Saved A: keep Mara’s voice." }] });
  expect(h.state.head.value?.proposalEdits?.[0]).toMatchObject({ expectedRevisionId: h.state.revisions.at(-1)?.revisionId,
    content: { kind: "knowledge-proposal", entries: [{ name: "Mara", text: "New B 人工输入 stays unchanged" }] } });
  first.view.unmount(); first.retire();
  const reopened = await h.open();
  expect(await screen.findByRole("textbox", { name: i18n.t("conversation.knowledgeText", { number: 1 }) })).toHaveValue("New B 人工输入 stays unchanged");
  await reopened.flush(); expect(calls("revise_conversation_proposal")).toHaveLength(1); expectNoExecution();
});

it("reopens incomplete proposal fields without a business save and discards only after a cancellable confirmation", async () => {
  const h = harness(), first = await h.open(), editor = await h.edit();
  expect(editor.getByRole("textbox", { name: "目标与做法" })).toHaveValue(h.revision.content.summary);
  expect(editor.getByRole("checkbox", { name: "dialogue.1" })).toBeChecked();
  expect(editor.getByRole("checkbox", { name: "dialogue.2" })).not.toBeChecked();
  expect(editor.getAllByRole("checkbox")).toHaveLength(2);
  fireEvent.change(editor.getByRole("textbox", { name: "目标与做法" }), { target: { value: "" } });
  fireEvent.click(editor.getByRole("button", { name: "添加问题" }));
  fireEvent.click(editor.getByRole("checkbox", { name: "dialogue.1" }));
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "独立消息还没提交 🙂" } });
  await first.flush();
  expect(h.state.head.value?.proposalEdits?.[0].content).toMatchObject({ summary: "", questions: [""], unitIds: [] });
  first.view.unmount(); first.retire();
  const reopened = await h.open(), retained = within(await screen.findByRole("region", { name: "修改提议" }));
  expect(retained.getByRole("textbox", { name: "目标与做法" })).toHaveValue("");
  expect(retained.getByRole("textbox", { name: "问题 1" })).toHaveValue("");
  await retained.findByRole("checkbox", { name: "dialogue.1" });
  expect(retained.getAllByRole("checkbox").every(box => !(box as HTMLInputElement).checked)).toBe(true);
  expect(retained.getByRole("button", { name: "另存新版本" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("独立消息还没提交 🙂");
  fireEvent.click(retained.getByRole("button", { name: "放弃这些修改" }));
  const confirmation = await screen.findByRole("dialog", { name: "放弃这份提议草稿？" });
  expect(within(confirmation).getByText("目标还没有填写。")).toBeInTheDocument();
  fireEvent.click(within(confirmation).getByText("继续修改", { selector: "button" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(retained.getByRole("textbox", { name: "问题 1" })).toHaveValue("");
  fireEvent.click(retained.getByRole("button", { name: "放弃这些修改" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "放弃这份草稿" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "修改提议" })).not.toBeInTheDocument());
  await reopened.flush();
  expect(h.state.head.value?.proposalEdits).toBeUndefined();
  expect(h.state.head.value?.text).toBe("独立消息还没提交 🙂");
  expect(h.state.revisions).toEqual([h.revision]);
  expect(calls("validate_conversation_proposal")).toHaveLength(0);
  expect(calls("capture_conversation_proposal")).toHaveLength(0);
  expect(calls("revise_conversation_proposal")).toHaveLength(0);
  expectNoExecution();
});

it("blocks IME and another dialog, then keeps newer proposal and message input when save A completes", async () => {
  const h = harness(), session = await h.open(), editor = await h.edit();
  const summary = editor.getByRole("textbox", { name: "目标与做法" });
  fireEvent.change(summary, { target: { value: "保存 A：保留占位符 {name}" } });
  fireEvent.click(editor.getByRole("button", { name: "添加问题" }));
  fireEvent.change(editor.getByRole("textbox", { name: "问题 1" }), { target: { value: "需确认清晨的时间吗？" } });
  fireEvent.click(editor.getByRole("checkbox", { name: "dialogue.1" }));
  fireEvent.click(editor.getByRole("checkbox", { name: "dialogue.2" }));
  await session.flush();
  const save = editor.getByRole("button", { name: "另存新版本" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.focus(summary); fireEvent.compositionStart(summary); fireEvent.click(save);
  expect(calls("validate_conversation_proposal")).toHaveLength(0);
  fireEvent.compositionEnd(summary);
  const closeOther = session.gate.pushDialog("another-dialog"); fireEvent.click(save); closeOther();
  expect(calls("validate_conversation_proposal")).toHaveLength(0);
  h.state.revisionWait = deferred(); fireEvent.click(save);
  await waitFor(() => expect(calls("revise_conversation_proposal")).toHaveLength(1));
  const submitted = calls("revise_conversation_proposal")[0][1].request;
  expect(submitted.content).toEqual({ ...h.content, summary: "保存 A：保留占位符 {name}", questions: ["需确认清晨的时间吗？"], unitIds: [h.unitIds[1]] });
  fireEvent.change(summary, { target: { value: "继续输入 B 🙂\n第二行" } });
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "独立消息 B" } });
  await act(async () => { h.state.revisionWait!.resolve(); });
  await screen.findByText("提议版本已保存。");
  await waitFor(() => expect(save).toBeEnabled()); await session.flush();
  expect(summary).toHaveValue("继续输入 B 🙂\n第二行");
  expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("独立消息 B");
  expect(h.state.head.value?.proposalEdits?.[0]).toMatchObject({ expectedRevisionId: submitted.revisionId, content: { summary: "继续输入 B 🙂\n第二行" } });
  expect(h.state.head.value?.text).toBe("独立消息 B");
  expect(h.state.head.value?.pending).toBeNull();
  expect(calls("revise_conversation_proposal")).toHaveLength(1);
  expectNoExecution();
});

it("compares an external latest version and requires explicit rebasing while preserving local content", async () => {
  const h = harness(), session = await h.open(), editor = await h.edit();
  const summary = editor.getByRole("textbox", { name: "目标与做法" });
  fireEvent.change(summary, { target: { value: "我的本机修改，不替换为外部内容" } });
  await session.flush();
  const latest: ConversationProposalRevision = { ...structuredClone(h.revision), revisionId: id(34003), revision: "2", ordinal: "2",
    previousRevisionId: h.revision.revisionId, content: { ...h.content, summary: "另一个窗口保存的目标", questions: ["外部新增的问题"], unitIds: [h.unitIds[1]] } };
  h.state.revisions.push(latest);
  fireEvent.click(editor.getByRole("button", { name: "重新读取提议" }));
  await editor.findByText("已经有更新的版本。你的修改还在，请先对照再继续。");
  const save = editor.getByRole("button", { name: "另存新版本" });
  expect(save).toBeDisabled(); expect(summary).toHaveValue("我的本机修改，不替换为外部内容");
  expect(editor.queryByRole("button", { name: "接在最新版之后继续" })).not.toBeInTheDocument();
  fireEvent.click(editor.getByRole("button", { name: "对照最新版" }));
  expect(editor.getByText("另一个窗口保存的目标")).toBeInTheDocument();
  expect(editor.getByText("外部新增的问题")).toBeInTheDocument();
  expect(h.state.head.value?.proposalEdits?.[0].expectedRevisionId).toBe(h.revision.revisionId);
  await waitFor(() => expect(editor.getByRole("button", { name: "接在最新版之后继续" })).toBeEnabled());
  fireEvent.click(editor.getByRole("button", { name: "接在最新版之后继续" }));
  await session.flush();
  await editor.findByText("基于第 2 版修改");
  expect(screen.getByRole("region", { name: "修改提议" })).toHaveFocus();
  await waitFor(() => expect(save).toBeEnabled());
  expect(summary).toHaveValue("我的本机修改，不替换为外部内容");
  expect(editor.getByRole("checkbox", { name: "dialogue.1" })).toBeChecked();
  expect(editor.getByRole("checkbox", { name: "dialogue.2" })).not.toBeChecked();
  expect(calls("revise_conversation_proposal")).toHaveLength(0);
  fireEvent.click(save);
  await screen.findByText("提议版本已保存。"); await session.flush();
  expect(calls("revise_conversation_proposal")).toHaveLength(1);
  expect(calls("revise_conversation_proposal")[0][1].request).toMatchObject({ expectedRevisionId: latest.revisionId,
    content: { summary: "我的本机修改，不替换为外部内容", questions: [], unitIds: [h.unitIds[0]] } });
  expect(h.state.revisions[0]).toEqual(h.revision); expect(h.state.revisions[1]).toEqual(latest);
  expectNoExecution();
});

const proposalTarget = (revision: ConversationProposalRevision, focus = true): ConversationProposalTarget => ({
  conversationId: revision.conversationId, proposalId: revision.proposalId, revisionId: revision.revisionId, focus,
});
const openedVersion = (number: string) => i18n.t("conversation.proposalTargetVersion", { number });

it("locates the exact version beyond the first fifty rows in StrictMode and merges the later page without duplicating it or writing a draft", async () => {
  const h = harness(), wait = deferred();
  h.state.revisions = Array.from({ length: 51 }, (_, index) => ({ ...structuredClone(h.revision), revisionId: id(35000 + index),
    revision: String(index + 1), ordinal: String(index + 1), previousRevisionId: index ? id(35000 + index - 1) : null,
    content: { ...structuredClone(h.content), summary: `已保存的提议 ${index + 1}`, questions: index === 50 ? ["夜行时要保留哪种语气？", "换行和 {name} 需要保留吗？"] : [] } }));
  const revision = h.state.revisions[50]; h.state.readWaits.set(revision.revisionId, wait);
  const session = await h.open(proposalTarget(revision), { strict: true });
  await screen.findByText(i18n.t("conversation.proposalTargetReading"));
  const history = within(await screen.findByRole("region", { name: i18n.t("conversation.proposalHistory") }));
  expect(history.getAllByRole("article")).toHaveLength(50);
  expect(history.queryByText(revision.content.summary)).not.toBeInTheDocument();
  expect(calls("read_conversation_proposal").map(([, payload]) => payload.request)).toContainEqual({ ...context,
    conversationId, proposalId: revision.proposalId, revisionId: revision.revisionId });
  await act(async () => { wait.resolve(); });
  const card = await screen.findByRole("article", { name: openedVersion("51") });
  await waitFor(() => expect(card).toHaveFocus());
  expect(within(card).getAllByRole("listitem").map(item => item.textContent)).toEqual(revision.content.questions);
  expect(within(card).getByRole("button", { name: i18n.t("conversation.proposalEdit") })).toBeEnabled();
  expect(within(card).getByRole("button", { name: i18n.t("conversation.planReviewOpen") })).toBeEnabled();
  expect(screen.queryByRole("region", { name: i18n.t("conversation.proposalEditor") })).not.toBeInTheDocument();
  expect(session.owner.getSnapshot().inputs.get(conversationId)?.value.proposalEdits).toBeUndefined();
  expect(calls("write_local_conversation_draft")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.moreProposalVersions") }));
  await waitFor(() => expect(screen.queryByRole("button", { name: i18n.t("conversation.moreProposalVersions") })).not.toBeInTheDocument());
  expect(history.getAllByRole("article")).toHaveLength(51);
  expect(history.getAllByText(revision.content.summary)).toHaveLength(1);
  expect(calls("read_conversation_proposal_revisions").at(-1)?.[1].request).toMatchObject({ after: "50", limit: 50 });
  expect(calls("read_conversation_proposal_revisions").every(([, payload]) => payload.request.after === null || payload.request.after === "50")).toBe(true);
  expect(calls("read_conversation_proposal").every(([, payload]) => payload.request.revisionId === revision.revisionId)).toBe(true);
  expect(calls("capture_conversation_proposal")).toHaveLength(0); expect(calls("revise_conversation_proposal")).toHaveLength(0);
  const beginEdit = vi.spyOn(session.owner, "beginProposalEdit");
  fireEvent.click(within(card).getByRole("button", { name: i18n.t("conversation.proposalEdit") }));
  expect(beginEdit).toHaveBeenCalledTimes(1); expect(beginEdit).toHaveBeenCalledWith(revision);
  await session.flush();
  expect(session.owner.getSnapshot().inputs.get(conversationId)?.value.proposalEdits?.[0]).toMatchObject({ expectedRevisionId: revision.revisionId,
    proposalId: revision.proposalId, content: revision.content });
  expect(calls("write_local_conversation_draft").length).toBeGreaterThan(0);
  expectNoExecution();
});

it.each(["moved", "hidden", "initially-hidden"] as const)("does not take focus after a delayed proposal read when %s", async mode => {
  const h = harness(), wait = deferred(), target = proposalTarget(h.revision);
  h.state.readWaits.set(h.revision.revisionId, wait);
  const session = await h.open(target, { strict: true, visible: mode !== "initially-hidden" });
  const composer = screen.getByRole("textbox", { name: i18n.t("conversation.message") });
  if (mode === "initially-hidden") {
    expect(calls("read_conversation_proposal")).toHaveLength(0);
    session.show(target, true);
  }
  await waitFor(() => expect(calls("read_conversation_proposal").length).toBeGreaterThan(0));
  if (mode === "moved") act(() => composer.focus());
  if (mode === "hidden") session.show(target, false);
  await act(async () => { wait.resolve(); });
  if (mode === "hidden") session.show(target, true);
  const card = await screen.findByRole("article", { name: openedVersion("1") });
  expect(card).not.toHaveFocus();
  if (mode === "moved") expect(composer).toHaveFocus();
  expect(calls("write_local_conversation_draft")).toHaveLength(0);
  expectNoExecution();
});

it("keeps the newer target and input B when an earlier exact-version read finishes late, then clears the target without choosing another card", async () => {
  const h = harness(), wait = deferred();
  h.state.revisions[0].content.questions = ["第一版的问题"];
  const latest: ConversationProposalRevision = { ...structuredClone(h.revision), revisionId: id(36001), revision: "2", ordinal: "2", previousRevisionId: h.revision.revisionId,
    content: { ...structuredClone(h.content), summary: "第二版的目标", questions: ["第二版的问题"] } };
  h.state.revisions.push(latest); h.state.readWaits.set(h.revision.revisionId, wait);
  const session = await h.open(proposalTarget(h.revision), { strict: true });
  await waitFor(() => expect(calls("read_conversation_proposal").length).toBeGreaterThan(0));
  session.show(proposalTarget(latest));
  const current = await screen.findByRole("article", { name: openedVersion("2") });
  await waitFor(() => expect(current).toHaveFocus());
  expect(within(current).getByRole("list").textContent).toBe("第二版的问题");
  const composer = screen.getByRole("textbox", { name: i18n.t("conversation.message") }); act(() => composer.focus());
  fireEvent.change(composer, { target: { value: "读取期间继续写 B 🙂\n下一行" } }); await session.flush();
  const writes = calls("write_local_conversation_draft").length;
  await act(async () => { wait.resolve(); });
  expect(screen.queryByRole("article", { name: openedVersion("1") })).not.toBeInTheDocument();
  expect(within(current).getByRole("list").textContent).toBe("第二版的问题");
  expect(composer).toHaveFocus(); expect(composer).toHaveValue("读取期间继续写 B 🙂\n下一行");
  expect(calls("write_local_conversation_draft")).toHaveLength(writes);
  session.show(null);
  expect(screen.queryByRole("article", { name: openedVersion("2") })).not.toBeInTheDocument();
  expect(composer).toHaveFocus(); expect(screen.queryByText("第一版的问题")).not.toBeInTheDocument();
  session.show(proposalTarget(latest));
  await waitFor(() => expect(screen.getByRole("article", { name: openedVersion("2") })).toHaveFocus());
  expectNoExecution();
});

it("does not reuse the same target’s focus attempt after switching conversations and reopening the original conversation", async () => {
  const h = harness(), wait = deferred(), target = proposalTarget(h.revision), otherId = id(36002);
  h.state.revisions[0].content.questions = ["原对话的问题"]; h.state.readWaits.set(h.revision.revisionId, wait);
  const session = await h.open(target, { strict: true });
  await waitFor(() => expect(calls("read_conversation_proposal").length).toBeGreaterThan(0));
  await act(async () => { expect(await session.owner.open(otherId)).toBe(true); });
  expect(screen.getByText(i18n.t("conversation.proposalTargetConversationChanged"))).toBeInTheDocument();
  expect(screen.queryByText("原对话的问题")).not.toBeInTheDocument();
  await act(async () => { wait.resolve(); });
  expect(screen.queryByRole("article", { name: openedVersion("1") })).not.toBeInTheDocument();
  await act(async () => { expect(await session.owner.open(conversationId)).toBe(true); });
  const card = await screen.findByRole("article", { name: openedVersion("1") });
  expect(within(card).getByRole("list").textContent).toBe("原对话的问题");
  expect(card).not.toHaveFocus();
  expect(calls("write_local_conversation_draft")).toHaveLength(0);
  expectNoExecution();
});

it("preserves message and proposal edits B when opening an exact version and reuses the original Session only after explicit editing", async () => {
  const h = harness(), session = await h.open(), editor = await h.edit(), wait = deferred();
  const summary = editor.getByRole("textbox", { name: i18n.t("conversation.proposalSummary") }), composer = screen.getByRole("textbox", { name: i18n.t("conversation.message") });
  fireEvent.change(summary, { target: { value: "已在修改的提议 B" } });
  fireEvent.change(composer, { target: { value: "消息 B" } }); await session.flush();
  h.state.readWaits.set(h.revision.revisionId, wait);
  const beginEdit = vi.spyOn(session.owner, "beginProposalEdit"), target = proposalTarget(h.revision);
  session.show(target);
  await waitFor(() => expect(calls("read_conversation_proposal").filter(([, payload]) => payload.request.revisionId === h.revision.revisionId).length).toBeGreaterThan(1));
  fireEvent.change(summary, { target: { value: "等待原提议时继续写 B" } });
  fireEvent.change(composer, { target: { value: "等待原提议时的消息 B" } }); await session.flush();
  const saved = structuredClone(h.state.head.value), writes = calls("write_local_conversation_draft").length;
  await act(async () => { wait.resolve(); });
  const card = await screen.findByRole("article", { name: openedVersion("1") });
  expect(summary).toHaveValue("等待原提议时继续写 B"); expect(composer).toHaveValue("等待原提议时的消息 B");
  expect(h.state.head.value).toEqual(saved); expect(calls("write_local_conversation_draft")).toHaveLength(writes);
  expect(beginEdit).not.toHaveBeenCalled();
  fireEvent.click(within(card).getByRole("button", { name: i18n.t("conversation.proposalContinueEditing") }));
  expect(beginEdit).toHaveBeenCalledTimes(1); expect(beginEdit).toHaveBeenCalledWith(h.revision);
  await waitFor(() => expect(screen.getByRole("region", { name: i18n.t("conversation.proposalEditor") })).toHaveFocus());
  expect(summary).toHaveValue("等待原提议时继续写 B"); expect(composer).toHaveValue("等待原提议时的消息 B");
  expect(session.owner.getSnapshot().inputs.get(conversationId)?.value.proposalEdits).toHaveLength(1);
  expect(calls("capture_conversation_proposal")).toHaveLength(0); expect(calls("revise_conversation_proposal")).toHaveLength(0);
  expectNoExecution();
});

it("rereads a failed exact version in place without creating a draft or claiming an unlisted question was answered", async () => {
  const h = harness(); h.state.readFailures.add(h.revision.revisionId);
  const session = await h.open(proposalTarget(h.revision), { strict: true });
  await screen.findByText(i18n.t("conversation.proposalTargetReadFailed"));
  expect(screen.queryByRole("article", { name: openedVersion("1") })).not.toBeInTheDocument();
  const failedReads = calls("read_conversation_proposal").length;
  h.state.readFailures.delete(h.revision.revisionId);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.retryRead") }));
  const card = await screen.findByRole("article", { name: openedVersion("1") });
  expect(within(card).getByText(i18n.t("conversation.proposalTargetNoQuestions"))).toBeInTheDocument();
  expect(card).not.toHaveFocus(); expect(screen.queryByText(/已有答复|已经答复|已回答/)).not.toBeInTheDocument();
  expect(calls("read_conversation_proposal")).toHaveLength(failedReads + 1);
  expect(calls("read_conversation_proposal").every(([, payload]) => payload.request.revisionId === h.revision.revisionId)).toBe(true);
  expect(session.owner.getSnapshot().inputs.get(conversationId)?.value.proposalEdits).toBeUndefined();
  expect(calls("write_local_conversation_draft")).toHaveLength(0);
  expectNoExecution();
});
