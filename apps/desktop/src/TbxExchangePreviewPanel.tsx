import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import type { SessionRequest } from "./executionCommands";
import { resourceCommands, type TbxExchangeRow, type TbxFilePreview, type TbxLossEntry, type TbxTermPreview } from "./resourceCommands";
import { useExchangePreview } from "./useExchangePreview";

const PAGE_SIZE = 20;

/** A local, read-only report of file terms. It never selects or adopts a preferred term. */
export function TbxExchangePreviewPanel({ context, sourceLocale, locale, enabled }: {
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
    <div className="execution-actions">
      <button className="secondary-button" disabled={!canChoose} onClick={choose}>{t("tbxExchange.choose")}</button>
      {isFetching ? <button className="text-button" onClick={cancelWait}>{t("tbxExchange.cancelWait")}</button> : null}
    </div>
    {!enabled ? <p role="status">{t("tbxExchange.unavailable")}</p> : null}
    {enabled && pickerBusy && !visible ? <p role="status">{t("tbxExchange.waitingForPicker")}</p> : null}
    {isFetching ? <p role="status">{t("tbxExchange.loading")}</p> : null}
    {isSuccess && invalidated ? <p role="status">{t("tbxExchange.stale")}</p> : null}
    {error ? <div role="alert"><p>{t("tbxExchange.readFailed")}</p><CommandFailureDetails failure={commandFailure(error)} /></div> : null}
    {isSuccess && !invalidated && result === null ? <p role="status">{t("tbxExchange.cancelled")}</p> : null}
    {report && result ? <>
      <p role="status">{t("tbxExchange.readOnly")}</p>
      <dl>
        <dt>{t("tbxExchange.file")}</dt><dd><OriginalText value={result.fileName} /></dd>
        <dt>{t("tbxExchange.profile")}</dt><dd>{report.profile}</dd>
        <dt>{t("tbxExchange.languages")}</dt><dd>{report.sourceLocale} → {report.targetLocale}</dd>
        <dt>{t("tbxExchange.documentLocale")}</dt><dd>{report.documentLocale}</dd>
        <dt>{t("tbxExchange.size")}</dt><dd>{t("tbxExchange.bytes", { count: report.byteLen })}</dd>
        <dt>{t("tbxExchange.license")}</dt><dd>{t("tbxExchange.licenseUnknown")}</dd>
      </dl>
      <p>{t("tbxExchange.documentLocaleHelp")}</p>
      <p>{t("tbxExchange.schemaHints")}</p>
      <details><summary>{t("tbxExchange.digest")}</summary><code style={{ overflowWrap: "anywhere" }}>{report.digest}</code></details>
      <button className="text-button" aria-expanded={metadataOpen} onClick={() => setMetadataOpen(!metadataOpen)}>{t("tbxExchange.documentMetadata")}</button>
      {metadataOpen ? <div>
        <h5>{t("tbxExchange.titles")}</h5>
        {report.titles.length ? <ol>{report.titles.map((value, index) => <li key={index}><OriginalText value={value} /></li>)}</ol> : <p>{t("tbxExchange.absent")}</p>}
        <h5>{t("tbxExchange.sourceDescriptions")}</h5>
        {report.sourceDescriptions.length ? <ol>{report.sourceDescriptions.map((value, index) => <li key={index}><OriginalText value={value} /></li>)}</ol> : <p>{t("tbxExchange.absent")}</p>}
      </div> : null}
      <p>{t("tbxExchange.mappingHelp")}</p>
      <h5>{t("tbxExchange.rowsTitle", { count: report.rows.length })}</h5>
      {report.rows.length ? <>
        <p>{t("tbxExchange.pagePosition", { first: String(first + 1), last: String(first + rows.length), count: report.rows.length })}</p>
        <ol start={first + 1}>{rows.map(row => <li key={`${report.digest}:${row.ordinal}`}><ConceptRow value={row} /></li>)}</ol>
        <div className="execution-actions">
          <button className="secondary-button" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>{t("tbxExchange.previous")}</button>
          <button className="secondary-button" disabled={page + 1 >= pageCount} onClick={() => setPageIndex(page + 1)}>{t("tbxExchange.next")}</button>
        </div>
      </> : <p>{t("tbxExchange.noRows")}</p>}
      <h5>{t("tbxExchange.lossesTitle")}</h5>
      {report.losses.length ? <>
        <p>{t("tbxExchange.lossPagePosition", { first: String(lossFirst + 1), last: String(lossFirst + losses.length), count: report.losses.length })}</p>
        <ul>{losses.map((loss, index) => <li key={`${loss.kind}:${loss.field}:${lossFirst + index}`}><Loss value={loss} /></li>)}</ul>
        <div className="execution-actions">
          <button className="secondary-button" disabled={lossPage === 0} onClick={() => setLossPageIndex(lossPage - 1)}>{t("tbxExchange.previousLosses")}</button>
          <button className="secondary-button" disabled={lossPage + 1 >= lossPageCount} onClick={() => setLossPageIndex(lossPage + 1)}>{t("tbxExchange.nextLosses")}</button>
        </div>
      </> : <p>{t("tbxExchange.noLosses")}</p>}
    </> : null}
  </section>;
}

function OriginalText({ value }: { value: string | null }) {
  const { t } = useTranslation();
  return value === null ? <span>{t("tbxExchange.absent")}</span> : value === "" ? <span>{t("tbxExchange.emptyText")}</span>
    : <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value}</span>;
}

