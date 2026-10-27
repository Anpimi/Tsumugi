import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { aiSemanticReviewCommands, type AiSemanticReviewPrepared } from "../../../aiSemanticReviewCommands";
import { semanticReviewKey } from "../../../aiSemanticReviewQueries";
import { executionCommands, executionContext, type AdoptionAction, type PrepareRequest, type Receipt } from "../../../executionCommands";
import { ExecutionTaskProvider, useExecutionTaskSession, type MutationCoordinator } from "../../../ExecutionTaskSession";
import { i18n } from "../../../i18n";
import type { ProjectView } from "../../../projectCommands";
import { ReviewDraftProvider, reviewDraftKey, useReviewDraftSession } from "../../../ReviewDraftSession";
import type { ReviewTarget } from "../../../reviewCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { semanticConfig, semanticPreparedFixture, semanticTargetFixture, semanticViewFixture } from "../../../testSupport/aiSemanticReviewFixture";
import { connectionFixture } from "../../../testSupport/connectionFixture";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { WorkbenchCommands } from "../../../workbenchCommands";
import execution from "../../../../test/fixtures/executionCommands.contract.json";
import { InteractionGate } from "../../workspace/interactionGate";
import { TranslationDrafts } from "../editor/translationDrafts";
import EntrySemanticPanel from "./EntrySemanticPanel";
import SemanticRecoveryPanel from "./SemanticRecoveryPanel";
import type { ReviewOwner } from "./reviewTypes";
import type { EntrySemanticPanelProps, EntrySemanticTaskPayload } from "./semanticTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "v2-entry-semantic", locator: "/synthetic/v2-entry-semantic", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(9700), displayName: "Synthetic semantic review", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN", "ja"] } };
const context = executionContext(project), scope = { ...context, area: "translation" as const };
const resources: { reads: SessionReads; drafts: TranslationDrafts; gate: InteractionGate }[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let target: ReviewTarget;
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); target = semanticTargetFixture(); invoke.mockReset();
  invoke.mockImplementation(async (command: string) => { if (command === "read_model_connections") return connectionFixture([]); throw new Error(`Unexpected native request: ${command}`); });
  vi.spyOn(aiSemanticReviewCommands, "prepare").mockImplementation(async request => ({ ...semanticPreparedFixture(target, request.config),
    preview: { ...semanticPreparedFixture(target, request.config).preview, rules: request.rules } }));
  vi.spyOn(aiSemanticReviewCommands, "start").mockImplementation(async request => request.attemptId);
  vi.spyOn(aiSemanticReviewCommands, "startAction").mockImplementation(async (request, preview) => ({ projectId: request.projectId,
    attemptId: request.attemptId, taskId: fixtureIdentity(9702), inputDigest: "f".repeat(64), preview }));
  vi.spyOn(aiSemanticReviewCommands, "read").mockImplementation(async request => ({ attemptId: request.attemptId, view: semanticViewFixture(semanticPreparedFixture(target)) }));
});
afterEach(() => { cleanup(); resources.splice(0).forEach(({ reads, drafts, gate }) => { reads.retire(); drafts.retire(); gate.dispose(); }); vi.restoreAllMocks(); });

