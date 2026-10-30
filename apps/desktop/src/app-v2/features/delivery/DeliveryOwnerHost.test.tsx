import { Button } from "../../../design-system/Button";
import { useCallback, useLayoutEffect, useState } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import releaseFixture from "../../../../test/fixtures/releaseCommands.contract.json";
import executionFixture from "../../../../test/fixtures/executionCommands.contract.json";
import { ReleaseDraftHandleProvider, useReleaseDraftSession } from "../../../ReleaseDraftSession";
import { executionCommands, type ApplicationShutdownView, type AttemptDetail } from "../../../executionCommands";
import { validateResponseAttempt } from "../../../generated/execution.validators";
import { validateResponseDelivery, validateResponsePluginBuild, validateResponsePreview, validateResponseReleases, validateResponseSelection } from "../../../generated/release.validators";
import { i18n } from "../../../i18n";
import { pluginCommands } from "../../../pluginCommands";
import type { ProjectView } from "../../../projectCommands";
import { releaseCommands, type DeliveryPreview, type DeliverySelection, type DeliveryView, type ReleaseView } from "../../../releaseCommands";
import { reviewCommands } from "../../../reviewCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { sourceCommands } from "../../../sourceCommands";
import { artifactWorkflowObservation, artifactWorkflowView } from "../../../testSupport/artifactWorkflowFixture";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { pluginBuildRequest, pluginBuildView, pluginBuildWorkflow } from "../../../testSupport/pluginBuildFixture";
import { ProjectLifecycle, type LeaveIntent, type LifecycleParticipant } from "../../platform/projectLifecycle";
import { InteractionGate } from "../../workspace/interactionGate";
import DeliveryOwnerHost from "./DeliveryOwnerHost";
import type { DeliveryOwnerHandle } from "./deliveryTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: releaseFixture.requests.session.sessionToken, locator: "/synthetic/delivery-owner", reconciliationState: "settled",
  metadata: { projectId: releaseFixture.requests.session.projectId, displayName: "Synthetic delivery", sourceLocale: "en", targetLocales: ["zh-CN", "fr-FR"], metadataRevision: "1" } };
