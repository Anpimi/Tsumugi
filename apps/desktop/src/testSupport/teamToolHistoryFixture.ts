import type { WorkPlanTeamWorkToolsRequest } from "../generated/ai.requests";
import type { TeamWorkToolHistory } from "../generated/ai.responses";
import { teamExecutionStatusFixture } from "./teamExecutionFixture";
import { fixtureIdentity } from "./executionFixture";

/** Historical execution facts only; no SDK, live scope or tool output is created. */
export function teamToolHistoryFixture(request: Pick<WorkPlanTeamWorkToolsRequest, "projectId" | "planId" | "work" | "after">, outcome: "stored" | "unknown" = "stored"): TeamWorkToolHistory {
  const next = request.after != null, known = outcome === "stored", unitId = teamExecutionStatusFixture().plan.scope[0].unitId;
  return { projectId: request.projectId, planId: request.planId, work: structuredClone(request.work), nextAfter: null, attempts: [{
    sequence: request.after == null ? "7" : (BigInt(request.after) + 1n).toString(),
    reference: { taskId: fixtureIdentity(next ? 10410 : 10400), attemptId: fixtureIdentity(next ? 10411 : 10401), inputDigest: "a".repeat(64) },
    toolHandle: fixtureIdentity(10402), name: "Captured glossary query 中文", unitIds: [unitId], storedResultItems: known ? 1 : 0,
    progress: { total: 1, succeeded: known ? 1 : 0, failed: 0, unknown: known ? 0 : 1, running: 0, queued: 0, cancelled: 0, adopted: 0 },
  }] };
}
