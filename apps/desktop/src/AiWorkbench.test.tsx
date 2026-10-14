import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import {act,cleanup,screen,waitFor,within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type { AiHandle } from "./AiWorkbench";
import { createRef, type ComponentProps } from "react";
import type { WorkPlanView, WorkPlanReceiptView, WorkPlanStatusView } from "./workPlanCommands";
import {AiWorkbench} from "./AiWorkbench";
import {defaultAiConfig,type AiPrepared, type AiItem} from "./aiCommands";
import {useEffect,type Ref} from "react";
import {AiPreparationSession} from "./AiPreparationSession";
import {useSessionReads} from "./SessionReadProvider";
import type {SessionReads} from "./sessionReads";
import type {AiConfig} from "./aiCommands";
import type {ProjectView} from "./projectCommands";
import {i18n} from "./i18n";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import aiFixture from "../test/fixtures/aiCommands.contract.json";
import {validateRequestPrepare} from "./generated/execution.validators";
import type { AdoptionAction, PrepareRequest, Receipt } from "./executionCommands";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { aiAttempt, aiViewFixture, aiWorkPlanFixture } from "./testSupport/aiFixture";
import { formatReviewSlotFixture } from "./testSupport/textReviewFixture";
import { toolQueryInventory, toolQueryPackage, toolQueryView } from "./testSupport/pluginToolFixture";
import type { WorkPlanToolSelection } from "./generated/ai.requests";
function formatCheckerFixture(): WorkPlanView["checkers"][number] {
  const checker = formatReviewSlotFixture();
  return { kind: "ready", checker: checker.checker, plugin: checker.plugin };
}
const invoke=vi.hoisted(()=>vi.fn());vi.mock("@tauri-apps/api/core",()=>({invoke}));
const project:ProjectView={sessionToken:"session",locator:"isolated",reconciliationState:"settled",metadata:{projectId:fixtureIdentity(500),displayName:"AI test",sourceLocale:"en",targetLocales:["zh-CN"],metadataRevision:"1"}};
let currentReads:SessionReads|null=null;
function CaptureReads(){const reads=useSessionReads();useEffect(()=>{currentReads=reads;return()=>{if(currentReads===reads)currentReads=null;};},[reads]);return null;}
function TestAiWorkbench({project:current,ref,disabled=false,onOpenTranslation=async()=>true}:{project:ProjectView;ref?:Ref<AiHandle>;disabled?:boolean;onOpenTranslation?:(unit:Parameters<ComponentProps<typeof AiWorkbench>["onOpenTranslation"]>[0],locale:string)=>Promise<boolean>}) {
 return <AiPreparationSession initialLocale={current.metadata.targetLocales[0]??""} targetLocales={current.metadata.targetLocales}>
  <CaptureReads/>
  <AiWorkbench project={current} ref={ref} disabled={disabled} onOpenTranslation={onOpenTranslation}/>
 </AiPreparationSession>;
}
function ToggleAiWorkbench({project:current,mounted}:{project:ProjectView;mounted:boolean}) {
 return <AiPreparationSession initialLocale={current.metadata.targetLocales[0]??""} targetLocales={current.metadata.targetLocales}>
  {mounted?<AiWorkbench project={current} disabled={false} onOpenTranslation={async()=>true}/>:null}
 </AiPreparationSession>;
}
const item:AiItem={unitId:fixtureIdentity(301),sourceRevisionId:fixtureIdentity(302),sourceSnapshotId:fixtureIdentity(300),nativeKey:"first",sourceLocale:"en",sourceText:"Hello",targetLocale:"zh-CN",terms:[],context:null,omissions:["terms-not-shared","context-not-shared"],resourceBaseline:"0"};
let prepared:AiPrepared;
let originalAction:AdoptionAction;
function actionFor(request:PrepareRequest):AdoptionAction {
 return {...executionFixture.action,projectId:request.projectId,attemptId:request.attemptId,actionId:request.actionId,unitId:request.unitId,
  operation:"ai-translation",parameters:null,resultIds:[...request.resultIds]};
}
function receiptFor(action=originalAction):Receipt {
 return {...executionFixture.receipt,projectId:action.projectId,attemptId:action.attemptId,actionId:action.actionId,unitId:action.unitId,
  changes:[{kind:"translation-revision",id:fixtureIdentity(900),revision:"1"}]};
}
let plan:WorkPlanView;
let authority:WorkPlanStatusView|null;
let actions:Map<string,WorkPlanReceiptView>;
let identity:number;
let startedGeneration:string;
function workPlanAiView(){const value=aiViewFixture(item,prepared.preview.config);value.planId=authority?planId:null;value.planGeneration=authority?startedGeneration:null;return value;}
const planId=fixtureIdentity(501);
beforeEach(async()=>{
 await i18n.changeLanguage("en-US");currentReads=null;authority=null;actions=new Map();identity=510;startedGeneration="1";
 prepared={attemptId:aiAttempt,preview:{config:{...defaultAiConfig,endpoint:"http://127.0.0.1:4000/v1/chat/completions",model:"test-model",credentialEnv:""},recipe:"direct-translation-1",digest:aiFixture.responses.prepared.preview.digest,items:[item]}};
 invoke.mockReset();invoke.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
  const request=args.request;
  if(command==="read_plugin_text_reviews")return{settingsRevision:"1",entries:[]};
  if(command==="read_content_scope")return{revision:"2",currentSnapshot:fixtureIdentity(300)};
  if(command==="read_source_content")return sourcePageFixture({snapshotId:fixtureIdentity(300),scope:{revision:"2",currentSnapshot:fixtureIdentity(300)},rows:[sourceRowFixture({unitId:item.unitId,sourceRevisionId:item.sourceRevisionId},{key:"first",text:item.sourceText})]});
  if(command==="prepare_work_plan"){
   if(request.config)prepared.preview.config=request.config as typeof defaultAiConfig;
   plan={tools:null,checkers: request.options && (request.options as WorkPlanView["options"]).selectionPolicy !== "candidates-only" ? [formatCheckerFixture()] : [],planId,digest:"plan-digest",locale:String(request.locale),options:request.options as WorkPlanView["options"],scope:[{unitId:item.unitId,sourceSnapshotId:item.sourceSnapshotId,sourceRevisionId:item.sourceRevisionId,nativeKey:item.nativeKey,selectionId:null}],attemptId:request.config?aiAttempt:null,preview:request.config?prepared.preview:null};return plan;
  }
  if(command==="authorize_work_plan"){
   const receipt:WorkPlanReceiptView={actionId:String(request.actionId),lease:{planId,generation:"1"},state:"active",attemptId:aiAttempt,parentTask:null};
   actions.set(receipt.actionId,receipt);authority={plan,lease:receipt.lease,state:"active",effects:request.effects as WorkPlanStatusView["effects"],expiresAt:String(request.expiresAt),toolInvocations:null};return receipt;
  }
  if(command==="control_work_plan"){
   const state=({pause:"paused",stop:"stopped","take-over":"taken-over",continue:"active"} as const)[request.command as "pause"];
   const receipt:WorkPlanReceiptView={actionId:String(request.actionId),lease:{planId,generation:(BigInt(String(request.expectedGeneration))+1n).toString()},state,attemptId:request.command==="continue"?fixtureIdentity(403):null,parentTask:request.command==="continue"?fixtureIdentity(402):null};
   actions.set(receipt.actionId,receipt);authority={...authority!,lease:receipt.lease,state,expiresAt:request.expiresAt?String(request.expiresAt):authority!.expiresAt};return receipt;
  }
  if(command==="read_work_plan_status")return authority;
  if(command==="read_work_plan_action")return actions.get(String(request.actionId))??null;
  if(command==="start_work_plan"){startedGeneration=String(request.expectedGeneration);return actions.get(String(request.actionId))!.attemptId;}
  if(command==="read_ai_translation"){
   const view=workPlanAiView();view.planId=authority?planId:null;view.planGeneration=authority?startedGeneration:null;
   view.detail.attemptId=String(request.attemptId);view.detail.recovery.attemptId=String(request.attemptId);return view;
  }
  if(command==="create_execution_identity")return fixtureIdentity(identity++);
  if(command==="prepare_execution_adoption"){if(!validateRequestPrepare(request))throw new Error("Invalid adoption fixture request");originalAction=actionFor(request);return originalAction;}
  if(command==="adopt_execution"||command==="read_execution_receipt")return receiptFor();
  throw new Error(command);
 });
});
afterEach(cleanup);
it("retains AI cancellation through consumer remount and confirms only an exact original retry",async()=>{
 const user=userEvent.setup(),ref=createRef<AiHandle>();const original=invoke.getMockImplementation()!;
 let cancellations=0;
 invoke.mockImplementation(async(command:string,payload:unknown)=>{
  if(command==="read_ai_translation"){const view=await original(command,payload);return {...view,detail:{...view.detail,progress:{...view.detail.progress,queued:1,succeeded:0}}};}
  if(command==="cancel_execution_task"){if(++cancellations===1)throw new Error("Disconnected");return "5";}
  return original(command,payload);
 });
 const view=render(<TestAiWorkbench project={project} ref={ref}/>);
 act(()=>{ref.current!.showAttempt(aiAttempt);});
 const cancel=await screen.findByRole("button",{name:"Cancel remaining work"});await waitFor(()=>expect(cancel).toBeEnabled());
 await user.click(cancel);await screen.findByRole("button",{name:"Retry the original cancellation"});
 view.rerender(null,project);view.rerender(<TestAiWorkbench project={project} ref={ref}/>);
 await user.click(await screen.findByRole("button",{name:"Retry the original cancellation"}));
 await screen.findByText(/Cancellation request recorded/);
 const requests=invoke.mock.calls.filter(([name])=>name==="cancel_execution_task").map(([,payload])=>payload.request);
 expect(requests).toHaveLength(2);expect(requests[0]).toEqual(requests[1]);
 expect(invoke.mock.calls.filter(([name])=>name==="create_execution_identity")).toHaveLength(1);
 expect(invoke.mock.calls.filter(([name])=>name==="adopt_execution")).toHaveLength(0);
});

