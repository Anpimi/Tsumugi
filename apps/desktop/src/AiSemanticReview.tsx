import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AiConnectionFields } from "./AiConnectionFields";
import { aiSemanticReviewCommands, type AiSemanticReviewView } from "./aiSemanticReviewCommands";
import { CommandFailureDetails, commandFailure, failureReason } from "./CommandFailure";
import { executionContext } from "./executionCommands";
import { TaskCancellationFeedback, useExecutionTaskSession } from "./ExecutionTaskSession";
import { ModelConnectionPicker, PreparationBudgetSummary } from "./ModelConnectionPicker";
import type { ProjectView } from "./projectCommands";
import { useReviewDraftSession } from "./ReviewDraftSession";
import type { ReviewTarget } from "./reviewCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { ProjectFactPreview, SourceContextChoice, SourceContextPreview } from "./SourceContextPreparation";
import { enUS } from "./i18n/en-US";

export function AiSemanticReview({ project, active, disabled, currentTarget, onOpenConnections }: {
  project: ProjectView; active: boolean; disabled: boolean; currentTarget: () => ReviewTarget | null; onOpenConnections?: () => void;
}) {
  const { t } = useTranslation(), review = useReviewDraftSession(), tasks = useExecutionTaskSession(), reads = useSessionReads();
  const owner = review.semantic, state = owner.state, session = executionContext(project);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const queryKey = ["ai-semantic-review", state.attemptId] as const;
  const query = useSessionQuery<AiSemanticReviewView | null>({ key: queryKey, scopes: ["execution", "source", "translation", "resources", "review"],
    enabled: active && state.expanded && !!state.attemptId,
    read: async () => (await aiSemanticReviewCommands.read({ ...session, attemptId: state.attemptId! })).view });
  function currentView() {
    const query = reads.client.getQueryState<AiSemanticReviewView | null>(reads.key(queryKey));
    return active && state.expanded && !reads.retired && query?.status === "success" && query.fetchStatus === "idle" && !query.error && !query.isInvalidated
      ? query.data ?? null : null;
  }
  const view = !query.error ? query.data : null;
  const ownActivity = tasks.activity?.intent.operation === "ai-semantic-review" ? tasks.activity : null;
  const recordPending = !!ownActivity && !["recorded", "rejected"].includes(ownActivity.phase);
  const blocked = !active || disabled || reads.retired || !!review.state.pending || review.state.busyMutation || review.state.batchRunning || recordPending;
  const pairCount = owner.targets().length;
  const pairLimitValid = Number.isInteger(state.config.maxItems) && state.config.maxItems >= 1 && state.config.maxItems <= 100;
  const canPrepare = active && !blocked && !owner.reserved() && pairCount > 0 && pairLimitValid && pairCount <= state.config.maxItems && state.rules.length > 0
    && (state.mode !== "current" || currentTarget()?.basis === review.state.projection?.basis);
  const prepared = state.prepared?.value.preview;
  const fresh = !!state.prepared && owner.preparationCurrent(state.prepared);
  function failureMessage(reason: string | null) {
    const key = reason === "ai-review-selection" ? "semanticReview.errors.selection"
      : reason === "ai-review-basis" || reason === "ai-review-preview" ? "semanticReview.errors.stale"
      : reason === "ai-review-pairs" ? "semanticReview.errors.pairs"
      : reason === "ai-review-rules" ? "semanticReview.errors.rules"
      : reason?.startsWith("ai-review-output") || reason === "ai-review-finding" || reason === "ai-review-range" || reason === "ai-review-result" ? "semanticReview.errors.output"
      : `ai.errors.${reason}`;
    return t(key, { defaultValue: t("semanticReview.failed") });
  }
  function record(row: AiSemanticReviewView["rows"][number]) {
    const value = currentView();
    if (!value || blocked || value.rows.find(value => value.itemId === row.itemId) !== row || row.run || !row.current || !row.output || !tasks.canBegin(value.detail.taskId)) return;
    const item = value.detail.items.find(item => item.status.itemId === row.itemId), resultId = item?.resultId;
    if (!resultId) return;
    const unit = value.detail.recovery.units.find(unit => unit.itemIds.length === 1 && unit.itemIds[0] === row.itemId
      && unit.resultIds.length === 1 && unit.resultIds[0] === resultId && unit.actions.includes("adopt-result"));
    if (unit) void tasks.beginFromQuery(queryKey, value.detail, unit, "adopt-result", 0);
  }
  const cancellation = view ? { taskId: view.detail.taskId, attemptId: view.detail.attemptId, origin: "tasks" as const } : null;
  return <section aria-label={t("semanticReview.title")}>
    <button type="button" className="secondary-button" aria-expanded={state.expanded} aria-controls="semantic-review-content" onClick={() => owner.setExpanded(!state.expanded)}>{t("semanticReview.title")}</button>
    {state.expanded ? <div id="semantic-review-content">
      <p>{t("semanticReview.help")}</p>
      <fieldset disabled={!active || disabled || reads.retired}><legend>{t("semanticReview.prepareTitle")}</legend>
        <label className="field">{t("semanticReview.scope")}<select value={state.mode} onChange={event => { if (event.target.value === "current" || event.target.value === "chosen") owner.setMode(event.target.value); }}><option value="current">{t("semanticReview.current")}</option><option value="chosen">{t("semanticReview.chosen")}</option></select></label>
        <p>{t("semanticReview.pairs", { count: pairCount })}</p>
        {pairCount > state.config.maxItems ? <p role="alert">{t("semanticReview.errors.pairs")}</p> : null}
        {state.mode === "current" && review.state.projection && !review.state.projection.selectionId ? <p>{t("semanticReview.errors.selection")}</p> : null}
        {!state.rules.length ? <p>{t("semanticReview.errors.rules")}</p> : null}
        <ul>{owner.targets().map(target => <li key={`${target.unitId}:${target.locale}`}>{(state.mode === "current" ? review.state.projection?.nativeKey : review.state.chosen[`${target.locale}:${target.unitId}`]?.nativeKey) ?? target.unitId} → {target.locale}</li>)}</ul>
        <fieldset><legend>{t("semanticReview.rules")}</legend>{(["meaning", "style"] as const).map(rule => <label className="source-check" key={rule}><input type="checkbox" checked={state.rules.includes(rule)} onChange={event => owner.setRules(event.target.checked ? [...state.rules, rule] : state.rules.filter(value => value !== rule))} />{t(`semanticReview.rule.${rule}`)}</label>)}</fieldset>
        <ModelConnectionPicker config={state.config} label={t("connections.choose")} active={active && state.expanded} disabled={disabled || reads.retired} editSeq={state.sequence} onSelect={owner.selectConnection} onOpenSettings={onOpenConnections} />
        <PreparationBudgetSummary config={state.config} />
        <AiConnectionFields config={state.config} setConfig={owner.setConfig} presetName={state.presetName} setPresetName={owner.setPresetName} connectionOpen={connectionOpen || ["ai-endpoint", "ai-model", "ai-credential"].includes(failureReason(state.failure) ?? "")} setConnectionOpen={setConnectionOpen} failure={!pairLimitValid ? "ai-limits" : failureReason(state.failure)} idPrefix="semantic-review" maxItemsLabel={t("semanticReview.maxItems")} />
        <label className="source-check"><input type="checkbox" checked={state.config.shareTerms} onChange={event => owner.setConfig(value => ({ ...value, shareTerms: event.target.checked }))} />{t("ai.shareTerms")}</label>
        <label className="source-check"><input type="checkbox" checked={state.config.shareContext} onChange={event => owner.setConfig(value => ({ ...value, shareContext: event.target.checked }))} />{t("ai.shareContext")}</label>
        <SourceContextChoice value={state.config.sourceContext} onChange={sourceContext => owner.setConfig(value => ({ ...value, sourceContext }))} />
        <button type="button" className="secondary-button" disabled={!canPrepare} onClick={() => void owner.prepare()}>{t("semanticReview.prepare")}</button>
      </fieldset>
      {state.busy ? <p role="status">{t(`semanticReview.busy.${state.busy}`)}</p> : null}
      {state.failure ? <div role="alert"><p>{failureMessage(failureReason(state.failure))}</p><CommandFailureDetails failure={state.failure} /></div> : null}
      {state.notice ? <p role="status">{t(`semanticReview.notice.${state.notice}`)}</p> : null}
      {prepared ? <section aria-label={t("semanticReview.preview")}><h4>{t("semanticReview.preview")}</h4>
        <p>{prepared.config.endpoint} · {prepared.config.model} · {prepared.recipe}</p><PreparationBudgetSummary config={prepared.config} /><p>{t("ai.costUnknown")}</p><p>{t("ai.rateLimit")}</p>
        <p>{prepared.rules.map(rule => t(`semanticReview.rule.${rule}`)).join(" · ")}</p>
        {prepared.items.map(item => <article key={`${item.source.unitId}:${item.source.targetLocale}`}><h5>{item.source.nativeKey} → {item.source.targetLocale}</h5><pre className="ai-text">{item.source.sourceText}</pre><p>{t("semanticReview.translation")}</p><pre className="ai-text">{item.translationText}</pre>
          {item.source.terms.map(term => <p key={term.revisionId}>{term.source} → {term.target}</p>)}{item.source.context ? <pre className="ai-text">{item.source.context.text}</pre> : null}
          <SourceContextPreview capture={item.source.sourceContext} /><ProjectFactPreview capture={item.source.projectContext} />
          {item.source.omissions.map(reason => <p key={reason}>{reason.startsWith("term-conflict:") ? t("ai.termConflict", { term: reason.slice(14) }) : t(`ai.${reason}`, { defaultValue: reason })}</p>)}
        </article>)}<p>{t("semanticReview.disclosure")}</p>
        <label className="source-check"><input type="checkbox" checked={state.consent} disabled={blocked || !!state.busy || !!state.pending || !fresh} onChange={event => owner.setConsent(event.target.checked)} />{t("semanticReview.consent")}</label>
        <button type="button" className="primary-button" disabled={blocked || owner.reserved() || !fresh || !state.consent} onClick={() => void owner.start()}>{t("semanticReview.start")}</button>
      </section> : null}
      {state.pending ? <section aria-label={t("semanticReview.original")}><h4>{t("semanticReview.original")}</h4><p>{state.pending.preparation.value.preview.config.model}</p>
        <button type="button" className="secondary-button" disabled={!!state.busy || !active} onClick={() => void owner.check()}>{t("semanticReview.check")}</button>
        {state.pending.absent ? <><button type="button" className="secondary-button" disabled={blocked || !!state.busy || !owner.preparationCurrent(state.pending.preparation)} onClick={() => void owner.retry()}>{t("semanticReview.retry")}</button><button type="button" className="secondary-button" disabled={!!state.busy} onClick={owner.discardAbsent}>{t("semanticReview.discardAbsent")}</button></> : null}
      </section> : null}
      {state.attempts.length ? <label className="field">{t("semanticReview.history")}<select value={state.attemptId ?? ""} disabled={!active || owner.reserved()} onChange={event => owner.showAttempt(event.target.value)}>{state.attempts.map((id, index) => <option value={id} key={id}>{t("semanticReview.attempt", { count: index + 1 })}</option>)}</select></label> : null}
      {state.attemptId ? <><button type="button" className="secondary-button" disabled={query.isFetching || !active} onClick={() => void query.refetch()}>{t("semanticReview.refresh")}</button>
        {query.isFetching ? <p role="status">{t("semanticReview.reading")}</p> : null}{query.error ? <div role="alert">{t("semanticReview.readFailed")}<CommandFailureDetails failure={commandFailure(query.error)} /></div> : null}
        {!query.isFetching && !query.error && query.data === null ? <p role="status">{t("semanticReview.notFound")}</p> : null}</> : null}
      {view ? <section aria-label={t("semanticReview.results")}><h4>{t("semanticReview.results")}</h4><p>{view.preview.config.model} · {view.preview.recipe}</p><p>{t("ai.progress", { ...view.detail.progress, defaultValue: enUS.ai.progress })}</p>
        <p>{t("semanticReview.stopHelp")}</p>{view.detail.progress.queued + view.detail.progress.running > 0 && cancellation ? <button type="button" className="secondary-button" disabled={disabled || !tasks.canCancel(cancellation, () => !!currentView())} onClick={() => void tasks.cancel(cancellation, () => !!currentView())}>{t("semanticReview.stop")}</button> : null}
        <TaskCancellationFeedback origin="tasks" taskId={view.detail.taskId} disabled={disabled} />
        {view.rows.map(row => {
          const item = view.detail.items.find(item => item.status.itemId === row.itemId);
          const unit = item?.resultId ? view.detail.recovery.units.find(unit => unit.itemIds.length === 1 && unit.itemIds[0] === row.itemId && unit.resultIds.length === 1 && unit.resultIds[0] === item.resultId && unit.actions.includes("adopt-result")) : null;
          return <article key={row.itemId}><h5>{row.item.source.nativeKey} → {row.item.source.targetLocale}</h5><p>{t(`ai.states.${item?.status.execution ?? "unknown"}`)}</p>
            {item?.status.diagnostic ? <p>{failureMessage(item.status.diagnostic)}</p> : null}
            {!row.current ? <p>{t("semanticReview.staleResult")}</p> : null}{row.run ? <p>{t("semanticReview.recorded")}</p> : null}
            {row.output ? <>{row.output.rules.map(rule => <section key={rule.rule}><h5>{t(`semanticReview.rule.${rule.rule}`)}</h5>{rule.findings.length ? rule.findings.map((finding, index) => <article key={`${finding.code}:${index}`}><p>{finding.detail}</p>{finding.suggestion ? <pre className="ai-text">{finding.suggestion}</pre> : null}</article>) : <p>{t("semanticReview.noFindings")}</p>}</section>)}
              <p>{t("semanticReview.usage", { requests: row.output.requests, input: row.output.usage?.promptTokens ?? "—", output: row.output.usage?.completionTokens ?? "—", defaultValue: enUS.semanticReview.usage })}</p>{row.output.usageIncomplete ? <p>{t("ai.usageUnknown")}</p> : null}
              {!row.run ? <button type="button" className="secondary-button" disabled={blocked || !active || !currentView() || !row.current || !unit || !tasks.canBegin(view.detail.taskId)} onClick={() => record(row)}>{t("semanticReview.record")}</button> : null}</> : null}
          </article>;
        })}
      </section> : null}
      {ownActivity ? <section aria-label={t("semanticReview.recordTitle")}><h4>{t("semanticReview.recordTitle")}</h4><p>{t("semanticReview.recordHelp")}</p>
        <ul>{ownActivity.intent.items.map(item => <li key={item.status.itemId}>{t("semanticReview.recordItem", { entry: view?.detail.attemptId === ownActivity.intent.attemptId ? view.rows.find(row => row.itemId === item.status.itemId)?.item.source.nativeKey ?? item.scope.id : item.scope.id, locale: item.scope.locale, defaultValue: enUS.semanticReview.recordItem })}</li>)}</ul>
        {ownActivity.phase === "confirming" ? <button type="button" className="primary-button" disabled={!active || disabled || !tasks.canSubmit()} onClick={() => void tasks.submit()}>{t("semanticReview.confirmRecord")}</button> : null}
        {ownActivity.phase === "unknown" ? <><p role="status">{t("semanticReview.recordUnknown")}</p><button type="button" className="secondary-button" disabled={tasks.busy || !active} onClick={() => void tasks.checkAdoption()}>{t("semanticReview.checkRecord")}</button>{ownActivity.retryAllowed ? <button type="button" className="secondary-button" disabled={!active || disabled || tasks.busy} onClick={() => void tasks.retryAdoption()}>{t("semanticReview.retryRecord")}</button> : null}</> : null}
        {ownActivity.phase === "recorded" ? <p role="status">{t("semanticReview.recorded")}</p> : null}
        {tasks.busy ? <p role="status">{t("semanticReview.recording")}</p> : null}<CommandFailureDetails failure={ownActivity.failure} />
        {!tasks.busy && ownActivity.phase !== "unknown" ? <button type="button" className="secondary-button" onClick={tasks.dismiss}>{t("semanticReview.closeRecord")}</button> : null}
      </section> : null}
    </div> : null}
  </section>;
}
