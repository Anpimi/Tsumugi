import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { connectionCommands } from "./connectionCommands";

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
    const focus = () => { void client.invalidateQueries({ queryKey: connectionReadKey, exact: true }); };
    window.addEventListener("focus", focus);
    return () => { window.removeEventListener("focus", focus); client.clear(); };
  }, [client]);
  return <ApplicationReads.Provider value={client}>{children}</ApplicationReads.Provider>;
}
export function useApplicationQueryClient() {
  const client = useContext(ApplicationReads);
  if (!client) throw new Error("ApplicationReadProvider is required");
  return client;
}
