import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import type { workbenchEn } from "../../../i18n/workbench";
import type { DraftHead, DraftValue } from "../../../draftCommands";
import type { SegmentRow, SegmentSourceComparison } from "../../../segmentCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { makeWorkspaceView } from "../../workspace/workspaceStore";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import type { EntryDiagnosticFocus } from "../review/navigationTypes";
import EntriesTable, { type EntriesTableHandle, type EntriesTableProps } from "./EntriesTable";

type WorkbenchTextKey = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
const w = (key: WorkbenchTextKey) => i18n.t(`workbenchV2.${key}`);

const heights = new Map<string, number>();
const observers = new Set<LayoutObserver>();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
class LayoutObserver {
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  observe(element: Element) { this.targets.add(element); }
  unobserve(element: Element) { this.targets.delete(element); }
  disconnect() { this.targets.clear(); observers.delete(this); }
}
function resize(element: HTMLElement) {
  const size = heights.get(element.dataset.unitId ?? "") ?? 80;
  observers.forEach(observer => {
    if (observer.targets.has(element)) observer.callback([{ target: element, borderBoxSize: [{ blockSize: size, inlineSize: 900 }] } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
  });
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  heights.clear(); observers.clear();
  vi.stubGlobal("ResizeObserver", LayoutObserver);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.getAttribute("role") === "region" ? 240 : 0; });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => 900);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return Number.parseFloat(this.querySelector<HTMLElement>('[role="list"]')?.style.height ?? "0"); });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return new DOMRect(0, 0, 900, this.dataset.unitId ? heights.get(this.dataset.unitId) ?? 80 : 240); });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    if (options.top !== undefined) this.scrollTop = options.top;
    if (options.left !== undefined) this.scrollLeft = options.left;
  } });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  window.getSelection()?.removeAllRanges();
});

const checks = { passed: 0, findings: 0, missing: 0, unavailable: 0, failed: 0, cancelled: 0, unknown: 0, notApplicable: 0, findingCount: 0 };
function row(index: number): SegmentRow {
  const unitId = `unit-${index}`;
  return { sourceTruncated: false, translationTruncated: false,
    content: { unitId, locale: "zh-CN", sourceSnapshotId: "snapshot", sourceRevisionId: "revision", nativeKey: `key.${unitId}`,
      sourcePreview: `Source ${index}: placeholders {name}, 中文, e\u0301, العربية and a long line that wraps in a narrow column.`,
      translationPreview: null, selectionId: null, revisionId: null, basis: "basis", currentCheck: null, currentDecision: null },
    candidateCount: 0, aiCandidateCount: 0, protection: { unitId, locale: "zh-CN", revision: "0", protected: false },
    qa: { current: false, outcome: null, mandatoryCoverageComplete: null, mandatory: checks, advisory: checks },
    terms: { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false },
    applicability: { selectedSourceRevisionId: null, sourceBasisCurrent: null, capturedBasisCurrent: null, resourceImpact: null, resourceReviewRequired: false },
    qualification: { blockerCount: 0, exceptionCount: 0, blockers: [], exceptions: [], truncated: false } };
}
const rows = Array.from({ length: 50 }, (_, index) => row(index));
function surface(overrides: Partial<EntriesTableProps> = {}) {
  const gate = overrides.gate ?? new InteractionGate(); gate.setVisibleOwner("entries");
  const ref = createRef<EntriesTableHandle>();
  let props: EntriesTableProps = {
    rows, firstPosition: 50, total: 200, projectId: "project", sourceLocale: "en", view: makeWorkspaceView({ kind: "entries", locale: "zh-CN" }, "entries"),
    drafts: null, gate, disabled: false, dispatch: vi.fn(() => true), scroll: { top: 0, left: 0 }, selectedIds: [],
    onScroll: vi.fn(), onEdit: vi.fn(), onDetails: vi.fn(), onMove: vi.fn(), onSelection: vi.fn(), canSelect: () => true, ...overrides,
  };
  const ui = render(<EntriesTable {...props} ref={ref} />);
  return { gate, ref, get props() { return props; }, update: (patch: Partial<EntriesTableProps>) => { props = { ...props, ...patch }; ui.rerender(<EntriesTable {...props} ref={ref} />); } };
}
function viewport() { return screen.getByRole("region", { name: w("entriesTableLabel") }); }
function scrollTo(top: number) { fireEvent.scroll(viewport(), { target: { scrollTop: top } }); }

