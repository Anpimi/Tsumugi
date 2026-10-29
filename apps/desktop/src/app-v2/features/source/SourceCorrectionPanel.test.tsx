import { useLayoutEffect, useState } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SourceCorrectionPanel from "./SourceCorrectionPanel";
import { useSourceDraftSession, type SourceSession } from "../../../SourceDraftSession";
import { translationCommands, type TranslationHistory } from "../../../translationCommands";
import { executionContext } from "../../../executionCommands";
import { i18n } from "../../../i18n";
import type { ProjectView } from "../../../projectCommands";
import type { SourceLineageCorrectionBasis, SourceLineageCorrectionReceipt, SourceLineageCorrectionRequest, SourceLineageSavedWork } from "../../../sourceCommands";
import { renderWorkbench } from "../../../testSupport/WorkbenchTestShell";
import { sourceRowFixture } from "../../../testSupport/sourceFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import wire from "../../../../test/fixtures/sourceCommands.contract.json";
import translations from "../../../../test/fixtures/translation-commands.json";

const invoke = vi.hoisted(() => vi.fn()); vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { ...wire.session, locator: "/synthetic/source-correction-panel", reconciliationState: "settled",
  metadata: { projectId: wire.session.projectId, displayName: "Source corrections", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const snapshotId = id(1050), previousSnapshotId = id(1051), unitB = id(1052), unitA = id(1053), occurrenceA = id(1054);
const row = sourceRowFixture({ unitId: unitB, occurrenceId: id(1055), sourceRevisionId: id(1056) }, { ordinal: 7, key: "dialogue.adopted", text: "Adopted {{name}} 世界" });
const candidate = sourceRowFixture({ unitId: unitA, occurrenceId: occurrenceA, sourceRevisionId: id(1057) }, { ordinal: 3, key: "dialogue.earlier", text: "Earlier {{name}} 世界" });
function savedWork(unitId: string): SourceLineageSavedWork {
  return { unitId, locale: "zh-CN", selectionId: unitId === unitB ? id(1058) : null, translationRevisionId: unitId === unitB ? id(1059) : null,
    translationRevisionIds: [unitId === unitB ? id(1059) : id(1060)], reviewActionIds: [], checkActionIds: [], protectionRevision: null, protected: false, basis: "synthetic-saved-work" };
}
const basis: SourceLineageCorrectionBasis = { projectId: project.metadata.projectId, previousSnapshotId, snapshotId, resultId: id(1061), resultDigest: "a".repeat(64),
  scope: { revision: "5", currentSnapshot: snapshotId }, mappingRevision: "1", ordinal: row.occurrence.ordinal,
  originChain: [{ snapshotId, occurrenceId: row.occurrenceId!, mappingRevision: "1" }],
  bindings: [{ occurrenceId: row.occurrenceId!, unitId: unitB, sourceRevisionId: row.sourceRevisionId!, predecessorId: null, relation: "new" },
    { occurrenceId: id(1062), unitId: unitB, sourceRevisionId: row.sourceRevisionId!, predecessorId: null, relation: "new" }],
  candidates: [{ oldSnapshotId: previousSnapshotId, old: candidate, actionId: id(1063), actor: "Earlier reviewer", reason: "Earlier reason", decision: "unresolved", appliedRelation: null, policy: "synthetic-policy", relationship: "candidate" }],
  savedWork: [savedWork(unitB), savedWork(unitA)] };
const request: SourceLineageCorrectionRequest = { ...executionContext(project), correction: { projectId: project.metadata.projectId, actionId: id(1064), basis,
  oldOccurrenceId: occurrenceA, decision: "continue", actor: "Reviewer A", reason: "Submitted reason A" } };
const receipt: SourceLineageCorrectionReceipt = { request: request.correction, mappingRevision: "2", previousBindings: basis.bindings,
  currentBindings: basis.bindings.map(binding => ({ ...binding, unitId: unitA, predecessorId: occurrenceA, relation: "continue" })), preservedWork: basis.savedWork };
type Frame = Pick<SourceSession["state"], "correctionDraft" | "correctionBasis" | "correctionReceipt" | "pendingCorrection" | "correctionLoading" | "correctionFailure">;
function frame(): Frame {
  return { correctionDraft: { snapshotId, ordinal: row.occurrence.ordinal, oldOccurrenceId: occurrenceA, decision: "continue", actor: "Reviewer A", reason: "Submitted reason A" },
    correctionBasis: basis, correctionReceipt: null, pendingCorrection: null, correctionLoading: false, correctionFailure: null };
}
const opened = vi.fn(), edited = vi.fn(), applied = vi.fn(), checked = vi.fn(), retried = vi.fn(), canceled = vi.fn(), discarded = vi.fn(), refreshed = vi.fn(), closed = vi.fn(), revealed = vi.fn();
let patchFrame: (patch: Partial<Frame>) => void;
function Harness({ initial = frame(), retryAllowed = false, dispatchAllowed = true }: { initial?: Frame; retryAllowed?: boolean; dispatchAllowed?: boolean }) {
  const retained = useSourceDraftSession(), [value, setValue] = useState(initial);
  const state = { ...retained.state, ...value };
  const owner: SourceSession = { ...retained, state, current: () => state,
    journal: { ...retained.journal, hydration: "ready", retired: false }, inFlight: () => false, hasPending: () => value.pendingCorrection !== null,
    openCorrection: async (snapshotId, ordinal) => { opened(snapshotId, ordinal); },
    editCorrection: patch => { edited(patch); setValue(before => ({ ...before, correctionDraft: before.correctionDraft ? { ...before.correctionDraft, ...patch } : null })); },
    applyCorrection: async () => { applied(); }, checkCorrection: async () => { checked(); },
    canRetryCorrection: () => retryAllowed, retryCorrection: async () => { retried(); },
    cancelCorrection: async () => { canceled(); },
    discardCorrection: async expected => { discarded(expected); return true; },
    refreshCorrection: async () => { refreshed(); }, closeCorrection: async () => { closed(); return true; } };
  useLayoutEffect(() => { patchFrame = patch => setValue(before => ({ ...before, ...patch })); });
  return <SourceCorrectionPanel project={project} owner={owner} snapshotId={snapshotId} row={row} visible current={() => dispatchAllowed} onRevealCorrection={revealed}/>;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset();
  invoke.mockImplementation(async command => { throw new Error(`Unexpected correction command: ${command}`); });
  for (const mock of [opened, edited, applied, checked, retried, canceled, discarded, refreshed, closed, revealed]) mock.mockReset();
  vi.spyOn(translationCommands, "history").mockImplementation(async query => {
    const text = query.unitId === unitB ? "Original selected B {{name}}" : "Earlier saved A {{name}}";
    const original = query.unitId === unitB, work = savedWork(query.unitId);
    const revision = { ...translations.receipt.revision, revisionId: work.translationRevisionIds[0], unitId: query.unitId, locale: query.locale,
      sourceSnapshotId: original ? snapshotId : previousSnapshotId, sourceRevisionId: original ? row.sourceRevisionId! : candidate.sourceRevisionId!, originKind: "manual" as const, text };
    const result: TranslationHistory = { unitId: query.unitId, locale: query.locale,
      current: original ? { ...translations.receipt.selection, eventId: work.selectionId!, revisionId: revision.revisionId, unitId: unitB, locale: query.locale } : null,
      currentText: query.unitId === unitB ? text : null, total: "1", rows: [revision], nextOrdinal: null };
    return result;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["en-US", "zh-CN"] as const)("requires explicit %s review, keeps decisions distinct and preserves user input during a language change", async language => {
  await i18n.changeLanguage(language); renderWorkbench(<Harness/>, project); const user = userEvent.setup();
  expect(opened).not.toHaveBeenCalled(); expect(checked).not.toHaveBeenCalled(); expect(applied).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionResume") }));
  expect(opened).toHaveBeenCalledExactlyOnceWith(snapshotId, row.occurrence.ordinal);
  const consequences = language === "en-US" ? [
    "This changes only the entry match. Imported files and source text are not edited.",
    "Translations, selections, reviews, checks and protected work stay with their existing entries. No translation or approval is transferred.",
    "To use a saved translation, choose it separately in the entry editor and reassess it against the current source. This correction does not select or approve it.",
  ] : [
    "这只会更正条目对应，不会修改导入的原文件或源文。",
    "译文、选择、审阅、检查和受保护的工作仍留在原来的条目上，不会转移译文或批准。",
    "若要使用已保存译文，请在条目编辑器中另行选择，并按当前源文重新核对适用性。这次更正不会选择或批准译文。",
  ];
  for (const consequence of consequences) expect(screen.getByText(consequence)).toBeVisible();
  expect(screen.getByText(i18n.t("sourceMaintenance.correctionGroup", { count: 2 }))).toBeVisible();
  const actor = screen.getByRole("textbox", { name: i18n.t("sourceMaintenance.actor") });
  fireEvent.change(actor, { target: { value: " Reviewer B 人工 " } });
  expect(actor).toHaveValue(" Reviewer B 人工 "); expect(actor).toHaveAttribute("aria-invalid", "true");
  fireEvent.change(actor, { target: { value: "Reviewer B 人工" } }); expect(actor).not.toHaveAttribute("aria-invalid");
  const decision = screen.getByRole("combobox", { name: i18n.t("sourceMaintenance.correctionDecision") });
  expect(within(decision).getAllByRole("option").map(option => option.getAttribute("value"))).toEqual(["continue", "reject", "unresolved"]);
  await user.selectOptions(decision, "reject"); expect(edited).toHaveBeenLastCalledWith({ decision: "reject" });
  await user.selectOptions(decision, "unresolved"); expect(edited).toHaveBeenLastCalledWith({ decision: "unresolved" });
  const reason = screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("sourceMaintenance.correctionReason") });
  fireEvent.change(reason, { target: { value: "Newer B 👩🏽‍💻\n人工理由" } });
  act(() => { reason.focus(); reason.setSelectionRange(2, 7, "backward"); });
  await act(async () => { await i18n.changeLanguage(language === "en-US" ? "zh-CN" : "en-US"); });
  expect(screen.getByRole("textbox", { name: i18n.t("sourceMaintenance.correctionReason") })).toBe(reason);
  expect(reason).toHaveValue("Newer B 👩🏽‍💻\n人工理由"); expect(reason).toHaveFocus(); expect(reason.selectionStart).toBe(2); expect(reason.selectionEnd).toBe(7);
  const submit = screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionApply") });
  expect(submit).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: i18n.t("sourceMaintenance.correctionConfirm") }));
  expect(submit).toBeEnabled();
  act(() => patchFrame({ correctionBasis: { ...basis, mappingRevision: "2", originChain: [{ snapshotId, occurrenceId: row.occurrenceId!, mappingRevision: "2" }] } }));
  expect(submit).toBeDisabled(); expect(screen.getByRole("checkbox", { name: i18n.t("sourceMaintenance.correctionConfirm") })).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: i18n.t("sourceMaintenance.correctionConfirm") }));
  await user.click(submit); expect(applied).toHaveBeenCalledOnce();
  expect(screen.getByRole("checkbox", { name: i18n.t("sourceMaintenance.correctionConfirm") })).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionDiscard") }));
  expect(screen.getByText(i18n.language === "en-US"
    ? "Only this entry correction draft will be discarded. Saved sources, translations and other import drafts are kept."
    : "只放弃这份对应更正草稿，已保存源内容、译文和其他导入草稿仍保留。")).toBeVisible();
  const discardConfirm = screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionDiscardConfirm") });
  expect(discardConfirm).toBeEnabled(); expect(discarded).not.toHaveBeenCalled();
  fireEvent.change(reason, { target: { value: "Newer C 👩🏽‍💻\n仍需保留的理由" } });
  expect(discardConfirm).toBeDisabled(); fireEvent.click(discardConfirm); expect(discarded).not.toHaveBeenCalled();
  expect(reason).toHaveValue("Newer C 👩🏽‍💻\n仍需保留的理由");
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionKeepEditing") }));
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionDiscard") }));
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionDiscardConfirm") }));
  expect(discarded).toHaveBeenCalledExactlyOnceWith({ snapshotId, ordinal: row.occurrence.ordinal, oldOccurrenceId: occurrenceA,
    decision: "unresolved", actor: "Reviewer B 人工", reason: "Newer C 👩🏽‍💻\n仍需保留的理由" });
  expect(applied).toHaveBeenCalledOnce(); expect(checked).not.toHaveBeenCalled(); expect(canceled).not.toHaveBeenCalled();
});

