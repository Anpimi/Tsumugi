import { Disclosure } from "../../../design-system/Disclosure";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiView } from "../../../aiCommands";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "../../../CommandFailure";
import type { SessionRequest } from "../../../executionCommands";
import type { AiRow, WorkPlanStartReceipt } from "../../../generated/ai.responses";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import type { WorkPlanView } from "../../../workPlanCommands";
import { Button } from "../../../design-system/Button";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { ConversationPlanLink } from "./conversationRun";
import { conversationRunCandidateTarget, readConversationRunResults, type OpenConversationRunCandidate } from "./conversationRunResultReads";
import styles from "./ConversationRunResults.module.css";

interface Props {
  context: SessionRequest; link: ConversationPlanLink; plan: WorkPlanView; start: WorkPlanStartReceipt;
  visible: boolean; canRead: () => boolean; onOpenCandidate?: OpenConversationRunCandidate;
}
const pageSize = 25;
const executionKeys = {
  queued: "runResultsQueued", dispatched: "runResultsDispatched", succeeded: "runResultsReturned", failed: "runResultsRequestFailed",
  "cancelled-before-dispatch": "runResultsCancelled", unknown: "runResultsUnknown",
} as const;
const validationKeys = {
  absent: "runResultsValidationAbsent", pending: "runResultsValidationPending", valid: "runResultsValidationValid", invalid: "runResultsValidationInvalid",
} as const;

function ReturnedText({ row }: { row: AiRow }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const [expanded, setExpanded] = useState(false);
  if (row.output === null) return null;
  return <Disclosure onToggle={event => setExpanded(event.currentTarget.open)} title={<>{t("runResultsFullText")}</>}>

    {expanded ? row.output.text === "" ? <p>{t("runResultsEmptyTranslation")}</p>
      : <p className={styles.text}><TokenizedText text={row.output.text} tone="ai"/></p> : null}
  </Disclosure>;
}

/** Expansion owns a read-only snapshot, never execution or candidate permission. */
export function ConversationRunResults(props: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const identity = JSON.stringify([props.context.projectId, props.context.sessionToken, props.link, props.plan, props.start]);
  const [openFor, setOpenFor] = useState<string | null>(null), id = useId(), expanded = openFor === identity;
  const trigger = useRef<HTMLButtonElement>(null), body = useRef<HTMLDivElement>(null);
  return <section className={styles.panel} hidden={!props.visible} aria-label={t("runResultsTitle")}>
    <div><Button ref={trigger} size="sm" aria-expanded={expanded} aria-controls={id} disabled={!props.visible} onClick={() => {
      if (!props.visible || !props.canRead()) return;
      if (expanded && body.current?.contains(document.activeElement)) trigger.current?.focus();
      setOpenFor(expanded ? null : identity);
    }}>{t(expanded ? "runResultsHide" : "runResultsShow")}</Button></div>
    <div id={id} ref={body} hidden={!expanded}>
      {expanded && props.visible ? <RunResultsRead key={identity} {...props} identity={identity}/> : null}
    </div>
  </section>;
}

