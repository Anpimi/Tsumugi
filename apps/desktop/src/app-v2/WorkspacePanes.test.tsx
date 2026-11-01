import { createRef, useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspacePanes } from "./WorkspacePanes";
import { makeWorkspaceView } from "./workspace/workspaceStore";

afterEach(cleanup);

function InputProbe({ label, mounted, unmounted }: { label: string; mounted: () => void; unmounted: () => void }) {
  const [value, setValue] = useState("");
  useEffect(() => { mounted(); return unmounted; }, [mounted, unmounted]);
  return <label>{label}<textarea value={value} onChange={event => setValue(event.target.value)}/></label>;
}

function setup() {
  const mounted = { view: vi.fn(), agent: vi.fn() }, unmounted = { view: vi.fn(), agent: vi.fn() };
  const onOpenChange = vi.fn(), dockRef = createRef<HTMLDivElement>(), resize = vi.fn();
  function tree({ conversationMode = false, compact = false, drawerOpen = false } = {}) {
    return <><button>Drawer trigger</button><WorkspacePanes view={makeWorkspaceView({ kind: "entries", locale: "zh-CN", conversationMode }, "one")}
      compact={compact} wide={!compact} disabled={false} dockRef={dockRef} label="Agent" resizeLabel="Resize panels" onResize={resize}
      drawer={{ open: drawerOpen, onOpenChange, title: "Agent drawer", description: "Synthetic project", closeLabel: "Close drawer" }}
      dock={<InputProbe label="Agent input" mounted={mounted.agent} unmounted={unmounted.agent}/>}>
      <main><InputProbe label="View input" mounted={mounted.view} unmounted={unmounted.view}/></main>
    </WorkspacePanes></>;
  }
  return { tree, mounted, unmounted, onOpenChange, dockRef, resize };
}

it("reorders the same panes in DOM and keyboard order without remounting either input", () => {
  const { tree, mounted, unmounted } = setup(), rendered = render(tree());
  const view = screen.getByRole("textbox", { name: "View input" }), agent = screen.getByRole("textbox", { name: "Agent input" });
  fireEvent.change(view, { target: { value: "Unfinished search B {{name}}" } });
  fireEvent.change(agent, { target: { value: "Retained conversation 🙂\nsecond line" } });
  const input = agent as HTMLTextAreaElement;
  input.setSelectionRange(2, 9); input.scrollTop = 48;
  expect(view.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  rendered.rerender(tree({ conversationMode: true }));
  expect(screen.getByRole("textbox", { name: "Agent input" })).toBe(agent);
  expect(screen.getByRole("textbox", { name: "View input" })).toBe(view);
  expect(agent.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(view).toHaveValue("Unfinished search B {{name}}");
  expect(agent).toHaveValue("Retained conversation 🙂\nsecond line");
  expect([input.selectionStart, input.selectionEnd, input.scrollTop]).toEqual([2, 9, 48]);
  rendered.rerender(tree());
  expect(view.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(mounted.view).toHaveBeenCalledOnce(); expect(mounted.agent).toHaveBeenCalledOnce();
  expect(unmounted.view).not.toHaveBeenCalled(); expect(unmounted.agent).not.toHaveBeenCalled();
});

it("retains a single Agent input through drawer close, conversation mode and return to the inline dock", async () => {
  const { tree, mounted, unmounted, onOpenChange, dockRef } = setup(), rendered = render(tree({ compact: true }));
  const agent = screen.getByLabelText("Agent input"), view = screen.getByRole("textbox", { name: "View input" }), trigger = screen.getByRole("button", { name: "Drawer trigger" });
  fireEvent.change(view, { target: { value: "Retained current view" } });
  trigger.focus(); rendered.rerender(tree({ compact: true, drawerOpen: true }));
  const dialog = await screen.findByRole("dialog", { name: "Agent drawer" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close drawer" })).toHaveFocus());
  agent.focus(); expect(agent).toHaveFocus();
  expect(within(dialog).getByRole("textbox", { name: "Agent input" })).toBe(agent);
  fireEvent.change(agent, { target: { value: "Draft in drawer\n🙂" } });
  expect(dockRef.current?.contains(agent)).toBe(true);
  expect(document.querySelectorAll('textarea')).toHaveLength(2);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close drawer" }));
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  rendered.rerender(tree({ compact: true }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("textbox", { name: "Agent input" })).not.toBeInTheDocument();
  expect(agent).toHaveValue("Draft in drawer\n🙂");
  expect(view.closest('[aria-hidden="true"]')).toBeNull();
  rendered.rerender(tree({ compact: true, conversationMode: true }));
  expect(screen.getByRole("textbox", { name: "Agent input" })).toBe(agent);
  expect(agent).toBeVisible(); expect(agent.closest('[aria-hidden="true"], [inert]')).toBeNull();
  expect(screen.queryByRole("textbox", { name: "View input" })).not.toBeInTheDocument();
  rendered.rerender(tree());
  expect(screen.getByRole("textbox", { name: "Agent input" })).toBe(agent);
  expect(screen.getByRole("textbox", { name: "View input" })).toBe(view);
  expect(view).toHaveValue("Retained current view");
  expect(mounted.view).toHaveBeenCalledOnce(); expect(mounted.agent).toHaveBeenCalledOnce();
  expect(unmounted.view).not.toHaveBeenCalled(); expect(unmounted.agent).not.toHaveBeenCalled();
});

it("releases the drawer focus scope and hidden siblings when the same Agent returns to a wide window", async () => {
  const { tree, unmounted } = setup(), rendered = render(tree({ compact: true }));
  const trigger = screen.getByRole("button", { name: "Drawer trigger" }), agent = screen.getByLabelText("Agent input");
  trigger.focus(); rendered.rerender(tree({ compact: true, drawerOpen: true }));
  const dialog = await screen.findByRole("dialog", { name: "Agent drawer" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close drawer" })).toHaveFocus());
  agent.focus(); expect(agent).toHaveFocus();
  rendered.rerender(tree());
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: "Agent input" })).toBe(agent);
  expect(agent.closest('[aria-hidden="true"], [inert]')).toBeNull();
  const view = screen.getByRole("textbox", { name: "View input" });
  view.focus(); expect(view).toHaveFocus();
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(unmounted.agent).not.toHaveBeenCalled();
});
