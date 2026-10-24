import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { executionCommands, confirmCancellationReceipt, confirmExecutionAction, confirmExecutionReceipt, type ContinuationRequest, type ListRequest, type PrepareRequest, type Receipt, type SessionRequest } from "./executionCommands";
import * as validators from "./generated/execution.validators";
import { hasUnknownOutcome } from "./projectCommands";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const session: SessionRequest = fixture.session;
const list: ListRequest = fixture.list;
const prepare: PrepareRequest = fixture.prepare;
const receipt: Receipt = fixture.receipt;
beforeEach(() => invoke.mockReset());
it("reads the exact original cancellation with a positive decimal revision and no cancellation replay",async()=>{
  const request=fixture.cancel,receipt={projectId:request.projectId,taskId:request.taskId,requestId:request.requestId,revision:"9007199254740993"};
  expect(validators.validateRequestCancellationAction(request)).toBe(true);
  invoke.mockResolvedValueOnce(receipt).mockResolvedValueOnce(null);
  expect(await executionCommands.cancellationAction(request)).toEqual(receipt);expect(await executionCommands.cancellationAction(request)).toBeNull();
  expect(invoke.mock.calls).toEqual(Array(2).fill(["read_execution_cancellation_action",{request}]));
  for(const value of [undefined,{...receipt,projectId:fixture.prepare.unitId},{...receipt,taskId:fixture.prepare.unitId},
    {...receipt,requestId:fixture.prepare.unitId},{...receipt,revision:"0"},{...receipt,revision:9007199254740992},{...receipt,extra:true}]){
    invoke.mockResolvedValueOnce(value);expect(hasUnknownOutcome(await executionCommands.cancellationAction(request).catch(error=>error))).toBe(true);
    expect(()=>confirmCancellationReceipt(request,value)).toThrow();
  }
  expect(()=>confirmCancellationReceipt(request,null)).toThrow();expect(invoke.mock.calls.every(([name])=>name==="read_execution_cancellation_action")).toBe(true);
});
it("reads complete original adoption records with required nullable receipts without a write", async () => {
  const action = {...fixture.action,parameters:null};
  for (const result of [null,{action,receipt:null},{action,receipt}]) {
    expect(validators.validateRequestAdoptionAction(prepare)).toBe(true);
    invoke.mockResolvedValueOnce(result);
    expect(await executionCommands.adoptionAction(prepare)).toEqual(result);
    expect(invoke).toHaveBeenLastCalledWith("read_execution_adoption_action",{request:prepare});
  }
  for (const result of [undefined,{action},{action,receipt:undefined},{action,receipt,extra:true},{action,receipt:{...receipt,unitId:"invalid"}}]) {
    invoke.mockResolvedValueOnce(result);
    expect(hasUnknownOutcome(await executionCommands.adoptionAction(prepare).catch(error=>error))).toBe(true);
    expect(validators.validateResponseAdoptionAction(result)).toBe(false);
  }
  expect(invoke.mock.calls.every(([name])=>name==="read_execution_adoption_action")).toBe(true);
});

