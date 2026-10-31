import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionTaskSession } from "../../../ExecutionTaskSession";
import { ResourceDraftSession, useResourceDraftSession } from "../../../ResourceDraftSession";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { TranslationDraftSession, useTranslationDraftSession } from "../../../TranslationDraftSession";
import { executionCommands, executionContext } from "../../../executionCommands";
import { i18n } from "../../../i18n";
import type { CommandError, ProjectView } from "../../../projectCommands";
import { resourceCommands, type ContextRevision, type SaveContext } from "../../../resourceCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import { SessionReads } from "../../../sessionReads";
import { sourceCommands } from "../../../sourceCommands";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { installResourceDraftFixture } from "../../../testSupport/resourceDraftFixture";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import type { KnowledgeOwner } from "../knowledge/knowledgeTypes";
import EntryContextNotes from "./EntryContextNotes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const first = reviewTargetFixture({ unitId: id(98701), sourceRevisionId: id(98702), nativeKey: "dialogue.first", sourceText: "Hello {{name}}" });
const second = reviewTargetFixture({ unitId: id(98703), sourceRevisionId: id(98704), nativeKey: "dialogue.second" });
const project: ProjectView = { sessionToken: "synthetic-entry-notes", locator: "/synthetic/entry-notes", reconciliationState: "settled",
  metadata: { projectId: id(98700), displayName: "Synthetic context notes", sourceLocale: "en", targetLocales: ["zh-CN", "de-DE"], metadataRevision: "1" } };
const context = executionContext(project), viewId = "entry-notes-view";
let reads: SessionReads, gate: InteractionGate, observed: KnowledgeOwner | null;
let translation: ReturnType<typeof useTranslationDraftSession> | null;
let notes: Map<string, ContextRevision>, records: Map<string, NonNullable<Awaited<ReturnType<typeof resourceCommands.contextAction>>>>;
let save: (request: SaveContext) => Promise<ContextRevision>, counter: number;
const noteKey = (unitId: string, locale: string) => `${unitId}:${locale}`;
const label = (key: "manualContext" | "reason" | "editFromEntry" | "saveContext" | "discardDraft" | "fixInput" | "refresh" | "adoptCurrentContext" | "retry" | "fixedInput" | "savedNewer") => i18n.t(`resource.${key}`);
function owner() { if (!observed) throw new Error("The real resource owner is not mounted"); return observed; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function accept(request: SaveContext): ContextRevision {
  const value: ContextRevision = { revisionId: id(++counter), previousRevisionId: request.expectedRevisionId ?? null,
    unitId: request.unitId, locale: request.locale, text: request.text, reason: request.reason };
  notes.set(noteKey(value.unitId, value.locale), value);
  records.set(request.actionId, { request: { ...structuredClone(request), expectedRevisionId: request.expectedRevisionId ?? null }, receipt: structuredClone(value) });
  return value;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  reads = new SessionReads(context); gate = new InteractionGate(); gate.setVisibleOwner(viewId); observed = null; translation = null; counter = 98710;
  notes = new Map([[noteKey(first.unitId, first.locale), { revisionId: id(98705), previousRevisionId: null, unitId: first.unitId,
    locale: first.locale, text: "Original note 👩🏽‍💻 é", reason: "Original reason" }]]); records = new Map();
  save = async request => accept(request);
  invoke.mockReset(); invoke.mockImplementation(async command => { throw new Error(`Unexpected synthetic command: ${command}`); });
  installResourceDraftFixture();
  vi.spyOn(executionCommands, "identity").mockImplementation(async () => id(++counter));
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ revision: "1", currentSnapshot: first.sourceSnapshotId });
  vi.spyOn(resourceCommands, "context").mockImplementation(async request => structuredClone(notes.get(noteKey(request.unitId, request.locale)) ?? null));
  vi.spyOn(resourceCommands, "resolve").mockImplementation(async request => ({ unitId: request.unitId, locale: request.locale,
    sourceRevisionId: request.unitId === second.unitId ? second.sourceRevisionId : first.sourceRevisionId, entries: [] }));
  vi.spyOn(resourceCommands, "saveContext").mockImplementation(async request => save(request.context));
  vi.spyOn(resourceCommands, "contextAction").mockImplementation(async request => structuredClone(records.get(request.context.actionId) ?? null));
  vi.spyOn(resourceCommands, "observeContextAction").mockImplementation(async request => structuredClone(records.get(request.context.actionId) ?? null));
  vi.spyOn(resourceCommands, "captureContext").mockImplementation(async request => {
    const note = notes.get(noteKey(request.capture.unitId, request.capture.locale));
    return { captureId: request.capture.actionId, unitId: request.capture.unitId, locale: request.capture.locale,
      sourceRevisionId: request.capture.sourceRevisionId, budgetBytes: request.capture.budgetBytes,
      included: [{ kind: "source", revisionId: request.capture.sourceRevisionId, text: "Hello {{name}}", provenance: "extracted-current-source" },
        ...(note ? [{ kind: "manual", revisionId: note.revisionId, text: note.text, provenance: note.reason }] : [])],
      omitted: [{ kind: "term", reference: "Ambiguous word", reason: "conflict" }] };
  });
});
afterEach(() => { cleanup(); reads.retire(); gate.dispose(); vi.restoreAllMocks(); });

