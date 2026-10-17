import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import arenaFixture from "../test/fixtures/arenaCommands.contract.json";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import { confirmArenaView, useArenaDraftSession } from "./ArenaDraftSession";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import type { ArenaConfig, ArenaPrepared, ArenaView, ComparisonView } from "./arenaCommands";
import type { AdoptionAction, PrepareRequest, Receipt } from "./executionCommands";
import type { TranslationSelection } from "./translationCommands";
import type { ProjectView, CommandError } from "./projectCommands";
import { validateResponsePrepared, validateResponseComparison } from "./generated/arena.validators";
import { arenaViewFixture, aiAttempt } from "./testSupport/aiFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { i18n } from "./i18n";
import { connectionReadKey, useApplicationQueryClient } from "./ApplicationReadProvider";
import { connectionFixture } from "./testSupport/connectionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "arena-owner", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(500), displayName: "Arena owner", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let owner: ReturnType<typeof useArenaDraftSession>, translations: ReturnType<typeof useTranslationDraftSession>, reads: ReturnType<typeof useSessionReads>;
let application: ReturnType<typeof useApplicationQueryClient>;
let prepared: ArenaPrepared, comparison: ComparisonView, action: AdoptionAction;
function Probe() {
  const value = useArenaDraftSession(), drafts = useTranslationDraftSession(), sessionReads = useSessionReads(), appReads = useApplicationQueryClient();
  useLayoutEffect(() => { owner = value; translations = drafts; reads = sessionReads; application = appReads; });
  return null;
}
function Harness({mounted = true, read = false}:{mounted?:boolean;read?:boolean}) {
  return <>{mounted ? <Probe/> : null}{read ? <ResultRead/> : null}</>;
}
function ResultRead() {
  const value = useArenaDraftSession();
  const query = useSessionQuery({key:["arena",value.attempt],scopes:["execution","arena"],enabled:!!value.attempt,read:()=>value.readView(value.attempt!)});
  return <output aria-label="Arena result read">{query.isError ? "Read failed" : query.isSuccess ? "Read confirmed" : "Loading"}</output>;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function payloads(command: string) { return calls(command).map(([,payload]) => payload.request); }
function deferred<T>() {
  let resolve!: (value:T)=>void, reject!: (value:unknown)=>void;
  const promise = new Promise<T>((done,fail) => { resolve=done;reject=fail; });
  return {promise,resolve,reject};
}
function actionFor(request: PrepareRequest): AdoptionAction {
  return {...executionFixture.action,projectId:request.projectId,attemptId:request.attemptId,actionId:request.actionId,unitId:request.unitId,
    operation:"arena-translation",parameters:null,resultIds:[...request.resultIds]};
}
function receiptFor(value: AdoptionAction): Receipt {
  return {...executionFixture.receipt,projectId:value.projectId,attemptId:value.attemptId,actionId:value.actionId,unitId:value.unitId,
    changes:[{kind:"translation-revision",id:fixtureIdentity(950),revision:"1"}]};
}
function selectionFor(request: {actionId:string;unitId:string;locale:string;expectedSelectionId?:string|null;revisionId?:string}): TranslationSelection {
  return {eventId:fixtureIdentity(951),revisionId:request.revisionId??fixtureIdentity(952),actionId:request.actionId,unitId:request.unitId,locale:request.locale,
    previousEventId:request.expectedSelectionId??null,sequence:request.expectedSelectionId ? "2" : "1"};
}
/** Host display order may differ from preview slots and detail storage order. */
function viewFor(value = prepared, displayOrder = value.preview.config.variants.map((_,index) => index).reverse()): ArenaView {
  const view = arenaViewFixture(value.preview.items[0].item,value.preview.config);
  view.detail.attemptId=value.attemptId;view.detail.recovery.attemptId=value.attemptId;
  if (view.variants) view.variants=displayOrder.map(slot=>value.preview.config.variants[slot]);
  const firstRow=view.rows[0],firstDetail=view.detail.items[0],firstUnit=view.detail.recovery.units[0];
  view.rows=[];view.detail.items=[];view.detail.recovery.units=[];
  const count=value.preview.config.variants.length;
  value.preview.items.forEach((original,index)=>{
    const itemId=fixtureIdentity(1000+index),resultId=fixtureIdentity(1200+index),unitId=fixtureIdentity(1400+index);
    const scope={kind:"translation-unit",id:original.item.unitId,locale:original.item.targetLocale};
    view.rows.push({...firstRow,item:original.item,itemId,resultId,sourceOrder:original.sourceOrder,label:displayOrder.indexOf(original.slot),
      output:{...firstRow.output!,unitId:original.item.unitId,targetLocale:original.item.targetLocale,text:`Output ${index}`}});
    view.detail.items.unshift({...firstDetail,resultId,scope,status:{...firstDetail.status,itemId}});
    view.detail.recovery.units.push({...firstUnit,unitId,itemIds:[itemId],remainingItemIds:[itemId],resultIds:[resultId],scopes:[scope]});
  });
  view.rows.sort((left,right)=>left.sourceOrder-right.sourceOrder||left.label-right.label);
  view.detail.progress.total=value.preview.items.length;view.detail.progress.succeeded=value.preview.items.length;
  view.budget={...view.budget!,limit:value.preview.config.maxRequests,dispatched:value.preview.items.length,usageUnknown:value.preview.items.length};
  expect(view.rows.length % count).toBe(0);
  return view;
}
const rejected: CommandError={code:"dependency-conflict",outcome:"rejected",stage:"execution-adopt",recoveryRequired:false,reason:"arena-basis"};
beforeEach(async()=>{
  await i18n.changeLanguage("en-US");
  const p:unknown=structuredClone(arenaFixture.responses.prepared),c:unknown=structuredClone(arenaFixture.responses.comparison);
  if(!validateResponsePrepared(p)||!validateResponseComparison(c))throw new Error("Invalid Arena fixture");
  prepared=p;prepared.attemptId=aiAttempt;comparison=c;
  let identity=910;
  let checkedWrites=-1;
  invoke.mockReset();invoke.mockImplementation(async(command:string,payload:{request:PrepareRequest & {config:ArenaConfig;unitIds:string[];locale:string;revisionIds:string[];blind:boolean;expectedSelectionId:string|null;revisionId:string}})=>{
    const request=payload.request;
    if(command==="create_execution_identity")return fixtureIdentity(identity++);
    if(command==="preview_arena_translation"){
      const items=prepared.preview.items;
      prepared={attemptId:aiAttempt,preview:{...prepared.preview,config:structuredClone({...request.config,parentAttemptId:request.config.parentAttemptId??null}),items:request.unitIds.flatMap((unitId,sourceOrder)=>
        request.config.variants.map((_,slot)=>({slot,sourceOrder,item:{...(items.find(row=>row.item.unitId===unitId)?.item??items[0].item),unitId,targetLocale:request.locale}})))}};
      return prepared;
    }
    if(command==="start_arena_translation")return prepared.attemptId;
    if(command==="read_arena_translation")return viewFor();
    if(command==="create_arena_comparison"){
      comparison={...comparison,comparisonId:request.actionId,unitId:request.unitId,locale:request.locale,blind:request.blind,
        rows:request.revisionIds.map((id,index)=>({...comparison.rows[index],revisionId:id}))};return comparison;
    }
    if(command==="read_arena_comparison")return comparison;
    if(command==="list_arena_comparisons")return [];
    if(command==="reveal_arena_identity")return null;
    if(command==="select_translation_revision"||command==="save_arena_merge")return selectionFor(request);
    if(command==="read_translation_action"||command==="read_execution_receipt")return null;
    if(command==="prepare_execution_adoption"){action=actionFor(request);return action;}
    if(command==="adopt_execution")return receiptFor(action);
    if(command==="read_execution_adoption_action"){
      const writes=calls("prepare_execution_adoption").length+calls("adopt_execution").length;
      if(checkedWrites!==writes){checkedWrites=writes;throw new Error("Automatic lookup unavailable");}
      return null;
    }
    throw new Error(command);
  });
});
afterEach(cleanup);
async function prepare(){
  act(()=>{owner.setConfig(prepared.preview.config);owner.setSelected([...new Set(prepared.preview.items.map(row=>row.item.unitId))]);});
  await act(async()=>{await owner.preview();});act(()=>owner.setConsent(true));
}
async function start(){await prepare();await act(async()=>{await owner.start();});return viewFor();}
async function compare(){
  act(()=>{owner.setUnit(comparison.unitId);owner.setReferences(comparison.rows.map(row=>row.revisionId));owner.setComparisonBlind(true);});
  await act(async()=>{await owner.compare();});
  await act(async()=>{const view=await owner.readComparison(owner.comparisonId!);reads.client.setQueryData(reads.key(["arena-comparison",view.comparisonId]),view);});
  return comparison;
}
async function merge(){const view=await compare();act(()=>owner.beginMerge(view));expect(owner.draft).not.toBeNull();}
const operations=["start","compare","select","merge","reveal","adopt"] as const;
type Operation=typeof operations[number];
const commands:Record<Operation,string>={start:"start_arena_translation",compare:"create_arena_comparison",select:"select_translation_revision",merge:"save_arena_merge",reveal:"reveal_arena_identity",adopt:"adopt_execution"};
async function setupOperation(kind:Operation){
  if(kind==="start")await prepare();
  else if(kind==="merge")await merge();
  else if(kind==="select"||kind==="reveal")await compare();
  else if(kind==="compare")act(()=>{owner.setUnit(comparison.unitId);owner.setReferences(comparison.rows.map(row=>row.revisionId));owner.setComparisonBlind(true);});
  else await start();
}
function execute(kind:Operation){
  if(kind==="start")return owner.start();
  if(kind==="compare")return owner.compare();
  if(kind==="select")return owner.select(comparison,comparison.rows[0].revisionId);
  if(kind==="merge")return owner.saveMerge();
  if(kind==="reveal")return owner.reveal(comparison.comparisonId!,"comparison");
  const view=viewFor();return owner.adopt(view,view.rows[0].resultId!);
}
function acknowledgement(kind:Operation):unknown{
  const request=payloads(commands[kind]).at(-1);
  if(kind==="start")return request.attemptId;
  if(kind==="compare")return {...comparison,comparisonId:request.actionId,unitId:request.unitId,locale:request.locale,blind:request.blind};
  if(kind==="reveal")return null;
  if(kind==="adopt")return receiptFor(action);
  return selectionFor(request);
}

it.each(["storeId", "profileId", "revision", "digest"] as const)("refuses an Arena profile with mismatched %s despite matching defaults", async field => {
  render(<Harness/>, project);
  const reference = { storeId: fixtureIdentity(700), profileId: fixtureIdentity(701), revision: "1", digest: "a".repeat(64) };
  act(() => { const variants = prepared.preview.config.variants.map((config, index) => index === 1 ? { ...config, connectionProfile: reference } : config); application.setQueryData(connectionReadKey, connectionFixture(variants)); owner.setConfig({ ...prepared.preview.config, variants }); owner.setSelected([prepared.preview.items[0].item.unitId]); });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, payload: unknown) => {
    const result = await original(command, payload); if (command !== "preview_arena_translation") return result;
    const wrong = structuredClone(result);
    wrong.preview.config.variants[1].connectionProfile[field] = field === "revision" ? "2" : field === "digest" ? "b".repeat(64) : fixtureIdentity(702);
    return wrong;
  });
  await act(async () => { await owner.preview(); });
  expect(owner.prepared).toBeNull(); expect(owner.consent).toBe(false); expect(owner.canStart()).toBe(false);
  expect(owner.current().config.variants[1].connectionProfile).toEqual(reference); expect(owner.failure).not.toBeNull(); expect(calls("start_arena_translation")).toHaveLength(0);
});

