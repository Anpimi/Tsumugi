import type { ConversationProposalRevision } from "../../../conversationCommands";

export interface ConversationProposalTarget {
  conversationId: string;
  proposalId: string;
  revisionId: string;
  focus: boolean;
}
export type ConversationKnowledgeProposalRef = Pick<ConversationProposalRevision, "projectId" | "conversationId" | "proposalId" | "revisionId">;
export type OpenKnowledgeProposal = (proposal: ConversationKnowledgeProposalRef, current: () => boolean) => Promise<boolean>;
