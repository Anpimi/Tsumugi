import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../../test/fixtures/translation-commands.json";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { sourceCommands } from "../../../sourceCommands";
import { segmentCommands, type SegmentPage, type SegmentQueueWindow, type SegmentRow } from "../../../segmentCommands";
import type { DraftBasis, DraftHead, DraftKey, DraftValue } from "../../../draftCommands";
import type { TranslationSaveReceipt, TranslationSaveRequest } from "../../../translationCommands";
import type { ProjectView } from "../../../projectCommands";
import { WorkbenchCommands, type CommandScope } from "../../../workbenchCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { createWorkspaceCommandDispatcher, registerWorkspaceCommands } from "../../workspace/workspaceCommands";
import { createWorkspaceStore, getWorkspaceView, type NewWorkspaceView, type WorkspaceView } from "../../workspace/workspaceStore";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import EntriesView, { type EntriesHandle } from "./EntriesView";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, parameters?: { key?: string }) => parameters?.key === undefined ? key : `${key}:${parameters.key}` }) }));
const owners: SessionReads[] = [];
afterEach(() => { cleanup(); owners.splice(0).forEach(reads => reads.retire()); });

const context = { projectId: fixture.save.projectId, sessionToken: "entry-view-session" };
const project: ProjectView = { locator: "/synthetic/entries", sessionToken: context.sessionToken, reconciliationState: "settled",
  metadata: { projectId: context.projectId, metadataRevision: "1", displayName: "Synthetic entries", sourceLocale: "en", targetLocales: ["zh-CN", "ja"] } };
