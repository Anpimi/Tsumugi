import { checkedInvoke } from "./ipc";
import { sameAiConfig } from "./aiCommands";
import type {
  WorkPlanPrepareRequest, WorkPlanAuthorizeRequest, WorkPlanStartRequest,
  WorkPlanControlRequest, WorkPlanStatusRequest, WorkPlanActionRequest,
  WorkProtectionReadRequest, WorkProtectionSetRequest,
  WorkPlanAgentOpenRequest, WorkPlanAgentStartRequest, WorkPlanAgentToolStartRequest,
  WorkPlanAgentToolAttemptRequest, WorkPlanAgentToolOutputRequest,
  WorkPlanAgentDelegateRequest, WorkPlanAgentGenerationAttemptRequest,
  WorkPlanAgentReconcileRequest,
  MaintenanceAssessmentRequest,
  WorkPlanTeamHistoryRequest, WorkPlanTeamPostRequest, WorkPlanTeamPublishRequest, WorkPlanTeamPublicationActionRequest,
  WorkPlanTeamExecutionRequest,
} from "./generated/ai.requests";
import type { AttemptDetail, ExecutionOutputView, WorkPlanView, TeamDiscussionPost, WorkPlanAgentView, WorkPlanAgentGenerationView, WorkPlanAgentToolView, WorkPlanToolSpec, PlanSelectionBasis,
  WorkPlanAgentGuidanceView, WorkPlanAgentGuidanceTextView } from "./generated/ai.responses";
import * as validators from "./generated/ai.validators";
import type { PluginToolView } from "./pluginCommands";
import { jsonIdentity } from "./pluginToolChoices";
import { checkerIdentity, contractIdentity } from "./reviewIdentity";
import { validWorkPlanApplicationTools } from "./workPlanApplicationTools";
export type {
  WorkPlanView, WorkPlanReceiptView, WorkPlanStatusView, WorkProtection,
  MaintenanceAssessment, MaintenanceAction, MaintenanceChoice, MaintenancePlanBasis,
  TeamHistoryPage, TeamDiscussionPost, TeamMemberRole,
  TeamExecutionView,
} from "./generated/ai.responses";
export type { WorkPlanTeamHistoryRequest, WorkPlanTeamPostRequest, WorkPlanTeamPublishRequest, WorkPlanTeamPublicationActionRequest } from "./generated/ai.requests";
export type { PlanOptions, WorkPlanCommand, AutomationEffect } from "./generated/ai.requests";

function invalidAcknowledgement(): never {
  throw Object.assign(new Error("Invalid work-plan acknowledgement"), {
    outcome: "unknown", reason: "invalid-work-plan-acknowledgement",
  });
}

function validDiscussionDisclosure(plan: WorkPlanView): boolean {
  const policy = plan.options.teamDiscussions, limits = plan.teamDiscussionLimits;
  if (!policy) return !limits;
  if (!limits || !plan.preview) return false;
  return policy.profile === "current-plan-1" ? limits.maxArtifactBytes === 0 : limits.maxArtifactBytes > 0;
}

function validTeamExecutionDisclosure(plan: WorkPlanView): boolean {
  const policy = plan.options.teamExecution, previews = plan.memberPreviews ?? [];
  if (!policy) return previews.length === 0;
  const initial = policy.members.find(member => member.memberId === policy.initialMemberId), limits = policy.limits;
  if (!plan.preview || !plan.options.teamDiscussions || policy.members.length < 1 || policy.members.length > 8 || previews.length !== policy.members.length
    || new Set(previews.map(value => value.memberId)).size !== previews.length
    || new Set(policy.members.map(value => value.memberId)).size !== policy.members.length
    || new Set(policy.members.map(value => value.roleVersionId)).size !== policy.members.length
    || !initial?.kinds.includes("translation") || !initial.unitIds.includes(policy.initialUnitId)
    || limits.maxActivations < 1 || limits.maxActivations > Math.min(300, plan.preview.config.maxRequests)
    || limits.maxConcurrency < 1 || limits.maxConcurrency > Math.min(8, plan.preview.config.concurrency, limits.maxActivations)
    || limits.maxNoProgress < 1 || limits.maxNoProgress > limits.maxActivations) return false;
  return policy.members.every(member => {
    const preview = previews.find(value => value.memberId === member.memberId)?.preview;
    return !!preview && sameAiConfig(preview.config, member.config) && preview.recipe === plan.preview!.recipe
      && preview.items.length === member.unitIds.length && new Set(preview.items.map(item => item.unitId)).size === member.unitIds.length
      && preview.items.every(item => member.unitIds.includes(item.unitId) && item.targetLocale === plan.locale && plan.scope.some(unit =>
        unit.unitId === item.unitId && unit.nativeKey === item.nativeKey && unit.sourceRevisionId === item.sourceRevisionId && unit.sourceSnapshotId === item.sourceSnapshotId))
      && member.toolHandles.every(handle => plan.tools?.entries.some(tool => tool.handle === handle));
  });
}

