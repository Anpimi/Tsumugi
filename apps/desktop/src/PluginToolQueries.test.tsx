import { createRef } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceWorkbench, type ResourceHandle } from "./ResourceWorkbench";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { toolQueryInventory, toolQueryPackage, toolQueryView } from "./testSupport/pluginToolFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";
import type { ProjectView } from "./projectCommands";
import type { AttemptDetail, PluginToolPrepareRequest, PluginToolPreflight, ResultEnvelope } from "./executionCommands";
import executionFixture from "../test/fixtures/executionCommands.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "synthetic-query-session", locator: "/synthetic/project", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(900), displayName: "Query demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let serial: number, inventory: typeof toolQueryInventory, prepared: PluginToolPreflight | null, detail: AttemptDetail | null;
let outputs: Map<string, ResultEnvelope>, startUnknown: boolean, malformedOutput: boolean, queued: boolean;
let holdPreparation: Promise<void> | null;

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  serial = 901; inventory = structuredClone(toolQueryInventory); prepared = null; detail = null;
  outputs = new Map(); startUnknown = false; malformedOutput = false; queued = false; holdPreparation = null;
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const request = args?.request;
    switch (command) {
      case "read_content_scope": return { revision: "0", currentSnapshot: null };
      case "read_terms": case "list_resource_captures": return [];
      case "read_plugin_inventory": return structuredClone(inventory);
      case "read_plugin_package": return structuredClone(toolQueryPackage);
      case "read_plugin_tool": return structuredClone(toolQueryView);
      case "create_execution_identity": return fixtureIdentity(serial++);
      case "prepare_plugin_tool": {
        const input = request as unknown as PluginToolPrepareRequest;
        if (holdPreparation) await holdPreparation;
        prepared = { attemptId: input.attemptId, inputDigest: "c".repeat(64), tool: structuredClone(toolQueryView),
          items: input.payloads.map((payload, index) => ({ itemId: fixtureIdentity(1000 + index), payload })).reverse() };
        return structuredClone(prepared);
      }
      case "start_plugin_tool": {
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
      case "read_execution_attempt": return structuredClone(detail);
      case "read_execution_output": return structuredClone(outputs.get(String(request.resultId)) ?? null);
      case "discard_plugin_tool_preflight": prepared = null; return true;
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

async function open() {
  const user = userEvent.setup(), ref = createRef<ResourceHandle>();
  render(<ResourceWorkbench ref={ref} project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await user.click(screen.getByRole("tab", { name: "Reference queries" }));
  await screen.findByRole("checkbox", { name: /^Term 👩🏽‍💻/ });
  await user.click(screen.getByRole("checkbox", { name: /^Term 👩🏽‍💻/ }));
  return { user, ref };
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

it("retains the exact grant and request after an unknown start acknowledgement and blocks leaving until reconciliation", async () => {
  const { user, ref } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "single");
  await review(user); startUnknown = true; await start(user);
  const retry = await screen.findByRole("button", { name: "Check the original action" });
  let allowed: boolean | undefined;
  await act(async () => { allowed = await ref.current?.allowLeave(); });
  expect(allowed).toBe(false);
  await user.click(retry);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Check the original action" })).toBeNull());
  const starts = invoke.mock.calls.filter(([command]) => command === "start_plugin_tool");
  expect(starts).toHaveLength(2); expect(starts[1][1]).toEqual(starts[0][1]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(2);
});

it("preserves hidden query drafts, prompts before leaving and explicitly discards the captured review", async () => {
  const { user } = await open();
  await user.type(screen.getByRole("textbox", { name: "Query text 1" }), "draft e\u0301");
  await review(user);
  await user.click(screen.getByRole("tab", { name: "Terms" }));
  await user.click(screen.getByRole("tab", { name: "Reference queries" }));
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("draft e\u0301");
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  const dialog = await screen.findByRole("dialog", { name: "Discard query input and leave?" });
  await user.click(within(dialog).getByRole("button", { name: "Stay and keep edits" }));
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("draft e\u0301");
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard edits and leave" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "discard_plugin_tool_preflight")).toBe(true));
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
