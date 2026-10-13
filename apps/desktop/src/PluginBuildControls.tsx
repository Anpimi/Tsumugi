import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { PluginPermissions } from "./PluginManager";
import { approvedPluginEnvironments, matchingPluginEnvironments, pluginEnvironmentVersion, type PluginComponentRuntime } from "./pluginEnvironments";
import { pluginCommands, readEnabledPluginPackages, type PluginBuildRequest, type PluginBuildView } from "./pluginCommands";
import { releaseCommands, type PluginBuildReview } from "./releaseCommands";
import { executionContext, type AttemptDetail } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { readCompleteAttempt } from "./executionRead";
import { reviewReasonKey } from "./reviewLabels";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { useReleaseDraftSession } from "./ReleaseDraftSession";
import { TaskCancellationFeedback, useExecutionTaskSession } from "./ExecutionTaskSession";
import { SavedPluginBuildSummary } from "./SavedPluginBuildSummary";
import { useWorkbenchCommands, type CommandAvailability, type ReleasePreparationCommandPayload, type ReleaseBuildPendingCommandPayload,
  type ReleasePluginStartCommandPayload, type ReleaseArtifactCommandPayload, type ReleaseCheckFinishCommandPayload,
  type ReleaseBuildRecordCommandPayload, type ReleaseBuildDiscardCommandPayload, type ExecutionCancellationCommandPayload,
  type ExecutionCancellationRetryCommandPayload } from "./workbenchCommands";

