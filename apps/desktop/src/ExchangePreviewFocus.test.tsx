import contract from "../test/fixtures/projectChanges.contract.json";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionReadProvider, useSessionQuery, useSessionReads } from "./SessionReadProvider";
import type { SessionReads } from "./sessionReads";
import { TmxExchangePreviewPanel } from "./TmxExchangePreviewPanel";
import { TbxExchangePreviewPanel } from "./TbxExchangePreviewPanel";
import { resourceCommands, type TmxFilePreview, type TbxFilePreview } from "./resourceCommands";
import { i18n } from "./i18n";

const wire = vi.hoisted(() => ({ snapshot: null as unknown, invoke: vi.fn(), listen: vi.fn(),
  receive: null as ((event: { payload: unknown }) => void) | null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: wire.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: wire.listen }));

const context = { projectId: contract.request.projectId, sessionToken: contract.request.sessionToken };
const sourceLocale = "en-US", locale = "zh-CN";
const provenance = { creationTool: null, creationToolVersion: null, originalTmFormat: null,
  creationId: null, creationDate: null, changeId: null, changeDate: null };
const tmxReport: TmxFilePreview = { projectId: context.projectId, fileName: "selected.tmx",
  preview: { profile: "tmx-1.4b-plain-text-preview", digest: "a".repeat(64), byteLen: 385,
    sourceLocale, targetLocale: locale, license: "unknown", header: provenance, rows: [], losses: [] } };
const tbxReport: TbxFilePreview = { projectId: context.projectId, fileName: "selected.tbx",
  preview: { profile: "tbx-basic-dca-subset-preview", digest: "b".repeat(64), byteLen: 420,
    sourceLocale, targetLocale: locale, documentLocale: "en-US", license: "unknown",
    titles: [], sourceDescriptions: [], rows: [], losses: [] } };

let reads: SessionReads | null = null;
function CaptureReads() {
  const value = useSessionReads();
  useEffect(() => { reads = value; return () => { if (reads === value) reads = null; }; }, [value]);
  return null;
}
function MutableProbe({ read }: { read: () => Promise<string> }) {
  const result = useSessionQuery({ key: ["mutable-resource-probe"], scopes: ["resources"], enabled: true, read });
  return <span data-testid="mutable-resource">{result.data ?? "loading"}</span>;
}
function Shell({ format, read }: { format: "tmx" | "tbx"; read: () => Promise<string> }) {
  return <SessionReadProvider context={context}><CaptureReads /><MutableProbe read={read} />
    {format === "tmx" ? <TmxExchangePreviewPanel context={context} sourceLocale={sourceLocale} locale={locale} enabled />
      : <TbxExchangePreviewPanel context={context} sourceLocale={sourceLocale} locale={locale} enabled />}
  </SessionReadProvider>;
}
function currentReads() {
  if (!reads) throw new Error("Session bridge is not mounted");
  return reads;
}
async function bridgeReady() {
  await waitFor(() => expect(currentReads().client.getQueryData(currentReads().key(["runtime"]))).toBeDefined());
}
async function focusAndConfirm() {
  const before = wire.invoke.mock.calls.filter(call => call[0] === "read_project_changes").length;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await currentReads().synchronize();
  });
  await waitFor(() => expect(wire.invoke.mock.calls.filter(call => call[0] === "read_project_changes").length).toBeGreaterThan(before));
}
function deferredPreview(format: "tmx" | "tbx") {
  let finish: () => void = () => { throw new Error("The chooser did not start"); };
  const preview = format === "tmx"
    ? vi.spyOn(resourceCommands, "previewTmx").mockImplementation(() => new Promise<TmxFilePreview | null>(resolve => {
        finish = () => resolve(tmxReport);
      }))
    : vi.spyOn(resourceCommands, "previewTbx").mockImplementation(() => new Promise<TbxFilePreview | null>(resolve => {
        finish = () => resolve(tbxReport);
      }));
  return { preview, finish: () => finish(), file: format === "tmx" ? "selected.tmx" : "selected.tbx",
    choose: format === "tmx" ? "Choose TMX file to preview" : "Choose TBX file to preview" };
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  reads = null;
  wire.snapshot = { ...contract.snapshot, sequence: "0", progressSequence: "0" };
  wire.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "read_project_changes") return wire.snapshot;
    throw new Error(`Unexpected native command: ${command}`);
  });
  wire.receive = null;
  wire.listen.mockReset().mockImplementation(async (_event: string, receive: (event: { payload: unknown }) => void) => {
    wire.receive = receive;
    return () => { if (wire.receive === receive) wire.receive = null; };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); reads = null; });

