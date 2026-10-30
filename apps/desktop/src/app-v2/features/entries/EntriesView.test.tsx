import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState, useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import type { workbenchEn } from "../../../i18n/workbench";
import fixture from "../../../../test/fixtures/translation-commands.json";
import reviewFixture from "../../../../test/fixtures/reviewCommands.contract.json";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { sourceCommands } from "../../../sourceCommands";
import { reviewCommands } from "../../../reviewCommands";
import { segmentCommands, type SegmentPage, type SegmentQueueWindow, type SegmentRow, type SegmentSourceComparison } from "../../../segmentCommands";
import type { DraftBasis, DraftHead, DraftKey, DraftValue } from "../../../draftCommands";
import type { TranslationSaveReceipt, TranslationSaveRequest } from "../../../translationCommands";
import type { ProjectView } from "../../../projectCommands";
import { WorkbenchCommands, type CommandScope } from "../../../workbenchCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { createWorkspaceCommandDispatcher, registerWorkspaceCommands } from "../../workspace/workspaceCommands";
import { createWorkspaceStore, getWorkspaceView, type NewWorkspaceView, type WorkspaceView } from "../../workspace/workspaceStore";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import ProjectBrief from "../assistant/ProjectBrief";
import EntriesView, { type EntriesHandle } from "./EntriesView";

type WorkbenchTextKey = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
const w = (key: WorkbenchTextKey) => i18n.t(`workbenchV2.${key}`);
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
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
    candidateCount: 0, aiCandidateCount: 0, protection: { unitId, locale, revision: "0", protected: false },
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
async function harness(initialView: Partial<NewWorkspaceView> = {}, options: { emptySource?: boolean; onImportSource?: () => void; onImport?: () => void } = {}) {
  const reads = new SessionReads(context); owners.push(reads);
  const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "view-one", kind: "entries", locale: "zh-CN", preset: "unselected", ...initialView }] });
  const gate = new InteractionGate(); gate.setVisibleOwner("view-one");
  const page = vi.spyOn(segmentCommands, "page").mockImplementation(async request => {
    const start = request.cursor ? 2 : 0;
    return { projectId: context.projectId, locale: request.locale, query: { ...request.query, status: request.query.status ?? "all" }, queryFingerprint: "query-fingerprint", epoch: "epoch", sequence: "1",
      scopeId: request.scopeId ?? "fixed-scope", sourceSnapshotId: "snapshot", readVersion: "1", total: units.length,
      rows: units.slice(start, start + 2).map(unit => row(unit, request.locale)), nextCursor: start === 0 ? "page-two" : null } satisfies SegmentPage;
  });
  const queue = vi.spyOn(segmentCommands, "queueWindow").mockImplementation(async request => {
    const start = request.anchorUnitId ? units.indexOf(request.anchorUnitId) : 0;
    return { projectId: context.projectId, locale: request.locale, query: { text: "", selection: "unselected", status: "all" }, queryFingerprint: "query-fingerprint", epoch: "epoch", sequence: "2",
      scopeId: request.scopeId, sourceSnapshotId: "snapshot", total: units.length, firstPosition: start,
      rows: units.slice(start, start + 2).map(unit => row(unit, request.locale)), previousUnitId: units[start - 1] ?? null, nextUnitId: units[start + 2] ?? null } satisfies SegmentQueueWindow;
  });
  const source = vi.spyOn(sourceCommands, "scope").mockResolvedValue({ currentSnapshot: options.emptySource ? null : "snapshot", revision: "1" });
  const comparison = vi.spyOn(segmentCommands, "sourceComparison").mockImplementation(async request => ({
    projectId: context.projectId, locale: request.locale, scopeId: request.scopeId, currentSnapshotId: "snapshot", baseSnapshotId: "previous-snapshot", nextAfter: null,
    rows: request.unitIds.map(unitId => ({ unitId, changeKind: "changed", old: { sourceRevisionId: "old-revision", text: `Previous ${unitId} é 👩🏽‍💻` },
      current: { sourceRevisionId: initial.sourceRevisionId, text: `Complete source ${unitId}` } })),
  } satisfies SegmentSourceComparison));
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
  let setDisabled!: (value: boolean) => void;
  function Surface() {
    const [disabled, updateDisabled] = useState(false); setDisabled = updateDisabled;
    const state = useSyncExternalStore(store.subscribe, store.getState, store.getState), view = getWorkspaceView(state, state.activeViewId);
    return view ? <div onKeyDown={event => dispatcher.handleKeyDown(event.nativeEvent, view.id, gate.getSnapshot().inputOwner?.ownerId)}>
      <EntriesView ref={ref} project={project} view={view} disabled={disabled} drafts={drafts} gate={gate} patch={value => store.getState().patch(view.id, value)} navigate={navigate}
        dispatch={(id, source, inputOwner) => dispatcher.dispatch(id, { viewId: view.id, source, inputOwner })} onRevealDraft={vi.fn()} onImportSource={options.onImportSource} onImport={options.onImport} />
    </div> : null;
  }
  render(<SessionReadProvider context={context} reads={reads} bridge={false}><Surface /></SessionReadProvider>);
  const view = () => getWorkspaceView(store.getState(), store.getState().activeViewId);
  const open = async (unit = unitA) => { fireEvent.click(await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: `key.${unit}` }) })); return screen.findByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: `key.${unit}` }) }); };
  return { reads, store, gate, drafts, ports, ref, page, queue, source, comparison, navigate, navigationAllowed, view, open, commit, setDisabled };
}

