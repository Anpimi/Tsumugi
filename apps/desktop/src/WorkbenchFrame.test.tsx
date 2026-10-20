import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceViewMemory, WorkspaceViewProvider, useWorkbenchState, useWorkbenchValue } from "./WorkbenchFrame";

afterEach(cleanup);

describe("project scoped view inputs", () => {
  it("observes retained context without initializing inputs and releases the previous session subscription", () => {
    const first = new WorkspaceViewMemory(), second = new WorkspaceViewMemory();
    const firstWrite = vi.spyOn(first, "write"), secondWrite = vi.spyOn(second, "write");
    function Context() {
      const locale = useWorkbenchValue<string>("translation", "targetLocale");
      const selection = useWorkbenchValue<readonly string[]>("review", "languages");
      return <output>{locale ?? "No working language"}: {selection?.join(", ") ?? "No selected languages"}</output>;
    }
    const tree = (memory: WorkspaceViewMemory) => <WorkspaceViewProvider value={{ area: "translation", memory, activate() {}, deactivate() {} }}><Context /></WorkspaceViewProvider>;
    const rendered = render(tree(first));
    expect(screen.getByText("No working language: No selected languages")).toBeInTheDocument();
    expect(firstWrite).not.toHaveBeenCalled();
    act(() => { first.write("translation", "targetLocale", "ja"); first.write("review", "languages", ["ja", "zh-CN"]); });
    expect(screen.getByText("ja: ja, zh-CN")).toBeInTheDocument();
    rendered.rerender(tree(second));
    expect(screen.getByText("No working language: No selected languages")).toBeInTheDocument();
    expect(secondWrite).not.toHaveBeenCalled();
    act(() => first.write("translation", "targetLocale", "fr"));
    expect(screen.queryByText(/^fr:/)).not.toBeInTheDocument();
    act(() => second.write("translation", "targetLocale", "zh-CN"));
    expect(screen.getByText("zh-CN: No selected languages")).toBeInTheDocument();
    expect(secondWrite).toHaveBeenCalledTimes(1);
  });
  it("resets semantic history cursors while their consumers are absent without clearing input or unrelated positions", () => {
    const memory = new WorkspaceViewMemory();
    memory.write("review", "historyCursor", { unitId: "unit", locale: "zh-CN", offset: 20 });
    memory.write("source", "history.offset", 50); memory.write("source", "historyOffset", 50);
    memory.write("source", "history.query", "Unapplied search"); memory.write("source", "history.after", 10);
    memory.observeChanges(["execution"]);
    expect(memory.read("review", "historyCursor")).toEqual({ unitId: "unit", locale: "zh-CN", offset: 20 });
    memory.observeChanges(["review"]);
    expect(memory.read("review", "historyCursor")).toEqual({ unitId: "unit", locale: "zh-CN", offset: 0 });
    expect(memory.read("source", "history.offset")).toBe(50);
    memory.observeChanges(["source"]);
    expect(memory.read("source", "history.offset")).toBe(0); expect(memory.read("source", "historyOffset")).toBe(0);
    expect(memory.read("source", "history.query")).toBe("Unapplied search"); expect(memory.read("source", "history.after")).toBe(10);
  });
  it("retains editable input through real consumer cleanup and remount", () => {
    const memory = new WorkspaceViewMemory(), removed = vi.fn();
    function Input() {
      const [query, setQuery] = useWorkbenchState("translation", "query", "");
      useLayoutEffect(() => removed, []);
      return <input aria-label="Search" value={query} onChange={event => setQuery(event.target.value)} />;
    }
    const tree = (visible: boolean) => <WorkspaceViewProvider value={{ area: "translation", memory, activate() {}, deactivate() {} }}>{visible ? <Input /> : null}</WorkspaceViewProvider>;
    const rendered = render(tree(true)); fireEvent.change(screen.getByLabelText("Search"), { target: { value: "original range" } });
    rendered.rerender(tree(false)); expect(removed).toHaveBeenCalledOnce();
    rendered.rerender(tree(true)); expect(screen.getByLabelText("Search")).toHaveValue("original range");
  });
  it("delivers a typed destination input to an already mounted view and ignores its old asynchronous setter", () => {
    const memory = new WorkspaceViewMemory(); let late!: (value: string) => void;
    function Input() {
      const [tab, setTab] = useWorkbenchState("review", "tab", "review");
      useLayoutEffect(() => { late = setTab; }, [setTab]); return <output>{tab}</output>;
    }
    const tree = (visible: boolean, inputs = memory) => <WorkspaceViewProvider value={{ area: "review", memory: inputs, activate() {}, deactivate() {} }}>{visible ? <Input /> : null}</WorkspaceViewProvider>;
    const rendered = render(tree(true)); act(() => memory.write("review", "tab", "work")); expect(screen.getByText("work")).toBeInTheDocument();
    const old = late; rendered.rerender(tree(false)); old("stale response");
    rendered.rerender(tree(true)); expect(screen.getByText("work")).toBeInTheDocument();
    rendered.rerender(tree(false)); rendered.rerender(tree(true, new WorkspaceViewMemory()));
    expect(screen.getByText("review")).toBeInTheDocument();
  });
});
