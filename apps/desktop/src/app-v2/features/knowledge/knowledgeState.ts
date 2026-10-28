import { contextResourceDirty } from "../../../contextResourceDrafts";
import type { KnowledgeOwner } from "./knowledgeTypes";

export function knowledgeBlocked(owner: KnowledgeOwner) {
  const state = owner.current();
  return owner.inFlight() || state.busyMutation || !!state.pending || !!state.factPending || !!state.checkingAction || owner.tool.blocked();
}
export function knowledgeHasDraft(owner: KnowledgeOwner) {
  return owner.termDirty() || owner.contextDirty() || owner.correctionDirty() || owner.factDirty() || owner.tool.hasDraft() || owner.contextResources.hasDrafts();
}

export function knowledgeRecovery(owner: KnowledgeOwner | null) {
  const state = owner?.current();
  if (!state) return { locale: undefined, preset: "terms", key: null };
  if (state.pending && state.pending.kind !== "typed-context") return { locale: state.locale, preset: "terms", key: null };
  const pending = state.pending?.kind === "typed-context" ? state.pending : null;
  const active = state.typedActiveKey ? state.typedDrafts[state.typedActiveKey] : null;
  const draft = pending ? state.typedDrafts[pending.draftKey] : active && contextResourceDirty(active) ? active : Object.values(state.typedDrafts).find(contextResourceDirty);
  return draft ? { locale: draft.locale, preset: draft.kind === "character" ? "characters" : draft.kind, key: draft.key } : { locale: state.locale, preset: "terms", key: null };
}
