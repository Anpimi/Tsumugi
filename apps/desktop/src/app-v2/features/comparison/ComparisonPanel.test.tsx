import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import arenaFixture from "../../../../test/fixtures/arenaCommands.contract.json";
import translationFixture from "../../../../test/fixtures/translation-commands.json";
import type { ComparisonView } from "../../../arenaCommands";
import type { DraftBasis, DraftHead, DraftValue } from "../../../draftCommands";
import { executionContext } from "../../../executionCommands";
import { validateResponseComparison } from "../../../generated/arena.validators";
import { i18n } from "../../../i18n";
import type { ProjectView } from "../../../projectCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { translationCommands, type TranslationHistory, type TranslationRevision } from "../../../translationCommands";
import { WorkbenchCommands } from "../../../workbenchCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import ComparisonPanel, { type ComparisonPanelProps } from "./ComparisonPanel";
import ComparisonRecovery from "./ComparisonRecovery";
import { ComparisonSession, type ComparisonPorts } from "./ComparisonSession";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "comparison-ui-session", locator: "/synthetic/comparison-ui", reconciliationState: "settled",
  metadata: { projectId: arenaFixture.requests.compare.projectId, displayName: "Synthetic saved comparisons", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const context = executionContext(project), scope = { ...context, area: "translation" as const };
const copy = <T,>(value: T): T => structuredClone(value);
type TextKey = "comparisonTitle" | "comparisonCreate" | "comparisonStageMerge" | "comparisonReveal" | "comparisonDirty"
  | "candidateAdopt" | "candidateCheck" | "candidateRetry" | "comparisonMissing" | "nextPage";
const w = (key: TextKey) => i18n.t(`workbenchV2.${key}`);
function fixtureView(): ComparisonView {
  const value: unknown = copy(arenaFixture.responses.comparison);
  if (!validateResponseComparison(value)) throw new Error("Invalid saved comparison fixture");
  return value;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const resources: { owner: ComparisonSession; drafts: TranslationDrafts; reads: SessionReads; gate: InteractionGate }[] = [];
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); invoke.mockRejectedValue(new Error("Unexpected native call")); });
afterEach(() => {
  cleanup(); resources.splice(0).forEach(({ owner, drafts, reads, gate }) => { owner.dispose(); drafts.retire(); reads.retire(); gate.dispose(); }); vi.restoreAllMocks();
});

