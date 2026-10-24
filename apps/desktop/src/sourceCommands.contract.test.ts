import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/sourceCommands.contract.json";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import unicodeFixture from "../../../crates/core/tests/fixtures/source-unicode.contract.json";
import { sourceCommands, confirmSourceAction, confirmSourceReceipt, type StartRequest, type SourceAdoptRequest } from "./sourceCommands";
import type { AdoptionAction, Receipt } from "./executionCommands";
import * as validators from "./generated/source.validators";
import { hasUnknownOutcome } from "./projectCommands";
import { sourcePageFixture, sourceRowFixture, sourceActionFixture, sourceReceiptFixture } from "./testSupport/sourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";

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
    [validators.validateResponseImpact, fixture.impact], [validators.validateResponseAction, sourceActionFixture(prepare)],
  ] as const) expect(validate(value), validate.name).toBe(true);
  invoke.mockResolvedValueOnce(page);
  expect(await sourceCommands.preview(fixture.preview)).toEqual(page);
  expect(invoke).toHaveBeenLastCalledWith("read_source_preview", { request: fixture.preview });
  invoke.mockResolvedValueOnce(start.attemptId);
  expect(await sourceCommands.start(start)).toBe(start.attemptId);
  expect(invoke).toHaveBeenLastCalledWith("start_source_import", { request: start });
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

it("reads only the complete original native Source start request and rejects every mismatched proof", async () => {
  const request = fixture.start; const { sessionToken: _session, ...original } = request;
  const proof = { request: original, taskId: fixtureIdentity(980), inputDigest: "a".repeat(64) };
  expect(validators.validateRequestStartAction(request)).toBe(true);
  for (const value of [null,proof]) { invoke.mockResolvedValueOnce(value); expect(await sourceCommands.startAction(request)).toEqual(value); }
  for (const changed of [{projectId:fixtureIdentity(777)},{attemptId:fixtureIdentity(777)},{selectionId:fixtureIdentity(777)},{sourceLanguage:"fr"}]) {
    invoke.mockResolvedValueOnce({...proof,request:{...original,...changed}});
    expect(hasUnknownOutcome(await sourceCommands.startAction(request).catch(error=>error))).toBe(true);
  }
  for (const value of [undefined,{}, {...proof,request:null}, {...proof,taskId:42}, {...proof,inputDigest:"invalid"}, {...proof,extra:true}]) {
    invoke.mockResolvedValueOnce(value); expect(hasUnknownOutcome(await sourceCommands.startAction(request).catch(error=>error))).toBe(true);
  }
  expect(invoke.mock.calls.every(([name,args]) => name === "read_source_import_start" && JSON.stringify(args.request) === JSON.stringify(request))).toBe(true);
});
