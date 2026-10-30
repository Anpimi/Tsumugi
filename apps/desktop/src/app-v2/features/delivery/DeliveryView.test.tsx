import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Delivery, { type DeliveryViewProps } from "./DeliveryView";
import { useReleaseDraftSession } from "../../../ReleaseDraftSession";
import { useExecutionTaskSession } from "../../../ExecutionTaskSession";
import { useWorkbenchCommands } from "../../../workbenchCommands";
import { renderWorkbench as render } from "../../../testSupport/WorkbenchTestShell";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { pluginBuildInventory, pluginBuildPackage, pluginBuildView, pluginBuildWorkflow } from "../../../testSupport/pluginBuildFixture";
import wire from "../../../../test/fixtures/releaseCommands.contract.json";
import type { DeliveryView as ExportRecord, PluginBuildPrepareRequest } from "../../../releaseCommands";
import type { ProjectView } from "../../../projectCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { i18n } from "../../../i18n";
import type { DecisionItem, DecisionPage } from "../../../decisionCommands";
import type { deliveryWorkbenchEn } from "../../../i18n/deliveryWorkbench";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { locator: "/synthetic/delivery", sessionToken: wire.requests.session.sessionToken, reconciliationState: "settled",
  metadata: { projectId: wire.requests.session.projectId, displayName: "Delivery sample", sourceLocale: "en-US", targetLocales: ["zh-CN", "fr-FR"], metadataRevision: "1" } };
const release = wire.responses.releases[0];
const w = (key: keyof typeof deliveryWorkbenchEn, values: Record<string, string | number> = {}) => i18n.t(`deliveryWorkbench.${key}`, values);
let gate: InteractionGate, owner: ReturnType<typeof useReleaseDraftSession>, stored: ExportRecord | null, serial: number;
let installed: boolean, loseExport: boolean, readAttempts: number, prepared: PluginBuildPrepareRequest | null;
function Harness({ visible = true, target = null, inbox, onOpenDecision }: { visible?: boolean; target?: DeliveryViewProps["target"]; project?: ProjectView; inbox?: DeliveryViewProps["inbox"]; onOpenDecision?: DeliveryViewProps["onOpenDecision"] }) {
  owner = useReleaseDraftSession();
  const tasks = useExecutionTaskSession(), commands = useWorkbenchCommands();
  return <Delivery project={project} owner={owner} tasks={tasks} commands={commands} gate={gate} viewId="delivery-view" visible={visible} disabled={false}
    onOpenDecisions={() => {}} onOpenKnowledge={() => {}} onOpenExtensions={() => {}} target={target} inbox={inbox} onOpenDecision={onOpenDecision}/>;
}
function mainAction() {
  const header = screen.getByRole("heading", { name: w("title"), level: 1 }).closest("header");
  if (!header) throw new Error("Delivery header required");
  return within(header).getByRole("button");
}
function recordName() {
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "short" }).format(new Date(release.createdAt));
  return w("chooseRecord", { date });
}
async function chooseSaved() {
  const user = userEvent.setup();
  const view = render(<Harness project={project}/>);
  const history = await screen.findByRole("button", { name: w("history") });
  await waitFor(() => expect(history).toBeEnabled());
  await user.click(history);
  await user.click(await screen.findByRole("button", { name: recordName() }));
  await waitFor(() => expect(mainAction()).toBeEnabled());
  return { user, view };
}
async function prepareExport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(mainAction());
  await screen.findByText(w("folder") + ": " + wire.responses.selection.folderName);
  await user.click(mainAction());
  await screen.findByRole("checkbox", { name: w("overwrite") });
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); gate = new InteractionGate(); gate.setVisibleOwner("delivery-view");
  stored = null; serial = 720; installed = false; loseExport = false; readAttempts = 0; prepared = null;
  invoke.mockReset().mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const request = args?.request;
    if (command === "list_releases") return [release];
    if (command === "list_deliveries") return stored ? [stored] : [];
    if (command === "read_plugin_inventory") return installed ? pluginBuildInventory : { ...pluginBuildInventory, packages: [], packageDecisions: [], runtimes: [], runtimeDecisions: [] };
    if (command === "read_plugin_package") return pluginBuildPackage;
    if (command === "read_plugin_build") return pluginBuildView;
    if (command === "create_execution_identity") return id(serial++);
    if (command === "choose_delivery_folder") return wire.responses.selection;
    if (command === "preview_delivery") return wire.responses.preview;
    if (command === "export_release") {
      stored = { ...wire.responses.delivery, actionId: String(request.actionId), state: "succeeded", files: wire.responses.delivery.files.map(file => ({ ...file, state: "succeeded", actualSha256: file.expectedSha256 })) };
      if (loseExport) throw { code: "outcome-unknown" };
      return stored;
    }
    if (command === "read_delivery_action") {
      if (++readAttempts === 1 && loseExport) throw { code: "storage-failed" };
      return stored;
    }
    if (command === "read_delivery_record") return { ...wire.responses.delivery, actionId: request.actionId, deliveryId: request.deliveryId, releaseId: request.releaseId };
    if (command === "read_content_scope") return { currentSnapshot: id(707), revision: "1" };
    if (command === "read_review_eligibility") return { basis: "basis", sourceSnapshotId: id(707), epoch: id(1), sequence: "1", ready: true, policyVersion: "balanced-1", locales: (request.locales as string[]).map(locale => ({ locale, ready: true, blockers: [], exceptions: [], checkedUnits: 2, selectedUnits: 2, blockingUnits: 0, blockerCount: 0, exceptionCount: 0 })) };
    if (command === "prepare_plugin_build") { prepared = request as unknown as PluginBuildPrepareRequest; return { ...pluginBuildWorkflow.review, attemptId: prepared.attemptId, choices: prepared.choices, build: pluginBuildView, eligibilityBasis: prepared.expectedEligibilityBasis, sourceSnapshotId: id(707) }; }
    throw new Error(command);
  });
});
afterEach(() => { cleanup(); gate.dispose(); });

