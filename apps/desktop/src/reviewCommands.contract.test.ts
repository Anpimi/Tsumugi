import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/reviewCommands.contract.json";
import nativeEnvironment from "../test/fixtures/nativeRuntime.contract.json";
import { reviewCommands, confirmReviewFindingBasis, confirmReviewFindingEvidence, type ReviewCheckRequest, type ReviewFindingWrite, type ReviewFindingDecision } from "./reviewCommands";
import * as validators from "./generated/review.validators";
import { hasUnknownOutcome } from "./projectCommands";
import { reviewDiagnosticFixture } from "./testSupport/reviewDiagnosticFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const session = { projectId: fixture.requests.target.projectId, sessionToken: fixture.requests.target.sessionToken };
function decisionRequest() {
  const request = fixture.requests.decision;
  if (!validators.validateRequestDecision(request)) throw new Error("Invalid review fixture");
  return request;
}
beforeEach(() => invoke.mockReset());

it.each(["unit", "locale", "run", "field", "encoding"])("rejects an unrelated normalized diagnostic %s acknowledgement", async changed => {
  const { target, run, diagnostic, location } = reviewDiagnosticFixture();
  const request = { ...session, unitId: target.unitId, locale: target.locale, runId: run.runId, diagnostic };
  expect(validators.validateRequestDiagnosticLocation(request)).toBe(true);
  const response = structuredClone(location);
  if (changed === "unit") response.unitId = fixture.requests.target.projectId;
  if (changed === "locale") response.locale = "fr";
  if (changed === "run") response.runId = fixture.requests.target.unitId;
  if (changed === "field") response.location.field = "source";
  if (changed === "encoding") response.location.range.encoding = "utf8-byte";
  expect(validators.validateResponseDiagnosticLocation(response)).toBe(true);
  invoke.mockResolvedValue(response); await expect(reviewCommands.diagnosticLocation(request)).rejects.toThrow();
});

it("dispatches the complete original diagnostic through the official read-only boundary", async () => {
  const { target, run, diagnostic, location } = reviewDiagnosticFixture("grapheme");
  const request = { ...session, unitId: target.unitId, locale: target.locale, runId: run.runId, diagnostic };
  invoke.mockResolvedValue(location); expect(await reviewCommands.diagnosticLocation(request)).toEqual(location);
  expect(invoke).toHaveBeenCalledOnce(); expect(invoke).toHaveBeenCalledWith("read_review_diagnostic_location", { request });
});

it.each(["scope", "locale", "duplicate", "excluded"])("rejects a shape-valid but mismatched fixed scope acknowledgement: %s", async kind => {
  const request = { ...fixture.requests.scope, excluded: [] as string[] }, response = structuredClone(fixture.responses.scope);
  if (kind === "scope") response.scopeId = fixture.requests.target.unitId;
  if (kind === "locale") response.locale = "fr";
  if (kind === "duplicate") response.units.push(response.units[0]);
  if (kind === "excluded") request.excluded = [response.units[0].unitId];
  expect(validators.validateResponseScope(response)).toBe(true);
  invoke.mockResolvedValue(response);
  await expect(reviewCommands.captureScope(request)).rejects.toThrow();
});

it("receives the native profile and rejects mixed runtime fields or claimed authorization", () => {
  const value = structuredClone(fixture.responses.prepareCheck);
  const slot = value.view.checkers[0];
  const native = { ...value, view: { ...value.view, checkers: [{ ...slot, plugin: { ...slot.plugin, plugin: { ...slot.plugin.plugin,
    environment: nativeEnvironment, environmentDigest: "ba38dd6b1f63b641359cf711154563ce9d1616d4790f250e1718bb5c3f570ddd",
  } } }] } };
  expect(validators.validateResponsePrepareCheck(native)).toBe(true);
  for (const fields of [{ toolVersion: "26.10.0" }, { authorization: true }, { profile: "caller-native-path" }]) {
    const nativeSlot = native.view.checkers[0];
    const bad = { ...native, view: { ...native.view, checkers: [{ ...nativeSlot, plugin: { ...nativeSlot.plugin, plugin: { ...nativeSlot.plugin.plugin,
      environment: { ...nativeEnvironment, ...fields },
    } } }] } };
    expect(validators.validateResponsePrepareCheck(bad)).toBe(false);
  }
});