let savedRelease: ReleaseView, destination: DeliverySelection, destinationPreview: DeliveryPreview, savedDelivery: DeliveryView, serial: number;
function checked<T>(value: unknown, valid: (input: unknown) => input is T): T {
  if (!valid(value)) throw new Error("Invalid synthetic delivery contract fixture");
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  vi.restoreAllMocks(); await i18n.changeLanguage("en-US"); serial = 9800;
  const releases = checked(structuredClone(releaseFixture.responses.releases), validateResponseReleases);
  if (!releases[0]) throw new Error("Expected a saved release fixture");
  savedRelease = releases[0]; const selected = checked(structuredClone(releaseFixture.responses.selection), validateResponseSelection);
  if (!selected) throw new Error("Expected a synthetic destination"); destination = selected;
  destinationPreview = checked(structuredClone(releaseFixture.responses.preview), validateResponsePreview);
  savedDelivery = checked(structuredClone(releaseFixture.responses.delivery), validateResponseDelivery);
  invoke.mockReset().mockRejectedValue(new Error("Unexpected synthetic native call"));
  vi.spyOn(releaseCommands, "releases").mockResolvedValue([]);
  vi.spyOn(releaseCommands, "deliveries").mockResolvedValue([]);
  vi.spyOn(releaseCommands, "cancelPluginPreparation").mockResolvedValue(false);
  vi.spyOn(releaseCommands, "choose").mockResolvedValue(destination);
  vi.spyOn(releaseCommands, "preview").mockResolvedValue(destinationPreview);
  vi.spyOn(releaseCommands, "export").mockRejectedValue(new Error("Lost synthetic export acknowledgement"));
  vi.spyOn(releaseCommands, "deliveryAction").mockRejectedValue(new Error("Synthetic export lookup unavailable"));
  vi.spyOn(executionCommands, "identity").mockImplementation(async () => fixtureIdentity(serial++));
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ revision: "1", currentSnapshot: savedRelease.sourceSnapshotId });
  vi.spyOn(reviewCommands, "eligibility").mockImplementation(async request => ({ policyVersion: savedRelease.policyVersion,
    sourceSnapshotId: savedRelease.sourceSnapshotId, epoch: fixtureIdentity(1), sequence: "1", basis: savedRelease.eligibilityBasis, ready: true,
    locales: request.locales.map(locale => ({ locale, ready: true, blockers: [], exceptions: [], checkedUnits: 2, selectedUnits: 2, blockingUnits: 0, blockerCount: 0, exceptionCount: 0 })) }));
  vi.spyOn(pluginCommands, "build").mockResolvedValue(pluginBuildView);
  vi.spyOn(releaseCommands, "preparePlugin").mockImplementation(async request => checked({ ...pluginBuildWorkflow.review,
    attemptId: request.attemptId, choices: request.choices, eligibilityBasis: request.expectedEligibilityBasis, sourceSnapshotId: savedRelease.sourceSnapshotId }, validateResponsePluginBuild));
  vi.spyOn(releaseCommands, "startPlugin").mockImplementation(async request => request.attemptId);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function harness(publishParticipant = false) {
  const ports = { open: vi.fn(async () => project), close: vi.fn(async () => ({ closed: true })),
    status: vi.fn(async () => ({ active: false, quiescing: false, queryCount: 0, error: null })),
    stopCleanup: vi.fn(async (request: { actionId: string }): Promise<ApplicationShutdownView> => ({ ...request, state: "stopped" })) };
  const lifecycle = new ProjectLifecycle(ports); expect(await lifecycle.open(project.locator)).toBe(true);
  const session = lifecycle.getSnapshot().session; if (!session) throw new Error("Expected a synthetic project session");
  const gate = new InteractionGate(); gate.setVisibleOwner("synthetic-delivery-view");
  let observed: DeliveryOwnerHandle | null = null, borrowed: DeliveryOwnerHandle | null = null, participant: LifecycleParticipant | null = null;
  const publications = vi.fn(), publishedParticipant = vi.fn((value: LifecycleParticipant | null) => { participant = value; });
  const reveal = vi.fn(), register = vi.spyOn(lifecycle, "register");
  function Consumer() {
    const value = useReleaseDraftSession(); useLayoutEffect(() => { borrowed = value; });
    return <p>{value.names["zh-CN"] ?? ""}</p>;
  }
  function Harness({ consumer = true, marker = "" }: { consumer?: boolean; marker?: string }) {
    const [owner, setOwner] = useState<DeliveryOwnerHandle | null>(null);
    const onOwner = useCallback((value: DeliveryOwnerHandle | null) => { observed = value; publications(value); setOwner(value); }, []);
    if (!session) throw new Error("Expected a synthetic project session");
    return <SessionReadProvider context={session.reads.context} reads={session.reads} bridge={false}>
      <Button type="button">{marker || "Synthetic return target"}</Button>
      <DeliveryOwnerHost project={project} lifecycle={lifecycle} gate={gate} onOwner={onOwner}
        onParticipant={publishParticipant ? publishedParticipant : undefined} onReveal={reveal}/>
      {consumer && owner ? <ReleaseDraftHandleProvider value={owner}><Consumer/></ReleaseDraftHandleProvider> : null}
    </SessionReadProvider>;
  }
  const view = render(<Harness/>);
  await waitFor(() => expect(observed).not.toBeNull());
  const registration = () => {
    const value = publishParticipant ? participant : register.mock.calls.find(([entry]) => entry.id === "delivery-release")?.[0];
    if (!value) throw new Error("Expected delivery lifecycle participant"); return value;
  };
  return { ports, lifecycle, session, gate, publications, publishedParticipant, reveal, register, view, participant: registration,
    owner: () => { if (!observed) throw new Error("Expected original release owner"); return observed; },
    borrowed: () => borrowed,
    show: (consumer: boolean, marker = "") => view.rerender(<Harness consumer={consumer} marker={marker}/>) };
}
function editPreparation(owner: DeliveryOwnerHandle) {
  owner.setLanguage("zh-CN", true); owner.setName("zh-CN", "i18n/zh.json");
}
async function requestLeave(h: Awaited<ReturnType<typeof harness>>, intent: LeaveIntent = { kind: "close-project" }) {
  const before = h.owner().current(); let completion!: Promise<boolean>;
  act(() => { completion = h.participant().prepareLeave(intent, () => h.owner().current() === before, () => true); });
  return { completion };
}

