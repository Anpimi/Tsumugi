import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import type { ConversationDraftHead } from "../../../conversationDraftCommands";
import type { ProjectConversationMessage } from "../../../conversationCommands";
import { ConversationSession } from "./ConversationSession";
import ConversationPanel from "./ConversationPanel";
import { InteractionGate } from "../../workspace/interactionGate";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { connectionFixture } from "../../../testSupport/connectionFixture";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { defaultAiConfig } from "../../../aiCommands";
import type { WorkspaceSelection } from "../../workspace/workspaceSelection";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: fixtureIdentity(900), sessionToken: "conversation-panel" }, conversationId = fixtureIdentity(901);
const thread = { projectId: context.projectId, conversationId, title: "春季更新", ordinal: "1" };
const key = { projectId: context.projectId, conversationId };
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("zh-CN"); });
afterEach(cleanup);

it.each(["conversation-only", "units"] as const)("reviews %s material and exact limits before one request, clears changed consent, and blocks IME and other dialogs", async mode => {
  let head: ConversationDraftHead = { key, revision: "0", writerId: null, value: null };
  const message = { ...key, messageId: fixtureIdentity(902), body: "  请先解释这条消息，不要改译文。\n", author: "human", ordinal: "1" };
  const config = { ...defaultAiConfig, endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "模拟助理", credentialEnv: "",
    connectionProfile: { profileId: fixtureIdentity(910), storeId: fixtureIdentity(911), revision: "1", digest: "a".repeat(64) } };
  let prepared: unknown;
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "list_project_conversations") return { projectId: context.projectId, rows: [thread], nextAfter: null };
    if (command === "read_project_conversation_messages") return { ...key, rows: [message], nextAfter: null };
    if (["read_conversation_planning_attempts", "read_conversation_proposal_revisions", "read_conversation_proposal_work_plans"].includes(command)) return { ...key, rows: [], nextAfter: null };
    if (command === "read_model_connections") return connectionFixture([config]);
    if (command === "read_local_conversation_draft") return structuredClone(head);
    if (command === "write_local_conversation_draft" || command === "resolve_local_conversation_draft") {
      const write = request.write ?? request.resolve.write;
      head = { key, revision: String(BigInt(head.revision) + 1n), writerId: write.writerId, value: structuredClone(write.value) }; return structuredClone(head);
    }
    if (command === "prepare_conversation_planning") {
      const system = "Synthetic instructions";
      const units = request.scope.kind === "units" ? request.scope.unitIds.map((unitId: string) => ({ unitId, sourceLocale: "en", targetLocale: request.scope.locale,
        nativeKey: "greeting", sourceText: "Hello {name}", terms: request.config.shareTerms ? [{ source: "Hello", target: "你好", protected: false }] : [], context: null, humanProtected: true })) : [];
      const input = JSON.stringify({ messages: [message.body], units });
      prepared = { preparationId: fixtureIdentity(915), previewDigest: "b".repeat(64), preview: { version: 2, ...key, config: request.config,
        scope: request.scope, selectedMessages: [message], units: units.map((unit: { unitId: string; terms: unknown[] }) => ({ unitId: unit.unitId, sourceSnapshotId: fixtureIdentity(920), sourceRevisionId: fixtureIdentity(921), selectionId: fixtureIdentity(922), translationRevisionId: fixtureIdentity(923),
          protection: { unitId: unit.unitId, locale: request.scope.locale, revision: "1", protected: true }, sharedTermRevisionIds: unit.terms.length ? [fixtureIdentity(924)] : [], sharedContextRevisionId: null })),
        system, input, byteLength: new TextEncoder().encode(JSON.stringify({ system, input })).length,
        brief: { messages: 1, units: units.length, sourceTexts: units.length, terms: units.reduce((count: number, unit: { terms: unknown[] }) => count + unit.terms.length, 0), manualContexts: 0, manualContextFacts: 0, sourceContextFacts: 0, sourceContextNeighbors: 0 } } };
      return prepared;
    }
    if (command === "validate_conversation_planning") return prepared;
    if (command === "start_conversation_planning") {
      expect(head.value?.pending).toMatchObject({ kind: "planning", request: { ...key, consent: request.consent } });
      return { ...key, consent: request.consent, inputDigest: "c".repeat(64) };
    }
    throw new Error(`Unexpected ${command}`);
  });
  const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("entries");
  const owner = new ConversationSession(context, () => reads.invalidate(["project"]), () => {}, { list: async () => ({ items: [], next: null }) });
  await owner.initialize(); await owner.open(conversationId);
  const selection: WorkspaceSelection = { kind: "ids", locale: "zh-CN", sourceSnapshotId: fixtureIdentity(920), unitIds: [fixtureIdentity(925)] };
  const tree = (selected: WorkspaceSelection = selection) => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
    <ConversationPanel owner={owner} visible disabled={false} gate={gate} viewId="entries" selection={selected}/>
  </SessionReadProvider></ApplicationReadProvider>;
  const rendered = render(tree());
  await screen.findByText("请先解释这条消息，不要改译文。");
  expect(invoke.mock.calls.some(([command]) => command === "prepare_conversation_planning" || command === "start_conversation_planning")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "询问助理" }));
  if (mode === "units") {
    fireEvent.click(screen.getByRole("button", { name: "带入当前选择（1）" }));
    expect(screen.getByText("已固定 1 个条目 → zh-CN。之后改筛选不会改变这个范围。")).toBeInTheDocument();
    rendered.rerender(tree({ kind: "ids", locale: "ja-JP", sourceSnapshotId: fixtureIdentity(926), unitIds: [fixtureIdentity(927)] }));
    expect(screen.getByText("已固定 1 个条目 → zh-CN。之后改筛选不会改变这个范围。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: i18n.t("ai.shareTerms") }));
  }
  expect(screen.getByRole("button", { name: "核对发送内容" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "发送第 1 条消息" }));
  await screen.findByRole("option", { name: "Synthetic 模拟助理 · 模拟助理" });
  fireEvent.change(screen.getByRole("combobox", { name: i18n.t("connections.choose") }), { target: { value: config.connectionProfile.profileId } });
  fireEvent.click(screen.getByRole("button", { name: "核对发送内容" }));
  const preview = await screen.findByRole("region", { name: "核对这次请求" });
  if (mode === "units") {
    expect(within(preview).getByText("这次会分享 1 条消息和 1 个条目的原文，目标语言为 zh-CN。")).toBeInTheDocument();
    expect(within(preview).getByText("当前选用的译文不在发送内容里。")).toBeInTheDocument();
    fireEvent.click(within(preview).getByRole("button", { name: "查看完整请求" }));
    expect(within(preview).getByText(/"sourceText": "Hello \{name\}"/)).toBeInTheDocument();
    expect(within(preview).getByText(/"humanProtected": true/)).toBeInTheDocument();
    expect(within(preview).getByText(/"sourceText"/).textContent).not.toContain("selectionId");
  } else expect(within(preview).getByText("只分享这 1 条消息，不带项目条目或资源。")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "发送一次" })).toBeDisabled();
  const consent = within(preview).getByRole("checkbox"); fireEvent.click(consent);
  fireEvent.change(screen.getByRole("spinbutton", { name: i18n.t("ai.maxOutputTokens") }), { target: { value: "1500" } });
  expect(screen.queryByRole("region", { name: "核对这次请求" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "核对发送内容" }));
  const refreshed = await screen.findByRole("region", { name: "核对这次请求" });
  const confirm = within(refreshed).getByRole("checkbox"); expect(confirm).not.toBeChecked(); fireEvent.click(confirm);
  const send = screen.getByRole("button", { name: "发送一次" });
  fireEvent.compositionStart(confirm); fireEvent.click(send); expect(invoke.mock.calls.some(([command]) => command === "start_conversation_planning")).toBe(false);
  fireEvent.compositionEnd(confirm);
  const close = gate.pushDialog("other"); fireEvent.click(send); close();
  expect(invoke.mock.calls.some(([command]) => command === "start_conversation_planning")).toBe(false);
  fireEvent.click(send);
  await screen.findByText("规划请求已记录，可以在这个对话里查看结果。");
  const starts = invoke.mock.calls.filter(([command]) => command === "start_conversation_planning"); expect(starts).toHaveLength(1);
  expect(starts[0][1].request.consent).toMatchObject({ shareMessages: true, shareUnits: mode === "units" });
  expect(head.value?.pending).toBeNull();
  owner.retire(); reads.retire();
});

