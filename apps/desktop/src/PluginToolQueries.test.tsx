import { createRef, useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceWorkbench, type ResourceHandle } from "./ResourceWorkbench";
import { useResourceDraftSession } from "./ResourceDraftSession";
import { useWorkbenchCommands, type WorkbenchCommands } from "./workbenchCommands";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { toolQueryInventory, toolQueryPackage, toolQueryView } from "./testSupport/pluginToolFixture";
import { nativeInventory, nativePackage, nativeEnvironment, nativeDigest, nativeOrigin } from "./testSupport/pluginNativeFixture";
import type { PluginToolView } from "./pluginCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";
import { SessionNavigation, type SessionExitPermit } from "./sessionNavigation";
import type { ProjectView } from "./projectCommands";
import type { AttemptDetail, PluginToolPrepareRequest, PluginToolPreflight, ExecutionOutputView } from "./executionCommands";
import { validateResponseToolPreflight } from "./generated/execution.validators";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import errorFixture from "../test/fixtures/commandErrors.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "synthetic-query-session", locator: "/synthetic/project", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(900), displayName: "Query demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let serial: number, inventory: typeof toolQueryInventory, prepared: PluginToolPreflight | null, detail: AttemptDetail | null;
let outputs: Map<string, ExecutionOutputView>, startUnknown: boolean, malformedOutput: boolean, queued: boolean;
let holdPreparation: Promise<void> | null, holdStartRead: Promise<void> | null;
let startBeforeEnqueue: boolean, startReadMode: "normal" | "error" | "invalid";
let applicationMode: boolean, nativeMode: boolean, instanceState: "reserved" | "active" | "stopping" | "stopped", unknownStop: boolean;
const applicationBasis = { instanceId: fixtureIdentity(1900), activationGeneration: 1 };
function selectedTool(): PluginToolView {
  return { ...structuredClone(toolQueryView), componentScope: applicationMode ? "application" : "project",
    ...(nativeMode ? { environment: nativeEnvironment, environmentDigest: nativeDigest, runtimeOrigin: nativeOrigin } : {}) };
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  applicationMode = false; nativeMode = false; instanceState = "reserved"; unknownStop = false;
  serial = 901; inventory = structuredClone(toolQueryInventory); prepared = null; detail = null;
  outputs = new Map(); startUnknown = false; malformedOutput = false; queued = false; holdPreparation = null; holdStartRead = null;
  startBeforeEnqueue = false; startReadMode = "normal";
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const request = args?.request;
    switch (command) {
      case "read_content_scope": return { revision: "0", currentSnapshot: null };
      case "read_terms": case "list_resource_captures": return [];
      case "read_plugin_inventory": return structuredClone(inventory);
      case "read_plugin_package": return nativeMode ? nativePackage(toolQueryPackage) : structuredClone(toolQueryPackage);
      case "read_plugin_tool": return selectedTool();
      case "read_application_plugin_instance": return { basis: structuredClone(applicationBasis), state: instanceState };
      case "stop_application_plugin_instance": {
        instanceState = "stopped";
        if (unknownStop) { unknownStop = false; return { unconfirmed: true }; }
        return { basis: structuredClone(applicationBasis), state: instanceState };
      }
      case "create_execution_identity": return fixtureIdentity(serial++);
      case "prepare_plugin_tool": {
        const input = request as unknown as PluginToolPrepareRequest;
        if (holdPreparation) await holdPreparation;
        prepared = { attemptId: input.attemptId, inputDigest: "c".repeat(64), tool: selectedTool(),
          applicationScope: applicationMode ? structuredClone(applicationBasis) : null,
          applicationCapabilities: applicationMode ? [{ contributionId: toolQueryView.binding.capability.provider.contributionId, capability: structuredClone(toolQueryView.binding.capability.declaration) },
            ...(!nativeMode ? [{ contributionId: "secondary.call", capability: structuredClone(toolQueryView.binding.capability.declaration) }] : [])] : [],
          items: input.payloads.map((payload, index) => ({ itemId: fixtureIdentity(1000 + index), payload })).reverse() };
        return structuredClone(prepared);
      }
      case "start_plugin_tool": {
        if (startBeforeEnqueue) { startBeforeEnqueue = false; throw new Error("Connection lost before enqueue"); }
        if (applicationMode) instanceState = "active";
        if (!prepared) throw new Error("Missing synthetic capture");
        detail = { attemptId: prepared.attemptId, taskId: fixtureIdentity(1200), operation: "plugin-tool-query", nextOffset: null,
          items: prepared.items.map((item, index) => ({ scope: { kind: "plugin-tool-query", id: project.metadata.projectId, locale: null },
            resultId: queued ? null : fixtureIdentity(1100 + index), status: { itemId: item.itemId, execution: queued ? "queued" : "succeeded",
              validation: "pending", adoption: "unapplied", cancellationRequested: false, retrySafe: false, diagnostic: null } })),
          progress: { total: prepared.items.length, queued: queued ? prepared.items.length : 0, running: 0,
            succeeded: queued ? 0 : prepared.items.length, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
          recovery: { attemptId: prepared.attemptId, units: [] } };
        prepared.items.forEach((item, index) => {
          const source = item.payload as { rows: { text: string }[] };
          const output = malformedOutput ? { unexpected: [] } : { results: [{ entries: source.rows[0].text === "empty" ? [] : [{ value: "<script>untrusted</script>", note: "Reference 👩🏽‍💻 e\u0301" }] }] };
          const resultId = fixtureIdentity(1100 + index);
          outputs.set(resultId, { ...executionFixture.output, projectId: project.metadata.projectId, attemptId: prepared!.attemptId,
            itemId: item.itemId, resultId, outcome: "succeeded", diagnostic: null, output, plugin: null });
        });
        if (startUnknown) { startUnknown = false; return { unconfirmed: true }; }
        return request.attemptId;
      }
      case "read_plugin_execution_start": {
        const proof = detail && prepared ? { projectId: project.metadata.projectId, attemptId: detail.attemptId,
          inputDigest: prepared.inputDigest, operation: detail.operation, taskId: detail.taskId } : null;
        if (holdStartRead) await holdStartRead;
        if (startReadMode === "error") throw new Error("Original start read unavailable");
        return startReadMode === "invalid" && proof ? { ...proof, inputDigest: "d".repeat(64) } : proof;
      }
      case "read_execution_attempt": return structuredClone(detail);
      case "read_execution_output": return structuredClone(outputs.get(String(request.resultId)) ?? null);
      case "discard_plugin_tool_preflight": prepared = null; return true;
      case "read_execution_cancellation_action": return null;
      case "cancel_execution_task": {
        if (!detail) throw new Error("Missing synthetic task");
        detail.items.forEach(item => { item.status.cancellationRequested = true; item.status.execution = "cancelled-before-dispatch"; });
        detail.progress.queued = 0; detail.progress.cancelled = detail.items.length; return "1";
      }
      default: throw new Error(command);
    }
  });
});
afterEach(cleanup);

