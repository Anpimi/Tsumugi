import { conversationCommands } from "../../../conversationCommands";
import type { SessionRequest } from "../../../executionCommands";
import type { ConversationKnowledgeProposalRef } from "../assistant/conversationNavigation";
import type { KnowledgeReviewTarget } from "./KnowledgeProposalPanel";

/** Read the exact version and its model result; this grants no adoption permission. */
export async function resolveKnowledgeReview(context: SessionRequest, proposal: ConversationKnowledgeProposalRef, entryIndex: number | null,
  current: () => boolean, commands: Pick<typeof conversationCommands, "readProposal" | "readPlanning"> = conversationCommands,
) {
  function present() { if (!current() || proposal.projectId !== context.projectId) throw new Error("Knowledge proposal navigation changed"); }
  present(); const revision = await commands.readProposal({ ...context, ...proposal }); present();
  if (revision.projectId !== context.projectId || revision.conversationId !== proposal.conversationId || revision.proposalId !== proposal.proposalId || revision.revisionId !== proposal.revisionId
    || revision.content.kind !== "knowledge-proposal" || !revision.content.entries.length || entryIndex !== null && (!Number.isInteger(entryIndex) || entryIndex < 0 || !revision.content.entries[entryIndex])) throw new Error("Invalid knowledge proposal target");
  const run = await commands.readPlanning({ ...context, conversationId: proposal.conversationId, attemptId: revision.origin.attemptId }); present();
  if (!run || run.resultId !== revision.origin.resultId || run.preview.purpose !== "knowledge" || run.preview.scope.kind !== "units") throw new Error("Invalid knowledge proposal material");
  const latest = await commands.readProposal({ ...context, ...proposal, revisionId: null }); present();
  if (latest.projectId !== context.projectId || latest.conversationId !== proposal.conversationId || latest.proposalId !== proposal.proposalId) throw new Error("Invalid knowledge proposal head");
  // Older versions remain readable. The review surface also reads this head
  // and disables decisions until its exact version is current.
  const entry = revision.content.entries[entryIndex ?? 0], target: KnowledgeReviewTarget = { proposal, entryIndex };
  return { target, locale: run.preview.scope.locale, preset: entry.kind === "character" ? "characters" : entry.kind };
}