function RunResultsRead({ context, link, plan, start, visible, canRead, onOpenCandidate, identity }: Props & { identity: string }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" }), { t: global } = useTranslation();
  const reads = useSessionReads(), id = useId();
  const mounted = useRef(false), live = useRef({ visible, identity, canRead, onOpenCandidate });
  const navigation = useRef<{ itemId: string; dispose: () => void } | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null), [page, setPage] = useState(0);
  const [feedback, setFeedback] = useState<{ itemId: string; cause: CommandFailure | null } | null>(null);
  const resultRegion = useRef<HTMLElement>(null), failureRegion = useRef<HTMLDivElement>(null), navigationFailureRegion = useRef<HTMLDivElement>(null);
  const readFocus = useRef<{ origin: HTMLElement | null } | null>(null), failureFocus = useRef<HTMLElement | null>(null), pageFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { live.current = { visible, identity, canRead, onOpenCandidate }; });
  useLayoutEffect(() => {
    mounted.current = true;
    readFocus.current = { origin: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    return () => { mounted.current = false; navigation.current?.dispose(); navigation.current = null; };
  }, []);
  const key = ["conversation-run-results", link.conversationId, plan.planId, plan.digest,
    start.actionId, start.expectedGeneration, start.taskId, start.attemptId] as const;
  const read = useSessionQuery({ key, scopes: ["execution", "source", "translation", "review"], enabled: visible,
    // Navigation may retain the exact decoded row while checking its origin.
    structuralSharing: false,
    read: () => readConversationRunResults(context, link, plan, start) });
  const view = !read.error ? read.data ?? null : null;
  const present = () => mounted.current && live.current.visible && live.current.identity === identity && !reads.retired
    && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken && live.current.canRead();
  function currentView(expected: AiView) {
    const query = reads.client.getQueryState<AiView>(reads.key(key));
    return present() && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null && query.data === expected;
  }
  const fresh = !!view && currentView(view);
  const pageCount = view ? Math.max(1, Math.ceil(view.rows.length / pageSize)) : 1, currentPage = Math.min(page, pageCount - 1);
  const rows = view?.rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize) ?? [];
  const statuses = new Map(view?.detail.items.map(item => [item.status.itemId, item]) ?? []);
  function shouldFocus(origin: HTMLElement | null) { return document.activeElement === origin; }
  useLayoutEffect(() => {
    const pending = readFocus.current;
    if (!pending || read.isPending || read.isFetching) return;
    readFocus.current = null;
    if (present() && shouldFocus(pending.origin)) (read.error ? failureRegion.current : resultRegion.current)?.focus();
  }, [read.isPending, read.isFetching, read.dataUpdatedAt, read.errorUpdatedAt]);
  useLayoutEffect(() => {
    const origin = failureFocus.current;
    failureFocus.current = null;
    if (feedback && origin && present() && shouldFocus(origin)) navigationFailureRegion.current?.focus();
  }, [feedback]);
  useLayoutEffect(() => {
    const origin = pageFocus.current;
    pageFocus.current = null;
    if (origin && present() && shouldFocus(origin)) resultRegion.current?.focus();
  }, [currentPage]);
  function refresh(origin: HTMLElement) {
    if (!present() || read.isFetching || navigation.current) return;
    const focusOwner = shouldFocus(origin) ? read.error ? failureRegion.current : resultRegion.current : null;
    focusOwner?.focus(); readFocus.current = { origin: focusOwner ?? origin }; setFeedback(null);
    void read.refetch();
  }
  function changePage(next: number, origin: HTMLElement) {
    if (!view || !currentView(view) || navigation.current || next < 0 || next >= pageCount) return;
    const focusOwner = shouldFocus(origin) ? resultRegion.current : null;
    focusOwner?.focus(); pageFocus.current = focusOwner ?? origin; setFeedback(null); setPage(next);
  }
  async function openCandidate(row: AiRow, origin: HTMLElement) {
    const callback = onOpenCandidate, expected = view;
    if (!callback || !expected || !currentView(expected) || navigation.current || !expected.rows.includes(row)) return;
    const target = conversationRunCandidateTarget(link, start, row);
    if (!target) return;
    const witness = reads.watchExactQuery(key), original = witness.current(), version = original?.state.dataUpdateCount;
    const flight = { itemId: row.itemId, dispose: () => witness.dispose() };
    const focusOwner = shouldFocus(origin) ? resultRegion.current : null;
    focusOwner?.focus();
    const current = () => navigation.current === flight && live.current.onOpenCandidate === callback && currentView(expected)
      && witness.current() === original && original?.state.dataUpdateCount === version && expected.rows.includes(row);
    navigation.current = flight; setBusyItem(row.itemId); setFeedback(null);
    try {
      if (!current()) return;
      const opened = await callback(target, current);
      if (current() && !opened) { failureFocus.current = focusOwner ?? origin; setFeedback({ itemId: row.itemId, cause: null }); }
    } catch (error) {
      if (current()) { failureFocus.current = focusOwner ?? origin; setFeedback({ itemId: row.itemId, cause: commandFailure(error) }); }
    } finally {
      flight.dispose();
      if (navigation.current === flight) { navigation.current = null; if (mounted.current) setBusyItem(null); }
    }
  }
  return <div className={styles.body} onClickCapture={event => { if (!present()) { event.preventDefault(); event.stopPropagation(); } }}>
    <p>{t("runResultsReadHelp")}</p>
    <div className={styles.actions}><Button size="sm" pending={read.isFetching} disabled={!present() || !!busyItem}
      onClick={event => refresh(event.currentTarget)}>{t("runResultsRefresh")}</Button></div>
    {read.isPending ? <LoadingState label={t("runResultsLoading")}/> : null}
    {read.error ? <Banner ref={failureRegion} tabIndex={-1} tone="error" role="alert"><p>{t("runResultsReadFailed")}</p>
      <CommandFailureDetails failure={commandFailure(read.error)}/>
      <Button size="sm" disabled={!present() || read.isFetching || !!busyItem} onClick={event => refresh(event.currentTarget)}>{t("runResultsRecoverRead")}</Button>
    </Banner> : null}
    {view ? <section ref={resultRegion} tabIndex={-1} className={styles.results} aria-labelledby={`${id}-title`}>
      <h5 id={`${id}-title`}>{t("runResultsTitle")}</h5>
      <p>{t("runResultsSummary", { total: view.rows.length, returned: view.rows.filter(row => row.output !== null).length,
        saved: view.rows.filter(row => row.savedRevisionId !== null).length })}</p>
      <p>{t("runResultsMeaning")}</p>
      {!fresh ? <p role="status">{t("runResultsStale")}</p> : null}
      {busyItem ? <p role="status">{t("runResultsOpeningCandidate")}</p> : null}
      {feedback ? <Banner ref={navigationFailureRegion} tabIndex={-1} tone="warning" role="alert"><p>{t("runResultsOpenFailed")}</p>
        {feedback.cause ? <CommandFailureDetails failure={feedback.cause}/> : null}
        <Button size="sm" disabled={!present() || read.isFetching || !!busyItem} onClick={event => refresh(event.currentTarget)}>{t("runResultsRecoverRead")}</Button>
      </Banner> : null}
      {view.rows.length === 0 ? <p>{t("runResultsEmpty")}</p> : <ol className={styles.rows} start={currentPage * pageSize + 1}>
        {rows.map(row => {
          const item = statuses.get(row.itemId), output = row.output, target = onOpenCandidate ? conversationRunCandidateTarget(link, start, row) : null;
          const decision = row.candidateDecision, effect = row.automation;
          return <li key={row.itemId}><article className={styles.row}>
            <h6><TokenizedText text={row.item.nativeKey || t("runResultsUnnamedEntry")}/></h6>
            {item ? <><p>{t(executionKeys[item.status.execution])}</p><p>{t(validationKeys[item.status.validation])}</p>
              {item.status.adoption === "conflict" ? <p>{t("runResultsSaveConflict")}</p> : item.status.adoption === "rejected" ? <p>{t("runResultsSaveRejected")}</p> : null}
              {item.status.cancellationRequested ? <p>{t("runResultsCancellationRequested")}</p> : null}
            </> : <p>{t("runResultsStateUnavailable")}</p>}
            {output !== null ? <><p>{t(row.savedRevisionId !== null ? "runResultsSaved" : "runResultsNotSaved")}</p><ReturnedText row={row}/></>
              : <p>{t("runResultsNoText")}</p>}
            {effect ? <div className={styles.processing}><p>{global(`ai.effects.phases.${effect.phase}`)}</p>
              {effect.receipt?.blocked ? <p>{global(`ai.effects.blocks.${effect.receipt.blocked}`)}</p> : null}
              {effect.error ? <Disclosure title={<>{t("runResultsProcessingDetails")}</>}><CommandFailureDetails failure={effect.error}/></Disclosure> : null}
            </div> : null}
            {decision ? <div className={styles.decision}><p>{t(decision.request.disposition === "rejected" ? "runResultsCandidateRejected" : "runResultsCandidateRestored")}</p>
              {decision.request.reason ? <Disclosure title={<>{t("runResultsDecisionReason")}</>}><p className={styles.text}><TokenizedText text={decision.request.reason}/></p></Disclosure> : null}
            </div> : null}
            {target ? <div className={styles.actions}><Button size="sm" pending={busyItem === row.itemId} disabled={!fresh || !!busyItem}
              onClick={event => void openCandidate(row, event.currentTarget)}>{t("runResultsOpenCandidate")}</Button></div> : null}
          </article></li>;
        })}
      </ol>}
      {pageCount > 1 ? <nav className={styles.pagination} aria-label={t("runResultsPagination")}>
        <p>{t("runResultsPage", { page: currentPage + 1, pages: pageCount })}</p><div className={styles.actions}>
          <Button size="sm" disabled={!fresh || !!busyItem || currentPage === 0} onClick={event => changePage(currentPage - 1, event.currentTarget)}>{t("runResultsPrevious")}</Button>
          <Button size="sm" disabled={!fresh || !!busyItem || currentPage + 1 >= pageCount} onClick={event => changePage(currentPage + 1, event.currentTarget)}>{t("runResultsNext")}</Button>
        </div>
      </nav> : null}
    </section> : null}
  </div>;
}
