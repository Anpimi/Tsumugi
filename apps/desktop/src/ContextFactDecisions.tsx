import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useResourceDraftSession, validContextFactDraft, isContextFactCasRejection } from "./ResourceDraftSession";
import { resourceCommands, type ContextFactDecision, type SourceFactBasis, type ContextFactDisposition } from "./resourceCommands";
import { type SourceContextPage, type ContentScope } from "./sourceCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { sourceReads } from "./sourceQueries";
import { type SessionRequest } from "./executionCommands";
import { CommandFailureDetails } from "./CommandFailure";
import { useWorkbenchCommands, type ResourceFactCommandPayload, type CommandAvailability } from "./workbenchCommands";
import { useWorkspaceView } from "./WorkbenchFrame";

const factKey=(scope:SourceFactBasis["scope"],facts:{blockIndex:number;factIndex:number}[])=>["context-fact-decisions",scope,facts];

/** Editable intent stays in the original resource draft owner across consumers. */
export function ContextFactDecisionFields(props: { context:SessionRequest; disabled?:boolean }) {
  const {t}=useTranslation(),owner=useResourceDraftSession();
  if (!owner.state.factDraft) return owner.state.factRecorded
    ? <p role="status">{t("contextFacts.saved",{key:owner.state.factRecorded.key,locale:owner.state.factRecorded.decision.request.basis.scope.locale})}</p> : null;
  return <ActiveContextFactDecisionFields {...props}/>;
}

