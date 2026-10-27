import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../../test/fixtures/translation-commands.json";
import type { DraftBasis, DraftHead, DraftKey, DraftReadView, DraftValue } from "../../../draftCommands";
import type { TranslationSaveReceipt, TranslationSaveRequest } from "../../../translationCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { TranslationDrafts, type TranslationDraftPorts } from "./translationDrafts";
import SegmentEditor, { type EditorCommand, type SegmentEditorHandle, type SegmentEditorProps } from "./SegmentEditor";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, parameters?: { key?: string }) => parameters?.key === undefined ? key : `${key}:${parameters.key}` }) }));
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalInsertCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (originalInsertCommand) Object.defineProperty(document, "execCommand", originalInsertCommand);
  else Reflect.deleteProperty(document, "execCommand");
});

const key: DraftKey = { projectId: fixture.save.projectId, unitId: fixture.save.unitId, locale: fixture.save.locale };
const context = { projectId: key.projectId, sessionToken: "editor-test-session" };
const initial: DraftBasis = { sourceRevisionId: fixture.save.sourceRevisionId, selectionId: null, revisionId: null, text: null };
const writerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const copy = <T,>(value: T): T => structuredClone(value);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function currentView(basis: DraftBasis = initial): DraftReadView["current"] {
  return { kind: "current", basis: copy(basis), nativeKey: "dialogue.hello", sourceText: "Source text" };
}
function draftHead(pending = false): DraftHead {
  const { sessionToken: _token, ...request } = fixture.save;
  return { key, revision: "1", writerId, value: { basis: copy(initial), text: "Retained input", editSeq: "2",
    pending: pending ? { kind: "save", request: { ...request, expectedSelectionId: null, text: "Submitted A" }, submittedSeq: "1" } : null } };
}
function saved(request: TranslationSaveRequest): TranslationSaveReceipt {
  return { ...fixture.receipt, projectId: request.projectId, actionId: request.actionId,
    selection: { ...fixture.receipt.selection, actionId: request.actionId, previousEventId: request.expectedSelectionId ?? null },
    revision: { ...fixture.receipt.revision, actionId: request.actionId, text: request.text, originKind: "manual" },
    basis: { ...fixture.receipt.basis, sourceRevisionId: request.sourceRevisionId, selectionId: fixture.receipt.selection.eventId } };
}
function harness(head: DraftHead = { key, revision: "0", writerId: null, value: null }, initialCurrent = currentView()) {
  let disk = copy(head), current = copy(initialCurrent);
  const commitWrite: TranslationDraftPorts["write"] = async request => {
    disk = { key, revision: (BigInt(disk.revision) + 1n).toString(), writerId: request.write.writerId, value: copy(request.write.value) as DraftValue };
    return copy(disk);
  };
  const ports = {
    read: vi.fn<TranslationDraftPorts["read"]>(async () => copy({ head: disk, current })),
    write: vi.fn<TranslationDraftPorts["write"]>(commitWrite),
    clear: vi.fn<TranslationDraftPorts["clear"]>(async () => { disk = { key, revision: (BigInt(disk.revision) + 1n).toString(), writerId: null, value: null }; return copy(disk); }),
    list: vi.fn<TranslationDraftPorts["list"]>(async () => ({ items: [], next: null })),
    identity: vi.fn<TranslationDraftPorts["identity"]>(async () => fixture.save.actionId),
    save: vi.fn<TranslationDraftPorts["save"]>(async request => saved(request)),
    recoverSave: vi.fn<TranslationDraftPorts["recoverSave"]>(async request => {
      const { sessionToken: _token, ...business } = request;
      return { request: { ...business, expectedSelectionId: business.expectedSelectionId ?? null }, outcome: { kind: "pending", replay: "explicit-same-request" } };
    }),
    writerId: () => writerId,
  };
  const drafts = new TranslationDrafts({ context, ports, reads: { invalidate: vi.fn() } });
  const gate = new InteractionGate(); gate.setVisibleOwner("view-one");
  const dispatch = vi.fn<SegmentEditorProps["dispatch"]>(() => true);
  const props: SegmentEditorProps = { drafts, draftKey: key, viewId: "view-one", gate, disabled: false, nativeKey: "dialogue.hello", dispatch };
  return { drafts, ports, gate, props, dispatch, commitWrite, setCurrent: (next: DraftReadView["current"]) => { current = copy(next); },
    ready: async () => { await drafts.initialize(); await drafts.open(key); } };
}
const input = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "editorLabel:dialogue.hello" });

