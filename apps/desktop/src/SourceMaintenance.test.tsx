import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceHistoryPanel, SourceImpactPanel } from "./SourceMaintenance";
import { useWorkbenchCommands, type SourceImpactTargetCommandPayload } from "./workbenchCommands";
import { executionContext } from "./executionCommands";
import type { ContentScope } from "./sourceCommands";
import type { ProjectView } from "./projectCommands";
import { i18n } from "./i18n";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { sourceContentFixture, sourceHistoryFixture, sourceImpactFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import fixture from "../test/fixtures/sourceCommands.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { ...fixture.session, locator: "C:\\isolated\\source-reads", reconciliationState: "settled",
  metadata: { projectId: fixture.session.projectId, displayName: "Fixture", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const snapshotId = fixture.content.snapshotId, commandScope = { ...executionContext(project), area: "source" as const };
let scope: ContentScope, registry: ReturnType<typeof useWorkbenchCommands>;
function Probe() { const value = useWorkbenchCommands(); useLayoutEffect(() => { registry = value; }); return null; }
function targetPayload(): SourceImpactTargetCommandPayload {
  const row = sourceImpactFixture().rows[0];
  return { kind: "source-impact-target", snapshotId, locale: row.locale, occurrenceId: row.current.occurrenceId!,
    target: { unitId: row.current.unitId!, sourceRevisionId: row.current.sourceRevisionId!, key: row.current.occurrence.key, sourceText: row.current.occurrence.text },
    selectionId: row.selectionId, translationRevisionId: row.translationRevisionId, reviewBasis: row.reviewBasis };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset(); scope = { revision: fixture.page.scope.revision, currentSnapshot: snapshotId };
  invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return scope;
    if (command === "read_source_history") return sourceHistoryFixture();
    if (command === "read_source_history_content") return sourceContentFixture(payload.request.snapshotId as string, scope);
    if (command === "read_source_lineage") return fixture.lineage;
    if (command === "read_source_impact") { const locale = payload.request.locale as string; return sourceImpactFixture({ summary: { ...fixture.impact.summary, locale }, rows: sourceImpactFixture().rows.map(row => ({ ...row, locale })) }); }
    throw new Error(command);
  });
});
afterEach(cleanup);

it("keeps the applied search and filtered cursor while typing, and retries a failed page exactly", async () => {
  let finish!: (value: unknown) => void, failPage = true;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_source_history_content" && payload.request.query === "A" && payload.request.after === 0)
      return new Promise(resolve => { finish = resolve; });
    if (command === "read_source_history_content" && payload.request.after === 1 && failPage) return Promise.reject(new Error("Page unavailable"));
    return original(command, payload);
  });
  render(<SourceHistoryPanel project={project} disabled={false} />);
  const historyButton = screen.getByRole("button", { name: "Source snapshot history" });
  expect(historyButton).toBeEnabled();
  const user = userEvent.setup(); await user.click(historyButton);
  await user.click(await screen.findByRole("button", { name: /Source revision/ }));
  const input = screen.getByRole("textbox", { name: "Search historical keys or text" });
  await user.type(input, "A"); await user.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  await user.clear(input); await user.type(input, "B");
  await act(async () => { finish(sourceContentFixture(snapshotId, scope)); });
  // Raw occurrence 70 is not the filtered array cursor 1.
  const first = sourceContentFixture(snapshotId, scope);
  invoke.mockImplementation((command: string, payload: { request: Record<string, unknown> }) => {
    if (command !== "read_source_history_content") return original(command, payload);
    if (payload.request.after === 1 && failPage) return Promise.reject(new Error("Page unavailable"));
    const next = payload.request.after === 1;
    return Promise.resolve({ ...first, total: 2, nextOrdinal: next ? null : 1,
      rows: [sourceRowFixture(first.rows[0], { ordinal: next ? 71 : 70, key: `${payload.request.query}-${next ? "next" : "first"}` })] });
  });
  await refreshWorkbenchReads(["source"]);
  await user.click(await screen.findByRole("button", { name: "Next page" }));
  await screen.findByRole("alert");
  expect(invoke).toHaveBeenLastCalledWith("read_source_history_content", { request: { ...fixture.session, snapshotId, query: "A", after: 1, limit: 20 } });
  expect(input).toHaveValue("B"); failPage = false;
  await user.click(screen.getByRole("button", { name: "Retry this read" }));
  await screen.findByText("A-next");
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  const reads = invoke.mock.calls.filter(([command]) => command === "read_source_history_content").map(([, payload]) => payload.request);
  expect(reads.slice(-2)).toEqual([expect.objectContaining({ query: "A", after: 1 }), expect.objectContaining({ query: "A", after: 1 })]);
  const firstPage = screen.getByRole("button", { name: "First page" }); await waitFor(() => expect(firstPage).toBeEnabled());
  await user.click(firstPage);
  // The exact first-page query is already fresh in the shared cache.
  await screen.findByText("A-first");
  expect(screen.queryByText("A-next")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "First page" })).not.toBeInTheDocument();
  expect(input).toHaveValue("B");
  expect(invoke).toHaveBeenCalledWith("read_source_history_content", { request: { ...fixture.session, snapshotId, query: "A", after: 0, limit: 20 } });
  await user.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("B-first");
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("read_source_history_content", { request: { ...fixture.session, snapshotId, query: "B", after: 0, limit: 20 } }));
});

