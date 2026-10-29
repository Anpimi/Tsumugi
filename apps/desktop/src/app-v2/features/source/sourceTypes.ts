import type { useSourceDraftSession } from "../../../SourceDraftSession";
import type { DecisionItem } from "../../../decisionCommands";

export type SourceOwner = ReturnType<typeof useSourceDraftSession>;
export type SourceReviewTarget = Extract<DecisionItem["action"], { kind: "compare-source-mapping" | "resolve-source-mapping" }>;
