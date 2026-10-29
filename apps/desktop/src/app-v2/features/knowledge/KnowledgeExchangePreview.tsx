import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import { Button } from "../../../design-system/Button";
import { Disclosure } from "../../../design-system/Disclosure";
import { Banner } from "../../../design-system/Feedback";
import { executionContext, type SessionRequest } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands, type TmxExchangeRow, type TmxFilePreview, type TmxProvenance,
  type TbxExchangeRow, type TbxFilePreview, type TbxLossEntry, type TbxTermPreview } from "../../../resourceCommands";
import { useExchangePreview } from "../../../useExchangePreview";
import styles from "./KnowledgeExchangePreview.module.css";

export type KnowledgeExchangeFormat = "tmx" | "tbx";
export interface KnowledgeExchangePreviewProps {
  project: ProjectView; locale: string; format: KnowledgeExchangeFormat; visible: boolean; disabled: boolean;
  current: () => boolean; onClose: () => void;
}
const PAGE_SIZE = 20;

/** Uses the original transient chooser and Query owner. No path or report is persisted. */
export default function KnowledgeExchangePreview({ project, locale, format, visible, disabled, current, onClose }: KnowledgeExchangePreviewProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledgeExchange" });
  if (!visible) return null;
  const enabled = !disabled && project.metadata.targetLocales.includes(locale) && current();
  const props = { context: executionContext(project), sourceLocale: project.metadata.sourceLocale, locale, enabled };
  return <section className={styles.preview} aria-label={t("title")} onClickCapture={event => {
    if (event.target instanceof Element && event.target.closest("button") && (disabled || !current())) { event.preventDefault(); event.stopPropagation(); }
  }}>
    <header><h2>{t("title")}</h2><Button size="sm" disabled={disabled} onClick={() => { if (current()) onClose(); }}>{t("close")}</Button></header>
    <p>{t("readOnly")}</p>
    {format === "tmx" ? <TmxPreviewPanel {...props}/> : <TbxPreviewPanel {...props}/>}
  </section>;
}

