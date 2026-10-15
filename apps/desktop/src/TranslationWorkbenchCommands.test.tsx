import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/translation-commands.json";
import { TranslationWorkbench } from "./TranslationWorkbench";
import { useTranslationImportSession } from "./TranslationImportSession";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands, type TranslationImportSetupCommandPayload, type TranslationImportConsentCommandPayload,
  type TranslationImportPreviewCommandPayload, type TranslationImportRowCommandPayload, type TranslationImportRowTarget,
  type TranslationImportBatchCommandPayload, type TranslationImportPendingCommandPayload, type TranslationRevisionCommandPayload,
  type TranslationSelectionPendingCommandPayload } from "./workbenchCommands";
import { isCommandError, hasUnknownOutcome, type CommandError, type ProjectView } from "./projectCommands";
import type { TranslationAdoptRequest, TranslationHistory, TranslationRevision, TranslationSelectRequest, TranslationSelection, TranslationPreview, TranslationPreviewRow } from "./translationCommands";
import { validateRequestAdopt, validateRequestSelect } from "./generated/translation.validators";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { translationActionFixture, translationAttemptFixture, translationPreviewFixture, translationReceiptFixture, translationRecoveryUnit, translationRowFixture, translationImportChoice, translationSelectionFixture, translationCaptureFixture, translationCheckerFixture, translationProjectionFixture, translationStageAttempt } from "./testSupport/translationFixture";
import { reviewSummaryFor, reviewSummaryPageFixture, reviewTargetFixture } from "./testSupport/reviewFixture";
import { sourcePageFixture } from "./testSupport/sourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { translationInventory, translationPackage, translationView } from "./testSupport/pluginTranslationFixture";
import { i18n } from "./i18n";

const invoke=vi.hoisted(()=>vi.fn());vi.mock("@tauri-apps/api/core",()=>({invoke}));
const project:ProjectView={sessionToken:fixture.start.sessionToken,locator:"isolated",reconciliationState:"settled",
  metadata:{projectId:fixture.start.projectId,displayName:"Translation commands",sourceLocale:"en",targetLocales:["zh-CN"],metadataRevision:"1"}};
