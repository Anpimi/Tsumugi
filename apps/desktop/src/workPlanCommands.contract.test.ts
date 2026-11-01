import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/workPlanCommands.contract.json";
import { workPlanCommands, type MaintenanceAssessment, type MaintenancePlanBasis } from "./workPlanCommands";
import * as validators from "./generated/ai.validators";
import type { Requests, WorkPlanControlRequest } from "./generated/ai.requests";
import { hasUnknownOutcome } from "./projectCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { WorkPlanStartSettlementView, WorkPlanControlSettlementView } from "./generated/ai.responses";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });

it("reads a start using the complete authorization identity without starting work", async () => {
  const request = fixture.requests.start;
  const receipt = {projectId:request.projectId,planId:request.planId,actionId:request.actionId,
    expectedGeneration:request.expectedGeneration,attemptId:fixtureIdentity(701),taskId:fixtureIdentity(702)};
  expect(validators.validateResponseWorkPlanStartAction(receipt)).toBe(true);
  invoke.mockResolvedValueOnce(receipt);
  expect(await workPlanCommands.startAction(request)).toEqual(receipt);
  expect(invoke).toHaveBeenLastCalledWith("read_work_plan_start_action",{request});
  invoke.mockResolvedValueOnce(null);
  expect(await workPlanCommands.startAction(request)).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("rejects malformed or differently bound start receipts rather than treating them as absent", async () => {
  const request = fixture.requests.start;
  const receipt = {projectId:request.projectId,planId:request.planId,actionId:request.actionId,
    expectedGeneration:request.expectedGeneration,attemptId:fixtureIdentity(701),taskId:fixtureIdentity(702)};
  for (const wrong of [undefined,{}, {...receipt,projectId:fixtureIdentity(703)}, {...receipt,planId:fixtureIdentity(704)},
    {...receipt,actionId:fixtureIdentity(705)}, {...receipt,expectedGeneration:"2"}, {...receipt,taskId:null},
    {...receipt,attemptId:null}, {...receipt,extra:true}]) {
    invoke.mockResolvedValueOnce(wrong);
    await expect(workPlanCommands.startAction(request)).rejects.toThrow();
  }
  expect(invoke.mock.calls.every(([command])=>command==="read_work_plan_start_action")).toBe(true);
});

describe("pure work-plan request settlement", () => {
  type StartRequest = Parameters<typeof workPlanCommands.startSettlement>[0];
  type Outcome = "recorded" | "pending" | "fenced-not-applied";
  const startRequest = (): StartRequest => ({ ...fixture.requests.start, expectedGeneration: "9007199254740993", expectedAttemptId: fixtureIdentity(710) });
  const controlRequest = (): WorkPlanControlRequest => ({ ...fixture.requests.control, command: "continue", confirmed: true,
    expectedGeneration: "9007199254740993", expiresAt: "18446744073709551615", toolExecution: true,
    checkerExecutions: [{ profile: { id: "example.text-review", schemaVersion: 1, behaviorVersion: 1 },
      provider: { plugin: { publisher: "example", id: "text-review", version: "0.1.0" }, packageDigest: "c".repeat(64), componentId: "worker", contributionId: "text-review-check" } }],
    applicationToolExecutions: [{ instanceId: fixtureIdentity(711), activationGeneration: 2 }] });
  function startProof(request: StartRequest, kind: Outcome): WorkPlanStartSettlementView {
    const { sessionToken: _token, ...original } = request;
    const value: unknown = { request: original, settlement: { projectId: request.projectId, planId: request.planId,
      lease: { planId: request.planId, generation: kind === "pending" ? request.expectedGeneration : "9007199254740996" }, state: "stopped",
      outcome: kind === "recorded" ? { kind, receipt: { projectId: request.projectId, planId: request.planId,
        actionId: request.actionId, expectedGeneration: request.expectedGeneration, attemptId: request.expectedAttemptId, taskId: fixtureIdentity(712) } } : { kind } } };
    if (!validators.validateResponseWorkPlanStartSettlement(value)) throw new Error("Invalid synthetic start settlement"); return value;
  }
  function controlProof(request: WorkPlanControlRequest, kind: Outcome): WorkPlanControlSettlementView {
    const { sessionToken: _token, ...original } = structuredClone(request);
    const value: unknown = { request: original, settlement: { projectId: request.projectId, planId: request.planId,
      lease: { planId: request.planId, generation: kind === "pending" ? request.expectedGeneration : "9007199254740996" }, state: "stopped",
      outcome: kind === "recorded" ? { kind, receipt: { actionId: request.actionId,
        lease: { planId: request.planId, generation: String(BigInt(request.expectedGeneration) + 1n) },
        state: { pause: "paused", stop: "stopped", "take-over": "taken-over", continue: "active" }[request.command],
        attemptId: request.command === "continue" ? fixtureIdentity(713) : null, parentTask: null } } : { kind } } };
    if (!validators.validateResponseWorkPlanControlSettlement(value)) throw new Error("Invalid synthetic control settlement"); return value;
  }

  it.each(["recorded", "pending", "fenced-not-applied"] as const)("reads the exact %s historical settlement without dispatching or granting current authority", async kind => {
    const start = startRequest(), control = controlRequest(), started = startProof(start, kind), controlled = controlProof(control, kind);
    expect(validators.validateRequestWorkPlanStartSettlement(start)).toBe(true);
    expect(validators.validateRequestWorkPlanControlSettlement(control)).toBe(true);
    invoke.mockResolvedValueOnce(started).mockResolvedValueOnce(controlled);
    expect(await workPlanCommands.startSettlement(start)).toEqual(started);
    expect(await workPlanCommands.controlSettlement(control)).toEqual(controlled);
    expect(invoke.mock.calls).toEqual([["read_work_plan_start_settlement", { request: start }], ["read_work_plan_control_settlement", { request: control }]]);
    if (kind === "recorded") {
      expect(started.settlement.lease.generation).toBe("9007199254740996");
      expect(controlled.settlement.state).toBe("stopped");
      expect(controlled.settlement.outcome).toMatchObject({ kind: "recorded", receipt: { state: "active", lease: { generation: "9007199254740994" } } });
    }
  });

  it("captures the original start identity and every Host choice before awaiting a settlement", async () => {
    const start = startRequest(), control = controlRequest(), originalStart = structuredClone(start), originalControl = structuredClone(control);
    const starts = startProof(start, "recorded"), controls = controlProof(control, "recorded");
    let answerStart!: (value: unknown) => void, answerControl!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { answerStart = resolve; })).mockImplementationOnce(() => new Promise(resolve => { answerControl = resolve; }));
    const readingStart = workPlanCommands.startSettlement(start), readingControl = workPlanCommands.controlSettlement(control);
    start.expectedAttemptId = fixtureIdentity(714); start.actionId = fixtureIdentity(715); start.sessionToken = "changed-session";
    control.checkerExecutions[0].provider.packageDigest = "d".repeat(64); control.applicationToolExecutions[0].activationGeneration = 3;
    control.command = "pause"; control.toolExecution = false; control.confirmed = false; control.expiresAt = "1";
    answerStart(starts); answerControl(controls);
    expect(await readingStart).toEqual(starts); expect(await readingControl).toEqual(controls);
    expect(invoke.mock.calls).toEqual([["read_work_plan_start_settlement", { request: originalStart }], ["read_work_plan_control_settlement", { request: originalControl }]]);
  });

  it("rejects differently bound requests, snapshots and recorded start identities", async () => {
    const request = startRequest(), proof = startProof(request, "recorded");
    if (proof.settlement.outcome.kind !== "recorded") throw new Error("Missing synthetic recorded start");
    const receipt = proof.settlement.outcome.receipt;
    const invalid = [
      { ...proof, request: { ...proof.request, expectedAttemptId: fixtureIdentity(714) } },
      { ...proof, request: { ...proof.request, actionId: fixtureIdentity(715) } },
      { ...proof, settlement: { ...proof.settlement, projectId: fixtureIdentity(716) } },
      { ...proof, settlement: { ...proof.settlement, planId: fixtureIdentity(717) } },
      { ...proof, settlement: { ...proof.settlement, lease: { ...proof.settlement.lease, planId: fixtureIdentity(717) } } },
      ...[{ ...receipt, attemptId: fixtureIdentity(714) }, { ...receipt, actionId: fixtureIdentity(715) },
        { ...receipt, projectId: fixtureIdentity(716) }, { ...receipt, planId: fixtureIdentity(717) },
        { ...receipt, expectedGeneration: "9007199254740992" }].map(receipt => ({ ...proof, settlement: { ...proof.settlement, outcome: { kind: "recorded", receipt } } })),
    ];
    for (const value of invalid) {
      invoke.mockResolvedValueOnce(value); await expect(workPlanCommands.startSettlement(request)).rejects.toThrow();
    }
    expect(invoke.mock.calls.every(([command]) => command === "read_work_plan_start_settlement")).toBe(true);
  });

  it("binds complete control choices and the recorded transition without confusing a later snapshot with its receipt", async () => {
    const request = controlRequest(), proof = controlProof(request, "recorded");
    if (proof.settlement.outcome.kind !== "recorded") throw new Error("Missing synthetic recorded control");
    const receipt = proof.settlement.outcome.receipt;
    const invalid = [
      ...[{ ...proof.request, checkerExecutions: [] }, { ...proof.request, applicationToolExecutions: [] },
        { ...proof.request, toolExecution: false }, { ...proof.request, confirmed: false }, { ...proof.request, expiresAt: "1" },
        { ...proof.request, command: "pause" }, { ...proof.request, expectedGeneration: "9007199254740992" }].map(original => ({ ...proof, request: original })),
      ...[{ ...receipt, actionId: fixtureIdentity(715) }, { ...receipt, lease: { ...receipt.lease, planId: fixtureIdentity(717) } },
        { ...receipt, lease: { ...receipt.lease, generation: "9007199254740995" } }, { ...receipt, state: "paused" },
        { ...receipt, attemptId: null }].map(receipt => ({ ...proof, settlement: { ...proof.settlement, outcome: { kind: "recorded", receipt } } })),
      { ...proof, settlement: { ...proof.settlement, lease: { ...proof.settlement.lease, generation: request.expectedGeneration } } },
    ];
    for (const value of invalid) {
      invoke.mockResolvedValueOnce(value); await expect(workPlanCommands.controlSettlement(request)).rejects.toThrow();
    }
    expect(invoke.mock.calls.every(([command]) => command === "read_work_plan_control_settlement")).toBe(true);
  });

  it("requires an advancing generation for a fence and generated wire structure for all outcomes", async () => {
    const start = startRequest(), control = controlRequest();
    for (const [request, proof, call] of [[start, startProof(start, "fenced-not-applied"), () => workPlanCommands.startSettlement(start)],
      [control, controlProof(control, "fenced-not-applied"), () => workPlanCommands.controlSettlement(control)]] as const) {
      const invalid = [
        { ...proof, settlement: { ...proof.settlement, lease: { ...proof.settlement.lease, generation: request.expectedGeneration } } },
        { ...proof, settlement: { ...proof.settlement, lease: { ...proof.settlement.lease, generation: "0" } } },
        { ...proof, request: { ...proof.request, sessionToken: "not-response-material" } },
        { ...proof, settlement: { ...proof.settlement, outcome: { kind: "pending", receipt: {} } } },
        { ...proof, settlement: { ...proof.settlement, outcome: { kind: "absent" } } },
      ];
      for (const value of invalid) { invoke.mockResolvedValueOnce(value); await expect(call()).rejects.toThrow(); }
    }
    const malformedStart = { ...start, expectedGeneration: "01", unexpected: true }, malformedControl = { ...control, unexpected: true };
    const calls = invoke.mock.calls.length;
    await expect(workPlanCommands.startSettlement(malformedStart)).rejects.toThrow();
    await expect(workPlanCommands.controlSettlement(malformedControl)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(calls);
  });
});
const requests: Pick<Requests, "workPlanPrepare" | "workPlanAuthorize" | "workPlanStart" | "workPlanControl" | "workPlanStatus" | "workPlanAction" | "workProtectionRead" | "workProtectionSet"> = {
  workPlanPrepare: { ...fixture.requests.prepare, options: {
    ...fixture.requests.prepare.options,
    stages: [{ stage: "generation", mode: "assisted" }], selectionPolicy: "candidates-only",
  } },
  workPlanAuthorize: { ...fixture.requests.authorize, effects: ["save-candidate"] },
  workPlanStart: fixture.requests.start,
  workPlanControl: { ...fixture.requests.control, command: "pause" },
  workPlanStatus: fixture.requests.status,
  workPlanAction: fixture.requests.action,
  workProtectionRead: fixture.requests.protectionRead,
  workProtectionSet: fixture.requests.protectionSet,
};
it("uses generated contracts and preserves scoped commands", async () => {
  for (const [validate, value] of [
    [validators.validateRequestWorkPlanPrepare, requests.workPlanPrepare],
    [validators.validateRequestWorkPlanAuthorize, requests.workPlanAuthorize],
    [validators.validateRequestWorkPlanStart, requests.workPlanStart],
    [validators.validateRequestWorkPlanControl, requests.workPlanControl],
    [validators.validateRequestWorkPlanStatus, requests.workPlanStatus],
    [validators.validateRequestWorkPlanAction, requests.workPlanAction],
    [validators.validateRequestWorkProtectionRead, requests.workProtectionRead],
    [validators.validateRequestWorkProtectionSet, requests.workProtectionSet],
    [validators.validateResponseWorkPlan, fixture.responses.plan],
    [validators.validateResponseWorkPlanReceipt, fixture.responses.receipt],
    [validators.validateResponseWorkPlanReceipt, fixture.responses.control],
    [validators.validateResponseWorkPlanStatus, fixture.responses.status],
    [validators.validateResponseWorkPlanAction, fixture.responses.action],
    [validators.validateResponseWorkPlanAction, null],
    [validators.validateResponseWorkProtection, fixture.responses.protection],
    [validators.validateResponseWorkProtectionRecovery, fixture.responses.protectionRecovery],
  ] as const) expect(validate(value), validate.name).toBe(true);
  for (const [command, request, response, call] of [
    ["prepare_work_plan", requests.workPlanPrepare, fixture.responses.plan, () => workPlanCommands.prepare(requests.workPlanPrepare)],
    ["authorize_work_plan", requests.workPlanAuthorize, fixture.responses.receipt, () => workPlanCommands.authorize(requests.workPlanAuthorize)],
    ["start_work_plan", requests.workPlanStart, fixture.responses.plan.attemptId, () => workPlanCommands.start(requests.workPlanStart, fixture.responses.plan.attemptId)],
    ["control_work_plan", requests.workPlanControl, fixture.responses.control, () => workPlanCommands.control(requests.workPlanControl)],
    ["read_work_plan_status", requests.workPlanStatus, fixture.responses.status, () => workPlanCommands.status(requests.workPlanStatus)],
    ["read_work_plan_action", requests.workPlanAction, fixture.responses.action, () => workPlanCommands.action(requests.workPlanAction)],
    ["read_work_protection", requests.workProtectionRead, fixture.responses.protection, () => workPlanCommands.protection(requests.workProtectionRead)],
    ["set_work_protection", requests.workProtectionSet, fixture.responses.protection, () => workPlanCommands.setProtection(requests.workProtectionSet)],
    ["recover_work_protection", requests.workProtectionSet, fixture.responses.protectionRecovery, () => workPlanCommands.recoverProtection(requests.workProtectionSet)],
  ] as const) {
    invoke.mockResolvedValueOnce(response);
    expect(await call()).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith(command, { request });
  }
});

it("checks every original protection field and receipt without treating malformed recovery as absence", async () => {
  const request = requests.workProtectionSet, response = fixture.responses.protectionRecovery;
  for (const outcome of [{ kind: "pending" }, { kind: "mismatch" }]) {
    invoke.mockResolvedValueOnce({ request: response.request, outcome });
    expect((await workPlanCommands.recoverProtection(request)).outcome).toEqual(outcome);
  }
  const alteredRequests = [
    { ...response.request, projectId: fixtureIdentity(1801) },
    { ...response.request, actionId: fixtureIdentity(1802) },
    { ...response.request, unitId: fixtureIdentity(1803) },
    { ...response.request, locale: "fr-FR" },
    { ...response.request, sourceRevisionId: fixtureIdentity(1804) },
    { ...response.request, selectionId: fixtureIdentity(1805) },
    { ...response.request, expectedRevision: "9007199254740994" },
    { ...response.request, protected: true },
    { ...response.request, confirmedRelease: false },
  ];
  for (const original of alteredRequests) {
    invoke.mockResolvedValueOnce({ ...response, request: original });
    await expect(workPlanCommands.recoverProtection(request)).rejects.toMatchObject({ outcome: "unknown" });
  }
  for (const wrong of [null, undefined, {}, { ...response, outcome: { kind: "pending", receipt: response.outcome.receipt } },
    { ...response, outcome: { kind: "mismatch", extra: true } }, { ...response, request: { ...response.request, sessionToken: request.sessionToken } },
    ...[{ unitId: fixtureIdentity(1806) }, { locale: "fr-FR" }, { revision: "9007199254740995" }, { protected: true }]
      .map(change => ({ ...response, outcome: { kind: "recorded", receipt: { ...response.outcome.receipt, ...change } } }))]) {
    invoke.mockResolvedValueOnce(wrong);
    await expect(workPlanCommands.recoverProtection(request)).rejects.toThrow();
  }
  expect(invoke.mock.calls.every(([name]) => name === "recover_work_protection")).toBe(true);
});

it("keeps generations exact and rejects unsupported semantic or raw input fields", () => {
  expect(fixture.responses.control.lease.generation).toBe("9007199254740994");
  for (const generation of [9007199254740993, "01", "-1", "9223372036854775808"])
    expect(validators.validateRequestWorkPlanControl({ ...requests.workPlanControl, expectedGeneration: generation })).toBe(false);
  expect(validators.validateRequestWorkPlanAuthorize({ ...requests.workPlanAuthorize, answer: "yes" })).toBe(false);
  expect(validators.validateRequestWorkPlanStart({ ...requests.workPlanStart, input: {} })).toBe(false);
  expect(validators.validateResponseWorkPlanStatus({ ...fixture.responses.status, expiresAt: 9007199254740993 })).toBe(false);
  expect(validators.validateResponseWorkPlan({ ...fixture.responses.plan, rawInput: {} })).toBe(false);
  const { applicationToolExecutions: _authorizeInstances, ...missingAuthorizeInstances } = requests.workPlanAuthorize;
  const { applicationToolExecutions: _controlInstances, ...missingControlInstances } = requests.workPlanControl;
  expect(validators.validateRequestWorkPlanAuthorize(missingAuthorizeInstances)).toBe(false);
  expect(validators.validateRequestWorkPlanControl(missingControlInstances)).toBe(false);
});

it("binds discussion opt-in and its disclosure to the exact prepared plan", async () => {
  const request = { ...requests.workPlanPrepare, options: {
    ...requests.workPlanPrepare.options, teamDiscussions: { profile: "current-plan-1" as const },
  } };
  const response = { ...fixture.responses.discussionPlan, options: request.options };
  expect(validators.validateRequestWorkPlanPrepare(request)).toBe(true);
  expect(validators.validateResponseWorkPlan(response)).toBe(true);
  invoke.mockResolvedValueOnce(response);
  expect(await workPlanCommands.prepare(request)).toEqual(response);
  expect(invoke).toHaveBeenLastCalledWith("prepare_work_plan", { request });
  const withoutLimits = { ...response, teamDiscussionLimits: undefined };
  const artifactCapOnV1 = { ...response, teamDiscussionLimits: fixture.responses.artifactDiscussionPlan.teamDiscussionLimits };
  for (const wrong of [fixture.responses.plan, withoutLimits, artifactCapOnV1]) {
    invoke.mockResolvedValueOnce(wrong);
    await expect(workPlanCommands.prepare(request)).rejects.toMatchObject({ reason: "invalid-work-plan-acknowledgement", outcome: "unknown" });
  }
  invoke.mockResolvedValueOnce(response);
  await expect(workPlanCommands.prepare(requests.workPlanPrepare)).rejects.toMatchObject({ reason: "invalid-work-plan-acknowledgement", outcome: "unknown" });
  expect(validators.validateRequestWorkPlanPrepare({ ...request, options: { ...request.options, teamDiscussions: { profile: "other-plan" } } })).toBe(false);
  expect(validators.validateRequestWorkPlanPrepare({ ...request, options: { ...request.options, teamDiscussions: { profile: "current-plan-1", maxPosts: 900 } } })).toBe(false);
  invoke.mockResolvedValueOnce({ ...fixture.responses.status, plan: withoutLimits });
  await expect(workPlanCommands.status(requests.workPlanStatus)).rejects.toMatchObject({ reason: "invalid-work-plan-acknowledgement", outcome: "unknown" });
  invoke.mockResolvedValueOnce({ ...fixture.responses.status, plan: artifactCapOnV1 });
  await expect(workPlanCommands.status(requests.workPlanStatus)).rejects.toMatchObject({ reason: "invalid-work-plan-acknowledgement", outcome: "unknown" });
});

it("binds referenced text disclosure to v2 without upgrading a v1 acknowledgement", async () => {
  const request = { ...requests.workPlanPrepare, options: {
    ...requests.workPlanPrepare.options, teamDiscussions: { profile: "current-plan-2" as const },
  } };
  const response = { ...fixture.responses.artifactDiscussionPlan, options: request.options };
  expect(validators.validateRequestWorkPlanPrepare(request)).toBe(true);
  expect(validators.validateResponseWorkPlan(response)).toBe(true);
  invoke.mockResolvedValueOnce(response);
  expect(await workPlanCommands.prepare(request)).toEqual(response);
  const withoutArtifactCap = { ...response, teamDiscussionLimits: fixture.responses.discussionPlan.teamDiscussionLimits };
  for (const wrong of [fixture.responses.discussionPlan, withoutArtifactCap]) {
    invoke.mockResolvedValueOnce(wrong);
    await expect(workPlanCommands.prepare(request)).rejects.toMatchObject({ reason: "invalid-work-plan-acknowledgement", outcome: "unknown" });
  }
  invoke.mockResolvedValueOnce({ ...fixture.responses.status, plan: response });
  expect((await workPlanCommands.status(requests.workPlanStatus)).plan).toEqual(response);
  invoke.mockResolvedValueOnce({ ...fixture.responses.status, plan: withoutArtifactCap });
  await expect(workPlanCommands.status(requests.workPlanStatus)).rejects.toMatchObject({ reason: "invalid-work-plan-acknowledgement", outcome: "unknown" });
  expect(validators.validateRequestWorkPlanPrepare({ ...request, options: { ...request.options, teamDiscussions: { profile: "current-plan-2", shareArtifacts: true } } })).toBe(false);
  const { maxArtifactBytes: _cap, ...missingCap } = response.teamDiscussionLimits;
  expect(validators.validateResponseWorkPlan({ ...response, teamDiscussionLimits: missingCap })).toBe(false);
});

it("rejects duplicate or mixed-generation instance consent and keeps revoking controls free of lifetime grants", async () => {
  const basis = { instanceId: fixtureIdentity(1800), activationGeneration: 1 };
  for (const applicationToolExecutions of [[basis, basis], [basis, { ...basis, activationGeneration: 2 }]]) {
    await expect(workPlanCommands.authorize({ ...requests.workPlanAuthorize, applicationToolExecutions })).rejects.toThrow("authorization request");
    await expect(workPlanCommands.control({ ...requests.workPlanControl, command: "continue", applicationToolExecutions })).rejects.toThrow("control request");
  }
  for (const command of ["pause", "stop", "take-over"] as const)
    await expect(workPlanCommands.control({ ...requests.workPlanControl, command, applicationToolExecutions: [basis] })).rejects.toThrow("control request");
  expect(invoke).not.toHaveBeenCalled();
});

it("binds acknowledgements to action, generation, scope, options and attempt", async () => {
  for (const response of [
    { ...fixture.responses.receipt, actionId: fixture.responses.plan.planId },
    { ...fixture.responses.receipt, lease: { ...fixture.responses.receipt.lease, generation: "2" } },
    { ...fixture.responses.receipt, attemptId: undefined },
  ]) {
    invoke.mockResolvedValueOnce(response);
    const error = await workPlanCommands.authorize(requests.workPlanAuthorize).catch(error => error);
    expect(hasUnknownOutcome(error)).toBe(true);
  }
  invoke.mockResolvedValueOnce({ ...fixture.responses.control, lease: { ...fixture.responses.control.lease, generation: "9007199254740993" } });
  await expect(workPlanCommands.control(requests.workPlanControl)).rejects.toThrow("acknowledgement");
  for (const response of [
    { ...fixture.responses.plan, scope: [] },
    { ...fixture.responses.plan, options: { ...fixture.responses.plan.options, deliver: true } },
    { ...fixture.responses.plan, preview: { ...fixture.responses.plan.preview, config: { ...fixture.responses.plan.preview.config, shareContext: false } } },
  ]) {
    invoke.mockResolvedValueOnce(response);
    await expect(workPlanCommands.prepare(requests.workPlanPrepare)).rejects.toThrow("acknowledgement");
  }
  invoke.mockResolvedValueOnce(fixture.responses.plan.planId);
  await expect(workPlanCommands.start(requests.workPlanStart, fixture.responses.plan.attemptId)).rejects.toThrow("acknowledgement");
});

it("recovers an unknown action without treating a historical active receipt as current authority", async () => {
  invoke.mockRejectedValueOnce(new Error("response lost"));
  const error = await workPlanCommands.authorize(requests.workPlanAuthorize).catch(error => error);
  expect(hasUnknownOutcome(error)).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValueOnce(fixture.responses.action);
  expect((await workPlanCommands.action(requests.workPlanAction))?.state).toBe("active");
  invoke.mockResolvedValueOnce({ ...fixture.responses.status, state: "paused", lease: { ...fixture.responses.status.lease, generation: "2" } });
  expect((await workPlanCommands.status(requests.workPlanStatus)).state).toBe("paused");
  expect(invoke).toHaveBeenCalledTimes(3);
});

it("prepares manual work without any model and validates renewed continuation receipts", async () => {
  const manual = { ...requests.workPlanPrepare, config: null, options: { ...requests.workPlanPrepare.options, stages: [{ stage: "generation" as const, mode: "manual" as const }] } };
  const response = { ...fixture.responses.plan, options: manual.options, preview: null, attemptId: null };
  invoke.mockResolvedValueOnce(response);
  expect(await workPlanCommands.prepare(manual)).toEqual(response);
  const continuing: WorkPlanControlRequest = { ...requests.workPlanControl, command: "continue", confirmed: true, expiresAt: "18446744073709551615" };
  const continued = { ...fixture.responses.control, state: "active", attemptId: fixture.responses.plan.attemptId, parentTask: fixture.responses.plan.planId };
  invoke.mockResolvedValueOnce(continued);
  expect(await workPlanCommands.control(continuing)).toEqual(continued);
});

function savedPreparation() {
  return {...requests.workPlanPrepare,config:{...requests.workPlanPrepare.config!,connectionProfile:{storeId:fixtureIdentity(700),profileId:fixtureIdentity(701),revision:"1",digest:"a".repeat(64)}}};
}
it("accepts a serialized captured profile with all exact configuration fields",async()=>{
  const request=savedPreparation(),response={...structuredClone(fixture.responses.plan),preview:{...structuredClone(fixture.responses.plan.preview),config:structuredClone(request.config)}};
  expect(validators.validateResponseWorkPlan(response)).toBe(true);invoke.mockResolvedValueOnce(response);
  expect(await workPlanCommands.prepare(request)).toEqual(response);
  expect(invoke).toHaveBeenLastCalledWith("prepare_work_plan",{request});
});
it.each(["storeId","profileId","revision","digest"] as const)("rejects a transplanted %s even when every saved default is unchanged",async field=>{
  const request=savedPreparation(),config=structuredClone(request.config);
  config.connectionProfile[field]=field==="revision"?"2":field==="digest"?"b".repeat(64):fixtureIdentity(702);
  const response={...structuredClone(fixture.responses.plan),preview:{...structuredClone(fixture.responses.plan.preview),config}};
  expect(validators.validateResponseWorkPlan(response)).toBe(true);invoke.mockResolvedValueOnce(response);
  await expect(workPlanCommands.prepare(request)).rejects.toMatchObject({reason:"invalid-work-plan-acknowledgement",outcome:"unknown"});
});

function maintenanceAssessment(): MaintenanceAssessment {
  const basis=fixture.responses.plan.scope[0];
  return {projectId:requests.workPlanPrepare.projectId,sourceSnapshotId:basis.sourceSnapshotId,locale:requests.workPlanPrepare.locale,
    after:0,limit:100,nextOrdinal:null,digest:"a".repeat(64),coverage:"finite-current-source-window; historical-and-external-query-coverage-unknown",
    rows:[{unitId:basis.unitId,sourceRevisionId:basis.sourceRevisionId,nativeKey:basis.nativeKey,sourceText:fixture.responses.plan.preview.items[0].sourceText,
      translationText:null,translationRevisionId:null,selectionId:basis.selectionId,reviewBasis:"b".repeat(64),mappingUnresolved:false,reasons:["translation-missing"],suggested:"repair",
      protection:{unitId:basis.unitId,locale:requests.workPlanPrepare.locale,revision:"0",protected:false}}]};
}
it("requires explicit null for ordinary maintenance and correlates finite assessment reads",async()=>{
  const missingRequest:Record<string,unknown>={...requests.workPlanPrepare},missingPlan:Record<string,unknown>={...fixture.responses.plan};
  delete missingRequest.maintenance;delete missingPlan.maintenance;
  expect(validators.validateRequestWorkPlanPrepare(missingRequest)).toBe(false);expect(validators.validateResponseWorkPlan(missingPlan)).toBe(false);
  const assessment=maintenanceAssessment(),request={projectId:assessment.projectId,sessionToken:requests.workPlanPrepare.sessionToken,
    snapshotId:assessment.sourceSnapshotId,locale:assessment.locale,after:assessment.after,limit:assessment.limit};
  invoke.mockResolvedValueOnce(assessment);expect(await workPlanCommands.maintenance(request)).toEqual(assessment);
  expect(invoke).toHaveBeenLastCalledWith("read_maintenance_assessment",{request});
  invoke.mockResolvedValueOnce({...assessment,after:100});await expect(workPlanCommands.maintenance(request)).rejects.toBeDefined();
});
it("rejects an acknowledgement which replaces the captured maintenance choices",async()=>{
  const assessment=maintenanceAssessment(),maintenance:MaintenancePlanBasis={assessment,choices:[{unitId:assessment.rows[0].unitId,action:"repair",excluded:false}]};
  const request={...requests.workPlanPrepare,maintenance},response={...fixture.responses.plan,maintenance};
  expect(validators.validateResponseWorkPlan(response)).toBe(true);invoke.mockResolvedValueOnce(response);
  expect(await workPlanCommands.prepare(request)).toEqual(response);
  const changed={...response,maintenance:{...maintenance,choices:[{...maintenance.choices[0],action:"keep" as const}]}};
  expect(validators.validateResponseWorkPlan(changed)).toBe(true);invoke.mockResolvedValueOnce(changed);
  await expect(workPlanCommands.prepare(request)).rejects.toMatchObject({reason:"invalid-work-plan-acknowledgement",outcome:"unknown"});
});

it("reads only the original persisted authorization fields without treating Host-local consent as a recorded grant",async()=>{
  const request={...requests.workPlanAuthorize,expiresAt:"9007199254740994"};
  const recorded={kind:"authorize",planId:request.planId,actionId:request.actionId,digest:request.digest,
    confirmed:request.confirmed,effects:request.effects,expiresAt:request.expiresAt};
  const proof={projectId:request.projectId,request:recorded,receipt:{...fixture.responses.receipt,actionId:request.actionId}};
  invoke.mockResolvedValueOnce(proof);expect(await workPlanCommands.authorizationAction(request)).toEqual(proof);
  expect(invoke).toHaveBeenLastCalledWith("read_work_plan_authorization_action",{request});
  expect(proof.request).not.toHaveProperty("checkerExecutions");expect(proof.request).not.toHaveProperty("toolExecution");
  expect(proof.request).not.toHaveProperty("applicationToolExecutions");
  invoke.mockResolvedValueOnce(null);expect(await workPlanCommands.authorizationAction(request)).toBeNull();
  const missing={...recorded} as Record<string,unknown>;delete missing.expiresAt;
  for(const wrong of [undefined,{}, {...proof,projectId:fixtureIdentity(1700)}, {...proof,request:missing},
    {...proof,request:{...recorded,expiresAt:"9007199254740993"}}, {...proof,request:{...recorded,digest:"different"}},
    {...proof,request:{...recorded,confirmed:false}}, {...proof,request:{...recorded,effects:[]}},
    {...proof,request:{...recorded,applicationToolExecutions:request.applicationToolExecutions}},
    {...proof,receipt:{...proof.receipt,lease:{...proof.receipt.lease,generation:"2"}}}]) {
    invoke.mockResolvedValueOnce(wrong);await expect(workPlanCommands.authorizationAction(request)).rejects.toSatisfy(hasUnknownOutcome);
  }
  expect(invoke.mock.calls.every(([name])=>name==="read_work_plan_authorization_action")).toBe(true);
});

it.each(["pause","stop","take-over","continue"] as const)("confirms the complete original %s transition without control or start writes",async command=>{
  const request:WorkPlanControlRequest={...requests.workPlanControl,command,confirmed:command==="continue",expiresAt:command==="continue"?"9007199254740994":null};
  const recorded={kind:"control",planId:request.planId,actionId:request.actionId,expectedGeneration:request.expectedGeneration,
    command,confirmed:request.confirmed,expiresAt:request.expiresAt};
  const state=({pause:"paused",stop:"stopped","take-over":"taken-over",continue:"active"} as const)[command];
  const receipt={...fixture.responses.control,actionId:request.actionId,lease:{planId:request.planId,generation:(BigInt(request.expectedGeneration)+1n).toString()},state,
    attemptId:command==="continue"?fixtureIdentity(1701):null,parentTask:command==="continue"?fixtureIdentity(1702):null};
  const proof={projectId:request.projectId,request:recorded,receipt};
  invoke.mockResolvedValueOnce(proof);expect(await workPlanCommands.controlAction(request)).toEqual(proof);
  expect(invoke).toHaveBeenLastCalledWith("read_work_plan_control_action",{request});
  invoke.mockResolvedValueOnce(null);expect(await workPlanCommands.controlAction(request)).toBeNull();
  const missing={...recorded} as Record<string,unknown>;delete missing.expiresAt;
  for(const wrong of [undefined,{}, {...proof,projectId:fixtureIdentity(1700)}, {...proof,request:missing},
    {...proof,request:{...recorded,expectedGeneration:"0"}}, {...proof,request:{...recorded,command:"other"}},
    {...proof,request:{...recorded,confirmed:!recorded.confirmed}}, {...proof,request:{...recorded,checkerExecutions:[]}},
    {...proof,receipt:{...receipt,lease:{...receipt.lease,generation:"99"}}},
    {...proof,receipt:{...receipt,attemptId:command==="continue"?null:fixtureIdentity(1703)}}]) {
    invoke.mockResolvedValueOnce(wrong);await expect(workPlanCommands.controlAction(request)).rejects.toSatisfy(hasUnknownOutcome);
  }
  expect(invoke.mock.calls.every(([name])=>name==="read_work_plan_control_action")).toBe(true);
});
