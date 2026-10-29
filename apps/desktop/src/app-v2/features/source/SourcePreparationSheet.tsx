import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, Sheet } from "../../../design-system/Dialog";
import { Button } from "../../../design-system/Button";
import { Field } from "../../../design-system/Field";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { CommandFailureDetails, type CommandFailure } from "../../../CommandFailure";
import { PluginPermissions } from "../../../PluginPermissions";
import { matchingPluginEnvironments, pluginEnvironmentVersion } from "../../../pluginEnvironments";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { executionCommands, executionContext } from "../../../executionCommands";
import { sourceReads } from "../../../sourceQueries";
import { sameSourceEnvironment } from "../../../sourceCommands";
import { readCompleteAttempt } from "../../../executionRead";
import type { ProjectView } from "../../../projectCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import SourceDraftRecovery from "../../../SourceDraftRecovery";
import { SourceDraftHandleProvider } from "../../../SourceDraftSession";
import { SourceMaintenanceHookChoice } from "../../../SourceMaintenanceHookControls";
import { TaskCancellationFeedback } from "../../../ExecutionTaskSession";
import { jsonIdentity } from "../../../pluginToolChoices";
import type { SourceDraftValue } from "../../../sourceDraftCommands";
import SourceMappingPanel from "./SourceMappingPanel";
import SourceSavedDetails from "./SourceSavedDetails";
import type { SourceOwner, SourceReviewTarget } from "./sourceTypes";
import styles from "./SourceMaintenance.module.css";

