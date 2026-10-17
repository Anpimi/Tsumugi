import { useLayoutEffect } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import releaseFixture from "../test/fixtures/releaseCommands.contract.json";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import { useReleaseDraftSession } from "./ReleaseDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { pluginBuildRequest, pluginBuildView, pluginBuildWorkflow } from "./testSupport/pluginBuildFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { ProjectView } from "./projectCommands";
import type { PluginBuildPrepareRequest, DeliveryPreview, DeliverySelection, DeliveryView, ExportRequest, ReleaseExceptionKind, ReleaseView } from "./releaseCommands";
import type { ChangeScope } from "./sessionReads";
import * as validators from "./generated/release.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const buildIdentity = fixtureIdentity(701);
const project: ProjectView = { sessionToken: releaseFixture.requests.session.sessionToken, locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: releaseFixture.requests.session.projectId, displayName: "Release owner", sourceLocale: "en", targetLocales: ["zh-CN", "fr-FR"], metadataRevision: "1" } };
let owner: ReturnType<typeof useReleaseDraftSession>, reads: ReturnType<typeof useSessionReads>;
let release: ReleaseView, preview: DeliveryPreview, selection: DeliverySelection, delivery: DeliveryView;
function Probe() {
  const value = useReleaseDraftSession(), sessionReads = useSessionReads();
  useLayoutEffect(() => { owner = value; reads = sessionReads; });
  return null;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function payloads<T>(command: string): T[] { return calls(command).map(([,payload]) => payload.request); }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function mount() {
  const view = render(<Probe/>, project);
  act(() => owner.setBuildSelection(pluginBuildRequest,"fixture",pluginBuildRequest.environmentDigest));
  return view;
}
async function prepare() {
  act(() => { owner.setLanguage("zh-CN", true); owner.setLanguage("fr-FR", true); owner.setName("zh-CN", "i18n/zh.json"); owner.setName("fr-FR", "fr.json"); });
  await act(async () => owner.assess(pluginBuildView));
  expect(owner.eligibility?.ready).toBe(true);
}
async function destination() {
  act(() => owner.chooseRelease(release));
  await act(async () => owner.chooseFolder());
  await act(async () => owner.previewFolder());
  act(() => owner.setOverwrite(true));
}
function fixtureExceptionKind(kind: string): ReleaseExceptionKind {
  if (kind !== "source-fallback" && kind !== "qa-waiver") throw new Error("Invalid release exception fixture");
  return kind;
}
beforeEach(() => {
  const saved = structuredClone(releaseFixture.responses.releases[0]);
  release = { ...saved, exceptions: saved.exceptions.map(value => ({ ...value, kind: fixtureExceptionKind(value.kind) })) };
  preview = structuredClone(releaseFixture.responses.preview) as DeliveryPreview;
  selection = structuredClone(releaseFixture.responses.selection);
  delivery = structuredClone(releaseFixture.responses.delivery) as DeliveryView;
  expect(validators.validateResponsePreview(preview)).toBe(true);
  expect(validators.validateResponseDelivery(delivery)).toBe(true);
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_plugin_build") return pluginBuildView;
    if (command === "read_content_scope") return { currentSnapshot: release.sourceSnapshotId, revision: "1" };
    if (command === "read_review_eligibility") return { policyVersion: release.policyVersion, sourceSnapshotId: release.sourceSnapshotId,
      basis: release.eligibilityBasis, ready: true, locales: (args.request.locales as string[]).map(locale => ({ locale, ready: true, blockers: [], exceptions: [], checkedUnits: 2, blockerCount: 0, exceptionCount: 0 })) };
    if (command === "create_execution_identity") return buildIdentity;
    if (command === "prepare_plugin_build") return { ...pluginBuildWorkflow.review, attemptId: args.request.attemptId, choices: args.request.choices, eligibilityBasis: args.request.expectedEligibilityBasis, sourceSnapshotId: release.sourceSnapshotId };
    if (command === "choose_delivery_folder") return selection;
    if (command === "preview_delivery") return preview;
    if (command === "export_release") return { ...delivery, actionId: args.request.actionId };
    if (command === "read_delivery_action") return { ...delivery, actionId: args.request.actionId };
    throw new Error(command);
  });
});
afterEach(cleanup);

it("reserves before identity creation and retains later edits instead of dispatching stale preparation", async () => {
  mount(); await prepare();
  const identity = deferred<string>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "create_execution_identity" ? identity.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.build(); void owner.build(); });
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  expect(calls("create_execution_identity")).toHaveLength(1);
  act(() => owner.setName("zh-CN", "later.json"));
  await act(async () => { identity.resolve(buildIdentity); await running; });
  expect(calls("prepare_plugin_build")).toHaveLength(0);
  expect(owner.names["zh-CN"]).toBe("later.json"); expect(owner.buildDirty).toBe(true);
});

