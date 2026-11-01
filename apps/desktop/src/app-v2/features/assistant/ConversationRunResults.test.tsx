import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import wire from "../../../../test/fixtures/aiCommands.contract.json";
import { validateResponseView, validateResponseWorkPlan, validateResponseWorkPlanStartAction } from "../../../generated/ai.validators";
import { i18n } from "../../../i18n";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { conversationWorkPlanFixture } from "../../../testSupport/conversationWorkPlanFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { ConversationRunResults } from "./ConversationRunResults";
import { conversationRunEffectTarget, type OpenConversationRunCandidate, type RetryConversationRunEffect } from "./conversationRunResultReads";
import { runCandidateBatchTarget, type OpenRunCandidateBatch } from "../candidates/runCandidateBatch";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const t = (key: string, values = {}) => i18n.t(`conversation.${key}`, values);
const disposals: (() => void)[] = [];
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(count = 100) {
  const context = { projectId: wire.requests.read.projectId, sessionToken: "results-dom-session" }, conversationId = id(61000);
  const prepared = conversationWorkPlanFixture({ ...context, conversationId }).prepared, plan = structuredClone(prepared.plan), value: unknown = structuredClone(wire.responses.view);
  if (!validateResponseView(value) || !plan.preview || !value.rows[0].output) throw new Error("Complete result fixture required");
  const view = value, row = structuredClone(value.rows[0]), basis = plan.scope[0], material = plan.preview.items[0], detail = view.detail.items[0];
  plan.preview.items = Array.from({ length: count }, (_, index) => ({ ...structuredClone(material), unitId: id(62000 + index), nativeKey: `entry.${index}`,
    sourceRevisionId: id(63000 + index), context: null }));
  plan.preview.config.maxItems = count; plan.preview.config.maxRequests = count;
  plan.scope = plan.preview.items.map(item => ({ ...basis, unitId: item.unitId, nativeKey: item.nativeKey, sourceRevisionId: item.sourceRevisionId }));
  view.config = structuredClone(plan.preview.config); view.recipe = plan.preview.recipe; view.planId = plan.planId; view.planGeneration = "3";
  view.rows = plan.preview.items.map((item, index) => {
    if (!row.output) throw new Error("Returned result fixture required");
    return { ...structuredClone(row), item, itemId: id(64000 + index), resultId: index === 3 ? null : id(65000 + index), savedRevisionId: index === 0 || index === 50 ? id(66000 + index) : null,
      output: index > 0 && index < 4 ? null : { ...structuredClone(row.output), unitId: item.unitId, text: index === 0 ? "" : `Returned ${index}` } };
  });
  view.detail.items = view.rows.map((item, index) => ({ ...structuredClone(detail), resultId: item.resultId,
    scope: { kind: "translation", id: item.item.unitId, locale: item.item.targetLocale }, status: { ...detail.status, itemId: item.itemId,
      adoption: item.savedRevisionId ? "committed" : detail.status.adoption,
      validation: index === 1 ? "pending" : index === 2 ? "invalid" : index === 3 ? "absent" : "valid", execution: index === 3 ? "unknown" : "succeeded" } }));
  view.detail.progress = { total: count, succeeded: count - (count > 3 ? 1 : 0), unknown: count > 3 ? 1 : 0, queued: 0, running: 0, failed: 0, cancelled: 0, adopted: view.rows.filter(row => row.savedRevisionId).length };
  view.detail.recovery.units = [];
  const start: unknown = { projectId: context.projectId, planId: plan.planId, actionId: id(61001), expectedGeneration: "3", taskId: view.detail.taskId, attemptId: view.detail.attemptId };
  if (!validateResponseWorkPlan(plan) || !validateResponseView(view) || !validateResponseWorkPlanStartAction(start) || start === null) throw new Error("Invalid result fixture");
  const link = { ...prepared.proposal, planId: plan.planId, planDigest: plan.digest, actionId: id(61002), ordinal: "1" };
  return { context, link, plan, start, view };
}
function harness(count = 100, callback = vi.fn<OpenConversationRunCandidate>(async () => true), retry?: RetryConversationRunEffect, batch?: OpenRunCandidateBatch) {
  const h = fixture(count), reads = new SessionReads(h.context), gate = new InteractionGate(); gate.setVisibleOwner("entries");
  if (retry) h.view.rows[0].automation = { actionId: id(69001), phase: "failed", retryable: true, receipt: null, error: { code: "outcome-unknown", stage: "execution-read", outcome: "unknown", recoveryRequired: true } };
  invoke.mockImplementation(async command => { if (command === "read_ai_translation") return structuredClone(h.view); throw new Error(`Unexpected result command: ${command}`); });
  const props = { ...h, visible: true, canRead: () => gate.canDispatch({ viewId: "entries", source: "button" }), onOpenCandidate: callback,
    canRetryEffect: () => true, onRetryEffect: retry, onOpenCandidateBatch: batch };
  const tree = () => <SessionReadProvider context={h.context} reads={reads} bridge={false}><label>Other draft<input aria-label="Other draft" defaultValue="Retained B"/></label>
    <ConversationRunResults {...props}/></SessionReadProvider>;
  const rendered = render(tree());
  const dispose = () => { rendered.unmount(); reads.retire(); gate.dispose(); }; disposals.push(dispose);
  const queryKey = reads.key(["conversation-run-results", h.link.conversationId, h.plan.planId, h.plan.digest, h.start.actionId, h.start.expectedGeneration, h.start.taskId, h.start.attemptId]);
  return { ...h, reads, gate, callback, rendered, queryKey, dispose, visible(value: boolean) { props.visible = value; rendered.rerender(tree()); } };
}
function resultRegion() { const region = screen.getByRole("heading", { name: t("runResultsTitle") }).closest("section"); if (!region) throw new Error("Result region required"); return region; }
async function expand() { const trigger = screen.getByRole("button", { name: t("runResultsShow") }); trigger.focus(); fireEvent.click(trigger); await screen.findByRole("heading", { name: t("runResultsTitle") }); }
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); expect(invoke.mock.calls.every(([command]) => command === "read_ai_translation")).toBe(true); });

