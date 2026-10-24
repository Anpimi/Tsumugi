import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import type { AiUsageView, ProviderBudget, ReportedTokenTotal, Usage } from "./generated/ai.responses";

const details = [
  ["cacheReadTokens", "cacheRead", "ai.usageDetails.cacheRead"],
  ["cacheWriteTokens", "cacheWrite", "ai.usageDetails.cacheWrite"],
  ["reasoningTokens", "reasoning", "ai.usageDetails.reasoning"],
] as const;

/** Render reported facts without converting decimal strings or estimating billing. */
export function AiOutputUsage({ usage, incomplete }: { usage: AiUsageView | Usage | null; incomplete: boolean }) {
  const { t } = useTranslation();
  return <>
    <p>{usage ? t("ai.usage", { ...usage, defaultValue: enUS.ai.usage }) : t("ai.usageUnknown")}</p>
    {usage && incomplete ? <p>{t("ai.usageDetails.partialTotals")}</p> : null}
    {usage ? <details><summary>{t("ai.usageDetails.title")}</summary><p>{t("ai.usageDetails.subsets")}</p>
      <dl>{details.map(([field, , label]) => {
        const tokens = usage[field];
        return <div key={field}><dt>{t(label)}</dt><dd>{tokens === null
          ? t("ai.usageDetails.notReported") : t("ai.usageDetails.reported", { tokens })}</dd></div>;
      })}</dl>
    </details> : null}
    <p>{t("ai.usageDetails.billingUnknown")}</p>
  </>;
}

function BudgetTokenValue({ value }: { value: ReportedTokenTotal }) {
  const { t } = useTranslation();
  return value.unknownRequests > 0 ? t("ai.usageDetails.partial", { tokens: value.tokens, requests: String(value.unknownRequests) })
    : t("ai.usageDetails.reported", { tokens: value.tokens });
}

/** The original provider ledger owns totals, holds and per-dimension missing reports. */
export function AiProviderBudget({ budget }: { budget: ProviderBudget }) {
  const { t } = useTranslation();
  return <>
    <p>{t("ai.budgetSummary", { ...budget, defaultValue: enUS.ai.budgetSummary })}</p>
    <p>{t("ai.budgetUsage", { ...budget, defaultValue: enUS.ai.budgetUsage })}</p>
    {budget.legacyHeld > 0 ? <p>{t("ai.legacyBudget", { count: budget.legacyHeld, defaultValue: enUS.ai.legacyBudget })}</p> : null}
    <details><summary>{t("ai.usageDetails.title")}</summary><p>{t("ai.usageDetails.subsets")}</p>
      <dl>{details.map(([, field, label]) => <div key={field}><dt>{t(label)}</dt><dd><BudgetTokenValue value={budget[field]}/></dd></div>)}</dl>
    </details>
    <p>{t("ai.usageDetails.billingUnknown")}</p>
  </>;
}
