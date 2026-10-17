import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/arenaCommands.contract.json";
import { arenaCommands, confirmArenaComparison, confirmArenaMerge } from "./arenaCommands";
import * as validators from "./generated/arena.validators";
import { hasUnknownOutcome } from "./projectCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it("reads an exact comparison creation request without accepting a current comparison projection",async()=>{
  const request=fixture.requests.compare;
  const echo={projectId:request.projectId,actionId:request.actionId,unitId:request.unitId,locale:request.locale,
    revisionIds:request.revisionIds,blind:request.blind};
  expect(validators.validateResponseComparisonAction(echo)).toBe(true);
  invoke.mockResolvedValueOnce(echo);expect(await arenaCommands.comparisonAction(request)).toEqual(echo);
  expect(invoke).toHaveBeenLastCalledWith("read_arena_comparison_action",{request});
  invoke.mockResolvedValueOnce(null);expect(await arenaCommands.comparisonAction(request)).toBeNull();
  for(const wrong of [undefined,{},fixture.responses.comparison,{...echo,projectId:fixtureIdentity(703)},
    {...echo,actionId:fixtureIdentity(704)},{...echo,unitId:fixtureIdentity(705)},{...echo,locale:"ja"},
    {...echo,blind:!echo.blind},{...echo,revisionIds:[...echo.revisionIds].reverse()},{...echo,revisionIds:echo.revisionIds.slice(1)}]){
    invoke.mockResolvedValueOnce(wrong);await expect(arenaCommands.comparisonAction(request)).rejects.toThrow();
  }
  expect(invoke.mock.calls.every(([command])=>command==="read_arena_comparison_action")).toBe(true);
});

it("binds a merge read to its entire original text, source, selection and ordered contributor basis",async()=>{
  const request=fixture.requests.merge;
  const echo={request:{projectId:request.projectId,actionId:request.actionId,unitId:request.unitId,locale:request.locale,
    sourceRevisionId:request.sourceRevisionId,expectedSelectionId:request.expectedSelectionId??null,text:request.text},
    merge:request.merge,receipt:fixture.responses.selection};
  expect(validators.validateResponseMergeAction(echo)).toBe(true);
  invoke.mockResolvedValueOnce(echo);expect(await arenaCommands.mergeAction(request)).toEqual(echo);
  expect(invoke).toHaveBeenLastCalledWith("read_arena_merge_action",{request});
  invoke.mockResolvedValueOnce(null);expect(await arenaCommands.mergeAction(request)).toBeNull();
  const {expectedSelectionId:_expected,...missing}=echo.request;
  for(const wrong of [undefined,{},fixture.responses.selection,{...echo,request:missing},
    ...[{projectId:fixtureIdentity(703)},{actionId:fixtureIdentity(704)},{unitId:fixtureIdentity(705)},{locale:"ja"},
      {sourceRevisionId:fixtureIdentity(706)},{expectedSelectionId:null},{text:request.text+" changed"}].map(fields=>({...echo,request:{...echo.request,...fields}})),
    {...echo,merge:{...echo.merge,expectedBasis:"changed"}},
    {...echo,merge:{...echo.merge,contributors:[...echo.merge.contributors].reverse()}},
    {...echo,receipt:{...echo.receipt,actionId:fixtureIdentity(707)}}]){
    invoke.mockResolvedValueOnce(wrong);await expect(arenaCommands.mergeAction(request)).rejects.toThrow();
  }
  const noSelection={...request,expectedSelectionId:null};
  const noSelectionEcho={...echo,request:{...echo.request,expectedSelectionId:null},receipt:{...echo.receipt,previousEventId:null,sequence:"1"}};
  const {expectedSelectionId:_absent,...absent}=noSelectionEcho.request;
  invoke.mockResolvedValueOnce({...noSelectionEcho,request:absent});await expect(arenaCommands.mergeAction(noSelection)).rejects.toThrow();
  invoke.mockResolvedValueOnce(noSelectionEcho);expect(await arenaCommands.mergeAction(noSelection)).toEqual(noSelectionEcho);
  expect(invoke.mock.calls.every(([command])=>command==="read_arena_merge_action")).toBe(true);
});

