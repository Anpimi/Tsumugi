import { createRef, useImperativeHandle, useRef, type ComponentProps, type Ref } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GroupProps, Layout, PanelProps, SeparatorProps } from "react-resizable-panels";
import { ContentPaneLayout, useContentPaneIntent, type ContentPaneLayoutHandle } from "./ContentPaneLayout";
import { WorkspaceViewMemory, WorkspaceViewProvider } from "./WorkbenchFrame";
import { controlContentPaneGeometry, panePointer } from "./testSupport/contentPaneGeometry";
import { i18n } from "./i18n";

type GroupRecord = { element: HTMLDivElement | null; props: GroupProps; layout: Layout; requested: Layout[] };
const library = vi.hoisted(() => ({ groups: new Map<string, GroupRecord>(), panels: new Map<string, PanelProps>() }));

// This double exercises only the application's adapter and stable composition.
// Real library constraints, drag, keyboard and ARIA require browser geometry.
vi.mock("react-resizable-panels", async () => {
  const React = await import("react");
  function attach<T>(ref: Ref<T> | undefined, value: T) { if (typeof ref === "function") ref(value); else if (ref) ref.current = value; }
  return {
    Group(props: GroupProps) {
      const record = React.useRef<GroupRecord>({ element: null, props, layout: {}, requested: [] }).current;
      record.props = props;
      React.useLayoutEffect(() => {
        library.groups.set(props.className ?? "", record);
        return () => { library.groups.delete(props.className ?? ""); };
      }, [record, props.className]);
      React.useImperativeHandle(props.groupRef, () => ({ getLayout: () => record.layout, setLayout: (layout: Layout) => {
        record.layout = structuredClone(layout); record.requested.push(structuredClone(layout));
        record.props.onLayoutChanged?.(layout, { isUserInteraction: false, requestedLayout: layout }); return layout;
      } }), [record]);
      return <div data-group className={props.className} onKeyDownCapture={props.onKeyDownCapture}
        ref={element => { record.element = element; attach(props.elementRef, element); }}>{props.children}</div>;
    },
    Panel(props: PanelProps) {
      React.useLayoutEffect(() => { library.panels.set(String(props.id), props); return () => { library.panels.delete(String(props.id)); }; }, [props]);
      return <div data-panel id={String(props.id)} ref={props.elementRef} hidden={props.hidden} tabIndex={props.tabIndex}><div className={props.className}>{props.children}</div></div>;
    },
    Separator(props: SeparatorProps) {
      return <div data-separator role="separator" ref={props.elementRef} className={props.className} hidden={props.hidden} aria-label={props["aria-label"]}/>;
    },
  };
});

let frameSequence = 0;
const pendingFrames = new Map<number, FrameRequestCallback>();
function advanceFrame() {
  act(() => {
    const current = [...pendingFrames.values()]; pendingFrames.clear();
    current.forEach(callback => callback(16));
  });
}