describe("conversation run result UI", () => {
it("captures the whole original batch, shows three examples, and opens comparison before either bulk action", async () => {
  const batch = vi.fn<OpenRunCandidateBatch>(async (_target, current) => { expect(current()).toBe(true); return true; });
  const h = harness(10, undefined, undefined, batch);
  for (const index of [4, 5, 6]) {
    h.view.rows[index].savedRevisionId = id(66000 + index); h.view.detail.items[index].status.adoption = "committed";
  }
  h.view.detail.progress.adopted = 4;
  expect(batch).not.toHaveBeenCalled(); await expand();
  const card = screen.getByRole("region", { name: t("runResultsBatchTitle", { count: 4 }) });
  expect(within(card).getAllByRole("listitem")).toHaveLength(3);
  for (const name of ["runResultsViewBatch", "runResultsStageBatch"]) {
    fireEvent.click(within(card).getByRole("button", { name: t(name) }));
    await waitFor(() => expect(batch).toHaveBeenCalledTimes(name === "runResultsViewBatch" ? 1 : 2));
    expect(batch.mock.lastCall?.[0]).toEqual(runCandidateBatchTarget(h.link, h.plan, h.start, h.view.rows));
    await waitFor(() => expect(within(card).getByRole("button", { name: t(name) })).toBeEnabled());
  }
  expect(invoke).toHaveBeenCalledOnce();
});
it("offers only a retryable original effect and passes its exact current proof to the retained owner", async () => {
  const retry = vi.fn<RetryConversationRunEffect>(async (_target, current) => { expect(current()).toBe(true); return true; });
  const h = harness(1, undefined, retry); await expand();
  fireEvent.click(screen.getByRole("button", { name: t("runResultsRetryEffect") }));
  await waitFor(() => expect(retry).toHaveBeenCalledOnce());
  expect(retry.mock.calls[0][0]).toEqual(conversationRunEffectTarget(h.link, h.start, h.view.rows[0]));
  expect(invoke.mock.calls.every(([command]) => command === "read_ai_translation")).toBe(true);
});
it("withdraws an effect proof on composition or hidden results without repeating the original action", async () => {
  const finishing = deferred<boolean>(), retry = vi.fn<RetryConversationRunEffect>(async () => finishing.promise);
  const h = harness(1, undefined, retry); await expand();
  fireEvent.click(screen.getByRole("button", { name: t("runResultsRetryEffect") }));
  await waitFor(() => expect(retry).toHaveBeenCalledOnce()); const current = retry.mock.calls[0][1];
  h.gate.setComposing("editor", true); expect(current()).toBe(false); h.gate.setComposing("editor", false);
  h.visible(false); expect(current()).toBe(false); finishing.resolve(true);
  await act(async () => { await finishing.promise; }); expect(retry).toHaveBeenCalledOnce();
});
it("waits for explicit expansion, renders 25 of 100 rows and keeps saved, pending, invalid and unknown results distinct", async () => {
  const h = harness(); expect(invoke).not.toHaveBeenCalled(); await expand();
  const region = resultRegion(), rows = within(region).getAllByRole("article"); expect(rows).toHaveLength(25);
  expect(within(rows[1]).getByText(t("runResultsValidationPending"))).toBeVisible(); expect(within(rows[1]).queryByText(t("runResultsValidationValid"))).not.toBeInTheDocument();
  expect(within(rows[2]).getByText(t("runResultsValidationInvalid"))).toBeVisible(); expect(within(rows[3]).getByText(t("runResultsUnknown"))).toBeVisible();
  expect(within(region).getAllByRole("button", { name: t("runResultsOpenCandidate") })).toHaveLength(1);
  fireEvent.click(within(rows[0]).getByText(t("runResultsFullText"))); expect(await screen.findByText(t("runResultsEmptyTranslation"))).toBeVisible();
  fireEvent.click(within(region).getByRole("button", { name: t("runResultsNext") }));
  expect(within(resultRegion()).getAllByRole("article")).toHaveLength(25); expect(screen.queryByRole("button", { name: t("runResultsOpenCandidate") })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: t("runResultsNext") }));
  expect(within(resultRegion()).getByRole("heading", { name: "entry.50" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: t("runResultsNext") }));
  expect(within(resultRegion()).getByRole("heading", { name: "entry.75" })).toBeVisible(); expect(screen.getByRole("button", { name: t("runResultsNext") })).toBeDisabled();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("read_ai_translation", { request: { ...h.context, attemptId: h.start.attemptId } });
});

