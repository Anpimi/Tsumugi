import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translationFixture from "../../../../test/fixtures/translation-commands.json";
import type { CandidateAuditCapture } from "../../../CandidateDecisionSession";
import { Button } from "../../../design-system/Button";
import { TextArea } from "../../../design-system/Field";
import type { DraftHead, DraftReadView, DraftValue } from "../../../draftCommands";
import { executionCommands, executionContext } from "../../../executionCommands";
import { validateResponseCandidateSlice } from "../../../generated/translation.validators";
import { i18n } from "../../../i18n";
import type { workbenchEn } from "../../../i18n/workbench";
import type { ProjectView } from "../../../projectCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { translationCommands, type CandidateDecision, type TranslationCandidateSliceRow } from "../../../translationCommands";
import { WorkbenchCommands, type TranslationCandidateBatchCommandPayload } from "../../../workbenchCommands";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { InteractionGate } from "../../workspace/interactionGate";
import type { WorkspaceSelection } from "../../workspace/workspaceSelection";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import CandidateOwnerHost from "./CandidateOwnerHost";
import CandidateBatchPanel, { type CandidateBatchPanelProps } from "./CandidateBatchPanel";
import CandidateBatchRecovery from "./CandidateBatchRecovery";
import type { CandidateBatchMode } from "./CandidateBatchSession";
import type { CandidateOwners } from "./candidateTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "candidate-batch-ui-session", locator: "/synthetic/candidate-batch-ui", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(1100), displayName: "Synthetic candidate batch", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const context = executionContext(project), scope = { ...context, area: "translation" as const }, snapshotId = fixtureIdentity(1101);
const copy = <T,>(value: T): T => structuredClone(value);
type TextKey = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
const w = (key: TextKey) => i18n.t(`workbenchV2.${key}`);
const resources: { drafts: TranslationDrafts; reads: SessionReads; lifecycle: ProjectLifecycle; gate: InteractionGate }[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function normalized(value: Parameters<TranslationDraftPorts["write"]>[0]["write"]["value"]): DraftValue {
  const pending = value.pending;
  return { ...copy(value), basis: { ...value.basis, selectionId: value.basis.selectionId ?? null, revisionId: value.basis.revisionId ?? null,
    text: value.basis.text ?? null }, merge: value.merge ?? null, pending: pending == null ? null : pending.kind === "selection"
    ? { ...copy(pending), request: { ...pending.request, expectedSelectionId: pending.request.expectedSelectionId ?? null } }
    : { ...copy(pending), request: { ...pending.request, expectedSelectionId: pending.request.expectedSelectionId ?? null } } };
}
function rowFixture(index: number): TranslationCandidateSliceRow {
  const target = reviewTargetFixture({ unitId: fixtureIdentity(1200 + index), sourceRevisionId: fixtureIdentity(1400 + index), sourceSnapshotId: snapshotId,
    nativeKey: `dialogue.batch.${index}`, sourceText: `Source ${index} {name}`, selectionId: null, revisionId: null, translationText: null,
    basis: "b".repeat(64) });
  return { target, selectedOriginKind: null, protection: { unitId: target.unitId, locale: target.locale, protected: false, revision: "0" }, candidateCount: 1,
    revisions: [{ ...translationFixture.receipt.revision, revisionId: fixtureIdentity(1600 + index), actionId: fixtureIdentity(1800 + index), ordinal: "1",
      unitId: target.unitId, locale: target.locale, sourceRevisionId: target.sourceRevisionId, sourceSnapshotId: snapshotId,
      originKind: "ai", text: `  AI ${index} {name}\né 👩🏽‍💻  `, candidateDecision: null }] };
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); invoke.mockRejectedValue(new Error("Unexpected native request")); });
afterEach(() => { cleanup(); resources.splice(0).forEach(({ drafts, reads, lifecycle, gate }) => { drafts.retire(); reads.retire(); lifecycle.dispose(); gate.dispose(); }); });

