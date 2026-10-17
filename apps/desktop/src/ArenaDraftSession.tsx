import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { arenaCommands, defaultArenaConfig, confirmArenaComparison, confirmArenaMerge, confirmArenaComparisonAction, confirmArenaMergeAction, type ArenaConfig, type ArenaPrepared, type ArenaView, type ComparisonView, type CompareRequest, type MergeRequest } from "./arenaCommands";
import type { StartRequest, RevealRequest } from "./generated/arena.requests";
import { executionCommands, type AdoptionAction, type PrepareRequest, type Receipt } from "./executionCommands";
import { translationCommands, confirmTranslationSelection, type TranslationSelectRequest, type TranslationSelection } from "./translationCommands";
import { validateResponseIdentity, validateResponseAction, validateResponseAdoption, validateResponseAdoptionAction } from "./generated/execution.validators";
import { validateResponsePrepared, validateResponseView, validateResponseComparison, validateResponseStartAction, validateResponseRevealTarget } from "./generated/arena.validators";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionReads, useSessionAlive } from "./SessionReadProvider";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { editedAiConfig, sameAiConfig, validSourceContextSelection, type AiConfig, type AiItem } from "./aiCommands";
import { connectionConfigCurrent, useConnectionFacts } from "./ApplicationReadProvider";
import type { ConnectionReadView } from "./connectionCommands";
import type { InfiniteData, QueryKey } from "@tanstack/react-query";
import type { TranslationHistory } from "./translationCommands";