function publicationMatches(post: TeamDiscussionPost, request: WorkPlanTeamPublishRequest): boolean {
  return post.planId === request.lease.planId && post.author.kind === "human" && post.author.actor === "local-user"
    && post.author.binding.delegation === null
    && jsonIdentity(post.author.binding.lease) === jsonIdentity(request.lease)
    && jsonIdentity(post.publication) === jsonIdentity(request.publication);
}

/** Receipts report an action's historical result. Read status for current authority. */
export const workPlanCommands = {
  teamExecution: async (request: WorkPlanTeamExecutionRequest) => {
    if (!validators.validateRequestWorkPlanTeamExecution(request)) throw new Error("Invalid team execution read");
    const value = await checkedInvoke("read_work_plan_team_execution", request, validators.validateResponseWorkPlanTeamExecution);
    if (value.planId !== request.planId || value.works.length > request.limit || value.messages.length > request.limit
      || value.members.some(member => member.planId !== request.planId)
      || value.works.some((work, index) => work.receipt.planId !== request.planId
        || work.validation !== "valid" && (work.output !== null || work.candidateRevisionId !== null)
        || (work.request ? !work.author || work.author.binding.lease.planId !== request.planId
          || work.request.intentId !== work.receipt.intentId || work.request.recipientMemberId !== work.receipt.memberId
          || jsonIdentity(work.request.target) !== jsonIdentity(work.target) : work.author !== null)
        || BigInt(work.sequence) <= BigInt(index ? value.works[index - 1].sequence : request.afterWork ?? "0"))
      || value.messages.some((message, index) => message.planId !== request.planId || message.sender.binding.lease.planId !== request.planId
        || BigInt(message.sequence) <= BigInt(index ? value.messages[index - 1].sequence : request.afterMessage ?? "0"))
      || new Set(value.works.map(work => work.receipt.intentId)).size !== value.works.length
      || new Set(value.messages.map(message => message.messageId)).size !== value.messages.length
      || value.nextWorkAfter !== null && value.nextWorkAfter !== value.works.at(-1)?.sequence
      || value.nextMessageAfter !== null && value.nextMessageAfter !== value.messages.at(-1)?.sequence) invalidAcknowledgement();
    return value;
  },
  teamHistory: async (request: WorkPlanTeamHistoryRequest) => {
    if (!validators.validateRequestWorkPlanTeamHistory(request)) throw new Error("Invalid team history request");
    const value = await checkedInvoke("read_work_plan_team_history", request, validators.validateResponseWorkPlanTeamHistory);
    const roles = value.authorRoles;
    if (value.planId !== request.planId || value.posts.length > request.limit
      || value.posts.some((post, index) => post.planId !== request.planId
        || (post.author.kind === "human" ? post.author.binding : post.author.author.binding).lease.planId !== request.planId
        || BigInt(post.sequence) <= BigInt(index ? value.posts[index - 1].sequence : request.after ?? "0"))
      || new Set(value.posts.map(post => post.publication.postId)).size !== value.posts.length
      || value.members.some(role => role.planId !== request.planId)
      || roles.some(role => role.planId !== request.planId)
      || new Set(value.members.map(role => role.request.memberId)).size !== value.members.length
      || new Set(roles.map(role => role.request.roleVersionId)).size !== roles.length
      || value.posts.some(post => { const author = post.author; return author.kind === "member" && !roles.some(role =>
        role.request.memberId === author.author.memberId && role.request.roleVersionId === author.author.roleVersionId); })
      || value.nextAfter !== null && value.nextAfter !== value.posts.at(-1)?.sequence) invalidAcknowledgement();
    return value;
  },
  teamPost: async (request: WorkPlanTeamPostRequest) => {
    if (!validators.validateRequestWorkPlanTeamPost(request)) throw new Error("Invalid team post request");
    const value = await checkedInvoke("read_work_plan_team_post", request, validators.validateResponseWorkPlanTeamPost);
    const binding = value.author.kind === "human" ? value.author.binding : value.author.author.binding;
    if (value.planId !== request.planId || value.publication.postId !== request.postId || binding.lease.planId !== request.planId) invalidAcknowledgement();
    return value;
  },
  publishTeam: async (input: WorkPlanTeamPublishRequest) => {
    const request = structuredClone(input);
    if (!validators.validateRequestWorkPlanTeamPublish(request)) throw new Error("Invalid team publication request");
    const value = await checkedInvoke("publish_work_plan_team_discussion", request, validators.validateResponseWorkPlanTeamPost);
    if (!publicationMatches(value, request)) invalidAcknowledgement();
    return value;
  },
  teamPublicationAction: async (input: WorkPlanTeamPublicationActionRequest) => {
    const request = structuredClone(input);
    if (!validators.validateRequestWorkPlanTeamPublicationAction(request)) throw new Error("Invalid team publication lookup");
    const value = await checkedInvoke("read_work_plan_team_publication_action", request, validators.validateResponseWorkPlanTeamPublicationAction);
    if (value && !publicationMatches(value, request)) invalidAcknowledgement();
    return value;
  },
  reconcileAgent: async (input: WorkPlanAgentReconcileRequest) => {
    const request = structuredClone(input);
    if (!validators.validateRequestWorkPlanAgentReconcile(request)) throw new Error("Invalid Agent reconciliation request");
    const value = await checkedInvoke("reconcile_work_plan_agent_execution", request, validators.validateResponseWorkPlanAgentReconcile);
    if (jsonIdentity(value.identity.lease) !== jsonIdentity(request.lease) || value.identity.taskId !== request.taskId
      || value.identity.attemptId !== request.attemptId || value.identity.inputDigest !== request.inputDigest) invalidAcknowledgement();
    return value;
  },
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
      || jsonIdentity(value.options.teamDiscussions) !== jsonIdentity(request.options.teamDiscussions)
      || jsonIdentity(value.options.teamExecution) !== jsonIdentity(request.options.teamExecution)
      || !validDiscussionDisclosure(value)
      || !validTeamExecutionDisclosure(value)
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
        || !validWorkPlanApplicationTools(value.tools.entries)
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
              componentScope: expected.componentScope, applicationScope: tool.execution.applicationScope, profile: expected.binding.declaration.profile,
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
    if (!validators.validateRequestWorkPlanAuthorize(request)
      || new Set(request.applicationToolExecutions.map(basis => basis.instanceId)).size !== request.applicationToolExecutions.length) throw new Error("Invalid work-plan authorization request");
    const value = await checkedInvoke("authorize_work_plan", request, validators.validateResponseWorkPlanReceipt);
    if (value.actionId !== request.actionId || value.lease.planId !== request.planId
      || value.lease.generation !== "1" || value.state !== "active"
      || typeof value.attemptId !== "string" || value.parentTask != null) invalidAcknowledgement();
    return value;
  },
  authorizationAction: async (request:WorkPlanAuthorizeRequest) => {
    const value=await checkedInvoke("read_work_plan_authorization_action",request,validators.validateResponseWorkPlanAuthorizationAction);
    const recorded={kind:"authorize",planId:request.planId,actionId:request.actionId,digest:request.digest,
      confirmed:request.confirmed,effects:request.effects,expiresAt:request.expiresAt};
    if(value!==null && (value.projectId!==request.projectId || jsonIdentity(value.request)!==jsonIdentity(recorded)
      || value.receipt.actionId!==request.actionId || value.receipt.lease.planId!==request.planId
      || value.receipt.lease.generation!=="1" || value.receipt.state!=="active" || typeof value.receipt.attemptId!=="string"
      || value.receipt.parentTask!==null)) invalidAcknowledgement();
    return value;
  },
  controlAction: async (request:WorkPlanControlRequest) => {
    const value=await checkedInvoke("read_work_plan_control_action",request,validators.validateResponseWorkPlanControlAction);
    const recorded={kind:"control",planId:request.planId,actionId:request.actionId,expectedGeneration:request.expectedGeneration,
      command:request.command,confirmed:request.confirmed,expiresAt:request.expiresAt??null};
    const state={pause:"paused",stop:"stopped","take-over":"taken-over",continue:"active"}[request.command];
    if(value!==null && (value.projectId!==request.projectId || jsonIdentity(value.request)!==jsonIdentity(recorded)
      || value.receipt.actionId!==request.actionId || value.receipt.lease.planId!==request.planId
      || value.receipt.lease.generation!==(BigInt(request.expectedGeneration)+1n).toString() || value.receipt.state!==state
      || (request.command==="continue"?typeof value.receipt.attemptId!=="string":value.receipt.attemptId!==null||value.receipt.parentTask!==null))) invalidAcknowledgement();
    return value;
  },
  start: async (request: WorkPlanStartRequest, expectedAttemptId: string) => {
    // The attempt identity is returned by authorization or continuation. The
    // backend resolves it from the action receipt and rechecks current authority.
    const value = await checkedInvoke("start_work_plan", request, validators.validateResponseIdentity);
    if (value !== expectedAttemptId) invalidAcknowledgement();
    return value;
  },
  startAction: async (request: WorkPlanStartRequest) => {
    const value = await checkedInvoke("read_work_plan_start_action", request, validators.validateResponseWorkPlanStartAction);
    if (value !== null && (value.projectId !== request.projectId || value.planId !== request.planId
      || value.actionId !== request.actionId || value.expectedGeneration !== request.expectedGeneration)) invalidAcknowledgement();
    return value;
  },
  control: async (request: WorkPlanControlRequest) => {
    if (!validators.validateRequestWorkPlanControl(request)
      || request.command !== "continue" && request.applicationToolExecutions.length !== 0
      || new Set(request.applicationToolExecutions.map(basis => basis.instanceId)).size !== request.applicationToolExecutions.length) throw new Error("Invalid work-plan control request");
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
      || !validDiscussionDisclosure(value.plan)
      || !validTeamExecutionDisclosure(value.plan)
      || Boolean(value.plan.tools) !== Boolean(value.toolInvocations)
      || (value.plan.tools && (!value.toolInvocations || value.toolInvocations.limit !== value.plan.tools.maxInvocations
        || value.toolInvocations.reserved > value.toolInvocations.limit || !validWorkPlanApplicationTools(value.plan.tools.entries)))) invalidAcknowledgement();
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
    || opened.delegation !== null
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
  const capturedTools = structuredClone(expectedTools);
  if (new Set(capturedTools.map(tool => tool.handle)).size !== capturedTools.length) throw new Error("Invalid Agent tool scope");
  const opened = await openWorkPlanAgentScope(opening, capturedScope);
  const root = createWorkPlanAgentConsumer(opening, opened, capturedScope, capturedTools);
  const proposals = new WeakMap<object, WorkPlanAgentDelegateRequest>();
  return Object.freeze({ ...root, delegate: async (proposal: { unitIds: string[]; toolHandles: string[] }) => {
    if (!proposal || typeof proposal !== "object") throw new Error("Invalid Agent subset request");
    let captured = proposals.get(proposal);
    if (!captured && (Object.keys(proposal).length !== 2
      || Object.keys(proposal).some(key => key !== "unitIds" && key !== "toolHandles")
      || !Array.isArray(proposal.unitIds) || !proposal.unitIds.length || proposal.unitIds.length > 100
      || new Set(proposal.unitIds).size !== proposal.unitIds.length || proposal.unitIds.some(id => !capturedScope.some(unit => unit.unitId === id))
      || !Array.isArray(proposal.toolHandles) || proposal.toolHandles.length > 32
      || new Set(proposal.toolHandles).size !== proposal.toolHandles.length || proposal.toolHandles.some(id => !capturedTools.some(tool => tool.handle === id))))
      throw new Error("Invalid Agent subset request");
    if (!captured) {
      const value: unknown = { projectId: opening.projectId, sessionToken: opening.sessionToken,
        scopeId: opened.scopeId, delegation: { delegationId: crypto.randomUUID(),
          unitIds: [...proposal.unitIds].sort(), toolHandles: [...proposal.toolHandles].sort() } };
      if (!validators.validateRequestWorkPlanAgentDelegate(value)) throw new Error("Invalid Agent subset request");
      captured = value;
      proposals.set(proposal, captured);
    }
    const sending = structuredClone(captured);
    if (!validators.validateRequestWorkPlanAgentDelegate(sending)) throw new Error("Invalid Agent subset request");
    const value = await checkedInvoke("delegate_work_plan_agent_scope", sending, validators.validateResponseWorkPlanAgent);
    if (!value.delegation || value.delegation.parentScopeId !== opened.scopeId || value.scopeId === opened.scopeId
      || value.delegation.delegationId !== sending.delegation.delegationId
      || jsonIdentity(value.delegation.unitIds) !== jsonIdentity(sending.delegation.unitIds)
      || jsonIdentity(value.delegation.toolHandles) !== jsonIdentity(sending.delegation.toolHandles)
      || jsonIdentity(value.lease) !== jsonIdentity(opened.lease) || value.parentTask !== opened.parentTask
      || value.budget.limit !== opened.budget.limit
      || jsonIdentity(value.scope) !== jsonIdentity(capturedScope.filter(unit => sending.delegation.unitIds.includes(unit.unitId)))
      || !matchesCapturedScope(value.scope, capturedScope, sending.delegation.unitIds)) invalidAcknowledgement();
    return createWorkPlanAgentConsumer(opening, value, value.scope, capturedTools.filter(tool => sending.delegation.toolHandles.includes(tool.handle)));
  } });
}

