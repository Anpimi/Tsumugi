import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { useEffect } from "react";
import { TmxExchangePreviewPanel } from "./TmxExchangePreviewPanel";
import { SessionReadProvider, useSessionReads } from "./SessionReadProvider";
import { resourceCommands, type TmxFilePreview } from "./resourceCommands";
import type { SessionReads } from "./sessionReads";
import { i18n } from "./i18n";

const context = { projectId: "project-one", sessionToken: "session-one" };
const provenance = { creationTool: null, creationToolVersion: null, originalTmFormat: null,
  creationId: null, creationDate: null, changeId: null, changeDate: null };
const row = (ordinal: number) => ({ ordinal, tuid: `origin-${ordinal}`, sourceText: `Line ${ordinal}\n  next`, targetText: `译文 ${ordinal}`,
  status: "eligible" as const, reasons: [], effectiveSourceLocale: "en", tuProvenance: provenance,
  sourceProvenance: provenance, targetProvenance: provenance });
const report = (rows = [row(1)]): TmxFilePreview => ({ projectId: context.projectId, fileName: "memory.tmx",
  preview: { profile: "TMX 1.4 restricted plain text", digest: "a".repeat(64), byteLen: 123,
    sourceLocale: "en", targetLocale: "zh-CN", license: "unknown", header: provenance, rows,
    losses: [{ kind: "extra-language", field: "fr", count: 18,
      samples: [{ byteOffset: 24, ordinal: 1, path: "/tmx/body/tu[1]/tuv[3]" }], unlisted: 17 }] } });

let reads: SessionReads | undefined;
function CaptureReads() {
  const value = useSessionReads();
  useEffect(() => { reads = value; return () => { if (reads === value) reads = undefined; }; }, [value]);
  return null;
}
function Shell({ locale = "zh-CN", enabled = true, mounted = true }: { locale?: string; enabled?: boolean; mounted?: boolean }) {
  return <SessionReadProvider context={context} bridge={false}><CaptureReads />
    {mounted ? <TmxExchangePreviewPanel context={context} sourceLocale="en" locale={locale} enabled={enabled} /> : null}
  </SessionReadProvider>;
}

let preview: MockInstance<typeof resourceCommands.previewTmx>;
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  preview = vi.spyOn(resourceCommands, "previewTmx").mockResolvedValue(report());
});
afterEach(() => { cleanup(); preview.mockRestore(); reads = undefined; });

it("opens the picker only on demand and shows complete raw text with local paging and classified losses", async () => {
  const user = userEvent.setup();
  render(<Shell />);
  expect(preview).not.toHaveBeenCalled();
  preview.mockResolvedValueOnce(report(Array.from({ length: 21 }, (_, index) => row(index + 1))));
  await user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  expect(await screen.findByText("Line 1 next")).toBeInTheDocument();
  expect(preview).toHaveBeenCalledWith({ ...context, locale: "zh-CN" });
  expect(screen.getByText(/Showing 1–20 of 21/)).toBeInTheDocument();
  expect(screen.queryByText("Line 21 next")).not.toBeInTheDocument();
  expect(screen.getByText(/17 additional occurrence/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next translation units" }));
  expect(screen.getByText("Line 21 next")).toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(1);
});

it("shows an empty but successful file as a preview rather than a picker cancellation", async () => {
  const empty = report([]);
  preview.mockResolvedValueOnce({ ...empty, preview: { ...empty.preview, losses: [] } });
  const user = userEvent.setup();
  render(<Shell />);
  await user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  expect(await screen.findByText("The file contains no translation units.")).toBeInTheDocument();
  expect(screen.getByText("No unmapped categories were reported by this restricted parser.")).toBeInTheDocument();
  expect(screen.queryByText("No file was selected. Nothing was saved.")).not.toBeInTheDocument();
});

it("pages many loss categories locally while keeping their full counts and bounded source pointers", async () => {
  const original = report();
  const losses = Array.from({ length: 21 }, (_, index) => ({
    kind: "extra-language" as const, field: `language-${index + 1}`, count: index + 1,
    samples: index === 20 ? [{ byteOffset: 99, ordinal: 1, path: "/tmx/body/tu[1]/tuv[3]" }] : [],
    unlisted: index === 20 ? 20 : index + 1,
  }));
  preview.mockResolvedValueOnce({ ...original, preview: { ...original.preview, losses } });
  const user = userEvent.setup();
  render(<Shell />);
  await user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  expect(await screen.findByText(/Showing loss categories 1–20 of 21/)).toBeInTheDocument();
  expect(screen.getByText(/language-1 · 1 occurrence/)).toBeInTheDocument();
  expect(screen.queryByText(/language-21 · 21 occurrence/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next loss categories" }));
  expect(screen.getByText(/Showing loss categories 21–21 of 21/)).toBeInTheDocument();
  expect(screen.getByText(/language-21 · 21 occurrence/)).toBeInTheDocument();
  expect(screen.getByText(/20 additional occurrence/)).toBeInTheDocument();
  await user.click(screen.getByText("Original location samples (1)"));
  expect(screen.getByText(/byte 99 · translation unit 1/)).toBeVisible();
  expect(preview).toHaveBeenCalledTimes(1);
});

it("distinguishes a cancelled picker from a failed read and allows another explicit selection", async () => {
  const user = userEvent.setup();
  preview.mockReset().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("invalid XML")).mockResolvedValueOnce(report());
  render(<Shell />);
  const choose = screen.getByRole("button", { name: "Choose TMX file to preview" });
  await user.click(choose);
  expect(await screen.findByText("No file was selected. Nothing was saved.")).toBeInTheDocument();
  await user.click(choose);
  expect(await screen.findByRole("alert")).toHaveTextContent("The TMX file could not be previewed");
  await user.click(choose);
  expect(await screen.findByText("memory.tmx")).toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(3);
});

it("hides a late result after the target language changes and never reopens the picker automatically", async () => {
  let finish!: (value: TmxFilePreview) => void;
  preview.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(report());
  const user = userEvent.setup();
  const view = render(<Shell />);
  await user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  view.rerender(<Shell locale="fr" />);
  await act(async () => finish(report()));
  expect(screen.queryByText("memory.tmx")).not.toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(1);
  view.rerender(<Shell />);
  expect(screen.queryByText("memory.tmx")).not.toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
});

it("does not show cached results or reopen the picker after hiding, remounting, or project invalidation", async () => {
  const user = userEvent.setup();
  const view = render(<Shell />);
  await user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  expect(await screen.findByText("memory.tmx")).toBeInTheDocument();
  await act(async () => reads!.invalidate(["project"]));
  expect(screen.queryByText("memory.tmx")).not.toBeInTheDocument();
  view.rerender(<Shell enabled={false} />);
  view.rerender(<Shell enabled />);
  view.rerender(<Shell mounted={false} />);
  view.rerender(<Shell />);
  expect(screen.queryByText("memory.tmx")).not.toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
});

it("hides an exact Query record invalidated without a semantic bridge event", async () => {
  const user = userEvent.setup();
  render(<Shell />);
  await user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  expect(await screen.findByText("memory.tmx")).toBeInTheDocument();
  const record = reads!.client.getQueryCache().findAll({ predicate: value =>
    value.queryKey[2] === "tmx-exchange-preview" && value.state.status === "success" })[0];
  expect(record).toBeDefined();
  await act(async () => { await reads!.client.invalidateQueries({ queryKey: record.queryKey, exact: true, refetchType: "none" }); });
  expect(screen.queryByText("memory.tmx")).not.toBeInTheDocument();
  expect(screen.getByText(/This preview is no longer current/)).toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
});
