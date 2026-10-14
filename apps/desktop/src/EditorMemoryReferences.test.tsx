import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorMemoryReferences } from "./EditorMemoryReferences";
import { SessionReadProvider } from "./SessionReadProvider";
import { resourceCommands, type TmSuggestion } from "./resourceCommands";
import { reviewCommands } from "./reviewCommands";
import { reviewTargetFixture } from "./testSupport/reviewFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import { i18n } from "./i18n";
import type { SessionRequest } from "./executionCommands";

const context: SessionRequest = { projectId: id(900), sessionToken: "memory-session" };
const target = { unitId: id(601), sourceRevisionId: id(602) };
const other = { unitId: id(611), sourceRevisionId: id(612) };
const suggestion = (text = "你好 {{player}} 👩🏽‍💻 é"): TmSuggestion => ({ unitId: id(620), sourceRevisionId: id(621),
  translationRevisionId: id(622), targetLocale: "zh-CN", sourceText: "Hello {{player}}", translationText: text,
  originKind: "ai", matchKind: "fuzzy", scorePercent: 85, isCurrentSelection: true, hasHumanApproval: false });
function Harness({ selected = target, session = context, enabled = true }: {
  selected?: typeof target; session?: SessionRequest; enabled?: boolean;
}) {
  const [draft, setDraft] = useState("Manual draft A");
  return <SessionReadProvider key={`${session.projectId}:${session.sessionToken}`} context={session} bridge={false}>
    <label>Editable draft<textarea value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <EditorMemoryReferences context={session} target={selected} locale="zh-CN" enabled={enabled} draftText={draft} />
  </SessionReadProvider>;
}
function delayed<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  vi.spyOn(resourceCommands, "suggestions").mockResolvedValue([suggestion()]);
  vi.spyOn(reviewCommands, "editorSnapshot").mockImplementation(async request => ({
    readVersion: "a".repeat(64), target: reviewTargetFixture({ unitId: request.unitId, sourceRevisionId: request.unitId === other.unitId ? other.sourceRevisionId : target.sourceRevisionId, locale: request.locale }),
    translations: { unitId: request.unitId, locale: request.locale, total: "0", current: null, currentText: null, rows: [], nextOrdinal: null },
    terms: { unitId: request.unitId, sourceRevisionId: target.sourceRevisionId, locale: request.locale, entries: [] }, context: null,
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("reads only the enabled current entry and compares without changing its editable draft", async () => {
  const view = render(<Harness enabled={false} />);
  expect(resourceCommands.suggestions).not.toHaveBeenCalled();
  view.rerender(<Harness />);
  await screen.findAllByText(suggestion().translationText);
  expect(resourceCommands.suggestions).toHaveBeenCalledExactlyOnceWith({ ...context, unitId: target.unitId, locale: "zh-CN", offset: 0, limit: 20 });
  expect(reviewCommands.editorSnapshot).toHaveBeenCalledExactlyOnceWith({ ...context, unitId: target.unitId, locale: "zh-CN" });
  fireEvent.click(screen.getByText("Compare with current draft"));
  fireEvent.change(screen.getByRole("textbox", { name: "Editable draft" }), { target: { value: "New B 日本語 مرحبا {{player}} 👩🏽‍💻 é" } });
  expect(screen.getByRole("textbox", { name: "Editable draft" })).toHaveValue("New B 日本語 مرحبا {{player}} 👩🏽‍💻 é");
  expect(screen.getByText("New B 日本語 مرحبا {{player}} 👩🏽‍💻 é", { selector: "pre" })).toBeInTheDocument();
  expect(screen.getByText(/AI candidate/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("Source", { selector: "summary" }));
  expect(screen.getByText("Reference source revision")).toBeInTheDocument();
  expect(screen.getByText("Saved translation revision")).toBeInTheDocument();
  expect(screen.getByText(suggestion().sourceRevisionId)).toBeInTheDocument();
  expect(screen.getByText(suggestion().translationRevisionId)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Save|Approve|Use/ })).not.toBeInTheDocument();
});

it("keeps suggestions scoped to the selected entry when an earlier read arrives late", async () => {
  const old = delayed<TmSuggestion[]>();
  vi.mocked(resourceCommands.suggestions).mockImplementation(request => request.unitId === target.unitId ? old.promise : Promise.resolve([suggestion("Second entry reference")]));
  const view = render(<Harness />);
  await waitFor(() => expect(resourceCommands.suggestions).toHaveBeenCalledTimes(1));
  view.rerender(<Harness selected={other} />);
  await screen.findAllByText("Second entry reference");
  await act(async () => old.resolve([suggestion("Late first entry reference")]));
  expect(screen.queryByText("Late first entry reference")).not.toBeInTheDocument();
  expect(screen.getAllByText("Second entry reference")[0]).toBeInTheDocument();
});

it("does not display an old session's late results in a replacement session", async () => {
  const old = delayed<TmSuggestion[]>();
  vi.mocked(resourceCommands.suggestions).mockImplementation(request => request.sessionToken === context.sessionToken ? old.promise : Promise.resolve([suggestion("Replacement session reference")]));
  const view = render(<Harness />);
  await waitFor(() => expect(resourceCommands.suggestions).toHaveBeenCalledTimes(1));
  view.rerender(<Harness session={{ projectId: id(930), sessionToken: "replacement" }} />);
  await screen.findAllByText("Replacement session reference");
  await act(async () => old.resolve([suggestion("Old session reference")]));
  expect(screen.queryByText("Old session reference")).not.toBeInTheDocument();
});

it("rejects a changed source basis even when the suggestions call succeeded", async () => {
  const current = vi.mocked(reviewCommands.editorSnapshot).getMockImplementation()!;
  vi.mocked(reviewCommands.editorSnapshot).mockImplementationOnce(async request => {
    const snapshot = await current(request);
    return { ...snapshot, target: { ...snapshot.target, sourceRevisionId: id(999) } };
  });
  render(<Harness />);
  expect(await screen.findByRole("alert")).toHaveTextContent("This entry’s source changed. Refresh the current entry");
  expect(screen.queryByText(suggestion().translationText)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry this read" }));
  await screen.findAllByText(suggestion().translationText);
});

it.each(["wrong-locale", "duplicate", "overflow"])("refuses inconsistent reference rows: %s", async kind => {
  const row = suggestion();
  vi.mocked(resourceCommands.suggestions).mockResolvedValue(kind === "wrong-locale" ? [{ ...row, targetLocale: "ja-JP" }]
    : kind === "duplicate" ? [row, row] : Array.from({ length: 21 }, (_, index) => ({ ...row, translationRevisionId: id(1000 + index) })));
  render(<Harness />);
  await screen.findByRole("alert");
  expect(screen.queryByText(row.translationText)).not.toBeInTheDocument();
});

it("retains new input through a failed read and explicit retry", async () => {
  vi.mocked(resourceCommands.suggestions).mockRejectedValueOnce(new Error("Read unavailable"));
  render(<Harness />);
  await screen.findByRole("alert");
  const draft = screen.getByRole("textbox", { name: "Editable draft" });
  fireEvent.change(draft, { target: { value: "Kept after failure B" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry this read" }));
  await screen.findAllByText(suggestion().translationText);
  expect(draft).toHaveValue("Kept after failure B");
});

it("hides retained suggestions when a refresh fails instead of presenting them as current", async () => {
  render(<Harness />);
  await screen.findAllByText(suggestion().translationText);
  vi.mocked(resourceCommands.suggestions).mockRejectedValueOnce(new Error("Changed writer"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("alert");
  expect(screen.queryByText(suggestion().translationText)).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Editable draft" })).toHaveValue("Manual draft A");
});

it("does not expose a late result after references are hidden, and rereads on return", async () => {
  const old = delayed<TmSuggestion[]>();
  vi.mocked(resourceCommands.suggestions).mockReturnValueOnce(old.promise);
  const view = render(<Harness />);
  await waitFor(() => expect(resourceCommands.suggestions).toHaveBeenCalledTimes(1));
  view.rerender(<Harness enabled={false} />);
  await act(async () => old.resolve([suggestion("Hidden late reference")]));
  expect(screen.queryByText("Hidden late reference")).not.toBeInTheDocument();
  view.rerender(<Harness />);
  await screen.findAllByText(suggestion().translationText);
  expect(resourceCommands.suggestions).toHaveBeenCalledTimes(2);
});

it("reports a confirmed empty read separately from loading or failure", async () => {
  vi.mocked(resourceCommands.suggestions).mockResolvedValue([]);
  render(<Harness />);
  await screen.findByText("No matching saved translations.");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
