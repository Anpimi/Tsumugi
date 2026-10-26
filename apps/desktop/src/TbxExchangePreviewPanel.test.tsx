import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { useEffect } from "react";
import { TbxExchangePreviewPanel } from "./TbxExchangePreviewPanel";
import { SessionReadProvider, useSessionReads } from "./SessionReadProvider";
import { resourceCommands, type TbxExchangeRow, type TbxFilePreview, type TbxLossEntry, type TbxTermPreview } from "./resourceCommands";
import type { SessionReads } from "./sessionReads";
import type { SessionRequest } from "./executionCommands";
import { i18n } from "./i18n";
import { ResourceWorkbench } from "./ResourceWorkbench";
import { renderWorkbench } from "./testSupport/WorkbenchTestShell";
import type { ProjectView } from "./projectCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const context: SessionRequest = { projectId: "project-one", sessionToken: "session-one" };
const term = (ordinal: number, overrides: Partial<TbxTermPreview> = {}): TbxTermPreview => ({
  languageOrdinal: 1, ordinal, termSecId: `term-${ordinal}`, text: `Source ${ordinal}`,
  usageStatuses: [], sources: [], reasons: [], ...overrides,
});
const row = (ordinal: number, overrides: Partial<TbxExchangeRow> = {}): TbxExchangeRow => ({
  ordinal, conceptId: `concept-${ordinal}`, sourceTerms: [term(1)],
  targetTerms: [term(1, { languageOrdinal: 2, text: "目标" })],
  status: "possible-mapping", reasons: [], ...overrides,
});
const schemaHint: TbxLossEntry = { kind: "schema-hint", field: "xml-model", count: 2,
  samples: [{ byteOffset: 23, ordinal: null, path: "/" }], unlisted: 1 };
const report = (rows: TbxExchangeRow[] = [row(1)], losses: TbxLossEntry[] = [schemaHint]): TbxFilePreview => ({
  projectId: context.projectId, fileName: "dictionary.tbx",
  preview: { profile: "tbx-basic-dca-subset-preview", digest: "a".repeat(64), byteLen: 456,
    sourceLocale: "en", targetLocale: "zh-CN", documentLocale: "de-DE", license: "unknown",
    titles: ["A multilingual glossary"], sourceDescriptions: ["Contributor statement, unverified"], rows, losses },
});

let reads: SessionReads | undefined;
function CaptureReads() {
  const value = useSessionReads();
  useEffect(() => { reads = value; return () => { if (reads === value) reads = undefined; }; }, [value]);
  return null;
}
function Shell({ value = context, sourceLocale = "en", locale = "zh-CN", enabled = true, mounted = true }: {
  value?: SessionRequest; sourceLocale?: string; locale?: string; enabled?: boolean; mounted?: boolean;
}) {
  return <SessionReadProvider key={`${value.projectId}:${value.sessionToken}`} context={value} bridge={false}><CaptureReads />
    {mounted ? <TbxExchangePreviewPanel context={value} sourceLocale={sourceLocale} locale={locale} enabled={enabled} /> : null}
  </SessionReadProvider>;
}

let preview: MockInstance<typeof resourceCommands.previewTbx>;
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  preview = vi.spyOn(resourceCommands, "previewTbx").mockResolvedValue(report());
});
afterEach(() => { cleanup(); preview.mockRestore(); reads = undefined; });

