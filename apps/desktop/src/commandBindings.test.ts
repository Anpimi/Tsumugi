import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBindings, COMMAND_BINDINGS_STORAGE_KEY, workspaceCommandCatalog, type BindingEntry } from "./commandBindings";
import { WorkbenchCommands, type CommandScope } from "./workbenchCommands";
import { i18n } from "./i18n";

beforeEach(() => { localStorage.removeItem(COMMAND_BINDINGS_STORAGE_KEY); });
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(COMMAND_BINDINGS_STORAGE_KEY); });

describe("application command bindings", () => {
  it("normalizes modifier order, case and comma, and reopens with the saved choices", () => {
    const bindings = new CommandBindings(workspaceCommandCatalog);
    expect(bindings.resolve("workspace.settings", "Mod+,")).toBe("Mod+,");
    expect(bindings.set("workspace.settings", " shift + ALT + moD + p ")).toEqual({ kind: "saved" });
    expect(bindings.resolve("workspace.settings", "Mod+,")).toBe("Mod+Shift+Alt+P");
    expect(new CommandBindings(workspaceCommandCatalog).resolve("workspace.settings", "Mod+,")).toBe("Mod+Shift+Alt+P");
    expect(bindings.set("workspace.settings", " mod + , ")).toEqual({ kind: "saved" });
    expect(bindings.resolve("workspace.settings", "Mod+,")).toBe("Mod+,");
    expect(JSON.parse(localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY)!)).toEqual({});
    expect(new CommandBindings(workspaceCommandCatalog).getSnapshot().problem).toBeNull();
  });

  it("persists an explicit unbound command and restores its default only on reset", () => {
    const bindings = new CommandBindings(workspaceCommandCatalog);
    expect(bindings.set("workspace.open-project", "  ")).toEqual({ kind: "saved" });
    const reopened = new CommandBindings(workspaceCommandCatalog);
    expect(reopened.resolve("workspace.open-project", "Mod+O")).toBeNull();
    expect(reopened.resolve("workspace.extensions", null)).toBeNull();
    expect(reopened.reset()).toEqual({ kind: "saved" });
    expect(reopened.resolve("workspace.open-project", "Mod+O")).toBe("Mod+O");
  });

  it.each(["Mod+A", "mod+c", "Mod+X", "Mod+V", "Shift+Mod+V", "Mod+Z", "Mod+Shift+Z", "Mod+Y", "Mod+Q", "Alt+F4"])("keeps the editing or system shortcut %s reserved", input => {
    const bindings = new CommandBindings(workspaceCommandCatalog);
    expect(bindings.set("workspace.open-project", input)).toEqual({ kind: "reserved" });
    expect(bindings.resolve("workspace.open-project", "Mod+O")).toBe("Mod+O");
    expect(localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY)).toBeNull();
  });

  it.each(["P", "Ctrl+P", "Mod+Mod+P", "Mod+", "Mod+Delete", "Shift+,"])("rejects unsupported binding %s without changing the current one", input => {
    const bindings = new CommandBindings(workspaceCommandCatalog);
    expect(bindings.set("workspace.open-project", "Mod+Alt+P")).toEqual({ kind: "saved" });
    const saved = localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY);
    expect(bindings.set("workspace.open-project", input)).toEqual({ kind: "invalid" });
    expect(bindings.resolve("workspace.open-project", "Mod+O")).toBe("Mod+Alt+P");
    expect(localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY)).toBe(saved);
  });

  it.each([
    { locale: "en-US", name: "Open project" },
    { locale: "zh-CN", name: "打开项目" },
  ])("reports the real conflicting command in $locale and preserves both existing bindings", async copy => {
    await i18n.changeLanguage(copy.locale);
    const bindings = new CommandBindings(workspaceCommandCatalog);
    expect(bindings.set("workspace.open-project", "Mod+Alt+P")).toEqual({ kind: "saved" });
    const saved = localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY);
    const result = bindings.set("workspace.commands", "mod+alt+p");
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") throw new Error("Expected a conflicting command");
    expect(result.command.id).toBe("workspace.open-project");
    expect(i18n.t(result.command.nameKey)).toBe(copy.name);
    expect(bindings.resolve("workspace.open-project", "Mod+O")).toBe("Mod+Alt+P");
    expect(bindings.resolve("workspace.commands", "Mod+K")).toBe("Mod+K");
    expect(localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY)).toBe(saved);
  });

  it("keeps the last effective and persisted choices when a write or reset fails", () => {
    const bindings = new CommandBindings(workspaceCommandCatalog);
    expect(bindings.set("workspace.open-project", "Mod+Alt+P")).toEqual({ kind: "saved" });
    const saved = localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Synthetic storage unavailable"); });
    expect(bindings.set("workspace.open-project", "Mod+Alt+R")).toEqual({ kind: "storage" });
    expect(bindings.reset()).toEqual({ kind: "storage" });
    expect(bindings.getSnapshot().problem).toBe("storage");
    expect(bindings.resolve("workspace.open-project", "Mod+O")).toBe("Mod+Alt+P");
    expect(localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY)).toBe(saved);
    write.mockRestore();
    expect(new CommandBindings(workspaceCommandCatalog).resolve("workspace.open-project", "Mod+O")).toBe("Mod+Alt+P");
    expect(bindings.set("workspace.open-project", "Mod+Alt+R")).toEqual({ kind: "saved" });
    expect(bindings.getSnapshot().problem).toBeNull();
  });

  it("reports an unreadable preference store separately and keeps defaults usable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Synthetic storage unavailable"); });
    const bindings = new CommandBindings(workspaceCommandCatalog);
    expect(bindings.getSnapshot().problem).toBe("storage");
    expect(bindings.resolve("workspace.open-project", "Mod+O")).toBe("Mod+O");
    expect(bindings.resolve("workspace.settings", "Mod+,")).toBe("Mod+,");
  });

  it.each([
    "not-json", "null", "[]", '{"workspace.open-project":42}', '{"workspace.open-project":"mod+p"}',
    '{"workspace.open-project":"Mod+K"}', '{"workspace.open-project":"Mod+C"}',
    '{"workspace.open-project":"Mod+Alt+P","unknown-command":null}',
  ])("rejects invalid or conflicting persisted preferences atomically: %s", raw => {
    localStorage.setItem(COMMAND_BINDINGS_STORAGE_KEY, raw);
    const bindings = new CommandBindings(workspaceCommandCatalog);
    expect(bindings.getSnapshot().problem).toBe("invalid");
    expect(bindings.resolve("workspace.open-project", "Mod+O")).toBe("Mod+O");
    expect(bindings.resolve("workspace.commands", "Mod+K")).toBe("Mod+K");
    expect(localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY)).toBe(raw);
  });

  it("resolves all registry descriptions through the supplied owner without weakening handler availability", () => {
    const catalog: readonly BindingEntry[] = [{ id: "project.metadata.save", nameKey: "editor.save", binding: "Mod+S" }];
    const bindings = new CommandBindings(catalog), commands = new WorkbenchCommands(bindings), save = vi.fn();
    const scope: CommandScope = { projectId: "synthetic-project", sessionToken: "synthetic-session", area: "overview" };
    let available = true;
    commands.register({ ...catalog[0], id: "project.metadata.save", category: "project", scope, risk: "writes-project", confirmation: "none", availability: () => ({ enabled: available }), handler: save });
    expect(bindings.set("project.metadata.save", "Mod+Alt+S")).toEqual({ kind: "saved" });
    expect(commands.describe("project.metadata.save", scope)?.binding).toBe("Mod+Alt+S");
    expect(commands.list(scope)[0].binding).toBe("Mod+Alt+S");
    expect(commands.dispatch("project.metadata.save", scope)).toBe(true);
    available = false;
    expect(commands.describe("project.metadata.save", scope)?.availability.enabled).toBe(false);
    expect(commands.dispatch("project.metadata.save", scope)).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
