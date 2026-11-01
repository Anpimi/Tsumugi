import type { useResourceDraftSession } from "../../../ResourceDraftSession";

/** The existing resource session owns drafts, CAS bases and original actions. */
export type KnowledgeOwner = ReturnType<typeof useResourceDraftSession>;
export interface ResourceProposalTarget { captureId: string; entryId: string }
export const knowledgeKinds = ["characters", "terms", "style", "background", "memory"] as const;
export type KnowledgeKind = typeof knowledgeKinds[number];

export function contextKindForKnowledge(preset: string) { return preset === "characters" ? "character" : preset === "style" ? "style" : preset === "background" ? "background" : null; }
