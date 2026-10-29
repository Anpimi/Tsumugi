import { Disclosure } from "../../../design-system/Disclosure";
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AiOutputUsage } from "../../../AiUsage";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "../../../CommandFailure";
import type { SessionRequest } from "../../../executionCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { workPlanCommands, type TeamDiscussionPost, type TeamExecutionView, type TeamMemberRole, type TeamWorkReference, type WorkPlanStatusView } from "../../../workPlanCommands";
import { Button } from "../../../design-system/Button";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { ConversationPlanLink } from "./conversationRun";
import { conversationTeamCandidateTarget, readConversationTeamExecution, readConversationTeamHistory, readConversationTeamPost, type OpenConversationTeamCandidate } from "./conversationTeamReads";
import styles from "./ConversationTeamProgress.module.css";

export interface ConversationTeamProgressProps {
  context: SessionRequest; link: ConversationPlanLink; status: WorkPlanStatusView;
  visible: boolean; canRead: () => boolean; onOpenCandidate?: OpenConversationTeamCandidate;
  actions?: (view: TeamExecutionView, current: () => boolean) => ReactNode;
  onReply?: (post: TeamDiscussionPost) => void;
}
type Work = TeamExecutionView["works"][number];
type Cursor = { frame: string; value: string | null };
const cursorFor = (cursor: Cursor | null, frame: string) => cursor?.frame === frame ? cursor.value : null;