it.each(operations)("keeps the checked %s acknowledgement across a real consumer unmount",async kind=>{
  const rendered=render(<Harness/>,project);await setupOperation(kind);
  const response=deferred<unknown>(),original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command===commands[kind]?response.promise:original(command,payload));
  let pending!:Promise<void>;act(()=>{pending=execute(kind);void execute(kind);});
  await waitFor(()=>expect(calls(commands[kind])).toHaveLength(1));
  const request=structuredClone(payloads(commands[kind])[0]);
  rendered.rerender(<Harness mounted={false}/>,project);
  await act(async()=>{response.resolve(acknowledgement(kind));await pending;});
  rendered.rerender(<Harness/>,project);
  expect(owner.pending).toBeNull();expect(owner.busy).toBe(false);expect(payloads(commands[kind])).toEqual([request]);
  if(kind==="start")expect(owner.attempt).toBe(request.attemptId);
  if(kind==="compare")expect(owner.comparisonId).toBe(request.actionId);
  if(kind==="merge")expect(owner.draft).toBeNull();
  if(kind==="adopt")expect(Object.values(owner.saved)).toEqual([receiptFor(action)]);
  const token=translations.reserveMutation();expect(token).not.toBeNull();act(()=>translations.releaseMutation(token!));
});

it.each(["compare","select","merge","reveal","adopt"] as const)("continues original %s after unmount during identity, without a second identity",async kind=>{
  const rendered=render(<Harness/>,project);await setupOperation(kind);
  const response=deferred<string>(),original=invoke.getMockImplementation()!,before=calls("create_execution_identity").length;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="create_execution_identity"?response.promise:original(command,payload));
  let pending!:Promise<void>;act(()=>{pending=execute(kind);void execute(kind);});
  expect(calls("create_execution_identity")).toHaveLength(before+1);
  if(kind==="select"||kind==="merge"||kind==="adopt")expect(translations.reserveMutation()).toBeNull();
  rendered.rerender(<Harness mounted={false}/>,project);
  await act(async()=>{response.resolve(fixtureIdentity(970));await pending;});rendered.rerender(<Harness/>,project);
  expect(owner.pending).toBeNull();expect(payloads(commands[kind])[0].actionId).toBe(fixtureIdentity(970));
  expect(calls("create_execution_identity")).toHaveLength(before+1);
});

