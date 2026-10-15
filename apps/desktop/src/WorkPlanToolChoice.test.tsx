import { createRef, useState, type ReactNode, type Ref } from "react";
import { act, cleanup, render as renderUi, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionReadProvider } from "./SessionReadProvider";
import { toolQueryInventory, toolQueryPackage, toolQueryView } from "./testSupport/pluginToolFixture";
import { WorkPlanToolChoice, type PlanToolDraft, type PlanToolChoiceHandle } from "./WorkPlanToolChoice";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
function render(ui: ReactNode) { return renderUi(ui, { wrapper: ({ children }) => <SessionReadProvider context={{ projectId: "00000000-0000-4000-8000-000000000001", sessionToken: "synthetic-tool-choice" }} bridge={false}>{children}</SessionReadProvider> }); }
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const alternativeView = structuredClone(toolQueryView);
alternativeView.binding.capability.provider.plugin.id = "reference-alternative";
alternativeView.binding.capability.provider.packageDigest = "c".repeat(64);
alternativeView.binding.declaration.title = "Independent alternative reference";
alternativeView.packageOrigin = { sourceId: "independent-local", publisherId: "user-approved" };
const alternativePackage = { ...structuredClone(toolQueryPackage), packageDigest: alternativeView.binding.capability.provider.packageDigest,
  manifest: { ...structuredClone(toolQueryPackage.manifest), plugin: alternativeView.binding.capability.provider.plugin } };
let inventory: typeof toolQueryInventory;
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  inventory = structuredClone(toolQueryInventory);
  invoke.mockReset(); invoke.mockImplementation(async (command, args) => {
    if (command === "read_plugin_inventory") return structuredClone(inventory);
    if (command === "read_plugin_package") return structuredClone(args.request.packageDigest === alternativePackage.packageDigest ? alternativePackage : toolQueryPackage);
    if (command === "read_plugin_tool") return structuredClone(args.request.package.packageDigest === alternativePackage.packageDigest ? alternativeView : toolQueryView);
    throw new Error(command);
  });
});
afterEach(cleanup);
function addAlternative() {
  const provider = alternativeView.binding.capability.provider;
  inventory.packages.push({ originalInstallAction: "00000000-0000-4000-8000-000000000002", plugin: provider.plugin, packageDigest: provider.packageDigest, origin: alternativeView.packageOrigin, state: "sealed" });
  inventory.packageDecisions.push({ plugin: provider.plugin, packageDigest: provider.packageDigest, origin: alternativeView.packageOrigin, enabled: true });
}
function Choice({ refProp, open = true, disabled = false }: { refProp: Ref<PlanToolChoiceHandle>; open?: boolean; disabled?: boolean }) {
  const [value, setValue] = useState<PlanToolDraft | null>(null);
  return <WorkPlanToolChoice open={open} disabled={disabled} value={value} onChange={setValue} ref={refProp} />;
}
function provider(number: number) { return within(screen.getByRole("group", { name: `Reference provider ${number}` })); }
async function choose(user: ReturnType<typeof userEvent.setup>, number: number, view = toolQueryView, sense = "term", target = "zh-CN") {
  const row = provider(number);
  await user.selectOptions(row.getByRole("combobox", { name: "Reference package" }), `${view.binding.capability.provider.packageDigest}:${view.resourceId}`);
  await user.selectOptions(row.getByRole("combobox", { name: "Execution environment" }), view.environmentDigest);
  await row.findByRole("checkbox", { name: /^Term 👩🏽‍💻/ });
  await user.selectOptions(row.getByRole("combobox", { name: "Target language" }), target);
  await user.click(row.getByRole("checkbox", { name: sense === "term" ? /^Term 👩🏽‍💻/ : /^Other/ }));
}

it("requires explicit tool/environment choices and captures fixed options without arbitrary query text", async () => {
  const user = userEvent.setup(), ref = createRef<PlanToolChoiceHandle>();
  render(<Choice refProp={ref} />);
  expect(ref.current?.capture()).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
  await user.click(screen.getByRole("checkbox", { name: "Include read-only reference tools" }));
  await screen.findByRole("option", { name: /philosophy.*agent-query-tool/ });
  expect(provider(1).getByRole("combobox", { name: "Reference package" })).toHaveValue("");
  expect(provider(1).getByRole("combobox", { name: "Execution environment" })).toHaveValue("");
  expect(() => ref.current?.capture()).toThrow();
  await choose(user, 1);
  await waitFor(() => expect(ref.current?.capture()).toMatchObject({ maxInvocations: 10,
    entries: [{ target: "zh-CN", selections: ["term"], view: toolQueryView }] }));
  expect(ref.current?.capture()?.entries[0].tool).toEqual({ package: { plugin: toolQueryPackage.manifest.plugin, packageDigest: toolQueryPackage.packageDigest }, resourceId: toolQueryView.resourceId, environmentDigest: toolQueryView.environmentDigest });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(invoke.mock.calls.some(([command]) => command.startsWith("start_") || command.startsWith("authorize_"))).toBe(false);
});

