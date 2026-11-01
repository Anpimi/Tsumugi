import { semanticPreparedFixture, semanticTargetFixture, semanticViewFixture } from "./aiSemanticReviewFixture";
import { semanticDiagnosticFixture } from "./semanticDiagnosticFixture";
import { teamExecutionStatusFixture, teamExecutionViewFixture } from "./teamExecutionFixture";
import { fixtureIdentity as id } from "./executionFixture";
import { teamContext } from "./teamDiscussionFixture";
import { reviewFindingViewFixture } from "./reviewFixture";
import type { ConversationPlanLink } from "../app-v2/features/assistant/conversationRun";

export function teamReviewFixture(recorded = true) {
  const page=teamExecutionViewFixture(),status=teamExecutionStatusFixture(),work=page.works[0];
  const target=semanticTargetFixture({...work.target,nativeKey:status.plan.scope[0].nativeKey,sourceText:"A source with {name} 👩🏽‍💻",translationText:"原译文 {name} 👩🏽‍💻"});
  const prepared=semanticPreparedFixture(target);prepared.attemptId=work.receipt.attemptId;
  prepared.preview.recipe="team-review-1";prepared.preview.digest=work.receipt.inputDigest;
  const view=semanticViewFixture(prepared),row=view.rows[0],detail=view.detail;
  detail.operation="ai-team-work";detail.taskId=work.receipt.taskId;
  work.resultId=detail.items[0].resultId;
  detail.items[0].scope.kind="translation-unit";detail.recovery.units[0].scopes[0].kind="translation-unit";
  const diagnostic=semanticDiagnosticFixture(),finding={...diagnostic.finding,waivable:false},key=diagnostic.run.rules[0].key;
  row.output!.rules[0].findings=[{code:"meaning-concern",detail:finding.detail,severity:"warning",location:null,suggestion:"Preserve the original meaning."}];
  const origin={...diagnostic.run.evidence,recipe:"team-review-1",attemptId:detail.attemptId,itemId:row.itemId,
    resultId:detail.items[0].resultId!,inputDigest:work.receipt.inputDigest,model:prepared.preview.config.model,endpoint:prepared.preview.config.endpoint};
  const run={...diagnostic.run,unitId:target.unitId,locale:target.locale,basis:target.basis,basisEvidence:target.basisEvidence,
    evidence:origin,validatorVersion:"team-review-1",diagnostics:[],rules:[{key,rule:"meaning",mandatory:false,status:"findings",reason:null,findings:[finding]}]};
  row.run=recorded?run:null;
  const output=work.output!;
  if(output.outcome.kind!=="review")throw new Error("Review fixture required");
  output.outcome.reviewed={kind:"artifact",reference:{kind:"translation-revision",revisionId:target.revisionId!}};
  output.outcome.report={summary:"A real structured summary from this saved result.",rules:structuredClone(row.output!.rules)};
  if(recorded){detail.items[0].status.adoption="committed";detail.progress.adopted=1;detail.recovery.units[0].actions=["view-receipt"];detail.recovery.units[0].receiptId=run.actionId;}
  const findings={...reviewFindingViewFixture(target),semanticRunId:run.runId,findings:[{runId:run.runId,purpose:"ai-semantic" as const,aiOrigin:origin,finding,
    requirement:{...diagnostic.requirement,targets:[target.unitId],key,inputDigest:origin.semanticInputDigest,scopeDigest:origin.scopeDigest},decision:null}]};
  const link:ConversationPlanLink={projectId:teamContext.projectId,conversationId:id(9320),proposalId:id(9321),revisionId:id(9322),ordinal:"1",
    planId:page.planId,planDigest:status.plan.digest,actionId:page.effectiveVersion.actionId};
  return {context:{...teamContext},status,page,work,target,view,row,run,findings,link};
}
