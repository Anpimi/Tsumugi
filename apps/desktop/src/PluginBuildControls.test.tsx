import { createRef } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReleaseWorkbench, type ReleaseHandle } from "./ReleaseWorkbench";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { pluginBuildInventory, pluginBuildPackage, pluginBuildView, pluginBuildWorkflow } from "./testSupport/pluginBuildFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import type { ProjectView } from "./projectCommands";
import type { AttemptDetail } from "./executionCommands";
import type { PluginBuildPrepareRequest, ArtifactCheckPrepareRequest, PluginStartRequest, ReleaseView } from "./releaseCommands";
import { i18n } from "./i18n";
import { validateResponseAttempt } from "./generated/execution.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session", locator: "/synthetic/project", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(700), displayName: "Build demo", sourceLocale: "en-US", targetLocales: ["zh-CN", "fr-FR"], metadataRevision: "1" } };
let serial: number, captured: PluginBuildPrepareRequest | null, build: AttemptDetail | null, releases: ReleaseView[];
let checks: Map<string, { request: ArtifactCheckPrepareRequest; detail: AttemptDetail }>;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
function detail(attemptId: string, locales: string[], operation: string): AttemptDetail {
  const items = locales.map((locale, index) => ({ scope: { kind: operation === "locale-build" ? "release-build" : "artifact-check", id: fixtureIdentity(707), locale }, resultId: fixtureIdentity(800 + index),
    status: { itemId: fixtureIdentity(810 + index), execution: "succeeded" as const, validation: "pending" as const, adoption: "unapplied" as const, cancellationRequested: false, retrySafe: false, diagnostic: null } }));
  return { attemptId, taskId: fixtureIdentity(820), operation, items, nextOffset: null,
    progress: { total: items.length, queued: 0, running: 0, succeeded: items.length, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
    recovery: { attemptId, units: [{ unitId: fixtureIdentity(830), itemIds: items.map(item => item.status.itemId), scopes: items.map(item => item.scope), resultIds: items.map(item => item.resultId), remainingItemIds: [], actions: ["adopt-result"], blockedReason: null, receiptId: null }] } };
}
function receipt(actionId: string) { return { ...executionFixture.receipt, actionId, attemptId: build!.attemptId, unitId: fixtureIdentity(830), projectId: project.metadata.projectId }; }
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  serial = 1; captured = null; build = null; releases = []; checks = new Map();
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const request = args?.request;
    switch (command) {
      case "read_plugin_inventory": return pluginBuildInventory;
      case "read_plugin_package": return pluginBuildPackage;
      case "read_plugin_build": return pluginBuildView;
      case "list_releases": return releases;
      case "list_deliveries": return [];
      case "create_execution_identity": return fixtureIdentity(serial++);
      case "read_content_scope": return {currentSnapshot:fixtureIdentity(707),revision:"1"};
      case "read_review_eligibility": return { basis: "basis", sourceSnapshotId: fixtureIdentity(707), ready: true, policyVersion: "balanced-1",
        locales: (request.locales as string[]).map(locale => ({ locale, ready: true, blockers: [], exceptions: [], checkedUnits: 2, blockerCount: 0, exceptionCount: 0 })) };
      case "prepare_plugin_build": {
        captured = request as unknown as PluginBuildPrepareRequest;
        return { ...pluginBuildWorkflow.review, attemptId: captured.attemptId, choices: captured.choices, build: pluginBuildView, inputDigest: "b".repeat(64), sourceSnapshotId: fixtureIdentity(707), eligibilityBasis: captured.expectedEligibilityBasis };
      }
      case "start_plugin_build": build = detail(String(request.attemptId), captured!.choices.map(choice => choice.locale), "locale-build"); return request.attemptId;
      case "read_execution_attempt": return request.attemptId === build?.attemptId ? structuredClone(build) : structuredClone(checks.get(String(request.attemptId))?.detail ?? null);
      case "prepare_artifact_check": {
        const check = request as unknown as ArtifactCheckPrepareRequest;
        const locale = build!.items.find(item => item.resultId === check.buildResultId)!.scope.locale!;
        checks.set(check.attemptId, { request: check, detail: detail(check.attemptId, [locale], "artifact-semantic-check") });
        return { ...pluginBuildWorkflow.checkReview, attemptId: check.attemptId, buildAttemptId: check.buildAttemptId, buildResultId: check.buildResultId, locale, build: pluginBuildView,
          inputDigest: (locale === "fr-FR" ? "d" : "c").repeat(64),
          artifacts: captured!.choices.find(choice => choice.locale === locale)!.outputPaths.map((logicalPath, index) => ({ id: `output-${index}`, role: "deliverable", logicalPath, byteLength: 12, sha256: "e".repeat(64) })) };
      }
      case "start_artifact_check": return request.attemptId;
      case "finish_artifact_check": {
        const check = checks.get(String(request.attemptId))!;
        const item = build!.items.find(item => item.resultId === check.request.buildResultId)!;
        item.status.validation = "valid"; return null;
      }
      case "prepare_execution_adoption": return { ...executionFixture.action, actionId: request.actionId, attemptId: request.attemptId, unitId: request.unitId, projectId: request.projectId, resultIds: request.resultIds, cancellationRevision: "0", operation: "locale-build", parameters: null };
      case "adopt_execution": {
        const saved = receipt(String(request.actionId));
        releases = [{ releaseId: fixtureIdentity(702), actionId: saved.actionId, attemptId: build!.attemptId, sourceSnapshotId: fixtureIdentity(707),
          policyVersion: "balanced-1", eligibilityBasis: "basis", manifestSha256: "a".repeat(64), builderVersion: "builder-1", validatorVersion: "checker-1", sourceFiles: [], exceptions: [], createdAt: "2026-10-06T00:00:00Z",
          artifacts: captured!.choices.flatMap(choice => choice.outputPaths.map(fileName => ({ locale: choice.locale, fileName, sha256: "e".repeat(64), entryCount: 2 }))) }];
        return saved;
      }
      case "read_project": return project;
      case "cancel_plugin_build_preparation": return false;
      case "cancel_execution_task": if (build) { build.items.forEach(item => { item.status.cancellationRequested = true; }); } return "1";
      case "read_execution_cancellation_action": return null;
      default: throw new Error(command);
    }
  });
});
afterEach(() => { cleanup(); if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll); else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"); });

it("orders installed builder discovery, refresh and re-entry around the exclusive Store", async () => {
  const original = invoke.getMockImplementation()!;
  const second = { ...pluginBuildPackage, packageDigest: "d".repeat(64),
    manifest: { ...pluginBuildPackage.manifest, plugin: { ...pluginBuildPackage.manifest.plugin, id: "synthetic-builder" } } };
  const packages = [pluginBuildPackage, second];
  const inventory = { ...pluginBuildInventory,
    packages: packages.map(item => ({ ...pluginBuildInventory.packages[0], plugin: item.manifest.plugin, packageDigest: item.packageDigest })),
    packageDecisions: packages.map(item => ({ ...pluginBuildInventory.packageDecisions[0], plugin: item.manifest.plugin, packageDigest: item.packageDigest })) };
  let active = false, inventories = 0, environments = 0, reads = 0;
  let releaseEnvironment!: () => void, releaseRefresh!: () => void, releaseReopen!: () => void;
  const firstEnvironment = new Promise<void>(resolve => { releaseEnvironment = resolve; });
  const refreshRead = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const reopenRead = new Promise<void>(resolve => { releaseReopen = resolve; });
  invoke.mockImplementation(async (command, args) => {
    if (!["read_plugin_inventory", "read_plugin_package", "read_plugin_build"].includes(command)) return original(command, args);
    if (active) throw { code: "busy", stage: "read", outcome: "rejected", recoveryRequired: false, reason: "plugin-store-busy" };
    active = true;
    try {
      if (command === "read_plugin_inventory") {
        if (++inventories === 2) await refreshRead;
        if (inventories === 3) await reopenRead;
        return inventory;
      }
      if (command === "read_plugin_package") { reads++; return packages.find(item => item.packageDigest === args.request.packageDigest); }
      if (++environments === 1) await firstEnvironment;
      return pluginBuildView;
    } finally { active = false; }
  });
  render(<ReleaseWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await waitFor(() => expect(environments).toBe(1));
  expect(reads).toBe(2);
  expect(screen.getByRole("button", { name: i18n.t("releasePlugin.refresh") })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: i18n.t("releasePlugin.builder") })).toBeDisabled();
  await act(async () => { releaseEnvironment(); });
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("releasePlugin.refresh") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.refresh") }));
  await waitFor(() => expect(inventories).toBe(2));
  expect(environments).toBe(1);
  await act(async () => { releaseRefresh(); });
  await waitFor(() => expect(environments).toBe(2));
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await waitFor(() => expect(inventories).toBe(3));
  expect(environments).toBe(2);
  await act(async () => { releaseReopen(); });
  await waitFor(() => expect(environments).toBe(3));
  expect(reads).toBe(6);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

async function ready(locales = ["zh-CN"], twoFiles = true, waitForCapture = true) {
  const user = userEvent.setup(), ref = createRef<ReleaseHandle>();
  const view = render(<ReleaseWorkbench ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await screen.findByText(/Example text artifact/);
  for (const locale of locales) {
    await user.click(screen.getByRole("checkbox", { name: locale }));
    const input = screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale }) });
    expect(input).toHaveValue("");
    await user.type(input, `deliverables/${locale}/captions.txt${twoFiles ? `\ndeliverables/${locale}/metadata.txt` : ""}`);
  }
  await user.click(screen.getByRole("button", { name: i18n.t("release.check") }));
  await screen.findByText(i18n.t("release.ready", { count: 0 }));
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.capture") }));
  if (waitForCapture) await screen.findByText(i18n.t("releasePlugin.fixedBuild"));
  return { user, ref, view };
}
async function start(user: ReturnType<typeof userEvent.setup>) {
  expect(screen.getByRole("button", { name: i18n.t("release.build") })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: i18n.t("releasePlugin.builderConsent") }));
  await user.click(screen.getByRole("button", { name: i18n.t("release.build") }));
}
async function check(user: ReturnType<typeof userEvent.setup>, locale: string) {
  await user.click(await screen.findByRole("button", { name: i18n.t("releasePlugin.prepareCheck", { locale }) }));
  const consent = await screen.findByRole("checkbox", { name: i18n.t("releasePlugin.checkerConsent") });
  expect(consent).not.toBeChecked();
  expect(screen.getByRole("button", { name: i18n.t("releasePlugin.startCheck") })).toBeDisabled();
  await user.click(consent);
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.startCheck") }));
  await user.click(await screen.findByRole("button", { name: i18n.t("releasePlugin.recordCheck") }));
}

