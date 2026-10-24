import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTranslationImportSession } from "./TranslationImportSession";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { translationCommands, type TranslationAdoptRequest, type TranslationPreview, type TranslationPreviewRow } from "./translationCommands";
import type { AdoptionAction, Receipt } from "./executionCommands";
import { isCommandError, hasUnknownOutcome, type CommandError, type ProjectView } from "./projectCommands";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { translationActionFixture, translationAttemptFixture, translationPreviewFixture, translationReceiptFixture, translationRecoveryUnit, translationRowFixture } from "./testSupport/translationFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "isolated-import", locator: "C:\\isolated\\import-owner", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(900), displayName: "Fixture", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let owner: ReturnType<typeof useTranslationImportSession>, drafts: ReturnType<typeof useTranslationDraftSession>;
let preview: TranslationPreview, pageSize: number, nextIdentity: number, requests: Map<string, TranslationAdoptRequest>;
function Probe() {
  const value = useTranslationImportSession(), manual = useTranslationDraftSession();
  useLayoutEffect(() => { owner = value; drafts = manual; });
  return <><output aria-label="Import outcome">{value.state.uncertain.length ? "Unknown" : value.state.completionVersion ? "Applied" : "Ready"}</output>
    <output aria-label="Import basis">{value.state.preview?.basis}</output><output aria-label="Manual input">{manual.draft?.text}</output></>;
}
function rowFor(request: TranslationAdoptRequest) { return preview.rows.find(row => row.itemId === request.itemId)!; }
function action(request: TranslationAdoptRequest) { return translationActionFixture(request, translationRecoveryUnit(rowFor(request))); }
function receipt(request: TranslationAdoptRequest) { return translationReceiptFixture(request, translationRecoveryUnit(rowFor(request)), rowFor(request).currentSelection?.sequence ?? null); }
function mutationRejection(): CommandError {
  // ExecutionHost.allow_mutation rejects a quiescing host before any write.
  const failure: CommandError = { code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false };
  expect(isCommandError(failure)).toBe(true); expect(hasUnknownOutcome(failure)).toBe(false);
  return failure;
}
beforeEach(() => {
  invoke.mockReset(); preview = translationPreviewFixture(); pageSize = 100; nextIdentity = 50; requests = new Map();
  const checkedWrites = new Map<string,number>();
  invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    const request = payload.request;
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: preview.currentSourceSnapshotId };
    if (command === "create_execution_identity") return fixtureIdentity(nextIdentity++);
    if (command === "select_source") return { selectionId: fixtureIdentity(901), folderName: "Fixture folder" };
    if (command === "list_translation_files") return ["zh.json", "zh-CN.json"];
    if (command === "preflight_translation") return { fileName: request.fileName, fileDigest: preview.fileDigest,
      sourceSnapshotId: preview.fixedSourceSnapshotId, targetLocale: request.targetLocale, declaredLocale: preview.declaredLocale, count: preview.total };
    if (command === "start_translation_import") return request.attemptId;
    if (command === "read_translation_preview") {
      const after = Number(request.after), rows = preview.rows.filter(row => row.entry.ordinal >= after).slice(0, Math.min(pageSize, Number(request.limit)));
      const next = rows.at(-1)?.entry.ordinal;
      return { ...preview, rows, nextOrdinal: next !== undefined && preview.rows.some(row => row.entry.ordinal > next) ? next + 1 : null };
    }
    if (command === "read_execution_attempt") {
      const offset = Number(request.offset), rows = preview.rows.slice(offset, offset + pageSize);
      return translationAttemptFixture(preview, rows, offset + rows.length < preview.rows.length ? offset + rows.length : null);
    }
    if (command === "prepare_translation_adoption") {
      const original = request as unknown as TranslationAdoptRequest; requests.set(original.actionId, original); return action(original);
    }
    if (command === "adopt_execution" || command === "read_execution_receipt") return receipt(requests.get(String(request.actionId))!);
    if (command === "read_translation_adoption_action") {
      const original = request.adoption as TranslationAdoptRequest;
      const writes = calls("prepare_translation_adoption").length + calls("adopt_execution").length;
      if (checkedWrites.get(original.actionId) !== writes) { checkedWrites.set(original.actionId,writes); throw new Error("Automatic lookup unavailable"); }
      return {action:action(original),receipt:receipt(original)};
    }
    throw new Error(command);
  });
});
afterEach(cleanup);

