import { expect, it } from "vitest";
import { currentSemanticDiagnosticRun, diagnosticIntentMatchesTarget, diagnosticMatchesEditor, diagnosticMatchesTarget, diagnosticTextareaSelection, reviewDiagnostics, type ReviewDiagnosticAnchor } from "./reviewDiagnosticNavigation";
import { reviewDiagnosticFixture } from "./testSupport/reviewDiagnosticFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { semanticDiagnosticFixture } from "./testSupport/semanticDiagnosticFixture";

it("maps only the standard textarea newline representation without changing saved text", () => {
  const text = "A\r\n👩🏽‍💻\rB\nZ";
  expect(diagnosticTextareaSelection(text, { encoding: "utf16", start: 3, end: 10 })).toEqual({ text: "A\n👩🏽‍💻\nB\nZ", start: 2, end: 9 });
  expect(text).toBe("A\r\n👩🏽‍💻\rB\nZ");
  expect(diagnosticTextareaSelection(text, { encoding: "utf16", start: 1, end: 3 })).toEqual({ text: "A\n👩🏽‍💻\nB\nZ", start: 1, end: 2 });
  expect(diagnosticTextareaSelection(text, { encoding: "utf16", start: 2, end: 3 })).toBeNull();
  expect(diagnosticTextareaSelection(text, { encoding: "utf16", start: 3, end: 4 })).toBeNull();
  expect(diagnosticTextareaSelection(text, { encoding: "utf16", start: 0, end: 999 })).toBeNull();
  expect(diagnosticTextareaSelection(text, { encoding: "grapheme", start: 1, end: 2 })).toBeNull();
});

it.each(["source", "selection", "revision", "run", "basis", "text", "translation", "context"])("rejects a changed %s before using a saved diagnostic", change => {
  const { editor, location, diagnostic } = reviewDiagnosticFixture();
  const anchor: ReviewDiagnosticAnchor = { projectId: fixtureIdentity(3790), sessionToken: "synthetic", value: structuredClone(location), diagnostic: { runId: location.runId, source: { purpose: "qa" }, diagnostic }, sourceText: editor.target.sourceText, translationText: editor.target.translationText, editSeq: 0 };
  expect(diagnosticMatchesEditor(anchor, editor)).toBe(true);
  if (change === "source") editor.target.sourceRevisionId = fixtureIdentity(3791);
  if (change === "selection") editor.target.selectionId = fixtureIdentity(3792);
  if (change === "revision") editor.target.revisionId = fixtureIdentity(3793);
  if (change === "run" && editor.target.currentCheck) editor.target.currentCheck.runId = fixtureIdentity(3794);
  if (change === "basis") editor.target.basis = "e".repeat(64);
  if (change === "text") editor.target.sourceText += "newer";
  if (change === "translation") editor.translations.currentText += "newer";
  if (change === "context") editor.target.basisEvidence.contextRevisionId = fixtureIdentity(3795);
  expect(diagnosticMatchesEditor(anchor, editor)).toBe(false);
});

it("keeps the exact SDK target scope separate from the Core UUID and another rule", () => {
  const { target, run, rule, diagnostic, location } = reviewDiagnosticFixture();
  expect(diagnostic.target).not.toBe(target.unitId); expect(diagnosticMatchesTarget(location, target)).toBe(true);
  run.evidence!.diagnostics.push({ ...diagnostic, target: target.unitId }, { ...diagnostic, key: { ...rule.key, rule: { ...rule.key.rule, id: "another.rule" } } });
  expect(reviewDiagnostics(run, rule, diagnostic.code)).toEqual([diagnostic]);
});

it("requires a distinct current semantic run without admitting it as mechanical QA", () => {
  const value = semanticDiagnosticFixture(), facts = { view: value.view, findings: value.findings };
  const intent = { runId: value.run.runId, source: value.source, diagnostic: value.diagnostic };
  expect(diagnosticMatchesTarget(value.location, value.target)).toBe(false);
  expect(diagnosticIntentMatchesTarget(intent, value.target, facts)).toBe(true);
  expect(value.target.currentCheck?.runId).toBe(value.qa.run.runId);
  expect(diagnosticIntentMatchesTarget({ ...intent, source: { purpose: "qa" } }, value.target, facts)).toBe(false);
  expect(diagnosticIntentMatchesTarget(intent, value.target)).toBe(false);
});

it.each(["run", "attempt", "item", "result", "resultDigest", "model", "endpoint", "recipe", "inputDigest", "semanticInputDigest", "scopeDigest", "basis", "locale", "current", "diagnostic"])("rejects mismatched semantic %s before using its location", change => {
  const value = semanticDiagnosticFixture(), origin = structuredClone(value.run.evidence);
  const intent = { runId: value.run.runId, source: { purpose: "ai-semantic" as const, origin }, diagnostic: structuredClone(value.diagnostic) };
  if (change === "run") value.findings.semanticRunId = fixtureIdentity(3999);
  if (change === "attempt") origin.attemptId = fixtureIdentity(3999);
  if (change === "item") origin.itemId = fixtureIdentity(3999);
  if (change === "result") origin.resultId = fixtureIdentity(3999);
  if (change === "resultDigest") origin.resultDigest = "9".repeat(64);
  if (change === "model") origin.model = "different-model";
  if (change === "endpoint") origin.endpoint = "https://other.example/v1/chat/completions";
  if (change === "recipe") origin.recipe = "different-recipe";
  if (change === "inputDigest") origin.inputDigest = "9".repeat(64);
  if (change === "semanticInputDigest") origin.semanticInputDigest = "9".repeat(64);
  if (change === "scopeDigest") origin.scopeDigest = "9".repeat(64);
  if (change === "basis") value.target.basis = "9".repeat(64);
  if (change === "locale") value.target.locale = "ja";
  if (change === "current") value.view.rows[0].current = false;
  if (change === "diagnostic") intent.diagnostic.detail = "Changed model diagnostic";
  expect(diagnosticIntentMatchesTarget(intent, value.target, { view: value.view, findings: value.findings })).toBe(false);
});

it("uses current semantic run identity even when no finding is on the first history page", () => {
  const value = semanticDiagnosticFixture(); value.findings.findings = [];
  expect(currentSemanticDiagnosticRun(value.target, value.run.runId, value.run.evidence, { view: value.view, findings: value.findings })).toBe(value.run);
  value.findings.semanticRunId = fixtureIdentity(3999);
  expect(currentSemanticDiagnosticRun(value.target, value.run.runId, value.run.evidence, { view: value.view, findings: value.findings })).toBeNull();
});