async function harness(initial = target, parentDialogId?: string) {
  const reads = new SessionReads(context), gate = new InteractionGate(), commands = new WorkbenchCommands();
  gate.setVisibleOwner("entries"); if (parentDialogId) gate.pushDialog(parentDialogId);
  const drafts = new TranslationDrafts({ context, reads, ports: { list: async () => ({ items: [], next: null }), writerId: () => fixtureIdentity(9701) } });
  await drafts.initialize(); resources.push({ reads, drafts, gate });
  const mutations: MutationCoordinator = { reserveMutation: () => drafts.reserveMutation("retained-for-navigation"), releaseMutation: token => drafts.releaseMutation(token) };
  let retained: ReviewOwner | null = null, retainedTasks: ReturnType<typeof useExecutionTaskSession> | null = null;
  type Presentation = Pick<EntrySemanticPanelProps, "target" | "read" | "visible" | "disabled" | "parentDialogId"> & { recovery: boolean };
  function seed(value: ReviewTarget) {
    const key = ["synthetic-semantic-details", value.unitId, value.locale] as const;
    reads.client.setQueryData(reads.key(key), { current: value }); return { key, data: reads.client.getQueryData(reads.key(key)) };
  }
  let presentation: Presentation = { target: initial, read: seed(initial), visible: true, disabled: false, parentDialogId, recovery: false };
  function Content(props: Presentation) {
    const owner = useReviewDraftSession(), tasks = useExecutionTaskSession();
    useLayoutEffect(() => { retained = owner; retainedTasks = tasks; });
    const shared = { project, owner, commands, gate, viewId: "entries", disabled: props.disabled, parentDialogId: props.parentDialogId };
    return <><EntrySemanticPanel {...shared} target={props.target} read={props.read} drafts={drafts} visible={props.visible && !props.recovery}/>
      <SemanticRecoveryPanel {...shared} visible={props.recovery}/></>;
  }
  const ui = () => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
    <ExecutionTaskProvider project={project} mutations={mutations}><ReviewDraftProvider project={project} mutations={mutations}><Content {...presentation}/></ReviewDraftProvider></ExecutionTaskProvider>
  </SessionReadProvider></ApplicationReadProvider>;
  const rendered = render(ui());
  const owner = () => { if (!retained) throw new Error("Missing retained review owner"); return retained; };
  const tasks = () => { if (!retainedTasks) throw new Error("Missing retained Task owner"); return retainedTasks; };
  await waitFor(() => expect(owner().current().projection?.unitId).toBe(initial.unitId));
  act(() => { owner().semantic.setConfig({ ...semanticConfig }); owner().semantic.setExpanded(true); });
  return { reads, drafts, gate, commands, owner, tasks, read: () => presentation.read,
    show: (patch: Partial<Presentation>) => { presentation = { ...presentation, ...patch, ...(patch.target ? { read: seed(patch.target) } : {}) }; rendered.rerender(ui()); } };
}
async function previewAndStart() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("semanticReview.prepare") }));
  const previewRegion = await screen.findByRole("region", { name: i18n.t("semanticReview.preview") }), preview = within(previewRegion);
  await waitFor(() => expect(previewRegion).toHaveFocus());
  await user.tab();
  expect(preview.getByRole("checkbox", { name: i18n.t("semanticReview.consent") })).toHaveFocus();
  await user.click(preview.getByRole("checkbox", { name: i18n.t("semanticReview.consent") }));
  await user.click(preview.getByRole("button", { name: i18n.t("semanticReview.start") }));
  await screen.findByRole("button", { name: i18n.t("semanticReview.record") });
}
function adoptionMocks() {
  const identity = vi.spyOn(executionCommands, "identity").mockResolvedValue(fixtureIdentity(9703));
  let captured: PrepareRequest | null = null, action: AdoptionAction | null = null;
  const prepare = vi.spyOn(executionCommands, "prepare").mockImplementation(async request => {
    captured = request; return action = { ...execution.action, projectId: request.projectId, actionId: request.actionId, attemptId: request.attemptId,
      unitId: request.unitId, operation: "ai-semantic-review", resultIds: request.resultIds, parameters: null };
  });
  const receipt = (): Receipt => {
    if (!captured) throw new Error("No captured request");
    return { ...execution.receipt, projectId: captured.projectId, actionId: captured.actionId, attemptId: captured.attemptId,
      unitId: captured.unitId, changes: [{ kind: "ai-semantic-review", id: target.unitId, revision: "1" }] };
  };
  const adopt = vi.spyOn(executionCommands, "adopt").mockImplementation(async () => receipt());
  const lookup = vi.spyOn(executionCommands, "adoptionAction").mockImplementation(async () => { if (!action) throw new Error("No action"); return { action, receipt: receipt() }; });
  return { identity, prepare, adopt, lookup, request: () => captured };
}

it("requires a saved selection, nonempty rules, exact parent evidence and the owning dialog without starting automatically", async () => {
  target = semanticTargetFixture({ translationText: "" });
  const h = await harness(target, "workspace-dock"), prepare = screen.getByRole("button", { name: i18n.t("semanticReview.prepare") });
  expect(prepare).toBeEnabled(); expect(aiSemanticReviewCommands.prepare).not.toHaveBeenCalled(); expect(aiSemanticReviewCommands.start).not.toHaveBeenCalled();
  act(() => h.owner().semantic.setRules([])); expect(prepare).toBeDisabled();
  act(() => h.owner().semantic.setRules(["meaning"])); expect(prepare).toBeEnabled();
  act(() => h.gate.setComposing("synthetic-editor", true)); expect(prepare).toBeDisabled();
  act(() => h.gate.setComposing("synthetic-editor", false));
  act(() => h.show({ disabled: true })); expect(prepare).toBeDisabled();
  act(() => h.show({ disabled: false, target: semanticTargetFixture({ selectionId: null, revisionId: null, translationText: null }) }));
  expect(prepare).toBeDisabled(); expect(screen.getByText(i18n.t("workbenchV2.entrySemanticNoSelection"))).toBeVisible();
});

