import { describe, expect, it, vi } from "vitest";
import { WorkbenchCommands, type ReviewWaiverCommandPayload, type WorkbenchCommand } from "./workbenchCommands";

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


describe("resource command payloads", () => {
  const resourceScope = { ...scope, area: "resources" as const };
  const metadata = { nameKey: "resource.save" as const, category: "resources" as const, scope: resourceScope,
    binding: null, risk: "writes-resources" as const, confirmation: "none" as const };
  it.each([
    ["resource.save-term", { kind: "resource-term", locale: "zh-CN", termId: null, expectedRevisionId: null, editSeq: 0 }, [{ editSeq: -1 }, { editSeq: 1.5 }, { termId: undefined }, { expectedRevisionId: "" }]],
    ["resource.save-context", { kind: "resource-context", locale: "zh-CN", unitId: "unit", sourceRevisionId: "source", expectedRevisionId: null, editSeq: 1 }, [{ sourceRevisionId: 7 }, { unitId: "" }, { expectedRevisionId: undefined }]],
    ["resource.capture-context", { kind: "resource-context", locale: "zh-CN", unitId: "unit", sourceRevisionId: "source", expectedRevisionId: null, editSeq: 1 }, [{ editSeq: NaN }, { locale: "" }]],
    ["resource.choose-file", { kind: "resource-locale", locale: "zh-CN" }, [{ locale: [] }]],
    ["resource.open-preview", { kind: "resource-capture", captureId: "capture", digest: "digest", locale: "zh-CN" }, [{ captureId: "" }, { digest: null }]],
    ["resource.refresh-preview", { kind: "resource-capture", captureId: "capture", digest: "digest", locale: "zh-CN" }, [{ locale: false }]],
    ["resource.decide-entry", { kind: "resource-decision", captureId: "capture", digest: "digest", locale: "zh-CN", entryId: "entry", expectedRevisionId: null, decision: "keep", rowKind: "added", scopeUnitId: null }, [{ decision: "delete" }, { rowKind: "missing" }, { expectedRevisionId: undefined }, { scopeUnitId: undefined }]],
    ["resource.retry-pending", { kind: "resource-pending", pendingKind: "term", actionId: "action" }, [{ pendingKind: "picker" }, { actionId: "" }]],
    ["resource.open-translation", { kind: "resource-translation", locale: "zh-CN", target: { unitId: "unit", sourceRevisionId: "source", key: "key", sourceText: "" }, evidenceKind: "tm", evidenceId: "revision", selectionId: null }, [{ target: null }, { target: { unitId: "unit" } }, { evidenceKind: "impact", selectionId: null }, { evidenceKind: "tm", selectionId: "selection" }]],
  ] as const)("validates %s before invoking its live handler", (id, payload, malformed) => {
    const commands = new WorkbenchCommands(), handler = vi.fn();
    let enabled = true;
    const remove = commands.register({ ...metadata, id, payloadKind: payload.kind,
      availability: () => ({ enabled }), handler } as WorkbenchCommand);
    const dispatch = (value?: unknown, target = resourceScope) => Reflect.apply(commands.dispatch, commands, [id, target, value]);
    expect(dispatch()).toBe(false); expect(dispatch(null)).toBe(false); expect(dispatch({ ...payload, kind: "unknown" })).toBe(false);
    malformed.forEach(change => expect(dispatch({ ...payload, ...change })).toBe(false));
    expect(dispatch(payload, { ...resourceScope, projectId: "other" })).toBe(false);
    expect(dispatch(payload, { ...resourceScope, sessionToken: "other" })).toBe(false);
    expect(Reflect.apply(commands.dispatch, commands, [id, { ...resourceScope, area: "review" }, payload])).toBe(false);
    expect(handler).not.toHaveBeenCalled(); expect(dispatch(payload)).toBe(true); expect(handler).toHaveBeenCalledWith(payload);
    enabled = false; expect(dispatch(payload)).toBe(false); expect(handler).toHaveBeenCalledTimes(1);
    remove(); expect(dispatch(payload)).toBe(false);
  });
});