const scope={projectId:project.metadata.projectId,sessionToken:project.sessionToken,area:"translation" as const};
let imports:ReturnType<typeof useTranslationImportSession>,drafts:ReturnType<typeof useTranslationDraftSession>,reads:ReturnType<typeof useSessionReads>,registry:ReturnType<typeof useWorkbenchCommands>;
let qualified:boolean;
let preview:TranslationPreview,history:TranslationHistory,candidate:TranslationRevision,identities:number,importRequests:Map<string,TranslationAdoptRequest>;
function Probe(){
  const imported=useTranslationImportSession(),draft=useTranslationDraftSession(),reader=useSessionReads(),commands=useWorkbenchCommands();
  useLayoutEffect(()=>{imports=imported;drafts=draft;reads=reader;registry=commands;});return null;
}
function Harness({consumer=true,project:current=project}:{consumer?:boolean;project?:ProjectView}){return <><Probe/>{consumer?<TranslationWorkbench project={current} disabled={false}/>:null}</>;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function calls(command:string){return invoke.mock.calls.filter(([name])=>name===command);}
function originalRequests(command:string){return calls(command).map(([,args])=>args.request);}
function mutationRejection(): CommandError {
  // ExecutionHost.allow_mutation rejects a quiescing host before any write.
  const failure: CommandError = { code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false };
  expect(isCommandError(failure)).toBe(true); expect(hasUnknownOutcome(failure)).toBe(false);
  return failure;
}
function target(){return reviewTargetFixture({unitId:candidate.unitId,locale:"zh-CN",nativeKey:"entry",sourceText:"Original",
  sourceSnapshotId:preview.fixedSourceSnapshotId,sourceRevisionId:candidate.sourceRevisionId,selectionId:history.current?.eventId??null,
  revisionId:history.current?.revisionId??null,translationText:history.currentText});}
function editorResponse(){return{target:target(),translations:history,terms:{unitId:candidate.unitId,locale:"zh-CN",sourceRevisionId:candidate.sourceRevisionId,entries:[]},context:null,readVersion:"view"};}
function selection(request:TranslationSelectRequest):TranslationSelection{return{actionId:request.actionId,unitId:request.unitId,locale:request.locale,
  eventId:fixtureIdentity(970),revisionId:request.revisionId,sequence:"1",previousEventId:request.expectedSelectionId??null};}
beforeEach(async()=>{
  await i18n.changeLanguage("en-US");invoke.mockReset();qualified=false;identities=700;importRequests=new Map();
  preview=translationPreviewFixture();const row=preview.rows[0];if(!row.unitId||!row.sourceRevisionId)throw new Error("Expected complete target fixture");
  candidate={...fixture.receipt.revision,unitId:row.unitId,locale:"zh-CN",ordinal:"1",sourceRevisionId:row.sourceRevisionId,
    sourceSnapshotId:preview.fixedSourceSnapshotId,originKind:"manual",text:"Historical candidate",contributors:[],attemptId:null,resultId:null,itemId:null,
    artifactId:null,logicalPath:null,declaredLocale:null,nativeKey:null,fileDigest:null};
  history={unitId:candidate.unitId,locale:"zh-CN",current:null,currentText:null,total:"1",rows:[candidate],nextOrdinal:null};
  invoke.mockImplementation(async(command:string,{request}: {request:Record<string,unknown>})=>{
    if(command==="read_content_scope")return{revision:"1",currentSnapshot:preview.currentSourceSnapshotId};
    if(command==="read_source_content")return sourcePageFixture({snapshotId:preview.currentSourceSnapshotId,scope:{revision:"1",currentSnapshot:preview.currentSourceSnapshotId},namespace:"Example.Mod"});
    if(command==="read_review_summary_page")return reviewSummaryPageFixture([reviewSummaryFor(target())]);
    if(command==="read_review_editor_snapshot")return editorResponse();
    if(command==="read_translation_history")return history;
    if(command==="read_plugin_inventory")return translationInventory;
    if(command==="read_plugin_package")return translationPackage;
    if(command==="read_plugin_translation")return translationView;
    if(command==="read_plugin_translation_source")return translationImportChoice(preview.fixedSourceSnapshotId).source;
    if(command==="select_plugin_translation")return translationSelectionFixture(preview.fixedSourceSnapshotId);
    if(command==="list_plugin_translation_files")return["zh.json"];
    if(command==="preflight_plugin_translation")return translationCaptureFixture(String(request.attemptId),preview.fixedSourceSnapshotId);
    if(command==="prepare_translation_check")return translationCheckerFixture(String(request.attemptId),String(request.translationAttemptId),String(request.translationResultId),preview.fixedSourceSnapshotId);
    if(command==="start_translation_check")return request.attemptId;
    if(command==="finish_translation_check"){qualified=true;return null;}
    if(command==="prepare_translation_projection")return translationProjectionFixture(String(request.attemptId),String(request.translationAttemptId),String(request.translationResultId),preview.fixedSourceSnapshotId);
    if(command==="start_translation_projection")return request.attemptId;
    if(command==="read_work_protection")return {unitId:request.unitId,locale:request.locale,revision:"1",protected:true};
    if(command==="create_execution_identity")return fixtureIdentity(identities++);
    if(command==="start_plugin_translation")return request.attemptId;
    if(command==="read_translation_preview"){
      const rows=preview.rows.filter(row=>row.entry.ordinal>=Number(request.after)).slice(0,Math.min(1,Number(request.limit))),last=rows.at(-1)?.entry.ordinal;
      return{...preview,attemptId:request.attemptId,rows,nextOrdinal:last!==undefined&&last+1<preview.total?last+1:null};
    }
    if(command==="read_execution_attempt"){
      if(request.attemptId===imports.current().extractionAttempt)return translationStageAttempt(String(request.attemptId),"translation-extract",qualified?"valid":"pending");
      if(request.attemptId===imports.current().checkAttempt)return translationStageAttempt(String(request.attemptId),"translation-semantic-check","valid");
      const offset=Number(request.offset),rows=preview.rows.slice(offset,offset+1);
      return translationAttemptFixture({...preview,attemptId:String(request.attemptId)},rows,offset+rows.length<preview.total?offset+rows.length:null);
    }
    if(command==="prepare_translation_adoption"){
      if(!validateRequestAdopt(request))throw new Error("Invalid original adoption request");importRequests.set(request.actionId,request);
      const row=preview.rows.find(row=>row.itemId===request.itemId);if(!row)throw new Error("Unknown item");return translationActionFixture(request,translationRecoveryUnit(row));
    }
    if(command==="adopt_execution"||command==="read_execution_receipt"){
      const original=importRequests.get(String(request.actionId));if(!original)return null;
      const row=preview.rows.find(row=>row.itemId===original.itemId);if(!row)throw new Error("Unknown original item");return translationReceiptFixture(original,translationRecoveryUnit(row),row.currentSelection?.sequence??null);
    }
    if(command==="select_translation_revision"){
      if(!validateRequestSelect(request))throw new Error("Invalid original selection request");const result=selection(request);
      history={...history,current:result,currentText:candidate.text};return result;
    }
    if(command==="read_translation_action")return history.current;
    throw new Error(command);
  });
});
afterEach(cleanup);
function setup():TranslationImportSetupCommandPayload{const value=imports.current();return{kind:"translation-import-setup",editSeq:value.editSeq,
  locale:value.targetLocale,selectionId:value.folder?.selectionId??null,fileName:value.fileName};}
function consent(confirmed=imports.current().confirmed):TranslationImportConsentCommandPayload{
  const checked=imports.current().preflight;if(!checked)throw new Error("Expected preflight");return{...setup(),kind:"translation-import-consent",
    sourceSnapshotId:checked.source.sourceSnapshotId,fileDigest:checked.file.sha256,inputDigest:checked.inputDigest,producerConsent:imports.current().producerConsent===checked.inputDigest,confirmed};
}
function previewTarget(value=imports.current().preview,editSeq=imports.current().editSeq){if(!value)throw new Error("Expected fixed preview");return{editSeq,
  attemptId:value.attemptId,bundleId:value.bundleId,basis:value.basis,locale:value.targetLocale,fixedSourceSnapshotId:value.fixedSourceSnapshotId,
  currentSourceSnapshotId:value.currentSourceSnapshotId,fileDigest:value.fileDigest,previewResultDigest:value.resultDigest};}
function rowTarget(row:TranslationPreviewRow):TranslationImportRowTarget{if(!row.unitId||!row.occurrenceId||!row.sourceRevisionId)throw new Error("Expected fixed target");
  return{ordinal:row.entry.ordinal,itemId:row.itemId,resultId:row.resultId,resultDigest:row.resultDigest,unitId:row.unitId,occurrenceId:row.occurrenceId,
    sourceRevisionId:row.sourceRevisionId,expectedSelectionId:row.currentSelection?.eventId??null};}
function rowPayload():TranslationImportRowCommandPayload{const value=imports.current().rowAction;if(!value)throw new Error("Expected row confirmation");return{kind:"translation-import-row",
  ...previewTarget(value.preview,value.editSeq),...rowTarget(value.row),decision:value.decision};}
function batchPayload():TranslationImportBatchCommandPayload{const value=imports.current().batchCapture;if(!value||value.decision==="replace")throw new Error("Expected fixed batch");
  return{kind:"translation-import-batch",...previewTarget(value.preview,value.editSeq),rows:value.eligible.map(rowTarget),decision:value.decision,excluded:value.excluded};}
function importPending():TranslationImportPendingCommandPayload{const value=imports.current().uncertain[0];if(!value)throw new Error("Expected original unknown request");
  return{kind:"translation-import-pending",request:structuredClone(value.request),recoveryUnitId:value.recoveryUnitId,previousSelectionSequence:value.previousSelectionSequence};}
function revisionPayload():TranslationRevisionCommandPayload{const value=drafts.current();if(!value)throw new Error("Expected editor capture");return{kind:"translation-revision",
  unitId:value.unitId,locale:value.locale,sourceRevisionId:value.sourceRevisionId,expectedSelectionId:value.baseSelectionId,editSeq:value.editSeq,
  revisionId:candidate.revisionId,revisionActionId:candidate.actionId,revisionOrdinal:candidate.ordinal,revisionSourceRevisionId:candidate.sourceRevisionId,revisionSourceSnapshotId:candidate.sourceSnapshotId};}
function selectionPending():TranslationSelectionPendingCommandPayload{const value=drafts.current()?.pendingSelection;if(!value)throw new Error("Expected original selection");
  return{kind:"translation-selection-pending",request:structuredClone(value.request),submittedSeq:value.submittedSeq};}
async function openImport(){const user=userEvent.setup(),view=render(<Harness/>,project);await user.click(screen.getByRole("button",{name:i18n.t("translation.title")}));
  await user.click(screen.getByRole("button",{name:i18n.t("translation.importTab")}));
  await user.selectOptions(await screen.findByRole("combobox",{name:i18n.t("translationPlugin.package")}),`${translationPackage.packageDigest}:${translationView.resourceId}`);
  await user.selectOptions(screen.getByRole("combobox",{name:i18n.t("sourcePlugin.runtime")}),translationView.environmentDigest);
  await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("translation.chooseFolder")})).toBeEnabled());
  await user.click(screen.getByRole("button",{name:i18n.t("translation.chooseFolder")}));
  await user.selectOptions(await screen.findByRole("combobox",{name:i18n.t("translation.file")}),"zh.json");
  await user.click(screen.getByRole("checkbox",{name:/I confirm that/}));
  await user.click(screen.getByRole("button",{name:i18n.t("translationPlugin.capture")}));
  await screen.findByRole("checkbox",{name:i18n.t("translationPlugin.producerConsent")});return{user,view};}