it("captures independent providers and per-provider options under one total limit without sharing draft references", async () => {
  addAlternative();
  const user = userEvent.setup(), ref = createRef<PlanToolChoiceHandle>();
  render(<Choice refProp={ref} />);
  await user.click(screen.getByRole("checkbox", { name: "Include read-only reference tools" }));
  await screen.findByRole("option", { name: /reference-alternative/ });
  await choose(user, 1);
  await user.click(screen.getByRole("button", { name: "Add reference provider" }));
  expect(provider(2).getByRole("combobox", { name: "Reference package" })).toHaveFocus();
  expect(provider(2).getByRole("combobox", { name: "Reference package" })).toHaveValue("");
  expect(() => ref.current?.capture()).toThrow();
  await choose(user, 2, alternativeView, "other", "ja");
  const limit = screen.getByRole("spinbutton", { name: "Total tool-call limit" });
  await user.clear(limit); await user.type(limit, "3");
  const captured = ref.current?.capture();
  expect(captured).toEqual({ maxInvocations: 3, entries: [
    { tool: { package: { plugin: toolQueryPackage.manifest.plugin, packageDigest: toolQueryPackage.packageDigest }, resourceId: toolQueryView.resourceId, environmentDigest: toolQueryView.environmentDigest }, target: "zh-CN", selections: ["term"], view: toolQueryView, readKey: expect.arrayContaining(["tool-query-environment"]) },
    { tool: { package: { plugin: alternativePackage.manifest.plugin, packageDigest: alternativePackage.packageDigest }, resourceId: alternativeView.resourceId, environmentDigest: alternativeView.environmentDigest }, target: "ja", selections: ["other"], view: alternativeView, readKey: expect.arrayContaining(["tool-query-environment"]) },
  ] });
  expect(screen.getAllByRole("spinbutton", { name: "Total tool-call limit" })).toHaveLength(1);
  if (!captured) throw new Error("Expected captured references");
  captured.entries[0].selections.length = 0;
  captured.entries[1].view.packageOrigin.sourceId = "mutated-caller-copy";
  expect(ref.current?.capture()?.entries[0].selections).toEqual(["term"]);
  expect(ref.current?.capture()?.entries[1].view.packageOrigin).toEqual(alternativeView.packageOrigin);
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(screen.getByRole("button", { name: "添加参考提供者" })).toBeInTheDocument();
  expect(ref.current?.capture()?.entries.map(entry => [entry.target, entry.selections])).toEqual([["zh-CN", ["term"]], ["ja", ["other"]]]);
  expect(invoke.mock.calls.some(([command]) => command.startsWith("start_") || command.startsWith("authorize_"))).toBe(false);
});

