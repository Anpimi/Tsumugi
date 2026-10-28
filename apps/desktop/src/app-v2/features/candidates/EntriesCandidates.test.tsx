import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../../../../test/fixtures/translation-commands.json";
import { translationMemoryEntryFixture, translationMemoryReuseFixture } from "../../../testSupport/translationMemoryFixture";
import { Button } from "../../../design-system/Button";
import { i18n } from "../../../i18n";
import type { workbenchEn } from "../../../i18n/workbench";
import type { DraftBasis, DraftHead, DraftKey, DraftValue } from "../../../draftCommands";
import { executionContext } from "../../../executionCommands";
import type { AiCandidateEffectView } from "../../../generated/ai.responses";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands, type TmSuggestion } from "../../../resourceCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { translationCommands, type TranslationHistory, type TranslationRevision, type CandidateDecisionRequest, type CandidateDecision } from "../../../translationCommands";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { WorkbenchCommands } from "../../../workbenchCommands";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { InteractionGate } from "../../workspace/interactionGate";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import CandidateOwnerHost from "./CandidateOwnerHost";
import type { CandidateOwners } from "./candidateTypes";
import EntriesCandidates from "./EntriesCandidates";
import InlineCandidate from "./InlineCandidate";
import CandidateRecovery from "./CandidateRecovery";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "candidate-ui-session", locator: "/synthetic/candidates", reconciliationState: "settled",
  metadata: { projectId: fixture.save.projectId, displayName: "Synthetic candidates", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const context = executionContext(project), scope = { ...context, area: "translation" as const };
const target = reviewTargetFixture({ unitId: fixture.save.unitId, locale: fixture.save.locale, sourceRevisionId: fixture.save.sourceRevisionId,
  sourceSnapshotId: fixture.receipt.revision.sourceSnapshotId, selectionId: null, revisionId: null, translationText: null });
const key: DraftKey = { projectId: context.projectId, unitId: target.unitId, locale: target.locale };
const basis: DraftBasis = { sourceRevisionId: target.sourceRevisionId, selectionId: null, revisionId: null, text: null };
const candidate: TranslationRevision = { ...fixture.receipt.revision, unitId: target.unitId, locale: target.locale,
  sourceRevisionId: target.sourceRevisionId, sourceSnapshotId: target.sourceSnapshotId, originKind: "ai", text: "AI {name}\né 👩🏽‍💻", candidateDecision: null };
const memory: TmSuggestion = { unitId: fixtureIdentity(700), sourceRevisionId: fixtureIdentity(701), translationRevisionId: fixtureIdentity(702),
  sourceText: "Memory source", translationText: "Memory translation", targetLocale: target.locale, originKind: "manual", hasHumanApproval: true, isCurrentSelection: true, matchKind: "exact", scorePercent: 100 };
const baseHistory: TranslationHistory = { unitId: target.unitId, locale: target.locale, current: null, currentText: null, rows: [candidate], total: "1", nextOrdinal: null };
type WorkbenchTextKey = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
const w = (key: WorkbenchTextKey) => i18n.t(`workbenchV2.${key}`);
const resources: { reads: SessionReads; drafts: TranslationDrafts; lifecycle: ProjectLifecycle }[] = [];
const copy = <T,>(value: T): T => structuredClone(value);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function decisionReceipt(request: CandidateDecisionRequest): CandidateDecision {
  return { request: { ...request.decision, expectedDecisionId: request.decision.expectedDecisionId ?? null, expectedSelectionId: request.decision.expectedSelectionId ?? null }, sourceSnapshotId: target.sourceSnapshotId };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset();
  vi.spyOn(translationCommands, "history").mockImplementation(async request => ({ ...copy(baseHistory), rows: request.afterOrdinal === "0" ? [copy(candidate)] : [] }));
  vi.spyOn(resourceCommands, "suggestions").mockResolvedValue([copy(memory)]);
  invoke.mockImplementation(async (command, payload) => {
    if (command === "create_execution_identity") return fixtureIdentity(750);
    if (command === "decide_translation_candidate") return decisionReceipt(payload.request);
    if (command === "read_translation_candidate_action") return null;
    throw new Error(String(command));
  });
});
afterEach(() => { cleanup(); resources.splice(0).forEach(value => { value.reads.retire(); value.drafts.retire(); value.lifecycle.dispose(); }); vi.restoreAllMocks(); });