function ConceptRow({ value }: { value: TbxExchangeRow }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <article>
    <h6>{t("tbxExchange.row", { ordinal: String(value.ordinal) })} · {t(`tbxExchange.status.${value.status}`)}</h6>
    <p>{t("tbxExchange.conceptId")}: <OriginalText value={value.conceptId} /></p>
    {value.reasons.length ? <p>{t("tbxExchange.exclusionReasons")}: {value.reasons.map(reason => t(`tbxExchange.reasons.${reason}`)).join("; ")}</p> : null}
    <p>{t("tbxExchange.candidateCounts", { source: String(value.sourceTerms.length), target: String(value.targetTerms.length) })}</p>
    <button className="text-button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>
      {expanded ? t("tbxExchange.hideCandidates") : t("tbxExchange.showCandidates")}
    </button>
    {expanded ? <div id={detailsId}>
      <TermList role="source" terms={value.sourceTerms} />
      <TermList role="target" terms={value.targetTerms} />
    </div> : null}
  </article>;
}

function TermList({ role, terms }: { role: "source" | "target"; terms: TbxTermPreview[] }) {
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
      <ol start={first + 1}>{shown.map(term => <li key={`${term.languageOrdinal}:${term.ordinal}`}><Term value={term} /></li>)}</ol>
      <div className="execution-actions">
        <button className="secondary-button" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>{t("tbxExchange.previousTerms")}</button>
        <button className="secondary-button" disabled={page + 1 >= pageCount} onClick={() => setPageIndex(page + 1)}>{t("tbxExchange.nextTerms")}</button>
      </div>
    </> : <p>{t("tbxExchange.noTerms")}</p>}
  </section>;
}

function Term({ value }: { value: TbxTermPreview }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <div>
    <p>{t("tbxExchange.termPosition", { languageOrdinal: String(value.languageOrdinal), ordinal: String(value.ordinal) })} · {t("tbxExchange.termSecId")}: <OriginalText value={value.termSecId} /></p>
    <p>{t("tbxExchange.termText")}: <OriginalText value={value.text} /></p>
    {value.reasons.length ? <p>{t("tbxExchange.termReasonsTitle")}: {value.reasons.map(reason => t(`tbxExchange.termReasons.${reason}`)).join("; ")}</p> : null}
    <button className="text-button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>{t("tbxExchange.termMetadata")}</button>
    {expanded ? <div id={detailsId}>
      <p>{t("tbxExchange.termMetadataHelp")}</p>
      <h6>{t("tbxExchange.usageStatuses")}</h6>
      {value.usageStatuses.length ? <ol>{value.usageStatuses.map((status, index) => <li key={index}><OriginalText value={status} /></li>)}</ol> : <p>{t("tbxExchange.absent")}</p>}
      <h6>{t("tbxExchange.termSources")}</h6>
      {value.sources.length ? <ol>{value.sources.map((source, index) => <li key={index}><OriginalText value={source} /></li>)}</ol> : <p>{t("tbxExchange.absent")}</p>}
    </div> : null}
  </div>;
}

function Loss({ value }: { value: TbxLossEntry }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <div>
    <p>{t(`tbxExchange.lossKinds.${value.kind}`)} · <span style={{ overflowWrap: "anywhere" }}>{value.field}</span> · {t("tbxExchange.lossCount", { count: value.count })}</p>
    {value.samples.length ? <>
      <button className="text-button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>{t("tbxExchange.samples", { count: value.samples.length })}</button>
      {expanded ? <ul id={detailsId}>{value.samples.map((sample, index) => <li key={`${sample.byteOffset}:${sample.path}:${index}`}>
        {t("tbxExchange.sample", { path: sample.path, byteOffset: String(sample.byteOffset), ordinal: sample.ordinal === null ? t("tbxExchange.noOrdinal") : String(sample.ordinal) })}
      </li>)}</ul> : null}
    </> : null}
    {value.unlisted > 0 ? <p>{t("tbxExchange.unlisted", { count: value.unlisted })}</p> : null}
  </div>;
}
