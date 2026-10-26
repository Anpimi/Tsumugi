import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { PluginManager } from "./PluginManager";
import { validateRequestPackInstall, validateResponseCandidate, validateResponseInventory } from "./generated/plugins.validators";
import type { PermissionRequest, PluginInventoryView, PluginPackCandidateView, PluginPackInstallRequest } from "./pluginCommands";
import { i18n } from "./i18n";
import inventory from "../test/fixtures/pluginInventory.contract.json";
import candidate from "../test/fixtures/pluginPackage.contract.json";

const invoke = vi.hoisted(() => vi.fn<(command: string, envelope: { request: unknown }) => Promise<unknown>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const onBusy = vi.fn();

function emptyInventory(): PluginInventoryView {
  const value: unknown = inventory.empty;
  if (!validateResponseInventory(value)) throw new Error("Invalid inventory fixture");
  return value;
}
function packageManifest() {
  const value: unknown = candidate;
  if (!validateResponseCandidate(value) || value === null) throw new Error("Invalid package fixture");
  return value.manifest;
}
const empty = emptyInventory();
const manifest = packageManifest();
const destination = "https://reference.example.test";
const program = "synthetic-text-helper";
function packMember(id: string, digest: string, permissions: PermissionRequest[], capabilityPermissions: PermissionRequest[]): PluginPackCandidateView["packages"][number] {
  return {
    manifest: {
      ...manifest,
      plugin: { ...manifest.plugin, id },
      permissions,
      contributions: manifest.contributions.map(contribution => contribution.contribution.kind === "capability" ? {
        ...contribution,
        contribution: {
          ...contribution.contribution,
          declaration: { ...contribution.contribution.declaration, permissions: capabilityPermissions },
        },
      } : contribution),
    },
    packageDigest: digest,
    fileCount: candidate.fileCount,
    byteCount: candidate.byteCount,
  };
}
const pack: PluginPackCandidateView = {
  ticket: "00000000-0000-4000-8000-000000000030",
  id: "synthetic-tools",
  displayName: "Synthetic tools",
  descriptorDigest: "a".repeat(64),
  packages: [
    packMember("network-reference", "b".repeat(64), [{ kind: "network", destination }, { kind: "captured-input" }], [{ kind: "captured-input" }]),
    packMember("local-helper", "c".repeat(64), [{ kind: "captured-input" }, { kind: "process", program }], [{ kind: "process", program }]),
  ],
};
const manualOrigin = { sourceId: "manual-local", publisherId: "manual-approval" };

/** The mock acknowledges the actual submitted action and its complete subset. */
function acknowledge(request: PluginPackInstallRequest, previous: PluginInventoryView = empty): PluginInventoryView {
  const selected = new Set(request.members.map(member => member.packageDigest));
  return {
    ...previous,
    settingsRevision: (BigInt(request.expectedRevision) + 1n).toString(),
    lastSettingsAction: request.actionId,
    packages: [
      ...previous.packages.filter(item => !selected.has(item.packageDigest)),
      ...request.members.map((member): PluginInventoryView["packages"][number] => ({
        ...member, originalInstallAction: request.actionId, origin: manualOrigin, state: "sealed",
      })),
    ],
    packageDecisions: [
      ...previous.packageDecisions.filter(item => !selected.has(item.packageDigest)),
      ...request.members.map(member => ({ ...member, origin: manualOrigin, enabled: false })),
    ],
  };
}
function mockIpc({ read = () => empty, select = () => pack, install = acknowledge }: {
  read?: () => PluginInventoryView | Promise<PluginInventoryView>;
  select?: () => PluginPackCandidateView | null | Promise<PluginPackCandidateView | null>;
  install?: (request: PluginPackInstallRequest) => unknown | Promise<unknown>;
} = {}) {
  invoke.mockImplementation(async (command, { request }) => {
    if (command === "read_plugin_inventory") return read();
    if (command === "select_plugin_pack") return select();
    if (command === "install_plugin_pack") {
      if (!validateRequestPackInstall(request)) throw new Error("Invalid Pack installation request");
      return install(request);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
}
function installCalls() {
  return invoke.mock.calls.filter(([command]) => command === "install_plugin_pack");
}
function originalRequest(): PluginPackInstallRequest {
  const call = installCalls()[0];
  if (!call) throw new Error("No Pack installation was submitted");
  const request = call[1].request;
  if (!validateRequestPackInstall(request)) throw new Error("Invalid Pack installation request");
  return request;
}
function expectNoMutations() {
  for (const [command] of invoke.mock.calls) {
    expect(["read_plugin_inventory", "select_plugin_pack"]).toContain(command);
  }
}
async function openManager() {
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Select offline Pack folder" })).toBeEnabled());
  return user;
}
async function choosePack(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Select offline Pack folder" }));
  return screen.findByRole("region", { name: "Review Pack: Synthetic tools" });
}
function memberCheckbox(id: string) {
  return screen.getByRole("checkbox", { name: `I trust and approve ${id} 0.1.0 with the permissions listed above` });
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  onBusy.mockReset();
  invoke.mockReset();
  mockIpc();
});
afterEach(cleanup);

it.each([
  { locale: "en-US", entry: "Extensions", choose: "Select offline Pack folder", title: "Review Pack: Synthetic tools", consent: "I trust and approve", install: "Approve and install selected packages", discard: "Cancel selection", network: "Connect to network hosts", process: "Launch external programs" },
  { locale: "zh-CN", entry: "扩展", choose: "选择离线扩展包文件夹", title: "查看扩展包组合：Synthetic tools", consent: "我信任并批准", install: "批准并安装所选插件包", discard: "取消选择", network: "访问网络地址", process: "启动外部程序" },
])("reviews each member and its own permissions without installing in $locale", async labels => {
  await i18n.changeLanguage(labels.locale);
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: labels.entry }));
  const picker = await screen.findByRole("button", { name: labels.choose });
  await waitFor(() => expect(picker).toBeEnabled());
  await user.click(picker);
  const review = await screen.findByRole("region", { name: labels.title });
  expect(within(review).getByRole("heading", { name: labels.title })).toHaveFocus();
  const checkboxes = within(review).getAllByRole("checkbox", { name: new RegExp(labels.consent) });
  expect(checkboxes).toHaveLength(2);
  for (const checkbox of checkboxes) expect(checkbox).not.toBeChecked();
  expect(within(review).getByRole("button", { name: labels.install })).toBeDisabled();
  expect(within(review).getByRole("button", { name: labels.discard })).toBeEnabled();
  for (const member of pack.packages) {
    expect(within(review).getByRole("checkbox", { name: new RegExp(`${labels.consent} ${member.manifest.plugin.id} ${member.manifest.plugin.version}`) })).toBeEnabled();
  }
  const networkMember = checkboxes[0].closest("li");
  const processMember = checkboxes[1].closest("li");
  if (!networkMember || !processMember) throw new Error("Missing member review");
  expect(within(networkMember).getByText(new RegExp(labels.network))).toBeVisible();
  expect(within(networkMember).getByText(destination)).toBeVisible();
  expect(within(networkMember).queryByText(program)).not.toBeInTheDocument();
  expect(within(processMember).getAllByText(new RegExp(labels.process))).toHaveLength(2);
  for (const label of within(processMember).getAllByText(new RegExp(labels.process))) expect(label).toBeVisible();
  expect(within(processMember).getAllByText(program)).toHaveLength(2);
  for (const target of within(processMember).getAllByText(program)) expect(target).toBeVisible();
  expect(within(processMember).queryByText(destination)).not.toBeInTheDocument();
  expect(within(review).getByText(/are unverified|均未经签名认证/)).toBeVisible();
  expect(within(review).getByText(/preview expires after 10 minutes|预览将在 10 分钟后过期/)).toBeVisible();
  expectNoMutations();
  await user.click(within(review).getByRole("button", { name: labels.discard }));
  expect(screen.queryByRole("region", { name: labels.title })).not.toBeInTheDocument();
  expect(picker).toHaveFocus();
  expectNoMutations();
});

