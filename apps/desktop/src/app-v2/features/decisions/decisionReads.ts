import { decisionActivityIdentity, decisionCommands, type DecisionPageRequest } from "../../../decisionCommands";
import type { DecisionClientActivity } from "../../../generated/decisions.requests";
import type { SessionReads } from "../../../sessionReads";

export interface DecisionActivityOwner {
  getDecisionActivity(): DecisionClientActivity;
  subscribe(listener: () => void): () => void;
}
export type DecisionOwners = readonly [DecisionActivityOwner | null, DecisionActivityOwner | null]
  | readonly [DecisionActivityOwner | null, DecisionActivityOwner | null, DecisionActivityOwner | null]
  | readonly [DecisionActivityOwner | null, DecisionActivityOwner | null, DecisionActivityOwner | null, DecisionActivityOwner | null]
  | readonly [DecisionActivityOwner | null, DecisionActivityOwner | null, DecisionActivityOwner | null, DecisionActivityOwner | null, DecisionActivityOwner | null];
const ownerBindings = new WeakMap<DecisionActivityOwner, number>();
let nextBinding = 0;
function binding(owner: DecisionActivityOwner | null): number | null {
  if (owner === null) return null;
  const existing = ownerBindings.get(owner);
  if (existing !== undefined) return existing;
  const value = ++nextBinding;
  ownerBindings.set(owner, value);
  return value;
}

/** Inbox, badge and tray borrow the same SessionReads cache. Owner lifecycle is
 * captured with the request and checked again before a result can be cached. */
export function decisionReadOptions(reads: SessionReads, query: DecisionPageRequest["query"],
  cursor: DecisionPageRequest["cursor"], owners: () => DecisionOwners, read = decisionCommands.page,
) {
  const capturedOwners = owners();
  const activity = capturedOwners.every(owner => owner !== null) ? capturedOwners.map(owner => owner!.getDecisionActivity()) : null;
  const identity = decisionActivityIdentity(activity);
  const request: DecisionPageRequest = { ...reads.context, query: structuredClone(query), cursor: cursor ? structuredClone(cursor) : null, limit: 50,
    activity: activity ? structuredClone(activity) : null };
  const current = () => {
    const now = owners();
    return !reads.retired && now.length === capturedOwners.length && now.every((owner, index) => owner === capturedOwners[index])
      && decisionActivityIdentity(now.every(owner => owner !== null) ? now.map(owner => owner!.getDecisionActivity()) : null) === identity;
  };
  return {
    // A replacement owner cannot reuse a completed read from a retired object,
    // even if it reports the same journal identity and activity revision.
    queryKey: reads.key(["workbench-decisions", request.query, request.cursor, identity, capturedOwners.map(binding), 50]),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (signal.aborted || !current()) throw new Error("Decision read changed");
      const page = await read(request);
      if (signal.aborted || !current()) throw new Error("Decision read changed");
      return page;
    },
    meta: { scopes: ["project", "source", "translation", "resources", "review", "release", "execution"] },
    networkMode: "always" as const, retry: false as const, staleTime: Infinity, gcTime: 60_000,
    refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: true,
  };
}
