import { Disclosure } from "../../../design-system/Disclosure";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AiPreviewItems } from "../../../AiPreviewItems";
import { connectionConfigCurrent, connectionReadKey, connectionReadOptions, pluginInventoryReadKey, useConnectionFacts } from "../../../ApplicationReadProvider";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import { PreparationBudgetSummary } from "../../../ModelConnectionPicker";
import { jsonIdentity } from "../../../pluginToolChoices";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { TeamDiscussionDisclosure } from "../../../TeamDiscussionDisclosure";
import { TeamExecutionDisclosure } from "../../../TeamExecutionDisclosure";
import { ToolGuidanceSharing } from "../../../ToolGuidanceSharing";
import { useWorkPlanExecutionReview, WorkPlanExecutionReview } from "../../../WorkPlanExecutionReview";
import { useWorkPlanApplicationTools, WorkPlanApplicationToolObservation } from "../../../workPlanApplicationTools";
import { workPlanCommands, type WorkPlanCommand, type WorkPlanStatusView } from "../../../workPlanCommands";
import { Button } from "../../../design-system/Button";
import { Field, TextInput } from "../../../design-system/Field";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ConversationInput, ConversationSession } from "./ConversationSession";
import { runMatchesLink, type ConversationPlanLink } from "./conversationRun";
import { emptyExecutionConsent, workPlanMinutesValid } from "./proposalWorkPlan";
import { ConversationRunRevocations } from "./ConversationRunRevocations";
import { ConversationRunProgress } from "./ConversationRunProgress";
import { ConversationRunHistory } from "./ConversationRunHistory";
import { ConversationTeamActions } from "./ConversationTeamActions";
import { ConversationTeamRecovery } from "./ConversationTeamRecovery";
import type { OpenConversationRunCandidate } from "./conversationRunResultReads";
import type { OpenConversationTeamCandidate } from "./conversationTeamReads";
import type { ConversationTeamQuestionTarget } from "./conversationNavigation";
import { ConversationTeamQuestions } from "./ConversationTeamQuestions";
import styles from "./ConversationRunPanel.module.css";

interface Props {
  owner: ConversationSession; input: ConversationInput; link: ConversationPlanLink;
  visible: boolean; disabled: boolean; gate: InteractionGate; viewId: string | null; parentDialogId?: string; onOpenCandidate?: OpenConversationRunCandidate; onOpenTeamCandidate?: OpenConversationTeamCandidate;
  questionTarget?: ConversationTeamQuestionTarget | null;
  expandedPlans?: readonly string[]; onExpandedPlan?: (planId: string, open: boolean) => void;
}

const stateKeys = { active: "runStateActive", paused: "runStatePaused", stopped: "runStateStopped", "taken-over": "runStateTakenOver" } as const;
const effectKeys = {
  "save-candidate": "runEffectSaveCandidate", "run-checks": "runEffectChecks", "select-missing": "runEffectSelectMissing",
  "replace-captured-selection": "runEffectReplaceSelection", "adopt-resources": "runEffectAdoptResources", deliver: "runEffectDeliver",
  "query-tools": "runEffectQueryTools", "publish-discussion": "runEffectPublishDiscussion", "dispatch-team-work": "runEffectTeamWork", "send-team-message": "runEffectTeamMessage",
} as const;

