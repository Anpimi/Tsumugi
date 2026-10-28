import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { canonicalConversationDraft, type ConversationDraftHead } from "../../../conversationDraftCommands";
import type { ConversationProposalRevision } from "../../../conversationCommands";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { conversationProposalFixture } from "../../../testSupport/conversationProposalFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import ConversationPanel from "./ConversationPanel";
import { ConversationSession } from "./ConversationSession";

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
    "capture_conversation_proposal", "revise_conversation_proposal",
  ].includes(command))).toEqual([]);
}
function harness(saved = true) {
  const fixture = conversationProposalFixture(key);
  if (fixture.revision.content.kind !== "proposal") throw new Error("Synthetic history must contain a proposal");
  const content = fixture.revision.content;
  const state = {
    head: { key, revision: "0", writerId: null, value: null } as ConversationDraftHead,
    revisions: saved ? [structuredClone(fixture.revision)] : [] as ConversationProposalRevision[],
    revisionWait: null as ReturnType<typeof deferred> | null,
  };
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "list_project_conversations") return { projectId: context.projectId,
      rows: [{ ...key, title: "夜行对话", ordinal: "1" }], nextAfter: null };
    if (command === "read_project_conversation_messages") return { ...key, rows: fixture.run.preview.selectedMessages, nextAfter: null };
    if (command === "read_conversation_planning_attempts") return { ...key,
      rows: [{ attemptId: fixture.run.receipt.consent.attemptId, taskId: fixture.run.receipt.consent.taskId, sequence: "1" }], nextAfter: null };
    if (command === "read_conversation_planning") return structuredClone(fixture.run);
    if (command === "read_conversation_proposal_revisions") return { ...key, rows: structuredClone(state.revisions), nextAfter: null };
    if (command === "read_conversation_proposal" || command === "validate_conversation_proposal") {
      const revision = request.revisionId === null ? [...state.revisions].reverse().find(item => item.proposalId === request.proposalId)
        : state.revisions.find(item => item.proposalId === request.proposalId && item.revisionId === request.revisionId);
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
  const open = async () => {
    const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("entries");
    const owner = new ConversationSession(context, () => reads.invalidate(["project"]), () => {});
    expect(await owner.initialize()).toBe(true); expect(await owner.open(conversationId)).toBe(true);
    const view = render(<SessionReadProvider context={context} reads={reads} bridge={false}>
      <ConversationPanel owner={owner} visible disabled={false} gate={gate} viewId="entries"/>
    </SessionReadProvider>);
    const retire = () => { owner.retire(); reads.retire(); gate.dispose(); };
    disposals.push(retire);
    return { owner, gate, view, retire, flush: async () => { await act(async () => { expect(await owner.flush()).toBe(true); }); } };
  };
  const edit = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "修改这份提议" }));
    const editor = await screen.findByRole("region", { name: "修改提议" });
    expect(editor).toHaveFocus();
    await waitFor(() => expect(within(editor).getByRole("button", { name: "另存新版本" })).toBeEnabled());
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
