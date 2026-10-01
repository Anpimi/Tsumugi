import type { TranslationKey } from "./i18n/types";

/** A queue, source-impact row and build blocker describe the same current evidence. */
export function reviewReasonKey(value: string): TranslationKey {
  if (value.startsWith("translation-") || value.startsWith("source-fallback")) return "review.queueReasonTranslation";
  if (value.startsWith("approval-")) return "review.queueReasonApproval";
  if (value === "changes-requested") return "review.queueReasonChanges";
  if (value.startsWith("qa-missing")) return "review.queueReasonQa";
  if (value.startsWith("qa-issue")) return "review.queueReasonIssue";
  if (value.startsWith("resource-")) return "review.queueReasonResource";
  if (value === "term-conflict") return "review.issueConflict";
  return "review.queueReasonCoverage";
}
