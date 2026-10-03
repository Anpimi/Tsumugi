import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReleaseWorkbench } from "./ReleaseWorkbench";
import type { ProjectView } from "./projectCommands";
import type { DeliveryView } from "./releaseCommands";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourceIntegrationFixture, captionIntegrationFixture } from "./testSupport/sourceFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = {
  sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled",
  metadata: { projectId: "project", displayName: "Demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" },
};
const release = { releaseId: "release", actionId: "action", attemptId: "attempt", sourceSnapshotId: "snapshot",
  policyVersion: "balanced-1", eligibilityBasis: "basis", manifestSha256: "manifest-hash",
  builderVersion: "builder-1", validatorVersion: "validator-1", sourceFiles: [], exceptions: [],
  createdAt: "2026-09-29T00:00:00Z",
  artifacts: [{ locale: "zh-CN", fileName: "i18n/zh.json", sha256: "hash", entryCount: 532 }] };
let releases: typeof release[];
let deliveryRows: DeliveryView[];
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  releases = [];
  deliveryRows = [];
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "list_releases") return releases;
    if (command === "read_source_integration") return sourceIntegrationFixture;
    if (command === "read_review_eligibility") return { policyVersion: "balanced-1", sourceSnapshotId: "snapshot", basis: "basis", ready: true,
      locales: [{ locale: "zh-CN", ready: true, blockers: [], exceptions: [], checkedUnits: 532, blockerCount: 0, exceptionCount: 0 }] };
    if (command === "create_execution_identity") return fixtureIdentity(1);
    if (command === "start_locale_build") return "action-id";
    if (command === "choose_delivery_folder") return { selectionId: "folder", folderName: "export" };
    if (command === "preview_delivery") return { previewId: "preview", releaseId: "release", selectionId: "folder", folderName: "export",
      files: [{ locale: "zh-CN", fileName: "i18n/zh.json", expectedSha256: "hash", currentSha256: "old", state: "conflict" }] };
    if (command === "list_deliveries") return deliveryRows;
    if (command === "reconcile_delivery") return { ...deliveryRows[0], state: "succeeded" };
    if (command === "export_release") return { deliveryId: "delivery", actionId: "action-id", releaseId: "release", directory: "C:\\isolated\\export",
      overwriteConflicts: true,
      state: "succeeded", files: [{ locale: "zh-CN", fileName: "i18n/zh.json", expectedSha256: "hash", actualSha256: "hash", state: "succeeded" }], createdAt: "today" };
    throw new Error(command);
  });
});
afterEach(cleanup);
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
  expect(await screen.findByText(i18n.t("release.webvttDestination", { name: "export" }))).toBeInTheDocument();
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
    sessionToken: "session", projectId: "project", attemptId: fixtureIdentity(1), expectedEligibilityBasis: "basis",
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
    sessionToken: "session", projectId: "project", attemptId: fixtureIdentity(1), expectedEligibilityBasis: "basis",
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
    sessionToken: "session", projectId: "project", releaseId: "release", selectionId: "folder",
    previewId: "preview", actionId: fixtureIdentity(1), overwriteConflicts: true,
  } }));
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
  deliveryRows = [{ deliveryId: "delivery", actionId: "uncertain-action", releaseId: "release",
    directory: "C:\\isolated\\export", overwriteConflicts: false, state: "unknown", createdAt: "today",
    files: [{ locale: "zh-CN", fileName: "i18n/zh.json", expectedSha256: "hash", actualSha256: null, state: "unknown" }] }];
  const user = userEvent.setup();
  render(<ReleaseWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Build and export" }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  await user.click(screen.getByRole("button", { name: "Choose export folder" }));
  await user.click(await screen.findByRole("button", { name: "Check these files against the selected folder" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("reconcile_delivery", { request: {
    sessionToken: "session", projectId: "project", actionId: "uncertain-action", selectionId: "folder",
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
  await act(async () => resolvePicker({ selectionId: "old-folder", folderName: "old-export" }));
  await user.click(screen.getByRole("button", { name: "Build and export" }));
  await user.click(await screen.findByRole("button", { name: /2026-09-29/ }));
  expect(screen.queryByText(/old-export/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check destination" })).not.toBeInTheDocument();
});