it("reveals invalid connection fields when preview fails after settings were collapsed",async()=>{
 const user=userEvent.setup();render(<TestAiWorkbench project={project}/>);
 await user.click(screen.getByRole("button",{name:"AI translation"}));
 await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));
 const connection=screen.getByText("Connection",{selector:"summary"});
 expect(connection.closest("details")).not.toHaveAttribute("open");
 await user.click(connection);expect(connection.closest("details")).toHaveAttribute("open");
 await user.click(connection);expect(connection.closest("details")).not.toHaveAttribute("open");
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((command:string,args:unknown)=>command==="prepare_work_plan"?Promise.reject({code:"invalid-input", outcome: "rejected",reason:"ai-model"}):original(command,args));
 await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await waitFor(()=>expect(connection.closest("details")).toHaveAttribute("open"));
 expect(screen.getByRole("textbox",{name:"Model"})).toHaveAttribute("aria-invalid","true");
 expect(invoke.mock.calls.some(([command])=>command==="start_work_plan")).toBe(false);
});

it("keeps a prepared draft through panel unmount and clears it only after confirmed project leave",async()=>{
 const handle=createRef<AiHandle>();const user=await preview(handle);
 await user.click(screen.getByRole("button",{name:"Back to overview"}));
 expect(document.querySelector("section.ai-dialog")).toBeNull();
 await user.click(screen.getByRole("button",{name:"AI translation"}));
 expect(screen.getByRole("textbox",{name:"Model"})).toHaveValue("test-model");
 expect(screen.getByRole("heading",{name:"Data sharing preview"})).toBeInTheDocument();
 await act(async()=>{void handle.current!.allowLeave();});
 await user.click(await screen.findByRole("button",{name:"Stay and keep draft"}));
 expect(screen.getByRole("textbox",{name:"Model"})).toHaveValue("test-model");
 await act(async()=>{void handle.current!.allowLeave();});
 await user.click(await screen.findByRole("button",{name:"Discard draft and leave"}));
 await user.click(screen.getByRole("button",{name:"AI translation"}));
 expect(screen.getByRole("textbox",{name:"Model"})).toHaveValue("");
 expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();
});
it("retains AI preparation when its entire controller unmounts within the same project session",async()=>{
 const user=userEvent.setup();const rendered=render(<ToggleAiWorkbench project={project} mounted/>);
 await user.click(screen.getByRole("button",{name:"AI translation"}));
 await user.type(screen.getByRole("textbox",{name:"Chat Completions URL"}),"http://127.0.0.1:4000/v1/chat/completions");
 await user.type(screen.getByRole("textbox",{name:"Model"}),"test-model");
 await user.clear(screen.getByRole("textbox",{name:"API key environment variable name"}));
 await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));
 await user.click(screen.getByRole("checkbox",{name:"Share applicable adopted terms"}));
 await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await screen.findByRole("heading",{name:"Data sharing preview"});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));
 expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeEnabled();
 const previews=invoke.mock.calls.filter(([command])=>command==="prepare_work_plan").length;
 rendered.rerender(<ToggleAiWorkbench project={project} mounted={false}/>);
 expect(document.querySelector("section.ai-dialog")).toBeNull();
 rendered.rerender(<ToggleAiWorkbench project={project} mounted/>);
 expect(screen.getByRole("textbox",{name:"Model"})).toHaveValue("test-model");
 expect(screen.getByRole("textbox",{name:"Chat Completions URL"})).toHaveValue("http://127.0.0.1:4000/v1/chat/completions");
 expect(screen.getByRole("combobox",{name:"Target language"})).toHaveValue("zh-CN");
 expect(await screen.findByRole("checkbox",{name:"first: Hello"})).toBeChecked();
 expect(screen.getByRole("checkbox",{name:"Share applicable adopted terms"})).toBeChecked();
 expect(screen.getByRole("heading",{name:"Data sharing preview"})).toBeInTheDocument();
 expect(screen.getByRole("checkbox",{name:/I confirm sending/})).toBeChecked();
 expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeEnabled();
 expect(invoke.mock.calls.filter(([command])=>command==="prepare_work_plan")).toHaveLength(previews);
 expect(invoke.mock.calls.filter(([command])=>command==="start_work_plan")).toHaveLength(0);
});

it("ignores a preview from a project that was replaced while the request was pending",async()=>{
 const user=userEvent.setup();const rendered=render(<TestAiWorkbench key="session" project={project} disabled={false} onOpenTranslation={async()=>true}/>);await user.click(screen.getByRole("button",{name:"AI translation"}));await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));let resolve:(value:WorkPlanView)=>void=()=>{};const original=invoke.getMockImplementation()!;invoke.mockImplementation((command:string,args:unknown)=>command==="prepare_work_plan"?new Promise<WorkPlanView>(done=>{resolve=done;}):original(command,args));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));rendered.rerender(<TestAiWorkbench key="replacement" project={{...project,sessionToken:"replacement"}} disabled={false} onOpenTranslation={async()=>true}/>);resolve({...plan,checkers:[],planId,digest:"plan-digest",locale:"zh-CN",options:{stages:[{stage:"generation",mode:"assisted"}],selectionPolicy:"candidates-only",adoptResources:false,deliver:false,advisoryChecks:[]},attemptId:aiAttempt,preview:prepared.preview,scope:[{unitId:item.unitId,sourceRevisionId:item.sourceRevisionId,sourceSnapshotId:item.sourceSnapshotId,nativeKey:"first",selectionId:null}]});await user.click(screen.getByRole("button",{name:"AI translation"}));await screen.findByRole("checkbox",{name:"first: Hello"});expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();expect(invoke.mock.calls.some(([c])=>c==="start_work_plan")).toBe(false);
});

