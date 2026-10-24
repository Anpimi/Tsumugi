import type { BuildRequest } from "./generated/release.requests";
import { checkedInvoke } from "./ipc";
import type { SessionRequest, ReleaseRequest, PreviewRequest, ExportRequest, ReconcileRequest, PluginBuildPrepareRequest, PluginStartRequest, ArtifactCheckPrepareRequest, ArtifactCheckFinishRequest, SavedPluginBuildRequest } from "./generated/release.requests";
import * as validators from "./generated/release.validators";
import type { DeliveryFile, DeliveryPreview, DeliveryView, ReleaseView } from "./generated/release.responses";
import type { ArtifactCheckWorkflowPreparation, ArtifactCheckWorkflowStart, ArtifactCheckWorkflowStepIdentity,
  ArtifactCheckWorkflowPrepareRequest, ArtifactCheckWorkflowStartRequest, ArtifactCheckWorkflowReadRequest,
  ArtifactCheckWorkflowStopRequest } from "./generated/release.requests";
import type { ArtifactCheckWorkflowView, ArtifactCheckWorkflowObservation } from "./generated/release.responses";

export type { PluginBuildRequest } from "./generated/release.requests";
export type { ExportRequest } from "./generated/release.requests";
export type { PluginBuildPrepareRequest, PluginBuildLocaleChoice, PluginStartRequest, ArtifactCheckPrepareRequest, ArtifactCheckFinishRequest } from "./generated/release.requests";
export type { PluginBuildReview, ArtifactCheckReview, CheckedArtifact } from "./generated/release.responses";
export type { SavedPluginBuildView, SavedBuildLocale } from "./generated/release.responses";
export type { ArtifactCheckWorkflowPreparation, ArtifactCheckWorkflowIdentity, ArtifactCheckWorkflowStart,
  ArtifactCheckWorkflowConsent, ArtifactCheckWorkflowStepIdentity, ArtifactCheckWorkflowPrepareRequest,
  ArtifactCheckWorkflowStartRequest, ArtifactCheckWorkflowReadRequest, ArtifactCheckWorkflowStopRequest } from "./generated/release.requests";
export type { ArtifactCheckWorkflowView, ArtifactCheckWorkflowObservation, ArtifactCheckWorkflowSessionView,
  ArtifactCheckWorkflowStopReceipt, ArtifactCheckWorkflowTask, ArtifactCheckWorkflowStepView } from "./generated/release.responses";
export type { ReleaseView, ReleasedArtifact, ReleaseException, ReleaseExceptionKind, BuildSourceFile as ReleaseSourceFile, DeliverySelection, PreviewFile, DeliveryPreview, DeliveryPreviewState, DeliveryFile, DeliveryFileState, DeliveryView, DeliveryState } from "./generated/release.responses";

/** Original Plugin actions remain complete across reconciliation and never acquire a replacement grant. */
export type ReleasePluginIntent =
  | { kind: "prepare-build"; request: PluginBuildPrepareRequest }
  | { kind: "prepare-check"; request: ArtifactCheckPrepareRequest }
  | { kind: "start-build" | "start-check"; request: PluginStartRequest }
  | { kind: "finish-check"; request: ArtifactCheckFinishRequest }
  | { kind: "adopt"; request: import("./executionCommands").PrepareRequest; prepared: boolean };

