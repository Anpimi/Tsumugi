import { useLayoutEffect } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import type { DraftHead, DraftValue } from "../../../draftCommands";
import { ExecutionTaskProvider, type MutationCoordinator } from "../../../ExecutionTaskSession";
import { executionContext } from "../../../executionCommands";
import { i18n } from "../../../i18n";
import type { PluginTextReviewListView } from "../../../pluginCommands";
import type { ProjectView } from "../../../projectCommands";
import { ReviewDraftProvider, reviewDraftKey, useReviewDraftSession } from "../../../ReviewDraftSession";
import type { CheckRun, ReviewCheckRequest, ReviewCheckStartRequest, ReviewTarget } from "../../../reviewCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { reviewDiagnosticFixture } from "../../../testSupport/reviewDiagnosticFixture";
import { reviewCheckFixture, reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { coreRuleKeyFixture, formatReviewSlotFixture, textReviewSlotFixture, textReviewViewFixture } from "../../../testSupport/textReviewFixture";
import { WorkbenchCommands } from "../../../workbenchCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import EntryChecksPanel from "./EntryChecksPanel";
import type { EntryChecksPanelProps, EntryChecksRunPayload } from "./checksTypes";
import type { ReviewOwner } from "./reviewTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "entry-rule-checks", locator: "/synthetic/entry-rule-checks", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(9900), displayName: "Synthetic checks", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN", "ja"] } };
const context = executionContext(project), scope = { ...context, area: "translation" as const };
const originalTarget = () => reviewTargetFixture({ basis: "a".repeat(64) });
const copy = <T,>(value: T): T => structuredClone(value);
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
type Key = "entryChecksPrepare" | "entryChecksRun" | "entryChecksCancel" | "entryChecksCancelRequested" | "entryChecksCheck" | "entryChecksRetry"
  | "entryChecksUnknown" | "entryChecksOtherPending" | "entryChecksOutdated" | "entryChecksCurrentRecord" | "entryChecksMissing" | "entryChecksMandatory"
  | "entryChecksAdvisory" | "entryChecksDiscoveryRequired" | "entryChecksChanged" | "entryChecksSaved" | "entryChecksBasisChanged";
const w = (key: Key) => i18n.t(`workbenchV2.${key}`);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const resources: { reads: SessionReads; drafts: TranslationDrafts; gate: InteractionGate }[] = [];
const text = textReviewViewFixture();
let settings: PluginTextReviewListView, identitySequence: number;
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset(); identitySequence = 9910;
  settings = { settingsRevision: formatReviewSlotFixture().plugin.plugin.settingsRevision, entries: [{
    package: { plugin: text.binding.checker.provider.plugin, packageDigest: text.binding.checker.provider.packageDigest },
    resourceId: text.resourceId, environmentDigest: text.environmentDigest, availability: { kind: "ready", view: text },
  }] };
  invoke.mockImplementation(async (command: string, args?: { request: ReviewCheckRequest }) => {
    if (command === "read_plugin_text_reviews") return copy(settings);
    if (command === "create_execution_identity") return fixtureIdentity(identitySequence++);
    if (command === "prepare_review_checks" && args) {
      const request = args.request, checkers = [formatReviewSlotFixture()];
      return { kind: "plugin", view: { actionId: request.actionId, unitId: request.unitId, locale: request.locale, basis: request.expectedBasis,
        checkers: request.advisoryChecks.length ? [...checkers, textReviewSlotFixture({ ...text, rules: request.advisoryChecks[0].rules })] : checkers } };
    }
    throw new Error(`Unexpected native request: ${command}`);
  });
});
afterEach(() => { cleanup(); resources.splice(0).forEach(({ reads, drafts, gate }) => { reads.retire(); drafts.retire(); gate.dispose(); }); });

