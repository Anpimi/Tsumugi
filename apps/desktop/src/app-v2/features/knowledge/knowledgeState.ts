import { contextResourceDirty } from "../../../contextResourceDrafts";
import { knowledgeProposalDirty } from "../../../knowledgeProposalDrafts";
import type { KnowledgeOwner } from "./knowledgeTypes";

export function knowledgeBlocked(owner: KnowledgeOwner) {
  const state = owner.current();
  return owner.inFlight() || state.busyMutation || !!state.pending || !!state.factPending || !!state.checkingAction || owner.tool.blocked();
}
export function knowledgeHasDraft(owner: KnowledgeOwner) {
  return owner.termDirty() || owner.contextDirty() || owner.correctionDirty() || owner.factDirty() || owner.tool.hasDraft() || owner.contextResources.hasDrafts() || owner.knowledgeProposals.hasDrafts();
}

export function knowledgeRecovery(owner: KnowledgeOwner | null) {
  const state = owner?.current();
  if (!state) return { locale: undefined, preset: "terms", key: null, proposalKey: null };
  const proposalPending = state.pending?.kind === "knowledge-decision" ? state.pending : null;
  const selectedProposal = state.knowledgeActiveKey ? state.knowledgeDrafts[state.knowledgeActiveKey] : null;
  const proposalDraft = proposalPending ? state.knowledgeDrafts[proposalPending.draftKey] : selectedProposal && knowledgeProposalDirty(selectedProposal) ? selectedProposal : Object.values(state.knowledgeDrafts).find(knowledgeProposalDirty);
  if (proposalDraft && (!state.pending || proposalPending)) return { locale: proposalDraft.locale, preset: proposalDraft.entry.kind === "character" ? "characters" : proposalDraft.entry.kind, key: null, proposalKey: proposalDraft.key };
  if (state.pending && state.pending.kind !== "typed-context") return { locale: state.locale, preset: "terms", key: null, proposalKey: null };
  const pending = state.pending?.kind === "typed-context" ? state.pending : null;
  const active = state.typedActiveKey ? state.typedDrafts[state.typedActiveKey] : null;
  const draft = pending ? state.typedDrafts[pending.draftKey] : active && contextResourceDirty(active) ? active : Object.values(state.typedDrafts).find(contextResourceDirty);
  return draft ? { locale: draft.locale, preset: draft.kind === "character" ? "characters" : draft.kind, key: draft.key, proposalKey: null } : { locale: state.locale, preset: "terms", key: null, proposalKey: null };
}
