import { useWorkbenchState } from "./WorkbenchFrame";
import { reviewReasonKey } from "./reviewLabels";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { QueryKey } from "@tanstack/react-query";
import type { ProjectView } from "./projectCommands";
import type { EditorTarget } from "./TranslationWorkbench";
import { executionContext } from "./executionCommands";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { sourceReads } from "./sourceQueries";
import { useWorkbenchCommands, type CommandAvailability, type SourceHistoryContentCommandPayload,
  type SourceLineageCommandPayload, type SourceImpactCommandPayload, type SourceImpactTargetCommandPayload } from "./workbenchCommands";
import { sourceCommands as commands, type ContentPage, type Coverage, type SourceOccurrence, type SourceHistory, type LineageEvidence, type SourceImpactRow } from "./sourceCommands";

export function useSourceOccurrenceLabel() {
  const { t } = useTranslation();
  return (occurrence: SourceOccurrence) => occurrence.nativeIdentity?.display.value ?? t("source.entryLabel", { number: String(occurrence.ordinal + 1) });
}

function SourceReferenceView({ reference, coverage, label }: { reference: SourceOccurrence["source"]; coverage: Coverage[] | undefined; label: string }) {
  const { t } = useTranslation();
  const file = coverage?.find(item => item.artifactId === reference.artifactId);
  const encodings = { "utf8-byte": t("source.referenceEncoding.utf8"), utf16: t("source.referenceEncoding.utf16"), grapheme: t("source.referenceEncoding.grapheme") };
  const encoding = encodings[reference.range.encoding];
  return <p>{label} · {file?.logicalPath ?? t("source.referenceUnavailable")} · {t("source.referenceRange", { encoding, start: String(reference.range.start), end: String(reference.range.end) })}</p>;
}

