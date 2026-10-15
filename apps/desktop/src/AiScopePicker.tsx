import { useTranslation } from "react-i18next";
import type { ContentPage } from "./sourceCommands";
import type { EditorTarget } from "./TranslationWorkbench";

/** Paging and selection belong to the existing workspace and preparation owners. */
export function AiScopePicker({ page, snapshotId, selectedSnapshotId, selected, after, ready, loading, failed,
  disabled, onChange, onRefresh, onPage, onOpenEditor }: {
  page: ContentPage | null; snapshotId: string | null; selectedSnapshotId: string | null; selected: string[];
  after: number; ready: boolean; loading: boolean; failed: boolean; disabled: boolean;
  onChange: (ids: string[], snapshotId: string | null) => void; onRefresh: () => void;
  onPage: (after: number) => void; onOpenEditor: (target: EditorTarget) => void;
}) {
  const { t } = useTranslation();
  const changed = selected.length > 0 && selectedSnapshotId !== null && snapshotId !== selectedSnapshotId;
  const rows = ready ? page?.rows ?? [] : [];
  const ids = rows.flatMap(row => row.unitId ? [row.unitId] : []);
  return <section aria-label={t("ai.workspace.scopeTitle")}>
    <h3>{t("ai.scope", { count: selected.length })}</h3><p>{t("ai.workspace.scopeHelp")}</p>
    {failed ? <p role="alert">{t("ai.workspace.scopeFailed")} <button type="button" className="text-button"
      disabled={disabled} onClick={onRefresh}>{t("ai.refresh")}</button></p> : loading ? <p role="status">{t("ai.workspace.scopeLoading")}</p>
      : !snapshotId ? <p>{t("ai.noSource")}</p> : null}
    {changed ? <p role="alert">{t("ai.workspace.scopeChanged")} <button type="button" className="text-button"
      disabled={disabled || !ready} onClick={() => onChange([], snapshotId)}>{t("ai.workspace.resetScope")}</button></p> : null}
    {ready && page ? <>
      <p>{t("ai.workspace.page", { first: rows.length ? after + 1 : 0, last: after + rows.length, total: page.total })}</p>
      <div className="execution-actions"><button type="button" className="secondary-button" disabled={disabled || changed || !ids.length}
        onClick={() => onChange([...new Set([...selected, ...ids])], snapshotId)}>{t("ai.workspace.selectPage")}</button></div>
      <ul>{rows.map(row => row.unitId && row.sourceRevisionId ? <li key={row.unitId}>
        <label className="source-check"><input type="checkbox" checked={selected.includes(row.unitId)} disabled={disabled || changed}
          onChange={event => onChange(event.target.checked ? [...new Set([...selected, row.unitId!])] : selected.filter(id => id !== row.unitId), snapshotId)} />{row.occurrence.key}: {row.occurrence.text}</label>
        <button type="button" className="text-button" disabled={disabled}
          onClick={() => onOpenEditor({ unitId: row.unitId!, sourceRevisionId: row.sourceRevisionId!, key: row.occurrence.key, sourceText: row.occurrence.text })}>{t("ai.workspace.editEntry", { key: row.occurrence.key })}</button>
      </li> : null)}</ul>
      <div className="execution-actions"><button type="button" className="secondary-button" disabled={disabled} onClick={() => onPage(0)}>{t("ai.first")}</button>
        {page.nextOrdinal !== null ? <button type="button" className="secondary-button" disabled={disabled} onClick={() => onPage(page.nextOrdinal!)}>{t("ai.next")}</button> : null}</div>
    </> : null}
  </section>;
}
