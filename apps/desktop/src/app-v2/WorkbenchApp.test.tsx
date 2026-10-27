import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { SessionReads } from "../sessionReads";
import { sourceCommands } from "../sourceCommands";
import { segmentCommands, type SegmentPage } from "../segmentCommands";
import type { ProjectView } from "../projectCommands";
import WorkbenchApp from "./WorkbenchApp";
import { ProjectLifecycle } from "./platform/projectLifecycle";

vi.mock("./platform/useProjectLifecycle", async original => ({ ...await original<object>(), useNativeProjectClose: () => ({ state: "ready" }) }));

const project: ProjectView = { locator: "/synthetic/project", sessionToken: "session", reconciliationState: "settled", metadata: { projectId: "project", metadataRevision: "1", displayName: "Synthetic project", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const emptyChecks = { passed: 0, findings: 0, missing: 0, unavailable: 0, failed: 0, cancelled: 0, unknown: 0, notApplicable: 0, findingCount: 0 };
const page: SegmentPage = {
  projectId: "project", locale: "zh-CN", query: { text: "", selection: "all" }, queryFingerprint: "fingerprint", epoch: "epoch", sequence: "1",
  scopeId: "scope", sourceSnapshotId: "snapshot", readVersion: "1", total: 1, nextCursor: null,
  rows: [{
    sourceTruncated: false, translationTruncated: false,
    content: { unitId: "unit", locale: "zh-CN", sourceSnapshotId: "snapshot", sourceRevisionId: "source", nativeKey: "dialogue.hello", sourcePreview: "Actual source from the read port", translationPreview: "从读取接口返回的译文", selectionId: "selection", revisionId: "revision", basis: "basis", currentCheck: null, currentDecision: null },
    candidateCount: 0, protection: { unitId: "unit", locale: "zh-CN", revision: "0", protected: false },
    qa: { current: false, outcome: null, mandatoryCoverageComplete: null, mandatory: emptyChecks, advisory: { ...emptyChecks } },
    terms: { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false },
    applicability: { selectedSourceRevisionId: "source", sourceBasisCurrent: true, capturedBasisCurrent: true, resourceImpact: null, resourceReviewRequired: false },
    qualification: { blockerCount: 2, exceptionCount: 0, blockers: [{ code: "approval-missing-or-stale", reference: null }, { code: "qa-missing-or-stale", reference: null }], exceptions: [], truncated: false },
  }],
};
let controller: ProjectLifecycle;
beforeEach(async () => {
  localStorage.clear(); history.replaceState(null, "", "/");
  await i18n.changeLanguage("zh-CN");
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ currentSnapshot: "snapshot", revision: "1" });
  vi.spyOn(segmentCommands, "page").mockResolvedValue(page);
  vi.spyOn(SessionReads.prototype, "start").mockReturnValue(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => { cleanup(); controller?.dispose(); });

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
    expect(segmentCommands.page).toHaveBeenCalledTimes(1);
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

  it("uses the original page cursor and starts a fresh scope when the selection filter changes", async () => {
    const read = vi.mocked(segmentCommands.page).mockImplementation(async request => {
      if (request.query.selection === "unselected") return { ...page, query: request.query, scopeId: "unselected-scope", total: 0, rows: [] };
      return request.cursor ? { ...page, total: 2, rows: [{ ...page.rows[0], protection: { ...page.rows[0].protection, unitId: "unit-two" }, content: { ...page.rows[0].content, unitId: "unit-two", sourcePreview: "Second page source" } }] }
        : { ...page, total: 2, nextCursor: "opaque-next" };
    });
    controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(project) });
    render(<WorkbenchApp controller={controller} native />);
    fireEvent.change(screen.getByRole("textbox", { name: "项目文件夹" }), { target: { value: project.locator } });
    fireEvent.click(screen.getByRole("button", { name: "打开项目" }));
    fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByText("Second page source")).toBeVisible();
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ scopeId: "scope", cursor: "opaque-next" }));
    const filter = screen.getByRole("button", { name: "全部条目" });
    await waitFor(() => expect(filter).toBeEnabled());
    filter.focus(); fireEvent.keyDown(filter, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "尚未选用译文" }));
    expect(await screen.findByText("没有匹配的条目")).toBeVisible();
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ query: { text: "", selection: "unselected" }, scopeId: null, cursor: null }));
    expect(read.mock.calls.filter(([request]) => request.query.selection === "unselected").every(([request]) => request.scopeId !== "scope")).toBe(true);
    expect(screen.queryByRole("button", { name: "回到首页" })).not.toBeInTheDocument();
  });
});
