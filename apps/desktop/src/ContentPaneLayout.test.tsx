import { createRef, useImperativeHandle, useRef, type ComponentProps, type Ref } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContentPaneLayout, useContentPaneIntent, type ContentPaneLayoutHandle } from "./ContentPaneLayout";
import { WorkspaceViewMemory, WorkspaceViewProvider } from "./WorkbenchFrame";
import { controlContentPaneGeometry, panePointer, pointerCaptureFor } from "./testSupport/contentPaneGeometry";
import { i18n } from "./i18n";

const noop = () => {};
type TestHandle = ContentPaneLayoutHandle & { captureEditorReveal: () => () => void };
function Content({ handle, composing = false, active = true, referencesOpen = true }: {
  handle: Ref<TestHandle>; composing?: boolean; active?: boolean; referencesOpen?: boolean;
}) {
  const field = useRef<HTMLTextAreaElement>(null), layout = useRef<ContentPaneLayoutHandle>(null), intent = useContentPaneIntent();
  useImperativeHandle(handle, () => ({ captureEditorReveal: intent.captureEditorReveal,
    editorVisible: () => layout.current?.editorVisible() ?? false, focusVisible: () => layout.current?.focusVisible() }));
  return <ContentPaneLayout ref={layout} intent={intent} active={active} composing={composing} referencesOpen={referencesOpen} hasEditor editorFocus={field} onEditorVisibilityChange={noop}
    list={<div className="translation-entry-list"><button className="translation-entry">Earlier entry</button><button className="translation-entry" aria-current="true">Selected entry</button></div>}
    editor={<div className="translation-editor"><textarea aria-label="Kept draft" defaultValue="Original draft 日本語" ref={field} /></div>}
    references={<details className="editor-references" open={referencesOpen}><summary>References</summary><p>Original reference</p></details>} />;
}
function harness(overrides: Partial<ComponentProps<typeof Content>> = {}) {
  const memory = new WorkspaceViewMemory(), handle = createRef<TestHandle>(), resize = controlContentPaneGeometry();
  const tree = (visible = true, props = overrides) => <><button>Outside layout</button><WorkspaceViewProvider value={{ area: "translation", memory, activate: noop, deactivate: noop }}>
    {visible ? <Content handle={handle} {...props} /> : null}</WorkspaceViewProvider></>;
  const rendered = render(tree());
  const columns = () => rendered.container.querySelector<HTMLDivElement>(".translation-columns")!;
  return { ...rendered, memory, handle, tree, measure: (width: number, height = 600) => resize(columns(), width, height) };
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["en-US", "zh-CN"])("exposes keyboard-operable boundaries with accurate values in %s", async locale => {
  await i18n.changeLanguage(locale);
  const ui = harness(); ui.measure(1300);
  const list = screen.getByRole("separator", { name: i18n.t("contentPaneLayout.resizeList") });
  const references = screen.getByRole("separator", { name: i18n.t("contentPaneLayout.resizeReferenceWidth") });
  expect(list).toHaveAttribute("aria-orientation", "vertical");
  expect(document.getElementById(list.getAttribute("aria-controls")!)).toBeInTheDocument();
  expect(list).toHaveAttribute("aria-valuenow", "288");
  fireEvent.keyDown(list, { key: "ArrowRight" }); expect(list).toHaveAttribute("aria-valuenow", "298");
  fireEvent.keyDown(list, { key: "ArrowLeft", shiftKey: true }); expect(list).toHaveAttribute("aria-valuenow", "258");
  fireEvent.keyDown(list, { key: "End" }); expect(list).toHaveAttribute("aria-valuenow", "400");
  fireEvent.keyDown(list, { key: "Home" }); expect(list).toHaveAttribute("aria-valuenow", "200");
  fireEvent.keyDown(list, { key: "ArrowRight", ctrlKey: true }); expect(list).toHaveAttribute("aria-valuenow", "200");
  fireEvent.keyDown(references, { key: "ArrowLeft" }); expect(references).toHaveAttribute("aria-valuenow", "298");
  fireEvent.keyDown(references, { key: "Home" }); expect(references).toHaveAttribute("aria-valuenow", "200");
  expect(references).toHaveAttribute("aria-valuetext", i18n.t("contentPaneLayout.pixels", { value: "200" }));
  expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(200);
});

