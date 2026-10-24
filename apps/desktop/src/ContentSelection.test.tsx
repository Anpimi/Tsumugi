import { useLayoutEffect, useState } from "react";
import { act, cleanup, render as renderDom, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslationWorkbench } from "./TranslationWorkbench";
import type { ContentSelection } from "./contentSelection";
import type { ProjectView } from "./projectCommands";
import type { ReviewScopeCapture, ReviewSummary } from "./reviewCommands";
import { useWorkspaceView, WorkspaceViewMemory, WorkspaceViewProvider, type WorkspaceArea } from "./WorkbenchFrame";
import { useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands, WorkbenchCommands, WorkbenchCommandsProvider, type TranslationContentRowCommandPayload } from "./workbenchCommands";
import { ProjectSessionWorkbench } from "./ProjectSessionWorkbench";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewSummaryFor, reviewSummaryPageFixture, reviewTargetFixture } from "./testSupport/reviewFixture";
import { sourcePageFixture } from "./testSupport/sourceFixture";
import { i18n } from "./i18n";
import { ApplicationReadProvider } from "./ApplicationReadProvider";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const project: ProjectView = { sessionToken: "content-selection-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(900), displayName: "Range selection", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const snapshot = fixtureIdentity(600), originalScope = fixtureIdentity(609), otherScope = fixtureIdentity(610);
const rows = Array.from({ length: 51 }, (_, index) => reviewSummaryFor(reviewTargetFixture({ unitId: fixtureIdentity(1000 + index),
  sourceRevisionId: fixtureIdentity(2000 + index), nativeKey: `a-${index + 1}`, sourceSnapshotId: snapshot, basis: `original-basis-${index}` })));
const otherRows = [51, 52].map(index => reviewSummaryFor(reviewTargetFixture({ unitId: fixtureIdentity(1000 + index),
  sourceRevisionId: fixtureIdentity(2000 + index), nativeKey: `b-${index}`, sourceSnapshotId: snapshot, basis: `other-basis-${index}` })));
let memory: WorkspaceViewMemory, reads: ReturnType<typeof useSessionReads>, registry: WorkbenchCommands;
let holdCapture: (() => Promise<ReviewScopeCapture>) | undefined;
const transferred = vi.fn(async (_selection: ContentSelection, _sequence: number) => true);
function Probe() {
  const view = useWorkspaceView(), reader = useSessionReads(), commands = useWorkbenchCommands();
  useLayoutEffect(() => { memory = view.memory; reads = reader; registry = commands; }); return null;
}
function Harness({ consumer = true, aiSequence = 7 }: { consumer?: boolean; aiSequence?: number; project?: ProjectView }) {
  return <><Probe />{consumer ? <TranslationWorkbench project={project} disabled={false}
    aiSelection={{ count: 2, locale: "zh-CN", editSeq: aiSequence, available: true }} onPrepareSelection={transferred} /> : null}</>;
}
function ProductionHarness() {
  const [area, setArea] = useState<WorkspaceArea>("translation"), [viewMemory] = useState(() => new WorkspaceViewMemory());
  const [commands] = useState(() => new WorkbenchCommands());
  return <ApplicationReadProvider><WorkbenchCommandsProvider commands={commands}><WorkspaceViewProvider value={{ area, memory: viewMemory, activate: setArea,
    deactivate: () => setArea("overview") }}><ProjectSessionWorkbench project={project} disabled={false} onActivate={setArea}
      onCoordinatingChange={() => {}} /></WorkspaceViewProvider></WorkbenchCommandsProvider></ApplicationReadProvider>;
}
function selection() { return memory.read<ContentSelection>("translation", "contentSelection"); }
function capture(scopeId = originalScope): ReviewScopeCapture {
  const members = scopeId === originalScope ? rows : otherRows;
  return { scopeId, sourceSnapshotId: snapshot, locale: "zh-CN", query: scopeId === originalScope ? "" : "b",
    readVersion: "fixed-view", units: members.map(row => ({ unitId: row.unitId, expectedBasis: row.basis, expectedDecisionId: null })) };
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function toolbar() { return screen.getByRole("group", { name: "Selected content range" }); }
async function open() {
  const result = render(<Harness project={project} />);
  await userEvent.click(screen.getByRole("button", { name: "Translations" }));
  await userEvent.click(screen.getByText("Find and range actions", { exact: true }));
  await userEvent.click(screen.getByText("Range actions (0 selected)", { exact: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Select all matching entries across pages" })).toBeEnabled());
  return result;
}
async function selectAll() {
  await userEvent.click(screen.getByRole("button", { name: "Select all matching entries across pages" }));
  const dialog = await screen.findByRole("dialog", { name: "Confirm range selection" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm range selection" })).toBeEnabled());
  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm range selection" }));
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset(); transferred.mockClear(); holdCapture = undefined;
  invoke.mockImplementation(async (command: string, payload?: { request: Record<string, unknown> }) => {
    if (command === "read_context_strategy_default") return null;
    const request = payload?.request ?? {};
    if (command === "read_project_changes") return { projectId: project.metadata.projectId, sessionToken: project.sessionToken,
      epoch: fixtureIdentity(901), sequence: "0", progressSequence: "0", scopes: [], runtime: { active: false, quiescing: false, queryCount: 0, error: null } };
    if (command === "read_plugin_text_reviews") return { settingsRevision: "1", entries: [] };
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: snapshot };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: snapshot, scope: { revision: "1", currentSnapshot: snapshot } });
    if (command === "read_review_summary_page") {
      const members: ReviewSummary[] = request.query === "b" ? otherRows : rows, after = Number(request.afterOrdinal);
      return reviewSummaryPageFixture(members.slice(after, after + 50), { total: members.length, nextOrdinal: after + 50 < members.length ? after + 50 : null,
        scopeId: request.query === "b" ? otherScope : originalScope, sourceSnapshotId: snapshot });
    }
    if (command === "capture_review_scope") return holdCapture ? holdCapture() : capture(String(request.scopeId));
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => cleanup());

it("captures all 51 Core members, excludes page 2, and keeps original bases when a new search shows other units", async () => {
  await open(); await selectAll();
  expect(selection()?.capture.units).toEqual(capture().units);
  expect(within(toolbar()).getByText(/51 selected · 0 excluded/)).toBeVisible();
  expect(screen.queryByRole("checkbox", { name: "Select a-51 for range actions" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  const last = await screen.findByRole("checkbox", { name: "Select a-51 for range actions" });
  await waitFor(() => expect(last).toBeEnabled()); expect(last).toBeChecked(); await userEvent.click(last);
  const confirmed = selection(); expect(confirmed?.excluded).toEqual([rows[50].unitId]);
  await userEvent.type(screen.getByRole("textbox", { name: "Find by key, source or translation" }), "b");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  expect(await screen.findByRole("checkbox", { name: "Select b-51 for range actions" })).toBeDisabled();
  expect(selection()).toBe(confirmed); expect(within(toolbar()).getByText(/50 selected · 1 excluded.*Fixed search: All entries/)).toBeVisible();
  expect(calls("capture_review_scope")).toHaveLength(1);
  await selectAll(); expect(selection()?.capture.units).toEqual(capture(otherScope).units);
  expect(selection()?.excluded).toEqual([]); expect(selection()?.capture.query).toBe("b");
});

it("retains a confirmed set through consumer unmount and transfers exactly its IDs and exclusions after explicit AI confirmation", async () => {
  const result = await open(); await selectAll();
  await userEvent.click(screen.getByRole("checkbox", { name: "Select a-1 for range actions" }));
  const confirmed = selection();
  result.rerender(<Harness project={project} consumer={false} />);
  result.rerender(<Harness project={project} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Prepare AI for selected entries" })).toBeEnabled());
  expect(selection()).toBe(confirmed); expect(calls("capture_review_scope")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Prepare AI for selected entries" }));
  expect(transferred).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Prepare AI for selected entries" });
  expect(within(dialog).getByText(/Replace the AI form's current 2 selected entries/)).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "Use this range in AI preparation" }));
  expect(transferred).toHaveBeenCalledExactlyOnceWith(confirmed, 7);
  expect(calls("prepare_work_plan")).toHaveLength(0); expect(calls("start_ai_translation")).toHaveLength(0);
});

it("preserves typed search B while capture A is pending and rejects a semantic change without replacing the previous selection", async () => {
  await open(); await selectAll(); const previous = selection();
  let resolve!: (value: ReviewScopeCapture) => void;
  holdCapture = () => new Promise(done => { resolve = done; });
  await userEvent.click(screen.getByRole("button", { name: "Select all matching entries across pages" }));
  await waitFor(() => expect(calls("capture_review_scope")).toHaveLength(2));
  await userEvent.type(screen.getByRole("textbox", { name: "Find by key, source or translation" }), "b");
  await act(async () => { reads.invalidate(["source"]); resolve(capture()); });
  await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
  expect(screen.getByRole("textbox", { name: "Find by key, source or translation" })).toHaveValue("b");
  expect(selection()).toBe(previous); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("refuses stale row command targets and keeps an AI confirmation from overwriting a newer preparation", async () => {
  const result = await open();
  const payload: TranslationContentRowCommandPayload = { kind: "translation-content-row", unitId: rows[0].unitId, scopeId: originalScope,
    sourceSnapshotId: snapshot, locale: "zh-CN", listReadId: -1, selectionVersion: 0, checked: true };
  expect(registry.dispatch("translation.toggle-content-selection", { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "translation" }, payload)).toBe(false);
  expect(calls("capture_review_scope")).toHaveLength(0);
  await selectAll(); await userEvent.click(screen.getByRole("button", { name: "Prepare AI for selected entries" }));
  result.rerender(<Harness project={project} aiSequence={8} />);
  expect(screen.getByRole("button", { name: "Use this range in AI preparation" })).toBeDisabled();
  expect(transferred).not.toHaveBeenCalled();
});

it("opens the production AI workspace with the confirmed cross-page set and no preparation or model dispatch", async () => {
  renderDom(<ProductionHarness />);
  // The production bridge may invalidate the initial view while registering.
  // The user explicitly confirms the search after that read has settled.
  await waitFor(() => expect(screen.getByRole("button", { name: "Find" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Select all matching entries across pages" })).toBeEnabled());
  await selectAll(); await userEvent.click(screen.getByRole("checkbox", { name: "Select a-1 for range actions" }));
  await userEvent.click(screen.getByRole("button", { name: "Prepare AI for selected entries" }));
  const dialog = screen.getByRole("dialog", { name: "Prepare AI for selected entries" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Use this range in AI preparation" }));
  expect(await screen.findByRole("heading", { name: i18n.t("ai.scope", { count: 50 }) })).toBeVisible();
  expect(screen.queryByRole("group", { name: "Selected content range" })).not.toBeInTheDocument();
  expect(calls("capture_review_scope")).toHaveLength(1);
  for (const command of ["preview_ai_translation", "prepare_work_plan", "start_ai_translation", "start_work_plan"]) expect(calls(command)).toHaveLength(0);
});