async function harness(options: { inline?: boolean; page?: string } = {}) {
  const reads = new SessionReads(context), gate = new InteractionGate(), commands = new WorkbenchCommands(); gate.setVisibleOwner("entries");
  let disk: DraftHead = { key, revision: "0", writerId: null, value: null };
  const ports = {
    list: async () => ({ items: [], next: null }),
    read: vi.fn<TranslationDraftPorts["read"]>(async () => ({ head: copy(disk), current: { kind: "current", basis: copy(basis), sourceText: target.sourceText, nativeKey: target.nativeKey } })),
    write: vi.fn<TranslationDraftPorts["write"]>(async request => { disk = { key, revision: (BigInt(disk.revision) + 1n).toString(), writerId: request.write.writerId, value: copy(request.write.value) as DraftValue }; return copy(disk); }),
    history: vi.fn<TranslationDraftPorts["history"]>(async () => copy(baseHistory)),
    suggestions: vi.fn<TranslationDraftPorts["suggestions"]>(async () => [copy(memory)]),
    memoryEntry: vi.fn<TranslationDraftPorts["memoryEntry"]>(async () => translationMemoryEntryFixture(memory)),
    prepareMemoryReuse: vi.fn<TranslationDraftPorts["prepareMemoryReuse"]>(async () => translationMemoryReuseFixture(target, translationMemoryEntryFixture(memory))),
    save: vi.fn<TranslationDraftPorts["save"]>(), select: vi.fn<TranslationDraftPorts["select"]>(), writerId: () => fixtureIdentity(751),
  };
  const drafts = new TranslationDrafts({ context, reads, ports }), lifecycle = new ProjectLifecycle(); resources.push({ reads, drafts, lifecycle });
  await drafts.initialize();
  const onEdit = vi.fn(async () => true), onInspect = vi.fn(), onPage = vi.fn();
  let owners: CandidateOwners | null = null;
  function Content({ visible = true, recovery = false, inline = options.inline ?? false, disabled = false }: { visible?: boolean; recovery?: boolean; inline?: boolean; disabled?: boolean }) {
    const [value, retain] = useState<CandidateOwners | null>(null); owners = value;
    return <><CandidateOwnerHost project={project} drafts={drafts} lifecycle={lifecycle} onOwners={retain} onReveal={() => undefined} />{value ? <>
      {recovery ? <CandidateRecovery project={project} owners={value} commands={commands} gate={gate} viewId={null} disabled={false} visible={visible} /> : <>
        <EntriesCandidates project={project} target={target} drafts={drafts} owners={value} commands={commands} gate={gate} viewId="entries" disabled={disabled} visible={visible} mode="candidates" afterOrdinal={options.page ?? "0"} onPage={onPage} onEdit={onEdit} />
        {inline ? <InlineCandidate project={project} target={target} drafts={drafts} owners={value} commands={commands} gate={gate} viewId="entries" disabled={disabled} visible={visible} focused aiCandidateCount={1} onEdit={onEdit} onInspect={onInspect} /> : null}
      </>}
    </> : null}</>;
  }
  const ui = (args: Parameters<typeof Content>[0] = {}) => <SessionReadProvider context={context} reads={reads} bridge={false}><Content {...args} /></SessionReadProvider>;
  const rendered = render(ui());
  await waitFor(() => expect(owners).not.toBeNull());
  await waitFor(() => expect(drafts.getEntry(key)).toBeDefined());
  return { reads, gate, commands, drafts, ports, onEdit, onInspect, onPage, rendered, owners: () => { if (!owners) throw new Error("Missing candidate owner"); return owners; },
    show: (args: Parameters<typeof Content>[0]) => rendered.rerender(ui(args)) };
}

