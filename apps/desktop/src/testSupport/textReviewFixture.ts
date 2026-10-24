//! Synthetic Desktop observations. These do not prove a Worker channel or SHA.
import wire from "../../test/fixtures/reviewCommands.contract.json";
import { validateResponsePrepareCheck, validateResponseCheck } from "../generated/review.validators";
import type { ReviewCheckerPreflightView, ReviewCheckerView, CheckKey } from "../generated/review.responses";
import type { PluginTextReviewView } from "../pluginCommands";
import { fixtureIdentity } from "./executionFixture";

export function formatReviewSlotFixture(): ReviewCheckerPreflightView & { plugin: Extract<ReviewCheckerView, { kind: "format" }> } {
  const prepared: unknown = structuredClone(wire.responses.prepareCheck);
  if (!validateResponsePrepareCheck(prepared) || prepared.kind !== "plugin") throw new Error("Invalid review fixture");
  const slot = prepared.view.checkers.find(slot => slot.plugin.kind === "format");
  if (!slot || slot.plugin.kind !== "format") throw new Error("Format fixture required");
  return { ...structuredClone(slot), plugin: structuredClone(slot.plugin) };
}
const contract = (id: string) => ({ id, schemaVersion: 1, behaviorVersion: 1 });

export function textReviewViewFixture(id = "text-support", digest = "c".repeat(64)): PluginTextReviewView {
  const format = formatReviewSlotFixture();
  const profile = contract("example.editorial-text");
  const rule = contract("example.preferred-form");
  return {
    settingsRevision: format.plugin.plugin.settingsRevision,
    resourceId: "text-review-profile",
    binding: {
      declaration: { profile, checker: "text-review-check", disposition: "advisory", supportingResources: ["terms"],
        rules: [{ rule, requiresTranslation: true, title: "Preferred form", description: "Inspect the selected editorial preference." },
          { rule: contract("example.source-note"), requiresTranslation: false, title: "Source note", description: "Inspect source wording." }] },
      checker: { provider: { plugin: { publisher: "example", id, version: "0.1.0" }, packageDigest: digest, componentId: "worker", contributionId: "text-review-check" },
        declaration: { contract: contract("example.text-review"), inputSchema: contract("tsumugi.text-review-input"),
          outputSchema: contract("tsumugi.text-review-report"), errorSchema: contract("tsumugi.review-check-error"), profiles: [profile],
          effect: "read-only", permissions: [{ kind: "captured-input" }], limits: { maxInputBytes: 65536, maxOutputBytes: 2097152, concurrency: 1, timeoutMs: 5000 } } },
      resources: [{ contributionId: "terms", schema: contract("example.editorial-resource") }],
    },
    resourcePins: [{ contributionId: "terms", schema: contract("example.editorial-resource"), sha256: "d".repeat(64) }],
    rules: [rule], packageOrigin: { sourceId: "manual-local", publisherId: "user-approved" },
    environment: format.plugin.plugin.environment, environmentDigest: format.plugin.plugin.environmentDigest,
    runtimeOrigin: format.plugin.plugin.runtimeOrigin,
  };
}

export function textReviewSlotFixture(view = textReviewViewFixture(), seed = 930): ReviewCheckerPreflightView {
  return { checker: { provider: view.binding.checker.provider, profile: view.binding.declaration.profile },
    attemptId: fixtureIdentity(seed), inputDigest: "e".repeat(64), plugin: { kind: "advisory-text", plugin: view } };
}
export function pluginRuleKeyFixture(id: string): CheckKey {
  return { rule: contract(id), implementation: { kind: "plugin", provider: formatReviewSlotFixture().checker.provider } };
}

export function coreRuleKeyFixture(rule: "required-translation" | "terminology"): CheckKey {
  const checked: unknown = structuredClone(wire.responses.check);
  if (!validateResponseCheck(checked)) throw new Error("Invalid check fixture");
  const match = checked.rules.find(value => value.rule === rule && value.key.implementation.kind === "core");
  if (!match) throw new Error("Core policy rule required");
  return match.key;
}
