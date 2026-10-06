import { checkedInvoke } from "./ipc";
import type { SessionRequest, ReleaseRequest, PreviewRequest, ExportRequest, ReconcileRequest, PluginBuildPrepareRequest, PluginStartRequest, ArtifactCheckPrepareRequest, ArtifactCheckFinishRequest } from "./generated/release.requests";
import * as validators from "./generated/release.validators";

export type { ExportRequest } from "./generated/release.requests";
export type { PluginBuildPrepareRequest, PluginBuildLocaleChoice, PluginStartRequest, ArtifactCheckPrepareRequest, ArtifactCheckFinishRequest } from "./generated/release.requests";
export type { PluginBuildReview, ArtifactCheckReview, CheckedArtifact } from "./generated/release.responses";
export type { ReleaseView, ReleasedArtifact, ReleaseException, ReleaseExceptionKind, BuildSourceFile as ReleaseSourceFile, DeliverySelection, PreviewFile, DeliveryPreview, DeliveryPreviewState, DeliveryFile, DeliveryFileState, DeliveryView, DeliveryState } from "./generated/release.responses";

function requireConfirmation(condition: boolean) {
  if (!condition) throw new Error("Invalid IPC acknowledgement: release action");
}

export const releaseCommands = {
  preparePlugin: async (request: PluginBuildPrepareRequest) => {
    const result = await checkedInvoke("prepare_plugin_build", request, validators.validateResponsePluginBuild);
    requireConfirmation(result.attemptId === request.attemptId && result.eligibilityBasis === request.expectedEligibilityBasis
      && matchesBuild(request.build, result.build) && result.choices.length === request.choices.length
      && result.choices.every((choice, i) => {
        const submitted = request.choices[i];
        return choice.locale === submitted.locale
          && choice.outputPaths.length === submitted.outputPaths.length
          && choice.outputPaths.every((path, j) => path === submitted.outputPaths[j])
          && choice.configuration.length === submitted.configuration.length
          && choice.configuration.every((payload, j) => {
            const fixed = submitted.configuration[j];
            return payload.utf8 === fixed.utf8 && payload.sha256 === fixed.sha256
              && payload.schema.id === fixed.schema.id && payload.schema.schemaVersion === fixed.schema.schemaVersion
              && payload.schema.behaviorVersion === fixed.schema.behaviorVersion;
          });
      }));
    return result;
  },
  startPlugin: async (request: PluginStartRequest) => {
    const result = await checkedInvoke("start_plugin_build", request, validators.validateResponseIdentity);
    requireConfirmation(result === request.attemptId);
    return result;
  },
  prepareCheck: async (request: ArtifactCheckPrepareRequest) => {
    const result = await checkedInvoke("prepare_artifact_check", request, validators.validateResponseArtifactCheck);
    requireConfirmation(result.attemptId === request.attemptId && result.buildAttemptId === request.buildAttemptId
      && result.buildResultId === request.buildResultId && matchesBuild(request.build, result.build));
    return result;
  },
  startCheck: async (request: PluginStartRequest) => {
    const result = await checkedInvoke("start_artifact_check", request, validators.validateResponseIdentity);
    requireConfirmation(result === request.attemptId);
    return result;
  },
  finishCheck: (request: ArtifactCheckFinishRequest) => checkedInvoke("finish_artifact_check", request, validators.validateResponseFinishArtifactCheck),
  cancelPluginPreparation: (request: SessionRequest) => checkedInvoke("cancel_plugin_build_preparation", request, validators.validateResponseCancelPluginBuild),
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

function matchesBuild(request: PluginBuildPrepareRequest["build"], view: import("./generated/release.responses").PluginBuildView) {
  return request.resourceId === view.resourceId && request.environmentDigest === view.environmentDigest
    && [view.builder.provider, view.checker.provider].every(provider =>
      provider.packageDigest === request.package.packageDigest && provider.plugin.publisher === request.package.plugin.publisher
      && provider.plugin.id === request.package.plugin.id && provider.plugin.version === request.package.plugin.version);
}
