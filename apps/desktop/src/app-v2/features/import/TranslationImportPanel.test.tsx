import { useLayoutEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import type { workbenchEn } from "../../../i18n/workbench";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { TranslationImportProvider, useTranslationImportSession } from "../../../TranslationImportSession";
import { ExecutionTaskProvider, useExecutionTaskSession } from "../../../ExecutionTaskSession";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { translationCommands, type TranslationAdoptRequest, type TranslationDecision, type TranslationPreview, type TranslationPreviewRow } from "../../../translationCommands";
import { validateRequestAdopt } from "../../../generated/translation.validators";
import { WorkbenchCommands, type TranslationImportRowCommandPayload } from "../../../workbenchCommands";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { translationActionFixture, translationAttemptFixture, translationPreviewFixture, translationReceiptFixture,
  translationRecoveryUnit, translationRowFixture } from "../../../testSupport/translationFixture";
import { TranslationDrafts } from "../editor/translationDrafts";
import { InteractionGate } from "../../workspace/interactionGate";
import TranslationImportPanel from "./TranslationImportPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./ImportPreparation", () => ({ default: () => null }));
const project: ProjectView = { locator: "/synthetic/import-panel", sessionToken: "import-panel-session", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(900), displayName: "Synthetic import panel", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN", "ja"] } };
const context = executionContext(project), commandScope = { ...context, area: "translation" as const };
const resources: { reads: SessionReads; drafts: TranslationDrafts }[] = [];
let owner: ReturnType<typeof useTranslationImportSession>;
let preview: TranslationPreview, pageSize: number, identities: number;
let requests: Map<string, TranslationAdoptRequest>;
let conflictItem: string | null, unknownItem: string | null;
let lookup: "recorded" | "absent" | "unavailable";
type WorkbenchTextKey = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
const w = (key: WorkbenchTextKey) => i18n.t(`workbenchV2.${key}`);
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
const click = (key: WorkbenchTextKey) => fireEvent.click(screen.getByRole("button", { name: w(key) }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function rowFor(request: TranslationAdoptRequest) {
  const row = preview.rows.find(value => value.itemId === request.itemId);
  if (!row) throw new Error("Synthetic request has no matching imported row");
  return row;
}
function action(request: TranslationAdoptRequest) { return translationActionFixture(request, translationRecoveryUnit(rowFor(request))); }
function receipt(request: TranslationAdoptRequest) { return translationReceiptFixture(request, translationRecoveryUnit(rowFor(request)), rowFor(request).currentSelection?.sequence ?? null); }
function selectedRow(ordinal: number) {
  const row = translationRowFixture(ordinal);
  return { ...row, status: "selected-conflict" as const, currentText: "Existing selected translation",
    currentSelection: { eventId: fixtureIdentity(600), unitId: row.unitId ?? fixtureIdentity(3000 + ordinal), locale: "zh-CN", sequence: "7",
      revisionId: fixtureIdentity(601), actionId: fixtureIdentity(602), previousEventId: fixtureIdentity(603) } };
}
function rowPayload(page: TranslationPreview, row: TranslationPreviewRow, decision: TranslationDecision): TranslationImportRowCommandPayload {
  if (!row.unitId || !row.occurrenceId || !row.sourceRevisionId) throw new Error("Synthetic row has no source identity");
  return { kind: "translation-import-row", editSeq: owner.current().editSeq, attemptId: page.attemptId, bundleId: page.bundleId, basis: page.basis,
    locale: page.targetLocale, fixedSourceSnapshotId: page.fixedSourceSnapshotId, currentSourceSnapshotId: page.currentSourceSnapshotId,
    fileDigest: page.fileDigest, previewResultDigest: page.resultDigest, ordinal: row.entry.ordinal, itemId: row.itemId, resultId: row.resultId,
    resultDigest: row.resultDigest, unitId: row.unitId, occurrenceId: row.occurrenceId, sourceRevisionId: row.sourceRevisionId,
    expectedSelectionId: row.currentSelection?.eventId ?? null, decision };
}
function ImportOwner({ children, current, drafts }: { children: ReactNode; current: ProjectView; drafts: TranslationDrafts }) {
  const tasks = useExecutionTaskSession();
  return <TranslationImportProvider project={current} tasks={tasks} mutations={drafts}>{children}</TranslationImportProvider>;
}
function Probe({ current, drafts, commands, gate, visible, disabled }: {
  current: ProjectView; drafts: TranslationDrafts; commands: WorkbenchCommands; gate: InteractionGate; visible: boolean; disabled: boolean;
}) {
  const imports = useTranslationImportSession(), tasks = useExecutionTaskSession();
  useLayoutEffect(() => { owner = imports; });
  return <TranslationImportPanel project={current} owners={{ imports, tasks, observation: { loading: false, failure: null, retry: () => undefined } }}
    drafts={drafts} commands={commands} gate={gate} viewId="entries" visible={visible} disabled={disabled} onBack={() => undefined} onOpenEntry={() => undefined} />;
}
async function harness() {
  const reads = new SessionReads(context), drafts = new TranslationDrafts({ context, reads, ports: { writerId: () => "import-panel-writer", list: async () => ({ items: [], next: null }) } });
  resources.push({ reads, drafts }); expect(await drafts.initialize()).toBe(true);
  const commands = new WorkbenchCommands(), gate = new InteractionGate(); gate.setVisibleOwner("entries");
  const ui = ({ current = project, visible = true, disabled = false }: { current?: ProjectView; visible?: boolean; disabled?: boolean } = {}) =>
    <SessionReadProvider context={context} reads={reads} bridge={false}><ExecutionTaskProvider project={current} mutations={drafts}>
      <ImportOwner current={current} drafts={drafts}><Probe current={current} drafts={drafts} commands={commands} gate={gate} visible={visible} disabled={disabled} /></ImportOwner>
    </ExecutionTaskProvider></SessionReadProvider>;
  const rendered = render(ui());
  act(() => { expect(owner.showAttempt(preview.attemptId)).toBe(true); });
  const page = await translationCommands.preview({ ...context, attemptId: preview.attemptId, after: 0, limit: 50, basis: null });
  act(() => owner.ready(page));
  return { reads, drafts, commands, gate, show: (options: Parameters<typeof ui>[0] = {}) => rendered.rerender(ui(options)) };
}
function chooseRow(index: number, key: "importCandidate" | "importSelect" | "importReplace") {
  const row = screen.getByRole("rowheader", { name: `key-${index}` }).closest("tr");
  if (!row) throw new Error("Synthetic preview row was not rendered");
  fireEvent.click(within(row).getByRole("button", { name: w(key) }));
}
function confirmRow(key: "importCandidate" | "importSelect" | "importReplace") {
  fireEvent.click(within(screen.getByRole("region", { name: w("importConfirmRow") })).getByRole("button", { name: w(key) }));
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); preview = translationPreviewFixture(); pageSize = 100; identities = 100; requests = new Map();
  conflictItem = null; unknownItem = null; lookup = "recorded"; invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const request = args.request;
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: preview.currentSourceSnapshotId };
    if (command === "create_execution_identity") return fixtureIdentity(identities++);
    if (command === "read_translation_preview") {
      const after = Number(request.after), rows = preview.rows.filter(row => row.entry.ordinal >= after).slice(0, Math.min(pageSize, Number(request.limit)));
      const last = rows.at(-1)?.entry.ordinal;
      return { ...preview, rows, nextOrdinal: last !== undefined && preview.rows.some(row => row.entry.ordinal > last) ? last + 1 : null };
    }
    if (command === "read_execution_attempt") {
      const offset = Number(request.offset), rows = preview.rows.slice(offset, offset + pageSize);
      return translationAttemptFixture(preview, rows, offset + rows.length < preview.total ? offset + rows.length : null);
    }
    if (command === "prepare_translation_adoption") {
      if (!validateRequestAdopt(request)) throw new Error("Invalid synthetic adoption request");
      requests.set(request.actionId, request);
      if (request.itemId === conflictItem) throw { code: "dependency-conflict", outcome: "rejected", stage: "execution-adopt", recoveryRequired: false, reason: "translation-selection" };
      return action(request);
    }
    if (command === "adopt_execution") {
      const original = requests.get(String(request.actionId));
      if (!original) throw new Error("Synthetic adoption has no prepared action");
      if (original.itemId === unknownItem) throw new Error("Lost synthetic adoption acknowledgement");
      return receipt(original);
    }
    if (command === "read_translation_adoption_action") {
      if (lookup === "unavailable") throw new Error("Synthetic original-action lookup unavailable");
      if (lookup === "absent") return null;
      const original = request.adoption;
      if (!validateRequestAdopt(original)) throw new Error("Invalid synthetic original-action lookup");
      return { action: action(original), receipt: receipt(original) };
    }
    throw new Error(`Unexpected synthetic request: ${command}`);
  });
});
afterEach(() => { cleanup(); resources.splice(0).forEach(({ reads, drafts }) => { drafts.retire(); reads.retire(); }); });

