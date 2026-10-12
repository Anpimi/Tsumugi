import { refreshWorkbenchReads, renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReleaseWorkbench } from "./ReleaseWorkbench";
import type { ProjectView } from "./projectCommands";
import type { DeliveryView, ReleaseView } from "./releaseCommands";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourceIntegrationFixture, captionIntegrationFixture } from "./testSupport/sourceFixture";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
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
  invoke.mockImplementation(async (command: string) => {
    if (command === "list_releases") return releases;
    if (command === "read_source_integration") return sourceIntegrationFixture;
    if (command === "read_content_scope") return { currentSnapshot: fixtureIdentity(707), revision: "1" };
    if (command === "read_review_eligibility") return { policyVersion: "balanced-1", sourceSnapshotId: fixtureIdentity(707), basis: "basis", ready: true,
      locales: [{ locale: "zh-CN", ready: true, blockers: [], exceptions: [], checkedUnits: 532, blockerCount: 0, exceptionCount: 0 }] };
    if (command === "create_execution_identity") return fixtureIdentity(1);
    if (command === "start_locale_build") return fixtureIdentity(1);
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

async function readyBuild() {
  const user = userEvent.setup();
  const ref = createRef<ReleaseHandle>();
  const view = render(<ReleaseWorkbench ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  await user.click(screen.getByRole("button", { name: i18n.t("release.check") }));
  await screen.findByText(i18n.t("release.ready", { count: 0 }));
  return { user, ref, view };
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

const savedBuild = { ...executionFixture.detail, attemptId: fixtureIdentity(1), operation: "locale-build",
  recovery: { ...executionFixture.detail.recovery, attemptId: fixtureIdentity(1) } };

it.each(["en-US", "zh-CN"])("checks the original build after an unrelated ACK without submitting another attempt in %s", async locale => {
  await i18n.changeLanguage(locale);
  const { user, ref } = await readyBuild();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "start_locale_build" ? Promise.resolve(fixtureIdentity(799))
    : command === "read_locale_build_attempt" ? Promise.resolve(savedBuild) : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("release.build") }));
  await screen.findByText(i18n.t("release.buildUnknown"));
  expect(await ref.current!.allowLeave()).toBe(false);
  expect(screen.getByRole("button", { name: i18n.t("workbench.backOverview") })).toBeEnabled();
  expect(await ref.current!.allowNavigate()).toBe(true);
  await user.click(screen.getByRole("button", { name: i18n.t("release.checkBuild") }));
  await screen.findByText(i18n.t("release.started", { id: fixtureIdentity(1) }));
  expect(await ref.current!.allowLeave()).toBe(true);
  expect(invoke.mock.calls.filter(([c]) => c === "start_locale_build")).toHaveLength(1);
  const start = invoke.mock.calls.find(([c]) => c === "start_locale_build")![1];
  expect(invoke.mock.calls.find(([c]) => c === "read_locale_build_attempt")![1]).toEqual(start);
});

it("offers a same-build retry only after a successful lookup proves absence", async () => {
  const { user } = await readyBuild();
  const original = invoke.getMockImplementation()!;
  let starts = 0, reads = 0;
  invoke.mockImplementation((command: string, args: unknown) => command === "start_locale_build" && ++starts === 1 ? Promise.reject({ code: "outcome-unknown" })
    : command === "read_locale_build_attempt" ? ++reads === 1 ? Promise.reject({ code: "storage-failed" }) : Promise.resolve(null) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Start build" }));
  await user.click(await screen.findByRole("button", { name: "Check saved build task" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([c]) => c === "read_locale_build_attempt")).toHaveLength(1));
  expect(screen.queryByRole("button", { name: "Retry the same build" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Check saved build task" }));
  await user.click(await screen.findByRole("button", { name: "Retry the same build" }));
  await screen.findByText(i18n.t("release.started", { id: fixtureIdentity(1) }));
  const calls = invoke.mock.calls.filter(([c]) => c === "start_locale_build");
  expect(calls).toHaveLength(2); expect(calls[1][1]).toEqual(calls[0][1]);
  expect(invoke.mock.calls.filter(([c]) => c === "create_execution_identity")).toHaveLength(1);
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
it.each(["en-US", "zh-CN"])("describes root caption delivery in %s", async locale => {
  await i18n.changeLanguage(locale);
  releases = [{ ...release, artifacts: [{ locale: "zh-CN", fileName: "zh-CN.vtt", sha256: "hash", entryCount: 2 }] }];
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string) => command === "read_source_integration" ? Promise.resolve(captionIntegrationFixture) : original(command));
  const user = userEvent.setup();
  render(<ReleaseWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: i18n.t("release.title") }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  await user.click(screen.getByRole("button", { name: i18n.t("release.chooseFolder") }));
  expect(await screen.findByText(i18n.t("release.savedDestination", { name: "export" }))).toBeInTheDocument();
  expect(screen.getByText(/zh-CN → zh-CN.vtt/)).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("release.destination", { name: "export" }))).not.toBeInTheDocument();
});

it("routes WebVTT builds to a root subtitle filename and preserves an edited mapping", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string) => command === "read_source_integration" ? Promise.resolve(captionIntegrationFixture) : original(command));
  const user = userEvent.setup();
  render(<ReleaseWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Build and export" }));
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  const name = await screen.findByRole("textbox", { name: "Subtitle file name for zh-CN" });
  expect(name).toHaveValue("zh-CN.vtt");
  await user.clear(name);
  await user.type(name, "captions-zh.vtt");
  await user.click(screen.getByRole("button", { name: "Check build readiness" }));
  await screen.findByText(/Ready to build/);
  await user.click(screen.getByRole("button", { name: "Start build" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_locale_build", { request: {
    sessionToken: "session", projectId: fixtureIdentity(700), attemptId: fixtureIdentity(1), expectedEligibilityBasis: "basis",
    choices: [{ locale: "zh-CN", fileName: "captions-zh.vtt" }],
  } }));
});

