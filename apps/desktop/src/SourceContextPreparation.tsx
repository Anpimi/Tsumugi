import { useTranslation } from "react-i18next";
import type { AiConfig, AiItem } from "./aiCommands";
import { sourceContextMinBytes, validSourceContextSelection } from "./aiCommands";

type Selection = AiConfig["sourceContext"];

export function SourceContextSelectionSummary({ value }: { value: Selection }) {
  const { t } = useTranslation();
  const count = Number(value.extracted) + Number(value.inferred) + Number(value.neighbors);
  return <p>{count ? t("sourceContext.selectionSummary", { count, bytes: String(value.maxBytes), items: String(value.maxItems) }) : t("sourceContext.notSelected")}</p>;
}

/** Controlled preparation input; the existing draft owner invalidates preview
 * and consent when any source category or budget changes. */
export function SourceContextChoice({ value, onChange }: { value: Selection; onChange: (next: Selection) => void }) {
  const { t } = useTranslation();
  const enabled = value.extracted || value.inferred || value.neighbors;
  const valid = validSourceContextSelection(value);
  return <fieldset className="source-context-choice">
    <legend>{t("sourceContext.title")}</legend>
    <p>{t("sourceContext.help")}</p>
    {(["extracted", "inferred", "neighbors"] as const).map(key => <label className="source-check" key={key}>
      <input type="checkbox" checked={value[key]} onChange={event => onChange({ ...value, [key]: event.target.checked })}/>{t(`sourceContext.choose.${key}`)}
    </label>)}
    <SourceContextSelectionSummary value={value}/>
    {enabled ? <>
      <label className="field">{t("sourceContext.maxBytes")}<input type="number" min={sourceContextMinBytes} max={16384} value={Number.isFinite(value.maxBytes) ? value.maxBytes : ""}
        aria-invalid={!valid || undefined} onChange={event => onChange({ ...value, maxBytes: event.target.valueAsNumber })}/></label>
      <label className="field">{t("sourceContext.maxItems")}<input type="number" min={1} max={128} value={Number.isFinite(value.maxItems) ? value.maxItems : ""}
        aria-invalid={!valid || undefined} onChange={event => onChange({ ...value, maxItems: event.target.valueAsNumber })}/></label>
      {!valid ? <p className="field-error">{t("sourceContext.invalidBudget")}</p> : null}
    </> : null}
  </fieldset>;
}

export function SourceContextPreview({ capture }: { capture: AiItem["sourceContext"] }) {
  const { t } = useTranslation();
  if (capture.kind === "not-selected") return <p>{t("sourceContext.notSelected")}</p>;
  const value = capture.value;
  const omitted = value.omissions;
  const observation = value.observations;
  const omittedTotal = omitted.notSelected + omitted.byteBudget + omitted.itemLimit;
  return <section aria-label={t("sourceContext.title")}>
    <h5>{t("sourceContext.title")}</h5>
    <p>{t("sourceContext.included", { facts: String(value.facts.length), neighbors: String(value.neighbors.length) })}</p>
    {value.facts.map(item => <article key={`${item.blockIndex}:${item.factIndex}`}>
      <p>{t(`sourceContext.factKinds.${item.fact.kind}`)} · {t(`sourceContext.origins.${item.fact.origin.kind}`)}</p>
      <pre className="ai-text">{item.fact.text}</pre>
      {item.fact.origin.kind === "inferred" ? <p>{t("sourceContext.rationale", { rationale: item.fact.origin.rationale })}</p> : null}
      <details><summary>{t("sourceContext.references")}</summary>
        <ul>{item.fact.origin.sources.map(reference => <li key={`${reference.artifactId}:${reference.range.encoding}:${reference.range.start}:${reference.range.end}`}>{t("sourceContext.referenceRange", {
          artifact: reference.artifactId, start: String(reference.range.start), end: String(reference.range.end), encoding: reference.range.encoding,
        })}</li>)}</ul>
      </details>
    </article>)}
    {value.neighbors.map(neighbor => {
      const directions = new Set(neighbor.adjacentTo.map(edge => edge.direction));
      const position = directions.size === 2 ? "both" : directions.has("before") ? "before" : "after";
      return <article key={neighbor.occurrence.occurrenceId}>
        <p>{t(`sourceContext.positions.${position}`)}</p><pre className="ai-text">{neighbor.text}</pre>
      </article>;
    })}
    {observation.missingBlocks ? <p>{t("sourceContext.missing")}</p> : null}
    {observation.emptyBlocks ? <p>{t("sourceContext.empty", { count: observation.emptyBlocks })}</p> : null}
    {observation.unknownBlocks ? <p>{t("sourceContext.unknown", { count: observation.unknownBlocks })}</p> : null}
    {omitted.notSelected ? <p>{t("sourceContext.excluded", { count: omitted.notSelected })}</p> : null}
    {omitted.byteBudget ? <p>{t("sourceContext.byteOmissions", { count: omitted.byteBudget })}</p> : null}
    {omitted.itemLimit ? <p>{t("sourceContext.itemOmissions", { count: omitted.itemLimit })}</p> : null}
    {omittedTotal ? <p>{t("sourceContext.omittedGroups", { extracted: String(omitted.extracted), inferred: String(omitted.inferred), neighbors: String(omitted.neighbors) })}</p> : null}
    {omitted.samples.length ? <details><summary>{t("sourceContext.omissionReferences")}</summary>
      <ul>{omitted.samples.map(sample => <li key={sample.kind === "fact" ? `fact:${sample.blockIndex}:${sample.factIndex}` : `neighbor:${sample.occurrenceId}`}>
        {sample.kind === "fact"
          ? t("sourceContext.omittedFact", { block: String(sample.blockIndex), fact: String(sample.factIndex), reason: t(`sourceContext.omissionReasons.${sample.reason}`) })
          : t("sourceContext.omittedNeighbor", { occurrence: sample.occurrenceId, reason: t(`sourceContext.omissionReasons.${sample.reason}`) })}
      </li>)}</ul>
    </details> : null}
    {omittedTotal > omitted.samples.length ? <p>{t("sourceContext.unsampled", { count: omittedTotal - omitted.samples.length })}</p> : null}
  </section>;
}

/** Local decision evidence is displayed independently of the raw source categories. */
export function ProjectFactPreview({capture}:{capture:AiItem["projectContext"]}) {
  const {t}=useTranslation();if(capture.kind==="not-selected")return null;
  return <section aria-label={t("contextFacts.preview")}><h5>{t("contextFacts.preview")}</h5>
    <p>{t("contextFacts.applied",{count:capture.decisions.length})}</p>
    {capture.manual?capture.decisions.map(v=>v.request.disposition.kind==="replace"?<article key={v.request.actionId}><p>{t(`sourceContext.factKinds.${v.request.basis.fact.fact.kind}`)} · {t("contextFacts.manual")}</p><pre>{v.request.disposition.text}</pre></article>:null):capture.decisions.some(v=>v.request.disposition.kind==="replace")?<p>{t("contextFacts.manualNotShared")}</p>:null}
  </section>;
}
