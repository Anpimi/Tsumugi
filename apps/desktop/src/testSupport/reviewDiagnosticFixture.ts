import wire from "../../test/fixtures/reviewCommands.contract.json";
import { validateResponseCheck, validateResponseEditor } from "../generated/review.validators";
import type { TextEncoding, TextReviewField, TextReviewDiagnostic, CheckRuleResult } from "../generated/review.responses";
import type { ReviewDiagnosticLocation } from "../reviewCommands";
import { reviewCheckFixture } from "./reviewFixture";
import { pluginRuleKeyFixture } from "./textReviewFixture";
import { fixtureIdentity } from "./executionFixture";

/** Synthetic current Review evidence; the Host integration owns encoding conversion. */
export function reviewDiagnosticFixture(encoding: TextEncoding = "utf16", field: TextReviewField = "translation", newline = false) {
  const editor: unknown = structuredClone(wire.responses.editor), original: unknown = structuredClone(wire.responses.check);
  if (!validateResponseEditor(editor) || !validateResponseCheck(original) || !original.evidence || !editor.translations.current) throw new Error("Canonical saved Review fixtures required");
  const target = editor.target, prefix = newline ? "\r\n" : "";
  target.nativeKey = "Diagnostic entry"; target.sourceText = `A${prefix}👩🏽‍💻 é العربية Z`; target.translationText = `前${prefix}👩🏽‍💻 é עברית后`;
  target.currentDecision = null; target.currentWaivers = [];
  editor.translations.currentText = target.translationText;
  editor.translations.rows = editor.translations.rows.map(revision => ({ ...revision, text: revision.revisionId === target.revisionId ? target.translationText! : revision.text }));
  const key = pluginRuleKeyFixture("synthetic.locatable"), code = "synthetic-spacing";
  const finding = { issueId: "f".repeat(64), rule: "plugin:synthetic.locatable", code, detail: "Inspect the captured emoji cluster", severity: "warning", waivable: false };
  const rule: CheckRuleResult = { key, rule: finding.rule, mandatory: false, status: "findings", reason: null, findings: [finding] };
  const start = encoding === "utf16" ? (newline ? 3 : 1) : encoding === "grapheme" ? (newline ? 2 : 1) : (field === "translation" ? 3 : 1) + (newline ? 2 : 0);
  const end = start + (encoding === "utf16" ? 7 : encoding === "grapheme" ? 1 : 15);
  const diagnostic: TextReviewDiagnostic = { key, code, target: "sdk-operation-0", detail: finding.detail, suggestion: "Inspect without changing text",
    location: { field, range: { encoding, start, end } }, resourceEntry: null };
  const requirement = { key, inputDigest: "b".repeat(64), scopeDigest: "c".repeat(64), targets: [diagnostic.target], mandatory: false, waivable: false, notApplicable: null };
  const run = reviewCheckFixture(target, fixtureIdentity(3700), "completed", { runId: fixtureIdentity(3701), rules: [rule], evidence: {
    ...original.evidence, advisoryChecks: [], origins: [], qaBasis: "d".repeat(64), requiredChecks: { ...original.evidence.requiredChecks, requirements: [requirement] },
    diagnostics: [diagnostic], results: [{ key, inputDigest: requirement.inputDigest, scopeDigest: requirement.scopeDigest, coveredTargets: [diagnostic.target],
      outcome: { kind: "completed", findings: [{ code, severity: "warning", target: diagnostic.target }] } }],
  } });
  target.currentCheck = run;
  const location: ReviewDiagnosticLocation = { unitId: target.unitId, locale: target.locale, runId: run.runId, basis: target.basis,
    basisEvidence: target.basisEvidence, location: { field, range: { encoding: "utf16", start: newline ? 3 : 1, end: newline ? 10 : 8 } } };
  if (!validateResponseEditor(editor)) throw new Error("Invalid synthetic diagnostic editor");
  return { editor, target, run, rule, diagnostic, location, finding, requirement };
}
