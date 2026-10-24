import { useLayoutEffect } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import releaseFixture from "../test/fixtures/releaseCommands.contract.json";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import { useReleaseDraftSession } from "./ReleaseDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { sourceIntegrationFixture } from "./testSupport/sourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { ProjectView } from "./projectCommands";
import type { BuildRequest, DeliveryPreview, DeliverySelection, DeliveryView, ExportRequest, ReleaseExceptionKind, ReleaseView } from "./releaseCommands";
import type { ChangeScope } from "./sessionReads";
import * as validators from "./generated/release.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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
  act(() => owner.observeIntegration(sourceIntegrationFixture));
  return view;
}
async function prepare() {
  act(() => { owner.setLanguage("zh-CN", true); owner.setLanguage("fr-FR", true); owner.setName("fr-FR", "fr.json"); });
  await act(async () => owner.assess());
  expect(owner.eligibility?.ready).toBe(true);
}
async function destination() {
  act(() => owner.chooseRelease(release));
  await act(async () => owner.chooseFolder());
  await act(async () => owner.previewFolder());
  act(() => owner.setOverwrite(true));
}
const savedBuild = { ...executionFixture.detail, attemptId: releaseFixture.requests.build.attemptId, operation: "locale-build",
  recovery: { ...executionFixture.detail.recovery, attemptId: releaseFixture.requests.build.attemptId } };
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
    if (command === "read_source_integration") return sourceIntegrationFixture;
    if (command === "read_content_scope") return { currentSnapshot: release.sourceSnapshotId, revision: "1" };
    if (command === "read_review_eligibility") return { policyVersion: release.policyVersion, sourceSnapshotId: release.sourceSnapshotId,
      basis: release.eligibilityBasis, ready: true, locales: (args.request.locales as string[]).map(locale => ({ locale, ready: true, blockers: [], exceptions: [], checkedUnits: 2, blockerCount: 0, exceptionCount: 0 })) };
    if (command === "create_execution_identity") return releaseFixture.requests.build.attemptId;
    if (command === "start_locale_build") return args.request.attemptId;
    if (command === "choose_delivery_folder") return selection;
    if (command === "preview_delivery") return preview;
    if (command === "export_release") return { ...delivery, actionId: args.request.actionId };
    if (command === "read_delivery_action") return { ...delivery, actionId: args.request.actionId };
    if (command === "read_locale_build_attempt") return savedBuild;
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
  await act(async () => { identity.resolve(releaseFixture.requests.build.attemptId); await running; });
  expect(calls("start_locale_build")).toHaveLength(0);
  expect(owner.names["zh-CN"]).toBe("later.json"); expect(owner.buildDirty).toBe(true);
});

it("continues a dispatched build without consumers and confirms its original request without clearing newer input", async () => {
  const view = mount(); await prepare();
  const start = deferred<string>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "start_locale_build" ? start.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.build(); });
  await waitFor(() => expect(calls("start_locale_build")).toHaveLength(1));
  expect(calls("start_locale_build")).toHaveLength(1);
  const request = payloads<BuildRequest>("start_locale_build")[0];
  expect(Object.isFrozen(request.choices)).toBe(true);
  act(() => { owner.setName("zh-CN", "new.json"); owner.setLanguage("fr-FR", false); });
  view.rerender(null);
  await act(async () => { start.reject(new Error("Lost acknowledgement")); await running; });
  view.rerender(<Probe/>);
  expect(owner.pending?.kind).toBe("build"); expect(owner.names["zh-CN"]).toBe("new.json");
  await act(async () => owner.checkBuild());
  expect(payloads<BuildRequest>("read_locale_build_attempt")[0]).toEqual(request);
  expect(owner.pending).toBeNull(); expect(owner.earlierBuild).toBe(true); expect(owner.buildDirty).toBe(true);
  expect(owner.languages).toEqual(["zh-CN"]); expect(calls("start_locale_build")).toHaveLength(1);
});

