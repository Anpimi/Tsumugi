import { checkedInvoke } from "./ipc";
import type { SessionRequest, BuildRequest, ReleaseRequest, PreviewRequest, ExportRequest, ReconcileRequest } from "./generated/release.requests";
import * as validators from "./generated/release.validators";
import type { DeliveryFile, DeliveryPreview, DeliveryView, ReleaseView } from "./generated/release.responses";

export type { BuildLocaleChoice, BuildRequest, ExportRequest } from "./generated/release.requests";
export type { ReleaseView, ReleasedArtifact, ReleaseException, ReleaseExceptionKind, BuildSourceFile as ReleaseSourceFile, DeliverySelection, PreviewFile, DeliveryPreview, DeliveryPreviewState, DeliveryFile, DeliveryFileState, DeliveryView, DeliveryState } from "./generated/release.responses";

function requireConfirmation(condition: boolean) {
  if (!condition) throw new Error("Invalid IPC acknowledgement: release action");
}

type ExpectedFile = Pick<DeliveryFile, "locale" | "fileName" | "expectedSha256">;
function fileKey(file: { locale: string; fileName: string }) { return JSON.stringify([file.locale, file.fileName]); }
function confirmFiles(files: ExpectedFile[], expected: ExpectedFile[]) {
  const byKey = new Map(expected.map(file => [fileKey(file), file]));
  requireConfirmation(expected.length > 0 && files.length === expected.length && byKey.size === expected.length
    && new Set(files.map(fileKey)).size === files.length && new Set(files.map(file => file.fileName)).size === files.length
    && files.every(file => byKey.get(fileKey(file))?.expectedSha256 === file.expectedSha256));
}
/** Bind all previewed files to the captured immutable release, without deriving new hashes. */
export function confirmReleasePreview(preview: DeliveryPreview, release: ReleaseView, selectionId: string) {
  requireConfirmation(validators.validateResponsePreview(preview) && preview.releaseId === release.releaseId && preview.selectionId === selectionId);
  confirmFiles(preview.files, release.artifacts.map(file => ({ ...file, expectedSha256: file.sha256 })));
  requireConfirmation(preview.files.every(file => file.state === (file.currentSha256 === null ? "absent"
    : file.currentSha256 === file.expectedSha256 ? "same" : "conflict")));
}
/** A typed ACK is still unknown until the whole original action and file set correspond. */
export function confirmReleaseDelivery(delivery: DeliveryView, original: Pick<ExportRequest, "actionId" | "releaseId" | "overwriteConflicts">,
  files: ExpectedFile[], previous: DeliveryView | null = null) {
  requireConfirmation(validators.validateResponseDelivery(delivery) && delivery.actionId === original.actionId
    && delivery.releaseId === original.releaseId && delivery.overwriteConflicts === original.overwriteConflicts);
  confirmFiles(delivery.files, files);
  const succeeded = delivery.files.filter(file => file.state === "succeeded").length;
  const pending = delivery.files.filter(file => file.state === "pending").length;
  const aggregate = pending > 0 ? "pending" : succeeded === delivery.files.length ? "succeeded"
    : delivery.files.some(file => file.state === "unknown") ? "unknown" : succeeded > 0 ? "partial" : "failed";
  requireConfirmation(delivery.state === aggregate && (!pending || pending === delivery.files.length)
    && delivery.files.every(file => file.state === "succeeded" ? file.actualSha256 === file.expectedSha256
      : file.state !== "pending" || file.actualSha256 === null));
  if (previous) {
    requireConfirmation(delivery.deliveryId === previous.deliveryId && delivery.directory === previous.directory
      && delivery.createdAt === previous.createdAt);
    const prior = new Map(previous.files.map(file => [fileKey(file), file]));
    requireConfirmation(delivery.files.every(file => {
      const before = prior.get(fileKey(file));
      return !!before && (before.state === "pending" || before.state === "unknown"
        ? before.state !== "unknown" || (file.state !== "pending" && (file.state !== "failed" || file.actualSha256 === null))
        : file.state === before.state && file.actualSha256 === before.actualSha256);
    }));
  }
}

export const releaseCommands = {
  start: async (request: BuildRequest) => {
    const result = await checkedInvoke("start_locale_build", request, validators.validateResponseIdentity);
    requireConfirmation(result === request.attemptId);
    return result;
  },
  buildAttempt: async (request: BuildRequest) => {
    const result = await checkedInvoke("read_locale_build_attempt", request, validators.validateResponseBuildAttempt);
    requireConfirmation(result === null || (result.projectId === request.projectId && result.attemptId === request.attemptId
      && result.operation === "locale-build" && /^[a-f0-9]{64}$/.test(result.inputDigest)
      && result.expectedEligibilityBasis === request.expectedEligibilityBasis
      && result.choices.length === request.choices.length && result.choices.every((choice, index) =>
        choice.locale === request.choices[index].locale && choice.fileName === request.choices[index].fileName)));
    return result;
  },
  deliveryAction: async (request: ReconcileRequest) => {
    const result = await checkedInvoke("read_delivery_action", request, validators.validateResponseDeliveryAction);
    requireConfirmation(result === null || result.actionId === request.actionId);
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
