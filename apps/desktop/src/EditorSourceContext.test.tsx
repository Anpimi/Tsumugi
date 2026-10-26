import { type ComponentProps } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorSourceContext } from "./EditorSourceContext";
import { SessionReadProvider } from "./SessionReadProvider";
import { sourceCommands, sourceContextBlockBasis, type SourceContextBlock, type SourceContextBlockDetail, type SourceContextNeighbor, type SourceContextPage } from "./sourceCommands";
import { i18n } from "./i18n";

vi.mock("./sourceCommands", async () => {
  const actual = await vi.importActual<typeof import("./sourceCommands")>("./sourceCommands");
  return { ...actual, sourceCommands: { ...actual.sourceCommands, sourceContext: vi.fn(), sourceContextBlock: vi.fn() } };
});
const read = vi.mocked(sourceCommands.sourceContext);
const readBlock = vi.mocked(sourceCommands.sourceContextBlock);
const id = (number: number) => `60000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const context = { projectId: id(1), sessionToken: "isolated-source-reference" };
type Scope = NonNullable<ComponentProps<typeof EditorSourceContext>["scope"]>;
const scope: Scope = { projectId: context.projectId, sourceSnapshotId: id(2), unitId: id(3), sourceRevisionId: id(4), locale: "zh-CN" };
const source = { artifactId: "synthetic-source", range: { encoding: "utf8-byte" as const, start: 0, end: 4 } };

function block(index: number, facts: SourceContextBlock["facts"] = { facts: [] }, handling: SourceContextBlock["handling"] = "preserve"): SourceContextPage["entries"][number] {
  return { kind: "block", value: { blockIndex: index, target: { kind: "occurrence", id: "original-occurrence" },
    schema: { id: "synthetic.source-context", schemaVersion: 1, behaviorVersion: 1 }, handling, inRevisionBasis: true, facts } };
}
function neighbor(): SourceContextPage["entries"][number] {
  const value: SourceContextNeighbor = { unitId: id(5), sourceRevisionId: id(6),
    occurrence: { occurrenceId: id(7), localOccurrenceId: "neighbor-occurrence", source }, text: "Previous original line",
    adjacentTo: [{ occurrenceId: id(8), direction: "before" }, { occurrenceId: id(9), direction: "after" }] };
  return { kind: "neighbor", value };
}
function storedBlock(index: number, payloadUtf8: string): Extract<SourceContextPage["entries"][number], { kind: "stored-block" }> {
  return { kind: "stored-block", value: { blockIndex: index, target: { kind: "occurrence", id: "original-occurrence" },
    schema: { id: "synthetic.original-record", schemaVersion: 1, behaviorVersion: 1 }, handling: "preserve", inRevisionBasis: false,
    payloadBytes: new TextEncoder().encode(payloadUtf8).byteLength } };
}
function page(entries: SourceContextPage["entries"], after = 0, totalEntries = entries.length,
  nextAfter: number | null = null, currentScope = scope): SourceContextPage {
  return { scope: currentScope, contentRevision: "7", sourceAttemptId: id(10), sourceResultId: id(11),
    sourceResultDigest: "a".repeat(64), sourceLocale: "en", localUnitId: "unit-local", occurrenceCount: 2,
    observations: { missingBlocks: false, knownBlocks: 1, knownFacts: 2, emptyBlocks: 0, unknownBlocks: 0,
      unknownRequiredBlocks: 0, neighborOccurrences: 1, unknownSamples: [] },
    entries, after, totalEntries, nextAfter };
}
function view(currentScope: Scope | null = scope, enabled = true, sourceChanged = false) {
  return <SessionReadProvider context={context} bridge={false}>
    <EditorSourceContext context={context} scope={currentScope} enabled={enabled} sourceChanged={sourceChanged} />
  </SessionReadProvider>;
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); read.mockReset(); readBlock.mockReset(); });
afterEach(cleanup);

it("reads only after the parent enables the current editor reference", async () => {
  read.mockResolvedValue(page([]));
  const rendered = render(view(scope, false));
  expect(read).not.toHaveBeenCalled();
  rendered.rerender(view());
  await screen.findByText("No source context items are available for this entry.");
  expect(read).toHaveBeenCalledWith({ ...context, ...scope, after: 0, limit: 4 });
});

it("keeps extracted facts, inferred rationale, source references and neighbors distinct", async () => {
  const entries = [block(0, { facts: [
    { id: "speaker", kind: "speaker", text: "Mira 👩🏽‍🚀", origin: { kind: "extracted", sources: [source] } },
    { id: "role", kind: "role", text: "captain", origin: { kind: "inferred", rationale: "addressed as captain", sources: [source] } },
  ] }), neighbor()];
  read.mockResolvedValue(page(entries));
  render(view());
  const panel = await screen.findByRole("region", { name: "Source context details" });
  await within(panel).findByText("Mira 👩🏽‍🚀");
  expect(within(panel).getByText("captain")).toBeInTheDocument();
  expect(within(panel).getByText(/Inferred \(unconfirmed\)/)).toBeInTheDocument();
  expect(within(panel).getByText("Inference rationale: addressed as captain")).toBeInTheDocument();
  expect(within(panel).getAllByText("synthetic-source · utf8-byte range [0, 4)")).toHaveLength(3);
  expect(within(panel).getByText("Source line appearing both before and after occurrences of this entry")).toBeInTheDocument();
  expect(within(panel).getByText("Previous original line")).toBeInTheDocument();
  expect(within(panel).getByText("Source context items loaded: 2 of 2.")).toBeInTheDocument();
});

it("distinguishes missing, explicitly empty and unknown required blocks", async () => {
  const user = userEvent.setup();
  const entries = [block(0, { facts: [] }), block(1, null, "required")];
  const result = page(entries);
  result.observations = { ...result.observations, knownBlocks: 1, knownFacts: 0, emptyBlocks: 1,
    unknownBlocks: 1, unknownRequiredBlocks: 1, neighborOccurrences: 0 };
  read.mockResolvedValue(result);
  render(view());
  expect(await screen.findByText("This block contains no source facts.")).toBeInTheDocument();
  expect(screen.getByText("This block requires an unsupported version (contents not read).")).toBeInTheDocument();
  expect(screen.getByText(/Source blocks requiring an unsupported version: 1/)).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("sourceContext.missing"))).not.toBeInTheDocument();
  const missing = page([]);
  missing.observations = { ...missing.observations, missingBlocks: true, knownBlocks: 0, knownFacts: 0,
    emptyBlocks: 0, unknownBlocks: 0, unknownRequiredBlocks: 0, neighborOccurrences: 0 };
  read.mockResolvedValue(missing);
  await user.click(screen.getByRole("button", { name: "Refresh source context" }));
  expect(await screen.findByText(i18n.t("sourceContext.missing"))).toBeInTheDocument();
  expect(screen.queryByText("This block requires an unsupported version (contents not read).")).not.toBeInTheDocument();
});

it("loads bounded pages using the previous cursor and original source basis", async () => {
  const first = page([block(0), block(1), block(2), block(3)], 0, 5, 4);
  const second = page([neighbor()], 4, 5, null);
  read.mockImplementation(async request => request.after === 0 ? first : second);
  const user = userEvent.setup(); render(view());
  await screen.findByText("Source context items loaded: 4 of 5.");
  await user.click(screen.getByRole("button", { name: "Load more source context" }));
  expect(await screen.findByText("Previous original line")).toBeInTheDocument();
  expect(screen.getByText("Source context items loaded: 5 of 5.")).toBeInTheDocument();
  expect(read.mock.calls.map(([request]) => request.after)).toEqual([0, 4]);
});

it("hides previous pages if the source result changes before the next page", async () => {
  const first = page([block(0), block(1), block(2), block(3)], 0, 5, 4);
  const changed = page([neighbor()], 4, 5); changed.sourceResultDigest = "b".repeat(64);
  read.mockImplementation(async request => request.after === 0 ? first : changed);
  const user = userEvent.setup(); render(view());
  await screen.findByText("Source context items loaded: 4 of 5.");
  await user.click(screen.getByRole("button", { name: "Load more source context" }));
  expect(await screen.findByText(/The source changed while loading pages/)).toBeInTheDocument();
  expect(screen.queryByText("Source-fact block 1")).not.toBeInTheDocument();
});

it("shows a failed read and retries it without treating the result as empty", async () => {
  read.mockRejectedValue(new Error("read unavailable"));
  const user = userEvent.setup(); render(view());
  expect(await screen.findByText(/Could not load source context/)).toBeInTheDocument();
  expect(screen.queryByText("No source context items are available for this entry.")).not.toBeInTheDocument();
  read.mockResolvedValue(page([block(0)]));
  await user.click(screen.getByRole("button", { name: "Retry loading source context" }));
  expect(await screen.findByText("Source-fact block 1")).toBeInTheDocument();
});

it("hides old facts when the draft source changes, retaining only review guidance", async () => {
  read.mockResolvedValue(page([block(0)]));
  const rendered = render(view());
  await screen.findByText("Source-fact block 1");
  rendered.rerender(view(null, true, true));
  expect(screen.getByText(/source text changed while your translation draft was kept/)).toBeInTheDocument();
  expect(screen.queryByText("Source-fact block 1")).not.toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(1);
});

it("keeps a late response for another editor target out of the current view", async () => {
  let finish!: (value: SourceContextPage) => void;
  const later = { ...scope, unitId: id(20), sourceRevisionId: id(21) };
  read.mockImplementation(request => request.unitId === scope.unitId
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(page([block(9)], 0, 1, null, later)));
  const rendered = render(view());
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  rendered.rerender(view(later));
  expect(await screen.findByText("Source-fact block 10")).toBeInTheDocument();
  await act(async () => finish(page([block(0)])));
  expect(screen.queryByText("Source-fact block 1")).not.toBeInTheDocument();
});

it("reads only the explicitly opened original record and preserves its literal text", async () => {
  const payloadUtf8 = '{\r\n "tick":18446744073709551615, "settings":"line:90% 世界", "literal":"<script>record</script>"\r\n}';
  const first = storedBlock(2, payloadUtf8), second = storedBlock(3, "unopened record"), result = page([block(0), first, second, neighbor()]);
  read.mockResolvedValue(result);
  readBlock.mockResolvedValue({ basis: sourceContextBlockBasis(result), descriptor: first.value, payloadUtf8 });
  const user = userEvent.setup(), rendered = render(view());
  await screen.findByText("Additional source record 3");
  expect(readBlock).not.toHaveBeenCalled();
  expect(screen.getByText("Previous original line")).toBeInTheDocument();
  expect(screen.getByText("Source-fact block 1")).toBeInTheDocument();
  await user.click(screen.getAllByRole("button", { name: "View raw record" })[0]);
  const record = await screen.findByRole("region", { name: "Read-only raw record" });
  await waitFor(() => expect(record.querySelector("pre")?.textContent).toBe(payloadUtf8));
  expect(record.querySelector("pre")?.childNodes).toHaveLength(1);
  expect(rendered.container.querySelector("script")).toBeNull();
  expect(readBlock).toHaveBeenCalledExactlyOnceWith({ ...context, basis: sourceContextBlockBasis(result), descriptor: first.value });
  expect(screen.queryByText("unopened record")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close raw record" })).toHaveAttribute("aria-expanded", "true");
  await user.click(screen.getByRole("button", { name: "Close raw record" }));
  expect(screen.queryByRole("region", { name: "Read-only raw record" })).not.toBeInTheDocument();
});

it("retries a failed record independently at its exact basis and descriptor", async () => {
  const first = storedBlock(0, "first original"), second = storedBlock(1, "second original"), result = page([first, second]);
  read.mockResolvedValue(result);
  readBlock.mockImplementation(async request => {
    if (request.descriptor.blockIndex === 0) throw new Error("record unavailable");
    return { basis: request.basis, descriptor: request.descriptor, payloadUtf8: "second original" };
  });
  const user = userEvent.setup(); render(view());
  await screen.findByText("Additional source record 1");
  const [openFirst, openSecond] = screen.getAllByRole("button", { name: "View raw record" });
  await user.click(openFirst);
  expect(await screen.findByText(/Could not load the raw record/)).toBeInTheDocument();
  await user.click(openSecond);
  expect(await screen.findByText("second original")).toBeInTheDocument();
  readBlock.mockResolvedValueOnce({ basis: sourceContextBlockBasis(result), descriptor: first.value, payloadUtf8: "first original" });
  await user.click(screen.getByRole("button", { name: "Retry loading raw record" }));
  expect(await screen.findByText("first original")).toBeInTheDocument();
  expect(screen.getByText("second original")).toBeInTheDocument();
  expect(readBlock.mock.calls[2][0]).toEqual(readBlock.mock.calls[0][0]);
  expect(read).toHaveBeenCalledTimes(1);
});

it("renders a complete two MiB original record as one plain text node", async () => {
  const payloadUtf8 = `"${"x".repeat(2 * 1024 * 1024 - 2)}"`, entry = storedBlock(0, payloadUtf8), result = page([entry]);
  read.mockResolvedValue(result);
  readBlock.mockResolvedValue({ basis: sourceContextBlockBasis(result), descriptor: entry.value, payloadUtf8 });
  const user = userEvent.setup(); render(view());
  await user.click(await screen.findByRole("button", { name: "View raw record" }));
  const record = await screen.findByRole("region", { name: "Read-only raw record" });
  await waitFor(() => expect(record.querySelector("pre")?.textContent).toBe(payloadUtf8));
  expect(record.querySelector("pre")?.childNodes).toHaveLength(1);
  expect(entry.value.payloadBytes).toBe(2 * 1024 * 1024);
});

it("keeps a pending record closed when its late read finishes and rereads only on reopening", async () => {
  const entry = storedBlock(0, "late original"), result = page([entry]);
  let finish!: (value: SourceContextBlockDetail) => void;
  read.mockResolvedValue(result);
  readBlock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const user = userEvent.setup(); render(view());
  await user.click(await screen.findByRole("button", { name: "View raw record" }));
  await screen.findByText("Loading raw record…");
  await user.click(screen.getByRole("button", { name: "Close raw record" }));
  const detail = { basis: sourceContextBlockBasis(result), descriptor: entry.value, payloadUtf8: "late original" };
  await act(async () => finish(detail));
  expect(screen.queryByText("late original")).not.toBeInTheDocument();
  readBlock.mockResolvedValueOnce(detail);
  await user.click(screen.getByRole("button", { name: "View raw record" }));
  expect(await screen.findByText("late original")).toBeInTheDocument();
  expect(readBlock).toHaveBeenCalledTimes(2);
});

it("keeps stored records on their original metadata page until explicitly opened", async () => {
  const payloadUtf8 = "paged original record", entry = storedBlock(4, payloadUtf8);
  const first = page([block(0), block(1), block(2), block(3)], 0, 5, 4), second = page([entry], 4, 5);
  read.mockImplementation(async request => request.after === 0 ? first : second);
  readBlock.mockResolvedValue({ basis: sourceContextBlockBasis(second), descriptor: entry.value, payloadUtf8 });
  const user = userEvent.setup(); render(view());
  await user.click(await screen.findByRole("button", { name: "Load more source context" }));
  await screen.findByText("Additional source record 5");
  expect(readBlock).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "View raw record" }));
  expect(await screen.findByText(payloadUtf8)).toBeInTheDocument();
  expect(readBlock).toHaveBeenCalledWith({ ...context, basis: sourceContextBlockBasis(second), descriptor: entry.value });
});

it("closes old record details on source refresh and rejects the old pending display", async () => {
  const oldEntry = storedBlock(0, "old result record"), oldPage = page([oldEntry]);
  let finish!: (value: SourceContextBlockDetail) => void;
  read.mockResolvedValueOnce(oldPage);
  readBlock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const user = userEvent.setup(); render(view());
  await user.click(await screen.findByRole("button", { name: "View raw record" }));
  await screen.findByText("Loading raw record…");
  const newEntry = storedBlock(0, "new result record"), newPage = { ...page([newEntry]), sourceResultId: id(30), sourceResultDigest: "b".repeat(64) };
  read.mockResolvedValue(newPage);
  await user.click(screen.getByRole("button", { name: "Refresh source context" }));
  await screen.findByRole("button", { name: "View raw record" });
  await act(async () => finish({ basis: sourceContextBlockBasis(oldPage), descriptor: oldEntry.value, payloadUtf8: "old result record" }));
  expect(screen.queryByText("old result record")).not.toBeInTheDocument();
  expect(readBlock).toHaveBeenCalledTimes(1);
  readBlock.mockResolvedValueOnce({ basis: sourceContextBlockBasis(newPage), descriptor: newEntry.value, payloadUtf8: "new result record" });
  await user.click(screen.getByRole("button", { name: "View raw record" }));
  expect(await screen.findByText("new result record")).toBeInTheDocument();
  expect(readBlock.mock.calls[1][0].basis.sourceResultId).toBe(id(30));
});

it("isolates late original records across cue changes and replacement project sessions", async () => {
  const oldEntry = storedBlock(0, "old cue original"), oldPage = page([oldEntry]);
  const nextScope = { ...scope, unitId: id(20), sourceRevisionId: id(21) }, nextEntry = storedBlock(1, "new cue original");
  const nextPage = page([nextEntry], 0, 1, null, nextScope);
  let finishOld!: (value: SourceContextBlockDetail) => void, finishCue!: (value: SourceContextBlockDetail) => void;
  read.mockImplementation(async request => request.unitId === scope.unitId ? oldPage : nextPage);
  readBlock.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishCue = resolve; }));
  const user = userEvent.setup(), rendered = render(view());
  await user.click(await screen.findByRole("button", { name: "View raw record" }));
  await waitFor(() => expect(readBlock).toHaveBeenCalledTimes(1));
  rendered.rerender(view(nextScope));
  await user.click(await screen.findByRole("button", { name: "View raw record" }));
  await waitFor(() => expect(readBlock).toHaveBeenCalledTimes(2));
  await act(async () => finishOld({ basis: sourceContextBlockBasis(oldPage), descriptor: oldEntry.value, payloadUtf8: "old cue original" }));
  expect(screen.queryByText("old cue original")).not.toBeInTheDocument();
  const replacement = { ...context, sessionToken: "replacement-source-session" };
  rendered.rerender(<SessionReadProvider key={replacement.sessionToken} context={replacement} bridge={false}>
    <EditorSourceContext context={replacement} scope={nextScope} enabled />
  </SessionReadProvider>);
  await screen.findByRole("button", { name: "View raw record" });
  await act(async () => finishCue({ basis: sourceContextBlockBasis(nextPage), descriptor: nextEntry.value, payloadUtf8: "new cue original" }));
  expect(screen.queryByText("new cue original")).not.toBeInTheDocument();
  readBlock.mockResolvedValueOnce({ basis: sourceContextBlockBasis(nextPage), descriptor: nextEntry.value, payloadUtf8: "new cue original" });
  await user.click(screen.getByRole("button", { name: "View raw record" }));
  expect(await screen.findByText("new cue original")).toBeInTheDocument();
  expect(readBlock.mock.calls[2][0].sessionToken).toBe(replacement.sessionToken);
});
