import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { QueryClientProvider, useQuery, useInfiniteQuery, type InfiniteData, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";
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
/** Owners may remain mounted for copying local work after their Core session has ended. */
export function useSessionAlive(): { current: boolean } {
  const reads = useSessionReads(), mounted = useRef(false);
  return useMemo(() => ({ get current() { return mounted.current && !reads.retired; },
    set current(value: boolean) { mounted.current = value; } }), [reads]);
}
function useReadVisibility(reads: SessionReads, queryKey: QueryKey, enabled: boolean) {
  const identity = JSON.stringify(queryKey);
  useEffect(() => {
    if (!enabled) {
      const cached = reads.client.getQueryCache().find({ queryKey, exact: true });
      // Cancellation restores the previous state. Mark it stale afterwards so
      // reopening also rereads a cancelled load-more query's retained pages.
      if (cached && !cached.isActive()) void reads.client.cancelQueries({ queryKey, exact: true });
      void reads.client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
    }
  }, [reads, enabled, identity]);
}
export function useSessionQuery<T>({ key, scopes, enabled, read, refetchOnMount }: { key: QueryKey; scopes: ChangeScope[]; enabled: boolean; read: () => Promise<T>; refetchOnMount?: UseQueryOptions<T>["refetchOnMount"] }) {
  const reads = useSessionReads();
  const queryKey = reads.key(key);
  const query = useQuery({ queryKey, enabled, meta: { scopes }, ...(refetchOnMount === undefined ? {} : { refetchOnMount }), queryFn: async ({ signal }) => {
    const result = await read();
    if (signal.aborted) throw new Error("Read cancelled");
    return result;
  } });
  useReadVisibility(reads, queryKey, enabled);
  return { ...query, setData: (data: T | undefined) => {
    if (data == null) void reads.client.resetQueries({ queryKey, exact: true }, { cancelRefetch: false });
    else reads.client.setQueryData(queryKey, data);
  } };
}
/** Load-more pages stay in the existing session cache, including their exact retry parameters. */
export function useSessionInfiniteQuery<T, P>({ key, scopes, enabled, initialPageParam, nextPage, read }: {
  key: QueryKey; scopes: ChangeScope[]; enabled: boolean; initialPageParam: P;
  nextPage: (last: T, pages: T[], lastParam: P, params: P[]) => P | undefined;
  read: (pageParam: P) => Promise<T>;
}) {
  const reads = useSessionReads(), queryKey = reads.key(key);
  // A concrete envelope keeps QueryFunctionContext's generic page parameter
  // precise, including null as a valid initial cursor.
  type PageParam = { cursor: P };
  const query = useInfiniteQuery<T, Error, InfiniteData<T, PageParam>, QueryKey, PageParam>({ queryKey, enabled,
    meta: { scopes }, initialPageParam: { cursor: initialPageParam },
    getNextPageParam: (last, pages, lastParam, params) => {
      const cursor = nextPage(last, pages, lastParam.cursor, params.map(param => param.cursor));
      return cursor === undefined ? undefined : { cursor };
    },
    queryFn: async ({ pageParam, signal }) => {
      const result = await read(pageParam.cursor);
      if (signal.aborted) throw new Error("Read cancelled");
      return result;
    },
  });
  useReadVisibility(reads, queryKey, enabled);
  return query;
}
export function SessionReadStatus() {
  const reads = useSessionReads(), { t } = useTranslation();
  const failed = useSyncExternalStore(reads.subscribeStatus, reads.status);
  return failed ? <p role="alert">{t("execution.updatesUnavailable")} <button className="text-button" onClick={() => void reads.synchronize(true)}>{t("execution.refresh")}</button></p> : null;
}
