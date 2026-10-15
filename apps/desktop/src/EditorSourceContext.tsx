import { useTranslation } from "react-i18next";
import { useSessionInfiniteQuery, useSessionReads } from "./SessionReadProvider";
import { sourceCommands, type SourceContextBlock, type SourceContextNeighbor, type SourceContextPage } from "./sourceCommands";
import type { SessionRequest } from "./executionCommands";

const pageLimit = 4;
type Scope = SourceContextPage["scope"];
type Cursor = { after: number; basis: string | null };

/** All pages of one reference view must come from the same checked source result. */
function pageBasis(page: SourceContextPage): string {
  return JSON.stringify([page.scope, page.contentRevision, page.sourceAttemptId, page.sourceResultId,
    page.sourceResultDigest, page.sourceLocale, page.localUnitId, page.occurrenceCount, page.observations, page.totalEntries]);
}

function Block({ block }: { block: SourceContextBlock }) {
  const { t } = useTranslation();
  return <article>
    <h6>{t("sourceContextRead.block", { number: String(block.blockIndex + 1) })}</h6>
    {block.facts === null ? <p>{t(block.handling === "required" ? "sourceContextRead.unknownRequired" : "sourceContextRead.unknownBlock")}</p>
      : block.facts.facts.length === 0 ? <p>{t("sourceContextRead.emptyBlock")}</p>
      : <ul>{block.facts.facts.map((fact, index) => <li key={`${block.blockIndex}:${fact.id}:${index}`}>
        <p>{t(`sourceContext.factKinds.${fact.kind}`)} · {t(`sourceContext.origins.${fact.origin.kind}`)}</p>
        <pre>{fact.text}</pre>
        {fact.origin.kind === "inferred" ? <p>{t("sourceContext.rationale", { rationale: fact.origin.rationale })}</p> : null}
        <details><summary>{t("sourceContext.references")}</summary><ul>{fact.origin.sources.map((reference, sourceIndex) =>
          <li key={`${reference.artifactId}:${sourceIndex}`}>{t("sourceContext.referenceRange", {
            artifact: reference.artifactId, encoding: reference.range.encoding,
            start: String(reference.range.start), end: String(reference.range.end),
          })}</li>)}</ul></details>
      </li>)}</ul>}
    <details><summary>{t("sourceContextRead.provenance")}</summary><dl>
      <dt>{t("sourceContextRead.target")}</dt><dd><code>{block.target.kind}{block.target.kind === "snapshot" ? "" : ` · ${block.target.id}`}</code></dd>
      <dt>{t("sourceContextRead.schema")}</dt><dd><code>{block.schema.id} · {block.schema.schemaVersion}/{block.schema.behaviorVersion}</code></dd>
      <dt>{t("sourceContextRead.handling")}</dt><dd>{t(`sourceContextRead.handlingKinds.${block.handling}`)}</dd>
      <dt>{t("sourceContextRead.revisionBasis")}</dt><dd>{t(block.inRevisionBasis ? "sourceContextRead.inRevision" : "sourceContextRead.outsideRevision")}</dd>
    </dl></details>
  </article>;
}

function Neighbor({ neighbor }: { neighbor: SourceContextNeighbor }) {
  const { t } = useTranslation();
  const directions = new Set(neighbor.adjacentTo.map(edge => edge.direction));
  const position = directions.size === 2 ? "both" : directions.has("before") ? "before" : "after";
  const source = neighbor.occurrence.source;
  return <article>
    <h6>{t(`sourceContext.positions.${position}`)}</h6><pre>{neighbor.text}</pre>
    <details><summary>{t("sourceContextRead.provenance")}</summary><dl>
      <dt>{t("sourceContextRead.occurrence")}</dt><dd><code>{neighbor.occurrence.localOccurrenceId}</code></dd>
      <dt>{t("sourceContextRead.reference")}</dt><dd><code>{t("sourceContext.referenceRange", {
        artifact: source.artifactId, encoding: source.range.encoding,
        start: String(source.range.start), end: String(source.range.end),
      })}</code></dd>
    </dl></details>
  </article>;
}

