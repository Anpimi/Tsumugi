import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { i18n } from "../../../i18n";
import { sourcePageFixture } from "../../../testSupport/sourceFixture";
import type { ContentPage } from "../../../sourceCommands";
import SourceCaptureOverview from "./SourceCaptureOverview";

function sample(): ContentPage {
  const page = sourcePageFixture({ total: 13, nextOrdinal: 1 });
  const source = { artifactId: page.coverage[0].artifactId, range: { encoding: "raw-byte" as const, start: 0, end: 40 } };
  page.captureSummary = { materials: [{ source,
    properties: [{ label: "Format", values: ["Synthetic <script>alert('literal')</script> — 世界"] }, { label: "Dependencies", values: [] }],
    counts: { items: 10, itemsWithFields: 9, declaredFields: 14, nonEmptyFields: 13 },
    groups: [{ label: "Record with empty field", counts: { items: 10, itemsWithFields: 9, declaredFields: 14, nonEmptyFields: 13 } }] }] };
  return page;
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(() => cleanup());

it("shows complete capture counts and preserves empty values as distinct from absent summaries", () => {
  const page = sample();
  const { rerender } = render(<SourceCaptureOverview summary={page.captureSummary} coverage={page.coverage}/>);
  const region = screen.getByRole("region", { name: "Captured scope" });
  expect(within(region).getByRole("heading", { name: page.coverage[0].logicalPath })).toBeVisible();
  expect(within(region).getByText("Declared fields", { selector: "dt" })).toBeVisible();
  expect(within(region).getByText("14", { selector: "dd" })).toBeVisible();
  expect(within(region).getByText("Nonempty fields", { selector: "dt" })).toBeVisible();
  fireEvent.click(screen.getByText("Format and dependencies", { selector: "summary" }));
  expect(screen.getByText("Dependencies")).toBeVisible();
  expect(screen.getByText("None")).toBeVisible();
  rerender(<SourceCaptureOverview summary={null} coverage={page.coverage}/>);
  expect(screen.queryByRole("region", { name: "Captured scope" })).not.toBeInTheDocument();
});

it("renders plugin text literally and gives keyboard-scrollable record groups an accessible name", () => {
  const page = sample();
  const { container } = render(<SourceCaptureOverview summary={page.captureSummary} coverage={page.coverage}/>);
  fireEvent.click(screen.getByText("Format and dependencies", { selector: "summary" }));
  expect(screen.getByRole("region", { name: "Captured scope" })).toHaveTextContent("Synthetic <script>alert('literal')</script> — 世界");
  expect(container.querySelector("script")).toBeNull();
  const disclosure = screen.getByText("View record groups", { selector: "summary" });
  expect(disclosure.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(disclosure);
  const group = screen.getByRole("region", { name: `Record groups in ${page.coverage[0].logicalPath}` });
  expect(group).toHaveAttribute("tabindex", "0");
  expect(within(group).getByRole("columnheader", { name: "Record group" })).toBeVisible();
  expect(within(group).getByRole("rowheader", { name: "Record with empty field" })).toBeVisible();
});

it("replaces the read-only presentation when the result changes and localizes application labels", async () => {
  const page = sample();
  const { rerender } = render(<SourceCaptureOverview summary={page.captureSummary} coverage={page.coverage}/>);
  const next = structuredClone(page);
  next.coverage[0].logicalPath = "下一版/很长的来源文件名 — 👩🏽‍💻.bin";
  await act(() => i18n.changeLanguage("zh-CN"));
  rerender(<SourceCaptureOverview summary={next.captureSummary} coverage={next.coverage}/>);
  expect(screen.getByRole("region", { name: "本次捕获范围" })).toBeVisible();
  expect(screen.getByText("声明字段", { selector: "dt" })).toBeVisible();
  expect(screen.getByRole("heading", { name: next.coverage[0].logicalPath })).toBeVisible();
  expect(screen.queryByRole("heading", { name: page.coverage[0].logicalPath })).not.toBeInTheDocument();
});

it("reports an unmatched source instead of showing its internal identifier as a filename", () => {
  const page = sample();
  render(<SourceCaptureOverview summary={page.captureSummary} coverage={[]}/>);
  expect(screen.getByRole("alert")).toHaveTextContent("could not be matched to their source");
  expect(screen.queryByText(page.coverage[0].artifactId)).not.toBeInTheDocument();
});