it("keeps the same editable textarea and composition input when the dispatch gate closes", async () => {
  const view = renderWorkbench(<Harness/>, project), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionResume") }));
  const reason = screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("sourceMaintenance.correctionReason") });
  fireEvent.change(reason, { target: { value: "Newer B 👩🏽‍💻\n人工理由" } });
  await user.click(screen.getByRole("checkbox", { name: i18n.t("sourceMaintenance.correctionConfirm") }));
  const submit = screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionApply") });
  expect(submit).toBeEnabled();
  act(() => { reason.focus(); reason.setSelectionRange(2, 7, "backward"); });
  fireEvent.compositionStart(reason);
  view.rerender(<Harness dispatchAllowed={false}/>, project);
  expect(screen.getByRole("textbox", { name: i18n.t("sourceMaintenance.correctionReason") })).toBe(reason);
  expect(reason).not.toHaveAttribute("readonly"); expect(reason).toHaveValue("Newer B 👩🏽‍💻\n人工理由"); expect(reason).toHaveFocus();
  expect(reason.selectionStart).toBe(2); expect(reason.selectionEnd).toBe(7); expect(reason.selectionDirection).toBe("backward");
  expect(submit).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: i18n.t("sourceMaintenance.correctionConfirm") })).toBeDisabled();
  fireEvent.change(reason, { target: { value: "Newer B 👩🏽‍💻\n正在输入的理由" } });
  expect(edited).toHaveBeenLastCalledWith({ reason: "Newer B 👩🏽‍💻\n正在输入的理由" });
  act(() => { reason.setSelectionRange(4, 9, "forward"); });
  view.rerender(<Harness dispatchAllowed={false}/>, project);
  expect(reason).not.toHaveAttribute("readonly"); expect(reason).toHaveValue("Newer B 👩🏽‍💻\n正在输入的理由"); expect(reason).toHaveFocus();
  expect(reason.selectionStart).toBe(4); expect(reason.selectionEnd).toBe(9); expect(reason.selectionDirection).toBe("forward");
  fireEvent.click(submit); expect(applied).not.toHaveBeenCalled();
  fireEvent.compositionEnd(reason);
  view.rerender(<Harness/>, project);
  expect(screen.getByRole("textbox", { name: i18n.t("sourceMaintenance.correctionReason") })).toBe(reason);
  expect(reason).not.toHaveAttribute("readonly"); expect(reason).toHaveValue("Newer B 👩🏽‍💻\n正在输入的理由"); expect(reason).toHaveFocus();
  expect(reason.selectionStart).toBe(4); expect(reason.selectionEnd).toBe(9);
  await user.click(screen.getByRole("checkbox", { name: i18n.t("sourceMaintenance.correctionConfirm") }));
  expect(submit).toBeEnabled(); await user.click(submit); expect(applied).toHaveBeenCalledOnce();
});