it("rejects duplicate exact tools rather than dropping or merging them, and preserves the remaining row on removal", async () => {
  const user = userEvent.setup(), ref = createRef<PlanToolChoiceHandle>();
  render(<Choice refProp={ref} />);
  await user.click(screen.getByRole("checkbox", { name: "Include read-only reference tools" }));
  await screen.findByRole("option", { name: /philosophy.*agent-query-tool/ });
  await choose(user, 1);
  await user.click(screen.getByRole("button", { name: "Add reference provider" }));
  await choose(user, 2, toolQueryView, "other", "ja");
  expect(screen.getAllByRole("alert").every(element => element.textContent?.includes("already selected"))).toBe(true);
  expect(() => ref.current?.capture()).toThrow();
  await user.click(screen.getByRole("button", { name: "Remove reference provider 2" }));
  expect(screen.getByRole("button", { name: "Add reference provider" })).toHaveFocus();
  expect(ref.current?.capture()?.entries).toHaveLength(1);
  expect(ref.current?.capture()?.entries[0]).toMatchObject({ target: "zh-CN", selections: ["term"], view: toolQueryView });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not attach a removed row's late metadata to a remaining provider or a newly added row", async () => {
  addAlternative();
  const user = userEvent.setup(), ref = createRef<PlanToolChoiceHandle>();
  let resolve: (value: typeof toolQueryView) => void = () => {};
  const pending = new Promise<typeof toolQueryView>(done => { resolve = done; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "read_plugin_tool" && args.request.package.packageDigest === toolQueryPackage.packageDigest ? pending : original(command, args));
  render(<Choice refProp={ref} />);
  await user.click(screen.getByRole("checkbox", { name: "Include read-only reference tools" }));
  await screen.findByRole("option", { name: /reference-alternative/ });
  await user.selectOptions(provider(1).getByRole("combobox", { name: "Reference package" }), `${toolQueryPackage.packageDigest}:${toolQueryView.resourceId}`);
  await user.selectOptions(provider(1).getByRole("combobox", { name: "Execution environment" }), toolQueryView.environmentDigest);
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_plugin_tool")).toBe(true));
  await user.click(screen.getByRole("button", { name: "Add reference provider" }));
  await choose(user, 2, alternativeView, "other", "ja");
  expect(() => ref.current?.capture()).toThrow();
  await user.click(screen.getByRole("button", { name: "Remove reference provider 1" }));
  expect(ref.current?.capture()?.entries).toHaveLength(1);
  expect(ref.current?.capture()?.entries[0]).toMatchObject({ target: "ja", selections: ["other"], view: alternativeView });
  await act(async () => { resolve(structuredClone(toolQueryView)); await pending; });
  expect(ref.current?.capture()?.entries[0].tool.package).toEqual({ plugin: alternativePackage.manifest.plugin, packageDigest: alternativePackage.packageDigest });
  await user.click(screen.getByRole("button", { name: "Add reference provider" }));
  expect(provider(2).getByRole("combobox", { name: "Reference package" })).toHaveValue("");
  expect(provider(2).queryByRole("combobox", { name: "Target language" })).not.toBeInTheDocument();
  expect(() => ref.current?.capture()).toThrow();
});

it("retains explicit options across refresh errors and refuses a substituted provider acknowledgement", async () => {
  addAlternative();
  const user = userEvent.setup(), ref = createRef<PlanToolChoiceHandle>();
  render(<Choice refProp={ref} />);
  await user.click(screen.getByRole("checkbox", { name: "Include read-only reference tools" }));
  await screen.findByRole("option", { name: /reference-alternative/ });
  await choose(user, 1, alternativeView, "other", "ja");
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "read_plugin_tool" ? Promise.reject({ code: "read-failed", outcome: "rejected", reason: "synthetic-read-failure" }) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Refresh reference packages" }));
  await screen.findByRole("alert");
  expect(provider(1).getByRole("combobox", { name: "Reference package" })).toHaveValue(`${alternativePackage.packageDigest}:${alternativeView.resourceId}`);
  expect(() => ref.current?.capture()).toThrow();
  invoke.mockImplementation((command, args) => command === "read_plugin_tool" ? Promise.resolve(structuredClone(toolQueryView)) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Refresh reference packages" }));
  await waitFor(() => expect(provider(1).getByRole("alert")).toHaveTextContent("Reference options could not be read"));
  expect(() => ref.current?.capture()).toThrow();
  invoke.mockImplementation(original);
  await user.click(screen.getByRole("button", { name: "Refresh reference packages" }));
  await provider(1).findByRole("combobox", { name: "Target language" });
  await waitFor(() => expect(ref.current?.capture()?.entries[0]).toMatchObject({ target: "ja", selections: ["other"], view: alternativeView }));
});

it("rejects empty enabled references, invalid shared limits and capture from hidden or disabled controls", async () => {
  const user = userEvent.setup(), ref = createRef<PlanToolChoiceHandle>();
  const rendered = render(<Choice refProp={ref} />);
  await user.click(screen.getByRole("checkbox", { name: "Include read-only reference tools" }));
  await screen.findByRole("option", { name: /philosophy.*agent-query-tool/ });
  await choose(user, 1);
  const limit = screen.getByRole("spinbutton", { name: "Total tool-call limit" });
  for (const value of ["0", "301", "1.5"]) {
    await user.clear(limit); await user.type(limit, value);
    expect(limit).toHaveAttribute("aria-invalid", "true");
    expect(() => ref.current?.capture()).toThrow();
  }
  await user.clear(limit); await user.type(limit, "2");
  rendered.rerender(<Choice refProp={ref} disabled />);
  expect(screen.getByRole("button", { name: "Remove reference provider 1" })).toBeDisabled();
  expect(() => ref.current?.capture()).toThrow();
  rendered.rerender(<Choice refProp={ref} open={false} />);
  expect(() => ref.current?.capture()).toThrow();
  rendered.rerender(<Choice refProp={ref} />);
  await waitFor(() => expect(ref.current?.capture()?.entries).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: "Remove reference provider 1" }));
  expect(screen.getByText(/Add a reference provider or turn off/)).toBeInTheDocument();
  expect(() => ref.current?.capture()).toThrow();
  await user.click(screen.getByRole("checkbox", { name: "Include read-only reference tools" }));
  expect(ref.current?.capture()).toBeNull();
});