async function harness({ count = 2, parentDialogId, unknownFirst = false }: { count?: number; parentDialogId?: string; unknownFirst?: boolean } = {}) {
  const rows = Array.from({ length: count }, (_, index) => rowFixture(index)), rowsById = new Map(rows.map(row => [row.target.unitId, row]));
  const heads = new Map<string, DraftHead>(), receipts = new Map<string, CandidateDecision>();
  const reads = new SessionReads(context), gate = new InteractionGate(), commands = new WorkbenchCommands(), lifecycle = new ProjectLifecycle();
  gate.setVisibleOwner("entries"); if (parentDialogId) gate.pushDialog(parentDialogId);
  const readView = (unitId: string, locale = "zh-CN"): DraftReadView => {
    const row = rowsById.get(unitId); if (!row) throw new Error("Missing synthetic member");
    const key = { projectId: context.projectId, unitId, locale }, target = row.target;
    return { head: copy(heads.get(unitId) ?? { key, revision: "0", writerId: null, value: null }), current: { kind: "current", nativeKey: target.nativeKey,
      sourceText: target.sourceText, basis: { sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, text: target.translationText } } };
  };
  const read = vi.spyOn(translationCommands, "candidateSlice").mockImplementation(async request => {
    const page = { projectId: context.projectId, locale: request.locale, sourceSnapshotId: snapshotId, scopeId: request.scopeId ?? null,
      readVersion: request.readVersion ?? "synthetic-candidate-batch-read", next: null,
      rows: request.unitIds.map(unitId => {
        const row = rowsById.get(unitId); if (!row) throw new Error("Unexpected synthetic member");
        const all = row.revisions.filter(revision => (revision.candidateDecision?.request.disposition === "rejected") === (request.state === "rejected"));
        return { ...copy(row), candidateCount: all.length, revisions: copy(all.filter(revision => BigInt(revision.ordinal) > BigInt(request.afterOrdinal ?? "0"))) };
      }) };
    expect(request.unitIds.length).toBeLessThanOrEqual(50); expect(validateResponseCandidateSlice(page)).toBe(true); return page;
  });
  const ports = {
    list: vi.fn<TranslationDraftPorts["list"]>(async () => ({ items: [], next: null })),
    read: vi.fn<TranslationDraftPorts["read"]>(async request => readView(request.key.unitId, request.key.locale)),
    readMany: vi.fn<TranslationDraftPorts["readMany"]>(async request => ({ items: request.unitIds.map(unitId => readView(unitId, request.locale)), nextAfter: null })),
    write: vi.fn<TranslationDraftPorts["write"]>(async ({ write }) => {
      const head: DraftHead = { key: copy(write.key), revision: (BigInt(heads.get(write.key.unitId)?.revision ?? "0") + 1n).toString(),
        writerId: write.writerId, value: normalized(write.value) }; heads.set(write.key.unitId, head); return copy(head);
    }),
    candidateSlice: translationCommands.candidateSlice, writerId: () => fixtureIdentity(1990),
    save: vi.fn<TranslationDraftPorts["save"]>().mockRejectedValue(new Error("No formal save")),
    select: vi.fn<TranslationDraftPorts["select"]>().mockRejectedValue(new Error("No formal selection")),
    merge: vi.fn<TranslationDraftPorts["merge"]>().mockRejectedValue(new Error("No formal merge")),
  };
  const drafts = new TranslationDrafts({ context, reads, ports }); await drafts.initialize();
  resources.push({ drafts, reads, lifecycle, gate });
  let identities = 2000, lostWrite = unknownFirst, lostRead = unknownFirst;
  vi.spyOn(executionCommands, "identity").mockImplementation(async () => fixtureIdentity(++identities));
  vi.spyOn(translationCommands, "decideCandidate").mockImplementation(async request => {
    if (lostWrite) { lostWrite = false; throw new Error("Lost original decision acknowledgement"); }
    const value: CandidateDecision = { sourceSnapshotId: snapshotId, request: { ...copy(request.decision), expectedSelectionId: request.decision.expectedSelectionId ?? null,
      expectedDecisionId: request.decision.expectedDecisionId ?? null } };
    receipts.set(request.decision.actionId, value);
    const row = rowsById.get(request.decision.unitId), revision = row?.revisions.find(value => value.revisionId === request.decision.revisionId);
    if (!revision) throw new Error("Missing synthetic candidate"); revision.candidateDecision = copy(value); return copy(value);
  });
  vi.spyOn(translationCommands, "candidateAction").mockImplementation(async request => {
    if (lostRead) { lostRead = false; throw new Error("Original decision read unavailable"); } return copy(receipts.get(request.actionId) ?? null);
  });
  let retained: CandidateOwners | null = null, setOpen: (open: boolean) => void = () => {}, currentOpen = false;
  let settings = { disabled: false, viewId: "entries" as string | null, parentDialogId };
  const onEdit = vi.fn<CandidateBatchPanelProps["onEdit"]>(async () => true), onOpenChange = vi.fn<(open: boolean) => void>();
  function Content() {
    const [owners, publish] = useState<CandidateOwners | null>(null), [open, changeOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null);
    retained = owners; setOpen = changeOpen; currentOpen = open;
    return <><Button ref={trigger} onClick={() => changeOpen(true)}>Inspect synthetic batch</Button><TextArea aria-label="Synthetic translation editor" />
      <CandidateOwnerHost project={project} drafts={drafts} lifecycle={lifecycle} onOwners={publish} onReveal={() => {}}/>
      {owners ? <><CandidateBatchPanel {...settings} project={project} owner={owners.batch} owners={owners} commands={commands} gate={gate} open={open}
        returnFocusRef={trigger} onOpenChange={value => { onOpenChange(value); changeOpen(value); }} onEdit={onEdit}/>
        <CandidateBatchRecovery {...settings} project={project} owner={owners.batch} owners={owners} commands={commands} gate={gate} visible={!open} onOpen={() => changeOpen(true)}/></> : null}</>;
  }
  const ui = () => <SessionReadProvider context={context} reads={reads} bridge={false}><Content/></SessionReadProvider>;
  const rendered = render(ui()); await waitFor(() => expect(retained).not.toBeNull());
  const owners = () => { if (!retained) throw new Error("Candidate owner missing"); return retained; };
  const selection: WorkspaceSelection = { kind: "ids", locale: "zh-CN", sourceSnapshotId: snapshotId, unitIds: rows.map(row => row.target.unitId) };
  return { rows, heads, reads, drafts, ports, read, gate, commands, lifecycle, owners, onEdit, onOpenChange, selection, isOpen: () => currentOpen,
    capture: async (mode: CandidateBatchMode = "stage", fixed: WorkspaceSelection = selection) => { await act(async () => { expect(await owners().batch.capture(fixed, mode, () => true)).toBe(true); }); },
    open: async () => { const trigger = screen.getByRole("button", { name: "Inspect synthetic batch" }); trigger.focus(); fireEvent.click(trigger);
      return screen.findByRole("dialog", { name: w("candidateBatchTitle") }); },
    show: (patch: Partial<typeof settings> & { open?: boolean }) => { settings = { ...settings, ...patch }; if (patch.open !== undefined) setOpen(patch.open); rendered.rerender(ui()); },
  };
}
function batchPayload(owners: CandidateOwners): TranslationCandidateBatchCommandPayload {
  const state = owners.batch.current(), value = owners.decisions.current();
  if (state.captureId === null) throw new Error("No fixed batch");
  const audit: CandidateAuditCapture | null = state.mode === "stage" ? null : { actor: value.actor, reason: value.reason, editSeq: value.editSeq };
  return { kind: "translation-candidate-batch", captureId: state.captureId, revision: state.revision, audit };
}
async function closePanel(user: ReturnType<typeof userEvent.setup>) {
  const dialog = screen.getByRole("dialog", { name: w("candidateBatchTitle") });
  await user.click(within(dialog).getAllByRole("button", { name: w("close") }).at(-1)!);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: w("candidateBatchTitle") })).not.toBeInTheDocument());
}

