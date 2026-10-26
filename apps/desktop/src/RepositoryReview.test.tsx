import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { PluginManager } from "./PluginManager";
import { i18n } from "./i18n";
import { validateResponseCandidate, validateResponseInventory, validateRequestRepositoryRefresh, validateRequestRepositoryResume, validateRequestRepositoryInstall } from "./generated/plugins.validators";
import type { PluginInventoryView, PluginRepositorySelectionView, PluginRepositorySourcesView, PluginRepositoryVerifiedView, PluginRepositoryRefreshRequest, PluginRepositoryResumeRequest, PluginRepositoryInstallRequest } from "./pluginCommands";
import inventoryFixture from "../test/fixtures/pluginInventory.contract.json";
import packageFixture from "../test/fixtures/pluginPackage.contract.json";

const invoke = vi.hoisted(() => vi.fn<(command: string, envelope: { request: unknown }) => Promise<unknown>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const onBusy = vi.fn();
function fixtureManifest() {
  const value: unknown = packageFixture;
  if (!validateResponseCandidate(value) || value === null) throw new Error("Invalid package fixture");
  return value.manifest;
}
function fixtureInventory(): PluginInventoryView {
  const value: unknown = inventoryFixture.empty;
  if (!validateResponseInventory(value)) throw new Error("Invalid inventory fixture");
  return value;
}
const manifest = fixtureManifest();
const empty = fixtureInventory();
const sourceId = "synthetic-signed-source";
const origin = { sourceId, publisherId: "synthetic-publisher-key" };
const selection: PluginRepositorySelectionView = {
  ticket: "00000000-0000-4000-8000-000000000050", sourceId,
  rootFingerprint: "1".repeat(64), captureDigest: "2".repeat(64), revision: "0",
};
function member(id: string, version: string, digest: string, kind: "install" | "update" | "rollback"): PluginRepositoryVerifiedView["packages"][number] {
  return {
    manifest: { ...manifest, plugin: { ...manifest.plugin, id, version },
      permissions: [...manifest.permissions, { kind: "network", destination: "https://repository.example.test" }, { kind: "process", program: "synthetic-helper" }],
    },
    packageDigest: digest.repeat(64), fileCount: 2, byteCount: "1024", origin, kind,
  };
}
const repository: PluginRepositoryVerifiedView = {
  ticket: "00000000-0000-4000-8000-000000000051", sourceId, revision: "1",
  actionId: "00000000-0000-4000-8000-000000000052", captureDigest: selection.captureDigest,
  displayName: "Synthetic repository", rootVersion: "1", timestampVersion: "4", snapshotVersion: "3", targetsVersion: "2",
  expiresAtUnixMilliseconds: "4102444800000",
  packages: [member("signed-tools", "1.0.0", "a", "rollback"), member("signed-tools", "2.0.0", "b", "update"), member("signed-reference", "1.0.0", "c", "install")],
};
const previous: PluginInventoryView = {
  ...empty, settingsRevision: "9007199254740993", lastSettingsAction: "00000000-0000-4000-8000-000000000053",
  packages: [{ plugin: { ...manifest.plugin, id: "signed-tools", version: "1.5.0" }, packageDigest: "d".repeat(64), origin,
    state: "sealed", originalInstallAction: "00000000-0000-4000-8000-000000000054" }],
  packageDecisions: [{ plugin: { ...manifest.plugin, id: "signed-tools", version: "1.5.0" }, packageDigest: "d".repeat(64), origin, enabled: false }],
};
let sources: PluginRepositorySourcesView;
function verified(request: PluginRepositoryRefreshRequest | PluginRepositoryResumeRequest): PluginRepositoryVerifiedView {
  sources = { sources: [{ sourceId, rootFingerprint: selection.rootFingerprint, displayName: repository.displayName, actionId: request.actionId, expectedRevision: request.expectedRevision,
    revision: (BigInt(request.expectedRevision) + 1n).toString(), state: "verified" }] };
  return { ...repository, actionId: request.actionId, revision: (BigInt(request.expectedRevision) + 1n).toString() };
}
function installed(request: PluginRepositoryInstallRequest): PluginInventoryView {
  return { ...previous, settingsRevision: (BigInt(request.expectedRevision) + 1n).toString(), lastSettingsAction: request.actionId,
    packages: [...previous.packages, ...request.members.map((item): PluginInventoryView["packages"][number] => ({ ...item.package, origin, state: "sealed", originalInstallAction: request.actionId }))],
    packageDecisions: [...previous.packageDecisions, ...request.members.map(item => ({ ...item.package, origin, enabled: false }))],
  };
}
function mockIpc({ readInventory = () => previous, refresh = verified, resume = verified, install = installed }: {
  readInventory?: () => PluginInventoryView;
  refresh?: (request: PluginRepositoryRefreshRequest) => unknown | Promise<unknown>;
  resume?: (request: PluginRepositoryResumeRequest) => unknown | Promise<unknown>;
  install?: (request: PluginRepositoryInstallRequest) => unknown | Promise<unknown>;
} = {}) {
  invoke.mockImplementation(async (command, { request }) => {
    if (command === "read_plugin_inventory") return readInventory();
    if (command === "read_plugin_repositories") return sources;
    if (command === "select_plugin_repository") return selection;
    if (command === "refresh_plugin_repository") {
      if (!validateRequestRepositoryRefresh(request)) throw new Error("Invalid trust refresh request");
      return refresh(request);
    }
    if (command === "resume_plugin_repository") {
      if (!validateRequestRepositoryResume(request)) throw new Error("Invalid original trust request");
      return resume(request);
    }
    if (command === "install_repository_packages") {
      if (!validateRequestRepositoryInstall(request)) throw new Error("Invalid repository installation request");
      return install(request);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
}
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
function installRequest(): PluginRepositoryInstallRequest {
  const value = calls("install_repository_packages")[0]?.[1].request;
  if (!validateRequestRepositoryInstall(value)) throw new Error("Missing valid installation request");
  return value;
}
const packageCheckbox = (id: string, version: string) => screen.getByRole("checkbox", { name: `I approve ${id} ${version} and all permissions listed above` });
const rollbackCheckbox = () => screen.getByRole("checkbox", { name: "I confirm rolling signed-tools back to 1.0.0" });
async function openRepositories() {
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await user.click(await screen.findByRole("button", { name: "Signed repositories" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Select trust root and repository folder" })).toBeEnabled());
  return user;
}
async function reviewRepository(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Select trust root and repository folder" }));
  await user.click(await screen.findByRole("checkbox", { name: "I have verified this root fingerprint and approve updating trust for this repository." }));
  await user.click(screen.getByRole("button", { name: "Verify and update repository trust" }));
  await screen.findByRole("region", { name: "Review repository: Synthetic repository" });
  await waitFor(() => expect(packageCheckbox("signed-tools", "2.0.0")).toBeEnabled());
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  sources = { sources: [] };
  onBusy.mockReset();
  invoke.mockReset();
  mockIpc();
});
afterEach(cleanup);

it.each([
  { locale: "en-US", open: "Extensions", repositories: "Signed repositories", choose: "Select trust root and repository folder", consent: "I have verified this root fingerprint and approve updating trust for this repository.", refresh: "Verify and update repository trust", close: "Close", title: "Review repository: Synthetic repository" },
  { locale: "zh-CN", open: "扩展", repositories: "签名仓库", choose: "选择信任根与仓库文件夹", consent: "我已核对此信任根指纹，并批准更新此仓库的信任状态。", refresh: "校验并更新仓库信任", close: "关闭", title: "查看仓库：Synthetic repository" },
])("requires fingerprint consent before revealing selectable packages in $locale", async labels => {
  await i18n.changeLanguage(labels.locale);
  const user = userEvent.setup();
  render(<PluginManager disabled={false} onBusyChange={onBusy}/>, { wrapper: ApplicationReadProvider });
  await user.click(screen.getByRole("button", { name: labels.open }));
  expect(calls("read_plugin_repositories")).toHaveLength(0);
  await user.click(await screen.findByRole("button", { name: labels.repositories }));
  const choose = await screen.findByRole("button", { name: labels.choose });
  await waitFor(() => expect(choose).toBeEnabled());
  await user.click(choose);
  expect(await screen.findByText(selection.rootFingerprint)).toBeVisible();
  expect(screen.queryByRole("region", { name: labels.title })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: labels.refresh })).toBeDisabled();
  expect(calls("refresh_plugin_repository")).toHaveLength(0);
  await user.click(screen.getByRole("checkbox", { name: labels.consent }));
  await user.click(screen.getByRole("button", { name: labels.close }));
  await user.click(screen.getByRole("button", { name: labels.open }));
  await waitFor(() => expect(screen.getByRole("button", { name: labels.refresh })).toBeEnabled());
  expect(screen.getByRole("checkbox", { name: labels.consent })).toBeChecked();
  expect(calls("refresh_plugin_repository")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: labels.refresh }));
  const review = await screen.findByRole("region", { name: labels.title });
  for (const input of within(review).getAllByRole("checkbox")) expect(input).not.toBeChecked();
  expect(within(review).getAllByText("https://repository.example.test")).toHaveLength(3);
  expect(within(review).getAllByText("synthetic-helper")).toHaveLength(3);
  expect(within(review).getAllByText(new RegExp(origin.publisherId))).toHaveLength(3);
  expect(calls("refresh_plugin_repository")[0][1]).toEqual({ request: { ticket: selection.ticket, expectedRevision: selection.revision, actionId: expect.any(String) } });
  expect(calls("install_repository_packages")).toHaveLength(0);
});

it("replaces another version's consent and submits only the exact chosen update", async () => {
  const user = await openRepositories();
  await reviewRepository(user);
  await user.click(packageCheckbox("signed-tools", "1.0.0"));
  await user.click(rollbackCheckbox());
  await user.click(packageCheckbox("signed-tools", "2.0.0"));
  expect(packageCheckbox("signed-tools", "1.0.0")).not.toBeChecked();
  expect(rollbackCheckbox()).not.toBeChecked();
  expect(rollbackCheckbox()).toBeDisabled();
  expect(packageCheckbox("signed-reference", "1.0.0")).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "Approve and install selected packages" }));
  expect(await screen.findByText(/Changes saved/)).toBeInTheDocument();
  const selectedMember = repository.packages.find(member => member.manifest.plugin.id === "signed-tools" && member.manifest.plugin.version === "2.0.0");
  if (!selectedMember) throw new Error("Missing signed-tools 2.0.0 fixture member");
  expect(calls("install_repository_packages")[0][1]).toEqual({ request: {
    ticket: repository.ticket, expectedRevision: previous.settingsRevision, actionId: expect.any(String),
    members: [{ package: { plugin: selectedMember.manifest.plugin, packageDigest: selectedMember.packageDigest }, kind: "update" }],
  } });
  for (const enable of screen.getAllByRole("button", { name: "Enable" })) expect(enable).toBeEnabled();
  expect(calls("set_plugin_enabled")).toHaveLength(0);
});