async function open(presentation = true) {
  const user = userEvent.setup(), ref = createRef<ResourceHandle>();
  let commands!: WorkbenchCommands, owner!: ReturnType<typeof useResourceDraftSession>;
  function Probe() {
    const currentCommands = useWorkbenchCommands(), currentOwner = useResourceDraftSession();
    useLayoutEffect(() => { commands = currentCommands; owner = currentOwner; });
    return null;
  }
  const ui = (currentProject = project) => <><ResourceWorkbench ref={ref} project={currentProject} disabled={false} onOpenTranslation={() => true} /><Probe /></>;
  const view = render(ui(), project);
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await user.click(screen.getByRole("tab", { name: "Reference queries" }));
  if (presentation) {
    await screen.findByRole("checkbox", { name: /^Term 👩🏽‍💻/ });
    await user.click(screen.getByRole("checkbox", { name: /^Term 👩🏽‍💻/ }));
  }
  return { user, ref, view, ui, commands: () => commands, owner: () => owner.tool, resources: () => owner };
}
function exitNavigation(handle: Awaited<ReturnType<typeof open>>) {
  return new SessionNavigation({ live: () => true, area: () => "resources", show: () => {},
    consumer: async () => handle.ref.current, accept: async () => false,
    inspect: () => {
      const owner = handle.resources(), state = owner.current(), tool = owner.tool;
      return [{ area: "resources", status: owner.inFlight() || state.pending || tool.blocked() ? "blocked"
        : owner.termDirty() || owner.contextDirty() || tool.hasDraft() ? "dirty" : "ready",
        revision: JSON.stringify([state.termSeq, state.contextSeq, tool.draftSequence.current,
          tool.current().capture?.review.inputDigest, tool.current().pending]) }];
    }, blocked: () => {}, busy: () => {}, failure: () => {} });
}
async function review(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review queries" }));
  await screen.findByRole("region", { name: "Captured queries and execution consent" });
}
async function start(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: /^I allow this exact component/ }));
  await user.click(screen.getByRole("button", { name: "Run reference queries" }));
}

