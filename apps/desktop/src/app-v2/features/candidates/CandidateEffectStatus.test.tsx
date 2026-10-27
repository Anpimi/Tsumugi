import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../../../../test/fixtures/aiCommands.contract.json";
import translationFixture from "../../../../test/fixtures/translation-commands.json";
import { type AiCandidateEffectView } from "../../../aiCommands";
import { validateResponseView } from "../../../generated/ai.validators";
import { i18n } from "../../../i18n";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import type { TranslationRevision } from "../../../translationCommands";
import { WorkbenchCommands } from "../../../workbenchCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import CandidateEffectStatus, { candidateEffectKey, type CandidateEffectStatusProps } from "./CandidateEffectStatus";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: fixture.requests.automaticRead.projectId, sessionToken: "candidate-effect-read-session" };
const scope = { ...context, area: "translation" as const };
const readsToRetire: SessionReads[] = [];
type TextKey = "candidateEffectSelected" | "candidateEffectChecked" | "candidateEffectHelp" | "candidateEffectLoading" | "candidateEffectRefresh"
  | "candidateEffectReadFailed" | "candidateEffectUnknown" | "candidateEffectNoRecord" | "candidateEffectUnavailable";
const w = (key: TextKey) => i18n.t(`workbenchV2.${key}`);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function sample() {
  const observed: unknown = structuredClone(fixture.responses.automaticView);
  if (!validateResponseView(observed)) throw new Error("Invalid recorded effect fixture");
  const row = observed.rows[0]; if (!row.savedRevisionId || !row.resultId || !row.automation) throw new Error("Expected saved automatic result");
  const revision: TranslationRevision = { ...translationFixture.receipt.revision, unitId: row.item.unitId, locale: row.item.targetLocale,
    revisionId: row.savedRevisionId, sourceSnapshotId: row.item.sourceSnapshotId, sourceRevisionId: row.item.sourceRevisionId,
    originKind: "ai", attemptId: observed.detail.attemptId, itemId: row.itemId, resultId: row.resultId, candidateDecision: null };
  const value: AiCandidateEffectView = { projectId: context.projectId, unitId: revision.unitId, locale: revision.locale, revisionId: revision.revisionId,
    sourceSnapshotId: revision.sourceSnapshotId, sourceRevisionId: revision.sourceRevisionId, attemptId: observed.detail.attemptId, itemId: row.itemId,
    resultId: row.resultId, taskId: observed.detail.taskId, planId: observed.planId, planGeneration: observed.planGeneration, currentResult: true, retained: true, effect: row.automation };
  return { revision, value };
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); invoke.mockRejectedValue(new Error("Unexpected native request")); });
afterEach(() => { cleanup(); readsToRetire.splice(0).forEach(reads => reads.retire()); });
function harness({ enabled = true, disabled = false, copies = 1 }: { enabled?: boolean; disabled?: boolean; copies?: number } = {}) {
  const data = sample(), reads = new SessionReads(context), commands = new WorkbenchCommands(), gate = new InteractionGate(); readsToRetire.push(reads); gate.setVisibleOwner("entries");
  invoke.mockImplementation(async (command, { request }) => {
    if (command !== "read_ai_candidate_effect" || request.revisionId !== data.revision.revisionId) throw new Error("Unrelated candidate request");
    return structuredClone(data.value);
  });
  let props: CandidateEffectStatusProps = { revision: data.revision, enabled, disabled, commands, gate, viewId: "entries" };
  let firstEnabled = true;
  const ui = () => <SessionReadProvider context={context} reads={reads} bridge={false}><CandidateEffectStatus {...props} enabled={props.enabled && firstEnabled}/>
    {copies === 2 ? <CandidateEffectStatus {...props}/> : null}</SessionReadProvider>;
  const rendered = render(ui());
  return { ...data, reads, commands, gate, rendered, show: (patch: Partial<CandidateEffectStatusProps>) => { props = { ...props, ...patch }; rendered.rerender(ui()); },
    hideFirst: () => { firstEnabled = false; rendered.rerender(ui()); } };
}

it("reads only after explicit expansion and presents the saved selection as history without any executing action", async () => {
  const h = harness({ enabled: false }); expect(invoke).not.toHaveBeenCalled(); expect(h.rendered.container).toBeEmptyDOMElement();
  h.show({ enabled: true }); await screen.findByText(w("candidateEffectSelected"));
  expect(invoke.mock.calls).toEqual([["read_ai_candidate_effect", { request: { ...context, unitId: h.revision.unitId, locale: h.revision.locale, revisionId: h.revision.revisionId } }]]);
  expect(screen.getByText(w("candidateEffectHelp"))).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("ai.effects.retry") })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  for (const value of [h.value.taskId, h.value.planId, h.revision.revisionId, h.value.effect?.actionId]) if (value) expect(h.rendered.container.textContent).not.toContain(value);
});

