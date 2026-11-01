import { aiCommands, sameAiConfig, type AiView } from "../../../aiCommands";
import type { SessionRequest } from "../../../executionCommands";
import type { WorkPlanStartReceipt } from "../../../generated/ai.responses";
import { jsonIdentity } from "../../../pluginToolChoices";
import { translationCommands, type TranslationRevision } from "../../../translationCommands";
import type { WorkPlanView } from "../../../workPlanCommands";
import type { ConversationPlanLink } from "./conversationRun";

export interface ConversationRunCandidateTarget {
  projectId: string; conversationId: string; planId: string; planDigest: string;
  actionId: string; generation: string; taskId: string; attemptId: string;
  unitId: string; locale: string; sourceRevisionId: string; sourceSnapshotId: string;
  itemId: string; resultId: string; revisionId: string;
}
export type OpenConversationRunCandidate = (target: ConversationRunCandidateTarget, current: () => boolean) => Promise<boolean>;

export interface ConversationRunEffectTarget {
  projectId: string; conversationId: string; planId: string; planDigest: string;
  startActionId: string; generation: string; taskId: string; attemptId: string;
  unitId: string; locale: string; sourceRevisionId: string; sourceSnapshotId: string;
  itemId: string; resultId: string | null; revisionId: string | null; effectActionId: string | null;
}
export type RetryConversationRunEffect = (target: ConversationRunEffectTarget, current: () => boolean) => Promise<boolean>;

export function conversationRunEffectTarget(link: ConversationPlanLink, start: WorkPlanStartReceipt, row: AiView["rows"][number]): ConversationRunEffectTarget | null {
  if (start.projectId !== link.projectId || start.planId !== link.planId || row.automation?.phase !== "failed"
    || !row.automation.retryable || row.candidateDecision?.request.disposition === "rejected") return null;
  return { projectId: link.projectId, conversationId: link.conversationId, planId: link.planId, planDigest: link.planDigest,
    startActionId: start.actionId, generation: start.expectedGeneration, taskId: start.taskId, attemptId: start.attemptId,
    unitId: row.item.unitId, locale: row.item.targetLocale, sourceRevisionId: row.item.sourceRevisionId, sourceSnapshotId: row.item.sourceSnapshotId,
    itemId: row.itemId, resultId: row.resultId, revisionId: row.savedRevisionId, effectActionId: row.automation.actionId };
}

/** The conversation planning contract captures at most 100 source entries. */
export async function readConversationRunResults(context: SessionRequest, link: ConversationPlanLink, plan: WorkPlanView, start: WorkPlanStartReceipt, read = aiCommands.read): Promise<AiView> {
  const captured = structuredClone({ context, link, plan, start });
  const { context: request, link: origin, plan: fixed, start: recorded } = captured;
  if (origin.projectId !== request.projectId || fixed.planId !== origin.planId || fixed.digest !== origin.planDigest
    || recorded.projectId !== request.projectId || recorded.planId !== origin.planId || !fixed.preview
    || fixed.options.teamExecution || fixed.options.mcpTermQuery || fixed.scope.length === 0 || fixed.scope.length > 100)
    throw new Error("Invalid conversation run result scope");
  const value = await read({ ...request, attemptId: recorded.attemptId });
  const detail = value.detail, progress = detail.progress;
  const scopes = new Map(fixed.scope.map(unit => [unit.unitId, unit]));
  const material = new Map(fixed.preview.items.map(item => [item.unitId, item]));
  const items = new Map(detail.items.map(item => [item.status.itemId, item]));
  if (value.planId !== origin.planId || value.planGeneration !== recorded.expectedGeneration
    || detail.taskId !== recorded.taskId || detail.attemptId !== recorded.attemptId || detail.recovery.attemptId !== recorded.attemptId
    || !sameAiConfig(value.config, fixed.preview.config) || value.recipe !== fixed.preview.recipe
    || detail.nextOffset !== null || progress.total !== fixed.scope.length || detail.items.length !== progress.total
    || value.rows.length !== progress.total || scopes.size !== fixed.scope.length || material.size !== scopes.size || items.size !== detail.items.length
    || new Set(value.rows.map(row => row.item.unitId)).size !== scopes.size
    || progress.adopted > progress.total || progress.total !== progress.queued + progress.running + progress.succeeded + progress.failed + progress.cancelled + progress.unknown
    || value.rows.some(row => {
      const basis = scopes.get(row.item.unitId), item = items.get(row.itemId), decision = row.candidateDecision;
      return !basis || !item || row.item.targetLocale !== fixed.locale || row.item.sourceRevisionId !== basis.sourceRevisionId
        || row.item.sourceSnapshotId !== basis.sourceSnapshotId || row.item.nativeKey !== basis.nativeKey
        || jsonIdentity(row.item) !== jsonIdentity(material.get(row.item.unitId)) || item.resultId !== row.resultId
        || row.output !== null && (item.status.execution !== "succeeded" || item.status.validation !== "valid")
        || decision != null && (decision.request.projectId !== request.projectId
          || decision.request.unitId !== row.item.unitId || decision.request.locale !== row.item.targetLocale
          || decision.request.sourceRevisionId !== row.item.sourceRevisionId || decision.request.revisionId !== row.savedRevisionId);
    })) throw new Error("Conversation run results do not match the recorded start");
  return value;
}

export function conversationRunCandidateTarget(link: ConversationPlanLink, start: WorkPlanStartReceipt, row: AiView["rows"][number]): ConversationRunCandidateTarget | null {
  if (start.projectId !== link.projectId || start.planId !== link.planId || !row.savedRevisionId || !row.resultId || row.output === null) return null;
  return { projectId: link.projectId, conversationId: link.conversationId, planId: link.planId, planDigest: link.planDigest,
    actionId: start.actionId, generation: start.expectedGeneration, taskId: start.taskId, attemptId: start.attemptId,
    unitId: row.item.unitId, locale: row.item.targetLocale, sourceRevisionId: row.item.sourceRevisionId, sourceSnapshotId: row.item.sourceSnapshotId,
    itemId: row.itemId, resultId: row.resultId, revisionId: row.savedRevisionId };
}

/** Read the exact saved version before opening the existing candidate workflow. */
export async function resolveConversationRunCandidate(context: SessionRequest, target: ConversationRunCandidateTarget): Promise<TranslationRevision> {
  const captured = structuredClone(target);
  if (captured.projectId !== context.projectId) throw new Error("Conversation candidate belongs to another project");
  const revision = await translationCommands.revision({ ...context, unitId: captured.unitId, locale: captured.locale, revisionId: captured.revisionId });
  if (revision.originKind !== "ai" || revision.sourceRevisionId !== captured.sourceRevisionId || revision.sourceSnapshotId !== captured.sourceSnapshotId
    || revision.attemptId !== captured.attemptId || revision.itemId !== captured.itemId || revision.resultId !== captured.resultId || BigInt(revision.ordinal) < 1n)
    throw new Error("The saved candidate does not match this run result");
  return revision;
}
