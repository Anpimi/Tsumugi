import { aiSemanticReviewCommands, type AiSemanticReviewView } from "../../../aiSemanticReviewCommands";
import { conversationCommands } from "../../../conversationCommands";
import type { SessionRequest } from "../../../executionCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import { reviewCommands, sameAiOrigin, type AdvisoryFinding, type ReviewTarget } from "../../../reviewCommands";
import { sameReviewBasis } from "../../../reviewDiagnosticNavigation";
import { workPlanCommands, type TeamExecutionView, type WorkPlanStatusView } from "../../../workPlanCommands";
import { readConversationTeamExecution } from "./conversationTeamReads";
import type { ConversationPlanLink } from "./conversationRun";

type Work = TeamExecutionView["works"][number];
export interface TeamRunFindingTarget {
  projectId: string; conversationId: string; planId: string;
  unitId: string; locale: string; sourceSnapshotId: string; sourceRevisionId: string;
  attemptId: string; itemId: string; resultId: string; runId: string; issueId: string; basis: string; offset: number;
  link: ConversationPlanLink; effectiveVersion: TeamExecutionView["effectiveVersion"]; work: Work;
}
export type OpenConversationTeamFinding = (target: TeamRunFindingTarget, current: () => boolean) => Promise<boolean>;

function match(condition: unknown): asserts condition { if (!condition) throw new Error("Original team review evidence changed"); }

/** Correlate the original fixed work and result; a verdict or post is never a report. */
export function conversationTeamReviewRow(view: AiSemanticReviewView | null | undefined, work: Work) {
  const outcome = work.output?.outcome;
  if (!view || work.execution !== "succeeded" || work.validation !== "valid" || outcome?.kind !== "review" || !outcome.report
    || outcome.reviewed.kind !== "artifact" || outcome.reviewed.reference.kind !== "translation-revision"
    || view.detail.operation !== "ai-team-work" || view.preview.recipe !== "team-review-1"
    || view.detail.taskId !== work.receipt.taskId || view.detail.attemptId !== work.receipt.attemptId
    || view.preview.digest !== work.receipt.inputDigest || view.rows.length !== 1 || view.detail.items.length !== 1) return null;
  const row = view.rows[0], item = view.detail.items[0];
  return row.output && item.status.execution === "succeeded" && item.status.validation === "valid" && item.resultId && work.resultId===item.resultId
    && item.status.itemId === row.itemId && row.item.source.unitId === work.target.unitId && row.item.source.targetLocale === work.target.locale
    && row.item.source.sourceSnapshotId === work.target.sourceSnapshotId && row.item.source.sourceRevisionId === work.target.sourceRevisionId
    && row.item.translationRevisionId === outcome.reviewed.reference.revisionId && jsonIdentity(row.output.rules) === jsonIdentity(outcome.report.rules)
    && (!row.run || row.run.evidence.attemptId === work.receipt.attemptId && row.run.evidence.itemId === row.itemId && row.run.evidence.resultId === item.resultId)
    ? row : null;
}

export function teamFindingTarget(link: ConversationPlanLink, page: TeamExecutionView, work: Work,
  view: AiSemanticReviewView, issueId: string): TeamRunFindingTarget | null {
  const row = conversationTeamReviewRow(view, work), run = row?.run, item = view.detail.items[0];
  if (!row?.current || !run || !page.works.includes(work) || !item?.resultId || !run.rules.some(rule => rule.findings.some(finding => finding.issueId === issueId))) return null;
  return structuredClone({projectId:link.projectId,conversationId:link.conversationId,planId:link.planId,
    unitId:work.target.unitId,locale:work.target.locale,sourceSnapshotId:work.target.sourceSnapshotId,sourceRevisionId:work.target.sourceRevisionId,
    attemptId:work.receipt.attemptId,itemId:row.itemId,resultId:item.resultId,runId:run.runId,issueId,basis:run.basis,offset:0,
    link,effectiveVersion:page.effectiveVersion,work});
}

/** Pure original-owner reads. A missing current run never clears a pending action. */
export async function resolveConversationTeamFinding(context: SessionRequest, input: TeamRunFindingTarget): Promise<{
  target: ReviewTarget; finding: AdvisoryFinding; offset: number; suggestion: string | null;
}> {
  const captured=structuredClone(input);
  match(context.projectId === captured.projectId && captured.link.projectId === captured.projectId
    && captured.link.conversationId === captured.conversationId && captured.link.planId === captured.planId);
  const link=await conversationCommands.readProposalWorkPlan({...context,conversationId:captured.conversationId,planId:captured.planId});
  match(jsonIdentity(link)===jsonIdentity(captured.link));
  const status:WorkPlanStatusView=await workPlanCommands.status({...context,planId:captured.planId});
  const after=BigInt(captured.work.sequence)>1n?(BigInt(captured.work.sequence)-1n).toString():null;
  const page=await readConversationTeamExecution(context,link,status,after,null);
  const work=page.works.find(value=>value.sequence===captured.work.sequence);
  match(work && jsonIdentity(work)===jsonIdentity(captured.work) && jsonIdentity(page.effectiveVersion)===jsonIdentity(captured.effectiveVersion));
  const [read,target]=await Promise.all([
    aiSemanticReviewCommands.read({...context,attemptId:captured.attemptId}),
    reviewCommands.target({...context,unitId:captured.unitId,locale:captured.locale}),
  ]);
  const row=conversationTeamReviewRow(read.view,work),run=row?.run;
  match(row?.current && run && run.runId===captured.runId && row.itemId===captured.itemId && run.evidence.resultId===captured.resultId
    && target.unitId===captured.unitId && target.locale===captured.locale && target.sourceSnapshotId===captured.sourceSnapshotId
    && target.sourceRevisionId===captured.sourceRevisionId && target.basis===captured.basis && target.basis===run.basis
    && target.selectionId===row.item.selectionId && target.revisionId===row.item.translationRevisionId
    && sameReviewBasis(target.basisEvidence,run.basisEvidence) && target.sourceText===row.item.source.sourceText && target.translationText===row.item.translationText);
  // Current findings share pagination with advisory QA evidence. Find the real
  // owner offset rather than assuming a team report begins on its first page.
  let offset=0;
  for (;;) {
    const findings=await reviewCommands.findings({...context,unitId:captured.unitId,locale:captured.locale,offset,limit:20});
    match(findings.basis===target.basis && findings.semanticRunId===run.runId);
    const finding=findings.findings.find(value=>value.runId===run.runId && value.finding.issueId===captured.issueId
      && value.purpose==="ai-semantic" && sameAiOrigin(value.aiOrigin,run.evidence));
    if(finding) {
      const rule=run.rules.find(rule=>rule.findings.some(value=>value.issueId===captured.issueId));
      const index=rule?.findings.findIndex(value=>value.issueId===captured.issueId) ?? -1;
      const original=row.output?.rules.find(value=>value.rule===rule?.rule)?.findings[index];
      match(rule && original && jsonIdentity(rule.findings[index])===jsonIdentity(finding.finding)
        && original.detail===finding.finding.detail && original.severity===finding.finding.severity);
      return {target,finding,offset,suggestion:original.suggestion};
    }
    match(findings.nextOffset!==null && findings.nextOffset>offset && findings.findings.length===20);
    offset=findings.nextOffset;
  }
}
