import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "./projectCommands";
import type { EditorTarget } from "./TranslationWorkbench";
import type { UiMessages } from "./i18n/types";
import { useSessionQuery } from "./SessionReadProvider";
import { useSourceDraftSession } from "./SourceDraftSession";
import { SourceHistoryPanel, SourceImpactPanel } from "./SourceMaintenance";
import { executionCommands as execution, executionContext, type AttemptDetail } from "./executionCommands";
import { sourceCommands as commands, type ContentPage, type LineageChoice, type IntegrationDescriptor, type SourceHistory } from "./sourceCommands";

function cueTiming(basis: string): string | null {
  if (!basis.startsWith("{")) return null;
  try { const value = JSON.parse(basis) as { policy?: unknown; timing?: unknown }; return value.policy === "webvtt-cue/1" && typeof value.timing === "string" ? value.timing : null; } catch { return null; }
}
export interface SourceHandle { showAttempt: (id: string) => void; allowLeave: () => Promise<boolean>; allowNavigate: () => Promise<boolean> }
export function SourceWorkbench({ project, disabled, onOpenWork, onOpenTranslation, ref }: { project: ProjectView; disabled: boolean; onOpenWork?: () => void; onOpenTranslation?: (target: EditorTarget, locale: string) => boolean; ref?: Ref<SourceHandle> }) {
  const { t } = useTranslation();
  const context = executionContext(project);
  const [open, setOpen] = useWorkbenchView("source");
  const [integration, setIntegration] = useState<IntegrationDescriptor | null>(null);
  const owner = useSourceDraftSession();
  const { domain, selection, declared, preflight, attempt, comparison, updating, lineage, actor, filter, appliedFilter,
    manualOrdinal, historicalQuery, estimate, confirmed, pendingStart, pendingApply, receiptChecked, busyMutation } = owner.state;
  const [currentPage, setCurrentPage] = useState<ContentPage | null>(null);
  const page = owner.state.preview ?? currentPage;
  const [history, setHistory] = useState<SourceHistory | null>(null);
  const [historicalMatches, setHistoricalMatches] = useState<ContentPage | null>(null);
  const [readBusy, setReadBusy] = useState(false);
  const [readFailure, setReadFailure] = useState<CommandFailure | null>(null);
  const busy = readBusy || busyMutation;
  const failureValue = owner.state.failure ?? readFailure;
  const failure = failureReason(failureValue);
  const setLineage = (value: Record<number, LineageChoice> | ((before: Record<number, LineageChoice>) => Record<number, LineageChoice>)) => owner.edit("lineage", value);
  const setActor = (value: string) => owner.edit("actor", value);
  const setFilter = (value: string) => owner.edit("filter", value);
  const setManualOrdinal = (value: number | null) => owner.edit("manualOrdinal", value);
  const setHistoricalQuery = (value: string) => owner.edit("historicalQuery", value);
  const setConfirmed = owner.confirm;
  const [leave, setLeave] = useState(false);
  const detailRead = useSessionQuery<AttemptDetail | null>({ key: ["source-attempt", attempt, 0, 100], scopes: ["execution"], enabled: open && !busy && !!attempt && !page && !comparison,
    read: () => execution.attempt({ ...context, attemptId: attempt!, offset: 0, limit: 100 }) });
  const detail = detailRead.data ?? null, setDetail = detailRead.setData;

  const leaveResolver = useRef<((answer: boolean) => void) | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const readRunning = useRef(false);
  useLayoutEffect(() => { sequence.current++; readRunning.current = false; setReadBusy(false); }, [open, project.sessionToken]);
  const first = useRef<HTMLHeadingElement>(null);
  const errorRegion = useRef<HTMLDivElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; leaveResolver.current?.(false); }; }, []);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    void commands.integration(context, domain).then(value => { if (!stale) { setIntegration(value); } }, error => { if (!stale) showError(error); });
    return () => { stale = true; };
  }, [open, project.sessionToken, domain]);
  useImperativeHandle(ref, () => ({
    showAttempt(id) { if (owner.showAttempt(id)) { sequence.current++; setCurrentPage(null); setHistory(null); setHistoricalMatches(null); setDetail(null); setReadFailure(null); } setOpen(true); },
    allowNavigate() { return Promise.resolve(!busy && !owner.inFlight() && !owner.current().pendingApply && !owner.current().pendingStart); },
    allowLeave() { const value = owner.current(); if (value.pendingApply || value.pendingStart) { setOpen(true); return Promise.resolve(false); } if (!value.selection && Object.keys(value.lineage).length === 0 && !value.actor.trim() && !busy && !owner.inFlight()) return Promise.resolve(true); setLeave(true); return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; }); },
  }));
  function showError(error: unknown) { setReadFailure(commandFailure(error)); }
  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (readRunning.current || owner.inFlight()) return;
    readRunning.current = true;
    const ticket = ++sequence.current;
    const current = () => mounted.current && sequence.current === ticket;
    setReadBusy(true); setReadFailure(null);
    try { await work(current); } catch (error) { if (current()) showError(error); }
    finally { if (current()) { readRunning.current = false; setReadBusy(false); } }
  }
  // A ready preview becomes the user's fixed adoption basis, separate from task progress.
  useEffect(() => {
    if (!open || busy || !attempt || page || comparison || !detail) return;
    const ticket = ++sequence.current;
    let stopped = false;
    const current = () => !stopped && mounted.current && ticket === sequence.current;
    const result = detail.items[0];
    if (result?.resultId && result.status.validation === "valid" && result.status.execution === "succeeded") {
      void (async () => {
        try {
          const scope = await commands.scope(context);
          if (!current()) return;
          if (scope.currentSnapshot) {
            const changes = await commands.compare({ ...context, attemptId: attempt, resultId: result.resultId!, after: 0, limit: 50 });
            if (current()) { owner.ready(changes, detail); setCurrentPage(null); setReadFailure(null); }
          } else {
            const preview = await commands.preview({ ...context, attemptId: attempt, resultId: result.resultId!, after: 0, limit: 50 });
            if (current()) { owner.ready(preview, detail); setCurrentPage(null); setReadFailure(null); }
          }
        } catch (error) { if (current()) showError(error); }
      })();
    } else if (result?.status.execution === "failed" || result?.status.validation === "invalid") setReadFailure(result.status.diagnostic ?? "output-invalid");
    else if (result?.status.execution === "unknown" || result?.status.execution === "cancelled-before-dispatch") setReadFailure(result.status.execution);
    return () => { stopped = true; };
  }, [open, busy, attempt, page, comparison, detail, project.sessionToken]);
  useEffect(() => { if (detailRead.error) showError(detailRead.error); }, [detailRead.error]);
  useEffect(() => { if (page || comparison) first.current?.focus(); }, [page, comparison]);
  useEffect(() => { if (failure && open) errorRegion.current?.focus(); }, [failure, open]);
  async function loadCurrent(current: () => boolean, recordedSnapshot?: string) {
    const before = owner.current();
    const scope = await commands.scope(context);
    const snapshotId = recordedSnapshot ?? scope.currentSnapshot;
    const next = snapshotId ? await commands.content({ ...context, snapshotId, after: 0, limit: 50 }) : null;
    const latest = owner.current();
    if (current() && latest.selection === before.selection && latest.attempt === before.attempt && latest.preview === before.preview
      && latest.comparison === before.comparison && latest.editSeq === before.editSeq && latest.receipt === before.receipt) setCurrentPage(next);
  }
  async function compare(after: number, current: () => boolean, base: string | null = comparison?.previousSnapshotId ?? null, query = appliedFilter, refresh = false) {
    if (!comparison) return;
    const next = await commands.compare({ ...context, attemptId: comparison.attemptId, resultId: comparison.resultId, base, filter: query, after, limit: 50 });
    if (current()) { owner.page(next, query, refresh); setHistoricalMatches(null); }
  }
  useEffect(() => {
    if (open && !busyMutation && owner.state.receipt && !owner.state.preview && !comparison) {
      setCurrentPage(null); setHistory(null); void perform(current => loadCurrent(current, owner.state.receipt!.changes[0].id));
    }
  }, [open, owner.state.completionVersion, busyMutation]);
  useEffect(() => {
    if (open && !attempt && !page && !selection && !updating) void perform(loadCurrent);
  }, [open, project.sessionToken]);
  function requestBack() {
    if (!readRunning.current && !owner.inFlight() && !pendingApply && !pendingStart) setOpen(false);
  }
  const knownErrors: Record<string, keyof UiMessages["source"]["errors"]> = {
    "unsupported-encoding": "encoding", "source-changed": "changed", "duplicate-native-key": "duplicate", "empty-source": "empty", "capture-timeout": "timeout", "extract-timeout": "unknown", "source-corrupt": "invalid", "stale-preview": "conflict", "language-required": "language",
    "vtt-header": "webvtt", "vtt-timing": "webvtt", "vtt-setting": "webvtt", "vtt-region": "webvtt", "vtt-block": "webvtt", "vtt-cue-id": "webvtt", "vtt-order": "webvtt", "vtt-payload": "webvtt", "unsupported-format": "format", "missing-companion": "missing", "language-conflict": "language", "limit-exceeded": "limit", "input-limit": "limit", "unauthorized-selection": "selection", "session-invalid": "selection", "input-busy": "busy", busy: "busy", "source-already-present": "conflict", "source-namespace": "namespace", "source-unchanged": "unchanged", "lineage-choice": "lineage", "lineage-split": "lineage", "dependency-conflict": "conflict", "output-invalid": "invalid", "invalid-structure": "invalid", "invalid-json": "invalid", "source-value-not-string": "stringValue", cancelled: "cancelled", "cancelled-before-dispatch": "cancelled", unknown: "unknown", "outcome-unknown": "unknown",
  };
  const locked = busy || pendingStart !== null || pendingApply !== null;
  const warnings = page?.diagnostics ?? preflight?.diagnostics ?? [];
  return <>
    <WorkbenchPanel open={open} title={t("source.title")} description={t("source.description")} className="source-dialog" onBack={() => void requestBack()} backDisabled={disabled || busy}>
        <div className="execution-content" aria-busy={busy}>
          {integration ? <><p>{t("source.profile", { version: integration.version, name: integration.id === "webvtt" ? "WebVTT" : "Stardew SMAPI", profile: integration.formatProfiles.join(", ") })}</p>{!integration.available ? <p role="alert">{t("source.unavailable")}</p> : null}</> : <p role="status">{t("source.loadingIntegration")}</p>}
          {failure ? <div ref={errorRegion} role="alert" tabIndex={-1}><p>{t(`source.errors.${knownErrors[failure] ?? "failed"}`)}</p><CommandFailureDetails failure={failureValue} />{typeof failureValue === "string" ? <details><summary>{t("execution.diagnostic")}</summary><code>{failure}</code></details> : null}</div> : null}
          {busy ? <p role="status">{t("execution.working")}</p> : null}
          {owner.state.receipt ? <p role="status">{t(owner.state.stale ? "source.adoptionSavedNewer" : "source.adoptionSaved")} <button className="text-button" disabled={busy} onClick={() => void perform(current => loadCurrent(current, owner.state.receipt!.changes[0].id))}>{t("source.readSaved")}</button></p> : null}
          {owner.state.stale && (comparison || owner.state.preview) ? <p role="alert">{t("source.comparisonChanged")}</p> : null}
          {warnings.includes("source-template") ? <p role="status">{t("source.templateWarning")}</p> : null}
          {!page && !comparison && !attempt ? <section aria-label={t(domain === "webvtt" ? "source.webvttSelect" : "source.select")}>
            <label className="source-field">{t("source.integration")}<select disabled={locked || updating} value={domain} onChange={event => { sequence.current++; owner.setDomain(event.target.value); setIntegration(null); setReadFailure(null); }}><option value="stardew-smapi">Stardew SMAPI</option><option value="webvtt">WebVTT</option></select></label>
            {updating ? <p role="status">{t("source.updateIntro")}</p> : null}
            <p>{t(domain === "webvtt" ? "source.webvttSupport" : "source.support")}</p>
            <button className="secondary-button" disabled={locked || !integration?.available} onClick={() => { setCurrentPage(null); setReadFailure(null); void owner.select(); }}>{t(domain === "webvtt" ? "source.webvttSelect" : "source.select")}</button>
            {selection ? <>
              <p>{selection.folderName}</p>
              <label className="source-check"><input type="checkbox" checked={declared} disabled={locked} onChange={event => { owner.declare(event.target.checked); }} />{t("source.language", { language: project.metadata.sourceLocale })}</label>
              <p>{t("source.languageHelp", { file: domain === "webvtt" ? "source.vtt" : "default.json" })}</p>
              <button className="secondary-button" disabled={locked || !declared} onClick={() => void owner.preflight()}>{t("source.preflight")}</button>
              {preflight ? <><p>{t("source.preflightResult", { namespace: preflight.namespace, count: preflight.count })}</p>
                <button className="primary-button" disabled={locked} onClick={() => void owner.start()}>{t("source.start")}</button></> : null}
              <button className="text-button" disabled={locked} onClick={() => void owner.discard()}>{t("source.discard")}</button>
            </> : null}
          </section> : null}
          {pendingStart && !busy ? <section><p>{t("source.startUnknown")}</p><button className="secondary-button" disabled={busy} onClick={() => void owner.retryStart()}>{t("source.checkStart")}</button></section> : null}
          {attempt && !page && !comparison ? <section><p role="status">{t("source.savedTask")}</p><p>{t("source.taskHelp")}</p>
            {detail ? <button className="secondary-button" disabled={locked} onClick={() => void owner.cancelTask(detail.taskId)}>{t("execution.cancel")}</button> : null}
            <button className="secondary-button" disabled={locked} onClick={() => void perform(async current => { if (current()) setDetail(null); })}>{t("execution.refresh")}</button>
          </section> : null}
          {page ? <section>
            <h3 ref={first} tabIndex={-1}>{t(page.snapshotId ? "source.imported" : "source.preview")}</h3>
            <p role="status">{t("source.range", { namespace: page.namespace, count: page.total, language: page.confirmation.sourceLanguage })}</p>
            <ul>{page.coverage.map(file => <li key={file.artifactId}>{file.logicalPath}<details><summary>{t("source.fingerprint")}</summary><code>{file.sha256}</code></details></li>)}</ul>
            <p>{t("source.identityHelp")}</p>
            <div className="source-table-scroll"><table className="source-table"><caption>{t("source.pageRange", { first: String((page.rows[0]?.occurrence.ordinal ?? 0) + 1), last: String((page.rows.at(-1)?.occurrence.ordinal ?? -1) + 1), total: String(page.total) })}</caption><thead><tr><th scope="col">{t("source.key")}</th><th scope="col">{t("source.text")}</th></tr></thead><tbody>{page.rows.map(row => <tr key={row.occurrence.ordinal}><th scope="row">{row.occurrence.key}{cueTiming(row.occurrence.identityBasis) ? <p>{cueTiming(row.occurrence.identityBasis)}</p> : null}<details><summary>{t("source.origin")}</summary><p>{row.occurrence.namespace}</p><p>{t("source.bytes", { start: String(row.occurrence.valueByteRange[0]), end: String(row.occurrence.valueByteRange[1]) })}</p>{row.unitId ? <code>{row.unitId}</code> : null}</details></th><td><pre>{row.occurrence.text || t("source.emptyText")}</pre></td></tr>)}</tbody></table></div>
            <div className="execution-actions">{[0, page.nextOrdinal].map((after, index) => after !== null ? <button className="secondary-button" key={index} disabled={locked || (index === 0 && page.rows[0]?.occurrence.ordinal === 0)} onClick={() => void perform(async current => {
              const next = page.snapshotId ? await commands.content({ ...context, snapshotId: page.snapshotId, after, limit: 50 }) : await commands.preview({ ...context, attemptId: page.attemptId, resultId: page.resultId, after, limit: 50 });
              if (current()) { if (next.snapshotId) setCurrentPage(next); else owner.page(next); }
            })}>{t(index === 0 ? "execution.firstPage" : "execution.nextPage")}</button> : null)}</div>
            {!page.snapshotId ? <>
              <label className="source-check"><input type="checkbox" disabled={locked || owner.state.stale || !!owner.state.receipt || page.scope.currentSnapshot !== null} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("source.confirm", { count: page.total, language: page.confirmation.sourceLanguage })}</label>
              <p>{t("source.applyHelp")}</p>
              {page.scope.currentSnapshot ? <p>{t("source.errors.conflict")}</p> : null}
              <button className="primary-button" disabled={locked || owner.state.stale || !!owner.state.receipt || !confirmed || page.scope.currentSnapshot !== null} onClick={() => void owner.apply()}>{t("source.apply")}</button>
            </> : null}
            {page.snapshotId && page.snapshotId === page.scope.currentSnapshot ? <button className="primary-button" disabled={locked || !integration?.available} onClick={() => {
              sequence.current++; owner.beginUpdate(); setCurrentPage(null); setReadFailure(null);
            }}>{t("source.update")}</button> : null}
          </section> : null}
          {comparison ? <section>
            <h3 ref={first} tabIndex={-1}>{t("source.compareTitle")}</h3>
            <p role="status">{t("source.compareSummary", { unchanged: String(comparison.unchanged), moved: String(comparison.moved), changed: String(comparison.changed), added: String(comparison.added), ambiguous: String(comparison.ambiguous), removed: String(comparison.removed) })}</p>
            <p>{t(domain === "webvtt" ? "source.webvttCompareHelp" : "source.compareHelp")}</p>
            <label className="source-field">{t("source.mappingActor")}<input disabled={locked} value={actor} onChange={event => setActor(event.target.value)} maxLength={128} autoComplete="name" /></label>
            <label className="source-field">{t("source.comparisonFilter")}<input disabled={locked} value={filter} maxLength={256} onChange={event => setFilter(event.target.value)} /></label>
            <button className="secondary-button" disabled={locked} onClick={() => void perform(current => compare(0, current, comparison.previousSnapshotId, filter))}>{t("source.search")}</button>
            <button className="secondary-button" disabled={locked} onClick={() => void perform(current => compare(0, current, Object.keys(lineage).length ? comparison.previousSnapshotId : null, filter, true))}>{t("source.refreshComparison")}</button>
            <p>{t("source.filteredRange", { count: comparison.filteredTotal, total: String(comparison.total) })}</p>
            {history ? <label className="source-field">{t("source.comparisonBase")}<select disabled={locked} value={comparison.previousSnapshotId} onChange={event => void perform(current => compare(0, current, event.target.value, filter, true))}>
              {history.snapshots.map(entry => <option key={entry.snapshotId} value={entry.snapshotId}>{t("source.snapshotLabel", { revision: String(entry.revision) })} · {t(entry.current ? "source.currentSnapshot" : "source.historicalSnapshot")}</option>)}
            </select></label> : null}
            <div className="source-table-scroll"><table className="source-table source-comparison-table"><caption>{t("source.changePage", { count: comparison.rows.length, total: String(comparison.total) })}</caption><thead><tr><th scope="col">{t("source.changeKind")}</th><th scope="col">{t("source.previous")}</th><th scope="col">{t("source.next")}</th><th scope="col">{t("source.mapping")}</th></tr></thead><tbody>{comparison.rows.map((row,index) => {
              const ordinal = row.new?.ordinal;
              const selected = ordinal === undefined ? undefined : lineage[ordinal];
              const defaultChoice = row.kind === "unchanged" || row.kind === "moved" ? "automatic" : "unresolved";
              return <tr key={`${row.new?.key ?? row.old?.occurrence.key}:${index}`}><th scope="row">{t(`source.change.${row.kind}`)}</th>
                <td>{row.old ? <><strong>{row.old.occurrence.key}</strong><pre>{row.old.occurrence.text || t("source.emptyText")}</pre><small>{cueTiming(row.old.occurrence.identityBasis) ?? "i18n/default.json"} · {row.old.occurrence.valueByteRange.join("–")}</small></> : row.candidates.length ? <ul>{row.candidates.map(candidate => <li key={candidate.occurrenceId}>{t("source.candidate", { key: candidate.occurrence.key, text: candidate.occurrence.text })}</li>)}</ul> : "—"}</td>
                <td>{row.new ? <><strong>{row.new.key}</strong><pre>{row.new.text || t("source.emptyText")}</pre><small>{cueTiming(row.new.identityBasis) ?? "i18n/default.json"} · {row.new.valueByteRange.join("–")}</small></> : "—"}</td>
                <td>{ordinal !== undefined ? <><label className="source-field">{t("source.mapping")}
                  <select disabled={locked} value={selected ? `${selected.decision}:${selected.oldOccurrenceId}` : defaultChoice} onChange={event => {
                    const [decision, oldOccurrenceId] = event.target.value.split(":");
                    setLineage(current => {
                      const next = { ...current };
                      if (decision === "automatic" || decision === "unresolved") delete next[ordinal];
                      else next[ordinal] = { newOrdinal: ordinal, oldOccurrenceId, decision: decision as "continue" | "reject", reason: "" };
                      return next;
                    });
                    setConfirmed(false);
                  }}>
                    <option value={defaultChoice}>{t(`source.mappingChoice.${defaultChoice}`)}</option>
                    {row.candidates.flatMap(candidate => candidate.occurrenceId ? [
                      <option key={`continue:${candidate.occurrenceId}`} value={`continue:${candidate.occurrenceId}`}>{t("source.mappingChoice.continue")} · {candidate.occurrence.key}</option>,
                      <option key={`reject:${candidate.occurrenceId}`} value={`reject:${candidate.occurrenceId}`}>{t("source.mappingChoice.reject")} · {candidate.occurrence.key}</option>,
                    ] : [])}
                    {selected && !row.candidates.some(candidate => candidate.occurrenceId === selected.oldOccurrenceId) ? <option value={`${selected.decision}:${selected.oldOccurrenceId}`}>{t(`source.mappingChoice.${selected.decision}`)} · {historicalMatches?.rows.find(item => item.occurrenceId === selected.oldOccurrenceId)?.occurrence.key ?? t("source.historicalSnapshot")}</option> : null}
                  </select></label>{selected ? <label className="source-field">{t("source.mappingReason")}<textarea disabled={locked} value={selected.reason} maxLength={4096} onChange={event => { setLineage(current => ({ ...current, [ordinal]: { ...current[ordinal], reason: event.target.value } })); setConfirmed(false); }} /></label> : null}
                  <button className="text-button" disabled={locked} onClick={() => { setManualOrdinal(ordinal); setHistoricalMatches(null); }}>{t("source.chooseHistorical")}</button>
                </> : t("source.noMapping")}</td></tr>;
            })}</tbody></table></div>
            <div className="execution-actions">{[0,comparison.nextOrdinal].map((after,index) => after !== null ? <button className="secondary-button" key={index} disabled={locked || (index === 0 && comparison.rows[0]?.new?.ordinal === 0)} onClick={() => void perform(async current => {
              await compare(after, current);
            })}>{t(index === 0 ? "execution.firstPage" : "execution.nextPage")}</button> : null)}</div>
            {manualOrdinal !== null ? <section className="source-maintenance-panel"><h4>{t("source.manualTarget", { key: comparison.rows.find(row => row.new?.ordinal === manualOrdinal)?.new?.key ?? String(manualOrdinal + 1) })}</h4>
              <label className="source-field">{t("source.searchHistory")}<input disabled={locked} maxLength={256} value={historicalQuery} onChange={event => setHistoricalQuery(event.target.value)} /></label>
              <button className="secondary-button" disabled={locked} onClick={() => void perform(async current => { const next = await commands.historyContent({ ...context, snapshotId: comparison.previousSnapshotId, query: historicalQuery, after: 0, limit: 20 }); if (current()) setHistoricalMatches(next); })}>{t("source.search")}</button>
              {historicalMatches ? <><p>{t("source.historyMatches", { count: historicalMatches.total })}</p><ul>{historicalMatches.rows.map(row => <li key={row.occurrenceId}><strong>{row.occurrence.key}</strong><pre>{row.occurrence.text}</pre>{(["continue", "reject"] as const).map(decision => <button className="text-button" key={decision} disabled={locked} onClick={() => { setLineage(current => ({ ...current, [manualOrdinal]: { newOrdinal: manualOrdinal, oldOccurrenceId: row.occurrenceId!, decision, reason: "" } })); setConfirmed(false); }}>{t(`source.mappingChoice.${decision}`)}</button>)}</li>)}</ul>{historicalMatches.nextOrdinal !== null ? <button className="secondary-button" disabled={locked} onClick={() => void perform(async current => { const next = await commands.historyContent({ ...context, snapshotId: comparison.previousSnapshotId, query: historicalQuery, after: historicalMatches.nextOrdinal!, limit: 20 }); if (current()) setHistoricalMatches(next); })}>{t("execution.nextPage")}</button> : null}</> : null}
            </section> : null}
            <button className="secondary-button" disabled={locked} onClick={() => { const ticket = sequence.current; void owner.estimate(() => mounted.current && open && sequence.current === ticket); }}>{t("source.reviewImpact")}</button>
            <p>{t("source.estimateHelp")}</p>{estimate?.map(summary => <p key={summary.locale}>{t("source.impactSummary", { locale: summary.locale, preserved: String(summary.preserved), reassess: String(summary.reassess), unresolved: String(summary.unresolved), total: String(summary.total) })}</p>)}
            <label className="source-check"><input type="checkbox" disabled={locked || owner.state.stale || !!owner.state.receipt || !estimate} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("source.updateConfirm", { count: comparison.total })}</label>
            <p>{t("source.updateImpact")}</p>
            <button className="primary-button" disabled={locked || owner.state.stale || !!owner.state.receipt || !confirmed || (Object.keys(lineage).length > 0 && (!actor.trim() || Object.values(lineage).some(choice => !choice.reason.trim())))} onClick={() => void owner.apply()}>{t("source.applyUpdate")}</button>
          </section> : null}
          {pendingApply && !busy ? <section><p>{t("source.applyUnknown")}</p><button className="secondary-button" disabled={busy} onClick={() => void owner.checkReceipt()}>{t("execution.checkReceipt")}</button>{receiptChecked ? <button className="secondary-button" disabled={busy} onClick={() => void owner.retryApply()}>{t("execution.retryAdoption")}</button> : null}
            <button className="text-button" disabled={busy || !receiptChecked} onClick={owner.keepOutput}>{t("execution.keepOutput")}</button>
          </section> : null}
          <button className="text-button" disabled={locked} onClick={() => { owner.showCurrent(); void perform(loadCurrent); }}>{t("source.viewCurrent")}</button>
          {page?.snapshotId && page.snapshotId === page.scope.currentSnapshot ? <SourceImpactPanel key={page.snapshotId} project={project} snapshotId={page.snapshotId} active={open} onOpenTranslation={onOpenTranslation} onOpenWork={onOpenWork ? () => { setOpen(false); onOpenWork(); } : undefined} /> : null}
          <p>{t("source.correctionHelp")}</p><SourceHistoryPanel key={page?.scope.revision ?? comparison?.scope.revision ?? "selection"} project={project} disabled={locked} onHistory={setHistory} />
          <p>{t("source.draftHelp")}</p>
        </div>
      </WorkbenchPanel>
    <Dialog.Root open={leave} onOpenChange={next => { if (!next) { setLeave(false); leaveResolver.current?.(false); leaveResolver.current = null; } }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()}>
        <Dialog.Title>{t("source.leaveTitle")}</Dialog.Title><Dialog.Description>{t("source.leaveHelp")}</Dialog.Description>
        <div className="form-actions"><button className="secondary-button" onClick={() => { setLeave(false); leaveResolver.current?.(false); leaveResolver.current = null; }}>{t("source.keep")}</button>
          <button className="primary-button" onClick={() => { sequence.current++; void owner.discard().then(ok => { setLeave(false); if (!ok) setOpen(true); leaveResolver.current?.(ok); leaveResolver.current = null; }); }}>{t("source.leave")}</button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </>;
}
