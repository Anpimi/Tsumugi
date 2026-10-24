import { editedAiConfig, type AiConfig } from "./aiCommands";
import type { TeamExecutionLimits, TeamWorkKind } from "./generated/ai.requests";

/** Local row keys describe a draft, never an authorized member or tool handle. */
export interface TeamMemberDraft {
  key: number;
  displayName: string;
  role: string;
  config: AiConfig;
  unitIds: string[];
  toolRowIds: number[];
  kinds: TeamWorkKind[];
}
export interface TeamExecutionDraft {
  initialKey: number;
  initialUnitId: string;
  members: TeamMemberDraft[];
  limits: TeamExecutionLimits;
}
export function newTeamMember(key: number, config: AiConfig, unitIds: readonly string[]): TeamMemberDraft {
  return { key, displayName: "", role: "", config: structuredClone({ ...config, concurrency: 1 }), unitIds: [...unitIds], toolRowIds: [], kinds: ["translation"] };
}
export function newTeamExecution(config: AiConfig, unitIds: readonly string[]): TeamExecutionDraft {
  const requests = Number.isInteger(config.maxRequests) && config.maxRequests > 0 ? config.maxRequests : 1;
  const concurrency = Number.isInteger(config.concurrency) && config.concurrency > 0 ? config.concurrency : 1;
  const maxActivations = Math.min(12, requests);
  return { initialKey: 0, initialUnitId: unitIds[0] ?? "", members: [newTeamMember(0, config, unitIds)], limits: {
    maxActivations, maxConcurrency: Math.min(3, 8, concurrency, maxActivations), maxNoProgress: Math.min(3, maxActivations),
  } };
}
export function editTeamMemberConfig(member: TeamMemberDraft, next: AiConfig): TeamMemberDraft {
  return { ...member, config: editedAiConfig(member.config, next) };
}
export function teamDraftProblem(value: TeamExecutionDraft, root: AiConfig, selected: readonly string[], toolRows: readonly number[]): "members" | "limits" | "scope" | "tools" | null {
  const { members, limits } = value;
  if (members.length < 1 || members.length > 8 || new Set(members.map(member => member.key)).size !== members.length
    || !members.some(member => member.key === value.initialKey && member.kinds.includes("translation")) || members.some(member => !member.displayName.trim() || !member.role.trim()
      || member.kinds.length === 0 || new Set(member.kinds).size !== member.kinds.length)) return "members";
  if (!Number.isInteger(limits.maxActivations) || limits.maxActivations < 1 || limits.maxActivations > Math.min(300, root.maxRequests)
    || !Number.isInteger(limits.maxConcurrency) || limits.maxConcurrency < 1 || limits.maxConcurrency > Math.min(8, root.concurrency, limits.maxActivations)
    || !Number.isInteger(limits.maxNoProgress) || limits.maxNoProgress < 1 || limits.maxNoProgress > limits.maxActivations
    || members.some(member => member.config.maxRequests > root.maxRequests || member.unitIds.length > member.config.maxItems)) return "limits";
  if (!members.find(member => member.key === value.initialKey)?.unitIds.includes(value.initialUnitId)
    || members.some(member => member.unitIds.length === 0 || new Set(member.unitIds).size !== member.unitIds.length
    || member.unitIds.some(id => !selected.includes(id)))) return "scope";
  if (members.some(member => new Set(member.toolRowIds).size !== member.toolRowIds.length || member.toolRowIds.some(id => !toolRows.includes(id)))) return "tools";
  return null;
}