function Content({ target, visible = true, onOpenEntry }: { target: ReviewTarget; visible?: boolean; onOpenEntry?: (unitId: string, locale: string) => Promise<boolean> }) {
  const value = useResourceDraftSession(), draft = useTranslationDraftSession();
  useLayoutEffect(() => { observed = value; translation = draft; });
  return <EntryContextNotes project={project} target={target} owner={value} gate={gate} viewId={viewId} disabled={false} visible={visible} onOpenEntry={onOpenEntry}/>;
}
function tree(target: ReviewTarget, visible = true, onOpenEntry?: (unitId: string, locale: string) => Promise<boolean>) {
  return <SessionReadProvider context={context} reads={reads} bridge={false}><TranslationDraftSession project={project}><ExecutionTaskSession project={project}>
    <ResourceDraftSession project={project}><Content target={target} visible={visible} onOpenEntry={onOpenEntry}/></ResourceDraftSession>
  </ExecutionTaskSession></TranslationDraftSession></SessionReadProvider>;
}
async function open() {
  const view = render(tree(first)), user = userEvent.setup();
  await waitFor(() => expect(owner().journal.hydration).toBe("ready"));
  await waitFor(() => expect(screen.getByRole("button", { name: label("editFromEntry") })).toBeEnabled());
  await act(async () => {
    translation?.begin({ unitId: first.unitId, locale: first.locale, sourceRevisionId: first.sourceRevisionId, key: first.nativeKey, sourceText: first.sourceText }, null, null, "Translation B 🧵");
  });
  await user.click(screen.getByRole("button", { name: label("editFromEntry") }));
  return { view, user };
}
function edit(value: string) { fireEvent.change(screen.getByRole("textbox", { name: label("manualContext") }), { target: { value } }); }

it.each(["en-US", "zh-CN"])("opens the real note owner explicitly and preserves note B and translation B after A is saved (%s)", async language => {
  await i18n.changeLanguage(language);
  const reply = deferred<ContextRevision>(); save = async () => reply.promise;
  const { user } = await open();
  expect(resourceCommands.saveContext).not.toHaveBeenCalled();
  edit("Submitted A {{name}}\n第一行");
  await user.click(screen.getByRole("button", { name: label("saveContext") }));
  await waitFor(() => expect(resourceCommands.saveContext).toHaveBeenCalledOnce());
  const request = vi.mocked(resourceCommands.saveContext).mock.calls[0][0].context;
  expect(request).toMatchObject({ unitId: first.unitId, locale: first.locale, sourceRevisionId: first.sourceRevisionId,
    expectedRevisionId: id(98705), text: "Submitted A {{name}}\n第一行", reason: "Original reason" });
  edit("New B 👩🏽‍💻 é\nsecond line");
  await act(async () => { reply.resolve(accept(request)); });
  await waitFor(() => expect(owner().current().pending).toBeNull());
  expect(screen.getByRole("textbox", { name: label("manualContext") })).toHaveValue("New B 👩🏽‍💻 é\nsecond line");
  expect(await screen.findByText(label("savedNewer"))).toBeVisible();
  expect(translation?.current()?.text).toBe("Translation B 🧵");
});

it("keeps B after an explicit failed save and leaves the original saved basis intact", async () => {
  const rejected: CommandError = { code: "storage-failed", outcome: "rejected", stage: "execution-adopt", recoveryRequired: false, reason: "synthetic-context-save" };
  save = async () => { throw rejected; };
  const { user } = await open(); edit("Note B after failure");
  await user.click(screen.getByRole("button", { name: label("saveContext") }));
  await waitFor(() => expect(owner().current().failure).not.toBeNull());
  expect(owner().current().pending).toBeNull(); expect(owner().current().contextRevision?.revisionId).toBe(id(98705));
  expect(screen.getByRole("textbox", { name: label("manualContext") })).toHaveValue("Note B after failure");
  expect(translation?.current()?.text).toBe("Translation B 🧵");
});

it("checks an unknown original request before an explicit same-request retry, keeping newer input", async () => {
  let attempts = 0;
  save = async request => { if (++attempts === 1) throw new Error("Synthetic acknowledgement lost"); return accept(request); };
  const { user } = await open(); edit("Original submitted A");
  await user.click(screen.getByRole("button", { name: label("saveContext") }));
  await waitFor(() => expect(owner().current().pendingUncertain).toBe(true));
  edit("Newer B while checking");
  expect(screen.queryByRole("button", { name: label("retry") })).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("knowledge.recoveryCheck") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: i18n.t("knowledge.recoveryCheck") }));
  await user.click(await screen.findByRole("button", { name: label("retry") }));
  await waitFor(() => expect(owner().current().pending).toBeNull());
  const calls = vi.mocked(resourceCommands.saveContext).mock.calls;
  expect(calls).toHaveLength(2); expect(calls[1][0]).toEqual(calls[0][0]);
  expect(executionCommands.identity).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox", { name: label("manualContext") })).toHaveValue("Newer B while checking");
});