it("retains the first unknown start after a definite rejection of the identical explicit retry", async () => {
  render(<Probe/>,project);
  await act(async()=>{await owner.chooseFolder();owner.setFile("zh.json");await owner.preflight();});
  act(()=>owner.confirmLanguage(true));const original=invoke.getMockImplementation()!,rejected=mutationRejection();let sent=0;
  invoke.mockImplementation((command:string,payload)=>command==="start_translation_import" ? Promise.reject(++sent===1 ? new Error("Lost ACK")
    : rejected) : original(command,payload));
  await act(async()=>{await owner.start();});const request=structuredClone(owner.current().pendingStart);
  await act(async()=>{await owner.retryStart();});
  expect(owner.current().pendingStart).toEqual(request);expect(owner.current().attempt).toBeNull();
  expect(calls("start_translation_import").map(([,args])=>args.request)).toEqual([request,request]);expect(calls("create_execution_identity")).toHaveLength(1);
});

it.each(["prepare_translation_adoption","adopt_execution"])("preserves an unknown import and its reservation after a checked-missing retry is rejected by %s",async boundary=>{
  render(<Probe/>,project);await ready();const original=invoke.getMockImplementation()!,rejected=mutationRejection();
  invoke.mockImplementation((command:string,payload)=>command==="adopt_execution" ? Promise.reject(new Error("Lost ACK"))
    : command==="read_translation_adoption_action" ? Promise.resolve(null) : original(command,payload));
  await applyRow();const pending=structuredClone(owner.current().uncertain[0]);
  await act(async()=>{await owner.checkReceipt(pending.request.actionId);});expect(owner.current().uncertain[0].receiptChecked).toBe(true);
  invoke.mockImplementation((command:string,payload)=>command===boundary ? Promise.reject(rejected) : original(command,payload));
  await act(async()=>{await owner.retryAction(pending.request.actionId);});
  expect(owner.current().uncertain).toHaveLength(1);expect(owner.current().uncertain[0]).toMatchObject({request:pending.request,receiptChecked:false});
  expect(drafts.mutationReserved).toBe(true);expect(calls("create_execution_identity")).toHaveLength(1);
  await act(async()=>{await owner.retryAction(pending.request.actionId);});expect(calls("prepare_translation_adoption")).toHaveLength(2);
});

it("releases fresh definite rejection while preserving no invented unknown request",async()=>{
  render(<Probe/>,project);await ready();const original=invoke.getMockImplementation()!,rejected=mutationRejection();
  invoke.mockImplementation((command:string,payload)=>command==="prepare_translation_adoption" ? Promise.reject(rejected) : original(command,payload));
  await applyRow();expect(owner.current().uncertain).toEqual([]);expect(drafts.mutationReserved).toBe(false);
  expect(calls("read_translation_adoption_action")).toHaveLength(0);
});

