import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/sourceCommands.contract.json";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import unicodeFixture from "../../../crates/core/tests/fixtures/source-unicode.contract.json";
import { sourceCommands, type SourceAdoptRequest } from "./sourceCommands";
import * as validators from "./generated/source.validators";
import { hasUnknownOutcome } from "./projectCommands";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

it("preserves bounded source requests, decimal revisions and explicit confirmation across IPC", async () => {
  const prepare: SourceAdoptRequest = fixture.prepare;
  const page = sourcePageFixture();
  for (const [validate, value] of [
    [validators.validateRequestSession, fixture.session],
    [validators.validateRequestPreview, fixture.preview],
    [validators.validateRequestContent, fixture.content], [validators.validateRequestComparison, fixture.comparisonRequest],
    [validators.validateRequestHistory, fixture.historyRequest], [validators.validateRequestHistoryContent, fixture.historyContent],
    [validators.validateRequestLineage, fixture.lineageRequest], [validators.validateRequestImpact, fixture.impactRequest],
    [validators.validateRequestAdopt, prepare],
    [validators.validateResponseAttempt, fixture.preview.attemptId], [validators.validateResponseCancelled, null],
    [validators.validateResponseScope, page.scope], [validators.validateResponsePage, page],
    [validators.validateResponseComparison, fixture.comparison], [validators.validateResponseHistory, fixture.history],
    [validators.validateResponseLineage, fixture.lineage], [validators.validateResponseEstimates, fixture.estimates],
    [validators.validateResponseImpact, fixture.impact], [validators.validateResponseAction, executionFixture.action],
  ] as const) expect(validate(value), validate.name).toBe(true);
  invoke.mockResolvedValueOnce(page);
  expect(await sourceCommands.preview(fixture.preview)).toEqual(page);
  expect(invoke).toHaveBeenLastCalledWith("read_source_preview", { request: fixture.preview });
  invoke.mockResolvedValueOnce(executionFixture.action);
  expect(await sourceCommands.prepare(prepare)).toEqual(executionFixture.action);
  expect(invoke).toHaveBeenLastCalledWith("prepare_source_adoption", { request: prepare });
  invoke.mockResolvedValueOnce(fixture.history);
  expect((await sourceCommands.history(fixture.historyRequest)).snapshots[0].revision).toBe("9007199254740993");
  expect(prepare.confirmation.expectedContentRevision).toBe("9007199254740993");
  expect(page.rows[0].occurrence.text).toBe("Hello {{name}} 世界");
});