it("shows the shared status glyph directly and keeps details beside the source key", () => {
  const summary = row(0); summary.candidateCount = summary.aiCandidateCount = 1; summary.protection.protected = true;
  const h = surface({ rows: [summary], view: makeWorkspaceView({ kind: "entries", locale: "zh-CN", focus: "unit-0", entryPageMode: true }, "entries") });
  const glyph = screen.getByRole("img", { name: w("entryStatusCandidate") });
  expect(glyph.closest("button")).toBeNull();
  expect(screen.getByRole("img", { name: w("entryStatusProtected") }).closest("button")).toBeNull();
  expect(screen.queryByText(i18n.t("workbenchV2.candidateCount", { count: summary.aiCandidateCount }))).not.toBeInTheDocument();
  expect(screen.queryByText(w("protectedEntry"))).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: "key.unit-0" }) }));
  expect(h.props.onDetails).toHaveBeenCalledWith("unit-0");
});

it.each(["en-US", "zh-CN"] as const)("labels the table, global range and row actions with real %s resources", async language => {
  await i18n.changeLanguage(language);
  const drafts = await draftOwner("unit-0");
  const h = surface({ rows: [row(0), row(1)], drafts, view: makeWorkspaceView({ kind: "entries", locale: "zh-CN", entryPageMode: true }, "entries") });
  expect(viewport()).toHaveAccessibleName(language === "en-US" ? "Translation entries" : "译文条目");
  expect(viewport()).toHaveAccessibleDescription(language === "en-US" ? "Showing 51–52 of 200 entries" : "正在显示第 51–52 条，共 200 条");
  const entry = within(screen.getByRole("listitem", { name: "key.unit-0" }));
  const edit = entry.getByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: "key.unit-0" }) });
  expect(edit).toHaveAccessibleName(language === "en-US" ? "Edit key.unit-0" : "编辑 key.unit-0");
  fireEvent.click(edit); expect(h.props.onEdit).toHaveBeenCalledWith("unit-0");
  fireEvent.click(entry.getByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: "key.unit-0" }) }));
  expect(h.props.onDetails).toHaveBeenCalledWith("unit-0");
});

it("mounts candidate actions only in the focused row", () => {
  const renderCandidate = vi.fn((summary: SegmentRow) => <span>{`Candidate for ${summary.content.unitId}`}</span>);
  const view = makeWorkspaceView({ kind: "entries", locale: "zh-CN", focus: "unit-0", entryPageMode: true }, "entries");
  const h = surface({ rows: [row(0), row(1)], view, renderCandidate });
  expect(screen.getByText("Candidate for unit-0")).toBeVisible();
  expect(screen.queryByText("Candidate for unit-1")).not.toBeInTheDocument();
  expect(renderCandidate.mock.calls.every(([summary]) => summary.content.unitId === "unit-0")).toBe(true);
  h.update({ view: { ...view, focus: "unit-1" } });
  expect(screen.getByText("Candidate for unit-1")).toBeVisible();
  expect(screen.queryByText("Candidate for unit-0")).not.toBeInTheDocument();
});

it("renders exact previous and current Unicode endpoints without remounting the active editor", async () => {
  const drafts = await draftOwner("unit-0");
  const view = makeWorkspaceView({ kind: "entries", locale: "zh-CN", focus: "unit-0", editing: true, entryPageMode: true }, "entries");
  const h = surface({ rows: [row(0)], drafts, view });
  const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-0" }) });
  fireEvent.change(field, { target: { value: "Keep {{name}} é 👩🏽‍💻" } }); field.setSelectionRange(2, 9, "backward");
  fireEvent.compositionStart(field);
  const previous = "Previous {{name}}\r\né 👩🏽‍💻", current = "Current <b>日本語</b>\n🙂";
  const sourceComparison: SegmentSourceComparison = { projectId: "project", locale: "zh-CN", scopeId: "scope", currentSnapshotId: "snapshot", baseSnapshotId: "base", nextAfter: null,
    rows: [{ unitId: "unit-0", changeKind: "changed", old: { sourceRevisionId: "old", text: previous }, current: { sourceRevisionId: "revision", text: current } }] };
  h.update({ view: { ...view, compareSource: true }, sourceComparison });
  expect(document.querySelector('[data-source-version="previous"]')?.lastElementChild?.textContent).toBe(previous);
  expect(document.querySelector('[data-source-version="current"]')?.lastElementChild?.textContent).toBe(current);
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-0" }) })).toBe(field);
  expect(field).toHaveValue("Keep {{name}} é 👩🏽‍💻");
  expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(9); expect(field.selectionDirection).toBe("backward");
  expect(h.gate.getSnapshot().composingOwners).toHaveLength(1);
  h.update({ view: { ...view, compareSource: false } });
  expect(document.querySelector('[data-source-version="previous"]')).toBeNull();
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-0" }) })).toBe(field);
  fireEvent.compositionEnd(field);
});

