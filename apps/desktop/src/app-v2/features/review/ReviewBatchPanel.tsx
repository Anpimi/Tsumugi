import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { matchQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import { executionContext } from "../../../executionCommands";
import { REVIEW_BATCH_PREPARE_LIMIT, type ReviewDraftState } from "../../../ReviewDraftSession";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import type { CommandAvailability } from "../../../workbenchCommands";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Field, TextInput } from "../../../design-system/Field";
import { Banner, EmptyState, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { copyWorkspaceSelection, workspaceSelectionIds, type WorkspaceSelection } from "../../workspace/workspaceSelection";
import { readReviewBatch } from "./reviewBatchReads";
import type { RetainedReviewPendingPayload } from "./reviewTypes";
import type { ReviewBatchApprovePayload, ReviewBatchControlPayload, ReviewBatchPagePayload, ReviewBatchPanelProps, ReviewBatchReadPayload, ReviewBatchReadRequest } from "./batchTypes";
import ReviewBatchSemanticPanel, { type SemanticBatchReadRequest, type SemanticBatchBinding } from "./ReviewBatchSemanticPanel";
import styles from "./ReviewBatchPanel.module.css";

const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" }, pageSize = 50;
type ReadIntent = { request: ReviewBatchReadRequest; chosen: ReviewDraftState["chosen"]; items: ReviewDraftState["batchItems"] };
const statusKeys = { "not-started": "reviewBatchNotStarted", pending: "reviewBatchPending", recorded: "reviewBatchRecorded",
  conflicted: "reviewBatchConflict", failed: "reviewBatchFailed" } as const;

/** The project owner keeps the approval plan. Closing only hides this view. */
export default function ReviewBatchPanel({ project, owner, selection, commands, gate, viewId, disabled, open, onOpenChange, parentDialogId, returnFocusRef, drafts }: ReviewBatchPanelProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), reads = useSessionReads(), state = owner.state;
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const context = executionContext(project), scope = { ...context, area: "translation" as const }, dialogId = "review-batch", inputOwner = `review-batch-${useId()}`;
  const identity = JSON.stringify([context.projectId, context.sessionToken, viewId, parentDialogId]);
  const live = useRef({ identity, open, disabled }), mounted = useRef(false), closing = useRef(false), serial = useRef(0), opening = useRef(false);
  const release = useRef<(() => void) | null>(null), closeButton = useRef<HTMLButtonElement>(null), pageRegion = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<{ identity: string; element: HTMLElement | null } | null>(null), pageFocus = useRef<{ identity: string; serial: number | null } | null>(null);
  const [intent, setIntent] = useState<ReadIntent | null>(null), [page, setPage] = useState(0), [stopRequested, setStopRequested] = useState(false);
  const [semanticOpen, setSemanticOpen] = useState(false), [semanticRequest, setSemanticRequest] = useState<SemanticBatchReadRequest | null>(null);
  const semanticBinding = useRef<SemanticBatchBinding | null>(null);
  const [semanticLocales, setSemanticLocales] = useState<string[] | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const intentRef = useRef(intent); useLayoutEffect(() => { intentRef.current = intent; live.current = { identity, open, disabled }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function present(inDialog = true) {
    return mounted.current && !disabled && !reads.retired && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
      && gate.getSnapshot().visibleViewId === viewId && (!inDialog || open && !closing.current)
      && gate.canDispatch({ viewId, source: "button", dialogId: open ? dialogId : parentDialogId });
  }
  function stillPresent() { return present() && live.current.identity === identity && live.current.open && !live.current.disabled; }
  function inputAllowed() { const interaction = gate.getSnapshot(); return mounted.current && open && !disabled && !closing.current && !reads.retired
    && gate.getSnapshot().visibleViewId === viewId && !interaction.intentOwner && interaction.dialogs.at(-1) === dialogId; }
  function idle() { const current = owner.current(); return !owner.inFlight() && !current.pending && !current.batchRunning && !current.busyMutation && !owner.semantic.reserved(); }
  function sameControl(payload: ReviewBatchControlPayload | ReviewBatchPagePayload | undefined) {
    const current = owner.current(); return !!payload && payload.chosen === current.chosen && payload.items === current.batchItems;
  }
  function readSelection(): WorkspaceSelection | null {
    const remaining = Object.values(owner.current().chosen);
    if (remaining.length) return { kind: "ids", locale: remaining[0].locale, sourceSnapshotId: remaining[0].sourceSnapshotId, unitIds: remaining.map(item => item.unitId) };
    const current = owner.current();
    return current.batchItems.length && !current.batchEnded ? null : copyWorkspaceSelection(selection);
  }
  function freezeRead() {
    if (!idle()) return;
    const selected = readSelection(), chosen = owner.current().chosen;
    if (!selected || workspaceSelectionIds(selected).length > REVIEW_BATCH_PREPARE_LIMIT || !workspaceSelectionIds(selected).length) return;
    const expected = Object.values(chosen), request: ReviewBatchReadRequest = { serial: ++serial.current, selection: selected,
      ...(expected.length ? { expected } : {}) };
    setIntent({ request, chosen, items: owner.current().batchItems }); setPage(0); setActionFailed(false);
  }
  useLayoutEffect(() => {
    if (!open) { opening.current = false; return; }
    closing.current = false;
    if (!release.current) release.current = gate.pushDialog(dialogId);
    if (!opening.current) {
      opening.current = true;
      const current = owner.current();
      if (!semanticOpen && (!current.batchItems.length || current.batchEnded)) freezeRead();
    }
    return () => { release.current?.(); release.current = null; gate.releaseOwner(inputOwner); };
  }, [open, identity, gate, inputOwner]);
  useLayoutEffect(() => () => gate.releaseOwner(inputOwner), [gate, identity, inputOwner]);
  function hide() {
    if (closing.current) return;
    closing.current = true; release.current?.(); release.current = null; gate.releaseOwner(inputOwner); onOpenChange(false);
  }
  const request = intent?.request ?? null, queryKey = ["review-batch", request] as const;
  // A dispatched request consumes this preview. Keep it readable without
  // refreshing its old decision basis in response to its own saved approvals.
  const consumed = state.batchItems.some(item => item.request !== null && !intent?.items.some(original => original.request === item.request));
  const query = useSessionQuery({ key: queryKey, scopes: ["source", "translation", "resources", "review"], enabled: open && request !== null && !reads.retired
      && !consumed,
    read: () => { if (!request) throw new Error("Review batch requires a fixed selection");
      return readReviewBatch({ context, selection: request.selection, ...(request.expected ? { expected: request.expected } : {}) }, () => !reads.retired); } });
  const keyIdentity = JSON.stringify(queryKey);
  const observed = useMemo(() => {
    const cache = reads.client.getQueryCache(), filter = { queryKey: reads.key(queryKey), exact: true };
    return { subscribe: (changed: () => void) => cache.subscribe(event => { if ((event.type === "updated" || event.type === "removed") && matchQuery(filter, event.query)) changed(); }),
      snapshot: () => cache.find(filter)?.state };
  }, [reads, keyIdentity]);
  const record = useSyncExternalStore(observed.subscribe, observed.snapshot, observed.snapshot);
  function currentRead() {
    const current = reads.client.getQueryCache().find({ queryKey: reads.key(queryKey), exact: true });
    return !!request && intentRef.current?.request === request && !!current && !reads.retired && current.state.status === "success" && current.state.error === null
      && current.state.fetchStatus === "idle" && !current.state.isInvalidated && current.state.data === query.data;
  }
  function canRead(payload: ReviewBatchReadPayload | undefined): CommandAvailability {
    return present() && idle() && !!payload && payload.chosen === owner.current().chosen && payload.request === (intentRef.current?.request ?? null)
      && !!readSelection() && workspaceSelectionIds(readSelection()).length <= REVIEW_BATCH_PREPARE_LIMIT && !query.isFetching ? { enabled: true } : unavailable;
  }
  function canApprove(payload: ReviewBatchApprovePayload | undefined): CommandAvailability {
    const current = owner.current();
    return !semanticOpen && present() && idle() && currentRead() && !!payload && intent?.chosen === current.chosen && payload.chosen === current.chosen
      && payload.request === request && record?.dataUpdateCount === payload.queryVersion && payload.actor !== "" && payload.actor === current.actor.trim()
      && !!query.data?.targets.length && query.data.targets.length <= REVIEW_BATCH_PREPARE_LIMIT
      && query.data.targets.every(target => target.selectionId !== null && target.revisionId !== null && target.translationText !== null) ? { enabled: true } : unavailable;
  }
  async function approve(payload: ReviewBatchApprovePayload) {
    if (!canApprove(payload).enabled || !query.data) return;
    const witness = reads.watchExactQuery(queryKey), original = witness.current(), data = query.data;
    const proof = () => stillPresent() && intentRef.current?.request === payload.request && witness.current() === original && !!original
      && original.state.status === "success" && original.state.fetchStatus === "idle" && original.state.error === null && !original.state.isInvalidated
      && original.state.data === data && original.state.dataUpdateCount === payload.queryVersion;
    setActionFailed(false); setStopRequested(false);
    try {
      if (!Object.keys(payload.chosen).length && !owner.prepareBatch({ ...context, targets: data.targets, expectedChosen: payload.chosen }, proof)) { setActionFailed(true); return; }
      const chosen = owner.current().chosen;
      await owner.approveBatch({ chosen, actor: payload.actor }, proof);
    } finally { witness.dispose(); }
  }
  function canControl(payload: ReviewBatchControlPayload | undefined, action: "show" | "hide" | "stop" | "end"): CommandAvailability {
    const current = owner.current();
    if (!present(false) || !sameControl(payload)) return unavailable;
    if (action === "show") return !open ? { enabled: true } : unavailable;
    if (action === "hide") return open ? { enabled: true } : unavailable;
    if (action === "stop") return current.batchRunning ? { enabled: true } : unavailable;
    return idle() && !current.batchEnded && (!!current.batchItems.length || !!Object.keys(current.chosen).length) ? { enabled: true } : unavailable;
  }
  function canPage(payload: ReviewBatchPagePayload | undefined): CommandAvailability {
    const current = owner.current(), results = current.batchItems.length > 0 && (!current.batchEnded || !request);
    const count = results ? current.batchItems.length : query.data?.targets.length ?? 0;
    return present() && sameControl(payload) && !!payload && Number.isInteger(payload.offset) && payload.offset >= 0 && payload.offset % pageSize === 0
      && payload.offset <= Math.max(0, Math.floor((count - 1) / pageSize) * pageSize) ? { enabled: true } : unavailable;
  }
  function canPending(payload: RetainedReviewPendingPayload | undefined, retry: boolean): CommandAvailability {
    const current = owner.current(), pending = current.pending;
    return present() && !!payload && pending === payload.pending && pending?.kind === "decision" && current.batchItems.some(item => item.request === pending.request)
      && !owner.inFlight() && !current.checkingAction && !current.batchRunning && (!retry || current.retryAllowed) ? { enabled: true } : unavailable;
  }
  useLayoutEffect(() => {
    const meta = { category: "review" as const, scope, binding: null, confirmation: "none" as const };
    const remove = [
      commands.register({ ...meta, id: "review.batch-show", nameKey: "workbenchV2.reviewBatchShow", payloadKind: "review-batch-control", risk: "changes-view", availability: value => canControl(value, "show"), handler: value => { if (canControl(value, "show").enabled) onOpenChange(true); } }),
      commands.register({ ...meta, id: "review.batch-hide", nameKey: "workbenchV2.close", payloadKind: "review-batch-control", risk: "changes-view", availability: value => canControl(value, "hide"), handler: value => { if (canControl(value, "hide").enabled) hide(); } }),
      commands.register({ ...meta, id: "review.batch-read", nameKey: "workbenchV2.reviewBatchRead", payloadKind: "review-batch-read", risk: "reads-review", availability: canRead, handler: value => { if (canRead(value).enabled) freezeRead(); } }),
      commands.register({ ...meta, id: "review.batch-approve", nameKey: "workbenchV2.reviewBatchApprove", payloadKind: "review-batch-approve", risk: "writes-review", availability: canApprove, handler: value => { void approve(value); } }),
      commands.register({ ...meta, id: "review.batch-stop", nameKey: "workbenchV2.reviewBatchStop", payloadKind: "review-batch-control", risk: "changes-view", availability: value => canControl(value, "stop"), handler: value => { if (canControl(value, "stop").enabled) { owner.stopBatch(); setStopRequested(true); } } }),
      commands.register({ ...meta, id: "review.batch-end", nameKey: "workbenchV2.reviewBatchEnd", payloadKind: "review-batch-control", risk: "changes-view", availability: value => canControl(value, "end"), handler: value => { if (canControl(value, "end").enabled && owner.endBatch(value.chosen)) { setIntent(null); setPage(0); } } }),
      commands.register({ ...meta, id: "review.batch-page", nameKey: "workbenchV2.reviewBatchPages", payloadKind: "review-batch-page", risk: "changes-view", availability: canPage, handler: value => { if (canPage(value).enabled) { pageFocus.current = { identity, serial: request?.serial ?? null }; setPage(value.offset); } } }),
      commands.register({ ...meta, id: "review.batch-check", nameKey: "workbenchV2.entryReviewCheck", payloadKind: "retained-review-pending", risk: "reads-review", availability: value => canPending(value, false), handler: value => { if (canPending(value, false).enabled) void owner.checkPending(); } }),
      commands.register({ ...meta, id: "review.batch-retry", nameKey: "workbenchV2.entryReviewRetry", payloadKind: "retained-review-pending", risk: "retries-review-action", availability: value => canPending(value, true), handler: value => { if (canPending(value, true).enabled) void owner.retryPending(); } }),
    ]; return () => remove.forEach(dispose => dispose());
  });
  const control: ReviewBatchControlPayload = { kind: "review-batch-control", chosen: state.chosen, items: state.batchItems };
  const readPayload: ReviewBatchReadPayload = { kind: "review-batch-read", chosen: state.chosen, request };
  const approvePayload: ReviewBatchApprovePayload | null = request && record ? { kind: "review-batch-approve", chosen: state.chosen, actor: state.actor.trim(), request, queryVersion: record.dataUpdateCount } : null;
  const pendingPayload: RetainedReviewPendingPayload | null = state.pending ? { kind: "retained-review-pending", pending: state.pending } : null;
  const showingResults = state.batchItems.length > 0 && (!state.batchEnded || !request);
  const items = showingResults ? state.batchItems.map(item => {
    const captured = query.data?.targets.find(target => target.unitId === item.target.unitId && target.locale === item.target.locale && target.basis === item.target.basis);
    return { target: item.target, source: captured?.sourceText ?? item.target.sourcePreview, text: captured ? captured.translationText : item.target.translationPreview,
      status: item.status, failure: item.failure, summary: !captured, actor: item.receipt?.actor ?? item.request?.actor ?? null };
  }) : query.data?.targets.map(target => ({ target, source: target.sourceText, text: target.translationText, status: "not-started" as const, failure: null, summary: false, actor: null })) ?? [];
  const maxOffset = Math.max(0, Math.floor((items.length - 1) / pageSize) * pageSize), offset = Math.min(page, maxOffset), rows = items.slice(offset, offset + pageSize);
  const previous: ReviewBatchPagePayload = { kind: "review-batch-page", chosen: state.chosen, items: state.batchItems, offset: offset - pageSize };
  const next: ReviewBatchPagePayload = { ...previous, offset: offset + pageSize };
  const remaining = Object.keys(state.chosen).length || (!showingResults ? query.data?.targets.length ?? 0 : 0);
  const selectedCount = workspaceSelectionIds(selection).length, tooMany = !Object.keys(state.chosen).length && selectedCount > REVIEW_BATCH_PREPARE_LIMIT && (!state.batchItems.length || state.batchEnded);
  const unselected = query.data?.targets.some(target => target.selectionId === null || target.revisionId === null || target.translationText === null) ?? false;
  const batchPending = state.pending?.kind === "decision" && state.batchItems.some(item => item.request === state.pending?.request);
  const stale = !!request && (!currentRead() || intent?.chosen !== state.chosen), resultKey = state.batchRunning ? "reviewBatchRunning" : state.pending ? "reviewBatchUnknown"
    : state.batchEnded ? "reviewBatchEnded" : showingResults && !Object.keys(state.chosen).length ? "reviewBatchComplete" : showingResults ? "reviewBatchPaused" : null;
  useLayoutEffect(() => {
    const ticket = pageFocus.current; if (!ticket) return; pageFocus.current = null;
    if (ticket.identity === identity && ticket.serial === (request?.serial ?? null) && stillPresent()) { pageRegion.current?.focus(); pageRegion.current?.scrollIntoView?.({ block: "nearest" }); }
  }, [offset, identity, request, gate]);
  const close = () => commands.dispatch("review.batch-hide", scope, control);
  function showResults() { if (stillPresent()) pageRegion.current?.focus(); }
  return <Dialog open={open} onOpenChange={value => { if (!value) close(); }} title={t("reviewBatchTitle")} description={t("reviewBatchHelp")} closeLabel={t("close")} className={styles.dialog}
    onOpenAutoFocus={event => { event.preventDefault(); returnFocus.current = { identity, element: document.activeElement instanceof HTMLElement ? document.activeElement : null };
      if (live.current.identity === identity && gate.getSnapshot().visibleViewId === viewId) closeButton.current?.focus(); }}
    onCloseAutoFocus={event => { event.preventDefault(); const ticket = returnFocus.current; returnFocus.current = null;
      if (!ticket || ticket.identity !== identity || live.current.identity !== identity || !gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })) return;
      const reachable = (element: HTMLElement | null | undefined) => !!element?.isConnected && element !== document.body && element !== document.documentElement
        && !element.closest('[hidden], [inert], [aria-hidden="true"]') && !element.matches(":disabled");
      const element = reachable(ticket.element) ? ticket.element : returnFocusRef?.current; if (reachable(element)) element?.focus(); }}
    onEscapeKeyDown={event => { event.preventDefault(); if (!event.isComposing && event.keyCode !== 229) close(); }}
    footer={<div className={styles.footer}><div className={styles.actions} aria-label={t("reviewBatchPages")}>
      <span className={styles.meta}>{t("reviewBatchPage", { page: offset / pageSize + 1, total: Math.max(1, Math.ceil(items.length / pageSize)) })}</span>
      <Button size="sm" disabled={offset === 0 || !canPage(previous).enabled} onClick={() => commands.dispatch("review.batch-page", scope, previous)}>{t("candidateBatchPrevious")}</Button>
      <Button size="sm" disabled={offset >= maxOffset || !canPage(next).enabled} onClick={() => commands.dispatch("review.batch-page", scope, next)}>{t("nextPage")}</Button></div>
      <div className={styles.actions}>{!semanticOpen && state.batchRunning ? <Button disabled={!canControl(control, "stop").enabled || stopRequested} onClick={() => commands.dispatch("review.batch-stop", scope, control)}>{t("reviewBatchStop")}</Button>
        : !semanticOpen && (showingResults || Object.keys(state.chosen).length) ? <Button disabled={!canControl(control, "end").enabled} onClick={() => commands.dispatch("review.batch-end", scope, control)}>{t("reviewBatchEnd")}</Button> : null}
        <Button ref={closeButton} disabled={!canControl(control, "hide").enabled} onClick={close}>{t("close")}</Button>
        {!semanticOpen && (state.batchRunning || remaining > 0 || !showingResults && selectedCount > 0) ? <Button variant="primary" pending={state.batchRunning} disabled={!approvePayload || !canApprove(approvePayload).enabled}
          onClick={() => { if (approvePayload && canApprove(approvePayload).enabled) { showResults(); commands.dispatch("review.batch-approve", scope, approvePayload); } }}>{state.batchRunning ? t("reviewBatchApproving")
            : state.actor.trim() && remaining > 0 ? t("reviewBatchConfirm", { count: remaining, actor: state.actor.trim() }) : t("reviewBatchApprove")}</Button> : null}
      </div></div>}>
    <div>{drafts ? <Button size="sm" disabled={!idle()} onClick={() => { if (idle() && owner.endBatch(owner.current().chosen))  { setSemanticOpen(value => !value); setSemanticRequest(null); setSemanticLocales(null); } }}>{t(semanticOpen ? "semanticBatchBack" : "semanticBatchSwitch")}</Button> : null}</div>
    {semanticOpen && drafts ? <ReviewBatchSemanticPanel project={project} owner={owner} selection={selection} commands={commands} gate={gate} viewId={viewId}
      disabled={disabled} open={open} onOpenChange={onOpenChange} drafts={drafts} request={semanticRequest} onRequest={setSemanticRequest} binding={semanticBinding}
      locales={semanticLocales ?? semanticRequest?.locales ?? [selection?.kind === "ids" ? selection.locale : selection?.selection.capture.locale ?? project.metadata.targetLocales[0]].filter((value): value is string => !!value)} onLocalesChange={setSemanticLocales}/>: null}
    <div hidden={semanticOpen} ref={pageRegion} tabIndex={-1} role="region" aria-label={t("reviewBatchResults")} className={`${styles.content} ${styles.pageRegion}`}>
      <p className={styles.meta}>{t("reviewBatchScope", { count: showingResults ? state.batchItems.length : selectedCount, locale: request?.selection.kind === "ids" ? request.selection.locale : request?.selection.selection.capture.locale ?? state.batchItems[0]?.target.locale ?? "" })}</p>
      {tooMany ? <Banner tone="warning">{t("reviewBatchLimit", { count: REVIEW_BATCH_PREPARE_LIMIT })}</Banner> : null}
      {unselected ? <Banner tone="warning">{t("reviewBatchUnselected")}</Banner> : null}
      {query.isFetching && request ? <LoadingState label={t("reviewBatchLoading")}/> : null}
      {query.error ? <Banner tone="error" role="alert">{t("reviewBatchReadFailed")}<CommandFailureDetails failure={commandFailure(query.error)}/></Banner> : null}
      {actionFailed ? <Banner tone="warning" role="status">{t("reviewBatchChanged")}</Banner> : null}
      {resultKey ? <Banner tone={resultKey === "reviewBatchComplete" ? "success" : "warning"} role="status">{t(resultKey)}</Banner> : null}
      {state.pending && !batchPending ? <Banner tone="warning">{t("reviewBatchOtherPending")}</Banner> : null}
      {stopRequested && state.batchRunning ? <p role="status">{t("reviewBatchStopping")}</p> : null}
      {state.batchStatus ? <p className={styles.meta}>{t("reviewBatchCounts", { ...state.batchStatus })}</p> : null}
      {stale && Object.keys(state.chosen).length > 0 && !state.batchRunning && !query.error && !query.isFetching ? <p role="status">{t("reviewBatchReadRemaining")}</p> : null}
      <Field label={t("entryReviewActor")} required><TextInput value={state.actor} readOnly={!inputAllowed()}
        onFocus={() => gate.setInputOwner(viewId, inputOwner)} onBlur={() => gate.releaseOwner(inputOwner)}
        onCompositionStart={() => gate.setComposing(inputOwner, true)} onCompositionEnd={() => gate.setComposing(inputOwner, false)}
        onChange={event => { if (inputAllowed()) owner.setActor(event.currentTarget.value); }}/></Field>
      <p className={styles.meta}>{t("reviewBatchReasonsKept")}</p>
      <Button size="sm" disabled={!canRead(readPayload).enabled} onClick={() => { if (canRead(readPayload).enabled) { showResults(); commands.dispatch("review.batch-read", scope, readPayload); } }}>{t(showingResults && !state.batchEnded ? "reviewBatchReadRemainingButton" : "reviewBatchRead")}</Button>
      {batchPending ? <section className={styles.recovery} aria-label={t("reviewBatchRecovery")}>
        <p>{t("reviewBatchUnknown")}</p>{state.pending?.kind === "decision" ? <p>{t("entryReviewOriginalAudit", { actor: state.pending.request.actor, locale: state.pending.request.locale })}</p> : null}
        <div className={styles.actions}>{pendingPayload ? <><Button size="sm" disabled={!canPending(pendingPayload, false).enabled} onClick={() => { if (canPending(pendingPayload, false).enabled) { showResults(); commands.dispatch("review.batch-check", scope, pendingPayload); } }}>{t("entryReviewCheck")}</Button>
          {state.retryAllowed ? <Button size="sm" disabled={!canPending(pendingPayload, true).enabled} onClick={() => { if (canPending(pendingPayload, true).enabled) { showResults(); commands.dispatch("review.batch-retry", scope, pendingPayload); } }}>{t("entryReviewRetry")}</Button> : null}</> : null}</div></section> : null}
      {rows.length ? <div>
        <table className={styles.table} aria-label={t("reviewBatchRows")}><thead><tr><th scope="col">{t("candidateBatchEntry")}</th><th scope="col">{t("reviewBatchSource")}</th><th scope="col">{t("reviewBatchTranslation")}</th><th scope="col">{t("candidateBatchResult")}</th></tr></thead>
          <tbody>{rows.map(item => <tr key={`${item.target.locale}:${item.target.unitId}`}><td><p className={styles.key}>{item.target.nativeKey}</p><p className={styles.meta}>{item.target.locale}</p>{item.summary ? <p className={styles.meta}>{t("reviewBatchSummary")}</p> : null}</td>
            <td className={styles.text}><TokenizedText text={item.source}/></td>
            <td className={styles.text}>{item.text === null ? t("reviewBatchNoSelection") : item.text === "" ? t("editorEmptySelection") : <TokenizedText text={item.text}/>}</td>
            <td><p>{t(statusKeys[item.status])}</p>{item.actor ? <p className={styles.meta}>{t("reviewBatchReviewer", { actor: item.actor })}</p> : null}
              {item.failure ? <CommandFailureDetails failure={item.failure}/> : null}</td></tr>)}</tbody></table>
      </div> : !query.isFetching && !query.error && !tooMany ? <EmptyState title={t("reviewBatchEmpty")}/> : null}
      <p className={styles.meta}>{t("reviewBatchEndHelp")}</p>
    </div>
  </Dialog>;
}
