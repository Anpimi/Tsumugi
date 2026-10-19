import { useEffect, useLayoutEffect, useRef, useState, useId } from "react";
import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import { useSessionQuery } from "./SessionReadProvider";
import type { SessionRequest } from "./executionCommands";
import { jsonIdentity } from "./pluginToolChoices";
import { workPlanCommands, type WorkPlanStatusView, type TeamDiscussionPost, type TeamMemberRole } from "./workPlanCommands";
import { teamPublicationActive, originalTeamPublicationClosed, type TeamDiscussionSession } from "./TeamDiscussionSession";
import { useWorkbenchCommands, type AiTeamDiscussionCommandPayload, type CommandAvailability } from "./workbenchCommands";

export function TeamDiscussionHistory({ context, status, open, writable, session }: {
  context: SessionRequest; status: WorkPlanStatusView; open: boolean; writable: boolean; session: TeamDiscussionSession;
}) {
  const { t } = useTranslation(), registry = useWorkbenchCommands(), errorRef = useRef<HTMLDivElement>(null);
  const [deadlineTick, setDeadlineTick] = useState(0), bodyHelpId = useId();
  useEffect(() => {
    if (!open) return;
    const remaining = BigInt(status.expiresAt) * 1000n - BigInt(Date.now()) + 1n;
    if (remaining <= 0n) return;
    const timer = window.setTimeout(() => setDeadlineTick(value => value + 1), Number(remaining > 2147483647n ? 2147483647n : remaining));
    return () => window.clearTimeout(timer);
  }, [open, status.expiresAt, deadlineTick]);
  const planId = status.plan.planId, state = session.current(planId), { draft, pending } = state;
  const history = useSessionQuery({ key: ["team-history", planId, state.after], scopes: ["execution", "source", "translation", "project"], enabled: open,
    read: () => workPlanCommands.teamHistory({ ...context, planId, after: state.after, limit: 16 }) });
  const focused = useSessionQuery({ key: ["team-post", planId, state.focusedPost], scopes: ["execution", "source", "translation", "project"], enabled: open && !!state.focusedPost,
    read: async () => {
      const post = await workPlanCommands.teamPost({ ...context, planId, postId: state.focusedPost! });
      const sequence = BigInt(post.sequence), after = sequence > 1n ? (sequence - 1n).toString() : null;
      const page = await workPlanCommands.teamHistory({ ...context, planId, after, limit: 16 });
      if (!page.posts.some(value => jsonIdentity(value) === jsonIdentity(post))) throw new Error("Original team post changed");
      return { post, roles: page.authorRoles };
    } });
  const page = !history.error ? history.data : null;
  const failure = state.failure ?? (history.error ? commandFailure(history.error) : focused.error ? commandFailure(focused.error) : null);
  useEffect(() => { if (open && failure) errorRef.current?.focus(); }, [open, failure, planId]);
  const active = writable && teamPublicationActive(status), posting = state.creating || pending?.phase === "publishing" || pending?.phase === "checking";
  const targetId = draft.unitId || status.plan.scope[0]?.unitId || "";
  const tooLarge = !!status.plan.teamDiscussionLimits && new TextEncoder().encode(draft.body).length > status.plan.teamDiscussionLimits.maxPostBytes;
  const validDraft = !!draft.body.trim() && !!status.plan.teamDiscussionLimits && !tooLarge
    && status.plan.scope.some(unit => unit.unitId === targetId);
  const scope = { projectId: context.projectId, sessionToken: context.sessionToken, area: "ai" as const };
  const draftPayload = (): AiTeamDiscussionCommandPayload => ({ kind: "ai-team-discussion", planId, generation: status.lease.generation, editSeq: draft.editSeq, postId: null });
  const pendingPayload = (): AiTeamDiscussionCommandPayload | undefined => pending ? { kind: "ai-team-discussion", planId,
    generation: pending.request.lease.generation, editSeq: pending.editSeq, postId: pending.request.publication.postId } : undefined;
  const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
  function publishAvailable(value?: AiTeamDiscussionCommandPayload): CommandAvailability {
    return open && active && validDraft && !pending && !state.creating && jsonIdentity(value) === jsonIdentity(draftPayload()) ? { enabled: true } : unavailable;
  }
  function checkAvailable(value?: AiTeamDiscussionCommandPayload): CommandAvailability {
    return open && pending?.phase === "unknown" && jsonIdentity(value) === jsonIdentity(pendingPayload()) ? { enabled: true } : unavailable;
  }
  function retryAvailable(value?: AiTeamDiscussionCommandPayload): CommandAvailability {
    return checkAvailable(value).enabled && active && pending?.retryAllowed
      && jsonIdentity(pending.request.lease) === jsonIdentity(status.lease) ? { enabled: true } : unavailable;
  }
  function endAvailable(value?: AiTeamDiscussionCommandPayload): CommandAvailability {
    return checkAvailable(value).enabled && pending?.retryAllowed && originalTeamPublicationClosed(status, pending.request) ? { enabled: true } : unavailable;
  }
  useLayoutEffect(() => {
    const metadata = { category: "ai" as const, scope, binding: null, confirmation: "none" as const };
    const remove = [registry.register({ ...metadata, id: "ai.team.publish", nameKey: "ai.teamHistory.publish", risk: "writes-execution", payloadKind: "ai-team-discussion",
      availability: publishAvailable, handler: value => { void session.publish(status, writable, value.editSeq); } }),
    registry.register({ ...metadata, id: "ai.team.check", nameKey: "ai.teamHistory.checkOriginal", risk: "reads-execution", payloadKind: "ai-team-discussion",
      availability: checkAvailable, handler: () => { void session.check(planId); } }),
    registry.register({ ...metadata, id: "ai.team.retry", nameKey: "ai.teamHistory.retryOriginal", risk: "retries-execution-action", payloadKind: "ai-team-discussion",
      availability: retryAvailable, handler: () => { void session.retry(status, writable); } }),
    registry.register({ ...metadata, id: "ai.team.end-retry", nameKey: "ai.teamHistory.endRetry", risk: "reads-execution", payloadKind: "ai-team-discussion",
      availability: endAvailable, handler: () => { session.endRetry(status); } })];
    return () => remove.forEach(dispose => dispose());
  });
  const targetName = (post: TeamDiscussionPost) => `${status.plan.scope.find(unit => unit.unitId === post.publication.target.unitId)?.nativeKey ?? t("ai.teamHistory.savedEntry")} · ${post.publication.target.locale}`;
  function reply(post: TeamDiscussionPost) { session.edit(planId, { unitId: post.publication.target.unitId, replyTo: post.publication.postId }); }
  function postCard(post: TeamDiscussionPost, roles: TeamMemberRole[]) {
    const author = post.author, role = author.kind === "member" ? roles.find(value => value.request.memberId === author.author.memberId && value.request.roleVersionId === author.author.roleVersionId) : null;
    const replyTo = post.publication.replyTo, supersedes = post.publication.supersedes;
    return <article key={post.publication.postId}>
      <h4>{targetName(post)}</h4>
      <p>{author.kind === "human" ? t("ai.teamHistory.localUser") : role?.request.displayName}</p>
      {role ? <details><summary>{t("ai.teamHistory.roleAtPublication")}</summary><pre className="ai-text">{role.request.role}</pre><p>{role.request.roleVersionId}</p></details> : null}
      <p>{t(`ai.teamHistory.kinds.${post.publication.kind}`)}</p><pre className="ai-text">{post.publication.body}</pre>
      <div className="execution-actions">
        {replyTo ? <button type="button" className="secondary-button" onClick={() => session.focusPost(planId, replyTo)}>{t("ai.teamHistory.readReply")}</button> : null}
        {supersedes ? <button type="button" className="secondary-button" onClick={() => session.focusPost(planId, supersedes)}>{t("ai.teamHistory.readSuperseded")}</button> : null}
        {status.plan.options.teamDiscussions ? <button type="button" className="secondary-button" onClick={() => reply(post)}>{t("ai.teamHistory.reply")}</button> : null}
      </div>
      {post.publication.references.length ? <details><summary>{t("ai.teamHistory.references")}</summary>
        <p>{t("ai.teamHistory.referenceHelp")}</p><ul>{post.publication.references.map((reference, index) => <li key={index}>
          {reference.kind === "translation-revision" ? <>{t("ai.teamHistory.translationVersion")} <code>{reference.revisionId}</code></>
            : <>{t("ai.teamHistory.sourceVersion")}<dl><dt>{t("ai.teamHistory.snapshot")}</dt><dd>{reference.snapshotId}</dd><dt>{t("ai.teamHistory.attempt")}</dt><dd>{reference.attemptId}</dd><dt>{t("ai.teamHistory.result")}</dt><dd>{reference.resultId}</dd></dl></>}
        </li>)}</ul></details> : null}
    </article>;
  }
  return <section aria-label={t("ai.teamHistory.title")}>
    <h3>{t("ai.teamHistory.title")}</h3><p>{t("ai.teamHistory.readHelp")}</p>
    <button type="button" className="secondary-button" disabled={history.isFetching} onClick={() => { void history.refetch(); if (state.focusedPost) void focused.refetch(); }}>{t("ai.teamHistory.refresh")}</button>
    {history.isFetching ? <p role="status">{t("ai.teamHistory.loading")}</p> : null}
    {failure ? <div role="alert" tabIndex={-1} ref={errorRef}><p>{t("ai.teamHistory.failed")}</p><CommandFailureDetails failure={failure}/></div> : null}
    {!status.plan.options.teamDiscussions ? <p>{t("ai.teamHistory.disabled")}</p> : null}
    {page ? <>
      <h4>{t("ai.teamHistory.members")}</h4>
      {page.members.length ? <ul>{page.members.map(role => <li key={role.request.memberId}><strong>{role.request.displayName}</strong><pre className="ai-text">{role.request.role}</pre></li>)}</ul> : <p>{t("ai.teamHistory.noMembers")}</p>}
      <h4>{t("ai.teamHistory.posts")}</h4>
      {page.posts.length ? page.posts.map(post => postCard(post, page.authorRoles)) : <p>{t("ai.teamHistory.noPosts")}</p>}
      <div className="execution-actions"><button type="button" className="secondary-button" disabled={state.after === null || history.isFetching} onClick={() => session.page(planId, null)}>{t("ai.teamHistory.firstPage")}</button>
        <button type="button" className="secondary-button" disabled={!page.nextAfter || history.isFetching} onClick={() => session.page(planId, page.nextAfter)}>{t("ai.teamHistory.nextPage")}</button></div>
    </> : null}
    {state.focusedPost ? <section aria-label={t("ai.teamHistory.originalPost")}><h4>{t("ai.teamHistory.originalPost")}</h4><button type="button" className="secondary-button" onClick={() => session.focusPost(planId, null)}>{t("ai.teamHistory.closeOriginal")}</button>
      {focused.isFetching ? <p role="status">{t("ai.teamHistory.loading")}</p> : !focused.error && focused.data ? postCard(focused.data.post, focused.data.roles) : null}</section> : null}
    {status.plan.options.teamDiscussions ? <form onSubmit={event => { event.preventDefault(); registry.dispatch("ai.team.publish", scope, draftPayload()); }}>
      <h4>{t("ai.teamHistory.write")}</h4><p>{t("ai.teamHistory.writeHelp")}</p>
      {!active ? <p role="status">{t("ai.teamHistory.unavailable")}</p> : null}
      <label className="field">{t("ai.teamHistory.target")}<select value={targetId} onChange={event => session.edit(planId, { unitId: event.target.value, replyTo: null })}>
        {status.plan.scope.map(unit => <option key={unit.unitId} value={unit.unitId}>{unit.nativeKey} · {status.plan.locale}</option>)}</select></label>
      {draft.replyTo ? <p>{t("ai.teamHistory.replying")} <button type="button" className="secondary-button" onClick={() => session.edit(planId, { replyTo: null })}>{t("ai.teamHistory.cancelReply")}</button></p> : null}
      <label className="field">{t("ai.teamHistory.body")}<textarea value={draft.body} aria-invalid={tooLarge || undefined} aria-describedby={bodyHelpId} onChange={event => session.edit(planId, { body: event.target.value })}/></label>
      <p id={bodyHelpId}>{tooLarge ? t("ai.teamHistory.bodyTooLarge") : t("ai.teamHistory.bodyLimit", { defaultValue: enUS.ai.teamHistory.bodyLimit, bytes: status.plan.teamDiscussionLimits!.maxPostBytes })}</p>
      <button type="submit" className="primary-button" disabled={!publishAvailable(draftPayload()).enabled}>{t("ai.teamHistory.publish")}</button>
    </form> : null}
    {posting ? <p role="status">{t("ai.teamHistory.pending")}</p> : null}
    {pending?.phase === "unknown" ? <div><p role="status">{t("ai.teamHistory.unknown")}</p>
      <details><summary>{t("ai.teamHistory.originalRequest")}</summary><p>{status.plan.scope.find(unit => unit.unitId === pending.request.publication.target.unitId)?.nativeKey} · {pending.request.publication.target.locale}</p><pre className="ai-text">{pending.request.publication.body}</pre></details>
      <button type="button" className="secondary-button" disabled={!checkAvailable(pendingPayload()).enabled} onClick={() => { const payload = pendingPayload(); if (payload) registry.dispatch("ai.team.check", scope, payload); }}>{t("ai.teamHistory.checkOriginal")}</button>
      <button type="button" className="secondary-button" disabled={!retryAvailable(pendingPayload()).enabled} onClick={() => { const payload = pendingPayload(); if (payload) registry.dispatch("ai.team.retry", scope, payload); }}>{t("ai.teamHistory.retryOriginal")}</button>
      {endAvailable(pendingPayload()).enabled ? <><p>{t("ai.teamHistory.endRetryHelp")}</p><button type="button" className="secondary-button" onClick={() => { const payload = pendingPayload(); if (payload) registry.dispatch("ai.team.end-retry", scope, payload); }}>{t("ai.teamHistory.endRetry")}</button></> : null}
    </div> : null}
    {state.notice ? <p role="status">{t(state.notice === "recorded" ? "ai.teamHistory.recorded" : state.notice === "ended" ? "ai.teamHistory.retryEnded" : "ai.teamHistory.absent")}</p> : null}
    {state.lastPostId ? <button type="button" className="secondary-button" onClick={() => session.focusPost(planId, state.lastPostId)}>{t("ai.teamHistory.viewRecorded")}</button> : null}
  </section>;
}