const noop = () => {};
type TestHandle = ContentPaneLayoutHandle & { captureEditorReveal: () => () => void };
function Content({ handle, composing = false, active = true, referencesOpen = true, entriesDisabled = false }: {
  handle: Ref<TestHandle>; composing?: boolean; active?: boolean; referencesOpen?: boolean; entriesDisabled?: boolean;
}) {
  const field = useRef<HTMLTextAreaElement>(null), layout = useRef<ContentPaneLayoutHandle>(null), intent = useContentPaneIntent();
  useImperativeHandle(handle, () => ({ captureEditorReveal: intent.captureEditorReveal,
    editorVisible: () => layout.current?.editorVisible() ?? false, focusVisible: () => layout.current?.focusVisible() }));
  return <ContentPaneLayout ref={layout} intent={intent} active={active} composing={composing} referencesOpen={referencesOpen} hasEditor editorFocus={field} onEditorVisibilityChange={noop}
    list={<div className="translation-entry-list"><button className="translation-entry" aria-disabled={entriesDisabled || undefined}>Earlier entry</button><button className="translation-entry" aria-current="true" aria-disabled={entriesDisabled || undefined}>Selected entry</button></div>}
    editor={<div className="translation-editor"><div className="translation-editor-content"><textarea aria-label="Kept draft" defaultValue="Original draft 日本語" ref={field}/></div><div className="editor-save-bar"><button>Save kept draft</button></div></div>}
    references={<details className="editor-references" open={referencesOpen}><summary>References</summary><p>Original reference</p></details>}/>;
}
function harness(overrides: Partial<ComponentProps<typeof Content>> = {}) {
  const memory = new WorkspaceViewMemory(), handle = createRef<TestHandle>(), resize = controlContentPaneGeometry();
  const geometry = { width: 0, height: 0, detailWidth: 0, summaryHeight: 52 };
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("translation-columns")) return new DOMRect(0, 0, geometry.width, geometry.height);
    if (this.classList.contains("translation-detail")) return new DOMRect(0, 0, geometry.detailWidth, geometry.height);
    if (this.classList.contains("editor-references")) return new DOMRect(0, 0, geometry.detailWidth, geometry.summaryHeight);
    if (this.hasAttribute("data-separator")) {
      if (this.hidden) return new DOMRect();
      const horizontalGroup = this.parentElement?.classList.contains("translation-columns") || library.groups.get("translation-detail")?.props.orientation === "horizontal";
      return new DOMRect(0, 0, horizontalGroup ? 24 : geometry.detailWidth, horizontalGroup ? geometry.height : 24);
    }
    return originalRect.call(this);
  });
  const tree = (visible = true, props = overrides) => <><button>Outside layout</button><WorkspaceViewProvider value={{ area: "translation", memory, activate: noop, deactivate: noop }}>
    {visible ? <Content handle={handle} {...props}/> : null}</WorkspaceViewProvider></>;
  const rendered = render(tree());
  function group(boundary: "list" | "references") {
    const value = library.groups.get(boundary === "list" ? "translation-columns" : "translation-detail");
    if (!value?.element) throw new Error("Expected the mounted Group contract"); return value;
  }
  function panelId(boundary: "list" | "references") {
    const panel = Array.from(group(boundary).element?.children ?? []).find(child => child.hasAttribute("data-panel") && child.id.endsWith(`-${boundary}`));
    if (!panel) throw new Error("Expected the captured panel identity"); return panel.id;
  }
  function measure(width: number, height = 600, detailWidth = 600) {
    Object.assign(geometry, { width, height, detailWidth });
    const outer = group("list").element, inner = group("references").element;
    if (!outer || !inner) throw new Error("Expected both product groups");
    resize(outer, width, height); resize(inner, detailWidth, height); advanceFrame();
  }
  function complete(boundary: "list" | "references", pixels: number, requested = pixels, user = true) {
    const value = group(boundary), horizontal = boundary === "list" || value.props.orientation === "horizontal";
    const axis = horizontal ? boundary === "list" ? geometry.width : geometry.detailWidth : geometry.height;
    const id = panelId(boundary), layout = { ...value.layout, [id]: pixels / (axis - 24) * 100 };
    act(() => value.props.onLayoutChanged?.(layout, { isUserInteraction: user, requestedLayout: { ...layout, [id]: requested / (axis - 24) * 100 } }));
  }
  return { ...rendered, memory, handle, tree, group, panelId, measure, complete, resize };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); library.groups.clear(); library.panels.clear();
  frameSequence = 0; pendingFrames.clear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { pendingFrames.set(++frameSequence, callback); return frameSequence; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { pendingFrames.delete(id); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["en-US", "zh-CN"])("labels library separators and delegates both orientations in %s", async locale => {
  await i18n.changeLanguage(locale); const ui = harness(); ui.measure(1300, 600, 988);
  expect(screen.getByRole("separator", { name: i18n.t("contentPaneLayout.resizeList") })).toBeInTheDocument();
  expect(screen.getByRole("separator", { name: i18n.t("contentPaneLayout.resizeReferenceWidth") })).toBeInTheDocument();
  expect(ui.group("references").props.orientation).toBe("horizontal"); ui.measure(900, 600, 636);
  expect(screen.getByRole("separator", { name: i18n.t("contentPaneLayout.resizeReferenceHeight") })).toBeInTheDocument();
  expect(ui.group("references").props.orientation).toBe("vertical");
});

it("persists only completed user requests in pixels, retaining requested rather than temporarily constrained sizes", () => {
  const ui = harness(); ui.measure(1300, 600, 988);
  ui.complete("list", 320, 400, false); expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(288);
  ui.complete("list", 320, 400); expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(400);
  ui.complete("references", 292, 400); expect(ui.memory.read("translation", "paneLayout.wide.referenceWidth")).toBe(400);
});

it("loads separate pixel preferences through Group APIs on mode changes without overwriting them on resize", async () => {
  const ui = harness(), user = userEvent.setup(); ui.measure(1300, 600, 988); ui.complete("list", 400); ui.complete("references", 400);
  ui.measure(900, 600, 636); ui.complete("list", 250); ui.complete("references", 160);
  ui.measure(600); await user.click(screen.getByRole("button", { name: "Current entry" })); ui.complete("references", 190);
  ui.measure(1100, 600, 676);
  const listId = ui.panelId("list"), referenceId = ui.panelId("references");
  expect(ui.group("list").layout[listId]).toBeCloseTo(400 / 1076 * 100);
  expect(ui.group("references").layout[referenceId]).toBeCloseTo(400 / 652 * 100);
  expect(ui.memory.read("translation", "paneLayout.wide.referenceWidth")).toBe(400);
  ui.measure(900, 600, 636);
  expect(ui.group("list").layout[listId]).toBeCloseTo(250 / 876 * 100);
  expect(ui.group("references").layout[referenceId]).toBeCloseTo(160 / 576 * 100);
  expect(ui.memory.read("translation", "paneLayout.narrow.referenceHeight")).toBe(190);
});

it.each(["pointercancel", "lostpointercapture", "blur", "pagehide", "resize"])("rolls back a cancelled library gesture on %s without later saving it", async reason => {
  const ui = harness(); ui.measure(1300, 600, 988);
  const separator = screen.getByRole("separator", { name: "Resize entry list" }), group = ui.group("list"), initial = structuredClone(group.layout);
  panePointer(separator, "pointerdown", 300); group.layout = { ...group.layout, [ui.panelId("list")]: 40 };
  if (reason === "resize") ui.measure(1200, 600, 888);
  else if (reason === "blur" || reason === "pagehide") fireEvent(window, new Event(reason));
  else panePointer(separator, reason, 380);
  ui.complete("list", 368);
  expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(288);
  if (reason === "resize") {
    expect(group.props.disabled).toBe(true);
    // A later completion cannot turn the cancelled interaction into a preference.
    panePointer(separator, "pointerup", 410); ui.complete("list", 398);
    expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(288);
  } else expect(group.layout).toEqual(initial);
  await act(async () => {});
  if (reason === "resize") {
    expect(group.props.disabled).toBe(false);
    expect(group.layout[ui.panelId("list")]).toBeCloseTo(288 / 1176 * 100);
  }
});

it("keeps original preferences through hidden zero geometry and a consumer remount", () => {
  const ui = harness(); ui.measure(1300, 600, 988); ui.complete("list", 400);
  const before = structuredClone(ui.group("list").layout); ui.measure(0, 0, 0);
  expect(ui.group("list").layout).toEqual(before); expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(400);
  ui.rerender(ui.tree(false)); ui.rerender(ui.tree()); ui.measure(1300, 600, 988);
  expect(ui.group("list").layout[ui.panelId("list")]).toBeCloseTo(400 / 1276 * 100);
});

it("does not cancel a library gesture for a descendant input blur", async () => {
  const ui = harness(); ui.measure(1300, 600, 988);
  const separator = screen.getByRole("separator", { name: "Resize entry list" });
  panePointer(separator, "pointerdown", 300);
  fireEvent.blur(screen.getByRole("textbox", { name: "Kept draft" }));
  ui.complete("list", 368);
  expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(368);
  expect(ui.group("list").props.disabled).toBe(false);
  panePointer(separator, "pointerup", 380);
  await act(async () => {});
});

it("loads natural closed summary height and lowers expanded reference constraints in a short container", () => {
  const ui = harness({ referencesOpen: false }); ui.measure(900, 200, 636);
  const summary = screen.getByText("References", { selector: "summary" }), field = screen.getByRole("textbox", { name: "Kept draft" });
  const referenceId = ui.panelId("references");
  expect(library.panels.get(referenceId)?.minSize).toBe(52); expect(library.panels.get(referenceId)?.maxSize).toBe(52);
  ui.rerender(ui.tree(true, { referencesOpen: true }));
  expect(library.panels.get(referenceId)?.minSize).toBe(56); expect(library.panels.get(referenceId)?.maxSize).toBe(56);
  expect(screen.getByText("References", { selector: "summary" })).toBe(summary); expect(screen.getByRole("textbox", { name: "Kept draft" })).toBe(field);
  expect(field.closest(".translation-editor-content")?.nextElementSibling).toHaveClass("editor-save-bar");
  ui.rerender(ui.tree(true, { referencesOpen: false })); expect(summary).toBeVisible();
});

it("keeps one editor node and its selection while switching modes and rehomes hidden focus", async () => {
  const ui = harness(), user = userEvent.setup(); ui.measure(1300, 600, 988);
  const field = screen.getByRole("textbox", { name: "Kept draft" });
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("Expected the original editor");
  field.focus(); field.setSelectionRange(2, 8); ui.measure(600);
  expect(screen.getByRole("button", { name: "Selected entry" })).toHaveFocus(); expect(field).not.toBeVisible();
  await user.click(screen.getByRole("button", { name: "Current entry" }));
  expect(screen.getByRole("textbox", { name: "Kept draft" })).toBe(field); expect(field).toHaveFocus();
  expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(8); expect(field).toHaveValue("Original draft 日本語");
  ui.measure(900); expect(screen.getByRole("textbox", { name: "Kept draft" })).toBe(field);
});

it("keeps composition visible and guards only composing separator keys, never the editor's IME keys", () => {
  const ui = harness(); ui.measure(1300, 600, 988);
  const separator = screen.getByRole("separator", { name: "Resize entry list" }), listener = vi.fn(); separator.addEventListener("keydown", listener);
  fireEvent.keyDown(separator, { key: "ArrowRight", isComposing: true }); expect(listener).not.toHaveBeenCalled();
  const field = screen.getByRole("textbox", { name: "Kept draft" }), key = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
  fireEvent(field, key); expect(key.defaultPrevented).toBe(false);
  ui.rerender(ui.tree(true, { composing: true })); ui.complete("list", 400);
  expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(288); expect(ui.group("list").props.disabled).toBe(true);
  ui.measure(500); expect(field).toBeVisible(); expect(screen.getByRole("button", { name: "Entries" })).toBeDisabled();
  ui.rerender(ui.tree(true, { composing: false })); expect(field).toBeVisible();
});

it("uses the visible list container when hidden editor focus has no available row target", () => {
  const ui = harness({ entriesDisabled: true }); ui.measure(1300, 600, 988);
  const field = screen.getByRole("textbox", { name: "Kept draft" }); field.focus();
  ui.measure(600);
  expect(field).not.toBeVisible();
  expect(screen.getByRole("button", { name: "Selected entry" }).closest("[data-panel]")).toHaveFocus();
  expect(screen.getByRole("button", { name: "Selected entry" })).not.toHaveFocus();
});

it("honors a later list choice over an asynchronous reveal and consumes same-pane reveals without later focus theft", async () => {
  const ui = harness(), user = userEvent.setup(); ui.measure(600);
  const stale = ui.handle.current?.captureEditorReveal(); if (!stale) throw new Error("Expected reveal intent");
  await user.click(screen.getByRole("button", { name: "Entries" })); act(() => stale());
  expect(screen.getByRole("button", { name: "Entries" })).toHaveAttribute("aria-pressed", "true");
  act(() => ui.handle.current?.captureEditorReveal()()); const field = screen.getByRole("textbox", { name: "Kept draft" }); expect(field).toBeVisible();
  act(() => ui.handle.current?.captureEditorReveal()());
  const outside = screen.getByRole("button", { name: "Outside layout" }); outside.focus(); ui.measure(900);
  expect(outside).toHaveFocus(); expect(screen.getByRole("textbox", { name: "Kept draft" })).toBe(field);
});

it("uses the measured text size to select the existing narrow mode without replacing the draft", async () => {
  const ui = harness(), user = userEvent.setup(); ui.measure(900, 600, 636);
  const field = screen.getByRole("textbox", { name: "Kept draft" }) as HTMLTextAreaElement;
  field.focus(); field.setSelectionRange(2, 8);
  const metric = ui.container.querySelector(".content-pane-font-metric");
  if (!metric) throw new Error("Expected the text-size measurement");
  ui.resize(metric, 28, 28); advanceFrame();
  expect(screen.getByRole("button", { name: "Entries" })).toHaveAttribute("aria-pressed", "true");
  expect(field).not.toBeVisible();
  await user.click(screen.getByRole("button", { name: "Current entry" }));
  expect(screen.getByRole("textbox", { name: "Kept draft" })).toBe(field);
  expect(field).toHaveFocus(); expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(8);
  expect(field).toHaveValue("Original draft 日本語");
  expect(ui.memory.read("translation", "paneLayout.compact.listWidth")).toBe(240);
  ui.resize(metric, 14, 14); advanceFrame();
  expect(screen.getByRole("textbox", { name: "Kept draft" })).toBe(field);
  expect(ui.group("list").props.disabled).toBe(false);
});

it("reveals an already focused field locally after panel bounds settle without changing its selection", () => {
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++sequence, callback); return sequence; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  const ui = harness(); ui.measure(900);
  const field = screen.getByRole("textbox", { name: "Kept draft" }) as HTMLTextAreaElement;
  const scroll = field.closest<HTMLElement>(".translation-editor-content");
  if (!scroll) throw new Error("Expected the local editor scroller");
  const outer = ui.container.querySelector<HTMLElement>(".content-pane-layout")!;
  outer.scrollTop = 27; scroll.scrollTop = 40;
  Object.defineProperty(scroll, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 0, 400, 120) });
  Object.defineProperty(field, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, -20, 400, 96) });
  field.focus(); field.setSelectionRange(2, 8);
  act(() => { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(16)); });
  expect(scroll.scrollTop).toBe(20); expect(outer.scrollTop).toBe(27);
  expect(field).toHaveFocus(); expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(8);
  expect(field).toHaveValue("Original draft 日本語");
});