const unitA = fixture.save.unitId, units = [unitA, "unit-b", "unit-c", "unit-d"];
const initial: DraftBasis = { sourceRevisionId: fixture.save.sourceRevisionId, selectionId: null, revisionId: null, text: null };
const emptyChecks = { passed: 0, findings: 0, missing: 0, unavailable: 0, failed: 0, cancelled: 0, unknown: 0, notApplicable: 0, findingCount: 0 };
const copy = <T,>(value: T): T => structuredClone(value);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function row(unitId: string, locale = "zh-CN"): SegmentRow {
  return { sourceTruncated: false, translationTruncated: false,
    content: { unitId, locale, sourceSnapshotId: "snapshot", sourceRevisionId: initial.sourceRevisionId, nativeKey: `key.${unitId}`, sourcePreview: `Source ${unitId}`,
      translationPreview: null, selectionId: null, revisionId: null, basis: "basis", currentCheck: null, currentDecision: null },
    candidateCount: 0, protection: { unitId, locale, revision: "0", protected: false },
    qa: { current: false, outcome: null, mandatoryCoverageComplete: null, mandatory: emptyChecks, advisory: { ...emptyChecks } },
    terms: { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false },
    applicability: { selectedSourceRevisionId: null, sourceBasisCurrent: null, capturedBasisCurrent: null, resourceImpact: null, resourceReviewRequired: false },
    qualification: { blockerCount: 0, exceptionCount: 0, blockers: [], exceptions: [], truncated: false } };
}
function receipt(request: TranslationSaveRequest): TranslationSaveReceipt {
  return { ...fixture.receipt, projectId: request.projectId, actionId: request.actionId,
    selection: { ...fixture.receipt.selection, unitId: request.unitId, locale: request.locale, actionId: request.actionId, previousEventId: request.expectedSelectionId ?? null },
    revision: { ...fixture.receipt.revision, unitId: request.unitId, locale: request.locale, sourceRevisionId: request.sourceRevisionId, text: request.text, actionId: request.actionId, originKind: "manual" },
    basis: { ...fixture.receipt.basis, sourceRevisionId: request.sourceRevisionId, selectionId: fixture.receipt.selection.eventId } };
}
async function harness(initialView: Partial<NewWorkspaceView> = {}) {
  const reads = new SessionReads(context); owners.push(reads);
  const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "view-one", kind: "entries", locale: "zh-CN", preset: "unselected", ...initialView }] });
  const gate = new InteractionGate(); gate.setVisibleOwner("view-one");
  const page = vi.spyOn(segmentCommands, "page").mockImplementation(async request => {
    const start = request.cursor ? 2 : 0;
    return { projectId: context.projectId, locale: request.locale, query: request.query, queryFingerprint: "query-fingerprint", epoch: "epoch", sequence: "1",
      scopeId: request.scopeId ?? "fixed-scope", sourceSnapshotId: "snapshot", readVersion: "1", total: units.length,
      rows: units.slice(start, start + 2).map(unit => row(unit, request.locale)), nextCursor: start === 0 ? "page-two" : null } satisfies SegmentPage;
  });
  const queue = vi.spyOn(segmentCommands, "queueWindow").mockImplementation(async request => {
    const start = request.anchorUnitId ? units.indexOf(request.anchorUnitId) : 0;
    return { projectId: context.projectId, locale: request.locale, query: { text: "", selection: "unselected" }, queryFingerprint: "query-fingerprint", epoch: "epoch", sequence: "2",
      scopeId: request.scopeId, sourceSnapshotId: "snapshot", total: units.length, firstPosition: start,
      rows: units.slice(start, start + 2).map(unit => row(unit, request.locale)), previousUnitId: units[start - 1] ?? null, nextUnitId: units[start + 2] ?? null } satisfies SegmentQueueWindow;
  });
  const source = vi.spyOn(sourceCommands, "scope").mockResolvedValue({ currentSnapshot: "snapshot", revision: "1" });
  const disk = new Map<string, DraftHead>(), current = new Map<string, DraftBasis>();
  const entity = (key: DraftKey) => JSON.stringify([key.unitId, key.locale]);
  const commit = (request: TranslationSaveRequest) => {
    const saved = receipt(request);
    current.set(entity(request), { sourceRevisionId: request.sourceRevisionId, selectionId: saved.selection.eventId, revisionId: saved.selection.revisionId, text: request.text });
    return saved;
  };
  const ports = {
    list: vi.fn<TranslationDraftPorts["list"]>(async () => ({ items: [], next: null })),
    read: vi.fn<TranslationDraftPorts["read"]>(async ({ key }) => ({ head: copy(disk.get(entity(key)) ?? { key, revision: "0", writerId: null, value: null }),
      current: { kind: "current", basis: copy(current.get(entity(key)) ?? initial), sourceText: `Complete source ${key.unitId}`, nativeKey: `key.${key.unitId}` } })),
    write: vi.fn<TranslationDraftPorts["write"]>(async ({ write }) => {
      const head: DraftHead = { key: write.key, revision: (BigInt(disk.get(entity(write.key))?.revision ?? "0") + 1n).toString(), writerId: write.writerId, value: copy(write.value) as DraftValue };
      disk.set(entity(write.key), head); return copy(head);
    }),
    clear: vi.fn<TranslationDraftPorts["clear"]>(async ({ clear }) => {
      const head: DraftHead = { key: clear.key, revision: (BigInt(disk.get(entity(clear.key))?.revision ?? "0") + 1n).toString(), writerId: null, value: null };
      disk.set(entity(clear.key), head); return copy(head);
    }),
    identity: vi.fn<TranslationDraftPorts["identity"]>(async () => fixture.save.actionId),
    save: vi.fn<TranslationDraftPorts["save"]>(async request => commit(request)), writerId: () => "editor-view-writer",
  };
  const drafts = new TranslationDrafts({ context, reads, ports }); await drafts.initialize();
  const ref = createRef<EntriesHandle>(), navigationAllowed = { value: true };
  const navigate = vi.fn(async (value: Partial<WorkspaceView>) => {
    if (!navigationAllowed.value) return false;
    const id = store.getState().activeViewId;
    return id !== null && store.getState().patch(id, value);
  });
  const commands = new WorkbenchCommands(), scope: CommandScope = { ...context, area: "translation" };
  const dispatcher = createWorkspaceCommandDispatcher({ gate, modifier: "meta", getContext: () => ({ viewId: store.getState().activeViewId, scope, commands }) });
  registerWorkspaceCommands({ commands, store, gate, viewId: "view-one", scope, getCurrentScope: () => scope,
    navigation: { open: vi.fn(async () => true), activate: vi.fn(async () => true), close: vi.fn(async () => true), update: vi.fn(async () => true) },
    actions: { confirm: advance => ref.current?.confirm(advance), isEditing: () => ref.current?.isEditing() ?? false, canConfirm: () => ref.current?.canConfirm() ?? false }, onError: error => { throw error; } });
  function Surface() {
    const state = useSyncExternalStore(store.subscribe, store.getState, store.getState), view = getWorkspaceView(state, state.activeViewId);
    return view ? <div onKeyDown={event => dispatcher.handleKeyDown(event.nativeEvent, view.id, gate.getSnapshot().inputOwner?.ownerId)}>
      <EntriesView ref={ref} project={project} view={view} disabled={false} drafts={drafts} gate={gate} patch={value => store.getState().patch(view.id, value)} navigate={navigate}
        dispatch={(id, source, inputOwner) => dispatcher.dispatch(id, { viewId: view.id, source, inputOwner })} onRevealDraft={vi.fn()} />
    </div> : null;
  }
  render(<SessionReadProvider context={context} reads={reads} bridge={false}><Surface /></SessionReadProvider>);
  const view = () => getWorkspaceView(store.getState(), store.getState().activeViewId);
  const open = async (unit = unitA) => { fireEvent.click(await screen.findByRole("button", { name: `entryEdit:key.${unit}` })); return screen.findByRole<HTMLTextAreaElement>("textbox", { name: `editorLabel:key.${unit}` }); };
  return { reads, store, gate, drafts, ports, ref, page, queue, source, navigate, navigationAllowed, view, open, commit };
}