it("shows a fixed scope, precise skip reasons and empty candidate text, paging at most fifty result items without writing", async () => {
  const h = await harness({ count: 52 });
  h.rows[0].revisions[0].text = ""; h.rows[1].protection.protected = true;
  h.rows[2].target = reviewTargetFixture({ ...h.rows[2].target, basisEvidence: undefined, selectionId: fixtureIdentity(2100), revisionId: fixtureIdentity(2101), translationText: "Human result" });
  h.rows[2].selectedOriginKind = "manual"; h.rows[3].revisions = [];
  h.rows[4].revisions.push({ ...copy(h.rows[4].revisions[0]), revisionId: fixtureIdentity(2102), actionId: fixtureIdentity(2103), ordinal: "2", text: "Other candidate" });
  const fixed: WorkspaceSelection = { kind: "scope", query: { text: "", selection: "all", status: "all" }, selection: { ...context,
    capture: { scopeId: fixtureIdentity(2104), sourceSnapshotId: snapshotId, locale: "zh-CN", query: "", readVersion: "fixed-scope",
      units: h.rows.map(row => ({ unitId: row.target.unitId, expectedBasis: row.target.basis, expectedDecisionId: null })) }, excluded: [h.rows[51].target.unitId] } };
  await h.capture("stage", fixed); const dialog = await h.open();
  expect(within(dialog).getByText(w("candidateBatchEmptyText"))).toBeVisible();
  expect(within(dialog).getByText(w("candidateBatchProtected"))).toBeVisible(); expect(within(dialog).getByText(w("candidateBatchHumanSelection"))).toBeVisible();
  expect(within(dialog).getByText(w("candidateBatchMultipleCandidates"))).toBeVisible();
  expect(within(dialog).getByText(i18n.t("workbenchV2.candidateBatchScope", { total: 52, excluded: 1, locale: "zh-CN" }))).toBeVisible();
  expect(within(dialog).getAllByRole("row")).toHaveLength(51); expect(h.ports.write).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: w("nextPage") }));
  expect(within(dialog).getAllByRole("row")).toHaveLength(2);
  expect(within(dialog).getByRole("region", { name: w("candidateBatchResult") })).toHaveFocus();
  expect(within(dialog).getByText(h.rows[50].target.nativeKey)).toBeVisible(); expect(within(dialog).queryByText(h.rows[51].target.nativeKey)).not.toBeInTheDocument();
  expect(translationCommands.decideCandidate).not.toHaveBeenCalled(); expect(executionCommands.identity).not.toHaveBeenCalled();
});

