import { useLayoutEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { ExecutionTaskProvider, type MutationCoordinator } from "../../../ExecutionTaskSession";
import { executionContext } from "../../../executionCommands";
import { i18n } from "../../../i18n";
import type { ProjectView } from "../../../projectCommands";
import { ReviewDraftProvider, reviewDraftKey, useReviewDraftSession } from "../../../ReviewDraftSession";
import type { FallbackDecision, FallbackWrite, ReviewTarget } from "../../../reviewCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { WorkbenchCommands } from "../../../workbenchCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import EntryFallbackPanel from "./EntryFallbackPanel";
import type { EntryFallbackPanelProps, EntryFallbackPayload } from "./fallbackTypes";
import type { ReviewOwner } from "./reviewTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "entry-source-fallback", locator: "/synthetic/entry-source-fallback", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(9970), displayName: "Synthetic fallback", sourceLocale: "en", targetLocales: ["zh-CN", "ja"], metadataRevision: "1" } };
const context = executionContext(project), scope = { ...context, area: "translation" as const };
type Key = "entryFallbackAllow" | "entryFallbackWithdraw" | "entryFallbackAbsent" | "entryFallbackActive" | "entryFallbackSelected" | "entryFallbackRecorded"
  | "entryFallbackUnknown" | "entryFallbackBasisChanged" | "entryFallbackEarlier" | "entryFallbackReadFailed" | "entryFallbackLoading";
const w = (key: Key) => i18n.t(`workbenchV2.${key}`), calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
const copy = <T,>(value: T): T => structuredClone(value);
const noSelection = (overrides: Partial<ReviewTarget> = {}) => reviewTargetFixture({ selectionId: null, revisionId: null, translationText: null, basis: "a".repeat(64), ...overrides });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let sequence: number;
const resources: { reads: SessionReads; drafts: TranslationDrafts; gate: InteractionGate }[] = [];
function receipt(request: FallbackWrite, target: ReviewTarget): FallbackDecision {
  return { fallbackId: fixtureIdentity(request.allow ? 9990 : 9991), actionId: request.actionId, unitId: request.unitId, locale: request.locale,
    sourceRevisionId: target.sourceRevisionId, allow: request.allow, previousFallbackId: request.expectedFallbackId ?? null,
    actor: request.actor, reason: request.reason, createdAt: "2026-10-28T00:00:00Z", policyVersion: "balanced-1" };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset(); sequence = 9975;
  invoke.mockImplementation(async (command: string) => { if (command === "create_execution_identity") return fixtureIdentity(sequence++); throw new Error(`Unexpected native request: ${command}`); });
});
afterEach(() => { cleanup(); resources.splice(0).forEach(({ reads, drafts, gate }) => { reads.retire(); drafts.retire(); gate.dispose(); }); });

