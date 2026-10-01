import { reviewReasonKey } from "./reviewLabels";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "./projectCommands";
import type { EditorTarget } from "./TranslationWorkbench";
import { executionContext } from "./executionCommands";
import { sourceCommands as commands, type ContentPage, type LineageEvidence, type SourceHistory, type SourceImpactPage } from "./sourceCommands";

export function LineageEvidenceView({ evidence }: { evidence: LineageEvidence[] }) {
  const { t } = useTranslation();
  return evidence.length ? <ul>{evidence.map(edge => <li key={edge.old.occurrenceId}>
    <strong>{edge.old.occurrence.key}</strong><pre>{edge.old.occurrence.text}</pre>
    <p>{t(edge.decision === "continue" ? "source.evidenceDecision.continue" : edge.decision === "reject" ? "source.evidenceDecision.reject" : edge.appliedRelation === "unchanged" ? "source.evidenceAutomatic" : "source.evidenceDecision.candidate")} · {edge.actor ?? t("source.proposed")}</p>
    {edge.reason ? <p>{edge.reason}</p> : null}
    <details><summary>{t("source.origin")}</summary><p>{edge.old.occurrence.namespace} · i18n/default.json · {edge.old.occurrence.valueByteRange.join("–")}</p><p>{edge.policy}</p><code>{edge.oldSnapshotId}</code><br /><code>{edge.actionId}</code></details>
  </li>)}</ul> : <p>{t("source.noEarlierEvidence")}</p>;
}