it("cancels a resized gesture before deferred geometry is published and retains the latest same-frame size", () => {
  const ui = harness(); ui.measure(1300, 600, 988);
  const separator = screen.getByRole("separator", { name: "Resize entry list" });
  const group = ui.group("list"), outer = group.element!;
  panePointer(separator, "pointerdown", 300);
  ui.resize(outer, 900, 600); ui.resize(outer, 1300, 600);
  ui.complete("list", 368);
  expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(288);
  panePointer(separator, "pointerup", 410);
  advanceFrame();
  expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(288);
  expect(ui.group("list").layout[ui.panelId("list")]).toBeCloseTo(288 / 1276 * 100);
});

it("does not record an already opened native disclosure as its collapsed reference height", () => {
  const ui = harness({ referencesOpen: false }); ui.measure(900, 600, 636);
  const references = ui.container.querySelector<HTMLDetailsElement>(".editor-references");
  if (!references) throw new Error("Expected the original reference disclosure");
  const referencePanel = () => library.panels.get(ui.panelId("references"))!;
  expect(referencePanel().minSize).toBe(52);
  // The DOM opens before its asynchronous toggle event updates React state.
  references.open = true;
  Object.defineProperty(references, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 0, 636, 1045) });
  ui.resize(references, 636, 1045); advanceFrame();
  expect(referencePanel().minSize).toBe(52);
  references.open = false;
  Object.defineProperty(references, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 0, 636, 88) });
  ui.resize(references, 636, 88); advanceFrame();
  expect(referencePanel().minSize).toBe(88);
});
