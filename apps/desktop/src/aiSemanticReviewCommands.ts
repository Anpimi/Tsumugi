import { sameAiConfig } from "./aiCommands";
import { sameExecutionIds } from "./executionCommands";
import { checkedInvoke } from "./ipc";
import { sameReviewBasis } from "./reviewDiagnosticNavigation";
import type { Requests } from "./generated/review.requests";
import type { Responses } from "./generated/review.responses";
import * as validators from "./generated/review.validators";

export type AiSemanticReviewPrepared = Responses["semanticPrepare"];
export type AiSemanticReviewLookup = Responses["semanticRead"];
export type AiSemanticReviewView = NonNullable<AiSemanticReviewLookup["view"]>;
export type AiSemanticReviewPreview = AiSemanticReviewPrepared["preview"];
export type AiSemanticReviewTarget = Requests["semanticPrepare"]["targets"][number];
export type AiSemanticReviewRule = Requests["semanticPrepare"]["rules"][number];

const pair = (unitId: string, locale: string) => JSON.stringify([unitId, locale]);
function validPreview(preview: AiSemanticReviewPreview) {
  return preview.recipe === "semantic-review-1" && preview.items.length > 0
    && preview.items.length <= preview.config.maxItems
    && preview.rules.length > 0 && new Set(preview.rules).size === preview.rules.length
    && new Set(preview.items.map(item => pair(item.source.unitId, item.source.targetLocale))).size === preview.items.length
    && preview.items.every(item => item.reviewBasis.selectionId === item.selectionId
      && item.reviewBasis.revisionId === item.translationRevisionId
      && item.reviewBasis.sourceRevisionId === item.source.sourceRevisionId
      && item.reviewBasis.sourceSnapshotId === item.source.sourceSnapshotId);
}

/** Shape validation and response correlation share the original IPC boundary. */
export function validAiSemanticReviewView(view: AiSemanticReviewView, attemptId: string) {
  const { preview, detail, rows } = view;
  if (!validPreview(preview) || detail.attemptId !== attemptId || detail.recovery.attemptId !== attemptId || detail.operation !== "ai-semantic-review"
    || detail.nextOffset !== null || detail.items.length !== preview.items.length || rows.length !== preview.items.length
    || !sameExecutionIds(rows.map(row => row.itemId), detail.items.map(item => item.status.itemId))) return false;
  const items = new Map(preview.items.map(item => [pair(item.source.unitId, item.source.targetLocale), item]));
  if (new Set(rows.map(row => pair(row.item.source.unitId, row.item.source.targetLocale))).size !== rows.length) return false;
  return rows.every(row => {
    const frozen = items.get(pair(row.item.source.unitId, row.item.source.targetLocale));
    const ledger = detail.items.find(item => item.status.itemId === row.itemId);
    if (!frozen || !ledger || ledger.scope.kind !== "review-unit" || ledger.scope.id !== frozen.source.unitId
      || ledger.scope.locale !== frozen.source.targetLocale || row.item.basis !== frozen.basis
      || row.item.translationText !== frozen.translationText || row.item.source.sourceText !== frozen.source.sourceText
      || !sameReviewBasis(row.item.reviewBasis, frozen.reviewBasis)) return false;
    const output = row.output;
    if (output && (ledger.resultId === null || output.unitId !== frozen.source.unitId
      || output.targetLocale !== frozen.source.targetLocale
      || !sameExecutionIds(output.rules.map(rule => rule.rule), preview.rules))) return false;
    const run = row.run;
    if (!run) return true;
    return !!output && run.purpose === "ai-semantic" && run.unitId === frozen.source.unitId
      && run.locale === frozen.source.targetLocale && run.basis === frozen.basis
      && sameReviewBasis(run.basisEvidence, frozen.reviewBasis)
      && run.evidence.attemptId === attemptId && run.evidence.itemId === row.itemId
      && run.evidence.resultId === ledger.resultId && run.evidence.recipe === preview.recipe
      && run.evidence.model === preview.config.model && run.evidence.endpoint === preview.config.endpoint;
  });
}

export const aiSemanticReviewCommands = {
  prepare: (request: Requests["semanticPrepare"]) => checkedInvoke("prepare_ai_semantic_review", request,
    (value): value is AiSemanticReviewPrepared => validators.validateResponseSemanticPrepare(value)
      && validPreview(value.preview) && sameAiConfig(value.preview.config, request.config)
      && sameExecutionIds(value.preview.rules, request.rules)
      && sameExecutionIds(value.preview.items.map(item => pair(item.source.unitId, item.source.targetLocale)),
        request.targets.map(target => pair(target.unitId, target.locale)))),
  start: (request: Requests["semanticStart"]) => checkedInvoke("start_ai_semantic_review", request,
    (value): value is Responses["semanticStart"] => {
      if (!validators.validateResponseSemanticStart(value) || value !== request.attemptId) {
        throw Object.assign(new Error("Invalid semantic review start acknowledgement"), { outcome: "unknown", reason: "invalid-ai-review-start" });
      }
      return true;
    }),
  read: (request: Requests["semanticRead"]) => checkedInvoke("read_ai_semantic_review", request,
    (value): value is AiSemanticReviewLookup => validators.validateResponseSemanticRead(value)
      && value.attemptId === request.attemptId && (value.view === null || validAiSemanticReviewView(value.view, request.attemptId))),
};
