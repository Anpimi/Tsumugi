import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/aiCommands.contract.json";
import { aiCommands } from "./aiCommands";
import * as validators from "./generated/ai.validators";
import { hasUnknownOutcome } from "./projectCommands";
import type { AiView, CheckKey } from "./generated/ai.responses";
import { textReviewViewFixture } from "./testSupport/textReviewFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { ruleIdentity } from "./reviewIdentity";
import { unreportedTokenTotalsFixture } from "./testSupport/usageFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

function automaticViewFixture(): AiView {
  const view: unknown = structuredClone(fixture.responses.automaticView);
  if (!validators.validateResponseView(view)) throw new Error("Invalid automatic selection fixture");
  return view;
}
function receiptOf(view: AiView) {
  const receipt = view.rows[0].automation?.receipt;
  if (!receipt?.evidence) throw new Error("Captured selection evidence required");
  return { receipt, evidence: receipt.evidence };
}
function checkOnlyView(view = automaticViewFixture()): AiView {
  const { receipt } = receiptOf(view), effect = view.rows[0].automation;
  if (!effect) throw new Error("Candidate work required");
  effect.phase = "checked";
  receipt.policy = "candidates-only";
  receipt.policyVersion = "checked-selection-3";
  receipt.candidateBasis.selectionId = null;
  receipt.selection = null; receipt.checkRunId = null; receipt.blocked = null;
  return view;
}
function advisoryViewFixture(status: "findings" | "failed" | "unknown" | "unavailable"): AiView {
  const view = automaticViewFixture();
  const { receipt, evidence } = receiptOf(view);
  const formatRule = receipt.rules.find(rule => rule.key.implementation.kind === "plugin");
  const formatRequirement = evidence.requiredChecks.requirements.find(requirement => requirement.key.implementation.kind === "plugin");
  if (!formatRule || !formatRequirement) throw new Error("Format rule required");
  const text = textReviewViewFixture();
  const reference = structuredClone(formatRule.key.rule);
  text.rules = [reference];
  text.binding.declaration.rules = [{ ...text.binding.declaration.rules[0], rule: reference }];
  const key: CheckKey = { rule: reference, implementation: { kind: "plugin", provider: text.binding.checker.provider } };
  const requirement = { ...structuredClone(formatRequirement), key, mandatory: false, waivable: false, inputDigest: "e".repeat(64) };
  evidence.requiredChecks.requirements.push(requirement);
  evidence.advisoryChecks.push({ binding: text.binding, declarationResourceId: text.resourceId,
    execution: { capability: text.binding.checker, componentScope: "project", applicationScope: null,
      profile: text.binding.declaration.profile, environment: text.environment },
    resourcePins: text.resourcePins, rules: text.rules });
  evidence.origins.push({ checker: { provider: text.binding.checker.provider, profile: text.binding.declaration.profile },
    attemptId: fixtureIdentity(940), inputDigest: requirement.inputDigest, resultId: fixtureIdentity(941), resultDigest: "f".repeat(64),
    outcome: status === "failed" ? "failed" : status === "unknown" ? "unknown" : "succeeded" });
  receipt.rules.push({ ...structuredClone(formatRule), key, mandatory: false, status,
    reason: status === "findings" ? null : status === "failed" ? "Invocation failed; no check result"
      : status === "unknown" ? "Invocation outcome unknown; no check result" : "Check unavailable",
    findings: status === "findings" ? [{ rule: formatRule.rule, issueId: "f".repeat(64), code: "preferred-term-missing",
      severity: "warning", detail: "Use the preferred editorial term.", waivable: false }] : [] });
  if (status === "findings") {
    evidence.results.push({ key, inputDigest: requirement.inputDigest, scopeDigest: requirement.scopeDigest,
      coveredTargets: requirement.targets, outcome: { kind: "completed", findings: [{ code: "preferred-term-missing", severity: "warning", target: requirement.targets[0] }] } });
    evidence.diagnostics.push({ key, code: "preferred-term-missing", target: requirement.targets[0], location: null,
      detail: "Use the preferred editorial term.", suggestion: "Preferred form", resourceEntry: { contributionId: "terms", entryId: "preferred-form" } });
  } else if (status === "unavailable") {
    evidence.results.push({ key, inputDigest: requirement.inputDigest, scopeDigest: requirement.scopeDigest,
      coveredTargets: requirement.targets, outcome: { kind: "unavailable" } });
  }
  // Distinct wire fields cannot share mutable objects as the builder does.
  const observed: unknown = JSON.parse(JSON.stringify(view));
  if (!validators.validateResponseView(observed)) throw new Error("Invalid joint selection fixture");
  return observed;
}

