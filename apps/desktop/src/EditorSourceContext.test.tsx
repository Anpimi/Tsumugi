import { type ComponentProps } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorSourceContext } from "./EditorSourceContext";
import { SessionReadProvider } from "./SessionReadProvider";
import { sourceCommands, type SourceContextBlock, type SourceContextNeighbor, type SourceContextPage } from "./sourceCommands";
import { i18n } from "./i18n";

vi.mock("./sourceCommands", () => ({ sourceCommands: { sourceContext: vi.fn() } }));
const read = vi.mocked(sourceCommands.sourceContext);
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
beforeEach(async () => { await i18n.changeLanguage("en-US"); read.mockReset(); });
afterEach(cleanup);

it("reads only after the parent enables the current editor reference", async () => {
  read.mockResolvedValue(page([]));
  const rendered = render(view(scope, false));
  expect(read).not.toHaveBeenCalled();
  rendered.rerender(view());
  await screen.findByText("No source observation entries are available for this item.");
  expect(read).toHaveBeenCalledWith({ ...context, ...scope, after: 0, limit: 4 });
});

it("keeps extracted facts, inferred rationale, source references and neighbors distinct", async () => {
  const entries = [block(0, { facts: [
    { id: "speaker", kind: "speaker", text: "Mira 👩🏽‍🚀", origin: { kind: "extracted", sources: [source] } },
    { id: "role", kind: "role", text: "captain", origin: { kind: "inferred", rationale: "addressed as captain", sources: [source] } },
  ] }), neighbor()];
  read.mockResolvedValue(page(entries));
  render(view());
  const panel = await screen.findByRole("region", { name: "Original source observations" });
  await within(panel).findByText("Mira 👩🏽‍🚀");
  expect(within(panel).getByText("captain")).toBeInTheDocument();
  expect(within(panel).getByText(/Inference, not a confirmed fact/)).toBeInTheDocument();
  expect(within(panel).getByText("Inference rationale: addressed as captain")).toBeInTheDocument();
  expect(within(panel).getAllByText("synthetic-source · utf8-byte range [0, 4)")).toHaveLength(3);
  expect(within(panel).getByText("Original adjacent before and after occurrences of this entry")).toBeInTheDocument();
  expect(within(panel).getByText("Previous original line")).toBeInTheDocument();
  expect(within(panel).getByText("Source entries loaded: 2 of 2.")).toBeInTheDocument();
});

it("distinguishes missing, explicitly empty and unknown required blocks", async () => {
  const user = userEvent.setup();
  const entries = [block(0, { facts: [] }), block(1, null, "required")];
  const result = page(entries);
  result.observations = { ...result.observations, knownBlocks: 1, knownFacts: 0, emptyBlocks: 1,
    unknownBlocks: 1, unknownRequiredBlocks: 1, neighborOccurrences: 0 };
  read.mockResolvedValue(result);
  render(view());
  expect(await screen.findByText("This block explicitly contains no source facts.")).toBeInTheDocument();
  expect(screen.getByText("This block requires an unavailable version; its contents were not interpreted.")).toBeInTheDocument();
  expect(screen.getByText(/Source blocks with an unavailable required version: 1/)).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("sourceContext.missing"))).not.toBeInTheDocument();
  const missing = page([]);
  missing.observations = { ...missing.observations, missingBlocks: true, knownBlocks: 0, knownFacts: 0,
    emptyBlocks: 0, unknownBlocks: 0, unknownRequiredBlocks: 0, neighborOccurrences: 0 };
  read.mockResolvedValue(missing);
  await user.click(screen.getByRole("button", { name: "Refresh source observations" }));
  expect(await screen.findByText(i18n.t("sourceContext.missing"))).toBeInTheDocument();
  expect(screen.queryByText("This block requires an unavailable version; its contents were not interpreted.")).not.toBeInTheDocument();
});

it("loads bounded pages using the previous cursor and original source basis", async () => {
  const first = page([block(0), block(1), block(2), block(3)], 0, 5, 4);
  const second = page([neighbor()], 4, 5, null);
  read.mockImplementation(async request => request.after === 0 ? first : second);
  const user = userEvent.setup(); render(view());
  await screen.findByText("Source entries loaded: 4 of 5.");
  await user.click(screen.getByRole("button", { name: "Load more source observations" }));
  expect(await screen.findByText("Previous original line")).toBeInTheDocument();
  expect(screen.getByText("Source entries loaded: 5 of 5.")).toBeInTheDocument();
  expect(read.mock.calls.map(([request]) => request.after)).toEqual([0, 4]);
});

it("hides previous pages if the source result changes before the next page", async () => {
  const first = page([block(0), block(1), block(2), block(3)], 0, 5, 4);
  const changed = page([neighbor()], 4, 5); changed.sourceResultDigest = "b".repeat(64);
  read.mockImplementation(async request => request.after === 0 ? first : changed);
  const user = userEvent.setup(); render(view());
  await screen.findByText("Source entries loaded: 4 of 5.");
  await user.click(screen.getByRole("button", { name: "Load more source observations" }));
  expect(await screen.findByText(/The source changed between pages/)).toBeInTheDocument();
  expect(screen.queryByText("Source-fact block 1")).not.toBeInTheDocument();
});

it("shows a failed read and retries it without treating the result as empty", async () => {
  read.mockRejectedValue(new Error("read unavailable"));
  const user = userEvent.setup(); render(view());
  expect(await screen.findByText(/Source observations could not be read/)).toBeInTheDocument();
  expect(screen.queryByText("No source observation entries are available for this item.")).not.toBeInTheDocument();
  read.mockResolvedValue(page([block(0)]));
  await user.click(screen.getByRole("button", { name: "Retry source read" }));
  expect(await screen.findByText("Source-fact block 1")).toBeInTheDocument();
});

it("hides old facts when the draft source changes, retaining only review guidance", async () => {
  read.mockResolvedValue(page([block(0)]));
  const rendered = render(view());
  await screen.findByText("Source-fact block 1");
  rendered.rerender(view(null, true, true));
  expect(screen.getByText(/source changed while your earlier translation draft was kept/)).toBeInTheDocument();
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
