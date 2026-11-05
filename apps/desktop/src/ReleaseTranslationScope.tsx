import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./design-system/Button";
import { Banner, LoadingState } from "./design-system/Feedback";
import { Disclosure } from "./design-system/Disclosure";
import { TokenizedText } from "./design-system/TokenizedText";
import { reviewCommands, type ReviewPage } from "./reviewCommands";
import { executionContext } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { useSessionQuery } from "./SessionReadProvider";
import styles from "./ReleaseTranslationScope.module.css";

type Props = { locale: string; selected: string[] | undefined; disabled: boolean; onChange: (value: string[] | null) => void };

/** Controlled presentation; reading or selecting a scope never changes translations. */
export function TranslationScopeChoices({ locale, selected, disabled, onChange, page, loading, failed, retry, previous, next }: Props & {
  page?: ReviewPage; loading: boolean; failed: boolean; retry: () => void; previous?: () => void; next?: () => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "releaseScope" });
  return <section className={styles.body} aria-label={t("heading", { locale })}>
    <label className={styles.choice}><input type="checkbox" checked={selected !== undefined} disabled={disabled}
      onChange={event => onChange(event.target.checked ? [] : null)}/><span>{t("mode")}</span></label>
    {selected !== undefined ? <>
      <p>{t("help")}</p><p role="status">{t("selected", { count: selected.length })}</p>
      {selected.length ? <Button variant="secondary" disabled={disabled} onClick={() => onChange([])}>{t("clear")}</Button> : null}
      {!selected.length ? <Banner tone="info">{t("allSource")}</Banner> : null}
      {loading ? <LoadingState label={t("loading")}/> : null}
      {failed ? <Banner tone="error" role="alert" action={<Button variant="secondary" disabled={disabled} onClick={retry}>{t("retry")}</Button>}>{t("failed")}</Banner> : null}
      {!failed && page ? <>
        {!page.rows.length ? <p>{t(page.total ? "emptyPage" : "empty")}</p> : null}
        <ul className={styles.list}>{page.rows.map(row => <li key={row.unitId}>
          <label className={styles.choice}><input type="checkbox" aria-label={t("include", { entry: row.nativeKey })} checked={selected.includes(row.unitId)} disabled={disabled || loading}
            onChange={event => onChange(event.target.checked ? [...selected, row.unitId] : selected.filter(id => id !== row.unitId))}/>
            <span><span className={styles.source}><TokenizedText text={row.sourceText}/></span><small><TokenizedText text={row.nativeKey}/></small>
              <span>{t("savedTranslation")}</span><span className={styles.source}>{row.translationText === null ? t("noTranslation") : <TokenizedText text={row.translationText}/>}</span></span>
          </label>
          <Disclosure title={t("fullSource")}><p><TokenizedText text={row.sourceText}/></p>
            <p>{t("savedTranslation")}</p><p>{row.translationText === null ? t("noTranslation") : <TokenizedText text={row.translationText}/>}</p></Disclosure>
        </li>)}</ul>
        <div className={styles.pages}><Button variant="secondary" disabled={disabled || loading || !previous} onClick={previous}>{t("previous")}</Button>
          <span>{t("total", { count: page.total })}</span><Button variant="secondary" disabled={disabled || loading || !next} onClick={next}>{t("next")}</Button></div>
      </> : null}
    </> : null}
  </section>;
}

export function ReleaseTranslationScope({ project, visible, canInteract, ...props }: Props & {
  project: ProjectView; visible: boolean; canInteract?: (kind?: "action" | "input") => boolean;
}) {
  const [cursors, setCursors] = useState([0]);
  const after = cursors[cursors.length - 1];
  const read = useSessionQuery({ key: ["release-translation-scope", props.locale, after], scopes: ["source", "review", "translation"],
    enabled: visible && props.selected !== undefined,
    read: () => reviewCommands.page({ ...executionContext(project), locale: props.locale, afterOrdinal: after, limit: 100, query: null }) });
  const nextOrdinal = !read.error && !read.isFetching ? read.data?.nextOrdinal : null;
  const canChange = () => visible && !props.disabled && canInteract?.("input") !== false;
  return <TranslationScopeChoices {...props} page={read.data} loading={read.isFetching} failed={!!read.error}
    onChange={value => { if (canChange()) props.onChange(value); }} retry={() => { if (canChange()) { if (after) setCursors([0]); else void read.refetch(); } }}
    previous={cursors.length > 1 ? () => { if (canChange()) setCursors(values => values.slice(0, -1)); } : undefined}
    next={nextOrdinal != null ? () => { if (canChange()) setCursors(values => [...values, nextOrdinal]); } : undefined}/>;
}