it("uses the entry label, keeps disabled text selectable, and delegates all confirmation buttons", async () => {
  const h = harness(draftHead()); await h.ready();
  const ref = createRef<SegmentEditorHandle>();
  const ui = render(<SegmentEditor {...h.props} ref={ref} />);
  expect(input()).toHaveValue("Retained input");
  expect(input()).toHaveAttribute("data-editor", "true");
  fireEvent.click(screen.getByRole("button", { name: "editorConfirm" }));
  fireEvent.click(screen.getByRole("button", { name: "confirmNext" }));
  fireEvent.click(screen.getByRole("button", { name: "editorExit" }));
  expect(h.dispatch.mock.calls.map(([command, source]) => [command, source])).toEqual([
    ["translation.confirm", "button"], ["translation.confirm-next", "button"], ["translation.exit-editor", "button"],
  ]);
  expect(h.ports.save).not.toHaveBeenCalled();
  ui.rerender(<SegmentEditor {...h.props} disabled ref={ref} />);
  expect(input()).toHaveAttribute("readonly"); expect(input()).not.toBeDisabled();
  act(() => ref.current?.focus()); expect(input()).toHaveFocus();
});

it("limits recovery presentation to confirmation without promising advance", async () => {
  const h = harness(draftHead()); await h.ready();
  const ui = render(<SegmentEditor {...h.props} allowAdvance={false} />);
  expect(screen.queryByRole("button", { name: "confirmNext" })).not.toBeInTheDocument();
  expect(screen.getByText("editorRecoveryHint")).toBeVisible(); expect(screen.queryByText("editorHint")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "editorConfirm" }));
  expect(h.dispatch).toHaveBeenCalledWith("translation.confirm", "button", expect.any(String));
  expect(h.dispatch.mock.calls.some(([command]) => command === "translation.confirm-next")).toBe(false);
  ui.rerender(<SegmentEditor {...h.props} />);
  expect(screen.getByRole("button", { name: "confirmNext" })).toBeVisible(); expect(screen.getByText("editorHint")).toBeVisible();
  expect(screen.queryByText("editorRecoveryHint")).not.toBeInTheDocument();
});

it("accepts B while confirmation of A is in flight and announces that newer input remains", async () => {
  const h = harness(); await h.ready();
  const receipt = deferred<TranslationSaveReceipt>(); h.ports.save.mockReturnValueOnce(receipt.promise);
  let confirming: ReturnType<TranslationDrafts["confirm"]> | undefined;
  h.dispatch.mockImplementation((command: EditorCommand) => { if (command === "translation.confirm") confirming = h.drafts.confirm(key); return true; });
  render(<SegmentEditor {...h.props} />);
  fireEvent.change(input(), { target: { value: "A" } }); await act(async () => { await h.drafts.flush(key); });
  fireEvent.click(screen.getByRole("button", { name: "editorConfirm" }));
  await waitFor(() => expect(h.ports.save).toHaveBeenCalledTimes(1));
  expect(screen.getByText("editorConfirming")).toBeVisible(); expect(input()).not.toHaveAttribute("readonly");
  fireEvent.change(input(), { target: { value: "B 👩🏽‍💻\né" } });
  expect(input()).toHaveValue("B 👩🏽‍💻\né");
  const result = saved(h.ports.save.mock.calls[0][0]);
  h.setCurrent(currentView({ ...initial, selectionId: result.selection.eventId, revisionId: result.selection.revisionId, text: "A" }));
  await act(async () => { receipt.resolve(result); await confirming; });
  expect(input()).toHaveValue("B 👩🏽‍💻\né"); expect(screen.getByText("editorNewerInput")).toBeVisible();
});

it("gates composition and does not install a competing keyboard command handler", async () => {
  const h = harness(); await h.ready(); const bubbled = vi.fn();
  const ui = render(<div onKeyDown={bubbled}><SegmentEditor {...h.props} /></div>);
  fireEvent.focus(input());
  const ownerId = h.gate.getSnapshot().inputOwner?.ownerId;
  expect(ownerId).toBeDefined();
  fireEvent.compositionStart(input());
  expect(h.gate.canDispatch({ viewId: "view-one", source: "button" })).toBe(false);
  fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
  fireEvent.keyDown(input(), { key: "Escape" });
  expect(bubbled).not.toHaveBeenCalled(); expect(h.dispatch).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input());
  fireEvent.keyDown(input(), { key: "Enter", metaKey: true, keyCode: 229 });
  expect(bubbled).not.toHaveBeenCalled();
  fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
  expect(bubbled).toHaveBeenCalledTimes(1);
  expect(h.gate.canDispatch({ viewId: "view-one", source: "keyboard", inputOwner: ownerId })).toBe(true);
  h.gate.setComposing("other-editor", true); h.gate.setInputOwner("view-one", "other-editor");
  ui.unmount();
  expect(h.gate.getSnapshot().composingOwners).toEqual(["other-editor"]);
  expect(h.gate.getSnapshot().inputOwner?.ownerId).toBe("other-editor");
});