it.each(["candidate-only", "replace"] as const)("requires inline confirmation before the real %s prepare and adoption IPC", async decision => {
  const row = decision === "replace" ? selectedRow(0) : translationRowFixture(0);
  preview = translationPreviewFixture([row]);
  const { drafts } = await harness(), label = decision === "replace" ? "importReplace" : "importCandidate";
  chooseRow(0, label);
  const confirmation = screen.getByRole("region", { name: w("importConfirmRow") });
  expect(confirmation).toHaveFocus();
  expect(within(confirmation).getByText(row.entry.text)).toBeVisible();
  expect(calls("prepare_translation_adoption")).toHaveLength(0); expect(calls("adopt_execution")).toHaveLength(0);
  confirmRow(label);
  await waitFor(() => expect(owner.current().completionVersion).toBe(1));
  const original = calls("prepare_translation_adoption")[0][1].request;
  expect(original).toMatchObject({ ...context, attemptId: preview.attemptId, itemId: row.itemId, resultId: row.resultId,
    confirmation: { targetUnitId: row.unitId, occurrenceId: row.occurrenceId, sourceRevisionId: row.sourceRevisionId,
      sourceSnapshotId: preview.fixedSourceSnapshotId, resultDigest: row.resultDigest, expectedSelectionId: row.currentSelection?.eventId ?? null, decision } });
  expect(translationRecoveryUnit(row)).not.toBe(row.unitId);
  expect(calls("adopt_execution").map(([, args]) => args.request)).toEqual([{ ...context, actionId: original.actionId }]);
  expect(drafts.getSnapshot().mutationReserved).toBe(false);
  expect(screen.getByText(w("importReceiptFound"))).toBeVisible();
  expect(screen.getByRole("region", { name: w("importTitle") })).toHaveFocus();
});