it.each(["select","merge","adopt"] as const)("shares the existing translation reservation for %s and retains it while unknown",async kind=>{
  render(<Harness/>,project);await setupOperation(kind);
  let token!:symbol;act(()=>{token=translations.reserveMutation()!;});
  await act(async()=>{await execute(kind);});expect(calls(commands[kind])).toHaveLength(0);
  act(()=>translations.releaseMutation(token));
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command===commands[kind]?Promise.reject({code:"outcome-unknown"}):original(command,payload));
  await act(async()=>{await execute(kind);});expect(owner.pending?.uncertain).toBe(true);expect(translations.reserveMutation()).toBeNull();
  await act(async()=>{await owner.checkPending();});expect(owner.pending?.retryAllowed).toBe(true);
  expect(translations.reserveMutation()).toBeNull();
});

it.each(operations)("does not erase the original unknown %s after a rejected explicit replay",async kind=>{
  render(<Harness/>,project);await setupOperation(kind);const original=invoke.getMockImplementation()!;let count=0;
  invoke.mockImplementation((command:string,payload:unknown)=>command===commands[kind]?Promise.reject(++count===1?{code:"outcome-unknown"}:rejected):original(command,payload));
  await act(async()=>{await execute(kind);});const originalEntry=owner.pending!,captured=originalEntry.request;
  if(kind!=="start"&&kind!=="compare")await act(async()=>{await owner.checkPending();});
  await act(async()=>{await owner.retryPending();});expect(owner.pending?.request).toEqual(captured);
  expect(owner.pending?.uncertain).toBe(true);expect(owner.pending?.retryAllowed).toBe(false);
  const wireRequest=originalEntry.kind==="adopt"?{sessionToken:originalEntry.request.sessionToken,projectId:originalEntry.request.projectId,actionId:originalEntry.request.actionId}:captured;
  expect(payloads(commands[kind])).toEqual([wireRequest,wireRequest]);
  if(originalEntry.kind==="adopt"){
    expect(payloads("prepare_execution_adoption").length).toBeGreaterThan(0);
    for(const request of payloads("prepare_execution_adoption"))expect(request).toEqual(captured);
  }
});