it.each(["tmx", "tbx"] as const)("keeps the explicitly selected %s report through unchanged picker and later focus checks", async format => {
  const selected = deferredPreview(format), mutableRead = vi.fn(async () => "current");
  render(<Shell format={format} read={mutableRead} />);
  await bridgeReady();
  await waitFor(() => expect(screen.getByTestId("mutable-resource")).toHaveTextContent("current"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: selected.choose }));
  await waitFor(() => expect(selected.preview).toHaveBeenCalledTimes(1));
  await focusAndConfirm(); // Native chooser returns focus while its file read is still pending.
  await act(async () => selected.finish());
  expect(await screen.findByText(selected.file)).toBeInTheDocument();
  expect(screen.queryByText(/This preview is outdated/)).not.toBeInTheDocument();
  const reportQuery = currentReads().client.getQueryCache().findAll({ predicate: query =>
    query.queryKey[2] === `${format}-exchange-preview` && query.state.status === "success" })[0];
  expect(reportQuery?.state.isInvalidated).toBe(false);
  const mutableQuery = currentReads().client.getQueryCache().find({
    queryKey: currentReads().key(["mutable-resource-probe"]), exact: true,
  });
  await waitFor(() => expect(mutableQuery?.state.fetchStatus).toBe("idle"));
  const originalReadCount = mutableRead.mock.calls.length;
  await focusAndConfirm(); // The same session and sequence remain current after success.
  expect(screen.getByText(selected.file)).toBeInTheDocument();
  expect(screen.queryByText(/This preview is outdated/)).not.toBeInTheDocument();
  expect(reportQuery?.state.isInvalidated).toBe(false);
  await waitFor(() => expect(mutableRead.mock.calls.length).toBeGreaterThan(originalReadCount));
  expect(selected.preview).toHaveBeenCalledTimes(1);
});

it.each(["source", "resources", "project"] as const)("hides a pending explicit TMX read after a real %s change notification", async scope => {
  const selected = deferredPreview("tmx");
  render(<Shell format="tmx" read={async () => "current"} />);
  await bridgeReady();
  await userEvent.setup().click(screen.getByRole("button", { name: selected.choose }));
  await waitFor(() => expect(selected.preview).toHaveBeenCalledTimes(1));
  wire.snapshot = { ...contract.snapshot, sequence: "1", progressSequence: "0", scopes: [scope] };
  await act(async () => {
    wire.receive?.({ payload: { ...context, epoch: contract.snapshot.epoch, kind: "change",
      afterSequence: "0", sequence: "1", scopes: [scope] } });
    await new Promise(resolve => setTimeout(resolve, 75)); // Bridge coalesces notifications for 50 ms.
  });
  await act(async () => selected.finish());
  expect(screen.queryByText(selected.file)).not.toBeInTheDocument();
  expect(selected.preview).toHaveBeenCalledTimes(1);
});

it("hides a completed TBX report when the authoritative session epoch resets", async () => {
  const selected = deferredPreview("tbx");
  render(<Shell format="tbx" read={async () => "current"} />);
  await bridgeReady();
  await userEvent.setup().click(screen.getByRole("button", { name: selected.choose }));
  await waitFor(() => expect(selected.preview).toHaveBeenCalledTimes(1));
  await act(async () => selected.finish());
  expect(await screen.findByText(selected.file)).toBeInTheDocument();
  wire.snapshot = { ...contract.snapshot, epoch: "1717ef0a-6f02-4645-95a4-1790d37e708c",
    sequence: "0", progressSequence: "0", scopes: ["project"] };
  await focusAndConfirm();
  await waitFor(() => expect(screen.queryByText(selected.file)).not.toBeInTheDocument());
  expect(selected.preview).toHaveBeenCalledTimes(1);
});
