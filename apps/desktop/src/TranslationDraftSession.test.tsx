import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/translation-commands.json";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useTranslationImportSession } from "./TranslationImportSession";
import { useSessionReads } from "./SessionReadProvider";
import { isCommandError, hasUnknownOutcome, type CommandError, type ProjectView } from "./projectCommands";
import type { TranslationRevision, TranslationSelectRequest, TranslationSelection, CandidateDecision, CandidateDecisionRequest } from "./translationCommands";
import { validateResponseCandidateAction } from "./generated/translation.validators";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { ...fixture.start, locator: "C:\\isolated\\selection-owner", reconciliationState: "settled",
  metadata: { projectId: fixture.start.projectId, displayName: "Fixture", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const candidate: TranslationRevision = { ...fixture.receipt.revision, originKind: "manual", text: "Candidate", revisionId: fixtureIdentity(701) };
let drafts: ReturnType<typeof useTranslationDraftSession>, imports: ReturnType<typeof useTranslationImportSession>, reads: ReturnType<typeof useSessionReads>;
let originalRequest: TranslationSelectRequest | null, selected: TranslationSelection | null;
function Probe() {
  const value = useTranslationDraftSession(), owner = useTranslationImportSession(), reader = useSessionReads();
  useLayoutEffect(() => { drafts = value; imports = owner; reads = reader; });
  return <output aria-label="Selection draft">{value.draft?.text}</output>;
}
function selection(request: TranslationSelectRequest): TranslationSelection {
  return { actionId: request.actionId, unitId: request.unitId, locale: request.locale, revisionId: request.revisionId,
    eventId: fixtureIdentity(702), sequence: "1", previousEventId: request.expectedSelectionId ?? null };
}
function calls(name: string) { return invoke.mock.calls.filter(([command]) => command === name); }
function mutationRejection(): CommandError {
  // ExecutionHost.allow_mutation rejects a quiescing host before any write.
  const failure: CommandError = { code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false };
  expect(isCommandError(failure)).toBe(true); expect(hasUnknownOutcome(failure)).toBe(false);
  return failure;
}
function unknownDecisionFailure(): CommandError {
  const failure: CommandError = { code: "outcome-unknown", stage: "execution-adopt", outcome: "unknown", recoveryRequired: true,
    reason: "candidate-decision", diagnosticId: fixtureIdentity(715) };
  expect(isCommandError(failure)).toBe(true); expect(hasUnknownOutcome(failure)).toBe(true);
  return failure;
}
beforeEach(() => {
  invoke.mockReset(); originalRequest = null; selected = null;
  invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: fixture.start.expectedSourceSnapshotId };
    if (command === "create_execution_identity") return fixtureIdentity(700);
    if (command === "select_translation_revision") { originalRequest = payload.request as unknown as TranslationSelectRequest; selected = selection(originalRequest); return selected; }
    if (command === "read_translation_action") return selected;
    throw new Error(command);
  });
});
afterEach(cleanup);

it("preserves an unknown selection and newer B after an explicit same-request retry is definitely rejected",async()=>{
  render(<Probe/>,project);begin();const original=invoke.getMockImplementation()!,rejected=mutationRejection();
  invoke.mockImplementation((command:string,payload)=>command==="select_translation_revision" ? Promise.reject(new Error("Lost ACK"))
    : command==="read_translation_action" ? Promise.resolve(null) : original(command,payload));
  await act(async()=>{await drafts.selectRevision(candidate);});const request=structuredClone(drafts.current()!.pendingSelection!.request);
  act(()=>drafts.edit("Newer B"));await act(async()=>{await drafts.checkSelection();});expect(drafts.current()?.pendingSelection?.receiptChecked).toBe(true);
  invoke.mockImplementation((command:string,payload)=>command==="select_translation_revision" ? Promise.reject(rejected) : original(command,payload));
  await act(async()=>{expect(await drafts.retrySelection()).toBe(false);});
  expect(drafts.current()).toMatchObject({text:"Newer B",outcomeUnknown:true,pendingSelection:{request,receiptChecked:false}});
  expect(drafts.mutationReserved).toBe(true);expect(calls("select_translation_revision").map(([,args])=>args.request)).toEqual([request,request]);
  expect(calls("create_execution_identity")).toHaveLength(1);await act(async()=>{await drafts.retrySelection();});expect(calls("select_translation_revision")).toHaveLength(2);
});