it.each(operations)("releases a fresh definitively rejected %s without discarding input",async kind=>{
  render(<Harness/>,project);await setupOperation(kind);const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command===commands[kind]?Promise.reject(rejected):original(command,payload));
  await act(async()=>{await execute(kind);});expect(owner.pending).toBeNull();
  expect(calls("read_execution_adoption_action")).toHaveLength(0);
  if(kind==="start")expect(owner.prepared).not.toBeNull();if(kind==="merge")expect(owner.draft?.text).toBe(comparison.rows[0].text);
  const token=translations.reserveMutation();expect(token).not.toBeNull();act(()=>translations.releaseMutation(token!));
});

it.each(["select","merge"] as const)("binds wrong %s ACKs and recovered receipts to every original selection field",async kind=>{
  render(<Harness/>,project);await setupOperation(kind);const original=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command:string,payload:unknown)=>{const result=await original(command,payload);return command===commands[kind]?{...result,actionId:fixtureIdentity(999)}:result;});
  await act(async()=>{await execute(kind);});const pending=owner.pending!;
  expect(pending.uncertain).toBe(true);
  const receipt=selectionFor(pending.request as Parameters<typeof selectionFor>[0]);
  for(const wrong of [{actionId:fixtureIdentity(998)},{unitId:fixtureIdentity(997)},{locale:"ja"},{previousEventId:null},{sequence:"0"},...(kind==="select"?[{revisionId:fixtureIdentity(996)}]:[])]){
    invoke.mockImplementation((command:string,payload:unknown)=>command==="read_translation_action"?Promise.resolve({...receipt,...wrong}):original(command,payload));
    await act(async()=>{await owner.checkPending();});expect(owner.pending?.request).toEqual(pending.request);expect(owner.pending?.retryAllowed).toBe(false);
  }
  invoke.mockImplementation((command:string,payload:unknown)=>command==="read_translation_action"?Promise.resolve(receipt):original(command,payload));
  await act(async()=>{await owner.checkPending();});expect(owner.pending).toBeNull();expect(owner.notice).toBe("reconciled");
  expect(calls(commands[kind])).toHaveLength(1);
});

it("keeps A to B to A merge edits after late confirmation and preserves fixed basis through pure query refresh",async()=>{
  render(<Harness/>,project);await merge();const basis=owner.draft!.basis,response=deferred<unknown>(),original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="save_arena_merge"?response.promise:original(command,payload));
  let pending!:Promise<void>;act(()=>{pending=owner.saveMerge();});await waitFor(()=>expect(calls("save_arena_merge")).toHaveLength(1));
  act(()=>{owner.editMerge("B");owner.editMerge(comparison.rows[0].text);reads.client.setQueryData(reads.key(["arena-comparison",comparison.comparisonId]),{...comparison,basis:"new",selectionId:fixtureIdentity(995)});});
  expect(owner.draft!.basis).toBe(basis);
  await act(async()=>{response.resolve(acknowledgement("merge"));await pending;});
  expect(owner.draft?.text).toBe(comparison.rows[0].text);expect(owner.draft!.basis).toBe(basis);expect(owner.draft!.editSeq).toBe(2);
  expect(owner.notice).toBe("merged");expect(owner.draft!.stale).toBe(true);
});

it("checks an old comparison by exact action despite a full bounded history list, and keeps failures unknown",async()=>{
  render(<Harness/>,project);await setupOperation("compare");const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="create_arena_comparison"?Promise.reject({code:"outcome-unknown"})
    :command==="read_arena_comparison"?Promise.reject(rejected):command==="list_arena_comparisons"?Promise.resolve(Array.from({length:100},(_,i)=>({...arenaFixture.responses.comparisons[0],comparisonId:fixtureIdentity(2000+i)}))):original(command,payload));
  await act(async()=>{await owner.compare();});const pending=owner.pending!;
  await act(async()=>{await owner.checkPending();});expect(calls("list_arena_comparisons")).toHaveLength(0);
  expect(payloads("read_arena_comparison")).toEqual([{sessionToken:project.sessionToken,projectId:project.metadata.projectId,comparisonId:(pending.request as {actionId:string}).actionId}]);
  expect(owner.pending?.request).toEqual(pending.request);expect(owner.pending?.uncertain).toBe(true);
  const request=pending.request as {actionId:string;unitId:string;locale:string;blind:boolean};
  const result={...comparison,comparisonId:request.actionId,sourceRevisionId:fixtureIdentity(990),selectionId:fixtureIdentity(991),basis:"current-projection",rows:[...comparison.rows].reverse()};
  invoke.mockImplementation((command:string,payload:unknown)=>command==="read_arena_comparison"?Promise.resolve(result):original(command,payload));
  await act(async()=>{await owner.checkPending();});expect(owner.pending).toBeNull();expect(owner.comparisonId).toBe(request.actionId);
  expect(calls("create_arena_comparison")).toHaveLength(1);
});

