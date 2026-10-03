import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { QueryClientProvider, useQuery, type QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SessionReads, type ChangeScope } from "./sessionReads";
import type { SessionRequest } from "./executionCommands";

const ReadsContext = createContext<SessionReads | null>(null);
export function SessionReadProvider({ context, children, bridge = true }: { context: SessionRequest; children: ReactNode; bridge?: boolean }) {
  const [reads] = useState(() => new SessionReads(context));
  useEffect(() => bridge ? reads.start() : undefined, [reads, bridge]);
  return <ReadsContext.Provider value={reads}><QueryClientProvider client={reads.client}>{children}</QueryClientProvider></ReadsContext.Provider>;
}
export function useSessionReads() { const reads = useContext(ReadsContext); if (!reads) throw new Error("Reads require a project session owner"); return reads; }
export function useSessionQuery<T>({ key, scopes, enabled, read }: { key: QueryKey; scopes: ChangeScope[]; enabled: boolean; read: () => Promise<T> }) {
  const reads = useSessionReads();
  const queryKey = reads.key(key);
  const identity = JSON.stringify(queryKey);
  const query = useQuery({ queryKey, enabled, meta: { scopes }, queryFn: async ({ signal }) => {
    const result = await read();
    if (signal.aborted) throw new Error("Read cancelled");
    return result;
  } });
  useEffect(() => {
    if (!enabled) {
      void reads.client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
      const cached = reads.client.getQueryCache().find({ queryKey, exact: true });
      if (cached && !cached.isActive()) void reads.client.cancelQueries({ queryKey, exact: true });
    }
  }, [reads, enabled, identity]);
  return { ...query, setData: (data: T | undefined) => {
    if (data == null) void reads.client.resetQueries({ queryKey, exact: true }, { cancelRefetch: false });
    else reads.client.setQueryData(queryKey, data);
  } };
}
export function SessionReadStatus() {
  const reads = useSessionReads(), { t } = useTranslation();
  const failed = useSyncExternalStore(reads.subscribeStatus, reads.status);
  return failed ? <p role="alert">{t("execution.updatesUnavailable")} <button className="text-button" onClick={() => void reads.synchronize(true)}>{t("execution.refresh")}</button></p> : null;
}