it("continues a dispatched build without consumers and confirms its original request without clearing newer input", async () => {
  const view = mount(); await prepare();
  const start = deferred<unknown>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "prepare_plugin_build" ? start.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.build(); });
  await waitFor(() => expect(calls("prepare_plugin_build")).toHaveLength(1));
  expect(calls("prepare_plugin_build")).toHaveLength(1);
  const request = payloads<PluginBuildPrepareRequest>("prepare_plugin_build")[0];
  expect(Object.isFrozen(request.choices)).toBe(true);
  act(() => { owner.setName("zh-CN", "new.json"); owner.setLanguage("fr-FR", false); });
  view.rerender(null);
  await act(async () => { start.reject(new Error("Lost acknowledgement")); await running; });
  view.rerender(<Probe/>);
  expect(owner.pending?.kind).toBe("build"); expect(owner.names["zh-CN"]).toBe("new.json");
  invoke.mockImplementation(original);
  await act(async () => owner.checkBuild());
  expect(payloads<PluginBuildPrepareRequest>("prepare_plugin_build")[1]).toEqual(request);
  expect(owner.pending).toBeNull(); expect(owner.earlierBuild).toBe(true); expect(owner.buildDirty).toBe(true);
  expect(owner.languages).toEqual(["zh-CN"]); expect(calls("prepare_plugin_build")).toHaveLength(2);
});

it("continues unchanged preparation after identity resolves with no consumer mounted", async () => {
  const view = mount(); await prepare();
  const original = invoke.getMockImplementation()!, identity = deferred<string>();
  invoke.mockImplementation((command: string, args) => command === "create_execution_identity" ? identity.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.build(); }); await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  view.rerender(null);
  await act(async () => { identity.resolve(buildIdentity); await running; });
  view.rerender(<Probe/>);
  expect(owner.prepared?.review.attemptId).toBe(buildIdentity); expect(owner.pending).toBeNull();
  expect(calls("prepare_plugin_build")).toHaveLength(1);
});

it("does not clear changed project preparation when an earlier dispatched build confirms", async () => {
  const view = mount(); await prepare();
  const original = invoke.getMockImplementation()!, start = deferred<unknown>();
  invoke.mockImplementation((command: string, args) => command === "prepare_plugin_build" ? start.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.build(); }); await waitFor(() => expect(calls("prepare_plugin_build")).toHaveLength(1));
  view.rerender(<Probe/>, { ...project, metadata: { ...project.metadata, sourceLocale: "ja-JP", metadataRevision: "2" } });
  await act(async () => { start.resolve({ ...pluginBuildWorkflow.review, attemptId: buildIdentity, choices: payloads<PluginBuildPrepareRequest>("prepare_plugin_build")[0].choices, eligibilityBasis: release.eligibilityBasis, sourceSnapshotId: release.sourceSnapshotId }); await running; });
  expect(owner.prepared?.review.attemptId).toBe(buildIdentity); expect(owner.buildDirty).toBe(true);
  expect(owner.earlierBuild).toBe(true); expect(owner.eligibility).toBeNull(); expect(owner.names["fr-FR"]).toBe("fr.json");
});

it("reconciles identical prepared bytes without allocating another identity or replacing later input", async () => {
  mount(); await prepare();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string,args) => command === "prepare_plugin_build" ? Promise.reject(new Error("Disconnected")) : original(command,args));
  await act(async () => owner.build());
  const request = payloads<PluginBuildPrepareRequest>("prepare_plugin_build")[0];
  expect(owner.pending?.kind).toBe("build");
  act(() => { owner.setName("zh-CN","new.json"); owner.setLanguage("fr-FR",false); });
  invoke.mockImplementation(original);
  await act(async () => owner.checkBuild());
  expect(payloads<PluginBuildPrepareRequest>("prepare_plugin_build")).toEqual([request,request]);
  expect(owner.pending).toBeNull(); expect(owner.prepared?.request).toEqual(request);
  expect(owner.names["zh-CN"]).toBe("new.json"); expect(owner.languages).toEqual(["zh-CN"]); expect(owner.buildDirty).toBe(true);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("start_plugin_build")).toHaveLength(0);
});

