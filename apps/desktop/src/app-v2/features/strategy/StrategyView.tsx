import type { TranslationKey } from "../../../i18n/types";
import type { WorkbenchCommands } from "../../../workbenchCommands";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "../../../projectCommands";
import { isCommandError } from "../../../projectCommands";
import type { StrategyOwner } from "../../../StrategyDraftSession";
import type { useExecutionTaskSession } from "../../../ExecutionTaskSession";
import type { ArenaView } from "../../../arenaCommands";
import { strategyCommands, strategyKeys, type StrategySuite } from "../../../strategyCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { sourceReads } from "../../../sourceQueries";
import type { ContentPage } from "../../../sourceCommands";
import { commandFailure, CommandFailureDetails, failureReason } from "../../../CommandFailure";
import { aiNumericLimits, defaultAiConfig, editedAiConfig, isChatGptSubscription, sourceContextMinBytes, validSourceContextSelection, validAiLimits, type AiConfig } from "../../../aiCommands";
import { connectionConfigCurrent, connectionReadOptions, currentConnections, useApplicationQueryClient } from "../../../ApplicationReadProvider";
import { PreparationBudgetSummary } from "../../../ModelConnectionPicker";
import { SourceContextSelectionSummary, SourceContextPreview, ProjectFactPreview } from "../../../SourceContextPreparation";
import { ContextResourceCapturePreview } from "../../../ContextResourceCapturePreview";
import { Button } from "../../../design-system/Button";
import { Banner, EmptyState, LoadingState } from "../../../design-system/Feedback";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Menu } from "../../../design-system/Menu";
import { Dialog } from "../../../design-system/Dialog";
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from "../../../design-system/Tabs";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { InteractionGate } from "../../workspace/interactionGate";
import { StrategyResults } from "./StrategyResults";
import styles from "./StrategyView.module.css";

export interface StrategyIntent { unitId: string; locale: string; sequence: number }
export interface StrategyRequestTarget { actionId: string; submittedSeq: string }
export interface StrategyViewProps {
  project: ProjectView;
  owner: StrategyOwner;
  commands?: WorkbenchCommands | null;
  visible: boolean;
  disabled: boolean;
  gate: InteractionGate;
  viewId: string | null;
  intent?: StrategyIntent | null;
  requestTarget?: StrategyRequestTarget | null;
  tasks?: ReturnType<typeof useExecutionTaskSession> | null;
  onOpenConnections?: () => void;
  onOpenEntry?: (unitId: string, locale: string) => Promise<boolean>;
  config?: AiConfig;
}
type Step = "candidate" | "experiment" | "results" | "history";