async function harness({ setup = false, selected = false, paged = false, disabled = false, parentDialogId }: {
  setup?: boolean; selected?: boolean; paged?: boolean; disabled?: boolean; parentDialogId?: string;
} = {}) {
  let stored = fixtureView();
  if (!selected) stored = { ...stored, selectionId: null, selectedRevisionId: null, selectedText: null };
  const target = reviewTargetFixture({ unitId: stored.unitId, locale: stored.locale, nativeKey: stored.nativeKey, sourceText: stored.sourceText,
    sourceRevisionId: stored.sourceRevisionId, sourceSnapshotId: translationFixture.receipt.revision.sourceSnapshotId,
    selectionId: stored.selectionId, revisionId: stored.selectedRevisionId, translationText: stored.selectedText, basis: stored.basis });
  const key = { projectId: context.projectId, unitId: target.unitId, locale: target.locale };
  const basis: DraftBasis = { sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, text: target.translationText };
  const revisions: TranslationRevision[] = stored.rows.map((row, index) => ({ ...translationFixture.receipt.revision, ...row,
    unitId: stored.unitId, locale: stored.locale, sourceSnapshotId: target.sourceSnapshotId, ordinal: String(index + 1), candidateDecision: null }));
  const history = (): TranslationHistory => ({ unitId: key.unitId, locale: key.locale, total: "2", nextOrdinal: null, currentText: basis.text,
    current: basis.selectionId && basis.revisionId ? { ...translationFixture.receipt.selection, unitId: key.unitId, locale: key.locale,
      eventId: basis.selectionId, revisionId: basis.revisionId } : null, rows: copy(revisions) });
  vi.spyOn(translationCommands, "revision").mockImplementation(async request => {
    const value = revisions.find(row => row.revisionId === request.revisionId && row.unitId === request.unitId && row.locale === request.locale);
    if (!value) throw new Error("Foreign synthetic revision"); return copy(value);
  });
  vi.spyOn(translationCommands, "history").mockImplementation(async request => ({ ...history(),
    rows: paged ? [copy(revisions[request.afterOrdinal === "0" ? 0 : 1])] : copy(revisions),
    nextOrdinal: paged && request.afterOrdinal === "0" ? "1" : null }));
  const reads = new SessionReads(context), gate = new InteractionGate(), commands = new WorkbenchCommands(); gate.setVisibleOwner("entries");
  let disk: DraftHead = { key, revision: "0", writerId: null, value: null };
  const draftPorts = {
    list: async () => ({ items: [], next: null }),
    read: vi.fn<TranslationDraftPorts["read"]>(async () => ({ head: copy(disk), current: { kind: "current", basis: copy(basis), sourceText: target.sourceText, nativeKey: target.nativeKey } })),
    write: vi.fn<TranslationDraftPorts["write"]>(async ({ write }) => {
      disk = { key, revision: (BigInt(disk.revision) + 1n).toString(), writerId: write.writerId, value: copy(write.value) as DraftValue }; return copy(disk);
    }),
    history: vi.fn<TranslationDraftPorts["history"]>(async () => history()),
    comparison: vi.fn<TranslationDraftPorts["comparison"]>(async () => copy(stored)),
    save: vi.fn<TranslationDraftPorts["save"]>(), select: vi.fn<TranslationDraftPorts["select"]>(), merge: vi.fn<TranslationDraftPorts["merge"]>(),
    identity: vi.fn<TranslationDraftPorts["identity"]>(async () => fixtureIdentity(980)), writerId: () => fixtureIdentity(981),
  };
  const drafts = new TranslationDrafts({ context, reads, ports: draftPorts }); await drafts.initialize(); await drafts.open(key);
  const ports = {
    identity: vi.fn<ComparisonPorts["identity"]>(async () => fixtureIdentity(982)),
    comparisons: vi.fn<ComparisonPorts["comparisons"]>(async () => [{ comparisonId: stored.comparisonId!, nativeKey: stored.nativeKey, locale: stored.locale }]),
    comparison: vi.fn<ComparisonPorts["comparison"]>(async () => copy(stored)),
    compare: vi.fn<ComparisonPorts["compare"]>(async request => {
      stored = { ...stored, comparisonId: request.actionId, blind: request.blind, revealed: !request.blind,
        rows: request.revisionIds.map(id => stored.rows.find(row => row.revisionId === id)!).reverse() }; return copy(stored);
    }),
    comparisonAction: vi.fn<ComparisonPorts["comparisonAction"]>(async () => null),
    reveal: vi.fn<ComparisonPorts["reveal"]>(async () => { stored = { ...stored, revealed: true,
      rows: stored.rows.map(row => ({ ...row, model: row.originKind === "ai" ? "Visible saved model" : null, recipe: row.originKind === "ai" ? "Visible saved recipe" : null })) }; }),
    revealTarget: vi.fn<ComparisonPorts["revealTarget"]>(async () => ({ projectId: context.projectId, targetId: stored.comparisonId!, targetKind: "comparison", visible: stored.revealed })),
  };
  const owner = new ComparisonSession({ project, reads, drafts, ports }); resources.push({ owner, drafts, reads, gate });
  const onEdit = vi.fn<ComparisonPanelProps["onEdit"]>(async () => true), onOpenComparison = vi.fn<ComparisonPanelProps["onOpenComparison"]>(async () => true);
  const onReferences = vi.fn<ComparisonPanelProps["onReferences"]>(), onPage = vi.fn<ComparisonPanelProps["onPage"]>(), onBlind = vi.fn<ComparisonPanelProps["onBlind"]>();
  let props: ComparisonPanelProps = { project, target, drafts, owner, commands, gate, viewId: "entries", disabled, visible: true, parentDialogId,
    comparisonId: setup ? null : stored.comparisonId, revisionIds: [], blind: true, afterOrdinal: "0", onEdit, onOpenComparison,
    onReferences, onPage, onBlind, onBack: vi.fn(), onSetup: vi.fn() };
  let recovery = false;
  function ui() { return <SessionReadProvider context={context} reads={reads} bridge={false}>{recovery
    ? <ComparisonRecovery project={project} owner={owner} commands={commands} gate={gate} viewId={props.viewId} disabled={props.disabled}
      visible={props.visible} parentDialogId={props.parentDialogId} onOpenComparison={onOpenComparison} /> : <ComparisonPanel {...props}/>}</SessionReadProvider>; }
  const rendered = render(ui());
  return { owner, reads, gate, commands, drafts, draftPorts, ports, key, target, revisions, onEdit, onOpenComparison, onReferences, onPage, onBlind,
    rendered, view: () => copy(stored), disk: () => copy(disk),
    show: (patch: Partial<ComparisonPanelProps>, showRecovery = recovery) => { props = { ...props, ...patch }; recovery = showRecovery; rendered.rerender(ui()); } };
}
async function candidate(label: string) { return screen.findByRole("article", { name: i18n.t("workbenchV2.comparisonCandidate", { label }) }); }