it("disposes its captured read listener on owner destruction before a deferred identity returns",async()=>{
  const view=render(<Probe/>,project);
  await act(async()=>{await owner.chooseFolder();owner.setFile("zh.json");await owner.preflight();});act(()=>owner.confirmLanguage(true));
  const original=invoke.getMockImplementation()!,dispose=vi.fn();let resolve!: (value:string)=>void;
  invoke.mockImplementation((command:string,payload)=>command==="create_execution_identity" ? new Promise<string>(done=>{resolve=done;}) : original(command,payload));
  let work!:Promise<void>;act(()=>{work=owner.start(()=>true,dispose);});await waitFor(()=>expect(resolve).toBeDefined());
  view.unmount();expect(dispose).toHaveBeenCalledTimes(1);await act(async()=>{resolve(fixtureIdentity(999));await work;});
  expect(dispose).toHaveBeenCalledTimes(1);expect(calls("start_translation_import")).toHaveLength(0);
});
async function ready() {
  act(() => owner.showAttempt(preview.attemptId));
  const page = await translationCommands.preview({ projectId: project.metadata.projectId, sessionToken: project.sessionToken,
    attemptId: preview.attemptId, after: 0, limit: 50, basis: null });
  act(() => owner.ready(page));
}
async function applyRow(decision: "candidate-only" | "select-if-empty" | "replace" = "candidate-only") {
  act(() => owner.chooseRow(owner.current().preview!.rows[0], decision));
  await act(async () => { await owner.applyRow(); });
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }

it("retains folder, language consent and fixed ready evidence across complete consumer removal", async () => {
  const view = render(<Probe/>, project);
  await act(async () => { await owner.chooseFolder(); owner.setFile("zh.json"); await owner.preflight(); });
  act(() => { owner.confirmLanguage(true); owner.setStrategy(true); });
  const captured = structuredClone(owner.current());
  view.rerender(null);
  view.rerender(<Probe/>);
  expect(owner.current()).toMatchObject({ folder: captured.folder, preflight: captured.preflight, confirmed: true, selectIfEmpty: true });
  await ready();
  const fixed = structuredClone(owner.current().preview);
  preview = { ...preview, basis: "later current basis" };
  view.rerender(null);
  await refreshWorkbenchReads(["translation", "execution"]);
  view.rerender(<Probe/>);
  act(() => owner.ready(preview));
  expect(owner.current().preview).toEqual(fixed);
  expect(screen.getByLabelText("Import basis")).toHaveTextContent(fixed!.basis);
});

it("retains an unknown start and resumes only its exact request after consumer and locale changes", async () => {
  const view = render(<Probe/>, project);
  await act(async () => { await owner.chooseFolder(); owner.setFile("zh.json"); await owner.preflight(); });
  act(() => owner.confirmLanguage(true));
  const original = invoke.getMockImplementation()!; let lost = true;
  invoke.mockImplementation(async (command: string, payload: unknown) => {
    const value = await original(command, payload);
    if (command === "start_translation_import" && lost) { lost = false; throw new Error("Lost start ACK"); }
    return value;
  });
  await act(async () => { await owner.start(); });
  const request = structuredClone(owner.current().pendingStart!);
  expect(request).toMatchObject({ expectedFileDigest: preview.fileDigest, expectedSourceSnapshotId: preview.fixedSourceSnapshotId, languageConfirmed: true });
  view.rerender(null, { ...project, metadata: { ...project.metadata, targetLocales: [], sourceLocale: "fr" } });
  await act(async () => { await owner.retryStart(); });
  view.rerender(<Probe/>);
  expect(calls("start_translation_import").map(([, args]) => args.request)).toEqual([request, request]);
  expect(owner.current().pendingStart).toBeNull(); expect(owner.current().attempt).toBe(request.attemptId);
});

it("requires a new preflight and exact language consent after explicitly reselecting the file", async () => {
  render(<Probe/>, project);
  await act(async () => { await owner.chooseFolder(); owner.setFile("zh.json"); await owner.preflight(); });
  act(() => { owner.confirmLanguage(true); owner.setFile("zh-CN.json"); });
  await act(async () => { await owner.start(); });
  expect(owner.current().preflight).toBeNull(); expect(owner.current().confirmed).toBe(false);
  expect(calls("create_execution_identity")).toHaveLength(0);
  await act(async () => { await owner.preflight(); });
  act(() => owner.confirmLanguage(true));
  await act(async () => { await owner.start(); });
  expect(calls("start_translation_import")[0][1].request.fileName).toBe("zh-CN.json");
});

