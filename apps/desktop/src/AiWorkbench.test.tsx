import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import {cleanup,screen,waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type { AiHandle } from "./AiWorkbench";
import { createRef } from "react";
import type { WorkPlanView, WorkPlanReceiptView, WorkPlanStatusView } from "./workPlanCommands";
import {AiWorkbench} from "./AiWorkbench";
import {defaultAiConfig,type AiPrepared, type AiItem} from "./aiCommands";
import type {ProjectView} from "./projectCommands";
import {i18n} from "./i18n";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { aiAttempt, aiViewFixture } from "./testSupport/aiFixture";
import { formatReviewSlotFixture } from "./testSupport/textReviewFixture";
function formatCheckerFixture(): WorkPlanView["checkers"][number] {
  const checker = formatReviewSlotFixture();
  return { kind: "ready", checker: checker.checker, plugin: checker.plugin };
}
const invoke=vi.hoisted(()=>vi.fn());vi.mock("@tauri-apps/api/core",()=>({invoke}));
const project:ProjectView={sessionToken:"session",locator:"isolated",reconciliationState:"settled",metadata:{projectId:"project",displayName:"AI test",sourceLocale:"en",targetLocales:["zh-CN"],metadataRevision:"1"}};
const item:AiItem={unitId:fixtureIdentity(301),sourceRevisionId:fixtureIdentity(302),sourceSnapshotId:fixtureIdentity(300),nativeKey:"first",sourceLocale:"en",sourceText:"Hello",targetLocale:"zh-CN",terms:[],context:null,omissions:["terms-not-shared","context-not-shared"],resourceBaseline:"0"};
let prepared:AiPrepared;
let plan:WorkPlanView;
let authority:WorkPlanStatusView|null;
let actions:Map<string,WorkPlanReceiptView>;
let identity:number;
let startedGeneration:string;
const planId=fixtureIdentity(501);
beforeEach(async()=>{
 await i18n.changeLanguage("en-US");authority=null;actions=new Map();identity=510;startedGeneration="1";
 prepared={attemptId:aiAttempt,preview:{config:{...defaultAiConfig,endpoint:"http://127.0.0.1:4000/v1/chat/completions",model:"test-model",credentialEnv:""},recipe:"direct-translation-1",digest:"digest",items:[item]}};
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
   const view=aiViewFixture(item,prepared.preview.config);view.planId=authority?planId:null;view.planGeneration=authority?startedGeneration:null;
   view.detail.attemptId=String(request.attemptId);view.detail.recovery.attemptId=String(request.attemptId);return view;
  }
  if(command==="create_execution_identity")return fixtureIdentity(identity++);
  if(command==="prepare_execution_adoption")return executionFixture.action;
  if(command==="adopt_execution")return executionFixture.receipt;
  throw new Error(command);
 });
});
afterEach(cleanup);

it("reveals invalid connection fields when preview fails after settings were collapsed",async()=>{
 const user=userEvent.setup();render(<AiWorkbench project={project} disabled={false} onOpenTranslation={()=>true}/>);
 await user.click(screen.getByRole("button",{name:"AI translation"}));
 await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));
 const connection=screen.getByText("Connection",{selector:"summary"});
 await user.click(connection);expect(connection.closest("details")).not.toHaveAttribute("open");
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((command:string,args:unknown)=>command==="prepare_work_plan"?Promise.reject({code:"invalid-input", outcome: "rejected",reason:"ai-model"}):original(command,args));
 await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await waitFor(()=>expect(connection.closest("details")).toHaveAttribute("open"));
 expect(screen.getByRole("textbox",{name:"Model"})).toHaveAttribute("aria-invalid","true");
 expect(invoke.mock.calls.some(([command])=>command==="start_work_plan")).toBe(false);
});

it("keeps a draft on stay and clears it only after explicit discard",async()=>{
 const user=await preview();await user.click(screen.getByRole("button",{name:"Back to overview"}));await user.click(await screen.findByRole("button",{name:"Stay and keep draft"}));expect(screen.getByRole("textbox",{name:"Model"})).toHaveValue("test-model");await user.click(screen.getByRole("button",{name:"Back to overview"}));await user.click(await screen.findByRole("button",{name:"Discard draft and leave"}));await user.click(screen.getByRole("button",{name:"AI translation"}));expect(screen.getByRole("textbox",{name:"Model"})).toHaveValue("");expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();
});