function RunPlanDetails({ status }: { status: WorkPlanStatusView }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" }), { t: global } = useTranslation();
  const plan = status.plan, preview = plan.preview, mcp = plan.options.mcpTermQuery?.preview;
  return <div className={styles.material}>
    <p>{t("runScope", { count: plan.scope.length, locale: plan.locale })}</p>
    <ul>{plan.scope.map(unit => <li key={unit.unitId}>{unit.nativeKey}</li>)}</ul>
    {plan.options.stages.map(choice => <p key={choice.stage}>{t("runStage", { stage: global(`ai.plan.stages.${choice.stage}`), mode: global(`ai.plan.modes.${choice.mode}`) })}</p>)}
    <p>{global(`ai.plan.policies.${plan.options.selectionPolicy}`)}</p>
    <section aria-label={t("runEffects")}><h5>{t("runEffects")}</h5><ul>{status.effects.map(effect => <li key={effect}>{t(effectKeys[effect])}</li>)}</ul></section>
    {preview ? <>
      {!plan.options.teamExecution ? <p>{t("runDestination", { endpoint: preview.config.endpoint, model: preview.config.model })}</p> : null}
      <PreparationBudgetSummary config={preview.config} policy={plan.options.teamDiscussions} team={!!plan.options.teamExecution}/>
      <p>{t("runCumulativeBudget")}</p>
      {plan.options.teamExecution ? <TeamExecutionDisclosure plan={plan}/> : <><AiPreviewItems items={preview.items}/><TeamDiscussionDisclosure plan={plan}/><ToolGuidanceSharing plan={plan} config={preview.config}/></>}
    </> : <p>{t("runNoModelMaterial")}</p>}
    {mcp ? <section aria-label={global("ai.mcpTermQuery.confirmation")}>
      <h5>{global("ai.mcpTermQuery.title")}</h5><p>{global("ai.mcpTermQuery.confirmation")}</p>
      <p>{global("ai.mcpTermQuery.scope", { entry: plan.scope.find(unit => unit.unitId === mcp.basis.unitId)?.nativeKey ?? "", locale: mcp.basis.locale })}</p>
      <p>{mcp.request.tool.endpoint} · {mcp.request.tool.toolName}</p><pre>{mcp.arguments.query}</pre>
      <p>{global("ai.mcpTermQuery.limits", { sdk: plan.tools?.maxInvocations ?? 0, total: (plan.tools?.maxInvocations ?? 0) + 1 })}</p>
    </section> : null}
    {plan.options.toolGuidance ? <p>{global("ai.toolGuidanceSharing.confirmation")}</p> : null}
  </div>;
}

/** The local expansion owns observation only; closing it never cancels execution. */
export function ConversationRunPanel(props: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const [opened, setExpanded] = useState(false), [closedTarget, setClosedTarget] = useState<ConversationTeamQuestionTarget | null>(null), id = useId();
  const questionTarget = props.questionTarget?.planId === props.link.planId && props.questionTarget.conversationId === props.link.conversationId ? props.questionTarget : null;
  const expanded = (props.expandedPlans ? props.expandedPlans.includes(props.link.planId) : opened) || questionTarget !== null && questionTarget !== closedTarget;
  const body = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null);
  const canToggle = () => props.visible && !props.owner.getSnapshot().retired
    && props.gate.canDispatch({ viewId: props.viewId, source: "button", dialogId: props.parentDialogId });
  return <section className={styles.panel} hidden={!props.visible} aria-label={t("runTitle")}>
    <div><Button ref={toggle} size="sm" aria-expanded={expanded} aria-controls={id} disabled={!expanded && props.disabled} onClick={() => {
      if (!canToggle()) return;
      if (expanded && body.current?.contains(document.activeElement)) toggle.current?.focus();
      if (props.onExpandedPlan) props.onExpandedPlan(props.link.planId, !expanded); else setExpanded(!expanded); if (expanded) setClosedTarget(questionTarget);
    }}>{t(expanded ? "runHide" : "runShow")}</Button></div>
    <div id={id} ref={body} hidden={!expanded}>
      {expanded && props.visible ? <RunObservation {...props}/> : null}
    </div>
  </section>;
}

