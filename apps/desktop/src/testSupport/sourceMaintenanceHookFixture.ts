import fixture from "../../test/fixtures/sourceCommands.contract.json";
import type { ProjectView } from "../projectCommands";
import type { SourceMaintenanceHookActivation, SourceMaintenanceHookObservation } from "../sourceMaintenanceHookCommands";
import type { MaintenanceAssessment } from "../workPlanCommands";
import { fixtureIdentity as id } from "./executionFixture";

export const hookProject: ProjectView = { ...fixture.session, locator: "isolated-source-hook", reconciliationState: "settled",
  metadata: { projectId: fixture.session.projectId, displayName: "Synthetic source notice", sourceLocale: "en", targetLocales: ["zh-CN", "fr"], metadataRevision: "1" } };
export function hookActivation(): SourceMaintenanceHookActivation {
  return { policyVersion: "source-maintenance-notice-1", sessionEpoch: id(8800), locale: "zh-CN", after: 0, limit: 100, expiresAtMs: Date.now() + 300_000 };
}
export function hookAssessment(): MaintenanceAssessment {
  return { projectId: hookProject.metadata.projectId, sourceSnapshotId: id(8801), locale: "zh-CN", after: 0, limit: 100, nextOrdinal: 100,
    coverage: "finite-current-source-window; explicit-unit-and-literal-possible-resource-impact; historical-and-external-query-coverage-unknown", digest: "a".repeat(64),
    rows: [1, 2, 3].map(index => ({ unitId: id(8810 + index), sourceRevisionId: id(8820 + index), nativeKey: `Notice entry ${index}`,
      sourceText: `Synthetic source ${index}`, translationText: null, selectionId: null, translationRevisionId: null, reviewBasis: "b".repeat(64),
      protection: { unitId: id(8810 + index), locale: "zh-CN", revision: "1", protected: index === 2 }, mappingUnresolved: index === 3,
      reasons: [index === 3 ? "correspondence-unresolved" : "translation-missing"], suggested: index === 3 ? "unresolved" : "repair" })) };
}
export function hookObservation(sourceActionId = fixture.prepare.actionId, activation = hookActivation(), phase: NonNullable<SourceMaintenanceHookObservation["view"]>["phase"] = "observed"): SourceMaintenanceHookObservation {
  const cause = { projectId: hookProject.metadata.projectId, sourceActionId, attemptId: fixture.prepare.attemptId, resultId: fixture.prepare.resultId,
    resultDigest: fixture.prepare.confirmation.resultDigest, sourceSnapshotId: id(8801), contentRevision: "2" };
  const prepared = phase === "prepared";
  return { sourceActionId, state: prepared ? "prepared" : "adopted", callbacksDrained: phase !== "running", error: null,
    view: { sourceActionId, activation, cause: prepared ? null : cause, phase, admissionClosed: phase === "observed" || phase === "stopped", stop: null,
      outcome: phase === "observed" ? { runId: id(8802), cause: { ...cause }, activation: { ...activation }, phase: "observed", assessment: hookAssessment(), error: null } : null } };
}