it.each(["en-US", "zh-CN"])("shows the original captured runtime without unavailable guidance during preparation in %s", async language => {
  await i18n.changeLanguage(language);
  const original = invoke.getMockImplementation()!;
  let releasePreparation!: () => void;
  const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
  invoke.mockImplementation(async (command, args) => {
    if (command === "prepare_plugin_build") await preparation;
    return original(command, args);
  });
  await ready(["zh-CN"], false, false);
  await screen.findByText(i18n.t("execution.working"));
  expect(screen.queryByText(i18n.t("releasePlugin.unavailable"))).not.toBeInTheDocument();
  await act(async () => { releasePreparation(); });
  await screen.findByText(i18n.t("releasePlugin.fixedBuild"));
  const runtime = screen.getAllByRole("combobox")
    .filter((node): node is HTMLSelectElement => node instanceof HTMLSelectElement)
    .find(node => node.value === pluginBuildView.environmentDigest);
  expect(runtime).toBeDisabled();
  expect(runtime?.selectedOptions[0].textContent).toBe("Node 26.10.0 · macos aarch64");
  expect(runtime).toHaveAccessibleName(i18n.t("releasePlugin.capturedRuntime"));
  expect(screen.getByRole("combobox", { name: i18n.t("releasePlugin.capturedBuilder") })).toBeDisabled();
});