interface BuildChoice { key: string; label: string; package: PluginBuildRequest["package"]; resourceId: string; runtimeKinds: PluginComponentRuntime[] }
export interface PluginBuildState { busy: boolean; pending: boolean }
export interface PluginBuildHandle { allowLeave: () => Promise<boolean>; allowNavigate: () => Promise<boolean>; showSavedBuild: (attemptId: string) => boolean }
function matchesBuildScope(item: AttemptDetail["items"][number], review: PluginBuildReview | null | undefined): boolean {
  return !!review && item.scope.kind === "release-build" && item.scope.id === review.sourceSnapshotId
    && item.scope.locale !== null && review.choices.some(choice => choice.locale === item.scope.locale);
}
function BuildExecutionReview({ build, checker }: { build: PluginBuildView; checker: boolean }) {
  const { t } = useTranslation();
  const capability = checker ? build.checker : build.builder;
  return <section aria-label={t(checker ? "releasePlugin.checkReview" : "releasePlugin.buildReview")}>
    <p>{build.declaration.displayName} · {capability.provider.plugin.id} {capability.provider.plugin.version}</p>
    <p>{t(build.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeDetails" : "sourcePlugin.nativeRuntimeDetails", { version: pluginEnvironmentVersion(build.environment), system: build.environment.platform.operatingSystem, architecture: build.environment.platform.architecture })}</p>
    <PluginPermissions permissions={capability.declaration.permissions} />
    <p>{t("sourcePlugin.unsandboxed")}</p>
    <details><summary>{t("sourcePlugin.fixedDetails")}</summary><dl>
      <dt>{t("sourcePlugin.packageDigest")}</dt><dd><code>{capability.provider.packageDigest}</code></dd>
      <dt>{t("sourcePlugin.runtimeDigest")}</dt><dd><code>{build.environmentDigest}</code></dd>
      <dt>{t("sourcePlugin.profile")}</dt><dd><code>{build.declaration.profile.id}</code> ({build.declaration.profile.schemaVersion}/{build.declaration.profile.behaviorVersion})</dd>
    </dl></details>
  </section>;
}

/** Query owns current projections; the project session owns every captured build action. */
export function PluginBuildControls({ project, open, disabled, leaving = false, onState, onRecorded, onAttention, onOpenExtensions, openBlocker, ref }: {
  project: ProjectView; open: boolean; disabled: boolean; leaving?: boolean;
  onState?: (state: PluginBuildState) => void; onRecorded: (actionId: string) => Promise<void>; onAttention?: () => void;
  onOpenExtensions?: () => void;
  openBlocker?: (unitId: string, locale: string) => void; ref?: Ref<PluginBuildHandle>;
}) {
  const { t } = useTranslation(), context = executionContext(project), reads = useSessionReads(), owner = useReleaseDraftSession(), tasks = useExecutionTaskSession(), registry = useWorkbenchCommands();
  const mounted = useRef(false), errorRegion = useRef<HTMLDivElement>(null), savedErrorRegion = useRef<HTMLDivElement>(null);
  const [refresh, setRefresh] = useState(0);
  const { choiceKey, runtimeDigest, languages, names: paths, eligibility, prepared, buildConsent, attempt, savedAttempt,
    checkReview, checkConsent, checkAttempt, pending, buildReceipt: receipt, busy } = owner;
  const failure = owner.failureArea === "build" ? owner.failure : null;
  const setupOpen = open && !savedAttempt;
  // Discovery belongs to editable setup. Captured execution keeps its original
  // environment and authority; unrelated Store reads must not replace that result.
  const discovering = setupOpen && !prepared && !attempt;
  const inventoryKey = ["release-plugin-inventory",refresh];
  const inventoryRead = useSessionQuery({ key: inventoryKey, scopes: ["execution"], enabled: discovering && !busy,
    read: async () => {
      const query = reads.client.getQueryCache().find({queryKey:reads.key(inventoryKey),exact:true}), flight = query?.promise;
      const current = () => !reads.retired && !!query && query.promise === flight && query.state.fetchStatus === "fetching"
        && reads.client.getQueryCache().find({queryKey:reads.key(inventoryKey),exact:true}) === query;
      const inventory = await pluginCommands.inventory();
      if (!current()) throw new Error("Build inventory read cancelled");
      const packages = await readEnabledPluginPackages(inventory,current);
      if (!current()) throw new Error("Build inventory read cancelled");
      const choices: BuildChoice[] = packages.flatMap(item => item.manifest.contributions.flatMap(contribution =>
        contribution.contribution.kind === "resource" && contribution.contribution.schema.id === "tsumugi.build-declaration"
          && contribution.contribution.schema.schemaVersion === 1 && contribution.contribution.schema.behaviorVersion === 1
          ? [{ key: `${item.packageDigest}:${contribution.id}`, label: `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${contribution.id}`,
            package: { plugin: item.manifest.plugin,packageDigest:item.packageDigest },resourceId:contribution.id,runtimeKinds:item.manifest.components.map(component=>component.runtime) }] : []));
      return { choices,environments:approvedPluginEnvironments(inventory) };
    } });
  function fresh<T>(key: readonly unknown[]): T | undefined {
    const query = reads.client.getQueryState(reads.key(key));
    return query?.status === "success" && query.error === null && query.fetchStatus === "idle" && !query.isInvalidated ? reads.client.getQueryData<T>(reads.key(key)) : undefined;
  }
  const inventory = fresh<NonNullable<typeof inventoryRead.data>>(inventoryKey), choices = inventoryRead.data?.choices ?? [];
  const choice = choices.find(item=>item.key===choiceKey);
  const runtimes = matchingPluginEnvironments(inventoryRead.data?.environments ?? [],choice?.runtimeKinds ?? []);
  const knownEnvironment = runtimes.some(item=>item.environmentDigest===runtimeDigest);
  const environmentAvailable = !!inventory && knownEnvironment;
  const selectedBuild = owner.buildChoice;
  const environmentKey = ["release-plugin-environment",selectedBuild];
  const environmentRead = useSessionQuery({ key:environmentKey,scopes:["execution"],enabled:discovering && !busy && knownEnvironment && !!selectedBuild,
    read: async () => {
      // The application Store is exclusive. A shared invalidation may refresh
      // both observers; wait for the inventory Query rather than opening it twice.
      const environmentQuery = reads.client.getQueryCache().find({queryKey:reads.key(environmentKey),exact:true}), environmentFlight = environmentQuery?.promise;
      const inventoryQuery = reads.client.getQueryCache().find({queryKey:reads.key(inventoryKey),exact:true});
      if (inventoryQuery?.state.fetchStatus === "fetching") await inventoryQuery.promise;
      if (environmentQuery && (environmentQuery.promise !== environmentFlight || environmentQuery.state.fetchStatus !== "fetching")) throw new Error("Build environment read cancelled");
      const selection = selectedBuild;
      if (!selection) throw new Error("No build selected");
      const value = await pluginCommands.build(selection);
      if (value.resourceId !== selection.resourceId || value.environmentDigest !== selection.environmentDigest
        || [value.builder.provider,value.checker.provider].some(provider => provider.packageDigest !== selection.package.packageDigest
          || JSON.stringify(provider.plugin)!==JSON.stringify(selection.package.plugin))) throw new Error("Build environment identity changed");
      return value;
    } });
  const environment = fresh<PluginBuildView>(environmentKey);
  const capturedBuild = prepared?.review.build;
  const displayedBuild = capturedBuild ?? environment;
  const displayedChoiceKey = capturedBuild ? `${capturedBuild.builder.provider.packageDigest}:${capturedBuild.resourceId}` : choiceKey;
  const displayedRuntimeDigest = capturedBuild?.environmentDigest ?? runtimeDigest;
  const buildKey = ["release-plugin-build",attempt],checkKey = ["release-artifact-check",checkAttempt];
  const buildRead = useSessionQuery({ key:buildKey,scopes:["execution"],enabled:setupOpen && !!attempt && !busy,
    read:()=>attempt ? readCompleteAttempt(context,attempt,"locale-build") : Promise.resolve(null) });
  const checkRead = useSessionQuery({ key:checkKey,scopes:["execution"],enabled:setupOpen && !!checkAttempt && !busy,
    read:()=>checkAttempt ? readCompleteAttempt(context,checkAttempt,"artifact-semantic-check") : Promise.resolve(null) });
  const savedRead = useSessionQuery({ key:["saved-plugin-build",savedAttempt],scopes:["execution","release"],enabled:open && !!savedAttempt,
    read:()=>{if(!savedAttempt)throw new Error("No saved build selected");return releaseCommands.savedBuild({...context,attemptId:savedAttempt});} });
  const detail = buildRead.data, checkDetail = checkRead.data, checkItem = checkDetail?.items[0];
  const buildActive = !!attempt && (!detail || detail.items.some(item=>["queued","dispatched"].includes(item.status.execution)));
  const checkActive = !!checkAttempt && (!checkDetail || checkDetail.items.some(item=>["queued","dispatched"].includes(item.status.execution)));
  const locked = disabled || owner.reserved() || tasks.unresolved(), draftLocked = locked || !!prepared || !!attempt;
  const loading = inventoryRead.isFetching, environmentLoading = environmentRead.isFetching;
  const mappingLocked = disabled || !!prepared || !!attempt || !!pending && pending.kind !== "build";
  const unavailable = discovering && !busy && !loading && !environmentLoading && !inventoryRead.error && !environmentRead.error
    && (!inventory || !choice || !environmentAvailable);
  const unit = detail?.recovery.units.length === 1 ? detail.recovery.units[0] : null;
  const complete = !!prepared && !!detail && detail.items.length===prepared.review.choices.length
    && prepared.review.choices.every(choice=>detail.items.filter(item=>item.scope.locale===choice.locale).length===1)
    && detail.items.every(item=>matchesBuildScope(item,prepared.review) && item.resultId && item.status.execution==="succeeded" && item.status.validation==="valid" && !item.status.cancellationRequested);
  const canRecord = complete && !!unit?.actions.includes("adopt-result") && unit.resultIds.length===detail?.items.length && unit.resultIds.every(id=>detail?.items.some(item=>item.resultId===id));
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useLayoutEffect(()=>{
    if (!setupOpen || !inventory || owner.current().prepared || owner.current().attempt || owner.reserved()) return;
    const selected = inventory.choices.find(item=>item.key===owner.current().choiceKey) ?? (!owner.current().choiceKey ? inventory.choices[0] : undefined);
    const available = matchingPluginEnvironments(inventory.environments,selected?.runtimeKinds ?? []);
    const runtime = available.find(item=>item.environmentDigest===owner.current().runtimeDigest) ?? (!owner.current().runtimeDigest ? available[0] : undefined);
    if (selected && runtime) owner.setBuildSelection({package:selected.package,resourceId:selected.resourceId,environmentDigest:runtime.environmentDigest},selected.key,runtime.environmentDigest);
  },[setupOpen,inventory,owner.choiceKey,owner.runtimeDigest]);
  useEffect(()=>{onState?.({busy,pending:!!pending});},[busy,!!pending,onState]);
  useEffect(()=>{if(failure && open)errorRegion.current?.focus();},[failure,open]);
  useEffect(()=>{if(savedRead.error && open)savedErrorRegion.current?.focus();},[savedRead.error,open]);
  useEffect(()=>{const error=inventoryRead.error??environmentRead.error??buildRead.error??checkRead.error;if(error)owner.reportFailure(commandFailure(error));},[inventoryRead.error,environmentRead.error,buildRead.error,checkRead.error]);
  const recorded = useRef<string|null>(null);
  useEffect(()=>{if(receipt && !owner.reserved() && recorded.current!==receipt.actionId){recorded.current=receipt.actionId;void onRecorded(receipt.actionId);}},[receipt,busy,onRecorded]);
  useImperativeHandle(ref,()=>({showSavedBuild:owner.showSavedBuild,allowNavigate:()=>Promise.resolve(true),allowLeave:()=>{
    if(owner.reserved()||owner.current().buildDirty||owner.current().prepared){onAttention?.();return Promise.resolve(false);}return Promise.resolve(true);
  }}));
  const scope = {projectId:context.projectId,sessionToken:context.sessionToken,area:"release" as const};
  const no: CommandAvailability = {enabled:false,reason:"unavailable"}, same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  function gate(recovery=false):CommandAvailability {
    if(!mounted.current||!setupOpen||leaving||reads.retired||reads.context.projectId!==scope.projectId||reads.context.sessionToken!==scope.sessionToken)return {enabled:false,reason:"hidden"};
    if(owner.current().busy)return {enabled:false,reason:"busy"};
    if(disabled)return no;
    if(!recovery&&(owner.reserved()||tasks.unresolved()))return {enabled:false,reason:"pending-action"};return {enabled:true};
  }
  function proof(key:readonly unknown[]) {
    const expected=structuredClone(reads.client.getQueryData(reads.key(key))),witness=reads.watchExactQuery(key);
    return {current:()=>{const query=witness.current();return !reads.retired&&(!query||query.state.status==="success"&&query.state.error===null&&same(query.state.data,expected));},dispose:witness.dispose};
  }
  function preparationPayload():ReleasePreparationCommandPayload|undefined {
    const value=owner.current();return value.buildChoice?{kind:"release-preparation",editSeq:value.editSeq,build:structuredClone(value.buildChoice),choices:structuredClone(owner.choices()),
      sourceLocale:project.metadata.sourceLocale,targetLocales:[...project.metadata.targetLocales],eligibilityBasis:value.eligibility?.basis??null}:undefined;
  }
  function preparationAvailability(payload?:ReleasePreparationCommandPayload,prepare=false):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;const value=owner.current();
    return payload&&same(payload,preparationPayload())&&same(value.buildChoice,selectedBuild)&&!!fresh(inventoryKey)&&!!fresh(environmentKey)&&owner.available()&&owner.choices().every(choice=>choice.outputPaths.length>0)
      &&!value.prepared&&!value.attempt&&(!prepare||!!value.eligibility?.ready&&!!value.assessment&&!value.stale)?{enabled:true}:no;
  }
  function startPayload(checker=false,approved=checker?!!owner.current().checkConsent:!!owner.current().buildConsent):ReleasePluginStartCommandPayload|undefined {
    const value=owner.current(),review=checker?value.checkReview:value.prepared?.review;return review?{kind:"release-plugin-start",phase:checker?"check":"build",attemptId:review.attemptId,inputDigest:review.inputDigest,approved}:undefined;
  }
  function startAvailability(payload?:ReleasePluginStartCommandPayload,checker=false,starting=false):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;const actual=startPayload(checker,payload?.approved),value=owner.current();
    return payload&&same(payload,actual)&&!(checker?value.checkAttempt:value.attempt)&&(!starting||payload.approved&&(checker?value.checkConsent:value.buildConsent)===payload.inputDigest)?{enabled:true}:no;
  }
  function artifactPayload(resultId:string):ReleaseArtifactCommandPayload|undefined {const value=owner.current();return value.prepared&&value.attempt?{kind:"release-artifact",buildAttemptId:value.attempt,buildResultId:resultId,build:structuredClone(value.prepared.request.build)}:undefined;}
  function artifactAvailability(payload?:ReleaseArtifactCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;const value=fresh<AttemptDetail|null>(buildKey);
    return payload&&value&&same(payload,artifactPayload(payload.buildResultId))&&!owner.current().checkReview&&value.attemptId===payload.buildAttemptId
      &&value.items.some(item=>item.resultId===payload.buildResultId&&matchesBuildScope(item,owner.current().prepared?.review)
        &&item.status.execution==="succeeded"&&item.status.validation!=="valid"&&!item.status.cancellationRequested)?{enabled:true}:no;
  }
  function finishPayload():ReleaseCheckFinishCommandPayload|undefined {
    const value=owner.current(),review=value.checkReview,item=checkDetail?.items[0];return review&&value.checkAttempt&&item?.resultId?{kind:"release-check-finish",attemptId:value.checkAttempt,resultId:item.resultId,buildAttemptId:review.buildAttemptId,buildResultId:review.buildResultId,inputDigest:review.inputDigest}:undefined;
  }
  function finishAvailability(payload?:ReleaseCheckFinishCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;const value=fresh<AttemptDetail|null>(checkKey);return payload&&same(payload,finishPayload())&&value?.attemptId===payload.attemptId&&value.items.length===1
      &&value.items[0].resultId===payload.resultId&&value.items[0].status.execution==="succeeded"&&!value.items[0].status.cancellationRequested?{enabled:true}:no;
  }
  function recordPayload():ReleaseBuildRecordCommandPayload|undefined {return detail&&unit?{kind:"release-build-record",taskId:detail.taskId,attemptId:detail.attemptId,operation:"locale-build",unitId:unit.unitId,itemIds:[...unit.itemIds],resultIds:[...unit.resultIds]}:undefined;}
  function recordAvailability(payload?:ReleaseBuildRecordCommandPayload):CommandAvailability {const allowed=gate();if(!allowed.enabled)return allowed;return payload&&canRecord&&!!fresh(buildKey)&&same(payload,recordPayload())&&!owner.current().buildReceipt?{enabled:true}:no;}
  function discardPayload():ReleaseBuildDiscardCommandPayload {const value=owner.current();return {kind:"release-build-discard",editSeq:value.editSeq,preparedAttemptId:value.prepared?.review.attemptId??null,buildAttemptId:value.attempt,checkAttemptId:value.checkAttempt};}
  function discardAvailability(payload?:ReleaseBuildDiscardCommandPayload):CommandAvailability {const allowed=gate(true);if(!allowed.enabled)return allowed;const value=owner.current();return payload&&same(payload,discardPayload())&&(!value.pending||value.pending.kind==="build"&&["prepare-build","prepare-check"].includes(value.pending.intent.kind))&&!buildActive&&!checkActive?{enabled:true}:no;}
  function pendingPayload():ReleaseBuildPendingCommandPayload|undefined {const value=owner.current().pending;return value?.kind==="build"?{kind:"release-build-pending",intent:structuredClone(value.intent),editSeq:value.editSeq}:undefined;}
  function pendingAvailability(payload?:ReleaseBuildPendingCommandPayload,retry=false):CommandAvailability {const allowed=gate(true);if(!allowed.enabled)return allowed;const value=owner.current().pending;return payload&&same(payload,pendingPayload())&&(!retry||value?.kind==="build"&&value.retryAllowed&&value.intent.kind==="adopt")?{enabled:true}:no;}
  function cancelPayload(value:AttemptDetail):ExecutionCancellationCommandPayload {return {kind:"execution-cancellation",taskId:value.taskId,attemptId:value.attemptId,origin:"release"};}
  function cancelAvailability(payload?:ExecutionCancellationCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;const value=payload?.attemptId===owner.current().attempt?buildRead.data:payload?.attemptId===owner.current().checkAttempt?checkRead.data:null;
    return payload?.origin==="release"&&value&&value.taskId===payload.taskId&&value.attemptId===payload.attemptId&&(value.progress.queued>0||value.progress.running>0)&&tasks.canCancel(payload)?{enabled:true}:no;
  }
  function cancelRetryAvailability(payload?:ExecutionCancellationRetryCommandPayload):CommandAvailability {const allowed=gate(true);if(!allowed.enabled)return allowed;const value=payload&&tasks.current(payload.taskId),activity=tasks.currentActivity();return payload&&value?.phase==="unknown"&&value.target.taskId===payload.taskId&&value.target.attemptId===payload.attemptId&&value.target.origin===payload.origin&&value.request.requestId===payload.requestId&&(!activity||!["capturing","identifying","preparing","adopting","recovering","checking","unknown"].includes(activity.phase))?{enabled:true}:no;}
  useLayoutEffect(()=>{
    const meta={category:"release" as const,scope,binding:null,confirmation:"none" as const};
    const remove=[
      registry.register({...meta,id:"release.assess-build",nameKey:"release.check",risk:"captures-release",payloadKind:"release-preparation",availability:payload=>preparationAvailability(payload),handler:()=>{const view=fresh<PluginBuildView>(environmentKey);if(view)void owner.assess(view,proof(environmentKey));}}),
      registry.register({...meta,id:"release.prepare-build",nameKey:"releasePlugin.capture",risk:"captures-release",payloadKind:"release-preparation",availability:payload=>preparationAvailability(payload,true),handler:()=>{void owner.build(proof(environmentKey));}}),
      registry.register({...meta,id:"release.confirm-builder",nameKey:"releasePlugin.builderConsent",risk:"captures-release",payloadKind:"release-plugin-start",availability:payload=>startAvailability(payload),handler:payload=>owner.setConsent(false,payload.approved)}),
      registry.register({...meta,id:"release.start-build",nameKey:"release.build",risk:"runs-release-build",confirmation:"required",payloadKind:"release-plugin-start",availability:payload=>startAvailability(payload,false,true),handler:()=>{void owner.startBuild();}}),
      registry.register({...meta,id:"release.prepare-artifact-check",nameKey:"releasePlugin.checkReview",risk:"captures-release",payloadKind:"release-artifact",availability:artifactAvailability,handler:payload=>{void owner.prepareCheck(payload.buildAttemptId,payload.buildResultId,proof(buildKey));}}),
      registry.register({...meta,id:"release.confirm-checker",nameKey:"releasePlugin.checkerConsent",risk:"captures-release",payloadKind:"release-plugin-start",availability:payload=>startAvailability(payload,true),handler:payload=>owner.setConsent(true,payload.approved)}),
      registry.register({...meta,id:"release.start-artifact-check",nameKey:"releasePlugin.startCheck",risk:"runs-release-build",confirmation:"required",payloadKind:"release-plugin-start",availability:payload=>startAvailability(payload,true,true),handler:()=>{void owner.startBuild(true);}}),
      registry.register({...meta,id:"release.finish-artifact-check",nameKey:"releasePlugin.recordCheck",risk:"writes-execution",payloadKind:"release-check-finish",availability:finishAvailability,handler:payload=>{void owner.finishCheck(payload.resultId,proof(checkKey));}}),
      registry.register({...meta,id:"release.record-build",nameKey:"releasePlugin.recordRelease",risk:"writes-execution",payloadKind:"release-build-record",availability:recordAvailability,handler:()=>{if(detail)void owner.recordBuild(detail,proof(buildKey));}}),
      registry.register({...meta,id:"release.discard-build",nameKey:"releasePlugin.discard",risk:"captures-release",payloadKind:"release-build-discard",availability:discardAvailability,handler:()=>{void owner.discardBuild();}}),
      registry.register({...meta,id:"release.check-build",nameKey:"releasePlugin.reconcile",risk:"reconciles-release",payloadKind:"release-build-pending",availability:payload=>pendingAvailability(payload),handler:()=>{void owner.checkBuild();}}),
      registry.register({...meta,id:"release.retry-build",nameKey:"execution.retryAdoption",risk:"retries-execution-action",payloadKind:"release-build-pending",availability:payload=>pendingAvailability(payload,true),handler:()=>{void owner.retryBuild();}}),
      registry.register({...meta,id:"release.cancel-task",nameKey:"execution.cancel",risk:"cancels-execution-task",payloadKind:"execution-cancellation",availability:cancelAvailability,handler:payload=>{void tasks.cancel(payload);}}),
      registry.register({...meta,id:"release.retry-cancellation",nameKey:"execution.retryCancellation",risk:"retries-execution-action",payloadKind:"execution-cancellation-retry",availability:cancelRetryAvailability,handler:payload=>{void tasks.retry(payload.taskId);}}),
    ];return()=>remove.forEach(dispose=>dispose());
  });
  return <>
    <TaskCancellationFeedback origin="release" taskId={detail?.taskId} disabled={busy} visible={open} retryCommand={{available:intent=>cancelRetryAvailability({...intent,kind:"execution-cancellation-retry"}).enabled,dispatch:intent=>{registry.dispatch("release.retry-cancellation",scope,{...intent,kind:"execution-cancellation-retry"});}}}/>
    {savedAttempt?<section aria-label={t("releasePlugin.savedView")} aria-busy={savedRead.isFetching}>
      {savedRead.isFetching?<p role="status">{t("execution.loading")}</p>:null}
      {savedRead.error?<div role="alert" ref={savedErrorRegion} tabIndex={-1}><p>{t("releasePlugin.savedReadFailed")}</p><CommandFailureDetails failure={commandFailure(savedRead.error)}/></div>:null}
      {!savedRead.error&&savedRead.data?.attemptId===savedAttempt?<SavedPluginBuildSummary build={savedRead.data}/>:null}
      <div className="execution-actions"><button className="secondary-button" disabled={savedRead.isFetching} onClick={()=>void savedRead.refetch()}>{t("releasePlugin.savedRefresh")}</button><button className="text-button" onClick={owner.closeSavedBuild}>{t("releasePlugin.savedBack")}</button></div>
    </section>:null}
    <section hidden={!!savedAttempt} aria-label={t("release.prepare")} aria-busy={busy||loading||environmentLoading}>
      <h3>{t("release.prepare")}</h3><p>{t("release.scope")}</p>
      {failure?<div ref={errorRegion} role="alert" tabIndex={-1}><p>{t("releasePlugin.failed")}</p><CommandFailureDetails failure={failure}/></div>:null}
      {busy||loading||environmentLoading?<p role="status">{t("execution.working")}</p>:null}
      <label className="source-field">{t(capturedBuild?"releasePlugin.capturedBuilder":"releasePlugin.builder")}<select value={displayedChoiceKey} disabled={draftLocked||loading||environmentLoading} onChange={event=>{const selected=choices.find(item=>item.key===event.target.value);if(!selected)return;const matching=matchingPluginEnvironments(inventoryRead.data?.environments??[],selected.runtimeKinds),runtime=matching.find(item=>item.environmentDigest===runtimeDigest)??matching[0];owner.setBuildSelection(runtime?{package:selected.package,resourceId:selected.resourceId,environmentDigest:runtime.environmentDigest}:null,selected.key,runtime?.environmentDigest??"");}}>
        {capturedBuild?<option value={displayedChoiceKey}>{capturedBuild.declaration.displayName} · {capturedBuild.builder.provider.plugin.id} {capturedBuild.builder.provider.plugin.version}</option>:<>{!choice?<option value={choiceKey}>{t("releasePlugin.chooseBuilder")}</option>:null}{choices.map(item=><option key={item.key} value={item.key}>{item.label}</option>)}</>}
      </select></label>
      <label className="source-field">{t(capturedBuild?"releasePlugin.capturedRuntime":"sourcePlugin.runtime")}<select value={displayedRuntimeDigest} disabled={draftLocked||loading||environmentLoading} onChange={event=>owner.setBuildSelection(choice?{package:choice.package,resourceId:choice.resourceId,environmentDigest:event.target.value}:null,choiceKey,event.target.value)}>
        {capturedBuild?<option value={displayedRuntimeDigest}>{t(capturedBuild.environment.profile==="node-system-libraries-v1"?"sourcePlugin.runtimeOption":"sourcePlugin.nativeRuntimeOption",{version:pluginEnvironmentVersion(capturedBuild.environment),system:capturedBuild.environment.platform.operatingSystem,architecture:capturedBuild.environment.platform.architecture})}</option>:<>{!environmentAvailable?<option value={runtimeDigest}>{t("sourcePlugin.chooseRuntime")}</option>:null}{runtimes.map(item=><option key={item.environmentDigest} value={item.environmentDigest}>{t(item.environment.profile==="node-system-libraries-v1"?"sourcePlugin.runtimeOption":"sourcePlugin.nativeRuntimeOption",{version:pluginEnvironmentVersion(item.environment),system:item.environment.platform.operatingSystem,architecture:item.environment.platform.architecture})}</option>)}</>}
      </select></label>
      <button className="secondary-button" disabled={draftLocked||loading||environmentLoading} onClick={()=>{owner.reportFailure(null);setRefresh(value=>value+1);}}>{t("releasePlugin.refresh")}</button>
      {unavailable?<><p role="status">{t("releasePlugin.unavailable")}</p>{onOpenExtensions?<button className="text-button" disabled={locked||leaving||reads.retired} onClick={onOpenExtensions}>{t("plugins.open")}</button>:null}</>:null}
      {displayedBuild?<p>{t("releasePlugin.limits",{name:displayedBuild.declaration.displayName,count:displayedBuild.declaration.outputLimits.maxArtifacts,bytes:String(displayedBuild.declaration.outputLimits.maxTotalBytes)})}</p>:null}
      <fieldset><legend>{t("release.languages")}</legend>{project.metadata.targetLocales.map(locale=><label key={locale} className="release-locale"><input type="checkbox" checked={languages.includes(locale)} disabled={mappingLocked} onChange={event=>owner.setLanguage(locale,event.target.checked)}/>{locale}</label>)}</fieldset>
      {languages.map(locale=><label className="source-field" key={locale}>{t("releasePlugin.paths",{locale})}<textarea value={paths[locale]??""} disabled={mappingLocked} onChange={event=>owner.setName(locale,event.target.value)}/></label>)}
      {languages.filter(locale=>!project.metadata.targetLocales.includes(locale)).map(locale=><p role="status" key={locale}>{t("release.removedLocale",{locale})}<button disabled={locked} onClick={()=>owner.setLanguage(locale,false)}>{t("release.removeLocale",{locale})}</button></p>)}
      {owner.stale?<p role="status">{t("release.readinessStale")}</p>:null}<p>{t("releasePlugin.pathHelp")}</p><p>{t("release.policy")}</p>
      <div className="form-actions"><button className="secondary-button" disabled={!preparationAvailability(preparationPayload()).enabled} onClick={()=>{const payload=preparationPayload();if(payload)registry.dispatch("release.assess-build",scope,payload);}}>{t("release.check")}</button><button className="primary-button" disabled={!preparationAvailability(preparationPayload(),true).enabled} onClick={()=>{const payload=preparationPayload();if(payload)registry.dispatch("release.prepare-build",scope,payload);}}>{t("releasePlugin.capture")}</button></div>
      {eligibility?<div role="status"><p>{t(eligibility.ready?"release.ready":"release.blocked",{count:eligibility.locales.reduce((sum,item)=>sum+item.blockerCount,0)})}</p><p>{t("release.source",{id:eligibility.sourceSnapshotId})} · {eligibility.policyVersion}</p>{eligibility.locales.map(item=><div key={item.locale}><strong>{item.locale}</strong>: {t("release.coverage",{count:item.checkedUnits})}{item.blockers.map((reason,index)=><div className="release-blocker" key={`${reason.unitId}:${index}`}>{reason.nativeKey}: {t(reviewReasonKey(reason.code))}{openBlocker?<button className="text-button" disabled={locked} onClick={()=>openBlocker(reason.unitId,item.locale)}>{t("translation.openEditor")}</button>:null}</div>)}{item.exceptions.map((reason,index)=><p key={index}>{t("release.exception",{key:reason.nativeKey,reason:reason.code})}</p>)}</div>)}</div>:null}
      {prepared&&!attempt&&owner.earlierBuild?<p role="status">{t("release.earlierPreparation")}</p>:null}
      {prepared?<><h4>{t("releasePlugin.fixedBuild")}</h4><p>{t("release.source",{id:prepared.review.sourceSnapshotId})}</p><ul>{prepared.review.choices.map(({locale,outputPaths})=><li key={locale}>{locale}<ul>{outputPaths.map(path=><li key={path}>{path}</li>)}</ul></li>)}</ul>{!attempt?<><BuildExecutionReview build={prepared.review.build} checker={false}/><label className="source-check"><input type="checkbox" checked={buildConsent===prepared.review.inputDigest} disabled={!startAvailability(startPayload()).enabled} onChange={event=>{const payload=startPayload(false,event.target.checked);if(payload)registry.dispatch("release.confirm-builder",scope,payload);}}/>{t("releasePlugin.builderConsent")}</label><button className="primary-button" disabled={!startAvailability(startPayload(),false,true).enabled} onClick={()=>{const payload=startPayload();if(payload)registry.dispatch("release.start-build",scope,payload);}}>{t("release.build")}</button><button className="text-button" disabled={!discardAvailability(discardPayload()).enabled} onClick={()=>registry.dispatch("release.discard-build",scope,discardPayload())}>{t("releasePlugin.discard")}</button></>:null}</>:null}
      {attempt?<section aria-label={t("releasePlugin.results")}><h4>{t("releasePlugin.results")}</h4><p>{t("release.started",{id:attempt})}</p>{owner.earlierBuild?<p role="status">{t("release.earlierBuild")}</p>:null}{detail?<ul>{detail.items.map(item=><li key={item.status.itemId}>{item.scope.locale} · {t(`execution.states.${item.status.execution}`)} · {t(`releasePlugin.validation.${item.status.validation}`)}{item.status.cancellationRequested?<p>{t("releasePlugin.cancelled")}</p>:null}{item.status.diagnostic?<details><summary>{t("execution.diagnostic")}</summary>{item.status.diagnostic}</details>:null}{item.resultId&&item.scope.locale!==null&&matchesBuildScope(item,prepared?.review)&&item.status.execution==="succeeded"&&item.status.validation!=="valid"&&!item.status.cancellationRequested?<button className="secondary-button" disabled={!artifactAvailability(artifactPayload(item.resultId)).enabled} onClick={()=>{const payload=artifactPayload(item.resultId!);if(payload)registry.dispatch("release.prepare-artifact-check",scope,payload);}}>{t("releasePlugin.prepareCheck",{locale:item.scope.locale})}</button>:null}</li>)}</ul>:<p role="status">{t("releasePlugin.waiting")}</p>}<button className="secondary-button" disabled={busy||buildRead.isFetching} onClick={()=>void buildRead.refetch()}>{t("execution.refresh")}</button>{detail&&buildActive?<><p>{t("execution.cancelHelp")}</p><button className="secondary-button" disabled={!cancelAvailability(cancelPayload(detail)).enabled} onClick={()=>registry.dispatch("release.cancel-task",scope,cancelPayload(detail))}>{t("execution.cancel")}</button></>:null}</section>:null}
      {checkReview?<section aria-label={t("releasePlugin.artifacts")}><h4>{t("releasePlugin.checkLocale",{locale:checkReview.locale})}</h4><ul>{checkReview.artifacts.map(file=><li key={`${file.id}:${file.logicalPath}`}>{file.logicalPath} · {t("releasePlugin.bytes",{count:file.byteLength})}<details><summary>{t("source.fingerprint")}</summary><code>{file.sha256}</code></details></li>)}</ul><p>{t("releasePlugin.rules",{count:checkReview.requirements.length})}</p>{!checkAttempt?<><BuildExecutionReview build={checkReview.build} checker/><label className="source-check"><input type="checkbox" checked={checkConsent===checkReview.inputDigest} disabled={!startAvailability(startPayload(true),true).enabled} onChange={event=>{const payload=startPayload(true,event.target.checked);if(payload)registry.dispatch("release.confirm-checker",scope,payload);}}/>{t("releasePlugin.checkerConsent")}</label><button className="primary-button" disabled={!startAvailability(startPayload(true),true,true).enabled} onClick={()=>{const payload=startPayload(true);if(payload)registry.dispatch("release.start-artifact-check",scope,payload);}}>{t("releasePlugin.startCheck")}</button></>:<><p role="status">{t(checkItem?.status.execution==="succeeded"?"releasePlugin.checkReceived":checkActive?"releasePlugin.checkRunning":"releasePlugin.checkFailed")}</p>{checkItem?.resultId&&checkItem.status.execution==="succeeded"&&!checkItem.status.cancellationRequested?<button className="primary-button" disabled={!finishAvailability(finishPayload()).enabled} onClick={()=>{const payload=finishPayload();if(payload)registry.dispatch("release.finish-artifact-check",scope,payload);}}>{t("releasePlugin.recordCheck")}</button>:null}<button className="secondary-button" disabled={busy||checkRead.isFetching} onClick={()=>void checkRead.refetch()}>{t("execution.refresh")}</button>{checkDetail&&checkActive?<button className="secondary-button" disabled={!cancelAvailability(cancelPayload(checkDetail)).enabled} onClick={()=>registry.dispatch("release.cancel-task",scope,cancelPayload(checkDetail))}>{t("execution.cancel")}</button>:null}</>}</section>:null}
      {canRecord&&!receipt?<><p role="status">{t("releasePlugin.allChecked")}</p><button className="primary-button" disabled={!recordAvailability(recordPayload()).enabled} onClick={()=>{const payload=recordPayload();if(payload)registry.dispatch("release.record-build",scope,payload);}}>{t("releasePlugin.recordRelease")}</button></>:null}{receipt?<p role="status">{t("releasePlugin.recorded")}</p>:null}
      {attempt&&!buildActive&&!checkActive?<button className="secondary-button" disabled={!discardAvailability(discardPayload()).enabled} onClick={()=>registry.dispatch("release.discard-build",scope,discardPayload())}>{t("releasePlugin.newBuild")}</button>:null}
      {pending?.kind==="build"&&!busy?<section role="status"><p>{t("releasePlugin.unknown")}</p><button className="secondary-button" disabled={!pendingAvailability(pendingPayload()).enabled} onClick={()=>{const payload=pendingPayload();if(payload)registry.dispatch("release.check-build",scope,payload);}}>{t("releasePlugin.reconcile")}</button>{pending.intent.kind==="adopt"&&pending.retryAllowed?<><p>{t("execution.noReceipt")}</p><button className="secondary-button" disabled={!pendingAvailability(pendingPayload(),true).enabled} onClick={()=>{const payload=pendingPayload();if(payload)registry.dispatch("release.retry-build",scope,payload);}}>{t("execution.retryAdoption")}</button></>:null}{["prepare-build","prepare-check"].includes(pending.intent.kind)?<button className="secondary-button" disabled={!discardAvailability(discardPayload()).enabled} onClick={()=>registry.dispatch("release.discard-build",scope,discardPayload())}>{t("releasePlugin.discard")}</button>:null}</section>:null}
    </section>
  </>;
}
