import { hasUnknownOutcome } from "./projectCommands";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { CommandError, ProjectView } from "./projectCommands";
import { executionCommands, executionContext } from "./executionCommands";
import { sourceCommands, type ContentPage, type ContentRow } from "./sourceCommands";
import {
  resourceCommands as commands,
  type ContextCapture, type ContextRevision, type GlossaryCapture, type ImpactPage, type ResourceDecision,
  type ResourcePreview, type SaveContext, type SaveTerm, type TermResolution,
  type TermRevision, type TmSuggestion,
} from "./resourceCommands";
import type { EditorTarget } from "./TranslationWorkbench";

type Tab = "terms" | "updates" | "context" | "impact";
type TermDraft = Pick<SaveTerm, "source" | "aliases" | "target" | "protected" | "scopeUnitId" | "reason">;
const blankTerm = (): TermDraft => ({ source: "", aliases: [], target: "", protected: false, scopeUnitId: null, reason: "" });
const termDraftFor = (term: TermRevision | null): TermDraft => term
  ? { source: term.source, aliases: term.aliases, target: term.target, protected: term.protected, scopeUnitId: term.scopeUnitId, reason: term.reason }
  : blankTerm();
const stageOf = (error: unknown): string => {
  const value = error as Partial<CommandError> | null;
  return value?.field ?? value?.code ?? "failed";
};
const unknownOutcome = hasUnknownOutcome;