it.each(["en-US", "zh-CN"])("keeps captured runtime labels after editable discovery is invalidated in %s", async language => {
  await i18n.changeLanguage(language);
  await ready(["zh-CN"], false);
  await refreshWorkbenchReads(["execution"]);
  const runtime = screen.getAllByRole("combobox")
    .filter((node): node is HTMLSelectElement => node instanceof HTMLSelectElement)
    .find(node => node.value === pluginBuildView.environmentDigest);
  expect(runtime).toBeDisabled();
  expect(runtime?.selectedOptions[0].textContent).toBe("Node 26.10.0 · macos aarch64");
  expect(screen.queryByText(i18n.t("releasePlugin.unavailable"))).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_build")).toBe(false);
});

it("keeps failed installed choice reads distinct from missing packages", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    if (command === "read_plugin_inventory") throw { code: "busy", stage: "read", outcome: "rejected", recoveryRequired: false, reason: "plugin-store-busy" };
    return original(command, args);
  });
  render(<ReleaseWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await screen.findByRole("alert");
  expect(screen.queryByText(i18n.t("releasePlugin.unavailable"))).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: i18n.t("releasePlugin.refresh") })).toBeEnabled();
  expect(invoke.mock.calls.some(([command]) => command === "prepare_plugin_build" || command === "start_plugin_build")).toBe(false);
});

it("opens the independent artifact checker for the Core source-snapshot build scope", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    const value = await original(command, args);
    if (command === "read_execution_attempt" && value?.operation === "locale-build") {
      // ReleasePlan::fixed_input binds every locale to the captured source snapshot.
      value.items.forEach((item: AttemptDetail["items"][number]) => {
        item.scope = { kind: "release-build", id: fixtureIdentity(707), locale: item.scope.locale };
      });
    }
    return value;
  });
  const { user } = await ready(["zh-CN"], false);
  await start(user);
  await check(user, "zh-CN");
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_artifact_check")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "start_artifact_check")).toHaveLength(1);
  await screen.findByRole("button", { name: i18n.t("releasePlugin.recordRelease") });
});

it.each([
  { kind: "locale", id: "zh-CN", locale: "zh-CN" },
  { kind: "release-build", id: fixtureIdentity(708), locale: "zh-CN" },
  { kind: "release-build", id: fixtureIdentity(707), locale: "de-DE" },
])("rejects checking and release recording for a foreign build scope: %j", async scope => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    const value = await original(command, args);
    if (command === "read_execution_attempt" && value?.operation === "locale-build") {
      value.items[0].scope = scope;
      value.items[0].status.validation = "valid";
    }
    return value;
  });
  const { user } = await ready(["zh-CN"], false);
  await start(user);
  await waitFor(() => expect(build).not.toBeNull());
  await screen.findByText(i18n.t("release.started", { id: build!.attemptId }));
  expect(screen.queryByRole("button", { name: i18n.t("releasePlugin.prepareCheck", { locale: scope.locale }) })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("releasePlugin.recordRelease") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command === "prepare_artifact_check" || command === "prepare_execution_adoption")).toBe(false);
});

it("keeps the original captured build usable without reopening live Store discovery", async () => {
  const original = invoke.getMockImplementation()!;
  let laterDiscovery = 0;
  invoke.mockImplementation(async (command, args) => {
    if (captured && ["read_plugin_inventory", "read_plugin_package", "read_plugin_build"].includes(command)) {
      laterDiscovery++;
      throw { code: "busy", stage: "read", outcome: "rejected", recoveryRequired: false, reason: "plugin-store-busy" };
    }
    return original(command, args);
  });
  const { user } = await ready(["zh-CN"], false);
  const request = structuredClone(captured);
  await refreshWorkbenchReads(["execution"]);
  expect(laterDiscovery).toBe(0);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await start(user);
  await screen.findByRole("button", { name: i18n.t("releasePlugin.prepareCheck", { locale: "zh-CN" }) });
  expect(captured).toEqual(request);
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_plugin_build")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_build")).toHaveLength(1);
  expect(laterDiscovery).toBe(0);
});

