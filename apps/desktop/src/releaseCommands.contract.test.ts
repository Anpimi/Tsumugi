import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/releaseCommands.contract.json";
import { confirmReleaseDelivery, confirmReleasePreview, releaseCommands, type DeliveryPreview, type DeliveryView, type ReleaseExceptionKind, type ReleaseView } from "./releaseCommands";
import * as validators from "./generated/release.validators";
import { hasUnknownOutcome } from "./projectCommands";
import { pluginBuildWorkflow, savedPluginBuild } from "./testSupport/pluginBuildFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it("reads the typed saved build with its exact original identity and without execution calls", async () => {
  expect(validators.validateRequestSavedPluginBuild(pluginBuildWorkflow.savedRead)).toBe(true);
  expect(validators.validateResponseSavedPluginBuild(savedPluginBuild)).toBe(true);
  invoke.mockResolvedValue(savedPluginBuild);
  expect(await releaseCommands.savedBuild(pluginBuildWorkflow.savedRead)).toEqual(savedPluginBuild);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("read_saved_plugin_build", { request: pluginBuildWorkflow.savedRead });
  expect(savedPluginBuild.locales[0].result?.artifacts.map(file => file.logicalPath)).toEqual(pluginBuildWorkflow.review.choices[0].outputPaths);
});

it("bounds saved build counts and refuses artifact bytes in the read-only projection", () => {
  const locale = savedPluginBuild.locales[0], artifact = locale.result!.artifacts[0];
  for (const count of [-1, 4294967296, 0.5, "2"]) {
    expect(validators.validateResponseSavedPluginBuild({ ...savedPluginBuild, locales: [{ ...locale, targetCount: count }] })).toBe(false);
    expect(validators.validateResponseSavedPluginBuild({ ...savedPluginBuild, locales: [{ ...locale,
      result: { ...locale.result, artifacts: [{ ...artifact, byteLength: count }] } }] })).toBe(false);
  }
  expect(validators.validateResponseSavedPluginBuild({ ...savedPluginBuild, locales: [{ ...locale,
    result: { ...locale.result, artifacts: [{ ...artifact, utf8: "unrequested output bytes" }] } }] })).toBe(false);
});