it.each([
  { locale: "en-US", title: "Delivery", steps: ["Readiness", "Build", "Verification", "Export", "History"], settings: "Build settings" },
  { locale: "zh-CN", title: "交付", steps: ["就绪检查", "构建", "验证", "导出", "历史"], settings: "构建设置" },
])("exports a saved build through the five-step surface without a model or installed builder in $locale", async labels => {
  await i18n.changeLanguage(labels.locale);
  const { user } = await chooseSaved();
  expect(screen.getByRole("heading", { name: labels.title, level: 1 })).toBeVisible();
  for (const label of labels.steps) expect(screen.getByRole("heading", { name: label, level: 2 })).toBeVisible();
  expect(screen.getByRole("button", { name: labels.settings })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getAllByRole("button").filter(button => button.getAttribute("data-variant") === "primary")).toHaveLength(1);
  await prepareExport(user);
  expect(mainAction()).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "export_release")).toBe(false);
  await user.click(screen.getByRole("checkbox", { name: w("overwrite") }));
  await user.click(mainAction());
  await screen.findByText(w("exported"));
  const call = invoke.mock.calls.find(([command]) => command === "export_release");
  expect(call?.[1].request).toEqual({ ...wire.requests.export, projectId: project.metadata.projectId, sessionToken: project.sessionToken, actionId: id(720) });
  expect(invoke.mock.calls.filter(([command]) => command === "export_release")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => ["prepare_plugin_build", "start_plugin_build", "start_ai_translation", "prepare_artifact_check"].includes(command))).toBe(false);
});

it("clears only an unsubmitted export setup while keeping the saved release and newer build input", async () => {
  const { user } = await chooseSaved(); await prepareExport(user);
  await user.click(screen.getByRole("checkbox", { name: w("overwrite") }));
  act(() => owner.setName("zh-CN", "retained-build-B.json"));
  await user.click(screen.getByRole("button", { name: w("clearDestination") }));
  expect(owner.current()).toMatchObject({ chosen: release, selection: null, preview: null, overwrite: false, deliveryDirty: false,
    names: { "zh-CN": "retained-build-B.json" }, buildDirty: true });
  expect(invoke.mock.calls.some(([command]) => ["export_release", "reconcile_delivery", "cancel_plugin_build_preparation"].includes(command))).toBe(false);
  expect(mainAction()).toBeEnabled();
});

it("keeps an unknown export across leaving and reopening, then checks that same action without exporting twice", async () => {
  loseExport = true;
  const { user, view } = await chooseSaved();
  await prepareExport(user);
  await user.click(screen.getByRole("checkbox", { name: w("overwrite") }));
  await user.click(mainAction());
  await screen.findByText(w("exportUnknown"));
  const request = structuredClone(owner.current().pending);
  act(() => gate.setVisibleOwner("other-view"));
  view.rerender(<Harness project={project} visible={false}/>);
  expect(owner.current().pending).toEqual(request);
  act(() => gate.setVisibleOwner("delivery-view"));
  view.rerender(<Harness project={project}/>);
  await user.click(mainAction());
  await screen.findByText(w("exported"));
  const exportRequest = invoke.mock.calls.find(([command]) => command === "export_release")?.[1].request;
  expect(invoke.mock.calls.filter(([command]) => command === "export_release")).toHaveLength(1);
  const checks = invoke.mock.calls.filter(([command]) => command === "read_delivery_action");
  expect(checks.at(-1)?.[1].request.actionId).toBe(exportRequest.actionId);
  expect(owner.current().pending).toBeNull();
});

