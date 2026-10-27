import { reviewCommands } from "../../../reviewCommands";
import { sourceCommands } from "../../../sourceCommands";
import { semanticReviewRead } from "../../../aiSemanticReviewQueries";
import { reviewFindingsRead } from "../../../reviewQueries";
import { diagnosticMatchesEditor, validDiagnosticSelection } from "../../../reviewDiagnosticNavigation";
import type { SessionReads } from "../../../sessionReads";
import type { EntryReviewEditorRequest } from "./navigationTypes";

/** Fresh read admission; this never starts QA, edits a draft, or renews model authorization. */
export async function readEditorNavigation(reads: SessionReads, input: EntryReviewEditorRequest, current: () => boolean) {
  const target = input.target, diagnostic = input.diagnostic;
  const origin = diagnostic?.intent.source.purpose === "ai-semantic" ? diagnostic.intent.source.origin : null;
  const [source, snapshot, semantic, findings] = await Promise.all([
    sourceCommands.scope(reads.context),
    reviewCommands.editorSnapshot({ ...reads.context, unitId: target.unitId, locale: target.locale }),
    origin ? semanticReviewRead(reads.context, origin.attemptId).read() : undefined,
    origin ? reviewFindingsRead(reads.context, target.unitId, target.locale).read() : undefined,
  ]);
  if (!current() || reads.retired || snapshot.target.unitId !== target.unitId || snapshot.target.locale !== target.locale
    || snapshot.translations.unitId !== target.unitId || snapshot.translations.locale !== target.locale
    || source.currentSnapshot !== snapshot.target.sourceSnapshotId) return null;
  if (diagnostic) {
    const anchor = { diagnostic: diagnostic.intent, value: diagnostic.location, sourceText: target.sourceText, translationText: target.translationText };
    const text = diagnostic.location.location.field === "source" ? target.sourceText : target.translationText;
    if (text === null || !validDiagnosticSelection(text, diagnostic.location.location.range)
      || !diagnosticMatchesEditor(anchor, snapshot, origin ? { view: semantic, findings } : undefined)) return null;
  }
  return snapshot;
}
