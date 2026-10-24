import { useLayoutEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider, pluginInventoryReadKey, pluginRepositoriesReadKey, useApplicationQueryClient } from "./ApplicationReadProvider";
import { PluginManager } from "./PluginManager";
import { pluginCommands, type PluginEnableRequest, type PluginInventoryView, type PluginRepositorySourcesView } from "./pluginCommands";
import { validateRequestEnable, validateResponseInventory } from "./generated/plugins.validators";
import { i18n } from "./i18n";
import inventoryFixture from "../test/fixtures/pluginInventory.contract.json";
import packageFixture from "../test/fixtures/pluginPackage.contract.json";

const invoke = vi.hoisted(() => vi.fn<(command: string, envelope: { request: unknown }) => Promise<unknown>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const onBusy = vi.fn();
let client: ReturnType<typeof useApplicationQueryClient>;
const emptyFixture: unknown = { ...inventoryFixture.empty, runtimeOffers: [] };
if (!validateResponseInventory(emptyFixture)) throw new Error("Invalid inventory fixture");
const empty: PluginInventoryView = emptyFixture;
type FactKind = "inventory" | "repositories";
const keyFor = (kind: FactKind) => kind === "inventory" ? pluginInventoryReadKey : pluginRepositoriesReadKey;
const commandFor = (kind: FactKind) => kind === "inventory" ? "read_plugin_inventory" : "read_plugin_repositories";
function installed(name = "current-plugin", enabled = false): PluginInventoryView {
  const plugin = { ...packageFixture.manifest.plugin, id: name }, origin = { sourceId: "manual-local", publisherId: "manual-approval" };
  return { ...empty, settingsRevision: "1", packages: [{ plugin, packageDigest: packageFixture.packageDigest, origin,
    state: "sealed", originalInstallAction: "00000000-0000-4000-8000-000000000001" }],
    packageDecisions: [{ plugin, packageDigest: packageFixture.packageDigest, origin, enabled }] };
}
function repositories(name: string): PluginRepositorySourcesView {
  return { sources: [{ sourceId: `synthetic-${name}`, displayName: name, rootFingerprint: "a".repeat(64),
    actionId: null, expectedRevision: null, revision: "1", state: "verified" }] };
}
const facts = (kind: FactKind, name: string) => kind === "inventory" ? installed(name) : repositories(name);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);
function CaptureClient() {
  const value = useApplicationQueryClient();
  useLayoutEffect(() => { client = value; });
  return null;
}
function Companion({ active = true }: { active?: boolean }) {
  const current = useApplicationQueryClient();
  const query = useQuery({ queryKey: pluginInventoryReadKey, enabled: active, queryFn: async ({ signal }) => {
    const value = await pluginCommands.inventory();
    if (signal.aborted) throw new Error("Companion read cancelled");
    return value;
  } }, current);
  return <output aria-label="Companion inventory">{query.data?.packages[0]?.plugin.id ?? "waiting"}</output>;
}
function view(companion = false, manager = true) {
  return <ApplicationReadProvider><CaptureClient />{companion ? <Companion /> : null}
    {manager ? <PluginManager disabled={false} onBusyChange={onBusy} /> : null}</ApplicationReadProvider>;
}
async function open(user: ReturnType<typeof userEvent.setup>, kind: FactKind) {
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  if (kind === "repositories") await user.click(await screen.findByRole("button", { name: "Signed repositories" }));
}
function defaults(command: string) {
  if (command === "read_plugin_inventory") return installed();
  if (command === "read_plugin_repositories") return { sources: [] };
  throw new Error(`Unexpected command: ${command}`);
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  onBusy.mockReset(); invoke.mockReset().mockImplementation(async command => defaults(command));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["inventory", "repositories"] as const)("cancels the last hidden %s wait, reads B on reopening and rejects late A", async kind => {
  const old = deferred<ReturnType<typeof facts>>(), fresh = deferred<ReturnType<typeof facts>>();
  let reads = 0;
  invoke.mockImplementation(async command => command === commandFor(kind) ? (++reads === 1 ? old.promise : fresh.promise) : defaults(command));
  const user = userEvent.setup(); render(view()); await open(user, kind);
  await waitFor(() => expect(reads).toBe(1));
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(client.getQueryState(keyFor(kind))?.isInvalidated).toBe(true));
  act(() => window.dispatchEvent(new Event("focus")));
  await act(async () => {});
  expect(reads).toBe(1);
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await waitFor(() => expect(reads).toBe(2));
  const current = facts(kind, "current-b");
  await act(async () => { fresh.resolve(current); await fresh.promise; });
  expect(await screen.findByText("current-b")).toBeVisible();
  await act(async () => { old.resolve(facts(kind, "retired-a")); await old.promise; });
  expect(screen.queryByText("retired-a")).not.toBeInTheDocument();
  expect(client.getQueryState(keyFor(kind))).toMatchObject({ data: current, status: "success", fetchStatus: "idle", isInvalidated: false });
  expect(invoke.mock.calls.every(([command]) => command.startsWith("read_plugin_"))).toBe(true);
});

