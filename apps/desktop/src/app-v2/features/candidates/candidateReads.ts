import { useEffect } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useSessionReads } from "../../../SessionReadProvider";
import { resourceCommands } from "../../../resourceCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import type { SessionReads, ChangeScope } from "../../../sessionReads";
import { translationCommands } from "../../../translationCommands";

export const candidatePageSize = 50;
const targetKey = (target: ReviewTarget) => [target.unitId, target.locale, target.sourceSnapshotId, target.sourceRevisionId,
  target.selectionId, target.revisionId, target.basis] as const;
export const candidateHistoryKey = (target: ReviewTarget, afterOrdinal: string) => ["workbench-candidate-history", ...targetKey(target), afterOrdinal, candidatePageSize] as const;
export const candidateTmKey = (target: ReviewTarget) => ["workbench-candidate-tm", ...targetKey(target), 0, 20] as const;

/** Inline and Inspector borrow the same bounded records. Hiding either observer must not invalidate the other's live read. */
function useCandidateQuery<T>(key: QueryKey, enabled: boolean, scopes: ChangeScope[], read: () => Promise<T>) {
  const reads = useSessionReads(), queryKey = reads.key(key), identity = JSON.stringify(key);
  const query = useQuery({ queryKey, enabled: enabled && !reads.retired, meta: { scopes }, queryFn: async ({ signal }) => {
    const value = await read();
    if (signal.aborted || reads.retired) throw new Error("Candidate read cancelled");
    return value;
  }, networkMode: "always", retry: false, staleTime: Infinity, gcTime: 60_000, refetchOnWindowFocus: false,
  refetchOnReconnect: false, refetchOnMount: true });
  useEffect(() => {
    if (enabled) return;
    const cached = reads.client.getQueryCache().find({ queryKey, exact: true });
    if (!cached || cached.isActive()) return;
    void reads.client.cancelQueries({ queryKey, exact: true });
    void reads.client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
  }, [reads, enabled, identity]);
  return query;
}
export function useCandidateHistory(target: ReviewTarget, afterOrdinal: string, enabled: boolean) {
  const reads = useSessionReads();
  return useCandidateQuery(candidateHistoryKey(target, afterOrdinal), enabled, ["source", "translation", "review"], async () => {
    const value = await translationCommands.history({ ...reads.context, unitId: target.unitId, locale: target.locale, afterOrdinal, limit: candidatePageSize });
    if (value.unitId !== target.unitId || value.locale !== target.locale || value.rows.some(row => row.unitId !== target.unitId || row.locale !== target.locale)) throw new Error("Candidate history does not match its target");
    return value;
  });
}
export function useCandidateTm(target: ReviewTarget, enabled: boolean) {
  const reads = useSessionReads();
  return useCandidateQuery(candidateTmKey(target), enabled, ["source", "translation", "resources", "review"], () =>
    resourceCommands.suggestions({ ...reads.context, unitId: target.unitId, locale: target.locale, offset: 0, limit: 20 }));
}
export function candidateReadCurrent(reads: SessionReads, key: QueryKey, data: unknown): boolean {
  const query = reads.client.getQueryCache().find({ queryKey: reads.key(key), exact: true });
  return !reads.retired && !!query && query.state.status === "success" && query.state.fetchStatus === "idle"
    && !query.state.isInvalidated && query.state.data === data;
}
export function candidateReadProof(reads: SessionReads, key: QueryKey, data: unknown) {
  const witness = reads.watchExactQuery(key), record = witness.current(), version = record?.state.dataUpdateCount;
  return { current: () => witness.current() === record && record !== undefined && record.state.dataUpdateCount === version && candidateReadCurrent(reads, key, data), dispose: witness.dispose };
}