it("captures all pages once, applies only the fixed unique empty set, and reconciles partial results with a pure original-action read", async () => {
  const rows = [translationRowFixture(0), translationRowFixture(1), translationRowFixture(2), selectedRow(3),
    translationRowFixture(4, { status: "ambiguous", unitId: null }), translationRowFixture(5, { status: "unmatched", unitId: null })];
  preview = translationPreviewFixture(rows); pageSize = 2; conflictItem = rows[1].itemId; unknownItem = rows[2].itemId; lookup = "unavailable";
  const { drafts } = await harness();
  expect(screen.queryByRole("rowheader", { name: "key-2" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: w("importSelectEmpty") })); click("importPrepareBatch");
  await screen.findByRole("region", { name: w("importConfirmBatch") });
  expect(owner.current().batchCapture?.eligible.map(row => row.itemId)).toEqual(rows.slice(0, 3).map(row => row.itemId));
  expect(owner.current().batchCapture?.excluded).toBe(3);
  expect(calls("prepare_translation_adoption")).toHaveLength(0);
  click("nextPage"); await screen.findByRole("rowheader", { name: "key-2" });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.importApplyBatch", { count: 3 }) }));
  await waitFor(() => expect(owner.current().batchOutcome).toEqual({ applied: 1, conflicted: 1, failed: 0, unknown: 1 }));
  expect(calls("prepare_translation_adoption").map(([, args]) => args.request.itemId)).toEqual(rows.slice(0, 3).map(row => row.itemId));
  expect(calls("prepare_translation_adoption").every(([, args]) => args.request.confirmation.decision === "select-if-empty")).toBe(true);
  expect(calls("read_execution_attempt").map(([, args]) => args.request.offset)).toEqual([0, 2, 4]);
  expect(screen.getByText(i18n.t("workbenchV2.importOutcome", { applied: String(1), conflicted: String(1), failed: String(0), unknown: String(1) }))).toBeVisible();
  expect(drafts.getSnapshot().mutationReserved).toBe(true);
  expect(screen.queryByRole("button", { name: w("importRetryOriginal") })).toBeNull();
  const pending = owner.current().uncertain[0], writes = calls("prepare_translation_adoption").length + calls("adopt_execution").length, allocated = calls("create_execution_identity").length;
  lookup = "recorded"; click("importCheckResult");
  await waitFor(() => expect(owner.current().uncertain).toHaveLength(0));
  expect(calls("read_translation_adoption_action").at(-1)?.[1].request).toEqual({ adoption: pending.request, unitId: pending.recoveryUnitId });
  expect(calls("prepare_translation_adoption").length + calls("adopt_execution").length).toBe(writes);
  expect(calls("create_execution_identity")).toHaveLength(allocated);
  expect(screen.getByText(i18n.t("workbenchV2.importOutcome", { applied: String(2), conflicted: String(1), failed: String(0), unknown: String(0) }))).toBeVisible();
  expect(drafts.getSnapshot().mutationReserved).toBe(false);
});

