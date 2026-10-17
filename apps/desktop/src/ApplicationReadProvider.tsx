import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { QueryClient, matchQuery } from "@tanstack/react-query";
import { connectionCommands, sameConnection, sameConnectionReference, type ConnectionReadView } from "./connectionCommands";
import type { AiConfig } from "./aiCommands";

const ApplicationReads = createContext<{ client: QueryClient; pluginReadReservations: Set<() => boolean> } | null>(null);
export const connectionReadKey = ["application", "connections", "current"] as const;
export const pluginInventoryReadKey = ["application", "plugins", "inventory"] as const;
export const pluginRepositoriesReadKey = ["application", "plugins", "repositories"] as const;
export function connectionReadOptions() {
  return { queryKey: connectionReadKey, staleTime: 0, queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const view = await connectionCommands.read();
    if (signal.aborted) throw new Error("Application connection read cancelled");
    return view;
  } };
}
/** Application facts outlive a settings panel and individual project sessions. */
export function ApplicationReadProvider({ children }: { children: ReactNode }) {
  const [owner] = useState(() => ({ client: new QueryClient({ defaultOptions: { queries: {
    networkMode: "always", retry: false, staleTime: 0, gcTime: 60_000,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  } } }), pluginReadReservations: new Set<() => boolean>() }));
  const { client, pluginReadReservations } = owner;
  useEffect(() => {
    let alive = true;
    const pluginReadReserved = () => [...pluginReadReservations].some(reserved => reserved());
    const focus = () => {
      for (const queryKey of [connectionReadKey, pluginInventoryReadKey, pluginRepositoriesReadKey]) {
        const pluginRead = queryKey !== connectionReadKey;
        if (pluginRead && pluginReadReserved()) continue;
        const filter = { queryKey, exact: true };
        // Cancel even a first read with no data so its pre-focus response
        // cannot confirm the facts requested by this focus check.
        void client.invalidateQueries({ ...filter, refetchType: "none" });
        void client.cancelQueries(filter, { revert: false }).then(() => {
          // A write may reserve the owner before cancellation finishes.
          if (alive && (!pluginRead || !pluginReadReserved())) return client.refetchQueries({ ...filter, type: "active" });
        });
      }
    };
    window.addEventListener("focus", focus);
    return () => { alive = false; window.removeEventListener("focus", focus); client.clear(); };
  }, [client, pluginReadReservations]);
  return <ApplicationReads.Provider value={owner}>{children}</ApplicationReads.Provider>;
}
export function useApplicationQueryClient() {
  const owner = useContext(ApplicationReads);
  if (!owner) throw new Error("ApplicationReadProvider is required");
  return owner.client;
}
/** Focus consults the original Extensions reservation, including before busy renders. */
export function usePluginReadReservation(running: RefObject<boolean>) {
  const owner = useContext(ApplicationReads);
  if (!owner) throw new Error("ApplicationReadProvider is required");
  useEffect(() => {
    const reserved = () => running.current;
    owner.pluginReadReservations.add(reserved);
    return () => { owner.pluginReadReservations.delete(reserved); };
  }, [owner, running]);
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
