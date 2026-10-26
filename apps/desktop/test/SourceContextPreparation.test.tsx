import { useState, type ComponentProps } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defaultAiConfig, editedAiConfig, sameAiConfig, validSourceContextSelection } from "../src/aiCommands";
import { SourceContextChoice, SourceContextPreview } from "../src/SourceContextPreparation";
import { i18n } from "../src/i18n";

type Capture = ComponentProps<typeof SourceContextPreview>["capture"];
const id = (number: number) => `60000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const sourceReference = { artifactId: "synthetic-source", range: { encoding: "utf8-byte" as const, start: 0, end: 4 } };

function selectedCapture(): Capture {
  return {
    kind: "selected",
    value: {
      scope: { projectId: id(1), sourceSnapshotId: id(2), unitId: id(3), sourceRevisionId: id(4), locale: "zh-CN" },
      contentRevision: "1", sourceAttemptId: id(5), sourceResultId: id(6), sourceResultDigest: "a".repeat(64),
      sourceLocale: "en", localUnitId: "unit-local",
      selection: { extracted: true, inferred: true, neighbors: true, maxBytes: 16384, maxItems: 128 },
      observations: { missingBlocks: false, knownBlocks: 1, knownFacts: 2, emptyBlocks: 0, unknownBlocks: 0,
        unknownRequiredBlocks: 0, neighborOccurrences: 1, unknownSamples: [] },
      facts: [
        { blockIndex: 0, factIndex: 0, target: { kind: "occurrence", id: "occ-local" },
          schema: { id: "synthetic.source-context", schemaVersion: 1, behaviorVersion: 1 }, handling: "preserve", inRevisionBasis: true,
          fact: { id: "speaker", kind: "speaker", text: "Mira 👩🏽‍🚀", origin: { kind: "extracted", sources: [sourceReference] } } },
        { blockIndex: 0, factIndex: 1, target: { kind: "occurrence", id: "occ-local" },
          schema: { id: "synthetic.source-context", schemaVersion: 1, behaviorVersion: 1 }, handling: "preserve", inRevisionBasis: true,
          fact: { id: "role", kind: "role", text: "captain", origin: { kind: "inferred", rationale: "the dialogue addresses the captain", sources: [sourceReference] } } },
      ],
      neighbors: [{ unitId: id(7), sourceRevisionId: id(8), text: "Earlier original line",
        occurrence: { occurrenceId: id(9), localOccurrenceId: "neighbor-local", source: sourceReference },
        adjacentTo: [{ occurrenceId: id(10), direction: "before" }] }],
      omissions: { extracted: 0, inferred: 0, neighbors: 0, notSelected: 0, byteBudget: 0, itemLimit: 0, samples: [] },
    },
  };
}

function Choice() {
  const [value, setValue] = useState(defaultAiConfig.sourceContext);
  return <SourceContextChoice value={value} onChange={setValue} />;
}

beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(cleanup);

it("starts with all source groups off independently of existing term and human-context sharing", () => {
  expect(defaultAiConfig.sourceContext).toEqual({ extracted: false, inferred: false, neighbors: false, maxBytes: 16384, maxItems: 128 });
  expect(sameAiConfig(defaultAiConfig, { ...defaultAiConfig, shareTerms: true })).toBe(false);
  expect(sameAiConfig(defaultAiConfig, { ...defaultAiConfig, shareContext: true })).toBe(false);
  render(<Choice />);
  for (const name of ["Include extracted source facts", "Include source inferences and rationale", "Include adjacent source lines"])
    expect(screen.getByRole("checkbox", { name })).not.toBeChecked();
  expect(screen.getByText(i18n.t("sourceContext.notSelected"))).toBeInTheDocument();
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
});

it("selects extracted facts, inferences and neighbors separately without changing other groups", async () => {
  const user = userEvent.setup();
  render(<Choice />);
  const extracted = screen.getByRole("checkbox", { name: "Include extracted source facts" });
  const inferred = screen.getByRole("checkbox", { name: "Include source inferences and rationale" });
  const neighbors = screen.getByRole("checkbox", { name: "Include adjacent source lines" });
  await user.click(inferred);
  expect(inferred).toBeChecked(); expect(extracted).not.toBeChecked(); expect(neighbors).not.toBeChecked();
  expect(screen.getByText(/Selected categories: 1/)).toBeInTheDocument();
  await user.click(neighbors);
  expect(inferred).toBeChecked(); expect(neighbors).toBeChecked(); expect(extracted).not.toBeChecked();
  await user.click(inferred);
  expect(inferred).not.toBeChecked(); expect(neighbors).toBeChecked();
});

it("keeps invalid budget input visible and rejects nonintegers and out-of-range values", async () => {
  const user = userEvent.setup();
  render(<Choice />);
  await user.click(screen.getByRole("checkbox", { name: "Include extracted source facts" }));
  const bytes = screen.getByRole("spinbutton", { name: "Source context byte limit (UTF-8)" });
  const items = screen.getByRole("spinbutton", { name: "Maximum source context items" });
  await user.clear(bytes);
  expect(bytes).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText(i18n.t("sourceContext.invalidBudget"))).toBeInTheDocument();
  await user.type(bytes, "16385");
  expect(bytes).toHaveValue(16385); expect(bytes).toHaveAttribute("aria-invalid", "true");
  await user.clear(bytes); await user.type(bytes, "27");
  await user.clear(items); await user.type(items, "129");
  expect(items).toHaveValue(129); expect(items).toHaveAttribute("aria-invalid", "true");
  await user.clear(items); await user.type(items, "1");
  expect(bytes).not.toHaveAttribute("aria-invalid"); expect(items).not.toHaveAttribute("aria-invalid");
  expect(screen.queryByText(i18n.t("sourceContext.invalidBudget"))).not.toBeInTheDocument();
  for (const value of [0, 1, 26, 1.5, Number.NaN, Infinity, 16385])
    expect(validSourceContextSelection({ ...defaultAiConfig.sourceContext, maxBytes: value })).toBe(false);
  for (const value of [0, 1.5, Number.NaN, Infinity, 129])
    expect(validSourceContextSelection({ ...defaultAiConfig.sourceContext, maxItems: value })).toBe(false);
});

it("treats every source category and budget as a captured configuration change without detaching a saved connection", () => {
  const reference = { storeId: id(11), profileId: id(12), revision: "1", digest: "b".repeat(64) };
  const before = { ...defaultAiConfig, connectionProfile: reference };
  for (const [key, value] of [["extracted", true], ["inferred", true], ["neighbors", true], ["maxBytes", 2048], ["maxItems", 4]] as const) {
    const after = { ...before, sourceContext: { ...before.sourceContext, [key]: value } };
    expect(sameAiConfig(before, after)).toBe(false);
    expect(editedAiConfig(before, after).connectionProfile).toEqual(reference);
    expect(sameAiConfig(after, { ...after, sourceContext: { ...after.sourceContext } })).toBe(true);
  }
});

it("labels a disabled capture as unshared without implying missing source evidence", () => {
  render(<SourceContextPreview capture={{ kind: "not-selected" }} />);
  expect(screen.getByText(i18n.t("sourceContext.notSelected"))).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("sourceContext.missing"))).not.toBeInTheDocument();
});

it("shows original fact origins, inference rationale and local source ranges in the captured preview", () => {
  render(<SourceContextPreview capture={selectedCapture()} />);
  const preview = screen.getByRole("region", { name: i18n.t("sourceContext.title") });
  expect(within(preview).getByText("Mira 👩🏽‍🚀")).toBeInTheDocument();
  expect(within(preview).getByText("captain")).toBeInTheDocument();
  expect(within(preview).getByText(/Extracted from source/)).toBeInTheDocument();
  expect(within(preview).getByText(/Inferred \(unconfirmed\)/)).toBeInTheDocument();
  expect(within(preview).getByText("Inference rationale: the dialogue addresses the captain")).toBeInTheDocument();
  expect(within(preview).getAllByText("synthetic-source · utf8-byte range [0, 4)")).toHaveLength(2);
});

it("shows adjacent original position and separately counts excluded, byte-limited and item-limited entries", () => {
  const capture = selectedCapture();
  if (capture.kind !== "selected") throw new Error("Expected selected capture");
  capture.value.neighbors[0].adjacentTo.push({ occurrenceId: id(13), direction: "after" });
  capture.value.observations = { ...capture.value.observations, knownFacts: 7, neighborOccurrences: 2 };
  capture.value.omissions = { extracted: 3, inferred: 2, neighbors: 1, notSelected: 3, byteBudget: 2, itemLimit: 1, samples: [{kind:"fact",blockIndex:4,factIndex:1,reason:"byte-budget"},{kind:"neighbor",occurrenceId:id(14),reason:"not-selected"}] };
  render(<SourceContextPreview capture={capture} />);
  expect(screen.getByText("Source line appearing both before and after occurrences of this entry")).toBeInTheDocument();
  expect(screen.getByText(i18n.t("sourceContext.excluded", { count: 3 }))).toBeInTheDocument();
  expect(screen.getByText(i18n.t("sourceContext.byteOmissions", { count: 2 }))).toBeInTheDocument();
  expect(screen.getByText(i18n.t("sourceContext.itemOmissions", { count: 1 }))).toBeInTheDocument();
  expect(screen.getByText(i18n.t("sourceContext.unsampled", {count:4}))).toBeInTheDocument();
  expect(screen.getByText("Block 4, fact 1: byte limit reached.")).toBeInTheDocument();
  expect(screen.getByText(`Source occurrence ${id(14)}: category not selected.`)).toBeInTheDocument();
  expect(screen.getByText("Omitted items: extracted 3 · inferred 2 · adjacent lines 1.")).toBeInTheDocument();
});

it("keeps absent, explicitly empty and unavailable source-fact blocks distinct", () => {
  const capture = selectedCapture();
  if (capture.kind !== "selected") throw new Error("Expected selected capture");
  capture.value.facts = []; capture.value.neighbors = [];
  capture.value.observations = { ...capture.value.observations, missingBlocks: true, knownBlocks: 0, knownFacts: 0, neighborOccurrences: 0 };
  const view = render(<SourceContextPreview capture={capture} />);
  expect(screen.getByText(i18n.t("sourceContext.missing"))).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("sourceContext.empty", { count: 1 }))).not.toBeInTheDocument();

  capture.value.observations = { ...capture.value.observations, missingBlocks: false, knownBlocks: 1, emptyBlocks: 1 };
  view.rerender(<SourceContextPreview capture={{ ...capture, value: { ...capture.value } }} />);
  expect(screen.getByText(i18n.t("sourceContext.empty", { count: 1 }))).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("sourceContext.missing"))).not.toBeInTheDocument();

  capture.value.observations = { ...capture.value.observations, knownBlocks: 0, emptyBlocks: 0, unknownBlocks: 2 };
  view.rerender(<SourceContextPreview capture={{ ...capture, value: { ...capture.value } }} />);
  expect(screen.getByText(i18n.t("sourceContext.unknown", { count: 2 }))).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("sourceContext.empty", { count: 1 }))).not.toBeInTheDocument();
});