it("requires exact sharing confirmation and invalidates it on configuration edits",async()=>{const user=await preview();expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeDisabled();expect(screen.getByRole("checkbox",{name:"Share applicable adopted terms"})).not.toBeChecked();expect(invoke.mock.calls.some(([c])=>c==="start_work_plan")).toBe(false);await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeEnabled();await user.type(screen.getByRole("textbox",{name:"Model"}),"-changed");expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();});
it("keeps empty limits editable and rejects them before preview serialization",async()=>{const user=await preview();await user.click(screen.getByText("Budget and limits"));await user.clear(screen.getByRole("spinbutton",{name:"Maximum requests including retries"}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));expect(await screen.findByRole("alert")).toHaveFocus();expect(screen.getByRole("spinbutton",{name:"Maximum requests including retries"})).toHaveAttribute("aria-invalid","true");expect(invoke.mock.calls.filter(([c])=>c==="prepare_work_plan")).toHaveLength(1);expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();});
it("ignores a replaced-session preview through the stable preparation consumer",async()=>{
 const user=userEvent.setup();const rendered=render(<TestAiWorkbench key="session" project={project}/>);await user.click(screen.getByRole("button",{name:"AI translation"}));await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));let resolve:(value:WorkPlanView)=>void=()=>{};const original=invoke.getMockImplementation()!;invoke.mockImplementation((command:string,args:unknown)=>command==="prepare_work_plan"?new Promise<WorkPlanView>(done=>{resolve=done;}):original(command,args));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));rendered.rerender(<TestAiWorkbench key="replacement" project={{...project,sessionToken:"replacement"}}/>);resolve(aiWorkPlanFixture(prepared));await user.click(screen.getByRole("button",{name:"AI translation"}));await screen.findByRole("checkbox",{name:"first: Hello"});expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();expect(invoke.mock.calls.some(([c])=>c==="start_work_plan")).toBe(false);
});
it("retains AI setup but blocks preview when its target locale is removed",async()=>{
 const user=userEvent.setup();const rendered=render(<TestAiWorkbench project={project}/>);
 await user.click(screen.getByRole("button",{name:"AI translation"}));
 await user.type(screen.getByRole("textbox",{name:"Chat Completions URL"}),"http://127.0.0.1:4000/v1/chat/completions");
 await user.type(screen.getByRole("textbox",{name:"Model"}),"test-model");
 await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));
 await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await screen.findByRole("heading",{name:"Data sharing preview"});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));
 const changed={...project,metadata:{...project.metadata,targetLocales:[],metadataRevision:"2"}};
 rendered.rerender(<TestAiWorkbench project={changed}/>);
 await waitFor(()=>expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument());
 expect(screen.getByRole("textbox",{name:"Model"})).toHaveValue("test-model");
 expect(screen.getByRole("checkbox",{name:"first: Hello"})).toBeChecked();
 expect(screen.getByRole("button",{name:"Preview what will be sent"})).toBeDisabled();
 expect(screen.getByText(/This language is no longer available/)).toBeInTheDocument();
 rendered.rerender(<TestAiWorkbench project={{...project,metadata:{...project.metadata,metadataRevision:"3"}}}/>);
 expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();
 expect(screen.getByRole("button",{name:"Preview what will be sent"})).toBeEnabled();
 expect(invoke.mock.calls.filter(([command])=>command==="start_work_plan")).toHaveLength(0);
});
it("shows a removed captured target until the user chooses a current language and prepares again",async()=>{
 const user=userEvent.setup();const rendered=render(<TestAiWorkbench project={project}/>);
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
  if(command==="prepare_work_plan"&&args.request.locale==="ja-JP")return aiWorkPlanFixture({
   attemptId:fixtureIdentity(420),preview:{config:args.request.config as AiConfig,recipe:"direct-translation-1",digest:aiFixture.responses.prepared.preview.digest,items:[{...item,targetLocale:"ja-JP"}]}
  } satisfies AiPrepared,plan.options);
  return original(command,args);
 });
 await user.click(screen.getByRole("button",{name:"AI translation"}));
 await user.type(screen.getByRole("textbox",{name:"Chat Completions URL"}),"http://127.0.0.1:4000/v1/chat/completions");
 await user.type(screen.getByRole("textbox",{name:"Model"}),"test-model");
 await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));
 await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await screen.findByRole("heading",{name:"Data sharing preview"});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));
 rendered.rerender(<TestAiWorkbench project={{...project,metadata:{...project.metadata,targetLocales:["ja-JP"],metadataRevision:"2"}}}/>);
 const target=screen.getByRole("combobox",{name:"Target language"});
 expect(target).toHaveValue("zh-CN");
 expect(screen.getByRole("option",{name:"zh-CN"})).toBeDisabled();
 expect(screen.getByRole("option",{name:"ja-JP"})).toBeInTheDocument();
 expect(screen.getByText(/This language is no longer available/)).toBeInTheDocument();
 expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();
 expect(screen.getByRole("textbox",{name:"Model"})).toHaveValue("test-model");
 expect(screen.getByRole("checkbox",{name:"first: Hello"})).toBeChecked();
 await user.selectOptions(target,"ja-JP");
 await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await screen.findByRole("heading",{name:"Data sharing preview"});
 expect(screen.getByText("first → ja-JP")).toBeInTheDocument();
 expect(screen.getByRole("checkbox",{name:/I confirm sending/})).not.toBeChecked();
 expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeDisabled();
 expect(invoke.mock.calls.filter(([command])=>command==="start_work_plan")).toHaveLength(0);
});
it("lets the user explicitly clear a removed cross-page AI scope without losing connection settings",async()=>{
 const user=userEvent.setup();const removedUnit=item.unitId, replacementUnit=fixtureIdentity(401);
 let removed=false;
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
  if(command==="read_content_scope"&&removed)return{revision:"3",currentSnapshot:fixtureIdentity(400)};
  if(command==="read_source_content"&&removed)return sourcePageFixture({snapshotId:fixtureIdentity(400),scope:{revision:"3",currentSnapshot:fixtureIdentity(400)},rows:[sourceRowFixture({unitId:replacementUnit,sourceRevisionId:fixtureIdentity(402)},{key:"second",text:"World"})]});
  if(command==="prepare_work_plan"&&removed){
   const units=args.request.unitIds as string[];
   if(units.includes(removedUnit))throw{code:"invalid-input",outcome:"rejected",stage:"execution-read",reason:"execution-storage",recoveryRequired:false};
   return aiWorkPlanFixture({attemptId:fixtureIdentity(410),preview:{config:args.request.config as AiConfig,recipe:"direct-translation-1",digest:aiFixture.responses.prepared.preview.digest,items:[{...item,unitId:replacementUnit,sourceRevisionId:fixtureIdentity(402),sourceSnapshotId:fixtureIdentity(400),nativeKey:"second",sourceText:"World"}]}},plan.options);
  }
  return original(command,args);
 });
 render(<TestAiWorkbench project={project}/>);
 await user.click(screen.getByRole("button",{name:"AI translation"}));
 await user.type(screen.getByRole("textbox",{name:"Chat Completions URL"}),"http://127.0.0.1:4000/v1/chat/completions");
 await user.type(screen.getByRole("textbox",{name:"Model"}),"test-model");
 await user.clear(screen.getByRole("textbox",{name:"API key environment variable name"}));
 await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));
 await user.click(screen.getByRole("checkbox",{name:"Share applicable adopted terms"}));
 await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await screen.findByRole("heading",{name:"Data sharing preview"});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));
 removed=true;
 await act(async()=>{currentReads!.invalidate(["source"]);});
 await screen.findByRole("checkbox",{name:"second: World"});
 expect(screen.queryByRole("checkbox",{name:"first: Hello"})).not.toBeInTheDocument();
 expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();
 await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 const failureNotice=await screen.findByRole("alert");
 expect(within(failureNotice).getByText("execution-storage",{selector:"code"})).toBeInTheDocument();
 expect(invoke.mock.calls.filter(([command])=>command==="prepare_work_plan")).toHaveLength(2);
 await user.click(screen.getByRole("button",{name:"Clear selected range"}));
 expect(screen.getByRole("textbox",{name:"Chat Completions URL"})).toHaveValue("http://127.0.0.1:4000/v1/chat/completions");
 expect(screen.getByRole("textbox",{name:"Model"})).toHaveValue("test-model");
 expect(screen.getByRole("combobox",{name:"Target language"})).toHaveValue("zh-CN");
 expect(screen.getByRole("checkbox",{name:"Share applicable adopted terms"})).toBeChecked();
 expect(screen.getByRole("button",{name:"Preview what will be sent"})).toBeDisabled();
 await user.click(screen.getByRole("checkbox",{name:"second: World"}));
 await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await screen.findByRole("heading",{name:"Data sharing preview"});
 expect(screen.getByRole("checkbox",{name:/I confirm sending/})).not.toBeChecked();
 expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeDisabled();
 expect(invoke.mock.calls.filter(([command])=>command==="start_work_plan")).toHaveLength(0);
});
async function preview(ref?:Ref<AiHandle>){const user=userEvent.setup();render(<TestAiWorkbench project={project} ref={ref}/>);await user.click(screen.getByRole("button",{name:"AI translation"}));await user.type(screen.getByRole("textbox",{name:"Chat Completions URL"}),"http://127.0.0.1:4000/v1/chat/completions");await user.type(screen.getByRole("textbox",{name:"Model"}),"test-model");await user.clear(screen.getByRole("textbox",{name:"API key environment variable name"}));await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));await screen.findByRole("heading",{name:"Data sharing preview"});return user;}
it("requires exact sharing confirmation and invalidates it on configuration edits through the stable preparation consumer",async()=>{const user=await preview();expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeDisabled();expect(screen.getByRole("checkbox",{name:"Share applicable adopted terms"})).not.toBeChecked();expect(invoke.mock.calls.some(([c])=>c==="start_work_plan")).toBe(false);await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeEnabled();await user.type(screen.getByRole("textbox",{name:"Model"}),"-changed");expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();});
it("keeps empty limits editable and rejects them before preview serialization through the stable preparation consumer",async()=>{const user=await preview();await user.click(screen.getByText("Budget and limits"));await user.clear(screen.getByRole("spinbutton",{name:"Maximum requests including retries"}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));expect(await screen.findByRole("alert")).toHaveFocus();expect(screen.getByRole("spinbutton",{name:"Maximum requests including retries"})).toHaveAttribute("aria-invalid","true");expect(invoke.mock.calls.filter(([c])=>c==="prepare_work_plan")).toHaveLength(1);expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();});
it("saves a normal candidate without issuing a translation selection",async()=>{const user=await preview();await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await user.click(await screen.findByRole("button",{name:"Save candidate"}));await waitFor(()=>expect(invoke.mock.calls.some(([c])=>c==="adopt_execution")).toBe(true));expect(invoke.mock.calls.some(([c])=>c==="select_translation_revision")).toBe(false);expect(screen.getAllByText(/Total usage/).length).toBeGreaterThan(0);});
it("keeps an uncertain start identity and blocks leaving until reconciliation",async()=>{const user=await preview();const original=invoke.getMockImplementation()!;invoke.mockImplementation((command:string,args:unknown)=>command==="start_work_plan"?Promise.reject({code:"outcome-unknown"}):original(command,args));await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await screen.findByText(/Start may have succeeded/);expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();await user.click(screen.getByRole("button",{name:"Check saved result"}));await waitFor(()=>expect(screen.queryByText(/Start may have succeeded/)).not.toBeInTheDocument());const calls=invoke.mock.calls.filter(([c])=>c==="start_work_plan");expect(calls).toHaveLength(1);expect(calls[0][1].request).toMatchObject({planId,expectedGeneration:"1",actionId:fixtureIdentity(510)});});

