import { validateResponseWorkPlanHistory } from "../generated/ai.validators";
import { validateResponseProposalWorkPlanLink } from "../generated/conversations.validators";
import type { WorkPlanHistoryPage, WorkPlanHistoryRow } from "../generated/ai.responses";
import { fixtureIdentity as id } from "./executionFixture";
import { teamContext } from "./teamDiscussionFixture";
import { teamExecutionStatusFixture } from "./teamExecutionFixture";

/** Synthetic original action records, with distinct attempts per recovery. */
export function workPlanHistoryFixture(total = 3) {
  const context = { ...teamContext }, status = teamExecutionStatusFixture(), plan = status.plan, members = plan.options.teamExecution?.members;
  const unit = plan.scope[0];
  if (!members?.length || !unit) throw new Error("Synthetic history needs a team and captured entry");
  const [translator, reviewer] = members;
  if (!translator || !reviewer) throw new Error("Synthetic history needs its two captured members");
  const capturedMembers: [typeof translator, typeof reviewer] = [translator, reviewer];
  const link = { projectId: context.projectId, conversationId: id(67001), proposalId: id(67002), revisionId: id(67003),
    planId: plan.planId, planDigest: plan.digest, actionId: id(67004), ordinal: "1" };
  if (!validateResponseProposalWorkPlanLink(link)) throw new Error("Invalid synthetic history link");
  const rootTask = id(67005), rows: WorkPlanHistoryRow[] = [];
  for (let generation = 1; generation <= total; generation++) {
    const lease = { planId: plan.planId, generation: String(generation) }, actionId = generation === 1 ? link.actionId : id(67100 + generation);
    if (generation % 2 === 0) {
      rows.push({ actionId, lease, state: "paused", cancellationRevision: String(generation / 2 - 1),
        action: { kind: "control", command: "pause", expectedGeneration: String(generation - 1), confirmed: false, expiresAt: null }, input: null, start: null });
      continue;
    }
    const input = { taskId: generation === 1 ? rootTask : id(67200 + generation), attemptId: id(67300 + generation), inputDigest: "c".repeat(64), parentTask: generation === 1 ? null : rootTask };
    rows.push({ actionId, lease, state: "active", cancellationRevision: String((generation - 1) / 2), input,
      start: { projectId: context.projectId, planId: plan.planId, actionId, expectedGeneration: String(generation), taskId: input.taskId, attemptId: input.attemptId },
      action: generation === 1 ? { kind: "authorize", digest: plan.digest, confirmed: true, effects: [...status.effects], expiresAt: status.expiresAt }
        : { kind: "team-recovery", digest: "b".repeat(64), confirmed: true, effects: [...status.effects],
          baseLease: { planId: plan.planId, generation: String(generation - 1) },
          baseEffectiveVersion: { actionId: generation === 3 ? link.actionId : id(67100 + generation - 2), lease: { planId: plan.planId, generation: String(generation - 2) }, digest: generation === 3 ? plan.digest : "b".repeat(64) },
          expiresAtMs: (BigInt(status.expiresAt) * 1000n).toString(), members: structuredClone(capturedMembers),
          work: { workId: id(67400 + generation), memberId: members[0].memberId, kind: "translation", instructions: `Original recovery instruction ${generation}`,
            target: { unitId: unit.unitId, locale: plan.locale, sourceSnapshotId: unit.sourceSnapshotId, sourceRevisionId: unit.sourceRevisionId }, postIds: [], priorWork: [] } },
    });
  }
  status.lease.generation = String(total); status.state = total % 2 ? "active" : "paused";
  const page = { projectId: context.projectId, planId: plan.planId, planDigest: plan.digest, locale: plan.locale,
    scope: structuredClone(plan.scope), baseline: { lease: structuredClone(status.lease), lastStart: [...rows].reverse().find(row => row.start)?.start ?? null }, rows, nextAfter: null };
  const first = historyPageAfter(page, "0");
  return { context, status, link, page, first };
}

export function historyPageAfter(original: Omit<WorkPlanHistoryPage, "rows" | "scope"> & {
  rows: WorkPlanHistoryRow[]; scope: WorkPlanHistoryPage["scope"][number][];
}, after: string, limit = 16): WorkPlanHistoryPage {
  const remaining = original.rows.filter(row => BigInt(row.lease.generation) > BigInt(after)), rows = remaining.slice(0, limit);
  const page: unknown = { ...structuredClone(original), rows: structuredClone(rows), nextAfter: remaining.length > limit ? rows.at(-1)?.lease.generation ?? null : null };
  if (!validateResponseWorkPlanHistory(page)) throw new Error("Invalid synthetic history page");
  return page;
}

export function historyRowAt(page: { rows: WorkPlanHistoryRow[] }, index: number): WorkPlanHistoryRow {
  const row = page.rows[index]; if (!row) throw new Error("Missing synthetic history row"); return row;
}