/** An on-demand reference only. It never edits the translation draft or grants AI sharing. */
export function EditorSourceContext({ context, scope, enabled, sourceChanged = false }: {
  context: SessionRequest; scope: Scope | null; enabled: boolean; sourceChanged?: boolean;
}) {
  const { t } = useTranslation(), reads = useSessionReads();
  const key = ["translation-editor-source-context", scope?.projectId ?? "", scope?.sourceSnapshotId ?? "",
    scope?.unitId ?? "", scope?.sourceRevisionId ?? "", scope?.locale ?? "", pageLimit];
  const active = enabled && scope !== null && !sourceChanged;
  const read = useSessionInfiniteQuery<SourceContextPage, Cursor>({
    key, scopes: ["source", "project"], enabled: active, initialPageParam: { after: 0, basis: null },
    nextPage: (last, pages) => last.nextAfter === null ? undefined : { after: last.nextAfter, basis: pageBasis(pages[0]) },
    read: async cursor => {
      if (!scope) throw new Error("No current source context scope");
      const page = await sourceCommands.sourceContext({ ...context, ...scope, after: cursor.after, limit: pageLimit });
      if (cursor.basis !== null && cursor.basis !== pageBasis(page)) throw { reason: "source-context-read-changed" };
      return page;
    },
  });
  const queryState = reads.client.getQueryState(reads.key(key));
  const pages = read.data?.pages ?? [];
  const consistent = pages.length > 0 && pages.every((page, index) => pageBasis(page) === pageBasis(pages[0])
    && (index === 0 ? page.after === 0 : page.after === pages[index - 1].nextAfter));
  const ready = active && read.isSuccess && !read.isFetching && !read.error && !queryState?.isInvalidated && consistent;
  const loaded = pages.reduce((count, page) => count + page.entries.length, 0);
  const changed = read.error && typeof read.error === "object" && "reason" in read.error
    && read.error.reason === "source-context-read-changed";
  const retry = () => {
    if (read.isFetchNextPageError && !changed) void read.fetchNextPage();
    else void reads.client.resetQueries({ queryKey: reads.key(key), exact: true });
  };
  return <section className="editor-memory" aria-label={t("sourceContextRead.title")}>
    <div className="execution-section-heading"><h5>{t("sourceContextRead.title")}</h5>
      <button type="button" className="text-button" disabled={!active || read.isFetching}
        onClick={() => void reads.client.resetQueries({ queryKey: reads.key(key), exact: true })}>{t("sourceContextRead.refresh")}</button>
    </div>
    <p>{t("sourceContextRead.help")}</p>
    {!enabled ? null : sourceChanged ? <p role="status">{t("sourceContextRead.sourceChanged")}</p>
      : !scope ? <p role="status">{t("sourceContextRead.unavailable")}</p>
      : read.isFetching || read.isPending ? <p role="status">{t("sourceContextRead.loading")}</p>
      : read.error || !consistent ? <p role="alert">{t(changed || (!read.error && !consistent) ? "sourceContextRead.basisChanged" : "sourceContextRead.readFailed")}
          <button type="button" className="secondary-button" onClick={retry}>{t("sourceContextRead.retry")}</button></p> : null}
    {ready ? <>
      <p>{t("sourceContextRead.progress", { loaded: String(loaded), total: String(pages[0].totalEntries) })}</p>
      {pages[0].observations.missingBlocks ? <p>{t("sourceContext.missing")}</p> : null}
      {pages[0].observations.emptyBlocks ? <p>{t("sourceContext.empty", { count: pages[0].observations.emptyBlocks })}</p> : null}
      {pages[0].observations.unknownBlocks ? <p>{t("sourceContext.unknown", { count: pages[0].observations.unknownBlocks })}</p> : null}
      {pages[0].observations.unknownRequiredBlocks ? <p>{t("sourceContextRead.requiredUnknownCount", { count: pages[0].observations.unknownRequiredBlocks })}</p> : null}
      {pages[0].totalEntries === 0 ? <p>{t("sourceContextRead.noEntries")}</p> : null}
      {pages.flatMap(page => page.entries).map((entry, index) => <div key={index}>
        {entry.kind === "block" ? <Block block={entry.value} /> : <Neighbor neighbor={entry.value} />}
      </div>)}
      {read.hasNextPage ? <button type="button" className="secondary-button" disabled={read.isFetching}
        onClick={() => void read.fetchNextPage()}>{t("sourceContextRead.more")}</button> : <p>{t("sourceContextRead.complete")}</p>}
    </> : null}
  </section>;
}
