import { checkedInvoke } from "./ipc";
import { jsonIdentity } from "./pluginToolChoices";
import type { SessionRequest, AttemptDetail, ExecutionOutputView } from "./executionCommands";
import type { McpRetrievalDiscoverRequest, McpRetrievalReadRequest, McpRetrievalPrepareRequest, McpRetrievalStartRequest,
  McpRetrievalStopRequest, McpRetrievalCaptureRequest, McpRetrievalIdentity, McpRetrievalDiscovery, McpTermQueryRequest, McpTermQueryConsent } from "./generated/mcpRetrieval.requests";
import type { McpRetrievalView, McpTermQueryPreview, McpTermTool, McpTermCaptureReceipt, McpTermQueryOutput } from "./generated/mcpRetrieval.responses";
import * as validators from "./generated/mcpRetrieval.validators";
export type { McpRetrievalIdentity, McpRetrievalDiscovery, McpRetrievalDiscoverRequest, McpRetrievalPrepareRequest, McpRetrievalStartRequest, McpRetrievalStopRequest,
  McpRetrievalCaptureRequest, McpTermQueryRequest, McpTermQueryConsent } from "./generated/mcpRetrieval.requests";
export type { McpRetrievalSession, McpRetrievalView, McpTermQueryPreview, McpTermTool, McpTermCaptureReceipt, McpTermQueryOutput } from "./generated/mcpRetrieval.responses";
function check(value: boolean): asserts value { if (!value) throw Object.assign(new Error("Invalid MCP retrieval acknowledgement"), { outcome: "unknown", reason: "mcp-retrieval-acknowledgement" }); }
export const sameRetrievalIdentity = (a: McpRetrievalIdentity, b: McpRetrievalIdentity) => a.actionId === b.actionId && a.generation === b.generation;
export const sameRetrievalDiscovery = (a: McpRetrievalDiscovery, b: McpRetrievalDiscovery) => sameRetrievalIdentity(a.identity, b.identity)
  && a.endpoint === b.endpoint && a.credentialEnv === b.credentialEnv && a.expiresAtMs === b.expiresAtMs && a.allowDiscovery === b.allowDiscovery;
