import { refreshWorkbenchReads, renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReleaseWorkbench } from "./ReleaseWorkbench";
import type { ProjectView } from "./projectCommands";
import type { DeliveryView, ReleaseView, SavedPluginBuildView } from "./releaseCommands";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { pluginBuildInventory, pluginBuildPackage, pluginBuildView, pluginBuildRequest, pluginBuildWorkflow, savedPluginBuild } from "./testSupport/pluginBuildFixture";
import { createRef } from "react";
import { WorkbenchCommands } from "./workbenchCommands";
import type { ReleaseHandle } from "./ReleaseWorkbench";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const project: ProjectView = {
  sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(700), displayName: "Demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" },
};
const release: ReleaseView = { releaseId: fixtureIdentity(702), actionId: fixtureIdentity(706), attemptId: fixtureIdentity(701), sourceSnapshotId: fixtureIdentity(707),
  policyVersion: "balanced-1", eligibilityBasis: "basis", manifestSha256: "manifest-hash",
  builderVersion: "builder-1", validatorVersion: "validator-1", sourceFiles: [], exceptions: [],
  createdAt: "2026-09-29T00:00:00Z",
  artifacts: [{ locale: "zh-CN", fileName: "i18n/zh.json", sha256: "hash", entryCount: 532 }] };
let releases: typeof release[];
let deliveryRows: DeliveryView[];
beforeEach(async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  await i18n.changeLanguage("en-US");
  releases = [];
  deliveryRows = [];
  invoke.mockReset();
  invoke.mockImplementation(async (command: string,args?: { request: Record<string, unknown> }) => {
    if (command === "list_releases") return releases;
    if (command === "read_plugin_inventory") return { ...pluginBuildInventory, packages: [], packageDecisions: [], runtimes: [], runtimeDecisions: [] };
    if (command === "read_plugin_package") return pluginBuildPackage;
    if (command === "read_plugin_build") return pluginBuildView;
    if (command === "prepare_plugin_build") return { ...pluginBuildWorkflow.review,attemptId:args!.request.attemptId,choices:args!.request.choices,eligibilityBasis:args!.request.expectedEligibilityBasis,sourceSnapshotId:fixtureIdentity(707) };
    if (command === "cancel_plugin_build_preparation") return false;
    if (command === "read_content_scope") return { currentSnapshot: fixtureIdentity(707), revision: "1" };
    if (command === "read_review_eligibility") return { policyVersion: "balanced-1", sourceSnapshotId: fixtureIdentity(707), basis: "basis", ready: true,
      locales: [{ locale: "zh-CN", ready: true, blockers: [], exceptions: [], checkedUnits: 532, blockerCount: 0, exceptionCount: 0 }] };
    if (command === "create_execution_identity") return fixtureIdentity(1);
    if (command === "choose_delivery_folder") return { selectionId: fixtureIdentity(704), folderName: "export" };
    if (command === "preview_delivery") return { previewId: fixtureIdentity(705), releaseId: fixtureIdentity(702), selectionId: fixtureIdentity(704), folderName: "export",
      files: [{ locale: "zh-CN", fileName: "i18n/zh.json", expectedSha256: "hash", currentSha256: "old", state: "conflict" }] };
    if (command === "list_deliveries") return deliveryRows;
    if (command === "reconcile_delivery") return { ...deliveryRows[0], state: "succeeded", files: deliveryRows[0].files.map(file => ({ ...file, state: "succeeded", actualSha256: file.expectedSha256 })) };
    if (command === "export_release") return { deliveryId: fixtureIdentity(708), actionId: fixtureIdentity(1), releaseId: fixtureIdentity(702), directory: "C:\\isolated\\export",
      overwriteConflicts: true,
      state: "succeeded", files: [{ locale: "zh-CN", fileName: "i18n/zh.json", expectedSha256: "hash", actualSha256: "hash", state: "succeeded" }], createdAt: "today" };
    throw new Error(command);
  });
});

