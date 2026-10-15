import executionFixture from "../test/fixtures/pluginTranslationExecution.contract.json";
import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/translation-commands.json";
import captureFixture from "../test/fixtures/pluginTranslationCapture.contract.json";
import * as validators from "./generated/translation.validators";
import unicodeFixture from "../../../crates/core/tests/fixtures/source-unicode.contract.json";
import { hasUnknownOutcome } from "./projectCommands";
import { translationCommands, translationHistoryAfter, validateSaveReceipt, confirmTranslationAction, confirmTranslationReceipt,
  sameTranslationConfirmation, confirmTranslationSelection, type TranslationSaveRequest } from "./translationCommands";
import { translationActionFixture, translationReceiptFixture } from "./testSupport/translationFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => invoke.mockReset());

it("routes declared translation selection and capture through generated contracts", async () => {
  expect(validators.validateRequestSource(captureFixture.sourceRequest)).toBe(true);
  expect(validators.validateRequestPluginSelect(captureFixture.select)).toBe(true);
  expect(validators.validateRequestPluginCapture(captureFixture.capture)).toBe(true);
  invoke.mockResolvedValueOnce(captureFixture.source).mockResolvedValueOnce(captureFixture.selection)
    .mockResolvedValueOnce(["zh.json"]).mockResolvedValueOnce(captureFixture.preflight);
  expect(await translationCommands.pluginSource(captureFixture.sourceRequest)).toEqual(captureFixture.source);
  expect(await translationCommands.selectPlugin(captureFixture.select)).toEqual(captureFixture.selection);
  const files = { sessionToken: captureFixture.capture.sessionToken, projectId: captureFixture.capture.projectId, selectionId: captureFixture.capture.selectionId };
  expect(await translationCommands.pluginFiles(files)).toEqual(["zh.json"]);
  expect(await translationCommands.preflightPlugin(captureFixture.capture)).toEqual(captureFixture.preflight);
  expect(invoke.mock.calls).toEqual([
    ["read_plugin_translation_source", { request: captureFixture.sourceRequest }],
    ["select_plugin_translation", { request: captureFixture.select }],
    ["list_plugin_translation_files", { request: files }],
    ["preflight_plugin_translation", { request: captureFixture.capture }],
  ]);
});

it("keeps source counters exact and refuses added capture authority or invalid observations", async () => {
  expect(validators.validateResponseSource(captureFixture.source)).toBe(true);
  expect(validators.validateResponsePluginSelection(null)).toBe(true);
  expect(validators.validateResponsePluginPreflight(captureFixture.preflight)).toBe(true);
  expect(validators.validateResponseSource({ ...captureFixture.source, contentRevision: 9007199254740993 })).toBe(false);
  for (const property of ["path", "directory", "targetLocale", "grantId", "approved"]) {
    expect(validators.validateRequestPluginCapture({ ...captureFixture.capture, [property]: true })).toBe(false);
  }
  invoke.mockResolvedValue({ ...captureFixture.preflight, grantId: "forged" });
  await expect(translationCommands.preflightPlugin(captureFixture.capture)).rejects.toThrow();
  invoke.mockResolvedValueOnce(captureFixture.source);
  expect((await translationCommands.pluginSource(captureFixture.sourceRequest)).contentRevision).toBe("9223372036854775807");
});

it("sends the retained manual save fixture without changing field names or values", async () => {
  const save: TranslationSaveRequest = fixture.save;
  invoke.mockResolvedValueOnce(fixture.receipt);
  await translationCommands.save(save);
  expect(invoke.mock.calls).toEqual([["save_translation_revision", { request: fixture.save }]]);
});

it("round trips exact decimal counters and Unicode text in a confirmed save", async () => {
  invoke.mockResolvedValue(fixture.receipt);
  const receipt = await translationCommands.save(fixture.save);
  expect(JSON.parse(JSON.stringify(receipt))).toEqual(fixture.receipt);
  expect(receipt.selection.sequence).toBe("9223372036854775807");
  expect(receipt.revision.ordinal).toBe("9007199254740993");
  expect(translationHistoryAfter(receipt.revision.ordinal, 100)).toBe("9007199254740893");
  expect(translationHistoryAfter("2", 100)).toBe("0");
  invoke.mockResolvedValueOnce(fixture.historyResponse);
  await translationCommands.history(fixture.history);
  expect(invoke).toHaveBeenLastCalledWith("read_translation_history", { request: fixture.history });
});

