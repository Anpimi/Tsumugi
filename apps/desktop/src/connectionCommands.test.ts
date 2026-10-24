import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/connectionCommands.contract.json";
import { connectionCommands, confirmConnectionReceipt, type ModelConnectionChange, type ModelConnectionReceipt } from "./connectionCommands";
import * as validators from "./generated/connections.validators";
import { hasUnknownOutcome } from "./projectCommands";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const other = "44444444-4444-4444-8444-444444444444";
const fresh = () => structuredClone(fixture);
beforeEach(() => invoke.mockReset());

describe("application connection IPC", () => {
  it("accepts the shared Rust fixture and exact native command arguments", async () => {
    for (const [key, value] of Object.entries(fixture.requests)) {
      const validator = ({ snapshot: validators.validateRequestSnapshot, change: validators.validateRequestChange,
        action: validators.validateRequestAction, resolve: validators.validateRequestResolve } as const)[key as keyof typeof fixture.requests];
      expect(validator(value)).toBe(true);
    }
    invoke.mockResolvedValueOnce(fixture.responses.snapshot).mockResolvedValueOnce(fixture.responses.receipt)
      .mockResolvedValueOnce(fixture.responses.action).mockResolvedValueOnce(fixture.responses.connection);
    expect(await connectionCommands.read()).toEqual(fixture.responses.snapshot);
    expect(await connectionCommands.change(fixture.requests.change as ModelConnectionChange)).toEqual(fixture.responses.receipt);
    expect(await connectionCommands.action(fixture.requests.action)).toEqual(fixture.responses.action);
    expect(await connectionCommands.resolve(fixture.requests.resolve)).toEqual(fixture.responses.connection);
    expect(invoke.mock.calls).toEqual([
      ["read_model_connections", { request: {} }],
      ["change_model_connections", { request: fixture.requests.change }],
      ["read_model_connection_action", { request: fixture.requests.action }],
      ["resolve_model_connection", { request: fixture.requests.resolve }],
    ]);
  });
  it("accepts an absent store with the Core's explicit empty basis and no references", async () => {
    const value = fresh().responses.snapshot;
    value.snapshot = { storeId: null, revision: "0", lastActionId: null, profiles: [] } as unknown as typeof value.snapshot;
    value.basis = { storeId: null, revision: "0", digest: fixture.requests.change.expected.digest } as unknown as typeof value.basis;
    value.references = [];
    invoke.mockResolvedValue(value);
    expect(await connectionCommands.read()).toEqual(value);
  });
  it("rejects structurally valid mixed snapshots, missing references and foreign profile identities", async () => {
    const changes = [
      (value: ReturnType<typeof fresh>["responses"]["snapshot"]) => { value.basis.revision = "2"; },
      (value: ReturnType<typeof fresh>["responses"]["snapshot"]) => { value.basis.storeId = other; },
      (value: ReturnType<typeof fresh>["responses"]["snapshot"]) => { value.references = []; },
      (value: ReturnType<typeof fresh>["responses"]["snapshot"]) => { value.references[0].storeId = other; },
      (value: ReturnType<typeof fresh>["responses"]["snapshot"]) => { value.references[0].profileId = other; },
      (value: ReturnType<typeof fresh>["responses"]["snapshot"]) => { value.references[0].revision = "2"; },
      (value: ReturnType<typeof fresh>["responses"]["snapshot"]) => { value.references[0].digest = "not-a-digest"; },
    ];
    for (const change of changes) {
      const value = fresh().responses.snapshot; change(value); invoke.mockResolvedValueOnce(value);
      await expect(connectionCommands.read()).rejects.toThrow("Invalid IPC acknowledgement");
    }
  });
  it("rejects duplicate profiles, duplicate active names and references to archived profiles", async () => {
    const value = fresh().responses.snapshot;
    value.snapshot.profiles.push(structuredClone(value.snapshot.profiles[0]));
    value.references.push(structuredClone(value.references[0])); invoke.mockResolvedValueOnce(value);
    await expect(connectionCommands.read()).rejects.toThrow();
    const names = fresh().responses.snapshot; const second = structuredClone(names.snapshot.profiles[0]); second.id = other;
    names.snapshot.profiles.push(second); names.references.push({ ...names.references[0], profileId: other }); invoke.mockResolvedValueOnce(names);
    await expect(connectionCommands.read()).rejects.toThrow();
    const archived = fresh().responses.snapshot; archived.snapshot.profiles[0].archived = true; invoke.mockResolvedValueOnce(archived);
    await expect(connectionCommands.read()).rejects.toThrow();
  });
  it("accepts the original receipt after later reads without treating it as current state", () => {
    const request = fixture.requests.change as ModelConnectionChange, receipt = fixture.responses.receipt as ModelConnectionReceipt;
    expect(confirmConnectionReceipt(request, receipt)).toEqual(receipt);
    expect(receipt.snapshot.revision).toBe("1");
  });
  it("keeps a wrong action, scope, generation or saved connection acknowledgement uncertain", async () => {
    for (const mutate of [
      (value: ModelConnectionReceipt) => { value.actionId = other; },
      (value: ModelConnectionReceipt) => { value.snapshot.lastActionId = other; },
      (value: ModelConnectionReceipt) => { value.snapshot.revision = "2"; },
      (value: ModelConnectionReceipt) => { value.snapshot.profiles[0].connection.model = "Foreign model"; },
      (value: ModelConnectionReceipt) => { value.snapshot.profiles[0].name = "Foreign name"; },
    ]) {
      const value = structuredClone(fixture.responses.receipt) as ModelConnectionReceipt; mutate(value); invoke.mockResolvedValueOnce(value);
      const error = await connectionCommands.change(fixture.requests.change as ModelConnectionChange).catch(error => error);
      expect(error).toBeInstanceOf(Error); expect(hasUnknownOutcome(error)).toBe(true);
    }
  });
  it("reads a missing original action and refuses a receipt for another action", async () => {
    invoke.mockResolvedValueOnce(null); expect(await connectionCommands.action(fixture.requests.action)).toBeNull();
    const value = fresh().responses.receipt; value.actionId = other; value.snapshot.lastActionId = other; invoke.mockResolvedValueOnce(value);
    await expect(connectionCommands.action(fixture.requests.action)).rejects.toThrow();
  });
  it("shares the generated error boundary for rejected and unknown connection saves", () => {
    const rejected = { code: "dependency-conflict", stage: "model-connections", outcome: "rejected", recoveryRequired: false };
    expect(hasUnknownOutcome(rejected)).toBe(false);
    expect(hasUnknownOutcome({ ...rejected, code: "outcome-unknown", outcome: "unknown", recoveryRequired: true })).toBe(true);
  });
  it("rejects control characters while measuring connection names in Unicode scalars", async () => {
    const control = fresh().responses.snapshot; control.snapshot.profiles[0].name = "Primary" + String.fromCharCode(1);
    invoke.mockResolvedValueOnce(control); await expect(connectionCommands.read()).rejects.toThrow();
    const unicode = fresh().responses.snapshot; unicode.snapshot.profiles[0].name = "🌱".repeat(128);
    invoke.mockResolvedValueOnce(unicode); expect(await connectionCommands.read()).toEqual(unicode);
    const tooLong = fresh().responses.snapshot; tooLong.snapshot.profiles[0].name = "🌱".repeat(129);
    invoke.mockResolvedValueOnce(tooLong); await expect(connectionCommands.read()).rejects.toThrow();
  });
  it("strictly refuses raw credential fields and numeric revisions", () => {
    const request = fresh().requests.change;
    expect(validators.validateRequestChange({ ...request, expected: { ...request.expected, revision: 0 } })).toBe(false);
    expect(validators.validateRequestChange({ ...request, edit: { ...request.edit, connection: { ...request.edit.connection, apiKey: "synthetic-rejected" } } })).toBe(false);
    expect(validators.validateRequestSnapshot({ directory: "untrusted" })).toBe(false);
  });
});
