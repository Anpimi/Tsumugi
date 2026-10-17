import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "./projectCommands";
import { executionContext } from "./executionCommands";
import { reviewCommands } from "./reviewCommands";
import { confirmReleaseDelivery, releaseCommands, type ReleaseView, type DeliveryView } from "./releaseCommands";
import { useReleaseDraftSession } from "./ReleaseDraftSession";
import { PluginBuildControls } from "./PluginBuildControls";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands, type CommandAvailability,
  type ReleaseRecordCommandPayload, type ReleaseDestinationCommandPayload, type ReleasePreviewCommandPayload,
  type ReleaseDeliveryPendingCommandPayload, type ReleaseDeliveryCommandPayload, type ReleaseBlockerCommandPayload } from "./workbenchCommands";

const errorReasons = {
  "destination-conflict": "release.errorDestination", "dependency-conflict": "release.errorDependency",
  "invalid-input": "release.errorInput", "permission-denied": "release.errorPermission",
  "session-invalid": "release.errorSession", "limit-exceeded": "release.errorLimit", "outcome-unknown": "release.errorOutcomeUnknown",
} as const;
export interface ReleaseHandle { allowLeave: (current?: () => boolean) => Promise<boolean>; allowNavigate: () => Promise<boolean>; showSavedBuild: (attemptId: string) => boolean }
export function ReleaseWorkbench({ project, disabled, ref, onOpenTranslation, onOpenExtensions }: { project: ProjectView; disabled: boolean; ref?: Ref<ReleaseHandle>; onOpenTranslation?: (target: import("./TranslationWorkbench").EditorTarget, locale: string) => Promise<boolean>; onOpenExtensions?: () => void }) {
  const { t } = useTranslation(), session = executionContext(project), owner = useReleaseDraftSession(), reads = useSessionReads(), registry = useWorkbenchCommands();
  const [open, setOpen] = useWorkbenchView("release"), [leaving, setLeaving] = useState(false);
  const { chosen, selection, preview, overwrite, result, pending, busy, checkingDelivery, exportMissing } = owner;
  const leaveProof = useRef<(() => boolean) | null>(null), leaveTrigger = useRef<HTMLElement | null>(null);
  const leaveResolve = useRef<((value: boolean) => void) | null>(null), errorRegion = useRef<HTMLDivElement>(null), mounted = useRef(false), viewVersion = useRef(0);
  const releasesRead = useSessionQuery({ key: ["release-list"], scopes: ["release", "execution"], enabled: open,
    read: () => releaseCommands.releases(session) });
  const deliveriesRead = useSessionQuery({ key: ["release-deliveries", chosen?.releaseId], scopes: ["release"], enabled: open && !!chosen,
    read: async () => {
      const rows = await releaseCommands.deliveries({ ...session, releaseId: chosen!.releaseId });
      rows.forEach(row => confirmReleaseDelivery(row, row, chosen!.artifacts.map(file => ({ ...file, expectedSha256: file.sha256 }))));
      return rows;
    } });
  const releases = releasesRead.data ?? [], deliveries = deliveriesRead.data ?? [], historyError = !!deliveriesRead.error;
  const errorValue = (owner.failureArea === "delivery" ? owner.failure : null) ?? (releasesRead.error ? commandFailure(releasesRead.error, "storage-failed") : null);
  const error = typeof errorValue === "string" ? errorValue : errorValue?.code ?? null;
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; leaveResolve.current?.(false); }; }, []);
  useLayoutEffect(() => { viewVersion.current++; }, [open, project.sessionToken]);
  useEffect(() => { if (error || historyError) { errorRegion.current?.focus(); errorRegion.current?.scrollIntoView({ block: "nearest" }); } }, [error, historyError]);
  function allowLeave(current: () => boolean = () => true): Promise<boolean> {
    leaveProof.current = current;
    viewVersion.current++;
    if (owner.reserved()) { setOpen(true); owner.reportFailure("outcome-unknown",owner.current().workflow || owner.current().pending?.kind === "build" ? "build" : "delivery"); return Promise.resolve(false); }
    const workflow = owner.current().workflow;
    if (workflow && !(workflow.safety?.admissionClosed && workflow.safety.callbacksDrained)) {
      setOpen(true); owner.reportFailure("outcome-unknown", "build"); return Promise.resolve(false);
    }
    if (!owner.current().buildDirty && !owner.current().deliveryDirty && !workflow && !(owner.current().prepared && !owner.current().attempt) && !(owner.current().checkReview && !owner.current().checkAttempt)) return Promise.resolve(true);
    leaveTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true); setLeaving(true);
    return new Promise(resolve => { leaveResolve.current?.(false); leaveResolve.current = resolve; });
  }
  async function settleLeave(value: boolean) {
    if (value && leaveProof.current && !leaveProof.current()) value = false;
    const originalEditSeq = owner.current().editSeq;
    if (value && (owner.current().buildDirty || owner.current().prepared || owner.current().checkReview || owner.current().attempt || owner.current().checkAttempt || owner.current().workflow)) {
      // The checked discard changes its own dirty revision. The owner guards its
      // original input; navigation separately inspects the settled result.
      if (!await owner.discardBuild(true) || owner.current().editSeq !== originalEditSeq) value = false;
    }
    setLeaving(false);
    if (value && !owner.reset()) value = false;
    leaveResolve.current?.(value); leaveResolve.current = null; leaveProof.current = null;
  }
  // Ordinary workspace navigation keeps the project session owner alive.
  useImperativeHandle(ref, () => ({ allowLeave, allowNavigate: () => Promise.resolve(true), showSavedBuild: attemptId => {
    if (disabled || leaving || !mounted.current || !owner.showSavedBuild(attemptId)) return false; setOpen(true); return true;
  } }));
  async function openBlocker(payload: ReleaseBlockerCommandPayload) {
    const ticket = ++viewVersion.current;
    try {
      const key = reads.key(["review-target",payload.unitId,payload.locale]);
      const target = await reads.client.fetchQuery({ queryKey:key,staleTime:0,meta:{scopes:["source","translation","resources","review"]},
        queryFn:()=>reviewCommands.target({...session,unitId:payload.unitId,locale:payload.locale}) });
      if (target.unitId !== payload.unitId || target.locale !== payload.locale) throw new Error("Invalid release blocker target");
      const query = reads.client.getQueryState(key);
      if (ticket === viewVersion.current && blockerAvailability(payload).enabled && query?.status === "success" && query.error === null
        && query.fetchStatus === "idle" && !query.isInvalidated && reads.client.getQueryData(key) === target
        && target.unitId === payload.unitId && target.locale === payload.locale) {
        await onOpenTranslation?.({ unitId: target.unitId, sourceRevisionId: target.sourceRevisionId, key: target.nativeKey, sourceText: target.sourceText }, payload.locale);
      }
    } catch (failure) { if (mounted.current && ticket === viewVersion.current) owner.reportFailure(commandFailure(failure, "storage-failed")); }
  }
  const hasConflict = preview?.files.some(file => file.state === "conflict") ?? false;
  const commandScope = {projectId:project.metadata.projectId,sessionToken:project.sessionToken,area:"release" as const};
  const unavailable: CommandAvailability = {enabled:false,reason:"unavailable"};
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  function gate(recovery = false): CommandAvailability {
    if (!open || leaving || !mounted.current || reads.retired || reads.context.projectId !== commandScope.projectId || reads.context.sessionToken !== commandScope.sessionToken) return {enabled:false,reason:"hidden"};
    if (owner.current().busy) return {enabled:false,reason:"busy"};
    if (disabled) return unavailable;
    if (!recovery && owner.reserved()) return {enabled:false,reason:"pending-action"};
    return {enabled:true};
  }
  function recordPayload(record: ReleaseView): ReleaseRecordCommandPayload {
    return {kind:"release-record",releaseId:record.releaseId,releaseActionId:record.actionId,attemptId:record.attemptId,manifestSha256:record.manifestSha256};
  }
  function sameRecord(payload: ReleaseRecordCommandPayload | ReleaseDestinationCommandPayload | ReleasePreviewCommandPayload | ReleaseDeliveryCommandPayload, record: ReleaseView) {
    return payload.releaseId === record.releaseId && payload.releaseActionId === record.actionId && payload.attemptId === record.attemptId && payload.manifestSha256 === record.manifestSha256;
  }
  function checkedHistory<T>(key: readonly unknown[]): T | undefined {
    const query=reads.client.getQueryState(reads.key(key));return query && query.dataUpdateCount > 0 ? reads.client.getQueryData<T>(reads.key(key)) : undefined;
  }
  function releaseRecord(payload: ReleaseRecordCommandPayload) { return checkedHistory<ReleaseView[]>(["release-list"])?.find(record=>sameRecord(payload,record)); }
  function recordAvailability(payload?: ReleaseRecordCommandPayload): CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;return payload && releaseRecord(payload) ? {enabled:true} : unavailable;
  }
  function destinationPayload(): ReleaseDestinationCommandPayload | undefined {
    const value=owner.current();return value.chosen ? {...recordPayload(value.chosen),kind:"release-destination",selectionId:value.selection?.selectionId ?? null} : undefined;
  }
  function destinationAvailability(payload?: ReleaseDestinationCommandPayload, previewing=false): CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;const value=owner.current();
    return payload && value.chosen && sameRecord(payload,value.chosen) && payload.selectionId === (value.selection?.selectionId ?? null)
      && (!previewing || !!value.selection) ? {enabled:true} : unavailable;
  }
  function previewPayload(overwrite = owner.current().overwrite): ReleasePreviewCommandPayload | undefined {
    const value=owner.current();return value.chosen && value.selection && value.preview ? {...recordPayload(value.chosen),kind:"release-preview",
      selectionId:value.selection.selectionId,previewId:value.preview.previewId,overwrite} : undefined;
  }
  function previewAvailability(payload?: ReleasePreviewCommandPayload, exporting=false): CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;const value=owner.current();
    return payload && value.chosen && value.preview && value.selection && sameRecord(payload,value.chosen) && payload.selectionId === value.selection.selectionId
      && payload.previewId === value.preview.previewId && (!exporting || payload.overwrite === value.overwrite
        && (!value.preview.files.some(file=>file.state === "conflict") || value.overwrite)) ? {enabled:true} : unavailable;
  }
  function deliveryPendingPayload(): ReleaseDeliveryPendingCommandPayload | undefined {
    const value=owner.current().pending;if(!value || value.kind === "build")return undefined;
    return {kind:"release-delivery-pending",pendingKind:value.kind,actionId:value.request.actionId,releaseId:value.kind === "export" ? value.request.releaseId : value.receipt.releaseId,
      selectionId:value.selection.selectionId,previewId:value.kind === "export" ? value.request.previewId : null,
      overwriteConflicts:value.kind === "export" ? value.request.overwriteConflicts : value.receipt.overwriteConflicts,
      recoverySelectionId:value.recoverySelection?.selectionId ?? null,delivery:value.receipt ? structuredClone(value.receipt) : null};
  }
  function deliveryPendingAvailability(payload?: ReleaseDeliveryPendingCommandPayload): CommandAvailability {
    const allowed=gate(true);if(!allowed.enabled)return allowed;const actual=deliveryPendingPayload();
    return payload && actual && payload.pendingKind === actual.pendingKind && payload.actionId === actual.actionId && payload.releaseId === actual.releaseId
      && payload.selectionId === actual.selectionId && payload.previewId === actual.previewId && payload.overwriteConflicts === actual.overwriteConflicts
      && payload.recoverySelectionId === actual.recoverySelectionId && same(payload.delivery,actual.delivery) ? {enabled:true} : unavailable;
  }
  function deliveryPayload(delivery: DeliveryView): ReleaseDeliveryCommandPayload | undefined {
    const value=owner.current();return value.chosen && value.selection ? {...recordPayload(value.chosen),kind:"release-delivery",selectionId:value.selection.selectionId,delivery:structuredClone(delivery)} : undefined;
  }
  function deliveryRecord(payload: ReleaseDeliveryCommandPayload) {
    const value=owner.current(), candidates=[...(checkedHistory<DeliveryView[]>(["release-deliveries",value.chosen?.releaseId]) ?? []),...(value.result ? [value.result] : [])];
    return candidates.find(record=>same(record,payload.delivery));
  }
  function deliveryAvailability(payload?: ReleaseDeliveryCommandPayload): CommandAvailability {
    const allowed=gate(true);if(!allowed.enabled)return allowed;const value=owner.current(), pending=value.pending;
    return payload && value.chosen && value.selection && sameRecord(payload,value.chosen) && payload.selectionId === value.selection.selectionId
      && payload.delivery.releaseId === value.chosen.releaseId && ["pending","unknown"].includes(payload.delivery.state) && deliveryRecord(payload)
      && (!pending || pending.kind !== "build" && pending.request.actionId === payload.delivery.actionId) ? {enabled:true} : unavailable;
  }
  function blockerPayload(unitId: string, locale: string): ReleaseBlockerCommandPayload | undefined {
    const value=owner.current();return value.eligibility ? {kind:"release-blocker",editSeq:value.editSeq,eligibilityBasis:value.eligibility.basis,
      sourceSnapshotId:value.eligibility.sourceSnapshotId,unitId,locale} : undefined;
  }
  function blockerAvailability(payload?: ReleaseBlockerCommandPayload): CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;const value=owner.current();
    return payload && onOpenTranslation && value.eligibility && payload.editSeq === value.editSeq && payload.eligibilityBasis === value.eligibility.basis
      && payload.sourceSnapshotId === value.eligibility.sourceSnapshotId && project.metadata.targetLocales.includes(payload.locale)
      && value.eligibility.locales.some(locale=>locale.locale === payload.locale && locale.blockers.some(reason=>reason.unitId === payload.unitId)) ? {enabled:true} : unavailable;
  }
  useLayoutEffect(()=>{
    const metadata={category:"release" as const,scope:commandScope,binding:null,confirmation:"none" as const};
    const remove=[
      registry.register({...metadata,id:"release.choose-release",nameKey:"release.selected",risk:"opens-release",payloadKind:"release-record",availability:recordAvailability,handler:payload=>{const record=releaseRecord(payload);if(record)owner.chooseRelease(record);}}),
      registry.register({...metadata,id:"release.choose-destination",nameKey:"release.chooseFolder",risk:"captures-release",payloadKind:"release-destination",availability:payload=>destinationAvailability(payload),handler:()=>{void owner.chooseFolder();}}),
      registry.register({...metadata,id:"release.preview-destination",nameKey:"release.preview",risk:"captures-release",payloadKind:"release-destination",availability:payload=>destinationAvailability(payload,true),handler:()=>{void owner.previewFolder();}}),
      registry.register({...metadata,id:"release.confirm-overwrite",nameKey:"release.overwrite",risk:"captures-release",payloadKind:"release-preview",availability:payload=>previewAvailability(payload),handler:payload=>owner.setOverwrite(payload.overwrite)}),
      registry.register({...metadata,id:"release.export",nameKey:"release.export",risk:"exports-release",confirmation:"required",payloadKind:"release-preview",availability:payload=>previewAvailability(payload,true),handler:()=>{void owner.exportFiles();}}),
      registry.register({...metadata,id:"release.check-export",nameKey:"release.checkExport",risk:"reconciles-release",payloadKind:"release-delivery-pending",availability:deliveryPendingAvailability,handler:()=>{void owner.checkExport();}}),
      registry.register({...metadata,id:"release.reauthorize-destination",nameKey:"release.reauthorizeFolder",risk:"captures-release",payloadKind:"release-delivery-pending",availability:deliveryPendingAvailability,handler:()=>{void owner.chooseFolder(true);}}),
      registry.register({...metadata,id:"release.reconcile-delivery",nameKey:"release.checkPending",risk:"reconciles-release",payloadKind:"release-delivery",availability:deliveryAvailability,handler:payload=>{const record=deliveryRecord(payload);if(record)void owner.reconcile(record);}}),
      registry.register({...metadata,id:"release.open-blocker",nameKey:"translation.openEditor",risk:"opens-translation",payloadKind:"release-blocker",availability:blockerAvailability,handler:payload=>{void openBlocker(payload);}}),
    ];return()=>remove.forEach(dispose=>dispose());
  });
  return <><WorkbenchPanel open={open} title={t("release.title")} description={t("release.description")} className="source-dialog release-dialog" onBack={() => setOpen(false)} backDisabled={disabled}>
      <div className="execution-content" aria-busy={busy}>
        {error || historyError ? <div className="release-alert" role="alert" ref={errorRegion} tabIndex={-1}>
          {error ? <p>{t("release.error", { reason: t(errorReasons[error as keyof typeof errorReasons] ?? "release.errorUnknown") })}</p> : null}
          <CommandFailureDetails failure={errorValue} />
          {releasesRead.isError ? <button disabled={disabled || releasesRead.isFetching} onClick={() => void releasesRead.refetch()}>{t("release.retryReads")}</button> : null}
          {historyError ? <><p>{t("release.historyFailed")}</p>{chosen ? <button disabled={disabled || deliveriesRead.isFetching} onClick={() => void deliveriesRead.refetch()}>{t("release.refreshDeliveries")}</button> : null}</> : null}
        </div> : null}
        {pending && pending.kind !== "build" ? <section role="status"><p>{t(checkingDelivery ? "release.checkingDelivery" : "release.exportUnknown")}</p><button disabled={!deliveryPendingAvailability(deliveryPendingPayload()).enabled} onClick={() => {const payload=deliveryPendingPayload();if(payload)registry.dispatch("release.check-export",commandScope,payload);}}>{t("release.checkExport")}</button><button disabled={!deliveryPendingAvailability(deliveryPendingPayload()).enabled} onClick={() => {const payload=deliveryPendingPayload();if(payload)registry.dispatch("release.reauthorize-destination",commandScope,payload);}}>{t("release.reauthorizeFolder")}</button>{pending.recoverySelection ? <p>{t("release.reauthorizationLimit")}</p> : null}</section> : null}
        {exportMissing ? <p role="status">{t("release.exportMissing")}</p> : null}
        <PluginBuildControls project={project} open={open} disabled={disabled} leaving={leaving} onOpenExtensions={onOpenExtensions} onRecorded={async actionId => {
          const response = await releasesRead.refetch();
          if (!mounted.current || reads.retired || response.error || owner.current().buildReceipt?.actionId !== actionId) return;
          const record = response.data?.find(item => item.actionId === actionId && item.attemptId === owner.current().buildReceipt?.attemptId);
          const current = owner.current();
          if (record && !current.chosen && !current.selection && !current.preview && !current.result && !current.deliveryDirty) owner.chooseRelease(record);
        }} openBlocker={onOpenTranslation ? (unitId, locale) => { const payload = blockerPayload(unitId,locale); if (payload) registry.dispatch("release.open-blocker",commandScope,payload); } : undefined}/>
        <section><div className="execution-actions"><h3>{t("release.history")}</h3><button className="secondary-button" disabled={disabled || releasesRead.isFetching} onClick={() => void releasesRead.refetch()}>{t("release.refresh")}</button></div>
          {releasesRead.isPending ? <p>{t("release.loading")}</p> : releases.length === 0 ? releasesRead.isError ? null : <p>{t("release.empty")}</p> : <ul>{releases.map(item => <li key={item.releaseId}><button className="text-button" disabled={!recordAvailability(recordPayload(item)).enabled} onClick={() => registry.dispatch("release.choose-release",commandScope,recordPayload(item))}>{item.createdAt} · {item.artifacts.map(file => file.locale).join(", ")}</button></li>)}</ul>}
          {chosen ? <div><h4>{t("release.selected")}</h4><p>{t("release.source", { id: chosen.sourceSnapshotId })} · {chosen.policyVersion}</p><ul>{chosen.artifacts.map(file => <li key={`${file.locale}:${file.fileName}`}>{file.locale} → {file.fileName} · {file.entryCount} · <code>{file.sha256}</code></li>)}</ul>
            <details><summary>{t("release.evidence")}</summary>
              <p>{t("release.manifestDigest", { digest: chosen.manifestSha256 })}</p>
              <p>{t("release.toolVersions", { builder: chosen.builderVersion, validator: chosen.validatorVersion })}</p>
              <p>{t("release.eligibilityBasis", { basis: chosen.eligibilityBasis })}</p>
              <ul>{chosen.sourceFiles.map(file => <li key={file.logicalPath}>{file.logicalPath} · <code>{file.sha256}</code></li>)}</ul>
              <h5>{t("release.exceptions")}</h5>{chosen.exceptions.length === 0 ? <p>{t("release.noExceptions")}</p> : <ul>{chosen.exceptions.map((item, index) => <li key={`${item.locale}:${item.nativeKey}:${index}`}>{item.locale} · {item.nativeKey} · {t(`release.exceptionKind.${item.kind}`)}</li>)}</ul>}
            </details>
            <div className="form-actions"><button className="secondary-button" disabled={!destinationAvailability(destinationPayload()).enabled} onClick={() => {const payload=destinationPayload();if(payload)registry.dispatch("release.choose-destination",commandScope,payload);}}>{t("release.chooseFolder")}</button>{selection ? <button className="secondary-button" disabled={!destinationAvailability(destinationPayload(),true).enabled} onClick={() => {const payload=destinationPayload();if(payload)registry.dispatch("release.preview-destination",commandScope,payload);}}>{t("release.preview")}</button> : null}</div>
            {selection ? <p>{t("release.savedDestination", { name: selection.folderName })}</p> : null}
            {preview ? <div><h4>{t("release.previewTitle")}</h4><p>{t("release.savedDestination", { name: preview.folderName })}</p><ul>{preview.files.map(file => <li key={`${file.locale}:${file.fileName}`}>{file.fileName} · {t(`release.fileState.${file.state}`)} · <code>{file.expectedSha256}</code></li>)}</ul>
              {hasConflict ? <label><input type="checkbox" checked={overwrite} disabled={!previewAvailability(previewPayload()).enabled} onChange={event => {const payload=previewPayload(event.target.checked);if(payload)registry.dispatch("release.confirm-overwrite",commandScope,payload);}} />{t("release.overwrite")}</label> : null}
              <div className="form-actions"><button className="primary-button" disabled={!previewAvailability(previewPayload(),true).enabled} onClick={() => {const payload=previewPayload();if(payload)registry.dispatch("release.export",commandScope,payload);}}>{t("release.export")}</button></div></div> : null}
            {result ? <div role="status"><p>{t(`release.deliveryState.${result.state}`)}</p>{(result.state === "pending" || result.state === "unknown") && selection ? <button disabled={!deliveryAvailability(deliveryPayload(result)).enabled} onClick={() => {const payload=deliveryPayload(result);if(payload)registry.dispatch("release.reconcile-delivery",commandScope,payload);}}>{t("release.checkPending")}</button> : null}</div> : null}
            <h4>{t("release.deliveries")}</h4>{deliveriesRead.isPending ? <p>{t("release.loading")}</p> : deliveries.length === 0 ? historyError ? null : <p>{t("release.noDeliveries")}</p> : <ul>{deliveries.map(delivery => <li key={delivery.deliveryId}>{delivery.createdAt} · {t(`release.deliveryState.${delivery.state}`)} · {delivery.directory} · {t(delivery.overwriteConflicts ? "release.overwriteAllowed" : "release.overwriteNotAllowed")}{(delivery.state === "pending" || delivery.state === "unknown") && selection && delivery.actionId !== result?.actionId ? <button className="secondary-button" disabled={!deliveryAvailability(deliveryPayload(delivery)).enabled} onClick={() => {const payload=deliveryPayload(delivery);if(payload)registry.dispatch("release.reconcile-delivery",commandScope,payload);}}>{t("release.checkPending")}</button> : null}<ul>{delivery.files.map(file => <li key={`${file.locale}:${file.fileName}`}>{file.fileName}: {t(`release.deliveryState.${file.state}`)}{file.actualSha256 ? <> · <code>{file.actualSha256}</code></> : null}</li>)}</ul></li>)}</ul>}
          </div> : null}
        </section>
      </div>
    </WorkbenchPanel>
    <Dialog.Root open={leaving} onOpenChange={next => { if (!next && !busy) void settleLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop"/><Dialog.Content className="confirm-dialog execution-confirm-dialog" onPointerDownOutside={event=>event.preventDefault()} onEscapeKeyDown={event=>{if(busy)event.preventDefault();}} onCloseAutoFocus={event=>{if(leaveTrigger.current?.isConnected){event.preventDefault();leaveTrigger.current.focus();}}}><Dialog.Title>{t("release.unsaved")}</Dialog.Title><Dialog.Description>{t("release.unsavedHelp")}</Dialog.Description><button disabled={busy} onClick={() => void settleLeave(false)}>{t(owner.buildDirty || owner.prepared ? "source.keep" : "release.stay")}</button><button disabled={busy} onClick={() => void settleLeave(true)}>{t(owner.buildDirty || owner.prepared ? "source.leave" : "release.discard")}</button></Dialog.Content></Dialog.Portal></Dialog.Root></>;
}
