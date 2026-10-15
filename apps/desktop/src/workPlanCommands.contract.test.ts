import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/workPlanCommands.contract.json";
import { workPlanCommands, type MaintenanceAssessment, type MaintenancePlanBasis } from "./workPlanCommands";
import * as validators from "./generated/ai.validators";
import type { Requests, WorkPlanControlRequest } from "./generated/ai.requests";
import { hasUnknownOutcome } from "./projectCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
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
it("uses generated contracts and preserves all eight scoped commands", async () => {
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
  ] as const) {
    invoke.mockResolvedValueOnce(response);
    expect(await call()).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith(command, { request });
  }
});

it("keeps generations exact and rejects unsupported semantic or raw input fields", () => {
  expect(fixture.responses.control.lease.generation).toBe("9007199254740994");
  for (const generation of [9007199254740993, "01", "-1", "9223372036854775808"])
    expect(validators.validateRequestWorkPlanControl({ ...requests.workPlanControl, expectedGeneration: generation })).toBe(false);
  expect(validators.validateRequestWorkPlanAuthorize({ ...requests.workPlanAuthorize, answer: "yes" })).toBe(false);
  expect(validators.validateRequestWorkPlanStart({ ...requests.workPlanStart, input: {} })).toBe(false);
  expect(validators.validateResponseWorkPlanStatus({ ...fixture.responses.status, expiresAt: 9007199254740993 })).toBe(false);
  expect(validators.validateResponseWorkPlan({ ...fixture.responses.plan, rawInput: {} })).toBe(false);
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