export interface SourceDrop { dropTicket: string; folderName: string }
export default function SourcePreparationSheet({ project, owner, open, disabled, gate, viewId, onClose, onApplied, onOpenEntry, target, savedSnapshotId = null, drop, dropFailure, onDropConsumed }: {
  project: ProjectView; owner: SourceOwner; open: boolean; disabled: boolean; gate: InteractionGate; viewId: string | null;
  onClose: () => void; onApplied: (snapshotId: string, release: () => void) => void;
  onOpenEntry: (snapshotId: string, unitId: string, locale: string, release: () => void) => void;
  target: SourceReviewTarget | null; savedSnapshotId?: string | null; drop: SourceDrop | null; onDropConsumed: () => void;
  dropFailure: CommandFailure | null;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "sourceMaintenance" }), { t: old } = useTranslation();
  const reads = useSessionReads(), context = executionContext(project), dialogId = useId(), inputId = useId();
  const [inventoryRevision, setInventoryRevision] = useState(0), [targetBlocked, setTargetBlocked] = useState(false);
  const [discardFrame, setDiscardFrame] = useState<SourceDraftValue | null>(null), [discarding, setDiscarding] = useState(false), discardDialogId = useId();
  useLayoutEffect(() => discardFrame ? gate.pushDialog(discardDialogId) : undefined, [discardFrame, gate, discardDialogId]);
  const dialogRelease = useRef<(() => void) | null>(null);
  const release = () => { dialogRelease.current?.(); dialogRelease.current = null; };
  useLayoutEffect(() => { if (!open) return; dialogRelease.current = gate.pushDialog(dialogId); return release; }, [open, gate, dialogId]);
  useEffect(() => () => gate.releaseOwner(inputId), [gate, inputId]);
  const state = owner.state, inventoryOptions = sourceReads.inventory(inventoryRevision);
  const historyOnly = savedSnapshotId !== null || target?.kind === "resolve-source-mapping";
  const savedSnapshot = savedSnapshotId ?? (target?.kind === "resolve-source-mapping" ? target.snapshotId : !state.attempt ? state.receiptRef?.snapshotId : null);
  const inventory = useSessionQuery({ ...inventoryOptions, enabled: open && !historyOnly });
  const sourceOptions = sourceReads.integration(context, state.source);
  const source = useSessionQuery({ ...sourceOptions, enabled: open && !historyOnly && !!state.source });
  const detail = useSessionQuery({ key: ["source-attempt", state.attempt, 0, 100], scopes: ["execution"], enabled: open && !historyOnly && !!state.attempt,
    read: () => { if (!state.attempt) throw new Error("No source attempt"); return executionCommands.attempt({ ...context, attemptId: state.attempt, offset: 0, limit: 100 }); } });
  const check = useSessionQuery({ key: ["source-check", state.checkAttempt], scopes: ["execution"], enabled: open && !historyOnly && !!state.checkAttempt,
    read: () => { if (!state.checkAttempt) throw new Error("No source check attempt"); return readCompleteAttempt(context, state.checkAttempt, "source-semantic-check"); } });
  const item = detail.data?.operation === "source-import" && detail.data.items.length === 1 ? detail.data.items[0] : null;
  const checked = check.data?.items.length === 1 ? check.data.items[0] : null;
  const choices = inventory.data?.choices ?? [], environments = inventory.data?.environments ?? [];
  const choiceKey = state.source ? `${state.source.package.packageDigest}:${state.source.resourceId}` : state.domain;
  const choice = choices.find(choice => choice.key === choiceKey), runtimes = matchingPluginEnvironments(environments, choice?.runtimeKinds ?? []);
  const current = () => open && !disabled && !reads.retired && gate.canDispatch({ viewId, source: "button", dialogId });
  const readOnly = disabled || owner.journal.hydration !== "ready" || owner.journal.retired;
  const configurationLocked = readOnly || owner.inFlight() || owner.hasPending() || !!state.attempt || !!Object.keys(state.lineage).length || state.actor !== "";
  function fresh(key: readonly unknown[]) { const value = reads.client.getQueryState(reads.key(key)); return value?.status === "success" && value.fetchStatus === "idle" && !value.isInvalidated && value.error === null; }
  const environment = state.source && source.data && !source.error && sameSourceEnvironment(source.data, state.source) ? source.data : null;
  const canPrepare = current() && !owner.blocked() && !!environment && fresh(sourceOptions.key) && fresh(inventoryOptions.key);
  useEffect(() => {
    if (!open || target?.kind !== "compare-source-mapping" || owner.journal.hydration !== "ready") return;
    if (owner.current().attempt === target.attemptId) { setTargetBlocked(false); return; }
    setTargetBlocked(!owner.showAttempt(target.attemptId));
  }, [open, target, owner.journal.hydration, owner.current]);
  function chooseSource(key: string, digest: string) {
    if (configurationLocked || !current()) return;
    const selected = choices.find(choice => choice.key === key);
    owner.setSource(null); owner.setDomain(key);
    if (selected && digest) owner.setSource({ package: selected.package, resourceId: selected.resourceId, environmentDigest: digest });
  }
  return <Sheet className="source-preparation-sheet" open={open} onOpenChange={value => { if (!value && gate.getSnapshot().composingOwners.length === 0) onClose(); }} title={t(historyOnly ? "savedSource" : "title")}
    description={project.metadata.displayName} closeLabel={t("close")} onEscapeKeyDown={event => { if (event.isComposing || event.keyCode === 229 || gate.getSnapshot().composingOwners.length) event.preventDefault(); }}>
    <div className={styles.body} onFocusCapture={event => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) gate.setInputOwner(viewId, inputId); }}
      onBlurCapture={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputId); }}
      onCompositionStart={() => gate.setComposing(inputId, true)} onCompositionEnd={() => gate.setComposing(inputId, false)}>
      {!historyOnly ? <><SourceDraftRecovery owner={owner} disabled={disabled}/>
      <TaskCancellationFeedback origin="source" taskId={detail.data?.taskId} disabled={disabled} visible={open}/>
      {targetBlocked ? <Banner tone="warning">{t("targetBlocked")}</Banner> : null}
      {drop ? <Banner>{t("droppedFolder", { folder: drop.folderName })}</Banner> : null}
      {dropFailure ? <Banner tone="error">{t("dropFailed")}<CommandFailureDetails failure={dropFailure}/></Banner> : null}
      {state.failure ? <Banner tone="error">{t("operationFailed")}<CommandFailureDetails failure={state.failure}/></Banner> : null}
      {inventory.isFetching ? <LoadingState label={t("readingImporters")}/> : inventory.error ? <Banner tone="error" action={<Button onClick={() => setInventoryRevision(value => value + 1)}>{t("retryRead")}</Button>}>{t("importersFailed")}</Banner> : null}
      <Field label={old("source.integration")}><select disabled={configurationLocked || !fresh(inventoryOptions.key)} value={choiceKey} onChange={event => chooseSource(event.target.value, "")}>
        <option value="">{old("sourcePlugin.choosePackage")}</option>{choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
      </select></Field>
      <Field label={old("sourcePlugin.runtime")}><select disabled={configurationLocked || !choice || !fresh(inventoryOptions.key)} value={state.source?.environmentDigest ?? ""}
        onChange={event => chooseSource(choiceKey, event.target.value)}><option value="">{old("sourcePlugin.chooseRuntime")}</option>
        {runtimes.map(runtime => <option key={runtime.environmentDigest} value={runtime.environmentDigest}>{old(runtime.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption",
          { version: pluginEnvironmentVersion(runtime.environment), system: runtime.environment.platform.operatingSystem, architecture: runtime.environment.platform.architecture })}</option>)}
      </select></Field>
      {source.error ? <Banner tone="error" action={<Button onClick={() => void source.refetch()}>{t("retryRead")}</Button>}>{t("importerUnavailable")}</Banner> : null}
      {environment ? <><p>{environment.declaration.displayName}</p><ul>{environment.declaration.materials.map(file => <li key={file.logicalPath}>{old("sourcePlugin.material", { path: file.logicalPath, bytes: String(file.maxBytes) })}</li>)}</ul></> : null}
      <Button disabled={!canPrepare || configurationLocked} onClick={() => { if (!current()) return; const ticket = drop?.dropTicket; onDropConsumed();
        if (ticket) void owner.selectDropped(ticket); else void owner.select(); }}>{t(drop ? "useDroppedFolder" : "chooseFolder")}</Button>
      {state.selection || state.preflight ? <>
        <p>{state.selection?.folderName ?? state.selectionLabel}</p>
        <Field label={old("source.language", { language: project.metadata.sourceLocale })}><input type="checkbox" checked={state.declared} disabled={configurationLocked}
          onChange={event => { if (current()) owner.declare(event.target.checked); }}/></Field>
        {state.selection ? <Button disabled={!canPrepare || !state.declared || configurationLocked} onClick={() => { if (current()) void owner.preflight(current); }}>{old("source.preflight")}</Button> : null}
      </> : null}
      {state.preflight ? <section className={styles.body} aria-label={t("capturedInput")}>
        <p>{state.preflight.source.extractor.provider.plugin.id} {state.preflight.source.extractor.provider.plugin.version}</p>
        <p>{old("sourcePlugin.captured", { count: state.preflight.files.length, language: state.preflight.sourceLanguage })}</p>
        <ul>{state.preflight.files.map(file => <li key={file.logicalPath}>{old("sourcePlugin.capturedFile", { path: file.logicalPath, bytes: String(file.byteLength) })}</li>)}</ul>
        <PluginPermissions permissions={state.preflight.source.extractor.declaration.permissions}/><p>{old("sourcePlugin.unsandboxed")}</p>
        <Field label={old("sourcePlugin.producerConsent")}><input type="checkbox" checked={state.producerConsent === state.preflight.inputDigest} disabled={configurationLocked}
          onChange={event => { if (current()) owner.consentProducer(event.target.checked); }}/></Field>
        <Button variant="primary" disabled={!canPrepare || configurationLocked || state.producerConsent !== state.preflight.inputDigest}
          onClick={() => { if (current()) void owner.start(current); }}>{old("source.start")}</Button>
      </section> : null}
      {state.attempt ? <section className={styles.body} aria-label={t("extraction")}>
        <h2>{t("extraction")}</h2>{detail.isFetching ? <LoadingState label={t("readingTask")}/> : null}
        {item ? <p>{old(`execution.states.${item.status.execution}`)}</p> : null}
        {item?.status.execution === "failed" ? <Banner tone="error">{t("extractionFailed")}</Banner> : null}
        <Button disabled={!current() || detail.isFetching} onClick={() => void detail.refetch()}>{t("refreshTask")}</Button>
        {detail.data && item && (item.status.execution === "queued" || item.status.execution === "dispatched") ? <Button disabled={!current() || owner.hasPending()}
          onClick={() => { if (current()) void owner.cancelTask(detail.data!.taskId, current, detail.data!.attemptId); }}>{t("stopTask")}</Button> : null}
        {item?.resultId && item.status.execution === "succeeded" && item.status.validation !== "valid" ? <>
          <p>{t("checkHelp")}</p><Button disabled={!canPrepare || owner.hasPending() || owner.inFlight()} onClick={() => { if (current()) void owner.prepareCheck({ attemptId: state.attempt!, resultId: item.resultId! }, current); }}>{t("prepareCheck")}</Button>
          {state.checkReview ? <><p>{state.checkReview.source.checker.provider.plugin.id} {state.checkReview.source.checker.provider.plugin.version}</p>
            <p>{old("sourcePlugin.rules", { count: state.checkReview.rules.length })}</p><PluginPermissions permissions={state.checkReview.source.checker.declaration.permissions}/><p>{old("sourcePlugin.unsandboxed")}</p>
            <Field label={old("sourcePlugin.checkerConsent")}><input type="checkbox" checked={state.checkerConsent === state.checkReview.inputDigest} disabled={readOnly || owner.inFlight() || owner.hasPending()}
              onChange={event => { if (current()) owner.consentChecker(event.target.checked); }}/></Field>
            <Button disabled={!current() || readOnly || owner.inFlight() || owner.hasPending() || state.checkerConsent !== state.checkReview.inputDigest}
              onClick={() => { if (current()) void owner.startCheck(current); }}>{t("startCheck")}</Button></> : null}
        </> : null}
        {state.checkAttempt ? <><p>{t("independentCheck")}</p>{check.isFetching ? <LoadingState label={t("readingTask")}/> : null}
          {checked ? <p>{old(`execution.states.${checked.status.execution}`)}</p> : null}
          <Button disabled={!current() || check.isFetching} onClick={() => void check.refetch()}>{t("refreshTask")}</Button>
          {checked?.status.execution === "succeeded" && checked.resultId ? <Button disabled={!current() || owner.inFlight() || owner.hasPending()}
            onClick={() => { if (current()) void owner.finishCheck(checked.resultId!); }}>{t("finishCheck")}</Button> : null}</> : null}
        {item?.resultId && item.status.execution === "succeeded" ? <SourceMappingPanel project={project} owner={owner} visible={open} disabled={disabled || targetBlocked}
          current={current} onApplied={snapshotId => onApplied(snapshotId, release)} target={target?.kind === "compare-source-mapping" ? target : null}/> : null}
      </section> : null}
      {!owner.hasPending() && owner.hasDraft() ? <Button disabled={!current() || !owner.canDiscard()} onClick={() => { if (current()) setDiscardFrame(owner.draftValue()); }}>{t("discardDraft")}</Button> : null}
      <SourceDraftHandleProvider value={owner}><SourceMaintenanceHookChoice project={project} disabled={readOnly || owner.inFlight() || owner.hasPending()}/></SourceDraftHandleProvider>
      {owner.hook.state.sourceActionId ? <section className={styles.body} aria-label={old("sourceHook.statusTitle")}><h3>{old("sourceHook.statusTitle")}</h3>
        <p>{old("sourceHook.separateOutcome")}</p>{owner.hook.state.stop?.unknown ? <p>{old("sourceHook.stopUnknown")}</p> : null}
        {owner.hook.state.stop?.notKnown ? <p>{old("sourceHook.stopNotKnown")}</p> : null}
        <div className={styles.actions}><Button disabled={!current() || owner.hook.state.reading} onClick={() => { if (current()) void owner.hook.read(); }}>{old("sourceHook.read")}</Button>
          <Button disabled={!current() || !owner.hook.canStop()} onClick={() => { if (current()) void owner.hook.stop(); }}>{old("sourceHook.stop")}</Button>
          {owner.hook.canEndWait() ? <Button disabled={!current()} onClick={() => { if (current()) void owner.hook.endWait(); }}>{old("sourceHook.endWait")}</Button> : null}</div>
        {owner.hook.state.waitEnded ? <p role="status">{old("sourceHook.waitEnded")}</p> : null}
        {owner.hook.state.stopFailure ? <CommandFailureDetails failure={owner.hook.state.stopFailure}/> : null}
      </section> : null}</> : null}
      {savedSnapshot ? <SourceSavedDetails key={savedSnapshot} project={project} snapshotId={savedSnapshot}
        target={target?.kind === "resolve-source-mapping" && target.snapshotId === savedSnapshot ? target : null} visible={open} current={current}
        onOpenEntry={(unitId, locale) => onOpenEntry(savedSnapshot, unitId, locale, release)}/> : null}
    </div>
    <Dialog open={discardFrame !== null} onOpenChange={value => { if (!value && !discarding) setDiscardFrame(null); }} title={t("discardTitle")} description={t("discardHelp")}
      closeLabel={t("close")} footer={<div className={styles.actions}><Button disabled={discarding} onClick={() => setDiscardFrame(null)}>{t("keepDraft")}</Button>
        <Button disabled={discarding || !discardFrame || jsonIdentity(discardFrame) !== jsonIdentity(owner.draftValue()) || !owner.canDiscard()} onClick={() => {
          if (!discardFrame || !gate.canDispatch({ viewId, source: "button", dialogId: discardDialogId }) || jsonIdentity(discardFrame) !== jsonIdentity(owner.draftValue())) return;
          setDiscarding(true); void owner.discard().then(ok => { if (ok) setDiscardFrame(null); }).finally(() => setDiscarding(false));
        }}>{t("discardConfirm")}</Button></div>}><p>{t("discardHelp")}</p></Dialog>
  </Sheet>;
}
