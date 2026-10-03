import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/sourceCommands.contract.json";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import unicodeFixture from "../../../crates/core/tests/fixtures/source-unicode.contract.json";
import { sourceCommands, type StartRequest, type SourceAdoptRequest } from "./sourceCommands";
import * as validators from "./generated/source.validators";
import { hasUnknownOutcome } from "./projectCommands";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it("preserves bounded source requests, decimal revisions and explicit confirmation across IPC", async () => {
  const start: StartRequest = fixture.start;
  const prepare: SourceAdoptRequest = fixture.prepare;
  const page = sourcePageFixture();
  for (const [validate, value] of [
    [validators.validateRequestSession, fixture.session], [validators.validateRequestCapture, fixture.capture],
    [validators.validateRequestStart, start], [validators.validateRequestPreview, fixture.preview],
    [validators.validateRequestContent, fixture.content], [validators.validateRequestComparison, fixture.comparisonRequest],
    [validators.validateRequestHistory, fixture.historyRequest], [validators.validateRequestHistoryContent, fixture.historyContent],
    [validators.validateRequestLineage, fixture.lineageRequest], [validators.validateRequestImpact, fixture.impactRequest],
    [validators.validateRequestAdopt, prepare],
    [validators.validateResponseIntegration, fixture.integration], [validators.validateResponseSelection, fixture.selection],
    [validators.validateResponseSelection, null], [validators.validateResponsePreflight, fixture.preflight],
    [validators.validateResponseAttempt, start.attemptId], [validators.validateResponseCancelled, null],
    [validators.validateResponseScope, page.scope], [validators.validateResponsePage, page],
    [validators.validateResponseComparison, fixture.comparison], [validators.validateResponseHistory, fixture.history],
    [validators.validateResponseLineage, fixture.lineage], [validators.validateResponseEstimates, fixture.estimates],
    [validators.validateResponseImpact, fixture.impact], [validators.validateResponseAction, executionFixture.action],
  ] as const) expect(validate(value), validate.name).toBe(true);
  invoke.mockResolvedValueOnce(page);
  expect(await sourceCommands.preview(fixture.preview)).toEqual(page);
  expect(invoke).toHaveBeenLastCalledWith("read_source_preview", { request: fixture.preview });
  invoke.mockResolvedValueOnce(start.attemptId);
  expect(await sourceCommands.start(start)).toBe(start.attemptId);
  expect(invoke).toHaveBeenLastCalledWith("start_source_import", { request: start });
  invoke.mockResolvedValueOnce(executionFixture.action);
  expect(await sourceCommands.prepare(prepare)).toEqual(executionFixture.action);
  expect(invoke).toHaveBeenLastCalledWith("prepare_source_adoption", { request: prepare });
  invoke.mockResolvedValueOnce(fixture.history);
  expect((await sourceCommands.history(fixture.historyRequest)).snapshots[0].revision).toBe("9007199254740993");
  expect(prepare.confirmation.expectedContentRevision).toBe("9007199254740993");
  expect(page.rows[0].occurrence.text).toBe("Hello {{name}} 世界");
});

it("rejects lossy counters, invalid tuples, unknown decisions and missing response fields", () => {
  expect(validators.validateRequestPreview({ ...fixture.preview, after: 4294967295 })).toBe(true);
  expect(validators.validateRequestPreview({ ...fixture.preview, after: 4294967296 })).toBe(false);
  for (const revision of [9007199254740992, "9223372036854775808", "01", "-1"]) {
    expect(validators.validateResponseHistory({ ...fixture.history, snapshots: [{ ...fixture.history.snapshots[0], revision }] })).toBe(false);
  }
  expect(validators.validateResponseHistory({ ...fixture.history, nextOffset: 4294967296 })).toBe(false);
  const page = sourcePageFixture();
  for (const keyByteRange of [[0, 4294967296], [0, 1, 2], [-1, 2], [0, 0.5]]) {
    expect(validators.validateResponsePage({ ...page, rows: [{ ...page.rows[0], occurrence: { ...page.rows[0].occurrence, keyByteRange } }] })).toBe(false);
  }
  expect(validators.validateRequestAdopt({ ...fixture.prepare, confirmation: { ...fixture.prepare.confirmation,
    lineage: [{ newOrdinal: 0, oldOccurrenceId: fixture.content.snapshotId, decision: "guess", reason: "unknown" }] } })).toBe(false);
  expect(validators.validateResponseIntegration({ id: "webvtt" })).toBe(false);
  expect(validators.validateResponseCancelled({})).toBe(false);
  expect(validators.validateResponseComparison({ ...fixture.comparison, rows: [{ ...fixture.comparison.rows[0], kind: "future-kind" }] })).toBe(false);
  expect(validators.validateResponseImpact({ ...fixture.impact, rows: [{ ...fixture.impact.rows[0], status: "future-status" }] })).toBe(false);
});

it("keeps an invalid preparation acknowledgement unknown without replaying the action", async () => {
  invoke.mockResolvedValueOnce({});
  const failure = await sourceCommands.prepare(fixture.prepare).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(hasUnknownOutcome(failure)).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("prepare_source_adoption", { request: fixture.prepare });
});

it.each(unicodeFixture.cases)("keeps $profile ranges in original UTF-8 bytes across Rust and TypeScript", caseFixture => {
  const bytes = new TextEncoder().encode(caseFixture.raw);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const rows = caseFixture.rows.map(row => sourceRowFixture({}, { ...row.occurrence,
    keyByteRange: [row.occurrence.keyByteRange[0], row.occurrence.keyByteRange[1]],
    valueByteRange: [row.occurrence.valueByteRange[0], row.occurrence.valueByteRange[1]] }));
  expect(validators.validateResponsePage(sourcePageFixture({ rows, total: rows.length }))).toBe(true);
  for (const row of caseFixture.rows) {
    for (const [byteRange, utf16Range, text] of [
      [row.occurrence.keyByteRange, row.keyUtf16Range, row.occurrence.key],
      [row.occurrence.valueByteRange, row.valueUtf16Range, row.occurrence.text],
    ] as const) {
      const token = decoder.decode(bytes.slice(byteRange[0], byteRange[1]));
      expect(caseFixture.raw.slice(utf16Range[0], utf16Range[1])).toBe(token);
      expect(caseFixture.profile === "smapi-json" ? JSON.parse(token) : token.replace(/\r\n?/g, "\n")).toBe(text);
    }
    const byteRange = row.occurrence.valueByteRange;
    expect(caseFixture.raw.slice(byteRange[0], byteRange[1])).not.toBe(decoder.decode(bytes.slice(byteRange[0], byteRange[1])));
  }
  expect(JSON.parse(JSON.stringify(caseFixture)).raw).toBe(caseFixture.raw);
});
