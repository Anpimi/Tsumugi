import { useLayoutEffect } from "react";
import { canonicalTranslationReuse } from "../../../translationReuse";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import type { DraftHead, DraftReadView, DraftValue } from "../../../draftCommands";
import { ExecutionTaskProvider, type MutationCoordinator } from "../../../ExecutionTaskSession";
import { executionContext } from "../../../executionCommands";
import { i18n } from "../../../i18n";
import type { ProjectView } from "../../../projectCommands";
import { ReviewDraftProvider, reviewDraftKey, useReviewDraftSession } from "../../../ReviewDraftSession";
import type { ReviewTarget, ReviewWrite } from "../../../reviewCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { reviewDecisionFixture, reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { WorkbenchCommands } from "../../../workbenchCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import EntryReviewPanel from "./EntryReviewPanel";
import type { EntryReviewPanelProps, ReviewEntryDecisionPayload, ReviewOwner } from "./reviewTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "entry-human-review", locator: "/synthetic/entry-human-review", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(9850), displayName: "Synthetic review", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN", "ja"] } };
const context = executionContext(project), scope = { ...context, area: "translation" as const };
type TextKey = "entryReviewApprove" | "entryReviewRequestChanges" | "entryReviewActor" | "entryReviewReason" | "entryReviewNoSelection"
  | "entryReviewBasisChanged" | "entryReviewAdoptCurrent" | "entryReviewUnknown" | "entryReviewOtherPending" | "entryReviewCheck" | "entryReviewRetry"
  | "entryReviewSaved" | "entryReviewReadChanged" | "entryReviewApproved" | "entryReviewChangesRequested" | "entryReviewOutdated" | "entryReviewResult";
const w = (key: TextKey) => i18n.t(`workbenchV2.${key}`);
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
const copy = <T,>(value: T): T => structuredClone(value);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const retained: { reads: SessionReads; drafts: TranslationDrafts; gate: InteractionGate }[] = [];
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "create_execution_identity") return fixtureIdentity(9851);
    throw new Error(`Unexpected native request: ${command}`);
  });
});
afterEach(() => { cleanup(); retained.splice(0).forEach(({ reads, drafts, gate }) => { reads.retire(); drafts.retire(); gate.dispose(); }); });