it("continues unchanged preparation after identity resolves with no consumer mounted", async () => {
  const view = mount(); await prepare();
  const original = invoke.getMockImplementation()!, identity = deferred<string>();
  invoke.mockImplementation((command: string, args) => command === "create_execution_identity" ? identity.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.build(); }); await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  view.rerender(null);
  await act(async () => { identity.resolve(releaseFixture.requests.build.attemptId); await running; });
  view.rerender(<Probe/>);
  expect(owner.attempt).toBe(releaseFixture.requests.build.attemptId); expect(owner.pending).toBeNull();
  expect(calls("start_locale_build")).toHaveLength(1);
});

it("does not clear changed project preparation when an earlier dispatched build confirms", async () => {
  mount(); await prepare();
  const original = invoke.getMockImplementation()!, start = deferred<string>();
  invoke.mockImplementation((command: string, args) => command === "start_locale_build" ? start.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.build(); }); await waitFor(() => expect(calls("start_locale_build")).toHaveLength(1));
  act(() => { owner.observeIntegration({ ...sourceIntegrationFixture, available: false, capabilityVersion: "changed" }); });
  await act(async () => { start.resolve(releaseFixture.requests.build.attemptId); await running; });
  expect(owner.attempt).toBe(releaseFixture.requests.build.attemptId); expect(owner.buildDirty).toBe(true);
  expect(owner.earlierBuild).toBe(true); expect(owner.eligibility).toBeNull(); expect(owner.names["fr-FR"]).toBe("fr.json");
});

it("retries identical build bytes only after exact absence and revokes that evidence on every new unknown", async () => {
  mount(); await prepare();
  const original = invoke.getMockImplementation()!;
  let missing = true;
  invoke.mockImplementation((command: string, args) => command === "start_locale_build" ? Promise.reject(new Error("Disconnected"))
    : command === "read_locale_build_attempt" ? missing ? Promise.resolve(null) : Promise.reject(new Error("Read lost")) : original(command, args));
  await act(async () => owner.build()); await act(async () => owner.checkBuild());
  expect(owner.pending?.kind === "build" && owner.pending.retryAllowed).toBe(true);
  act(() => { owner.setName("zh-CN", "new.json"); owner.setLanguage("fr-FR", false); owner.setLanguage("fr-FR", true); });
  await act(async () => owner.retryBuild());
  expect(payloads<BuildRequest>("start_locale_build")[1]).toEqual(payloads<BuildRequest>("start_locale_build")[0]);
  expect(owner.pending?.kind === "build" && owner.pending.retryAllowed).toBe(false);
  missing = false; await act(async () => owner.checkBuild()); await act(async () => owner.retryBuild());
  expect(calls("start_locale_build")).toHaveLength(2); expect(calls("create_execution_identity")).toHaveLength(1);
});

it("preserves an earlier unknown dispatch after a formally rejected retry and requires another exact lookup", async () => {
  mount(); await prepare();
  const original = invoke.getMockImplementation()!;
  let starts = 0;
  invoke.mockImplementation((command: string, args) => command === "start_locale_build" ? ++starts === 1 ? Promise.reject(new Error("First ACK lost"))
    : Promise.reject({ code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false })
    : command === "read_locale_build_attempt" ? Promise.resolve(null) : original(command, args));
  await act(async () => owner.build()); await act(async () => owner.checkBuild()); await act(async () => owner.retryBuild());
  expect(owner.pending?.kind).toBe("build"); expect(owner.pending?.kind === "build" && owner.pending.retryAllowed).toBe(false);
  await act(async () => owner.retryBuild()); expect(calls("start_locale_build")).toHaveLength(2);
  expect(payloads<BuildRequest>("start_locale_build")[1]).toEqual(payloads<BuildRequest>("start_locale_build")[0]);
});

it.each(["project", "source", "translation", "resources", "review"] as ChangeScope[])("revokes readiness on %s changes while retaining mappings", async scope => {
  mount(); await prepare();
  act(() => reads.invalidate([scope]));
  expect(owner.eligibility).toBeNull(); expect(owner.stale).toBe(true); expect(owner.names["fr-FR"]).toBe("fr.json");
  await act(async () => owner.build()); expect(calls("start_locale_build")).toHaveLength(0);
});