it.each(["en-US", "zh-CN"] as const)("offers source import in the %s empty state and respects disabled and interaction gates", async language => {
  await i18n.changeLanguage(language);
  const onImportSource = vi.fn(), onImport = vi.fn();
  const h = await harness({}, { emptySource: true, onImportSource, onImport });
  const button = await screen.findByRole("button", { name: language === "en-US" ? "Import source content" : "导入源内容" });
  expect(screen.getByText(w("noSourceHelp"))).toBeVisible();
  fireEvent.click(button); expect(onImportSource).toHaveBeenCalledTimes(1); expect(onImport).not.toHaveBeenCalled();
  let release!: () => void; act(() => { release = h.gate.pushDialog("other-dialog"); });
  expect(button).toBeDisabled(); fireEvent.click(button); expect(onImportSource).toHaveBeenCalledTimes(1);
  act(() => { release(); h.setDisabled(true); });
  expect(button).toBeDisabled(); fireEvent.click(button); expect(onImportSource).toHaveBeenCalledTimes(1);
  act(() => h.setDisabled(false)); expect(button).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: w("importTitle") }));
  expect(onImport).toHaveBeenCalledTimes(1); expect(onImportSource).toHaveBeenCalledTimes(1);
});

it.each(["en-US", "zh-CN"] as const)("uses real %s search labels, counts and interpolated row actions", async language => {
  await i18n.changeLanguage(language);
  const h = await harness();
  const edit = await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: `key.${unitA}` }) });
  const search = screen.getByRole("textbox", { name: w("searchEntries") });
  expect(search).toHaveAccessibleName(language === "en-US" ? "Search entries" : "查找条目");
  expect(screen.getByRole("form", { name: w("searchEntries") })).toBeVisible();
  expect(screen.getByText(i18n.t("workbenchV2.entryCount", { count: units.length }))).toHaveTextContent(language === "en-US" ? "4 entries" : "4 条");
  expect(edit).toHaveAccessibleName(language === "en-US" ? `Edit key.${unitA}` : `编辑 key.${unitA}`);
  fireEvent.change(search, { target: { value: "用户 query é 👩🏽‍💻" } });
  expect(h.view()?.searchInput).toBe("用户 query é 👩🏽‍💻");
  expect(h.page).toHaveBeenLastCalledWith(expect.objectContaining({ query: { text: "", selection: "unselected", status: "all" } }));
});

