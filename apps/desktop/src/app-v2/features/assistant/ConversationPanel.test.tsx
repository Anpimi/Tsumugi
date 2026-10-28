import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: fixtureIdentity(900), sessionToken: "conversation-panel" }, conversationId = fixtureIdentity(901);
const thread = { projectId: context.projectId, conversationId, title: "春季更新", ordinal: "1" };
const key = { projectId: context.projectId, conversationId };
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("zh-CN"); });
afterEach(cleanup);

it("shows saved messages and keeps composer input across presentation changes without IME or dialog shortcuts submitting it", async () => {
  let head: ConversationDraftHead = { key, revision: "0", writerId: null, value: null };
  const messages: ProjectConversationMessage[] = [];
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "list_project_conversations") return { projectId: context.projectId, rows: [thread], nextAfter: null };
    if (command === "read_project_conversation_messages") return { ...key, rows: messages, nextAfter: null };
    if (command === "read_conversation_planning_attempts") return { ...key, rows: [], nextAfter: null };
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
  const tree = (visible = true) => <SessionReadProvider context={context} reads={reads} bridge={false}>
    <ConversationPanel owner={owner} visible={visible} disabled={false} gate={gate} viewId="entries"/>
  </SessionReadProvider>;
  const view = render(tree());
  await waitFor(() => expect(screen.getByRole("button", { name: "对话" })).toBeEnabled());
  fireEvent.pointerDown(screen.getByRole("button", { name: "对话" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
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