it("rereads current installed choices after explicitly discarding a captured preparation", async () => {
  const original = invoke.getMockImplementation()!;
  let inventoryReads = 0;
  invoke.mockImplementation(async (command, args) => {
    if (command === "read_plugin_inventory") inventoryReads++;
    if (command === "cancel_plugin_build_preparation") captured = null;
    return original(command, args);
  });
  const { user } = await ready(["zh-CN"], false);
  const before = inventoryReads;
  expect(before).toBeGreaterThan(0);
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_build")).toBe(false);
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.discard") }));
  await waitFor(() => expect(inventoryReads).toBeGreaterThan(before));
  await waitFor(() => expect(screen.getByRole("combobox", { name: i18n.t("releasePlugin.builder") })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) })).toHaveValue("deliverables/zh-CN/captions.txt");
  expect(screen.queryByText(i18n.t("releasePlugin.fixedBuild"))).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "cancel_plugin_build_preparation")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_build")).toBe(false);
});

it.each(["en-US", "zh-CN"])("records all languages and multiple exact paths only after separate grants and proofs in %s", async locale => {
  await i18n.changeLanguage(locale);
  const { user } = await ready(["zh-CN", "fr-FR"]);
  expect(captured!.choices[0].outputPaths).toEqual(["deliverables/zh-CN/captions.txt", "deliverables/zh-CN/metadata.txt"]);
  expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_build")).toHaveLength(0);
  await start(user);
  await check(user, "zh-CN");
  await waitFor(() => expect(screen.queryByRole("button", { name: i18n.t("releasePlugin.recordRelease") })).not.toBeInTheDocument());
  await check(user, "fr-FR");
  await user.click(await screen.findByRole("button", { name: i18n.t("releasePlugin.recordRelease") }));
  await screen.findByText(i18n.t("releasePlugin.recorded"));
  expect(screen.getByRole("button", { name: i18n.t("release.chooseFolder") })).toBeEnabled();
  expect(screen.getByText(/zh-CN → deliverables\/zh-CN\/metadata/)).toBeInTheDocument();
  expect(screen.getByText(/fr-FR → deliverables\/fr-FR\/captions/)).toBeInTheDocument();
  const grants = invoke.mock.calls.filter(([command]) => command === "start_plugin_build" || command === "start_artifact_check").map(([, args]) => args.request as PluginStartRequest);
  expect(new Set(grants.map(grant => grant.grantId)).size).toBe(3);
  expect(grants.map(grant => grant.inputDigest)).toEqual(["b".repeat(64), "c".repeat(64), "d".repeat(64)]);
  expect(grants.every(grant => grant.unsandboxedExecution && BigInt(grant.expiresAtMs) > BigInt(Date.now()))).toBe(true);
  expect(invoke.mock.calls.some(([command]) => command === "start_locale_build" || command === "read_source_integration")).toBe(false);
});

