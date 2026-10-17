import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/translation-commands.json";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useTranslationImportSession } from "./TranslationImportSession";
import { useSessionReads } from "./SessionReadProvider";
import { isCommandError, hasUnknownOutcome, type CommandError, type ProjectView } from "./projectCommands";
import type { TranslationRevision, TranslationSelectRequest, TranslationSaveRequest, TranslationSaveReceipt, TranslationSelection, CandidateDecision, CandidateDecisionRequest } from "./translationCommands";
import { validateRequestSave, validateRequestSelect, validateResponseSaved, validateResponseSelected, validateResponseCandidateAction } from "./generated/translation.validators";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { ...fixture.start, locator: "C:\\isolated\\selection-owner", reconciliationState: "settled",
  metadata: { projectId: fixture.start.projectId, displayName: "Fixture", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const candidate: TranslationRevision = { ...fixture.receipt.revision, originKind: "manual", text: "Candidate", revisionId: fixtureIdentity(701) };
let drafts: ReturnType<typeof useTranslationDraftSession>, imports: ReturnType<typeof useTranslationImportSession>, reads: ReturnType<typeof useSessionReads>;
let originalRequest: TranslationSelectRequest | null, selected: TranslationSelection | null;
let savedActions: Map<string, { request: TranslationSaveRequest; receipt: TranslationSaveReceipt }>;
function Probe() {
  const value = useTranslationDraftSession(), owner = useTranslationImportSession(), reader = useSessionReads();
  useLayoutEffect(() => { drafts = value; imports = owner; reads = reader; });
  return <output aria-label="Selection draft">{value.draft?.text}</output>;
}
function selection(request: TranslationSelectRequest): TranslationSelection {
  return { actionId: request.actionId, unitId: request.unitId, locale: request.locale, revisionId: request.revisionId,
    eventId: fixtureIdentity(702), sequence: "1", previousEventId: request.expectedSelectionId ?? null };
}
function saved(request: TranslationSaveRequest): TranslationSaveReceipt {
  const selected = { ...selection({ ...request, revisionId: fixtureIdentity(730) }), sequence: request.expectedSelectionId == null ? "1" : "2" };
  return { projectId: request.projectId, actionId: request.actionId, selection: selected,
    revision: { ...fixture.receipt.revision, originKind: "manual", actionId: request.actionId, revisionId: selected.revisionId,
      unitId: request.unitId, locale: request.locale, sourceRevisionId: request.sourceRevisionId, text: request.text },
    basis: { sourceSnapshotId: fixture.start.expectedSourceSnapshotId, sourceRevisionId: request.sourceRevisionId, selectionId: selected.eventId } };
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
  invoke.mockReset(); originalRequest = null; selected = null; savedActions = new Map();
  invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: fixture.start.expectedSourceSnapshotId };
    if (command === "create_execution_identity") return fixtureIdentity(700);
    if (command === "select_translation_revision") {
      if (!validateRequestSelect(payload.request)) throw new Error("Invalid selection request");
      originalRequest = payload.request; selected = selection(originalRequest); return selected;
    }
    if (command === "read_translation_selection_action") {
      if (!validateRequestSelect(payload.request)) throw new Error("Invalid selection lookup request");
      if (originalRequest) expect(payload.request).toEqual(originalRequest);
      return selected;
    }
    if (command === "save_translation_revision") {
      if (!validateRequestSave(payload.request)) throw new Error("Invalid save request");
      const receipt = saved(payload.request); savedActions.set(payload.request.actionId, { request: structuredClone(payload.request), receipt }); return receipt;
    }
    if (command === "read_translation_save_action") {
      if (!validateRequestSave(payload.request)) throw new Error("Invalid save lookup request");
      const record = savedActions.get(payload.request.actionId); if (record) expect(payload.request).toEqual(record.request);
      return record?.receipt ?? null;
    }
    throw new Error(command);
  });
});
afterEach(cleanup);