it("loads comparison for only the current page and keeps the same editor through toggles, failure and retry", async () => {
  const h = await harness(), field = await h.open();
  fireEvent.change(field, { target: { value: "Keep {{name}} — é 👩🏽‍💻" } }); field.setSelectionRange(5, 13, "backward");
  expect(h.comparison).not.toHaveBeenCalled();
  h.comparison.mockRejectedValueOnce(new Error("Scope read unavailable"));
  fireEvent.click(screen.getByRole("button", { name: w("sourceComparisonToggle") }));
  expect(await screen.findByRole("alert")).toHaveTextContent(w("sourceComparisonFailed"));
  expect(h.view()).toMatchObject({ compareSource: true, focus: unitA, editing: true });
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: `key.${unitA}` }) })).toBe(field);
  expect(field).toHaveValue("Keep {{name}} — é 👩🏽‍💻");
  const selected = h.view()?.selection;
  fireEvent.click(screen.getByRole("button", { name: w("sourceComparisonRetry") }));
  await waitFor(() => expect(document.querySelector('[data-source-version="previous"]')).toBeInTheDocument());
  expect(h.comparison.mock.calls.every(([request]) => request.unitIds.length === 2 && request.scopeId === "fixed-scope")).toBe(true);
  expect(h.view()?.selection).toBe(selected);
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: `key.${unitA}` }) })).toBe(field);
  expect(field.selectionStart).toBe(5); expect(field.selectionEnd).toBe(13); expect(field.selectionDirection).toBe("backward");
  fireEvent.click(screen.getByRole("button", { name: w("sourceComparisonToggle") }));
  expect(document.querySelector('[data-source-version="previous"]')).toBeNull();
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: `key.${unitA}` }) })).toBe(field);
  expect(field).toHaveValue("Keep {{name}} — é 👩🏽‍💻");
});

it("does not display a late previous-source response after comparison is switched off", async () => {
  const h = await harness(), pending = deferred<SegmentSourceComparison>();
  await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: `key.${unitA}` }) });
  h.comparison.mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: w("sourceComparisonToggle") }));
  await waitFor(() => expect(h.comparison).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("status")).toHaveTextContent(w("sourceComparisonLoading"));
  fireEvent.click(screen.getByRole("button", { name: w("sourceComparisonToggle") }));
  const request = h.comparison.mock.calls[0][0];
  await act(async () => { pending.resolve({ projectId: context.projectId, locale: request.locale, scopeId: request.scopeId,
    currentSnapshotId: "snapshot", baseSnapshotId: "previous-snapshot", nextAfter: null,
    rows: request.unitIds.map(unitId => ({ unitId, changeKind: "changed", old: { sourceRevisionId: "old-revision", text: "Late previous source" },
      current: { sourceRevisionId: initial.sourceRevisionId, text: `Complete source ${unitId}` } })) }); });
  expect(screen.queryByText("Late previous source")).not.toBeInTheDocument();
  expect(h.view()?.compareSource).toBe(false);
});

it("explains the first source version while retaining empty source text as a real endpoint", async () => {
  const h = await harness();
  await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: `key.${unitA}` }) });
  h.comparison.mockImplementationOnce(async request => ({ projectId: context.projectId, locale: request.locale, scopeId: request.scopeId,
    currentSnapshotId: "snapshot", baseSnapshotId: null, nextAfter: null,
    rows: request.unitIds.map(unitId => ({ unitId, changeKind: "added", old: null, current: { sourceRevisionId: initial.sourceRevisionId, text: "" } })) }));
  fireEvent.click(screen.getByRole("button", { name: w("sourceComparisonToggle") }));
  expect(await screen.findByText(w("sourceComparisonFirstVersion"))).toBeVisible();
  expect(screen.getAllByText(w("sourceComparisonNoPrevious")).length).toBeGreaterThan(0);
  expect(screen.getAllByText(w("sourceComparisonEmptyText")).length).toBeGreaterThan(0);
  expect(h.page.mock.calls.filter(([request]) => request.scopeId === null)).toHaveLength(1);
});

