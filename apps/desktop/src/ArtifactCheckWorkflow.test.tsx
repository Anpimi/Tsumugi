import { createRef, useLayoutEffect, type Ref } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReleaseWorkbench, type ReleaseHandle } from "./ReleaseWorkbench";
import { useReleaseDraftSession } from "./ReleaseDraftSession";
import { useWorkbenchCommands } from "./workbenchCommands";
import { SavedPluginBuildSummary } from "./SavedPluginBuildSummary";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { pluginBuildView, pluginBuildRequest, pluginBuildInventory, pluginBuildPackage, pluginBuildWorkflow, savedPluginBuild } from "./testSupport/pluginBuildFixture";
import { artifactWorkflowView, artifactWorkflowObservation, startArtifactWorkflow, proveArtifactWorkflowStep } from "./testSupport/artifactWorkflowFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import * as validation from "./generated/release.validators";
import { validateRequestPrepare, validateRequestCancel, validateResponseAttempt as executionAttempt } from "./generated/execution.validators";
import type { ArtifactCheckWorkflowView, PluginBuildPrepareRequest, ReleaseView } from "./releaseCommands";
import type { AttemptDetail } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session", locator: "synthetic", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(700), displayName: "Artifact workflow", sourceLocale: "en-US", targetLocales: ["zh-CN", "fr-FR"], metadataRevision: "1" } };
let owner: ReturnType<typeof useReleaseDraftSession>, registry: ReturnType<typeof useWorkbenchCommands>;
let serial: number, captured: PluginBuildPrepareRequest | null, build: AttemptDetail | null, workflow: ArtifactCheckWorkflowView | null;
let drainOnStop: boolean, releases: ReleaseView[];
const sourceId = pluginBuildWorkflow.review.sourceSnapshotId;
function check<T>(value: unknown, guard: (value: unknown) => value is T): T { if (!guard(value)) throw new Error("Invalid strict workflow test request"); return value; }
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function requests(command: string): unknown[] { return calls(command).map(([, args]) => args.request); }
function currentWorkflow() { if (!workflow) throw new Error("Expected original workflow"); return workflow; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function Probe() { const value = useReleaseDraftSession(), commands = useWorkbenchCommands(); useLayoutEffect(() => { owner = value; registry = commands; }); return null; }
function Harness({ consumer = true, handle }: { consumer?: boolean; handle?: Ref<ReleaseHandle> }) {
  return <><Probe/>{consumer ? <ReleaseWorkbench project={project} disabled={false} ref={handle}/> : null}</>;
}
function buildDetail(attemptId: string, request: PluginBuildPrepareRequest): AttemptDetail {
  const items = request.choices.map((choice, index) => ({ scope: { kind: "release-build", id: sourceId, locale: choice.locale }, resultId: fixtureIdentity(800 + index),
    status: { itemId: fixtureIdentity(810 + index), execution: "succeeded", validation: "pending", adoption: "unapplied", cancellationRequested: false, retrySafe: false, diagnostic: null } }));
  const value: unknown = { taskId: fixtureIdentity(820), attemptId, operation: "locale-build", items, nextOffset: null,
    progress: { total: items.length, queued: 0, running: 0, succeeded: items.length, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
    recovery: { attemptId, units: [{ unitId: fixtureIdentity(830), itemIds: items.map(item => item.status.itemId), resultIds: items.map(item => item.resultId),
      scopes: items.map(item => item.scope), remainingItemIds: [], actions: ["adopt-result"], blockedReason: null, receiptId: null }] } };
  // The existing execution boundary validates this through read_execution_attempt.
  if (!value || typeof value !== "object") throw new Error("Invalid attempt fixture");
  return check(value, executionAttempt);
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US"); serial = 1000; captured = null; build = null; workflow = null; drainOnStop = true; releases = [];
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args?: { request: unknown }) => {
    const raw = args?.request;
    switch (command) {
      case "read_plugin_inventory": return pluginBuildInventory;
      case "read_plugin_package": return pluginBuildPackage;
      case "read_plugin_build": return pluginBuildView;
      case "read_content_scope": return { currentSnapshot: sourceId, revision: "1" };
      case "list_releases": return releases;
      case "list_deliveries": return [];
      case "read_review_eligibility": return { policyVersion: "balanced-1", sourceSnapshotId: sourceId, basis: "a".repeat(64), ready: true,
        locales: project.metadata.targetLocales.map(locale => ({ locale, ready: true, blockers: [], exceptions: [], checkedUnits: 2, blockerCount: 0, exceptionCount: 0 })) };
      case "create_execution_identity": return fixtureIdentity(serial++);
      case "prepare_plugin_build": {
        captured = check(raw, validation.validateRequestPluginBuild);
        return { ...structuredClone(pluginBuildWorkflow.review), attemptId: captured.attemptId, choices: captured.choices, eligibilityBasis: captured.expectedEligibilityBasis };
      }
      case "start_plugin_build": {
        const request = check(raw, validation.validateRequestPluginStart);
        if (!captured) throw new Error("Expected exact build preparation");
        build = buildDetail(request.attemptId, captured); return request.attemptId;
      }
      case "read_execution_attempt": return structuredClone(build);
      case "read_artifact_check_workflow_session": return { kind: "available", ownerId: fixtureIdentity(3000), nextGeneration: "1", current: null };
      case "prepare_artifact_check_workflow": {
        const request = check(raw, validation.validateRequestArtifactWorkflowPrepare);
        workflow = artifactWorkflowView(request.preparation); return structuredClone(workflow);
      }
      case "start_artifact_check_workflow": {
        const request = check(raw, validation.validateRequestArtifactWorkflowStart);
        startArtifactWorkflow(currentWorkflow(), request.start); return structuredClone(workflow);
      }
      case "read_artifact_check_workflow": {
        const request = check(raw, validation.validateRequestArtifactWorkflowRead);
        return artifactWorkflowObservation(currentWorkflow(), request.start);
      }
      case "stop_artifact_check_workflow": {
        const request = check(raw, validation.validateRequestArtifactWorkflowStop), value = currentWorkflow();
        expect(request.identity).toEqual(value.preparation.identity);
        value.admissionClosed = true; value.callbacksDrained = drainOnStop; value.phase = "stopped";
        return { identity: request.identity, admissionClosed: true, callbacksDrained: drainOnStop, currentTask: value.currentTask };
      }
      case "cancel_execution_task": check(raw, validateRequestCancel); return "1";
      case "prepare_execution_adoption": {
        const request = check(raw, validateRequestPrepare);
        return { ...executionFixture.action, projectId: request.projectId, actionId: request.actionId,
          attemptId: request.attemptId, unitId: request.unitId, resultIds: request.resultIds,
          cancellationRevision: "0", operation: "locale-build", parameters: null };
      }
      case "adopt_execution": {
        if (!raw || typeof raw !== "object" || !("actionId" in raw) || typeof raw.actionId !== "string" || !build || !captured) throw new Error("Expected original release action");
        const receipt = { ...executionFixture.receipt, projectId: project.metadata.projectId, actionId: raw.actionId, attemptId: build.attemptId, unitId: fixtureIdentity(830) };
        releases = [{ releaseId: fixtureIdentity(702), actionId: raw.actionId, attemptId: build.attemptId, sourceSnapshotId: sourceId, policyVersion: "balanced-1",
          eligibilityBasis: "a".repeat(64), manifestSha256: "a".repeat(64), builderVersion: "builder-1", validatorVersion: "checker-1", sourceFiles: [], exceptions: [], createdAt: "2026-10-16T00:00:00Z",
          artifacts: captured.choices.flatMap(choice => choice.outputPaths.map(fileName => ({ locale: choice.locale, fileName, sha256: "e".repeat(64), entryCount: 2 }))) }];
        return receipt;
      }
      case "read_project": return project;
      case "cancel_plugin_build_preparation": return false;
      default: throw new Error(`Unexpected workflow fixture command: ${command}`);
    }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function ready() {
  const user = userEvent.setup(), handle = createRef<ReleaseHandle>(), view = render(<Harness handle={handle}/>, project);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await screen.findByText(/Example text artifact/);
  for (const locale of project.metadata.targetLocales) {
    await user.click(screen.getByRole("checkbox", { name: locale }));
    await user.type(screen.getByRole("textbox", { name: i18n.t("releasePlugin.paths", { locale }) }), `${locale}.txt`);
  }
  await user.click(screen.getByRole("button", { name: i18n.t("release.check") }));
  await screen.findByText(i18n.t("release.ready", { count: 0 }));
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.capture") }));
  await user.click(await screen.findByRole("checkbox", { name: i18n.t("releasePlugin.builderConsent") }));
  await user.click(screen.getByRole("button", { name: i18n.t("release.build") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("releaseWorkflow.prepare") })).toBeEnabled());
  return { user, handle, view };
}
async function prepareBatch(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: i18n.t("releaseWorkflow.prepare") }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: i18n.t("releaseWorkflow.consentAll") })).toBeEnabled());
}
async function runBatch(user: ReturnType<typeof userEvent.setup>, all = true) {
  await user.click(screen.getByRole("checkbox", { name: all ? i18n.t("releaseWorkflow.consentAll") : i18n.t("releaseWorkflow.consentFor", { locale: "zh-CN" }) }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("releaseWorkflow.run") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: i18n.t("releaseWorkflow.run") }));
  await waitFor(() => expect(calls("start_artifact_check_workflow")).toHaveLength(1));
}
async function completeSelected() {
  const value = currentWorkflow();
  value.steps.forEach((item, index) => { if (item.selected) { proveArtifactWorkflowStep(value, index); if (build) build.items[index].status.validation = "valid"; } });
  value.phase = "completed"; value.admissionClosed = true; value.callbacksDrained = true; value.currentTask = null;
  await refreshWorkbenchReads(["execution", "release"]);
}

