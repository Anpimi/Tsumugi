import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { conversationCommands, isConversationMessageText, type ConversationProposalRevision } from "../../../conversationCommands";
import type { ConversationProposalDraft } from "../../../conversationDraftCommands";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import { useSessionQuery } from "../../../SessionReadProvider";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Banner, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { Menu } from "../../../design-system/Menu";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ConversationInput, ConversationSession } from "./ConversationSession";
import { planningUnitLabels, validProposalContent, validProposalQuestion } from "./proposalDraft";
import styles from "./ConversationPanel.module.css";

interface ContextProps {
  owner: ConversationSession; input: ConversationInput; visible: boolean; disabled: boolean;
  gate: InteractionGate; viewId: string | null; parentDialogId?: string;
}

function ProposalEditor({ owner, input, draft, visible, disabled, gate, viewId, parentDialogId, focusRequest }: ContextProps & { draft: ConversationProposalDraft; focusRequest: RefObject<boolean> }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" }), { t: global } = useTranslation();
  const conversationId = input.key.conversationId, proposalId = draft.proposalId, context = owner.context;
  const id = useId(), inputOwner = `proposal-editor-${id}`, dialogId = `proposal-discard-${id}`;
  const root = useRef<HTMLElement>(null), live = useRef({ visible, disabled, mounted: true });
  const focus = useRef<HTMLElement | null>(null);
  const [discardSeq, setDiscardSeq] = useState<string | null>(null), [latestOpen, setLatestOpen] = useState(false);
  useLayoutEffect(() => { live.current = { visible, disabled, mounted: true }; return () => { live.current.mounted = false; }; }, [disabled, visible]);
  useLayoutEffect(() => { if (visible && focusRequest.current) { focusRequest.current = false; root.current?.focus(); } });
  useEffect(() => () => gate.releaseOwner(inputOwner), [gate, inputOwner]);
  useEffect(() => { if (!visible) { gate.releaseOwner(inputOwner); setDiscardSeq(null); } }, [gate, inputOwner, visible]);
  useEffect(() => discardSeq === null ? undefined : gate.pushDialog(dialogId), [dialogId, discardSeq, gate]);
  useEffect(() => {
    const origin = focus.current;
    if (!origin || input.busy || input.journalBusy) return;
    focus.current = null;
    if (visible && (document.activeElement === origin || document.activeElement === document.body)) root.current?.focus();
  }, [input.busy, input.journalBusy, visible]);
  const base = useSessionQuery({ key: ["conversation", conversationId, "proposal", proposalId, "base", draft.expectedRevisionId], scopes: ["project"], enabled: visible,
    read: () => conversationCommands.readProposal({ ...context, conversationId, proposalId, revisionId: draft.expectedRevisionId }) });
  const latest = useSessionQuery({ key: ["conversation", conversationId, "proposal", proposalId, "latest"], scopes: ["project"], enabled: visible,
    read: () => conversationCommands.readProposal({ ...context, conversationId, proposalId, revisionId: null }) });
  const originId = base.data?.origin.attemptId;
  const origin = useSessionQuery({ key: ["conversation", conversationId, "proposal", proposalId, "origin", originId], scopes: ["project", "execution"], enabled: visible && !!originId,
    read: () => { if (!originId) throw new Error("Missing proposal origin"); return conversationCommands.readPlanning({ ...context, conversationId, attemptId: originId }); } });
  const readFailed = base.isError || latest.isError || origin.isError;
  const reading = base.isFetching || latest.isFetching || origin.isFetching;
  const changed = !!latest.data && latest.data.revisionId !== draft.expectedRevisionId;
  const run = origin.data, scope = run?.preview.scope, labels = planningUnitLabels(run?.preview.input ?? "");
  const materialUnavailable = !reading && !readFailed && (!base.data || !latest.data || !run || run.resultId !== base.data.origin.resultId || scope?.kind !== "units");
  const content = draft.content, pending = !!input.value.pending, blocked = disabled || !visible;
  const allowed = () => !blocked && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const current = () => live.current.mounted && live.current.visible && !live.current.disabled && owner.getSnapshot().activeId === conversationId
    && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const failure = input.proposalFailure?.proposalId === proposalId ? input.proposalFailure.cause : null;
  if (content.kind !== "proposal") return <ErrorState title={t("proposalDraftInvalid")}/>;
  return <section ref={root} tabIndex={-1} className={styles.proposalEditor} aria-label={t("proposalEditor")}
    onFocusCapture={() => gate.setInputOwner(viewId, inputOwner)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputOwner); }}
    onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
    <h3>{t("proposalEditor")}</h3><p>{t("proposalEditHelp")}</p>
    {base.data ? <p>{t("proposalBasedOn", { number: base.data.revision })}</p> : null}
    {readFailed ? <Banner tone="error"><p>{t("proposalReadFailed")}</p><CommandFailureDetails failure={commandFailure(base.error ?? latest.error ?? origin.error)}/></Banner>
      : reading ? <LoadingState label={t("proposalReading")}/> : materialUnavailable ? <Banner tone="warning">{t("proposalMaterialUnavailable")}</Banner> : null}
    <Button size="sm" disabled={blocked || reading} onClick={() => { void base.refetch(); void latest.refetch(); if (originId) void origin.refetch(); }}>{t("proposalRefresh")}</Button>
    {changed ? <Banner tone="warning"><p>{t("proposalNewerVersion")}</p>
      <Button size="sm" aria-expanded={latestOpen} onClick={() => setLatestOpen(value => !value)}>{t("proposalShowLatest")}</Button>
      {latestOpen && latest.data ? <div><p>{t("proposalVersion", { number: latest.data.revision })}</p><p className={styles.text}>{latest.data.content.summary}</p>
        {latest.data.content.questions.map((question, index) => <p className={styles.text} key={index}>{question}</p>)}
        {latest.data.content.kind === "proposal" ? <><p>{t("proposalScope", { count: latest.data.content.unitIds.length })}</p>
          <ul>{latest.data.content.unitIds.map((unitId, index) => <li key={unitId}>{labels.get(unitId)?.key || t("proposalEntryNumber", { number: index + 1 })}</li>)}</ul>
          <p>{global(`ai.plan.policies.${latest.data.content.options.selectionPolicy}`)}</p></> : null}
        <p>{t("proposalRebaseHelp")}</p><Button size="sm" disabled={blocked || (!!input.busy || input.journalBusy) || pending || readFailed || reading || !run} onClick={() => {
          if (allowed() && latest.data) { focusRequest.current = true; owner.acceptProposalBase(latest.data, draft.editSeq); }
        }}>{t("proposalUseLatestBase")}</Button></div> : null}
    </Banner> : null}
    <Field label={t("proposalSummary")} error={!isConversationMessageText(content.summary) ? t("proposalSummaryInvalid") : undefined}>
      <TextArea rows={4} value={content.summary} readOnly={blocked} onChange={event => owner.editProposal(conversationId, proposalId, value => ({ ...value, summary: event.target.value }))}/>
    </Field>
    <fieldset className={styles.proposalFields} disabled={blocked}><legend>{t("proposalQuestions")}</legend>
      {content.questions.map((question, index) => <div key={index} className={styles.question}>
        <Field label={t("proposalQuestion", { number: index + 1 })} error={!validProposalQuestion(question) ? t("proposalQuestionInvalid") : undefined}>
          <TextArea rows={2} value={question} onChange={event => owner.editProposal(conversationId, proposalId, value => ({ ...value, questions: value.questions.map((text, position) => position === index ? event.target.value : text) }))}/>
        </Field>
        <Button size="sm" onClick={() => { if (allowed()) owner.editProposal(conversationId, proposalId, value => ({ ...value, questions: value.questions.filter((_, position) => position !== index) })); }}>{t("proposalRemoveQuestion", { number: index + 1 })}</Button>
      </div>)}
      <Button size="sm" disabled={content.questions.length >= 8} onClick={() => { if (allowed()) owner.editProposal(conversationId, proposalId, value => ({ ...value, questions: [...value.questions, ""] })); }}>{t("proposalAddQuestion")}</Button>
    </fieldset>
    {scope?.kind === "units" ? <fieldset className={styles.proposalFields} disabled={blocked}><legend>{t("proposalEntries", { locale: scope.locale })}</legend>
      {scope.unitIds.map((unitId, index) => <div className={styles.previewMessage} key={unitId}><label className={styles.check}>
        <TextInput type="checkbox" className={styles.checkbox} checked={content.unitIds.includes(unitId)} onChange={event => owner.editProposal(conversationId, proposalId,
          value => ({ ...value, unitIds: event.target.checked ? [...value.unitIds, unitId] : value.unitIds.filter(id => id !== unitId) }))}/>
        <span>{labels.get(unitId)?.key || t("proposalEntryNumber", { number: index + 1 })}</span></label>
        {labels.has(unitId) ? <p className={styles.text}>{labels.get(unitId)?.text}</p> : null}</div>)}
      {!content.unitIds.length ? <p role="status">{t("proposalChooseEntries")}</p> : null}
    </fieldset> : null}
    <div className={styles.planSummary}><h4>{t("proposalSteps")}</h4>
      {content.options.stages.map(choice => <p key={choice.stage}>{t("proposalStage", { stage: global(`ai.plan.stages.${choice.stage}`), mode: global(`ai.plan.modes.${choice.mode}`) })}</p>)}
      <p>{global(`ai.plan.policies.${content.options.selectionPolicy}`)}</p><p>{t("proposalKeepOptions")}</p>
    </div>
    {failure ? <Banner tone="error"><p>{t("proposalSaveFailed")}</p><CommandFailureDetails failure={failure}/></Banner> : null}
    <div className={styles.actions}><Button variant="secondary" size="sm" disabled={blocked || (!!input.busy || input.journalBusy) || pending || readFailed || reading || changed || !base.data || !latest.data || !run || run.resultId !== base.data.origin.resultId || !validProposalContent(content, run)}
      onClick={event => { if (allowed()) { focus.current = event.currentTarget; void owner.saveProposal(conversationId, proposalId, current); } }}>{t("proposalSaveVersion")}</Button>
      <Button size="sm" disabled={blocked || (!!input.busy || input.journalBusy) || pending} onClick={() => { if (allowed()) setDiscardSeq(draft.editSeq); }}>{t("proposalDiscard")}</Button></div>
    <p>{t(input.failure?.kind === "journal" ? "inputUnsaved" : input.journalBusy || input.dirty ? "savingInput" : "inputSaved")}</p>
    <Dialog open={discardSeq !== null && visible} title={t("proposalDiscardTitle")} description={t("proposalDiscardHelp")} closeLabel={t("proposalKeepEditing")}
      onOpenChange={open => { if (!open) setDiscardSeq(null); }} footer={<><Button onClick={() => setDiscardSeq(null)}>{t("proposalKeepEditing")}</Button>
        <Button variant="danger" disabled={blocked || (!!input.busy || input.journalBusy) || pending || discardSeq !== draft.editSeq} onClick={() => {
          if (discardSeq !== null && gate.canDispatch({ viewId, source: "button", dialogId }) && owner.discardProposalEdit(conversationId, proposalId, discardSeq)) setDiscardSeq(null);
        }}>{t("proposalConfirmDiscard")}</Button></>}><p className={styles.text}>{content.summary || t("proposalEmptySummary")}</p></Dialog>
  </section>;
}