it.each(["inventory", "repositories"] as const)("keeps a failed reopened %s check after late A succeeds", async kind => {
  const old = deferred<ReturnType<typeof facts>>(), fresh = deferred<ReturnType<typeof facts>>();
  let reads = 0;
  invoke.mockImplementation(async command => command === commandFor(kind) ? (++reads === 1 ? old.promise : fresh.promise) : defaults(command));
  const user = userEvent.setup(); render(view()); await open(user, kind);
  await waitFor(() => expect(reads).toBe(1));
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await waitFor(() => expect(reads).toBe(2));
  const error = new Error("Current local read unavailable");
  await act(async () => { fresh.reject(error); });
  expect(await screen.findByText(i18n.t(kind === "inventory" ? "plugins.readFailed" : "plugins.repositoryReadFailed"))).toBeVisible();
  await act(async () => { old.resolve(facts(kind, "retired-a")); await old.promise; });
  expect(screen.queryByText("retired-a")).not.toBeInTheDocument();
  expect(client.getQueryState(keyFor(kind))).toMatchObject({ status: "error", error, data: undefined });
});

it.each(["inventory", "repositories"] as const)("replaces a first pending %s read on focus without accepting its old response", async kind => {
  const old = deferred<ReturnType<typeof facts>>(), fresh = deferred<ReturnType<typeof facts>>();
  let reads = 0;
  invoke.mockImplementation(async command => command === commandFor(kind) ? (++reads === 1 ? old.promise : fresh.promise) : defaults(command));
  const user = userEvent.setup(); render(view()); await open(user, kind);
  await waitFor(() => expect(reads).toBe(1));
  act(() => { window.dispatchEvent(new Event("focus")); expect(client.getQueryState(keyFor(kind))?.isInvalidated).toBe(true); });
  await waitFor(() => expect(reads).toBe(2));
  await act(async () => { old.resolve(facts(kind, "retired-a")); await old.promise; });
  expect(screen.queryByText("retired-a")).not.toBeInTheDocument();
  expect(client.getQueryState(keyFor(kind))?.data).toBeUndefined();
  const current = facts(kind, "focused-b");
  await act(async () => { fresh.resolve(current); await fresh.promise; });
  expect(await screen.findByText("focused-b")).toBeVisible();
  expect(client.getQueryState(keyFor(kind))).toMatchObject({ data: current, status: "success", isInvalidated: false });
});

it("does not cancel or invalidate an exact inventory read still used by another active observer", async () => {
  const pending = deferred<PluginInventoryView>();
  invoke.mockImplementation(async command => command === "read_plugin_inventory" ? pending.promise : defaults(command));
  const user = userEvent.setup(); render(view(true)); await open(user, "inventory");
  const cancel = vi.spyOn(client, "cancelQueries"), invalidate = vi.spyOn(client, "invalidateQueries");
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(cancel.mock.calls.filter(([filter]) => filter?.queryKey === pluginInventoryReadKey)).toHaveLength(0);
  expect(invalidate.mock.calls.filter(([filter]) => filter?.queryKey === pluginInventoryReadKey)).toHaveLength(0);
  const current = installed("shared-current");
  await act(async () => { pending.resolve(current); await pending.promise; });
  expect(await screen.findByLabelText("Companion inventory")).toHaveTextContent("shared-current");
  expect(client.getQueryState(pluginInventoryReadKey)).toMatchObject({ data: current, isInvalidated: false });
  expect(calls("read_plugin_inventory")).toHaveLength(1);
});