it("reads at most the fixed real revisions, keeps blind positions anonymous and waits for the Host journal before editing", async () => {
  const h = await harness(), column = await candidate("B"), adopt = within(column).getByRole("button", { name: w("candidateAdopt") });
  await waitFor(() => expect(adopt).toBeEnabled());
  expect(translationCommands.revision).toHaveBeenCalledTimes(2);
  h.revisions.forEach(revision => expect(translationCommands.revision).toHaveBeenCalledWith({ ...context, unitId: h.target.unitId, locale: h.target.locale, revisionId: revision.revisionId }));
  expect(translationCommands.history).not.toHaveBeenCalled();
  expect(screen.getAllByRole("article").map(item => item.getAttribute("aria-label"))).toEqual(["Candidate A", "Candidate B"]);
  expect(column).toHaveTextContent(h.revisions[1].text);
  expect([...column.querySelectorAll("p")].some(item => item.textContent === i18n.t("translation.manualOrigin"))).toBe(false);
  expect(screen.queryByText(i18n.t("ai.origin"))).not.toBeInTheDocument();
  h.revisions.forEach(revision => expect(h.rendered.container.innerHTML).not.toContain(revision.revisionId));
  expect(h.rendered.container.querySelector("[data-ai]")).toBeNull();
  const write = deferred<DraftHead>(), commit = h.draftPorts.write.getMockImplementation()!;
  h.draftPorts.write.mockImplementationOnce(() => write.promise); fireEvent.click(adopt);
  await waitFor(() => expect(h.draftPorts.write).toHaveBeenCalledTimes(1)); expect(h.onEdit).not.toHaveBeenCalled();
  await act(async () => { write.resolve(await commit(h.draftPorts.write.mock.calls[0][0])); });
  await waitFor(() => expect(h.onEdit).toHaveBeenCalledWith(h.target.unitId, h.target.locale));
  expect(h.disk().value).toMatchObject({ text: h.revisions[1].text, pending: null });
  expect(h.draftPorts.save).not.toHaveBeenCalled(); expect(h.draftPorts.select).not.toHaveBeenCalled(); expect(h.draftPorts.merge).not.toHaveBeenCalled();
  expect(h.draftPorts.identity).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
});

it("starts a same-text merge as a real draft retaining every contributor in persisted A/B order", async () => {
  const h = await harness({ selected: true }), column = await candidate("A"), start = within(column).getByRole("button", { name: w("comparisonStageMerge") });
  await waitFor(() => expect(start).toBeEnabled()); fireEvent.click(start);
  await waitFor(() => expect(h.onEdit).toHaveBeenCalledTimes(1));
  expect(h.disk().value).toMatchObject({ text: h.target.translationText, merge: { comparisonId: h.view().comparisonId,
    contributors: h.view().rows.map(row => row.revisionId), expectedBasis: h.view().basis }, pending: null });
  expect(screen.getByText(w("comparisonDirty"))).toBeInTheDocument();
  screen.getAllByRole("button", { name: w("comparisonStageMerge") }).forEach(button => expect(button).toBeDisabled());
  expect(h.draftPorts.merge).not.toHaveBeenCalled(); expect(h.draftPorts.save).not.toHaveBeenCalled(); expect(h.draftPorts.select).not.toHaveBeenCalled();
});