it("reconciles a well-formed acknowledgement for the wrong AI attempt without resending",async()=>{
 const user=await preview();const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((command:string,args:unknown)=>command==="start_work_plan"?Promise.resolve(fixtureIdentity(499)):original(command,args));
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 await screen.findByText(/Start may have succeeded/);expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();
 await user.click(screen.getByRole("button",{name:"Check saved result"}));await screen.findByText("你好");
 expect(invoke.mock.calls.filter(([c])=>c==="start_work_plan")).toHaveLength(1);
 expect(invoke.mock.calls.find(([c])=>c==="read_ai_translation")?.[1].request.attemptId).toBe(aiAttempt);
});

it("checks an uncertain adoption receipt before retrying the same action",async()=>{
 const user=await preview();const original=invoke.getMockImplementation()!;let lost=true;
 invoke.mockImplementation((command:string,args:unknown)=>{if(command==="adopt_execution"&&lost){lost=false;return Promise.reject({code:"outcome-unknown"});}if(command==="read_execution_receipt")return Promise.resolve(null);return original(command,args);});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await user.click(await screen.findByRole("button",{name:"Save candidate"}));await screen.findByText(/Saving may have committed/);
 expect(screen.queryByRole("button",{name:"Retry same action"})).not.toBeInTheDocument();expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();
 await user.click(screen.getByRole("button",{name:"Check saved result"}));await user.click(await screen.findByRole("button",{name:"Retry same action"}));await waitFor(()=>expect(screen.queryByText(/Saving may have committed/)).not.toBeInTheDocument());
 const calls=invoke.mock.calls.filter(([c])=>c==="adopt_execution");expect(calls).toHaveLength(2);expect(calls.map(([,args])=>args.request.actionId)).toEqual([fixtureIdentity(511),fixtureIdentity(511)]);expect(invoke.mock.calls.filter(([c])=>c==="create_execution_identity")).toHaveLength(2);
 const receiptIndex=invoke.mock.calls.findIndex(([c])=>c==="read_execution_receipt");expect(receiptIndex).toBeGreaterThan(invoke.mock.calls.findIndex(([c])=>c==="adopt_execution"));
});

