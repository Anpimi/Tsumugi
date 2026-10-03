import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { executionCommands, type ListRequest, type PrepareRequest, type Receipt, type SessionRequest } from "./executionCommands";
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
