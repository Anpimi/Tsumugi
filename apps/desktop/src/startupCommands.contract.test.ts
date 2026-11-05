import { beforeEach, expect, it, vi } from "vitest";
import { startupCommands, validateResponseStartupDropEvent, type StartupPreflight } from "./startupCommands";
import { validateResponsePluginSelection } from "./generated/source.validators";
import fixture from "../test/fixtures/pluginSourceWorkflow.contract.json";
import { fixtureIdentity as id } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn()); vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const selected: unknown = structuredClone(fixture.selection);
if (!validateResponsePluginSelection(selected) || selected === null) throw new Error("Invalid source selection fixture");
const selection = selected, directory = { selectionId: selection.selectionId, folderName: selection.folderName };
const request = { selectionId: directory.selectionId, source: fixture.select.source };
const preview: StartupPreflight = { directory, source: selection.source, complete: true,
  materials: selection.source.declaration.materials.map(material => ({ ...material, byteLength: 1, sha256: "a".repeat(64) })) };
beforeEach(() => invoke.mockReset());

it("keeps native selection cancellation separate from an authorized directory and accepts no raw path response", async () => {
  invoke.mockResolvedValueOnce(null); expect(await startupCommands.chooseDirectory()).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("select_startup_source_directory", { request: {} });
  invoke.mockResolvedValueOnce(directory); expect(await startupCommands.droppedDirectory({ dropTicket: id(2200) })).toEqual(directory);
  invoke.mockResolvedValueOnce({ ...directory, path: "/untrusted/path" }); await expect(startupCommands.chooseDirectory()).rejects.toThrow();
  invoke.mockResolvedValueOnce(null); await expect(startupCommands.droppedDirectory({ dropTicket: id(2200) })).rejects.toThrow();
});

it("binds preflight to the original directory and source recipe and checks material completeness", async () => {
  invoke.mockResolvedValueOnce(preview); expect(await startupCommands.preflight(request)).toEqual(preview);
  for (const value of [
    { ...preview, directory: { ...directory, selectionId: id(2201) } },
    { ...preview, source: { ...preview.source, resourceId: "another-resource" } },
    { ...preview, complete: false },
    { ...preview, materials: preview.materials.map((file, index) => index ? file : { ...file, logicalPath: "unrelated.txt" }) },
  ]) {
    invoke.mockResolvedValueOnce(value); await expect(startupCommands.preflight(request)).rejects.toThrow();
  }
  const incomplete = { ...preview, complete: false, materials: preview.materials.map(file => ({ ...file, byteLength: null, sha256: null })) };
  invoke.mockResolvedValueOnce(incomplete); expect(await startupCommands.preflight(request)).toEqual(incomplete);
  expect(invoke.mock.calls.every(([command]) => command === "read_startup_source_preflight")).toBe(true);
});

it("hands off only the exact directory and source to the newly created project context", async () => {
  const claim = { ...request, projectId: fixture.select.projectId, sessionToken: fixture.select.sessionToken };
  invoke.mockResolvedValueOnce(selection); expect(await startupCommands.claimDirectory(claim)).toEqual(selection);
  expect(invoke).toHaveBeenLastCalledWith("claim_startup_source_directory", { request: claim });
  invoke.mockResolvedValueOnce({ ...selection, selectionId: id(2202) }); await expect(startupCommands.claimDirectory(claim)).rejects.toThrow();
  invoke.mockResolvedValueOnce({ ...selection, source: { ...selection.source, resourceId: "substitution" } }); await expect(startupCommands.claimDirectory(claim)).rejects.toThrow();
});

it("accepts only opaque native drop invitations", () => {
  const event = { kind: "ready", dropTicket: id(2203), folderName: "Synthetic materials" };
  expect(validateResponseStartupDropEvent(event)).toBe(true);
  for (const key of ["path", "paths", "window", "epoch", "approved"]) expect(validateResponseStartupDropEvent({ ...event, [key]: "/untrusted/path" })).toBe(false);
});


it("binds selected file groups and optional omissions to the exact startup materials", async () => {
  const source = structuredClone(preview.source);
  source.declaration.materials = [];
  source.declaration.fileSets = [{ id: "records", displayName: "Record files", role: "source", encoding: "binary",
    extensions: ["esp", "esl"], minFiles: 1, maxFiles: 1, maxBytes: 1024 },
    { id: "tables", displayName: "Companion tables", role: "companion", encoding: "binary",
      extensions: ["strings"], minFiles: 0, maxFiles: 1, maxBytes: 1024 }];
  const chosen: StartupPreflight = { ...preview, source, fileSets: [{ id: "records", logicalPaths: ["Chosen.esp"] }],
    materials: [{ logicalPath: "Chosen.esp", role: "source", maxBytes: 1024, byteLength: 2, sha256: "a".repeat(64) }] };
  invoke.mockResolvedValueOnce(chosen); expect(await startupCommands.preflight(request)).toEqual(chosen);
  for (const value of [
    { ...chosen, fileSets: [] },
    { ...chosen, fileSets: [...chosen.fileSets!, ...chosen.fileSets!] },
    { ...chosen, fileSets: [{ id: "unknown", logicalPaths: ["Chosen.esp"] }] },
    { ...chosen, fileSets: [{ id: "records", logicalPaths: ["Other.esl"] }] },
    { ...chosen, materials: [...chosen.materials, { ...chosen.materials[0], logicalPath: "extra.esp" }] },
    { ...chosen, complete: false },
  ]) {
    invoke.mockResolvedValueOnce(value); await expect(startupCommands.preflight(request)).rejects.toThrow();
  }
});

it("checks shared captured bytes and requires a file even when every group is optional", async () => {
  const source = structuredClone(preview.source);
  source.declaration.materials = [];
  source.declaration.maxTotalBytes = 8;
  source.declaration.fileSets = [{ id: "records", displayName: "Record files", role: "source", encoding: "binary",
    extensions: ["esp"], minFiles: 0, maxFiles: 2, maxBytes: 8 }];
  const chosen: StartupPreflight = { ...preview, source,
    fileSets: [{ id: "records", logicalPaths: ["One.esp", "Two.esp"] }],
    materials: ["One.esp", "Two.esp"].map(logicalPath => ({ logicalPath, role: "source", maxBytes: 8, byteLength: 4, sha256: "a".repeat(64) })) };
  invoke.mockResolvedValueOnce(chosen); expect(await startupCommands.preflight(request)).toEqual(chosen);
  for (const value of [
    { ...chosen, materials: chosen.materials.map((file, index) => ({ ...file, byteLength: index ? 5 : 4 })) },
    { ...chosen, fileSets: [], materials: [] },
  ]) {
    invoke.mockResolvedValueOnce(value); await expect(startupCommands.preflight(request)).rejects.toThrow();
  }
});