it("distinguishes a missing prior unit from real empty source text", () => {
  const view = makeWorkspaceView({ kind: "entries", locale: "zh-CN", entryPageMode: true, compareSource: true }, "entries");
  const sourceComparison: SegmentSourceComparison = { projectId: "project", locale: "zh-CN", scopeId: "scope", currentSnapshotId: "snapshot", baseSnapshotId: "base", nextAfter: null,
    rows: [
      { unitId: "unit-0", changeKind: "added", old: null, current: { sourceRevisionId: "revision", text: "" } },
      { unitId: "unit-1", changeKind: "unchanged", old: { sourceRevisionId: "revision", text: "" }, current: { sourceRevisionId: "revision", text: "" } },
    ] };
  surface({ rows: [row(0), row(1)], view, sourceComparison });
  const newEntry = screen.getByRole("listitem", { name: "key.unit-0" }), emptyEntry = screen.getByRole("listitem", { name: "key.unit-1" });
  expect(within(newEntry).getByText(w("sourceComparisonNoPrevious"))).toBeVisible();
  expect(within(newEntry).getAllByText(w("sourceComparisonEmptyText"))).toHaveLength(1);
  expect(within(emptyEntry).queryByText(w("sourceComparisonNoPrevious"))).not.toBeInTheDocument();
  expect(within(emptyEntry).getAllByText(w("sourceComparisonEmptyText"))).toHaveLength(2);
});

async function draftOwner(unitId: string, sourceText?: string) {
  const heads = new Map<string, DraftHead>();
  const ports: Partial<TranslationDraftPorts> = {
    list: async () => ({ items: [], next: null }),
    read: async ({ key }) => ({ head: heads.get(key.unitId) ?? { key, revision: "0", writerId: null, value: null }, current: {
      kind: "current", basis: { sourceRevisionId: "revision", selectionId: null, revisionId: null, text: null }, sourceText: sourceText ?? `Complete source ${key.unitId}`, nativeKey: `key.${key.unitId}`,
    } }),
    write: async ({ write }) => {
      const head = { key: write.key, revision: (BigInt(heads.get(write.key.unitId)?.revision ?? "0") + 1n).toString(), writerId: write.writerId, value: structuredClone(write.value) as DraftValue };
      heads.set(write.key.unitId, head); return head;
    },
    clear: async ({ clear }) => { const head = { key: clear.key, revision: "1", writerId: null, value: null }; heads.set(clear.key.unitId, head); return head; },
    identity: async () => "action", save: async () => { throw new Error("No confirmation requested"); }, writerId: () => "table-writer",
  };
  const drafts = new TranslationDrafts({ context: { projectId: "project", sessionToken: "table-session" }, ports, reads: { invalidate: vi.fn() } });
  await drafts.initialize(); await drafts.open({ projectId: "project", unitId, locale: "zh-CN" });
  return drafts;
}