/** The original project owner retains drafts, execution and recovery. This surface only arranges the workflow. */
export function StrategyView(props: StrategyViewProps) {
  const { project, owner, commands, tasks, visible, disabled, gate, viewId, intent, requestTarget, onOpenConnections, onOpenEntry, config } = props;
  const { t } = useTranslation(), reads = useSessionReads(), state = owner.state, inputId = `strategy-${useId()}`;
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const [step, setStep] = useState<Step>("candidate"), [after, setAfter] = useState(0);
  const [candidateOffset, setCandidateOffset] = useState(0), [evaluationOffset, setEvaluationOffset] = useState(0), [historyOffset, setHistoryOffset] = useState(0);
  const [handledIntent, setHandledIntent] = useState<string | null>(null), [resetOpen, setResetOpen] = useState(false);
  const [dismissedRequest, setDismissedRequest] = useState<string | null>(null);
  const dialogId = `${inputId}-reset`, live = useRef(props);
  useLayoutEffect(() => { live.current = props; });
  useLayoutEffect(() => { if (!visible) gate.releaseOwner(inputId); return () => gate.releaseOwner(inputId); }, [visible, gate, inputId]);
  useLayoutEffect(() => resetOpen && visible ? gate.pushDialog(dialogId) : undefined, [resetOpen, visible, gate, dialogId]);
  const present = () => live.current.visible && !live.current.disabled && !reads.retired
    && live.current.project.metadata.projectId === reads.context.projectId && live.current.project.sessionToken === reads.context.sessionToken;
  const current = () => present() && gate.canDispatch({ viewId: live.current.viewId, source: "button" });
  const inputAllowed = () => {
    const snapshot = gate.getSnapshot();
    return present() && snapshot.visibleViewId === live.current.viewId && !snapshot.intentOwner && snapshot.dialogs.length === 0
      && !owner.current().hydrating;
  };
  const locked = () => !current() || owner.reserved() || !owner.available();
  useLayoutEffect(() => {
    if (!commands) return;
    const scope = { ...reads.context, area: "translation" as const };
    const available = (retry: boolean) => {
      const value = live.current, pending = value.owner.current().pending;
      if (!value.visible || value.disabled || reads.retired || gate.getSnapshot().visibleViewId !== value.viewId) return { enabled: false, reason: "hidden" as const };
      if (value.owner.current().busy) return { enabled: false, reason: "busy" as const };
      return pending?.uncertain && (!retry || pending.retryAllowed) ? { enabled: true } : { enabled: false, reason: "unavailable" as const };
    };
    const check = commands.register({ id: "strategy.check-pending", nameKey: "strategy.reconcile", category: "translation", scope,
      binding: null, risk: "reads-strategy", confirmation: "none", availability: () => available(false),
      handler: () => { if (available(false).enabled) void live.current.owner.reconcile(); } });
    const retry = commands.register({ id: "strategy.retry-pending", nameKey: "strategy.retryOriginal", category: "translation", scope,
      binding: null, risk: "retries-strategy-action", confirmation: "none", availability: () => available(true),
      handler: () => { if (available(true).enabled) void live.current.owner.retry(); } });
    return () => { check(); retry(); };
  }, [commands, reads, gate, viewId]);
  const context = reads.context, enabled = visible && !reads.retired && !state.hydrating;
  const source = useSessionQuery({ ...sourceReads.scope(context), enabled });
  const page = useSessionQuery({ ...sourceReads.content(context, source.data?.currentSnapshot ?? "", after, source.data),
    enabled: enabled && !!source.data?.currentSnapshot && !source.error });
  const candidates = useSessionQuery({ key: strategyKeys.candidates(state.locale, candidateOffset), scopes: ["arena", "source", "translation"],
    enabled: enabled && owner.available(), read: () => strategyCommands.candidates({ ...context, locale: state.locale, offset: candidateOffset, limit: 50 }) });
  const evaluations = useSessionQuery({ key: strategyKeys.evaluations(state.locale, evaluationOffset), scopes: ["arena"],
    enabled: enabled && owner.available(), read: () => strategyCommands.evaluations({ ...context, locale: state.locale, offset: evaluationOffset, limit: 50 }) });
  const future = useSessionQuery({ key: strategyKeys.default(state.locale), scopes: ["arena", "project"], enabled: enabled && owner.available(),
    read: () => strategyCommands.default({ ...context, locale: state.locale }) });
  const history = useSessionQuery({ key: strategyKeys.defaults(state.locale, historyOffset), scopes: ["arena", "project"], enabled: enabled && owner.available(),
    read: () => strategyCommands.defaults({ ...context, locale: state.locale, offset: historyOffset, limit: 50 }) });
  const defaultCandidateId = future.data?.reference?.candidateId;
  const defaultCandidate = useSessionQuery({ key: ["context-strategy-candidate", defaultCandidateId], scopes: ["arena", "source", "translation"],
    enabled: enabled && !!defaultCandidateId, read: () => strategyCommands.candidate({ ...context, candidateId: defaultCandidateId! }) });
  const selectedId = state.candidate?.candidateId;
  const selectedCandidate = useSessionQuery({ key: ["context-strategy-candidate", selectedId], scopes: ["arena", "source", "translation"],
    enabled: enabled && !!selectedId, read: () => strategyCommands.candidate({ ...context, candidateId: selectedId! }) });
  const evaluationId = state.evaluationId;
  const evaluation = useSessionQuery({ key: strategyKeys.evaluation(evaluationId ?? ""), scopes: ["arena", "source", "resources", "translation", "review", "execution"],
    enabled: enabled && !!evaluationId, read: () => strategyCommands.evaluation({ ...context, evaluationId: evaluationId! }) });
  const view = evaluation.data, attemptId = view?.evaluation.attemptId;
  const arena = useSessionQuery({ key: ["arena", attemptId], scopes: ["arena", "execution", "translation", "source", "review"],
    enabled: enabled && !!attemptId && !state.prepared, read: () => owner.readArena(attemptId!) });
  const queries = [source, page, candidates, evaluations, future, history, defaultCandidate, selectedCandidate, evaluation, arena];
  const readError = queries.find(query => query.error)?.error;
  const failure = state.failure ?? (readError ? commandFailure(readError) : null), diagnostic = failureReason(failure);
  const failureKey = diagnostic === "strategy-report" ? "strategy.invalidReport" : diagnostic === "strategy-correction" ? "strategy.invalidCorrection"
    : diagnostic === "strategy-correction-stale" ? "strategy.correctionStale" : state.pending?.uncertain ? "strategy.unknown"
    : isCommandError(failure) && failure.outcome === "rejected" && failure.reason === "strategy-checks-incomplete" ? "strategy.checksIncomplete"
    : isCommandError(failure) && failure.outcome === "rejected" && failure.reason === "strategy-no-improvement" ? "strategy.noImprovement"
    : state.notice === "recordedReadFailed" ? "strategy.recordedReadFailed" : !state.failure && readError ? "strategyView.readFailed" : "strategy.failed";
  const entries = page.error || page.isFetching || source.error || source.isFetching ? [] : page.data?.rows ?? [];
  const loadedPages = reads.client.getQueriesData<ContentPage>({ queryKey: reads.key(["source-content", source.data?.currentSnapshot ?? ""]) });
  function selectedEntryName(id: string) {
    return loadedPages.flatMap(([, value]) => value?.rows ?? []).find(row => row.unitId === id)?.occurrence.key
      ?? state.suite?.preview.items.find(row => row.item.unitId === id)?.item.nativeKey ?? t("strategyView.selectedEntry");
  }
  const roleIds = Object.keys(state.roles), calibration = roleIds.filter(id => state.roles[id] === "calibration"), holdout = roleIds.filter(id => state.roles[id] === "holdout");
  const intentKey = intent ? JSON.stringify([intent.unitId, intent.locale, intent.sequence]) : null;
  const pendingIntent = intent && intentKey !== handledIntent ? intent : null;
  const originalRequest = owner.pendingIdentity(), requestKey = requestTarget ? JSON.stringify([requestTarget.actionId, requestTarget.submittedSeq]) : null;
  const requestChanged = !!requestTarget && dismissedRequest !== requestKey && !state.hydrating
    && (originalRequest?.actionId !== requestTarget.actionId || originalRequest?.submittedSeq !== requestTarget.submittedSeq);
  function applyIntent() {
    if (!pendingIntent || !current() || owner.reserved() || owner.dirty() || !project.metadata.targetLocales.includes(pendingIntent.locale)) return;
    if (owner.current().locale !== pendingIntent.locale && !owner.setLocale(pendingIntent.locale)) return;
    setHandledIntent(intentKey); setStep("candidate"); setAfter(0); setCandidateOffset(0); setEvaluationOffset(0); setHistoryOffset(0);
    const target = pendingIntent;
    owner.edit("correctionUnit", target.unitId);
    const editSeq = owner.current().editSeq;
    void owner.flush().then(saved => {
      const latest = owner.current();
      if (saved && current() && latest.editSeq === editSeq && latest.correctionUnit === target.unitId && latest.locale === target.locale) void owner.inspectCorrection();
    });
  }
  useEffect(() => { if (pendingIntent && !owner.dirty()) applyIntent(); });
  function edit<K extends "reason" | "exceptions" | "sourceContext" | "correctionUnit" | "config" | "roles">(key: K, value: StrategyOwner["state"][K]) {
    if (inputAllowed()) owner.edit(key, value);
  }
  function defaultCurrent() {
    const query = reads.client.getQueryState(reads.key(strategyKeys.default(owner.current().locale)));
    return current() && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null && query.data === future.data;
  }
  function refresh() {
    if (!current()) return;
    void source.refetch(); if (source.data?.currentSnapshot) void page.refetch();
    void candidates.refetch(); void evaluations.refetch(); void future.refetch(); void history.refetch();
    if (defaultCandidateId) void defaultCandidate.refetch(); if (selectedId) void selectedCandidate.refetch();
    if (evaluationId) void evaluation.refetch(); if (attemptId && !state.prepared) void arena.refetch();
  }
  function originalArenaCurrent(value: ArenaView) {
    const query = reads.client.getQueryState(reads.key(["arena", value.detail.attemptId]));
    return current() && owner.current().evaluationId === view?.evaluation.evaluationId && view?.evaluation.attemptId === value.detail.attemptId
      && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null && query.data === value;
  }
  async function stopEvaluation(value: ArenaView) {
    if (!tasks || !originalArenaCurrent(value)) return;
    const target = { taskId: value.detail.taskId, attemptId: value.detail.attemptId, origin: "arena" as const };
    const witness = reads.watchExactQuery(["arena", value.detail.attemptId]), captured = witness.current(), version = captured?.state.dataUpdateCount;
    const proof = () => originalArenaCurrent(value) && witness.current() === captured && captured !== undefined && captured.state.dataUpdateCount === version;
    try { if (tasks.canCancel(target, proof)) await tasks.cancel(target, proof); }
    finally { witness.dispose(); }
  }
  const localeChoice = <Choice label={t("strategy.locale")} value={state.locale || t("strategy.chooseLocale")} disabled={locked() || owner.dirty()}
    choices={project.metadata.targetLocales.map(locale => ({ id: locale, label: locale }))} onSelect={locale => {
      if (!locked() && owner.setLocale(locale)) { setAfter(0); setCandidateOffset(0); setEvaluationOffset(0); setHistoryOffset(0); }
    }}/>;
  const sourcePaging = <div className={styles.actions}><Button size="sm" disabled={!current() || page.isFetching || after === 0} onClick={() => { if (current()) setAfter(0); }}>{t("ai.first")}</Button>
    <Button size="sm" disabled={!current() || page.isFetching || page.data?.nextOrdinal == null} onClick={() => { if (current() && page.data?.nextOrdinal != null) setAfter(page.data.nextOrdinal); }}>{t("strategy.next")}</Button></div>;
  if (!visible) return null;
  return <section className={styles.view} aria-label={t("strategyView.title")} onCompositionStartCapture={() => gate.setComposing(inputId, true)} onCompositionEndCapture={() => gate.setComposing(inputId, false)}
    onFocusCapture={event => { if (inputAllowed() && (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) gate.setInputOwner(viewId, inputId); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputId); }}>
    <header className={styles.header}><h1>{t("strategyView.title")}</h1><p className={styles.help}>{t("strategyView.subtitle")}</p>
      <p className={styles.help}>{t("strategy.scope", { project: project.metadata.displayName, locale: state.locale })}</p>{localeChoice}</header>
    <div className={styles.status}>
      {state.journalFailure ? <Banner tone="error" role="alert"
        action={<Button size="sm" disabled={!current() || state.journalBusy} onClick={() => { if (current()) void owner.retryJournal(); }}>{t("strategyView.retryLocal")}</Button>}>
        <p>{t("strategyView.localFailure")}</p><CommandFailureDetails failure={state.journalFailure}/></Banner>
        : state.hydrating ? <LoadingState label={t("strategyView.localLoading")}/>
        : <p className={styles.help} role={state.journalBusy || state.journalDirty ? "status" : undefined}>{t(state.journalBusy || state.journalDirty ? "strategyView.localSaving" : "strategyView.localSaved")}</p>}
      {!owner.available() ? <Banner tone="warning">{t("strategyView.noLocale")}</Banner> : null}
      {pendingIntent ? <Banner tone={owner.dirty() ? "warning" : "info"}><p>{t(owner.dirty() ? "strategyView.intentBlocked" : "strategyView.intentReady", { locale: pendingIntent.locale })}</p>
        <div className={styles.actions}><Button size="sm" disabled={locked() || owner.dirty()} onClick={applyIntent}>{t("strategyView.loadIntent")}</Button>
          <Button size="sm" disabled={!current()} onClick={() => { if (current()) setHandledIntent(intentKey); }}>{t("strategyView.dismissIntent")}</Button></div></Banner> : null}
      {requestChanged ? <Banner tone="info"><p>{t("strategyView.requestChanged")}</p><div className={styles.actions}><Button size="sm" disabled={!current()} onClick={() => {
        if (current()) { setDismissedRequest(requestKey); setStep("history"); }
      }}>{t("strategyView.viewCurrent")}</Button></div></Banner> : null}
      {failure ? <Banner tone="error" role="alert"><p>{t(failureKey)}</p><CommandFailureDetails failure={failure}/><div className={styles.actions}>
        <Button size="sm" disabled={!current() || state.busy} onClick={refresh}>{t("strategy.refresh")}</Button></div></Banner> : null}
      {state.notice ? <p role="status">{t(`strategy.${state.notice}`)}</p> : null}
      {state.pending?.uncertain && !requestChanged ? <Banner tone="warning" role="status"><h2>{t("strategyView.originalRequest")}</h2><p>{t(state.checkingAction ? "strategy.checkingSaved" : state.pending.kind === "check" || state.pending.kind === "prepare-check" ? "strategy.checkUnknown" : "strategy.unknown")}</p>
        <div className={styles.actions}><Button size="sm" disabled={!current() || state.busy} onClick={() => { if (current() && !owner.current().busy) void owner.reconcile(); }}>{t("strategy.reconcile")}</Button>
          {state.pending.retryAllowed ? <Button size="sm" disabled={!current() || state.busy} onClick={() => { if (current() && !owner.current().busy) void owner.retry(); }}>{t("strategy.retryOriginal")}</Button> : null}</div></Banner> : null}
      {state.pending?.uncertain && !requestChanged && (state.pending.kind === "start" || state.pending.kind === "check" || state.pending.kind === "prepare-check") ? <div className={styles.section}>
        <p className={styles.help}>{t("strategyView.closeHelp")}</p><div className={styles.actions}><Button size="sm" disabled={!current() || state.busy || state.journalBusy || state.journalDirty || !!state.journalFailure}
          onClick={() => { if (current() && !owner.current().busy) void owner.closePending(); }}>{t(state.pending.kind === "start" ? "strategyView.closeEvaluation" : "strategyView.closeCheck")}</Button></div></div> : null}
      {state.pending?.kind === "check" && !requestChanged ? <div className={styles.actions}><Button size="sm" disabled={!current()} onClick={() => { if (current()) void owner.cancelCheck(); }}>{t("review.cancelCheck")}</Button></div> : null}
      {state.busy && !state.pending?.uncertain ? <p role="status">{t("strategyView.working")}</p> : null}
      {queries.some(query => query.isFetching) ? <p className={styles.help} role="status">{t("strategy.loading")}</p> : null}
    </div>
    <TabsRoot className={styles.tabs} value={step} onValueChange={value => { if (current() && (value === "candidate" || value === "experiment" || value === "results" || value === "history")) setStep(value); }}>
      <TabsList className={styles.tabList} aria-label={t("strategyView.navigation")}>{(["candidate", "experiment", "results", "history"] as const).map(value => <TabsTrigger key={value} value={value}>{t(`strategyView.${value}`)}</TabsTrigger>)}</TabsList>
      <TabsContent value="candidate" className={styles.body}>
        <section className={styles.section}><h2>{t("strategy.correction")}</h2><p className={styles.help}>{t("strategy.correctionHelp")}</p>
          <Choice label={t("strategy.correction")} value={entries.find(row => row.unitId === state.correctionUnit)?.occurrence.key ?? state.evidence?.sourceText ?? t("strategy.chooseCorrection")} disabled={locked()}
            choices={entries.flatMap(row => row.unitId ? [{ id: row.unitId, label: `${row.occurrence.key} · ${row.occurrence.text}` }] : [])} onSelect={id => edit("correctionUnit", id)}/>
          {!source.data?.currentSnapshot && !source.isFetching ? <p className={styles.help}>{t("strategy.emptySource")}</p> : null}{sourcePaging}
          <div className={styles.actions}><Button size="sm" variant="secondary" disabled={locked() || !state.correctionUnit} onClick={() => { if (!locked()) void owner.inspectCorrection(); }}>{t("strategy.inspectCorrection")}</Button></div>
          {state.evidence ? <><CorrectionEvidence source={state.evidence.sourceText} before={state.evidence.beforeText} after={state.evidence.afterText}/>
            {state.stale ? <Banner tone="warning">{t("strategy.correctionStale")}</Banner> : null}</> : null}
        </section>
        <section className={styles.section}><h2>{t("strategyView.candidateHelp")}</h2><fieldset className={styles.form} disabled={!inputAllowed()}>
          <SourceContextFields value={state.sourceContext} onChange={value => edit("sourceContext", value)}/>
          <Field label={t("strategy.reason")} required><TextArea rows={3} value={state.reason} maxLength={4096} onChange={event => edit("reason", event.target.value)}/></Field>
          <Field label={t("strategy.exceptions")} required description={t("strategy.reasonHelp")}><TextArea rows={3} value={state.exceptions} maxLength={4096} onChange={event => edit("exceptions", event.target.value)}/></Field>
        </fieldset><p className={styles.help}>{t("strategy.immutable")}</p>
          <div className={styles.actions}><Button variant="primary" disabled={locked() || !owner.canCapture()} pending={state.busy && state.pending?.kind === "candidate"} onClick={() => { if (!locked()) void owner.capture(); }}>{t("strategy.create")}</Button></div>
        </section>
        {state.candidate ? <section className={styles.section}><p>{t("strategy.savedVersion", { reason: state.candidate.reason })}</p><p className={styles.help}>{t("strategyView.candidateReady")}</p>
          <div className={styles.actions}><Button variant="secondary" disabled={!current()} onClick={() => { if (current()) setStep("experiment"); }}>{t("strategyView.continue")}</Button></div></section> : null}
      </TabsContent>
      <TabsContent value="experiment" className={styles.body}>{state.candidate ? <>
        <section className={styles.section}><h2>{t("strategy.savedVersion", { reason: state.candidate.reason })}</h2><p className={styles.text}>{state.candidate.exceptions}</p><SourceContextSelectionSummary value={state.candidate.sourceContext}/>
          {!state.candidate.evidence.current || selectedCandidate.data?.evidence.current === false ? <Banner tone="warning">{t("strategy.correctionStale")}</Banner> : null}
          <Disclosure show="strategyView.showOriginal" hide="strategyView.hideOriginal"><CorrectionEvidence source={state.candidate.evidence.sourceText} before={state.candidate.evidence.beforeText} after={state.candidate.evidence.afterText}/></Disclosure>
          <Disclosure show="strategyView.showDetails" hide="strategyView.hideDetails"><p className={styles.diagnostic}>{state.candidate.candidateId}</p><p className={styles.diagnostic}>{state.candidate.digest}</p></Disclosure>
        </section>
        <section className={styles.section}><h2>{t("strategy.suite")}</h2><p className={styles.help}>{t("strategyView.roleHelp")}</p><p>{t("strategy.setCount", { calibration: calibration.length, holdout: holdout.length })}</p>
          <ul className={styles.list} aria-label={t("strategyView.sourcePage")}>{entries.map(row => row.unitId ? <li key={row.unitId} className={styles.entry}>
            <p>{row.occurrence.key}</p><div className={styles.text}><TokenizedText text={row.occurrence.text}/></div>
            <Choice label={t("strategyView.assignment", { entry: row.occurrence.key })} value={t(state.roles[row.unitId] === "calibration" ? "strategy.calibration" : state.roles[row.unitId] === "holdout" ? "strategy.holdout" : "strategy.unused")}
              disabled={!inputAllowed()} choices={[{ id: "unused", label: t("strategy.unused") }, { id: "calibration", label: t("strategy.calibration"), disabled: roleIds.length >= 20 && !state.roles[row.unitId] },
                { id: "holdout", label: t("strategy.holdout"), disabled: row.unitId === state.candidate?.evidence.basis.unitId || roleIds.length >= 20 && !state.roles[row.unitId] }]}
              onSelect={value => { const roles = { ...owner.current().roles }; if (value === "calibration" || value === "holdout") roles[row.unitId!] = value; else delete roles[row.unitId!]; edit("roles", roles); }}/>
            {row.unitId === state.candidate?.evidence.basis.unitId ? <p className={styles.help}>{t("strategyView.excludedCorrection")}</p> : null}
          </li> : null)}</ul>{sourcePaging}
          {roleIds.filter(id => !entries.some(row => row.unitId === id)).map(id => <div key={id} className={styles.sectionHeader}><p>{selectedEntryName(id)} · {t(state.roles[id] === "holdout" ? "strategy.holdout" : "strategy.calibration")}</p>
            <Button size="sm" disabled={!inputAllowed()} aria-label={t("strategyView.removeEntry", { entry: selectedEntryName(id) })} onClick={() => { const roles = { ...owner.current().roles }; delete roles[id]; edit("roles", roles); }}>{t("strategy.unused")}</Button></div>)}
        </section>
        <section className={styles.section}><h2>{t("strategy.conditions")}</h2><p className={styles.help}>{t("strategy.conditionsHelp")}</p>
          {config ? <div className={styles.actions}><Button size="sm" disabled={locked()} onClick={() => { if (!locked()) owner.copyConfig(config); }}>{t("strategy.useConnection")}</Button></div> : null}
          <ConnectionFields owner={owner} enabled={enabled} locked={locked} inputAllowed={inputAllowed} current={current} onOpenConnections={onOpenConnections}/>
          <p className={styles.help}>{t("strategyView.promptSharing")}</p><PreparationBudgetSummary config={state.config}/>
          {!state.config.endpoint || !state.config.model ? <p className={styles.help}>{t("strategy.noConnection")}</p> : null}
          <div className={styles.actions}><Button variant={state.suite || state.prepared ? "secondary" : "primary"} disabled={locked() || !state.candidate.evidence.current || selectedCandidate.data?.evidence.current === false || !!selectedCandidate.error || selectedCandidate.isFetching
            || calibration.length < 1 || holdout.length < 1 || roleIds.length > 20 || !state.config.endpoint || !state.config.model || !validAiLimits(state.config)}
            onClick={() => { if (!locked()) void owner.captureSuite(); }}>{t("strategy.saveSuite")}</Button>
            {state.suite && !state.prepared ? <Button variant="primary" disabled={locked()} onClick={() => { if (!locked()) void owner.prepare(); }}>{t("strategy.evaluate")}</Button> : null}</div>
          {state.suite ? <p className={styles.help}>{t("strategyView.frozen")}</p> : null}
          {state.suite && !state.prepared ? <Disclosure show="strategyView.showMaterials" hide="strategyView.hideMaterials"><ComparisonMaterials preview={state.suite.preview}/></Disclosure> : null}
        </section>
        {state.prepared ? <section className={styles.section} aria-label={t("strategy.preview")}><h2>{t("strategy.preview")}</h2><p className={styles.help}>{t("strategyView.previewHelp")}</p>
          <ComparisonMaterials preview={state.prepared.preview}/>
          <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={state.consent} disabled={locked() || !state.prepared.canStart || state.stale}
            onChange={event => { if (!locked()) owner.setConsent(event.target.checked); }}/><span>{t("strategy.consent")}</span></label>
          {state.stale || !state.prepared.canStart ? <Banner tone="warning">{t("strategy.previewChanged")}</Banner> : null}
          <div className={styles.actions}><Button variant="primary" disabled={locked() || !owner.canStart()} onClick={() => { if (!locked()) void owner.start().then(() => { if (current()) setStep("results"); }); }}>{t("strategy.start")}</Button></div>
        </section> : null}
      </> : <EmptyState title={t("strategyView.candidateRequired")} action={<Button variant="secondary" onClick={() => { if (current()) setStep("history"); }}>{t("strategyView.openHistory")}</Button>}/>}</TabsContent>
      <TabsContent value="results" className={styles.body}>{view ? <>
        <section className={styles.section}><h2>{t("strategy.originalResults")}</h2><p>{t("strategyView.originalEvaluation", { reason: view.candidate.reason, locale: view.suite.locale })}</p>
          <p className={styles.help}>{t(view.current ? "strategy.current" : "strategy.stale")}</p><p className={styles.help}>{t("strategy.burdenUnknown")}</p>
          {evaluation.isFetching || arena.isFetching ? <p className={styles.help}>{t("strategyView.staleRead")}</p> : null}
          {arena.data ? <StrategyResults onOpenEntry={onOpenEntry} owner={owner} view={view} arena={arena.data} disabled={disabled} current={current} inputAllowed={inputAllowed}/> : arena.isPending ? <LoadingState label={t("strategy.loading")}/> : null}
          {tasks && arena.data ? <EvaluationCancellation tasks={tasks} arena={arena.data} current={current} fresh={() => originalArenaCurrent(arena.data!)} stop={() => { if (arena.data) void stopEvaluation(arena.data); }}/> : null}
        </section>
        <section className={styles.section}><h2>{t("strategy.defaultTitle")}</h2><p className={styles.help}>{t("strategy.promoteHelp")}</p>
          <div className={styles.actions}><Button variant="primary" disabled={locked() || !view.current || !owner.evaluationCurrent(view) || !defaultCurrent()}
            onClick={() => { if (!locked() && defaultCurrent()) void owner.changeDefault(view, false, future.data?.revisionId ?? null, defaultCurrent); }}>{t("strategy.promote")}</Button></div></section>
      </> : <EmptyState title={t("strategyView.resultsEmpty")} description={t("strategyView.resultsEmptyHelp")} action={<Button variant="secondary" onClick={() => { if (current()) setStep("history"); }}>{t("strategyView.openHistory")}</Button>}/>}</TabsContent>
      <TabsContent value="history" className={styles.body}>
        <section className={styles.section}><h2>{t("strategyView.candidatesTitle")}</h2>{candidates.isSuccess && !candidates.data.rows.length ? <p className={styles.help}>{t("strategy.noCandidates")}</p> : null}
          <ul className={styles.list}>{candidates.data?.rows.map(candidate => <li key={candidate.candidateId} className={styles.entry}><p className={styles.text}>{candidate.reason}</p><p className={styles.help}>{candidate.exceptions}</p>
            <div className={styles.actions}><Button size="sm" variant="secondary" disabled={locked() || owner.dirty()} onClick={() => { if (!locked() && owner.chooseCandidate(candidate)) setStep("experiment"); }}>{t("strategyView.candidateLabel", { reason: candidate.reason, locale: candidate.locale })}</Button></div></li>)}</ul>
          <HistoryPaging offset={candidateOffset} next={candidates.data?.nextOffset ?? null} disabled={!current() || candidates.isFetching} onPage={setCandidateOffset}/>
        </section>
        <section className={styles.section}><h2>{t("strategyView.evaluationsTitle")}</h2><p className={styles.help}>{t("strategyView.allEvaluations")}</p>{evaluations.isSuccess && !evaluations.data.rows.length ? <p className={styles.help}>{t("strategyView.evaluationsEmpty")}</p> : null}
          <ul className={styles.list}>{evaluations.data?.rows.map((row, index) => <li key={row.evaluationId} className={styles.entry}><div className={styles.actions}><Button size="sm" variant="secondary" disabled={locked() || owner.dirty()}
            onClick={() => { if (!locked() && owner.selectEvaluation(row.evaluationId)) setStep("results"); }}>{t("strategyView.evaluation", { number: evaluationOffset + index + 1, locale: row.locale })}</Button></div></li>)}</ul>
          <HistoryPaging offset={evaluationOffset} next={evaluations.data?.nextOffset ?? null} disabled={!current() || evaluations.isFetching} onPage={setEvaluationOffset}/>
        </section>
        <section className={styles.section}><h2>{t("strategy.defaultTitle")}</h2>{future.isSuccess ? <p>{t(future.data?.reference ? "strategy.currentDefault" : "strategy.noDefault")}</p> : null}
          {defaultCandidate.data ? <><p className={styles.text}>{defaultCandidate.data.reason}</p><p className={styles.text}>{defaultCandidate.data.exceptions}</p><SourceContextSelectionSummary value={defaultCandidate.data.sourceContext}/>
            <Disclosure show="strategyView.showOriginal" hide="strategyView.hideOriginal"><CorrectionEvidence source={defaultCandidate.data.evidence.sourceText} before={defaultCandidate.data.evidence.beforeText} after={defaultCandidate.data.evidence.afterText}/></Disclosure></> : null}
          <p className={styles.help}>{t("strategy.withdrawHelp")}</p><div className={styles.actions}><Button variant="secondary" disabled={locked() || !future.data?.reference || !defaultCurrent()}
            onClick={() => { if (!locked() && defaultCurrent()) void owner.changeDefault(null, true, future.data?.revisionId ?? null, defaultCurrent); }}>{t("strategy.withdraw")}</Button></div>
        </section>
        <section className={styles.section}><h2>{t("strategy.history")}</h2>{history.isSuccess && !history.data.rows.length ? <p className={styles.help}>{t("strategy.historyEmpty")}</p> : null}
          <ol className={styles.list} start={historyOffset + 1}>{history.data?.rows.map(row => <li className={styles.entry} key={row.revisionId}><p>{t(row.reference ? "strategy.historyApplied" : "strategy.historyWithdrawn")} · {row.locale}</p>
            {row.evaluationId ? <div className={styles.actions}><Button size="sm" disabled={locked() || owner.dirty()} onClick={() => { if (!locked() && row.evaluationId && owner.selectEvaluation(row.evaluationId)) setStep("results"); }}>{t("strategyView.openAdoptedEvaluation")}</Button></div> : null}</li>)}</ol>
          <HistoryPaging offset={historyOffset} next={history.data?.nextOffset ?? null} disabled={!current() || history.isFetching} onPage={setHistoryOffset}/>
        </section>
      </TabsContent>
    </TabsRoot>
    <footer className={styles.footer}><Button size="sm" disabled={!current() || state.busy} onClick={refresh}>{t("strategy.refresh")}</Button>
      <Button size="sm" disabled={locked()} onClick={() => { if (!locked()) { if (owner.dirty()) setResetOpen(true); else if (owner.reset()) setStep("candidate"); } }}>{t("strategy.reset")}</Button></footer>
    <Dialog open={resetOpen && visible} onOpenChange={setResetOpen} title={t("strategyView.newDraftTitle")} description={t("strategyView.newDraftHelp")} closeLabel={t("strategyView.cancel")}
      footer={<><Button onClick={() => setResetOpen(false)}>{t("strategyView.cancel")}</Button><Button variant="danger" disabled={owner.reserved()} onClick={() => {
        if (present() && gate.canDispatch({ viewId, source: "button", dialogId }) && !owner.reserved() && owner.reset()) { setResetOpen(false); setStep("candidate"); }
      }}>{t("strategy.reset")}</Button></>}><p>{t("strategy.immutable")}</p></Dialog>
  </section>;
}

