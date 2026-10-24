import type { ArtifactCheckWorkflowPreparation, ArtifactCheckWorkflowStart, ArtifactCheckWorkflowView,
  ArtifactCheckWorkflowObservation } from "../releaseCommands";
import { validateResponseArtifactWorkflow, validateResponseArtifactWorkflowObservation } from "../generated/release.validators";
import { pluginBuildWorkflow, savedPluginBuild } from "./pluginBuildFixture";
import { fixtureIdentity } from "./executionFixture";

export function artifactWorkflowView(preparation: ArtifactCheckWorkflowPreparation): ArtifactCheckWorkflowView {
  const value: unknown = {
    preparation: structuredClone(preparation), materializationDigest: "a".repeat(64), phase: "prepared", start: null,
    admissionClosed: false, callbacksDrained: true, currentTask: null, error: null,
    steps: preparation.buildResults.map((result, index) => {
      const locale = index === 0 ? "zh-CN" : "fr-FR", attemptId = fixtureIdentity(4000 + index), inputDigest = (index === 0 ? "c" : "d").repeat(64);
      return { ordinal: index, step: { locale, buildItemId: result.itemId, buildResultId: result.resultId,
        producerAttemptId: preparation.buildAttemptId, producerInputDigest: preparation.buildInputDigest,
        taskId: fixtureIdentity(4100 + index), attemptId, inputDigest }, buildResultDigest: "b".repeat(64), selected: false,
        phase: "prepared", proof: null, error: null,
        review: { ...structuredClone(pluginBuildWorkflow.checkReview), attemptId, inputDigest, buildAttemptId: preparation.buildAttemptId,
          buildResultId: result.resultId, locale, artifacts: [{ id: "artifact", role: "deliverable", logicalPath: `${locale}.txt`, byteLength: 12, sha256: "e".repeat(64) }] } };
    }),
  };
  if (!validateResponseArtifactWorkflow(value)) throw new Error("Invalid materialized artifact workflow fixture");
  return value;
}

export function startArtifactWorkflow(view: ArtifactCheckWorkflowView, start: ArtifactCheckWorkflowStart) {
  view.start = structuredClone(start); view.phase = "running"; view.callbacksDrained = false;
  for (const item of view.steps) { item.selected = start.consents.some(consent => consent.step.attemptId === item.step.attemptId); item.phase = item.selected ? "waiting" : "not-selected"; }
  const item = view.steps.find(item => item.selected);
  if (!item) throw new Error("Expected an explicitly selected workflow step");
  item.phase = "enqueued"; view.currentTask = { taskId: item.step.taskId, attemptId: item.step.attemptId };
  return view;
}

export function proveArtifactWorkflowStep(view: ArtifactCheckWorkflowView, index: number, valid = true, reportAvailable = true) {
  const item = view.steps[index];
  item.phase = valid ? "proved" : "failed";
  item.proof = { checkerAttemptId: item.step.attemptId, checkerInputDigest: item.step.inputDigest,
    checkerResultId: fixtureIdentity(4200 + index), checkerResultDigest: "f".repeat(64),
    checker: structuredClone(savedPluginBuild.build.checkerExecution), valid,
    checks: reportAvailable ? item.review.requirements.map(requirement => ({ key: structuredClone(requirement.key),
      inputDigest: requirement.inputDigest, scopeDigest: requirement.scopeDigest, coveredTargets: [...requirement.targets],
      outcome: valid ? { kind: "completed", findings: [] } : { kind: "failed" } })) : null };
}

export function artifactWorkflowObservation(view: ArtifactCheckWorkflowView, requestedStart: ArtifactCheckWorkflowStart | null = view.start): ArtifactCheckWorkflowObservation {
  const value: unknown = { identity: view.preparation.identity, kind: "current", admissionClosed: view.admissionClosed,
    callbacksDrained: view.callbacksDrained, currentTask: view.currentTask, view: structuredClone(view),
    steps: (requestedStart?.consents ?? []).map(consent => {
      const item = view.steps.find(item => item.step.attemptId === consent.step.attemptId);
      if (!item) throw new Error("Expected an original materialized step");
      const enqueued = ["enqueued", "recording", "proved", "failed", "unknown", "cancelled"].includes(item.phase);
      return { step: item.step, outcome: enqueued ? "enqueued" : view.admissionClosed ? "not-enqueued" : "pending",
        execution: enqueued ? item.phase === "unknown" ? "unknown" : item.phase === "proved" ? "succeeded" : item.phase === "failed" ? "failed" : "dispatched" : null,
        resultId: item.proof?.checkerResultId ?? null, proof: item.proof };
    }) };
  if (!validateResponseArtifactWorkflowObservation(value)) throw new Error("Invalid artifact workflow observation fixture");
  return value;
}
