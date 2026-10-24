import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/translation-commands.json";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useTranslationImportSession } from "./TranslationImportSession";
import { isCommandError, hasUnknownOutcome, type CommandError, type ProjectView } from "./projectCommands";
import type { TranslationRevision, TranslationSelectRequest, TranslationSelection } from "./translationCommands";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { ...fixture.start, locator: "C:\\isolated\\selection-owner", reconciliationState: "settled",
  metadata: { projectId: fixture.start.projectId, displayName: "Fixture", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const candidate: TranslationRevision = { ...fixture.receipt.revision, originKind: "manual", text: "Candidate", revisionId: fixtureIdentity(701) };
let drafts: ReturnType<typeof useTranslationDraftSession>, imports: ReturnType<typeof useTranslationImportSession>;
let originalRequest: TranslationSelectRequest | null, selected: TranslationSelection | null;
function Probe() {
  const value = useTranslationDraftSession(), owner = useTranslationImportSession();
  useLayoutEffect(() => { drafts = value; imports = owner; });
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
