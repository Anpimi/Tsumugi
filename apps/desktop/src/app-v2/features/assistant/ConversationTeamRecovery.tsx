import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AiBudgetInputs, AiConnectionEditor } from "../../../AiConnectionFields";
import { AiProviderBudget } from "../../../AiUsage";
import { connectionAiConfig, editedAiConfig, type AiConfig } from "../../../aiCommands";
import { connectionConfigCurrent, connectionReadKey, pluginInventoryReadKey, useConnectionFacts } from "../../../ApplicationReadProvider";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import { Button } from "../../../design-system/Button";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { Menu } from "../../../design-system/Menu";
import { TeamWorkKindValues } from "../../../generated/ai.enums";
import type { TeamWorkReference } from "../../../generated/ai.responses";
import { ModelConnectionPicker } from "../../../ModelConnectionPicker";
import { jsonIdentity } from "../../../pluginToolChoices";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { SourceContextChoice } from "../../../SourceContextPreparation";
import { TeamRecoveryDisclosure } from "../../../TeamRecoveryDisclosure";
import { teamRecoveryAvailable, teamRecoveryHasCapacity } from "../../../TeamRecoverySession";
import { useWorkPlanExecutionReview, WorkPlanExecutionReview } from "../../../WorkPlanExecutionReview";
import { workPlanCommands, type WorkPlanStatusView } from "../../../workPlanCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ConversationInput, ConversationSession } from "./ConversationSession";
import type { ConversationPlanLink } from "./conversationRun";
import { readConversationTeamExecution, readConversationTeamHistory } from "./conversationTeamReads";
import { conversationRecoveryProblem, recoveryBasisMatches, type ConversationRecoveryMember } from "./conversationRecovery";
import { emptyExecutionConsent } from "./proposalWorkPlan";
import styles from "./ConversationTeamRecovery.module.css";

export interface ConversationTeamRecoveryProps {
  owner: ConversationSession; input: ConversationInput; link: ConversationPlanLink; status: WorkPlanStatusView;
  visible: boolean; disabled: boolean; current: () => boolean; gate: InteractionGate; viewId: string | null; parentDialogId?: string;
}
const same = (left: unknown, right: unknown) => jsonIdentity(left) === jsonIdentity(right);

