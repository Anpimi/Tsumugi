import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { CommandError, ProjectView } from "./projectCommands";
import type { EditorTarget } from "./TranslationWorkbench";
import type { UiMessages } from "./i18n/types";
import { useSessionQuery } from "./SessionReadProvider";
import { SourceHistoryPanel, SourceImpactPanel, SourceOccurrenceOrigin, readSourceHistoryCoverage, useSourceOccurrenceLabel } from "./SourceMaintenance";
import { executionCommands as execution, executionContext, type AttemptDetail } from "./executionCommands";
import { sourceCommands as commands, type ContentPage, type SourceChangePage, type LineageChoice, type SourceAdoptRequest, type SourceHistory, type SourceImpactSummary } from "./sourceCommands";

import { SourceImportControls, type SourceImportHandle, type SourceImportState } from "./SourceImportControls";

export interface SourceHandle { showAttempt: (id: string) => void; allowLeave: () => Promise<boolean>; allowNavigate: () => Promise<boolean> }
export function SourceWorkbench({ project, disabled, onOpenWork, onOpenTranslation, ref }: { project: ProjectView; disabled: boolean; onOpenWork?: () => void; onOpenTranslation?: (target: EditorTarget, locale: string) => boolean; ref?: Ref<SourceHandle> }) {
  const { t } = useTranslation();
  const sourceLabel = useSourceOccurrenceLabel();
  const context = executionContext(project);
  const [open, setOpen] = useWorkbenchView("source");
  const sourceImport = useRef<SourceImportHandle>(null);
  const [importState, setImportState] = useState<SourceImportState>({ busy: false, pending: false, hasDraft: false });
  const [attempt, setAttempt] = useState<string | null>(null);
  const [page, setPage] = useState<ContentPage | null>(null);
  const [comparison, setComparison] = useState<SourceChangePage | null>(null);
  const [updating, setUpdating] = useState(false);
  const [lineage, setLineage] = useState<Record<number, LineageChoice>>({});
  const [actor, setActor] = useState("");
  const [filter, setFilter] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const [history, setHistory] = useState<SourceHistory | null>(null);
  const [manualOrdinal, setManualOrdinal] = useState<number | null>(null);
  const [historicalQuery, setHistoricalQuery] = useState("");
  const [historicalMatches, setHistoricalMatches] = useState<ContentPage | null>(null);
  const [estimate, setEstimate] = useState<SourceImpactSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failureValue, setFailure] = useState<CommandFailure | null>(null);
  const failure = failureReason(failureValue);
  const [confirmed, setConfirmed] = useState(false);
  const [pendingApply, setPendingApply] = useState<SourceAdoptRequest | null>(null);
  const [receiptChecked, setReceiptChecked] = useState(false);
  const [leave, setLeave] = useState(false);
  const detailRead = useSessionQuery<AttemptDetail | null>({ key: ["source-attempt", attempt, 0, 100], scopes: ["execution"], enabled: open && !busy && !!attempt && !page && !comparison,
    read: () => execution.attempt({ ...context, attemptId: attempt!, offset: 0, limit: 100 }) });
  const detail = detailRead.data ?? null, setDetail = detailRead.setData;

  const leaveResolver = useRef<((answer: boolean) => void) | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const mutation = useRef(false);
  const first = useRef<HTMLHeadingElement>(null);
  const errorRegion = useRef<HTMLDivElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; leaveResolver.current?.(false); }; }, []);
  useImperativeHandle(ref, () => ({
    showAttempt(id) { if (mutation.current || importState.busy || pendingApply || importState.pending) { setOpen(true); return; } sequence.current++; setAttempt(id); setPage(null); setComparison(null); setLineage({}); setEstimate(null); setFilter(""); setAppliedFilter(""); setManualOrdinal(null); setHistoricalMatches(null); setDetail(null); setConfirmed(false); setFailure(null); setOpen(true); },
    allowNavigate() { return Promise.resolve(!busy && !importState.busy && !pendingApply && !importState.pending); },
    allowLeave() { if (pendingApply || importState.pending) { setOpen(true); return Promise.resolve(false); } if (!importState.hasDraft && Object.keys(lineage).length === 0 && !busy && !importState.busy) return Promise.resolve(true); setLeave(true); return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; }); },
  }));
  function showError(error: unknown) {
    setFailure(commandFailure(error));
  }
  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true;
    const ticket = ++sequence.current;
    const current = () => mounted.current && sequence.current === ticket;
    setBusy(true); setFailure(null);
    try { await work(current); } catch (error) { if (current()) showError(error); }
    finally { mutation.current = false; if (mounted.current) setBusy(false); }
  }
  // A ready preview becomes the user's fixed adoption basis, separate from task progress.
  useEffect(() => {
    if (!open || busy || !attempt || page || comparison || !detail) return;
    const ticket = ++sequence.current;
    let stopped = false;
    const current = () => !stopped && mounted.current && ticket === sequence.current;
    const result = detail.items[0];
    if (result?.resultId && result.status.validation !== "invalid" && result.status.execution === "succeeded") {
      void (async () => {
        try {
          const scope = await commands.scope(context);
          if (!current()) return;
          if (scope.currentSnapshot) {
            const changes = await commands.compare({ ...context, attemptId: attempt, resultId: result.resultId!, after: 0, limit: 50 });
            if (current()) { setUpdating(true); setComparison(changes); setPage(null); setFailure(null); }
          } else {
            const preview = await commands.preview({ ...context, attemptId: attempt, resultId: result.resultId!, after: 0, limit: 50 });
            if (current()) { setPage(preview); setFailure(null); }
          }
        } catch (error) { if (current()) showError(error); }
      })();
    } else if (result?.status.execution === "failed" || result?.status.validation === "invalid") setFailure(result.status.diagnostic ?? "output-invalid");
    else if (result?.status.execution === "unknown" || result?.status.execution === "cancelled-before-dispatch") setFailure(result.status.execution);
    return () => { stopped = true; };
  }, [open, busy, attempt, page, comparison, detail, project.sessionToken]);
  useEffect(() => { if (detailRead.error) showError(detailRead.error); }, [detailRead.error]);
  useEffect(() => { if (page || comparison) first.current?.focus(); }, [page, comparison]);
  useEffect(() => { if (failure && open) errorRegion.current?.focus(); }, [failure, open]);
  async function loadCurrent(current: () => boolean) {
    const scope = await commands.scope(context);
    const next = scope.currentSnapshot ? await commands.content({ ...context, snapshotId: scope.currentSnapshot, after: 0, limit: 50 }) : null;
    if (current()) { setPage(next); setComparison(null); setUpdating(false); setLineage({}); setConfirmed(false); if (next) { setAttempt(null); } }
  }
  async function applied(request: SourceAdoptRequest, current: () => boolean) {
    let receipt;
    try {
      await commands.prepare(request);
      receipt = await execution.adopt({ ...context, actionId: request.actionId });
    } catch (error) {
      const code = (error as Partial<CommandError> | null)?.code;
      if (current() && code && code !== "outcome-unknown" && code !== "storage-failed") setPendingApply(null);
      throw error;
    }
    const snapshot = receipt.changes.find(change => change.kind === "source-snapshot")?.id;
    if (!snapshot) throw { code: "output-invalid" };
    const next = await commands.content({ ...context, snapshotId: snapshot, after: 0, limit: 50 });
    if (current()) { setPage(next); setComparison(null); setUpdating(false); setLineage({}); setEstimate(null); setHistory(null); setPendingApply(null); setAttempt(null); setConfirmed(false); }
  }
  async function compare(after: number, current: () => boolean, base: string | null = comparison?.previousSnapshotId ?? null, query = appliedFilter, reset = false) {
    if (!comparison) return;
    const next = await commands.compare({ ...context, attemptId: comparison.attemptId, resultId: comparison.resultId, base, filter: query, after, limit: 50 });
    if (current()) {
      const changed = next.scope.currentSnapshot !== comparison.scope.currentSnapshot || next.scope.revision !== comparison.scope.revision;
      setComparison(next); setAppliedFilter(query);
      if (reset || changed) { setConfirmed(false); setEstimate(null); setLineage({}); setManualOrdinal(null); setHistoricalMatches(null); }
      if (changed) setFailure("stale-preview");
    }
  }
  useEffect(() => {
    if (open && !attempt && !page && !importState.hasDraft && !updating) void perform(loadCurrent);
  }, [open, project.sessionToken]);
  function requestBack() {
    if (!mutation.current && !pendingApply && !importState.pending && !importState.busy) setOpen(false);
  }
  const knownErrors: Record<string, keyof UiMessages["source"]["errors"]> = {
    "unsupported-encoding": "encoding", "source-changed": "changed", "duplicate-native-key": "duplicate", "empty-source": "empty", "capture-timeout": "timeout", "extract-timeout": "unknown", "source-corrupt": "invalid", "stale-preview": "conflict", "language-required": "language",
    "unsupported-format": "format", "missing-companion": "missing", "language-conflict": "language", "limit-exceeded": "limit", "input-limit": "limit", "unauthorized-selection": "selection", "session-invalid": "selection", "input-busy": "busy", busy: "busy", "source-already-present": "conflict", "source-namespace": "namespace", "source-unchanged": "unchanged", "lineage-choice": "lineage", "lineage-split": "lineage", "dependency-conflict": "conflict", "output-invalid": "invalid", "invalid-structure": "invalid", cancelled: "cancelled", "cancelled-before-dispatch": "cancelled", unknown: "unknown", "outcome-unknown": "unknown",
  };
  const locked = busy || importState.busy || importState.pending || pendingApply !== null;
  const sourceValid = detail?.items[0]?.status.validation === "valid";
  const proposal = comparison ? { attemptId: comparison.attemptId, resultId: comparison.resultId } : page && !page.snapshotId ? { attemptId: page.attemptId, resultId: page.resultId } : null;
  const warnings = page?.diagnostics ?? [];
  const manualOccurrence = comparison?.rows.find(row => row.new?.ordinal === manualOrdinal)?.new;
  return <>
    <WorkbenchPanel open={open} title={t("source.title")} description={t("source.description")} className="source-dialog" onBack={() => void requestBack()} backDisabled={disabled || busy}>
        <div className="execution-content" aria-busy={busy}>
          {failure ? <div ref={errorRegion} role="alert" tabIndex={-1}><p>{t(`source.errors.${knownErrors[failure] ?? "failed"}`)}</p><CommandFailureDetails failure={failureValue} />{typeof failureValue === "string" ? <details><summary>{t("execution.diagnostic")}</summary><code>{failure}</code></details> : null}</div> : null}
          {busy ? <p role="status">{t("execution.working")}</p> : null}
          {warnings.length ? <details><summary>{t("source.diagnostics", { count: warnings.length })}</summary><ul>{warnings.map((diagnostic, index) => <li key={`${diagnostic}:${index}`}><code>{diagnostic}</code></li>)}</ul></details> : null}
          <SourceImportControls ref={sourceImport} project={project} open={open} canCapture={!page && !comparison && !attempt} proposal={proposal} validation={detail?.items[0]?.status.validation ?? "pending"} disabled={disabled || busy || !!pendingApply} onState={setImportState}
            onStarted={id => { sequence.current++; setAttempt(id); setPage(null); setComparison(null); setLineage({}); setEstimate(null); setFilter(""); setAppliedFilter(""); setManualOrdinal(null); setHistoricalMatches(null); setDetail(null); setConfirmed(false); }}
            onValidated={async () => { if (!proposal) return; const ticket = sequence.current; const fresh = await execution.attempt({ ...context, attemptId: proposal.attemptId, offset: 0, limit: 100 }); if (mounted.current && sequence.current === ticket) setDetail(fresh); }} />
          {proposal && !sourceValid ? <button className="secondary-button" disabled={locked || Object.keys(lineage).length > 0} onClick={() => { sequence.current++; setAttempt(null); setPage(null); setComparison(null); setConfirmed(false); setFailure(null); }}>{t("sourcePlugin.newInput")}</button> : null}
          {attempt && !page && !comparison ? <section><p role="status">{t("source.savedTask")}</p><p>{t("source.taskHelp")}</p>
            {detail ? <button className="secondary-button" disabled={locked} onClick={() => void perform(async () => { await execution.cancel({ ...context, taskId: detail.taskId, requestId: await execution.identity(context) }); })}>{t("execution.cancel")}</button> : null}
            <button className="secondary-button" disabled={locked} onClick={() => void perform(async current => { if (current()) setDetail(null); })}>{t("execution.refresh")}</button>
          </section> : null}
          {page ? <section>
            <h3 ref={first} tabIndex={-1}>{t(page.snapshotId ? "source.imported" : "source.preview")}</h3>
            <p role="status">{t("source.range", { namespace: page.namespace, count: page.total, language: page.confirmation.sourceLanguage })}</p>
            <ul>{page.coverage.map(file => <li key={file.artifactId}>{file.logicalPath}<details><summary>{t("source.fingerprint")}</summary><code>{file.sha256}</code></details></li>)}</ul>
            <p>{t("source.identityHelp")}</p>
            <div className="source-table-scroll"><table className="source-table"><caption>{t("source.pageRange", { first: String((page.rows[0]?.occurrence.ordinal ?? 0) + 1), last: String((page.rows.at(-1)?.occurrence.ordinal ?? -1) + 1), total: String(page.total) })}</caption><thead><tr><th scope="col">{t("source.key")}</th><th scope="col">{t("source.text")}</th></tr></thead><tbody>{page.rows.map(row => <tr key={row.occurrence.operationOccurrenceId}><th scope="row">{sourceLabel(row.occurrence)}<SourceOccurrenceOrigin key={`${project.sessionToken}:${project.metadata.projectId}:${page.snapshotId ?? page.resultId}:${row.occurrence.operationOccurrenceId}`} occurrence={row.occurrence} coverage={page.coverage} /></th><td><pre>{row.occurrence.text || t("source.emptyText")}</pre></td></tr>)}</tbody></table></div>
            <div className="execution-actions">{[0, page.nextOrdinal].map((after, index) => after !== null ? <button className="secondary-button" key={index} disabled={locked || (index === 0 && page.rows[0]?.occurrence.ordinal === 0)} onClick={() => void perform(async current => {
              const next = page.snapshotId ? await commands.content({ ...context, snapshotId: page.snapshotId, after, limit: 50 }) : await commands.preview({ ...context, attemptId: page.attemptId, resultId: page.resultId, after, limit: 50 });
              if (current()) setPage(next);
            })}>{t(index === 0 ? "execution.firstPage" : "execution.nextPage")}</button> : null)}</div>
            {!page.snapshotId ? <>
              <label className="source-check"><input type="checkbox" disabled={locked || !sourceValid || page.scope.currentSnapshot !== null} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("source.confirm", { count: page.total, language: page.confirmation.sourceLanguage })}</label>
              <p>{t("source.applyHelp")}</p>
              {page.scope.currentSnapshot ? <p>{t("source.errors.conflict")}</p> : null}
              <button className="primary-button" disabled={locked || !sourceValid || !confirmed || page.scope.currentSnapshot !== null} onClick={() => void perform(async current => {
                const request = { ...context, attemptId: page.attemptId, resultId: page.resultId, actionId: await execution.identity(context), confirmation: page.confirmation };
                if (!current()) return;
                setPendingApply(request); setReceiptChecked(false); await applied(request, current);
              })}>{t("source.apply")}</button>
            </> : null}
            {page.snapshotId && page.snapshotId === page.scope.currentSnapshot ? <button className="primary-button" disabled={locked} onClick={() => {
              sequence.current++; setPage(null); setComparison(null); setLineage({}); setUpdating(true); setConfirmed(false); setFailure(null);
            }}>{t("source.update")}</button> : null}
          </section> : null}
          {comparison ? <section>
            <h3 ref={first} tabIndex={-1}>{t("source.compareTitle")}</h3>
            <p role="status">{t("source.compareSummary", { unchanged: String(comparison.unchanged), moved: String(comparison.moved), changed: String(comparison.changed), added: String(comparison.added), ambiguous: String(comparison.ambiguous), removed: String(comparison.removed) })}</p>
            <p>{t("source.compareHelp")}</p>
            <label className="source-field">{t("source.mappingActor")}<input disabled={locked} value={actor} onChange={event => setActor(event.target.value)} maxLength={128} autoComplete="name" /></label>
            <label className="source-field">{t("source.comparisonFilter")}<input disabled={locked} value={filter} maxLength={256} onChange={event => setFilter(event.target.value)} /></label>
            <button className="secondary-button" disabled={locked} onClick={() => void perform(current => compare(0, current, comparison.previousSnapshotId, filter))}>{t("source.search")}</button>
            <button className="secondary-button" disabled={locked} onClick={() => void perform(current => compare(0, current, null, filter, true))}>{t("source.refreshComparison")}</button>
            <p>{t("source.filteredRange", { count: comparison.filteredTotal, total: String(comparison.total) })}</p>
            {history ? <label className="source-field">{t("source.comparisonBase")}<select disabled={locked} value={comparison.previousSnapshotId} onChange={event => void perform(current => compare(0, current, event.target.value, filter, true))}>
              {history.snapshots.map(entry => <option key={entry.snapshotId} value={entry.snapshotId}>{t("source.snapshotLabel", { revision: String(entry.revision) })} · {t(entry.current ? "source.currentSnapshot" : "source.historicalSnapshot")}</option>)}
            </select></label> : null}
            <div className="source-table-scroll"><table className="source-table source-comparison-table"><caption>{t("source.changePage", { count: comparison.rows.length, total: String(comparison.total) })}</caption><thead><tr><th scope="col">{t("source.changeKind")}</th><th scope="col">{t("source.previous")}</th><th scope="col">{t("source.next")}</th><th scope="col">{t("source.mapping")}</th></tr></thead><tbody>{comparison.rows.map((row,index) => {
              const ordinal = row.new?.ordinal;
              const selected = ordinal === undefined ? undefined : lineage[ordinal];
              const selectedHistorical = historicalMatches?.rows.find(item => item.occurrenceId === selected?.oldOccurrenceId);
              const defaultChoice = row.kind === "unchanged" || row.kind === "moved" ? "automatic" : "unresolved";
              return <tr key={row.new?.operationOccurrenceId ?? row.old?.occurrenceId ?? index}><th scope="row">{t(`source.change.${row.kind}`)}</th>
                <td>{row.old ? <><strong>{sourceLabel(row.old.occurrence)}</strong><pre>{row.old.occurrence.text || t("source.emptyText")}</pre><SourceOccurrenceOrigin key={`${project.sessionToken}:${project.metadata.projectId}:${comparison.previousSnapshotId}:${row.old.occurrenceId}`} occurrence={row.old.occurrence} coverage={history?.snapshots.find(entry => entry.snapshotId === comparison.previousSnapshotId)?.coverage} readCoverage={() => readSourceHistoryCoverage(context, comparison.previousSnapshotId)} /></> : row.candidates.length ? <ul>{row.candidates.map(candidate => <li key={candidate.occurrenceId}>{t("source.candidate", { key: sourceLabel(candidate.occurrence), text: candidate.occurrence.text })}</li>)}</ul> : "—"}</td>
                <td>{row.new ? <><strong>{sourceLabel(row.new)}</strong><pre>{row.new.text || t("source.emptyText")}</pre><SourceOccurrenceOrigin key={`${project.sessionToken}:${project.metadata.projectId}:${comparison.resultId}:${row.new.operationOccurrenceId}`} occurrence={row.new} readCoverage={async () => { const preview = await commands.preview({ ...context, attemptId: comparison.attemptId, resultId: comparison.resultId, after: 0, limit: 1 }); if (preview.attemptId !== comparison.attemptId || preview.resultId !== comparison.resultId) throw new Error("Source preview result mismatch"); return preview.coverage; }} /></> : "—"}</td>
                <td>{ordinal !== undefined ? <><label className="source-field">{t("source.mapping")}
                  <select disabled={locked} value={selected ? `${selected.decision}:${selected.oldOccurrenceId}` : defaultChoice} onChange={event => {
                    const [decision, oldOccurrenceId] = event.target.value.split(":");
                    setLineage(current => {
                      const next = { ...current };
                      if (decision === "automatic" || decision === "unresolved") delete next[ordinal];
                      else next[ordinal] = { newOrdinal: ordinal, oldOccurrenceId, decision: decision as "continue" | "reject", reason: "" };
                      return next;
                    });
                    setEstimate(null); setConfirmed(false);
                  }}>
                    <option value={defaultChoice}>{t(`source.mappingChoice.${defaultChoice}`)}</option>
                    {row.candidates.flatMap(candidate => candidate.occurrenceId ? [
                      <option key={`continue:${candidate.occurrenceId}`} value={`continue:${candidate.occurrenceId}`}>{t("source.mappingChoice.continue")} · {sourceLabel(candidate.occurrence)}</option>,
                      <option key={`reject:${candidate.occurrenceId}`} value={`reject:${candidate.occurrenceId}`}>{t("source.mappingChoice.reject")} · {sourceLabel(candidate.occurrence)}</option>,
                    ] : [])}
                    {selected && !row.candidates.some(candidate => candidate.occurrenceId === selected.oldOccurrenceId) ? <option value={`${selected.decision}:${selected.oldOccurrenceId}`}>{t(`source.mappingChoice.${selected.decision}`)} · {selectedHistorical ? sourceLabel(selectedHistorical.occurrence) : t("source.historicalSnapshot")}</option> : null}
                  </select></label>{selected ? <label className="source-field">{t("source.mappingReason")}<textarea disabled={locked} value={selected.reason} maxLength={4096} onChange={event => { setLineage(current => ({ ...current, [ordinal]: { ...current[ordinal], reason: event.target.value } })); setConfirmed(false); }} /></label> : null}
                  <button className="text-button" disabled={locked} onClick={() => { setManualOrdinal(ordinal); setHistoricalMatches(null); }}>{t("source.chooseHistorical")}</button>
                </> : t("source.noMapping")}</td></tr>;
            })}</tbody></table></div>
            <div className="execution-actions">{[0,comparison.nextOrdinal].map((after,index) => after !== null ? <button className="secondary-button" key={index} disabled={locked || (index === 0 && comparison.rows[0]?.new?.ordinal === 0)} onClick={() => void perform(async current => {
              await compare(after, current);
            })}>{t(index === 0 ? "execution.firstPage" : "execution.nextPage")}</button> : null)}</div>
            {manualOrdinal !== null ? <section className="source-maintenance-panel"><h4>{t("source.manualTarget", { key: manualOccurrence ? sourceLabel(manualOccurrence) : t("source.entryLabel", { number: String(manualOrdinal + 1) }) })}</h4>
              <label className="source-field">{t("source.searchHistory")}<input disabled={locked} maxLength={256} value={historicalQuery} onChange={event => setHistoricalQuery(event.target.value)} /></label>
              <button className="secondary-button" disabled={locked} onClick={() => void perform(async current => { const next = await commands.historyContent({ ...context, snapshotId: comparison.previousSnapshotId, query: historicalQuery, after: 0, limit: 20 }); if (current()) setHistoricalMatches(next); })}>{t("source.search")}</button>
              {historicalMatches ? <><p>{t("source.historyMatches", { count: historicalMatches.total })}</p><ul>{historicalMatches.rows.map(row => <li key={row.occurrenceId}><strong>{sourceLabel(row.occurrence)}</strong><pre>{row.occurrence.text}</pre><SourceOccurrenceOrigin key={`${project.sessionToken}:${project.metadata.projectId}:${historicalMatches.snapshotId}:${row.occurrenceId}`} occurrence={row.occurrence} coverage={historicalMatches.coverage} />{(["continue", "reject"] as const).map(decision => <button className="text-button" key={decision} disabled={locked} onClick={() => { setLineage(current => ({ ...current, [manualOrdinal]: { newOrdinal: manualOrdinal, oldOccurrenceId: row.occurrenceId!, decision, reason: "" } })); setEstimate(null); setConfirmed(false); }}>{t(`source.mappingChoice.${decision}`)}</button>)}</li>)}</ul>{historicalMatches.nextOrdinal !== null ? <button className="secondary-button" disabled={locked} onClick={() => void perform(async current => { const next = await commands.historyContent({ ...context, snapshotId: comparison.previousSnapshotId, query: historicalQuery, after: historicalMatches.nextOrdinal!, limit: 20 }); if (current()) setHistoricalMatches(next); })}>{t("execution.nextPage")}</button> : null}</> : null}
            </section> : null}
            <button className="secondary-button" disabled={locked} onClick={() => void perform(async current => { const next = await commands.estimate({ ...context, attemptId: comparison.attemptId, resultId: comparison.resultId, actionId: await execution.identity(context), confirmation: { ...comparison.confirmation, lineage: Object.values(lineage), actor: actor.trim() || null } }); if (current()) setEstimate(next); })}>{t("source.reviewImpact")}</button>
            <p>{t("source.estimateHelp")}</p>{estimate?.map(summary => <p key={summary.locale}>{t("source.impactSummary", { locale: summary.locale, preserved: String(summary.preserved), reassess: String(summary.reassess), unresolved: String(summary.unresolved), total: String(summary.total) })}</p>)}
            <label className="source-check"><input type="checkbox" disabled={locked || !sourceValid || !estimate} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("source.updateConfirm", { count: comparison.total })}</label>
            <p>{t("source.updateImpact")}</p>
            <button className="primary-button" disabled={locked || !sourceValid || !confirmed || (Object.keys(lineage).length > 0 && (!actor.trim() || Object.values(lineage).some(choice => !choice.reason.trim())))} onClick={() => void perform(async current => {
              const request = { ...context, attemptId: comparison.attemptId, resultId: comparison.resultId, actionId: await execution.identity(context), confirmation: { ...comparison.confirmation, lineage: Object.values(lineage), actor: actor.trim() || null } };
              if (!current()) return;
              setPendingApply(request); setReceiptChecked(false); await applied(request,current);
            })}>{t("source.applyUpdate")}</button>
          </section> : null}
          {pendingApply && !busy ? <section><p>{t("source.applyUnknown")}</p><button className="secondary-button" disabled={busy} onClick={() => void perform(async current => {
            const receipt = await execution.receipt({ ...context, actionId: pendingApply.actionId });
            if (!current()) return;
            setReceiptChecked(true);
            if (receipt) { await loadCurrent(current); if (current()) setPendingApply(null); }
          })}>{t("execution.checkReceipt")}</button>{receiptChecked ? <button className="secondary-button" disabled={busy} onClick={() => void perform(current => { setReceiptChecked(false); return applied(pendingApply, current); })}>{t("execution.retryAdoption")}</button> : null}
            <button className="text-button" disabled={busy || !receiptChecked} onClick={() => { setPendingApply(null); setConfirmed(false); }}>{t("execution.keepOutput")}</button>
          </section> : null}
          <button className="text-button" disabled={locked} onClick={() => void perform(loadCurrent)}>{t("source.viewCurrent")}</button>
          {page?.snapshotId && page.snapshotId === page.scope.currentSnapshot ? <SourceImpactPanel key={page.snapshotId} project={project} snapshotId={page.snapshotId} active={open} onOpenTranslation={onOpenTranslation} onOpenWork={onOpenWork ? () => { setOpen(false); onOpenWork(); } : undefined} /> : null}
          <p>{t("source.correctionHelp")}</p><SourceHistoryPanel key={page?.scope.revision ?? comparison?.scope.revision ?? "selection"} project={project} disabled={locked} onHistory={setHistory} />
          <p>{t("source.draftHelp")}</p>
        </div>
      </WorkbenchPanel>
    <Dialog.Root open={leave} onOpenChange={next => { if (!next) { setLeave(false); leaveResolver.current?.(false); leaveResolver.current = null; } }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()}>
        <Dialog.Title>{t("source.leaveTitle")}</Dialog.Title><Dialog.Description>{t("source.leaveHelp")}</Dialog.Description>
        <div className="form-actions"><button className="secondary-button" onClick={() => { setLeave(false); leaveResolver.current?.(false); leaveResolver.current = null; }}>{t("source.keep")}</button>
          <button className="primary-button" onClick={() => { sequence.current++; void (sourceImport.current?.discard() ?? commands.cancelCapture(context)).then(() => { setLineage({}); setComparison(null); setLeave(false); leaveResolver.current?.(true); leaveResolver.current = null; }, error => { showError(error); setLeave(false); setOpen(true); leaveResolver.current?.(false); leaveResolver.current = null; }); }}>{t("source.leave")}</button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </>;
}
