import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { aiCommands, defaultAiConfig, type AiConfig, type AiItem, type AiPrepared, type AiStart, type AiView } from "./aiCommands";
import { executionCommands, type AdoptionAction, type PrepareRequest, type Receipt } from "./executionCommands";
import { validateResponseIdentity, validateResponseAdoptionAction } from "./generated/execution.validators";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { hasUnknownOutcome } from "./projectCommands";
import { useSessionReads, useSessionAlive } from "./SessionReadProvider";
import { useExecutionTaskSession } from "./ExecutionTaskSession";

type StartCapture = { request: AiStart; prepared: AiPrepared; editSeq: number; uncertain: boolean };
type Candidate = { taskId: string; item: AiItem; resultId: string; unitId: string; text: string };
type AdoptCapture = { request: PrepareRequest; candidate: Candidate; editSeq: number; action: AdoptionAction | null; receipt: Receipt | null; uncertain: boolean; retryAllowed: boolean; checking: boolean };
interface State {
  presetName: string; config: AiConfig; locale: string; selected: string[]; prepared: AiPrepared | null; consent: boolean;
  staleReason: "source" | "preview" | null; dirty: boolean; editSeq: number; sourceGeneration: number; busy: boolean;
  attempt: string | null; started: { prepared: AiPrepared; taskId: string | null } | null;
  pendingStart: StartCapture | null; pendingAdopt: AdoptCapture | null; saved: Record<string, Receipt>;
  failure: CommandFailure | null; notice: "started" | "saved" | "newer" | null;
}
const configKeys = ["endpoint", "model", "credentialEnv", "tokenField", "maxItems", "concurrency", "maxRequests", "maxOutputTokens", "maxRetries", "timeoutSeconds", "shareTerms", "shareContext"] as const;
const limits = [["maxItems",1,100],["concurrency",1,2],["maxRequests",1,300],["maxOutputTokens",1,16384],["maxRetries",0,2],["timeoutSeconds",1,120]] as const;
const sameConfig = (left: AiConfig, right: AiConfig) => configKeys.every(key => left[key] === right[key]);
const validLimits = (config: AiConfig) => limits.every(([key,min,max]) => Number.isInteger(config[key]) && config[key] >= min && config[key] <= max);
function validItem(item: AiItem) {
  return [item.unitId,item.sourceRevisionId,item.sourceSnapshotId,...item.terms.map(term => term.revisionId)].every(validateResponseIdentity)
    && (!item.context || [item.context.revisionId,item.context.unitId,...(item.context.previousRevisionId ? [item.context.previousRevisionId] : [])].every(validateResponseIdentity));
}
function itemProof(item: AiItem) {
  return JSON.stringify([item.unitId,item.sourceRevisionId,item.sourceSnapshotId,item.nativeKey,item.sourceLocale,item.sourceText,item.targetLocale,item.resourceBaseline,
    item.terms.map(term => [term.revisionId,term.source,term.target,term.protected]),
    item.context ? [item.context.revisionId,item.context.previousRevisionId,item.context.unitId,item.context.locale,item.context.text,item.context.reason] : null,item.omissions]);
}
function freeze<T>(part: T): T {
  if (part && typeof part === "object" && !Object.isFrozen(part)) { Object.values(part).forEach(freeze); Object.freeze(part); }
  return part;
}
function fixed<T>(value: T): T { return freeze(structuredClone(value)); }
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