it("reconciles an unrelated build acknowledgement using the same attempt, grant and expiry", async () => {
  const { user, ref, view } = await ready();
  const original = invoke.getMockImplementation()!;
  let starts = 0, reads = 0;
  invoke.mockImplementation(async (command, args) => { if (command === "read_plugin_execution_start") { if (++reads === 1) throw new Error("Original read unavailable"); return null; } const value = await original(command, args); return command === "start_plugin_build" && ++starts === 1 ? fixtureIdentity(999) : value; });
  await start(user);
  await screen.findByText(i18n.t("releasePlugin.unknown"));
  expect(await ref.current!.allowLeave()).toBe(false);
  expect(await ref.current!.allowNavigate()).toBe(true);
  view.rerender(null,project);view.rerender(<ReleaseWorkbench ref={ref} project={project} disabled={false}/>);
  await screen.findByText(i18n.t("releasePlugin.unknown"));
  await user.click(screen.getByRole("button", { name: i18n.t("execution.checkPluginStart") }));
  expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_build")).toHaveLength(1);
  await user.click(await screen.findByRole("button", { name: i18n.t("execution.retryPluginStart") }));
  await screen.findByRole("button", { name: i18n.t("releasePlugin.prepareCheck", { locale: "zh-CN" }) });
  const calls = invoke.mock.calls.filter(([command]) => command === "start_plugin_build");
  expect(calls).toHaveLength(2); expect(calls[0][1]).toEqual(calls[1][1]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(2);
});

it("reconciles a lost proof acknowledgement without another checker grant or partial release", async () => {
  const { user } = await ready(); await start(user);
  const original = invoke.getMockImplementation()!;
  let finishes = 0;
  invoke.mockImplementation(async (command, args) => { const value = await original(command, args); if (command === "finish_artifact_check" && ++finishes === 1) throw { code: "outcome-unknown" }; return value; });
  await check(user, "zh-CN");
  await screen.findByText(i18n.t("releasePlugin.unknown"));
  const record = screen.queryByRole("button", { name: i18n.t("releasePlugin.recordRelease") });
  if (record) expect(record).toBeDisabled();
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.reconcile") }));
  await screen.findByRole("button", { name: i18n.t("releasePlugin.recordRelease") });
  const calls = invoke.mock.calls.filter(([command]) => command === "finish_artifact_check");
  expect(calls).toHaveLength(2); expect(calls[1][1]).toEqual(calls[0][1]);
  expect(invoke.mock.calls.filter(([command]) => command === "start_artifact_check")).toHaveLength(1);
});

it("reads the original receipt after a lost adoption response before allowing any retry", async () => {
  const { user, ref } = await ready(); await start(user); await check(user, "zh-CN");
  const original = invoke.getMockImplementation()!;
  let saved: ReturnType<typeof receipt> | null = null;
  invoke.mockImplementation(async (command, args) => {
    if (command === "read_execution_receipt") return saved;
    const value = await original(command, args);
    if (command === "adopt_execution") { saved = value; throw { code: "outcome-unknown" }; }
    return value;
  });
  await user.click(await screen.findByRole("button", { name: i18n.t("releasePlugin.recordRelease") }));
  await screen.findByText(i18n.t("releasePlugin.unknown"));
  expect(await ref.current!.allowLeave()).toBe(false);
  expect(screen.queryByRole("button", { name: i18n.t("execution.retryAdoption") })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.reconcile") }));
  await screen.findByText(i18n.t("releasePlugin.recorded"));
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
  expect(invoke.mock.calls.find(([command]) => command === "read_execution_receipt")![1].request.actionId).toBe(saved!.actionId);
  expect(await ref.current!.allowLeave()).toBe(true);
});

it("keeps failed mandatory checks from recording a release and preserves the output paths", async () => {
  const { user } = await ready(); await start(user);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => { if (command === "finish_artifact_check") throw { ...executionFixture.error, code: "output-invalid", reason: "artifact-rule-failed", stage: "execution-adopt", outcome: "rejected" }; return original(command, args); });
  await check(user, "zh-CN");
  expect((await screen.findByRole("alert"))).toHaveFocus();
  expect(screen.getAllByText("deliverables/zh-CN/captions.txt").length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: i18n.t("releasePlugin.recordRelease") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(0);
});

it("protects an unfinished mapping on project leave while navigation retains it", async () => {
  const { user, ref } = await ready();
  expect(await ref.current!.allowNavigate()).toBe(true);
  await user.click(screen.getByRole("button", { name: i18n.t("workbench.backOverview") }));
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  expect(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) })).toHaveValue("deliverables/zh-CN/captions.txt\ndeliverables/zh-CN/metadata.txt");
  let leaving!: Promise<boolean>;
  const trigger = screen.getByRole("button", { name: i18n.t("workbench.backOverview") });
  trigger.focus();
  await act(async () => { leaving = ref.current!.allowLeave(); });
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("button", { name: i18n.t("source.keep") })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(await leaving).toBe(false);
  await waitFor(() => expect(trigger).toHaveFocus());
  await act(async () => { leaving = ref.current!.allowLeave(); });
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: i18n.t("source.keep") }));
  expect(await leaving).toBe(false);
  await waitFor(() => expect(trigger).toHaveFocus());
  await act(async () => { leaving = ref.current!.allowLeave(); });
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: i18n.t("source.leave") }));
  expect(await leaving).toBe(true);
  expect(invoke.mock.calls.filter(([command]) => command === "cancel_plugin_build_preparation")).toHaveLength(1);
  expect(screen.queryByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) })).not.toBeInTheDocument();
});

it("refuses saved-build inspection while an original mapping is dirty and accepts only after explicit discard", async () => {
  const user = userEvent.setup(), ref = createRef<ReleaseHandle>();
  render(<ReleaseWorkbench ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await screen.findByText(/Example text artifact/);
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  const path = screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) });
  await user.type(path, "deliverables/retained.txt");
  await user.click(screen.getByRole("button", { name: i18n.t("workbench.backOverview") }));
  await act(async () => { expect(ref.current!.showSavedBuild(pluginBuildWorkflow.review.attemptId)).toBe(false); });
  expect(screen.queryByRole("heading", { name: i18n.t("release.title") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command === "read_saved_plugin_build")).toBe(false);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  expect(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) })).toHaveValue("deliverables/retained.txt");
  let leaving!: Promise<boolean>;
  await act(async () => { leaving = ref.current!.allowLeave(); });
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: i18n.t("source.leave") }));
  expect(await leaving).toBe(true);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "read_saved_plugin_build" ? Promise.reject({ code: "storage-failed" }) : original(command, args));
  await act(async () => { expect(ref.current!.showSavedBuild(pluginBuildWorkflow.review.attemptId)).toBe(true); });
  await screen.findByText(i18n.t("releasePlugin.savedReadFailed"));
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.savedBack") }));
  expect(screen.getByRole("checkbox", { name: "zh-CN" })).not.toBeChecked();
  expect(screen.queryByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "cancel_plugin_build_preparation")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "prepare_plugin_build" || command === "start_plugin_build" || command === "create_execution_identity")).toBe(false);
});

it.each(["prepared", "consented", "busy", "unknown"] as const)("preserves the original %s build owner when saved inspection is requested", async phase => {
  const { user, ref } = await ready();
  const request = structuredClone(captured);
  let resolveStart!: (attemptId: string) => void;
  const deferred = new Promise<string>(resolve => { resolveStart = resolve; });
  if (phase !== "prepared") await user.click(screen.getByRole("checkbox", { name: i18n.t("releasePlugin.builderConsent") }));
  if (phase === "busy" || phase === "unknown") {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === "start_plugin_build"
      ? phase === "busy" ? deferred : Promise.reject({ code: "outcome-unknown" }) : original(command, args));
    await user.click(screen.getByRole("button", { name: i18n.t("release.build") }));
    await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "start_plugin_build")).toBe(true));
    if (phase === "unknown") await screen.findByRole("button", { name: i18n.t("execution.checkPluginStart") });
  }
  await act(async () => { expect(ref.current!.showSavedBuild(fixtureIdentity(890))).toBe(false); });
  expect(captured).toEqual(request);
  expect(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) })).toHaveValue("deliverables/zh-CN/captions.txt\ndeliverables/zh-CN/metadata.txt");
  expect(screen.getByRole("checkbox", { name: i18n.t("releasePlugin.builderConsent") })).toHaveProperty("checked", phase !== "prepared");
  expect(screen.queryByRole("region", { name: i18n.t("releasePlugin.savedView") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command === "read_saved_plugin_build")).toBe(false);
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_plugin_build")).toHaveLength(1);
  if (phase === "busy") await act(async () => { resolveStart(request!.attemptId); await deferred; });
  if (phase === "unknown") expect(await ref.current!.allowLeave()).toBe(false);
});