it.each(["project", "attempt", "item", "paths", "artifact-id", "status", "non-success"] as const)("rejects a saved build projection with mismatched %s without retry", async mismatch => {
  const value = structuredClone(savedPluginBuild), other = pluginBuildWorkflow.prepareCheck.attemptId;
  if (mismatch === "project") value.projectId = other;
  if (mismatch === "attempt") value.attemptId = other;
  if (mismatch === "item") value.locales[0].status.itemId = other;
  if (mismatch === "paths") value.locales[0].choice.outputPaths = ["unrequested.txt"];
  if (mismatch === "artifact-id") value.locales[0].result!.artifacts[1].id = value.locales[0].result!.artifacts[0].id;
  if (mismatch === "status") value.locales[0].status.execution = "failed";
  if (mismatch === "non-success" && value.locales[0].result) value.locales[0].result.outcome = "failed";
  invoke.mockResolvedValue(value);
  await expect(releaseCommands.savedBuild(pluginBuildWorkflow.savedRead)).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("round trips the shared delivery contracts through all seven adapters", async () => {
  const requestChecks = { session: validators.validateRequestSession,
    release: validators.validateRequestRelease, preview: validators.validateRequestPreview,
    export: validators.validateRequestExport, reconcile: validators.validateRequestReconcile };
  const responseChecks = { identity: validators.validateResponseIdentity, releases: validators.validateResponseReleases,
    selection: validators.validateResponseSelection, preview: validators.validateResponsePreview,
    delivery: validators.validateResponseDelivery, deliveries: validators.validateResponseDeliveries,
    deliveryAction: validators.validateResponseDeliveryAction };
  for (const [key, check] of Object.entries(requestChecks)) {
    const value = fixture.requests[key as keyof typeof fixture.requests];
    expect(check(value), `requests.${key}`).toBe(true);
    expect(check(JSON.parse(JSON.stringify(value))), key).toBe(true);
  }
  for (const [key, check] of Object.entries(responseChecks)) {
    const value = fixture.responses[key as keyof typeof fixture.responses];
    expect(check(value), `responses.${key}`).toBe(true);
    expect(check(JSON.parse(JSON.stringify(value))), key).toBe(true);
  }
  const cases = [
    ["read_delivery_action", fixture.requests.reconcile, fixture.responses.deliveryAction, () => releaseCommands.deliveryAction(fixture.requests.reconcile)],
    ["list_releases", fixture.requests.session, fixture.responses.releases, () => releaseCommands.releases(fixture.requests.session)],
    ["choose_delivery_folder", fixture.requests.session, fixture.responses.selection, () => releaseCommands.choose(fixture.requests.session)],
    ["preview_delivery", fixture.requests.preview, fixture.responses.preview, () => releaseCommands.preview(fixture.requests.preview)],
    ["export_release", fixture.requests.export, fixture.responses.delivery, () => releaseCommands.export(fixture.requests.export)],
    ["list_deliveries", fixture.requests.release, fixture.responses.deliveries, () => releaseCommands.deliveries(fixture.requests.release)],
    ["reconcile_delivery", fixture.requests.reconcile, fixture.responses.delivery, () => releaseCommands.reconcile(fixture.requests.reconcile)],
  ] as const;
  for (const [command, request, response, call] of cases) {
    invoke.mockResolvedValueOnce(response);
    expect(await call()).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith(command, { request });
  }
  invoke.mockResolvedValueOnce(null);
  expect(await releaseCommands.deliveryAction(fixture.requests.reconcile)).toBeNull();
});

it("preserves precise counts, Unicode, nulls and closed states in nested release data", () => {
  expect(fixture.responses.releases[0].sourceFiles[0].logicalPath).toContain("木桶 👩🏽‍💻 é");
  expect(validators.validateResponseSelection(null)).toBe(true);
  expect(validators.validateResponseDeliveryAction(null)).toBe(true);
  expect(validators.validateResponsePreview({ ...fixture.responses.preview, selectionId: "short" })).toBe(false);
  expect(validators.validateResponseReleases([{ ...fixture.responses.releases[0], unexpected: true }])).toBe(false);
  for (const entryCount of [0, 4294967295]) expect(validators.validateResponseReleases([{ ...fixture.responses.releases[0], artifacts: [{ ...fixture.responses.releases[0].artifacts[0], entryCount }] }])).toBe(true);
  for (const entryCount of [-1, 4294967296, 0.5]) expect(validators.validateResponseReleases([{ ...fixture.responses.releases[0], artifacts: [{ ...fixture.responses.releases[0].artifacts[0], entryCount }] }])).toBe(false);
  expect(validators.validateResponseReleases([{ ...fixture.responses.releases[0], exceptions: [{ ...fixture.responses.releases[0].exceptions[0], kind: "approved" }] }])).toBe(false);
  for (const state of ["pending", "succeeded", "partial", "failed", "unknown"]) expect(validators.validateResponseDelivery({ ...fixture.responses.delivery, state })).toBe(true);
  expect(validators.validateResponseDelivery({ ...fixture.responses.delivery, state: "completed" })).toBe(false);
  expect(validators.validateResponseDelivery({ ...fixture.responses.delivery, files: [{ ...fixture.responses.delivery.files[0], state: "partial" }] })).toBe(false);
  const missing = structuredClone(fixture.responses.delivery) as Record<string, unknown>;
  delete missing.files;
  expect(validators.validateResponseDelivery(missing)).toBe(false);
  expect(validators.validateResponsePreview({ ...fixture.responses.preview, files: [{ ...fixture.responses.preview.files[0], state: "unknown" }] })).toBe(false);
});

it("keeps malformed or misbound delivery acknowledgements unknown without replay", async () => {
  const other = fixture.responses.releases[0].sourceSnapshotId;
  const cases = [
    [{ ...fixture.responses.preview, releaseId: other }, () => releaseCommands.preview(fixture.requests.preview)],
    [{ ...fixture.responses.preview, selectionId: other }, () => releaseCommands.preview(fixture.requests.preview)],
    [{ ...fixture.responses.delivery, actionId: other }, () => releaseCommands.export(fixture.requests.export)],
    [{ ...fixture.responses.delivery, releaseId: other }, () => releaseCommands.export(fixture.requests.export)],
    [{ ...fixture.responses.delivery, overwriteConflicts: false }, () => releaseCommands.export(fixture.requests.export)],
    [null, () => releaseCommands.export(fixture.requests.export)],
    [[{ ...fixture.responses.delivery, releaseId: other }], () => releaseCommands.deliveries(fixture.requests.release)],
    [{ ...fixture.responses.delivery, actionId: other }, () => releaseCommands.reconcile(fixture.requests.reconcile)],
    [{ ...fixture.responses.deliveryAction, actionId: other }, () => releaseCommands.deliveryAction(fixture.requests.reconcile)],
  ] as const;
  for (const [response, call] of cases) {
    invoke.mockReset(); invoke.mockResolvedValue(response);
    const failure = await call().then(() => null, error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(hasUnknownOutcome(failure)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  }
});

it("retains cancellation, explicit unknown delivery and backend rejection semantics", async () => {
  invoke.mockResolvedValueOnce(null);
  expect(await releaseCommands.choose(fixture.requests.session)).toBeNull();
  const unknown = { ...fixture.responses.delivery, state: "unknown", files: fixture.responses.delivery.files.map(file => ({ ...file, actualSha256: null, state: "unknown" })) };
  invoke.mockResolvedValueOnce(unknown);
  expect(await releaseCommands.export(fixture.requests.export)).toEqual(unknown);
  const rejected = { code: "destination-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false };
  invoke.mockRejectedValueOnce(rejected);
  await expect(releaseCommands.export(fixture.requests.export)).rejects.toBe(rejected);
  expect(invoke).toHaveBeenCalledTimes(3);
});

function fixtureExceptionKind(kind: string): ReleaseExceptionKind {
  if (kind !== "source-fallback" && kind !== "qa-waiver") throw new Error("Invalid release exception fixture");
  return kind;
}
it("binds the entire preview vector and digest states to the saved release, regardless of display order", () => {
  const saved = fixture.responses.releases[0], preview = structuredClone(fixture.responses.preview) as DeliveryPreview;
  const release: ReleaseView = { ...saved, exceptions: saved.exceptions.map(value => ({ ...value, kind: fixtureExceptionKind(value.kind) })) };
  expect(() => confirmReleasePreview({ ...preview, files: [...preview.files].reverse() }, release, fixture.requests.preview.selectionId)).not.toThrow();
  const variants: DeliveryPreview[] = [
    { ...preview, files: preview.files.slice(0, 1) },
    { ...preview, files: [preview.files[0], preview.files[0]] },
    { ...preview, files: [{ ...preview.files[0], expectedSha256: "0".repeat(64) }, preview.files[1]] },
    { ...preview, files: [{ ...preview.files[0], state: "same" }, preview.files[1]] },
    { ...preview, files: [{ ...preview.files[0], fileName: "i18n/other.json" }, preview.files[1]] },
  ];
  variants.forEach(value => {
    expect(validators.validateResponsePreview(value)).toBe(true);
    expect(() => confirmReleasePreview(value, release, fixture.requests.preview.selectionId)).toThrow();
  });
});

it("checks aggregate results, all file identities and hashes, and preserves terminal evidence during reconciliation", () => {
  const receipt = structuredClone(fixture.responses.delivery) as DeliveryView, files = fixture.responses.preview.files;
  expect(() => confirmReleaseDelivery({ ...receipt, files: [...receipt.files].reverse() }, fixture.requests.export, files)).not.toThrow();
  const variants: DeliveryView[] = [
    { ...receipt, files: [] }, { ...receipt, files: [receipt.files[0], receipt.files[0]] },
    { ...receipt, files: [{ ...receipt.files[0], locale: "ja-JP" }, receipt.files[1]] },
    { ...receipt, files: [{ ...receipt.files[0], actualSha256: "0".repeat(64) }, receipt.files[1]] },
    { ...receipt, state: "succeeded" },
    { ...receipt, files: [{ ...receipt.files[0], state: "pending", actualSha256: null }, receipt.files[1]], state: "pending" },
  ];
  variants.forEach(value => {
    expect(validators.validateResponseDelivery(value)).toBe(true);
    expect(() => confirmReleaseDelivery(value, fixture.requests.export, files)).toThrow();
  });
  expect(() => confirmReleaseDelivery({ ...receipt, directory: "C:\\isolated\\other" }, fixture.requests.export, files, receipt)).toThrow();
  expect(() => confirmReleaseDelivery({ ...receipt, deliveryId: fixture.responses.releases[0].sourceSnapshotId }, fixture.requests.export, files, receipt)).toThrow();
  const unknown: DeliveryView = { ...receipt, state: "unknown", files: [receipt.files[0], { ...receipt.files[1], state: "unknown" }] };
  expect(() => confirmReleaseDelivery(receipt, fixture.requests.export, files, unknown)).not.toThrow();
  expect(() => confirmReleaseDelivery({ ...unknown, files: [{ ...unknown.files[0], state: "unknown", actualSha256: null }, unknown.files[1]] }, fixture.requests.export, files, unknown)).toThrow();
  expect(() => confirmReleaseDelivery({ ...receipt, files: [receipt.files[0], { ...receipt.files[1], actualSha256: "0".repeat(64) }] }, fixture.requests.export, files, unknown)).toThrow();
  const allUnknown: DeliveryView = { ...receipt, state: "unknown", files: receipt.files.map(file => ({ ...file, state: "unknown", actualSha256: null })) };
  const regressed: DeliveryView = { ...receipt, state: "pending", files: receipt.files.map(file => ({ ...file, state: "pending", actualSha256: null })) };
  expect(validators.validateResponseDelivery(regressed)).toBe(true);
  expect(() => confirmReleaseDelivery(regressed, fixture.requests.export, files, allUnknown)).toThrow();
});