interface MergeCapture {
  comparisonId: string; unitId: string; locale: string; sourceRevisionId: string; sourceText: string; nativeKey: string;
  selectionId: string | null; basis: string; rows: { revisionId: string; sourceRevisionId: string; text: string }[];
}
interface MergeDraft { basis: MergeCapture; text: string; editSeq: number; stale: boolean }
interface Candidate { taskId: string; itemId: string; item: AiItem; resultId: string; unitId: string; text: string }
interface PendingState { editSeq: number; uncertain: boolean; retryAllowed: boolean }
type Pending = PendingState & (
  | { kind: "start"; request: StartRequest; prepared: ArenaPrepared; checking: boolean }
  | { kind: "compare"; request: CompareRequest; checking: boolean }
  | { kind: "reveal"; request: RevealRequest; targetKind: "attempt" | "comparison"; checking: boolean; targetMissing: boolean }
  | { kind: "select"; request: TranslationSelectRequest; receipt: TranslationSelection | null; checking: boolean }
  | { kind: "merge"; request: MergeRequest; draftSeq: number; receipt: TranslationSelection | null; checking: boolean }
  | { kind: "adopt"; request: PrepareRequest; candidate: Candidate; action: AdoptionAction | null; receipt: Receipt | null; checking: boolean }
);
interface State {
  config: ArenaConfig; locale: string; selected: string[]; prepared: ArenaPrepared | null; consent: boolean;
  dirty: boolean; editSeq: number; sourceGeneration: number; staleReason: "source" | "preview" | "connection" | null;
  unit: string; references: string[]; comparisonBlind: boolean; comparisonId: string | null; draft: MergeDraft | null;
  attempt: string | null; started: { prepared: ArenaPrepared; taskId: string | null } | null;
  pending: Pending | null; saved: Record<string, Receipt>; busy: boolean; failure: CommandFailure | null;
  notice: "saved" | "merged" | "selected" | "reconciled" | "repeatCost" | "identitiesVisible" | null;
}
const aiLimits = [["maxItems",1,100],["concurrency",1,2],["maxRequests",1,300],["maxOutputTokens",1,16384],["maxRetries",0,2],["timeoutSeconds",1,120]] as const;
function sameConfig(left: ArenaConfig, right: ArenaConfig) {
  return left.maxItems === right.maxItems && left.maxRequests === right.maxRequests && left.concurrency === right.concurrency && left.blind === right.blind
    && (left.parentAttemptId ?? null) === (right.parentAttemptId ?? null) && left.variants.length === right.variants.length
    && left.variants.every((variant,index) => sameAiConfig(variant,right.variants[index]));
}
function validConfig(config: ArenaConfig, count: number) {
  return config.variants.length >= 2 && config.variants.length <= 4 && Number.isInteger(config.maxItems) && config.maxItems >= 1 && config.maxItems <= 100
    && count > 0 && count <= config.maxItems && count * config.variants.length <= 100
    && Number.isInteger(config.maxRequests) && config.maxRequests >= count * config.variants.length && config.maxRequests <= 300
    && Number.isInteger(config.concurrency) && config.concurrency >= 1 && config.concurrency <= 2
    && config.variants.every(variant => validSourceContextSelection(variant.sourceContext)
      && aiLimits.every(([key,min,max]) => Number.isInteger(variant[key]) && variant[key] >= min && variant[key] <= max));
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function fixed<T>(value: T): T { return freeze(structuredClone(value)); }
function invalidAck(): never { throw new Error("Invalid Arena business acknowledgement"); }
function itemProof(item: AiItem) {
  return JSON.stringify([item.unitId,item.sourceRevisionId,item.sourceSnapshotId,item.nativeKey,item.sourceLocale,item.sourceText,item.targetLocale,item.resourceBaseline,
    item.terms.map(term => [term.revisionId,term.source,term.target,term.protected]),
    item.context ? [item.context.revisionId,item.context.previousRevisionId,item.context.unitId,item.context.locale,item.context.text,item.context.reason] : null,item.sourceContext,item.projectContext,item.omissions]);
}
function sourceProof(item: AiItem) {
  return JSON.stringify([item.unitId,item.sourceRevisionId,item.sourceSnapshotId,item.nativeKey,item.sourceLocale,item.sourceText,item.targetLocale]);
}
function validItem(item: AiItem) {
  return [item.unitId,item.sourceRevisionId,item.sourceSnapshotId,...item.terms.map(term => term.revisionId)].every(validateResponseIdentity)
    && (!item.context || [item.context.revisionId,item.context.unitId,...(item.context.previousRevisionId ? [item.context.previousRevisionId] : [])].every(validateResponseIdentity));
}
function multiset(values: string[]) { return JSON.stringify(values.sort()); }
function permutations(values: number[]): number[][] {
  return values.length ? values.flatMap(value => permutations(values.filter(other => other !== value)).map(rest => [value,...rest])) : [[]];
}
/** Labels are persisted display positions, not the preview's original variant slots. */
export function confirmArenaView(view: ArenaView, attemptId: string, prepared?: ArenaPrepared, taskId: string | null = null) {
  if (!validateResponseView(view) || view.detail.attemptId !== attemptId || view.detail.recovery.attemptId !== attemptId || view.detail.operation !== "arena-translation"
    || !validateResponseIdentity(view.detail.taskId) || (taskId !== null && view.detail.taskId !== taskId) || !view.rows.length || view.rows.length > 100
    || view.detail.nextOffset !== null || view.rows.length !== view.detail.items.length || view.rows.length !== view.detail.progress.total) invalidAck();
  const details = new Map(view.detail.items.map(item => [item.status.itemId,item]));
  const resultIds = view.rows.flatMap(row => row.resultId === null ? [] : [row.resultId]);
  const orders = [...new Set(view.rows.map(row => row.sourceOrder))].sort((a,b) => a-b);
  const labels = [...new Set(view.rows.map(row => row.label))].sort((a,b) => a-b);
  if (details.size !== view.rows.length || new Set(view.rows.map(row => row.itemId)).size !== view.rows.length
    || new Set(resultIds).size !== resultIds.length || orders.some((order,index) => order !== index) || labels.length < 2 || labels.length > 4
    || labels.some((label,index) => label !== index) || orders.length * labels.length !== view.rows.length
    || new Set(view.rows.map(row => `${row.sourceOrder}:${row.label}`)).size !== view.rows.length
    || view.detail.recovery.units.length !== view.rows.length || new Set(view.detail.recovery.units.map(unit => unit.unitId)).size !== view.rows.length
    || (view.blind && !view.revealed ? view.variants !== null : view.variants?.length !== labels.length)
    || (!view.blind && !view.revealed)) invalidAck();
  const sources = orders.map(order => view.rows.find(row => row.sourceOrder === order)!.item);
  if (new Set(sources.map(item => item.unitId)).size !== sources.length
    || sources.some(item => item.sourceSnapshotId !== sources[0].sourceSnapshotId || item.targetLocale !== sources[0].targetLocale)) invalidAck();
  for (const row of view.rows) {
    const detail = details.get(row.itemId), units = view.detail.recovery.units.filter(unit => unit.itemIds.includes(row.itemId));
    const unit = units[0];
    if (!validateResponseIdentity(row.itemId) || !validItem(row.item) || (row.resultId !== null && !validateResponseIdentity(row.resultId))
      || sourceProof(row.item) !== sourceProof(sources[row.sourceOrder]) || !detail || detail.resultId !== row.resultId
      || detail.scope.kind !== "translation-unit" || detail.scope.id !== row.item.unitId || detail.scope.locale !== row.item.targetLocale
      || (row.output && (row.output.unitId !== row.item.unitId || row.output.targetLocale !== row.item.targetLocale || row.resultId === null))
      || units.length !== 1 || !validateResponseIdentity(unit.unitId) || unit.itemIds.length !== 1 || unit.itemIds[0] !== row.itemId
      || unit.scopes.length !== 1 || unit.scopes[0].kind !== "translation-unit" || unit.scopes[0].id !== row.item.unitId || unit.scopes[0].locale !== row.item.targetLocale
      || unit.resultIds.length !== (row.resultId === null ? 0 : 1) || (row.resultId !== null && unit.resultIds[0] !== row.resultId)
      || unit.remainingItemIds.some(id => id !== row.itemId)) invalidAck();
  }
  if (prepared && (prepared.attemptId !== attemptId || view.blind !== prepared.preview.config.blind
    || (view.parentAttemptId ?? null) !== (prepared.preview.config.parentAttemptId ?? null) || labels.length !== prepared.preview.config.variants.length
    || prepared.preview.items.length !== view.rows.length || orders.some(order => multiset(view.rows.filter(row => row.sourceOrder === order).map(row => itemProof(row.item)))
      !== multiset(prepared.preview.items.filter(row => row.sourceOrder === order).map(row => itemProof(row.item)))))) invalidAck();
  if (prepared && !permutations(labels).some(displayOrder => view.rows.every(row => {
    const original = prepared.preview.items.find(item => item.sourceOrder === row.sourceOrder && item.slot === displayOrder[row.label]);
    return !!original && itemProof(original.item) === itemProof(row.item)
      && (!view.variants || sameAiConfig(view.variants[row.label],prepared.preview.config.variants[displayOrder[row.label]]));
  }))) invalidAck();
  // A blind read omits configurations and the digest. Core's original request digest remains authoritative.
}
function comparisonBasis(view: ComparisonView) {
  return JSON.stringify([view.comparisonId,view.unitId,view.locale,view.sourceRevisionId,view.sourceText,view.selectionId,view.basis,
    view.rows.map(row => [row.revisionId,row.sourceRevisionId,row.text,row.basisCurrent,row.candidateDisposition])]);
}
function confirmComparisonRead(view: ComparisonView, comparisonId: string) {
  if (!validateResponseComparison(view) || view.comparisonId !== comparisonId || view.rows.length < 2 || view.rows.length > 4
    || new Set(view.rows.map(row => row.revisionId)).size !== view.rows.length
    || (!view.blind && !view.revealed)
    || (view.blind && !view.revealed && view.rows.some(row => row.model !== null || row.recipe !== null))) invalidAck();
}

function useArenaOwner(project: ProjectView) {
  const reads = useSessionReads(), translations = useTranslationDraftSession(), tasks = useExecutionTaskSession();
  const connections = useConnectionFacts();
  const [session] = useState(() => Object.freeze({ ...reads.context }));
  const [state,setState] = useState<State>(() => freeze({config:defaultArenaConfig(),locale:project.metadata.targetLocales[0] ?? "",selected:[],prepared:null,consent:false,
    dirty:false,editSeq:0,sourceGeneration:0,staleReason:null,unit:"",references:[],comparisonBlind:false,comparisonId:null,draft:null,
    attempt:null,started:null,pending:null,saved:{},busy:false,failure:null,notice:null}));
  const stateRef = useRef(state), projectRef = useRef(project), draftsRef = useRef(translations), tasksRef = useRef(tasks), mounted = useSessionAlive();
  const version = useRef(0), flight = useRef<object | null>(null), mutation = useRef<symbol | null>(null);
  const queryCleanup = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const sourceChanged = projectRef.current.metadata.sourceLocale !== project.metadata.sourceLocale;
    projectRef.current = project; draftsRef.current = translations; tasksRef.current = tasks;
    if (sourceChanged) revoke("source");
  }, [project,translations,tasks]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; queryCleanup.current?.(); queryCleanup.current = null; if (mutation.current) draftsRef.current.releaseMutation(mutation.current); mutation.current = null; }; }, []);
  function current() { return stateRef.current; }
  function live() { return mounted.current && projectRef.current.sessionToken === session.sessionToken && projectRef.current.metadata.projectId === session.projectId
    && reads.context.sessionToken === session.sessionToken && reads.context.projectId === session.projectId; }
  function update(change: (before: State) => State) { if (live()) { stateRef.current = freeze(change(current())); setState(stateRef.current); } }
  function available(locale = current().locale) { return !!locale && projectRef.current.metadata.targetLocales.includes(locale); }
  function reserved() { return !!flight.current || !!current().pending; }
  function connectionCurrent() { return current().config.variants.every(config => connectionConfigCurrent(connections.current(), config)); }
  function selectConnection(slot: number, view: ConnectionReadView | null, id: string, expectedEditSeq: number) {
    const before = current(), config = before.config.variants[slot];
    if (!live() || reserved() || !config || before.editSeq !== expectedEditSeq) return false;
    let next: AiConfig;
    if (!id) next = { ...config, connectionProfile: null };
    else {
      if (!view || connections.current() !== view) return false;
      const reference = view.references.find(value => value.profileId === id), profile = view.snapshot.profiles.find(value => value.id === id && !value.archived);
      if (!reference || !profile) return false;
      next = { ...config, ...profile.connection, connectionProfile: reference };
    }
    edit("config", { ...before.config, variants: before.config.variants.map((value, index) => index === slot ? next : value) }); return true;
  }
  function reserveTranslation() { if (mutation.current) return false; mutation.current = draftsRef.current.reserveMutation(); return mutation.current !== null; }
  function releaseTranslation() { const token = mutation.current; mutation.current = null; if (token) draftsRef.current.releaseMutation(token); }
  async function run(work: () => Promise<void>, recovery = false) {
    if (!live() || flight.current || (!recovery && current().pending)) return;
    const ticket = {}; flight.current = ticket;
    update(before => ({ ...before,busy:true,failure:null }));
    try { await work(); } catch (error) { update(before => ({ ...before,failure:commandFailure(error,"outcome-unknown") })); }
    finally { if (live() && flight.current === ticket) { flight.current = null; if (!current().pending) releaseTranslation(); update(before => ({ ...before,busy:false })); } }
  }
  async function withQueryProof<T>(key: QueryKey, matchesProjection: (value: T) => boolean, work: (proof: () => boolean) => Promise<void>) {
    const witness = reads.watchExactQuery(key);
    queryCleanup.current = witness.dispose;
    // Evicting a hidden view does not revoke a captured operation. A newer exact record still governs it.
    const proof = () => {
      const query = witness.current();
      return !query || (query.state.status === "success" && query.state.error === null && query.state.data !== undefined && matchesProjection(query.state.data as T));
    };
    try { await work(proof); }
    finally { witness.dispose(); if (queryCleanup.current === witness.dispose) queryCleanup.current = null; }
  }
  function revoke(reason: State["staleReason"]) {
    version.current++;
    update(before => ({ ...before,prepared:null,consent:false,staleReason:reason,draft:before.draft ? {...before.draft,stale:true} : null }));
  }
  useLayoutEffect(() => {
    const view = connections.current(), before = current();
    if (view && !reserved() && (before.prepared || before.consent) && !before.config.variants.every(config => connectionConfigCurrent(view, config))) {
      version.current++; update(value => ({ ...value, prepared: null, consent: false, staleReason: "connection" }));
    }
  }, [connections.state, state.busy, state.pending, state.config, state.prepared, state.consent]);
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(scope => scope === "project" || scope === "source" || scope === "resources")) {
      revoke(scopes.includes("source") ? "source" : "preview");
      if (scopes.includes("project") || scopes.includes("source")) update(before => ({...before,sourceGeneration:before.sourceGeneration+1}));
    } else if (scopes.includes("translation")) {
      version.current++; update(before => ({...before,draft:before.draft ? {...before.draft,stale:true} : null}));
    }
  }), [reads]);
  const targetAvailable = project.metadata.targetLocales.includes(state.locale) && state.locale !== "";
  useLayoutEffect(() => { if (!targetAvailable) revoke(null); }, [targetAvailable]);
  function edit<K extends "config" | "locale" | "selected" | "references" | "comparisonBlind">(key: K, value: SetStateAction<State[K]>) {
    const before = current(), next = typeof value === "function" ? (value as (old: State[K]) => State[K])(before[key]) : value;
    version.current++;
    update(value => ({ ...value,[key]:fixed(next),dirty:true,editSeq:value.editSeq+1,failure:null,notice:null,
      ...(["config","locale","selected"].includes(key) ? {prepared:null,consent:false,staleReason:null} : {}),
      ...(key === "locale" ? {unit:"",references:[],comparisonId:null,...(next!==before.locale?{config:fixed({...value.config,variants:value.config.variants.map(variant=>({...variant,contextStrategy:null}))})}:{})} : {}) }));
  }
  function canPreview() {
    const before = current();
    return live() && !reserved() && project.metadata.targetLocales.includes(before.locale) && !!before.locale
      && validateResponseIdentity(session.projectId) && before.selected.length > 0 && connectionCurrent();
  }
  async function preview() {
    const before = current(), ticket = version.current;
    if (!canPreview() || !available()) return;
    const request = fixed({...session,config:before.config,locale:before.locale,unitIds:before.selected});
    await run(async () => {
      if (!validConfig(request.config,request.unitIds.length)) throw {field:"arena-limits"};
      if (new Set(request.unitIds).size !== request.unitIds.length || request.unitIds.some(id => !validateResponseIdentity(id))) throw {field:"ai-source"};
      const result = await arenaCommands.preview(request);
      if (!live() || version.current !== ticket || !available(request.locale)) return;
      if (!validateResponsePrepared(result) || !sameConfig(result.preview.config,request.config) || !result.preview.digest
        || result.preview.items.length !== request.unitIds.length * request.config.variants.length
        || result.preview.items.some((row,index) => !validItem(row.item) || row.sourceOrder !== Math.floor(index / request.config.variants.length)
          || row.slot !== index % request.config.variants.length || row.item.unitId !== request.unitIds[row.sourceOrder] || row.item.targetLocale !== request.locale)) invalidAck();
      const first = result.preview.items[0].item;
      if (result.preview.items.some(row => row.item.sourceSnapshotId !== first.sourceSnapshotId
        || sourceProof(row.item) !== sourceProof(result.preview.items[row.sourceOrder * request.config.variants.length].item))) invalidAck();
      update(value => ({...value,prepared:fixed(result),consent:false,staleReason:null}));
    });
  }
  function matches(entry: Pending) { return live() && current().pending?.request === entry.request; }
  function replace(entry: Pending) { update(before => before.pending?.request === entry.request ? {...before,pending:entry} : before); }
  function settle(entry: Pending, notice: State["notice"], taskId: string | null = null) {
    if (!matches(entry)) return;
    update(before => ({ ...before,pending:null,failure:null,notice,
      dirty:before.editSeq === entry.editSeq && (entry.kind === "start" || entry.kind === "compare") ? false : before.dirty,
      ...(entry.kind === "start" ? {attempt:entry.request.attemptId,started:{prepared:entry.prepared,taskId},prepared:before.prepared === entry.prepared ? null : before.prepared,consent:false} : {}),
      ...(entry.kind === "compare" ? {comparisonId:entry.request.actionId} : {}),
      ...(entry.kind === "merge" && before.draft?.editSeq === entry.draftSeq ? {draft:null} : {}),
      ...(entry.kind === "adopt" && entry.receipt ? {saved:{...before.saved,[entry.candidate.resultId]:entry.receipt}} : {}) }));
    releaseTranslation();
    reads.invalidate(entry.kind === "adopt" ? ["execution","translation","arena"] : entry.kind === "start" ? ["execution","arena"]
      : entry.kind === "merge" || entry.kind === "select" ? ["translation","arena"] : ["arena"]);
  }
  function confirmSelection(entry: Extract<Pending,{kind:"select" | "merge"}>, result: TranslationSelection) {
    if (entry.kind === "select") confirmTranslationSelection(entry.request,result); else confirmArenaMerge(entry.request,result);
    if (entry.receipt && JSON.stringify(entry.receipt) !== JSON.stringify(result)) invalidAck();
  }
  function confirmAction(entry: Extract<Pending,{kind:"adopt"}>, action: AdoptionAction) {
    const request = entry.request;
    if (!validateResponseAction(action) || action.projectId !== request.projectId || action.attemptId !== request.attemptId || action.actionId !== request.actionId
      || action.unitId !== request.unitId || action.operation !== "arena-translation" || action.parameters !== null
      || action.resultIds.length !== 1 || action.resultIds[0] !== entry.candidate.resultId
      || (entry.action && entry.action.cancellationRevision !== action.cancellationRevision)) invalidAck();
  }
  function confirmReceipt(entry: Extract<Pending,{kind:"adopt"}>, receipt: Receipt) {
    const request = entry.request, change = receipt.changes[0];
    if (!validateResponseAdoption(receipt) || receipt.projectId !== request.projectId || receipt.attemptId !== request.attemptId || receipt.actionId !== request.actionId
      || receipt.unitId !== request.unitId || !/^[a-f0-9]{64}$/.test(receipt.requestDigest) || receipt.changes.length !== 1 || change?.kind !== "translation-revision"
      || !validateResponseIdentity(change.id) || BigInt(change.revision) <= 0n
      || (entry.receipt && (entry.receipt.requestDigest !== receipt.requestDigest || JSON.stringify(entry.receipt.changes) !== JSON.stringify(receipt.changes)))) invalidAck();
  }
  async function dispatch(entry: Pending, replay = false, proof: () => boolean = live) {
    if (!live()) return;
    update(before => ({...before,pending:{...entry,retryAllowed:false},notice:null}));
    try {
      if (entry.kind === "start") { await arenaCommands.start(entry.request); if (matches(entry)) settle(entry,null); }
      else if (entry.kind === "compare") {
        const result = await arenaCommands.compare(entry.request);
        if (!matches(entry)) return;
        confirmArenaComparison(entry.request,result); confirmComparisonRead(result,entry.request.actionId);
        reads.client.setQueryData(reads.key(["arena-comparison",entry.request.actionId]),result);
        settle(entry,null);
      } else if (entry.kind === "reveal") { await arenaCommands.reveal(entry.request); if (matches(entry)) settle(entry,"identitiesVisible"); }
      else if (entry.kind === "select" || entry.kind === "merge") {
        const result = entry.kind === "select" ? await translationCommands.select(entry.request) : await arenaCommands.merge(entry.request);
        if (!matches(entry)) return;
        confirmSelection(entry,result); replace({...entry,receipt:fixed(result)}); settle(entry,entry.kind === "select" ? "selected" : "merged");
      } else {
        const action = await executionCommands.prepare(entry.request);
        if (!matches(entry)) return;
        const original = current().pending;
        if (original?.kind !== "adopt") return;
        confirmAction(original,action); replace({...original,action:fixed(action)});
        if (!proof()) throw {field:"arena-basis"};
        const receipt = await executionCommands.adopt({...session,actionId:entry.request.actionId});
        if (!matches(entry)) return;
        const captured = current().pending;
        if (captured?.kind !== "adopt") return;
        confirmReceipt(captured,receipt); const checked = {...captured,receipt:fixed(receipt)};
        replace(checked); settle(checked,"saved");
      }
    } catch (error) {
      if (matches(entry)) {
        if (replay || entry.uncertain || hasUnknownOutcome(error)) {
          update(before => before.pending ? {...before,pending:{...before.pending,uncertain:true,retryAllowed:false}} : before);
        } else { update(before => ({...before,pending:null})); releaseTranslation(); }
      }
      if (hasUnknownOutcome(error) && matches(entry)) {
        if (entry.kind === "adopt") { await lookupAdoption(entry,commandFailure(error,"outcome-unknown")); return; }
        if (entry.kind === "start") { await lookupStart(entry,commandFailure(error,"outcome-unknown")); return; }
        if (entry.kind === "compare") { await lookupComparison(entry,commandFailure(error,"outcome-unknown")); return; }
        if (entry.kind === "reveal") { await lookupReveal(entry,commandFailure(error,"outcome-unknown")); return; }
        if (entry.kind === "select" || entry.kind === "merge") { await lookupSelection(entry,commandFailure(error,"outcome-unknown")); return; }
      }
      throw error;
    }
  }
  async function lookupReveal(entry: Extract<Pending,{kind:"reveal"}>, originalFailure = current().failure) {
    if (!matches(entry)) return;
    replace({...entry,checking:true,uncertain:true,retryAllowed:false,targetMissing:false}); update(before => ({...before,failure:null}));
    try {
      const result = await arenaCommands.revealTarget({sessionToken:entry.request.sessionToken,
        projectId:entry.request.projectId,comparisonId:entry.request.comparisonId});
      if (!matches(entry)) return;
      if (!validateResponseRevealTarget(result) || result !== null && (result.projectId !== entry.request.projectId
        || result.targetId !== entry.request.comparisonId || result.targetKind !== entry.targetKind)) invalidAck();
      // This proves the target goal, including a reveal recorded by another request.
      if (result?.visible === true) { settle(entry,"identitiesVisible"); return; }
      replace({...entry,checking:false,uncertain:true,retryAllowed:result !== null,targetMissing:result === null});
      update(before => ({...before,failure:originalFailure}));
    } catch (error) {
      if (!matches(entry)) return;
      replace({...entry,checking:false,uncertain:true,retryAllowed:false,targetMissing:false});
      update(before => ({...before,failure:commandFailure(error,"outcome-unknown")}));
    }
  }
  async function lookupComparison(entry: Extract<Pending,{kind:"compare"}>, originalFailure = current().failure) {
    if (!matches(entry)) return;
    replace({...entry,checking:true,uncertain:true,retryAllowed:false}); update(before => ({...before,failure:null}));
    try {
      const result = await arenaCommands.comparisonAction(entry.request);
      if (!matches(entry)) return;
      if (confirmArenaComparisonAction(entry.request,result) !== null) { settle(entry,"reconciled"); return; }
      replace({...entry,checking:false,uncertain:true,retryAllowed:true}); update(before => ({...before,failure:originalFailure}));
    } catch (error) {
      if (!matches(entry)) return;
      replace({...entry,checking:false,uncertain:true,retryAllowed:false}); update(before => ({...before,failure:commandFailure(error,"outcome-unknown")}));
    }
  }
  async function lookupSelection(entry: Extract<Pending,{kind:"select" | "merge"}>, originalFailure = current().failure) {
    if (!matches(entry)) return;
    replace({...entry,checking:true,uncertain:true,retryAllowed:false}); update(before => ({...before,failure:null}));
    try {
      let receipt: TranslationSelection | null;
      if (entry.kind === "select") receipt = await translationCommands.selectionAction(entry.request);
      else {
        const result = await arenaCommands.mergeAction(entry.request);
        if (!matches(entry)) return;
        const confirmed = confirmArenaMergeAction(entry.request,result);
        receipt = confirmed === null ? null : confirmed.receipt;
      }
      if (!matches(entry)) return;
      const latest = current().pending;
      if (!latest || latest.kind !== "select" && latest.kind !== "merge") return;
      if (receipt === null) { if (latest.receipt) invalidAck(); }
      else {
        confirmSelection(latest,receipt); const checked = {...latest,receipt:fixed(receipt)};
        replace(checked); settle(checked,"reconciled"); return;
      }
      replace({...latest,checking:false,uncertain:true,retryAllowed:true}); update(before => ({...before,failure:originalFailure}));
    } catch (error) {
      if (!matches(entry)) return;
      const latest = current().pending;
      if (latest?.kind === "select" || latest?.kind === "merge") replace({...latest,checking:false,uncertain:true,retryAllowed:false});
      update(before => ({...before,failure:commandFailure(error,"outcome-unknown")}));
    }
  }
  async function lookupStart(entry: Extract<Pending,{kind:"start"}>, originalFailure = current().failure) {
    if (!matches(entry)) return;
    replace({...entry,checking:true,uncertain:true,retryAllowed:false}); update(before => ({...before,failure:null}));
    try {
      const result = await arenaCommands.startAction(entry.request);
      if (!matches(entry)) return;
      if (!validateResponseStartAction(result) || result !== null && (result.projectId !== entry.request.projectId
        || result.attemptId !== entry.request.attemptId || result.digest !== entry.request.digest)) invalidAck();
      if (result !== null) {
        settle(entry,"reconciled",result.taskId); return;
      }
      replace({...entry,checking:false,uncertain:true,retryAllowed:true}); update(before => ({...before,failure:originalFailure}));
    } catch (error) {
      if (!matches(entry)) return;
      replace({...entry,checking:false,uncertain:true,retryAllowed:false});
      update(before => ({...before,failure:commandFailure(error,"outcome-unknown")}));
    }
  }
  async function lookupAdoption(entry: Extract<Pending,{kind:"adopt"}>, originalFailure = current().failure) {
    if (!matches(entry)) return;
    const latest = current().pending;
    if (latest?.kind !== "adopt") return;
    replace({...latest,checking:true,uncertain:true,retryAllowed:false}); update(before => ({...before,failure:null}));
    try {
      const result = await executionCommands.adoptionAction(entry.request);
      if (!matches(entry)) return;
      let checked = current().pending;
      if (checked?.kind !== "adopt") return;
      if (!validateResponseAdoptionAction(result)) invalidAck();
      if (result === null) { if (checked.receipt) invalidAck(); }
      else {
        if (result.receipt !== null) { confirmReceipt(checked,result.receipt); checked = {...checked,receipt:fixed(result.receipt)}; replace(checked); }
        else if (checked.receipt) invalidAck();
        confirmAction(checked,result.action); checked = {...checked,action:fixed(result.action)}; replace(checked);
        if (checked.receipt) { settle(checked,"reconciled"); return; }
      }
      replace({...checked,checking:false,retryAllowed:true}); update(before => ({...before,failure:originalFailure}));
    } catch (error) {
      if (!matches(entry)) return;
      const checked = current().pending;
      if (checked?.kind === "adopt") replace({...checked,checking:false,retryAllowed:false});
      update(before => ({...before,failure:commandFailure(error,"outcome-unknown")}));
    }
  }
  function canStart() {
    const before = current(), prepared = before.prepared;
    return live() && !reserved() && project.metadata.targetLocales.includes(before.locale) && !!before.locale && before.consent && !!prepared && connectionCurrent()
      && sameConfig(before.config,prepared.preview.config) && validConfig(before.config,before.selected.length)
      && prepared.preview.items.every(row => row.item.unitId === before.selected[row.sourceOrder] && row.item.targetLocale === before.locale);
  }
  async function start() {
    const before = current(), prepared = before.prepared;
    if (!canStart() || !available() || !prepared) return;
    const entry: Pending = {kind:"start",request:fixed({...session,attemptId:prepared.attemptId,digest:prepared.preview.digest,confirmed:true}),prepared,
      editSeq:before.editSeq,uncertain:false,retryAllowed:false,checking:false};
    await run(() => dispatch(entry));
  }
  async function readView(attemptId: string) {
    const original = current().started?.prepared.attemptId === attemptId ? current().started : null;
    const result = await arenaCommands.read({...session,attemptId});
    confirmArenaView(result,attemptId,original?.prepared,original?.taskId);
    if (live() && original && current().started?.prepared === original.prepared && original.taskId === null) update(before => ({...before,started:{...original,taskId:result.detail.taskId}}));
    return result;
  }
  async function readComparison(comparisonId: string) {
    const result = await arenaCommands.comparison({...session,comparisonId}); confirmComparisonRead(result,comparisonId); return result;
  }
  function comparisonCurrent(view: ComparisonView) {
    const key = reads.key(["arena-comparison",view.comparisonId]), query = reads.client.getQueryState(key);
    const projection = reads.client.getQueryData<ComparisonView>(key);
    return view.comparisonId !== null && current().comparisonId === view.comparisonId && available(view.locale) && projection !== undefined
      && query?.status === "success" && query.error === null && query.fetchStatus === "idle" && !query.isInvalidated && comparisonBasis(projection) === comparisonBasis(view);
  }
  function canCompare() {
    const before = current();
    return live() && !reserved() && !before.draft && project.metadata.targetLocales.includes(before.locale) && !!before.locale && validateResponseIdentity(before.unit)
      && before.references.length >= 2 && before.references.length <= 4 && new Set(before.references).size === before.references.length
      && before.references.every(validateResponseIdentity);
  }
  /** A checked read may open offline choices without replacing model preparation
   * or a separate editor draft. Existing choices require explicit disposal. */
  function receiveComparisonTarget(unitId: string, locale: string, revisionId: string, expected: State) {
    const before = current();
    if (!live() || before !== expected || reserved() || before.draft || !available(locale)
      || draftsRef.current.candidates.blocked() || draftsRef.current.mutationReserved || draftsRef.current.protection.blocked()
      || draftsRef.current.current()?.pending || draftsRef.current.current()?.pendingSelection
      || draftsRef.current.current()?.saving || draftsRef.current.current()?.selecting
      || !validateResponseIdentity(unitId) || !validateResponseIdentity(revisionId)
      || (before.locale !== locale && (before.dirty || before.prepared || before.attempt || before.selected.length > 0))
      || (before.references.length > 0 && (before.unit !== unitId || before.locale !== locale || !before.references.includes(revisionId)))) return false;
    version.current++;
    update(value => ({ ...value, unit: unitId, locale, references: value.references.length ? value.references : [revisionId],
      comparisonId: null, dirty: true, editSeq: value.editSeq + 1, failure: null, notice: null }));
    return true;
  }
  async function compare() {
    const before = current(), ticket = version.current;
    if (!canCompare() || !available()) return;
    const request = fixed({...session,unitId:before.unit,locale:before.locale,revisionIds:before.references,blind:before.comparisonBlind});
    const key = ["arena-history",before.unit,before.locale,before.sourceGeneration];
    const original = reads.client.getQueryData<InfiniteData<TranslationHistory>>(reads.key(key));
    const rows = request.revisionIds.map(id => original?.pages.flatMap(page => page.rows).find(row => row.revisionId === id));
    await run(() => withQueryProof<InfiniteData<TranslationHistory>>(key, history =>
      request.revisionIds.every((id,index) => history.pages.some(page => page.unitId === request.unitId && page.locale === request.locale
        && page.rows.some(row => row.revisionId === id && row.unitId === request.unitId && row.locale === request.locale
          && (!rows[index] || JSON.stringify(row) === JSON.stringify(rows[index]))))), async proof => {
      const actionId = await executionCommands.identity(session);
      if (!live() || ticket !== version.current || current().editSeq !== before.editSeq || !available(request.locale) || !proof()) return;
      await dispatch({kind:"compare",request:fixed({...request,actionId}),editSeq:before.editSeq,uncertain:false,retryAllowed:false,checking:false});
    }));
  }
  function canSelect(view: ComparisonView, revisionId: string) {
    return live() && !reserved() && !translations.mutationReserved && comparisonCurrent(view)
      && view.rows.some(row => row.revisionId === revisionId && row.sourceRevisionId === view.sourceRevisionId && row.candidateDisposition !== "rejected");
  }
  async function select(view: ComparisonView, revisionId: string) {
    if (!canSelect(view,revisionId) || !reserveTranslation()) return;
    const before = current(), ticket = version.current, captured = fixed(view);
    await run(() => withQueryProof<ComparisonView>(["arena-comparison",captured.comparisonId], projection => comparisonBasis(projection) === comparisonBasis(captured), async proof => {
      const actionId = await executionCommands.identity(session);
      if (!live() || version.current !== ticket || current().comparisonId !== captured.comparisonId || !available(captured.locale) || !proof()) return;
      await dispatch({kind:"select",request:fixed({...session,actionId,unitId:captured.unitId,locale:captured.locale,sourceRevisionId:captured.sourceRevisionId,
        expectedSelectionId:captured.selectionId,revisionId}),receipt:null,editSeq:before.editSeq,uncertain:false,retryAllowed:false,checking:false});
    }));
  }
  async function reveal(target: string, targetKind: "attempt" | "comparison") {
    const before = current(), ticket = version.current;
    if (reserved() || !validateResponseIdentity(target) || (targetKind === "attempt" ? before.attempt !== target : before.comparisonId !== target)) return;
    await run(() => withQueryProof<ArenaView | ComparisonView>([targetKind === "attempt" ? "arena" : "arena-comparison",target], view =>
      view.blind && !view.revealed && ("detail" in view ? view.detail.attemptId === target : view.comparisonId === target), async proof => {
      const actionId = await executionCommands.identity(session);
      if (!live() || ticket !== version.current || !proof() || (targetKind === "attempt" ? current().attempt !== target : current().comparisonId !== target)) return;
      await dispatch({kind:"reveal",request:fixed({...session,comparisonId:target,actionId}),targetKind,editSeq:before.editSeq,uncertain:false,retryAllowed:false,checking:false,targetMissing:false});
    }));
  }
  function canBeginMerge(view: ComparisonView) {
    return live() && !reserved() && !current().draft && comparisonCurrent(view) && view.rows.every(row => row.sourceRevisionId === view.sourceRevisionId);
  }
  function beginMerge(view: ComparisonView) {
    if (!canBeginMerge(view)) return;
    const capture: MergeCapture = {comparisonId:view.comparisonId!,unitId:view.unitId,locale:view.locale,sourceRevisionId:view.sourceRevisionId,sourceText:view.sourceText,nativeKey:view.nativeKey,
      selectionId:view.selectionId,basis:view.basis,rows:view.rows.map(row => ({revisionId:row.revisionId,sourceRevisionId:row.sourceRevisionId,text:row.text}))};
    update(before => ({...before,draft:{basis:fixed(capture),text:view.rows[0].text,editSeq:0,stale:false}}));
  }
  function editMerge(text: string) { update(before => ({...before,draft:before.draft ? {...before.draft,text,editSeq:before.draft.editSeq+1} : null})); }
  function sameMergeBasis(view: ComparisonView, capture: MergeCapture) {
    return view.comparisonId === capture.comparisonId && view.unitId === capture.unitId && view.locale === capture.locale && view.sourceRevisionId === capture.sourceRevisionId
      && view.sourceText === capture.sourceText && view.selectionId === capture.selectionId && view.basis === capture.basis
      && view.rows.length === capture.rows.length && view.rows.every((row,index) => row.revisionId === capture.rows[index].revisionId
        && row.sourceRevisionId === capture.rows[index].sourceRevisionId && row.text === capture.rows[index].text);
  }
  function mergeBasisCurrent(capture: MergeCapture) {
    const key = reads.key(["arena-comparison",capture.comparisonId]), query = reads.client.getQueryState(key);
    const view = reads.client.getQueryData<ComparisonView>(key);
    return !!view && query?.status === "success" && query.error === null && query.fetchStatus === "idle" && !query.isInvalidated && sameMergeBasis(view,capture);
  }
  function canSaveMerge() {
    const draft = current().draft;
    return live() && !reserved() && !translations.mutationReserved && !!draft && !draft.stale && !!draft.text.trim()
      && available(draft.basis.locale) && mergeBasisCurrent(draft.basis);
  }
  async function saveMerge() {
    const before = current(), draft = before.draft, ticket = version.current;
    if (!canSaveMerge() || !draft || !reserveTranslation()) return;
    const captured = fixed(draft);
    await run(() => withQueryProof<ComparisonView>(["arena-comparison",captured.basis.comparisonId], view => sameMergeBasis(view,captured.basis), async currentQuery => {
      const proof = () => live() && version.current === ticket && current().draft?.editSeq === captured.editSeq
        && current().draft?.basis === draft.basis && available(captured.basis.locale) && currentQuery();
      const actionId = await executionCommands.identity(session);
      if (!proof()) return;
      await dispatch({kind:"merge",request:fixed({...session,actionId,unitId:captured.basis.unitId,locale:captured.basis.locale,sourceRevisionId:captured.basis.sourceRevisionId,
        expectedSelectionId:captured.basis.selectionId,text:captured.text,merge:{contributors:captured.basis.rows.map(row => row.revisionId),expectedBasis:captured.basis.basis}}),
        draftSeq:captured.editSeq,receipt:null,editSeq:before.editSeq,uncertain:false,retryAllowed:false,checking:false});
    }));
  }
  async function refreshMerge() {
    const original = current().draft;
    if (reserved() || !original || !available(original.basis.locale)) return;
    await run(async () => {
      const view = await readComparison(original.basis.comparisonId);
      if (!live() || current().draft?.basis !== original.basis) return;
      if (view.unitId !== original.basis.unitId || view.locale !== original.basis.locale || view.rows.length !== original.basis.rows.length
        || view.rows.some(row => row.sourceRevisionId !== view.sourceRevisionId || !original.basis.rows.some(parent => parent.revisionId === row.revisionId))) invalidAck();
      reads.client.setQueryData(reads.key(["arena-comparison",view.comparisonId]),view);
      update(before => ({...before,draft:before.draft ? {...before.draft,basis:fixed({...original.basis,sourceRevisionId:view.sourceRevisionId,sourceText:view.sourceText,
        selectionId:view.selectionId,basis:view.basis}),stale:false} : null}));
    });
  }
  function candidate(view: ArenaView, resultId: string): Candidate | null {
    if (view.detail.attemptId !== current().attempt) return null;
    try { const proof = current().started; confirmArenaView(view,view.detail.attemptId,proof?.prepared,proof?.taskId); } catch { return null; }
    const row = view.rows.find(row => row.resultId === resultId), detail = row && view.detail.items.find(item => item.status.itemId === row.itemId);
    const unit = row && view.detail.recovery.units.find(unit => unit.itemIds.includes(row.itemId));
    if (!row?.output || !detail || detail.status.execution !== "succeeded" || detail.status.validation !== "valid" || detail.status.adoption === "committed"
      || detail.status.cancellationRequested || !unit?.actions.includes("adopt-result") || unit.resultIds.length !== 1 || unit.resultIds[0] !== resultId
      || !available(row.item.targetLocale) || current().saved[resultId]) return null;
    return {taskId:view.detail.taskId,itemId:row.itemId,item:row.item,resultId,unitId:unit.unitId,text:row.output.text};
  }
  function cancellationPending(taskId: string) {
    const value = tasksRef.current.current(taskId);
    return !!value && (value.phase === "preparing" || value.phase === "pending" || value.phase === "checking" || value.phase === "unknown");
  }
  function candidateCurrent(view: ArenaView, value: Candidate) {
    const key = reads.key(["arena",view.detail.attemptId]), query = reads.client.getQueryState(key);
    const projection = reads.client.getQueryData<ArenaView>(key);
    return !cancellationPending(value.taskId) && (!query || (query.status === "success" && query.error === null && query.fetchStatus === "idle" && !query.isInvalidated))
      && (!projection || JSON.stringify(candidate(projection,value.resultId)) === JSON.stringify(value));
  }
  function canAdopt(view: ArenaView, resultId: string) {
    const value = candidate(view,resultId);
    return live() && !reserved() && !translations.mutationReserved && !!value && candidateCurrent(view,value);
  }
  async function adopt(view: ArenaView, resultId: string) {
    if (!canAdopt(view,resultId)) return;
    const value = candidate(view,resultId);
    if (!value || !reserveTranslation()) return;
    const captured = fixed(value), before = current(), ticket = version.current, attemptId = view.detail.attemptId;
    await run(() => withQueryProof<ArenaView>(["arena",attemptId], projection => JSON.stringify(candidate(projection,resultId)) === JSON.stringify(captured), async currentQuery => {
      const proof = () => live() && ticket === version.current && current().attempt === attemptId && current().editSeq === before.editSeq
        && available(captured.item.targetLocale) && !cancellationPending(captured.taskId) && currentQuery();
      const actionId = await executionCommands.identity(session);
      if (!proof()) return;
      await dispatch({kind:"adopt",request:fixed({...session,attemptId,actionId,unitId:captured.unitId,resultIds:[captured.resultId]}),candidate:captured,
        action:null,receipt:null,editSeq:before.editSeq,uncertain:false,retryAllowed:false,checking:false},false,proof);
    }));
  }
  async function checkPending() {
    const entry = current().pending; if (!entry) return;
    const originalFailure = current().failure;
    await run(async () => {
      replace({...entry,retryAllowed:false});
      if (entry.kind === "start") {
        await lookupStart(entry,originalFailure);
      } else if (entry.kind === "compare") {
        await lookupComparison(entry,originalFailure);
      } else if (entry.kind === "reveal") {
        await lookupReveal(entry,originalFailure);
      } else if (entry.kind === "select" || entry.kind === "merge") {
        await lookupSelection(entry,originalFailure);
      } else {
        await lookupAdoption(entry,originalFailure);
      }
    },true);
  }
  async function retryPending() {
    const entry = current().pending;
    if (entry?.retryAllowed) await run(() => dispatch(entry,true),true);
  }
  function showAttempt(attempt: string) {
    if (!live() || reserved() || current().dirty || current().draft || !validateResponseIdentity(attempt)) return false;
    update(before => ({...before,attempt,started:before.started?.prepared.attemptId === attempt ? before.started : null,failure:null,notice:null})); return true;
  }
  async function newRound(view: ArenaView) {
    if (reserved() || current().draft || current().attempt !== view.detail.attemptId) return;
    const before = current(), ticket = version.current;
    await run(async () => {
      const value = await readView(view.detail.attemptId);
      if (!live() || version.current !== ticket || current().editSeq !== before.editSeq || current().attempt !== before.attempt
        || value.detail.progress.queued || value.detail.progress.running || !available(value.rows[0].item.targetLocale)) return;
      version.current++;
      update(state => ({...state,attempt:null,started:null,config:fixed({...state.config,variants:value.variants ?? state.started?.prepared.preview.config.variants ?? state.config.variants,parentAttemptId:value.detail.attemptId}),
        selected:[...new Set(value.rows.map(row => row.item.unitId))],locale:value.rows[0].item.targetLocale,prepared:null,consent:false,dirty:true,editSeq:state.editSeq+1,notice:"repeatCost"}));
    });
  }
  function reset() {
    if (!live() || reserved()) return false;
    version.current++;
    update(before => ({...before,config:defaultArenaConfig(),locale:projectRef.current.metadata.targetLocales[0] ?? "",selected:[],prepared:null,consent:false,dirty:false,editSeq:before.editSeq+1,
      unit:"",references:[],comparisonBlind:false,comparisonId:null,draft:null,attempt:null,started:null,staleReason:null,failure:null,notice:null})); return true;
  }
  return {...state,current,reserved,targetAvailable,connectionCurrent,selectConnection,canPreview,preview,canStart,start,readView,readComparison,canCompare,compare,canSelect,select,reveal,canBeginMerge,beginMerge,editMerge,canSaveMerge,mergeBasisCurrent,saveMerge,refreshMerge,
    canAdopt,adopt,checkPending,retryPending,showAttempt,newRound,reset,receiveComparisonTarget,
    setConfig:(value: SetStateAction<ArenaConfig>) => edit("config",before => {
      const next = typeof value === "function" ? value(before) : value;
      return { ...next, variants: next.variants.map((config, index) => before.variants[index] ? editedAiConfig(before.variants[index], config) : config) };
    }),setLocale:(value: SetStateAction<string>) => edit("locale",value),
    setSelected:(value: SetStateAction<string[]>) => edit("selected",value),setReferences:(value: SetStateAction<string[]>) => edit("references",value),
    setComparisonBlind:(value: SetStateAction<boolean>) => edit("comparisonBlind",value),
    setUnit:(unit: string) => { if (!reserved() && !current().draft) { version.current++; update(before => ({...before,unit,references:[],comparisonId:null})); } },
    openComparison:(comparisonId: string) => { if (!reserved() && !current().draft && validateResponseIdentity(comparisonId)) update(before => ({...before,comparisonId})); },
    setConsent:(consent: boolean) => { if (!reserved() && current().prepared && available() && (!consent || connectionCurrent())) update(before => ({...before,consent})); },
    discardMerge:() => { if (!reserved()) update(before => ({...before,draft:null})); },
    clearSelectedRange:() => { if (!reserved()) edit("selected",[]); },
    reportFailure:(failure: CommandFailure) => update(before => ({...before,failure}))};
}
type ArenaOwner = ReturnType<typeof useArenaOwner>;
const ArenaContext = createContext<ArenaOwner | null>(null);
export function ArenaDraftSession({project,children}:{project:ProjectView;children:ReactNode}) {
  return <ArenaContext.Provider value={useArenaOwner(project)}>{children}</ArenaContext.Provider>;
}
export function useArenaDraftSession() {
  const owner = useContext(ArenaContext);
  if (!owner) throw new Error("Arena requires a project session owner");
  return owner;
}
