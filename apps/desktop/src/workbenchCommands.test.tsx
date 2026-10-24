import { describe, expect, it, vi } from "vitest";
import releaseFixture from "../test/fixtures/releaseCommands.contract.json";
import translationFixture from "../test/fixtures/translation-commands.json";
import { validateResponseDelivery } from "./generated/release.validators";
import { WorkbenchCommands, type ReviewWaiverCommandPayload, type TaskPendingCommandPayload, type ProjectMetadataReconcileCommandPayload, type WorkbenchCommand } from "./workbenchCommands";

const scope = { projectId: "project-a", sessionToken: "session-a", area: "overview" as const };

describe("Project metadata recovery commands", () => {
  it("validates a complete typed original capture and keeps describe, dispatch and disposal in the same scope", () => {
    const payload: ProjectMetadataReconcileCommandPayload = { kind: "project-metadata-reconcile", previous: {
      sessionToken: "original-session", locator: "C:\\Projects\\original", reconciliationState: "settled",
      metadata: { projectId: translationFixture.start.projectId, displayName: "Original", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" },
    }, form: { kind: "rename", expectedRevision: "1" }, value: "Captured name", directoryName: "Captured name" };
    const currentScope = { projectId: payload.previous.metadata.projectId, sessionToken: payload.previous.sessionToken, area: "overview" as const };
    const commands = new WorkbenchCommands(), handler = vi.fn();
    let visible = true;
    const remove = commands.register({ id: "project.metadata.reconcile", nameKey: "action.retry", category: "project", scope: currentScope,
      binding: null, risk: "reconciles-project", confirmation: "none", payloadKind: "project-metadata-reconcile",
      availability: () => ({ enabled: visible, ...(!visible ? { reason: "hidden" as const } : {}) }), handler });
    const dispatch = (value: unknown, targetScope = currentScope) => Reflect.apply(commands.dispatch, commands, ["project.metadata.reconcile", targetScope, value]);
    for (const malformed of [undefined, null, { ...payload, kind: "other" }, { ...payload, previous: null },
      { ...payload, previous: { ...payload.previous, metadata: {} } }, { ...payload, form: null },
      { ...payload, form: { kind: "other", expectedRevision: "1" } }, { ...payload, form: { kind: "rename", expectedRevision: "01" } },
      { ...payload, value: null }, { ...payload, directoryName: undefined },
      { ...payload, form: { kind: "target", expectedRevision: "1" } }]) expect(dispatch(malformed)).toBe(false);
    expect(dispatch(payload, { ...currentScope, sessionToken: "other" })).toBe(false);
    expect(dispatch(payload, { ...currentScope, projectId: "other" })).toBe(false);
    expect(Reflect.apply(commands.dispatch, commands, ["project.metadata.reconcile", { ...currentScope, area: "tasks" }, payload])).toBe(false);
    expect(commands.describe("project.metadata.reconcile", currentScope, payload)?.availability.enabled).toBe(true);
    expect(handler).not.toHaveBeenCalled(); expect(dispatch(payload)).toBe(true); expect(handler).toHaveBeenCalledExactlyOnceWith(payload);
    visible = false;
    expect(commands.describe("project.metadata.reconcile", currentScope, payload)?.availability).toEqual({ enabled: false, reason: "hidden" });
    expect(dispatch(payload)).toBe(false); remove();
    expect(commands.describe("project.metadata.reconcile", currentScope, payload)).toBeUndefined(); expect(dispatch(payload)).toBe(false);
  });
});

describe("Translation business command payloads",()=>{
  const translationScope={...scope,area:"translation" as const},metadata={nameKey:"translation.start" as const,category:"translation" as const,
    scope:translationScope,binding:null,risk:"writes-translation" as const,confirmation:"none" as const};
  const setup={kind:"translation-import-setup" as const,editSeq:1,locale:"zh-CN",selectionId:translationFixture.start.selectionId,fileName:"zh.json"};
  const consent={...setup,kind:"translation-import-consent" as const,sourceSnapshotId:translationFixture.start.expectedSourceSnapshotId,
    fileDigest:translationFixture.start.expectedFileDigest,declaredLocale:"zh",confirmed:true};
  const target={editSeq:1,attemptId:translationFixture.start.attemptId,bundleId:"bundle",basis:"basis",locale:"zh-CN",
    fixedSourceSnapshotId:translationFixture.start.expectedSourceSnapshotId,currentSourceSnapshotId:translationFixture.start.expectedSourceSnapshotId,
    fileDigest:"file",previewResultDigest:"results"};
  const row={ordinal:0,itemId:"item",resultId:"result",resultDigest:"row-result",unitId:"unit",occurrenceId:"occurrence",sourceRevisionId:"revision",expectedSelectionId:null};
  const adopt={...translationFixture.adopt,confirmation:{...translationFixture.adopt.confirmation,decision:"candidate-only" as const}};
  const selection=translationFixture.select;
  const revision={kind:"translation-revision" as const,unitId:"unit",locale:"zh-CN",sourceRevisionId:"current-revision",expectedSelectionId:null,
    editSeq:1,revisionId:"revision",revisionActionId:"action",revisionOrdinal:"1",revisionSourceRevisionId:"source",revisionSourceSnapshotId:"snapshot"};
  it.each([
    ["translation.choose-import-folder",setup,[{editSeq:-1},{selectionId:undefined}]],
    ["translation.inspect-import",setup,[{locale:""},{fileName:null}]],
    ["translation.confirm-import-language",consent,[{confirmed:"yes"},{fileDigest:""}]],
    ["translation.start-import",consent,[{sourceSnapshotId:null},{selectionId:null}]],
    ["translation.retry-import-start",{kind:"translation-import-start-pending",request:translationFixture.start},[{request:{}}]],
    ["translation.choose-import-row",{...target,...row,kind:"translation-import-row",decision:"candidate-only"},[{expectedSelectionId:undefined},{decision:"other"}]],
    ["translation.apply-import-row",{...target,...row,kind:"translation-import-row",decision:"select-if-empty"},[{ordinal:-1},{itemId:null}]],
    ["translation.capture-import-batch",{...target,kind:"translation-import-preview",selectIfEmpty:true},[{selectIfEmpty:"yes"},{basis:""}]],
    ["translation.apply-import-batch",{...target,kind:"translation-import-batch",decision:"candidate-only",rows:[row],excluded:0},[{rows:[]},{rows:[row,row]},{excluded:-1}]],
    ["translation.check-import-receipt",{kind:"translation-import-pending",request:adopt,recoveryUnitId:"recovery",previousSelectionSequence:null},[{request:{}},{recoveryUnitId:""}]],
    ["translation.retry-import-action",{kind:"translation-import-pending",request:adopt,recoveryUnitId:"recovery",previousSelectionSequence:"1"},[{previousSelectionSequence:undefined}]],
    ["translation.select-revision",revision,[{revisionOrdinal:"0"},{expectedSelectionId:undefined}]],
    ["translation.check-selection",{kind:"translation-selection-pending",request:selection,submittedSeq:1},[{request:{}},{submittedSeq:-1}]],
    ["translation.retry-selection",{kind:"translation-selection-pending",request:selection,submittedSeq:1},[{request:{...selection,revisionId:null}}]],
  ] as const)("checks %s before its owner and uses the same scope for describe and dispatch",(id,payload,malformed)=>{
    const commands=new WorkbenchCommands(),handler=vi.fn();let enabled=true;
    const remove=commands.register({...metadata,id,payloadKind:payload.kind,availability:()=>({enabled}),handler} as WorkbenchCommand);
    const dispatch=(value?:unknown,targetScope=translationScope)=>Reflect.apply(commands.dispatch,commands,[id,targetScope,value]);
    expect(dispatch()).toBe(false);expect(dispatch(null)).toBe(false);expect(dispatch({...payload,kind:"other"})).toBe(false);
    malformed.forEach(change=>expect(dispatch({...payload,...change})).toBe(false));
    expect(dispatch(payload,{...translationScope,sessionToken:"other"})).toBe(false);expect(dispatch(payload,{...translationScope,projectId:"other"})).toBe(false);
    expect(Reflect.apply(commands.dispatch,commands,[id,{...translationScope,area:"tasks"},payload])).toBe(false);
    expect(Reflect.apply(commands.describe,commands,[id,translationScope,payload])?.availability.enabled).toBe(true);
    expect(handler).not.toHaveBeenCalled();expect(dispatch(payload)).toBe(true);expect(handler).toHaveBeenCalledExactlyOnceWith(payload);
    enabled=false;expect(dispatch(payload)).toBe(false);remove();expect(dispatch(payload)).toBe(false);
  });
});

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


describe("AI command payloads", () => {
  const aiScope = { ...scope, area: "ai" as const };
  const metadata = { nameKey: "ai.preview" as const, category: "ai" as const, scope: aiScope,
    binding: null, risk: "captures-ai" as const, confirmation: "none" as const };
  const item = { attemptId: "attempt", taskId: "task", itemId: "item", translationUnitId: "unit", locale: "zh-CN",
    sourceRevisionId: "revision", sourceSnapshotId: "snapshot" };
  it.each([
    ["ai.preview", { kind: "ai-preparation", editSeq: 1, locale: "zh-CN", unitIds: ["later-page", "first-page"] },
      [{ editSeq: -1 }, { editSeq: 1.5 }, { locale: "" }, { unitIds: [] }, { unitIds: ["same", "same"] }, { unitIds: ["valid", null] }]],
    ["ai.start", { kind: "ai-start", attemptId: "attempt", editSeq: 2 }, [{ attemptId: "" }, { editSeq: NaN }]],
    ["ai.adopt-result", { kind: "ai-candidate", ...item, resultId: "result", recoveryUnitId: "recovery" },
      [{ resultId: null }, { recoveryUnitId: "" }, { itemId: "" }, { translationUnitId: null }, { sourceSnapshotId: undefined }]],
    ["ai.reconcile-start", { kind: "ai-start-pending", attemptId: "attempt", editSeq: 3 }, [{ attemptId: null }, { editSeq: undefined }]],
    ["ai.retry-start", { kind: "ai-start-pending", attemptId: "attempt", editSeq: 3 }, [{ editSeq: -1 }]],
    ["ai.reconcile-adoption", { kind: "ai-adoption-pending", attemptId: "attempt", actionId: "action", recoveryUnitId: "recovery", resultId: "result" },
      [{ actionId: null }, { recoveryUnitId: "" }]],
    ["ai.retry-adoption", { kind: "ai-adoption-pending", attemptId: "attempt", actionId: "action", recoveryUnitId: "recovery", resultId: "result" },
      [{ resultId: undefined }, { attemptId: "" }]],
    ["ai.cancel-task", { kind: "execution-cancellation", taskId: "task", attemptId: "attempt", origin: "ai" }, [{ origin: "other" }, { taskId: "" }]],
    ["ai.retry-cancellation", { kind: "execution-cancellation-retry", taskId: "task", attemptId: "attempt", origin: "source", requestId: "original" },
      [{ requestId: "" }, { origin: undefined }]],
    ["ai.open-translation", { kind: "ai-translation-target", ...item }, [{ sourceRevisionId: null }, { locale: false }]],
  ] as const)("rejects malformed and obsolete UI intent for %s before invoking its owner", (id, payload, malformed) => {
    const commands = new WorkbenchCommands(), handler = vi.fn();
    let enabled = true;
    const remove = commands.register({ ...metadata, id, payloadKind: payload.kind,
      availability: () => ({ enabled }), handler } as WorkbenchCommand);
    const dispatch = (value?: unknown, target = aiScope) => Reflect.apply(commands.dispatch, commands, [id, target, value]);
    expect(dispatch()).toBe(false); expect(dispatch(null)).toBe(false); expect(dispatch({ ...payload, kind: "unknown" })).toBe(false);
    malformed.forEach(change => expect(dispatch({ ...payload, ...change })).toBe(false));
    expect(dispatch(payload, { ...aiScope, projectId: "other" })).toBe(false);
    expect(dispatch(payload, { ...aiScope, sessionToken: "other" })).toBe(false);
    expect(Reflect.apply(commands.dispatch, commands, [id, { ...aiScope, area: "arena" }, payload])).toBe(false);
    expect(handler).not.toHaveBeenCalled(); expect(dispatch(payload)).toBe(true); expect(handler).toHaveBeenCalledWith(payload);
    enabled = false; expect(dispatch(payload)).toBe(false); expect(handler).toHaveBeenCalledTimes(1);
    remove(); expect(dispatch(payload)).toBe(false);
  });
});

describe("Arena command payloads", () => {
  const arenaScope = { ...scope, area: "arena" as const };
  const metadata = { nameKey: "arena.compare" as const, category: "arena" as const, scope: arenaScope,
    binding: null, risk: "captures-arena" as const, confirmation: "none" as const };
  const item = { attemptId: "attempt", taskId: "task", itemId: "item", translationUnitId: "unit", locale: "zh-CN",
    sourceRevisionId: "source", sourceSnapshotId: "snapshot" };
  const comparison = { comparisonId: "comparison", unitId: "unit", locale: "zh-CN", sourceRevisionId: "source", selectionId: null, basis: "basis" };
  it.each([
    ["arena.preview", { kind: "arena-preparation", editSeq: 1, locale: "zh-CN", unitIds: ["second-page", "first-page"] }, [{ editSeq: -1 }, { unitIds: [] }, { unitIds: ["same", "same"] }]],
    ["arena.start", { kind: "arena-start", attemptId: "attempt", editSeq: 1 }, [{ attemptId: null }, { editSeq: NaN }]],
    ["arena.adopt-result", { kind: "arena-candidate", ...item, resultId: "result", recoveryUnitId: "recovery" }, [{ recoveryUnitId: "" }, { sourceSnapshotId: null }]],
    ["arena.create-comparison", { kind: "arena-compare", unitId: "unit", locale: "zh-CN", revisionIds: ["first", "second"], blind: true, editSeq: 2 }, [{ revisionIds: ["same", "same"] }, { revisionIds: ["first"] }, { blind: null }, { editSeq: 1.5 }]],
    ["arena.reveal-identities", { kind: "arena-reveal", targetKind: "comparison", targetId: "comparison" }, [{ targetKind: "task" }, { targetId: "" }]],
    ["arena.select-candidate", { kind: "arena-selection", ...comparison, revisionId: "revision" }, [{ revisionId: null }, { selectionId: undefined }]],
    ["arena.begin-merge", { kind: "arena-comparison", ...comparison }, [{ basis: "" }, { sourceRevisionId: null }]],
    ["arena.save-merge", { kind: "arena-merge-draft", ...comparison, editSeq: 3 }, [{ editSeq: -1 }]],
    ["arena.refresh-merge-basis", { kind: "arena-merge-draft", ...comparison, editSeq: 3 }, [{ editSeq: undefined }]],
    ["arena.discard-merge", { kind: "arena-merge-draft", ...comparison, editSeq: 3 }, [{ comparisonId: "" }]],
    ["arena.new-round", { kind: "arena-round", attemptId: "attempt", taskId: "task", editSeq: 3 }, [{ taskId: null }, { editSeq: false }]],
    ["arena.open-comparison", { kind: "arena-open-comparison", comparisonId: "comparison", nativeKey: "", locale: "zh-CN" }, [{ locale: "" }, { nativeKey: null }]],
    ["arena.reconcile-pending", { kind: "arena-pending", pendingKind: "start", attemptId: "attempt" }, [{ pendingKind: "other" }, { attemptId: null }]],
    ["arena.retry-pending", { kind: "arena-pending", pendingKind: "adopt", attemptId: "attempt", actionId: "action", recoveryUnitId: "recovery", resultId: "result" }, [{ recoveryUnitId: null }, { resultId: "" }]],
    ["arena.cancel-task", { kind: "execution-cancellation", taskId: "task", attemptId: "attempt", origin: "arena" }, [{ origin: "other" }, { attemptId: null }]],
    ["arena.retry-cancellation", { kind: "execution-cancellation-retry", taskId: "task", attemptId: "attempt", origin: "source", requestId: "request" }, [{ requestId: "" }]],
    ["arena.open-translation", { kind: "arena-translation-target", ...item }, [{ sourceRevisionId: null }, { locale: "" }]],
    ["arena.reconcile-pending", { kind: "arena-pending", pendingKind: "compare", actionId: "action", unitId: "unit", locale: "zh-CN" }, [{ actionId: "" }, { unitId: null }]],
    ["arena.reconcile-pending", { kind: "arena-pending", pendingKind: "reveal", actionId: "action", targetKind: "attempt", targetId: "attempt" }, [{ targetKind: "other" }, { targetId: null }]],
    ["arena.reconcile-pending", { kind: "arena-pending", pendingKind: "select", actionId: "action", unitId: "unit", locale: "zh-CN" }, [{ locale: "" }]],
    ["arena.reconcile-pending", { kind: "arena-pending", pendingKind: "merge", actionId: "action", unitId: "unit", locale: "zh-CN" }, [{ unitId: "" }]],
  ] as const)("validates fixed Arena intent for %s before reaching the owner", (id, payload, malformed) => {
    const commands = new WorkbenchCommands(), handler = vi.fn(); let enabled = true;
    const remove = commands.register({ ...metadata, id, payloadKind: payload.kind, availability: () => ({ enabled }), handler } as WorkbenchCommand);
    const dispatch = (value?: unknown, target = arenaScope) => Reflect.apply(commands.dispatch, commands, [id, target, value]);
    expect(dispatch()).toBe(false); expect(dispatch(null)).toBe(false); expect(dispatch({ ...payload, kind: "unknown" })).toBe(false);
    malformed.forEach(change => expect(dispatch({ ...payload, ...change })).toBe(false));
    expect(dispatch(payload, { ...arenaScope, projectId: "other" })).toBe(false);
    expect(dispatch(payload, { ...arenaScope, sessionToken: "other" })).toBe(false);
    expect(Reflect.apply(commands.dispatch, commands, [id, { ...arenaScope, area: "ai" }, payload])).toBe(false);
    expect(Reflect.apply(commands.describe, commands, [id, arenaScope, payload])?.availability.enabled).toBe(true);
    expect(handler).not.toHaveBeenCalled(); expect(dispatch(payload)).toBe(true); expect(handler).toHaveBeenCalledWith(payload);
    enabled = false; expect(dispatch(payload)).toBe(false); expect(handler).toHaveBeenCalledTimes(1);
    remove(); expect(dispatch(payload)).toBe(false);
  });
});

describe("Tasks command payloads", () => {
  const tasksScope = { ...scope, area: "tasks" as const };
  const metadata = { nameKey: "execution.confirm" as const, category: "tasks" as const, scope: tasksScope,
    binding: null, risk: "captures-execution-action" as const, confirmation: "none" as const };
  const target = { taskId: "task", attemptId: "attempt", operation: "operation", unitId: "unit" };
  const action = { ...target, itemIds: ["item", "other"], remainingItemIds: ["item"], resultIds: ["result"], itemId: null };
  const adoption: TaskPendingCommandPayload = { kind: "task-pending", ...target, actionId: "action", requestKind: "adoption", resultIds: ["result"] };
  const continuation: TaskPendingCommandPayload = { kind: "task-pending", ...target, actionId: "action", requestKind: "continuation", action: "resume-undispatched", itemIds: ["item"], expectedCancellationRevision: "0" };
  it("keeps complete units independent of the continuation dispatch limit", () => {
    const commands = new WorkbenchCommands(), handler = vi.fn(), itemIds=Array.from({length:2001},(_,index)=>`item-${index}`);
    commands.register({...metadata,id:"tasks.resume-undispatched",payloadKind:"task-action",availability:()=>({enabled:true}),handler});
    const payload={kind:"task-action" as const,...target,action:"resume-undispatched" as const,itemIds,remainingItemIds:itemIds.slice(0,2000),resultIds:[],itemId:null,offset:0};
    expect(commands.dispatch("tasks.resume-undispatched",tasksScope,payload)).toBe(true);
    expect(commands.dispatch("tasks.resume-undispatched",tasksScope,{...payload,remainingItemIds:itemIds})).toBe(false);
    expect(handler).toHaveBeenCalledExactlyOnceWith(payload);
  });
  it.each([
    ["tasks.adopt-result", { kind: "task-action", ...action, action: "adopt-result", offset: 0 }, [{ itemIds: [] }, { resultIds: ["same", "same"] }]],
    ["tasks.resume-undispatched", { kind: "task-action", ...action, action: "resume-undispatched", offset: 100 }, [{ offset: -1 }, { remainingItemIds: ["foreign"] }]],
    ["tasks.retry-safe-failure", { kind: "task-action", ...action, action: "retry-safe-failure", offset: 0 }, [{ action: "other" }]],
    ["tasks.validate-output", { kind: "task-action", ...action, action: "validate-output", offset: 0 }, [{ itemId: "item" }]],
    ["tasks.query-outcome", { kind: "task-action", ...action, action: "query-outcome", itemId: "item", offset: 0 }, [{ itemId: null }, { itemId: "foreign" }]],
    ["tasks.submit-action", { kind: "task-confirmed", ...action, action: "resume-undispatched", cancellationRevision: "0" }, [{ cancellationRevision: undefined }, { cancellationRevision: "01" }]],
    ["tasks.submit-action", { kind: "task-confirmed", ...action, action: "adopt-result", cancellationRevision: null }, [{ itemIds: ["same", "same"] }]],
    ["tasks.confirm-cancellation", { kind: "execution-cancellation", taskId: "task", attemptId: "attempt", origin: "tasks" }, [{ origin: "other" }]],
    ["tasks.cancel-task", { kind: "execution-cancellation", taskId: "task", attemptId: "attempt", origin: "tasks" }, [{ taskId: null }]],
    ["tasks.retry-cancellation", { kind: "execution-cancellation-retry", taskId: "task", attemptId: "attempt", origin: "arena", requestId: "request" }, [{ requestId: "" }]],
    ["tasks.reconcile-adoption", adoption, [{ actionId: "" }, { resultIds: [] }]],
    ["tasks.retry-adoption", adoption, [{ requestKind: "other" }]],
    ["tasks.reconcile-continuation", continuation, [{ expectedCancellationRevision: null }, { itemIds: [] }]],
    ["tasks.retry-continuation", continuation, [{ action: "adopt-result" }]],
    ["tasks.view-continuation", { kind: "task-history", taskId: "task", sourceAttemptId: "source", operation: "operation", actionId: "action", unitId: "unit",
      action: "resume-undispatched", itemIds: ["item"], expectedCancellationRevision: "0", attemptId: "new", sequence: "9007199254740993",
      requestDigest: "a".repeat(64), sourceInputDigest: "b".repeat(64), inputDigest: "c".repeat(64), cursor: "0" }, [{ sequence: "0" }, { inputDigest: "bad" }, { cursor: "01" }]],
    ["tasks.view-receipt", { kind: "task-receipt", ...target, actionId: "receipt" }, [{ actionId: undefined }]],
    ["tasks.view-output", { kind: "task-output", taskId: "task", attemptId: "attempt", operation: "operation", itemId: "item", resultId: "result" }, [{ resultId: null }]],
    ["tasks.open-preview", { kind: "task-preview", taskId: "task", attemptId: "attempt", operation: "source-import", area: "source", unitId: null }, [{ area: "release" }, { unitId: undefined }]],
  ] as const)("validates the exact %s UI intent without dispatching malformed scope", (id, payload, malformed) => {
    const commands = new WorkbenchCommands(), handler = vi.fn(); let enabled = true;
    const remove = commands.register({ ...metadata, id, payloadKind: payload.kind, availability: () => ({ enabled }), handler } as WorkbenchCommand);
    const dispatch = (value?: unknown, target = tasksScope) => Reflect.apply(commands.dispatch, commands, [id, target, value]);
    expect(dispatch()).toBe(false); expect(dispatch(null)).toBe(false); expect(dispatch({ ...payload, kind: "unknown" })).toBe(false);
    malformed.forEach(change => expect(dispatch({ ...payload, ...change })).toBe(false));
    if (payload.kind === "task-action") expect(dispatch({ ...payload, action: payload.action === "adopt-result" ? "validate-output" : "adopt-result" })).toBe(false);
    expect(dispatch(payload, { ...tasksScope, projectId: "other" })).toBe(false);
    expect(dispatch(payload, { ...tasksScope, sessionToken: "other" })).toBe(false);
    expect(Reflect.apply(commands.dispatch, commands, [id, { ...tasksScope, area: "source" }, payload])).toBe(false);
    expect(Reflect.apply(commands.describe, commands, [id, tasksScope, payload])?.availability.enabled).toBe(true);
    expect(handler).not.toHaveBeenCalled(); expect(dispatch(payload)).toBe(true); expect(handler).toHaveBeenCalledWith(payload);
    enabled = false; expect(dispatch(payload)).toBe(false); expect(handler).toHaveBeenCalledTimes(1);
    remove(); expect(dispatch(payload)).toBe(false);
  });
});


describe("Release command payloads",()=>{
  const releaseScope={...scope,area:"release" as const},metadata={nameKey:"release.build" as const,category:"release" as const,scope:releaseScope,
    binding:null,risk:"captures-release" as const,confirmation:"none" as const};
  const target={releaseId:"release",releaseActionId:"release-action",attemptId:"attempt",manifestSha256:"manifest"};
  const preparation={kind:"release-preparation" as const,editSeq:1,locales:["zh-CN"],fileNames:["zh.json"],sourceLocale:"en",targetLocales:["zh-CN"],integrationId:"format",integrationVersion:"1",eligibilityBasis:"basis"};
  const build={kind:"release-build-pending" as const,attemptId:"attempt",choices:[{locale:"zh-CN",fileName:"i18n/zh.json"}],expectedEligibilityBasis:"basis"};
  const preview={kind:"release-preview" as const,...target,selectionId:"selection",previewId:"preview",overwrite:true};
  const pending={kind:"release-delivery-pending" as const,pendingKind:"export" as const,actionId:"action",releaseId:"release",selectionId:"selection",
    previewId:"preview",overwriteConflicts:true,recoverySelectionId:null,delivery:null};
  const checked:unknown=structuredClone(releaseFixture.responses.delivery);if(!validateResponseDelivery(checked))throw new Error("Invalid original delivery fixture");
  it.each([
    ["release.assess-build",preparation,[{locales:[]},{fileNames:[]},{editSeq:-1}]],
    ["release.start-build",preparation,[{integrationVersion:""},{eligibilityBasis:undefined}]],
    ["release.check-build",build,[{choices:[]},{attemptId:null}]],
    ["release.retry-build",build,[{choices:[{locale:"zh-CN",fileName:""}]}]],
    ["release.choose-release",{kind:"release-record",...target},[{manifestSha256:null}]],
    ["release.choose-destination",{kind:"release-destination",...target,selectionId:null},[{selectionId:undefined}]],
    ["release.preview-destination",{kind:"release-destination",...target,selectionId:"selection"},[{releaseActionId:""}]],
    ["release.confirm-overwrite",preview,[{overwrite:"yes"},{previewId:null}]],
    ["release.export",preview,[{selectionId:null},{overwrite:undefined}]],
    ["release.check-export",pending,[{previewId:null},{pendingKind:"other"}]],
    ["release.reauthorize-destination",pending,[{recoverySelectionId:undefined},{delivery:{}}]],
    ["release.reconcile-delivery",{kind:"release-delivery",...target,selectionId:"selection",delivery:checked},[{delivery:{...checked,files:[]}}]],
    ["release.open-blocker",{kind:"release-blocker",editSeq:1,eligibilityBasis:"basis",sourceSnapshotId:"snapshot",unitId:"unit",locale:"zh-CN"},[{unitId:""},{editSeq:NaN}]],
  ] as const)("validates %s before invoking its owner and keeps describe and dispatch on the same scope",(id,payload,malformed)=>{
    const commands=new WorkbenchCommands(),handler=vi.fn();let enabled=true;
    const remove=commands.register({...metadata,id,payloadKind:payload.kind,availability:()=>({enabled}),handler} as WorkbenchCommand);
    const dispatch=(value?:unknown,targetScope=releaseScope)=>Reflect.apply(commands.dispatch,commands,[id,targetScope,value]);
    expect(dispatch()).toBe(false);expect(dispatch(null)).toBe(false);expect(dispatch({...payload,kind:"other"})).toBe(false);
    malformed.forEach(change=>expect(dispatch({...payload,...change})).toBe(false));
    expect(dispatch(payload,{...releaseScope,projectId:"other"})).toBe(false);expect(dispatch(payload,{...releaseScope,sessionToken:"other"})).toBe(false);
    expect(Reflect.apply(commands.dispatch,commands,[id,{...releaseScope,area:"tasks"},payload])).toBe(false);
    expect(Reflect.apply(commands.describe,commands,[id,releaseScope,payload])?.availability.enabled).toBe(true);expect(handler).not.toHaveBeenCalled();
    expect(dispatch(payload)).toBe(true);expect(handler).toHaveBeenCalledExactlyOnceWith(payload);enabled=false;expect(dispatch(payload)).toBe(false);
    remove();expect(dispatch(payload)).toBe(false);
  });
});