function requireConfirmation(condition: boolean) {
  if (!condition) throw new Error("Invalid IPC acknowledgement: release action");
}
const digest = (value: string) => /^[0-9a-f]{64}$/.test(value);
function sameWorkflowIdentity(left: ArtifactCheckWorkflowPreparation["identity"], right: ArtifactCheckWorkflowPreparation["identity"]) {
  return left.ownerId === right.ownerId && left.generation === right.generation && left.workflowId === right.workflowId;
}
function sameWorkflowStep(left: ArtifactCheckWorkflowStepIdentity, right: ArtifactCheckWorkflowStepIdentity) {
  return left.locale === right.locale && left.buildItemId === right.buildItemId && left.buildResultId === right.buildResultId
    && left.producerAttemptId === right.producerAttemptId && left.producerInputDigest === right.producerInputDigest
    && left.taskId === right.taskId && left.attemptId === right.attemptId && left.inputDigest === right.inputDigest;
}
function sameWorkflowStart(left: ArtifactCheckWorkflowStart, right: ArtifactCheckWorkflowStart) {
  return sameWorkflowIdentity(left.identity, right.identity) && left.materializationDigest === right.materializationDigest
    && left.consents.length === right.consents.length && left.consents.every((consent, index) => {
      const expected = right.consents[index];
      return sameWorkflowStep(consent.step, expected.step) && consent.grantId === expected.grantId
        && consent.expiresAtMs === expected.expiresAtMs && consent.unsandboxedExecution === expected.unsandboxedExecution;
    });
}
/** Progress and proofs may change; the materialized checker inputs may not. */
export function sameArtifactWorkflowMaterialization(left: ArtifactCheckWorkflowView, right: ArtifactCheckWorkflowView) {
  return left.materializationDigest === right.materializationDigest && left.steps.length === right.steps.length
    && left.steps.every((item, index) => {
      const expected = right.steps[index];
      return item.ordinal === expected.ordinal && sameWorkflowStep(item.step, expected.step)
        && item.buildResultDigest === expected.buildResultDigest && JSON.stringify(item.review) === JSON.stringify(expected.review);
    });
}
function confirmWorkflowPreparation(actual: ArtifactCheckWorkflowPreparation, expected: ArtifactCheckWorkflowPreparation) {
  requireConfirmation(sameWorkflowIdentity(actual.identity, expected.identity) && actual.buildAttemptId === expected.buildAttemptId
    && actual.buildInputDigest === expected.buildInputDigest && actual.build.resourceId === expected.build.resourceId
    && actual.build.environmentDigest === expected.build.environmentDigest
    && actual.build.package.packageDigest === expected.build.package.packageDigest
    && actual.build.package.plugin.publisher === expected.build.package.plugin.publisher
    && actual.build.package.plugin.id === expected.build.package.plugin.id && actual.build.package.plugin.version === expected.build.package.plugin.version
    && actual.buildResults.length === expected.buildResults.length && new Set(actual.buildResults.map(item => item.itemId)).size === actual.buildResults.length
    && actual.buildResults.every(item => expected.buildResults.some(value => value.itemId === item.itemId && value.resultId === item.resultId)));
}
/** Materialized inputs and every later ACK retain the exact original build and consent set. */
export function confirmArtifactWorkflow(view: ArtifactCheckWorkflowView, preparation: ArtifactCheckWorkflowPreparation, start: ArtifactCheckWorkflowStart | null, requireAcceptedStart = false) {
  confirmWorkflowPreparation(view.preparation, preparation);
  requireConfirmation(view.materializationDigest === null || digest(view.materializationDigest));
  requireConfirmation(start === null ? view.start === null : view.start === null ? !requireAcceptedStart : sameWorkflowStart(view.start, start));
  requireConfirmation(new Set(view.steps.map(item => item.step.locale)).size === view.steps.length
    && new Set(view.steps.map(item => item.step.attemptId)).size === view.steps.length
    && new Set(view.steps.map(item => item.step.taskId)).size === view.steps.length
    && new Set(view.steps.map(item => item.step.buildItemId)).size === view.steps.length
    && new Set(view.steps.map(item => item.ordinal)).size === view.steps.length
    && view.steps.every(item => preparation.buildResults.some(expected => expected.itemId === item.step.buildItemId && expected.resultId === item.step.buildResultId)
      && digest(item.step.inputDigest) && digest(item.step.producerInputDigest) && digest(item.buildResultDigest)
      && item.review.attemptId === item.step.attemptId && item.review.inputDigest === item.step.inputDigest
      && item.review.buildAttemptId === item.step.producerAttemptId && item.review.buildResultId === item.step.buildResultId
      && item.review.locale === item.step.locale && matchesBuild(preparation.build, item.review.build)
      && (item.proof === null || item.proof.checkerAttemptId === item.step.attemptId && item.proof.checkerInputDigest === item.step.inputDigest)
      && (item.phase !== "proved" || item.proof?.valid === true)
      && item.selected === !!view.start?.consents.some(consent => sameWorkflowStep(consent.step, item.step))));
  if (view.materializationDigest !== null) requireConfirmation(view.steps.length === preparation.buildResults.length);
  if (start) requireConfirmation(start.materializationDigest === view.materializationDigest
    && start.consents.every(consent => view.steps.some(item => sameWorkflowStep(item.step, consent.step))));
  if (view.phase === "completed") requireConfirmation(!!view.start && view.start.consents.length > 0 && view.steps.some(item => item.selected)
    && view.steps.filter(item => item.selected).every(item => item.phase === "proved" && item.proof?.valid === true));
}
export function confirmArtifactWorkflowObservation(value: ArtifactCheckWorkflowObservation, request: ArtifactCheckWorkflowReadRequest) {
  requireConfirmation(sameWorkflowIdentity(value.identity, request.preparation.identity));
  if (value.view) confirmArtifactWorkflow(value.view, request.preparation, request.start);
  requireConfirmation(value.kind !== "current" || value.view !== null);
  requireConfirmation(value.steps.length === (request.start?.consents.length ?? 0));
  requireConfirmation(new Set(value.steps.map(item => item.step.attemptId)).size === value.steps.length
    && value.steps.every((item, index) => request.preparation.buildResults.some(expected => expected.itemId === item.step.buildItemId && expected.resultId === item.step.buildResultId)
      && request.start !== null && sameWorkflowStep(request.start.consents[index].step, item.step)
      && (item.outcome !== "not-enqueued" || value.admissionClosed)
      && (item.outcome === "enqueued" ? item.execution !== null : item.execution === null && item.resultId === null && item.proof === null)
      && (item.proof === null || item.proof.checkerAttemptId === item.step.attemptId && item.proof.checkerInputDigest === item.step.inputDigest
        && item.proof.checkerResultId === item.resultId)));
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

export type { BuildRequest, BuildLocaleChoice } from "./generated/release.requests";

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
  workflowSession: async (request: SessionRequest) => {
    const result = await checkedInvoke("read_artifact_check_workflow_session", request, validators.validateResponseArtifactWorkflowSession);
    requireConfirmation(result.kind !== "available" || result.current === null || result.current.ownerId === result.ownerId
      && BigInt(result.nextGeneration) > BigInt(result.current.generation));
    return result;
  },
  prepareWorkflow: async (request: ArtifactCheckWorkflowPrepareRequest) => {
    requireConfirmation(validators.validateRequestArtifactWorkflowPrepare(request));
    const result = await checkedInvoke("prepare_artifact_check_workflow", request, validators.validateResponseArtifactWorkflow);
    confirmArtifactWorkflow(result, request.preparation, null); return result;
  },
  startWorkflow: async (request: ArtifactCheckWorkflowStartRequest, preparation: ArtifactCheckWorkflowPreparation) => {
    requireConfirmation(validators.validateRequestArtifactWorkflowStart(request));
    const result = await checkedInvoke("start_artifact_check_workflow", request, validators.validateResponseArtifactWorkflow);
    confirmArtifactWorkflow(result, preparation, request.start, true); return result;
  },
  readWorkflow: async (request: ArtifactCheckWorkflowReadRequest) => {
    requireConfirmation(validators.validateRequestArtifactWorkflowRead(request));
    const result = await checkedInvoke("read_artifact_check_workflow", request, validators.validateResponseArtifactWorkflowObservation);
    confirmArtifactWorkflowObservation(result, request); return result;
  },
  stopWorkflow: async (request: ArtifactCheckWorkflowStopRequest) => {
    requireConfirmation(validators.validateRequestArtifactWorkflowStop(request));
    const result = await checkedInvoke("stop_artifact_check_workflow", request, validators.validateResponseArtifactWorkflowStopped);
    requireConfirmation(sameWorkflowIdentity(result.identity, request.identity) && result.admissionClosed); return result;
  },
  savedBuild: async (request: SavedPluginBuildRequest) => {
    const result = await checkedInvoke("read_saved_plugin_build", request, validators.validateResponseSavedPluginBuild);
    requireConfirmation(result.projectId === request.projectId && result.attemptId === request.attemptId
      && new Set(result.locales.map(locale => locale.choice.locale)).size === result.locales.length
      && new Set(result.locales.map(locale => locale.itemId)).size === result.locales.length
      && new Set(result.locales.flatMap(locale => locale.result ? [locale.result.resultId] : [])).size === result.locales.filter(locale => locale.result).length
      && result.locales.every(locale => locale.status.itemId === locale.itemId && (!locale.result
        || (locale.result.outcome === locale.status.execution && (locale.result.outcome === "succeeded"
          ? locale.result.artifacts.length === locale.choice.outputPaths.length
            && new Set(locale.result.artifacts.map(artifact => artifact.id)).size === locale.result.artifacts.length
            && new Set(locale.result.artifacts.map(artifact => artifact.logicalPath)).size === locale.result.artifacts.length
            && locale.result.artifacts.every(artifact => locale.choice.outputPaths.includes(artifact.logicalPath))
          : locale.result.artifacts.length === 0)))));
    return result;
  },
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