it("reads lineage by the selected raw occurrence ordinal and refreshes current history markers", async () => {
  const original = invoke.getMockImplementation()!;
  let current = true;
  invoke.mockImplementation((command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_source_history") return Promise.resolve(sourceHistoryFixture({ snapshots: fixture.history.snapshots.map(entry => ({ ...entry, current })) }));
    if (command === "read_source_history_content") { const page = sourceContentFixture(snapshotId, scope); return Promise.resolve({ ...page, rows: [sourceRowFixture(page.rows[0], { ordinal: 70 })] }); }
    return original(command, payload);
  });
  render(<SourceHistoryPanel project={project} disabled={false} />);
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Source snapshot history" }));
  await user.click(await screen.findByRole("button", { name: /Source revision.*Current source/ }));
  await user.click(await screen.findByRole("button", { name: "View identity evidence" }));
  await screen.findByText("Same stable key");
  expect(invoke).toHaveBeenCalledWith("read_source_lineage", { request: { ...fixture.session, snapshotId, ordinal: 70 } });
  current = false; scope = { revision: "9007199254740994", currentSnapshot: fixtureIdentity(99) };
  await refreshWorkbenchReads(["source"]);
  expect(await screen.findByRole("button", { name: /Source revision.*Historical source/ })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Search historical keys or text" })).toHaveValue("");
});

it("ignores a hidden history response and rereads its exact intent when shown", async () => {
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<SourceHistoryPanel project={project} disabled={false} active />);
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Source snapshot history" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.rerender(<SourceHistoryPanel project={project} disabled={false} active={false} />);
  await act(async () => { finish(sourceHistoryFixture({ total: 99 })); });
  expect(screen.queryByText("99 saved source snapshots")).not.toBeInTheDocument();
  invoke.mockImplementation(original);
  view.rerender(<SourceHistoryPanel project={project} disabled={false} active />);
  await screen.findByText("1 saved source snapshots");
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_history").map(([, payload]) => payload.request)).toEqual([
    { ...fixture.session, offset: 0, limit: 50 }, { ...fixture.session, offset: 0, limit: 50 }]);
});

it("removes its read commands on unmount and automatically rereads the retained cursor while ignoring the late response", async () => {
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<><Probe/><SourceHistoryPanel project={project} disabled={false} /></>, project);
  expect(registry.describe("source.read-history", commandScope, { kind: "source-history", offset: 0 })?.availability.enabled).toBe(true);
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Source snapshot history" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.rerender(<Probe/>);
  expect(registry.dispatch("source.read-history", commandScope, { kind: "source-history", offset: 0 })).toBe(false);
  await act(async () => { finish(sourceHistoryFixture({ total: 99 })); });
  invoke.mockImplementation(original);
  view.rerender(<><Probe/><SourceHistoryPanel project={project} disabled={false}/></>);
  await screen.findByText("1 saved source snapshots");
  expect(screen.queryByText("99 saved source snapshots")).not.toBeInTheDocument();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_source_history", "read_source_history"]);
});

it("opens the exact current unit and blocks missing, stale and previous-unit targets", async () => {
  const onOpenTranslation = vi.fn(() => false);
  const view = render(<><Probe/><SourceImpactPanel project={project} snapshotId={snapshotId} onOpenTranslation={onOpenTranslation}/></>, project);
  const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "Edit this key" }));
  expect(onOpenTranslation).toHaveBeenCalledWith(targetPayload().target, "zh-CN");
  expect(await screen.findByRole("alert")).toHaveTextContent("The translation editor could not open");
  const payload = targetPayload();
  expect(Reflect.apply(registry.dispatch, registry, ["source.open-translation", commandScope])).toBe(false);
  expect(registry.dispatch("source.open-translation", commandScope, { ...payload, target: { ...payload.target, unitId: payload.occurrenceId } })).toBe(false);
  expect(registry.dispatch("source.open-translation", commandScope, { ...payload, reviewBasis: "historical" })).toBe(false);
  expect(registry.dispatch("source.open-translation", { ...commandScope, projectId: fixtureIdentity(90) }, payload)).toBe(false);
  view.rerender(<><Probe/><SourceImpactPanel project={project} snapshotId={snapshotId} disabled onOpenTranslation={onOpenTranslation}/></>, project);
  expect(registry.describe("source.open-translation", commandScope, payload)?.availability.enabled).toBe(false);
  expect(registry.dispatch("source.open-translation", commandScope, payload)).toBe(false);
  expect(onOpenTranslation).toHaveBeenCalledTimes(1);
});

