import type { OpenConversationTeamFinding } from "./teamFindingReads";
import type { OpenRunCandidateBatch } from "../candidates/runCandidateBatch";
import { Disclosure } from "../../../design-system/Disclosure";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, MessageSquare, Plus, RefreshCw, Sparkles } from "lucide-react";
import { assistantComposerCommands, composerCommand, type AssistantComposerCommand } from "../../../assistantComposerCommands";
import type { SegmentQuery } from "../../../segmentCommands";
import { ConversationContextChips } from "./ConversationContextChips";
import { ConversationText } from "./ConversationText";
import { ConversationEntryReferences, type OpenConversationEntryReference } from "./ConversationEntryReferences";
import { composerMemberRoute, ConversationMemberRoutes, type ConversationMemberRoute } from "./ConversationMemberRoutes";
import { conversationCommands, isConversationMessageText } from "../../../conversationCommands";
import { workspaceCommandMetadata } from "../../../commandBindings";
import type { WorkbenchCommands } from "../../../workbenchCommands";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import { Button, IconButton } from "../../../design-system/Button";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { Menu } from "../../../design-system/Menu";
import { useSessionInfiniteQuery, useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ConversationInput, ConversationSession } from "./ConversationSession";
import type { WorkspaceSelection } from "../../workspace/workspaceSelection";
import { ConversationPlanningPanel } from "./ConversationPlanningPanel";
import { ConversationMaterialReferences } from "./ConversationMaterialReferences";
import { ConversationProposals } from "./ConversationProposals";
import { ConversationKnowledgeEntries } from "./ConversationKnowledgeEntries";
import type { OpenKnowledgeProposal } from "./conversationNavigation";
import { ConversationWorkPlanPanel } from "./ConversationWorkPlanPanel";
import { locallyReplayableConversationRequest, conversationPendingActionId, isConversationTeamPending, type ConversationDraftPending } from "../../../conversationDraftCommands";
import { isRunPending } from "./conversationRun";
import { ConversationRunRevocations } from "./ConversationRunRevocations";
import type { OpenConversationRunCandidate } from "./conversationRunResultReads";
import type { OpenConversationTeamCandidate } from "./conversationTeamReads";
import type { ConversationProposalTarget, ConversationTeamQuestionTarget } from "./conversationNavigation";
import styles from "../../WorkbenchLayout.module.css";
import local from "./ConversationPanel.module.css";

export type ConversationRecoveryTarget = { conversationId: string; slot: "primary" | "revocation"; actionId: string; focus: boolean };
interface Props { projectBrief?: (emptyThread: boolean) => ReactNode; showWorkPlans?: boolean; commands?: WorkbenchCommands; owner: ConversationSession; visible: boolean; disabled: boolean; gate: InteractionGate; viewId: string | null; parentDialogId?: string; selection?: WorkspaceSelection | null; targetLocale?: string | null; contextFilter?: SegmentQuery | null; onOpenEntryReference?: OpenConversationEntryReference; onOpenCandidate?: OpenConversationRunCandidate; onOpenCandidateBatch?: OpenRunCandidateBatch; onOpenTeamCandidate?: OpenConversationTeamCandidate; onOpenTeamFinding?: OpenConversationTeamFinding; onPrepareFindingRepair?: OpenConversationTeamFinding; onOpenKnowledgeProposal?: OpenKnowledgeProposal; decisionTray?: ReactNode; maintenanceBrief?: ReactNode; recoveryTarget?: ConversationRecoveryTarget | null; proposalTarget?: ConversationProposalTarget | null; questionTarget?: ConversationTeamQuestionTarget | null }
const noNext = (last: { nextAfter: string | null }) => last.nextAfter ?? undefined;
const pendingAction = (pending: ConversationDraftPending | null | undefined) => pending ? conversationPendingActionId(pending) : undefined;

