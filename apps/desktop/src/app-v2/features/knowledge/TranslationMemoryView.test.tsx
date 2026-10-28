import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translation from "../../../../test/fixtures/translation-commands.json";
import { i18n } from "../../../i18n";
import type { translationMemoryEn } from "../../../i18n/translationMemory";
import type { DraftHead, DraftValue } from "../../../draftCommands";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands } from "../../../resourceCommands";
import { reviewCommands } from "../../../reviewCommands";
import { SessionReads } from "../../../sessionReads";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { reviewDecisionFixture, reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { translationMemoryEntryFixture, translationMemoryReuseFixture } from "../../../testSupport/translationMemoryFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { emptyTranslationMemoryPresentation, makeWorkspaceView } from "../../workspace/workspaceStore";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import TranslationMemoryView from "./TranslationMemoryView";
import { MemoryEntryEvidence } from "./TranslationMemoryDetails";

const project: ProjectView = { sessionToken: "synthetic-tm-ui", locator: "/synthetic/tm-ui", reconciliationState: "settled",
  metadata: { projectId: translation.save.projectId, displayName: "Synthetic memory", sourceLocale: "en", targetLocales: [translation.save.locale], metadataRevision: "1" } };
const context = { projectId: project.metadata.projectId, sessionToken: project.sessionToken };
const target = reviewTargetFixture({ unitId: translation.save.unitId, locale: translation.save.locale, sourceRevisionId: translation.save.sourceRevisionId,
  selectionId: null, revisionId: null, translationText: null, nativeKey: "dialogue.departure" });
const key = { projectId: context.projectId, unitId: target.unitId, locale: target.locale }, basis = { sourceRevisionId: target.sourceRevisionId, selectionId: null, revisionId: null, text: null };
type TextKey = { [K in keyof typeof translationMemoryEn]: typeof translationMemoryEn[K] extends string ? K : never }[keyof typeof translationMemoryEn];
const m = (key: TextKey) => i18n.t(`knowledge.${key}`);
const resources: { reads: SessionReads; drafts: TranslationDrafts; gate: InteractionGate }[] = [];
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); resources.splice(0).forEach(value => { value.reads.retire(); value.drafts.retire(); value.gate.dispose(); }); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function harness(input = "") {
  const donor = translationMemoryEntryFixture(), preview = translationMemoryReuseFixture(target, donor), reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("memory-view");
  const next = { ...structuredClone(donor), basis: "f".repeat(64), revision: { ...donor.revision, unitId: id(97011), revisionId: id(97012), text: "Second historical translation" },
    sourceLabel: { ...donor.sourceLabel, nativeKey: "dialogue.return" }, isCurrentSelection: false, isCurrentSource: false };
  const page = vi.spyOn(resourceCommands, "translationMemoryPage").mockImplementation(async request => ({ projectId: context.projectId, filter: { ...request.filter,
    sourceText: request.filter.sourceText ?? null, translationText: request.filter.translationText ?? null, origin: request.filter.origin ?? null },
    basis: "synthetic-page-basis", rows: request.cursor ? [next] : [donor], nextCursor: request.cursor ? null : "synthetic-next-cursor" }));
  vi.spyOn(resourceCommands, "translationMemoryEntry").mockImplementation(async request => request.revisionId === next.revision.revisionId ? next : donor);
  const prepare = vi.spyOn(resourceCommands, "prepareTranslationMemoryReuse").mockResolvedValue(preview);
  vi.spyOn(reviewCommands, "editorSnapshot").mockResolvedValue({ readVersion: "synthetic-read", target, context: null,
    terms: { unitId: target.unitId, locale: target.locale, sourceRevisionId: target.sourceRevisionId, entries: [] },
    translations: { unitId: target.unitId, locale: target.locale, current: null, currentText: null, total: "0", rows: [], nextOrdinal: null } });
  let disk: DraftHead = input ? { key, revision: "1", writerId: id(97021), value: { basis, text: input, editSeq: "1", pending: null } }
    : { key, revision: "0", writerId: null, value: null };
  const ports = {
    list: vi.fn<TranslationDraftPorts["list"]>(async () => ({ items: [], next: null })),
    read: vi.fn<TranslationDraftPorts["read"]>(async () => ({ head: structuredClone(disk), current: { kind: "current", basis, sourceText: target.sourceText, nativeKey: target.nativeKey } })),
    write: vi.fn<TranslationDraftPorts["write"]>(async request => { disk = { key, revision: String(BigInt(disk.revision) + 1n), writerId: request.write.writerId, value: structuredClone(request.write.value) as DraftValue }; return structuredClone(disk); }),
    save: vi.fn<TranslationDraftPorts["save"]>(), select: vi.fn<TranslationDraftPorts["select"]>(), suggestions: vi.fn<TranslationDraftPorts["suggestions"]>(),
    prepareMemoryReuse: prepare,
  };
  const drafts = new TranslationDrafts({ context, reads, ports }); resources.push({ reads, drafts, gate }); await drafts.initialize();
  const onEdit = vi.fn(async () => true), onDetails = vi.fn();
  function Shell({ visible }: { visible: boolean }) {
    const [view, setView] = useState(() => makeWorkspaceView({ kind: "knowledge", locale: target.locale, preset: "memory",
      translationMemory: { ...emptyTranslationMemoryPresentation(), targetUnitId: target.unitId } }, "memory-view"));
    return visible ? <TranslationMemoryView project={project} view={view} drafts={drafts} disabled={false} gate={gate}
      current={dialogId => gate.canDispatch({ viewId: "memory-view", source: "button", dialogId })} patch={patch => setView(value => ({ ...value, ...patch }))} onEdit={onEdit} onDetails={onDetails}/> : null;
  }
  const tree = (visible: boolean) => <SessionReadProvider context={context} reads={reads} bridge={false}><Shell visible={visible}/></SessionReadProvider>;
  const view = render(tree(true));
  const choose = async () => { fireEvent.click(await screen.findByRole("button", { name: donor.sourceLabel.nativeKey }));
    await waitFor(() => expect(screen.getByRole("button", { name: m("memoryStage") })).toBeEnabled()); };
  return { donor, next, preview, page, prepare, reads, drafts, ports, onEdit, onDetails, choose, disk: () => disk, show: (visible: boolean) => view.rerender(tree(visible)) };
}

