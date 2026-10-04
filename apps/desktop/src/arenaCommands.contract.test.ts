import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/arenaCommands.contract.json";
import { arenaCommands } from "./arenaCommands";
import * as validators from "./generated/arena.validators";
import { hasUnknownOutcome } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

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
