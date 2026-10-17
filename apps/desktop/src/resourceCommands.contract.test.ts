import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/resourceCommands.contract.json";
import { resourceCommands } from "./resourceCommands";
import * as validators from "./generated/resource.validators";
import { hasUnknownOutcome } from "./projectCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it("validates both directions of every shared resource contract", async () => {
  for (const [validate, value] of [
    [validators.validateRequestTmxPreview, fixture.requests.tmxPreview],
    [validators.validateResponseTmxPreview, fixture.responses.tmxPreview], [validators.validateResponseTmxPreview, null],
    [validators.validateRequestTbxPreview, fixture.requests.tbxPreview],
    [validators.validateResponseTbxPreview, fixture.responses.tbxPreview], [validators.validateResponseTbxPreview, null],
    [validators.validateRequestCorrectionBasis, fixture.requests.correctionBasis], [validators.validateRequestCorrectionCapture, fixture.requests.correctionCapture],
    [validators.validateRequestResourceAction, fixture.requests.resourceAction], [validators.validateResponseCorrectionBasis, fixture.responses.correctionBasis],
    [validators.validateResponseCorrectionCapture, fixture.responses.correctionCapture], [validators.validateResponseCorrectionAction, fixture.responses.correctionAction],
    [validators.validateResponseCorrectionAction, null], [validators.validateResponseDecisionAction, fixture.responses.decisionAction], [validators.validateResponseDecisionAction, null],
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
    ["preview_tmx_exchange", fixture.requests.tmxPreview, fixture.responses.tmxPreview, () => resourceCommands.previewTmx(fixture.requests.tmxPreview)],
    ["preview_tbx_exchange", fixture.requests.tbxPreview, fixture.responses.tbxPreview, () => resourceCommands.previewTbx(fixture.requests.tbxPreview)],
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

it("checks TMX report scope and treats picker cancellation as a read without granting file authority", async () => {
  expect(validators.validateRequestTmxPreview({ ...fixture.requests.tmxPreview, path: "/forged.tmx" })).toBe(false);
  expect(validators.validateResponseTmxPreview({ ...fixture.responses.tmxPreview,
    preview: { ...fixture.responses.tmxPreview.preview, license: "approved" } })).toBe(false);
  expect(validators.validateResponseTmxPreview({ ...fixture.responses.tmxPreview,
    preview: { ...fixture.responses.tmxPreview.preview, rows: [{ ...fixture.responses.tmxPreview.preview.rows[0], status: "imported" }] } })).toBe(false);
  invoke.mockResolvedValueOnce(null);
  await expect(resourceCommands.previewTmx(fixture.requests.tmxPreview)).resolves.toBeNull();
  for (const value of [
    { ...fixture.responses.tmxPreview, projectId: "30000000-0000-4000-8000-000000000099" },
    { ...fixture.responses.tmxPreview, preview: { ...fixture.responses.tmxPreview.preview, targetLocale: "de" } },
  ]) {
    invoke.mockResolvedValueOnce(value);
    await expect(resourceCommands.previewTmx(fixture.requests.tmxPreview)).rejects.toThrow("Invalid TMX preview association");
  }
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(invoke).toHaveBeenLastCalledWith("preview_tmx_exchange", { request: fixture.requests.tmxPreview });
});

it("preserves external term keys and Unicode without treating them as generated identities", () => {
  expect(fixture.responses.terms[1].termId).toBe("external:contract-glossary:barrel");
  expect(validators.validateResponseTerm(fixture.responses.terms[1])).toBe(true);
  expect(JSON.parse(JSON.stringify(fixture.responses.contextCapture))).toEqual(fixture.responses.contextCapture);
  expect(fixture.responses.term.target).toBe("木桶 👩🏽‍💻 é");
  const { termId: _term, expectedRevisionId: _revision, ...term } = fixture.requests.term.term;
  expect(validators.validateRequestTerm({ ...fixture.requests.term, term })).toBe(true);
});

it("checks TBX read scope and strict shape without upgrading file-reported terminology status", async () => {
  const request = fixture.requests.tbxPreview, response = fixture.responses.tbxPreview;
  expect(validators.validateRequestTbxPreview({ ...request, schemaHref: "forged.xsd" })).toBe(false);
  const withRow = (row: unknown) => ({ ...response, preview: { ...response.preview, rows: [row] } });
  const row = response.preview.rows[0], term = row.sourceTerms[0];
  expect(validators.validateResponseTbxPreview(withRow({ ...row, status: "adopted" }))).toBe(false);
  expect(validators.validateResponseTbxPreview(withRow({ ...row, sourceTerms: [{ ...term, ordinal: 4294967296 }] }))).toBe(false);
  expect(validators.validateResponseTbxPreview(withRow({ ...row, sourceTerms: [{ ...term, approved: true }] }))).toBe(false);
  expect(validators.validateResponseTbxPreview(withRow({ ...row, sourceTerms: [{ ...term, usageStatuses: ["file-reported-unknown"] }] }))).toBe(true);
  invoke.mockResolvedValueOnce(null);
  await expect(resourceCommands.previewTbx(request)).resolves.toBeNull();
  for (const value of [
    { ...response, projectId: "30000000-0000-4000-8000-000000000099" },
    { ...response, preview: { ...response.preview, targetLocale: "de" } },
  ]) {
    invoke.mockResolvedValueOnce(value);
    await expect(resourceCommands.previewTbx(request)).rejects.toThrow("Invalid TBX preview association");
  }
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(invoke).toHaveBeenLastCalledWith("preview_tbx_exchange", { request });
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

const savedActionCases = [
  { kind: "term", command: "read_term_save_action", request: fixture.requests.term,
    response: { request: fixture.requests.term.term, receipt: fixture.responses.term }, validate: validators.validateResponseTermAction,
    read: () => resourceCommands.termAction(fixture.requests.term),
    proofChanges: [{ termId: "different-term" }, { expectedRevisionId: fixtureIdentity(991) }, { aliases: ["Different alias"] }, { scopeUnitId: fixtureIdentity(992) }] },
  { kind: "context", command: "read_context_save_action", request: fixture.requests.context,
    response: { request: fixture.requests.context.context, receipt: fixture.responses.savedContext }, validate: validators.validateResponseContextAction,
    read: () => resourceCommands.contextAction(fixture.requests.context),
    proofChanges: [{ sourceRevisionId: fixtureIdentity(991) }, { expectedRevisionId: fixtureIdentity(992) }, { text: "Different context" }, { reason: "Different reason" }] },
  { kind: "capture", command: "read_context_capture_action", request: fixture.requests.contextCapture,
    response: { request: fixture.requests.contextCapture.capture, receipt: fixture.responses.contextCapture }, validate: validators.validateResponseContextCaptureAction,
    read: () => resourceCommands.contextCaptureAction(fixture.requests.contextCapture),
    proofChanges: [{ sourceRevisionId: fixtureIdentity(991) }, { budgetBytes: 1 }, { unitId: fixtureIdentity(992) }, { locale: "fr" }] },
] as const;

it.each(savedActionCases)("reads only the complete original $kind action and rejects schema-valid forged request echoes", async test => {
  expect(test.validate(test.response)).toBe(true); expect(test.validate(null)).toBe(true);
  invoke.mockResolvedValueOnce(test.response);
  await expect(test.read()).resolves.toEqual(test.response);
  expect(invoke).toHaveBeenLastCalledWith(test.command, { request: test.request });
  invoke.mockResolvedValueOnce(null); await expect(test.read()).resolves.toBeNull();
  for (const change of [{ actionId: fixtureIdentity(993) }, { projectId: fixtureIdentity(994) }, ...test.proofChanges]) {
    const forged = { ...test.response, request: { ...test.response.request, ...change } };
    expect(test.validate(forged)).toBe(true);
    invoke.mockResolvedValueOnce(forged); await expect(test.read()).rejects.toThrow(`Invalid IPC response: ${test.command}`);
  }
  for (const value of [undefined, { request: test.response.request }, { receipt: test.response.receipt }, { ...test.response, receipt: null }, { ...test.response, extra: true }]) {
    expect(test.validate(value)).toBe(false);
    invoke.mockResolvedValueOnce(value); await expect(test.read()).rejects.toThrow(`Invalid IPC response: ${test.command}`);
  }
  expect(invoke.mock.calls.every(([command]) => command === test.command)).toBe(true);
});


it("keeps correction source tags and exact resource action receipts strict", async () => {
  const basis = fixture.responses.correctionBasis;
  invoke.mockResolvedValueOnce(basis);
  await expect(resourceCommands.correctionBasis(fixture.requests.correctionBasis)).resolves.toEqual(basis);
  expect(invoke).toHaveBeenLastCalledWith("read_correction_term_basis", { request: fixture.requests.correctionBasis });
  const receipt = fixture.responses.correctionCapture;
  if (!validators.validateRequestCorrectionCapture(fixture.requests.correctionCapture)) throw new Error("Invalid correction fixture");
  invoke.mockResolvedValueOnce(receipt);
  await expect(resourceCommands.captureCorrection(fixture.requests.correctionCapture)).resolves.toEqual(receipt);
  invoke.mockResolvedValueOnce({ ...receipt, request: { ...receipt.request, target: "different" } });
  await expect(resourceCommands.captureCorrection(fixture.requests.correctionCapture)).rejects.toThrow("Invalid correction capture acknowledgement");
  invoke.mockResolvedValueOnce(null);
  await expect(resourceCommands.correctionAction(fixture.requests.resourceAction)).resolves.toBeNull();
  const decisionRequest = { ...fixture.requests.resourceAction, actionId: fixture.responses.decision.actionId };
  invoke.mockResolvedValueOnce(fixture.responses.decision);
  await expect(resourceCommands.decisionAction(decisionRequest)).resolves.toEqual(fixture.responses.decision);
  const { origin: _origin, ...missingOrigin } = receipt.capture;
  expect(validators.validateResponseCapture(missingOrigin)).toBe(false);
  const { correction: _correction, ...missingCorrection } = fixture.responses.preview;
  expect(validators.validateResponsePreview(missingCorrection)).toBe(false);
  const { request: _request, ...missingRequest } = fixture.responses.decision;
  expect(validators.validateResponseDecision(missingRequest)).toBe(false);
  expect(validators.validateResponseCapture({ ...receipt.capture, origin: { ...receipt.capture.origin, license: "invented" } })).toBe(false);
  invoke.mockResolvedValueOnce({ ...fixture.responses.preview, capture: receipt.capture });
  await expect(resourceCommands.preview({ ...fixture.requests.capture, captureId: receipt.capture.captureId })).rejects.toThrow();
  invoke.mockResolvedValueOnce({ ...fixture.responses.preview, correction: { evidence: basis, decision: null } });
  await expect(resourceCommands.preview(fixture.requests.capture)).rejects.toThrow();
});