it("runs explicit Unicode single/batch inputs and pairs reversed ledger items with their own reference results", async () => {
  const { user } = await open();
  const text = "sound 👩🏽‍💻\ne\u0301";
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), text);
  await user.click(screen.getByRole("button", { name: "Add another query" }));
  await user.type(screen.getByRole("textbox", { name: "Query text 2" }), "empty");
  await review(user);
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_tool")).toBe(false);
  const request = invoke.mock.calls.find(([command]) => command === "prepare_plugin_tool")?.[1].request;
  expect(request.payloads).toEqual([
    { basis: { revision: "é-👩🏽‍💻" }, target: "zh-CN", rows: [{ id: "original-query", text, selected: ["term"] }] },
    { basis: { revision: "é-👩🏽‍💻" }, target: "zh-CN", rows: [{ id: "original-query", text: "empty", selected: ["term"] }] },
  ]);
  await start(user);
  const results = await screen.findByRole("region", { name: "Query results" });
  await within(results).findByText("<script>untrusted</script>");
  expect(screen.getByText("Captured 2 queries. Follow their execution status below.")).toBeVisible();
  expect(screen.queryByText("Captured 2 queries. No component has run yet.")).toBeNull();
  expect(Array.from(results.querySelectorAll("blockquote pre"), value => value.textContent)).toContain(text);
  expect(within(results).getByText("No preference for this explicit selection.")).toBeVisible();
  expect(results.querySelector("script")).toBeNull();
  expect(within(results).getByRole("table")).toBeVisible();
  expect(invoke.mock.calls.some(([command]) => ["save_term", "adopt_execution", "prepare_execution_adoption"].includes(command))).toBe(false);
  const consent = invoke.mock.calls.find(([command]) => command === "start_plugin_tool")?.[1].request;
  expect(consent).toMatchObject({ attemptId: request.attemptId, inputDigest: "c".repeat(64), unsandboxedExecution: true });
  expect(Number(consent.expiresAtMs) - Date.now()).toBeLessThanOrEqual(600_000);
});

it("keeps B typed while A is captured and requires a new review instead of granting consent to stale input", async () => {
  let finish!: () => void;
  holdPreparation = new Promise<void>(resolve => { finish = resolve; });
  const { user } = await open(), input = screen.getByRole("textbox", { name: "Query text 1" });
  await user.type(input, "A");
  await user.click(screen.getByRole("button", { name: "Review queries" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "prepare_plugin_tool")).toBe(true));
  await user.type(input, "B");
  await act(async () => finish());
  await screen.findByRole("region", { name: "Captured queries and execution consent" });
  expect(input).toHaveValue("AB");
  expect(screen.getByRole("button", { name: "Run reference queries" })).toBeDisabled();
  await screen.findByText("You edited the query after capture. Review the current input before granting new execution consent.");
  holdPreparation = null;
  await user.click(screen.getByRole("button", { name: "Review queries" }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /^I allow this exact component/ })).toBeEnabled());
  const requests = invoke.mock.calls.filter(([command]) => command === "prepare_plugin_tool");
  expect(requests[0][1].request.payloads[0].rows[0].text).toBe("A");
  expect(requests[1][1].request.payloads[0].rows[0].text).toBe("AB");
});

it.each(["project", "native-application"])("confirms an unknown %s start by its original input without replay or renewed consent", async mode => {
  if (mode === "native-application") { nativeMode = true; applicationMode = true; inventory = nativeInventory(inventory); }
  const { user, owner } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "single 👩🏽‍💻");
  await review(user);
  if (applicationMode) await user.click(await screen.findByRole("checkbox", { name: /^I allow this exact shared instance/ }));
  startUnknown = true; await start(user);
  await waitFor(() => expect(owner().current().pending).toBeNull());
  expect(owner().current().knownTask).toEqual({ taskId: fixtureIdentity(1200), attemptId: prepared!.attemptId, operation: "plugin-tool-query" });
  const starts = invoke.mock.calls.filter(([command]) => command === "start_plugin_tool");
  expect(starts).toHaveLength(1);
  expect(starts[0][1].request.applicationExecution).toBe(applicationMode);
  const checks = invoke.mock.calls.filter(([command]) => command === "read_plugin_execution_start");
  expect(checks).toHaveLength(1);
  expect(checks[0][1].request).toEqual({ projectId: project.metadata.projectId, sessionToken: project.sessionToken,
    attemptId: starts[0][1].request.attemptId, inputDigest: starts[0][1].request.inputDigest, operation: "plugin-tool-query" });
  expect(owner().current().run?.review).toEqual(prepared);
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("single 👩🏽‍💻");
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: i18n.t("execution.retryPluginStart") })).toBeNull();
});

it("preserves hidden query drafts, prompts before leaving and explicitly discards the captured review", async () => {
  const { user, ref } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "draft e\u0301");
  await review(user);
  await user.click(screen.getByRole("tab", { name: "Terms" }));
  await user.click(screen.getByRole("tab", { name: "Reference queries" }));
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("draft e\u0301");
  let leaving: Promise<boolean> | undefined;
  await act(async () => { leaving = ref.current?.allowLeave(); });
  const dialog = await screen.findByRole("dialog", { name: "Discard query input and leave?" });
  await user.click(within(dialog).getByRole("button", { name: "Stay and keep edits" }));
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("draft e\u0301");
  expect(await leaving).toBe(false);
  await act(async () => { leaving = ref.current?.allowLeave(); });
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard edits and leave" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "discard_plugin_tool_preflight")).toBe(true));
  expect(await leaving).toBe(true);
  expect(invoke.mock.calls.some(([command]) => command === "cancel_execution_task")).toBe(false);
});

it("keeps text when extension availability changes and distinguishes malformed saved output from empty reference results", async () => {
  const { user } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "input kept");
  await review(user); malformedOutput = true; await start(user);
  await screen.findByText("The saved result cannot be shown as reference entries. Review its execution record in Tasks; it is not an empty result.");
  inventory.packageDecisions.forEach(decision => { decision.enabled = false; });
  await user.click(screen.getByRole("button", { name: "Refresh reference packages" }));
  await screen.findByText("Enable a reference package in Extensions and approve its runtime. Your text stays here while the package is unavailable.");
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("input kept");
  expect(screen.getByRole("button", { name: "Review queries" })).toBeDisabled();
});

