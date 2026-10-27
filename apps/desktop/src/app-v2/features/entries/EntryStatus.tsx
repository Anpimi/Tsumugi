import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { StatusGlyph } from "../../../design-system/StatusGlyph";
import type { SegmentRow } from "../../../segmentCommands";
import type { TranslationDrafts } from "../editor/translationDrafts";
import { deriveEntryStatus } from "./deriveEntryStatus";

export interface EntryStatusProps {
  row: SegmentRow;
  projectId: string;
  drafts: Pick<TranslationDrafts, "subscribe" | "getEntry" | "getSnapshot"> | null;
  className?: string;
}
const noSubscription = () => () => {};

export default function EntryStatus({ row, projectId, drafts, className }: EntryStatusProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const { unitId, locale } = row.content;
  // Immutable entry identity is the snapshot. Session notifications for another
  // row do not change it and therefore do not rerender this glyph.
  const snapshot = useCallback(() => drafts?.getEntry({ projectId, unitId, locale })
    ?? drafts?.getSnapshot().summaries.find(summary => summary.key.projectId === projectId
      && summary.key.unitId === unitId && summary.key.locale === locale) ?? null,
    [drafts, projectId, unitId, locale]);
  const draft = useSyncExternalStore(drafts?.subscribe ?? noSubscription, snapshot, snapshot);
  const status = deriveEntryStatus(row, draft);
  return <StatusGlyph state={status.state} label={t(status.labelKey)} protected={status.protected}
    protectedLabel={t("entryStatusProtected")} className={className} />;
}
