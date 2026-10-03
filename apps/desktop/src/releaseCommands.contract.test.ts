import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/releaseCommands.contract.json";
import { releaseCommands } from "./releaseCommands";
import * as validators from "./generated/release.validators";
import { hasUnknownOutcome } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it("round trips the shared build and delivery contracts through all seven adapters", async () => {
  const requestChecks = { session: validators.validateRequestSession, build: validators.validateRequestBuild,
    release: validators.validateRequestRelease, preview: validators.validateRequestPreview,
    export: validators.validateRequestExport, reconcile: validators.validateRequestReconcile };
  const responseChecks = { identity: validators.validateResponseIdentity, releases: validators.validateResponseReleases,
    selection: validators.validateResponseSelection, preview: validators.validateResponsePreview,
    delivery: validators.validateResponseDelivery, deliveries: validators.validateResponseDeliveries };
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
    ["start_locale_build", fixture.requests.build, fixture.responses.identity, () => releaseCommands.start(fixture.requests.build)],
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
});

it("preserves precise counts, Unicode, nulls and closed states in nested release data", () => {
  expect(fixture.responses.releases[0].sourceFiles[0].logicalPath).toContain("木桶 👩🏽‍💻 é");
  expect(validators.validateResponseSelection(null)).toBe(true);
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

it("keeps malformed or misbound build and delivery acknowledgements unknown without replay", async () => {
  const other = fixture.responses.releases[0].sourceSnapshotId;
  const cases = [
    [other, () => releaseCommands.start(fixture.requests.build)],
    [{ ...fixture.responses.preview, releaseId: other }, () => releaseCommands.preview(fixture.requests.preview)],
    [{ ...fixture.responses.preview, selectionId: other }, () => releaseCommands.preview(fixture.requests.preview)],
    [{ ...fixture.responses.delivery, actionId: other }, () => releaseCommands.export(fixture.requests.export)],
    [{ ...fixture.responses.delivery, releaseId: other }, () => releaseCommands.export(fixture.requests.export)],
    [{ ...fixture.responses.delivery, overwriteConflicts: false }, () => releaseCommands.export(fixture.requests.export)],
    [null, () => releaseCommands.export(fixture.requests.export)],
    [[{ ...fixture.responses.delivery, releaseId: other }], () => releaseCommands.deliveries(fixture.requests.release)],
    [{ ...fixture.responses.delivery, actionId: other }, () => releaseCommands.reconcile(fixture.requests.reconcile)],
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