function usePreparation(initialLocale: string, targetLocales: readonly string[]) {
  const reads = useSessionReads(), tasks = useExecutionTaskSession();
  const [session] = useState(() => Object.freeze({ ...reads.context }));
  const [state,setState] = useState<State>(() => freeze({ presetName:"custom",config:fixed(defaultAiConfig),locale:initialLocale,selected:[],prepared:null,consent:false,
    staleReason:null,dirty:false,editSeq:0,sourceGeneration:0,busy:false,attempt:null,started:null,pendingStart:null,pendingAdopt:null,saved:{},failure:null,notice:null }));
  const stateRef = useRef(state), mounted = useSessionAlive(), locales = useRef(targetLocales), basis = useRef(0), flight = useRef<object | null>(null);
  const candidateReadCleanup = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { mounted.current = true; return () => {
    mounted.current = false; candidateReadCleanup.current?.(); candidateReadCleanup.current = null;
  }; }, []);
  useLayoutEffect(() => { locales.current = targetLocales; }, [targetLocales]);
  function current() { return stateRef.current; }
  function live() { return mounted.current && reads.context.projectId === session.projectId && reads.context.sessionToken === session.sessionToken; }
  function update(change: (before: State) => State) { if (!live()) return; stateRef.current = freeze(change(current())); setState(stateRef.current); }
  function reserved() { return !!flight.current || !!current().pendingStart || !!current().pendingAdopt; }
  function available(locale = current().locale) { return locale !== "" && locales.current.includes(locale); }
  function invalidatePreview(reason: State["staleReason"] = null) {
    basis.current++; update(before => ({ ...before,prepared:null,consent:false,staleReason:reason }));
  }
  function edit<K extends "config" | "presetName" | "locale" | "selected">(key: K, value: State[K]) {
    basis.current++;
    update(before => ({ ...before,[key]:fixed(value),prepared:null,consent:false,staleReason:null,
      dirty:true,editSeq:before.editSeq+1,failure:null,notice:null }));
  }
  async function run(work: () => Promise<void>, recovery = false) {
    if (!live() || flight.current || (!recovery && (current().pendingStart || current().pendingAdopt))) return;
    // Reserve before any identity/IPC await, across every consumer of this owner.
    const ticket = {}; flight.current = ticket;
    update(before => ({ ...before,busy:true,failure:null,notice:null }));
    try { await work(); } catch (error) { update(before => ({ ...before,failure:commandFailure(error,"outcome-unknown") })); }
    finally { if (live() && flight.current === ticket) { flight.current = null; update(before => ({ ...before,busy:false })); } }
  }
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.includes("project") || scopes.includes("source") || scopes.includes("resources")) {
      invalidatePreview(scopes.includes("source") ? "source" : "preview");
      if (scopes.includes("project") || scopes.includes("source")) update(before => ({ ...before,sourceGeneration:before.sourceGeneration+1 }));
    }
  }), [reads]);
  const targetAvailable = state.locale !== "" && targetLocales.includes(state.locale);
  useLayoutEffect(() => { if (!targetAvailable) invalidatePreview(); }, [targetAvailable]);
  function canPreview() {
    const before = current();
    // Presentation follows this render's props. Mutation entry points below
    // separately require the committed locale ref before any dispatch.
    return live() && !reserved() && before.locale !== "" && targetLocales.includes(before.locale)
      && validateResponseIdentity(session.projectId) && !!session.sessionToken && before.selected.length > 0;
  }
  async function preview() {
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
      update(value => ({ ...value,prepared:fixed(result),consent:false,staleReason:null }));
    });
  }
  function settleStart(entry: StartCapture, taskId: string | null = null) {
    update(before => before.pendingStart?.request !== entry.request ? before : { ...before,pendingStart:null,attempt:entry.request.attemptId,
      started:{prepared:entry.prepared,taskId},prepared:before.prepared === entry.prepared ? null : before.prepared,consent:false,
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
    return live() && !reserved() && before.locale !== "" && targetLocales.includes(before.locale) && !!prepared && before.consent && sameConfig(before.config,prepared.preview.config)
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
    const result = await aiCommands.read({ ...session,attemptId });
    const recorded = proof && current().started?.prepared === proof.prepared ? current().started : null;
    confirmView(result,attemptId,proof?.prepared,recorded?.taskId ?? proof?.taskId);
    // Prepared/start ACKs have no TaskId. Keep only the first checked original task identity, not the mutable view.
    if (live() && recorded && recorded.taskId === null) update(before => ({ ...before,started:{...recorded,taskId:result.detail.taskId} }));
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
    const row = view.rows.find(value => value.resultId === resultId), item = row && view.detail.items.find(value => value.status.itemId === row.itemId);
    const unit = row && view.detail.recovery.units.find(value => value.itemIds.includes(row.itemId));
    if (!row?.output || row.output.unitId !== row.item.unitId || row.output.targetLocale !== row.item.targetLocale
      || !item || item.resultId !== resultId || item.status.execution !== "succeeded" || item.status.validation !== "valid" || item.status.adoption === "committed"
      || item.scope.id !== row.item.unitId || item.scope.locale !== row.item.targetLocale || !unit?.actions.includes("adopt-result")
      || !validateResponseIdentity(unit.unitId) || !unit.resultIds.includes(resultId)
      || !unit.scopes.some(scope => scope.kind === "translation-unit" && scope.id === row.item.unitId && scope.locale === row.item.targetLocale)
      || !available(row.item.targetLocale) || current().saved[resultId]) return null;
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
    return live() && !reserved() && !!value && !cancellationPending(value.taskId);
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
  async function adopt(view: AiView, resultId: string) {
    if (!canAdopt(view,resultId)) return;
    const value = candidate(view,resultId);
    if (!value) return;
    const captured = fixed(value), version = basis.current, editSeq = current().editSeq, attemptId = view.detail.attemptId;
    await run(async () => {
      const readProof = candidateReadProof(captured,attemptId);
      candidateReadCleanup.current = readProof.dispose;
      const proof = () => live() && version === basis.current && current().attempt === attemptId && available(captured.item.targetLocale)
        && !cancellationPending(captured.taskId) && readProof.current();
      try {
        const actionId = await executionCommands.identity(session);
        if (!proof()) return;
        const entry: AdoptCapture = {request:fixed({...session,attemptId,unitId:captured.unitId,actionId,resultIds:[captured.resultId]}),candidate:captured,editSeq,
          action:null,receipt:null,uncertain:false,retryAllowed:false,checking:false};
        await dispatchAdopt(entry,false,proof);
      } finally {
        readProof.dispose();
        if (candidateReadCleanup.current === readProof.dispose) candidateReadCleanup.current = null;
      }
    });
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
  async function checkAdoption() {
    const entry = current().pendingAdopt;
    if (!entry) return;
    const originalFailure = current().failure;
    await run(() => lookupAdoption(entry,originalFailure),true);
  }
  async function retryAdoption() { const entry = current().pendingAdopt; if (entry?.retryAllowed) await run(() => dispatchAdopt(entry,true),true); }
  function showAttempt(attempt: string) {
    if (!live() || reserved() || current().dirty || !validateResponseIdentity(attempt)) return false;
    update(before => ({ ...before,attempt,started:before.started?.prepared.attemptId === attempt ? before.started : null,failure:null,notice:null })); return true;
  }
  function reset() {
    if (!live() || reserved()) return false;
    basis.current++;
    update(before => ({ ...before,presetName:"custom",config:fixed(defaultAiConfig),locale:initialLocale,selected:[],prepared:null,consent:false,staleReason:null,
      dirty:false,editSeq:before.editSeq+1,attempt:null,started:null,failure:null,notice:null })); return true;
  }
  return { ...state,current,reserved,targetAvailable,canPreview,preview,canStart,start,checkStart,retryStart,readView,canAdopt,adopt,checkAdoption,retryAdoption,showAttempt,reset,invalidatePreview,
    setPresetName:(value:SetStateAction<string>) => edit("presetName",typeof value === "function" ? value(current().presetName) : value),
    setConfig:(value:SetStateAction<AiConfig>) => edit("config",typeof value === "function" ? value(current().config) : value),
    setLocale:(value:SetStateAction<string>) => edit("locale",typeof value === "function" ? value(current().locale) : value),
    setSelected:(value:SetStateAction<string[]>) => edit("selected",typeof value === "function" ? value(current().selected) : value),
    clearSelectedRange:() => { if (!reserved()) edit("selected",[]); },
    setConsent:(consent:boolean) => { if (!reserved() && current().prepared && available()) update(before => ({ ...before,consent })); }
  };
}
type Preparation = ReturnType<typeof usePreparation>;
const PreparationContext = createContext<Preparation | null>(null);
export function AiPreparationSession({initialLocale,targetLocales,children}:{initialLocale:string;targetLocales:readonly string[];children:ReactNode}) {
  return <PreparationContext.Provider value={usePreparation(initialLocale,targetLocales)}>{children}</PreparationContext.Provider>;
}
export function useAiPreparation() {
  const owner = useContext(PreparationContext);
  if (!owner) throw new Error("AI preparation requires a project session owner");
  return owner;
}