async function harness(target = reviewTargetFixture(), parentDialogId?: string) {
  const reads = new SessionReads(context), gate = new InteractionGate(), commands = new WorkbenchCommands();
  gate.setVisibleOwner("entries"); if (parentDialogId) gate.pushDialog(parentDialogId);
  const targets = new Map([[target.unitId, target]]), heads = new Map<string, DraftHead>();
  const readDraft: TranslationDraftPorts["read"] = async request => {
    const current = targets.get(request.key.unitId); if (!current) throw new Error("Missing synthetic draft target");
    const result: DraftReadView = { head: copy(heads.get(current.unitId) ?? { key: request.key, revision: "0", writerId: null, value: null }),
      current: { kind: "current", nativeKey: current.nativeKey, sourceText: current.sourceText, basis: { sourceRevisionId: current.sourceRevisionId,
        selectionId: current.selectionId, revisionId: current.revisionId, text: current.translationText } } };
    return result;
  };
  const writeDraft = vi.fn<TranslationDraftPorts["write"]>(async request => {
    const input = copy(request.write.value), original = input.pending;
    const pending: DraftValue["pending"] = original == null ? null : original.kind === "selection"
      ? { ...original, request: { ...original.request, expectedSelectionId: original.request.expectedSelectionId ?? null } }
      : { ...original, request: { ...original.request, reuseOrigin: canonicalTranslationReuse(original.request.reuseOrigin), expectedSelectionId: original.request.expectedSelectionId ?? null } };
    const value: DraftValue = { ...input, reuseOrigin: canonicalTranslationReuse(input.reuseOrigin), basis: { ...input.basis, selectionId: input.basis.selectionId ?? null,
      revisionId: input.basis.revisionId ?? null, text: input.basis.text ?? null }, pending, merge: input.merge ?? null };
    const head: DraftHead = { key: request.write.key, revision: String(BigInt(heads.get(request.write.key.unitId)?.revision ?? "0") + 1n),
      writerId: request.write.writerId, value };
    heads.set(head.key.unitId, head); return copy(head);
  });
  const drafts = new TranslationDrafts({ context, reads, ports: { read: readDraft, write: writeDraft,
    list: async () => ({ items: [], next: null }), writerId: () => fixtureIdentity(9852) } });
  await drafts.initialize(); retained.push({ reads, drafts, gate });
  const mutations: MutationCoordinator = { reserveMutation: () => drafts.reserveMutation("retained-for-navigation"), releaseMutation: token => drafts.releaseMutation(token) };
  let currentOwner: ReviewOwner | null = null;
  type Presentation = Pick<EntryReviewPanelProps, "target" | "visible" | "disabled" | "parentDialogId" | "read">;
  const readKey = (value: ReviewTarget) => ["synthetic-entry-details", value.unitId, value.locale] as const;
  function seed(value: ReviewTarget) {
    const data = { current: value, context: null };
    reads.client.setQueryData(reads.key(readKey(value)), data);
    const actual: unknown = reads.client.getQueryData(reads.key(readKey(value)));
    return { key: readKey(value), data: actual };
  }
  let presentation: Presentation = { target, visible: true, disabled: false, parentDialogId, read: seed(target) };
  function Content(props: Presentation) {
    const owner = useReviewDraftSession();
    useLayoutEffect(() => { currentOwner = owner; });
    return <EntryReviewPanel {...props} project={project} owner={owner} drafts={drafts} commands={commands} gate={gate} viewId="entries"/>;
  }
  const ui = () => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
    <ExecutionTaskProvider project={project} mutations={mutations}><ReviewDraftProvider project={project} mutations={mutations}>
      <Content {...presentation}/>
    </ReviewDraftProvider></ExecutionTaskProvider>
  </SessionReadProvider></ApplicationReadProvider>;
  const rendered = render(ui());
  const owner = () => { if (!currentOwner) throw new Error("Review owner not mounted"); return currentOwner; };
  await waitFor(() => expect(owner().current().selected?.unitId).toBe(target.unitId));
  const show = (patch: Partial<Presentation>) => {
    const next = { ...presentation, ...patch };
    if (patch.target) { targets.set(patch.target.unitId, patch.target); next.read = seed(patch.target); }
    presentation = next; rendered.rerender(ui());
  };
  return { reads, drafts, commands, gate, rendered, owner, show, writeDraft, key: { projectId: context.projectId, unitId: target.unitId, locale: target.locale },
    read: () => presentation.read };
}
async function audit(actor = "Reviewer A", reason = "Reason A") {
  const user = userEvent.setup(); await user.type(screen.getByRole("textbox", { name: w("entryReviewActor") }), actor);
  if (reason) await user.type(screen.getByRole("textbox", { name: w("entryReviewReason") }), reason);
  return user;
}
function decisionPayload(owner: ReviewOwner, kind: ReviewWrite["kind"] = "approve"): ReviewEntryDecisionPayload {
  const state = owner.current(), selected = state.selected; if (!selected) throw new Error("Expected selected review evidence");
  const key = reviewDraftKey(selected);
  return { kind: "entry-review-decision", decision: kind, unitId: selected.unitId, locale: selected.locale, basis: selected.basis,
    sourceSnapshotId: selected.sourceSnapshotId, sourceRevisionId: selected.sourceRevisionId, selectionId: selected.selectionId,
    revisionId: selected.revisionId, expectedDecisionId: selected.currentDecision?.decisionId ?? null, expectedFallbackId: selected.currentFallback?.fallbackId ?? null,
    actor: state.actor, reason: state.drafts[key] ?? "", editSeq: state.editSeq[key] ?? 0 };
}

it("distinguishes no selection from an explicitly selected empty translation and leaves a local draft untouched", async () => {
  const missing = reviewTargetFixture({ selectionId: null, revisionId: null, translationText: null }), h = await harness(missing);
  const user = await audit(" Actual reviewer ", "");
  expect(screen.getByText(w("entryReviewNoSelection"))).toBeInTheDocument();
  expect(screen.getByRole("button", { name: w("entryReviewApprove") })).toBeDisabled(); expect(calls("create_execution_identity")).toHaveLength(0);
  const target = reviewTargetFixture({ translationText: "", basis: "explicit-empty-selection" }); h.show({ target });
  await act(async () => { await h.drafts.open(h.key); });
  act(() => { expect(h.drafts.edit(h.key, "Unconfirmed é 👩🏽‍💻")).toBe(true); });
  invoke.mockImplementation(async (command: string, { request }: { request: { decision: ReviewWrite } }) => {
    if (command === "create_execution_identity") return fixtureIdentity(9851);
    if (command === "write_review_decision") return reviewDecisionFixture(request.decision, target);
    throw new Error(command);
  });
  await waitFor(() => expect(screen.getByRole("button", { name: w("entryReviewApprove") })).toBeEnabled());
  expect(screen.getByRole("button", { name: w("entryReviewRequestChanges") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: w("entryReviewApprove") })); await screen.findByText(w("entryReviewSaved"));
  expect(calls("write_review_decision")[0][1].request.decision).toMatchObject({ unitId: target.unitId, locale: target.locale, expectedBasis: target.basis, actor: "Actual reviewer", kind: "approve", reason: "" });
  expect(h.drafts.getEntry(h.key)?.value?.text).toBe("Unconfirmed é 👩🏽‍💻");
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["create_execution_identity", "write_review_decision"]);
});

