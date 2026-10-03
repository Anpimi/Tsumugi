import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import {cleanup,screen,waitFor,within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {createRef} from "react";
import {ArenaWorkbench} from "./ArenaWorkbench";
import type {AiHandle} from "./AiWorkbench";
import type {ProjectView} from "./projectCommands";
import {defaultArenaConfig,type ArenaPrepared,type ComparisonView} from "./arenaCommands";
import {i18n} from "./i18n";
import {fixtureIdentity} from "./testSupport/executionFixture";
import {aiAttempt,aiTask,arenaViewFixture} from "./testSupport/aiFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
const invoke=vi.hoisted(()=>vi.fn());vi.mock("@tauri-apps/api/core",()=>({invoke}));
const project:ProjectView={sessionToken:"session",locator:"isolated",reconciliationState:"settled",metadata:{projectId:"project",displayName:"Arena test",sourceLocale:"en",targetLocales:["zh-CN","ja"],metadataRevision:"1"}};
const item={unitId:fixtureIdentity(301),sourceRevisionId:fixtureIdentity(302),sourceSnapshotId:fixtureIdentity(300),nativeKey:"first",sourceLocale:"en",sourceText:"Hello {name}",targetLocale:"zh-CN",terms:[],context:null,omissions:["terms-not-shared","context-not-shared"],resourceBaseline:"0"};
let prepared:ArenaPrepared,comparison:ComparisonView;
beforeEach(async()=>{await i18n.changeLanguage("en-US");prepared={attemptId:aiAttempt,preview:{config:defaultArenaConfig(),digest:"digest",items:[{slot:0,sourceOrder:0,item},{slot:1,sourceOrder:0,item}]}};
 comparison={comparisonId:fixtureIdentity(330),unitId:fixtureIdentity(301),locale:"zh-CN",sourceRevisionId:fixtureIdentity(302),sourceText:item.sourceText,nativeKey:"first",selectionId:fixtureIdentity(320),selectedRevisionId:fixtureIdentity(321),selectedText:"First {name}",basis:"basis",blind:true,revealed:false,rows:[{revisionId:fixtureIdentity(321),text:"First {name}",sourceRevisionId:fixtureIdentity(302),originKind:"ai",contributors:[],model:null,recipe:null,basisCurrent:true},{revisionId:fixtureIdentity(322),text:"Second {name}",sourceRevisionId:fixtureIdentity(302),originKind:"manual",contributors:[],model:null,recipe:null,basisCurrent:true}]};
 invoke.mockReset();invoke.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
  if(command==="read_content_scope")return{revision:"2",currentSnapshot:fixtureIdentity(300)};if(command==="read_source_content")return sourcePageFixture({snapshotId:fixtureIdentity(300),scope:{revision:"2",currentSnapshot:fixtureIdentity(300)},rows:[sourceRowFixture({unitId:fixtureIdentity(301),sourceRevisionId:fixtureIdentity(302)},{key:"first",text:item.sourceText})]});
  if(command==="list_arena_comparisons")return[];
  if(command==="preview_arena_translation"){prepared.preview.config=args.request.config as typeof prepared.preview.config;return prepared;}
  if(command==="start_arena_translation")return aiAttempt;
  if(command==="read_arena_translation")return arenaViewFixture(item);
  if(command==="read_translation_history")return{unitId:fixtureIdentity(301),locale:"zh-CN",total:"2",current:{eventId:fixtureIdentity(320),revisionId:fixtureIdentity(321),unitId:fixtureIdentity(301),locale:"zh-CN",sequence:"1",actionId:fixtureIdentity(324),previousEventId:null},currentText:"First {name}",rows:comparison.rows.map((r,i)=>({...r,unitId:fixtureIdentity(301),locale:"zh-CN",ordinal:String(i+1),sourceSnapshotId:fixtureIdentity(300),actionId:fixtureIdentity(324+i),attemptId:null,resultId:null,itemId:null,artifactId:null,logicalPath:null,declaredLocale:null,nativeKey:null,fileDigest:null})).map(({model:_model,recipe:_recipe,basisCurrent:_basis,...revision})=>revision),nextOrdinal:null};
  if(command==="create_arena_comparison"){comparison={...comparison,comparisonId:String(args.request.actionId),blind:Boolean(args.request.blind),rows:(args.request.revisionIds as string[]).map((id,i)=>({...comparison.rows[i],revisionId:id}))};return comparison;}if(command==="read_arena_comparison")return comparison;
  if(command==="create_execution_identity")return fixtureIdentity(1);
  if(command==="read_translation_action")return null;
  if(command==="save_arena_merge")return{eventId:fixtureIdentity(326),revisionId:fixtureIdentity(327),actionId:args.request.actionId,unitId:args.request.unitId,locale:args.request.locale,sequence:"2",previousEventId:args.request.expectedSelectionId};
  if(command==="select_translation_revision")return{eventId:fixtureIdentity(323),revisionId:args.request.revisionId,actionId:args.request.actionId,unitId:args.request.unitId,locale:args.request.locale,sequence:"2",previousEventId:args.request.expectedSelectionId};
  throw new Error(command);
 });
});afterEach(cleanup);
async function open(){const user=userEvent.setup();render(<ArenaWorkbench project={project} disabled={false} onOpenTranslation={()=>true}/>);await user.click(screen.getByRole("button",{name:"Arena comparison"}));await screen.findByRole("checkbox",{name:/first: Hello/});return user;}
async function compare(){const user=await open();await user.selectOptions(screen.getByRole("combobox",{name:"Original string"}),fixtureIdentity(301));await user.click(await screen.findByRole("checkbox",{name:/Revision 1/}));await user.click(screen.getByRole("checkbox",{name:/Revision 2/}));await user.click(screen.getAllByRole("checkbox",{name:"Hide candidate identities until revealed"})[1]);await user.click(screen.getByRole("button",{name:"Start comparison"}));await screen.findByRole("button",{name:"Edit a manual merge"});return user;}

