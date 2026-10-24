import type { TextEncoding, TextReviewField } from "../generated/review.responses";
import type { ReviewFindingView } from "../reviewCommands";
import type { ReviewDiagnosticSource, SemanticDiagnosticRun } from "../reviewDiagnosticNavigation";
import { semanticPreparedFixture, semanticViewFixture } from "./aiSemanticReviewFixture";
import { reviewDiagnosticFixture } from "./reviewDiagnosticFixture";
import { reviewFindingViewFixture } from "./reviewFixture";
import { fixtureIdentity } from "./executionFixture";

/** Independent model advice alongside the unchanged mechanical QA fixture. */
export function semanticDiagnosticFixture(encoding: TextEncoding = "utf16", field: TextReviewField = "translation", newline = false, seed = 3900) {
  const qa = reviewDiagnosticFixture(encoding, field, newline), { target, editor } = qa;
  const prepared = semanticPreparedFixture(target); prepared.attemptId = fixtureIdentity(seed);
  const view = semanticViewFixture(prepared), row = view.rows[0];
  const key = { rule: { id: "meaning", schemaVersion: 1, behaviorVersion: 1 },
    implementation: { kind: "core" as const, validator: { id: "tsumugi.ai-semantic-review", schemaVersion: 1, behaviorVersion: 1 } } };
  const finding = { ...qa.finding, issueId: "a".repeat(64), rule: "meaning", code: "meaning-0-synthetic-spacing", detail: "Synthetic model diagnostic" };
  const diagnostic = { ...qa.diagnostic, key, code: finding.code, target: target.unitId, detail: finding.detail };
  const origin = { endpoint: prepared.preview.config.endpoint, model: prepared.preview.config.model, recipe: prepared.preview.recipe,
    attemptId: prepared.attemptId, itemId: row.itemId, inputDigest: "1".repeat(64), resultId: view.detail.items[0].resultId!,
    resultDigest: "2".repeat(64), semanticInputDigest: "3".repeat(64), scopeDigest: "4".repeat(64) };
  const run: SemanticDiagnosticRun = { purpose: "ai-semantic", runId: fixtureIdentity(seed + 1), actionId: fixtureIdentity(seed + 2),
    unitId: target.unitId, locale: target.locale, basis: target.basis, basisEvidence: target.basisEvidence, validatorVersion: "semantic-review-1",
    rules: [{ key, rule: "meaning", mandatory: false, status: "findings", reason: null, findings: [finding] }],
    diagnostics: [diagnostic], evidence: origin, createdAt: "2026-10-17T00:00:00Z" };
  row.run = run;
  row.output!.rules[0].findings = [{ code: "synthetic-spacing", detail: finding.detail, severity: "warning", location: diagnostic.location, suggestion: diagnostic.suggestion }];
  view.detail.items[0].status.adoption = "committed"; view.detail.progress.adopted = 1;
  view.detail.recovery.units[0].actions = ["view-receipt"]; view.detail.recovery.units[0].receiptId = run.actionId;
  const requirement = { key, inputDigest: origin.semanticInputDigest, scopeDigest: origin.scopeDigest, targets: [target.unitId], mandatory: false, waivable: false, notApplicable: null };
  const findings: ReviewFindingView = { ...reviewFindingViewFixture(target), semanticRunId: run.runId,
    findings: [{ runId: run.runId, purpose: "ai-semantic", aiOrigin: origin, finding, requirement, decision: null }] };
  const location = { ...qa.location, runId: run.runId };
  const source: ReviewDiagnosticSource = { purpose: "ai-semantic", origin };
  return { qa, target, editor, view, findings, run, diagnostic, finding, requirement, location, source };
}
