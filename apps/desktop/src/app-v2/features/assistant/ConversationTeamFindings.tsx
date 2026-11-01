import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import { useExecutionTaskSession } from "../../../ExecutionTaskSession";
import type { SessionRequest } from "../../../executionCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { reviewFindingsRead } from "../../../reviewQueries";
import type { TeamExecutionView } from "../../../workPlanCommands";
import { Banner } from "../../../design-system/Feedback";
import { Button } from "../../../design-system/Button";
import { Disclosure } from "../../../design-system/Disclosure";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { semanticReadCurrent, semanticReadProof, useSemanticAttempt } from "../review/SemanticRecoveryPanel";
import type { ConversationPlanLink } from "./conversationRun";
import { conversationTeamReviewRow, teamFindingTarget, type OpenConversationTeamFinding } from "./teamFindingReads";
import styles from "./ConversationTeamProgress.module.css";

type Work=TeamExecutionView["works"][number];
interface Props {
  context: SessionRequest; link: ConversationPlanLink; page: TeamExecutionView; work: Work;
  current: () => boolean; present: () => boolean;
  onOpenFinding?: OpenConversationTeamFinding; onPrepareFindingRepair?: OpenConversationTeamFinding;
}

/** Presentation borrows the semantic query, task action and original review owner. */
export function ConversationTeamFindings(props:Props) {
  const {t:team}=useTranslation(undefined,{keyPrefix:"conversationTeam"});
  const [open,setOpen]=useState(false),id=useId();
  const outcome=props.work.output?.outcome,report=outcome?.kind==="review"?outcome.report:null;
  if(!report) return null;
  return <section className={styles.finding} aria-label={team("findingReportTitle")}>
    <h6>{team("findingReportTitle")}</h6><p className={styles.text}><TokenizedText text={report.summary}/></p>
    <p>{team("findingReportCount",{count:report.rules.reduce((count,rule)=>count+rule.findings.length,0)})}</p>
    <Button size="sm" aria-expanded={open} aria-controls={id} disabled={!props.present()} onClick={()=>{if(props.present())setOpen(value=>!value);}}>{team(open?"hideFindingReport":"showFindingReport")}</Button>
    <div id={id}>{open?<FindingDetails {...props}/>:null}</div>
  </section>;
}