/** Observation and local controls only; the conversation owner retains all input and original requests. */
export function ConversationTeamRecovery({ owner, input, link, status, visible, disabled, current, gate, viewId, parentDialogId }: ConversationTeamRecoveryProps) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "conversationTeamRecovery" }), { t: global } = useTranslation();
  const reads = useSessionReads(), facts = useConnectionFacts(), id = useId(), inputOwner = `team-recovery-${id}`;
  const observedApplication = useRef({ connections: facts.client.getQueryData(connectionReadKey), plugins: facts.client.getQueryData(pluginInventoryReadKey) });
  const state = input.recoveryStates?.get(link.planId), saved = input.value.teamDrafts?.find(value => value.planId === link.planId);
  const draft = saved?.planDigest === link.planDigest ? saved.recovery : null, open = state?.open ?? false;
  const frame = jsonIdentity([link, status.lease, status.state, status.plan]);
  const [workCursor, setWorkCursor] = useState<{ frame: string | undefined; value: string | null }>({ frame, value: null });
  const [postCursor, setPostCursor] = useState<{ frame: string | undefined; value: string | null }>({ frame, value: null });
  const afterWork = workCursor.frame === frame ? workCursor.value : null, afterPost = postCursor.frame === frame ? postCursor.value : null;
  const [executionConsent, setExecutionConsent] = useState(emptyExecutionConsent), [tick, setTick] = useState(0);
  const mounted = useRef(true), live = useRef({ visible, disabled, current });
  const toggle = useRef<HTMLButtonElement>(null), body = useRef<HTMLDivElement>(null), feedback = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; gate.releaseOwner(inputOwner); }; }, [gate, inputOwner]);
  useLayoutEffect(() => { live.current = { visible, disabled, current }; });
  useEffect(() => () => { owner.setTeamRecoveryConsent(link, false); }, [owner, link.conversationId, link.planId, link.planDigest]);
  const editable = () => mounted.current && live.current.visible && !live.current.disabled && !owner.getSnapshot().retired
    && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const allowed = () => editable() && live.current.current();
  const readKey = ["team-recovery-state", link.planId] as const;
  const read = useSessionQuery({ key: readKey, scopes: ["execution", "source", "translation", "resources", "review", "project"], enabled: visible && open,
    read: () => workPlanCommands.teamRecoveryState({ ...owner.context, planId: link.planId }) });
  const teamKey = ["conversation-team-recovery-members", link.conversationId, link.planId, frame, afterWork] as const;
  const team = useSessionQuery({ key: teamKey, scopes: ["execution", "source", "translation", "project"], enabled: visible && open,
    structuralSharing: false, read: () => readConversationTeamExecution(owner.context, link, status, afterWork, null) });
  const postsKey = ["conversation-team-recovery-posts", link.conversationId, link.planId, frame, afterPost] as const;
  const posts = useSessionQuery({ key: postsKey, scopes: ["execution", "source", "translation", "project"], enabled: visible && open && !!draft,
    structuralSharing: false, read: () => readConversationTeamHistory(owner.context, link, status, afterPost) });
  const observation = !read.error ? read.data ?? null : null, view = !team.error ? team.data ?? null : null;
  function currentRead<T>(key: readonly unknown[], expected: T) {
    const query = reads.client.getQueryState<T>(reads.key(key));
    return query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null && query.data === expected;
  }
  const fresh = !!observation && !!view && currentRead(readKey, observation) && currentRead(teamKey, view);
  const limits = status.plan.options.teamExecution?.limits;
  const capacity = !!observation && !!limits && teamRecoveryHasCapacity(observation.state, limits);
  const available = !!observation && !!limits && teamRecoveryAvailable(observation, limits) && !!view
    && same(view.effectiveVersion, observation.state.effectiveVersion);
  const prepared = state?.prepared ?? null, preparedSeq = state?.preparedSeq;
  const connectionsCurrent = (prepared?.preview.members ?? draft?.members ?? []).every(member => connectionConfigCurrent(facts.current(), member.config));
  const matchingCapture = !!draft && !!prepared && state?.preparedRequest != null && preparedSeq === draft.editSeq
    && prepared.preparationId === state.preparedRequest.preparationId && !!observation && !!view && recoveryBasisMatches(prepared, observation, view);
  const reviewPlan = prepared && state?.preparedPlan ? { ...state.preparedPlan, digest: prepared.preview.digest, tools: prepared.tools, checkers: prepared.checkers } : null;
  const captureKey = jsonIdentity([prepared?.preparationId, prepared?.preview.digest, preparedSeq, state?.epoch]);
  const clearConsent = () => { setExecutionConsent(emptyExecutionConsent()); owner.setTeamRecoveryConsent(link, false); };
  const review = useWorkPlanExecutionReview({ context: owner.context, plan: reviewPlan, generation: prepared?.preview.baseLease.generation ?? null,
    open: visible && open && !!prepared, value: executionConsent,
    onChange: change => { if (editable()) { setExecutionConsent(change); owner.setTeamRecoveryConsent(link, false); } } });
  useEffect(() => { setExecutionConsent(emptyExecutionConsent()); }, [captureKey]);
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(scope => ["project", "source", "translation", "resources", "review"].includes(scope))) {
      setExecutionConsent(emptyExecutionConsent()); owner.invalidateTeamRecovery(link);
    }
  }), [reads, owner, link.conversationId, link.planId, link.planDigest]);
  useEffect(() => facts.client.getQueryCache().subscribe(event => {
    if ((event.type === "updated" || event.type === "removed") && [jsonIdentity(connectionReadKey), jsonIdentity(pluginInventoryReadKey)].includes(jsonIdentity(event.query.queryKey))) {
      setExecutionConsent(emptyExecutionConsent()); owner.setTeamRecoveryConsent(link, false);
      const key = same(event.query.queryKey, connectionReadKey) ? "connections" : "plugins";
      if (event.type === "removed") { observedApplication.current[key] = undefined; owner.invalidateTeamRecovery(link); }
      else if (event.query.state.status === "success" && event.query.state.fetchStatus === "idle" && !event.query.state.isInvalidated) {
        const changed = !same(observedApplication.current[key], event.query.state.data);
        observedApplication.current[key] = event.query.state.data;
        if (changed) owner.invalidateTeamRecovery(link);
      }
    }
  }), [facts.client, owner, link.conversationId, link.planId, link.planDigest]);
  useEffect(() => reads.client.getQueryCache().subscribe(event => {
    if (event.type !== "updated" && event.type !== "removed") return;
    const key = event.query.queryKey[2];
    if (key === "tool-query-inventory" || key === "tool-query-environment" || key === "work-plan-tool-applications") {
      setExecutionConsent(emptyExecutionConsent()); owner.setTeamRecoveryConsent(link, false);
    }
  }), [reads, owner, link.conversationId, link.planId, link.planDigest]);
  useEffect(() => {
    if (prepared && (facts.current() != null && !connectionsCurrent || draft?.editSeq !== preparedSeq || observation && view && !recoveryBasisMatches(prepared, observation, view)))
      owner.invalidateTeamRecovery(link);
  }, [owner, link.conversationId, link.planId, prepared, preparedSeq, draft?.editSeq, connectionsCurrent, observation, view]);
  useEffect(() => {
    if (!open || !observation) return;
    const remaining = BigInt(observation.state.expiresAtMs) - BigInt(Date.now()) + 1n;
    if (remaining <= 0n) return;
    const timer = window.setTimeout(() => setTick(value => value + 1), Number(remaining > 2147483647n ? 2147483647n : remaining));
    return () => window.clearTimeout(timer);
  }, [open, observation?.state.expiresAtMs, tick]);
  function refresh() { if (editable()) { clearConsent(); reads.invalidate(["execution"]); } }
  function finish(origin: HTMLElement) {
    if (mounted.current && live.current.visible && (document.activeElement === origin || document.activeElement === document.body)) feedback.current?.focus();
  }
  function proof() {
    const recoveryWitness = reads.watchExactQuery(readKey), teamWitness = reads.watchExactQuery(teamKey);
    const recoveryQuery = recoveryWitness.current(), teamQuery = teamWitness.current();
    const recoveryVersion = recoveryQuery?.state.dataUpdateCount, teamVersion = teamQuery?.state.dataUpdateCount;
    return { current: () => allowed() && !!observation && !!view && currentRead(readKey, observation) && currentRead(teamKey, view)
      && recoveryWitness.current() === recoveryQuery && teamWitness.current() === teamQuery
      && recoveryQuery?.state.dataUpdateCount === recoveryVersion && teamQuery?.state.dataUpdateCount === teamVersion,
    dispose: () => { recoveryWitness.dispose(); teamWitness.dispose(); } };
  }
  async function prepare(origin: HTMLElement) {
    if (!draft || !observation || !view || !canPrepare || !allowed()) return;
    const witness = proof();
    try { await owner.prepareTeamRecovery(link, status, view, observation, witness.current); }
    finally { witness.dispose(); finish(origin); }
  }
  async function authorize(origin: HTMLElement) {
    if (!draft || !canAuthorize || !allowed() || !review.current()) return;
    const witness = proof(), sequence = draft.editSeq, epoch = state?.epoch;
    try { await owner.authorizeTeamRecovery(link, status, sequence,
      () => witness.current() && owner.getSnapshot().inputs.get(link.conversationId)?.recoveryStates.get(link.planId)?.epoch === epoch && review.current(),
      { checkerExecutions: review.checkerExecutions(), toolExecution: review.toolExecution, applicationToolExecutions: review.applicationToolExecutions() }); }
    finally { witness.dispose(); setExecutionConsent(emptyExecutionConsent()); finish(origin); }
  }
  const problem = draft && view ? conversationRecoveryProblem(draft, status.plan, view, observation) : null;
  const ownPending = input.value.pending?.kind === "team-recovery" && input.value.pending.request.recovery.planId === link.planId;
  const otherPending = !!input.value.pending && !ownPending;
  const blocked = !!state?.busy || input.journalBusy || !!input.busy || input.failure?.kind === "journal" || otherPending
    || !!input.workPlan.busy || !!input.planning.busy;
  const canPrepare = !!draft && fresh && available && !problem && !blocked && !input.value.pending && connectionsCurrent;
  const canAuthorize = matchingCapture && fresh && available && !blocked && !!state?.consent && connectionsCurrent && review.confirmed;
  const failure = state?.failure ?? (read.error ? commandFailure(read.error) : team.error ? commandFailure(team.error) : posts.error ? commandFailure(posts.error) : null);
  const statusMessage = !observation || !limits ? null : !capacity ? "exhausted" : observation.state.state === "active" ? "pauseFirst"
    : !observation.runtime?.originalDeadlineAvailable || observation.state.state === "stopped" || BigInt(observation.state.expiresAtMs) <= BigInt(Date.now()) ? "unavailable"
    : !observation.runtime.producersDrained || !observation.hostCallbacksDrained ? "draining" : available ? "available" : "stale";
  const deadline = observation ? new Date(Number(observation.state.expiresAtMs)) : null;
  const workReferences = view?.works.map(work => ({ taskId: work.receipt.taskId, attemptId: work.receipt.attemptId, inputDigest: work.receipt.inputDigest })) ?? [];
  const unresolved = observation?.state.unresolvedWork ?? [];
  const selectedElsewhere = draft?.priorWork.filter(reference => ![...workReferences, ...unresolved].some(value => same(value, reference))) ?? [];
  const names = new Map(status.plan.scope.map(unit => [unit.unitId, unit.nativeKey]));
  const toggleReference = (reference: TeamWorkReference, checked: boolean) => {
    if (draft && editable()) owner.editTeamRecovery(link, { priorWork: checked ? [...draft.priorWork.filter(value => !same(value, reference)), reference] : draft.priorWork.filter(value => !same(value, reference)) });
  };
  function referenceChoice(reference: TeamWorkReference, label: string) {
    return <div key={jsonIdentity(reference)} className={styles.reference}><label className={styles.check}><TextInput type="checkbox" className={styles.checkbox}
      disabled={!editable()} checked={draft?.priorWork.some(value => same(value, reference)) ?? false} onChange={event => toggleReference(reference, event.target.checked)}/><span>{label}</span></label>
      <details><summary>{global("ai.team.identityDetails")}</summary><pre>{JSON.stringify(reference, null, 2)}</pre></details></div>;
  }
  return <section className={styles.panel} aria-label={t("title")} hidden={!visible}
    onFocusCapture={() => gate.setInputOwner(viewId, inputOwner)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputOwner); }}
    onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
    <Button ref={toggle} size="sm" aria-expanded={open} aria-controls={id} disabled={!editable()} onClick={() => {
      if (!editable()) return;
      if (open && body.current?.contains(document.activeElement)) toggle.current?.focus();
      if (open) clearConsent();
      owner.setTeamRecoveryOpen(link, !open);
    }}>{t(open ? "hide" : "show")}</Button>
    {!open && draft ? <p role="status">{t("kept")}</p> : null}
    <div id={id} ref={body} hidden={!open} className={styles.body}>
      <h5>{t("title")}</h5><p>{t("help")}</p><p>{t("localHelp")}</p>
      <Button size="sm" pending={read.isFetching || team.isFetching} disabled={!editable()} onClick={refresh}>{t("refresh")}</Button>
      {read.isPending || team.isPending ? <LoadingState label={t("loading")}/> : null}
      <div ref={feedback} tabIndex={-1} className={styles.feedback}>
        {failure ? <Banner tone="error" role="alert"><p>{t("failed")}</p><CommandFailureDetails failure={failure}/></Banner> : null}
        {statusMessage ? <p role="status">{t(statusMessage)}</p> : null}
        {observation ? <><p>{deadline && Number.isFinite(deadline.getTime()) ? global("ai.recovery.deadline", { date: new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "short" }).format(deadline) }) : global("conversation.runExpiryUnknown")}</p>
          <AiProviderBudget budget={observation.state.budget}/></> : null}
        {state?.busy ? <p role="status">{t(state.busy === "prepare" ? "preparing" : state.busy === "authorize" ? "authorizing" : "closing")}</p> : null}
      </div>
      {!draft ? <Button size="sm" disabled={!allowed() || !fresh || !available || blocked || !!input.value.pending} onClick={() => {
        if (allowed() && fresh && available && view) owner.beginTeamRecovery(link, status, view);
      }}>{global("ai.recovery.edit")}</Button> : <>
        <fieldset className={styles.fields}><legend>{t("members")}</legend>
          {draft.members.map((member, index) => <RecoveryMemberFields key={member.key} member={member} number={index + 1} owner={owner} link={link}
            plan={status.plan} editSeq={draft.editSeq} active={visible && open} editable={editable}/>) }
          <Button size="sm" disabled={!editable() || draft.members.length >= 8} onClick={() => { if (editable()) owner.addTeamRecoveryMember(link, status.plan); }}>{global("ai.team.add")}</Button>
        </fieldset>
        <fieldset className={styles.fields}><legend>{t("work")}</legend>
          <Menu label={t("recipient")} trigger={<Button size="sm" disabled={!editable()}>{draft.members.find(member => member.key === draft.recipientKey)?.displayName || t("chooseMember")}</Button>}
            items={draft.members.map(member => ({ id: String(member.key), label: member.displayName || global("ai.team.memberNumber", { number: String(draft.members.indexOf(member) + 1) }),
              onSelect: () => { if (editable()) owner.editTeamRecovery(link, { recipientKey: member.key }); } }))}/>
          <Menu label={t("entry")} trigger={<Button size="sm" disabled={!editable()}>{names.get(draft.unitId ?? "") ?? t("chooseEntry")}</Button>}
            items={status.plan.scope.map(unit => ({ id: unit.unitId, label: unit.nativeKey, onSelect: () => { if (editable()) owner.editTeamRecovery(link, { unitId: unit.unitId }); } }))}/>
          <Menu label={t("kind")} trigger={<Button size="sm" disabled={!editable()}>{global(`ai.team.workKinds.${draft.kind}`)}</Button>}
            items={TeamWorkKindValues.map(kind => ({ id: kind, label: global(`ai.team.workKinds.${kind}`), onSelect: () => { if (editable()) owner.editTeamRecovery(link, { kind }); } }))}/>
          <Field label={t("instructions")} error={problem === "work" ? global("ai.recovery.problems.work") : undefined}><TextArea value={draft.instructions} readOnly={!editable()}
            onChange={event => { if (editable()) owner.editTeamRecovery(link, { instructions: event.target.value }); }}/></Field>
        </fieldset>
        <details className={styles.fields}><summary>{t("attachments")}</summary><p>{t("attachmentHelp")}</p>
          {unresolved.length ? <fieldset className={styles.fields}><legend>{t("unresolved")}</legend><p>{t("unresolvedHelp")}</p>
            {unresolved.map((reference, index) => referenceChoice(reference, t("priorWork", { number: index + 1 })))}</fieldset> : null}
          {view?.works.filter(work => !unresolved.some(reference => reference.attemptId === work.receipt.attemptId)).map(work => referenceChoice(
            { taskId: work.receipt.taskId, attemptId: work.receipt.attemptId, inputDigest: work.receipt.inputDigest }, `${names.get(work.target.unitId) ?? work.target.unitId} · ${work.target.locale} · ${global(`ai.states.${work.execution}`)}`))}
          {!view?.works.length ? <p>{t("noWork")}</p> : null}
          {selectedElsewhere.map((reference, index) => referenceChoice(reference, t("savedWork", { number: index + 1 })))}
          <div className={styles.actions}><Button size="sm" disabled={!editable() || team.isFetching || afterWork === null} onClick={() => { if (editable()) setWorkCursor({ frame, value: null }); }}>{t("firstPage")}</Button>
            <Button size="sm" disabled={!editable() || team.isFetching || !view?.nextWorkAfter} onClick={() => { if (editable()) setWorkCursor({ frame, value: view?.nextWorkAfter ?? null }); }}>{t("nextWork")}</Button></div>
          {posts.data?.posts.filter(post => post.publication.target.unitId === draft.unitId && post.publication.target.locale === status.plan.locale).map(post => <label key={post.publication.postId} className={styles.check}>
            <TextInput type="checkbox" className={styles.checkbox} checked={draft.postIds.includes(post.publication.postId)} disabled={!editable()} onChange={event => {
              if (editable()) owner.editTeamRecovery(link, { postIds: event.target.checked ? [...draft.postIds.filter(id => id !== post.publication.postId), post.publication.postId] : draft.postIds.filter(id => id !== post.publication.postId) });
            }}/><span><span>{names.get(post.publication.target.unitId)} · {post.publication.target.locale}</span><span className={styles.text}>{post.publication.body}</span></span></label>)}
          {!posts.data?.posts.length ? <p>{t("noPosts")}</p> : null}
          {draft.postIds.filter(postId => !posts.data?.posts.some(post => post.publication.postId === postId)).map((postId, index) => <label key={postId} className={styles.check}>
            <TextInput type="checkbox" className={styles.checkbox} checked disabled={!editable()} onChange={() => { if (editable()) owner.editTeamRecovery(link, { postIds: draft.postIds.filter(id => id !== postId) }); }}/>
            <span>{t("selectedPost", { number: index + 1 })}<span className={styles.text}>{t("selectedPostHelp")}</span></span></label>)}
          <div className={styles.actions}><Button size="sm" disabled={!editable() || posts.isFetching || afterPost === null} onClick={() => { if (editable()) setPostCursor({ frame, value: null }); }}>{t("firstPage")}</Button>
            <Button size="sm" disabled={!editable() || posts.isFetching || !posts.data?.nextAfter} onClick={() => { if (editable()) setPostCursor({ frame, value: posts.data?.nextAfter ?? null }); }}>{t("nextPosts")}</Button></div>
          <p>{t("selected", { posts: draft.postIds.length, works: draft.priorWork.length })}</p>
        </details>
        {problem && problem !== "work" ? <p role="status">{global(`ai.recovery.problems.${problem}`)}</p> : null}
        {!connectionsCurrent ? <Banner tone="warning">{t("connectionChanged")}</Banner> : null}
        {ownPending && !prepared && !state?.receipt ? <p role="status">{t("newPreview")}</p> : null}
        <div className={styles.actions}><Button variant="primary" size="sm" disabled={!canPrepare || !allowed()} onClick={event => void prepare(event.currentTarget)}>{t("prepare")}</Button>
          <Button size="sm" disabled={!editable() || blocked || !!input.value.pending} onClick={() => { if (editable()) owner.discardTeamRecovery(link); }}>{t("discard")}</Button></div>
      </>}
      {prepared ? <><TeamRecoveryDisclosure plan={state?.preparedPlan ?? status.plan} preview={prepared.preview} unresolvedWork={state?.unresolvedWork ?? []}/>
        <WorkPlanExecutionReview review={review} disabled={blocked} consentDisabled={!matchingCapture || !connectionsCurrent} showConsent/>
        <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={state?.consent ?? false}
          disabled={blocked || !matchingCapture || !fresh || !available || !connectionsCurrent || !review.confirmed} onChange={event => {
            if (editable() && matchingCapture && review.current()) owner.setTeamRecoveryConsent(link, event.target.checked);
          }}/><span>{t("consent")}</span></label><p>{t("noStart")}</p>
        <Button variant="primary" size="sm" disabled={!canAuthorize || !allowed()} onClick={event => void authorize(event.currentTarget)}>{t("authorize")}</Button></> : null}
      {state?.receipt ? <><p role="status">{t("ready")}</p><Button variant="primary" size="sm" disabled={!allowed() || !owner.canStartTeamRecovery(link.conversationId, status)} onClick={event => {
        if (!allowed()) return; const origin = event.currentTarget;
        void owner.startTeamRecovery(link, status, allowed).finally(() => finish(origin));
      }}>{t("start")}</Button></> : null}
      {!state?.receipt && (ownPending || prepared) ? <><p>{t("closeHelp")}</p><Button size="sm" disabled={!editable() || !!state?.busy || input.journalBusy || !!input.busy} onClick={event => {
        if (!editable()) return; const origin = event.currentTarget;
        void owner.closeTeamRecovery(link).finally(() => finish(origin));
      }}>{t("close")}</Button></> : null}
    </div>
  </section>;
}