/** A read-only, explicitly selected TMX report. No file path or report copy is kept in component state. */
function TmxPreviewPanel({ context, sourceLocale, locale, enabled }: {
  context: SessionRequest; sourceLocale: string; locale: string; enabled: boolean;
}) {
  const { t } = useTranslation();
  const [pageIndex, setPageIndex] = useState(0);
  const [lossPageIndex, setLossPageIndex] = useState(0);
  const selection = useExchangePreview<TmxFilePreview>({ format: "tmx", context, sourceLocale, locale, enabled,
    preview: resourceCommands.previewTmx });
  const { choose: chooseFile, cancelWait, pickerBusy, canChoose, visible, invalidated, result, isFetching, isSuccess, error } = selection;
  const report = result?.preview;
  const pageCount = report ? Math.max(1, Math.ceil(report.rows.length / PAGE_SIZE)) : 1;
  const page = Math.min(pageIndex, pageCount - 1);
  const first = page * PAGE_SIZE;
  const rows = report?.rows.slice(first, first + PAGE_SIZE) ?? [];
  const lossPageCount = report ? Math.max(1, Math.ceil(report.losses.length / PAGE_SIZE)) : 1;
  const lossPage = Math.min(lossPageIndex, lossPageCount - 1);
  const lossFirst = lossPage * PAGE_SIZE;
  const losses = report?.losses.slice(lossFirst, lossFirst + PAGE_SIZE) ?? [];

  function choose() {
    setPageIndex(0);
    setLossPageIndex(0);
    chooseFile();
  }

  return <section aria-labelledby="tmx-exchange-title">
    <h4 id="tmx-exchange-title">{t("tmxExchange.title")}</h4>
    <p>{t("tmxExchange.help")}</p>
    <p>{t("tmxExchange.limits")}</p>
    <div className={styles.actions}>
      <Button variant="secondary" size="sm" disabled={!canChoose} onClick={choose}>{t("tmxExchange.choose")}</Button>
      {isFetching ? <Button size="sm" onClick={cancelWait}>{t("tmxExchange.cancelWait")}</Button> : null}
    </div>
    {!enabled ? <p role="status">{t("tmxExchange.unavailable")}</p> : null}
    {enabled && pickerBusy && !visible ? <p role="status">{t("tmxExchange.waitingForPicker")}</p> : null}
    {isFetching ? <p role="status">{t("tmxExchange.loading")}</p> : null}
    {isSuccess && invalidated ? <p role="status">{t("tmxExchange.stale")}</p> : null}
    {error ? <Banner tone="error" role="alert"><p>{t("tmxExchange.readFailed")}</p><CommandFailureDetails failure={commandFailure(error)} /></Banner> : null}
    {isSuccess && !invalidated && result === null ? <p role="status">{t("tmxExchange.cancelled")}</p> : null}
    {report && result ? <>
      <p role="status">{t("tmxExchange.readOnly")}</p>
      <dl>
        <dt>{t("tmxExchange.file")}</dt><dd>{result.fileName}</dd>
        <dt>{t("tmxExchange.profile")}</dt><dd>{report.profile}</dd>
        <dt>{t("tmxExchange.languages")}</dt><dd>{report.sourceLocale} → {report.targetLocale}</dd>
        <dt>{t("tmxExchange.size")}</dt><dd>{t("tmxExchange.bytes", { count: report.byteLen })}</dd>
        <dt>{t("tmxExchange.license")}</dt><dd>{t("tmxExchange.licenseUnknown")}</dd>
      </dl>
      <Disclosure title={<>{t("tmxExchange.digest")}</>}><code>{report.digest}</code></Disclosure>
      <Disclosure title={<>{t("tmxExchange.headerProvenance")}</>}><Provenance value={report.header} /></Disclosure>
      <p>{t("tmxExchange.mappingHelp")}</p>
      <h5>{t("tmxExchange.rowsTitle", { count: report.rows.length })}</h5>
      {report.rows.length ? <>
        <p>{t("tmxExchange.pagePosition", { first: String(first + 1), last: String(first + rows.length), count: report.rows.length })}</p>
        <ol start={first + 1}>{rows.map(row => <li key={row.ordinal}><TmxRow value={row} /></li>)}</ol>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>{t("tmxExchange.previous")}</Button>
          <Button variant="secondary" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPageIndex(page + 1)}>{t("tmxExchange.next")}</Button>
        </div>
      </> : <p>{t("tmxExchange.noRows")}</p>}
      <h5>{t("tmxExchange.lossesTitle")}</h5>
      {report.losses.length ? <>
        <p>{t("tmxExchange.lossPagePosition", { first: String(lossFirst + 1), last: String(lossFirst + losses.length), count: report.losses.length })}</p>
        <ul>{losses.map((loss, index) => <li key={`${loss.kind}:${loss.field}:${lossFirst + index}`}>
          <p>{t(`tmxExchange.lossKinds.${loss.kind}`)} · {loss.field} · {t("tmxExchange.lossCount", { count: loss.count })}</p>
          {loss.samples.length ? <Disclosure title={<>{t("tmxExchange.samples", { count: loss.samples.length })}</>}><ul>{loss.samples.map((sample, sampleIndex) => <li key={`${sample.byteOffset}:${sample.path}:${sampleIndex}`}>
            {t("tmxExchange.sample", { path: sample.path, byteOffset: String(sample.byteOffset), ordinal: sample.ordinal === null ? t("tmxExchange.noOrdinal") : String(sample.ordinal) })}
          </li>)}</ul></Disclosure> : null}
          {loss.unlisted > 0 ? <p>{t("tmxExchange.unlisted", { count: loss.unlisted })}</p> : null}
        </li>)}</ul>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" disabled={lossPage === 0} onClick={() => setLossPageIndex(lossPage - 1)}>{t("tmxExchange.previousLosses")}</Button>
          <Button variant="secondary" size="sm" disabled={lossPage + 1 >= lossPageCount} onClick={() => setLossPageIndex(lossPage + 1)}>{t("tmxExchange.nextLosses")}</Button>
        </div>
      </> : <p>{t("tmxExchange.noLosses")}</p>}
    </> : null}
  </section>;
}

function TmxOriginalText({ value }: { value: string | null }) {
  const { t } = useTranslation();
  return value === null ? <span>{t("tmxExchange.absent")}</span> : value === "" ? <span>{t("tmxExchange.emptyText")}</span>
    : <span className={styles.original}>{value}</span>;
}