it("confirms and advances through the same fixed queue, including its next window", async () => {
  const h = await harness(), field = await h.open();
  fireEvent.change(field, { target: { value: "Confirmed A" } });
  await act(async () => { await h.ref.current?.confirm(true); });
  expect(await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-b" }) })).toBeVisible();
  expect(h.view()).toMatchObject({ focus: "unit-b", queueScopeId: "fixed-scope", queueActive: true });
  fireEvent.change(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-b" }) }), { target: { value: "Confirmed B" } });
  await act(async () => { await h.ref.current?.confirm(true); });
  expect(await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-c" }) })).toBeVisible();
  expect(h.view()).toMatchObject({ focus: "unit-c", queueAnchor: "unit-c", queueScopeId: "fixed-scope" });
  expect(h.page.mock.calls.filter(([request]) => request.scopeId === null)).toHaveLength(1);
  expect(h.queue.mock.calls.every(([request]) => request.scopeId === "fixed-scope")).toBe(true);
});

it("keeps the original editing queue when the adjacent project brief refreshes after confirmation", async () => {
  const h = await harness(), field = await h.open();
  const selection = { kind: "ids" as const, locale: "zh-CN", sourceSnapshotId: "snapshot", unitIds: [unitA, "unit-b"] };
  act(() => { h.store.getState().patch("view-one", { selection }); });
  const retained = ["fixed-scope"], pageRead = h.page.getMockImplementation()!, queueRead = h.queue.getMockImplementation()!;
  let captures = 0;
  const expired = () => ({ code: "dependency-conflict", stage: "execution-read", outcome: "rejected", recoveryRequired: false, diagnostic: "review-scope-expired" });
  // Core retains at most eight unique read scopes. Statistics must not consume
  // that membership budget and evict a queue already being edited.
  h.page.mockImplementation(async request => {
    if (request.scopeId && !retained.includes(request.scopeId)) throw expired();
    const scopeId = request.scopeId ?? `statistics-scope-${++captures}`;
    if (!request.scopeId) { retained.push(scopeId); if (retained.length > 8) retained.shift(); }
    const page = await pageRead(request);
    return { ...page, scopeId, rows: page.rows.slice(0, request.limit),
      total: request.query.selection === "selected" ? h.ports.save.mock.calls.filter(([saved]) => saved.locale === request.locale).length : units.length };
  });
  h.queue.mockImplementation(async request => {
    if (!retained.includes(request.scopeId)) throw expired();
    return queueRead(request);
  });
  const eligibility = vi.spyOn(reviewCommands, "eligibility").mockImplementation(async request => {
    const report = copy(reviewFixture.responses.eligibility), entry = report.locales[0];
    return { ...report, sourceSnapshotId: "snapshot", locales: request.locales.map(locale => ({ ...entry, locale, checkedUnits: units.length,
      selectedUnits: h.ports.save.mock.calls.filter(([saved]) => saved.locale === locale).length, blockingUnits: units.length, blockerCount: units.length })) };
  });
  render(<SessionReadProvider context={context} reads={h.reads} bridge={false}>
    <ProjectBrief project={project} visible briefEligible disabled={false} decisions={{ page: undefined, loading: false, error: null }}
      onContinue={vi.fn()} onEntries={vi.fn()} onImport={vi.fn()} onDecisions={vi.fn()}/>
  </SessionReadProvider>);
  await screen.findAllByText("Selected translations: 0 / 4");
  fireEvent.change(field, { target: { value: "你好\n世界" } });
  await act(async () => { await h.ref.current?.confirm(true); });
  await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-b" }) });
  await screen.findAllByText("Selected translations: 1 / 4");
  // A later change notification observes the same committed save again.
  act(() => { h.reads.invalidate(["translation", "review"]); });
  await waitFor(() => expect(h.reads.client.isFetching()).toBe(0));
  expect(screen.queryByText(w("viewChanged"))).not.toBeInTheDocument();
  expect(h.view()).toMatchObject({ focus: "unit-b", queueActive: true, queueScopeId: "fixed-scope", selection });
  expect(h.ports.save).toHaveBeenCalledOnce();
  expect(eligibility).toHaveBeenCalledTimes(3);
  expect(captures).toBe(0);
  expect(h.page.mock.calls.filter(([request]) => request.scopeId === null && request.limit === 50)).toHaveLength(1);
  // A genuinely expired queue still requires the user's explicit refresh.
  retained.splice(0);
  act(() => { h.reads.invalidate(["translation", "review"]); });
  expect(await screen.findByText(w("viewChanged"))).toBeVisible();
  expect(h.view()).toMatchObject({ focus: "unit-b", queueActive: true, queueScopeId: "fixed-scope", selection });
  expect(captures).toBe(0);
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
  expect(screen.getByText(w("editorNewerInput"))).toBeVisible();
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
    await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-c" }) });
    act(() => { h.store.getState().patch("view-one", { focus: unitA, queueAnchor: unitA }); });
    await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: `key.${unitA}` }) });
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
  const search = screen.getByRole("textbox", { name: w("searchEntries") });
  act(() => search.focus()); fireEvent.keyDown(search, { key: "Enter", metaKey: true });
  expect(h.ports.save).not.toHaveBeenCalled();
  fireEvent.change(search, { target: { value: "submitted query" } });
  fireEvent.keyDown(search, { key: "Enter" }); fireEvent.submit(screen.getByRole("form", { name: w("searchEntries") }));
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
    const enter = screen.getByRole("button", { name: w("editorFocusMode") });
    act(() => enter.focus()); fireEvent.click(enter);
    await waitFor(() => expect(h.view()?.focusMode).toBe(true));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(field).not.toHaveFocus();
    act(() => { frames.splice(0).forEach(callback => callback(0)); });
    expect(field).toHaveFocus();
    expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: `key.${unitA}` }) })).toBe(field);
    expect(field.selectionStart).toBe(selection.start); expect(field.selectionEnd).toBe(selection.end); expect(field.selectionDirection).toBe(selection.direction);
    const exits = screen.getAllByRole("button", { name: w("editorTableMode") }), exit = exits[exits.length - 1];
    act(() => exit.focus()); fireEvent.click(exit);
    await waitFor(() => expect(h.view()?.focusMode).toBe(false));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(field).not.toHaveFocus();
    act(() => { frames.splice(0).forEach(callback => callback(0)); });
    expect(field).toHaveFocus(); expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: `key.${unitA}` }) })).toBe(field);
    expect(field).toHaveValue("Keep this selected draft");
    expect(field.selectionStart).toBe(selection.start); expect(field.selectionEnd).toBe(selection.end); expect(field.selectionDirection).toBe(selection.direction);
    expect(h.view()).toMatchObject({ focus: unitA, queueScopeId: "fixed-scope", editing: true }); expect(h.ports.save).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it("opens a row from a nonzero page at that row's fixed queue position", async () => {
  const h = await harness({ cursor: "page-two", afterOrdinal: 2 });
  const edit = await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: "key.unit-c" }) }); expect(edit).toHaveTextContent("3");
  fireEvent.click(edit);
  expect(await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-c" }) })).toBeVisible();
  expect(h.view()).toMatchObject({ focus: "unit-c", queueAnchor: "unit-c", queueScopeId: "fixed-scope" });
  expect(h.queue).toHaveBeenCalledWith(expect.objectContaining({ anchorUnitId: "unit-c", scopeId: "fixed-scope" }));
  expect(screen.getByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: "key.unit-c" }) })).toHaveTextContent("3");
});

