import { createRef, useState } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as aiOwner from "./AiPreparationSession";
import * as resourceOwner from "./ResourceDraftSession";
import { ProjectSessionWorkbench, type ProjectSessionHandle } from "./ProjectSessionWorkbench";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "./workbenchCommands";
import { WorkspaceViewMemory, WorkspaceViewProvider, type WorkspaceArea } from "./WorkbenchFrame";
import { defaultAiConfig, type AiItem, type AiPrepared } from "./aiCommands";
import { workPlanCommands, type WorkPlanView } from "./workPlanCommands";
import type { WorkPlanPrepareRequest } from "./generated/ai.requests";
import type { McpRetrievalView, McpRetrievalDiscoverRequest, McpRetrievalPrepareRequest, McpRetrievalStopRequest } from "./mcpRetrievalCommands";
import { i18n } from "./i18n";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import { aiWorkPlanFixture } from "./testSupport/aiFixture";
import { connectionFixture } from "./testSupport/connectionFixture";
import { toolQueryInventory } from "./testSupport/pluginToolFixture";
import { retrievalProject as project, retrievalSource as source, retrievalView } from "./testSupport/mcpRetrievalFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const actualAi = aiOwner.useAiPreparation, actualResources = resourceOwner.useResourceDraftSession;
let ai: ReturnType<typeof actualAi>, resources: ReturnType<typeof actualResources>;
let canonical: McpRetrievalView | null, serial: number, lastPlan: WorkPlanView;
const handle = createRef<ProjectSessionHandle>();
function Harness() {
  const [area, setArea] = useState<WorkspaceArea>("resources"), [memory] = useState(() => new WorkspaceViewMemory());
  const [commands] = useState(() => new WorkbenchCommands());
  return <ApplicationReadProvider><WorkbenchCommandsProvider commands={commands}><WorkspaceViewProvider value={{ area, memory, activate: setArea, deactivate: () => setArea("overview") }}>
    <ProjectSessionWorkbench project={project} ref={handle} disabled={false} onActivate={setArea} onCoordinatingChange={() => {}} />
  </WorkspaceViewProvider></WorkbenchCommandsProvider></ApplicationReadProvider>;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function item(): AiItem {
  return { unitId: source.rows[0].unitId!, sourceRevisionId: source.rows[0].sourceRevisionId!, sourceSnapshotId: source.snapshotId!,
    nativeKey: source.rows[0].occurrence.key, sourceLocale: "en", sourceText: source.rows[0].occurrence.text,
    targetLocale: "zh-CN", terms: [], context: null, sourceContext: { kind: "not-selected" }, projectContext: { kind: "not-selected" },
    omissions: ["terms-not-shared", "context-not-shared"], resourceBaseline: "0" };
}
function planFor(request: WorkPlanPrepareRequest): WorkPlanView {
  if (!request.config) throw new Error("Missing synthetic model capture");
  const prepared: AiPrepared = { attemptId: id(9400), preview: { recipe: "direct-translation-1", config: structuredClone(request.config),
    digest: "c".repeat(64), items: [item()] } };
  return { ...aiWorkPlanFixture(prepared, request.options), planId: id(9401) };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); serial = 9500; canonical = null; invoke.mockReset();
  vi.spyOn(aiOwner, "useAiPreparation").mockImplementation(() => { const value = actualAi(); ai = value; return value; });
  vi.spyOn(resourceOwner, "useResourceDraftSession").mockImplementation(() => { const value = actualResources(); resources = value; return value; });
  invoke.mockImplementation(async (command: string, payload?: { request: Record<string, unknown> }) => {
    const request = payload?.request;
    switch (command) {
      case "read_project_changes": return { projectId: project.metadata.projectId, sessionToken: project.sessionToken,
        epoch: id(9450), sequence: "0", progressSequence: "0", scopes: [], runtime: { active: false, quiescing: false, queryCount: 0, error: null } };
      case "read_context_strategy_default": return null;
      case "read_model_connections": return connectionFixture([defaultAiConfig]);
      case "read_content_scope": return source.scope;
      case "read_source_content": return source;
      case "read_terms": case "read_term_history": case "list_resource_captures": return [];
      case "read_plugin_inventory": return { ...toolQueryInventory, packages: [], packageDecisions: [] };
      case "read_plugin_text_reviews": return { settingsRevision: "1", entries: [] };
      case "create_execution_identity": return id(++serial);
      case "read_mcp_retrieval_session": return { nextGeneration: "1", current: null, lifetimeMs: 120_000, maxTools: 32,
        maxQueryBytes: 16_384, maxResultBytes: 65_536, maxEntries: 100 };
      case "discover_mcp_terms": canonical = retrievalView((request as unknown as McpRetrievalDiscoverRequest).discovery); return structuredClone(canonical);
      case "read_mcp_retrieval": return structuredClone(canonical);
      case "prepare_mcp_term_query": {
        if (!canonical) throw new Error("Missing synthetic discovery");
        canonical = retrievalView(canonical.discovery, (request as unknown as McpRetrievalPrepareRequest).query); return structuredClone(canonical);
      }
      case "stop_mcp_retrieval": {
        if (!canonical) throw new Error("Missing synthetic discovery");
        const stop = (request as unknown as McpRetrievalStopRequest).stop;
        canonical = { ...canonical, phase: "closed", stop, admissionClosed: true, callbacksDrained: true };
        return { request: stop, view: structuredClone(canonical) };
      }
      case "prepare_work_plan": lastPlan = planFor(request as unknown as WorkPlanPrepareRequest); return structuredClone(lastPlan);
      default: throw new Error(`Unexpected synthetic command: ${command}`);
    }
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function preparedQuery() {
  render(<Harness />); const user = userEvent.setup();
  act(() => ai.setConfig(previous => ({ ...previous, endpoint: "http://127.0.0.1:4000/v1/chat/completions", model: "synthetic-mcp-model", credentialEnv: "", connectionProfile: null })));
  await user.click(screen.getByRole("tab", { name: i18n.t("resource.tabs.queries") }));
  await user.selectOptions(screen.getByRole("combobox", { name: i18n.t("mcpRetrieval.mode") }), "mcp");
  const ui = within(screen.getByRole("region", { name: i18n.t("mcpRetrieval.title") }));
  await user.type(ui.getByRole("textbox", { name: i18n.t("mcpRetrieval.endpoint") }), "https://example.invalid/mcp");
  await user.click(ui.getByRole("checkbox", { name: i18n.t("mcpRetrieval.discoveryConsent") }));
  await user.click(ui.getByRole("button", { name: i18n.t("mcpRetrieval.discover") }));
  await waitFor(() => expect(ui.getByRole("option", { name: "find_terms" })).toBeInTheDocument());
  await user.selectOptions(ui.getByRole("combobox", { name: i18n.t("mcpRetrieval.tool") }), "find_terms");
  await user.selectOptions(ui.getByRole("combobox", { name: i18n.t("mcpRetrieval.unit") }), source.rows[0].unitId!);
  await user.selectOptions(ui.getByRole("combobox", { name: i18n.t("mcpRetrieval.locale") }), "zh-CN");
  await user.click(ui.getByRole("button", { name: i18n.t("mcpRetrieval.useSource") }));
  await user.click(ui.getByRole("button", { name: i18n.t("mcpRetrieval.preview") }));
  await waitFor(() => expect(ui.getByRole("button", { name: i18n.t("mcpRetrieval.aiPlan.use") })).toBeEnabled());
  return { user, ui };
}
async function attached() {
  const ready = await preparedQuery();
  await ready.user.click(ready.ui.getByRole("button", { name: i18n.t("mcpRetrieval.aiPlan.use") }));
  await screen.findByRole("region", { name: i18n.t("ai.mcpTermQuery.title") });
  return ready.user;
}
async function consent(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.mcpTermQuery.serviceConsent") }));
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.mcpTermQuery.modelConsent") }));
}

it("hands the exact original preview to the production AI owner with both permissions off and no external query", async () => {
  await attached(); const preview = canonical!.preview!;
  expect(ai.mcpDraft?.preview).toEqual(preview); expect(ai.selected).toEqual([preview.basis.unitId]);
  expect(screen.getByRole("checkbox", { name: i18n.t("ai.mcpTermQuery.serviceConsent") })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: i18n.t("ai.mcpTermQuery.modelConsent") })).not.toBeChecked();
  expect(screen.getByText(i18n.t("ai.mcpTermQuery.scope", { entry: "synthetic.barrel", locale: "zh-CN" }))).toBeVisible();
  expect(screen.getByText(i18n.t("ai.mcpTermQuery.limits", { sdk: 0, total: 1 }))).toBeVisible();
  expect(screen.getByRole("textbox", { name: i18n.t("mcpRetrieval.fixedQuery") })).toHaveValue(preview.arguments.query);
  expect(calls("discover_mcp_terms")).toHaveLength(1); expect(calls("start_mcp_term_query")).toHaveLength(0);
  expect(calls("prepare_work_plan")).toHaveLength(0); expect(calls("authorize_work_plan")).toHaveLength(0);
  expect(calls("start_work_plan")).toHaveLength(0); expect(resources.tool.mcp.current().operation?.handedToAi).toBe(true);
  await act(async () => { expect(await handle.current!.navigate({ kind: "mcp-query" })).toBe(true); });
  const original = within(await screen.findByRole("region", { name: i18n.t("mcpRetrieval.title") }));
  expect(original.getByRole("checkbox", { name: i18n.t("mcpRetrieval.consent") })).toBeDisabled();
  expect(original.getByRole("button", { name: i18n.t("mcpRetrieval.start") })).toBeDisabled();
  expect(ai.mcpDraft?.preview).toEqual(preview); expect(calls("discover_mcp_terms")).toHaveLength(1);
});

it("requires both independent permissions, keeps MCP-only tools absent, and verifies the complete plan acknowledgement", async () => {
  const user = await attached();
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.mcpTermQuery.serviceConsent") }));
  expect(screen.getByRole("button", { name: i18n.t("ai.preview") })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.mcpTermQuery.modelConsent") }));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.preview") }));
  await waitFor(() => expect(ai.preparedPlan).not.toBeNull());
  const request = calls("prepare_work_plan")[0][1].request as WorkPlanPrepareRequest;
  expect(request.options.mcpTermQuery).toEqual({ profile: "fixed-term-query-1", preview: canonical!.preview });
  expect(request.toolSelection).toBeNull(); expect(ai.preparedPlan!.tools).toBeNull(); expect(ai.consent).toBe(false);
  expect(calls("authorize_work_plan")).toHaveLength(0); expect(calls("start_mcp_term_query")).toHaveLength(0);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    const value = await original(command, args);
    if (command !== "prepare_work_plan") return value;
    const changed: WorkPlanView = structuredClone(value); changed.options.mcpTermQuery!.preview.arguments.query = "Changed acknowledgement";
    return changed;
  });
  await expect(workPlanCommands.prepare(request)).rejects.toMatchObject({ outcome: "unknown", reason: "invalid-work-plan-acknowledgement" });
});

