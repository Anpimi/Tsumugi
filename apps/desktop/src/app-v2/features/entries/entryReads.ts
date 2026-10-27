import type { SessionReads } from "../../../sessionReads";
import { reviewCommands, type ReviewSummaryPage } from "../../../reviewCommands";

export type EntryCapture = { scopeId: string; snapshotId: string };
const scopes = ["source", "translation", "review", "resources"] as const;
export const entryPageKey = (locale: string, query: string, scopeId: string, after: number) =>
  ["workbench-entries", locale, query, scopeId, after] as const;

/** Capturing allocates a Host read scope; only an explicit view/read intent calls this. */
export async function captureEntries(reads: SessionReads, locale: string, query: string, refresh = false): Promise<EntryCapture> {
  if (reads.retired) throw new Error("Project session has ended");
  const captureKey = reads.key(["workbench-entry-capture", locale, query]);
  const previous = reads.client.getQueryState<EntryCapture>(captureKey);
  if (!refresh && previous?.status === "success" && !previous.isInvalidated && previous.data) return previous.data;
  return reads.client.fetchQuery({
    queryKey: captureKey, staleTime: refresh ? 0 : Infinity, retry: false, meta: { scopes: [...scopes] },
    queryFn: async ({ signal }) => {
      const page = await reviewCommands.summaryPage({ ...reads.context, locale, query, scopeId: null, afterOrdinal: 0, limit: 50 });
      if (signal.aborted || reads.retired) throw new Error("Project read cancelled");
      const key = entryPageKey(locale, query, page.scopeId, 0);
      const record = reads.client.getQueryCache().build<ReviewSummaryPage>(reads.client, {
        queryKey: reads.key(key), meta: { scopes: [...scopes] },
        queryFn: () => readEntryPage(reads, locale, query, page.scopeId, 0),
      });
      record.setData(page);
      return { scopeId: page.scopeId, snapshotId: page.sourceSnapshotId };
    },
  });
}

export function readEntryPage(reads: SessionReads, locale: string, query: string, scopeId: string, after: number) {
  // Automatic invalidation rereads the captured scope; it never captures another one.
  return reviewCommands.summaryPage({ ...reads.context, locale, query, scopeId, afterOrdinal: after, limit: 50 });
}

export async function readEntryDetails(reads: SessionReads, unitId: string, locale: string) {
  const value = await reviewCommands.editorSnapshot({ ...reads.context, unitId, locale });
  if (reads.retired || value.target.unitId !== unitId || value.target.locale !== locale
    || value.translations.unitId !== unitId || value.translations.locale !== locale
    || value.terms.unitId !== unitId || value.terms.locale !== locale) throw new Error("Entry details do not match this view");
  return value;
}
