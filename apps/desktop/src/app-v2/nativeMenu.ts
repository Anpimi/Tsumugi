import type { WorkbenchCommandDescription } from "../workbenchCommands";
import type { TranslationKey } from "../i18n/types";
import { workspaceCommandIds, type WorkspaceCommandId } from "./workspace/workspaceCommands";

let menuOperations = Promise.resolve();

/** Native menus use the same live dispatcher as buttons, the palette and shortcuts. */
export function installWorkspaceMenu(commands: WorkbenchCommandDescription[], translate: (key: TranslationKey) => string, dispatch: (id: WorkspaceCommandId) => unknown, failed: () => void) {
  let disposed = false, close: (() => Promise<void>) | undefined;
  menuOperations = menuOperations.then(async () => {
    const { Menu, Submenu, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
    if (disposed) return;
    const items = commands.flatMap(command => {
      const id = workspaceCommandIds.find(value => value === command.id);
      return id ? [{ id, text: translate(command.nameKey), enabled: command.availability.enabled,
        ...(id === "workspace.close-window" && navigator.platform.includes("Mac") ? { accelerator: "Cmd+Q" } : {}),
        action: () => { if (!disposed) dispatch(id); } }] : [];
    });
    const submenu = await Submenu.new({ text: "Tsumugi", items });
    // WebKit's copy/paste and undo shortcuts depend on the native responder-chain menu.
    const editItems = await Promise.all((["Undo", "Redo", "Separator", "Cut", "Copy", "Paste", "SelectAll"] as const).map(item => PredefinedMenuItem.new({ item })));
    const edit = await Submenu.new({ text: translate("workbenchV2.editMenu"), items: editItems });
    const menu = await Menu.new({ items: [submenu, edit] });
    if (disposed) { await menu.close(); await submenu.close(); await edit.close(); await Promise.all(editItems.map(item => item.close())); return; }
    const previous = await menu.setAsAppMenu();
    close = async () => {
      if (previous) await previous.setAsAppMenu();
      await menu.close(); await submenu.close(); await edit.close();
      await Promise.all(editItems.map(item => item.close()));
    };
    if (disposed) { await close(); close = undefined; }
  }).catch(() => { if (!disposed) failed(); });
  return () => {
    disposed = true;
    // Restore the exact Host menu before installing the next view's callbacks.
    menuOperations = menuOperations.then(async () => { await close?.(); close = undefined; }).catch(failed);
  };
}