it("requires an exact null reveal ACK, and a revealed read proves the target goal without inventing an action receipt",async()=>{
  render(<Harness/>,project);await compare();const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="reveal_arena_identity"?Promise.resolve({}):original(command,payload));
  await act(async()=>{await owner.reveal(comparison.comparisonId!,"comparison");});expect(owner.pending?.uncertain).toBe(true);
  comparison={...comparison,revealed:true};await act(async()=>{await owner.checkPending();});expect(owner.pending).toBeNull();expect(calls("reveal_arena_identity")).toHaveLength(1);
});

it("settles the original adoption receipt after a lost prepare ACK without adopting again",async()=>{
  render(<Harness/>,project);await start();const original=invoke.getMockImplementation()!;let lost=true,lookups=0;
  invoke.mockImplementation(async(command:string,payload:unknown)=>{
    if(command==="prepare_execution_adoption"){const result=await original(command,payload);if(lost){lost=false;throw new Error("Lost prepare ACK");}return result;}
    if(command==="read_execution_adoption_action"){if(++lookups===1)throw new Error("Automatic lookup unavailable");return {action,receipt:receiptFor(action)};}
    return original(command,payload);
  });
  await act(async()=>{await execute("adopt");});expect(owner.pending?.uncertain).toBe(true);expect(calls("adopt_execution")).toHaveLength(0);
  const request=owner.pending!.request;await act(async()=>{await owner.checkPending();});
  expect(owner.pending).toBeNull();expect(Object.values(owner.saved)).toEqual([receiptFor(action)]);
  expect(payloads("prepare_execution_adoption")).toEqual([request]);expect(calls("adopt_execution")).toHaveLength(0);
  expect(payloads("read_execution_adoption_action")).toEqual([request,request]);
});

it("automatically checks an invalid adoption acknowledgement once and preserves its shared reservation through the read",async()=>{
  const rendered=render(<Harness/>,project);await start();const original=invoke.getMockImplementation()!,response=deferred<unknown>();
  invoke.mockImplementation((command:string,payload:unknown)=>command==="adopt_execution"?Promise.resolve({...receiptFor(action),actionId:fixtureIdentity(999)})
    :command==="read_execution_adoption_action"?response.promise:original(command,payload));
  let work!:Promise<void>;act(()=>{work=execute("adopt");});await waitFor(()=>expect(calls("read_execution_adoption_action")).toHaveLength(1));
  expect(owner.pending).toMatchObject({kind:"adopt",checking:true});expect(translations.reserveMutation()).toBeNull();
  await act(async()=>{await owner.checkPending();await owner.retryPending();});expect(calls("read_execution_adoption_action")).toHaveLength(1);
  rendered.rerender(<Harness mounted={false}/>);
  await act(async()=>{response.resolve({action,receipt:receiptFor(action)});await work;});rendered.rerender(<Harness/>);
  expect(owner.pending).toBeNull();expect(owner.saved[action.resultIds[0]]).toEqual(receiptFor(action));expect(owner.failure).toBeNull();
  expect(calls("prepare_execution_adoption")).toHaveLength(1);expect(calls("adopt_execution")).toHaveLength(1);expect(calls("create_execution_identity")).toHaveLength(1);
});

it.each(["projectId","attemptId","actionId","unitId","operation","parameters","resultIds","cancellationRevision"] as const)("rejects unrelated adoption prepare field %s",async field=>{
  render(<Harness/>,project);await start();const original=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command:string,payload:unknown)=>{
    const result=await original(command,payload);
    if(command!=="prepare_execution_adoption")return result;
    return {...result,[field]:field==="operation"?"ai-translation":field==="parameters"?{}:field==="resultIds"?[fixtureIdentity(999)]:field==="cancellationRevision"?"01":fixtureIdentity(999)};
  });
  await act(async()=>{await execute("adopt");});expect(owner.pending?.uncertain).toBe(true);expect(calls("adopt_execution")).toHaveLength(0);
});

it.each(["projectId","attemptId","actionId","unitId","requestDigest","changes"] as const)("retains adoption uncertainty for wrong receipt field %s",async field=>{
  render(<Harness/>,project);await start();const original=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command:string,payload:unknown)=>{
    const result=await original(command,payload);
    return command!=="adopt_execution"?result:{...result,[field]:field==="changes"?[{kind:"translation-selection",id:fixtureIdentity(999),revision:"1"}]:field==="requestDigest"?"bad":fixtureIdentity(999)};
  });
  await act(async()=>{await execute("adopt");});expect(owner.pending?.uncertain).toBe(true);expect(Object.values(owner.saved)).toHaveLength(0);
  expect(translations.reserveMutation()).toBeNull();
});

