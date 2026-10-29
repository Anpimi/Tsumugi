import type { CommandFailure } from "../../../CommandFailure";
import { sameAiConfig, validAiLimits, type AiConfig } from "../../../aiCommands";
import type { AutomationEffect, TeamExecutionMember, TeamWorkKind, TeamWorkReference, WorkPlanTeamRecoveryPrepareRequest } from "../../../generated/ai.requests";
import type { TeamRecoveryReceipt, WorkPlanTeamRecoveryPreviewView, WorkPlanTeamRecoveryStateView } from "../../../generated/ai.responses";
import { jsonIdentity } from "../../../pluginToolChoices";
import type { TeamExecutionView, WorkPlanView } from "../../../workPlanCommands";

export interface ConversationRecoveryMember {
  key: number;
  original: TeamExecutionMember | null;
  displayName: string;
  role: string;
  config: AiConfig;
  unitIds: string[];
  toolHandles: string[];
  kinds: TeamWorkKind[];
}
export interface ConversationRecoveryDraft {
  editSeq: string;
  nextKey: number;
  members: ConversationRecoveryMember[];
  recipientKey: number | null;
  unitId: string | null;
  kind: TeamWorkKind;
  instructions: string;
  postIds: string[];
  priorWork: TeamWorkReference[];
}
export type ConversationRecoveryPrepareOriginal = Omit<WorkPlanTeamRecoveryPrepareRequest, "sessionToken">;
/** Only this live owner holds confirmation and readiness; the journal holds input and identities. */
export interface ConversationRecoveryState {
  open: boolean;
  prepared: WorkPlanTeamRecoveryPreviewView | null;
  preparedRequest: ConversationRecoveryPrepareOriginal | null;
  preparedSeq: string | null;
  preparedPlan: WorkPlanView | null;
  preparedEffects: AutomationEffect[];
  memberKeys: number[];
  unresolvedWork: TeamWorkReference[];
  epoch: number;
  consent: boolean;
  busy: "prepare" | "authorize" | "close" | null;
  failure: CommandFailure | null;
  receipt: TeamRecoveryReceipt | null;
  readyEpoch: number | null;
}
export function initialConversationRecoveryState(): ConversationRecoveryState {
  return { open: false, prepared: null, preparedRequest: null, preparedSeq: null, preparedPlan: null, preparedEffects: [],
    memberKeys: [], unresolvedWork: [], epoch: 0, consent: false, busy: null, failure: null, receipt: null, readyEpoch: null };
}
export function initialConversationRecoveryDraft(plan: WorkPlanView, view: TeamExecutionView, editSeq: string): ConversationRecoveryDraft {
  const members = view.roster.map((member, key) => ({ key, original: structuredClone(member), displayName: member.displayName,
    role: member.role, config: structuredClone(member.config), unitIds: [...member.unitIds], toolHandles: [...member.toolHandles], kinds: [...member.kinds] }));
  return { editSeq, nextKey: members.length, members, recipientKey: members[0]?.key ?? null,
    unitId: members[0]?.unitIds.find(id => plan.scope.some(unit => unit.unitId === id)) ?? null,
    kind: members[0]?.kinds[0] ?? "translation", instructions: "", postIds: [], priorWork: [] };
}
export function newConversationRecoveryMember(key: number, plan: WorkPlanView): ConversationRecoveryMember | null {
  if (!plan.preview) return null;
  return { key, original: null, displayName: "", role: "", config: structuredClone({ ...plan.preview.config, concurrency: 1 }),
    unitIds: plan.scope.map(unit => unit.unitId), toolHandles: [], kinds: ["translation"] };
}
export function unchangedConversationRecoveryMember(member: ConversationRecoveryMember): boolean {
  const original = member.original;
  return !!original && original.displayName === member.displayName && original.role === member.role && sameAiConfig(original.config, member.config)
    && jsonIdentity(original.unitIds) === jsonIdentity(member.unitIds) && jsonIdentity(original.toolHandles) === jsonIdentity(member.toolHandles)
    && jsonIdentity(original.kinds) === jsonIdentity(member.kinds);
}
export type ConversationRecoveryProblem = "members" | "memberLimit" | "scope" | "work" | "unresolved" | "unresolvedLimit";
export function conversationRecoveryProblem(draft: ConversationRecoveryDraft, plan: WorkPlanView, view: TeamExecutionView,
  observation?: WorkPlanTeamRecoveryStateView | null): ConversationRecoveryProblem | null {
  if (observation && observation.state.unresolvedWork.length > 16) return "unresolvedLimit";
  const oldIds = new Set([...view.roster.map(member => member.memberId), ...view.retiredMemberIds]);
  if (oldIds.size + draft.members.filter(member => member.original === null).length > 8) return "memberLimit";
  if (draft.members.length < 1 || draft.members.length > 8 || new Set(draft.members.map(member => member.key)).size !== draft.members.length
    || draft.members.some(member => !member.displayName.trim() || !member.role.trim() || !member.kinds.length
      || new Set(member.kinds).size !== member.kinds.length || !validAiLimits(member.config) || !member.config.endpoint.trim() || !member.config.model.trim()
      || member.original && !view.roster.some(current => current.memberId === member.original?.memberId && current.roleVersionId === member.original?.roleVersionId))) return "members";
  if (draft.members.some(member => !member.unitIds.length || new Set(member.unitIds).size !== member.unitIds.length
    || member.unitIds.some(id => !plan.scope.some(unit => unit.unitId === id)) || member.unitIds.length > member.config.maxItems
    || new Set(member.toolHandles).size !== member.toolHandles.length || member.toolHandles.some(handle => !plan.tools?.entries.some(tool => tool.handle === handle)))) return "scope";
  const member = draft.members.find(value => value.key === draft.recipientKey);
  if (!draft.unitId || !member?.unitIds.includes(draft.unitId) || !member.kinds.includes(draft.kind) || !draft.instructions.trim()
    || new TextEncoder().encode(draft.instructions).length > 8192 || draft.postIds.length > 16 || new Set(draft.postIds).size !== draft.postIds.length
    || draft.priorWork.length > 16 || new Set(draft.priorWork.map(value => jsonIdentity(value))).size !== draft.priorWork.length) return "work";
  if (observation?.state.unresolvedWork.some(reference => !draft.priorWork.some(value => jsonIdentity(value) === jsonIdentity(reference)))) return "unresolved";
  return null;
}
export function recoveryBasisMatches(prepared: WorkPlanTeamRecoveryPreviewView, observation: WorkPlanTeamRecoveryStateView, view: TeamExecutionView): boolean {
  const preview = prepared.preview;
  return observation.state.planId === preview.planId && view.planId === preview.planId
    && jsonIdentity(observation.state.lease) === jsonIdentity(preview.baseLease)
    && jsonIdentity(observation.state.effectiveVersion) === jsonIdentity(preview.baseEffectiveVersion)
    && jsonIdentity(view.effectiveVersion) === jsonIdentity(preview.baseEffectiveVersion);
}
