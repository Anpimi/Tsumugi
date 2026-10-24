import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/resourceCommands.contract.json";
import { resourceCommands } from "./resourceCommands";
import * as validators from "./generated/resource.validators";
import { hasUnknownOutcome } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it("validates both directions of every shared resource contract", async () => {
  for (const [validate, value] of [
    [validators.validateRequestSession, fixture.requests.session], [validators.validateRequestCaptures, fixture.requests.captures],
    [validators.validateRequestCapture, fixture.requests.capture], [validators.validateRequestTerm, fixture.requests.term],
    [validators.validateRequestDecision, fixture.requests.decision], [validators.validateRequestTerms, fixture.requests.terms],
    [validators.validateRequestTermHistory, fixture.requests.termHistory], [validators.validateRequestUnitLocale, fixture.requests.unitLocale],
    [validators.validateRequestContext, fixture.requests.context], [validators.validateRequestContextCapture, fixture.requests.contextCapture],
    [validators.validateRequestSuggestions, fixture.requests.suggestions], [validators.validateRequestImpacts, fixture.requests.impacts],
    [validators.validateResponseCaptures, fixture.responses.captures], [validators.validateResponseCapture, fixture.responses.capture],
    [validators.validateResponseCapture, null], [validators.validateResponsePreview, fixture.responses.preview],
    [validators.validateResponseDecision, fixture.responses.decision], [validators.validateResponseTerm, fixture.responses.term],
    [validators.validateResponseTerms, fixture.responses.terms], [validators.validateResponseResolution, fixture.responses.resolution],
    [validators.validateResponseContext, fixture.responses.context], [validators.validateResponseContext, null],
    [validators.validateResponseSavedContext, fixture.responses.savedContext], [validators.validateResponseContextCapture, fixture.responses.contextCapture],
    [validators.validateResponseSuggestions, fixture.responses.suggestions], [validators.validateResponseImpacts, fixture.responses.impacts],
  ] as const) expect(validate(value), validate.name).toBe(true);
  const decision = fixture.requests.decision;
  if (!validators.validateRequestDecision(decision)) throw new Error("Invalid resource fixture");
  for (const [command, request, response, run] of [
    ["list_resource_captures", fixture.requests.captures, fixture.responses.captures, () => resourceCommands.captures(fixture.requests.captures)],
    ["choose_resource_file", fixture.requests.session, null, () => resourceCommands.chooseFile(fixture.requests.session)],
    ["read_resource_preview", fixture.requests.capture, fixture.responses.preview, () => resourceCommands.preview(fixture.requests.capture)],
    ["decide_resource_entry", decision, fixture.responses.decision, () => resourceCommands.decide(decision)],
    ["save_term", fixture.requests.term, fixture.responses.term, () => resourceCommands.saveTerm(fixture.requests.term)],
    ["read_terms", fixture.requests.terms, fixture.responses.terms, () => resourceCommands.terms(fixture.requests.terms)],
    ["read_term_history", fixture.requests.termHistory, fixture.responses.terms, () => resourceCommands.termHistory(fixture.requests.termHistory)],
    ["resolve_terms", fixture.requests.unitLocale, fixture.responses.resolution, () => resourceCommands.resolve(fixture.requests.unitLocale)],
    ["read_context_revision", fixture.requests.unitLocale, null, () => resourceCommands.context(fixture.requests.unitLocale)],
    ["save_context", fixture.requests.context, fixture.responses.savedContext, () => resourceCommands.saveContext(fixture.requests.context)],
    ["capture_context", fixture.requests.contextCapture, fixture.responses.contextCapture, () => resourceCommands.captureContext(fixture.requests.contextCapture)],
    ["read_context_capture", fixture.requests.capture, fixture.responses.contextCapture, () => resourceCommands.readCapture(fixture.requests.capture)],
    ["tm_suggestions", fixture.requests.suggestions, fixture.responses.suggestions, () => resourceCommands.suggestions(fixture.requests.suggestions)],
    ["resource_impacts", fixture.requests.impacts, fixture.responses.impacts, () => resourceCommands.impacts(fixture.requests.impacts)],
  ] as const) {
    invoke.mockResolvedValueOnce(response);
    expect(await run()).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith(command, { request });
  }
});

it("preserves external term keys and Unicode without treating them as generated identities", () => {
  expect(fixture.responses.terms[1].termId).toBe("external:contract-glossary:barrel");
  expect(validators.validateResponseTerm(fixture.responses.terms[1])).toBe(true);
  expect(JSON.parse(JSON.stringify(fixture.responses.contextCapture))).toEqual(fixture.responses.contextCapture);
  expect(fixture.responses.term.target).toBe("木桶 👩🏽‍💻 é");
  const { termId: _term, expectedRevisionId: _revision, ...term } = fixture.requests.term.term;
  expect(validators.validateRequestTerm({ ...fixture.requests.term, term })).toBe(true);
});

