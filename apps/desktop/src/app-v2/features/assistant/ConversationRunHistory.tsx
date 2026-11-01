import type { OpenRunCandidateBatch } from "../candidates/runCandidateBatch";
import { Disclosure } from "../../../design-system/Disclosure";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import type { SessionRequest } from "../../../executionCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import type { WorkPlanHistoryBaseline, WorkPlanHistoryPage, WorkPlanHistoryRow, WorkPlanStatusView } from "../../../workPlanCommands";
import { Button } from "../../../design-system/Button";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { ConversationPlanLink } from "./conversationRun";
import type { OpenConversationRunCandidate } from "./conversationRunResultReads";
import type { OpenConversationTeamCandidate } from "./conversationTeamReads";
import { readConversationRunHistory, readConversationRunHistoryAttempt } from "./planHistoryReads";
import { ConversationRunResults } from "./ConversationRunResults";
import { ConversationTeamProgress } from "./ConversationTeamProgress";
import styles from "./ConversationRunHistory.module.css";

interface Props {
  context: SessionRequest; link: ConversationPlanLink; status: WorkPlanStatusView | null;
  visible: boolean; canRead: () => boolean;
  onOpenCandidate?: OpenConversationRunCandidate; onOpenCandidateBatch?: OpenRunCandidateBatch; onOpenTeamCandidate?: OpenConversationTeamCandidate;
}
interface Cursor { after: string; baseline: WorkPlanHistoryBaseline | null }
const states = { active: "active", paused: "paused", stopped: "stopped", "taken-over": "takenOver" } as const;
const commands = { pause: "pause", stop: "stop", "take-over": "takeOver", continue: "continue" } as const;
const effects = {
  "save-candidate": "runEffectSaveCandidate", "run-checks": "runEffectChecks", "select-missing": "runEffectSelectMissing",
  "replace-captured-selection": "runEffectReplaceSelection", "adopt-resources": "runEffectAdoptResources", deliver: "runEffectDeliver",
  "query-tools": "runEffectQueryTools", "publish-discussion": "runEffectPublishDiscussion", "dispatch-team-work": "runEffectTeamWork", "send-team-message": "runEffectTeamMessage",
} as const;

/** This disclosure owns observation and selection only. History never seeds a
 * ready run, execution consent, a draft, or a pending action. */
export function ConversationRunHistory(props: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversationRunHistory" }), id = useId();
  const identity = JSON.stringify([props.context, props.link]);
  const [openFor, setOpenFor] = useState<string | null>(null), expanded = openFor === identity;
  const trigger = useRef<HTMLButtonElement>(null), body = useRef<HTMLDivElement>(null);
  return <section className={styles.panel} hidden={!props.visible} aria-label={t("title")}>
    <Button ref={trigger} size="sm" aria-expanded={expanded} aria-controls={id} disabled={!props.visible || !props.canRead()} onClick={() => {
      if (!props.visible || !props.canRead()) return;
      if (expanded && body.current?.contains(document.activeElement)) trigger.current?.focus();
      setOpenFor(expanded ? null : identity);
    }}>{t(expanded ? "hide" : "show")}</Button>
    <div ref={body} id={id} hidden={!expanded}>{expanded && props.visible ? <HistoryRead key={identity} {...props} identity={identity}/> : null}</div>
  </section>;
}