it.each(["en-US", "zh-CN"])("runs only an explicit materialized batch and waits for manual release in %s", async locale => {
  const { user } = await ready(); await act(async () => { await i18n.changeLanguage(locale); }); await prepareBatch(user);
  expect(screen.getByRole("checkbox", { name: i18n.t("releaseWorkflow.consentAll") })).not.toBeChecked();
  expect(screen.getByRole("button", { name: i18n.t("releaseWorkflow.run") })).toBeDisabled();
  expect(calls("start_artifact_check_workflow")).toHaveLength(0);
  expect(screen.getByRole("button", { name: i18n.t("releasePlugin.prepareCheck", { locale: "zh-CN" }) })).toBeDisabled();
  await runBatch(user); const request = owner.current().workflow?.start;
  expect(request?.start.consents).toHaveLength(2); expect(new Set(request?.start.consents.map(item => item.grantId)).size).toBe(2);
  await completeSelected();
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("releasePlugin.recordRelease") })).toBeEnabled());
  expect(calls("adopt_execution")).toHaveLength(0); expect(calls("export_release")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: i18n.t("releasePlugin.recordRelease") }));
  await screen.findByText(i18n.t("releasePlugin.recorded"));
  expect(calls("adopt_execution")).toHaveLength(1); expect(calls("export_release")).toHaveLength(0);
});

