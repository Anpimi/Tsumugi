import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDesktopBehavior } from "./desktopBehavior";

let removeBehavior: () => void;
beforeEach(() => { removeBehavior = installDesktopBehavior(); });
afterEach(() => { removeBehavior(); document.body.replaceChildren(); });

function shortcut(key: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

it.each([
  ["r", { ctrlKey: true }], ["R", { ctrlKey: true, shiftKey: true }],
  ["F5", {}], ["F5", { ctrlKey: true }], ["p", { ctrlKey: true }],
  ["u", { ctrlKey: true }], ["s", { ctrlKey: true }],
  ["ArrowLeft", { altKey: true }], ["ArrowRight", { altKey: true }],
  ["BrowserBack", {}], ["BrowserForward", {}],
] as const)("prevents the browser default for %s without clearing an editor draft", (key, modifiers) => {
  const editor = document.createElement("textarea");
  editor.value = "Uncommitted translation";
  document.body.append(editor);
  expect(shortcut(key, modifiers, editor).defaultPrevented).toBe(true);
  expect(editor.value).toBe("Uncommitted translation");
});

it("still delivers Ctrl+S to the editor's save handler", () => {
  const editor = document.createElement("textarea");
  document.body.append(editor);
  const save = vi.fn();
  editor.addEventListener("keydown", save);
  expect(shortcut("s", { ctrlKey: true }, editor).defaultPrevented).toBe(true);
  expect(save).toHaveBeenCalledOnce();
});

it.each(["c", "v", "x", "a", "z", "y", "+", "-", "0"])("preserves editing or accessibility shortcut Ctrl+%s", key => {
  expect(shortcut(key, { ctrlKey: true }).defaultPrevented).toBe(false);
});

it("does not intercept composition, AltGr input, Tab or Escape", () => {
  expect(shortcut("r", { ctrlKey: true, isComposing: true }).defaultPrevented).toBe(false);
  expect(shortcut("s", { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
  expect(shortcut("Tab").defaultPrevented).toBe(false);
  expect(shortcut("Escape").defaultPrevented).toBe(false);
});

it("suppresses the page menu while retaining native input and textarea menus", () => {
  for (const tag of ["div", "button", "input", "textarea"]) {
    const target = document.createElement(tag);
    document.body.append(target);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(tag === "div" || tag === "button");
  }
});

it("releases its listeners when disposed", () => {
  removeBehavior();
  expect(shortcut("r", { ctrlKey: true }).defaultPrevented).toBe(false);
});
