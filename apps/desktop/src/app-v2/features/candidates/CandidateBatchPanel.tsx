import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "../../../projectCommands";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Banner, EmptyState, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { TranslationCandidateBatchPageCommandPayload, WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import { workspaceSelectionIds } from "../../workspace/workspaceSelection";
import type { CandidateBatchItem, CandidateBatchSession, CandidateBatchSkipReason } from "./CandidateBatchSession";
import type { CandidateOwners } from "./candidateTypes";
import { candidateBatchPageSize, useCandidateBatchActions } from "./CandidateBatchRecovery";
import styles from "./CandidateBatchPanel.module.css";

export interface CandidateBatchPanelProps {
  project: ProjectView; owner: CandidateBatchSession; owners: CandidateOwners; commands: WorkbenchCommands;
  gate: InteractionGate; viewId: string | null; disabled: boolean; open: boolean; onOpenChange: (open: boolean) => void;
  onEdit: (unitId: string, locale: string, parentDialogId?: string) => Promise<boolean>;
  parentDialogId?: string; returnFocusRef?: RefObject<HTMLElement | null>;
}
const reasons = {
  "no-candidate": "candidateBatchNoCandidate", "multiple-candidates": "candidateBatchMultipleCandidates", protected: "candidateBatchProtected",
  "human-selection": "candidateBatchHumanSelection", "existing-draft": "candidateBatchExistingDraft", "draft-input": "candidateBatchDraftInput",
  merge: "candidateBatchMerge", pending: "candidateBatchPendingInput", unavailable: "candidateBatchItemUnavailable",
  "basis-changed": "candidateBatchBasisChanged", "source-changed": "candidateBatchSourceChanged", ended: "candidateBatchEnded",
} as const satisfies Record<CandidateBatchSkipReason, string>;
const statuses = { ready: "candidateBatchReady", skipped: "candidateBatchSkipped", running: "candidateBatchItemRunning", staged: "candidateBatchStaged",
  recorded: "candidateBatchRecorded", pending: "candidateBatchUnknown", undurable: "candidateStageUndurable", failed: "candidateBatchItemFailed" } as const;

/** The dialog presents the owner's fixed plan. Hiding it never clears results, input, or an original request. */
export default function CandidateBatchPanel({ project, owner, owners, commands, gate, viewId, disabled, open, onOpenChange, onEdit,
  parentDialogId, returnFocusRef }: CandidateBatchPanelProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const dialogId = "candidate-batch", inputOwner = `candidate-batch-audit-${useId()}`;
  const dialogRelease = useRef<(() => void) | null>(null), closing = useRef(false), editing = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null), pageRegion = useRef<HTMLDivElement>(null);
  const identity = JSON.stringify([project.metadata.projectId, project.sessionToken, viewId, parentDialogId]);
  const live = useRef({ identity, open }), returnFocus = useRef<{ identity: string; element: HTMLElement | null } | null>(null);
  const [page, setPage] = useState<{ captureId: number | null; offset: number }>({ captureId: null, offset: 0 });
  const pageFocus = useRef<{ identity: string; captureId: number | null; input: ReturnType<InteractionGate["getSnapshot"]>["inputOwner"] } | null>(null);
  useLayoutEffect(() => { live.current = { identity, open }; });
  useLayoutEffect(() => {
    if (!open) return;
    closing.current = false; editing.current = false;
    if (!dialogRelease.current) dialogRelease.current = gate.pushDialog(dialogId);
    return () => { dialogRelease.current?.(); dialogRelease.current = null; gate.releaseOwner(inputOwner); };
  }, [gate, open, inputOwner]);
  useLayoutEffect(() => () => gate.releaseOwner(inputOwner), [gate, inputOwner, identity]);
  function hide() {
    if (closing.current) return;
    closing.current = true;
    dialogRelease.current?.(); dialogRelease.current = null; gate.releaseOwner(inputOwner);
    onOpenChange(false);
  }
  const actions = useCandidateBatchActions({ project, owner, owners, commands, gate, viewId, disabled, visible: open, parentDialogId: dialogId,
    active: () => !closing.current, contextCurrent: () => live.current.identity === identity && live.current.open, onHide: hide,
    onEdit: async (unitId, locale) => { editing.current = true; hide(); return onEdit(unitId, locale, parentDialogId); },
    onPage: offset => {
      pageFocus.current = { identity, captureId: owner.current().captureId, input: gate.getSnapshot().inputOwner };
      setPage({ captureId: owner.current().captureId, offset });
    } });
  const { state, scope } = actions, input = actions.payload();
  const maxOffset = Math.max(0, Math.floor((state.items.length - 1) / candidateBatchPageSize) * candidateBatchPageSize);
  const offset = page.captureId === state.captureId ? Math.min(page.offset, maxOffset) : 0;
  const rows = state.items.slice(offset, offset + candidateBatchPageSize), totalPages = Math.max(1, Math.ceil(state.items.length / candidateBatchPageSize));
  useLayoutEffect(() => {
    const ticket = pageFocus.current; if (!ticket) return;
    pageFocus.current = null;
    if (ticket.identity !== identity || ticket.captureId !== state.captureId || !actions.stillPresent()
      || gate.getSnapshot().inputOwner !== ticket.input) return;
    pageRegion.current?.focus(); pageRegion.current?.scrollIntoView?.({ block: "nearest" });
  }, [offset, state.captureId, identity, gate, actions]);
  function pagePayload(next: number): TranslationCandidateBatchPageCommandPayload | null {
    return state.captureId === null ? null : { kind: "translation-candidate-batch-page", captureId: state.captureId, revision: state.revision, offset: next };
  }
  const previous = pagePayload(offset - candidateBatchPageSize), next = pagePayload(offset + candidateBatchPageSize);
  const pending = state.items.find(item => item.status === "pending" || item.status === "undurable");
  const modeKey = state.mode === "reject" ? "candidateBatchReject" : state.mode === "restore" ? "candidateBatchRestore" : "candidateBatchStage";
  const totalMembers = workspaceSelectionIds(state.selection).length + state.excluded.length;
  const processed = state.items.filter(item => item.status !== "ready" && item.status !== "running").length;
  const audit = owners.decisions.state;
  const commonInput = {
    onFocus: () => gate.setInputOwner(viewId, inputOwner), onBlur: () => gate.releaseOwner(inputOwner),
    onCompositionStart: () => gate.setComposing(inputOwner, true), onCompositionEnd: () => gate.setComposing(inputOwner, false),
  };
  const close = () => commands.dispatch("translation.hide-candidate-batch", scope);
  function result(item: CandidateBatchItem) {
    const pendingInput = actions.pendingPayload(item.id), editInput = actions.itemPayload(item.id);
    return <><p className={styles.status}>{t(statuses[item.status])}</p>
      {item.skipReason ? <p className={styles.meta}>{t(reasons[item.skipReason])}</p> : null}
      {item.status === "pending" && item.request ? <p className={styles.meta}>{t("candidateBatchOriginalAudit", { actor: item.request.decision.actor, reason: item.request.decision.reason })}</p> : null}
      <div className={styles.actions}>
        {pendingInput ? <><Button size="sm" disabled={!actions.canCheck(pendingInput).enabled} onClick={() => commands.dispatch("translation.check-candidate-batch", scope, pendingInput)}>{t(item.status === "undurable" ? "editorRetryPreserve" : "candidateCheck")}</Button>
          {item.status === "pending" && owner.retryAllowed(item.id) ? <Button size="sm" disabled={!actions.canCheck(pendingInput, true).enabled} onClick={() => commands.dispatch("translation.retry-candidate-batch", scope, pendingInput)}>{t("candidateRetry")}</Button> : null}</> : null}
        {item.status === "staged" && editInput ? <Button size="sm" disabled={!actions.canEdit(editInput).enabled} onClick={() => commands.dispatch("translation.edit-candidate-batch-item", scope, editInput)}>{t("candidateBatchEdit")}</Button> : null}
      </div></>;
  }
  const pausedKey = state.pauseReason === "audit-changed" ? "candidateBatchAuditChanged" : state.pauseReason === "unknown" ? "candidateBatchUnknown"
    : state.pauseReason === "journal" ? "candidateStageUndurable" : state.pauseReason === "failed" ? "candidateBatchActionFailed"
      : state.pauseReason === "stale" || state.pauseReason === "context-changed" ? "candidateBatchChanged" : "candidateBatchPaused";
  return <Dialog open={open} onOpenChange={value => { if (!value) close(); }} title={t("candidateBatchTitle")} description={t("candidateBatchHelp")}
    closeLabel={t("close")} className={styles.dialog}
    onOpenAutoFocus={event => {
      event.preventDefault(); returnFocus.current = { identity, element: document.activeElement instanceof HTMLElement ? document.activeElement : null };
      if (live.current.identity === identity && gate.getSnapshot().visibleViewId === viewId) closeButton.current?.focus();
    }}
    onCloseAutoFocus={event => {
      event.preventDefault(); const ticket = returnFocus.current; returnFocus.current = null;
      if (editing.current || !ticket || ticket.identity !== identity || live.current.identity !== identity
        || !gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })) return;
      const reachable = (element: HTMLElement | null | undefined) => !!element?.isConnected && element !== document.body && element !== document.documentElement
        && !element.closest('[hidden], [inert], [aria-hidden="true"]') && !element.matches(":disabled");
      const element = reachable(ticket.element) ? ticket.element : returnFocusRef?.current;
      if (reachable(element)) element?.focus();
    }}
    onEscapeKeyDown={event => { event.preventDefault(); if (!event.isComposing && event.keyCode !== 229) close(); }}
    footer={<div className={styles.footer}>
      <div className={styles.pages} aria-label={t("candidateBatchPages")}>
        <span className={styles.meta}>{t("candidateBatchPage", { page: offset / candidateBatchPageSize + 1, total: totalPages })}</span>
        <Button size="sm" disabled={offset === 0 || !previous || !actions.canPage(previous).enabled} onClick={() => { if (previous) commands.dispatch("translation.candidate-batch-page", scope, previous); }}>{t("candidateBatchPrevious")}</Button>
        <Button size="sm" disabled={offset >= maxOffset || !next || !actions.canPage(next).enabled} onClick={() => { if (next) commands.dispatch("translation.candidate-batch-page", scope, next); }}>{t("nextPage")}</Button>
      </div>
      <div className={styles.actions}>
        {input && ["preview", "paused"].includes(state.phase) && !state.ended ? <Button size="sm" disabled={!actions.canEnd(input).enabled} onClick={() => commands.dispatch("translation.end-candidate-batch", scope, input)}>{t("candidateBatchEnd")}</Button> : null}
        <Button ref={closeButton} disabled={!actions.canHide()} onClick={close}>{t("close")}</Button>
        {input && state.phase === "preview" ? <Button variant="primary" pending={actions.working} disabled={!actions.canConfirm(input).enabled} onClick={() => commands.dispatch("translation.confirm-candidate-batch", scope, input)}>{t("candidateBatchConfirm")}</Button> : null}
        {input && state.phase === "paused" && !pending && state.items.some(item => item.status === "ready") ? <Button variant="primary" pending={actions.working} disabled={!actions.canContinue(input).enabled} onClick={() => commands.dispatch("translation.continue-candidate-batch", scope, input)}>{t("candidateBatchContinue")}</Button> : null}
      </div>
    </div>}>
    <div className={styles.content}>
      <div><p className={styles.key}>{t(modeKey)}</p><p className={styles.meta}>{t("candidateBatchScope", { total: totalMembers, excluded: state.excluded.length, locale: state.locale ?? "" })}</p>
        {state.phase === "preview" ? <p className={styles.meta}>{t("candidateBatchCounts", { eligible: state.items.filter(item => item.status === "ready").length,
          skipped: state.items.filter(item => item.status === "skipped").length })}</p> : state.items.length ? <p className={styles.meta}>{t("candidateBatchProgress", { done: processed, total: state.items.length })}</p> : null}</div>
      {state.phase === "capturing" ? <LoadingState label={t("candidateBatchLoading")} /> : null}
      {state.phase === "running" ? <Banner role="status">{t("candidateBatchRunning")}</Banner> : null}
      {state.phase === "paused" ? <Banner tone="warning" role="status">{t(pausedKey)}</Banner> : null}
      {state.phase === "complete" ? <Banner tone="success" role="status">{t(state.ended ? "candidateBatchEnded" : "candidateBatchComplete")}</Banner> : null}
      {actions.failed || state.failure && !pending && !["failed", "unknown", "journal"].includes(state.pauseReason ?? "") ? <Banner tone="error">{t("candidateBatchActionFailed")}</Banner> : null}
      {disabled || state.phase === "retired" ? <Banner tone="warning">{t("candidateBatchUnavailable")}</Banner> : null}
      {state.mode && state.mode !== "stage" ? <div className={styles.audit}>
        <Field label={t("candidateActor")} required><TextInput {...commonInput} value={audit.actor} readOnly={!actions.auditEditable()} onChange={event => { if (actions.auditEditable()) owners.decisions.edit("actor", event.currentTarget.value); }} /></Field>
        <Field label={t("candidateReason")} required><TextArea {...commonInput} rows={2} value={audit.reason} readOnly={!actions.auditEditable()} onChange={event => { if (actions.auditEditable()) owners.decisions.edit("reason", event.currentTarget.value); }} /></Field>
        {state.phase === "paused" && !pending ? <p className={styles.meta}>{t("candidateBatchContinueAudit")}</p> : !audit.actor.trim() || !audit.reason.trim() ? <p className={styles.meta}>{t("candidateBatchAuditRequired")}</p> : null}
      </div> : null}
      {state.items.length === 0 && state.phase !== "capturing" ? <EmptyState title={t("candidateBatchEmpty")} /> : null}
      {rows.length ? <div ref={pageRegion} className={styles.pageRegion} tabIndex={-1} aria-label={t("candidateBatchResult")} role="region">
        <table className={styles.table} aria-label={t("candidateBatchResult")}><thead><tr><th className={styles.entryColumn} scope="col">{t("candidateBatchEntry")}</th><th scope="col">{t("candidateBatchText")}</th><th className={styles.resultColumn} scope="col">{t("candidateBatchResult")}</th></tr></thead>
          <tbody>{rows.map(item => <tr key={item.id}><td><div className={styles.key}>{item.nativeKey}</div>
            {item.revision ? <p className={styles.meta}>{t("candidateBatchVersion", { ordinal: item.revision.ordinal })}</p> : null}</td>
            <td>{item.skipReason === "multiple-candidates" ? <p className={styles.meta}>{t("candidateBatchAmbiguous", { count: item.row.candidateCount })}</p>
              : item.revision ? <div className={`${styles.text} ${styles.ai}`}>{item.revision.text === "" ? t("candidateBatchEmptyText") : <TokenizedText text={item.revision.text} />}</div> : <p className={styles.meta}>{t("candidateBatchNoCandidate")}</p>}</td>
            <td>{result(item)}</td></tr>)}</tbody></table>
      </div> : null}
      {input && ["preview", "paused"].includes(state.phase) && !state.ended ? <p className={styles.meta}>{t("candidateBatchEndHelp")}</p> : null}
    </div>
  </Dialog>;
}