it("opens an address-restored focus outside the first page by reading its queue anchor", async () => {
  const h = await harness({ focus: "unit-d" });
  expect(await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-d" }) })).toBeVisible();
  expect(h.view()).toMatchObject({ focus: "unit-d", queueAnchor: "unit-d", queueScopeId: "fixed-scope", editing: true });
  expect(h.queue).toHaveBeenCalledWith(expect.objectContaining({ anchorUnitId: "unit-d" }));
  expect(screen.getByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: "key.unit-d" }) })).toHaveTextContent("4");
});

it("does not read a fresh queue when its guarded refresh is refused", async () => {
  const h = await harness(); await h.open();
  const captureCalls = h.page.mock.calls.filter(([request]) => request.scopeId === null).length, sourceCalls = h.source.mock.calls.length;
  h.navigationAllowed.value = false; fireEvent.click(screen.getByRole("button", { name: w("refresh") }));
  await waitFor(() => expect(h.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ queueActive: false, focus: null })));
  expect(h.view()).toMatchObject({ queueActive: true, queueScopeId: "fixed-scope", focus: unitA });
  expect(h.page.mock.calls.filter(([request]) => request.scopeId === null)).toHaveLength(captureCalls); expect(h.source).toHaveBeenCalledTimes(sourceCalls);
});