it("marks unselected languages explicitly and never turns selected completion into release eligibility", async () => {
  const { user } = await ready(); await prepareBatch(user); await runBatch(user, false); await completeSelected();
  await screen.findByText(i18n.t("releaseWorkflow.phase.completed"));
  expect(screen.getByText(i18n.t("releaseWorkflow.step.not-selected"))).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("releasePlugin.recordRelease") })).not.toBeInTheDocument();
  expect(owner.current().workflow?.start?.start.consents).toHaveLength(1);
});

it("records partial negative evidence without replacing a missing report with an empty successful report", async () => {
  const { user } = await ready(); await prepareBatch(user); await runBatch(user);
  const value = currentWorkflow(); proveArtifactWorkflowStep(value, 0); proveArtifactWorkflowStep(value, 1, false, false);
  value.phase = "paused"; value.admissionClosed = true; value.callbacksDrained = true;
  await refreshWorkbenchReads(["execution", "release"]);
  await screen.findByText(i18n.t("releaseWorkflow.proofUnavailable"));
  expect(screen.getByText(i18n.t("releaseWorkflow.proofPassed"))).toBeInTheDocument();
  expect(calls("start_artifact_check_workflow")).toHaveLength(1); expect(calls("adopt_execution")).toHaveLength(0);
});