async function harness(target = originalTarget(), parentDialogId?: string) {
  const reads = new SessionReads(context), gate = new InteractionGate(), commands = new WorkbenchCommands();
  gate.setVisibleOwner("entries"); if (parentDialogId) gate.pushDialog(parentDialogId);
  const targets = new Map([[target.unitId, target]]), heads = new Map<string, DraftHead>();
  const write: TranslationDraftPorts["write"] = async request => {
    const input = copy(request.write.value), original = input.pending;
    const pending: DraftValue["pending"] = original == null ? null : original.kind === "selection"
      ? { ...original, request: { ...original.request, expectedSelectionId: original.request.expectedSelectionId ?? null } }
      : { ...original, request: { ...original.request, expectedSelectionId: original.request.expectedSelectionId ?? null } };
    const value: DraftValue = { ...input, basis: { sourceRevisionId: input.basis.sourceRevisionId, selectionId: input.basis.selectionId ?? null,
      revisionId: input.basis.revisionId ?? null, text: input.basis.text ?? null }, pending };
    const head: DraftHead = { key: request.write.key, revision: String(BigInt(heads.get(request.write.key.unitId)?.revision ?? "0") + 1n), writerId: request.write.writerId, value };
    heads.set(head.key.unitId, head); return copy(head);
  };
  const drafts = new TranslationDrafts({ context, reads, ports: { list: async () => ({ items: [], next: null }), writerId: () => fixtureIdentity(9901), write,
    read: async request => { const current = targets.get(request.key.unitId); if (!current) throw new Error("Missing synthetic target");
      return { head: copy(heads.get(current.unitId) ?? { key: request.key, revision: "0", writerId: null, value: null }), current: { kind: "current",
        nativeKey: current.nativeKey, sourceText: current.sourceText, basis: { sourceRevisionId: current.sourceRevisionId, selectionId: current.selectionId, revisionId: current.revisionId, text: current.translationText } } }; } } });
  await drafts.initialize(); resources.push({ reads, drafts, gate });
  const mutations: MutationCoordinator = { reserveMutation: () => drafts.reserveMutation("retained-for-navigation"), releaseMutation: token => drafts.releaseMutation(token) };
  let retained: ReviewOwner | null = null;
  type Presentation = Pick<EntryChecksPanelProps, "target" | "visible" | "disabled" | "parentDialogId" | "read">;
  const readKey = (value: ReviewTarget) => ["synthetic-check-details", value.unitId, value.locale] as const;
  function seed(value: ReviewTarget) { const key = readKey(value); reads.client.setQueryData(reads.key(key), { target: value }); return { key, data: reads.client.getQueryData(reads.key(key)) }; }
  let presentation: Presentation = { target, visible: true, disabled: false, parentDialogId, read: seed(target) };
  function Content(props: Presentation) { const owner = useReviewDraftSession(); useLayoutEffect(() => { retained = owner; });
    return <EntryChecksPanel {...props} project={project} owner={owner} drafts={drafts} commands={commands} gate={gate} viewId="entries"/>; }
  const ui = () => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
    <ExecutionTaskProvider project={project} mutations={mutations}><ReviewDraftProvider project={project} mutations={mutations}><Content {...presentation}/></ReviewDraftProvider></ExecutionTaskProvider>
  </SessionReadProvider></ApplicationReadProvider>;
  const rendered = render(ui()), owner = () => { if (!retained) throw new Error("Missing review owner"); return retained; };
  await waitFor(() => expect(owner().current().selected?.unitId).toBe(target.unitId));
  await screen.findByRole("checkbox", { name: "Preferred form" });
  return { reads, drafts, gate, commands, rendered, owner, read: () => presentation.read,
    key: { projectId: context.projectId, unitId: target.unitId, locale: target.locale }, show: (patch: Partial<Presentation>) => {
      if (patch.target) targets.set(patch.target.unitId, patch.target);
      presentation = { ...presentation, ...patch, ...(patch.target ? { read: seed(patch.target) } : {}) }; rendered.rerender(ui());
    } };
}
async function prepare(user: ReturnType<typeof userEvent.setup>, advisory = false) {
  if (advisory) await user.click(screen.getByRole("checkbox", { name: "Preferred form" }));
  const button = screen.getByRole("button", { name: w("entryChecksPrepare") }); await waitFor(() => expect(button).toBeEnabled()); await user.click(button);
  return screen.findAllByRole("checkbox", { name: i18n.t("review.checkConsent") });
}
function runPayload(owner: ReviewOwner, target: ReviewTarget): EntryChecksRunPayload {
  const current = owner.current(), preparation = current.checkReview; if (!preparation) throw new Error("Expected prepared checks");
  return { kind: "entry-checks-run", unitId: target.unitId, locale: target.locale, sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId,
    selectionId: target.selectionId, revisionId: target.revisionId, basis: target.basis, currentRunId: target.currentCheck?.runId ?? null,
    advisoryChecks: copy(current.advisoryChecks), settingsRevision: settings.settingsRevision, preparation, consent: [...current.checkConsent] };
}

