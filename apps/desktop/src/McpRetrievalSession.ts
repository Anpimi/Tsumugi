import { useLayoutEffect, useRef, useState } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, type Receipt } from "./executionCommands";
import { resourceCommands, type GlossaryCapture } from "./resourceCommands";
import { useSessionReads } from "./SessionReadProvider";
import { jsonIdentity } from "./pluginToolChoices";
import { mcpRetrievalCommands as commands, sameRetrievalIdentity, type McpRetrievalIdentity, type McpRetrievalDiscovery, type McpRetrievalDiscoverRequest,
  type McpRetrievalPrepareRequest, type McpRetrievalStartRequest, type McpRetrievalStopRequest, type McpRetrievalCaptureRequest,
  type McpRetrievalView, type McpTermQueryPreview } from "./mcpRetrievalCommands";
import type { RetrievalUnit } from "./PluginToolQuerySession";
import type { ProjectView } from "./projectCommands";

export const retrievalKey = (identity: McpRetrievalIdentity) => ["mcp-retrieval", identity.generation, identity.actionId] as const;
function fixed<T>(value: T): T { const copy = structuredClone(value); function freeze(part: unknown) {
  if (part && typeof part === "object") { Object.values(part).forEach(freeze); Object.freeze(part); }
} freeze(copy); return copy; }
interface Draft { endpoint: string; credentialEnv: string; query: string; toolName: string; unit: RetrievalUnit | null; locale: string; seq: number }
interface Operation {
  discovery: McpRetrievalDiscoverRequest; seq: number; query: McpRetrievalPrepareRequest | null; preview: McpTermQueryPreview | null;
  start: McpRetrievalStartRequest | null; unknown: "discover" | "prepare" | "start" | null; closed: boolean; drained: boolean; ended: boolean;
  handedToAi: boolean;
}
interface State {
  operation: Operation | null; busy: "discovery" | "prepare" | "start" | null; consent: boolean; stale: boolean; failure: CommandFailure | null;
  reading: boolean; readFailure: CommandFailure | null;
  stop: { request: McpRetrievalStopRequest; pending: boolean; unknown: boolean; ended: boolean } | null; stopping: boolean; stopFailure: CommandFailure | null;
  capture: { request: McpRetrievalCaptureRequest; pending: boolean; unknown: boolean; checkedMissing: boolean; value: GlossaryCapture | null } | null;
  capturing: boolean; captureFailure: CommandFailure | null; captureReading: boolean;
}
/** Holds original actions and consent inside the resource query owner. Input stays in its existing rows. */
export function useMcpRetrieval(project: ProjectView, ports: { live: () => boolean; draft: () => Draft; submitted: (seq: number) => void }) {
  const reads = useSessionReads(), [session] = useState(() => ({ ...reads.context }));
  const portsRef = useRef(ports), projectRef = useRef(project), primary = useRef<object | null>(null), control = useRef<object | null>(null), reading = useRef<object | null>(null), captureFlight = useRef<object | null>(null), captureRead = useRef<object | null>(null);
  const [state, setState] = useState<State>({ operation: null, busy: null, consent: false, stale: false, failure: null, reading: false, readFailure: null,
    stop: null, stopping: false, stopFailure: null, capture: null, capturing: false, captureFailure: null, captureReading: false });
  const stateRef = useRef(state);
  useLayoutEffect(() => { portsRef.current = ports; projectRef.current = project; });
  useLayoutEffect(() => () => { primary.current = null; control.current = null; reading.current = null; captureFlight.current = null; captureRead.current = null; }, []);
  useLayoutEffect(() => reads.subscribeChanges(scopes => { if (scopes.some(scope => scope === "source" || scope === "project")) invalidate(); }), [reads]);
  function live() { return portsRef.current.live() && !reads.retired; }
  function current() { return stateRef.current; }
  function update(change: (before: State) => State) { if (!live()) return; const value = change(stateRef.current); stateRef.current = value; setState(value); }
  function same(operation: Operation) { return live() && current().operation?.discovery === operation.discovery; }
  function status() { const op = current().operation; return op ? reads.client.getQueryData<McpRetrievalView>(reads.key(retrievalKey(op.discovery.discovery.identity))) : undefined; }
  function invalidate() { update(value => ({ ...value, consent: false, stale: !!value.operation?.query || value.stale })); }
  function observe(operation: Operation, value: McpRetrievalView) {
    if (!same(operation)) return;
    const before = current(), held = before.operation!;
    if (held.closed && !value.admissionClosed) throw new Error("MCP retrieval admission cannot reopen");
    const stopped = before.stop && value.stop && jsonIdentity(before.stop.request.stop) === jsonIdentity(value.stop);
    if (stopped) control.current = null;
    // A read can confirm acceptance, but null never disproves a request whose ACK was lost.
    const accepted = held.unknown === "discover" ? value.phase === "ready" || value.tools.length > 0 : held.unknown === "prepare" ? value.preview !== null : held.unknown === "start" ? value.task !== null : false;
    if (accepted) primary.current = null;
    reads.client.setQueryData(reads.key(retrievalKey(value.identity)), value);
    update(part => part.operation?.discovery !== operation.discovery ? part : { ...part, busy: accepted ? null : part.busy,
      stop: stopped && part.stop ? { ...part.stop, pending: false, unknown: false, ended: false } : part.stop, stopping: stopped ? false : part.stopping,
      stale: part.stale || !!value.preview && (portsRef.current.draft().unit?.sourceSnapshotId !== value.preview.basis.sourceSnapshotId
        || portsRef.current.draft().unit?.sourceRevisionId !== value.preview.basis.sourceRevisionId),
      operation: { ...part.operation, preview: part.operation.preview ?? value.preview,
        unknown: accepted ? null : part.operation.unknown, closed: part.operation.closed || value.admissionClosed,
        drained: part.operation.closed && part.operation.drained || value.callbacksDrained } });
  }
  async function discover() {
    if (!live() || primary.current || blocked() || current().operation) return;
    const draft = fixed(portsRef.current.draft()), ticket = {}; primary.current = ticket;
    update(value => ({ ...value, busy: "discovery", failure: null }));
    try {
      const descriptor = await commands.session(session); if (!live() || primary.current !== ticket || portsRef.current.draft().seq !== draft.seq) return;
      if (descriptor.current) {
        const recovered = await commands.read({ ...session, identity: descriptor.current });
        if (!live() || primary.current !== ticket) return;
        if (!recovered.admissionClosed || !recovered.callbacksDrained) {
          const operation: Operation = { discovery: fixed({ ...session, discovery: recovered.discovery }), seq: draft.seq,
            query: recovered.query ? fixed({ ...session, identity: recovered.identity, query: recovered.query }) : null, preview: recovered.preview,
            start: null, unknown: null, closed: recovered.admissionClosed, drained: recovered.callbacksDrained, ended: false, handedToAi: false };
          update(value => ({ ...value, operation, consent: false, stale: true })); observe(operation, recovered); return;
        }
      }
      const actionId = await executionCommands.identity(session); if (!live() || primary.current !== ticket || portsRef.current.draft().seq !== draft.seq) return;
      const discovery: McpRetrievalDiscovery = { identity: { actionId, generation: descriptor.nextGeneration }, endpoint: draft.endpoint,
        credentialEnv: draft.credentialEnv || null, expiresAtMs: Date.now() + descriptor.lifetimeMs, allowDiscovery: true };
      const operation: Operation = { discovery: fixed({ ...session, discovery }), seq: draft.seq, query: null, preview: null, start: null, unknown: "discover", closed: false, drained: false, ended: false, handedToAi: false };
      update(value => ({ ...value, operation, stale: false, consent: false, stop: null, stopFailure: null, capture: null, captureFailure: null }));
      const result = await commands.discover(operation.discovery); if (primary.current !== ticket || !same(operation)) return;
      observe(operation, result); update(value => value.operation?.discovery === operation.discovery ? { ...value, operation: { ...value.operation, unknown: null } } : value);
    } catch (error) { if (primary.current === ticket) update(value => ({ ...value, failure: commandFailure(error) })); }
    finally { if (primary.current === ticket) { primary.current = null; update(value => ({ ...value, busy: null })); } }
  }
  async function read(replaceWait = false) {
    const operation = current().operation; if (!live() || !operation || reading.current && !replaceWait) return;
    const ticket = {}; reading.current = ticket; update(value => ({ ...value, reading: true, readFailure: null }));
    const key = reads.key(retrievalKey(operation.discovery.discovery.identity));
    try {
      if (replaceWait) await reads.client.cancelQueries({ queryKey: key, exact: true });
      if (reading.current !== ticket || !same(operation)) return;
      const result = await reads.client.fetchQuery({ queryKey: key, staleTime: 0, meta: { scopes: ["execution"] }, queryFn: async ({ signal }) => {
        const value = await commands.read({ ...session, identity: operation.discovery.discovery.identity }, operation.discovery.discovery, operation.query?.query, operation.start?.consent);
        if (signal.aborted || reading.current !== ticket || !same(operation)) throw new Error("MCP retrieval read wait retired");
        if (current().operation?.closed && !value.admissionClosed) throw new Error("MCP retrieval admission cannot reopen"); return value;
      } });
      if (reading.current === ticket && same(operation)) observe(operation, result);
    } catch (error) { if (reading.current === ticket) update(value => ({ ...value, readFailure: commandFailure(error) })); }
    finally { if (reading.current === ticket) { reading.current = null; update(value => ({ ...value, reading: false })); } }
  }
  async function prepare(currentSource: () => boolean) {
    const operation = current().operation, draft = fixed(portsRef.current.draft()), view = status();
    if (!live() || !operation || primary.current || operation.unknown || operation.query || operation.closed || !view || !currentSource() || !draft.unit
      || !projectRef.current.metadata.targetLocales.includes(draft.locale)) return;
    const tool = view.tools.find(tool => tool.toolName === draft.toolName); if (!tool || tool.endpoint !== draft.endpoint || tool.credentialEnv !== (draft.credentialEnv || null)) return;
    const ticket = {}; primary.current = ticket; update(value => ({ ...value, busy: "prepare", failure: null, consent: false }));
    try {
      const [actionId, taskId, attemptId] = await Promise.all([executionCommands.identity(session), executionCommands.identity(session), executionCommands.identity(session)]);
      if (!same(operation) || primary.current !== ticket || portsRef.current.draft().seq !== draft.seq || !currentSource()) return;
      const request: McpRetrievalPrepareRequest = fixed({ ...session, identity: operation.discovery.discovery.identity, query: { projectId: session.projectId,
        actionId, taskId, attemptId, unitId: draft.unit.unitId, locale: draft.locale, query: draft.query, tool,
        expiresAtMs: operation.discovery.discovery.expiresAtMs } });
      update(value => value.operation?.discovery !== operation.discovery ? value : { ...value, stale: false, operation: { ...value.operation, seq: draft.seq, query: request, unknown: "prepare" } });
      const result = await commands.prepare(request, operation.discovery.discovery);
      if (!same(operation) || primary.current !== ticket) return;
      if (result.preview?.basis.sourceSnapshotId !== draft.unit.sourceSnapshotId || result.preview.basis.sourceRevisionId !== draft.unit.sourceRevisionId) throw new Error("MCP retrieval source basis changed");
      observe(current().operation!, result);
      update(value => value.operation?.discovery !== operation.discovery ? value : { ...value, stale: portsRef.current.draft().seq !== draft.seq || !currentSource(), operation: { ...value.operation, unknown: null } });
    } catch (error) { if (primary.current === ticket) update(value => ({ ...value, failure: commandFailure(error) })); }
    finally { if (primary.current === ticket) { primary.current = null; update(value => ({ ...value, busy: null })); } }
  }
  function setConsent(consent: boolean) { const value = current(), op = value.operation;
    if (!op?.preview || value.busy || value.stale || op.closed || op.unknown || op.start || op.handedToAi || op.seq !== portsRef.current.draft().seq || op.preview.request.expiresAtMs <= Date.now()) return;
    update(before => ({ ...before, consent }));
  }
  function canUseInAi(preview = current().operation?.preview, sequence = portsRef.current.draft().seq) {
    const value = current(), op = value.operation;
    if (!live() || !op?.query || !op.preview || !preview || value.busy || value.stale || op.start || op.unknown || op.closed
      || sequence !== op.seq || sequence !== portsRef.current.draft().seq || preview.request.expiresAtMs <= Date.now()
      || jsonIdentity(preview) !== jsonIdentity(op.preview)) return false;
    return aiPreviewCurrent(preview);
  }
  function aiPreviewCurrent(preview: McpTermQueryPreview) {
    const value = current(), op = value.operation;
    if (!live() || !op || op.start || op.unknown || op.closed || value.stopping || value.stop?.pending || value.stop?.unknown || preview.request.expiresAtMs <= Date.now()
      || jsonIdentity(op.preview) !== jsonIdentity(preview)) return false;
    const query = reads.client.getQueryState<McpRetrievalView>(reads.key(retrievalKey(op.discovery.discovery.identity))), view = query?.data;
    return query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null
      && !!view && view.phase === "prepared" && !view.admissionClosed && view.consent === null && view.task === null
      && jsonIdentity(view.preview) === jsonIdentity(preview);
  }
  function handToAi(preview: McpTermQueryPreview, sequence: number) {
    if (!canUseInAi(preview, sequence)) return false;
    // This only suppresses the separate manual Start in this local draft.
    // The Host independently binds the exact query to an approved plan.
    update(before => ({ ...before, consent: false, operation: before.operation ? { ...before.operation, handedToAi: true } : null }));
    return true;
  }
  async function start(currentSource: () => boolean) {
    const operation = current().operation;
    if (!live() || !operation?.query || !operation.preview || primary.current || !current().consent || current().stale || operation.closed || operation.unknown || operation.start || operation.handedToAi
      || operation.seq !== portsRef.current.draft().seq || !currentSource() || operation.query.query.expiresAtMs <= Date.now()
      || !projectRef.current.metadata.targetLocales.includes(operation.preview.basis.locale) || operation.preview.basis.sourceLocale !== projectRef.current.metadata.sourceLocale) return;
    const ticket = {}; primary.current = ticket;
    const request: McpRetrievalStartRequest = fixed({ ...session, identity: operation.discovery.discovery.identity, consent: { actionId: operation.query.query.actionId,
      inputDigest: operation.preview.inputDigest, expiresAtMs: operation.query.query.expiresAtMs, shareQuery: true } });
    update(value => value.operation?.discovery !== operation.discovery ? value : { ...value, busy: "start", failure: null, consent: false, operation: { ...value.operation, start: request, unknown: "start" } });
    portsRef.current.submitted(operation.seq);
    try { const value = await commands.start(request, operation.discovery.discovery, operation.query.query);
      if (primary.current !== ticket || !same(operation)) return; observe(current().operation!, value);
      update(before => before.operation?.discovery !== operation.discovery ? before : { ...before, operation: { ...before.operation, unknown: null } });
    } catch (error) { if (primary.current === ticket) update(value => ({ ...value, failure: commandFailure(error) })); }
    finally { if (primary.current === ticket) { primary.current = null; update(value => ({ ...value, busy: null })); } }
  }
  async function stop(replaceWait = false) {
    const operation = current().operation;
    if (!live() || !operation || control.current && !replaceWait || operation.closed && operation.drained && !current().stop?.unknown && !current().stop?.pending) return;
    const ticket = {}; control.current = ticket; update(value => ({ ...value, stopping: true, stopFailure: null }));
    try {
      let request = current().stop?.request;
      if (!request) { const actionId = await executionCommands.identity(session); if (!same(operation) || control.current !== ticket) return;
        request = fixed({ ...session, stop: { identity: operation.discovery.discovery.identity, actionId, discovery: operation.discovery.discovery } }); }
      update(value => ({ ...value, stop: { request, pending: true, unknown: false, ended: false } }));
      const result = await commands.stop(request); if (!same(operation) || control.current !== ticket) return;
      observe(operation, result.view); update(value => ({ ...value, stop: value.stop ? { ...value.stop, pending: false, unknown: false } : null }));
    } catch (error) { if (control.current === ticket) update(value => ({ ...value, stopFailure: commandFailure(error), stop: value.stop ? { ...value.stop, pending: false, unknown: true } : null })); }
    finally { if (control.current === ticket) { control.current = null; update(value => ({ ...value, stopping: false })); } }
  }
  function canEndWait() { const value = current(), op = value.operation; if (!op || !value.busy && !op.unknown && !value.stopping && !value.stop?.unknown && !value.stop?.pending) return false;
    const query = reads.client.getQueryState<McpRetrievalView>(reads.key(retrievalKey(op.discovery.discovery.identity)));
    return live() && !value.reading && !value.readFailure && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null
      && !!query.data && sameRetrievalIdentity(query.data.identity, op.discovery.discovery.identity) && query.data.admissionClosed && query.data.callbacksDrained;
  }
  function endWait() { if (!canEndWait()) return false; primary.current = null; control.current = null;
    update(value => ({ ...value, busy: null, stopping: false, consent: false, operation: value.operation ? { ...value.operation, unknown: null, ended: true } : null,
      stop: value.stop ? { ...value.stop, pending: false, unknown: false, ended: true } : null })); return true; }
  async function capture(attemptId: string, resultId: string) {
    if (!live() || captureFlight.current || current().capture) return;
    const ticket = {}; captureFlight.current = ticket; update(value => ({ ...value, capturing: true, captureFailure: null }));
    try { const actionId = await executionCommands.identity(session); if (!live() || captureFlight.current !== ticket) return;
      const request: McpRetrievalCaptureRequest = fixed({ ...session, actionId, attemptId, resultId });
      update(value => ({ ...value, capture: { request, pending: true, unknown: false, checkedMissing: false, value: null } }));
      const receipt = await commands.capture(request); if (!live() || captureFlight.current !== ticket) return;
      update(value => ({ ...value, capture: value.capture?.request === request ? { ...value.capture, pending: false, value: receipt.capture } : value.capture })); reads.invalidate(["resources"], false);
    } catch (error) { if (captureFlight.current === ticket) update(value => ({ ...value, captureFailure: commandFailure(error), capture: value.capture ? { ...value.capture, pending: false, unknown: true } : null })); }
    finally { if (captureFlight.current === ticket) { captureFlight.current = null; update(value => ({ ...value, capturing: false })); } }
  }
  function checkReceipt(receipt: Receipt, request: McpRetrievalCaptureRequest) {
    return receipt.projectId === request.projectId && receipt.actionId === request.actionId && receipt.attemptId === request.attemptId
      && receipt.changes.length === 1 && receipt.changes[0].kind === "resource-capture" && receipt.changes[0].id === request.actionId;
  }
  async function readCapture() {
    const captured = current().capture; if (!live() || !captured) return;
    const ticket = {}; captureRead.current = ticket; update(value => ({ ...value, captureReading: true, captureFailure: null }));
    try { const receipt = await executionCommands.receipt({ ...session, actionId: captured.request.actionId });
      if (!live() || captureRead.current !== ticket || current().capture?.request !== captured.request) return;
      if (!receipt) { captureFlight.current = null;
        update(value => ({ ...value, capturing: false, capture: value.capture ? { ...value.capture, pending: false, unknown: true, checkedMissing: true } : null })); return; }
      if (!checkReceipt(receipt, captured.request)) throw new Error("MCP capture receipt changed");
      const preview = await resourceCommands.preview({ ...session, captureId: captured.request.actionId });
      if (!live() || captureRead.current !== ticket || current().capture?.request !== captured.request) return;
      if (preview.capture.origin.kind !== "mcp" || preview.capture.origin.provenance.attemptId !== captured.request.attemptId
        || preview.capture.origin.provenance.resultId !== captured.request.resultId) throw new Error("MCP capture provenance changed");
      captureFlight.current = null;
      update(value => ({ ...value, capturing: false, capture: value.capture ? { ...value.capture, pending: false, unknown: false, checkedMissing: false, value: preview.capture } : null }));
    } catch (error) { if (captureRead.current === ticket) update(value => ({ ...value, captureFailure: commandFailure(error) })); }
    finally { if (captureRead.current === ticket) { captureRead.current = null; update(value => ({ ...value, captureReading: false })); } }
  }
  async function retryCapture() { const captured = current().capture; if (!live() || !captured?.unknown || !captured.checkedMissing || captureFlight.current) return;
    const ticket = {}; captureFlight.current = ticket; update(value => ({ ...value, capturing: true, captureFailure: null }));
    try { const receipt = await commands.capture(captured.request); if (!live() || captureFlight.current !== ticket) return;
      update(value => ({ ...value, capture: value.capture?.request === captured.request ? { ...value.capture, unknown: false, pending: false, value: receipt.capture } : value.capture })); reads.invalidate(["resources"], false);
    } catch (error) { if (captureFlight.current === ticket) update(value => ({ ...value, captureFailure: commandFailure(error) })); }
    finally { if (captureFlight.current === ticket) { captureFlight.current = null; update(value => ({ ...value, capturing: false })); } }
  }
  function blocked() { const value = current(), op = value.operation; return !!primary.current || !!control.current || !!captureFlight.current || !!captureRead.current || !!op && (!op.closed || !op.drained || !!op.unknown)
    || !!value.stop?.pending || !!value.stop?.unknown || !!value.capture?.pending || !!value.capture?.unknown; }
  function close() { if (!live() || blocked()) return false; reading.current = null;
    update(value => ({ ...value, operation: null, stop: null, consent: false, stale: false, failure: null, reading: false, readFailure: null, stopFailure: null, capture: null, captureFailure: null })); return true; }
  function endLocalPreparationWait() { if (!live() || current().operation || !primary.current) return false; primary.current = null;
    update(value => ({ ...value, busy: null })); return true; }
  function revision() { const value = current(); return [value.operation?.discovery, value.operation?.query, value.operation?.start, value.operation?.unknown,
    value.operation?.closed, value.operation?.drained, value.operation?.ended, value.operation?.handedToAi, value.busy, value.stop, value.stopping, value.capture, value.capturing, value.captureReading]; }
  return { state, current, status, revision, discover, read, retryRead: () => read(true), prepare, setConsent, start, stop, retryStop: () => stop(true), canEndWait, endWait, endLocalPreparationWait,
    capture, readCapture, retryCapture, blocked, close, invalidate, canUseInAi, handToAi, aiPreviewCurrent };
}
export type McpRetrievalSession = ReturnType<typeof useMcpRetrieval>;
