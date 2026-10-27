import { beforeEach, expect, it, vi } from "vitest";
import actions from "../test/fixtures/translation-commands.json";
import fixture from "../test/fixtures/translationRecovery.contract.json";
import { translationCommands } from "./translationCommands";
import * as validators from "./generated/translation.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it.each(["saveRecorded", "savePending", "saveBlocked", "saveMismatch"] as const)(
  "reads the original save result without submitting another action (%s)", async key => {
    invoke.mockResolvedValueOnce(fixture[key]);
    expect(await translationCommands.recoverSave(actions.save)).toEqual(fixture[key]);
    expect(invoke.mock.calls).toEqual([["recover_translation_save", { request: actions.save }]]);
  },
);

it.each(["selectionRecorded", "selectionPending", "selectionBlocked", "selectionMismatch"] as const)(
  "reads the original selection result without changing its identity (%s)", async key => {
    invoke.mockResolvedValueOnce(fixture[key]);
    expect(await translationCommands.recoverSelection(actions.select)).toEqual(fixture[key]);
    expect(invoke.mock.calls).toEqual([["recover_translation_selection", { request: actions.select }]]);
  },
);

it.each(["projectId", "actionId", "unitId", "locale", "sourceRevisionId", "expectedSelectionId", "text"] as const)(
  "keeps an unconfirmed save when a typed response echoes another %s", async field => {
    const value = structuredClone(fixture.savePending);
    value.request[field] = field === "locale" ? "fr-FR" : field === "text" ? "Newer draft" : actions.start.selectionId;
    expect(validators.validateResponseRecoverSave(value)).toBe(true);
    invoke.mockResolvedValueOnce(value);
    await expect(translationCommands.recoverSave(actions.save)).rejects.toThrow("Invalid save receipt");
    expect(invoke).toHaveBeenCalledTimes(1);
  },
);

it("rejects a different revision or a recorded result for another payload", async () => {
  const selection = structuredClone(fixture.selectionPending);
  selection.request.revisionId = actions.start.selectionId;
  invoke.mockResolvedValueOnce(selection);
  await expect(translationCommands.recoverSelection(actions.select)).rejects.toThrow("Invalid save receipt");
  const saved = structuredClone(fixture.saveRecorded);
  saved.outcome.receipt.revision.text = "Another saved input";
  expect(validators.validateResponseRecoverSave(saved)).toBe(true);
  invoke.mockResolvedValueOnce(saved);
  await expect(translationCommands.recoverSave(actions.save)).rejects.toThrow("Invalid save receipt");
});

it.each([
  null,
  { ...fixture.savePending, outcome: { kind: "confirmed-not-applied", replay: "explicit-same-request" } },
  { ...fixture.savePending, outcome: { kind: "pending", replay: "automatic" } },
  { ...fixture.savePending, outcome: { kind: "pending" } },
  { ...fixture.saveMismatch, outcome: { kind: "mismatch", replay: "explicit-same-request" } },
  { ...fixture.saveRecorded, outcome: { kind: "recorded" } },
  { ...fixture.savePending, request: { ...fixture.savePending.request, sessionToken: "another-session" } },
])("does not infer a result or replay permission from an invalid response", async value => {
  expect(validators.validateResponseRecoverSave(value)).toBe(false);
  invoke.mockResolvedValueOnce(value);
  await expect(translationCommands.recoverSave(actions.save)).rejects.toThrow();
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["recover_translation_save"]);
});

it("accepts a new session credential while keeping the complete business request", async () => {
  invoke.mockResolvedValueOnce(fixture.saveRecorded);
  const request = { ...actions.save, sessionToken: "reopened-session" };
  expect(await translationCommands.recoverSave(request)).toEqual(fixture.saveRecorded);
  expect(invoke).toHaveBeenLastCalledWith("recover_translation_save", { request });
});

it("keeps a failed recovery read as an error and sends no write", async () => {
  const failure = { code: "storage-failed", outcome: "unknown" };
  invoke.mockRejectedValueOnce(failure);
  await expect(translationCommands.recoverSave(actions.save)).rejects.toBe(failure);
  expect(invoke).toHaveBeenCalledTimes(1);
});