function installedBuilder() {
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args)=>command==="read_plugin_inventory"?Promise.resolve(pluginBuildInventory):original(command,args));
}
async function readyBuild() {
  installedBuilder();
  const user = userEvent.setup(), ref = createRef<ReleaseHandle>();
  const view = render(<ReleaseWorkbench ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button",{name:i18n.t("release.title")}));
  await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("releasePlugin.refresh")})).toBeEnabled());
  await user.click(screen.getByRole("checkbox",{name:"zh-CN"}));
  await user.type(screen.getByRole("textbox",{name:i18n.t("releasePlugin.paths",{locale:"zh-CN"})}),"i18n/zh.json");
  await user.click(screen.getByRole("button",{name:i18n.t("release.check")}));
  await screen.findByText(i18n.t("release.ready",{count:0}));
  return {user,ref,view};
}

async function readyExport() {
  releases = [release];
  const user = userEvent.setup();
  const ref = createRef<ReleaseHandle>();
  const view = render(<ReleaseWorkbench ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Build and export" }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  await user.click(screen.getByRole("button", { name: "Choose export folder" }));
  await user.click(await screen.findByRole("button", { name: "Check destination" }));
  await user.click(screen.getByRole("checkbox", { name: /Replace the existing conflicting files/ }));
  return { user, ref, view };
}

function historicalBuild(): SavedPluginBuildView { return { ...structuredClone(savedPluginBuild), projectId: project.metadata.projectId }; }
function savedBuildReads(read: (attemptId: string) => Promise<SavedPluginBuildView>) {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: { attemptId?: string } }) => command === "read_saved_plugin_build"
    ? read(args.request.attemptId!) : original(command, args));
}
function expectHistoricalReadsOnly() {
  expect(invoke.mock.calls.every(([command]) => ["read_plugin_inventory", "list_releases", "read_saved_plugin_build"].includes(command))).toBe(true);
}

it.each(["en-US", "zh-CN"])("inspects a historical plugin build without an installed builder or renewed approval in %s", async language => {
  await i18n.changeLanguage(language);
  const saved = historicalBuild(), ref = createRef<ReleaseHandle>();
  savedBuildReads(async () => saved);
  render(<ReleaseWorkbench ref={ref} project={project} disabled={false} />);
  await act(async () => { expect(ref.current!.showSavedBuild(saved.attemptId)).toBe(true); });
  const summary = await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  expect(summary).toHaveTextContent(i18n.t("releasePlugin.savedReadOnly"));
  expect(summary).toHaveTextContent(i18n.t("releasePlugin.savedTargets", { count: 2 }));
  for (const artifact of saved.locales[0].result!.artifacts) {
    expect(screen.getByLabelText(i18n.t("releasePlugin.savedSha", { path: artifact.logicalPath }))).toHaveTextContent(artifact.sha256);
  }
  expect(screen.getByRole("button", { name: i18n.t("releasePlugin.savedBack") })).toBeEnabled();
  expect(invoke.mock.calls.some(([command]) => command === "read_plugin_inventory" || command === "read_plugin_package" || command === "read_plugin_build")).toBe(false);
  expect(screen.queryByRole("checkbox", { name: i18n.t("releasePlugin.builderConsent") })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("releasePlugin.startCheck") })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("releasePlugin.recordRelease") })).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("read_saved_plugin_build", { request: { sessionToken: project.sessionToken, projectId: project.metadata.projectId, attemptId: saved.attemptId } });
  expectHistoricalReadsOnly();
});

it.each(["absent", "failed"] as const)("distinguishes %s saved build output without fabricating files", async state => {
  const saved = historicalBuild(), locale = saved.locales[0], ref = createRef<ReleaseHandle>();
  if (state === "absent") { locale.result = null; locale.status.execution = "queued"; }
  else { locale.result!.outcome = "failed"; locale.result!.artifacts = []; locale.status.execution = "failed"; }
  savedBuildReads(async () => saved);
  render(<ReleaseWorkbench ref={ref} project={project} disabled={false} />);
  await act(async () => { expect(ref.current!.showSavedBuild(saved.attemptId)).toBe(true); });
  await screen.findByText(i18n.t(state === "absent" ? "releasePlugin.savedNoResult" : "releasePlugin.savedFailed"));
  expect(screen.queryByRole("list", { name: i18n.t("releasePlugin.savedArtifacts", { locale: "zh-CN" }) })).not.toBeInTheDocument();
  expectHistoricalReadsOnly();
});

