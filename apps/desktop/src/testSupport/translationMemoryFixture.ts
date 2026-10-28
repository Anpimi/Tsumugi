import fixture from "../../test/fixtures/translation-commands.json";
import type { ReviewTarget } from "../reviewCommands";
import type { TmSuggestion, TranslationMemoryEntry, TranslationMemoryReusePreview } from "../resourceCommands";
import { fixtureIdentity as id } from "./executionFixture";
import { reviewDecisionFixture, reviewTargetFixture } from "./reviewFixture";

export function translationMemoryEntryFixture(suggestion?: TmSuggestion): TranslationMemoryEntry {
  const revision: TranslationMemoryEntry["revision"] = { ...fixture.receipt.revision, unitId: suggestion?.unitId ?? id(97001), revisionId: suggestion?.translationRevisionId ?? id(97002),
    sourceRevisionId: suggestion?.sourceRevisionId ?? id(97003), locale: suggestion?.targetLocale ?? fixture.save.locale,
    text: suggestion?.translationText ?? "A quiet farewell, {name}.", originKind: suggestion?.originKind ?? "manual", candidateDecision: null };
  const target = reviewTargetFixture({ unitId: revision.unitId, locale: revision.locale, sourceRevisionId: revision.sourceRevisionId,
    sourceSnapshotId: revision.sourceSnapshotId, revisionId: revision.revisionId, selectionId: id(97004), translationText: revision.text, basis: "c".repeat(64) });
  const approval = suggestion?.hasHumanApproval ? reviewDecisionFixture({ projectId: fixture.save.projectId, unitId: target.unitId, locale: target.locale,
    actionId: id(97005), expectedBasis: target.basis, expectedDecisionId: null, actor: "Synthetic reviewer", reason: "Checked this version", kind: "approve" }, target) : null;
  return { projectId: fixture.save.projectId, basis: "e".repeat(64), sourceLocale: "en", sourceText: suggestion?.sourceText ?? "A farewell for {name}.",
    sourceLabel: { namespace: "synthetic-dialogue", nativeKey: "dialogue.farewell", occurrenceCount: 1 }, isCurrentSource: true,
    revision, isCurrentSelection: suggestion?.isCurrentSelection ?? true,
    quality: { latestDecision: approval, pastApproval: approval, currentApproval: approval } };
}
export function translationMemoryReuseFixture(target: ReviewTarget, donor = translationMemoryEntryFixture()): TranslationMemoryReusePreview {
  return { target, donor, reuseOrigin: { targetSourceSnapshotId: target.sourceSnapshotId, targetUnitId: target.unitId,
    targetSourceRevisionId: target.sourceRevisionId, targetSelectionId: target.selectionId, donorUnitId: donor.revision.unitId,
    donorSourceRevisionId: donor.revision.sourceRevisionId, donorTranslationRevisionId: donor.revision.revisionId, donorBasis: donor.basis } };
}