export interface ResourceHandle { allowLeave: () => Promise<boolean> }
export function ResourceWorkbench({
  project, disabled, onOpenTranslation, ref,
}: {
  project: ProjectView; disabled: boolean;
  onOpenTranslation: (target: EditorTarget, locale: string, suggestedText?: string) => boolean;
  ref?: Ref<ResourceHandle>;
}) {
  const { t } = useTranslation();
  const session = executionContext(project);
  const [open, setOpen] = useWorkbenchView("resources");
  const [tab, setTab] = useState<Tab>("terms");
  const [locale, setLocale] = useState(project.metadata.targetLocales[0] ?? "");
  const [sourcePage, setSourcePage] = useState<ContentPage | null>(null);
  const [sourceMissing, setSourceMissing] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState<ContentRow | null>(null);
  const [terms, setTerms] = useState<TermRevision[]>([]);
  const [selectedTerm, setSelectedTerm] = useState<TermRevision | null>(null);
  const [termDraft, setTermDraft] = useState<TermDraft>(blankTerm);
  const [aliasInput, setAliasInput] = useState("");
  const termDraftRef = useRef(termDraft);
  const [termHistory, setTermHistory] = useState<TermRevision[]>([]);
  const [pendingTerm, setPendingTerm] = useState<SaveTerm | null>(null);
  const [preview, setPreview] = useState<ResourcePreview | null>(null);
  const [captures, setCaptures] = useState<GlossaryCapture[]>([]);
  const [pendingDecision, setPendingDecision] = useState<ResourceDecision | null>(null);
  const [contextRevision, setContextRevision] = useState<ContextRevision | null>(null);
  const [contextDraft, setContextDraft] = useState("");
  const contextDraftRef = useRef("");
  const [contextReason, setContextReason] = useState("");
  const [pendingContext, setPendingContext] = useState<SaveContext | null>(null);
  const [resolution, setResolution] = useState<TermResolution | null>(null);
  const [fixedContext, setFixedContext] = useState<ContextCapture | null>(null);
  const [suggestions, setSuggestions] = useState<TmSuggestion[]>([]);
  const [impact, setImpact] = useState<ImpactPage | null>(null);
  const [impactOffset, setImpactOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const leaveResolver = useRef<((answer: boolean) => void) | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const running = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const termDirty = JSON.stringify(termDraft) !== JSON.stringify(termDraftFor(selectedTerm));
  const contextDirty = contextDraft !== (contextRevision?.text ?? "") || contextReason !== (contextRevision?.reason ?? "");

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      leaveResolver.current?.(false);
    };
  }, []);
  useEffect(() => { if (open) heading.current?.focus(); }, [open, tab]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const scope = await sourceCommands.scope(session);
        const page = scope.currentSnapshot
          ? await sourceCommands.content({ ...session, snapshotId: scope.currentSnapshot, after: 0, limit: 50 })
          : null;
        if (!cancelled) {
          setSourcePage(page); setSourceMissing(!page);
        }
      } catch (error) {
        if (!cancelled) setFailure(stageOf(error));
      }
    })();
    return () => { cancelled = true; };
  }, [open, project.sessionToken]);
  useEffect(() => {
    if (!open || !locale) return;
    let cancelled = false;
    void commands.terms({ ...session, locale, afterTermId: null, limit: 100 })
      .then(rows => { if (!cancelled) setTerms(rows); })
      .catch(error => { if (!cancelled) setFailure(stageOf(error)); });
    return () => { cancelled = true; };
  }, [open, locale, project.sessionToken]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void commands.captures({ ...session, limit: 100 })
      .then(rows => { if (!cancelled) setCaptures(rows); })
      .catch(error => { if (!cancelled) setFailure(stageOf(error)); });
    return () => { cancelled = true; };
  }, [open, project.sessionToken]);
  useImperativeHandle(ref, () => ({
    allowLeave() {
      if (running.current || pendingTerm || pendingContext || pendingDecision) {
        setOpen(true); setFailure("outcome-unknown"); return Promise.resolve(false);
      }
      if (!termDirty && !contextDirty) return Promise.resolve(true);
      setOpen(true); setLeavePrompt(true);
      return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
    },
  }));

  function updateTerm(next: TermDraft) { termDraftRef.current = next; setTermDraft(next); }
  function resetTerm(term: TermRevision | null) {
    updateTerm(termDraftFor(term));
    setAliasInput(term?.aliases.join(", ") ?? "");
  }
  function updateContext(text: string) { contextDraftRef.current = text; setContextDraft(text); }
  async function run(work: (current: () => boolean) => Promise<void>) {
    if (running.current) return;
    running.current = true;
    const ticket = ++generation.current;
    const current = () => alive.current && generation.current === ticket;
    setBusy(true); setFailure(null); setMessage(null);
    try { await work(current); }
    catch (error) { if (current()) setFailure(stageOf(error)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  function requestClose() {
    if (running.current || pendingTerm || pendingContext || pendingDecision) {
      setFailure("outcome-unknown"); return;
    }
    if (termDirty || contextDirty) { setLeavePrompt(true); return; }
    generation.current++; setOpen(false);
  }
  function finishLeave(discard: boolean) {
    setLeavePrompt(false);
    if (discard) {
      resetTerm(selectedTerm);
      updateContext(contextRevision?.text ?? "");
      setContextReason(contextRevision?.reason ?? "");
      if (leaveResolver.current) leaveResolver.current(true);
      else { generation.current++; setOpen(false); }
    } else leaveResolver.current?.(false);
    leaveResolver.current = null;
  }
  function switchLocale(next: string) {
    if (termDirty || contextDirty || pendingTerm || pendingContext) { setLeavePrompt(true); return; }
    generation.current++;
    setLocale(next); setSelectedTerm(null); resetTerm(null);
    setSelectedUnit(null); setContextRevision(null); updateContext(""); setContextReason("");
    setResolution(null); setSuggestions([]); setFixedContext(null); setImpact(null);
  }
  function selectTerm(term: TermRevision | null) {
    if (termDirty || pendingTerm) { setLeavePrompt(true); return; }
    setSelectedTerm(term); resetTerm(term); setTermHistory([]);
    if (term) void run(async current => {
      const rows = await commands.termHistory({ ...session, termId: term.termId, offset: 0, limit: 100 });
      if (current()) setTermHistory(rows);
    });
  }
  async function refreshTerms(current: () => boolean) {
    const rows = await commands.terms({ ...session, locale, afterTermId: null, limit: 100 });
    if (current()) setTerms(rows);
  }
  async function saveTerm(current: () => boolean) {
    const draft = termDraftRef.current;
    const request = pendingTerm ?? {
      projectId: session.projectId, actionId: await executionCommands.identity(session),
      termId: selectedTerm?.termId ?? null, locale, source: draft.source,
      aliases: draft.aliases, target: draft.target, protected: draft.protected,
      scopeUnitId: draft.scopeUnitId, expectedRevisionId: selectedTerm?.revisionId ?? null,
      reason: draft.reason,
    };
    if (!current()) return;
    setPendingTerm(request);
    try {
      const revision = await commands.saveTerm({ ...session, term: request });
      if (!current()) return;
      setPendingTerm(null); setSelectedTerm(revision);
      if (JSON.stringify(termDraftRef.current) === JSON.stringify(draft)) resetTerm(revision);
      await refreshTerms(current);
      if (current()) {
        setTermHistory(await commands.termHistory({ ...session, termId: revision.termId, offset: 0, limit: 100 }));
        setMessage(t("resource.saved"));
      }
    } catch (error) {
      if (current() && !unknownOutcome(error)) setPendingTerm(null);
      throw error;
    }
  }
  async function chooseFile(current: () => boolean) {
    const capture = await commands.chooseFile(session);
    if (!current() || !capture) return;
    const result = await commands.preview({ ...session, captureId: capture.captureId });
    if (current()) {
      setCaptures(previous => [capture, ...previous.filter(item => item.captureId !== capture.captureId)].slice(0, 100));
      setPreview(result); setTab("updates"); setMessage(t("resource.previewReady"));
    }
  }
  async function decide(entryId: string, expectedRevisionId: string | null, decision: ResourceDecision["decision"], current: () => boolean) {
    const request = pendingDecision ?? {
      projectId: session.projectId,
      actionId: await executionCommands.identity(session),
      captureId: preview!.capture.captureId, entryId, expectedRevisionId, decision,
    };
    if (!current()) return;
    setPendingDecision(request);
    try {
      await commands.decide({ ...session, decision: request });
      if (!current()) return;
      setPendingDecision(null);
      const next = await commands.preview({ ...session, captureId: request.captureId });
      if (current()) { setPreview(next); await refreshTerms(current); setMessage(t("resource.decisionSaved")); }
    } catch (error) {
      if (current() && !unknownOutcome(error)) setPendingDecision(null);
      throw error;
    }
  }
  async function selectUnit(row: ContentRow, current: () => boolean) {
    if (contextDirty || pendingContext) { setLeavePrompt(true); return; }
    if (!row.unitId) return;
    const [manual, terms, tm] = await Promise.all([
      commands.context({ ...session, unitId: row.unitId, locale }),
      commands.resolve({ ...session, unitId: row.unitId, locale }),
      commands.suggestions({ ...session, unitId: row.unitId, locale, offset: 0, limit: 20 }),
    ]);
    if (current()) {
      setSelectedUnit(row); setContextRevision(manual); updateContext(manual?.text ?? "");
      setContextReason(manual?.reason ?? ""); setResolution(terms); setSuggestions(tm);
      setFixedContext(null);
    }
  }
  async function saveContext(current: () => boolean) {
    if (!selectedUnit?.unitId || !selectedUnit.sourceRevisionId) return;
    const submitted = contextDraftRef.current;
    const reason = contextReason;
    const request = pendingContext ?? {
      projectId: session.projectId, actionId: await executionCommands.identity(session),
      unitId: selectedUnit.unitId, locale, sourceRevisionId: selectedUnit.sourceRevisionId,
      expectedRevisionId: contextRevision?.revisionId ?? null, text: submitted, reason,
    };
    if (!current()) return;
    setPendingContext(request);
    try {
      const saved = await commands.saveContext({ ...session, context: request });
      if (!current()) return;
      setPendingContext(null); setContextRevision(saved);
      if (contextDraftRef.current === submitted) updateContext(saved.text);
      if (contextReason === reason) setContextReason(saved.reason);
      setMessage(t("resource.saved"));
    } catch (error) {
      if (current() && !unknownOutcome(error)) setPendingContext(null);
      throw error;
    }
  }
  async function fixContext(current: () => boolean) {
    if (!selectedUnit?.unitId || !selectedUnit.sourceRevisionId) return;
    const capture = await commands.captureContext({
      ...session,
      capture: {
        projectId: session.projectId, actionId: await executionCommands.identity(session),
        unitId: selectedUnit.unitId, locale,
        sourceRevisionId: selectedUnit.sourceRevisionId, budgetBytes: 16 * 1024,
      },
    });
    if (current()) setFixedContext(capture);
  }
  async function loadImpact(offset: number, current: () => boolean) {
    const next = await commands.impacts({ ...session, locale, offset, limit: 50 });
    if (current()) { setImpact(next); setImpactOffset(offset); }
  }
  function openTranslation(target: EditorTarget, suggestion?: string) {
    if (termDirty || contextDirty) { setLeavePrompt(true); return; }
    if (onOpenTranslation(target, locale, suggestion)) { generation.current++; setOpen(false); }
    else setFailure("translation-draft");
  }
  const sourceRows = sourcePage?.rows ?? [];
  return <>
    <WorkbenchPanel open={open} title={t("resource.title")} description={t("resource.description")} className="source-dialog" onBack={requestClose} backDisabled={disabled || busy}>
        <div className="execution-content" aria-busy={busy}>
          {failure ? <p role="alert">{t("resource.error", { reason: t(`resource.errors.${failure}`, { defaultValue: failure }) })}</p> : null}
          {message ? <p role="status">{message}</p> : null}
          {busy ? <p role="status">{t("execution.working")}</p> : null}
          <label>{t("resource.targetLocale")}<select value={locale} disabled={busy} onChange={event => switchLocale(event.target.value)}>{project.metadata.targetLocales.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          {!locale ? <p>{t("resource.noLocale")}</p> : null}
          {sourceMissing ? <p>{t("resource.noSource")}</p> : null}
          <div className="execution-actions" role="tablist" aria-label={t("resource.title")}>
            {(["terms", "updates", "context", "impact"] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "primary-button" : "secondary-button"} onClick={() => { setTab(value); if (value === "impact") void run(current => loadImpact(0, current)); }}>{t(`resource.tabs.${value}`)}</button>)}
          </div>
          {tab === "terms" && locale ? <section>
            <div className="execution-section-heading"><h3>{t("resource.currentTerms")}</h3><button className="secondary-button" disabled={busy || termDirty} onClick={() => selectTerm(null)}>{t("resource.newTerm")}</button></div>
            {terms.length ? <ul>{terms.filter(term => !term.removed).map(term => <li key={term.termId}><button className="text-button" disabled={busy} onClick={() => selectTerm(term)}>{term.source} → {term.target}</button> <small>{term.scopeUnitId ? t("resource.unitScope") : t("resource.projectScope")} · {term.originKind === "manual" ? t("resource.manual") : t("resource.external")}</small></li>)}</ul> : <p>{t("resource.noTerms")}</p>}
            {terms.length === 100 ? <button className="secondary-button" disabled={busy} onClick={() => void run(async current => { const more = await commands.terms({ ...session, locale, afterTermId: terms.at(-1)!.termId, limit: 100 }); if (current()) setTerms([...terms, ...more]); })}>{t("execution.nextPage")}</button> : null}
            <div className="translation-editor">
              <h4>{selectedTerm ? t("resource.editTerm") : t("resource.newTerm")}</h4>
              <label>{t("resource.sourceTerm")}<input value={termDraft.source} onChange={event => updateTerm({ ...termDraftRef.current, source: event.target.value })} /></label>
              <label>{t("resource.aliases")}<input value={aliasInput} onChange={event => { const value = event.target.value; setAliasInput(value); updateTerm({ ...termDraftRef.current, aliases: value.split(",").map(alias => alias.trim()).filter(Boolean) }); }} /></label>
              <label>{t("resource.targetTerm")}<input value={termDraft.target} onChange={event => updateTerm({ ...termDraftRef.current, target: event.target.value })} /></label>
              <label>{t("resource.scope")}<select value={termDraft.scopeUnitId ?? ""} onChange={event => updateTerm({ ...termDraftRef.current, scopeUnitId: event.target.value || null })}><option value="">{t("resource.projectScope")}</option>{termDraft.scopeUnitId && !sourceRows.some(row => row.unitId === termDraft.scopeUnitId) ? <option value={termDraft.scopeUnitId}>{t("resource.currentUnit")}</option> : null}{sourceRows.filter(row => row.unitId).map(row => <option key={row.unitId!} value={row.unitId!}>{row.occurrence.key}</option>)}</select></label>
              {sourcePage ? <div className="execution-actions"><button className="secondary-button" disabled={busy} onClick={() => void run(async current => { const first = await sourceCommands.content({ ...session, snapshotId: sourcePage.snapshotId!, after: 0, limit: 50 }); if (current()) setSourcePage(first); })}>{t("execution.firstPage")}</button><button className="secondary-button" disabled={busy || sourcePage.nextOrdinal === null} onClick={() => void run(async current => { const next = await sourceCommands.content({ ...session, snapshotId: sourcePage.snapshotId!, after: sourcePage.nextOrdinal!, limit: 50 }); if (current()) setSourcePage(next); })}>{t("execution.nextPage")}</button></div> : null}
              <label className="source-check"><input type="checkbox" checked={termDraft.protected} onChange={event => updateTerm({ ...termDraftRef.current, protected: event.target.checked })} />{t("resource.protected")}</label>
              <label>{t("resource.reason")}<input value={termDraft.reason} onChange={event => updateTerm({ ...termDraftRef.current, reason: event.target.value })} /></label>
              <div className="execution-actions"><button className="primary-button" disabled={busy || !locale || !sourcePage || !termDraft.source.trim() || !termDraft.target.trim() || !termDraft.reason.trim()} onClick={() => void run(saveTerm)}>{pendingTerm ? t("resource.retry") : t("resource.save")}</button><button className="secondary-button" disabled={busy || !termDirty || !!pendingTerm} onClick={() => resetTerm(selectedTerm)}>{t("resource.discardDraft")}</button></div>
              {selectedTerm ? <><p>{t("resource.provenance")}: {selectedTerm.originKind} · {selectedTerm.reason}</p><details><summary>{t("resource.history")}</summary><ul>{termHistory.map(revision => <li key={revision.revisionId}>{revision.source} → {revision.target} · {revision.reason}</li>)}</ul>{termHistory.length === 100 ? <button className="secondary-button" disabled={busy} onClick={() => void run(async current => { const more = await commands.termHistory({ ...session, termId: selectedTerm.termId, offset: termHistory.length, limit: 100 }); if (current()) setTermHistory([...termHistory, ...more]); })}>{t("execution.nextPage")}</button> : null}</details></> : null}
            </div>
          </section> : null}
          {tab === "updates" && locale ? <section><h3>{t("resource.resourceUpdates")}</h3><p>{t("resource.fileHelp")}</p><button className="primary-button" disabled={busy || !sourcePage || termDirty || contextDirty} onClick={() => void run(chooseFile)}>{t("resource.chooseFile")}</button>
            {captures.length ? <div><h4>{t("resource.savedCaptures")}</h4><ul>{captures.filter(item => item.targetLocale === locale).map(item => <li key={item.captureId}><button className="text-button" disabled={busy} onClick={() => void run(async current => { const result = await commands.preview({ ...session, captureId: item.captureId }); if (current()) setPreview(result); })}>{item.resourceId} · {item.revision}</button></li>)}</ul></div> : null}
            {preview ? <><p>{preview.capture.resourceId} · {preview.capture.revision} · {preview.capture.license} · {preview.capture.targetLocale} · {preview.capture.count}</p><details><summary>{t("resource.evidence")}</summary><code>{preview.capture.digest}</code></details>
              <p>{t("resource.previewHelp")}</p>
              <div className="source-table-scroll"><table className="source-table"><thead><tr><th>{t("resource.sourceTerm")}</th><th>{t("resource.currentValue")}</th><th>{t("resource.newValue")}</th><th>{t("resource.change")}</th><th>{t("resource.actions")}</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.entry.id}><th scope="row">{row.entry.source}<small> · {row.entry.nativeKey ?? t("resource.projectScope")}</small></th><td>{row.current?.target ?? "—"}</td><td>{row.entry.target}</td><td>{t(`resource.changeKind.${row.kind}`)}</td><td><button className="text-button" disabled={busy || row.kind === "unchanged" || !!pendingDecision} onClick={() => void run(current => decide(row.entry.id, row.current?.revisionId ?? null, row.kind === "override" ? "override" : "adopt", current))}>{row.kind === "override" ? t("resource.setOverride") : t("resource.adopt")}</button><button className="text-button" disabled={busy || !!pendingDecision} onClick={() => void run(current => decide(row.entry.id, row.current?.revisionId ?? null, "keep", current))}>{t("resource.keep")}</button><button className="text-button" disabled={busy || !!pendingDecision} onClick={() => void run(current => decide(row.entry.id, row.current?.revisionId ?? null, "ignore", current))}>{t("resource.ignore")}</button></td></tr>)}</tbody></table></div>
              {preview.removed.length ? <><h4>{t("resource.removed")}</h4><ul>{preview.removed.map(term => <li key={term.termId}>{term.source} → {term.target}<button className="text-button" disabled={busy || !!pendingDecision} onClick={() => void run(current => decide(term.externalEntryId!, term.revisionId, "adopt", current))}>{t("resource.adoptRemoval")}</button><button className="text-button" disabled={busy || !!pendingDecision} onClick={() => void run(current => decide(term.externalEntryId!, term.revisionId, "keep", current))}>{t("resource.keep")}</button></li>)}</ul></> : null}
            </> : <p>{t("resource.noPreview")}</p>}
            {pendingDecision ? <div role="status"><p>{t("resource.uncertainAction")}</p><button className="secondary-button" disabled={busy} onClick={() => void run(current => decide(pendingDecision.entryId, pendingDecision.expectedRevisionId, pendingDecision.decision, current))}>{t("resource.retry")}</button></div> : null}
          </section> : null}
          {tab === "context" && locale ? <section><h3>{t("resource.contextAndMemory")}</h3><p>{t("resource.chooseUnit")}</p>{sourcePage ? <><div className="source-table-scroll"><ul>{sourceRows.map(row => <li key={row.occurrence.ordinal}><button className="text-button" disabled={busy || !row.unitId} onClick={() => void run(current => selectUnit(row, current))}>{row.occurrence.key}</button></li>)}</ul></div><button className="secondary-button" disabled={busy || sourcePage.nextOrdinal === null} onClick={() => void run(async current => { const next = await sourceCommands.content({ ...session, snapshotId: sourcePage.snapshotId!, after: sourcePage.nextOrdinal!, limit: 50 }); if (current()) setSourcePage(next); })}>{t("execution.nextPage")}</button></> : null}
            {selectedUnit?.unitId && selectedUnit.sourceRevisionId ? <div className="translation-editor"><h4>{selectedUnit.occurrence.key}</h4><p>{selectedUnit.occurrence.text}</p>
              <label>{t("resource.manualContext")}<textarea value={contextDraft} onChange={event => updateContext(event.target.value)} /></label>
              <label>{t("resource.reason")}<input value={contextReason} onChange={event => setContextReason(event.target.value)} /></label>
              <div className="execution-actions"><button className="primary-button" disabled={busy || !contextReason.trim()} onClick={() => void run(saveContext)}>{pendingContext ? t("resource.retry") : t("resource.saveContext")}</button><button className="secondary-button" disabled={busy || !contextDirty || !!pendingContext} onClick={() => { updateContext(contextRevision?.text ?? ""); setContextReason(contextRevision?.reason ?? ""); }}>{t("resource.discardDraft")}</button><button className="secondary-button" disabled={busy} onClick={() => void run(fixContext)}>{t("resource.fixInput")}</button></div>
              {resolution ? <><h4>{t("resource.applicableTerms")}</h4>{resolution.entries.length ? <ul>{resolution.entries.map(entry => <li key={entry.source}>{entry.source}: {entry.selected ? entry.selected.target : t("resource.conflict")}</li>)}</ul> : <p>{t("resource.noApplicableTerms")}</p>}</> : null}
              {fixedContext ? <><h4>{t("resource.fixedInput")}</h4><ul>{fixedContext.included.map(item => <li key={item.revisionId}>{item.kind}: {item.text}</li>)}</ul>{fixedContext.omitted.length ? <><h5>{t("resource.omitted")}</h5><ul>{fixedContext.omitted.map((item, index) => <li key={index}>{item.kind}: {item.reference} · {item.reason}</li>)}</ul></> : null}</> : null}
              <h4>{t("resource.tm")}</h4><p>{t("resource.tmLimit")}</p>{suggestions.length ? <ul>{suggestions.map(item => <li key={item.translationRevisionId}><p>{item.sourceText} → {item.translationText}</p><p>{t(`resource.match.${item.matchKind}`)} · {item.scorePercent}% · {item.originKind === "manual" ? t("resource.manual") : t("resource.imported")} · {t("resource.noApproval")}</p><button className="secondary-button" disabled={busy} onClick={() => openTranslation({ unitId: selectedUnit.unitId!, sourceRevisionId: selectedUnit.sourceRevisionId!, key: selectedUnit.occurrence.key, sourceText: selectedUnit.occurrence.text }, item.translationText)}>{t("resource.useAsDraft")}</button></li>)}</ul> : <p>{t("resource.noSuggestions")}</p>}
            </div> : null}
          </section> : null}
          {tab === "impact" && locale ? <section><div className="execution-section-heading"><h3>{t("resource.affectedWork")}</h3><button className="secondary-button" disabled={busy} onClick={() => void run(current => loadImpact(0, current))}>{t("resource.refresh")}</button></div>
            {impact ? <><p>{t("resource.affectedCount", { count: impact.totalAffected })}</p><p>{t("resource.coverage")}</p>{impact.items.length ? <ul>{impact.items.map(item => <li key={item.unitId}><h4>{item.nativeKey}</h4><p>{t(`resource.impactStatus.${item.status}`)}</p><ul>{item.reasons.map(reason => <li key={reason.changeId}>{t(`resource.reasonKind.${reason.kind}`)} · {reason.oldValue ?? "—"} → {reason.newRemoved ? t("resource.removedValue") : reason.newValue} · {t(`resource.confidence.${reason.confidence}`)}</li>)}</ul><button className="secondary-button" disabled={busy} onClick={() => openTranslation({ unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, key: item.nativeKey, sourceText: item.sourceText })}>{t("resource.openTranslation")}</button></li>)}</ul> : <p>{t("resource.noImpacts")}</p>}<div className="execution-actions"><button className="secondary-button" disabled={busy || impactOffset === 0} onClick={() => void run(current => loadImpact(Math.max(0, impactOffset - 50), current))}>{t("execution.firstPage")}</button><button className="secondary-button" disabled={busy || impact.nextOffset === null} onClick={() => void run(current => loadImpact(impact.nextOffset!, current))}>{t("execution.nextPage")}</button></div></> : <p>{t("resource.loadImpact")}</p>}
          </section> : null}
        </div>
      </WorkbenchPanel>
    <Dialog.Root open={leavePrompt} onOpenChange={value => { if (!value && !busy) finishLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()}><Dialog.Title>{t("resource.leaveTitle")}</Dialog.Title><Dialog.Description>{t("resource.leaveHelp")}</Dialog.Description><div className="form-actions"><button className="secondary-button" onClick={() => finishLeave(false)}>{t("resource.stay")}</button><button className="primary-button" onClick={() => finishLeave(true)}>{t("resource.discardAndLeave")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
