import { createRef, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSessionWorkbench, type OverviewSourcePresentation, type ProjectSessionHandle } from "./ProjectSessionWorkbench";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { WorkspaceViewMemory, WorkspaceViewProvider, type WorkspaceArea } from "./WorkbenchFrame";
import { WorkbenchCommands, WorkbenchCommandsProvider, type ContextEditorTarget } from "./workbenchCommands";
import type { ContextRevision, SaveContext } from "./resourceCommands";
import type { ReviewEditorSnapshot } from "./reviewCommands";
import type { ProjectView } from "./projectCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewSummaryFor, reviewSummaryPageFixture, reviewTargetFixture } from "./testSupport/reviewFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { i18n } from "./i18n";
import { validateResponseChanges } from "./generated/validators";
import { validateResponseScope, validateResponsePage, validateResponseSourceContext } from "./generated/source.validators";
import { validateResponseSummary, validateResponseEditor } from "./generated/review.validators";
import { validateResponseActivity } from "./generated/execution.validators";
import { validateRequestWorkProtectionSet, validateResponseWorkProtection } from "./generated/ai.validators";
import type { WorkProtection } from "./workPlanCommands";

// Fail at the synthetic wire boundary with the command name, rather than
// reducing a missing/invalid fixture to the consumer's generic error notice.
const wireValidators: Record<string, (value: unknown) => boolean> = {
  read_project_changes: validateResponseChanges, read_content_scope: validateResponseScope,
  read_source_content: validateResponsePage, read_review_summary_page: validateResponseSummary,
  read_review_editor_snapshot: validateResponseEditor, read_execution_task_activity: validateResponseActivity,
  read_source_context: validateResponseSourceContext,
  read_work_protection: validateResponseWorkProtection, set_work_protection: validateResponseWorkProtection,
};
let wireFailures: string[];
async function wireReply(command: string, read: () => Promise<unknown>) {
  try {
    const value = await read(), validate = wireValidators[command];
    if (validate && !validate(value)) {
      throw new Error(`Invalid synthetic IPC response: ${command}: ${JSON.stringify(Reflect.get(validate, "errors"))}`);
    }
    return value;
  } catch (error) {
    wireFailures.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

const invoke=vi.hoisted(()=>vi.fn());
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async()=>()=>{})}));
const project:ProjectView={sessionToken:"context-editor-session",locator:"isolated",reconciliationState:"settled",
  metadata:{projectId:fixtureIdentity(500),displayName:"Context editing",sourceLocale:"en",targetLocales:["zh-CN"],metadataRevision:"1"}};
