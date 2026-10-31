import { useLayoutEffect, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { Button } from "../../../design-system/Button";
import { executionCommands, executionContext } from "../../../executionCommands";
import { ExecutionTaskProvider, type MutationCoordinator } from "../../../ExecutionTaskSession";
import { i18n } from "../../../i18n";
import type { ProjectView } from "../../../projectCommands";
import { ReviewDraftProvider, reviewDraftKey, useReviewDraftSession } from "../../../ReviewDraftSession";
import type { ReviewDecision, ReviewTarget, ReviewWrite } from "../../../reviewCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { reviewDecisionFixture, reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { WorkbenchCommands } from "../../../workbenchCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import type { WorkspaceSelection } from "../../workspace/workspaceSelection";
import { TranslationDrafts } from "../editor/translationDrafts";
import ReviewBatchPanel from "./ReviewBatchPanel";
import type { ReviewBatchControlPayload } from "./batchTypes";
import type { ReviewOwner } from "./reviewTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "v2-review-batch", locator: "/synthetic/v2-review-batch", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(9300), displayName: "Synthetic batch approval", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN", "ja"] } };
const context = executionContext(project), scope = { ...context, area: "translation" as const }, snapshot = fixtureIdentity(9301);
const resources: { reads: SessionReads; drafts: TranslationDrafts; gate: InteractionGate }[] = [];
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(index: number): ReviewTarget {
  return reviewTargetFixture({ unitId: fixtureIdentity(9400 + index), nativeKey: `review.batch.${index}`, sourceSnapshotId: snapshot,
    sourceRevisionId: fixtureIdentity(9600 + index), selectionId: fixtureIdentity(9800 + index), revisionId: fixtureIdentity(10000 + index),
    sourceText: `Source ${index} {name}`, translationText: index === 0 ? "" : `  译文 ${index} é 👩🏽‍💻\n{name}  `, basis: "b".repeat(64) });
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); });
afterEach(() => { cleanup(); resources.splice(0).forEach(({ reads, drafts, gate }) => { reads.retire(); drafts.retire(); gate.dispose(); }); vi.restoreAllMocks(); });

