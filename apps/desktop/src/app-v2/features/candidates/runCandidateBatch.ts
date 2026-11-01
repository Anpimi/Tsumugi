import type { AiView } from "../../../aiCommands";
import type { SessionRequest } from "../../../executionCommands";
import type { WorkPlanStartReceipt } from "../../../generated/ai.responses";
import { jsonIdentity } from "../../../pluginToolChoices";
import type { WorkPlanView } from "../../../workPlanCommands";
import type { ConversationPlanLink } from "../assistant/conversationRun";
import { conversationRunCandidateTarget, readConversationRunResults, type ConversationRunCandidateTarget } from "../assistant/conversationRunResultReads";
import type { ExactCandidateBatchScope } from "./candidateBatchTargets";

export interface RunCandidateBatchTarget {
  link: ConversationPlanLink; plan: WorkPlanView; start: WorkPlanStartReceipt;
  candidates: readonly ConversationRunCandidateTarget[];
}
export type OpenRunCandidateBatch = (target: RunCandidateBatchTarget, current: () => boolean) => Promise<boolean>;

/** Capture only the saved candidates represented by this card, never later results. */
export function runCandidateBatchTarget(link: ConversationPlanLink, plan: WorkPlanView, start: WorkPlanStartReceipt, rows: AiView["rows"]): RunCandidateBatchTarget | null {
  const candidates = rows.flatMap(row => { const target = conversationRunCandidateTarget(link, start, row); return target ? [target] : []; });
  return candidates.length ? structuredClone({ link, plan, start, candidates }) : null;
}

/** Re-read the original run association before the shared batch owner reads its versions. */
export async function resolveRunCandidateBatch(context: SessionRequest, target: RunCandidateBatchTarget, current: () => boolean,
  read = readConversationRunResults,
): Promise<ExactCandidateBatchScope | null> {
  const fixed = structuredClone(target), first = fixed.candidates[0];
  if (!current() || !first || fixed.candidates.length > 100 || context.projectId !== fixed.link.projectId
    || new Set(fixed.candidates.map(value => value.unitId)).size !== fixed.candidates.length
    || fixed.candidates.some(value => value.projectId !== context.projectId || value.conversationId !== fixed.link.conversationId
      || value.planId !== fixed.link.planId || value.planDigest !== fixed.link.planDigest || value.actionId !== fixed.start.actionId
      || value.generation !== fixed.start.expectedGeneration || value.taskId !== fixed.start.taskId || value.attemptId !== fixed.start.attemptId
      || value.locale !== first.locale || value.sourceSnapshotId !== first.sourceSnapshotId)) return null;
  const observed = await read(context, fixed.link, fixed.plan, fixed.start);
  if (!current()) return null;
  const originals = observed.rows.flatMap(row => { const value = conversationRunCandidateTarget(fixed.link, fixed.start, row); return value ? [value] : []; });
  if (fixed.candidates.some(value => !originals.some(original => jsonIdentity(original) === jsonIdentity(value)))) return null;
  return { projectId: context.projectId, locale: first.locale, sourceSnapshotId: first.sourceSnapshotId,
    candidates: fixed.candidates.map(({ unitId, locale, sourceSnapshotId, sourceRevisionId, revisionId, attemptId, itemId, resultId }) =>
      ({ unitId, locale, sourceSnapshotId, sourceRevisionId, revisionId, attemptId, itemId, resultId })) };
}