it("uses a committed receipt to reconcile adoption without repeating the mutation",async()=>{
 const user=await preview();const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((command:string,args:unknown)=>command==="adopt_execution"?Promise.reject({code:"outcome-unknown"}):command==="read_execution_receipt"?Promise.resolve(receiptFor()):original(command,args));
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await user.click(await screen.findByRole("button",{name:"Save candidate"}));await screen.findByText(/Saving may have committed/);await user.click(screen.getByRole("button",{name:"Check saved result"}));
 await waitFor(()=>expect(screen.queryByText(/Saving may have committed/)).not.toBeInTheDocument());expect(invoke.mock.calls.filter(([c])=>c==="adopt_execution")).toHaveLength(1);expect(screen.queryByRole("button",{name:"Retry same action"})).not.toBeInTheDocument();
});

it("shows durable unknown and legacy exposure without replaying when refreshed",async()=>{
 const user=await preview();const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((command:string,args:unknown)=>{if(command==="read_ai_translation"){const view=workPlanAiView();view.budget={limit:20,dispatched:2,legacyHeld:3,unresolved:1,usageUnknown:2,promptTokens:"9007199254740993",completionTokens:"0"};return Promise.resolve(view);}return original(command,args);});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 await screen.findByText(/reserved requests 2 · awaiting confirmation 1 · unknown usage 2/);expect(screen.getByText(/up to 3 possible requests held/)).toBeInTheDocument();expect(screen.getByText(/9007199254740993 input/)).toBeInTheDocument();
 await i18n.changeLanguage("zh-CN");expect(await screen.findByText(/已占请求额度 2.*待核对 1.*用量未知 2/)).toBeInTheDocument();await user.click(screen.getAllByRole("button",{name:"刷新"})[0]);expect(invoke.mock.calls.filter(([c])=>c==="start_work_plan")).toHaveLength(1);
});
it("explains queue rejection and preserves preview without sending another task",async()=>{
 const user=await preview();const original=invoke.getMockImplementation()!;invoke.mockImplementation((c:string,a:unknown)=>c==="start_work_plan"?Promise.reject({code:"limit-exceeded",outcome:"rejected",reason:"execution-queue"}):original(c,a));
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await screen.findByText(/waiting queue is full/);expect(screen.getByRole("heading",{name:"Data sharing preview"})).toBeInTheDocument();expect(invoke.mock.calls.filter(([c])=>c==="start_work_plan")).toHaveLength(1);
});

it("prepares a model-free manual plan and opens its captured entry without authorization",async()=>{
 const user=userEvent.setup(),openEditor=vi.fn(async()=>true);
 render(<TestAiWorkbench project={project} onOpenTranslation={openEditor}/>);
 await user.click(screen.getByRole("button",{name:"AI translation"}));
 await user.selectOptions(screen.getByRole("combobox",{name:"Translate"}),"manual");
 expect(screen.queryByRole("textbox",{name:"Model"})).not.toBeInTheDocument();
 await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));
 await user.click(screen.getByRole("button",{name:"Prepare manual plan"}));
 await user.click(await screen.findByRole("button",{name:"Open manual editor"}));
 expect(openEditor).toHaveBeenCalledWith(expect.objectContaining({unitId:item.unitId,sourceRevisionId:item.sourceRevisionId,key:"first"}),"zh-CN");
 expect(invoke.mock.calls.find(([c])=>c==="prepare_work_plan")?.[1].request.config).toBeNull();
 expect(invoke.mock.calls.some(([c])=>["authorize_work_plan","start_work_plan","preview_ai_translation"].includes(c))).toBe(false);
});

it("records the exact plan digest, effect and expiry before starting the saved grant",async()=>{
 const user=await preview();await user.clear(screen.getByRole("spinbutton",{name:"Authorization duration (minutes)"}));
 expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeDisabled();
 await user.type(screen.getByRole("spinbutton",{name:"Authorization duration (minutes)"}),"15");
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));
 const before=Math.floor(Date.now()/1000);await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await screen.findByText("你好");
 const grant=invoke.mock.calls.find(([c])=>c==="authorize_work_plan")![1].request;
 expect(grant).toMatchObject({planId,digest:"plan-digest",confirmed:true,effects:["save-candidate"]});
 expect(BigInt(grant.expiresAt)).toBeGreaterThanOrEqual(BigInt(before+900));expect(BigInt(grant.expiresAt)).toBeLessThanOrEqual(BigInt(Math.floor(Date.now()/1000)+900));
 expect(invoke.mock.calls.findIndex(([c])=>c==="authorize_work_plan")).toBeLessThan(invoke.mock.calls.findIndex(([c])=>c==="start_work_plan"));
 expect(invoke.mock.calls.find(([c])=>c==="start_work_plan")![1].request).not.toHaveProperty("input");
});

it("pauses and takes over live work, then requires renewed consent and uses the continuation receipt",async()=>{
 const user=await preview(),original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(c:string,a:unknown)=>{const result=await original(c,a);if(c==="read_ai_translation")result.detail.progress.running=1;return result;});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 await user.click(await screen.findByRole("button",{name:"Pause automation"}));
 await screen.findByText("Automation paused");expect(screen.getByRole("button",{name:"Continue with renewed authorization"})).toBeDisabled();
 expect(screen.getByRole("button",{name:"Save candidate"})).toBeDisabled();
 await user.click(screen.getByRole("button",{name:"Take over manually"}));await screen.findByText("Manual control");
 await user.click(screen.getByRole("checkbox",{name:/I authorize the displayed generation/}));
 await user.click(screen.getByRole("button",{name:"Continue with renewed authorization"}));
 await waitFor(()=>expect(invoke.mock.calls.filter(([c])=>c==="start_work_plan")).toHaveLength(2));
 const controls=invoke.mock.calls.filter(([c])=>c==="control_work_plan").map(([,a])=>a.request);
 expect(controls.map(a=>[a.command,a.expectedGeneration,a.confirmed])).toEqual([["pause","1",false],["take-over","2",false],["continue","3",true]]);
 const starts=invoke.mock.calls.filter(([c])=>c==="start_work_plan");expect(starts[1][1].request).toMatchObject({planId,expectedGeneration:"4",actionId:controls[2].actionId});
 expect(invoke.mock.calls.filter(([c])=>c==="authorize_work_plan")).toHaveLength(1);
});

it("reconciles lost authorization against newer stopped authority without queuing",async()=>{
 const user=await preview(),original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(c:string,a:unknown)=>{const result=await original(c,a);if(c==="authorize_work_plan"){authority={...authority!,state:"stopped",lease:{planId,generation:"2"}};throw {code:"outcome-unknown"};}return result;});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 await screen.findByText(/control or authorization may have been saved/);expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();
 await user.click(screen.getByRole("button",{name:"Check saved result"}));await screen.findByText("Plan stopped");
 expect(screen.queryByRole("button",{name:"Start authorized work"})).not.toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Continue with renewed authorization"})).not.toBeInTheDocument();
 expect(invoke.mock.calls.some(([c])=>c==="start_work_plan")).toBe(false);
 expect(invoke.mock.calls.filter(([c])=>c==="authorize_work_plan")).toHaveLength(1);
});

it("retains an unknown control action and retries it only after its receipt is missing",async()=>{
 const user=await preview(),original=invoke.getMockImplementation()!;let lost=true;
 invoke.mockImplementation((c:string,a:unknown)=>{if(c==="control_work_plan"&&lost){lost=false;return Promise.reject({code:"outcome-unknown"});}return original(c,a);});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 await user.click(await screen.findByRole("button",{name:"Pause automation"}));await screen.findByText(/control or authorization may have been saved/);
 expect(screen.queryByRole("button",{name:"Retry same action"})).not.toBeInTheDocument();
 await user.click(screen.getByRole("button",{name:"Check saved result"}));await user.click(await screen.findByRole("button",{name:"Retry same action"}));await screen.findByText("Automation paused");
 const controls=invoke.mock.calls.filter(([c])=>c==="control_work_plan");expect(controls).toHaveLength(2);expect(controls[1][1].request).toEqual(controls[0][1].request);
 expect(invoke.mock.calls.filter(([c])=>c==="create_execution_identity")).toHaveLength(2);
});

