import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { conversationCommands } from "../../../conversationCommands";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import { Button } from "../../../design-system/Button";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { Menu } from "../../../design-system/Menu";
import { useSessionInfiniteQuery, useSessionReads } from "../../../SessionReadProvider";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ConversationSession } from "./ConversationSession";
import type { OpenConversationRunCandidate } from "./conversationRunResultReads";
import type { OpenConversationTeamCandidate } from "./conversationTeamReads";
import { ConversationWorkPlanPanel } from "./ConversationWorkPlanPanel";
import styles from "./RunsView.module.css";

export default function RunsView({ owner, disabled, gate, viewId, onAssistant, onOpenCandidate, onOpenTeamCandidate, showDetails = true, expandedPlans, onExpandedPlan, scrollTop = 0, onScroll }: {
  owner: ConversationSession; disabled: boolean; gate: InteractionGate; viewId: string;
  onAssistant: () => void; onOpenCandidate: OpenConversationRunCandidate; onOpenTeamCandidate: OpenConversationTeamCandidate;
  showDetails?: boolean; expandedPlans?: readonly string[]; onExpandedPlan?: (planId: string, open: boolean) => void;
  scrollTop?: number; onScroll?: (top: number) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "runsView" }), { t: global } = useTranslation(), reads = useSessionReads();
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (root.current) root.current.scrollTop = scrollTop; }, [viewId]);
  const activeId = state.activeId, input = activeId ? state.inputs.get(activeId) : null;
  const threads = useSessionInfiniteQuery({ key: ["conversations"], scopes: ["project"], enabled: !reads.retired,
    initialPageParam: null as string | null, nextPage: (last: Awaited<ReturnType<typeof conversationCommands.list>>) => last.nextAfter ?? undefined,
    read: after => conversationCommands.list({ ...owner.context, after, limit: 50 }) });
  const saved = threads.data?.pages.flatMap(page => page.rows) ?? [], title = saved.find(thread => thread.conversationId === activeId);
  const allowed = () => !disabled && !state.retired && !reads.retired && gate.canDispatch({ viewId, source: "button" });
  // Presentation moves retire preview witnesses, while input and pending requests stay with the owner.
  useLayoutEffect(() => {
    if (!showDetails) return;
    if (activeId) owner.invalidateWorkPlan(activeId);
    return () => { if (activeId) owner.invalidateWorkPlan(activeId); };
  }, [owner, activeId, showDetails]);
  return <section ref={root} onScroll={event => onScroll?.(event.currentTarget.scrollTop)} className={styles.view} aria-label={t("title")}>
    <header><h2>{t("title")}</h2><p>{t("help")}</p></header>
    <div className={styles.actions}><Menu label={global("conversation.chooseThread")} trigger={<Button variant="secondary" disabled={!allowed() || saved.length === 0}>
      {title?.title ?? (title ? global("conversation.threadNumber", { number: title.ordinal }) : activeId ? global("conversation.untitled") : global("conversation.chooseThreadPlaceholder"))}</Button>}
      items={saved.map(thread => ({ id: thread.conversationId, label: thread.title ?? global("conversation.threadNumber", { number: thread.ordinal }),
        onSelect: () => { if (allowed()) void owner.open(thread.conversationId); } }))}/>
      {threads.hasNextPage ? <Button size="sm" pending={threads.isFetchingNextPage} disabled={!allowed()} onClick={() => { if (allowed()) void threads.fetchNextPage(); }}>{global("conversation.moreThreads")}</Button> : null}
      <Button size="sm" disabled={!allowed()} onClick={() => { if (allowed()) onAssistant(); }}>{t("assistant")}</Button>
    </div>
    {threads.isPending ? <LoadingState label={global("conversation.readingMessages")}/> : null}
    {threads.error ? <Banner tone="error" action={<Button size="sm" disabled={!allowed()} onClick={() => { if (allowed()) void threads.refetch(); }}>{global("conversation.retryRead")}</Button>}>
      <p>{global("conversation.threadsReadFailed")}</p><CommandFailureDetails failure={commandFailure(threads.error)}/></Banner> : null}
    {input?.value.pending || input?.failure ? <Banner tone="warning" action={<Button size="sm" disabled={!allowed()} onClick={() => { if (allowed()) onAssistant(); }}>{t("originalRequest")}</Button>}>{t("pending")}</Banner> : null}
    {!showDetails ? <p>{t("pending")}</p> : !activeId ? <EmptyState title={t("choose")} description={t("chooseHelp")}/> : !input ? state.inputFailure?.conversationId === activeId
      ? <ErrorState title={global("conversation.inputReadFailed")} action={<Button disabled={!allowed()} onClick={() => { if (allowed()) void owner.open(activeId); }}>{global("conversation.retryRead")}</Button>}/>
      : <LoadingState label={global("conversation.readingInput")}/>
      : <ConversationWorkPlanPanel key={activeId} owner={owner} input={input} visible disabled={disabled} gate={gate} viewId={viewId}
        onOpenCandidate={onOpenCandidate} onOpenTeamCandidate={onOpenTeamCandidate} expandedPlans={expandedPlans} onExpandedPlan={onExpandedPlan}/>}
  </section>;
}