it("pins a seen receipt through invalid action proof and refuses a later null or changed receipt",async()=>{
  render(<Harness/>,project);await start();const original=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command:string,payload:unknown)=>{if(command==="prepare_execution_adoption"){await original(command,payload);throw new Error("Prepare read unavailable");}
    if(command==="read_execution_adoption_action")return {action:{...action,parameters:{}},receipt:receiptFor(action)};return original(command,payload);});
  await act(async()=>{await execute("adopt");await owner.checkPending();});
  const seen=owner.pending;expect(seen?.kind).toBe("adopt");if(seen?.kind!=="adopt")throw new Error("Missing adoption");expect(seen.receipt).toEqual(receiptFor(action));
  for(const value of [null,{...receiptFor(action),changes:[{kind:"translation-revision",id:fixtureIdentity(999),revision:"2"}]}]){
    invoke.mockImplementation((command:string,payload:unknown)=>command==="read_execution_adoption_action"?Promise.resolve(value===null?null:{action,receipt:value}):original(command,payload));
    await act(async()=>{await owner.checkPending();});expect(owner.pending?.kind).toBe("adopt");
    if(owner.pending?.kind==="adopt")expect(owner.pending.receipt).toEqual(seen.receipt);
    expect(owner.pending?.retryAllowed).toBe(false);
  }
  expect(calls("adopt_execution")).toHaveLength(0);
});

it("revokes missing-receipt retry permission after another unknown replay",async()=>{
  render(<Harness/>,project);await start();const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="adopt_execution"?Promise.reject({code:"outcome-unknown"}):original(command,payload));
  await act(async()=>{await execute("adopt");await owner.checkPending();});expect(owner.pending?.retryAllowed).toBe(true);
  await act(async()=>{await owner.retryPending();});expect(owner.pending?.retryAllowed).toBe(false);
  const count=calls("adopt_execution").length;await act(async()=>{await owner.retryPending();});expect(calls("adopt_execution")).toHaveLength(count);
});

it("retains a checked adoption after pure result reading fails",async()=>{
  render(<Harness read/>,project);await start();const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="read_arena_translation"?Promise.reject(new Error("Read failed")):original(command,payload));
  await act(async()=>{await execute("adopt");});await screen.findByText("Read failed");
  expect(owner.pending).toBeNull();expect(Object.values(owner.saved)).toEqual([receiptFor(action)]);expect(owner.notice).toBe("saved");
  expect(calls("adopt_execution")).toHaveLength(1);await act(async()=>{await owner.retryPending();});expect(calls("adopt_execution")).toHaveLength(1);
});

it.each(["identity","prepare","adopt"] as const)("stops late adoption %s continuation after project owner destruction",async phase=>{
  const rendered=render(<Harness/>,project);await start();const original=invoke.getMockImplementation()!,response=deferred<unknown>();
  const command=phase==="identity"?"create_execution_identity":phase==="prepare"?"prepare_execution_adoption":"adopt_execution";
  invoke.mockImplementation((name:string,payload:unknown)=>name===command?response.promise:original(name,payload));
  let pending!:Promise<void>;act(()=>{pending=execute("adopt");});await waitFor(()=>expect(calls(command).length).toBeGreaterThan(0));
  const captured=owner;rendered.unmount();
  const request=payloads("prepare_execution_adoption")[0] as PrepareRequest|undefined;
  await act(async()=>{response.resolve(phase==="identity"?fixtureIdentity(999):phase==="prepare"?actionFor(request!):receiptFor(action));await pending;});
  expect(Object.values(captured.current().saved)).toHaveLength(0);
  if(phase==="identity")expect(calls("prepare_execution_adoption")).toHaveLength(0);
  if(phase==="prepare")expect(calls("adopt_execution")).toHaveLength(0);
});

it("rechecks current source, removed locale, newer settings and candidate proof after identity without dispatch",async()=>{
  const rendered=render(<Harness/>,project);await start();const response=deferred<string>(),original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="create_execution_identity"?response.promise:original(command,payload));
  let pending!:Promise<void>;act(()=>{pending=execute("adopt");});
  act(()=>{reads.invalidate(["source"]);owner.setConfig({...owner.config,maxRequests:80});});
  rendered.rerender(<Harness/>,{...project,metadata:{...project.metadata,targetLocales:[]}});
  await act(async()=>{response.resolve(fixtureIdentity(999));await pending;});
  expect(calls("prepare_execution_adoption")).toHaveLength(0);expect(owner.prepared).toBeNull();expect(owner.consent).toBe(false);
  expect(owner.config.maxRequests).toBe(80);expect(owner.targetAvailable).toBe(false);
});

it("retains original unknown actions and fixed drafts after source, resource and locale invalidation",async()=>{
  const rendered=render(<Harness/>,project);await merge();const basis=owner.draft!.basis,original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="save_arena_merge"?Promise.reject({code:"outcome-unknown"}):original(command,payload));
  await act(async()=>{await owner.saveMerge();});const request=owner.pending!.request;
  act(()=>reads.invalidate(["source","resources"]));rendered.rerender(<Harness/>,{...project,metadata:{...project.metadata,targetLocales:[]}});
  expect(owner.pending!.request).toEqual(request);expect(owner.draft!.basis).toBe(basis);expect(owner.draft!.stale).toBe(true);
  invoke.mockImplementation((command:string,payload:unknown)=>command==="read_translation_action"?Promise.resolve(selectionFor(request as Parameters<typeof selectionFor>[0])):original(command,payload));
  await act(async()=>{await owner.checkPending();});expect(owner.pending).toBeNull();expect(owner.notice).toBe("reconciled");
});