it("clears the fixed queue identity when an explicit refresh returns to browsing", async () => {
  const h = await harness(); await h.open();
  h.page.mockImplementation(async request => ({ projectId: context.projectId, locale: request.locale, query: { ...request.query, status: request.query.status ?? "all" }, queryFingerprint: "new-query-fingerprint", epoch: "epoch", sequence: "3",
    scopeId: "fresh-scope", sourceSnapshotId: "snapshot", readVersion: "2", total: units.length, rows: units.slice(0, 2).map(unit => row(unit, request.locale)), nextCursor: "page-two" }));
  fireEvent.click(screen.getByRole("button", { name: w("refresh") }));
  await waitFor(() => expect(h.page.mock.calls.filter(([request]) => request.scopeId === null).length).toBeGreaterThan(1));
  await waitFor(() => expect(h.view()).toMatchObject({ editing: false, focus: null, queueActive: false, queueScopeId: null, queueAnchor: null }));
});

it("does not advance an old queue window after an explicit move to the queue start", async () => {
  const h = await harness({ focus: "unit-c" });
  const field = await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-c" }) }), saved = deferred<TranslationSaveReceipt>();
  h.ports.save.mockReturnValueOnce(saved.promise); fireEvent.change(field, { target: { value: "Submitted C" } });
  let confirming: Promise<void> | undefined; act(() => { confirming = h.ref.current?.confirm(true); });
  await waitFor(() => expect(h.ports.save).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: w("firstPage") }));
  await waitFor(() => expect(h.view()?.queueAnchor).toBeNull());
  const before = h.view();
  await act(async () => { saved.resolve(h.commit(h.ports.save.mock.calls[0][0])); await confirming; });
  expect(h.view()?.focus).toBe(before?.focus); expect(h.view()?.editing).toBe(before?.editing); expect(h.view()?.queueAnchor).toBeNull();
  expect(h.navigate.mock.calls.some(([value]) => value.focus === "unit-d")).toBe(false);
});