function PlanningResult({ owner, input, attemptId, visible, disabled, gate, viewId, parentDialogId, savedResultIds, onOpenEntryReference }: Omit<Props, "selection"> & { input: ConversationInput; attemptId: string; savedResultIds: ReadonlySet<string> }) {
  const context = owner.context, conversationId = input.key.conversationId;
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const [materialOpen, setMaterialOpen] = useState(false), materialId = useId();
  const query = useSessionQuery({ key: ["conversation", conversationId, "planning", attemptId], scopes: ["project", "execution"], enabled: visible,
    read: () => conversationCommands.readPlanning({ ...context, conversationId, attemptId }) });
  if (query.isPending) return <p role="status">{t("readingReply")}</p>;
  if (query.isError || !query.data) return <Banner tone="error" action={<Button size="sm" onClick={() => void query.refetch()}>{t("retryRead")}</Button>}>{t("replyReadFailed")}</Banner>;
  const run = query.data, output = run.output?.model;
  const unavailable = run.detail.progress.cancelled ? "replyStopped" : run.detail.items.some(item => item.status.validation === "invalid") ? "replyInvalid"
    : run.detail.progress.failed || run.detail.progress.unknown ? "replyUnfinished" : "replyPending";
  return <section className={styles.agentCard} aria-label={t("reply")}>
    <h3><Sparkles className={styles.ai}/>{t(output?.kind === "knowledge-proposal" ? "knowledgeProposal" : output?.kind === "proposal" ? "proposal" : "reply")}</h3>
    {output ? <><ConversationText text={output.summary}/><ConversationEntryReferences run={run} onOpen={onOpenEntryReference} current={() => visible && !disabled && !query.isFetching && !query.isError && owner.getSnapshot().activeId === conversationId && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })}/>
      <ConversationMaterialReferences context={context} run={run} visible={visible} disabled={disabled} gate={gate} viewId={viewId} parentDialogId={parentDialogId} onOpenEntry={onOpenEntryReference}/>
      {output.kind === "proposal" ? <p className={styles.meta}>{t("proposalScope", { count: output.unitIds.length })}</p> : null}
      {output.kind === "knowledge-proposal" ? <ConversationKnowledgeEntries entries={output.entries}/> : null}
      {output.questions.length ? <ul>{output.questions.map((question, index) => <li key={index}>{question}</li>)}</ul> : null}
      {output.kind !== "reply" ? run.resultId && (savedResultIds.has(run.resultId) || input.capturedResultIds.includes(run.resultId)) ? <p>{t("proposalAlreadySaved")}</p>
        : <Button size="sm" disabled={disabled || !visible || (!!input.busy || input.journalBusy) || !!input.value.pending || !!input.failure} onClick={() => {
          if (gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })) void owner.captureProposal(run);
        }}>{t("proposalCapture")}</Button> : null}
      <Button size="sm" aria-expanded={materialOpen} aria-controls={materialId} onClick={() => setMaterialOpen(open => !open)}>{t("sentMaterial")}</Button>
      {materialOpen ? <div id={materialId}><p>{t("materialScope", { messages: run.preview.selectedMessages.length, units: run.preview.units.length })}</p>
        <pre className={local.text}>{run.preview.system}</pre><pre className={local.text}>{run.preview.input}</pre></div> : null}
    </> : <p>{t(unavailable)}</p>}
    <Button size="sm" onClick={() => void query.refetch()} pending={query.isFetching}>{t("refreshReply")}</Button>
  </section>;
}