it("keeps an unknown action across hidden, changed-view and removed-locale states and permits only its checked original retry", async () => {
  unknownItem = preview.rows[0].itemId; lookup = "unavailable";
  const { show, gate, commands, drafts } = await harness(); chooseRow(0, "importCandidate"); confirmRow("importCandidate");
  await waitFor(() => expect(owner.current().uncertain).toHaveLength(1)); await waitFor(() => expect(owner.current().busy).toBe(false));
  const pending = owner.current().uncertain[0], original = pending.request;
  expect(screen.queryByRole("button", { name: w("importRetryOriginal") })).toBeNull();
  const input = { kind: "translation-import-pending" as const, request: original, recoveryUnitId: pending.recoveryUnitId, previousSelectionSequence: pending.previousSelectionSequence };
  expect(commands.dispatch("translation.retry-import-action", commandScope, input)).toBe(false);
  expect(commands.dispatch("translation.check-import-receipt", commandScope, { ...input, request: { ...original, actionId: fixtureIdentity(999) } })).toBe(false);
  show({ visible: false });
  expect(commands.dispatch("translation.check-import-receipt", commandScope, input)).toBe(false);
  show(); act(() => gate.setVisibleOwner("another-view"));
  expect(commands.dispatch("translation.check-import-receipt", commandScope, input)).toBe(false);
  act(() => { gate.setVisibleOwner("entries"); gate.setComposing("synthetic-editor", true); });
  expect(commands.dispatch("translation.check-import-receipt", commandScope, input)).toBe(false);
  act(() => gate.setComposing("synthetic-editor", false));
  show({ current: { ...project, metadata: { ...project.metadata, targetLocales: ["ja"], metadataRevision: "2" } } });
  expect(owner.current().uncertain[0].request).toEqual(original);
  expect(drafts.getSnapshot().mutationReserved).toBe(true);
  const allocated = calls("create_execution_identity").length, adopted = calls("adopt_execution").length;
  lookup = "absent"; click("importCheckResult");
  await waitFor(() => expect(screen.getByRole("button", { name: w("importRetryOriginal") })).toBeEnabled());
  expect(calls("adopt_execution")).toHaveLength(adopted);
  show(); unknownItem = null; click("importRetryOriginal");
  await waitFor(() => expect(owner.current().uncertain).toHaveLength(0));
  expect(calls("prepare_translation_adoption").map(([, args]) => args.request)).toEqual([original, original]);
  expect(calls("adopt_execution").map(([, args]) => args.request.actionId)).toEqual([original.actionId, original.actionId]);
  expect(calls("create_execution_identity")).toHaveLength(allocated);
  expect(drafts.getSnapshot().mutationReserved).toBe(false);
});