async function harness({ count = 2, parentDialogId, unknown = false }: { count?: number; parentDialogId?: string; unknown?: boolean } = {}) {
  const targets = Array.from({ length: count }, (_, index) => fixture(index)), current = new Map(targets.map(target => [target.unitId, target]));
  const receipts = new Map<string, { request: ReviewWrite; receipt: ReviewDecision }>();
  let sequence = 10500, lostWrite = unknown, lostRead = unknown;
  invoke.mockImplementation(async (command: string, args?: { request: { unitId?: string; locale?: string; actionId?: string; decision?: ReviewWrite } }) => {
    if (command === "create_execution_identity") return fixtureIdentity(++sequence);
    if (command === "read_content_scope") return { currentSnapshot: snapshot, revision: "1" };
    if (command === "read_review_target") { const target = current.get(args?.request.unitId ?? ""); if (!target) throw new Error("Missing synthetic member"); return { ...structuredClone(target), locale: args?.request.locale ?? target.locale }; }
    if (command === "write_review_decision") {
      const request = args?.request.decision; if (!request) throw new Error("Missing approval request");
      if (lostWrite) { lostWrite = false; throw new Error("Lost approval ACK"); }
      const target = current.get(request.unitId); if (!target) throw new Error("Missing original target");
      const receipt = { ...reviewDecisionFixture(request, target), decisionId: fixtureIdentity(++sequence) };
      receipts.set(request.actionId, { request: structuredClone(request), receipt }); current.set(target.unitId, { ...target, currentDecision: receipt }); return receipt;
    }
    if (command === "read_review_decision_action") {
      if (lostRead) { lostRead = false; throw new Error("Read unavailable"); }
      return structuredClone(receipts.get(args?.request.actionId ?? "") ?? null);
    }
    throw new Error(`Unexpected native request: ${command}`);
  });
  const reads = new SessionReads(context), gate = new InteractionGate(), commands = new WorkbenchCommands();
  gate.setVisibleOwner("entries"); if (parentDialogId) gate.pushDialog(parentDialogId);
  const drafts = new TranslationDrafts({ context, reads, ports: { list: async () => ({ items: [], next: null }), writerId: () => fixtureIdentity(9302) } }); await drafts.initialize();
  resources.push({ reads, drafts, gate });
  const mutations: MutationCoordinator = { reserveMutation: () => drafts.reserveMutation("retained-for-navigation"), releaseMutation: token => drafts.releaseMutation(token) };
  const selection: WorkspaceSelection = { kind: "ids", locale: "zh-CN", sourceSnapshotId: snapshot, unitIds: targets.map(target => target.unitId) };
  let retained: ReviewOwner | null = null, settings = { disabled: false, parentDialogId }, changeOpen: (open: boolean) => void = () => {};
  function Content() {
    const owner = useReviewDraftSession(), [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null);
    useLayoutEffect(() => { retained = owner; changeOpen = setOpen; });
    const payload: ReviewBatchControlPayload = { kind: "review-batch-control", chosen: owner.state.chosen, items: owner.state.batchItems };
    return <><Button ref={trigger} onClick={() => commands.dispatch("review.batch-show", scope, payload)}>Inspect synthetic approval</Button>
      <ReviewBatchPanel {...settings} drafts={drafts} project={project} owner={owner} selection={selection} commands={commands} gate={gate} viewId="entries" open={open} onOpenChange={setOpen} returnFocusRef={trigger}/></>;
  }
  const ui = () => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
    <ExecutionTaskProvider project={project} mutations={mutations}><ReviewDraftProvider project={project} mutations={mutations}><Content/></ReviewDraftProvider></ExecutionTaskProvider>
  </SessionReadProvider></ApplicationReadProvider>;
  const rendered = render(ui()), owner = () => { if (!retained) throw new Error("Missing original review owner"); return retained; };
  await waitFor(() => expect(retained).not.toBeNull());
  return { targets, current, receipts, selection, reads, gate, commands, drafts, owner,
    open: async () => { await userEvent.setup().click(screen.getByRole("button", { name: "Inspect synthetic approval" })); return screen.findByRole("dialog", { name: i18n.t("workbenchV2.reviewBatchTitle") }); },
    show: (patch: Partial<typeof settings> & { open?: boolean }) => { settings = { ...settings, ...patch }; if (patch.open !== undefined) changeOpen(patch.open); rendered.rerender(ui()); },
    control: (): ReviewBatchControlPayload => ({ kind: "review-batch-control", chosen: owner().current().chosen, items: owner().current().batchItems }) };
}
const confirm = (count: number, actor = "Reviewer A") => screen.getByRole("button", { name: i18n.t("workbenchV2.reviewBatchConfirm", { count, actor }) });
async function setActor(value = "Reviewer A") { const actor = screen.getByRole("textbox", { name: i18n.t("workbenchV2.entryReviewActor") }); fireEvent.change(actor, { target: { value } }); }
async function closePanel() {
  const dialog = screen.getByRole("dialog", { name: i18n.t("workbenchV2.reviewBatchTitle") });
  await userEvent.setup().click(within(dialog).getAllByRole("button", { name: i18n.t("workbenchV2.close") }).at(-1)!);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: i18n.t("workbenchV2.reviewBatchTitle") })).toBeNull());
}

it("rejects more than one hundred fixed members without truncating or reading a different selection", async () => {
  const h = await harness({ count: 101 }); await h.open();
  expect(screen.getByText(i18n.t("workbenchV2.reviewBatchLimit", { count: 100 }))).toBeVisible();
  expect(calls("read_review_target")).toHaveLength(0); expect(calls("create_execution_identity")).toHaveLength(0); expect(calls("write_review_decision")).toHaveLength(0);
  expect(h.owner().current().chosen).toEqual({});
});

it("previews every selected entry through bounded reads, pages fifty rows and preserves selected empty and Unicode text", async () => {
  const h = await harness({ count: 52 }); const dialog = await h.open();
  const table = await screen.findByRole("table", { name: i18n.t("workbenchV2.reviewBatchRows") });
  expect(within(dialog).getByRole("button", { name: i18n.t("workbenchV2.reviewBatchApprove") })).toBeDisabled();
  await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(51));
  expect(within(table).getByText(i18n.t("workbenchV2.editorEmptySelection"))).toBeVisible(); expect(within(table).getByText("review.batch.49")).toBeVisible();
  expect(within(table).queryByText("review.batch.50")).toBeNull();
  const unicodeRow = within(table).getByText("review.batch.1", { exact: true }).closest("tr");
  expect(unicodeRow?.cells[2].textContent).toBe(h.targets[1].translationText);
  await userEvent.setup().click(within(dialog).getByRole("button", { name: i18n.t("workbenchV2.nextPage") }));
  expect(within(table).getAllByRole("row")).toHaveLength(3); expect(within(table).getByText("review.batch.51")).toBeVisible();
  expect(document.activeElement).toBe(screen.getByRole("region", { name: i18n.t("workbenchV2.reviewBatchResults") }));
  expect(calls("read_review_target")).toHaveLength(52); expect(calls("write_review_decision")).toHaveLength(0); expect(h.owner().current().chosen).toEqual({});
});

