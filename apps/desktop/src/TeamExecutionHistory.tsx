import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import { useSessionQuery } from "./SessionReadProvider";
import type { SessionRequest } from "./executionCommands";
import { workPlanCommands, type WorkPlanStatusView } from "./workPlanCommands";

/** Read the original team facts; this pane never runs or adopts a model output. */
export function TeamExecutionHistory({ context, status, open, onOpenTask, onReadPost }: {
  context: SessionRequest; status: WorkPlanStatusView; open: boolean;
  onOpenTask?: (taskId: string, attemptId: string) => Promise<boolean>; onReadPost: (postId: string) => void;
}) {
  const { t } = useTranslation(), errorRef = useRef<HTMLDivElement>(null), [afterWork, setAfterWork] = useState<string | null>(null), [afterMessage, setAfterMessage] = useState<string | null>(null);
  const planId = status.plan.planId, policy = status.plan.options.teamExecution;
  const read = useSessionQuery({ key: ["team-execution", planId, afterWork, afterMessage], scopes: ["execution", "source", "translation", "project"], enabled: open && !!policy,
    read: () => workPlanCommands.teamExecution({ ...context, planId, afterWork, afterMessage, limit: 16 }) });
  const view = !read.error ? read.data : null;
  useEffect(() => { if (open && read.error) errorRef.current?.focus(); }, [open, read.error]);
  const memberName = (id: string) => policy?.members.find(member => member.memberId === id)?.displayName ?? view?.members.find(member => member.request.memberId === id)?.request.displayName ?? t("ai.team.recordedMember");
  const entryName = (id: string) => status.plan.scope.find(unit => unit.unitId === id)?.nativeKey ?? t("ai.teamHistory.savedEntry");
  const postButtons = (ids: readonly string[]) => ids.map(postId => <button type="button" className="secondary-button" key={postId} onClick={() => onReadPost(postId)}>{t("ai.team.readReason")}</button>);
  if (!policy) return null;
  return <section aria-label={t("ai.team.executionTitle")}>
    <h3>{t("ai.team.executionTitle")}</h3><p>{t("ai.team.executionHelp")}</p>
    <button type="button" className="secondary-button" disabled={read.isFetching} onClick={() => { void read.refetch(); }}>{t("ai.team.refresh")}</button>
    {read.isFetching ? <p role="status">{t("ai.team.loading")}</p> : null}
    {read.error ? <div role="alert" tabIndex={-1} ref={errorRef}><p>{t("ai.team.readFailed")}</p><CommandFailureDetails failure={commandFailure(read.error)}/></div> : null}
    {view ? <>
      <h4>{t("ai.teamHistory.members")}</h4><ul>{view.members.map(member => <li key={member.request.memberId}><strong>{member.request.displayName}</strong><pre className="ai-text">{member.request.role}</pre><p>{member.config.endpoint} · {member.config.model}</p></li>)}</ul>
      {view.stopReason ? <p role="status">{t(`ai.team.stops.${view.stopReason}`)}</p> : null}
      {view.budget ? <><p>{t("ai.budgetSummary", { ...view.budget, defaultValue: enUS.ai.budgetSummary })}</p><p>{t("ai.budgetUsage", { ...view.budget, defaultValue: enUS.ai.budgetUsage })}</p>
        {view.budget.legacyHeld > 0 ? <p>{t("ai.legacyBudget", { count: view.budget.legacyHeld, defaultValue: enUS.ai.legacyBudget })}</p> : null}</> : <p>{t("ai.team.noBudget")}</p>}
      <h4>{t("ai.team.works")}</h4>
      {view.works.length ? view.works.map(work => {
        const target = work.target, outcome = work.validation === "valid" ? work.output?.outcome : null;
        return <article key={work.receipt.intentId}>
          <h5>{memberName(work.receipt.memberId)} · {entryName(target.unitId)} · {target.locale}</h5>
          <p>{t(`ai.team.workKinds.${work.request?.kind ?? "translation"}`)} · {t(`ai.states.${work.execution}`)}</p>
          <p>{t(`ai.team.validation.${work.validation}`)}</p>
          {work.author ? <p>{t("ai.team.requestedBy", { member: memberName(work.author.memberId) })}</p> : null}
          {work.request ? <pre className="ai-text">{work.request.instructions}</pre> : <p>{t("ai.team.initialWork")}</p>}
          {outcome?.kind === "translation" ? <><p>{t(work.candidateRevisionId ? "ai.team.candidateSaved" : "ai.team.translationSuggestion")}</p><pre className="ai-text">{outcome.text}</pre></> : null}
          {outcome?.kind === "review" ? <><p>{t(`ai.team.verdicts.${outcome.verdict}`)}</p>{postButtons(outcome.postIds)}</> : null}
          {outcome?.kind === "evidence" ? <><p>{t("ai.team.evidence")}</p>{postButtons(outcome.postIds)}</> : null}
          {outcome?.kind === "waiting" ? <p>{t("ai.team.waiting", { count: outcome.requestedIntentIds.length })}</p> : null}
          {work.output ? <p>{work.output.usage ? t("ai.usage", { ...work.output.usage, defaultValue: enUS.ai.usage }) : t("ai.usageUnknown")}{work.output.usage && work.output.usageIncomplete ? ` · ${t("ai.usageUnknown")}` : ""}</p> : null}
          {onOpenTask ? <button type="button" className="secondary-button" onClick={() => { void onOpenTask(work.receipt.taskId, work.receipt.attemptId); }}>{t("ai.team.openTask")}</button> : null}
          <details><summary>{t("ai.team.identityDetails")}</summary><p>{work.receipt.intentId}</p><p>{work.receipt.roleVersionId}</p><p>{work.receipt.taskId}</p><p>{work.receipt.attemptId}</p>
            {work.author ? <p>{work.author.memberId} · {work.author.roleVersionId}</p> : null}
            {work.candidateRevisionId ? <p>{t("ai.team.candidateRevision", { revision: work.candidateRevisionId })}</p> : null}
            {work.request?.causeMessageId ? <p>{work.request.causeMessageId}</p> : null}
            {outcome?.kind === "waiting" ? <ul>{outcome.requestedIntentIds.map(id => <li key={id}>{id}</li>)}</ul> : null}
            {outcome?.kind === "review" ? <pre className="ai-text">{JSON.stringify(outcome.reviewed, null, 2)}</pre> : null}
          </details>
        </article>;
      }) : <p>{t("ai.team.noWork")}</p>}
      <h4>{t("ai.team.messages")}</h4>
      {view.messages.length ? view.messages.map(message => {
        const included = view.consumptions.filter(value => value.messageId === message.messageId);
        return <article key={message.messageId}><h5>{memberName(message.sender.memberId)} → {memberName(message.recipientMemberId)}</h5>
          <p>{entryName(message.target.unitId)} · {message.target.locale}</p><pre className="ai-text">{message.body}</pre>
          <p>{t(included.length ? "ai.team.included" : "ai.team.addressed", { count: included.length })}</p>{postButtons(message.postIds)}
          <details><summary>{t("ai.team.identityDetails")}</summary><p>{message.messageId}</p>{message.causeMessageId ? <p>{message.causeMessageId}</p> : null}
            {included.map(value => <p key={value.providerRequestId}>{value.taskId} · {value.providerRequestId}</p>)}
          </details>
        </article>;
      }) : <p>{t("ai.team.noMessages")}</p>}
      <div className="execution-actions"><button type="button" className="secondary-button" disabled={read.isFetching || afterWork === null && afterMessage === null} onClick={() => { setAfterWork(null); setAfterMessage(null); }}>{t("ai.team.firstPage")}</button>
        <button type="button" className="secondary-button" disabled={read.isFetching || !view.nextWorkAfter} onClick={() => setAfterWork(view.nextWorkAfter)}>{t("ai.team.nextWorks")}</button>
        <button type="button" className="secondary-button" disabled={read.isFetching || !view.nextMessageAfter} onClick={() => setAfterMessage(view.nextMessageAfter)}>{t("ai.team.nextMessages")}</button></div>
    </> : null}
  </section>;
}
