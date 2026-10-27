import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { SessionReads } from "../sessionReads";
import { sourceCommands } from "../sourceCommands";
import { segmentCommands, type SegmentPage } from "../segmentCommands";
import { draftCommands } from "../draftCommands";
import { translationCommands } from "../translationCommands";
import { validateSaveReceipt } from "../translationCommands";
import { executionCommands } from "../executionCommands";
import { reviewCommands } from "../reviewCommands";
import { validateResponseRead, validateResponseWritten, validateResponseCleared } from "../generated/draft.validators";
import { validateResponseRecoverSave } from "../generated/translation.validators";
import draftFixture from "../../test/fixtures/draftCommands.contract.json";
import translationFixture from "../../test/fixtures/translation-commands.json";
import type { DraftBasis, DraftHead } from "../draftCommands";
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
  vi.spyOn(draftCommands, "list").mockResolvedValue({ items: [], next: null });
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

  it("keeps the editor focused on a narrow workspace until details are explicitly requested", async () => {
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 900 });
    const first = translationFixture.save.unitId, second = "66666666-6666-4666-8666-666666666667";
    const basis: DraftBasis = { sourceRevisionId: translationFixture.save.sourceRevisionId, selectionId: null, revisionId: null, text: null };
    const opened = { ...project, metadata: { ...project.metadata, projectId: translationFixture.save.projectId } };
    const firstNativeKey = "greeting.welcome", secondNativeKey = "greeting.next";
    const names = new Map([[first, firstNativeKey], [second, secondNativeKey]]);
    const disk = new Map<string, DraftHead>(), current = new Map<string, DraftBasis>();
    const rows = [first, second].map((unitId, index) => ({ ...structuredClone(page.rows[0]),
      protection: { ...page.rows[0].protection, unitId }, applicability: { ...page.rows[0].applicability, selectedSourceRevisionId: null, sourceBasisCurrent: null, capturedBasisCurrent: null },
      content: { ...page.rows[0].content, unitId, sourceSnapshotId: translationFixture.start.expectedSourceSnapshotId,
        sourceRevisionId: basis.sourceRevisionId, nativeKey: names.get(unitId)!, sourcePreview: `Narrow source ${index + 1}`,
        translationPreview: null, selectionId: null, revisionId: null, basis: "a".repeat(64) } }));
    const captured: SegmentPage = { ...page, projectId: opened.metadata.projectId, sourceSnapshotId: translationFixture.start.expectedSourceSnapshotId,
      scopeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", epoch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      queryFingerprint: "c".repeat(64), readVersion: "b".repeat(64), rows, total: 2 };
    vi.mocked(sourceCommands.scope).mockResolvedValue({ currentSnapshot: captured.sourceSnapshotId, revision: "1" });
    vi.mocked(segmentCommands.page).mockResolvedValue(captured);
    vi.spyOn(segmentCommands, "queueWindow").mockImplementation(async request => ({ projectId: opened.metadata.projectId, locale: request.locale,
      scopeId: captured.scopeId, sourceSnapshotId: captured.sourceSnapshotId, query: captured.query, queryFingerprint: captured.queryFingerprint,
      epoch: captured.epoch, sequence: "1", total: 2, firstPosition: 0, previousUnitId: null, nextUnitId: null, rows }));
    vi.spyOn(draftCommands, "read").mockImplementation(async ({ key }) => {
      const value: unknown = { head: structuredClone(disk.get(key.unitId) ?? { key, revision: "0", writerId: null, value: null }),
        current: { kind: "current", basis: structuredClone(current.get(key.unitId) ?? basis), nativeKey: names.get(key.unitId)!, sourceText: `Complete source ${names.get(key.unitId)}` } };
      if (!validateResponseRead(value)) throw new Error("Invalid narrow draft read fixture"); return value;
    });
    vi.spyOn(draftCommands, "write").mockImplementation(async ({ write }) => {
      expect(write.expectedRevision).toBe(disk.get(write.key.unitId)?.revision ?? "0");
      const head: unknown = { key: write.key, revision: (BigInt(write.expectedRevision) + 1n).toString(), writerId: write.writerId, value: structuredClone(write.value) };
      if (!validateResponseWritten(head)) throw new Error("Invalid narrow draft write fixture");
      disk.set(write.key.unitId, head); return structuredClone(head);
    });
    vi.spyOn(draftCommands, "clear").mockImplementation(async ({ clear }) => {
      expect(clear.expectedRevision).toBe(disk.get(clear.key.unitId)?.revision ?? "0");
      const head: unknown = { key: clear.key, revision: (BigInt(clear.expectedRevision) + 1n).toString(), writerId: null, value: null };
      if (!validateResponseCleared(head)) throw new Error("Invalid narrow draft clear fixture");
      disk.set(clear.key.unitId, head); return structuredClone(head);
    });
    vi.spyOn(executionCommands, "identity").mockResolvedValue(translationFixture.save.actionId);
    const save = vi.spyOn(translationCommands, "save").mockImplementation(async request => {
      const selection = { ...translationFixture.receipt.selection, actionId: request.actionId, unitId: request.unitId, locale: request.locale,
        previousEventId: request.expectedSelectionId ?? null, sequence: "1" };
      const receipt = validateSaveReceipt({ ...translationFixture.receipt, actionId: request.actionId, projectId: request.projectId, selection,
        revision: { ...translationFixture.receipt.revision, actionId: request.actionId, unitId: request.unitId, locale: request.locale, sourceRevisionId: request.sourceRevisionId, text: request.text },
        basis: { ...translationFixture.receipt.basis, sourceRevisionId: request.sourceRevisionId, selectionId: selection.eventId } }, request);
      current.set(request.unitId, { sourceRevisionId: request.sourceRevisionId, selectionId: selection.eventId, revisionId: selection.revisionId, text: request.text });
      return receipt;
    });
    vi.spyOn(reviewCommands, "editorSnapshot").mockRejectedValue(new Error("Details not part of this drawer fixture"));
    try {
      controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(opened) });
      render(<WorkbenchApp controller={controller} native />);
      fireEvent.change(screen.getByRole("textbox", { name: "项目文件夹" }), { target: { value: opened.locator } });
      fireEvent.click(screen.getByRole("button", { name: "打开项目" }));
      const edit = await screen.findByRole("button", { name: i18n.t("workbenchV2.entryEdit", { key: firstNativeKey }) });
      await waitFor(() => expect(edit).toBeEnabled()); fireEvent.click(edit);
      const input = await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: firstNativeKey }) });
      expect(screen.queryByRole("dialog", { name: i18n.t("workbenchV2.agent") })).not.toBeInTheDocument();
      expect(input).toHaveFocus(); fireEvent.change(input, { target: { value: "Confirmed without opening the drawer" } });
      const confirm = screen.getByRole("button", { name: i18n.t("workbenchV2.confirmNext") });
      await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
      const next = await screen.findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: secondNativeKey }) });
      expect(save).toHaveBeenCalledTimes(1); expect(next).toHaveFocus();
      expect(screen.queryByRole("dialog", { name: i18n.t("workbenchV2.agent") })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.showEntryDetails", { key: secondNativeKey }) }));
      expect(await screen.findByRole("dialog", { name: i18n.t("workbenchV2.agent") })).toBeVisible();
    } finally {
      if (width) Object.defineProperty(window, "innerWidth", width);
    }
  });

  it("keeps initial presentation usable while draft hydration fails, and retries before allowing project exit", async () => {
    vi.mocked(draftCommands.list).mockRejectedValueOnce(new Error("Draft storage unavailable"));
    const close = vi.fn(async () => ({ closed: true }));
    controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(project), close });
    render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
    fireEvent.change(screen.getByRole("textbox", { name: "项目文件夹" }), { target: { value: project.locator } });
    fireEvent.click(screen.getByRole("button", { name: "打开项目" }));
    expect(await screen.findByText("Actual source from the read port")).toBeVisible();
    expect(await screen.findByText(i18n.t("workbenchV2.draftIndexFailed"))).toBeVisible();
    await act(async () => { expect(await controller.close()).toBe(false); });
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.draftIndexRetry") }));
    await waitFor(() => expect(screen.queryByText(i18n.t("workbenchV2.draftIndexFailed"))).not.toBeInTheDocument());
    let permit: Awaited<ReturnType<ProjectLifecycle["prepareLeave"]>> = null;
    await act(async () => { permit = await controller.prepareLeave({ kind: "close-project" }); });
    expect(permit).not.toBeNull();
    act(() => { permit?.release(); });
  });

  it("reveals the original pending draft outside blocked routing and checks it through the current session", async () => {
    const retained: unknown = structuredClone(draftFixture.responses.read);
    if (!validateResponseRead(retained) || retained.head.value?.pending?.kind !== "save") throw new Error("Invalid shared pending draft fixture");
    const pending = retained.head.value.pending, restored = { ...project, metadata: { ...project.metadata, projectId: retained.head.key.projectId } };
    vi.mocked(draftCommands.list).mockResolvedValue(draftFixture.responses.page);
    vi.spyOn(draftCommands, "read").mockImplementation(async () => structuredClone(retained));
    const recover = vi.spyOn(translationCommands, "recoverSave").mockImplementation(async () => {
      const result = { request: structuredClone(pending.request), outcome: { kind: "pending" as const, replay: "explicit-same-request" as const } };
      if (!validateResponseRecoverSave(result)) throw new Error("Invalid shared recovery fixture");
      return result;
    });
    vi.mocked(segmentCommands.page).mockResolvedValue({ ...page, projectId: restored.metadata.projectId });
    const close = vi.fn(async () => ({ closed: true }));
    controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(restored), close });
    render(<StrictMode><WorkbenchApp controller={controller} native /></StrictMode>);
    fireEvent.change(screen.getByRole("textbox", { name: "项目文件夹" }), { target: { value: restored.locator } });
    fireEvent.click(screen.getByRole("button", { name: "打开项目" }));
    await screen.findByText(i18n.t("workbenchV2.draftPendingSummary", { count: 1 }));
    await act(async () => { expect(await controller.close()).toBe(false); });
    const sheet = await screen.findByRole("dialog", { name: i18n.t("workbenchV2.draftRecoveryTitle") });
    const input = await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "greeting.welcome" }) });
    expect(input).toHaveValue(retained.head.value.text);
    expect(within(sheet).getByText("Welcome 👩🏽‍💻", { exact: false })).toBeVisible();
    fireEvent.click(within(sheet).getByRole("button", { name: i18n.t("workbenchV2.editorCheckResult") }));
    await waitFor(() => expect(recover).toHaveBeenCalledWith({ ...pending.request, sessionToken: restored.sessionToken }));
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole("button", { name: i18n.t("workbenchV2.close") }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: i18n.t("workbenchV2.draftRecoveryTitle") })).not.toBeInTheDocument());
    expect(screen.getByText(i18n.t("workbenchV2.draftPendingSummary", { count: 1 }))).toBeVisible();
  });

  it("confirms a recovered draft after the last view closes without offering an advance action", async () => {
    const retained: unknown = structuredClone(draftFixture.responses.read);
    if (!validateResponseRead(retained) || !retained.head.value) throw new Error("Invalid ordinary recovery fixture");
    retained.head.value.pending = null;
    let head = retained.head;
    const restored = { ...project, metadata: { ...project.metadata, projectId: head.key.projectId } };
    vi.mocked(draftCommands.list).mockResolvedValue({ items: draftFixture.responses.page.items.map(item => ({ ...item, hasPending: false })), next: null });
    vi.spyOn(draftCommands, "read").mockImplementation(async () => ({ head: structuredClone(head), current: structuredClone(retained.current) }));
    vi.spyOn(draftCommands, "write").mockImplementation(async ({ write }) => {
      expect(write.expectedRevision).toBe(head.revision);
      const value: unknown = { key: write.key, writerId: write.writerId, revision: (BigInt(head.revision) + 1n).toString(), value: structuredClone(write.value) };
      if (!validateResponseWritten(value)) throw new Error("Invalid recovery write fixture");
      head = value; return structuredClone(head);
    });
    vi.mocked(segmentCommands.page).mockResolvedValue({ ...page, projectId: restored.metadata.projectId });
    vi.spyOn(executionCommands, "identity").mockResolvedValue(translationFixture.save.actionId);
    const save = vi.spyOn(translationCommands, "save").mockRejectedValue({ code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false });
    controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(restored) });
    render(<WorkbenchApp controller={controller} native />);
    fireEvent.change(screen.getByRole("textbox", { name: "项目文件夹" }), { target: { value: restored.locator } });
    fireEvent.click(screen.getByRole("button", { name: "打开项目" }));
    const open = await screen.findByRole("button", { name: i18n.t("workbenchV2.draftRecoveryTitle") });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.closeView", { name: i18n.t("workbenchV2.viewName", { locale: "zh-CN" }) }) }));
    expect(await screen.findByText(i18n.t("workbenchV2.noViews"))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.draftRecoveryTitle") }));
    const sheet = await screen.findByRole("dialog", { name: i18n.t("workbenchV2.draftRecoveryTitle") });
    const input = await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: "greeting.welcome" }) }, { timeout: 3000 });
    await waitFor(() => expect(input).toHaveFocus());
    expect(within(sheet).queryByRole("button", { name: i18n.t("workbenchV2.confirmNext") })).not.toBeInTheDocument();
    const modifier = navigator.platform.includes("Mac") ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(input, { key: "Enter", ...modifier });
    expect(save).not.toHaveBeenCalled();
    expect(within(sheet).getByRole("button", { name: i18n.t("workbenchV2.editorConfirm") })).toBeEnabled();
    fireEvent.keyDown(input, { key: "s", ...modifier });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ unitId: retained.head.key.unitId, text: retained.head.value.text, sessionToken: restored.sessionToken }));
    expect(sheet).toBeVisible();
  });

  it("opens ordinary local drafts without source metadata and keeps newer input when switching the recovery list", async () => {
    const first: unknown = { ...structuredClone(draftFixture.responses.read), current: { kind: "unavailable", reason: "source-missing" } };
    if (!validateResponseRead(first) || !first.head.value) throw new Error("Invalid ordinary draft fixture");
    first.head.value.pending = null;
    const second: unknown = structuredClone(first);
    if (!validateResponseRead(second) || !second.head.value) throw new Error("Invalid second draft fixture");
    second.head.key.unitId = "66666666-6666-4666-8666-666666666667";
    second.head.value.text = "Another retained draft";
    const restored = { ...project, metadata: { ...project.metadata, projectId: first.head.key.projectId } };
    vi.mocked(draftCommands.list).mockResolvedValue({ items: [first, second].map(value => ({ key: value.head.key, revision: value.head.revision,
      editSeq: value.head.value!.editSeq, sourceRevisionId: value.head.value!.basis.sourceRevisionId, hasPending: false })), next: null });
    vi.spyOn(draftCommands, "read").mockImplementation(async request => structuredClone(request.key.unitId === first.head.key.unitId ? first : second));
    vi.spyOn(draftCommands, "write").mockRejectedValue(new Error("Disk unavailable"));
    vi.mocked(segmentCommands.page).mockResolvedValue({ ...page, projectId: restored.metadata.projectId });
    const writeText = vi.fn(async () => {}), clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      controller = new ProjectLifecycle({ open: vi.fn().mockResolvedValue(restored) });
      render(<WorkbenchApp controller={controller} native />);
      fireEvent.change(screen.getByRole("textbox", { name: "项目文件夹" }), { target: { value: restored.locator } });
      fireEvent.click(screen.getByRole("button", { name: "打开项目" }));
      const entry = await screen.findByRole("button", { name: i18n.t("workbenchV2.draftRecoveryTitle") });
      await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry);
      const sheet = await screen.findByRole("dialog", { name: i18n.t("workbenchV2.draftRecoveryTitle") });
      const input = await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: first.head.key.unitId }) });
      expect(input).toHaveValue(first.head.value.text);
      expect(within(sheet).getByText(i18n.t("workbenchV2.editorSourceMissing"))).toBeVisible();
      expect(within(sheet).getByTitle(first.head.key.unitId)).toHaveTextContent(`66666666…666666`);
      expect(within(sheet).getByTitle(second.head.key.unitId)).toHaveTextContent(`66666666…666667`);
      fireEvent.change(input, { target: { value: "Newer input kept while switching drafts" } });
      fireEvent.click(within(sheet).getByTitle(second.head.key.unitId));
      expect(await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: second.head.key.unitId }) })).toHaveValue("Another retained draft");
      fireEvent.click(within(sheet).getByTitle(first.head.key.unitId));
      expect(await within(sheet).findByRole("textbox", { name: i18n.t("workbenchV2.editorLabel", { key: first.head.key.unitId }) })).toHaveValue("Newer input kept while switching drafts");
      fireEvent.click(within(sheet).getByRole("button", { name: i18n.t("workbenchV2.editorCopy") }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("Newer input kept while switching drafts"));
      expect(screen.queryByText(i18n.t("workbenchV2.draftPendingSummary", { count: 1 }))).not.toBeInTheDocument();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});