it("preserves an unknown selection and newer B after an explicit same-request retry is definitely rejected",async()=>{
  render(<Probe/>,project);begin();const original=invoke.getMockImplementation()!,rejected=mutationRejection();let lookups=0;
  invoke.mockImplementation((command:string,payload)=>command==="select_translation_revision" ? Promise.reject(new Error("Lost ACK"))
    : command==="read_translation_selection_action" ? lookups++===0?Promise.reject(new Error("Lookup unavailable")):Promise.resolve(null) : original(command,payload));
  await act(async()=>{await drafts.selectRevision(candidate);});const request=structuredClone(drafts.current()!.pendingSelection!.request);
  act(()=>drafts.edit("Newer B"));await act(async()=>{await drafts.checkSelection();});expect(drafts.current()?.pendingSelection?.receiptChecked).toBe(true);
  invoke.mockImplementation((command:string,payload)=>command==="select_translation_revision" ? Promise.reject(rejected) : original(command,payload));
  await act(async()=>{expect(await drafts.retrySelection()).toBe(false);});
  expect(drafts.current()).toMatchObject({text:"Newer B",outcomeUnknown:true,pendingSelection:{request,receiptChecked:false}});
  expect(drafts.mutationReserved).toBe(true);expect(calls("select_translation_revision").map(([,args])=>args.request)).toEqual([request,request]);
  expect(calls("read_translation_selection_action")).toHaveLength(2);
  expect(calls("create_execution_identity")).toHaveLength(1);await act(async()=>{await drafts.retrySelection();});expect(calls("select_translation_revision")).toHaveLength(2);
});

it("releases a first definite selection rejection and its captured read listener",async()=>{
  render(<Probe/>,project);begin();const original=invoke.getMockImplementation()!,dispose=vi.fn(),rejected=mutationRejection();
  invoke.mockImplementation((command:string,payload)=>command==="select_translation_revision" ? Promise.reject(rejected) : original(command,payload));
  await act(async()=>{expect(await drafts.selectRevision(candidate,()=>true,dispose)).toBe(false);});
  expect(drafts.current()?.pendingSelection).toBeNull();expect(drafts.current()?.outcomeUnknown).toBe(false);expect(drafts.mutationReserved).toBe(false);expect(dispose).toHaveBeenCalledTimes(1);
  expect(calls("read_translation_selection_action")).toHaveLength(0);
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
function unknownTranslationFailure(): CommandError {
  const failure: CommandError = { code: "outcome-unknown", stage: "execution-adopt", outcome: "unknown", recoveryRequired: true,
    reason: "translation-action", diagnosticId: fixtureIdentity(740) };
  expect(isCommandError(failure)).toBe(true); return failure;
}

it.each(["lost", "invalid"] as const)("confirms a %s save acknowledgement with one original-request read and keeps newer B across consumer removal", async acknowledgement => {
  const view = render(<Probe/>, project); begin(); act(() => drafts.edit("A 👩🏽‍💻"));
  const original = invoke.getMockImplementation()!, identity = deferred<string>(), lookup = deferred<TranslationSaveReceipt | null>();
  let written!: TranslationSaveRequest, receipt!: TranslationSaveReceipt;
  invoke.mockImplementation(async (command: string, args) => {
    if (command === "create_execution_identity") return identity.promise;
    if (command === "read_translation_save_action") return lookup.promise;
    const result = await original(command, args);
    if (command === "save_translation_revision") {
      written = args.request; receipt = result;
      if (acknowledgement === "lost") throw unknownTranslationFailure();
      return { ...receipt, actionId: fixtureIdentity(741) };
    }
    return result;
  });
  let running!: ReturnType<typeof drafts.save>;
  act(() => { running = drafts.save(); void drafts.save(); });
  expect(drafts.reserveMutation()).toBeNull(); expect(drafts.current()).toMatchObject({ saving: true, checkingAction: null });
  await act(async () => { expect(await drafts.selectRevision(candidate)).toBe(false); });
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("save_translation_revision")).toHaveLength(0);
  await act(async () => { identity.resolve(fixtureIdentity(742)); });
  await waitFor(() => expect(calls("read_translation_save_action")).toHaveLength(1));
  expect(drafts.current()).toMatchObject({ saving: true, checkingAction: "save", failure: null });
  expect(calls("read_translation_save_action")[0][1].request).toEqual(written);
  act(() => drafts.edit("Newer B é"));
  await act(async () => { expect((await drafts.save()).saved).toBe(false); expect((await drafts.checkSavedAction()).saved).toBe(false); });
  view.rerender(null, { ...project, metadata: { ...project.metadata, sourceLocale: "fr", targetLocales: [] } });
  await act(async () => { lookup.resolve(receipt); expect(await running).toMatchObject({ saved: true, savedCurrent: false, submittedText: "A 👩🏽‍💻" }); });
  view.rerender(<Probe/>);
  expect(drafts.current()).toMatchObject({ text: "Newer B é", baseText: "A 👩🏽‍💻", baseSelectionId: receipt.selection.eventId,
    pending: null, saving: false, checkingAction: null, outcomeUnknown: false, newerDraftSaved: true, receiptCheck: "found", failure: null });
  expect(calls("save_translation_revision")).toHaveLength(1); expect(calls("read_translation_save_action")).toHaveLength(1);
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("select_translation_revision")).toHaveLength(0);
  expect(calls("read_translation_action")).toHaveLength(0);
});

