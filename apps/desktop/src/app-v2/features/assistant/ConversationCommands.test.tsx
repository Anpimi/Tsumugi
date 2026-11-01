import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { CommandBindings, COMMAND_BINDINGS_STORAGE_KEY, workspaceCommandCatalog, workspaceCommandMetadata } from "../../../commandBindings";
import { WorkbenchCommands } from "../../../workbenchCommands";
import { canonicalConversationDraft, type ConversationDraftHead, type conversationDraftCommands } from "../../../conversationDraftCommands";
import type { conversationCommands, ProjectConversation } from "../../../conversationCommands";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { i18n } from "../../../i18n";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { createWorkspaceCommandDispatcher } from "../../workspace/workspaceCommands";
import { ConversationSession } from "./ConversationSession";
import ConversationPanel from "./ConversationPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: fixtureIdentity(970), sessionToken: "conversation-command-test" }, viewId = "entries";
const resources: { owner: ConversationSession; reads: SessionReads; gate: InteractionGate }[] = [];
beforeEach(async () => { invoke.mockReset(); localStorage.removeItem(COMMAND_BINDINGS_STORAGE_KEY); await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); resources.splice(0).forEach(({ owner, reads, gate }) => { owner.retire(); reads.retire(); gate.dispose(); }); localStorage.removeItem(COMMAND_BINDINGS_STORAGE_KEY); });

async function harness(held = false) {
  const heads = new Map<string, ConversationDraftHead>(), saved: ProjectConversation[] = [];
  let identity = 971, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; }); if (!held) release();
  const create = vi.fn(async (request: Parameters<typeof conversationCommands.create>[0]) => {
    await ready;
    const receipt = { projectId: request.projectId, conversationId: request.conversationId, title: request.title, ordinal: String(saved.length + 1) };
    saved.push(receipt); return receipt;
  });
  function commit(write: Parameters<typeof conversationDraftCommands.write>[0]["write"]) {
    const value: unknown = { key: write.key, revision: String(BigInt(write.expectedRevision) + 1n), writerId: write.writerId,
      value: canonicalConversationDraft(structuredClone(write.value)) };
    if (!validateResponseConversationWritten(value)) throw new Error("Invalid synthetic journal response");
    heads.set(write.key.conversationId, value); return structuredClone(value);
  }
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "list_project_conversations") return { projectId: context.projectId, rows: [...saved], nextAfter: null };
    if (["read_project_conversation_messages", "read_conversation_planning_attempts", "read_conversation_proposal_revisions", "read_conversation_proposal_work_plans"].includes(command)) {
      return { projectId: request.projectId, conversationId: request.conversationId, rows: [], nextAfter: null };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner(viewId);
  const owner = new ConversationSession(context, () => reads.invalidate(["project"]), () => {}, {
    identity: () => fixtureIdentity(identity++), list: async () => ({ items: [], next: null }),
    read: async request => structuredClone(heads.get(request.key.conversationId) ?? { key: request.key, revision: "0", writerId: null, value: null }),
    write: async request => commit(request.write), resolve: async request => commit(request.resolve.write), create,
  });
  resources.push({ owner, reads, gate }); await owner.initialize();
  const bindings = new CommandBindings(workspaceCommandCatalog), commands = new WorkbenchCommands(bindings), scope = { ...context, area: "translation" as const };
  let visible = true, disabled = false, parentDialogId: string | undefined;
  const tree = () => <StrictMode><ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
    <ConversationPanel owner={owner} commands={commands} visible={visible} disabled={disabled} gate={gate} viewId={viewId} parentDialogId={parentDialogId}/>
  </SessionReadProvider></ApplicationReadProvider></StrictMode>;
  const rendered = render(tree());
  const dispatcher = createWorkspaceCommandDispatcher({ gate, modifier: "meta", getContext: () => ({ viewId, scope, commands }) });
  const key = (options: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: "n", metaKey: true, cancelable: true, ...options });
  const settled = async () => waitFor(() => {
    const state = owner.getSnapshot(), input = state.activeId ? state.inputs.get(state.activeId) : undefined;
    expect(input?.value.pending).toBeNull(); expect(input?.journalBusy).toBe(false);
  });
  const show = (next: { visible?: boolean; disabled?: boolean; parentDialogId?: string }) => {
    visible = next.visible ?? true; disabled = next.disabled ?? false; parentDialogId = next.parentDialogId; rendered.rerender(tree());
  };
  return { owner, gate, commands, bindings, dispatcher, scope, create, release, key, settled, show, rendered };
}

