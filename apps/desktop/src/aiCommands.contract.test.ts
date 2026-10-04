import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/aiCommands.contract.json";
import { aiCommands } from "./aiCommands";
import * as validators from "./generated/ai.validators";
import { hasUnknownOutcome } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it("validates both directions of every shared AI contract", async () => {
  for (const [validate, value] of [
    [validators.validateRequestPreview, fixture.requests.preview],
    [validators.validateRequestStart, fixture.requests.start],
    [validators.validateRequestRead, fixture.requests.read],
    [validators.validateResponsePrepared, fixture.responses.prepared],
    [validators.validateResponseIdentity, fixture.responses.identity],
    [validators.validateResponseView, fixture.responses.view],
  ] as const) expect(validate(value), validate.name).toBe(true);
  for (const [command, request, response, run] of [
    ["preview_ai_translation", fixture.requests.preview, fixture.responses.prepared, () => aiCommands.preview(fixture.requests.preview)],
    ["start_ai_translation", fixture.requests.start, fixture.responses.identity, () => aiCommands.start(fixture.requests.start)],
    ["read_ai_translation", fixture.requests.read, fixture.responses.view, () => aiCommands.read(fixture.requests.read)],
  ] as const) {
    invoke.mockResolvedValueOnce(response);
    expect(await run()).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith(command, { request });
  }
});

it("preserves full u64 display values, context evidence and Unicode", () => {
  const item = fixture.responses.prepared.preview.items[0];
  expect(item.resourceBaseline).toBe("18446744073709551615");
  expect(fixture.responses.view.rows[0].output.usage.promptTokens).toBe("9007199254740993");
  expect(item.terms[0].target).toBe("木桶 👩🏽‍💻 é");
  expect(JSON.parse(JSON.stringify(fixture.responses.view))).toEqual(fixture.responses.view);
  for (const value of ["0", "9007199254740993", "18446744073709551615"]) {
    expect(validators.validateResponsePrepared({ ...fixture.responses.prepared, preview: { ...fixture.responses.prepared.preview, items: [{ ...item, resourceBaseline: value }] } })).toBe(true);
  }
});

it("rejects noncanonical counters, overflow and incomplete nested responses", () => {
  const view = fixture.responses.view, row = view.rows[0];
  for (const value of [0, 9007199254740992, "18446744073709551616", "01", "-1", "+1", "1.0", "1e3", " 1", ""]) {
    expect(validators.validateResponseView({ ...view, rows: [{ ...row, output: { ...row.output, usage: { ...row.output.usage, promptTokens: value } } }] }), String(value)).toBe(false);
  }
  expect(validators.validateResponseView({ ...view, rows: [{ ...row, itemId: "item" }] })).toBe(false);
  expect(validators.validateResponseView({ ...view, detail: { ...view.detail, items: [{ ...view.detail.items[0], status: { ...view.detail.items[0].status, execution: "completed" } }] } })).toBe(false);
  expect(validators.validateRequestPreview({ ...fixture.requests.preview, config: { ...fixture.requests.preview.config, maxRequests: 4294967296 } })).toBe(false);
  const { reason: _reason, ...context } = row.item.context;
  expect(validators.validateResponseView({ ...view, rows: [{ ...row, item: { ...row.item, context } }] })).toBe(false);
});

it("keeps malformed or unrelated start acknowledgements unknown", async () => {
  for (const response of ["attempt", fixture.responses.view.rows[0].itemId]) {
    invoke.mockResolvedValueOnce(response);
    await expect(aiCommands.start(fixture.requests.start)).rejects.toSatisfy(hasUnknownOutcome);
  }
  invoke.mockResolvedValueOnce({ ...fixture.responses.view, detail: { ...fixture.responses.view.detail, attemptId: fixture.responses.view.rows[0].itemId } });
  await expect(aiCommands.read(fixture.requests.read)).rejects.toThrow();
  invoke.mockResolvedValueOnce({ ...fixture.responses.view, rows: [{ ...fixture.responses.view.rows[0], output: { ...fixture.responses.view.rows[0].output, targetLocale: "ja" } }] });
  await expect(aiCommands.read(fixture.requests.read)).rejects.toThrow();
  const rejected = { code: "invalid-input", outcome: "rejected", reason: "ai-model" };
  invoke.mockRejectedValueOnce(rejected);
  await expect(aiCommands.start(fixture.requests.start)).rejects.toBe(rejected);
});


it("validates durable budget counters and exact aggregate usage", () => {
  const budget = {limit:300,dispatched:2,legacyHeld:0,unresolved:1,usageUnknown:1,promptTokens:"5534023222112865484500",completionTokens:"0"};
  expect(validators.validateResponseView({...fixture.responses.view,budget})).toBe(true);
  for (const value of [1, "01", "-1", "1e2", "10000000000000000000000"]) expect(validators.validateResponseView({...fixture.responses.view,budget:{...budget,promptTokens:value}})).toBe(false);
  for (const value of [-1, 0.5, 301]) expect(validators.validateResponseView({...fixture.responses.view,budget:{...budget,dispatched:value}})).toBe(false);
  expect(validators.validateResponseView({...fixture.responses.view,budget:{...budget,extra:true}})).toBe(false);
});
