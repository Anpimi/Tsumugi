import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import wire from "../../../../test/fixtures/resourceCommands.contract.json";
import segmentWire from "../../../../test/fixtures/segmentCommands.contract.json";
import { i18n } from "../../../i18n";
import type { knowledgeEn } from "../../../i18n/knowledge";
import type { workbenchEn } from "../../../i18n/workbench";
import { SessionReads } from "../../../sessionReads";
import { draftCommands } from "../../../draftCommands";
import { conversationDraftCommands } from "../../../conversationDraftCommands";
import { conversationCommands } from "../../../conversationCommands";
import { sourceCommands } from "../../../sourceCommands";
import { segmentCommands } from "../../../segmentCommands";
import type { ProjectView } from "../../../projectCommands";
import type { TermRevision } from "../../../resourceCommands";
import { validateResponseSegmentPage } from "../../../generated/review.validators";
import { ProjectLifecycle, type ProjectLifecyclePorts } from "../../platform/projectLifecycle";
import WorkbenchApp from "../../WorkbenchApp";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));
vi.mock("../../platform/useProjectLifecycle", async original => ({ ...await original<object>(), useNativeProjectClose: () => ({ state: "ready" }) }));
const project: ProjectView = { sessionToken: "synthetic-knowledge-workspace", locator: "/synthetic/knowledge-workspace", reconciliationState: "settled",
  metadata: { projectId: segmentWire.responses.segmentPage.projectId, displayName: "Knowledge workspace", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const term: TermRevision = { ...wire.responses.term, termId: "manual-term", source: "Barrel", target: "木桶", aliases: [], reason: "Saved reason", scopeUnitId: null,
  locale: "zh-CN", originKind: "manual", captureId: null, externalEntryId: null, previousRevisionId: null, removed: false };
let controller: ProjectLifecycle | undefined;
const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
type KnowledgeMessage = { [Key in keyof typeof knowledgeEn]: typeof knowledgeEn[Key] extends string ? Key : never }[keyof typeof knowledgeEn];
type WorkspaceMessage = { [Key in keyof typeof workbenchEn]: typeof workbenchEn[Key] extends string ? Key : never }[keyof typeof workbenchEn];
const w = (key: WorkspaceMessage) => i18n.t(`workbenchV2.${key}`), k = (key: KnowledgeMessage) => i18n.t(`knowledge.${key}`);
beforeEach(async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  localStorage.clear(); history.replaceState(null, "", "/"); await i18n.changeLanguage("en-US");
  vi.spyOn(SessionReads.prototype, "start").mockReturnValue(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(draftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(conversationDraftCommands, "list").mockResolvedValue({ items: [], next: null });
  vi.spyOn(conversationCommands, "list").mockResolvedValue({ projectId: project.metadata.projectId, rows: [], nextAfter: null });
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ revision: "1", currentSnapshot: segmentWire.responses.segmentPage.sourceSnapshotId });
  const page: unknown = structuredClone(segmentWire.responses.segmentPage);
  if (!validateResponseSegmentPage(page)) throw new Error("A complete synthetic entry page is required");
  vi.spyOn(segmentCommands, "page").mockResolvedValue(page);
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_terms") return [structuredClone(term)];
    if (command === "read_term_current") return structuredClone(term);
    if (command === "read_term_history") return [structuredClone(term)];
    if (command === "list_resource_captures") return [];
    throw new Error(`Unexpected synthetic workspace command: ${command}`);
  });
});
afterEach(() => { cleanup(); controller?.dispose(); controller = undefined; if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth); });

it("protects the lazy owner gap and retains the original draft across workspace tabs", async () => {
  const close = vi.fn<ProjectLifecyclePorts["close"]>(async () => ({ closed: true }));
  controller = new ProjectLifecycle({ open: async () => project, close, status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  const register = vi.spyOn(controller, "register"), lifecycle = controller;
  render(<StrictMode><WorkbenchApp controller={lifecycle} native/></StrictMode>);
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: w("projectFolder") }), project.locator);
  await user.click(screen.getByRole("button", { name: w("openProject") }));
  const activity = await screen.findByRole("navigation", { name: w("activity") }, { timeout: 5000 });
  const loading = register.mock.calls.find(([participant]) => participant.id === "knowledge-resources-loading")?.[0];
  expect(loading).toBeDefined(); expect(loading?.inspect({ kind: "close-project" }).status).toBe("ready");
  act(() => { loading?.reveal?.(); expect(loading?.inspect({ kind: "close-window" }).status).toBe("blocked"); });
  await waitFor(() => expect(register.mock.calls.some(([participant]) => participant.id === "knowledge-resources")).toBe(true), { timeout: 5000 });
  expect(loading?.inspect({ kind: "close-window" }).status).toBe("ready");
  await waitFor(() => {
    const knowledge = within(activity).getByRole("button", { name: w("knowledge") });
    expect(knowledge.tagName).toBe("BUTTON"); expect(knowledge).toBeEnabled(); expect(knowledge).not.toHaveAttribute("aria-disabled", "true");
  });
  await user.click(within(activity).getByRole("button", { name: w("knowledge") }));
  await user.click(await screen.findByRole("button", { name: "Barrel" }));
  const editor = await screen.findByRole("textbox", { name: k("targetTerm") });
  fireEvent.change(editor, { target: { value: "Keep my edit" } });
  await user.click(within(activity).getByRole("button", { name: w("entries") }));
  expect(await screen.findByRole("button", { name: k("backToDraft") })).toBeVisible();
  await act(async () => { expect(await lifecycle.close()).toBe(false); }); expect(close).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: k("backToDraft") }));
  expect(await screen.findByRole("textbox", { name: k("targetTerm") })).toHaveValue("Keep my edit");
  expect(within(screen.getByRole("tablist", { name: w("dockTabs") })).getByRole("tab", { name: w("agent") })).toHaveAttribute("aria-selected", "true");
  await user.click(screen.getByRole("button", { name: k("discard") }));
  await act(async () => { expect(await lifecycle.close()).toBe(true); }); expect(close).toHaveBeenCalledOnce();
});