export type WorkPlanAgentLeaf = ReturnType<typeof createWorkPlanAgentConsumer>;
function createWorkPlanAgentConsumer(opening: WorkPlanAgentOpenRequest, received: WorkPlanAgentView,
  expectedScope: readonly PlanSelectionBasis[], expectedTools: readonly WorkPlanToolSpec[]) {
  const opened = structuredClone(received), capturedScope = structuredClone(expectedScope);
  const tools = new Map(structuredClone(expectedTools).map(tool => [tool.handle, tool]));
  if (tools.size !== expectedTools.length) throw new Error("Invalid Agent tool scope");
  const basis = new Map(capturedScope.map(unit => [unit.unitId, unit]));
  const matchesScope = (actual: PlanSelectionBasis[], ids: readonly string[]) => matchesCapturedScope(actual, capturedScope, ids);
  const preparedRequests = new WeakMap<WorkPlanAgentGenerationView, WorkPlanAgentStartRequest>();
  const preparedTools = new WeakMap<WorkPlanAgentToolView, WorkPlanAgentToolStartRequest>();
  const generationReads = new WeakMap<WorkPlanAgentGenerationView, { identity: string | undefined;
    positions: Map<number, { itemId: string; unitId: string; locale: string }>; locale?: string }>();
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
  function guidanceTool(handle: string) {
    const tool = tools.get(handle);
    if (!tool) throw new Error("Tool is outside this Agent guidance scope");
    return tool;
  }
  function generationCapture(prepared: WorkPlanAgentGenerationView) {
    const request = preparedRequests.get(prepared), witness = generationReads.get(prepared);
    if (!request || !witness) throw new Error("Generation was not prepared by this Agent scope");
    if (jsonIdentity(prepared) !== witness.identity) throw new Error("Agent generation preparation changed");
    return { request, witness };
  }
  function confirmGuidanceText(value: WorkPlanAgentGuidanceTextView, tool: WorkPlanToolSpec) {
    if (value.scopeId !== context.scopeId || value.parentTask !== parentTask || jsonIdentity(value.tool) !== jsonIdentity(tool)) invalidAcknowledgement();
    const bytes = new TextEncoder().encode(value.content.text);
    // UTF-16 lone surrogates must not silently become replacement characters.
    if (bytes.byteLength > 65536 || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value.content.text) invalidAcknowledgement();
    return value;
  }
  return Object.freeze({
    scope: structuredClone(opened),
    readGuidance: async () => {
      const value = await checkedInvoke("read_work_plan_agent_guidance", { ...context }, (value: unknown): value is WorkPlanAgentGuidanceView => {
        if (!validators.validateResponseWorkPlanAgentGuidance(value)) invalidAcknowledgement();
        return true;
      });
      if (value.scopeId !== context.scopeId || value.parentTask !== parentTask || value.tools.length !== tools.size || value.tools.length > 32
        || new Set(value.tools.map(tool => tool.handle)).size !== tools.size
        || value.tools.some(tool => jsonIdentity(tool) !== jsonIdentity(tools.get(tool.handle)))) invalidAcknowledgement();
      return value;
    },
    readSkill: async (toolHandle: string) => {
      const tool = guidanceTool(toolHandle), skillId = tool.binding.declaration.skill;
      if (!skillId) throw new Error("This Agent tool has no Skill");
      const reading = { ...context, toolHandle: tool.handle, skillId };
      if (!validators.validateRequestWorkPlanAgentSkill(reading)) throw new Error("Invalid Agent guidance request");
      const value = confirmGuidanceText(await checkedInvoke("read_work_plan_agent_skill", reading, (value: unknown): value is WorkPlanAgentGuidanceTextView => {
        if (!validators.validateResponseWorkPlanAgentSkill(value)) invalidAcknowledgement();
        return true;
      }), tool);
      if (value.content.kind !== "skill" || value.content.contributionId !== skillId) invalidAcknowledgement();
      return value;
    },
    readResource: async (toolHandle: string, resourceId: string) => {
      const tool = guidanceTool(toolHandle), resource = tool.binding.resources.find(resource => resource.contributionId === resourceId);
      if (!resource) throw new Error("Resource is outside this Agent tool declaration");
      const reading = { ...context, toolHandle: tool.handle, resourceId: resource.contributionId };
      if (!validators.validateRequestWorkPlanAgentResource(reading)) throw new Error("Invalid Agent guidance request");
      const value = confirmGuidanceText(await checkedInvoke("read_work_plan_agent_resource", reading, (value: unknown): value is WorkPlanAgentGuidanceTextView => {
        if (!validators.validateResponseWorkPlanAgentResource(value)) invalidAcknowledgement();
        return true;
      }), tool);
      if (value.content.kind !== "resource" || value.content.contributionId !== resource.contributionId
        || jsonIdentity(value.content.schema) !== jsonIdentity(resource.schema)) invalidAcknowledgement();
      return value;
    },
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
      generationReads.set(value, { identity: jsonIdentity(value), positions: new Map() });
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
    readGenerationAttempt: async (prepared: WorkPlanAgentGenerationView, page: Pick<WorkPlanAgentGenerationAttemptRequest, "offset" | "limit">) => {
      const captured = generationCapture(prepared);
      readOptions(page, ["offset", "limit"]);
      const reading = { ...structuredClone(captured.request), ...structuredClone(page) }, ids = captured.request.generation.unitIds;
      if (!validators.validateRequestWorkPlanAgentGenerationAttempt(reading) || !Number.isInteger(reading.offset) || reading.offset < 0 || reading.offset > ids.length
        || !Number.isInteger(reading.limit) || reading.limit < 1 || reading.limit > 100) throw new Error("Invalid Agent generation read request");
      const value = await checkedInvoke("read_work_plan_agent_generation_attempt", reading, validators.validateResponseWorkPlanAgentGenerationAttempt);
      if (generationCapture(prepared).request !== captured.request) throw new Error("Agent generation preparation changed");
      const count = Math.min(reading.limit, ids.length - reading.offset), next = reading.offset + count;
      if (value.attemptId !== reading.generation.attemptId || value.taskId !== reading.generation.taskId || value.operation !== "ai-translation"
        || value.recovery.attemptId !== reading.generation.attemptId || value.progress.total !== ids.length || value.items.length !== count
        || value.nextOffset !== (next < ids.length ? next : null)
        || new Set(value.items.map(item => item.status.itemId)).size !== count || new Set(value.items.map(item => item.scope.id)).size !== count) invalidAcknowledgement();
      let locale = captured.witness.locale;
      const positions = value.items.map((item, index) => {
        if (item.scope.kind !== "translation-unit" || !ids.includes(item.scope.id) || !item.scope.locale
          || locale !== undefined && item.scope.locale !== locale || index > 0 && value.items[index - 1].status.itemId >= item.status.itemId) invalidAcknowledgement();
        locale = item.scope.locale;
        const position = reading.offset + index, identity = { itemId: item.status.itemId, unitId: item.scope.id, locale };
        const prior = captured.witness.positions.get(position);
        if (prior && jsonIdentity(prior) !== jsonIdentity(identity)
          || [...captured.witness.positions].some(([seen, item]) => seen !== position && (item.itemId === identity.itemId || item.unitId === identity.unitId))) invalidAcknowledgement();
        return { position, identity };
      });
      captured.witness.locale = locale;
      for (const { position, identity } of positions) captured.witness.positions.set(position, identity);
      return value;
    },
    readGenerationOutput: async (prepared: WorkPlanAgentGenerationView, itemId: string, resultId: string) => {
      const captured = generationCapture(prepared), reading = { ...structuredClone(captured.request), itemId, resultId };
      if (!validators.validateRequestWorkPlanAgentGenerationOutput(reading)) throw new Error("Invalid Agent generation read request");
      const value = await checkedInvoke("read_work_plan_agent_generation_output", reading, validators.validateResponseWorkPlanAgentGenerationOutput);
      if (generationCapture(prepared).request !== captured.request) throw new Error("Agent generation preparation changed");
      if (value.projectId !== reading.projectId || value.attemptId !== reading.generation.attemptId || value.itemId !== itemId || value.resultId !== resultId) invalidAcknowledgement();
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