it("releases a first definite selection rejection and its captured read listener",async()=>{
  render(<Probe/>,project);begin();const original=invoke.getMockImplementation()!,dispose=vi.fn(),rejected=mutationRejection();
  invoke.mockImplementation((command:string,payload)=>command==="select_translation_revision" ? Promise.reject(rejected) : original(command,payload));
  await act(async()=>{expect(await drafts.selectRevision(candidate,()=>true,dispose)).toBe(false);});
  expect(drafts.current()?.pendingSelection).toBeNull();expect(drafts.current()?.outcomeUnknown).toBe(false);expect(drafts.mutationReserved).toBe(false);expect(dispose).toHaveBeenCalledTimes(1);
});
function begin() {
  act(() => drafts.begin({ unitId: candidate.unitId, locale: candidate.locale, sourceRevisionId: candidate.sourceRevisionId,
    key: "key", sourceText: "Original" }, null, null));
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function decisionReceipt(request: CandidateDecisionRequest): CandidateDecision {
  return { request: { ...structuredClone(request.decision), expectedDecisionId: request.decision.expectedDecisionId ?? null,
    expectedSelectionId: request.decision.expectedSelectionId ?? null }, sourceSnapshotId: fixture.start.expectedSourceSnapshotId };
}
function prepareCandidateDecision() {
  const view = render(<Probe/>, project); begin();
  act(() => { drafts.candidates.edit("actor", "Reviewer A"); drafts.candidates.edit("reason", "Reason A"); });
  return view;
}
const aiCandidate: TranslationRevision = { ...candidate, originKind: "ai", candidateDecision: null };

it("holds the synchronous translation reservation through one automatic candidate lookup and settles only A after consumer removal", async () => {
  const view = prepareCandidateDecision(), original = invoke.getMockImplementation()!, writeFailure = unknownDecisionFailure();
  const identity = deferred<string>(), lookup = deferred<CandidateDecision | null>();
  let written!: CandidateDecisionRequest;
  invoke.mockImplementation((command: string, args) => {
    if (command === "create_execution_identity") return identity.promise;
    if (command === "decide_translation_candidate") { written = args.request; return Promise.reject(writeFailure); }
    if (command === "read_translation_candidate_action") return lookup.promise;
    return original(command, args);
  });
  let running!: Promise<void>;
  act(() => { running = drafts.candidates.decide(aiCandidate, "rejected"); void drafts.candidates.decide(aiCandidate, "rejected"); });
  expect(drafts.mutationReserved).toBe(true); expect(drafts.reserveMutation()).toBeNull();
  await act(async () => { expect((await drafts.save()).saved).toBe(false); expect(await drafts.selectRevision(candidate)).toBe(false); });
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("decide_translation_candidate")).toHaveLength(0);
  await act(async () => { identity.resolve(fixtureIdentity(710)); });
  await waitFor(() => expect(calls("read_translation_candidate_action")).toHaveLength(1));
  expect(drafts.candidates.current()).toMatchObject({ busy: true, checking: true, pending: written, failure: null });
  act(() => { drafts.candidates.edit("actor", "Reviewer B"); drafts.candidates.edit("reason", "Reason B"); drafts.edit("Manual B"); });
  await act(async () => { await drafts.candidates.check(); await drafts.candidates.retry(); await drafts.candidates.decide(aiCandidate, "rejected"); });
  expect(calls("decide_translation_candidate")).toHaveLength(1); expect(calls("read_translation_candidate_action")).toHaveLength(1);
  expect(calls("read_translation_candidate_action")[0][1].request).toEqual({ projectId: project.metadata.projectId, sessionToken: project.sessionToken,
    actionId: written.decision.actionId, unitId: written.decision.unitId, locale: written.decision.locale });
  view.rerender(null);
  await act(async () => { lookup.resolve(decisionReceipt(written)); await running; });
  view.rerender(<Probe/>);
  expect(drafts.candidates.current()).toMatchObject({ actor: "Reviewer B", reason: "Reason B", busy: false, checking: false,
    pending: null, checkedMissing: false, failure: null, recorded: "rejected" });
  expect(drafts.candidates.hasDraft()).toBe(true); expect(drafts.current()?.text).toBe("Manual B"); expect(drafts.mutationReserved).toBe(false);
  expect(written.decision).toMatchObject({ actor: "Reviewer A", reason: "Reason A" });
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("decide_translation_candidate")).toHaveLength(1);
  expect(calls("read_translation_candidate_action")).toHaveLength(1); expect(calls("save_translation_revision")).toHaveLength(0);
  expect(calls("select_translation_revision")).toHaveLength(0);
});

