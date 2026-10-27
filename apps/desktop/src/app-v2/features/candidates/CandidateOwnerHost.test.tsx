import { StrictMode, useState } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../../../../test/fixtures/translation-commands.json";
import type { DraftReadView } from "../../../draftCommands";
import type { ProjectView } from "../../../projectCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import type { CandidateDecision, CandidateDecisionRequest, TranslationRevision } from "../../../translationCommands";
import type { ProtectionBasis } from "../../../WorkProtectionSession";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { TranslationDrafts } from "../editor/translationDrafts";
import CandidateOwnerHost from "./CandidateOwnerHost";
import type { CandidateOwners } from "./candidateTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "candidate-owner-session", locator: "/synthetic/candidate-owner", reconciliationState: "settled",
  metadata: { projectId: fixture.save.projectId, displayName: "Candidate fixture", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const key = { projectId: project.metadata.projectId, unitId: fixture.save.unitId, locale: "zh-CN" };
const revision: TranslationRevision = { ...fixture.receipt.revision, originKind: "ai", text: "Candidate text", candidateDecision: null };
const view: DraftReadView = { head: { key, revision: "0", writerId: null, value: null }, current: { kind: "current",
  basis: { sourceRevisionId: revision.sourceRevisionId, selectionId: null, revisionId: null, text: null }, nativeKey: "first", sourceText: "Source" } };
const rejected = { code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason: "candidate-decision" };
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
function receipt(request: CandidateDecisionRequest): CandidateDecision {
  return { request: { ...request.decision, expectedDecisionId: request.decision.expectedDecisionId ?? null,
    expectedSelectionId: request.decision.expectedSelectionId ?? null }, sourceSnapshotId: revision.sourceSnapshotId };
}
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, payload: { request: CandidateDecisionRequest }) => {
    if (command === "create_execution_identity") return fixtureIdentity(950);
    if (command === "decide_translation_candidate") return receipt(payload.request);
    if (command === "read_translation_candidate_action") return null;
    throw new Error(command);
  });
});
afterEach(cleanup);

function FeedbackHarness(props: Parameters<typeof CandidateOwnerHost>[0]) {
  const [, retain] = useState<CandidateOwners | null>(null);
  return <CandidateOwnerHost {...props} onOwners={value => { retain(value); props.onOwners(value); }}/>;
}
async function harness(strict = false) {
  const ports = { open: vi.fn(async () => project), close: vi.fn(async () => ({ closed: true })) };
  const lifecycle = new ProjectLifecycle(ports); expect(await lifecycle.open(project.locator)).toBe(true);
  const session = lifecycle.getSnapshot().session!;
  const read = vi.fn(async () => structuredClone(view));
  const drafts = new TranslationDrafts({ context: session.reads.context, reads: session.reads,
    ports: { read, list: async () => ({ items: [], next: null }), writerId: () => fixtureIdentity(951) } });
  expect(await drafts.initialize()).toBe(true); await drafts.open(key);
  lifecycle.register(drafts.lifecycleParticipant());
  let current: CandidateOwners | null = null;
  const onOwners = vi.fn((value: CandidateOwners | null) => { current = value; }), onReveal = vi.fn(), register = vi.spyOn(lifecycle, "register");
  const content = (activeProject = project) => <SessionReadProvider context={session.reads.context} reads={session.reads} bridge={false}>
    <FeedbackHarness project={activeProject} drafts={drafts} lifecycle={lifecycle} onOwners={onOwners} onReveal={onReveal}/>
  </SessionReadProvider>;
  const rendered = render(strict ? <StrictMode>{content()}</StrictMode> : content());
  await waitFor(() => expect(current).not.toBeNull());
  return { lifecycle, session, drafts, read, ports, rendered, content, onOwners, onReveal, participant: register.mock.calls.at(-1)![0],
    owners: () => { if (!current) throw new Error("Candidate owner is not mounted"); return current; } };
}
function audit(h: Awaited<ReturnType<typeof harness>>) {
  act(() => { h.owners().decisions.edit("actor", "Reviewer A"); h.owners().decisions.edit("reason", "Reason A"); });
}

it("retains one project owner without a publication loop and republishes after StrictMode effect replay", async () => {
  const h = await harness(true);
  expect(h.onOwners).toHaveBeenCalledWith(null); expect(h.onOwners).toHaveBeenLastCalledWith(h.owners());
  audit(h);
  expect(h.participant.inspect({ kind: "close-project" }).status).toBe("dirty");
  expect(h.participant.inspect({ kind: "navigate" }).status).toBe("ready");
  expect(h.participant.inspect({ kind: "language" }).status).toBe("ready");
  expect(h.participant.inspect({ kind: "close-view" }).status).toBe("ready");
  await act(async () => { expect(await h.lifecycle.close()).toBe(false); });
  expect(h.onReveal).toHaveBeenCalled(); expect(h.ports.close).not.toHaveBeenCalled();
  act(() => { expect(h.owners().decisions.discardInputs()).toBe(true); });
  expect(h.participant.inspect({ kind: "close-project" }).status).toBe("ready");
  h.rendered.unmount(); expect(h.onOwners).toHaveBeenLastCalledWith(null); h.lifecycle.dispose();
});