function HistoryRead({ context, link, status, visible, canRead, onOpenCandidate, onOpenCandidateBatch, onOpenTeamCandidate, identity }: Props & { identity: string }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversationRunHistory" }), { t: global } = useTranslation(), reads = useSessionReads(), id = useId();
  const [cursor, setCursor] = useState<Cursor>({ after: "0", baseline: null }), [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null), region = useRef<HTMLElement>(null);
  const mounted = useRef(false), live = useRef({ identity, visible, canRead });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { live.current = { identity, visible, canRead }; });
  function present() {
    return mounted.current && live.current.identity === identity && live.current.visible && live.current.canRead() && !reads.retired
      && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken;
  }
  const key = ["conversation-run-history", link.conversationId, link.planId, identity, cursor, revision];
  const read = useSessionQuery({ key, scopes: ["project", "execution"], enabled: visible && canRead(), structuralSharing: false,
    read: async () => {
      if (!present()) throw new Error("History read is no longer current");
      const page = await readConversationRunHistory(context, link, cursor.after, cursor.baseline);
      if (!present()) throw new Error("History read is no longer current");
      return page;
    } });
  const page = !read.error ? read.data : null;
  const state = reads.client.getQueryState<WorkPlanHistoryPage>(reads.key(key));
  const fresh = present() && !!page && state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated && state.error === null && state.data === page;
  function focusForAction(origin: HTMLElement) { if (document.activeElement === origin) region.current?.focus(); }
  function first(origin: HTMLElement) {
    if (!present() || read.isFetching) return;
    focusForAction(origin); setSelected(null); setCursor({ after: "0", baseline: null }); setRevision(value => value + 1);
  }
  const failure = read.error ? commandFailure(read.error) : null;
  const changed = typeof failure === "string" ? ["dependency-conflict", "work-plan-history-changed"].includes(failure) : failure?.code === "dependency-conflict";
  return <section ref={region} tabIndex={-1} className={styles.body} aria-label={t("records")}>
    <p>{t("help")}</p>
    <div className={styles.actions}><Button size="sm" pending={read.isFetching} disabled={!present() || read.isFetching} onClick={event => first(event.currentTarget)}>{t("refresh")}</Button></div>
    {read.isPending ? <LoadingState label={t("loading")}/> : null}
    {read.error ? <Banner tone="error" role="alert"><p>{t(changed ? "changed" : "failed")}</p><CommandFailureDetails failure={failure}/>
      <Button size="sm" disabled={!present() || read.isFetching} onClick={event => first(event.currentTarget)}>{t("recover")}</Button>
    </Banner> : null}
    {page ? <>
      <p>{t("scope", { count: page.scope.length, locale: page.locale })}</p>
      <Disclosure title={<>{t("scopeDetails")}</>}><ul>{page.scope.map(unit => <li key={unit.unitId}><TokenizedText text={unit.nativeKey}/></li>)}</ul></Disclosure>
      <p>{t("pageCount", { count: page.rows.length })}</p>
      {!fresh ? <p role="status">{t("checking")}</p> : null}
      {page.rows.length === 0 ? <p>{t("empty")}</p> : <ol className={styles.rows}>{page.rows.map(row => {
        const action = row.action, input = row.input, selectedRow = selected === row.actionId;
        const label = action.kind === "authorize" ? t("authorize") : action.kind === "team-recovery" ? t("teamRecovery") : t(commands[action.command]);
        const target = action.kind === "team-recovery" ? page.scope.find(unit => unit.unitId === action.work.target.unitId) : null;
        return <li key={row.actionId}><article className={styles.row}>
          <h6>{t("entry", { generation: row.lease.generation, action: label })}</h6>
          <p>{t(states[row.state])}</p>
          {input ? <p>{t(row.start ? "started" : "startUnconfirmed")}</p> : null}
          {action.kind !== "control" ? <Disclosure title={<>{global("conversation.runEffects")}</>}><ul>{action.effects.map(effect =>
            <li key={effect}>{global(`conversation.${effects[effect]}`)}</li>)}</ul></Disclosure> : null}
          {action.kind === "team-recovery" ? <>
            <p>{t("recoveryBase", { generation: action.baseLease.generation, entry: target?.nativeKey ?? "", locale: action.work.target.locale })}</p>
            <p className={styles.text}><TokenizedText text={action.work.instructions}/></p>
            <ul>{action.members.map(member => <li key={member.memberId}><TokenizedText text={member.displayName}/>{" · "}<TokenizedText text={member.role}/>
              <p>{t("destination", { endpoint: member.config.endpoint, model: member.config.model })}</p>
              <p>{t("memberScope", { count: member.unitIds.length })}</p>
            </li>)}</ul>
          </> : null}
          <Disclosure title={<>{t("identity")}</>}><dl className={styles.identities}>
            <dt>{t("actionId")}</dt><dd>{row.actionId}</dd>
            {input ? <><dt>{t("taskId")}</dt><dd>{input.taskId}</dd><dt>{t("attemptId")}</dt><dd>{input.attemptId}</dd>
              {input.parentTask ? <><dt>{t("parentTask")}</dt><dd>{input.parentTask}</dd></> : null}</> : null}
          </dl></Disclosure>
          {row.start ? <Button size="sm" aria-expanded={selectedRow} aria-controls={`${id}-${row.actionId}`} disabled={!fresh} onClick={event => {
            if (!fresh) return; focusForAction(event.currentTarget); setSelected(selectedRow ? null : row.actionId);
          }}>{t(selectedRow ? "hideAttempt" : "showAttempt")}</Button> : null}
          <div id={`${id}-${row.actionId}`} hidden={!selectedRow}>{selectedRow && row.start ? <HistoryAttempt key={`${row.actionId}:${jsonIdentity(page.baseline)}`} context={context} link={link} page={page} row={row}
            visible={visible} canRead={() => present() && fresh} status={status} onOpenCandidate={onOpenCandidate} onOpenCandidateBatch={onOpenCandidateBatch} onOpenTeamCandidate={onOpenTeamCandidate}/> : null}</div>
        </article></li>;
      })}</ol>}
      {page.nextAfter ? <Button size="sm" disabled={!fresh} onClick={event => {
        if (!fresh || !page.nextAfter) return; focusForAction(event.currentTarget); setSelected(null);
        setCursor({ after: page.nextAfter, baseline: page.baseline });
      }}>{t("next")}</Button> : <p>{t("end")}</p>}
    </> : null}
  </section>;
}