it("keeps trust verification independent from unavailable plugin settings and blocks package installation", async () => {
  mockIpc({ readInventory: () => { throw new Error("Plugin settings unavailable"); } });
  const user = await openRepositories();
  await user.click(screen.getByRole("button", { name: "Select trust root and repository folder" }));
  await user.click(await screen.findByRole("checkbox", { name: /I have verified this root fingerprint/ }));
  await user.click(screen.getByRole("button", { name: "Verify and update repository trust" }));
  const review = await screen.findByRole("region", { name: "Review repository: Synthetic repository" });
  expect(screen.getByText(/Repository trust was verified, but current plugin settings could not be read/)).toBeInTheDocument();
  for (const input of within(review).getAllByRole("checkbox")) expect(input).toBeDisabled();
  expect(within(review).getByRole("button", { name: "Approve and install selected packages" })).toBeDisabled();
  expect(within(review).getByRole("button", { name: "Close package review" })).toBeEnabled();
  expect(calls("refresh_plugin_repository")).toHaveLength(1);
  expect(calls("install_repository_packages")).toHaveLength(0);
});

it("requires separate explicit rollback consent and never reuses it after changing versions", async () => {
  const user = await openRepositories();
  await reviewRepository(user);
  await user.click(packageCheckbox("signed-tools", "1.0.0"));
  const install = () => screen.getByRole("button", { name: "Install selected packages (including rollbacks)" });
  expect(install()).toBeDisabled();
  await user.click(rollbackCheckbox());
  expect(install()).toBeEnabled();
  await user.click(packageCheckbox("signed-tools", "2.0.0"));
  await user.click(packageCheckbox("signed-tools", "1.0.0"));
  expect(rollbackCheckbox()).not.toBeChecked();
  expect(install()).toBeDisabled();
  await user.click(rollbackCheckbox());
  await user.click(install());
  await screen.findByText(/Changes saved/);
  expect(installRequest().members).toEqual([{ package: { plugin: repository.packages[0].manifest.plugin, packageDigest: repository.packages[0].packageDigest }, kind: "rollback" }]);
  expect(calls("refresh_plugin_repository")).toHaveLength(1);
  expect(calls("resume_plugin_repository")).toHaveLength(0);
});

