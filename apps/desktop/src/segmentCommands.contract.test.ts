import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/segmentCommands.contract.json";
import { segmentCommands, type SegmentPage, type SegmentPageRequest, type SegmentScopeRequest } from "./segmentCommands";
import * as validators from "./generated/review.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

function pageRequest(): SegmentPageRequest {
  const request: unknown = structuredClone(fixture.requests.segmentPage);
  if (!validators.validateRequestSegmentPage(request)) throw new Error("Invalid segment page fixture");
  return request;
}
function scopeRequest(): SegmentScopeRequest {
  const request: unknown = structuredClone(fixture.requests.segmentScope);
  if (!validators.validateRequestSegmentScope(request)) throw new Error("Invalid segment scope fixture");
  return request;
}
function pageResponse(): SegmentPage {
  const response: unknown = structuredClone(fixture.responses.segmentPage);
  if (!validators.validateResponseSegmentPage(response)) throw new Error("Invalid segment response fixture");
  return response;
}

it("validates the shared Rust wire fixtures and dispatches both read-only commands", async () => {
  const page = pageRequest(), scope = scopeRequest();
  expect(validators.validateResponseSegmentPage(fixture.responses.segmentPage)).toBe(true);
  expect(validators.validateResponseSegmentScope(fixture.responses.segmentScope)).toBe(true);
  invoke.mockResolvedValueOnce(fixture.responses.segmentPage);
  expect(await segmentCommands.page(page)).toEqual(fixture.responses.segmentPage);
  expect(invoke).toHaveBeenLastCalledWith("read_segment_page", { request: page });
  invoke.mockResolvedValueOnce(fixture.responses.segmentScope);
  expect(await segmentCommands.captureScope(scope)).toEqual(fixture.responses.segmentScope);
  expect(invoke).toHaveBeenLastCalledWith("capture_segment_scope", { request: scope });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("rejects unknown selection filters, caller authority, malformed cursors and rounded revisions", () => {
  const request = pageRequest(), page = fixture.responses.segmentPage;
  expect(validators.validateRequestSegmentPage({ ...request, query: { ...request.query, selection: "approved" } })).toBe(false);
  expect(validators.validateRequestSegmentPage({ ...request, approved: true })).toBe(false);
  expect(validators.validateResponseSegmentPage({ ...page, nextCursor: "row-offset-50" })).toBe(false);
  expect(validators.validateRequestSegmentPage({ ...request, limit: 4294967296 })).toBe(false);
  expect(validators.validateResponseSegmentPage({ ...page, sequence: 9007199254740992 })).toBe(false);
  expect(validators.validateResponseSegmentPage({ ...page, sequence: "9223372036854775808" })).toBe(false);
  expect(validators.validateResponseSegmentPage({ ...page, rows: [{ ...page.rows[0], applicable: true }] })).toBe(false);
});

it.each(["project", "locale", "query-text", "query-selection", "scope", "row-locale", "snapshot", "duplicate", "limit", "cursor"])(
  "rejects a shape-valid but unrelated or inconsistent segment page: %s", async kind => {
    const request = pageRequest(), response = pageResponse();
    request.scopeId = response.scopeId;
    if (kind === "project") response.projectId = response.rows[0].content.unitId;
    if (kind === "locale") response.locale = "fr";
    if (kind === "query-text") response.query.text = "different";
    if (kind === "query-selection") response.query.selection = "selected";
    if (kind === "scope") response.scopeId = response.rows[0].content.unitId;
    if (kind === "row-locale") response.rows[0].content.locale = "fr";
    if (kind === "snapshot") response.rows[0].content.sourceSnapshotId = response.rows[0].content.unitId;
    if (kind === "duplicate") response.rows.push(response.rows[0]);
    if (kind === "limit") request.limit = 0;
    if (kind === "cursor") request.cursor = response.nextCursor = response.rows[0].content.unitId;
    expect(validators.validateResponseSegmentPage(response)).toBe(true);
    invoke.mockResolvedValueOnce(response);
    await expect(segmentCommands.page(request)).rejects.toThrow("Invalid IPC response: read_segment_page");
  },
);

it("checks the query on the first page, preserves explicit truncation, and accepts a valid empty result", async () => {
  const request = pageRequest(), page = structuredClone(fixture.responses.segmentPage);
  invoke.mockResolvedValueOnce({ ...page, query: { text: "another query", selection: "all" } });
  await expect(segmentCommands.page(request)).rejects.toThrow("Invalid IPC response: read_segment_page");
  page.rows[0].sourceTruncated = page.rows[0].translationTruncated = true;
  invoke.mockResolvedValueOnce(page);
  expect(await segmentCommands.page(request)).toEqual(page);
  const empty = { ...page, rows: [], total: 0 };
  invoke.mockResolvedValueOnce(empty);
  expect(await segmentCommands.page(request)).toEqual(empty);
});

it("rejects rows that contradict the captured selection filter", async () => {
  const request = pageRequest(), page = structuredClone(fixture.responses.segmentPage);
  request.query.selection = "unselected";
  page.query.selection = "unselected";
  expect(validators.validateResponseSegmentPage(page)).toBe(true);
  invoke.mockResolvedValueOnce(page);
  await expect(segmentCommands.page(request)).rejects.toThrow("Invalid IPC response: read_segment_page");
});

it.each(["candidateCount", "protection", "qa", "terms", "applicability", "qualification"])(
  "requires the generated bounded row summary field: %s", field => {
    const page = pageResponse(), row = { ...page.rows[0] } as Record<string, unknown>;
    delete row[field];
    expect(validators.validateResponseSegmentPage({ ...page, rows: [row] })).toBe(false);
  },
);

it("rejects invalid nested summary types and enum values through the generated contract", () => {
  const page = pageResponse(), row = page.rows[0];
  for (const changed of [
    { ...row, candidateCount: 4294967296 },
    { ...row, protection: { ...row.protection, revision: 9007199254740992 } },
    { ...row, qa: { ...row.qa, mandatory: { ...row.qa.mandatory, findings: -1 } } },
    { ...row, qa: { ...row.qa, outcome: "passed" } },
    { ...row, terms: { ...row.terms, highlightedRanges: [[0, 1]] } },
    { ...row, applicability: { ...row.applicability, resourceImpact: { ...row.applicability.resourceImpact, status: "resolved" } } },
    { ...row, qualification: { ...row.qualification, ready: true } },
  ]) expect(validators.validateResponseSegmentPage({ ...page, rows: [changed] })).toBe(false);
});

it.each(["protection-unit", "protection-locale", "qa-current", "qa-outcome", "qa-coverage", "qa-basis", "qa-absent-outcome", "qa-absent-coverage", "term-conflicts", "term-count", "term-truncated", "term-duplicate", "impact-count", "impact-duplicate", "impact-truncated", "blocker-count", "exception-count", "qualification-truncated", "selected-basis", "unselected-basis", "source-current", "captured-current"])(
  "rejects a shape-valid row summary that contradicts its own basis or counts: %s", async kind => {
    const page = pageResponse(), row = page.rows[0], request = pageRequest();
    if (kind === "protection-unit") row.protection.unitId = page.sourceSnapshotId;
    if (kind === "protection-locale") row.protection.locale = "fr";
    if (kind === "qa-current") row.qa.current = false;
    if (kind === "qa-outcome") row.qa.outcome = "unknown";
    if (kind === "qa-coverage") row.qa.mandatoryCoverageComplete = null;
    if (kind === "qa-basis") row.content.currentCheck!.basis = "another-basis";
    if (kind === "qa-absent-outcome" || kind === "qa-absent-coverage") {
      row.content.currentCheck = null;
      row.qa.current = false;
      row.qa.outcome = kind === "qa-absent-outcome" ? "completed" : null;
      row.qa.mandatoryCoverageComplete = kind === "qa-absent-coverage" ? false : null;
    }
    if (kind === "term-conflicts") row.terms.conflictingEntryCount = row.terms.applicableEntryCount + 1;
    if (kind === "term-count") row.terms.revisionCount++;
    if (kind === "term-truncated") row.terms.truncated = true;
    if (kind === "term-duplicate") { row.terms.revisions.push(row.terms.revisions[0]); row.terms.revisionCount++; }
    if (kind === "impact-count") row.applicability.resourceImpact!.reasonCount++;
    if (kind === "impact-duplicate") { row.applicability.resourceImpact!.changes.push(row.applicability.resourceImpact!.changes[0]); row.applicability.resourceImpact!.reasonCount++; }
    if (kind === "impact-truncated") row.applicability.resourceImpact!.truncated = true;
    if (kind === "blocker-count") row.qualification.blockerCount++;
    if (kind === "exception-count") row.qualification.exceptionCount++;
    if (kind === "qualification-truncated") row.qualification.truncated = true;
    if (kind === "selected-basis") row.applicability.selectedSourceRevisionId = null;
    if (kind === "unselected-basis") row.content.selectionId = row.content.revisionId = null;
    if (kind === "source-current") row.applicability.sourceBasisCurrent = false;
    if (kind === "captured-current") { row.applicability.selectedSourceRevisionId = page.sourceSnapshotId; row.applicability.sourceBasisCurrent = false; row.applicability.capturedBasisCurrent = true; }
    expect(validators.validateResponseSegmentPage(page)).toBe(true);
    invoke.mockResolvedValueOnce(page);
    await expect(segmentCommands.page(request)).rejects.toThrow("Invalid IPC response: read_segment_page");
  },
);

it("keeps absent or unknown QA, applicability and qualification observations distinct", async () => {
  const request = pageRequest(), page = pageResponse(), row = page.rows[0];
  row.content.currentCheck = null;
  row.qa = { current: false, outcome: null, mandatoryCoverageComplete: null,
    mandatory: { ...row.qa.mandatory, passed: 0, findings: 0, findingCount: 0 }, advisory: row.qa.advisory };
  row.content.selectionId = row.content.revisionId = row.content.translationPreview = null;
  row.applicability = { selectedSourceRevisionId: null, sourceBasisCurrent: null, capturedBasisCurrent: null,
    resourceImpact: null, resourceReviewRequired: false };
  row.terms = { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false };
  row.qualification = { blockerCount: 2, exceptionCount: 0,
    blockers: [{ code: "translation-missing", reference: null }, { code: "qa-missing-or-stale", reference: null }], exceptions: [], truncated: false };
  invoke.mockResolvedValueOnce(page);
  expect(await segmentCommands.page(request)).toEqual(page);
  const unknown = pageResponse();
  unknown.rows[0].content.currentCheck!.outcome = unknown.rows[0].qa.outcome = "unknown";
  unknown.rows[0].content.currentCheck!.hasIncomplete = true;
  unknown.rows[0].qa.mandatory.unknown = 1;
  invoke.mockResolvedValueOnce(unknown);
  expect(await segmentCommands.page(request)).toEqual(unknown);
});

it("preserves bounded term and impact references and repeated owner qualification reasons", async () => {
  const request = pageRequest(), page = pageResponse(), row = page.rows[0];
  const identity = (index: number) => `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  row.terms = { applicableEntryCount: 3, conflictingEntryCount: 1, revisionCount: 9, truncated: true,
    revisions: Array.from({ length: 8 }, (_, index) => ({ termId: `term-${index}`, revisionId: identity(index + 30) })) };
  row.applicability.resourceImpact = { status: "unresolved", reasonCount: 9, truncated: true,
    changes: Array.from({ length: 8 }, (_, index) => ({ changeId: identity(index + 40), kind: "term", confidence: "literal-possible" })) };
  row.applicability.resourceReviewRequired = false;
  row.qualification = { blockerCount: 9, exceptionCount: 1, truncated: true,
    blockers: Array.from({ length: 8 }, () => ({ code: "qa-unavailable", reference: "same-rule-from-different-checkers" })),
    exceptions: [{ code: "issue-waiver", reference: "synthetic-issue" }] };
  expect(validators.validateResponseSegmentPage(page)).toBe(true);
  invoke.mockResolvedValueOnce(page);
  expect(await segmentCommands.page(request)).toEqual(page);
  for (const field of ["terms", "impact", "blockers", "exceptions"]) {
    const excessive = structuredClone(page), summary = excessive.rows[0];
    if (field === "terms") summary.terms.revisions.push({ termId: "ninth", revisionId: identity(100) });
    if (field === "impact") summary.applicability.resourceImpact!.changes.push({ changeId: identity(101), kind: "context", confidence: "explicit-unit" });
    if (field === "blockers") summary.qualification.blockers.push({ code: "ninth", reference: null });
    if (field === "exceptions") { summary.qualification.exceptionCount = 9; summary.qualification.exceptions = Array.from({ length: 9 }, () => ({ code: "issue-waiver", reference: "synthetic" })); }
    invoke.mockResolvedValueOnce(excessive);
    await expect(segmentCommands.page(request)).rejects.toThrow("Invalid IPC response: read_segment_page");
  }
});

it.each(["project", "fingerprint", "version", "scope", "locale", "duplicate", "excluded"])(
  "rejects a shape-valid but unrelated frozen scope: %s", async kind => {
    const request = scopeRequest(), response = structuredClone(fixture.responses.segmentScope);
    if (kind === "project") response.projectId = response.capture.units[0].unitId;
    if (kind === "fingerprint") response.queryFingerprint = "another-query";
    if (kind === "version") response.readVersion = "another-read";
    if (kind === "scope") response.capture.scopeId = response.capture.units[0].unitId;
    if (kind === "locale") response.capture.locale = "fr";
    if (kind === "duplicate") response.capture.units.push(response.capture.units[0]);
    if (kind === "excluded") request.excluded = [response.capture.units[0].unitId];
    expect(validators.validateResponseSegmentScope(response)).toBe(true);
    invoke.mockResolvedValueOnce(response);
    await expect(segmentCommands.captureScope(request)).rejects.toThrow("Invalid IPC response: capture_segment_scope");
  },
);