it("settles a late original import ACK after consumer unmount while preserving manual input B", async () => {
  const view = render(<Probe/>, project); await ready();
  act(() => { drafts.begin({ unitId: preview.rows[0].unitId!, locale: "zh-CN", sourceRevisionId: preview.rows[0].sourceRevisionId!, key: "key", sourceText: "Original" }, null, null); drafts.edit("A"); });
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  act(() => owner.chooseRow(owner.current().preview!.rows[0], "candidate-only"));
  let pending!: Promise<void>; act(() => { pending = owner.applyRow(); });
  await waitFor(() => expect(finish).toBeDefined());
  act(() => drafts.edit("B"));
  view.rerender(null);
  const request = owner.current().uncertain[0].request;
  await act(async () => { finish(receipt(request)); await pending; });
  view.rerender(<Probe/>);
  expect(screen.getByLabelText("Import outcome")).toHaveTextContent("Applied");
  expect(screen.getByLabelText("Manual input")).toHaveTextContent("B");
  expect(drafts.current()?.baseSelectionId).toBeNull();
  expect(calls("adopt_execution")).toHaveLength(1);
});

it("recovers the original unknown request after source, language and pure view reads change", async () => {
  const view = render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? Promise.reject(new Error("Lost ACK")) : original(command, payload));
  await applyRow(); const pending = owner.current().uncertain[0];
  view.rerender(null, { ...project, metadata: { ...project.metadata, sourceLocale: "fr", targetLocales: [] } });
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_content_scope" || command === "read_translation_preview"
    ? Promise.reject(new Error("Current view unavailable")) : original(command, payload));
  await act(async () => { await owner.checkReceipt(pending.request.actionId); });
  view.rerender(<Probe/>);
  expect(owner.current().uncertain).toHaveLength(0);
  expect(owner.current().completionVersion).toBe(1);
  expect(calls("adopt_execution")).toHaveLength(1);
  expect(drafts.mutationReserved).toBe(false);
});

it("replays the exact original prepare and adoption after a missing receipt and revokes that permission on another unknown", async () => {
  const view = render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!; let lookups = 0;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? Promise.reject(new Error("Lost ACK"))
    : command === "read_translation_adoption_action" ? ++lookups <= 2 ? Promise.resolve(null) : Promise.reject(new Error("Lookup unavailable")) : original(command, payload));
  await applyRow(); const request = structuredClone(owner.current().uncertain[0].request);
  await act(async () => { await owner.checkReceipt(request.actionId); });
  expect(owner.current().uncertain[0].receiptChecked).toBe(true);
  view.rerender(<Probe/>, { ...project, metadata: { ...project.metadata, sourceLocale: "fr", targetLocales: [] } });
  await act(async () => { await owner.retryAction(request.actionId); });
  expect(calls("prepare_translation_adoption").map(([, args]) => args.request)).toEqual([request, request]);
  expect(owner.current().uncertain[0].receiptChecked).toBe(false);
  await act(async () => { await owner.retryAction(request.actionId); });
  expect(calls("adopt_execution")).toHaveLength(2);
  expect(drafts.mutationReserved).toBe(true);
});

