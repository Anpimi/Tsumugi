import { checkedInvoke } from "./ipc";
import { jsonIdentity } from "./pluginToolChoices";
import type { PluginGenerationComponentView } from "./generated/plugins.responses";
import type {
  WorkPlanGenerationPrepareRequest, WorkPlanGenerationStartRequest, WorkPlanGenerationDiscardRequest,
} from "./generated/ai.requests";
import type { WorkPlanAgentView, WorkPlanGenerationPreflight, WorkPlanToolSpec } from "./generated/ai.responses";
import { contractIdentity } from "./reviewIdentity";
import * as validators from "./generated/ai.validators";
import { validWorkPlanApplicationTools } from "./workPlanApplicationTools";

function invalidAcknowledgement(): never {
  throw Object.assign(new Error("Invalid generation component acknowledgement"), {
    outcome: "unknown", reason: "invalid-generation-component-acknowledgement",
  });
}
const preparations = new WeakMap<WorkPlanGenerationPreflight, WorkPlanGenerationPrepareRequest & { inputDigest: string; taskId: string }>();
const starts = new WeakMap<WorkPlanGenerationPreflight, WorkPlanGenerationStartRequest>();
export function generationSupportsPreparedTools(component: PluginGenerationComponentView) {
  return (component.componentScope === "project" || component.componentScope === "attempt") && component.environment.profile === "node-system-libraries-v1"
    && contractIdentity(component.binding.declaration.inputSchema) === contractIdentity({ id: "tsumugi.generation-component-input", schemaVersion: 1, behaviorVersion: 1 });
}
export function compatiblePreparedTool(tool: WorkPlanToolSpec) {
  return (tool.execution.componentScope === "project" && tool.execution.environment.profile === "node-system-libraries-v1"
      || tool.execution.componentScope === "application") && validWorkPlanApplicationTools([tool])
    && tool.binding.capability.declaration.effect === "read-only" && tool.binding.declaration.query !== null && tool.binding.declaration.query !== undefined;
}

/** Trusted human operations; these are separate from the bounded Agent facade. */
export const workPlanGenerationCommands = {
  prepare: async (input: WorkPlanGenerationPrepareRequest, scope: WorkPlanAgentView, component: PluginGenerationComponentView, tools: readonly WorkPlanToolSpec[] = []) => {
    const request = structuredClone(input), originalScope = structuredClone(scope), installed = structuredClone(component), capturedTools = structuredClone(tools);
    if (!validators.validateRequestWorkPlanGenerationPrepare(request)) throw new Error("Invalid generation component request");
    const ids = request.generation.unitIds, basis = new Map(originalScope.scope.map(unit => [unit.unitId, unit]));
    const identities = new Set([request.attemptId, request.generation.taskId, request.generation.attemptId, originalScope.parentTask]);
    const validToolIdentities = request.toolQueries.every(query => {
      if (query.taskId === query.attemptId || identities.has(query.taskId) || identities.has(query.attemptId)) return false;
      identities.add(query.taskId); identities.add(query.attemptId); return true;
    });
    if (request.scopeId !== originalScope.scopeId || new Set(ids).size !== ids.length || ids.some(id => !basis.has(id))
      || jsonIdentity(request.component.provider) !== jsonIdentity(installed.binding.provider)
      || jsonIdentity(request.component.profile) !== jsonIdentity(installed.profile)
      || request.component.environmentDigest !== installed.environmentDigest) throw new Error("Invalid generation component selection");
    if (request.toolQueries.length > 15 || (request.toolQueries.length > 0 && !generationSupportsPreparedTools(installed))
      || new Set(request.toolQueries.map(query => query.toolHandle)).size !== request.toolQueries.length
      || !validToolIdentities
      || request.toolQueries.some(query => query.unitIds.length !== 1 || !ids.includes(query.unitIds[0])
        || !capturedTools.some(tool => tool.handle === query.toolHandle && compatiblePreparedTool(tool)))) throw new Error("Invalid prepared reference selection");
    const value = await checkedInvoke("prepare_work_plan_generation_component", request, validators.validateResponseWorkPlanGenerationPreflight);
    if (value.scopeId !== request.scopeId || value.parentTask !== originalScope.parentTask || value.attemptId !== request.attemptId
      || value.taskId === value.parentTask || value.taskId === request.generation.taskId
      || request.toolQueries.some(query => query.taskId === value.taskId || query.attemptId === value.taskId)
      || jsonIdentity(value.component) !== jsonIdentity(installed) || jsonIdentity(value.generation) !== jsonIdentity(request.generation)
      || value.scope.length !== ids.length || new Set(value.scope.map(unit => unit.unitId)).size !== ids.length
      || value.scope.some(unit => !ids.includes(unit.unitId) || jsonIdentity(unit) !== jsonIdentity(basis.get(unit.unitId)))
      || value.preparedTools.length !== request.toolQueries.length
      || new Set(value.preparedTools.map(tool => tool.handleId)).size !== value.preparedTools.length
      || new Set(value.preparedTools.map(tool => tool.callId)).size !== value.preparedTools.length
      || value.preparedTools.some((tool, index) => !tool.handleId || tool.callId !== tool.query.attemptId
        || jsonIdentity(tool.query) !== jsonIdentity(request.toolQueries[index])
        || jsonIdentity(tool.tool) !== jsonIdentity(capturedTools.find(candidate => candidate.handle === tool.query.toolHandle))
        || contractIdentity(tool.input.schema) !== contractIdentity(tool.tool.binding.capability.declaration.inputSchema))) invalidAcknowledgement();
    preparations.set(value, { ...request, inputDigest: value.inputDigest, taskId: value.taskId });
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
  startAction: async (prepared: WorkPlanGenerationPreflight) => {
    const original = preparations.get(prepared);
    if (!original) throw new Error("Generation component was not prepared by this session");
    // Scope handles and live human consent are not part of the stored input.
    // The original task and digest bind the complete captured plugin request.
    const request = { projectId: original.projectId, sessionToken: original.sessionToken,
      taskId: original.taskId, attemptId: original.attemptId, inputDigest: original.inputDigest };
    const value = await checkedInvoke("read_work_plan_generation_component_start", request, validators.validateResponseWorkPlanGenerationStartRead);
    if (value !== null && (value.projectId !== request.projectId || value.taskId !== request.taskId
      || value.attemptId !== request.attemptId || value.inputDigest !== request.inputDigest
      || value.operation !== "work-plan-generation-component")) invalidAcknowledgement();
    return value;
  },
  discard: async (input: WorkPlanGenerationDiscardRequest) => {
    const request = structuredClone(input);
    if (!validators.validateRequestWorkPlanGenerationDiscard(request)) throw new Error("Invalid generation component discard request");
    const value = await checkedInvoke("discard_work_plan_generation_component", request, (value: unknown): value is boolean => typeof value === "boolean");
    return value;
  },
};