it("settles an actual navigation exit after discarding the original captured tool draft", async () => {
  const handle = await open(), navigation = exitNavigation(handle);
  await handle.user.type(screen.getByRole("textbox", { name: "Query text 1" }), "original draft 👩🏽‍💻");
  await review(handle.user);
  const capture = handle.owner().current().capture;
  expect(capture).not.toBeNull();
  let permit: SessionExitPermit | null | undefined;
  await act(async () => { void navigation.prepareExit().then(value => { permit = value; }); });
  const dialog = await screen.findByRole("dialog", { name: "Discard query input and leave?" });
  await handle.user.click(within(dialog).getByRole("button", { name: "Discard edits and leave" }));
  await waitFor(() => expect(permit).toBeDefined());
  expect(permit?.current()).toBe(true);
  expect(handle.owner().current().capture).toBeNull();
  expect(handle.owner().current().pending).toBeNull();
  expect(handle.owner().current().rows.map(row => row.text)).toEqual([""]);
  const discards = invoke.mock.calls.filter(([command]) => command === "discard_plugin_tool_preflight");
  expect(discards).toHaveLength(1);
  expect(discards[0][1].request).toEqual({ projectId: project.metadata.projectId,
    sessionToken: project.sessionToken, attemptId: capture!.review.attemptId });
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => ["start_plugin_tool", "cancel_execution_task"].includes(command))).toBe(false);
  permit?.release();
});

it.each(["tool-input", "resource-input", "retired-intent"] as const)("rejects exit after %s changes during the checked Tool discard", async change => {
  const handle = await open(), navigation = exitNavigation(handle);
  await handle.user.type(screen.getByRole("textbox", { name: "Query text 1" }), "original A");
  await review(handle.user);
  const original = invoke.getMockImplementation()!;
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "discard_plugin_tool_preflight") await held;
    return original(command, args);
  });
  let permit: SessionExitPermit | null | undefined;
  await act(async () => { void navigation.prepareExit().then(value => { permit = value; }); });
  const dialog = await screen.findByRole("dialog", { name: "Discard query input and leave?" });
  await handle.user.click(within(dialog).getByRole("button", { name: "Discard edits and leave" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "discard_plugin_tool_preflight")).toHaveLength(1));
  await act(async () => {
    if (change === "tool-input") { handle.owner().setRows([{ id: 0, text: "new B 👩🏽‍💻" }]); handle.owner().edit(); }
    else if (change === "resource-input") handle.resources().editTerm({ ...handle.resources().current().termDraft, target: "new B" });
    else navigation.dispose();
    finish();
  });
  await waitFor(() => expect(permit).toBeNull());
  expect(handle.owner().current().capture).toBeNull();
  expect(handle.owner().current().pending).toBeNull();
  expect(handle.owner().current().rows.map(row => row.text)).toEqual([change === "tool-input" ? "new B 👩🏽‍💻" : "original A"]);
  if (change === "resource-input") expect(handle.resources().current().termDraft.target).toBe("new B");
  expect(invoke.mock.calls.filter(([command]) => command === "discard_plugin_tool_preflight")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => ["start_plugin_tool", "cancel_execution_task"].includes(command))).toBe(false);
});

it("retains unknown Tool discard and refuses another actual exit intent", async () => {
  const handle = await open(), navigation = exitNavigation(handle);
  await handle.user.type(screen.getByRole("textbox", { name: "Query text 1" }), "kept A");
  await review(handle.user);
  const capture = handle.owner().current().capture, original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "discard_plugin_tool_preflight"
    ? Promise.resolve({ unconfirmed: true }) : original(command, args));
  let permit: SessionExitPermit | null | undefined;
  await act(async () => { void navigation.prepareExit().then(value => { permit = value; }); });
  const dialog = await screen.findByRole("dialog", { name: "Discard query input and leave?" });
  await handle.user.click(within(dialog).getByRole("button", { name: "Discard edits and leave" }));
  await waitFor(() => expect(handle.owner().current().uncertain).toBe(true));
  await handle.user.click(within(dialog).getByRole("button", { name: "Stay and keep edits" }));
  await waitFor(() => expect(permit).toBeNull());
  const pending = handle.owner().current().pending;
  expect(pending).toEqual({ kind: "discard", request: { projectId: project.metadata.projectId,
    sessionToken: project.sessionToken, attemptId: capture!.review.attemptId } });
  expect(handle.owner().current().capture).toBe(capture);
  expect(handle.owner().current().rows.map(row => row.text)).toEqual(["kept A"]);
  await act(async () => { expect(await navigation.prepareExit()).toBeNull(); });
  expect(handle.owner().current().pending).toBe(pending);
  expect(invoke.mock.calls.filter(([command]) => command === "discard_plugin_tool_preflight")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
});