it("locates the full read-only source independently of source comparison while preserving translation B", async () => {
  const text = "A\r\n👩🏽‍💻\rB\nZ é", drafts = await draftOwner("unit-0", text), key = { projectId: "project", unitId: "unit-0", locale: "zh-CN" };
  await act(async () => { drafts.edit(key, "Translation draft B {name}"); await drafts.flush(key); });
  const value = drafts.getEntry(key)?.value; if (!value) throw new Error("Expected loaded synthetic draft");
  const focus: EntryDiagnosticFocus = { id: "source-diagnostic-once", unitId: key.unitId, locale: key.locale, sourceText: text, translationText: null,
    basis: structuredClone(value.basis), editSeq: value.editSeq, location: { field: "source", range: { encoding: "utf16", start: 3, end: 10 } }, status: "pending" };
  const summary = row(0); summary.content.sourcePreview = "A"; summary.sourceTruncated = true;
  const view = makeWorkspaceView({ kind: "entries", locale: "zh-CN", focus: "unit-0", editing: true, entryPageMode: true, compareSource: true }, "entries");
  const sourceComparison: SegmentSourceComparison = { projectId: "project", locale: "zh-CN", scopeId: "scope", currentSnapshotId: "snapshot", baseSnapshotId: "base", nextAfter: null,
    rows: [{ unitId: key.unitId, changeKind: "changed", old: { sourceRevisionId: "old", text: "Previous source" }, current: { sourceRevisionId: "revision", text } }] };
  const located = vi.fn(), edit = vi.spyOn(drafts, "edit"), h = surface({ rows: [summary], drafts, view, sourceComparison, diagnosticFocus: focus, onDiagnosticFocus: located });
  const source = screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("workbenchV2.editorDiagnosticSourceLabel", { key: "key.unit-0" }) });
  expect(source).toHaveAttribute("readonly"); expect(source).toHaveValue("A\n👩🏽‍💻\nB\nZ é"); expect(source).toHaveFocus();
  expect(source.selectionStart).toBe(2); expect(source.selectionEnd).toBe(9); expect(located.mock.calls).toEqual([[focus.id, true]]);
  expect(document.querySelector('[data-source-version="previous"]')).toBeNull();
  const translation = screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-0" }) });
  expect(translation).toHaveValue("Translation draft B {name}"); expect(translation).not.toHaveFocus(); expect(drafts.getEntry(key)?.value?.text).toBe("Translation draft B {name}");
  expect(text).toContain("\r\n"); const setSource = vi.spyOn(source, "value", "set");
  h.update({ diagnosticFocus: { ...focus, status: "applied" } });
  expect(source).toHaveFocus(); expect(source.selectionStart).toBe(2); expect(source.selectionEnd).toBe(9); expect(setSource).not.toHaveBeenCalled();
  const current = drafts.getEntry(key)?.current; expect(current?.kind === "current" ? current.sourceText : null).toBe(text);
  act(() => source.setSelectionRange(1, 1)); h.update({ diagnosticFocus: { ...focus, status: "applied" } });
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorDiagnosticSourceLabel", { key: "key.unit-0" }) })).toBe(source);
  expect(source.selectionStart).toBe(1); expect(source.selectionEnd).toBe(1); expect(located).toHaveBeenCalledTimes(1); expect(edit).not.toHaveBeenCalled(); expect(setSource).not.toHaveBeenCalled();
});

it("consumes a stale source sequence without selecting it later when the same request is repainted", async () => {
  const text = "Source 👩🏽‍💻", drafts = await draftOwner("unit-0", text), key = { projectId: "project", unitId: "unit-0", locale: "zh-CN" };
  const before = drafts.getEntry(key)?.value; if (!before) throw new Error("Expected loaded synthetic draft");
  const focus: EntryDiagnosticFocus = { id: "stale-source-request", unitId: key.unitId, locale: key.locale, sourceText: text, translationText: null,
    basis: structuredClone(before.basis), editSeq: before.editSeq, location: { field: "source", range: { encoding: "utf16", start: 0, end: 6 } }, status: "pending" };
  await act(async () => { drafts.edit(key, "New input B"); await drafts.flush(key); });
  const view = makeWorkspaceView({ kind: "entries", locale: "zh-CN", focus: "unit-0", editing: true, entryPageMode: true }, "entries");
  const located = vi.fn(), h = surface({ rows: [row(0)], drafts, view, diagnosticFocus: focus, onDiagnosticFocus: located });
  const source = screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorDiagnosticSourceLabel", { key: "key.unit-0" }) });
  expect(located.mock.calls).toEqual([[focus.id, false]]); expect(source).not.toHaveFocus(); expect(drafts.getEntry(key)?.value?.text).toBe("New input B");
  const current = drafts.getEntry(key)?.value; if (!current) throw new Error("Expected retained newer input");
  h.update({ diagnosticFocus: { ...focus, editSeq: current.editSeq } });
  expect(located).toHaveBeenCalledTimes(1); expect(source).not.toHaveFocus();
});