it("reports a draft as retained only after the journal acknowledgement and keeps journal failures actionable", async () => {
  const h = harness(); await h.ready();
  const written = deferred<DraftHead>(); h.ports.write.mockReturnValueOnce(written.promise);
  render(<SegmentEditor {...h.props} />);
  fireEvent.change(input(), { target: { value: "Unacknowledged" } });
  expect(screen.getByText("editorPreserving")).toBeVisible(); expect(screen.queryByText("editorPreserved")).not.toBeInTheDocument();
  await waitFor(() => expect(h.ports.write).toHaveBeenCalledTimes(1));
  await act(async () => { written.resolve(await h.commitWrite(h.ports.write.mock.calls[0][0])); await h.drafts.flush(key); });
  expect(screen.getByText("editorPreserved")).toBeVisible();
  h.ports.write.mockRejectedValueOnce(new Error("Synthetic disk failure"));
  fireEvent.change(input(), { target: { value: "Still here" } });
  expect(await screen.findByText("editorJournalFailed")).toBeVisible();
  expect(input()).toHaveValue("Still here"); expect(screen.queryByText("editorPreserved")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "editorConfirm" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "editorRetryPreserve" }));
  await waitFor(() => expect(screen.getByText("editorPreserved")).toBeVisible());
});

it("shares input across views and keeps it after every borrowed editor unmounts", async () => {
  const h = harness(); await h.ready();
  const ui = render(<StrictMode><SegmentEditor {...h.props} /><SegmentEditor {...h.props} viewId="view-two" autoFocus={false} /></StrictMode>);
  const fields = screen.getAllByRole("textbox", { name: "editorLabel:dialogue.hello" });
  fireEvent.change(fields[0], { target: { value: "Shared draft" } });
  expect(fields[1]).toHaveValue("Shared draft");
  await act(async () => { await h.drafts.flush(key); });
  ui.unmount(); render(<SegmentEditor {...h.props} />);
  expect(input()).toHaveValue("Shared draft"); expect(h.drafts.getSnapshot().retired).toBe(false);
});

it("offers lookup before replay and never offers fresh confirmation or discard for an unknown action", async () => {
  const h = harness(draftHead(true)); await h.ready();
  render(<SegmentEditor {...h.props} />);
  expect(screen.getByText("editorPending")).toBeVisible();
  expect(screen.getByRole("button", { name: "editorConfirm" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "editorReplay" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "editorRestore" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "editorCheckResult" }));
  expect(await screen.findByRole("button", { name: "editorReplay" })).toBeEnabled();
  expect(h.ports.recoverSave).toHaveBeenCalledTimes(1); expect(h.ports.save).not.toHaveBeenCalled();
});

it.each(["mismatch", "read-failed"] as const)("preserves unknown input after %s and withholds replay", async outcome => {
  const h = harness(draftHead(true)); await h.ready();
  if (outcome === "read-failed") h.ports.recoverSave.mockRejectedValueOnce(new Error("Lookup failed"));
  else h.ports.recoverSave.mockImplementationOnce(async request => {
    const { sessionToken: _token, ...business } = request;
    return { request: { ...business, expectedSelectionId: business.expectedSelectionId ?? null }, outcome: { kind: "mismatch" } };
  });
  render(<SegmentEditor {...h.props} />);
  fireEvent.click(screen.getByRole("button", { name: "editorCheckResult" }));
  expect(await screen.findByText(outcome === "mismatch" ? "editorMismatch" : "editorRecoveryFailed")).toBeVisible();
  expect(input()).toHaveValue("Retained input");
  expect(screen.queryByRole("button", { name: "editorReplay" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "editorConfirm" })).toBeDisabled();
});

