import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/translation-commands.json";
import * as validators from "./generated/translation.validators";
import unicodeFixture from "../../../crates/core/tests/fixtures/source-unicode.contract.json";
import { hasUnknownOutcome } from "./projectCommands";
import { translationCommands, translationHistoryAfter, validateSaveReceipt, confirmTranslationAction, confirmTranslationReceipt,
  sameTranslationConfirmation, confirmTranslationSelection, type TranslationSaveRequest, type TranslationStartRequest } from "./translationCommands";
import { translationActionFixture, translationReceiptFixture } from "./testSupport/translationFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => invoke.mockReset());
it("reads the complete frozen import request and recovery unit with a required nullable receipt", async () => {
  const adoption: unknown = structuredClone(fixture.adopt),unitId = fixture.prepared.unitId;
  if (!validators.validateRequestAdopt(adoption)) throw new Error("Invalid original import request fixture");
  const request = {adoption,unitId},action = translationActionFixture(adoption,unitId),receipt = translationReceiptFixture(adoption,unitId,null);
  expect(validators.validateRequestAdoptionAction(request)).toBe(true);
  expect(validators.validateRequestAdoptionAction({...request,sessionToken:adoption.sessionToken,projectId:adoption.projectId})).toBe(false);
  for (const value of [null,{action,receipt:null},{action,receipt}]) {
    invoke.mockResolvedValueOnce(value);
    expect(await translationCommands.adoptionAction(request)).toEqual(value);
    expect(invoke).toHaveBeenLastCalledWith("read_translation_adoption_action",{request});
  }
  for (const value of [undefined,{action},{action,receipt:undefined},{action,receipt,extra:true}]) {
    invoke.mockResolvedValueOnce(value);
    const failure = await translationCommands.adoptionAction(request).catch(error=>error);
    expect(hasUnknownOutcome(failure)).toBe(true);expect(validators.validateResponseAdoptionAction(value)).toBe(false);
  }
  expect(invoke.mock.calls.every(([name])=>name==="read_translation_adoption_action")).toBe(true);
});

it("sends the shared translation command fixture without changing field names or values", async () => {
  const start: TranslationStartRequest = fixture.start;
  const save: TranslationSaveRequest = fixture.save;
  invoke.mockResolvedValueOnce(fixture.start.attemptId).mockResolvedValueOnce(fixture.receipt);
  await translationCommands.start(start);
  await translationCommands.save(save);
  expect(invoke.mock.calls).toEqual([
    ["start_translation_import", { request: fixture.start }],
    ["save_translation_revision", { request: fixture.save }],
  ]);
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

it("validates every translation request and response from the shared Rust fixture", async () => {
  const adopt = fixture.adopt;
  if (!validators.validateRequestAdopt(adopt)) throw new Error("Invalid translation fixture");
  for (const [validate, value] of [
    [validators.validateRequestFiles, fixture.filesRequest], [validators.validateRequestCapture, fixture.capture],
    [validators.validateRequestStart, fixture.start], [validators.validateRequestPreview, fixture.previewRequest],
    [validators.validateRequestAdopt, fixture.adopt], [validators.validateRequestHistory, fixture.history],
    [validators.validateRequestSave, fixture.save], [validators.validateRequestAction, fixture.actionRequest],
    [validators.validateRequestSelect, fixture.select], [validators.validateResponseFiles, fixture.files],
    [validators.validateResponsePreflight, fixture.preflight], [validators.validateResponseAttempt, fixture.start.attemptId],
    [validators.validateResponsePreview, fixture.preview], [validators.validateResponsePrepared, fixture.prepared],
    [validators.validateResponseHistory, fixture.historyResponse], [validators.validateResponseAction, fixture.selected],
    [validators.validateResponseAction, null], [validators.validateResponseSaved, fixture.receipt],
    [validators.validateResponseSelected, fixture.selected],
  ] as const) expect(validate(value), validate.name).toBe(true);
  for (const [command, request, response, method] of [
    ["list_translation_files", fixture.filesRequest, fixture.files, () => translationCommands.files(fixture.filesRequest)],
    ["preflight_translation", fixture.capture, fixture.preflight, () => translationCommands.preflight(fixture.capture)],
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


it.each(["save", "selection"] as const)("reads the complete original %s request without another mutation", async kind => {
  const request = kind === "save" ? fixture.save : fixture.select;
  const command = kind === "save" ? "read_translation_save_action" : "read_translation_selection_action";
  const read = () => kind === "save" ? translationCommands.saveAction(fixture.save) : translationCommands.selectionAction(fixture.select);
  const receipt = kind === "save" ? fixture.receipt : fixture.selected;
  invoke.mockResolvedValueOnce(receipt).mockResolvedValueOnce(null);
  expect(await read()).toEqual(receipt); expect(await read()).toBeNull();
  expect(invoke.mock.calls).toEqual([[command, { request }], [command, { request }]]);
});
it.each(["save", "selection"] as const)("keeps malformed or unrelated %s read acknowledgements unknown", async kind => {
  const read = () => kind === "save" ? translationCommands.saveAction(fixture.save) : translationCommands.selectionAction(fixture.select);
  const wrong = kind === "save" ? { ...fixture.receipt, revision: { ...fixture.receipt.revision, text: "Another draft" } }
    : { ...fixture.selected, revisionId: fixtureIdentity(999) };
  for (const response of [undefined, {}, wrong]) {
    invoke.mockResolvedValueOnce(response);
    expect(hasUnknownOutcome(await read().catch(error => error))).toBe(true);
  }
  expect(invoke.mock.calls.every(([command]) => command === (kind === "save" ? "read_translation_save_action" : "read_translation_selection_action"))).toBe(true);
});

it("reads the full native translation start tuple without weakening digest or language evidence", async () => {
  const request = fixture.start; const { sessionToken: _session, ...original } = request;
  const proof = { request: original, taskId: fixtureIdentity(980), inputDigest: "b".repeat(64) };
  expect(validators.validateRequestStartAction(request)).toBe(true);
  for (const value of [null,proof]) { invoke.mockResolvedValueOnce(value); expect(await translationCommands.startAction(request)).toEqual(value); }
  for (const changed of [{projectId:fixtureIdentity(777)},{attemptId:fixtureIdentity(777)},{selectionId:fixtureIdentity(777)},
    {fileName:"zh-CN.json"},{targetLocale:"zh-TW"},{languageConfirmed:false},{expectedFileDigest:"f".repeat(64)},{expectedSourceSnapshotId:fixtureIdentity(777)}]) {
    invoke.mockResolvedValueOnce({...proof,request:{...original,...changed}});
    expect(hasUnknownOutcome(await translationCommands.startAction(request).catch(error=>error))).toBe(true);
  }
  for (const value of [undefined,{}, {...proof,request:null}, {...proof,taskId:42}, {...proof,inputDigest:"invalid"}, {...proof,extra:true}]) {
    invoke.mockResolvedValueOnce(value); expect(hasUnknownOutcome(await translationCommands.startAction(request).catch(error=>error))).toBe(true);
  }
  expect(invoke.mock.calls.every(([name,args]) => name === "read_translation_import_start" && JSON.stringify(args.request) === JSON.stringify(request))).toBe(true);
});
