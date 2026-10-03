import { expect, it, vi } from "vitest";
import project from "../test/fixtures/projectCommands.contract.json";
import changes from "../test/fixtures/projectChanges.contract.json";
import { validateRequestCreate, validateRequestRename, validateRequestRead, validateRequestChanges, validateResponseProjectView, validateResponseMetadataMutation, validateResponseClose, validateResponseError, validateResponseChanges, validateResponseNotification } from "./generated/validators";
import { hasUnknownOutcome, isCommandError, projectCommands } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("checks shared Serde fixtures in both wire directions", () => {
  expect(validateRequestCreate(project.requests.create)).toBe(true);
  expect(validateRequestRename(project.requests.rename)).toBe(true);
  expect(validateRequestRead(project.requests.read)).toBe(true);
  expect(validateRequestChanges(changes.request)).toBe(true);
  expect(validateResponseProjectView(project.responses.projectView)).toBe(true);
  expect(validateResponseMetadataMutation(project.responses.metadataMutation)).toBe(true);
  expect(validateResponseClose(project.responses.close)).toBe(true);
  expect(validateResponseError(project.error)).toBe(true);
  expect(validateResponseChanges(changes.snapshot)).toBe(true);
  expect(validateResponseNotification(changes.notification)).toBe(true);
});
it("keeps full u64 metadata counters separate from nonnegative i64 execution counters", () => {
  const error = { ...project.error, currentRevision: "18446744073709551615" };
  expect(isCommandError(error)).toBe(true);
  for (const currentRevision of [18446744073709551615, "18446744073709551616", "01", "-1"]) expect(isCommandError({ ...error, currentRevision })).toBe(false);
  for (const sequence of [9007199254740992, "9223372036854775808", "01", "-1"]) expect(validateResponseChanges({ ...changes.snapshot, sequence })).toBe(false);
  expect(validateResponseChanges({ ...changes.snapshot, sequence: "9223372036854775807" })).toBe(true);
});
it("rejects incorrect enums and field shapes while preserving mutation uncertainty", async () => {
  expect(isCommandError({ ...project.error, reason: null })).toBe(false);
  expect(isCommandError({ ...project.error, stage: "future-stage" })).toBe(false);
  expect(isCommandError({ ...project.error, recoveryActions: ["replay-unknown"] })).toBe(false);
  expect(isCommandError({ ...project.error, outcome: "rejected" })).toBe(false);
  invoke.mockResolvedValueOnce({ ...project.responses.metadataMutation, outcome: "maybe" });
  const failure = await projectCommands.rename(project.requests.rename).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(hasUnknownOutcome(failure)).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
});
