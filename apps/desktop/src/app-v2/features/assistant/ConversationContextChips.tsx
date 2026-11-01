import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { SegmentQuery } from "../../../segmentCommands";
import { Button } from "../../../design-system/Button";
import { workspaceSelectionIds, type WorkspaceSelection } from "../../workspace/workspaceSelection";
import styles from "./ConversationPanel.module.css";

const statusNames = { all: "allEntries", untranslated: "entryPresetUntranslated", "needs-review": "entryPresetReview", issues: "entryPresetIssues",
  affected: "entryPresetAffected", blocking: "entryPresetBlocking", "ai-pending": "entryPresetAi" } as const;

export function ConversationContextChips({ selection, filter, disabled, remove }: {
  selection: WorkspaceSelection | null; filter?: SegmentQuery | null; disabled: boolean; remove: () => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" }), { t: workspace } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const count = workspaceSelectionIds(selection).length;
  const locale = selection?.kind === "ids" ? selection.locale : selection?.selection.capture.locale;
  const query = selection?.kind === "scope" ? selection.query : filter;
  const filterLabel = query ? [query.text, workspace(query.selection === "all" ? statusNames[query.status ?? "all"] : query.selection === "selected" ? "selectedEntries" : "unselectedEntries")].filter(Boolean).join(" · ") : null;
  const chips = selection ? [t("contextSelection", { count }), t("contextLocale", { locale }), ...(filterLabel ? [t("contextFilter", { filter: filterLabel })] : [])] : [];
  return <section className={styles.context} aria-label={t("contextTitle")}>
    {chips.length ? <><div className={styles.contextChips}>{chips.map(label => <Button key={label} size="sm" className={styles.contextChip}
      disabled={disabled} aria-label={t("contextRemove", { label })} onClick={remove}><span>{label}</span><X aria-hidden="true"/></Button>)}</div><p className={styles.notice}>{t("contextHelp")}</p></>
      : <p className={styles.notice}>{t("contextNone")}</p>}
  </section>;
}