it("retains a missing save's original error and requires another pure read after failed lookup or a definite retry rejection", async () => {
  render(<Probe/>, project); begin(); act(() => drafts.edit("Saved A"));
  const original = invoke.getMockImplementation()!, unknown = unknownTranslationFailure(), rejected = mutationRejection();
  let writes = 0, lookups = 0, written!: TranslationSaveRequest;
  invoke.mockImplementation((command: string, args) => {
    if (command === "save_translation_revision") { written = args.request; return Promise.reject(++writes === 3 ? rejected : unknown); }
    if (command === "read_translation_save_action") {
      lookups++; if (lookups === 2) return Promise.reject(Object.assign(new Error("Lookup failed"), { reason: "save-lookup-failed" }));
      return Promise.resolve(lookups === 4 ? saved(written) : null);
    }
    return original(command, args);
  });
  await act(async () => { expect((await drafts.save()).saved).toBe(false); });
  const pending = drafts.current()!.pending!, request = pending.request;
  expect(drafts.current()).toMatchObject({ pending, receiptCheck: "missing", outcomeUnknown: true, failure: unknown });
  expect(drafts.current()?.failure).toBe(unknown); expect(writes).toBe(1); expect(lookups).toBe(1);
  act(() => drafts.edit("Newer B"));
  await act(async () => { await drafts.save(); await drafts.save(); });
  expect(writes).toBe(2); expect(lookups).toBe(2);
  expect(drafts.current()).toMatchObject({ pending, receiptCheck: null, failure: "save-lookup-failed", checkingAction: null });
  await act(async () => { await drafts.checkSavedAction(); await drafts.save(); });
  expect(writes).toBe(3); expect(lookups).toBe(3);
  expect(drafts.current()).toMatchObject({ pending, outcomeUnknown: true, receiptCheck: null, failure: rejected });
  await act(async () => { expect(await drafts.checkSavedAction()).toMatchObject({ saved: true, savedCurrent: false }); });
  expect(drafts.current()).toMatchObject({ pending: null, text: "Newer B", baseText: "Saved A", failure: null, receiptCheck: "found" });
  expect(calls("save_translation_revision").map(([, args]) => args.request)).toEqual([request, request, request]);
  expect(calls("read_translation_save_action").map(([, args]) => args.request)).toEqual([request, request, request, request]);
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("read_translation_action")).toHaveLength(0);
});