function RunObservation({ owner, input, link, visible, disabled, gate, viewId, parentDialogId, onOpenCandidate, onOpenTeamCandidate, questionTarget }: Props) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "conversation" });
  const reads = useSessionReads(), facts = useConnectionFacts(), id = useId(), inputOwner = `conversation-run-${id}`;
  const statusRegion = useRef<HTMLDivElement>(null);
  const live = useRef({ mounted: true, visible, disabled });
  const changeEpoch = useRef(0);
  useLayoutEffect(() => { live.current = { mounted: true, visible, disabled }; return () => { live.current.mounted = false; }; }, [visible, disabled]);
  useEffect(() => () => gate.releaseOwner(inputOwner), [gate, inputOwner]);
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(scope => ["project", "source", "translation", "resources", "review"].includes(scope))) changeEpoch.current++;
  }), [reads]);
  useEffect(() => facts.client.getQueryCache().subscribe(event => {
    if ((event.type === "updated" || event.type === "removed") && [jsonIdentity(connectionReadKey), jsonIdentity(pluginInventoryReadKey)].includes(jsonIdentity(event.query.queryKey))) changeEpoch.current++;
  }), [facts.client]);
  const statusKey = ["workPlan", link.planId] as const;
  const read = useSessionQuery({ key: statusKey, scopes: ["project", "execution", "source", "translation", "resources", "review"], enabled: visible,
    read: () => workPlanCommands.status({ ...owner.context, planId: link.planId }) });
  const status = !read.error && read.data && runMatchesLink(read.data, link) ? read.data : null;
  const plan = status?.plan ?? null;
  const configs = plan ? [...(plan.preview ? [plan.preview.config] : []), ...(plan.options.teamExecution?.members.map(member => member.config) ?? [])] : [];
  const needsConnections = configs.some(config => config.connectionProfile != null);
  const connectionRead = useQuery({ ...connectionReadOptions(), enabled: visible && needsConnections }, facts.client);
  const connectionCurrent = configs.every(config => connectionConfigCurrent(facts.current(), config));
  const applications = useWorkPlanApplicationTools(plan?.tools?.entries ?? [], visible && !!plan);
  const [continueOpen, setContinueOpen] = useState(false), [deadlineTick, setDeadlineTick] = useState(0);
  const canRead = () => live.current.mounted && live.current.visible && !live.current.disabled && !reads.retired
    && !owner.getSnapshot().retired && owner.getSnapshot().activeId === link.conversationId
    && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const blocked = disabled || input.journalBusy || !!input.busy || !!input.value.pending || !!input.failure || !!input.workPlan.busy || !!input.planning.busy;
  const allowed = () => !blocked && canRead();
  function statusCurrent(expected: WorkPlanStatusView) {
    const record = reads.client.getQueryState<WorkPlanStatusView>(reads.key(statusKey));
    return record?.status === "success" && record.fetchStatus === "idle" && !record.isInvalidated && record.error === null && record.data === expected;
  }
  function capture(executing: boolean) {
    const witness = reads.watchExactQuery(statusKey), original = witness.current(), version = original?.state.dataUpdateCount;
    const expected = status, epoch = changeEpoch.current, connection = facts.client.getQueryState(connectionReadKey);
    const appKey = ["work-plan-tool-applications", applications.groups.map(group => group.basis)] as const;
    const appWitness = applications.groups.length ? reads.watchExactQuery(appKey) : null;
    const originalApp = appWitness?.current(), appVersion = originalApp?.state.dataUpdateCount;
    return {
      current: () => {
        const query = witness.current(), app = appWitness?.current();
        return canRead() && !!expected && statusCurrent(expected) && query === original && query?.state.dataUpdateCount === version
          && (!executing || changeEpoch.current === epoch && connectionCurrent && configs.every(config => connectionConfigCurrent(facts.current(), config))
            && (!needsConnections || facts.client.getQueryState(connectionReadKey) === connection)
            && applications.current() && (!appWitness || app === originalApp && app?.state.dataUpdateCount === appVersion));
      },
      dispose: () => { witness.dispose(); appWitness?.dispose(); },
    };
  }
  function finishAction(origin: HTMLElement) {
    if (live.current.mounted && live.current.visible && (document.activeElement === origin || document.activeElement === document.body)) statusRegion.current?.focus();
  }
  async function control(command: Exclude<WorkPlanCommand, "continue">, origin: HTMLElement) {
    if (!status || !canRead() || !owner.canRevokeRun(link.conversationId, status, command) || !statusCurrent(status)) return;
    const proof = capture(false);
    try { await owner.controlRun(link, status, command, null, proof.current); } finally { proof.dispose(); finishAction(origin); }
  }
  async function start(origin: HTMLElement) {
    if (!status || !allowed() || !owner.canStartRun(link.conversationId, status) || !connectionCurrent || !applications.current()) return;
    const proof = capture(true);
    try { await owner.startRun(link, status, proof.current); } finally { proof.dispose(); finishAction(origin); }
  }
  useEffect(() => {
    if (!status || status.state !== "active") return;
    const remaining = BigInt(status.expiresAt) * 1000n - BigInt(Date.now()) + 1n;
    if (remaining <= 0n) return;
    const timer = window.setTimeout(() => setDeadlineTick(value => value + 1), Number(remaining > 2147483647n ? 2147483647n : remaining));
    return () => window.clearTimeout(timer);
  }, [status?.state, status?.expiresAt, deadlineTick]);
  const fresh = !!status && statusCurrent(status), runBusy = input.runBusy?.planId === link.planId ? input.runBusy : null;
  const mayContinue = status?.state === "paused" || status?.state === "taken-over";
  const genericContinue = mayContinue && !plan?.options.teamExecution && !plan?.options.mcpTermQuery;
  const canStart = !!status && owner.canStartRun(link.conversationId, status);
  const expired = !!status && BigInt(status.expiresAt) <= BigInt(Math.floor(Date.now() / 1000));
  const expiry = status ? new Date(Number(status.expiresAt) * 1000) : null;
  return <div ref={statusRegion} tabIndex={-1} className={styles.observation} onFocusCapture={() => gate.setInputOwner(viewId, inputOwner)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputOwner); }}
    onClickCapture={event => { if (!canRead()) { event.preventDefault(); event.stopPropagation(); } }}
    onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
    <p>{t("runReadHelp")}</p>
    {read.isPending ? <LoadingState label={t("runLoading")}/> : null}
    {read.isError ? <Banner tone="error"><p>{t("runReadFailed")}</p><CommandFailureDetails failure={commandFailure(read.error)}/></Banner> : null}
    {read.data && !runMatchesLink(read.data, link) ? <Banner tone="error">{t("runMismatch")}</Banner> : null}
    <div className={styles.actions}><Button size="sm" pending={read.isFetching} disabled={!canRead()} onClick={() => { if (canRead()) reads.invalidate(["execution"]); }}>{t("runRefresh")}</Button></div>
    {status ? <>
      <h5>{t(stateKeys[status.state])}</h5><p>{t("runStatusHelp")}</p>
      <p>{expiry && Number.isFinite(expiry.getTime()) ? t("runExpiry", { date: new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "short" }).format(expiry) }) : t("runExpiryUnknown")}</p>
      {expired && status.state !== "stopped" ? <p role="status">{t("runExpired")}</p> : null}
      {status.toolInvocations ? <p>{t("runToolUsage", { reserved: status.toolInvocations.reserved, limit: status.toolInvocations.limit })}</p> : null}
      <Disclosure title={<>{t("runFixedDetails")}</>}><RunPlanDetails status={status}/></Disclosure>
      {input.value.pending || input.failure ? <Banner tone="warning">{t("runPending")}</Banner> : null}
      {input.runFailure?.planId === link.planId ? <Banner tone="error"><p>{t("runActionFailed")}</p><CommandFailureDetails failure={input.runFailure.cause}/></Banner> : null}
      {runBusy ? <p role="status">{t(runBusy.kind === "check" ? "runChecking" : "runSending")}</p> : null}
      {!fresh ? <p role="status">{t("runStale")}</p> : null}
      {!connectionCurrent && needsConnections ? <Banner tone="warning"><p>{t("runConnectionChanged")}</p>
        {connectionRead.isFetching ? <p role="status">{t("runConnectionLoading")}</p> : null}
        {connectionRead.error ? <CommandFailureDetails failure={commandFailure(connectionRead.error)}/> : null}
        <Button size="sm" pending={connectionRead.isFetching} disabled={!canRead()} onClick={() => { if (canRead()) void connectionRead.refetch(); }}>{t("runReadConnection")}</Button></Banner> : null}
      {status.state === "active" ? <>
        {!canStart ? <p>{t("runNeedsConfirmation")}</p> : <p>{t("runReady")}</p>}
        <div className={styles.actions}><Button variant="primary" size="sm" disabled={blocked || !fresh || !canStart || !connectionCurrent || !applications.current()} onClick={event => void start(event.currentTarget)}>{t("runStart")}</Button></div>
        {canStart && applications.groups.length ? <WorkPlanApplicationToolObservation observation={applications.observation}/> : null}
      </> : null}
      {status.state !== "stopped" ? <>
        <div className={styles.actions}>
          {status.state === "active" ? <Button size="sm" disabled={!fresh || !owner.canRevokeRun(link.conversationId, status, "pause")} onClick={event => void control("pause", event.currentTarget)}>{t("runPause")}</Button> : null}
          {status.state !== "taken-over" ? <Button size="sm" disabled={!fresh || !owner.canRevokeRun(link.conversationId, status, "take-over")} onClick={event => void control("take-over", event.currentTarget)}>{t("runTakeOver")}</Button> : null}
          <Button variant="danger" size="sm" disabled={!fresh || !owner.canRevokeRun(link.conversationId, status, "stop")} onClick={event => void control("stop", event.currentTarget)}>{t("runStop")}</Button>
        </div><p>{t("runControlHelp")}</p>
      </> : <p>{t("runStoppedHelp")}</p>}
      {plan?.options.teamExecution ? <ConversationTeamRecovery owner={owner} input={input} link={link} status={status} visible={visible}
        disabled={disabled} current={() => canRead() && statusCurrent(status)} gate={gate} viewId={viewId} parentDialogId={parentDialogId}/> : null}
      {plan?.options.teamQuestions ? <ConversationTeamQuestions owner={owner} input={input} link={link} status={status} visible={visible} disabled={disabled}
        current={() => canRead() && statusCurrent(status)} gate={gate} viewId={viewId} parentDialogId={parentDialogId}
        target={questionTarget?.planId === link.planId && questionTarget.conversationId === link.conversationId ? questionTarget : null}/> : null}
      {mayContinue && plan?.options.mcpTermQuery ? <Banner tone="info">{t("runMcpRecovery")}</Banner> : null}
      {genericContinue ? <>
        <div><Button size="sm" aria-expanded={continueOpen} aria-controls={`${id}-continue`} disabled={!continueOpen && (blocked || !fresh)} onClick={() => {
          if (canRead()) setContinueOpen(value => !value);
        }}>{t(continueOpen ? "runCloseContinue" : "runReviewContinue")}</Button></div>
        {continueOpen ? <ContinueRun key={jsonIdentity([status.plan.planId, status.plan.digest, status.plan, status.lease, status.state, status.expiresAt, status.effects])}
          id={`${id}-continue`} owner={owner} status={status} link={link} disabled={blocked || !fresh} canRead={canRead}
          connectionCurrent={connectionCurrent} capture={() => capture(true)} onFinished={finishAction}/>: null}
      </> : null}
    </> : null}
    <ConversationRunRevocations owner={owner} input={input} link={link} canRead={canRead} onFinished={finishAction}/>
    <ConversationRunHistory context={owner.context} link={link} status={status} visible={visible} canRead={canRead}
      onOpenCandidate={onOpenCandidate} onOpenTeamCandidate={onOpenTeamCandidate}/>
    <ConversationRunProgress onOpenCandidate={onOpenCandidate} onOpenTeamCandidate={onOpenTeamCandidate} context={owner.context} link={link} status={status} visible={visible} canRead={canRead}
      teamActions={status ? (view, current) => <ConversationTeamActions owner={owner} input={input} link={link} status={status} view={view} current={() => canRead() && statusCurrent(status) && current()}
        visible={visible} disabled={disabled} gate={gate} viewId={viewId} refresh={() => { if (canRead()) reads.invalidate(["execution"]); }}/> : undefined}
      onTeamReply={post => {
        if (status && canRead() && statusCurrent(status) && post.planId === link.planId)
          owner.editTeamPublication(link, { unitId: post.publication.target.unitId, replyTo: post.publication.postId });
      }}/>
  </div>;
}