async function harness(target = noSelection(), parentDialogId?: string) {
  const reads = new SessionReads(context), commands = new WorkbenchCommands(), gate = new InteractionGate(); gate.setVisibleOwner("entries");
  if (parentDialogId) gate.pushDialog(parentDialogId);
  const ports = { list: vi.fn<TranslationDraftPorts["list"]>(async () => ({ items: [], next: null })), read: vi.fn<TranslationDraftPorts["read"]>(),
    write: vi.fn<TranslationDraftPorts["write"]>(), save: vi.fn<TranslationDraftPorts["save"]>(), select: vi.fn<TranslationDraftPorts["select"]>(), writerId: () => fixtureIdentity(9971) };
  const drafts = new TranslationDrafts({ context, reads, ports }); await drafts.initialize(); resources.push({ reads, drafts, gate });
  const mutations: MutationCoordinator = { reserveMutation: () => drafts.reserveMutation("retained-for-navigation"), releaseMutation: token => drafts.releaseMutation(token) };
  let retained: ReviewOwner | null = null;
  type Presentation = Pick<EntryFallbackPanelProps, "project" | "target" | "visible" | "disabled" | "parentDialogId" | "read">;
  const readKey = (value: ReviewTarget) => ["synthetic-fallback-details", value.unitId, value.locale] as const;
  function seed(value: ReviewTarget) { const key = readKey(value); reads.client.setQueryData(reads.key(key), { target: value }); return { key, data: reads.client.getQueryData(reads.key(key)) }; }
  let presentation: Presentation = { project, target, visible: true, disabled: false, parentDialogId, read: seed(target) };
  function Content(props: Presentation) { const owner = useReviewDraftSession(); useLayoutEffect(() => { retained = owner; });
    return <EntryFallbackPanel {...props} owner={owner} drafts={drafts} commands={commands} gate={gate} viewId="entries"/>; }
  const ui = () => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
    <ExecutionTaskProvider project={presentation.project} mutations={mutations}><ReviewDraftProvider project={presentation.project} mutations={mutations}><Content {...presentation}/></ReviewDraftProvider></ExecutionTaskProvider>
  </SessionReadProvider></ApplicationReadProvider>;
  const rendered = render(ui()), owner = () => { if (!retained) throw new Error("Missing retained review owner"); return retained; };
  await waitFor(() => expect(owner().current().selected?.unitId).toBe(target.unitId));
  return { reads, drafts, ports, commands, gate, rendered, owner, read: () => presentation.read, show: (patch: Partial<Presentation>) => {
    presentation = { ...presentation, ...patch, ...(patch.target ? { read: seed(patch.target) } : {}) }; rendered.rerender(ui());
  } };
}
function setAudit(owner: ReviewOwner, target: ReviewTarget, actor = "Reviewer A", reason = "Reason A") {
  act(() => { owner.setActor(actor); owner.editReason(target, reason); });
}
function payload(owner: ReviewOwner, allow: boolean): EntryFallbackPayload {
  const state = owner.current(), target = state.selected; if (!target) throw new Error("Expected bound original review target");
  return { kind: "entry-review-fallback", unitId: target.unitId, locale: target.locale, basis: target.basis,
    sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId,
    basisEvidence: copy(target.basisEvidence), expectedFallbackId: target.currentFallback?.fallbackId ?? null, actor: state.actor,
    reason: state.drafts[reviewDraftKey(target)] ?? "", editSeq: state.editSeq[reviewDraftKey(target)] ?? 0, allow };
}

it("mounts read-only, requires the shared audit, and explicitly allows then withdraws only the current fallback", async () => {
  const target = noSelection(), h = await harness(target), user = userEvent.setup();
  expect(screen.getByText(w("entryFallbackAbsent"))).toBeInTheDocument(); expect(invoke).not.toHaveBeenCalled(); expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  setAudit(h.owner(), target, "", "Reason A"); expect(screen.getByRole("button", { name: w("entryFallbackAllow") })).toBeDisabled();
  setAudit(h.owner(), target, " Actual reviewer ", ""); expect(screen.getByRole("button", { name: w("entryFallbackAllow") })).toBeDisabled();
  const reason = "  Intentional {name}\né 👩🏽‍💻  "; setAudit(h.owner(), target, " Actual reviewer ", reason);
  invoke.mockImplementation(async (command: string, args?: { request: { fallback: FallbackWrite } }) => {
    if (command === "create_execution_identity") return fixtureIdentity(sequence++);
    if (command === "allow_source_fallback" && args) return receipt(args.request.fallback, target);
    throw new Error(command);
  });
  await user.click(screen.getByRole("button", { name: w("entryFallbackAllow") })); await screen.findByText(w("entryFallbackRecorded"));
  const original: FallbackWrite = calls("allow_source_fallback")[0][1].request.fallback;
  expect(original).toMatchObject({ unitId: target.unitId, locale: target.locale, expectedBasis: target.basis, expectedFallbackId: null, actor: "Actual reviewer", reason, allow: true });
  const fallback = receipt(original, target), current = { ...target, currentFallback: fallback }; h.show({ target: current });
  expect(screen.getByText(w("entryFallbackActive"))).toBeInTheDocument(); expect(h.rendered.container.textContent).toContain(reason);
  expect(screen.getByText("Actual reviewer", { exact: false })).toBeInTheDocument();
  setAudit(h.owner(), current, "Reviewer W", "Withdraw intentionally");
  expect(screen.getByRole("button", { name: w("entryFallbackAllow") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: w("entryFallbackWithdraw") })); await waitFor(() => expect(calls("allow_source_fallback")).toHaveLength(2));
  expect(calls("allow_source_fallback")[1][1].request.fallback).toMatchObject({ expectedFallbackId: fallback.fallbackId, actor: "Reviewer W", reason: "Withdraw intentionally", allow: false });
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["create_execution_identity", "allow_source_fallback", "create_execution_identity", "allow_source_fallback"]);
  expect(h.ports.read).not.toHaveBeenCalled(); expect(h.ports.write).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it("captures audit A before identity, preserves B after its receipt, and rejects an old typed payload", async () => {
  const target = noSelection(), h = await harness(target), user = userEvent.setup(); setAudit(h.owner(), target);
  const old = payload(h.owner(), true), identity = deferred<string>(), writing = deferred<FallbackDecision>();
  invoke.mockImplementation((command: string) => command === "create_execution_identity" ? identity.promise : command === "allow_source_fallback" ? writing.promise : Promise.reject(new Error(command)));
  await user.click(screen.getByRole("button", { name: w("entryFallbackAllow") })); await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true); setAudit(h.owner(), target, "Reviewer B", "New reason B {name}\né 👩🏽‍💻");
  await act(async () => identity.resolve(fixtureIdentity(9975))); await waitFor(() => expect(calls("allow_source_fallback")).toHaveLength(1));
  const original: FallbackWrite = calls("allow_source_fallback")[0][1].request.fallback; expect(original).toMatchObject({ actor: "Reviewer A", reason: "Reason A" });
  await act(async () => writing.resolve(receipt(original, target))); await screen.findByText(w("entryFallbackRecorded"));
  expect(h.owner().current().actor).toBe("Reviewer B"); expect(h.owner().current().drafts[reviewDraftKey(target)]).toBe("New reason B {name}\né 👩🏽‍💻");
  expect(h.drafts.getSnapshot().mutationReserved).toBe(false); expect(h.commands.dispatch("review.entry-allow-fallback", scope, old)).toBe(false);
  expect(calls("create_execution_identity")).toHaveLength(1);
});

