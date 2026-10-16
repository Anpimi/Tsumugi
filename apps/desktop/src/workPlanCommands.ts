import { checkedInvoke } from "./ipc";
import { sameAiConfig } from "./aiCommands";
import type {
  WorkPlanPrepareRequest, WorkPlanAuthorizeRequest, WorkPlanStartRequest,
  WorkPlanControlRequest, WorkPlanStatusRequest, WorkPlanActionRequest,
  WorkProtectionReadRequest, WorkProtectionSetRequest,
  WorkPlanAgentOpenRequest, WorkPlanAgentStartRequest, WorkPlanAgentToolStartRequest,
  WorkPlanAgentToolAttemptRequest, WorkPlanAgentToolOutputRequest,
  MaintenanceAssessmentRequest,
} from "./generated/ai.requests";
import type { AttemptDetail, ExecutionOutputView, WorkPlanAgentView, WorkPlanAgentGenerationView, WorkPlanAgentToolView, WorkPlanToolSpec, PlanSelectionBasis } from "./generated/ai.responses";
import * as validators from "./generated/ai.validators";
import type { PluginToolView } from "./pluginCommands";
import { jsonIdentity } from "./pluginToolChoices";
import { checkerIdentity, contractIdentity } from "./reviewIdentity";
export type {
  WorkPlanView, WorkPlanReceiptView, WorkPlanStatusView, WorkProtection,
  MaintenanceAssessment, MaintenanceAction, MaintenanceChoice, MaintenancePlanBasis,
} from "./generated/ai.responses";
export type { PlanOptions, WorkPlanCommand, AutomationEffect } from "./generated/ai.requests";

function invalidAcknowledgement(): never {
  throw Object.assign(new Error("Invalid work-plan acknowledgement"), {
    outcome: "unknown", reason: "invalid-work-plan-acknowledgement",
  });
}