it("shows saved messages and keeps composer input across presentation changes without IME or dialog shortcuts submitting it", async () => {
  let head: ConversationDraftHead = { key, revision: "0", writerId: null, value: null };
  const messages: ProjectConversationMessage[] = [];
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "list_project_conversations") return { projectId: context.projectId, rows: [thread], nextAfter: null };
    if (command === "read_project_conversation_messages") return { ...key, rows: messages, nextAfter: null };
    if (["read_conversation_planning_attempts", "read_conversation_proposal_revisions", "read_conversation_proposal_work_plans"].includes(command)) return { ...key, rows: [], nextAfter: null };
    if (command === "read_local_conversation_draft") return structuredClone(head);
    if (command === "write_local_conversation_draft" || command === "resolve_local_conversation_draft") {
      const write = request.write ?? request.resolve.write;
      head = { key, revision: String(BigInt(head.revision) + 1n), writerId: write.writerId, value: structuredClone(write.value) }; return structuredClone(head);
    }
    if (command === "append_project_conversation_message") {
      const message = { ...key, body: request.body, messageId: request.messageId, author: "human" as const, ordinal: String(messages.length + 1) };
      messages.push(message); return message;
    }
    if (command === "recover_project_conversation_message") {
      const { sessionToken: _, ...original } = request;
      return { request: original, outcome: { kind: "recorded", receipt: messages.find(message => message.messageId === request.messageId) } };
    }
    throw new Error(`Unexpected ${command}`);
  });
  const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("entries");
  const owner = new ConversationSession(context, () => reads.invalidate(["project"]), () => {}, { list: async () => ({ items: [], next: null }) });
  await owner.initialize();
  const tree = (visible = true) => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
    <ConversationPanel owner={owner} visible={visible} disabled={false} gate={gate} viewId="entries"/>
  </SessionReadProvider></ApplicationReadProvider>;
  const view = render(tree());
  await waitFor(() => expect(screen.getByRole("button", { name: "对话" })).toBeEnabled());
  screen.getByRole("button", { name: "对话" }).focus();
  fireEvent.keyDown(screen.getByRole("button", { name: "对话" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "春季更新" }));
  const input = await screen.findByRole("textbox", { name: "消息" });
  fireEvent.focus(input); fireEvent.change(input, { target: { value: "  先看这几条 🙂\n" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "保存消息" })).toBeEnabled());
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: "Enter", metaKey: true });
  expect(messages).toHaveLength(0); fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter", metaKey: true, keyCode: 229 });
  fireEvent.keyDown(input, { key: "Enter" }); expect(messages).toHaveLength(0);
  const closeDialog = gate.pushDialog("another-dialog"); fireEvent.keyDown(input, { key: "Enter", metaKey: true }); expect(messages).toHaveLength(0); closeDialog();
  fireEvent.keyDown(input, { key: "Enter", metaKey: true });
  await waitFor(() => expect(input).toHaveValue("")); expect(messages).toHaveLength(1);
  expect(await screen.findByText("先看这几条 🙂")).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "append_project_conversation_message")[0][1].request.body).toBe("  先看这几条 🙂\n");
  fireEvent.change(input, { target: { value: "继续写 B" } }); await act(async () => { await owner.flush(); });
  view.rerender(tree(false)); expect(gate.getSnapshot().inputOwner).toBeNull();
  view.rerender(tree()); expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("继续写 B");
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    const result = await original(command, payload);
    if (command === "append_project_conversation_message") throw new Error("Lost acknowledgement");
    return result;
  });
  fireEvent.click(screen.getByRole("button", { name: "保存消息" }));
  await screen.findByRole("button", { name: "核对请求结果" });
  expect(screen.getAllByText("上一次请求还需要核对，当前输入已保留。")).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "核对期间继续写 C" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "核对请求结果" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "核对请求结果" }));
  await screen.findByText("消息已保存。");
  expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("核对期间继续写 C");
  expect(messages).toHaveLength(2);
  expect(invoke.mock.calls.some(([command]) => command === "start_conversation_planning" || command === "create_project_conversation")).toBe(false);
  owner.retire(); reads.retire();
});
