import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import { conversationProposalFixture } from "../../../testSupport/conversationProposalFixture";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { ConversationText } from "./ConversationText";
import { ConversationEntryReferences } from "./ConversationEntryReferences";
import { assistantComposerCommands, composerCommand } from "../../../assistantComposerCommands";
import { composerMemberRoute } from "./ConversationMemberRoutes";
import { workspaceCommandCatalog } from "../../../commandBindings";

beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("folds completed text beyond six lines and copies the untouched full Unicode text", async () => {
  const text = "一 🙂\ntwo\nthree\nfour\nfive\nsix\nseven é\n[[untrusted]] #99";
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<ConversationText text={text}/>);
  const expand = screen.getByRole("button", { name: i18n.t("conversation.textExpand") });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  expect(document.querySelector("p")).toHaveTextContent("seven é");
  fireEvent.click(expand); expect(expand).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.textCopy") }));
  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(text));
  expect(await screen.findByRole("status")).toHaveTextContent(i18n.t("conversation.textCopied"));
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("reports a clipboard failure and keeps the full text available", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  render(<ConversationText text="Keep this text"/>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.textCopy") }));
  expect(await screen.findByRole("status")).toHaveTextContent(i18n.t("conversation.textCopyFailed"));
  expect(screen.getByText("Keep this text")).toBeVisible();
});

it("opens only a saved entry reference tuple and invalidates an in-flight route when its original read changes", async () => {
  const { run } = conversationProposalFixture({ projectId: fixtureIdentity(900), conversationId: fixtureIdentity(901) });
  let capturedCurrent: (() => boolean) | undefined;
  const open = vi.fn(async (_target, current: () => boolean) => { capturedCurrent = current; return true; });
  const view = render(<ConversationEntryReferences run={run} current={() => true} onOpen={open}/>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.entryReference", { entry: "dialogue.1", locale: "zh-CN" }) }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  expect(open.mock.calls[0][0]).toEqual({ projectId: run.preview.projectId, conversationId: run.preview.conversationId, attemptId: run.detail.attemptId,
    unitId: run.preview.units[0].unitId, locale: "zh-CN", sourceSnapshotId: run.preview.units[0].sourceSnapshotId, sourceRevisionId: run.preview.units[0].sourceRevisionId });
  expect(capturedCurrent?.()).toBe(true);
  view.rerender(<ConversationEntryReferences run={structuredClone(run)} current={() => true} onOpen={open}/>);
  expect(capturedCurrent?.()).toBe(false);
});

it("shares the five discoverable command definitions and recognizes only explicit command tokens", () => {
  expect(assistantComposerCommands).toHaveLength(5);
  for (const command of assistantComposerCommands) {
    expect(workspaceCommandCatalog).toContainEqual(command);
    for (const alias of command.aliases) expect(composerCommand(`${alias} keep human edits`)).toBe(command);
  }
  expect(composerCommand("开始吧")).toBeNull();
  expect(composerCommand("please /translate")).toBeNull();
  expect(composerCommand("/translate-everything")).toBeNull();
});


it("resolves @ names only against an unambiguous current roster, including names with spaces", () => {
  const open = vi.fn(), route = { key: "saved-role", name: "Translator A", plan: "1", current: () => true, open };
  expect(composerMemberRoute("@Translator A Preserve this text", [route])).toEqual({ route, body: "Preserve this text" });
  expect(composerMemberRoute("@Translator A Preserve this text", [route, { ...route, key: "other-plan" }])).toBeNull();
  expect(composerMemberRoute("@译者 Start", [route])).toBeNull();
  expect(composerMemberRoute("@Translator A Start", [{ ...route, current: () => false }])).toBeNull();
  expect(open).not.toHaveBeenCalled();
});


it("does not label a different original record as copied after a delayed clipboard result", async () => {
  let finish!: () => void;
  const copied = new Promise<void>(resolve => { finish = resolve; });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(() => copied) } });
  const view = render(<ConversationText text="Original A"/>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("conversation.textCopy") }));
  view.rerender(<ConversationText text="Original B"/>);
  await act(async () => { finish(); await copied; });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByText("Original B")).toBeVisible();
});
