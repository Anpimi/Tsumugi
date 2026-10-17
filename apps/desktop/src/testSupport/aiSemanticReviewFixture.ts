import fixture from "../../test/fixtures/aiCommands.contract.json";
import { validateResponsePrepared } from "../generated/ai.validators";
import { defaultAiConfig, type AiConfig } from "../aiCommands";
import type { AiSemanticReviewPrepared, AiSemanticReviewView } from "../aiSemanticReviewCommands";
import type { ReviewTarget } from "../reviewCommands";
import { aiViewFixture } from "./aiFixture";
import { fixtureIdentity } from "./executionFixture";
import { reviewTargetFixture } from "./reviewFixture";

export const semanticConfig: AiConfig = { ...defaultAiConfig, endpoint: "https://model.example/v1/chat/completions", model: "synthetic-review" };
export function semanticPreparedFixture(target = reviewTargetFixture({ basis: "d".repeat(64) }), config = semanticConfig): AiSemanticReviewPrepared {
  const original: unknown = structuredClone(fixture.responses.prepared);
  if (!validateResponsePrepared(original) || !target.selectionId || !target.revisionId || target.translationText === null) throw new Error("Selected saved review fixture required");
  const source = { ...original.preview.items[0], unitId: target.unitId, targetLocale: target.locale, sourceText: target.sourceText,
    sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId, nativeKey: target.nativeKey };
  return { attemptId: fixtureIdentity(2401), preview: { config, recipe: "semantic-review-1", rules: ["meaning", "style"], digest: "e".repeat(64),
    items: [{ source, selectionId: target.selectionId, translationRevisionId: target.revisionId, translationText: target.translationText,
      reviewBasis: target.basisEvidence, basis: target.basis }] } };
}
export function semanticViewFixture(prepared = semanticPreparedFixture()): AiSemanticReviewView {
  const item = prepared.preview.items[0], detail = aiViewFixture(item.source, prepared.preview.config).detail;
  detail.operation = "ai-semantic-review"; detail.attemptId = prepared.attemptId; detail.recovery.attemptId = prepared.attemptId;
  const scope = { kind: "review-unit", id: item.source.unitId, locale: item.source.targetLocale };
  detail.items[0].scope = scope; detail.recovery.units[0].scopes = [scope];
  return { preview: prepared.preview, detail, rows: [{ itemId: detail.items[0].status.itemId, item, run: null, current: true,
    output: { unitId: item.source.unitId, targetLocale: item.source.targetLocale, rules: prepared.preview.rules.map(rule => ({ rule, findings: [] })), requests: 1, usage: null, usageIncomplete: true } }] };
}
export function semanticTargetFixture(overrides: Partial<ReviewTarget> = {}) { return reviewTargetFixture({ basis: "d".repeat(64), ...overrides }); }