it("inspects an exact saved candidate on demand while another mutation is reserved, then returns keyboard focus without writing", async () => {
  const revision: TranslationRevision = { ...candidate, attemptId: fixtureIdentity(830), itemId: fixtureIdentity(831), resultId: fixtureIdentity(832) };
  vi.mocked(translationCommands.history).mockResolvedValue({ ...copy(baseHistory), rows: [revision] });
  const view: AiCandidateEffectView = { projectId: context.projectId, unitId: revision.unitId, locale: revision.locale,
    revisionId: revision.revisionId, sourceSnapshotId: revision.sourceSnapshotId, sourceRevisionId: revision.sourceRevisionId,
    attemptId: revision.attemptId!, itemId: revision.itemId!, resultId: revision.resultId!, taskId: fixtureIdentity(833),
    planId: null, planGeneration: null, currentResult: true, retained: false, effect: null };
  invoke.mockImplementation(async command => { if (command === "read_ai_candidate_effect") return copy(view); throw new Error(String(command)); });
  const h = await harness();
  await waitFor(() => expect(screen.getByRole("button", { name: w("candidateEffectOpen") })).toBeEnabled());
  expect(invoke).not.toHaveBeenCalled();
  let reservation: symbol | null = null;
  act(() => { reservation = h.drafts.reserveMutation("retained-for-navigation"); });
  expect(reservation).not.toBeNull();
  const trigger = screen.getByRole("button", { name: w("candidateEffectOpen") });
  fireEvent.click(trigger);
  const region = await screen.findByRole("region", { name: w("candidateEffectTitle") });
  await waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith("read_ai_candidate_effect", { request: {
    ...context, unitId: revision.unitId, locale: revision.locale, revisionId: revision.revisionId,
  } }));
  expect(region).toHaveFocus();
  await waitFor(() => expect(within(region).queryByText(w("candidateEffectLoading"))).not.toBeInTheDocument());
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  fireEvent.click(within(region).getByRole("button", { name: w("candidateEffectClose") }));
  await waitFor(() => expect(screen.queryByRole("region", { name: w("candidateEffectTitle") })).not.toBeInTheDocument());
  expect(trigger).toHaveFocus(); expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(h.ports.write).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledTimes(1);
  act(() => { if (reservation) h.drafts.releaseMutation(reservation); });
});

it("shares one bounded history read across focused inline and Inspector; stages durably before opening the editor without selecting or saving", async () => {
  const h = await harness({ inline: true });
  await waitFor(() => expect(h.commands.describe("translation.stage-focused-ai", scope)?.availability.enabled).toBe(true));
  expect(translationCommands.history).toHaveBeenCalledTimes(1);
  expect(translationCommands.history).toHaveBeenCalledWith({ ...context, unitId: target.unitId, locale: target.locale, afterOrdinal: "0", limit: 50 });
  expect(resourceCommands.suggestions).toHaveBeenCalledWith({ ...context, unitId: target.unitId, locale: target.locale, offset: 0, limit: 20 });
  act(() => h.gate.setInputOwner("entries", "segment-editor-other"));
  expect(h.commands.dispatch("translation.stage-focused-ai", scope)).toBe(false);
  act(() => { h.gate.setInputOwner("entries", "entry-list-entries"); h.gate.setComposing("physical-input", true); });
  expect(h.commands.dispatch("translation.stage-focused-ai", scope)).toBe(false);
  act(() => h.gate.setComposing("physical-input", false));
  const write = deferred<DraftHead>(), writeImplementation = h.ports.write.getMockImplementation()!;
  h.ports.write.mockImplementationOnce(() => write.promise);
  act(() => { expect(h.commands.dispatch("translation.stage-focused-ai", scope)).toBe(true); });
  await waitFor(() => expect(h.ports.write).toHaveBeenCalledTimes(1)); expect(h.onEdit).not.toHaveBeenCalled();
  await act(async () => { write.resolve(await writeImplementation(h.ports.write.mock.calls[0][0])); });
  await waitFor(() => expect(h.onEdit).toHaveBeenCalledWith(target.unitId, target.locale));
  expect(h.drafts.getEntry(key)?.value?.text).toBe(candidate.text); expect(h.drafts.getEntry(key)?.durableSeq).toBe("1");
  expect(h.ports.select).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled();
  h.show({ visible: false, inline: true }); expect(h.commands.describe("translation.stage-focused-ai", scope)).toBeUndefined();
});

it("preserves newer input arriving while candidate qualification is pending", async () => {
  const h = await harness(), delayed = deferred<TranslationHistory>();
  const adopt = await screen.findByRole("button", { name: w("candidateAdopt") }); await waitFor(() => expect(adopt).toBeEnabled());
  h.ports.history.mockImplementationOnce(() => delayed.promise);
  fireEvent.click(adopt); await waitFor(() => expect(h.ports.history).toHaveBeenCalledTimes(1));
  act(() => h.drafts.edit(key, "Newer human input B"));
  await act(async () => delayed.resolve(copy(baseHistory)));
  await waitFor(() => expect(screen.getByText(w("candidateStageBlocked"))).toBeInTheDocument());
  expect(h.drafts.getEntry(key)?.value?.text).toBe("Newer human input B"); expect(h.onEdit).not.toHaveBeenCalled();
});