it("retains the inline decision when hiding interrupts identity allocation, then applies through the same owner after returning", async () => {
  const { show, drafts } = await harness(); chooseRow(0, "importCandidate");
  const captured = owner.current().rowAction, allocated = deferred<string>(), wire = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "create_execution_identity" ? allocated.promise : wire(command, args));
  confirmRow("importCandidate"); await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  show({ visible: false }); await act(async () => allocated.resolve(fixtureIdentity(777)));
  await waitFor(() => expect(owner.current().busy).toBe(false));
  expect(calls("prepare_translation_adoption")).toHaveLength(0); expect(calls("adopt_execution")).toHaveLength(0);
  expect(owner.current().rowAction).toEqual(captured); expect(drafts.getSnapshot().mutationReserved).toBe(false);
  invoke.mockImplementation(wire); show(); confirmRow("importCandidate");
  await waitFor(() => expect(owner.current().completionVersion).toBe(1));
  expect(calls("prepare_translation_adoption")).toHaveLength(1); expect(calls("adopt_execution")).toHaveLength(1);
});

it("rejects stale or forged row targets and gates new applies during composition, another view, a held draft slot and locale removal", async () => {
  const { show, commands, gate, drafts } = await harness(); chooseRow(0, "importCandidate");
  const input = rowPayload(preview, preview.rows[0], "candidate-only"), captured = owner.current().rowAction;
  expect(commands.dispatch("translation.apply-import-row", commandScope, { ...input, unitId: fixtureIdentity(999) })).toBe(false);
  expect(commands.dispatch("translation.apply-import-row", commandScope, { ...input, editSeq: input.editSeq + 1 })).toBe(false);
  expect(commands.dispatch("translation.apply-import-row", { ...commandScope, sessionToken: "another-session" }, input)).toBe(false);
  act(() => gate.setComposing("synthetic-editor", true)); confirmRow("importCandidate");
  act(() => { gate.setComposing("synthetic-editor", false); gate.setVisibleOwner("another-view"); }); confirmRow("importCandidate");
  act(() => gate.setVisibleOwner("entries"));
  let token: symbol | null = null; act(() => { token = drafts.reserveMutation(); }); expect(token).not.toBeNull();
  confirmRow("importCandidate"); act(() => { if (token) drafts.releaseMutation(token); });
  show({ disabled: true }); confirmRow("importCandidate");
  show({ current: { ...project, metadata: { ...project.metadata, targetLocales: ["ja"], metadataRevision: "2" } } }); confirmRow("importCandidate");
  expect(calls("prepare_translation_adoption")).toHaveLength(0); expect(calls("adopt_execution")).toHaveLength(0); expect(calls("create_execution_identity")).toHaveLength(0);
  expect(owner.current().rowAction).toEqual(captured);
  expect(screen.getByRole("region", { name: w("importConfirmRow") })).toBeVisible();
});
