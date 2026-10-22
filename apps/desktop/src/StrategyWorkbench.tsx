import { useRef, useState, useEffect, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { useOptionalStrategyDraftSession, useStrategyDraftSession } from "./StrategyDraftSession";
import { strategyCommands, strategyKeys, type StrategyEvaluationView } from "./strategyCommands";
import { SourceContextChoice, SourceContextPreview, SourceContextSelectionSummary, ProjectFactPreview } from "./SourceContextPreparation";
import { ModelConnectionPicker, PreparationBudgetSummary } from "./ModelConnectionPicker";
import { AiConnectionFields } from "./AiConnectionFields";
import { AiOutputUsage, AiProviderBudget } from "./AiUsage";
import { ReviewCheckerDetails, checkerIdentity, ruleIdentity } from "./ReviewCheckers";
import { CommandFailureDetails, commandFailure, failureReason } from "./CommandFailure";
import { sourceReads } from "./sourceQueries";
import { editedAiConfig, mandatoryChecksClean, type AiConfig } from "./aiCommands";
import type { ProjectView } from "./projectCommands";
import type { ArenaView } from "./arenaCommands";
import { reviewRuleLabel } from "./reviewLabels";
import { useWorkbenchCommands } from "./workbenchCommands";
import { enUS } from "./i18n/en-US";

interface Props { area: "ai" | "arena"; project: ProjectView; active: boolean; disabled: boolean; config: AiConfig; onOpenConnections?: () => void }
/** The shared draft owner remains mounted when either existing work surface is hidden. */
export function StrategyWorkbench(props: Props) {
  const owner = useOptionalStrategyDraftSession();
  return owner ? <StrategyPanel {...props} /> : null;
}
function StrategyPanel({ area, project, active, disabled, config, onOpenConnections }: Props) {
  const { t } = useTranslation(), owner = useStrategyDraftSession(), reads = useSessionReads(), state = owner.state;
  const [connectionOpen, setConnectionOpen] = useState(false), [presetName, setPresetName] = useState("custom");
  const [expanded, setExpanded] = useState(() => owner.dirty() || owner.reserved()), [after, setAfter] = useState(0);
  const [candidateOffset, setCandidateOffset] = useState(0), [evaluationOffset, setEvaluationOffset] = useState(0), [historyOffset, setHistoryOffset] = useState(0);
  const failureRef = useRef<HTMLDivElement>(null), context = reads.context;
  const enabled = active && expanded && !reads.retired;
  const registry = useWorkbenchCommands();
  const commandScope = { ...context, area };
  function checkAvailability() {
    if (!active || !expanded || reads.retired) return { enabled: false, reason: "hidden" as const };
    if (owner.current().busy) return { enabled: false, reason: "busy" as const };
    return owner.current().pending?.uncertain ? { enabled: true } : { enabled: false, reason: "unavailable" as const };
  }
  function retryAvailability() {
    const available = checkAvailability(); if (!available.enabled) return available;
    return !disabled && owner.current().pending?.retryAllowed ? { enabled: true } : { enabled: false, reason: "unavailable" as const };
  }
  useLayoutEffect(() => {
    const removeCheck = registry.register({ id: "strategy.check-pending", nameKey: "strategy.reconcile", category: area, scope: commandScope,
      binding: null, risk: "reads-strategy", confirmation: "none", availability: checkAvailability, handler: () => { void owner.reconcile(); } });
    const removeRetry = registry.register({ id: "strategy.retry-pending", nameKey: "strategy.retryOriginal", category: area, scope: commandScope,
      binding: null, risk: "retries-strategy-action", confirmation: "none", availability: retryAvailability, handler: () => { void owner.retry(); } });
    return () => { removeCheck(); removeRetry(); };
  });
  const sourceOptions = sourceReads.scope(context), source = useSessionQuery({ ...sourceOptions, enabled });
  const pageOptions = sourceReads.content(context, source.data?.currentSnapshot ?? "", after, source.data);
  const page = useSessionQuery({ ...pageOptions, enabled: enabled && !!source.data?.currentSnapshot && !source.error });
  const candidates = useSessionQuery({ key: strategyKeys.candidates(state.locale, candidateOffset), scopes: ["arena", "source", "translation"], enabled: enabled && owner.available(), read: () => strategyCommands.candidates({ ...context, locale: state.locale, offset: candidateOffset, limit: 50 }) });
  const evaluations = useSessionQuery({ key: strategyKeys.evaluations(state.locale, evaluationOffset), scopes: ["arena"], enabled: enabled && owner.available(), read: () => strategyCommands.evaluations({ ...context, locale: state.locale, offset: evaluationOffset, limit: 50 }) });
  const future = useSessionQuery({ key: strategyKeys.default(state.locale), scopes: ["arena", "project"], enabled: enabled && owner.available(), read: () => strategyCommands.default({ ...context, locale: state.locale }) });
  const defaultCandidateId = future.data?.reference?.candidateId;
  const defaultCandidate = useSessionQuery({ key: ["context-strategy-candidate", defaultCandidateId], scopes: ["arena", "source", "translation"],
    enabled: enabled && !!defaultCandidateId, read: () => strategyCommands.candidate({ ...context, candidateId: defaultCandidateId! }) });
  const selectedCandidateId = state.candidate?.candidateId;
  const selectedCandidate = useSessionQuery({ key: ["context-strategy-candidate", selectedCandidateId], scopes: ["arena", "source", "translation"],
    enabled: enabled && !!selectedCandidateId, read: () => strategyCommands.candidate({ ...context, candidateId: selectedCandidateId! }) });
  const history = useSessionQuery({ key: strategyKeys.defaults(state.locale, historyOffset), scopes: ["arena", "project"], enabled: enabled && owner.available(), read: () => strategyCommands.defaults({ ...context, locale: state.locale, offset: historyOffset, limit: 50 }) });
  const evaluationId = state.evaluationId;
  const evaluation = useSessionQuery({ key: strategyKeys.evaluation(evaluationId ?? ""), scopes: ["arena", "source", "resources", "translation", "review", "execution"],
    enabled: enabled && !!evaluationId, read: () => strategyCommands.evaluation({ ...context, evaluationId: evaluationId! }) });
  const view = evaluation.data;
  const attemptId = view?.evaluation.attemptId;
  const arena = useSessionQuery({ key: ["arena", attemptId], scopes: ["arena", "execution", "translation", "source", "review"],
    enabled: enabled && !!attemptId && !state.prepared, read: () => owner.readArena(attemptId!) });
  const failedRead = source.error ?? page.error ?? candidates.error ?? evaluations.error ?? future.error ?? defaultCandidate.error ?? selectedCandidate.error ?? history.error ?? evaluation.error ?? arena.error;
  const failure = state.failure ?? (failedRead ? commandFailure(failedRead) : null);
  const diagnostic = failureReason(failure), localFailure = diagnostic === "strategy-report" ? "strategy.invalidReport"
    : diagnostic === "strategy-correction" ? "strategy.invalidCorrection" : diagnostic === "strategy-correction-stale" ? "strategy.correctionStale" : null;
  const loading = source.isFetching || page.isFetching || candidates.isFetching || evaluations.isFetching || future.isFetching || defaultCandidate.isFetching || history.isFetching || evaluation.isFetching || arena.isFetching;
  useEffect(() => { if (state.failure) failureRef.current?.focus(); }, [state.failure]);
  const locked = disabled || owner.reserved() || !owner.available();
  const roleIds = Object.keys(state.roles), calibration = roleIds.filter(id => state.roles[id] === "calibration"), holdout = roleIds.filter(id => state.roles[id] === "holdout");
  const entries = page.error || page.isFetching || source.error || source.isFetching ? [] : page.data?.rows ?? [];
  const savedCandidates = candidates.data?.rows ?? [], savedEvaluations = evaluations.data?.rows.filter(row => row.candidateId === state.candidate?.candidateId) ?? [];
  const defaultCurrent = () => {
    const value = reads.client.getQueryState(reads.key(strategyKeys.default(state.locale)));
    return value?.status === "success" && value.fetchStatus === "idle" && !value.isInvalidated && value.error === null && value.data === future.data;
  };
  function refresh() {
    void source.refetch(); if (source.data?.currentSnapshot) void page.refetch();
    void candidates.refetch(); void evaluations.refetch(); void future.refetch(); void history.refetch();
    if (defaultCandidateId) void defaultCandidate.refetch();
    if (selectedCandidateId) void selectedCandidate.refetch();
    if (evaluationId) void evaluation.refetch(); if (attemptId && !state.prepared) void arena.refetch();
  }
  return <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t("strategy.title")}</summary>
    <section aria-label={t("strategy.title")}>
      <p>{t("strategy.help")}</p><p>{t("strategy.scope", { project: project.metadata.displayName, locale: state.locale })}</p>
      <label className="field">{t("strategy.locale")}<select value={state.locale} disabled={locked || owner.dirty()} onChange={event => { if (owner.setLocale(event.target.value)) { setAfter(0); setCandidateOffset(0); setEvaluationOffset(0); setHistoryOffset(0); } }}>
        <option value="">{t("strategy.chooseLocale")}</option>{project.metadata.targetLocales.map(locale => <option key={locale} value={locale}>{locale}</option>)}
      </select></label>
      {!owner.available() ? <p role="alert">{t("ai.errors.ai-locale")}</p> : null}
      {loading ? <p role="status">{t("strategy.loading")}</p> : null}
      {failure ? <div role="alert" tabIndex={-1} ref={failureRef}><p>{t(localFailure ?? (state.pending?.uncertain ? "strategy.unknown" : state.notice === "recordedReadFailed" ? "strategy.recordedReadFailed" : "strategy.failed"))}</p>
        <CommandFailureDetails failure={failure} /><button type="button" className="secondary-button" disabled={state.busy} onClick={refresh}>{t("strategy.refresh")}</button></div> : null}
      {state.notice ? <p role="status">{t(`strategy.${state.notice}`)}</p> : null}
      {state.pending?.uncertain ? <div role="status"><p>{t(state.checkingAction ? "strategy.checkingSaved" : state.pending.kind === "check" || state.pending.kind === "prepare-check" ? "strategy.checkUnknown" : "strategy.unknown")}</p>
        <button type="button" className="secondary-button" disabled={!checkAvailability().enabled} onClick={() => registry.dispatch("strategy.check-pending", commandScope)}>{t("strategy.reconcile")}</button>
        {state.pending.retryAllowed ? <button type="button" className="secondary-button" disabled={!retryAvailability().enabled} onClick={() => registry.dispatch("strategy.retry-pending", commandScope)}>{t("strategy.retryOriginal")}</button> : null}
      </div> : null}
      {state.pending?.kind === "check" ? <button type="button" className="secondary-button" disabled={disabled} onClick={() => void owner.cancelCheck()}>{t("review.cancelCheck")}</button> : null}
      <section aria-label={t("strategy.defaultTitle")}><h3>{t("strategy.defaultTitle")}</h3>
        {future.isSuccess ? <p>{t(future.data?.reference ? "strategy.currentDefault" : "strategy.noDefault")}</p> : null}
        {defaultCandidate.data ? <><p>{t("strategy.savedVersion", { reason: defaultCandidate.data.reason })}</p><p>{defaultCandidate.data.exceptions}</p><SourceContextSelectionSummary value={defaultCandidate.data.sourceContext} />
          <details><summary>{t("strategy.original")}</summary><h4>{t("strategy.source")}</h4><pre className="ai-text">{defaultCandidate.data.evidence.sourceText}</pre><h4>{t("strategy.before")}</h4><pre className="ai-text">{defaultCandidate.data.evidence.beforeText}</pre><h4>{t("strategy.after")}</h4><pre className="ai-text">{defaultCandidate.data.evidence.afterText}</pre></details></> : null}
        <p>{t("strategy.withdrawHelp")}</p>
        <button type="button" className="secondary-button" disabled={locked || !future.data?.reference || !defaultCurrent()}
          onClick={() => void owner.changeDefault(null, true, future.data?.revisionId ?? null, defaultCurrent)}>{t("strategy.withdraw")}</button>
        <details><summary>{t("strategy.history")}</summary>{history.isSuccess && !history.data.rows.length ? <p>{t("strategy.historyEmpty")}</p> : null}
          <ol start={historyOffset + 1}>{history.data?.rows.map(row => <li key={row.revisionId}>{t(row.reference ? "strategy.historyApplied" : "strategy.historyWithdrawn")} · {row.locale}</li>)}</ol>
          <HistoryPaging offset={historyOffset} next={history.data?.nextOffset ?? null} disabled={history.isFetching} onPage={setHistoryOffset} />
        </details>
      </section>
      <section aria-label={t("strategy.correction")}><h3>{t("strategy.correction")}</h3><p>{t("strategy.correctionHelp")}</p>
        <label className="field">{t("strategy.correction")}<select value={state.correctionUnit} disabled={disabled} onChange={event => owner.edit("correctionUnit", event.target.value)}>
          <option value="">{t("strategy.chooseCorrection")}</option>
          {state.correctionUnit && !entries.some(row => row.unitId === state.correctionUnit) ? <option value={state.correctionUnit}>{state.evidence?.sourceText ?? t("strategy.correction")}</option> : null}
          {entries.map(row => row.unitId ? <option key={row.unitId} value={row.unitId}>{row.occurrence.key} · {row.occurrence.text}</option> : null)}
        </select></label>
        <button type="button" className="secondary-button" disabled={locked || !state.correctionUnit} onClick={() => void owner.inspectCorrection()}>{t("strategy.inspectCorrection")}</button>
        {state.evidence ? <div><h4>{t("strategy.source")}</h4><pre className="ai-text">{state.evidence.sourceText}</pre><h4>{t("strategy.before")}</h4><pre className="ai-text">{state.evidence.beforeText}</pre><h4>{t("strategy.after")}</h4><pre className="ai-text">{state.evidence.afterText}</pre>
          {state.stale ? <p role="alert">{t("strategy.correctionStale")}</p> : null}</div> : null}
        <fieldset disabled={disabled}><legend>{t("strategy.candidate")}</legend>
          <SourceContextChoice value={state.sourceContext} onChange={value => owner.edit("sourceContext", value)} />
          <label className="field">{t("strategy.reason")}<textarea value={state.reason} maxLength={4096} onChange={event => owner.edit("reason", event.target.value)} /></label>
          <label className="field">{t("strategy.exceptions")}<textarea value={state.exceptions} maxLength={4096} onChange={event => owner.edit("exceptions", event.target.value)} /></label><p>{t("strategy.reasonHelp")}</p>
        </fieldset><p>{t("strategy.immutable")}</p>
        <button type="button" className="primary-button" disabled={locked || !owner.canCapture()} onClick={() => void owner.capture()}>{t("strategy.create")}</button>
      </section>
      <label className="field">{t("strategy.candidate")}<select value={state.candidate?.candidateId ?? ""} disabled={locked || owner.dirty()} onChange={event => {
        const candidate = savedCandidates.find(row => row.candidateId === event.target.value); if (candidate) owner.chooseCandidate(candidate);
      }}><option value="">{t("strategy.chooseCandidate")}</option>
        {state.candidate && !savedCandidates.some(row => row.candidateId === state.candidate?.candidateId) ? <option value={state.candidate.candidateId}>{state.candidate.reason}</option> : null}
        {savedCandidates.map(row => <option key={row.candidateId} value={row.candidateId}>{row.reason}</option>)}</select></label>
      {candidates.isSuccess && !savedCandidates.length ? <p>{t("strategy.noCandidates")}</p> : null}
      <HistoryPaging offset={candidateOffset} next={candidates.data?.nextOffset ?? null} disabled={candidates.isFetching} onPage={setCandidateOffset} />
      {state.candidate ? <><p>{t("strategy.savedVersion", { reason: state.candidate.reason })}</p><p>{state.candidate.exceptions}</p>
        {!state.candidate.evidence.current || selectedCandidate.data?.evidence.current === false ? <p role="alert">{t("strategy.correctionStale")}</p> : null}
        <SourceContextSelectionSummary value={state.candidate.sourceContext} />
        <details><summary>{t("strategy.details")}</summary><p>{state.candidate.candidateId}</p><code>{state.candidate.digest}</code></details>
        <details><summary>{t("strategy.original")}</summary><pre className="ai-text">{state.candidate.evidence.sourceText}</pre><pre className="ai-text">{state.candidate.evidence.beforeText}</pre><pre className="ai-text">{state.candidate.evidence.afterText}</pre></details>
        <section aria-label={t("strategy.suite")}><h3>{t("strategy.suite")}</h3><p>{t("strategy.suiteHelp")}</p>
          {!source.data?.currentSnapshot && !source.isFetching ? <p>{t("strategy.emptySource")}</p> : null}
          <p>{t("strategy.setCount", { calibration: calibration.length, holdout: holdout.length })}</p>
          <ul>{entries.map(row => row.unitId ? <li key={row.unitId}><label className="field">{row.occurrence.key}: {row.occurrence.text}
            <select aria-label={t("strategy.assignment", { key: row.occurrence.key })} value={state.roles[row.unitId] ?? "unused"} disabled={disabled}
              onChange={event => { const value = event.target.value, roles = { ...state.roles }; if (value === "calibration" || value === "holdout") roles[row.unitId!] = value; else delete roles[row.unitId!]; owner.edit("roles", roles); }}>
              <option value="unused">{t("strategy.unused")}</option><option value="calibration">{t("strategy.calibration")}</option>
              <option value="holdout" disabled={row.unitId === state.candidate?.evidence.basis.unitId}>{t("strategy.holdout")}</option>
            </select></label></li> : null)}</ul>
          <div className="execution-actions"><button type="button" className="secondary-button" disabled={disabled || after === 0} onClick={() => setAfter(0)}>{t("ai.first")}</button>
            {page.data?.nextOrdinal != null ? <button type="button" className="secondary-button" disabled={disabled || page.isFetching} onClick={() => setAfter(page.data!.nextOrdinal!)}>{t("strategy.next")}</button> : null}</div>
          <h4>{t("strategy.conditions")}</h4><p>{t("strategy.conditionsHelp")}</p>
          <button type="button" className="secondary-button" disabled={locked} onClick={() => owner.copyConfig(config)}>{t("strategy.useConnection")}</button>
          <ModelConnectionPicker config={state.config} label={t("strategy.connection")} active={enabled} disabled={locked} editSeq={state.editSeq} onSelect={owner.selectConnection} onOpenSettings={onOpenConnections} />
          <fieldset disabled={locked}><AiConnectionFields config={state.config} setConfig={next=>{const before=owner.current().config;owner.edit("config",editedAiConfig(before,typeof next === "function" ? next(before) : next));}}
            presetName={presetName} setPresetName={setPresetName} connectionOpen={connectionOpen} setConnectionOpen={setConnectionOpen} failure={null} idPrefix="strategy"/></fieldset><PreparationBudgetSummary config={state.config} />
          {!state.config.endpoint || !state.config.model ? <p>{t("strategy.noConnection")}</p> : null}
          <button type="button" className="secondary-button" disabled={locked || !state.candidate.evidence.current || selectedCandidate.data?.evidence.current === false || !!selectedCandidate.error || selectedCandidate.isFetching
            || calibration.length < 1 || holdout.length < 1 || roleIds.length > 20 || !state.config.endpoint || !state.config.model}
            onClick={() => void owner.captureSuite()}>{t("strategy.saveSuite")}</button>
          {state.suite ? <button type="button" className="primary-button" disabled={locked} onClick={() => void owner.prepare()}>{t("strategy.evaluate")}</button> : null}
        </section>
        <section aria-label={t("strategy.evaluations")}><h3>{t("strategy.evaluations")}</h3>
          {evaluations.isSuccess && !savedEvaluations.length ? <p>{t("strategy.noEvaluations")}</p> : null}
          <ol start={evaluationOffset + 1}>{savedEvaluations.map((row, index) => <li key={row.evaluationId}><button type="button" className="text-button" disabled={locked || owner.dirty()}
            onClick={() => owner.selectEvaluation(row.evaluationId)}>{t("strategy.openEvaluation", { number: evaluationOffset + index + 1 })}</button></li>)}</ol>
          <HistoryPaging offset={evaluationOffset} next={evaluations.data?.nextOffset ?? null} disabled={evaluations.isFetching} onPage={setEvaluationOffset} />
        </section>
      </> : null}
      {state.prepared ? <section aria-label={t("strategy.preview")}><h3>{t("strategy.preview")}</h3>
        <p>{t("strategy.conditionsHelp")}</p>
        {state.prepared.preview.config.variants.map((variant, index) => <div key={index}><h4>{t(index === 0 ? "strategy.baseline" : "strategy.candidateSlot")}</h4><p>{variant.endpoint} · {variant.model}</p><PreparationBudgetSummary config={variant} /></div>)}
        {state.prepared.preview.items.map(row => <article key={`${row.sourceOrder}:${row.slot}`}><h4>{row.item.nativeKey} · {t(row.slot === 0 ? "strategy.baseline" : "strategy.candidateSlot")}</h4><pre className="ai-text">{row.item.sourceText}</pre><SourceContextPreview capture={row.item.sourceContext} /><ProjectFactPreview capture={row.item.projectContext} /></article>)}
        <label className="source-check"><input type="checkbox" checked={state.consent} disabled={locked || !state.prepared.canStart || state.stale} onChange={event => owner.setConsent(event.target.checked)} />{t("strategy.consent")}</label>
        <button type="button" className="primary-button" disabled={locked || !owner.canStart()} onClick={() => void owner.start()}>{t("strategy.start")}</button>
        {state.stale || !state.prepared.canStart ? <p role="alert">{t("strategy.previewChanged")}</p> : null}
      </section> : null}
      {view ? <section aria-label={t("strategy.originalResults")}><h3>{t("strategy.originalResults")}</h3><p>{t(view.current ? "strategy.current" : "strategy.stale")}</p>
        <p>{t("strategy.burdenUnknown")}</p>
        {arena.data ? <StrategyEvaluationResults view={view} arena={arena.data} disabled={disabled} /> : null}
        <p>{t("strategy.promoteHelp")}</p><button type="button" className="primary-button" disabled={locked || !view.current || !owner.evaluationCurrent(view) || !defaultCurrent()}
          onClick={() => void owner.changeDefault(view, false, future.data?.revisionId ?? null, defaultCurrent)}>{t("strategy.promote")}</button>
      </section> : null}
      <div className="execution-actions"><button type="button" className="secondary-button" disabled={locked} onClick={refresh}>{t("strategy.refresh")}</button>
        <button type="button" className="secondary-button" disabled={locked} onClick={() => owner.reset()}>{t(owner.dirty() ? "strategy.discard" : "strategy.reset")}</button></div>
    </section>
  </details>;
}