it("keeps the same release owner and draft across view hiding and parent rerenders without reading history or publishing unchanged snapshots", async () => {
  const h = await harness();
  expect(h.borrowed()?.current()).toBe(h.owner().current());
  const initial = h.owner().current(), count = h.publications.mock.calls.length;
  h.show(false, "Another view"); h.show(true, "Returned view");
  expect(h.owner().current()).toBe(initial); expect(h.publications).toHaveBeenCalledTimes(count);
  act(() => editPreparation(h.owner()));
  const retained = h.owner().current(); h.show(false); h.show(true);
  expect(h.owner().current()).toBe(retained); expect(h.borrowed()?.current()).toBe(retained);
  const ordinary = ["navigate", "language", "close-view", "restore"] as const;
  for (const kind of ordinary) {
    expect(h.participant().inspect({ kind })).toEqual({ status: "ready", revision: "retained-delivery-session" });
    expect(await h.participant().prepareLeave({ kind }, () => true, () => true)).toBe(true);
  }
  expect(h.participant().inspect({ kind: "close-window" }).status).toBe("dirty");
  expect(releaseCommands.releases).not.toHaveBeenCalled(); expect(releaseCommands.deliveries).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it.each([
  ["en-US", "Your file names and destination preparation are kept while moving between workspaces. Leaving this project discards that preparation. Saved builds and releases remain available."],
  ["zh-CN", "在工作区之间切换时会保留文件名和导出目录的准备内容。离开此项目会放弃这些准备；已保存的构建和发布仍然保留。"],
])("keeps preparation and restores focus when destructive leave is declined (%s)", async (language, disclosure) => {
  await i18n.changeLanguage(language); const h = await harness(), user = userEvent.setup();
  act(() => editPreparation(h.owner())); const before = h.owner().current();
  const trigger = screen.getByRole("button", { name: "Synthetic return target" }); trigger.focus();
  const { completion } = await requestLeave(h);
  const dialog = await screen.findByRole("dialog", { name: i18n.t("release.unsaved") });
  expect(within(dialog).getByText(disclosure)).toBeVisible(); expect(h.gate.getSnapshot().dialogs).toHaveLength(1);
  await user.click(within(dialog).getByRole("button", { name: i18n.t("release.stay") }));
  expect(await completion).toBe(false); expect(h.owner().current()).toBe(before);
  await waitFor(() => expect(trigger).toHaveFocus()); expect(h.gate.getSnapshot().dialogs).toHaveLength(0);
  expect(releaseCommands.cancelPluginPreparation).not.toHaveBeenCalled();
});

it("settles the real close-window guard only after explicit preparation discard and resets through the original owner", async () => {
  const h = await harness(), user = userEvent.setup(), destroy = vi.fn(async () => {});
  act(() => editPreparation(h.owner())); let closing!: Promise<boolean>;
  act(() => { closing = h.lifecycle.closeWindow(destroy); });
  const dialog = await screen.findByRole("dialog", { name: i18n.t("release.unsaved") });
  expect(destroy).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: i18n.t("release.discard") }));
  let allowed = false; await act(async () => { allowed = await closing; });
  expect(allowed).toBe(true); expect(destroy).toHaveBeenCalledTimes(1); expect(h.ports.close).toHaveBeenCalledTimes(1);
  expect(releaseCommands.cancelPluginPreparation).toHaveBeenCalledTimes(1); expect(releaseCommands.cancelPluginPreparation).toHaveBeenCalledWith(sessionRequest());
  expect(h.owner().current().names).toEqual({}); expect(h.owner().current().languages).toEqual([]);
  expect(executionCommands.identity).not.toHaveBeenCalled();
});
function sessionRequest() { return { projectId: project.metadata.projectId, sessionToken: project.sessionToken }; }

it("retains newer file names when the original preparation cancellation acknowledges late", async () => {
  const h = await harness(), user = userEvent.setup(), cancelled = deferred<boolean>();
  vi.mocked(releaseCommands.cancelPluginPreparation).mockReturnValueOnce(cancelled.promise);
  act(() => editPreparation(h.owner())); const { completion } = await requestLeave(h);
  const dialog = await screen.findByRole("dialog", { name: i18n.t("release.unsaved") });
  await user.click(within(dialog).getByRole("button", { name: i18n.t("release.discard") }));
  await waitFor(() => expect(releaseCommands.cancelPluginPreparation).toHaveBeenCalledTimes(1));
  act(() => h.owner().setName("zh-CN", "newer/B.json"));
  await act(async () => { cancelled.resolve(true); expect(await completion).toBe(false); });
  expect(h.owner().current().names["zh-CN"]).toBe("newer/B.json"); expect(h.owner().current().buildDirty).toBe(true);
  expect(h.owner().current().languages).toEqual(["zh-CN"]); expect(h.participant().inspect({ kind: "close-window" }).status).toBe("dirty");
});

