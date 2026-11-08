import type { Menu, MenuItem, Submenu } from "@tauri-apps/api/menu";
import type { WorkbenchCommandDescription } from "../workbenchCommands";
import type { TranslationKey } from "../i18n/types";
import { workspaceCommandIds, type WorkspaceCommandId } from "./workspace/workspaceCommands";

type MenuRow = { id: WorkspaceCommandId; text: string; enabled: boolean };
type MenuResource = { close(): Promise<void> };
type InstalledMenu = { rows: MenuRow[]; items: MenuItem[]; submenu: Submenu; enabled: boolean; close(): Promise<void> };

let menuOperations = Promise.resolve();

async function settleAll<T>(operations: Promise<T>[]): Promise<T[]> {
  // Finish every operation before a later refresh or cleanup touches the same handles.
  return (await Promise.allSettled(operations)).map(result => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

/** Native menu presentation follows the live dispatcher without disturbing the Edit responder chain on input changes. */
export function installWorkspaceMenu(translate: (key: TranslationKey) => string, dispatch: (id: WorkspaceCommandId) => unknown, failed: () => void) {
  let disposed = false, scheduled = false;
  let desired: MenuRow[] = [];
  let installed: InstalledMenu | undefined;

  async function mount(rows: MenuRow[]): Promise<InstalledMenu | undefined> {
    const { Menu, MenuItem, Submenu, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
    if (disposed) return;
    const resources: MenuResource[] = [];
    async function retain<T extends MenuResource>(operation: Promise<T>) {
      const resource = await operation;
      resources.push(resource);
      return resource;
    }
    let previous: Menu | null = null, mounted = false;
    async function close() {
      mounted = false;
      try {
        if (previous) {
          const replaced = await previous.setAsAppMenu();
          if (replaced) resources.push(replaced);
        }
      } finally {
        await settleAll(resources.map(resource => resource.close()));
      }
    }

    try {
      const enabled = rows.length === 0 || rows.some(row => row.enabled);
      const submenu = await retain(Submenu.new({ text: "Tsumugi", enabled, items: rows.map(({ id, text, enabled }) => ({
        id, text, enabled,
        ...(id === "workspace.close-window" && navigator.platform.includes("Mac") ? { accelerator: "Cmd+Q" } : {}),
        action: () => { if (mounted && !disposed) dispatch(id); },
      })) }));
      const handles = await submenu.items();
      resources.push(...handles);
      const items = handles.filter(item => item instanceof MenuItem);
      if (items.length !== rows.length || items.some((item, index) => item.id !== rows[index].id)) throw new Error("Unexpected workspace menu items");

      // WebKit's copy/paste and undo shortcuts depend on the native responder-chain menu.
      const editItems = await settleAll((["Undo", "Redo", "Separator", "Cut", "Copy", "Paste", "SelectAll"] as const)
        .map(item => retain(PredefinedMenuItem.new({ item }))));
      const edit = await retain(Submenu.new({ text: translate("workbenchV2.editMenu"), items: editItems }));
      const menu = await retain(Menu.new({ items: [submenu, edit] }));
      if (disposed) return;
      previous = await menu.setAsAppMenu();
      if (previous) resources.push(previous);
      mounted = true;
      return { rows, items, submenu, enabled, close };
    } finally {
      if (!mounted) await close();
    }
  }

  function update(commands: WorkbenchCommandDescription[]) {
    if (disposed) return;
    desired = commands.flatMap(command => {
      const id = workspaceCommandIds.find(value => value === command.id);
      return id ? [{ id, text: translate(command.nameKey), enabled: command.availability.enabled }] : [];
    });
    if (scheduled) return;
    scheduled = true;
    menuOperations = menuOperations.then(async () => {
      scheduled = false;
      if (disposed) return;
      const rows = desired, menu = installed;
      if (!menu || menu.rows.length !== rows.length || menu.rows.some((row, index) => row.id !== rows[index].id || row.text !== rows[index].text)) {
        installed = undefined;
        await menu?.close();
        installed = await mount(rows);
        return;
      }
      const enabled = rows.length === 0 || rows.some(row => row.enabled);
      // A transient gate can disable every command at once. Keep the item states
      // and the Edit menu intact while suspending the workspace submenu.
      if (enabled) await settleAll(rows.flatMap(({ enabled }, index) => {
        const previous = menu.rows[index];
        if (enabled === previous.enabled) return [];
        return [menu.items[index].setEnabled(enabled).then(() => { previous.enabled = enabled; })];
      }));
      if (enabled !== menu.enabled) {
        await menu.submenu.setEnabled(enabled);
        menu.enabled = enabled;
      }
    }).catch(() => { if (!disposed) failed(); });
  }

  return { update, dispose: () => {
    if (disposed) return;
    disposed = true;
    menuOperations = menuOperations.then(async () => { await installed?.close(); installed = undefined; }).catch(failed);
  } };
}