it.each(["project", "text", "source", "previous selection", "revision link", "basis"] as const)("retains the original save after a typed-valid wrong %s lookup", async defect => {
  render(<Probe/>, project); begin(); act(() => drafts.edit("A"));
  const original = invoke.getMockImplementation()!; let written!: TranslationSaveRequest;
  invoke.mockImplementation((command: string, args) => {
    if (command === "save_translation_revision") { written = args.request; return Promise.reject(unknownTranslationFailure()); }
    if (command === "read_translation_save_action") {
      const receipt = saved(written);
      if (defect === "project") receipt.projectId = fixtureIdentity(749);
      else if (defect === "text") receipt.revision.text = "Different saved request";
      else if (defect === "source") receipt.revision.sourceRevisionId = fixtureIdentity(749);
      else if (defect === "previous selection") receipt.selection.previousEventId = fixtureIdentity(749);
      else if (defect === "revision link") receipt.selection.revisionId = fixtureIdentity(749);
      else receipt.basis.selectionId = fixtureIdentity(749);
      expect(validateResponseSaved(receipt)).toBe(true); return Promise.resolve(receipt);
    }
    return original(command, args);
  });
  await act(async () => { expect((await drafts.save()).saved).toBe(false); });
  expect(drafts.current()).toMatchObject({ pending: { request: written }, text: "A", baseText: null, saving: false,
    outcomeUnknown: true, receiptCheck: null, checkingAction: null, failure: "invalid-save-receipt" });
  expect(drafts.reserveMutation()).toBeNull(); expect(calls("save_translation_revision")).toHaveLength(1);
  expect(calls("read_translation_save_action")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
});

it("releases a definite first save rejection without looking up an action", async () => {
  render(<Probe/>, project); begin(); act(() => drafts.edit("Retained A"));
  const original = invoke.getMockImplementation()!, rejected = mutationRejection();
  invoke.mockImplementation((command: string, args) => command === "save_translation_revision" ? Promise.reject(rejected) : original(command, args));
  await act(async () => { expect((await drafts.save()).saved).toBe(false); });
  expect(drafts.current()).toMatchObject({ pending: null, saving: false, checkingAction: null, outcomeUnknown: false, failure: rejected, text: "Retained A" });
  expect(calls("read_translation_save_action")).toHaveLength(0);
  let token!: symbol | null; act(() => { token = drafts.reserveMutation(); }); expect(token).not.toBeNull(); act(() => drafts.releaseMutation(token!));
});

it("confirms the original history selection with one read while preserving B and the shared reservation", async () => {
  const view = render(<Probe/>, project); begin();
  const original = invoke.getMockImplementation()!, lookup = deferred<TranslationSelection | null>();
  let written!: TranslationSelectRequest;
  invoke.mockImplementation(async (command: string, args) => {
    if (command === "read_translation_selection_action") return lookup.promise;
    const result = await original(command, args);
    if (command === "select_translation_revision") { written = args.request; throw unknownTranslationFailure(); }
    return result;
  });
  let running!: Promise<boolean>; act(() => { running = drafts.selectRevision(candidate); });
  await waitFor(() => expect(calls("read_translation_selection_action")).toHaveLength(1));
  expect(drafts.current()).toMatchObject({ selecting: true, checkingAction: "selection", failure: null });
  expect(drafts.mutationReserved).toBe(true); expect(drafts.reserveMutation()).toBeNull();
  act(() => drafts.edit("Composition B"));
  await act(async () => { expect(await drafts.checkSelection()).toBe(false); expect(await drafts.retrySelection()).toBe(false); expect((await drafts.save()).saved).toBe(false); });
  view.rerender(null);
  await act(async () => { lookup.resolve(selection(written)); expect(await running).toBe(true); });
  view.rerender(<Probe/>);
  expect(drafts.current()).toMatchObject({ text: "Composition B", baseText: candidate.text, baseRevisionId: candidate.revisionId,
    pendingSelection: null, checkingAction: null, newerDraftSaved: true, outcomeUnknown: false, failure: null });
  expect(drafts.mutationReserved).toBe(false); expect(calls("select_translation_revision")).toHaveLength(1);
  expect(calls("read_translation_selection_action").map(([, args]) => args.request)).toEqual([written]);
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("save_translation_revision")).toHaveLength(0);
  expect(calls("read_translation_action")).toHaveLength(0);
});