// An absent draft must not disable/invalidate another consumer's source query.
function ActiveContextFactDecisionFields({ context, disabled=false }: { context:SessionRequest; disabled?:boolean }) {
  const {t}=useTranslation(),owner=useResourceDraftSession(),reads=useSessionReads(),registry=useWorkbenchCommands(),view=useWorkspaceView();
  const state=owner.state,draft=state.factDraft,pending=state.factPending;
  const facts=draft?[{blockIndex:draft.basis.fact.blockIndex,factIndex:draft.basis.fact.factIndex}]:[];
  const sourceOptions=sourceReads.scope(context);
  const source=useSessionQuery({...sourceOptions,enabled:true});
  const decisions=useSessionQuery({key:draft?factKey(draft.basis.scope,facts):["context-fact-decisions",null],scopes:["source","resources"],enabled:true,
    read:()=>{if(!draft)throw new Error("No context fact draft");return resourceCommands.factDecisions({...context,scope:draft.basis.scope,facts});}});
  function current(){
    if(!draft || owner.current().factDraft!==draft || !owner.localeAvailable(draft.basis.scope.locale) || reads.retired)return false;
    const source=reads.client.getQueryState<ContentScope>(reads.key(sourceOptions.key));
    const decisions=reads.client.getQueryState<ContextFactDecision[]>(reads.key(factKey(draft.basis.scope,facts)));
    return source?.status==="success" && source.fetchStatus==="idle" && !source.isInvalidated && source.error===null && source.data?.currentSnapshot===draft.basis.scope.sourceSnapshotId
      && decisions?.status==="success" && decisions.fetchStatus==="idle" && !decisions.isInvalidated && decisions.error===null
      && (decisions.data?.find(v=>v.request.basis.fact.blockIndex===draft.basis.fact.blockIndex && v.request.basis.fact.fact.id===draft.basis.fact.fact.id)?.request.actionId??null)===draft.expectedDecisionId;
  }
  function payload():ResourceFactCommandPayload|undefined {const value=owner.current().factDraft;return value?{kind:"resource-fact",unitId:value.basis.scope.unitId,locale:value.basis.scope.locale,sourceRevisionId:value.basis.scope.sourceRevisionId,sourceSnapshotId:value.basis.scope.sourceSnapshotId,blockIndex:value.basis.fact.blockIndex,factId:value.basis.fact.fact.id,expectedDecisionId:value.expectedDecisionId,editSeq:value.editSeq}:undefined;}
  function availability(input:ResourceFactCommandPayload|undefined,action:"save"|"check"|"retry"|"discard"):CommandAvailability {
    if(disabled||reads.retired||state.busyMutation||!input||JSON.stringify(input)!==JSON.stringify(payload()))return{enabled:false,reason:"unavailable"};
    if(action==="check"||action==="retry")return{enabled:!!pending&&(action==="check"||state.factCheckedMissing)};
    if(action==="discard")return{enabled:!pending};
    return{enabled:!pending&&!state.pending&&current()&&!!draft&&validContextFactDraft(draft)};
  }
  const scope={...context,area:view.area};
  useLayoutEffect(()=>{
    if(!draft)return;
    const meta={category:"resources" as const,scope,binding:null,risk:"writes-resources" as const,confirmation:"none" as const,payloadKind:"resource-fact" as const};
    const removals=[
      registry.register({...meta,id:"resource.save-fact",nameKey:"contextFacts.save",availability:p=>availability(p,"save"),handler:()=>{void owner.saveFact(current);}}),
      registry.register({...meta,id:"resource.check-fact",nameKey:"contextFacts.check",availability:p=>availability(p,"check"),handler:()=>{void owner.checkFact();}}),
      registry.register({...meta,id:"resource.retry-fact",nameKey:"contextFacts.retry",availability:p=>availability(p,"retry"),handler:()=>{void owner.retryFact();}}),
      registry.register({...meta,id:"resource.discard-fact",nameKey:"contextFacts.discard",availability:p=>availability(p,"discard"),handler:()=>{owner.discardFact();}}),
    ];return()=>removals.forEach(remove=>remove());
  });
  if(!draft)return state.factRecorded?<p role="status">{t("contextFacts.saved",{key:state.factRecorded.key,locale:state.factRecorded.decision.request.basis.scope.locale})}</p>:null;
  const command=(action:"save"|"check"|"retry"|"discard")=>{const value=payload();if(value)registry.dispatch(`resource.${action}-fact`,scope,value);};
  return <section aria-label={t("contextFacts.editor")}>
    <h5>{t("contextFacts.editor")}</h5><p>{t("contextFacts.scope",{key:draft.key,locale:draft.basis.scope.locale})}</p>
    <p>{t(`sourceContext.factKinds.${draft.basis.fact.fact.kind}`)} · {t(`sourceContext.origins.${draft.basis.fact.fact.origin.kind}`)}</p><pre>{draft.basis.fact.fact.text}</pre>
    <p>{t(`contextFacts.operation.${draft.disposition.kind}`)}</p><p>{t("contextFacts.fieldLimits")}</p>
    {draft.disposition.kind==="replace"?<label>{t("contextFacts.value")}<textarea value={draft.disposition.text} onChange={e=>owner.editFact({disposition:{kind:"replace",text:e.target.value}})}/></label>:null}
    <label>{t("contextFacts.actor")}<input value={draft.actor} onChange={e=>owner.editFact({actor:e.target.value})}/></label>
    <label>{t("contextFacts.reason")}<textarea value={draft.reason} onChange={e=>owner.editFact({reason:e.target.value})}/></label>
    {!pending&&!current()?<p role="status">{t("contextFacts.changed")} <button onClick={()=>{void source.refetch();void decisions.refetch();}}>{t("resource.refresh")}</button></p>:null}
    {state.factRecorded?<p role="status">{t("resource.savedNewer")}</p>:null}
    {pending?<p role="alert">{t("contextFacts.unknown")}</p>:null}
    {state.factFailure?<div role="alert"><p>{t(!pending&&isContextFactCasRejection(state.factFailure)?"contextFacts.notSubmitted":"contextFacts.failed")}</p><CommandFailureDetails failure={state.factFailure}/>{!pending?<button onClick={()=>{void source.refetch();void decisions.refetch();}}>{t("resource.refresh")}</button>:null}</div>:null}
    <button disabled={!availability(payload(),"save").enabled} onClick={()=>command("save")}>{t("contextFacts.save")}</button>
    <button disabled={!availability(payload(),"discard").enabled} onClick={()=>command("discard")}>{t("contextFacts.discard")}</button>
    {pending?<><button disabled={!availability(payload(),"check").enabled} onClick={()=>command("check")}>{t("contextFacts.check")}</button>
      {state.factCheckedMissing?<button disabled={!availability(payload(),"retry").enabled} onClick={()=>command("retry")}>{t("contextFacts.retry")}</button>:null}</>:null}
  </section>;
}