it("accepts exactly 100 expanded items and rejects 100 sources by four variants before Host preview, without slicing",async()=>{
  render(<Harness/>,project);const base=prepared.preview.items[0].item;
  const originals=Array.from({length:100},(_,index)=>({...base,unitId:fixtureIdentity(3000+index),sourceRevisionId:fixtureIdentity(3200+index),nativeKey:`key-${index}`}));
  prepared.preview.items=originals.slice(0,25).flatMap((item,sourceOrder)=>Array.from({length:4},(_,slot)=>({sourceOrder,slot,item})));
  prepared.preview.config={...prepared.preview.config,variants:Array.from({length:4},()=>({...prepared.preview.config.variants[0]})),maxItems:100,maxRequests:300};
  await prepare();expect(owner.prepared!.preview.items).toHaveLength(100);
  await act(async()=>{await owner.start();});confirmArenaView(viewFor(),aiAttempt,prepared);
  act(()=>{owner.setSelected(originals.map(item=>item.unitId));});const count=calls("preview_arena_translation").length;
  await act(async()=>{await owner.preview();});expect(calls("preview_arena_translation")).toHaveLength(count);expect(owner.selected).toHaveLength(100);
  expect(owner.prepared).toBeNull();expect(owner.failure).toBe("arena-limits");
});

it("proves the whole shuffled matrix with different per-variant terms and context and repeated identical inputs",()=>{
  const first=prepared.preview.items[0].item,second={...first,unitId:fixtureIdentity(3400),sourceRevisionId:fixtureIdentity(3401),nativeKey:"second"};
  const withResources=(item:typeof first)=>({...item,terms:[{revisionId:fixtureIdentity(3402),source:"barrel",target:"桶",protected:true}],
    context:{revisionId:fixtureIdentity(3403),previousRevisionId:null,unitId:item.unitId,locale:item.targetLocale,text:"Context",reason:"synthetic"},omissions:[]});
  prepared.preview.items=[{sourceOrder:0,slot:0,item:first},{sourceOrder:0,slot:1,item:withResources(first)},
    {sourceOrder:1,slot:0,item:second},{sourceOrder:1,slot:1,item:withResources(second)}];
  const view=viewFor(prepared,[1,0]);expect(()=>confirmArenaView(view,aiAttempt,prepared)).not.toThrow();
  const repeated=structuredClone(prepared);repeated.preview.items.forEach(row=>{row.item={...row.item,terms:[],context:null,omissions:first.omissions};});
  expect(()=>confirmArenaView(viewFor(repeated,[1,0]),aiAttempt,repeated)).not.toThrow();
  const changed=structuredClone(view);changed.rows.find(row=>row.sourceOrder===1&&row.label===0)!.item=second;
  expect(()=>confirmArenaView(changed,aiAttempt,prepared)).toThrow();
  const inconsistent=structuredClone(view);inconsistent.rows.filter(row=>row.sourceOrder===1).forEach(row=>{row.label=1-row.label;});
  expect(()=>confirmArenaView(inconsistent,aiAttempt,prepared)).toThrow();
});

it.each(["partial","nextOffset","duplicateItem","duplicateResult","matrix","namespace","recovery","sourceProof","privacy"] as const)("rejects invalid whole-round %s evidence",field=>{
  const view=viewFor();
  if(field==="partial")view.detail.items.pop();
  if(field==="nextOffset")view.detail.nextOffset=100;
  if(field==="duplicateItem")view.rows[1].itemId=view.rows[0].itemId;
  if(field==="duplicateResult")view.rows[1].resultId=view.rows[0].resultId;
  if(field==="matrix")view.rows[1].label=view.rows[0].label;
  if(field==="namespace")view.detail.items[0].scope.kind="translation";
  if(field==="recovery")view.detail.recovery.units[0].resultIds=[];
  if(field==="sourceProof")view.rows[0].item={...view.rows[0].item,sourceText:"Different captured source"};
  if(field==="privacy")view.variants=prepared.preview.config.variants;
  expect(()=>confirmArenaView(view,aiAttempt,prepared)).toThrow();
});