it("refuses an unrelated runtime acknowledgement and retains the entered mapping", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => command === "read_plugin_build" ? { ...pluginBuildView, environmentDigest: "f".repeat(64) } : original(command, args));
  const user = userEvent.setup(); render(<ReleaseWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  expect(await screen.findByRole("alert")).toHaveFocus();
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  await user.type(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) }), "delivery/output.txt");
  expect(screen.getByRole("button", { name: i18n.t("release.check") })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_build")).toBe(false);
});

it("reads all build pages before offering a complete release", async () => {
  const { user } = await ready(["zh-CN", "fr-FR"]);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    const value = await original(command, args);
    if (command === "read_execution_attempt" && value?.operation === "locale-build") return { ...value, items: [value.items[args.request.offset]], nextOffset: args.request.offset === 0 ? 1 : null };
    return value;
  });
  await start(user);
  await screen.findByRole("button", { name: i18n.t("releasePlugin.prepareCheck", { locale: "fr-FR" }) });
  expect(invoke.mock.calls.some(([command, args]) => command === "read_execution_attempt" && args.request.offset === 1)).toBe(true);
  expect(screen.queryByRole("button", { name: i18n.t("releasePlugin.recordRelease") })).not.toBeInTheDocument();
});

it("requires a successful absent-receipt read before retrying the same release action", async () => {
  const { user } = await ready(); await start(user); await check(user, "zh-CN");
  const original = invoke.getMockImplementation()!;
  let adoptions = 0, reads = 0;
  invoke.mockImplementation(async (command, args) => {
    if (command === "adopt_execution" && ++adoptions === 1) throw { code: "outcome-unknown" };
    if (command === "read_execution_receipt") { if (++reads === 1) throw { code: "storage-failed" }; return null; }
    return original(command, args);
  });
  await user.click(await screen.findByRole("button", { name: i18n.t("releasePlugin.recordRelease") }));
  await user.click(await screen.findByRole("button", { name: i18n.t("releasePlugin.reconcile") }));
  expect(screen.queryByRole("button", { name: i18n.t("execution.retryAdoption") })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.reconcile") }));
  await user.click(await screen.findByRole("button", { name: i18n.t("execution.retryAdoption") }));
  await screen.findByText(i18n.t("releasePlugin.recorded"));
  const calls = invoke.mock.calls.filter(([command]) => command === "adopt_execution");
  expect(calls).toHaveLength(2); expect(calls[0][1]).toEqual(calls[1][1]);
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_execution_adoption")).toHaveLength(1);
  expect(invoke.mock.calls.find(([command]) => command === "prepare_execution_adoption")![1].request).toEqual({
    projectId: project.metadata.projectId, sessionToken: project.sessionToken, attemptId: captured!.attemptId,
    unitId: fixtureIdentity(830), resultIds: [fixtureIdentity(800)], actionId: calls[0][1].request.actionId,
  });
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(5);
});

it("ignores an environment response from the previous project session", async () => {
  const original = invoke.getMockImplementation()!;
  let resolveOld!: (view: typeof pluginBuildView) => void, environmentReads = 0;
  invoke.mockImplementation((command, args) => command === "read_plugin_build" && ++environmentReads === 1
    ? new Promise(resolve => { resolveOld = resolve; }) : original(command, args));
  const user = userEvent.setup();
  const view = render(<ReleaseWorkbench key="old-session" project={{ ...project, sessionToken: "old-session" }} disabled={false} />);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await waitFor(() => expect(resolveOld).toBeDefined());
  view.rerender(<ReleaseWorkbench key="new-session" project={{ ...project, sessionToken: "new-session" }} disabled={false} />);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await screen.findByText(/Example text artifact/);
  await act(async () => resolveOld({ ...pluginBuildView, declaration: { ...pluginBuildView.declaration, displayName: "Old project builder" } }));
  expect(screen.queryByText(/Old project builder/)).not.toBeInTheDocument();
  expect(screen.getByText(/Example text artifact/)).toBeInTheDocument();
});

it("cancels a queued task with the original cancellation request after a lost response", async () => {
  const { user } = await ready();
  const original = invoke.getMockImplementation()!;
  let cancellations = 0,lookups = 0;
  invoke.mockImplementation(async (command, args) => {
    if(command==="read_execution_cancellation_action"){
      if(++lookups===1)throw new Error("Automatic check unavailable");return null;
    }
    const value = await original(command, args);
    if (command === "start_plugin_build") {
      build!.items.forEach(item => { item.status.execution = "queued"; item.resultId = null; });
      Object.assign(build!.progress, { queued: build!.items.length, succeeded: 0 });
    }
    if (command === "cancel_execution_task") {
      build!.items.forEach(item => { item.status.execution = "cancelled-before-dispatch"; });
      Object.assign(build!.progress, { queued: 0, cancelled: build!.items.length });
      if (++cancellations === 1) throw { code: "outcome-unknown" };
    }
    return value;
  });
  await start(user);
  await user.click(await screen.findByRole("button", { name: i18n.t("execution.cancel") }));
  await screen.findByText(i18n.t("execution.cancelUnknown"));
  expect(screen.queryByRole("button",{name:i18n.t("execution.retryCancellation")})).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:i18n.t("execution.checkCancellation")}));
  await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("execution.retryCancellation")})).toBeEnabled());
  await user.click(screen.getByRole("button", { name: i18n.t("execution.retryCancellation") }));
  await screen.findByText(i18n.t("releasePlugin.cancelled"));
  const calls = invoke.mock.calls.filter(([command]) => command === "cancel_execution_task");
  expect(calls).toHaveLength(2); expect(calls[0][1]).toEqual(calls[1][1]);
  expect(screen.queryByRole("button", { name: i18n.t("releasePlugin.recordRelease") })).not.toBeInTheDocument();
  expect(await screen.findByRole("button", { name: i18n.t("releasePlugin.newBuild") })).toBeEnabled();
});


