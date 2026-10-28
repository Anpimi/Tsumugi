import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, MessageSquare, Plus, RefreshCw, Sparkles } from "lucide-react";
import { conversationCommands, isConversationMessageText } from "../../../conversationCommands";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import { Button, IconButton } from "../../../design-system/Button";
import { Field, TextArea } from "../../../design-system/Field";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { Menu } from "../../../design-system/Menu";
import { useSessionInfiniteQuery, useSessionQuery } from "../../../SessionReadProvider";
import type { SessionRequest } from "../../../executionCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ConversationSession } from "./ConversationSession";
import styles from "../../WorkbenchLayout.module.css";
import local from "./ConversationPanel.module.css";

interface Props { owner: ConversationSession; visible: boolean; disabled: boolean; gate: InteractionGate; viewId: string | null; parentDialogId?: string }
const noNext = (last: { nextAfter: string | null }) => last.nextAfter ?? undefined;

function PlanningResult({ context, conversationId, attemptId, visible }: { context: SessionRequest; conversationId: string; attemptId: string; visible: boolean }) {
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
    <h3><Sparkles className={styles.ai}/>{t(output?.kind === "proposal" ? "proposal" : "reply")}</h3>
    {output ? <><div className={local.text}>{output.summary}</div>
      {output.kind === "proposal" ? <p className={styles.meta}>{t("proposalScope", { count: output.unitIds.length })}</p> : null}
      {output.questions.length ? <ul>{output.questions.map((question, index) => <li key={index}>{question}</li>)}</ul> : null}
      <Button size="sm" aria-expanded={materialOpen} aria-controls={materialId} onClick={() => setMaterialOpen(open => !open)}>{t("sentMaterial")}</Button>
      {materialOpen ? <div id={materialId}><p>{t("materialScope", { messages: run.preview.selectedMessages.length, units: run.preview.units.length })}</p>
        <pre className={local.text}>{run.preview.system}</pre><pre className={local.text}>{run.preview.input}</pre></div> : null}
    </> : <p>{t(unavailable)}</p>}
    <Button size="sm" onClick={() => void query.refetch()} pending={query.isFetching}>{t("refreshReply")}</Button>
  </section>;
}