it("reads only the captured Arena start and distinguishes missing from invalid proof", async () => {
  const request=fixture.requests.start;
  const receipt={projectId:request.projectId,attemptId:request.attemptId,taskId:fixtureIdentity(702),digest:request.digest};
  expect(validators.validateResponseStartAction(receipt)).toBe(true);
  invoke.mockResolvedValueOnce(receipt);
  expect(await arenaCommands.startAction(request)).toEqual(receipt);
  expect(invoke).toHaveBeenLastCalledWith("read_arena_start_action",{request});
  invoke.mockResolvedValueOnce(null);expect(await arenaCommands.startAction(request)).toBeNull();
  for(const wrong of [undefined,{}, {...receipt,projectId:fixtureIdentity(703)}, {...receipt,attemptId:fixtureIdentity(704)},
    {...receipt,digest:"f".repeat(64)}, {...receipt,taskId:null}, {...receipt,extra:true}]){
    invoke.mockResolvedValueOnce(wrong);await expect(arenaCommands.startAction(request)).rejects.toThrow();
  }
  expect(invoke.mock.calls.every(([command])=>command==="read_arena_start_action")).toBe(true);
});

it("validates both directions of every shared Arena contract", async () => {
  for (const [validate, value] of [
    [validators.validateRequestPreview, fixture.requests.preview], [validators.validateRequestStart, fixture.requests.start],
    [validators.validateRequestRead, fixture.requests.read], [validators.validateRequestCompare, fixture.requests.compare],
    [validators.validateRequestComparison, fixture.requests.comparison], [validators.validateRequestSession, fixture.requests.session],
    [validators.validateRequestReveal, fixture.requests.reveal], [validators.validateRequestMerge, fixture.requests.merge],
    [validators.validateResponsePrepared, fixture.responses.prepared], [validators.validateResponseIdentity, fixture.responses.identity],
    [validators.validateResponseView, fixture.responses.view], [validators.validateResponseComparison, fixture.responses.comparison],
    [validators.validateResponseComparisons, fixture.responses.comparisons], [validators.validateResponseReveal, fixture.responses.reveal],
    [validators.validateResponseSelection, fixture.responses.selection],
  ] as const) expect(validate(value), validate.name).toBe(true);
  for (const [command, request, response, run] of [
    ["preview_arena_translation", fixture.requests.preview, fixture.responses.prepared, () => arenaCommands.preview(fixture.requests.preview)],
    ["start_arena_translation", fixture.requests.start, fixture.responses.identity, () => arenaCommands.start(fixture.requests.start)],
    ["read_arena_translation", fixture.requests.read, fixture.responses.view, () => arenaCommands.read(fixture.requests.read)],
    ["create_arena_comparison", fixture.requests.compare, fixture.responses.comparison, () => arenaCommands.compare(fixture.requests.compare)],
    ["read_arena_comparison", fixture.requests.comparison, fixture.responses.comparison, () => arenaCommands.comparison(fixture.requests.comparison)],
    ["list_arena_comparisons", fixture.requests.session, fixture.responses.comparisons, () => arenaCommands.comparisons(fixture.requests.session)],
    ["save_arena_merge", fixture.requests.merge, fixture.responses.selection, () => arenaCommands.merge(fixture.requests.merge)],
  ] as const) {
    invoke.mockResolvedValueOnce(response);
    expect(await run()).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith(command, { request });
  }
  invoke.mockResolvedValueOnce(null);
  expect(await arenaCommands.reveal(fixture.requests.reveal)).toBeUndefined();
  expect(invoke).toHaveBeenLastCalledWith("reveal_arena_identity", { request: fixture.requests.reveal });
});

it("preserves exact counters while keeping blind identities nullable", () => {
  expect(fixture.responses.view.variants).toBeNull();
  expect(fixture.responses.comparison.rows.every(row => row.model === null && row.recipe === null)).toBe(true);
  expect(fixture.responses.view.rows[0].output.usage.completionTokens).toBe("18446744073709551615");
  expect(JSON.parse(JSON.stringify(fixture.responses.comparison))).toEqual(fixture.responses.comparison);
  const { parentAttemptId: _parent, ...config } = fixture.requests.preview.config;
  expect(validators.validateRequestPreview({ ...fixture.requests.preview, config })).toBe(true);
  const { expectedSelectionId: _selection, ...merge } = fixture.requests.merge;
  expect(validators.validateRequestMerge(merge)).toBe(true);
});

it("rejects unknown origins, unbounded indices and incomplete confirmations", () => {
  const comparison = fixture.responses.comparison;
  expect(validators.validateResponseComparison({ ...comparison, rows: [{ ...comparison.rows[0], originKind: "best" }] })).toBe(false);
  const view = fixture.responses.view, row = view.rows[0];
  for (const label of [-1, 0.5, 4294967296]) expect(validators.validateResponseView({ ...view, rows: [{ ...row, label }] })).toBe(false);
  expect(validators.validateResponseView({ ...view, rows: [{ ...row, sourceOrder: 4294967296 }] })).toBe(false);
  expect(validators.validateResponseComparisons([{ ...fixture.responses.comparisons[0], comparisonId: null }])).toBe(false);
  expect(validators.validateResponseView({ ...view, rows: [{ ...row, output: { ...row.output, usage: { promptTokens: 1, completionTokens: "0" } } }] })).toBe(false);
  expect(validators.validateResponseReveal({})).toBe(false);
});

