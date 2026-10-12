import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { executionCommands, confirmExecutionAction, confirmExecutionReceipt, type ListRequest, type PrepareRequest, type Receipt, type SessionRequest } from "./executionCommands";
import * as validators from "./generated/execution.validators";
import { hasUnknownOutcome } from "./projectCommands";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const session: SessionRequest = fixture.session;
const list: ListRequest = fixture.list;
const prepare: PrepareRequest = fixture.prepare;
const receipt: Receipt = fixture.receipt;
beforeEach(() => invoke.mockReset());
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
