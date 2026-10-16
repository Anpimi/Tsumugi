import { beforeEach, expect, it, vi } from "vitest";
import { releaseCommands, type ArtifactCheckWorkflowPrepareRequest, type ArtifactCheckWorkflowStartRequest, type ArtifactCheckWorkflowView } from "./releaseCommands";
import { validateRequestArtifactWorkflowPrepare, validateRequestArtifactWorkflowStart } from "./generated/release.validators";
import { artifactWorkflowView, artifactWorkflowObservation, startArtifactWorkflow, proveArtifactWorkflowStep } from "./testSupport/artifactWorkflowFixture";
import { pluginBuildRequest, pluginBuildWorkflow } from "./testSupport/pluginBuildFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let prepare: ArtifactCheckWorkflowPrepareRequest, start: ArtifactCheckWorkflowStartRequest;
function firstStep(value: ArtifactCheckWorkflowView) {
  const item = value.steps[0];
  if (!item) throw new Error("Expected a materialized workflow step");
  return item;
}
beforeEach(() => {
  invoke.mockReset();
  const preparation: unknown = { ...pluginBuildWorkflow.session, preparation: {
    identity: { ownerId: fixtureIdentity(9000), generation: "1", workflowId: fixtureIdentity(9001) },
    buildAttemptId: fixtureIdentity(9002), buildInputDigest: "b".repeat(64), build: pluginBuildRequest,
    buildResults: [{ itemId: fixtureIdentity(9003), resultId: fixtureIdentity(9004) }, { itemId: fixtureIdentity(9005), resultId: fixtureIdentity(9006) }] } };
  if (!validateRequestArtifactWorkflowPrepare(preparation)) throw new Error("Invalid workflow preparation fixture");
  prepare = preparation;
  const view = artifactWorkflowView(prepare.preparation);
  const started: unknown = { ...pluginBuildWorkflow.session, start: { identity: prepare.preparation.identity, materializationDigest: view.materializationDigest,
    consents: view.steps.map((item, index) => ({ step: item.step, grantId: fixtureIdentity(9100 + index), expiresAtMs: "4102444800000", unsandboxedExecution: true })) } };
  if (!validateRequestArtifactWorkflowStart(started)) throw new Error("Invalid exact workflow start fixture");
  start = started;
});

it("uses the five typed endpoints and preserves the complete original start including each grant and expiry", async () => {
  const prepared = artifactWorkflowView(prepare.preparation), running = startArtifactWorkflow(artifactWorkflowView(prepare.preparation), start.start);
  const read = { ...pluginBuildWorkflow.session, preparation: prepare.preparation, start: start.start };
  const observation = artifactWorkflowObservation(running);
  const stopped = { identity: prepare.preparation.identity, admissionClosed: true, callbacksDrained: false, currentTask: running.currentTask };
  invoke.mockResolvedValueOnce({ kind: "available", ownerId: prepare.preparation.identity.ownerId, nextGeneration: "1", current: null })
    .mockResolvedValueOnce(prepared).mockResolvedValueOnce(running).mockResolvedValueOnce(observation).mockResolvedValueOnce(stopped);
  await releaseCommands.workflowSession(pluginBuildWorkflow.session);
  expect(await releaseCommands.prepareWorkflow(prepare)).toEqual(prepared);
  expect(await releaseCommands.startWorkflow(start, prepare.preparation)).toEqual(running);
  expect(await releaseCommands.readWorkflow(read)).toEqual(observation);
  expect(await releaseCommands.stopWorkflow({ ...pluginBuildWorkflow.session, identity: prepare.preparation.identity })).toEqual(stopped);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_artifact_check_workflow_session", "prepare_artifact_check_workflow",
    "start_artifact_check_workflow", "read_artifact_check_workflow", "stop_artifact_check_workflow"]);
  expect(invoke.mock.calls[2][1].request).toEqual(start);
});