it("discards another saved attempt's late read and recovers an exact identity error without a grant", async () => {
  // The canonical input and package fingerprints share bytes. This case needs
  // a distinct input marker while preserving both attempts' original builder.
  const first = { ...historicalBuild(), inputDigest: "c".repeat(64) }, second = { ...historicalBuild(), attemptId: fixtureIdentity(890), inputDigest: "f".repeat(64) };
  let resolveFirst!: (value: SavedPluginBuildView) => void;
  const deferred = new Promise<SavedPluginBuildView>(resolve => { resolveFirst = resolve; });
  let correct = false;
  savedBuildReads(async id => id === first.attemptId ? deferred : correct ? second : first);
  const ref = createRef<ReleaseHandle>(), user = userEvent.setup();
  render(<ReleaseWorkbench ref={ref} project={project} disabled={false} />);
  await act(async () => { expect(ref.current!.showSavedBuild(first.attemptId)).toBe(true); });
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_saved_plugin_build")).toBe(true));
  await act(async () => { expect(ref.current!.showSavedBuild(second.attemptId)).toBe(true); });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(i18n.t("releasePlugin.savedReadFailed"));
  expect(alert).toHaveFocus();
  await act(async () => { resolveFirst(first); await deferred; });
  expect(screen.queryByRole("region", { name: i18n.t("releasePlugin.savedTitle") })).not.toBeInTheDocument();
  correct = true;
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.savedRefresh") }));
  const summary = await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  await user.click(screen.getByText(i18n.t("sourcePlugin.fixedDetails")));
  expect(screen.getByText(second.inputDigest)).toBeVisible();
  expect(screen.queryByText(first.inputDigest)).not.toBeInTheDocument();
  expect(within(summary).getByText(i18n.t("sourcePlugin.packageDigest"), { selector: "dt" }).nextElementSibling)
    .toHaveTextContent(second.build.binding.builder.provider.packageDigest);
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.savedBack") }));
  expect(screen.queryByRole("region", { name: i18n.t("releasePlugin.savedView") })).not.toBeInTheDocument();
  expectHistoricalReadsOnly();
});

it("reads the same saved build afresh after a consumer remount without restoring prepared consent", async () => {
  const saved = historicalBuild(), ref = createRef<ReleaseHandle>(), user = userEvent.setup();
  let reads = 0, resolveFresh!: (value: SavedPluginBuildView) => void;
  const fresh = new Promise<SavedPluginBuildView>(resolve => { resolveFresh = resolve; });
  savedBuildReads(async () => ++reads === 1 ? saved : fresh);
  const view = render(<ReleaseWorkbench key="first" ref={ref} project={project} disabled={false} />);
  await act(async () => { expect(ref.current!.showSavedBuild(saved.attemptId)).toBe(true); });
  await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  await user.click(screen.getByRole("button", { name: i18n.t("workbench.backOverview") }));
  view.rerender(<ReleaseWorkbench key="second" ref={ref} project={project} disabled={false} />);
  await act(async () => { expect(ref.current!.showSavedBuild(saved.attemptId)).toBe(true); });
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.getByRole("region", { name: i18n.t("releasePlugin.savedView") })).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByRole("checkbox", { name: i18n.t("releasePlugin.builderConsent") })).not.toBeInTheDocument();
  await act(async () => { resolveFresh(saved); await fresh; });
  await waitFor(() => expect(screen.getByRole("region", { name: i18n.t("releasePlugin.savedView") })).toHaveAttribute("aria-busy", "false"));
  expect(screen.getByRole("region", { name: i18n.t("releasePlugin.savedTitle") })).toHaveTextContent(i18n.t("releasePlugin.savedReadOnly"));
  expect(invoke.mock.calls.filter(([command]) => command === "read_saved_plugin_build").map(([, args]) => args.request.attemptId)).toEqual([saved.attemptId, saved.attemptId]);
  expectHistoricalReadsOnly();
});

it("cancels a pending saved inspection without creating authority or reopening it from a late result", async () => {
  const saved = historicalBuild(), ref = createRef<ReleaseHandle>(), user = userEvent.setup();
  let resolve!: (value: SavedPluginBuildView) => void;
  const deferred = new Promise<SavedPluginBuildView>(done => { resolve = done; });
  savedBuildReads(async () => deferred);
  render(<ReleaseWorkbench ref={ref} project={project} disabled={false} />);
  await act(async () => { expect(ref.current!.showSavedBuild(saved.attemptId)).toBe(true); });
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_saved_plugin_build")).toBe(true));
  expect(screen.getByRole("region", { name: i18n.t("releasePlugin.savedView") })).toHaveAttribute("aria-busy", "true");
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.savedBack") }));
  await act(async () => { resolve(saved); await deferred; });
  expect(screen.queryByRole("region", { name: i18n.t("releasePlugin.savedView") })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: i18n.t("releasePlugin.savedTitle") })).not.toBeInTheDocument();
  await act(async () => { expect(ref.current!.showSavedBuild(saved.attemptId)).toBe(true); });
  await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  expect(invoke.mock.calls.filter(([command]) => command === "read_saved_plugin_build").map(([, args]) => args.request.attemptId)).toEqual([saved.attemptId, saved.attemptId]);
  expectHistoricalReadsOnly();
});