it("confirms and advances through the same fixed queue, including its next window", async () => {
  const h = await harness(), field = await h.open();
  fireEvent.change(field, { target: { value: "Confirmed A" } });
  await act(async () => { await h.ref.current?.confirm(true); });
  expect(await screen.findByRole("textbox", { name: "editorLabel:key.unit-b" })).toBeVisible();
  expect(h.view()).toMatchObject({ focus: "unit-b", queueScopeId: "fixed-scope", queueActive: true });
  fireEvent.change(screen.getByRole("textbox", { name: "editorLabel:key.unit-b" }), { target: { value: "Confirmed B" } });
  await act(async () => { await h.ref.current?.confirm(true); });
  expect(await screen.findByRole("textbox", { name: "editorLabel:key.unit-c" })).toBeVisible();
  expect(h.view()).toMatchObject({ focus: "unit-c", queueAnchor: "unit-c", queueScopeId: "fixed-scope" });
  expect(h.page.mock.calls.filter(([request]) => request.scopeId === null)).toHaveLength(1);
  expect(h.queue.mock.calls.every(([request]) => request.scopeId === "fixed-scope")).toBe(true);
});

it("keeps B and stays on the row when A's confirmation arrives", async () => {
  const h = await harness(), field = await h.open(), saved = deferred<TranslationSaveReceipt>();
  h.ports.save.mockReturnValueOnce(saved.promise);
  fireEvent.change(field, { target: { value: "Submitted A" } });
  let confirming: Promise<void> | undefined;
  act(() => { confirming = h.ref.current?.confirm(true); });
  await waitFor(() => expect(h.ports.save).toHaveBeenCalledTimes(1));
  fireEvent.change(field, { target: { value: "Newer B" } });
  await act(async () => { saved.resolve(h.commit(h.ports.save.mock.calls[0][0])); await confirming; });
  expect(h.view()?.focus).toBe(unitA); expect(field).toHaveValue("Newer B");
  expect(screen.getByText("editorNewerInput")).toBeVisible();
  expect(h.navigate.mock.calls.some(([value]) => value.focus === "unit-b")).toBe(false);
});

it.each(["view", "locale", "focused row"] as const)("does not move the current %s when an earlier confirmation finishes", async changed => {
  const h = await harness(), field = await h.open(), saved = deferred<TranslationSaveReceipt>();
  h.ports.save.mockReturnValueOnce(saved.promise); fireEvent.change(field, { target: { value: "Submitted A" } });
  let confirming: Promise<void> | undefined; act(() => { confirming = h.ref.current?.confirm(true); });
  await waitFor(() => expect(h.ports.save).toHaveBeenCalledTimes(1));
  act(() => {
    if (changed === "view") { h.store.getState().open({ id: "view-two", kind: "entries", locale: "zh-CN", preset: "unselected" }); h.gate.setVisibleOwner("view-two"); }
    else h.store.getState().patch("view-one", changed === "locale" ? { locale: "ja", focus: unitA } : { focus: "unit-c", queueAnchor: "unit-c" });
  });
  const before = h.view();
  await act(async () => { saved.resolve(h.commit(h.ports.save.mock.calls[0][0])); await confirming; });
  expect(h.view()?.id).toBe(before?.id); expect(h.view()?.locale).toBe(before?.locale); expect(h.view()?.focus).toBe(before?.focus);
  expect(h.navigate.mock.calls.some(([value]) => value.focus === "unit-b")).toBe(false);
});