/** Coverage comes from the captured snapshot or result, never a domain path convention. */
export function SourceOccurrenceOrigin({ occurrence, coverage, readCoverage, children }: { occurrence: SourceOccurrence; coverage?: Coverage[]; readCoverage?: () => Promise<Coverage[]>; children?: ReactNode }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Coverage[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function load() {
    if (coverage !== undefined || loaded !== undefined || busy || !readCoverage) return;
    const ticket = ++generation.current;
    setBusy(true); setFailed(false);
    try { const next = await readCoverage(); if (generation.current === ticket) setLoaded(next); }
    catch { if (generation.current === ticket) setFailed(true); }
    finally { if (generation.current === ticket) setBusy(false); }
  }
  const files = coverage ?? loaded;
  return <details onToggle={event => { if (event.currentTarget.open) void load(); }}><summary>{t("source.origin")}</summary>
    {busy ? <p role="status">{t("execution.working")}</p> : null}
    {failed ? <><p role="alert">{t("source.referenceUnavailable")}</p><button type="button" className="text-button" disabled={busy} onClick={() => void load()}>{t("execution.refresh")}</button></> : null}
    <SourceReferenceView reference={occurrence.source} coverage={files} label={t("source.text")} />
    {occurrence.nativeIdentity?.display.source ? <SourceReferenceView reference={occurrence.nativeIdentity.display.source} coverage={files} label={t("source.key")} /> : null}
    {children}
  </details>;
}

export async function readSourceHistoryCoverage(context: ReturnType<typeof executionContext>, snapshotId: string): Promise<Coverage[]> {
  const page = await commands.historyContent({ ...context, snapshotId, query: "", after: 0, limit: 1 });
  if (page.snapshotId !== snapshotId) throw new Error("Source history snapshot mismatch");
  return page.coverage;
}

export function LineageEvidenceView({ evidence, project, history }: { evidence: LineageEvidence[]; project: ProjectView; history?: SourceHistory | null }) {
  const { t } = useTranslation();
  const label = useSourceOccurrenceLabel();
  const context = executionContext(project);
  return evidence.length ? <ul>{evidence.map(edge => <li key={edge.old.occurrenceId}>
    <strong>{label(edge.old.occurrence)}</strong><pre>{edge.old.occurrence.text}</pre>
    <p>{t(edge.decision === "continue" ? "source.evidenceDecision.continue" : edge.decision === "reject" ? "source.evidenceDecision.reject" : edge.appliedRelation === "unchanged" ? "source.evidenceAutomatic" : "source.evidenceDecision.candidate")} · {edge.actor ?? t("source.proposed")}</p>
    {edge.reason ? <p>{edge.reason}</p> : null}
    <SourceOccurrenceOrigin key={`${project.sessionToken}:${project.metadata.projectId}:${edge.oldSnapshotId}:${edge.old.occurrenceId}`} occurrence={edge.old.occurrence} coverage={history?.snapshots.find(entry => entry.snapshotId === edge.oldSnapshotId)?.coverage} readCoverage={() => readSourceHistoryCoverage(context, edge.oldSnapshotId)}>
      <details><summary>{t("execution.diagnostic")}</summary><p>{edge.policy}</p><code>{edge.oldSnapshotId}</code><br /><code>{edge.actionId}</code></details>
    </SourceOccurrenceOrigin>
  </li>)}</ul> : <p>{t("source.noEarlierEvidence")}</p>;
}

export function SourceReadFeedback({ error, fetching, retry, impact = false, messageKey = "source.historyFailed" }: {
  error: unknown; fetching: boolean; retry: () => void; impact?: boolean; messageKey?: "source.historyFailed" | "source.readFailed";
}) {
  const { t } = useTranslation();
  return fetching ? <p role="status">{t("execution.working")}</p> : error ? <div role="alert"><p>{t(impact ? "source.impactFailed" : messageKey)}</p>
    <CommandFailureDetails failure={commandFailure(error)} /><button className="secondary-button" onClick={retry}>{t("source.retryRead")}</button></div> : null;
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };

export function SourceHistoryPanel({ project, disabled, active = true, onHistoryCursor }: {
  project: ProjectView; disabled: boolean; active?: boolean; onHistoryCursor?: (offset: number) => void;
}) {
  const { t } = useTranslation(), reads = useSessionReads(), registry = useWorkbenchCommands();
  const label = useSourceOccurrenceLabel();
  const session = executionContext(project), commandScope = { ...session, area: "source" as const };
  const [offset, setOffset] = useWorkbenchState<number | null>("source", "history.offset", null), [snapshotId, setSnapshotId] = useWorkbenchState<string | null>("source", "history.snapshot", null);
  const [query, setQuery] = useWorkbenchState("source", "history.query", ""), [appliedQuery, setAppliedQuery] = useWorkbenchState("source", "history.appliedQuery", ""), [after, setAfter] = useWorkbenchState("source", "history.after", 0);
  const [ordinal, setOrdinal] = useWorkbenchState<number | null>("source", "history.ordinal", null);
  const alive = useRef(false), committed = useRef({ active, disabled, project });
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => { committed.current = { active, disabled, project }; });
  const historyOptions = sourceReads.history(session, offset ?? 0);
  const historyRead = useSessionQuery({ ...historyOptions, enabled: active && offset !== null });
  const contentOptions = sourceReads.historyContent(session, snapshotId ?? "", appliedQuery, after);
  const contentRead = useSessionQuery({ ...contentOptions, enabled: active && !!snapshotId });
  const lineageOptions = sourceReads.lineage(session, snapshotId ?? "", ordinal ?? 0);
  const lineageRead = useSessionQuery({ ...lineageOptions, enabled: active && !!snapshotId && ordinal !== null
    && !contentRead.error && !!contentRead.data?.rows.some(row => row.occurrence.ordinal === ordinal) });
  const history = active && !historyRead.error ? historyRead.data : undefined;
  const page = active && !contentRead.error ? contentRead.data : undefined;
  function ready(key: QueryKey) { const state = reads.client.getQueryState(reads.key(key)); return state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated; }
  // Buttons use reactive inputs; dispatch still verifies the committed consumer.
  function common(rendering = false): CommandAvailability {
    const view = rendering ? { active, disabled, project } : committed.current;
    if ((!rendering && !alive.current) || !view.active || view.project.sessionToken !== session.sessionToken || view.project.metadata.projectId !== session.projectId) return { enabled: false, reason: "hidden" };
    return view.disabled ? { enabled: false, reason: "busy" } : { enabled: true };
  }
  function contentAvailability(input?: SourceHistoryContentCommandPayload, rendering = false): CommandAvailability {
    const allowed = common(rendering); if (!allowed.enabled) return allowed;
    if (!input || input.newOrdinal !== null || contentRead.isFetching) return unavailable;
    const selected = input.snapshotId === snapshotId;
    const listed = ready(historyOptions.key) && history?.snapshots.some(entry => entry.snapshotId === input.snapshotId);
    return (input.after === 0 && (selected || listed))
      || (selected && input.query === appliedQuery && (input.after === after || (ready(contentOptions.key) && input.after === page?.nextOrdinal))) ? allowed : unavailable;
  }
  function contentPayload(id = snapshotId!, search = appliedQuery, cursor = after): SourceHistoryContentCommandPayload {
    return { kind: "source-history-content", snapshotId: id, query: search, after: cursor, newOrdinal: null };
  }
  function readContent(input: SourceHistoryContentCommandPayload) {
    if (snapshotId === input.snapshotId && appliedQuery === input.query && after === input.after) void contentRead.refetch();
    else { setSnapshotId(input.snapshotId); setAppliedQuery(input.query); setAfter(input.after); }
    setOrdinal(null);
  }
  useLayoutEffect(() => {
    const metadata = { category: "source" as const, binding: null, risk: "reads-source" as const, confirmation: "none" as const, scope: commandScope };
    const removals = [
      registry.register({ ...metadata, id: "source.read-history", nameKey: "source.history", payloadKind: "source-history",
        availability: input => { const allowed = common(); return allowed.enabled && input && !historyRead.isFetching
          && (input.offset === 0 || input.offset === offset || (ready(historyOptions.key) && input.offset === history?.nextOffset)) ? allowed : allowed.enabled ? unavailable : allowed; },
        handler: input => { onHistoryCursor?.(input.offset); if (offset === input.offset) void historyRead.refetch(); else setOffset(input.offset); } }),
      registry.register({ ...metadata, id: "source.read-history-content", nameKey: "source.search", payloadKind: "source-history-content", availability: contentAvailability, handler: readContent }),
      registry.register({ ...metadata, id: "source.read-lineage", nameKey: "source.lineageHistory", payloadKind: "source-lineage",
        availability: input => { const allowed = common(); return allowed.enabled && input && ready(contentOptions.key) && !lineageRead.isFetching && input.snapshotId === snapshotId
          && page?.rows.some(row => row.occurrence.ordinal === input.ordinal) ? allowed : allowed.enabled ? unavailable : allowed; },
        handler: input => { if (ordinal === input.ordinal) void lineageRead.refetch(); else setOrdinal(input.ordinal); } }),
    ];
    return () => removals.forEach(remove => remove());
  });
  function historyPage(cursor: number) { registry.dispatch("source.read-history", commandScope, { kind: "source-history", offset: cursor }); }
  function dispatchContent(input: SourceHistoryContentCommandPayload) { registry.dispatch("source.read-history-content", commandScope, input); }
  function lineagePayload(value: number): SourceLineageCommandPayload { return { kind: "source-lineage", snapshotId: snapshotId!, ordinal: value }; }
  return <section className="source-maintenance-panel">
    <button className="secondary-button" disabled={!common(true).enabled || historyRead.isFetching} onClick={() => historyPage(0)}>{t("source.history")}</button>
    <SourceReadFeedback error={historyRead.error} fetching={active && historyRead.isFetching} retry={() => historyPage(offset ?? 0)} />
    {history ? <><p>{t("source.historyCount", { count: history.total })}</p><ul>{history.snapshots.map(entry => <li key={entry.snapshotId}>
      <button className="text-button" disabled={!contentAvailability(contentPayload(entry.snapshotId, query, 0), true).enabled} onClick={() => dispatchContent(contentPayload(entry.snapshotId, query, 0))}>{t("source.snapshotLabel", { revision: String(entry.revision) })} · {t(entry.current ? "source.currentSnapshot" : "source.historicalSnapshot")}</button>
      <details><summary>{t("source.fingerprint")}</summary><code>{entry.snapshotId}</code><p>{entry.total}</p><code>{entry.resultDigest}</code>{entry.coverage.map(file => <p key={file.artifactId}>{file.logicalPath}<br /><code>{file.sha256}</code></p>)}</details>
    </li>)}</ul>{history.nextOffset !== null ? <button className="secondary-button" disabled={!common(true).enabled || !ready(historyOptions.key)} onClick={() => historyPage(history.nextOffset!)}>{t("execution.nextPage")}</button> : null}</> : null}
    {snapshotId ? <><label className="source-field">{t("source.searchHistory")}<input value={query} maxLength={256} onChange={event => setQuery(event.target.value)} /></label>
      <button className="secondary-button" disabled={!contentAvailability(contentPayload(snapshotId, query, 0), true).enabled} onClick={() => dispatchContent(contentPayload(snapshotId, query, 0))}>{t("source.search")}</button>
      <SourceReadFeedback error={contentRead.error} fetching={active && contentRead.isFetching} retry={() => dispatchContent(contentPayload())} />
      {after > 0 ? <button className="secondary-button" disabled={!contentAvailability(contentPayload(snapshotId, appliedQuery, 0), true).enabled} onClick={() => dispatchContent(contentPayload(snapshotId, appliedQuery, 0))}>{t("execution.firstPage")}</button> : null}
    </> : null}
    {page ? <><h4>{t("source.historicalSnapshot")}</h4><p>{t("source.historyMatches", { count: page.total })}</p>
      <ul>{page.rows.map(row => <li key={row.occurrenceId}><strong>{label(row.occurrence)}</strong><pre>{row.occurrence.text}</pre>
        <button className="text-button" disabled={!common(true).enabled || !ready(contentOptions.key) || lineageRead.isFetching} onClick={() => registry.dispatch("source.read-lineage", commandScope, lineagePayload(row.occurrence.ordinal))}>{t("source.lineageHistory")}</button></li>)}</ul>
      {page.nextOrdinal !== null ? <button className="secondary-button" disabled={!contentAvailability(contentPayload(snapshotId!, appliedQuery, page.nextOrdinal), true).enabled} onClick={() => dispatchContent(contentPayload(snapshotId!, appliedQuery, page.nextOrdinal!))}>{t("execution.nextPage")}</button> : null}</> : null}
    {ordinal !== null ? <SourceReadFeedback error={lineageRead.error} fetching={active && lineageRead.isFetching} retry={() => registry.dispatch("source.read-lineage", commandScope, lineagePayload(ordinal))} /> : null}
    {active && !lineageRead.error && !lineageRead.isFetching && lineageRead.data ? <LineageEvidenceView evidence={lineageRead.data} project={project} history={history} /> : null}
  </section>;
}