it("does not pick the first of multiple installed providers and reports explicit selection and text limits", async () => {
  const other = { ...inventory.packages[0], plugin: { ...inventory.packages[0].plugin, id: "other-reference" }, packageDigest: "d".repeat(64) };
  inventory.packages.push(other); inventory.packageDecisions.push({ plugin: other.plugin, packageDigest: other.packageDigest, origin: other.origin, enabled: true });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_plugin_package"
    ? Promise.resolve({ ...toolQueryPackage, packageDigest: (args.request as { packageDigest: string }).packageDigest,
      manifest: { ...toolQueryPackage.manifest, plugin: (args.request as { plugin: object }).plugin } }) : original(command, args));
  const user = userEvent.setup();
  render(<ResourceWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await user.click(screen.getByRole("tab", { name: "Reference queries" }));
  const chooser = screen.getByRole("combobox", { name: "Reference package" });
  await waitFor(() => expect(within(chooser).getAllByRole("option")).toHaveLength(3));
  expect(chooser).toHaveValue(""); expect(invoke.mock.calls.some(([command]) => command === "read_plugin_tool")).toBe(false);
  await user.selectOptions(chooser, "a".repeat(64) + ":agent-query-tool");
  await screen.findByRole("checkbox", { name: /^Term 👩🏽‍💻/ });
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "x".repeat(257));
  await user.click(screen.getByRole("button", { name: "Review queries" }));
  await screen.findByText("This input exceeds the package’s limit. Shorten the text or reduce the batch; your input is preserved.");
  expect(invoke.mock.calls.some(([command]) => command === "prepare_plugin_tool")).toBe(false);
});

it("requests cancellation through the original task and preserves its execution record", async () => {
  const { user } = await open(); queued = true;
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "queued query");
  await review(user); await start(user);
  await user.click(await screen.findByRole("button", { name: "Request cancellation" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "cancel_execution_task")).toBe(true));
  await screen.findByText("Cancelled before starting");
  const request = invoke.mock.calls.find(([command]) => command === "cancel_execution_task")?.[1].request;
  expect(request).toMatchObject({ taskId: fixtureIdentity(1200), projectId: project.metadata.projectId, sessionToken: project.sessionToken });
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("queued query");
});

it("appends editor text without replacing an existing draft or inheriting its reviewed consent", async () => {
  const { user, ref } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "existing reference draft");
  await review(user);
  await user.click(screen.getByRole("checkbox", { name: /^I allow this exact component/ }));
  let added: boolean | undefined;
  await act(async () => { added = ref.current?.addQueryText("👩🏽‍💻\ne\u0301"); });
  expect(added).toBe(true);
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("existing reference draft");
  expect(screen.getByRole("textbox", { name: "Query text 2" })).toHaveValue("👩🏽‍💻\ne\u0301");
  expect(screen.getByRole("checkbox", { name: /^I allow this exact component/ })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Run reference queries" })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_tool")).toBe(false);
});


it("keeps the complete unknown tool action after the consumer unmounts and a later retry is rejected", async () => {
  const { user, ref, view, ui } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "original Unicode 👩🏽‍💻");
  await review(user); startBeforeEnqueue = true; await start(user);
  await screen.findByRole("button", { name: i18n.t("execution.retryPluginStart") });
  const first = invoke.mock.calls.find(([command]) => command === "start_plugin_tool")![1];
  const identities = invoke.mock.calls.filter(([command]) => command === "create_execution_identity").length;
  const native = invoke.getMockImplementation()!;
  let rejectRetry = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "start_plugin_tool" && rejectRetry) { rejectRetry = false; return Promise.reject(errorFixture.errors[1]); }
    return native(command, args);
  });
  view.rerender(<span>Consumer is unmounted</span>, project);
  const reads = invoke.mock.calls.filter(([command]) => command === "read_execution_attempt").length;
  await refreshWorkbenchReads();
  expect(invoke.mock.calls.filter(([command]) => command === "read_execution_attempt")).toHaveLength(reads);
  view.rerender(ui(), project);
  await user.click(await screen.findByRole("button", { name: i18n.t("execution.retryPluginStart") }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_tool")).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("execution.retryPluginStart") })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("original Unicode 👩🏽‍💻");
  let allowed: boolean | undefined;
  await act(async () => { allowed = await ref.current?.allowLeave(); });
  expect(allowed).toBe(false);
  await user.click(screen.getByRole("button", { name: i18n.t("execution.retryPluginStart") }));
  await waitFor(() => expect(screen.queryByRole("button", { name: i18n.t("execution.retryPluginStart") })).toBeNull());
  const retries = invoke.mock.calls.filter(([command]) => command === "start_plugin_tool");
  expect(retries).toHaveLength(3);
  retries.forEach(([, args]) => expect(args).toEqual(first));
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_plugin_tool")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(identities);
});


