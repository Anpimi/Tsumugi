import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { ResourceWorkbench } from "./ResourceWorkbench";
import { useResourceDraftSession } from "./ResourceDraftSession";
import { i18n } from "./i18n";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import { toolQueryInventory } from "./testSupport/pluginToolFixture";
import execution from "../test/fixtures/executionCommands.contract.json";
import { retrievalProject as project, retrievalSource as source, retrievalView, retrievalQuery, retrievalAttempt, retrievalResult,
  retrievalCapture, retrievalResourcePreview } from "./testSupport/mcpRetrievalFixture";
import type { McpRetrievalDiscoverRequest, McpRetrievalPrepareRequest, McpRetrievalStopRequest, McpRetrievalCaptureRequest, McpRetrievalView,
  McpTermQueryRequest, McpTermCaptureReceipt } from "./mcpRetrievalCommands";
import type { ResourceDecision } from "./resourceCommands";

const invoke = vi.hoisted(() => vi.fn()); vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let serial: number, canonical: McpRetrievalView | null, captured: McpTermCaptureReceipt | null, current: boolean;
let owner: ReturnType<typeof useResourceDraftSession>;
function Probe() { const value = useResourceDraftSession(); useLayoutEffect(() => { owner = value; }); return null; }
function recordedQuery(): McpTermQueryRequest { return canonical?.query ?? retrievalQuery(); }
function panel() { return within(screen.getByRole("region", { name: i18n.t("mcpRetrieval.title") })); }
function externalCalls() { return invoke.mock.calls.filter(([command]) => command === "discover_mcp_terms" || command === "start_mcp_term_query"); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); serial = 9500; canonical = null; captured = null; current = true; invoke.mockReset();
  invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    const request = payload?.request;
    switch (command) {
      case "read_content_scope": return source.scope;
      case "read_source_content": return source;
      case "read_terms": case "read_term_history": return [];
      case "read_plugin_inventory": return { ...toolQueryInventory, packages: [], packageDecisions: [] };
      case "list_resource_captures": return captured ? [captured.capture] : [];
      case "create_execution_identity": return id(++serial);
      case "read_mcp_retrieval_session": return { nextGeneration: "1", current: null, lifetimeMs: 120_000, maxTools: 32, maxQueryBytes: 16_384, maxResultBytes: 65_536, maxEntries: 100 };
      case "discover_mcp_terms": canonical = retrievalView((request as unknown as McpRetrievalDiscoverRequest).discovery); return structuredClone(canonical);
      case "read_mcp_retrieval": return structuredClone(canonical);
      case "prepare_mcp_term_query": {
        if (!canonical) throw new Error("Missing synthetic discovery");
        canonical = retrievalView(canonical.discovery, (request as unknown as McpRetrievalPrepareRequest).query); return structuredClone(canonical);
      }
      case "start_mcp_term_query": {
        if (!canonical?.query) throw new Error("Missing synthetic query");
        canonical = retrievalView(canonical.discovery, canonical.query, "closed"); return structuredClone(canonical);
      }
      case "stop_mcp_retrieval": {
        if (!canonical) throw new Error("Missing synthetic discovery"); const stop = (request as unknown as McpRetrievalStopRequest).stop;
        canonical = { ...canonical, phase: "closed", stop, admissionClosed: true, callbacksDrained: true }; return { request: stop, view: structuredClone(canonical) };
      }
      case "read_execution_attempt": return retrievalAttempt(recordedQuery());
      case "read_execution_output": return retrievalResult(recordedQuery());
      case "list_execution_tasks": return [{ ...execution.task, projectId: project.metadata.projectId, taskId: recordedQuery().taskId, operation: "mcp-term-query", sequence: "1" }];
      case "read_execution_task": return [{ ...execution.summary, attemptId: recordedQuery().attemptId, sequence: "1" }];
      case "capture_mcp_glossary": {
        const input = request as unknown as McpRetrievalCaptureRequest; captured = retrievalCapture(input.actionId, recordedQuery()); return structuredClone(captured);
      }
      case "read_resource_preview": {
        if (!captured) throw new Error("Missing synthetic candidate"); return retrievalResourcePreview(captured, current);
      }
      case "decide_resource_entry": {
        const decision = request.decision as ResourceDecision; return { request: decision, actionId: decision.actionId, decision: decision.decision, revision: null };
      }
      default: throw new Error(command);
    }
  });
});
afterEach(cleanup);
async function open(expectSource = true) {
  const view = render(<><ResourceWorkbench project={project} disabled={false} onOpenTranslation={() => true}/><Probe/></>, project), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("resource.title") }));
  await user.click(screen.getByRole("tab", { name: i18n.t("resource.tabs.queries") }));
  await user.selectOptions(screen.getByRole("combobox", { name: i18n.t("mcpRetrieval.mode") }), "mcp");
  if (expectSource) await waitFor(() => expect(panel().getByRole("option", { name: "synthetic.barrel" })).toBeInTheDocument());
  return { user, view };
}
async function prepare() {
  const opened = await open(), ui = panel();
  await opened.user.type(ui.getByRole("textbox", { name: "MCP service endpoint" }), "https://example.invalid/mcp");
  await opened.user.type(ui.getByRole("textbox", { name: "MCP credential environment variable" }), "TSUMUGI_MCP_CLIENT_SYNTHETIC");
  await opened.user.click(ui.getByRole("checkbox", { name: /I authorize connecting/ }));
  await opened.user.click(ui.getByRole("button", { name: "Connect and discover tools" }));
  await waitFor(() => expect(ui.getByRole("option", { name: "find_terms" })).toBeInTheDocument());
  await opened.user.selectOptions(ui.getByRole("combobox", { name: "Discovered tool" }), "find_terms");
  await opened.user.selectOptions(ui.getByRole("combobox", { name: "Saved entry for this query" }), id(9302));
  await opened.user.selectOptions(ui.getByRole("combobox", { name: "Target language" }), "zh-CN");
  await opened.user.click(ui.getByRole("button", { name: "Use this saved source as the query" }));
  await opened.user.click(ui.getByRole("button", { name: "Review exact external query" }));
  await ui.findByRole("textbox", { name: "Query sent to the service" }); return { ...opened, ui };
}
async function complete() {
  const opened = await prepare(); await opened.user.click(opened.ui.getByRole("checkbox", { name: /I authorize this service to receive/ }));
  await opened.user.click(opened.ui.getByRole("button", { name: "Send this exact query" }));
  await opened.ui.findByRole("textbox", { name: "Suggested target term" }); return opened;
}
it("keeps discovery and execution manual, and treats descriptions and returned reasons as plain untrusted text", async () => {
  const { user } = await open(), ui = panel(); expect(externalCalls()).toHaveLength(0);
  expect(invoke.mock.calls.some(([command]) => command === "read_mcp_retrieval_session")).toBe(false);
  await user.type(ui.getByRole("textbox", { name: "MCP service endpoint" }), "https://example.invalid/mcp");
  expect(ui.getByRole("button", { name: "Connect and discover tools" })).toBeDisabled();
  await user.click(ui.getByRole("checkbox", { name: /I authorize connecting/ })); await user.click(ui.getByRole("button", { name: "Connect and discover tools" }));
  await user.selectOptions(ui.getByRole("combobox", { name: "Discovered tool" }), "find_terms");
  expect(ui.getByText("<script>untrusted service description</script>")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "External terminology retrieval" }).querySelector("script, a")).toBeNull();
  expect(externalCalls()).toHaveLength(1); expect(invoke.mock.calls.some(([command]) => command === "start_mcp_term_query")).toBe(false);
});
it("runs the exact previewed query and explicitly hands its MCP candidate to the original resource decision path", async () => {
  const { user, ui } = await complete();
  expect(ui.getByRole("textbox", { name: "Query sent to the service" })).toHaveValue(source.rows[0].occurrence.text);
  expect((ui.getByRole("textbox", { name: "Service-supplied reason" }) as HTMLTextAreaElement).value).toContain("<a href=");
  expect(screen.getByRole("region", { name: "Untrusted terminology results" }).querySelector("a, script")).toBeNull();
  expect(invoke.mock.calls.some(([command]) => command === "capture_mcp_glossary" || command === "decide_resource_entry")).toBe(false);
  await user.click(ui.getByRole("button", { name: "Create a captured terminology candidate" }));
  await ui.findByText("The external result was captured. It has not been adopted.");
  await user.click(ui.getByRole("button", { name: "Review the captured terminology" }));
  const heading = await screen.findByRole("heading", { name: i18n.t("resource.resourceUpdates") }); await waitFor(() => expect(heading).toHaveFocus());
  expect(screen.getByText("The captured source basis is current. Review each proposed change before adopting it.")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Adopt" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Adopt" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "decide_resource_entry")).toBe(true));
  const decision = invoke.mock.calls.find(([command]) => command === "decide_resource_entry")![1].request.decision;
  expect(decision).toMatchObject({ projectId: project.metadata.projectId, captureId: captured!.capture.captureId, entryId: "barrel", decision: "adopt" });
  expect(captured!.capture.origin.kind).toBe("mcp"); expect(externalCalls().map(([command]) => command)).toEqual(["discover_mcp_terms", "start_mcp_term_query"]);
  expect(invoke.mock.calls.some(([command]) => /prepare_plugin_tool|start_plugin_tool|model/.test(command))).toBe(false);
});
it("invalidates consent after a new query edit and keeps the fixed original preview", async () => {
  const { user, ui } = await prepare(); await user.click(ui.getByRole("checkbox", { name: /I authorize this service to receive/ }));
  const query = ui.getByRole("textbox", { name: "Exact query text 1" }); await user.clear(query); await user.type(query, "Barrel");
  expect(ui.getByRole("checkbox", { name: /I authorize this service to receive/ })).not.toBeChecked();
  expect(ui.getByRole("textbox", { name: "Query sent to the service" })).toHaveValue(source.rows[0].occurrence.text);
  expect(ui.getByRole("button", { name: "Send this exact query" })).toBeDisabled(); expect(externalCalls()).toHaveLength(1);
});
it("retains a newer manual resource draft when a completed external candidate requests a handoff", async () => {
  const { user, ui } = await complete(); await user.click(ui.getByRole("button", { name: "Create a captured terminology candidate" }));
  await ui.findByText("The external result was captured. It has not been adopted.");
  await user.click(screen.getByRole("tab", { name: "Terms" })); await user.type(screen.getByRole("textbox", { name: "Source term" }), "Manual B");
  await user.click(screen.getByRole("tab", { name: "Reference queries" })); await user.click(panel().getByRole("button", { name: "Review the captured terminology" }));
  expect(await panel().findByRole("alert")).toHaveTextContent("Pending work or newer resource input prevents this handoff");
  expect(owner.current().termDraft.source).toBe("Manual B"); expect(owner.current().previewCapture).toBeNull();
});
it("does not apply a handoff preview after newer manual input arrives while its original read is pending", async () => {
  const { user, ui } = await complete(); await user.click(ui.getByRole("button", { name: "Create a captured terminology candidate" }));
  await ui.findByText("The external result was captured. It has not been adopted.");
  const pending = deferred<ReturnType<typeof retrievalResourcePreview>>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "read_resource_preview" ? pending.promise : original(command, payload));
  await user.click(ui.getByRole("button", { name: "Review the captured terminology" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_resource_preview")).toBe(true));
  act(() => owner.editTerm({ ...owner.current().termDraft, source: "Manual B", target: "人工 B", reason: "Newer input" }));
  await act(async () => { pending.resolve(retrievalResourcePreview(captured!)); });
  await ui.findByText("Pending work or newer resource input prevents this handoff. Current terminology, context and query input are kept.");
  expect(owner.current().termDraft.source).toBe("Manual B"); expect(owner.current().preview).toBeNull();
  expect(screen.getByRole("tab", { name: "Reference queries" })).toHaveAttribute("aria-selected", "true");
});
it("keeps the original request reachable during an unknown start, stops independently and returns focus after explicit local closure", async () => {
  const { user, ui } = await prepare(), pending = deferred<McpRetrievalView>(); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "start_mcp_term_query" ? pending.promise : original(command, payload));
  await user.click(ui.getByRole("checkbox", { name: /I authorize this service to receive/ })); await user.click(ui.getByRole("button", { name: "Send this exact query" }));
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  expect(screen.queryByRole("heading", { name: "External terminology retrieval" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  expect(screen.getByRole("heading", { name: "External terminology retrieval" })).toBeVisible(); expect(owner.tool.mcp.current().operation!.unknown).toBe("start");
  await user.click(panel().getByRole("button", { name: "Stop this external operation" }));
  await waitFor(() => expect(owner.tool.mcp.current().operation!.closed).toBe(true));
  await user.click(within(panel().getByRole("region", { name: "Original external query" })).getByRole("button", { name: "Check original local record" }));
  await user.click(await panel().findByRole("button", { name: "End this unconfirmed wait after local closure" }));
  await user.click(panel().getByRole("button", { name: "Close the resolved external request" }));
  expect(screen.getByRole("heading", { name: "External terminology retrieval" })).toHaveFocus();
  await act(async () => { pending.resolve(retrievalView(canonical!.discovery, canonical!.query, "enqueued")); });
  expect(owner.tool.mcp.current().operation).toBeNull(); expect(externalCalls()).toHaveLength(2);
});
it("reads saved query results and captures them without reconnecting or restoring any consent", async () => {
  const { user } = await open(), ui = panel(); await user.click(ui.getByRole("button", { name: "Read saved external query history" }));
  await user.click(await ui.findByRole("button", { name: "External query record 1" })); await user.click(await ui.findByRole("button", { name: "Read attempt 1" }));
  await ui.findByRole("textbox", { name: "Suggested target term" }); expect(externalCalls()).toHaveLength(0);
  await user.click(ui.getByRole("button", { name: "Create a captured terminology candidate" })); await ui.findByText("The external result was captured. It has not been adopted.");
  expect(externalCalls()).toHaveLength(0); expect(owner.tool.mcp.current().operation).toBeNull(); expect(owner.tool.mcp.current().consent).toBe(false);
  expect(invoke.mock.calls.some(([command]) => command === "read_mcp_retrieval_session")).toBe(false);
});
it.each(["changed-source", "removed-source"] as const)("shows %s MCP evidence through the original capture list, retaining Keep and Ignore while disabling new adoption", async state => {
  captured = retrievalCapture(); current = false;
  if (state === "removed-source") { const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, payload) => command === "read_content_scope" ? Promise.resolve({ revision: "3", currentSnapshot: null }) : original(command, payload)); }
  const { user } = await open(state !== "removed-source");
  await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  await user.click(await screen.findByRole("button", { name: "External MCP terminology · find_terms" }));
  await screen.findByText("The captured source basis is no longer current. New adoption or override is unavailable; the saved evidence, Keep and Ignore remain available.");
  expect(screen.getByRole("button", { name: "Adopt" })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Keep current" })).toBeEnabled());
  expect(screen.getByRole("button", { name: i18n.t("resource.ignore") })).toBeEnabled(); expect(externalCalls()).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Keep current" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "decide_resource_entry")).toBe(true));
});
it("localizes the discoverable entry and consent while keeping user endpoint input unchanged", async () => {
  await i18n.changeLanguage("zh-CN"); const { user } = await open(), ui = panel();
  await user.type(ui.getByRole("textbox", { name: "MCP 服务端点" }), "https://example.invalid/mcp");
  expect(ui.getByRole("textbox", { name: "MCP 服务端点" })).toHaveValue("https://example.invalid/mcp");
  expect(ui.getByRole("checkbox", { name: "我允许连接此端点读取工具描述；发现过程不发送项目文本。" })).not.toBeChecked();
  expect(ui.getByRole("button", { name: "连接并发现工具" })).toBeDisabled(); expect(externalCalls()).toHaveLength(0);
});