it("keeps a conflicting member separate and locks all actions while another member installs", async () => {
  const conflictingMember = repository.packages.find(member => member.manifest.plugin.id === "signed-reference");
  if (!conflictingMember) throw new Error("Missing signed-reference fixture member");
  const conflicting: PluginInventoryView = { ...previous, packageDecisions: [...previous.packageDecisions, {
    plugin: conflictingMember.manifest.plugin, packageDigest: "e".repeat(64), origin: { sourceId: "other-source", publisherId: "other-key" }, enabled: false,
  }] };
  let finish: ((view: PluginInventoryView) => void) | undefined;
  const pending = new Promise<PluginInventoryView>(resolve => { finish = resolve; });
  mockIpc({ readInventory: () => conflicting, install: () => pending });
  const user = await openRepositories();
  await reviewRepository(user);
  expect(packageCheckbox("signed-reference", "1.0.0")).toBeDisabled();
  expect(screen.getByText(/This package conflicts with an existing source/)).toBeInTheDocument();
  await user.click(packageCheckbox("signed-tools", "2.0.0"));
  await user.click(screen.getByRole("button", { name: "Approve and install selected packages" }));
  await waitFor(() => expect(calls("install_repository_packages")).toHaveLength(1));
  for (const name of ["Close", "Select plugin folder", "Select offline Pack folder", "Select trust root and repository folder", "Refresh repository sources", "Close package review"]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(onBusy).toHaveBeenLastCalledWith(true);
  const resolveInstall = finish;
  if (!resolveInstall) throw new Error("Missing installation resolver");
  await act(async () => resolveInstall(installed(installRequest())));
  await screen.findByText(/Changes saved/);
  await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());
  expect(onBusy).toHaveBeenLastCalledWith(false);
});