it("accepts only a complete cloned original tool recovery payload and retains its first unknown after rejection", async () => {
  const { user, commands, owner } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "original query");
  await review(user); startReadMode = "error"; startBeforeEnqueue = true; await start(user);
  await waitFor(() => { expect(owner().current().checkingStart).toBe(false); expect(owner().current().failure).not.toBeNull(); });
  const original = owner().current().pending!;
  expect(original.kind).toBe("start");
  const native = invoke.getMockImplementation()!;
  let rejectRetry = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "start_plugin_tool" && rejectRetry) { rejectRetry = false; return Promise.reject(errorFixture.errors[1]); }
    return native(command, args);
  });
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "resources" as const };
  const payload = { kind: "resource-tool-pending" as const, intent: structuredClone(original) };
  expect(commands().dispatch("resource.retry-tool", scope, payload)).toBe(false);
  for (const mutate of [
    (value: typeof payload) => { if (value.intent.kind === "start") value.intent.request.expiresAtMs = "1"; },
    (value: typeof payload) => { if (value.intent.kind === "start") value.intent.review.inputDigest = "d".repeat(64); },
    (value: typeof payload) => { if (value.intent.kind === "start") value.intent.sequence++; },
  ]) {
    const changed = structuredClone(payload); mutate(changed);
    expect(commands().dispatch("resource.check-tool-start", scope, changed)).toBe(false);
    expect(commands().dispatch("resource.retry-tool", scope, changed)).toBe(false);
  }
  startReadMode = "normal";
  await act(async () => { expect(commands().dispatch("resource.check-tool-start", scope, payload)).toBe(true); });
  await waitFor(() => expect(owner().current().startRetryAllowed).toBe(true));
  await act(async () => { expect(commands().dispatch("resource.retry-tool", scope, payload)).toBe(true); });
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_tool")).toHaveLength(2));
  expect(owner().current().pending).toEqual(original); expect(owner().current().uncertain).toBe(true);
  const changed = structuredClone(payload);
  if (changed.intent.kind !== "start") throw new Error("Expected original start");
  changed.intent.request.expiresAtMs = "1";
  expect(commands().dispatch("resource.retry-tool", scope, changed)).toBe(false);
  await user.click(await screen.findByRole("button", { name: i18n.t("execution.retryPluginStart") }));
  await waitFor(() => expect(owner().current().pending).toBeNull());
  const requests = invoke.mock.calls.filter(([command]) => command === "start_plugin_tool").map(([, args]) => args.request);
  expect(requests).toHaveLength(3); requests.forEach(request => expect(request).toEqual(requests[0]));
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(2);
});

it("rejects a changed task association for the same tool attempt and keeps cancellation bound to its original task", async () => {
  const { user, owner } = await open(); queued = true;
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "queued original");
  await review(user); await start(user);
  await screen.findByRole("button", { name: "Request cancellation" });
  await waitFor(() => expect(owner().current().knownTask?.taskId).toBe(fixtureIdentity(1200)));
  if (!detail) throw new Error("Expected original attempt");
  detail = { ...structuredClone(detail), taskId: fixtureIdentity(1201) };
  await refreshWorkbenchReads();
  await screen.findByText(i18n.t("toolQuery.recordReadFailed"));
  expect(owner().current().knownTask).toMatchObject({ taskId: fixtureIdentity(1200), attemptId: detail.attemptId });
  await user.click(screen.getByRole("button", { name: "Request cancellation" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "cancel_execution_task")).toHaveLength(1));
  const request = invoke.mock.calls.find(([command]) => command === "cancel_execution_task")![1].request;
  expect(request.taskId).toBe(fixtureIdentity(1200)); expect(request.taskId).not.toBe(detail.taskId);
  expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_tool")).toHaveLength(1);
});

it("checks an original tool cancellation through the shared feedback before an explicit retry",async()=>{
  const {user}=await open();queued=true;
  await user.type(screen.getByRole("textbox",{name:"Query text 1"}),"preserved query");await review(user);await start(user);
  const original=invoke.getMockImplementation()!;let writes=0,reads=0;
  invoke.mockImplementation((command:string,args:unknown)=>command==="cancel_execution_task"&&++writes===1?Promise.reject(new Error("Lost ACK"))
    :command==="read_execution_cancellation_action"?++reads===1?Promise.reject(new Error("Automatic check unavailable")):Promise.resolve(null):original(command,args));
  await user.click(await screen.findByRole("button",{name:"Request cancellation"}));
  await screen.findByText(i18n.t("execution.cancelUnknown"));expect(screen.queryByRole("button",{name:i18n.t("execution.retryCancellation")})).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:i18n.t("execution.checkCancellation")}));
  await user.click(await screen.findByRole("button",{name:i18n.t("execution.retryCancellation")}));
  await screen.findByText(i18n.t("execution.cancelRecorded"));
  const requests=invoke.mock.calls.filter(([name])=>name==="cancel_execution_task").map(([,args])=>args.request);
  expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);
  expect(invoke.mock.calls.filter(([name])=>name==="read_execution_cancellation_action").map(([,args])=>args.request)).toEqual([requests[0],requests[0]]);
  expect(screen.getByRole("textbox",{name:"Query text 1"})).toHaveValue("preserved query");
});