it.each(["en-US", "zh-CN"] as const)("keeps both sides reachable and newer %s input editable while an original correction needs explicit reconciliation", async language => {
  await i18n.changeLanguage(language);
  const initial = frame(); initial.pendingCorrection = request;
  const select = vi.spyOn(translationCommands, "select"), save = vi.spyOn(translationCommands, "save");
  const view = renderWorkbench(<Harness initial={initial}/>, project); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionResume") }));
  expect(checked).not.toHaveBeenCalled(); expect(applied).not.toHaveBeenCalled(); expect(canceled).not.toHaveBeenCalled();
  const reason = screen.getByRole("textbox", { name: i18n.t("sourceMaintenance.correctionReason") });
  expect(reason).not.toHaveAttribute("readonly"); fireEvent.change(reason, { target: { value: "Newer B 👩🏽‍💻\n人工理由" } });
  await user.click(screen.getByText(i18n.t("sourceMaintenance.correctionSubmitted")));
  expect(screen.getByText(i18n.t("sourceMaintenance.correctionSubmittedReason", { reason: "Submitted reason A" }))).toBeVisible();
  expect(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionApply") })).toBeDisabled();
  expect(screen.queryByRole("button", { name: i18n.t("sourceMaintenance.correctionRetry") })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("sourceMaintenance.correctionDiscard") })).not.toBeInTheDocument();
  const kept = screen.getByRole("region", { name: i18n.t("sourceMaintenance.correctionSavedWork") });
  await user.click(within(kept).getByText(i18n.t("sourceMaintenance.correctionCurrentWork", { locale: "zh-CN" })));
  await user.click(within(kept).getByText(i18n.t("sourceMaintenance.correctionCandidateWork", { entry: "dialogue.earlier", locale: "zh-CN" })));
  await waitFor(() => expect(kept).toHaveTextContent("Original selected B {{name}}"));
  await waitFor(() => expect(kept).toHaveTextContent("Earlier saved A {{name}}"));
  expect(translationCommands.history).toHaveBeenCalledWith({ ...executionContext(project), unitId: unitB, locale: "zh-CN", afterOrdinal: "0", limit: 20 });
  expect(translationCommands.history).toHaveBeenCalledWith({ ...executionContext(project), unitId: unitA, locale: "zh-CN", afterOrdinal: "0", limit: 20 });
  expect(screen.getByText(language === "en-US"
    ? "If the correction is already recorded, its actual result is kept. Otherwise, this request is closed. Your newer input is kept."
    : "如果已经记录，会保留实际结果；尚未记录时关闭这次请求。你新填的内容仍保留。")).toBeVisible();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionCancel") })); expect(canceled).toHaveBeenCalledOnce();
  expect(reason).toHaveValue("Newer B 👩🏽‍💻\n人工理由"); expect(applied).not.toHaveBeenCalled(); expect(checked).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionCheck") })); expect(checked).toHaveBeenCalledOnce();
  view.rerender(<Harness initial={initial} retryAllowed/>, project);
  expect(retried).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionRetry") })); expect(retried).toHaveBeenCalledOnce();
  expect(reason).toHaveValue("Newer B 👩🏽‍💻\n人工理由"); expect(applied).not.toHaveBeenCalled();
  act(() => patchFrame({ pendingCorrection: null, correctionReceipt: receipt, correctionBasis: null }));
  expect(screen.getByText(language === "en-US"
    ? "The earlier correction was recorded. Your newer changes are still here and have not been submitted. Read the match again before submitting them."
    : "此前的更正已记录，较新的修改仍在这里，还没有提交。请重新读取对应后再提交。")).toBeVisible();
  expect(reason).toHaveValue("Newer B 👩🏽‍💻\n人工理由");
  expect(screen.getByText(/Earlier saved A/)).toBeVisible();
  for (const node of screen.getAllByText(/Original selected B/)) expect(node).toBeVisible();
  expect(select).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionClose") })); expect(closed).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionResume") }));
  expect(screen.getByRole("textbox", { name: i18n.t("sourceMaintenance.correctionReason") })).toHaveValue("Newer B 👩🏽‍💻\n人工理由");
  expect(checked).toHaveBeenCalledOnce(); expect(applied).not.toHaveBeenCalled();
});

it("reveals a different kept correction without replacing it", async () => {
  const initial = frame(); initial.correctionDraft = { ...initial.correctionDraft!, snapshotId: previousSnapshotId, ordinal: 3 };
  renderWorkbench(<Harness initial={initial}/>, project); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionOpen") }));
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.correctionReveal") }));
  expect(revealed).toHaveBeenCalledExactlyOnceWith(previousSnapshotId, 3); expect(edited).not.toHaveBeenCalled(); expect(applied).not.toHaveBeenCalled();
});
