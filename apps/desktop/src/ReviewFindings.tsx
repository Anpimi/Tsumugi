import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import { useReviewDraftSession, reviewDraftKey } from "./ReviewDraftSession";
import { ReviewDiagnosticDetails, ruleIdentity } from "./ReviewCheckers";
import { executionContext } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { reviewCommands, type ReviewTarget, type ReviewFindingView, type ReviewFindingDisposition, type ReviewFindingDecision } from "./reviewCommands";
import { useSessionAlive, useSessionQuery, useSessionReads } from "./SessionReadProvider";
import type { EditorTarget } from "./TranslationWorkbench";
import { useWorkbenchCommands, type ReviewFindingCommandPayload } from "./workbenchCommands";
import { currentDiagnosticRun, reviewDiagnostics } from "./reviewDiagnosticNavigation";
import type { TextReviewDiagnostic } from "./generated/review.responses";

const key = (unit: string, locale: string, offset: number) => ["review-findings", unit, locale, offset, 20] as const;

/** Current evidence stays in Query; mutation/recovery and reason edits stay in
 * the original Review owner, including when this panel is unmounted. */
export function ReviewFindings({ project, target, active, available, currentTarget, freshReadProof, onOpenTranslation, onLocateDiagnostic }: {
  project: ProjectView; target: ReviewTarget; active: boolean; available: () => { enabled: boolean };
  currentTarget: () => ReviewTarget | null; freshReadProof: () => () => boolean;
  onOpenTranslation: (target: EditorTarget, locale: string) => boolean | Promise<boolean>;
  onLocateDiagnostic?: (target: ReviewTarget, runId: string, diagnostic: TextReviewDiagnostic) => boolean | Promise<boolean>;
}) {
  const { t } = useTranslation();
  const owner = useReviewDraftSession(), reads = useSessionReads(), commands = useWorkbenchCommands();
  const alive = useSessionAlive();
  const activity = useRef({ active, unitId: target.unitId, locale: target.locale, basis: target.basis });
  useLayoutEffect(() => { activity.current = { active, unitId: target.unitId, locale: target.locale, basis: target.basis }; });
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [cursor, setCursor] = useState({ unitId: target.unitId, locale: target.locale, offset: 0 });
  const offset = cursor.unitId === target.unitId && cursor.locale === target.locale ? cursor.offset : 0;
  const query = useSessionQuery({ key: key(target.unitId, target.locale, offset), scopes: ["source", "translation", "resources", "review"],
    enabled: active, read: () => reviewCommands.findings({ ...executionContext(project), unitId: target.unitId, locale: target.locale, offset, limit: 20 }) });
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  const observedCompletion = useRef(owner.state.completionVersion);
  useEffect(() => {
    if (observedCompletion.current === owner.state.completionVersion) return;
    observedCompletion.current = owner.state.completionVersion;
    // A mutation must not leave a stale first page cached while a later page is
    // visible. Its next observer fetches current facts before enabling writes.
    void reads.client.invalidateQueries({ queryKey: reads.key(["review-findings", target.unitId, target.locale]) });
    setCursor({ unitId: target.unitId, locale: target.locale, offset: 0 });
  }, [owner.state.completionVersion, target.unitId, target.locale, reads]);
  function currentView() {
    const current = currentTarget();
    const cached = reads.client.getQueryCache().find({ queryKey: reads.key(key(target.unitId, target.locale, offset)), exact: true });
    const value = cached?.state.data as ReviewFindingView | undefined;
    return active && current && !reads.retired && cached?.state.status === "success"
      && cached.state.fetchStatus === "idle" && !cached.state.error && !cached.state.isInvalidated
      && value?.unitId === target.unitId && value.locale === target.locale && value.basis === target.basis
      && current.basis === target.basis && value.runId === (current.currentCheck?.runId ?? null) ? value : null;
  }
  function availability(payload: ReviewFindingCommandPayload | undefined, disposition: ReviewFindingDisposition) {
    if (!active) return { enabled: false, reason: "hidden" as const };
    if (owner.inFlight() || owner.current().busyMutation) return { enabled: false, reason: "busy" as const };
    if (owner.current().pending) return { enabled: false, reason: "pending-action" as const };
    if (!available().enabled) return { enabled: false, reason: "unavailable" as const };
    const view = currentView(), current = owner.current();
    const finding = view?.findings.find(value => value.finding.issueId === payload?.issueId);
    const prior = finding?.decision;
    const validTransition = disposition === "restored" ? prior?.request.disposition === "rejected"
      : prior?.request.disposition !== "rejected" && (disposition !== "repair-requested" || prior?.request.disposition !== "repair-requested");
    return payload && view && finding && validTransition && current.actor.trim() && (current.drafts[reviewDraftKey(target)] ?? "").trim()
      && payload.unitId === target.unitId && payload.locale === target.locale && payload.basis === target.basis && payload.runId === view.runId
      && payload.expectedDecisionId === (prior?.decisionId ?? null) ? { enabled: true } : { enabled: false, reason: "unavailable" as const };
  }
  async function act(payload: ReviewFindingCommandPayload, disposition: ReviewFindingDisposition) {
    if (!availability(payload, disposition).enabled) return;
    const view = currentView(), parentProof = freshReadProof();
    const cached = reads.client.getQueryCache().find({ queryKey: reads.key(key(target.unitId, target.locale, offset)), exact: true });
    const version = cached?.state.dataUpdateCount;
    const before = owner.current(), seq = before.editSeq[reviewDraftKey(target)] ?? 0;
    const evidence = view?.findings.find(item => item.finding.issueId === payload.issueId);
    if (!evidence) return;
    const receipt = await owner.finding({ runId: payload.runId, issueId: payload.issueId, expectedDecisionId: payload.expectedDecisionId, disposition, evidence },
      () => parentProof() && currentView() === view && cached?.state.dataUpdateCount === version);
    if (receipt && disposition === "repair-requested" && alive.current && !reads.retired && activity.current.active
      && activity.current.unitId === target.unitId && activity.current.locale === target.locale && activity.current.basis === target.basis
      && owner.current().selected?.unitId === target.unitId && owner.current().selected?.locale === target.locale && owner.current().selected?.basis === target.basis
      && (owner.current().editSeq[reviewDraftKey(target)] ?? 0) === seq + 1 && !owner.current().drafts[reviewDraftKey(target)]) {
      // The durable request remains awaiting a real recheck even if navigation
      // is declined by the manual editor's existing draft protection.
      const run = view?.runId === target.currentCheck?.runId ? target.currentCheck : null;
      const rule = run?.rules.find(rule => ruleIdentity(rule.key) === ruleIdentity(evidence.requirement.key));
      const locations = run && rule ? reviewDiagnostics(run, rule, evidence.finding.code).filter(diagnostic => diagnostic.location) : [];
      const diagnostic = locations.length === 1 ? locations[0] : null;
      const opened = diagnostic && run && onLocateDiagnostic
        ? await onLocateDiagnostic(target, run.runId, diagnostic)
        : await onOpenTranslation({ unitId: target.unitId, sourceRevisionId: target.sourceRevisionId, key: target.nativeKey, sourceText: target.sourceText }, target.locale);
      if (!opened) {
        owner.setNotice("error"); owner.setReason("editor-unavailable");
      }
    }
  }
  useLayoutEffect(() => {
    const reject = commands.register({ id: "review.reject-finding", nameKey: "review.advisoryFindings.reject", category: "review", scope,
      binding: null, risk: "writes-review", confirmation: "none", payloadKind: "review-finding",
      availability: payload => availability(payload, "rejected"), handler: payload => { void act(payload, "rejected"); } });
    const restore = commands.register({ id: "review.restore-finding", nameKey: "review.advisoryFindings.restore", category: "review", scope,
      binding: null, risk: "writes-review", confirmation: "none", payloadKind: "review-finding",
      availability: payload => availability(payload, "restored"), handler: payload => { void act(payload, "restored"); } });
    const repair = commands.register({ id: "review.repair-finding", nameKey: "review.advisoryFindings.repair", category: "review", scope,
      binding: null, risk: "writes-review", confirmation: "none", payloadKind: "review-finding",
      availability: payload => availability(payload, "repair-requested"), handler: payload => { void act(payload, "repair-requested"); } });
    return () => { repair(); restore(); reject(); };
  });
  const value = !query.error && !query.isFetching && !query.isStale && query.data?.basis === target.basis ? query.data : null;
  const checkedRun = currentTarget()?.currentCheck;
  const diagnosticRun = checkedRun && checkedRun.runId === value?.runId ? checkedRun : null;
  function evidenceDetails(requirement: ReviewFindingDecision["requirement"], runId: string, sourceRevisionId: string) {
    const implementation = requirement.key.implementation;
    return <details><summary>{t("review.advisoryFindings.basis")}</summary><dl>
      <dt>{t("review.advisoryFindings.rule")}</dt><dd>{requirement.key.rule.id}</dd>
      <dt>{t("review.advisoryFindings.provider")}</dt><dd>{implementation.kind === "plugin" ? `${implementation.provider.plugin.publisher}/${implementation.provider.plugin.id} ${implementation.provider.plugin.version}` : implementation.validator.id}</dd>
      <dt>{t("review.advisoryFindings.run")}</dt><dd>{runId}</dd>
      <dt>{t("review.advisoryFindings.input")}</dt><dd>{requirement.inputDigest}</dd>
      <dt>{t("review.advisoryFindings.scope")}</dt><dd>{requirement.scopeDigest}</dd>
      <dt>{t("review.advisoryFindings.source")}</dt><dd>{sourceRevisionId}</dd>
    </dl></details>;
  }
  function historyDetails(decision: ReviewFindingDecision) { return evidenceDetails(decision.requirement, decision.request.runId, decision.basisEvidence.sourceRevisionId); }
  const findingRunId = value?.runId;
  return <section aria-label={t("review.advisoryFindings.title")}>
    <h4>{t("review.advisoryFindings.title")}</h4><p>{t("review.advisoryFindings.help")}</p>
    {query.isFetching ? <p role="status">{t("review.currentLoading")}</p> : null}
    {query.error ? <div role="alert">{t("review.advisoryFindings.unavailable")}<CommandFailureDetails failure={commandFailure(query.error)} /></div> : null}
    <button className="secondary-button" disabled={!active || query.isFetching || owner.inFlight()} onClick={() => void query.refetch()}>{t("review.advisoryFindings.refresh")}</button>
    {value?.findings.length === 0 ? <p>{t("review.advisoryFindings.empty")}</p> : null}
    {findingRunId ? value?.findings.map(item => {
      const payload: ReviewFindingCommandPayload = { kind: "review-finding", unitId: target.unitId, locale: target.locale, basis: value.basis,
        runId: findingRunId, issueId: item.finding.issueId, expectedDecisionId: item.decision?.decisionId ?? null };
      const rule = diagnosticRun?.rules.find(rule => ruleIdentity(rule.key) === ruleIdentity(item.requirement.key));
      const rejected = item.decision?.request.disposition === "rejected";
      return <article key={item.finding.issueId}><p><strong>{item.requirement.key.rule.id}</strong>: {item.finding.detail}</p>
        {evidenceDetails(item.requirement, findingRunId, target.sourceRevisionId)}
        {item.decision && item.decision.request.runId !== findingRunId ? <p>{t("review.advisoryFindings.associated")}</p> : null}
        {diagnosticRun && rule ? <ReviewDiagnosticDetails run={diagnosticRun} rule={rule} code={item.finding.code}
          onLocate={onLocateDiagnostic && currentView() && currentDiagnosticRun(target, diagnosticRun)
            ? diagnostic => { void onLocateDiagnostic(target, diagnosticRun.runId, diagnostic); } : undefined} /> : null}
        {item.decision ? <><p>{t(item.decision.request.disposition === "rejected" ? "review.advisoryFindings.rejected" : item.decision.request.disposition === "restored" ? "review.advisoryFindings.restored" : "review.advisoryFindings.awaiting")}</p>
          <p>{item.decision.request.actor}: {item.decision.request.reason}</p>{historyDetails(item.decision)}</> : null}
        <div className="form-actions"><button className="secondary-button" disabled={!availability(payload, rejected ? "restored" : "rejected").enabled}
          onClick={() => commands.dispatch(rejected ? "review.restore-finding" : "review.reject-finding", scope, payload)}>{t(rejected ? "review.advisoryFindings.restore" : "review.advisoryFindings.reject")}</button>
          <button className="secondary-button" disabled={!availability(payload, "repair-requested").enabled} onClick={() => commands.dispatch("review.repair-finding", scope, payload)}>{t("review.advisoryFindings.repair")}</button></div>
      </article>;
    }) : null}
    {value?.repairs.map(repair => <article key={repair.decision.decisionId}><p>{repair.decision.finding.detail}</p>
      <p>{t(repair.status === "awaiting-current-recheck" ? "review.advisoryFindings.awaiting" : repair.status === "current-rule-clear" ? "review.advisoryFindings.recheckClear" : repair.status === "superseded" ? "review.advisoryFindings.superseded" : "review.advisoryFindings.recheckFindings")}</p>
      <p>{repair.decision.request.actor}: {repair.decision.request.reason}</p>{historyDetails(repair.decision)}</article>)}
    <details><summary>{t("review.advisoryFindings.history")}</summary>
      {value?.history.length === 0 ? <p>{t("review.advisoryFindings.historyEmpty")}</p> : null}
      {value?.history.map(decision => <article key={decision.decisionId}><p>{decision.createdAt} · {decision.request.actor} · {t(decision.request.disposition === "rejected" ? "review.advisoryFindings.rejected" : decision.request.disposition === "restored" ? "review.advisoryFindings.restored" : "review.advisoryFindings.repairRecorded")}</p>
        <p>{decision.finding.detail}</p><p>{decision.request.reason}</p>{historyDetails(decision)}</article>)}
      <button className="secondary-button" disabled={!active || query.isFetching || offset === 0} onClick={() => setCursor({ unitId: target.unitId, locale: target.locale, offset: 0 })}>{t("review.advisoryFindings.previousPage")}</button>
      <button className="secondary-button" disabled={!active || query.isFetching || value?.nextOffset == null} onClick={() => { if (value?.nextOffset != null) setCursor({ unitId: target.unitId, locale: target.locale, offset: value.nextOffset }); }}>{t("review.advisoryFindings.moreHistory")}</button>
    </details>
  </section>;
}
