import { checkedInvoke } from "./ipc";
import type {
  WorkPlanPrepareRequest, WorkPlanAuthorizeRequest, WorkPlanStartRequest,
  WorkPlanControlRequest, WorkPlanStatusRequest, WorkPlanActionRequest,
  WorkProtectionReadRequest, WorkProtectionSetRequest,
} from "./generated/ai.requests";
import * as validators from "./generated/ai.validators";
export type {
  WorkPlanView, WorkPlanReceiptView, WorkPlanStatusView, WorkProtection,
} from "./generated/ai.responses";
export type { PlanOptions, WorkPlanCommand, AutomationEffect } from "./generated/ai.requests";

function invalidAcknowledgement(): never {
  throw Object.assign(new Error("Invalid work-plan acknowledgement"), {
    outcome: "unknown", reason: "invalid-work-plan-acknowledgement",
  });
}

/** Receipts report an action's historical result. Read status for current authority. */
export const workPlanCommands = {
  prepare: async (request: WorkPlanPrepareRequest) => {
    const value = await checkedInvoke("prepare_work_plan", request, validators.validateResponseWorkPlan);
    const units = new Set(request.unitIds);
    const stages = new Map(request.options.stages.map(choice => [choice.stage, choice.mode]));
    if (value.locale !== request.locale || value.scope.length !== units.size
      || new Set(value.scope.map(unit => unit.unitId)).size !== units.size
      || value.scope.some(unit => !units.has(unit.unitId))
      || value.options.selectionPolicy !== request.options.selectionPolicy
      || value.options.adoptResources !== request.options.adoptResources
      || value.options.deliver !== request.options.deliver
      || value.options.stages.length !== stages.size
      || value.options.stages.some(choice => stages.get(choice.stage) !== choice.mode)
      || Boolean(value.preview) !== Boolean(request.config)
      || Boolean(value.preview) !== (typeof value.attemptId === "string")
      || (value.preview && (value.preview.items.length !== value.scope.length
        || value.preview.items.some(item => !value.scope.some(unit =>
          unit.unitId === item.unitId && unit.sourceRevisionId === item.sourceRevisionId
          && unit.sourceSnapshotId === item.sourceSnapshotId && unit.nativeKey === item.nativeKey
          && item.targetLocale === value.locale))))
      || (value.preview && Object.entries(request.config ?? {}).some(([key, expected]) =>
        value.preview!.config[key as keyof typeof value.preview.config] !== expected))) invalidAcknowledgement();
    return value;
  },
  authorize: async (request: WorkPlanAuthorizeRequest) => {
    const value = await checkedInvoke("authorize_work_plan", request, validators.validateResponseWorkPlanReceipt);
    if (value.actionId !== request.actionId || value.lease.planId !== request.planId
      || value.lease.generation !== "1" || value.state !== "active"
      || typeof value.attemptId !== "string" || value.parentTask != null) invalidAcknowledgement();
    return value;
  },
  start: async (request: WorkPlanStartRequest, expectedAttemptId: string) => {
    // The attempt identity is returned by authorization or continuation. The
    // backend resolves it from the action receipt and rechecks current authority.
    const value = await checkedInvoke("start_work_plan", request, validators.validateResponseIdentity);
    if (value !== expectedAttemptId) invalidAcknowledgement();
    return value;
  },
  control: async (request: WorkPlanControlRequest) => {
    const value = await checkedInvoke("control_work_plan", request, validators.validateResponseWorkPlanReceipt);
    const state = { pause: "paused", stop: "stopped", "take-over": "taken-over", continue: "active" }[request.command];
    if (value.actionId !== request.actionId || value.lease.planId !== request.planId
      || value.lease.generation !== (BigInt(request.expectedGeneration) + 1n).toString()
      || value.state !== state || (request.command === "continue") !== (typeof value.attemptId === "string")
      || (request.command !== "continue" && value.parentTask != null)) invalidAcknowledgement();
    return value;
  },
  status: async (request: WorkPlanStatusRequest) => {
    const value = await checkedInvoke("read_work_plan_status", request, validators.validateResponseWorkPlanStatus);
    if (value.plan.planId !== request.planId || value.lease.planId !== request.planId
      || BigInt(value.lease.generation) === 0n) invalidAcknowledgement();
    return value;
  },
  action: async (request: WorkPlanActionRequest) => {
    const value = await checkedInvoke("read_work_plan_action", request, validators.validateResponseWorkPlanAction);
    if (value && value.actionId !== request.actionId) invalidAcknowledgement();
    return value;
  },
  protection: async (request: WorkProtectionReadRequest) => {
    const value = await checkedInvoke("read_work_protection", request, validators.validateResponseWorkProtection);
    if (value.unitId !== request.unitId || value.locale !== request.locale) invalidAcknowledgement();
    return value;
  },
  setProtection: async (request: WorkProtectionSetRequest) => {
    const value = await checkedInvoke("set_work_protection", request, validators.validateResponseWorkProtection);
    if (value.unitId !== request.unitId || value.locale !== request.locale
      || value.protected !== request.protected
      || value.revision !== (BigInt(request.expectedRevision) + 1n).toString()) invalidAcknowledgement();
    return value;
  },
};