describe("source command payloads", () => {
  const sourceScope = { ...scope, area: "source" as const };
  const metadata = { nameKey: "source.search" as const, category: "source" as const, scope: sourceScope,
    binding: null, risk: "reads-source" as const, confirmation: "none" as const };
  it.each([
    ["source.select", { kind: "source-selection", domain: "webvtt", integrationId: "webvtt", version: "0.1.0" }, [{ domain: null }, { version: "" }]],
    ["source.preflight", { kind: "source-capture", selectionId: "selection", sourceLanguage: "en" }, [{ selectionId: undefined }, { sourceLanguage: false }]],
    ["source.start", { kind: "source-capture", selectionId: "selection", sourceLanguage: "en" }, [{ sourceLanguage: [] }]],
    ["source.apply", { kind: "source-basis", attemptId: "attempt", resultId: "result", revision: "1", currentSnapshot: null, base: null, editSeq: 0 }, [{ revision: 1 }, { currentSnapshot: undefined }, { editSeq: 1.5 }]],
    ["source.estimate", { kind: "source-basis", attemptId: "attempt", resultId: "result", revision: "1", currentSnapshot: "snapshot", base: "base", editSeq: 1 }, [{ base: "" }, { editSeq: -1 }]],
    ["source.search-comparison", { kind: "source-comparison", attemptId: "attempt", resultId: "result", revision: "1", currentSnapshot: "snapshot", originalBase: "base", base: "base", filter: "A", after: 1, editSeq: 1 }, [{ filter: [] }, { after: -1 }, { originalBase: null }]],
    ["source.refresh-comparison", { kind: "source-comparison", attemptId: "attempt", resultId: "result", revision: "1", currentSnapshot: "snapshot", originalBase: "base", base: null, filter: "", after: 0, editSeq: 1 }, [{ base: undefined }]],
    ["source.retry-start", { kind: "source-pending", pendingKind: "start", attemptId: "attempt", actionId: null }, [{ actionId: "action" }, { pendingKind: "other" }]],
    ["source.check-receipt", { kind: "source-pending", pendingKind: "apply", attemptId: "attempt", actionId: "action" }, [{ actionId: null }]],
    ["source.retry-apply", { kind: "source-pending", pendingKind: "apply", attemptId: "attempt", actionId: "action" }, [{ actionId: undefined }]],
    ["source.cancel-task", { kind: "source-task", attemptId: "attempt", taskId: "task" }, [{ taskId: "" }]],
    ["source.read-page", { kind: "source-page", snapshotId: null, attemptId: "attempt", resultId: "result", after: 50 }, [{ snapshotId: undefined }, { after: NaN }]],
    ["source.read-history", { kind: "source-history", offset: 50 }, [{ offset: -1 }]],
    ["source.read-history-content", { kind: "source-history-content", snapshotId: "snapshot", query: "", after: 1, newOrdinal: null }, [{ query: null }, { newOrdinal: undefined }]],
    ["source.find-lineage-candidates", { kind: "source-history-content", snapshotId: "snapshot", query: "A", after: 20, newOrdinal: 70 }, [{ after: 1.5 }, { newOrdinal: -1 }]],
    ["source.read-lineage", { kind: "source-lineage", snapshotId: "snapshot", ordinal: 70 }, [{ ordinal: NaN }]],
    ["source.read-impact", { kind: "source-impact", snapshotId: "snapshot", locale: "zh-CN", after: 10 }, [{ locale: "" }]],
    ["source.open-translation", { kind: "source-impact-target", snapshotId: "snapshot", locale: "zh-CN", occurrenceId: "occurrence",
      target: { unitId: "unit", sourceRevisionId: "source", key: "key", sourceText: "" }, selectionId: null, translationRevisionId: null, reviewBasis: "current" }, [{ target: { unitId: "unit" } }, { selectionId: undefined }, { reviewBasis: "" }]],
  ] as const)("validates and describes the exact %s input before dispatch", (id, payload, malformed) => {
    const commands = new WorkbenchCommands(), handler = vi.fn(); let enabled = true;
    const remove = commands.register({ ...metadata, id, payloadKind: payload.kind, availability: () => ({ enabled }), handler } as WorkbenchCommand);
    const dispatch = (value?: unknown, target = sourceScope) => Reflect.apply(commands.dispatch, commands, [id, target, value]);
    expect(dispatch()).toBe(false); expect(dispatch(null)).toBe(false); expect(dispatch({ ...payload, kind: "resource-capture" })).toBe(false);
    malformed.forEach(change => expect(dispatch({ ...payload, ...change })).toBe(false));
    expect(dispatch(payload, { ...sourceScope, projectId: "other" })).toBe(false);
    expect(dispatch(payload, { ...sourceScope, sessionToken: "other" })).toBe(false);
    expect(Reflect.apply(commands.dispatch, commands, [id, { ...sourceScope, area: "translation" }, payload])).toBe(false);
    expect(commands.list(sourceScope)[0].availability.enabled).toBe(false);
    expect(Reflect.apply(commands.describe, commands, [id, sourceScope, payload])?.availability.enabled).toBe(true);
    expect(handler).not.toHaveBeenCalled(); expect(dispatch(payload)).toBe(true); expect(handler).toHaveBeenCalledWith(payload);
    enabled = false; expect(Reflect.apply(commands.describe, commands, [id, sourceScope, payload])?.availability.enabled).toBe(false);
    expect(dispatch(payload)).toBe(false); expect(handler).toHaveBeenCalledTimes(1);
    remove(); expect(dispatch(payload)).toBe(false);
  });
});