it("preserves an earlier unknown preparation after a formally rejected explicit reconcile", async () => {
  mount(); await prepare(); const original = invoke.getMockImplementation()!; let starts = 0;
  invoke.mockImplementation((command:string,args) => command === "prepare_plugin_build" ? Promise.reject(++starts === 1 ? new Error("First ACK lost")
    : { code:"dependency-conflict",stage:"execution-adopt",outcome:"rejected",recoveryRequired:false }) : original(command,args));
  await act(async () => owner.build()); await act(async () => owner.checkBuild());
  expect(owner.pending?.kind).toBe("build"); expect(owner.pending?.kind === "build" && owner.pending.uncertain).toBe(true);
  expect(owner.pending?.kind === "build" && owner.pending.retryAllowed).toBe(false);
  await act(async () => owner.retryBuild()); expect(calls("prepare_plugin_build")).toHaveLength(2);
  expect(payloads<PluginBuildPrepareRequest>("prepare_plugin_build")[1]).toEqual(payloads<PluginBuildPrepareRequest>("prepare_plugin_build")[0]);
  expect(calls("create_execution_identity")).toHaveLength(1);
});

it.each(["project", "source", "translation", "resources", "review"] as ChangeScope[])("revokes readiness on %s changes while retaining mappings", async scope => {
  mount(); await prepare();
  act(() => reads.invalidate([scope]));
  expect(owner.eligibility).toBeNull(); expect(owner.stale).toBe(true); expect(owner.names["fr-FR"]).toBe("fr.json");
  await act(async () => owner.build()); expect(calls("prepare_plugin_build")).toHaveLength(0);
});

it("keeps readiness through execution ticks but rechecks source and installed build before allocating a build", async () => {
  mount(); await prepare();
  act(() => reads.invalidate(["execution"])); expect(owner.eligibility?.ready).toBe(true);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "read_plugin_build" ? Promise.resolve({ ...pluginBuildView, settingsRevision: "2" }) : original(command, args));
  await act(async () => owner.build());
  expect(owner.eligibility).toBeNull(); expect(owner.stale).toBe(true); expect(calls("create_execution_identity")).toHaveLength(0);
});

it("rechecks source scope after identity creation before dispatching the captured build", async () => {
  mount(); await prepare();
  const original = invoke.getMockImplementation()!, identity = deferred<string>();
  let changed = false;
  invoke.mockImplementation((command: string, args) => command === "create_execution_identity" ? identity.promise
    : command === "read_content_scope" && changed ? Promise.resolve({ currentSnapshot: fixtureIdentity(799), revision: "2" }) : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.build(); }); await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  changed = true;
  await act(async () => { identity.resolve(buildIdentity); await running; });
  expect(calls("prepare_plugin_build")).toHaveLength(0); expect(owner.eligibility).toBeNull();
  expect(owner.names["fr-FR"]).toBe("fr.json"); expect(owner.stale).toBe(true);
});

it("checks captured project values without assuming that an external ProjectView is immutable", async () => {
  const mutable = structuredClone(project);
  render(<Probe/>, mutable); act(() => owner.setBuildSelection(pluginBuildRequest,"fixture",pluginBuildRequest.environmentDigest)); await prepare();
  mutable.metadata.sourceLocale = "ja-JP";
  mutable.metadata.targetLocales.reverse();
  await act(async () => owner.build());
  expect(calls("create_execution_identity")).toHaveLength(0); expect(calls("prepare_plugin_build")).toHaveLength(0);
  expect(owner.names["fr-FR"]).toBe("fr.json");
});

it("keeps removed language input visible but prevents a fresh build for the old target set", async () => {
  const view = mount(); await prepare();
  view.rerender(<Probe/>, { ...project, metadata: { ...project.metadata, targetLocales: ["zh-CN"], metadataRevision: "2" } });
  expect(owner.languages).toEqual(["zh-CN", "fr-FR"]); expect(owner.names["fr-FR"]).toBe("fr.json");
  expect(owner.available()).toBe(false); expect(owner.eligibility).toBeNull();
  await act(async () => owner.build()); expect(calls("prepare_plugin_build")).toHaveLength(0);
});

it("keeps folder, preview and replacement consent across consumer remount without replaying native work", async () => {
  const view = mount();
  act(() => owner.chooseRelease(release));
  const picker = deferred<DeliverySelection | null>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "choose_delivery_folder" ? picker.promise : original(command, args));
  let choosing!: Promise<void>;
  act(() => { choosing = owner.chooseFolder(); }); view.rerender(null);
  await act(async () => { picker.resolve(selection); await choosing; }); view.rerender(<Probe/>);
  await act(async () => owner.previewFolder()); act(() => owner.setOverwrite(true));
  view.rerender(null); view.rerender(<Probe/>);
  expect(owner.selection).toEqual(selection); expect(owner.preview).toEqual(preview); expect(owner.overwrite).toBe(true);
  invoke.mockImplementation((command: string, args) => command === "choose_delivery_folder" ? Promise.resolve(null) : original(command, args));
  await act(async () => owner.chooseFolder());
  expect(owner.preview).toEqual(preview); expect(owner.overwrite).toBe(true);
  expect(calls("preview_delivery")).toHaveLength(1); expect(calls("export_release")).toHaveLength(0);
});

