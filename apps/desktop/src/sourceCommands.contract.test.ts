import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/sourceCommands.contract.json";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import unicodeFixture from "../../../crates/core/tests/fixtures/source-unicode.contract.json";
import { sourceCommands, confirmSourceAction, confirmSourceReceipt, type SourceAdoptRequest } from "./sourceCommands";
import type { AdoptionAction, Receipt } from "./executionCommands";
import * as validators from "./generated/source.validators";
import { hasUnknownOutcome } from "./projectCommands";
import { sourcePageFixture, sourceRowFixture, sourceActionFixture, sourceReceiptFixture } from "./testSupport/sourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";

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
    [validators.validateResponseImpact, fixture.impact], [validators.validateResponseAction, sourceActionFixture(prepare)],
  ] as const) expect(validate(value), validate.name).toBe(true);
  invoke.mockResolvedValueOnce(page);
  expect(await sourceCommands.preview(fixture.preview)).toEqual(page);
  expect(invoke).toHaveBeenLastCalledWith("read_source_preview", { request: fixture.preview });
  invoke.mockResolvedValueOnce(sourceActionFixture(prepare));
  expect(await sourceCommands.prepare(prepare)).toEqual(sourceActionFixture(prepare));
  expect(invoke).toHaveBeenLastCalledWith("prepare_source_adoption", { request: prepare });
  invoke.mockResolvedValueOnce(fixture.history);
  expect((await sourceCommands.history(fixture.historyRequest)).snapshots[0].revision).toBe("9007199254740993");
  expect(prepare.confirmation.expectedContentRevision).toBe("9007199254740993");
  expect(page.rows[0].occurrence.text).toBe("Hello {{name}} 世界");
});

it("compares the complete normalized Source confirmation independent of object key order", async () => {
  const request: SourceAdoptRequest = { ...fixture.prepare, confirmation: { ...fixture.prepare.confirmation,
    lineage: [{ newOrdinal: 70, oldOccurrenceId: fixtureIdentity(70), decision: "continue", reason: "Same identity" }], actor: "Reviewer" } };
  const action = sourceActionFixture(request);
  action.parameters = Object.fromEntries(Object.entries(action.parameters as Record<string, unknown>).reverse());
  invoke.mockResolvedValueOnce(action);
  const decoded = await sourceCommands.prepare(request);
  expect(() => confirmSourceAction(request, action.unitId, decoded)).not.toThrow();
  const defaults: SourceAdoptRequest = { ...fixture.prepare, confirmation: { resultDigest: fixture.prepare.confirmation.resultDigest,
    identityPolicy: fixture.prepare.confirmation.identityPolicy, expectedContentRevision: fixture.prepare.confirmation.expectedContentRevision, sourceLanguage: fixture.prepare.confirmation.sourceLanguage } };
  expect(() => confirmSourceAction(defaults, action.unitId, sourceActionFixture(defaults))).not.toThrow();
});

it.each([
  ["project", { projectId: fixtureIdentity(90) }], ["attempt", { attemptId: fixtureIdentity(90) }],
  ["action", { actionId: fixtureIdentity(90) }], ["unit", { unitId: fixtureIdentity(90) }],
  ["operation", { operation: "sample-update" }], ["result", { resultIds: [fixtureIdentity(90)] }],
  ["extra result", { resultIds: [fixture.prepare.resultId, fixtureIdentity(90)] }],
  ["source language", { parameters: { ...fixture.prepare.confirmation, sourceLanguage: "zh-CN" } }],
  ["result digest", { parameters: { ...fixture.prepare.confirmation, resultDigest: "b".repeat(64) } }],
  ["content revision", { parameters: { ...fixture.prepare.confirmation, expectedContentRevision: "9007199254740994" } }],
  ["current snapshot", { parameters: { ...fixture.prepare.confirmation, expectedCurrentSnapshot: fixtureIdentity(90) } }],
  ["lineage base", { parameters: { ...fixture.prepare.confirmation, lineageBaseSnapshot: fixtureIdentity(90) } }],
  ["identity policy", { parameters: { ...fixture.prepare.confirmation, identityPolicy: "webvtt-cue/1" } }],
  ["actor", { parameters: { ...fixture.prepare.confirmation, actor: "Different reviewer" } }],
  ["lineage", { parameters: { ...fixture.prepare.confirmation, lineage: [{ newOrdinal: 70, oldOccurrenceId: fixtureIdentity(70), decision: "reject", reason: "Different identity" }] } }],
  ["null lineage", { parameters: { ...fixture.prepare.confirmation, lineage: null } }],
  ["extra parameter", { parameters: { ...fixture.prepare.confirmation, text: "Unrelated" } }],
] satisfies [string, Partial<AdoptionAction>][])("retains a schema-valid but wrong %s preparation as unknown", async (_name, patch) => {
  const action = { ...sourceActionFixture(), ...patch };
  invoke.mockResolvedValueOnce(action);
  const decoded = await sourceCommands.prepare(fixture.prepare);
  const failure = (() => { try { confirmSourceAction(fixture.prepare, executionFixture.prepare.unitId, decoded); } catch (error) { return error; } })();
  expect(failure).toBeInstanceOf(Error);
  expect(hasUnknownOutcome(failure)).toBe(true);
});