it("preserves a confirmed export and refreshes only its history after a read failure", async () => {
  const { user, ref } = await readyExport();
  const original = invoke.getMockImplementation()!;
  let failed = true;
  invoke.mockImplementation((command: string, args: unknown) => command === "list_deliveries" && failed ? Promise.reject({ code: "storage-failed" }) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Export these files" }));
  expect(await screen.findByText("Export verified")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Export history could not refresh");
  expect(screen.getByRole("alert")).toHaveFocus();
  expect(await ref.current!.allowLeave()).toBe(true);
  failed = false;
  await user.click(screen.getByRole("button", { name: "Refresh export history" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByText("Export verified")).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([c]) => c === "export_release")).toHaveLength(1);
});

it("retains the original export after a lost ACK even when history also fails", async () => {
  const { user, ref } = await readyExport();
  const original = invoke.getMockImplementation()!;
  const delivery = await original("export_release");
  invoke.mockImplementation((command: string, args: unknown) => command === "export_release" ? Promise.reject({ code: "outcome-unknown" })
    : command === "list_deliveries" ? Promise.reject({ code: "storage-failed" })
    : command === "read_delivery_action" ? Promise.resolve(delivery) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Export these files" }));
  await screen.findByText(/These files may have been exported/);
  expect(await ref.current!.allowLeave()).toBe(false);
  expect(screen.getByRole("alert")).toHaveTextContent("The action may have completed");
  await user.click(screen.getByRole("button", { name: "Check this export" }));
  expect(await screen.findByText("Export verified")).toBeInTheDocument();
  expect(await ref.current!.allowLeave()).toBe(true);
  expect(invoke.mock.calls.filter(([c]) => c === "export_release")).toHaveLength(1);
  expect(invoke.mock.calls.find(([c]) => c === "read_delivery_action")![1].request).toMatchObject({ actionId: fixtureIdentity(1), selectionId: fixtureIdentity(704) });
});

it("requires a fresh destination preview after an exact export lookup finds no action", async () => {
  const { user, ref } = await readyExport();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "export_release" ? Promise.reject(new Error("Disconnected"))
    : command === "read_delivery_action" ? Promise.resolve(null) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Export these files" }));
  await user.click(await screen.findByRole("button", { name: "Check this export" }));
  await screen.findByText(/This export did not start/);
  expect(await ref.current!.allowLeave()).toBe(true);
  expect(screen.queryByRole("button", { name: "Export these files" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check destination" })).toBeEnabled();
  expect(invoke.mock.calls.filter(([c]) => c === "export_release")).toHaveLength(1);
});

it("preserves a rejected export error when its history refresh also fails", async () => {
  const { user, ref } = await readyExport();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "export_release" ? Promise.reject({ code: "destination-conflict", outcome: "rejected", stage: "execution-adopt", recoveryRequired: false })
    : command === "list_deliveries" ? Promise.reject({ code: "storage-failed" }) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Export these files" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("The destination changed");
  expect(alert).toHaveTextContent("Export history could not refresh");
  expect(await ref.current!.allowLeave()).toBe(true);
  expect(screen.queryByText(/These files may have been exported/)).not.toBeInTheDocument();
});

it("keeps an uncertain export locked when the exact action lookup fails", async () => {
  const { user, ref } = await readyExport();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "export_release" ? Promise.reject({ code: "outcome-unknown" })
    : command === "read_delivery_action" ? Promise.reject({ code: "storage-failed" }) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Export these files" }));
  await user.click(await screen.findByRole("button", { name: "Check this export" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check this export" })).toBeEnabled());
  expect(await ref.current!.allowLeave()).toBe(false);
  expect(screen.queryByText(/This export did not start/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Export these files" })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([c]) => c === "export_release")).toHaveLength(1);
});

it.each([
  { code: "destination-conflict", outcome: "rejected" },
  { code: "destination-conflict", outcome: "rejected", stage: "execution-write", recoveryRequired: false },
])("checks the original export when a known-code rejection is malformed: %s", async failure => {
  const { user, ref } = await readyExport();
  const original = invoke.getMockImplementation()!;
  const delivery = await original("export_release");
  invoke.mockImplementation((command: string, args: unknown) => command === "export_release" ? Promise.reject(failure)
    : command === "read_delivery_action" ? Promise.resolve(delivery) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Export these files" }));
  await screen.findByText(/These files may have been exported/);
  expect(await ref.current!.allowLeave()).toBe(false);
  expect(screen.getByRole("alert")).toHaveTextContent("The action may have completed");
  expect(screen.getByRole("button", { name: "Back to overview" })).toBeEnabled();
  expect(await ref.current!.allowNavigate()).toBe(true);
  const originalRequest = invoke.mock.calls.find(([command]) => command === "export_release")![1].request;
  await user.click(screen.getByRole("button", { name: "Check this export" }));
  expect(await screen.findByText("Export verified")).toBeInTheDocument();
  expect(await ref.current!.allowLeave()).toBe(true);
  expect(invoke.mock.calls.find(([command]) => command === "read_delivery_action")![1].request.actionId).toBe(originalRequest.actionId);
  expect(invoke.mock.calls.filter(([command]) => command === "export_release")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
});
afterEach(() => {
  cleanup();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
it.each(["en-US", "zh-CN"])("exports saved arbitrary paths without requiring an installed builder in %s", async locale => {
  await i18n.changeLanguage(locale);
  releases = [{ ...release, artifacts: [{ locale: "zh-CN", fileName: "deliverables/captions.txt", sha256: "hash", entryCount: 2 }, { locale: "zh-CN", fileName: "deliverables/metadata.txt", sha256: "metadata", entryCount: 2 }] }];
  const user = userEvent.setup();
  render(<ReleaseWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  await user.click(screen.getByRole("button", { name: i18n.t("release.chooseFolder") }));
  expect(await screen.findByText(i18n.t("release.savedDestination", { name: "export" }))).toBeInTheDocument();
  expect(screen.getByText(/zh-CN → deliverables\/captions/)).toBeInTheDocument();
  expect(screen.getByText(/zh-CN → deliverables\/metadata/)).toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command === "read_source_integration" || command === "start_locale_build")).toBe(false);
});

it("routes an explicitly mapped subtitle to its root path and preserves the edited mapping", async () => {
  const {user}=await readyBuild(),name=screen.getByRole("textbox",{name:i18n.t("releasePlugin.paths",{locale:"zh-CN"})});
  expect(name).toHaveValue("i18n/zh.json");await user.clear(name);await user.type(name,"captions-zh.vtt");
  await user.click(screen.getByRole("button",{name:i18n.t("release.check")}));await screen.findByText(/Ready to build/);
  await user.click(screen.getByRole("button",{name:i18n.t("releasePlugin.capture")}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("prepare_plugin_build",{request:{sessionToken:"session",projectId:fixtureIdentity(700),attemptId:fixtureIdentity(1),expectedEligibilityBasis:"basis",
    build:pluginBuildRequest,choices:[{locale:"zh-CN",outputPaths:["captions-zh.vtt"],configuration:[]}]}}));
  expect(screen.getByRole("textbox",{name:i18n.t("releasePlugin.paths",{locale:"zh-CN"})})).toHaveValue("captions-zh.vtt");
  expect(invoke.mock.calls.some(([command])=>command==="read_source_integration"||command==="start_locale_build"||command==="start_plugin_build")).toBe(false);
});

it("sends the explicit locale mapping and current eligibility basis to the native build boundary", async () => {
  const {user}=await readyBuild();
  expect(screen.getByRole("textbox",{name:i18n.t("releasePlugin.paths",{locale:"zh-CN"})})).toHaveValue("i18n/zh.json");
  await user.click(screen.getByRole("button",{name:i18n.t("releasePlugin.capture")}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("prepare_plugin_build",{request:{sessionToken:"session",projectId:fixtureIdentity(700),attemptId:fixtureIdentity(1),expectedEligibilityBasis:"basis",
    build:pluginBuildRequest,choices:[{locale:"zh-CN",outputPaths:["i18n/zh.json"],configuration:[]}]}}));
  expect(screen.getByRole("checkbox",{name:i18n.t("releasePlugin.builderConsent")})).not.toBeChecked();
  expect(screen.getByRole("button",{name:i18n.t("release.build")})).toBeDisabled();
  expect(invoke.mock.calls.filter(([command])=>command==="start_plugin_build")).toHaveLength(0);
});

it("requires explicit confirmation for a conflicting file before export", async () => {
  releases = [release];
  const user = userEvent.setup();
  render(<ReleaseWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Build and export" }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  await user.click(screen.getByRole("button", { name: "Choose export folder" }));
  await user.click(await screen.findByRole("button", { name: "Check destination" }));
  expect(await screen.findByRole("button", { name: "Export these files" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /Replace the existing conflicting files/ }));
  await user.click(screen.getByRole("button", { name: "Export these files" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("export_release", { request: {
    sessionToken: "session", projectId: fixtureIdentity(700), releaseId: fixtureIdentity(702), selectionId: fixtureIdentity(704),
    previewId: fixtureIdentity(705), actionId: fixtureIdentity(1), overwriteConflicts: true,
  } }));
});

it("rejects a preview for another release before offering an export", async () => {
  releases = [release];
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string,args?: { request: Record<string, unknown> }) => {
    const response = await original(command);
    return command === "preview_delivery" ? { ...response, releaseId: fixtureIdentity(799) } : response;
  });
  const user = userEvent.setup();
  render(<ReleaseWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Build and export" }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  await user.click(screen.getByRole("button", { name: "Choose export folder" }));
  await user.click(await screen.findByRole("button", { name: "Check destination" }));
  expect(await screen.findByRole("alert")).toHaveFocus();
  expect(screen.queryByRole("button", { name: "Export these files" })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "export_release")).toHaveLength(0);
});

it("keeps the chosen destination and preview when the folder picker is cancelled", async () => {
  releases = [release];
  const user = userEvent.setup();
  render(<ReleaseWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Build and export" }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  await user.click(screen.getByRole("button", { name: "Choose export folder" }));
  await user.click(await screen.findByRole("button", { name: "Check destination" }));
  expect(await screen.findByRole("button", { name: "Export these files" })).toBeDisabled();
  invoke.mockImplementationOnce(async () => null);
  await user.click(screen.getByRole("button", { name: "Choose export folder" }));
  expect(screen.getAllByText(/Export folder: export/)).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Export these files" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: /Replace the existing conflicting files/ })).toBeInTheDocument();
});

it("offers a destination check for an uncertain export before retry", async () => {
  releases = [release];
  deliveryRows = [{ deliveryId: fixtureIdentity(708), actionId: fixtureIdentity(711), releaseId: fixtureIdentity(702),
    directory: "C:\\isolated\\export", overwriteConflicts: false, state: "unknown", createdAt: "today",
    files: [{ locale: "zh-CN", fileName: "i18n/zh.json", expectedSha256: "hash", actualSha256: null, state: "unknown" }] }];
  const user = userEvent.setup();
  render(<ReleaseWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Build and export" }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  await user.click(screen.getByRole("button", { name: "Choose export folder" }));
  await user.click(await screen.findByRole("button", { name: "Check these files against the selected folder" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("reconcile_delivery", { request: {
    sessionToken: "session", projectId: fixtureIdentity(700), actionId: fixtureIdentity(711), selectionId: fixtureIdentity(704),
  } }));
});

it("ignores a folder choice returned after the project changes", async () => {
  releases = [release];
  const user = userEvent.setup();
  let resolvePicker!: (folder: { selectionId: string; folderName: string }) => void;
  const previous = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string) => command === "choose_delivery_folder"
    ? new Promise(resolve => { resolvePicker = resolve; }) : previous(command));
  const oldProject = { ...project, sessionToken: "old-session" };
  const nextProject = { ...project, sessionToken: "new-session" };
  const view = render(<ReleaseWorkbench key={oldProject.sessionToken} project={oldProject} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Build and export" }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  await user.click(screen.getByRole("button", { name: "Choose export folder" }));
  view.rerender(<ReleaseWorkbench key={nextProject.sessionToken} project={nextProject} disabled={false} />);
  await act(async () => resolvePicker({ selectionId: fixtureIdentity(715), folderName: "old-export" }));
  await user.click(screen.getByRole("button", { name: "Build and export" }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  expect(screen.queryByText(/old-export/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check destination" })).not.toBeInTheDocument();
});

it("continues an original build after the consumer unmounts and keeps newer file names on its confirmation", async () => {
  const { user, ref, view } = await readyBuild();
  const original = invoke.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string, args: unknown) => command === "prepare_plugin_build" ? new Promise<unknown>(resolve => { finish = resolve; }) : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.capture") }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "prepare_plugin_build")).toHaveLength(1));
  const name = screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths",{locale:"zh-CN"}) });
  await user.clear(name); await user.type(name, "newer.json");
  view.rerender(null);
  const request=invoke.mock.calls.find(([command])=>command==="prepare_plugin_build")![1].request;
  await act(async () => finish({...pluginBuildWorkflow.review,attemptId:request.attemptId,choices:request.choices,eligibilityBasis:request.expectedEligibilityBasis,sourceSnapshotId:fixtureIdentity(707)}));
  view.rerender(<ReleaseWorkbench ref={ref} project={project} disabled={false}/>);
  expect(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths",{locale:"zh-CN"}) })).toHaveValue("newer.json");
  expect(await screen.findByText(i18n.t("release.earlierPreparation"))).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start build" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_plugin_build")).toHaveLength(1);
});

it("retains captured release and consent across real consumer remount and a bounded history rollover", async () => {
  const { user, ref, view } = await readyExport();
  view.rerender(null); view.rerender(<ReleaseWorkbench ref={ref} project={project} disabled={false}/>);
  expect(screen.getByRole("checkbox", { name: /Replace the existing conflicting files/ })).toBeChecked();
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh releases" })).toBeEnabled());
  releases = [];
  await user.click(screen.getByRole("button", { name: "Refresh releases" }));
  await screen.findByText(i18n.t("release.empty"));
  expect(screen.getByRole("heading", { name: "Selected release" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export these files" })).toBeEnabled();
  expect(invoke.mock.calls.filter(([command]) => command === "choose_delivery_folder")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "preview_delivery")).toHaveLength(1);
});

it.each(["en-US", "zh-CN"])("keeps an original unknown export when a newly authorized folder has no record in %s", async language => {
  await i18n.changeLanguage(language);
  releases = [release];
  const user = userEvent.setup(), ref = createRef<ReleaseHandle>();
  render(<ReleaseWorkbench ref={ref} project={project} disabled={false}/>);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  await user.click(screen.getByRole("button", { name: i18n.t("release.chooseFolder") }));
  await user.click(await screen.findByRole("button", { name: i18n.t("release.preview") }));
  await user.click(screen.getByRole("checkbox", { name: i18n.t("release.overwrite") }));
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "export_release" ? Promise.reject(new Error("Lost ACK"))
    : command === "choose_delivery_folder" ? Promise.resolve({ selectionId: fixtureIdentity(799), folderName: "export" })
    : command === "read_delivery_action" ? Promise.resolve(null) : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("release.export") }));
  await user.click(await screen.findByRole("button", { name: i18n.t("release.reauthorizeFolder") }));
  await screen.findByText(i18n.t("release.reauthorizationLimit"));
  await user.click(screen.getByRole("button", { name: i18n.t("release.checkExport") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("release.checkExport") })).toBeEnabled());
  expect(await ref.current!.allowLeave()).toBe(false);
  expect(screen.queryByText(i18n.t("release.exportMissing"))).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("release.export") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.find(([command]) => command === "read_delivery_action")![1].request.selectionId).toBe(fixtureIdentity(799));
  expect(invoke.mock.calls.find(([command]) => command === "export_release")![1].request.selectionId).toBe(fixtureIdentity(704));
  expect(invoke.mock.calls.filter(([command]) => command === "export_release")).toHaveLength(1);
});

it("revokes readiness when project evidence changes and retains user mappings", async () => {
  const { user } = await readyBuild();
  await refreshWorkbenchReads(["resources"]);
  expect(await screen.findByText(i18n.t("release.readinessStale"))).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths",{locale:"zh-CN"}) })).toHaveValue("i18n/zh.json");
  expect(screen.getByRole("button", { name: i18n.t("releasePlugin.capture") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Check build readiness" }));
  await screen.findByText(i18n.t("release.ready", { count: 0 }));
});

it("revokes replacement consent as soon as a new destination preview is requested, including a failed response", async () => {
  const { user } = await readyExport();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "preview_delivery" ? Promise.reject(new Error("Preview ACK lost")) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Check destination" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Export these files" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: /Replace the existing conflicting files/ })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "export_release")).toHaveLength(0);
});


it("routes destination consent and immutable export through scoped Registry without rechecking current build readiness", async () => {
  const dispatch=vi.spyOn(WorkbenchCommands.prototype,"dispatch");
  try {
    const {user}=await readyExport();await user.click(screen.getByRole("button",{name:"Export these files"}));
    expect(await screen.findByText("Export verified")).toBeInTheDocument();
    expect(dispatch.mock.calls.map(([id])=>id)).toEqual(expect.arrayContaining([
      "release.choose-release","release.choose-destination","release.preview-destination","release.confirm-overwrite","release.export",
    ]));
    const exported=dispatch.mock.calls.find(([id])=>id==="release.export");
    expect(exported?.[1]).toEqual({projectId:project.metadata.projectId,sessionToken:project.sessionToken,area:"release"});
    expect(exported?.[2]).toMatchObject({kind:"release-preview",releaseId:release.releaseId,manifestSha256:release.manifestSha256,
      selectionId:fixtureIdentity(704),previewId:fixtureIdentity(705),overwrite:true});
    expect(invoke.mock.calls.filter(([name])=>name==="read_review_eligibility"||name==="start_locale_build")).toHaveLength(0);
  } finally {dispatch.mockRestore();}
});

it("reconciles a misbound fixed-build acknowledgement with the complete original request and requires a separate unchecked execution consent",async()=>{
  const {user,ref}=await readyBuild(),original=invoke.getMockImplementation()!;let preparations=0;
  invoke.mockImplementation(async(command,args)=>{
    if(command==="start_plugin_build")return args.request.attemptId;
    if(command==="read_execution_attempt") {
      const saved=historicalBuild();return {attemptId:args.request.attemptId,taskId:saved.taskId,operation:"locale-build",nextOffset:null,
        items:saved.locales.map(locale=>({scope:{kind:"locale",id:locale.choice.locale,locale:locale.choice.locale},status:locale.status,resultId:locale.result?.resultId??null})),
        progress:{total:saved.locales.length,queued:0,running:0,succeeded:saved.locales.length,failed:0,cancelled:0,unknown:0,adopted:0},
        recovery:{attemptId:args.request.attemptId,units:[]}};
    }
    const response=await original(command,args);
    return command==="prepare_plugin_build"&&++preparations===1?{...response,attemptId:fixtureIdentity(799)}:response;
  });
  await user.click(screen.getByRole("button",{name:i18n.t("releasePlugin.capture")}));
  await screen.findByText(i18n.t("releasePlugin.unknown"));
  expect(await ref.current!.allowLeave()).toBe(false);expect(await ref.current!.allowNavigate()).toBe(true);
  expect(invoke.mock.calls.filter(([command])=>command==="start_plugin_build")).toHaveLength(0);
  await user.click(screen.getByRole("button",{name:i18n.t("releasePlugin.reconcile")}));
  const consent=await screen.findByRole("checkbox",{name:i18n.t("releasePlugin.builderConsent")});
  expect(consent).not.toBeChecked();expect(screen.getByRole("button",{name:i18n.t("release.build")})).toBeDisabled();
  const captures=invoke.mock.calls.filter(([command])=>command==="prepare_plugin_build").map(([,args])=>args.request);
  expect(captures).toHaveLength(2);expect(captures[1]).toEqual(captures[0]);
  expect(captures[0]).toEqual({sessionToken:project.sessionToken,projectId:project.metadata.projectId,attemptId:fixtureIdentity(1),expectedEligibilityBasis:"basis",
    build:pluginBuildRequest,choices:[{locale:"zh-CN",outputPaths:["i18n/zh.json"],configuration:[]}]});
  expect(invoke.mock.calls.filter(([command])=>command==="create_execution_identity")).toHaveLength(1);
  await user.click(consent);await user.click(screen.getByRole("button",{name:i18n.t("release.build")}));
  await screen.findByText(i18n.t("release.started",{id:fixtureIdentity(1)}));
  expect(await ref.current!.allowLeave()).toBe(true);
  expect(invoke.mock.calls.filter(([command])=>command==="start_plugin_build")).toHaveLength(1);
});
