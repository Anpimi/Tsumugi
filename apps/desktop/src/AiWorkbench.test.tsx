import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import {act,cleanup,screen,waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {createRef,useEffect,type Ref} from "react";
import {AiWorkbench,type AiHandle} from "./AiWorkbench";
import {AiPreparationSession} from "./AiPreparationSession";
import {useSessionReads} from "./SessionReadProvider";
import type {SessionReads} from "./sessionReads";
import {defaultAiConfig,type AiConfig,type AiPrepared, type AiItem} from "./aiCommands";
import type {ProjectView} from "./projectCommands";
import {i18n} from "./i18n";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { aiAttempt, aiViewFixture } from "./testSupport/aiFixture";
const invoke=vi.hoisted(()=>vi.fn());vi.mock("@tauri-apps/api/core",()=>({invoke}));
const project:ProjectView={sessionToken:"session",locator:"isolated",reconciliationState:"settled",metadata:{projectId:fixtureIdentity(500),displayName:"AI test",sourceLocale:"en",targetLocales:["zh-CN"],metadataRevision:"1"}};
let currentReads:SessionReads|null=null;
function CaptureReads(){const reads=useSessionReads();useEffect(()=>{currentReads=reads;return()=>{if(currentReads===reads)currentReads=null;};},[reads]);return null;}
function TestAiWorkbench({project:current,ref}:{project:ProjectView;ref?:Ref<AiHandle>}) {
 return <AiPreparationSession initialLocale={current.metadata.targetLocales[0]??""} targetLocales={current.metadata.targetLocales}>
  <CaptureReads/>
  <AiWorkbench project={current} ref={ref} disabled={false} onOpenTranslation={()=>true}/>
 </AiPreparationSession>;
}
function ToggleAiWorkbench({project:current,mounted}:{project:ProjectView;mounted:boolean}) {
 return <AiPreparationSession initialLocale={current.metadata.targetLocales[0]??""} targetLocales={current.metadata.targetLocales}>
  {mounted?<AiWorkbench project={current} disabled={false} onOpenTranslation={()=>true}/>:null}
 </AiPreparationSession>;
}
const item:AiItem={unitId:fixtureIdentity(301),sourceRevisionId:fixtureIdentity(302),sourceSnapshotId:fixtureIdentity(300),nativeKey:"first",sourceLocale:"en",sourceText:"Hello",targetLocale:"zh-CN",terms:[],context:null,omissions:["terms-not-shared","context-not-shared"],resourceBaseline:"0"};
let prepared:AiPrepared;
beforeEach(async()=>{currentReads=null;await i18n.changeLanguage("en-US");prepared={attemptId:aiAttempt,preview:{config:{...defaultAiConfig,endpoint:"http://127.0.0.1:4000/v1/chat/completions",model:"test-model",credentialEnv:""},recipe:"direct-translation-1",digest:"digest",items:[item]}};invoke.mockReset();invoke.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{if(command==="read_content_scope")return{revision:"2",currentSnapshot:fixtureIdentity(300)};if(command==="read_source_content")return sourcePageFixture({snapshotId:fixtureIdentity(300),scope:{revision:"2",currentSnapshot:fixtureIdentity(300)},rows:[sourceRowFixture({unitId:fixtureIdentity(301),sourceRevisionId:fixtureIdentity(302)},{key:"first",text:item.sourceText})]});if(command==="preview_ai_translation"){prepared.preview.config=args.request.config as typeof defaultAiConfig;return prepared;}if(command==="start_ai_translation")return aiAttempt;if(command==="read_ai_translation")return aiViewFixture(item,prepared.preview.config);if(command==="create_execution_identity")return executionFixture.prepare.actionId;if(command==="prepare_execution_adoption")return executionFixture.action;if(command==="adopt_execution")return executionFixture.receipt;throw new Error(command);});});
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
 await user.click(connection);expect(connection.closest("details")).not.toHaveAttribute("open");
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((command:string,args:unknown)=>command==="preview_ai_translation"?Promise.reject({code:"invalid-input", outcome: "rejected",reason:"ai-model"}):original(command,args));
 await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await waitFor(()=>expect(connection.closest("details")).toHaveAttribute("open"));
 expect(screen.getByRole("textbox",{name:"Model"})).toHaveAttribute("aria-invalid","true");
 expect(invoke.mock.calls.some(([command])=>command==="start_ai_translation")).toBe(false);
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
 const previews=invoke.mock.calls.filter(([command])=>command==="preview_ai_translation").length;
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
 expect(invoke.mock.calls.filter(([command])=>command==="preview_ai_translation")).toHaveLength(previews);
 expect(invoke.mock.calls.filter(([command])=>command==="start_ai_translation")).toHaveLength(0);
});

