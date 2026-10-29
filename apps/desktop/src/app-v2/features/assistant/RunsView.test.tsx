import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { i18n } from "../../../i18n";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { ConversationSession } from "./ConversationSession";
import RunsView from "./RunsView";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: id(92001), sessionToken: "runs-synthetic" }, conversationId = id(92002);
const disposals: (() => void)[] = [];
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("zh-CN"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });

async function harness() {
  let failInput = false, failList = false;
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "list_project_conversations") {
      if (failList) throw new Error("Synthetic list unavailable");
      return { projectId: context.projectId, rows: [{ projectId: context.projectId, conversationId, ordinal: "1", title: "第三章" }], nextAfter: null };
    }
    if (command === "read_conversation_proposal_work_plans") return { projectId: context.projectId, conversationId: request.conversationId, rows: [], nextAfter: null };
    throw new Error(`Unexpected business command: ${command}`);
  });
  const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("runs");
  const owner = new ConversationSession(context, vi.fn(), vi.fn(), { identity: () => id(92003),
    list: async () => ({ items: [], next: null }), read: async request => {
      if (failInput) throw new Error("Synthetic input unavailable");
      return { key: request.key, revision: "0", writerId: null, value: null };
    } });
  await owner.initialize();
  const assistant = vi.fn(), candidate = vi.fn(async () => true);
  const view = render(<ApplicationReadProvider><SessionReadProvider reads={reads} context={context} bridge={false}>
    <RunsView owner={owner} disabled={false} gate={gate} viewId="runs" onAssistant={assistant} onOpenCandidate={candidate} onOpenTeamCandidate={candidate}/>
  </SessionReadProvider></ApplicationReadProvider>);
  disposals.push(() => { owner.retire(); reads.retire(); gate.dispose(); });
  return { owner, reads, gate, assistant, view, user: userEvent.setup(), failInput: (value: boolean) => { failInput = value; }, failList: (value: boolean) => { failList = value; } };
}

it("opens a conversation’s original plan history without writing input or dispatching work", async () => {
  const h = await harness();
  expect(screen.getByRole("heading", { name: "工作计划" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "选择项目对话" })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("conversation.chooseThreadPlaceholder") })).toBeEnabled());
  await h.user.click(screen.getByRole("button", { name: i18n.t("conversation.chooseThreadPlaceholder") }));
  await h.user.click(screen.getByRole("menuitem", { name: "第三章" }));
  await screen.findByText(i18n.t("conversation.planHistoryEmpty"));
  expect(h.owner.getSnapshot().activeId).toBe(conversationId);
  expect(h.owner.getSnapshot().inputs.get(conversationId)?.dirty).toBe(false);
  expect(new Set(invoke.mock.calls.map(([command]) => command))).toEqual(new Set(["list_project_conversations", "read_conversation_proposal_work_plans"]));
  await h.user.click(screen.getByRole("button", { name: "打开项目助理" })); expect(h.assistant).toHaveBeenCalledOnce();
});

it("shows a failed input read with a retry and keeps the same original conversation", async () => {
  const h = await harness(); h.failInput(true);
  await act(async () => { expect(await h.owner.open(conversationId)).toBe(false); });
  expect(await screen.findByText(i18n.t("conversation.inputReadFailed"))).toBeVisible();
  h.failInput(false);
  await h.user.click(screen.getByRole("button", { name: i18n.t("conversation.retryRead") }));
  await screen.findByText(i18n.t("conversation.planHistoryEmpty"));
  expect(h.owner.getSnapshot().activeId).toBe(conversationId);
});