it.each([
  ["action", (value: typeof fixture.receipt) => { value.actionId = fixture.start.selectionId; }],
  ["unit", (value: typeof fixture.receipt) => { value.selection.unitId = fixture.start.selectionId; }],
  ["basis", (value: typeof fixture.receipt) => { value.basis.selectionId = fixture.start.selectionId; }],
  ["text", (value: typeof fixture.receipt) => { value.revision.text = "Other draft"; }],
  ["zero sequence", (value: typeof fixture.receipt) => { value.selection.sequence = "0"; }],
  ["zero ordinal", (value: typeof fixture.receipt) => { value.revision.ordinal = "0"; }],
  ["number", (value: typeof fixture.receipt) => { Object.assign(value.selection, { sequence: 9007199254740993 }); }],
  ["noncanonical", (value: typeof fixture.receipt) => { value.revision.ordinal = "01"; }],
  ["overflow", (value: typeof fixture.receipt) => { value.selection.sequence = "9223372036854775808"; }],
])("does not confirm an invalid save receipt (%s)", (_name, change) => {
  const value = structuredClone(fixture.receipt);
  change(value);
  expect(() => validateSaveReceipt(value, fixture.save)).toThrow("Invalid save receipt");
});

it("validates retained translation requests and responses from the shared Rust fixture", async () => {
  const adopt = fixture.adopt;
  if (!validators.validateRequestAdopt(adopt)) throw new Error("Invalid translation fixture");
  for (const [validate, value] of [
    [validators.validateRequestFiles, fixture.filesRequest], [validators.validateRequestPreview, fixture.previewRequest],
    [validators.validateRequestAdopt, fixture.adopt], [validators.validateRequestHistory, fixture.history],
    [validators.validateRequestSave, fixture.save], [validators.validateRequestAction, fixture.actionRequest],
    [validators.validateRequestSelect, fixture.select], [validators.validateResponseFiles, fixture.files],
    [validators.validateResponseAttempt, fixture.start.attemptId],
    [validators.validateResponsePreview, fixture.preview], [validators.validateResponsePrepared, fixture.prepared],
    [validators.validateResponseHistory, fixture.historyResponse], [validators.validateResponseAction, fixture.selected],
    [validators.validateResponseAction, null], [validators.validateResponseSaved, fixture.receipt],
    [validators.validateResponseSelected, fixture.selected],
  ] as const) expect(validate(value), validate.name).toBe(true);
  for (const [command, request, response, method] of [
    ["read_translation_preview", fixture.previewRequest, fixture.preview, () => translationCommands.preview(fixture.previewRequest)],
    ["prepare_translation_adoption", fixture.adopt, fixture.prepared, () => translationCommands.prepare(adopt)],
    ["read_translation_action", fixture.actionRequest, null, () => translationCommands.action(fixture.actionRequest)],
    ["select_translation_revision", fixture.select, fixture.selected, () => translationCommands.select(fixture.select)],
  ] as const) {
    invoke.mockResolvedValueOnce(response);
    // Each fixture was checked above against its actual request schema.
    expect(await method()).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith(command, { request });
  }
});

it("rejects missing fields, unknown states, imprecise integers and invalid identities", () => {
  for (const counter of [9007199254740992, "01", "9223372036854775808", "-1"]) {
    expect(validators.validateResponseHistory({ ...fixture.historyResponse, nextOrdinal: counter })).toBe(false);
  }
  expect(validators.validateRequestPreview({ ...fixture.previewRequest, after: 4294967295 })).toBe(true);
  expect(validators.validateRequestPreview({ ...fixture.previewRequest, after: 4294967296 })).toBe(false);
  const value = structuredClone(fixture.preview);
  value.rows[0].entry.valueByteRange[1] = 4294967296;
  expect(validators.validateResponsePreview(value)).toBe(false);
  expect(validators.validateResponseSaved({ ...fixture.receipt, revision: { ...fixture.receipt.revision, originKind: "plugin" } })).toBe(false);
  expect(validators.validateResponsePreview({ ...fixture.preview, rows: [{ ...fixture.preview.rows[0], status: "ready" }] })).toBe(false);
  const { contributors: _omitted, ...revision } = fixture.receipt.revision;
  expect(validators.validateResponseSaved({ ...fixture.receipt, revision })).toBe(false);
  expect(validators.validateResponseSelected({ ...fixture.selected, eventId: "not-an-id" })).toBe(false);
  expect(validators.validateRequestAdopt({ ...fixture.adopt, confirmation: { ...fixture.adopt.confirmation, decision: "overwrite" } })).toBe(false);
});

