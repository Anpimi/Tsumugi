import { describe, expect, it } from "vitest";
import { createWorkspaceStore } from "./workspaceStore";
import { workspaceViewHref } from "./workspaceRouter";
const selected = (id: string, locale = "zh-CN") => ({ kind: "ids" as const, locale, sourceSnapshotId: "snapshot", unitIds: [id] });

describe("workspace view state", () => {
  it("keeps a project decision and its page separate from the entry editing queue", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "inbox", kind: "decisions", locale: "zh-CN", focus: "delivery-unknown:original" }] });
    const cursor = { basis: "a".repeat(64), afterId: "delivery-unknown:earlier" };
    store.getState().patch("inbox", { decisionCursor: cursor, decisionPrevious: [null], scroll: { top: 120, left: 0 } });
    cursor.afterId = "changed-outside-view";
    expect(store.getState().views.inbox).toMatchObject({ focus: "delivery-unknown:original", editing: false, queueActive: false, queueAnchor: null,
      decisionCursor: { afterId: "delivery-unknown:earlier" }, decisionPrevious: [null], scroll: { top: 120, left: 0 } });
    store.getState().open({ id: "entry", kind: "entries", locale: "zh-CN", focus: "unit-a" });
    store.getState().activate("inbox");
    expect(store.getState().views.inbox.decisionPrevious).toEqual([null]);
    expect(workspaceViewHref(store.getState().views.inbox)).not.toMatch(/decisionCursor|afterId|decisionPrevious/);
    store.getState().patch("inbox", { locale: "fr-FR", focus: "delivery-unknown:other" });
    expect(store.getState().views.inbox).toMatchObject({ editing: false, queueActive: false, queueAnchor: null });
  });
  it("retains comparison and inspector tabs per view and resets candidate paging for another target", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN", focus: "unit-a" }] });
    const references = ["revision-a", "revision-b"];
    store.getState().patch("one", { compareSource: true, detailTab: "candidates", candidateAfterOrdinal: "50", candidateInitialRevisionId: "revision-a",
      candidateCompareOpen: true, candidateComparisonId: "comparison-a", candidateCompareRefs: references, candidateCompareBlind: true });
    references.push("unrelated-revision");
    expect(store.getState().views.one.candidateCompareRefs).toEqual(["revision-a", "revision-b"]);
    store.getState().open({ id: "two", kind: "entries", locale: "ja" });
    expect(store.getState().views.two).toMatchObject({ compareSource: false, detailTab: "detail", candidateAfterOrdinal: "0", candidateCompareOpen: false, candidateCompareRefs: [] });
    store.getState().patch("one", { focus: "unit-b" });
    expect(store.getState().views.one).toMatchObject({ compareSource: true, detailTab: "candidates", candidateAfterOrdinal: "0", candidateInitialRevisionId: null,
      candidateCompareOpen: false, candidateComparisonId: null, candidateCompareRefs: [], candidateCompareBlind: true });
    store.getState().patch("one", { candidateAfterOrdinal: "100", locale: "ja" });
    expect(store.getState().views.one.candidateAfterOrdinal).toBe("100");
    store.getState().patch("one", { locale: "zh-CN" });
    expect(store.getState().views.one.candidateAfterOrdinal).toBe("0");
    expect(workspaceViewHref(store.getState().views.one)).not.toMatch(/compare|candidate|detailTab/);
  });
  it("keeps review history pages per view and returns to the first page for another entry or language", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN", focus: "unit-a" }] });
    store.getState().patch("one", { detailTab: "history", reviewHistoryOffset: 40 });
    store.getState().open({ id: "two", kind: "entries", locale: "zh-CN", focus: "unit-a" });
    expect(store.getState().views.one.reviewHistoryOffset).toBe(40);
    expect(store.getState().views.two.reviewHistoryOffset).toBe(0);
    store.getState().patch("one", { focus: "unit-b" });
    expect(store.getState().views.one).toMatchObject({ detailTab: "history", reviewHistoryOffset: 0 });
    store.getState().patch("one", { reviewHistoryOffset: 20 });
    store.getState().patch("one", { locale: "ja" });
    expect(store.getState().views.one.reviewHistoryOffset).toBe(0);
    expect(workspaceViewHref(store.getState().views.one)).not.toContain("reviewHistory");
  });
  it("keeps the entry presentation mode local to each tab and out of the URL", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN" }] });
    expect(store.getState().views.one.entryMode).toBe("table");
    store.getState().patch("one", { entryMode: "import" });
    store.getState().open({ id: "two", kind: "entries", locale: "ja" });
    expect(store.getState().views.one.entryMode).toBe("import"); expect(store.getState().views.two.entryMode).toBe("table");
    expect(workspaceViewHref(store.getState().views.one)).toBe("/view/one?kind=entries&locale=zh-CN&preset=all");
    store.getState().patch("one", { locale: "ja" }); expect(store.getState().views.one.entryMode).toBe("import");
  });
  it("keeps submitted search, unfinished input and position separate for each tab and session", () => {
    const first = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN" }] });
    first.getState().patch("one", { query: "harvest" });
    first.getState().patch("one", { query: "harvest", searchInput: "harvest festival", selection: selected("unit-a"), afterOrdinal: 80, scroll: { top: 640, left: 12 }, dock: "details", focus: "unit-a" });
    first.getState().open({ id: "two", kind: "entries", locale: "ja" });
    first.getState().patch("two", { query: "letter", searchInput: "letter to a friend", selection: selected("unit-b", "ja") });
    first.getState().activate("one");
    expect(first.getState().views.one).toMatchObject({ locale: "zh-CN", query: "harvest", searchInput: "harvest festival", selection: selected("unit-a"), afterOrdinal: 80, scroll: { top: 640, left: 12 }, dock: "details", focus: "unit-a" });
    expect(first.getState().views.two).toMatchObject({ locale: "ja", query: "letter", searchInput: "letter to a friend", selection: selected("unit-b", "ja"), afterOrdinal: 0 });
    const second = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN" }] });
    expect(second.getState().views.one).toMatchObject({ query: "", searchInput: "", selection: null, dock: "agent" });
  });

  it("selects a neighbour after closing, keeps pinned tabs and copies caller arrays", () => {
    const selection = selected("unit-a");
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: ["one", "two", "three"].map(id => ({ id, kind: "entries" as const, locale: "zh-CN" })) });
    store.getState().patch("two", { selection });
    selection.unitIds.push("unit-b");
    expect(store.getState().views.two.selection).toEqual(selected("unit-a"));
    store.getState().activate("two");
    expect(store.getState().close("two")).toBe(true);
    expect(store.getState().activeViewId).toBe("three");
    store.getState().pin("one");
    expect(store.getState().close("one")).toBe(false);
    expect(store.getState().close("three")).toBe(true);
    expect(store.getState().activeViewId).toBe("one");
    store.getState().pin("one", false);
    expect(store.getState().close("one")).toBe(true);
    expect(store.getState().activeViewId).toBeNull();
  });

  it("does not treat an inherited object property as an existing tab", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [] });
    expect(store.getState().activate("constructor")).toBe(false);
    store.getState().open({ id: "constructor", kind: "entries", locale: "zh-CN" });
    expect(store.getState().views.constructor).toMatchObject({ id: "constructor", kind: "entries" });
  });

  it("keeps editing and the fixed queue in a view, and clears their scope when its query context changes", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN", focus: "unit-a" }] });
    expect(store.getState().views.one).toMatchObject({ editing: true, queueActive: true, queueAnchor: "unit-a", queueScopeId: null, focusMode: false });
    store.getState().patch("one", { queueScopeId: "original-scope", cursor: "original-cursor", focusMode: true });
    store.getState().patch("one", { preset: "unselected" });
    expect(store.getState().views.one).toMatchObject({ focus: "unit-a", editing: false, queueActive: false, queueScopeId: null, cursor: null, queueAnchor: "unit-a", focusMode: false });
    store.getState().patch("one", { locale: "ja", focus: "unit-b", editing: true, queueActive: true });
    expect(store.getState().views.one).toMatchObject({ locale: "ja", editing: true, queueActive: true, queueAnchor: "unit-b", queueScopeId: null });
  });
});
