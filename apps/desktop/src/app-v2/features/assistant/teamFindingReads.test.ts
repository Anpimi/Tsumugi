import { afterEach, expect, it, vi } from "vitest";
import { aiSemanticReviewCommands, validAiSemanticReviewView } from "../../../aiSemanticReviewCommands";
import { conversationCommands } from "../../../conversationCommands";
import { reviewCommands } from "../../../reviewCommands";
import { workPlanCommands } from "../../../workPlanCommands";
import { teamReviewFixture } from "../../../testSupport/teamReviewFixture";
import { conversationTeamReviewRow, resolveConversationTeamFinding, teamFindingTarget } from "./teamFindingReads";

afterEach(()=>vi.restoreAllMocks());

it("correlates the typed report with the original work, selected revision and result without treating a verdict as findings",()=>{
  const h=teamReviewFixture();
  expect(validAiSemanticReviewView(h.view,h.work.receipt.attemptId)).toBe(true);
  expect(conversationTeamReviewRow(h.view,h.work)).toBe(h.row);
  expect(conversationTeamReviewRow(h.view,{...h.work,resultId:h.link.planId})).toBeNull();
  for(const change of [()=>{h.view.detail.taskId=h.link.planId;},()=>{h.view.preview.digest="f".repeat(64);},()=>{h.row.item.translationRevisionId=h.link.planId;},
    ()=>{h.row.output!.rules[0].findings[0].detail="Unrelated result";}]){
    const original=structuredClone(h.view);change();expect(conversationTeamReviewRow(h.view,h.work)).toBeNull();Object.assign(h.view,original);h.row=h.view.rows[0];
  }
  if(h.work.output?.outcome.kind==="review")delete h.work.output.outcome.report;
  expect(conversationTeamReviewRow(h.view,h.work)).toBeNull();
});

function reads(h:ReturnType<typeof teamReviewFixture>){
  vi.spyOn(conversationCommands,"readProposalWorkPlan").mockResolvedValue(h.link);
  vi.spyOn(workPlanCommands,"status").mockResolvedValue(h.status);
  vi.spyOn(workPlanCommands,"teamExecution").mockResolvedValue(h.page);
  vi.spyOn(aiSemanticReviewCommands,"read").mockResolvedValue({attemptId:h.work.receipt.attemptId,view:h.view});
  vi.spyOn(reviewCommands,"target").mockResolvedValue(h.target);
  return vi.spyOn(reviewCommands,"findings").mockResolvedValue(h.findings);
}

it("resolves only a real current finding through its original review owner and preserves the actual pagination offset",async()=>{
  const h=teamReviewFixture(),findings=reads(h),target=teamFindingTarget(h.link,h.page,h.work,h.view,h.run.rules[0].findings[0].issueId)!;
  findings.mockResolvedValueOnce({...h.findings,findings:Array.from({length:20},(_,index)=>({...h.findings.findings[0],runId:h.link.planId,finding:{...h.findings.findings[0].finding,issueId:String(index).padStart(64,"0")}})),nextOffset:20});
  const resolved=await resolveConversationTeamFinding(h.context,target);
  expect(resolved.suggestion).toBe("Preserve the original meaning.");expect(resolved.offset).toBe(20);expect(resolved.finding.finding.issueId).toBe(target.issueId);
  expect(findings).toHaveBeenLastCalledWith({...h.context,unitId:target.unitId,locale:target.locale,offset:20,limit:20});
});

it.each(["selection","work","current-run","currentness"])("rejects %s drift without writing or inventing a replacement finding",async change=>{
  const h=teamReviewFixture(),target=teamFindingTarget(h.link,h.page,h.work,h.view,h.run.rules[0].findings[0].issueId)!;reads(h);
  if(change==="selection")h.target.selectionId=h.link.planId;
  if(change==="work")h.work.receipt.inputDigest="e".repeat(64);
  if(change==="current-run")h.findings.semanticRunId=h.link.planId;
  if(change==="currentness")h.row.current=false;
  await expect(resolveConversationTeamFinding(h.context,target)).rejects.toThrow("Original team review evidence changed");
});
