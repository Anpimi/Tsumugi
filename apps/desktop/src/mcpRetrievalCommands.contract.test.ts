import { beforeEach, expect, it, vi } from "vitest";
import { mcpRetrievalCommands as commands, retrievalOutput, type McpRetrievalView, type McpRetrievalStartRequest, type McpRetrievalStopRequest } from "./mcpRetrievalCommands";
import { retrievalProject, retrievalDiscovery, retrievalView, retrievalQuery, retrievalPreview, retrievalAttempt, retrievalResult, retrievalCapture } from "./testSupport/mcpRetrievalFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
const invoke = vi.hoisted(() => vi.fn()); vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const session = { sessionToken: retrievalProject.sessionToken, projectId: retrievalProject.metadata.projectId };
beforeEach(() => invoke.mockReset());
it("keeps discovery, local preview, exact consent, stop and provenance capture distinct at the generated boundary", async () => {
  const discovery = retrievalDiscovery(), query = retrievalQuery(discovery), ready = retrievalView(discovery), prepared = retrievalView(discovery, query), started = retrievalView(discovery, query, "enqueued");
  invoke.mockResolvedValueOnce({ nextGeneration: "1", current: null, lifetimeMs: 120_000, maxTools: 32, maxQueryBytes: 16_384, maxResultBytes: 65_536, maxEntries: 100 });
  expect((await commands.session(session)).current).toBeNull(); expect(invoke).toHaveBeenLastCalledWith("read_mcp_retrieval_session", { request: session });
  invoke.mockResolvedValueOnce(ready); await expect(commands.discover({ ...session, discovery })).resolves.toEqual(ready);
  invoke.mockResolvedValueOnce(prepared); await expect(commands.prepare({ ...session, identity: discovery.identity, query }, discovery)).resolves.toEqual(prepared);
  const start: McpRetrievalStartRequest = { ...session, identity: discovery.identity, consent: started.consent! };
  invoke.mockResolvedValueOnce(started); await expect(commands.start(start, discovery, query)).resolves.toEqual(started);
  const stop: McpRetrievalStopRequest = { ...session, stop: { identity: discovery.identity, actionId: id(9330), discovery } }, closed = { ...started, phase: "closed" as const, stop: stop.stop, admissionClosed: true, callbacksDrained: false };
  invoke.mockResolvedValueOnce({ request: stop.stop, view: closed }); await expect(commands.stop(stop)).resolves.toEqual({ request: stop.stop, view: closed });
  invoke.mockResolvedValueOnce(closed); await expect(commands.read({ ...session, identity: discovery.identity }, discovery, query, start.consent)).resolves.toEqual(closed);
  const request = { ...session, actionId: id(9320), attemptId: query.attemptId, resultId: id(9314) }; invoke.mockResolvedValueOnce(retrievalCapture(request.actionId, query));
  expect((await commands.capture(request)).capture.origin.kind).toBe("mcp"); expect(invoke).toHaveBeenLastCalledWith("capture_mcp_glossary", { request });
});
it.each(["query", "preview", "consent", "task"] as const)("retains a schema-valid start ACK with missing %s as unknown", async field => {
  const discovery = retrievalDiscovery(), query = retrievalQuery(discovery), view = retrievalView(discovery, query, "enqueued"), consent = view.consent!;
  view[field] = null; invoke.mockResolvedValueOnce(view);
  await expect(commands.start({ ...session, identity: discovery.identity, consent }, discovery, query)).rejects.toMatchObject({ outcome: "unknown" });
});
it.each(["no-stop", "wrong-stop", "open"] as const)("does not confirm a %s stop by its echoed wrapper", async field => {
  const discovery = retrievalDiscovery(), stop = { identity: discovery.identity, actionId: id(9330), discovery }, view = retrievalView(discovery, null, "closed");
  view.stop = field === "no-stop" ? null : { ...stop, actionId: field === "wrong-stop" ? id(9331) : stop.actionId }; if (field === "open") view.admissionClosed = false;
  invoke.mockResolvedValueOnce({ request: stop, view }); await expect(commands.stop({ ...session, stop })).rejects.toMatchObject({ outcome: "unknown" });
});
it.each(["identity", "tool", "tool-expiry", "query", "basis", "task", "missing-consent"] as const)("rejects a wrong %s association even when the DTO schema is valid", async kind => {
  const discovery = retrievalDiscovery(), query = retrievalQuery(discovery), view = retrievalView(discovery, query, "enqueued");
  if (kind === "identity") view.identity = { ...view.identity, generation: "2" };
  if (kind === "tool") view.tools[0].endpoint = "https://other.invalid/mcp";
  if (kind === "tool-expiry") view.tools[0].discoveryExpiresAtMs--;
  if (kind === "query") view.query = { ...query, query: "Different text" };
  if (kind === "basis") view.preview!.basis.unitId = id(9339);
  if (kind === "task") view.task!.taskId = id(9339);
  if (kind === "missing-consent") view.consent = null;
  invoke.mockResolvedValueOnce(view); await expect(commands.read({ ...session, identity: discovery.identity }, discovery, query)).rejects.toBeDefined();
});
it("treats descriptions and output as plain untrusted data and rejects cross-attempt, plugin and malformed result evidence", () => {
  const query = retrievalQuery(), detail = retrievalAttempt(query), output = retrievalResult(query), preview = retrievalPreview(query);
  expect(retrievalOutput(output, detail, preview)?.entries[0].reason).toContain("<a");
  expect(retrievalOutput({ ...output, attemptId: id(9339) }, detail, preview)).toBeNull();
  expect(retrievalOutput({ ...output, output: { entries: [{ id: "x", source: "outside source", target: "x", reason: "x" }] } }, detail, preview)).toBeNull();
  expect(retrievalOutput({ ...output, output: { entries: [], instruction: "Do not validate" } }, detail, preview)).toBeNull();
  expect(retrievalOutput({ ...output, capabilityId: "unrelated" }, detail, preview)).toBeNull();
});
it("requires explicit nullable fields and accepts reordered equivalent immutable tool schemas", async () => {
  const discovery = retrievalDiscovery(), query = retrievalQuery(discovery), view = retrievalView(discovery, query);
  view.query!.tool.inputSchema = { required: ["query", "sourceLocale", "targetLocale"], properties: { targetLocale: { type: "string" }, query: { type: "string" }, sourceLocale: { type: "string" } }, additionalProperties: false, type: "object" };
  invoke.mockResolvedValueOnce(view); await expect(commands.read({ ...session, identity: discovery.identity }, discovery)).resolves.toBeDefined();
  const missing = retrievalView(discovery); delete (missing as Partial<McpRetrievalView>).error; invoke.mockResolvedValueOnce(missing);
  await expect(commands.read({ ...session, identity: discovery.identity })).rejects.toBeDefined();
});