function selectionCapture() {
  return { projectId: context.projectId, queryFingerprint: "query-fingerprint", readVersion: "1", capture: {
    scopeId: "fixed-scope", sourceSnapshotId: "snapshot", locale: "zh-CN", query: "", readVersion: "fixed-selection-bases",
    units: units.map(unitId => ({ unitId, expectedBasis: "basis", expectedDecisionId: null })),
  } };
}
async function selectionMenu(name: string) {
  const trigger = screen.getByRole("button", { name: w("entrySelectionMenu") });
  act(() => trigger.focus()); fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
it("freezes all pages, keeps that selection through filtering, and excludes only an original member", async () => {
  const capture = vi.spyOn(segmentCommands, "captureScope").mockResolvedValue(selectionCapture());
  const h = await harness(); await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: `key.${unitA}` }) });
  await selectionMenu(w("entrySelectPage"));
  expect(h.view()?.selection).toMatchObject({ kind: "ids", unitIds: units.slice(0, 2) });
  fireEvent.click(screen.getByRole("button", { name: w("nextPage") }));
  await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: "key.unit-c" }) });
  await selectionMenu(w("entrySelectMatches"));
  await waitFor(() => expect(h.view()?.selection?.kind).toBe("scope"));
  expect(capture).toHaveBeenCalledWith({ ...context, locale: "zh-CN", scopeId: "fixed-scope", queryFingerprint: "query-fingerprint", readVersion: "1", excluded: [] });
  const fixed = h.view()?.selection;
  const filter = screen.getByRole("button", { name: w("unselectedEntries") });
  act(() => filter.focus()); fireEvent.keyDown(filter, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: w("entryPresetIssues") }));
  await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: `key.${unitA}` }) });
  expect(h.page).toHaveBeenLastCalledWith(expect.objectContaining({ query: { text: "", selection: "all", status: "issues" } }));
  expect(h.view()?.selection).toEqual(fixed); expect(capture).toHaveBeenCalledTimes(1);
  const checkbox = screen.getByRole("checkbox", { name: i18n.t("workbenchV2.entrySelect", { key: `key.${unitA}` }) });
  expect(checkbox).toBeChecked(); fireEvent.click(checkbox);
  expect(h.view()?.selection).toMatchObject({ kind: "scope", selection: { capture: { units: selectionCapture().capture.units }, excluded: [unitA] } });
  act(() => { h.store.getState().patch("view-one", { locale: "ja" }); });
  await screen.findByText(w("entrySelectionChanged"));
  expect(h.view()?.selection).toMatchObject({ selection: { capture: { locale: "zh-CN" }, excluded: [unitA] } });
  expect(await screen.findByRole("checkbox", { name: i18n.t("workbenchV2.entrySelect", { key: `key.${unitA}` }) })).toBeDisabled();
});

it("does not install an earlier full-scope selection after the user changes the filter", async () => {
  const pending = deferred<Awaited<ReturnType<typeof segmentCommands.captureScope>>>();
  vi.spyOn(segmentCommands, "captureScope").mockReturnValue(pending.promise);
  const h = await harness(); await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: `key.${unitA}` }) });
  await selectionMenu(w("entrySelectPage")); const original = h.view()?.selection;
  await selectionMenu(w("entrySelectMatches")); await screen.findByText(w("entryCapturingSelection"));
  const filter = screen.getByRole("button", { name: w("unselectedEntries") });
  act(() => filter.focus()); fireEvent.keyDown(filter, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: w("entryPresetReview") }));
  await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: `key.${unitA}` }) });
  await act(async () => { pending.resolve(selectionCapture()); });
  expect(h.view()?.preset).toBe("needs-review"); expect(h.view()?.selection).toEqual(original);
});

it("moves list focus across fixed page boundaries and edits only after Enter", async () => {
  const h = await harness();
  const first = await screen.findByRole("listitem", { name: `key.${unitA}` });
  act(() => first.focus()); fireEvent.keyDown(first, { key: "ArrowDown" });
  await waitFor(() => expect(h.view()).toMatchObject({ focus: "unit-b", editing: false, queueActive: true }));
  const second = await screen.findByRole("listitem", { name: "key.unit-b" });
  await waitFor(() => expect(second).toHaveFocus()); fireEvent.keyDown(second, { key: "j" });
  await waitFor(() => expect(h.view()).toMatchObject({ focus: "unit-c", editing: false, queueAnchor: "unit-c" }));
  const third = await screen.findByRole("listitem", { name: "key.unit-c" });
  await waitFor(() => expect(third).toHaveFocus()); fireEvent.keyDown(third, { key: "ArrowUp" });
  await waitFor(() => expect(h.view()).toMatchObject({ focus: "unit-b", editing: false, queueAnchor: "unit-b" }));
  const back = await screen.findByRole("listitem", { name: "key.unit-b" });
  await waitFor(() => expect(back).toHaveFocus()); fireEvent.keyDown(back, { key: "Enter" });
  expect(await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-b" }) })).toBeVisible();
  expect(h.ports.save).not.toHaveBeenCalled();
});
