import { StrictMode, useLayoutEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { SessionReadProvider } from "./SessionReadProvider";
import { SessionReads } from "./sessionReads";
import { StrategyDraftSession, useStrategyDraftSession, type StrategyOwner, type StrategyTranslationMutation } from "./StrategyDraftSession";
import { strategyDraftCommands, type StrategyDraftHead } from "./strategyDraftCommands";
import { strategyCommands, type ContextStrategyCandidate } from "./strategyCommands";
import { executionCommands } from "./executionCommands";
import { reviewCommands } from "./reviewCommands";
import { resourceCommands, type CorrectionTermEvidence } from "./resourceCommands";
import { defaultAiConfig } from "./aiCommands";
import type { ProjectView } from "./projectCommands";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import { strategyDraftActionFixture, strategyDraftHeadFixture } from "./testSupport/strategyDraftFixture";
import resourceWire from "../test/fixtures/resourceCommands.contract.json";
import reviewWire from "../test/fixtures/reviewCommands.contract.json";
import { validateResponseCorrectionBasis } from "./generated/resource.validators";
import { validateResponseEditor } from "./generated/review.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let owner: StrategyOwner, head: StrategyDraftHead, evidence: CorrectionTermEvidence;
const project: ProjectView = { sessionToken: "isolated-strategy-session", locator: "synthetic", reconciliationState: "settled",
  metadata: { projectId: resourceWire.responses.correctionBasis.basis.projectId, displayName: "Synthetic strategy persistence", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const context = { sessionToken: project.sessionToken, projectId: project.metadata.projectId };
const translation: StrategyTranslationMutation = { mutationReserved: false, reserveMutation: () => Symbol("synthetic entry reservation"), releaseMutation: () => {} };
const disposals: (() => void)[] = [];
function Probe() { const current = useStrategyDraftSession(); useLayoutEffect(() => { owner = current; }); return null; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function mount(sessionToken = project.sessionToken) {
  const current = { ...project, sessionToken }, reads = new SessionReads({ ...context, sessionToken });
  const rendered = render(<StrictMode><ApplicationReadProvider><SessionReadProvider context={{ ...context, sessionToken }} reads={reads} bridge={false}>
    <StrategyDraftSession project={current} translationMutation={translation}><Probe/></StrategyDraftSession>
  </SessionReadProvider></ApplicationReadProvider></StrictMode>);
  disposals.push(() => { rendered.unmount(); reads.retire(); });
  await waitFor(() => expect(owner.hydrating).toBe(false));
  return rendered;
}
function captured(request: Parameters<typeof strategyCommands.capture>[0]): ContextStrategyCandidate {
  return { candidateId: request.capture.actionId, projectId: context.projectId, locale: "zh-CN", evidence: { ...structuredClone(evidence), basis: request.capture.basis },
    sourceContext: request.capture.sourceContext, reason: request.capture.reason, exceptions: request.capture.exceptions, digest: "a".repeat(64) };
}
async function correction() {
  act(() => owner.edit("correctionUnit", evidence.basis.unitId)); await act(async () => { await owner.flush(); });
  await act(async () => { await owner.inspectCorrection(); });
  act(() => { owner.edit("sourceContext", { ...defaultAiConfig.sourceContext, extracted: true }); owner.edit("reason", "Original A {{name}} 中文"); owner.edit("exceptions", "This project and language only."); });
  await act(async () => { await owner.flush(); });
}
beforeEach(() => {
  vi.restoreAllMocks(); invoke.mockReset(); invoke.mockRejectedValue(new Error("Unexpected native or external request"));
  const source: unknown = structuredClone(resourceWire.responses.correctionBasis);
  if (!validateResponseCorrectionBasis(source)) throw new Error("Invalid synthetic correction evidence"); evidence = source;
  const editor: unknown = structuredClone(reviewWire.responses.editor);
  if (!validateResponseEditor(editor) || !editor.translations.current) throw new Error("Invalid synthetic saved correction");
  editor.target.unitId = evidence.basis.unitId; editor.target.sourceRevisionId = evidence.basis.sourceRevisionId;
  editor.translations.current.eventId = evidence.basis.after.selectionId; editor.translations.current.revisionId = evidence.basis.after.revisionId;
  editor.translations.current.previousEventId = evidence.basis.before.selectionId;
  vi.spyOn(reviewCommands, "editorSnapshot").mockResolvedValue(editor); vi.spyOn(resourceCommands, "correctionBasis").mockResolvedValue(evidence);
  vi.spyOn(SessionReads.prototype, "synchronizeFresh").mockResolvedValue(undefined);
  head = { key: { projectId: context.projectId }, revision: "0", writerId: null, value: null };
  vi.spyOn(strategyDraftCommands, "read").mockImplementation(async () => structuredClone(head));
  const commit = (write: Parameters<typeof strategyDraftCommands.write>[0]["write"]) => {
    expect(write.expectedRevision).toBe(head.revision);
    head = strategyDraftHeadFixture({ key: write.key, revision: String(BigInt(head.revision) + 1n), writerId: write.writerId, value: structuredClone(write.value) });
    return structuredClone(head);
  };
  vi.spyOn(strategyDraftCommands, "write").mockImplementation(async request => {
    if (head.value?.pending) expect(request.write.value.pending).toEqual(head.value.pending);
    return commit(request.write);
  });
  vi.spyOn(strategyDraftCommands, "resolve").mockImplementation(async request => {
    expect(request.resolve.pending).toEqual(head.value?.pending); expect(request.resolve.write.value.pending).toBeNull();
    return commit(request.resolve.write);
  });
  let identity = 69100; vi.spyOn(executionCommands, "identity").mockImplementation(async () => id(identity++));
  vi.spyOn(strategyCommands, "capture").mockImplementation(async request => captured(request));
  vi.spyOn(strategyCommands, "action").mockResolvedValue(null);
  vi.spyOn(strategyDraftCommands, "action").mockImplementation(async request => strategyDraftActionFixture({ pending: structuredClone(request.pending), disposition: null }));
});
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });

describe("Strategy owner in the shared local journal", () => {
  it("restores incomplete input and independent judgments without a legacy translation owner or execution consent", async () => {
    const rendered = await mount();
    const selected = captured({ ...context, capture: { actionId: id(69195), basis: evidence.basis, sourceContext: defaultAiConfig.sourceContext, reason: "Selected historical candidate", exceptions: "Same locale" } });
    act(() => { expect(owner.chooseCandidate(selected)).toBe(true); expect(owner.selectEvaluation(id(69196))).toBe(true); });
    await act(async () => { await owner.flush(); });
    act(() => {
      owner.edit("reason", "Unfinished {{name}} 中文"); owner.edit("exceptions", "");
      owner.edit("config", { ...defaultAiConfig, endpoint: "", model: "", maxRequests: 0 });
      owner.edit("roles", { [id(69190)]: "holdout" });
      owner.editJudgment(id(69191), { preference: "equivalent", notes: "Independent judgment B", elapsed: "1e", modified: "unfinished" });
      owner.editJudgment(id(69191), { notes: "Independent judgment C" });
    });
    const version = owner.journalSeq; await act(async () => { expect(await owner.flush()).toBe(true); });
    expect(owner.journalSeq).toBe(version); expect(owner.journalDirty).toBe(false); expect(owner.blocked()).toBe(false);
    const original = structuredClone(head.value);
    expect(original).not.toHaveProperty("prepared"); expect(original).not.toHaveProperty("consent"); expect(original).not.toHaveProperty("check");
    rendered.unmount(); await mount("reopened-local-strategy");
    expect(owner.state.reason).toBe("Unfinished {{name}} 中文"); expect(owner.state.config.endpoint).toBe("");
    expect(owner.state.candidate).toEqual(selected); expect(owner.state.evaluationId).toBe(id(69196));
    expect(owner.state.roles).toEqual({ [id(69190)]: "holdout" });
    expect(owner.state.judgments[id(69191)]).toMatchObject({ notes: "Independent judgment C", elapsed: "1e", modified: "unfinished", editSeq: 2, savedSeq: 0 });
    expect(owner.state.prepared).toBeNull(); expect(owner.state.check).toBeNull(); expect(owner.state.consent).toBe(false);
    expect(owner.state.checkerConsent).toEqual([]); expect(owner.state.stale).toBe(true);
    expect(strategyCommands.capture).not.toHaveBeenCalled(); expect(strategyCommands.action).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });

  it("waits for the pending ACK before dispatch and preserves B across the original A receipt", async () => {
    await mount(); await correction();
    const entered = deferred<void>(), acknowledge = deferred<void>(), business = deferred<ContextStrategyCandidate>();
    const write = vi.mocked(strategyDraftCommands.write).getMockImplementation()!;
    vi.mocked(strategyDraftCommands.write).mockImplementation(async request => {
      const result = await write(request);
      if (request.write.value.pending?.kind === "candidate") { entered.resolve(); await acknowledge.promise; }
      return result;
    });
    vi.mocked(strategyCommands.capture).mockReturnValueOnce(business.promise);
    let saving!: Promise<void>; act(() => { saving = owner.capture(); }); await entered.promise;
    expect(strategyCommands.capture).not.toHaveBeenCalled(); expect(head.value?.pending?.kind).toBe("candidate");
    expect(head.value?.pending?.request).not.toHaveProperty("sessionToken");
    await act(async () => { acknowledge.resolve(); }); await waitFor(() => expect(strategyCommands.capture).toHaveBeenCalledOnce());
    const request = vi.mocked(strategyCommands.capture).mock.calls[0][0];
    expect(owner.getDecisionActivity().actions).toEqual([{ key: { kind: "strategy" }, slot: "strategy", actionId: request.capture.actionId, submittedSeq: head.value?.pending?.submittedSeq }]);
    act(() => owner.edit("reason", "Newer B must remain"));
    await waitFor(() => expect(head.value?.reason).toBe("Newer B must remain"));
    await act(async () => { business.resolve(captured(request)); await saving; await owner.flush(); });
    expect(owner.state.reason).toBe("Newer B must remain"); expect(owner.dirty()).toBe(true); expect(owner.state.candidate).toBeNull();
    expect(owner.state.pending).toBeNull(); expect(head.value?.reason).toBe("Newer B must remain"); expect(head.value?.pending).toBeNull();
    expect(owner.getDecisionActivity().actions).toEqual([]);
  });

  it("closes a reopened original start through the trusted drain proof before allowing a fresh draft", async () => {
    const rendered = await mount();
    act(() => owner.edit("reason", "Retained local input")); await act(async () => { await owner.flush(); });
    if (!head.value) throw new Error("Original local strategy input required");
    const pending = { kind: "start" as const, editSeq: head.value.editSeq, submittedSeq: head.value.journalSeq,
      request: { projectId: context.projectId, evaluationId: id(69196), attemptId: id(69197), digest: "d".repeat(64), confirmed: true } };
    head.value.pending = pending;
    rendered.unmount(); await mount("reopened-original-start");
    const start = vi.spyOn(strategyCommands, "start"), read = vi.spyOn(strategyCommands, "startAction").mockResolvedValue(null);
    expect(owner.pendingIdentity()).toEqual({ actionId: pending.request.attemptId, submittedSeq: pending.submittedSeq });
    expect(owner.state.prepared).toBeNull(); expect(owner.state.consent).toBe(false);
    await act(async () => { await owner.reconcile(); await owner.flush(); });
    expect(read).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled(); expect(owner.state.pending).not.toBeNull();
    expect(owner.blocked()).toBe(false);
    const close = vi.spyOn(strategyDraftCommands, "close").mockResolvedValue({ pending, disposition: "confirmed-not-applied" });
    await act(async () => { await owner.closePending(); await owner.flush(); });
    expect(close).toHaveBeenCalledWith({ sessionToken: "reopened-original-start", key: { projectId: context.projectId }, pending });
    expect(owner.state.pending).toBeNull(); expect(owner.state.reason).toBe("Retained local input"); expect(start).not.toHaveBeenCalled();
    act(() => expect(owner.reset()).toBe(true)); await act(async () => { await owner.flush(); });
    expect(owner.state.reason).toBe(""); expect(owner.blocked()).toBe(false);
  });

  it("reopens an unknown original request without lookup or replay and settles only its exact receipt", async () => {
    const rendered = await mount(); await correction();
    vi.mocked(strategyCommands.capture).mockRejectedValueOnce({ code: "storage-failed", outcome: "unknown", reason: "synthetic-lost-strategy-ack" });
    await act(async () => { await owner.capture(); await owner.flush(); });
    const original = structuredClone(head.value?.pending); if (original?.kind !== "candidate") throw new Error("Original candidate pending required");
    const previousReads = vi.mocked(strategyCommands.action).mock.calls.length;
    expect(owner.blocked()).toBe(false); rendered.unmount(); await mount("reopened-unknown-strategy");
    expect(owner.state.pending).toMatchObject({ kind: "candidate", uncertain: true, retryAllowed: false });
    expect(strategyCommands.action).toHaveBeenCalledTimes(previousReads); expect(strategyCommands.capture).toHaveBeenCalledOnce();
    const request = { ...original.request, sessionToken: "reopened-unknown-strategy" }, candidate = captured(request);
    vi.mocked(strategyCommands.action).mockResolvedValueOnce({ kind: "candidate", request: original.request.capture, candidate });
    vi.spyOn(strategyCommands, "candidate").mockResolvedValue(candidate);
    await act(async () => { await owner.reconcile(); await owner.flush(); });
    expect(owner.state.pending).toBeNull(); expect(owner.state.candidate).toEqual(candidate);
    expect(strategyCommands.capture).toHaveBeenCalledOnce(); expect(head.value?.pending).toBeNull();
  });
});