it("shows real TM provenance and adopts its donor text through the same local draft boundary", async () => {
  const h = await harness();
  fireEvent.mouseDown(screen.getByRole("tab", { name: w("candidateTm") }), { button: 0, ctrlKey: false });
  const donor = await screen.findByText(memory.translationText), item = donor.closest("li"); if (!item) throw new Error("Missing TM suggestion");
  expect(within(item).getByText(i18n.t("resource.manual"))).toBeInTheDocument();
  fireEvent.click(within(item).getByRole("button", { name: w("candidateAdopt") }));
  await waitFor(() => expect(h.drafts.getEntry(key)?.value?.text).toBe(memory.translationText));
  expect(h.ports.suggestions).toHaveBeenCalledWith({ ...context, unitId: target.unitId, locale: target.locale, offset: 0, limit: 20 });
  expect(h.ports.select).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled();
  expect(h.drafts.getEntry(key)?.value?.reuseOrigin).toEqual(translationMemoryReuseFixture(target, translationMemoryEntryFixture(memory)).reuseOrigin);
});

it("distinguishes an earlier donor approval from current approval without granting either to the target", async () => {
  const quality = translationMemoryEntryFixture(memory).quality;
  vi.mocked(resourceCommands.suggestions).mockResolvedValue([{ ...memory, hasHumanApproval: false,
    quality: { ...quality, currentApproval: null } }]);
  await harness(); fireEvent.mouseDown(screen.getByRole("tab", { name: w("candidateTm") }), { button: 0, ctrlKey: false });
  const item = (await screen.findByText(memory.translationText)).closest("li"); if (!item) throw new Error("Missing TM suggestion");
  expect(within(item).getByText(i18n.t("knowledge.memoryPastApproval"))).toBeVisible();
  expect(within(item).queryByText(i18n.t("knowledge.memoryCurrentApproval"))).toBeNull();
  expect(within(item).getByText(i18n.t("knowledge.memoryApprovalHelp"))).toBeVisible();
});

it("requires real audit input, retains unknown requests with no tabs, and retries only the original decision after a missing-result check", async () => {
  let original: CandidateDecisionRequest | null = null;
  invoke.mockImplementation(async (command, payload) => {
    if (command === "create_execution_identity") return fixtureIdentity(760);
    if (command === "decide_translation_candidate") {
      original ??= copy(payload.request);
      if (invoke.mock.calls.filter(([name]) => name === command).length === 1) throw new Error("Lost acknowledgement");
      return decisionReceipt(payload.request);
    }
    if (command === "read_translation_candidate_action") return null;
    throw new Error(String(command));
  });
  const h = await harness();
  const reject = await screen.findByRole("button", { name: w("candidateReject") }); await waitFor(() => expect(reject).toBeEnabled()); fireEvent.click(reject);
  expect(screen.getByRole("button", { name: w("candidateRecord") })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: w("candidateActor") }), { target: { value: "Human reviewer" } });
  fireEvent.change(screen.getByRole("textbox", { name: w("candidateReason") }), { target: { value: "Missing context" } });
  fireEvent.click(screen.getByRole("button", { name: w("candidateRecord") }));
  await waitFor(() => expect(h.owners().decisions.current().checkedMissing).toBe(true));
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  act(() => h.gate.setVisibleOwner(null)); h.show({ recovery: true });
  await waitFor(() => expect(screen.getByRole("button", { name: w("candidateRetry") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: w("candidateRetry") }));
  await waitFor(() => expect(h.owners().decisions.current().pending).toBeNull());
  const writes = invoke.mock.calls.filter(([name]) => name === "decide_translation_candidate");
  expect(writes.map(([, payload]) => payload.request)).toEqual([original, original]);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  expect(h.ports.select).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled();
});

it("keeps older-source and rejected candidates readable and comparable while preventing draft adoption", async () => {
  const rejectedDecision = decisionReceipt({ ...context, decision: { projectId: context.projectId, actionId: fixtureIdentity(780), unitId: target.unitId,
    locale: target.locale, revisionId: candidate.revisionId, sourceRevisionId: target.sourceRevisionId, expectedSelectionId: null,
    expectedDecisionId: null, disposition: "rejected", actor: "Reviewer", reason: "Out of context" } });
  const old = { ...copy(candidate), revisionId: fixtureIdentity(781), sourceRevisionId: fixtureIdentity(782), text: "", originKind: "manual" as const };
  vi.mocked(translationCommands.history).mockResolvedValue({ ...copy(baseHistory), rows: [old, { ...copy(candidate), candidateDecision: rejectedDecision }], total: "2" });
  await harness();
  const older = await screen.findByText(w("candidateOldSource")), olderRow = older.closest("li"); if (!olderRow) throw new Error("Missing older source candidate");
  expect(within(olderRow).getByRole("button", { name: w("candidateAdopt") })).toBeDisabled();
  expect(screen.getByText(w("candidateRejected"))).toBeInTheDocument();
  const compared = within(olderRow).getByRole("button", { name: w("candidateCompare") }); await waitFor(() => expect(compared).toBeEnabled()); fireEvent.click(compared);
  const comparison = screen.getByRole("region", { name: w("candidateComparison") });
  expect(within(comparison).getByText(w("editorNoSelection"))).toBeInTheDocument();
  expect(within(comparison).getByText(w("editorEmptySelection"))).toBeInTheDocument();
});