it("bounds mounted rows, keeps global list positions, and measures a row after it grows", async () => {
  surface();
  expect(screen.getAllByRole("listitem").length).toBeLessThan(15);
  const first = screen.getByRole("listitem", { name: "key.unit-0" });
  expect(first).toHaveAttribute("aria-posinset", "51"); expect(first).toHaveAttribute("aria-setsize", "200");
  const second = screen.getByRole("listitem", { name: "key.unit-1" });
  expect(second).toHaveStyle({ transform: "translateY(80px)" });
  heights.set("unit-0", 220); act(() => resize(first));
  await waitFor(() => expect(second).toHaveStyle({ transform: "translateY(220px)" }));
  scrollTo(1600);
  await waitFor(() => expect(screen.queryByRole("listitem", { name: "key.unit-0" })).not.toBeInTheDocument());
  expect(screen.getAllByRole("listitem").length).toBeLessThan(15);
  expect(viewport()).toHaveAccessibleDescription(/^Showing \d+–\d+ of 200 entries$/);
  expect(screen.queryByRole("grid")).not.toBeInTheDocument();
});

it("retains a focused row outside the virtual range and can focus a target arriving in a later page", async () => {
  const h = surface();
  const first = screen.getByRole("listitem", { name: "key.unit-0" }); act(() => first.focus());
  scrollTo(1600); expect(first.isConnected).toBe(true); expect(first).toHaveFocus();
  act(() => h.ref.current?.focusRow("unit-75"));
  h.update({ rows: Array.from({ length: 50 }, (_, index) => row(index + 50)), firstPosition: 100 });
  const target = await screen.findByRole("listitem", { name: "key.unit-75" });
  expect(target).toHaveFocus(); expect(target).toHaveAttribute("aria-posinset", "126");
  scrollTo(0); expect(target.isConnected).toBe(true); expect(target).toHaveFocus();
});

it("moves list focus without editing and leaves text selections, input, modifiers and IME alone", async () => {
  const drafts = await draftOwner("unit-0"), h = surface({ drafts });
  const first = screen.getByRole("listitem", { name: "key.unit-0" }); act(() => first.focus());
  fireEvent.keyDown(first, { key: "j" }); fireEvent.keyDown(first, { key: "ArrowUp" });
  expect(h.props.onMove).toHaveBeenNthCalledWith(1, 1, "unit-0"); expect(h.props.onMove).toHaveBeenNthCalledWith(2, -1, "unit-0");
  expect(h.props.onEdit).not.toHaveBeenCalled();
  fireEvent.keyDown(first, { key: "Enter" }); expect(h.props.onEdit).toHaveBeenCalledWith("unit-0");
  fireEvent.keyDown(first, { key: "j", ctrlKey: true }); expect(h.props.onMove, "modifier").toHaveBeenCalledTimes(2);
  fireEvent.keyDown(first, { key: "j", isComposing: true }); expect(h.props.onMove, "native composition").toHaveBeenCalledTimes(2);
  fireEvent.keyDown(first, { key: "j", keyCode: 229 }); expect(h.props.onMove, "IME keycode").toHaveBeenCalledTimes(2);
  fireEvent.keyDown(within(first).getByRole("checkbox"), { key: "j" }); expect(h.props.onMove, "checkbox").toHaveBeenCalledTimes(2);
  const text = first.querySelector('[lang="en"]')?.firstChild;
  if (!text) throw new Error("Expected selectable source text");
  const range = document.createRange(); range.selectNodeContents(text); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  expect(window.getSelection()?.isCollapsed).toBe(false);
  fireEvent.keyDown(first, { key: "j" }); expect(h.props.onMove, "selected source text").toHaveBeenCalledTimes(2); window.getSelection()?.removeAllRanges();
  fireEvent.compositionStart(first); fireEvent.keyDown(first, { key: "j" }); scrollTo(1600);
  expect(first.isConnected).toBe(true); fireEvent.compositionEnd(first);
  expect(h.props.onMove).toHaveBeenCalledTimes(2);
});

