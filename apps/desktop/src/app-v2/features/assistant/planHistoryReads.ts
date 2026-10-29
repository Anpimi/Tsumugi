import { conversationCommands } from "../../../conversationCommands";
import { executionCommands, type SessionRequest } from "../../../executionCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import { workPlanCommands, type WorkPlanHistoryBaseline, type WorkPlanHistoryPage, type WorkPlanHistoryRow } from "../../../workPlanCommands";
import type { ConversationPlanLink } from "./conversationRun";

function match(value: unknown): asserts value {
  if (!value) throw new Error("Conversation run history identity changed");
}

/** Check the immutable saved conversation association before observing a page. */
export async function readConversationRunHistory(context: SessionRequest, link: ConversationPlanLink,
  after = "0", baseline: WorkPlanHistoryBaseline | null = null): Promise<WorkPlanHistoryPage> {
  const fixed = structuredClone({ context, link, after, baseline });
  match(fixed.context.projectId === fixed.link.projectId);
  const recorded = await conversationCommands.readProposalWorkPlan({ ...fixed.context, conversationId: fixed.link.conversationId, planId: fixed.link.planId });
  match(jsonIdentity(recorded) === jsonIdentity(fixed.link));
  const page = await workPlanCommands.history({ ...fixed.context, planId: fixed.link.planId, after: fixed.after, baseline: fixed.baseline, limit: 16 });
  match(page.planDigest === fixed.link.planDigest && page.scope.length > 0 && page.scope.length <= 100
    && new Set(page.scope.map(unit => unit.unitId)).size === page.scope.length);
  for (const row of page.rows) {
    if (row.action.kind === "authorize") match(row.actionId === fixed.link.actionId);
    if (row.action.kind !== "team-recovery") continue;
    const action = row.action, target = action.work.target;
    match(target.locale === page.locale && page.scope.some(unit => unit.unitId === target.unitId
      && unit.sourceSnapshotId === target.sourceSnapshotId && unit.sourceRevisionId === target.sourceRevisionId));
    for (const member of action.members) match(member.unitIds.length > 0
      && member.unitIds.every(id => page.scope.some(unit => unit.unitId === id)));
    match(action.members.some(member => member.memberId === action.work.memberId && member.unitIds.includes(target.unitId)));
  }
  return page;
}

/** Revalidate the exact saved row before loading a bounded current observation
 * of its original attempt. Item progress is not a historical event total. */
export async function readConversationRunHistoryAttempt(context: SessionRequest, link: ConversationPlanLink,
  page: WorkPlanHistoryPage, row: WorkPlanHistoryRow, offset = 0) {
  const fixed = structuredClone({ context, link, page, row, offset });
  match(fixed.page.rows.some(value => jsonIdentity(value) === jsonIdentity(fixed.row)) && fixed.row.input && fixed.row.start);
  const original = await readConversationRunHistory(fixed.context, fixed.link,
    (BigInt(fixed.row.lease.generation) - 1n).toString(), fixed.page.baseline);
  match(original.rows.some(value => jsonIdentity(value) === jsonIdentity(fixed.row)));
  const input = fixed.row.input;
  const detail = await executionCommands.attempt({ ...fixed.context, attemptId: input.attemptId, offset: fixed.offset, limit: 16 });
  match(detail.taskId === input.taskId && detail.attemptId === input.attemptId && detail.recovery.attemptId === input.attemptId
    && detail.items.length <= 16 && detail.progress.adopted <= detail.progress.total
    && detail.progress.total === detail.progress.queued + detail.progress.running + detail.progress.succeeded
      + detail.progress.failed + detail.progress.unknown + detail.progress.cancelled
    && (detail.nextOffset === null ? fixed.offset + detail.items.length === detail.progress.total
      : detail.nextOffset === fixed.offset + detail.items.length && detail.nextOffset < detail.progress.total));
  return detail;
}