function HistoryAttempt({ context, link, page, row, visible, canRead, status, onOpenCandidate, onOpenCandidateBatch, onOpenTeamCandidate }:
  Props & { page: WorkPlanHistoryPage; row: WorkPlanHistoryRow }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversationRunHistory" });
  const reads = useSessionReads(), [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0), mounted = useRef(false), region = useRef<HTMLElement>(null);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const present = () => mounted.current && visible && canRead() && !reads.retired;
  const read = useSessionQuery({ key: ["conversation-run-history-attempt", link.conversationId, link.planId, page.baseline, row, offset, refresh],
    scopes: ["project", "execution"], enabled: visible && canRead(), structuralSharing: false, read: async () => {
      if (!present()) throw new Error("History attempt is no longer current");
      const detail = await readConversationRunHistoryAttempt(context, link, page, row, offset);
      if (!present()) throw new Error("History attempt is no longer current");
      return detail;
    } });
  const detail = !read.error ? read.data : null;
  const plan = status?.plan, supported = plan?.planId === link.planId && plan.digest === link.planDigest;
  function keepFocus(origin: HTMLElement) { if (document.activeElement === origin) region.current?.focus(); }
  return <section ref={region} tabIndex={-1} className={styles.attempt} aria-label={t("attemptTitle")}>
    <p>{t("attemptHelp")}</p>
    {read.isPending ? <LoadingState label={t("attemptLoading")}/> : null}
    {read.error ? <Banner tone="error" role="alert"><p>{t("attemptFailed")}</p><CommandFailureDetails failure={commandFailure(read.error)}/></Banner> : null}
    <Button size="sm" pending={read.isFetching} disabled={!present() || read.isFetching} onClick={event => {
      if (present() && !read.isFetching) { keepFocus(event.currentTarget); setOffset(0); setRefresh(value => value + 1); }
    }}>{t("attemptRefresh")}</Button>
    {detail ? <>
      <p>{t("progress", { ...detail.progress })}</p>
      <p>{t("itemPage", { count: detail.items.length })}</p>
      <ul>{detail.items.map(item => <li key={item.status.itemId}><TokenizedText text={page.scope.find(unit => unit.unitId === item.scope.id)?.nativeKey ?? item.scope.id}/>{" · "}{t(`execution.${item.status.execution}`)}</li>)}</ul>
      {detail.nextOffset !== null ? <Button size="sm" disabled={!present() || read.isFetching} onClick={event => {
        if (present() && !read.isFetching && detail.nextOffset !== null) { keepFocus(event.currentTarget); setOffset(detail.nextOffset); }
      }}>{t("nextItems")}</Button> : null}
      {supported && plan?.options.teamExecution && status ? <>
        <p>{t("teamResultsHelp")}</p><ConversationTeamProgress context={context} link={link} status={status} visible={visible} canRead={present} onOpenCandidate={onOpenTeamCandidate}/>
      </> : supported && plan?.preview && !plan.options.mcpTermQuery && row.start ? <ConversationRunResults context={context} link={link} plan={plan} start={row.start}
        visible={visible} canRead={present} onOpenCandidate={onOpenCandidate} onOpenCandidateBatch={onOpenCandidateBatch}/> : null}
    </> : null}
  </section>;
}