it("keeps the current mapping when navigation opens an older export outcome", async () => {
  installed = true;
  const user = userEvent.setup(), view = render(<Harness project={project}/>);
  const settings = await screen.findByRole("button", { name: w("settings") });
  await waitFor(() => expect(settings).toBeEnabled());
  await user.click(settings);
  await waitFor(() => expect(screen.getByRole("combobox", { name: w("builder") })).toBeEnabled());
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  const input = screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale: "zh-CN" }) });
  await user.type(input, "deliverables/kept-B.txt");
  const target = { releaseId: release.releaseId, deliveryId: id(708), actionId: id(703) };
  view.rerender(<Harness project={project} target={target}/>);
  await screen.findByText(w("ownerKept"));
  expect(input).toHaveValue("deliverables/kept-B.txt"); expect(owner.current().chosen).toBeNull();
  expect(invoke.mock.calls.find(([command]) => command === "read_delivery_record")?.[1].request).toEqual({ ...target, projectId: project.metadata.projectId, sessionToken: project.sessionToken });
  expect(invoke.mock.calls.some(([command]) => ["export_release", "choose_delivery_folder", "reconcile_delivery", "start_plugin_build"].includes(command))).toBe(false);
});

it("guides an unconfigured check into settings, captures exact paths and keeps execution consent separate", async () => {
  installed = true;
  const user = userEvent.setup(); render(<Harness project={project}/>);
  await screen.findByRole("button", { name: w("check") });
  await waitFor(() => expect(mainAction()).toBeEnabled());
  await user.click(mainAction());
  const inputLabel = i18n.t("releasePlugin.paths", { locale: "zh-CN" });
  await screen.findByRole("combobox", { name: w("builder") });
  await waitFor(() => expect(screen.getByRole("combobox", { name: w("builder") })).toBeEnabled());
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  await user.type(screen.getByRole("textbox", { name: inputLabel }), "deliverables/zh-CN/译文.txt");
  await user.click(mainAction());
  await screen.findByText(w("ready"));
  await user.click(mainAction());
  const consent = await screen.findByRole("checkbox", { name: i18n.t("releasePlugin.builderConsent") });
  expect(consent).not.toBeChecked(); expect(mainAction()).toBeDisabled();
  expect(prepared?.choices).toEqual([{ locale: "zh-CN", outputPaths: ["deliverables/zh-CN/译文.txt"], configuration: [] }]);
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_build")).toBe(false);
});


it("explains a changed typed issue and explicitly refreshes the shared feed without replacing build settings", async () => {
  const item: DecisionItem = { decisionId: "delivery-unknown:synthetic", source: "delivery-unknown", state: "awaiting-recheck", locale: "zh-CN", targets: [{ kind: "delivery", releaseId: release.releaseId, deliveryId: id(708) }], targetsComplete: true,
    basis: "d".repeat(64), sourceActionId: id(703), action: { kind: "inspect-delivery-outcome", releaseId: release.releaseId, deliveryId: id(708), actionId: id(703) },
    evidence: { kind: "delivery-outcome", state: "unknown", locales: ["zh-CN"], fileCount: 1, unknownFileCount: 1 } };
  const page: DecisionPage = { projectId: project.metadata.projectId, basis: "e".repeat(64), query: { locale: null, sources: ["delivery-unknown"] }, items: [item], next: null, knownCount: 1, total: 1,
    coverage: [{ source: "delivery-unknown", knownCount: 1, total: 1, state: "complete", reason: null, errorCode: null }], deliveryActivity: [], executionActivity: [], localActions: null };
  const retry = vi.fn(), onOpenDecision = vi.fn(async () => false), inbox = { page, loading: false, failure: null, current: () => true, retry };
  const user = userEvent.setup(); render(<Harness project={project} inbox={inbox} onOpenDecision={onOpenDecision}/>);
  const readiness = await screen.findByRole("button", { name: w("readiness") });
  await waitFor(() => expect(readiness).toBeEnabled()); await user.click(readiness);
  const issues = screen.getByRole("region", { name: w("otherIssues") });
  await user.click(within(issues).getAllByRole("button", { name: w("openDecisions") })[0]);
  expect(await within(issues).findByText(w("decisionChanged"))).toBeVisible();
  await user.click(within(issues).getByRole("button", { name: w("refreshIssues") }));
  expect(retry).toHaveBeenCalledOnce(); expect(onOpenDecision).toHaveBeenCalledExactlyOnceWith(item);
  expect(owner.current().pending).toBeNull();
  expect(invoke.mock.calls.some(([command]) => ["export_release", "reconcile_delivery", "read_decision_page"].includes(command))).toBe(false);
});
