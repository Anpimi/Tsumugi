import { reviewFindingLabel, reviewRuleLabel } from "./reviewLabels";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import type { EffectView } from "./generated/ai.responses";

/** A durable policy receipt describes past work, without asserting current selection or approval. */
export function AiEffectStatus({ effect, disabled, onRetry }: {
  effect: EffectView; disabled: boolean; onRetry: () => void;
}) {
  const { t } = useTranslation();
  const statusKeys: Record<string, "passed" | "notApplicable" | "findings" | "checkFailed" | "checkCancelled"> = { passed: "passed", "not-applicable": "notApplicable", findings: "findings", failed: "checkFailed", cancelled: "checkCancelled" };
  return <section aria-label={t("ai.effects.title")}>
    <p>{t(`ai.effects.phases.${effect.phase}`)}</p>
    {effect.receipt ? <>
      <p>{t("ai.effects.policy", { policy: effect.receipt.policyVersion })}</p>
      {effect.receipt.blocked ? <p>{t(`ai.effects.blocks.${effect.receipt.blocked}`)}</p> : null}
      <details><summary>{t("ai.effects.checks")}</summary><ul>{effect.receipt.rules.map(rule =>
        <li key={rule.rule}>{reviewRuleLabel(t, rule.rule)}: {t(`review.${statusKeys[rule.status] ?? "qaUnavailable"}`)}
          {rule.findings.length ? <ul>{rule.findings.map(finding => <li key={finding.issueId}>{reviewFindingLabel(t, rule.rule, finding.code)}</li>)}</ul> : null}</li>)}</ul></details>
    </> : null}
    {effect.error ? <div role="alert"><p>{t(`ai.errors.${effect.error.reason ?? "failed"}`, { defaultValue: t("ai.effects.failed") })}</p>
      <CommandFailureDetails failure={commandFailure(effect.error, "outcome-unknown")} /></div> : null}
    {effect.retryable ? <button className="secondary-button" disabled={disabled} onClick={onRetry}>{t("ai.effects.retry")}</button> : null}
  </section>;
}