it("preserves Rust field names, exact revisions and explicit command scopes", async () => {
  invoke.mockResolvedValueOnce(fixture.status);
  expect(await executionCommands.status(session)).toEqual(fixture.status);
  expect(invoke).toHaveBeenLastCalledWith("execution_status", { request: session });
  invoke.mockResolvedValueOnce([]);
  await executionCommands.list(list);
  expect(invoke).toHaveBeenLastCalledWith("list_execution_tasks", { request: list });
  expect(list.after).toBe("9007199254740993");
  invoke.mockResolvedValueOnce(fixture.action);
  await executionCommands.prepare(prepare);
  expect(invoke).toHaveBeenLastCalledWith("prepare_execution_adoption", { request: prepare });
  expect(receipt.changes[0].revision).toBe("9007199254740993");
  expect(fixture.detail.recovery.units[0].actions).toEqual(["query-outcome"]);
  expect(fixture.detail.items[0].status).toMatchObject({ execution: "unknown", adoption: "unapplied", retrySafe: false });
  expect(JSON.stringify(fixture)).not.toMatch(/session_token|attempt_id|remaining_item_ids/);
});
it("validates shared Rust fixtures in both directions with exact scalar bounds", () => {
  const requests = [
    [validators.validateRequestSession, fixture.session],
    [validators.validateRequestList, fixture.list],
    [validators.validateRequestTask, fixture.taskRequest],
    [validators.validateRequestAttempt, fixture.attempt],
    [validators.validateRequestOutput, fixture.outputRequest],
    [validators.validateRequestCancel, fixture.cancel],
    [validators.validateRequestRecovery, fixture.recover],
    [validators.validateRequestContinuation, fixture.continuation],
    [validators.validateRequestContinuationRead, fixture.continuationRead],
    [validators.validateRequestContinuationList, fixture.continuationList],
    [validators.validateRequestTaskView, fixture.taskViewRequest],
    [validators.validateRequestPrepare, fixture.prepare],
    [validators.validateRequestAdopt, fixture.adopt],
  ] as const;
  const responses = [
    [validators.validateResponseIdentity, fixture.prepare.actionId],
    [validators.validateResponseStatus, fixture.status],
    [validators.validateResponseTasks, [fixture.task]],
    [validators.validateResponseAttempts, [fixture.summary]],
    [validators.validateResponseAttempt, fixture.detail],
    [validators.validateResponseOutput, fixture.output],
    [validators.validateResponseCancellation, "9223372036854775807"],
    [validators.validateResponseRecovery, fixture.recovery],
    [validators.validateResponseContinuation, fixture.continuationReceipt],
    [validators.validateResponseContinuationReceipt, fixture.continuationReceipt],
    [validators.validateResponseContinuationReceipt, null],
    [validators.validateResponseContinuations, fixture.continuations],
    [validators.validateResponseTaskView, fixture.task],
    [validators.validateResponseAction, fixture.action],
    [validators.validateResponseAdoption, fixture.receipt],
    [validators.validateResponseReceipt, fixture.receipt],
    [validators.validateResponseReceipt, null],
  ] as const;
  for (const [validate, value] of [...requests, ...responses]) expect(validate(value)).toBe(true);
  expect(validators.validateRequestAttempt({ ...fixture.attempt, offset: 4294967296 })).toBe(false);
  expect(validators.validateResponseAttempt({ ...fixture.detail, nextOffset: 4294967296 })).toBe(false);
  expect(validators.validateResponseAttempt({ ...fixture.detail, progress: { ...fixture.detail.progress, total: 4294967296 } })).toBe(false);
  for (const sequence of [9007199254740992, "9223372036854775808", "01", "-1"]) expect(validators.validateResponseTasks([{ ...fixture.task, sequence }])).toBe(false);
  const invalid = structuredClone(fixture.detail);
  invalid.items[0].status.execution = "future-state";
  expect(validators.validateResponseAttempt(invalid)).toBe(false);
  expect(validators.validateResponseReceipt({})).toBe(false);
  expect(validators.validateResponseReceipt(undefined)).toBe(false);
});
it("keeps a malformed adoption acknowledgement unknown without replaying it", async () => {
  invoke.mockResolvedValueOnce({ ...fixture.receipt, changes: [{ ...fixture.receipt.changes[0], revision: 9007199254740992 }] });
  const failure = await executionCommands.adopt(fixture.adopt).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(hasUnknownOutcome(failure)).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValueOnce(fixture.receipt);
  expect(await executionCommands.receipt(fixture.adopt)).toEqual(fixture.receipt);
});
it("requires a positive checked cancellation revision and preserves the exact original request", async () => {
  expect(validators.validateResponseCancellation("0")).toBe(true);
  for (const invalid of ["0", 1, "01", "9223372036854775808", {}]) {
    invoke.mockResolvedValueOnce(invalid);
    const failure = await executionCommands.cancel(fixture.cancel).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(hasUnknownOutcome(failure)).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("cancel_execution_task", { request: fixture.cancel });
  }
  expect(invoke).toHaveBeenCalledTimes(5);
  invoke.mockResolvedValueOnce("9007199254740993");
  expect(await executionCommands.cancel(fixture.cancel)).toBe("9007199254740993");
  expect(invoke).toHaveBeenLastCalledWith("cancel_execution_task", { request: fixture.cancel });
});

it("checks the real general preparation contract using canonical unique result sets and null parameters", () => {
  const other = "10000000-0000-4000-8000-000000000009";
  const request = { ...prepare, resultIds: [other, prepare.resultIds[0]] };
  // Host's general adapter supplies null; the shared Core fixture also covers custom parameters.
  const action = { ...fixture.action, parameters: null, resultIds: [...request.resultIds].sort(), cancellationRevision: "0" };
  expect(confirmExecutionAction(request, "sample-update", action)).toEqual(action);
  expect(request.resultIds).toEqual([other, prepare.resultIds[0]]);
  for (const patch of [
    { projectId: other }, { attemptId: other }, { actionId: other }, { unitId: other }, { operation: "other" },
    { parameters: fixture.action.parameters }, { resultIds: [other, other] }, { resultIds: [other] },
    { resultIds: [...action.resultIds, fixture.prepare.actionId] },
  ]) expect(() => confirmExecutionAction(request, "sample-update", { ...action, ...patch })).toThrow();
  expect(() => confirmExecutionAction(request, "sample-update", { ...action, cancellationRevision: "1" }, action)).toThrow();
});

it("pins complete generic receipts without inventing domain-specific change restrictions", () => {
  const generic = { ...receipt, changes: [{ kind: "custom fact", id: "a non-UUID fact", revision: "0" }] };
  expect(confirmExecutionReceipt(prepare, generic)).toEqual(generic);
  expect(confirmExecutionReceipt(prepare, { ...receipt, changes: [] })).toEqual({ ...receipt, changes: [] });
  for (const patch of [
    { projectId: fixture.prepare.unitId }, { attemptId: fixture.prepare.unitId }, { actionId: fixture.prepare.unitId },
    { unitId: fixture.prepare.actionId }, { requestDigest: "f".repeat(64) },
    { changes: [] }, { changes: [{ ...generic.changes[0], kind: "other" }] },
    { changes: [{ ...generic.changes[0], id: "another fact" }] }, { changes: [{ ...generic.changes[0], revision: "1" }] },
  ]) expect(() => confirmExecutionReceipt(prepare, { ...generic, ...patch }, generic)).toThrow();
});