it("retains newer B input and its focus when an earlier staged A journal acknowledgement arrives", async () => {
  const h = await harness(), column = await candidate("B"), adopt = within(column).getByRole("button", { name: w("candidateAdopt") });
  await waitFor(() => expect(adopt).toBeEnabled());
  const write = deferred<DraftHead>(), commit = h.draftPorts.write.getMockImplementation()!;
  h.draftPorts.write.mockImplementationOnce(() => write.promise); fireEvent.click(adopt);
  await waitFor(() => expect(h.draftPorts.write).toHaveBeenCalledTimes(1));
  const input = document.createElement("textarea"); h.rendered.container.append(input); input.focus();
  act(() => { h.gate.setInputOwner("entries", "newer-draft-input"); h.drafts.edit(h.key, "Newer manual B"); });
  await act(async () => { write.resolve(await commit(h.draftPorts.write.mock.calls[0][0])); });
  await waitFor(() => expect(h.drafts.getEntry(h.key)?.busy).toBe(false));
  expect(h.drafts.getEntry(h.key)?.value?.text).toBe("Newer manual B"); expect(h.onEdit).not.toHaveBeenCalled(); expect(input).toHaveFocus();
});

it("retains selected references across bounded pages and creates one exact saved-result comparison", async () => {
  const h = await harness({ setup: true, paged: true });
  const first = await screen.findByRole("checkbox", { name: i18n.t("workbenchV2.comparisonChoice", { number: "1" }) });
  await waitFor(() => expect(first).toBeEnabled()); fireEvent.click(first);
  expect(h.onReferences).toHaveBeenLastCalledWith([h.revisions[0].revisionId]); h.show({ revisionIds: [h.revisions[0].revisionId] });
  fireEvent.click(screen.getByRole("button", { name: w("nextPage") })); expect(h.onPage).toHaveBeenLastCalledWith("1"); h.show({ afterOrdinal: "1" });
  await waitFor(() => expect(translationCommands.history).toHaveBeenCalledWith({ ...context, unitId: h.target.unitId, locale: h.target.locale, afterOrdinal: "1", limit: 50 }));
  const second = await screen.findByRole("checkbox", { name: i18n.t("workbenchV2.comparisonChoice", { number: "1" }) });
  await waitFor(() => expect(second).toBeEnabled());
  expect(second).not.toBeChecked(); expect(second.closest("li")).toHaveTextContent(h.revisions[1].text); fireEvent.click(second);
  expect(h.onReferences).toHaveBeenLastCalledWith(h.revisions.map(row => row.revisionId)); h.show({ revisionIds: h.revisions.map(row => row.revisionId) });
  const create = screen.getByRole("button", { name: w("comparisonCreate") }); await waitFor(() => expect(create).toBeEnabled()); fireEvent.click(create);
  await waitFor(() => expect(h.onOpenComparison).toHaveBeenCalledTimes(1));
  expect(h.ports.compare).toHaveBeenCalledWith({ ...context, actionId: fixtureIdentity(982), unitId: h.target.unitId, locale: h.target.locale,
    revisionIds: h.revisions.map(row => row.revisionId), blind: true });
  expect(h.onOpenComparison.mock.calls[0][0].rows.map(row => row.revisionId)).toEqual([...h.revisions].reverse().map(row => row.revisionId));
  expect(h.draftPorts.write).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
});