it("freezes approval name A before identity while preserving new name B and per-entry reasons", async () => {
  const h = await harness(), identity = deferred<string>(); const allocate = vi.spyOn(executionCommands, "identity").mockReturnValueOnce(identity.promise);
  await h.open(); await setActor(); await waitFor(() => expect(confirm(2)).toBeEnabled());
  act(() => h.owner().editReason(h.targets[0], "Retained individual reason A"));
  await userEvent.setup().click(confirm(2)); await waitFor(() => expect(allocate).toHaveBeenCalledOnce());
  await setActor("Reviewer B"); act(() => h.owner().editReason(h.targets[0], "New individual reason B"));
  const newInput = screen.getByRole("textbox", { name: i18n.t("workbenchV2.entryReviewActor") }); newInput.focus();
  expect(screen.getByRole("button", { name: i18n.t("workbenchV2.reviewBatchApproving") })).toBeDisabled();
  await act(async () => { identity.resolve(fixtureIdentity(10700)); });
  await waitFor(() => expect(h.owner().current().batchStatus?.applied).toBe(2));
  expect(document.activeElement).toBe(newInput);
  await act(async () => { await h.reads.client.invalidateQueries(); });
  expect(calls("read_review_target")).toHaveLength(2);
  expect(screen.queryByText(i18n.t("workbenchV2.reviewBatchReadFailed"))).toBeNull();
  const approvals = calls("write_review_decision").map(([, args]) => args.request.decision);
  expect(approvals).toHaveLength(2); expect(approvals.every(value => value.actor === "Reviewer A" && value.reason === "" && value.kind === "approve")).toBe(true);
  expect(h.owner().current().actor).toBe("Reviewer B"); expect(h.owner().current().drafts[reviewDraftKey(h.targets[0])]).toBe("New individual reason B");
  expect(h.drafts.getSnapshot().summaries).toEqual([]); expect(screen.getByText(i18n.t("workbenchV2.reviewBatchReasonsKept"))).toBeVisible();
});

it("rejects an old approval payload after the name changes and rejects Query ABA before the first approval dispatch", async () => {
  const h = await harness(), identity = deferred<string>(), allocate = vi.spyOn(executionCommands, "identity").mockReturnValueOnce(identity.promise);
  const dispatch = vi.spyOn(h.commands, "dispatch"); await h.open(); await setActor(); await waitFor(() => expect(confirm(2)).toBeEnabled());
  await userEvent.setup().click(confirm(2)); await waitFor(() => expect(allocate).toHaveBeenCalledOnce());
  const old = dispatch.mock.calls.find(([id]) => id === "review.batch-approve")?.[2];
  const record = h.reads.client.getQueryCache().findAll().find(query => query.queryKey[2] === "review-batch" && query.state.data !== undefined);
  if (!record || !old || old.kind !== "review-batch-approve") throw new Error("Missing captured approval read");
  act(() => { h.reads.client.setQueryData(record.queryKey, record.state.data); });
  await act(async () => { identity.resolve(fixtureIdentity(10701)); }); await waitFor(() => expect(h.owner().current().batchRunning).toBe(false));
  expect(calls("write_review_decision")).toHaveLength(0);
  await setActor("Reviewer B"); expect(h.commands.dispatch("review.batch-approve", scope, old)).toBe(false); expect(allocate).toHaveBeenCalledOnce();
});

