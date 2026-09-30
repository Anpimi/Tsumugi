import {cleanup,render,screen,waitFor,within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {createRef} from "react";
import {ArenaWorkbench} from "./ArenaWorkbench";
import type {AiHandle} from "./AiWorkbench";
import type {ProjectView} from "./projectCommands";
import {defaultArenaConfig,type ArenaPrepared,type ComparisonView} from "./arenaCommands";
import {i18n} from "./i18n";
const invoke=vi.hoisted(()=>vi.fn());vi.mock("@tauri-apps/api/core",()=>({invoke}));
const project:ProjectView={sessionToken:"session",locator:"isolated",reconciliationState:"settled",metadata:{projectId:"project",displayName:"Arena test",sourceLocale:"en",targetLocales:["zh-CN","ja"],metadataRevision:"1"}};
const item={unitId:"unit",sourceRevisionId:"source",sourceSnapshotId:"snapshot",nativeKey:"first",sourceLocale:"en",sourceText:"Hello {name}",targetLocale:"zh-CN",terms:[],context:null,omissions:["terms-not-shared","context-not-shared"],resourceBaseline:0};
let prepared:ArenaPrepared,comparison:ComparisonView;
beforeEach(async()=>{await i18n.changeLanguage("en-US");prepared={attemptId:"attempt",preview:{config:defaultArenaConfig(),digest:"digest",items:[{slot:0,sourceOrder:0,item},{slot:1,sourceOrder:0,item}]}};
 comparison={comparisonId:"comparison",unitId:"unit",locale:"zh-CN",sourceRevisionId:"source",sourceText:item.sourceText,nativeKey:"first",selectionId:"selected",selectedRevisionId:"r1",basis:"basis",blind:true,revealed:false,rows:[{revisionId:"r1",text:"First {name}",sourceRevisionId:"source",originKind:"ai",contributors:[],model:null,recipe:null,basisCurrent:true},{revisionId:"r2",text:"Second {name}",sourceRevisionId:"source",originKind:"manual",contributors:[],model:null,recipe:null,basisCurrent:true}]};
 invoke.mockReset();invoke.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
  if(command==="read_content_scope")return{currentSnapshot:"snapshot"};if(command==="read_source_content")return{rows:[{unitId:"unit",sourceRevisionId:"source",occurrence:{key:"first",text:item.sourceText}}],nextOrdinal:null};
  if(command==="list_arena_comparisons")return[];
  if(command==="preview_arena_translation"){prepared.preview.config=args.request.config as typeof prepared.preview.config;return prepared;}
  if(command==="start_arena_translation")return"attempt";
  if(command==="read_arena_translation")return{detail:{attemptId:"attempt",taskId:"task",operation:"arena-translation",progress:{queued:0,running:0,succeeded:2,failed:0,unknown:0,adopted:0},items:[],recovery:{units:[]}},rows:[{item,itemId:"i2",sourceOrder:0,label:0,resultId:"out2",output:{text:"Second output",usage:null,requests:1,usageIncomplete:true}},{item,itemId:"i1",sourceOrder:0,label:1,resultId:"out1",output:{text:"First output",usage:null,requests:1,usageIncomplete:true}}],variants:null,blind:true,revealed:false,differentInputs:false,repeatedSampling:true,parentAttemptId:null};
  if(command==="read_translation_history")return{unitId:"unit",locale:"zh-CN",total:2,current:{eventId:"selected",revisionId:"r1"},currentText:"First {name}",rows:comparison.rows.map((r,i)=>({...r,ordinal:i+1})),nextOrdinal:null};
  if(command==="create_arena_comparison"||command==="read_arena_comparison")return comparison;
  if(command==="create_execution_identity")return"action";
  if(command==="read_translation_action")return null;
  if(command==="save_arena_merge")return{eventId:"merged",revisionId:"merged-revision",actionId:"action"};
  if(command==="select_translation_revision")return{eventId:"new-selection",revisionId:args.request.revisionId,actionId:"action"};
  throw new Error(command);
 });
});afterEach(cleanup);
async function open(){const user=userEvent.setup();render(<ArenaWorkbench project={project} disabled={false} onOpenTranslation={()=>true}/>);await user.click(screen.getByRole("button",{name:"Arena comparison"}));await screen.findByRole("checkbox",{name:/first: Hello/});return user;}
async function compare(){const user=await open();await user.selectOptions(screen.getByRole("combobox",{name:"Original string"}),"unit");await user.click(await screen.findByRole("checkbox",{name:/Revision 1/}));await user.click(screen.getByRole("checkbox",{name:/Revision 2/}));await user.click(screen.getAllByRole("checkbox",{name:"Hide candidate identities until revealed"})[1]);await user.click(screen.getByRole("button",{name:"Start comparison"}));await screen.findByRole("button",{name:"Edit a manual merge"});return user;}