it("binds mutation acknowledgements and keeps an unrelated action unknown", async () => {
  invoke.mockResolvedValueOnce(fixture.responses.comparison.unitId);
  await expect(arenaCommands.start(fixture.requests.start)).rejects.toSatisfy(hasUnknownOutcome);
  for (const response of [
    { ...fixture.responses.comparison, comparisonId: fixture.responses.comparison.unitId },
    { ...fixture.responses.comparison, unitId: fixture.responses.comparison.sourceRevisionId },
    { ...fixture.responses.comparison, rows: [fixture.responses.comparison.rows[0], fixture.responses.comparison.rows[0]] },
  ]) {
    invoke.mockResolvedValueOnce(response);
    await expect(arenaCommands.compare(fixture.requests.compare)).rejects.toSatisfy(hasUnknownOutcome);
  }
  for (const response of [
    { ...fixture.responses.selection, actionId: fixture.responses.selection.revisionId },
    { ...fixture.responses.selection, previousEventId: null },
    { ...fixture.responses.selection, sequence: "0" },
  ]) {
    invoke.mockResolvedValueOnce(response);
    await expect(arenaCommands.merge(fixture.requests.merge)).rejects.toSatisfy(hasUnknownOutcome);
  }
  invoke.mockResolvedValueOnce({});
  await expect(arenaCommands.reveal(fixture.requests.reveal)).rejects.toSatisfy(hasUnknownOutcome);
  const rejected = { code: "dependency-conflict", outcome: "rejected", reason: "arena-basis" };
  invoke.mockRejectedValueOnce(rejected);
  await expect(arenaCommands.merge(fixture.requests.merge)).rejects.toBe(rejected);
});


it("validates durable budget counters and exact aggregate usage", () => {
  const budget = {limit:300,dispatched:2,legacyHeld:0,unresolved:1,usageUnknown:1,promptTokens:"5534023222112865484500",completionTokens:"0"};
  expect(validators.validateResponseView({...fixture.responses.view,budget})).toBe(true);
  for (const value of [1, "01", "-1", "1e2", "10000000000000000000000"]) expect(validators.validateResponseView({...fixture.responses.view,budget:{...budget,promptTokens:value}})).toBe(false);
  for (const value of [-1, 0.5, 301]) expect(validators.validateResponseView({...fixture.responses.view,budget:{...budget,dispatched:value}})).toBe(false);
  expect(validators.validateResponseView({...fixture.responses.view,budget:{...budget,extra:true}})).toBe(false);
});


it("binds the original comparison creation fields while accepting current projection and blind shuffled order", () => {
  const current = {...fixture.responses.comparison,sourceRevisionId:fixture.responses.selection.revisionId,
    selectionId:fixture.responses.selection.eventId,basis:"current-basis",sourceText:"Updated current source",rows:[...fixture.responses.comparison.rows].reverse()};
  expect(confirmArenaComparison(fixture.requests.compare,current)).toEqual(current);
  for(const wrong of [{comparisonId:fixture.responses.comparison.unitId},{unitId:fixture.responses.comparison.sourceRevisionId},
    {locale:"ja"},{blind:false},{rows:[current.rows[0],current.rows[0]]},{rows:[current.rows[0]]}]){
    expect(()=>confirmArenaComparison(fixture.requests.compare,{...current,...wrong})).toThrow();
  }
});
it("validates the exact original merge selection receipt without fabricating revision or text receipt fields", () => {
  const receipt=fixture.responses.selection;
  expect(confirmArenaMerge(fixture.requests.merge,receipt)).toEqual(receipt);
  for(const wrong of [{actionId:receipt.revisionId},{unitId:receipt.revisionId},{locale:"ja"},{previousEventId:null},
    {sequence:"0"},{sequence:"1"},{eventId:"invalid"},{revisionId:"invalid"}]){
    expect(()=>confirmArenaMerge(fixture.requests.merge,{...receipt,...wrong})).toThrow();
  }
  const first={...fixture.requests.merge,expectedSelectionId:null};
  expect(confirmArenaMerge(first,{...receipt,previousEventId:null,sequence:"1"})).toEqual({...receipt,previousEventId:null,sequence:"1"});
  expect(()=>confirmArenaMerge(first,{...receipt,previousEventId:null,sequence:"2"})).toThrow();
});