function ReadFailure({ label, error }: { label: string; error: unknown }) {
  return <Banner tone="warning" role="alert"><p>{label}</p><CommandFailureDetails failure={commandFailure(error)}/></Banner>;
}
function PostCard({ post, roles, status, allowed, openPost, onReply }: {
  post: TeamDiscussionPost; roles: readonly TeamMemberRole[]; status: WorkPlanStatusView; allowed: boolean;
  openPost: (postId: string, origin: HTMLButtonElement) => void;
  onReply?: (post: TeamDiscussionPost) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversationTeam" });
  const author = post.author;
  const role = author.kind === "member" ? roles.find(value => value.request.memberId === author.author.memberId && value.request.roleVersionId === author.author.roleVersionId) : null;
  const target = post.publication.target, entry = status.plan.scope.find(unit => unit.unitId === target.unitId)?.nativeKey ?? t("entryUnknown");
  return <article className={styles.post} aria-label={t("target", { entry, locale: target.locale })}>
    <h5>{author.kind !== "member" ? t("localUser") : role?.request.displayName ?? t("memberUnknown")} · {t(`postKind.${post.publication.kind}`)}</h5>
    <p className={styles.meta}>{t("target", { entry, locale: target.locale })}</p><p className={styles.text}>{post.publication.body}</p>
    <div className={styles.actions}>
      {onReply ? <Button size="sm" disabled={!allowed} onClick={() => { if (allowed) onReply(post); }}>{t("reply")}</Button> : null}
      {post.publication.replyTo ? <Button size="sm" disabled={!allowed} onClick={event => { if (allowed && post.publication.replyTo) openPost(post.publication.replyTo, event.currentTarget); }}>{t("readReply")}</Button> : null}
      {post.publication.supersedes ? <Button size="sm" disabled={!allowed} onClick={event => { if (allowed && post.publication.supersedes) openPost(post.publication.supersedes, event.currentTarget); }}>{t("readSuperseded")}</Button> : null}
    </div>
    {role ? <Disclosure title={<>{t("memberRole")}</>}><p className={styles.text}>{role.request.role}</p><p>{t("model")}: {role.config.model}</p><p>{t("roleVersion")}: <code>{role.request.roleVersionId}</code></p></Disclosure> : null}
    {post.publication.references.length ? <Disclosure title={<>{t("postReferences")}</>}><ul>{post.publication.references.map((reference, index) => <li key={index}><code>{reference.kind === "translation-revision" ? reference.revisionId : reference.resultId}</code></li>)}</ul></Disclosure> : null}
  </article>;
}

/** The original work owns each tool reference; expanding it never runs a tool. */
function ToolReferences({ context, status, work, frame, visible, current }: {
  context: SessionRequest; status: WorkPlanStatusView; work: TeamWorkReference; frame: string; visible: boolean; current: () => boolean;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversationTeam" }), reads = useSessionReads();
  const [open, setOpen] = useState(false), [cursor, setCursor] = useState<Cursor | null>(null), after = cursorFor(cursor, frame);
  const key = ["conversation-team-tools", status.plan.planId, frame, work, after];
  const read = useSessionQuery({ key, scopes: ["execution", "project"], enabled: visible && open && current(), structuralSharing: false,
    read: async () => {
      if (!visible || !current()) throw new Error("Team tool read is no longer current");
      const page = await workPlanCommands.teamWorkTools({ ...context, planId: status.plan.planId, work, after, limit: 16 });
      if (!visible || !current()) throw new Error("Team tool read is no longer current");
      return page;
    } });
  const page = !read.error ? read.data : undefined;
  function fresh() {
    const query = reads.client.getQueryState(reads.key(key));
    return visible && current() && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null && query.data === page;
  }
  return <section className={styles.tools} aria-label={t("tools")}>
    <Button size="sm" aria-expanded={open} disabled={!visible || !current()} onClick={() => { if (visible && current()) setOpen(value => !value); }}>{t(open ? "hideTools" : "readTools")}</Button>
    {open ? <>
      <p className={styles.meta}>{t("toolsHelp")}</p>
      {read.isPending || read.isFetching ? <p role="status">{t("toolsLoading")}</p> : null}
      {read.error ? <ReadFailure label={t("toolsFailed")} error={read.error}/> : null}
      {page?.attempts.map(row => <article key={row.reference.attemptId}>
        <h6>{row.name}</h6><p>{t("toolsCounts", { succeeded: row.progress.succeeded, unknown: row.progress.unknown, saved: row.storedResultItems })}</p>
        <Disclosure title={<>{t("diagnostics")}</>}><code>{row.reference.taskId}</code><p><code>{row.reference.attemptId}</code></p></Disclosure>
      </article>)}
      {fresh() && page?.attempts.length === 0 ? <p>{t("noTools")}</p> : null}
      <div className={styles.actions}>
        <Button size="sm" disabled={!current() || read.isFetching} onClick={() => { if (current()) void read.refetch(); }}>{t("refreshTools")}</Button>
        <Button size="sm" disabled={!fresh() || after === null} onClick={() => { if (fresh()) setCursor({ frame, value: null }); }}>{t("firstTools")}</Button>
        <Button size="sm" disabled={!fresh() || !page?.nextAfter} onClick={() => { if (fresh() && page?.nextAfter) setCursor({ frame, value: page.nextAfter }); }}>{t("nextTools")}</Button>
      </div>
    </> : null}
  </section>;
}

export function ConversationTeamProgress(props: ConversationTeamProgressProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversationTeam" }), id = useId();
  const planIdentity = useMemo(() => JSON.stringify([props.context, props.link]), [props.context.projectId, props.context.sessionToken, props.link]);
  const [openFor, setOpenFor] = useState<string | null>(null), expanded = openFor === planIdentity;
  return <section className={styles.panel} hidden={!props.visible} aria-label={t("title")}>
    <Button size="sm" aria-expanded={expanded} aria-controls={id} disabled={!props.visible || !props.canRead()} onClick={() => {
      if (props.visible && props.canRead()) setOpenFor(expanded ? null : planIdentity);
    }}>{t(expanded ? "hide" : "show")}</Button>
    <div id={id} hidden={!expanded}>{expanded && props.visible ? <TeamRecords key={planIdentity} {...props}/> : null}</div>
  </section>;
}

function TeamRecords({ context, link, status, visible, canRead, onOpenCandidate, actions, onReply }: ConversationTeamProgressProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversationTeam" }), { t: global } = useTranslation(), reads = useSessionReads();
  const frame = useMemo(() => JSON.stringify([context, link, status]), [context.projectId, context.sessionToken, link, status]);
  const live = useRef({ frame, visible, canRead, onOpenCandidate }), alive = useRef(true);
  useLayoutEffect(() => { live.current = { frame, visible, canRead, onOpenCandidate }; });
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; navigation.current?.dispose(); navigation.current = null; }; }, []);
  const [workCursor, setWorkCursor] = useState<Cursor | null>(null), [messageCursor, setMessageCursor] = useState<Cursor | null>(null), [historyCursor, setHistoryCursor] = useState<Cursor | null>(null);
  const afterWork = cursorFor(workCursor, frame), afterMessage = cursorFor(messageCursor, frame), afterHistory = cursorFor(historyCursor, frame);
  const [historyOpen, setHistoryOpen] = useState(false), [postId, setPostId] = useState<string | null>(null);
  const [basis, setBasis] = useState<{ frame: string; value: string } | null>(null), [busyWork, setBusyWork] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ intentId: string; cause: CommandFailure | null } | null>(null);
  const navigation = useRef<{ dispose: () => void } | null>(null), postOrigin = useRef<HTMLButtonElement | null>(null), postReturn = useRef<HTMLButtonElement | null>(null), postHeading = useRef<HTMLHeadingElement>(null);
  function present() {
    return alive.current && live.current.frame === frame && live.current.visible && !reads.retired
      && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken && live.current.canRead();
  }
  async function guarded<T>(read: () => Promise<T>): Promise<T> {
    if (!present()) throw new Error("Team read is no longer current");
    const value = await read();
    if (!present()) throw new Error("Team read is no longer current");
    return value;
  }
  const key = ["conversation-team-execution", link.conversationId, link.planId, frame, afterWork, afterMessage];
  const read = useSessionQuery({ key, scopes: ["execution", "source", "translation", "project"], enabled: visible && canRead(), structuralSharing: false,
    read: () => guarded(() => readConversationTeamExecution(context, link, status, afterWork, afterMessage)) });
  const page = !read.error ? read.data ?? null : null;
  const effective = page ? JSON.stringify(page.effectiveVersion) : null;
  const changed = !!page && (afterWork !== null || afterMessage !== null) && basis?.frame === frame && basis.value !== effective;
  useLayoutEffect(() => {
    if (!page || !effective || afterWork !== null || afterMessage !== null || read.isFetching || read.error) return;
    setBasis(previous => previous?.frame === frame && previous.value === effective ? previous : { frame, value: effective });
  }, [effective, frame, afterWork, afterMessage, read.isFetching, read.error]);
  function currentPage(expected: TeamExecutionView) {
    const query = reads.client.getQueryState<TeamExecutionView>(reads.key(key));
    return present() && !changed && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null && query.data === expected;
  }
  function returnToFirstPages() {
    if (!present()) return;
    void reads.client.invalidateQueries({ queryKey: reads.key(["conversation-team-execution", link.conversationId, link.planId, frame]), refetchType: "none" });
    setBasis(null); setWorkCursor({ frame, value: null }); setMessageCursor({ frame, value: null });
  }
  const fresh = !!page && currentPage(page);
  const historyKey = ["conversation-team-history", link.conversationId, link.planId, frame, afterHistory];
  const history = useSessionQuery({ key: historyKey, scopes: ["execution", "source", "translation", "project"], enabled: visible && historyOpen && canRead(), structuralSharing: false,
    read: () => guarded(() => readConversationTeamHistory(context, link, status, afterHistory)) });
  const posts = !history.error ? history.data : undefined;
  function historyCurrent() {
    const query = reads.client.getQueryState(reads.key(historyKey));
    return present() && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null && query.data === posts;
  }
  const focused = useSessionQuery({ key: ["conversation-team-post", link.conversationId, link.planId, frame, postId], scopes: ["execution", "source", "translation", "project"], enabled: visible && !!postId && canRead(), structuralSharing: false,
    read: () => guarded(() => { if (!postId) throw new Error("No original post selected"); return readConversationTeamPost(context, link, status, postId); }) });
  useLayoutEffect(() => {
    const origin = postOrigin.current;
    if (!origin || focused.isFetching || focused.isPending) return;
    postOrigin.current = null;
    if (present() && document.activeElement === origin) postHeading.current?.focus();
  }, [postId, focused.isFetching, focused.isPending, focused.dataUpdatedAt, focused.errorUpdatedAt]);
  function openPost(originalId: string, origin: HTMLButtonElement) { if (present()) { postOrigin.current = origin; postReturn.current = origin; setPostId(originalId); } }
  function postButtons(ids: readonly string[]) { return [...new Set(ids)].map(originalId => <Button size="sm" key={originalId} disabled={!fresh} onClick={event => { if (fresh) openPost(originalId, event.currentTarget); }}>{t("readReason")}</Button>); }
  function entryName(unitId: string) { return status.plan.scope.find(unit => unit.unitId === unitId)?.nativeKey ?? t("entryUnknown"); }
  function roleAt(memberId: string, versionId: string) { return page?.roleVersions.find(role => role.request.memberId === memberId && role.request.roleVersionId === versionId); }
  function memberName(memberId: string, versionId: string) { return roleAt(memberId, versionId)?.request.displayName ?? t("memberUnknown"); }
  async function openCandidate(work: Work) {
    const expected = page, callback = onOpenCandidate;
    if (!expected || !callback || !currentPage(expected) || navigation.current || !expected.works.includes(work)) return;
    const target = conversationTeamCandidateTarget(link, status, expected, work);
    if (!target) return;
    const witness = reads.watchExactQuery(key), original = witness.current(), version = original?.state.dataUpdateCount;
    const flight = { dispose: () => witness.dispose() };
    const current = () => navigation.current === flight && live.current.onOpenCandidate === callback && currentPage(expected)
      && witness.current() === original && original?.state.dataUpdateCount === version && expected.works.includes(work);
    navigation.current = flight; setBusyWork(work.receipt.intentId); setFeedback(null);
    try {
      if (!current()) return;
      if (!await callback(target, current) && current()) setFeedback({ intentId: work.receipt.intentId, cause: null });
    } catch (error) { if (current()) setFeedback({ intentId: work.receipt.intentId, cause: commandFailure(error) }); }
    finally { flight.dispose(); if (navigation.current === flight) { navigation.current = null; if (alive.current) setBusyWork(null); } }
  }
  return <div className={styles.body}>
    <h4>{t("title")}</h4><p className={styles.meta}>{t("help")}</p><p className={styles.meta}>{t("partial")}</p>
    {read.isPending ? <LoadingState label={t("loading")}/> : read.isFetching ? <p role="status">{t("loading")}</p> : null}
    {read.error ? <ReadFailure label={t("failed")} error={read.error}/> : null}
    {changed ? <Banner tone="warning"><p>{t("changed")}</p><Button size="sm" disabled={!present() || read.isFetching} onClick={returnToFirstPages}>{t("firstPages")}</Button></Banner> : page && !fresh && !read.isFetching ? <p role="status">{t("stale")}</p> : null}
    <div className={styles.actions}><Button size="sm" pending={read.isFetching} disabled={!present() || !!busyWork} onClick={() => { if (present() && !navigation.current) { setFeedback(null); void read.refetch(); } }}>{t("refresh")}</Button></div>
    {page ? <>
      {actions?.(page, () => currentPage(page))}
      <section aria-label={t("members")}><h5>{t("members")}</h5><ul className={styles.members}>{page.roster.map(member => <li key={`${member.memberId}:${member.roleVersionId}`}><strong>{member.displayName}</strong><Disclosure title={<>{t("memberRole")}</>}><p className={styles.text}>{member.role}</p><p>{t("model")}: {member.config.model}</p><p>{t("roleVersion")}: <code>{member.roleVersionId}</code></p></Disclosure></li>)}</ul>
        {page.retiredMemberIds.length ? <Disclosure title={<>{t("retired")}</>}><ul>{page.retiredMemberIds.map(memberId => <li key={memberId}>{page.roleVersions.find(role => role.request.memberId === memberId)?.request.displayName ?? t("memberUnknown")}</li>)}</ul></Disclosure> : null}
      </section>
      {page.stopReason ? <Banner tone="warning">{global(`ai.team.stops.${page.stopReason}`)}</Banner> : null}
      <section aria-label={t("works")}><h5>{t("works")}</h5>
        {!page.works.length && fresh ? <p>{t("noWork")}</p> : page.works.map(work => {
          const outcome = work.validation === "valid" ? work.output?.outcome : null, human = work.origin.kind === "human-continuation" ? work.origin.work : null;
          const role = roleAt(work.receipt.memberId, work.receipt.roleVersionId), candidate = conversationTeamCandidateTarget(link, status, page, work);
          return <article className={styles.work} key={work.receipt.intentId} aria-label={t("target", { entry: entryName(work.target.unitId), locale: work.target.locale })}>
            <h6>{memberName(work.receipt.memberId, work.receipt.roleVersionId)} · {entryName(work.target.unitId)} · {work.target.locale}</h6>
            <p>{t(`execution.${work.execution}`)} · {t(`validation.${work.validation}`)}</p>
            {human || work.origin.kind === "start" ? <p className={styles.meta}>{t(human ? "human" : "initial")}</p> : null}
            {work.author ? <p className={styles.meta}>{t("requestedBy", { member: memberName(work.author.memberId, work.author.roleVersionId) })}</p> : null}
            <Disclosure title={<>{t("instructions")}</>}><p className={styles.text}>{human?.instructions ?? work.request?.instructions ?? t("initial")}</p>{role ? <><h6>{t("role")}</h6><p className={styles.text}>{role.request.role}</p><code>{role.request.roleVersionId}</code></> : null}
              {human?.priorWork.length ? <><h6>{t("priorWork")}</h6><ul>{human.priorWork.map(reference => <li key={reference.attemptId}><code>{reference.taskId}</code> · <code>{reference.attemptId}</code></li>)}</ul></> : null}
            </Disclosure>
            {outcome?.kind === "translation" ? <><p>{t(work.candidateRevisionId ? "candidate" : "suggestion")}</p><Disclosure title={<>{t("fullText")}</>}>{outcome.text === "" ? <p>{t("emptyTranslation")}</p> : <p className={styles.text}><TokenizedText text={outcome.text} tone="ai"/></p>}</Disclosure></> : null}
            {outcome?.kind === "review" ? <p>{t(`verdict.${outcome.verdict}`)}</p> : outcome?.kind === "waiting" ? <p>{t("waiting")}</p> : outcome?.kind === "awaiting-human" ? <p>{t("awaitingHuman")}</p> : outcome?.kind === "evidence" ? <p>{t("evidence")}</p> : null}
            <div className={styles.actions}>{postButtons([...(work.request?.postIds ?? human?.postIds ?? []), ...(outcome?.kind === "review" || outcome?.kind === "evidence" ? outcome.postIds : [])])}
              {candidate && onOpenCandidate ? <Button size="sm" disabled={!fresh || busyWork !== null} onClick={() => void openCandidate(work)}>{t(busyWork === work.receipt.intentId ? "openingCandidate" : "openCandidate")}</Button> : null}
            </div>
            {feedback?.intentId === work.receipt.intentId ? <Banner tone="warning" role="status"><p>{t("candidateChanged")}</p>{feedback.cause ? <CommandFailureDetails failure={feedback.cause}/> : null}</Banner> : null}
            {work.output ? <Disclosure title={<>{global("ai.usageDetails.title")}</>}><AiOutputUsage usage={work.output.usage} incomplete={work.output.usageIncomplete}/></Disclosure> : null}
            <ToolReferences context={context} status={status} frame={frame} work={{ taskId: work.receipt.taskId, attemptId: work.receipt.attemptId, inputDigest: work.receipt.inputDigest }} visible={visible} current={() => currentPage(page)}/>
          </article>;
        })}
        <div className={styles.actions}><Button size="sm" disabled={!fresh || afterWork === null || !!busyWork} onClick={() => { if (fresh) setWorkCursor({ frame, value: null }); }}>{t("firstWork")}</Button><Button size="sm" disabled={!fresh || !page.nextWorkAfter || !!busyWork} onClick={() => { if (fresh && page.nextWorkAfter) setWorkCursor({ frame, value: page.nextWorkAfter }); }}>{t("nextWork")}</Button></div>
      </section>
      <section aria-label={t("messages")}><h5>{t("messages")}</h5>{!page.messages.length && fresh ? <p>{t("noMessages")}</p> : page.messages.map(message => {
        const included = page.consumptions.filter(item => item.messageId === message.messageId);
        return <article className={styles.message} key={message.messageId}><h6>{message.sender.kind !== "member" ? t("localUser") : memberName(message.sender.author.memberId, message.sender.author.roleVersionId)} → {memberName(message.recipientMemberId, message.recipientRoleVersionId)}</h6><p className={styles.meta}>{t("target", { entry: entryName(message.target.unitId), locale: message.target.locale })}</p><p className={styles.text}>{message.body}</p><p className={styles.meta}>{t(included.length ? "included" : "addressed", { count: included.length })}</p><div className={styles.actions}>{postButtons(message.postIds)}</div></article>;
      })}
        <div className={styles.actions}><Button size="sm" disabled={!fresh || afterMessage === null} onClick={() => { if (fresh) setMessageCursor({ frame, value: null }); }}>{t("firstMessage")}</Button><Button size="sm" disabled={!fresh || !page.nextMessageAfter} onClick={() => { if (fresh && page.nextMessageAfter) setMessageCursor({ frame, value: page.nextMessageAfter }); }}>{t("nextMessage")}</Button></div>
      </section>
    </> : null}
    <Button size="sm" aria-expanded={historyOpen} disabled={!present()} onClick={() => { if (present()) setHistoryOpen(value => !value); }}>{t(historyOpen ? "hideHistory" : "showHistory")}</Button>
    {historyOpen ? <section aria-label={t("history")}><h5>{t("history")}</h5>{history.isPending || history.isFetching ? <p role="status">{t("historyLoading")}</p> : null}{history.error ? <ReadFailure label={t("historyFailed")} error={history.error}/> : null}
      {posts?.posts.map(post => <PostCard key={post.publication.postId} post={post} roles={posts.authorRoles} status={status} allowed={historyCurrent()} openPost={openPost}
        onReply={onReply ? original => { if (historyCurrent()) onReply(original); } : undefined}/>)}
      {historyCurrent() && posts?.posts.length === 0 ? <p>{t("noPosts")}</p> : null}
      <div className={styles.actions}><Button size="sm" disabled={!present() || history.isFetching} onClick={() => { if (present()) void history.refetch(); }}>{t("refreshHistory")}</Button><Button size="sm" disabled={!historyCurrent() || afterHistory === null} onClick={() => { if (historyCurrent()) setHistoryCursor({ frame, value: null }); }}>{t("firstHistory")}</Button><Button size="sm" disabled={!historyCurrent() || !posts?.nextAfter} onClick={() => { if (historyCurrent() && posts?.nextAfter) setHistoryCursor({ frame, value: posts.nextAfter }); }}>{t("nextHistory")}</Button></div>
    </section> : null}
    {postId ? <section className={styles.original} aria-label={t("originalPost")}><h5 tabIndex={-1} ref={postHeading}>{t("originalPost")}</h5><Button size="sm" disabled={!present()} onClick={() => { if (present()) { setPostId(null); postOrigin.current = null; const origin = postReturn.current; postReturn.current = null; if (origin?.isConnected) origin.focus(); } }}>{t("closePost")}</Button>
      {focused.isPending || focused.isFetching ? <p role="status">{t("historyLoading")}</p> : null}{focused.error ? <ReadFailure label={t("historyFailed")} error={focused.error}/> : focused.data ? <PostCard post={focused.data.post} roles={focused.data.roles} status={status} allowed={present()} openPost={openPost}
        onReply={onReply ? original => { if (present() && !focused.isFetching && !focused.error) onReply(original); } : undefined}/> : null}
      <Button size="sm" disabled={!present() || focused.isFetching} onClick={() => { if (present()) void focused.refetch(); }}>{t("refreshPost")}</Button>
    </section> : null}
    {!actions ? <p className={styles.meta}>{t("readOnly")}</p> : null}
  </div>;
}
