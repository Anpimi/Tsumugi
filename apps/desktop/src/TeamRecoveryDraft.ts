import { sameAiConfig } from "./aiCommands";
import { jsonIdentity } from "./pluginToolChoices";
import type { TeamExecutionMember, TeamWorkKind, TeamWorkReference } from "./generated/ai.requests";
import type { WorkPlanView, TeamExecutionView } from "./workPlanCommands";
import type { TeamMemberDraft } from "./TeamExecutionDraft";

export interface RecoveryMemberDraft extends TeamMemberDraft { original: TeamExecutionMember | null }
export interface TeamRecoveryDraft {
  planId: string;
  nextKey: number;
  members: RecoveryMemberDraft[];
  recipientKey: number;
  unitId: string;
  kind: TeamWorkKind;
  instructions: string;
  postIds: string[];
  priorWork: TeamWorkReference[];
}
export function recoveryDraft(plan: WorkPlanView, view: TeamExecutionView): TeamRecoveryDraft {
  const tools = plan.tools?.entries ?? [];
  const members = view.roster.map((member, key) => ({ key, original: structuredClone(member), displayName: member.displayName, role: member.role,
    config: structuredClone(member.config), unitIds: [...member.unitIds], kinds: [...member.kinds],
    toolRowIds: member.toolHandles.map(handle => tools.findIndex(tool => tool.handle === handle)) }));
  return { planId: plan.planId, nextKey: members.length, members, recipientKey: members[0]?.key ?? -1, unitId: members[0]?.unitIds[0] ?? "",
    kind: members[0]?.kinds[0] ?? "translation", instructions: "", postIds: [], priorWork: [] };
}
export function unchangedRecoveryMember(draft: RecoveryMemberDraft, handles: string[]): boolean {
  const original = draft.original;
  return !!original && original.displayName === draft.displayName && original.role === draft.role
    && sameAiConfig(original.config, draft.config) && jsonIdentity(original.unitIds) === jsonIdentity(draft.unitIds)
    && jsonIdentity(original.toolHandles) === jsonIdentity(handles) && jsonIdentity(original.kinds) === jsonIdentity(draft.kinds);
}
export function recoveryDraftProblem(draft: TeamRecoveryDraft, plan: WorkPlanView, view: TeamExecutionView): "members" | "scope" | "work" | "memberLimit" | null {
  const roster = draft.members, tools = plan.tools?.entries ?? [];
  const oldIds = new Set([...view.roster.map(member => member.memberId), ...view.retiredMemberIds]);
  if (oldIds.size + roster.filter(member => member.original === null).length > 8) return "memberLimit";
  if (roster.length < 1 || roster.length > 8 || new Set(roster.map(member => member.key)).size !== roster.length
    || roster.some(member => !member.displayName.trim() || !member.role.trim() || !member.kinds.length || new Set(member.kinds).size !== member.kinds.length
      || member.original && !view.roster.some(current => current.memberId === member.original!.memberId && current.roleVersionId === member.original!.roleVersionId))) return "members";
  if (roster.some(member => !member.unitIds.length || new Set(member.unitIds).size !== member.unitIds.length
    || member.unitIds.some(id => !plan.scope.some(unit => unit.unitId === id)) || member.unitIds.length > member.config.maxItems
    || new Set(member.toolRowIds).size !== member.toolRowIds.length || member.toolRowIds.some(id => !Number.isInteger(id) || !tools[id]))) return "scope";
  const recipient = roster.find(member => member.key === draft.recipientKey);
  if (!recipient?.unitIds.includes(draft.unitId) || !recipient.kinds.includes(draft.kind) || !draft.instructions.trim()
    || new TextEncoder().encode(draft.instructions).length > 8192 || draft.postIds.length > 16 || draft.priorWork.length > 16) return "work";
  return null;
}