it.each(["source-missing", "locale-removed"] as const)("keeps local input copyable when %s", async reason => {
  const h = harness(draftHead(), { kind: "unavailable", reason }); await h.ready();
  render(<SegmentEditor {...h.props} />);
  expect(input()).toHaveValue("Retained input");
  expect(screen.getByText(reason === "source-missing" ? "editorSourceMissing" : "editorLocaleRemoved")).toBeVisible();
  expect(screen.getByRole("button", { name: "editorCopy" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "editorConfirm" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "editorRestore" })).not.toBeInTheDocument();
});

it.each([null, "", "Current chosen text"])("shows current selection %j separately and rebases without replacing input", async text => {
  const nextBasis = { ...initial, sourceRevisionId: "changed-source", selectionId: text === null ? null : "new-selection", revisionId: text === null ? null : "new-revision", text };
  const h = harness(draftHead(), currentView(nextBasis)); await h.ready();
  render(<SegmentEditor {...h.props} />);
  const current = within(screen.getByRole("group", { name: "editorCurrentSelection" }));
  expect(current.getByText(text === null ? "editorNoSelection" : text === "" ? "editorEmptySelection" : text)).toBeVisible();
  expect(input()).toHaveValue("Retained input"); expect(screen.getByRole("button", { name: "editorConfirm" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "editorRebase" }));
  await waitFor(() => expect(screen.queryByText("editorBasisChanged")).not.toBeInTheDocument());
  expect(input()).toHaveValue("Retained input"); expect(screen.getByRole("button", { name: "editorConfirm" })).toBeEnabled();
});

it("can retry its initial read without clearing input held by the session", async () => {
  const h = harness(draftHead()); await h.drafts.initialize(); h.ports.read.mockRejectedValueOnce(new Error("Read failed"));
  render(<SegmentEditor {...h.props} />);
  expect(await screen.findByText("editorReadFailed")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "editorRetryRead" }));
  expect(await screen.findByRole("textbox", { name: "editorLabel:dialogue.hello" })).toHaveValue("Retained input");
});

it("requires an explicit second action before restoring the confirmed version", async () => {
  const h = harness(draftHead()); await h.ready(); render(<SegmentEditor {...h.props} />);
  fireEvent.click(screen.getByRole("button", { name: "editorRestore" }));
  expect(screen.getByText("editorRestoreHelp")).toBeVisible(); expect(h.ports.clear).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "editorKeepDraft" }));
  expect(input()).toHaveValue("Retained input"); expect(h.ports.clear).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "editorRestore" }));
  fireEvent.click(screen.getByRole("button", { name: "editorRestoreNow" }));
  await waitFor(() => expect(input()).toHaveValue("")); expect(h.ports.clear).toHaveBeenCalledTimes(1);
});

it("withdraws a restore confirmation when the selected version changes", async () => {
  const h = harness(draftHead()); await h.ready(); render(<SegmentEditor {...h.props} />);
  fireEvent.click(screen.getByRole("button", { name: "editorRestore" }));
  expect(screen.getByRole("button", { name: "editorRestoreNow" })).toBeEnabled();
  await act(async () => {
    h.setCurrent(currentView({ ...initial, selectionId: "new-selection", revisionId: "new-revision", text: "New current selection" }));
    await h.drafts.open(key);
  });
  expect(screen.queryByRole("button", { name: "editorRestoreNow" })).not.toBeInTheDocument();
  expect(input()).toHaveValue("Retained input"); expect(h.ports.clear).not.toHaveBeenCalled();
});

it("does not steal focus as durable status changes and explains clipboard denial with selected text", async () => {
  const h = harness(draftHead()); await h.ready();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")) } });
  render(<><SegmentEditor {...h.props} /><input aria-label="Another input" /></>);
  expect(input()).toHaveFocus();
  screen.getByRole("textbox", { name: "Another input" }).focus();
  await act(async () => { h.drafts.edit(key, "Newer local input"); await h.drafts.flush(key); });
  expect(screen.getByRole("textbox", { name: "Another input" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "editorCopy" }));
  expect(await screen.findByText("editorCopyFailed")).toBeVisible();
  expect(input()).toHaveFocus(); expect(input()).toHaveProperty("selectionStart", 0); expect(input()).toHaveProperty("selectionEnd", "Newer local input".length);
});