it("ignores a preview from a project that was replaced while the request was pending",async()=>{
 const user=userEvent.setup();const rendered=render(<AiWorkbench key="session" project={project} disabled={false} onOpenTranslation={()=>true}/>);await user.click(screen.getByRole("button",{name:"AI translation"}));await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));let resolve:(value:WorkPlanView)=>void=()=>{};const original=invoke.getMockImplementation()!;invoke.mockImplementation((command:string,args:unknown)=>command==="prepare_work_plan"?new Promise<WorkPlanView>(done=>{resolve=done;}):original(command,args));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));rendered.rerender(<AiWorkbench key="replacement" project={{...project,sessionToken:"replacement"}} disabled={false} onOpenTranslation={()=>true}/>);resolve({...plan,checkers:[],planId,digest:"plan-digest",locale:"zh-CN",options:{stages:[{stage:"generation",mode:"assisted"}],selectionPolicy:"candidates-only",adoptResources:false,deliver:false,advisoryChecks:[]},attemptId:aiAttempt,preview:prepared.preview,scope:[{unitId:item.unitId,sourceRevisionId:item.sourceRevisionId,sourceSnapshotId:item.sourceSnapshotId,nativeKey:"first",selectionId:null}]});await user.click(screen.getByRole("button",{name:"AI translation"}));await screen.findByRole("checkbox",{name:"first: Hello"});expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();expect(invoke.mock.calls.some(([c])=>c==="start_work_plan")).toBe(false);
});
async function preview(){const user=userEvent.setup();render(<AiWorkbench project={project} disabled={false} onOpenTranslation={()=>true}/>);await user.click(screen.getByRole("button",{name:"AI translation"}));await user.type(screen.getByRole("textbox",{name:"Chat Completions URL"}),"http://127.0.0.1:4000/v1/chat/completions");await user.type(screen.getByRole("textbox",{name:"Model"}),"test-model");await user.clear(screen.getByRole("textbox",{name:"API key environment variable name"}));await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));await screen.findByRole("heading",{name:"Data sharing preview"});return user;}
it("requires exact sharing confirmation and invalidates it on configuration edits",async()=>{const user=await preview();expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeDisabled();expect(screen.getByRole("checkbox",{name:"Share applicable adopted terms"})).not.toBeChecked();expect(invoke.mock.calls.some(([c])=>c==="start_work_plan")).toBe(false);await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeEnabled();await user.type(screen.getByRole("textbox",{name:"Model"}),"-changed");expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();});
it("keeps empty limits editable and rejects them before preview serialization",async()=>{const user=await preview();await user.click(screen.getByText("Budget and limits"));await user.clear(screen.getByRole("spinbutton",{name:"Maximum requests including retries"}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));expect(await screen.findByRole("alert")).toHaveFocus();expect(screen.getByRole("spinbutton",{name:"Maximum requests including retries"})).toHaveAttribute("aria-invalid","true");expect(invoke.mock.calls.filter(([c])=>c==="prepare_work_plan")).toHaveLength(1);expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();});
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
 invoke.mockImplementation((command:string,args:unknown)=>command==="adopt_execution"?Promise.reject({code:"outcome-unknown"}):command==="read_execution_receipt"?Promise.resolve(executionFixture.receipt):original(command,args));
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await user.click(await screen.findByRole("button",{name:"Save candidate"}));await screen.findByText(/Saving may have committed/);await user.click(screen.getByRole("button",{name:"Check saved result"}));
 await waitFor(()=>expect(screen.queryByText(/Saving may have committed/)).not.toBeInTheDocument());expect(invoke.mock.calls.filter(([c])=>c==="adopt_execution")).toHaveLength(1);expect(screen.queryByRole("button",{name:"Retry same action"})).not.toBeInTheDocument();
});

it("shows durable unknown and legacy exposure without replaying when refreshed",async()=>{
 const user=await preview();const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((command:string,args:unknown)=>{if(command==="read_ai_translation"){const view=aiViewFixture(item,prepared.preview.config);view.budget={limit:20,dispatched:2,legacyHeld:3,unresolved:1,usageUnknown:2,promptTokens:"9007199254740993",completionTokens:"0"};return Promise.resolve(view);}return original(command,args);});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 await screen.findByText(/reserved requests 2 · awaiting confirmation 1 · unknown usage 2/);expect(screen.getByText(/up to 3 possible requests held/)).toBeInTheDocument();expect(screen.getByText(/9007199254740993 input/)).toBeInTheDocument();
 await i18n.changeLanguage("zh-CN");expect(await screen.findByText(/已占请求额度 2.*待核对 1.*用量未知 2/)).toBeInTheDocument();await user.click(screen.getAllByRole("button",{name:"刷新"})[0]);expect(invoke.mock.calls.filter(([c])=>c==="start_work_plan")).toHaveLength(1);
});
it("explains queue rejection and preserves preview without sending another task",async()=>{
 const user=await preview();const original=invoke.getMockImplementation()!;invoke.mockImplementation((c:string,a:unknown)=>c==="start_work_plan"?Promise.reject({code:"limit-exceeded",outcome:"rejected",reason:"execution-queue"}):original(c,a));
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await screen.findByText(/waiting queue is full/);expect(screen.getByRole("heading",{name:"Data sharing preview"})).toBeInTheDocument();expect(invoke.mock.calls.filter(([c])=>c==="start_work_plan")).toHaveLength(1);
});

it("prepares a model-free manual plan and opens its captured entry without authorization",async()=>{
 const user=userEvent.setup(),openEditor=vi.fn(()=>true);
 render(<AiWorkbench project={project} disabled={false} onOpenTranslation={openEditor}/>);
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
 render(<AiWorkbench ref={ref} project={project} disabled={false} onOpenTranslation={()=>true}/>);
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