it("submits only the explicitly selected exact members and leaves new packages disabled", async () => {
  const current = { ...empty, settingsRevision: "9007199254740993" };
  mockIpc({ read: () => current });
  const user = await openManager();
  await choosePack(user);
  await user.click(memberCheckbox("network-reference"));
  expect(memberCheckbox("local-helper")).not.toBeChecked();
  await user.click(memberCheckbox("local-helper"));
  await user.click(memberCheckbox("network-reference"));
  await user.click(screen.getByRole("button", { name: "Approve and install selected packages" }));
  expect(await screen.findByRole("button", { name: "Enable" })).toBeEnabled();
  expect(installCalls()).toHaveLength(1);
  const selectedMember = pack.packages.find(member => member.manifest.plugin.id === "local-helper");
  if (!selectedMember) throw new Error("Missing local-helper fixture member");
  expect(installCalls()[0][1]).toEqual({ request: {
    ticket: pack.ticket,
    expectedRevision: current.settingsRevision,
    actionId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    members: [{ plugin: selectedMember.manifest.plugin, packageDigest: selectedMember.packageDigest }],
  } });
  expect(screen.queryByRole("region", { name: "Review Pack: Synthetic tools" })).not.toBeInTheDocument();
  expect(screen.getByText("local-helper")).toBeInTheDocument();
  expect(screen.queryByText("network-reference")).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command !== "read_plugin_inventory" && command !== "select_plugin_pack" && command !== "install_plugin_pack")).toHaveLength(0);
  expect(onBusy).toHaveBeenLastCalledWith(false);
  await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());
});