async function readyImport(){const result=await openImport();await result.user.click(screen.getByRole("checkbox",{name:i18n.t("translationPlugin.producerConsent")}));
  await result.user.click(screen.getByRole("button",{name:i18n.t("translation.start")}));
  await result.user.click(await screen.findByRole("button",{name:i18n.t("translationPlugin.prepareCheck")}));
  await result.user.click(await screen.findByRole("checkbox",{name:i18n.t("translationPlugin.checkerConsent")}));
  await result.user.click(screen.getByRole("button",{name:i18n.t("translationPlugin.startCheck")}));
  await result.user.click(await screen.findByRole("button",{name:i18n.t("translationPlugin.recordCheck")}));
  await result.user.click(await screen.findByRole("button",{name:i18n.t("translationPlugin.preparePreview")}));
  await result.user.click(await screen.findByRole("button",{name:i18n.t("translationPlugin.openPreview")}));
  await screen.findByRole("heading",{name:i18n.t("translation.preview")});await waitFor(()=>expect(imports.current().preview).not.toBeNull());return result;}
async function readyRow(){const result=await readyImport();await result.user.click(screen.getByRole("button",{name:i18n.t("translation.addCandidate")}));
  await screen.findByRole("dialog",{name:i18n.t("translation.addCandidate")});return result;}