it("passes the exact saved result target and current-read proof without submitting a business action", async () => {
  const h = harness(); await expand(); const open = screen.getByRole("button", { name: t("runResultsOpenCandidate") }); open.focus(); fireEvent.click(open);
  await waitFor(() => expect(h.callback).toHaveBeenCalledOnce());
  const [target, current] = h.callback.mock.calls[0], row = h.view.rows[0];
  expect(target).toEqual({ projectId: h.context.projectId, conversationId: h.link.conversationId, planId: h.link.planId, planDigest: h.link.planDigest,
    actionId: h.start.actionId, generation: h.start.expectedGeneration, taskId: h.start.taskId, attemptId: h.start.attemptId,
    unitId: row.item.unitId, locale: row.item.targetLocale, sourceSnapshotId: row.item.sourceSnapshotId, sourceRevisionId: row.item.sourceRevisionId,
    itemId: row.itemId, resultId: row.resultId, revisionId: row.savedRevisionId });
  expect(current()).toBe(false); expect(invoke).toHaveBeenCalledOnce();
});

it("revokes a late candidate proof after hiding, unmounting, changing view or retiring the read session", async () => {
  for (const guard of ["hide", "unmount", "view", "retire"] as const) {
    const response = deferred<boolean>(), callback = vi.fn<OpenConversationRunCandidate>(() => response.promise), h = harness(25, callback);
    await expand(); fireEvent.click(screen.getByRole("button", { name: t("runResultsOpenCandidate") })); await waitFor(() => expect(callback).toHaveBeenCalledOnce());
    const current = callback.mock.calls[0][1]; expect(current()).toBe(true);
    act(() => { if (guard === "hide") h.visible(false); else if (guard === "unmount") h.rendered.unmount(); else if (guard === "view") h.gate.setVisibleOwner("another-view"); else h.reads.retire(); });
    expect(current()).toBe(false); await act(async () => { response.resolve(false); await response.promise; }); h.dispose();
  }
});

it("revokes a late candidate proof after invalidation, equal cache writes, IME composition or a blocking dialog", async () => {
  for (const guard of ["invalidate", "same-data", "composition", "dialog"] as const) {
    const response = deferred<boolean>(), callback = vi.fn<OpenConversationRunCandidate>(() => response.promise), h = harness(25, callback);
    await expand(); fireEvent.click(screen.getByRole("button", { name: t("runResultsOpenCandidate") })); await waitFor(() => expect(callback).toHaveBeenCalledOnce());
    const current = callback.mock.calls[0][1]; expect(current()).toBe(true);
    act(() => { if (guard === "invalidate") h.reads.invalidate(["execution"]); else if (guard === "same-data") h.reads.client.setQueryData(h.queryKey, h.reads.client.getQueryData(h.queryKey));
      else if (guard === "composition") h.gate.setComposing("other-input", true); else h.gate.pushDialog("blocking-dialog"); });
    expect(current()).toBe(false); await act(async () => { response.resolve(false); await response.promise; }); h.dispose();
  }
});

it("recovers failed reads and candidate checks without taking focus or text from another draft", async () => {
  const check = deferred<boolean>(), callback = vi.fn<OpenConversationRunCandidate>(() => check.promise), h = harness(25, callback);
  invoke.mockRejectedValueOnce(new Error("Result read temporarily unavailable"));
  const trigger = screen.getByRole("button", { name: t("runResultsShow") }); trigger.focus(); fireEvent.click(trigger);
  await screen.findByText(t("runResultsReadFailed"));
  const outside = screen.getByRole("textbox", { name: "Other draft" }); outside.focus();
  fireEvent.click(screen.getByRole("button", { name: t("runResultsRecoverRead") })); await screen.findByRole("heading", { name: t("runResultsTitle") });
  expect(outside).toHaveFocus(); expect(outside).toHaveValue("Retained B");
  fireEvent.click(screen.getByRole("button", { name: t("runResultsOpenCandidate") })); await waitFor(() => expect(callback).toHaveBeenCalledOnce()); outside.focus();
  await act(async () => { check.reject(new Error("Exact revision temporarily unavailable")); await check.promise.catch(() => {}); });
  await screen.findByText(t("runResultsOpenFailed")); expect(outside).toHaveFocus(); expect(outside).toHaveValue("Retained B");
  fireEvent.click(screen.getByRole("button", { name: t("runResultsRecoverRead") }));
  await waitFor(() => expect(screen.queryByText(t("runResultsOpenFailed"))).not.toBeInTheDocument()); expect(outside).toHaveFocus(); expect(outside).toHaveValue("Retained B");
  expect(h.callback).toHaveBeenCalledOnce();
});
});
