import { useLayoutEffect, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider, connectionReadKey, currentConnections, useConnectionFacts } from "./ApplicationReadProvider";
import { ModelConnectionPicker } from "./ModelConnectionPicker";
import { defaultAiConfig } from "./aiCommands";
import type { ConnectionReadView } from "./connectionCommands";
import { connectionFixture } from "./testSupport/connectionFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const config = { ...defaultAiConfig, endpoint: "https://synthetic.example.test/v1", model: "Original", credentialEnv: "SYNTHETIC_REFERENCE",
  connectionProfile: { storeId: fixtureIdentity(700), profileId: fixtureIdentity(701), revision: "1", digest: "a".repeat(64) } };
let client: ReturnType<typeof useConnectionFacts>["client"];
const selected = vi.fn((_view: ConnectionReadView | null, _id: string, _seq: number) => true);

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function facts(model = "Original", revision = "1"): ConnectionReadView {
  const view = connectionFixture([{ ...config, model, connectionProfile: { ...config.connectionProfile, revision,
    digest: (revision === "1" ? "a" : "b").repeat(64) } }]);
  view.snapshot.revision = revision; view.basis.revision = revision;
  return view;
}
function SubscribedOwner({ count = 1, linked = true }: { count?: number; linked?: boolean }) {
  const connections = useConnectionFacts(), [visible, setVisible] = useState(false);
  useLayoutEffect(() => { client = connections.client; });
  return <>
    <output aria-label="Current connection">{connections.current()?.snapshot.profiles[0]?.connection.model ?? "Unavailable"}</output>
    <button onClick={() => setVisible(true)}>Show connection choices</button>
    {visible ? Array.from({ length: count }, (_, index) => <ModelConnectionPicker key={index} config={linked ? config : defaultAiConfig}
      label={`Connection ${index + 1}`} active disabled={false} editSeq={7} onSelect={selected} />) : null}
  </>;
}
async function open(count = 1, linked = true) {
  const user = userEvent.setup(), rendered = render(<ApplicationReadProvider><SubscribedOwner count={count} linked={linked} /></ApplicationReadProvider>);
  expect(client.getQueryState(connectionReadKey)).toBeUndefined();
  await user.click(screen.getByRole("button", { name: "Show connection choices" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_model_connections", { request: {} }));
  return { user, ...rendered };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  selected.mockClear(); invoke.mockReset().mockResolvedValue(facts());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("mounts two shared pickers after the fact owner subscribes without render-time owner updates", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { user } = await open(2, false);
  await waitFor(() => expect(screen.getByLabelText("Current connection")).toHaveTextContent("Original"));
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls.filter(([message]) => String(message).includes("Cannot update a component"))).toEqual([]);
  await user.selectOptions(screen.getByRole("combobox", { name: "Connection 2" }), config.connectionProfile.profileId);
  expect(selected).toHaveBeenCalledWith(currentConnections(client), config.connectionProfile.profileId, 7);
});

it("keeps a pre-focus first response unavailable until a new read confirms current facts", async () => {
  const old = deferred<ConnectionReadView>(), fresh = deferred<ConnectionReadView>();
  invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const { user } = await open();
  act(() => { window.dispatchEvent(new Event("focus")); expect(currentConnections(client)).toBeUndefined(); });
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  await act(async () => { old.resolve(facts()); await old.promise; });
  expect(currentConnections(client)).toBeUndefined();
  expect(screen.queryByRole("option", { name: "Synthetic Original · Original" })).not.toBeInTheDocument();
  const confirmed = facts("Current", "2");
  await act(async () => { fresh.resolve(confirmed); await fresh.promise; });
  const option = await screen.findByRole("option", { name: "Synthetic Current · Current" });
  expect(option).toBeEnabled(); expect(currentConnections(client)).toEqual(confirmed);
  expect(screen.getByRole("combobox")).toHaveValue("captured");
  expect(selected).not.toHaveBeenCalled(); expect(config.model).toBe("Original");
  await user.selectOptions(screen.getByRole("combobox"), config.connectionProfile.profileId);
  expect(selected).toHaveBeenCalledWith(currentConnections(client), config.connectionProfile.profileId, 7);
  expect(invoke.mock.calls.every(([command]) => command === "read_model_connections")).toBe(true);
});

it("does not let a cancelled older response erase a failed focus check or prevent explicit one-time mode", async () => {
  const old = deferred<ConnectionReadView>(), fresh = deferred<ConnectionReadView>();
  invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const { user } = await open();
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  await act(async () => { fresh.reject({ code: "storage-failed", stage: "model-connections", outcome: "rejected", reason: "model-connections-storage" }); });
  await screen.findByText(i18n.t("connections.readFailed"));
  await act(async () => { old.resolve(facts()); await old.promise; });
  expect(currentConnections(client)).toBeUndefined();
  expect(screen.getByText(i18n.t("connections.readFailed"))).toBeInTheDocument();
  expect(screen.getByRole("combobox")).toHaveValue("captured");
  await user.selectOptions(screen.getByRole("combobox"), "");
  expect(selected).toHaveBeenCalledWith(null, "", 7);
  expect(config.connectionProfile.revision).toBe("1");
});

it("retires pending reads and the focus listener with the application provider", async () => {
  const old = deferred<ConnectionReadView>(), fresh = deferred<ConnectionReadView>();
  invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const { unmount } = await open();
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  unmount();
  await act(async () => { old.resolve(facts()); fresh.resolve(facts("Current", "2")); await Promise.all([old.promise, fresh.promise]); });
  act(() => window.dispatchEvent(new Event("focus")));
  expect(client.getQueryState(connectionReadKey)).toBeUndefined(); expect(invoke).toHaveBeenCalledTimes(2);
  expect(selected).not.toHaveBeenCalled();
});