async function pasteEditor() {
  const head = draftHead(); if (head.value) head.value.text = "Left replace right";
  const h = harness(head); await h.ready();
  const clipboard = deferred<string>();
  const readText = vi.fn(() => clipboard.promise);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const insertText = vi.fn((command: string, _showUi: boolean, text: string) => {
    const field = document.activeElement;
    if (command !== "insertText" || !(field instanceof HTMLTextAreaElement)) return false;
    const start = field.selectionStart, display = text.replace(/\r\n?/g, "\n");
    fireEvent.change(field, { target: { value: field.value.slice(0, start) + display + field.value.slice(field.selectionEnd) } });
    field.setSelectionRange(start + display.length, start + display.length); return true;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: insertText });
  const view = render(<SegmentEditor {...h.props} />), field = input();
  field.setSelectionRange(5, 12, "backward"); fireEvent.select(field);
  return { ...h, clipboard, readText, insertText, view, field };
}

it("does not claim untouched initial text was written to the local journal", async () => {
  const h = harness(); await h.ready(); render(<SegmentEditor {...h.props} />);
  expect(screen.getByText("editorReady")).toBeVisible();
  expect(screen.queryByText("editorPreserved")).not.toBeInTheDocument(); expect(screen.queryByText("editorNotPreserved")).not.toBeInTheDocument();
});

it("pastes the original decomposed Mac text and line endings through native insertion", async () => {
  const editor = await pasteEditor(), raw = "e\u0301 {{name}}\r\n👩🏽‍💻 مرحبا 日本語";
  expect(fireEvent.paste(editor.field, { clipboardData: { getData: () => raw.replace(/\r\n/g, "\n").normalize("NFC") } })).toBe(false);
  expect(editor.readText).toHaveBeenCalledTimes(1); expect(editor.field).toHaveValue("Left replace right");
  expect(editor.drafts.getSnapshot().mutationReserved).toBe(false);
  expect(editor.gate.getSnapshot().intentOwner).not.toBeNull();
  await act(async () => { editor.clipboard.resolve(raw); await editor.clipboard.promise; await editor.drafts.flush(key); });
  expect(editor.insertText).toHaveBeenCalledWith("insertText", false, raw);
  expect(editor.field).toHaveValue(`Left ${raw.replace(/\r\n/g, "\n")} right`);
  expect(editor.drafts.getEntry(key)?.value?.text).toBe(`Left ${raw.replace(/\r\n/g, "\n")} right`);
  expect(editor.gate.getSnapshot().intentOwner).toBeNull();
});

it("allows a local paste of B while formal confirmation of A owns the mutation reservation", async () => {
  const editor = await pasteEditor(), response = deferred<TranslationSaveReceipt>();
  editor.ports.save.mockReturnValueOnce(response.promise);
  let confirming: ReturnType<TranslationDrafts["confirm"]> | undefined;
  await act(async () => { confirming = editor.drafts.confirm(key); });
  await waitFor(() => expect(editor.ports.save).toHaveBeenCalledTimes(1));
  expect(editor.drafts.getSnapshot().mutationReserved).toBe(true);
  fireEvent.paste(editor.field, { clipboardData: { getData: () => "é" } });
  expect(editor.readText).toHaveBeenCalledTimes(1);
  await act(async () => { editor.clipboard.resolve("e\u0301"); await editor.clipboard.promise; await editor.drafts.flush(key); });
  expect(editor.field).toHaveValue("Left e\u0301 right"); expect(editor.drafts.getSnapshot().mutationReserved).toBe(true);
  const receipt = saved(editor.ports.save.mock.calls[0][0]);
  editor.setCurrent(currentView({ ...initial, selectionId: receipt.selection.eventId, revisionId: receipt.selection.revisionId, text: "Left replace right" }));
  await act(async () => { response.resolve(receipt); await confirming; });
  expect(editor.field).toHaveValue("Left e\u0301 right"); expect(screen.getByText("editorNewerInput")).toBeVisible();
});

it.each(["newer input", "composition", "selection", "focus", "retirement", "source change", "unmount"] as const)("rejects a late paste after %s", async change => {
  const editor = await pasteEditor();
  fireEvent.paste(editor.field, { clipboardData: { getData: () => "é" } });
  if (change === "newer input") fireEvent.change(editor.field, { target: { value: "Newer B" } });
  else if (change === "composition") fireEvent.compositionStart(editor.field);
  else if (change === "selection") { editor.field.setSelectionRange(0, 0); fireEvent.select(editor.field); }
  else if (change === "focus") act(() => screen.getByRole("button", { name: "editorExit" }).focus());
  else if (change === "retirement") act(() => editor.drafts.retire());
  else if (change === "source change") await act(async () => { editor.setCurrent(currentView({ ...initial, sourceRevisionId: "new-source" })); await editor.drafts.open(key); });
  else editor.view.unmount();
  await act(async () => { editor.clipboard.resolve("e\u0301"); await editor.clipboard.promise; await editor.drafts.flush(key); });
  expect(editor.insertText).not.toHaveBeenCalled();
  expect(editor.drafts.getEntry(key)?.value?.text).toBe(change === "newer input" ? "Newer B" : "Left replace right");
  expect(editor.gate.getSnapshot().intentOwner).toBeNull();
});

