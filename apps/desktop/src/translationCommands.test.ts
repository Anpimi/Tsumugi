import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/translation-commands.json";
import { translationCommands, translationHistoryAfter, validateSaveReceipt, type TranslationSaveRequest, type TranslationStartRequest } from "./translationCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => invoke.mockReset());

it("sends the shared translation command fixture without changing field names or values", async () => {
  const start: TranslationStartRequest = fixture.start;
  const save: TranslationSaveRequest = fixture.save;
  invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(fixture.receipt);
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
  await translationCommands.history(fixture.history);
  expect(invoke).toHaveBeenLastCalledWith("read_translation_history", { request: fixture.history });
});

it.each([
  ["action", (value: typeof fixture.receipt) => { value.actionId = "other-action"; }],
  ["unit", (value: typeof fixture.receipt) => { value.selection.unitId = "other-unit"; }],
  ["basis", (value: typeof fixture.receipt) => { value.basis.selectionId = "other-selection"; }],
  ["text", (value: typeof fixture.receipt) => { value.revision.text = "Other draft"; }],
  ["number", (value: typeof fixture.receipt) => { Object.assign(value.selection, { sequence: 9007199254740993 }); }],
  ["noncanonical", (value: typeof fixture.receipt) => { value.revision.ordinal = "01"; }],
  ["overflow", (value: typeof fixture.receipt) => { value.selection.sequence = "9223372036854775808"; }],
])("does not confirm an invalid save receipt (%s)", (_name, change) => {
  const value = structuredClone(fixture.receipt);
  change(value);
  expect(() => validateSaveReceipt(value, fixture.save)).toThrow("Invalid save receipt");
});
