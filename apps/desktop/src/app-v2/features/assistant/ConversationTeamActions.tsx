import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { teamGuidanceActive } from "../../../TeamGuidanceSession";
import { teamPublicationActive } from "../../../TeamDiscussionSession";
import { CommandFailureDetails } from "../../../CommandFailure";
import { Button } from "../../../design-system/Button";
import { Field, TextArea } from "../../../design-system/Field";
import { Menu } from "../../../design-system/Menu";
import { Banner } from "../../../design-system/Feedback";
import { jsonIdentity } from "../../../pluginToolChoices";
import type { TeamExecutionView, WorkPlanStatusView } from "../../../workPlanCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ConversationInput, ConversationSession } from "./ConversationSession";
import type { ConversationPlanLink } from "./conversationRun";
import styles from "./ConversationTeamActions.module.css";

export interface ConversationTeamActionsProps {
  owner: ConversationSession; input: ConversationInput; link: ConversationPlanLink;
  status: WorkPlanStatusView; view: TeamExecutionView; current: () => boolean;
  visible: boolean; disabled: boolean; gate: InteractionGate; viewId: string | null;
  refresh: () => void;
}
export function ConversationTeamActions({ owner, input, link, status, view, current, visible, disabled, gate, viewId, refresh }: ConversationTeamActionsProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversationTeamActions" });
  const [open, setOpen] = useState(false), id = useId(), inputOwner = `team-input-${id}`;
  const binding = useMemo(() => jsonIdentity([link, status.lease, status.effects, status.expiresAt, view.effectiveVersion, view.roster]),
    [link, status.lease, status.effects, status.expiresAt, view.effectiveVersion, view.roster]);
  const live = useRef({ current, visible, disabled, open, binding });
  useLayoutEffect(() => { live.current = { current, visible, disabled, open, binding }; });
  useLayoutEffect(() => () => gate.releaseOwner(inputOwner), [gate, inputOwner]);
  const editable = () => live.current.visible && !live.current.disabled && !owner.getSnapshot().retired;
  const allowed = () => editable() && live.current.open && live.current.binding === binding && live.current.current();
  const saved = input.value.teamDrafts?.find(value => value.planId === link.planId), guidance = saved?.guidance, publication = saved?.publication;
  useLayoutEffect(() => { if (publication?.replyTo) setOpen(true); }, [publication?.replyTo]);
  const member = view.roster.find(value => value.memberId === guidance?.memberId);
  const guidanceUnit = status.plan.scope.find(value => value.unitId === guidance?.unitId && member?.unitIds.includes(value.unitId));
  const publicationUnit = status.plan.scope.find(value => value.unitId === publication?.unitId);
  const bodyProblem = (body: string, maximum: number) => !body.trim() ? body ? t("emptyBody") : undefined
    : new TextEncoder().encode(body).length > maximum ? t("bodyTooLong", { count: maximum }) : undefined;
  const guidanceProblem = bodyProblem(guidance?.body ?? "", view.messageLimits.maxBodyBytes);
  const publicationProblem = bodyProblem(publication?.body ?? "", status.plan.teamDiscussionLimits?.maxPostBytes ?? 0);
  const currentNow = open && visible && !disabled && !owner.getSnapshot().retired && current();
  const available = currentNow && owner.canSendTeam(link.conversationId);
  const guidanceReady = available && !!guidanceUnit && !!guidance?.body.trim() && !guidanceProblem && teamGuidanceActive(status, view);
  const publicationReady = available && !!publicationUnit && !!publication?.body.trim() && !publicationProblem && teamPublicationActive(status);
  const hasSpace = !!saved || (input.value.teamDrafts?.length ?? 0) < 32;
  function entryChoice(kind: "guidance" | "publication") {
    const selected = kind === "guidance" ? guidanceUnit : publicationUnit;
    const units = kind === "guidance" ? status.plan.scope.filter(unit => member?.unitIds.includes(unit.unitId)) : status.plan.scope;
    return <Menu label={t("chooseEntry")} trigger={<Button size="sm" disabled={!editable() || !hasSpace || units.length === 0}>
      {t("entryChoice", { entry: selected?.nativeKey ?? t("chooseEntry") })}
    </Button>} items={units.map(unit => ({ id: unit.unitId, label: unit.nativeKey, onSelect: () => {
      if (!editable()) return;
      if (kind === "guidance") owner.editTeamGuidance(link, { unitId: unit.unitId });
      else owner.editTeamPublication(link, { unitId: unit.unitId });
    } }))}/>;
  }
  return <section className={styles.panel} aria-label={t("title")} hidden={!visible}
    onFocusCapture={() => gate.setInputOwner(viewId, inputOwner)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputOwner); }}
    onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
    <Button size="sm" aria-expanded={open} aria-controls={id} disabled={!editable()} onClick={() => { if (editable()) setOpen(value => !value); }}>{t(open ? "hide" : "show")}</Button>
    {!open && (guidance?.body || publication?.body) ? <p role="status">{t("draftKept")}</p> : null}
    <div id={id} className={styles.body} hidden={!open}>
      <p>{t("localHelp")}</p>{!hasSpace ? <p role="status">{t("draftLimit")}</p> : null}
      {!input.value.pending && input.failure?.kind === "action" ? <Banner tone="warning" role="alert"><p>{t("prepareFailed")}</p><CommandFailureDetails failure={input.failure.cause}/>
        <Button size="sm" disabled={!editable() || !!input.busy || input.journalBusy} onClick={() => {
          if (editable() && owner.clearTeamPreparationFailure(link.conversationId)) refresh();
        }}>{t("recheck")}</Button></Banner> : null}
      <fieldset className={styles.body}><legend>{t("guidanceTitle")}</legend>
        <p>{t("guidanceHelp")}</p>
        {!teamGuidanceActive(status, view) ? <p role="status">{t("guidanceUnavailable")}</p> : null}
        <Menu label={t("chooseMember")} trigger={<Button size="sm" disabled={!editable() || !hasSpace}>
          {t("memberChoice", { member: member?.displayName ?? t("chooseMember") })}
        </Button>} items={view.roster.map(value => ({ id: value.memberId, label: value.displayName, onSelect: () => {
          if (editable()) owner.editTeamGuidance(link, { memberId: value.memberId, unitId: value.unitIds.includes(guidance?.unitId ?? "") ? guidance?.unitId ?? null : null });
        } }))}/>
        {entryChoice("guidance")}
        {member ? <div className={styles.preview}><p>{t("destination", { name: member.displayName, endpoint: member.config.endpoint, model: member.config.model })}</p><details><summary>{t("viewRole")}</summary><p className={styles.text}>{member.role}</p></details></div> : null}
        {guidanceUnit ? <p>{t("target", { entry: guidanceUnit.nativeKey, locale: status.plan.locale })}</p> : null}
        <Field label={t("guidanceBody")} error={guidanceProblem}><TextArea readOnly={!editable() || !hasSpace} value={guidance?.body ?? ""}
          onChange={event => { if (editable()) owner.editTeamGuidance(link, { body: event.target.value }); }}/></Field>
        <div className={styles.actions}><Button size="sm" variant="secondary" disabled={!guidanceReady} onClick={() => {
          if (guidanceReady && guidance && allowed()) void owner.sendTeamGuidance(link, status, view, guidance.editSeq, allowed);
        }}>{t("sendGuidance")}</Button><Button size="sm" disabled={!guidance || !!input.value.pending || !!input.busy || !editable()}
          onClick={() => { if (editable()) owner.discardTeamDraft(link, "guidance"); }}>{t("clearGuidance")}</Button></div>
      </fieldset>
      <fieldset className={styles.body}><legend>{t("discussionTitle")}</legend>
        <p>{t("discussionHelp")}</p>{!teamPublicationActive(status) ? <p role="status">{t("discussionUnavailable")}</p> : null}{entryChoice("publication")}
        {publicationUnit ? <p>{t("target", { entry: publicationUnit.nativeKey, locale: status.plan.locale })}</p> : null}
        {publication?.replyTo ? <><p>{t("replyKept")}</p><Button size="sm" disabled={!editable()} onClick={() => { if (editable()) owner.editTeamPublication(link, { replyTo: null }); }}>{t("removeReply")}</Button></> : null}
        <Field label={t("discussionBody")} error={publicationProblem}><TextArea readOnly={!editable() || !hasSpace} value={publication?.body ?? ""}
          onChange={event => { if (editable()) owner.editTeamPublication(link, { body: event.target.value }); }}/></Field>
        <div className={styles.actions}><Button size="sm" variant="secondary" disabled={!publicationReady} onClick={() => {
          if (publicationReady && publication && allowed()) void owner.publishTeamDiscussion(link, status, publication.editSeq, allowed);
        }}>{t("publishDiscussion")}</Button><Button size="sm" disabled={!publication || !!input.value.pending || !!input.busy || !editable()}
          onClick={() => { if (editable()) owner.discardTeamDraft(link, "publication"); }}>{t("clearDiscussion")}</Button></div>
      </fieldset>
      {!currentNow ? <p role="status">{t("refreshFirst")}</p> : !owner.canSendTeam(link.conversationId) && input.failure?.kind !== "action" ? <p role="status">{t("pendingHelp")}</p> : null}
    </div>
  </section>;
}
