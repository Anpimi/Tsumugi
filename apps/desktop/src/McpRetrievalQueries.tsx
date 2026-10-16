import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbenchState } from "./WorkbenchFrame";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { executionCommands, executionContext } from "./executionCommands";
import { readCompleteAttempt } from "./executionRead";
import { retrievalKey } from "./McpRetrievalSession";
import { retrievalOutput, type McpRetrievalView } from "./mcpRetrievalCommands";
import { CommandFailureDetails, commandFailure, failureReason, type CommandFailure } from "./CommandFailure";
import type { PluginToolQuerySession } from "./PluginToolQuerySession";
import type { ContentPage } from "./sourceCommands";
import type { GlossaryCapture } from "./resourceCommands";
import type { ProjectView } from "./projectCommands";

export function validRetrievalEndpoint(value: string) { try { const url = new URL(value);
  return !url.username && !url.password && !value.includes("?") && !value.includes("#") && !/[\s\u0000-\u001f\u007f-\u009f]/.test(value)
    && new TextEncoder().encode(value).byteLength <= 2048 && (url.protocol === "https:" || url.protocol === "http:"
      && (url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)));
} catch { return false; } }
/** All automatic reads below address local records. Only explicit commands contact the service. */
export function McpRetrievalQueries({ project, session, open, disabled, sourcePage, sourceCurrent, onSourcePage, onOpenCapture }: {
  project: ProjectView; session: PluginToolQuerySession; open: boolean; disabled: boolean; sourcePage: ContentPage | null; sourceCurrent: () => boolean;
  onSourcePage: (after: number) => void; onOpenCapture: (capture: GlossaryCapture) => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation(), reads = useSessionReads(), owner = session.mcp, state = owner.state, raw = session.state, context = executionContext(project);
  const [discoveryConsent, setDiscoveryConsent] = useState(false), [handoffBlocked, setHandoffBlocked] = useState(false), heading = useRef<HTMLHeadingElement>(null);
  const operation = state.operation, identity = operation?.discovery.discovery.identity;
  const [visible, setVisible] = useState(document.visibilityState !== "hidden"), polls = useRef(0);
  const snapshot = useCallback(() => identity ? reads.client.getQueryData<McpRetrievalView>(reads.key(retrievalKey(identity))) : undefined, [reads, identity?.generation, identity?.actionId]);
  const subscribe = useCallback((notify: () => void) => reads.client.getQueryCache().subscribe(notify), [reads]);
  const view = useSyncExternalStore(subscribe, snapshot);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setDiscoveryConsent(false); }, [raw.endpoint, raw.credentialEnv]);
  useEffect(() => { if (open) heading.current?.focus({ preventScroll: true }); }, [open, identity?.actionId]);
  useEffect(() => { const update = () => setVisible(document.visibilityState !== "hidden"); document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update); }, []);
  useEffect(() => { polls.current = 0; }, [identity?.actionId]);
  useEffect(() => { if (open && identity && !view && !state.readFailure) void owner.read(); }, [open, identity?.actionId]);
  useEffect(() => {
    if (!open || !visible || !identity || state.reading || state.readFailure || view?.error || reads.retired || polls.current >= 130
      || !(view?.phase === "discovering" || view?.phase === "enqueued" || view?.admissionClosed && !view.callbacksDrained)) return;
    const timer = window.setTimeout(() => { polls.current++; void owner.read(); }, 1000); return () => window.clearTimeout(timer);
  }, [open, visible, identity?.actionId, state.reading, state.readFailure, view?.phase, view?.admissionClosed, view?.callbacksDrained, view?.error, reads]);
  useEffect(() => { const expiry = operation?.discovery.discovery.expiresAtMs; if (!open || !expiry) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, expiry - Date.now() + 1)); return () => window.clearTimeout(timer);
  }, [open, operation?.discovery]);
  const unit = raw.retrievalUnit, selected = sourcePage?.rows.find(row => unit !== null && row.unitId === unit.unitId && row.sourceRevisionId === unit.sourceRevisionId);
  const target = raw.target;
  const query = raw.rows.length === 1 ? raw.rows[0].text : "";
  function inputCurrent() { const current = session.current(), selected = current.retrievalUnit;
    return open && !disabled && !reads.retired && sourceCurrent() && !!selected && sourcePage?.snapshotId === selected.sourceSnapshotId
      && sourcePage.scope.currentSnapshot === selected.sourceSnapshotId && sourcePage.rows.some(row => row.unitId === selected.unitId && row.sourceRevisionId === selected.sourceRevisionId
        && current.rows.length === 1 && !!current.rows[0].text.trim() && row.occurrence.text.includes(current.rows[0].text))
      && (!operation?.preview || operation.preview.basis.unitId === selected.unitId && operation.preview.basis.sourceSnapshotId === selected.sourceSnapshotId
        && operation.preview.basis.sourceRevisionId === selected.sourceRevisionId && operation.preview.basis.locale === current.target
        && operation.preview.basis.sourceLocale === project.metadata.sourceLocale)
      && project.metadata.targetLocales.includes(current.target) && new TextEncoder().encode(current.rows[0].text).byteLength <= 16_384;
  }
  const endpointValid = validRetrievalEndpoint(raw.endpoint), credentialValid = raw.credentialEnv === "" || raw.credentialEnv.length <= 128 && /^TSUMUGI_MCP_CLIENT_[A-Z0-9_]+$/.test(raw.credentialEnv);
  const expired = !!operation && operation.discovery.discovery.expiresAtMs <= now;
  const preview = operation?.preview;
  const changed = state.stale || !!operation?.query && operation.seq !== session.draftSequence.current;
  const tools = view?.tools ?? [], selectedTool = tools.find(tool => tool.toolName === raw.mcpToolName);
  const [historyOpen, setHistoryOpen] = useWorkbenchState("resources", "mcpHistoryOpen", false);
  const [historyAfter, setHistoryAfter] = useWorkbenchState("resources", "mcpHistoryAfter", "0");
  const [historyTask, setHistoryTask] = useWorkbenchState<string | null>("resources", "mcpHistoryTask", null);
  const [attemptAfter, setAttemptAfter] = useWorkbenchState("resources", "mcpAttemptAfter", "0");
  const [historical, setHistorical] = useWorkbenchState<{ taskId: string; attemptId: string } | null>("resources", "mcpHistoryAttempt", null);
  const history = useSessionQuery({ key: ["mcp-retrieval-history", historyAfter], scopes: ["execution"], enabled: open && historyOpen,
    read: () => executionCommands.list({ ...context, after: historyAfter, limit: 50 }) });
  const attempts = useSessionQuery({ key: ["mcp-retrieval-attempt-history", historyTask, attemptAfter], scopes: ["execution"], enabled: open && historyOpen && !!historyTask,
    read: () => executionCommands.task({ ...context, taskId: historyTask!, after: attemptAfter, limit: 50 }) });
  const liveAttempt = view?.task ?? (operation?.start && operation.query ? { taskId: operation.query.query.taskId, attemptId: operation.query.query.attemptId } : null), shown = historical ?? liveAttempt;
  const attemptId = shown?.attemptId ?? null;
  const detail = useSessionQuery({ key: ["mcp-retrieval-attempt", attemptId], scopes: ["execution"], enabled: open && !!attemptId,
    read: async () => { if (!attemptId || !shown) return null; const value = await readCompleteAttempt(context, attemptId, "mcp-term-query");
      if (value && (value.taskId !== shown.taskId || value.items.length !== 1 || value.nextOffset !== null)) throw new Error("MCP retrieval task association changed"); return value; } });
  const resultId = detail.data?.items[0]?.resultId ?? null;
  const output = useSessionQuery({ key: ["mcp-retrieval-output", attemptId, resultId], scopes: ["execution"], enabled: open && !!attemptId && !!resultId,
    read: async () => { const value = await executionCommands.output({ ...context, attemptId: attemptId!, resultId: resultId! });
      if (value.projectId !== context.projectId || value.attemptId !== attemptId || value.resultId !== resultId) throw new Error("MCP retrieval output association changed"); return value; } });
  const result = detail.data ? retrievalOutput(output.data ?? null, detail.data, historical ? null : preview ?? null) : null;
  function resultCurrent() { const detailState = reads.client.getQueryState(reads.key(["mcp-retrieval-attempt", attemptId]));
    const outputState = reads.client.getQueryState(reads.key(["mcp-retrieval-output", attemptId, resultId]));
    return open && !disabled && !reads.retired && result !== null && detailState?.status === "success" && detailState.fetchStatus === "idle"
      && !detailState.isInvalidated && detailState.error === null && detailState.data === detail.data && outputState?.status === "success" && outputState.fetchStatus === "idle"
      && !outputState.isInvalidated && outputState.error === null && outputState.data === output.data;
  }
  const working = !!detail.data?.items.some(item => item.status.execution === "queued" || item.status.execution === "dispatched");
  const detailPolls = useRef(0); useEffect(() => { detailPolls.current = 0; }, [attemptId]);
  useEffect(() => { if (!open || !visible || !working || detail.error || detail.isFetching || detailPolls.current >= 130) return;
    const timer = window.setTimeout(() => { detailPolls.current++; void detail.refetch(); }, 1000); return () => window.clearTimeout(timer);
  }, [open, visible, working, detail.error, detail.isFetching, detail.data]);
  const captured = state.capture?.value;
  function recovery(failure: CommandFailure) { const reason = failureReason(failure);
    if (reason === "mcp-query-source" || reason === "mcp-query-text") return <p>{t("mcpRetrieval.sourceRecovery")}</p>;
    if (reason === "mcp-query-stale") return <p>{t("mcpRetrieval.staleRecovery")}</p>;
    if (reason === "mcp-query-deadline" || reason === "mcp-query-permit") return <p>{t("mcpRetrieval.expired")}</p>;
    return null;
  }
  async function openCapture() { if (!captured) return; const accepted = await onOpenCapture(captured); if (!accepted) setHandoffBlocked(true); }
  return <section hidden={!open} aria-labelledby="mcp-retrieval-heading">
    <h3 ref={heading} id="mcp-retrieval-heading" tabIndex={-1}>{t("mcpRetrieval.title")}</h3><p>{t("mcpRetrieval.help")}</p>
    <label className="source-field">{t("mcpRetrieval.endpoint")}<input value={raw.endpoint} disabled={disabled} onChange={event => session.editMcp({ endpoint: event.target.value })} aria-invalid={raw.endpoint !== "" && !endpointValid}/></label>
    {raw.endpoint && !endpointValid ? <p role="alert">{t("mcpRetrieval.invalidEndpoint")}</p> : null}
    <label className="source-field">{t("mcpRetrieval.credentialEnv")}<input value={raw.credentialEnv} disabled={disabled} onChange={event => session.editMcp({ credentialEnv: event.target.value })} aria-invalid={!credentialValid}/></label>
    <p>{t("mcpRetrieval.credentialHelp")}</p>{!credentialValid ? <p role="alert">{t("mcpRetrieval.invalidCredential")}</p> : null}
    <p>{t("mcpRetrieval.discoveryHelp")}</p><label className="source-check"><input type="checkbox" checked={discoveryConsent} disabled={disabled || !!operation}
      onChange={event => setDiscoveryConsent(event.target.checked)}/>{t("mcpRetrieval.discoveryConsent")}</label>
    <button type="button" className="primary-button" disabled={disabled || !!operation || !!state.busy || !endpointValid || !credentialValid || !discoveryConsent}
      onClick={() => { setHistorical(null); void owner.discover(); }}>{t("mcpRetrieval.discover")}</button>
    {state.busy === "discovery" && !operation ? <button type="button" onClick={() => owner.endLocalPreparationWait()}>{t("mcpRetrieval.endPreparationWait")}</button> : null}
    <label className="source-field">{t("mcpRetrieval.tool")}<select value={raw.mcpToolName} disabled={disabled} onChange={event => session.editMcp({ mcpToolName: event.target.value })}>
      <option value="">{t("mcpRetrieval.chooseTool")}</option>{tools.map(tool => <option value={tool.toolName} key={tool.toolName}>{tool.toolName}</option>)}
    </select></label>
    {view?.phase === "ready" && tools.length === 0 ? <p role="status">{t("mcpRetrieval.noTools")}</p> : null}
    {selectedTool ? <details><summary>{t("mcpRetrieval.description")}</summary><pre>{selectedTool.serverName} · {selectedTool.serverVersion} · {selectedTool.protocolVersion}</pre>
      <pre>{selectedTool.description ?? ""}</pre><pre>{JSON.stringify(selectedTool.inputSchema, null, 2)}</pre><pre>{JSON.stringify(selectedTool.outputSchema, null, 2)}</pre></details> : null}
    <p>{t("mcpRetrieval.profile")}</p><p>{t("mcpRetrieval.limits")}</p>
    <label className="source-field">{t("mcpRetrieval.unit")}<select value={unit?.unitId ?? ""} disabled={disabled || !sourceCurrent()} onChange={event => {
      const row = sourcePage?.rows.find(row => row.unitId === event.target.value); if (!event.target.value) session.editMcp({ retrievalUnit: null });
      else if (row?.unitId && row.sourceRevisionId && sourcePage?.snapshotId) session.editMcp({ retrievalUnit: { unitId: row.unitId, sourceRevisionId: row.sourceRevisionId, sourceSnapshotId: sourcePage.snapshotId, label: row.occurrence.key } });
    }}><option value="">{t("mcpRetrieval.chooseUnit")}</option>{unit && !selected ? <option value={unit.unitId} disabled>{unit.label}</option> : null}
      {Array.from(new Map(sourcePage?.rows.filter(row => row.unitId && row.sourceRevisionId).map(row => [row.unitId!, row])).values()).map(row => <option key={row.unitId!} value={row.unitId!}>{row.occurrence.key}</option>)}</select></label>
    {sourcePage ? <div className="execution-actions"><button type="button" disabled={disabled || sourcePage.rows[0]?.occurrence.ordinal === 0} onClick={() => onSourcePage(0)}>{t("execution.firstPage")}</button>
      <button type="button" disabled={disabled || sourcePage.nextOrdinal === null} onClick={() => { if (sourcePage.nextOrdinal !== null) onSourcePage(sourcePage.nextOrdinal); }}>{t("execution.nextPage")}</button></div> : null}
    <label className="source-field">{t("mcpRetrieval.locale")}<select value={target} disabled={disabled} onChange={event => { session.setTarget(event.target.value); session.edit(); }}>
      <option value="">{t("mcpRetrieval.chooseLocale")}</option>{target && !project.metadata.targetLocales.includes(target) ? <option value={target} disabled>{target}</option> : null}
      {project.metadata.targetLocales.map(locale => <option key={locale} value={locale}>{locale}</option>)}</select></label>
    <p>{t("mcpRetrieval.queryHelp")}</p>
    {raw.rows.map((row, index) => <div key={row.id}><label className="source-field">{t("mcpRetrieval.query", { position: String(index + 1) })}<textarea value={row.text} disabled={disabled} rows={3}
      onChange={event => { session.setRows(rows => rows.map(value => value.id === row.id ? { ...value, text: event.target.value } : value)); session.edit(); }}/></label>
      {raw.rows.length > 1 ? <button type="button" disabled={disabled} onClick={() => { session.setRows(rows => rows.filter(value => value.id !== row.id)); session.edit(); }}>{t("toolQuery.remove", { position: String(index + 1) })}</button> : null}</div>)}
    <button type="button" disabled={disabled || !selected || !sourceCurrent() || raw.rows.length !== 1} onClick={() => { if (selected) { session.setRows(rows => rows.map(row => ({ ...row, text: selected.occurrence.text }))); session.edit(); } }}>{t("mcpRetrieval.useSource")}</button>
    {(query || unit) && !inputCurrent() ? <p role="status">{t("mcpRetrieval.invalidInput")}</p> : null}
    <button type="button" className="primary-button" disabled={disabled || !operation || !!operation.query || !!operation.unknown || operation.closed || !!state.busy || expired || !selectedTool || !inputCurrent()}
      onClick={() => { void owner.prepare(inputCurrent); }}>{t("mcpRetrieval.preview")}</button>
    {operation ? <section aria-label={t("mcpRetrieval.original")}><h4>{t("mcpRetrieval.original")}</h4>
      <p>{t("mcpRetrieval.destination")}</p><pre>{operation.discovery.discovery.endpoint}</pre>
      <p>{t("mcpRetrieval.credentialEnv")} · {operation.discovery.discovery.credentialEnv ?? t("mcpRetrieval.withoutCredential")}</p>
      <p>{t("mcpRetrieval.expiry", { expiry: new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "medium" }).format(operation.discovery.discovery.expiresAtMs) })}</p>
      {state.busy ? <p role="status">{t(state.busy === "discovery" ? "mcpRetrieval.discovering" : state.busy === "start" ? "mcpRetrieval.starting" : "mcpRetrieval.prepareHelp")}</p> : null}
      {view ? <p role="status">{t("mcpRetrieval.status", { phase: t(`mcpRetrieval.phases.${view.phase}`) })}</p> : null}
      {operation.unknown ? <p role="status">{t("mcpRetrieval.unknown")}</p> : null}{operation.ended || state.stop?.ended ? <p role="status">{t("mcpRetrieval.waitEnded")}</p> : null}
      {changed ? <p role="status">{t("mcpRetrieval.changed")}</p> : null}{expired ? <p role="status">{t("mcpRetrieval.expired")}</p> : null}
      {preview ? <section aria-label={t("mcpRetrieval.previewTitle")}><h4>{t("mcpRetrieval.previewTitle")}</h4><p>{t("mcpRetrieval.prepareHelp")}</p>
        <label>{t("mcpRetrieval.destination")}<textarea readOnly value={preview.request.tool.endpoint} rows={2}/></label>
        <p>{preview.request.tool.serverName} · {preview.request.tool.serverVersion} · {preview.request.tool.protocolVersion} · {preview.request.tool.toolName}</p>
        <label>{t("mcpRetrieval.fixedQuery")}<textarea readOnly rows={4} value={preview.arguments.query}/></label>
        <p>{t("mcpRetrieval.sourceLocale")} · {preview.arguments.sourceLocale}</p><p>{t("mcpRetrieval.locale")} · {preview.arguments.targetLocale}</p>
        <p>{t("mcpRetrieval.disclosure")}</p><label className="source-check"><input type="checkbox" checked={state.consent} disabled={disabled || !!state.busy || changed || expired || !!operation.start || operation.closed || !inputCurrent()}
          onChange={event => owner.setConsent(event.target.checked)}/>{t("mcpRetrieval.consent")}</label>
        <button type="button" className="primary-button" disabled={disabled || !!state.busy || !state.consent || changed || expired || !!operation.start || operation.closed || !inputCurrent()}
          onClick={() => { setHistorical(null); void owner.start(inputCurrent); }}>{t("mcpRetrieval.start")}</button>
      </section> : null}
      {state.reading ? <p role="status">{t("mcpRetrieval.reading")}</p> : null}{state.stopping ? <p role="status">{t("mcpRetrieval.stopping")}</p> : null}
      {state.stop?.unknown ? <p role="status">{t("mcpRetrieval.stopUnknown")}</p> : null}
      {operation.closed ? <p role="status">{t(operation.drained ? "mcpRetrieval.closed" : "mcpRetrieval.draining")}</p> : null}
      <div className="execution-actions"><button type="button" onClick={() => { void (state.reading ? owner.retryRead() : owner.read()); }}>{t(state.reading ? "mcpRetrieval.replaceRead" : "mcpRetrieval.read")}</button>
        <button type="button" disabled={disabled || operation.closed && operation.drained && !state.stop?.unknown && !state.stop?.pending} onClick={() => { void (state.stopping ? owner.retryStop() : owner.stop()); }}>{t(state.stopping ? "mcpRetrieval.replaceStop" : state.stop?.unknown ? "mcpRetrieval.retryStop" : "mcpRetrieval.stop")}</button>
        {owner.canEndWait() ? <button type="button" onClick={() => owner.endWait()}>{t("mcpRetrieval.endWait")}</button> : null}</div><p>{t("mcpRetrieval.readHelp")}</p>
    </section> : null}
    {[state.failure, state.stopFailure, view?.error].map((failure, index) => failure ? <div role="alert" key={index}><p>{t("mcpRetrieval.failed")}</p>{recovery(failure)}<CommandFailureDetails failure={failure}/></div> : null)}
    {state.readFailure ? <div role="alert"><p>{t("mcpRetrieval.readFailed")}</p><CommandFailureDetails failure={state.readFailure}/></div> : null}
    <button type="button" className="secondary-button" disabled={disabled} aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>{t("mcpRetrieval.history")}</button>
    {historyOpen ? <section><p>{t("mcpRetrieval.historyHelp")}</p><p>{t("mcpRetrieval.historyCoverage")}</p>
      {history.error || attempts.error ? <div role="alert"><p>{t("mcpRetrieval.readFailed")}</p><CommandFailureDetails failure={commandFailure(history.error ?? attempts.error)}/></div> : null}
      <button type="button" disabled={history.isFetching || attempts.isFetching} onClick={() => { void history.refetch(); if (historyTask) void attempts.refetch(); }}>{t("mcpRetrieval.read")}</button>
      {history.data?.filter(row => row.operation === "mcp-term-query").map(row => <button type="button" key={row.taskId} disabled={disabled || owner.blocked()}
        onClick={() => { setHistoryTask(row.taskId); setAttemptAfter("0"); setHistorical(null); }}>{t("mcpRetrieval.historyTask", { sequence: row.sequence })}</button>)}
      {history.data?.every(row => row.operation !== "mcp-term-query") ? <p>{t("mcpRetrieval.noHistory")}</p> : null}
      <div className="execution-actions"><button type="button" disabled={historyAfter === "0" || history.isFetching} onClick={() => setHistoryAfter("0")}>{t("execution.firstPage")}</button>
        <button type="button" disabled={history.isFetching || history.data?.length !== 50} onClick={() => { const after = history.data?.at(-1)?.sequence; if (after) setHistoryAfter(after); }}>{t("execution.nextPage")}</button></div>
      {attempts.data?.map(row => <button type="button" key={row.attemptId} disabled={disabled || owner.blocked()} onClick={() => { if (historyTask) setHistorical({ taskId: historyTask, attemptId: row.attemptId }); }}>{t("mcpRetrieval.historyAttempt", { sequence: row.sequence })}</button>)}
      {historyTask ? <div className="execution-actions"><button type="button" disabled={attemptAfter === "0" || attempts.isFetching} onClick={() => setAttemptAfter("0")}>{t("execution.firstPage")}</button>
        <button type="button" disabled={attempts.isFetching || attempts.data?.length !== 50} onClick={() => { const after = attempts.data?.at(-1)?.sequence; if (after) setAttemptAfter(after); }}>{t("execution.nextPage")}</button></div> : null}
    </section> : null}
    {detail.error || output.error ? <div role="alert"><p>{t("mcpRetrieval.readFailed")}</p><CommandFailureDetails failure={commandFailure(detail.error ?? output.error)}/></div> : null}
    {attemptId ? <section aria-label={t("mcpRetrieval.results")}><h4>{t("mcpRetrieval.results")}</h4>
      {detail.data?.items.map(item => <p role="status" key={item.status.itemId}>{t(`execution.states.${item.status.execution}`)}</p>)}
      <button type="button" disabled={detail.isFetching || output.isFetching} onClick={() => { void detail.refetch(); if (resultId) void output.refetch(); }}>{t("mcpRetrieval.read")}</button>
      {result?.entries.length === 0 ? <p>{t("mcpRetrieval.noResults")}</p> : null}
      {result?.entries.map(entry => <article key={entry.id}><label>{t("mcpRetrieval.source")}<textarea readOnly value={entry.source} rows={2}/></label>
        <label>{t("mcpRetrieval.target")}<textarea readOnly value={entry.target} rows={2}/></label><label>{t("mcpRetrieval.reason")}<textarea readOnly value={entry.reason} rows={2}/></label></article>)}
      {detail.data?.items[0]?.status.execution === "succeeded" && output.data && !result ? <p role="alert">{t("toolQuery.invalidResult")}</p> : null}
      <p>{t("mcpRetrieval.captureHelp")}</p><button type="button" className="primary-button" disabled={disabled || !resultCurrent() || !resultId || !!state.capture || !!state.capturing || !!operation && (!operation.closed || !operation.drained || !!operation.unknown)}
        onClick={() => { if (attemptId && resultId && resultCurrent()) void owner.capture(attemptId, resultId); }}>{t("mcpRetrieval.capture")}</button>
    </section> : null}
    {state.capture ? <section>{state.capturing ? <p role="status">{t("mcpRetrieval.capturing")}</p> : null}{state.capture.unknown ? <p role="status">{t("mcpRetrieval.captureUnknown")}</p> : null}
      {state.capture.pending || state.capture.unknown ? <><button type="button" onClick={() => { void owner.readCapture(); }}>{t(state.captureReading ? "mcpRetrieval.replaceRead" : "mcpRetrieval.read")}</button>
        {state.capture.checkedMissing ? <button type="button" disabled={state.capturing || state.captureReading} onClick={() => { void owner.retryCapture(); }}>{t("mcpRetrieval.retryOriginal")}</button> : null}</> : null}
      {captured ? <><p role="status">{t("mcpRetrieval.captured")}</p><button type="button" className="primary-button" disabled={disabled || owner.blocked()} onClick={() => { void openCapture(); }}>{t("mcpRetrieval.openCapture")}</button></> : null}
      {state.captureFailure ? <div role="alert"><p>{t("mcpRetrieval.captureUnknown")}</p>{recovery(state.captureFailure)}<CommandFailureDetails failure={state.captureFailure}/></div> : null}
    </section> : null}
    {handoffBlocked ? <p role="alert">{t("mcpRetrieval.captureBlocked")}</p> : null}
    {operation || state.capture ? <><button type="button" className="secondary-button" disabled={disabled || owner.blocked()} onClick={() => { if (owner.close()) heading.current?.focus(); }}>{t("mcpRetrieval.discard")}</button><p>{t("mcpRetrieval.discardHelp")}</p></> : null}
  </section>;
}
