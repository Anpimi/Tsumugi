import { expect, it } from "vitest";
import { diagnosticMatchesEditor, diagnosticMatchesTarget, diagnosticTextareaSelection, reviewDiagnostics, type ReviewDiagnosticAnchor } from "./reviewDiagnosticNavigation";
import { reviewDiagnosticFixture } from "./testSupport/reviewDiagnosticFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";

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
  const { editor, location } = reviewDiagnosticFixture();
  const anchor: ReviewDiagnosticAnchor = { projectId: fixtureIdentity(3790), sessionToken: "synthetic", value: structuredClone(location), sourceText: editor.target.sourceText, translationText: editor.target.translationText, editSeq: 0 };
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