it("previews selected empty content, requires independent consent and retains results when configuration is collapsed", async () => {
  target = semanticTargetFixture({ translationText: "" }); const h = await harness();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("semanticReview.prepare") }));
  const preview = within(await screen.findByRole("region", { name: i18n.t("semanticReview.preview") }));
  expect(preview.getByText(i18n.t("workbenchV2.editorEmptySelection"))).toBeVisible();
  expect(preview.getByRole("button", { name: i18n.t("semanticReview.start") })).toBeDisabled();
  await user.click(preview.getByRole("checkbox", { name: i18n.t("semanticReview.consent") }));
  await user.click(preview.getByRole("button", { name: i18n.t("semanticReview.start") }));
  const record = await screen.findByRole("button", { name: i18n.t("semanticReview.record") });
  act(() => h.owner().semantic.setExpanded(false));
  expect(record).toBeVisible(); expect(aiSemanticReviewCommands.start).toHaveBeenCalledOnce();
  expect(aiSemanticReviewCommands.start).toHaveBeenCalledWith(expect.objectContaining({ attemptId: fixtureIdentity(2401), confirmed: true, digest: "e".repeat(64) }));
  expect(h.tasks().currentActivity()).toBeNull(); expect(h.drafts.getSnapshot().summaries).toEqual([]);
});

it.each(["query-version", "config-B"] as const)("rejects late preparation after %s and does not steal focus from newer settings", async change => {
  const pending = deferred<AiSemanticReviewPrepared>(); vi.mocked(aiSemanticReviewCommands.prepare).mockReturnValueOnce(pending.promise);
  const h = await harness(), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("semanticReview.prepare") }));
  await waitFor(() => expect(aiSemanticReviewCommands.prepare).toHaveBeenCalledOnce());
  await user.click(screen.getByText(i18n.t("ai.connection"), { selector: "summary" }));
  const model = screen.getByRole("textbox", { name: i18n.t("ai.model") }); model.focus();
  if (change === "config-B") fireEvent.change(model, { target: { value: "new-model-B" } });
  else act(() => { h.reads.client.setQueryData(h.reads.key(h.read().key), h.read().data); });
  await act(async () => { pending.resolve(semanticPreparedFixture(target)); });
  await waitFor(() => expect(h.owner().semantic.current().busy).toBeNull());
  expect(h.owner().semantic.current().prepared).toBeNull(); expect(h.owner().semantic.current().consent).toBe(false);
  expect(document.activeElement).toBe(model);
  if (change === "config-B") expect(h.owner().semantic.current().config.model).toBe("new-model-B");
  expect(aiSemanticReviewCommands.start).not.toHaveBeenCalled();
});

it("checks the original uncertain start after leaving the entry without replacing the request or config B", async () => {
  vi.mocked(aiSemanticReviewCommands.start).mockRejectedValueOnce(new Error("Lost ACK"));
  vi.mocked(aiSemanticReviewCommands.startAction).mockRejectedValueOnce(new Error("Lookup unavailable"));
  const h = await harness(), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("semanticReview.prepare") }));
  const preview = within(await screen.findByRole("region", { name: i18n.t("semanticReview.preview") }));
  await user.click(preview.getByRole("checkbox")); await user.click(preview.getByRole("button", { name: i18n.t("semanticReview.start") }));
  await waitFor(() => expect(h.owner().semantic.current().pending).not.toBeNull());
  await waitFor(() => expect(h.owner().semantic.current().busy).toBeNull());
  const request = h.owner().semantic.current().pending?.request;
  act(() => { h.owner().semantic.setConfig(value => ({ ...value, model: "new-model-B" })); h.owner().setLocale("ja"); h.show({ recovery: true, visible: false }); });
  expect(screen.getByText(i18n.t("workbenchV2.entrySemanticStartUnknown"))).toBeVisible();
  expect(screen.queryByText(i18n.t("workbenchV2.entrySemanticFailed"))).toBeNull();
  await user.click(screen.getByRole("button", { name: i18n.t("semanticReview.check") }));
  await waitFor(() => expect(h.owner().semantic.current().pending).toBeNull());
  expect(aiSemanticReviewCommands.startAction).toHaveBeenLastCalledWith(request, expect.anything());
  expect(aiSemanticReviewCommands.start).toHaveBeenCalledOnce(); expect(aiSemanticReviewCommands.prepare).toHaveBeenCalledOnce();
  expect(h.owner().semantic.current().config.model).toBe("new-model-B");
});