function ThreadHistory({ showWorkPlans = true, owner, input, visible, disabled, gate, viewId, parentDialogId, selection, onOpenCandidate, onOpenCandidateBatch, onOpenTeamCandidate, onOpenTeamFinding, onPrepareFindingRepair, onOpenKnowledgeProposal, onOpenEntryReference, proposalTarget, questionTarget, proposalFocusTargets }: Omit<Props, "owner"> & { owner: ConversationSession; input: ConversationInput; proposalFocusTargets: RefObject<WeakSet<ConversationProposalTarget>> }) {
  const context = owner.context, conversationId = input.key.conversationId, planning = input.planning;
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const messages = useSessionInfiniteQuery({ key: ["conversation", conversationId, "messages"], scopes: ["project"], enabled: visible,
    initialPageParam: null as string | null, nextPage: noNext,
    read: after => conversationCommands.messages({ ...context, conversationId, after, limit: 50 }) });
  const attempts = useSessionInfiniteQuery({ key: ["conversation", conversationId, "attempts"], scopes: ["project", "execution"], enabled: visible,
    initialPageParam: "0", nextPage: noNext,
    read: after => conversationCommands.planningAttempts({ ...context, conversationId, after, limit: 50 }) });
  const proposals = useSessionInfiniteQuery({ key: ["conversation", conversationId, "proposals"], scopes: ["project"], enabled: visible,
    initialPageParam: null as string | null, nextPage: noNext,
    read: after => conversationCommands.proposalRevisions({ ...context, conversationId, after, limit: 50 }) });
  const saved = messages.data?.pages.flatMap(page => page.rows) ?? [];
  const runs = attempts.data?.pages.flatMap(page => page.rows) ?? [];
  const revisions = proposals.data?.pages.flatMap(page => page.rows) ?? [], savedResultIds = new Set(revisions.map(revision => revision.origin.resultId));
  const blocked = disabled || !visible || !!input.value.pending || (!!input.busy || input.journalBusy) || !!planning.busy || !!input.failure;
  const allowed = () => !blocked && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  return <>
    <Button size="sm" disabled={disabled || !visible} aria-expanded={planning.open} onClick={() => {
      if (gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })) owner.setPlanningOpen(conversationId, !planning.open);
    }}>{t(planning.open ? "askClose" : "askTitle")}</Button>
    {messages.isPending ? <LoadingState label={t("readingMessages")}/> : messages.isError ? <ErrorState title={t("messagesReadFailed")}
      action={<Button onClick={() => void messages.refetch()}>{t("retryRead")}</Button>}/> : saved.length === 0 ? <p className={styles.meta}>{t("emptyThread")}</p>
      : <section aria-label={t("savedMessages")} className={local.history}>{saved.map(message => <div key={message.messageId} className={styles.userMessage}>
        <span className={local.author}>{t("you")}</span><ConversationText text={message.body}/>
        {planning.open ? <label className={local.check}><TextInput className={local.checkbox} type="checkbox" checked={planning.messageIds.includes(message.messageId)}
          disabled={blocked || !planning.messageIds.includes(message.messageId) && planning.messageIds.length >= 16}
          onChange={event => { if (allowed()) owner.setPlanningMessages(conversationId, event.target.checked ? [...planning.messageIds, message.messageId] : planning.messageIds.filter(id => id !== message.messageId)); }}/><span>{t("askChooseMessage", { number: message.ordinal })}</span></label> : null}</div>)}</section>}
    {messages.hasNextPage ? <Button pending={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>{t("moreMessages")}</Button> : null}
    {planning.open ? <ConversationPlanningPanel owner={owner} input={input} visible={visible} disabled={disabled} gate={gate} viewId={viewId} parentDialogId={parentDialogId} selection={selection}/> : null}
    {attempts.isError ? <Banner tone="error" action={<Button size="sm" onClick={() => void attempts.refetch()}>{t("retryRead")}</Button>}>{t("repliesReadFailed")}</Banner> : null}
    {runs.length ? <section aria-label={t("savedReplies")} className={local.history}>{runs.map(run => <PlanningResult key={run.attemptId} owner={owner} input={input}
      attemptId={run.attemptId} visible={visible} disabled={disabled} gate={gate} viewId={viewId} parentDialogId={parentDialogId} savedResultIds={savedResultIds} onOpenEntryReference={onOpenEntryReference}/>)}</section> : null}
    {attempts.hasNextPage ? <Button pending={attempts.isFetchingNextPage} onClick={() => void attempts.fetchNextPage()}>{t("moreReplies")}</Button> : null}
    {proposals.isError ? <Banner tone="error" action={<Button size="sm" onClick={() => void proposals.refetch()}>{t("retryRead")}</Button>}>{t("proposalReadFailed")}</Banner> : null}
    <ConversationProposals owner={owner} input={input} visible={visible} disabled={disabled} gate={gate} viewId={viewId} parentDialogId={parentDialogId} revisions={revisions} proposalTarget={proposalTarget} proposalFocusTargets={proposalFocusTargets} onOpenKnowledgeProposal={onOpenKnowledgeProposal}/>
    {showWorkPlans ? <ConversationWorkPlanPanel onOpenCandidate={onOpenCandidate} onOpenCandidateBatch={onOpenCandidateBatch} onOpenTeamCandidate={onOpenTeamCandidate} onOpenTeamFinding={onOpenTeamFinding} onPrepareFindingRepair={onPrepareFindingRepair} owner={owner} input={input} visible={visible} disabled={disabled} gate={gate} viewId={viewId} parentDialogId={parentDialogId} questionTarget={questionTarget}/> : null}
    {proposals.hasNextPage ? <Button pending={proposals.isFetchingNextPage} onClick={() => void proposals.fetchNextPage()}>{t("moreProposalVersions")}</Button> : null}
  </>;
}