it("creates once through the shared command, blocks another creation in flight, and rebinds the same button action without a model", async () => {
  const h = await harness(true);
  expect(h.dispatcher.list().find(command => command.id === "conversation.new-thread")).toMatchObject({ nameKey: "conversation.newThread", binding: "Mod+N", availability: { enabled: true } });
  const event = h.key(); act(() => { expect(h.dispatcher.handleKeyDown(event, viewId)).toBe(true); });
  expect(event.defaultPrevented).toBe(true); await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
  act(() => { expect(h.dispatcher.handleKeyDown(h.key(), viewId)).toBe(false); });
  const blockedButton = screen.getByRole("button", { name: "New conversation" });
  expect(blockedButton).toHaveAttribute("aria-disabled", "true");
  expect(within(blockedButton).getByRole("button", { hidden: true })).toBeDisabled();
  fireEvent.click(blockedButton); expect(h.create).toHaveBeenCalledTimes(1);
  await act(async () => { h.release(); }); await h.settled();
  expect(h.bindings.set("conversation.new-thread", "Mod+Alt+N")).toEqual({ kind: "saved" });
  expect(new CommandBindings(workspaceCommandCatalog).resolve("conversation.new-thread", "Mod+N")).toBe("Mod+Alt+N");
  expect(h.dispatcher.handleKeyDown(h.key(), viewId)).toBe(false);
  act(() => { expect(h.dispatcher.handleKeyDown(h.key({ altKey: true }), viewId)).toBe(true); });
  await waitFor(() => expect(h.create).toHaveBeenCalledTimes(2)); await h.settled();
  const dispatch = vi.spyOn(h.commands, "dispatch");
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  expect(dispatch).toHaveBeenCalledWith("conversation.new-thread", h.scope);
  await waitFor(() => expect(h.create).toHaveBeenCalledTimes(3)); await h.settled();
  expect(invoke.mock.calls.every(([command]) => ["list_project_conversations", "read_project_conversation_messages", "read_conversation_planning_attempts", "read_conversation_proposal_revisions", "read_conversation_proposal_work_plans"].includes(command))).toBe(true);
});

it("keeps hidden, stale, composing and modal panels inactive and limits the Agent drawer to its own new-thread command", async () => {
  const h = await harness(), openProject = vi.fn();
  h.commands.register({ ...workspaceCommandMetadata("workspace.open-project"), category: "project", scope: h.scope, risk: "changes-view", confirmation: "none", availability: () => ({ enabled: true }), handler: openProject });
  expect(h.dispatcher.handleKeyDown(h.key({ isComposing: true }), viewId)).toBe(false);
  act(() => h.gate.setComposing("conversation-composer", true));
  expect(h.commands.dispatch("conversation.new-thread", h.scope)).toBe(false);
  act(() => h.gate.setComposing("conversation-composer", false));
  let closeModal!: () => void; act(() => { closeModal = h.gate.pushDialog("settings"); });
  expect(h.dispatcher.handleKeyDown(h.key(), viewId)).toBe(false); act(closeModal);
  act(() => h.gate.setVisibleOwner("other-view"));
  expect(h.commands.dispatch("conversation.new-thread", h.scope)).toBe(false);
  act(() => h.gate.setVisibleOwner(viewId));
  h.show({ visible: false }); expect(h.commands.dispatch("conversation.new-thread", h.scope)).toBe(false);
  h.show({ disabled: true }); expect(h.commands.dispatch("conversation.new-thread", h.scope)).toBe(false);
  h.show({ parentDialogId: "workspace-dock" });
  let closeDrawer!: () => void, closeNested!: () => void;
  act(() => { closeDrawer = h.gate.pushDialog("workspace-dock"); closeNested = h.gate.pushDialog("settings"); });
  expect(h.dispatcher.handleKeyDown(h.key(), viewId, undefined, "workspace-dock")).toBe(false); act(closeNested);
  expect(h.dispatcher.handleKeyDown(h.key({ key: "o" }), viewId, undefined, "workspace-dock")).toBe(false);
  expect(h.dispatcher.handleKeyDown(h.key(), viewId, "stale-input", "workspace-dock")).toBe(false);
  expect(h.create).not.toHaveBeenCalled(); expect(openProject).not.toHaveBeenCalled();
  act(() => { expect(h.dispatcher.handleKeyDown(h.key(), viewId, undefined, "workspace-dock")).toBe(true); });
  await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1)); await h.settled(); act(closeDrawer);
  h.rendered.unmount(); expect(h.commands.describe("conversation.new-thread", h.scope)).toBeUndefined();
});

it("routes command palette actions to the same explicit composer input without running or sharing it", async () => {
  const h = await harness();
  act(() => { h.commands.dispatch("conversation.new-thread", h.scope); });
  await h.settled();
  expect(h.commands.describe("conversation.translate", h.scope)?.nameKey).toBe("conversation.commandTranslate");
  act(() => { expect(h.commands.dispatch("conversation.translate", h.scope)).toBe(true); });
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("/translate ");
  expect(h.owner.getSnapshot().inputs.get(h.owner.getSnapshot().activeId!)?.planning.consent).toBe(false);
  let close!: () => void; act(() => { close = h.gate.pushDialog("other"); });
  expect(h.commands.dispatch("conversation.review", h.scope)).toBe(false); act(close);
  h.show({ visible: false }); expect(h.commands.dispatch("conversation.terms", h.scope)).toBe(false);
  expect(invoke.mock.calls.some(([command]) => command === "start_conversation_planning" || command === "start_work_plan" || command === "prepare_conversation_planning")).toBe(false);
});