export function sameRetrievalTool(a: McpTermTool, b: McpTermTool) { return jsonIdentity(a) === jsonIdentity(b); }
export function confirmRetrievalView(value: McpRetrievalView, context: SessionRequest, identity: McpRetrievalIdentity,
  discovery?: McpRetrievalDiscovery, query?: McpTermQueryRequest | null, consent?: McpTermQueryConsent | null) {
  check(sameRetrievalIdentity(value.identity, identity) && sameRetrievalIdentity(value.discovery.identity, identity)
    && (!discovery || sameRetrievalDiscovery(value.discovery, discovery)) && value.discovery.allowDiscovery
    && value.tools.length <= 32 && new Set(value.tools.map(tool => tool.toolName)).size === value.tools.length
    && value.tools.every(tool => tool.discoveryId === identity.actionId && tool.discoveryGeneration === identity.generation && tool.discoveryExpiresAtMs === value.discovery.expiresAtMs
      && tool.endpoint === value.discovery.endpoint && tool.credentialEnv === value.discovery.credentialEnv && tool.profileVersion === "tsumugi.mcp.term-query-1"));
  const request = value.query, preview = value.preview;
  if (request) check(request.projectId === context.projectId && request.expiresAtMs <= value.discovery.expiresAtMs
    && value.tools.some(tool => sameRetrievalTool(tool, request.tool)) && (!query || jsonIdentity(request) === jsonIdentity(query)));
  if (preview) check(request !== null && jsonIdentity(preview.request) === jsonIdentity(request)
    && preview.basis.projectId === context.projectId && preview.basis.unitId === request.unitId && preview.basis.locale === request.locale
    && preview.arguments.query === request.query && preview.arguments.sourceLocale === preview.basis.sourceLocale && preview.arguments.targetLocale === request.locale
    && /^[0-9a-f]{64}$/.test(preview.inputDigest) && /^[0-9a-f]{64}$/.test(preview.toolDigest));
  if (value.consent) check(preview !== null && value.consent.actionId === preview.request.actionId && value.consent.inputDigest === preview.inputDigest
    && value.consent.expiresAtMs === preview.request.expiresAtMs && value.consent.shareQuery && (!consent || jsonIdentity(value.consent) === jsonIdentity(consent)));
  if (value.task) check(request !== null && preview !== null && value.consent !== null && value.task.taskId === request.taskId && value.task.attemptId === request.attemptId && value.task.inputDigest === preview.inputDigest);
  if (value.stop) check(sameRetrievalIdentity(value.stop.identity, identity) && sameRetrievalDiscovery(value.stop.discovery, value.discovery) && value.admissionClosed);
  return value;
}
export function confirmRetrievalCapture(value: McpTermCaptureReceipt, request: McpRetrievalCaptureRequest) {
  const { action, receipt, capture } = value;
  check(action.projectId === request.projectId && action.actionId === request.actionId && action.attemptId === request.attemptId && action.operation === "mcp-term-query"
    && action.resultIds.length === 1 && action.resultIds[0] === request.resultId && action.parameters === null
    && receipt.projectId === request.projectId && receipt.actionId === request.actionId && receipt.attemptId === request.attemptId && receipt.unitId === action.unitId
    && receipt.changes.length === 1 && receipt.changes[0].kind === "resource-capture" && receipt.changes[0].id === request.actionId
    && capture.captureId === request.actionId && capture.origin.kind === "mcp");
  const proof = capture.origin.provenance;
  check(proof.basis.projectId === request.projectId && proof.attemptId === request.attemptId && proof.resultId === request.resultId
    && proof.basis.locale === capture.targetLocale && proof.basis.sourceLocale === capture.sourceLocale);
  return value;
}
export function retrievalOutput(value: ExecutionOutputView | null, detail: AttemptDetail, preview: McpTermQueryPreview | null = null): McpTermQueryOutput | null {
  const item = detail.items[0];
  if (!value || detail.operation !== "mcp-term-query" || detail.items.length !== 1 || detail.nextOffset !== null
    || item.scope.kind !== "translation-unit" || !item.scope.locale
    || value.attemptId !== detail.attemptId || value.itemId !== item.status.itemId || value.resultId !== item.resultId
    || value.capabilityId !== "tsumugi.mcp.term-query" || value.capabilityVersion !== "tsumugi.mcp.term-query-1" || value.outcome !== "succeeded" || value.plugin != null
    || !validators.validateResponseOutput(value.output)) return null;
  const output = value.output;
  if (output.entries.length > 100 || new TextEncoder().encode(JSON.stringify(output)).byteLength > 65_536
    || new Set(output.entries.map(entry => entry.id)).size !== output.entries.length
    || preview && (value.projectId !== preview.request.projectId || detail.attemptId !== preview.request.attemptId || detail.taskId !== preview.request.taskId
      || item.scope.id !== preview.basis.unitId || item.scope.locale !== preview.basis.locale
      || output.entries.some(entry => !preview.arguments.query.includes(entry.source)))) return null;
  return output;
}
export const mcpRetrievalCommands = {
  session: async (request: SessionRequest) => {
    check(validators.validateRequestSession(request)); const value = await checkedInvoke("read_mcp_retrieval_session", request, validators.validateResponseSession);
    check(value.lifetimeMs === 120_000 && value.maxTools === 32 && value.maxQueryBytes === 16_384 && value.maxResultBytes === 65_536 && value.maxEntries === 100); return value;
  },
  discover: async (request: McpRetrievalDiscoverRequest) => { check(validators.validateRequestDiscover(request));
    return confirmRetrievalView(await checkedInvoke("discover_mcp_terms", request, validators.validateResponseView), request, request.discovery.identity, request.discovery); },
  read: async (request: McpRetrievalReadRequest, discovery?: McpRetrievalDiscovery, query?: McpTermQueryRequest | null, consent?: McpTermQueryConsent | null) => {
    check(validators.validateRequestRead(request)); return confirmRetrievalView(await checkedInvoke("read_mcp_retrieval", request, validators.validateResponseView), request, request.identity, discovery, query, consent); },
  prepare: async (request: McpRetrievalPrepareRequest, discovery: McpRetrievalDiscovery) => { check(validators.validateRequestPrepare(request));
    const value = confirmRetrievalView(await checkedInvoke("prepare_mcp_term_query", request, validators.validateResponseView), request, request.identity, discovery, request.query);
    check(value.preview !== null); return value; },
  start: async (request: McpRetrievalStartRequest, discovery: McpRetrievalDiscovery, query: McpTermQueryRequest) => { check(validators.validateRequestStart(request));
    const value = confirmRetrievalView(await checkedInvoke("start_mcp_term_query", request, validators.validateResponseView), request, request.identity, discovery, query, request.consent);
    check(value.query !== null && value.preview !== null && value.consent !== null && value.task !== null && (value.phase === "enqueued" || value.phase === "closed")); return value; },
  stop: async (request: McpRetrievalStopRequest) => { check(validators.validateRequestStop(request));
    const value = await checkedInvoke("stop_mcp_retrieval", request, validators.validateResponseStopped);
    check(jsonIdentity(value.request) === jsonIdentity(request.stop)); confirmRetrievalView(value.view, request, request.stop.identity, request.stop.discovery);
    check(value.view.admissionClosed && value.view.stop !== null && jsonIdentity(value.view.stop) === jsonIdentity(request.stop)); return value; },
  capture: async (request: McpRetrievalCaptureRequest) => { check(validators.validateRequestCapture(request));
    return confirmRetrievalCapture(await checkedInvoke("capture_mcp_glossary", request, validators.validateResponseCapture), request); },
};
