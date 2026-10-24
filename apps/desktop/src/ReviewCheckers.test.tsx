import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import wire from "../test/fixtures/reviewCommands.contract.json";
import { ReviewDiagnosticDetails } from "./ReviewCheckers";
import { validateResponseCheck } from "./generated/review.validators";
import type { CheckKey, CheckRuleResult, TextReviewDiagnostic } from "./generated/review.responses";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { textReviewViewFixture } from "./testSupport/textReviewFixture";

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en-US");
});

it("offers only an explicit read-only location for the exact current SDK diagnostic", async () => {
  const { run, rule, code } = diagnosticFixture(), locate = vi.fn();
  const ui = render(<ReviewDiagnosticDetails run={run} rule={rule} code={code} onLocate={locate} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Locate in translation" }));
  expect(locate).toHaveBeenCalledOnce(); expect(locate).toHaveBeenCalledWith(run.evidence!.diagnostics[0]);
  ui.rerender(<ReviewDiagnosticDetails run={run} rule={rule} code={code} />);
  expect(screen.queryByRole("button", { name: "Locate in translation" })).not.toBeInTheDocument();
  expect(screen.getByText(/Historical range/)).toBeVisible();
});

function diagnosticFixture() {
  // Synthetic rendering observations do not establish a Worker channel.
  const run: unknown = structuredClone(wire.responses.check);
  if (!validateResponseCheck(run) || !run.evidence) throw new Error("Captured QA fixture required");
  const text = textReviewViewFixture();
  const key: CheckKey = { rule: structuredClone(text.rules[0]),
    implementation: { kind: "plugin", provider: structuredClone(text.binding.checker.provider) } };
  const code = "preferred-term-missing";
  const rule: CheckRuleResult = { key, rule: `plugin:${key.rule.id}`, mandatory: false, status: "findings", reason: null,
    findings: [{ issueId: "f".repeat(64), rule: `plugin:${key.rule.id}`, code, severity: "warning", waivable: false,
      detail: "Captured detail 👩🏽‍💻 é" }] };
  run.rules.push(rule);
  const evidence = run.evidence;
  evidence.requiredChecks.requirements.push({ key: structuredClone(key), inputDigest: "e".repeat(64), scopeDigest: "e".repeat(64),
    targets: ["cue-0"], mandatory: false, waivable: false, notApplicable: null });
  evidence.advisoryChecks.push({ binding: text.binding, declarationResourceId: text.resourceId,
    execution: { capability: text.binding.checker, componentScope: "project", applicationScope: null,
      profile: text.binding.declaration.profile, environment: text.environment },
    resourcePins: text.resourcePins, rules: text.rules });
  evidence.origins.push({ checker: { provider: text.binding.checker.provider, profile: text.binding.declaration.profile },
    attemptId: fixtureIdentity(950), inputDigest: "e".repeat(64), resultId: fixtureIdentity(951), resultDigest: "f".repeat(64), outcome: "succeeded" });
  evidence.results.push({ key: structuredClone(key), inputDigest: "e".repeat(64), scopeDigest: "e".repeat(64), coveredTargets: ["cue-0"],
    outcome: { kind: "completed", findings: [{ code, severity: "warning", target: "cue-0" }] } });
  const diagnostic: TextReviewDiagnostic = { key: structuredClone(key), code, target: "cue-0", detail: "Captured detail 👩🏽‍💻 é",
    suggestion: "Preferred wording", location: { field: "translation", range: { encoding: "utf16", start: 2, end: 8 } },
    resourceEntry: { contributionId: "terms", entryId: "preferred-form" } };
  const otherRule = { ...structuredClone(key), rule: { ...key.rule, id: "example.other-rule" } };
  const otherProvider = structuredClone(key);
  if (otherProvider.implementation.kind !== "plugin") throw new Error("Plugin fixture required");
  otherProvider.implementation.provider.packageDigest = "f".repeat(64);
  // Deliberately unrelated observations must not leak into this finding.
  evidence.diagnostics = [diagnostic,
    { ...structuredClone(diagnostic), key: otherRule, detail: "Other rule detail" },
    { ...structuredClone(diagnostic), key: otherProvider, detail: "Other provider detail" },
    { ...structuredClone(diagnostic), target: "cue-1", detail: "Other SDK target detail" },
    { ...structuredClone(diagnostic), target: run.unitId, detail: "Core UUID is not the SDK target" },
    { ...structuredClone(diagnostic), code: "another-finding", detail: "Other finding detail" }];
  return { run, rule, code };
}

it.each([
  ["en-US", "Technical details", "Selected translation · utf16 range 2–8", "Suggested wording: Preferred wording", "Resource terms · entry preferred-form"],
  ["zh-CN", "技术详情", "已选译文 · utf16 区间 2–8", "建议用语：Preferred wording", "资源 terms · 条目 preferred-form"],
])("joins SDK diagnostics to the exact captured rule scope independently of the Core UUID in %s", async (locale, details, range, suggestion, resource) => {
  await i18n.changeLanguage(locale);
  const { run, rule, code } = diagnosticFixture();
  expect(run.unitId).not.toBe("cue-0");
  expect(validateResponseCheck(run)).toBe(true);
  render(<ReviewDiagnosticDetails run={run} rule={rule} code={code} />);
  expect(screen.getByText("Captured detail 👩🏽‍💻 é")).toBeVisible();
  expect(screen.getByText(suggestion)).toBeVisible();
  for (const detail of ["Other rule detail", "Other provider detail", "Other SDK target detail", "Core UUID is not the SDK target", "Other finding detail"])
    expect(screen.queryByText(detail)).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByText(details));
  expect(screen.getByText(range)).toBeVisible();
  expect(screen.getByText(resource)).toBeVisible();
});