it("preserves unknown rejection A, newer reason B and the original same-request retry across navigation and locale removal", async () => {
  const h = await harness(); audit(h);
  let original: CandidateDecisionRequest | null = null, recorded: CandidateDecision | null = null;
  const native = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    if (command === "decide_translation_candidate") {
      original ??= structuredClone(payload.request); recorded = receipt(payload.request);
      if (calls(command).length === 1) throw new Error("Lost decision acknowledgement");
      throw rejected;
    }
    if (command === "read_translation_candidate_action") return calls(command).length > 1 ? recorded : null;
    return native(command, payload);
  });
  await act(async () => { await h.owners().decide(key, revision, "rejected", () => true); });
  const pending = structuredClone(h.owners().decisions.current().pending);
  expect(pending).toEqual(original); expect(h.owners().decisions.current().checkedMissing).toBe(true);
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  act(() => { h.owners().decisions.edit("reason", "Reason B"); });
  await act(async () => { expect(await h.lifecycle.transition({ kind: "navigate" }, () => true, () => {})).toBe(true);
    expect(await h.lifecycle.close()).toBe(false); });
  const closeLastView = vi.fn();
  await act(async () => { expect(await h.lifecycle.transition({ kind: "close-view", viewId: "last-view" }, () => true, closeLastView)).toBe(true); });
  expect(closeLastView).toHaveBeenCalledOnce();
  h.rendered.rerender(h.content({ ...project, metadata: { ...project.metadata, targetLocales: [] } }));
  expect(h.owners().decisions.current()).toMatchObject({ reason: "Reason B", pending });
  await act(async () => { await h.owners().decisions.retry(); });
  expect(h.owners().decisions.current()).toMatchObject({ pending, checkedMissing: false });
  expect(calls("decide_translation_candidate").map(([, payload]) => payload.request)).toEqual([original, original]);
  expect(calls("create_execution_identity")).toHaveLength(1);
  await act(async () => { await h.owners().decisions.check(); });
  expect(h.owners().decisions.current()).toMatchObject({ pending: null, reason: "Reason B", recorded: "rejected" });
  expect(h.owners().decisions.hasDraft()).toBe(true); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
  expect(calls("save_translation_revision")).toHaveLength(0); expect(calls("select_translation_revision")).toHaveLength(0);
  h.lifecycle.dispose();
});

it("checks the original proof after refreshing the real draft basis and does not dispatch a late decision", async () => {
  const h = await harness(); audit(h);
  const read = deferred<DraftReadView>(); h.read.mockReturnValueOnce(read.promise);
  let valid = true, deciding!: Promise<void>;
  act(() => { deciding = h.owners().decide(key, revision, "rejected", () => valid); });
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  valid = false;
  await act(async () => { read.resolve(structuredClone(view)); await deciding; });
  expect(calls("decide_translation_candidate")).toHaveLength(0);
  expect(h.drafts.getSnapshot().mutationReserved).toBe(false); expect(h.owners().decisions.current().reason).toBe("Reason A");
  h.lifecycle.dispose();
});

it("ignores a late identity after session retirement and retains audit inputs for copying", async () => {
  const h = await harness(); audit(h);
  const identity = deferred<string>(), native = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "create_execution_identity" ? identity.promise : native(command, payload));
  let deciding!: Promise<void>;
  act(() => { deciding = h.owners().decide(key, revision, "rejected", () => true); });
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  await act(async () => { h.session.reads.retire(); identity.resolve(fixtureIdentity(952)); await deciding; });
  expect(calls("decide_translation_candidate")).toHaveLength(0); expect(h.read).toHaveBeenCalledTimes(1);
  expect(h.owners().decisions.current()).toMatchObject({ actor: "Reviewer A", reason: "Reason A" }); h.lifecycle.dispose();
});

it("shares the existing mutation lock with protection and retains its original unknown request across ordinary navigation", async () => {
  const h = await harness(); audit(h);
  const native = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "set_work_protection" ? Promise.reject(new Error("Lost protection acknowledgement")) : native(command, payload));
  const basis: ProtectionBasis = { request: { ...h.session.reads.context, unitId: key.unitId, locale: key.locale,
    sourceRevisionId: revision.sourceRevisionId, selectionId: null, expectedRevision: "0" }, key: "first", sourceText: "Source", selectionText: null };
  await act(async () => { await expect(h.owners().protection.change(basis, true, () => true)).rejects.toThrow("Lost protection acknowledgement"); });
  const pending = structuredClone(h.owners().protection.current().pending);
  expect(pending?.phase).toBe("unknown"); expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  await act(async () => { await h.owners().decide(key, revision, "rejected", () => true); });
  expect(calls("decide_translation_candidate")).toHaveLength(0); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(h.participant.inspect({ kind: "navigate" }).status).toBe("ready");
  expect(h.participant.inspect({ kind: "close-window" }).status).toBe("blocked");
  expect(h.owners().protection.current().pending).toEqual(pending);
  await act(async () => { h.session.reads.retire(); await h.owners().protection.retry(() => true); });
  expect(calls("set_work_protection")).toHaveLength(1); expect(h.owners().protection.current().pending).toEqual(pending); h.lifecycle.dispose();
});