it.each(["focus round trip", "completed composition"] as const)("revokes automatic advance after a %s even when final view values match", async changed => {
  const h = await harness(), field = await h.open(), saved = deferred<TranslationSaveReceipt>();
  h.ports.save.mockReturnValueOnce(saved.promise); fireEvent.change(field, { target: { value: "Submitted A" } });
  let confirming: Promise<void> | undefined; act(() => { confirming = h.ref.current?.confirm(true); });
  await waitFor(() => expect(h.ports.save).toHaveBeenCalledTimes(1));
  if (changed === "focus round trip") {
    act(() => { h.store.getState().patch("view-one", { focus: "unit-c", queueAnchor: "unit-c" }); });
    await screen.findByRole("textbox", { name: "editorLabel:key.unit-c" });
    act(() => { h.store.getState().patch("view-one", { focus: unitA, queueAnchor: unitA }); });
    await screen.findByRole("textbox", { name: `editorLabel:key.${unitA}` });
  } else {
    fireEvent.compositionStart(field); fireEvent.compositionEnd(field);
    expect(h.gate.getSnapshot().composingOwners).toEqual([]);
  }
  await act(async () => { saved.resolve(h.commit(h.ports.save.mock.calls[0][0])); await confirming; });
  expect(h.view()).toMatchObject({ focus: unitA, editing: true, queueScopeId: "fixed-scope" });
  expect(h.navigate.mock.calls.some(([value]) => value.focus === "unit-b")).toBe(false);
});

it("keeps search and list navigation separate from textarea typing and confirmation shortcuts", async () => {
  const h = await harness(), field = await h.open();
  fireEvent.change(field, { target: { value: "Draft text" } });
  fireEvent.keyDown(field, { key: "ArrowDown" }); fireEvent.keyDown(field, { key: "j" });
  expect(h.view()?.focus).toBe(unitA); expect(h.ports.save).not.toHaveBeenCalled();
  const search = screen.getByRole("textbox", { name: "searchEntries" });
  act(() => search.focus()); fireEvent.keyDown(search, { key: "Enter", metaKey: true });
  expect(h.ports.save).not.toHaveBeenCalled();
  fireEvent.change(search, { target: { value: "submitted query" } });
  fireEvent.keyDown(search, { key: "Enter" }); fireEvent.submit(screen.getByRole("form", { name: "searchEntries" }));
  expect(h.view()).toMatchObject({ query: "submitted query", editing: false, focus: null });
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.drafts.getEntry({ ...context, unitId: unitA, locale: "zh-CN" })?.value?.text).toBe("Draft text");
});

