import { conversationCommands } from "../../../conversationCommands";
import type { SessionRequest } from "../../../executionCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import { resourceCommands } from "../../../resourceCommands";
import type { ConversationKnowledgeProposalRef } from "../assistant/conversationNavigation";

/** Saving a proposal already captures its terms. Opening review only reads it. */
export async function resolveTermProposalReview(context: SessionRequest, proposal: ConversationKnowledgeProposalRef, current: () => boolean,
  commands = { proposal: conversationCommands.readProposal, planning: conversationCommands.readPlanning, preview: resourceCommands.preview },
) {
  function present() { if (!current() || proposal.projectId !== context.projectId) throw new Error("Term proposal navigation changed"); }
  present();
  const revision = await commands.proposal({ ...context, ...proposal }); present();
  if (revision.projectId !== proposal.projectId || revision.conversationId !== proposal.conversationId || revision.proposalId !== proposal.proposalId
    || revision.revisionId !== proposal.revisionId || revision.content.kind !== "term-proposal") throw new Error("Invalid term proposal target");
  const [run, preview] = await Promise.all([
    commands.planning({ ...context, conversationId: proposal.conversationId, attemptId: revision.origin.attemptId }),
    commands.preview({ ...context, captureId: proposal.revisionId }),
  ]); present();
  if (!run || run.resultId !== revision.origin.resultId || run.receipt.inputDigest !== revision.origin.inputDigest
    || run.preview.purpose !== "terminology" || run.preview.scope.kind !== "units" || run.output?.model.kind !== "term-proposal"
    || jsonIdentity(run.output.model.entries) !== jsonIdentity(revision.content.entries)
    || preview.capture.captureId !== proposal.revisionId || preview.capture.origin.kind !== "conversation"
    || jsonIdentity(preview.capture.origin.proposal) !== jsonIdentity(proposal)
    || jsonIdentity(preview.capture.origin.modelOrigin) !== jsonIdentity(revision.origin)
    || preview.capture.targetLocale !== run.preview.scope.locale) throw new Error("Invalid term proposal material");
  return preview.capture;
}