it("reopens a persisted plan through its execution view and reads current control authority without dispatch",async()=>{
 const user=userEvent.setup(),ref=createRef<AiHandle>();
 plan={tools:null,checkers: [],planId,digest:"old",locale:"zh-CN",options:{stages:[{stage:"generation",mode:"assisted"}],selectionPolicy:"candidates-only",adoptResources:false,deliver:false,advisoryChecks:[]},scope:[{unitId:item.unitId,sourceRevisionId:item.sourceRevisionId,sourceSnapshotId:item.sourceSnapshotId,nativeKey:item.nativeKey,selectionId:null}],preview:prepared.preview,attemptId:aiAttempt};
 authority={plan,lease:{planId,generation:"3"},state:"paused",effects:["save-candidate"],expiresAt:String(Math.floor(Date.now()/1000)+600),toolInvocations:null};
 render(<TestAiWorkbench ref={ref} project={project}/>);
 ref.current!.showAttempt(aiAttempt);await screen.findByText("Automation paused");
 expect(screen.getByRole("heading",{name:"Data sharing preview"})).toBeInTheDocument();
 expect(screen.getAllByText(/test-model/).length).toBeGreaterThan(0);
 expect(invoke.mock.calls.some(([c])=>["authorize_work_plan","control_work_plan","start_work_plan"].includes(c))).toBe(false);
 await user.click(screen.getByRole("button",{name:"Refresh plan status"}));
 expect(invoke.mock.calls.filter(([c])=>c==="read_work_plan_status").every(([,a])=>a.request.planId===planId)).toBe(true);
});


it("confirms the displayed checked selection effects before dispatch", async () => {
  const user = await preview();
  const selector = screen.getByRole("combobox", { name: "Choose generated translations" });
  await user.selectOptions(selector, "missing-only");
  expect(screen.queryByRole("checkbox", { name: /I confirm sending/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  const request = invoke.mock.calls.filter(([command]) => command === "prepare_work_plan").at(-1)![1].request;
  expect(request.options.selectionPolicy).toBe("missing-only");
  expect(request.options.stages.find((choice: {stage: string}) => choice.stage === "checks").mode).toBe("assisted");
  await user.click(screen.getByRole("checkbox", { name: /I confirm sending/ }));
  expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I authorize this checker/ }));
  await user.click(screen.getByRole("button", { name: "Send and generate candidates" }));
  await screen.findByText("你好");
  expect(invoke.mock.calls.find(([command]) => command === "authorize_work_plan")![1].request.effects).toEqual(["save-candidate", "run-checks", "select-missing"]);
  expect(invoke.mock.calls.find(([command]) => command === "authorize_work_plan")![1].request.checkerExecutions).toEqual(plan.checkers.map(checker => checker.checker));
  await user.click(screen.getByRole("button", { name: "Pause automation" }));
  await screen.findByText("Automation paused");
  expect(screen.getByRole("checkbox", { name: /I authorize this checker/ })).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: /I authorize the displayed generation/ }));
  expect(screen.getByRole("button", { name: "Continue with renewed authorization" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I authorize this checker/ }));
  const checker = authority!.plan.checkers[0];
  if (checker?.kind !== "ready" || checker.plugin.kind !== "format") throw new Error("captured format checker required");
  const plugin = checker.plugin;
  authority = { ...authority!, plan: { ...authority!.plan, checkers: [{
    ...checker, plugin: { ...plugin, plugin: { ...plugin.plugin,
      settingsRevision: plugin.plugin.settingsRevision === "0" ? "1" : "0" } },
  }] } };
  await user.click(screen.getByRole("button", { name: "Refresh plan status" }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /I authorize this checker/ })).not.toBeChecked());
  expect(screen.getByRole("button", { name: "Continue with renewed authorization" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I authorize this checker/ }));
  await user.click(screen.getByRole("button", { name: "Continue with renewed authorization" }));
  await screen.findByText("Automation authorized");
  const continued = invoke.mock.calls.filter(([command]) => command === "control_work_plan").at(-1)![1].request;
  expect(continued.checkerExecutions).toEqual(plan.checkers.map(checker => checker.checker));
  expect(continued.expectedGeneration).toBe("2");
});

it("resets automatic selection when generation is changed to manual", async () => {
  const user = await preview();
  await user.selectOptions(screen.getByRole("combobox", { name: "Choose generated translations" }), "replace-captured-selection");
  await user.selectOptions(screen.getByRole("combobox", { name: "Translate" }), "manual");
  expect(screen.queryByRole("combobox", { name: "Choose generated translations" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Prepare manual plan" }));
  const request = invoke.mock.calls.filter(([command]) => command === "prepare_work_plan").at(-1)![1].request;
  expect(request.options.selectionPolicy).toBe("candidates-only");
  expect(request.options.stages.find((choice: {stage: string}) => choice.stage === "checks").mode).toBe("manual");
  expect(invoke.mock.calls.some(([command]) => command === "authorize_work_plan")).toBe(false);
});


it("keeps a checked plan unavailable when its installed checker cannot be prepared", async () => {
  const user = await preview();
  await user.selectOptions(screen.getByRole("combobox", { name: "Choose generated translations" }), "missing-only");
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    const value = await original(command, args);
    if (command === "prepare_work_plan") value.checkers = [{ kind: "unavailable", checker: value.checkers[0].checker, error: {
      code: "permission-denied", stage: "read", outcome: "rejected", recoveryRequired: false,
    } }];
    return value;
  });
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  await user.click(screen.getByRole("checkbox", { name: /I confirm sending/ }));
  expect(screen.getByText(/captured checker or approved runtime is unavailable/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "authorize_work_plan")).toBe(false);
});

it("displays native application identity and keeps checker consent separate", async () => {
  const user = await preview();
  await user.selectOptions(screen.getByRole("combobox", { name: "Choose generated translations" }), "missing-only");
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    const value = await original(command, args);
    if (command === "prepare_work_plan") {
      const checker: WorkPlanView["checkers"][number] = value.checkers[0];
      if (checker?.kind !== "ready" || checker.plugin.kind !== "format") throw new Error("captured format checker required");
      value.checkers = [{ ...checker, plugin: { ...checker.plugin, plugin: { ...checker.plugin.plugin, environment: {
        protocolVersion: 1, platform: { operatingSystem: "macos", architecture: "aarch64" },
        sdkVersion: "0.1.0-alpha.1", processProtocol: 2, profile: "native-application-host-v1",
        hostVersion: "0.2.0-alpha.1", executable: { kind: "darwin-code-directory-hash-v1", value: "a".repeat(40) },
      } } } } satisfies WorkPlanView["checkers"][number]];
    }
    return value;
  });
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  expect(await screen.findByText("Native plugin with application 0.2.0-alpha.1 on macos aarch64")).toBeInTheDocument();
  expect(screen.queryByText(/Fixed Node/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: /I confirm sending/ }));
  expect(screen.getByRole("checkbox", { name: /I authorize this checker/ })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "authorize_work_plan")).toBe(false);
});

