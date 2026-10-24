import { aiSemanticReviewCommands } from "./aiSemanticReviewCommands";
import type { SessionRequest } from "./executionCommands";
import type { ChangeScope } from "./sessionReads";

export const semanticReviewKey = (attemptId: string | null) => ["ai-semantic-review", attemptId] as const;
/** All consumers observe the same checked attempt; reads never start a model. */
export function semanticReviewRead(session: SessionRequest, attemptId: string | null) {
  return { key: semanticReviewKey(attemptId), scopes: ["execution", "source", "translation", "resources", "review"] as ChangeScope[],
    read: async () => {
      if (!attemptId) throw new Error("Semantic review read requires an original attempt");
      return (await aiSemanticReviewCommands.read({ ...session, attemptId })).view;
    } };
}
