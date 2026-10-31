import type { SourceFactBasis } from "./resourceCommands";

/** Both workspaces observe the same current decisions for these fact positions. */
export const contextFactQueryKey = (scope: SourceFactBasis["scope"], facts: { blockIndex: number; factIndex: number }[]) =>
  ["context-fact-decisions", scope, facts];