it.each(["en-US", "zh-CN"] as const)("shows historical mandatory rules and Unicode findings without claiming current QA (%s)", async language => {
  await i18n.changeLanguage(language); const h = harness({ enabled: false }), effect = h.value.effect, receipt = effect?.receipt;
  if (!effect || !receipt?.evidence) throw new Error("Expected recorded mechanical evidence");
  effect.phase = "checked"; receipt.policy = "candidates-only"; receipt.selection = null; receipt.checkRunId = null; receipt.blocked = null; receipt.candidateBasis.selectionId = null;
  const rule = receipt.rules[0], detail = "Keep {name}\né 👩🏽‍💻";
  rule.status = "findings"; rule.findings = [{ rule: rule.rule, issueId: "f".repeat(64), code: "empty", severity: "warning", detail, waivable: false }];
  const requirement = receipt.evidence.requiredChecks.requirements.find(item => item.key.rule.id === rule.key.rule.id);
  const result = receipt.evidence.results.find(item => item.key.rule.id === rule.key.rule.id);
  if (!requirement || !result) throw new Error("Expected captured rule result");
  result.outcome = { kind: "completed", findings: [{ code: "empty", severity: "warning", target: requirement.targets[0] }] };
  h.show({ enabled: true });
  await screen.findByText(w("candidateEffectChecked"));
  expect(screen.getAllByText(i18n.t("review.mandatoryRule")).length).toBeGreaterThan(0);
  expect(h.rendered.container.textContent).toContain(detail); expect(screen.queryByText(w("candidateEffectSelected"))).not.toBeInTheDocument();
  expect(screen.getByText(w("candidateEffectHelp"))).toBeInTheDocument(); expect(invoke).toHaveBeenCalledTimes(1);
});

it("shows no record when the exact revision has neither a saved receipt nor a matching retained producer", async () => {
  const h = harness({ enabled: false }); h.value.effect = null; h.value.retained = false; h.value.planId = null; h.value.planGeneration = null;
  h.show({ enabled: true });
  await screen.findByText(w("candidateEffectNoRecord")); expect(screen.queryByText(i18n.t("workbenchV2.candidateEffectStatuses.cancelled"))).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("ai.effects.retry") })).not.toBeInTheDocument(); expect(invoke).toHaveBeenCalledTimes(1);
});

it("presents an uncertain processing record as a warning while keeping execution retry unavailable", async () => {
  const h = harness({ enabled: false }); h.value.effect = { phase: "failed", actionId: h.value.effect!.actionId, receipt: null, retryable: true,
    error: { code: "outcome-unknown", stage: "execution-read", outcome: "unknown", recoveryRequired: true } };
  h.show({ enabled: true });
  const message = await screen.findByText(w("candidateEffectUnknown")); expect(message.closest("[data-tone]")).toHaveAttribute("data-tone", "warning");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: i18n.t("ai.effects.retry") })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button")).toHaveLength(1);
});

it("hides previous evidence during refresh and after failure, then rereads the same revision through Registry", async () => {
  const h = harness(); await screen.findByText(w("candidateEffectSelected"));
  const reply = deferred<AiCandidateEffectView>(); invoke.mockImplementationOnce(() => reply.promise);
  fireEvent.click(screen.getByRole("button", { name: w("candidateEffectRefresh") }));
  expect(screen.queryByText(w("candidateEffectSelected"))).not.toBeInTheDocument(); await screen.findByText(w("candidateEffectLoading"));
  await act(async () => reply.reject(new Error("Saved record temporarily unavailable")));
  await screen.findByText(w("candidateEffectReadFailed")); expect(screen.queryByText(w("candidateEffectSelected"))).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: w("candidateEffectRefresh") })); await screen.findByText(w("candidateEffectSelected"));
  expect(invoke).toHaveBeenCalledTimes(3); expect(invoke.mock.calls.every(([name]) => name === "read_ai_candidate_effect")).toBe(true);
});

it("shares one exact record and does not invalidate its visible observer when another copy is hidden", async () => {
  const h = harness({ copies: 2 }); await waitFor(() => expect(screen.getAllByText(w("candidateEffectSelected"))).toHaveLength(2));
  expect(invoke).toHaveBeenCalledTimes(1); h.hideFirst();
  expect(screen.getAllByText(w("candidateEffectSelected"))).toHaveLength(1);
  expect(h.reads.client.getQueryState(h.reads.key(candidateEffectKey(h.revision)))?.isInvalidated).toBe(false); expect(invoke).toHaveBeenCalledTimes(1);
});

