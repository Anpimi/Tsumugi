import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceViewMemory, WorkspaceViewProvider, useWorkbenchState } from "./WorkbenchFrame";

afterEach(cleanup);

describe("project scoped view inputs", () => {
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