it("opens the chooser only on click and pages concepts and term candidates without hiding original positions", async () => {
  const user = userEvent.setup();
  const first = row(1, { sourceTerms: Array.from({ length: 21 }, (_, index) => term(index + 1)) });
  preview.mockResolvedValueOnce(report([first, ...Array.from({ length: 20 }, (_, index) => row(index + 2))]));
  const view = render(<Shell />);
  expect(preview).not.toHaveBeenCalled();
  view.rerender(<Shell />);
  expect(preview).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Choose TBX file to preview" }));
  expect(await screen.findByText("dictionary.tbx")).toBeInTheDocument();
  expect(preview).toHaveBeenCalledWith({ ...context, locale: "zh-CN" });
  expect(screen.getByText(/Showing concepts 1–20 of 21/)).toBeInTheDocument();
  expect(screen.queryByText("Source 1")).not.toBeInTheDocument();
  await user.click(screen.getAllByRole("button", { name: "View all term candidates" })[0]);
  expect(screen.getByText("Source 1")).toBeInTheDocument();
  expect(screen.queryByText("Source 21")).not.toBeInTheDocument();
  expect(screen.getByText(/Language section 1, term section 1 ·/)).toBeInTheDocument();
  await user.click(screen.getAllByRole("button", { name: "Next candidate terms" })[0]);
  expect(screen.getByText("Source 21")).toBeInTheDocument();
  expect(screen.getByText(/Language section 1, term section 21/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next concepts" }));
  expect(screen.getByText(/File concept 21/)).toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(1);
});

it("keeps Unicode whitespace, null, empty text, literal statuses and direct sources distinct", async () => {
  const raw = "\u00a0日 本\n  語 ";
  preview.mockResolvedValueOnce(report([row(1, { conceptId: null, sourceTerms: [term(1, {
    termSecId: null, text: raw, usageStatuses: ["preferred", "unrecognized", "preferred"],
    sources: ["Direct source\n  line"],
  }), term(2, { text: "" }), term(3, { text: null, reasons: ["missing-term"] })],
  status: "excluded", reasons: ["ambiguous-source"] })], [
    { kind: "unknown-usage-status", field: "unrecognized", count: 1, samples: [], unlisted: 1 },
    { kind: "duplicate-usage-status", field: "usageStatus", count: 2, samples: [], unlisted: 2 },
  ]));
  const user = userEvent.setup();
  render(<Shell />);
  await user.click(screen.getByRole("button", { name: "Choose TBX file to preview" }));
  expect(await screen.findByText("dictionary.tbx")).toBeInTheDocument();
  expect(screen.getByText(/Multiple source language sections or usable term candidates/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "View all term candidates" }));
  const original = screen.getByText(/日 本/);
  expect(original.textContent).toBe(raw);
  expect(original).toHaveStyle({ whiteSpace: "pre-wrap" });
  expect(screen.getAllByText("Not provided").length).toBeGreaterThan(0);
  expect(screen.getByText("Empty text")).toBeInTheDocument();
  expect(screen.getByText(/Term issues: Missing term/)).toBeInTheDocument();
  expect(screen.queryByText("Direct source line")).not.toBeInTheDocument();
  await user.click(screen.getAllByRole("button", { name: "File usage statuses and direct term sources" })[0]);
  expect(screen.getAllByText("preferred").length).toBeGreaterThanOrEqual(2);
  expect(screen.getAllByText("unrecognized").length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText(/Direct source/).textContent).toBe("Direct source\n  line");
  expect(screen.getByText(/Unknown usage status/)).toBeInTheDocument();
  expect(screen.getByText(/Duplicate usage status/)).toBeInTheDocument();
});

it("labels license, schema hints, quality and document language honestly, with metadata on demand", async () => {
  const user = userEvent.setup();
  render(<Shell />);
  await user.click(screen.getByRole("button", { name: "Choose TBX file to preview" }));
  expect(await screen.findByText("dictionary.tbx")).toBeInTheDocument();
  expect(screen.getByText(/License, usage rights, provenance, and term quality are unverified/)).toBeInTheDocument();
  expect(screen.getByText(/Reported from the file metadata/)).toBeInTheDocument();
  expect(screen.getByText(/External schemas are never fetched or executed/)).toBeInTheDocument();
  expect(screen.getByText("de-DE")).toBeInTheDocument();
  expect(screen.getByText(/Ignored schema hint/)).toBeInTheDocument();
  expect(screen.getByText(/1 additional occurrence/)).toBeInTheDocument();
  expect(screen.queryByText("A multilingual glossary")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "File titles and source descriptions (unverified)" }));
  expect(screen.getByText("A multilingual glossary")).toBeInTheDocument();
  expect(screen.getByText("Contributor statement, unverified")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Sample locations (1)" }));
  expect(screen.getByText(/byte 23 · concept outside a concept/)).toBeInTheDocument();
});

