import { expect, it } from "vitest";
import type { ConversationReferencePage } from "../../../conversationCommands";
import { conversationProposalFixture } from "../../../testSupport/conversationProposalFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { materialEntryReference, materialReferenceIdentity, referencesMatchPlanning } from "./materialReferenceReads";

function fixture() {
  const { run } = conversationProposalFixture({ projectId: id(71000), conversationId: id(71001) });
  const source = run.preview.units[0], revisionId = id(71002);
  source.sharedTermRevisionIds = [revisionId];
  const unit = { unitId: source.unitId, locale: "zh-CN", sourceSnapshotId: source.sourceSnapshotId, sourceRevisionId: source.sourceRevisionId };
  const page: ConversationReferencePage = { projectId: run.preview.projectId, conversationId: run.preview.conversationId,
    attemptId: run.detail.attemptId, inputDigest: run.receipt.inputDigest, currentSnapshotId: unit.sourceSnapshotId, after: 0, total: 2, nextAfter: null,
    rows: [{ kind: "term", unit, original: { termId: "term-one", revisionId, source: "Harbor", target: "Original harbor", protected: false, originKind: "manual", removed: false }, current: null },
      { kind: "file", unit: { ...unit }, artifactId: id(71003), logicalPath: "dialogue/chapter.txt", role: "source" }] };
  return { run, page };
}

it("matches original unit and term evidence and produces distinct references to the context tab", () => {
  const { run, page } = fixture();
  expect(referencesMatchPlanning(page, run)).toBe(true);
  expect(materialReferenceIdentity(page.rows[0])).not.toEqual(materialReferenceIdentity(page.rows[1]));
  for (const row of page.rows) expect(materialEntryReference(run, row)).toEqual({ projectId: page.projectId, conversationId: page.conversationId,
    attemptId: page.attemptId, ...row.unit, detailTab: "context" });
});

it.each(["project", "conversation", "attempt", "digest", "unit", "locale", "snapshot", "revision", "term", "scope"] as const)(
  "rejects a %s mismatch against the original planning material", field => {
    const { run, page } = fixture(), row = page.rows[0];
    if (field === "project") page.projectId = id(71900);
    if (field === "conversation") page.conversationId = id(71900);
    if (field === "attempt") page.attemptId = id(71900);
    if (field === "digest") page.inputDigest = "c".repeat(64);
    if (field === "unit") row.unit.unitId = id(71900);
    if (field === "locale") row.unit.locale = "ja-JP";
    if (field === "snapshot") row.unit.sourceSnapshotId = id(71900);
    if (field === "revision") row.unit.sourceRevisionId = id(71900);
    if (field === "term" && row.kind === "term") row.original.revisionId = id(71900);
    if (field === "scope") run.preview.scope = { kind: "conversation-only" };
    expect(referencesMatchPlanning(page, run)).toBe(false);
  },
);
