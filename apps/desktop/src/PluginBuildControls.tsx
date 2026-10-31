import { useEffect, useLayoutEffect, useRef, useState, useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { BuildExecutionReview } from "./BuildExecutionReview";
import { ArtifactCheckWorkflowControls } from "./ArtifactCheckWorkflowControls";
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
import { Button } from "./design-system/Button";
import { Field, TextArea } from "./design-system/Field";
import { Banner } from "./design-system/Feedback";
import styles from "./PluginBuildControls.module.css";
import { useWorkbenchCommands, type CommandAvailability, type ReleasePreparationCommandPayload, type ReleaseBuildPendingCommandPayload,
  type ReleasePluginStartCommandPayload, type ReleaseArtifactCommandPayload, type ReleaseCheckFinishCommandPayload,
  type ReleaseBuildRecordCommandPayload, type ReleaseBuildDiscardCommandPayload, type ExecutionCancellationCommandPayload,
  type ExecutionCancellationRetryCommandPayload } from "./workbenchCommands";

interface BuildChoice { key: string; label: string; package: PluginBuildRequest["package"]; resourceId: string; runtimeKinds: PluginComponentRuntime[] }
export interface BuildWorkbenchAction { step: "readiness" | "build" | "verification"; label: string; enabled: boolean; run: () => void }
export interface BuildWorkbenchParts {
  settings: ReactNode; readiness: ReactNode; build: ReactNode; verification: ReactNode; feedback: ReactNode; recovery: ReactNode; saved: ReactNode;
  primary: BuildWorkbenchAction | null;
  status: { buildActive: boolean; checkActive: boolean; outputReceived: boolean; complete: boolean; failed: boolean; unknown: boolean; readFailed: boolean };
}
function matchesBuildScope(item: AttemptDetail["items"][number], review: PluginBuildReview | null | undefined): boolean {
  return !!review && item.scope.kind === "release-build" && item.scope.id === review.sourceSnapshotId
    && item.scope.locale !== null && review.choices.some(choice => choice.locale === item.scope.locale);
}

/** Query owns current projections; the project session owns every captured build action. */
export function PluginBuildControls({ project, open, disabled, onRecorded, onOpenExtensions, openBlocker, renderWorkbench, canInteract }: {
  project: ProjectView; open: boolean; disabled: boolean;
  onRecorded: (actionId: string) => Promise<void>;
  onOpenExtensions?: () => void;
  renderWorkbench: (parts: BuildWorkbenchParts) => ReactNode;
  canInteract?: (kind?: "action" | "input") => boolean;
  openBlocker?: (unitId: string, locale: string) => void;
}) {
  const { t } = useTranslation(), context = executionContext(project), reads = useSessionReads(), owner = useReleaseDraftSession(), tasks = useExecutionTaskSession(), registry = useWorkbenchCommands();
  const mounted = useRef(false), errorRegion = useRef<HTMLDivElement>(null), savedErrorRegion = useRef<HTMLDivElement>(null);
  const [refresh, setRefresh] = useState(0);
  const pathsHelpId = useId();
  const composing = useRef(false);
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
  useEffect(() => { if (!open) composing.current = false; }, [open]);
  useEffect(()=>{if(failure && open)errorRegion.current?.focus();},[failure,open]);
  useEffect(()=>{if(savedRead.error && open)savedErrorRegion.current?.focus();},[savedRead.error,open]);
  useEffect(()=>{const error=inventoryRead.error??environmentRead.error??buildRead.error??checkRead.error;if(error)owner.reportFailure(commandFailure(error));},[inventoryRead.error,environmentRead.error,buildRead.error,checkRead.error]);
  const recorded = useRef<string|null>(null);
  useEffect(()=>{if(receipt && !owner.reserved() && recorded.current!==receipt.actionId){recorded.current=receipt.actionId;void onRecorded(receipt.actionId);}},[receipt,busy,onRecorded]);
  const scope = {projectId:context.projectId,sessionToken:context.sessionToken,area:"release" as const};
  const no: CommandAvailability = {enabled:false,reason:"unavailable"}, same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  function gate(recovery=false):CommandAvailability {
    if(!mounted.current||!setupOpen||canInteract?.()===false||reads.retired||reads.context.projectId!==scope.projectId||reads.context.sessionToken!==scope.sessionToken)return {enabled:false,reason:"hidden"};
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
    return payload&&value&&same(payload,artifactPayload(payload.buildResultId))&&!owner.current().checkReview&&!owner.current().workflow&&value.attemptId===payload.buildAttemptId
      &&value.items.some(item=>item.resultId===payload.buildResultId&&matchesBuildScope(item,owner.current().prepared?.review)
        &&item.status.execution==="succeeded"&&item.status.validation!=="valid"&&!item.status.cancellationRequested)?{enabled:true}:no;
  }
  function finishPayload():ReleaseCheckFinishCommandPayload|undefined {
    const value=owner.current(),review=value.checkReview,item=checkDetail?.items[0];return review&&value.checkAttempt&&item?.resultId?{kind:"release-check-finish",attemptId:value.checkAttempt,resultId:item.resultId,buildAttemptId:review.buildAttemptId,buildResultId:review.buildResultId,inputDigest:review.inputDigest}:undefined;
  }
  function finishAvailability(payload?:ReleaseCheckFinishCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;const value=fresh<AttemptDetail|null>(checkKey);return !owner.current().workflow&&payload&&same(payload,finishPayload())&&value?.attemptId===payload.attemptId&&value.items.length===1
      &&value.items[0].resultId===payload.resultId&&value.items[0].status.execution==="succeeded"&&!value.items[0].status.cancellationRequested?{enabled:true}:no;
  }
  function recordPayload():ReleaseBuildRecordCommandPayload|undefined {return detail&&unit?{kind:"release-build-record",taskId:detail.taskId,attemptId:detail.attemptId,operation:"locale-build",unitId:unit.unitId,itemIds:[...unit.itemIds],resultIds:[...unit.resultIds]}:undefined;}
  function recordAvailability(payload?:ReleaseBuildRecordCommandPayload):CommandAvailability {const allowed=gate();if(!allowed.enabled)return allowed;return payload&&canRecord&&!!fresh(buildKey)&&same(payload,recordPayload())&&!owner.current().buildReceipt?{enabled:true}:no;}
  function discardPayload():ReleaseBuildDiscardCommandPayload {const value=owner.current();return {kind:"release-build-discard",editSeq:value.editSeq,preparedAttemptId:value.prepared?.review.attemptId??null,buildAttemptId:value.attempt,checkAttemptId:value.checkAttempt};}
  function discardAvailability(payload?:ReleaseBuildDiscardCommandPayload):CommandAvailability {const allowed=gate(true);if(!allowed.enabled)return allowed;const value=owner.current();return payload&&same(payload,discardPayload())&&(!value.workflow||!value.workflow.pending&&!value.workflow.stopPending&&!value.workflowControlBusy&&value.workflow.safety?.admissionClosed&&value.workflow.safety.callbacksDrained)&&(!value.pending||value.pending.kind==="build"&&["prepare-build","prepare-check"].includes(value.pending.intent.kind))&&!buildActive&&!checkActive?{enabled:true}:no;}
  function pendingPayload():ReleaseBuildPendingCommandPayload|undefined {const value=owner.current().pending;return value?.kind==="build"?{kind:"release-build-pending",intent:structuredClone(value.intent),editSeq:value.editSeq}:undefined;}
  function pendingAvailability(payload?:ReleaseBuildPendingCommandPayload,retry=false):CommandAvailability {const allowed=gate(true);if(!allowed.enabled)return allowed;const value=owner.current().pending;return payload&&same(payload,pendingPayload())&&(!retry||value?.kind==="build"&&value.retryAllowed&&["adopt","start-build","start-check"].includes(value.intent.kind))?{enabled:true}:no;}
  function cancelPayload(value:AttemptDetail):ExecutionCancellationCommandPayload {return {kind:"execution-cancellation",taskId:value.taskId,attemptId:value.attemptId,origin:"release"};}
  function cancelAvailability(payload?:ExecutionCancellationCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;const value=payload?.attemptId===owner.current().attempt?buildRead.data:payload?.attemptId===owner.current().checkAttempt?checkRead.data:null;
    return payload?.origin==="release"&&value&&value.taskId===payload.taskId&&value.attemptId===payload.attemptId&&(value.progress.queued>0||value.progress.running>0)&&tasks.canCancel(payload)?{enabled:true}:no;
  }
  function cancelRetryAvailability(payload?:ExecutionCancellationRetryCommandPayload,retry=true):CommandAvailability {const allowed=gate(true);if(!allowed.enabled)return allowed;const value=payload&&tasks.current(payload.taskId),activity=tasks.currentActivity();return payload&&value?.phase==="unknown"&&(!retry||value.retryAllowed)&&value.target.taskId===payload.taskId&&value.target.attemptId===payload.attemptId&&value.target.origin===payload.origin&&value.request.requestId===payload.requestId&&(!activity||!["capturing","identifying","preparing","adopting","recovering","checking","unknown"].includes(activity.phase))?{enabled:true}:no;}
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
      registry.register({...meta,id:"release.retry-build",nameKey:"sourcePlugin.retryOriginal",risk:"retries-execution-action",payloadKind:"release-build-pending",availability:payload=>pendingAvailability(payload,true),handler:()=>{void owner.retryBuild();}}),
      registry.register({...meta,id:"release.cancel-task",nameKey:"execution.cancel",risk:"cancels-execution-task",payloadKind:"execution-cancellation",availability:cancelAvailability,handler:payload=>{void tasks.cancel(payload);}}),
      registry.register({...meta,id:"release.retry-cancellation",nameKey:"execution.retryCancellation",risk:"retries-execution-action",payloadKind:"execution-cancellation-retry",availability:cancelRetryAvailability,handler:payload=>{void tasks.retry(payload.taskId);}}),
      registry.register({...meta,id:"release.check-cancellation",nameKey:"execution.checkCancellation",risk:"reads-execution",payloadKind:"execution-cancellation-retry",availability:payload=>cancelRetryAvailability(payload,false),handler:payload=>{void tasks.checkCancellation(payload.taskId);}}),
    ];return()=>remove.forEach(dispose=>dispose());
  });
  function mainAction(): BuildWorkbenchAction {
    const action = (step: BuildWorkbenchAction["step"], key: "check" | "prepare" | "startBuild" | "verify" | "saveBuild" | "checkResult", enabled: boolean, run: () => void): BuildWorkbenchAction => ({ step, label: t(`deliveryWorkbench.${key}`), enabled, run });
    if (pending?.kind === "build" && pending.uncertain) return action("build", "checkResult", pendingAvailability(pendingPayload()).enabled, () => { const payload = pendingPayload(); if (payload) registry.dispatch("release.check-build", scope, payload); });
    if (canRecord && !receipt) return action("verification", "saveBuild", recordAvailability(recordPayload()).enabled, () => { const payload = recordPayload(); if (payload) registry.dispatch("release.record-build", scope, payload); });
    if (owner.workflow) {
      const workflow = owner.workflow;
      const payload = { kind: "release-workflow" as const, identity: structuredClone(workflow.request.preparation.identity), materializationDigest: workflow.review?.materializationDigest ?? null, approvedAttemptIds: [...workflow.approved] };
      const command = !workflow.start && !workflow.stop && workflow.review?.phase === "prepared" ? "release.run-check-workflow" : "release.check-check-workflow";
      const available = registry.describe(command, scope, payload)?.availability.enabled ?? false;
      return action("verification", command === "release.run-check-workflow" ? "verify" : "checkResult", available, () => { registry.dispatch(command, scope, payload); });
    }
    if (checkReview && !checkAttempt) return action("verification", "verify", startAvailability(startPayload(true), true, true).enabled, () => { const payload = startPayload(true); if (payload) registry.dispatch("release.start-artifact-check", scope, payload); });
    if (checkReview && checkAttempt && checkItem?.resultId && checkItem.status.execution === "succeeded") return action("verification", "verify", finishAvailability(finishPayload()).enabled, () => { const payload = finishPayload(); if (payload) registry.dispatch("release.finish-artifact-check", scope, payload); });
    if (attempt) {
      const item = detail?.items.find(value => value.resultId && value.scope.locale !== null && matchesBuildScope(value, prepared?.review) && value.status.execution === "succeeded" && value.status.validation !== "valid" && !value.status.cancellationRequested);
      if (item?.resultId) return action("verification", "verify", artifactAvailability(artifactPayload(item.resultId)).enabled, () => { const payload = item.resultId ? artifactPayload(item.resultId) : undefined; if (payload) registry.dispatch("release.prepare-artifact-check", scope, payload); });
      return action("build", "checkResult", open && !disabled && canInteract?.() !== false && !busy && !buildRead.isFetching && !reads.retired, () => { if (open && canInteract?.() !== false && !reads.retired) void buildRead.refetch(); });
    }
    if (prepared) return action("build", "startBuild", startAvailability(startPayload(), false, true).enabled, () => { const payload = startPayload(); if (payload) registry.dispatch("release.start-build", scope, payload); });
    if (eligibility?.ready && !owner.stale) return action("build", "prepare", preparationAvailability(preparationPayload(), true).enabled, () => { const payload = preparationPayload(); if (payload) registry.dispatch("release.prepare-build", scope, payload); });
    return action("readiness", "check", preparationAvailability(preparationPayload()).enabled, () => { const payload = preparationPayload(); if (payload) registry.dispatch("release.assess-build", scope, payload); });
  }
  const savedContent = <>
    {savedAttempt ? <section className={styles.section} aria-label={t("releasePlugin.savedView")} aria-busy={savedRead.isFetching}>
      {savedRead.isFetching ? <Banner role="status">{t("execution.loading")}</Banner> : null}
      {savedRead.error ? <Banner tone="error" role="alert" ref={savedErrorRegion} tabIndex={-1}>
        <p>{t("releasePlugin.savedReadFailed")}</p><CommandFailureDetails failure={commandFailure(savedRead.error)}/>
      </Banner> : null}
      {!savedRead.error && savedRead.data?.attemptId === savedAttempt ? <SavedPluginBuildSummary build={savedRead.data}/> : null}
      <div className={styles.actions}>
        <Button variant="secondary" disabled={savedRead.isFetching} onClick={() => void savedRead.refetch()}>{t("releasePlugin.savedRefresh")}</Button>
        <Button variant="link" onClick={() => { if (canInteract?.() !== false) owner.closeSavedBuild(); }}>{t("releasePlugin.savedBack")}</Button>
      </div>
    </section> : null}
  </>;
  const feedbackContent = <>
    <TaskCancellationFeedback origin="release" taskId={detail?.taskId} disabled={busy} visible={open} retryCommand={{available:intent=>cancelRetryAvailability({...intent,kind:"execution-cancellation-retry"}).enabled,dispatch:intent=>{registry.dispatch("release.retry-cancellation",scope,{...intent,kind:"execution-cancellation-retry"});}}} checkCommand={{available:intent=>cancelRetryAvailability({...intent,kind:"execution-cancellation-retry"},false).enabled,dispatch:intent=>{registry.dispatch("release.check-cancellation",scope,{...intent,kind:"execution-cancellation-retry"});}}}/>
      {failure ? <Banner tone={pending?.kind === "build" && pending.uncertain ? "warning" : "error"} ref={errorRegion} role="alert" tabIndex={-1}>
        <p>{t("releasePlugin.failed")}</p><CommandFailureDetails failure={failure}/>
      </Banner> : null}
      {busy || loading || environmentLoading ? <Banner role="status">{t("execution.working")}</Banner> : null}
  </>;
  const settingsContent = <>
      <div className={styles.environmentFields}>
        <Field label={t("deliveryWorkbench.builder")}>
          <select className={styles.select} value={displayedChoiceKey} disabled={draftLocked || loading || environmentLoading} onChange={event => {
            if (draftLocked || loading || environmentLoading || canInteract?.("input") === false) return;
            const selected = choices.find(item => item.key === event.target.value);
            if (!selected) return;
            const matching = matchingPluginEnvironments(inventoryRead.data?.environments ?? [], selected.runtimeKinds);
            const runtime = matching.find(item => item.environmentDigest === runtimeDigest) ?? matching[0];
            owner.setBuildSelection(runtime ? { package: selected.package, resourceId: selected.resourceId, environmentDigest: runtime.environmentDigest } : null, selected.key, runtime?.environmentDigest ?? "");
          }}>
            {capturedBuild ? <option value={displayedChoiceKey}>{capturedBuild.declaration.displayName} · {capturedBuild.builder.provider.plugin.id} {capturedBuild.builder.provider.plugin.version}</option> : <>
              {!choice ? <option value={choiceKey}>{t("releasePlugin.chooseBuilder")}</option> : null}
              {choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
            </>}
          </select>
        </Field>
        <Field label={t("deliveryWorkbench.runtime")}>
          <select className={styles.select} value={displayedRuntimeDigest} disabled={draftLocked || loading || environmentLoading} onChange={event => { if (!draftLocked && !loading && !environmentLoading && canInteract?.("input") !== false) owner.setBuildSelection(choice ? { package: choice.package, resourceId: choice.resourceId, environmentDigest: event.target.value } : null, choiceKey, event.target.value); }}>
            {capturedBuild ? <option value={displayedRuntimeDigest}>{t(capturedBuild.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption", { version: pluginEnvironmentVersion(capturedBuild.environment), system: capturedBuild.environment.platform.operatingSystem, architecture: capturedBuild.environment.platform.architecture })}</option> : <>
              {!environmentAvailable ? <option value={runtimeDigest}>{t("sourcePlugin.chooseRuntime")}</option> : null}
              {runtimes.map(item => <option key={item.environmentDigest} value={item.environmentDigest}>{t(item.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption", { version: pluginEnvironmentVersion(item.environment), system: item.environment.platform.operatingSystem, architecture: item.environment.platform.architecture })}</option>)}
            </>}
          </select>
        </Field>
      </div>
      <div className={styles.actions}><Button variant="secondary" disabled={draftLocked || loading || environmentLoading} onClick={() => { if (draftLocked || loading || environmentLoading || canInteract?.() === false) return; owner.reportFailure(null); setRefresh(value => value + 1); }}>{t("releasePlugin.refresh")}</Button></div>
      {unavailable ? <Banner tone="warning" role="status" action={onOpenExtensions ? <Button variant="link" disabled={locked || reads.retired} onClick={onOpenExtensions}>{t("plugins.open")}</Button> : null}>{t("releasePlugin.unavailable")}</Banner> : null}
      <fieldset className={styles.languages}>
        <legend>{t("release.languages")}</legend>
        {project.metadata.targetLocales.map(locale => <Field key={locale} label={locale} className={styles.checkbox}>
          <input type="checkbox" checked={languages.includes(locale)} disabled={mappingLocked} onChange={event => { if (!mappingLocked && canInteract?.("input") !== false) owner.setLanguage(locale, event.target.checked); }}/>
        </Field>)}
      </fieldset>
      <p id={pathsHelpId} className={styles.help}>{t("releasePlugin.pathHelp")}</p>
      <div className={styles.paths}>
        {languages.map(locale => <Field key={locale} label={t("releasePlugin.paths", { locale })}>
          <TextArea value={paths[locale] ?? ""} aria-describedby={pathsHelpId} disabled={mappingLocked} onChange={event => { if (!mappingLocked && canInteract?.("input") !== false) owner.setName(locale, event.target.value); }}/>
        </Field>)}
      </div>
      {languages.filter(locale => !project.metadata.targetLocales.includes(locale)).map(locale => <Banner tone="warning" role="status" key={locale} action={<Button variant="secondary" disabled={locked} onClick={() => { if (!locked && canInteract?.("input") !== false) owner.setLanguage(locale, false); }}>{t("release.removeLocale", { locale })}</Button>}>{t("release.removedLocale", { locale })}</Banner>)}
      {owner.stale ? <Banner tone="warning" role="status">{t("release.readinessStale")}</Banner> : null}
  </>;
  const readinessContent = <>
      {eligibility ? <section className={styles.readiness} aria-label={t("release.readiness")}>
        <Banner tone={eligibility.ready ? "success" : "warning"} role="status">{t(eligibility.ready ? "release.ready" : "release.blocked", {
          count: eligibility.locales.reduce((sum, item) => sum + (eligibility.ready ? item.exceptionCount : item.blockerCount), 0),
        })}</Banner>
        <details className={styles.evidence}><summary>{t("deliveryWorkbench.diagnostics")}</summary><p>{t("release.source", { id: eligibility.sourceSnapshotId })} · {eligibility.policyVersion}</p></details>
        {eligibility.locales.map(item => <section key={item.locale} className={styles.localeReadiness}>
          <h4>{item.locale}<span>{t("release.coverage", { count: item.checkedUnits })}</span></h4>
          {item.blockers.length ? <div className={styles.blockerTable} tabIndex={0} role="region" aria-label={t("release.blockerTable", { locale: item.locale })}>
            <table><thead><tr><th scope="col">{t("release.entry")}</th><th scope="col">{t("release.blockingReason")}</th><th scope="col">{t("release.action")}</th></tr></thead>
              <tbody>{item.blockers.map((reason, index) => <tr key={`${reason.unitId}:${index}`}>
                <th scope="row"><code>{reason.nativeKey}</code></th><td>{t(reviewReasonKey(reason.code))}</td>
                <td>{openBlocker ? <Button variant="link" disabled={locked} onClick={() => openBlocker(reason.unitId, item.locale)}>{t("translation.openEditor")}</Button> : null}</td>
              </tr>)}</tbody>
            </table>
          </div> : null}
          {item.exceptions.length ? <ul className={styles.exceptions}>{item.exceptions.map((reason, index) => <li key={`${reason.unitId}:${index}`}>{t("release.exception", { key: reason.nativeKey, reason: reason.code })}</li>)}</ul> : null}
        </section>)}
      </section> : null}
  </>;
  const buildContent = <>
      {prepared && !attempt && owner.earlierBuild ? <Banner tone="warning" role="status">{t("release.earlierPreparation")}</Banner> : null}
      {prepared ? <section className={styles.review}>
        <h4>{t("deliveryWorkbench.fixedHelp")}</h4><details><summary>{t("deliveryWorkbench.diagnostics")}</summary><p>{t("release.source", { id: prepared.review.sourceSnapshotId })}</p></details>
        <ul>{prepared.review.choices.map(({ locale, outputPaths }) => <li key={locale}>{locale}<ul>{outputPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul></li>)}</ul>
        {!attempt ? <>
          <BuildExecutionReview build={prepared.review.build} checker={false}/>
          <Field className={styles.checkbox} label={t("releasePlugin.builderConsent")}><input type="checkbox" checked={buildConsent === prepared.review.inputDigest} disabled={!startAvailability(startPayload()).enabled} onChange={event => { const payload = startPayload(false, event.target.checked); if (payload) registry.dispatch("release.confirm-builder", scope, payload); }}/></Field>
          <div className={styles.actions}>
            <Button variant="link" disabled={!discardAvailability(discardPayload()).enabled} onClick={() => registry.dispatch("release.discard-build", scope, discardPayload())}>{t("releasePlugin.discard")}</Button>
          </div>
        </> : null}
      </section> : null}
      {attempt ? <section className={styles.results} aria-label={t("releasePlugin.results")}>
        <h4>{t("releasePlugin.results")}</h4>
        {owner.earlierBuild ? <Banner tone="warning" role="status">{t("release.earlierBuild")}</Banner> : null}
        {detail ? <ul className={styles.resultList}>{detail.items.map(item => <li key={item.status.itemId}>
          <p>{item.scope.locale} · {t(`execution.states.${item.status.execution}`)} · {t(`releasePlugin.validation.${item.status.validation}`)}</p>
          {item.status.cancellationRequested ? <p>{t("releasePlugin.cancelled")}</p> : null}
          {item.status.diagnostic ? <section className={styles.diagnostic} aria-label={t("execution.diagnostic")}><h5>{t("execution.diagnostic")}</h5><pre>{item.status.diagnostic}</pre></section> : null}
          {item.resultId && item.scope.locale !== null && matchesBuildScope(item, prepared?.review) && item.status.execution === "succeeded" && item.status.validation !== "valid" && !item.status.cancellationRequested ? <Button variant="secondary" disabled={!artifactAvailability(artifactPayload(item.resultId)).enabled} onClick={() => { const payload = artifactPayload(item.resultId!); if (payload) registry.dispatch("release.prepare-artifact-check", scope, payload); }}>{t("releasePlugin.prepareCheck", { locale: item.scope.locale })}</Button> : null}
        </li>)}</ul> : <Banner role="status">{t("releasePlugin.waiting")}</Banner>}
        <div className={styles.actions}>
          <Button variant="secondary" disabled={busy || buildRead.isFetching} onClick={() => void buildRead.refetch()}>{t("execution.refresh")}</Button>
          {detail && buildActive ? <Button variant="secondary" disabled={!cancelAvailability(cancelPayload(detail)).enabled} onClick={() => registry.dispatch("release.cancel-task", scope, cancelPayload(detail))}>{t("execution.cancel")}</Button> : null}
        </div>
        {detail && buildActive ? <p className={styles.help}>{t("execution.cancelHelp")}</p> : null}
      </section> : null}
  </>;
  const verificationContent = <>
      {checkReview ? <section className={styles.review} aria-label={t("releasePlugin.artifacts")}>
        <h4>{t("releasePlugin.checkLocale", { locale: checkReview.locale })}</h4>
        <ul className={styles.resultList}>{checkReview.artifacts.map(file => <li key={`${file.id}:${file.logicalPath}`}>
          <p><code>{file.logicalPath}</code> · {t("releasePlugin.bytes", { count: file.byteLength })}</p>
          <dl className={styles.identity}><dt>{t("source.fingerprint")}</dt><dd><code>{file.sha256}</code></dd></dl>
        </li>)}</ul>
        <p>{t("releasePlugin.rules", { count: checkReview.requirements.length })}</p>
        {!checkAttempt ? <>
          <BuildExecutionReview build={checkReview.build} checker/>
          <Field className={styles.checkbox} label={t("releasePlugin.checkerConsent")}><input type="checkbox" checked={checkConsent === checkReview.inputDigest} disabled={!startAvailability(startPayload(true), true).enabled} onChange={event => { const payload = startPayload(true, event.target.checked); if (payload) registry.dispatch("release.confirm-checker", scope, payload); }}/></Field>
        </> : <>
          <Banner role="status">{t(checkItem?.status.execution === "succeeded" ? "releasePlugin.checkReceived" : checkActive ? "releasePlugin.checkRunning" : "releasePlugin.checkFailed")}</Banner>
          <div className={styles.actions}>
            <Button variant="secondary" disabled={busy || checkRead.isFetching} onClick={() => void checkRead.refetch()}>{t("execution.refresh")}</Button>
            {checkDetail && checkActive ? <Button variant="secondary" disabled={!cancelAvailability(cancelPayload(checkDetail)).enabled} onClick={() => registry.dispatch("release.cancel-task", scope, cancelPayload(checkDetail))}>{t("execution.cancel")}</Button> : null}
          </div>
        </>}
      </section> : null}
      <ArtifactCheckWorkflowControls project={project} open={setupOpen} disabled={disabled} canInteract={canInteract} detail={detail ?? null} buildKey={buildKey} readProof={() => proof(buildKey)}/>
      {canRecord && !receipt ? <>
        <Banner tone="success" role="status">{t("releasePlugin.allChecked")}</Banner>
      </> : null}
      {receipt ? <Banner tone="success" role="status">{t("releasePlugin.recorded")}</Banner> : null}
      {attempt && !buildActive && !checkActive ? <div className={styles.actions}><Button variant="secondary" disabled={!discardAvailability(discardPayload()).enabled} onClick={() => registry.dispatch("release.discard-build", scope, discardPayload())}>{t("releasePlugin.newBuild")}</Button></div> : null}
  </>;
  const recoveryContent = <>
      {pending?.kind === "build" && pending.uncertain ? <Banner tone="warning" role="status">
        <p>{t(owner.checkingStart ? "execution.checkingPluginStart" : "releasePlugin.unknown")}</p>
        <div className={styles.actions}>
          <Button variant="secondary" disabled={!pendingAvailability(pendingPayload()).enabled} onClick={() => { const payload = pendingPayload(); if (payload) registry.dispatch("release.check-build", scope, payload); }}>{t(["start-build", "start-check"].includes(pending.intent.kind) ? "execution.checkPluginStart" : "releasePlugin.reconcile")}</Button>
          {pending.retryAllowed && ["adopt", "start-build", "start-check"].includes(pending.intent.kind) ? <Button variant="secondary" disabled={!pendingAvailability(pendingPayload(), true).enabled} onClick={() => { const payload = pendingPayload(); if (payload) registry.dispatch("release.retry-build", scope, payload); }}>{t(pending.intent.kind === "adopt" ? "execution.retryAdoption" : "execution.retryPluginStart")}</Button> : null}
          {["prepare-build", "prepare-check"].includes(pending.intent.kind) ? <Button variant="secondary" disabled={!discardAvailability(discardPayload()).enabled} onClick={() => registry.dispatch("release.discard-build", scope, discardPayload())}>{t("releasePlugin.discard")}</Button> : null}
        </div>
        {pending.retryAllowed && ["adopt", "start-build", "start-check"].includes(pending.intent.kind) ? <p>{t(pending.intent.kind === "adopt" ? "execution.noReceipt" : "execution.pluginStartMissing")}</p> : null}
      </Banner> : null}
  </>;
  const content = renderWorkbench({
    settings: settingsContent, readiness: readinessContent, build: buildContent, verification: verificationContent,
    feedback: feedbackContent, recovery: recoveryContent, saved: savedContent, primary: savedAttempt ? null : mainAction(),
    status: { buildActive, checkActive, outputReceived: !!detail?.items.length && detail.items.every(item => item.resultId && item.status.execution === "succeeded"), complete,
      failed: !!detail?.items.some(item => item.status.execution === "failed" || item.status.execution === "cancelled-before-dispatch"),
      unknown: pending?.kind === "build" && pending.uncertain || !!detail?.items.some(item => item.status.execution === "unknown"), readFailed: !!buildRead.error || !!checkRead.error },
  });
  return <div className={styles.root}
    onCompositionStartCapture={() => { composing.current = true; }}
    onCompositionEndCapture={() => { composing.current = false; }}
    onKeyDownCapture={event => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation();
    }}
    onChangeCapture={event => { if (canInteract?.("input") === false) { event.preventDefault(); event.stopPropagation(); } }}
    onClickCapture={event => {
      if (canInteract?.() === false) { event.preventDefault(); event.stopPropagation(); return; }
      if (composing.current && event.detail === 0) { event.preventDefault(); event.stopPropagation(); }
    }}>
    {content}
  </div>;
}