it("keeps readiness through execution ticks but rechecks source and integration before allocating a build", async () => {
  mount(); await prepare();
  act(() => reads.invalidate(["execution"])); expect(owner.eligibility?.ready).toBe(true);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "read_source_integration" ? Promise.resolve({ ...sourceIntegrationFixture, capabilityVersion: "changed" }) : original(command, args));
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
  await act(async () => { identity.resolve(releaseFixture.requests.build.attemptId); await running; });
  expect(calls("start_locale_build")).toHaveLength(0); expect(owner.eligibility).toBeNull();
  expect(owner.names["fr-FR"]).toBe("fr.json"); expect(owner.stale).toBe(true);
});

it("checks captured project values without assuming that an external ProjectView is immutable", async () => {
  const mutable = structuredClone(project);
  render(<Probe/>, mutable); act(() => owner.observeIntegration(sourceIntegrationFixture)); await prepare();
  mutable.metadata.sourceLocale = "ja-JP";
  mutable.metadata.targetLocales.reverse();
  await act(async () => owner.build());
  expect(calls("create_execution_identity")).toHaveLength(0); expect(calls("start_locale_build")).toHaveLength(0);
  expect(owner.names["fr-FR"]).toBe("fr.json");
});

it("keeps removed language input visible but prevents a fresh build for the old target set", async () => {
  const view = mount(); await prepare();
  view.rerender(<Probe/>, { ...project, metadata: { ...project.metadata, targetLocales: ["zh-CN"], metadataRevision: "2" } });
  expect(owner.languages).toEqual(["zh-CN", "fr-FR"]); expect(owner.names["fr-FR"]).toBe("fr.json");
  expect(owner.available()).toBe(false); expect(owner.eligibility).toBeNull();
  await act(async () => owner.build()); expect(calls("start_locale_build")).toHaveLength(0);
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
  invoke.mockImplementation((command: string, args) => command === "export_release" ? Promise.resolve({ ...invalid, actionId: args.request.actionId }) : original(command, args));
  await act(async () => owner.exportFiles());
  expect(owner.pending?.kind).toBe("export"); expect(owner.result).toBeNull(); expect(owner.failure).toBe("outcome-unknown");
  expect(owner.preview).toBeNull(); expect(owner.overwrite).toBe(false); expect(calls("export_release")).toHaveLength(1);
});

it("uses an explicit recovery lease only for lookup and cannot infer original absence from another folder", async () => {
  const view = mount(); await destination();
  const original = invoke.getMockImplementation()!, recoverySelection = { ...selection, selectionId: fixtureIdentity(720) };
  invoke.mockImplementation((command: string, args) => command === "export_release" ? Promise.reject(new Error("Lost export"))
    : command === "choose_delivery_folder" ? Promise.resolve(recoverySelection)
    : command === "read_delivery_action" ? Promise.resolve(null) : original(command, args));
  await act(async () => owner.exportFiles());
  const request = payloads<ExportRequest>("export_release")[0]; view.rerender(null); view.rerender(<Probe/>);
  await act(async () => owner.chooseFolder(true)); await act(async () => owner.checkExport());
  expect(owner.pending?.kind === "export" && owner.pending.request).toEqual(request);
  expect(owner.exportMissing).toBe(false); expect(owner.reserved()).toBe(true);
  expect(payloads<{selectionId: string}>("read_delivery_action")[0].selectionId).toBe(recoverySelection.selectionId);
  expect(calls("export_release")).toHaveLength(1); expect(calls("preview_delivery")).toHaveLength(1);
});

it("recovers the complete original export receipt after explicit directory reauthorization without sending files again", async () => {
  mount(); await destination();
  const original = invoke.getMockImplementation()!, recoverySelection = { selectionId: fixtureIdentity(720), folderName: "another label" };
  invoke.mockImplementation((command: string, args) => command === "export_release" ? Promise.reject(new Error("Lost export"))
    : command === "choose_delivery_folder" ? Promise.resolve(recoverySelection) : original(command, args));
  await act(async () => owner.exportFiles()); await act(async () => owner.chooseFolder(true)); await act(async () => owner.checkExport());
  expect(owner.pending).toBeNull(); expect(owner.result?.files).toEqual(delivery.files); expect(owner.result?.state).toBe("partial");
  expect(calls("export_release")).toHaveLength(1); expect(calls("preview_delivery")).toHaveLength(1);
});