it("keeps offline comparison independent of any generation or provider",async()=>{await compare();expect(invoke.mock.calls.some(([c])=>c.includes("arena_translation"))).toBe(false);expect(screen.getAllByText("First {name}").length).toBeGreaterThan(0);expect(screen.getByRole("button",{name:"Reveal candidate identities"})).toBeEnabled();});
it("loads current strings without opening every historical comparison",async()=>{
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((c:string,a:unknown)=>c==="list_arena_comparisons"?Promise.resolve([{comparisonId:fixtureIdentity(331),nativeKey:"removed original",locale:"zh-CN"}]):
  c==="read_arena_comparison"?Promise.reject({code:"dependency-conflict", outcome: "rejected",reason:"translation-source"}):original(c,a));
 const user=await open();expect(invoke.mock.calls.some(([c])=>c==="read_arena_comparison")).toBe(false);
 await user.click(screen.getByRole("button",{name:"Reopen comparison: removed original · zh-CN"}));await screen.findByRole("alert");
 expect(screen.getByRole("checkbox",{name:/first: Hello/})).toBeEnabled();
});
it("keeps selected revisions while loading another history page",async()=>{
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(c:string,a:{request:Record<string,unknown>})=>{
  const value=await original(c,a);
  if(c==="read_translation_history")return a.request.afterOrdinal==="50"?{...value,rows:[{...value.rows[1],revisionId:fixtureIdentity(351),ordinal:"51"}],nextOrdinal:null}:
   {...value,rows:[{...value.rows[0],ordinal:"1"}],nextOrdinal:"50"};
  return value;
 });
 const user=await open();await user.selectOptions(screen.getByRole("combobox",{name:"Original string"}),fixtureIdentity(301));
 await user.click(await screen.findByRole("checkbox",{name:/Revision 1/}));await user.click(screen.getByRole("button",{name:"Load more revisions"}));
 expect(await screen.findByRole("checkbox",{name:/Revision 1/})).toBeChecked();await user.click(screen.getByRole("checkbox",{name:/Revision 51/}));
 await user.click(screen.getByRole("button",{name:"Start comparison"}));await screen.findByRole("button",{name:"Edit a manual merge"});
 expect(invoke.mock.calls.find(([c])=>c==="create_arena_comparison")?.[1].request.revisionIds).toEqual([fixtureIdentity(321),fixtureIdentity(351)]);
});
it("keeps offline blind preference separate from a confirmed generation preview",async()=>{
 const user=await open();await user.click(screen.getByRole("checkbox",{name:/first: Hello/}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await user.click(await screen.findByRole("checkbox",{name:/I confirm sending the shown/}));
 await user.selectOptions(screen.getByRole("combobox",{name:"Original string"}),fixtureIdentity(301));await screen.findByRole("checkbox",{name:/Revision 1/});
 const controls=screen.getAllByRole("checkbox",{name:"Hide candidate identities until revealed"});await user.click(controls[1]);
 expect(controls[0]).not.toBeChecked();expect(prepared.preview.config.blind).toBe(false);
 expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeEnabled();
});
it("invalidates consent when the second scheme changes",async()=>{const user=await open();await user.click(screen.getByRole("checkbox",{name:/first: Hello/}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));await user.click(await screen.findByRole("checkbox",{name:/I confirm sending the shown/}));expect(screen.getByRole("button",{name:"Send and generate candidates"})).toBeEnabled();await user.type(screen.getByRole("textbox",{name:"Scheme 2 · Model"}),"different");expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument();expect(invoke.mock.calls.some(([c])=>c==="start_arena_translation")).toBe(false);});
it("preserves stable anonymous labels and does not infer a winner from returned order",async()=>{const user=await open();await user.click(screen.getByRole("checkbox",{name:/first: Hello/}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));await user.click(await screen.findByRole("checkbox",{name:/I confirm sending the shown/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));const a=await screen.findByRole("heading",{name:"Candidate A"});expect(within(a.closest("article")!).getByText("Second output")).toBeInTheDocument();expect(screen.queryByText("alpha-model")).not.toBeInTheDocument();expect(invoke.mock.calls.some(([c])=>c==="select_translation_revision"||c==="adopt_execution")).toBe(false);});

it("shows exact token totals beyond JavaScript and u64 aggregate limits",async()=>{
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(c:string,a:unknown)=>{
  const value=await original(c,a);
  if(c==="read_arena_translation")return {...value,rows:value.rows.map((row:typeof value.rows[number])=>({...row,output:{...row.output,usage:{promptTokens:"9007199254740993",completionTokens:"18446744073709551615"},usageIncomplete:false}}))};
  return value;
 });
 const user=await open();await user.click(screen.getByRole("checkbox",{name:/first: Hello/}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await user.click(await screen.findByRole("checkbox",{name:/I confirm sending the shown/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 expect(await screen.findByText(/18014398509481986.*36893488147419103230/)).toBeInTheDocument();
});
it("sends observed selection and all contributors in one merge request",async()=>{const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));await user.clear(screen.getByRole("textbox",{name:"Merged translation"}));await user.click(screen.getByRole("textbox",{name:"Merged translation"}));await user.paste("Combined {name}");await user.click(screen.getByRole("button",{name:"Save merge and select"}));await screen.findByText(/Merge saved and selected/);const request=invoke.mock.calls.find(([c])=>c==="save_arena_merge")![1].request;expect(request).toMatchObject({unitId:fixtureIdentity(301),locale:"zh-CN",sourceRevisionId:fixtureIdentity(302),expectedSelectionId:fixtureIdentity(320),text:"Combined {name}",merge:{contributors:[fixtureIdentity(321),fixtureIdentity(322)],expectedBasis:"basis"}});expect(invoke.mock.calls.some(([c])=>c==="save_translation_revision"||c==="select_translation_revision")).toBe(false);});
it("shows the actual selected merge outside the comparison candidates",async()=>{
 const user=await compare();const original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(c:string,a:unknown)=>{
  const value=await original(c,a);
  if(c==="save_arena_merge")comparison=Object.assign({...comparison,selectionId:fixtureIdentity(326),selectedRevisionId:fixtureIdentity(327)},{selectedText:"Combined {name}"});
  return value;
 });
 await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));
 await user.clear(screen.getByRole("textbox",{name:"Merged translation"}));await user.click(screen.getByRole("textbox",{name:"Merged translation"}));await user.paste("Combined {name}");
 await user.click(screen.getByRole("button",{name:"Save merge and select"}));await screen.findByText(/Merge saved and selected/);
 expect(screen.getByText("Current selection: Combined {name}")).toBeInTheDocument();
 expect(comparison.rows.some(r=>r.revisionId===comparison.selectedRevisionId)).toBe(false);
});
it.each([[null,null,"No translation is selected yet."],[fixtureIdentity(332),"",""],[fixtureIdentity(332),"External revision","External revision"]])("distinguishes current selection %s from the compared revisions",async(revisionId,text,shown)=>{
 comparison=Object.assign({...comparison,selectedRevisionId:revisionId},{selectedText:text});
 await compare();expect(screen.getByText(`Current selection:${shown?` ${shown}`:""}`)).toBeInTheDocument();
});
it("clears a transient poll failure after a successful terminal read",async()=>{
 const original=invoke.getMockImplementation()!;let reads=0;
 invoke.mockImplementation((c:string,a:unknown)=>c==="read_arena_translation"&&++reads===1?Promise.reject({code:"busy"}):original(c,a));
 const user=await open();await user.click(screen.getByRole("checkbox",{name:/first: Hello/}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await user.click(await screen.findByRole("checkbox",{name:/I confirm sending the shown/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 expect(await screen.findByRole("alert")).toHaveTextContent("Another operation is running");
 await refreshWorkbenchReads();
 await screen.findByRole("heading",{name:"Candidate A"},{timeout:3000});expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("preserves a cancellation failure when a background read succeeds",async()=>{
 const original=invoke.getMockImplementation()!;let reads=0;
 invoke.mockImplementation(async(c:string,a:unknown)=>{
  if(c==="cancel_execution_task")throw {code:"busy"};
  const value=await original(c,a);
  if(c==="read_arena_translation"){reads++;return {...value,detail:{...value.detail,progress:{...value.detail.progress,queued:1}}};}
  return value;
 });
 const user=await open();await user.click(screen.getByRole("checkbox",{name:/first: Hello/}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await user.click(await screen.findByRole("checkbox",{name:/I confirm sending the shown/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 await user.click(await screen.findByRole("button",{name:"Cancel remaining work"}));await screen.findByRole("alert");const prior=reads;
 await refreshWorkbenchReads();
 await waitFor(()=>expect(reads).toBeGreaterThan(prior),{timeout:3000});expect(screen.getByRole("alert")).toHaveTextContent("Another operation is running");
});
it("keeps newer input when a previous merge save returns successfully",async()=>{const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));let finish:(v:unknown)=>void=()=>{};const original=invoke.getMockImplementation()!;invoke.mockImplementation((c:string,a:unknown)=>c==="save_arena_merge"?new Promise(done=>{finish=done;}):original(c,a));await user.click(screen.getByRole("button",{name:"Save merge and select"}));const input=screen.getByRole("textbox",{name:"Merged translation"});expect(input).toBeEnabled();await user.type(input," plus newer edit");finish({eventId:fixtureIdentity(326),revisionId:fixtureIdentity(327),actionId:fixtureIdentity(1),unitId:item.unitId,locale:item.targetLocale,sequence:"2",previousEventId:fixtureIdentity(320)});await screen.findByText(/Merge saved and selected/);expect(input).toHaveValue("First {name} plus newer edit");await user.click(screen.getByRole("button",{name:"Back to overview"}));expect(await screen.findByText("Keep your Arena draft?")).toBeInTheDocument();});
it("preserves a merge draft on a relevant-basis conflict and allows explicit rebase",async()=>{const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));const original=invoke.getMockImplementation()!;invoke.mockImplementation((c:string,a:unknown)=>c==="save_arena_merge"?Promise.reject({code:"dependency-conflict", outcome: "rejected",stage:"execution-read",recoveryRequired:false,reason:"arena-basis"}):original(c,a));await user.click(screen.getByRole("button",{name:"Save merge and select"}));expect(await screen.findByRole("alert")).toHaveFocus();expect(screen.getByRole("textbox",{name:"Merged translation"})).toHaveValue("First {name}");comparison={...comparison,basis:"new-basis",selectionId:fixtureIdentity(323)};await user.click(screen.getByRole("button",{name:"Review current basis and keep draft"}));expect(screen.getByRole("textbox",{name:"Merged translation"})).toHaveValue("First {name}");});
it("checks an uncertain merge before repeating the exact action",async()=>{const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));const original=invoke.getMockImplementation()!;let first=true;invoke.mockImplementation((c:string,a:unknown)=>{if(c==="save_arena_merge"&&first){first=false;return Promise.reject({code:"outcome-unknown", outcome: "unknown",reason:"translation-commit"});}return original(c,a);});await user.click(screen.getByRole("button",{name:"Save merge and select"}));await screen.findByText(/The action may have committed/);expect(screen.getByRole("alert")).toHaveTextContent("The result is uncertain");expect(screen.queryByRole("button",{name:"Retry same action"})).not.toBeInTheDocument();expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();await user.click(screen.getByRole("button",{name:"Check saved result"}));await user.click(await screen.findByRole("button",{name:"Retry same action"}));await screen.findByText(/Merge saved and selected/);const saves=invoke.mock.calls.filter(([c])=>c==="save_arena_merge");expect(saves).toHaveLength(2);expect(saves[0][1]).toEqual(saves[1][1]);});

it("keeps newer merge input after an unrelated acknowledgement and the same-action retry",async()=>{
 const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));
 const original=invoke.getMockImplementation()!;let first=true;
 invoke.mockImplementation(async(c:string,a:unknown)=>{
  const value=await original(c,a);
  if(c==="save_arena_merge"&&first){first=false;return {...value,actionId:fixtureIdentity(499)};}
  return value;
 });
 await user.click(screen.getByRole("button",{name:"Save merge and select"}));await screen.findByText(/The action may have committed/);
 const identities=invoke.mock.calls.filter(([c])=>c==="create_execution_identity").length;
 const input=screen.getByRole("textbox",{name:"Merged translation"});await user.type(input," plus newer edit");
 expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();
 await user.click(screen.getByRole("button",{name:"Check saved result"}));await user.click(await screen.findByRole("button",{name:"Retry same action"}));
 await screen.findByText(/Merge saved and selected/);expect(input).toHaveValue("First {name} plus newer edit");
 const saves=invoke.mock.calls.filter(([c])=>c==="save_arena_merge");expect(saves).toHaveLength(2);expect(saves[0][1]).toEqual(saves[1][1]);
 expect(invoke.mock.calls.filter(([c])=>c==="create_execution_identity")).toHaveLength(identities);
});
it("reconciles a committed merge after a newer selection without resaving",async()=>{
 const user=await compare();await user.click(screen.getByRole("button",{name:"Edit a manual merge"}));
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((c:string,a:unknown)=>{
  if(c==="save_arena_merge")return Promise.reject({code:"outcome-unknown"});
  if(c==="read_translation_action")return Promise.resolve({eventId:fixtureIdentity(326),revisionId:fixtureIdentity(327),actionId:fixtureIdentity(1),unitId:fixtureIdentity(301),locale:"zh-CN",sequence:"2",previousEventId:fixtureIdentity(320)});
  return original(c,a);
 });
 await user.click(screen.getByRole("button",{name:"Save merge and select"}));await screen.findByText(/The action may have committed/);
 comparison={...comparison,selectionId:fixtureIdentity(333),selectedRevisionId:fixtureIdentity(322),selectedText:"Second {name}"};
 await user.click(screen.getByRole("button",{name:"Check saved result"}));await screen.findByText(/The saved action has been confirmed/);
 expect(screen.queryByRole("textbox",{name:"Merged translation"})).not.toBeInTheDocument();
 expect(invoke.mock.calls.filter(([c])=>c==="save_arena_merge")).toHaveLength(1);
 expect(invoke.mock.calls.find(([c])=>c==="read_translation_action")?.[1].request).toMatchObject({unitId:fixtureIdentity(301),locale:"zh-CN",actionId:fixtureIdentity(1)});
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
   items:value.detail.items.map((entry:typeof value.detail.items[number])=>({...entry,status:{...entry.status,cancellationRequested:cancelled}})),
  }};
  return value;
 });
 await user.click(screen.getByRole("checkbox",{name:/first: Hello/}));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));
 await user.click(await screen.findByRole("checkbox",{name:/I confirm sending the shown/}));await user.click(screen.getByRole("button",{name:"Send and generate candidates"}));
 await user.click(await screen.findByRole("button",{name:"Cancel remaining work"}));await screen.findByText(/The action may have committed/);
 expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();
 await user.click(screen.getByRole("button",{name:"Check saved result"}));await screen.findByText(/The saved action has been confirmed/);
 expect(invoke.mock.calls.filter(([c])=>c==="cancel_execution_task")).toHaveLength(1);
 expect(invoke.mock.calls.find(([c])=>c==="cancel_execution_task")?.[1].request).toMatchObject({taskId:aiTask,requestId:fixtureIdentity(1)});
});
it("drops a late preview after the project session is replaced",async()=>{const user=userEvent.setup();const ref=createRef<AiHandle>();const rendered=render(<ArenaWorkbench key="old" ref={ref} project={project} disabled={false} onOpenTranslation={()=>true}/>);await user.click(screen.getByRole("button",{name:"Arena comparison"}));await user.click(await screen.findByRole("checkbox",{name:/first: Hello/}));let finish:(p:ArenaPrepared)=>void=()=>{};const original=invoke.getMockImplementation()!;invoke.mockImplementation((c:string,a:unknown)=>c==="preview_arena_translation"?new Promise<ArenaPrepared>(done=>{finish=done;}):original(c,a));await user.click(screen.getByRole("button",{name:"Preview what will be sent"}));rendered.rerender(<ArenaWorkbench key="new" ref={ref} project={{...project,sessionToken:"new"}} disabled={false} onOpenTranslation={()=>true}/>);finish(prepared);await user.click(screen.getByRole("button",{name:"Arena comparison"}));await waitFor(()=>expect(screen.queryByRole("heading",{name:"Data sharing preview"})).not.toBeInTheDocument());});
