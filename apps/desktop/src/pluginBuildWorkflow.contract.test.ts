import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/pluginBuildWorkflow.contract.json";
import { releaseCommands } from "./releaseCommands";
import * as validators from "./generated/release.validators";
import { hasUnknownOutcome } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it("validates Rust workflow fixtures and invokes the six installed build adapters", async () => {
  expect(validators.validateRequestPluginBuild(fixture.prepare)).toBe(true);
  expect(validators.validateResponsePluginBuild(fixture.review)).toBe(true);
  expect(validators.validateRequestPluginStart(fixture.start)).toBe(true);
  expect(validators.validateRequestArtifactCheck(fixture.prepareCheck)).toBe(true);
  expect(validators.validateResponseArtifactCheck(fixture.checkReview)).toBe(true);
  expect(validators.validateRequestFinishArtifactCheck(fixture.finishCheck)).toBe(true);
  const cases = [
    ["prepare_plugin_build", fixture.prepare, fixture.review, () => releaseCommands.preparePlugin(fixture.prepare)],
    ["start_plugin_build", fixture.start, fixture.start.attemptId, () => releaseCommands.startPlugin(fixture.start)],
    ["prepare_artifact_check", fixture.prepareCheck, fixture.checkReview, () => releaseCommands.prepareCheck(fixture.prepareCheck)],
    ["start_artifact_check", fixture.startCheck, fixture.startCheck.attemptId, () => releaseCommands.startCheck(fixture.startCheck)],
    ["finish_artifact_check", fixture.finishCheck, null, () => releaseCommands.finishCheck(fixture.finishCheck)],
    ["cancel_plugin_build_preparation", fixture.session, true, () => releaseCommands.cancelPluginPreparation(fixture.session)],
  ] as const;
  for (const [command, request, response, call] of cases) {
    invoke.mockResolvedValueOnce(response);
    expect(await call()).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith(command, { request });
  }
});

it("refuses open fields, malformed artifact scope and imprecise metadata", () => {
  for (const extra of ["approved", "renewGrant", "directory"]) {
    expect(validators.validateRequestPluginStart({ ...fixture.start, [extra]: true })).toBe(false);
    expect(validators.validateRequestPluginBuild({ ...fixture.prepare, [extra]: true })).toBe(false);
  }
  for (const byteLength of [-1, 0.5, 4294967296]) {
    expect(validators.validateResponseArtifactCheck({ ...fixture.checkReview, artifacts: [{ ...fixture.checkReview.artifacts[0], byteLength }] })).toBe(false);
  }
  expect(validators.validateResponseArtifactCheck({ ...fixture.checkReview, artifacts: [{ ...fixture.checkReview.artifacts[0], unknown: true }] })).toBe(false);
  expect(validators.validateResponseFinishArtifactCheck(null)).toBe(true);
  expect(validators.validateResponseFinishArtifactCheck(true)).toBe(false);
  expect(validators.validateResponseCancelPluginBuild(null)).toBe(false);
});

it("keeps substituted attempts, choices and bindings unknown without replay", async () => {
  const other = fixture.finishCheck.resultId;
  const choices = structuredClone(fixture.review.choices);
  choices[0].outputPaths[0] = "changed.txt";
  const alteredBuild = structuredClone(fixture.review.build);
  alteredBuild.checker.provider.packageDigest = "f".repeat(64);
  const cases = [
    [{ ...fixture.review, attemptId: other }, () => releaseCommands.preparePlugin(fixture.prepare)],
    [{ ...fixture.review, eligibilityBasis: "f".repeat(64) }, () => releaseCommands.preparePlugin(fixture.prepare)],
    [{ ...fixture.review, choices }, () => releaseCommands.preparePlugin(fixture.prepare)],
    [{ ...fixture.review, build: alteredBuild }, () => releaseCommands.preparePlugin(fixture.prepare)],
    [other, () => releaseCommands.startPlugin(fixture.start)],
    [other, () => releaseCommands.startCheck(fixture.startCheck)],
    [{ ...fixture.checkReview, buildResultId: other }, () => releaseCommands.prepareCheck(fixture.prepareCheck)],
    [{ ...fixture.checkReview, buildAttemptId: other }, () => releaseCommands.prepareCheck(fixture.prepareCheck)],
    [{ ...fixture.checkReview, attemptId: other }, () => releaseCommands.prepareCheck(fixture.prepareCheck)],
    [{ ...fixture.checkReview, build: { ...fixture.review.build, environmentDigest: "f".repeat(64) } }, () => releaseCommands.prepareCheck(fixture.prepareCheck)],
    [true, () => releaseCommands.finishCheck(fixture.finishCheck)],
  ] as const;
  for (const [response, call] of cases) {
    invoke.mockReset(); invoke.mockResolvedValue(response);
    const failure = await call().then(() => null, error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(hasUnknownOutcome(failure)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  }
});

it("retains backend rejection and preparation cancellation outcomes", async () => {
  const rejected = { code: "permission-denied", stage: "execution-recover", outcome: "rejected", recoveryRequired: false };
  invoke.mockRejectedValueOnce(rejected);
  await expect(releaseCommands.startCheck(fixture.startCheck)).rejects.toBe(rejected);
  invoke.mockResolvedValueOnce(false);
  expect(await releaseCommands.cancelPluginPreparation(fixture.session)).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(2);
});