it("retains an unknown refresh across source reads and reopening, then retries its original trust action", async () => {
  let attempts = 0;
  mockIpc({ refresh: request => {
    if (++attempts === 1) {
      sources = { sources: [{ sourceId, rootFingerprint: selection.rootFingerprint, displayName: null, state: "pending", revision: "0", actionId: request.actionId, expectedRevision: request.expectedRevision }] };
      throw new Error("Trust response interrupted");
    }
    return verified(request);
  } });
  const user = await openRepositories();
  await user.click(screen.getByRole("button", { name: "Select trust root and repository folder" }));
  await user.click(await screen.findByRole("checkbox", { name: /I have verified this root fingerprint/ }));
  await user.click(screen.getByRole("button", { name: "Verify and update repository trust" }));
  expect(await screen.findByRole("button", { name: "Retry original operation" })).toBeEnabled();
  const original = calls("refresh_plugin_repository")[0][1];
  await user.click(screen.getByRole("button", { name: "Refresh repository sources" }));
  await screen.findByText(/A trust update is awaiting confirmation/);
  expect(calls("refresh_plugin_repository")).toHaveLength(1);
  expect(calls("resume_plugin_repository")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Extensions" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry original operation" })).toBeEnabled());
  expect(screen.getByRole("button", { name: "Select trust root and repository folder" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Retry original operation" }));
  await screen.findByRole("region", { name: "Review repository: Synthetic repository" });
  expect(calls("refresh_plugin_repository")).toHaveLength(2);
  expect(calls("refresh_plugin_repository")[1][1]).toEqual(original);
  expect(calls("install_repository_packages")).toHaveLength(0);
});

it("only resumes a persisted pending source after an explicit action using its saved identity", async () => {
  const actionId = "00000000-0000-4000-8000-000000000060";
  sources = { sources: [{ sourceId, rootFingerprint: selection.rootFingerprint, displayName: repository.displayName, revision: "3", expectedRevision: "3", actionId, state: "pending" }] };
  const user = await openRepositories();
  expect(calls("resume_plugin_repository")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Refresh repository sources" }));
  await waitFor(() => expect(screen.getByRole("button", { name: `Continue pending trust update for ${repository.displayName}` })).toBeEnabled());
  expect(calls("resume_plugin_repository")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: `Continue pending trust update for ${repository.displayName}` }));
  await screen.findByRole("region", { name: "Review repository: Synthetic repository" });
  expect(calls("resume_plugin_repository")[0][1]).toEqual({ request: { sourceId, expectedRevision: "3", actionId } });
  expect(calls("select_plugin_repository")).toHaveLength(0);
  expect(calls("refresh_plugin_repository")).toHaveLength(0);
  expect(calls("install_repository_packages")).toHaveLength(0);
});