it("keeps separate mode preferences, clamps the rendered width and restores the wider preference", async () => {
  const ui = harness(), user = userEvent.setup(); ui.measure(1300);
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize entry list" }), { key: "End" });
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize reference width" }), { key: "End" });
  ui.measure(900);
  const compactList = screen.getByRole("separator", { name: "Resize entry list" }), compactReferences = screen.getByRole("separator", { name: "Resize reference height" });
  expect(compactList).toHaveAttribute("aria-valuenow", "240");
  expect(compactReferences).toHaveAttribute("aria-orientation", "horizontal");
  fireEvent.keyDown(compactList, { key: "ArrowRight" });
  fireEvent.keyDown(compactReferences, { key: "ArrowUp" });
  expect(compactReferences).toHaveAttribute("aria-valuenow", "160");
  ui.measure(600); await user.click(screen.getByRole("button", { name: "Current entry" }));
  const narrowReferences = screen.getByRole("separator", { name: "Resize reference height" });
  expect(narrowReferences).toHaveAttribute("aria-valuenow", "150");
  fireEvent.keyDown(narrowReferences, { key: "ArrowUp", shiftKey: true });
  expect(narrowReferences).toHaveAttribute("aria-valuenow", "190");
  ui.measure(1100);
  expect(screen.getByRole("separator", { name: "Resize entry list" })).toHaveAttribute("aria-valuenow", "400");
  expect(screen.getByRole("separator", { name: "Resize reference width" })).toHaveAttribute("aria-valuenow", "292");
  expect(ui.memory.read("translation", "paneLayout.wide.referenceWidth")).toBe(400);
  ui.measure(1300);
  expect(screen.getByRole("separator", { name: "Resize reference width" })).toHaveAttribute("aria-valuenow", "400");
  ui.measure(900);
  expect(screen.getByRole("separator", { name: "Resize entry list" })).toHaveAttribute("aria-valuenow", "250");
  expect(screen.getByRole("separator", { name: "Resize reference height" })).toHaveAttribute("aria-valuenow", "160");
});

it("previews a captured pointer drag and commits its preference only on pointerup", () => {
  const ui = harness(); ui.measure(1300);
  const field = screen.getByRole("textbox", { name: "Kept draft" }), separator = screen.getByRole("separator", { name: "Resize entry list" });
  const capture = pointerCaptureFor(separator);
  panePointer(separator, "pointerdown", 300);
  panePointer(separator, "pointermove", 350);
  expect(capture.set).toHaveBeenCalledExactlyOnceWith(1);
  expect(separator).toHaveAttribute("aria-valuenow", "338");
  expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(288);
  panePointer(separator, "pointerup", 350);
  expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(338);
  expect(capture.release).toHaveBeenCalledExactlyOnceWith(1);
  panePointer(separator, "lostpointercapture", 350);
  expect(screen.getByRole("textbox", { name: "Kept draft" })).toBe(field);
  expect(separator).toHaveAttribute("aria-valuenow", "338");
});

it.each(["pointercancel", "lostpointercapture", "resize", "unmount"])("rolls back temporary geometry on %s and releases the captured pointer", reason => {
  const ui = harness(); ui.measure(1300);
  const separator = screen.getByRole("separator", { name: "Resize entry list" }), capture = pointerCaptureFor(separator);
  panePointer(separator, "pointerdown", 300); panePointer(separator, "pointermove", 380);
  expect(separator).toHaveAttribute("aria-valuenow", "368");
  if (reason === "resize") ui.measure(1200);
  else if (reason === "unmount") ui.rerender(ui.tree(false));
  else panePointer(separator, reason, 380);
  expect(ui.memory.read("translation", "paneLayout.wide.listWidth")).toBe(288);
  expect(capture.release).toHaveBeenCalledExactlyOnceWith(1);
  if (reason !== "unmount") expect(separator).toHaveAttribute("aria-valuenow", "288");
});