function RecoveryMemberFields({ member, number, owner, link, plan, editSeq, active, editable }: {
  member: ConversationRecoveryMember; number: number; owner: ConversationSession; link: ConversationPlanLink;
  plan: WorkPlanStatusView["plan"]; editSeq: string; active: boolean; editable: () => boolean;
}) {
  const { t } = useTranslation(), id = useId(), facts = useConnectionFacts();
  const [connectionOpen, setConnectionOpen] = useState(false), [presetName, setPresetName] = useState("custom");
  const change = (patch: Partial<ConversationRecoveryMember>) => { if (editable()) owner.editTeamRecoveryMember(link, member.key, patch); };
  const config = (value: AiConfig | ((before: AiConfig) => AiConfig)) => change({ config: editedAiConfig(member.config, typeof value === "function" ? value(member.config) : value) });
  const tools = [...new Set([...(plan.tools?.entries.map(tool => tool.handle) ?? []), ...member.toolHandles])];
  return <fieldset className={styles.member}><legend>{t("ai.team.memberNumber", { number: String(number) })}</legend>
    <Field label={t("ai.team.name")}><TextInput value={member.displayName} readOnly={!editable()} onChange={event => change({ displayName: event.target.value })}/></Field>
    <Field label={t("ai.team.role")}><TextArea value={member.role} readOnly={!editable()} onChange={event => change({ role: event.target.value })}/></Field>
    <ModelConnectionPicker config={member.config} label={t("ai.team.connection")} active={active} disabled={!editable()} editSeq={Number(editSeq)} onSelect={(view, profileId) => {
      const latest = owner.getSnapshot().inputs.get(link.conversationId)?.value.teamDrafts?.find(value => value.planId === link.planId)?.recovery;
      if (!editable() || latest?.editSeq !== editSeq) return false;
      const profile = view?.snapshot.profiles.find(value => value.id === profileId && !value.archived), reference = view?.references.find(value => value.profileId === profileId);
      if (profileId && (!profile || !reference || view !== facts.current())) return false;
      change({ config: profile && reference ? connectionAiConfig(member.config, profile.connection, reference) : { ...member.config, connectionProfile: null } }); return true;
    }}/>
    <fieldset className={styles.fields} disabled={!editable()}><AiConnectionEditor config={member.config} setConfig={config} presetName={presetName} setPresetName={setPresetName}
      connectionOpen={connectionOpen} setConnectionOpen={setConnectionOpen} failure={null} idPrefix={id}/>
      <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={member.config.shareTerms} onChange={event => config(before => ({ ...before, shareTerms: event.target.checked }))}/><span>{t("ai.shareTerms")}</span></label>
      <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={member.config.shareContext} onChange={event => config(before => ({ ...before, shareContext: event.target.checked }))}/><span>{t("ai.shareContext")}</span></label>
      <SourceContextChoice value={member.config.sourceContext} onChange={sourceContext => config(before => ({ ...before, sourceContext }))}/>
      <details><summary>{t("ai.team.memberLimits")}</summary><p>{t("ai.team.memberLimitsHelp")}</p><AiBudgetInputs config={member.config} setConfig={config}
        fields={["maxItems", "maxRequests", "maxOutputTokens", "maxRetries", "timeoutSeconds"]} idPrefix={id}/></details>
      <fieldset className={styles.fields}><legend>{t("ai.team.units")}</legend>{[...new Set([...plan.scope.map(unit => unit.unitId), ...member.unitIds])].map(unitId => <label className={styles.check} key={unitId}>
        <TextInput type="checkbox" className={styles.checkbox} checked={member.unitIds.includes(unitId)} onChange={event => change({ unitIds: event.target.checked ? [...member.unitIds, unitId] : member.unitIds.filter(value => value !== unitId) })}/>
        <span>{plan.scope.find(unit => unit.unitId === unitId)?.nativeKey ?? t("ai.team.removedEntry", { number: String(member.unitIds.indexOf(unitId) + 1) })}</span></label>)}</fieldset>
      <fieldset className={styles.fields}><legend>{t("ai.team.tools")}</legend>{tools.length ? tools.map((handle, index) => <label key={handle} className={styles.check}>
        <TextInput type="checkbox" className={styles.checkbox} checked={member.toolHandles.includes(handle)} onChange={event => change({ toolHandles: event.target.checked ? [...member.toolHandles, handle] : member.toolHandles.filter(value => value !== handle) })}/>
        <span>{plan.tools?.entries.find(tool => tool.handle === handle)?.binding.declaration.title ?? t("ai.team.removedTool", { number: String(index + 1) })}</span></label>) : <p>{t("ai.team.noTools")}</p>}</fieldset>
      <fieldset className={styles.fields}><legend>{t("ai.team.kinds")}</legend>{TeamWorkKindValues.map(kind => <label key={kind} className={styles.check}>
        <TextInput type="checkbox" className={styles.checkbox} checked={member.kinds.includes(kind)} onChange={event => change({ kinds: event.target.checked ? [...member.kinds, kind] : member.kinds.filter(value => value !== kind) })}/><span>{t(`ai.team.workKinds.${kind}`)}</span></label>)}</fieldset>
    </fieldset>
    <Button size="sm" disabled={!editable()} onClick={() => { if (editable()) owner.removeTeamRecoveryMember(link, member.key); }}>{t("ai.team.remove")}</Button>
  </fieldset>;
}
