import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "./projectCommands";
import { executionContext } from "./executionCommands";
import { sourceCommands, type ContentPage, type ContentRow } from "./sourceCommands";
import { resourceCommands as commands, type GlossaryCapture, type ImpactPage, type TermResolution, type TermRevision, type TmSuggestion } from "./resourceCommands";
import { useResourceDraftSession } from "./ResourceDraftSession";
import type { EditorTarget } from "./TranslationWorkbench";

type Tab = "terms" | "updates" | "context" | "impact";
export interface ResourceHandle { allowLeave: () => Promise<boolean>; allowNavigate: () => Promise<boolean> }
export function ResourceWorkbench({ project, disabled, onOpenTranslation, ref }: {
  project: ProjectView; disabled: boolean;
  onOpenTranslation: (target: EditorTarget, locale: string, suggestedText?: string) => boolean;
  ref?: Ref<ResourceHandle>;
}) {
  const { t } = useTranslation();
  const session = executionContext(project), owner = useResourceDraftSession();
  const { locale, selectedTerm, termDraft, aliasInput, selectedUnit, contextDraft, contextReason,
    previewCapture, preview, previewNeedsRefresh, fixedContext, pending, notice, busyMutation, completionVersion } = owner.state;
  const pendingTerm = pending?.kind === "term" ? pending.request : null;
  const pendingContext = pending?.kind === "context" ? pending.request : null;
  const pendingDecision = pending?.kind === "decision" ? pending.request : null;
  const termDirty = owner.termDirty(), contextDirty = owner.contextDirty();
  const [open, setOpen] = useWorkbenchView("resources");
  const [tab, setTab] = useState<Tab>("terms");
  const [sourcePage, setSourcePage] = useState<ContentPage | null>(null);
  const [sourceMissing, setSourceMissing] = useState(false);
  const [terms, setTerms] = useState<TermRevision[]>([]);
  const [termHistory, setTermHistory] = useState<TermRevision[]>([]);
  const [captures, setCaptures] = useState<GlossaryCapture[]>([]);
  const [resolution, setResolution] = useState<TermResolution | null>(null);
  const [suggestions, setSuggestions] = useState<TmSuggestion[]>([]);
  const [impact, setImpact] = useState<ImpactPage | null>(null);
  const [impactOffset, setImpactOffset] = useState(0);
  const [readBusy, setReadBusy] = useState(false);
  const [readFailure, setReadFailure] = useState<CommandFailure | null>(null);
  const failureValue = owner.state.failure, failure = failureReason(failureValue);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const leaveResolver = useRef<((answer: boolean) => void) | null>(null);
  const alive = useRef(false), generation = useRef(0), running = useRef(false);
  const committed = useRef({ open, locale, project, disabled, tab });
  const targetScope = project.metadata.targetLocales.join("\u0000");
  const targetAvailable = project.metadata.targetLocales.includes(locale);
  const busy = readBusy || busyMutation;
  useLayoutEffect(() => {
    committed.current = { open, locale, project, disabled, tab };
    generation.current++; running.current = false; setReadBusy(false);
  }, [open, locale, project, targetScope, tab]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; leaveResolver.current?.(false); }; }, []);
  function currentLocale(value: string) { return alive.current && committed.current.open && committed.current.locale === value && committed.current.project.sessionToken === session.sessionToken
    && committed.current.project.metadata.projectId === session.projectId && owner.localeAvailable(value); }
  useEffect(() => {
    if (!open || !targetAvailable) return;
    let cancelled = false;
    void (async () => {
      try {
        const scope = await sourceCommands.scope(session);
        if (cancelled || !currentLocale(locale)) return;
        const page = scope.currentSnapshot ? await sourceCommands.content({ ...session, snapshotId: scope.currentSnapshot, after: 0, limit: 50 }) : null;
        if (!cancelled && currentLocale(locale)) { setSourcePage(page); setSourceMissing(!page); }
      } catch (error) { if (!cancelled && currentLocale(locale)) setReadFailure(commandFailure(error)); }
    })();
    return () => { cancelled = true; };
  }, [open, locale, targetScope, project.sessionToken]);
  useEffect(() => {
    setTerms([]); setTermHistory([]); setResolution(null); setSuggestions([]); setImpact(null); setImpactOffset(0); setReadFailure(null);
  }, [locale, targetScope]);
  useEffect(() => {
    if (!open || !targetAvailable) return;
    let cancelled = false;
    void commands.terms({ ...session, locale, afterTermId: null, limit: 100 }).then(rows => { if (!cancelled && currentLocale(locale)) setTerms(rows); })
      .catch(error => { if (!cancelled && currentLocale(locale)) setReadFailure(commandFailure(error)); });
    return () => { cancelled = true; };
  }, [open, locale, targetScope, project.sessionToken, completionVersion]);
  useEffect(() => {
    if (!open || !targetAvailable) return;
    let cancelled = false;
    void commands.captures({ ...session, limit: 100 }).then(rows => { if (!cancelled && currentLocale(locale)) setCaptures(rows); })
      .catch(error => { if (!cancelled && currentLocale(locale)) setReadFailure(commandFailure(error)); });
    return () => { cancelled = true; };
  }, [open, locale, targetScope, project.sessionToken, completionVersion]);
  useEffect(() => {
    if (!open || !targetAvailable || !selectedTerm) return;
    let cancelled = false;
    void commands.termHistory({ ...session, termId: selectedTerm.termId, offset: 0, limit: 100 }).then(rows => {
      if (!cancelled && currentLocale(locale) && owner.current().selectedTerm?.termId === selectedTerm.termId) setTermHistory(rows);
    }).catch(error => { if (!cancelled && currentLocale(locale)) setReadFailure(commandFailure(error)); });
    return () => { cancelled = true; };
  }, [open, locale, targetScope, selectedTerm?.termId, completionVersion]);
  useEffect(() => {
    if (!open || !targetAvailable || !selectedUnit?.unitId || !selectedUnit.sourceRevisionId) return;
    let cancelled = false;
    const captured = selectedUnit;
    void Promise.all([commands.resolve({ ...session, unitId: captured.unitId!, locale }), commands.suggestions({ ...session, unitId: captured.unitId!, locale, offset: 0, limit: 20 })])
      .then(([resolved, tm]) => {
        if (cancelled || !currentLocale(locale) || owner.current().selectedUnit !== captured) return;
        if (resolved.unitId !== captured.unitId || resolved.locale !== locale || resolved.sourceRevisionId !== captured.sourceRevisionId) { setResolution(null); setSuggestions([]); setReadFailure("context-source"); return; }
        setResolution(resolved); setSuggestions(tm.filter(item => item.targetLocale === locale));
      }).catch(error => { if (!cancelled && currentLocale(locale)) setReadFailure(commandFailure(error)); });
    return () => { cancelled = true; };
  }, [open, locale, targetScope, selectedUnit, completionVersion]);
  function allowNavigate() { generation.current++; running.current = false; setReadBusy(false); return Promise.resolve(true); }
  useImperativeHandle(ref, () => ({ allowNavigate, allowLeave() {
    if (owner.inFlight() || owner.current().pending) { setOpen(true); return Promise.resolve(false); }
    if (!owner.termDirty() && !owner.contextDirty()) return Promise.resolve(true);
    setOpen(true); setLeavePrompt(true);
    return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
  } }));
  async function run(work: (current: () => boolean) => Promise<void>) {
    if (running.current || !currentLocale(locale)) return;
    running.current = true; const ticket = ++generation.current;
    const current = () => alive.current && generation.current === ticket && currentLocale(locale);
    setReadBusy(true); setReadFailure(null);
    try { await work(current); } catch (error) { if (current()) setReadFailure(commandFailure(error)); }
    finally { if (generation.current === ticket) { running.current = false; if (alive.current) setReadBusy(false); } }
  }
  function currentView() {
    const ticket = generation.current;
    return () => generation.current === ticket && currentLocale(locale);
  }
  async function refreshDecision(work: () => Promise<void>) {
    const current = currentView();
    await work();
    if (current() && !owner.current().pending && owner.current().notice === "decisionSaved") await owner.retryPreview(current);
  }
  function retryPending() {
    if (owner.current().pending?.kind === "decision") return refreshDecision(() => owner.retryPending());
    return owner.retryPending();
  }
  function requestClose() { void allowNavigate().then(() => setOpen(false)); }
  function finishLeave(discard: boolean) {
    if (owner.inFlight() || owner.current().pending) return;
    setLeavePrompt(false);
    if (discard) { owner.discard(); if (leaveResolver.current) leaveResolver.current(true); }
    else leaveResolver.current?.(false);
    leaveResolver.current = null;
  }
  function switchLocale(next: string) { if (!owner.setLocale(next)) { if (!owner.inFlight() && !owner.current().pending) setLeavePrompt(true); } }
  function selectTerm(term: TermRevision | null) { if (!owner.beginTerm(term) && !owner.inFlight() && !owner.current().pending) setLeavePrompt(true); }
  async function selectUnit(row: ContentRow, current: () => boolean) {
    if (owner.contextDirty() || owner.inFlight() || owner.current().pending) { if (!owner.inFlight() && !owner.current().pending) setLeavePrompt(true); return; }
    if (!row.unitId || !row.sourceRevisionId) return;
    const manual = await commands.context({ ...session, unitId: row.unitId, locale });
    if (current()) {
      if (manual && (manual.unitId !== row.unitId || manual.locale !== locale)) throw new Error("Invalid context reference");
      owner.beginContext(row, manual);
    }
  }
  async function loadImpact(offset: number, current: () => boolean) { const next = await commands.impacts({ ...session, locale, offset, limit: 50 }); if (current()) { setImpact(next); setImpactOffset(offset); } }
  useEffect(() => {
    if (open && tab === "impact" && targetAvailable) void run(current => loadImpact(0, current));
  }, [open, tab, locale, targetScope, project.sessionToken]);
  function openTranslation(target: EditorTarget, suggestion?: string) {
    if (!owner.localeAvailable(locale) || owner.inFlight() || owner.current().pending) return;
    if (onOpenTranslation(target, locale, suggestion)) requestClose(); else setReadFailure("translation-draft");
  }
  const sourceRows = sourcePage?.rows ?? [];
  return <>
    <WorkbenchPanel open={open} title={t("resource.title")} description={t("resource.description")} className="source-dialog" onBack={requestClose} backDisabled={disabled}>
        <div className="execution-content" aria-busy={busy}>
          {failure ? <div role="alert"><p>{t("resource.error", { reason: t(`resource.errors.${failure}`, { defaultValue: failure }) })}</p><CommandFailureDetails failure={failureValue} /></div> : null}
          {notice ? <p role="status">{t(notice === "saved" ? "resource.saved" : notice === "savedNewer" ? "resource.saved" : notice === "decisionSaved" ? "resource.decisionSaved" : notice === "previewReady" ? "resource.previewReady" : notice === "captureSaved" ? "resource.captureSaved" : notice === "pickerUnknown" ? "resource.pickerUnknown" : notice === "unknown" ? "resource.uncertainAction" : "resource.actionFailed")}</p> : null}
          {notice === "savedNewer" ? <p role="status">{t("resource.savedNewer")}</p> : null}
          {readFailure ? <div role="alert"><p>{t("resource.readFailed", { reason: t(`resource.errors.${failureReason(readFailure)}`, { defaultValue: failureReason(readFailure) ?? "" }) })}</p><CommandFailureDetails failure={readFailure} /></div> : null}
          {!targetAvailable && locale ? <p role="status">{t("resource.removedTarget", { locale })} <button className="text-button" onClick={requestClose}>{t("resource.returnSettings")}</button></p> : null}
          {previewCapture && previewCapture.targetLocale !== locale && !owner.localeAvailable(previewCapture.targetLocale) ? <p role="status">{t("resource.removedPreviewTarget", { locale: previewCapture.targetLocale })} <button className="text-button" onClick={requestClose}>{t("resource.returnSettings")}</button></p> : null}
          {pending && (pending.kind === "capture" || (pending.kind === "term" && tab !== "terms") || (pending.kind === "context" && tab !== "context") || (pending.kind === "decision" && tab !== "updates")) ? <div role="status"><p>{t("resource.uncertainAction")}</p><button className="secondary-button" disabled={busyMutation || disabled} onClick={() => void retryPending()}>{t("resource.retry")}</button></div> : null}
          {busy ? <p role="status">{t("execution.working")}</p> : null}
          <label>{t("resource.targetLocale")}<select value={locale} disabled={busyMutation || !!pending} onChange={event => switchLocale(event.target.value)}>{!targetAvailable && locale ? <option value={locale} disabled>{t("resource.removedTargetOption", { locale })}</option> : null}{project.metadata.targetLocales.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          {!locale ? <p>{t("resource.noLocale")}</p> : null}
          {sourceMissing ? <p>{t("resource.noSource")}</p> : null}
          <div className="execution-actions" role="tablist" aria-label={t("resource.title")}>
            {(["terms", "updates", "context", "impact"] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "primary-button" : "secondary-button"} onClick={() => setTab(value)}>{t(`resource.tabs.${value}`)}</button>)}
          </div>
          {tab === "terms" && locale ? <section>
            <div className="execution-section-heading"><h3>{t("resource.currentTerms")}</h3><button className="secondary-button" disabled={busy || !!pending || !targetAvailable || termDirty} onClick={() => selectTerm(null)}>{t("resource.newTerm")}</button></div>
            {terms.length ? <ul>{terms.filter(term => !term.removed).map(term => <li key={term.termId}><button className="text-button" disabled={busy || !!pending || !targetAvailable} onClick={() => selectTerm(term)}>{term.source} → {term.target}</button> <small>{term.scopeUnitId ? t("resource.unitScope") : t("resource.projectScope")} · {term.originKind === "manual" ? t("resource.manual") : t("resource.external")}</small></li>)}</ul> : <p>{t("resource.noTerms")}</p>}
            {terms.length === 100 ? <button className="secondary-button" disabled={busy || !targetAvailable} onClick={() => void run(async current => { const more = await commands.terms({ ...session, locale, afterTermId: terms.at(-1)!.termId, limit: 100 }); if (current()) setTerms([...terms, ...more]); })}>{t("execution.nextPage")}</button> : null}
            <div className="translation-editor">
              <h4>{selectedTerm ? t("resource.editTerm") : t("resource.newTerm")}</h4>
              <label>{t("resource.sourceTerm")}<input value={termDraft.source} onChange={event => owner.editTerm({ ...owner.current().termDraft, source: event.target.value })} /></label>
              <label>{t("resource.aliases")}<input value={aliasInput} onChange={event => { const value = event.target.value; owner.editTerm({ ...owner.current().termDraft, aliases: value.split(",").map(alias => alias.trim()).filter(Boolean) }, value); }} /></label>
              <label>{t("resource.targetTerm")}<input value={termDraft.target} onChange={event => owner.editTerm({ ...owner.current().termDraft, target: event.target.value })} /></label>
              <label>{t("resource.scope")}<select value={termDraft.scopeUnitId ?? ""} onChange={event => owner.editTerm({ ...owner.current().termDraft, scopeUnitId: event.target.value || null })}><option value="">{t("resource.projectScope")}</option>{termDraft.scopeUnitId && !sourceRows.some(row => row.unitId === termDraft.scopeUnitId) ? <option value={termDraft.scopeUnitId}>{t("resource.currentUnit")}</option> : null}{sourceRows.filter(row => row.unitId).map(row => <option key={row.unitId!} value={row.unitId!}>{row.occurrence.key}</option>)}</select></label>
              {sourcePage ? <div className="execution-actions"><button className="secondary-button" disabled={busy || !targetAvailable} onClick={() => void run(async current => { const first = await sourceCommands.content({ ...session, snapshotId: sourcePage.snapshotId!, after: 0, limit: 50 }); if (current()) setSourcePage(first); })}>{t("execution.firstPage")}</button><button className="secondary-button" disabled={busy || !targetAvailable || sourcePage.nextOrdinal === null} onClick={() => void run(async current => { const next = await sourceCommands.content({ ...session, snapshotId: sourcePage.snapshotId!, after: sourcePage.nextOrdinal!, limit: 50 }); if (current()) setSourcePage(next); })}>{t("execution.nextPage")}</button></div> : null}
              <label className="source-check"><input type="checkbox" checked={termDraft.protected} onChange={event => owner.editTerm({ ...owner.current().termDraft, protected: event.target.checked })} />{t("resource.protected")}</label>
              <label>{t("resource.reason")}<input value={termDraft.reason} onChange={event => owner.editTerm({ ...owner.current().termDraft, reason: event.target.value })} /></label>
              <div className="execution-actions"><button className="primary-button" disabled={disabled || busyMutation || (!!pending && !pendingTerm) || (!pendingTerm && (!targetAvailable || sourceMissing || !termDraft.source.trim() || !termDraft.target.trim() || !termDraft.reason.trim()))} onClick={() => void (pendingTerm ? retryPending() : owner.saveTerm())}>{pendingTerm ? t("resource.retry") : t("resource.save")}</button><button className="secondary-button" disabled={busyMutation || !termDirty || !!pending} onClick={() => owner.discardTerm()}>{t("resource.discardDraft")}</button></div>
              {selectedTerm ? <><p>{t("resource.provenance")}: {selectedTerm.originKind} · {selectedTerm.reason}</p><details><summary>{t("resource.history")}</summary><ul>{termHistory.map(revision => <li key={revision.revisionId}>{revision.source} → {revision.target} · {revision.reason}</li>)}</ul>{termHistory.length === 100 ? <button className="secondary-button" disabled={busy || !targetAvailable} onClick={() => void run(async current => { const more = await commands.termHistory({ ...session, termId: selectedTerm.termId, offset: termHistory.length, limit: 100 }); if (current()) setTermHistory([...termHistory, ...more]); })}>{t("execution.nextPage")}</button> : null}</details></> : null}
            </div>
          </section> : null}
          {tab === "updates" && locale ? <section><h3>{t("resource.resourceUpdates")}</h3><p>{t("resource.fileHelp")}</p><button className="primary-button" disabled={disabled || busyMutation || !!pending || !targetAvailable || !sourcePage || termDirty || contextDirty} onClick={() => void owner.chooseFile(currentView())}>{t("resource.chooseFile")}</button>
            {captures.length ? <div><h4>{t("resource.savedCaptures")}</h4><ul>{captures.filter(item => item.targetLocale === locale).map(item => <li key={item.captureId}><button className="text-button" disabled={busy || !!pending || !targetAvailable} onClick={() => void owner.openPreview(item, currentView())}>{item.resourceId} · {item.revision}</button></li>)}</ul></div> : null}
            {previewCapture && (!preview || previewNeedsRefresh) ? <p>{t("resource.previewUnavailable")} <button className="secondary-button" disabled={disabled || busyMutation || !!pending || !owner.localeAvailable(previewCapture.targetLocale)} onClick={() => void owner.retryPreview(currentView())}>{t("resource.retryPreview")}</button></p> : null}
            {preview ? <><p>{preview.capture.resourceId} · {preview.capture.revision} · {preview.capture.license} · {preview.capture.targetLocale} · {preview.capture.count}</p><details><summary>{t("resource.evidence")}</summary><code>{preview.capture.digest}</code></details>
              <p>{t("resource.previewHelp")}</p>
              <div className="source-table-scroll"><table className="source-table"><thead><tr><th>{t("resource.sourceTerm")}</th><th>{t("resource.currentValue")}</th><th>{t("resource.newValue")}</th><th>{t("resource.change")}</th><th>{t("resource.actions")}</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.entry.id}><th scope="row">{row.entry.source}<small> · {row.entry.nativeKey ?? t("resource.projectScope")}</small></th><td>{row.current?.target ?? "—"}</td><td>{row.entry.target}</td><td>{t(`resource.changeKind.${row.kind}`)}</td><td><button className="text-button" disabled={disabled || busy || previewNeedsRefresh || row.kind === "unchanged" || !!pending || !owner.localeAvailable(previewCapture?.targetLocale ?? "")} onClick={() => void refreshDecision(() => owner.decide(row.entry.id, row.current?.revisionId ?? null, row.kind === "override" ? "override" : "adopt"))}>{row.kind === "override" ? t("resource.setOverride") : t("resource.adopt")}</button><button className="text-button" disabled={disabled || busy || previewNeedsRefresh || !!pending || !owner.localeAvailable(previewCapture?.targetLocale ?? "")} onClick={() => void refreshDecision(() => owner.decide(row.entry.id, row.current?.revisionId ?? null, "keep"))}>{t("resource.keep")}</button><button className="text-button" disabled={disabled || busy || previewNeedsRefresh || !!pending || !owner.localeAvailable(previewCapture?.targetLocale ?? "")} onClick={() => void refreshDecision(() => owner.decide(row.entry.id, row.current?.revisionId ?? null, "ignore"))}>{t("resource.ignore")}</button></td></tr>)}</tbody></table></div>
              {preview.removed.length ? <><h4>{t("resource.removed")}</h4><ul>{preview.removed.map(term => <li key={term.termId}>{term.source} → {term.target}<button className="text-button" disabled={disabled || busy || previewNeedsRefresh || !!pending || !owner.localeAvailable(previewCapture?.targetLocale ?? "")} onClick={() => void refreshDecision(() => owner.decide(term.externalEntryId!, term.revisionId, "adopt"))}>{t("resource.adoptRemoval")}</button><button className="text-button" disabled={disabled || busy || previewNeedsRefresh || !!pending || !owner.localeAvailable(previewCapture?.targetLocale ?? "")} onClick={() => void refreshDecision(() => owner.decide(term.externalEntryId!, term.revisionId, "keep"))}>{t("resource.keep")}</button></li>)}</ul></> : null}
            </> : <p>{t("resource.noPreview")}</p>}
            {pendingDecision ? <div role="status"><p>{t("resource.uncertainAction")}</p><button className="secondary-button" disabled={disabled || busyMutation} onClick={() => void retryPending()}>{t("resource.retry")}</button></div> : null}
          </section> : null}
          {tab === "context" && locale ? <section><h3>{t("resource.contextAndMemory")}</h3><p>{t("resource.chooseUnit")}</p>{sourcePage ? <><div className="source-table-scroll"><ul>{sourceRows.map(row => <li key={row.occurrence.ordinal}><button className="text-button" disabled={busy || !!pending || !targetAvailable || !row.unitId} onClick={() => void run(current => selectUnit(row, current))}>{row.occurrence.key}</button></li>)}</ul></div><button className="secondary-button" disabled={busy || !targetAvailable || sourcePage.nextOrdinal === null} onClick={() => void run(async current => { const next = await sourceCommands.content({ ...session, snapshotId: sourcePage.snapshotId!, after: sourcePage.nextOrdinal!, limit: 50 }); if (current()) setSourcePage(next); })}>{t("execution.nextPage")}</button></> : null}
            {selectedUnit?.unitId && selectedUnit.sourceRevisionId ? <div className="translation-editor"><h4>{selectedUnit.occurrence.key}</h4><p>{selectedUnit.occurrence.text}</p>
              <label>{t("resource.manualContext")}<textarea value={contextDraft} onChange={event => owner.editContext(event.target.value)} /></label>
              <label>{t("resource.reason")}<input value={contextReason} onChange={event => owner.editContextReason(event.target.value)} /></label>
              <div className="execution-actions"><button className="primary-button" disabled={disabled || busyMutation || (!!pending && !pendingContext) || (!pendingContext && (!targetAvailable || !contextReason.trim()))} onClick={() => void (pendingContext ? retryPending() : owner.saveContext())}>{pendingContext ? t("resource.retry") : t("resource.saveContext")}</button><button className="secondary-button" disabled={busyMutation || !contextDirty || !!pending} onClick={() => owner.discardContext()}>{t("resource.discardDraft")}</button><button className="secondary-button" disabled={disabled || busyMutation || !!pending || !targetAvailable} onClick={() => void owner.captureContext()}>{t("resource.fixInput")}</button></div>
              {resolution ? <><h4>{t("resource.applicableTerms")}</h4>{resolution.entries.length ? <ul>{resolution.entries.map(entry => <li key={entry.source}>{entry.source}: {entry.selected ? entry.selected.target : t("resource.conflict")}</li>)}</ul> : <p>{t("resource.noApplicableTerms")}</p>}</> : null}
              {fixedContext ? <><h4>{t("resource.fixedInput")}</h4><ul>{fixedContext.included.map(item => <li key={item.revisionId}>{item.kind}: {item.text}</li>)}</ul>{fixedContext.omitted.length ? <><h5>{t("resource.omitted")}</h5><ul>{fixedContext.omitted.map((item, index) => <li key={index}>{item.kind}: {item.reference} · {item.reason}</li>)}</ul></> : null}</> : null}
              <h4>{t("resource.tm")}</h4><p>{t("resource.tmLimit")}</p>{suggestions.length ? <ul>{suggestions.map(item => <li key={item.translationRevisionId}><p>{item.sourceText} → {item.translationText}</p><p>{t(`resource.match.${item.matchKind}`)} · {item.scorePercent}% · {item.originKind === "manual" ? t("resource.manual") : t("resource.imported")} · {t("resource.noApproval")}</p><button className="secondary-button" disabled={busy || !!pending || !targetAvailable} onClick={() => openTranslation({ unitId: selectedUnit.unitId!, sourceRevisionId: selectedUnit.sourceRevisionId!, key: selectedUnit.occurrence.key, sourceText: selectedUnit.occurrence.text }, item.translationText)}>{t("resource.useAsDraft")}</button></li>)}</ul> : <p>{t("resource.noSuggestions")}</p>}
            </div> : null}
          </section> : null}
          {tab === "impact" && locale ? <section><div className="execution-section-heading"><h3>{t("resource.affectedWork")}</h3><button className="secondary-button" disabled={busy || !targetAvailable} onClick={() => void run(current => loadImpact(0, current))}>{t("resource.refresh")}</button></div>
            {impact ? <><p>{t("resource.affectedCount", { count: impact.totalAffected })}</p><p>{t("resource.coverage")}</p>{impact.items.length ? <ul>{impact.items.map(item => <li key={item.unitId}><h4>{item.nativeKey}</h4><p>{t(`resource.impactStatus.${item.status}`)}</p><ul>{item.reasons.map(reason => <li key={reason.changeId}>{t(`resource.reasonKind.${reason.kind}`)} · {reason.oldValue ?? "—"} → {reason.newRemoved ? t("resource.removedValue") : reason.newValue} · {t(`resource.confidence.${reason.confidence}`)}</li>)}</ul><button className="secondary-button" disabled={busy || !!pending || !targetAvailable} onClick={() => openTranslation({ unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, key: item.nativeKey, sourceText: item.sourceText })}>{t("resource.openTranslation")}</button></li>)}</ul> : <p>{t("resource.noImpacts")}</p>}<div className="execution-actions"><button className="secondary-button" disabled={busy || !targetAvailable || impactOffset === 0} onClick={() => void run(current => loadImpact(Math.max(0, impactOffset - 50), current))}>{t("execution.firstPage")}</button><button className="secondary-button" disabled={busy || !targetAvailable || impact.nextOffset === null} onClick={() => void run(current => loadImpact(impact.nextOffset!, current))}>{t("execution.nextPage")}</button></div></> : <p>{t("resource.loadImpact")}</p>}
          </section> : null}
        </div>
      </WorkbenchPanel>
    <Dialog.Root open={leavePrompt} onOpenChange={value => { if (!value && !busy) finishLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()}><Dialog.Title>{t("resource.leaveTitle")}</Dialog.Title><Dialog.Description>{t("resource.leaveHelp")}</Dialog.Description><div className="form-actions"><button className="secondary-button" onClick={() => finishLeave(false)}>{t("resource.stay")}</button><button className="primary-button" onClick={() => finishLeave(true)}>{t("resource.discardAndLeave")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