it.each(["projectId", "actionId", "unitId", "locale", "revisionId", "sourceRevisionId", "expectedSelectionId", "expectedDecisionId", "disposition", "actor", "reason"] as const)("retains the complete original candidate request after a typed-valid wrong %s lookup", async field => {
  prepareCandidateDecision(); const original = invoke.getMockImplementation()!;
  let written!: CandidateDecisionRequest;
  invoke.mockImplementation((command: string, args) => {
    if (command === "decide_translation_candidate") { written = args.request; return Promise.reject(new Error("Lost decision acknowledgement")); }
    if (command === "read_translation_candidate_action") {
      const wrong = decisionReceipt(written);
      if (field === "disposition") wrong.request.disposition = "restored";
      else if (field === "locale") wrong.request.locale = "fr-FR";
      else if (field === "actor" || field === "reason") wrong.request[field] = "Different human input";
      else wrong.request[field] = fixtureIdentity(799);
      expect(validateResponseCandidateAction(wrong)).toBe(true);
      return Promise.resolve(wrong);
    }
    return original(command, args);
  });
  await act(async () => { await drafts.candidates.decide(aiCandidate, "rejected"); });
  expect(drafts.candidates.current()).toMatchObject({ pending: written, busy: false, checking: false, checkedMissing: false,
    recorded: null, failure: "invalid-candidate-decision-receipt", actor: "Reviewer A", reason: "Reason A" });
  expect(drafts.mutationReserved).toBe(true); expect(drafts.reserveMutation()).toBeNull();
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("decide_translation_candidate")).toHaveLength(1);
  expect(calls("read_translation_candidate_action")).toHaveLength(1);
});

it("recovers an invalid candidate write acknowledgement from one exact saved action without repeating the decision", async () => {
  prepareCandidateDecision(); const original = invoke.getMockImplementation()!;
  let receipt!: CandidateDecision;
  invoke.mockImplementation((command: string, args) => {
    if (command === "decide_translation_candidate") { receipt = decisionReceipt(args.request); return Promise.resolve({ ...receipt, request: { ...receipt.request, reason: "Wrong reason" } }); }
    if (command === "read_translation_candidate_action") return Promise.resolve(receipt);
    return original(command, args);
  });
  await act(async () => { await drafts.candidates.decide(aiCandidate, "rejected"); });
  expect(drafts.candidates.current()).toMatchObject({ pending: null, recorded: "rejected", busy: false, checking: false, failure: null });
  expect(drafts.candidates.hasDraft()).toBe(false); expect(drafts.mutationReserved).toBe(false);
  expect(calls("decide_translation_candidate")).toHaveLength(1); expect(calls("read_translation_candidate_action")).toHaveLength(1);
});