it("distinguishes an empty file from chooser cancellation, a failed read and explicit retry", async () => {
  const empty = report([], []);
  preview.mockReset().mockResolvedValueOnce(empty).mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("invalid TBX XML")).mockResolvedValueOnce(report());
  const user = userEvent.setup();
  render(<Shell />);
  const choose = screen.getByRole("button", { name: "Choose TBX file to preview" });
  await user.click(choose);
  expect(await screen.findByText("The file contains no concepts.")).toBeInTheDocument();
  expect(screen.getByText("No unmapped items were reported by this preview parser.")).toBeInTheDocument();
  await user.click(choose);
  expect(await screen.findByText("No file selected. Nothing was saved.")).toBeInTheDocument();
  await user.click(choose);
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not preview the TBX file");
  await user.click(choose);
  expect(await screen.findByText("dictionary.tbx")).toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(4);
});

it("pages loss categories locally and keeps complete counts and original pointers", async () => {
  const losses: TbxLossEntry[] = Array.from({ length: 21 }, (_, index) => ({
    kind: "unknown-data-category", field: `field-${index + 1}`, count: index + 1,
    samples: index === 20 ? [{ byteOffset: 99, ordinal: 1, path: "/tbx/text/body/conceptEntry" }] : [],
    unlisted: index === 20 ? 20 : index + 1,
  }));
  preview.mockResolvedValueOnce(report([row(1)], losses));
  const user = userEvent.setup();
  render(<Shell />);
  await user.click(screen.getByRole("button", { name: "Choose TBX file to preview" }));
  expect(await screen.findByText(/Showing unmapped categories 1–20 of 21/)).toBeInTheDocument();
  expect(screen.queryByText("field-21")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next unmapped categories" }));
  expect(screen.getByText("field-21")).toBeInTheDocument();
  expect(screen.getByText(/20 additional occurrence/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Sample locations (1)" }));
  expect(screen.getByText(/byte 99 · concept 1/)).toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(1);
});

it("hides late responses across source, target and session changes without another automatic chooser", async () => {
  let finish!: (value: TbxFilePreview) => void;
  let finishSession!: (value: TbxFilePreview) => void;
  preview.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishSession = resolve; }));
  const user = userEvent.setup();
  const view = render(<Shell />);
  await user.click(screen.getByRole("button", { name: "Choose TBX file to preview" }));
  view.rerender(<Shell sourceLocale="fr" />);
  view.rerender(<Shell sourceLocale="fr" locale="ja" />);
  await act(async () => finish(report()));
  expect(screen.queryByText("dictionary.tbx")).not.toBeInTheDocument();
  view.rerender(<Shell />);
  expect(screen.queryByText("dictionary.tbx")).not.toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Choose TBX file to preview" }));
  view.rerender(<Shell value={{ ...context, sessionToken: "session-two" }} />);
  await act(async () => finishSession(report()));
  expect(preview).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("dictionary.tbx")).not.toBeInTheDocument();
});

