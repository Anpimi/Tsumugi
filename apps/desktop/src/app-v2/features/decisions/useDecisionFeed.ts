import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { decisionActivityIdentity, decisionCommands } from "../../../decisionCommands";
import type { DecisionCursor, DecisionPage } from "../../../generated/decisions.responses";
import type { SessionReads } from "../../../sessionReads";
import { decisionReadOptions, type DecisionOwners } from "./decisionReads";

const allDecisions = { locale: null, sources: [] };
const noSubscription = () => () => {};
const noActivity = () => null;

/** The shell owns one first-page read for the badge and tray. A paged list uses
 * that same record at its start and the same session cache for later cursors. */
export function useDecisionFeed(reads: SessionReads, owners: DecisionOwners, cursor: DecisionCursor | null,
  visible: boolean, enabled: boolean, read = decisionCommands.page,
) {
  const firstOwner = owners[0], secondOwner = owners[1], resourceOwner = owners[2], sourceOwner = owners[3], strategyOwner = owners[4];
  const firstActivity = useSyncExternalStore(firstOwner?.subscribe ?? noSubscription, firstOwner?.getDecisionActivity ?? noActivity);
  const secondActivity = useSyncExternalStore(secondOwner?.subscribe ?? noSubscription, secondOwner?.getDecisionActivity ?? noActivity);
  const resourceActivity = useSyncExternalStore(resourceOwner?.subscribe ?? noSubscription, resourceOwner?.getDecisionActivity ?? noActivity);
  const sourceActivity = useSyncExternalStore(sourceOwner?.subscribe ?? noSubscription, sourceOwner?.getDecisionActivity ?? noActivity);
  const strategyActivity = useSyncExternalStore(strategyOwner?.subscribe ?? noSubscription, strategyOwner?.getDecisionActivity ?? noActivity);
  const activity = firstActivity && secondActivity && (owners.length < 3 || resourceActivity) && (owners.length < 4 || sourceActivity) && (owners.length < 5 || strategyActivity)
    ? [firstActivity, secondActivity, ...(resourceActivity ? [resourceActivity] : []), ...(sourceActivity ? [sourceActivity] : []), ...(strategyActivity ? [strategyActivity] : [])] : null;
  const identity = decisionActivityIdentity(activity);
  const liveOwners = useRef(owners);
  liveOwners.current = owners;
  const getOwners = useCallback(() => liveOwners.current, []);
  const firstOptions = useMemo(() => decisionReadOptions(reads, allDecisions, null, getOwners, read),
    [reads, firstOwner, secondOwner, resourceOwner, sourceOwner, strategyOwner, identity, getOwners, read]);
  const pageOptions = useMemo(() => decisionReadOptions(reads, allDecisions, cursor, getOwners, read),
    [reads, firstOwner, secondOwner, resourceOwner, sourceOwner, strategyOwner, identity, getOwners, cursor, read]);
  const live = enabled && !reads.retired;
  const first = useQuery({ ...firstOptions, enabled: live });
  const changed = cursor !== null && first.data !== undefined && cursor.basis !== first.data.basis;
  const page = useQuery({ ...pageOptions, enabled: live && visible && !changed && (cursor === null || first.data !== undefined) });
  const currentPage = cursor === null ? first : page;

  function current(basis: string): boolean {
    const now = getOwners();
    const observed = now.every(owner => owner !== null) ? now.map(owner => owner!.getDecisionActivity()) : null;
    const state = reads.client.getQueryState<DecisionPage>(firstOptions.queryKey);
    return live && !reads.retired && now[0] === firstOwner && now[1] === secondOwner && now[2] === resourceOwner && now[3] === sourceOwner && now[4] === strategyOwner
      && decisionActivityIdentity(observed) === identity && state?.status === "success"
      && state.fetchStatus === "idle" && !state.isInvalidated && state.data?.basis === basis;
  }

  return { first, page: currentPage, changed, current,
    refresh: () => reads.client.invalidateQueries({ queryKey: reads.key(["workbench-decisions"]), refetchType: "active" }),
  };
}
