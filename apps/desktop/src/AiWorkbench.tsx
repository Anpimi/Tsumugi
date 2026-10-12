import { useSessionReads, useSessionQuery } from "./SessionReadProvider";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { hasUnknownOutcome } from "./projectCommands";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import {enUS} from "./i18n/en-US";
import {useEffect,useImperativeHandle,useRef,useState,type Ref} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {useTranslation} from "react-i18next";
import type {ProjectView} from "./projectCommands";
import {executionCommands as execution,executionContext,type PrepareRequest} from "./executionCommands";
import {sourceCommands,type ContentPage} from "./sourceCommands";
import {aiCommands,aiTarget,defaultAiConfig,type AiConfig,type AiView} from "./aiCommands";
import { workPlanCommands, type WorkPlanView, type WorkPlanStatusView, type PlanOptions } from "./workPlanCommands";
import { AiEffectStatus } from "./AiEffectStatus";
import { WorkPlanControls } from "./WorkPlanControls";
import { WorkPlanToolChoice, type PlanToolDraft, type PlanToolChoiceHandle } from "./WorkPlanToolChoice";
import { WorkPlanAgentControls } from "./WorkPlanAgentControls";
import type { WorkPlanToolSelection } from "./generated/ai.requests";
import { TextReviewSelections } from "./TextReviewSelections";
import type { PluginTextReviewSelection } from "./pluginCommands";
import type {EditorTarget} from "./TranslationWorkbench";
export interface AiHandle {allowLeave:()=>Promise<boolean>;showAttempt:(id:string)=>void}
const stage=(e:unknown)=>commandFailure(e,"outcome-unknown");
const defaultOptions: PlanOptions = { stages: (["understanding", "resources", "generation", "checks", "delivery"] as const).map(stage => ({stage, mode: stage === "generation" ? "assisted" : "manual"})), selectionPolicy: "candidates-only", adoptResources: false, deliver: false, advisoryChecks: [] };
export function AiWorkbench({project,disabled,ref,onOpenTranslation,onOpenExtensions}:{project:ProjectView;disabled:boolean;ref?:Ref<AiHandle>;onOpenTranslation:(target:EditorTarget,locale:string)=>boolean;onOpenExtensions?:()=>void}) {
  const {t}=useTranslation();const context=executionContext(project);const reads=useSessionReads();
  const [connectionOpen,setConnectionOpen]=useState(true);
  const [toolDraft,setToolDraft]=useState<PlanToolDraft|null>(null),[agentBlocked,setAgentBlocked]=useState(false);
  const toolChoice=useRef<PlanToolChoiceHandle>(null);
  const [presetName,setPresetName]=useState("custom");const [open,setOpen]=useWorkbenchView("ai"),[config,setConfig]=useState<AiConfig>(()=>({...defaultAiConfig}));
  const [locale,setLocale]=useState(project.metadata.targetLocales[0]??""),[page,setPage]=useState<ContentPage|null>(null),[selected,setSelected]=useState<string[]>([]);
  const [prepared,setPrepared]=useState<WorkPlanView|null>(null),[consent,setConsent]=useState(false),[attempt,setAttempt]=useState<string|null>(null);
  const [busy,setBusy]=useState(false),[failureValue,setFailure]=useState<CommandFailure|null>(null),[dirty,setDirty]=useState(false),[leaving,setLeaving]=useState(false);
  const failure=failureReason(failureValue);
  const [planBlocked,setPlanBlocked]=useState(false),[currentPlanId,setCurrentPlanId]=useState<string|null>(null),[options,setOptions]=useState<PlanOptions>(()=>structuredClone(defaultOptions));
  const [pendingAdopt,setPendingAdopt]=useState<PrepareRequest|null>(null),[receiptMissing,setReceiptMissing]=useState(false);
  const [advisoryChecks,setAdvisoryChecks]=useState<PluginTextReviewSelection[]>([]);
  const alive=useRef(true),generation=useRef(0),inFlight=useRef(false),leaveResolve=useRef<((v:boolean)=>void)|null>(null),errorRef=useRef<HTMLDivElement>(null);
  const viewRead = useSessionQuery<AiView | null>({
    key: ["aiCommands", attempt], scopes: ["execution", "source", "translation", "resources", "arena", "review"], enabled: open && !!attempt && !busy,
    read: () => aiCommands.read({...context, attemptId: attempt!}),
  });
  const view = viewRead.data ?? null, setView = viewRead.setData;
  const planId=currentPlanId??view?.planId??null;
  const planRead=useSessionQuery<WorkPlanStatusView>({key:["workPlan",planId],scopes:["project","execution","source","translation","resources"],enabled:open&&!!planId&&!busy,read:()=>workPlanCommands.status({...context,planId:planId!})});
  const status=planRead.data??null;
  const sharing=prepared?.preview??status?.plan.preview;
  async function refreshPlan(id:string,current:()=>boolean) { const result=await workPlanCommands.status({...context,planId:id});if(current())reads.client.setQueryData(reads.key(["workPlan",id]),result);return result; }
  const assisted=options.stages.some(choice=>choice.stage==="generation"&&choice.mode==="assisted");
  const active=!!attempt&&(!view||view.detail.progress.queued>0||view.detail.progress.running>0||view.rows.some(row=>row.automation&&["waiting","saving-candidate","checking"].includes(row.automation.phase)));
  const locked=disabled||busy||planBlocked||agentBlocked||!!pendingAdopt||active;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;leaveResolve.current?.(false);};},[]);
  useEffect(()=>{if(failure){if(["ai-endpoint","ai-model","ai-credential"].includes(failure))setConnectionOpen(true);errorRef.current?.focus();}},[failure]);
  async function perform(work:(current:()=>boolean)=>Promise<void>) {
    if(inFlight.current)return;inFlight.current=true;setBusy(true);setFailure(null);
    const ticket=++generation.current;const current=()=>alive.current&&generation.current===ticket;
    try{await work(current);}catch(e){if(current())setFailure(stage(e));}
    finally{inFlight.current=false;if(alive.current)setBusy(false);}
  }
  function allowLeave():Promise<boolean> {
    if(inFlight.current||planBlocked||agentBlocked||pendingAdopt){setOpen(true);setFailure(planBlocked?"work-plan-pending":"outcome-unknown");return Promise.resolve(false);}
    if(!dirty)return Promise.resolve(true);
    setOpen(true);setLeaving(true);return new Promise(resolve=>{leaveResolve.current?.(false);leaveResolve.current=resolve;});
  }
  function settleLeave(value:boolean){setLeaving(false);if(value){setDirty(false);setPresetName("custom");setConfig({...defaultAiConfig});setLocale(project.metadata.targetLocales[0]??"");setSelected([]);setPrepared(null);setConsent(false);setAttempt(null);setCurrentPlanId(null);setOptions(structuredClone(defaultOptions));setToolDraft(null);setAdvisoryChecks([]);setView(null);setOpen(false);}leaveResolve.current?.(value);leaveResolve.current=null;}
  useImperativeHandle(ref,()=>({allowLeave,showAttempt(id){if(dirty||inFlight.current||planBlocked||agentBlocked||pendingAdopt){setOpen(true);return;}setAttempt(id);setCurrentPlanId(null);setView(null);setOpen(true);}}));
  async function loadPage(after=0) {
    await perform(async current=>{const scope=await sourceCommands.scope(context);if(!scope.currentSnapshot){if(current())setPage(null);return;}const result=await sourceCommands.content({...context,snapshotId:scope.currentSnapshot,after,limit:50});if(current())setPage(result);});
  }
  useEffect(()=>{if(open&&!page)void loadPage();},[open]);
  useEffect(()=>{if(viewRead.error)setFailure(stage(viewRead.error));else if(viewRead.isSuccess)setFailure(previous=>failureReason(previous)==="busy"?null:previous);},[viewRead.error,viewRead.isSuccess]);
  useEffect(()=>{if(planRead.error)setFailure(stage(planRead.error));},[planRead.error]);
  function change<K extends keyof AiConfig>(key:K,value:AiConfig[K]){setFailure(null);setConfig(c=>({...c,[key]:value}));setPrepared(null);setConsent(false);setDirty(true);}
  function preset(value:string){setFailure(null);setPresetName(value);setConfig(c=>({...c,endpoint:value==="openai"?"https://api.openai.com/v1/chat/completions":value==="local"?"http://127.0.0.1:11434/v1/chat/completions":"",credentialEnv:value==="local"?"":"OPENAI_API_KEY",tokenField:value==="openai"?"max_completion_tokens":"max_tokens"}));setPrepared(null);setConsent(false);setDirty(true);}
  async function adopt(request:PrepareRequest,current:()=>boolean){setPendingAdopt(request);setReceiptMissing(false);try{await execution.prepare(request);await execution.adopt({...context,actionId:request.actionId});const next=await aiCommands.read({...context,attemptId:request.attemptId});if(current()){setView(next);setPendingAdopt(null);}}catch(e){if(current()&&!hasUnknownOutcome(e))setPendingAdopt(null);throw e;}}
  const numeric=[['maxItems',1,100],['concurrency',1,2],['maxRequests',1,300],['maxOutputTokens',1,16384],['maxRetries',0,2],['timeoutSeconds',1,120]] as const;
  const fieldFailure=(key:string)=>failure===`ai-${key==="credentialEnv"?"credential":key}`;
  const fieldError=(key:string)=>fieldFailure(key)?<span id={`ai-error-${key}`} className="field-error">{t(`ai.errors.${failure}`,{defaultValue:t("ai.errors.failed")})}</span>:null;
  return <><WorkbenchPanel open={open} title={t("ai.title")} description={t("ai.description")} className="ai-dialog" onBack={()=>void allowLeave().then(ok=>{if(ok)setOpen(false);})} backDisabled={disabled || busy || planBlocked || agentBlocked || !!pendingAdopt}>
    {failure?<div role="alert" tabIndex={-1} ref={errorRef}><p>{t(`ai.errors.${failure}`,{defaultValue:t("ai.errors.failed")})}</p><CommandFailureDetails failure={failureValue} /><button className="secondary-button" onClick={()=>void loadPage()} disabled={busy}>{t("ai.refresh")}</button></div>:null}
    <fieldset disabled={locked}><legend>{t("ai.scope",{count:selected.length})}</legend><h3>{t("ai.plan.stagesTitle")}</h3>{options.stages.map(choice=><label className="field" key={choice.stage}>{t(`ai.plan.stages.${choice.stage}`)}<select value={choice.mode} onChange={event=>{
      const mode = event.target.value as typeof choice.mode;
      setOptions(previous=>({...previous,
        selectionPolicy: (choice.stage === "generation" || choice.stage === "checks") && mode !== "assisted" ? "candidates-only" : previous.selectionPolicy,
        stages:previous.stages.map(item=>item.stage===choice.stage?{...item,mode}:choice.stage==="generation"&&mode!=="assisted"&&item.stage==="checks"&&item.mode==="assisted"?{...item,mode:"manual"}:item)
      }));setPrepared(null);setConsent(false);setDirty(true);
    }}><option value="manual">{t("ai.plan.modes.manual")}</option>{choice.stage==="generation"?<option value="assisted">{t("ai.plan.modes.assisted")}</option>:choice.stage==="checks"&&assisted&&options.selectionPolicy!=="candidates-only"?<option value="assisted">{t("ai.plan.mechanicalChecks")}</option>:null}<option value="skipped">{t("ai.plan.modes.skipped")}</option></select></label>)}
    {assisted?<><label className="field">{t("ai.plan.selectionPolicy")}<select aria-label={t("ai.plan.selectionPolicy")} value={options.selectionPolicy} onChange={event=>{
      const selectionPolicy = event.target.value as PlanOptions["selectionPolicy"];
      setOptions(previous=>({...previous,selectionPolicy,stages:previous.stages.map(choice=>choice.stage==="checks"?{...choice,mode:selectionPolicy==="candidates-only"?"manual":"assisted"}:choice)}));
      setPrepared(null);setConsent(false);setDirty(true);
    }}>{(["candidates-only","missing-only","replace-captured-selection"] as const).map(policy=><option key={policy} value={policy}>{t(`ai.plan.policies.${policy}`)}</option>)}</select></label>
    {options.selectionPolicy!=="candidates-only"?<p>{t("ai.plan.checkedSelection")}</p>:null}</>:null}
    {assisted?<><details open={connectionOpen} onToggle={event=>setConnectionOpen(event.currentTarget.open)}><summary>{t("ai.connection")}</summary><label className="field">{t("ai.preset")}<select value={presetName} onChange={e=>preset(e.target.value)}><option value="custom">{t("ai.custom")}</option><option value="openai">OpenAI</option><option value="local">{t("ai.local")}</option></select></label>
    {([['endpoint','url'],['model','text'],['credentialEnv','text']] as const).map(([key,type])=><label className="field" key={key}>{t(`ai.${key}`)}<input type={type} value={config[key]} aria-label={t(`ai.${key}`)} aria-invalid={fieldFailure(key)||undefined} aria-describedby={fieldFailure(key)?`ai-error-${key}`:undefined} onChange={e=>change(key,e.target.value)}/>{fieldError(key)}</label>)}<p>{t("ai.credentialHelp")}</p>
    <label className="field">{t("ai.tokenField")}<select value={config.tokenField} onChange={e=>change("tokenField",e.target.value)}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
    </details><details open={failure==="ai-limits"?true:undefined}><summary>{t("ai.budget")}</summary>{failure==="ai-limits"?<p id="ai-error-limits" className="field-error">{t("ai.errors.ai-limits")}</p>:null}{numeric.map(([key,min,max])=><label className="field" key={key}>{t(`ai.${key}`)}<input type="number" min={min} max={max} value={Number.isFinite(config[key])?config[key]:""} aria-invalid={failure==="ai-limits"&&(!Number.isInteger(config[key])||config[key]<min||config[key]>max)||undefined} aria-describedby={failure==="ai-limits"?"ai-error-limits":undefined} onChange={e=>change(key,e.target.valueAsNumber)}/></label>)}<button className="secondary-button" type="button" onClick={()=>{setFailure(null);setConfig(c=>({...defaultAiConfig,endpoint:c.endpoint,model:c.model,credentialEnv:c.credentialEnv,tokenField:c.tokenField}));setPrepared(null);setConsent(false);setDirty(true);}}>{t("ai.reset")}</button></details></>:null}
    {assisted?<WorkPlanToolChoice ref={toolChoice} open={open} disabled={locked} value={toolDraft} onChange={value=>{setToolDraft(value);setPrepared(null);setConsent(false);setDirty(true);}}/>:null}
    <label className="field">{t("ai.locale")}<select value={locale} onChange={e=>{setLocale(e.target.value);setPrepared(null);setConsent(false);setDirty(true);}}>{project.metadata.targetLocales.map(l=><option key={l}>{l}</option>)}</select></label>
    {assisted?<><label className="source-check"><input type="checkbox" checked={config.shareTerms} onChange={e=>change("shareTerms",e.target.checked)}/>{t("ai.shareTerms")}</label><label className="source-check"><input type="checkbox" checked={config.shareContext} onChange={e=>change("shareContext",e.target.checked)}/>{t("ai.shareContext")}</label></>:null}
    <h3>{t("ai.scope",{count:selected.length})}</h3>{page?<><ul>{page.rows.map(row=>row.unitId?<li key={row.unitId}><label className="source-check"><input type="checkbox" checked={selected.includes(row.unitId)} onChange={e=>{setSelected(ids=>e.target.checked?[...ids,row.unitId!]:ids.filter(id=>id!==row.unitId));setPrepared(null);setConsent(false);setDirty(true);}}/>{row.occurrence.key}: {row.occurrence.text}</label></li>:null)}</ul><button className="secondary-button" disabled={locked} onClick={()=>void loadPage(0)}>{t("ai.first")}</button>{page.nextOrdinal!==null?<button className="secondary-button" onClick={()=>void loadPage(page.nextOrdinal!)}>{t("ai.next")}</button>:null}</>:<p>{t("ai.noSource")}</p>}
    {options.stages.some(choice=>choice.stage==="checks"&&choice.mode==="assisted")?<><p>{t("review.formatChecksRequired")}</p><TextReviewSelections value={advisoryChecks} active={open} scopeKey={JSON.stringify([context,locale])} disabled={locked} onOpenExtensions={onOpenExtensions} onSnapshotRevision={revision=>{if(prepared?.checkers.some(checker=>checker.kind==="ready"&&checker.plugin.plugin.settingsRevision!==revision)){setPrepared(null);setConsent(false);}}} onChange={choices=>{setAdvisoryChecks(choices);setPrepared(null);setConsent(false);setDirty(true);}}/></>:null}
    <button className="primary-button" disabled={!selected.length} onClick={()=>void perform(async current=>{
      if(assisted&&numeric.some(([key,min,max])=>!Number.isInteger(config[key])||config[key]<min||config[key]>max))throw {field:"ai-limits"};
      const capturedTools=assisted&&toolDraft?toolChoice.current?.capture():null;
      if(assisted&&toolDraft&&!capturedTools)throw {reason:"work-plan-tool-unavailable",outcome:"rejected"};
      let toolSelection:WorkPlanToolSelection|null=null;
      if(capturedTools){
        const entries=await Promise.all(capturedTools.entries.map(async tool=>({
          handle:await execution.identity(context),tool:tool.tool,target:tool.target,selections:tool.selections,
        })));
        const [first,...remaining]=entries;
        if(!first)throw {reason:"work-plan-tool-unavailable",outcome:"rejected"};
        toolSelection={maxInvocations:capturedTools.maxInvocations,entries:[first,...remaining]};
      }
      if(!current())return;
      const result=await workPlanCommands.prepare({...context,config:assisted?config:null,locale,unitIds:selected,options,toolSelection,
        advisoryChecks:options.stages.some(choice=>choice.stage==="checks"&&choice.mode==="assisted")?advisoryChecks:[]},capturedTools?.entries.map(tool=>tool.view)??[]);
      if(current()){setPrepared(result);setCurrentPlanId(null);setAttempt(null);setView(null);setConsent(false);}
    })}>{t(assisted?"ai.preview":"ai.plan.prepareManual")}</button></fieldset>
    {sharing?<section><h3>{t("ai.previewTitle")}</h3><p>{sharing.config.endpoint} · {sharing.config.model}</p><p>{t("ai.limits",{defaultValue:enUS.ai.limits,requests:sharing.config.maxRequests,concurrency:sharing.config.concurrency,tokens:sharing.config.maxOutputTokens,retries:sharing.config.maxRetries})}</p><p>{t("ai.costUnknown")}</p><p>{t("ai.rateLimit")}</p>{sharing.items.map(item=><article key={item.unitId}><h4>{item.nativeKey} → {item.targetLocale}</h4><pre className="ai-text">{item.sourceText}</pre>{item.terms.map(term=><p key={term.revisionId}>{term.source} → {term.target}</p>)}{item.context?<pre className="ai-text">{item.context.text}</pre>:null}{item.omissions.map(reason=><p key={reason}>{reason.startsWith("term-conflict:")?t("ai.termConflict",{term:reason.slice(14)}):t(`ai.${reason}`,{defaultValue:reason})}</p>)}</article>)}{prepared?.preview&&!status?<label className="source-check"><input type="checkbox" checked={consent} disabled={locked} onChange={e=>setConsent(e.target.checked)}/>{t("ai.consent")}</label>:null}</section>:null}
    <WorkPlanControls onOpenExtensions={onOpenExtensions} context={context} prepared={prepared} status={status} busy={busy} disabled={disabled||!!pendingAdopt} consent={consent} run={perform} refresh={refreshPlan} onPlan={setCurrentPlanId} onStarted={(id,plan)=>{setAttempt(id);setCurrentPlanId(plan);setPrepared(null);setConsent(false);setView(null);setDirty(false);}} onBlockedChange={setPlanBlocked} onOpenTranslation={(target,targetLocale)=>{if(!inFlight.current&&!pendingAdopt&&!planBlocked&&onOpenTranslation(target,targetLocale))setOpen(false);}}/>
    {status&&status.plan.preview?<WorkPlanAgentControls key={`${context.sessionToken}:${status.lease.planId}`} context={context} status={status} open={open} disabled={disabled||planBlocked||!!pendingAdopt||active} busy={busy} run={perform} onBlockedChange={setAgentBlocked} onGenerated={id=>{setAttempt(id);setView(null);}}/>:null}
    {pendingAdopt?<section><p>{t("ai.adoptUnknown")}</p><button className="secondary-button" disabled={busy} onClick={()=>void perform(async current=>{const receipt=await execution.receipt({...context,actionId:pendingAdopt.actionId});if(receipt){const next=await aiCommands.read({...context,attemptId:pendingAdopt.attemptId});if(current()){setPendingAdopt(null);setView(next);}}else if(current())setReceiptMissing(true);})}>{t("ai.reconcile")}</button>{receiptMissing?<button className="secondary-button" disabled={busy} onClick={()=>void perform(current=>adopt(pendingAdopt,current))}>{t("ai.retrySame")}</button>:null}</section>:null}
    {view?<section><h3>{t("ai.results")}</h3><p>{view.config.model} · {view.recipe}</p><p>{t("ai.progress",{...view.detail.progress,defaultValue:enUS.ai.progress})}</p>{view.budget?<><p>{t("ai.budgetSummary",{...view.budget,defaultValue:enUS.ai.budgetSummary})}</p><p>{t("ai.budgetUsage",{...view.budget,defaultValue:enUS.ai.budgetUsage})}</p>{view.budget.legacyHeld>0?<p>{t("ai.legacyBudget",{count:view.budget.legacyHeld,defaultValue:enUS.ai.legacyBudget})}</p>:null}</>:null}{active&&!planId?<button className="secondary-button" disabled={busy} onClick={()=>void perform(async current=>{await execution.cancel({...context,taskId:view.detail.taskId,requestId:await execution.identity(context)});if(current())setView(await aiCommands.read({...context,attemptId:view.detail.attemptId}));})}>{t("ai.cancel")}</button>:null}<button className="secondary-button" disabled={busy} onClick={()=>void perform(async current=>{const result=await aiCommands.read({...context,attemptId:view.detail.attemptId});if(current())setView(result);})}>{t("ai.refresh")}</button>
    {view.rows.map(row=>{const item=view.detail.items.find(i=>i.status.itemId===row.itemId);const unit=view.detail.recovery.units.find(u=>u.itemIds.includes(row.itemId));return <article key={row.itemId}><h4>{row.item.nativeKey}</h4><p>{t(`ai.states.${item?.status.execution}`,{defaultValue:item?.status.execution??""})}</p>{item?.status.diagnostic?<p>{t(`ai.errors.${item.status.diagnostic}`,{defaultValue:t("ai.errors.failed")})}</p>:null}{row.automation?<AiEffectStatus effect={row.automation} disabled={disabled||busy||planBlocked||!!pendingAdopt||!status||status.state!=="active"||status.lease.generation!==view.planGeneration} onRetry={()=>void perform(async current=>{const latest=await aiCommands.read({...context,attemptId:view.detail.attemptId});if(!current())return;setView(latest);if(!latest.rows.find(item=>item.itemId===row.itemId)?.automation?.retryable)return;await aiCommands.retryEffect({...context,attemptId:view.detail.attemptId,itemId:row.itemId});const result=await aiCommands.read({...context,attemptId:view.detail.attemptId});if(current())setView(result);})}/>:null}{row.output?<><pre className="ai-text">{row.output.text}</pre><p>{row.output.usage?t("ai.usage",{...row.output.usage,defaultValue:enUS.ai.usage}):t("ai.usageUnknown")}{row.output.usage&&row.output.usageIncomplete?` · ${t("ai.usageUnknown")}`:""}</p><button className="secondary-button" disabled={disabled||busy||planBlocked||!!pendingAdopt||(!!planId&&(!status||status.state!=="active"||status.lease.generation!==view.planGeneration))||Boolean(row.savedRevisionId)||Boolean(row.automation&&["waiting","saving-candidate","checking"].includes(row.automation.phase))||item?.status.adoption==="committed"||!unit} onClick={()=>void perform(async current=>adopt({...context,attemptId:view.detail.attemptId,unitId:unit!.unitId,actionId:await execution.identity(context),resultIds:[row.resultId!]},current))}>{row.savedRevisionId||item?.status.adoption==="committed"?t("ai.saved"):t("ai.saveCandidate")}</button><button className="secondary-button" disabled={busy||planBlocked||!!pendingAdopt} onClick={()=>void allowLeave().then(ok=>{if(ok&&onOpenTranslation(aiTarget(row.item),row.item.targetLocale))setOpen(false);})}>{t("ai.openEditor")}</button></>:null}</article>;})}<p>{t("ai.noAutomaticRetry")}</p></section>:null}

  </WorkbenchPanel><Dialog.Root open={leaving} onOpenChange={next=>{if(!next)settleLeave(false);}}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop"/><Dialog.Content className="confirm-dialog execution-confirm-dialog"><Dialog.Title>{t("ai.unsaved")}</Dialog.Title><Dialog.Description>{t("ai.unsavedDescription")}</Dialog.Description><button className="secondary-button" onClick={()=>settleLeave(false)}>{t("ai.stay")}</button><button className="secondary-button" onClick={()=>settleLeave(true)}>{t("ai.discard")}</button></Dialog.Content></Dialog.Portal></Dialog.Root></>;
}