it.each(["project", "attempt", "action", "unit", "operation", "result", "digest", "snapshot", "occurrence", "source revision", "target unit", "selection", "decision"])
  ("keeps a typed-valid wrong prepare %s unknown and recovers by original action read without another adoption", async field => {
    render(<Probe/>, project); await ready();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, payload: { request: TranslationAdoptRequest }) => {
      if (command !== "prepare_translation_adoption") return original(command, payload);
      requests.set(payload.request.actionId, payload.request);
      const ack = action(payload.request), parameters = { ...payload.request.confirmation };
      const patches: Record<string, Partial<AdoptionAction>> = { project: { projectId: fixtureIdentity(99) }, attempt: { attemptId: fixtureIdentity(99) },
        action: { actionId: fixtureIdentity(99) }, unit: { unitId: payload.request.confirmation.targetUnitId }, operation: { operation: "source-import" }, result: { resultIds: [fixtureIdentity(99)] } };
      const confirmationPatches = { digest: { resultDigest: "wrong" }, snapshot: { sourceSnapshotId: fixtureIdentity(99) }, occurrence: { occurrenceId: fixtureIdentity(99) },
        "source revision": { sourceRevisionId: fixtureIdentity(99) }, "target unit": { targetUnitId: fixtureIdentity(99) }, selection: { expectedSelectionId: fixtureIdentity(99) }, decision: { decision: "replace" } };
      return Promise.resolve({ ...ack, ...(patches[field] ?? { parameters: { ...parameters, ...confirmationPatches[field as keyof typeof confirmationPatches] } }) });
    });
    await applyRow(); const pending = owner.current().uncertain[0];
    expect(pending).toBeDefined(); expect(calls("adopt_execution")).toHaveLength(0);
    invoke.mockImplementation(original);
    await act(async () => { await owner.checkReceipt(pending.request.actionId); });
    expect(owner.current().uncertain).toHaveLength(0);
    expect(calls("prepare_translation_adoption")).toHaveLength(1);
    expect(calls("adopt_execution")).toHaveLength(0);
  });

it.each(["project", "attempt", "action", "unit", "digest", "uppercase digest", "change kind", "zero ordinal", "extra selection", "selection sequence"])
  ("keeps a typed-valid wrong receipt %s unknown", async field => {
    render(<Probe/>, project); await ready();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, payload: { request: { actionId: string } }) => {
      if (command !== "adopt_execution") return original(command, payload);
      const request = requests.get(payload.request.actionId)!, value = receipt(request);
      const patches: Record<string, Partial<Receipt>> = { project: { projectId: fixtureIdentity(99) }, attempt: { attemptId: fixtureIdentity(99) },
        action: { actionId: fixtureIdentity(99) }, unit: { unitId: request.confirmation.targetUnitId }, digest: { requestDigest: "not-a-digest" }, "uppercase digest": { requestDigest: "A".repeat(64) },
        "change kind": { changes: [{ ...value.changes[0], kind: "source-snapshot" }] }, "zero ordinal": { changes: [{ ...value.changes[0], revision: "0" }, ...value.changes.slice(1)] },
        "extra selection": { changes: [...value.changes, { kind: "translation-selection", id: fixtureIdentity(99), revision: "1" }] },
        "selection sequence": { changes: [value.changes[0], { ...value.changes[1], revision: "2" }] } };
      return Promise.resolve({ ...value, ...patches[field] });
    });
    await applyRow(field === "selection sequence" ? "select-if-empty" : "candidate-only");
    expect(owner.current().uncertain).toHaveLength(1); expect(owner.current().completionVersion).toBe(0);
    expect(drafts.mutationReserved).toBe(true);
  });

it("pins a legitimate receipt before recovering a missing prepare ACK and denies a later missing or changed receipt", async () => {
  render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: TranslationAdoptRequest }) => {
    if (command === "read_translation_adoption_action") {
      const request = owner.current().uncertain[0].request;
      return Promise.resolve({action:{...action(request),operation:"source-import"},receipt:receipt(request)});
    }
    if (command !== "prepare_translation_adoption") return original(command, payload);
    requests.set(payload.request.actionId, payload.request); return Promise.resolve({ ...action(payload.request), operation: "source-import" });
  });
  await applyRow(); const request = owner.current().uncertain[0].request;
  await act(async () => { await owner.checkReceipt(request.actionId); });
  expect(owner.current().uncertain[0].receipt).toEqual(receipt(request));
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_translation_adoption_action" ? Promise.resolve(null) : original(command, payload));
  await act(async () => { await owner.checkReceipt(request.actionId); await owner.retryAction(request.actionId); });
  expect(owner.current().uncertain[0].receiptChecked).toBe(false); expect(calls("adopt_execution")).toHaveLength(0);
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_translation_adoption_action" ? Promise.resolve({action:action(request),receipt:{ ...receipt(request), requestDigest: "b".repeat(64) }}) : original(command, payload));
  await act(async () => { await owner.checkReceipt(request.actionId); });
  expect(owner.current().completionVersion).toBe(0);
});

