import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/translationMemory.contract.json";
import { resourceCommands } from "./resourceCommands";
import { translationCommands } from "./translationCommands";
import { sameDraftValue } from "./draftCommands";
import { validateRequestTranslationMemoryPage, validateRequestTranslationMemoryEntry, validateRequestTranslationMemoryReuse,
  validateResponseTranslationMemoryPage, validateResponseTranslationMemoryEntry, validateResponseTranslationMemoryReuse } from "./generated/resource.validators";
import { validateRequestSave, validateResponseSaved } from "./generated/translation.validators";
import { validateResponseWritten } from "./generated/draft.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
function data() {
  const pageRequest: unknown = structuredClone(fixture.requests.page), entryRequest: unknown = structuredClone(fixture.requests.entry);
  const reuseRequest: unknown = structuredClone(fixture.requests.reuse), saveRequest: unknown = structuredClone(fixture.requests.save);
  const page: unknown = structuredClone(fixture.responses.page), entry: unknown = structuredClone(fixture.responses.entry);
  const preview: unknown = structuredClone(fixture.responses.reuse), saved: unknown = structuredClone(fixture.responses.saved);
  if (!validateRequestTranslationMemoryPage(pageRequest) || !validateRequestTranslationMemoryEntry(entryRequest)
    || !validateRequestTranslationMemoryReuse(reuseRequest) || !validateRequestSave(saveRequest)
    || !validateResponseTranslationMemoryPage(page) || !validateResponseTranslationMemoryEntry(entry)
    || !validateResponseTranslationMemoryReuse(preview) || !validateResponseSaved(saved)) throw new Error("Invalid shared memory fixture");
  return { pageRequest, entryRequest, reuseRequest, saveRequest, page, entry, preview, saved };
}

it("reads project memory, an exact donor and its target preview before a separate manual save", async () => {
  const value = data();
  invoke.mockResolvedValueOnce(value.page).mockResolvedValueOnce(value.entry).mockResolvedValueOnce(value.preview).mockResolvedValueOnce(value.saved);
  await expect(resourceCommands.translationMemoryPage(value.pageRequest)).resolves.toEqual(value.page);
  await expect(resourceCommands.translationMemoryEntry(value.entryRequest)).resolves.toEqual(value.entry);
  await expect(resourceCommands.prepareTranslationMemoryReuse(value.reuseRequest)).resolves.toEqual(value.preview);
  await expect(translationCommands.save(value.saveRequest)).resolves.toEqual(value.saved);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["list_translation_memory", "read_translation_memory_entry", "prepare_translation_memory_reuse", "save_translation_revision"]);
  expect(value.saved.revision.text).toBe("Reviewed target A {{name}} é 👩🏽‍💻");
});

it.each(["project", "filter", "locale", "duplicate", "source-label", "cursor"])("rejects a memory page with a changed %s", async kind => {
  const { pageRequest, page } = data();
  if (kind === "project") page.projectId = page.rows[0].revision.unitId;
  if (kind === "filter") page.filter.selection = "historical";
  if (kind === "locale") page.rows[0].revision.locale = "ja";
  if (kind === "duplicate") page.rows.push(structuredClone(page.rows[0]));
  if (kind === "source-label") page.rows[0].sourceLabel.occurrenceCount = 0;
  if (kind === "cursor") { page.rows = []; page.nextCursor = "another-page"; }
  invoke.mockResolvedValueOnce(page);
  await expect(resourceCommands.translationMemoryPage(pageRequest)).rejects.toThrow("Invalid IPC response");
  expect(invoke).toHaveBeenCalledOnce();
});

it.each(["project", "unit", "revision"])("rejects an exact donor from another %s", async kind => {
  const { entryRequest, entry } = data();
  if (kind === "project") entry.projectId = entry.revision.unitId;
  if (kind === "unit") entry.revision.unitId = entry.revision.revisionId;
  if (kind === "revision") entry.revision.revisionId = entry.revision.unitId;
  invoke.mockResolvedValueOnce(entry);
  await expect(resourceCommands.translationMemoryEntry(entryRequest)).rejects.toThrow("Invalid IPC response");
});

