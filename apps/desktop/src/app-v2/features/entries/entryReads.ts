import type { SessionReads } from "../../../sessionReads";
import { reviewCommands } from "../../../reviewCommands";
import { segmentCommands, type SegmentPage, type SegmentQuery, type SegmentSelectionFilter } from "../../../segmentCommands";

export type EntryCapture = { scopeId: string; snapshotId: string; queryFingerprint: string; readVersion: string };
const scopes = ["source", "translation", "review", "resources"] as const;
export function entrySelectionFilter(preset: string): SegmentSelectionFilter | null {
  return preset === "all" || preset === "selected" || preset === "unselected" ? preset : null;
}
export const entryPageKey = (locale: string, query: SegmentQuery, capture: EntryCapture, cursor: string | null) =>
  ["workbench-entries", locale, query, capture.scopeId, capture.readVersion, cursor] as const;

/** Captures one fixed read basis. Automatic page reads keep that same basis. */
export async function captureEntries(reads: SessionReads, locale: string, query: SegmentQuery, refresh = false): Promise<EntryCapture> {
  if (reads.retired) throw new Error("Project session has ended");
  const captureKey = reads.key(["workbench-entry-capture", locale, query]);
  const previous = reads.client.getQueryState<EntryCapture>(captureKey);
  if (!refresh && previous?.status === "success" && !previous.isInvalidated && previous.data) return previous.data;
  return reads.client.fetchQuery({
    queryKey: captureKey, staleTime: refresh ? 0 : Infinity, retry: false, meta: { scopes: [...scopes] },
    queryFn: async ({ signal }) => {
      const page = await segmentCommands.page({ ...reads.context, locale, query, scopeId: null, cursor: null, limit: 50 });
      if (signal.aborted || reads.retired) throw new Error("Project read cancelled");
      const capture = { scopeId: page.scopeId, snapshotId: page.sourceSnapshotId, queryFingerprint: page.queryFingerprint, readVersion: page.readVersion };
      const record = reads.client.getQueryCache().build<SegmentPage>(reads.client, {
        queryKey: reads.key(entryPageKey(locale, query, capture, null)), meta: { scopes: [...scopes] },
        queryFn: () => readEntryPage(reads, locale, query, capture, null),
      });
      record.setData(page);
      return capture;
    },
  });
}

export async function readEntryPage(reads: SessionReads, locale: string, query: SegmentQuery, capture: EntryCapture, cursor: string | null) {
  const page = await segmentCommands.page({ ...reads.context, locale, query, scopeId: capture.scopeId, cursor, limit: 50 });
  if (reads.retired || page.sourceSnapshotId !== capture.snapshotId || page.queryFingerprint !== capture.queryFingerprint || page.readVersion !== capture.readVersion) throw new Error("Entry page does not match the captured read basis");
  return page;
}

export async function readEntryDetails(reads: SessionReads, unitId: string, locale: string) {
  const value = await reviewCommands.editorSnapshot({ ...reads.context, unitId, locale });
  if (reads.retired || value.target.unitId !== unitId || value.target.locale !== locale
    || value.translations.unitId !== unitId || value.translations.locale !== locale
    || value.terms.unitId !== unitId || value.terms.locale !== locale) throw new Error("Entry details do not match this view");
  return value;
}