export function StrategyEvaluationResults({ view, arena, disabled }: { view: StrategyEvaluationView; arena: ArenaView; disabled: boolean }) {
  const { t } = useTranslation(), owner = useStrategyDraftSession(), state = owner.state;
  const locked = disabled || owner.reserved() || !owner.evaluationCurrent(view);
  const groups = [...new Set(arena.rows.map(row => row.sourceOrder))];
  const active = arena.detail.progress.queued > 0 || arena.detail.progress.running > 0;
  return <><p>{t("ai.costUnknown")}</p>{arena.budget ? <AiProviderBudget budget={arena.budget}/> : <p>{t("ai.usageUnknown")}</p>}{active ? <p role="status">{t("strategy.running")}</p> : null}
    <p>{t("strategy.qaHelp")}</p>
    {groups.map(order => {
      const rows = arena.rows.filter(row => row.sourceOrder === order), first = rows[0];
      const unitId = first.item.unitId, suiteUnit = view.suite.units.find(row => row.unitId === unitId), saved = view.judgments.find(row => row.request.unitId === unitId);
      const draft = state.judgments[unitId] ?? { preference: saved?.request.preference ?? "", notes: saved?.request.notes ?? "", elapsed: saved?.request.elapsedSeconds?.toString() ?? "", modified: saved?.request.modifiedCharacters?.toString() ?? "" };
      function edit(change: Partial<typeof draft>) { owner.editJudgment(unitId, { preference: draft.preference, notes: draft.notes, elapsed: draft.elapsed, modified: draft.modified, ...change }); }
      return <section key={unitId}><h4>{first.item.nativeKey} · {t(suiteUnit?.holdout ? "strategy.holdout" : "strategy.calibration")}</h4><pre className="ai-text">{first.item.sourceText}</pre>
        <div className="arena-columns">{rows.map(row => {
          const status = arena.detail.items.find(item => item.status.itemId === row.itemId)?.status, receipt = view.checks.find(check => check.request.itemId === row.itemId && check.request.resultId === row.resultId);
          const original = view.slots.find(slot => slot.itemId === row.itemId && slot.unitId === row.item.unitId);
          const resultMatches = !!original && original.resultId === row.resultId;
          const complete = receipt && mandatoryChecksClean(receipt);
          return <article key={row.itemId}><h5>{original ? t(original.slot === 0 ? "strategy.baseline" : "strategy.candidateSlot") : t("arena.candidate", { label: String.fromCharCode(65 + row.label) })}</h5><p>{t(`ai.states.${status?.execution}`, { defaultValue: status?.execution ?? "" })}</p>
            {status?.diagnostic ? <p role="alert">{status.diagnostic}</p> : null}
            {row.output ? <><pre className="ai-text">{row.output.text}</pre><AiOutputUsage usage={row.output.usage} incomplete={row.output.usageIncomplete}/>
              {status?.adoption === "committed" ? <button type="button" className="secondary-button" disabled={locked || active || !resultMatches || !!state.check || !!complete} onClick={() => void owner.prepareCheck(view, row)}>{t("strategy.prepareCheck")}</button>
                : <button type="button" className="secondary-button" disabled={locked || active || !resultMatches || status?.validation !== "valid"} onClick={() => void owner.saveCandidate(view, row, arena)}>{t("ai.saveCandidate")}</button>}
            </> : null}
            <p>{t(complete ? "strategy.checked" : receipt ? "strategy.qaFailed" : "strategy.notChecked")}</p>
            {receipt ? <ul>{receipt.rules.map(rule => <li key={ruleIdentity(rule.key)}>{reviewRuleLabel(t, rule.rule)}: {t(rule.status === "passed" ? "review.passed" : rule.status === "not-applicable" ? "review.notApplicable" : rule.status === "findings" ? "review.findings" : rule.status === "failed" ? "review.checkFailed" : rule.status === "cancelled" ? "review.checkCancelled" : "review.checkUnknown")}{rule.findings.map((finding, index) => <p key={index}>{finding.detail ?? finding.code}</p>)}</li>)}</ul> : null}
          </article>;
        })}</div>
        {suiteUnit?.holdout ? <fieldset disabled={disabled}><legend>{t("strategy.judgment")}</legend>
          <label className="field">{t("strategy.preference")}<select value={draft.preference} onChange={event => { const value = event.target.value; if (value === "candidate-preferred" || value === "equivalent" || value === "baseline-preferred") edit({ preference: value }); }}>
            <option value="">{t("strategy.choosePreference")}</option><option value="candidate-preferred">{t("strategy.candidatePreferred")}</option><option value="equivalent">{t("strategy.equivalent")}</option><option value="baseline-preferred">{t("strategy.baselinePreferred")}</option>
          </select></label><label className="field">{t("strategy.notes")}<textarea value={draft.notes} maxLength={4096} onChange={event => edit({ notes: event.target.value })} /></label>
          <label className="field">{t("strategy.elapsed")}<input type="number" min={0} max={31536000} step={1} value={draft.elapsed} onChange={event => edit({ elapsed: event.target.value })} /></label>
          <label className="field">{t("strategy.modified")}<input type="number" min={0} max={10000000} step={1} value={draft.modified} onChange={event => edit({ modified: event.target.value })} /></label>
          <button type="button" className="secondary-button" disabled={locked || active || !draft.preference || !draft.notes.trim() || !state.judgments[unitId]} onClick={() => void owner.judge(view, unitId)}>{t("strategy.saveJudgment")}</button>
        </fieldset> : null}
      </section>;
    })}
    {state.check ? <section aria-label={t("strategy.qa")}><h4>{t("strategy.qa")}</h4>{state.check.preparation.view.checkers.map(slot => <fieldset key={checkerIdentity(slot.checker)}>
      <legend>{slot.checker.provider.plugin.publisher}/{slot.checker.provider.plugin.id} · {slot.checker.profile.id}</legend><ReviewCheckerDetails view={slot.plugin} />
      <label className="source-check"><input type="checkbox" checked={state.checkerConsent.includes(owner.checkerKey(slot))} disabled={locked} onChange={event => owner.setCheckerConsent(slot.attemptId, event.target.checked)} />{t("strategy.checkConsent")}</label>
    </fieldset>)}<button type="button" className="primary-button" disabled={locked || !owner.checkersConfirmed() || !owner.evaluationCurrent(view)} onClick={() => void owner.check(view)}>{t("strategy.runCheck")}</button></section> : null}
  </>;
}

function HistoryPaging({ offset, next, disabled, onPage }: { offset: number; next: number | null; disabled: boolean; onPage: (offset: number) => void }) {
  const { t } = useTranslation();
  return <div className="execution-actions"><p>{t("strategy.historyPage")}</p>
    <button type="button" className="secondary-button" disabled={disabled || offset === 0} onClick={() => onPage(Math.max(0, offset - 50))}>{t("strategy.previous")}</button>
    <button type="button" className="secondary-button" disabled={disabled || next === null} onClick={() => { if (next !== null) onPage(next); }}>{t("strategy.next")}</button>
  </div>;
}
