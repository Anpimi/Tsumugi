import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { TaskCancellationFeedback, useExecutionTaskSession } from "./ExecutionTaskSession";
import { commandFailure, failureReason, CommandFailureDetails } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView, useWorkbenchState, useWorkbenchRef, type AttemptWorkbenchHandle } from "./WorkbenchFrame";
import {enUS} from "./i18n/en-US";
import {useEffect,useImperativeHandle,useRef,useState,type Ref} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {useTranslation} from "react-i18next";
import type {ProjectView} from "./projectCommands";
import {executionContext} from "./executionCommands";
import {sourceReads} from "./sourceQueries";
import {aiTarget,defaultAiConfig,type AiView} from "./aiCommands";
import {useAiPreparation} from "./AiPreparationSession";
import type {EditorTarget} from "./TranslationWorkbench";
export interface AiHandle extends AttemptWorkbenchHandle {allowNavigate:()=>Promise<boolean>}
const stage=(e:unknown)=>commandFailure(e,"outcome-unknown");
export function AiWorkbench({project,disabled,ref,onOpenTranslation}:{project:ProjectView;disabled:boolean;ref?:Ref<AiHandle>;onOpenTranslation:(target:EditorTarget,locale:string)=>boolean | Promise<boolean>}) {
  const {t}=useTranslation();const context=executionContext(project),reads=useSessionReads();
  const [connectionOpen,setConnectionOpen]=useWorkbenchState("ai", "connectionOpen", true);
  const preparation=useAiPreparation(), tasks=useExecutionTaskSession();
  const {presetName,setPresetName,config,setConfig,locale,setLocale,selected,setSelected,prepared,
    consent,setConsent,staleReason,pendingStart,pendingAdopt,dirty,sourceGeneration,clearSelectedRange,reset,targetAvailable,attempt,busy}=preparation;
  const lastSourceGeneration = useWorkbenchRef("ai", "sourceGeneration", sourceGeneration);
  const [open,setOpen]=useWorkbenchView("ai"),[after,setAfter]=useWorkbenchState("ai", "after", 0),[leaving,setLeaving]=useState(false);
  const leaveProof = useRef<(() => boolean) | null>(null);
  const leaveResolve=useRef<((v:boolean)=>void)|null>(null),errorRef=useRef<HTMLDivElement>(null);
  const scopeOptions=sourceReads.scope(context),scopeRead=useSessionQuery({...scopeOptions,enabled:open});
  const contentOptions=sourceReads.content(context,scopeRead.data?.currentSnapshot??"",after,scopeRead.data);
  const contentRead=useSessionQuery({...contentOptions,enabled:open&&!!scopeRead.data?.currentSnapshot&&!scopeRead.error});
  const visiblePage=!contentRead.error?contentRead.data??null:null;
  const viewRead = useSessionQuery<AiView | null>({
    key: ["aiCommands", attempt], scopes: ["execution", "source", "translation", "resources", "arena"], enabled: open && !!attempt,
    read: () => preparation.readView(attempt!),
  });
  const view = !viewRead.error?viewRead.data??null:null;
  const failureValue=preparation.failure??(viewRead.error||scopeRead.error||contentRead.error?stage(viewRead.error??scopeRead.error??contentRead.error):null);
  const failure=failureReason(failureValue);
  const active=!!attempt&&(!view||view.detail.progress.queued>0||view.detail.progress.running>0);
  const cancelUnresolved = Object.values(tasks.state).some(value => (value.target.origin === "ai" || value.target.taskId === view?.detail.taskId)
    && (value.phase === "preparing" || value.phase === "pending" || value.phase === "unknown"));
  const locked=busy||!!pendingStart||!!pendingAdopt||active||cancelUnresolved;
  useEffect(()=>()=>{leaveResolve.current?.(false);},[]);
  useEffect(()=>{if(lastSourceGeneration.current!==sourceGeneration){lastSourceGeneration.current=sourceGeneration;setAfter(0);}},[sourceGeneration]);
  useEffect(()=>{if(failure){if(["ai-endpoint","ai-model","ai-credential"].includes(failure))setConnectionOpen(true);errorRef.current?.focus();}},[failure]);
  function allowLeave(current: () => boolean = () => true):Promise<boolean> {
    leaveProof.current = current;
    if(cancelUnresolved){setOpen(true);return Promise.resolve(false);}
    if(preparation.reserved()){setOpen(true);return Promise.resolve(false);}
    if(!dirty)return Promise.resolve(true);
    setOpen(true);setLeaving(true);return new Promise(resolve=>{leaveResolve.current?.(false);leaveResolve.current=resolve;});
  }
  function allowNavigate():Promise<boolean> {
    if(preparation.reserved()){setOpen(true);return Promise.resolve(false);}
    return Promise.resolve(true);
  }
  function settleLeave(value:boolean){if(value&&leaveProof.current&&!leaveProof.current())value=false;setLeaving(false);if(value&&!reset())value=false;leaveResolve.current?.(value);leaveResolve.current=null;leaveProof.current=null;}
  useImperativeHandle(ref,()=>({allowLeave,allowNavigate,showAttempt(id){preparation.showAttempt(id);setOpen(true);}}));
  function loadPage(next=0){if(next===0){void reads.client.invalidateQueries({queryKey:reads.key(scopeOptions.key),exact:true});void reads.client.invalidateQueries({queryKey:reads.key(sourceReads.content(context,scopeRead.data?.currentSnapshot??"",0,scopeRead.data).key),exact:true});}setAfter(next);}
  function refreshReads(){loadPage();if(attempt)void viewRead.refetch();}
  function change<K extends keyof typeof config>(key:K,value:(typeof config)[K]){setConfig(c=>({...c,[key]:value}));}
  function preset(value:string){setPresetName(value);setConfig(c=>({...c,endpoint:value==="openai"?"https://api.openai.com/v1/chat/completions":value==="local"?"http://127.0.0.1:11434/v1/chat/completions":"",credentialEnv:value==="local"?"":"OPENAI_API_KEY",tokenField:value==="openai"?"max_completion_tokens":"max_tokens"}));}
  const numeric=[['maxItems',1,100],['concurrency',1,2],['maxRequests',1,300],['maxOutputTokens',1,16384],['maxRetries',0,2],['timeoutSeconds',1,120]] as const;
  const fieldFailure=(key:string)=>failure===`ai-${key==="credentialEnv"?"credential":key}`;
  const fieldError=(key:string)=>fieldFailure(key)?<span id={`ai-error-${key}`} className="field-error">{t(`ai.errors.${failure}`,{defaultValue:t("ai.errors.failed")})}</span>:null;
  return <>{open?<WorkbenchPanel open={open} title={t("ai.title")} description={t("ai.description")} className="ai-dialog" onBack={()=>void allowNavigate().then(ok=>{if(ok)setOpen(false);})} backDisabled={disabled || busy || !!pendingStart || !!pendingAdopt}>
    <TaskCancellationFeedback origin="ai" taskId={view?.detail.taskId} disabled={busy} />
    {preparation.notice?<p role="status">{t(preparation.notice==="started"?"ai.startRecorded":preparation.notice==="saved"?"ai.candidateRecorded":"ai.newerInput")}</p>:null}
    {open&&(scopeRead.isPending||contentRead.isPending&&!!scopeRead.data?.currentSnapshot||viewRead.isPending&&!!attempt)?<p role="status">{t("ai.readLoading")}</p>:null}
    {failure?<div role="alert" tabIndex={-1} ref={errorRef}><p>{t(`ai.errors.${failure}`,{defaultValue:t("ai.errors.failed")})}</p><CommandFailureDetails failure={failureValue} /><button className="secondary-button" onClick={refreshReads} disabled={busy}>{t("ai.refresh")}</button></div>:null}
    {!targetAvailable&&locale?<p role="alert">{t("ai.errors.ai-locale")}</p>:null}
    {targetAvailable&&staleReason&&!prepared?<p role="status">{t(staleReason==="source"?"ai.errors.ai-source":"ai.errors.ai-preview")}</p>:null}
    <fieldset disabled={locked}><legend>{t("ai.scope",{count:selected.length})}</legend><details open={connectionOpen} onToggle={event=>setConnectionOpen(event.currentTarget.open)}><summary>{t("ai.connection")}</summary><label className="field">{t("ai.preset")}<select value={presetName} onChange={e=>preset(e.target.value)}><option value="custom">{t("ai.custom")}</option><option value="openai">OpenAI</option><option value="local">{t("ai.local")}</option></select></label>
    {([['endpoint','url'],['model','text'],['credentialEnv','text']] as const).map(([key,type])=><label className="field" key={key}>{t(`ai.${key}`)}<input type={type} value={config[key]} aria-label={t(`ai.${key}`)} aria-invalid={fieldFailure(key)||undefined} aria-describedby={fieldFailure(key)?`ai-error-${key}`:undefined} onChange={e=>change(key,e.target.value)}/>{fieldError(key)}</label>)}<p>{t("ai.credentialHelp")}</p>
    <label className="field">{t("ai.tokenField")}<select value={config.tokenField} onChange={e=>change("tokenField",e.target.value)}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
    </details><details open={failure==="ai-limits"?true:undefined}><summary>{t("ai.budget")}</summary>{failure==="ai-limits"?<p id="ai-error-limits" className="field-error">{t("ai.errors.ai-limits")}</p>:null}{numeric.map(([key,min,max])=><label className="field" key={key}>{t(`ai.${key}`)}<input type="number" min={min} max={max} value={Number.isFinite(config[key])?config[key]:""} aria-invalid={failure==="ai-limits"&&(!Number.isInteger(config[key])||config[key]<min||config[key]>max)||undefined} aria-describedby={failure==="ai-limits"?"ai-error-limits":undefined} onChange={e=>change(key,e.target.valueAsNumber)}/></label>)}<button className="secondary-button" type="button" onClick={()=>{setConfig(c=>({...defaultAiConfig,endpoint:c.endpoint,model:c.model,credentialEnv:c.credentialEnv,tokenField:c.tokenField}));}}>{t("ai.reset")}</button></details>
    <label className="field">{t("ai.locale")}<select value={locale} onChange={e=>{setLocale(e.target.value);}}>{!targetAvailable&&locale?<option value={locale} disabled>{locale}</option>:null}{project.metadata.targetLocales.map(l=><option key={l}>{l}</option>)}</select></label>
    <label className="source-check"><input type="checkbox" checked={config.shareTerms} onChange={e=>change("shareTerms",e.target.checked)}/>{t("ai.shareTerms")}</label><label className="source-check"><input type="checkbox" checked={config.shareContext} onChange={e=>change("shareContext",e.target.checked)}/>{t("ai.shareContext")}</label>
    <h3>{t("ai.scope",{count:selected.length})}</h3>{visiblePage?<><ul>{visiblePage.rows.map(row=>row.unitId?<li key={row.unitId}><label className="source-check"><input type="checkbox" checked={selected.includes(row.unitId)} onChange={e=>{setSelected(ids=>e.target.checked?[...ids,row.unitId!]:ids.filter(id=>id!==row.unitId));}}/>{row.occurrence.key}: {row.occurrence.text}</label></li>:null)}</ul><button className="secondary-button" disabled={locked} onClick={()=>void loadPage(0)}>{t("ai.first")}</button>{visiblePage.nextOrdinal!==null?<button className="secondary-button" onClick={()=>void loadPage(visiblePage.nextOrdinal!)}>{t("ai.next")}</button>:null}</>:!scopeRead.isPending&&(!scopeRead.data?.currentSnapshot||!contentRead.isPending)?<p>{t("ai.noSource")}</p>:null}
    <button className="secondary-button" type="button" disabled={locked||!selected.length} onClick={()=>{if(locked)return;clearSelectedRange();}}>{t("ai.clearSelectedRange")}</button>
    <button className="primary-button" disabled={disabled||locked||!selected.length||!targetAvailable||!visiblePage} onClick={()=>{if(!disabled)void preparation.preview();}}>{t("ai.preview")}</button></fieldset>
    {prepared&&targetAvailable?<section><h3>{t("ai.previewTitle")}</h3><p>{prepared.preview.config.endpoint} · {prepared.preview.config.model}</p><p>{t("ai.limits",{defaultValue:enUS.ai.limits,requests:config.maxRequests,concurrency:config.concurrency,tokens:config.maxOutputTokens,retries:config.maxRetries})}</p><p>{t("ai.costUnknown")}</p><p>{t("ai.rateLimit")}</p>{prepared.preview.items.map(item=><article key={item.unitId}><h4>{item.nativeKey} → {item.targetLocale}</h4><pre className="ai-text">{item.sourceText}</pre>{item.terms.map(term=><p key={term.revisionId}>{term.source} → {term.target}</p>)}{item.context?<pre className="ai-text">{item.context.text}</pre>:null}{item.omissions.map(reason=><p key={reason}>{reason.startsWith("term-conflict:")?t("ai.termConflict",{term:reason.slice(14)}):t(`ai.${reason}`,{defaultValue:reason})}</p>)}</article>)}<label className="source-check"><input type="checkbox" checked={consent} disabled={locked} onChange={e=>setConsent(e.target.checked)}/>{t("ai.consent")}</label><button className="primary-button" disabled={disabled||locked||!consent} onClick={()=>{if(!disabled)void preparation.start();}}>{t("ai.generate")}</button></section>:null}
    {pendingStart?<section role="status"><p>{t(pendingStart.uncertain?"ai.startUnknown":"ai.startPending")}</p>{pendingStart.uncertain?<><button className="secondary-button" disabled={busy} onClick={()=>void preparation.checkStart()}>{t("ai.reconcile")}</button><button className="secondary-button" disabled={busy} onClick={()=>void preparation.retryStart()}>{t("ai.retrySame")}</button></>:null}</section>:null}
    {pendingAdopt?<section><p>{t(pendingAdopt.uncertain?"ai.adoptUnknown":"ai.adoptPending")}</p><p>{pendingAdopt.candidate.item.nativeKey} → {pendingAdopt.candidate.item.targetLocale}</p><pre className="ai-text">{pendingAdopt.candidate.text}</pre>{pendingAdopt.uncertain?<><button className="secondary-button" disabled={busy} onClick={()=>void preparation.checkAdoption()}>{t("ai.reconcile")}</button>{pendingAdopt.retryAllowed?<button className="secondary-button" disabled={busy} onClick={()=>void preparation.retryAdoption()}>{t("ai.retrySame")}</button>:null}</>:null}</section>:null}
    {view?<section><h3>{t("ai.results")}</h3><p>{view.config.model} · {view.recipe}</p><p>{t("ai.progress",{...view.detail.progress,defaultValue:enUS.ai.progress})}</p>{view.budget?<><p>{t("ai.budgetSummary",{...view.budget,defaultValue:enUS.ai.budgetSummary})}</p><p>{t("ai.budgetUsage",{...view.budget,defaultValue:enUS.ai.budgetUsage})}</p>{view.budget.legacyHeld>0?<p>{t("ai.legacyBudget",{count:view.budget.legacyHeld,defaultValue:enUS.ai.legacyBudget})}</p>:null}</>:null}{active?<button className="secondary-button" disabled={disabled||busy||!!pendingStart||!!pendingAdopt||!tasks.canCancel({taskId:view.detail.taskId,attemptId:view.detail.attemptId,origin:"ai"})} onClick={()=>{if(disabled||preparation.reserved())return;void tasks.cancel({taskId:view.detail.taskId,attemptId:view.detail.attemptId,origin:"ai"});}}>{t("ai.cancel")}</button>:null}<button className="secondary-button" disabled={busy} onClick={()=>void viewRead.refetch()}>{t("ai.refresh")}</button>
    {view.rows.map(row=>{const item=view.detail.items.find(i=>i.status.itemId===row.itemId);return <article key={row.itemId}><h4>{row.item.nativeKey}</h4><p>{t(`ai.states.${item?.status.execution}`,{defaultValue:item?.status.execution??""})}</p>{item?.status.diagnostic?<p>{t(`ai.errors.${item.status.diagnostic}`,{defaultValue:t("ai.errors.failed")})}</p>:null}{row.output?<><pre className="ai-text">{row.output.text}</pre><p>{row.output.usage?t("ai.usage",{...row.output.usage,defaultValue:enUS.ai.usage}):t("ai.usageUnknown")}{row.output.usage&&row.output.usageIncomplete?` · ${t("ai.usageUnknown")}`:""}</p><button className="secondary-button" disabled={disabled||!row.resultId||!preparation.canAdopt(view,row.resultId)} onClick={()=>{if(!disabled&&row.resultId)void preparation.adopt(view,row.resultId);}}>{item?.status.adoption==="committed"||(row.resultId&&preparation.saved[row.resultId])?t("ai.saved"):t("ai.saveCandidate")}</button><button className="secondary-button" disabled={busy||!!pendingAdopt} onClick={()=>void allowNavigate().then(async ok=>{if(ok)await onOpenTranslation(aiTarget(row.item),row.item.targetLocale);})}>{t("ai.openEditor")}</button></>:null}</article>;})}<p>{t("ai.noAutomaticRetry")}</p></section>:null}

  </WorkbenchPanel>:null}<Dialog.Root open={leaving} onOpenChange={next=>{if(!next)settleLeave(false);}}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop"/><Dialog.Content className="confirm-dialog execution-confirm-dialog"><Dialog.Title>{t("ai.unsaved")}</Dialog.Title><Dialog.Description>{t("ai.unsavedDescription")}</Dialog.Description><button className="secondary-button" onClick={()=>settleLeave(false)}>{t("ai.stay")}</button><button className="secondary-button" onClick={()=>settleLeave(true)}>{t("ai.discard")}</button></Dialog.Content></Dialog.Portal></Dialog.Root></>;
}