it("restores focus to the same textarea and selection across a focus mode round trip", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
  try {
    const h = await harness(), field = await h.open();
    fireEvent.change(field, { target: { value: "Keep this selected draft" } });
    await act(async () => { await h.drafts.flush({ ...context, unitId: unitA, locale: "zh-CN" }); });
    field.setSelectionRange(5, 18, "backward"); fireEvent.select(field);
    const selection = { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection };
    const enter = screen.getByRole("button", { name: "editorFocusMode" });
    act(() => enter.focus()); fireEvent.click(enter);
    await waitFor(() => expect(h.view()?.focusMode).toBe(true));
    await waitFor(() => expect(frames).toHaveLength(1));
    expect(field).not.toHaveFocus();
    act(() => { frames.splice(0).forEach(callback => callback(0)); });
    expect(field).toHaveFocus();
    expect(screen.getByRole("textbox", { name: `editorLabel:key.${unitA}` })).toBe(field);
    expect(field.selectionStart).toBe(selection.start); expect(field.selectionEnd).toBe(selection.end); expect(field.selectionDirection).toBe(selection.direction);
    const exits = screen.getAllByRole("button", { name: "editorTableMode" }), exit = exits[exits.length - 1];
    act(() => exit.focus()); fireEvent.click(exit);
    await waitFor(() => expect(h.view()?.focusMode).toBe(false));
    await waitFor(() => expect(frames).toHaveLength(1));
    expect(field).not.toHaveFocus();
    act(() => { frames.splice(0).forEach(callback => callback(0)); });
    expect(field).toHaveFocus(); expect(screen.getByRole("textbox", { name: `editorLabel:key.${unitA}` })).toBe(field);
    expect(field).toHaveValue("Keep this selected draft");
    expect(field.selectionStart).toBe(selection.start); expect(field.selectionEnd).toBe(selection.end); expect(field.selectionDirection).toBe(selection.direction);
    expect(h.view()).toMatchObject({ focus: unitA, queueScopeId: "fixed-scope", editing: true }); expect(h.ports.save).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it("opens a row from a nonzero page at that row's fixed queue position", async () => {
  const h = await harness({ cursor: "page-two", afterOrdinal: 2 });
  const edit = await screen.findByRole("button", { name: "entryEdit:key.unit-c" }); expect(edit).toHaveTextContent("3");
  fireEvent.click(edit);
  expect(await screen.findByRole("textbox", { name: "editorLabel:key.unit-c" })).toBeVisible();
  expect(h.view()).toMatchObject({ focus: "unit-c", queueAnchor: "unit-c", queueScopeId: "fixed-scope" });
  expect(h.queue).toHaveBeenCalledWith(expect.objectContaining({ anchorUnitId: "unit-c", scopeId: "fixed-scope" }));
  expect(screen.getByRole("button", { name: "entryEdit:key.unit-c" })).toHaveTextContent("3");
});

it("opens an address-restored focus outside the first page by reading its queue anchor", async () => {
  const h = await harness({ focus: "unit-d" });
  expect(await screen.findByRole("textbox", { name: "editorLabel:key.unit-d" })).toBeVisible();
  expect(h.view()).toMatchObject({ focus: "unit-d", queueAnchor: "unit-d", queueScopeId: "fixed-scope", editing: true });
  expect(h.queue).toHaveBeenCalledWith(expect.objectContaining({ anchorUnitId: "unit-d" }));
  expect(screen.getByRole("button", { name: "entryEdit:key.unit-d" })).toHaveTextContent("4");
});

it("does not read a fresh queue when its guarded refresh is refused", async () => {
  const h = await harness(); await h.open();
  const captureCalls = h.page.mock.calls.filter(([request]) => request.scopeId === null).length, sourceCalls = h.source.mock.calls.length;
  h.navigationAllowed.value = false; fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await waitFor(() => expect(h.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ queueActive: false, focus: null })));
  expect(h.view()).toMatchObject({ queueActive: true, queueScopeId: "fixed-scope", focus: unitA });
  expect(h.page.mock.calls.filter(([request]) => request.scopeId === null)).toHaveLength(captureCalls); expect(h.source).toHaveBeenCalledTimes(sourceCalls);
});

it("clears the fixed queue identity when an explicit refresh returns to browsing", async () => {
  const h = await harness(); await h.open();
  h.page.mockImplementation(async request => ({ projectId: context.projectId, locale: request.locale, query: request.query, queryFingerprint: "new-query-fingerprint", epoch: "epoch", sequence: "3",
    scopeId: "fresh-scope", sourceSnapshotId: "snapshot", readVersion: "2", total: units.length, rows: units.slice(0, 2).map(unit => row(unit, request.locale)), nextCursor: "page-two" }));
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await waitFor(() => expect(h.page.mock.calls.filter(([request]) => request.scopeId === null).length).toBeGreaterThan(1));
  await waitFor(() => expect(h.view()).toMatchObject({ editing: false, focus: null, queueActive: false, queueScopeId: null, queueAnchor: null }));
});

it("does not advance an old queue window after an explicit move to the queue start", async () => {
  const h = await harness({ focus: "unit-c" });
  const field = await screen.findByRole("textbox", { name: "editorLabel:key.unit-c" }), saved = deferred<TranslationSaveReceipt>();
  h.ports.save.mockReturnValueOnce(saved.promise); fireEvent.change(field, { target: { value: "Submitted C" } });
  let confirming: Promise<void> | undefined; act(() => { confirming = h.ref.current?.confirm(true); });
  await waitFor(() => expect(h.ports.save).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "firstPage" }));
  await waitFor(() => expect(h.view()?.queueAnchor).toBeNull());
  const before = h.view();
  await act(async () => { saved.resolve(h.commit(h.ports.save.mock.calls[0][0])); await confirming; });
  expect(h.view()?.focus).toBe(before?.focus); expect(h.view()?.editing).toBe(before?.editing); expect(h.view()?.queueAnchor).toBeNull();
  expect(h.navigate.mock.calls.some(([value]) => value.focus === "unit-d")).toBe(false);
});