it("retains a reconcile receipt on a lost ACK and refuses later receipts that rewrite terminal files", async () => {
  const view = mount(); await destination();
  const unresolved: DeliveryView = { ...delivery, state: "unknown", files: [delivery.files[0], { ...delivery.files[1], state: "unknown" }] };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "reconcile_delivery" ? Promise.reject(new Error("Lost check"))
    : command === "read_delivery_action" ? Promise.resolve({ ...unresolved, files: [{ ...unresolved.files[0], actualSha256: null, state: "unknown" }, unresolved.files[1]] }) : original(command, args));
  await act(async () => owner.reconcile(unresolved)); view.rerender(null); view.rerender(<Probe/>);
  expect(owner.pending?.kind).toBe("reconcile");
  await act(async () => owner.checkExport());
  expect(owner.pending?.kind).toBe("reconcile"); expect(owner.result).toBeNull(); expect(owner.failure).toBe("outcome-unknown");
  expect(calls("reconcile_delivery")).toHaveLength(1); expect(calls("export_release")).toHaveLength(0);
});

it("retains an unresolved valid delivery until reconciliation completes while the consumer is absent", async () => {
  const view = mount(); await destination();
  const original = invoke.getMockImplementation()!, completion = deferred<DeliveryView>();
  const unknown = { ...delivery, state: "unknown", files: delivery.files.map(file => ({ ...file, state: "unknown", actualSha256: null })) };
  invoke.mockImplementation((command: string, args) => command === "export_release" ? Promise.resolve({ ...unknown, actionId: args.request.actionId })
    : command === "reconcile_delivery" ? completion.promise : original(command, args));
  await act(async () => owner.exportFiles()); expect(owner.pending?.kind).toBe("export");
  let running!: Promise<void>;
  act(() => { running = owner.reconcile(owner.result!); }); view.rerender(null);
  await act(async () => { completion.resolve({ ...delivery, actionId: releaseFixture.requests.build.attemptId }); await running; });
  view.rerender(<Probe/>);
  expect(owner.pending).toBeNull(); expect(owner.result?.state).toBe("partial"); expect(calls("export_release")).toHaveLength(1);
});

it("stops dispatch after owner destruction before identity returns", async () => {
  const view = mount(); await prepare();
  const original = invoke.getMockImplementation()!, identity = deferred<string>();
  invoke.mockImplementation((command: string, args) => command === "create_execution_identity" ? identity.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.build(); });
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1)); view.unmount();
  await act(async () => { identity.resolve(releaseFixture.requests.build.attemptId); await running; });
  expect(calls("start_locale_build")).toHaveLength(0);
});

it("does not cancel a dispatched native export or apply its late receipt to another owner", async () => {
  const view = mount(); await destination();
  const original = invoke.getMockImplementation()!, exported = deferred<DeliveryView>();
  invoke.mockImplementation((command: string, args) => command === "export_release" ? exported.promise : original(command, args));
  let running!: Promise<void>;
  act(() => { running = owner.exportFiles(); }); await waitFor(() => expect(calls("export_release")).toHaveLength(1));
  expect(calls("export_release")).toHaveLength(1);
  view.rerender(<Probe/>, { ...project, sessionToken: "new-owner" });
  await act(async () => { exported.resolve({ ...delivery, actionId: releaseFixture.requests.build.attemptId }); await running; });
  expect(owner.result).toBeNull(); expect(owner.chosen).toBeNull(); expect(owner.pending).toBeNull();
  expect(calls("export_release")).toHaveLength(1); expect(invoke.mock.calls.some(([command]) => command.includes("cancel"))).toBe(false);
});

it("releases an accepted read proof immediately on owner destruction and only once when identity later returns", async () => {
  const view=mount();await prepare();const identity=deferred<string>(),original=invoke.getMockImplementation()!,dispose=vi.fn();
  invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:original(command,args));
  let running!:Promise<void>;act(()=>{running=owner.build({current:()=>true,dispose});});
  await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(1));view.unmount();expect(dispose).toHaveBeenCalledTimes(1);
  await act(async()=>{identity.resolve(releaseFixture.requests.build.attemptId);await running;});
  expect(dispose).toHaveBeenCalledTimes(1);expect(calls("start_locale_build")).toHaveLength(0);
});