it("preserves explicitly absent display ranges and requires the nullable wire field", async () => {
  const preview = structuredClone(fixture.preview);
  Object.assign(preview.rows[0].entry, { keyByteRange: null });
  expect(validators.validateResponsePreview(preview)).toBe(true);
  invoke.mockResolvedValueOnce(preview);
  expect((await translationCommands.preview(fixture.previewRequest)).rows[0].entry.keyByteRange).toBeNull();
  const { keyByteRange: _range, ...entry } = preview.rows[0].entry;
  expect(validators.validateResponsePreview({ ...preview, rows: [{ ...preview.rows[0], entry }] })).toBe(false);
});

it("keeps malformed mutation confirmations unknown and preserves structured rejections", async () => {
  invoke.mockResolvedValueOnce({ ...fixture.selected, sequence: 1 });
  await expect(translationCommands.select(fixture.select)).rejects.toSatisfy(hasUnknownOutcome);
  invoke.mockResolvedValueOnce({ ...fixture.receipt, revision: { ...fixture.receipt.revision, originKind: "plugin" } });
  await expect(translationCommands.save(fixture.save)).rejects.toSatisfy(hasUnknownOutcome);
  const rejected = { code: "dependency-conflict", stage: "execution-write", outcome: "rejected", reason: "translation-selection" };
  invoke.mockRejectedValueOnce(rejected);
  await expect(translationCommands.save(fixture.save)).rejects.toBe(rejected);
});

it("interprets translation ranges as original UTF-8 bytes rather than decoded UTF-16 indices", () => {
  const entry = fixture.preview.rows[0].entry;
  const raw = unicodeFixture.cases[0].raw;
  const bytes = new TextEncoder().encode(raw);
  const [start, end] = entry.valueByteRange;
  const captured = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
  expect(JSON.parse(captured)).toBe(entry.text);
  const [utf16Start, utf16End] = unicodeFixture.cases[0].rows[0].valueUtf16Range;
  expect(raw.slice(utf16Start, utf16End)).toBe(captured);
  expect(raw.slice(start, end)).not.toBe(captured);
});

it("binds an omitted expected selection to Serde's no-selection value", () => {
  const { expectedSelectionId: _omitted, ...request } = fixture.save;
  const receipt = structuredClone(fixture.receipt);
  if (!validators.validateResponseSaved(receipt)) throw new Error("Invalid translation fixture");
  const firstReceipt: import("./translationCommands").TranslationSaveReceipt = receipt;
  firstReceipt.selection.previousEventId = null;
  firstReceipt.selection.sequence = "1";
  expect(validators.validateRequestSave(request)).toBe(true);
  expect(validateSaveReceipt(receipt, request)).toEqual(receipt);
  expect(() => validateSaveReceipt(fixture.receipt, request)).toThrow("Invalid save receipt");
});

it("connects original producer, independent checker and projection contracts through checked IPC", async () => {
  const { start, checkPrepare, checkReview, checkFinish, projectionPrepare, projectionReview, projectionStart } = executionFixture;
  if (!validators.validateRequestPluginStart(start)
    || !validators.validateRequestCheckPrepare(checkPrepare)
    || !validators.validateRequestCheckFinish(checkFinish)
    || !validators.validateRequestProjectionPrepare(projectionPrepare)
    || !validators.validateRequestProjectionStart(projectionStart)
    || !validators.validateResponseCheckReview(checkReview)
    || !validators.validateResponseProjectionReview(projectionReview)) throw new Error("Invalid shared translation execution fixture");
  const checkerStart = { ...start, attemptId: checkReview.attemptId, inputDigest: checkReview.inputDigest, grantId: checkFinish.resultId };
  for (const [command, request, response, method] of [
    ["start_plugin_translation", start, start.attemptId, () => translationCommands.startPlugin(start)],
    ["prepare_translation_check", checkPrepare, checkReview, () => translationCommands.prepareCheck(checkPrepare)],
    ["start_translation_check", checkerStart, checkerStart.attemptId, () => translationCommands.startCheck(checkerStart)],
    ["finish_translation_check", checkFinish, null, () => translationCommands.finishCheck(checkFinish)],
    ["prepare_translation_projection", projectionPrepare, projectionReview, () => translationCommands.prepareProjection(projectionPrepare)],
    ["start_translation_projection", projectionStart, projectionStart.attemptId, () => translationCommands.startProjection(projectionStart)],
  ] as const) {
    invoke.mockResolvedValueOnce(response);
    expect(await method()).toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith(command, { request });
  }
});