/** Raw observations remain visible; this separate projection describes only project decisions. */
export function ContextFactReferences({ context,pages,entryKey }: {context:SessionRequest;pages:SourceContextPage[];entryKey:string}) {
  const {t}=useTranslation(),owner=useResourceDraftSession(),reads=useSessionReads(),scope=pages[0].scope;
  const [blocked,setBlocked]=useState(false),[offset,setOffset]=useState(0),[pageIndex,setPageIndex]=useState(0);
  const page=pages[Math.min(pageIndex,pages.length-1)];
  const facts=page.entries.flatMap(entry=>entry.kind==="block"&&entry.value.facts?entry.value.facts.facts.map((_,factIndex)=>({blockIndex:entry.value.blockIndex,factIndex})):[]);
  const decisions=useSessionQuery({key:factKey(scope,facts),scopes:["source","resources"],enabled:true,read:()=>resourceCommands.factDecisions({...context,scope,facts})});
  const history=useSessionQuery({key:["context-fact-history",scope.unitId,scope.locale,offset],scopes:["resources"],enabled:true,read:()=>resourceCommands.factHistory({...context,unitId:scope.unitId,locale:scope.locale,offset,limit:10})});
  const state=reads.client.getQueryState(reads.key(factKey(scope,facts)));
  const ready=decisions.isSuccess&&!decisions.isFetching&&!decisions.error&&!state?.isInvalidated;
  function begin(basis:SourceFactBasis,value:ContextFactDecision|null,disposition:ContextFactDisposition){
    const checked=reads.client.getQueryState(reads.key(factKey(scope,facts)));
    if(!ready || checked?.status!=="success" || checked.fetchStatus!=="idle" || checked.isInvalidated || checked.data!==decisions.data){setBlocked(true);return;}
    setBlocked(!owner.beginFact(basis,entryKey,value,disposition));
  }
  return <section aria-label={t("contextFacts.title")}><h5>{t("contextFacts.title")}</h5><p>{t("contextFacts.help")}</p>
    {!ready?<p role={decisions.error?"alert":"status"}>{t(decisions.error?"contextFacts.readFailed":"resource.loading")}<button onClick={()=>{void decisions.refetch();}}>{t("resource.refresh")}</button></p>:null}
    {blocked?<p role="alert">{t("contextFacts.draftBlocked")}</p>:null}
    <p>{t("contextFacts.decisionsPage",{page:String(Math.min(pageIndex+1,pages.length)),total:String(pages.length)})}</p>
    {page.entries.flatMap(entry=>entry.kind==="block"&&entry.value.facts?entry.value.facts.facts.map((fact,factIndex)=>{
      const block=entry.value,basis:SourceFactBasis={scope,sourceResultId:page.sourceResultId,sourceResultDigest:page.sourceResultDigest,
        fact:{blockIndex:block.blockIndex,factIndex,target:block.target,schema:block.schema,handling:block.handling,inRevisionBasis:block.inRevisionBasis,fact}};
      const current=decisions.data?.find(v=>v.request.basis.fact.blockIndex===block.blockIndex&&v.request.basis.fact.fact.id===fact.id)??null;
      return <article key={`${block.blockIndex}:${fact.id}`}><p>{t(`sourceContext.factKinds.${fact.kind}`)} · {fact.text}</p>
        {ready&&current?<p>{t(`contextFacts.operation.${current.request.disposition.kind}`)} · {current.request.disposition.kind==="replace"?current.request.disposition.text:""} · {current.request.actor}: {current.request.reason}</p>:null}
        <button disabled={!ready||owner.factBlocked()} onClick={()=>begin(basis,current,{kind:"replace",text:current?.request.disposition.kind==="replace"?current.request.disposition.text:fact.text})}>{t("contextFacts.replace")}</button>
        {fact.origin.kind==="inferred"?<button disabled={!ready||owner.factBlocked()||current?.request.disposition.kind==="reject-inference"} onClick={()=>begin(basis,current,{kind:"reject-inference"})}>{t("contextFacts.reject")}</button>:null}
        {current&&current.request.disposition.kind!=="restore"?<button disabled={!ready||owner.factBlocked()} onClick={()=>begin(basis,current,{kind:"restore"})}>{t("contextFacts.restore")}</button>:null}
      </article>;
    }):[])}
    {pageIndex>0?<button onClick={()=>setPageIndex(value=>Math.max(0,value-1))}>{t("contextFacts.previousSourcePage")}</button>:null}
    {pageIndex+1<pages.length?<button onClick={()=>setPageIndex(value=>value+1)}>{t("contextFacts.nextSourcePage")}</button>:null}
    <details><summary>{t("contextFacts.history")}</summary>{history.isFetching?<p>{t("resource.loading")}</p>:history.error?<p role="alert">{t("contextFacts.readFailed")}<button onClick={()=>{void history.refetch();}}>{t("resource.retryRead")}</button></p>:history.data?.rows.map(row=><article key={row.request.actionId}>
      <p>{t(`contextFacts.operation.${row.request.disposition.kind}`)} · {t(`sourceContext.factKinds.${row.request.basis.fact.fact.kind}`)}</p><pre>{row.request.basis.fact.fact.text}</pre>
      {row.request.disposition.kind==="replace"?<pre>{row.request.disposition.text}</pre>:null}<p>{row.request.actor}: {row.request.reason}</p>
      {row.request.basis.scope.sourceSnapshotId!==scope.sourceSnapshotId?<p>{t("contextFacts.historicalSource")}</p>:null}
    </article>)}{offset>0?<button onClick={()=>setOffset(0)}>{t("contextFacts.firstPage")}</button>:null}{history.data?.nextOffset!=null?<button onClick={()=>setOffset(history.data!.nextOffset!)}>{t("execution.nextPage")}</button>:null}</details>
  </section>;
}