it("reads a recorded candidate check without claiming a selected revision or current QA", async () => {
  const view = checkOnlyView();
  expect(validators.validateResponseView(view)).toBe(true);
  invoke.mockResolvedValueOnce(view);
  expect(await aiCommands.read(fixture.requests.automaticRead)).toEqual(view);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it.each(["findings", "failed", "unknown", "unavailable"] as const)("preserves complete check-only %s evidence without granting selection", async status => {
  const view = checkOnlyView(advisoryViewFixture(status));
  invoke.mockResolvedValueOnce(view);
  const read = await aiCommands.read(fixture.requests.automaticRead);
  expect(read.rows[0].automation?.receipt).toEqual(view.rows[0].automation?.receipt);
  expect(read.rows[0].automation?.phase).toBe("checked");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("rejects check-only receipts that claim selection, current QA, another candidate or another authority", async () => {
  const selected = receiptOf(automaticViewFixture()).receipt;
  const changes: ((view: AiView) => void)[] = [
    view => { receiptOf(view).receipt.selection = selected.selection; },
    view => { receiptOf(view).receipt.checkRunId = selected.checkRunId; },
    view => { receiptOf(view).receipt.blocked = "protected"; },
    view => { receiptOf(view).receipt.candidateBasis.selectionId = fixtureIdentity(942); },
    view => { receiptOf(view).receipt.candidateBasis.revisionId = fixtureIdentity(942); },
    view => { receiptOf(view).receipt.request.revisionId = fixtureIdentity(942); },
    view => { receiptOf(view).receipt.request.projectId = fixtureIdentity(942); },
    view => { receiptOf(view).receipt.request.lease.generation = "2"; },
    view => { receiptOf(view).receipt.request.actionId = fixtureIdentity(942); },
    view => { const effect = view.rows[0].automation; if (!effect) throw new Error("Missing effect"); effect.phase = "selected"; },
    view => { const effect = view.rows[0].automation; if (!effect) throw new Error("Missing effect"); effect.receipt = null; },
  ];
  for (const change of changes) {
    const view = checkOnlyView(); change(view);
    expect(validators.validateResponseView(view)).toBe(true);
    invoke.mockResolvedValueOnce(view);
    await expect(aiCommands.read(fixture.requests.automaticRead)).rejects.toThrow("automatic selection");
  }
});

it("validates both directions of every shared AI contract", async () => {
  for (const [validate, value] of [
    [validators.validateRequestPreview, fixture.requests.preview],
    [validators.validateRequestStart, fixture.requests.start],
    [validators.validateRequestRead, fixture.requests.read],
    [validators.validateRequestEffectRetry, fixture.requests.effectRetry],
    [validators.validateResponseEffectRetry, fixture.responses.effectRetry],
    [validators.validateResponseView, fixture.responses.automaticView],
    [validators.validateResponsePrepared, fixture.responses.prepared],
    [validators.validateResponseIdentity, fixture.responses.identity],
    [validators.validateResponseView, fixture.responses.view],
  ] as const) expect(validate(value), validate.name).toBe(true);
  for (const [command, request, response, run] of [
    ["preview_ai_translation", fixture.requests.preview, fixture.responses.prepared, () => aiCommands.preview(fixture.requests.preview)],
    ["start_ai_translation", fixture.requests.start, fixture.responses.identity, () => aiCommands.start(fixture.requests.start)],
    ["read_ai_translation", fixture.requests.read, fixture.responses.view, () => aiCommands.read(fixture.requests.read)],
    ["retry_work_plan_effect", fixture.requests.effectRetry, fixture.responses.effectRetry, () => aiCommands.retryEffect(fixture.requests.effectRetry)],
    ["read_ai_translation", fixture.requests.automaticRead, fixture.responses.automaticView, () => aiCommands.read(fixture.requests.automaticRead)],
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
  const budget = {limit:300,dispatched:2,legacyHeld:0,unresolved:1,usageUnknown:1,promptTokens:"5534023222112865484500",completionTokens:"0",...unreportedTokenTotalsFixture(2)};
  expect(validators.validateResponseView({...fixture.responses.view,budget})).toBe(true);
  for (const value of [1, "01", "-1", "1e2", "10000000000000000000000"]) expect(validators.validateResponseView({...fixture.responses.view,budget:{...budget,promptTokens:value}})).toBe(false);
  for (const value of [-1, 0.5, 301]) expect(validators.validateResponseView({...fixture.responses.view,budget:{...budget,dispatched:value}})).toBe(false);
  expect(validators.validateResponseView({...fixture.responses.view,budget:{...budget,extra:true}})).toBe(false);
});

describe("generated reported-usage wire", () => {
  it("requires nullable details and preserves canonical unsigned detail strings in actual AI responses", () => {
    const view = fixture.responses.view, row = view.rows[0];
    const usage = { ...row.output.usage, promptTokens: "18446744073709551615", completionTokens: "18446744073709551615" };
    expect(validators.validateResponseView(view)).toBe(true);
    for (const field of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
      for (const value of [null, "0", "18446744073709551615"]) {
        const reported = { ...usage, [field]: value };
        expect(validators.validateResponseView({ ...view, rows: [{ ...row, output: { ...row.output, usage: reported } }] }), `${field}: ${String(value)}`).toBe(true);
        expect(reported[field]).toBe(value);
      }
      const missing: Record<string, unknown> = { ...usage };
      delete missing[field];
      expect(validators.validateResponseView({ ...view, rows: [{ ...row, output: { ...row.output, usage: missing } }] }), `missing ${field}`).toBe(false);
      for (const value of [0, "01", "18446744073709551616"]) {
        expect(validators.validateResponseView({ ...view, rows: [{ ...row, output: { ...row.output, usage: { ...usage, [field]: value } } }] }), `${field}: ${String(value)}`).toBe(false);
      }
    }
  });

  it("requires all ledger detail totals with canonical decimal portions and bounded missing-request counts", () => {
    const view = fixture.responses.view;
    // The ordinary read has no ledger budget; the automatic-plan fixture has one.
    const budget = { ...fixture.responses.automaticView.budget, limit: 300, dispatched: 300, usageUnknown: 0 };
    for (const field of ["cacheRead", "cacheWrite", "reasoning"] as const) {
      for (const tokens of ["0", "18446744073709551615", "5534023222112865484500"]) {
        for (const unknownRequests of [0, 300]) {
          const reported = { tokens, unknownRequests };
          expect(validators.validateResponseView({ ...view, budget: { ...budget, [field]: reported } }), `${field}: ${tokens}, ${unknownRequests}`).toBe(true);
          expect(reported.tokens).toBe(tokens);
        }
      }
      const missing: Record<string, unknown> = { ...budget };
      delete missing[field];
      expect(validators.validateResponseView({ ...view, budget: missing }), `missing ${field}`).toBe(false);
      for (const value of [null, { tokens: "0" }, { unknownRequests: 0 },
        ...[0, "01", "10000000000000000000000"].map(tokens => ({ tokens, unknownRequests: 0 })),
        ...[-1, 301, 0.5, "0", null].map(unknownRequests => ({ tokens: "0", unknownRequests }))]) {
        expect(validators.validateResponseView({ ...view, budget: { ...budget, [field]: value } }), `${field}: ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });
});


it("binds policy receipts to the exact project, lease, candidate, action and mechanical evidence", async () => {
  const base = fixture.responses.automaticView;
  const malformed = [
    (view: typeof base) => { view.rows[0].automation.receipt.request.projectId = fixture.responses.view.rows[0].itemId; },
    (view: typeof base) => { view.rows[0].automation.receipt.request.lease.generation = "2"; },
    (view: typeof base) => { view.rows[0].automation.receipt.request.revisionId = fixture.responses.view.rows[0].itemId; },
    (view: typeof base) => { view.rows[0].automation.actionId = fixture.responses.view.rows[0].itemId; },
    (view: typeof base) => { view.rows[0].automation.receipt.selection.revisionId = fixture.responses.view.rows[0].itemId; },
    (view: typeof base) => { view.rows[0].automation.receipt.rules.pop(); },
    (view: typeof base) => { view.rows[0].automation.phase = "blocked"; },
    (view: typeof base) => { view.rows[0].automation.retryable = true; },
  ];
  for (const alter of malformed) {
    const view = structuredClone(base); alter(view); invoke.mockResolvedValueOnce(view);
    await expect(aiCommands.read(fixture.requests.automaticRead)).rejects.toThrow();
  }
  invoke.mockResolvedValueOnce(false);
  await expect(aiCommands.retryEffect(fixture.requests.effectRetry)).rejects.toSatisfy(hasUnknownOutcome);
});

it("receives the captured plugin union and rejects an injected nested authority field", async () => {
  const valid = structuredClone(fixture.responses.automaticView);
  expect(valid.rows[0].automation.receipt.rules.length).not.toBe(4);
  invoke.mockResolvedValueOnce(valid);
  expect(await aiCommands.read(fixture.requests.automaticRead)).toEqual(valid);
  const invalid = structuredClone(valid) as unknown as { rows: Array<{ automation: { receipt: { evidence: { results: Array<{ key: { implementation: Record<string, unknown> } }> } } } }> };
  invalid.rows[0].automation.receipt.evidence.results[0].key.implementation.permission = "granted";
  invoke.mockResolvedValueOnce(invalid);
  await expect(aiCommands.read(fixture.requests.automaticRead)).rejects.toThrow();
});

it("retains independent providers with equal rule names and nonblocking advisory observations", async () => {
  for (const status of ["findings", "failed", "unknown", "unavailable"] as const) {
    const view = advisoryViewFixture(status);
    const { receipt } = receiptOf(view);
    expect(receipt.rules[2].rule).toBe(receipt.rules[3].rule);
    expect(receipt.rules[2].key).not.toEqual(receipt.rules[3].key);
    expect(validators.validateResponseView(view)).toBe(true);
    invoke.mockResolvedValueOnce(view);
    const observed = await aiCommands.read(fixture.requests.automaticRead);
    expect(observed).toEqual(view);
    expect(receiptOf(observed).receipt.rules[3]).toMatchObject({ mandatory: false, status });
  }
});

it("rejects unrelated typed projections, changed action subsets and incomplete mandatory evidence", async () => {
  const changes: Array<(view: AiView) => void> = [
    view => { const { receipt } = receiptOf(view); receipt.rules[3].key = structuredClone(receipt.rules[2].key); },
    view => { const { receipt } = receiptOf(view); receipt.rules[3].key.implementation = structuredClone(receipt.rules[0].key.implementation); },
    view => { const { receipt } = receiptOf(view); const implementation = receipt.rules[3].key.implementation;
      if (implementation.kind !== "plugin") throw new Error("Plugin rule required"); implementation.provider.plugin.version = "0.2.0"; },
    view => { receiptOf(view).receipt.rules[3].key.rule.behaviorVersion = 2; },
    view => { receiptOf(view).receipt.rules[3].mandatory = true; },
    view => { receiptOf(view).evidence.advisoryChecks[0].rules = []; },
    view => { receiptOf(view).evidence.advisoryChecks[0].rules[0].schemaVersion = 2; },
    view => { const { evidence } = receiptOf(view); evidence.advisoryChecks.push(structuredClone(evidence.advisoryChecks[0])); },
    view => { const { receipt, evidence } = receiptOf(view); evidence.results = evidence.results.filter(result => ruleIdentity(result.key) !== ruleIdentity(receipt.rules[0].key)); },
    view => { receiptOf(view).receipt.rules[0].status = "unknown"; },
    view => { receiptOf(view).evidence.results[0].outcome = { kind: "failed" }; },
    view => { receiptOf(view).evidence.results[0].coveredTargets = ["different-unit"]; },
    view => { receiptOf(view).evidence.results[0].inputDigest = "f".repeat(64); },
    view => { receiptOf(view).evidence.results[0].scopeDigest = "f".repeat(64); },
    view => { const { receipt, evidence } = receiptOf(view); receipt.rules[0].status = "not-applicable";
      evidence.results[0].outcome = { kind: "not-applicable", basis: { code: "no-translation", basisDigest: "f".repeat(64) } }; },
    view => { receiptOf(view).evidence.sourceBinding.declaration.rules.push({ rule: { id: "another-format-rule", schemaVersion: 1, behaviorVersion: 1 }, requiresTranslation: false }); },
  ];
  for (const change of changes) {
    const view = advisoryViewFixture("findings");
    change(view);
    expect(validators.validateResponseView(view)).toBe(true);
    invoke.mockResolvedValueOnce(view);
    await expect(aiCommands.read(fixture.requests.automaticRead)).rejects.toThrow("automatic selection");
  }
});

it("requires a strict original-request receipt and correlates every start identity", async () => {
  const request = fixture.requests.start;
  const receipt = {projectId:request.projectId,attemptId:request.attemptId,taskId:fixture.responses.view.detail.taskId,digest:request.digest};
  for (const response of [null,receipt]) {
    invoke.mockResolvedValueOnce(response); expect(await aiCommands.startAction(request)).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith("read_ai_start_action",{request});
  }
  for (const response of [{...receipt,projectId:receipt.taskId},{...receipt,attemptId:receipt.taskId},
    {...receipt,digest:"wrong"},{...receipt,taskId:"invalid"},{...receipt,extra:true},{...receipt,taskId:undefined}]) {
    invoke.mockResolvedValueOnce(response); await expect(aiCommands.startAction(request)).rejects.toThrow();
  }
  invoke.mockResolvedValueOnce(receipt); await expect(aiCommands.startAction({...request,confirmed:false})).rejects.toThrow();
});
