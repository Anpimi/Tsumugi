import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AiBudgetInputs, AiConnectionEditor } from "../../../AiConnectionFields";
import { AiPreviewItems } from "../../../AiPreviewItems";
import { connectionConfigCurrent, connectionReadKey, pluginInventoryReadKey, useConnectionFacts } from "../../../ApplicationReadProvider";
import { connectionAiConfig, validAiLimits } from "../../../aiCommands";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "../../../CommandFailure";
import { conversationCommands } from "../../../conversationCommands";
import { ModelConnectionPicker, PreparationBudgetSummary } from "../../../ModelConnectionPicker";
import { jsonIdentity } from "../../../pluginToolChoices";
import { useSessionInfiniteQuery, useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { SourceContextChoice } from "../../../SourceContextPreparation";
import { TeamDiscussionDisclosure } from "../../../TeamDiscussionDisclosure";
import { TeamExecutionDisclosure } from "../../../TeamExecutionDisclosure";
import { TextReviewSelections } from "../../../TextReviewSelections";
import { ToolGuidanceSharing } from "../../../ToolGuidanceSharing";
import { useWorkPlanExecutionReview, WorkPlanExecutionReview, workPlanEffects } from "../../../WorkPlanExecutionReview";
import { WorkPlanToolChoice, type PlanToolChoiceHandle } from "../../../WorkPlanToolChoice";
import { Button } from "../../../design-system/Button";
import { Field, TextInput } from "../../../design-system/Field";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ConversationInput, ConversationSession } from "./ConversationSession";
import { workPlanMinutesValid, type ProposalWorkPlanTools } from "./proposalWorkPlan";
import styles from "./ConversationWorkPlanPanel.module.css";
import { ConversationRunPanel } from "./ConversationRunPanel";

interface Props {
  owner: ConversationSession; input: ConversationInput; visible: boolean; disabled: boolean;
  gate: InteractionGate; viewId: string | null; parentDialogId?: string;
}
type PlanPage = Awaited<ReturnType<typeof conversationCommands.proposalWorkPlans>>;
type PlanLink = PlanPage["rows"][number];
interface ToolProof { current: () => boolean; dispose: () => void }

function WorkPlanHistoryRecord({ owner, link, visible, canRead, ...runProps }: Props & { link: PlanLink; canRead: () => boolean }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const proposal = useSessionQuery({
    key: ["conversation", link.conversationId, "proposal", link.proposalId, "base", link.revisionId], scopes: ["project"], enabled: visible,
    read: () => conversationCommands.readProposal({ ...owner.context, conversationId: link.conversationId, proposalId: link.proposalId, revisionId: link.revisionId }),
  });
  return <article className={styles.record}>
    <h4>{t("planHistoryNumber", { number: link.ordinal })}</h4>
    {proposal.isPending ? <p role="status">{t("planHistoryProposalLoading")}</p>
      : proposal.isError ? <Banner tone="error" action={<Button size="sm" pending={proposal.isFetching} onClick={() => {
        if (canRead()) void proposal.refetch();
      }}>{t("retryRead")}</Button>}><p>{t("planHistoryProposalFailed")}</p><CommandFailureDetails failure={commandFailure(proposal.error)}/></Banner>
      : <><p>{t("planHistoryVersion", { number: proposal.data.revision })}</p><p className={styles.text}>{proposal.data.content.summary}</p></>}
    <details><summary>{t("planHistoryIdentity")}</summary><dl className={styles.identifiers}>
      <dt>{t("planHistoryPlanId")}</dt><dd><code>{link.planId}</code></dd>
      <dt>{t("planHistoryProposalId")}</dt><dd><code>{link.proposalId}</code></dd>
      <dt>{t("planHistoryRevisionId")}</dt><dd><code>{link.revisionId}</code></dd>
      <dt>{t("planHistoryActionId")}</dt><dd><code>{link.actionId}</code></dd>
      {proposal.data ? <><dt>{t("planHistoryOrigin")}</dt><dd><code>{proposal.data.origin.attemptId}</code></dd>
        <dt>{t("planHistoryResult")}</dt><dd><code>{proposal.data.origin.resultId}</code></dd></> : null}
    </dl></details>
    <ConversationRunPanel owner={owner} link={link} visible={visible} {...runProps}/>
  </article>;
}

