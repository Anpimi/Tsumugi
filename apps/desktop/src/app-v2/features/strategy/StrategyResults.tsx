import { useTranslation } from "react-i18next";
import type { StrategyOwner } from "../../../StrategyDraftSession";
import type { StrategyEvaluationView } from "../../../strategyCommands";
import type { ArenaView } from "../../../arenaCommands";
import { mandatoryChecksClean } from "../../../aiCommands";
import { AiOutputUsage, AiProviderBudget } from "../../../AiUsage";
import { ReviewCheckerDetails, checkerIdentity, ruleIdentity } from "../../../ReviewCheckers";
import { reviewRuleLabel } from "../../../reviewLabels";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { TokenizedText } from "../../../design-system/TokenizedText";
import styles from "./StrategyView.module.css";

export interface StrategyResultsProps {
  owner: StrategyOwner;
  view: StrategyEvaluationView;
  arena: ArenaView;
  disabled: boolean;
  current: () => boolean;
  inputAllowed: () => boolean;
  onOpenEntry?: (unitId: string, locale: string) => Promise<boolean>;
}

/** Roles and check eligibility come from the original evaluation, never Arena's blind labels. */
export function StrategyResults({ owner, view, arena, disabled, current, inputAllowed, onOpenEntry }: StrategyResultsProps) {
  const { t } = useTranslation(), state = owner.state;
  const progress = arena.detail.progress, active = progress.queued > 0 || progress.running > 0;
  const locked = () => disabled || !current() || owner.reserved() || !owner.evaluationCurrent(view);
  const groups = [...new Set(arena.rows.map(row => row.sourceOrder))];
  return <div className={styles.results}>
    <p role={active ? "status" : undefined}>{t("strategyView.progress", { completed: progress.succeeded, total: progress.total,
      queued: progress.queued, running: progress.running, failed: progress.failed, cancelled: progress.cancelled, unknown: progress.unknown })}</p>
    {active ? <p className={styles.help}>{t("strategy.running")}</p> : null}
    <div className={styles.usage}>{arena.budget ? <AiProviderBudget budget={arena.budget}/> : <p>{t("ai.usageUnknown")}</p>}<p>{t("ai.costUnknown")}</p></div>
    <p className={styles.help}>{t("strategy.qaHelp")}</p><p className={styles.help}>{t("strategyView.saveResultHelp")}</p>
    {groups.map(order => {
      const rows = arena.rows.filter(row => row.sourceOrder === order), first = rows[0];
      if (!first) return null;
      const unitId = first.item.unitId, suiteUnit = view.suite.units.find(unit => unit.unitId === unitId);
      const saved = view.judgments.find(judgment => judgment.request.unitId === unitId);
      const draft = state.judgments[unitId] ?? { preference: saved?.request.preference ?? "", notes: saved?.request.notes ?? "",
        elapsed: saved?.request.elapsedSeconds?.toString() ?? "", modified: saved?.request.modifiedCharacters?.toString() ?? "" };
      function edit(change: Partial<typeof draft>) {
        if (inputAllowed()) owner.editJudgment(unitId, { preference: draft.preference, notes: draft.notes, elapsed: draft.elapsed, modified: draft.modified, ...change });
      }
      return <section key={unitId} className={styles.resultUnit} aria-label={first.item.nativeKey}>
        <header className={styles.sectionHeader}><h3>{first.item.nativeKey}</h3><span>{t(suiteUnit?.holdout ? "strategy.holdout" : "strategy.calibration")}</span></header>
        <div className={styles.text}><TokenizedText text={first.item.sourceText}/></div>
        {onOpenEntry ? <div className={styles.actions}><Button size="sm" disabled={!current()} onClick={() => { if (current()) void onOpenEntry(unitId, view.suite.locale); }}>{t("strategyView.openEntry")}</Button></div> : null}
        <div className={styles.comparison}>{rows.map(row => {
          const status = arena.detail.items.find(item => item.status.itemId === row.itemId)?.status;
          const original = view.slots.find(slot => slot.itemId === row.itemId && slot.unitId === row.item.unitId);
          const matches = !!original && original.resultId === row.resultId;
          const receipt = view.checks.find(check => check.request.itemId === row.itemId && check.request.resultId === row.resultId);
          const clean = !!receipt && mandatoryChecksClean(receipt);
          return <article key={row.itemId} className={styles.variant}>
            <h4>{original ? t(original.slot === 0 ? "strategy.baseline" : "strategy.candidateSlot") : t("strategyView.unmappedResult")}</h4>
            {status ? <p className={styles.help}>{t(`ai.states.${status.execution}`, { defaultValue: status.execution })}</p> : null}
            {status?.diagnostic ? <Banner tone="warning">{status.diagnostic}</Banner> : null}
            {row.output ? <><div className={styles.translation}><TokenizedText text={row.output.text}/></div>
              <div className={styles.usage}><AiOutputUsage usage={row.output.usage} incomplete={row.output.usageIncomplete}/></div>
              <div className={styles.actions}>{status?.adoption === "committed"
                ? <Button size="sm" variant="secondary" disabled={locked() || active || !matches || !!state.check || clean} onClick={() => { if (!locked()) void owner.prepareCheck(view, row); }}>{t("strategy.prepareCheck")}</Button>
                : <Button size="sm" variant="secondary" disabled={locked() || active || !matches || status?.validation !== "valid"} onClick={() => { if (!locked()) void owner.saveCandidate(view, row, arena); }}>{t("ai.saveCandidate")}</Button>}</div>
            </> : <p className={styles.help}>{t("strategyView.noOutput")}</p>}
            <p>{t(clean ? "strategy.checked" : receipt ? "strategy.qaFailed" : "strategy.notChecked")}</p>
            {receipt ? <ul className={styles.checks}>{receipt.rules.map(rule => <li key={ruleIdentity(rule.key)}>
              <span>{reviewRuleLabel(t, rule.rule)}: {t(rule.status === "passed" ? "review.passed" : rule.status === "not-applicable" ? "review.notApplicable"
                : rule.status === "findings" ? "review.findings" : rule.status === "failed" ? "review.checkFailed" : rule.status === "cancelled" ? "review.checkCancelled" : "review.checkUnknown")}</span>
              {rule.findings.map((finding, index) => <p key={index}>{finding.detail ?? finding.code}</p>)}
            </li>)}</ul> : null}
          </article>;
        })}</div>
        {suiteUnit?.holdout ? <fieldset className={styles.form} disabled={!inputAllowed()}><legend>{t("strategy.judgment")}</legend>
          <fieldset className={styles.choices}><legend>{t("strategy.preference")}</legend>{([
            ["candidate-preferred", "strategy.candidatePreferred"], ["equivalent", "strategy.equivalent"], ["baseline-preferred", "strategy.baselinePreferred"],
          ] as const).map(([value, label]) => <label key={value} className={styles.check}><TextInput type="radio" name={`strategy-preference-${view.evaluation.evaluationId}-${unitId}`}
            className={styles.checkbox} checked={draft.preference === value} onChange={() => edit({ preference: value })}/><span>{t(label)}</span></label>)}</fieldset>
          <Field label={t("strategy.notes")} required><TextArea rows={3} maxLength={4096} value={draft.notes} onChange={event => edit({ notes: event.target.value })}/></Field>
          <p className={styles.help}>{t("strategyView.humanReported")}</p>
          <Field label={t("strategy.elapsed")}><TextInput type="number" min={0} max={31536000} step={1} value={draft.elapsed} onChange={event => edit({ elapsed: event.target.value })}/></Field>
          <Field label={t("strategy.modified")}><TextInput type="number" min={0} max={10000000} step={1} value={draft.modified} onChange={event => edit({ modified: event.target.value })}/></Field>
          {saved ? <p>{t("strategyView.savedJudgment", { preference: t(saved.request.preference === "candidate-preferred" ? "strategy.candidatePreferred" : saved.request.preference === "baseline-preferred" ? "strategy.baselinePreferred" : "strategy.equivalent") })}</p> : null}
          {state.judgments[unitId] && state.judgments[unitId].editSeq !== state.judgments[unitId].savedSeq ? <p className={styles.help}>{t("strategyView.judgmentPending")}</p> : null}
          <div className={styles.actions}><Button size="sm" variant="secondary" disabled={locked() || active || !draft.preference || !draft.notes.trim() || !state.judgments[unitId]}
            onClick={() => { if (!locked()) void owner.judge(view, unitId); }}>{t("strategy.saveJudgment")}</Button></div>
        </fieldset> : null}
      </section>;
    })}
    {state.check ? <section className={styles.section} aria-label={t("strategy.qa")}><h3>{t("strategy.qa")}</h3>
      {state.check.preparation.view.checkers.map(slot => <div key={checkerIdentity(slot.checker)} className={styles.checker}>
        <ReviewCheckerDetails view={slot.plugin}/>
        <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={state.checkerConsent.includes(owner.checkerKey(slot))} disabled={locked()}
          onChange={event => { if (!locked()) owner.setCheckerConsent(slot.attemptId, event.target.checked); }}/><span>{t("strategy.checkConsent")}</span></label>
      </div>)}
      <div className={styles.actions}><Button size="sm" variant="secondary" disabled={locked() || !owner.checkersConfirmed()}
        onClick={() => { if (!locked()) void owner.check(view); }}>{t("strategy.runCheck")}</Button></div>
    </section> : null}
  </div>;
}