async function readyEditor(){const user=userEvent.setup(),view=render(<Harness/>,project);await user.click(screen.getByRole("button",{name:i18n.t("translation.title")}));
  await user.click(await screen.findByRole("button",{name:"entry"}));await screen.findByRole("textbox",{name:i18n.t("translation.draft")});
  await waitFor(()=>expect(registry.describe("translation.select-revision",scope,revisionPayload())?.availability.enabled).toBe(true));return{user,view};}

it("registers import and content row commands and confirms an ordered complete multi-page import batch through the UI",async()=>{
  preview=translationPreviewFixture([translationRowFixture(0),translationRowFixture(1),translationRowFixture(2)]);const {user}=await readyImport(),dispatch=vi.spyOn(registry,"dispatch");
  expect(registry.list(scope).filter(value=>value.payloadKind?.startsWith("translation-")).map(value=>value.id).sort()).toEqual([
    "translation.apply-import-batch","translation.apply-import-row","translation.capture-import-batch","translation.check-candidate-decision","translation.check-import-receipt","translation.check-selection",
    "translation.choose-import-folder","translation.choose-import-row","translation.confirm-import-language","translation.decide-candidate","translation.edit-context","translation.inspect-import","translation.open-comparison","translation.retry-candidate-decision","translation.retry-import-action",
    "translation.retry-import-start","translation.retry-selection","translation.select-revision","translation.start-import","translation.toggle-content-selection",
    "translation.prepare-import-check","translation.start-import-check","translation.finish-import-check","translation.prepare-import-projection","translation.start-import-projection","translation.retry-import-plugin",
  ].sort());
  const previewPayload:TranslationImportPreviewCommandPayload={kind:"translation-import-preview",...previewTarget(),selectIfEmpty:false};
  expect(registry.dispatch("translation.capture-import-batch",{...scope,sessionToken:"wrong"},previewPayload)).toBe(false);
  await user.click(screen.getByRole("button",{name:i18n.t("translation.apply",{count:3})}));const dialog=await screen.findByRole("dialog",{name:i18n.t("translation.batchConfirm")});
  const payload=batchPayload();expect(payload.rows.map(row=>row.itemId)).toEqual(preview.rows.map(row=>row.itemId));
  expect(registry.dispatch("translation.apply-import-batch",scope,{...payload,rows:payload.rows.slice(1)})).toBe(false);
  await user.click(within(dialog).getByRole("button",{name:i18n.t("translation.batchStart")}));await waitFor(()=>expect(calls("adopt_execution")).toHaveLength(3));
  expect(dispatch).toHaveBeenCalledWith("translation.apply-import-batch",scope,payload);
  expect(originalRequests("prepare_translation_adoption").map(request=>request.itemId)).toEqual(preview.rows.map(row=>row.itemId));
  await waitFor(()=>expect(imports.current().batchOutcome).toEqual({applied:3,conflicted:0,failed:0,unknown:0}));
});

it("denies wrong file consent and a current Query error before allocating a new import identity",async()=>{
  const {user}=await openImport();await user.click(screen.getByRole("checkbox",{name:i18n.t("translationPlugin.producerConsent")}));const payload=consent();
  expect(registry.dispatch("translation.start-import",scope,{...payload,fileDigest:"different"})).toBe(false);
  const query=reads.client.getQueryCache().find({queryKey:reads.key(["translation-plugin-source", "zh-CN"]),exact:true})!;
  act(()=>query.setState({fetchStatus:"fetching"}));expect(registry.describe("translation.start-import",scope,payload)?.availability.enabled).toBe(false);
  act(()=>query.setState({status:"error",fetchStatus:"idle",error:new Error("Current source unavailable")}));
  expect(registry.describe("translation.start-import",scope,payload)?.availability.enabled).toBe(false);
  await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("translation.start")})).toBeDisabled());expect(calls("create_execution_identity")).toHaveLength(1);
});

