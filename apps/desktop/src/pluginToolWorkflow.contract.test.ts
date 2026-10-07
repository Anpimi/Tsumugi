import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/pluginToolWorkflow.contract.json";
import { pluginCommands } from "./pluginCommands";
import { executionCommands } from "./executionCommands";
import { hasUnknownOutcome } from "./projectCommands";
import { validateRequestTool, validateResponseTool } from "./generated/plugins.validators";
import { validateRequestToolPrepare, validateRequestToolStart, validateRequestToolDiscard, validateResponseToolPreflight } from "./generated/execution.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it("shares exact installed tool choices and fixed opaque query payloads with Rust", () => {
  expect(validateRequestTool(fixture.request)).toBe(true);
  expect(validateResponseTool(fixture.view)).toBe(true);
  expect(validateRequestToolPrepare(fixture.prepare)).toBe(true);
  expect(validateRequestToolStart(fixture.start)).toBe(true);
  expect(validateRequestToolDiscard(fixture.discard)).toBe(true);
  expect(validateResponseToolPreflight(fixture.preflight)).toBe(true);
  expect(fixture.preflight.items[0].payload).toEqual(fixture.prepare.payloads[0]);
  expect(fixture.view.binding.capability.provider.plugin).toEqual(fixture.request.package.plugin);
  expect(fixture.view.binding.capability.declaration.effect).toBe("read-only");
  for (const property of ["directory", "origin", "environment", "grantId", "approved"]) {
    expect(validateRequestTool({ ...fixture.request, [property]: true })).toBe(false);
    expect(validateRequestToolPrepare({ ...fixture.prepare, [property]: true })).toBe(false);
  }
  expect(validateRequestToolPrepare({ ...fixture.prepare, parentAttemptId: fixture.prepare.attemptId })).toBe(false);
  expect(validateResponseTool({ ...fixture.view, settingsRevision: 1 })).toBe(false);
  expect(validateResponseToolPreflight({ ...fixture.preflight, grantId: fixture.start.grantId })).toBe(false);
  expect(validateResponseToolPreflight({ ...fixture.preflight, items: [{ ...fixture.preflight.items[0], itemId: "unbound" }] })).toBe(false);
});

it("uses central typed adapters for discovery, preparation and the original consent", async () => {
  invoke.mockResolvedValueOnce(fixture.view);
  await expect(pluginCommands.tool(fixture.request)).resolves.toEqual(fixture.view);
  expect(invoke).toHaveBeenLastCalledWith("read_plugin_tool", { request: fixture.request });
  invoke.mockResolvedValueOnce(fixture.preflight);
  await expect(executionCommands.prepareTool(fixture.prepare)).resolves.toEqual(fixture.preflight);
  expect(invoke).toHaveBeenLastCalledWith("prepare_plugin_tool", { request: fixture.prepare });
  invoke.mockResolvedValueOnce(fixture.start.attemptId);
  await expect(executionCommands.startTool(fixture.start)).resolves.toBe(fixture.start.attemptId);
  expect(invoke).toHaveBeenLastCalledWith("start_plugin_tool", { request: fixture.start });
  invoke.mockResolvedValueOnce(true);
  await expect(executionCommands.discardTool(fixture.discard)).resolves.toBe(true);
  expect(invoke).toHaveBeenLastCalledWith("discard_plugin_tool_preflight", { request: fixture.discard });
  expect(invoke).toHaveBeenCalledTimes(4);
});

it("keeps malformed start acknowledgements unknown without replaying or renewing consent", async () => {
  invoke.mockResolvedValueOnce({ permissionGranted: true });
  const failure = await executionCommands.startTool(fixture.start).catch(error => error);
  expect(hasUnknownOutcome(failure)).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("start_plugin_tool", { request: fixture.start });
  invoke.mockResolvedValueOnce({ ...fixture.preflight, tool: { ...fixture.view, runtimeOrigin: undefined } });
  await expect(executionCommands.prepareTool(fixture.prepare)).rejects.toThrow("Invalid IPC response: prepare_plugin_tool");
});