it("prepares a Native builder with Host presentation and independent unchecked consent", async () => {
  const { nativeInventory, nativePackage, nativeEnvironment, nativeDigest, nativeOrigin } = await import("./testSupport/pluginNativeFixture");
  const base = invoke.getMockImplementation()!;
  const nativeView = { ...pluginBuildView, environment: nativeEnvironment, environmentDigest: nativeDigest, runtimeOrigin: nativeOrigin };
  invoke.mockImplementation(async (command, args) => {
    if (command === "read_plugin_inventory") return nativeInventory(pluginBuildInventory);
    if (command === "read_plugin_package") return nativePackage(pluginBuildPackage);
    if (command === "read_plugin_build") return nativeView;
    const value = await base(command, args);
    return command === "prepare_plugin_build" ? { ...value, build: nativeView } : value;
  });
  await ready(["zh-CN"], false);
  expect(captured!.build.environmentDigest).toBe(nativeDigest);
  expect(screen.getByRole("combobox", { name: i18n.t("releasePlugin.capturedRuntime") })).toHaveValue(nativeDigest);
  expect(screen.queryByRole("option", { name: /^Node / })).not.toBeInTheDocument();
  expect(screen.getByText(i18n.t("sourcePlugin.nativeRuntimeDetails", { version: nativeEnvironment.hostVersion, system: "macos", architecture: "aarch64" }))).toBeVisible();
  expect(screen.getByRole("checkbox", { name: i18n.t("releasePlugin.builderConsent") })).not.toBeChecked();
  expect(screen.getByRole("button", { name: i18n.t("release.build") })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_build")).toBe(false);
});

it("keeps Native build preparation unavailable when only Node is approved", async () => {
  const { nativeInventory, nativePackage } = await import("./testSupport/pluginNativeFixture");
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    if (command === "read_plugin_inventory") return nativeInventory(pluginBuildInventory, false);
    if (command === "read_plugin_package") return nativePackage(pluginBuildPackage);
    return base(command, args);
  });
  const user = userEvent.setup();
  render(<ReleaseWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await screen.findByText(i18n.t("releasePlugin.unavailable"));
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  await user.type(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) }), "deliverables/zh-CN/messages.json");
  expect(screen.getByRole("button", { name: i18n.t("release.check") })).toBeDisabled();
  expect(screen.getByRole("button", { name: i18n.t("releasePlugin.capture") })).toBeDisabled();
  expect(screen.queryByRole("option", { name: /^Node / })).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command === "read_plugin_build" || command === "prepare_plugin_build" || command === "start_plugin_build")).toBe(false);
});


it("serializes a shared semantic inventory refresh before rereading its exact builder and retains the entered mapping",async()=>{
  const original=invoke.getMockImplementation()!;let active=false,inventories=0,environments=0,releaseInventory!:()=>void;
  const refresh=new Promise<void>(resolve=>{releaseInventory=resolve;});
  invoke.mockImplementation(async(command,args)=>{
    if(!["read_plugin_inventory","read_plugin_package","read_plugin_build"].includes(command))return original(command,args);
    if(active)throw {code:"busy",stage:"read",outcome:"rejected",recoveryRequired:false};
    active=true;
    try { if(command==="read_plugin_inventory"&&++inventories===2)await refresh;if(command==="read_plugin_build")environments++;return await original(command,args); }
    finally {active=false;}
  });
  const user=userEvent.setup();render(<ReleaseWorkbench project={project} disabled={false}/>);
  await user.click(screen.getByRole("button",{name:i18n.t("release.title")}));
  await screen.findByText(/Example text artifact/);await user.click(screen.getByRole("checkbox",{name:"zh-CN"}));
  await user.type(screen.getByRole("textbox",{name:i18n.t("releasePlugin.paths",{locale:"zh-CN"})}),"outputs/retained.txt");
  const refreshed=refreshWorkbenchReads(["execution"]);
  await waitFor(()=>expect(inventories).toBe(2));expect(environments).toBe(1);
  expect(screen.getByRole("button",{name:i18n.t("release.check")})).toBeDisabled();
  await act(async()=>{releaseInventory();await refresh;});await refreshed;
  await waitFor(()=>expect(environments).toBe(2));
  await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("release.check")})).toBeEnabled());
  expect(screen.getByRole("textbox",{name:i18n.t("releasePlugin.paths",{locale:"zh-CN"})})).toHaveValue("outputs/retained.txt");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command])=>command==="prepare_plugin_build"||command==="start_plugin_build"||command==="create_execution_identity")).toBe(false);
});