it("opens the actual saved target from a same-name summary without guessing its unit", async () => {
  const h = await harness({ setup: true }), foreign = { ...h.view(), unitId: fixtureIdentity(989) };
  const open = await screen.findByRole("button", { name: i18n.t("workbenchV2.comparisonOpenSaved", { name: h.target.nativeKey, locale: h.target.locale }) });
  await waitFor(() => expect(open).toBeEnabled()); h.ports.comparison.mockResolvedValueOnce(foreign); fireEvent.click(open);
  await waitFor(() => expect(h.onOpenComparison).toHaveBeenCalledWith(foreign));
  expect(h.onEdit).not.toHaveBeenCalled(); expect(h.draftPorts.write).not.toHaveBeenCalled();
});

it("uses the current disabled state and the explicit parent dialog rather than inheriting any top dialog", async () => {
  const h = await harness({ disabled: true }); h.show({ disabled: false });
  const column = await candidate("B"), adopt = within(column).getByRole("button", { name: w("candidateAdopt") });
  await waitFor(() => expect(adopt).toBeEnabled());
  let release!: () => void; act(() => { release = h.gate.pushDialog("workspace-dock"); }); expect(adopt).toBeDisabled();
  h.show({ parentDialogId: "workspace-dock" }); await waitFor(() => expect(adopt).toBeEnabled());
  let other!: () => void; act(() => { other = h.gate.pushDialog("unrelated-confirmation"); }); expect(adopt).toBeDisabled();
  act(() => other()); await waitFor(() => expect(adopt).toBeEnabled());
  act(() => h.gate.setComposing("physical-input", true)); expect(adopt).toBeDisabled();
  act(() => { h.gate.setComposing("physical-input", false); release(); });
  expect(h.draftPorts.write).not.toHaveBeenCalled();
});

it("makes reveal explicit and refreshes saved identities without running a provider", async () => {
  const h = await harness(), reveal = await screen.findByRole("button", { name: w("comparisonReveal") });
  await waitFor(() => expect(reveal).toBeEnabled());
  expect(screen.queryByText("Visible saved model", { exact: false })).not.toBeInTheDocument(); fireEvent.click(reveal);
  await screen.findByText("Visible saved model Visible saved recipe");
  expect(h.ports.reveal).toHaveBeenCalledWith({ ...context, actionId: fixtureIdentity(982), comparisonId: h.view().comparisonId });
  expect(h.rendered.container.querySelector("[data-ai]")).not.toBeNull(); expect(h.draftPorts.write).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
});

it("keeps original unknown recovery usable with no views while its shared draft reservation remains retained", async () => {
  const h = await harness({ setup: true });
  h.ports.compare.mockRejectedValueOnce(new Error("Lost comparison acknowledgement"));
  h.ports.comparisonAction.mockRejectedValueOnce(new Error("Original action temporarily unavailable"));
  await act(async () => h.owner.create({ unitId: h.target.unitId, locale: h.target.locale, revisionIds: h.revisions.map(row => row.revisionId), blind: true }, () => true));
  const original = copy(h.ports.compare.mock.calls[0][0]);
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true); expect(h.owner.current().retryAllowed).toBe(false);
  expect(h.owner.lifecycleParticipant().inspect({ kind: "close-project" }).status).toBe("blocked");
  expect(h.drafts.lifecycleParticipant().inspect({ kind: "close-view" }).status).toBe("ready");
  act(() => h.gate.setVisibleOwner(null)); h.show({ viewId: null }, true);
  const check = await screen.findByRole("button", { name: w("candidateCheck") }); await waitFor(() => expect(check).toBeEnabled());
  expect(screen.queryByRole("button", { name: w("candidateRetry") })).not.toBeInTheDocument();
  fireEvent.click(check); const retry = await screen.findByRole("button", { name: w("candidateRetry") }); await waitFor(() => expect(retry).toBeEnabled());
  expect(screen.getByText(w("comparisonMissing"))).toBeInTheDocument(); fireEvent.click(retry);
  await waitFor(() => expect(h.ports.compare).toHaveBeenCalledTimes(2)); expect(h.ports.compare.mock.calls[1][0]).toEqual(original);
  expect(h.ports.identity).toHaveBeenCalledTimes(1);
});
