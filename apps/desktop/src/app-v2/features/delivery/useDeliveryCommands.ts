import { useLayoutEffect, useRef } from "react";
import { executionContext } from "../../../executionCommands";
import { commandFailure } from "../../../CommandFailure";
import { confirmReleaseDelivery, releaseCommands, type ReleaseView, type DeliveryView } from "../../../releaseCommands";
import type { useReleaseDraftSession } from "../../../ReleaseDraftSession";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import type { ProjectView } from "../../../projectCommands";
import type { WorkbenchCommands, CommandAvailability, ReleaseRecordCommandPayload, ReleaseDestinationCommandPayload,
  ReleasePreviewCommandPayload, ReleaseDeliveryPendingCommandPayload, ReleaseDeliveryCommandPayload, ReleaseBlockerCommandPayload } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";

export function useDeliveryCommands({ project, owner, commands: registry, gate: interactions, viewId, visible, disabled, onOpenEntry }: {
  project: ProjectView; owner: ReturnType<typeof useReleaseDraftSession>; commands: WorkbenchCommands; gate: InteractionGate;
  viewId: string; visible: boolean; disabled: boolean; onOpenEntry?: (unitId: string, locale: string) => Promise<boolean>;
}) {
  const session = executionContext(project), reads = useSessionReads(), mounted = useRef(false);
  const currentView = useRef({ visible, disabled, projectId: session.projectId, sessionToken: session.sessionToken });
  currentView.current = { visible, disabled, projectId: session.projectId, sessionToken: session.sessionToken };
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { chosen, selection, preview } = owner;
  const releasesRead = useSessionQuery({ key: ["release-list"], scopes: ["release", "execution"], enabled: visible,
    read: () => releaseCommands.releases(session) });
  const deliveriesRead = useSessionQuery({ key: ["release-deliveries", chosen?.releaseId], scopes: ["release"], enabled: visible && !!chosen,
    read: async () => {
      if (!chosen) throw new Error("No saved build selected");
      const rows = await releaseCommands.deliveries({ ...session, releaseId: chosen.releaseId });
      rows.forEach(row => confirmReleaseDelivery(row, row, chosen.artifacts.map(file => ({ ...file, expectedSha256: file.sha256 }))));
      return rows;
    } });
  const commandScope = { projectId: session.projectId, sessionToken: session.sessionToken, area: "release" as const };
  const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  function gate(recovery = false): CommandAvailability {
    const live = currentView.current;
    if (!mounted.current || !live.visible || reads.retired || live.projectId !== commandScope.projectId || live.sessionToken !== commandScope.sessionToken
      || reads.context.projectId !== commandScope.projectId || reads.context.sessionToken !== commandScope.sessionToken
      || !interactions.canDispatch({ viewId, source: "button" })) return { enabled: false, reason: "hidden" };
    if (live.disabled) return unavailable;
    if (owner.current().busy) return { enabled: false, reason: "busy" };
    if (!recovery && owner.reserved()) return { enabled: false, reason: "pending-action" };
    return { enabled: true };
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
    const allowed=gate();if(!allowed.enabled)return allowed;return payload && releaseRecord(payload) && !(owner.current().deliveryDirty && owner.current().chosen?.releaseId !== payload.releaseId) ? {enabled:true} : unavailable;
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
    return payload && onOpenEntry && value.eligibility && payload.editSeq === value.editSeq && payload.eligibilityBasis === value.eligibility.basis
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
      registry.register({...metadata,id:"release.open-blocker",nameKey:"translation.openEditor",risk:"opens-translation",payloadKind:"release-blocker",availability:blockerAvailability,handler:payload=>{if(blockerAvailability(payload).enabled)void onOpenEntry?.(payload.unitId,payload.locale).catch(error=>{if(gate().enabled)owner.reportFailure(commandFailure(error),"build");});}}),
    ];return()=>remove.forEach(dispose=>dispose());
  });
  return { releasesRead, deliveriesRead, commandScope, gate, recordPayload, recordAvailability,
    destinationPayload, destinationAvailability, previewPayload, previewAvailability, deliveryPendingPayload, deliveryPendingAvailability,
    deliveryPayload, deliveryAvailability, blockerPayload, blockerAvailability };
}
