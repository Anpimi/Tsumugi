import type { KnowledgeOwner } from "./knowledgeTypes";

export function knowledgeBlocked(owner: KnowledgeOwner) {
  const state = owner.current();
  return owner.inFlight() || state.busyMutation || !!state.pending || !!state.factPending || !!state.checkingAction || owner.tool.blocked();
}
export function knowledgeHasDraft(owner: KnowledgeOwner) {
  return owner.termDirty() || owner.contextDirty() || owner.correctionDirty() || owner.factDirty() || owner.tool.hasDraft();
}