it("ignores a preview from a project that was replaced while the request was pending",async()=>{
 const user=userEvent.setup();const rendered=render(<TestAiWorkbench key="session" project={project}/>);await user.click(screen.getByRole("button",{name:"AI translation"}));await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));let resolve:(value:AiPrepared)=>void=()=>{};const original=invoke.getMockImplementation()!;invoke.mockImplementation((command:string,args:unknown)=>command==="preview_ai_translation"?new Promise<AiPrepared>(done=>{resolve=done;}):original(command,args));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));rendered.rerender(<TestAiWorkbench key="replacement" project={{...project,sessionToken:"replacement"}}/>);resolve(prepared);await user.click(screen.getByRole("button",{name:"AI translation"}));await screen.findByRole("checkbox",{name:"first: Hello"});expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();expect(invoke.mock.calls.some(([c])=>c==="start_ai_translation")).toBe(false);
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
 expect(invoke.mock.calls.filter(([command])=>command==="start_ai_translation")).toHaveLength(0);
});
it("shows a removed captured target until the user chooses a current language and prepares again",async()=>{
 const user=userEvent.setup();const rendered=render(<TestAiWorkbench project={project}/>);
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
  if(command==="preview_ai_translation"&&args.request.locale==="ja-JP")return{
   attemptId:fixtureIdentity(420),preview:{config:args.request.config as AiConfig,recipe:"direct-translation-1",digest:"ja-preview",items:[{...item,targetLocale:"ja-JP"}]}
  } satisfies AiPrepared;
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
 expect(invoke.mock.calls.filter(([command])=>command==="start_ai_translation")).toHaveLength(0);
});
it("lets the user explicitly clear a removed cross-page AI scope without losing connection settings",async()=>{
 const user=userEvent.setup();const removedUnit=item.unitId, replacementUnit=fixtureIdentity(401);
 let removed=false;
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
  if(command==="read_content_scope"&&removed)return{revision:"3",currentSnapshot:fixtureIdentity(400)};
  if(command==="read_source_content"&&removed)return sourcePageFixture({snapshotId:fixtureIdentity(400),scope:{revision:"3",currentSnapshot:fixtureIdentity(400)},rows:[sourceRowFixture({unitId:replacementUnit,sourceRevisionId:fixtureIdentity(402)},{key:"second",text:"World"})]});
  if(command==="preview_ai_translation"&&removed){
   const units=args.request.unitIds as string[];
   if(units.includes(removedUnit))throw{code:"invalid-input",outcome:"rejected",stage:"execution-read",reason:"execution-storage",recoveryRequired:false};
   return{attemptId:fixtureIdentity(410),preview:{config:args.request.config as AiConfig,recipe:"direct-translation-1",digest:"replacement-digest",items:[{...item,unitId:replacementUnit,sourceRevisionId:fixtureIdentity(402),sourceSnapshotId:fixtureIdentity(400),nativeKey:"second",sourceText:"World"}]}} satisfies AiPrepared;
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
 await screen.findByText(/execution-storage|failed/i);
 expect(invoke.mock.calls.filter(([command])=>command==="preview_ai_translation")).toHaveLength(2);
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
 expect(invoke.mock.calls.filter(([command])=>command==="start_ai_translation")).toHaveLength(0);
});
async function preview(ref?:Ref<AiHandle>){const user=userEvent.setup();render(<TestAiWorkbench project={project} ref={ref}/>);await user.click(screen.getByRole("button",{name:"AI translation"}));await user.type(screen.getByRole("textbox",{name:"Chat Completions URL"}),"http://127.0.0.1:4000/v1/chat/completions");await user.type(screen.getByRole("textbox",{name:"Model"}),"test-model");await user.clear(screen.getByRole("textbox",{name:"API key environment variable name"}));await user.click(await screen.findByRole("checkbox",{name:"first: Hello"}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));await screen.findByRole("heading",{name:"Data sharing preview"});return user;}
it("requires exact sharing confirmation and invalidates it on configuration edits",async()=>{const user=await preview();expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeDisabled();expect(screen.getByRole("checkbox",{name:"Share applicable adopted terms"})).not.toBeChecked();expect(invoke.mock.calls.some(([c])=>c==="start_ai_translation")).toBe(false);await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeEnabled();await user.type(screen.getByRole("textbox",{name:"Model"}),"-changed");expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();});
it("keeps empty limits editable and rejects them before preview serialization",async()=>{const user=await preview();await user.click(screen.getByText("Budget and limits"));await user.clear(screen.getByRole("spinbutton",{name:"Maximum requests including retries"}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));expect(await screen.findByRole("alert")).toHaveFocus();expect(screen.getByRole("spinbutton",{name:"Maximum requests including retries"})).toHaveAttribute("aria-invalid","true");expect(invoke.mock.calls.filter(([c])=>c==="preview_ai_translation")).toHaveLength(1);expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();});
it("saves a normal candidate without issuing a translation selection",async()=>{const user=await preview();await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await user.click(await screen.findByRole("button",{name:"Save candidate"}));await waitFor(()=>expect(invoke.mock.calls.some(([c])=>c==="adopt_execution")).toBe(true));expect(invoke.mock.calls.some(([c])=>c==="select_translation_revision")).toBe(false);expect(screen.getAllByText(/Total usage/).length).toBeGreaterThan(0);});
it("keeps an uncertain start identity and blocks leaving until reconciliation",async()=>{const user=await preview();const original=invoke.getMockImplementation()!;invoke.mockImplementation((command:string,args:unknown)=>command==="start_ai_translation"?Promise.reject({code:"outcome-unknown"}):original(command,args));await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await screen.findByText(/Start may have succeeded/);expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();await user.click(screen.getByRole("button",{name:"Check saved result"}));await waitFor(()=>expect(screen.queryByText(/Start may have succeeded/)).not.toBeInTheDocument());const calls=invoke.mock.calls.filter(([c])=>c==="start_ai_translation");expect(calls).toHaveLength(1);expect(calls[0][1].request.attemptId).toBe(aiAttempt);});

it("reconciles a well-formed acknowledgement for the wrong AI attempt without resending",async()=>{
 const user=await preview();const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((command:string,args:unknown)=>command==="start_ai_translation"?Promise.resolve(fixtureIdentity(499)):original(command,args));
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 await screen.findByText(/Start may have succeeded/);expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();
 await user.click(screen.getByRole("button",{name:"Check saved result"}));await screen.findByText("你好");
 expect(invoke.mock.calls.filter(([c])=>c==="start_ai_translation")).toHaveLength(1);
 expect(invoke.mock.calls.find(([c])=>c==="read_ai_translation")?.[1].request.attemptId).toBe(aiAttempt);
});

it("checks an uncertain adoption receipt before retrying the same action",async()=>{
 const user=await preview();const original=invoke.getMockImplementation()!;let lost=true;
 invoke.mockImplementation((command:string,args:unknown)=>{if(command==="adopt_execution"&&lost){lost=false;return Promise.reject({code:"outcome-unknown"});}if(command==="read_execution_receipt")return Promise.resolve(null);return original(command,args);});
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await user.click(await screen.findByRole("button",{name:"Save candidate"}));await screen.findByText(/Saving may have committed/);
 expect(screen.queryByRole("button",{name:"Retry same action"})).not.toBeInTheDocument();expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();
 await user.click(screen.getByRole("button",{name:"Check saved result"}));await user.click(await screen.findByRole("button",{name:"Retry same action"}));await waitFor(()=>expect(screen.queryByText(/Saving may have committed/)).not.toBeInTheDocument());
 const calls=invoke.mock.calls.filter(([c])=>c==="adopt_execution");expect(calls).toHaveLength(2);expect(calls.map(([,args])=>args.request.actionId)).toEqual([executionFixture.prepare.actionId,executionFixture.prepare.actionId]);expect(invoke.mock.calls.filter(([c])=>c==="create_execution_identity")).toHaveLength(1);
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
 await i18n.changeLanguage("zh-CN");expect(await screen.findByText(/已占请求额度 2.*待核对 1.*用量未知 2/)).toBeInTheDocument();await user.click(screen.getAllByRole("button",{name:"刷新"})[0]);expect(invoke.mock.calls.filter(([c])=>c==="start_ai_translation")).toHaveLength(1);
});
it("explains queue rejection and preserves preview without sending another task",async()=>{
 const user=await preview();const original=invoke.getMockImplementation()!;invoke.mockImplementation((c:string,a:unknown)=>c==="start_ai_translation"?Promise.reject({code:"limit-exceeded",outcome:"rejected",reason:"execution-queue"}):original(c,a));
 await user.click(screen.getByRole("checkbox",{name:/I confirm sending/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));await screen.findByText(/waiting queue is full/);expect(screen.getByRole("heading",{name:"Data sharing preview"})).toBeInTheDocument();expect(invoke.mock.calls.filter(([c])=>c==="start_ai_translation")).toHaveLength(1);
});