it("pauses an unknown request, checks and retries only that request, then requires an explicit read and confirmation for remaining entries", async () => {
  const h = await harness({ unknown: true }), user = userEvent.setup(); await h.open(); await setActor(); await waitFor(() => expect(confirm(2)).toBeEnabled());
  await user.click(confirm(2)); await waitFor(() => expect(h.owner().current().batchStatus?.pending).toBe(1));
  expect(document.activeElement).toBe(screen.getByRole("region", { name: i18n.t("workbenchV2.reviewBatchResults") }));
  const original = h.owner().current().pending; if (!original || original.kind !== "decision") throw new Error("Missing original approval");
  expect(h.owner().current().batchStatus?.failed).toBe(0); expect(calls("create_execution_identity")).toHaveLength(1);
  await closePanel(); expect(h.owner().current().pending).toBe(original); expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  await h.open(); await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.entryReviewCheck") }));
  await waitFor(() => expect(h.owner().current().retryAllowed).toBe(true));
  expect(document.activeElement).toBe(screen.getByRole("region", { name: i18n.t("workbenchV2.reviewBatchResults") }));
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.entryReviewRetry") }));
  await waitFor(() => expect(h.owner().current().pending).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("region", { name: i18n.t("workbenchV2.reviewBatchResults") }));
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("write_review_decision")).toHaveLength(2);
  expect(calls("write_review_decision")[1][1].request.decision).toEqual(original.request);
  expect(h.owner().current().batchItems[1].status).toBe("not-started");
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.reviewBatchReadRemainingButton") }));
  await waitFor(() => expect(confirm(1)).toBeEnabled()); expect(calls("write_review_decision")).toHaveLength(2);
  await user.click(confirm(1)); await waitFor(() => expect(h.owner().current().batchStatus?.applied).toBe(2));
  expect(calls("create_execution_identity")).toHaveLength(2); expect(calls("write_review_decision")).toHaveLength(3);
});

it("keeps the active approval through close, stops before remaining entries and restores focus to the stable trigger", async () => {
  const h = await harness(), acknowledgement = deferred<ReviewDecision>(), user = userEvent.setup();
  const originalInvoke = invoke.getMockImplementation(); if (!originalInvoke) throw new Error("Missing synthetic transport");
  let request: ReviewWrite | null = null;
  invoke.mockImplementation(async (command: string, args?: { request: { decision?: ReviewWrite } }) => {
    if (command === "write_review_decision" && !request) { request = args?.request.decision ?? null; return acknowledgement.promise; }
    return originalInvoke(command, args);
  });
  await h.open(); await setActor(); await waitFor(() => expect(confirm(2)).toBeEnabled()); await user.click(confirm(2));
  await waitFor(() => expect(request).not.toBeNull()); await closePanel();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inspect synthetic approval" }));
  expect(h.commands.dispatch("review.batch-stop", scope, h.control())).toBe(true);
  const pending = h.owner().current().pending; if (!pending || pending.kind !== "decision") throw new Error("Missing active approval request");
  await act(async () => { acknowledgement.resolve(reviewDecisionFixture(pending.request, h.targets[0])); });
  await waitFor(() => expect(h.owner().current().batchRunning).toBe(false));
  expect(h.owner().current().batchItems.map(item => item.status)).toEqual(["recorded", "not-started"]); expect(calls("create_execution_identity")).toHaveLength(1);
  await h.open(); expect(screen.getByText(i18n.t("workbenchV2.reviewBatchPaused"))).toBeVisible();
});

it("preserves a changed or unread remaining target instead of rebasing approval, and ends only when no request is uncertain", async () => {
  const h = await harness({ unknown: true }), user = userEvent.setup(); await h.open(); await setActor(); await waitFor(() => expect(confirm(2)).toBeEnabled());
  await user.click(confirm(2)); await waitFor(() => expect(h.owner().current().pending).not.toBeNull()); await waitFor(() => expect(h.owner().current().batchRunning).toBe(false));
  expect(screen.getByRole("button", { name: i18n.t("workbenchV2.reviewBatchEnd") })).toBeDisabled();
  expect(h.commands.dispatch("review.batch-end", scope, h.control())).toBe(false);
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.entryReviewCheck") }));
  await waitFor(() => expect(h.owner().current().retryAllowed).toBe(true)); await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.entryReviewRetry") }));
  await waitFor(() => expect(h.owner().current().pending).toBeNull());
  h.current.set(h.targets[1].unitId, { ...h.targets[1], basis: "c".repeat(64) });
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.reviewBatchReadRemainingButton") }));
  expect(await screen.findByText(i18n.t("workbenchV2.reviewBatchReadFailed"))).toBeVisible(); expect(confirm(1)).toBeDisabled();
  expect(h.owner().current().chosen[reviewDraftKey(h.targets[1])].basis).toBe("b".repeat(64)); expect(calls("create_execution_identity")).toHaveLength(1);
  const results = h.owner().current().batchItems; await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.reviewBatchEnd") }));
  expect(h.owner().current().batchEnded).toBe(true); expect(h.owner().current().chosen).toEqual({}); expect(h.owner().current().batchItems).toBe(results);
});