it("keeps offline comparison independent of any generation or provider",async()=>{await compare();expect(invoke.mock.calls.some(([c])=>c.includes("arena_translation"))).toBe(false);expect(screen.getAllByText("First {name}").length).toBeGreaterThan(0);expect(screen.getByRole("button",{name:"Reveal candidate identities"})).toBeEnabled();});
it("loads current strings without opening every historical comparison",async()=>{
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((c:string,a:unknown)=>c==="list_arena_comparisons"?Promise.resolve([{comparisonId:"removed",nativeKey:"removed original",locale:"zh-CN"}]):
  c==="read_arena_comparison"?Promise.reject({code:"dependency-conflict",field:"translation-source"}):original(c,a));
 const user=await open();expect(invoke.mock.calls.some(([c])=>c==="read_arena_comparison")).toBe(false);
 await user.click(screen.getByRole("button",{name:"Reopen comparison: removed original · zh-CN"}));await screen.findByRole("alert");
 expect(screen.getByRole("checkbox",{name:/first: Hello/})).toBeEnabled();
});
it("keeps selected revisions while loading another history page",async()=>{
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(c:string,a:{request:Record<string,unknown>})=>{
  const value=await original(c,a);
  if(c==="read_translation_history")return a.request.afterOrdinal===50?{...value,rows:[{...comparison.rows[1],revisionId:"r51",ordinal:51}],nextOrdinal:null}:
   {...value,rows:[{...comparison.rows[0],ordinal:1}],nextOrdinal:50};
  return value;
 });
 const user=await open();await user.selectOptions(screen.getByRole("combobox",{name:"Original string"}),"unit");
 await user.click(await screen.findByRole("checkbox",{name:/Revision 1/}));await user.click(screen.getByRole("button",{name:"Load more revisions"}));
 expect(await screen.findByRole("checkbox",{name:/Revision 1/})).toBeChecked();await user.click(screen.getByRole("checkbox",{name:/Revision 51/}));
 await user.click(screen.getByRole("button",{name:"Start comparison"}));await screen.findByRole("button",{name:"Edit a manual merge"});
 expect(invoke.mock.calls.find(([c])=>c==="create_arena_comparison")?.[1].request.revisionIds).toEqual(["r1","r51"]);
});
it("keeps offline blind preference separate from a confirmed generation preview",async()=>{
 const user=await open();await user.click(screen.getByRole("checkbox",{name:/first: Hello/}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await user.click(await screen.findByRole("checkbox",{name:/I confirm sending the shown/}));
 await user.selectOptions(screen.getByRole("combobox",{name:"Original string"}),"unit");await screen.findByRole("checkbox",{name:/Revision 1/});
 const controls=screen.getAllByRole("checkbox",{name:"Hide candidate identities until revealed"});await user.click(controls[1]);
 expect(controls[0]).not.toBeChecked();expect(prepared.preview.config.blind).toBe(false);
 expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeEnabled();
});
it("invalidates consent when the second scheme changes",async()=>{const user=await open();await user.click(screen.getByRole("checkbox",{name:/first: Hello/}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));await user.click(await screen.findByRole("checkbox",{name:/I confirm sending the shown/}));expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeEnabled();await user.type(screen.getByRole("textbox",{name:"Scheme 2 · Model"}),"different");expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();expect(invoke.mock.calls.some(([c])=>c==="start_arena_translation")).toBe(false);});
it("preserves stable anonymous labels and does not infer a winner from returned order",async()=>{const user=await open();await user.click(screen.getByRole("checkbox",{name:/first: Hello/}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));await user.click(await screen.findByRole("checkbox",{name:/I confirm sending the shown/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));const a=await screen.findByRole("heading",{name:"Candidate A"});expect(within(a.closest("article")!).getByText("Second output")).toBeInTheDocument();expect(screen.queryByText("alpha-model")).not.toBeInTheDocument();expect(invoke.mock.calls.some(([c])=>c==="select_translation_revision"||c==="adopt_execution")).toBe(false);});
it("sends observed selection and all contributors in one merge request",async()=>{const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));await user.clear(screen.getByRole("textbox",{name:"Merged translation"}));await user.click(screen.getByRole("textbox",{name:"Merged translation"}));await user.paste("Combined {name}");await user.click(screen.getByRole("button",{name:"Save merge and select"}));await screen.findByText(/Merge saved and selected/);const request=invoke.mock.calls.find(([c])=>c==="save_arena_merge")![1].request;expect(request).toMatchObject({unitId:"unit",locale:"zh-CN",sourceRevisionId:"source",expectedSelectionId:"selected",text:"Combined {name}",merge:{contributors:["r1","r2"],expectedBasis:"basis"}});expect(invoke.mock.calls.some(([c])=>c==="save_translation_revision"||c==="select_translation_revision")).toBe(false);});
it("keeps newer input when a previous merge save returns successfully",async()=>{const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));let finish:(v:unknown)=>void=()=>{};const original=invoke.getMockImplementation()!;invoke.mockImplementation((c:string,a:unknown)=>c==="save_arena_merge"?new Promise(done=>{finish=done;}):original(c,a));await user.click(screen.getByRole("button",{name:"Save merge and select"}));const input=screen.getByRole("textbox",{name:"Merged translation"});expect(input).toBeEnabled();await user.type(input," plus newer edit");finish({revisionId:"merged"});await screen.findByText(/Merge saved and selected/);expect(input).toHaveValue("First {name} plus newer edit");await user.click(screen.getByRole("button",{name:"Back"}));expect(await screen.findByText("Keep your Arena draft?")).toBeInTheDocument();});
it("preserves a merge draft on a relevant-basis conflict and allows explicit rebase",async()=>{const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));const original=invoke.getMockImplementation()!;invoke.mockImplementation((c:string,a:unknown)=>c==="save_arena_merge"?Promise.reject({code:"dependency-conflict",field:"arena-basis"}):original(c,a));await user.click(screen.getByRole("button",{name:"Save merge and select"}));expect(await screen.findByRole("alert")).toHaveFocus();expect(screen.getByRole("textbox",{name:"Merged translation"})).toHaveValue("First {name}");comparison={...comparison,basis:"new-basis",selectionId:"new-selection"};await user.click(screen.getByRole("button",{name:"Review current basis and keep draft"}));expect(screen.getByRole("textbox",{name:"Merged translation"})).toHaveValue("First {name}");});
it("checks an uncertain merge before repeating the exact action",async()=>{const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));const original=invoke.getMockImplementation()!;let first=true;invoke.mockImplementation((c:string,a:unknown)=>{if(c==="save_arena_merge"&&first){first=false;return Promise.reject({code:"outcome-unknown"});}return original(c,a);});await user.click(screen.getByRole("button",{name:"Save merge and select"}));await screen.findByText(/The action may have committed/);expect(screen.queryByRole("button",{name:"Retry same action"})).not.toBeInTheDocument();expect(screen.getByRole("button",{name:"Back"})).toBeDisabled();await user.click(screen.getByRole("button",{name:"Check saved result"}));await user.click(await screen.findByRole("button",{name:"Retry same action"}));await screen.findByText(/Merge saved and selected/);const saves=invoke.mock.calls.filter(([c])=>c==="save_arena_merge");expect(saves).toHaveLength(2);expect(saves[0][1]).toEqual(saves[1][1]);});
it("reconciles a committed merge after a newer selection without resaving",async()=>{
 const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((c:string,a:unknown)=>{
  if(c==="save_arena_merge")return Promise.reject({code:"outcome-unknown"});
  if(c==="read_translation_action")return Promise.resolve({eventId:"saved-merge",revisionId:"merged",actionId:"action"});
  return original(c,a);
 });
 await user.click(screen.getByRole("button",{name:"Save merge and select"}));await screen.findByText(/The action may have committed/);
 comparison={...comparison,selectionId:"newer-selection",selectedRevisionId:"r2"};
 await user.click(screen.getByRole("button",{name:"Check saved result"}));await screen.findByText(/The saved action has been confirmed/);
 expect(screen.queryByRole("textbox",{name:"Merged translation"})).not.toBeInTheDocument();
 expect(invoke.mock.calls.filter(([c])=>c==="save_arena_merge")).toHaveLength(1);
 expect(invoke.mock.calls.find(([c])=>c==="read_translation_action")?.[1].request).toMatchObject({unitId:"unit",locale:"zh-CN",actionId:"action"});
});
it("reports a committed save separately from a failed projection refresh",async()=>{
 const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((c:string,a:unknown)=>c==="read_arena_comparison"?Promise.reject({code:"busy"}):original(c,a));
 await user.click(screen.getByRole("button",{name:"Save merge and select"}));
 await screen.findByText(/The action was saved, but the view could not refresh/);
 expect(screen.getByText(/Merge saved and selected/)).toBeInTheDocument();
 expect(screen.queryByRole("textbox",{name:"Merged translation"})).not.toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Retry same action"})).not.toBeInTheDocument();
 expect(invoke.mock.calls.filter(([c])=>c==="save_arena_merge")).toHaveLength(1);
});
it("reconciles an uncertain cancellation before allowing another action",async()=>{
 const user=await open();const original=invoke.getMockImplementation()!;let cancelled=false;
 invoke.mockImplementation(async(c:string,a:unknown)=>{
  if(c==="cancel_execution_task"){cancelled=true;throw {code:"outcome-unknown"};}
  const value=await original(c,a);
  if(c==="read_arena_translation")return {...value,detail:{...value.detail,
   progress:{...value.detail.progress,queued:cancelled?0:2},
   items:cancelled?[{status:{itemId:"i1",cancellationRequested:true}},{status:{itemId:"i2",cancellationRequested:true}}]:[],
  }};
  return value;
 });
 await user.click(screen.getByRole("checkbox",{name:/first: Hello/}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await user.click(await screen.findByRole("checkbox",{name:/I confirm sending the shown/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 await user.click(await screen.findByRole("button",{name:"Cancel remaining work"}));await screen.findByText(/The action may have committed/);
 expect(screen.getByRole("button",{name:"Back"})).toBeDisabled();
 await user.click(screen.getByRole("button",{name:"Check saved result"}));await screen.findByText(/The saved action has been confirmed/);
 expect(invoke.mock.calls.filter(([c])=>c==="cancel_execution_task")).toHaveLength(1);
 expect(invoke.mock.calls.find(([c])=>c==="cancel_execution_task")?.[1].request).toMatchObject({taskId:"task",requestId:"action"});
});
it("drops a late preview after the project session is replaced",async()=>{const user=userEvent.setup();const ref=createRef<AiHandle>();const rendered=render(<ArenaWorkbench key="old" ref={ref} project={project} disabled={false} onOpenTranslation={()=>true}/>);await user.click(screen.getByRole("button",{name:"Arena comparison"}));await user.click(await screen.findByRole("checkbox",{name:/first: Hello/}));let finish:(p:ArenaPrepared)=>void=()=>{};const original=invoke.getMockImplementation()!;invoke.mockImplementation((c:string,a:unknown)=>c==="preview_arena_translation"?new Promise<ArenaPrepared>(done=>{finish=done;}):original(c,a));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));rendered.rerender(<ArenaWorkbench key="new" ref={ref} project={{...project,sessionToken:"new"}} disabled={false} onOpenTranslation={()=>true}/>);finish(prepared);await user.click(screen.getByRole("button",{name:"Arena comparison"}));await waitFor(()=>expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument());});
