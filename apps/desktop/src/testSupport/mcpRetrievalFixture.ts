import execution from "../../test/fixtures/executionCommands.contract.json";
import { fixtureIdentity as id } from "./executionFixture";
import { sourcePageFixture, sourceRowFixture } from "./sourceFixture";
import type { ProjectView } from "../projectCommands";
import type { AttemptDetail, ExecutionOutputView } from "../executionCommands";
import type { ResourcePreview } from "../resourceCommands";
import type { McpRetrievalDiscovery, McpRetrievalView, McpTermTool, McpTermQueryRequest, McpTermQueryPreview, McpTermCaptureReceipt } from "../mcpRetrievalCommands";
export const retrievalProject: ProjectView = { sessionToken: "synthetic-retrieval-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: id(9300), displayName: "Synthetic retrieval", sourceLocale: "en", targetLocales: ["zh-CN", "fr"], metadataRevision: "1" } };
export const retrievalSource = sourcePageFixture({ snapshotId: id(9301), scope: { revision: "2", currentSnapshot: id(9301) },
  rows: [sourceRowFixture({ unitId: id(9302), sourceRevisionId: id(9303) }, { ordinal: 0, key: "synthetic.barrel", text: "Synthetic Barrel {{name}} 👩🏽‍💻" })] });
export function retrievalDiscovery(generation = "1"): McpRetrievalDiscovery { return { identity: { generation, actionId: id(9310) }, endpoint: "https://example.invalid/mcp",
  credentialEnv: "TSUMUGI_MCP_CLIENT_SYNTHETIC", expiresAtMs: Date.now() + 120_000, allowDiscovery: true }; }
export function retrievalTool(discovery = retrievalDiscovery()): McpTermTool { return { discoveryId: discovery.identity.actionId, discoveryGeneration: discovery.identity.generation,
  discoveryExpiresAtMs: discovery.expiresAtMs,
  endpoint: discovery.endpoint, credentialEnv: discovery.credentialEnv, serverName: "Synthetic service", serverVersion: "1", protocolVersion: "2025-06-18", toolName: "find_terms",
  description: "<script>untrusted service description</script>", profileVersion: "tsumugi.mcp.term-query-1",
  inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" }, sourceLocale: { type: "string" }, targetLocale: { type: "string" } }, required: ["query", "sourceLocale", "targetLocale"] },
  outputSchema: { type: "object", additionalProperties: false, properties: { entries: { type: "array", items: { type: "object", additionalProperties: false,
    properties: { id: { type: "string" }, source: { type: "string" }, target: { type: "string" }, reason: { type: "string" } }, required: ["id", "source", "target", "reason"] } } }, required: ["entries"] } }; }
export function retrievalQuery(discovery = retrievalDiscovery()): McpTermQueryRequest { return { projectId: retrievalProject.metadata.projectId, actionId: id(9311), taskId: id(9312), attemptId: id(9313),
  unitId: id(9302), locale: "zh-CN", query: retrievalSource.rows[0].occurrence.text, expiresAtMs: discovery.expiresAtMs, tool: retrievalTool(discovery) }; }
export function retrievalPreview(request = retrievalQuery()): McpTermQueryPreview { return { request, basis: { projectId: request.projectId, unitId: request.unitId, locale: request.locale,
  sourceLocale: "en", sourceSnapshotId: id(9301), sourceRevisionId: id(9303) }, arguments: { query: request.query, sourceLocale: "en", targetLocale: request.locale }, toolDigest: "a".repeat(64), inputDigest: "b".repeat(64) }; }
export function retrievalView(discovery = retrievalDiscovery(), query: McpTermQueryRequest | null = null, phase: McpRetrievalView["phase"] = query ? "prepared" : "ready"): McpRetrievalView {
  const preview = query ? retrievalPreview(query) : null;
  return { identity: discovery.identity, discovery, phase, tools: [retrievalTool(discovery)], query, preview,
    consent: phase === "enqueued" || phase === "closed" && query ? { actionId: query!.actionId, inputDigest: preview!.inputDigest, expiresAtMs: query!.expiresAtMs, shareQuery: true } : null,
    task: phase === "enqueued" || phase === "closed" && query ? { taskId: query!.taskId, attemptId: query!.attemptId, inputDigest: preview!.inputDigest } : null,
    stop: null, admissionClosed: phase === "closed", callbacksDrained: phase !== "enqueued" && phase !== "discovering", error: null };
}
export function retrievalAttempt(query = retrievalQuery()): AttemptDetail { const scope = { kind: "translation-unit", id: query.unitId, locale: query.locale };
  return { ...execution.detail, attemptId: query.attemptId, taskId: query.taskId, operation: "mcp-term-query", progress: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
    items: [{ ...execution.detail.items[0], resultId: id(9314), scope, status: { ...execution.detail.items[0].status, execution: "succeeded", validation: "valid", adoption: "unapplied", cancellationRequested: false, diagnostic: null } }],
    recovery: { attemptId: query.attemptId, units: [{ ...execution.detail.recovery.units[0], scopes: [scope], resultIds: [id(9314)], actions: ["adopt-result"], blockedReason: null }] }, nextOffset: null };
}
export function retrievalResult(query = retrievalQuery()): ExecutionOutputView { return { ...execution.output, projectId: query.projectId, attemptId: query.attemptId, itemId: retrievalAttempt(query).items[0].status.itemId,
  resultId: id(9314), capabilityId: "tsumugi.mcp.term-query", capabilityVersion: "tsumugi.mcp.term-query-1", outcome: "succeeded", plugin: null,
  output: { entries: [{ id: "barrel", source: "Barrel", target: "木桶", reason: "<a href='https://example.invalid'>Untrusted reference 👩🏽‍💻</a>" }] } }; }
export function retrievalCapture(actionId = id(9320), query = retrievalQuery()): McpTermCaptureReceipt {
  const preview = retrievalPreview(query), resultId = id(9314), action = { ...execution.action, actionId, projectId: query.projectId, attemptId: query.attemptId, operation: "mcp-term-query", resultIds: [resultId], parameters: null };
  return { action, receipt: { ...execution.receipt, actionId, projectId: query.projectId, attemptId: query.attemptId, unitId: action.unitId,
    changes: [{ kind: "resource-capture", id: actionId, revision: "1" }] }, capture: { captureId: actionId, count: 1, sourceLocale: "en", targetLocale: query.locale, digest: "c".repeat(64),
      origin: { kind: "mcp", provenance: { basis: preview.basis, query: query.query, tool: query.tool, toolDigest: preview.toolDigest,
        queryActionId: query.actionId, taskId: query.taskId, attemptId: query.attemptId, inputDigest: preview.inputDigest,
        itemId: retrievalAttempt(query).items[0].status.itemId, resultId, resultDigest: "d".repeat(64) } } } };
}
export function retrievalResourcePreview(captured = retrievalCapture(), current = true): ResourcePreview { return { capture: captured.capture, correction: null, mcp: { current }, removed: [],
  rows: [{ entry: { id: "barrel", source: "Barrel", target: "木桶", aliases: [], protected: false, nativeKey: null, reason: "Synthetic external suggestion" }, kind: "added", current: null, scopeUnitId: id(9302) }] }; }