it("rejects a replaced parent Query during identity and displays parent loading or failure without trusting old permission", async () => {
  const target = noSelection(), h = await harness(target), user = userEvent.setup(); setAudit(h.owner(), target);
  const identity = deferred<string>(); invoke.mockImplementation((command: string) => command === "create_execution_identity" ? identity.promise : Promise.reject(new Error(command)));
  await user.click(screen.getByRole("button", { name: w("entryFallbackAllow") })); await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  act(() => { h.reads.client.removeQueries({ queryKey: h.reads.key(h.read().key), exact: true }); h.reads.client.setQueryData(h.reads.key(h.read().key), h.read().data); });
  await act(async () => identity.resolve(fixtureIdentity(9975))); await waitFor(() => expect(h.owner().current().busyMutation).toBe(false));
  expect(calls("allow_source_fallback")).toHaveLength(0); expect(h.owner().current().drafts[reviewDraftKey(target)]).toBe("Reason A");
  const query = h.reads.client.getQueryCache().find({ queryKey: h.reads.key(h.read().key), exact: true }); if (!query) throw new Error("Expected exact parent query");
  act(() => query.setState({ status: "pending", fetchStatus: "fetching" })); expect(screen.getByText(w("entryFallbackLoading"))).toBeInTheDocument();
  act(() => query.setState({ status: "error", fetchStatus: "idle", error: new Error("Synthetic parent read failure") }));
  expect(screen.getByText(w("entryFallbackReadFailed"))).toBeInTheDocument(); expect(screen.getByRole("button", { name: w("entryFallbackAllow") })).toBeDisabled();
});

it("does not rebind an older reason or expired source permission without explicit basis adoption", async () => {
  const original = noSelection(), oldRequest: FallbackWrite = { projectId: context.projectId, actionId: fixtureIdentity(9991), unitId: original.unitId,
    locale: original.locale, expectedBasis: original.basis, expectedFallbackId: null, actor: "Earlier reviewer", reason: "Earlier source", allow: true };
  const target = { ...original, currentFallback: receipt(oldRequest, original) }, h = await harness(target); setAudit(h.owner(), target);
  const current = noSelection({ sourceSnapshotId: fixtureIdentity(9994), sourceRevisionId: fixtureIdentity(9992), basis: "b".repeat(64) }); h.show({ target: current });
  expect(screen.getByText(w("entryFallbackBasisChanged"))).toBeInTheDocument(); expect(screen.getByText(w("entryFallbackEarlier"))).toBeInTheDocument();
  expect(screen.getByText(w("entryFallbackAbsent"))).toBeInTheDocument(); expect(screen.queryByText(w("entryFallbackActive"))).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: w("entryFallbackAllow") })).toBeDisabled(); expect(h.owner().current().selected?.basis).toBe(target.basis);
  expect(h.owner().current().drafts[reviewDraftKey(target)]).toBe("Reason A");
  act(() => { expect(h.owner().adoptCurrent()).toBe(true); });
  expect(screen.getByRole("button", { name: w("entryFallbackAllow") })).toBeEnabled(); expect(h.owner().current().drafts[reviewDraftKey(target)]).toBe("Reason A");
  expect(invoke).not.toHaveBeenCalled();
});

