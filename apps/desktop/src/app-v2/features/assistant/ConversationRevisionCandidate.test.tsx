import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import executionFixture from "../../../../test/fixtures/executionCommands.contract.json";
import translationFixture from "../../../../test/fixtures/translation-commands.json";
import type { ConversationPlanningRun } from "../../../conversationCommands";
import { executionCommands } from "../../../executionCommands";
import { i18n } from "../../../i18n";
import { reviewCommands } from "../../../reviewCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { translationCommands, type TranslationRevision } from "../../../translationCommands";
import { ConversationRevisionCandidate } from "./ConversationRevisionCandidate";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("compares the verified saved candidate with its original translation when the current entry is unavailable", async () => {
  await i18n.changeLanguage("en-US");
  const { attemptId, unitId, resultIds: [resultId] } = executionFixture.prepare;
  const revision: TranslationRevision = { ...translationFixture.receipt.revision, originKind: "ai",
    actionId: resultId, attemptId, resultId, itemId: unitId, text: "Suggested wording" };
  const basis = { unitId: revision.unitId, locale: revision.locale, sourceSnapshotId: revision.sourceSnapshotId,
    sourceRevisionId: revision.sourceRevisionId, selectionId: translationFixture.receipt.selection.eventId,
    translationRevisionId: translationFixture.receipt.selection.revisionId };
  const run = {
    detail: { ...executionFixture.detail, operation: "conversation-planning", recovery: {
      attemptId, units: [{ ...executionFixture.detail.recovery.units[0], unitId, resultIds: [resultId], actions: ["view-receipt"] }],
    } },
    resultId,
    receipt: { consent: { actionId: unitId } },
    preview: { input: JSON.stringify({ selectedTranslation: "Original saved wording" }) },
    output: { model: { kind: "revision", text: revision.text } },
  } as ConversationPlanningRun;
  vi.spyOn(reviewCommands, "target").mockRejectedValue(new Error("Current entry unavailable"));
  vi.spyOn(executionCommands, "adoptionAction").mockResolvedValue({
    action: { ...executionFixture.action, actionId: resultId, operation: "conversation-planning", parameters: null },
    receipt: { ...executionFixture.receipt, actionId: resultId,
      changes: [{ kind: "translation-revision", id: revision.revisionId, revision: revision.ordinal }] },
  });
  vi.spyOn(translationCommands, "revision").mockResolvedValue(revision);
  const onOpen = vi.fn(async () => true);
  const context = executionFixture.session, reads = new SessionReads(context);
  try {
    render(<SessionReadProvider context={context} reads={reads} bridge={false}>
      <ConversationRevisionCandidate run={run} basis={basis} runKey={["original-run"]} visible current={() => true} onOpen={onOpen}/>
    </SessionReadProvider>);
    const summary = await screen.findByText(i18n.t("conversation.revisionHistoricalCompare"));
    const comparison = summary.closest("details")!;
    comparison.open = true;
    expect(within(comparison).getByText("Original saved wording")).toBeVisible();
    expect(within(comparison).getByText("Suggested wording")).toBeVisible();
    expect(screen.queryByRole("button", { name: i18n.t("conversation.revisionCandidateCompare") })).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  } finally { reads.retire(); }
});
