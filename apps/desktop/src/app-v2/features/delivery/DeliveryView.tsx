import { useEffect, useLayoutEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import { Field } from "../../../design-system/Field";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import { PluginBuildControls, type BuildWorkbenchParts } from "../../../PluginBuildControls";
import { ReleaseDraftHandleProvider, type useReleaseDraftSession } from "../../../ReleaseDraftSession";
import { ExecutionTaskHandleProvider, type useExecutionTaskSession } from "../../../ExecutionTaskSession";
import { executionContext } from "../../../executionCommands";
import { releaseCommands, type DeliveryView as DeliveryRecord } from "../../../releaseCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import type { DecisionItem, DecisionPage } from "../../../decisionCommands";
import type { ProjectView } from "../../../projectCommands";
import { WorkbenchCommandsProvider, type WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import { useDeliveryCommands } from "./useDeliveryCommands";
import styles from "./DeliveryView.module.css";

export interface DeliveryViewProps {
  project: ProjectView;
  owner: ReturnType<typeof useReleaseDraftSession>;
  tasks: ReturnType<typeof useExecutionTaskSession>;
  commands: WorkbenchCommands;
  gate: InteractionGate;
  viewId: string;
  visible: boolean;
  disabled: boolean;
  onOpenEntry?: (unitId: string, locale: string) => Promise<boolean>;
  onOpenDecisions: () => void;
  onOpenKnowledge: () => void;
  onOpenExtensions: () => void;
  inbox?: { page: DecisionPage | undefined; loading: boolean; failure: unknown; current: (basis: string) => boolean; retry: () => void };
  onOpenDecision?: (item: DecisionItem) => Promise<boolean>;
  target?: { releaseId: string; deliveryId: string; actionId: string } | null;
}
type Step = "readiness" | "build" | "verification" | "export" | "history";
const steps: Step[] = ["readiness", "build", "verification", "export", "history"];

/** A delivery surface over the retained Release owner. Opening a step never
 * starts work; every mutation goes through its original registered command. */
export function DeliveryView(props: DeliveryViewProps) {
  const { project, owner, commands, gate, viewId, visible, disabled, inbox, onOpenDecision, target,
    onOpenEntry, onOpenDecisions, onOpenKnowledge, onOpenExtensions } = props;
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "deliveryWorkbench" }), { t: global } = useTranslation();
  const reads = useSessionReads(), context = executionContext(project), id = useId();
  const [primaryMode, setPrimaryMode] = useState<"build" | "export">(owner.chosen ? "export" : "build");
  const [expanded, setExpanded] = useState<Step[]>(() => owner.checkReview && !owner.checkAttempt || owner.workflow?.review?.phase === "prepared" && !owner.workflow.start && !owner.workflow.stop ? ["verification"] : owner.prepared && !owner.attempt ? ["build"] : []), [settingsOpen, setSettingsOpen] = useState(false);
  const selectedTarget = useRef<string | null>(null), mounted = useRef(false);
  const decisionFlight = useRef(0), currentView = useRef({ visible, sessionToken: project.sessionToken, viewId });
  currentView.current = { visible, sessionToken: project.sessionToken, viewId };
  const [decisionChanged, setDecisionChanged] = useState(false);
  useLayoutEffect(() => { decisionFlight.current += 1; return () => { decisionFlight.current += 1; }; }, [visible, project.sessionToken, viewId]);
  const interaction = useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const inputOwner = `delivery-input-${viewId}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; gate.releaseOwner(inputOwner); }; }, [gate, inputOwner]);
  const sameSession = () => mounted.current && !reads.retired && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken;
  const canInteract = (kind: "action" | "input" = "action") => visible && !disabled && sameSession()
    && (kind === "action" ? gate.canDispatch({ viewId, source: "button" })
      : gate.getSnapshot().visibleViewId === viewId && gate.getSnapshot().dialogs.length === 0 && gate.getSnapshot().intentOwner === null);
  const delivery = useDeliveryCommands({ project, owner, commands, gate, viewId, visible, disabled, onOpenEntry });
  const { releasesRead, deliveriesRead, commandScope } = delivery;
  const { chosen, selection, preview, overwrite, result, pending, busy } = owner;
  const releases = releasesRead.data ?? [], deliveries = deliveriesRead.data ?? [];
  const targetRead = useSessionQuery({ key: ["delivery-navigation-record", target], scopes: ["release"], enabled: visible && !!target,
    read: async () => {
      if (!target) throw new Error("No delivery navigation target");
      const record = await releaseCommands.deliveryRecord({ ...context, ...target });
      if (record && (record.releaseId !== target.releaseId || record.deliveryId !== target.deliveryId || record.actionId !== target.actionId)) throw new Error("Delivery navigation identity changed");
      return record;
    } });
  const targetRecord = targetRead.error ? undefined : targetRead.data;
  const originalWorkKept = !!target && (owner.buildDirty || owner.deliveryDirty || owner.reserved() || !!owner.prepared || !!owner.attempt || !!owner.checkAttempt || !!owner.workflow);
  useEffect(() => {
    if (!target || !targetRecord || targetRead.isFetching || targetRead.error || releasesRead.isFetching || releasesRead.error
      || !canInteract() || originalWorkKept || chosen?.releaseId === target.releaseId) return;
    const navigation = `${target.releaseId}:${target.deliveryId}:${target.actionId}`;
    if (selectedTarget.current === navigation) return;
    const record = releases.find(item => item.releaseId === target.releaseId);
    if (!record || targetRecord.releaseId !== target.releaseId || targetRecord.deliveryId !== target.deliveryId || targetRecord.actionId !== target.actionId) return;
    const value = owner.current();
    if (value.buildDirty || value.deliveryDirty || owner.reserved() || value.prepared || value.attempt || value.checkAttempt || value.workflow || value.selection || value.preview) return;
    if (commands.dispatch("release.choose-release", commandScope, delivery.recordPayload(record))) { selectedTarget.current = navigation; setPrimaryMode("export"); }
  }, [target, targetRecord, targetRead.isFetching, targetRead.error, releasesRead.dataUpdatedAt, releasesRead.isFetching, releasesRead.error, visible, disabled, originalWorkKept, chosen?.releaseId, interaction]);

  function reveal(step: Step) { if (canInteract()) setExpanded(current => current.includes(step) ? current : [...current, step]); }
  function toggle(step: Step) { if (canInteract()) { if (step === "export") setPrimaryMode("export"); else if (step === "build" || step === "verification" || step === "readiness") setPrimaryMode("build"); setExpanded(current => current.includes(step) ? current.filter(item => item !== step) : [...current, step]); } }
  const isExpanded = (step: Step) => expanded.includes(step) || step === "export" && !!target || step === "history" && !!owner.savedAttempt;
  function dispatchExport() {
    if (!canInteract()) return;
    const recovery = delivery.deliveryPendingPayload();
    if (recovery) { commands.dispatch("release.check-export", commandScope, recovery); return; }
    if (!chosen) { reveal("history"); return; }
    if (!selection) { const payload = delivery.destinationPayload(); if (payload) commands.dispatch("release.choose-destination", commandScope, payload); return; }
    if (!preview) { const payload = delivery.destinationPayload(); if (payload) commands.dispatch("release.preview-destination", commandScope, payload); return; }
    const payload = delivery.previewPayload(); if (payload) commands.dispatch("release.export", commandScope, payload);
  }
  function exportEnabled() {
    if (!canInteract()) return false;
    if (delivery.deliveryPendingPayload()) return delivery.deliveryPendingAvailability(delivery.deliveryPendingPayload()).enabled;
    if (!chosen) return false;
    return preview ? delivery.previewAvailability(delivery.previewPayload(), true).enabled
      : delivery.destinationAvailability(delivery.destinationPayload(), !!selection).enabled;
  }
  async function recorded(actionId: string) {
    const response = await releasesRead.refetch();
    if (!sameSession() || response.error || owner.current().buildReceipt?.actionId !== actionId) return;
    const record = response.data?.find(item => item.actionId === actionId && item.attemptId === owner.current().buildReceipt?.attemptId), current = owner.current();
    if (record && !current.chosen && !current.selection && !current.preview && !current.result && !current.deliveryDirty && canInteract() && commands.dispatch("release.choose-release", commandScope, delivery.recordPayload(record))) setPrimaryMode("export");
  }
  const settings = owner.languages.length ? owner.languages.map(locale => t("settingsSummary", { locale, paths: (owner.names[locale] ?? "").split(/\r?\n/).filter(Boolean).join(", ") || t("noPaths") })).join(" · ") : t("settingsEmpty");
  const deliveryFailure = owner.failureArea === "delivery" ? owner.failure : null;
  const failureCode = typeof deliveryFailure === "string" ? deliveryFailure : deliveryFailure?.code;
  const deliveryReasons = { "destination-conflict": "release.errorDestination", "dependency-conflict": "release.errorDependency", "invalid-input": "release.errorInput", "permission-denied": "release.errorPermission", "session-invalid": "release.errorSession", "limit-exceeded": "release.errorLimit", "outcome-unknown": "release.errorOutcomeUnknown" } as const;
  const deliveryReason = failureCode && failureCode in deliveryReasons ? deliveryReasons[failureCode as keyof typeof deliveryReasons] : "release.errorUnknown";
  const historyFailure = releasesRead.error ?? deliveriesRead.error;
  const pendingExport = pending && pending.kind !== "build";
  const hasConflict = preview?.files.some(file => file.state === "conflict") ?? false;
  function outcome(record: DeliveryRecord) {
    return <article className={styles.outcome} key={record.deliveryId}>
      <p><strong>{global(`release.deliveryState.${record.state}`)}</strong> · <time>{record.createdAt}</time></p>
      <p>{record.directory}</p><ul>{record.files.map(file => <li key={`${file.locale}:${file.fileName}`}><code>{file.fileName}</code> · {global(`release.deliveryState.${file.state}`)}</li>)}</ul>
      {(record.state === "pending" || record.state === "unknown") && selection ? <Button variant="secondary" disabled={!delivery.deliveryAvailability(delivery.deliveryPayload(record)).enabled} onClick={() => { const payload = delivery.deliveryPayload(record); if (payload) commands.dispatch("release.reconcile-delivery", commandScope, payload); }}>{t("checkAttempt")}</Button> : null}
      <details><summary>{t("diagnostics")}</summary><dl><dt>{global("release.overwrite")}</dt><dd>{global(record.overwriteConflicts ? "release.overwriteAllowed" : "release.overwriteNotAllowed")}</dd></dl><ul>{record.files.map(file => <li key={`${file.locale}:${file.fileName}`}><code>{file.fileName}</code><p><code>{file.expectedSha256}</code></p>{file.actualSha256 ? <code>{file.actualSha256}</code> : null}</li>)}</ul></details>
    </article>;
  }
  function formatDate(value: string) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "short" }).format(date) : value;
  }
  const history = <>
    <div className={styles.actions}><Button variant="secondary" disabled={!canInteract() || releasesRead.isFetching} onClick={() => { if (canInteract()) void releasesRead.refetch(); }}>{t("refreshHistory")}</Button></div>
    {releasesRead.isPending ? <p role="status">{t("loading")}</p> : releases.length === 0 && !releasesRead.error ? <p>{t("noHistory")}</p> : null}
    <ul className={styles.historyList}>{releases.map(record => <li key={record.releaseId}>
      <Button variant="ghost" aria-pressed={chosen?.releaseId === record.releaseId} disabled={!delivery.recordAvailability(delivery.recordPayload(record)).enabled || owner.deliveryDirty && chosen?.releaseId !== record.releaseId}
        onClick={() => { if (canInteract()) { if (commands.dispatch("release.choose-release", commandScope, delivery.recordPayload(record))) { setPrimaryMode("export"); reveal("export"); } } }}>{t("chooseRecord", { date: formatDate(record.createdAt) })}</Button>
      <p>{record.artifacts.map(file => `${file.locale} → ${file.fileName}`).join(" · ")}</p>
      <details><summary>{t("diagnostics")}</summary><p>{t("snapshot")}: <code>{record.sourceSnapshotId}</code></p><p>{t("version")}: {record.builderVersion} · {record.validatorVersion}</p><code>{record.manifestSha256}</code><p>{t("exceptions")}</p>{record.exceptions.length ? <ul>{record.exceptions.map((item, index) => <li key={index}>{item.locale} · {item.nativeKey} · {global(`release.exceptionKind.${item.kind}`)}</li>)}</ul> : <p>{t("noExceptions")}</p>}</details>
    </li>)}</ul>
  </>;
  const exportContent = <>
    {pendingExport ? <Banner tone="warning" role="status"><p>{t("exportUnknown")}</p><div className={styles.actions}>
      <Button variant="secondary" disabled={!delivery.deliveryPendingAvailability(delivery.deliveryPendingPayload()).enabled} onClick={() => { const payload = delivery.deliveryPendingPayload(); if (payload) commands.dispatch("release.check-export", commandScope, payload); }}>{t("checkResult")}</Button>
      <Button variant="secondary" disabled={!delivery.deliveryPendingAvailability(delivery.deliveryPendingPayload()).enabled} onClick={() => { const payload = delivery.deliveryPendingPayload(); if (payload) commands.dispatch("release.reauthorize-destination", commandScope, payload); }}>{t("reauthorize")}</Button>
    </div>{pending.recoverySelection ? <p>{global("release.reauthorizationLimit")}</p> : null}</Banner> : null}
    {owner.exportMissing ? <Banner tone="warning">{global("release.exportMissing")}</Banner> : null}
    {target ? <section aria-label={t("currentOutcome")}>
      {targetRead.isFetching ? <p role="status">{t("loading")}</p> : null}
      {targetRead.error ? <Banner tone="warning"><p>{t("historyFailed")}</p><CommandFailureDetails failure={commandFailure(targetRead.error)}/><Button variant="secondary" disabled={!canInteract()} onClick={() => { if (canInteract()) void targetRead.refetch(); }}>{t("retryOwner")}</Button></Banner> : null}
      {targetRecord ? <><p>{global(`release.deliveryState.${targetRecord.state}`)}</p><ul>{targetRecord.files.map(file => <li key={`${file.locale}:${file.fileName}`}><code>{file.fileName}</code> · {global(`release.deliveryState.${file.state}`)}</li>)}</ul></> : !targetRead.isFetching && !targetRead.error ? <p>{global("workbenchV2.decisionDetailsDeliveryAbsent")}</p> : null}
      {originalWorkKept ? <Banner tone="info">{t("ownerKept")} <Button variant="link" disabled={!canInteract()} onClick={() => reveal("build")}>{t("backToDelivery")}</Button></Banner> : null}
    </section> : null}
    {chosen ? <>
      <h3>{t("chosenRecord")}</h3><ul className={styles.fileList}>{chosen.artifacts.map(file => <li key={`${file.locale}:${file.fileName}`}><code>{file.fileName}</code><span>{file.locale} · {file.entryCount}</span></li>)}</ul>
      <div className={styles.actions}>
        <Button variant="secondary" disabled={!delivery.destinationAvailability(delivery.destinationPayload()).enabled} onClick={() => { const payload = delivery.destinationPayload(); if (payload) commands.dispatch("release.choose-destination", commandScope, payload); }}>{t("chooseFolder")}</Button>
        {selection ? <Button variant="secondary" disabled={!delivery.destinationAvailability(delivery.destinationPayload(), true).enabled} onClick={() => { const payload = delivery.destinationPayload(); if (payload) commands.dispatch("release.preview-destination", commandScope, payload); }}>{t("previewFolder")}</Button> : null}
        {owner.deliveryDirty && !pendingExport ? <Button variant="secondary" disabled={!delivery.recordAvailability(delivery.recordPayload(chosen)).enabled}
          onClick={() => { if (canInteract()) commands.dispatch("release.choose-release", commandScope, delivery.recordPayload(chosen)); }}>{t("clearDestination")}</Button> : null}
      </div>
      {owner.deliveryDirty && !pendingExport ? <p>{t("clearDestinationHelp")}</p> : null}
      {selection ? <p>{t("folder")}: {selection.folderName}</p> : null}
      {preview ? <section aria-label={global("release.previewTitle")}><ul className={styles.fileList}>{preview.files.map(file => <li key={`${file.locale}:${file.fileName}`}><code>{file.fileName}</code><span>{global(`release.fileState.${file.state}`)}</span><details><summary>{t("diagnostics")}</summary><code>{file.expectedSha256}</code></details></li>)}</ul>
        {hasConflict ? <Field label={t("overwrite")} className={styles.consent}><input type="checkbox" checked={overwrite} disabled={!delivery.previewAvailability(delivery.previewPayload()).enabled} onChange={event => { const payload = delivery.previewPayload(event.target.checked); if (payload) commands.dispatch("release.confirm-overwrite", commandScope, payload); }}/></Field> : null}
      </section> : null}
      {result ? <Banner tone={result.state === "succeeded" ? "success" : result.state === "failed" ? "error" : "warning"} role="status">{global(`release.deliveryState.${result.state}`)}</Banner> : null}
      <h3>{t("deliveries")}</h3><Button variant="secondary" disabled={!canInteract() || deliveriesRead.isFetching} onClick={() => { if (canInteract()) void deliveriesRead.refetch(); }}>{t("refreshExport")}</Button>
      {deliveriesRead.isPending ? <p role="status">{t("loading")}</p> : deliveries.length === 0 && !deliveriesRead.error ? <p>{t("noDeliveries")}</p> : deliveries.map(outcome)}
    </> : <p>{t("noRelease")}</p>}
  </>;
  async function openDecision(item: DecisionItem) {
    if (!canInteract() || !inbox?.page || !inbox.current(inbox.page.basis)) return;
    if (!onOpenDecision) { if (item.targets.some(value => value.kind === "resource")) onOpenKnowledge(); else onOpenDecisions(); return; }
    const ticket = ++decisionFlight.current, sessionToken = project.sessionToken;
    setDecisionChanged(false);
    let opened = false;
    try { opened = await onOpenDecision(item); } catch { opened = false; }
    const view = currentView.current;
    if (!opened && ticket === decisionFlight.current && mounted.current && !reads.retired && view.visible && view.sessionToken === sessionToken && view.viewId === viewId && gate.getSnapshot().visibleViewId === viewId) setDecisionChanged(true);
  }
  const projectIssues = inbox ? <section className={styles.issues} aria-label={t("otherIssues")}>
    <h3>{t("otherIssues")}</h3>
    {decisionChanged ? <Banner tone="warning" role="status"><p>{t("decisionChanged")}</p><Button variant="secondary" disabled={!canInteract()} onClick={() => { if (canInteract()) { setDecisionChanged(false); inbox.retry(); } }}>{t("refreshIssues")}</Button></Banner> : null}
    {inbox.loading ? <p role="status">{t("loading")}</p> : null}
    {inbox.failure ? <Banner tone="warning">{t("issueReadFailed")}<Button variant="secondary" disabled={!canInteract()} onClick={() => { if (canInteract()) inbox.retry(); }}>{t("retryOwner")}</Button></Banner> : null}
    {inbox.page ? <><p>{t("issueCount", { count: inbox.page.knownCount })}</p>{inbox.page.total === null ? <p>{t("issuePartial")}</p> : null}
      {inbox.page.deliveryActivity.length ? <Banner tone="info">{t("activeDelivery")}</Banner> : null}
      <ul>{inbox.page.items.map(item => <li key={item.decisionId}>
        <span>{t(item.source === "source-mapping" ? "sourceIssue" : item.source === "resource-proposal" ? "resourceIssue" : item.source === "delivery-unknown" ? "outcomeIssue" : item.source === "execution-unknown" || item.source === "local-action-recovery" ? "executionIssue" : "projectIssue")}</span>
        <Button variant="link" disabled={!canInteract() || !(inbox.page !== undefined && inbox.current(inbox.page.basis))} onClick={() => {
          void openDecision(item);
        }}>{t(item.targets.some(value => value.kind === "resource") ? "openKnowledge" : "openDecisions")}</Button>
      </li>)}</ul></> : null}
    <div className={styles.actions}><Button variant="link" disabled={!canInteract()} onClick={() => { if (canInteract()) onOpenDecisions(); }}>{t("openDecisions")}</Button><Button variant="link" disabled={!canInteract()} onClick={() => { if (canInteract()) onOpenExtensions(); }}>{t("openExtensions")}</Button></div>
  </section> : null;

  function render(parts: BuildWorkbenchParts) {
    const summary: Record<Step, string> = {
      readiness: owner.stale ? t("stale") : owner.eligibility ? owner.eligibility.ready ? t("ready") : t("blocked", { count: owner.eligibility.locales.reduce((sum, locale) => sum + locale.blockerCount, 0) }) : t("notChecked"),
      build: owner.buildReceipt ? t("saved") : parts.status.unknown || parts.status.readFailed ? t("buildUnconfirmed") : parts.status.failed ? t("buildFailed") : parts.status.buildActive ? t("building") : parts.status.outputReceived ? t("built") : owner.prepared ? t("prepared") : t("noBuild"),
      verification: owner.buildReceipt ? t("saved") : parts.status.complete ? t("verified") : parts.status.checkActive ? t("checking") : owner.workflow?.pending || owner.checkReview ? t("verificationUnconfirmed") : parts.status.outputReceived ? t("verificationNeeded") : t("noVerification"),
      export: pendingExport || result?.state === "unknown" || result?.state === "pending" ? t("exportPending") : result?.state === "succeeded" ? t("exported") : result?.state === "failed" || result?.state === "partial" ? t("exportFailed") : hasConflict && !overwrite ? t("exportConflict") : preview ? t("destinationReady") : chosen ? t("exportReady") : t("noRelease"),
      history: releasesRead.error ? t("historyFailed") : releases.length ? t("records", { count: releases.length }) : t("noHistory"),
    };
    const exportPrimary = !!pendingExport || primaryMode === "export" && !!chosen && !owner.pending && !owner.reserved();
    let action = exportPrimary ? { step: "export" as const, label: pendingExport ? t("checkResult") : t("exportAction"), enabled: exportEnabled(), run: dispatchExport } : parts.primary;
    const needsSettings = !owner.languages.length || !owner.buildChoice || owner.choices().some(choice => !choice.outputPaths.length);
    if (!exportPrimary && !owner.prepared && !owner.attempt && !owner.reserved() && needsSettings) action = { step: "build", label: t("check"), enabled: canInteract(), run: () => setSettingsOpen(true) };
    const contents = { readiness: <>{parts.readiness}{projectIssues}</>, build: parts.build, verification: parts.verification, export: exportContent, history: <>{history}{parts.saved}</> };
    return <section className={styles.document} aria-labelledby={`${id}-title`} hidden={!visible}
      onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputOwner); }}>
      <header className={styles.header}><div><h1 id={`${id}-title`}>{t("title")}</h1><p>{t("help")}</p></div>
        <Button variant="primary" disabled={!action?.enabled || !canInteract()} onClick={() => { if (action && canInteract()) { reveal(action.step); action.run(); } }}>{action?.label ?? t("check")}</Button>
      </header>
      {deliveryFailure ? <Banner tone={pendingExport ? "warning" : "error"} role="alert"><p>{global("release.error", { reason: global(deliveryReason) })}</p><CommandFailureDetails failure={deliveryFailure}/></Banner> : null}
      {historyFailure ? <Banner tone="warning" role="alert"><p>{t("historyFailed")}</p><CommandFailureDetails failure={commandFailure(historyFailure)}/><Button variant="secondary" disabled={!canInteract()} onClick={() => { if (canInteract()) { void releasesRead.refetch(); if (chosen) void deliveriesRead.refetch(); } }}>{t("retryOwner")}</Button></Banner> : null}
      {parts.feedback}{parts.recovery}
      <div className={styles.settings}><Button variant="ghost" aria-expanded={settingsOpen} aria-controls={`${id}-settings`} disabled={!canInteract()} onClick={() => { if (canInteract()) { setPrimaryMode("build"); setSettingsOpen(value => !value); } }}>{t("settings")}<ChevronDown aria-hidden="true"/></Button><span>{settings}</span></div>
      <section hidden={!settingsOpen} className={styles.settingsBody} id={`${id}-settings`} aria-label={t("settings")}>{parts.settings}</section>
      <ol className={styles.stepper}>{steps.map((step, index) => <li key={step}>
        <span className={styles.number} aria-hidden="true">{index + 1}</span><div className={styles.stepContent}>
          <div className={styles.stepHeader}><h2><Button variant="ghost" disabled={!canInteract()} aria-expanded={isExpanded(step)} aria-controls={`${id}-${step}`} onClick={() => toggle(step)}>{t(step)}<ChevronDown aria-hidden="true"/></Button></h2><p>{summary[step]}</p></div>
          <section hidden={!isExpanded(step)} id={`${id}-${step}`} className={styles.stepBody} aria-label={t(step)}>{contents[step]}</section>
        </div>
      </li>)}</ol>
    </section>;
  }
  return <PluginBuildControls project={project} open={visible} disabled={disabled} presentation="workbench" canInteract={canInteract} renderWorkbench={render}
    onRecorded={recorded} onOpenExtensions={() => { if (canInteract()) onOpenExtensions(); }}
    openBlocker={onOpenEntry ? (unitId, locale) => { const payload = delivery.blockerPayload(unitId, locale); if (payload) commands.dispatch("release.open-blocker", commandScope, payload); } : undefined}/>;
}

/** Inject the existing Host handles into the original component contexts. */
export default function Delivery(props: DeliveryViewProps) {
  return <ReleaseDraftHandleProvider value={props.owner}><ExecutionTaskHandleProvider value={props.tasks}><WorkbenchCommandsProvider commands={props.commands}>
    <DeliveryView {...props}/>
  </WorkbenchCommandsProvider></ExecutionTaskHandleProvider></ReleaseDraftHandleProvider>;
}
