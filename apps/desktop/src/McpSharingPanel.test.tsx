import { createRef, useLayoutEffect, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { ProjectSessionOwners, ProjectSessionWorkbench, type ProjectSessionHandle } from "./ProjectSessionWorkbench";
import { McpSharingPanel } from "./McpSharingPanel";
import * as sharingOwner from "./McpSharingSession";
import { mcpCommands, type McpShareView } from "./mcpCommands";
import { executionCommands } from "./executionCommands";
import { WorkspaceViewMemory, WorkspaceViewProvider, type WorkspaceArea } from "./WorkbenchFrame";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "./workbenchCommands";
import { mcpConfiguration, mcpPrepared, mcpProject, mcpTarget, mcpView } from "./testSupport/mcpSharingFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import execution from "../test/fixtures/executionCommands.contract.json";
import commandErrors from "../test/fixtures/commandErrors.contract.json";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
let owner: ReturnType<typeof sharingOwner.useMcpSharing>, canonical: McpShareView | null, sequence: number, area: WorkspaceArea;
function Probe() { const value = sharingOwner.useMcpSharing(); useLayoutEffect(() => { owner = value; }); return null; }
function Harness({ children }: { children?: ReactNode }) {
  return <ApplicationReadProvider><ProjectSessionOwners project={mcpProject} bridge={false}><Probe /><McpSharingPanel />{children}</ProjectSessionOwners></ApplicationReadProvider>;
}
const handle = createRef<ProjectSessionHandle>();
function ProductionHarness() {
  const [current, show] = useState<WorkspaceArea>("overview"), [memory] = useState(() => new WorkspaceViewMemory()), [commands] = useState(() => new WorkbenchCommands());
  useLayoutEffect(() => { area = current; });
  return <ApplicationReadProvider><WorkbenchCommandsProvider commands={commands}><WorkspaceViewProvider value={{ area: current, memory, activate: show, deactivate: () => show("overview") }}>
    <ProjectSessionWorkbench ref={handle} project={mcpProject} disabled={false} onActivate={show} onCoordinatingChange={() => {}} />
  </WorkspaceViewProvider></WorkbenchCommandsProvider></ApplicationReadProvider>;
}
function currentView() { if (!canonical) throw new Error("Synthetic sharing view missing"); return canonical; }
function open() { render(<Harness />); act(() => { expect(owner.begin(mcpTarget)).toBe(true); }); }
async function preview() {
  fireEvent.change(screen.getByRole("textbox", { name: "External recipient" }), { target: { value: "Synthetic recipient" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview exact shared content" }));
  await screen.findByRole("region", { name: "Exact saved snapshot" }); await waitFor(() => expect(owner.state.reading).toBe(false));
}
async function authorize() {
  fireEvent.click(screen.getByRole("checkbox", { name: "I authorize this recipient to read exactly the content shown above under these limits." }));
  fireEvent.click(screen.getByRole("button", { name: "Create one-use client configuration" }));
  await screen.findByRole("button", { name: "Show client configuration" });
}
beforeEach(async () => {
  vi.restoreAllMocks(); await i18n.changeLanguage("en-US"); canonical = null; sequence = 9200;
  vi.spyOn(executionCommands, "identity").mockImplementation(async () => id(++sequence));
  vi.spyOn(mcpCommands, "session").mockResolvedValue({ kind: "available", ownerId: id(9020), nextGeneration: "1", current: null });
  vi.spyOn(mcpCommands, "prepare").mockImplementation(async request => { canonical = mcpView(request.preparation); return mcpPrepared(request.preparation); });
  vi.spyOn(mcpCommands, "authorize").mockImplementation(async (request, preparation) => {
    canonical = mcpView(preparation, request.authorization); return { view: canonical, configuration: structuredClone(mcpConfiguration) };
  });
  vi.spyOn(mcpCommands, "read").mockImplementation(async () => structuredClone(currentView()));
  vi.spyOn(mcpCommands, "revoke").mockImplementation(async request => {
    canonical = { ...currentView(), phase: "closed", admissionClosed: true, callbacksDrained: true };
    return { identity: request.identity, actionId: request.actionId, admissionClosed: true, callbacksDrained: true };
  });
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "read_context_strategy_default") return null;
    if (command === "read_project_changes") return { projectId: mcpProject.metadata.projectId, sessionToken: mcpProject.sessionToken,
      epoch: id(9290), sequence: "0", progressSequence: "0", scopes: [], runtime: execution.status };
    if (command === "read_content_scope") return { revision: "0", currentSnapshot: null };
    if (command === "read_execution_task_activity") return { total: "0", active: "0", attention: "0", saved: "0", rows: [] };
    throw new Error("Unexpected synthetic non-sharing read");
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("shows the exact saved content, independent opt-ins and recipient limits before any authorization", async () => {
  open(); expect(screen.getByRole("heading", { name: "Share one saved entry" })).toHaveFocus();
  expect(screen.getByRole("button", { name: "Preview exact shared content" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "Include adopted terms for this entry" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Include the saved manual context for this entry" })).not.toBeChecked();
  await preview();
  expect(screen.getByText(/^Synthetic Hello/, { selector: "pre" }).textContent).toBe("Synthetic Hello {{player}} 👩🏽‍💻 é\nمرحبا");
  expect(screen.getByText("合成你好 {{player}}", { selector: "pre" })).toBeInTheDocument();
  expect(screen.getByText("Adopted terms are excluded.")).toBeInTheDocument(); expect(screen.getByText("Manual context is excluded.")).toBeInTheDocument();
  expect(screen.getByText(/at most five minutes/)).toBeInTheDocument(); expect(screen.getByText(/at most 100 reads/)).toBeInTheDocument();
  expect(screen.getByText(/including sending it to its model provider/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create one-use client configuration" })).toBeDisabled(); expect(mcpCommands.authorize).not.toHaveBeenCalled();
});

it("independently includes only the optional categories explicitly chosen before preview", async () => {
  open(); fireEvent.click(screen.getByRole("checkbox", { name: "Include the saved manual context for this entry" })); await preview();
  expect(screen.getByText("Synthetic manual context only", { selector: "pre" })).toBeInTheDocument(); expect(screen.getByText("Adopted terms are excluded.")).toBeInTheDocument();
  expect(vi.mocked(mcpCommands.prepare).mock.calls[0]?.[0].preparation.selection).toMatchObject({ shareTerms: false, shareContext: true });
});

it.each([
  ["mcp-share-selection-source", "dependency-conflict", /save or select a translation based on the current source/],
  ["mcp-share-current", "dependency-conflict", /Saved data changed after this preview/],
  ["mcp-share-bytes", "limit-exceeded", /turn off optional terms or manual context/],
] as const)("offers contract-specific recovery while preserving input: %s", async (reason, code, message) => {
  vi.mocked(mcpCommands.prepare).mockRejectedValueOnce({ ...commandErrors.errors[0], stage: "execution-read", reason, code });
  open(); fireEvent.change(screen.getByRole("textbox", { name: "External recipient" }), { target: { value: "Recipient B preserved" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview exact shared content" }));
  await screen.findByText(message);
  expect(screen.getByRole("textbox", { name: "External recipient" })).toHaveValue("Recipient B preserved");
  expect(screen.getByRole("button", { name: "Close original sharing request" })).toBeEnabled();
  expect(mcpCommands.authorize).not.toHaveBeenCalled();
});

it("renders shared text literally without executing content or fetching embedded references", async () => {
  const text = '<img src="https://invalid.example/synthetic" onerror="invalid()">\n{{player}} 👩🏽‍💻 é';
  vi.mocked(mcpCommands.prepare).mockImplementationOnce(async request => {
    canonical = mcpView(request.preparation); const prepared = mcpPrepared(request.preparation); prepared.preview.payload.source.text = text; return prepared;
  });
  open(); await preview();
  expect(screen.getByText(/^<img src=/, { selector: "pre" }).textContent).toBe(text); expect(document.querySelector(".mcp-sharing-panel img")).toBeNull();
  expect(document.querySelector(".mcp-sharing-panel a")).toBeNull(); expect(mcpCommands.authorize).not.toHaveBeenCalled();
});

it("requires explicit reveal for the local credential and hides it again without persisting or rendering it elsewhere", async () => {
  const storage = vi.spyOn(Storage.prototype, "setItem"); open(); await preview(); await authorize();
  expect(screen.queryByRole("textbox", { name: "One-use MCP client configuration" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show client configuration" }));
  expect(screen.getByRole("textbox", { name: "One-use MCP client configuration" })).toHaveValue(JSON.stringify(mcpConfiguration, null, 2));
  fireEvent.click(screen.getByRole("button", { name: "Hide client configuration" }));
  expect(screen.queryByRole("textbox", { name: "One-use MCP client configuration" })).not.toBeInTheDocument();
  expect(storage.mock.calls.some(([, value]) => String(value).includes("synthetic-unusable-recipient-credential"))).toBe(false);
  expect(vi.mocked(mcpCommands.authorize).mock.calls[0]?.[0].authorization.validForSeconds).toBe(300);
});

it("keeps the original revoke control available during pending authorization and preserves newer recipient input", async () => {
  let finish!: (value: Awaited<ReturnType<typeof mcpCommands.authorize>>) => void;
  vi.mocked(mcpCommands.authorize).mockImplementation(async (request, preparation) => {
    canonical = mcpView(preparation, request.authorization); return new Promise(resolve => { finish = resolve; });
  });
  open(); await preview(); fireEvent.click(screen.getByRole("checkbox", { name: "I authorize this recipient to read exactly the content shown above under these limits." }));
  fireEvent.click(screen.getByRole("button", { name: "Create one-use client configuration" }));
  await waitFor(() => expect(mcpCommands.authorize).toHaveBeenCalledTimes(1));
  const original = structuredClone(currentView());
  fireEvent.change(screen.getByRole("textbox", { name: "External recipient" }), { target: { value: "New recipient B" } });
  expect(screen.getByRole("button", { name: "Revoke original permission" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Revoke original permission" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Close sharing draft" })).toBeEnabled());
  await act(async () => finish({ view: original, configuration: mcpConfiguration }));
  expect(screen.getByRole("textbox", { name: "External recipient" })).toHaveValue("New recipient B");
  expect(screen.queryByRole("button", { name: "Show client configuration" })).not.toBeInTheDocument();
});

it("shows a usable read replacement action while an original read is hung, and does not dispatch authorization", async () => {
  open(); await preview(); let finish!: (value: McpShareView) => void;
  vi.mocked(mcpCommands.read).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Check original sharing status" }));
  const replace = await screen.findByRole("button", { name: "Stop waiting and check the same sharing request" }); expect(replace).toBeEnabled();
  fireEvent.click(replace); await waitFor(() => expect(screen.getByRole("button", { name: "Check original sharing status" })).toBeEnabled());
  await act(async () => finish(currentView())); expect(mcpCommands.authorize).not.toHaveBeenCalled();
});

it("stops automatic status reads after failure and pauses them while collapsed or the document is hidden", async () => {
  open(); await preview(); vi.useFakeTimers();
  await act(async () => { owner.setConsent(true); await owner.authorize(); });
  let count = vi.mocked(mcpCommands.read).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(mcpCommands.read).toHaveBeenCalledTimes(count + 1);
  const details = screen.getByRole("heading", { name: "Share one saved entry" }).closest("details"); if (!details) throw new Error("Sharing details missing");
  act(() => { details.open = false; fireEvent(details, new Event("toggle")); }); count = vi.mocked(mcpCommands.read).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(mcpCommands.read).toHaveBeenCalledTimes(count);
  act(() => { details.open = true; fireEvent(details, new Event("toggle")); });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => { fireEvent(document, new Event("visibilitychange")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(mcpCommands.read).toHaveBeenCalledTimes(count);
  visibility.mockReturnValue("visible"); vi.mocked(mcpCommands.read).mockRejectedValueOnce(new Error("Synthetic status failure"));
  act(() => { fireEvent(document, new Event("visibilitychange")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(owner.state.readFailed).toBe(true); count = vi.mocked(mcpCommands.read).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(mcpCommands.read).toHaveBeenCalledTimes(count);
  expect(screen.getByRole("button", { name: "Retry this status read" })).toBeEnabled();
});

it("keeps the production sharing owner across areas and refuses project exit until the user explicitly closes its resolved draft", async () => {
  const actual = sharingOwner.useMcpSharing;
  vi.spyOn(sharingOwner, "useMcpSharing").mockImplementation(() => { const value = actual(); owner = value; return value; });
  render(<ProductionHarness />); act(() => { owner.begin(mcpTarget); owner.edit({ recipientLabel: "Retained project recipient" }); });
  await act(async () => { expect(await handle.current?.navigate({ kind: "area", area: "translation" })).toBe(true); });
  expect(area).toBe("translation"); expect(screen.getByRole("textbox", { name: "External recipient" })).toHaveValue("Retained project recipient");
  await act(async () => { expect(await handle.current?.navigate({ kind: "area", area: "overview" })).toBe(true); });
  expect(area).toBe("overview"); expect(screen.getByRole("textbox", { name: "External recipient" })).toHaveValue("Retained project recipient");
  await act(async () => { expect(await handle.current?.prepareExit()).toBeNull(); });
  expect(area).toBe("translation"); expect(screen.getByRole("button", { name: "Close sharing draft" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Close sharing draft" }));
  let permit!: Awaited<ReturnType<ProjectSessionHandle["prepareExit"]>>;
  await act(async () => { permit = await handle.current?.prepareExit() ?? null; });
  expect(permit?.current()).toBe(true); act(() => permit?.release()); expect(mcpCommands.authorize).not.toHaveBeenCalled();
});

it("keeps the same controls and field labels in Chinese", async () => {
  await i18n.changeLanguage("zh-CN"); open();
  expect(screen.getByRole("textbox", { name: "外部接收方" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "包含本条目已采用的术语" })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "关闭分享草稿" })).toBeEnabled();
});
