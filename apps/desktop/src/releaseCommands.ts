import { checkedInvoke } from "./ipc";
import type { SessionRequest, BuildRequest, ReleaseRequest, PreviewRequest, ExportRequest, ReconcileRequest } from "./generated/release.requests";
import * as validators from "./generated/release.validators";

export type { BuildLocaleChoice } from "./generated/release.requests";
export type { ReleaseView, ReleasedArtifact, ReleaseException, ReleaseExceptionKind, BuildSourceFile as ReleaseSourceFile, DeliverySelection, PreviewFile, DeliveryPreview, DeliveryPreviewState, DeliveryFile, DeliveryFileState, DeliveryView, DeliveryState } from "./generated/release.responses";

function requireConfirmation(condition: boolean) {
  if (!condition) throw new Error("Invalid IPC acknowledgement: release action");
}

export const releaseCommands = {
  start: async (request: BuildRequest) => {
    const result = await checkedInvoke("start_locale_build", request, validators.validateResponseIdentity);
    requireConfirmation(result === request.attemptId);
    return result;
  },
  releases: (request: SessionRequest) => checkedInvoke("list_releases", request, validators.validateResponseReleases),
  choose: (request: SessionRequest) => checkedInvoke("choose_delivery_folder", request, validators.validateResponseSelection),
  preview: async (request: PreviewRequest) => {
    const result = await checkedInvoke("preview_delivery", request, validators.validateResponsePreview);
    requireConfirmation(result.releaseId === request.releaseId && result.selectionId === request.selectionId);
    return result;
  },
  export: async (request: ExportRequest) => {
    const result = await checkedInvoke("export_release", request, validators.validateResponseDelivery);
    requireConfirmation(result.actionId === request.actionId && result.releaseId === request.releaseId
      && result.overwriteConflicts === request.overwriteConflicts);
    return result;
  },
  deliveries: async (request: ReleaseRequest) => {
    const result = await checkedInvoke("list_deliveries", request, validators.validateResponseDeliveries);
    requireConfirmation(result.every(delivery => delivery.releaseId === request.releaseId));
    return result;
  },
  reconcile: async (request: ReconcileRequest) => {
    const result = await checkedInvoke("reconcile_delivery", request, validators.validateResponseDelivery);
    requireConfirmation(result.actionId === request.actionId);
    return result;
  },
};