it("retains Resource input B while the fixed query A plan preview is pending", async () => {
  const user = await attached(); await consent(user);
  const original = invoke.getMockImplementation()!, held = deferred<WorkPlanView>();
  invoke.mockImplementation((command, args) => command === "prepare_work_plan" ? held.promise : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.preview") }));
  await waitFor(() => expect(calls("prepare_work_plan")).toHaveLength(1));
  const request = calls("prepare_work_plan")[0][1].request as WorkPlanPrepareRequest;
  act(() => { resources.tool.setRows([{ id: 0, text: "Later input B 👩🏽‍💻" }]); resources.tool.edit();
    resources.editTerm({ ...resources.current().termDraft, source: "Manual B", target: "人工", reason: "Retained separately" }); });
  await act(async () => held.resolve(planFor(request)));
  await waitFor(() => expect(ai.preparedPlan?.options.mcpTermQuery?.preview).toEqual(canonical!.preview));
  expect(resources.tool.current().rows[0].text).toBe("Later input B 👩🏽‍💻"); expect(resources.current().termDraft.source).toBe("Manual B");
  expect(request.options.mcpTermQuery!.preview.arguments.query).toBe(source.rows[0].occurrence.text);
  expect(calls("start_mcp_term_query")).toHaveLength(0);
});

it("ignores an old plan acknowledgement after model B replaces its destination and clears both permissions", async () => {
  const user = await attached(); await consent(user);
  const original = invoke.getMockImplementation()!, held = deferred<WorkPlanView>();
  invoke.mockImplementation((command, args) => command === "prepare_work_plan" ? held.promise : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.preview") }));
  const request = calls("prepare_work_plan")[0][1].request as WorkPlanPrepareRequest;
  act(() => ai.setConfig(previous => ({ ...previous, model: "Later model B" })));
  await act(async () => held.resolve(planFor(request)));
  await waitFor(() => expect(ai.busy).toBe(false));
  expect(ai.config.model).toBe("Later model B"); expect(ai.preparedPlan).toBeNull();
  expect(ai.mcpDraft?.serviceConsent).toBe(false); expect(ai.mcpDraft?.modelConsent).toBe(false);
  expect(ai.mcpDraft?.preview).toEqual(canonical!.preview); expect(request.config!.model).not.toBe("Later model B");
});

it("stops the original service independently during plan preparation and preserves newer drafts against its late acknowledgement", async () => {
  const user = await attached(); await consent(user);
  const original = invoke.getMockImplementation()!, held = deferred<WorkPlanView>();
  invoke.mockImplementation((command, args) => command === "prepare_work_plan" ? held.promise : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.preview") }));
  const request = calls("prepare_work_plan")[0][1].request as WorkPlanPrepareRequest;
  act(() => { resources.tool.setRows([{ id: 0, text: "B survives Stop" }]); resources.tool.edit(); });
  const stop = screen.getByRole("button", { name: i18n.t("ai.mcpTermQuery.stop") }); expect(stop).toBeEnabled(); await user.click(stop);
  await waitFor(() => expect(resources.tool.mcp.current().operation?.closed).toBe(true));
  await act(async () => held.resolve(planFor(request)));
  await waitFor(() => expect(ai.busy).toBe(false));
  expect(ai.preparedPlan).toBeNull(); expect(ai.mcpDraft?.serviceConsent).toBe(false); expect(ai.mcpDraft?.modelConsent).toBe(false);
  expect(resources.tool.current().rows[0].text).toBe("B survives Stop"); expect(calls("stop_mcp_retrieval")).toHaveLength(1);
  expect(calls("start_mcp_term_query")).toHaveLength(0); expect(calls("authorize_work_plan")).toHaveLength(0);
});

it("expires at the original service deadline without discovering again or extending the captured preview", async () => {
  await attached(); const expires = ai.mcpDraft!.preview.request.expiresAtMs;
  vi.useFakeTimers();
  act(() => {
    expect(ai.receiveMcpQuery(canonical!.preview!, ai.editSeq, "synthetic.barrel")).toBe(true);
    ai.setMcpConsent("serviceConsent", true); ai.setMcpConsent("modelConsent", true);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(Math.max(1, expires - Date.now() + 2)); });
  expect(ai.mcpDraft!.preview.request.expiresAtMs).toBe(expires); expect(ai.mcpScopeCurrent()).toBe(false);
  expect(ai.mcpDraft?.serviceConsent).toBe(false); expect(ai.mcpDraft?.modelConsent).toBe(false);
  expect(calls("discover_mcp_terms")).toHaveLength(1); expect(calls("start_mcp_term_query")).toHaveLength(0);
});

it("retains an unknown authorization's complete fixed query while input B and an independent service Stop remain available", async () => {
  const user = await attached();
  act(() => ai.setOptions(previous => ({ ...previous, stages: previous.stages.map(stage => stage.stage === "checks" ? { ...stage, mode: "manual" } : stage) })));
  await consent(user); await user.click(screen.getByRole("button", { name: i18n.t("ai.preview") }));
  await waitFor(() => expect(ai.preparedPlan).not.toBeNull());
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => {
    if (command === "authorize_work_plan") return Promise.reject({ outcome: "unknown", reason: "synthetic-lost-acknowledgement" });
    if (command === "read_work_plan_authorization_action") return Promise.resolve(null);
    return original(command, args);
  });
  await user.click(screen.getByRole("checkbox", { name: i18n.t("ai.consent") }));
  const generate = screen.getByRole("button", { name: i18n.t("ai.generate") }); await waitFor(() => expect(generate).toBeEnabled()); await user.click(generate);
  await waitFor(() => expect(ai.planControl.current().pending?.uncertain).toBe(true));
  const pending = structuredClone(ai.planControl.current().pending!);
  expect(pending.kind).toBe("authorize"); expect(pending.prepared.options.mcpTermQuery!.preview).toEqual(canonical!.preview);
  if (pending.kind !== "authorize") throw new Error("Expected original authorization");
  expect(pending.request.effects).toContain("query-tools"); expect(pending.request.toolExecution).toBe(false);
  act(() => { resources.tool.setRows([{ id: 0, text: "B while authorization is unknown" }]); resources.tool.edit(); });
  await user.click(screen.getByRole("button", { name: i18n.t("ai.mcpTermQuery.stop") }));
  await waitFor(() => expect(resources.tool.mcp.current().operation?.closed).toBe(true));
  expect(ai.planControl.current().pending?.request).toEqual(pending.request);
  expect(ai.planControl.current().pending?.prepared.options.mcpTermQuery).toEqual(pending.prepared.options.mcpTermQuery);
  expect(resources.tool.current().rows[0].text).toBe("B while authorization is unknown");
  expect(calls("authorize_work_plan")).toHaveLength(1); expect(calls("read_work_plan_authorization_action")).toHaveLength(1);
  expect(calls("start_work_plan")).toHaveLength(0); expect(calls("start_mcp_term_query")).toHaveLength(0);
});

it("does not upgrade an accepted or unknown manual Start into model sharing", async () => {
  const { user, ui } = await preparedQuery(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "start_mcp_term_query"
    ? Promise.reject({ outcome: "unknown", reason: "synthetic-lost-acknowledgement" }) : original(command, args));
  await user.click(ui.getByRole("checkbox", { name: i18n.t("mcpRetrieval.consent") }));
  await user.click(ui.getByRole("button", { name: i18n.t("mcpRetrieval.start") }));
  await waitFor(() => expect(resources.tool.mcp.current().operation?.unknown).toBe("start"));
  expect(ui.getByRole("button", { name: i18n.t("mcpRetrieval.aiPlan.use") })).toBeDisabled(); expect(ai.mcpDraft).toBeNull();
  act(() => { canonical = retrievalView(canonical!.discovery, canonical!.query, "enqueued"); });
  await act(async () => resources.tool.mcp.read());
  expect(resources.tool.mcp.current().operation?.unknown).toBeNull(); expect(resources.tool.mcp.canUseInAi()).toBe(false);
  expect(ai.mcpDraft).toBeNull(); expect(calls("prepare_work_plan")).toHaveLength(0); expect(calls("start_mcp_term_query")).toHaveLength(1);
});

it("refuses stale AI handoffs and keeps the original MCP owner blocking exit after clearing only the AI draft", async () => {
  const { user, ui } = await preparedQuery(), preview = canonical!.preview!, sequence = ai.editSeq;
  act(() => ai.setConfig(previous => ({ ...previous, model: "Draft B" })));
  expect(await handle.current!.navigate({ kind: "ai-mcp-query", preview, querySequence: resources.tool.draftSequence.current, expectedEditSeq: sequence })).toBe(false);
  expect(ai.mcpDraft).toBeNull(); expect(ai.config.model).toBe("Draft B");
  await user.click(ui.getByRole("button", { name: i18n.t("mcpRetrieval.aiPlan.use") }));
  await screen.findByRole("region", { name: i18n.t("ai.mcpTermQuery.title") });
  await user.click(screen.getByRole("button", { name: i18n.t("ai.mcpTermQuery.clear") }));
  expect(ai.mcpDraft).toBeNull(); expect(resources.tool.mcp.current().operation?.handedToAi).toBe(true);
  expect(await handle.current!.prepareExit()).toBeNull(); expect(resources.tool.mcp.blocked()).toBe(true);
  expect(resources.tool.current().rows[0].text).toBe(source.rows[0].occurrence.text);
  expect(calls("stop_mcp_retrieval")).toHaveLength(0);
});