it("keeps the actual textarea and selection through scrolling, focus mode and composition", async () => {
  const drafts = await draftOwner("unit-0"), view = makeWorkspaceView({ kind: "entries", locale: "zh-CN", focus: "unit-0", editing: true }, "entries");
  const h = surface({ drafts, view });
  const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-0" }) });
  fireEvent.change(field, { target: { value: "Keep {name}\ne\u0301 中文🙂 العربية" } }); field.setSelectionRange(3, 11, "backward");
  fireEvent.compositionStart(field); scrollTo(1600);
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-0" }) })).toBe(field); expect(field).toHaveFocus();
  fireEvent.keyDown(field, { key: "j", isComposing: true }); expect(h.props.onMove).not.toHaveBeenCalled();
  fireEvent.compositionEnd(field); scrollTo(0);
  h.update({ view: { ...view, focusMode: true } });
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-0" }) })).toBe(field);
  h.update({ view: { ...view, focusMode: false } }); act(() => h.ref.current?.focusEditor());
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-0" }) })).toBe(field); expect(field).toHaveValue("Keep {name}\ne\u0301 中文🙂 العربية");
  expect(field.selectionStart).toBe(3); expect(field.selectionEnd).toBe(11); expect(field.selectionDirection).toBe("backward");
  expect(field).toHaveFocus();
});

it("preserves scroll restoration and selected offscreen identities with a guarded checkbox", async () => {
  const h = surface({ scroll: { top: 800, left: 12 }, selectedIds: ["unit-0", "unit-20"], canSelect: unitId => unitId !== "unit-1" });
  expect(viewport().scrollTop).toBe(800); expect(viewport().scrollLeft).toBe(12);
  h.update({ scroll: { top: 0, left: 0 } }); fireEvent.scroll(viewport());
  const first = screen.getByRole("checkbox", { name: i18n.t("workbenchV2.entrySelect", { key: "key.unit-0" }) }); expect(first).toBeChecked();
  expect(screen.getByRole("checkbox", { name: i18n.t("workbenchV2.entrySelect", { key: "key.unit-1" }) })).toBeDisabled();
  fireEvent.click(first); expect(h.props.onSelection).toHaveBeenCalledWith("unit-0", false);
  scrollTo(1600);
  const later = await screen.findByRole("checkbox", { name: i18n.t("workbenchV2.entrySelect", { key: "key.unit-20" }) }); expect(later).toBeChecked();
  expect(h.props.onScroll).toHaveBeenLastCalledWith({ top: 1600, left: 0 });
});


it("shows only the loaded page in natural flow and keeps the editor instance when switching rendering modes", async () => {
  const drafts = await draftOwner("unit-0"), view = makeWorkspaceView({ kind: "entries", locale: "zh-CN", focus: "unit-0", editing: true }, "entries");
  const h = surface({ drafts, view });
  const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-0" }) });
  fireEvent.change(field, { target: { value: "Keep {name} 中文\ne\u0301🙂 العربية" } }); field.setSelectionRange(5, 12, "backward");
  fireEvent.compositionStart(field);
  expect(screen.getAllByRole("listitem").length).toBeLessThan(15);
  h.update({ view: { ...view, entryPageMode: true } });
  const list = screen.getByRole("list", { name: w("entriesTableLabel") });
  expect(screen.getAllByRole("listitem")).toHaveLength(50);
  expect(screen.getByRole("listitem", { name: "key.unit-49" })).toHaveAttribute("aria-posinset", "100");
  expect(list.style.height).toBe("");
  expect(screen.getByRole("listitem", { name: "key.unit-49" }).style.transform).toBe("");
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-0" }) })).toBe(field);
  scrollTo(1600); expect(screen.getAllByRole("listitem")).toHaveLength(50);
  h.update({ view: { ...view, entryPageMode: false } });
  expect(screen.getAllByRole("listitem").length).toBeLessThan(15);
  expect(screen.getByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "key.unit-0" }) })).toBe(field);
  expect(field).toHaveValue("Keep {name} 中文\ne\u0301🙂 العربية"); expect(field).toHaveFocus();
  expect(field.selectionStart).toBe(5); expect(field.selectionEnd).toBe(12); expect(field.selectionDirection).toBe("backward");
  expect(h.gate.getSnapshot().composingOwners).toHaveLength(1); fireEvent.compositionEnd(field);
  h.update({ view: { ...view, editing: false, focus: null, entryPageMode: true } });
  act(() => h.ref.current?.focusRow("unit-49"));
  expect(screen.getByRole("listitem", { name: "key.unit-49" })).toHaveFocus();
});
