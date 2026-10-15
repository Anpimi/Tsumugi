import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionRequest } from "./executionCommands";
import { useSessionQuery } from "./SessionReadProvider";
import { sourceCommands, type ContentRow } from "./sourceCommands";
import type { EditorTarget } from "./TranslationWorkbench";

export interface AiScopeSelection { snapshotId: string | null; unitIds: string[] }

/** Current source facts stay in the session cache; only paging is local intent. */
export function useAiSourceScope(context: SessionRequest, open: boolean) {
  const [position, setPosition] = useState<{ snapshotId: string; after: number } | null>(null);
  const scope = useSessionQuery({ key: ["ai", "source-scope"], scopes: ["source"], enabled: open,
    read: () => sourceCommands.scope(context) });
  const snapshotId = scope.data?.currentSnapshot ?? null;
  const after = position?.snapshotId === snapshotId ? position.after : 0;
  const page = useSessionQuery({ key: ["ai", "source-page", snapshotId, after], scopes: ["source"],
    enabled: open && scope.isSuccess && !scope.isFetching && !scope.error && snapshotId !== null,
    read: () => sourceCommands.content({ ...context, snapshotId: snapshotId!, after, limit: 50 }) });
  const ready = scope.isSuccess && !scope.isFetching && !scope.error && snapshotId !== null
    && page.isSuccess && !page.isFetching && !page.error && page.data.snapshotId === snapshotId;
  return { scope, page, snapshotId, after, ready, setAfter: (value: number) => {
    if (snapshotId) setPosition({ snapshotId, after: value });
  }, refresh: async () => {
    const latest = await scope.refetch();
    if (latest.error) throw latest.error;
    if (latest.data?.currentSnapshot === snapshotId && snapshotId) {
      const result = await page.refetch();
      if (result.error) throw result.error;
    }
  } };
}

export function AiScopePicker({ source, selection, disabled, onChange, onRefresh, onOpenEditor }: {
  source: ReturnType<typeof useAiSourceScope>;
  selection: AiScopeSelection;
  disabled: boolean;
  onChange: (selection: AiScopeSelection) => void;
  onRefresh: () => void;
  onOpenEditor: (target: EditorTarget) => void;
}) {
  const { t } = useTranslation();
  const changed = selection.unitIds.length > 0 && source.snapshotId !== selection.snapshotId;
  const rows = source.ready ? source.page.data?.rows ?? [] : [];
  const ids = rows.flatMap(row => row.unitId ? [row.unitId] : []);
  function toggle(row: ContentRow, checked: boolean) {
    if (!row.unitId || !source.ready || changed) return;
    onChange({ snapshotId: source.snapshotId, unitIds: checked
      ? [...new Set([...selection.unitIds, row.unitId])]
      : selection.unitIds.filter(id => id !== row.unitId) });
  }
  return <section aria-label={t("ai.workspace.scopeTitle")}>
    <h3>{t("ai.scope", { count: selection.unitIds.length })}</h3>
    <p>{t("ai.workspace.scopeHelp")}</p>
    {source.scope.error || source.page.error ? <p role="alert">{t("ai.workspace.scopeFailed")} <button type="button"
      className="text-button" disabled={disabled} onClick={onRefresh}>{t("ai.refresh")}</button></p>
      : source.scope.isFetching || (source.snapshotId && !source.ready) ? <p role="status">{t("ai.workspace.scopeLoading")}</p>
      : !source.snapshotId ? <p>{t("ai.noSource")}</p> : null}
    {changed ? <p role="alert">{t("ai.workspace.scopeChanged")} <button type="button" className="text-button"
      disabled={disabled || !source.ready} onClick={() => onChange({ snapshotId: source.snapshotId, unitIds: [] })}>{t("ai.workspace.resetScope")}</button></p> : null}
    {source.ready ? <>
      <p>{t("ai.workspace.page", { first: rows.length ? source.after + 1 : 0, last: source.after + rows.length, total: source.page.data!.total })}</p>
      <div className="execution-actions">
        <button type="button" className="secondary-button" disabled={disabled || changed || !ids.length}
          onClick={() => onChange({ snapshotId: source.snapshotId, unitIds: [...new Set([...selection.unitIds, ...ids])] })}>{t("ai.workspace.selectPage")}</button>
        <button type="button" className="secondary-button" disabled={disabled || !selection.unitIds.length}
          onClick={() => onChange({ snapshotId: source.snapshotId, unitIds: [] })}>{t("ai.workspace.clearScope")}</button>
      </div>
      <ul>{rows.map(row => row.unitId && row.sourceRevisionId ? <li key={row.unitId}>
        <label className="source-check"><input type="checkbox" checked={selection.unitIds.includes(row.unitId)}
          disabled={disabled || changed} onChange={event => toggle(row, event.target.checked)} />{row.occurrence.key}: {row.occurrence.text}</label>
        <button type="button" className="text-button" disabled={disabled}
          onClick={() => onOpenEditor({ unitId: row.unitId!, sourceRevisionId: row.sourceRevisionId!, key: row.occurrence.key, sourceText: row.occurrence.text })}>{t("ai.workspace.editEntry", { key: row.occurrence.key })}</button>
      </li> : null)}</ul>
      <div className="execution-actions">
        <button type="button" className="secondary-button" disabled={disabled || source.after === 0} onClick={() => source.setAfter(0)}>{t("ai.first")}</button>
        {source.page.data?.nextOrdinal !== null ? <button type="button" className="secondary-button" disabled={disabled}
          onClick={() => source.setAfter(source.page.data!.nextOrdinal!)}>{t("ai.next")}</button> : null}
      </div>
    </> : null}
  </section>;
}