it("mounts as a read and permits explicit missing-translation checks without a reviewer or selected translation", async () => {
  const target = reviewTargetFixture({ selectionId: null, revisionId: null, translationText: null, basis: "b".repeat(64) }), h = await harness(target);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_plugin_text_reviews"]);
  expect(screen.getByText(w("entryChecksMissing"))).toBeInTheDocument(); expect(h.owner().current().actor).toBe("");
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args?: { request: ReviewCheckRequest }) => command === "prepare_review_checks" && args
    ? Promise.resolve({ kind: "recorded", run: reviewCheckFixture(target, args.request.actionId, "completed", { rules: [{ key: coreRuleKeyFixture("required-translation"),
      rule: "required-translation", mandatory: true, status: "findings", reason: null, findings: [{ issueId: "f".repeat(64), rule: "required-translation", code: "missing", detail: "", severity: "error", waivable: false }] }] }) }) : original(command, args));
  await userEvent.setup().click(screen.getByRole("button", { name: w("entryChecksPrepare") }));
  await screen.findByText(w("entryChecksSaved")); expect(h.owner().current().selected?.currentCheck?.rules[0].status).toBe("findings");
  expect(screen.getByText(w("entryChecksMissing"))).toBeInTheDocument();
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("run_review_checks")).toHaveLength(0);
  expect(calls("write_review_decision")).toHaveLength(0); expect(calls("save_translation_revision")).toHaveLength(0);
});

it("requires every checker consent and revokes a run proof when the exact parent Query changes during grant allocation", async () => {
  const target = originalTarget(), h = await harness(target), user = userEvent.setup(), consents = await prepare(user, true);
  expect(consents).toHaveLength(2); consents.forEach(checkbox => expect(checkbox).not.toBeChecked());
  await user.click(consents[0]); expect(screen.getByRole("button", { name: w("entryChecksRun") })).toBeDisabled();
  await user.click(consents[1]); expect(screen.getByRole("button", { name: w("entryChecksRun") })).toBeEnabled();
  const grant = deferred<string>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args?: { request: ReviewCheckRequest }) => command === "create_execution_identity" ? grant.promise : original(command, args));
  await user.click(screen.getByRole("button", { name: w("entryChecksRun") }));
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(2));
  act(() => { h.reads.client.removeQueries({ queryKey: h.reads.key(h.read().key), exact: true }); h.reads.client.setQueryData(h.reads.key(h.read().key), h.read().data); });
  await act(async () => grant.resolve(fixtureIdentity(9940))); await waitFor(() => expect(h.owner().current().busyMutation).toBe(false));
  expect(calls("run_review_checks")).toHaveLength(0); expect(calls("create_execution_identity")).toHaveLength(2); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
});

it("replays only the original QA request and all original grants after navigation while preserving reason B and a local draft", async () => {
  const target = originalTarget(), h = await harness(target), user = userEvent.setup(), consents = await prepare(user, true);
  for (const consent of consents) await user.click(consent);
  const original = invoke.getMockImplementation()!; let runs = 0;
  invoke.mockImplementation((command: string, args?: { request: ReviewCheckStartRequest & ReviewCheckRequest }) => {
    if (command === "run_review_checks" && args) { if (++runs === 1) return Promise.reject(new Error("Synthetic lost QA ACK")); return Promise.resolve(reviewCheckFixture(target, args.request.check.actionId)); }
    if (command === "read_review_check_action") return Promise.resolve(null);
    if (command === "cancel_review_checks") return Promise.resolve(true);
    return original(command, args);
  });
  await act(async () => { await h.drafts.open(h.key); });
  act(() => { h.drafts.edit(h.key, "Local draft B 👩🏽‍💻"); h.owner().setActor("Reviewer A"); h.owner().editReason(target, "Reason A"); });
  await user.click(screen.getByRole("button", { name: w("entryChecksRun") })); await screen.findByText(w("entryChecksUnknown"));
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true); const pending = h.owner().current().pending;
  await user.click(screen.getByRole("button", { name: w("entryChecksCancel") })); await screen.findByText(w("entryChecksCancelRequested"));
  expect(h.owner().current().pending).toBe(pending); expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  act(() => { h.owner().setActor("Reviewer B"); h.owner().editReason(target, "Reason B"); });
  h.show({ visible: false }); expect(screen.queryByRole("button", { name: w("entryChecksRetry") })).not.toBeInTheDocument();
  h.show({ visible: true, target: reviewTargetFixture({ unitId: fixtureIdentity(9941), locale: "ja", basis: "c".repeat(64), nativeKey: "other" }) });
  await screen.findByText(w("entryChecksOtherPending"));
  await user.click(screen.getByRole("button", { name: w("entryChecksCheck") })); await waitFor(() => expect(calls("read_review_check_action")).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("button", { name: w("entryChecksRetry") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: w("entryChecksRetry") })); await screen.findByText(w("entryChecksSaved"));
  const requests = calls("run_review_checks").map(([, args]) => args.request);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(requests[0].executions).toHaveLength(2);
  expect(new Set(requests[0].executions.map((grant: { grantId: string }) => grant.grantId)).size).toBe(2);
  expect(requests[0].executions.every((grant: { unsandboxedExecution: boolean }) => grant.unsandboxedExecution)).toBe(true);
  expect(calls("create_execution_identity")).toHaveLength(3); expect(calls("prepare_review_checks")).toHaveLength(1);
  expect(h.owner().current().actor).toBe("Reviewer B"); expect(h.owner().current().drafts[reviewDraftKey(target)]).toBe("Reason B");
  expect(h.drafts.getEntry(h.key)?.value?.text).toBe("Local draft B 👩🏽‍💻"); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
});