it("rejects missing nested evidence, unknown states, invalid identities and primitive overflow", () => {
  expect(validators.validateRequestCaptures({ ...fixture.requests.captures, limit: 4294967295 })).toBe(true);
  expect(validators.validateRequestCaptures({ ...fixture.requests.captures, limit: 4294967296 })).toBe(false);
  expect(validators.validateResponseSuggestions([{ ...fixture.responses.suggestions[0], scorePercent: 256 }])).toBe(false);
  expect(validators.validateResponseSuggestions([{ ...fixture.responses.suggestions[0], matchKind: "best" }])).toBe(false);
  expect(validators.validateResponseSuggestions([{ ...fixture.responses.suggestions[0], originKind: "external" }])).toBe(false);
  expect(validators.validateResponseTerm({ ...fixture.responses.term, originKind: "import" })).toBe(false);
  expect(validators.validateResponseTerm({ ...fixture.responses.term, revisionId: "external:glossary:entry" })).toBe(false);
  expect(validators.validateResponseImpacts({ ...fixture.responses.impacts, items: [{ ...fixture.responses.impacts.items[0], status: "invalidated" }] })).toBe(false);
  expect(validators.validateResponseImpacts({ ...fixture.responses.impacts, nextOffset: 4294967296 })).toBe(false);
  const { omitted: _omitted, ...capture } = fixture.responses.contextCapture;
  expect(validators.validateResponseContextCapture(capture)).toBe(false);
  expect(validators.validateResponseContextCapture({ ...fixture.responses.contextCapture, included: [{ ...fixture.responses.contextCapture.included[0], extra: true }] })).toBe(false);
});

it("keeps malformed mutation acknowledgements unknown and preserves backend rejections", async () => {
  invoke.mockResolvedValueOnce({ ...fixture.responses.term, revisionId: "invalid" });
  await expect(resourceCommands.saveTerm(fixture.requests.term)).rejects.toSatisfy(hasUnknownOutcome);
  const decision = fixture.requests.decision;
  if (!validators.validateRequestDecision(decision)) throw new Error("Invalid resource fixture");
  invoke.mockResolvedValueOnce({ ...fixture.responses.decision, decision: "apply-all" });
  await expect(resourceCommands.decide(decision)).rejects.toSatisfy(hasUnknownOutcome);
  invoke.mockResolvedValueOnce({ ...fixture.responses.savedContext, previousRevisionId: 1 });
  await expect(resourceCommands.saveContext(fixture.requests.context)).rejects.toSatisfy(hasUnknownOutcome);
  const rejected = { code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", reason: "term-revision" };
  invoke.mockRejectedValueOnce(rejected);
  await expect(resourceCommands.saveTerm(fixture.requests.term)).rejects.toBe(rejected);
});

function decisionActionRequest() {
  const request = fixture.requests.decision;
  if (!validators.validateRequestDecision(request)) throw new Error("Invalid resource fixture");
  return request;
}

for (const [kind, original, receipt, run] of [
    ["term", fixture.requests.term.term, fixture.responses.term, () => resourceCommands.termAction(fixture.requests.term)],
    ["context", fixture.requests.context.context, fixture.responses.savedContext, () => resourceCommands.contextAction(fixture.requests.context)],
    ["capture", fixture.requests.contextCapture.capture, fixture.responses.contextCapture, () => resourceCommands.captureAction(fixture.requests.contextCapture)],
    ["decision", fixture.requests.decision.decision, fixture.responses.decision, () => resourceCommands.decisionAction(decisionActionRequest())],
] as const) it(`reads ${kind} only with a strict nullable complete original request echo`, async () => {
  invoke.mockResolvedValueOnce({ request: original, receipt });
  expect(await run()).toEqual(receipt);
  invoke.mockResolvedValueOnce(null); expect(await run()).toBeNull();
  for (const invalid of [undefined, {}, { request: original, receipt: undefined }]) {
    invoke.mockResolvedValueOnce(invalid); await expect(run()).rejects.toSatisfy(hasUnknownOutcome);
  }
  for (const [key, value] of Object.entries(original)) {
    const altered = value === null ? "ffffffff-ffff-4fff-8fff-ffffffffffff" : typeof value === "boolean" ? !value
      : typeof value === "number" ? value + 1 : Array.isArray(value) ? [...value, "changed"]
      : typeof value === "string" && /^[0-9a-f-]{36}$/.test(value) ? "ffffffff-ffff-4fff-8fff-ffffffffffff" : `${value}-changed`;
    invoke.mockResolvedValueOnce({ request: { ...original, [key]: altered }, receipt });
    await expect(run(), key).rejects.toSatisfy(hasUnknownOutcome);
    const missing = { ...original } as Record<string, unknown>; delete missing[key];
    invoke.mockResolvedValueOnce({ request: missing, receipt });
    await expect(run(), key).rejects.toSatisfy(hasUnknownOutcome);
  }
});