const session=createRef<ProjectSessionHandle>();
let saved:ContextRevision|null, version:string, snapshot:ReviewEditorSnapshot;
let protection: WorkProtection, protectionReceipts: Map<string, WorkProtection>, identities: number;
let hold:(()=>Promise<ReviewEditorSnapshot>)|null, loseSave:boolean, changedResources:boolean, memory:WorkspaceViewMemory;
const target=()=>reviewTargetFixture({unitId:fixtureIdentity(601),nativeKey:"entry",sourceText:"Original",selectionId:null,revisionId:null,translationText:null});
function editor():ReviewEditorSnapshot {return {...snapshot,target:{...snapshot.target,basisEvidence:{...snapshot.target.basisEvidence,contextRevisionId:saved?.revisionId??null}},context:saved,readVersion:version};}
function Harness(){
  const [area,setArea]=useState<WorkspaceArea>("overview"),[sourceState,setSourceState]=useState<OverviewSourcePresentation["state"]>("loading"),[viewMemory]=useState(()=>{const value=new WorkspaceViewMemory();value.write("translation","tab","edit");return value;}),[commands]=useState(()=>new WorkbenchCommands());
  memory=viewMemory;
  return <ApplicationReadProvider><WorkbenchCommandsProvider commands={commands}><WorkspaceViewProvider value={{area,memory:viewMemory,activate:setArea,deactivate:()=>setArea("overview")}}>
    <button disabled={sourceState!=="ready"} onClick={()=>{void session.current?.navigate({kind:"area",area:"translation"});}}>Open translations</button>
    <button onClick={()=>{void session.current?.navigate({kind:"area",area:"resources"});}}>Open retained resources</button>
    <ProjectSessionWorkbench ref={session} project={project} disabled={false} onActivate={setArea} onCoordinatingChange={()=>{}} onSourceState={value=>setSourceState(value.state)}/>
  </WorkspaceViewProvider></WorkbenchCommandsProvider></ApplicationReadProvider>;
}
beforeEach(async()=>{
  await i18n.changeLanguage("en-US");wireFailures=[];hold=null;loseSave=false;changedResources=false;version="original-context-view";
  saved={revisionId:fixtureIdentity(610),unitId:target().unitId,locale:"zh-CN",text:"Saved context A",reason:"Original source note",previousRevisionId:null};
  protection={unitId:target().unitId,locale:"zh-CN",revision:"0",protected:false};protectionReceipts=new Map();identities=630;
  snapshot={target:target(),translations:{unitId:target().unitId,locale:"zh-CN",current:null,currentText:null,total:"0",rows:[],nextOrdinal:null},
    terms:{unitId:target().unitId,locale:"zh-CN",sourceRevisionId:target().sourceRevisionId,entries:[]},context:saved,readVersion:version};
  invoke.mockReset().mockImplementation((command:string,{request}:{request:Record<string,unknown>})=>wireReply(command,async()=>{
    if(command==="read_project_changes")return{projectId:project.metadata.projectId,sessionToken:project.sessionToken,epoch:fixtureIdentity(620),sequence:changedResources?"1":"0",progressSequence:"0",scopes:changedResources?["resources"]:[],runtime:{active:false,quiescing:false,queryCount:0,error:null}};
    if(command==="read_content_scope")return{revision:"1",currentSnapshot:snapshot.target.sourceSnapshotId};
    if(command==="read_execution_task_activity")return{total:"0",active:"0",attention:"0",saved:"0",rows:[]};
    if(command==="read_source_content")return sourcePageFixture({snapshotId:snapshot.target.sourceSnapshotId,scope:{revision:"1",currentSnapshot:snapshot.target.sourceSnapshotId},
      rows:[sourceRowFixture({unitId:snapshot.target.unitId,sourceRevisionId:snapshot.target.sourceRevisionId},{key:"entry",text:"Original"})]});
    if(command==="read_review_summary_page")return reviewSummaryPageFixture([reviewSummaryFor(snapshot.target)]);
    if(command==="read_review_editor_snapshot")return hold?hold():structuredClone(editor());
    if(command==="read_translation_history")return snapshot.translations;
    if(command==="read_work_protection"){
      expect(request).toMatchObject({unitId:target().unitId,locale:"zh-CN"});return {...protection};
    }
    if(command==="set_work_protection"){
      if(!validateRequestWorkProtectionSet(request))throw new Error("Invalid synthetic protection request");
      const existing=protectionReceipts.get(request.actionId);if(existing)return {...existing};
      expect(request).toMatchObject({projectId:project.metadata.projectId,sessionToken:project.sessionToken,
        unitId:target().unitId,sourceRevisionId:target().sourceRevisionId,locale:"zh-CN",selectionId:null,
        expectedRevision:protection.revision,protected:true,confirmedRelease:false});
      protection={unitId:request.unitId,locale:request.locale,revision:(BigInt(request.expectedRevision)+1n).toString(),protected:request.protected};
      protectionReceipts.set(request.actionId,protection);return {...protection};
    }
    if(command==="read_context_revision")return saved;
    if(command==="read_terms"||command==="tm_suggestions"||command==="list_resource_captures")return[];
    if(command==="resolve_terms")return snapshot.terms;
    if(command==="read_source_context")return{scope:{projectId:project.metadata.projectId,sourceSnapshotId:request.sourceSnapshotId,unitId:request.unitId,sourceRevisionId:request.sourceRevisionId,locale:request.locale},
      contentRevision:"1",sourceAttemptId:fixtureIdentity(621),sourceResultId:fixtureIdentity(622),sourceResultDigest:"a".repeat(64),sourceLocale:"en",localUnitId:"synthetic-entry",occurrenceCount:1,
      observations:{missingBlocks:true,knownBlocks:0,knownFacts:0,emptyBlocks:0,unknownBlocks:0,unknownRequiredBlocks:0,neighborOccurrences:0,unknownSamples:[]},entries:[],after:0,totalEntries:0,nextAfter:null};
    if(command==="create_execution_identity")return fixtureIdentity(identities++);
    if(command==="save_context"){
      if(loseSave)throw new Error("Synthetic lost context acknowledgement");
      const value=request.context as SaveContext;saved={revisionId:fixtureIdentity(631),unitId:value.unitId,locale:value.locale,text:value.text,reason:value.reason,previousRevisionId:value.expectedRevisionId??null};version="saved-context-view";return saved;
    }
    throw new Error(`Unexpected synthetic IPC command: ${command}`);
  }));
});
afterEach(cleanup);
async function open(){
  const user=userEvent.setup();let phase="render production owners";
  try {
    render(<Harness/>);
    // Production starts in Overview. Let its source observer and the real change
    // bridge settle before opening Translations through the session navigator.
    phase="wait for current overview source";
    await waitFor(()=>expect(screen.getByRole("button",{name:"Open translations"})).toBeEnabled());
    phase="wait for current task activity";
    await screen.findByText(i18n.t("execution.dock.empty"));
    phase="navigate to translations";
    await user.click(screen.getByRole("button",{name:"Open translations"}));
    phase="open the exact entry";
    await user.click(await screen.findByRole("button",{name:"entry"}));
    phase="wait for the original editor protection owner";
    const field=await screen.findByRole("textbox",{name:i18n.t("translation.draft")});
    await waitFor(()=>expect(field).not.toHaveAttribute("readonly"));
    phase="retain manual B and open references";
    await user.type(field,"Manual B");await user.click(screen.getByText(i18n.t("workbench.references")));
    phase="confirm current context edit command";
    await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("resource.editFromEntry")})).toBeEnabled());
    return user;
  } catch (error) {
    throw new Error(`Context editor setup failed at ${phase}. IPC calls: ${invoke.mock.calls.map(([command])=>command).join(", ")}. Fixture failures: ${wireFailures.join("; ") || "none"}. Protection: ${JSON.stringify(protection)}`, {cause:error});
  }
}
async function enter(user:ReturnType<typeof userEvent.setup>){await user.click(screen.getByRole("button",{name:i18n.t("resource.editFromEntry")}));
  await screen.findByRole("textbox",{name:i18n.t("resource.manualContext")});}