it("opens only an explicit same-request retry after an automatic missing-action check and keeps a later unknown retry reserved", async () => {
  prepareCandidateDecision(); const original = invoke.getMockImplementation()!, writeFailure = unknownDecisionFailure();
  let receipt: CandidateDecision | null = null, writes = 0, lookups = 0;
  invoke.mockImplementation((command: string, args) => {
    if (command === "decide_translation_candidate") { if (++writes === 2) receipt = decisionReceipt(args.request); return Promise.reject(writeFailure); }
    if (command === "read_translation_candidate_action") {
      lookups++; if (lookups === 1) return Promise.resolve(null);
      return lookups === 2 ? Promise.reject(Object.assign(new Error("Saved action temporarily unavailable"), { reason: "candidate-lookup-unavailable" })) : Promise.resolve(receipt);
    }
    return original(command, args);
  });
  await act(async () => { await drafts.candidates.decide(aiCandidate, "rejected"); });
  const request = drafts.candidates.current().pending;
  expect(drafts.candidates.current()).toMatchObject({ pending: request, checkedMissing: true, checking: false, failure: writeFailure });
  expect(drafts.candidates.current().failure).toBe(writeFailure);
  expect(writes).toBe(1); expect(lookups).toBe(1); expect(drafts.mutationReserved).toBe(true);
  act(() => drafts.candidates.edit("reason", "Newer reason B"));
  await act(async () => { await drafts.candidates.retry(); await drafts.candidates.retry(); });
  expect(drafts.candidates.current()).toMatchObject({ pending: request, checkedMissing: false, busy: false, checking: false,
    reason: "Newer reason B", failure: "candidate-lookup-unavailable" });
  expect(writes).toBe(2); expect(lookups).toBe(2); expect(drafts.mutationReserved).toBe(true);
  await act(async () => { await drafts.candidates.check(); });
  expect(drafts.candidates.current()).toMatchObject({ pending: null, recorded: "rejected", reason: "Newer reason B", failure: null });
  expect(drafts.candidates.hasDraft()).toBe(true); expect(drafts.mutationReserved).toBe(false);
  expect(calls("decide_translation_candidate").map(([,args]) => args.request)).toEqual([request, request]);
  expect(calls("create_execution_identity")).toHaveLength(1); expect(lookups).toBe(3);
});

it("releases a first definite candidate rejection without reading an action", async () => {
  prepareCandidateDecision(); const original = invoke.getMockImplementation()!, rejected = mutationRejection();
  invoke.mockImplementation((command: string, args) => command === "decide_translation_candidate" ? Promise.reject(rejected) : original(command, args));
  await act(async () => { await drafts.candidates.decide(aiCandidate, "rejected"); });
  expect(drafts.candidates.current()).toMatchObject({ pending: null, busy: false, checking: false, checkedMissing: false, failure: rejected });
  expect(drafts.mutationReserved).toBe(false); expect(drafts.candidates.hasDraft()).toBe(true);
  expect(calls("decide_translation_candidate")).toHaveLength(1); expect(calls("read_translation_candidate_action")).toHaveLength(0);
});

it.each(["before lookup", "during lookup"] as const)("does not continue an old candidate decision when its owner retires %s", async retirement => {
  prepareCandidateDecision(); const original = invoke.getMockImplementation()!;
  const write = deferred<CandidateDecision>(), lookup = deferred<CandidateDecision | null>();
  let written!: CandidateDecisionRequest;
  invoke.mockImplementation((command: string, args) => {
    if (command === "decide_translation_candidate") { written = args.request; return write.promise; }
    if (command === "read_translation_candidate_action") return lookup.promise;
    return original(command, args);
  });
  let running!: Promise<void>; act(() => { running = drafts.candidates.decide(aiCandidate, "rejected"); });
  await waitFor(() => expect(calls("decide_translation_candidate")).toHaveLength(1));
  if (retirement === "during lookup") {
    await act(async () => { write.reject(new Error("Lost decision acknowledgement")); });
    await waitFor(() => expect(calls("read_translation_candidate_action")).toHaveLength(1));
  }
  const before = drafts.candidates.current(); act(() => reads.retire());
  await act(async () => {
    if (retirement === "before lookup") write.reject(new Error("Late acknowledgement lost"));
    else lookup.resolve(decisionReceipt(written));
    await running;
  });
  expect(drafts.candidates.current()).toBe(before);
  expect(calls("read_translation_candidate_action")).toHaveLength(retirement === "before lookup" ? 0 : 1);
  expect(calls("decide_translation_candidate")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("save_translation_revision")).toHaveLength(0); expect(calls("select_translation_revision")).toHaveLength(0);
});

