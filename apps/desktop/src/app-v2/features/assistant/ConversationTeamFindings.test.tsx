import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { aiSemanticReviewCommands } from "../../../aiSemanticReviewCommands";
import { executionCommands, type AdoptionAction, type PrepareRequest, type Receipt } from "../../../executionCommands";
import { ExecutionTaskProvider, useExecutionTaskSession } from "../../../ExecutionTaskSession";
import { i18n } from "../../../i18n";
import type { ProjectView } from "../../../projectCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { teamReviewFixture } from "../../../testSupport/teamReviewFixture";
import execution from "../../../../test/fixtures/executionCommands.contract.json";
import { ConversationTeamFindings } from "./ConversationTeamFindings";
import { reviewCommands } from "../../../reviewCommands";
import type { OpenConversationTeamFinding } from "./teamFindingReads";

const invoke=vi.hoisted(()=>vi.fn());
vi.mock("@tauri-apps/api/core",()=>({invoke}));
const disposals:(()=>void)[]=[];
beforeEach(async()=>{await i18n.changeLanguage("en-US");invoke.mockReset();invoke.mockRejectedValue(new Error("Unexpected native command"));});
afterEach(()=>{cleanup();disposals.splice(0).forEach(dispose=>dispose());vi.restoreAllMocks();expect(invoke).not.toHaveBeenCalled();});
const label=(key:"showFindingReport"|"openFinding"|"prepareFindingRepair")=>i18n.t(`conversationTeam.${key}`);

function harness(recorded=true){
  const h=teamReviewFixture(recorded),reads=new SessionReads(h.context);
  vi.spyOn(aiSemanticReviewCommands,"read").mockImplementation(async()=>({attemptId:h.work.receipt.attemptId,view:structuredClone(h.view)}));
  vi.spyOn(reviewCommands,"findings").mockImplementation(async()=>structuredClone(h.findings));
  const project:ProjectView={sessionToken:h.context.sessionToken,locator:"/synthetic/team-findings",reconciliationState:"settled",
    metadata:{projectId:h.context.projectId,displayName:"Synthetic review",metadataRevision:"1",sourceLocale:"en",targetLocales:[h.work.target.locale]}};
  let taskOwner:ReturnType<typeof useExecutionTaskSession>|null=null,visible=true,current=true,reserved=false;
  const open=vi.fn<OpenConversationTeamFinding>(async()=>true),repair=vi.fn<OpenConversationTeamFinding>(async()=>true);
  function Probe(){const value=useExecutionTaskSession();useLayoutEffect(()=>{taskOwner=value;});return null;}
  const mutations={reserveMutation:()=>{if(reserved)return null;reserved=true;return Symbol();},releaseMutation:()=>{reserved=false;}};
  const tree=()=> <SessionReadProvider context={h.context} reads={reads} bridge={false}><ExecutionTaskProvider project={project} mutations={mutations}><Probe/>
    <label>Other draft<input aria-label="Other draft" defaultValue="Newer B"/></label>
    {visible?<ConversationTeamFindings context={h.context} link={h.link} page={h.page} work={h.work} present={()=>true} current={()=>current} onOpenFinding={open} onPrepareFindingRepair={repair}/>:null}
  </ExecutionTaskProvider></SessionReadProvider>;
  const ui=render(tree());disposals.push(()=>{ui.unmount();reads.retire();});
  return {...h,reads,open,repair,owner:()=>{if(!taskOwner)throw new Error("Missing original task owner");return taskOwner;},reserved:()=>reserved,
    show:(value:boolean)=>{visible=value;ui.rerender(tree());},stale:()=>{current=false;ui.rerender(tree());}};
}
async function expand(){fireEvent.click(screen.getByRole("button",{name:label("showFindingReport")}));await screen.findByText("Synthetic model diagnostic");}
function adoption(){
  vi.spyOn(executionCommands,"identity").mockResolvedValue(id(9801));let captured:PrepareRequest|null=null,action:AdoptionAction|null=null;
  const prepare=vi.spyOn(executionCommands,"prepare").mockImplementation(async request=>{captured=request;return action={...execution.action,
    projectId:request.projectId,actionId:request.actionId,attemptId:request.attemptId,unitId:request.unitId,resultIds:request.resultIds,operation:"ai-team-work",parameters:null};});
  const receipt=():Receipt=>{if(!captured)throw new Error("Missing original request");return {...execution.receipt,projectId:captured.projectId,actionId:captured.actionId,
    attemptId:captured.attemptId,unitId:captured.unitId,changes:[{kind:"review",id:id(9802),revision:"1"}]};};
  const adopt=vi.spyOn(executionCommands,"adopt").mockImplementation(async()=>receipt());
  const lookup=vi.spyOn(executionCommands,"adoptionAction").mockImplementation(async()=>{if(!action)throw new Error("Missing original action");return {action,receipt:receipt()};});
  return {prepare,adopt,lookup,request:()=>captured};
}