it.each(["en-US", "zh-CN"])("updates mounted TM confirmation labels in %s while keeping the target's own B", async locale => {
  await i18n.changeLanguage(locale); const h = await harness("Human B 人工输入"); await h.choose();
  expect(m("memoryReplaceTitle")).toBe(locale === "en-US" ? "Replace this translation draft?" : "替换这份译文草稿？");
  fireEvent.click(screen.getByRole("button", { name: m("memoryStage") }));
  const dialog = await screen.findByRole("dialog", { name: m("memoryReplaceTitle") });
  expect(within(dialog).getByText("Human B 人工输入")).toBeVisible();
  await act(async () => { await i18n.changeLanguage(locale === "en-US" ? "zh-CN" : "en-US"); });
  expect(screen.getByRole("dialog", { name: m("memoryReplaceTitle") })).toBe(dialog);
  expect(within(dialog).getByRole("button", { name: m("memoryReplace") })).toBeEnabled();
  expect(h.drafts.getEntry(key)?.value?.text).toBe("Human B 人工输入");
  fireEvent.click(within(dialog).getByRole("button", { name: m("memoryKeepDraft") }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: m("memoryStage") }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: m("memoryReplace") }));
  await waitFor(() => expect(h.onEdit).toHaveBeenCalledWith(key.unitId, key.locale));
  expect(h.disk().value).toMatchObject({ text: h.donor.revision.text, reuseOrigin: h.preview.reuseOrigin, pending: null });
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled(); expect(h.ports.suggestions).not.toHaveBeenCalled();
});

