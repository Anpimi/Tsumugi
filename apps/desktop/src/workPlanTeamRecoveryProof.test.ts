import { beforeEach, describe, expect, it, vi } from "vitest";
import { workPlanCommands } from "./workPlanCommands";
import type { WorkPlanTeamRecoverySettlementRequest } from "./generated/ai.requests";
import { teamRecoveryFixture, teamRecoveryPreviewFixture, teamRecoveryReceiptFixture } from "./testSupport/teamRecoveryFixture";
import { validateRequestWorkPlanTeamRecoveryPrepare } from "./generated/ai.validators";
import { teamContext } from "./testSupport/teamDiscussionFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });
function fixture() {
  const source = teamRecoveryFixture();
  const pausedLease = { ...source.status.lease, generation: String(BigInt(source.view.effectiveVersion.lease.generation) + 1n) };
  source.status.lease = structuredClone(pausedLease); source.state.state.lease = structuredClone(pausedLease);
  const unit = source.status.plan.scope[0], member = source.view.roster[0];
  const request = { ...teamContext, preparationId: id(67900), recovery: {
    projectId: teamContext.projectId, planId: source.status.plan.planId, expectedLease: structuredClone(source.state.state.lease),
    expectedEffectiveVersion: structuredClone(source.view.effectiveVersion), members: structuredClone(source.view.roster),
    work: { workId: id(67901), memberId: member.memberId, kind: member.kinds[0], instructions: "Original human A é {{text}} 中文",
      postIds: [], priorWork: [], target: { unitId: unit.unitId, locale: source.status.plan.locale, sourceSnapshotId: unit.sourceSnapshotId, sourceRevisionId: unit.sourceRevisionId } } } };
  if (!validateRequestWorkPlanTeamRecoveryPrepare(request)) throw new Error("Invalid synthetic original recovery request");
  const preview = teamRecoveryPreviewFixture(request, source);
  const authorization: WorkPlanTeamRecoverySettlementRequest = { ...teamContext, preparationId: request.preparationId, planId: request.recovery.planId,
    baseLease: request.recovery.expectedLease, recovery: { actionId: id(67902), digest: preview.preview.digest, effects: source.status.effects, confirmed: true },
    checkerExecutions: [], toolExecution: false, applicationToolExecutions: [] };
  const receipt = teamRecoveryReceiptFixture(authorization, preview);
  const { sessionToken: _prepareToken, ...prepareOriginal } = request;
  const { sessionToken: _authorizeToken, ...authorizationOriginal } = authorization;
  return { request, preview, authorization, receipt, prepareOriginal, authorizationOriginal };
}
describe("original team recovery proof bridges", () => {
  it("checks the exact preparation echo and rejects a fence without both advancement and drain", async () => {
    const f = fixture(), value = { request: f.prepareOriginal, lease: f.request.recovery.expectedLease, state: "paused", hostCallbacksDrained: true, outcome: { kind: "closed" } };
    invoke.mockResolvedValue(value); await expect(workPlanCommands.closeTeamRecoveryPreparation(f.request)).resolves.toEqual(value);
    expect(invoke).toHaveBeenCalledWith("close_work_plan_team_recovery_preparation", { request: f.request });
    invoke.mockResolvedValue({ ...value, request: { ...f.prepareOriginal, preparationId: id(67903) } });
    await expect(workPlanCommands.readTeamRecoveryPreparation(f.request)).rejects.toBeDefined();
    invoke.mockResolvedValue({ ...value, outcome: { kind: "fenced-not-applied" } });
    await expect(workPlanCommands.readTeamRecoveryPreparation(f.request)).rejects.toBeDefined();
    invoke.mockResolvedValue({ ...value, lease: { ...value.lease, generation: String(BigInt(value.lease.generation) + 1n) }, hostCallbacksDrained: false, outcome: { kind: "fenced-not-applied" } });
    await expect(workPlanCommands.readTeamRecoveryPreparation(f.request)).rejects.toBeDefined();
  });
  it("uses exact decimal generations above the safe integer range and never treats null as proof", async () => {
    const f = fixture(); f.authorization.baseLease.generation = "9007199254740993";
    const { sessionToken: _token, ...original } = f.authorization;
    const value = { request: original, settlement: { projectId: original.projectId, planId: original.planId,
      lease: { ...original.baseLease, generation: "9007199254740994" }, state: "taken-over", outcome: { kind: "fenced-not-applied" } } };
    invoke.mockResolvedValue(value); await expect(workPlanCommands.teamRecoverySettlement(f.authorization)).resolves.toEqual(value);
    invoke.mockResolvedValue({ ...value, settlement: { ...value.settlement, lease: original.baseLease } });
    await expect(workPlanCommands.teamRecoverySettlement(f.authorization)).rejects.toBeDefined();
    invoke.mockResolvedValue(null); await expect(workPlanCommands.teamRecoverySettlement(f.authorization)).rejects.toBeDefined();
  });
  it("accepts an exact recorded authorization and rejects changed effects, digest or base lease", async () => {
    const f = fixture(), value = { request: f.authorizationOriginal, settlement: { projectId: f.authorization.projectId, planId: f.authorization.planId,
      lease: f.receipt.effectiveVersion.lease, state: "active", outcome: { kind: "recorded", receipt: f.receipt } } };
    invoke.mockResolvedValue(value); await expect(workPlanCommands.teamRecoverySettlement(f.authorization)).resolves.toEqual(value);
    invoke.mockResolvedValue({ ...value, request: { ...value.request, recovery: { ...value.request.recovery, effects: [] } } });
    await expect(workPlanCommands.teamRecoverySettlement(f.authorization)).rejects.toBeDefined();
    invoke.mockResolvedValue({ ...value, settlement: { ...value.settlement, outcome: { kind: "recorded", receipt: { ...f.receipt,
      effectiveVersion: { ...f.receipt.effectiveVersion, digest: "a".repeat(64) } } } } });
    await expect(workPlanCommands.teamRecoverySettlement(f.authorization)).rejects.toBeDefined();
    invoke.mockResolvedValue({ ...value, settlement: { ...value.settlement, outcome: { kind: "recorded", receipt: { ...f.receipt,
      baseLease: { ...f.receipt.baseLease, generation: "1" } } } } });
    await expect(workPlanCommands.teamRecoverySettlement(f.authorization)).rejects.toBeDefined();
  });
  it("freezes the original request while a transport read is waiting", async () => {
    const f = fixture(); let release!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const original = structuredClone(f.authorizationOriginal), request = structuredClone(f.authorization);
    const reading = workPlanCommands.teamRecoverySettlement(request);
    request.preparationId = id(67904); request.recovery.digest = "b".repeat(64); request.recovery.effects = [];
    release({ request: original, settlement: { projectId: original.projectId, planId: original.planId, lease: original.baseLease, state: "paused", outcome: { kind: "pending" } } });
    await expect(reading).resolves.toMatchObject({ request: original });
    expect(invoke.mock.calls[0][1].request.preparationId).toBe(original.preparationId);
  });
});
