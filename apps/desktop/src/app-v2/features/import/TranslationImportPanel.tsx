import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "../../../projectCommands";
import { executionContext } from "../../../executionCommands";
import type { TranslationImportPending } from "../../../TranslationImportSession";
import type { TranslationDecision, TranslationPreview, TranslationPreviewRow } from "../../../translationCommands";
import type { CommandAvailability, WorkbenchCommands, TranslationImportRowTarget, TranslationImportRowCommandPayload, TranslationImportBatchCommandPayload, TranslationImportPreviewCommandPayload, TranslationImportPendingCommandPayload } from "../../../workbenchCommands";
import { Button } from "../../../design-system/Button";
import { Banner, EmptyState, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { TranslationDrafts } from "../editor/translationDrafts";
import ImportPreparation from "./ImportPreparation";
import type { ImportOwners } from "./importTypes";
import styles from "./TranslationImport.module.css";

export interface TranslationImportPanelProps {
  project: ProjectView; owners: ImportOwners; drafts: TranslationDrafts; commands: WorkbenchCommands;
  gate: InteractionGate; viewId: string | null; disabled: boolean; visible: boolean;
  onBack: () => void; onOpenEntry: (unitId: string, locale: string) => void;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
function previewTarget(page: TranslationPreview, editSeq: number) {
  return { editSeq, attemptId: page.attemptId, bundleId: page.bundleId, basis: page.basis, locale: page.targetLocale,
    fixedSourceSnapshotId: page.fixedSourceSnapshotId, currentSourceSnapshotId: page.currentSourceSnapshotId,
    fileDigest: page.fileDigest, previewResultDigest: page.resultDigest };
}
function rowTarget(row: TranslationPreviewRow): TranslationImportRowTarget | null {
  return row.unitId && row.occurrenceId && row.sourceRevisionId ? { ordinal: row.entry.ordinal, itemId: row.itemId, resultId: row.resultId,
    resultDigest: row.resultDigest, unitId: row.unitId, occurrenceId: row.occurrenceId, sourceRevisionId: row.sourceRevisionId,
    expectedSelectionId: row.currentSelection?.eventId ?? null } : null;
}
function rowPayload(page: TranslationPreview, row: TranslationPreviewRow, decision: TranslationDecision, editSeq: number): TranslationImportRowCommandPayload | null {
  const target = rowTarget(row);
  return target ? { kind: "translation-import-row", ...previewTarget(page, editSeq), ...target, decision } : null;
}
function pendingPayload(pending: TranslationImportPending): TranslationImportPendingCommandPayload {
  return { kind: "translation-import-pending", request: pending.request, recoveryUnitId: pending.recoveryUnitId,
    previousSelectionSequence: pending.previousSelectionSequence };
}

/** Presentation of the original import owner; all writes keep their captured request. */
export default function TranslationImportPanel(props: TranslationImportPanelProps) {
  const { project, owners, drafts, commands, gate, viewId, disabled, visible, onBack, onOpenEntry } = props;
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const { t: legacy } = useTranslation();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const owner = owners.imports, state = owner.state, preview = state.preview, scope = { ...executionContext(project), area: "translation" as const };
  const live = useRef({ ...props, mounted: true });
  useLayoutEffect(() => { live.current = { ...props, mounted: true }; });
  useLayoutEffect(() => () => { live.current.mounted = false; }, []);
  function present() {
    const latest = live.current;
    return latest.mounted && latest.visible && !latest.disabled && latest.viewId === viewId
      && latest.project.sessionToken === scope.sessionToken && latest.project.metadata.projectId === scope.projectId
      && gate.canDispatch({ viewId, source: "button" });
  }
  function common(recovery = false): CommandAvailability {
    if (!visible || disabled || !gate.canDispatch({ viewId, source: "button" })) return { enabled: false, reason: "hidden" };
    if (owner.current().busy || (!recovery && drafts.getSnapshot().mutationReserved)) return { enabled: false, reason: "busy" };
    if (!recovery && (owner.hasPending() || !project.metadata.targetLocales.includes(owner.current().targetLocale))) return unavailable;
    return { enabled: true };
  }
  function rowAvailability(input?: TranslationImportRowCommandPayload, applying = false): CommandAvailability {
    const allowed = common(), current = owner.current(), capture = current.rowAction;
    const page = applying ? capture?.preview : current.preview;
    const row = applying ? capture?.row : page?.rows.find(row => same(rowTarget(row), input && {
      ordinal: input.ordinal, itemId: input.itemId, resultId: input.resultId, resultDigest: input.resultDigest,
      unitId: input.unitId, occurrenceId: input.occurrenceId, sourceRevisionId: input.sourceRevisionId, expectedSelectionId: input.expectedSelectionId }));
    return allowed.enabled && input && page && row && !current.stale && input.editSeq === current.editSeq
      && input.fixedSourceSnapshotId === input.currentSourceSnapshotId && (row.status === "unique" || row.status === "selected-conflict")
      && (input.decision === "replace" ? !!row.currentSelection : input.decision !== "select-if-empty" || !row.currentSelection)
      && same(input, rowPayload(page, row, applying && capture ? capture.decision : input.decision, applying && capture ? capture.editSeq : current.editSeq))
      ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function previewPayload(): TranslationImportPreviewCommandPayload | null {
    const current = owner.current();
    return current.preview ? { kind: "translation-import-preview", ...previewTarget(current.preview, current.editSeq), selectIfEmpty: current.selectIfEmpty } : null;
  }
  function previewAvailability(input?: TranslationImportPreviewCommandPayload): CommandAvailability {
    const allowed = common(), current = owner.current();
    return allowed.enabled && input && same(input, previewPayload()) && !!current.preview?.unique && !current.stale
      && !current.preview.sourceChanged && input.fixedSourceSnapshotId === input.currentSourceSnapshotId ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function batchPayload(): TranslationImportBatchCommandPayload | null {
    const capture = owner.current().batchCapture;
    if (!capture || capture.decision === "replace") return null;
    const rows = capture.eligible.map(rowTarget);
    if (rows.some(row => row === null)) return null;
    return { kind: "translation-import-batch", ...previewTarget(capture.preview, capture.editSeq), decision: capture.decision,
      rows: rows.filter((row): row is TranslationImportRowTarget => row !== null), excluded: capture.excluded };
  }
  function batchAvailability(input?: TranslationImportBatchCommandPayload): CommandAvailability {
    const allowed = common(), current = owner.current();
    return allowed.enabled && input && same(input, batchPayload()) && input.editSeq === current.editSeq && !current.stale
      && input.fixedSourceSnapshotId === input.currentSourceSnapshotId ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function pendingAvailability(input?: TranslationImportPendingCommandPayload, retry = false): CommandAvailability {
    const allowed = common(true), pending = input && owner.current().uncertain.find(value => value.request.actionId === input.request.actionId);
    return allowed.enabled && pending && input && same(input, pendingPayload(pending)) && (!retry || pending.receiptChecked)
      ? allowed : allowed.enabled ? unavailable : allowed;
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const meta = { category: "translation" as const, scope, binding: null, confirmation: "none" as const };
    const removals = [
      commands.register({ ...meta, id: "translation.choose-import-row", nameKey: "translation.addCandidate", risk: "captures-translation-import", payloadKind: "translation-import-row",
        availability: input => rowAvailability(input), handler: input => { const row = owner.current().preview?.rows.find(row => row.itemId === input.itemId); if (row) owner.chooseRow(row, input.decision); } }),
      commands.register({ ...meta, id: "translation.apply-import-row", nameKey: "translation.selectImported", risk: "writes-translation", confirmation: "required", payloadKind: "translation-import-row",
        availability: input => rowAvailability(input, true), handler: () => { void owner.applyRow(present); } }),
      commands.register({ ...meta, id: "translation.capture-import-batch", nameKey: "translation.apply", risk: "captures-translation-import", payloadKind: "translation-import-preview",
        availability: previewAvailability, handler: () => { void owner.captureBatch(); } }),
      commands.register({ ...meta, id: "translation.apply-import-batch", nameKey: "translation.batchStart", risk: "writes-translation", confirmation: "required", payloadKind: "translation-import-batch",
        availability: batchAvailability, handler: () => { void owner.applyBatch(present); } }),
      commands.register({ ...meta, id: "translation.check-import-receipt", nameKey: "translation.checkReceipt", risk: "reads-execution", payloadKind: "translation-import-pending",
        availability: input => pendingAvailability(input), handler: input => { void owner.checkReceipt(input.request.actionId); } }),
      commands.register({ ...meta, id: "translation.retry-import-action", nameKey: "translation.retryAction", risk: "retries-execution-action", payloadKind: "translation-import-pending",
        availability: input => pendingAvailability(input, true), handler: input => { void owner.retryAction(input.request.actionId); } }),
    ];
    if (preview) removals.push(commands.register({ ...meta, id: "translation.reset-import", nameKey: "workbenchV2.importNewFile", risk: "changes-view",
      availability: () => common().enabled && !owner.hasActive() ? { enabled: true } : unavailable,
      handler: () => { owner.resetPlugin(); } }));
    return () => removals.forEach(remove => remove());
  });
  const batch = state.batchCapture, row = state.rowAction;
  const panel = useRef<HTMLElement>(null), confirmation = useRef<HTMLElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    if (row || batch) {
      if (!returnFocus.current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
      confirmation.current?.focus();
    } else if (returnFocus.current) {
      const target = returnFocus.current; returnFocus.current = null;
      if (target.isConnected && !target.matches(":disabled") && (target.tabIndex >= 0 || target.hasAttribute("tabindex"))) target.focus();
      else panel.current?.focus();
    }
  }, [visible, row, batch]);
  const rowInput = row ? rowPayload(row.preview, row.row, row.decision, row.editSeq) : null, batchInput = batchPayload(), previewInput = previewPayload();
  const canRead = common(true).enabled && !state.busy;
  return <section ref={panel} tabIndex={-1} className={styles.panel} aria-label={t("importTitle")}>
    <header className={styles.header}><div><h1>{t("importTitle")}</h1><p>{t("importHelp")}</p></div><Button onClick={onBack}>{t("importBack")}</Button></header>
    <div hidden={preview !== null}><ImportPreparation project={project} owner={owner} tasks={owners.tasks} commands={commands} gate={gate} viewId={viewId} disabled={disabled} visible={visible && preview === null} /></div>
    {preview ? <div className={styles.sectionHeader}><p>{preview.logicalPath} · {preview.targetLocale}</p><Button disabled={!common().enabled || owner.hasActive()} onClick={() => commands.dispatch("translation.reset-import", scope)}>{t("importNewFile")}</Button></div> : null}
    {state.failure ? <Banner tone="error" role="alert">{t("importFailed")}</Banner> : null}
    {owners.observation.failure ? <Banner tone="error" role="alert" action={<Button disabled={!canRead} onClick={owners.observation.retry}>{t("importReadAgain")}</Button>}>{t("importReadFailed")}</Banner> : null}
    {state.stale ? <Banner tone="warning">{t("importStale")}</Banner> : null}
    {state.receiptMessage ? <Banner tone={state.receiptMessage === "found" ? "success" : "warning"}>{t(state.receiptMessage === "found" ? "importReceiptFound" : "importReceiptMissing")}</Banner> : null}
    {state.uncertain.map(pending => { const input = pendingPayload(pending); return <Banner key={pending.request.actionId} tone="warning" action={<div className={styles.actions}>
      <Button disabled={!pendingAvailability(input).enabled} onClick={() => commands.dispatch("translation.check-import-receipt", scope, input)}>{t("importCheckResult")}</Button>
      {pending.receiptChecked ? <Button disabled={!pendingAvailability(input, true).enabled} onClick={() => commands.dispatch("translation.retry-import-action", scope, input)}>{t("importRetryOriginal")}</Button> : null}
    </div>}>{t("importUnknown", { key: pending.key })}</Banner>; })}
    {state.batchProgress ? <p role="status">{t("importProgress", { done: String(state.batchProgress.done), total: String(state.batchProgress.total) })}</p> : null}
    {state.batchOutcome ? <Banner tone={state.batchOutcome.failed || state.batchOutcome.conflicted || state.batchOutcome.unknown ? "warning" : "success"}>{t("importOutcome", { applied: String(state.batchOutcome.applied), conflicted: String(state.batchOutcome.conflicted), failed: String(state.batchOutcome.failed), unknown: String(state.batchOutcome.unknown) })}</Banner> : null}
    {state.batchDetails.length ? <ul className={styles.resultList}>{state.batchDetails.map(item => <li key={item.actionId}><span>{item.key}</span><span>{legacy(`translation.batchStatus.${item.status}`)}</span></li>)}</ul> : null}
    {row ? <section ref={confirmation} tabIndex={-1} className={styles.confirm} aria-label={t("importConfirmRow")}><h2>{t("importConfirmRow")}</h2><p>{t("importRowHelp", { key: row.row.entry.nativeKey, locale: row.preview.targetLocale })}</p>
      <div className={styles.compare}><div><h3>{t("importIncoming")}</h3>{row.row.entry.text === "" ? legacy("translation.empty") : <TokenizedText text={row.row.entry.text} />}</div><div><h3>{t("importCurrent")}</h3>{row.row.currentText === null ? t("editorNoSelection") : row.row.currentText === "" ? t("editorEmptySelection") : <TokenizedText text={row.row.currentText} />}</div></div>
      <p>{t(row.decision === "replace" ? "importReplaceHelp" : row.decision === "select-if-empty" ? "importSelectHelp" : "importCandidateHelp")}</p>
      <div className={styles.actions}><Button disabled={state.busy} onClick={() => owner.cancelConfirmation()}>{t("importCancelConfirm")}</Button><Button variant="primary" disabled={!rowInput || !rowAvailability(rowInput, true).enabled} onClick={() => { if (rowInput) commands.dispatch("translation.apply-import-row", scope, rowInput); }}>{t(row.decision === "replace" ? "importReplace" : row.decision === "select-if-empty" ? "importSelect" : "importCandidate")}</Button></div>
    </section> : null}
    {batch ? <section ref={confirmation} tabIndex={-1} className={styles.confirm} aria-label={t("importConfirmBatch")}><h2>{t("importConfirmBatch")}</h2><p>{t("importBatchScope", { count: batch.eligible.length, excluded: String(batch.excluded), locale: batch.preview.targetLocale })}</p><p>{t(batch.decision === "select-if-empty" ? "importSelectHelp" : "importCandidateHelp")}</p>
      <div className={styles.actions}><Button disabled={state.busy} onClick={() => owner.cancelConfirmation()}>{t("importCancelConfirm")}</Button><Button variant="primary" disabled={!batchInput || !batchAvailability(batchInput).enabled} onClick={() => { if (batchInput) commands.dispatch("translation.apply-import-batch", scope, batchInput); }}>{t("importApplyBatch", { count: batch.eligible.length })}</Button></div>
    </section> : null}
    {preview ? <section aria-label={t("importPreview")}><div className={styles.sectionHeader}><div><h2>{t("importPreview")}</h2><p>{t("importPreviewSummary", { total: String(preview.total), unique: String(preview.unique), ambiguous: String(preview.ambiguous), unmatched: String(preview.unmatched), conflicts: String(preview.selectedConflicts) })}</p></div><Button disabled={!canRead} onClick={() => { void owner.page(0, true); }}>{t("importRefreshPreview")}</Button></div>
      <p>{t("importPreviewHelp")}</p>
      {preview.rows.length ? <div className={styles.tableScroll}><table className={styles.table}><caption>{t("importPage", { first: String((preview.rows[0]?.entry.ordinal ?? 0) + 1), last: String((preview.rows.at(-1)?.entry.ordinal ?? -1) + 1), total: String(preview.total) })}</caption><thead><tr><th>{t("importKey")}</th><th>{t("importSource")}</th><th>{t("importIncoming")}</th><th>{t("importCurrent")}</th><th>{t("importMatch")}</th></tr></thead><tbody>{preview.rows.map(item => { const unitId = item.unitId, candidate = rowPayload(preview, item, "candidate-only", state.editSeq), selected = rowPayload(preview, item, item.currentSelection ? "replace" : "select-if-empty", state.editSeq); return <tr key={item.itemId}><th scope="row">{item.entry.nativeKey}</th><td>{item.sourceText === null ? t("importSourceMissing") : item.sourceText === "" ? legacy("translation.empty") : <TokenizedText text={item.sourceText} />}</td><td>{item.entry.text === "" ? legacy("translation.empty") : <TokenizedText text={item.entry.text} />}</td><td>{item.currentText === null ? t("editorNoSelection") : item.currentText === "" ? t("editorEmptySelection") : <TokenizedText text={item.currentText} />}</td><td><p>{legacy(`translation.status.${item.status}`)}</p><div className={styles.actions}>
        {candidate ? <Button size="sm" disabled={!rowAvailability(candidate).enabled} onClick={() => commands.dispatch("translation.choose-import-row", scope, candidate)}>{t("importCandidate")}</Button> : null}
        {selected ? <Button size="sm" disabled={!rowAvailability(selected).enabled} onClick={() => commands.dispatch("translation.choose-import-row", scope, selected)}>{t(item.currentSelection ? "importReplace" : "importSelect")}</Button> : null}
        {unitId ? <Button size="sm" disabled={!canRead} onClick={() => onOpenEntry(unitId, preview.targetLocale)}>{t("importOpenEntry")}</Button> : null}
      </div></td></tr>; })}</tbody></table></div> : <EmptyState title={t("importEmpty")} />}
      <div className={styles.actions}>{(preview.rows[0]?.entry.ordinal ?? 0) > 0 ? <Button disabled={!canRead} onClick={() => { void owner.page(0); }}>{t("firstPage")}</Button> : null}{preview.nextOrdinal !== null ? <Button disabled={!canRead} onClick={() => { if (preview.nextOrdinal !== null) void owner.page(preview.nextOrdinal); }}>{t("nextPage")}</Button> : null}</div>
      <label className={styles.check}><input type="checkbox" checked={state.selectIfEmpty} disabled={!common().enabled || state.busy} onChange={event => owner.setStrategy(event.currentTarget.checked)} />{t("importSelectEmpty")}</label>
      <div className={styles.actions}><Button variant="primary" disabled={!previewInput || !previewAvailability(previewInput).enabled} onClick={() => { if (previewInput) commands.dispatch("translation.capture-import-batch", scope, previewInput); }}>{t("importPrepareBatch")}</Button></div>
    </section> : owners.observation.loading ? <LoadingState label={t("importReadingPreview")} /> : null}
  </section>;
}