it.each(["error","contradiction"] as const)("retains removed replacement source Query %s during start identity and releases the witness",async change=>{
  const {user,view}=await openImport();await user.click(screen.getByRole("checkbox",{name:i18n.t("translationPlugin.producerConsent")}));const identity=deferred<string>(),original=invoke.getMockImplementation()!,dispose=vi.fn(),watch=reads.watchExactQuery.bind(reads);
  vi.spyOn(reads,"watchExactQuery").mockImplementation(key=>{const proof=watch(key);return{current:proof.current,dispose:()=>{dispose();proof.dispose();}};});
  invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:original(command,args));
  act(()=>{expect(registry.dispatch("translation.start-import",scope,consent())).toBe(true);expect(registry.dispatch("translation.start-import",scope,consent())).toBe(false);});
  await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(2));view.rerender(<Harness consumer={false}/>,project);const key=reads.key(["translation-plugin-source", "zh-CN"]);
  act(()=>{reads.client.removeQueries({queryKey:key,exact:true});reads.client.setQueryData(key,{...translationImportChoice(preview.fixedSourceSnapshotId).source,sourceSnapshotId:change==="contradiction"?fixtureIdentity(999):preview.currentSourceSnapshotId});
    if(change==="error")reads.client.getQueryCache().find({queryKey:key,exact:true})!.setState({status:"error",error:new Error("Replacement failed")});reads.client.removeQueries({queryKey:key,exact:true});});
  await act(async()=>identity.resolve(fixtureIdentity(900)));await waitFor(()=>expect(imports.current().busy).toBe(false));expect(calls("start_plugin_translation")).toHaveLength(0);expect(dispose).toHaveBeenCalledTimes(2);
});

it.each(["gc","retire","destroy"] as const)("distinguishes pure view eviction from a real session boundary while start waits (%s)",async boundary=>{
  const {user,view}=await openImport();await user.click(screen.getByRole("checkbox",{name:i18n.t("translationPlugin.producerConsent")}));
  const identity=deferred<string>(),original=invoke.getMockImplementation()!,dispose=vi.fn(),watch=reads.watchExactQuery.bind(reads);
  vi.spyOn(reads,"watchExactQuery").mockImplementation(key=>{const proof=watch(key);return{current:proof.current,dispose:()=>{dispose();proof.dispose();}};});
  invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:original(command,args));
  act(()=>{expect(registry.dispatch("translation.start-import",scope,consent())).toBe(true);});await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(2));
  if(boundary==="destroy"){view.unmount();expect(dispose).toHaveBeenCalledTimes(2);}
  else{view.rerender(<Harness consumer={false}/>,project);act(()=>{if(boundary==="retire")reads.retire();else reads.client.clear();});}
  await act(async()=>identity.resolve(fixtureIdentity(999)));
  if(boundary==="gc"){await waitFor(()=>expect(imports.current().extractionAttempt).toBe(imports.current().preflight?.attemptId));expect(calls("start_plugin_translation")).toHaveLength(1);}
  else expect(calls("start_plugin_translation")).toHaveLength(0);
  expect(dispose).toHaveBeenCalledTimes(2);
});

it("keeps a checked row confirmation actionable under pure source read failure and continues it through consumer removal without changing B",async()=>{
  const {view}=await readyRow();act(()=>drafts.begin({unitId:candidate.unitId,locale:"zh-CN",sourceRevisionId:candidate.sourceRevisionId,key:"entry",sourceText:"Original"},null,null));
  const sourceQuery=reads.client.getQueryCache().find({queryKey:reads.key(["translation-plugin-source", "zh-CN"]),exact:true})!;
  act(()=>sourceQuery.setState({status:"error",error:new Error("Pure view read failed")}));const payload=rowPayload();
  expect(registry.describe("translation.apply-import-row",scope,payload)?.availability.enabled).toBe(true);
  await waitFor(()=>expect(within(screen.getByRole("dialog",{name:i18n.t("translation.addCandidate")})).getByRole("button",{name:i18n.t("translation.addCandidate")})).toBeEnabled());
  const identity=deferred<string>(),original=invoke.getMockImplementation()!;invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:original(command,args));
  act(()=>{expect(registry.dispatch("translation.apply-import-row",scope,payload)).toBe(true);expect(registry.dispatch("translation.apply-import-row",scope,payload)).toBe(false);});
  await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(6));view.rerender(<Harness consumer={false}/>,project);act(()=>{reads.client.clear();drafts.edit("Newer B");});
  await act(async()=>identity.resolve(fixtureIdentity(999)));await waitFor(()=>expect(imports.current().completionVersion).toBe(1));
  expect(drafts.current()?.text).toBe("Newer B");expect(originalRequests("prepare_translation_adoption")[0].confirmation).toMatchObject({targetUnitId:payload.unitId,decision:payload.decision,resultDigest:payload.resultDigest});
  expect(registry.describe("translation.apply-import-row",scope,payload)).toBeUndefined();
});