it.each(["missing-file", "duplicate-file", "wrong-hash", "wrong-actual", "wrong-aggregate"])("keeps an export unknown after a typed %s receipt", async defect => {
  mount(); await destination();
  const original = invoke.getMockImplementation()!;
  const invalid = structuredClone(delivery);
  if (defect === "missing-file") invalid.files.pop();
  if (defect === "duplicate-file") invalid.files[1] = { ...invalid.files[0] };
  if (defect === "wrong-hash") invalid.files[1].expectedSha256 = "0".repeat(64);
  if (defect === "wrong-actual") invalid.files[0].actualSha256 = "0".repeat(64);
  if (defect === "wrong-aggregate") invalid.state = "succeeded";
  expect(validators.validateResponseDelivery(invalid)).toBe(true);
  invoke.mockImplementation((command: string, args) => command === "export_release" || command === "read_delivery_action"
    ? Promise.resolve({ ...invalid, actionId: args.request.actionId }) : original(command, args));
  await act(async () => owner.exportFiles());
  expect(owner.pending?.kind).toBe("export"); expect(owner.result).toBeNull(); expect(owner.failure).toBe("outcome-unknown");
  expect(owner.preview).toBeNull(); expect(owner.overwrite).toBe(false); expect(calls("export_release")).toHaveLength(1);
  expect(calls("read_delivery_action")).toHaveLength(1); expect(owner.checkingDelivery).toBe(false);
});

it("uses an explicit recovery lease only for lookup and cannot infer original absence from another folder", async () => {
  const view = mount(); await destination();
  const original = invoke.getMockImplementation()!, recoverySelection = { ...selection, selectionId: fixtureIdentity(720) };
  let lookups = 0;
  invoke.mockImplementation((command: string, args) => command === "export_release" ? Promise.reject(new Error("Lost export"))
    : command === "choose_delivery_folder" ? Promise.resolve(recoverySelection)
    : command === "read_delivery_action" ? lookups++ === 0 ? Promise.reject(new Error("Original directory lease unavailable")) : Promise.resolve(null) : original(command, args));
  await act(async () => owner.exportFiles());
  const request = payloads<ExportRequest>("export_release")[0]; view.rerender(null); view.rerender(<Probe/>);
  await act(async () => owner.chooseFolder(true)); await act(async () => owner.checkExport());
  expect(owner.pending?.kind === "export" && owner.pending.request).toEqual(request);
  expect(owner.exportMissing).toBe(false); expect(owner.reserved()).toBe(true);
  expect(payloads<{selectionId: string}>("read_delivery_action").map(request => request.selectionId)).toEqual([selection.selectionId, recoverySelection.selectionId]);
  expect(calls("export_release")).toHaveLength(1); expect(calls("preview_delivery")).toHaveLength(1);
});

it("recovers the complete original export receipt after explicit directory reauthorization without sending files again", async () => {
  mount(); await destination();
  const original = invoke.getMockImplementation()!, recoverySelection = { selectionId: fixtureIdentity(720), folderName: "another label" };
  let lookups = 0;
  invoke.mockImplementation((command: string, args) => command === "export_release" ? Promise.reject(new Error("Lost export"))
    : command === "choose_delivery_folder" ? Promise.resolve(recoverySelection)
    : command === "read_delivery_action" && lookups++ === 0 ? Promise.reject(new Error("Original directory lease unavailable")) : original(command, args));
  await act(async () => owner.exportFiles()); await act(async () => owner.chooseFolder(true)); await act(async () => owner.checkExport());
  expect(owner.pending).toBeNull(); expect(owner.result?.files).toEqual(delivery.files); expect(owner.result?.state).toBe("partial");
  expect(calls("export_release")).toHaveLength(1); expect(calls("preview_delivery")).toHaveLength(1);
  expect(payloads<{selectionId: string}>("read_delivery_action").map(request => request.selectionId)).toEqual([selection.selectionId, recoverySelection.selectionId]);
});

