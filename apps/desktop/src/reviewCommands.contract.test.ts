import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/reviewCommands.contract.json";
import { reviewCommands } from "./reviewCommands";
import * as validators from "./generated/review.validators";
import { hasUnknownOutcome } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const session = { projectId: fixture.requests.target.projectId, sessionToken: fixture.requests.target.sessionToken };
function decisionRequest() {
  const request = fixture.requests.decision;
  if (!validators.validateRequestDecision(request)) throw new Error("Invalid review fixture");
  return request;
}
beforeEach(() => invoke.mockReset());

it("validates both directions of every shared review contract and dispatches the actual requests", async () => {
  expect(validators.validateRequestPage(fixture.requests.page), "requests.page").toBe(true);
  expect(validators.validateRequestTarget(fixture.requests.target), "requests.target").toBe(true);
  expect(validators.validateRequestSummary(fixture.requests.summary), "requests.summary").toBe(true);
  expect(validators.validateRequestNeighbor(fixture.requests.neighbor), "requests.neighbor").toBe(true);
  expect(validators.validateRequestScope(fixture.requests.scope), "requests.scope").toBe(true);
  expect(validators.validateRequestHistory(fixture.requests.history), "requests.history").toBe(true);
  expect(validators.validateRequestDecision(fixture.requests.decision), "requests.decision").toBe(true);
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