it("does not let a hidden cancellation completion invalidate the newly active reopened read", async () => {
  const user = userEvent.setup(); render(view()); await open(user, "inventory");
  await screen.findByRole("button", { name: "Enable" });
  const released = deferred<void>(), cancel = client.cancelQueries.bind(client);
  vi.spyOn(client, "cancelQueries").mockImplementation(async (...args) => {
    await cancel(...args);
    if (args[0]?.queryKey === pluginInventoryReadKey) await released.promise;
  });
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await waitFor(() => expect(calls("read_plugin_inventory")).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled());
  await act(async () => { released.resolve(); await released.promise; });
  expect(client.getQueryState(pluginInventoryReadKey)?.isInvalidated).toBe(false);
  expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled();
});

it("keeps a surviving active observer current when the manager unmounts", async () => {
  const user = userEvent.setup(), rendered = render(view(true)); await open(user, "inventory");
  await screen.findByRole("button", { name: "Enable" });
  const current = client.getQueryData(pluginInventoryReadKey), cancel = vi.spyOn(client, "cancelQueries");
  rendered.rerender(view(true, false));
  expect(client.getQueryState(pluginInventoryReadKey)).toMatchObject({ data: current, isInvalidated: false });
  expect(cancel.mock.calls.filter(([filter]) => filter?.queryKey === pluginInventoryReadKey)).toHaveLength(0);
});

it("blocks focus reads synchronously during a write even with another active observer, then preserves its ACK", async () => {
  const pending = deferred<PluginInventoryView>();
  let request!: PluginEnableRequest;
  invoke.mockImplementation(async (command, envelope) => {
    if (command === "set_plugin_enabled") {
      if (!validateRequestEnable(envelope.request)) throw new Error("Invalid enable request");
      request = envelope.request; return pending.promise;
    }
    return defaults(command);
  });
  const user = userEvent.setup(); render(view(true)); await open(user, "repositories");
  await waitFor(() => expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled());
  await waitFor(() => expect(calls("read_plugin_repositories")).toHaveLength(1));
  const before = calls("read_plugin_inventory").length;
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false");
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(calls("set_plugin_enabled")).toHaveLength(1));
  expect(calls("read_plugin_inventory")).toHaveLength(before);
  expect(calls("read_plugin_repositories")).toHaveLength(1);
  act(() => window.dispatchEvent(new Event("focus")));
  const confirmed = { ...installed("current-plugin", true), settingsRevision: "2", lastSettingsAction: request.actionId };
  await act(async () => { pending.resolve(confirmed); await pending.promise; });
  expect(await screen.findByRole("button", { name: "Disable" })).toBeEnabled();
  expect(client.getQueryData(pluginInventoryReadKey)).toEqual(confirmed);
  expect(calls("read_plugin_inventory")).toHaveLength(before);
  expect(calls("read_plugin_repositories")).toHaveLength(1);
  expect(calls("set_plugin_enabled")).toHaveLength(1);
});

it("rechecks the write reservation after focus cancellation and does not dispatch its queued refetch", async () => {
  const pending = deferred<PluginInventoryView>();
  invoke.mockImplementation(async command => command === "set_plugin_enabled" ? pending.promise : defaults(command));
  const user = userEvent.setup(); render(view()); await open(user, "inventory");
  const enable = await screen.findByRole("button", { name: "Enable" });
  const released = deferred<void>(), cancel = client.cancelQueries.bind(client);
  let waitingForFocusCancellation = false;
  vi.spyOn(client, "cancelQueries").mockImplementation(async (...args) => {
    await cancel(...args);
    if (args[0]?.queryKey === pluginInventoryReadKey && args[1]?.revert === false) {
      waitingForFocusCancellation = true;
      await released.promise;
    }
  });
  act(() => {
    window.dispatchEvent(new Event("focus"));
    fireEvent.click(enable);
  });
  await waitFor(() => expect(calls("set_plugin_enabled")).toHaveLength(1));
  expect(waitingForFocusCancellation).toBe(true);
  await act(async () => { released.resolve(); await released.promise; });
  expect(calls("read_plugin_inventory")).toHaveLength(1);
  await act(async () => { pending.resolve(installed("current-plugin", true)); await pending.promise; });
  expect(await screen.findByRole("button", { name: "Disable" })).toBeEnabled();
  expect(calls("read_plugin_inventory")).toHaveLength(1);
});