function ContinueRun({ id, owner, status, link, disabled, canRead, connectionCurrent, capture, onFinished }: {
  id: string; owner: ConversationSession; status: WorkPlanStatusView; link: ConversationPlanLink; disabled: boolean;
  canRead: () => boolean; connectionCurrent: boolean; capture: () => { current: () => boolean; dispose: () => void };
  onFinished: (origin: HTMLElement) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const reads = useSessionReads(), facts = useConnectionFacts();
  const [executionConsent, setExecutionConsent] = useState(emptyExecutionConsent), [minutes, setMinutes] = useState(60), [consent, setConsent] = useState(false);
  const sequence = useRef(0), mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const allowed = () => mounted.current && !disabled && canRead();
  const clear = () => { sequence.current++; setConsent(false); setExecutionConsent(before => before.checkers.length || before.tools || before.applications.length ? emptyExecutionConsent() : before); };
  const review = useWorkPlanExecutionReview({ context: owner.context, plan: status.plan, generation: status.lease.generation, open: true, value: executionConsent,
    onChange: change => { if (allowed()) { sequence.current++; setConsent(false); setExecutionConsent(change); } } });
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(scope => ["project", "source", "translation", "resources", "review"].includes(scope))) clear();
  }), [reads]);
  useEffect(() => facts.client.getQueryCache().subscribe(event => {
    if ((event.type === "updated" || event.type === "removed") && [jsonIdentity(connectionReadKey), jsonIdentity(pluginInventoryReadKey)].includes(jsonIdentity(event.query.queryKey))) clear();
  }), [facts.client]);
  useEffect(() => reads.client.getQueryCache().subscribe(event => {
    if (event.type !== "updated" && event.type !== "removed") return;
    const key = event.query.queryKey[2];
    if (key === "tool-query-inventory" || key === "tool-query-environment" || key === "work-plan-tool-applications") clear();
    else if (key === "workPlan" && event.query.queryKey[3] === status.plan.planId
      && (event.type === "removed" || event.query.state.isInvalidated || event.query.state.fetchStatus !== "idle" || event.query.state.error !== null)) clear();
  }), [reads, status.plan.planId]);
  async function confirm(origin: HTMLElement) {
    if (!allowed() || !consent || !connectionCurrent || !review.current() || !workPlanMinutesValid(minutes)) return;
    const proof = capture(), version = sequence.current;
    try { await owner.controlRun(link, status, "continue", { confirmed: true, minutes, checkerExecutions: review.checkerExecutions(),
      toolExecution: review.toolExecution, applicationToolExecutions: review.applicationToolExecutions() },
    () => mounted.current && sequence.current === version && canRead() && proof.current() && review.current());
    } finally { proof.dispose(); if (mounted.current) clear(); onFinished(origin); }
  }
  return <section id={id} className={styles.continuation} aria-label={t("runContinueTitle")}>
    <h5>{t("runContinueTitle")}</h5><p>{t("runContinueHelp")}</p><RunPlanDetails status={status}/>
    {!connectionCurrent ? <Banner tone="warning">{t("runConnectionChanged")}</Banner> : null}
    <fieldset disabled={disabled}><legend>{t("runExecutionConsent")}</legend>
      <WorkPlanExecutionReview review={review} disabled={disabled} consentDisabled={!connectionCurrent} showConsent/>
      <Field label={t("runMinutes")} description={t("runMinutesHelp")} error={!workPlanMinutesValid(minutes) ? t("runMinutesInvalid") : undefined}>
        <TextInput type="number" min={1} max={1440} step={1} value={Number.isFinite(minutes) ? minutes : ""} onChange={event => {
          if (allowed()) { sequence.current++; setConsent(false); setMinutes(event.target.valueAsNumber); }
        }}/>
      </Field>
      <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={consent}
        disabled={disabled || !connectionCurrent || !review.confirmed || !workPlanMinutesValid(minutes)} onChange={event => {
          if (allowed() && connectionCurrent && review.current()) { sequence.current++; setConsent(event.target.checked); }
        }}/><span>{t("runConsent")}</span></label>
      <p>{t("runContinueNoStart")}</p>
      <div className={styles.actions}><Button variant="primary" size="sm" disabled={disabled || !consent || !connectionCurrent || !review.confirmed || !workPlanMinutesValid(minutes)}
        onClick={event => void confirm(event.currentTarget)}>{t("runConfirmContinue")}</Button></div>
    </fieldset>
  </section>;
}
