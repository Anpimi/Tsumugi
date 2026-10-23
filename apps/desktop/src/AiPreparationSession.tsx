import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from "react";
import { matchQuery, QueryObserver } from "@tanstack/react-query";
import { aiCommands, defaultAiConfig, editedAiConfig, validSourceContextSelection, sameAiConfig as sameConfig, type AiConfig, type AiItem, type AiPrepared, type AiStart, type AiView } from "./aiCommands";
import { connectionConfigCurrent, useConnectionFacts } from "./ApplicationReadProvider";
import type { ConnectionReadView } from "./connectionCommands";
import { executionCommands, type AdoptionAction, type PrepareRequest, type Receipt, type AttemptDetail } from "./executionCommands";
import { validateResponseIdentity, validateResponseAdoptionAction } from "./generated/execution.validators";
import { validateResponseWorkPlanStatus, validateResponseView } from "./generated/ai.validators";
import { validateResponseScope, validateResponsePage } from "./generated/source.validators";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { hasUnknownOutcome } from "./projectCommands";
import { useSessionReads, useSessionAlive } from "./SessionReadProvider";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { workPlanCommands, checkedTeamToolHistoryTask, type TeamWorkReference, type TeamToolHistoryAttempt, type MaintenanceAssessment, type MaintenancePlanBasis, type MaintenanceChoice, type WorkPlanView, type WorkPlanStatusView, type PlanOptions } from "./workPlanCommands";
import { useWorkPlanControlSession } from "./WorkPlanControls";
import { useWorkPlanAgentSession } from "./WorkPlanAgentControls";
import { childLifecycleKey, childRunWorking, hasChildUncertainty } from "./WorkPlanChildControls";
import { useWorkPlanGenerationSession } from "./WorkPlanGenerationControls";
import { useTeamRecoverySession } from "./TeamRecoverySession";
import { useTeamDiscussionSession } from "./TeamDiscussionSession";
import { useTeamGuidanceSession } from "./TeamGuidanceSession";
import { editTeamMemberConfig, teamDraftProblem, type TeamExecutionDraft } from "./TeamExecutionDraft";
import type { PlanToolDraft, PlanToolChoiceHandle } from "./WorkPlanToolChoice";
import type { PluginTextReviewSelection } from "./pluginCommands";
import { jsonIdentity } from "./pluginToolChoices";
import type { WorkPlanToolSelection } from "./generated/ai.requests";
import type { ChangeScope } from "./sessionReads";
import { sourceReads } from "./sourceQueries";
import { contentSelectionIds, validContentSelection, type ContentSelection } from "./contentSelection";
import { strategyCommands, strategyKeys } from "./strategyCommands";
import type { McpTermQueryPreview } from "./mcpRetrievalCommands";
import type { McpRetrievalSession } from "./McpRetrievalSession";

export const defaultPlanOptions: PlanOptions = { stages: (["understanding", "resources", "generation", "checks", "delivery"] as const).map(stage => ({ stage, mode: stage === "generation" || stage === "checks" ? "assisted" : "manual" })), selectionPolicy: "candidates-only", adoptResources: false, deliver: false, advisoryChecks: [] };
export type WorkPlanContinuation = (() => boolean) & { fresh: () => boolean; acceptPlan: (status: WorkPlanStatusView) => boolean };
type PreparationCapture = { kind: "direct"; value: AiPrepared } | { kind: "plan"; value: WorkPlanView };


type StartCapture = { request: AiStart; prepared: AiPrepared; editSeq: number; uncertain: boolean };
type Candidate = { taskId: string; item: AiItem; resultId: string; unitId: string; text: string };
type AdoptCapture = { request: PrepareRequest; candidate: Candidate; editSeq: number; action: AdoptionAction | null; receipt: Receipt | null; uncertain: boolean; retryAllowed: boolean; checking: boolean };
type McpDraft = { preview: McpTermQueryPreview; label: string; serviceConsent: boolean; modelConsent: boolean };
interface State {
  maintenance: MaintenancePlanBasis | null;
  presetName: string; config: AiConfig; locale: string; selected: string[]; selectedSnapshotId: string | null; capture: PreparationCapture | null; consent: boolean;
  options: PlanOptions; toolDraft: PlanToolDraft | null; advisoryChecks: PluginTextReviewSelection[]; planId: string | null;
  teamDraft: TeamExecutionDraft | null;
  mcpDraft: McpDraft | null;
  startedPlan: { prepared: WorkPlanView; attemptId: string; taskId: string | null; generation: string; unitIds: string[] } | null;
  staleReason: "source" | "preview" | "connection" | null; dirty: boolean; editSeq: number; sourceGeneration: number; busy: boolean;
  checkedTask: { attemptId: string; taskId: string } | null;
  attempt: string | null; started: { prepared: AiPrepared; taskId: string | null } | null;
  pendingStart: StartCapture | null; pendingAdopt: AdoptCapture | null; saved: Record<string, Receipt>;
  failure: CommandFailure | null; notice: "started" | "saved" | "newer" | "maintenance" | null;
  strategyDefault: "loading" | "ready" | "failed"; strategyDefaultFailure: CommandFailure | null;
}
const limits = [["maxItems",1,100],["concurrency",1,2],["maxRequests",1,300],["maxOutputTokens",1,16384],["maxRetries",0,2],["timeoutSeconds",1,120]] as const;
const validLimits = (config: AiConfig) => limits.every(([key,min,max]) => Number.isInteger(config[key]) && config[key] >= min && config[key] <= max) && validSourceContextSelection(config.sourceContext);
function validItem(item: AiItem) {
  return [item.unitId,item.sourceRevisionId,item.sourceSnapshotId,...item.terms.map(term => term.revisionId)].every(validateResponseIdentity)
    && (!item.context || [item.context.revisionId,item.context.unitId,...(item.context.previousRevisionId ? [item.context.previousRevisionId] : [])].every(validateResponseIdentity));
}
function itemProof(item: AiItem) {
  return JSON.stringify([item.unitId,item.sourceRevisionId,item.sourceSnapshotId,item.nativeKey,item.sourceLocale,item.sourceText,item.targetLocale,item.resourceBaseline,
    item.terms.map(term => [term.revisionId,term.source,term.target,term.protected]),
    item.context ? [item.context.revisionId,item.context.previousRevisionId,item.context.unitId,item.context.locale,item.context.text,item.context.reason] : null,item.sourceContext,item.projectContext,item.omissions]);
}
function freeze<T>(part: T): T {
  if (part && typeof part === "object" && !Object.isFrozen(part)) { Object.values(part).forEach(freeze); Object.freeze(part); }
  return part;
}
function fixed<T>(value: T): T { return freeze(structuredClone(value)); }
function newDraftConfig(): AiConfig {
  return fixed({ ...defaultAiConfig, shareTerms: true, shareContext: true });
}
type PreparationState = State & { readonly prepared: AiPrepared | null; readonly preparedPlan: WorkPlanView | null };
function preparationState(value: State): PreparationState {
  const snapshot: PreparationState = { ...value,
    get prepared() { return snapshot.capture?.kind === "direct" ? snapshot.capture.value : null; },
    get preparedPlan() { return snapshot.capture?.kind === "plan" ? snapshot.capture.value : null; },
  };
  return freeze(snapshot);
}
function invalidAck() { throw new Error("Invalid AI business acknowledgement"); }
function confirmView(view: AiView, attemptId: string, prepared?: AiPrepared, taskId: string | null = null) {
  const details = new Map(view.detail.items.map(item => [item.status.itemId,item]));
  const originalItems = new Map<string,string>(prepared?.preview.items.map(item => [item.unitId,itemProof(item)]) ?? []);
  // Core accepts at most 100 selected items; the Host reads all 100, not a smaller preview scope.
  if (view.detail.attemptId !== attemptId || view.detail.recovery.attemptId !== attemptId || view.detail.operation !== "ai-translation"
    || !validateResponseIdentity(view.detail.taskId) || (taskId && view.detail.taskId !== taskId) || view.recipe !== "direct-translation-1"
    || !validLimits(view.config) || !view.rows.length || view.rows.length > view.config.maxItems
    || view.detail.nextOffset !== null || view.rows.length !== view.detail.items.length || view.rows.length !== view.detail.progress.total
    || details.size !== view.detail.items.length || new Set(view.rows.map(row => row.itemId)).size !== view.rows.length
    || new Set(view.rows.map(row => row.item.unitId)).size !== view.rows.length
    || view.rows.some(row => {
      const detail = details.get(row.itemId);
      return !validateResponseIdentity(row.itemId) || !validItem(row.item) || (row.resultId !== null && !validateResponseIdentity(row.resultId))
        || !detail || detail.resultId !== row.resultId || detail.scope.kind !== "translation-unit" || detail.scope.id !== row.item.unitId || detail.scope.locale !== row.item.targetLocale;
    }) || (prepared && (!sameConfig(view.config,prepared.preview.config) || view.recipe !== prepared.preview.recipe
      || originalItems.size !== prepared.preview.items.length || view.rows.length !== originalItems.size
      // Ledger reads use random item identity order; the fixed preview keeps the user's original selection order.
      || view.rows.some(row => originalItems.get(row.item.unitId) !== itemProof(row.item))))) invalidAck();
}