it("retains a reconcile receipt on a lost ACK and refuses later receipts that rewrite terminal files", async () => {
  const view = mount(); await destination();
  const unresolved: DeliveryView = { ...delivery, state: "unknown", files: [delivery.files[0], { ...delivery.files[1], state: "unknown" }] };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "reconcile_delivery" ? Promise.reject(new Error("Lost check"))
    : command === "read_delivery_action" ? Promise.resolve({ ...unresolved, files: [{ ...unresolved.files[0], actualSha256: null, state: "unknown" }, unresolved.files[1]] }) : original(command, args));
  await act(async () => owner.reconcile(unresolved)); view.rerender(null); view.rerender(<Probe/>);
  expect(owner.pending?.kind).toBe("reconcile");
  expect(calls("read_delivery_action")).toHaveLength(1);
  await act(async () => owner.checkExport());
  expect(owner.pending?.kind).toBe("reconcile"); expect(owner.result).toBeNull(); expect(owner.failure).toBe("outcome-unknown");
  expect(calls("reconcile_delivery")).toHaveLength(1); expect(calls("export_release")).toHaveLength(0);
  expect(calls("read_delivery_action")).toHaveLength(2);
});

it("retains an unresolved valid delivery until reconciliation completes while the consumer is absent", async () => {
  const view = mount(); await destination();
  const original = invoke.getMockImplementation()!, completion = deferred<DeliveryView>();
  const unknown = { ...delivery, state: "unknown", files: delivery.files.map(file => ({ ...file, state: "unknown", actualSha256: null })) };
  invoke.mockImplementation((command: string, args) => command === "export_release" ? Promise.resolve({ ...unknown, actionId: args.request.actionId })
    : command === "read_delivery_action" ? Promise.resolve({ ...unknown, actionId: args.request.actionId })
    : command === "reconcile_delivery" ? completion.promise : original(command, args));
  await act(async () => owner.exportFiles()); expect(owner.pending?.kind).toBe("export");
  expect(calls("read_delivery_action")).toHaveLength(1); expect(calls("reconcile_delivery")).toHaveLength(0);
  let running!: Promise<void>;
  act(() => { running = owner.reconcile(owner.result!); }); view.rerender(null);
  await act(async () => { completion.resolve({ ...delivery, actionId: buildIdentity }); await running; });
  view.rerender(<Probe/>);
  expect(owner.pending).toBeNull(); expect(owner.result?.state).toBe("partial"); expect(calls("export_release")).toHaveLength(1);
});

it.each(["export", "reconcile"] as const)("checks one lost %s acknowledgement within the original reservation without consumers", async operation => {
  const view = mount(); await destination();
  const original = invoke.getMockImplementation()!, lookup = deferred<DeliveryView | null>();
  const command = operation === "export" ? "export_release" : "reconcile_delivery";
  const unresolved: DeliveryView = { ...delivery, state: "unknown", files: delivery.files.map(file => ({ ...file, state: "unknown", actualSha256: null })) };
  invoke.mockImplementation((name: string, args) => name === command ? Promise.reject(new Error("Lost write acknowledgement"))
    : name === "read_delivery_action" ? lookup.promise : original(name, args));
  let running!: Promise<void>;
  act(() => { running = operation === "export" ? owner.exportFiles() : owner.reconcile(unresolved); });
  await waitFor(() => expect(calls("read_delivery_action")).toHaveLength(1));
  const request = payloads<{actionId: string}>(command)[0], pending = owner.current().pending;
  expect(owner.busy).toBe(true); expect(owner.checkingDelivery).toBe(true); expect(owner.reserved()).toBe(true);
  await act(async () => { await owner.checkExport(); await owner.chooseFolder(true); await owner.exportFiles(); await owner.reconcile(unresolved); });
  expect(owner.current().pending).toBe(pending);
  expect(calls(command)).toHaveLength(1); expect(calls("read_delivery_action")).toHaveLength(1);
  expect(calls("choose_delivery_folder")).toHaveLength(1); expect(calls("preview_delivery")).toHaveLength(1);
  expect(payloads("read_delivery_action")).toEqual([{ projectId: project.metadata.projectId, sessionToken: project.sessionToken,
    actionId: request.actionId, selectionId: selection.selectionId }]);
  view.rerender(null);
  await act(async () => { lookup.resolve({ ...delivery, actionId: request.actionId }); await running; });
  view.rerender(<Probe/>);
  expect(owner.pending).toBeNull(); expect(owner.result?.state).toBe("partial"); expect(owner.failure).toBeNull();
  expect(owner.busy).toBe(false); expect(owner.checkingDelivery).toBe(false); expect(owner.reserved()).toBe(false);
  expect(calls(command)).toHaveLength(1); expect(calls("read_delivery_action")).toHaveLength(1);
  expect(calls(operation === "export" ? "reconcile_delivery" : "export_release")).toHaveLength(0);
  expect(calls("create_execution_identity")).toHaveLength(operation === "export" ? 1 : 0);
});