it("labels a decision on an earlier basis as outdated instead of applying its approval or change request to current content", async () => {
  const earlier = reviewTargetFixture();
  const request: ReviewWrite = { projectId: context.projectId, actionId: fixtureIdentity(9880), unitId: earlier.unitId, locale: earlier.locale,
    expectedBasis: earlier.basis, expectedDecisionId: null, actor: "Previous reviewer", kind: "approve", reason: "Earlier content" };
  const decision = reviewDecisionFixture(request, earlier);
  const current = reviewTargetFixture({ sourceRevisionId: fixtureIdentity(9881), basis: "source-or-resources-changed", currentDecision: decision });
  const h = await harness(current);
  expect(screen.getByText(w("entryReviewOutdated"))).toBeInTheDocument();
  expect(screen.queryByText(w("entryReviewApproved"))).not.toBeInTheDocument();
  expect(screen.queryByText(w("entryReviewChangesRequested"))).not.toBeInTheDocument();
  h.show({ target: { ...current, currentDecision: { ...decision, kind: "request-changes" } } });
  expect(screen.getByText(w("entryReviewOutdated"))).toBeInTheDocument();
  expect(screen.queryByText(w("entryReviewApproved"))).not.toBeInTheDocument();
  expect(screen.queryByText(w("entryReviewChangesRequested"))).not.toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();
});

it("submits audit A captured before identity, retains audit B, and rejects a stale Registry payload", async () => {
  const target = reviewTargetFixture(), h = await harness(target), user = await audit();
  const identity = deferred<string>(), write = deferred<ReturnType<typeof reviewDecisionFixture>>();
  invoke.mockImplementation((command: string) => command === "create_execution_identity" ? identity.promise : command === "write_review_decision" ? write.promise : Promise.reject(new Error(command)));
  const old = decisionPayload(h.owner(), "request-changes");
  await user.click(screen.getByRole("button", { name: w("entryReviewRequestChanges") }));
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1)); expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: w("entryReviewReason") }), { target: { value: "Reason B {name}\né 👩🏽‍💻" } });
  await user.clear(screen.getByRole("textbox", { name: w("entryReviewActor") })); await user.type(screen.getByRole("textbox", { name: w("entryReviewActor") }), "Reviewer B");
  await act(async () => identity.resolve(fixtureIdentity(9851)));
  await waitFor(() => expect(calls("write_review_decision")).toHaveLength(1));
  const original: ReviewWrite = calls("write_review_decision")[0][1].request.decision;
  expect(original).toMatchObject({ actor: "Reviewer A", reason: "Reason A", kind: "request-changes" });
  await act(async () => write.resolve(reviewDecisionFixture(original, target)));
  await screen.findByText(w("entryReviewSaved"));
  expect(screen.getByRole("textbox", { name: w("entryReviewActor") })).toHaveValue("Reviewer B");
  expect(screen.getByRole("textbox", { name: w("entryReviewReason") })).toHaveValue("Reason B {name}\né 👩🏽‍💻");
  expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
  expect(h.commands.dispatch("review.entry-request-changes", scope, old)).toBe(false); expect(calls("create_execution_identity")).toHaveLength(1);
});

it("keeps a reason on its original basis until explicit adoption of freshly read facts", async () => {
  const target = reviewTargetFixture(), h = await harness(target), user = await audit();
  const current = reviewTargetFixture({ basis: "second-basis", sourceRevisionId: fixtureIdentity(9860), selectionId: fixtureIdentity(9861), revisionId: fixtureIdentity(9862), translationText: "New selected text" });
  h.show({ target: current });
  await screen.findByText(w("entryReviewBasisChanged"));
  expect(h.owner().current().selected?.basis).toBe(target.basis); expect(h.owner().current().projection?.basis).toBe(current.basis);
  expect(screen.getByRole("textbox", { name: w("entryReviewReason") })).toHaveValue("Reason A");
  expect(screen.getByRole("button", { name: w("entryReviewApprove") })).toBeDisabled();
  const stale = decisionPayload(h.owner());
  await user.click(screen.getByRole("button", { name: w("entryReviewAdoptCurrent") }));
  await waitFor(() => expect(h.owner().current().selected?.basis).toBe(current.basis));
  expect(screen.getByRole("textbox", { name: w("entryReviewReason") })).toHaveValue("Reason A");
  expect(h.owner().current().draftTargets[reviewDraftKey(current)].basis).toBe(current.basis);
  expect(h.commands.dispatch("review.entry-approve", scope, stale)).toBe(false);
  expect(screen.getByRole("button", { name: w("entryReviewApprove") })).toBeEnabled(); expect(invoke).not.toHaveBeenCalled();
});