it("retains the original unknown request and audit under the shared lock through hiding, locale removal, check and exact retry", async () => {
  const target = noSelection(), h = await harness(target), user = userEvent.setup(); setAudit(h.owner(), target);
  let writes = 0, lookups = 0;
  invoke.mockImplementation(async (command: string, args?: { request: { fallback: FallbackWrite } }) => {
    if (command === "create_execution_identity") return fixtureIdentity(9975);
    if (command === "allow_source_fallback" && args) { if (++writes === 1) throw new Error("Synthetic lost fallback ACK"); return receipt(args.request.fallback, target); }
    if (command === "read_review_fallback_action") { if (++lookups === 1) throw new Error("Synthetic first lookup unavailable"); return null; }
    throw new Error(command);
  });
  await user.click(screen.getByRole("button", { name: w("entryFallbackAllow") })); await screen.findByText(w("entryFallbackUnknown"));
  const pending = h.owner().current().pending; expect(pending?.kind).toBe("fallback"); expect(h.owner().current().retryAllowed).toBe(false);
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true); setAudit(h.owner(), target, "Reviewer B", "Retained reason B");
  h.show({ visible: false }); expect(h.owner().current().pending).toBe(pending); expect(screen.queryByRole("button")).not.toBeInTheDocument();
  h.show({ visible: true, target: noSelection({ unitId: fixtureIdentity(9993), locale: "ja", basis: "c".repeat(64) }),
    project: { ...project, metadata: { ...project.metadata, targetLocales: ["ja"] } } });
  await act(async () => { await h.owner().retryPending(); }); expect(writes).toBe(1);
  await act(async () => { await h.owner().checkPending(); }); expect(h.owner().current().pending).toBe(pending); expect(h.owner().current().retryAllowed).toBe(true);
  await act(async () => { await h.owner().retryPending(); }); expect(h.owner().current().pending).toBeNull(); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
  const requests = calls("allow_source_fallback").map(([, args]) => args.request);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(calls("read_review_fallback_action").map(([, args]) => args.request)).toEqual([requests[0], requests[0]]); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(h.owner().current().actor).toBe("Reviewer B"); expect(h.owner().current().drafts[reviewDraftKey(target)]).toBe("Retained reason B");
  expect(h.ports.write).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it("treats a selected empty string as selected and honors locale, IME and parent dialog gates", async () => {
  const target = noSelection(), h = await harness(target, "workspace-dock"); setAudit(h.owner(), target);
  const allow = () => screen.getByRole("button", { name: w("entryFallbackAllow") }); expect(allow()).toBeEnabled();
  act(() => h.gate.setComposing("review-reason", true)); expect(allow()).toBeDisabled(); act(() => h.gate.setComposing("review-reason", false));
  let close!: () => void; act(() => { close = h.gate.pushDialog("another-dialog"); }); expect(allow()).toBeDisabled(); act(() => close());
  h.show({ target: reviewTargetFixture({ translationText: "", basis: "d".repeat(64) }) });
  expect(screen.getByText(w("entryFallbackSelected"))).toBeInTheDocument(); expect(allow()).toBeDisabled(); expect(screen.getByRole("button", { name: w("entryFallbackWithdraw") })).toBeDisabled();
  h.show({ target, project: { ...project, metadata: { ...project.metadata, targetLocales: ["ja"] } } }); expect(allow()).toBeDisabled();
  expect(h.owner().current().drafts[reviewDraftKey(target)]).toBe("Reason A"); expect(invoke).not.toHaveBeenCalled();
});
