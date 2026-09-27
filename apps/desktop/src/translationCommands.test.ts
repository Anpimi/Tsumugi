import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/translation-commands.json";
import { translationCommands, type TranslationSaveRequest, type TranslationStartRequest } from "./translationCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => invoke.mockReset());

it("sends the shared translation command fixture without changing field names or values", async () => {
  const start: TranslationStartRequest = fixture.start;
  const save: TranslationSaveRequest = fixture.save;
  invoke.mockResolvedValue(null);
  await translationCommands.start(start);
  await translationCommands.save(save);
  expect(invoke.mock.calls).toEqual([
    ["start_translation_import", { request: fixture.start }],
    ["save_translation_revision", { request: fixture.save }],
  ]);
});