it("captures the complete multi-page file and paged recovery units before confirming the exact batch", async () => {
  preview = translationPreviewFixture([translationRowFixture(0), translationRowFixture(1), translationRowFixture(2, { status: "unmatched", unitId: null, occurrenceId: null, sourceRevisionId: null })]); pageSize = 1;
  const view = render(<Probe/>, project); await ready();
  await act(async () => { await owner.captureBatch(); });
  expect(owner.current().batchCapture).toMatchObject({ excluded: 1, eligible: [preview.rows[0], preview.rows[1]], preview: { total: 3 } });
  expect(calls("create_execution_identity")).toHaveLength(0);
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void; let delayed = false;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" && !delayed
    ? (delayed = true, new Promise(resolve => { finish = resolve; })) : original(command, payload));
  let pending!: Promise<void>; act(() => { pending = owner.applyBatch(); });
  await waitFor(() => expect(finish).toBeDefined());
  const request = owner.current().uncertain[0].request;
  view.rerender(null);
  await act(async () => { finish(receipt(request)); await pending; });
  view.rerender(<Probe/>);
  expect(owner.current().batchOutcome).toEqual({ applied: 2, conflicted: 0, failed: 0, unknown: 0 });
  expect(calls("prepare_translation_adoption").map(([, args]) => args.request.itemId)).toEqual(preview.rows.slice(0, 2).map(row => row.itemId));
  expect(calls("read_execution_attempt").map(([, args]) => args.request.offset)).toEqual([0, 1, 2]);
});

it("keeps partial business results and their original unknown independently of a failed preview refresh", async () => {
  preview = translationPreviewFixture([translationRowFixture(0), translationRowFixture(1), translationRowFixture(2)]);
  render(<Probe/>, project); await ready(); await act(async () => { await owner.captureBatch(); });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: TranslationAdoptRequest }) => {
    if (command === "prepare_translation_adoption" && payload.request.itemId === preview.rows[1].itemId) return Promise.reject({ code: "dependency-conflict", outcome: "rejected", stage: "execution-adopt", recoveryRequired: false, reason: "translation-selection" });
    if (command === "adopt_execution" && requests.get(payload.request.actionId)?.itemId === preview.rows[2].itemId) return Promise.reject(new Error("Lost ACK"));
    return original(command, payload);
  });
  await act(async () => { await owner.applyBatch(); });
  expect(owner.current().batchOutcome).toEqual({ applied: 1, conflicted: 1, failed: 0, unknown: 1 });
  const pending = owner.current().uncertain[0];
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_translation_preview" ? Promise.reject(new Error("View unavailable")) : original(command, payload));
  await act(async () => { await owner.checkReceipt(pending.request.actionId); await owner.page(0, true); });
  expect(owner.current().batchOutcome).toEqual({ applied: 2, conflicted: 1, failed: 0, unknown: 0 });
  expect(owner.current().completionVersion).toBe(2); expect(owner.current().uncertain).toHaveLength(0);
  expect(calls("adopt_execution")).toHaveLength(2);
});