it("loads bounded pages and retains the actual filters and donor across a presentation unmount", async () => {
  const h = await harness();
  fireEvent.click(await screen.findByRole("button", { name: m("memoryMore") }));
  await screen.findByText(h.next.revision.text);
  expect(h.page.mock.calls[1][0]).toMatchObject({ cursor: "synthetic-next-cursor", limit: 50 });
  fireEvent.change(screen.getByRole("textbox", { name: m("memorySourceSearch") }), { target: { value: "farewell" } });
  fireEvent.change(screen.getByRole("textbox", { name: m("memoryTranslationSearch") }), { target: { value: "quiet" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("knowledge.search") }));
  await waitFor(() => expect(h.page.mock.calls.at(-1)?.[0].filter).toMatchObject({ sourceText: "farewell", translationText: "quiet", sourceLocale: "en", targetLocale: target.locale }));
  await h.choose(); h.show(false); h.show(true);
  expect(screen.getByRole("textbox", { name: m("memorySourceSearch") })).toHaveValue("farewell");
  await screen.findByRole("region", { name: m("memoryComparison") });
  expect(h.ports.save).not.toHaveBeenCalled();
});

it("attaches the same byte limit to the translation search field that exceeded it", async () => {
  await harness(); const source = screen.getByRole("textbox", { name: m("memorySourceSearch") }), translation = screen.getByRole("textbox", { name: m("memoryTranslationSearch") });
  fireEvent.change(translation, { target: { value: "界".repeat(171) } });
  expect(translation).toHaveAttribute("aria-invalid", "true"); expect(translation).toHaveAccessibleDescription(m("memorySearchLimit"));
  expect(source).not.toHaveAttribute("aria-invalid"); expect(screen.getByRole("button", { name: i18n.t("knowledge.search") })).toBeDisabled();
});

it("keeps later B and refuses an earlier explicit replacement after the donor read returns", async () => {
  const h = await harness("Original B"); await h.choose();
  fireEvent.click(screen.getByRole("button", { name: m("memoryStage") }));
  const waiting = deferred<typeof h.preview>(); h.prepare.mockReturnValueOnce(waiting.promise);
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: m("memoryReplace") }));
  await act(async () => { h.drafts.edit(key, "New B while replacement waits"); });
  await act(async () => { waiting.resolve(h.preview); });
  expect(h.drafts.getEntry(key)?.value?.text).toBe("New B while replacement waits");
  expect(h.onEdit).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("separates a historical approval from current source applicability even when the donor remains selected", () => {
  const donor = translationMemoryEntryFixture(), original = reviewTargetFixture({ unitId: donor.revision.unitId, locale: donor.revision.locale,
    revisionId: donor.revision.revisionId, sourceRevisionId: donor.revision.sourceRevisionId, sourceSnapshotId: donor.revision.sourceSnapshotId });
  const approval = reviewDecisionFixture({ projectId: context.projectId, actionId: id(97031), unitId: original.unitId, locale: original.locale,
    expectedBasis: original.basis, expectedDecisionId: null, actor: "Synthetic reviewer", reason: "Reviewed the original version", kind: "approve" }, original);
  render(<MemoryEntryEvidence entry={{ ...donor, isCurrentSource: false, isCurrentSelection: true, quality: { latestDecision: approval, pastApproval: approval, currentApproval: null } }}/>);
  expect(screen.getByText(m("memorySelected"))).toBeVisible(); expect(screen.getByText(m("memorySourceHistorical"))).toBeVisible();
  expect(screen.getByText(m("memoryPastApproval"))).toBeVisible(); expect(screen.queryByText(m("memoryCurrentApproval"))).toBeNull();
  const translatedText = screen.getByText(m("memoryDonorTranslation")).nextElementSibling;
  expect(translatedText?.tagName).toBe("DD"); expect(translatedText).toHaveTextContent(donor.revision.text);
});