function Choice({ label, value, choices, disabled, onSelect }: { label: string; value: string; choices: { id: string; label: string; disabled?: boolean }[]; disabled?: boolean; onSelect: (id: string) => void }) {
  return <Field label={label}>{control => <Menu label={label} align="start" trigger={<Button {...control} className={styles.choice} variant="secondary" aria-label={label} disabled={disabled}>{value}</Button>}
    items={choices.map(choice => ({ ...choice, onSelect: () => onSelect(choice.id) }))}/>}</Field>;
}
function Disclosure({ show, hide, children }: { show: TranslationKey; hide: TranslationKey; children: ReactNode }) {
  const { t } = useTranslation(), [open, setOpen] = useState(false), id = useId();
  return <div className={styles.section}><div><Button size="sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{t(open ? hide : show)}</Button></div><div id={id} hidden={!open}>{open ? children : null}</div></div>;
}
function CorrectionEvidence({ source, before, after }: { source: string; before: string; after: string }) {
  const { t } = useTranslation();
  return <div className={styles.evidence}>{([["strategy.source", source], ["strategy.before", before], ["strategy.after", after]] as const).map(([label, text]) => <div key={label}><h3>{t(label)}</h3><div className={styles.text}><TokenizedText text={text}/></div></div>)}</div>;
}
function SourceContextFields({ value, onChange }: { value: AiConfig["sourceContext"]; onChange: (value: AiConfig["sourceContext"]) => void }) {
  const { t } = useTranslation(), selected = value.extracted || value.inferred || value.neighbors;
  return <fieldset className={styles.choices}><legend>{t("sourceContext.title")}</legend><p className={styles.help}>{t("sourceContext.help")}</p>
    {(["extracted", "inferred", "neighbors"] as const).map(key => <label key={key} className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={value[key]} onChange={event => onChange({ ...value, [key]: event.target.checked })}/><span>{t(`sourceContext.choose.${key}`)}</span></label>)}
    <SourceContextSelectionSummary value={value}/>{selected ? <><Field label={t("sourceContext.maxBytes")}><TextInput type="number" min={sourceContextMinBytes} max={16384} value={Number.isFinite(value.maxBytes) ? value.maxBytes : ""} onChange={event => onChange({ ...value, maxBytes: event.target.valueAsNumber })}/></Field>
      <Field label={t("sourceContext.maxItems")} error={!validSourceContextSelection(value) ? t("sourceContext.invalidBudget") : undefined}><TextInput type="number" min={1} max={128} value={Number.isFinite(value.maxItems) ? value.maxItems : ""} onChange={event => onChange({ ...value, maxItems: event.target.valueAsNumber })}/></Field></> : null}
  </fieldset>;
}
function ConnectionFields({ owner, enabled, locked, inputAllowed, current, onOpenConnections }: { owner: StrategyOwner; enabled: boolean; locked: () => boolean; inputAllowed: () => boolean; current: () => boolean; onOpenConnections?: () => void }) {
  const { t } = useTranslation(), client = useApplicationQueryClient(), query = useQuery({ ...connectionReadOptions(), enabled }, client);
  const config = owner.state.config, view = currentConnections(client), linked = !!config.connectionProfile, matching = connectionConfigCurrent(view, config), subscription = isChatGptSubscription(config);
  const profiles = query.data?.snapshot.profiles.filter(profile => !profile.archived) ?? [];
  const selected = matching ? profiles.find(profile => profile.id === config.connectionProfile?.profileId)?.name : undefined;
  function change<K extends keyof AiConfig>(key: K, value: AiConfig[K]) { if (inputAllowed()) { const before = owner.current().config; owner.edit("config", editedAiConfig(before, { ...before, [key]: value })); } }
  return <div className={styles.section}>
    <Choice label={t("strategyView.connection")} value={selected ?? (linked ? t("strategyView.connectionCaptured", { model: config.model }) : t("strategyView.connectionOnce"))} disabled={locked()}
      choices={[{ id: "", label: t("strategyView.connectionOnce") }, ...profiles.map(profile => ({ id: profile.id, label: `${profile.name} · ${profile.connection.model}`, disabled: !view }))]}
      onSelect={id => { if (!locked()) owner.selectConnection(currentConnections(client) ?? null, id, owner.current().editSeq); }}/>
    {query.isFetching ? <p role="status">{t("connections.loading")}</p> : query.isError ? <Banner tone="error"><p>{t("connections.readFailed")}</p><CommandFailureDetails failure={commandFailure(query.error)}/></Banner>
      : view && profiles.length === 0 ? <p className={styles.help}>{t("connections.empty")}</p> : null}
    {linked ? <p className={styles.help}>{t(matching ? "connections.selectionCurrent" : view ? "connections.selectionChanged" : "connections.selectionChecking")}</p> : null}
    <div className={styles.actions}><Button size="sm" disabled={!current() || query.isFetching} onClick={() => { if (current()) void query.refetch(); }}>{t("connections.refresh")}</Button>
      {onOpenConnections ? <Button size="sm" disabled={!current()} onClick={() => { if (current()) onOpenConnections(); }}>{t("connections.manage")}</Button> : null}</div>
    <Disclosure show="strategyView.advanced" hide="strategyView.hideAdvanced"><fieldset className={styles.form} disabled={!inputAllowed()}>
      {subscription ? <p className={styles.help}>{t("connections.chatgpt.preparationHelp", { model: config.model })}</p> : <>
        {(["endpoint", "model", "credentialEnv"] as const).map(key => <Field key={key} label={t(`ai.${key}`)} description={key === "credentialEnv" ? t("ai.credentialHelp") : undefined}><TextInput type={key === "endpoint" ? "url" : "text"} value={config[key]} onChange={event => change(key, event.target.value)}/></Field>)}
        <Choice label={t("strategyView.tokenField")} value={config.tokenField} disabled={!inputAllowed()} choices={[{ id: "max_tokens", label: "max_tokens" }, { id: "max_completion_tokens", label: "max_completion_tokens" }]} onSelect={value => change("tokenField", value)}/>
      </>}
      {aiNumericLimits.filter(([key]) => !subscription || key !== "maxOutputTokens" && key !== "maxRetries").map(([key, min, max]) => <Field key={key} label={t(`ai.${key}`)}><TextInput type="number" min={min} max={max} value={Number.isFinite(config[key]) ? config[key] : ""} onChange={event => change(key, event.target.valueAsNumber)}/></Field>)}
      <div className={styles.actions}><Button size="sm" disabled={!inputAllowed()} onClick={() => { if (inputAllowed()) { const before = owner.current().config; owner.edit("config", { ...before, maxItems: defaultAiConfig.maxItems, concurrency: defaultAiConfig.concurrency, maxRequests: defaultAiConfig.maxRequests,
        maxOutputTokens: subscription ? 0 : defaultAiConfig.maxOutputTokens, maxRetries: defaultAiConfig.maxRetries, timeoutSeconds: defaultAiConfig.timeoutSeconds }); } }}>{t("ai.reset")}</Button></div>
    </fieldset></Disclosure>
  </div>;
}
function ComparisonMaterials({ preview }: { preview: StrategySuite["preview"] }) {
  const { t } = useTranslation();
  return <div className={styles.materials}>{preview.config.variants.map((variant, index) => <section className={styles.section} key={index}><h3>{t(index === 0 ? "strategy.baseline" : "strategy.candidateSlot")}</h3><p>{variant.endpoint} · {variant.model}</p><PreparationBudgetSummary config={variant}/></section>)}
    {preview.items.map(row => <article key={`${row.sourceOrder}:${row.slot}`} className={styles.section}><h3>{row.item.nativeKey} · {t(row.slot === 0 ? "strategy.baseline" : "strategy.candidateSlot")}</h3>
      <div className={styles.text}><TokenizedText text={row.item.sourceText}/></div><SourceContextPreview capture={row.item.sourceContext}/><ProjectFactPreview capture={row.item.projectContext}/><ContextResourceCapturePreview capture={row.item.contextResources}/></article>)}</div>;
}
function HistoryPaging({ offset, next, disabled, onPage }: { offset: number; next: number | null; disabled: boolean; onPage: (offset: number) => void }) {
  const { t } = useTranslation();
  return <div className={styles.section}><p className={styles.help}>{t("strategy.historyPage")}</p><div className={styles.actions}><Button size="sm" disabled={disabled || offset === 0} onClick={() => { if (!disabled) onPage(Math.max(0, offset - 50)); }}>{t("strategy.previous")}</Button>
    <Button size="sm" disabled={disabled || next === null} onClick={() => { if (!disabled && next !== null) onPage(next); }}>{t("strategy.next")}</Button></div></div>;
}

