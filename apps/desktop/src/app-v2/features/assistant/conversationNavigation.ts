import type { ConversationProposalRevision } from "../../../conversationCommands";

export interface ConversationProposalTarget {
  conversationId: string;
  proposalId: string;
  revisionId: string;
  focus: boolean;
}
export interface ConversationTeamQuestionTarget {
  conversationId: string;
  planId: string;
  questionPostId: string;
  focus: boolean;
  /** Transient UI witness. Never persist or send this DOM reference over IPC. */
  origin?: Element | null;
}
export type ConversationKnowledgeProposalRef = Pick<ConversationProposalRevision, "projectId" | "conversationId" | "proposalId" | "revisionId">;
export type OpenKnowledgeProposal = (proposal: ConversationKnowledgeProposalRef, current: () => boolean) => Promise<boolean>;
export type OpenTermProposal = OpenKnowledgeProposal;