export function SourceHistoryPanel({ project, disabled, onHistory }: { project: ProjectView; disabled: boolean; onHistory?: (history: SourceHistory) => void }) {
  const { t } = useTranslation();
  const context = executionContext(project);
  const [history, setHistory] = useState<SourceHistory | null>(null);
  const [page, setPage] = useState<ContentPage | null>(null);
  const [query, setQuery] = useState("");
  const [evidence, setEvidence] = useState<LineageEvidence[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function run(work: () => Promise<void>) {
    setBusy(true); setFailed(false);
    try { await work(); } catch { setFailed(true); } finally { setBusy(false); }
  }
  async function loadHistory(offset: number) {
    const ticket = ++generation.current;
    const next = await commands.history({ ...context, offset, limit: 50 });
    if (generation.current === ticket) { setHistory(next); onHistory?.(next); }
  }
  async function load(snapshotId: string, after = 0) {
    const ticket = ++generation.current;
    const next = await commands.historyContent({ ...context, snapshotId, query, after, limit: 20 });
    if (generation.current === ticket) { setPage(next); setEvidence(null); }
  }
  return <section className="source-maintenance-panel">
    <button className="secondary-button" disabled={disabled || busy} onClick={() => void run(() => loadHistory(0))}>{t("source.history")}</button>
    {failed ? <p role="alert">{t("source.historyFailed")}</p> : null}
    {busy ? <p role="status">{t("execution.working")}</p> : null}
    {history ? <><p>{t("source.historyCount", { count: history.total })}</p><ul>{history.snapshots.map(entry => <li key={entry.snapshotId}>
      <button className="text-button" disabled={disabled || busy} onClick={() => void run(() => load(entry.snapshotId))}>{t("source.snapshotLabel", { revision: String(entry.revision) })} · {t(entry.current ? "source.currentSnapshot" : "source.historicalSnapshot")}</button>
      <details><summary>{t("source.fingerprint")}</summary><code>{entry.snapshotId}</code><p>{entry.total}</p><code>{entry.resultDigest}</code>{entry.coverage.map(file => <p key={file.artifactId}>{file.logicalPath}<br /><code>{file.sha256}</code></p>)}</details>
    </li>)}</ul>{history.nextOffset !== null ? <button className="secondary-button" disabled={disabled || busy} onClick={() => void run(() => loadHistory(history.nextOffset!))}>{t("execution.nextPage")}</button> : null}</> : null}
    {page ? <><h4>{t("source.historicalSnapshot")}</h4><label className="source-field">{t("source.searchHistory")}<input value={query} maxLength={256} onChange={event => setQuery(event.target.value)} /></label><button className="secondary-button" disabled={disabled || busy} onClick={() => void run(() => load(page.snapshotId!))}>{t("source.search")}</button>
      <p>{t("source.historyMatches", { count: page.total })}</p><ul>{page.rows.map(row => <li key={row.occurrenceId}><strong>{row.occurrence.key}</strong><pre>{row.occurrence.text}</pre><button className="text-button" disabled={disabled || busy} onClick={() => void run(async () => { const ticket = ++generation.current; const next = await commands.lineage({ ...context, snapshotId: page.snapshotId!, ordinal: row.occurrence.ordinal }); if (generation.current === ticket) setEvidence(next); })}>{t("source.lineageHistory")}</button></li>)}</ul>
      {page.nextOrdinal !== null ? <button className="secondary-button" disabled={disabled || busy} onClick={() => void run(() => load(page.snapshotId!, page.nextOrdinal!))}>{t("execution.nextPage")}</button> : null}
      {evidence ? <LineageEvidenceView evidence={evidence} /> : null}</> : null}
  </section>;
}

export function SourceImpactPanel({ project, snapshotId, active = true, onOpenWork, onOpenTranslation }: { project: ProjectView; snapshotId: string; active?: boolean; onOpenWork?: () => void; onOpenTranslation?: (target: EditorTarget, locale: string) => boolean }) {
  const { t } = useTranslation();
  const context = executionContext(project);
  const [locale, setLocale] = useState(project.metadata.targetLocales[0] ?? "");
  const [page, setPage] = useState<SourceImpactPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pageAfter, setPageAfter] = useState(0);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (active) void load(pageAfter); }, [snapshotId, active]);
  async function load(after = 0) {
    const ticket = ++generation.current;
    setBusy(true); setFailed(false);
    try { const next = await commands.impact({ ...context, snapshotId, locale, after, limit: 10 }); if (generation.current === ticket) { setPage(next); setPageAfter(after); } }
    catch { if (generation.current === ticket) { setPage(null); setFailed(true); } }
    finally { if (generation.current === ticket) setBusy(false); }
  }
  function reasonLabel(value: string) {
    if (value === "source-changed") return t("source.reasonChanged");
    if (value === "correspondence-unresolved") return t("source.reasonUnresolved");
    return t(reviewReasonKey(value));
  }
  return <section className="source-maintenance-panel"><h4>{t("source.actualImpact")}</h4>
    <label className="source-field">{t("review.targetLocale")}<select value={locale} disabled={busy} onChange={event => { generation.current++; setLocale(event.target.value); setPage(null); }}>
      {project.metadata.targetLocales.map(value => <option key={value}>{value}</option>)}
    </select></label><button className="secondary-button" disabled={busy || !locale} onClick={() => void load()}>{t("source.readImpact")}</button>
    {onOpenWork ? <button className="text-button" disabled={busy} onClick={onOpenWork}>{t("source.openWork")}</button> : null}
    {busy ? <p role="status">{t("execution.working")}</p> : null}
    {failed ? <p role="alert">{t("source.impactFailed")}</p> : null}
    {page ? <><p role="status">{t("source.impactSummary", { locale: page.summary.locale, preserved: String(page.summary.preserved), reassess: String(page.summary.reassess), unresolved: String(page.summary.unresolved), total: String(page.summary.total) })}</p><p>{t("source.impactCoverage")}</p>
      <ul>{page.rows.map(row => <li key={row.current.occurrenceId}><strong>{row.current.occurrence.key}</strong> · {t(`source.impactStatus.${row.status}`)}<pre>{row.current.occurrence.text}</pre>
        {onOpenTranslation && row.current.unitId && row.current.sourceRevisionId ? <button type="button" className="text-button" disabled={busy} onClick={() => onOpenTranslation({ unitId: row.current.unitId!, sourceRevisionId: row.current.sourceRevisionId!, key: row.current.occurrence.key, sourceText: row.current.occurrence.text }, locale)}>{t("translation.openEditor")}</button> : null}
        {row.previous ? <details><summary>{t("source.previous")}</summary><pre>{row.previous.occurrence.text}</pre><code>{row.previous.sourceRevisionId}</code>
          <h5>{t("source.previousBases")}</h5>{row.previousBases.length ? row.previousBases.map(basis => <div key={basis.actionId}><p>{t(basis.kind === "review" ? "source.historicalReview" : "source.historicalCheck")}</p><pre>{basis.translationText}</pre><code>{basis.evidence.selectionId}</code><br /><code>{basis.evidence.revisionId}</code><br /><code>{basis.basis}</code><p>{t("source.historicalBasisNotice")}</p></div>) : <p>{t("source.noPreviousBasis")}</p>}
        </details> : null}
        <ul>{row.reasons.map(reason => <li key={reason}>{reasonLabel(reason)}<details><summary>{t("execution.diagnostic")}</summary><code>{reason}</code></details></li>)}</ul>
        <details><summary>{t("source.currentBasis")}</summary><code>{row.current.sourceRevisionId}</code><br /><code>{row.selectionId}</code><br /><code>{row.translationRevisionId}</code><br /><code>{row.reviewBasis}</code><LineageEvidenceView evidence={row.lineage} /></details>
      </li>)}</ul><button className="secondary-button" disabled={busy} onClick={() => void load()}>{t("execution.firstPage")}</button>{page.nextOrdinal !== null ? <button className="secondary-button" disabled={busy} onClick={() => void load(page.nextOrdinal!)}>{t("execution.nextPage")}</button> : null}</> : null}
  </section>;
}
