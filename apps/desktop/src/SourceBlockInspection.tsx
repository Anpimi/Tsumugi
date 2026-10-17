import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import type { SessionRequest } from "./executionCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { sourceCommands, type SourceContextBlockBasis, type SourceContextBlockDescriptor } from "./sourceCommands";

function OriginalRecord({ context, basis, descriptor }: { context: SessionRequest; basis: SourceContextBlockBasis; descriptor: SourceContextBlockDescriptor }) {
  const { t } = useTranslation(), reads = useSessionReads();
  const key = ["source-context-block", basis, descriptor];
  const query = useSessionQuery({ key, scopes: ["source", "project"], enabled: true,
    read: () => sourceCommands.sourceContextBlock({ ...context, basis, descriptor }) });
  const state = reads.client.getQueryState(reads.key(key));
  const ready = query.isSuccess && !query.isFetching && !query.error && !state?.isInvalidated;
  return <section aria-label={t("sourceBlockRead.record")}>
    <h6>{t("sourceBlockRead.record")}</h6>
    {query.isFetching || query.isPending ? <p role="status">{t("sourceBlockRead.loading")}</p> : null}
    {query.error ? <div role="alert"><p>{t("sourceBlockRead.failed")}</p><CommandFailureDetails failure={commandFailure(query.error)} />
      <button type="button" className="secondary-button" disabled={query.isFetching} onClick={() => void query.refetch()}>{t("sourceBlockRead.retry")}</button></div> : null}
    {ready && query.data ? <pre className="ai-text">{query.data.payloadUtf8}</pre> : null}
  </section>;
}

/** A local record inspector. It never interprets or rewrites the stored payload. */
export function SourceBlockInspection({ context, basis, descriptor }: { context: SessionRequest; basis: SourceContextBlockBasis; descriptor: SourceContextBlockDescriptor }) {
  const { t } = useTranslation(), reads = useSessionReads(), id = useId(), [expanded, setExpanded] = useState(false);
  const current = !reads.retired && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
    && basis.scope.projectId === context.projectId;
  return <article>
    <h6>{t("sourceBlockRead.title", { number: String(descriptor.blockIndex + 1) })}</h6>
    <p>{t(`sourceBlockRead.applies.${descriptor.target.kind}`)}</p>
    <button type="button" className="text-button" disabled={!current} aria-expanded={expanded && current} aria-controls={id}
      onClick={() => setExpanded(value => !value)}>{t(expanded ? "sourceBlockRead.close" : "sourceBlockRead.open")}</button>
    <details><summary>{t("sourceContextRead.provenance")}</summary><dl>
      <dt>{t("sourceContextRead.target")}</dt><dd><code>{descriptor.target.kind}{descriptor.target.kind === "snapshot" ? "" : ` · ${descriptor.target.id}`}</code></dd>
      <dt>{t("sourceContextRead.schema")}</dt><dd><code>{descriptor.schema.id} · {descriptor.schema.schemaVersion}/{descriptor.schema.behaviorVersion}</code></dd>
      <dt>{t("sourceContextRead.handling")}</dt><dd>{t(`sourceContextRead.handlingKinds.${descriptor.handling}`)}</dd>
      <dt>{t("sourceContextRead.revisionBasis")}</dt><dd>{t(descriptor.inRevisionBasis ? "sourceContextRead.inRevision" : "sourceContextRead.outsideRevision")}</dd>
      <dt>{t("sourceBlockRead.bytes")}</dt><dd>{String(descriptor.payloadBytes)}</dd>
    </dl></details>
    {expanded && current ? <div id={id}><OriginalRecord context={context} basis={basis} descriptor={descriptor} /></div> : null}
  </article>;
}
