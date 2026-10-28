import review from "../../test/fixtures/reviewCommands.contract.json";
import type { ContextResourceCapture, ContextResourceRevision } from "../resourceCommands";
import { fixtureIdentity } from "./executionFixture";

export function contextResourceFixture(overrides: Partial<ContextResourceRevision> = {}): ContextResourceRevision {
  return { projectId: review.requests.target.projectId, contextId: fixtureIdentity(75001), subjectId: fixtureIdentity(75002),
    revisionId: fixtureIdentity(75003), previousRevisionId: null, actionId: fixtureIdentity(75004),
    kind: "character", locale: "zh-CN", scope: { kind: "project" }, sourceBasis: { revision: "1", currentSnapshot: review.responses.editor.target.sourceSnapshotId },
    name: "Mara", text: "Keep a calm tone.", actor: "Recorder audit data", reason: "Reason audit data", withdrawn: false, ...overrides };
}

export function contextResourceCaptureFixture(entries: ContextResourceCapture["entries"]): ContextResourceCapture {
  const target = review.responses.editor.target;
  return { scope: { projectId: review.requests.target.projectId, unitId: target.unitId, locale: target.locale,
    sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId }, entries };
}