export function confirmPlanStartView(view: AiView, plan: WorkPlanView, attemptId: string, generation: string, taskId: string | null = null, unitIds: readonly string[] = plan.scope.map(unit=>unit.unitId)) {
  confirmView(view,attemptId,undefined,taskId);
  const preview = plan.preview;
  const items = new Map(preview?.items.filter(item=>unitIds.includes(item.unitId)).map(item => [item.unitId,itemProof(item)]) ?? []);
  if (!preview || view.planId !== plan.planId || view.planGeneration !== generation
    || new Set(unitIds).size !== unitIds.length || items.size !== unitIds.length
    || !sameConfig(view.config,preview.config) || view.recipe !== preview.recipe
    || view.rows.length !== items.size || view.rows.some(row => items.get(row.item.unitId) !== itemProof(row.item))) invalidAck();
}

function usePreparation(initialLocale: string, targetLocales: readonly string[], mcp?: McpRetrievalSession) {
  const reads = useSessionReads(), tasks = useExecutionTaskSession();
  const connections = useConnectionFacts();
  const [session] = useState(() => Object.freeze({ ...reads.context }));
  const [state,setState] = useState<PreparationState>(() => preparationState({ maintenance:null,presetName:"custom",config:newDraftConfig(),locale:initialLocale,selected:[],selectedSnapshotId:null,capture:null,consent:false,
    options:fixed(defaultPlanOptions),toolDraft:null,teamDraft:null,mcpDraft:null,advisoryChecks:[],planId:null,startedPlan:null,
    staleReason:null,dirty:false,editSeq:0,sourceGeneration:0,busy:false,checkedTask:null,attempt:null,started:null,pendingStart:null,pendingAdopt:null,saved:{},failure:null,notice:null,strategyDefault:"loading",strategyDefaultFailure:null }));
  const stateRef = useRef(state), mounted = useSessionAlive(), locales = useRef(targetLocales), basis = useRef(0), flight = useRef<object | null>(null);
  const candidateReadCleanup = useRef<(() => void) | null>(null);
  const actionReadCleanups = useRef(new Set<() => void>());
  useLayoutEffect(() => { mounted.current = true; return () => {
    mounted.current = false; candidateReadCleanup.current?.(); candidateReadCleanup.current = null;
    actionReadCleanups.current.forEach(dispose=>dispose()); actionReadCleanups.current.clear();
  }; }, []);
  useLayoutEffect(() => { locales.current = targetLocales; }, [targetLocales]);
  function current() { return stateRef.current; }
  function live() { return mounted.current && reads.context.projectId === session.projectId && reads.context.sessionToken === session.sessionToken; }
  function update(change: (before: State) => State) {
    if (!live()) return;
    const next=change(stateRef.current);if(next===stateRef.current)return;
    stateRef.current = preparationState(next); setState(stateRef.current);
  }
  const defaultGeneration = useRef(0);
  const defaultCaptureSequence = useRef(0);
  const defaultWait = useRef<Promise<void> | null>(null);
  async function loadStrategyDefault() {
    if (!live() || reserved()) return;
    const before = current(), generation = ++defaultGeneration.current, editSeq = before.editSeq, locale = before.locale;
    if (!locale || !available(locale)) { update(value => ({ ...value, strategyDefault: "ready", strategyDefaultFailure: null })); return; }
    update(value => ({ ...value, strategyDefault: "loading", strategyDefaultFailure: null }));
    const unchanged = () => live() && generation === defaultGeneration.current && current().editSeq === editSeq && current().locale === locale && !reserved();
    try {
      const key = reads.key(strategyKeys.default(locale));
      await reads.client.fetchQuery({ queryKey: key, staleTime: 0, meta: { scopes: ["arena", "project"] }, queryFn: () => strategyCommands.default({ ...session, locale }) });
      const snapshot = reads.client.getQueryState<Awaited<ReturnType<typeof strategyCommands.default>>>(key);
      if (!unchanged()) { if (live() && generation === defaultGeneration.current) update(value => ({ ...value, strategyDefault: "ready" })); return; }
      if (!snapshot || snapshot.status !== "success" || snapshot.fetchStatus !== "idle" || snapshot.isInvalidated || snapshot.error !== null) throw new Error("Strategy default is not current");
      const revision = snapshot.data;
      const candidate = revision?.reference ? await strategyCommands.candidate({ ...session, candidateId: revision.reference.candidateId }) : null;
      if (!unchanged()) { if (live() && generation === defaultGeneration.current) update(value => ({ ...value, strategyDefault: "ready" })); return; }
      const latest = reads.client.getQueryState(key);
      if (latest !== snapshot || latest?.isInvalidated || latest?.fetchStatus !== "idle" || latest?.error !== null) throw new Error("Strategy default changed while reading");
      if (candidate && (candidate.locale !== locale || candidate.projectId !== session.projectId || !revision?.reference)) throw new Error("Strategy default scope does not match");
      // This one-time capture changes only context. It never copies a saved
      // experiment's connection, limits or manual sharing into a user's draft.
      update(value => ({ ...value, strategyDefault: "ready", strategyDefaultFailure: null,
        config: editSeq === defaultCaptureSequence.current && candidate && revision?.reference ? fixed({ ...value.config, sourceContext: candidate.sourceContext, contextStrategy: revision.reference }) : value.config }));
    } catch (error) {
      if (live() && generation === defaultGeneration.current) update(value => ({ ...value, strategyDefault: "failed", strategyDefaultFailure: commandFailure(error) }));
    }
  }
  useEffect(() => { defaultWait.current = loadStrategyDefault(); return () => { defaultGeneration.current++; }; }, []);
  const planControl = useWorkPlanControlSession(live), agent = useWorkPlanAgentSession(live), component = useWorkPlanGenerationSession(live);
  const discussions = useTeamDiscussionSession(live, session, () => reads.invalidate(["execution"]), () => !guidance.blocked());
  const recovery = useTeamRecoverySession(live, session, () => !flight.current && !current().busy && !current().pendingStart && !current().pendingAdopt
    && !planControl.current().pending && !planControl.current().ready && !agent.current().pending && !component.current().operation && !guidance.blocked(),
    () => reads.invalidate(["execution", "translation", "review"]), (prepared, receipt, unitId) => {
      update(before => before.planId !== null && before.planId !== prepared.planId ? before : ({ ...before, planId: prepared.planId, attempt: receipt.attemptId, checkedTask: null, started: null,
        startedPlan: { prepared, attemptId: receipt.attemptId, taskId: receipt.taskId, generation: receipt.effectiveVersion.lease.generation, unitIds: [unitId] } }));
    });
  const guidance = useTeamGuidanceSession(live, session, () => !reserved(true) && !discussions.blocked(), () => reads.invalidate(["execution"]));
  function parentReserved(excludeRecovery = false, excludeGuidance = false) {
    const toolRun = agent.current().toolRun;
    const toolView = toolRun && reads.client.getQueryData<AttemptDetail | null>(reads.key(["agent-tool-attempt",toolRun.prepared.attemptId]));
    const toolWorking = !!toolRun && (!toolView || toolView.items.some(item => item.status.execution === "queued" || item.status.execution === "dispatched"));
    return (!excludeRecovery && recovery.blocked()) || (!excludeGuidance && guidance.blocked()) || !!flight.current || !!current().pendingStart || !!current().pendingAdopt
      || !!planControl.current().pending || !!planControl.current().ready || !!agent.current().pending || toolWorking || !!component.current().operation;
  }
  function reserved(excludeGuidance = false) {
    return parentReserved(false, excludeGuidance) || !!agent.current().child.pending || agent.current().child.children.some(child => child.runs.some(action => childRunWorking(action,
      reads.client.getQueryData<AttemptDetail | null>(reads.key(childLifecycleKey(child.consumer.scope.scopeId, action.prepared.attemptId))))));
  }
  function canRunChild(recovery = false) {
    return live() && !parentReserved() && (recovery || !hasChildUncertainty(agent.current().child));
  }
  function canOpenChildHistory(taskId: string, attemptId: string) {
    return canRunChild(true) && agent.current().child.children.some(child => child.runs.some(action =>
      action.phase !== "not-enqueued" && action.request.taskId === taskId && action.request.attemptId === attemptId));
  }
  function canOpenTeamToolHistory(planId: string, work: TeamWorkReference, row: TeamToolHistoryAttempt) {
    return live() && !parentReserved(true, true) && !agent.current().child.pending && current().planId === planId
      && checkedTeamToolHistoryTask(session, planId, work, row);
  }
  function available(locale = current().locale) { return locale !== "" && locales.current.includes(locale); }
  function connectionCurrent() {
    const before = current(), view = connections.current();
    return connectionConfigCurrent(view, before.config) && (!before.teamDraft || before.teamDraft.members.every(member => connectionConfigCurrent(view, member.config)));
  }
  function selectConnection(view: ConnectionReadView | null, id: string, expectedEditSeq: number) {
    const before = current();
    if (!live() || reserved() || before.editSeq !== expectedEditSeq) return false;
    if (!id) { edit("config", { ...before.config, connectionProfile: null }); update(value => ({ ...value, presetName: "custom" })); return true; }
    if (!view || connections.current() !== view) return false;
    const reference = view.references.find(value => value.profileId === id), profile = view.snapshot.profiles.find(value => value.id === id && !value.archived);
    if (!reference || !profile) return false;
    edit("config", { ...before.config, ...profile.connection, connectionProfile: reference }); update(value => ({ ...value, presetName: "custom" })); return true;
  }
  function invalidatePreview(reason: State["staleReason"] = null) {
    basis.current++; update(before => ({ ...before,capture:null,consent:false,staleReason:reason,
      mcpDraft: before.mcpDraft ? { ...before.mcpDraft, serviceConsent: false, modelConsent: false } : null }));
  }
  function edit<K extends "config" | "presetName" | "locale" | "selected" | "options" | "toolDraft" | "teamDraft" | "advisoryChecks">(key: K, value: State[K]) {
    basis.current++;
    update(before => ({ ...before,[key]:fixed(value),...(key==="selected"||key==="locale"?{maintenance:null}:{}),...(key==="locale"&&value!==before.locale?{
      config:fixed({...before.config,contextStrategy:null}),teamDraft:before.teamDraft?fixed({...before.teamDraft,members:before.teamDraft.members.map(member=>({...member,config:{...member.config,contextStrategy:null}}))}):null
    }:{}),capture:null,consent:false,staleReason:null,
      mcpDraft: before.mcpDraft ? { ...before.mcpDraft, serviceConsent: false, modelConsent: false } : null,
      dirty:true,editSeq:before.editSeq+1,failure:null,notice:null }));
  }
  function canReceiveMcpQuery(preview: McpTermQueryPreview, expectedEditSeq: number) {
    const before = current(), request = preview.request;
    return live() && !reads.retired && !reserved() && before.editSeq === expectedEditSeq && !before.teamDraft && !before.options.teamExecution
      && (!before.mcpDraft || jsonIdentity(before.mcpDraft.preview) === jsonIdentity(preview))
      && before.options.stages.some(choice => choice.stage === "generation" && choice.mode === "assisted")
      && request.projectId === session.projectId && preview.basis.projectId === session.projectId
      && available(request.locale) && before.locale === request.locale && request.expiresAtMs > Date.now()
      && (before.selected.length === 0 || before.selected.length === 1 && before.selected[0] === request.unitId)
      && !!mcp && mcp.aiPreviewCurrent(preview);
  }
  function receiveMcpQuery(preview: McpTermQueryPreview, expectedEditSeq: number, label: string) {
    if (!canReceiveMcpQuery(preview, expectedEditSeq)) return false;
    basis.current++;
    update(before => ({ ...before, maintenance: null, selected: [preview.basis.unitId], selectedSnapshotId: preview.basis.sourceSnapshotId,
      mcpDraft: { preview: fixed(preview), label, serviceConsent: false, modelConsent: false }, capture: null, consent: false,
      dirty: true, editSeq: before.editSeq + 1, staleReason: null, failure: null, notice: null }));
    return true;
  }
  function mcpScopeCurrent() {
    const before = current(), preview = before.mcpDraft?.preview;
    const source = reads.client.getQueryState(reads.key(["source-scope"]));
    return !!preview && !before.teamDraft && !before.options.teamExecution && before.selected.length === 1 && before.selected[0] === preview.basis.unitId
      && before.locale === preview.basis.locale && available(preview.basis.locale)
      && source?.status === "success" && source.fetchStatus === "idle" && !source.isInvalidated && source.error === null
      && validateResponseScope(source.data) && source.data.currentSnapshot === preview.basis.sourceSnapshotId
      && before.options.stages.some(choice => choice.stage === "generation" && choice.mode === "assisted")
      && !!mcp && mcp.aiPreviewCurrent(preview);
  }
  function setMcpConsent(key: "serviceConsent" | "modelConsent", value: boolean) {
    if (!live() || reserved() || !current().mcpDraft || value && (!mcpScopeCurrent() || !connectionCurrent())) return;
    basis.current++;
    update(before => ({ ...before, mcpDraft: before.mcpDraft ? { ...before.mcpDraft, [key]: value } : null,
      capture: null, consent: false, dirty: true, editSeq: before.editSeq + 1, failure: null }));
  }
  function clearMcpQuery() {
    if (!live() || reserved()) return false;
    basis.current++;
    update(before => ({ ...before, mcpDraft: null, capture: null, consent: false, dirty: true, editSeq: before.editSeq + 1 }));
    return true;
  }
  useEffect(() => {
    const preview = state.mcpDraft?.preview;
    if (!preview) return;
    const expire = () => { if (current().mcpDraft?.preview === preview) invalidatePreview("preview"); };
    const remaining = preview.request.expiresAtMs - Date.now();
    if (remaining <= 0) { expire(); return; }
    const timer = window.setTimeout(expire, remaining + 1); return () => window.clearTimeout(timer);
  }, [state.mcpDraft?.preview]);
  useLayoutEffect(() => {
    const before = current(), draft = before.mcpDraft, original = mcp?.current();
    if (draft && (draft.serviceConsent || draft.modelConsent || before.capture?.kind === "plan" && before.capture.value.options.mcpTermQuery)
      && (!original || original.operation?.closed || original.operation?.unknown || original.stop?.pending || original.stop?.unknown
        || jsonIdentity(original.operation?.preview) !== jsonIdentity(draft.preview))) invalidatePreview("preview");
  }, [mcp?.state]);
  function editTeamConfig(key: number, change: SetStateAction<AiConfig>) {
    const draft = current().teamDraft;
    if (!live() || !draft) return;
    edit("teamDraft", { ...draft, members: draft.members.map(member => member.key === key
      ? editTeamMemberConfig(member, typeof change === "function" ? change(member.config) : change) : member) });
  }
  function selectTeamConnection(key: number, view: ConnectionReadView | null, id: string, expectedEditSeq: number) {
    const before = current(), member = before.teamDraft?.members.find(member => member.key === key);
    if (!live() || reserved() || before.editSeq !== expectedEditSeq || !member) return false;
    if (!id) { editTeamConfig(key, { ...member.config, connectionProfile: null }); return true; }
    if (!view || connections.current() !== view) return false;
    const reference = view.references.find(value => value.profileId === id), profile = view.snapshot.profiles.find(value => value.id === id && !value.archived);
    if (!reference || !profile) return false;
    editTeamConfig(key, { ...member.config, ...profile.connection, connectionProfile: reference }); return true;
  }
  useLayoutEffect(() => {
    const view = connections.current(), before = current();
    // Pending actions/checked grants keep their original continuation proof.
    // A focus reread which confirms the same reference keeps preview/consent.
    if (view && !reserved() && (before.prepared || before.preparedPlan?.preview || before.consent || before.mcpDraft?.serviceConsent || before.mcpDraft?.modelConsent) && !connectionCurrent()) invalidatePreview("connection");
  }, [connections.state, state.busy, state.config, state.teamDraft, state.capture, state.consent, state.mcpDraft, planControl.state.pending, planControl.state.ready]);
  function receiveContentSelection(selection: ContentSelection, expectedEditSeq: number) {
    if (!canReceiveContentSelection() || current().editSeq !== expectedEditSeq
      || selection.projectId !== session.projectId || selection.sessionToken !== session.sessionToken
      || !available(selection.capture.locale) || !validContentSelection(selection)) return false;
    const selected = contentSelectionIds(selection);
    if (!selected.length || selected.length > 100) return false;
    // Transfer only a user range. Existing preparation, consent and execution
    // authority cannot accompany it; the next explicit preview reads Core facts.
    basis.current++;
    update(before => ({ ...before,maintenance:null,locale:selection.capture.locale,...(before.locale!==selection.capture.locale?{config:fixed({...before.config,contextStrategy:null})}:{}),selected:fixed(selected),selectedSnapshotId:selection.capture.sourceSnapshotId,capture:null,consent:false,staleReason:null,
      mcpDraft: before.mcpDraft ? { ...before.mcpDraft, serviceConsent: false, modelConsent: false } : null,
      dirty:true,editSeq:before.editSeq+1,failure:null,notice:null }));
    return true;
  }
  function canReceiveContentSelection() {
    if (!live() || reads.retired || reserved()) return false;
    const before = current(); if (!before.attempt) return true;
    const read = reads.client.getQueryState<AiView | null>(reads.key(["aiCommands",before.attempt])), view = read?.data;
    // A start acknowledgement is not a completed task. Retain the old range
    // while its checked result is absent, stale, running or still saving.
    return read?.status === "success" && read.fetchStatus === "idle" && !read.isInvalidated && read.error === null
      && validateResponseView(view) && view.detail.attemptId === before.attempt
      && before.checkedTask?.attemptId === before.attempt && before.checkedTask.taskId === view.detail.taskId
      && view.detail.progress.queued === 0 && view.detail.progress.running === 0
      && !view.rows.some(row => row.automation && ["waiting","saving-candidate","checking"].includes(row.automation.phase));
  }
  function captureMaintenance(assessment: MaintenanceAssessment, expectedEditSeq: number, currentRead: () => boolean,
    replacement?: { expectedDirty: boolean; confirmed: boolean }) {
    if (!canReceiveContentSelection() || current().editSeq!==expectedEditSeq || !currentRead()
      || replacement && (current().dirty !== replacement.expectedDirty || current().dirty && !replacement.confirmed)
      || assessment.projectId!==session.projectId || !available(assessment.locale)) return false;
    const choices: MaintenanceChoice[]=assessment.rows.map(row=>({unitId:row.unitId,action:row.suggested,
      excluded:row.protection.protected||row.mappingUnresolved}));
    basis.current++;
    update(before=>({...before,maintenance:fixed({assessment,choices}),locale:assessment.locale,...(before.locale!==assessment.locale?{config:fixed({...before.config,contextStrategy:null})}:{}),
      selected:choices.filter(choice=>!choice.excluded&&choice.action==="repair").map(choice=>choice.unitId),
      selectedSnapshotId:assessment.sourceSnapshotId,capture:null,consent:false,staleReason:null,dirty:true,editSeq:before.editSeq+1,failure:null,notice:"maintenance"}));
    return true;
  }
  function editMaintenance(choice: MaintenanceChoice, expectedEditSeq: number) {
    const before=current(), maintenance=before.maintenance, row=maintenance?.assessment.rows.find(row=>row.unitId===choice.unitId);
    if (!live()||reserved()||before.editSeq!==expectedEditSeq||!maintenance||!row
      || (!choice.excluded&&choice.action==="repair"&&(row.protection.protected||row.mappingUnresolved))) return false;
    const choices=maintenance.choices.map(value=>value.unitId===choice.unitId?choice:value);
    basis.current++;
    update(value=>({...value,maintenance:fixed({...maintenance,choices}),selected:choices.filter(value=>!value.excluded&&value.action==="repair").map(value=>value.unitId),
      capture:null,consent:false,dirty:true,editSeq:value.editSeq+1,failure:null,notice:null})); return true;
  }
  function discardMaintenance() {
    if (!live()||reserved()||!current().maintenance) return false;
    edit("selected",[]); update(value=>({...value,selectedSnapshotId:null})); return true;
  }
  async function run(work: () => Promise<void>, recovery = false, guidanceRevocation = false) {
    if (!live() || flight.current || guidance.blocked() && !guidanceRevocation || (!recovery && reserved())) return;
    // Reserve before any identity/IPC await, across every consumer of this owner.
    const ticket = {}; flight.current = ticket;
    update(before => ({ ...before,busy:true,failure:null,notice:null }));
    try { await work(); } catch (error) { update(before => ({ ...before,failure:commandFailure(error,"outcome-unknown") })); }
    finally { if (live() && flight.current === ticket) { flight.current = null; update(before => ({ ...before,busy:false })); } }
  }
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(scope => ["project", "source", "resources", "translation", "review"].includes(scope))) recovery.invalidateCapture();
    if (scopes.includes("project") || scopes.includes("source") || scopes.includes("resources")) {
      invalidatePreview(scopes.includes("source") ? "source" : "preview");
      if (scopes.includes("project") || scopes.includes("source")) update(before => ({ ...before,sourceGeneration:before.sourceGeneration+1 }));
    }
  }), [reads]);
  const targetAvailable = state.locale !== "" && targetLocales.includes(state.locale);
  useLayoutEffect(() => { if (!targetAvailable) invalidatePreview(); }, [targetAvailable]);
  function canPreview(model = true) {
    const before = current();
    const mcpEnabled = before.mcpDraft && (before.mcpDraft.serviceConsent || before.mcpDraft.modelConsent);
    // Presentation follows this render's props. Mutation entry points below
    // separately require the committed locale ref before any dispatch.
    return live() && !reserved() && before.strategyDefault === "ready" && before.locale !== "" && targetLocales.includes(before.locale)
      && validateResponseIdentity(session.projectId) && !!session.sessionToken && before.selected.length > 0 && (!model || connectionCurrent())
      && (!mcpEnabled || before.mcpDraft?.serviceConsent && before.mcpDraft.modelConsent && mcpScopeCurrent());
  }
  async function preview() {
    if (current().strategyDefault === "loading") await defaultWait.current;
    if(current().maintenance)return;
    if (!canPreview() || !available()) return;
    const before = current(), version = basis.current;
    const request = fixed({ ...session,config:before.config,locale:before.locale,unitIds:before.selected });
    await run(async () => {
      if (!validLimits(request.config)) throw { field:"ai-limits" };
      if (request.unitIds.length > request.config.maxItems || new Set(request.unitIds).size !== request.unitIds.length) throw { field:"ai-scope" };
      if (request.unitIds.some(id => !validateResponseIdentity(id))) throw { field:"ai-source" };
      const result = await aiCommands.preview(request);
      if (!live() || version !== basis.current || !available(request.locale)) return;
      if (!validateResponseIdentity(result.attemptId) || !sameConfig(result.preview.config,request.config) || !result.preview.digest
        || result.preview.recipe !== "direct-translation-1" || result.preview.items.length !== request.unitIds.length
        || result.preview.items.some((item,index) => !validItem(item) || item.unitId !== request.unitIds[index] || item.targetLocale !== request.locale)) invalidAck();
      update(value => ({ ...value,capture:{kind:"direct",value:fixed(result)},planId:null,startedPlan:null,consent:false,staleReason:null }));
    });
  }
  async function preparePlan(captureTools: () => ReturnType<PlanToolChoiceHandle["capture"]>, sourceContentKey: readonly unknown[]) {
    if (current().strategyDefault === "loading") await defaultWait.current;
    const before = current(), version = basis.current;
    const assisted = before.options.stages.some(choice => choice.stage === "generation" && choice.mode === "assisted");
    if (!canPreview(assisted) || !available()) return;
    const mcpPreview = before.mcpDraft?.serviceConsent && before.mcpDraft.modelConsent ? before.mcpDraft.preview : null;
    const options = { ...before.options };
    delete options.mcpTermQuery;
    if (mcpPreview) options.mcpTermQuery = { profile: "fixed-term-query-1", preview: mcpPreview };
    const capture = fixed({ ...session, config: assisted ? before.config : null, locale: before.locale,
      unitIds: before.selected, options, maintenance:before.maintenance, advisoryChecks: before.options.stages.some(choice => choice.stage === "checks" && choice.mode === "assisted") ? before.advisoryChecks : [] });
    await run(async () => {
      const tools = captureTools(), selectedTools = tools && fixed(tools);
      const sourceWitness = reads.watchExactQuery(["source-scope"]);
      const contentWitness = reads.watchExactQuery(sourceContentKey), originalContent = contentWitness.current()?.state.data;
      const toolWitnesses = selectedTools?.entries.map(tool => ({ tool,witness:reads.watchExactQuery(tool.readKey) })) ?? [];
      const originalSource = sourceWitness.current()?.state.data;
      const sourceCurrent = () => {
        const query = sourceWitness.current(), value = query?.state.data;
        const content = contentWitness.current();
        return !!query && query.state.status === "success" && query.state.error === null
          && validateResponseScope(value) && validateResponseScope(originalSource)
          && value.revision === originalSource.revision && value.currentSnapshot === originalSource.currentSnapshot
          && content?.state.status === "success" && content.state.error === null
          && validateResponsePage(content.state.data) && validateResponsePage(originalContent)
          && jsonIdentity(content.state.data) === jsonIdentity(originalContent);
      };
      const toolsCurrent = () => (!mcpPreview || !!mcp && mcp.aiPreviewCurrent(mcpPreview)) && toolWitnesses.every(({tool,witness}) => {
        const query = witness.current();
        return query?.state.status === "success" && query.state.error === null && jsonIdentity(query.state.data) === jsonIdentity(tool.view);
      });
      const dispose = () => { sourceWitness.dispose(); contentWitness.dispose(); toolWitnesses.forEach(({witness})=>witness.dispose()); };
      candidateReadCleanup.current = dispose;
      try {
      if (capture.config && !validLimits(capture.config)) throw { field: "ai-limits" };
      if (before.teamDraft && (!assisted || !capture.options.teamDiscussions || teamDraftProblem(before.teamDraft, before.config, before.selected, before.toolDraft?.entries.map(entry => entry.id) ?? [])
        || before.teamDraft.members.some(member => !validLimits(member.config)))) throw { field: "team-config" };
      if (capture.unitIds.length > (capture.config?.maxItems ?? 1000) || new Set(capture.unitIds).size !== capture.unitIds.length) throw { field: "ai-scope" };
      if (capture.unitIds.some(id => !validateResponseIdentity(id))) throw { field: "ai-source" };
      if (assisted && before.toolDraft && !selectedTools) throw { reason: "work-plan-tool-unavailable", outcome: "rejected" };
      if (!sourceCurrent() || !toolsCurrent() || [sourceWitness,contentWitness,...toolWitnesses.map(value=>value.witness)].some(witness=> {
        const query=witness.current();return !query || query.state.fetchStatus!=="idle" || query.state.isInvalidated;
      })) return;
      const scopeOptions = sourceReads.scope(session);
      const latestScope = await reads.client.fetchQuery({ queryKey: reads.key(scopeOptions.key), meta: { scopes: scopeOptions.scopes }, staleTime: 0, queryFn: scopeOptions.read });
      if (!live() || version !== basis.current) return;
      if (before.selectedSnapshotId !== null && latestScope.currentSnapshot !== before.selectedSnapshotId) throw { reason: "work-plan-basis", outcome: "rejected" };
      let toolSelection: WorkPlanToolSelection | null = null;
      if (selectedTools) {
        const entries = await Promise.all(selectedTools.entries.map(async tool => ({
          handle: await executionCommands.identity(session), tool: tool.tool, target: tool.target, selections: tool.selections,
        })));
        const [first, ...rest] = entries;
        if (!first) throw { reason: "work-plan-tool-unavailable", outcome: "rejected" };
        toolSelection = { maxInvocations: selectedTools.maxInvocations, entries: [first, ...rest] };
      }
      let options = capture.options;
      if (before.teamDraft) {
        const members = await Promise.all(before.teamDraft.members.map(async member => {
          const [memberId, roleVersionId] = await Promise.all([executionCommands.identity(session), executionCommands.identity(session)]);
          return { memberId, roleVersionId, displayName: member.displayName, role: member.role, config: member.config,
            unitIds: member.unitIds, kinds: member.kinds, toolHandles: member.toolRowIds.map(rowId => {
              const index = selectedTools?.entries.findIndex(tool => tool.rowId === rowId) ?? -1;
              const handle = index >= 0 ? toolSelection?.entries[index]?.handle : null;
              if (!handle) throw { field: "team-config" }; return handle;
            }) };
        }));
        const initial = members[before.teamDraft.members.findIndex(member => member.key === before.teamDraft!.initialKey)];
        if (!initial) throw { field: "team-config" };
        options = { ...options, teamExecution: { profile: "bounded-team-1", initialMemberId: initial.memberId, initialUnitId: before.teamDraft.initialUnitId, members, limits: before.teamDraft.limits } };
      }
      if (!live() || version !== basis.current || !available(capture.locale) || !sourceCurrent() || !toolsCurrent() || assisted && !connectionCurrent()) return;
      const result = await workPlanCommands.prepare({ ...capture, options, toolSelection }, selectedTools?.entries.map(tool => tool.view) ?? []);
      if (!live() || version !== basis.current || !available(capture.locale) || !sourceCurrent() || !toolsCurrent() || assisted && !connectionCurrent()) return;
      // Core may canonicalize the preview independently of the user's selection.
      // Verify complete, unique coverage without rebinding either capture.
      const units=new Set(capture.unitIds);
      if (result.scope.length !== units.size || new Set(result.scope.map(unit=>unit.unitId)).size!==units.size
        || result.scope.some(unit=>!units.has(unit.unitId)) || (result.preview && (result.preview.items.length!==units.size
          || new Set(result.preview.items.map(item=>item.unitId)).size!==units.size
          || result.preview.items.some(item=>!units.has(item.unitId))))) invalidAck();
      update(value => ({ ...value,capture:{kind:"plan",value:fixed(result)},planId:null,attempt:null,checkedTask:null,started:null,startedPlan:null,consent:false,staleReason:null }));
      planControl.reset(); agent.reset(); component.reset();
      } finally { dispose(); if (candidateReadCleanup.current === dispose) candidateReadCleanup.current = null; }
    });
  }
  async function readPlan(planId: string) { return workPlanCommands.status({ ...session, planId }); }
  async function actionRead<T>(key:readonly unknown[],scopes:ChangeScope[],read:()=>Promise<T>,current:()=>boolean):Promise<T> {
    if(!live() || !flight.current || !current())throw new Error("AI action read is unavailable");
    const options={queryKey:reads.key(key),meta:{scopes},queryFn:read,retry:false as const,refetchOnMount:false as const};
    // A captured action owns this temporary observer. Pure view hiding can
    // cancel its own wait without cancelling the action's checked read.
    const observer=new QueryObserver<T>(reads.client,options),release=observer.subscribe(()=>{});
    let disposed=false;
    const dispose=()=>{if(disposed)return;disposed=true;release();observer.destroy();actionReadCleanups.current.delete(dispose);};
    actionReadCleanups.current.add(dispose);
    try{return await reads.client.fetchQuery({...options,staleTime:0});}
    finally{dispose();}
  }
  async function readPlanForAction(planId:string,current:()=>boolean) {
    return actionRead(["workPlan",planId],["project","execution","source","translation","resources","review"],()=>readPlan(planId),current);
  }
  async function readViewForAction(attemptId:string,current:()=>boolean) {
    return actionRead(["aiCommands",attemptId],["execution","source","translation","resources","review"],()=>readView(attemptId),current);
  }
  function recordPlan(planId: string) {
    if (live() && validateResponseIdentity(planId)) update(before => ({ ...before,planId }));
  }
  async function runWorkPlan(work: (current: WorkPlanContinuation) => Promise<void>, planId: string | null, sourceContentKey: readonly unknown[], guidanceRevocation = false) {
    await run(async () => {
      const version = basis.current;
      let witness = planId ? reads.watchExactQuery(["workPlan",planId]) : null;
      const sourceWitness = reads.watchExactQuery(["source-scope"]), originalSource = sourceWitness.current()?.state.data;
      const contentWitness = reads.watchExactQuery(sourceContentKey), originalContent = contentWitness.current()?.state.data;
      const originalQuery = witness?.current(), originalState = originalQuery?.state;
      const original = originalState?.data;
      let expectedPlan = validateResponseWorkPlanStatus(original) ? original : null;
      const sourceCurrent = () => {
        if (!live() || version !== basis.current) return false;
        const sourceQuery = sourceWitness.current(), source = sourceQuery?.state.data;
        const contentQuery = contentWitness.current(), content = contentQuery?.state.data;
        if (!sourceQuery || sourceQuery.state.status !== "success" || sourceQuery.state.error !== null
          || !validateResponseScope(source) || !validateResponseScope(originalSource)
          || source.revision !== originalSource.revision || source.currentSnapshot !== originalSource.currentSnapshot
          || contentQuery?.state.status!=="success" || contentQuery.state.error!==null
          || !validateResponsePage(content) || !validateResponsePage(originalContent) || jsonIdentity(content)!==jsonIdentity(originalContent)) return false;
        return true;
      };
      const continuation: WorkPlanContinuation = Object.assign(() => live(), { fresh() {
        if(!sourceCurrent())return false;
        if (!witness) return true;
        const query = witness.current(), value = query?.state.data;
        return !!query && validateResponseWorkPlanStatus(value) && !!expectedPlan
          && query.state.status === "success" && query.state.error === null
          && jsonIdentity(value.plan) === jsonIdentity(expectedPlan.plan)
          && jsonIdentity(value.lease) === jsonIdentity(expectedPlan.lease) && value.state === expectedPlan.state
          && value.expiresAt === expectedPlan.expiresAt && jsonIdentity(value.effects) === jsonIdentity(expectedPlan.effects);
      }, acceptPlan(status:WorkPlanStatusView) {
        if(!sourceCurrent() || !validateResponseWorkPlanStatus(status))return false;
        if(expectedPlan && (status.plan.planId!==expectedPlan.plan.planId || status.plan.digest!==expectedPlan.plan.digest
          || jsonIdentity(status.plan.scope)!==jsonIdentity(expectedPlan.plan.scope)
          || jsonIdentity(status.plan.options)!==jsonIdentity(expectedPlan.plan.options)
          || jsonIdentity(status.plan.preview)!==jsonIdentity(expectedPlan.plan.preview)
          || jsonIdentity(status.plan.tools)!==jsonIdentity(expectedPlan.plan.tools)))return false;
        // Only a checked result of this flight may advance its original lease.
        // The raw latest witness must still contain that exact successful read.
        if(!witness)witness=reads.watchExactQuery(["workPlan",status.lease.planId]);
        const latest=witness.current();
        if(latest?.state.status!=="success" || latest.state.error!==null || jsonIdentity(latest.state.data)!==jsonIdentity(status))return false;
        expectedPlan=status;return true;
      } });
      const dispose = () => { witness?.dispose(); sourceWitness.dispose(); contentWitness.dispose(); };
      candidateReadCleanup.current = dispose;
      try { await work(continuation); }
      finally { dispose(); if (candidateReadCleanup.current === dispose) candidateReadCleanup.current = null; }
    }, true, guidanceRevocation);
  }
  async function runChildWorkPlan(work: (current: WorkPlanContinuation) => Promise<void>, planId: string | null, sourceContentKey: readonly unknown[], recovery = false) {
    // Known queued children share Core's original concurrency budget. Only a
    // submission in flight or an unresolved intent blocks another child call.
    if (!canRunChild(recovery)) return;
    await runWorkPlan(work, planId, sourceContentKey);
  }
  function recordPlanStart(attemptId: string, planId: string, prepared: WorkPlanView, generation: string, editSeq: number, taskId: string | null = null) {
    if (!live() || !validateResponseIdentity(attemptId) || prepared.planId !== planId) return;
    update(before => ({ ...before,attempt:attemptId,planId,checkedTask:null,started:null,
      startedPlan:{prepared,attemptId,taskId,generation,unitIds:prepared.scope.map(unit=>unit.unitId)},
      capture:before.capture?.kind === "plan" && before.capture.value.planId === prepared.planId && before.capture.value.digest === prepared.digest ? null : before.capture,
      consent:false,dirty:before.editSeq === editSeq ? false : before.dirty,notice:before.editSeq === editSeq ? "started" : "newer" }));
    reads.invalidate(["execution"]);
  }
  function recordGenerated(attemptId: string) {
    if (!live() || !validateResponseIdentity(attemptId)) return;
    const pending = agent.current().pending, operation = component.current().operation;
    const captured = pending?.kind === "generation" && pending.prepared.attemptId === attemptId
      ? { prepared:pending.plan,attemptId,taskId:pending.prepared.taskId,generation:pending.generation,unitIds:pending.unitIds }
      : operation?.prepared.generation.attemptId === attemptId
        ? { prepared:operation.plan,attemptId,taskId:operation.prepared.generation.taskId,generation:operation.lease.generation,unitIds:[...operation.prepared.generation.unitIds] } : null;
    if (!captured) return;
    update(before => ({ ...before,attempt:attemptId,planId:captured.prepared.planId,checkedTask:null,started:null,startedPlan:captured }));
    reads.invalidate(["execution"]);
  }
  function settleStart(entry: StartCapture, taskId: string | null = null) {
    update(before => before.pendingStart?.request !== entry.request ? before : { ...before,pendingStart:null,checkedTask:null,attempt:entry.request.attemptId,
      started:{prepared:entry.prepared,taskId},planId:null,startedPlan:null,capture:before.capture?.kind === "direct" && before.capture.value === entry.prepared ? null : before.capture,consent:false,
      dirty:before.editSeq === entry.editSeq ? false : before.dirty,failure:null,notice:before.editSeq === entry.editSeq ? "started" : "newer" });
    if (live()) reads.invalidate(["execution"]);
  }
  async function dispatchStart(entry: StartCapture, retryingUnknown = false) {
    update(before => ({ ...before,pendingStart:entry }));
    try { await aiCommands.start(entry.request); if (live()) settleStart(entry); }
    catch (error) {
      // A rejected replay only classifies that invocation; it cannot disprove the first unknown dispatch.
      update(before => before.pendingStart?.request !== entry.request ? before : { ...before,pendingStart:retryingUnknown || hasUnknownOutcome(error) ? { ...entry,uncertain:true } : null });
      throw error;
    }
  }
  function canStart() {
    const before = current(), prepared = before.prepared;
    return live() && !reserved() && before.locale !== "" && targetLocales.includes(before.locale) && !!prepared && before.consent && connectionCurrent() && sameConfig(before.config,prepared.preview.config)
      && prepared.preview.items.length === before.selected.length && prepared.preview.items.every((item,index) => item.unitId === before.selected[index] && item.targetLocale === before.locale);
  }
  async function start() {
    if (!canStart() || !available()) return;
    const before = current(), prepared = before.prepared!;
    const entry: StartCapture = { request:fixed({ ...session,attemptId:prepared.attemptId,digest:prepared.preview.digest,confirmed:true }),prepared,editSeq:before.editSeq,uncertain:false };
    await run(() => dispatchStart(entry));
  }
  async function readView(attemptId: string) {
    const proof = current().started?.prepared.attemptId === attemptId ? current().started : null;
    const planProof = current().startedPlan?.attemptId === attemptId ? current().startedPlan : null;
    const result = await aiCommands.read({ ...session,attemptId });
    const recorded = proof && current().started?.prepared === proof.prepared ? current().started : null;
    confirmView(result,attemptId,proof?.prepared,recorded?.taskId ?? proof?.taskId);
    if (planProof) {
      confirmPlanStartView(result,planProof.prepared,attemptId,planProof.generation,planProof.taskId,planProof.unitIds);
      if (live() && current().startedPlan === planProof && planProof.taskId === null) {
        update(before => ({ ...before,startedPlan:{...planProof,taskId:result.detail.taskId} }));
      }
    }
    // Prepared/start ACKs have no TaskId. Keep only the first checked original task identity, not the mutable view.
    if (live() && recorded && recorded.taskId === null) update(before => ({ ...before,started:{...recorded,taskId:result.detail.taskId} }));
    if (live() && current().attempt === attemptId) {
      const checked = current().checkedTask;
      if (checked?.attemptId === attemptId && checked.taskId !== result.detail.taskId) invalidAck();
      if (!checked || checked.attemptId !== attemptId) update(before => ({ ...before,checkedTask:{attemptId,taskId:result.detail.taskId} }));
    }
    return result;
  }
  async function checkStart() {
    const entry = current().pendingStart;
    if (!entry) return;
    await run(async () => {
      const result = await reads.client.fetchQuery({ queryKey:reads.key(["aiCommands",entry.request.attemptId]),staleTime:0,meta:{scopes:["execution"]},
        queryFn:async () => { const value = await aiCommands.read({ ...session,attemptId:entry.request.attemptId }); confirmView(value,entry.request.attemptId,entry.prepared); return value; } });
      if (live()) settleStart(entry,result.detail.taskId);
    },true);
  }
  async function retryStart() { const entry = current().pendingStart; if (entry) await run(() => dispatchStart(entry,true),true); }
  function candidate(view: AiView, resultId: string): Candidate | null {
    if (!validateResponseIdentity(session.projectId) || !session.sessionToken || view.detail.attemptId !== current().attempt) return null;
    const proof = current().started;
    try { confirmView(view,view.detail.attemptId,proof?.prepared,proof?.taskId); } catch { return null; }
    const planProof = current().startedPlan;
    if (planProof?.attemptId === view.detail.attemptId) {
      try { confirmPlanStartView(view,planProof.prepared,view.detail.attemptId,planProof.generation,planProof.taskId,planProof.unitIds); } catch { return null; }
    }
    const row = view.rows.find(value => value.resultId === resultId), item = row && view.detail.items.find(value => value.status.itemId === row.itemId);
    const unit = row && view.detail.recovery.units.find(value => value.itemIds.includes(row.itemId));
    if (!row?.output || row.output.unitId !== row.item.unitId || row.output.targetLocale !== row.item.targetLocale
      || !item || item.resultId !== resultId || item.status.execution !== "succeeded" || item.status.validation !== "valid" || item.status.adoption === "committed"
      || item.scope.id !== row.item.unitId || item.scope.locale !== row.item.targetLocale || !unit?.actions.includes("adopt-result")
      || !validateResponseIdentity(unit.unitId) || !unit.resultIds.includes(resultId)
      || !unit.scopes.some(scope => scope.kind === "translation-unit" && scope.id === row.item.unitId && scope.locale === row.item.targetLocale)
      || !available(row.item.targetLocale) || current().saved[resultId] || row.savedRevisionId
      || (row.automation && ["waiting","saving-candidate","checking"].includes(row.automation.phase))) return null;
    return {taskId:view.detail.taskId,item:row.item,resultId,unitId:unit.unitId,text:row.output.text};
  }
  function candidateReadProof(value: Candidate, attemptId: string) {
    const witness = reads.watchExactQuery(["aiCommands",attemptId]);
    const capturedQuery = witness.current();
    const capturedState = capturedQuery?.state;
    // Direct owner callers can supply checked fixed evidence. The consumer must
    // additionally prove a current Query before dispatch. Once captured, hiding
    // its view only invalidates that read; it does not revoke the business intent.
    return {
      current() {
        const query = witness.current(), projection = query?.state.data as AiView | null | undefined;
        // A checked direct-owner read may be newer than an inactive cache entry.
        // Only that unchanged original record retains this initial exception;
        // production fresh entry points still require a successful current Query.
        return !query || (query === capturedQuery && query.state === capturedState)
          || (query.state.status === "success" && query.state.error === null
            && !!projection && JSON.stringify(candidate(projection,value.resultId)) === JSON.stringify(value));
      },
      dispose: witness.dispose,
    };
  }
  function cancellationPending(taskId: string) {
    const value = tasks.current(taskId);
    return value?.phase === "preparing" || value?.phase === "pending" || value?.phase === "checking" || value?.phase === "unknown";
  }
  function canAdopt(view: AiView, resultId: string) {
    const value = candidate(view,resultId);
    return live() && !reserved() && !!value && !cancellationPending(value.taskId) && planPermits(view);
  }
  function planPermits(view: AiView) {
    if (!view.planId) return view.planGeneration === null;
    const query = reads.client.getQueryState<WorkPlanStatusView>(reads.key(["workPlan",view.planId]));
    const status = query?.data;
    return query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null
      && !!status && status.plan.planId === view.planId && status.lease.planId === view.planId
      && status.state === "active" && status.lease.generation === view.planGeneration
      && BigInt(status.expiresAt) > BigInt(Math.floor(Date.now()/1000));
  }
  function confirmAction(entry: AdoptCapture, action: AdoptionAction) {
    const request = entry.request;
    if (action.projectId !== request.projectId || action.attemptId !== request.attemptId || action.actionId !== request.actionId || action.unitId !== request.unitId
      || action.operation !== "ai-translation" || action.parameters !== null || action.resultIds.length !== 1 || action.resultIds[0] !== entry.candidate.resultId
      || (entry.action && entry.action.cancellationRevision !== action.cancellationRevision)) invalidAck();
  }
  function confirmReceipt(entry: AdoptCapture, receipt: Receipt) {
    const request = entry.request, change = receipt.changes[0];
    if (receipt.projectId !== request.projectId || receipt.attemptId !== request.attemptId || receipt.actionId !== request.actionId || receipt.unitId !== request.unitId
      || !receipt.requestDigest || receipt.changes.length !== 1 || change?.kind !== "translation-revision" || !validateResponseIdentity(change.id) || change.revision === "0"
      || (entry.receipt && (entry.receipt.requestDigest !== receipt.requestDigest || JSON.stringify(entry.receipt.changes) !== JSON.stringify(receipt.changes)))) invalidAck();
  }
  function settleAdopt(entry: AdoptCapture, receipt: Receipt) {
    confirmReceipt(entry,receipt);
    update(before => before.pendingAdopt?.request !== entry.request ? before : { ...before,pendingAdopt:null,saved:{...before.saved,[entry.candidate.resultId]:fixed(receipt)},
      failure:null,notice:before.editSeq === entry.editSeq ? "saved" : "newer" });
    if (live()) reads.invalidate(["execution","translation"]);
  }
  async function dispatchAdopt(entry: AdoptCapture, retryingUnknown = false, proof: () => boolean = live) {
    update(before => ({ ...before,pendingAdopt:{...entry,retryAllowed:false} }));
    try {
      const action = await executionCommands.prepare(entry.request);
      if (!live()) return;
      const original = current().pendingAdopt;
      if (original?.request !== entry.request) return;
      confirmAction(original,action);
      update(before => ({ ...before,pendingAdopt:before.pendingAdopt && {...before.pendingAdopt,action:fixed(action)} }));
      if (!proof()) throw { field:"ai-preview" };
      const receipt = await executionCommands.adopt({ ...session,actionId:entry.request.actionId });
      if (live()) settleAdopt(current().pendingAdopt ?? entry,receipt);
    } catch (error) {
      // Retain both the exact request and checked partial proof across an unknown original replay.
      update(before => before.pendingAdopt?.request !== entry.request ? before : { ...before,pendingAdopt:retryingUnknown || hasUnknownOutcome(error)
        ? {...before.pendingAdopt,uncertain:true,retryAllowed:false} : null });
      if (hasUnknownOutcome(error) && live() && current().pendingAdopt?.request === entry.request) {
        await lookupAdoption(entry,commandFailure(error,"outcome-unknown")); return;
      }
      throw error;
    }
  }
  async function lookupAdoption(entry: AdoptCapture, originalFailure = current().failure) {
    if (!live() || current().pendingAdopt?.request !== entry.request) return;
    update(before => ({...before,failure:null,pendingAdopt:before.pendingAdopt && {...before.pendingAdopt,checking:true,retryAllowed:false}}));
    try {
      const result = await executionCommands.adoptionAction(entry.request);
      if (!live() || current().pendingAdopt?.request !== entry.request) return;
      let checked = current().pendingAdopt!;
      if (!validateResponseAdoptionAction(result)) invalidAck();
      if (result === null) { if (checked.receipt) invalidAck(); }
      else {
        if (result.receipt !== null) {
          confirmReceipt(checked,result.receipt); checked = {...checked,receipt:fixed(result.receipt)};
          update(before => ({...before,pendingAdopt:checked}));
        } else if (checked.receipt) invalidAck();
        confirmAction(checked,result.action); checked = {...checked,action:fixed(result.action)};
        update(before => ({...before,pendingAdopt:checked}));
        if (checked.receipt) { settleAdopt(checked,checked.receipt); return; }
      }
      update(before => ({...before,failure:originalFailure,pendingAdopt:{...checked,checking:false,retryAllowed:true}}));
    } catch (error) {
      update(before => before.pendingAdopt?.request !== entry.request ? before : {...before,failure:commandFailure(error,"outcome-unknown"),
        pendingAdopt:{...before.pendingAdopt,checking:false,uncertain:true,retryAllowed:false}});
    }
  }
  async function adopt(view: AiView, resultId: string) {
    if (!canAdopt(view,resultId)) return;
    const value = candidate(view,resultId);
    if (!value) return;
    const captured = fixed(value), version = basis.current, editSeq = current().editSeq, attemptId = view.detail.attemptId;
    await run(async () => {
      const readProof = candidateReadProof(captured,attemptId);
      const planWitness = view.planId ? reads.watchExactQuery(["workPlan",view.planId]) : null;
      const originalPlanValue = planWitness?.current()?.state.data;
      const originalPlan = validateResponseWorkPlanStatus(originalPlanValue) ? originalPlanValue : null;
      const dispose = () => { readProof.dispose(); planWitness?.dispose(); };
      candidateReadCleanup.current = dispose;
      const proof = () => live() && version === basis.current && current().attempt === attemptId && available(captured.item.targetLocale)
        && !cancellationPending(captured.taskId) && readProof.current() && (!planWitness || (() => {
          const query = planWitness.current(), value = query?.state.data;
          const status = validateResponseWorkPlanStatus(value) ? value : null;
          return query?.state.status === "success" && query.state.error === null && !!status && !!originalPlan
            && status.plan.planId === view.planId && status.lease.planId === view.planId
            && status.lease.generation === view.planGeneration && status.state === "active"
            && status.plan.digest === originalPlan.plan.digest && BigInt(status.expiresAt) > BigInt(Math.floor(Date.now()/1000));
        })());
      try {
        const actionId = await executionCommands.identity(session);
        if (!proof()) return;
        const entry: AdoptCapture = {request:fixed({...session,attemptId,unitId:captured.unitId,actionId,resultIds:[captured.resultId]}),candidate:captured,editSeq,
          action:null,receipt:null,uncertain:false,retryAllowed:false,checking:false};
        await dispatchAdopt(entry,false,proof);
      } finally {
        dispose();
        if (candidateReadCleanup.current === dispose) candidateReadCleanup.current = null;
      }
    });
  }
  async function checkAdoption() {
    const entry = current().pendingAdopt;
    if (!entry) return;
    const originalFailure = current().failure;
    await run(() => lookupAdoption(entry,originalFailure),true);
  }
  async function retryAdoption() { const entry = current().pendingAdopt; if (entry?.retryAllowed) await run(() => dispatchAdopt(entry,true),true); }
  function showAttempt(attempt: string) {
    if (!live() || reserved() || current().dirty || !validateResponseIdentity(attempt)) return false;
    update(before => ({ ...before,attempt,checkedTask:before.checkedTask?.attemptId === attempt ? before.checkedTask : null,planId:before.startedPlan?.attemptId === attempt ? before.planId : null,
      startedPlan:before.startedPlan?.attemptId === attempt ? before.startedPlan : null,
      started:before.started?.prepared.attemptId === attempt ? before.started : null,failure:null,notice:null })); return true;
  }
  function reset() {
    if (!live() || reserved() || discussions.blocked() || recovery.blocked() || guidance.blocked()) return false;
    if (!discussions.discard() || !recovery.discard() || !guidance.discard()) return false;
    defaultCaptureSequence.current = current().editSeq + 1;
    basis.current++; planControl.reset(); agent.reset(); component.reset();
    update(before => ({ ...before,maintenance:null,presetName:"custom",config:newDraftConfig(),locale:initialLocale,selected:[],selectedSnapshotId:null,capture:null,consent:false,staleReason:null,strategyDefault:"loading",strategyDefaultFailure:null,
      dirty:false,editSeq:before.editSeq+1,attempt:null,checkedTask:null,started:null,startedPlan:null,planId:null,options:fixed(defaultPlanOptions),toolDraft:null,teamDraft:null,mcpDraft:null,advisoryChecks:[],failure:null,notice:null })); defaultWait.current = loadStrategyDefault(); return true;
  }
  const contentToolAttempt = agent.current().toolRun?.prepared.attemptId ?? null;
  const subscribeContentAvailability = useCallback((notify: () => void) => reads.client.getQueryCache().subscribe(event => {
    if (matchQuery({ queryKey: reads.key(["aiCommands",state.attempt]), exact: true }, event.query)
      || contentToolAttempt !== null && matchQuery({ queryKey: reads.key(["agent-tool-attempt",contentToolAttempt]), exact: true }, event.query)) notify();
  }), [reads,state.attempt,contentToolAttempt]);
  const contentRangeAvailable = useSyncExternalStore(subscribeContentAvailability, canReceiveContentSelection, canReceiveContentSelection);
  return { ...state, prepared: current().prepared, preparedPlan: current().preparedPlan, contentRangeAvailable,
    planControl, agent, component, discussions, recovery, guidance, canOpenTeamToolHistory,
    mcpOriginal: mcp, canReceiveMcpQuery, receiveMcpQuery, mcpScopeCurrent, setMcpConsent, clearMcpQuery,
    canOpenRecoveryTask: (taskId: string, attemptId: string) => live() && !parentReserved(true) && recovery.taskReferences().some(reference => reference.taskId === taskId && reference.attemptId === attemptId), captureMaintenance, editMaintenance, discardMaintenance, preparePlan, readPlan, readPlanForAction, readViewForAction, runWorkPlan, runChildWorkPlan, canRunChild, canOpenChildHistory, recordPlan, recordPlanStart, recordGenerated, retryEffect:async(attemptId:string,itemId:string)=>{await aiCommands.retryEffect({...session,attemptId,itemId});if(live())reads.invalidate(["execution","translation","review"]);},
    setOptions:(value:SetStateAction<PlanOptions>) => edit("options",typeof value === "function" ? value(current().options) : value),
    setToolDraft:(value:PlanToolDraft|null) => {
      edit("toolDraft",value);
      if(!value?.entries.length&&current().options.toolGuidance){
        const options={...current().options};delete options.toolGuidance;
        update(before=>({...before,options:fixed(options)}));
      }
    },
    setTeamDraft:(value:TeamExecutionDraft|null) => edit("teamDraft",value), editTeamConfig, selectTeamConnection,
    setAdvisoryChecks:(value:PluginTextReviewSelection[]) => edit("advisoryChecks",value),
    current,reserved,targetAvailable,connectionCurrent,selectConnection,canPreview,preview,canStart,start,checkStart,retryStart,readView,canAdopt,adopt,checkAdoption,retryAdoption,showAttempt,reset,invalidatePreview,receiveContentSelection,canReceiveContentSelection,loadStrategyDefault,
    setPresetName:(value:SetStateAction<string>) => edit("presetName",typeof value === "function" ? value(current().presetName) : value),
    setConfig:(value:SetStateAction<AiConfig>) => edit("config",editedAiConfig(current().config, typeof value === "function" ? value(current().config) : value)),
    setLocale:(value:SetStateAction<string>) => edit("locale",typeof value === "function" ? value(current().locale) : value),
    setSelected:(value:SetStateAction<string[]>, snapshotId?: string | null) => {
      if (!live()) return;
      const selected = typeof value === "function" ? value(current().selected) : value;
      const scope = reads.client.getQueryData(reads.key(["source-scope"]));
      const selectedSnapshotId = selected.length ? snapshotId ?? (validateResponseScope(scope) ? scope.currentSnapshot : null) : null;
      edit("selected",selected); update(before => ({ ...before,selectedSnapshotId }));
    },
    clearSelectedRange:() => { if (!reserved()) { edit("selected",[]); update(before => ({ ...before,selectedSnapshotId:null })); } },
    setConsent:(consent:boolean) => { if (!reserved() && (current().prepared || current().preparedPlan?.preview) && available()
      && (!consent || connectionCurrent() && (!current().preparedPlan?.options.mcpTermQuery || mcpScopeCurrent()))) update(before => ({ ...before,consent })); }
  };
}
type Preparation = ReturnType<typeof usePreparation>;
const PreparationContext = createContext<Preparation | null>(null);
export function AiPreparationSession({initialLocale,targetLocales,mcp,children}:{initialLocale:string;targetLocales:readonly string[];mcp?:McpRetrievalSession;children:ReactNode}) {
  return <PreparationContext.Provider value={usePreparation(initialLocale,targetLocales,mcp)}>{children}</PreparationContext.Provider>;
}
export function useAiPreparation() {
  const owner = useContext(PreparationContext);
  if (!owner) throw new Error("AI preparation requires a project session owner");
  return owner;
}
