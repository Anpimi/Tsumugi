import { useLayoutEffect, useState } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Delivery from "./app-v2/features/delivery/DeliveryView";
import { InteractionGate } from "./app-v2/workspace/interactionGate";
import { useReleaseDraftSession } from "./ReleaseDraftSession";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { useWorkbenchCommands } from "./workbenchCommands";
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
      case "read_review_eligibility": return { basis: "basis", sourceSnapshotId: fixtureIdentity(707), epoch: fixtureIdentity(1), sequence: "1", ready: true, policyVersion: "balanced-1",
        locales: (request.locales as string[]).map(locale => ({ locale, ready: true, blockers: [], exceptions: [], checkedUnits: 2, selectedUnits: 2, blockingUnits: 0, blockerCount: 0, exceptionCount: 0 })) };
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

function DeliveryConsumer() {
  const owner = useReleaseDraftSession(), tasks = useExecutionTaskSession(), commands = useWorkbenchCommands();
  const [gate] = useState(() => { const gate = new InteractionGate(); gate.setVisibleOwner("build-contract"); return gate; });
  useLayoutEffect(() => () => gate.dispose(), [gate]);
  return <Delivery project={project} owner={owner} tasks={tasks} commands={commands} gate={gate} viewId="build-contract" visible disabled={false}
    onOpenDecisions={() => {}} onOpenKnowledge={() => {}} onOpenExtensions={() => {}}/>;
}
function primary() {
  const header = screen.getByRole("heading", { name: i18n.t("deliveryWorkbench.title"), level: 1 }).closest("header");
  if (!header) throw new Error("Expected delivery header");
  return within(header).getByRole("button");
}
async function openStep(user: ReturnType<typeof userEvent.setup>, step: "build" | "verification") {
  const trigger = screen.getByRole("button", { name: i18n.t(`deliveryWorkbench.${step}`) });
  if (trigger.getAttribute("aria-expanded") !== "true") await user.click(trigger);
}
async function ready(locales = ["zh-CN"], twoFiles = true) {
  const user = userEvent.setup(), view = render(<DeliveryConsumer/>, project);
  await waitFor(() => expect(primary()).toBeEnabled()); await user.click(primary());
  await waitFor(() => expect(screen.getByRole("combobox", { name: i18n.t("deliveryWorkbench.builder") })).toBeEnabled());
  for (const locale of locales) {
    await user.click(screen.getByRole("checkbox", { name: locale }));
    const input = screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale }) });
    expect(input).toHaveValue("");
    await user.type(input, `deliverables/${locale}/captions.txt${twoFiles ? `\ndeliverables/${locale}/metadata.txt` : ""}`);
  }
  await user.click(primary()); await screen.findByText(i18n.t("release.ready", { count: 0 }));
  await user.click(primary()); await screen.findByText(i18n.t("deliveryWorkbench.fixedHelp"));
  return { user, view };
}
async function start(user: ReturnType<typeof userEvent.setup>) {
  expect(primary()).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: i18n.t("releasePlugin.builderConsent") }));
  await user.click(primary()); await openStep(user, "build");
}
async function check(user: ReturnType<typeof userEvent.setup>, locale: string) {
  await openStep(user, "build");
  await user.click(await screen.findByRole("button", { name: i18n.t("releasePlugin.prepareCheck", { locale }) }));
  await openStep(user, "verification");
  const consent = await screen.findByRole("checkbox", { name: i18n.t("releasePlugin.checkerConsent") });
  expect(consent).not.toBeChecked(); expect(primary()).toBeDisabled();
  await user.click(consent); await user.click(primary());
  await screen.findByText(i18n.t("releasePlugin.checkReceived"));
  await waitFor(() => expect(primary()).toBeEnabled()); await user.click(primary());
}

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
  await screen.findByRole("button", { name: i18n.t("deliveryWorkbench.saveBuild") });
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
  await screen.findByRole("region", { name: i18n.t("releasePlugin.results") });
  expect(screen.queryByRole("button", { name: i18n.t("releasePlugin.prepareCheck", { locale: scope.locale }) })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("deliveryWorkbench.saveBuild") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command === "prepare_artifact_check" || command === "prepare_execution_adoption")).toBe(false);
});