it.each(["target", "source", "selection", "donor", "origin-target", "origin-donor", "origin-basis"])("rejects reuse prepared for a changed %s", async kind => {
  const { reuseRequest, preview } = data();
  if (kind === "target") preview.target.unitId = preview.donor.revision.unitId;
  if (kind === "source") preview.target.sourceRevisionId = preview.donor.revision.sourceRevisionId;
  if (kind === "selection") preview.target.selectionId = preview.donor.revision.revisionId;
  if (kind === "donor") preview.donor.revision.revisionId = preview.donor.revision.unitId;
  if (kind === "origin-target") preview.reuseOrigin.targetUnitId = preview.donor.revision.unitId;
  if (kind === "origin-donor") preview.reuseOrigin.donorTranslationRevisionId = preview.donor.revision.unitId;
  if (kind === "origin-basis") preview.reuseOrigin.donorBasis = "c".repeat(64);
  invoke.mockResolvedValueOnce(preview);
  await expect(resourceCommands.prepareTranslationMemoryReuse(reuseRequest)).rejects.toThrow("Invalid IPC response");
});

it("captures a filter before the caller changes it while its page is pending", async () => {
  const { pageRequest, page } = data(), captured = structuredClone(pageRequest);
  let finish!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const read = resourceCommands.translationMemoryPage(pageRequest);
  pageRequest.filter.selection = "historical"; finish(page);
  await expect(read).resolves.toEqual(page);
  expect(invoke).toHaveBeenCalledWith("list_translation_memory", { request: captured });
});

it("requires an explicit new origin to be acknowledged but permits Core to inherit an existing origin", async () => {
  const { saveRequest, saved } = data();
  const forged = structuredClone(saved); forged.revision.reuseOrigin = undefined;
  invoke.mockResolvedValueOnce(forged);
  await expect(translationCommands.save(saveRequest)).rejects.toThrow("Invalid save receipt");
  delete saveRequest.reuseOrigin;
  invoke.mockResolvedValueOnce(saved);
  await expect(translationCommands.save(saveRequest)).resolves.toEqual(saved);
});

it("keeps the full original reuse request during recovery", async () => {
  const { saveRequest } = data();
  const changed = structuredClone(fixture.responses.recovery);
  changed.request.reuseOrigin.donorBasis = "c".repeat(64);
  invoke.mockResolvedValueOnce(changed);
  await expect(translationCommands.recoverSave(saveRequest)).rejects.toThrow("Invalid save receipt");
});

it("accepts Serde's null selection when the original origin omitted that optional input", async () => {
  const { saveRequest, saved } = data();
  if (!saveRequest.reuseOrigin || !saved.revision.reuseOrigin) throw new Error("Expected a saved reuse origin");
  saveRequest.reuseOrigin.targetSelectionId = undefined;
  saved.revision.reuseOrigin.targetSelectionId = null;
  const { sessionToken: _sessionToken, ...original } = saveRequest;
  const recovered = { request: { ...original, reuseOrigin: { ...saveRequest.reuseOrigin, targetSelectionId: null } },
    outcome: { kind: "recorded", receipt: saved } };
  invoke.mockResolvedValueOnce(saved).mockResolvedValueOnce(recovered);
  await expect(translationCommands.save(saveRequest)).resolves.toEqual(saved);
  await expect(translationCommands.recoverSave(saveRequest)).resolves.toEqual(recovered);
});

it("compares draft and pending origins instead of accepting equal text with a different donor", () => {
  const save = fixture.requests.save;
  const head: unknown = { key: { projectId: save.projectId, unitId: save.unitId, locale: save.locale },
    revision: "1", writerId: "00000000-0000-4000-8000-000000080009", value: structuredClone(fixture.draft) };
  if (!validateResponseWritten(head) || !head.value) throw new Error("Invalid shared draft fixture");
  const other = structuredClone(head.value);
  if (!other.reuseOrigin || other.pending?.kind !== "save" || !other.pending.request.reuseOrigin) throw new Error("Expected source-bearing draft");
  other.reuseOrigin.donorBasis = "c".repeat(64);
  expect(sameDraftValue(head.value, other)).toBe(false);
  other.reuseOrigin = structuredClone(head.value.reuseOrigin);
  other.pending.request.reuseOrigin.donorBasis = "c".repeat(64);
  expect(sameDraftValue(head.value, other)).toBe(false);
});