it("sends the explicit locale mapping and current eligibility basis to the native build boundary", async () => {
  const user = userEvent.setup();
  render(<ReleaseWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Build and export" }));
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  expect(screen.getByRole("textbox", { name: "SMAPI file name for zh-CN" })).toHaveValue("zh.json");
  await user.click(screen.getByRole("button", { name: "Check build readiness" }));
  await screen.findByText(/Ready to build/);
  await user.click(screen.getByRole("button", { name: "Start build" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_locale_build", { request: {
    sessionToken: "session", projectId: fixtureIdentity(700), attemptId: fixtureIdentity(1), expectedEligibilityBasis: "basis",
    choices: [{ locale: "zh-CN", fileName: "i18n/zh.json" }],
  } }));
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
  invoke.mockImplementation(async (command: string) => {
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
  let finish!: (id: string) => void;
  invoke.mockImplementation((command: string, args: unknown) => command === "start_locale_build" ? new Promise<string>(resolve => { finish = resolve; }) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Start build" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "start_locale_build")).toHaveLength(1));
  const name = screen.getByRole("textbox", { name: "SMAPI file name for zh-CN" });
  await user.clear(name); await user.type(name, "newer.json");
  view.rerender(null);
  await act(async () => finish(fixtureIdentity(1)));
  view.rerender(<ReleaseWorkbench ref={ref} project={project} disabled={false}/>);
  expect(screen.getByRole("textbox", { name: "SMAPI file name for zh-CN" })).toHaveValue("newer.json");
  expect(await screen.findByText(i18n.t("release.earlierBuild"))).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start build" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([command]) => command === "start_locale_build")).toHaveLength(1);
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
  expect(screen.getByRole("textbox", { name: "SMAPI file name for zh-CN" })).toHaveValue("zh.json");
  expect(screen.getByRole("button", { name: "Start build" })).toBeDisabled();
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
