import type { useResourceDraftSession } from "../../../ResourceDraftSession";

/** The existing resource session owns drafts, CAS bases and original actions. */
export type KnowledgeOwner = ReturnType<typeof useResourceDraftSession>;
export const knowledgeKinds = ["characters", "terms", "style", "background", "memory"] as const;
export type KnowledgeKind = typeof knowledgeKinds[number];