function EvaluationCancellation({ tasks, arena, current, fresh, stop }: { tasks: ReturnType<typeof useExecutionTaskSession>; arena: ArenaView; current: () => boolean; fresh: () => boolean; stop: () => void }) {
  const { t } = useTranslation(), target = { taskId: arena.detail.taskId, attemptId: arena.detail.attemptId, origin: "arena" as const };
  const value = tasks.current(target.taskId), record = value?.target.attemptId === target.attemptId ? value : null;
  const active = arena.detail.progress.queued + arena.detail.progress.running > 0;
  const original = () => current() && tasks.current(target.taskId) === record;
  return <section className={styles.section} aria-label={t("execution.cancelStatus")}>
    {active ? <><p className={styles.help}>{t("strategyView.stopHelp")}</p><div className={styles.actions}><Button size="sm" disabled={!fresh() || !tasks.canCancel(target)} onClick={stop}>{t("strategyView.stopEvaluation")}</Button></div></> : null}
    {record ? <>
      {record.failure ? <Banner tone="warning" role="alert"><p>{t("strategyView.stopFailed")}</p><CommandFailureDetails failure={record.failure}/></Banner> : null}
      <p role="status">{t(record.phase === "recorded" ? "execution.cancelRecorded" : record.phase === "checking" ? "execution.checkingCancellation" : record.phase === "unknown" ? "execution.cancelUnknown"
        : record.phase === "rejected" ? record.request ? "execution.cancelRejected" : "execution.cancelPreparationFailed" : "execution.cancelPending")}</p>
      {record.phase === "unknown" ? <div className={styles.actions}><Button size="sm" disabled={!current()} onClick={() => { if (original()) void tasks.checkCancellation(target.taskId); }}>{t("execution.checkCancellation")}</Button>
        {record.retryAllowed ? <Button size="sm" disabled={!current()} onClick={() => { if (original()) void tasks.retry(target.taskId); }}>{t("execution.retryCancellation")}</Button> : null}</div> : null}
      <Disclosure show="strategyView.showDetails" hide="strategyView.hideDetails"><p className={styles.diagnostic}>{t("execution.cancelTaskIdentity")} {record.target.taskId}</p>
        {record.request ? <p className={styles.diagnostic}>{t("execution.cancelRequestIdentity")} {record.request.requestId}</p> : null}
        {record.revision ? <p>{t("execution.revision", { number: record.revision })}</p> : null}</Disclosure>
    </> : null}
  </section>;
}

export default StrategyView;