it("revokes a parent Query witness during identity without overwriting input or writing a review", async () => {
  const h = await harness(), user = await audit(), identity = deferred<string>();
  invoke.mockImplementation((command: string) => command === "create_execution_identity" ? identity.promise : Promise.reject(new Error(command)));
  await user.click(screen.getByRole("button", { name: w("entryReviewApprove") }));
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  act(() => { h.reads.client.removeQueries({ queryKey: h.reads.key(h.read().key), exact: true }); h.reads.client.setQueryData(h.reads.key(h.read().key), h.read().data); });
  await act(async () => identity.resolve(fixtureIdentity(9851)));
  await waitFor(() => expect(h.owner().current().busyMutation).toBe(false));
  expect(calls("write_review_decision")).toHaveLength(0); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
  expect(screen.getByRole("textbox", { name: w("entryReviewReason") })).toHaveValue("Reason A");
  expect(screen.getByText(w("entryReviewReadChanged"))).toBeInTheDocument();
});

it("recovers the original unresolved request under its shared reservation after hiding and changing the displayed target", async () => {
  const target = reviewTargetFixture(), h = await harness(target), user = await audit();
  let writes = 0, original: ReviewWrite | null = null;
  const checked = deferred<null>();
  invoke.mockImplementation(async (command: string, { request }: { request: { decision: ReviewWrite } }) => {
    if (command === "create_execution_identity") return fixtureIdentity(9851);
    if (command === "write_review_decision") {
      if (++writes === 1) { original = copy(request.decision); throw { code: "outcome-unknown", stage: "execution-adopt", outcome: "unknown", recoveryRequired: true }; }
      return reviewDecisionFixture(request.decision, target);
    }
    if (command === "read_review_decision_action") return calls(command).length === 1 ? checked.promise : null;
    throw new Error(command);
  });
  await user.click(screen.getByRole("button", { name: w("entryReviewApprove") }));
  await waitFor(() => expect(calls("read_review_decision_action")).toHaveLength(1));
  expect(screen.getByRole("button", { name: w("entryReviewRetry") })).toBeDisabled();
  await act(async () => checked.resolve(null)); await screen.findByText(w("entryReviewUnknown"));
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true); const pending = h.owner().current().pending;
  h.show({ visible: false }); expect(screen.queryByRole("textbox")).not.toBeInTheDocument(); expect(h.owner().current().pending).toBe(pending);
  const other = reviewTargetFixture({ unitId: fixtureIdentity(9870), locale: "ja", nativeKey: "other", basis: "other-entry", translationText: "別の訳文" });
  h.show({ visible: true, target: other }); await screen.findByText(w("entryReviewOtherPending"));
  await user.type(screen.getByRole("textbox", { name: w("entryReviewReason") }), "Other entry reason B");
  await user.clear(screen.getByRole("textbox", { name: w("entryReviewActor") })); await user.type(screen.getByRole("textbox", { name: w("entryReviewActor") }), "Reviewer B");
  await user.click(screen.getByRole("button", { name: w("entryReviewCheck") })); await waitFor(() => expect(calls("read_review_decision_action")).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("button", { name: w("entryReviewRetry") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: w("entryReviewRetry") })); await screen.findByText(w("entryReviewSaved"));
  expect(calls("write_review_decision").map(([, args]) => args.request.decision)).toEqual([original, original]);
  expect(calls("read_review_decision_action").map(([, args]) => args.request.decision)).toEqual([original, original]);
  expect(calls("create_execution_identity")).toHaveLength(1); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
  expect(h.owner().current().actor).toBe("Reviewer B"); expect(screen.getByRole("textbox", { name: w("entryReviewReason") })).toHaveValue("Other entry reason B");
});