it("opens the exact human context, saves through original CAS, and returns without replacing the manual translation",async()=>{
  const user=await open();await enter(user);
  expect(screen.getByRole("textbox",{name:i18n.t("resource.manualContext")})).toHaveValue("Saved context A");
  expect(invoke.mock.calls.some(([name])=>name==="save_context")).toBe(false);
  await user.clear(screen.getByRole("textbox",{name:i18n.t("resource.manualContext")}));await user.type(screen.getByRole("textbox",{name:i18n.t("resource.manualContext")}),"Human supplement");
  await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("resource.saveContext")})).toBeEnabled());await user.click(screen.getByRole("button",{name:i18n.t("resource.saveContext")}));
  await waitFor(()=>expect(invoke.mock.calls.filter(([name])=>name==="save_context")).toHaveLength(1));
  expect(invoke.mock.calls.find(([name])=>name==="save_context")![1].request.context).toMatchObject({unitId:target().unitId,sourceRevisionId:target().sourceRevisionId,locale:"zh-CN",expectedRevisionId:fixtureIdentity(610),text:"Human supplement"});
  const back=screen.getByRole("button",{name:i18n.t("resource.returnToEditor",{key:"entry",locale:"zh-CN"})});await waitFor(()=>expect(back).toBeEnabled());await user.click(back);
  expect(await screen.findByRole("textbox",{name:i18n.t("translation.draft")})).toHaveValue("Manual B");await screen.findByText("Human supplement · Original source note");
  expect(invoke.mock.calls.some(([name])=>["save_translation_revision","authorize_work_plan","start_work_plan","start_ai_translation"].includes(name))).toBe(false);
});