it("shows a failed preparation without continuing to describe it as materializing", async () => {
  const { user } = await ready(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    const result = await original(command, args);
    if (command === "prepare_artifact_check_workflow") {
      const value = currentWorkflow(); value.phase = "failed"; value.materializationDigest = null; value.steps = [];
      value.admissionClosed = true; value.callbacksDrained = true;
      return structuredClone(value);
    }
    return result;
  });
  await user.click(screen.getByRole("button", { name: i18n.t("releaseWorkflow.prepare") }));
  await screen.findByText(i18n.t("releaseWorkflow.phase.failed"));
  expect(screen.queryByText(i18n.t("releaseWorkflow.materializing"))).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: i18n.t("releaseWorkflow.close") })).toBeEnabled();
  expect(calls("start_artifact_check_workflow")).toHaveLength(0);
});

it("reads original step evidence after the finite intent has retired without recreating consent", async () => {
  const { user } = await ready(); await prepareBatch(user); await runBatch(user);
  const identities = calls("create_execution_identity").length;
  const value = currentWorkflow(); proveArtifactWorkflowStep(value, 0); value.phase = "stopped";
  value.admissionClosed = true; value.callbacksDrained = true; value.currentTask = null;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    const result = await original(command, args);
    if (command === "read_artifact_check_workflow") {
      const request = check(args?.request, validation.validateRequestArtifactWorkflowRead);
      return { ...artifactWorkflowObservation(value, request.start), kind: "admission-closed", view: null };
    }
    return result;
  });
  await refreshWorkbenchReads(["execution", "release"]);
  await screen.findByText(i18n.t("releaseWorkflow.retired"));
  expect(screen.getByText(i18n.t("releaseWorkflow.proofPassed"))).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("releaseWorkflow.step.prepared"))).not.toBeInTheDocument();
  expect(calls("start_artifact_check_workflow")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(identities);
});

it.each(["prepare", "start"])("stops a hung %s through the original identity and ignores its late ACK without clearing newer B", async phase => {
  const { user, handle } = await ready();
  if (phase === "start") await prepareBatch(user);
  const command = phase === "prepare" ? "prepare_artifact_check_workflow" : "start_artifact_check_workflow";
  const hold = deferred<unknown>(), original = invoke.getMockImplementation()!;
  let late: unknown;
  invoke.mockImplementation(async (name, args) => { const result = await original(name, args); if (name === command) {
    late = phase === "prepare" ? { ...currentWorkflow(), phase: "preparing", materializationDigest: null, steps: [], callbacksDrained: false } : result;
    return hold.promise;
  } return result; });
  if (phase === "prepare") await user.click(screen.getByRole("button", { name: i18n.t("releaseWorkflow.prepare") }));
  else await runBatch(user);
  await waitFor(() => expect(calls(command)).toHaveLength(1));
  act(() => owner.setName("zh-CN", "newer-B.txt")); drainOnStop = false;
  await user.click(screen.getByRole("button", { name: i18n.t("releaseWorkflow.stop") }));
  await waitFor(() => expect(calls("stop_artifact_check_workflow")).toHaveLength(1));
  expect(owner.current().workflow?.pending).toBe(phase); expect(owner.reserved()).toBe(true);
  let allowed = true; await act(async () => { allowed = await handle.current!.allowLeave(); }); expect(allowed).toBe(false);
  currentWorkflow().callbacksDrained = true;
  if (phase === "start") { const first = currentWorkflow().steps.find(item => item.selected); if (first) first.phase = "unknown"; currentWorkflow().currentTask = null; }
  await user.click(screen.getByRole("button", { name: i18n.t("releaseWorkflow.refresh") }));
  await waitFor(() => expect(owner.current().workflow?.pending).toBeNull());
  expect(owner.current().workflow?.safety?.admissionClosed).toBe(true);
  expect(screen.queryByText(i18n.t("releaseWorkflow.materializing"))).not.toBeInTheDocument();
  await act(async () => { hold.resolve(late); });
  expect(owner.current().workflow?.safety?.admissionClosed).toBe(true); expect(owner.current().names["zh-CN"]).toBe("newer-B.txt");
  expect(owner.current().workflow?.review?.steps).toHaveLength(2);
  expect(requests(command)).toHaveLength(1); expect(calls("start_artifact_check")).toHaveLength(0);
});