function installReferenceProviders() {
  const alternative = structuredClone(toolQueryView);
  alternative.binding.capability.provider.plugin.id = "reference-alternative";
  alternative.binding.capability.provider.packageDigest = "c".repeat(64);
  alternative.binding.declaration.title = "Independent alternative reference";
  alternative.packageOrigin = { sourceId: "independent-local", publisherId: "user-approved" };
  const packageDetails = { ...structuredClone(toolQueryPackage), packageDigest: alternative.binding.capability.provider.packageDigest,
    manifest: { ...structuredClone(toolQueryPackage.manifest), plugin: alternative.binding.capability.provider.plugin } };
  const inventory = structuredClone(toolQueryInventory), provider = alternative.binding.capability.provider;
  inventory.packages.push({ originalInstallAction: "00000000-0000-4000-8000-000000000002", plugin: provider.plugin, packageDigest: provider.packageDigest, origin: alternative.packageOrigin, state: "sealed" });
  inventory.packageDecisions.push({ plugin: provider.plugin, packageDigest: provider.packageDigest, origin: alternative.packageOrigin, enabled: true });
  const views = [toolQueryView, alternative], original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_plugin_inventory") return structuredClone(inventory);
    if (command === "read_plugin_package") return structuredClone(args.request.packageDigest === packageDetails.packageDigest ? packageDetails : toolQueryPackage);
    if (command === "read_plugin_tool") return structuredClone((args.request.package as { packageDigest: string }).packageDigest === packageDetails.packageDigest ? alternative : toolQueryView);
    const value = await original(command, args);
    if (command === "prepare_work_plan") {
      const selection = args.request.toolSelection as WorkPlanToolSelection | null;
      if (selection) {
        const entries = selection.entries.map(entry => {
        const view = views.find(candidate => candidate.binding.capability.provider.packageDigest === entry.tool.package.packageDigest);
        if (!view) throw new Error("Missing captured synthetic provider");
        return { handle: entry.handle, target: entry.target, selections: entry.selections, binding: structuredClone(view.binding),
          environment: structuredClone(view.environment), resourceId: view.resourceId, settingsRevision: view.settingsRevision,
          packageOrigin: structuredClone(view.packageOrigin), runtimeOrigin: structuredClone(view.runtimeOrigin) };
        }).reverse();
        const [first, ...remaining] = entries;
        if (!first) throw new Error("Expected a nonempty captured tool selection");
        plan.tools = { maxInvocations: selection.maxInvocations, entries: [first, ...remaining] };
      } else plan.tools = null;
      return structuredClone(plan);
    }
    return value;
  });
  return views;
}
async function chooseReferences(user: ReturnType<typeof userEvent.setup>, views: ReturnType<typeof installReferenceProviders>) {
  await user.click(screen.getByRole("checkbox", { name: "Include read-only reference tools" }));
  await screen.findByRole("option", { name: /reference-alternative/ });
  for (const [index, view] of views.entries()) {
    if (index > 0) await user.click(screen.getByRole("button", { name: "Add reference provider" }));
    const row = within(screen.getByRole("group", { name: `Reference provider ${index + 1}` }));
    await user.selectOptions(row.getByRole("combobox", { name: "Reference package" }), `${view.binding.capability.provider.packageDigest}:${view.resourceId}`);
    await user.selectOptions(row.getByRole("combobox", { name: "Execution environment" }), view.environmentDigest);
    await row.findByRole("checkbox", { name: /^Term 👩🏽‍💻/ });
    await user.selectOptions(row.getByRole("combobox", { name: "Target language" }), index === 0 ? "zh-CN" : "ja");
    await user.click(row.getByRole("checkbox", { name: index === 0 ? /^Term 👩🏽‍💻/ : /^Other/ }));
  }
  await user.clear(screen.getByRole("spinbutton", { name: "Total tool-call limit" }));
  await user.type(screen.getByRole("spinbutton", { name: "Total tool-call limit" }), "3");
}

it("prepares multiple exact reference providers with distinct handles and one shared limit, accepting reordered keyed acknowledgements", async () => {
  const user = await preview(), views = installReferenceProviders();
  await chooseReferences(user, views);
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  await screen.findByRole("heading", { name: "Data sharing preview" });
  const request = invoke.mock.calls.filter(([command]) => command === "prepare_work_plan").at(-1)![1].request;
  expect(request.toolSelection.maxInvocations).toBe(3);
  expect(new Set(request.toolSelection.entries.map((entry: { handle: string }) => entry.handle)).size).toBe(2);
  expect(request.toolSelection.entries).toEqual(views.map((view, index) => ({ handle: expect.any(String),
    tool: { package: { plugin: view.binding.capability.provider.plugin, packageDigest: view.binding.capability.provider.packageDigest },
      resourceId: view.resourceId, environmentDigest: view.environmentDigest },
    target: index === 0 ? "zh-CN" : "ja", selections: index === 0 ? ["term"] : ["other"] })));
  expect(plan.tools?.entries.map(entry => entry.packageOrigin)).toEqual([...views].reverse().map(view => view.packageOrigin));
  expect(screen.getByText("Shared tool-call limit: 3")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /I allow these exact plugins/ })).not.toBeChecked();
  expect(invoke.mock.calls.some(([command]) => ["authorize_work_plan", "start_work_plan", "select_translation_revision", "save_term"].includes(command))).toBe(false);
  await user.click(screen.getByRole("checkbox", { name: /I confirm sending/ }));
  await user.click(screen.getByRole("button", { name: "Remove reference provider 2" }));
  expect(screen.queryByRole("heading", { name: "Data sharing preview" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: /I confirm sending/ })).not.toBeInTheDocument();
  expect(within(screen.getByRole("group", { name: "Reference provider 1" })).getByRole("checkbox", { name: /^Term 👩🏽‍💻/ })).toBeChecked();
});

it("refuses a reference preparation whose second provider origin was replaced and retains both option drafts", async () => {
  const user = await preview(), views = installReferenceProviders();
  await chooseReferences(user, views);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    const value = await original(command, args);
    if (command === "prepare_work_plan" && value.tools) value.tools.entries[0].packageOrigin = structuredClone(views[0].packageOrigin);
    return value;
  });
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("heading", { name: "Data sharing preview" })).not.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByRole("region", { name: "References in this work plan" })).toHaveAttribute("aria-busy", "false");
    const first = screen.getByRole("group", { name: "Reference provider 1" });
    const second = screen.getByRole("group", { name: "Reference provider 2" });
    expect(first).toHaveAttribute("aria-busy", "false");
    expect(second).toHaveAttribute("aria-busy", "false");
    expect(within(first).getByRole("combobox", { name: "Target language" })).toHaveValue("zh-CN");
    expect(within(second).getByRole("combobox", { name: "Target language" })).toHaveValue("ja");
    expect(within(first).getByRole("checkbox", { name: /^Term 👩🏽‍💻/ })).toBeChecked();
    expect(within(second).getByRole("checkbox", { name: /^Other/ })).toBeChecked();
  });
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_work_plan")).toHaveLength(2);
  expect(invoke.mock.calls.some(([command]) => ["authorize_work_plan", "start_work_plan"].includes(command))).toBe(false);
});