it("keeps a removed locale visible and requires an explicit read for a newly selected target", async () => {
  const open = vi.fn(() => true), view = render(<><Probe/><SourceImpactPanel project={project} snapshotId={snapshotId} onOpenTranslation={open}/></>, project);
  await screen.findByRole("button", { name: "Edit this key" });
  const previousCalls = invoke.mock.calls.filter(([command]) => command === "read_source_impact").length;
  const changed = { ...project, metadata: { ...project.metadata, targetLocales: ["fr"] } };
  view.rerender(<><Probe/><SourceImpactPanel project={changed} snapshotId={snapshotId} onOpenTranslation={open}/></>, changed);
  expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("zh-CN");
  expect(screen.getByRole("alert")).toHaveTextContent("zh-CN is no longer a project target");
  expect(registry.dispatch("source.open-translation", commandScope, targetPayload())).toBe(false);
  expect(screen.queryByRole("button", { name: "Edit this key" })).not.toBeInTheDocument();
  const user = userEvent.setup(); await user.selectOptions(screen.getByRole("combobox", { name: "Target language" }), "fr");
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_impact")).toHaveLength(previousCalls);
  expect(screen.getByRole("button", { name: "Read current impact" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Read current impact" }));
  await screen.findByRole("button", { name: "Edit this key" });
  expect(invoke).toHaveBeenLastCalledWith("read_source_impact", { request: { ...fixture.session, snapshotId, locale: "fr", after: 0, limit: 10 } });
  expect(open).not.toHaveBeenCalled();
});

it.each(["translation", "resources", "review"] as const)("rechecks impact navigation after %s changes", async change => {
  const open = vi.fn(() => true); render(<><Probe/><SourceImpactPanel project={project} snapshotId={snapshotId} onOpenTranslation={open}/></>, project);
  const button = await screen.findByRole("button", { name: "Edit this key" });
  await waitFor(() => expect(button).toBeEnabled());
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_source_impact" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  await refreshWorkbenchReads([change]);
  expect(registry.dispatch("source.open-translation", commandScope, targetPayload())).toBe(false);
  // Query notifications are scheduled; keep the response pending until the DOM catches up.
  await waitFor(() => expect(button).toBeDisabled());
  const next = sourceImpactFixture(); next.rows[0] = { ...next.rows[0], selectionId: fixtureIdentity(80), translationRevisionId: fixtureIdentity(81), reviewBasis: "new-current" };
  await act(async () => { finish(next); });
  await waitFor(() => expect(button).toBeEnabled());
  expect(registry.dispatch("source.open-translation", commandScope, targetPayload())).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

it("rejects a wrong snapshot page, retries its exact cursor and stops when the source changes", async () => {
  const original = invoke.getMockImplementation()!; let valid = false;
  invoke.mockImplementation((command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_source_impact") return Promise.resolve(payload.request.after === 0 ? sourceImpactFixture({ nextOrdinal: 10 })
      : sourceImpactFixture({ snapshotId: valid ? snapshotId : fixtureIdentity(90) }));
    return original(command, payload);
  });
  render(<SourceImpactPanel project={project} snapshotId={snapshotId} />);
  const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "Next page" }));
  await screen.findByRole("alert"); valid = true;
  await user.click(screen.getByRole("button", { name: "Retry this read" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_impact").slice(-2).map(([, payload]) => payload.request)).toEqual([
    { ...fixture.session, snapshotId, locale: "zh-CN", after: 10, limit: 10 }, { ...fixture.session, snapshotId, locale: "zh-CN", after: 10, limit: 10 }]);
  scope = { revision: "9007199254740994", currentSnapshot: fixtureIdentity(95) };
  await refreshWorkbenchReads(["source"]);
  expect(await screen.findByRole("alert")).toHaveTextContent("This source is no longer current");
  expect(screen.getByRole("button", { name: "Read current impact" })).toBeDisabled();
});

it.each(["malformed", "wrong-locale"] as const)("rejects %s impact responses at the typed adapter and query boundary", async failure => {
  const original = invoke.getMockImplementation()!, open = vi.fn(() => true); let valid = false;
  invoke.mockImplementation((command: string, payload: unknown) => {
    if (command === "read_source_impact" && !valid) return Promise.resolve(failure === "malformed" ? { ...fixture.impact, rows: undefined }
      : sourceImpactFixture({ summary: { ...fixture.impact.summary, locale: "fr" } }));
    return original(command, payload);
  });
  render(<><Probe/><SourceImpactPanel project={project} snapshotId={snapshotId} onOpenTranslation={open}/></>, project);
  await screen.findByRole("alert"); expect(screen.queryByRole("button", { name: "Edit this key" })).not.toBeInTheDocument();
  expect(registry.dispatch("source.open-translation", commandScope, targetPayload())).toBe(false); expect(open).not.toHaveBeenCalled();
  valid = true; const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Retry this read" }));
  await screen.findByRole("button", { name: "Edit this key" });
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_impact").map(([, payload]) => payload.request)).toEqual([
    { ...fixture.session, snapshotId, locale: "zh-CN", after: 0, limit: 10 }, { ...fixture.session, snapshotId, locale: "zh-CN", after: 0, limit: 10 }]);
});

