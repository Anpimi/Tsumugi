import { useLayoutEffect } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { useResourceDraftSession } from "./ResourceDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { executionCommands } from "./executionCommands";
import { resourceCommands } from "./resourceCommands";
import { mcpRetrievalCommands as commands, type McpRetrievalView } from "./mcpRetrievalCommands";
import { retrievalKey } from "./McpRetrievalSession";
import { retrievalProject as project, retrievalSource, retrievalView, retrievalCapture, retrievalResourcePreview } from "./testSupport/mcpRetrievalFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
const invoke = vi.hoisted(() => vi.fn()); vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let resource: ReturnType<typeof useResourceDraftSession>, reads: ReturnType<typeof useSessionReads>, canonical: McpRetrievalView | null, sequence: number, generation: number;
function Probe() { const owner = useResourceDraftSession(), queries = useSessionReads(); useLayoutEffect(() => { resource = owner; reads = queries; }); return null; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function tool() { return resource.tool; } function owner() { return tool().mcp; }
function view() { if (!canonical) throw new Error("Synthetic retrieval record missing"); return canonical; }
function draft(text = retrievalSource.rows[0].occurrence.text) { act(() => { tool().setMode("mcp"); tool().editMcp({ endpoint: "https://example.invalid/mcp", credentialEnv: "TSUMUGI_MCP_CLIENT_SYNTHETIC",
  retrievalUnit: { unitId: id(9302), sourceSnapshotId: id(9301), sourceRevisionId: id(9303), label: "Synthetic entry" } });
  tool().setTarget("zh-CN"); tool().setRows([{ id: 0, text }]); tool().edit(); }); }
async function discover() { await act(async () => { await owner().discover(); }); act(() => tool().editMcp({ mcpToolName: "find_terms" })); }
async function prepare() { await act(async () => { await owner().prepare(() => true); }); }
async function start() { act(() => owner().setConsent(true)); await act(async () => { await owner().start(() => true); }); }
beforeEach(() => {
  vi.restoreAllMocks(); invoke.mockReset(); canonical = null; sequence = 9400; generation = 1;
  vi.spyOn(executionCommands, "identity").mockImplementation(async () => id(++sequence));
  vi.spyOn(commands, "session").mockImplementation(async () => ({ nextGeneration: String(generation), current: canonical?.identity ?? null, lifetimeMs: 120_000, maxTools: 32, maxQueryBytes: 16_384, maxResultBytes: 65_536, maxEntries: 100 }));
  vi.spyOn(commands, "discover").mockImplementation(async request => { canonical = retrievalView(request.discovery); generation++; return structuredClone(canonical); });
  vi.spyOn(commands, "read").mockImplementation(async () => structuredClone(view()));
  vi.spyOn(commands, "prepare").mockImplementation(async request => { canonical = retrievalView(view().discovery, request.query); return structuredClone(canonical); });
  vi.spyOn(commands, "start").mockImplementation(async () => { canonical = retrievalView(view().discovery, view().query, "closed"); return structuredClone(canonical); });
  vi.spyOn(commands, "stop").mockImplementation(async request => { canonical = { ...view(), phase: "closed", stop: request.stop, admissionClosed: true, callbacksDrained: true };
    return { request: request.stop, view: structuredClone(canonical) }; });
  vi.spyOn(commands, "capture").mockImplementation(async request => retrievalCapture(request.actionId, view().query!));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("mounts and edits only the original resource query draft without any discovery, identity or model call", () => {
  render(<Probe/>, project); draft(); expect(tool().current().rows[0].text).toContain("Barrel"); expect(owner().current().operation).toBeNull();
  expect(commands.session).not.toHaveBeenCalled(); expect(commands.discover).not.toHaveBeenCalled(); expect(executionCommands.identity).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
});
it("requires a separate exact preview and consent, retains input B and never sends the later value", async () => {
  render(<Probe/>, project); draft(); await discover(); await prepare();
  const request = owner().current().operation!.query!, original = request.query.query;
  await act(async () => { await owner().start(() => true); }); expect(commands.start).not.toHaveBeenCalled();
  const ack = deferred<McpRetrievalView>(); vi.mocked(commands.start).mockImplementationOnce(() => ack.promise);
  act(() => owner().setConsent(true)); let started!: Promise<void>; act(() => { started = owner().start(() => true); });
  act(() => { tool().setRows([{ id: 0, text: "Later B" }]); tool().edit(); resource.editTerm({ ...resource.current().termDraft, source: "Manual B", target: "人工", reason: "Separate manual draft" }); });
  await act(async () => { canonical = retrievalView(view().discovery, request.query, "closed"); ack.resolve(structuredClone(canonical)); await started; });
  expect(tool().current().rows[0].text).toBe("Later B"); expect(resource.current().termDraft.source).toBe("Manual B"); expect(owner().current().operation?.preview?.arguments.query).toBe(original);
  expect(vi.mocked(commands.start).mock.calls[0][2].query).toBe(original); expect(tool().hasDraft()).toBe(true);
});
it("invalidates consent after a newer query edit while preserving the original preview", async () => {
  render(<Probe/>, project); draft(); await discover(); await prepare(); act(() => owner().setConsent(true));
  const preview = owner().current().operation!.preview; act(() => { tool().setRows([{ id: 0, text: "Barrel" }]); tool().edit(); });
  expect(owner().current().consent).toBe(false); expect(owner().current().stale).toBe(true); expect(owner().current().operation!.preview).toBe(preview);
  await act(async () => { await owner().start(() => true); }); expect(commands.start).not.toHaveBeenCalled();
});
it("keeps a malformed start ACK unknown instead of claiming task acceptance", async () => {
  render(<Probe/>, project); draft(); await discover(); await prepare(); vi.mocked(commands.start).mockRestore();
  invoke.mockResolvedValueOnce({ ...view(), phase: "closed", query: null, preview: null, consent: null, task: null, admissionClosed: true, callbacksDrained: true });
  await start(); expect(owner().current().operation!.unknown).toBe("start"); expect(owner().blocked()).toBe(true); expect(owner().current().failure).not.toBeNull();
});
it("keeps a malformed stop ACK pending until exact closure is read and explicitly ends only the local wait", async () => {
  render(<Probe/>, project); draft(); await discover(); vi.mocked(commands.stop).mockRestore();
  invoke.mockImplementation(async (_command, { request }) => ({ request: request.stop, view: { ...view(), phase: "closed", stop: null, admissionClosed: true, callbacksDrained: true } }));
  await act(async () => { await owner().stop(); }); expect(owner().current().stop?.unknown).toBe(true); expect(owner().blocked()).toBe(true);
  canonical = { ...view(), phase: "closed", admissionClosed: true, callbacksDrained: true };
  await act(async () => { await owner().read(); }); expect(owner().canEndWait()).toBe(true); act(() => { expect(owner().endWait()).toBe(true); });
  expect(owner().current().stop?.ended).toBe(true); expect(owner().blocked()).toBe(false); expect(owner().current().operation?.ended).toBe(true);
});
it("stops independently during a hung discovery and ignores its late open response", async () => {
  render(<Probe/>, project); draft(); const wait = deferred<McpRetrievalView>();
  vi.mocked(commands.discover).mockImplementationOnce(async request => { canonical = { ...retrievalView(request.discovery), phase: "discovering", tools: [], callbacksDrained: false }; return wait.promise; });
  let discovering!: Promise<void>; act(() => { discovering = owner().discover(); }); await waitFor(() => expect(owner().current().operation).not.toBeNull());
  const original = structuredClone(view()); await act(async () => { await owner().stop(); await owner().read(); });
  act(() => { expect(owner().endWait()).toBe(true); }); expect(owner().blocked()).toBe(false);
  await act(async () => { wait.resolve(original); await discovering; }); expect(owner().current().operation!.closed).toBe(true); expect(owner().status()?.admissionClosed).toBe(true);
});
it("can recheck a hung local read without reconnecting and prevents its late A from overwriting the exact later read", async () => {
  render(<Probe/>, project); draft(); await discover(); const first = deferred<McpRetrievalView>(); vi.mocked(commands.read).mockImplementationOnce(() => first.promise);
  let reading!: Promise<void>; act(() => { reading = owner().read(); }); const original = structuredClone(view());
  canonical = { ...view(), phase: "closed", admissionClosed: true, callbacksDrained: true };
  await act(async () => { await owner().retryRead(); }); const closed = owner().status();
  await act(async () => { first.resolve(original); await reading; }); expect(owner().status()).toBe(closed); expect(owner().current().operation!.closed).toBe(true);
  expect(commands.discover).toHaveBeenCalledTimes(1); expect(commands.start).not.toHaveBeenCalled();
});
it("allows an independent exact stop after natural closure while real callbacks are still draining", async () => {
  render(<Probe/>, project); draft(); await discover(); const discovery = view().discovery;
  canonical = { ...view(), phase: "closed", admissionClosed: true, callbacksDrained: false };
  await act(async () => { await owner().read(); }); expect(owner().blocked()).toBe(true);
  await act(async () => { await owner().stop(); });
  expect(commands.stop).toHaveBeenCalledTimes(1); expect(vi.mocked(commands.stop).mock.calls[0][0].stop.discovery).toEqual(discovery);
  expect(owner().current().operation!.drained).toBe(true); expect(owner().blocked()).toBe(false); expect(commands.start).not.toHaveBeenCalled();
});
it("does not turn natural closure into confirmation of an unknown start and can explicitly end its wait", async () => {
  render(<Probe/>, project); draft(); await discover(); await prepare(); const pending = deferred<McpRetrievalView>(); vi.mocked(commands.start).mockImplementationOnce(() => pending.promise);
  act(() => owner().setConsent(true)); let started!: Promise<void>; act(() => { started = owner().start(() => true); });
  const enqueued = retrievalView(view().discovery, view().query, "enqueued"); canonical = { ...view(), phase: "closed", admissionClosed: true, callbacksDrained: true };
  await act(async () => { await owner().read(); }); expect(owner().current().operation!.unknown).toBe("start"); expect(owner().canEndWait()).toBe(true);
  act(() => owner().endWait()); await act(async () => { pending.resolve(enqueued); await started; });
  expect(owner().current().operation!.ended).toBe(true); expect(owner().status()?.task).toBeNull(); expect(owner().blocked()).toBe(false);
});
it("creates a new generation only after exact original closure and preserves B against late A", async () => {
  render(<Probe/>, project); draft(); await discover(); await act(async () => { await owner().stop(); });
  const first = owner().current().operation!.discovery.discovery.identity; act(() => { expect(owner().close()).toBe(true); tool().editMcp({ endpoint: "https://second.invalid/mcp" }); });
  await act(async () => { await owner().discover(); }); const second = owner().current().operation!.discovery.discovery;
  expect(second.identity.generation).toBe("2"); expect(second.identity.actionId).not.toBe(first.actionId); expect(second.endpoint).toBe("https://second.invalid/mcp");
  expect(commands.discover).toHaveBeenCalledTimes(2); expect(reads.client.getQueryData(reads.key(retrievalKey(first)))).toBeDefined();
});
it("reads an existing active record without restoring its previous consent or starting another discovery", async () => {
  render(<Probe/>, project); draft(); canonical = retrievalView(undefined, undefined); const prior = view().discovery;
  await act(async () => { await owner().discover(); }); expect(owner().current().operation!.discovery.discovery).toEqual(prior); expect(owner().current().consent).toBe(false); expect(owner().current().stale).toBe(true);
  expect(commands.discover).not.toHaveBeenCalled(); expect(commands.start).not.toHaveBeenCalled();
});
it("reconciles an unknown capture by original action receipt and retains independent manual B", async () => {
  render(<Probe/>, project); draft(); await discover(); await prepare(); await start(); const captured = deferred<ReturnType<typeof retrievalCapture>>(); vi.mocked(commands.capture).mockImplementationOnce(() => captured.promise);
  let capturing!: Promise<void>; act(() => { capturing = owner().capture(view().query!.attemptId, id(9314)); }); await waitFor(() => expect(owner().current().capture).not.toBeNull());
  const request = owner().current().capture!.request, receipt = retrievalCapture(request.actionId, view().query!);
  vi.spyOn(executionCommands, "receipt").mockResolvedValue(receipt.receipt); vi.spyOn(resourceCommands, "preview").mockResolvedValue(retrievalResourcePreview(receipt));
  act(() => resource.editTerm({ ...resource.current().termDraft, source: "Manual B", target: "B", reason: "Separate" }));
  await act(async () => { await owner().readCapture(); }); expect(owner().current().capture!.value?.captureId).toBe(request.actionId); expect(owner().blocked()).toBe(false);
  expect(resource.canReceiveMcp(receipt.capture)).toBe(false); expect(resource.current().termDraft.source).toBe("Manual B");
  await act(async () => { captured.resolve(receipt); await capturing; }); expect(owner().current().capture!.value?.captureId).toBe(request.actionId);
  expect(commands.capture).toHaveBeenCalledTimes(1); expect(executionCommands.receipt).toHaveBeenCalledWith({ sessionToken: project.sessionToken, projectId: project.metadata.projectId, actionId: request.actionId });
});
it("keeps requests with the project owner when their consumer unmounts and never discovers again on return", async () => {
  const rendered = render(<Probe/>, project); draft(); await discover(); const original = owner().current().operation;
  rendered.rerender(null); rendered.rerender(<Probe/>); expect(owner().current().operation).toBe(original); expect(commands.discover).toHaveBeenCalledTimes(1); expect(commands.start).not.toHaveBeenCalled();
});
