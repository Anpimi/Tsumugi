import { useTranslation } from "react-i18next";
import { useWorkbenchState, type WorkspaceArea } from "./WorkbenchFrame";
import { useAiPreparation } from "./AiPreparationSession";
import { executionContext } from "./executionCommands";
import { sourceReads } from "./sourceQueries";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { workPlanCommands } from "./workPlanCommands";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import { reviewReasonKey } from "./reviewLabels";
import type { ProjectView } from "./projectCommands";

/** Queries own current assessments; the original preparation owns explicit edits. */
export function IncrementalMaintenance({ project, active, disabled, onOpenManual }: {
  project: ProjectView; active: boolean; disabled: boolean; onOpenManual?: (area: WorkspaceArea) => Promise<boolean>;
}) {
  const { t }=useTranslation(), reads=useSessionReads(), owner=useAiPreparation(), context=executionContext(project);
  const [expanded,setExpanded]=useWorkbenchState("ai","maintenanceOpen",false);
  const [after,setAfter]=useWorkbenchState("ai","maintenanceAfter",0);
  // The containing AI workspace shares this Query. Collapsing this section
  // retires only its assessment, not the workspace's current source facts.
  const scopeOptions=sourceReads.scope(context), source=useSessionQuery({...scopeOptions,enabled:active});
  const snapshot=source.data?.currentSnapshot, locale=owner.locale;
  const key=["maintenance-assessment",snapshot,locale,after,100];
  const query=useSessionQuery({key,scopes:["project","source","translation","resources","review"],
    enabled:active&&expanded&&!!snapshot&&project.metadata.targetLocales.includes(locale),
    read:()=>workPlanCommands.maintenance({...context,snapshotId:snapshot!,locale,after,limit:100})});
  function currentAssessment() {
    const facts=reads.client.getQueryState(reads.key(key)), scope=reads.client.getQueryState(reads.key(scopeOptions.key));
    return active&&!reads.retired&&facts?.status==="success"&&facts.fetchStatus==="idle"&&!facts.error&&!facts.isInvalidated&&facts.data===query.data
      &&scope?.status==="success"&&scope.fetchStatus==="idle"&&!scope.error&&!scope.isInvalidated&&scope.data===source.data
      &&query.data?.sourceSnapshotId===source.data?.currentSnapshot&&query.data?.locale===owner.current().locale ? query.data : null;
  }
  const current=currentAssessment(), draft=owner.maintenance, shown=draft?.assessment??current;
  const stale=!!draft&&(!current||current.digest!==draft.assessment.digest);
  const locked=disabled||owner.reserved();
  return <section aria-label={t("ai.maintenance.title")}>
    <button type="button" className="secondary-button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{t("ai.maintenance.title")}</button>
    {expanded ? <>
      <p>{t("ai.maintenance.help")}</p><p>{t("ai.maintenance.coverage")}</p>
      {source.isFetching||query.isFetching ? <p role="status">{t("ai.readLoading")}</p>:null}
      {source.error||query.error ? <div role="alert"><p>{t("ai.maintenance.failed")}</p><CommandFailureDetails failure={commandFailure(source.error??query.error)}/></div>:null}
      <button type="button" disabled={locked||source.isFetching||query.isFetching} onClick={()=>{void source.refetch();if(snapshot)void query.refetch();}}>{t("ai.maintenance.refresh")}</button>
      <button type="button" disabled={locked||!current||!owner.canReceiveContentSelection()} onClick={()=>{const value=currentAssessment();if(value)owner.captureMaintenance(value,owner.current().editSeq,()=>currentAssessment()===value);}}>{t(draft?"ai.maintenance.replace":"ai.maintenance.capture")}</button>
      {draft ? <button type="button" disabled={locked} onClick={()=>owner.discardMaintenance()}>{t("ai.maintenance.discard")}</button>:null}
      {stale ? <p role="status">{t("ai.maintenance.changed")}</p>:null}
      {shown?.rows.length===0 ? <p>{t("ai.maintenance.empty")}</p>:null}
      {shown?.rows.map(row=>{
        const choice=draft?.choices.find(choice=>choice.unitId===row.unitId);
        return <article key={row.unitId}><h4>{row.nativeKey}</h4><pre>{row.sourceText}</pre><p>{row.translationText??t("review.missingTranslation")}</p>
          <ul>{row.reasons.map(reason=><li key={reason}>{t(reason==="source-changed"?"ai.maintenance.sourceChanged":reason==="correspondence-unresolved"?"ai.maintenance.mapping":reviewReasonKey(reason))}</li>)}</ul>
          {row.protection.protected ? <p>{t("ai.maintenance.protected")}</p>:null}
          <details><summary>{t("ai.maintenance.basis")}</summary><p>{row.sourceRevisionId} · {row.translationRevisionId??"—"}</p><p>{row.reviewBasis}</p><p>{row.protection.revision}</p><ul>{row.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul></details>
          {choice ? <>
            <label>{t("ai.maintenance.action")}<select aria-label={t("ai.maintenance.actionFor",{name:row.nativeKey})} value={choice.action} disabled={locked}
              onChange={event=>{const action=event.target.value;if(action==="keep"||action==="recheck"||action==="repair"||action==="unresolved")owner.editMaintenance({...choice,action},owner.current().editSeq);}}>
              {(["keep","recheck","repair","unresolved"] as const).map(action=><option key={action} value={action} disabled={action==="repair"&&(row.protection.protected||row.mappingUnresolved)}>{t(`ai.maintenance.actions.${action}`)}</option>)}
            </select></label>
            <label><input type="checkbox" checked={choice.excluded} disabled={locked||row.protection.protected||row.mappingUnresolved}
              onChange={event=>owner.editMaintenance({...choice,excluded:event.target.checked},owner.current().editSeq)}/>{t("ai.maintenance.exclude",{name:row.nativeKey})}</label>
          </>:<p>{t(`ai.maintenance.actions.${row.suggested}`)}</p>}
        </article>;
      })}
      {draft ? <p>{t("ai.maintenance.prepareHelp",{count:draft.choices.filter(choice=>!choice.excluded&&choice.action==="repair").length})}</p>:null}
      <div className="execution-actions"><button type="button" disabled={locked||!!draft||after===0} onClick={()=>setAfter(0)}>{t("execution.firstPage")}</button>
        <button type="button" disabled={locked||!!draft||!current||current.nextOrdinal===null} onClick={()=>{if(current?.nextOrdinal!=null)setAfter(current.nextOrdinal);}}>{t("execution.nextPage")}</button>
        {onOpenManual ? <><button type="button" disabled={locked} onClick={()=>{void onOpenManual("review");}}>{t("ai.maintenance.review")}</button>
          <button type="button" disabled={locked} onClick={()=>{void onOpenManual("source");}}>{t("ai.maintenance.source")}</button></>:null}</div>
    </>:null}
  </section>;
}
