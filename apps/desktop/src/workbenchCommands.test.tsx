import { describe, expect, it, vi } from "vitest";
import { WorkbenchCommands, type ReviewWaiverCommandPayload } from "./workbenchCommands";

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

  it("describes and dispatches an exact typed target without choosing an implicit issue", () => {
    const commands = new WorkbenchCommands(), grant = vi.fn();
    const payload: ReviewWaiverCommandPayload = { kind: "review-waiver", unitId: "unit-a", locale: "zh-CN",
      basis: "basis-a", issueId: "issue-b", expectedWaiverId: null };
    let liveBasis = payload.basis;
    commands.register({
      id: "review.grant-waiver", nameKey: "review.waive", category: "review", binding: null,
      risk: "writes-review", confirmation: "none", scope, payloadKind: "review-waiver",
      availability: input => input?.unitId === payload.unitId && input.issueId === payload.issueId && input.basis === liveBasis
        ? { enabled: true } : { enabled: false, reason: "unavailable" }, handler: grant,
    });
    expect(commands.list(scope)[0]).toMatchObject({ payloadKind: "review-waiver", availability: { enabled: false, reason: "unavailable" } });
    expect(commands.describe("review.grant-waiver", scope, payload)?.availability).toEqual({ enabled: true });
    expect(commands.describe("review.grant-waiver", { ...scope, sessionToken: "session-b" }, payload)).toBeUndefined();
    expect(commands.dispatch("review.grant-waiver", { ...scope, area: "review" }, payload)).toBe(false);
    expect(Reflect.apply(commands.dispatch, commands, ["review.grant-waiver", scope])).toBe(false);
    expect(Reflect.apply(commands.dispatch, commands, ["review.grant-waiver", scope, { ...payload, expectedWaiverId: undefined }])).toBe(false);
    expect(Reflect.apply(commands.dispatch, commands, ["review.grant-waiver", scope, { ...payload, kind: "review-fallback" }])).toBe(false);
    expect(commands.dispatch("review.grant-waiver", scope, { ...payload, issueId: "issue-a" })).toBe(false);
    expect(commands.dispatch("review.grant-waiver", scope, payload)).toBe(true);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledWith(payload);
    liveBasis = "basis-b";
    expect(commands.describe("review.grant-waiver", scope, payload)?.availability).toEqual({ enabled: false, reason: "unavailable" });
    expect(commands.dispatch("review.grant-waiver", scope, payload)).toBe(false);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed fallback input and preserves registration cleanup for parameterized commands", () => {
    const commands = new WorkbenchCommands(), fallback = vi.fn();
    const register = (sessionToken: string) => commands.register({
      id: "review.withdraw-fallback", nameKey: "review.withdrawFallback", category: "review", binding: null,
      risk: "writes-review", confirmation: "none", scope: { ...scope, sessionToken }, payloadKind: "review-fallback",
      availability: () => ({ enabled: true }), handler: fallback,
    });
    const payload = { kind: "review-fallback" as const, unitId: "unit-a", locale: "zh-CN", basis: "basis-a", expectedFallbackId: "fallback-a" };
    const removeOld = register("session-a"), removeNew = register("session-b");
    removeOld();
    const currentScope = { ...scope, sessionToken: "session-b" };
    expect(commands.list(currentScope)[0].availability).toEqual({ enabled: false, reason: "unavailable" });
    expect(commands.dispatch("review.withdraw-fallback", scope, payload)).toBe(false);
    expect(Reflect.apply(commands.dispatch, commands, ["review.withdraw-fallback", currentScope, { ...payload, unitId: 4 }])).toBe(false);
    expect(Reflect.apply(commands.dispatch, commands, ["review.withdraw-fallback", currentScope, { ...payload, expectedFallbackId: undefined }])).toBe(false);
    expect(commands.dispatch("review.withdraw-fallback", currentScope, payload)).toBe(true);
    removeNew();
    expect(commands.dispatch("review.withdraw-fallback", currentScope, payload)).toBe(false);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(payload);
  });
});
