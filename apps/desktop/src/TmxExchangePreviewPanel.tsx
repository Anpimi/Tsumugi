import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import type { SessionRequest } from "./executionCommands";
import { resourceCommands, type TmxExchangeRow, type TmxFilePreview, type TmxProvenance } from "./resourceCommands";
import { useExchangePreview } from "./useExchangePreview";

const PAGE_SIZE = 20;

/** A read-only, explicitly selected TMX report. No file path or report copy is kept in component state. */
export function TmxExchangePreviewPanel({ context, sourceLocale, locale, enabled }: {
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
    <div className="execution-actions">
      <button className="secondary-button" disabled={!canChoose} onClick={choose}>{t("tmxExchange.choose")}</button>
      {isFetching ? <button className="text-button" onClick={cancelWait}>{t("tmxExchange.cancelWait")}</button> : null}
    </div>
    {!enabled ? <p role="status">{t("tmxExchange.unavailable")}</p> : null}
    {enabled && pickerBusy && !visible ? <p role="status">{t("tmxExchange.waitingForPicker")}</p> : null}
    {isFetching ? <p role="status">{t("tmxExchange.loading")}</p> : null}
    {isSuccess && invalidated ? <p role="status">{t("tmxExchange.stale")}</p> : null}
    {error ? <div role="alert"><p>{t("tmxExchange.readFailed")}</p><CommandFailureDetails failure={commandFailure(error)} /></div> : null}
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
      <details><summary>{t("tmxExchange.digest")}</summary><code>{report.digest}</code></details>
      <details><summary>{t("tmxExchange.headerProvenance")}</summary><Provenance value={report.header} /></details>
      <p>{t("tmxExchange.mappingHelp")}</p>
      <h5>{t("tmxExchange.rowsTitle", { count: report.rows.length })}</h5>
      {report.rows.length ? <>
        <p>{t("tmxExchange.pagePosition", { first: String(first + 1), last: String(first + rows.length), count: report.rows.length })}</p>
        <ol start={first + 1}>{rows.map(row => <li key={row.ordinal}><Row value={row} /></li>)}</ol>
        <div className="execution-actions">
          <button className="secondary-button" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>{t("tmxExchange.previous")}</button>
          <button className="secondary-button" disabled={page + 1 >= pageCount} onClick={() => setPageIndex(page + 1)}>{t("tmxExchange.next")}</button>
        </div>
      </> : <p>{t("tmxExchange.noRows")}</p>}
      <h5>{t("tmxExchange.lossesTitle")}</h5>
      {report.losses.length ? <>
        <p>{t("tmxExchange.lossPagePosition", { first: String(lossFirst + 1), last: String(lossFirst + losses.length), count: report.losses.length })}</p>
        <ul>{losses.map((loss, index) => <li key={`${loss.kind}:${loss.field}:${lossFirst + index}`}>
          <p>{t(`tmxExchange.lossKinds.${loss.kind}`)} · {loss.field} · {t("tmxExchange.lossCount", { count: loss.count })}</p>
          {loss.samples.length ? <details><summary>{t("tmxExchange.samples", { count: loss.samples.length })}</summary><ul>{loss.samples.map((sample, sampleIndex) => <li key={`${sample.byteOffset}:${sample.path}:${sampleIndex}`}>
            {t("tmxExchange.sample", { path: sample.path, byteOffset: String(sample.byteOffset), ordinal: sample.ordinal === null ? t("tmxExchange.noOrdinal") : String(sample.ordinal) })}
          </li>)}</ul></details> : null}
          {loss.unlisted > 0 ? <p>{t("tmxExchange.unlisted", { count: loss.unlisted })}</p> : null}
        </li>)}</ul>
        <div className="execution-actions">
          <button className="secondary-button" disabled={lossPage === 0} onClick={() => setLossPageIndex(lossPage - 1)}>{t("tmxExchange.previousLosses")}</button>
          <button className="secondary-button" disabled={lossPage + 1 >= lossPageCount} onClick={() => setLossPageIndex(lossPage + 1)}>{t("tmxExchange.nextLosses")}</button>
        </div>
      </> : <p>{t("tmxExchange.noLosses")}</p>}
    </> : null}
  </section>;
}

function OriginalText({ value }: { value: string | null }) {
  const { t } = useTranslation();
  return value === null ? <span>{t("tmxExchange.absent")}</span> : value === "" ? <span>{t("tmxExchange.emptyText")}</span>
    : <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value}</span>;
}

function Row({ value }: { value: TmxExchangeRow }) {
  const { t } = useTranslation();
  return <article>
    <h6>{t("tmxExchange.row", { ordinal: String(value.ordinal) })} · {t(`tmxExchange.status.${value.status}`)}</h6>
    <p>{t("tmxExchange.tuid")}: <OriginalText value={value.tuid} /> · {t("tmxExchange.effectiveSource")}: {value.effectiveSourceLocale ?? t("tmxExchange.absent")}</p>
    {value.reasons.length ? <p>{t("tmxExchange.exclusionReasons")}: {value.reasons.map(reason => t(`tmxExchange.reasons.${reason}`)).join("; ")}</p> : null}
    <dl><dt>{t("tmxExchange.sourceText")}</dt><dd><OriginalText value={value.sourceText} /></dd>
      <dt>{t("tmxExchange.targetText")}</dt><dd><OriginalText value={value.targetText} /></dd></dl>
    <details><summary>{t("tmxExchange.rowProvenance")}</summary>
      <h6>{t("tmxExchange.tuProvenance")}</h6><Provenance value={value.tuProvenance} />
      <h6>{t("tmxExchange.sourceProvenance")}</h6>{value.sourceProvenance ? <Provenance value={value.sourceProvenance} /> : <p>{t("tmxExchange.absent")}</p>}
      <h6>{t("tmxExchange.targetProvenance")}</h6>{value.targetProvenance ? <Provenance value={value.targetProvenance} /> : <p>{t("tmxExchange.absent")}</p>}
    </details>
  </article>;
}

function Provenance({ value }: { value: TmxProvenance }) {
  const { t } = useTranslation();
  const fields = ["creationTool", "creationToolVersion", "originalTmFormat", "creationId", "creationDate", "changeId", "changeDate"] as const;
  return <dl>{fields.map(field => <div key={field}><dt>{t(`tmxExchange.provenance.${field}`)}</dt><dd><OriginalText value={value[field]} /></dd></div>)}</dl>;
}