it("keeps composition editable while disabling approval and immediately respects disabled and parent dialog changes", async () => {
  const h = await harness({ parentDialogId: "workspace-dock" }); await h.open(); await setActor(); await waitFor(() => expect(confirm(2)).toBeEnabled());
  const actor = screen.getByRole("textbox", { name: i18n.t("workbenchV2.entryReviewActor") });
  fireEvent.compositionStart(actor); expect(actor).not.toHaveAttribute("readonly"); expect(confirm(2)).toBeDisabled();
  fireEvent.change(actor, { target: { value: "Reviewer B" } }); fireEvent.compositionEnd(actor);
  expect(h.owner().current().actor).toBe("Reviewer B"); expect(confirm(2, "Reviewer B")).toBeEnabled();
  act(() => h.show({ disabled: true })); expect(confirm(2, "Reviewer B")).toBeDisabled();
  act(() => h.show({ disabled: false })); const release = h.gate.pushDialog("another-dialog");
  act(() => h.show({})); expect(confirm(2, "Reviewer B")).toBeDisabled(); release();
  expect(calls("write_review_decision")).toHaveLength(0);
});


it("captures the selected entries in multiple languages for the retained semantic owner without approving or starting a model", async () => {
  const h = await harness(); await h.open(); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.semanticBatchSwitch") }));
  await user.click(screen.getByRole("checkbox", { name: "ja" }));
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.semanticBatchCapture") }));
  await waitFor(() => expect(Object.values(h.owner().current().chosen)).toHaveLength(4));
  expect(h.owner().semantic.current().mode).toBe("chosen");
  expect(Object.values(h.owner().current().chosen).map(value => value.locale).sort()).toEqual(["ja", "ja", "zh-CN", "zh-CN"]);
  expect(calls("write_review_decision")).toHaveLength(0); expect(calls("prepare_ai_semantic_review")).toHaveLength(0);
  await user.click(screen.getByRole("checkbox", { name: `${h.targets[0].nativeKey} → ja` }));
  expect(Object.values(h.owner().current().chosen)).toHaveLength(3);
  await user.click(screen.getAllByRole("button", { name: i18n.t("workbenchV2.close") }).at(-1)!);
  await h.open();
  expect(h.owner().semantic.current().mode).toBe("chosen");
  expect(Object.values(h.owner().current().chosen)).toHaveLength(3);
});


it("keeps unapplied semantic language choices after the dialog content unmounts and still requires capture", async () => {
  const h = await harness(); await h.open(); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.semanticBatchSwitch") }));
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.semanticBatchCapture") }));
  await waitFor(() => expect(Object.values(h.owner().current().chosen)).toHaveLength(2));
  await user.click(screen.getByRole("checkbox", { name: "ja" }));
  expect(screen.getByRole("checkbox", { name: "ja" })).toBeChecked();
  expect(screen.getByText(i18n.t("workbenchV2.semanticBatchRecapture"))).toBeVisible();
  await user.click(screen.getAllByRole("button", { name: i18n.t("workbenchV2.close") }).at(-1)!);
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: "ja" })).not.toBeInTheDocument());
  await h.open();
  expect(screen.getByRole("checkbox", { name: "ja" })).toBeChecked();
  expect(screen.getByText(i18n.t("workbenchV2.semanticBatchRecapture"))).toBeVisible();
  expect(Object.values(h.owner().current().chosen)).toHaveLength(2);
  expect(Object.values(h.owner().current().chosen).every(target => target.locale === "zh-CN")).toBe(true);
  expect(calls("write_review_decision")).toHaveLength(0); expect(calls("prepare_ai_semantic_review")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.semanticBatchCapture") }));
  await waitFor(() => expect(Object.values(h.owner().current().chosen)).toHaveLength(4));
  expect(screen.queryByText(i18n.t("workbenchV2.semanticBatchRecapture"))).not.toBeInTheDocument();
});