it("settles an original selection after consumer removal without overwriting newer B or reading history", async () => {
  const view = render(<Probe/>, project); begin();
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string, payload: { request: TranslationSelectRequest }) => {
    if (command !== "select_translation_revision") return original(command, payload);
    originalRequest = payload.request; return new Promise(resolve => { finish = resolve; });
  });
  let pending!: Promise<boolean>; act(() => { pending = drafts.selectRevision(candidate); });
  await waitFor(() => expect(finish).toBeDefined());
  act(() => drafts.edit("Newer B")); view.rerender(null);
  await act(async () => { finish(selection(originalRequest!)); expect(await pending).toBe(true); });
  view.rerender(<Probe/>);
  expect(screen.getByLabelText("Selection draft")).toHaveTextContent("Newer B");
  expect(drafts.current()).toMatchObject({ baseText: "Candidate", baseRevisionId: candidate.revisionId, newerDraftSaved: true, pendingSelection: null });
  expect(calls("read_translation_history")).toHaveLength(0);
  expect(drafts.mutationReserved).toBe(false);
});

it("keeps an unknown original selection reserved and checks it after its locale and source change", async () => {
  const view = render(<Probe/>, project); begin();
  const original = invoke.getMockImplementation()!; let lost = true;
  invoke.mockImplementation(async (command: string, payload: { request: TranslationSelectRequest }) => {
    const result = await original(command, payload);
    if (command === "select_translation_revision" && lost) { lost = false; throw new Error("Lost ACK"); }
    return result;
  });
  await act(async () => { expect(await drafts.selectRevision(candidate)).toBe(false); });
  const request = structuredClone(drafts.current()!.pendingSelection!.request);
  act(() => { drafts.edit("Newer B"); drafts.clear(); });
  expect(drafts.current()?.pendingSelection).not.toBeNull();
  expect(drafts.reserveMutation()).toBeNull();
  view.rerender(null, { ...project, metadata: { ...project.metadata, targetLocales: [], sourceLocale: "fr" } });
  await act(async () => { expect(await drafts.checkSelection()).toBe(true); });
  view.rerender(<Probe/>);
  expect(calls("select_translation_revision").map(([, args]) => args.request)).toEqual([request, request]);
  expect(calls("read_translation_action")[0][1].request).toEqual({ projectId: request.projectId, sessionToken: request.sessionToken,
    actionId: request.actionId, unitId: request.unitId, locale: request.locale });
  expect(drafts.current()?.text).toBe("Newer B"); expect(drafts.mutationReserved).toBe(false);
});

it("requires a missing-action check before exact selection retry and revokes it on another unknown", async () => {
  render(<Probe/>, project); begin();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: TranslationSelectRequest }) => {
    if (command === "select_translation_revision") { originalRequest = payload.request; return Promise.reject(new Error("Disconnected")); }
    return original(command, payload);
  });
  await act(async () => { await drafts.selectRevision(candidate); await drafts.retrySelection(); });
  expect(calls("select_translation_revision")).toHaveLength(1);
  await act(async () => { await drafts.checkSelection(); await drafts.retrySelection(); });
  expect(calls("select_translation_revision").map(([, args]) => args.request)).toEqual([originalRequest, originalRequest]);
  expect(drafts.current()?.pendingSelection?.receiptChecked).toBe(false);
  await act(async () => { await drafts.retrySelection(); });
  expect(calls("select_translation_revision")).toHaveLength(2);
});

