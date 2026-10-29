import { beforeEach, expect, it, vi } from "vitest";
import { sourceCommands, type SourceLineageCorrectionRequest } from "./sourceCommands";
import { sourceCorrectionBasisFixture, sourceCorrectionReceiptFixture } from "./testSupport/sourceCorrectionFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import wire from "../test/fixtures/sourceCommands.contract.json";

const invoke = vi.hoisted(() => vi.fn()); vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
function request(): SourceLineageCorrectionRequest {
  const basis = sourceCorrectionBasisFixture(wire.session.projectId);
  return { ...wire.session, correction: { projectId: wire.session.projectId, actionId: id(2130), basis,
    oldOccurrenceId: basis.candidates[0].old.occurrenceId!, decision: "continue", actor: "Synthetic recorder", reason: "Keep the original match" } };
}

it("associates the correction comparison with its exact project, snapshot and occurrence position", async () => {
  const basis = request().correction.basis, read = { ...wire.session, snapshotId: basis.snapshotId, ordinal: basis.ordinal };
  invoke.mockResolvedValueOnce(basis); expect(await sourceCommands.correctionBasis(read)).toEqual(basis);
  invoke.mockResolvedValueOnce({ ...basis, snapshotId: id(2131) });
  await expect(sourceCommands.correctionBasis(read)).rejects.toThrow("Invalid IPC response");
  invoke.mockResolvedValueOnce({ ...basis, ordinal: basis.ordinal + 1 });
  await expect(sourceCommands.correctionBasis(read)).rejects.toThrow("Invalid IPC response");
});

it("requires the full original correction request and a newer mapping version in its receipt", async () => {
  const original = request(), receipt = sourceCorrectionReceiptFixture(original);
  invoke.mockResolvedValueOnce(receipt); expect(await sourceCommands.correctLineage(original)).toEqual(receipt);
  invoke.mockResolvedValueOnce({ ...receipt, request: { ...receipt.request, reason: "Another reason" } });
  await expect(sourceCommands.correctLineage(original)).rejects.toThrow("Invalid IPC response");
  invoke.mockResolvedValueOnce({ ...receipt, mappingRevision: original.correction.basis.mappingRevision });
  await expect(sourceCommands.correctLineage(original)).rejects.toThrow("Invalid IPC response");
});

it("keeps receipt absence and permanent non-application distinct without dispatching or settling the correction", async () => {
  const original = request();
  for (const status of ["receipt-absent", "confirmed-not-applied"] as const) {
    invoke.mockResolvedValueOnce({ status }); expect(await sourceCommands.correctionAction(original)).toEqual({ status });
  }
  invoke.mockResolvedValueOnce({ status: "recorded", receipt: sourceCorrectionReceiptFixture(original) });
  expect((await sourceCommands.correctionAction(original)).status).toBe("recorded");
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(Array(3).fill("read_source_lineage_correction_action"));
});