it("keeps an original import retry behind actual missing-receipt permission despite newer queries and locale removal",async()=>{
  const {view}=await readyRow();const original=invoke.getMockImplementation()!,rejected=mutationRejection();
  invoke.mockImplementation((command:string,args)=>command==="adopt_execution"?Promise.reject(new Error("ACK lost")):original(command,args));
  await act(async()=>{registry.dispatch("translation.apply-import-row",scope,rowPayload());});await waitFor(()=>expect(imports.current().uncertain).toHaveLength(1));const payload=importPending();
  expect(registry.dispatch("translation.retry-import-action",scope,payload)).toBe(false);
  expect(registry.dispatch("translation.check-import-receipt",scope,{...payload,request:{...payload.request,resultId:fixtureIdentity(999)}})).toBe(false);
  invoke.mockImplementation((command:string,args)=>command==="read_execution_receipt"?Promise.resolve(null):command==="prepare_translation_adoption"?
    Promise.reject(rejected):original(command,args));
  const removed={...project,metadata:{...project.metadata,targetLocales:[]}};view.rerender(<Harness project={removed}/>,removed);
  act(()=>reads.client.clear());await act(async()=>{expect(registry.dispatch("translation.check-import-receipt",scope,payload)).toBe(true);});
  await waitFor(()=>expect(registry.describe("translation.retry-import-action",scope,payload)?.availability.enabled).toBe(true));
  await act(async()=>{expect(registry.dispatch("translation.retry-import-action",scope,payload)).toBe(true);});
  expect(imports.current().uncertain[0]).toMatchObject({request:payload.request,receiptChecked:false});expect(originalRequests("prepare_translation_adoption")).toEqual([payload.request,payload.request]);
  // Capture, producer grant, checker attempt/grant, projection and original adoption.
  expect(calls("create_execution_identity")).toHaveLength(6);
});

it.each(["error","contradiction"] as const)("rejects a removed replacement editor Query %s while the exact historical selection identity is pending",async change=>{
  const {view}=await readyEditor(),identity=deferred<string>(),original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:original(command,args));const payload=revisionPayload();
  expect(registry.dispatch("translation.select-revision",scope,{...payload,revisionId:fixtureIdentity(999)})).toBe(false);
  act(()=>{expect(registry.dispatch("translation.select-revision",scope,payload)).toBe(true);expect(registry.dispatch("translation.select-revision",scope,payload)).toBe(false);});
  await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(1));const query=reads.client.getQueryCache().findAll({predicate:value=>value.queryKey[2]==="translation-editor"}).find(value=>value.state.data);
  if(!query)throw new Error("Expected exact checked editor Query");const key=query.queryKey;view.rerender(<Harness consumer={false}/>,project);
  act(()=>{reads.client.removeQueries({queryKey:key,exact:true});reads.client.setQueryData(key,{...editorResponse(),target:change==="contradiction"?{...target(),sourceRevisionId:fixtureIdentity(999)}:target()});
    if(change==="error")reads.client.getQueryCache().find({queryKey:key,exact:true})!.setState({status:"error",error:new Error("Replacement failed")});reads.client.removeQueries({queryKey:key,exact:true});});
  await act(async()=>identity.resolve(fixtureIdentity(999)));await waitFor(()=>expect(drafts.current()?.selecting).toBe(false));expect(calls("select_translation_revision")).toHaveLength(0);
});

it("routes the actual historical selection button with the exact current basis and captured immutable revision",async()=>{
  const {user}=await readyEditor(),payload=revisionPayload(),dispatch=vi.spyOn(registry,"dispatch");
  expect(registry.dispatch("translation.select-revision",scope,{...payload,expectedSelectionId:fixtureIdentity(999)})).toBe(false);
  await user.click(screen.getByRole("button",{name:i18n.t("translation.selectRevision")}));
  await waitFor(()=>expect(drafts.current()?.baseRevisionId).toBe(candidate.revisionId));
  expect(dispatch).toHaveBeenCalledWith("translation.select-revision",scope,payload);
  expect(originalRequests("select_translation_revision")[0]).toMatchObject({unitId:payload.unitId,locale:payload.locale,sourceRevisionId:payload.sourceRevisionId,
    revisionId:payload.revisionId,expectedSelectionId:payload.expectedSelectionId});expect(calls("create_execution_identity")).toHaveLength(1);
});

