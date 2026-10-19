import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import { AiPreviewItems } from "./AiPreviewItems";
import { TeamDiscussionDisclosure } from "./TeamDiscussionDisclosure";
import type { TeamWorkReference } from "./generated/ai.requests";
import type { TeamRecoveryPreviewView } from "./generated/ai.responses";
import type { WorkPlanView } from "./workPlanCommands";

/** Render Core's new destination capture; old model consent is never reused. */
export function TeamRecoveryDisclosure({ plan, preview, unresolvedWork, onOpenTask }: { plan: WorkPlanView; preview: TeamRecoveryPreviewView; unresolvedWork: readonly TeamWorkReference[]; onOpenTask?: (taskId: string, attemptId: string) => Promise<boolean> }) {
  const { t } = useTranslation(), names = new Map(plan.scope.map(unit => [unit.unitId, unit.nativeKey]));
  return <section aria-label={t("ai.recovery.previewTitle")}><h4>{t("ai.recovery.previewTitle")}</h4>
    <p>{t("ai.recovery.previewHelp")}</p><p>{t("ai.team.sharedBudget")}</p>
    <p>{t("ai.team.capturedLimits", { activations: String(preview.limits.maxActivations), concurrency: String(preview.limits.maxConcurrency), noProgress: String(preview.limits.maxNoProgress) })}</p>
    <p>{t("ai.team.completionLimitHelp")}</p>
    <p>{t("ai.recovery.counters", { activations: String(preview.activations), completions: String(preview.unconfirmedCompletions) })}</p>
    <p>{t("ai.budgetSummary", { ...preview.budget, defaultValue: enUS.ai.budgetSummary })}</p><p>{t("ai.budgetUsage", { ...preview.budget, defaultValue: enUS.ai.budgetUsage })}</p>
    <p>{t("ai.recovery.workSummary", { member: preview.members.find(member => member.memberId === preview.work.memberId)?.displayName ?? "",
      entry: names.get(preview.work.target.unitId) ?? "", locale: preview.work.target.locale, kind: t(`ai.team.workKinds.${preview.work.kind}`) })}</p>
    <pre className="ai-text">{preview.work.instructions}</pre>
    {unresolvedWork.length ? <div><p role="status">{t("ai.recovery.unresolvedTitle", { count: unresolvedWork.length })}</p><p>{t("ai.recovery.unresolvedHelp")}</p>
      {unresolvedWork.map((reference, index) => <div key={reference.attemptId}><p>{t("ai.recovery.unresolvedItem", { number: String(index + 1) })}</p>
        {onOpenTask ? <button type="button" className="secondary-button" onClick={() => { void onOpenTask(reference.taskId, reference.attemptId); }}>{t("ai.team.openTask")}</button> : null}
      </div>)}
    </div> : null}
    <p>{t("ai.recovery.retiredCount", { count: preview.retiredMemberIds.length })}</p>
    <TeamDiscussionDisclosure plan={plan} destinations={preview.members.map(member => ({ name: member.displayName, endpoint: member.config.endpoint, model: member.config.model }))}/>
    {preview.members.map(member => {
      const input = preview.memberPreviews.find(value => value.memberId === member.memberId)!;
      return <section key={member.memberId} aria-label={member.displayName}><h5>{member.displayName}</h5><pre className="ai-text">{member.role}</pre>
        <p>{t("ai.discussions.destination", { endpoint: member.config.endpoint, model: member.config.model })}</p>
        <p>{t("ai.team.capturedMemberLimits", { requests: String(member.config.maxRequests), tokens: String(member.config.maxOutputTokens), timeout: String(member.config.timeoutSeconds), retries: String(member.config.maxRetries) })}</p>
        <p>{t("ai.team.allowedKinds", { kinds: member.kinds.map(kind => t(`ai.team.workKinds.${kind}`)).join(", ") })}</p>
        <p>{t("ai.team.allowedEntries", { entries: member.unitIds.map(id => names.get(id) ?? "").join(", ") })}</p>
        <AiPreviewItems items={input.preview.items}/>
        <h6>{t("ai.recovery.existingDiscussions")}</h6>
        {preview.discussionPreviews.filter(value => value.memberId === member.memberId).map(view => <article key={view.target.unitId}>
          <p>{names.get(view.target.unitId)} · {view.target.locale}</p>
          {view.posts.length ? view.posts.map(post => <article key={post.publication.postId}><pre className="ai-text">{post.publication.body}</pre>
            <details><summary>{t("ai.team.identityDetails")}</summary><pre className="ai-text">{JSON.stringify({ postId: post.publication.postId, author: post.author,
              replyTo: post.publication.replyTo, supersedes: post.publication.supersedes, references: post.publication.references }, null, 2)}</pre></details>
          </article>) : <p>{t("ai.recovery.noExistingDiscussions")}</p>}
          {view.artifacts.length ? <><h6>{t("ai.recovery.existingArtifacts")}</h6>{view.artifacts.map(artifact => <article key={`${artifact.postId}:${artifact.referenceIndex}`}>
            <pre className="ai-text">{artifact.artifact.text}</pre><details><summary>{t("ai.teamHistory.references")}</summary>
              <pre className="ai-text">{JSON.stringify({ postId: artifact.postId, referenceIndex: artifact.referenceIndex, target: artifact.target,
                artifact: artifact.artifact.kind === "translation-revision" ? { kind: artifact.artifact.kind, revisionId: artifact.artifact.revisionId }
                  : { kind: artifact.artifact.kind, snapshotId: artifact.artifact.snapshotId, attemptId: artifact.artifact.attemptId, resultId: artifact.artifact.resultId, occurrenceId: artifact.artifact.occurrenceId, nativeKey: artifact.artifact.nativeKey } }, null, 2)}</pre>
            </details></article>)}</> : null}
        </article>)}
      </section>;
    })}
    <details><summary>{t("ai.recovery.selectedWorkDetails")}</summary><pre className="ai-text">{JSON.stringify({ postIds: preview.work.postIds, priorWork: preview.work.priorWork }, null, 2)}</pre></details>
  </section>;
}