it("validates both directions of every shared review contract and dispatches the actual requests", async () => {
  expect(validators.validateRequestPage(fixture.requests.page), "requests.page").toBe(true);
  expect(validators.validateRequestTarget(fixture.requests.target), "requests.target").toBe(true);
  expect(validators.validateRequestSummary(fixture.requests.summary), "requests.summary").toBe(true);
  expect(validators.validateRequestNeighbor(fixture.requests.neighbor), "requests.neighbor").toBe(true);
  expect(validators.validateRequestScope(fixture.requests.scope), "requests.scope").toBe(true);
  expect(validators.validateRequestHistory(fixture.requests.history), "requests.history").toBe(true);
  expect(validators.validateRequestDecision(fixture.requests.decision), "requests.decision").toBe(true);
  expect(validators.validateRequestPrepareCheck(fixture.requests.prepareCheck)).toBe(true);
  expect(validators.validateResponsePrepareCheck(fixture.responses.prepareCheck)).toBe(true);
  expect(validators.validateRequestCheck(fixture.requests.check), "requests.check").toBe(true);
  expect(validators.validateRequestCancelCheck(fixture.requests.cancelCheck), "requests.cancelCheck").toBe(true);
  expect(validators.validateRequestWaiver(fixture.requests.waiver), "requests.waiver").toBe(true);
  expect(validators.validateRequestFallback(fixture.requests.fallback), "requests.fallback").toBe(true);
  expect(validators.validateRequestWork(fixture.requests.work), "requests.work").toBe(true);
  expect(validators.validateRequestEligibility(fixture.requests.eligibility), "requests.eligibility").toBe(true);
  expect(validators.validateResponsePage(fixture.responses.page), "responses.page").toBe(true);
  expect(validators.validateResponseTarget(fixture.responses.target), "responses.target").toBe(true);
  expect(validators.validateResponseSummary(fixture.responses.summary), "responses.summary").toBe(true);
  expect(validators.validateResponseNeighbor(fixture.responses.neighbor), "responses.neighbor").toBe(true);
  expect(validators.validateResponseScope(fixture.responses.scope), "responses.scope").toBe(true);
  expect(validators.validateResponseHistory(fixture.responses.history), "responses.history").toBe(true);
  expect(validators.validateResponseDecision(fixture.responses.decision), "responses.decision").toBe(true);
  expect(validators.validateResponseCheck(fixture.responses.check), "responses.check").toBe(true);
  expect(validators.validateResponseCancelCheck(fixture.responses.cancelCheck), "responses.cancelCheck").toBe(true);
  expect(validators.validateResponseWaiver(fixture.responses.waiver), "responses.waiver").toBe(true);
  expect(validators.validateResponseFallback(fixture.responses.fallback), "responses.fallback").toBe(true);
  expect(validators.validateResponseWork(fixture.responses.work), "responses.work").toBe(true);
  expect(validators.validateResponseEligibility(fixture.responses.eligibility), "responses.eligibility").toBe(true);
  expect(validators.validateResponseEditor(fixture.responses.editor), "responses.editor").toBe(true);
  const decision = decisionRequest();
  for (const [command, request, response, run] of [
    ["read_review_page", fixture.requests.page, fixture.responses.page, () => reviewCommands.page(fixture.requests.page)],
    ["read_review_target", fixture.requests.target, fixture.responses.target, () => reviewCommands.target(fixture.requests.target)],
    ["read_review_summary_page", fixture.requests.summary, fixture.responses.summary, () => reviewCommands.summaryPage(fixture.requests.summary)],
    ["read_review_neighbor", fixture.requests.neighbor, fixture.responses.neighbor, () => reviewCommands.neighbor(fixture.requests.neighbor)],
    ["capture_review_scope", fixture.requests.scope, fixture.responses.scope, () => reviewCommands.captureScope(fixture.requests.scope)],
    ["read_review_history", fixture.requests.history, fixture.responses.history, () => reviewCommands.history(fixture.requests.history)],
    ["write_review_decision", decision, fixture.responses.decision, () => reviewCommands.decide(session, decision.decision)],
    ["prepare_review_checks", fixture.requests.prepareCheck, fixture.responses.prepareCheck, () => reviewCommands.prepareCheck(fixture.requests.prepareCheck)],
    ["run_review_checks", fixture.requests.check, fixture.responses.check, () => reviewCommands.check(fixture.requests.check)],
    ["cancel_review_checks", fixture.requests.cancelCheck, fixture.responses.cancelCheck, () => reviewCommands.cancelCheck(fixture.requests.cancelCheck)],
    ["waive_review_issue", fixture.requests.waiver, fixture.responses.waiver, () => reviewCommands.waive(session, fixture.requests.waiver.waiver)],
    ["allow_source_fallback", fixture.requests.fallback, fixture.responses.fallback, () => reviewCommands.fallback(session, fixture.requests.fallback.fallback)],
    ["read_review_work", fixture.requests.work, fixture.responses.work, () => reviewCommands.work(fixture.requests.work)],
    ["read_review_eligibility", fixture.requests.eligibility, fixture.responses.eligibility, () => reviewCommands.eligibility(fixture.requests.eligibility)],
    ["read_review_editor_snapshot", fixture.requests.target, fixture.responses.editor, () => reviewCommands.editorSnapshot(fixture.requests.target)],
  ] as const) {
    invoke.mockResolvedValueOnce(response);
    expect(await run()).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith(command, { request });
  }
});

