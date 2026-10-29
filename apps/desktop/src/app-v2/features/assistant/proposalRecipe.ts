import { defaultAiConfig, validAiLimits } from "../../../aiCommands";
import type { PlanOptions, TeamExecutionMember } from "../../../generated/draft.responses";
import { newTeamMember, teamDraftProblem } from "../../../TeamExecutionDraft";

export type RunTemplate = "translate" | "translate-checks";

/** Templates change the draft recipe; scope, destinations and permission stay separate. */
export function applyRunTemplate(options: PlanOptions, template: RunTemplate): PlanOptions {
  return { ...options, stages: (["understanding", "resources", "generation", "checks", "delivery"] as const).map(stage => ({
    stage, mode: stage === "generation" || stage === "checks" && template === "translate-checks" ? "assisted" : "manual",
  })), selectionPolicy: "candidates-only", advisoryChecks: template === "translate-checks" ? options.advisoryChecks : [],
  adoptResources: false, deliver: false };
}

export function newProposalMember(unitIds: readonly string[], identity: () => string, model?: TeamExecutionMember): TeamExecutionMember {
  const { key: _key, toolRowIds: _tools, ...member } = newTeamMember(0, model?.config ?? { ...defaultAiConfig, maxItems: unitIds.length }, unitIds);
  return { ...member, memberId: identity(), roleVersionId: identity(), toolHandles: [] };
}

export function proposalTeamProblem(options: PlanOptions, unitIds: readonly string[]): "members" | "scope" | "limits" | null {
  const team = options.teamExecution;
  if (!team) return null;
  if (team.members.some(member => !validAiLimits(member.config) || !member.config.endpoint.trim() || !member.config.model.trim())) return "members";
  // The proposal has no root budget yet; that bound is checked by the original
  // WorkPlan preparation once the user chooses its connection and budget.
  const problem = teamDraftProblem({ initialKey: team.members.findIndex(member => member.memberId === team.initialMemberId),
    initialUnitId: team.initialUnitId, limits: team.limits, members: team.members.map((member, key) => ({ ...member, key, toolRowIds: [] })) },
  { ...defaultAiConfig, maxRequests: 300, concurrency: 8 }, unitIds, []);
  return problem === "tools" ? null : problem;
}
