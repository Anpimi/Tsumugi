import type { AiUsageView, ProviderBudget } from "../generated/ai.responses";

/** These synthetic reports have no cache or reasoning detail; zero is not inferred. */
export function unreportedUsageDetailsFixture(): Pick<AiUsageView, "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens"> {
  return { cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null };
}

/** Every supplied request lacks these details, independently of its base totals. */
export function unreportedTokenTotalsFixture(requests: number): Pick<ProviderBudget, "cacheRead" | "cacheWrite" | "reasoning"> {
  return { cacheRead: { tokens: "0", unknownRequests: requests }, cacheWrite: { tokens: "0", unknownRequests: requests },
    reasoning: { tokens: "0", unknownRequests: requests } };
}