it.each(["save", "selection"] as const)("does not automatically read a %s action when identity allocation failed before dispatch", async kind => {
  render(<Probe/>, project); begin(); if (kind === "save") act(() => drafts.edit("A"));
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "create_execution_identity" ? Promise.reject(new Error("Identity unavailable")) : original(command, args));
  await act(async () => { if (kind === "save") await drafts.save(); else await drafts.selectRevision(candidate); });
  expect(calls("save_translation_revision")).toHaveLength(0); expect(calls("select_translation_revision")).toHaveLength(0);
  expect(calls("read_translation_save_action")).toHaveLength(0); expect(calls("read_translation_selection_action")).toHaveLength(0);
});

it.each(["save", "selection"] as const)("rejects an undefined %s lookup instead of granting a missing-action retry", async kind => {
  render(<Probe/>, project); begin(); if (kind === "save") act(() => drafts.edit("A"));
  const original = invoke.getMockImplementation()!;
  const writeCommand = kind === "save" ? "save_translation_revision" : "select_translation_revision";
  const readCommand = kind === "save" ? "read_translation_save_action" : "read_translation_selection_action";
  invoke.mockImplementation((command: string, args) => command === writeCommand ? Promise.reject(unknownTranslationFailure())
    : command === readCommand ? Promise.resolve(undefined) : original(command, args));
  await act(async () => { if (kind === "save") await drafts.save(); else await drafts.selectRevision(candidate); });
  expect(drafts.current()).toMatchObject({ receiptCheck: null, checkingAction: null, outcomeUnknown: true, failure: "failed" });
  if (kind === "save") expect(drafts.current()?.pending).not.toBeNull();
  else expect(drafts.current()?.pendingSelection).toMatchObject({ receiptChecked: false });
  await act(async () => { if (kind === "save") await drafts.save(); else await drafts.retrySelection(); });
  expect(calls(writeCommand)).toHaveLength(1); expect(calls(readCommand)).toHaveLength(1);
});

it.each([ ["save", "before"], ["save", "during"], ["selection", "before"], ["selection", "during"] ] as const)("ignores the old %s action after retirement %s its lookup", async (kind, moment) => {
  render(<Probe/>, project); begin(); if (kind === "save") act(() => drafts.edit("A"));
  const original = invoke.getMockImplementation()!, write = deferred<unknown>(), lookup = deferred<unknown>();
  const writeCommand = kind === "save" ? "save_translation_revision" : "select_translation_revision";
  const readCommand = kind === "save" ? "read_translation_save_action" : "read_translation_selection_action";
  let receipt!: TranslationSaveReceipt | TranslationSelection;
  invoke.mockImplementation((command: string, args) => {
    if (command === writeCommand) {
      if (kind === "save") { if (!validateRequestSave(args.request)) throw new Error("Invalid captured save"); receipt = saved(args.request); }
      else { if (!validateRequestSelect(args.request)) throw new Error("Invalid captured selection"); receipt = selection(args.request); }
      return write.promise;
    }
    if (command === readCommand) return lookup.promise;
    return original(command, args);
  });
  let running!: Promise<unknown>; act(() => { running = kind === "save" ? drafts.save() : drafts.selectRevision(candidate); });
  await waitFor(() => expect(calls(writeCommand)).toHaveLength(1));
  if (moment === "during") { await act(async () => { write.reject(unknownTranslationFailure()); }); await waitFor(() => expect(calls(readCommand)).toHaveLength(1)); }
  const before = drafts.current(); act(() => reads.retire());
  await act(async () => {
    if (moment === "before") write.reject(unknownTranslationFailure());
    else lookup.resolve(receipt);
    await running;
  });
  expect(drafts.current()).toBe(before); expect(calls(readCommand)).toHaveLength(moment === "before" ? 0 : 1);
  expect(calls(writeCommand)).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
});

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
  const original = invoke.getMockImplementation()!; let lost = true, lookups = 0;
  invoke.mockImplementation(async (command: string, payload: { request: TranslationSelectRequest }) => {
    if (command === "read_translation_selection_action" && lookups++ === 0) throw new Error("Lookup unavailable");
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
  expect(calls("select_translation_revision").map(([, args]) => args.request)).toEqual([request]);
  expect(calls("read_translation_selection_action").map(([, args]) => args.request)).toEqual([request, request]);
  expect(drafts.current()?.text).toBe("Newer B"); expect(drafts.mutationReserved).toBe(false);
});