it("only retries an absent start with the original request after explaining the model and budget consequences", async () => {
  vi.mocked(aiSemanticReviewCommands.start).mockRejectedValueOnce(new Error("Lost ACK"));
  vi.mocked(aiSemanticReviewCommands.startAction).mockResolvedValueOnce(null);
  const h = await harness(), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("semanticReview.prepare") }));
  const preview = within(await screen.findByRole("region", { name: i18n.t("semanticReview.preview") }));
  await user.click(preview.getByRole("checkbox")); await user.click(preview.getByRole("button", { name: i18n.t("semanticReview.start") }));
  const retry = await screen.findByRole("button", { name: i18n.t("semanticReview.retry") }); await waitFor(() => expect(retry).toBeEnabled());
  expect(screen.getByText(i18n.t("workbenchV2.entrySemanticStartAbsent"))).toBeVisible();
  const request = h.owner().semantic.current().pending?.request;
  await user.click(retry); await waitFor(() => expect(h.owner().semantic.current().pending).toBeNull());
  expect(aiSemanticReviewCommands.start).toHaveBeenCalledTimes(2); expect(vi.mocked(aiSemanticReviewCommands.start).mock.calls[1][0]).toBe(request);
  expect(aiSemanticReviewCommands.prepare).toHaveBeenCalledOnce();
});

it("uses the original attempt record for global confirmation and rejects same-data ABA while allocating identity", async () => {
  const h = await harness(), mocks = adoptionMocks(), identity = deferred<string>(); mocks.identity.mockReturnValueOnce(identity.promise);
  await previewAndStart(); await userEvent.setup().click(screen.getByRole("button", { name: i18n.t("semanticReview.record") }));
  await waitFor(() => expect(h.tasks().currentActivity()?.phase).toBe("confirming"));
  act(() => h.show({ recovery: true, visible: false }));
  const confirm = await screen.findByRole("button", { name: i18n.t("semanticReview.confirmRecord") }); await waitFor(() => expect(confirm).toBeEnabled());
  expect(screen.getAllByText(i18n.t("semanticReview.noFindings"))).toHaveLength(2);
  const activity = h.tasks().currentActivity(); if (!activity) throw new Error("Missing original activity");
  const canonical = semanticReviewKey(activity.intent.attemptId), record = h.reads.client.getQueryCache().find({ queryKey: h.reads.key(canonical), exact: true });
  const payload: EntrySemanticTaskPayload = { kind: "entry-semantic-task", activity, queryVersion: record?.state.dataUpdateCount ?? null };
  await userEvent.setup().click(confirm); await waitFor(() => expect(mocks.identity).toHaveBeenCalledOnce());
  act(() => h.reads.client.setQueryData(h.reads.key(canonical), record?.state.data));
  await act(async () => { identity.resolve(fixtureIdentity(9703)); });
  await waitFor(() => expect(h.tasks().currentActivity()?.phase).toBe("rejected"));
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.adopt).not.toHaveBeenCalled();
  expect(h.commands.dispatch("review.entry-semantic-confirm-record", scope, payload)).toBe(false);
});

it("retains Task recording uncertainty across views and reconciles only the original request without losing reason B", async () => {
  const h = await harness(), mocks = adoptionMocks(); mocks.adopt.mockRejectedValueOnce(new Error("Lost receipt")); mocks.lookup.mockRejectedValueOnce(new Error("Lookup unavailable"));
  await previewAndStart(); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: i18n.t("semanticReview.record") }));
  const confirm = await screen.findByRole("button", { name: i18n.t("semanticReview.confirmRecord") }); await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await waitFor(() => expect(h.tasks().currentActivity()?.phase).toBe("unknown")); const request = mocks.request();
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  act(() => { h.owner().editReason(target, "New reason B"); h.owner().semantic.setConfig(value => ({ ...value, model: "new-model-B" })); h.show({ recovery: true, visible: false }); });
  await user.click(screen.getByRole("button", { name: i18n.t("semanticReview.checkRecord") }));
  await waitFor(() => expect(h.tasks().currentActivity()?.phase).toBe("recorded"));
  expect(mocks.lookup).toHaveBeenLastCalledWith(request); expect(mocks.identity).toHaveBeenCalledOnce(); expect(mocks.prepare).toHaveBeenCalledOnce(); expect(mocks.adopt).toHaveBeenCalledOnce();
  expect(h.drafts.getSnapshot().mutationReserved).toBe(false); expect(h.drafts.getSnapshot().summaries).toEqual([]);
  expect(h.owner().current().drafts[reviewDraftKey(target)]).toBe("New reason B"); expect(h.owner().semantic.current().config.model).toBe("new-model-B");
});
