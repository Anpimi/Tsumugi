import { checkedInvoke } from "./ipc";
import type { SessionRequest } from "./executionCommands";
import type { SourceMaintenanceHookReadRequest, SourceMaintenanceHookStopRequest, SourceMaintenanceHookActivation, StopSourceMaintenanceHook } from "./generated/source.requests";
import type { SourceMaintenanceHookObservation, SourceMaintenanceHookView } from "./generated/source.responses";
import * as validators from "./generated/source.validators";

export type { SourceMaintenanceHookReadRequest, SourceMaintenanceHookStopRequest, SourceMaintenanceHookActivation, StopSourceMaintenanceHook } from "./generated/source.requests";
export type { SourceMaintenanceHookSession, SourceMaintenanceHookView, SourceMaintenanceHookObservation, SourceMaintenanceHookStopped } from "./generated/source.responses";
function requireConfirmation(condition: boolean): asserts condition {
  if (!condition) throw Object.assign(new Error("Invalid source notification acknowledgement"), { outcome: "unknown", reason: "invalid-source-notification-receipt" });
}
export function sameSourceHookActivation(left: SourceMaintenanceHookActivation, right: SourceMaintenanceHookActivation) {
  return left.policyVersion === right.policyVersion && left.sessionEpoch === right.sessionEpoch && left.locale === right.locale
    && left.after === right.after && left.limit === right.limit && left.expiresAtMs === right.expiresAtMs;
}
export function sameSourceHookStop(left: StopSourceMaintenanceHook, right: StopSourceMaintenanceHook) {
  return left.projectId === right.projectId && left.sourceActionId === right.sourceActionId && left.actionId === right.actionId
    && sameSourceHookActivation(left.activation, right.activation);
}
function sameCause(left: NonNullable<SourceMaintenanceHookView["cause"]>, right: NonNullable<SourceMaintenanceHookView["cause"]>) {
  return left.projectId === right.projectId && left.sourceActionId === right.sourceActionId && left.attemptId === right.attemptId
    && left.resultId === right.resultId && left.resultDigest === right.resultDigest && left.sourceSnapshotId === right.sourceSnapshotId && left.contentRevision === right.contentRevision;
}
export function confirmSourceHookObservation(value: SourceMaintenanceHookObservation, request: SourceMaintenanceHookReadRequest, activation: SourceMaintenanceHookActivation | null) {
  requireConfirmation(value.sourceActionId === request.sourceActionId);
  const { view } = value;
  requireConfirmation(view === null ? value.state === "action-not-known" || value.state === "not-enabled"
    : value.state === "prepared" || value.state === "adopted");
  if (!view) return value;
  requireConfirmation(view.sourceActionId === request.sourceActionId && (activation === null || sameSourceHookActivation(view.activation, activation))
    && (value.state === "prepared" ? view.cause === null : view.cause !== null)
    && view.activation.after === 0 && view.activation.limit === 100
    && view.activation.policyVersion === "source-maintenance-notice-1"
    && Number.isSafeInteger(view.activation.expiresAtMs) && view.activation.expiresAtMs > 0 && view.activation.expiresAtMs <= 8_640_000_000_000_000
    && (view.cause === null || view.cause.projectId === request.projectId && view.cause.sourceActionId === request.sourceActionId)
    && (view.stop === null || view.stop.admissionClosed && view.stop.request.projectId === request.projectId
      && view.stop.request.sourceActionId === request.sourceActionId && sameSourceHookActivation(view.stop.request.activation, view.activation)));
  const outcome = view.outcome, assessment = outcome?.assessment;
  if (outcome) requireConfirmation(view.cause !== null && sameSourceHookActivation(outcome.activation, view.activation)
    && sameCause(outcome.cause, view.cause)
    && (outcome.phase !== "observed" || assessment !== null));
  if (view.phase === "observed") requireConfirmation(outcome?.phase === "observed" && assessment !== null && assessment !== undefined);
  if (assessment) requireConfirmation(view.cause !== null && assessment.projectId === request.projectId
    && assessment.sourceSnapshotId === view.cause.sourceSnapshotId && assessment.locale === view.activation.locale
    && assessment.after === view.activation.after && assessment.limit === view.activation.limit && assessment.rows.length <= assessment.limit
    && new Set(assessment.rows.map(row => row.unitId)).size === assessment.rows.length
    && assessment.rows.every(row => row.protection.unitId === row.unitId && row.protection.locale === assessment.locale));
  return value;
}
export const sourceMaintenanceHookCommands = {
  session: async (request: SessionRequest) => {
    requireConfirmation(validators.validateRequestMaintenanceHookSession(request));
    const value = await checkedInvoke("read_source_maintenance_hook_session", request, validators.validateResponseMaintenanceHookSession);
    requireConfirmation(value.policyVersion === "source-maintenance-notice-1" && value.sessionEpoch.length > 0 && value.windowLimit === 100
      && value.defaultLifetimeMs === 300_000 && value.maxLifetimeMs === 600_000);
    return value;
  },
  read: async (request: SourceMaintenanceHookReadRequest, activation: SourceMaintenanceHookActivation | null = null) => {
    requireConfirmation(validators.validateRequestMaintenanceHook(request));
    return confirmSourceHookObservation(await checkedInvoke("read_source_maintenance_hook", request, validators.validateResponseMaintenanceHook), request, activation);
  },
  stop: async (request: SourceMaintenanceHookStopRequest) => {
    requireConfirmation(validators.validateRequestMaintenanceHookStop(request) && request.projectId === request.stop.projectId);
    const value = await checkedInvoke("stop_source_maintenance_hook", request, validators.validateResponseMaintenanceHookStopped);
    requireConfirmation(sameSourceHookStop(value.request, request.stop));
    if (value.result.kind === "stopped") requireConfirmation(value.result.receipt.admissionClosed && sameSourceHookStop(value.result.receipt.request, request.stop));
    return value;
  },
};
