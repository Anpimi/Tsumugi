import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { SessionReads } from "../sessionReads";
import { sourceCommands } from "../sourceCommands";
import { reviewCommands, type ReviewSummaryPage } from "../reviewCommands";
import type { ProjectView } from "../projectCommands";
import WorkbenchApp from "./WorkbenchApp";
import { ProjectLifecycle } from "./platform/projectLifecycle";

vi.mock("./platform/useProjectLifecycle", async original => ({ ...await original<object>(), useNativeProjectClose: () => ({ state: "ready" }) }));

const project: ProjectView = { locator: "/synthetic/project", sessionToken: "session", reconciliationState: "settled", metadata: { projectId: "project", metadataRevision: "1", displayName: "Synthetic project", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const page: ReviewSummaryPage = { scopeId: "scope", sourceSnapshotId: "snapshot", readVersion: "1", total: 1, nextOrdinal: null, rows: [{ unitId: "unit", locale: "zh-CN", sourceSnapshotId: "snapshot", sourceRevisionId: "source", nativeKey: "dialogue.hello", sourcePreview: "Actual source from the read port", translationPreview: "从读取接口返回的译文", selectionId: "selection", revisionId: "revision", basis: "basis", currentCheck: null, currentDecision: null }] };
let controller: ProjectLifecycle;
beforeEach(async () => {
  localStorage.clear(); history.replaceState(null, "", "/");
  await i18n.changeLanguage("zh-CN");
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ currentSnapshot: "snapshot", revision: "1" });
  vi.spyOn(reviewCommands, "summaryPage").mockResolvedValue(page);
  vi.spyOn(SessionReads.prototype, "start").mockReturnValue(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => { controller?.dispose(); });

describe("real-port workspace assembly", () => {
  it("opens through the project controller and keeps search input separate in two views sharing entry facts", async () => {
    const open = vi.fn().mockResolvedValue(project);
    controller = new ProjectLifecycle({ open });
    render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
    fireEvent.change(screen.getByRole("textbox", { name: "项目文件夹" }), { target: { value: project.locator } });
    fireEvent.click(screen.getByRole("button", { name: "打开项目" }));
    expect(await screen.findByText("Actual source from the read port")).toBeVisible();
    expect(open).toHaveBeenCalledWith({ locator: project.locator });
    const search = screen.getByRole("textbox", { name: "查找条目" });
    fireEvent.change(search, { target: { value: "unsent view A search" } });
    await waitFor(() => expect(controller.getSnapshot().phase).toBe("idle"), { timeout: 3000 });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "新建条目视图" })).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("button", { name: "新建条目视图" })).toBeEnabled();
    }, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "新建条目视图" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "查找条目" })).toHaveValue(""));
    const tabs = within(screen.getByRole("navigation", { name: "工作视图" })).getAllByRole("button", { name: "条目 · zh-CN" });
    expect(tabs).toHaveLength(2); fireEvent.click(tabs[0]);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "查找条目" })).toHaveValue("unsent view A search"));
    expect(reviewCommands.summaryPage).toHaveBeenCalledTimes(1);
  });

  it("settles an open acknowledgement while keeping a folder typed during the request", async () => {
    let resolve!: (value: ProjectView) => void;
    const open = vi.fn().mockImplementation(() => new Promise<ProjectView>(done => { resolve = done; }));
    controller = new ProjectLifecycle({ open });
    render(<WorkbenchApp controller={controller} native />);
    const input = screen.getByRole("textbox", { name: "项目文件夹" });
    fireEvent.change(input, { target: { value: project.locator } }); fireEvent.click(screen.getByRole("button", { name: "打开项目" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "/synthetic/newer-folder" } });
    await act(async () => resolve(project));
    const dialog = await screen.findByRole("dialog", { name: "打开项目" });
    expect(within(dialog).getByRole("textbox", { name: "项目文件夹" })).toHaveValue("/synthetic/newer-folder");
    expect(controller.getSnapshot().session?.project).toEqual(project);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