it("retains another entry's unfinished note until it is explicitly discarded and offers its original location", async () => {
  const { view, user } = await open(); edit("First entry B");
  const onOpenEntry = vi.fn(async () => true);
  view.rerender(tree(second, true, onOpenEntry));
  expect(screen.getByRole("textbox", { name: label("manualContext") })).toHaveValue("First entry B");
  expect(owner().current().selectedUnit?.unitId).toBe(first.unitId);
  await user.click(screen.getByRole("button", { name: i18n.t("resource.returnToEditor", { key: first.nativeKey, locale: first.locale }) }));
  expect(onOpenEntry).toHaveBeenCalledWith(first.unitId, first.locale);
  await user.click(screen.getByRole("button", { name: label("discardDraft") }));
  await waitFor(() => expect(screen.getByRole("button", { name: label("editFromEntry") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: label("editFromEntry") }));
  expect(owner().current().selectedUnit?.unitId).toBe(second.unitId);
  expect(screen.getByRole("textbox", { name: label("manualContext") })).toHaveValue("");
  expect(translation?.current()?.text).toBe("Translation B 🧵");
});

it("requires an explicit comparison basis adoption after a saved note changes, preserving B", async () => {
  const { user } = await open(); edit("My unsaved B");
  notes.set(noteKey(first.unitId, first.locale), { revisionId: id(98790), previousRevisionId: id(98705), unitId: first.unitId,
    locale: first.locale, text: "Other author's updated note", reason: "Other reason" });
  await user.click(screen.getByRole("button", { name: label("refresh") }));
  await waitFor(() => expect(screen.getByRole("button", { name: label("saveContext") })).toBeDisabled());
  await user.click(await screen.findByRole("button", { name: label("adoptCurrentContext") }));
  expect(owner().current().contextRevision?.revisionId).toBe(id(98790));
  expect(screen.getByRole("textbox", { name: label("manualContext") })).toHaveValue("My unsaved B");
  await user.click(screen.getByRole("button", { name: label("saveContext") }));
  await waitFor(() => expect(resourceCommands.saveContext).toHaveBeenCalledOnce());
  expect(vi.mocked(resourceCommands.saveContext).mock.calls[0][0].context.expectedRevisionId).toBe(id(98790));
});

it("locks saved material without saving unsaved text and displays the actual captured items and omissions", async () => {
  const { user } = await open(); edit("Unsaved note B must not enter the capture");
  await user.click(screen.getByRole("button", { name: label("fixInput") }));
  await waitFor(() => expect(owner().current().fixedContext).not.toBeNull());
  expect(resourceCommands.saveContext).not.toHaveBeenCalled();
  const saved = owner().current().fixedContext;
  if (!saved) throw new Error("The real resource owner has not retained its capture");
  expect(saved.included.some(item => item.text === "Unsaved note B must not enter the capture")).toBe(false);
  await user.click(screen.getByText(label("fixedInput"), { selector: "summary" }));
  const disclosure = screen.getByText(label("fixedInput"), { selector: "summary" }).parentElement;
  expect(disclosure).not.toBeNull();
  if (!disclosure) throw new Error("The captured input disclosure is missing");
  expect(within(disclosure).getByText("Original note 👩🏽‍💻 é")).toBeVisible();
  expect(within(disclosure).getByText(/Ambiguous word/)).toBeVisible();
  expect(screen.getByRole("textbox", { name: label("manualContext") })).toHaveValue("Unsaved note B must not enter the capture");
  expect(translation?.current()?.text).toBe("Translation B 🧵");
});

it("keeps composition editable while blocking save and ignores a late current-note read after switching entry", async () => {
  const { view, user } = await open(), input = screen.getByRole("textbox", { name: label("manualContext") });
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: "组合输入 B" } });
  expect(input).not.toHaveAttribute("readonly"); expect(input).toHaveValue("组合输入 B");
  expect(screen.getByRole("button", { name: label("saveContext") })).toBeDisabled(); fireEvent.compositionEnd(input);
  await user.click(screen.getByRole("button", { name: label("discardDraft") }));
  const waiting = deferred<ContextRevision | null>();
  vi.mocked(resourceCommands.context).mockImplementationOnce(async () => waiting.promise);
  await act(async () => { reads.invalidate(["resources"]); });
  view.rerender(tree(second));
  await waitFor(() => expect(screen.getByRole("button", { name: label("editFromEntry") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: label("editFromEntry") }));
  edit("Second entry B");
  await act(async () => { waiting.resolve(notes.get(noteKey(first.unitId, first.locale)) ?? null); });
  expect(owner().current().selectedUnit?.unitId).toBe(second.unitId);
  expect(screen.getByRole("textbox", { name: label("manualContext") })).toHaveValue("Second entry B");
  expect(resourceCommands.saveContext).not.toHaveBeenCalled();
});