export function SourceImpactPanel({ project, snapshotId, active = true, disabled = false, onOpenWork, onOpenTranslation }: {
  project: ProjectView; snapshotId: string; active?: boolean; disabled?: boolean; onOpenWork?: () => void; onOpenTranslation?: (target: EditorTarget, locale: string) => boolean | Promise<boolean>;
}) {
  const { t } = useTranslation(), reads = useSessionReads(), registry = useWorkbenchCommands();
  const label = useSourceOccurrenceLabel();
  const session = executionContext(project), commandScope = { ...session, area: "source" as const };
  const [locale, setLocale] = useWorkbenchState("source", `impact.${snapshotId}.locale`, project.metadata.targetLocales[0] ?? ""), [requestedLocale, setRequestedLocale] = useWorkbenchState("source", `impact.${snapshotId}.requestedLocale`, locale);
  const [after, setAfter] = useWorkbenchState("source", `impact.${snapshotId}.after`, 0), [navigationFailed, setNavigationFailed] = useState(false);
  const alive = useRef(false), committed = useRef({ active, disabled, project, snapshotId, locale });
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => { committed.current = { active, disabled, project, snapshotId, locale }; });
  const localeAvailable = !!locale && project.metadata.targetLocales.includes(locale);
  const scopeOptions = sourceReads.scope(session), scopeRead = useSessionQuery({ ...scopeOptions, enabled: active });
  const currentSnapshot = !scopeRead.error && scopeRead.data?.currentSnapshot === snapshotId;
  const impactOptions = sourceReads.impact(session, snapshotId, locale, after);
  const impactRead = useSessionQuery({ ...impactOptions, enabled: active && localeAvailable && currentSnapshot && requestedLocale === locale });
  const page = active && localeAvailable && currentSnapshot && requestedLocale === locale && !impactRead.error ? impactRead.data : undefined;
  function ready(key: QueryKey) { const state = reads.client.getQueryState(reads.key(key)); return state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated; }
  // Locale changes can leave the query disabled, so layout refs cannot drive rendering.
  function common(fresh = true, rendering = false): CommandAvailability {
    const view = rendering ? { active, disabled, project, snapshotId, locale } : committed.current;
    if ((!rendering && !alive.current) || !view.active || view.project.sessionToken !== session.sessionToken || view.project.metadata.projectId !== session.projectId) return { enabled: false, reason: "hidden" };
    if (view.disabled) return { enabled: false, reason: "busy" };
    return view.project.metadata.targetLocales.includes(view.locale) && ready(scopeOptions.key)
      && reads.client.getQueryData<{ currentSnapshot: string | null }>(reads.key(scopeOptions.key))?.currentSnapshot === view.snapshotId
      && (!fresh || (ready(impactOptions.key) && reads.client.getQueryData(reads.key(impactOptions.key)) === impactRead.data)) ? { enabled: true } : unavailable;
  }
  function impactPayload(cursor = after): SourceImpactCommandPayload { return { kind: "source-impact", snapshotId, locale, after: cursor }; }
  function targetPayload(row: SourceImpactRow): SourceImpactTargetCommandPayload | null {
    const current = row.current;
    return current.occurrenceId && current.unitId && current.sourceRevisionId ? { kind: "source-impact-target", snapshotId, locale, occurrenceId: current.occurrenceId,
      target: { unitId: current.unitId, sourceRevisionId: current.sourceRevisionId, key: current.occurrence.key, sourceText: current.occurrence.text },
      selectionId: row.selectionId, translationRevisionId: row.translationRevisionId, reviewBasis: row.reviewBasis } : null;
  }
  function targetAvailability(input?: SourceImpactTargetCommandPayload, rendering = false): CommandAvailability {
    const allowed = common(true, rendering); if (!allowed.enabled) return allowed;
    const row = page?.rows.find(item => item.current.occurrenceId === input?.occurrenceId);
    const expected = row ? targetPayload(row) : null;
    return input && expected && onOpenTranslation && input.snapshotId === expected.snapshotId && input.locale === expected.locale
      && input.target.unitId === expected.target.unitId && input.target.sourceRevisionId === expected.target.sourceRevisionId
      && input.target.key === expected.target.key && input.target.sourceText === expected.target.sourceText
      && input.selectionId === expected.selectionId && input.translationRevisionId === expected.translationRevisionId && input.reviewBasis === expected.reviewBasis ? allowed : unavailable;
  }
  useLayoutEffect(() => {
    const metadata = { category: "source" as const, binding: null, confirmation: "none" as const, scope: commandScope };
    const removals = [
      registry.register({ ...metadata, id: "source.read-impact", nameKey: "source.readImpact", risk: "reads-source", payloadKind: "source-impact",
        availability: input => { const allowed = common(false); return allowed.enabled && input && !impactRead.isFetching && input.snapshotId === snapshotId && input.locale === locale
          && (input.after === 0 || input.after === after || (ready(impactOptions.key) && input.after === page?.nextOrdinal)) ? allowed : allowed.enabled ? unavailable : allowed; },
        handler: input => { setNavigationFailed(false); if (requestedLocale === locale && input.after === after) void impactRead.refetch(); else { setRequestedLocale(locale); setAfter(input.after); } } }),
      registry.register({ ...metadata, id: "source.open-work", nameKey: "source.openWork", risk: "reads-source", payloadKind: "source-impact",
        availability: input => { const allowed = common(); return allowed.enabled && onOpenWork && input && input.snapshotId === snapshotId && input.locale === locale && input.after === after ? allowed : allowed.enabled ? unavailable : allowed; },
        handler: () => onOpenWork?.() }),
      registry.register({ ...metadata, id: "source.open-translation", nameKey: "translation.openEditor", risk: "opens-translation", payloadKind: "source-impact-target",
        availability: targetAvailability, handler: async input => {
          const captured = { ...committed.current }, available = targetAvailability(input);
          if (!available.enabled || !onOpenTranslation) return;
          const settle = (opened: boolean) => {
            const value = committed.current;
            if (alive.current && value.active && value.project.sessionToken === captured.project.sessionToken
              && value.project.metadata.projectId === captured.project.metadata.projectId && value.snapshotId === captured.snapshotId && value.locale === captured.locale) setNavigationFailed(!opened);
          };
          try { settle(await onOpenTranslation({ ...input.target }, input.locale)); }
          catch { settle(false); }
        } }),
    ];
    return () => removals.forEach(remove => remove());
  });
  function readImpact(cursor = after) { registry.dispatch("source.read-impact", commandScope, impactPayload(cursor)); }
  function reasonLabel(value: string) {
    if (value === "source-changed") return t("source.reasonChanged");
    if (value === "correspondence-unresolved") return t("source.reasonUnresolved");
    return t(reviewReasonKey(value));
  }
  return <section className="source-maintenance-panel"><h4>{t("source.actualImpact")}</h4>
    <label className="source-field">{t("review.targetLocale")}<select value={locale} disabled={disabled} onChange={event => { setLocale(event.target.value); setRequestedLocale(""); setAfter(0); setNavigationFailed(false); }}>
      {!localeAvailable && locale ? <option value={locale}>{t("source.removedTargetOption", { locale })}</option> : null}
      {project.metadata.targetLocales.map(value => <option key={value}>{value}</option>)}
    </select></label><button className="secondary-button" disabled={!common(false, true).enabled || impactRead.isFetching} onClick={() => readImpact(0)}>{t("source.readImpact")}</button>
    {!localeAvailable ? <p role="alert">{t(locale ? "source.removedTarget" : "source.noTargets", { locale })}</p> : null}
    {active && !scopeRead.error && scopeRead.isSuccess && !currentSnapshot ? <p role="alert">{t("source.impactChanged")}</p> : null}
    {onOpenWork ? <button className="text-button" disabled={!common(true, true).enabled} onClick={() => registry.dispatch("source.open-work", commandScope, impactPayload())}>{t("source.openWork")}</button> : null}
    <SourceReadFeedback error={scopeRead.error || impactRead.error} fetching={active && (scopeRead.isFetching || impactRead.isFetching)} impact retry={() => { if (scopeRead.error) void scopeRead.refetch(); else readImpact(); }} />
    {navigationFailed ? <p role="alert">{t("source.navigationBlocked")}</p> : null}
    {after > 0 && !page ? <button className="secondary-button" disabled={!common(false, true).enabled || impactRead.isFetching} onClick={() => readImpact(0)}>{t("execution.firstPage")}</button> : null}
    {page ? <><p role="status">{t("source.impactSummary", { locale: page.summary.locale, preserved: String(page.summary.preserved), reassess: String(page.summary.reassess), unresolved: String(page.summary.unresolved), total: String(page.summary.total) })}</p><p>{t("source.impactCoverage")}</p>
      <ul>{page.rows.map(row => <li key={row.current.occurrenceId}><strong>{label(row.current.occurrence)}</strong> · {t(`source.impactStatus.${row.status}`)}<pre>{row.current.occurrence.text}</pre>
        {onOpenTranslation && targetPayload(row) ? <button type="button" className="text-button" disabled={!targetAvailability(targetPayload(row)!, true).enabled} onClick={() => registry.dispatch("source.open-translation", commandScope, targetPayload(row)!)}>{t("translation.openEditor")}</button> : null}
        {row.previous ? <details><summary>{t("source.previous")}</summary><pre>{row.previous.occurrence.text}</pre><code>{row.previous.sourceRevisionId}</code>
          <h5>{t("source.previousBases")}</h5>{row.previousBases.length ? row.previousBases.map(basis => <div key={basis.actionId}><p>{t(basis.kind === "review" ? "source.historicalReview" : "source.historicalCheck")}</p><pre>{basis.translationText}</pre><code>{basis.evidence.selectionId}</code><br /><code>{basis.evidence.revisionId}</code><br /><code>{basis.basis}</code><p>{t("source.historicalBasisNotice")}</p></div>) : <p>{t("source.noPreviousBasis")}</p>}
        </details> : null}
        <ul>{row.reasons.map(reason => <li key={reason}>{reasonLabel(reason)}<details><summary>{t("execution.diagnostic")}</summary><code>{reason}</code></details></li>)}</ul>
        <details><summary>{t("source.currentBasis")}</summary><code>{row.current.sourceRevisionId}</code><br /><code>{row.selectionId}</code><br /><code>{row.translationRevisionId}</code><br /><code>{row.reviewBasis}</code><LineageEvidenceView evidence={row.lineage} project={project} /></details>
      </li>)}</ul><button className="secondary-button" disabled={!common(false, true).enabled || impactRead.isFetching} onClick={() => readImpact(0)}>{t("execution.firstPage")}</button>
      {page.nextOrdinal !== null ? <button className="secondary-button" disabled={!common(true, true).enabled} onClick={() => readImpact(page.nextOrdinal!)}>{t("execution.nextPage")}</button> : null}</> : null}
  </section>;
}