it("uses current disabled props and an explicit parent dialog for pure read refresh", async () => {
  const h = harness({ disabled: true }); expect(invoke).not.toHaveBeenCalled(); h.show({ disabled: false });
  await screen.findByText(w("candidateEffectSelected"));
  const refresh = await screen.findByRole("button", { name: w("candidateEffectRefresh") }); await waitFor(() => expect(refresh).toBeEnabled());
  let close!: () => void; act(() => { close = h.gate.pushDialog("workspace-dock"); }); expect(refresh).toBeDisabled();
  expect(h.commands.dispatch("translation.refresh-candidate-effect", scope)).toBe(false);
  h.show({ parentDialogId: "workspace-dock" }); await waitFor(() => expect(refresh).toBeEnabled());
  let other!: () => void; act(() => { other = h.gate.pushDialog("other-dialog"); }); expect(refresh).toBeDisabled(); act(() => other());
  act(() => h.gate.setComposing("physical-input", true)); expect(refresh).toBeDisabled(); act(() => h.gate.setComposing("physical-input", false));
  await waitFor(() => expect(refresh).toBeEnabled()); act(() => close());
});

it("keeps the same refresh button and keyboard focus through error, loading and success without taking focus back from another input", async () => {
  const h = harness({ enabled: false }); invoke.mockRejectedValueOnce(new Error("Record unavailable")); h.show({ enabled: true });
  await screen.findByText(w("candidateEffectReadFailed"));
  const refresh = screen.getByRole("button", { name: w("candidateEffectRefresh") }), reply = deferred<AiCandidateEffectView>();
  invoke.mockImplementationOnce(() => reply.promise); refresh.focus(); fireEvent.click(refresh);
  await screen.findByText(w("candidateEffectLoading"));
  expect(screen.getByRole("button", { name: w("candidateEffectRefresh") })).toBe(refresh); expect(refresh).toHaveFocus();
  expect(refresh).toHaveAttribute("aria-disabled", "true"); expect(refresh.parentElement).toHaveAttribute("aria-busy", "true");
  expect(h.commands.dispatch("translation.refresh-candidate-effect", scope)).toBe(false);
  await act(async () => reply.resolve(h.value)); await screen.findByText(w("candidateEffectSelected"));
  expect(screen.getByRole("button", { name: w("candidateEffectRefresh") })).toBe(refresh); expect(refresh).toHaveFocus();
  const next = deferred<AiCandidateEffectView>(); invoke.mockImplementationOnce(() => next.promise); fireEvent.click(refresh);
  const other = document.createElement("input"); h.rendered.container.append(other); other.focus();
  await act(async () => next.resolve(h.value)); await screen.findByText(w("candidateEffectSelected")); expect(other).toHaveFocus();
});

it("does not display a late old revision result after the target changes", async () => {
  const h = harness(); await screen.findByText(w("candidateEffectSelected"));
  const old = deferred<AiCandidateEffectView>(); invoke.mockImplementationOnce(() => old.promise);
  act(() => h.reads.invalidate(["execution"])); await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(w("candidateEffectSelected"))).not.toBeInTheDocument();
  const next = { ...h.revision, revisionId: fixtureIdentity(9820), resultId: fixtureIdentity(9821), attemptId: fixtureIdentity(9822), itemId: fixtureIdentity(9823) };
  invoke.mockImplementation(async (command, { request }) => {
    if (command !== "read_ai_candidate_effect" || request.revisionId !== next.revisionId) throw new Error("Wrong new target");
    return { ...h.value, revisionId: next.revisionId, resultId: next.resultId, attemptId: next.attemptId, itemId: next.itemId,
      taskId: fixtureIdentity(9824), planId: null, planGeneration: null, effect: null, retained: false };
  });
  h.show({ revision: next }); await screen.findByText(w("candidateEffectNoRecord"));
  await act(async () => old.resolve(h.value));
  expect(screen.getByText(w("candidateEffectNoRecord"))).toBeInTheDocument(); expect(screen.queryByText(w("candidateEffectSelected"))).not.toBeInTheDocument();
});

it("hides a retired session's record and never revives it from a late read", async () => {
  const h = harness(); await screen.findByText(w("candidateEffectSelected"));
  const reply = deferred<AiCandidateEffectView>(); invoke.mockImplementationOnce(() => reply.promise);
  fireEvent.click(screen.getByRole("button", { name: w("candidateEffectRefresh") })); act(() => h.reads.retire());
  await screen.findByText(w("candidateEffectUnavailable")); await act(async () => reply.resolve(h.value));
  expect(screen.queryByText(w("candidateEffectSelected"))).not.toBeInTheDocument(); expect(h.commands.dispatch("translation.refresh-candidate-effect", scope)).toBe(false);
});
