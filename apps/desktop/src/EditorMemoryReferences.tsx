import { useTranslation } from "react-i18next";
import { useSessionQuery } from "./SessionReadProvider";
import type { SessionRequest } from "./executionCommands";
import { resourceCommands, type TmSuggestion } from "./resourceCommands";
import { reviewCommands } from "./reviewCommands";
import { commandFailure, failureReason } from "./CommandFailure";

const limit = 20;
type MemoryTarget = { unitId: string; sourceRevisionId: string };

/** Saved references use the existing session cache; comparing never edits a draft. */
export function EditorMemoryReferences({ context, target, locale, enabled, draftText }: {
  context: SessionRequest; target: MemoryTarget; locale: string; enabled: boolean; draftText: string;
}) {
  const { t } = useTranslation();
  const read = useSessionQuery<TmSuggestion[]>({
    key: ["translation-editor-memory", target.unitId, target.sourceRevisionId, locale, limit],
    scopes: ["source", "translation"], enabled,
    read: async () => {
      const rows = await resourceCommands.suggestions({ ...context, unitId: target.unitId, locale, offset: 0, limit });
      // Suggestions have reference-unit identities, not the querying unit's source basis.
      // Recheck the latter after reading, including changes by another project writer.
      const current = await reviewCommands.editorSnapshot({ ...context, unitId: target.unitId, locale });
      if (current.target.unitId !== target.unitId || current.target.locale !== locale
        || current.target.sourceRevisionId !== target.sourceRevisionId) throw { reason: "editor-memory-source-changed" };
      if (rows.length > limit || rows.some(row => row.targetLocale !== locale)
        || new Set(rows.map(row => row.translationRevisionId)).size !== rows.length) throw { reason: "editor-memory-response" };
      return rows;
    },
  });
  const ready = enabled && read.isSuccess && !read.isFetching && !read.error;
  return <section className="editor-memory" aria-label={t("resource.tm")}>
    <div className="execution-section-heading"><h5>{t("resource.tm")}</h5>
      <button type="button" className="text-button" disabled={!enabled || read.isFetching}
        onClick={() => { void read.refetch(); }}>{t(read.error ? "resource.retryRead" : "resource.refresh")}</button>
    </div>
    <p>{t("resource.editorTmHelp")}</p><p>{t("resource.tmLimit")}</p>
    {!enabled ? <p role="status">{t("resource.editorTmUnavailable")}</p>
      : read.isFetching ? <p role="status">{t("resource.loading")}</p>
      : read.error ? <p role="alert">{t(failureReason(commandFailure(read.error)) === "editor-memory-source-changed" ? "resource.editorTmSourceChanged" : "resource.editorTmFailed")}</p> : null}
    {ready ? <><p>{t("resource.editorTmLimit", { count: limit })}</p>
      {read.data.length ? <ul>{read.data.map(row => <li key={row.translationRevisionId}>
        <p>{t(`resource.match.${row.matchKind}`)} · {row.scorePercent}% · {t(row.originKind === "ai" ? "ai.origin" : row.originKind === "manual" ? "resource.manual" : "resource.imported")}</p>
        <pre>{row.translationText}</pre>
        <p>{t("resource.editorTmApproval")}</p>
        <details><summary>{t("resource.editorTmCompare")}</summary>
          <h6>{t("translation.sourceText")}</h6><pre>{row.sourceText}</pre>
          <h6>{t("translation.draft")}</h6><pre>{draftText || t("translation.empty")}</pre>
          <h6>{t("resource.newValue")}</h6><pre>{row.translationText || t("translation.empty")}</pre>
          <details><summary>{t("resource.provenance")}</summary><dl>
            <dt>{t("resource.editorTmReferenceUnit")}</dt><dd><code>{row.unitId}</code></dd>
            <dt>{t("resource.editorTmSourceRevision")}</dt><dd><code>{row.sourceRevisionId}</code></dd>
            <dt>{t("resource.editorTmTranslationRevision")}</dt><dd><code>{row.translationRevisionId}</code></dd>
          </dl></details>
        </details>
      </li>)}</ul> : <p>{t("resource.noSuggestions")}</p>}
    </> : null}
  </section>;
}