it("reads details only after expansion, shows the original summary and evidence, and routes typed finding and repair actions",async()=>{
  const h=harness();expect(aiSemanticReviewCommands.read).not.toHaveBeenCalled();
  expect(screen.getByText("A real structured summary from this saved result.")).toBeVisible();await expand();
  fireEvent.click(screen.getByText(i18n.t("review.advisoryFindings.basis")));
  expect(screen.getAllByRole("definition")[0]).toHaveTextContent(h.target.sourceText);expect(screen.getAllByRole("definition")[1]).toHaveTextContent(h.target.translationText!);
  const locate=screen.getByRole("button",{name:label("openFinding")});await waitFor(()=>expect(locate).toBeEnabled());fireEvent.click(locate);await waitFor(()=>expect(h.open).toHaveBeenCalledOnce());
  expect(h.open.mock.calls[0][0]).toMatchObject({runId:h.run.runId,issueId:h.run.rules[0].findings[0].issueId,resultId:h.run.evidence.resultId});
  fireEvent.click(screen.getByRole("button",{name:label("prepareFindingRepair")}));await waitFor(()=>expect(h.repair).toHaveBeenCalledOnce());
  expect(screen.getByRole("textbox",{name:"Other draft"})).toHaveValue("Newer B");expect(h.owner().currentActivity()).toBeNull();
});

it("keeps stale or failed original evidence read only and permits a focused refresh",async()=>{
  const h=harness();vi.mocked(aiSemanticReviewCommands.read).mockRejectedValueOnce(new Error("Unavailable original evidence"));
  fireEvent.click(screen.getByRole("button",{name:label("showFindingReport")}));await screen.findByText(i18n.t("semanticReview.readFailed"));
  expect(screen.queryByRole("button",{name:label("openFinding")})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:i18n.t("semanticReview.refresh")}));await screen.findByText("Synthetic model diagnostic");
  act(()=>h.stale());expect(screen.getByRole("button",{name:label("openFinding")})).toBeDisabled();
});

it("captures an explicit adoption with the original task owner, retains unknown across reopening, and checks only that request",async()=>{
  const h=harness(false),mocks=adoption();mocks.adopt.mockRejectedValueOnce(new Error("Lost receipt"));mocks.lookup.mockRejectedValueOnce(new Error("Read unavailable"));
  await expand();fireEvent.click(screen.getByRole("button",{name:i18n.t("semanticReview.record")}));
  const confirm=await screen.findByRole("button",{name:i18n.t("semanticReview.confirmRecord")});await waitFor(()=>expect(confirm).toBeEnabled());
  fireEvent.click(confirm);fireEvent.click(confirm);await waitFor(()=>expect(h.owner().currentActivity()?.phase).toBe("unknown"));
  expect(mocks.adopt).toHaveBeenCalledOnce();const request=structuredClone(mocks.request());expect(h.reserved()).toBe(true);
  fireEvent.change(screen.getByRole("textbox",{name:"Other draft"}),{target:{value:"Newer B remains"}});
  act(()=>h.show(false));act(()=>h.show(true));await expand();
  fireEvent.click(screen.getByRole("button",{name:i18n.t("semanticReview.checkRecord")}));
  await waitFor(()=>expect(h.owner().currentActivity()?.phase).toBe("recorded"));
  expect(mocks.request()).toEqual(request);expect(mocks.prepare).toHaveBeenCalledOnce();expect(mocks.adopt).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox",{name:"Other draft"})).toHaveValue("Newer B remains");expect(h.reserved()).toBe(false);
});

it("rejects an ABA query replacement while allocating adoption identity",async()=>{
  const h=harness(false),mocks=adoption();let resolve!:(id:string)=>void;
  vi.mocked(executionCommands.identity).mockReturnValueOnce(new Promise<string>(yes=>{resolve=yes;}));
  await expand();fireEvent.click(screen.getByRole("button",{name:i18n.t("semanticReview.record")}));
  const confirm=await screen.findByRole("button",{name:i18n.t("semanticReview.confirmRecord")});await waitFor(()=>expect(confirm).toBeEnabled());
  fireEvent.click(confirm);await waitFor(()=>expect(executionCommands.identity).toHaveBeenCalledOnce());
  act(()=>{const key=h.reads.key(["ai-semantic-review",h.work.receipt.attemptId]);h.reads.client.setQueryData(key,h.reads.client.getQueryData(key));});
  await act(async()=>resolve(id(9801)));await waitFor(()=>expect(h.owner().currentActivity()?.phase).toBe("rejected"));
  expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.adopt).not.toHaveBeenCalled();
});