it("recovers an invalid export acknowledgement only from the complete original saved receipt", async () => {
  mount(); await destination();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "export_release"
    ? Promise.resolve({ ...delivery, actionId: args.request.actionId, files: delivery.files.slice(0, 1) }) : original(command, args));
  await act(async () => owner.exportFiles());
  expect(owner.pending).toBeNull(); expect(owner.result?.files).toEqual(delivery.files); expect(owner.failure).toBeNull();
  expect(calls("export_release")).toHaveLength(1); expect(calls("read_delivery_action")).toHaveLength(1);
});

it.each(["unchanged", "regressed", "missing"] as const)("preserves the latest unknown receipt's confirmed files when its automatic lookup is %s", async result => {
  mount(); await destination();
  const original = invoke.getMockImplementation()!;
  const observed: DeliveryView = { ...delivery, actionId: buildIdentity, state: "unknown", files: [delivery.files[0],
    { ...delivery.files[1], state: "unknown", actualSha256: null }] };
  const regressed: DeliveryView = { ...observed, files: observed.files.map(file => ({ ...file, state: "unknown", actualSha256: null })) };
  invoke.mockImplementation((command: string, args) => command === "export_release" ? Promise.resolve(observed)
    : command === "read_delivery_action" ? Promise.resolve(result === "missing" ? null : result === "regressed" ? regressed : observed) : original(command, args));
  await act(async () => owner.exportFiles());
  expect(owner.result).toEqual(observed);
  const pending = owner.current().pending;
  expect(pending?.kind).toBe("export");
  if (!pending || pending.kind === "build") throw new Error("Expected the original unresolved delivery");
  expect(pending.receipt).toEqual(observed); expect(pending.request).toEqual(payloads("export_release")[0]);
  expect(owner.exportMissing).toBe(false); expect(owner.checkingDelivery).toBe(false); expect(owner.reserved()).toBe(true);
  expect(owner.failure).toBe(result === "unchanged" ? null : "outcome-unknown");
  expect(calls("read_delivery_action")).toHaveLength(1); expect(calls("export_release")).toHaveLength(1);
  expect(calls("reconcile_delivery")).toHaveLength(0);
});

it("retains a valid pending acknowledgement without automatically reading or reconciling it", async () => {
  mount(); await destination();
  const original = invoke.getMockImplementation()!;
  const pending: DeliveryView = { ...delivery, actionId: buildIdentity, state: "pending", files: delivery.files.map(file => ({ ...file, state: "pending", actualSha256: null })) };
  invoke.mockImplementation((command: string, args) => command === "export_release" ? Promise.resolve(pending) : original(command, args));
  await act(async () => owner.exportFiles());
  expect(owner.result).toEqual(pending); expect(owner.pending?.kind).toBe("export"); expect(owner.reserved()).toBe(true);
  expect(owner.checkingDelivery).toBe(false); expect(calls("read_delivery_action")).toHaveLength(0);
  expect(calls("reconcile_delivery")).toHaveLength(0); expect(calls("export_release")).toHaveLength(1);
});