it("blocks an unknown export without cancelling or replaying it and keeps recovery in the same owner", async () => {
  const h = await harness(); act(() => h.owner().chooseRelease(savedRelease));
  await act(async () => { await h.owner().chooseFolder(); await h.owner().previewFolder(); });
  act(() => h.owner().setOverwrite(true)); await act(async () => { await h.owner().exportFiles(); });
  const pending = h.owner().current().pending;
  if (!pending || pending.kind !== "export") throw new Error("Expected the exact original unknown export");
  expect(h.participant().inspect({ kind: "close-window" }).status).toBe("blocked");
  expect(await h.participant().prepareLeave({ kind: "close-window" }, () => true, () => true)).toBe(false);
  expect(h.reveal).toHaveBeenCalled(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(h.owner().current().pending).toBe(pending); expect(releaseCommands.cancelPluginPreparation).not.toHaveBeenCalled();
  vi.mocked(releaseCommands.deliveryAction).mockResolvedValueOnce({ ...savedDelivery, actionId: pending.request.actionId, overwriteConflicts: pending.request.overwriteConflicts });
  await act(async () => { await h.owner().checkExport(); });
  expect(h.owner().current().pending).toBeNull(); expect(h.owner().current().result?.actionId).toBe(pending.request.actionId);
  expect(releaseCommands.export).toHaveBeenCalledTimes(1); expect(h.participant().inspect({ kind: "close-window" }).status).toBe("ready");
});

it("keeps artifact checks blocked until admission is closed and callbacks really drain", async () => {
  const h = await harness();
  act(() => { h.owner().setBuildSelection(pluginBuildRequest, "synthetic", pluginBuildRequest.environmentDigest); editPreparation(h.owner()); });
  await act(async () => { await h.owner().assess(pluginBuildView); await h.owner().build(); });
  act(() => h.owner().setConsent(false, true)); await act(async () => { await h.owner().startBuild(); });
  const preparation = h.owner().current().prepared;
  if (!preparation) throw new Error("Expected the real build preparation");
  const detail: AttemptDetail = checked({ ...executionFixture.detail, attemptId: preparation.review.attemptId, operation: "locale-build", nextOffset: null,
    progress: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
    items: [{ ...executionFixture.detail.items[0], resultId: fixtureIdentity(9901), scope: { kind: "release-build", id: savedRelease.sourceSnapshotId, locale: "zh-CN" },
      status: { ...executionFixture.detail.items[0].status, execution: "succeeded", cancellationRequested: false } }],
    recovery: { attemptId: preparation.review.attemptId, units: [] } }, validateResponseAttempt);
  vi.spyOn(releaseCommands, "workflowSession").mockResolvedValue({ kind: "available", ownerId: fixtureIdentity(9902), nextGeneration: "1", current: null });
  vi.spyOn(releaseCommands, "prepareWorkflow").mockImplementation(async request => artifactWorkflowView(request.preparation));
  await act(async () => { await h.owner().prepareWorkflow(detail); });
  expect(h.owner().current().workflow).not.toBeNull(); expect(h.participant().inspect({ kind: "close-window" }).status).toBe("blocked");
  vi.spyOn(releaseCommands, "stopWorkflow").mockImplementation(async request => ({ identity: request.identity, admissionClosed: true, callbacksDrained: false, currentTask: null }));
  await act(async () => { await h.owner().stopWorkflow(); });
  expect(h.participant().inspect({ kind: "close-window" }).status).toBe("blocked");
  const workflow = h.owner().current().workflow, request = h.owner().workflowReadRequest();
  if (!workflow?.review || !request) throw new Error("Expected the retained workflow and original read");
  const closed = structuredClone(workflow.review); closed.phase = "stopped"; closed.admissionClosed = true; closed.callbacksDrained = true;
  act(() => h.owner().observeWorkflow(request, artifactWorkflowObservation(closed)));
  expect(h.participant().inspect({ kind: "close-window" }).status).toBe("dirty");
  expect(releaseCommands.stopWorkflow).toHaveBeenCalledTimes(1);
});

it("publishes a participant for a stable project registration and releases both handles on unmount", async () => {
  const h = await harness(true);
  expect(h.register).not.toHaveBeenCalled(); expect(h.participant().scope).toEqual({ kind: "project", ...sessionRequest() });
  h.view.unmount();
  expect(h.publishedParticipant).toHaveBeenLastCalledWith(null); expect(h.publications).toHaveBeenLastCalledWith(null);
});