it("preserves full basis evidence, nested guidance and Unicode", () => {
  expect(fixture.responses.target.basisEvidence).toEqual(fixture.responses.decision.basisEvidence);
  expect(fixture.responses.editor.translations.rows[0].text).toBe("木桶 👩🏽‍💻 é");
  const { basisEvidence: _basis, ...target } = fixture.responses.target;
  expect(validators.validateResponseTarget(target)).toBe(false);
  expect(validators.validateResponseEditor({ ...fixture.responses.editor, target })).toBe(false);
  expect(validators.validateResponseCheck({ ...fixture.responses.check, outcome: "passed" })).toBe(false);
  expect(validators.validateResponseDecision({ ...fixture.responses.decision, kind: "accept-all" })).toBe(false);
  expect(validators.validateResponseHistory({ ...fixture.responses.history, checks: [{ ...fixture.responses.check, extra: true }] })).toBe(false);
  expect(validators.validateResponseSummary({ ...fixture.responses.summary, total: 4294967296 })).toBe(false);
  expect(validators.validateRequestNeighbor({ ...fixture.requests.neighbor, direction: -2147483648 })).toBe(true);
  expect(validators.validateRequestNeighbor({ ...fixture.requests.neighbor, direction: -2147483649 })).toBe(false);
  expect(validators.validateRequestNeighbor({ ...fixture.requests.neighbor, direction: 2147483648 })).toBe(false);
});

it("binds mutation confirmations to the original action, scope, basis and choice", async () => {
  const decision = decisionRequest();
  for (const change of [
    { actionId: fixture.responses.waiver.actionId }, { unitId: fixture.responses.decision.decisionId },
    { locale: "ja-JP" }, { basis: "different-basis" }, { kind: "approve" }, { reason: "different reason" },
    { basisEvidence: { ...fixture.responses.decision.basisEvidence, revisionId: fixture.responses.decision.decisionId } },
  ]) {
    invoke.mockResolvedValueOnce({ ...fixture.responses.decision, ...change });
    await expect(reviewCommands.decide(session, decision.decision)).rejects.toSatisfy(hasUnknownOutcome);
  }
  invoke.mockResolvedValueOnce({ ...fixture.responses.check, actionId: fixture.responses.waiver.actionId });
  await expect(reviewCommands.check(fixture.requests.check)).rejects.toSatisfy(hasUnknownOutcome);
  invoke.mockResolvedValueOnce({ ...fixture.responses.waiver, grant: false });
  await expect(reviewCommands.waive(session, fixture.requests.waiver.waiver)).rejects.toSatisfy(hasUnknownOutcome);
  invoke.mockResolvedValueOnce({ ...fixture.responses.fallback, allow: false });
  await expect(reviewCommands.fallback(session, fixture.requests.fallback.fallback)).rejects.toSatisfy(hasUnknownOutcome);
  expect(invoke).toHaveBeenCalledTimes(10);
});