it("revokes checker consent during discovery failure and requires new consent even when the same settings revision returns", async () => {
  const target = originalTarget(), h = await harness(target), user = userEvent.setup(), consents = await prepare(user);
  await user.click(consents[0]); const stale = runPayload(h.owner(), target), refresh = deferred<PluginTextReviewListView>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args?: { request: ReviewCheckRequest }) => command === "read_plugin_text_reviews" ? refresh.promise : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("review.refreshCheckers") }));
  expect(h.owner().current().checkConsent).toEqual([]); expect(h.commands.dispatch("review.entry-run-checks", scope, stale)).toBe(false);
  await act(async () => refresh.reject(new Error("Synthetic discovery failed"))); await screen.findByText(i18n.t("review.checkersReadFailed"));
  expect(screen.getByRole("button", { name: w("entryChecksRun") })).toBeDisabled();
  invoke.mockImplementation((command: string, args?: { request: ReviewCheckRequest }) => command === "read_plugin_text_reviews" ? Promise.resolve(copy(settings)) : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("review.refreshCheckers") })); await screen.findByRole("checkbox", { name: "Preferred form" });
  expect(screen.getByRole("checkbox", { name: i18n.t("review.checkConsent") })).not.toBeChecked();
  expect(screen.getByRole("button", { name: w("entryChecksRun") })).toBeDisabled();
  expect(h.commands.dispatch("review.entry-run-checks", scope, stale)).toBe(false); expect(calls("run_review_checks")).toHaveLength(0);
});

it("separates outdated QA and mandatory versus advisory results without substituting human approval for current coverage", async () => {
  const target = originalTarget(), run: CheckRun = reviewCheckFixture(target, fixtureIdentity(9950), "completed", { basis: "d".repeat(64), rules: [
    { key: coreRuleKeyFixture("required-translation"), rule: "required-translation", mandatory: true, status: "passed", reason: null, findings: [] },
    { key: coreRuleKeyFixture("terminology"), rule: "terminology", mandatory: false, status: "findings", reason: null,
      findings: [{ issueId: "e".repeat(64), rule: "terminology", code: "conflict", detail: "Keep {name}\né 👩🏽‍💻", severity: "warning", waivable: true }] },
  ] });
  const h = await harness({ ...target, currentCheck: run });
  expect(screen.getByText(w("entryChecksOutdated"))).toBeInTheDocument(); expect(screen.queryByText(w("entryChecksCurrentRecord"))).not.toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: w("entryChecksMandatory") })).getByText(i18n.t("review.passed"))).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: w("entryChecksAdvisory") })).getByText(i18n.t("review.findings"))).toBeInTheDocument();
  expect(h.rendered.container.textContent).toContain("Keep {name}\né 👩🏽‍💻");
  h.show({ target: { ...target, currentCheck: { ...run, basis: target.basis } } });
  expect(screen.getByText(w("entryChecksCurrentRecord"))).toBeInTheDocument(); expect(calls("prepare_review_checks")).toHaveLength(0); expect(calls("create_execution_identity")).toHaveLength(0);
});