function TmxRow({ value }: { value: TmxExchangeRow }) {
  const { t } = useTranslation();
  return <article>
    <h6>{t("tmxExchange.row", { ordinal: String(value.ordinal) })} · {t(`tmxExchange.status.${value.status}`)}</h6>
    <p>{t("tmxExchange.tuid")}: <TmxOriginalText value={value.tuid} /> · {t("tmxExchange.effectiveSource")}: {value.effectiveSourceLocale ?? t("tmxExchange.absent")}</p>
    {value.reasons.length ? <p>{t("tmxExchange.exclusionReasons")}: {value.reasons.map(reason => t(`tmxExchange.reasons.${reason}`)).join("; ")}</p> : null}
    <dl><dt>{t("tmxExchange.sourceText")}</dt><dd><TmxOriginalText value={value.sourceText} /></dd>
      <dt>{t("tmxExchange.targetText")}</dt><dd><TmxOriginalText value={value.targetText} /></dd></dl>
    <Disclosure title={<>{t("tmxExchange.rowProvenance")}</>}>
      <h6>{t("tmxExchange.tuProvenance")}</h6><Provenance value={value.tuProvenance} />
      <h6>{t("tmxExchange.sourceProvenance")}</h6>{value.sourceProvenance ? <Provenance value={value.sourceProvenance} /> : <p>{t("tmxExchange.absent")}</p>}
      <h6>{t("tmxExchange.targetProvenance")}</h6>{value.targetProvenance ? <Provenance value={value.targetProvenance} /> : <p>{t("tmxExchange.absent")}</p>}
    </Disclosure>
  </article>;
}

function Provenance({ value }: { value: TmxProvenance }) {
  const { t } = useTranslation();
  const fields = ["creationTool", "creationToolVersion", "originalTmFormat", "creationId", "creationDate", "changeId", "changeDate"] as const;
  return <dl>{fields.map(field => <div key={field}><dt>{t(`tmxExchange.provenance.${field}`)}</dt><dd><TmxOriginalText value={value[field]} /></dd></div>)}</dl>;
}

