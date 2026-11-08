import { afterEach, expect, it, vi } from "vitest";
import { exactPastePresentationDelayMs } from "../exactPaste";
import type { WorkbenchCommandDescription } from "../workbenchCommands";
import { installWorkspaceMenu } from "./nativeMenu";

const native = vi.hoisted(() => ({
  setAsAppMenu: vi.fn(async () => null),
  setSubmenuEnabled: vi.fn(async (_enabled: boolean) => undefined),
}));

vi.mock("@tauri-apps/api/menu", () => {
  const close = async () => undefined;
  class MenuItem {
    constructor(readonly id: string) {}
    close = close;
  }
  return {
    MenuItem,
    Menu: { new: async () => ({ close, setAsAppMenu: native.setAsAppMenu }) },
    Submenu: { new: async (options: { items: { id: string }[] }) => ({
      close, items: async () => options.items.map(item => new MenuItem(item.id)), setEnabled: native.setSubmenuEnabled,
    }) },
    PredefinedMenuItem: { new: async () => ({ close }) },
  };
});

function commands(enabled: boolean): WorkbenchCommandDescription[] {
  return [{
    id: "workspace.refresh", nameKey: "workbenchV2.refresh", category: "project",
    scope: { projectId: "project", sessionToken: "session", area: "translation" },
    binding: null, risk: "changes-view", confirmation: "none", availability: { enabled },
  }];
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("leaves the native submenu untouched for a paste that finishes within the delay", async () => {
  const failed = vi.fn();
  const menu = installWorkspaceMenu(key => key, vi.fn(), failed);
  try {
    menu.update(commands(true));
    await vi.waitFor(() => expect(native.setAsAppMenu).toHaveBeenCalledOnce());
    vi.useFakeTimers();

    menu.update(commands(false), true);
    await vi.advanceTimersByTimeAsync(exactPastePresentationDelayMs - 1);
    menu.update(commands(true));
    await vi.advanceTimersByTimeAsync(exactPastePresentationDelayMs);

    expect(native.setSubmenuEnabled).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  } finally { menu.dispose(); }
});

it("suspends a slow paste at its original deadline and applies unrelated suspensions immediately", async () => {
  const failed = vi.fn();
  const menu = installWorkspaceMenu(key => key, vi.fn(), failed);
  try {
    menu.update(commands(true));
    await vi.waitFor(() => expect(native.setAsAppMenu).toHaveBeenCalledOnce());
    vi.useFakeTimers();

    menu.update(commands(false), true);
    await vi.advanceTimersByTimeAsync(exactPastePresentationDelayMs - 1);
    expect(native.setSubmenuEnabled).not.toHaveBeenCalled();
    menu.update(commands(false), true);
    await vi.advanceTimersByTimeAsync(1);
    expect(native.setSubmenuEnabled.mock.calls).toEqual([[false]]);

    menu.update(commands(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(native.setSubmenuEnabled.mock.calls).toEqual([[false], [true]]);

    menu.update(commands(false), true);
    menu.update(commands(false));
    await vi.advanceTimersByTimeAsync(0);
    expect(native.setSubmenuEnabled.mock.calls).toEqual([[false], [true], [false]]);
    expect(failed).not.toHaveBeenCalled();
  } finally { menu.dispose(); }
});
