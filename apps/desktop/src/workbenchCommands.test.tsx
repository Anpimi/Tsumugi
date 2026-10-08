import { describe, expect, it, vi } from "vitest";
import { WorkbenchCommands } from "./workbenchCommands";

const scope = { projectId: "project-a", sessionToken: "session-a", area: "overview" as const };

describe("WorkbenchCommands", () => {
  it("dispatches only the live committed project, session, and area", () => {
    const commands = new WorkbenchCommands();
    const save = vi.fn();
    const register = (sessionToken: string) => commands.register({
      id: "project.metadata.save", nameKey: "editor.save", category: "project", binding: "Mod+S",
      risk: "writes-project", confirmation: "none", scope: { ...scope, sessionToken }, availability: () => ({ enabled: true }), handler: save,
    });
    const removeOld = register("session-a");
    expect(commands.dispatch("project.metadata.save", { ...scope, area: "translation" })).toBe(false);
    expect(commands.dispatch("project.metadata.save", { ...scope, projectId: "project-b" })).toBe(false);
    expect(commands.dispatch("project.metadata.save", scope)).toBe(true);

    const removeNew = register("session-b");
    removeOld();
    expect(commands.dispatch("project.metadata.save", scope)).toBe(false);
    expect(commands.dispatch("project.metadata.save", { ...scope, sessionToken: "session-b" })).toBe(true);
    removeNew();
    expect(commands.dispatch("project.metadata.save", { ...scope, sessionToken: "session-b" })).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("rechecks availability at dispatch, including while an earlier action is pending", () => {
    const commands = new WorkbenchCommands();
    const save = vi.fn();
    let pending = false;
    commands.register({
      id: "project.metadata.save", nameKey: "editor.save", category: "project", binding: "Mod+S",
      risk: "writes-project", confirmation: "none", scope, availability: () => pending
        ? { enabled: false, reason: "pending-action" }
        : { enabled: true }, handler: save,
    });
    expect(commands.dispatch("project.metadata.save", scope)).toBe(true);
    pending = true;
    expect(commands.list(scope)).toEqual([expect.objectContaining({ id: "project.metadata.save",
      confirmation: "none", availability: { enabled: false, reason: "pending-action" } })]);
    expect(commands.dispatch("project.metadata.save", scope)).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
