import { checkedInvoke } from "./ipc";
import { jsonIdentity } from "./pluginToolChoices";
import type { PluginGenerationComponentView } from "./generated/plugins.responses";
import type {
  WorkPlanGenerationPrepareRequest, WorkPlanGenerationStartRequest, WorkPlanGenerationDiscardRequest,
} from "./generated/ai.requests";
import type { WorkPlanAgentView, WorkPlanGenerationPreflight } from "./generated/ai.responses";
import * as validators from "./generated/ai.validators";

function invalidAcknowledgement(): never {
  throw Object.assign(new Error("Invalid generation component acknowledgement"), {
    outcome: "unknown", reason: "invalid-generation-component-acknowledgement",
  });
}
const preparations = new WeakMap<WorkPlanGenerationPreflight, WorkPlanGenerationPrepareRequest & { inputDigest: string }>();
const starts = new WeakMap<WorkPlanGenerationPreflight, WorkPlanGenerationStartRequest>();

/** Trusted human operations; these are separate from the bounded Agent facade. */
export const workPlanGenerationCommands = {
  prepare: async (input: WorkPlanGenerationPrepareRequest, scope: WorkPlanAgentView, component: PluginGenerationComponentView) => {
    const request = structuredClone(input), originalScope = structuredClone(scope), installed = structuredClone(component);
    if (!validators.validateRequestWorkPlanGenerationPrepare(request)) throw new Error("Invalid generation component request");
    const ids = request.generation.unitIds, basis = new Map(originalScope.scope.map(unit => [unit.unitId, unit]));
    if (request.scopeId !== originalScope.scopeId || new Set(ids).size !== ids.length || ids.some(id => !basis.has(id))
      || jsonIdentity(request.component.provider) !== jsonIdentity(installed.binding.provider)
      || jsonIdentity(request.component.profile) !== jsonIdentity(installed.profile)
      || request.component.environmentDigest !== installed.environmentDigest) throw new Error("Invalid generation component selection");
    const value = await checkedInvoke("prepare_work_plan_generation_component", request, validators.validateResponseWorkPlanGenerationPreflight);
    if (value.scopeId !== request.scopeId || value.parentTask !== originalScope.parentTask || value.attemptId !== request.attemptId
      || jsonIdentity(value.component) !== jsonIdentity(installed) || jsonIdentity(value.generation) !== jsonIdentity(request.generation)
      || value.scope.length !== ids.length || new Set(value.scope.map(unit => unit.unitId)).size !== ids.length
      || value.scope.some(unit => !ids.includes(unit.unitId) || jsonIdentity(unit) !== jsonIdentity(basis.get(unit.unitId)))) invalidAcknowledgement();
    preparations.set(value, { ...request, inputDigest: value.inputDigest });
    return value;
  },
  start: async (prepared: WorkPlanGenerationPreflight, consent: Pick<WorkPlanGenerationStartRequest, "grantId" | "expiresAtMs" | "unsandboxedExecution">) => {
    const original = preparations.get(prepared);
    if (!original) throw new Error("Generation component was not prepared by this session");
    const request: WorkPlanGenerationStartRequest = {
      projectId: original.projectId, sessionToken: original.sessionToken, scopeId: original.scopeId,
      attemptId: original.attemptId, inputDigest: original.inputDigest,
      grantId: consent.grantId, expiresAtMs: consent.expiresAtMs, unsandboxedExecution: consent.unsandboxedExecution,
    };
    if (!validators.validateRequestWorkPlanGenerationStart(request) || !request.unsandboxedExecution) throw new Error("Invalid generation component consent");
    const prior = starts.get(prepared);
    if (prior && jsonIdentity(prior) !== jsonIdentity(request)) throw new Error("Generation component start must retain its original consent");
    // Preserve the exact human decision before awaiting an uncertain write.
    starts.set(prepared, structuredClone(request));
    const value = await checkedInvoke("start_work_plan_generation_component", request, validators.validateResponseIdentity);
    if (value !== original.attemptId) invalidAcknowledgement();
    return value;
  },
  discard: async (input: WorkPlanGenerationDiscardRequest) => {
    const request = structuredClone(input);
    if (!validators.validateRequestWorkPlanGenerationDiscard(request)) throw new Error("Invalid generation component discard request");
    const value = await checkedInvoke("discard_work_plan_generation_component", request, (value: unknown): value is boolean => typeof value === "boolean");
    return value;
  },
};