it.each(["en-US", "zh-CN"])("records all languages and multiple exact paths only after separate grants and proofs in %s", async locale => {
  await i18n.changeLanguage(locale);
  const { user } = await ready(["zh-CN", "fr-FR"]);
  expect(captured!.choices[0].outputPaths).toEqual(["deliverables/zh-CN/captions.txt", "deliverables/zh-CN/metadata.txt"]);
  expect(invoke.mock.calls.filter(([command]) => command === "start_plugin_build")).toHaveLength(0);
  await start(user);
  await check(user, "zh-CN");
  await waitFor(() => expect(screen.queryByRole("button", { name: i18n.t("deliveryWorkbench.saveBuild") })).not.toBeInTheDocument());
  await check(user, "fr-FR");
  await user.click(await screen.findByRole("button", { name: i18n.t("deliveryWorkbench.saveBuild") }));
  await screen.findByText(i18n.t("releasePlugin.recorded"));
  expect(primary()).toBeEnabled();
  expect(captured!.choices.flatMap(choice => choice.outputPaths)).toEqual(["deliverables/zh-CN/captions.txt", "deliverables/zh-CN/metadata.txt", "deliverables/fr-FR/captions.txt", "deliverables/fr-FR/metadata.txt"]);
  const grants = invoke.mock.calls.filter(([command]) => command === "start_plugin_build" || command === "start_artifact_check").map(([, args]) => args.request as PluginStartRequest);
  expect(new Set(grants.map(grant => grant.grantId)).size).toBe(3);
  expect(grants.map(grant => grant.inputDigest)).toEqual(["b".repeat(64), "c".repeat(64), "d".repeat(64)]);
  expect(grants.every(grant => grant.unsandboxedExecution && BigInt(grant.expiresAtMs) > BigInt(Date.now()))).toBe(true);
  expect(invoke.mock.calls.some(([command]) => command === "start_locale_build" || command === "read_source_integration")).toBe(false);
});


it("reconciles a lost proof acknowledgement without another checker grant or partial release", async () => {
  const { user } = await ready(); await start(user);
  const original = invoke.getMockImplementation()!;
  let finishes = 0;
  invoke.mockImplementation(async (command, args) => { const value = await original(command, args); if (command === "finish_artifact_check" && ++finishes === 1) throw { code: "outcome-unknown" }; return value; });
  await check(user, "zh-CN");
  await screen.findByText(i18n.t("releasePlugin.unknown"));
  const record = screen.queryByRole("button", { name: i18n.t("deliveryWorkbench.saveBuild") });
  if (record) expect(record).toBeDisabled();
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.reconcile") }));
  await screen.findByRole("button", { name: i18n.t("deliveryWorkbench.saveBuild") });
  const calls = invoke.mock.calls.filter(([command]) => command === "finish_artifact_check");
  expect(calls).toHaveLength(2); expect(calls[1][1]).toEqual(calls[0][1]);
  expect(invoke.mock.calls.filter(([command]) => command === "start_artifact_check")).toHaveLength(1);
});


it("keeps failed mandatory checks from recording a release and preserves the output paths", async () => {
  const { user } = await ready(); await start(user);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => { if (command === "finish_artifact_check") throw { ...executionFixture.error, code: "output-invalid", reason: "artifact-rule-failed", stage: "execution-adopt", outcome: "rejected" }; return original(command, args); });
  await check(user, "zh-CN");
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getAllByText("deliverables/zh-CN/captions.txt").length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: i18n.t("deliveryWorkbench.saveBuild") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(0);
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
  expect(screen.queryByRole("button", { name: i18n.t("deliveryWorkbench.saveBuild") })).not.toBeInTheDocument();
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