it.each(["wrong-build", "missing-step", "wrong-producer", "wrong-checker", "wrong-digest"])("rejects a structurally valid but mismatched materialization: %s", async kind => {
  const value = artifactWorkflowView(prepare.preparation);
  if (kind === "wrong-build") value.preparation.buildAttemptId = fixtureIdentity(9300);
  if (kind === "missing-step") value.steps.pop();
  if (kind === "wrong-producer") firstStep(value).step.producerAttemptId = fixtureIdentity(9300);
  if (kind === "wrong-checker") firstStep(value).review.build.checker.provider.packageDigest = "f".repeat(64);
  if (kind === "wrong-digest") firstStep(value).review.inputDigest = "f".repeat(64);
  invoke.mockResolvedValue(value);
  await expect(releaseCommands.prepareWorkflow(prepare)).rejects.toThrow();
});

it("preserves an original reused producer instead of pretending the current build produced that result", async () => {
  const value = artifactWorkflowView(prepare.preparation), item = firstStep(value);
  item.step.producerAttemptId = fixtureIdentity(9400); item.step.producerInputDigest = "e".repeat(64);
  item.review.buildAttemptId = item.step.producerAttemptId;
  invoke.mockResolvedValue(value);
  expect(firstStep(await releaseCommands.prepareWorkflow(prepare)).step.producerAttemptId).toBe(fixtureIdentity(9400));
});

it.each(["missing-consent", "wrong-order", "wrong-grant", "open-absence", "missing-drain"])("rejects incomplete original reconciliation evidence: %s", async kind => {
  const running = startArtifactWorkflow(artifactWorkflowView(prepare.preparation), start.start);
  const value = artifactWorkflowObservation(running);
  let response: unknown = value;
  if (kind === "missing-consent") value.steps.pop();
  if (kind === "wrong-order") value.steps.reverse();
  if (kind === "wrong-grant" && value.view?.start) value.view.start.consents[0].grantId = fixtureIdentity(9300);
  if (kind === "open-absence") {
    const step = value.steps[0];
    if (!step) throw new Error("Expected an original observation step");
    value.steps[0] = { ...step, outcome: "not-enqueued", execution: null, resultId: null, proof: null };
  }
  if (kind === "missing-drain") response = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "callbacksDrained"));
  invoke.mockResolvedValue(response);
  await expect(releaseCommands.readWorkflow({ ...pluginBuildWorkflow.session, preparation: prepare.preparation, start: start.start })).rejects.toThrow();
});

it("preserves pending absence while admission is open and confirms closed absence without adopting another start", async () => {
  const prepared = artifactWorkflowView(prepare.preparation);
  invoke.mockResolvedValueOnce(artifactWorkflowObservation(prepared, start.start));
  const read = { ...pluginBuildWorkflow.session, preparation: prepare.preparation, start: start.start };
  expect((await releaseCommands.readWorkflow(read)).steps.every(item => item.outcome === "pending")).toBe(true);
  prepared.admissionClosed = true; prepared.phase = "stopped";
  invoke.mockResolvedValueOnce(artifactWorkflowObservation(prepared, start.start));
  expect((await releaseCommands.readWorkflow(read)).steps.every(item => item.outcome === "not-enqueued")).toBe(true);
  expect(invoke.mock.calls.every(([command]) => command === "read_artifact_check_workflow")).toBe(true);
});

it("keeps a nullable negative report and refuses an empty or unproved completed run", async () => {
  const view = startArtifactWorkflow(artifactWorkflowView(prepare.preparation), start.start);
  proveArtifactWorkflowStep(view, 0, false, false); view.phase = "paused"; view.admissionClosed = true; view.callbacksDrained = true;
  invoke.mockResolvedValueOnce(artifactWorkflowObservation(view));
  const read = { ...pluginBuildWorkflow.session, preparation: prepare.preparation, start: start.start };
  expect((await releaseCommands.readWorkflow(read)).view?.steps[0]?.proof?.checks).toBeNull();
  view.phase = "completed";
  invoke.mockResolvedValueOnce(view);
  await expect(releaseCommands.startWorkflow(start, prepare.preparation)).rejects.toThrow();
});