function savedArenaConnection() {
  return {...prepared.preview.config.variants[0],endpoint:"https://saved.example.test/v1",model:"Saved Arena model",credentialEnv:"SYNTHETIC_REFERENCE",tokenField:"max_completion_tokens",
    connectionProfile:{storeId:fixtureIdentity(700),profileId:fixtureIdentity(701),revision:"1",digest:"a".repeat(64)}};
}
it("selects one scheme's saved defaults without changing other schemes or the shared budget",()=>{
  render(<Harness/>,project);act(()=>owner.setConfig(prepared.preview.config));const before=owner.config,config=savedArenaConnection(),view=connectionFixture([config]);
  act(()=>{application.setQueryData(connectionReadKey,view);expect(owner.selectConnection(1,view,config.connectionProfile.profileId,owner.editSeq)).toBe(true);});
  expect(owner.config.variants[0]).toEqual(before.variants[0]);expect(owner.config.variants[1]).toMatchObject({...view.snapshot.profiles[0].connection,connectionProfile:view.references[0]});
  expect([owner.config.maxItems,owner.config.maxRequests,owner.config.concurrency,owner.config.blind]).toEqual([before.maxItems,before.maxRequests,before.concurrency,before.blind]);
  expect(owner.config.variants[1].maxOutputTokens).toBe(before.variants[1].maxOutputTokens);expect(calls("preview_arena_translation")).toHaveLength(0);
  act(()=>owner.setConfig({...owner.config,variants:owner.config.variants.map((value,index)=>index===1?{...value,model:"Manual B"}:value)}));expect(owner.config.variants[1].connectionProfile).toBeNull();expect(application.getQueryData(connectionReadKey)).toEqual(view);
});
it("invalidates a new round's consent for a changed selected profile without making an offline merge stale",async()=>{
  render(<Harness/>,project);await merge();const draft=owner.draft,config=savedArenaConnection(),view=connectionFixture([config]);
  act(()=>{application.setQueryData(connectionReadKey,view);expect(owner.selectConnection(1,view,config.connectionProfile.profileId,owner.editSeq)).toBe(true);owner.setSelected([prepared.preview.items[0].item.unitId]);});
  await act(async()=>owner.preview());act(()=>owner.setConsent(true));expect(owner.canStart()).toBe(true);
  const changed=structuredClone(view);changed.snapshot.revision="2";changed.basis.revision="2";changed.snapshot.profiles[0].revision="2";changed.references[0].revision="2";changed.references[0].digest="b".repeat(64);
  act(()=>application.setQueryData(connectionReadKey,changed));expect(owner.prepared).toBeNull();expect(owner.consent).toBe(false);expect(owner.draft).toEqual(draft);expect(owner.draft?.stale).toBe(false);
});

it.each([["extracted",true],["inferred",true],["neighbors",true],["maxBytes",2048],["maxItems",4]] as const)("revokes Arena consent for source context %s without changing another variant", async (key,value) => {
  render(<Harness />, project); await prepare();
  const before = owner.current();
  expect(before.prepared).not.toBeNull(); expect(before.consent).toBe(true);
  act(() => { owner.setConfig({...before.config,variants:before.config.variants.map((variant,index) => index === 0
    ? {...variant,sourceContext:{...variant.sourceContext,[key]:value}} : variant)}); });
  expect(owner.prepared).toBeNull(); expect(owner.consent).toBe(false); expect(owner.canStart()).toBe(false);
  expect(owner.config.variants[0].sourceContext[key]).toBe(value);
  expect(owner.config.variants[1]).toEqual(before.config.variants[1]);
  expect(owner.config.maxRequests).toBe(before.config.maxRequests);
  expect(calls("start_arena_translation")).toHaveLength(0);
});

it("receives a checked offline target without replacing manual B or model settings, and refuses newer choices", () => {
  render(<Probe/>, project);
  act(() => { translations.begin({unitId:fixtureIdentity(1901),locale:"zh-CN",sourceRevisionId:fixtureIdentity(1902),key:"manual",sourceText:"Original"},null,null,"Manual B");
    owner.setConfig(value=>({...value,variants:value.variants.map(variant=>({...variant,model:"Kept model"}))})); });
  const before=owner.current();
  act(()=>expect(owner.receiveComparisonTarget(comparison.unitId,"zh-CN",comparison.rows[0].revisionId,before)).toBe(true));
  expect(owner.current().unit).toBe(comparison.unitId);expect(owner.current().references).toEqual([comparison.rows[0].revisionId]);
  expect(owner.current().config.variants[0].model).toBe("Kept model");expect(translations.current()?.text).toBe("Manual B");
  const captured=owner.current();act(()=>owner.setReferences(comparison.rows.map(row=>row.revisionId)));
  act(()=>expect(owner.receiveComparisonTarget(fixtureIdentity(1903),"zh-CN",fixtureIdentity(1904),captured)).toBe(false));
  expect(owner.current().references).toEqual(comparison.rows.map(row=>row.revisionId));
  expect(calls("create_execution_identity")).toHaveLength(0);expect(calls("create_arena_comparison")).toHaveLength(0);
});

it("keeps rejected comparison rows readable but refuses direct selection until a fresh restored projection", () => {
  render(<Probe/>, project);act(()=>owner.openComparison(comparison.comparisonId!));
  comparison={...comparison,rows:comparison.rows.map((row,index)=>({...row,candidateDisposition:index===0?"rejected" as const:null}))};
  act(()=>reads.client.setQueryData(reads.key(["arena-comparison",comparison.comparisonId]),comparison));
  expect(owner.canSelect(comparison,comparison.rows[0].revisionId)).toBe(false);
  expect(owner.canSelect(comparison,comparison.rows[1].revisionId)).toBe(true);
  expect(comparison.rows[0].text).toBeTruthy();expect(comparison.rows[0].model).toBeNull();
  const old=comparison;
  comparison={...comparison,rows:comparison.rows.map((row,index)=>({...row,candidateDisposition:index===0?"restored" as const:null}))};
  act(()=>reads.client.setQueryData(reads.key(["arena-comparison",comparison.comparisonId]),comparison));
  expect(owner.canSelect(old,old.rows[0].revisionId)).toBe(false);
  expect(owner.canSelect(comparison,comparison.rows[0].revisionId)).toBe(true);
});