it("clears all member consent when choosing a new Pack and when cancelling its picker", async () => {
  const replacement = { ...pack, ticket: "00000000-0000-4000-8000-000000000031", displayName: "Updated tools" };
  const selections: Array<PluginPackCandidateView | null> = [pack, replacement, null];
  mockIpc({ select: () => selections.shift() ?? null });
  const user = await openManager();
  await choosePack(user);
  await user.click(memberCheckbox("network-reference"));
  await user.click(screen.getByRole("button", { name: "Select offline Pack folder" }));
  expect(await screen.findByRole("region", { name: "Review Pack: Updated tools" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Review Pack: Synthetic tools" })).not.toBeInTheDocument();
  for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Approve and install selected packages" })).toBeDisabled();
  await user.click(memberCheckbox("local-helper"));
  await user.click(screen.getByRole("button", { name: "Select offline Pack folder" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Select offline Pack folder" })).toBeEnabled());
  expect(screen.getByRole("region", { name: "Review Pack: Updated tools" })).toBeInTheDocument();
  for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Approve and install selected packages" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([command]) => command === "select_plugin_pack")).toHaveLength(3);
  expectNoMutations();
});

it("keeps the captured review and exact member selection when the panel is closed and reopened", async () => {
  const user = await openManager();
  await choosePack(user);
  await user.click(memberCheckbox("local-helper"));
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await screen.findByRole("region", { name: "Review Pack: Synthetic tools" });
  await waitFor(() => expect(memberCheckbox("local-helper")).toBeEnabled());
  expect(memberCheckbox("local-helper")).toBeChecked();
  expect(memberCheckbox("network-reference")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Approve and install selected packages" })).toBeEnabled();
  expect(invoke.mock.calls.filter(([command]) => command === "select_plugin_pack")).toHaveLength(1);
  expectNoMutations();
});

it("locks conflicting operations and panel dismissal until the accepted installation returns", async () => {
  const previous = acknowledge({
    ticket: pack.ticket, actionId: "00000000-0000-4000-8000-000000000040", expectedRevision: "0",
    members: [{ plugin: pack.packages[0].manifest.plugin, packageDigest: pack.packages[0].packageDigest }],
  });
  let finish: ((view: PluginInventoryView) => void) | undefined;
  const pending = new Promise<PluginInventoryView>(resolve => { finish = resolve; });
  mockIpc({ read: () => previous, install: () => pending });
  const user = await openManager();
  await choosePack(user);
  await user.click(memberCheckbox("local-helper"));
  await user.click(screen.getByRole("button", { name: "Approve and install selected packages" }));
  await waitFor(() => expect(installCalls()).toHaveLength(1));
  expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
  for (const name of ["Close", "Select plugin folder", "Select offline Pack folder", "Refresh state", "Cancel selection", "Approve and install selected packages", "Enable", "View package details"]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
  for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeDisabled();
  expect(onBusy).toHaveBeenLastCalledWith(true);
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Approve and install selected packages" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(installCalls()).toHaveLength(1);
  const resolveInstall = finish;
  if (!resolveInstall) throw new Error("No pending installation resolver");
  await act(async () => resolveInstall(acknowledge(originalRequest(), previous)));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Enable" })).toHaveLength(2));
  expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  expect(onBusy).toHaveBeenLastCalledWith(false);
});

it("retains an unknown original Pack action across refresh and reopening, then retries that same subset", async () => {
  let latest = empty;
  let attempts = 0;
  mockIpc({ read: () => latest, install: request => {
    attempts += 1;
    latest = acknowledge(request);
    if (attempts === 1) throw new Error("Installation response interrupted");
    return latest;
  } });
  const user = await openManager();
  await choosePack(user);
  await user.click(memberCheckbox("network-reference"));
  await user.click(memberCheckbox("local-helper"));
  await user.click(screen.getByRole("button", { name: "Approve and install selected packages" }));
  expect(await screen.findByRole("button", { name: "Retry original operation" })).toBeEnabled();
  const original = originalRequest();
  expect(screen.getByText(/operation may have partially completed/)).toBeInTheDocument();
  expect(onBusy).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "Refresh state" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Enable" })).toHaveLength(2));
  for (const button of screen.getAllByRole("button", { name: "Enable" })) expect(button).toBeDisabled();
  expect(screen.queryByText(/Changes saved/)).not.toBeInTheDocument();
  expect(installCalls()).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry original operation" })).toBeEnabled());
  expect(screen.getByRole("button", { name: "Select offline Pack folder" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel selection" })).toBeDisabled();
  expect(memberCheckbox("network-reference")).toBeChecked();
  expect(memberCheckbox("local-helper")).toBeChecked();
  expect(installCalls()).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Retry original operation" }));
  expect(await screen.findByText(/Changes saved/)).toBeInTheDocument();
  expect(installCalls()).toHaveLength(2);
  expect(installCalls()[1][1]).toEqual({ request: original });
  expect(original.expectedRevision).toBe("0");
  expect(original.members).toEqual(pack.packages.map(member => ({ plugin: member.manifest.plugin, packageDigest: member.packageDigest })));
  for (const button of screen.getAllByRole("button", { name: "Enable" })) expect(button).toBeEnabled();
  expect(onBusy).toHaveBeenLastCalledWith(false);
});

it.each(["malformed", "missing-member", "missing-approval", "wrong-action", "wrong-revision"])("keeps the original request unconfirmed after a %s acknowledgement", async fault => {
  mockIpc({ install: request => {
    const view = acknowledge(request);
    if (fault === "malformed") return { ...view, unexpected: true };
    if (fault === "missing-member") return { ...view, packages: view.packages.slice(0, 1) };
    if (fault === "missing-approval") return { ...view, packageDecisions: view.packageDecisions.slice(0, 1) };
    if (fault === "wrong-action") return { ...view, lastSettingsAction: "00000000-0000-4000-8000-000000000099" };
    return { ...view, settingsRevision: request.expectedRevision };
  } });
  const user = await openManager();
  await choosePack(user);
  await user.click(memberCheckbox("network-reference"));
  await user.click(memberCheckbox("local-helper"));
  await user.click(screen.getByRole("button", { name: "Approve and install selected packages" }));
  expect(await screen.findByRole("button", { name: "Retry original operation" })).toBeEnabled();
  expect(screen.queryByText(/Changes saved/)).not.toBeInTheDocument();
  expect(screen.getByText("No plugin packages installed.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select offline Pack folder" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel selection" })).toBeDisabled();
  expect(screen.getByRole("region", { name: "Review Pack: Synthetic tools" })).toBeInTheDocument();
  expect(memberCheckbox("network-reference")).toBeChecked();
  expect(memberCheckbox("local-helper")).toBeChecked();
  expect(installCalls()).toHaveLength(1);
  expect(onBusy).toHaveBeenLastCalledWith(true);
});


it.each(["installed", "uninstalled"])("keeps retained %s origins out of a manual Pack installation", async state => {
  const member = pack.packages[0];
  const original: PluginInventoryView["packages"][number] = {
    plugin: member.manifest.plugin, packageDigest: member.packageDigest,
    originalInstallAction: "00000000-0000-4000-8000-000000000080",
    origin: { sourceId: "verified-repository", publisherId: "repository-principal" }, state: "sealed",
  };
  const previous: PluginInventoryView = { ...empty, settingsRevision: "2", lastSettingsAction: "00000000-0000-4000-8000-000000000081",
    packages: state === "installed" ? [original] : [],
    uninstallations: state === "uninstalled" ? [{ actionId: "00000000-0000-4000-8000-000000000082", settingsRevision: "2", installation: original, state: "sealed" }] : [],
  };
  mockIpc({ read: () => previous });
  const user = await openManager();
  const review = await choosePack(user);
  expect(within(review).getByText(/cannot change the source or publisher of an existing package/)).toBeVisible();
  await user.click(memberCheckbox("network-reference"));
  const install = screen.getByRole("button", { name: "Approve and install selected packages" });
  expect(install).toBeDisabled();
  await user.click(memberCheckbox("local-helper"));
  expect(install).toBeDisabled();
  await user.click(memberCheckbox("network-reference"));
  expect(install).toBeEnabled();
  expectNoMutations();
});
