import { Disclosure } from "../../../design-system/Disclosure";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { teamQuestionCommands, type TeamQuestionView } from "../../../teamQuestionCommands";
import { workPlanCommands, type WorkPlanStatusView } from "../../../workPlanCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import { Button } from "../../../design-system/Button";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ConversationSession, ConversationInput } from "./ConversationSession";
import type { ConversationPlanLink } from "./conversationRun";
import type { ConversationTeamQuestionTarget } from "./conversationNavigation";
import styles from "./ConversationTeamQuestions.module.css";

interface Props {
  owner: ConversationSession; input: ConversationInput; link: ConversationPlanLink; status: WorkPlanStatusView;
  visible: boolean; disabled: boolean; current: () => boolean; gate: InteractionGate; viewId: string | null; parentDialogId?: string;
  target?: ConversationTeamQuestionTarget | null;
}
export function ConversationTeamQuestions(props: Props) {
  const { owner, input, link, status, visible, disabled, current, gate, viewId, parentDialogId, target } = props;
  const { t } = useTranslation(undefined, { keyPrefix: "conversationTeamQuestions" }), reads = useSessionReads(), id = useId();
  const [expanded, setExpanded] = useState(false), [after, setAfter] = useState<string | null>(null);
  const targetMatches = target?.conversationId === link.conversationId && target.planId === link.planId;
  const open = expanded || targetMatches, drafts = owner.teamDraft(link.conversationId, link.planId)?.questions ?? [];
  const live = useRef(props); live.current = props;
  const allowed = () => live.current.visible && !live.current.disabled && live.current.current()
    && gate.canDispatch({ viewId: live.current.viewId, source: "button", dialogId: live.current.parentDialogId });
  const page = useSessionQuery({ key: ["team-questions", link.conversationId, link.planId, after], scopes: ["execution", "project"], enabled: visible && open,
    read: () => teamQuestionCommands.page({ ...owner.context, planId: link.planId, after, limit: 16 }) });
  const exact = useSessionQuery({ key: ["team-question", link.conversationId, link.planId, targetMatches ? target.questionPostId : null], scopes: ["execution", "project"],
    enabled: visible && open && targetMatches, read: () => teamQuestionCommands.question({ ...owner.context, planId: link.planId, questionPostId: target!.questionPostId }) });
  const roles = useSessionQuery({ key: ["team-question-roles", link.conversationId, link.planId], scopes: ["execution", "project"], enabled: visible && open,
    read: () => workPlanCommands.teamExecution({ ...owner.context, planId: link.planId, afterWork: null, afterMessage: null, limit: 16 }) });
  const listed = page.data?.questions ?? [], questions = exact.data && !listed.some(view => view.question.publication.postId === exact.data.question.publication.postId)
    ? [exact.data, ...listed] : listed;
  if (!status.plan.options.teamQuestions && !targetMatches && drafts.length === 0) return null;
  return <section className={styles.panel} aria-label={t("title")}><Button size="sm" aria-expanded={open} aria-controls={id}
    disabled={!visible || disabled} onClick={() => { if (allowed()) setExpanded(value => !value); }}>{t(open ? "hide" : "show")}</Button>
    <div id={id} hidden={!open}>{open ? <>
      <p>{t("help")}</p><p>{t("localHelp")}</p>
      {(page.isPending || targetMatches && exact.isPending) ? <LoadingState label={t("loading")}/> : null}
      {page.isError || targetMatches && exact.isError ? <Banner tone="error" action={<Button size="sm" onClick={() => { if (allowed()) { void page.refetch(); if (targetMatches) void exact.refetch(); } }}>{t("refresh")}</Button>}>
        <p>{t("readFailed")}</p><CommandFailureDetails failure={commandFailure(page.error ?? exact.error)}/></Banner> : null}
      {roles.isError ? <p>{t("memberReadFailed")}</p> : null}
      {!page.isPending && !page.isError && questions.length === 0 ? <p>{t(after === null ? "empty" : "pageEmpty")}</p> : null}
      {questions.map(view => {
        const author = view.question.author, member = author.kind === "member" ? roles.data?.roleVersions.find(role => role.request.memberId === author.author.memberId
          && role.request.roleVersionId === author.author.roleVersionId) : null;
        return <Question key={view.question.publication.postId} {...props} question={view}
          memberName={member?.request.displayName ?? null} memberRole={member?.request.role ?? null}
          fresh={!page.isError && (!targetMatches || !exact.isError)} allowed={allowed}/>;
      })}
      {page.data?.nextAfter ? <Button size="sm" disabled={!allowed() || page.isFetching} onClick={() => { if (allowed()) setAfter(page.data?.nextAfter ?? null); }}>{t("next")}</Button> : null}
      {after !== null ? <Button size="sm" disabled={!allowed()} onClick={() => { if (allowed()) setAfter(null); }}>{t("first")}</Button> : null}
      <Button size="sm" disabled={!allowed()} pending={page.isFetching} onClick={() => { if (allowed()) { void page.refetch(); void roles.refetch(); if (targetMatches) void exact.refetch(); } }}>{t("refresh")}</Button>
    </> : null}</div>
  </section>;
}
function Question({ owner, input, link, status, question, memberName, memberRole, target, visible, disabled, gate, viewId, parentDialogId, allowed, fresh }: Props & {
  question: TeamQuestionView; memberName: string | null; memberRole: string | null; allowed: () => boolean; fresh: boolean;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversationTeamQuestions" }), id = useId(), region = useRef<HTMLElement>(null);
  const post = question.question, postId = post.publication.postId, draft = owner.teamDraft(link.conversationId, link.planId)?.questions?.find(draft => draft.questionPostId === postId);
  const targetMatches = target?.conversationId === link.conversationId && target.planId === link.planId && target.questionPostId === postId;
  const focused = useRef<ConversationTeamQuestionTarget | null>(null), [editing, setEditing] = useState(false);
  const open = editing || !!draft, unit = status.plan.scope.find(unit => unit.unitId === post.publication.target.unitId);
  const event = post.publication.question, options = event?.kind === "open" ? event.options : [];
  const pending = input.value.pending, ownPending = pending?.kind === "team-question-response" && pending.request.response.questionPostId === postId;
  const editable = () => visible && !disabled && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const blocked = !fresh || !allowed() || !owner.canSendTeam(link.conversationId) || question.state !== "open";
  const bytes = draft?.mode === "choice" ? 0 : new TextEncoder().encode(draft?.body ?? "").length;
  const valid = !!draft && (draft.mode === "choice" ? options.some(option => option.optionId === draft.optionId) : !!draft.body.trim() && bytes <= 8192);
  const canDismiss = !!draft && new TextEncoder().encode(draft.dismissReason).length <= 8192;
  useLayoutEffect(() => {
    if (!visible || !targetMatches || !target?.focus || focused.current === target || !region.current) return;
    focused.current = target;
    if (!document.activeElement || document.activeElement === document.body || document.activeElement === target.origin) region.current.focus();
  }, [target, targetMatches, visible]);
  useEffect(() => { if (!visible) setEditing(false); }, [visible]);
  return <article ref={region} tabIndex={-1} className={styles.question} aria-label={t("questionTitle", { member: memberName ?? t("memberUnknown") })}>
    <h4>{memberName ?? t("memberUnknown")}</h4><p className={styles.text}>{post.publication.body}</p>
    <p>{t("target", { entry: unit?.nativeKey ?? t("entryUnknown"), locale: post.publication.target.locale })}</p>
    {memberRole ? <Disclosure title={<>{t("role")}</>}><p className={styles.text}>{memberRole}</p></Disclosure> : null}
    <p role="status">{t(question.state === "open" ? "waiting" : question.state === "resolved" ? "answered" : "dismissed")}</p>
    {question.response ? <p className={styles.text}>{question.response.publication.body || t("noReason")}</p> : null}
    {question.state === "open" ? <Button size="sm" aria-expanded={open} aria-controls={id} disabled={!editable()} onClick={() => {
      if (!editable()) return; if (!draft) owner.editTeamQuestion(link, postId, {}); setEditing(true);
    }}>{t("edit")}</Button> : null}
    <div id={id} hidden={!open}>{open ? <div className={styles.form}>
      {question.state !== "open" ? <Banner tone="warning">{t("closedDraft")}</Banner> : null}
      {options.length > 0 ? <fieldset className={styles.options}><legend>{t("choices")}</legend>
        {options.map(option => <label className={styles.choice} key={option.optionId}><TextInput className={styles.checkbox} type="radio" name={`${id}-answer`} checked={draft?.mode === "choice" && draft.optionId === option.optionId}
          disabled={!editable() || question.state !== "open"} onChange={() => { if (editable()) owner.editTeamQuestion(link, postId, { mode: "choice", optionId: option.optionId }); }}/><span>{option.label}</span></label>)}
        <label className={styles.choice}><TextInput className={styles.checkbox} type="radio" name={`${id}-answer`} checked={draft?.mode !== "choice"} disabled={!editable() || question.state !== "open"}
          onChange={() => { if (editable()) owner.editTeamQuestion(link, postId, { mode: "text" }); }}/><span>{t("ownText")}</span></label>
      </fieldset> : null}
      <Field label={t("body")} error={bytes > 8192 ? t("tooLong") : undefined}><TextArea value={draft?.body ?? ""} rows={4}
        readOnly={!editable() || question.state !== "open"} onChange={event => { if (editable()) owner.editTeamQuestion(link, postId, { mode: "text", body: event.target.value }); }}/></Field>
      <p>{t("shareHelp")}</p>
      <Button variant="primary" size="sm" disabled={blocked || !valid} onClick={() => { if (!blocked && draft) void owner.respondTeamQuestion(link, question, draft.editSeq, false, allowed); }}>{t("save")}</Button>
      <Disclosure title={<>{t("close")}</>}><p>{t("closeHelp")}</p><Field label={t("reason")}><TextArea value={draft?.dismissReason ?? ""}
        readOnly={!editable() || question.state !== "open"} onChange={event => { if (editable()) owner.editTeamQuestion(link, postId, { dismissReason: event.target.value }); }}/></Field>
        <Button size="sm" disabled={blocked || !canDismiss} onClick={() => { if (!blocked && draft) void owner.respondTeamQuestion(link, question, draft.editSeq, true, allowed); }}>{t("closeConfirm")}</Button>
      </Disclosure>
      <Button size="sm" disabled={!editable() || !!ownPending || !!input.busy} onClick={() => { if (editable()) { owner.discardTeamQuestion(link, postId); setEditing(false); } }}>{t("discard")}</Button>
      {ownPending ? <p role="status">{t("pending")}</p> : input.journalBusy || input.dirty ? <p role="status">{t("saving")}</p> : <p role="status">{t("kept")}</p>}
    </div> : null}</div>
  </article>;
}
