import { describe, expect, it } from "vitest";
import { createWorkspaceStore } from "./workspaceStore";

describe("workspace view state", () => {
  it("keeps submitted search, unfinished input and position separate for each tab and session", () => {
    const first = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN" }] });
    first.getState().patch("one", { query: "harvest", searchInput: "harvest festival", selection: ["unit-a"], afterOrdinal: 80, scroll: { top: 640, left: 12 }, dock: "details", focus: "unit-a" });
    first.getState().open({ id: "two", kind: "entries", locale: "ja" });
    first.getState().patch("two", { query: "letter", searchInput: "letter to a friend", selection: ["unit-b"] });
    first.getState().activate("one");
    expect(first.getState().views.one).toMatchObject({ locale: "zh-CN", query: "harvest", searchInput: "harvest festival", selection: ["unit-a"], afterOrdinal: 80, scroll: { top: 640, left: 12 }, dock: "details", focus: "unit-a" });
    expect(first.getState().views.two).toMatchObject({ locale: "ja", query: "letter", searchInput: "letter to a friend", selection: ["unit-b"], afterOrdinal: 0 });
    const second = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN" }] });
    expect(second.getState().views.one).toMatchObject({ query: "", searchInput: "", selection: [], dock: "agent" });
  });

  it("selects a neighbour after closing, keeps pinned tabs and copies caller arrays", () => {
    const selection = ["unit-a"];
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: ["one", "two", "three"].map(id => ({ id, kind: "entries" as const, locale: "zh-CN" })) });
    store.getState().patch("two", { selection });
    selection.push("unit-b");
    expect(store.getState().views.two.selection).toEqual(["unit-a"]);
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
});