/** A saved proposal fixes scope and policy; all new sharing and execution consent is explicit. */
export function ConversationWorkPlanPanel({ owner, input, visible, disabled, gate, viewId, parentDialogId }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" }), { t: global } = useTranslation();
  const reads = useSessionReads(), facts = useConnectionFacts(), workPlan = input.workPlan;
  const conversationId = input.key.conversationId, revision = workPlan.revision;
  const proposal = revision?.content.kind === "proposal" ? revision.content : null;
  const open = visible && workPlan.open, plan = workPlan.prepared?.plan ?? null;
  const [connectionOpen, setConnectionOpen] = useState(false), [presetName, setPresetName] = useState("custom");
  const [captureFailure, setCaptureFailure] = useState<CommandFailure | null>(null);
  const id = useId(), inputOwner = `conversation-work-plan-${id}`;
  const root = useRef<HTMLElement>(null), previewRegion = useRef<HTMLElement>(null), origin = useRef<HTMLElement | null>(null);
  const focus = useRef<{ origin: HTMLElement; preview: boolean } | null>(null), wasOpen = useRef(false);
  const proof = useRef<ToolProof | null>(null), live = useRef({ mounted: true, visible, disabled, open });
  useLayoutEffect(() => { live.current = { mounted: true, visible, disabled, open }; return () => { live.current.mounted = false; }; }, [visible, disabled, open]);
  const disposeProof = () => { proof.current?.dispose(); proof.current = null; };
  const invalidate = () => { disposeProof(); owner.invalidateWorkPlan(conversationId); };
  const pending = !!input.value.pending || !!input.failure;
  const blocked = disabled || !open || !!input.busy || pending || !!workPlan.busy;
  const unsavedProposal = !!revision && !!input.value.proposalEdits?.some(edit => edit.proposalId === revision.proposalId);
  const unresolved = proposal?.questions.length ?? 0;
  const connectionCurrent = connectionConfigCurrent(facts.current(), workPlan.config);
  const valid = validAiLimits(workPlan.config) && !!workPlan.config.endpoint.trim() && !!workPlan.config.model.trim()
    && !!proposal && proposal.unitIds.length <= workPlan.config.maxItems;
  const canRead = () => live.current.mounted && live.current.visible && !live.current.disabled && !owner.getSnapshot().retired
    && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const allowed = () => !blocked && canRead();
  // Journal construction clears final consent and adds a pending request. Those
  // changes must not invalidate this same, already confirmed authorization.
  const current = () => {
    const snapshot = owner.getSnapshot(), latest = snapshot.inputs.get(conversationId)?.workPlan;
    return canRead() && live.current.open && !reads.retired && snapshot.activeId === conversationId && !!latest?.open
      && connectionConfigCurrent(facts.current(), latest.config) && (proof.current?.current() ?? true);
  };
  const review = useWorkPlanExecutionReview({ context: owner.context, plan, generation: "prepared", open,
    value: workPlan.executionConsent, onChange: change => { if (allowed()) owner.setWorkPlanExecutionConsent(conversationId, change); } });
  const history = useSessionInfiniteQuery<PlanPage, string | null>({ key: ["conversation", conversationId, "work-plans"], scopes: ["project"], enabled: visible,
    initialPageParam: null as string | null, nextPage: last => last.nextAfter ?? undefined,
    read: after => conversationCommands.proposalWorkPlans({ ...owner.context, conversationId, after, limit: 50 }) });
  const links = history.data?.pages.flatMap(page => page.rows) ?? [];

  useEffect(() => () => { disposeProof(); gate.releaseOwner(inputOwner); }, [gate, inputOwner]);
  useEffect(() => {
    // Duration changes keep the same prepared material and its read witnesses.
    if (!workPlan.prepared) disposeProof();
    setCaptureFailure(null);
  }, [conversationId, workPlan.sequence, workPlan.prepared]);
  useEffect(() => {
    if (!open) { disposeProof(); gate.releaseOwner(inputOwner); owner.invalidateWorkPlan(conversationId); }
  }, [conversationId, gate, inputOwner, open, owner]);
  useEffect(() => { if (!connectionCurrent) invalidate(); }, [connectionCurrent, conversationId, owner]);
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(scope => ["project", "source", "translation", "resources", "review"].includes(scope))) invalidate();
  }), [reads, conversationId, owner]);
  useEffect(() => facts.client.getQueryCache().subscribe(event => {
    if (event.type !== "updated" && event.type !== "removed") return;
    const key = jsonIdentity(event.query.queryKey);
    if (key === jsonIdentity(connectionReadKey) || key === jsonIdentity(pluginInventoryReadKey)) invalidate();
  }), [facts.client, conversationId, owner]);
  useEffect(() => reads.client.getQueryCache().subscribe(event => {
    if (event.type !== "updated" && event.type !== "removed") return;
    const kind = event.query.queryKey[2];
    if (kind !== "tool-query-inventory" && kind !== "tool-query-environment") return;
    if ((proof.current && !proof.current.current()) || (kind === "tool-query-inventory" && (event.type === "removed"
      || event.query.state.isInvalidated || event.query.state.fetchStatus !== "idle" || event.query.state.error !== null))) invalidate();
  }), [reads, conversationId, owner]);
  useLayoutEffect(() => {
    if (open && !wasOpen.current) { origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; root.current?.focus(); }
    if (!open && wasOpen.current && visible && origin.current?.isConnected
      && (root.current?.contains(document.activeElement) || document.activeElement === document.body)) origin.current.focus();
    wasOpen.current = open;
  }, [open, visible]);
  useEffect(() => {
    const ticket = focus.current;
    if (!ticket || workPlan.busy || input.busy) return;
    focus.current = null;
    if (open && (document.activeElement === ticket.origin || document.activeElement === document.body))
      (ticket.preview && workPlan.prepared ? previewRegion.current : root.current)?.focus();
  }, [input.busy, open, workPlan.busy, workPlan.prepared]);

  const toolChoice = useRef<PlanToolChoiceHandle>(null);
  async function prepare(button: HTMLElement) {
    if (!allowed() || !valid || !connectionCurrent || unresolved || unsavedProposal) return;
    disposeProof(); setCaptureFailure(null);
    let selected: ProposalWorkPlanTools;
    try {
      selected = toolChoice.current?.capture() ?? null;
      if (!!selected !== !!workPlan.toolDraft) throw new Error("The selected tools are not available");
      const witnesses = selected?.entries.map(tool => {
        const witness = reads.watchExactQuery(tool.readKey), original = witness.current();
        return { witness, original, identity: jsonIdentity(tool.view) };
      }) ?? [];
      proof.current = {
        current: () => witnesses.every(({ witness, original, identity }) => {
          const query = witness.current();
          return !!query && query === original && query.state.status === "success" && query.state.error === null
            && !query.state.isInvalidated && query.state.fetchStatus === "idle" && jsonIdentity(query.state.data) === identity;
        }),
        dispose: () => witnesses.forEach(({ witness }) => witness.dispose()),
      };
      if (!proof.current.current()) throw new Error("The selected tool material changed");
    } catch (error) { disposeProof(); setCaptureFailure(commandFailure(error)); return; }
    focus.current = { origin: button, preview: true };
    await owner.prepareWorkPlan(conversationId, selected, current);
  }
  const preview = plan?.preview, mcp = plan?.options.mcpTermQuery?.preview;
  const consentKey = plan?.options.teamExecution ? plan.options.teamDiscussions?.profile === "current-plan-2" ? "ai.team.artifactConsent" : "ai.team.consent"
    : plan?.options.teamDiscussions?.profile === "current-plan-2" ? "ai.discussions.artifactConsent" : plan?.options.teamDiscussions ? "ai.discussions.consent" : "ai.consent";
  return <div className={styles.panel} hidden={!visible}>
    {workPlan.open && revision && proposal ? <section ref={root} tabIndex={-1} className={styles.editor} aria-label={t("planTitle")}
      onFocusCapture={() => gate.setInputOwner(viewId, inputOwner)}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputOwner); }}
      onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
      <div className={styles.actions}><h3>{t("planTitle")}</h3><Button size="sm" onClick={() => {
        if (canRead()) owner.setWorkPlanOpen(conversationId, false);
      }}>{t("planClose")}</Button></div>
      <p>{t("planHelp")}</p><p>{t("planBasedOn", { number: revision.revision })}</p><p className={styles.text}>{proposal.summary}</p>
      <p>{t("planFixedScope", { count: proposal.unitIds.length })}</p>
      <div className={styles.section}>{proposal.options.stages.map(choice => <p key={choice.stage}>{t("proposalStage", {
        stage: global(`ai.plan.stages.${choice.stage}`), mode: global(`ai.plan.modes.${choice.mode}`),
      })}</p>)}<p>{global(`ai.plan.policies.${proposal.options.selectionPolicy}`)}</p></div>
      {unresolved ? <Banner tone="warning"><p>{t("planUnresolvedQuestions", { count: unresolved })}</p><ul>{proposal.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></Banner> : null}
      {unsavedProposal ? <Banner tone="warning">{t("planUnsavedProposal")}</Banner> : null}
      {pending ? <Banner tone="warning">{t("planPending")}</Banner> : null}
      <fieldset className={styles.configuration} disabled={blocked}><legend>{t("planDestination")}</legend>
        <ModelConnectionPicker config={workPlan.config} label={global("connections.choose")} active={open} disabled={blocked} editSeq={workPlan.sequence}
          onSelect={(view, profileId, sequence) => {
            if (!allowed() || sequence !== owner.getSnapshot().inputs.get(conversationId)?.workPlan.sequence) return false;
            if (!profileId) { owner.setWorkPlanConfig(conversationId, before => ({ ...before, connectionProfile: null })); return true; }
            if (!view || facts.current() !== view) return false;
            const profile = view.snapshot.profiles.find(value => value.id === profileId && !value.archived), reference = view.references.find(value => value.profileId === profileId);
            if (!profile || !reference) return false;
            owner.setWorkPlanConfig(conversationId, before => connectionAiConfig(before, profile.connection, reference)); return true;
          }}/>
        <AiConnectionEditor config={workPlan.config} setConfig={change => { if (allowed()) owner.setWorkPlanConfig(conversationId, change); }} presetName={presetName} setPresetName={setPresetName}
          connectionOpen={connectionOpen} setConnectionOpen={setConnectionOpen} failure={null} idPrefix={id}/>
        <AiBudgetInputs config={workPlan.config} setConfig={change => { if (allowed()) owner.setWorkPlanConfig(conversationId, change); }} idPrefix={id}/>
        <PreparationBudgetSummary config={workPlan.config} policy={proposal.options.teamDiscussions} team={!!proposal.options.teamExecution}/>
        <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={workPlan.config.shareTerms} onChange={event => {
          if (allowed()) owner.setWorkPlanConfig(conversationId, before => ({ ...before, shareTerms: event.target.checked }));
        }}/><span>{global("ai.shareTerms")}</span></label>
        <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={workPlan.config.shareContext} onChange={event => {
          if (allowed()) owner.setWorkPlanConfig(conversationId, before => ({ ...before, shareContext: event.target.checked }));
        }}/><span>{global("ai.shareContext")}</span></label>
        <SourceContextChoice value={workPlan.config.sourceContext} help={t("planSourceContextHelp")} onChange={sourceContext => {
          if (allowed()) owner.setWorkPlanConfig(conversationId, before => ({ ...before, sourceContext }));
        }}/>
        {proposal.options.stages.some(choice => choice.stage === "checks" && choice.mode === "assisted") ? <TextReviewSelections value={workPlan.advisoryChecks}
          active={open} scopeKey={JSON.stringify([owner.context, conversationId, revision.revisionId])} disabled={blocked}
          onSnapshotRevision={settingsRevision => { if (plan?.checkers.some(checker => checker.kind === "ready" && checker.plugin.plugin.settingsRevision !== settingsRevision)) invalidate(); }}
          onChange={checks => { if (allowed()) owner.setWorkPlanChecks(conversationId, checks); }}/> : null}
        {/* The enclosing fieldset blocks edits without disabling the read observers
            whose exact records witness this preparation and its confirmation. */}
        <WorkPlanToolChoice ref={toolChoice} value={workPlan.toolDraft} open={open} disabled={disabled || !visible}
          onChange={tools => { if (allowed()) owner.setWorkPlanTools(conversationId, tools); }}/>
      </fieldset>
      {!valid ? <p role="status">{t("planConfigHelp")}</p> : null}
      {!connectionCurrent ? <p role="status">{t("planConnectionChanged")}</p> : null}
      <p>{t("planPreparationHelp")}</p>
      {workPlan.failure ? <Banner tone="error"><p>{t("planFailure")}</p><CommandFailureDetails failure={workPlan.failure}/></Banner> : null}
      {captureFailure ? <Banner tone="error"><p>{t("planToolCaptureFailed")}</p><CommandFailureDetails failure={captureFailure}/></Banner> : null}
      <div className={styles.actions}><Button size="sm" pending={workPlan.busy === "prepare"} disabled={blocked || !valid || !connectionCurrent || !!unresolved || unsavedProposal}
        onClick={event => void prepare(event.currentTarget)}>{t("planPrepare")}</Button></div>
      {workPlan.busy ? <p role="status">{t(workPlan.busy === "prepare" ? "planPreparing" : "planAuthorizing")}</p> : null}
      {plan ? <section ref={previewRegion} tabIndex={-1} className={styles.preview} aria-label={t("planPreview")}>
        <h4>{t("planPreview")}</h4><p>{t("planScope", { count: plan.scope.length, locale: plan.locale })}</p>
        <section className={styles.section} aria-label={t("planScopeTitle")}><h4>{t("planScopeTitle")}</h4><ul>{plan.scope.map(unit => <li key={unit.unitId}>{unit.nativeKey}</li>)}</ul>
          {plan.options.stages.map(choice => <p key={choice.stage}>{t("proposalStage", { stage: global(`ai.plan.stages.${choice.stage}`), mode: global(`ai.plan.modes.${choice.mode}`) })}</p>)}
          <p>{global(`ai.plan.policies.${plan.options.selectionPolicy}`)}</p><p>{t("planResourcesManual")}</p><p>{t("planDeliveryManual")}</p>
        </section>
        {preview ? <>{!plan.options.teamExecution ? <p className={styles.text}>{t("planModelDestination", { endpoint: preview.config.endpoint, model: preview.config.model })}</p> : null}
          <PreparationBudgetSummary config={preview.config} policy={plan.options.teamDiscussions} team={!!plan.options.teamExecution}/><p>{global("ai.rateLimit")}</p>
          <section className={styles.section} aria-label={t("planMaterial")}><h4>{t("planMaterial")}</h4>
            {plan.options.teamExecution ? <TeamExecutionDisclosure plan={plan}/> : <><AiPreviewItems items={preview.items}/><TeamDiscussionDisclosure plan={plan}/><ToolGuidanceSharing plan={plan} config={preview.config}/></>}
          </section></> : <p>{t("planManual")}</p>}
        {mcp ? <section className={styles.section} aria-label={global("ai.mcpTermQuery.confirmation")}><h4>{global("ai.mcpTermQuery.title")}</h4>
          <p>{global("ai.mcpTermQuery.confirmation")}</p><p>{global("ai.mcpTermQuery.scope", { entry: plan.scope.find(unit => unit.unitId === mcp.basis.unitId)?.nativeKey ?? "", locale: mcp.basis.locale })}</p>
          <p className={styles.text}>{mcp.request.tool.endpoint} · {mcp.request.tool.toolName}</p><pre>{mcp.arguments.query}</pre>
          {preview ? <p>{global("ai.mcpTermQuery.destination", { endpoint: preview.config.endpoint, model: preview.config.model })}</p> : null}
          <p>{global("ai.mcpTermQuery.limits", { sdk: plan.tools?.maxInvocations ?? 0, total: (plan.tools?.maxInvocations ?? 0) + 1 })}</p><p>{t("planMcpServiceSharing")}</p>
        </section> : null}
        {plan.options.toolGuidance ? <p>{global("ai.toolGuidanceSharing.confirmation")}</p> : null}
        <fieldset className={styles.execution} disabled={blocked}><legend>{global("ai.plan.controls")}</legend>
          <WorkPlanExecutionReview review={review} disabled={blocked} consentDisabled={!connectionCurrent} showConsent/>
          <Field label={t("planMinutes")} description={t("planMinutesHelp")} error={!workPlanMinutesValid(workPlan.minutes) ? t("planMinutesInvalid") : undefined}>
            <TextInput type="number" min={1} max={1440} step={1} value={Number.isFinite(workPlan.minutes) ? workPlan.minutes : ""} onChange={event => {
              if (allowed()) owner.setWorkPlanMinutes(conversationId, event.target.valueAsNumber);
            }}/>
          </Field>
          <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={workPlan.consent}
            disabled={blocked || !connectionCurrent || !review.confirmed || !workPlanMinutesValid(workPlan.minutes) || unsavedProposal}
            onChange={event => { if (allowed()) owner.setWorkPlanConsent(conversationId, event.target.checked); }}/>
            <span>{global(consentKey)} {mcp ? t("planMcpServiceSharing") : null}</span></label>
          <p>{t("planNoAutomaticStart")}</p>
          <div className={styles.actions}><Button variant="primary" size="sm" pending={workPlan.busy === "authorize"}
            disabled={blocked || !connectionCurrent || !workPlan.consent || !review.confirmed || !workPlanMinutesValid(workPlan.minutes) || unsavedProposal}
            onClick={event => {
              if (!allowed() || !current() || !review.current()) return;
              focus.current = { origin: event.currentTarget, preview: false };
              void owner.authorizeWorkPlan(conversationId, { checkerExecutions: review.checkerExecutions(), toolExecution: review.toolExecution,
                applicationToolExecutions: review.applicationToolExecutions(), effects: workPlanEffects(plan) }, () => current() && review.current());
            }}>{t("planConfirm")}</Button></div>
        </fieldset>
      </section> : null}
    </section> : null}
    <section className={styles.history} aria-label={t("planHistory")}><h3>{t("planHistory")}</h3><p>{t("planHistoryHelp")}</p>
      {history.isPending ? <LoadingState label={t("planHistoryLoading")}/> : null}
      {history.isError ? <Banner tone="error" action={<Button size="sm" pending={history.isFetching} onClick={() => {
        if (canRead()) void history.refetch();
      }}>{t("retryRead")}</Button>}><p>{t("planHistoryFailed")}</p><CommandFailureDetails failure={commandFailure(history.error)}/></Banner> : null}
      {history.isSuccess && links.length === 0 ? <p>{t("planHistoryEmpty")}</p> : null}
      {links.map(link => <WorkPlanHistoryRecord key={link.planId} owner={owner} input={input} link={link} visible={visible} disabled={disabled}
        gate={gate} viewId={viewId} parentDialogId={parentDialogId} canRead={canRead}/>)}
      {history.hasNextPage ? <div className={styles.actions}><Button size="sm" pending={history.isFetchingNextPage} disabled={!visible || disabled || history.isFetching}
        onClick={() => { if (canRead()) void history.fetchNextPage(); }}>{t("planHistoryMore")}</Button></div> : null}
    </section>
  </div>;
}