/** A local, read-only report of file terms. It never selects or adopts a preferred term. */
function TbxPreviewPanel({ context, sourceLocale, locale, enabled }: {
  context: SessionRequest; sourceLocale: string; locale: string; enabled: boolean;
}) {
  const { t } = useTranslation();
  const [pageIndex, setPageIndex] = useState(0);
  const [lossPageIndex, setLossPageIndex] = useState(0);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const selection = useExchangePreview<TbxFilePreview>({ format: "tbx", context, sourceLocale, locale, enabled,
    preview: resourceCommands.previewTbx });
  const { choose: chooseFile, cancelWait, pickerBusy, canChoose, visible, invalidated, result, isFetching, isSuccess, error } = selection;
  const report = result?.preview;
  const pageCount = report ? Math.max(1, Math.ceil(report.rows.length / PAGE_SIZE)) : 1;
  const page = Math.min(pageIndex, pageCount - 1);
  const first = page * PAGE_SIZE;
  const rows = report?.rows.slice(first, first + PAGE_SIZE) ?? [];
  const lossPageCount = report ? Math.max(1, Math.ceil(report.losses.length / PAGE_SIZE)) : 1;
  const lossPage = Math.min(lossPageIndex, lossPageCount - 1);
  const lossFirst = lossPage * PAGE_SIZE;
  const losses = report?.losses.slice(lossFirst, lossFirst + PAGE_SIZE) ?? [];

  function choose() {
    setPageIndex(0);
    setLossPageIndex(0);
    setMetadataOpen(false);
    chooseFile();
  }

  return <section aria-labelledby="tbx-exchange-title">
    <h4 id="tbx-exchange-title">{t("tbxExchange.title")}</h4>
    <p>{t("tbxExchange.help")}</p>
    <p>{t("tbxExchange.limits")}</p>
    <div className={styles.actions}>
      <Button variant="secondary" size="sm" disabled={!canChoose} onClick={choose}>{t("tbxExchange.choose")}</Button>
      {isFetching ? <Button size="sm" onClick={cancelWait}>{t("tbxExchange.cancelWait")}</Button> : null}
    </div>
    {!enabled ? <p role="status">{t("tbxExchange.unavailable")}</p> : null}
    {enabled && pickerBusy && !visible ? <p role="status">{t("tbxExchange.waitingForPicker")}</p> : null}
    {isFetching ? <p role="status">{t("tbxExchange.loading")}</p> : null}
    {isSuccess && invalidated ? <p role="status">{t("tbxExchange.stale")}</p> : null}
    {error ? <Banner tone="error" role="alert"><p>{t("tbxExchange.readFailed")}</p><CommandFailureDetails failure={commandFailure(error)} /></Banner> : null}
    {isSuccess && !invalidated && result === null ? <p role="status">{t("tbxExchange.cancelled")}</p> : null}
    {report && result ? <>
      <p role="status">{t("tbxExchange.readOnly")}</p>
      <dl>
        <dt>{t("tbxExchange.file")}</dt><dd><TbxOriginalText value={result.fileName} /></dd>
        <dt>{t("tbxExchange.profile")}</dt><dd>{report.profile}</dd>
        <dt>{t("tbxExchange.languages")}</dt><dd>{report.sourceLocale} → {report.targetLocale}</dd>
        <dt>{t("tbxExchange.documentLocale")}</dt><dd>{report.documentLocale}</dd>
        <dt>{t("tbxExchange.size")}</dt><dd>{t("tbxExchange.bytes", { count: report.byteLen })}</dd>
        <dt>{t("tbxExchange.license")}</dt><dd>{t("tbxExchange.licenseUnknown")}</dd>
      </dl>
      <p>{t("tbxExchange.documentLocaleHelp")}</p>
      <p>{t("tbxExchange.schemaHints")}</p>
      <Disclosure title={<>{t("tbxExchange.digest")}</>}><code className={styles.original}>{report.digest}</code></Disclosure>
      <Button size="sm" aria-expanded={metadataOpen} onClick={() => setMetadataOpen(!metadataOpen)}>{t("tbxExchange.documentMetadata")}</Button>
      {metadataOpen ? <div>
        <h5>{t("tbxExchange.titles")}</h5>
        {report.titles.length ? <ol>{report.titles.map((value, index) => <li key={index}><TbxOriginalText value={value} /></li>)}</ol> : <p>{t("tbxExchange.absent")}</p>}
        <h5>{t("tbxExchange.sourceDescriptions")}</h5>
        {report.sourceDescriptions.length ? <ol>{report.sourceDescriptions.map((value, index) => <li key={index}><TbxOriginalText value={value} /></li>)}</ol> : <p>{t("tbxExchange.absent")}</p>}
      </div> : null}
      <p>{t("tbxExchange.mappingHelp")}</p>
      <h5>{t("tbxExchange.rowsTitle", { count: report.rows.length })}</h5>
      {report.rows.length ? <>
        <p>{t("tbxExchange.pagePosition", { first: String(first + 1), last: String(first + rows.length), count: report.rows.length })}</p>
        <ol start={first + 1}>{rows.map(row => <li key={`${report.digest}:${row.ordinal}`}><TbxConceptRow value={row} /></li>)}</ol>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>{t("tbxExchange.previous")}</Button>
          <Button variant="secondary" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPageIndex(page + 1)}>{t("tbxExchange.next")}</Button>
        </div>
      </> : <p>{t("tbxExchange.noRows")}</p>}
      <h5>{t("tbxExchange.lossesTitle")}</h5>
      {report.losses.length ? <>
        <p>{t("tbxExchange.lossPagePosition", { first: String(lossFirst + 1), last: String(lossFirst + losses.length), count: report.losses.length })}</p>
        <ul>{losses.map((loss, index) => <li key={`${loss.kind}:${loss.field}:${lossFirst + index}`}><TbxLoss value={loss} /></li>)}</ul>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" disabled={lossPage === 0} onClick={() => setLossPageIndex(lossPage - 1)}>{t("tbxExchange.previousLosses")}</Button>
          <Button variant="secondary" size="sm" disabled={lossPage + 1 >= lossPageCount} onClick={() => setLossPageIndex(lossPage + 1)}>{t("tbxExchange.nextLosses")}</Button>
        </div>
      </> : <p>{t("tbxExchange.noLosses")}</p>}
    </> : null}
  </section>;
}

function TbxOriginalText({ value }: { value: string | null }) {
  const { t } = useTranslation();
  return value === null ? <span>{t("tbxExchange.absent")}</span> : value === "" ? <span>{t("tbxExchange.emptyText")}</span>
    : <span className={styles.original}>{value}</span>;
}