it("locks provider edits while allocating captured handles and does not prepare a replacement session after a late identity", async () => {
  const user = await preview(), views = installReferenceProviders();
  await chooseReferences(user, views);
  const original = invoke.getMockImplementation()!, ref = createRef<AiHandle>();
  let release: () => void = () => {}, calls = 0;
  const gate = new Promise<void>(done => { release = done; });
  invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "create_execution_identity" && ++calls === 2) await gate;
    return original(command, args);
  });
  // The mounted workbench remains the original production consumer.
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(2));
  expect(screen.getByRole("button", { name: "Add reference provider" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove reference provider 1" })).toBeDisabled();
  expect(screen.getByRole("spinbutton", { name: "Total tool-call limit" })).toBeDisabled();
  const oldPreparationCount = invoke.mock.calls.filter(([command]) => command === "prepare_work_plan").length;
  cleanup();
  render(<TestAiWorkbench key="replacement" ref={ref} project={{ ...project, sessionToken: "replacement" }} disabled={false} onOpenTranslation={async() => true} />);
  await act(async () => { release(); await gate; });
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_work_plan")).toHaveLength(oldPreparationCount);
  expect(invoke.mock.calls.some(([command]) => ["authorize_work_plan", "start_work_plan"].includes(command))).toBe(false);
});

async function prepareToggle() {
 const user=userEvent.setup(),rendered=render(<ToggleAiWorkbench project={project} mounted/>);
 await user.click(screen.getByRole("button",{name:"AI translation"}));
 await user.type(screen.getByRole("textbox",{name:"Chat Completions URL"}),"http://127.0.0.1:4000/v1/chat/completions");
 await user.type(screen.getByRole("textbox",{name:"Model"}),"test-model");
 await user.clear(screen.getByRole("textbox",{name:"API key environment variable name"}));
 await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));
 await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await screen.findByRole("heading",{name:"Data sharing preview"});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));
 return {user,rendered};
}

it("restores an original unknown generation after actual consumer unmount without automatically sending again",async()=>{
 const {user,rendered}=await prepareToggle(),original=invoke.getMockImplementation()!;
 let fail!:(error:unknown)=>void;
 invoke.mockImplementation((command:string,args:unknown)=>command==="start_work_plan"?new Promise((_,reject)=>{fail=reject;}):original(command,args));
 await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 rendered.rerender(<ToggleAiWorkbench project={project} mounted={false}/>);
 await act(async()=>{fail(new Error("Disconnected"));});
 rendered.rerender(<ToggleAiWorkbench project={project} mounted/>);
 await screen.findByText(/Start may have succeeded/);
 expect(invoke.mock.calls.filter(([name])=>name==="start_work_plan")).toHaveLength(1);
 expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();
 await user.click(screen.getByRole("button",{name:"Check saved result"}));
 await screen.findByText("你好");
 expect(screen.queryByText(/Start may have succeeded/)).not.toBeInTheDocument();
 expect(invoke.mock.calls.filter(([name])=>name==="start_work_plan")).toHaveLength(1);
});

it("finishes candidate saving through consumer identity and ACK waits and retains confirmation after read failure",async()=>{
 const {user,rendered}=await prepareToggle(),original=invoke.getMockImplementation()!;
 await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 const save=await screen.findByRole("button",{name:"Save candidate"});await waitFor(()=>expect(save).toBeEnabled());
 let identify!:(id:string)=>void,confirm!:(receipt:Receipt)=>void,failReads=false;
 invoke.mockImplementation((command:string,args:unknown)=>{
  if(command==="create_execution_identity")return new Promise<string>(resolve=>{identify=resolve;});
  if(command==="adopt_execution")return new Promise<Receipt>(resolve=>{confirm=resolve;});
  if(command==="read_ai_translation"&&failReads)return Promise.reject(new Error("Result read disconnected"));
  return original(command,args);
 });
 await user.click(save);
 rendered.rerender(<ToggleAiWorkbench project={project} mounted={false}/>);
 await act(async()=>{identify(executionFixture.prepare.actionId);});
 expect(invoke.mock.calls.filter(([name])=>name==="prepare_execution_adoption")).toHaveLength(1);
 expect(invoke.mock.calls.filter(([name])=>name==="adopt_execution")).toHaveLength(1);
 failReads=true;await act(async()=>{confirm(receiptFor());});
 rendered.rerender(<ToggleAiWorkbench project={project} mounted/>);
 await screen.findByText(/This candidate was saved/);
 await screen.findByRole("alert");
 expect(screen.queryByText(/Saving may have committed/)).not.toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Check saved result"})).not.toBeInTheDocument();
 expect(invoke.mock.calls.filter(([name])=>name==="create_execution_identity")).toHaveLength(2);
 failReads=false;await user.click(within(screen.getByRole("alert")).getByRole("button",{name:"Refresh"}));
 expect(await screen.findByRole("button",{name:"Candidate saved"})).toBeDisabled();
 expect(invoke.mock.calls.filter(([name])=>name==="adopt_execution")).toHaveLength(1);
 await act(async()=>{await i18n.changeLanguage("zh-CN");});
 expect(screen.getByText(/此候选已保存/)).toBeInTheDocument();
});

it("offers the captured uncertain candidate after a complete consumer remount and checks its original receipt",async()=>{
 const {user,rendered}=await prepareToggle(),original=invoke.getMockImplementation()!;
 invoke.mockImplementation((command:string,args:unknown)=>command==="adopt_execution"?Promise.reject(new Error("Disconnected"))
  :command==="read_execution_receipt"?Promise.resolve(receiptFor()):original(command,args));
 await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 await user.click(await screen.findByRole("button",{name:"Save candidate"}));
 await screen.findByText(/Saving may have committed/);
 const request=invoke.mock.calls.find(([name])=>name==="prepare_execution_adoption")![1].request;
 rendered.rerender(<ToggleAiWorkbench project={project} mounted={false}/>);
 rendered.rerender(<ToggleAiWorkbench project={project} mounted/>);
 await screen.findByText(/Saving may have committed/);
 const pendingNotice=screen.getByText(/Saving may have committed/).closest("section");
 if(!pendingNotice)throw new Error("Expected original candidate recovery section");
 expect(within(pendingNotice).getByText("first → zh-CN")).toBeInTheDocument();
 expect(invoke.mock.calls.filter(([name])=>name==="adopt_execution")).toHaveLength(1);
 await user.click(screen.getByRole("button",{name:"Check saved result"}));
 expect(await screen.findByRole("button",{name:"Candidate saved"})).toBeDisabled();
 expect(invoke.mock.calls.find(([name])=>name==="read_execution_receipt")![1].request).toEqual({sessionToken:project.sessionToken,projectId:project.metadata.projectId,actionId:request.actionId});
 expect(invoke.mock.calls.filter(([name])=>name==="adopt_execution")).toHaveLength(1);
});

it("lets a pure source read leave the view without taking the AI business reservation",async()=>{
 const user=userEvent.setup(),ref=createRef<AiHandle>(),original=invoke.getMockImplementation()!;
 let finish!:(page:ReturnType<typeof sourcePageFixture>)=>void;
 invoke.mockImplementation((command:string,args:unknown)=>command==="read_source_content"?new Promise(resolve=>{finish=resolve;}):original(command,args));
 render(<TestAiWorkbench project={project} ref={ref}/>);
 await user.click(screen.getByRole("button",{name:"AI translation"}));
 await waitFor(()=>expect(finish).toBeDefined());
 expect(screen.getByText(/Loading current source/)).toBeInTheDocument();
 expect(screen.getByRole("button",{name:"Back to overview"})).toBeEnabled();
 await user.click(screen.getByRole("button",{name:"Back to overview"}));
 let allowed=false;await act(async()=>{allowed=await ref.current!.allowLeave();});expect(allowed).toBe(true);
 await act(async()=>{finish(sourcePageFixture({snapshotId:fixtureIdentity(300),scope:{revision:"2",currentSnapshot:fixtureIdentity(300)}}));});
 expect(document.querySelector("section.ai-dialog")).toBeNull();
 expect(invoke.mock.calls.filter(([name])=>name==="start_work_plan"||name==="adopt_execution")).toHaveLength(0);
});