it("requires a missing-action check before exact selection retry and revokes it on another unknown", async () => {
  render(<Probe/>, project); begin();
  const original = invoke.getMockImplementation()!; let lookups = 0;
  invoke.mockImplementation((command: string, payload: { request: TranslationSelectRequest }) => {
    if (command === "select_translation_revision") { originalRequest = payload.request; return Promise.reject(new Error("Disconnected")); }
    if (command === "read_translation_selection_action") return ++lookups === 2 ? Promise.resolve(null) : Promise.reject(new Error("Lookup unavailable"));
    return original(command, payload);
  });
  await act(async () => { await drafts.selectRevision(candidate); await drafts.retrySelection(); });
  expect(calls("select_translation_revision")).toHaveLength(1);
  await act(async () => { await drafts.checkSelection(); await drafts.retrySelection(); });
  expect(calls("select_translation_revision").map(([, args]) => args.request)).toEqual([originalRequest, originalRequest]);
  expect(drafts.current()?.pendingSelection?.receiptChecked).toBe(false);
  await act(async () => { await drafts.retrySelection(); });
  expect(calls("select_translation_revision")).toHaveLength(2);
  expect(calls("read_translation_selection_action")).toHaveLength(3);
});

it.each(["action", "unit", "locale", "revision", "previous selection", "zero sequence"])("retains a typed-valid wrong selection %s as unknown", async field => {
  render(<Probe/>, project); begin();
  const original = invoke.getMockImplementation()!; let wrong!: TranslationSelection;
  invoke.mockImplementation((command: string, payload: { request: TranslationSelectRequest }) => {
    if (command === "read_translation_selection_action") { expect(validateResponseSelected(wrong)).toBe(true); return Promise.resolve(wrong); }
    if (command !== "select_translation_revision") return original(command, payload);
    const ack = selection(payload.request);
    const patch: Partial<TranslationSelection> = field === "action" ? { actionId: fixtureIdentity(99) } : field === "unit" ? { unitId: fixtureIdentity(99) }
      : field === "locale" ? { locale: "fr" } : field === "revision" ? { revisionId: fixtureIdentity(99) }
        : field === "previous selection" ? { previousEventId: fixtureIdentity(99) } : { sequence: "0" };
    wrong = { ...ack, ...patch }; return Promise.resolve(wrong);
  });
  await act(async () => { await drafts.selectRevision(candidate); });
  expect(drafts.current()?.pendingSelection).not.toBeNull(); expect(drafts.mutationReserved).toBe(true);
  expect(drafts.current()).toMatchObject({ receiptCheck: null, checkingAction: null, failure: "invalid-save-receipt" });
  expect(calls("read_translation_selection_action")).toHaveLength(1); expect(calls("select_translation_revision")).toHaveLength(1);
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