it("counts automatic original reads in the actual batch and preserves partial results for later pure checking",async()=>{
  preview=translationPreviewFixture([translationRowFixture(0),translationRowFixture(1),translationRowFixture(2)]);
  render(<Probe/>,project);await ready();await act(async()=>{await owner.captureBatch();});
  const original=invoke.getMockImplementation()!;let retryRead=false,rejectSecond!:(error:unknown)=>void;
  invoke.mockImplementation((command:string,payload:{request:Record<string,unknown>})=>{
    const request=payload.request;
    if(command==="prepare_translation_adoption"&&request.itemId===preview.rows[1].itemId)return new Promise((_,reject)=>{rejectSecond=reject;});
    if(command==="adopt_execution")return Promise.reject(new Error("Lost adoption ACK"));
    if(command==="read_translation_adoption_action"){
      const adoption=request.adoption as TranslationAdoptRequest;
      if(adoption.itemId===preview.rows[2].itemId&&!retryRead)return Promise.reject(new Error("Lookup unavailable"));
      return Promise.resolve({action:action(adoption),receipt:receipt(adoption)});
    }
    return original(command,payload);
  });
  let batch!:Promise<void>;act(()=>{batch=owner.applyBatch();});await waitFor(()=>expect(rejectSecond).toBeDefined());
  expect(owner.current().batchOutcome).toEqual({applied:1,conflicted:0,failed:0,unknown:0});
  expect(drafts.reserveMutation()).toBeNull();expect(owner.current().batchProgress).toEqual({done:1,total:3});
  await act(async()=>{rejectSecond({code:"dependency-conflict",outcome:"rejected",stage:"execution-adopt",recoveryRequired:false,reason:"translation-selection"});await batch;});
  expect(owner.current().batchOutcome).toEqual({applied:1,conflicted:1,failed:0,unknown:1});
  expect(owner.current().batchDetails.map(row=>row.status)).toEqual(["applied","conflicted","unknown"]);
  const pending=owner.current().uncertain[0];expect(pending.request.itemId).toBe(preview.rows[2].itemId);
  expect(calls("read_translation_adoption_action").map(([,args])=>args.request)).toEqual([0,2].map(index=>{
    const request=[...requests.values()].find(request=>request.itemId===preview.rows[index].itemId)!;
    return {adoption:request,unitId:translationRecoveryUnit(preview.rows[index])};
  }));
  expect(drafts.mutationReserved).toBe(true);retryRead=true;
  await act(async()=>{await owner.checkReceipt(pending.request.actionId);});
  expect(owner.current().batchOutcome).toEqual({applied:2,conflicted:1,failed:0,unknown:0});
  expect(owner.current().completionVersion).toBe(2);expect(drafts.mutationReserved).toBe(false);
  expect(calls("adopt_execution")).toHaveLength(2);expect(calls("prepare_translation_adoption")).toHaveLength(3);expect(calls("create_execution_identity")).toHaveLength(3);
});

it("reads a frozen import unit after hidden consumer removal and preserves newer manual input",async()=>{
  const view=render(<Probe/>,project);await ready();const original=invoke.getMockImplementation()!;
  act(()=>{drafts.begin({unitId:fixtureIdentity(700),locale:"zh-CN",sourceRevisionId:fixtureIdentity(701),key:"manual",sourceText:"Source"},null,null);});
  let finish!:(value:unknown)=>void;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="adopt_execution"?Promise.reject(new Error("Lost ACK"))
    :command==="read_translation_adoption_action"?new Promise(resolve=>{finish=resolve;}):original(command,payload));
  act(()=>owner.chooseRow(owner.current().preview!.rows[0],"candidate-only"));
  let work!:Promise<void>;act(()=>{work=owner.applyRow();});await waitFor(()=>expect(finish).toBeDefined());
  const pending=owner.current().uncertain[0];expect(owner.current()).toMatchObject({busy:true,checkingAction:pending.request.actionId,failure:null});
  act(()=>drafts.edit("Newer B"));view.rerender(null);
  await act(async()=>{finish({action:action(pending.request),receipt:receipt(pending.request)});await work;});view.rerender(<Probe/>);
  expect(owner.current()).toMatchObject({checkingAction:null,busy:false,uncertain:[],completionVersion:1,failure:null});
  expect(drafts.current()?.text).toBe("Newer B");expect(calls("read_execution_attempt")).toHaveLength(1);
  expect(calls("read_translation_adoption_action")[0][1].request).toEqual({adoption:pending.request,unitId:pending.recoveryUnitId});
  expect(calls("adopt_execution")).toHaveLength(1);expect(calls("prepare_translation_adoption")).toHaveLength(1);
});