it("rejects lossy counters, invalid source references, unknown decisions and missing response fields", () => {
  expect(validators.validateRequestPreview({ ...fixture.preview, after: 4294967295 })).toBe(true);
  expect(validators.validateRequestPreview({ ...fixture.preview, after: 4294967296 })).toBe(false);
  for (const revision of [9007199254740992, "9223372036854775808", "01", "-1"]) {
    expect(validators.validateResponseHistory({ ...fixture.history, snapshots: [{ ...fixture.history.snapshots[0], revision }] })).toBe(false);
  }
  expect(validators.validateResponseHistory({ ...fixture.history, nextOffset: 4294967296 })).toBe(false);
  const page = sourcePageFixture();
  for (const range of [
    { encoding: "utf8-byte", start: 0, end: 4294967296 },
    { encoding: "utf16", start: -1, end: 2 },
    { encoding: "grapheme", start: 0, end: 0.5 },
    { encoding: "characters", start: 0, end: 2 },
    { encoding: "utf16", start: 0, end: 2, extra: true },
  ]) {
    expect(validators.validateResponsePage({ ...page, rows: [{ ...page.rows[0], occurrence: { ...page.rows[0].occurrence,
      source: { ...page.rows[0].occurrence.source, range } } }] })).toBe(false);
  }
  const { operationOccurrenceId: _id, ...missingLocalId } = page.rows[0].occurrence;
  expect(validators.validateResponsePage({ ...page, rows: [{ ...page.rows[0], occurrence: missingLocalId }] })).toBe(false);
  const nativeIdentity = page.rows[0].occurrence.nativeIdentity!;
  expect(validators.validateResponsePage({ ...page, rows: [{ ...page.rows[0], occurrence: { ...page.rows[0].occurrence,
    nativeIdentity: { ...nativeIdentity, display: { value: nativeIdentity.display.value } } } }] })).toBe(false);
  expect(validators.validateRequestAdopt({ ...fixture.prepare, confirmation: { ...fixture.prepare.confirmation,
    lineage: [{ newOrdinal: 0, oldOccurrenceId: fixture.content.snapshotId, decision: "guess", reason: "unknown" }] } })).toBe(false);
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

it.each(unicodeFixture.cases)("preserves $profile original byte and UTF-16 coordinates without assuming JavaScript indices are bytes", caseFixture => {
  const bytes = new TextEncoder().encode(caseFixture.raw);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // These format-specific oracle coordinates are test inputs, not a source DTO
  // interpretation. Source references retain whichever encoding the domain supplied.
  for (const encoding of ["utf8-byte", "utf16"] as const) {
    const rows = caseFixture.rows.map(row => {
      const textRange = encoding === "utf8-byte" ? row.occurrence.valueByteRange : row.valueUtf16Range;
      const identityRange = encoding === "utf8-byte" ? row.occurrence.keyByteRange : row.keyUtf16Range;
      return sourceRowFixture({}, { ordinal: row.occurrence.ordinal, artifactId: row.occurrence.artifactId,
        namespace: row.occurrence.namespace, key: row.occurrence.key, text: row.occurrence.text,
        operationUnitId: `unit-${row.occurrence.ordinal}`, operationOccurrenceId: `occurrence-${row.occurrence.ordinal}`,
        operationSourceRevisionId: `revision-${row.occurrence.ordinal}`,
        source: { artifactId: row.occurrence.artifactId, range: { encoding, start: textRange[0], end: textRange[1] } },
        nativeIdentity: { namespace: row.occurrence.namespace, value: row.occurrence.key,
          policy: { id: caseFixture.profile, schemaVersion: 1, behaviorVersion: 1 },
          display: { value: row.occurrence.key, source: { artifactId: row.occurrence.artifactId,
            range: { encoding, start: identityRange[0], end: identityRange[1] } } } } });
    });
    const page = sourcePageFixture({ rows, total: rows.length });
    expect(validators.validateResponsePage(page)).toBe(true);
    expect(JSON.parse(JSON.stringify(page)).rows.map((row: { occurrence: { source: unknown } }) => row.occurrence.source)).toEqual(rows.map(row => row.occurrence.source));
  }
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

it("keeps grapheme references, canonical identity and domain-confirmed display distinct on the wire", async () => {
  const row = sourceRowFixture({}, { source: { artifactId: fixture.page.coverage[0].artifactId,
    range: { encoding: "grapheme", start: 1, end: 4 } }, nativeIdentity: {
    namespace: "Fixture.Mod", value: "canonical-id", policy: { id: "fixture-identity", schemaVersion: 1, behaviorVersion: 2 },
    display: { value: "Original ID", source: null } } });
  const page = sourcePageFixture({ rows: [row] });
  invoke.mockResolvedValueOnce(JSON.parse(JSON.stringify(page)));
  const received = await sourceCommands.preview(fixture.preview);
  expect(received.rows[0].occurrence.source.range).toEqual({ encoding: "grapheme", start: 1, end: 4 });
  expect(received.rows[0].occurrence.nativeIdentity?.value).toBe("canonical-id");
  expect(received.rows[0].occurrence.nativeIdentity?.display).toEqual({ value: "Original ID", source: null });
});

it("validates and transports separately fixed plugin source and semantic-check requests", async () => {
  const { default: flow } = await import("../test/fixtures/pluginSourceWorkflow.contract.json");
  for (const [validate, value] of [
    [validators.validateRequestPluginSelect, flow.select], [validators.validateResponsePluginSelection, flow.selection],
    [validators.validateRequestPluginCapture, flow.capture], [validators.validateResponsePluginPreflight, flow.preflight],
    [validators.validateRequestPluginStart, flow.start], [validators.validateRequestCheckPrepare, flow.prepareCheck],
    [validators.validateResponseCheckReview, flow.checkReview], [validators.validateRequestCheckFinish, flow.finishCheck],
  ] as const) expect(validate(value), validate.name).toBe(true);
  expect(validators.validateRequestPluginStart({ ...flow.start, expiresAtMs: Number(flow.start.expiresAtMs) })).toBe(false);
  expect(validators.validateRequestPluginStart({ ...flow.start, directory: "/untrusted" })).toBe(false);
  invoke.mockResolvedValueOnce(flow.selection); await sourceCommands.selectPlugin(flow.select);
  expect(invoke).toHaveBeenLastCalledWith("select_plugin_source", { request: flow.select });
  invoke.mockResolvedValueOnce(flow.preflight); await sourceCommands.capturePlugin(flow.capture);
  expect(invoke).toHaveBeenLastCalledWith("preflight_plugin_source", { request: flow.capture });
  invoke.mockResolvedValueOnce(flow.start.attemptId); await sourceCommands.startPlugin(flow.start);
  expect(invoke).toHaveBeenLastCalledWith("start_plugin_source", { request: flow.start });
  invoke.mockResolvedValueOnce(flow.checkReview); await sourceCommands.prepareCheck(flow.prepareCheck);
  expect(invoke).toHaveBeenLastCalledWith("prepare_source_check", { request: flow.prepareCheck });
  invoke.mockResolvedValueOnce(flow.start.attemptId); await sourceCommands.startCheck(flow.start);
  expect(invoke).toHaveBeenLastCalledWith("start_source_check", { request: flow.start });
  invoke.mockResolvedValueOnce(null); await sourceCommands.finishCheck(flow.finishCheck);
  expect(invoke).toHaveBeenLastCalledWith("finish_source_check", { request: flow.finishCheck });
});
