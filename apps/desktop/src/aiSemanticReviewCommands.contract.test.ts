import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/aiSemanticReviewCommands.contract.json";
import { aiSemanticReviewCommands, type AiSemanticReviewLookup } from "./aiSemanticReviewCommands";
import * as validators from "./generated/review.validators";
import { semanticPreparedFixture } from "./testSupport/aiSemanticReviewFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { hasUnknownOutcome } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
function lookup(kind: "view" | "recorded"): AiSemanticReviewLookup {
  const value: unknown = structuredClone(fixture.responses[kind]);
  if (!validators.validateResponseSemanticRead(value)) throw new Error("Invalid shared semantic review fixture");
  return value;
}

it("round trips all shared Rust review request and response shapes through the actual command names", async () => {
  const request: unknown = fixture.requests.prepare;
  if (!validators.validateRequestSemanticPrepare(request)) throw new Error("Invalid shared prepare request");
  expect(validators.validateRequestSemanticStart(fixture.requests.start)).toBe(true);
  expect(validators.validateRequestSemanticRead(fixture.requests.read)).toBe(true);
  invoke.mockResolvedValueOnce(fixture.responses.prepared);
  expect(await aiSemanticReviewCommands.prepare(request)).toEqual(fixture.responses.prepared);
  expect(invoke).toHaveBeenLastCalledWith("prepare_ai_semantic_review", { request });
  invoke.mockResolvedValueOnce(fixture.responses.started);
  expect(await aiSemanticReviewCommands.start(fixture.requests.start)).toEqual(fixture.responses.started);
  expect(invoke).toHaveBeenLastCalledWith("start_ai_semantic_review", { request: fixture.requests.start });
  for (const result of [fixture.responses.absent, lookup("view"), lookup("recorded")]) {
    invoke.mockResolvedValueOnce(result);
    expect(await aiSemanticReviewCommands.read(fixture.requests.read)).toEqual(result);
    expect(invoke).toHaveBeenLastCalledWith("read_ai_semantic_review", { request: fixture.requests.read });
  }
});

it.each(["pair", "model", "rules", "selection"])("refuses a shape-valid preview for different captured %s", async changed => {
  const request: unknown = fixture.requests.prepare;
  if (!validators.validateRequestSemanticPrepare(request)) throw new Error("Invalid shared prepare request");
  const result = structuredClone(fixture.responses.prepared);
  if (changed === "pair") result.preview.items[0].source.targetLocale = "ja";
  if (changed === "model") result.preview.config.model = "unselected-model";
  if (changed === "rules") result.preview.rules = ["style"];
  if (changed === "selection") result.preview.items[0].selectionId = fixture.requests.read.attemptId;
  expect(validators.validateResponseSemanticPrepare(result)).toBe(true);
  invoke.mockResolvedValueOnce(result);
  await expect(aiSemanticReviewCommands.prepare(request)).rejects.toThrow();
});

it.each(["attempt", "item", "pair", "result", "model", "recipe", "basis"])("refuses shape-valid recorded evidence with mismatched %s", async changed => {
  const result = lookup("recorded"), view = result.view!;
  const row = view.rows[0], run = row.run!;
  if (changed === "attempt") result.attemptId = row.itemId;
  if (changed === "item") row.itemId = run.runId;
  if (changed === "pair") row.output!.targetLocale = "ja";
  if (changed === "result") run.evidence.resultId = run.runId;
  if (changed === "model") run.evidence.model = "different-review-model";
  if (changed === "recipe") run.evidence.recipe = "translation-recipe";
  if (changed === "basis") run.basisEvidence.revisionId = run.runId;
  expect(validators.validateResponseSemanticRead(result)).toBe(true);
  invoke.mockResolvedValueOnce(result);
  await expect(aiSemanticReviewCommands.read(fixture.requests.read)).rejects.toThrow();
});

it("keeps full unsigned token counters and rejects number substitution or invented model authority", () => {
  const result = lookup("recorded");
  expect(result.view!.rows[0].output!.usage!.promptTokens).toBe("18446744073709551615");
  const number = structuredClone(fixture.responses.view);
  const invalid: unknown = { ...number, view: { ...number.view, rows: [{ ...number.view.rows[0],
    output: { ...number.view.rows[0].output, usage: { ...number.view.rows[0].output.usage, promptTokens: 1, completionTokens: "1" } } }] } };
  expect(validators.validateResponseSemanticRead(invalid)).toBe(false);
  expect(validators.validateResponseSemanticRead({ ...result, view: { ...result.view,
    rows: [{ ...result.view!.rows[0], run: { ...result.view!.rows[0].run, approval: true } }] } })).toBe(false);
});

it.each([fixture.requests.prepare.projectId, null, {}])("treats an invalid start acknowledgement as unknown: %j", async result => {
  invoke.mockResolvedValueOnce(result);
  await expect(aiSemanticReviewCommands.start(fixture.requests.start)).rejects.toSatisfy(hasUnknownOutcome);
});


it("correlates original start proof with the full frozen preview and keeps temporary consent separate", async () => {
  const prepared = semanticPreparedFixture();
  const request = { projectId: fixtureIdentity(2400), sessionToken: "original-session", attemptId: prepared.attemptId, digest: prepared.preview.digest, confirmed: false };
  const saved = { projectId: request.projectId, attemptId: request.attemptId, taskId: fixtureIdentity(2490), inputDigest: "f".repeat(64), preview: prepared.preview };
  invoke.mockResolvedValueOnce(saved); expect(await aiSemanticReviewCommands.startAction(request, prepared.preview)).toEqual(saved);
  expect(invoke).toHaveBeenLastCalledWith("read_ai_semantic_review_start_action", { request });
  invoke.mockResolvedValueOnce(null); expect(await aiSemanticReviewCommands.startAction(request, prepared.preview)).toBeNull();
  invoke.mockResolvedValueOnce({ ...saved, taskId: "invalid" }); await expect(aiSemanticReviewCommands.startAction(request, prepared.preview)).rejects.toThrow();
});