it("keeps Serde None semantics and preserves explicit backend rejections", async () => {
  const decision = decisionRequest();
  const { expectedDecisionId: _expected, ...write } = decision.decision;
  expect(validators.validateRequestDecision({ ...decision, decision: write })).toBe(true);
  const { expectedWaiverId: _waiver, ...waiver } = fixture.requests.waiver.waiver;
  invoke.mockResolvedValueOnce(fixture.responses.waiver);
  expect(await reviewCommands.waive(session, waiver)).toEqual(fixture.responses.waiver);
  const rejected = { code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", reason: "review-current" };
  invoke.mockRejectedValueOnce(rejected);
  await expect(reviewCommands.decide(session, decision.decision)).rejects.toBe(rejected);
});

it("strictly receives the saved policy union and nested actual result projection", () => {
  expect(validators.validateResponseCheck(fixture.responses.check)).toBe(true);
  for (const field of ["sourceBinding", "advisoryChecks", "origins", "diagnostics"] as const) {
    const evidence = Object.fromEntries(Object.entries(fixture.responses.check.evidence).filter(([key]) => key !== field));
    expect(validators.validateResponseCheck({ ...fixture.responses.check, evidence }), field).toBe(false);
  }
  for (const field of ["key", "mandatory"] as const) {
    const rules = fixture.responses.check.rules.map(rule => Object.fromEntries(Object.entries(rule).filter(([key]) => key !== field)));
    expect(validators.validateResponseCheck({ ...fixture.responses.check, rules }), field).toBe(false);
  }
  expect(validators.validateResponseCheck({ ...fixture.responses.check, evidence: { ...fixture.responses.check.evidence,
    attemptId: fixture.responses.check.evidence.origins[0].attemptId } })).toBe(false);
  const extra = structuredClone(fixture.responses.check) as unknown as { evidence: { results: Array<{ key: { implementation: Record<string, unknown> } }> } };
  extra.evidence.results[0].key.implementation.permission = "granted";
  expect(validators.validateResponseCheck(extra)).toBe(false);
  const unknown = structuredClone(fixture.responses.check) as unknown as { evidence: { results: Array<{ outcome: { kind: string } }> } };
  unknown.evidence.results[0].outcome.kind = "passed";
  expect(validators.validateResponseCheck(unknown)).toBe(false);
});

it("checks the preparation acknowledgement against the exact review action and basis", async () => {
  const request = fixture.requests.prepareCheck;
  for (const change of [{ actionId: fixture.responses.check.runId }, { basis: "different" }, { locale: "ja-JP" }]) {
    invoke.mockResolvedValueOnce({ ...fixture.responses.prepareCheck, view: { ...fixture.responses.prepareCheck.view, ...change } });
    await expect(reviewCommands.prepareCheck(request)).rejects.toSatisfy(hasUnknownOutcome);
  }
  invoke.mockResolvedValueOnce({ kind: "recorded", run: fixture.responses.check });
  expect(await reviewCommands.prepareCheck(request)).toEqual({ kind: "recorded", run: fixture.responses.check });
});

it.each([null, fixture.responses.summary.scopeId])("rejects a wrong source snapshot in a summary captured at scope %s", async scopeId => {
  const page = fixture.responses.summary;
  const response = { ...page, rows: page.rows.map(row => ({ ...row, sourceSnapshotId: fixture.responses.waiver.waiverId })) };
  expect(validators.validateResponseSummary(response)).toBe(true);
  invoke.mockResolvedValueOnce(response);
  await expect(reviewCommands.summaryPage({ ...fixture.requests.summary, scopeId })).rejects.toThrow("Invalid IPC response: read_review_summary_page");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("rejects a summary for another fixed scope or language while preserving valid empty pages", async () => {
  const page = fixture.responses.summary;
  const request = { ...fixture.requests.summary, scopeId: page.scopeId };
  invoke.mockResolvedValueOnce({ ...page, scopeId: fixture.responses.waiver.waiverId });
  await expect(reviewCommands.summaryPage(request)).rejects.toThrow("Invalid IPC response: read_review_summary_page");
  invoke.mockResolvedValueOnce({ ...page, rows: page.rows.map(row => ({ ...row, locale: "ja" })) });
  await expect(reviewCommands.summaryPage(request)).rejects.toThrow("Invalid IPC response: read_review_summary_page");
  invoke.mockResolvedValueOnce({ ...page, rows: [] });
  expect(await reviewCommands.summaryPage(request)).toEqual({ ...page, rows: [] });
});


it("validates finding transport and exact action/evidence receipts without granting mandatory authority", async () => {
  const target: unknown = fixture.responses.target;
  if (!validators.validateResponseTarget(target)) throw new Error("Valid target required");
  const original: unknown = fixture.responses.check;
  if (!validators.validateResponseCheck(original)) throw new Error("Valid check required");
  const rule = original.rules.find(rule => rule.key.implementation.kind === "plugin");
  if (!rule) throw new Error("Captured provider required");
  const request: ReviewFindingWrite = { projectId: session.projectId, actionId: fixture.requests.decision.decision.actionId,
    unitId: target.unitId, locale: target.locale, expectedBasis: target.basis, runId: original.runId, issueId: "a".repeat(64),
    expectedDecisionId: null, disposition: "rejected", actor: "Synthetic reviewer", reason: "Original finding evidence" };
  const result: ReviewFindingDecision = { purpose: "qa", aiOrigin: null, decisionId: fixture.responses.decision.decisionId,
    request: { ...request, expectedDecisionId: request.expectedDecisionId ?? null },
    basisEvidence: target.basisEvidence, finding: { issueId: request.issueId, rule: rule.rule, code: "synthetic", detail: "Synthetic report", severity: "warning", waivable: false },
    requirement: { key: rule.key, inputDigest: "b".repeat(64), scopeDigest: "c".repeat(64), targets: [target.unitId], mandatory: false, waivable: false, notApplicable: null },
    createdAt: fixture.responses.decision.createdAt };
  const writeRequest = { ...session, finding: request };
  expect(validators.validateRequestFinding(writeRequest)).toBe(true);
  expect(validators.validateResponseFinding(result)).toBe(true);
  expect(validators.validateRequestFinding({ ...writeRequest, finding: { ...request, disposition: "waived" } })).toBe(false);
  invoke.mockResolvedValueOnce(result);
  expect(await reviewCommands.finding(session,request)).toEqual(result);
  expect(invoke).toHaveBeenLastCalledWith("write_review_finding",{request:writeRequest});
  invoke.mockResolvedValueOnce(result);
  expect(await reviewCommands.findingAction({...session,actionId:request.actionId})).toEqual(result);
  expect(invoke).toHaveBeenLastCalledWith("read_review_finding_action",{request:{...session,actionId:request.actionId}});
  const page = { unitId: target.unitId, locale: target.locale, basis: target.basis, runId: original.runId, semanticRunId: null,
    findings: [{ runId: original.runId, purpose: "qa" as const, aiOrigin: null, finding: result.finding, requirement: result.requirement, decision: result }], repairs: [], history: [result], nextOffset: null };
  invoke.mockResolvedValueOnce(page);
  expect(await reviewCommands.findings({...session,unitId:target.unitId,locale:target.locale,offset:0,limit:20})).toEqual(page);
  for (const invalid of [ { ...result, request: { ...request, reason: "Different reason" } },
    { ...result, request: { ...request, runId: target.unitId } },
    { ...result, requirement: { ...result.requirement, mandatory: true } } ]) {
    invoke.mockResolvedValueOnce(invalid);
    const error = await reviewCommands.finding(session,request).catch(value => value);
    expect(hasUnknownOutcome(error)).toBe(true);
    expect(error.reason).toBe("invalid-review-finding-receipt");
  }
  expect(()=>confirmReviewFindingBasis({...result,basisEvidence:{...result.basisEvidence,sourceRevisionId:target.unitId}},target.basisEvidence)).toThrow("Invalid review finding acknowledgement");
  expect(()=>confirmReviewFindingEvidence({...result,requirement:{...result.requirement,inputDigest:"d".repeat(64)}},page.findings[0])).toThrow("Invalid review finding acknowledgement");
  invoke.mockResolvedValueOnce({...page,findings:[{...page.findings[0],requirement:{...result.requirement,mandatory:true}}]});
  await expect(reviewCommands.findings({...session,unitId:target.unitId,locale:target.locale,offset:0,limit:20})).rejects.toThrow();
});

it("reads each complete human decision request without dispatching its mutation", async () => {
  const decision = { ...decisionRequest().decision, expectedDecisionId: fixture.requests.decision.decision.expectedDecisionId ?? null };
  const waiver = { ...fixture.requests.waiver.waiver, expectedWaiverId: fixture.requests.waiver.waiver.expectedWaiverId ?? null };
  const fallback = { ...fixture.requests.fallback.fallback, expectedFallbackId: fixture.requests.fallback.fallback.expectedFallbackId ?? null };
  for (const [command, request, response, read] of [
    ["read_review_decision_action", { ...session, decision }, { request: decision, receipt: fixture.responses.decision }, () => reviewCommands.decisionAction(session, decision)],
    ["read_review_waiver_action", { ...session, waiver }, { request: waiver, receipt: fixture.responses.waiver }, () => reviewCommands.waiverAction(session, waiver)],
    ["read_review_fallback_action", { ...session, fallback }, { request: fallback, receipt: fixture.responses.fallback }, () => reviewCommands.fallbackAction(session, fallback)],
  ] as const) {
    invoke.mockResolvedValueOnce(response);
    expect(await read()).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith(command, { request });
    invoke.mockResolvedValueOnce(null); expect(await read()).toBeNull();
  }
  expect(invoke).toHaveBeenCalledTimes(6);
});

it.each(["decision", "waiver", "fallback"] as const)("rejects incomplete or differently bound %s action echoes before receipt settlement", async kind => {
  const original = kind === "decision" ? { ...decisionRequest().decision, expectedDecisionId: null }
    : kind === "waiver" ? { ...fixture.requests.waiver.waiver, expectedWaiverId: null }
    : { ...fixture.requests.fallback.fallback, expectedFallbackId: null };
  const receipt = kind === "decision" ? fixture.responses.decision : kind === "waiver" ? fixture.responses.waiver : fixture.responses.fallback;
  const nullable = kind === "decision" ? "expectedDecisionId" : kind === "waiver" ? "expectedWaiverId" : "expectedFallbackId";
  const read = () => kind === "decision" ? reviewCommands.decisionAction(session, { ...decisionRequest().decision, expectedDecisionId: null })
    : kind === "waiver" ? reviewCommands.waiverAction(session, { ...fixture.requests.waiver.waiver, expectedWaiverId: null })
    : reviewCommands.fallbackAction(session, { ...fixture.requests.fallback.fallback, expectedFallbackId: null });
  const missing = { ...original } as Record<string, unknown>; delete missing[nullable];
  for (const response of [undefined, {}, { request: original },
    { request: missing, receipt }, { request: { ...original, [nullable]: fixture.requests.target.unitId }, receipt },
    ...["projectId", "actionId", "unitId", "locale", "expectedBasis", "actor", "reason"].map(key => ({ request: { ...original, [key]: key.endsWith("Id") ? fixtureIdentity(3300) : key === "locale" ? "fr" : "different" }, receipt })),
    { request: original, receipt: { ...receipt, actionId: fixture.requests.target.unitId } },
  ]) {
    invoke.mockResolvedValueOnce(response);
    await expect(read()).rejects.toSatisfy(hasUnknownOutcome);
  }
  const changed = kind === "decision" ? { ...original, kind: fixture.requests.decision.decision.kind === "approve" ? "request-changes" : "approve" }
    : kind === "waiver" ? { ...original, grant: !fixture.requests.waiver.waiver.grant }
    : { ...original, allow: !fixture.requests.fallback.fallback.allow };
  invoke.mockResolvedValueOnce({ request: changed, receipt });
  await expect(read()).rejects.toSatisfy(hasUnknownOutcome);
  expect(invoke.mock.calls.every(([command]) => command.startsWith("read_review_"))).toBe(true);
});


it("reads only the complete original normalized checker request and nullable final receipt", async () => {
  const request: ReviewCheckRequest = fixture.requests.prepareCheck;
  const expected = { projectId: request.projectId, actionId: request.actionId, unitId: request.unitId,
    locale: request.locale, expectedBasis: request.expectedBasis, advisoryChecks: request.advisoryChecks.map(choice => ({
      plugin: choice.package.plugin, packageDigest: choice.package.packageDigest, resourceId: choice.resourceId,
      environmentDigest: choice.environmentDigest, rules: choice.rules })) };
  const response = { request: expected, receipt: { ...fixture.responses.check, actionId: request.actionId,
    unitId: request.unitId, locale: request.locale, basis: request.expectedBasis } };
  expect(validators.validateRequestCheckAction(request)).toBe(true);
  expect(validators.validateResponseCheckAction(response)).toBe(true);
  invoke.mockResolvedValueOnce(response); expect(await reviewCommands.checkAction(request)).toEqual(response);
  expect(invoke).toHaveBeenLastCalledWith("read_review_check_action", { request });
  invoke.mockResolvedValueOnce(null); expect(await reviewCommands.checkAction(request)).toBeNull();
  for (const field of ["projectId", "actionId", "unitId", "locale", "expectedBasis"] as const) {
    invoke.mockResolvedValueOnce({ ...response, request: { ...expected, [field]: field.endsWith("Id") ? fixtureIdentity(3599) : "wrong" } });
    await expect(reviewCommands.checkAction(request)).rejects.toSatisfy(hasUnknownOutcome);
  }
  // Use an actual typed text selection to exercise every original advisory field.
  const text = (await import("./testSupport/textReviewFixture")).textReviewViewFixture();
  const choice = { package: { plugin: text.binding.checker.provider.plugin, packageDigest: text.binding.checker.provider.packageDigest },
    resourceId: text.resourceId, environmentDigest: text.environmentDigest, rules: text.rules };
  const withChoice = { ...request, advisoryChecks: [choice] };
  const selected = { plugin: choice.package.plugin, packageDigest: choice.package.packageDigest, resourceId: choice.resourceId,
    environmentDigest: choice.environmentDigest, rules: choice.rules };
  const chosenResponse = { ...response, request: { ...expected, advisoryChecks: [selected] } };
  invoke.mockResolvedValueOnce(chosenResponse); expect(await reviewCommands.checkAction(withChoice)).toEqual(chosenResponse);
  for (const changed of [{ ...selected, environmentDigest: "0".repeat(64) }, { ...selected, packageDigest: "0".repeat(64) },
    { ...selected, resourceId: "another" }, { ...selected, rules: [] }, { ...selected, plugin: { ...selected.plugin, version: "99.0.0" } }]) {
    invoke.mockResolvedValueOnce({ ...chosenResponse, request: { ...expected, advisoryChecks: [changed] } });
    await expect(reviewCommands.checkAction(withChoice)).rejects.toSatisfy(hasUnknownOutcome);
  }
  invoke.mockResolvedValueOnce({ ...response, executions: [] });
  await expect(reviewCommands.checkAction(request)).rejects.toSatisfy(hasUnknownOutcome);
});