function TbxConceptRow({ value }: { value: TbxExchangeRow }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <article>
    <h6>{t("tbxExchange.row", { ordinal: String(value.ordinal) })} · {t(`tbxExchange.status.${value.status}`)}</h6>
    <p>{t("tbxExchange.conceptId")}: <TbxOriginalText value={value.conceptId} /></p>
    {value.reasons.length ? <p>{t("tbxExchange.exclusionReasons")}: {value.reasons.map(reason => t(`tbxExchange.reasons.${reason}`)).join("; ")}</p> : null}
    <p>{t("tbxExchange.candidateCounts", { source: String(value.sourceTerms.length), target: String(value.targetTerms.length) })}</p>
    <Button size="sm" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>
      {expanded ? t("tbxExchange.hideCandidates") : t("tbxExchange.showCandidates")}
    </Button>
    {expanded ? <div id={detailsId}>
      <TbxTermList role="source" terms={value.sourceTerms} />
      <TbxTermList role="target" terms={value.targetTerms} />
    </div> : null}
  </article>;
}

function TbxTermList({ role, terms }: { role: "source" | "target"; terms: TbxTermPreview[] }) {
  const { t } = useTranslation();
  const [pageIndex, setPageIndex] = useState(0);
  const pageCount = Math.max(1, Math.ceil(terms.length / PAGE_SIZE));
  const page = Math.min(pageIndex, pageCount - 1);
  const first = page * PAGE_SIZE;
  const shown = terms.slice(first, first + PAGE_SIZE);
  return <section aria-label={t(role === "source" ? "tbxExchange.sourceTerms" : "tbxExchange.targetTerms")}>
    <h6>{t("tbxExchange.termsTitle", { role: t(role === "source" ? "tbxExchange.sourceTerms" : "tbxExchange.targetTerms"), count: terms.length })}</h6>
    {terms.length ? <>
      <p>{t("tbxExchange.termPagePosition", { first: String(first + 1), last: String(first + shown.length), count: terms.length })}</p>
      <ol start={first + 1}>{shown.map(term => <li key={`${term.languageOrdinal}:${term.ordinal}`}><TbxTerm value={term} /></li>)}</ol>
      <div className={styles.actions}>
        <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>{t("tbxExchange.previousTerms")}</Button>
        <Button variant="secondary" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPageIndex(page + 1)}>{t("tbxExchange.nextTerms")}</Button>
      </div>
    </> : <p>{t("tbxExchange.noTerms")}</p>}
  </section>;
}

function TbxTerm({ value }: { value: TbxTermPreview }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <div>
    <p>{t("tbxExchange.termPosition", { languageOrdinal: String(value.languageOrdinal), ordinal: String(value.ordinal) })} · {t("tbxExchange.termSecId")}: <TbxOriginalText value={value.termSecId} /></p>
    <p>{t("tbxExchange.termText")}: <TbxOriginalText value={value.text} /></p>
    {value.reasons.length ? <p>{t("tbxExchange.termReasonsTitle")}: {value.reasons.map(reason => t(`tbxExchange.termReasons.${reason}`)).join("; ")}</p> : null}
    <Button size="sm" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>{t("tbxExchange.termMetadata")}</Button>
    {expanded ? <div id={detailsId}>
      <p>{t("tbxExchange.termMetadataHelp")}</p>
      <h6>{t("tbxExchange.usageStatuses")}</h6>
      {value.usageStatuses.length ? <ol>{value.usageStatuses.map((status, index) => <li key={index}><TbxOriginalText value={status} /></li>)}</ol> : <p>{t("tbxExchange.absent")}</p>}
      <h6>{t("tbxExchange.termSources")}</h6>
      {value.sources.length ? <ol>{value.sources.map((source, index) => <li key={index}><TbxOriginalText value={source} /></li>)}</ol> : <p>{t("tbxExchange.absent")}</p>}
    </div> : null}
  </div>;
}

function TbxLoss({ value }: { value: TbxLossEntry }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <div>
    <p>{t(`tbxExchange.lossKinds.${value.kind}`)} · <span className={styles.original}>{value.field}</span> · {t("tbxExchange.lossCount", { count: value.count })}</p>
    {value.samples.length ? <>
      <Button size="sm" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>{t("tbxExchange.samples", { count: value.samples.length })}</Button>
      {expanded ? <ul id={detailsId}>{value.samples.map((sample, index) => <li key={`${sample.byteOffset}:${sample.path}:${index}`}>
        {t("tbxExchange.sample", { path: sample.path, byteOffset: String(sample.byteOffset), ordinal: sample.ordinal === null ? t("tbxExchange.noOrdinal") : String(sample.ordinal) })}
      </li>)}</ul> : null}
    </> : null}
    {value.unlisted > 0 ? <p>{t("tbxExchange.unlisted", { count: value.unlisted })}</p> : null}
  </div>;
}