it("keeps a resource B draft when another context handoff is requested",async()=>{
  const user=await open();await enter(user);await user.type(screen.getByRole("textbox",{name:i18n.t("resource.manualContext")})," resource B");
  await user.click(screen.getByRole("button",{name:i18n.t("resource.returnToEditor",{key:"entry",locale:"zh-CN"})}));
  await screen.findByRole("textbox",{name:i18n.t("translation.draft")});
  await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("resource.editFromEntry")})).toBeEnabled());await user.click(screen.getByRole("button",{name:i18n.t("resource.editFromEntry")}));
  await screen.findByText(i18n.t("resource.contextEditorBlocked"));expect(screen.getByRole("textbox",{name:i18n.t("translation.draft")})).toHaveValue("Manual B");
  await user.click(screen.getByRole("button",{name:"Open retained resources"}));expect(await screen.findByRole("textbox",{name:i18n.t("resource.manualContext")})).toHaveValue("Saved context A resource B");
});

it.each(["context","source"] as const)("rejects changed %s evidence returned after the original navigation capture",async kind=>{
  const user=await open();let finish!:(value:ReviewEditorSnapshot)=>void;hold=()=>new Promise(resolve=>{finish=resolve;});
  await user.click(screen.getByRole("button",{name:i18n.t("resource.editFromEntry")}));await waitFor(()=>expect(finish).toBeDefined());
  const changed=structuredClone(editor());if(kind==="context"){changed.readVersion="new context";changed.context={...saved!,revisionId:fixtureIdentity(640)};changed.target.basisEvidence.contextRevisionId=changed.context.revisionId;}
  else {changed.target.sourceRevisionId=fixtureIdentity(641);changed.target.sourceSnapshotId=fixtureIdentity(642);changed.target.basisEvidence={...changed.target.basisEvidence,sourceRevisionId:changed.target.sourceRevisionId,sourceSnapshotId:changed.target.sourceSnapshotId};}
  await act(async()=>{finish(changed);});await screen.findByText(i18n.t("resource.contextEditorChanged"));
  expect(screen.getByRole("textbox",{name:i18n.t("translation.draft")})).toHaveValue("Manual B");expect(memory.read("resources","contextEditorReturn")).toBeUndefined();
  expect(invoke.mock.calls.some(([name])=>name==="save_context")).toBe(false);
});

it("does not let an old successful response revive a handoff invalidated by the live change bridge",async()=>{
  const user=await open();const original=structuredClone(editor());let finish!:(value:ReviewEditorSnapshot)=>void;
  // Both the handoff and any bridge-triggered reread receive this same old
  // response. A later request must not overwrite the original wait's resolver.
  const pending=new Promise<ReviewEditorSnapshot>(resolve=>{finish=resolve;});
  const heldRead=vi.fn(()=>pending);hold=heldRead;
  await user.click(screen.getByRole("button",{name:i18n.t("resource.editFromEntry")}));await waitFor(()=>expect(heldRead).toHaveBeenCalled());
  const readsBefore=invoke.mock.calls.filter(([name])=>name==="read_project_changes").length;
  await act(async()=>{changedResources=true;window.dispatchEvent(new Event("focus"));});
  await waitFor(()=>expect(invoke.mock.calls.filter(([name])=>name==="read_project_changes").length).toBeGreaterThan(readsBefore));
  await act(async()=>{finish(original);});await screen.findByText(i18n.t("resource.contextEditorChanged"));
  expect(memory.read("resources","contextEditorReturn")).toBeUndefined();expect(screen.getByRole("textbox",{name:i18n.t("translation.draft")})).toHaveValue("Manual B");
});

it("keeps an uncertain original context action reachable and blocks return navigation",async()=>{
  const user=await open();await enter(user);loseSave=true;await user.type(screen.getByRole("textbox",{name:i18n.t("resource.manualContext")})," edited");
  await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("resource.saveContext")})).toBeEnabled());await user.click(screen.getByRole("button",{name:i18n.t("resource.saveContext")}));
  await screen.findByText(i18n.t("resource.uncertainAction"));expect(screen.getByRole("button",{name:i18n.t("resource.returnToEditor",{key:"entry",locale:"zh-CN"})})).toBeDisabled();
  let accepted=true;await act(async()=>{accepted=await session.current!.navigate({kind:"resource-context-return",capture:memory.read<ContextEditorTarget>("resources","contextEditorReturn")!});});expect(accepted).toBe(false);
  expect(screen.getByRole("textbox",{name:i18n.t("resource.manualContext")})).toHaveValue("Saved context A edited");expect(invoke.mock.calls.filter(([name])=>name==="save_context")).toHaveLength(1);
});