it("cancels a pre-write inventory response so it cannot overwrite a confirmed write", async () => {
  const old = deferred<PluginInventoryView>(), pending = deferred<PluginInventoryView>();
  let reads = 0;
  invoke.mockImplementation(async command => {
    if (command === "read_plugin_inventory") return ++reads === 1 ? installed() : old.promise;
    return command === "set_plugin_enabled" ? pending.promise : defaults(command);
  });
  const user = userEvent.setup(); render(view()); await open(user, "inventory");
  const enable = await screen.findByRole("button", { name: "Enable" });
  act(() => {
    void client.refetchQueries({ queryKey: pluginInventoryReadKey, exact: true });
    fireEvent.click(enable);
  });
  await waitFor(() => expect(calls("set_plugin_enabled")).toHaveLength(1));
  const confirmed = installed("current-plugin", true);
  await act(async () => { pending.resolve(confirmed); await pending.promise; });
  expect(await screen.findByRole("button", { name: "Disable" })).toBeEnabled();
  await act(async () => { old.resolve(installed("obsolete-read")); await old.promise; });
  expect(screen.queryByText("obsolete-read")).not.toBeInTheDocument();
  expect(client.getQueryData(pluginInventoryReadKey)).toEqual(confirmed);
});

it("keeps unknown recovery on the same original request through focus and panel reopening", async () => {
  let writes = 0;
  invoke.mockImplementation(async command => {
    if (command === "set_plugin_enabled") {
      if (++writes === 1) throw { code: "outcome-unknown", stage: "plugin-settings", outcome: "unknown", recoveryRequired: true, reason: "plugin-result-unconfirmed" };
      return installed("current-plugin", true);
    }
    return defaults(command);
  });
  const user = userEvent.setup(); render(view()); await open(user, "inventory");
  await user.click(await screen.findByRole("button", { name: "Enable" }));
  await screen.findByRole("button", { name: "Retry original operation" });
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(calls("read_plugin_inventory")).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry original operation" })).toBeEnabled());
  expect(calls("set_plugin_enabled")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry original operation" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Retry original operation" }));
  expect(await screen.findByRole("button", { name: "Disable" })).toBeEnabled();
  const attempts = calls("set_plugin_enabled");
  expect(attempts).toHaveLength(2);
  expect(attempts[1][1]).toEqual(attempts[0][1]);
});

it.each(["inventory", "repositories"] as const)("cancels the last %s observer when the manager unmounts and requires a new read on return", async kind => {
  const old = deferred<ReturnType<typeof facts>>(), fresh = deferred<ReturnType<typeof facts>>();
  let reads = 0;
  invoke.mockImplementation(async command => command === commandFor(kind) ? (++reads === 1 ? old.promise : fresh.promise) : defaults(command));
  const user = userEvent.setup(), rendered = render(view()); await open(user, kind);
  await waitFor(() => expect(reads).toBe(1));
  rendered.rerender(view(false, false));
  await waitFor(() => expect(client.getQueryState(keyFor(kind))).toMatchObject({ fetchStatus: "idle", isInvalidated: true }));
  await act(async () => { old.resolve(facts(kind, "retired-consumer")); await old.promise; });
  expect(client.getQueryState(keyFor(kind))?.data).toBeUndefined();
  rendered.rerender(view()); await open(user, kind);
  await waitFor(() => expect(reads).toBe(2));
  await act(async () => { fresh.resolve(facts(kind, "returned-current")); await fresh.promise; });
  expect(await screen.findByText("returned-current")).toBeVisible();
  expect(screen.queryByText("retired-consumer")).not.toBeInTheDocument();
});

it("retires extension waits and the shared focus listener with the application provider", async () => {
  const old = deferred<PluginInventoryView>();
  invoke.mockImplementation(async command => command === "read_plugin_inventory" ? old.promise : defaults(command));
  const user = userEvent.setup(), rendered = render(view()); await open(user, "inventory");
  await waitFor(() => expect(calls("read_plugin_inventory")).toHaveLength(1));
  rendered.unmount();
  await act(async () => { old.resolve(installed("retired-provider")); await old.promise; });
  act(() => window.dispatchEvent(new Event("focus")));
  expect(client.getQueryState(pluginInventoryReadKey)).toBeUndefined();
  expect(calls("read_plugin_inventory")).toHaveLength(1);
});