it("requires every lineage decision and reason in the original order", () => {
  const request: SourceAdoptRequest = { ...fixture.prepare, confirmation: { ...fixture.prepare.confirmation, actor: "Reviewer", lineage: [
    { newOrdinal: 0, oldOccurrenceId: fixtureIdentity(70), decision: "continue", reason: "First reason" },
    { newOrdinal: 70, oldOccurrenceId: fixtureIdentity(71), decision: "reject", reason: "Later reason" },
  ] } };
  const action = sourceActionFixture(request);
  for (const lineage of [[...request.confirmation.lineage!].reverse(), [{ ...request.confirmation.lineage![0], reason: "Changed reason" }, request.confirmation.lineage![1]],
    [{ ...request.confirmation.lineage![0], decision: "reject" }, request.confirmation.lineage![1]]]) {
    expect(() => confirmSourceAction(request, action.unitId, { ...action, parameters: { ...request.confirmation, lineage } })).toThrow();
  }
});

it("confirms a Source receipt's actual new snapshot and exact next decimal revision", () => {
  const receipt = sourceReceiptFixture();
  expect(receipt.requestDigest).not.toBe(fixture.prepare.confirmation.resultDigest);
  expect(confirmSourceReceipt(fixture.prepare, receipt.unitId, receipt)).toBe(receipt.changes[0].id);
  expect(receipt.changes[0].revision).toBe("9007199254740994");
});

it.each([
  ["project", { projectId: fixtureIdentity(90) }], ["attempt", { attemptId: fixtureIdentity(90) }],
  ["action", { actionId: fixtureIdentity(90) }], ["unit", { unitId: fixtureIdentity(90) }],
  ["digest", { requestDigest: "not-a-digest" }],
  ["kind", { changes: [{ kind: "sample-update", id: fixtureIdentity(100), revision: "9007199254740994" }] }],
  ["snapshot", { changes: [{ kind: "source-snapshot", id: "old-snapshot", revision: "9007199254740994" }] }],
  ["revision", { changes: [{ kind: "source-snapshot", id: fixtureIdentity(100), revision: "9007199254740993" }] }],
  ["extra change", { changes: [...sourceReceiptFixture().changes, { kind: "source-snapshot", id: fixtureIdentity(101), revision: "9007199254740994" }] }],
] satisfies [string, Partial<Receipt>][])("does not confirm a Source receipt with wrong %s", (_name, patch) => {
  expect(() => confirmSourceReceipt(fixture.prepare, executionFixture.prepare.unitId, { ...sourceReceiptFixture(), ...patch })).toThrow();
});

it("rejects lossy counters, invalid tuples, unknown decisions and missing response fields", () => {
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


it("reads bounded whole source-context entries with exact request and revision evidence", async () => {
  expect(validators.validateRequestSourceContext(fixture.sourceContextRequest)).toBe(true);
  expect(validators.validateResponseSourceContext(fixture.sourceContext)).toBe(true);
  invoke.mockResolvedValueOnce(structuredClone(fixture.sourceContext));
  const result = await sourceCommands.sourceContext(fixture.sourceContextRequest);
  expect(result).toEqual(fixture.sourceContext);
  expect(result.contentRevision).toBe("9007199254740993");
  expect(invoke).toHaveBeenLastCalledWith("read_source_context", {request:fixture.sourceContextRequest});
  const numeric = {...fixture.sourceContext,contentRevision:9007199254740992};
  expect(validators.validateResponseSourceContext(numeric)).toBe(false);
});

it("refuses source-context responses for a different exact scope", async () => {
  for (const field of ["projectId","sourceSnapshotId","unitId","sourceRevisionId","locale"] as const) {
    const response = structuredClone(fixture.sourceContext);
    response.scope[field] = field === "locale" ? "ja" : fixtureIdentity(999);
    expect(validators.validateResponseSourceContext(response)).toBe(true);
    invoke.mockResolvedValueOnce(response);
    await expect(sourceCommands.sourceContext(fixture.sourceContextRequest)).rejects.toThrow("source context page association");
  }
});

it("rejects nonprogressing, overlapping and prematurely terminal source-context page cursors", async () => {
  for (const change of [{after:1},{nextAfter:0},{nextAfter:4},{entries:[],nextAfter:1},{totalEntries:5,nextAfter:null}]) {
    invoke.mockResolvedValueOnce({...fixture.sourceContext,...change});
    await expect(sourceCommands.sourceContext(fixture.sourceContextRequest)).rejects.toThrow();
  }
  const page = {...fixture.sourceContext,entries:fixture.sourceContext.entries.slice(0,1),nextAfter:1};
  invoke.mockResolvedValueOnce(page);
  expect(await sourceCommands.sourceContext({...fixture.sourceContextRequest,limit:1})).toEqual(page);
});