it.each(["export", "reconcile"] as const)("does not look up a formally rejected fresh %s", async operation => {
  mount(); await destination();
  const original = invoke.getMockImplementation()!, command = operation === "export" ? "export_release" : "reconcile_delivery";
  const rejected = { code: "destination-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false };
  invoke.mockImplementation((name: string, args) => name === command ? Promise.reject(rejected) : original(name, args));
  const unresolved: DeliveryView = { ...delivery, state: "unknown", files: delivery.files.map(file => ({ ...file, state: "unknown", actualSha256: null })) };
  await act(async () => { if (operation === "export") await owner.exportFiles(); else await owner.reconcile(unresolved); });
  expect(owner.pending).toBeNull(); expect(owner.result).toBeNull(); expect(owner.reserved()).toBe(false);
  expect(owner.failure).toMatchObject(rejected); expect(owner.checkingDelivery).toBe(false);
  expect(calls(command)).toHaveLength(1); expect(calls("read_delivery_action")).toHaveLength(0);
});

it("keeps an earlier unknown export when a later explicit reconciliation is formally rejected", async () => {
  mount(); await destination();
  const original = invoke.getMockImplementation()!;
  const unresolved: DeliveryView = { ...delivery, actionId: buildIdentity, state: "unknown", files: delivery.files.map(file => ({ ...file, state: "unknown", actualSha256: null })) };
  invoke.mockImplementation((command: string, args) => command === "export_release" || command === "read_delivery_action" ? Promise.resolve(unresolved)
    : command === "reconcile_delivery" ? Promise.reject({ code: "destination-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false }) : original(command, args));
  await act(async () => owner.exportFiles());
  const pending = owner.current().pending;
  await act(async () => owner.reconcile(unresolved));
  expect(owner.current().pending).toBe(pending); expect(owner.result).toEqual(unresolved); expect(owner.reserved()).toBe(true);
  expect(owner.checkingDelivery).toBe(false); expect(calls("read_delivery_action")).toHaveLength(1);
  expect(calls("export_release")).toHaveLength(1); expect(calls("reconcile_delivery")).toHaveLength(1);
});

it.each(["before lookup", "during lookup"] as const)("keeps an old delivery out of a replacement owner retired %s", async retirement => {
  const view = mount(); await destination();
  const original = invoke.getMockImplementation()!, write = deferred<DeliveryView>(), lookup = deferred<DeliveryView | null>();
  invoke.mockImplementation((command: string, args) => command === "export_release" ? write.promise
    : command === "read_delivery_action" ? lookup.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.exportFiles(); });
  await waitFor(() => expect(calls("export_release")).toHaveLength(1));
  if (retirement === "during lookup") {
    await act(async () => { write.reject(new Error("Lost export acknowledgement")); });
    await waitFor(() => expect(calls("read_delivery_action")).toHaveLength(1));
    expect(owner.checkingDelivery).toBe(true);
  }
  view.rerender(<Probe/>, { ...project, sessionToken: "replacement-owner" });
  await act(async () => {
    if (retirement === "before lookup") write.reject(new Error("Late export acknowledgement lost"));
    else lookup.resolve({ ...delivery, actionId: buildIdentity });
    await running;
  });
  expect(owner.pending).toBeNull(); expect(owner.result).toBeNull(); expect(owner.chosen).toBeNull();
  expect(owner.busy).toBe(false); expect(owner.checkingDelivery).toBe(false);
  expect(calls("read_delivery_action")).toHaveLength(retirement === "during lookup" ? 1 : 0);
  expect(calls("export_release")).toHaveLength(1); expect(invoke.mock.calls.some(([command]) => command.includes("cancel"))).toBe(false);
});

it("stops dispatch after owner destruction before identity returns", async () => {
  const view = mount(); await prepare();
  const original = invoke.getMockImplementation()!, identity = deferred<string>();
  invoke.mockImplementation((command: string, args) => command === "create_execution_identity" ? identity.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.build(); });
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1)); view.unmount();
  await act(async () => { identity.resolve(buildIdentity); await running; });
  expect(calls("prepare_plugin_build")).toHaveLength(0);
});

it("does not cancel a dispatched native export or apply its late receipt to another owner", async () => {
  const view = mount(); await destination();
  const original = invoke.getMockImplementation()!, exported = deferred<DeliveryView>();
  invoke.mockImplementation((command: string, args) => command === "export_release" ? exported.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.exportFiles(); }); await waitFor(() => expect(calls("export_release")).toHaveLength(1));
  expect(calls("export_release")).toHaveLength(1);
  view.rerender(<Probe/>, { ...project, sessionToken: "new-owner" });
  await act(async () => { exported.resolve({ ...delivery, actionId: buildIdentity }); await running; });
  expect(owner.result).toBeNull(); expect(owner.chosen).toBeNull(); expect(owner.pending).toBeNull();
  expect(calls("export_release")).toHaveLength(1); expect(invoke.mock.calls.some(([command]) => command.includes("cancel"))).toBe(false);
});

it("releases an accepted read proof immediately on owner destruction and only once when identity later returns", async () => {
  const view=mount();await prepare();const identity=deferred<string>(),original=invoke.getMockImplementation()!,dispose=vi.fn();
  invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:original(command,args));
  let running!:Promise<void>;act(()=>{running=owner.build({current:()=>true,dispose});});
  await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(1));view.unmount();expect(dispose).toHaveBeenCalledTimes(1);
  await act(async()=>{identity.resolve(buildIdentity);await running;});
  expect(dispose).toHaveBeenCalledTimes(1);expect(calls("prepare_plugin_build")).toHaveLength(0);
});