it("keeps a failed saved-result read distinct from empty or malformed output and retries only the original read", async () => {
  const { user } = await open(), native = invoke.getMockImplementation()!;
  let unavailable = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_execution_output" && unavailable) return Promise.reject(new Error("Result read unavailable"));
    return native(command, args);
  });
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "original input kept");
  await review(user); await start(user);
  const notice = await screen.findByText(i18n.t("toolQuery.outputReadFailed"));
  expect(screen.queryByText(i18n.t("toolQuery.invalidResult"))).toBeNull();
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("original input kept");
  const before = invoke.mock.calls.filter(([command]) => command === "read_execution_output").length;
  unavailable = false;
  await user.click(within(notice.parentElement!).getByRole("button", { name: i18n.t("toolQuery.retryRead") }));
  await within(await screen.findByRole("region", { name: "Query results" })).findByText("<script>untrusted</script>");
  const reads = invoke.mock.calls.filter(([command]) => command === "read_execution_output").map(([, args]) => args.request);
  expect(reads).toHaveLength(before + 1); reads.forEach(request => expect(request).toEqual(reads[0]));
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_plugin_tool")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_tool")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(2);
});

it.each(["missing-selected", "duplicate-member", "external-member", "ordinary-roster"])("retains the original preparation when the returned component roster is %s", async mode => {
  applicationMode = mode !== "ordinary-roster";
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const response = await original(command, args);
    if (command !== "prepare_plugin_tool") return response;
    const forged = structuredClone(response) as PluginToolPreflight;
    if (mode === "missing-selected") forged.applicationCapabilities.shift();
    else if (mode === "duplicate-member") forged.applicationCapabilities.push(structuredClone(forged.applicationCapabilities[0]));
    else if (mode === "external-member") forged.applicationCapabilities[1].capability.effect = "external";
    else forged.applicationCapabilities = [{ contributionId: toolQueryView.binding.capability.provider.contributionId, capability: structuredClone(toolQueryView.binding.capability.declaration) }];
    return forged;
  });
  const { user, owner } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "keep the exact draft");
  await user.click(screen.getByRole("button", { name: "Review queries" }));
  await waitFor(() => expect(owner().current().uncertain).toBe(true));
  expect(owner().current().capture).toBeNull();
  expect(owner().current().pending?.kind).toBe("prepare");
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("keep the exact draft");
  expect(screen.queryByRole("checkbox", { name: /^I allow this exact shared instance/ })).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_tool")).toBe(false);
});

it.each(["javascript", "native-worker"])("requires independent %s application lifetime consent and preserves drafts/results after an unknown exact stop", async runtime => {
  applicationMode = true;
  if (runtime === "native-worker") { nativeMode = true; inventory = nativeInventory(inventory); }
  const { user, owner } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "kept query");
  expect(invoke.mock.calls.some(([command]) => ["prepare_plugin_tool", "start_plugin_tool", "read_application_plugin_instance"].includes(command))).toBe(false);
  await review(user);
  const lifetime = await screen.findByRole("checkbox", { name: /^I allow this exact shared instance/ });
  if (nativeMode) {
    expect(screen.queryByText("secondary.call")).toBeNull();
    expect(screen.getByText(i18n.t("toolQuery.applicationNativeHelp"))).toBeVisible();
    expect(prepared?.tool.environment).toEqual(nativeEnvironment);
    expect(prepared?.applicationCapabilities).toHaveLength(1);
  } else expect(screen.getByText("secondary.call")).toBeVisible();
  expect(screen.getByText(toolQueryView.binding.capability.provider.contributionId)).toBeVisible();
  expect(screen.getByText(i18n.t("toolQuery.applicationCapabilities"))).toBeVisible();
  const run = screen.getByRole("button", { name: "Run reference queries" });
  await user.click(screen.getByRole("checkbox", { name: /^I allow this exact component/ }));
  expect(run).toBeDisabled();
  await user.click(lifetime);
  expect(run).toBeEnabled();
  await user.click(run);
  await screen.findByRole("region", { name: "Query results" });
  expect(invoke.mock.calls.find(([command]) => command === "start_plugin_tool")?.[1].request.applicationExecution).toBe(true);
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), " plus draft");
  unknownStop = true;
  const stop = await screen.findByRole("button", { name: "Stop shared instance" });
  await waitFor(() => expect(stop).toBeEnabled());
  await user.click(stop);
  await screen.findByRole("button", { name: "Check the original action" });
  expect(owner().current().pending?.kind).toBe("stop-instance");
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("kept query plus draft");
  await user.click(screen.getByRole("button", { name: "Check the original action" }));
  await waitFor(() => expect(owner().current().pending).toBeNull());
  const stops = invoke.mock.calls.filter(([command]) => command === "stop_application_plugin_instance");
  expect(stops).toHaveLength(2);
  expect(stops[1][1]).toEqual(stops[0][1]);
  expect(stops[0][1].request.basis).toEqual(applicationBasis);
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("kept query plus draft");
  expect(screen.getByRole("region", { name: "Query results" })).toBeVisible();
  expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_tool")).toHaveLength(1);
});