it("retains independently captured checker consent and its proof request through complete consumer unmount",async()=>{
  const {user,view}=await ready();await start(user);
  await user.click(await screen.findByRole("button",{name:i18n.t("releasePlugin.prepareCheck",{locale:"zh-CN"})}));
  const consent=await screen.findByRole("checkbox",{name:i18n.t("releasePlugin.checkerConsent")});
  expect(consent).not.toBeChecked();await user.click(consent);
  const capturedCheck=invoke.mock.calls.find(([command])=>command==="prepare_artifact_check")![1].request;
  view.rerender(null,project);view.rerender(<ReleaseWorkbench project={project} disabled={false}/>);
  expect(await screen.findByRole("checkbox",{name:i18n.t("releasePlugin.checkerConsent")})).toBeChecked();
  await user.click(screen.getByRole("button",{name:i18n.t("releasePlugin.startCheck")}));
  const record=await screen.findByRole("button",{name:i18n.t("releasePlugin.recordCheck")});
  const original=invoke.getMockImplementation()!;let resolveProof!:(value:null)=>void;
  const pending=new Promise<null>(resolve=>{resolveProof=resolve;});
  invoke.mockImplementation(async(command,args)=>{const result=await original(command,args);return command==="finish_artifact_check"?pending:result;});
  await user.click(record);await waitFor(()=>expect(invoke.mock.calls.filter(([command])=>command==="finish_artifact_check")).toHaveLength(1));
  const proof=invoke.mock.calls.find(([command])=>command==="finish_artifact_check")![1].request;
  view.rerender(null,project);await act(async()=>{resolveProof(null);await pending;});
  view.rerender(<ReleaseWorkbench project={project} disabled={false}/>);
  await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("releasePlugin.recordRelease")})).toBeEnabled());
  expect(screen.queryByRole("checkbox",{name:i18n.t("releasePlugin.checkerConsent")})).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command])=>command==="prepare_artifact_check").map(([,args])=>args.request)).toEqual([capturedCheck]);
  expect(invoke.mock.calls.filter(([command])=>command==="start_artifact_check")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command])=>command==="finish_artifact_check").map(([,args])=>args.request)).toEqual([proof]);
  expect(proof.attemptId).toBe(capturedCheck.attemptId);
  expect(invoke.mock.calls.filter(([command])=>command==="adopt_execution")).toHaveLength(0);
});

it.each([null, "ja-JP"] as const)("does not offer an artifact check for a result outside the original build locale: %s", async locale => {
  const { user } = await ready();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    const response: unknown = await original(command, args);
    if (command === "read_execution_attempt" && build?.attemptId === args.request.attemptId) {
      if (!validateResponseAttempt(response)) throw new Error("Invalid complete build attempt fixture");
      return { ...response, items: response.items.map(item => ({ ...item, scope: { ...item.scope, locale } })) };
    }
    return response;
  });
  await start(user);
  const results = await screen.findByRole("region", { name: i18n.t("releasePlugin.results") });
  await waitFor(() => expect(results).toHaveTextContent(i18n.t("releasePlugin.validation.pending")));
  expect(within(results).getAllByRole("button")).toEqual([within(results).getByRole("button", { name: i18n.t("execution.refresh") })]);
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_artifact_check")).toHaveLength(0);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(2);
});

it("opens Extensions for an unavailable builder without clearing the entered build mapping or starting work", async () => {
  const user = userEvent.setup(), onOpenExtensions = vi.fn(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => command === "read_plugin_inventory"
    ? { ...pluginBuildInventory, packages: [], packageDecisions: [] } : original(command, args));
  render(<ReleaseWorkbench project={project} disabled={false} onOpenExtensions={onOpenExtensions} />);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await screen.findByText(i18n.t("releasePlugin.unavailable"));
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  const paths = screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) });
  await user.type(paths, "outputs/retained.txt");
  await user.click(screen.getByRole("button", { name: i18n.t("plugins.open") }));
  expect(onOpenExtensions).toHaveBeenCalledOnce(); expect(paths).toHaveValue("outputs/retained.txt");
  expect(invoke.mock.calls.some(([command]) => ["create_execution_identity", "prepare_plugin_build", "start_plugin_build", "prepare_artifact_check", "adopt_execution"].includes(command))).toBe(false);
});

it.each(["en-US", "zh-CN"])("reports the approved exception count when a build is ready in %s", async locale => {
  await i18n.changeLanguage(locale);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    const reply = await original(command, args);
    return command === "read_review_eligibility" ? { ...reply, locales: reply.locales.map((item: { locale: string }) => ({
      ...item, exceptionCount: 1, exceptions: [{ unitId: fixtureIdentity(901), nativeKey: "retained.original", code: "source-fallback", reference: null }],
    })) } : reply;
  });
  render(<ReleaseWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("releasePlugin.refresh") })).toBeEnabled());
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  await user.type(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) }), "deliverables/zh-CN/captions.txt");
  await user.click(screen.getByRole("button", { name: i18n.t("release.check") }));
  expect(await screen.findByText(i18n.t("release.ready", { count: 1 }))).toBeVisible();
  expect(screen.getByRole("button", { name: i18n.t("releasePlugin.capture") })).toBeEnabled();
  expect(invoke.mock.calls.some(([command]) => command === "prepare_plugin_build")).toBe(false);
});