it("honors explicit parent dialog ownership and IME while retaining input when hidden", async () => {
  const h = await harness(reviewTargetFixture(), "workspace-dock"), user = await audit();
  const reason = screen.getByRole("textbox", { name: w("entryReviewReason") }); act(() => reason.focus());
  expect(h.gate.getSnapshot().inputOwner?.ownerId).toBeTruthy();
  fireEvent.compositionStart(reason); fireEvent.change(reason, { target: { value: "正在输入 B" } });
  fireEvent.keyDown(reason, { key: "Enter", isComposing: true, keyCode: 229 });
  expect(screen.getByRole("button", { name: w("entryReviewApprove") })).toBeDisabled(); expect(reason).toHaveValue("正在输入 B");
  fireEvent.compositionEnd(reason); expect(screen.getByRole("button", { name: w("entryReviewApprove") })).toBeEnabled();
  let close!: () => void; act(() => { close = h.gate.pushDialog("another-dialog"); });
  expect(screen.getByRole("button", { name: w("entryReviewApprove") })).toBeDisabled(); expect(reason).toBeDisabled();
  act(() => close()); await user.click(reason); h.show({ visible: false });
  expect(h.gate.getSnapshot().inputOwner).toBeNull(); expect(h.gate.getSnapshot().composingOwners).toEqual([]);
  h.show({ visible: true }); expect(screen.getByRole("textbox", { name: w("entryReviewReason") })).toHaveValue("正在输入 B"); expect(invoke).not.toHaveBeenCalled();
});

it("restores a blurred action's focus to its result after settlement while leaving newer reason input focus alone", async () => {
  const target = reviewTargetFixture(), h = await harness(target), user = await audit();
  const first = deferred<ReturnType<typeof reviewDecisionFixture>>(), second = deferred<ReturnType<typeof reviewDecisionFixture>>();
  let identitySequence = 9890;
  invoke.mockImplementation((command: string) => command === "create_execution_identity" ? Promise.resolve(fixtureIdentity(identitySequence++))
    : command === "write_review_decision" ? calls(command).length === 1 ? first.promise : second.promise : Promise.reject(new Error(command)));
  const approve = screen.getByRole("button", { name: w("entryReviewApprove") });
  await user.click(approve); await waitFor(() => expect(calls("write_review_decision")).toHaveLength(1));
  // JSDOM keeps disabled controls focused; emulate the browser's focus loss.
  act(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex"); });
  expect(document.activeElement).toBe(document.body);
  const firstRequest: ReviewWrite = calls("write_review_decision")[0][1].request.decision;
  const receipt = { ...reviewDecisionFixture(firstRequest, target), decisionId: fixtureIdentity(9892) };
  // A receipt-driven parent refresh changes decision identity in the same view.
  h.show({ target: { ...target, currentDecision: receipt } });
  await act(async () => first.resolve(receipt));
  const result = screen.getByRole("group", { name: w("entryReviewResult") });
  await waitFor(() => expect(result).toHaveFocus()); expect(screen.getByText(w("entryReviewSaved"))).toBeInTheDocument();

  await waitFor(() => expect(approve).toBeEnabled()); await user.click(approve);
  await waitFor(() => expect(calls("write_review_decision")).toHaveLength(2));
  const reason = screen.getByRole("textbox", { name: w("entryReviewReason") }); await user.click(reason); await user.type(reason, "New reason B");
  expect(reason).toHaveFocus();
  const secondRequest: ReviewWrite = calls("write_review_decision")[1][1].request.decision;
  await act(async () => second.resolve({ ...reviewDecisionFixture(secondRequest, target), decisionId: fixtureIdentity(9893) }));
  await waitFor(() => expect(h.owner().current().busyMutation).toBe(false));
  expect(reason).toHaveFocus(); expect(reason).toHaveValue("New reason B"); expect(result).not.toHaveFocus();
});


it("requires an explicit rebind when only the source fallback record changes and keeps the reason", async () => {
  const target = reviewTargetFixture({ selectionId: null, revisionId: null, translationText: null });
  const h = await harness(target), user = await audit("Reviewer", "Reason for the previous fallback state");
  const next = { ...target, currentFallback: { fallbackId: fixtureIdentity(9896), actionId: fixtureIdentity(9897),
    unitId: target.unitId, locale: target.locale, sourceRevisionId: target.sourceRevisionId, allow: true,
    previousFallbackId: null, actor: "Another reviewer", reason: "Use the source here", createdAt: "2026-10-28T00:00:00Z", policyVersion: "balanced-1" } };
  h.show({ target: next });
  expect(h.owner().current().selected?.currentFallback).toBeNull();
  expect(screen.getByText(w("entryReviewBasisChanged"))).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: w("entryReviewAdoptCurrent") }));
  await waitFor(() => expect(h.owner().current().selected?.currentFallback?.fallbackId).toBe(next.currentFallback.fallbackId));
  expect(screen.getByRole("textbox", { name: w("entryReviewReason") })).toHaveValue("Reason for the previous fallback state");
  expect(screen.queryByText(w("entryReviewBasisChanged"))).not.toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();
});
