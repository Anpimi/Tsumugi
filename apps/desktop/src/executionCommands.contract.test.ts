import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/executionCommands.contract.json";
import sdkResult from "../../../crates/plugin-sdk/tests/fixtures/invocation.result.json";
import { executionCommands, type ContinuationRequest, type ListRequest, type PrepareRequest, type Receipt, type SessionRequest } from "./executionCommands";
import * as validators from "./generated/execution.validators";
import { hasUnknownOutcome } from "./projectCommands";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const session: SessionRequest = fixture.session;
const list: ListRequest = fixture.list;
const prepare: PrepareRequest = fixture.prepare;
const receipt: Receipt = fixture.receipt;
beforeEach(() => invoke.mockReset());
it("retains SDK channel and raw result evidence through the generated output contract", async () => {
  const result = sdkResult.body.data;
  const output = { ...fixture.output, outcome: "succeeded", output: JSON.parse(result.outcome.output.utf8), diagnostic: null,
    plugin: { authorizationId: fixture.prepare.actionId, channel: result.provider, result } };
  expect(validators.validateResponseOutput(output)).toBe(true);
  invoke.mockResolvedValueOnce(output);
  expect(await executionCommands.output(fixture.outputRequest)).toEqual(output);
  expect(output.plugin.result.outcome.output.utf8).toBe('{"text":"世界 😀"}');
  expect(validators.validateResponseOutput({ ...output, plugin: { ...output.plugin, authority: true } })).toBe(false);
  expect(validators.validateResponseOutput({ ...output, plugin: { ...output.plugin, authorizationId: "not-a-core-id" } })).toBe(false);
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

it("requires actual null for continuation absence and accepts the original revision-zero request", async () => {
  const request: ContinuationRequest = { ...fixture.continuation, action: { ...fixture.continuation.action, kind: "resume-undispatched", expectedCancellationRevision: "0" } };
  const recorded = { ...fixture.continuationReceipt, action: request.action };
  invoke.mockResolvedValueOnce(recorded);
  expect(await executionCommands.continue(request)).toEqual(recorded);
  expect(invoke).toHaveBeenLastCalledWith("continue_execution", { request });
  for (const value of [undefined, {}, false]) {
    invoke.mockResolvedValueOnce(value);
    await expect(executionCommands.continuation(fixture.continuationRead)).rejects.toThrow();
  }
  invoke.mockResolvedValueOnce(null);
  expect(await executionCommands.continuation(fixture.continuationRead)).toBeNull();
  invoke.mockResolvedValueOnce({ ...fixture.task, taskId: fixture.output.dispatchToken });
  await expect(executionCommands.taskView(fixture.taskViewRequest)).rejects.toThrow("Invalid task view scope");
});

it("reads a reused raw Plugin result under its logical continuation without rewriting the producer frame", async () => {
  const result = sdkResult.body.data;
  const output = { ...fixture.output, outcome: "succeeded", output: JSON.parse(result.outcome.output.utf8), diagnostic: null,
    plugin: { authorizationId: fixture.prepare.actionId, channel: result.provider, result } };
  const request = { ...fixture.outputRequest, attemptId: fixture.continuationReceipt.attemptId };
  invoke.mockResolvedValueOnce(output);
  expect(await executionCommands.output(request)).toEqual(output);
  expect(invoke).toHaveBeenLastCalledWith("read_execution_output", { request });
  expect(output.attemptId).toBe(fixture.continuation.action.sourceAttemptId);
  expect(output.attemptId).not.toBe(request.attemptId);
  expect(invoke.mock.calls.some(([command]) => command === "continue_execution" || command === "start_plugin_tool")).toBe(false);
});