export default function ConversationPanel({ projectBrief, showWorkPlans = true, commands, owner, visible, disabled, gate, viewId, parentDialogId, selection = null, targetLocale, contextFilter, onOpenEntryReference, onOpenCandidate, onOpenCandidateBatch, onOpenTeamCandidate, onOpenTeamFinding, onPrepareFindingRepair, onOpenKnowledgeProposal, decisionTray, maintenanceBrief, recoveryTarget, proposalTarget, questionTarget }: Props) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "conversation" }), { t: global } = useTranslation();
  const reads = useSessionReads();
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const activeId = state.activeId, input = activeId ? state.inputs.get(activeId) : undefined;
  const composer = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const [memberRoutes, setMemberRoutes] = useState<ReadonlyMap<string, readonly ConversationMemberRoute[]>>(() => new Map());
  const [commandNotice, setCommandNotice] = useState<{ conversationId: string; messageId: string } | null>(null);
  const memberRegistry = useMemo(() => ({ register: (key: string, routes: readonly ConversationMemberRoute[]) => {
    setMemberRoutes(before => new Map(before).set(key, routes));
    return () => setMemberRoutes(before => { if (before.get(key) !== routes) return before; const next = new Map(before); next.delete(key); return next; });
  } }), []);
  const inputReady = !!input;
  const contextIdentity = JSON.stringify([selection, targetLocale ?? null, contextFilter ?? null]);
  useLayoutEffect(() => {
    if (!activeId || !input || !visible || disabled) return;
    const locale = selection?.kind === "ids" ? selection.locale : selection?.selection.capture.locale;
    owner.syncComposerContext(activeId, targetLocale && locale !== targetLocale ? null : selection, contextIdentity);
  }, [activeId, inputReady, visible, disabled, owner, contextIdentity, selection, targetLocale]);
  const proposalFocusTargets = useRef(new WeakSet<ConversationProposalTarget>());
  const threads = useSessionInfiniteQuery({ key: ["conversations"], scopes: ["project"], enabled: visible,
    initialPageParam: null as string | null, nextPage: noNext,
    read: after => conversationCommands.list({ ...owner.context, after, limit: 50 }) });
  const briefMessages = useSessionInfiniteQuery({ key: ["conversation", activeId, "messages"], scopes: ["project"], enabled: visible && !!activeId && !!projectBrief,
    initialPageParam: null as string | null, nextPage: noNext,
    read: after => { if (!activeId) throw new Error("A project brief requires a conversation"); return conversationCommands.messages({ ...owner.context, conversationId: activeId, after, limit: 50 }); } });
  const saved = threads.data?.pages.flatMap(page => page.rows) ?? [];
  const known = new Map(saved.map(thread => [thread.conversationId, thread.title ?? t("threadNumber", { number: thread.ordinal })]));
  state.summaries.forEach((summary, index) => { if (!known.has(summary.key.conversationId)) known.set(summary.key.conversationId, t("retainedInput", { number: index + 1 })); });
  for (const [id] of state.inputs) if (!known.has(id)) known.set(id, t("untitled"));
  const blocked = disabled || state.retired;
  const presentation = useRef({ visible, blocked, activeId, viewId, parentDialogId });
  useLayoutEffect(() => { presentation.current = { visible, blocked, activeId, viewId, parentDialogId }; });
  useLayoutEffect(() => () => { presentation.current.visible = false; }, []);
  const commandScope = useMemo(() => ({ ...owner.context, area: "translation" as const }), [owner]);
  function canCreateThread(live = presentation.current) {
    const latest = owner.getSnapshot();
    return live.visible && !live.blocked && live.viewId === viewId && live.parentDialogId === parentDialogId
      && !reads.retired && !latest.retired && latest.hydration === "ready"
      && ![...latest.inputs.values()].some(value => value.value.pending?.kind === "create" && !value.failure && (value.dirty || value.journalBusy || !!value.busy))
      && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  }
  function createThread() {
    if (!canCreateThread()) return;
    const origin = document.activeElement;
    void owner.create();
    const createdId = owner.getSnapshot().activeId;
    requestAnimationFrame(() => {
      const live = presentation.current;
      if (live.visible && !live.blocked && live.viewId === viewId && live.parentDialogId === parentDialogId
        && owner.getSnapshot().activeId === createdId && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })
        && (document.activeElement === origin || document.activeElement === document.body)) composer.current?.focus();
    });
  }
  useLayoutEffect(() => {
    if (!commands) return;
    return commands.register({ ...workspaceCommandMetadata("conversation.new-thread"), category: "ai", scope: commandScope, risk: "writes-project", confirmation: "none",
      availability: () => ({ enabled: canCreateThread() }), handler: createThread });
  }, [commands, owner, reads, gate, commandScope, viewId, parentDialogId]);
  function dispatchNewThread() {
    if (commands) commands.dispatch("conversation.new-thread", commandScope);
    else createThread();
  }
  function chooseCommand(command: AssistantComposerCommand) {
    const live = presentation.current;
    if (!live.activeId || !live.visible || live.blocked || !gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })) return;
    const current = owner.getSnapshot().inputs.get(live.activeId);
    if (!current || current.value.pending || current.busy || current.planning.busy || current.failure) return;
    const prefix = command.aliases[i18n.resolvedLanguage?.startsWith("zh") ? 0 : 1];
    owner.edit(live.activeId, `${prefix} ${current.value.text}`);
    owner.setPlanningOpen(live.activeId, true);
    composer.current?.focus();
  }
  useLayoutEffect(() => {
    if (!commands) return;
    const dispose = assistantComposerCommands.map(command => commands.register({ ...workspaceCommandMetadata(command.id), category: "ai", scope: commandScope,
      risk: "changes-view", confirmation: "none", availability: () => {
        const live = presentation.current, current = live.activeId ? owner.getSnapshot().inputs.get(live.activeId) : undefined;
        return { enabled: live.visible && !live.blocked && !!current && !current.busy && !current.value.pending && !current.failure && !current.planning.busy && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId }) };
      }, handler: () => chooseCommand(command) }));
    return () => dispose.forEach(close => close());
  }, [commands, owner, gate, commandScope, viewId, parentDialogId]);
  async function saveComposer() {
    const live = presentation.current, conversationId = live.activeId;
    if (!conversationId || !live.visible || live.blocked || !gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })) return;
    const before = owner.getSnapshot().inputs.get(conversationId);
    if (!before || before.planning.busy || before.value.pending || before.busy || before.failure) return;
    const command = composerCommand(before.value.text);
    const member = composerMemberRoute(before.value.text, [...memberRoutes.values()].flat());
    if (member) { member.route.open(member.body); return; }
    const sending = owner.append(conversationId), pending = owner.getSnapshot().inputs.get(conversationId)?.value.pending;
    await sending;
    const after = owner.getSnapshot(), current = after.inputs.get(conversationId);
    if (command && pending?.kind === "append" && current && !current.value.pending && after.activeId === conversationId
      && presentation.current.visible && !presentation.current.blocked && current.notice === "messageSaved") {
      const messageIds = [...new Set([...current.planning.messageIds, pending.request.messageId])];
      if (messageIds.length <= 16) {
        owner.setPlanningMessages(conversationId, messageIds);
        owner.setPlanningPurpose(conversationId, null);
        setCommandNotice(null);
      } else {
        owner.invalidatePlanning(conversationId);
        setCommandNotice({ conversationId, messageId: pending.request.messageId });
      }
      owner.setPlanningOpen(conversationId, true);
    }
  }
  const createDisabled = !canCreateThread({ visible, blocked, activeId, viewId, parentDialogId });
  const byteLength = new TextEncoder().encode(input?.value.text ?? "").length;
  const pending = input?.value.pending;
  const runPending = isRunPending(pending);
  const replayable = locallyReplayableConversationRequest(pending) || !!activeId && (owner.canRetryRun(activeId) || owner.canRetryTeam(activeId) || owner.canRetryQuestion(activeId));
  const exists = pending?.kind !== "create" || input?.outcome === "recorded";
  const primaryRecovery = !!recoveryTarget && recoveryTarget.conversationId === activeId && recoveryTarget.slot === "primary" && pendingAction(pending) === recoveryTarget.actionId;
  const revocationRecovery = recoveryTarget && recoveryTarget.conversationId === activeId && recoveryTarget.slot === "revocation"
    ? input?.value.revocations?.find(slot => slot.request.actionId === recoveryTarget.actionId) : undefined;
  const recoveryChanged = !!recoveryTarget && (recoveryTarget.conversationId !== activeId || !!input && !primaryRecovery && !revocationRecovery);
  const recoveryRegion = useRef<HTMLElement>(null), seenRecovery = useRef<ConversationRecoveryTarget | null | undefined>(undefined);
  const recoveryFocus = useRef<{ target: ConversationRecoveryTarget; origin: Element | null; moved: boolean; dispose: () => void } | null>(null);
  useLayoutEffect(() => () => { recoveryFocus.current?.dispose(); recoveryFocus.current = null; }, []);
  useLayoutEffect(() => {
    if (seenRecovery.current !== recoveryTarget) {
      recoveryFocus.current?.dispose(); recoveryFocus.current = null; seenRecovery.current = recoveryTarget;
      if (recoveryTarget?.focus && visible && !blocked) {
        const ticket = { target: recoveryTarget, origin: document.activeElement, moved: false, dispose: () => document.removeEventListener("focusin", moved) };
        const moved = (event: FocusEvent) => { if (event.target !== ticket.origin) ticket.moved = true; };
        document.addEventListener("focusin", moved); recoveryFocus.current = ticket;
      }
    }
    const ticket = recoveryFocus.current;
    if (!ticket) return;
    if (!visible || blocked || reads.retired || ticket.moved || activeId !== ticket.target.conversationId || recoveryChanged) {
      ticket.dispose(); recoveryFocus.current = null; return;
    }
    const latest = owner.getSnapshot(), current = latest.inputs.get(ticket.target.conversationId);
    const exact = ticket.target.slot === "primary" ? pendingAction(current?.value.pending) === ticket.target.actionId
      : current?.value.revocations?.some(slot => slot.request.actionId === ticket.target.actionId);
    if (!exact || !recoveryRegion.current || !gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })) return;
    ticket.dispose(); recoveryFocus.current = null;
    if (latest.activeId === ticket.target.conversationId && !latest.retired && document.activeElement === ticket.origin) recoveryRegion.current.focus();
  });
  function recoveryRequestName(value: ConversationDraftPending) {
    switch (value.kind) {
      case "create": return t("newThread");
      case "append": return t("saveMessage");
      case "planning": return t("askTitle");
      case "proposal-capture": return t("proposalCapture");
      case "proposal-revision": return t("proposalSaveVersion");
      case "proposal-work-plan": return t("planConfirm");
      case "work-plan-start": return t("runStart");
      case "team-question-response": return t("teamQuestionResponseRequest");
      case "team-recovery": return t("teamRecoveryRequest");
      case "team-message": return t("teamMessageRequest");
      case "team-publication": return t("teamPublicationRequest");
      case "work-plan-control": return t(value.request.command === "pause" ? "runPause" : value.request.command === "stop" ? "runStop" : value.request.command === "take-over" ? "runTakeOver" : "runReviewContinue");
    }
  }
  useEffect(() => () => gate.releaseOwner("conversation-composer"), [gate]);
  useEffect(() => { if (!visible) { composing.current = false; gate.releaseOwner("conversation-composer"); } }, [gate, visible]);
  return <ConversationMemberRoutes.Provider value={memberRegistry}><div className={styles.agent}>
    <div className={styles.agentHeader}><span>{t("lead")}</span>
      <div className={local.actions}><IconButton label={t("refresh")} disabled={blocked} onClick={() => { void threads.refetch(); void owner.initialize(); }}><RefreshCw/></IconButton>
        <IconButton label={t("newThread")} disabled={createDisabled} onClick={dispatchNewThread}><Plus/></IconButton></div>
    </div>
    <div className={local.picker}><Menu label={t("chooseThread")} align="start" trigger={<Button className={local.threadButton} variant="secondary" aria-label={t("chooseThread")} disabled={blocked || known.size === 0}>
      <span>{activeId ? known.get(activeId) : t("chooseThreadPlaceholder")}</span><ChevronDown/></Button>}
      items={[...known].map(([id, title]) => ({ id, label: title, onSelect: () => { void owner.open(id); } }))}/>
      {threads.hasNextPage ? <Button size="sm" pending={threads.isFetchingNextPage} onClick={() => void threads.fetchNextPage()}>{t("moreThreads")}</Button> : null}
      {state.next ? <Button size="sm" pending={state.hydration === "loading"} onClick={() => void owner.initialize(true)}>{t("moreDrafts")}</Button> : null}
    </div>
    <div className={styles.messages}>
      {projectBrief?.(!activeId ? threads.isSuccess && saved.length === 0 : briefMessages.isSuccess && briefMessages.data.pages.every(page => page.rows.length === 0))}
      {maintenanceBrief}
      {proposalTarget && proposalTarget.conversationId !== activeId ? <Banner tone="warning" role="status">{t("proposalTargetConversationChanged")}</Banner> : null}
      {threads.isError ? <Banner tone="error" action={<Button size="sm" onClick={() => void threads.refetch()}>{t("retryRead")}</Button>}>{t("threadsReadFailed")}</Banner> : null}
      {state.hydration === "failed" ? <Banner tone="error" action={<Button size="sm" onClick={() => void owner.initialize()}>{t("retryRead")}</Button>}>{t("draftsReadFailed")}<CommandFailureDetails failure={state.failure}/></Banner> : null}
      {!activeId ? <EmptyState icon={<MessageSquare/>} title={t("welcome")} description={t("welcomeHelp")}
        action={<Button variant="secondary" disabled={createDisabled} onClick={dispatchNewThread}>{t("newThread")}</Button>}/>
        : !input ? state.inputFailure?.conversationId === activeId ? <ErrorState title={t("inputReadFailed")} description={<CommandFailureDetails failure={state.inputFailure.cause}/>} action={<Button onClick={() => void owner.open(activeId)}>{t("retryRead")}</Button>}/>
          : <LoadingState label={t("readingInput")}/> : exists ? <ThreadHistory showWorkPlans={showWorkPlans} onOpenCandidate={onOpenCandidate} onOpenCandidateBatch={onOpenCandidateBatch} onOpenTeamCandidate={onOpenTeamCandidate} onOpenTeamFinding={onOpenTeamFinding} onPrepareFindingRepair={onPrepareFindingRepair} onOpenKnowledgeProposal={onOpenKnowledgeProposal} onOpenEntryReference={onOpenEntryReference} key={activeId} owner={owner} input={input} visible={visible} disabled={blocked} gate={gate} viewId={viewId} parentDialogId={parentDialogId} selection={selection} proposalTarget={proposalTarget} proposalFocusTargets={proposalFocusTargets} questionTarget={questionTarget?.conversationId === activeId ? questionTarget : null}/> : <p role="status">{t("creatingThread")}</p>}
    </div>
    {decisionTray}
    {input ? <div className={styles.composer}>
      <div className={styles.composerBody}>
        {recoveryChanged ? <Banner tone="warning" role="status">{t("recoveryChanged")}</Banner> : null}
        {revocationRecovery && recoveryTarget ? <ConversationRunRevocations owner={owner} input={input}
          link={{ conversationId: input.key.conversationId, planId: revocationRecovery.request.planId }}
          recovery={{ actionId: recoveryTarget.actionId, targetRef: recoveryRegion }} canRead={() => {
            const live = presentation.current, latest = owner.getSnapshot();
            return live.visible && !live.blocked && !reads.retired && !latest.retired && live.activeId === recoveryTarget.conversationId
              && latest.activeId === recoveryTarget.conversationId && live.viewId === viewId && live.parentDialogId === parentDialogId
              && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
          }}
          onFinished={origin => {
            const live = presentation.current;
            if (live.visible && !live.blocked && live.activeId === recoveryTarget.conversationId
              && (document.activeElement === origin || document.activeElement === document.body)) composer.current?.focus();
          }}/> : null}
        {input.notice ? <p role="status" className={local.notice}>{t(input.notice)}</p> : null}
        {commandNotice?.conversationId === activeId && !input.planning.messageIds.includes(commandNotice.messageId) ? <p role="status" className={local.notice}>{t("composerMessageLimit")}</p> : null}
        {input.failure?.kind === "journal" ? <Banner tone="error"><p>{t("journalFailed")}</p><CommandFailureDetails failure={input.failure.cause}/>
          <Button size="sm" disabled={blocked || input.journalBusy} onClick={() => void owner.retryJournal(activeId!)}>{t("retryJournal")}</Button></Banner> : null}
        {pending ? <section ref={primaryRecovery ? recoveryRegion : undefined} tabIndex={primaryRecovery ? -1 : undefined}
          className={primaryRecovery ? local.recovery : undefined} data-conversation-recovery={primaryRecovery ? "primary" : undefined}
          aria-label={primaryRecovery ? t("recoveryPrimary") : undefined}>
          {primaryRecovery ? <><h3>{t("recoveryPrimary")}</h3><p>{t("recoveryRequest", { request: recoveryRequestName(pending) })}</p><p>{t("recoveryHelp")}</p></> : null}
        {pending.kind === "team-question-response" ? <><p>{t("teamQuestionPendingHelp")}</p><Disclosure title={<>{t("teamOriginal")}</>}>
          <p>{pending.question.publication.body}</p><Field label={t("teamQuestionOriginalResponse")}><TextArea readOnly value={pending.request.response.response.kind === "text" ? pending.request.response.response.body
            : pending.request.response.response.kind === "dismiss" ? pending.request.response.response.reason : pending.question.publication.question?.kind === "open"
              ? pending.question.publication.question.options.find(option => pending.request.response.response.kind === "choice" && option.optionId === pending.request.response.response.optionId)?.label ?? "" : ""}/></Field>
        </Disclosure></> : null}
        {pending.kind === "team-recovery" ? <><p>{t("teamRecoveryPendingHelp")}</p><Disclosure title={<>{t("teamOriginal")}</>}>
          <Field label={t("teamOriginalBody")}><TextArea readOnly value={pending.request.recovery.work.instructions}/></Field>
          {pending.request.recovery.members.map(member => <div key={member.memberId}><p>{t("teamOriginalRecipient", { name: member.displayName, endpoint: member.config.endpoint, model: member.config.model })}</p><p>{member.role}</p></div>)}
        </Disclosure></> : null}
        {isConversationTeamPending(pending) ? <><p>{t("teamPendingHelp")}</p><Disclosure title={<>{t("teamOriginal")}</>}>
          <p>{t("teamOriginalTarget", { entry: pending.targetName, locale: pending.kind === "team-message" ? pending.request.message.target.locale : pending.request.publication.target.locale })}</p>
          {pending.kind === "team-message" ? <><p>{t("teamOriginalRecipient", { ...pending.destination })}</p><p>{pending.destination.role}</p></> : null}
          <Field label={t("teamOriginalBody")}><TextArea readOnly value={pending.kind === "team-message" ? pending.request.message.body : pending.request.publication.body}/></Field>
        </Disclosure></> : null}
        {!input.busy && input.failure?.kind !== "journal" ? <Banner tone={input.outcome === "mismatch" ? "error" : "warning"}>
          <p>{t(input.outcome === "blocked" ? runPending ? "runBlocked" : "absentBlocked" : input.outcome === "absent" ? replayable ? runPending ? "runAbsent" : "absent" : "absentBlocked" : input.outcome === "mismatch" ? "mismatch" : input.outcome === "recorded" ? "finishing" : runPending ? "runPending" : "pending")}</p>
          <CommandFailureDetails failure={input.failure?.cause ?? null}/>
          <div className={local.actions}><Button size="sm" disabled={blocked || (!!input.busy || input.journalBusy)} onClick={async event => {
            const origin = event.currentTarget, conversationId = activeId!;
            await owner.check(conversationId);
            const live = presentation.current;
            if (live.visible && !live.blocked && live.activeId === conversationId && (document.activeElement === origin || document.activeElement === document.body)) composer.current?.focus();
          }}>{t("check")}</Button>
            {input.outcome === "absent" && replayable ? <Button size="sm" disabled={blocked || (!!input.busy || input.journalBusy)} onClick={() => {
              const conversationId = activeId!;
              const current = () => {
                const live = presentation.current;
                return live.visible && !live.blocked && live.activeId === conversationId &&
                  live.viewId === viewId && live.parentDialogId === parentDialogId &&
                  gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
              };
              if (current()) void owner.retry(conversationId, current);
            }}>{t(runPending ? "runRetryOriginal" : "retryOriginal")}</Button> : null}</div>
        </Banner> : null}</section> : null}
        <ConversationContextChips selection={input.planning.selection} filter={contextFilter} disabled={blocked || !visible || !!input.planning.busy}
          remove={() => { if (!blocked && visible && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })) owner.setPlanningSelection(activeId!, null); }}/>
        <div className={local.actions}><Menu label={t("composerCommands")} trigger={<Button size="sm" disabled={blocked || !visible || !!pending}>{t("composerCommands")}</Button>}
          items={assistantComposerCommands.map(command => ({ id: command.id, label: global(command.nameKey), onSelect: () => commands ? commands.dispatch(command.id, commandScope) : chooseCommand(command) }))}/>
          <Menu label={t("composerMembers")} trigger={<Button size="sm" disabled={blocked || !visible || ![...memberRoutes.values()].some(routes => routes.some(route => route.current()))}>{t("composerMembers")}</Button>}
            items={[...memberRoutes.values()].flat().map(route => ({ id: route.key, label: t("composerMemberChoice", { member: route.name, plan: route.plan }), disabled: !route.current(), onSelect: () => { if (visible && !blocked && route.current() && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })) route.open(); } }))}/></div>
        <p className={local.notice}>{t("composerCommandHelp")}</p><p className={local.notice}>{t("composerMemberHelp")}</p>
        <Field label={t("message")} error={byteLength > 8192 ? t("messageTooLong") : undefined} description={t("localOnly")}>
          <TextArea ref={composer} className={local.composerInput} rows={2} value={input.value.text} readOnly={blocked} placeholder={t("placeholder")}
            onFocus={() => gate.setInputOwner(viewId, "conversation-composer")} onBlur={() => { composing.current = false; gate.releaseOwner("conversation-composer"); }}
            onCompositionStart={() => { composing.current = true; gate.setInputOwner(viewId, "conversation-composer"); gate.setComposing("conversation-composer", true); }}
            onCompositionEnd={() => { composing.current = false; gate.setComposing("conversation-composer", false); }}
            onChange={event => owner.edit(activeId!, event.target.value)} onKeyDown={event => {
              if (event.key !== "Enter" || event.altKey || event.shiftKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
              if (!gate.canDispatch({ viewId, source: "keyboard", inputOwner: "conversation-composer", dialogId: parentDialogId })) return;
              event.preventDefault(); event.stopPropagation(); if (!blocked) void saveComposer();
            }}/>
        </Field>
      </div>
      <div className={styles.composerFooter}><span role="status">{t(input.failure?.kind === "journal" ? "inputUnsaved" : input.busy === "submit" ? runPending ? "runSending" : pending?.kind === "planning" ? "askStarting" : pending?.kind === "proposal-work-plan" ? "planConfirming" : pending?.kind === "proposal-capture" || pending?.kind === "proposal-revision" ? "proposalSaving" : "savingMessage" : input.busy === "check" ? input.runBusy ? "runChecking" : pending ? "checking" : "proposalChecking" : input.journalBusy || input.dirty ? "savingInput" : "inputSaved")}</span>
        <Button variant="secondary" size="sm" disabled={blocked || (!!input.busy || input.journalBusy) || !!input.planning.busy || !!pending || !!input.failure || !isConversationMessageText(input.value.text)}
          onClick={() => void saveComposer()}>{t("saveMessage")}</Button></div>
    </div> : null}
  </div></ConversationMemberRoutes.Provider>;
}