/** Receipts report an action's historical result. Read status for current authority. */
export const workPlanCommands = {
  maintenance: (request: MaintenanceAssessmentRequest) => checkedInvoke("read_maintenance_assessment", request,
    (value): value is import("./generated/ai.responses").MaintenanceAssessment => validators.validateResponseMaintenanceAssessment(value)
      && value.projectId===request.projectId && value.sourceSnapshotId===request.snapshotId && value.locale===request.locale
      && value.after===request.after && value.limit===request.limit),
  prepare: async (input: WorkPlanPrepareRequest, expectedTools: readonly PluginToolView[] = []) => {
    const request = structuredClone(input), tools = structuredClone(expectedTools);
    const value = await checkedInvoke("prepare_work_plan", request, validators.validateResponseWorkPlan);
    const units = new Set(request.unitIds);
    const stages = new Map(request.options.stages.map(choice => [choice.stage, choice.mode]));
    if (jsonIdentity(value.maintenance)!==jsonIdentity(request.maintenance)
      || value.locale !== request.locale || value.scope.length !== units.size
      || new Set(value.scope.map(unit => unit.unitId)).size !== units.size
      || value.scope.some(unit => !units.has(unit.unitId))
      || value.options.selectionPolicy !== request.options.selectionPolicy
      || value.options.adoptResources !== request.options.adoptResources
      || value.options.deliver !== request.options.deliver
      || value.options.stages.length !== stages.size
      || value.options.stages.some(choice => stages.get(choice.stage) !== choice.mode)
      || value.options.advisoryChecks.length !== request.advisoryChecks.length
      || Boolean(value.preview) !== Boolean(request.config)
      || Boolean(value.preview) !== (typeof value.attemptId === "string")
      || (value.preview && (value.preview.items.length !== value.scope.length
        || value.preview.items.some(item => !value.scope.some(unit =>
          unit.unitId === item.unitId && unit.sourceRevisionId === item.sourceRevisionId
          && unit.sourceSnapshotId === item.sourceSnapshotId && unit.nativeKey === item.nativeKey
          && item.targetLocale === value.locale))))
      || (value.preview && (!request.config || !sameAiConfig(value.preview.config, request.config)))) invalidAcknowledgement();
    const selection = request.toolSelection;
    if (Boolean(value.tools) !== Boolean(selection)) invalidAcknowledgement();
    if (selection) {
      if (!value.tools || value.tools.maxInvocations !== selection.maxInvocations
        || value.tools.entries.length !== selection.entries.length || tools.length !== selection.entries.length
        || new Set(value.tools.entries.map(tool => tool.handle)).size !== selection.entries.length
        || value.tools.entries.some(tool => {
          const index = selection.entries.findIndex(entry => entry.handle === tool.handle);
          const entry = selection.entries[index], expected = tools[index];
          return !entry || !expected || tool.resourceId !== entry.tool.resourceId
            || tool.target !== entry.target || jsonIdentity(tool.selections) !== jsonIdentity(entry.selections)
            || expected.environmentDigest !== entry.tool.environmentDigest
            || expected.binding.capability.provider.packageDigest !== entry.tool.package.packageDigest
            || jsonIdentity(expected.binding.capability.provider.plugin) !== jsonIdentity(entry.tool.package.plugin)
            || jsonIdentity(tool.binding) !== jsonIdentity(expected.binding)
            || jsonIdentity(tool.execution) !== jsonIdentity({ capability: expected.binding.capability,
              componentScope: expected.componentScope, applicationScope: null, profile: expected.binding.declaration.profile,
              environment: expected.environment })
            || tool.settingsRevision !== expected.settingsRevision
            || jsonIdentity(tool.packageOrigin) !== jsonIdentity(expected.packageOrigin)
            || jsonIdentity(tool.runtimeOrigin) !== jsonIdentity(expected.runtimeOrigin);
        })) invalidAcknowledgement();
    }
    value.options.advisoryChecks.forEach((captured, index) => {
      const requested = request.advisoryChecks[index];
      const provider = captured.binding.checker.provider;
      if (captured.declarationResourceId !== requested.resourceId || provider.packageDigest !== requested.package.packageDigest
        || provider.plugin.publisher !== requested.package.plugin.publisher || provider.plugin.id !== requested.package.plugin.id
        || provider.plugin.version !== requested.package.plugin.version
        || JSON.stringify(captured.rules.map(contractIdentity)) !== JSON.stringify(requested.rules.map(contractIdentity))) invalidAcknowledgement();
      const checker = value.checkers.find(checker => checkerIdentity(checker.checker)
        === checkerIdentity({ provider, profile: captured.binding.declaration.profile }));
      if (checker?.kind === "ready" && (checker.plugin.kind !== "advisory-text"
        || checker.plugin.plugin.environmentDigest !== requested.environmentDigest
        || checker.plugin.plugin.resourceId !== requested.resourceId)) invalidAcknowledgement();
    });
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
      || BigInt(value.lease.generation) === 0n
      || Boolean(value.plan.tools) !== Boolean(value.toolInvocations)
      || (value.plan.tools && (!value.toolInvocations || value.toolInvocations.limit !== value.plan.tools.maxInvocations
        || value.toolInvocations.reserved > value.toolInvocations.limit))) invalidAcknowledgement();
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

/** The human workbench and bounded Agent consumer share one scope observation. */
export async function openWorkPlanAgentScope(request: WorkPlanAgentOpenRequest, expectedScope: readonly PlanSelectionBasis[]) {
  const opening = structuredClone(request);
  const capturedScope = structuredClone(expectedScope);
  if (!validators.validateRequestWorkPlanAgentOpen(opening)) throw new Error("Invalid Agent scope request");
  const opened = await checkedInvoke("open_work_plan_agent_scope", opening, (value: unknown): value is WorkPlanAgentView => {
    if (!validators.validateResponseWorkPlanAgent(value)) invalidAcknowledgement();
    return true;
  });
  if (opened.lease.planId !== opening.lease.planId
    || opened.lease.generation !== opening.lease.generation
    || !matchesCapturedScope(opened.scope, capturedScope, capturedScope.map(unit => unit.unitId))) invalidAcknowledgement();
  return opened;
}

function matchesCapturedScope(actual: readonly PlanSelectionBasis[], captured: readonly PlanSelectionBasis[], ids: readonly string[]) {
  const basis = new Map(captured.map(unit => [unit.unitId, unit]));
  return basis.size === captured.length && new Set(ids).size === ids.length
    && actual.length === ids.length && new Set(actual.map(unit => unit.unitId)).size === ids.length
    && actual.every(unit => ids.includes(unit.unitId) && jsonIdentity(unit) === jsonIdentity(basis.get(unit.unitId)));
}

/** Only the trusted host opens a scope. Give Agent callers the returned consumer. */
export async function openWorkPlanAgent(
  request: WorkPlanAgentOpenRequest, expectedScope: readonly PlanSelectionBasis[], expectedTools: readonly WorkPlanToolSpec[] = [],
) {
  const opening = structuredClone(request), capturedScope = structuredClone(expectedScope);
  const tools = new Map(structuredClone(expectedTools).map(tool => [tool.handle, tool]));
  if (tools.size !== expectedTools.length) throw new Error("Invalid Agent tool scope");
  const opened = await openWorkPlanAgentScope(opening, capturedScope);
  const basis = new Map(capturedScope.map(unit => [unit.unitId, unit]));
  const matchesScope = (actual: PlanSelectionBasis[], ids: readonly string[]) => matchesCapturedScope(actual, capturedScope, ids);
  const preparedRequests = new WeakMap<WorkPlanAgentGenerationView, WorkPlanAgentStartRequest>();
  const preparedTools = new WeakMap<WorkPlanAgentToolView, WorkPlanAgentToolStartRequest>();
  // Bounded identity witnesses only. Authority and current execution state stay
  // in Core; caller-owned DTOs and prior successful reads cannot renew a scope.
  const toolReadIdentities = new WeakMap<WorkPlanAgentToolView, {
    identity: string | undefined;
    positions: Map<number, { itemId: string; unitId: string; locale: string }>;
    locale?: string;
  }>();
  // Copy once before awaiting. Caller edits to requests or DTOs cannot change
  // the session, authority, captured basis or exact bytes selected for start.
  const context = { projectId: opening.projectId, sessionToken: opening.sessionToken, scopeId: opened.scopeId };
  const parentTask = opened.parentTask;
  function readCapture(prepared: WorkPlanAgentToolView) {
    const request = preparedTools.get(prepared), witness = toolReadIdentities.get(prepared);
    if (!request || !witness) throw new Error("Tool was not prepared by this Agent scope");
    if (jsonIdentity(prepared) !== witness.identity) throw new Error("Agent tool preparation changed");
    return { request, witness };
  }
  function sameReadCapture(prepared: WorkPlanAgentToolView, captured: ReturnType<typeof readCapture>) {
    const current = readCapture(prepared);
    if (current.request !== captured.request || current.witness !== captured.witness) throw new Error("Agent tool preparation changed");
  }
  function readOptions(value: unknown, keys: readonly string[]) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)))
      throw new Error("Invalid Agent tool read request");
  }
  return Object.freeze({
    prepare: async (generation: unknown) => {
      const preparing = { ...context, generation: structuredClone(generation) };
      if (!validators.validateRequestWorkPlanAgentPrepare(preparing))
        throw new Error("Invalid Agent generation request");
      const ids = preparing.generation.unitIds;
      if (new Set(ids).size !== ids.length || ids.some(id => !basis.has(id)))
        throw new Error("Invalid Agent generation request");
      const value = await checkedInvoke("prepare_work_plan_agent_generation", preparing, (value: unknown): value is WorkPlanAgentGenerationView => {
        if (!validators.validateResponseWorkPlanAgentGeneration(value)) invalidAcknowledgement();
        return true;
      });
      if (value.scopeId !== context.scopeId || value.parentTask !== parentTask
        || value.taskId !== preparing.generation.taskId || value.attemptId !== preparing.generation.attemptId
        || !matchesScope(value.scope, ids)) invalidAcknowledgement();
      preparedRequests.set(value, { ...preparing, inputDigest: value.inputDigest });
      return value;
    },
    start: async (prepared: WorkPlanAgentGenerationView) => {
      const starting = preparedRequests.get(prepared);
      if (!starting) throw new Error("Generation was not prepared by this Agent scope");
      const value = await checkedInvoke("start_work_plan_agent_generation", structuredClone(starting), (value: unknown): value is string => {
        if (!validators.validateResponseIdentity(value)) invalidAcknowledgement();
        return true;
      });
      if (value !== starting.generation.attemptId) invalidAcknowledgement();
      return value;
    },
    prepareTool: async (tool: unknown) => {
      const preparing = { ...context, tool: structuredClone(tool) };
      if (!validators.validateRequestWorkPlanAgentToolPrepare(preparing)) throw new Error("Invalid Agent tool request");
      const ids = preparing.tool.unitIds;
      if (!tools.has(preparing.tool.toolHandle) || new Set(ids).size !== ids.length || ids.some(id => !basis.has(id)))
        throw new Error("Invalid Agent tool request");
      const value = await checkedInvoke("prepare_work_plan_agent_tool", preparing, (value: unknown): value is WorkPlanAgentToolView => {
        if (!validators.validateResponseWorkPlanAgentTool(value)) invalidAcknowledgement();
        return true;
      });
      if (value.scopeId !== context.scopeId || value.parentTask !== parentTask
        || value.taskId !== preparing.tool.taskId || value.attemptId !== preparing.tool.attemptId
        || value.toolHandle !== preparing.tool.toolHandle || !matchesScope(value.scope, ids)) invalidAcknowledgement();
      preparedTools.set(value, { ...preparing, inputDigest: value.inputDigest });
      toolReadIdentities.set(value, { identity: jsonIdentity(value), positions: new Map() });
      return value;
    },
    startTool: async (prepared: WorkPlanAgentToolView) => {
      const starting = preparedTools.get(prepared);
      if (!starting) throw new Error("Tool was not prepared by this Agent scope");
      const value = await checkedInvoke("start_work_plan_agent_tool", structuredClone(starting), (value: unknown): value is string => {
        if (!validators.validateResponseIdentity(value)) invalidAcknowledgement();
        return true;
      });
      if (value !== starting.tool.attemptId) invalidAcknowledgement();
      return value;
    },
    readToolAttempt: async (prepared: WorkPlanAgentToolView, page: Pick<WorkPlanAgentToolAttemptRequest, "offset" | "limit">) => {
      const captured = readCapture(prepared);
      readOptions(page, ["offset", "limit"]);
      const reading = { ...structuredClone(captured.request), ...structuredClone(page) };
      const ids = captured.request.tool.unitIds;
      if (!validators.validateRequestWorkPlanAgentToolAttempt(reading) || !Number.isInteger(reading.offset)
        || reading.offset < 0 || reading.offset > ids.length || !Number.isInteger(reading.limit) || reading.limit < 1 || reading.limit > 100)
        throw new Error("Invalid Agent tool read request");
      const value = await checkedInvoke("read_work_plan_agent_tool_attempt", reading, (value: unknown): value is AttemptDetail => {
        if (!validators.validateResponseWorkPlanAgentToolAttempt(value)) invalidAcknowledgement();
        return true;
      });
      sameReadCapture(prepared, captured);
      const count = Math.min(reading.limit, ids.length - reading.offset), next = reading.offset + count;
      if (value.attemptId !== reading.tool.attemptId || value.taskId !== reading.tool.taskId || value.operation !== "plugin-tool-query"
        || value.recovery.attemptId !== reading.tool.attemptId || value.progress.total !== ids.length || value.items.length !== count
        || value.nextOffset !== (next < ids.length ? next : null)
        || new Set(value.items.map(item => item.status.itemId)).size !== count
        || new Set(value.items.map(item => item.scope.id)).size !== count) invalidAcknowledgement();
      let locale = captured.witness.locale;
      const positions = value.items.map((item, index) => {
        if (item.scope.kind !== "translation-unit" || !ids.includes(item.scope.id) || !item.scope.locale
          || locale !== undefined && locale !== item.scope.locale
          || index > 0 && value.items[index - 1].status.itemId >= item.status.itemId) invalidAcknowledgement();
        locale = item.scope.locale;
        const position = reading.offset + index, identity = { itemId: item.status.itemId, unitId: item.scope.id, locale };
        const prior = captured.witness.positions.get(position);
        if (prior && jsonIdentity(prior) !== jsonIdentity(identity)
          || [...captured.witness.positions].some(([seen, value]) => seen !== position && (value.itemId === identity.itemId || value.unitId === identity.unitId))) invalidAcknowledgement();
        return { position, identity };
      });
      captured.witness.locale = locale;
      for (const { position, identity } of positions) captured.witness.positions.set(position, identity);
      return value;
    },
    readToolOutput: async (prepared: WorkPlanAgentToolView, result: Pick<WorkPlanAgentToolOutputRequest, "itemId" | "resultId">) => {
      const captured = readCapture(prepared);
      readOptions(result, ["itemId", "resultId"]);
      const reading = { ...structuredClone(captured.request), ...structuredClone(result) };
      if (!validators.validateRequestWorkPlanAgentToolOutput(reading)) throw new Error("Invalid Agent tool read request");
      const value = await checkedInvoke("read_work_plan_agent_tool_output", reading, (value: unknown): value is ExecutionOutputView => {
        if (!validators.validateResponseWorkPlanAgentToolOutput(value)) invalidAcknowledgement();
        return true;
      });
      sameReadCapture(prepared, captured);
      if (value.projectId !== reading.projectId || value.attemptId !== reading.tool.attemptId
        || value.itemId !== reading.itemId || value.resultId !== reading.resultId || !value.plugin) invalidAcknowledgement();
      return value;
    },
  });
}