it("finishes the reference boundary at the released position without replacing another captured pointer", () => {
  const ui = harness(); ui.measure(900);
  const separator = screen.getByRole("separator", { name: "Resize reference height" }), capture = pointerCaptureFor(separator);
  panePointer(separator, "pointerdown", 0, 400);
  panePointer(separator, "pointermove", 0, 380);
  panePointer(separator, "pointerdown", 0, 300, 2);
  panePointer(separator, "pointerup", 0, 200, 2);
  expect(capture.set).toHaveBeenCalledExactlyOnceWith(1);
  expect(separator).toHaveAttribute("aria-valuenow", "170");
  panePointer(separator, "pointerup", 0, 350);
  expect(separator).toHaveAttribute("aria-valuenow", "200");
  expect(ui.memory.read("translation", "paneLayout.compact.referenceHeight")).toBe(200);
  expect(capture.release).toHaveBeenCalledExactlyOnceWith(1);
});

it("retains geometry through consumer remount and ignores zero measurements from hidden containers", () => {
  const ui = harness(); ui.measure(1300);
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize entry list" }), { key: "End" });
  ui.measure(0, 0);
  expect(screen.getByRole("separator", { name: "Resize entry list" })).toHaveAttribute("aria-valuenow", "400");
  ui.rerender(ui.tree(false)); ui.rerender(ui.tree()); ui.measure(1300);
  expect(screen.getByRole("separator", { name: "Resize entry list" })).toHaveAttribute("aria-valuenow", "400");
});

it("keeps one editor node and its selection while switching modes and rehomes hidden focus", async () => {
  const ui = harness(), user = userEvent.setup(); ui.measure(1300);
  const field = screen.getByRole("textbox", { name: "Kept draft" }) as HTMLTextAreaElement;
  field.focus(); field.setSelectionRange(2, 8);
  ui.measure(600);
  expect(screen.getByRole("button", { name: "Selected entry" })).toHaveFocus();
  expect(field).not.toBeVisible();
  await user.click(screen.getByRole("button", { name: "Current entry" }));
  expect(screen.getByRole("textbox", { name: "Kept draft" })).toBe(field);
  expect(field).toHaveFocus(); expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(8);
  expect(field).toHaveValue("Original draft 日本語");
  ui.measure(900);
  expect(screen.getByRole("textbox", { name: "Kept draft" })).toBe(field);
});

it("keeps composition visible when narrowing and rejects pane switches and boundary input", () => {
  const ui = harness({ composing: true }); ui.measure(1300);
  const separator = screen.getByRole("separator", { name: "Resize entry list" }), capture = pointerCaptureFor(separator);
  fireEvent.keyDown(separator, { key: "ArrowRight" }); panePointer(separator, "pointerdown", 300); panePointer(separator, "pointermove", 380);
  expect(capture.set).not.toHaveBeenCalled(); expect(separator).toHaveAttribute("aria-valuenow", "288");
  const field = screen.getByRole("textbox", { name: "Kept draft" }); ui.measure(500);
  expect(field).toBeVisible(); expect(screen.getByRole("button", { name: "Entries" })).toBeDisabled();
  ui.rerender(ui.tree(true, { composing: false })); expect(field).toBeVisible();
});

it("honors a later list choice over an asynchronous reveal and consumes same-pane reveals without later focus theft", async () => {
  const ui = harness(), user = userEvent.setup(); ui.measure(600);
  const stale = ui.handle.current!.captureEditorReveal();
  await user.click(screen.getByRole("button", { name: "Entries" }));
  act(() => stale());
  expect(screen.getByRole("button", { name: "Entries" })).toHaveAttribute("aria-pressed", "true");
  const current = ui.handle.current!.captureEditorReveal(); act(() => current());
  const field = screen.getByRole("textbox", { name: "Kept draft" }); expect(field).toBeVisible();
  act(() => ui.handle.current!.captureEditorReveal()());
  const outside = screen.getByRole("button", { name: "Outside layout" }); outside.focus();
  ui.measure(900); expect(outside).toHaveFocus();
  expect(screen.getByRole("textbox", { name: "Kept draft" })).toBe(field);
});