it("captures every encoded configuration and artifact path before identity and preserves them across a same-request reconcile", async () => {
  mount();
  const configuration = { schema:{id:"synthetic-build-options",schemaVersion:1,behaviorVersion:1},
    utf8:"",sha256:"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
  act(()=>{owner.setLanguage("zh-CN",true);owner.setName("zh-CN","outputs/captions.vtt\noutputs/metadata.json");owner.setConfiguration("zh-CN",[configuration]);});
  await act(async()=>owner.assess(pluginBuildView));
  const original=invoke.getMockImplementation()!,identity=deferred<string>();
  invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:command==="prepare_plugin_build"?Promise.reject(new Error("ACK lost")):original(command,args));
  let running!:Promise<void>;act(()=>{running=owner.build();void owner.build();});
  await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(1));
  await act(async()=>{identity.resolve(buildIdentity);await running;});
  const captured=payloads<PluginBuildPrepareRequest>("prepare_plugin_build")[0];
  expect(captured.choices).toEqual([{locale:"zh-CN",outputPaths:["outputs/captions.vtt","outputs/metadata.json"],configuration:[configuration]}]);
  expect(captured.build).toEqual(pluginBuildRequest);expect(Object.isFrozen(captured.choices[0].configuration[0])).toBe(true);
  act(()=>owner.setConfiguration("zh-CN",[]));invoke.mockImplementation(original);
  await act(async()=>owner.checkBuild());
  expect(payloads<PluginBuildPrepareRequest>("prepare_plugin_build")).toEqual([captured,captured]);
  expect(owner.configuration["zh-CN"]).toEqual([]);expect(owner.buildDirty).toBe(true);expect(owner.earlierBuild).toBe(true);
  expect(calls("create_execution_identity")).toHaveLength(1);expect(calls("start_plugin_build")).toHaveLength(0);
});

it("retains newer mapping changes during builder authorization and settles only the original fixed input", async () => {
  mount();await prepare();await act(async()=>owner.build());
  act(()=>owner.setConsent(false,true));
  const original=invoke.getMockImplementation()!,identity=deferred<string>();
  invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:command==="start_plugin_build"?Promise.resolve(args.request.attemptId):original(command,args));
  const review=owner.prepared!.review;
  let running!:Promise<void>;act(()=>{running=owner.startBuild();void owner.startBuild();});
  await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(2));
  act(()=>{owner.setName("zh-CN","newer.vtt");owner.setLanguage("fr-FR",false);});
  await act(async()=>{identity.resolve(fixtureIdentity(799));await running;});
  expect(calls("start_plugin_build")).toHaveLength(1);
  expect(payloads("start_plugin_build")[0]).toMatchObject({attemptId:review.attemptId,inputDigest:review.inputDigest,grantId:fixtureIdentity(799),unsandboxedExecution:true});
  expect(owner.attempt).toBe(review.attemptId);expect(owner.names["zh-CN"]).toBe("newer.vtt");expect(owner.languages).toEqual(["zh-CN"]);
  expect(owner.buildDirty).toBe(true);expect(owner.earlierBuild).toBe(true);
});

it("keeps a newer draft when explicit preparation discard is still awaiting its acknowledgement", async () => {
  mount();await prepare();await act(async()=>owner.build());
  const response=deferred<boolean>(),original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args)=>command==="cancel_plugin_build_preparation"?response.promise:original(command,args));
  let discard!:Promise<boolean>;act(()=>{discard=owner.discardBuild(true);});
  await waitFor(()=>expect(calls("cancel_plugin_build_preparation")).toHaveLength(1));
  act(()=>owner.setName("zh-CN","keep-after-discard.vtt"));
  let accepted=true;await act(async()=>{response.resolve(true);accepted=await discard;});
  expect(accepted).toBe(false);expect(owner.prepared).toBeNull();expect(owner.names["zh-CN"]).toBe("keep-after-discard.vtt");expect(owner.buildDirty).toBe(true);
  expect(owner.showSavedBuild(fixtureIdentity(890))).toBe(false);expect(calls("read_saved_plugin_build")).toHaveLength(0);
});


it("keeps a prepared acknowledgement with a different source snapshot unknown instead of offering execution consent",async()=>{
  mount();await prepare();const original=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command:string,args)=>{const result=await original(command,args);return command==="prepare_plugin_build"?{...result,sourceSnapshotId:fixtureIdentity(999)}:result;});
  await act(async()=>owner.build());
  expect(owner.prepared).toBeNull();expect(owner.pending?.kind).toBe("build");expect(owner.pending?.kind==="build"&&owner.pending.sourceSnapshotId).toBe(release.sourceSnapshotId);
  expect(owner.buildConsent).toBeNull();expect(calls("start_plugin_build")).toHaveLength(0);
  const request=payloads<PluginBuildPrepareRequest>("prepare_plugin_build")[0];invoke.mockImplementation(original);
  await act(async()=>owner.checkBuild());
  expect(owner.prepared?.request).toEqual(request);expect(owner.prepared?.review.sourceSnapshotId).toBe(release.sourceSnapshotId);
  expect(payloads<PluginBuildPrepareRequest>("prepare_plugin_build")).toEqual([request,request]);expect(calls("create_execution_identity")).toHaveLength(1);
});