it("uses the original audit inputs with no defaults and requires both fields before confirming candidate decisions", async () => {
  const h = await harness(); await h.capture("reject"); const dialog = await h.open(), user = userEvent.setup();
  const actor = within(dialog).getByRole("textbox", { name: w("candidateActor") }), reason = within(dialog).getByRole("textbox", { name: w("candidateReason") });
  expect(actor).toHaveValue(""); expect(reason).toHaveValue(""); expect(within(dialog).getByRole("button", { name: w("candidateBatchConfirm") })).toBeDisabled();
  await user.type(actor, "Reviewer A"); expect(h.owners().decisions.current().actor).toBe("Reviewer A");
  expect(within(dialog).getByRole("button", { name: w("candidateBatchConfirm") })).toBeDisabled();
  await user.type(reason, "Does not fit this dialogue");
  await user.click(within(dialog).getByRole("button", { name: w("candidateBatchConfirm") }));
  await waitFor(() => expect(h.owners().batch.current().phase).toBe("complete"));
  expect(translationCommands.decideCandidate).toHaveBeenCalledTimes(2);
  for (const [request] of vi.mocked(translationCommands.decideCandidate).mock.calls) expect(request.decision).toMatchObject({ actor: "Reviewer A", reason: "Does not fit this dialogue", disposition: "rejected" });
  expect(h.ports.write).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it("revokes current confirmation immediately for disabled props, composition and a different foreground dialog", async () => {
  const h = await harness(); await h.capture(); const dialog = await h.open();
  const confirm = within(dialog).getByRole("button", { name: w("candidateBatchConfirm") }); await waitFor(() => expect(confirm).toBeEnabled());
  act(() => h.show({ disabled: true })); expect(confirm).toBeDisabled();
  expect(h.commands.dispatch("translation.confirm-candidate-batch", scope, batchPayload(h.owners()))).toBe(false);
  act(() => h.show({ disabled: false })); await waitFor(() => expect(confirm).toBeEnabled());
  act(() => h.gate.setComposing("other-input", true)); expect(confirm).toBeDisabled();
  expect(h.commands.dispatch("translation.confirm-candidate-batch", scope, batchPayload(h.owners()))).toBe(false);
  act(() => h.gate.setComposing("other-input", false));
  let release!: () => void; act(() => { release = h.gate.pushDialog("another-dialog"); }); expect(confirm).toBeDisabled();
  act(release); await waitFor(() => expect(confirm).toBeEnabled()); expect(h.ports.write).not.toHaveBeenCalled();
});

it("keeps the parent gate, blocks Escape during IME, restores the trigger and retains the same preview on reopening", async () => {
  const h = await harness({ parentDialogId: "workspace-dock" }); await h.capture("reject"); const dialog = await h.open();
  const captureId = h.owners().batch.current().captureId, actor = within(dialog).getByRole("textbox", { name: w("candidateActor") });
  expect(h.gate.getSnapshot().dialogs).toEqual(["workspace-dock", "candidate-batch"]);
  fireEvent.focus(actor); fireEvent.compositionStart(actor);
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape", isComposing: true, keyCode: 229 }); expect(dialog).toBeVisible();
  fireEvent.compositionEnd(actor); await closePanel(userEvent.setup());
  expect(h.gate.getSnapshot().dialogs).toEqual(["workspace-dock"]);
  expect(screen.getByRole("button", { name: "Inspect synthetic batch" })).toHaveFocus();
  await userEvent.setup().click(screen.getByRole("button", { name: w("candidateBatchOpen") }));
  expect(await screen.findByRole("dialog", { name: w("candidateBatchTitle") })).toBeVisible(); expect(h.owners().batch.current().captureId).toBe(captureId);
  await closePanel(userEvent.setup());
  expect(screen.getByRole("button", { name: "Inspect synthetic batch" })).toHaveFocus();
  act(() => { screen.getByRole("button", { name: "Inspect synthetic batch" }).blur(); h.show({ open: true }); });
  await closePanel(userEvent.setup());
  expect(screen.getByRole("button", { name: "Inspect synthetic batch" })).toHaveFocus();
});

it("keeps an unknown original request after closing, checks and retries it without a new identity, then explicitly continues unstarted items with B", async () => {
  const h = await harness({ unknownFirst: true });
  act(() => { h.owners().decisions.edit("actor", "Reviewer A"); h.owners().decisions.edit("reason", "Reason A"); });
  await h.capture("reject"); const dialog = await h.open();
  fireEvent.click(within(dialog).getByRole("button", { name: w("candidateBatchConfirm") }));
  await waitFor(() => expect(h.owners().batch.current().items[0].status).toBe("pending"));
  await waitFor(() => expect(h.owners().batch.current().failure).not.toBeNull());
  const original = h.owners().decisions.current().pending; expect(original).not.toBeNull();
  expect(within(dialog).getByRole("status")).toHaveTextContent(w("candidateBatchUnknown"));
  expect(within(dialog).queryByText(w("candidateBatchActionFailed"))).not.toBeInTheDocument();
  await waitFor(() => expect(within(dialog).getByRole("button", { name: w("candidateCheck") })).toBeEnabled());
  expect(within(dialog).getByRole("button", { name: w("candidateBatchEnd") })).toBeDisabled();
  expect(h.commands.dispatch("translation.end-candidate-batch", scope, batchPayload(h.owners()))).toBe(false);
  await closePanel(userEvent.setup());
  expect(screen.getByRole("status")).toHaveTextContent(w("candidateBatchUnknown"));
  expect(screen.queryByText(w("candidateBatchActionFailed"))).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: w("candidateCheck") })).toBeEnabled();
  act(() => { h.owners().decisions.edit("actor", "Reviewer B"); h.owners().decisions.edit("reason", "Reason B"); });
  expect(h.owners().decisions.current().pending).toBe(original); expect(h.owners().batch.current().items[1].status).toBe("ready");
  fireEvent.click(screen.getByRole("button", { name: w("candidateCheck") }));
  const retry = await screen.findByRole("button", { name: w("candidateRetry") }); await waitFor(() => expect(retry).toBeEnabled());
  expect(screen.queryByText(w("candidateBatchActionFailed"))).not.toBeInTheDocument(); fireEvent.click(retry);
  await waitFor(() => expect(h.owners().batch.current().items[0].status).toBe("recorded"));
  expect(executionCommands.identity).toHaveBeenCalledOnce(); expect(translationCommands.decideCandidate).toHaveBeenCalledTimes(2);
  expect(vi.mocked(translationCommands.decideCandidate).mock.calls[0][0]).toBe(original); expect(vi.mocked(translationCommands.decideCandidate).mock.calls[1][0]).toBe(original);
  expect(h.owners().batch.current().items[1].status).toBe("ready");
  fireEvent.click(screen.getByRole("button", { name: w("candidateBatchOpen") }));
  const reopened = await screen.findByRole("dialog", { name: w("candidateBatchTitle") });
  expect(within(reopened).getByRole("textbox", { name: w("candidateActor") })).toHaveValue("Reviewer B");
  expect(within(reopened).getByText(w("candidateBatchContinueAudit"))).toBeVisible();
  const next = within(reopened).getByRole("button", { name: w("candidateBatchContinue") }); await waitFor(() => expect(next).toBeEnabled()); fireEvent.click(next);
  await waitFor(() => expect(h.owners().batch.current().phase).toBe("complete"));
  expect(executionCommands.identity).toHaveBeenCalledTimes(2);
  expect(vi.mocked(translationCommands.decideCandidate).mock.calls[2][0].decision).toMatchObject({ actor: "Reviewer B", reason: "Reason B" });
});