it("explains an empty target list without issuing an impact read", async () => {
  const changed = { ...project, metadata: { ...project.metadata, targetLocales: [] } };
  render(<SourceImpactPanel project={changed} snapshotId={snapshotId}/>);
  expect(screen.getByRole("alert")).toHaveTextContent("Add a target language in project settings");
  expect(screen.getByRole("button", { name: "Read current impact" })).toBeDisabled();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_content_scope", { request: fixture.session }));
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_impact")).toHaveLength(0);
});


it("retains historical snapshot and unapplied search input through a real consumer remount", async () => {
  const user = userEvent.setup(), view = render(<SourceHistoryPanel project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Source snapshot history" }));
  await user.click(await screen.findByRole("button", { name: /Source revision/ }));
  await user.type(screen.getByRole("textbox", { name: "Search historical keys or text" }), "not yet applied");
  await screen.findByText("Historical source");
  const previous = invoke.mock.calls.filter(([command]) => command === "read_source_history_content").length;
  view.rerender(<></>); view.rerender(<SourceHistoryPanel project={project} disabled={false} />);
  expect(await screen.findByRole("textbox", { name: "Search historical keys or text" })).toHaveValue("not yet applied");
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "read_source_history_content").length).toBeGreaterThan(previous));
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_history_content").at(-1)?.[1].request)
    .toMatchObject({ snapshotId, query: "", after: 0 });
});

it("awaits destination acceptance and does not show late navigation feedback in a replacement source view", async () => {
  let finish!: (value: boolean) => void;
  const open = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const view = render(<SourceImpactPanel project={project} snapshotId={snapshotId} onOpenTranslation={open} />);
  const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "Edit this key" }));
  expect(open).toHaveBeenCalledOnce();
  expect(screen.queryByText(i18n.t("source.navigationBlocked"))).not.toBeInTheDocument();
  view.rerender(<></>); await act(async () => finish(false));
  view.rerender(<SourceImpactPanel project={project} snapshotId={snapshotId} onOpenTranslation={open} />);
  await screen.findByRole("button", { name: "Edit this key" });
  expect(screen.queryByText(i18n.t("source.navigationBlocked"))).not.toBeInTheDocument();
});

it.each(["synchronous", "asynchronous"])("shows a recoverable navigation failure after a %s callback rejection", async kind => {
  const open = vi.fn(() => {
    if (kind === "synchronous") throw new Error("Destination unavailable");
    return Promise.reject<boolean>(new Error("Destination unavailable"));
  });
  render(<SourceImpactPanel project={project} snapshotId={snapshotId} onOpenTranslation={open} />);
  const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "Edit this key" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("source.navigationBlocked"));
  open.mockImplementation(() => Promise.resolve(true));
  await user.click(screen.getByRole("button", { name: "Edit this key" }));
  await waitFor(() => expect(screen.queryByText(i18n.t("source.navigationBlocked"))).not.toBeInTheDocument());
  expect(open).toHaveBeenCalledTimes(2);
});

it("ignores a rejected destination callback after its original source consumer unmounts", async () => {
  let reject!: (reason: Error) => void;
  const open = vi.fn(() => new Promise<boolean>((_resolve, fail) => { reject = fail; }));
  const view = render(<SourceImpactPanel project={project} snapshotId={snapshotId} onOpenTranslation={open} />);
  const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "Edit this key" }));
  view.rerender(<></>); await act(async () => reject(new Error("Old destination unavailable")));
  view.rerender(<SourceImpactPanel project={project} snapshotId={snapshotId} onOpenTranslation={open} />);
  await screen.findByRole("button", { name: "Edit this key" });
  expect(screen.queryByText(i18n.t("source.navigationBlocked"))).not.toBeInTheDocument();
});
