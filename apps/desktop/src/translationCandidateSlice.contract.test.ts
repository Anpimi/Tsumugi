import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/translationCandidateSlice.contract.json";
import { translationCommands } from "./translationCommands";
import * as validators from "./generated/translation.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
const raw: unknown = fixture.request;
if (!validators.validateRequestCandidateSlice(raw)) throw new Error("Invalid candidate slice request fixture");
const request = { ...raw, unitIds: [...raw.unitIds] };

it("reads full current-source proposals in one bounded request and retains selected AI and intentional empty text", async () => {
  expect(validators.validateResponseCandidateSlice(fixture.response)).toBe(true);
  invoke.mockResolvedValueOnce(fixture.response);
  const page = await translationCommands.candidateSlice(request);
  expect(page.rows[0].selectedOriginKind).toBe("ai");
  expect(page.rows[0].target.translationText).toBe("");
  expect(page.rows[0].revisions[1].text).toBe("");
  expect(page.rows[1].target.translationText).toBeNull();
  expect(page.rows[0].revisions[0].text).toContain("é 👩🏽‍💻");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("read_translation_candidate_slice", { request });
});

it("continues a partial unit by original ordinal, then consumes the unchanged remaining membership", async () => {
  const partial = structuredClone(fixture.response);
  partial.rows = [partial.rows[0]];
  partial.rows[0].revisions = [partial.rows[0].revisions[0]];
  const first = { ...partial, next: { unitOffset: 0, afterOrdinal: "2" } };
  invoke.mockResolvedValueOnce(first);
  expect(await translationCommands.candidateSlice(request)).toEqual(first);
  const rest = structuredClone(fixture.response); rest.rows[0].revisions.shift();
  const continuation = { ...request, afterOrdinal: "2", readVersion: first.readVersion };
  invoke.mockResolvedValueOnce(rest);
  expect(await translationCommands.candidateSlice(continuation)).toEqual(rest);
});

it("reads rejected proposals with their original latest decision and never grants a selection", async () => {
  const page = structuredClone(fixture.response), revision = page.rows[0].revisions[0];
  const decision = { request: { projectId: request.projectId, actionId: request.unitIds[1], unitId: revision.unitId, locale: revision.locale,
    revisionId: revision.revisionId, sourceRevisionId: revision.sourceRevisionId, expectedSelectionId: page.rows[0].target.selectionId,
    expectedDecisionId: null, disposition: "rejected", actor: "Synthetic reviewer", reason: "Original decision" }, sourceSnapshotId: request.sourceSnapshotId };
  const rejected = { ...page, rows: [{ ...page.rows[0], candidateCount: 1, revisions: [{ ...revision, candidateDecision: decision }] }, page.rows[1]] };
  invoke.mockResolvedValueOnce(rejected);
  expect(await translationCommands.candidateSlice({ ...request, state: "rejected" })).toEqual(rejected);
  expect(invoke.mock.calls.every(([command]) => command === "read_translation_candidate_slice")).toBe(true);
});

it.each(["project", "snapshot", "unit-order", "source", "selected-origin", "selected-null", "origin", "count", "duplicate", "ordinal", "state", "cursor", "version", "too-large"])("rejects an unrelated or incomplete candidate slice: %s", async kind => {
  const page: unknown = structuredClone(fixture.response);
  if (!validators.validateResponseCandidateSlice(page)) throw new Error("Invalid candidate slice response fixture");
  const row = page.rows[0], revision = row.revisions[0];
  if (kind === "project") page.projectId = request.unitIds[0];
  if (kind === "snapshot") page.sourceSnapshotId = request.unitIds[0];
  if (kind === "unit-order") page.rows.reverse();
  if (kind === "source") revision.sourceRevisionId = request.unitIds[0];
  if (kind === "selected-origin") row.selectedOriginKind = null;
  if (kind === "selected-null") row.target.translationText = null;
  if (kind === "origin") revision.originKind = "manual";
  if (kind === "count") row.candidateCount = 3;
  if (kind === "duplicate") row.revisions[1] = revision;
  if (kind === "ordinal") row.revisions[1].ordinal = revision.ordinal;
  if (kind === "state") revision.candidateDecision = { request: { projectId: request.projectId, actionId: request.unitIds[1], unitId: revision.unitId, locale: revision.locale,
    revisionId: revision.revisionId, sourceRevisionId: revision.sourceRevisionId, expectedSelectionId: row.target.selectionId, expectedDecisionId: null,
    disposition: "rejected", actor: "Synthetic reviewer", reason: "Original decision" }, sourceSnapshotId: request.sourceSnapshotId };
  if (kind === "cursor") page.next = { unitOffset: 0, afterOrdinal: "1" };
  if (kind === "version") page.readVersion = "c".repeat(64);
  if (kind === "too-large") row.target.sourceText = "界".repeat(90_000);
  invoke.mockResolvedValueOnce(page);
  await expect(translationCommands.candidateSlice({ ...request, readVersion: fixture.response.readVersion })).rejects.toThrow("Invalid IPC response: read_translation_candidate_slice");
});
