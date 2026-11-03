import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { defaultAiConfig } from "../../../aiCommands";
import { canonicalConversationDraft, type ConversationDraftHead } from "../../../conversationDraftCommands";
import type { PreparedConversationPlanning, ProjectConversationMessage } from "../../../conversationCommands";
import { i18n } from "../../../i18n";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { connectionFixture } from "../../../testSupport/connectionFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import ConversationPanel from "./ConversationPanel";
import { ConversationSession } from "./ConversationSession";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: id(49000), sessionToken: "send-review-fixture" }, conversationId = id(49001), key = { projectId: context.projectId, conversationId };
const resources: (() => void)[] = [];
afterEach(() => { cleanup(); resources.splice(0).forEach(dispose => dispose()); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function harness(locale = "en-US", delayedPrepare = false) {
  await i18n.changeLanguage(locale); invoke.mockReset();
  let head: ConversationDraftHead = { key, revision: "0", writerId: null, value: null }, prepared: PreparedConversationPlanning | null = null;
  const messages: ProjectConversationMessage[] = [{ ...key, messageId: id(49002), ordinal: "1", author: "human", body: "Earlier history: do not share implicitly" }];
  const preparing = deferred<void>(), sending = deferred<void>();
  if (!delayedPrepare) preparing.resolve();
  invoke.mockImplementation(async (command, { request }) => {
    if (command === "list_project_conversations") return { projectId: context.projectId, rows: [{ ...key, title: "Question fixture", ordinal: "1" }], nextAfter: null };
    if (command === "read_project_conversation_messages") return { ...key, rows: structuredClone(messages), nextAfter: null };
    if (["read_conversation_planning_attempts", "read_conversation_proposal_revisions", "read_conversation_proposal_work_plans"].includes(command)) return { ...key, rows: [], nextAfter: null };
    if (command === "read_model_connections") return connectionFixture([]);
    if (command === "read_local_conversation_draft") return structuredClone(head);
    if (command === "write_local_conversation_draft" || command === "resolve_local_conversation_draft") {
      const write = request.write ?? request.resolve.write;
      const next = { key, revision: String(BigInt(head.revision) + 1n), writerId: write.writerId, value: canonicalConversationDraft(structuredClone(write.value)) };
      if (!validateResponseConversationWritten(next)) throw new Error("Invalid synthetic journal response");
      head = next;
      return structuredClone(head);
    }
    if (command === "append_project_conversation_message") {
      const message: ProjectConversationMessage = { ...key, messageId: request.messageId, ordinal: String(messages.length + 1), author: "human", body: request.body };
      messages.push(message); return message;
    }
    if (command === "prepare_conversation_planning") {
      await preparing.promise;
      const selected = messages.filter(message => request.selectedMessageIds.includes(message.messageId));
      const system = "Synthetic planning instructions", input = JSON.stringify({ messages: selected.map(message => message.body), units: [] });
      prepared = { preparationId: id(49003), previewDigest: "b".repeat(64), preview: { version: 2, ...key,
        config: request.config, scope: request.scope, selectedMessages: selected, units: [], system, input,
        byteLength: new TextEncoder().encode(JSON.stringify({ system, input })).length,
        brief: { messages: selected.length, units: 0, sourceTexts: 0, terms: 0, manualContexts: 0, manualContextFacts: 0, sourceContextFacts: 0, sourceContextNeighbors: 0 } } };
      return structuredClone(prepared);
    }
    if (command === "validate_conversation_planning") return structuredClone(prepared);
    if (command === "start_conversation_planning") {
      expect(head.value?.pending).toMatchObject({ kind: "planning", request: { ...key, consent: request.consent } });
      await sending.promise; return { ...key, consent: request.consent, inputDigest: "c".repeat(64) };
    }
    throw new Error(`Unexpected synthetic command: ${command}`);
  });
  const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("entries");
  const owner = new ConversationSession(context, () => reads.invalidate(["project"]), () => {}, { list: async () => ({ items: [], next: null }) });
  resources.push(() => { owner.retire(); reads.retire(); gate.dispose(); });
  await owner.initialize(); await owner.open(conversationId);
  owner.setPlanningConfig(conversationId, { ...defaultAiConfig, endpoint: "http://127.0.0.1:9/v1/chat/completions", model: "synthetic-question", credentialEnv: "" });
  render(<ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
    <ConversationPanel owner={owner} visible disabled={false} gate={gate} viewId="entries"/>
  </SessionReadProvider></ApplicationReadProvider>);
  await screen.findByText(messages[0].body);
  const field = screen.getByRole("textbox", { name: i18n.t("conversation.message") });
  const calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);
  return { owner, field, messages, preparing, sending, calls };
}

it.each(["en-US", "zh-CN"])("prepares the current question, keeps cancelled input and sends only after explicit review in %s", async locale => {
  const h = await harness(locale); h.field.focus(); fireEvent.change(h.field, { target: { value: "Question A 👩🏽‍💻" } });
  fireEvent.compositionStart(h.field); fireEvent.keyDown(h.field, { key: "Enter" }); expect(h.calls("append_project_conversation_message")).toHaveLength(0);
  fireEvent.compositionEnd(h.field); fireEvent.keyDown(h.field, { key: "Enter", shiftKey: true }); expect(h.calls("append_project_conversation_message")).toHaveLength(0);
  fireEvent.keyDown(h.field, { key: "Enter" }); fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.prepareMessage") }));
  const preview = await screen.findByRole("region", { name: i18n.t("conversation.askPreview") });
  expect(within(preview).getByText("Question A 👩🏽‍💻")).toBeVisible();
  expect(within(preview).queryByText(h.messages[0].body)).not.toBeInTheDocument();
  expect(h.calls("append_project_conversation_message")).toHaveLength(1); expect(h.calls("prepare_conversation_planning")).toHaveLength(1);
  expect(h.calls("start_conversation_planning")).toHaveLength(0);
  expect(h.owner.getSnapshot().inputs.get(conversationId)?.planning.messageIds).toEqual([h.messages[1].messageId]);
  fireEvent.change(h.field, { target: { value: "Newer B stays local" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.askClose") }));
  expect(screen.queryByRole("region", { name: i18n.t("conversation.askPreview") })).not.toBeInTheDocument(); expect(h.field).toHaveValue("Newer B stays local"); expect(h.field).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.askTitle") }));
  const restored = await screen.findByRole("region", { name: i18n.t("conversation.askPreview") });
  expect(within(restored).getByRole("checkbox")).not.toBeChecked(); fireEvent.click(within(restored).getByRole("checkbox"));
  fireEvent.click(within(restored).getByRole("button", { name: i18n.t("conversation.askSend") }));
  await waitFor(() => expect(h.calls("start_conversation_planning")).toHaveLength(1));
  fireEvent.change(h.field, { target: { value: "Newest B while A sends" } });
  await act(async () => h.sending.resolve()); await screen.findByText(i18n.t("conversation.planningRecorded"));
  expect(h.field).toHaveValue("Newest B while A sends"); expect(h.calls("append_project_conversation_message")).toHaveLength(1);
});

it("only saves a message without preparing or sending a request", async () => {
  const h = await harness(); fireEvent.change(h.field, { target: { value: "A local note" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.saveMessage") })); await screen.findByText(i18n.t("conversation.messageSaved"));
  expect(h.calls("append_project_conversation_message")).toHaveLength(1); expect(h.calls("prepare_conversation_planning")).toHaveLength(0);
  expect(h.calls("start_conversation_planning")).toHaveLength(0);
});

it("does not move focus away from newer B when preparation of A finishes", async () => {
  const h = await harness("en-US", true); h.field.focus(); fireEvent.change(h.field, { target: { value: "A waits for local preparation" } }); fireEvent.keyDown(h.field, { key: "Enter" });
  await waitFor(() => expect(h.calls("prepare_conversation_planning")).toHaveLength(1));
  h.field.focus(); fireEvent.change(h.field, { target: { value: "B keeps focus" } }); await act(async () => h.preparing.resolve());
  await screen.findByRole("region", { name: i18n.t("conversation.askPreview") });
  expect(h.field).toHaveValue("B keeps focus"); expect(h.field).toHaveFocus(); expect(h.calls("start_conversation_planning")).toHaveLength(0);
});