it("keeps an approved Native package unavailable without its exact Host approval and retains query input", async () => {
  nativeMode = true; applicationMode = true; inventory = nativeInventory(inventory, false);
  const { user, owner } = await open(false);
  const input = screen.getByRole("textbox", { name: "Query text 1" });
  await user.type(input, "not authorized 👩🏽‍💻 e\u0301");
  await screen.findByText(i18n.t("toolQuery.unavailable"));
  expect(screen.getByRole("button", { name: "Review queries" })).toBeDisabled();
  expect(owner().current().capture).toBeNull();
  expect(input).toHaveValue("not authorized 👩🏽‍💻 e\u0301");
  expect(invoke.mock.calls.some(([command]) => ["read_plugin_tool", "prepare_plugin_tool", "start_plugin_tool", "read_application_plugin_instance"].includes(command))).toBe(false);
});

it("refuses a multi-callable Native application acknowledgement while keeping its original preparation and draft", async () => {
  nativeMode = true; applicationMode = true; inventory = nativeInventory(inventory);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const response = await original(command, args);
    if (command !== "prepare_plugin_tool") return response;
    const forged: unknown = response;
    if (!validateResponseToolPreflight(forged)) throw new Error("Invalid synthetic Native tool preflight");
    forged.applicationCapabilities.push({ contributionId: "not-supported.second-call", capability: structuredClone(toolQueryView.binding.capability.declaration) });
    return forged;
  });
  const { user, owner } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "keep Native input");
  await user.click(screen.getByRole("button", { name: "Review queries" }));
  await waitFor(() => expect(owner().current().uncertain).toBe(true));
  expect(owner().current().capture).toBeNull();
  expect(owner().current().pending?.kind).toBe("prepare");
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("keep Native input");
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_tool")).toBe(false);
});


it.each(["error", "invalid"] as const)("preserves an accepted original start after a %s proof and reconciles without another write", async mode => {
  const { user, owner } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "original evidence");
  await review(user); startReadMode = mode; startUnknown = true; await start(user);
  await waitFor(() => { expect(owner().current().checkingStart).toBe(false); expect(owner().current().failure).not.toBeNull(); });
  const original = owner().current().pending;
  expect(original?.kind).toBe("start"); expect(owner().current().uncertain).toBe(true);
  expect(owner().current().startRetryAllowed).toBe(false);
  expect(screen.queryByRole("button", { name: i18n.t("execution.retryPluginStart") })).toBeNull();
  // A broad progress refresh cannot confirm this exact original input.
  await refreshWorkbenchReads();
  expect(owner().current().pending).toBe(original);
  startReadMode = "normal";
  await user.click(screen.getByRole("button", { name: i18n.t("execution.checkPluginStart") }));
  await waitFor(() => expect(owner().current().pending).toBeNull());
  expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_tool")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "read_plugin_execution_start")).toHaveLength(2);
});

it("does not read or retain a fresh formally rejected start", async () => {
  const { user, owner } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "rejected input"); await review(user);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "start_plugin_tool"
    ? Promise.reject(errorFixture.errors[1]) : original(command, args));
  await start(user);
  await waitFor(() => expect(owner().current().failure).not.toBeNull());
  expect(owner().current().pending).toBeNull();
  expect(invoke.mock.calls.filter(([command]) => command === "read_plugin_execution_start")).toHaveLength(0);
});

it("finishes the original read while its consumer is hidden without issuing a new start", async () => {
  const { user, owner, view, ui } = await open(); let finish!: () => void;
  holdStartRead = new Promise<void>(resolve => { finish = resolve; });
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "hidden original"); await review(user);
  startUnknown = true; await start(user);
  await waitFor(() => expect(owner().current().checkingStart).toBe(true));
  view.rerender(<span>Consumer hidden</span>, project);
  await act(async () => { finish(); });
  expect(owner().current().pending).toBeNull();
  view.rerender(ui(), project);
  expect(await screen.findByRole("textbox", { name: "Query text 1" })).toHaveValue("hidden original");
  expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_tool")).toHaveLength(1);
});

it.each(["retire", "replace"])("ignores a late proof after session %s", async mode => {
  const handle = await open(); const { user, owner, view, ui } = handle; let finish!: () => void;
  holdStartRead = new Promise<void>(resolve => { finish = resolve; });
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "retired input"); await review(user);
  startUnknown = true; await start(user);
  await waitFor(() => expect(owner().current().checkingStart).toBe(true));
  const previous = owner(), pending = previous.current().pending;
  if (mode === "retire") view.unmount();
  else { const replacement = { ...project, sessionToken: "replacement-query-session" }; view.rerender(ui(replacement), replacement); }
  await act(async () => { finish(); });
  expect(previous.current().pending).toBe(pending);
  if (mode === "replace") { expect(owner().current().pending).toBeNull(); expect(owner().current().run).toBeNull(); }
  expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_tool")).toHaveLength(1);
});