it("honors parent dialog and IME gates without clearing a reason anchored to an earlier basis", async () => {
  const target = originalTarget(), h = await harness(target, "workspace-dock");
  act(() => h.gate.setComposing("human-reason", true)); expect(screen.getByRole("button", { name: w("entryChecksPrepare") })).toBeDisabled();
  act(() => h.gate.setComposing("human-reason", false));
  let close!: () => void; act(() => { close = h.gate.pushDialog("another-dialog"); });
  expect(screen.getByRole("button", { name: w("entryChecksPrepare") })).toBeDisabled(); act(() => close());
  act(() => h.owner().editReason(target, "Reason on original basis"));
  h.show({ target: reviewTargetFixture({ sourceRevisionId: fixtureIdentity(9951), basis: "e".repeat(64) }) });
  await screen.findByText(w("entryChecksBasisChanged")); expect(screen.getByRole("button", { name: w("entryChecksPrepare") })).toBeDisabled();
  expect(h.owner().current().drafts[reviewDraftKey(target)]).toBe("Reason on original basis"); expect(h.owner().current().selected?.basis).toBe(target.basis);
  expect(calls("create_execution_identity")).toHaveLength(0); expect(calls("run_review_checks")).toHaveLength(0);
});

it("keeps a late preparation on its original basis and cannot run it after source changes or explicit basis adoption", async () => {
  const target = originalTarget(), h = await harness(target), user = userEvent.setup();
  const reply = deferred<unknown>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args?: { request: ReviewCheckRequest }) => command === "prepare_review_checks" ? reply.promise : original(command, args));
  await user.click(screen.getByRole("button", { name: w("entryChecksPrepare") }));
  await waitFor(() => expect(calls("prepare_review_checks")).toHaveLength(1));
  const request: ReviewCheckRequest = calls("prepare_review_checks")[0][1].request;
  const current = reviewTargetFixture({ sourceRevisionId: fixtureIdentity(9952), basis: "f".repeat(64) });
  h.show({ target: current });
  await act(async () => reply.resolve({ kind: "plugin", view: { actionId: request.actionId, unitId: request.unitId, locale: request.locale,
    basis: request.expectedBasis, checkers: [formatReviewSlotFixture()] } }));
  await waitFor(() => expect(h.owner().current().busyMutation).toBe(false));
  const stale = runPayload(h.owner(), target);
  expect(screen.getByRole("button", { name: w("entryChecksRun") })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: i18n.t("review.checkConsent") })).toBeDisabled();
  expect(h.commands.dispatch("review.entry-run-checks", scope, stale)).toBe(false);
  act(() => { expect(h.owner().adoptCurrent()).toBe(true); });
  expect(screen.getByRole("button", { name: w("entryChecksRun") })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: i18n.t("review.checkConsent") })).toBeDisabled();
  expect(screen.getByRole("button", { name: w("entryChecksPrepare") })).toBeEnabled();
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("run_review_checks")).toHaveLength(0);
});

it("invalidates old checker slots when a newer discovery revision arrives before a late preparation", async () => {
  const h = await harness(), user = userEvent.setup(), reply = deferred<unknown>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args?: { request: ReviewCheckRequest }) => command === "prepare_review_checks" ? reply.promise : original(command, args));
  await user.click(screen.getByRole("button", { name: w("entryChecksPrepare") }));
  await waitFor(() => expect(calls("prepare_review_checks")).toHaveLength(1));
  const request: ReviewCheckRequest = calls("prepare_review_checks")[0][1].request;
  h.show({ visible: false }); settings = { settingsRevision: "2", entries: [] }; h.show({ visible: true });
  await screen.findByText(i18n.t("review.noAdvisoryChecks"));
  await act(async () => reply.resolve({ kind: "plugin", view: { actionId: request.actionId, unitId: request.unitId, locale: request.locale,
    basis: request.expectedBasis, checkers: [formatReviewSlotFixture()] } }));
  await waitFor(() => expect(h.owner().current().checkReview).toBeNull());
  expect(h.owner().current().checkConsent).toEqual([]); expect(screen.queryByRole("checkbox", { name: i18n.t("review.checkConsent") })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: w("entryChecksRun") })).not.toBeInTheDocument();
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("run_review_checks")).toHaveLength(0);
});

it("does not label a current diagnostic as historical when its location controls are in the issues panel", async () => {
  const fixture = reviewDiagnosticFixture(); await harness(fixture.target);
  expect(await screen.findByText(w("entryChecksCurrentRecord"))).toBeInTheDocument();
  expect(screen.getByText(fixture.finding.detail)).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("review.diagnosticNavigation.historical"))).not.toBeInTheDocument();
  expect(calls("read_review_diagnostic_location")).toHaveLength(0);
});
