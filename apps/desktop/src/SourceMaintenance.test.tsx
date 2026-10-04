import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LineageEvidenceView } from "./SourceMaintenance";
import { i18n } from "./i18n";
import type { LineageEvidence } from "./sourceCommands";
import type { ProjectView } from "./projectCommands";
import { validateResponseLineage } from "./generated/source.validators";
import fixture from "../test/fixtures/sourceCommands.contract.json";
import { sourcePageFixture } from "./testSupport/sourceFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: fixture.session.sessionToken, locator: "isolated-project", reconciliationState: "settled",
  metadata: { projectId: fixture.session.projectId, displayName: "Synthetic project", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };

function lineageFixture(): LineageEvidence[] {
  if (!validateResponseLineage(fixture.lineage)) throw new Error("Invalid synthetic source lineage fixture");
  return structuredClone(fixture.lineage);
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); });
afterEach(cleanup);

it.each([
  ["en-US", "Source location and identity", "UTF-16 code units range [2, 8)"],
  ["zh-CN", "来源位置与身份", "UTF-16 码元范围 [2, 8)"],
])("keeps an original identity spelling and labels its source coordinate encoding in %s", async (locale, origin, range) => {
  await i18n.changeLanguage(locale);
  const evidence = lineageFixture();
  evidence[0].old.occurrence.nativeIdentity!.value = "canonical-name";
  evidence[0].old.occurrence.nativeIdentity!.display.value = "Original Name 原文";
  evidence[0].old.occurrence.source.range = { encoding: "utf16", start: 2, end: 8 };
  const history = { ...fixture.history, snapshots: [{ ...fixture.history.snapshots[0],
    coverage: [{ ...fixture.page.coverage[0], logicalPath: "captions/original.vtt" }] }] };
  render(<LineageEvidenceView evidence={evidence} project={project} history={history} />);
  expect(screen.getByText("Original Name 原文")).toBeInTheDocument();
  expect(screen.queryByText("canonical-name")).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByText(origin));
  expect(screen.getByText(text => text.endsWith(range))).toBeVisible();
  expect(invoke).not.toHaveBeenCalled();
});

it("reads historical coverage only when requested and retries a failed read without changing evidence", async () => {
  const evidence = lineageFixture();
  const source = sourcePageFixture({ snapshotId: evidence[0].oldSnapshotId,
    coverage: [{ ...fixture.page.coverage[0], logicalPath: "captions/original.vtt" }] });
  invoke.mockRejectedValueOnce(new Error("Synthetic read failure")).mockResolvedValueOnce(source);
  render(<LineageEvidenceView evidence={evidence} project={project} />);
  expect(invoke).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.click(screen.getByText("Source location and identity"));
  await screen.findByRole("alert");
  expect(screen.getByText("Same stable key")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.getByText(/Original text · captions\/original\.vtt/)).toBeVisible());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(invoke).toHaveBeenLastCalledWith("read_source_history_content", { request: { ...fixture.session,
    snapshotId: evidence[0].oldSnapshotId, query: "", after: 0, limit: 1 } });
  expect(evidence).toEqual(fixture.lineage);
});

it("does not display late file metadata from a replaced historical snapshot", async () => {
  let complete!: (value: unknown) => void;
  const original = lineageFixture();
  const replacement = lineageFixture();
  replacement[0].oldSnapshotId = "00000000-0000-4000-8000-000000000015";
  replacement[0].old.occurrence.nativeIdentity!.display.value = "Replacement name";
  invoke.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const view = render(<LineageEvidenceView evidence={original} project={project} />);
  await userEvent.setup().click(screen.getByText("Source location and identity"));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  view.rerender(<LineageEvidenceView evidence={replacement} project={project} />);
  await act(async () => complete(sourcePageFixture({ snapshotId: original[0].oldSnapshotId,
    coverage: [{ ...fixture.page.coverage[0], logicalPath: "captions/stale.vtt" }] })));
  expect(screen.getByText("Replacement name")).toBeInTheDocument();
  expect(screen.queryByText(/captions\/stale\.vtt/)).not.toBeInTheDocument();
});