it("checks a hung original stop without waiting for its transport ACK and never reopens admission from its late response", async () => {
  const { user } = await ready(); await prepareBatch(user); await runBatch(user); drainOnStop = false;
  const original = invoke.getMockImplementation()!, held = deferred<unknown>(); let late: unknown;
  invoke.mockImplementation(async (command, args) => { const result = await original(command, args); if (command === "stop_artifact_check_workflow") { late = result; return held.promise; } return result; });
  await user.click(screen.getByRole("button", { name: i18n.t("releaseWorkflow.stop") }));
  await waitFor(() => expect(owner.current().workflow?.stopPending).toBe(true));
  expect(owner.current().workflowStopBusy).toBe(true);
  currentWorkflow().callbacksDrained = true;
  const first = currentWorkflow().steps.find(item => item.selected); if (first) first.phase = "unknown"; currentWorkflow().currentTask = null;
  await user.click(screen.getByRole("button", { name: i18n.t("releaseWorkflow.refresh") }));
  await waitFor(() => expect(owner.current().workflow?.stopPending).toBe(false));
  await waitFor(() => expect(owner.reserved()).toBe(false));
  await act(async () => { held.resolve(late); });
  expect(owner.current().workflow?.safety?.callbacksDrained).toBe(true);
  expect(calls("stop_artifact_check_workflow")).toHaveLength(1);
});

it("fixes the selected inputs before grant identity awaits and does not attach a start to newer B", async () => {
  const { user } = await ready(); await prepareBatch(user);
  await user.click(screen.getByRole("checkbox", { name: i18n.t("releaseWorkflow.consentAll") }));
  const original = invoke.getMockImplementation()!, held = deferred<string>(), count = calls("create_execution_identity").length;
  invoke.mockImplementation((command, args) => command === "create_execution_identity" ? held.promise : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("releaseWorkflow.run") }));
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(count + 1));
  act(() => owner.setName("zh-CN", "new-during-grant.txt"));
  await act(async () => { held.resolve(fixtureIdentity(9900)); });
  await waitFor(() => expect(owner.current().busy).toBe(false));
  expect(calls("start_artifact_check_workflow")).toHaveLength(0); expect(owner.current().workflow?.start).toBeNull();
  expect(owner.current().workflow?.approved).toHaveLength(2); expect(owner.current().names["zh-CN"]).toBe("new-during-grant.txt");
});

it("keeps stop, callbacks draining and cancellation of the current Task distinct", async () => {
  const { user } = await ready(); await prepareBatch(user); await runBatch(user); drainOnStop = false;
  await user.click(screen.getByRole("button", { name: i18n.t("releaseWorkflow.stop") }));
  await screen.findByText(i18n.t("releaseWorkflow.draining"));
  expect(calls("cancel_execution_task")).toHaveLength(0); expect(owner.reserved()).toBe(true);
  expect(screen.getByRole("button", { name: i18n.t("releaseWorkflow.close") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: i18n.t("execution.cancel") }));
  await waitFor(() => expect(calls("cancel_execution_task")).toHaveLength(1));
  expect(owner.reserved()).toBe(true);
});