it.each(["source", "capture", "revision"])("refuses a trust acknowledgement with the wrong %s", async fault => {
  mockIpc({ refresh: request => {
    const view = verified(request);
    if (fault === "source") return { ...view, sourceId: "different-source" };
    if (fault === "capture") return { ...view, captureDigest: "f".repeat(64) };
    return { ...view, revision: request.expectedRevision };
  } });
  const user = await openRepositories();
  await user.click(screen.getByRole("button", { name: "Select trust root and repository folder" }));
  await user.click(await screen.findByRole("checkbox", { name: /I have verified this root fingerprint/ }));
  await user.click(screen.getByRole("button", { name: "Verify and update repository trust" }));
  expect(await screen.findByRole("button", { name: "Retry original operation" })).toBeEnabled();
  expect(screen.queryByRole("region", { name: "Review repository: Synthetic repository" })).not.toBeInTheDocument();
  expect(screen.getByText(selection.rootFingerprint)).toBeInTheDocument();
  expect(onBusy).toHaveBeenLastCalledWith(true);
});

it.each(["missing-member", "wrong-origin"])("keeps installation unconfirmed after a %s acknowledgement", async fault => {
  mockIpc({ install: request => {
    const view = installed(request);
    return fault === "missing-member" ? { ...view, packages: previous.packages }
      : { ...view, packages: view.packages.map(item => ({ ...item, origin: { sourceId: "other-source", publisherId: "other-key" } })) };
  } });
  const user = await openRepositories();
  await reviewRepository(user);
  await user.click(packageCheckbox("signed-tools", "2.0.0"));
  await user.click(screen.getByRole("button", { name: "Approve and install selected packages" }));
  expect(await screen.findByRole("button", { name: "Retry original operation" })).toBeEnabled();
  expect(screen.queryByText(/Changes saved/)).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Review repository: Synthetic repository" })).toBeInTheDocument();
  expect(packageCheckbox("signed-tools", "2.0.0")).toBeChecked();
  expect(packageCheckbox("signed-tools", "2.0.0")).toBeDisabled();
  expect(onBusy).toHaveBeenLastCalledWith(true);
});