it("keeps actual general adoption on the three-field request and accepts a zero change revision", async () => {
  const action = { ...fixture.action, parameters: null, cancellationRevision: "0" };
  invoke.mockResolvedValueOnce(action).mockResolvedValueOnce({ ...receipt, changes: [{ kind: "sample-update", id: "Sample A", revision: "0" }] });
  expect(confirmExecutionAction(prepare, "sample-update", await executionCommands.prepare(prepare))).toEqual(action);
  await executionCommands.adopt(fixture.adopt);
  expect(invoke).toHaveBeenLastCalledWith("adopt_execution", { request: fixture.adopt });
  expect(Object.keys(invoke.mock.calls[1][1].request).sort()).toEqual(["actionId", "projectId", "sessionToken"]);
});

it("binds continuation ACK and exact lookup to the complete original action", async () => {
  const request: ContinuationRequest = { ...fixture.continuation, action: { ...fixture.continuation.action, kind: "resume-undispatched" } };
  invoke.mockResolvedValueOnce(fixture.continuationReceipt);
  expect(await executionCommands.continue(request)).toEqual(fixture.continuationReceipt);
  expect(invoke).toHaveBeenLastCalledWith("continue_execution", { request });
  for (const action of [
    { ...request.action, unitId: fixture.output.dispatchToken },
    { ...request.action, expectedCancellationRevision: "0" },
    { ...request.action, itemIds: [] },
    { ...request.action, kind: "retry-safe-failure" },
  ]) {
    invoke.mockResolvedValueOnce({ ...fixture.continuationReceipt, action });
    const error = await executionCommands.continue(request).catch(error => error);
    expect(hasUnknownOutcome(error)).toBe(true);
  }
  invoke.mockResolvedValueOnce({ ...fixture.continuationReceipt, action: { ...request.action, actionId: fixture.prepare.actionId } });
  await expect(executionCommands.continuation(fixture.continuationRead)).rejects.toThrow();
  invoke.mockResolvedValueOnce(fixture.continuationReceipt);
  expect(await executionCommands.continuation(fixture.continuationRead)).toEqual(fixture.continuationReceipt);
  expect(invoke.mock.calls.filter(([command]) => command === "continue_execution")).toHaveLength(5);
});

it("rejects incomplete or mis-scoped continuation history without a false absence result", async () => {
  const request = { ...fixture.continuationList, after: "0", limit: 1 };
  invoke.mockResolvedValueOnce({ receipts: [fixture.continuationReceipt], next: fixture.continuationReceipt.sequence });
  expect((await executionCommands.continuations(request)).next).toBe(fixture.continuationReceipt.sequence);
  for (const page of [
    { receipts: [fixture.continuationReceipt], next: "1" },
    { receipts: [fixture.continuationReceipt], next: null },
    { receipts: [{ ...fixture.continuationReceipt, action: { ...fixture.continuationReceipt.action, sourceAttemptId: fixture.output.dispatchToken } }], next: null },
    { receipts: [fixture.continuationReceipt, fixture.continuationReceipt], next: null },
  ]) {
    invoke.mockResolvedValueOnce(page);
    await expect(executionCommands.continuations(request)).rejects.toThrow();
  }
  invoke.mockResolvedValueOnce({ receipts: [], next: null });
  expect(await executionCommands.continuations({ ...request, after: fixture.continuationReceipt.sequence })).toEqual({ receipts: [], next: null });
});

it("accepts a zero continuation basis while checking the original TaskView scope and exact revision", async () => {
  const request: ContinuationRequest = { ...fixture.continuation, action: { ...fixture.continuation.action, kind: "resume-undispatched", expectedCancellationRevision: "0" } };
  expect(validators.validateRequestContinuation(request)).toBe(true);
  const receipt = { ...fixture.continuationReceipt, action: request.action };
  invoke.mockResolvedValueOnce(receipt);
  expect(await executionCommands.continue(request)).toEqual(receipt);
  expect(invoke).toHaveBeenLastCalledWith("continue_execution", { request });
  for (const patch of [{ taskId: fixture.prepare.actionId }, { projectId: fixture.prepare.actionId }, { cancellationRevision: "01" }, { cancellationRevision: 0 }]) {
    invoke.mockResolvedValueOnce({ ...fixture.task, ...patch });
    await expect(executionCommands.taskView(fixture.taskViewRequest)).rejects.toThrow();
  }
  const task = { ...fixture.task, cancellationRevision: "0" };
  invoke.mockResolvedValueOnce(task);
  expect(await executionCommands.taskView(fixture.taskViewRequest)).toEqual(task);
  expect(invoke).toHaveBeenLastCalledWith("read_execution_task_view", { request: fixture.taskViewRequest });
});