it("upgrades an initial preparing read only when the complete original materialization arrives", async () => {
  const { user, view } = await ready(), original = invoke.getMockImplementation()!;
  const timers = vi.spyOn(globalThis, "setTimeout"), clears = vi.spyOn(globalThis, "clearTimeout");
  let materialized = false;
  invoke.mockImplementation(async (command, args) => {
    const result = await original(command, args);
    if ((command === "prepare_artifact_check_workflow" || command === "read_artifact_check_workflow") && !materialized) {
      const pending = { ...currentWorkflow(), phase: "preparing", materializationDigest: null, steps: [], callbacksDrained: false };
      return command === "prepare_artifact_check_workflow" ? pending : { ...artifactWorkflowObservation(currentWorkflow()), view: pending, callbacksDrained: false };
    }
    return result;
  });
  await user.click(screen.getByRole("button", { name: i18n.t("releaseWorkflow.prepare") }));
  await waitFor(() => expect(owner.current().workflow?.pending).toBeNull());
  expect(owner.current().workflow?.review).toBeNull(); expect(owner.reserved()).toBe(true);
  const pendingTimers = timers.mock.calls.flatMap(([, delay], index) => {
    const result = timers.mock.results[index];
    return delay === 1000 && result.type === "return" && !clears.mock.calls.some(([value]) => value === result.value) ? [result.value] : [];
  });
  expect(pendingTimers).toHaveLength(1);
  view.rerender(<Harness consumer={false}/>);
  expect(clears).toHaveBeenCalledWith(pendingTimers[0]);
  materialized = true; view.rerender(<Harness/>);
  await waitFor(() => expect(screen.getByRole("checkbox", { name: i18n.t("releaseWorkflow.consentAll") })).toBeEnabled(), { timeout: 2500 });
  expect(owner.current().workflow?.review?.steps).toHaveLength(2); expect(owner.reserved()).toBe(false);
  timers.mockRestore(); clears.mockRestore();
});

it("retains original unknown start, consent and B across complete consumer unmount and exact readback without another start", async () => {
  const { user, view } = await ready(); await prepareBatch(user);
  const original = invoke.getMockImplementation()!; let missing = true;
  invoke.mockImplementation(async (command, args) => {
    if (command === "read_artifact_check_workflow" && missing && owner.current().workflow?.start) throw new Error("Read unavailable");
    const value = await original(command, args); if (command === "start_artifact_check_workflow") throw new Error("Lost start ACK"); return value;
  });
  await runBatch(user); await waitFor(() => expect(owner.current().workflow?.uncertain).toBe(true));
  const sent = owner.current().workflow?.start, identities = calls("create_execution_identity").length;
  act(() => owner.setName("zh-CN", "retained-B.txt")); view.rerender(<Harness consumer={false}/>);
  missing = false; view.rerender(<Harness/>);
  await waitFor(() => expect(owner.current().workflow?.pending).toBeNull());
  expect(owner.current().workflow?.start).toEqual(sent); expect(owner.current().names["zh-CN"]).toBe("retained-B.txt");
  expect(calls("create_execution_identity")).toHaveLength(identities); expect(calls("start_artifact_check_workflow")).toHaveLength(1);
});

it("rejects a stale typed control payload and never runs from invalidation alone", async () => {
  const { user } = await ready(); await prepareBatch(user);
  const value = owner.current().workflow;
  if (!value) throw new Error("Expected captured workflow");
  expect(registry.dispatch("release.run-check-workflow", { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "release" }, {
    kind: "release-workflow", identity: { ...value.request.preparation.identity, workflowId: fixtureIdentity(9999) }, materializationDigest: value.review?.materializationDigest ?? null, approvedAttemptIds: [] })).toBe(false);
  await refreshWorkbenchReads(["execution", "release"]);
  expect(calls("start_artifact_check_workflow")).toHaveLength(0);
});

it("shows saved negative proof and checker provenance as read-only history without restoring authority", () => {
  const preparation = check({ ...pluginBuildWorkflow.session, preparation: { identity: { ownerId: fixtureIdentity(3000), generation: "1", workflowId: fixtureIdentity(3001) },
    buildAttemptId: savedPluginBuild.attemptId, buildInputDigest: savedPluginBuild.inputDigest, build: pluginBuildRequest,
    buildResults: [{ itemId: savedPluginBuild.locales[0].itemId, resultId: fixtureIdentity(3002) }] } }, validation.validateRequestArtifactWorkflowPrepare);
  const value = artifactWorkflowView(preparation.preparation); proveArtifactWorkflowStep(value, 0, false, false);
  const proof = value.steps[0]?.proof;
  if (!proof) throw new Error("Expected the original negative proof");
  const history = structuredClone(savedPluginBuild); history.locales[0].artifactCheck = proof;
  render(<SavedPluginBuildSummary build={history}/>, project);
  expect(screen.getByText(i18n.t("releaseWorkflow.proofUnavailable"))).toBeInTheDocument();
  expect(screen.getByText(/check-artifact/)).toBeInTheDocument(); expect(invoke).not.toHaveBeenCalled();
});