it("retries an unknown original protection change from the no-tab banner while its mutation slot remains reserved", async () => {
  invoke.mockImplementation(async command => {
    if (command === "create_execution_identity") return fixtureIdentity(790);
    if (command === "set_work_protection") throw new Error("Lost protection acknowledgement");
    throw new Error(String(command));
  });
  const h = await harness();
  await act(async () => {
    await expect(h.owners().protection.change({ request: { ...context, unitId: target.unitId, locale: target.locale,
      sourceRevisionId: target.sourceRevisionId, selectionId: null, expectedRevision: "0" }, key: target.nativeKey, sourceText: target.sourceText, selectionText: null }, true, () => true)).rejects.toThrow("Lost protection acknowledgement");
  });
  const original = h.owners().protection.current().pending?.request; expect(original).toBeDefined();
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  act(() => h.gate.setVisibleOwner(null)); h.show({ recovery: true });
  const retry = await screen.findByRole("button", { name: w("candidateProtectionRetry") }); await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "set_work_protection")).toHaveLength(2));
  expect(invoke.mock.calls.filter(([name]) => name === "set_work_protection").map(([, payload]) => payload.request)).toEqual([original, original]);
  expect(h.owners().protection.current().pending?.phase).toBe("unknown");
});

it("discards only retained audit details through their existing owner when no current entry is mounted", async () => {
  const h = await harness();
  act(() => { h.owners().decisions.edit("actor", "Person"); h.owners().decisions.edit("reason", "Unfinished decision"); h.gate.setVisibleOwner(null); });
  h.show({ recovery: true });
  const discard = await screen.findByRole("button", { name: w("candidateDiscard") }); await waitFor(() => expect(discard).toBeEnabled());
  act(() => h.gate.setComposing("audit-input", true)); expect(discard).toBeDisabled();
  act(() => h.gate.setComposing("audit-input", false)); fireEvent.click(discard);
  expect(h.owners().decisions.current()).toMatchObject({ actor: "", reason: "" });
  expect(h.drafts.getEntry(key)?.value?.text).toBe(""); expect(h.ports.write).not.toHaveBeenCalled();
});

it("keeps an explicit Inspector entry when the bounded first history page has no eligible AI candidate", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ ...copy(candidate), revisionId: fixtureIdentity(800 + index), ordinal: String(index + 1), originKind: "manual" as const, text: `Saved translation ${index}` }));
  vi.mocked(translationCommands.history).mockResolvedValue({ ...copy(baseHistory), rows, total: "51", nextOrdinal: "50" });
  const h = await harness({ inline: true });
  await screen.findByText(w("candidateMore"));
  const open = screen.getByRole("button", { name: w("candidateTitle") }); expect(open).toBeEnabled();
  fireEvent.click(open); expect(h.onInspect).toHaveBeenCalledExactlyOnceWith(null);
  h.show({ inline: true, disabled: true }); expect(screen.getByText(w("candidateMore"))).toBeInTheDocument();
  expect(screen.getByRole("button", { name: w("candidateTitle") })).toBeDisabled();
});

it("focuses the opened comparison, restores its exact Compare button, and never steals focus after the visible view changes", async () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView"), scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  try {
    const h = await harness();
    const compare = await screen.findByRole("button", { name: w("candidateCompare") }); await waitFor(() => expect(compare).toBeEnabled());
    compare.focus(); expect(compare).toHaveFocus(); fireEvent.click(compare);
    const region = screen.getByRole("region", { name: w("candidateComparison") });
    expect(region).toHaveAttribute("tabindex", "-1"); expect(region).toHaveFocus();
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
    fireEvent.click(within(region).getByRole("button", { name: w("candidateCloseCompare") }));
    expect(screen.queryByRole("region", { name: w("candidateComparison") })).not.toBeInTheDocument();
    expect(compare).toHaveFocus();
    const other = render(<Button>Other view destination</Button>).getByRole("button", { name: "Other view destination" });
    act(() => { fireEvent.click(compare); h.gate.setVisibleOwner("other-view"); other.focus(); });
    expect(other).toHaveFocus(); expect(scroll).toHaveBeenCalledTimes(1);
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});
