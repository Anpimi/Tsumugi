import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { QueryClient, matchQuery } from "@tanstack/react-query";
import { connectionCommands, sameConnection, sameConnectionReference, type ConnectionReadView } from "./connectionCommands";
import type { AiConfig } from "./aiCommands";

const ApplicationReads = createContext<QueryClient | null>(null);
export const connectionReadKey = ["application", "connections", "current"] as const;
export function connectionReadOptions() {
  return { queryKey: connectionReadKey, staleTime: 0, queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const view = await connectionCommands.read();
    if (signal.aborted) throw new Error("Application connection read cancelled");
    return view;
  } };
}
/** Application facts outlive a settings panel and individual project sessions. */
export function ApplicationReadProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: {
    networkMode: "always", retry: false, staleTime: 0, gcTime: 60_000,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  } } }));
  useEffect(() => {
    let alive = true;
    const filter = { queryKey: connectionReadKey, exact: true };
    const focus = () => {
      // Invalidate immediately, then cancel even a first read with no data.
      // Query otherwise reuses that pending promise during refetch, allowing a
      // response captured before this focus check to clear the invalidation.
      void client.invalidateQueries({ ...filter, refetchType: "none" });
      void client.cancelQueries(filter, { revert: false }).then(() => {
        if (alive) return client.refetchQueries({ ...filter, type: "active" });
      });
    };
    window.addEventListener("focus", focus);
    return () => { alive = false; window.removeEventListener("focus", focus); client.clear(); };
  }, [client]);
  return <ApplicationReads.Provider value={client}>{children}</ApplicationReads.Provider>;
}
export function useApplicationQueryClient() {
  const client = useContext(ApplicationReads);
  if (!client) throw new Error("ApplicationReadProvider is required");
  return client;
}
export function currentConnections(client: QueryClient): ConnectionReadView | undefined {
  const value = client.getQueryState<ConnectionReadView>(connectionReadKey);
  return value?.status === "success" && value.fetchStatus === "idle" && !value.isInvalidated && value.error === null ? value.data : undefined;
}
/** The cache owns facts; this subscription does not copy them into a draft. */
export function useConnectionFacts() {
  const client = useApplicationQueryClient();
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe(event => {
    // A child useQuery can add its empty query or change observer options in
    // render. Those structural events provide no current facts. Observe actual
    // state changes and removal so data/invalidations still reach owners at once.
    if ((event.type === "updated" || event.type === "removed")
      && matchQuery({ queryKey: connectionReadKey, exact: true }, event.query)) changed();
  }), [client]);
  const snapshot = useCallback(() => client.getQueryState<ConnectionReadView>(connectionReadKey), [client]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { client, state, current: () => currentConnections(client) };
}
export function connectionConfigCurrent(view: ConnectionReadView | undefined, config: AiConfig): boolean {
  const reference = config.connectionProfile;
  if (reference == null) return true;
  const selected = view?.references.find(value => value.profileId === reference.profileId);
  const profile = view?.snapshot.profiles.find(value => value.id === reference.profileId && !value.archived);
  return !!selected && !!profile && sameConnectionReference(selected, reference) && sameConnection(profile.connection, config);
}
