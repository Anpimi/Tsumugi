import { ContextResourceCapturePreview } from "../../../ContextResourceCapturePreview";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { matchQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { validAiLimits } from "../../../aiCommands";
import type { AiSemanticReviewView } from "../../../aiSemanticReviewCommands";
import { AiConnectionFields } from "../../../AiConnectionFields";
import { AiOutputUsage } from "../../../AiUsage";
import { commandFailure, CommandFailureDetails, failureReason } from "../../../CommandFailure";
import { executionContext } from "../../../executionCommands";
import { useExecutionTaskSession } from "../../../ExecutionTaskSession";
import { ModelConnectionPicker, PreparationBudgetSummary } from "../../../ModelConnectionPicker";
import { reviewDraftKey } from "../../../ReviewDraftSession";
import { sameReviewBasis } from "../../../reviewDiagnosticNavigation";
import { useSessionReads } from "../../../SessionReadProvider";
import { ProjectFactPreview, SourceContextChoice, SourceContextPreview } from "../../../SourceContextPreparation";
import { semanticCommandId, type CommandAvailability, type SemanticEntryCommandId } from "../../../workbenchCommands";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import { TextInput } from "../../../design-system/Field";
import { Menu } from "../../../design-system/Menu";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { enUS } from "../../../i18n/en-US";
import SemanticRecoveryPanel, { semanticReadCurrent, semanticReadProof, useSemanticAttempt } from "./SemanticRecoveryPanel";
import type { EntrySemanticCancelPayload, EntrySemanticCapture, EntrySemanticConsentPayload, EntrySemanticPanelProps, EntrySemanticPreparation,
  EntrySemanticPreparePayload, EntrySemanticReadPayload, EntrySemanticRecordPayload, EntrySemanticScopePayload, EntrySemanticStartPayload } from "./semanticTypes";
import styles from "./EntrySemanticPanel.module.css";

const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
function sameCapture(left: EntrySemanticCapture, right: EntrySemanticCapture) {
  return left.targets === right.targets && left.unitId === right.unitId && left.locale === right.locale && left.sourceSnapshotId === right.sourceSnapshotId && left.sourceRevisionId === right.sourceRevisionId
    && left.selectionId === right.selectionId && left.revisionId === right.revisionId && left.basis === right.basis && left.sequence === right.sequence
    && sameReviewBasis(left.basisEvidence, right.basisEvidence);
}

/** Current saved content supplies evidence; the original project owners keep configuration and requests. */
export default function EntrySemanticPanel({ project, target, owner, drafts, commands, gate, viewId, disabled, visible, parentDialogId, read, batchTargets }: EntrySemanticPanelProps) {
  const { t } = useTranslation(), { t: w } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), reads = useSessionReads(), tasks = useExecutionTaskSession();
  const batch = batchTargets !== undefined, selectedTargets = batchTargets ?? [target];
  const commandId = <Id extends SemanticEntryCommandId>(id: Id) => semanticCommandId(id, batch);
  const semantic = owner.semantic, state = semantic.state, context = executionContext(project), commandScope = { ...context, area: "translation" as const };
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  const scope = JSON.stringify([context.projectId, context.sessionToken, target.unitId, target.locale, viewId, parentDialogId]);
  const identity = JSON.stringify([scope, target.basis, target.basisEvidence, target.sourceText, target.translationText, batchTargets]);
  const mounted = useRef(false), flight = useRef(false), root = useRef<HTMLElement>(null), feedbackRegion = useRef<HTMLDivElement>(null), previewRegion = useRef<HTMLElement>(null);
  const focus = useRef<{ identity: string; origin: Element | null; preparation: boolean } | null>(null), bound = useRef<{ data: unknown; version: number; identity: string } | null>(null);
  const live = useRef({ scope, identity, disabled, visible });
  const [working, setWorking] = useState(false), [connectionOpen, setConnectionOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ scope: string; kind: "prepared" | "changed" } | null>(null);
  const inputOwner = `entry-semantic-${useId()}`;
  useLayoutEffect(() => { live.current = { scope, identity, disabled, visible }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; gate.releaseOwner(inputOwner); }; }, [gate, inputOwner]);
  useLayoutEffect(() => { if (!visible) gate.releaseOwner(inputOwner); }, [visible, gate, inputOwner]);
  const preparedRead = useRef<{ preparation: EntrySemanticPreparation; version: number; data: unknown } | null>(null);
  const queryIdentity = JSON.stringify(read.key);
  const parent = useMemo(() => {
    const cache = reads.client.getQueryCache(), filters = { queryKey: reads.key(read.key), exact: true };
    return { subscribe: (changed: () => void) => cache.subscribe(event => {
      if ((event.type === "updated" || event.type === "removed") && matchQuery(filters, event.query)) changed();
    }), snapshot: () => cache.find(filters)?.state };
  }, [reads, queryIdentity]);
  const parentState = useSyncExternalStore(parent.subscribe, parent.snapshot, parent.snapshot);
  const result = useSemanticAttempt(state.attemptId, visible);
  const view = result.query.data;
  function present() {
    return mounted.current && visible && !disabled && !reads.retired && !drafts.getSnapshot().retired
      && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken && gate.getSnapshot().visibleViewId === viewId;
  }
  function interactionAllowed() { return gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId }); }
  function sameView() { return present() && live.current.scope === scope && live.current.visible && !live.current.disabled && interactionAllowed(); }
  function stillPresent() { return sameView() && live.current.identity === identity; }
  function inputAllowed() {
    const interaction = gate.getSnapshot(), top = interaction.dialogs.at(-1);
    return present() && live.current.identity === identity && project.metadata.targetLocales.includes(target.locale) && !interaction.intentOwner && (!top || top === parentDialogId);
  }
  function currentRead() { return semanticReadCurrent(reads, read.key, read.data); }
  useEffect(() => {
    if (batch || !present() || !currentRead() || !parentState || !project.metadata.targetLocales.includes(target.locale)) return;
    const before = owner.current(), selected = before.selected, projection = before.projection;
    if (bound.current?.identity === identity && bound.current.data === read.data && bound.current.version === parentState.dataUpdateCount
      && projection?.unitId === target.unitId && projection.locale === target.locale && projection.basis === target.basis) return;
    bound.current = { identity, data: read.data, version: parentState.dataUpdateCount };
    if (before.locale !== target.locale) owner.setLocale(target.locale);
    if (!selected || selected.unitId !== target.unitId || selected.locale !== target.locale) owner.setSelected(target);
    else owner.observeProjection(target, { unitId: selected.unitId, locale: selected.locale, basis: selected.basis, editSeq: before.editSeq[reviewDraftKey(selected)] ?? 0 });
  });
  function capture(): EntrySemanticCapture | null {
    const current = semantic.current(), projection = owner.current().projection, targets = semantic.targets();
    if (current.mode !== (batch ? "chosen" : "current") || !selectedTargets.length || selectedTargets.some(value => !value.selectionId || !value.revisionId || value.translationText === null
      || !project.metadata.targetLocales.includes(value.locale)) || targets.length !== selectedTargets.length
      || targets.some(value => !selectedTargets.some(selected => selected.unitId === value.unitId && selected.locale === value.locale))) return null;
    if (!batch && (!projection || projection.unitId !== target.unitId || projection.locale !== target.locale || projection.basis !== target.basis
      || projection.sourceText !== target.sourceText || projection.translationText !== target.translationText || !sameReviewBasis(projection.basisEvidence, target.basisEvidence))) return null;
    return { unitId: target.unitId, locale: target.locale, sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId,
      selectionId: target.selectionId!, revisionId: target.revisionId!, basis: target.basis, basisEvidence: target.basisEvidence, sequence: current.sequence,
      ...(batch ? { targets: JSON.stringify(selectedTargets) } : {}) };
  }
  function matches(payload: EntrySemanticCapture) { const current = capture(); return current !== null && sameCapture(payload, current); }
  function idle() {
    const current = owner.current(), shared = drafts.getSnapshot();
    return present() && interactionAllowed() && project.metadata.targetLocales.includes(target.locale) && !flight.current && !current.pending && !current.busyMutation
      && !current.batchRunning && !semantic.reserved() && shared.hydration === "ready" && !shared.mutationReserved;
  }
  function preparationMatches(preparation: EntrySemanticPreparation) {
    const current = capture(), items = preparation.value.preview.items, query = reads.client.getQueryState(reads.key(read.key)), evidence = preparedRead.current;
    return current !== null && evidence?.preparation === preparation && evidence.data === read.data && query?.dataUpdateCount === evidence.version && semantic.current().prepared === preparation && semantic.preparationCurrent(preparation) && items.length === selectedTargets.length
      && selectedTargets.every(target => items.some(item => item.source.unitId === target.unitId && item.source.targetLocale === target.locale && item.basis === target.basis
        && sameReviewBasis(item.reviewBasis, target.basisEvidence) && item.source.sourceText === target.sourceText && item.translationText === target.translationText));
  }
  function prepareAvailability(payload: EntrySemanticPreparePayload | undefined): CommandAvailability {
    const config = semantic.current().config;
    return idle() && currentRead() && !!payload && matches(payload) && semantic.current().rules.length > 0 && selectedTargets.length <= config.maxItems && validAiLimits(config) && config.endpoint.trim() !== "" && config.model.trim() !== "" ? { enabled: true } : unavailable;
  }
  function startAvailability(payload: EntrySemanticStartPayload | undefined): CommandAvailability {
    return idle() && currentRead() && !!payload && matches(payload) && preparationMatches(payload.preparation) && semantic.current().consent ? { enabled: true } : unavailable;
  }
  function consentAvailability(payload: EntrySemanticConsentPayload | undefined): CommandAvailability {
    return idle() && currentRead() && !!payload && matches(payload) && preparationMatches(payload.preparation) ? { enabled: true } : unavailable;
  }
  async function perform(payload: EntrySemanticPreparePayload | EntrySemanticStartPayload) {
    if (!(payload.kind === "entry-semantic-prepare" ? prepareAvailability(payload) : startAvailability(payload)).enabled) return;
    const witness = semanticReadProof(reads, read.key, read.data);
    const proof = () => stillPresent() && currentRead() && witness.current() && matches(payload)
      && (payload.kind !== "entry-semantic-start" || preparationMatches(payload.preparation));
    const active = document.activeElement, origin = active && root.current?.contains(active) ? active : null;
    flight.current = true; setWorking(true); setFeedback(null);
    try {
      if (payload.kind === "entry-semantic-prepare") {
        preparedRead.current = null;
        await semantic.prepare(proof);
        const prepared = semantic.current().prepared, query = reads.client.getQueryState(reads.key(read.key));
        if (prepared && proof() && query) preparedRead.current = { preparation: prepared, version: query.dataUpdateCount, data: read.data };
      } else await semantic.start(proof);
      if (sameView()) {
        if (payload.kind === "entry-semantic-prepare") { const prepared = semantic.current().prepared;
          setFeedback({ scope, kind: proof() && prepared && preparationMatches(prepared) ? "prepared" : "changed" }); }
        else if (!semantic.current().pending && semantic.current().notice !== "started" && !semantic.current().failure) setFeedback({ scope, kind: "changed" });
      }
    } finally { witness.dispose(); flight.current = false; if (mounted.current) { focus.current = { identity, origin, preparation: payload.kind === "entry-semantic-prepare" }; setWorking(false); } }
  }
  function resultCurrent() { return semanticReadCurrent(reads, result.key, view) && view?.detail.attemptId === semantic.current().attemptId ? view : null; }
  function rowFor(payload: EntrySemanticRecordPayload) {
    const value = resultCurrent();
    if (!value || value.detail.taskId !== payload.taskId || value.detail.attemptId !== payload.attemptId || result.record?.dataUpdateCount !== payload.queryVersion) return null;
    const row = value.rows.find(row => row.itemId === payload.itemId);
    const target = selectedTargets.find(target => target.unitId === row?.item.source.unitId && target.locale === row.item.source.targetLocale);
    if (!target) return null;
    const item = value.detail.items.find(item => item.status.itemId === payload.itemId);
    const unit = value.detail.recovery.units.find(unit => unit.unitId === payload.recoveryUnitId && unit.itemIds.length === 1 && unit.itemIds[0] === payload.itemId
      && unit.resultIds.length === 1 && unit.resultIds[0] === payload.resultId && unit.actions.includes("adopt-result"));
    return row?.current && row.output && !row.run && item?.resultId === payload.resultId && row.item.source.unitId === target.unitId && row.item.source.targetLocale === target.locale
      && row.item.basis === target.basis && sameReviewBasis(row.item.reviewBasis, target.basisEvidence) && row.item.source.sourceText === target.sourceText
      && row.item.translationText === target.translationText && row.item.selectionId === target.selectionId && row.item.translationRevisionId === target.revisionId && unit ? { value, row, unit } : null;
  }
  function recordAvailability(payload: EntrySemanticRecordPayload | undefined): CommandAvailability {
    return idle() && currentRead() && !!payload && matches(payload) && rowFor(payload) && tasks.canBegin(payload.taskId) ? { enabled: true } : unavailable;
  }
  async function record(payload: EntrySemanticRecordPayload) {
    if (!recordAvailability(payload).enabled) return;
    const current = rowFor(payload); if (!current) return;
    await tasks.beginFromQuery(result.key, current.value.detail, current.unit, "adopt-result", 0);
  }
  function readAvailability(payload: EntrySemanticReadPayload | undefined, select: boolean): CommandAvailability {
    if (!present() || !interactionAllowed() || !payload || !semantic.current().attempts.includes(payload.attemptId)) return unavailable;
    return select ? !semantic.reserved() && !flight.current ? { enabled: true } : unavailable
      : payload.attemptId === semantic.current().attemptId && !result.query.isFetching ? { enabled: true } : unavailable;
  }
  function cancelAvailability(payload: EntrySemanticCancelPayload | undefined): CommandAvailability {
    const value = resultCurrent();
    return present() && interactionAllowed() && !!payload && value && value.detail.taskId === payload.taskId && value.detail.attemptId === payload.attemptId
      && payload.requestId === null && result.record?.dataUpdateCount === payload.queryVersion && value.detail.progress.queued + value.detail.progress.running > 0
      && tasks.canCancel({ taskId: payload.taskId, attemptId: payload.attemptId, origin: "tasks" }) ? { enabled: true } : unavailable;
  }
  async function cancel(payload: EntrySemanticCancelPayload) {
    if (!cancelAvailability(payload).enabled) return;
    const witness = semanticReadProof(reads, result.key, view, payload.queryVersion ?? undefined);
    try { await tasks.cancel({ taskId: payload.taskId, attemptId: payload.attemptId, origin: "tasks" }, () => stillPresent() && witness.current()); }
    finally { witness.dispose(); }
  }
  function scopeAvailability(payload: EntrySemanticScopePayload | undefined): CommandAvailability {
    return inputAllowed() && !!payload && semantic.current().sequence === payload.sequence && semantic.current().mode !== "current" ? { enabled: true } : unavailable;
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const meta = { category: "review" as const, scope: commandScope, binding: null, confirmation: "none" as const };
    const remove = [
      commands.register({ ...meta, id: commandId("review.entry-semantic-current"), nameKey: "workbenchV2.entrySemanticUseCurrent", payloadKind: "entry-semantic-scope", risk: "changes-view", availability: scopeAvailability, handler: value => { if (scopeAvailability(value).enabled) semantic.setMode("current"); } }),
      commands.register({ ...meta, id: commandId("review.entry-semantic-prepare"), nameKey: "semanticReview.prepare", payloadKind: "entry-semantic-prepare", risk: "captures-ai", availability: prepareAvailability, handler: value => { void perform(value); } }),
      commands.register({ ...meta, id: commandId("review.entry-semantic-start"), nameKey: "semanticReview.start", payloadKind: "entry-semantic-start", risk: "runs-ai", availability: startAvailability, handler: value => { void perform(value); } }),
      commands.register({ ...meta, id: commandId("review.entry-semantic-consent"), nameKey: "semanticReview.consent", payloadKind: "entry-semantic-consent", risk: "changes-view", availability: consentAvailability, handler: value => { if (consentAvailability(value).enabled) semantic.setConsent(value.approved); } }),
      commands.register({ ...meta, id: commandId("review.entry-semantic-show-attempt"), nameKey: "semanticReview.history", payloadKind: "entry-semantic-read", risk: "changes-view", availability: value => readAvailability(value, true), handler: value => { if (readAvailability(value, true).enabled) semantic.showAttempt(value.attemptId); } }),
      commands.register({ ...meta, id: commandId("review.entry-semantic-refresh"), nameKey: "semanticReview.refresh", payloadKind: "entry-semantic-read", risk: "reads-review", availability: value => readAvailability(value, false), handler: value => { if (readAvailability(value, false).enabled) void result.query.refetch(); } }),
      commands.register({ ...meta, id: commandId("review.entry-semantic-record"), nameKey: "semanticReview.record", payloadKind: "entry-semantic-record", risk: "captures-execution-action", availability: recordAvailability, handler: value => { void record(value); } }),
      commands.register({ ...meta, id: commandId("review.entry-semantic-cancel"), nameKey: "semanticReview.stop", payloadKind: "entry-semantic-cancel", risk: "cancels-execution-task", availability: cancelAvailability, handler: value => { void cancel(value); } }),
    ];
    return () => remove.forEach(dispose => dispose());
  });
  useLayoutEffect(() => {
    const ticket = focus.current; if (!ticket || working) return;
    focus.current = null;
    if (ticket.identity === identity && stillPresent() && (document.activeElement === document.body || document.activeElement === ticket.origin)) {
      const destination = ticket.preparation && semantic.current().prepared && semantic.current().expanded ? previewRegion.current : feedbackRegion.current;
      destination?.focus();
    }
  });
  const captured = capture(), prepared = state.prepared, fresh = !!prepared && preparationMatches(prepared) && currentRead();
  const preparePayload: EntrySemanticPreparePayload | null = captured ? { ...captured, kind: "entry-semantic-prepare" } : null;
  const startPayload: EntrySemanticStartPayload | null = captured && prepared ? { ...captured, kind: "entry-semantic-start", preparation: prepared } : null;
  const scopePayload: EntrySemanticScopePayload = { kind: "entry-semantic-scope", sequence: state.sequence };
  const attemptPayload: EntrySemanticReadPayload | null = state.attemptId ? { kind: "entry-semantic-read", attemptId: state.attemptId } : null;
  const cancellation: EntrySemanticCancelPayload | null = view ? { kind: "entry-semantic-cancel", taskId: view.detail.taskId, attemptId: view.detail.attemptId,
    queryVersion: result.record?.dataUpdateCount ?? null, requestId: null } : null;
  const failure = failureReason(state.failure), pairLimitValid = validAiLimits(state.config), feedbackKind = feedback?.scope === scope ? feedback.kind : null;
  const setConfig = (value: Parameters<typeof semantic.setConfig>[0]) => { if (inputAllowed()) semantic.setConfig(value); };
  const resultRows = view?.rows.filter(row => selectedTargets.some(target => row.item.source.unitId === target.unitId && row.item.source.targetLocale === target.locale)) ?? [];
  if (!visible) return null;
  return <section className={styles.section} ref={root} aria-label={w("entrySemanticTitle")}
    onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
    <h3>{w("entrySemanticTitle")}</h3><p className={styles.meta}>{w("entrySemanticHelp")}</p>
    {!currentRead() ? <Banner tone="warning" role="status">{w("entrySemanticReadChanged")}</Banner> : null}
    {selectedTargets.some(target => !target.selectionId || target.translationText === null) ? <Banner tone="info">{w("entrySemanticNoSelection")}</Banner> : null}
    {!batch && state.mode !== "current" ? <Banner tone="warning"><p>{w("entrySemanticCurrentOnly")}</p><Button size="sm" disabled={!scopeAvailability(scopePayload).enabled}
      onClick={() => commands.dispatch(commandId("review.entry-semantic-current"), commandScope, scopePayload)}>{w("entrySemanticUseCurrent")}</Button></Banner> : null}
    <Button size="sm" aria-expanded={state.expanded} aria-controls={`${inputOwner}-preparation`} disabled={!sameView()}
      onClick={() => { if (sameView()) semantic.setExpanded(!semantic.current().expanded); }}>{t("semanticReview.prepareTitle")}</Button>
    <div id={`${inputOwner}-preparation`} hidden={!state.expanded}>
    <fieldset className={styles.configuration} disabled={!inputAllowed()}><legend>{t("semanticReview.prepareTitle")}</legend>
      <p>{batch ? t("semanticReview.pairs", { count: selectedTargets.length }) : `${target.nativeKey} → ${target.locale}`}</p>
      {selectedTargets.length > state.config.maxItems ? <p role="alert">{t("semanticReview.errors.pairs")}</p> : null}
      <div className={styles.checks}>{(["meaning", "style"] as const).map(rule => <label className={styles.check} key={rule}><TextInput className={styles.checkbox} type="checkbox" checked={state.rules.includes(rule)}
        onChange={event => { if (inputAllowed()) semantic.setRules(event.target.checked ? [...state.rules, rule] : state.rules.filter(value => value !== rule)); }}/>{t(`semanticReview.rule.${rule}`)}</label>)}</div>
      <ModelConnectionPicker config={state.config} label={t("connections.choose")} active={visible} disabled={!inputAllowed()} editSeq={state.sequence}
        onSelect={(view, id, sequence) => inputAllowed() && semantic.selectConnection(view, id, sequence)}/>
      <PreparationBudgetSummary config={state.config}/>
      <AiConnectionFields config={state.config} setConfig={setConfig} presetName={state.presetName} setPresetName={value => { if (inputAllowed()) semantic.setPresetName(value); }}
        connectionOpen={connectionOpen || ["ai-endpoint", "ai-model", "ai-credential"].includes(failure ?? "")} setConnectionOpen={setConnectionOpen}
        failure={!pairLimitValid ? "ai-limits" : failure} idPrefix={inputOwner} maxItemsLabel={t("semanticReview.maxItems")}/>
      <div className={styles.checks}><label className={styles.check}><TextInput className={styles.checkbox} type="checkbox" checked={state.config.shareTerms} onChange={event => setConfig(value => ({ ...value, shareTerms: event.target.checked }))}/>{t("ai.shareTerms")}</label>
        <label className={styles.check}><TextInput className={styles.checkbox} type="checkbox" checked={state.config.shareContext} onChange={event => setConfig(value => ({ ...value, shareContext: event.target.checked }))}/>{t("ai.shareContext")}</label></div>
      <SourceContextChoice value={state.config.sourceContext} onChange={sourceContext => setConfig(value => ({ ...value, sourceContext }))}/>
    </fieldset>
    {!state.config.endpoint.trim() || !state.config.model.trim() ? <p className={styles.meta}>{w("entrySemanticChooseConnection")}</p> : null}
    {!state.rules.length ? <p role="status">{t("semanticReview.errors.rules")}</p> : null}
    <Button size="sm" disabled={!preparePayload || !prepareAvailability(preparePayload).enabled} onClick={() => { if (preparePayload) commands.dispatch(commandId("review.entry-semantic-prepare"), commandScope, preparePayload); }}>{t("semanticReview.prepare")}</Button>
    {prepared ? <section ref={previewRegion} tabIndex={-1} className={styles.preview} aria-label={t("semanticReview.preview")}><h4>{t("semanticReview.preview")}</h4>
      {!fresh ? <Banner tone="warning">{w("entrySemanticReadChanged")}</Banner> : null}<p>{prepared.value.preview.config.model} · {prepared.value.preview.config.endpoint}</p>
      <PreparationBudgetSummary config={prepared.value.preview.config}/>
      {prepared.value.preview.items.map(item => <div key={`${item.source.unitId}:${item.source.targetLocale}`} className={styles.previewItem}>
        <h5>{item.source.nativeKey} → {item.source.targetLocale}</h5><div className={styles.text}><TokenizedText text={item.source.sourceText}/></div>
        <p>{t("semanticReview.translation")}</p><div className={styles.text}>{item.translationText === "" ? w("editorEmptySelection") : <TokenizedText text={item.translationText}/>}</div>
        {item.source.terms.map(term => <p key={term.revisionId}>{term.source} → {term.target}</p>)}{item.source.context ? <div className={styles.text}><TokenizedText text={item.source.context.text}/></div> : null}
        <SourceContextPreview capture={item.source.sourceContext}/><ProjectFactPreview capture={item.source.projectContext}/><ContextResourceCapturePreview capture={item.source.contextResources}/>
        {item.source.omissions.map(reason => <p className={styles.meta} key={reason}>{reason.startsWith("term-conflict:") ? t("ai.termConflict", { term: reason.slice(14) }) : t(`ai.${reason}`, { defaultValue: reason })}</p>)}
      </div>)}<p className={styles.meta}>{t("semanticReview.disclosure")}</p>
      <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={state.consent} disabled={!captured || !consentAvailability({ ...captured, kind: "entry-semantic-consent", preparation: prepared, approved: true }).enabled}
        onChange={event => { if (captured) commands.dispatch(commandId("review.entry-semantic-consent"), commandScope, { ...captured, kind: "entry-semantic-consent", preparation: prepared, approved: event.target.checked }); }}/>{t("semanticReview.consent")}</label>
      <Button size="sm" variant="primary" disabled={!startPayload || !startAvailability(startPayload).enabled} onClick={() => { if (startPayload) commands.dispatch(commandId("review.entry-semantic-start"), commandScope, startPayload); }}>{t("semanticReview.start")}</Button>
    </section> : null}
    </div>
    {state.attempts.length ? <div className={styles.actions}><Menu label={t("semanticReview.history")} trigger={<Button size="sm" disabled={!present() || semantic.reserved()}>{t("semanticReview.history")}</Button>}
      items={state.attempts.map((attemptId, index) => { const payload: EntrySemanticReadPayload = { kind: "entry-semantic-read", attemptId }; return { id: attemptId,
        label: t("semanticReview.attempt", { count: index + 1 }), disabled: !readAvailability(payload, true).enabled, onSelect: () => commands.dispatch(commandId("review.entry-semantic-show-attempt"), commandScope, payload) }; })}/>
      {attemptPayload ? <Button size="sm" disabled={!readAvailability(attemptPayload, false).enabled} onClick={() => commands.dispatch(commandId("review.entry-semantic-refresh"), commandScope, attemptPayload)}>{t("semanticReview.refresh")}</Button> : null}</div> : null}
    {result.query.isFetching && state.attemptId ? <p role="status">{t("semanticReview.reading")}</p> : null}
    {result.query.error ? <Banner tone="error" role="alert">{t("semanticReview.readFailed")}<CommandFailureDetails failure={commandFailure(result.query.error)}/></Banner> : null}
    {state.attemptId && !result.query.isFetching && !result.query.error && view === null ? <p role="status">{t("semanticReview.notFound")}</p> : null}
    {view ? <section className={styles.results} aria-label={t("semanticReview.results")}><h4>{t("semanticReview.results")}</h4><p>{view.preview.config.model} · {view.preview.recipe}</p>
      <p className={styles.meta}>{t("ai.progress", { ...view.detail.progress, defaultValue: enUS.ai.progress })}</p>
      {resultRows.length === 0 ? <Banner tone="info">{w("entrySemanticOtherEntry")}</Banner> : null}
      {resultRows.map(row => {
        const item = view.detail.items.find(item => item.status.itemId === row.itemId), unit = item?.resultId ? view.detail.recovery.units.find(unit => unit.itemIds.length === 1
          && unit.itemIds[0] === row.itemId && unit.resultIds.length === 1 && unit.resultIds[0] === item.resultId && unit.actions.includes("adopt-result")) : null;
        const payload: EntrySemanticRecordPayload | null = captured && item?.resultId && unit && result.record ? { ...captured, kind: "entry-semantic-record", taskId: view.detail.taskId,
          attemptId: view.detail.attemptId, itemId: row.itemId, resultId: item.resultId, recoveryUnitId: unit.unitId, queryVersion: result.record.dataUpdateCount } : null;
        return <article className={styles.result} key={row.itemId}><h5>{row.item.source.nativeKey} → {row.item.source.targetLocale}</h5>
          <p>{t(`ai.states.${item?.status.execution ?? "unknown"}`)}</p>{!row.current ? <Banner tone="warning">{t("semanticReview.staleResult")}</Banner> : null}
          {row.run ? <p>{w("entrySemanticRecorded")}</p> : null}
          {row.output ? <>{row.output.rules.map(rule => <section key={rule.rule}><h5>{t(`semanticReview.rule.${rule.rule}`)}</h5>
            {rule.findings.length ? rule.findings.map((finding, index) => <div key={`${finding.code}:${index}`} className={styles.text}><p><TokenizedText text={finding.detail}/></p>{finding.suggestion ? <p><TokenizedText text={finding.suggestion}/></p> : null}</div>) : <p>{t("semanticReview.noFindings")}</p>}</section>)}
            <p>{t("ai.usageDetails.requests", { count: row.output.requests })}</p><AiOutputUsage usage={row.output.usage} incomplete={row.output.usageIncomplete}/>
            {!row.run ? <Button size="sm" disabled={!payload || !recordAvailability(payload).enabled} onClick={() => { if (payload) commands.dispatch(commandId("review.entry-semantic-record"), commandScope, payload); }}>{t("semanticReview.record")}</Button> : null}</> : null}
        </article>;
      })}
      {cancellation && view.detail.progress.queued + view.detail.progress.running > 0 ? <><p className={styles.meta}>{t("semanticReview.stopHelp")}</p><Button size="sm" disabled={!cancelAvailability(cancellation).enabled} onClick={() => commands.dispatch(commandId("review.entry-semantic-cancel"), commandScope, cancellation)}>{t("semanticReview.stop")}</Button></> : null}
      {tasks.current(view.detail.taskId)?.phase === "recorded" ? <p role="status">{w("entrySemanticStopRecorded")}</p> : null}
    </section> : null}
    <div ref={feedbackRegion} role="group" aria-label={w("entrySemanticResult")} tabIndex={-1} className={styles.feedback}>
      {feedbackKind && !state.failure && !state.pending ? <Banner tone={feedbackKind === "prepared" ? "success" : "warning"} role="status">{w(feedbackKind === "prepared" ? "entrySemanticPrepared" : "entrySemanticReadChanged")}</Banner> : null}
      <SemanticRecoveryPanel commandPrefix={batch ? "review.batch-semantic" : undefined} project={project} owner={owner} commands={commands} gate={gate} viewId={viewId} disabled={disabled} visible={visible} parentDialogId={parentDialogId}/>
    </div>
  </section>;
}