it.each(["action", "unit", "locale", "revision", "previous selection", "zero sequence"])("retains a typed-valid wrong selection %s as unknown", async field => {
  render(<Probe/>, project); begin();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: TranslationSelectRequest }) => {
    if (command !== "select_translation_revision") return original(command, payload);
    const ack = selection(payload.request);
    const patch: Partial<TranslationSelection> = field === "action" ? { actionId: fixtureIdentity(99) } : field === "unit" ? { unitId: fixtureIdentity(99) }
      : field === "locale" ? { locale: "fr" } : field === "revision" ? { revisionId: fixtureIdentity(99) }
        : field === "previous selection" ? { previousEventId: fixtureIdentity(99) } : { sequence: "0" };
    return Promise.resolve({ ...ack, ...patch });
  });
  await act(async () => { await drafts.selectRevision(candidate); });
  expect(drafts.current()?.pendingSelection).not.toBeNull(); expect(drafts.mutationReserved).toBe(true);
  expect(drafts.reserveMutation()).toBeNull();
});

it("blocks selection before identity while import owns the same reservation", async () => {
  render(<Probe/>, project); begin();
  let token!: symbol;
  act(() => { token = drafts.reserveMutation()!; });
  await act(async () => { expect(await drafts.selectRevision(candidate)).toBe(false); });
  expect(calls("create_execution_identity")).toHaveLength(0);
  act(() => { drafts.releaseMutation(Symbol("different owner")); });
  expect(drafts.mutationReserved).toBe(true);
  act(() => drafts.releaseMutation(token));
  await act(async () => { expect(await drafts.selectRevision(candidate)).toBe(true); });
  expect(calls("select_translation_revision")).toHaveLength(1);
  expect(imports.current().uncertain).toHaveLength(0);
});

it("does not dispatch a fresh selection when a late identity outlives its source scope", async () => {
  render(<Probe/>, project); begin();
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void; let changed = false;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finish = resolve; })
    : command === "read_content_scope" && changed ? Promise.resolve({ revision: "2", currentSnapshot: fixtureIdentity(99) }) : original(command, payload));
  let pending!: Promise<boolean>; act(() => { pending = drafts.selectRevision(candidate); });
  await waitFor(() => expect(finish).toBeDefined()); changed = true;
  await act(async () => { finish(fixtureIdentity(700)); expect(await pending).toBe(false); });
  expect(calls("select_translation_revision")).toHaveLength(0); expect(drafts.mutationReserved).toBe(false);
});

it("keeps the original protection pending in the translation owner and refuses conflicting fresh mutations", async () => {
  const view = render(<Probe/>, project); begin();
  const original = invoke.getMockImplementation()!; let sent = 0;
  invoke.mockImplementation((command: string, args) => command === "set_work_protection" ? Promise.reject(++sent === 1 ? new Error("Protection ACK lost") : mutationRejection()) : original(command, args));
  const basis = { key: "entry", sourceText: "Original", selectionText: null, request: { projectId: project.metadata.projectId, sessionToken: project.sessionToken,
    unitId: candidate.unitId, locale: candidate.locale, sourceRevisionId: candidate.sourceRevisionId, selectionId: null, expectedRevision: "0" } };
  await act(async () => { await drafts.protection.change(basis, true, () => true).catch(() => {}); });
  const pending = structuredClone(drafts.protection.current().pending); expect(pending?.phase).toBe("unknown"); expect(drafts.mutationReserved).toBe(true);
  act(() => { drafts.edit("Retained B"); drafts.clear(); });
  expect(drafts.current()?.text).toBe("Retained B"); expect(drafts.protection.blocked()).toBe(true);
  await act(async () => { expect(await drafts.selectRevision(candidate)).toBe(false); expect((await drafts.save()).saved).toBe(false); });
  expect(calls("select_translation_revision")).toHaveLength(0); expect(calls("save_translation_revision")).toHaveLength(0);
  view.rerender(null); view.rerender(<Probe/>, project);
  await act(async () => { await drafts.protection.retry(() => true).catch(() => {}); });
  expect(drafts.protection.current().pending).toEqual(pending); expect(drafts.current()?.text).toBe("Retained B");
  expect(calls("set_work_protection").map(([, args]) => args.request)).toEqual([pending!.request, pending!.request]); expect(calls("create_execution_identity")).toHaveLength(1);
});