export function ConversationProposals({ revisions, ...props }: ContextProps & { revisions: readonly ConversationProposalRevision[] }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const { owner, input, visible, disabled, gate, viewId, parentDialogId } = props;
  const focusRequest = useRef(false);
  const edits = input.value.proposalEdits ?? [], active = edits.find(edit => edit.proposalId === input.proposalEditorId) ?? edits[0];
  const allowed = () => visible && !disabled && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  return <>
    {edits.length ? <section className={styles.planning} aria-label={t("proposalLocalDrafts")}><h3>{t("proposalLocalDrafts")}</h3>
      <Menu label={t("proposalChooseDraft")} trigger={<Button size="sm" disabled={disabled || !visible}>{t("proposalDraftCount", { count: edits.length })}</Button>}
        items={edits.map((edit, index) => ({ id: edit.proposalId, label: edit.content.summary || t("proposalDraftNumber", { number: index + 1 }), onSelect: () => { if (allowed()) { focusRequest.current = true; owner.showProposalEdit(input.key.conversationId, edit.proposalId); } } }))}/>
    </section> : null}
    {active ? <ProposalEditor key={active.proposalId} {...props} draft={active} focusRequest={focusRequest}/> : null}
    {revisions.length ? <section className={styles.history} aria-label={t("proposalHistory")}><h3>{t("proposalHistory")}</h3>
      {revisions.map(revision => <article key={revision.revisionId} className={styles.proposalRevision}><h4>{t("proposalVersion", { number: revision.revision })}</h4>
        <p className={styles.text}>{revision.content.summary}</p>{revision.content.kind === "proposal" ? <p>{t("proposalScope", { count: revision.content.unitIds.length })}</p> : null}
        {revision.content.questions.length ? <p>{t("proposalQuestionsRemaining", { count: revision.content.questions.length })}</p> : null}
        <Button size="sm" disabled={disabled || !visible} onClick={() => { if (allowed()) { focusRequest.current = true; owner.beginProposalEdit(revision); } }}>{t(edits.some(edit => edit.proposalId === revision.proposalId) ? "proposalContinueEditing" : "proposalEdit")}</Button>
        <Button size="sm" disabled={disabled || !visible || (!!input.busy || input.journalBusy) || !!input.workPlan.busy || !!input.value.pending} onClick={() => { if (allowed()) owner.beginWorkPlan(revision); }}>{t("planReviewOpen")}</Button>
      </article>)}
    </section> : null}
  </>;
}