it.each(["basis", "eligibility", "count"])("does not silently shrink a confirmed batch when %s changes", async field => {
  preview = translationPreviewFixture([translationRowFixture(0), translationRowFixture(1)]);
  render(<Probe/>, project); await ready(); await act(async () => { await owner.captureBatch(); });
  preview = field === "basis" ? { ...preview, basis: "new-basis" } : field === "count" ? { ...preview, total: 3 }
    : { ...preview, rows: [preview.rows[0], { ...preview.rows[1], status: "selected-conflict" }] };
  await act(async () => { await owner.applyBatch(); });
  expect(calls("create_execution_identity")).toHaveLength(0); expect(calls("prepare_translation_adoption")).toHaveLength(0);
  expect(owner.current().batchCapture?.eligible).toHaveLength(2);
  expect(drafts.mutationReserved).toBe(false);
});

it("revokes a fresh operation after a late identity when its target language disappears", async () => {
  const view = render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  act(() => owner.chooseRow(owner.current().preview!.rows[0], "candidate-only"));
  let pending!: Promise<void>; act(() => { pending = owner.applyRow(); });
  await waitFor(() => expect(finish).toBeDefined());
  view.rerender(<Probe/>, { ...project, metadata: { ...project.metadata, targetLocales: [] } });
  await act(async () => { finish(fixtureIdentity(50)); await pending; });
  expect(calls("prepare_translation_adoption")).toHaveLength(0); expect(drafts.mutationReserved).toBe(false);
  expect(owner.current().preview).not.toBeNull();
});

it("blocks adoption before identity while manual saving or a manual unknown is reserved", async () => {
  render(<Probe/>, project); await ready();
  act(() => { drafts.begin({ unitId: preview.rows[0].unitId!, locale: "zh-CN", sourceRevisionId: preview.rows[0].sourceRevisionId!, key: "key", sourceText: "Original" }, null, null); drafts.edit("A"); });
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<unknown>; act(() => { pending = drafts.save(); });
  await waitFor(() => expect(finish).toBeDefined());
  act(() => owner.chooseRow(owner.current().preview!.rows[0], "candidate-only"));
  await act(async () => { await owner.applyRow(); });
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("prepare_translation_adoption")).toHaveLength(0);
  await act(async () => { finish(fixtureIdentity(50)); await pending; });
  expect(drafts.current()?.pending).not.toBeNull();
  await act(async () => { await owner.applyRow(); });
  expect(calls("prepare_translation_adoption")).toHaveLength(0);
});

it("blocks direct fresh manual save and selection throughout import identity wait and unknown recovery", async () => {
  render(<Probe/>, project); await ready();
  act(() => { drafts.begin({ unitId: preview.rows[0].unitId!, locale: "zh-CN", sourceRevisionId: preview.rows[0].sourceRevisionId!, key: "key", sourceText: "Original" }, null, null); drafts.edit("B"); owner.chooseRow(owner.current().preview!.rows[0], "candidate-only"); });
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>; act(() => { pending = owner.applyRow(); });
  await waitFor(() => expect(finish).toBeDefined());
  await act(async () => { expect((await drafts.save()).saved).toBe(false); });
  expect(calls("create_execution_identity")).toHaveLength(1);
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? Promise.reject(new Error("Lost ACK")) : original(command, payload));
  await act(async () => { finish(fixtureIdentity(50)); await pending; });
  await act(async () => { expect((await drafts.save()).saved).toBe(false); });
  expect(drafts.current()?.text).toBe("B"); expect(calls("save_translation_revision")).toHaveLength(0);
});

it("stops the next authorized batch item when the project session owner is destroyed", async () => {
  preview = translationPreviewFixture([translationRowFixture(0), translationRowFixture(1)]);
  const view = render(<Probe/>, project); await ready(); await act(async () => { await owner.captureBatch(); });
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>; act(() => { pending = owner.applyBatch(); });
  await waitFor(() => expect(finish).toBeDefined()); const request = owner.current().uncertain[0].request;
  view.unmount();
  await act(async () => { finish(receipt(request)); await pending; });
  expect(calls("prepare_translation_adoption")).toHaveLength(1); expect(calls("adopt_execution")).toHaveLength(1);
});