it("refuses forged translation execution authority, rounded consent and ambiguous proof responses", async () => {
  expect(validators.validateRequestCheckPrepare({ ...executionFixture.checkPrepare, grantId: executionFixture.start.grantId })).toBe(false);
  expect(validators.validateRequestProjectionStart({ ...executionFixture.projectionStart, unsandboxedExecution: true })).toBe(false);
  expect(validators.validateRequestPluginStart({ ...executionFixture.start, expiresAtMs: 9007199254740992 })).toBe(false);
  expect(validators.validateResponseCheckReview({ ...executionFixture.checkReview, source: { ...executionFixture.checkReview.source, contentRevision: 1 } })).toBe(false);
  expect(validators.validateResponseProjectionReview({ ...executionFixture.projectionReview, itemCount: 4294967296 })).toBe(false);
  const request = executionFixture.checkFinish;
  if (!validators.validateRequestCheckFinish(request)) throw new Error("Invalid shared check identity");
  invoke.mockResolvedValueOnce(true);
  await expect(translationCommands.finishCheck(request)).rejects.toSatisfy(hasUnknownOutcome);

});

it("binds a complete import confirmation to its independent execution adoption unit", () => {
  if (!validators.validateRequestAdopt(fixture.adopt)) throw new Error("Invalid fixture");
  const request = fixture.adopt, unit = fixtureIdentity(403);
  const action = translationActionFixture(request, unit);
  expect(unit).not.toBe(request.confirmation.targetUnitId);
  expect(() => confirmTranslationAction(request, unit, action)).not.toThrow();
  expect(() => confirmTranslationAction(request, request.confirmation.targetUnitId, action)).toThrow();
  expect(sameTranslationConfirmation(request.confirmation, { ...request.confirmation, expectedSelectionId: undefined })).toBe(false);
  const none = { ...request, confirmation: { ...request.confirmation, decision: "candidate-only" as const, expectedSelectionId: null } };
  const { expectedSelectionId: _omitted, ...confirmation } = none.confirmation;
  expect(() => confirmTranslationAction({ ...none, confirmation }, unit, translationActionFixture(none, unit))).not.toThrow();
  expect(() => confirmTranslationAction(request, unit, { ...action, parameters: { resultDigest: request.confirmation.resultDigest } })).toThrow();
});

it("checks import changes by their selection strategy without confusing selection sequence and revision ordinal", () => {
  if (!validators.validateRequestAdopt(fixture.adopt)) throw new Error("Invalid fixture");
  const unit = fixtureIdentity(403), request = fixture.adopt;
  const replaced = translationReceiptFixture(request, unit, "3");
  expect(replaced.changes.map(change => change.revision)).toEqual(["7", "4"]);
  expect(confirmTranslationReceipt(request, unit, replaced, "3")).toBe(replaced);
  expect(replaced.requestDigest).not.toBe(request.confirmation.resultDigest);
  const candidate = { ...request, confirmation: { ...request.confirmation, decision: "candidate-only" as const } };
  expect(confirmTranslationReceipt(candidate, unit, translationReceiptFixture(candidate, unit, "3"), "3").changes).toHaveLength(1);
  const empty = { ...request, confirmation: { ...request.confirmation, decision: "select-if-empty" as const, expectedSelectionId: null } };
  expect(confirmTranslationReceipt(empty, unit, translationReceiptFixture(empty, unit), null).changes.map(change => change.revision)).toEqual(["7", "1"]);
  expect(() => confirmTranslationReceipt(empty, unit, { ...translationReceiptFixture(empty, unit), requestDigest: "A".repeat(64) }, null)).toThrow();
  expect(() => confirmTranslationReceipt(request, unit, { ...replaced, changes: [...replaced.changes].reverse() }, "3")).toThrow();
});

it("checks the exact original revision selection instead of accepting a truthy selection", () => {
  expect(confirmTranslationSelection(fixture.select, fixture.selected)).toEqual(fixture.selected);
  expect(() => confirmTranslationSelection(fixture.select, { ...fixture.selected, revisionId: fixtureIdentity(99) })).toThrow();
  expect(() => confirmTranslationSelection(fixture.select, { ...fixture.selected, previousEventId: null })).toThrow();
});