it("continues a fixed historical selection across pure eviction and settles a late ACK without replacing newer B",async()=>{
  const {view}=await readyEditor(),identity=deferred<string>(),ack=deferred<TranslationSelection>(),original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:command==="select_translation_revision"?ack.promise:original(command,args));
  act(()=>{expect(registry.dispatch("translation.select-revision",scope,revisionPayload())).toBe(true);});
  await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(1));view.rerender(<Harness consumer={false}/>,project);act(()=>reads.client.clear());
  await act(async()=>identity.resolve(fixtureIdentity(999)));await waitFor(()=>expect(calls("select_translation_revision")).toHaveLength(1));
  const request:unknown=originalRequests("select_translation_revision")[0];if(!validateRequestSelect(request))throw new Error("Expected fixed original selection request");
  act(()=>drafts.edit("Newer B"));await act(async()=>ack.resolve(selection(request)));
  await waitFor(()=>expect(drafts.current()).toMatchObject({baseRevisionId:candidate.revisionId,text:"Newer B",newerDraftSaved:true,pendingSelection:null}));
  expect(calls("create_execution_identity")).toHaveLength(1);expect(calls("select_translation_revision")).toHaveLength(1);
});

it("checks and retries only the original unknown history selection after consumer remount and retains newer B on a late rejection",async()=>{
  const {view}=await readyEditor(),original=invoke.getMockImplementation()!,rejected=mutationRejection();
  invoke.mockImplementation((command:string,args)=>command==="select_translation_revision"?Promise.reject(new Error("ACK lost")):original(command,args));
  await act(async()=>{registry.dispatch("translation.select-revision",scope,revisionPayload());});await waitFor(()=>expect(drafts.current()?.pendingSelection?.request.actionId).toBeDefined());
  const payload=selectionPending();expect(registry.dispatch("translation.retry-selection",scope,payload)).toBe(false);act(()=>drafts.edit("Newer B"));
  view.rerender(<Harness consumer={false}/>,project);act(()=>reads.client.clear());view.rerender(<Harness/>,project);
  await waitFor(()=>expect(registry.describe("translation.check-selection",scope,payload)?.availability.enabled).toBe(true));
  invoke.mockImplementation((command:string,args)=>command==="read_translation_action"?Promise.resolve(null):command==="select_translation_revision"?
    Promise.reject(rejected):original(command,args));
  await act(async()=>{expect(registry.dispatch("translation.check-selection",scope,payload)).toBe(true);});
  await waitFor(()=>expect(registry.describe("translation.retry-selection",scope,payload)?.availability.enabled).toBe(true));
  await act(async()=>{expect(registry.dispatch("translation.retry-selection",scope,payload)).toBe(true);});
  expect(drafts.current()).toMatchObject({text:"Newer B",outcomeUnknown:true,pendingSelection:{request:payload.request,receiptChecked:false}});
  expect(originalRequests("select_translation_revision")).toEqual([payload.request,payload.request]);expect(calls("create_execution_identity")).toHaveLength(1);
});

it("refuses an original captured row dispatch after the real session is retired",async()=>{
  await readyRow();const payload=rowPayload();act(()=>reads.retire());
  expect(registry.dispatch("translation.apply-import-row",scope,payload)).toBe(false);expect(calls("prepare_translation_adoption")).toHaveLength(0);
});

it("records and restores an AI candidate while preserving manual text and the immutable original result", async()=>{
  candidate.originKind="ai";candidate.attemptId=fixture.start.attemptId;candidate.resultId=preview.rows[0].resultId;candidate.itemId=preview.rows[0].itemId;
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args)=>{
    if(command==="decide_translation_candidate"){
      const value={request:args.request.decision,sourceSnapshotId:preview.currentSourceSnapshotId};
      candidate={...candidate,candidateDecision:value};history={...history,rows:[candidate]};return Promise.resolve(value);
    }
    return original(command,args);
  });
  const {user}=await readyEditor();
  act(()=>drafts.edit("Manual B 👩🏽‍💻"));
  expect(screen.getByRole("button",{name:i18n.t("candidateDecisions.reject")})).toBeDisabled();
  await user.type(screen.getByRole("textbox",{name:i18n.t("candidateDecisions.actor")}),"Synthetic reviewer");
  await user.type(screen.getByRole("textbox",{name:i18n.t("candidateDecisions.reason")}),"Wrong meaning");
  expect(screen.getByRole("button",{name:i18n.t("candidateDecisions.reject")})).toBeEnabled();
  await user.click(screen.getByRole("button",{name:i18n.t("candidateDecisions.reject")}));
  await waitFor(()=>expect(calls("decide_translation_candidate")).toHaveLength(1));
  await screen.findByText(i18n.t("candidateDecisions.rejectedRecorded"));
  expect(drafts.candidates.hasDraft()).toBe(false);
  expect(drafts.current()?.text).toBe("Manual B 👩🏽‍💻");
  expect(originalRequests("decide_translation_candidate")[0].decision).toMatchObject({revisionId:candidate.revisionId,actor:"Synthetic reviewer",reason:"Wrong meaning",disposition:"rejected",expectedDecisionId:null});
  await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("candidateDecisions.restore")})).toBeEnabled());
  expect(screen.getByRole("button",{name:i18n.t("translation.selectRevision")})).toBeDisabled();
  expect(calls("select_translation_revision")).toHaveLength(0);expect(calls("save_translation_revision")).toHaveLength(0);
  await user.click(screen.getByRole("button",{name:i18n.t("candidateDecisions.restore")}));
  await screen.findByText(i18n.t("candidateDecisions.restoredRecorded"));
  const requests=originalRequests("decide_translation_candidate");expect(requests).toHaveLength(2);
  expect(requests[1].decision.expectedDecisionId).toBe(requests[0].decision.actionId);expect(requests[1].decision.disposition).toBe("restored");
  expect(candidate.text).toBe("Historical candidate");expect(drafts.current()?.text).toBe("Manual B 👩🏽‍💻");
});