it("hides old reports on semantic and exact invalidation, hiding and remounting", async () => {
  const user = userEvent.setup();
  const view = render(<Shell />);
  await user.click(screen.getByRole("button", { name: "Choose TBX file to preview" }));
  expect(await screen.findByText("dictionary.tbx")).toBeInTheDocument();
  const record = reads!.client.getQueryCache().findAll({ predicate: value =>
    value.queryKey[2] === "tbx-exchange-preview" && value.state.status === "success" })[0];
  expect(record).toBeDefined();
  await act(async () => { await reads!.client.invalidateQueries({ queryKey: record.queryKey, exact: true, refetchType: "none" }); });
  expect(screen.queryByText("dictionary.tbx")).not.toBeInTheDocument();
  expect(screen.getByText(/This preview is outdated/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Choose TBX file to preview" }));
  expect(await screen.findByText("dictionary.tbx")).toBeInTheDocument();
  await act(async () => reads!.invalidate(["resources"]));
  expect(screen.queryByText("dictionary.tbx")).not.toBeInTheDocument();
  view.rerender(<Shell enabled={false} />);
  view.rerender(<Shell />);
  view.rerender(<Shell mounted={false} />);
  view.rerender(<Shell />);
  expect(screen.queryByText("dictionary.tbx")).not.toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(2);
});

it("keeps the native picker gate closed after stopping a wait, including panel remount", async () => {
  let finish!: (value: TbxFilePreview | null) => void;
  preview.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(report());
  const user = userEvent.setup();
  const view = render(<Shell />);
  await user.click(screen.getByRole("button", { name: "Choose TBX file to preview" }));
  await user.click(screen.getByRole("button", { name: "Cancel TBX preview wait" }));
  expect(screen.getByRole("button", { name: "Choose TBX file to preview" })).toBeDisabled();
  expect(screen.getByText(/file chooser is still open/)).toBeInTheDocument();
  view.rerender(<Shell mounted={false} />);
  view.rerender(<Shell />);
  expect(screen.getByRole("button", { name: "Choose TBX file to preview" })).toBeDisabled();
  await act(async () => finish(report()));
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose TBX file to preview" })).toBeEnabled());
  expect(screen.queryByText("dictionary.tbx")).not.toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(1);
});

it("rejects a wrong profile or association and never treats that report as current", async () => {
  const wrong = report();
  preview.mockResolvedValueOnce({ ...wrong, preview: { ...wrong.preview, profile: "other-dialect" } });
  preview.mockResolvedValueOnce({ ...wrong, projectId: "other-project" });
  preview.mockResolvedValueOnce({ ...wrong, preview: { ...wrong.preview, sourceLocale: "fr" } });
  const user = userEvent.setup();
  render(<Shell />);
  const choose = screen.getByRole("button", { name: "Choose TBX file to preview" });
  for (let count = 1; count <= 3; count++) {
    await user.click(choose);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not preview the TBX file");
    expect(screen.queryByText("dictionary.tbx")).not.toBeInTheDocument();
    expect(preview).toHaveBeenCalledTimes(count);
  }
});

it("leaves the existing glossary draft intact when the preview fails in the resource workbench", async () => {
  const project: ProjectView = {
    sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled",
    metadata: { projectId: fixtureIdentity(405), displayName: "Demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" },
  };
  const page = sourcePageFixture({
    snapshotId: fixtureIdentity(400), scope: { revision: "2", currentSnapshot: fixtureIdentity(400) },
    rows: [sourceRowFixture({ unitId: fixtureIdentity(401), sourceRevisionId: fixtureIdentity(402) }, { ordinal: 0, key: "barrel", text: "Barrel" })],
  });
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "read_content_scope") return page.scope;
    if (command === "read_source_content") return page;
    if (command === "read_terms" || command === "list_resource_captures") return [];
    if (command === "create_execution_identity") return fixtureIdentity(1);
    throw new Error(command);
  });
  preview.mockRejectedValueOnce(new Error("malformed TBX"));
  const user = userEvent.setup();
  renderWorkbench(<ResourceWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" });
  await user.type(screen.getByRole("textbox", { name: "Source term" }), "Draft source");
  await user.type(screen.getByRole("textbox", { name: "Preferred target form" }), "稿");
  await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  await user.click(screen.getByRole("button", { name: "Choose TBX file to preview" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not preview the TBX file");
  await user.click(screen.getByRole("tab", { name: "Terms" }));
  expect(screen.getByRole("textbox", { name: "Source term" })).toHaveValue("Draft source");
  expect(screen.getByRole("textbox", { name: "Preferred target form" })).toHaveValue("稿");
  expect(invoke.mock.calls.some(([command]) => command === "save_term")).toBe(false);
});