it("stages real shared drafts and releases only its own dialog before delegating edit navigation to Root", async () => {
  const h = await harness({ count: 1, parentDialogId: "workspace-dock" }); await h.capture(); const dialog = await h.open();
  const editing = deferred<boolean>();
  h.onEdit.mockImplementation(async (_unit, _locale, parent) => {
    expect(h.onOpenChange).toHaveBeenLastCalledWith(false); expect(h.gate.getSnapshot().dialogs).toEqual(["workspace-dock"]);
    expect(parent).toBe("workspace-dock"); await editing.promise; screen.getByRole("textbox", { name: "Synthetic translation editor" }).focus(); return true;
  });
  fireEvent.click(within(dialog).getByRole("button", { name: w("candidateBatchConfirm") }));
  const edit = await within(dialog).findByRole("button", { name: w("candidateBatchEdit") }); await waitFor(() => expect(edit).toBeEnabled());
  expect(h.heads.get(h.rows[0].target.unitId)?.value).toMatchObject({ text: h.rows[0].revisions[0].text, pending: null });
  fireEvent.click(edit); await waitFor(() => expect(h.isOpen()).toBe(false));
  await act(async () => { editing.resolve(true); });
  expect(screen.getByRole("textbox", { name: "Synthetic translation editor" })).toHaveFocus();
  expect(h.onEdit).toHaveBeenCalledWith(h.rows[0].target.unitId, "zh-CN", "workspace-dock");
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled(); expect(h.ports.merge).not.toHaveBeenCalled();
});

it("does not dispatch or steal focus when the view closes during late identity allocation", async () => {
  const h = await harness({ count: 1 }); await h.capture("reject");
  act(() => { h.owners().decisions.edit("actor", "Reviewer"); h.owners().decisions.edit("reason", "Reason"); });
  const identity = deferred<string>(); vi.mocked(executionCommands.identity).mockReturnValueOnce(identity.promise);
  const dialog = await h.open(); fireEvent.click(within(dialog).getByRole("button", { name: w("candidateBatchConfirm") }));
  await waitFor(() => expect(executionCommands.identity).toHaveBeenCalledOnce());
  act(() => { h.gate.setVisibleOwner("other-view"); h.show({ viewId: "other-view", open: false }); });
  const other = screen.getByRole("textbox", { name: "Synthetic translation editor" }); other.focus();
  await act(async () => { identity.resolve(fixtureIdentity(2200)); });
  await waitFor(() => expect(h.owners().batch.current().phase).toBe("paused"));
  expect(translationCommands.decideCandidate).not.toHaveBeenCalled(); expect(other).toHaveFocus();
  expect(h.owners().decisions.current()).toMatchObject({ actor: "Reviewer", reason: "Reason", pending: null });
});