it("checks the original lost candidate-decision receipt after consumer removal without losing newer inputs",async()=>{
  candidate.originKind="ai";candidate.attemptId=fixture.start.attemptId;candidate.resultId=preview.rows[0].resultId;candidate.itemId=preview.rows[0].itemId;
  const original=invoke.getMockImplementation()!;let recorded:unknown;
  invoke.mockImplementation((command:string,args)=>{
    if(command==="decide_translation_candidate"){recorded={request:args.request.decision,sourceSnapshotId:preview.currentSourceSnapshotId};return Promise.reject(new Error("Reply lost"));}
    if(command==="read_translation_candidate_action")return Promise.resolve(recorded);
    return original(command,args);
  });
  const {user,view}=await readyEditor();
  await user.type(screen.getByRole("textbox",{name:i18n.t("candidateDecisions.actor")}),"Reviewer A");
  await user.type(screen.getByRole("textbox",{name:i18n.t("candidateDecisions.reason")}),"Reason A");
  expect(screen.getByRole("button",{name:i18n.t("candidateDecisions.reject")})).toBeEnabled();
  await user.click(screen.getByRole("button",{name:i18n.t("candidateDecisions.reject")}));
  await waitFor(()=>expect(calls("decide_translation_candidate")).toHaveLength(1));
  await screen.findByRole("button",{name:i18n.t("candidateDecisions.check")});
  expect(drafts.candidates.current().pending?.decision.reason).toBe("Reason A");
  act(()=>{drafts.edit("Text B");drafts.candidates.edit("reason","Reason B");});
  expect(drafts.mutationReserved).toBe(true);
  view.rerender(<Harness consumer={false}/>,project);expect(registry.list(scope).find(command=>command.id === "translation.decide-candidate")).toBeUndefined();
  await act(async()=>{await drafts.candidates.check();});
  expect(drafts.candidates.current().pending).toBeNull();expect(drafts.candidates.current().reason).toBe("Reason B");
  expect(drafts.candidates.hasDraft()).toBe(true);
  expect(drafts.current()?.text).toBe("Text B");expect(drafts.mutationReserved).toBe(false);
  expect(calls("decide_translation_candidate")).toHaveLength(1);expect(calls("create_execution_identity")).toHaveLength(1);
  expect(originalRequests("read_translation_candidate_action")[0]).toMatchObject({actionId:originalRequests("decide_translation_candidate")[0].decision.actionId,unitId:candidate.unitId,locale:"zh-CN"});
});

it("opens an exact saved revision for offline comparison without saving the newer manual draft", async()=>{
  const {user,view}=await readyEditor(),compare=vi.fn(async()=>true);
  view.rerender(<><Probe/><TranslationWorkbench project={project} disabled={false} onOpenComparison={compare}/></>,project);
  act(()=>drafts.edit("Newer manual B"));
  const button=await screen.findByRole("button",{name:i18n.t("arena.openFromEntry")});
  await waitFor(()=>expect(button).toBeEnabled());await user.click(button);
  expect(compare).toHaveBeenCalledWith(expect.objectContaining({unitId:candidate.unitId,sourceRevisionId:candidate.sourceRevisionId}),"zh-CN",expect.objectContaining({revisionId:candidate.revisionId,ordinal:candidate.ordinal}));
  expect(drafts.current()?.text).toBe("Newer manual B");expect(calls("save_translation_revision")).toHaveLength(0);expect(calls("select_translation_revision")).toHaveLength(0);
});