it.each(["denied", "mismatched", "unavailable"] as const)("preserves input and suppresses normalized default text when clipboard access is %s", async failure => {
  const editor = await pasteEditor(), privateText = "Unrelated private clipboard content";
  if (failure === "unavailable") Object.defineProperty(navigator.clipboard, "readText", { configurable: true, value: undefined });
  expect(fireEvent.paste(editor.field, { clipboardData: { getData: () => "é" } })).toBe(false);
  await act(async () => {
    if (failure === "denied") editor.clipboard.reject(new DOMException("Private failure details", "NotAllowedError"));
    else editor.clipboard.resolve(privateText);
  });
  expect(editor.insertText).not.toHaveBeenCalled(); expect(editor.field).toHaveValue("Left replace right");
  expect(screen.getByText(failure === "denied" ? "editorPasteFailed" : failure === "mismatched" ? "editorPasteChanged" : "editorPasteUnavailable")).toBeVisible();
  expect(document.body).not.toHaveTextContent(privateText); expect(document.body).not.toHaveTextContent("Private failure details");
  expect(editor.gate.getSnapshot().intentOwner).toBeNull();
});

it("clears stale paste feedback when ordinary typing continues after cancellation", async () => {
  const editor = await pasteEditor(); fireEvent.paste(editor.field, { clipboardData: { getData: () => "é" } });
  fireEvent.change(editor.field, { target: { value: "Newer B" } });
  expect(screen.getByText("editorPasteChanged")).toBeVisible();
  fireEvent.change(editor.field, { target: { value: "Newer B, still typing" } });
  expect(screen.queryByText("editorPasteChanged")).not.toBeInTheDocument();
  await act(async () => { editor.clipboard.resolve("e\u0301"); await editor.clipboard.promise; await editor.drafts.flush(key); });
  expect(editor.field).toHaveValue("Newer B, still typing"); expect(editor.insertText).not.toHaveBeenCalled();
  expect(screen.queryByText("editorPasteChanged")).not.toBeInTheDocument();
});

it("cancels a pending paste from its keyboard reachable action and ignores the later clipboard result", async () => {
  const editor = await pasteEditor(); fireEvent.paste(editor.field, { clipboardData: { getData: () => "é" } });
  const cancel = screen.getByRole("button", { name: "editorPasteCancel" });
  act(() => cancel.focus()); fireEvent.click(cancel);
  expect(screen.getByText("editorPasteCancelled")).toBeVisible(); expect(editor.field).toHaveFocus();
  expect(editor.gate.getSnapshot().intentOwner).toBeNull();
  await act(async () => { editor.clipboard.resolve("e\u0301"); await editor.clipboard.promise; });
  expect(editor.insertText).not.toHaveBeenCalled(); expect(editor.field).toHaveValue("Left replace right");
});

it("keeps actual partial native input without assigning a fallback value", async () => {
  const editor = await pasteEditor(), readingDuringInsertion: boolean[] = [];
  editor.insertText.mockImplementation(() => {
    fireEvent.change(editor.field, { target: { value: "Partial native input" } });
    readingDuringInsertion.push(screen.queryByText("editorPasteReading") !== null);
    return false;
  });
  fireEvent.paste(editor.field, { clipboardData: { getData: () => "é" } });
  await act(async () => { editor.clipboard.resolve("e\u0301"); await editor.clipboard.promise; await editor.drafts.flush(key); });
  expect(editor.field).toHaveValue("Partial native input"); expect(editor.drafts.getEntry(key)?.value?.text).toBe("Partial native input");
  expect(readingDuringInsertion).toEqual([true]);
  expect(screen.getByText("editorPasteUnconfirmed")).toBeVisible();
});

it("keeps Windows native paste behavior", async () => {
  const editor = await pasteEditor(); vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(fireEvent.paste(editor.field, { clipboardData: { getData: () => "é" } })).toBe(true);
  expect(editor.readText).not.toHaveBeenCalled(); expect(editor.gate.getSnapshot().intentOwner).toBeNull();
});