function ThreadHistory({ context, conversationId, visible }: { context: SessionRequest; conversationId: string; visible: boolean }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const messages = useSessionInfiniteQuery({ key: ["conversation", conversationId, "messages"], scopes: ["project"], enabled: visible,
    initialPageParam: null as string | null, nextPage: noNext,
    read: after => conversationCommands.messages({ ...context, conversationId, after, limit: 50 }) });
  const attempts = useSessionInfiniteQuery({ key: ["conversation", conversationId, "attempts"], scopes: ["project", "execution"], enabled: visible,
    initialPageParam: "0", nextPage: noNext,
    read: after => conversationCommands.planningAttempts({ ...context, conversationId, after, limit: 50 }) });
  const saved = messages.data?.pages.flatMap(page => page.rows) ?? [];
  const runs = attempts.data?.pages.flatMap(page => page.rows) ?? [];
  return <>
    {messages.isPending ? <LoadingState label={t("readingMessages")}/> : messages.isError ? <ErrorState title={t("messagesReadFailed")}
      action={<Button onClick={() => void messages.refetch()}>{t("retryRead")}</Button>}/> : saved.length === 0 ? <p className={styles.meta}>{t("emptyThread")}</p>
      : <section aria-label={t("savedMessages")} className={local.history}>{saved.map(message => <div key={message.messageId} className={styles.userMessage}>
        <span className={local.author}>{t("you")}</span><p className={local.text}>{message.body}</p></div>)}</section>}
    {messages.hasNextPage ? <Button pending={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>{t("moreMessages")}</Button> : null}
    {attempts.isError ? <Banner tone="error" action={<Button size="sm" onClick={() => void attempts.refetch()}>{t("retryRead")}</Button>}>{t("repliesReadFailed")}</Banner> : null}
    {runs.length ? <section aria-label={t("savedReplies")} className={local.history}>{runs.map(run => <PlanningResult key={run.attemptId} context={context}
      conversationId={conversationId} attemptId={run.attemptId} visible={visible}/>)}</section> : null}
    {attempts.hasNextPage ? <Button pending={attempts.isFetchingNextPage} onClick={() => void attempts.fetchNextPage()}>{t("moreReplies")}</Button> : null}
  </>;
}

export default function ConversationPanel({ owner, visible, disabled, gate, viewId, parentDialogId }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const activeId = state.activeId, input = activeId ? state.inputs.get(activeId) : undefined;
  const composer = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const threads = useSessionInfiniteQuery({ key: ["conversations"], scopes: ["project"], enabled: visible,
    initialPageParam: null as string | null, nextPage: noNext,
    read: after => conversationCommands.list({ ...owner.context, after, limit: 50 }) });
  const saved = threads.data?.pages.flatMap(page => page.rows) ?? [];
  const known = new Map(saved.map(thread => [thread.conversationId, thread.title ?? t("threadNumber", { number: thread.ordinal })]));
  state.summaries.forEach((summary, index) => { if (!known.has(summary.key.conversationId)) known.set(summary.key.conversationId, t("retainedInput", { number: index + 1 })); });
  for (const [id] of state.inputs) if (!known.has(id)) known.set(id, t("untitled"));
  const blocked = disabled || state.retired;
  const byteLength = new TextEncoder().encode(input?.value.text ?? "").length;
  const pending = input?.value.pending;
  const exists = pending?.kind !== "create" || input?.outcome === "recorded";
  useEffect(() => () => gate.releaseOwner("conversation-composer"), [gate]);
  useEffect(() => { if (!visible) { composing.current = false; gate.releaseOwner("conversation-composer"); } }, [gate, visible]);
  return <div className={styles.agent}>
    <div className={styles.agentHeader}><span>{t("lead")}</span>
      <div className={local.actions}><IconButton label={t("refresh")} disabled={blocked} onClick={() => { void threads.refetch(); void owner.initialize(); }}><RefreshCw/></IconButton>
        <IconButton label={t("newThread")} disabled={blocked || state.hydration !== "ready"} onClick={() => { void owner.create(); requestAnimationFrame(() => composer.current?.focus()); }}><Plus/></IconButton></div>
    </div>
    <div className={local.picker}><Menu label={t("chooseThread")} align="start" trigger={<Button className={local.threadButton} variant="secondary" aria-label={t("chooseThread")} disabled={blocked || known.size === 0}>
      <span>{activeId ? known.get(activeId) : t("chooseThreadPlaceholder")}</span><ChevronDown/></Button>}
      items={[...known].map(([id, title]) => ({ id, label: title, onSelect: () => { void owner.open(id); } }))}/>
      {threads.hasNextPage ? <Button size="sm" pending={threads.isFetchingNextPage} onClick={() => void threads.fetchNextPage()}>{t("moreThreads")}</Button> : null}
      {state.next ? <Button size="sm" pending={state.hydration === "loading"} onClick={() => void owner.initialize(true)}>{t("moreDrafts")}</Button> : null}
    </div>
    <div className={styles.messages}>
      {threads.isError ? <Banner tone="error" action={<Button size="sm" onClick={() => void threads.refetch()}>{t("retryRead")}</Button>}>{t("threadsReadFailed")}</Banner> : null}
      {state.hydration === "failed" ? <Banner tone="error" action={<Button size="sm" onClick={() => void owner.initialize()}>{t("retryRead")}</Button>}>{t("draftsReadFailed")}<CommandFailureDetails failure={state.failure}/></Banner> : null}
      {!activeId ? <EmptyState icon={<MessageSquare/>} title={t("welcome")} description={t("welcomeHelp")}
        action={<Button variant="secondary" disabled={blocked || state.hydration !== "ready"} onClick={() => void owner.create()}>{t("newThread")}</Button>}/>
        : !input ? state.inputFailure?.conversationId === activeId ? <ErrorState title={t("inputReadFailed")} description={<CommandFailureDetails failure={state.inputFailure.cause}/>} action={<Button onClick={() => void owner.open(activeId)}>{t("retryRead")}</Button>}/>
          : <LoadingState label={t("readingInput")}/> : exists ? <ThreadHistory key={activeId} context={owner.context} conversationId={activeId} visible={visible}/> : <p role="status">{t("creatingThread")}</p>}
    </div>
    {input ? <div className={styles.composer}>
      {input.notice ? <p role="status" className={local.notice}>{t(input.notice)}</p> : null}
      {input.failure?.kind === "journal" ? <Banner tone="error"><p>{t("journalFailed")}</p><CommandFailureDetails failure={input.failure.cause}/>
        <Button size="sm" disabled={blocked || !!input.busy} onClick={() => void owner.retryJournal(activeId!)}>{t("retryJournal")}</Button></Banner> : null}
      {pending && !input.busy && input.failure?.kind !== "journal" ? <Banner tone={input.outcome === "mismatch" ? "error" : "warning"}>
        <p>{t(input.outcome === "absent" ? "absent" : input.outcome === "mismatch" ? "mismatch" : input.outcome === "recorded" ? "finishing" : "pending")}</p>
        <CommandFailureDetails failure={input.failure?.cause ?? null}/>
        <div className={local.actions}><Button size="sm" disabled={blocked || !!input.busy} onClick={() => void owner.check(activeId!)}>{t("check")}</Button>
          {input.outcome === "absent" ? <Button size="sm" disabled={blocked || !!input.busy} onClick={() => void owner.retry(activeId!)}>{t("retryOriginal")}</Button> : null}</div>
      </Banner> : null}
      <Field label={t("message")} error={byteLength > 8192 ? t("messageTooLong") : undefined} description={t("localOnly")}>
        <TextArea ref={composer} rows={3} value={input.value.text} readOnly={blocked} placeholder={t("placeholder")}
          onFocus={() => gate.setInputOwner(viewId, "conversation-composer")} onBlur={() => { composing.current = false; gate.releaseOwner("conversation-composer"); }}
          onCompositionStart={() => { composing.current = true; gate.setInputOwner(viewId, "conversation-composer"); gate.setComposing("conversation-composer", true); }}
          onCompositionEnd={() => { composing.current = false; gate.setComposing("conversation-composer", false); }}
          onChange={event => owner.edit(activeId!, event.target.value)} onKeyDown={event => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
            if (!gate.canDispatch({ viewId, source: "keyboard", inputOwner: "conversation-composer", dialogId: parentDialogId })) return;
            event.preventDefault(); event.stopPropagation(); if (!blocked) void owner.append(activeId!);
          }}/>
      </Field>
      <div className={styles.composerFooter}><span role="status">{t(input.failure?.kind === "journal" ? "inputUnsaved" : input.busy === "submit" ? "savingMessage" : input.busy === "check" ? "checking" : input.busy === "journal" || input.dirty ? "savingInput" : "inputSaved")}</span>
        <Button variant="secondary" size="sm" disabled={blocked || !!input.busy || !!pending || !!input.failure || !isConversationMessageText(input.value.text)}
          onClick={() => void owner.append(activeId!)}>{t("saveMessage")}</Button></div>
    </div> : null}
  </div>;
}
