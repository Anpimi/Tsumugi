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
