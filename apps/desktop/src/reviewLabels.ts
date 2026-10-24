import type { TFunction } from "i18next";
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

/** Core labels describe Core policy. Domain identities remain opaque to the UI. */
export function reviewRuleLabel(t: TFunction, rule: string): string {
  if (rule === "required-translation") return t("review.ruleRequired");
  if (rule === "terminology") return t("review.ruleTerminology");
  return t("review.rulePlugin", { rule: rule.startsWith("plugin:") ? rule.slice(7) : rule });
}
export function reviewFindingLabel(t: TFunction, rule: string, code: string): string {
  if (rule === "required-translation") return t(code === "empty" ? "review.issueEmpty" : "review.issueMissing");
  if (rule === "terminology") return t(code === "conflict" ? "review.issueConflict" : "review.issueTerm");
  return t("review.issuePlugin", { code });
}