function FindingDetails({context,link,page,work,current,present,onOpenFinding,onPrepareFindingRepair}:Props) {
  const {t}=useTranslation(),{t:team}=useTranslation(undefined,{keyPrefix:"conversationTeam"}),reads=useSessionReads(),tasks=useExecutionTaskSession();
  const original=useSemanticAttempt(work.receipt.attemptId,present()),view=original.query.error?null:original.query.data;
  const row=conversationTeamReviewRow(view,work),run=row?.run;
  const findingOptions=reviewFindingsRead(context,work.target.unitId,work.target.locale);
  const findings=useSessionQuery({...findingOptions,enabled:present()&&!!run});
  const findingPage=findings.error?null:findings.data;
  const flight=useRef(false),mounted=useRef(true),live=useRef({current,present,onOpenFinding,onPrepareFindingRepair});
  const [busy,setBusy]=useState(false),[feedback,setFeedback]=useState<unknown>(null);
  useLayoutEffect(()=>{live.current={current,present,onOpenFinding,onPrepareFindingRepair};});
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  function active(){return mounted.current&&!reads.retired&&live.current.present();}
  function fresh(){return active()&&live.current.current()&&semanticReadCurrent(reads,original.key,view)&&!!row;}
  function currentFinding(){return fresh()&&!!run&&row?.current&&semanticReadCurrent(reads,findingOptions.key,findingPage)
    &&findingPage?.semanticRunId===run.runId&&findingPage.basis===run.basis;}
  const activity=tasks.activity?.intent.operation==="ai-team-work"&&tasks.activity.intent.attemptId===work.receipt.attemptId
    &&tasks.activity.intent.taskId===work.receipt.taskId&&tasks.activity.intent.action==="adopt-result"?tasks.activity:null;
  const unit=view?.detail.recovery.units.find(unit=>row&&unit.itemIds.length===1&&unit.itemIds[0]===row.itemId&&unit.resultIds.length===1
    &&unit.resultIds[0]===view.detail.items[0]?.resultId&&unit.actions.includes("adopt-result"));
  function captured(){return !!activity&&!!unit&&!!view&&!!row?.current&&!run&&JSON.stringify(unit)===JSON.stringify(activity.intent.unit)
    &&JSON.stringify(activity.intent.items)===JSON.stringify(view.detail.items);}
  async function perform(action:()=>Promise<unknown>|void) {
    if(!active()||flight.current)return;
    flight.current=true;setBusy(true);setFeedback(null);
    try{await action();}catch(error){if(active())setFeedback(error);}
    finally{flight.current=false;if(mounted.current)setBusy(false);}
  }
  async function begin(){
    if(!fresh()||!view||!row?.current||run||!unit||!tasks.canBegin(view.detail.taskId))return;
    await perform(()=>tasks.beginFromQuery(original.key,view.detail,unit,"adopt-result",0));
  }
  async function confirm(){
    if(!fresh()||activity?.phase!=="confirming"||!captured()||!tasks.canSubmit())return;
    const witness=semanticReadProof(reads,original.key,view),intent=activity.intent;
    try{await perform(()=>tasks.submit(()=>active()&&live.current.current()&&witness.current()&&tasks.currentActivity()?.intent===intent&&captured()));}
    finally{witness.dispose();}
  }
  async function navigate(issueId:string,repair:boolean){
    const callback=repair?onPrepareFindingRepair:onOpenFinding;
    if(!currentFinding()||!view||!callback||flight.current)return;
    const target=teamFindingTarget(link,page,work,view,issueId);if(!target)return;
    const witness=semanticReadProof(reads,original.key,view);
    const findingWitness=semanticReadProof(reads,findingOptions.key,findingPage);
    const proof=()=>active()&&live.current.current()&&witness.current()&&findingWitness.current()&&(repair?live.current.onPrepareFindingRepair:live.current.onOpenFinding)===callback;
    try{await perform(async()=>{if(!proof())return;if(!await callback(target,proof)&&proof())setFeedback(new Error("Original finding is no longer current"));});}
    finally{witness.dispose();findingWitness.dispose();}
  }
  return <div className={styles.body}>
    <p className={styles.meta}>{team("findingReportHelp")}</p>
    {original.query.isPending||original.query.isFetching?<p role="status">{t("semanticReview.reading")}</p>:null}
    {original.query.error?<Banner tone="warning" role="alert"><p>{t("semanticReview.readFailed")}</p><CommandFailureDetails failure={commandFailure(original.query.error)}/></Banner>:null}
    {!original.query.isPending&&!original.query.isFetching&&!original.query.error&&!row?<Banner tone="warning" role="status">{team("findingReportChanged")}</Banner>:null}
    <Button size="sm" disabled={!active()||busy||original.query.isFetching} onClick={()=>void perform(async()=>{await Promise.all([original.query.refetch(),...(run?[findings.refetch()]:[])]);})}>{t("semanticReview.refresh")}</Button>
    {row?<>
      <p>{row.current?team("findingReportCurrent"):t("semanticReview.staleResult")}</p>
      {run&&(findings.isFetching||findings.isPending)?<p role="status">{t("review.currentLoading")}</p>:null}
      {run&&!findings.isFetching&&!currentFinding()?<Banner tone="warning" role="status">{team("findingReportChanged")}</Banner>:null}
      <p>{view?.preview.config.model} · {view?.preview.recipe}</p>
      <Disclosure title={<>{t("review.advisoryFindings.basis")}</>}><dl>
        <dt>{t("review.source")}</dt><dd className={styles.text}><TokenizedText text={row.item.source.sourceText}/></dd>
        <dt>{t("review.translation")}</dt><dd className={styles.text}>{row.item.translationText===""?t("workbenchV2.editorEmptySelection"):<TokenizedText text={row.item.translationText}/>}</dd>
        <dt>{t("review.advisoryFindings.source")}</dt><dd><code>{row.item.source.sourceRevisionId}</code></dd>
        <dt>{team("findingReportRevision")}</dt><dd><code>{row.item.translationRevisionId}</code></dd>
        <dt>{team("diagnostics")}</dt><dd><pre>{JSON.stringify({memberId:work.receipt.memberId,roleVersionId:work.receipt.roleVersionId,
          taskId:work.receipt.taskId,attemptId:work.receipt.attemptId,itemId:row.itemId,resultId:view?.detail.items[0]?.resultId,runId:run?.runId??null},null,2)}</pre></dd>
      </dl></Disclosure>
      {row.output?.rules.map(rule=><section key={rule.rule}><h6>{t(`semanticReview.rule.${rule.rule}`)}</h6>
        {rule.findings.length?rule.findings.map((finding,index)=>{
          const saved=run?.rules.find(saved=>saved.rule===rule.rule)?.findings[index];
          return <article key={`${finding.code}:${index}`} className={styles.work}>
            <p className={styles.text}><TokenizedText text={finding.detail}/></p>
            {finding.suggestion?<p className={styles.text}><TokenizedText text={finding.suggestion}/></p>:null}
            {finding.location?<p>{t("review.diagnosticRange",{field:t(finding.location.field==="source"?"review.source":"review.translation"),encoding:finding.location.range.encoding,rangeStart:String(finding.location.range.start),rangeEnd:String(finding.location.range.end)})}</p>:null}
            <Disclosure title={<>{team("diagnostics")}</>}><pre>{JSON.stringify({issueId:saved?.issueId??null,code:finding.code,severity:finding.severity,location:finding.location},null,2)}</pre></Disclosure>
            {saved?<div className={styles.actions}>
              {onOpenFinding?<Button size="sm" disabled={!currentFinding()||busy} onClick={()=>void navigate(saved.issueId,false)}>{team("openFinding")}</Button>:null}
              {onPrepareFindingRepair?<Button size="sm" disabled={!currentFinding()||busy} onClick={()=>void navigate(saved.issueId,true)}>{team("prepareFindingRepair")}</Button>:null}
            </div>:null}
          </article>;
        }):<p>{t("semanticReview.noFindings")}</p>}
      </section>)}
      {run?<p role="status">{t("workbenchV2.entrySemanticRecorded")}</p>:<Button size="sm" disabled={!fresh()||!row.current||busy||!unit||!view||!tasks.canBegin(view.detail.taskId)} onClick={()=>void begin()}>{t("semanticReview.record")}</Button>}
    </>:null}
    {activity?<section aria-label={t("semanticReview.recordTitle")} className={styles.original}>
      <h6>{t("semanticReview.recordTitle")}</h6><p>{t("workbenchV2.entrySemanticRecordHelp")}</p>
      {activity.phase==="confirming"?<Button size="sm" variant="primary" disabled={!fresh()||busy||!captured()||!tasks.canSubmit()} onClick={()=>void confirm()}>{t("semanticReview.confirmRecord")}</Button>
        :activity.phase==="unknown"?<><Banner tone="warning" role="status">{t("semanticReview.recordUnknown")}</Banner>
          <div className={styles.actions}><Button size="sm" disabled={!active()||busy||tasks.busy||!activity.prepare} onClick={()=>void perform(()=>tasks.checkAdoption())}>{t("semanticReview.checkRecord")}</Button>
            {activity.retryAllowed?<Button size="sm" disabled={!active()||busy||tasks.busy||!activity.prepare} onClick={()=>void perform(()=>tasks.retryAdoption())}>{t("semanticReview.retryRecord")}</Button>:null}</div></>
          :activity.phase==="recorded"?<p role="status">{t("workbenchV2.entrySemanticRecorded")}</p>
            :activity.phase==="rejected"?<Banner tone="warning" role="alert"><CommandFailureDetails failure={activity.failure}/></Banner>:<p role="status">{t("semanticReview.recording")}</p>}
      {activity.phase!=="unknown"&&!tasks.busy?<Button size="sm" disabled={!active()||busy} onClick={()=>{if(active()&&!flight.current)tasks.dismiss();}}>{t("semanticReview.closeRecord")}</Button>:null}
    </section>:null}
    {feedback?<Banner tone="warning" role="alert"><p>{team("findingReportChanged")}</p><CommandFailureDetails failure={commandFailure(feedback)}/></Banner>:null}
  </div>;
}
