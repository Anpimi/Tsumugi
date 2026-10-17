import { jsonIdentity } from "./pluginToolChoices";
import { usePluginToolQuerySession, type PluginToolQuerySession } from "./PluginToolQuerySession";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, type SessionRequest } from "./executionCommands";
import { hasUnknownOutcome, isCommandError, type ProjectView } from "./projectCommands";
import { confirmContextFact, confirmCorrectionCapture, resourceCommands, type CorrectionTermEvidence, type CorrectionTermReceipt, type CaptureCorrectionTerm, type ContextFactWrite, type ContextFactDecision, type SourceFactBasis, type ContextFactDisposition, type CaptureContext, type ContextCapture, type ContextRevision, type GlossaryCapture,
  type ResourceDecision, type ResourceDecisionResult, type ResourcePreview, type SaveContext, type SaveTerm, type TermRevision } from "./resourceCommands";
import { sourceCommands, type ContentRow, type ContentScope } from "./sourceCommands";
import { useSessionReads, useSessionAlive } from "./SessionReadProvider";

export type ResourceTermDraft = Pick<SaveTerm, "source" | "aliases" | "target" | "protected" | "scopeUnitId" | "reason">;
export const resourceTermDraftFor = (term: ResourceTermDraft | null): ResourceTermDraft => term
  ? { source: term.source, aliases: [...term.aliases], target: term.target, protected: term.protected, scopeUnitId: term.scopeUnitId ?? null, reason: term.reason }
  : { source: "", aliases: [], target: "", protected: false, scopeUnitId: null, reason: "" };
type PendingBase = { session: SessionRequest };
export type ResourcePending =
  | (PendingBase & { kind: "correction"; request: CaptureCorrectionTerm; submittedSeq: number })
  | (PendingBase & { kind: "term"; request: SaveTerm; submittedSeq: number; aliasInput: string })
  | (PendingBase & { kind: "context"; request: SaveContext; submittedSeq: number })
  | (PendingBase & { kind: "decision"; request: ResourceDecision; locale: string })
  | (PendingBase & { kind: "capture"; request: CaptureContext });
export type ResourceNotice = "correctionSaved" | "correctionSavedNewer" | "saved" | "savedNewer" | "decisionSaved" | "previewReady" | "captureSaved" | "unknown" | "pickerUnknown" | "error" | null;
export interface ResourceSourceBasis { revision: string; snapshotId: string | null }
export interface ResourceCorrectionDraft { evidence: CorrectionTermEvidence; source: string; target: string; protected: boolean; reason: string; editSeq: number }
/** Only the checked editing target belongs to a context draft, not a source page. */
export interface ResourceContextTarget {
  unitId: string; sourceRevisionId: string; occurrence: { key: string; text: string };
}
export interface ResourceFactDraft { basis: SourceFactBasis; key:string; expectedDecisionId:string|null; disposition:ContextFactDisposition; actor:string; reason:string; editSeq:number }
/** Local field feedback; Core validates the actual write and its source basis. */
export function validContextFactDraft(draft:ResourceFactDraft) {
  const bytes=(value:string)=>new TextEncoder().encode(value).length;
  return !!draft.actor.trim() && bytes(draft.actor.trim())<=512 && !!draft.reason.trim() && bytes(draft.reason.trim())<=4096
    && (draft.disposition.kind!=="replace" || !!draft.disposition.text.trim() && bytes(draft.disposition.text)<=4096);
}
/** Core replays a recorded action before checking this append-only CAS. This
 * exact rejection proves that the original action has not committed. */
export function isContextFactCasRejection(value:unknown) {
  return isCommandError(value) && value.code==="dependency-conflict" && value.stage==="execution-adopt"
    && value.outcome==="rejected" && value.reason==="context-fact-current";
}
/** These Core checks run only after the exact original action receipt lookup.
 * They prove non-commit even when an earlier acknowledgement was lost. */
function isReceiptFirstRejection(action: ResourcePending, value: unknown) {
  if (!isCommandError(value) || value.code !== "dependency-conflict" || value.stage !== "execution-adopt" || value.outcome !== "rejected") return false;
  return action.kind === "correction" ? value.reason === "correction-stale" || value.reason === "correction-existing"
    : action.kind === "decision" && (value.reason === "correction-stale" || value.reason === "resource-current");
}
export interface ResourceDraftState {
  correctionDraft: ResourceCorrectionDraft | null;
  correctionReceipt: CorrectionTermReceipt | null;
  pendingCheckedMissing: boolean;
  factDraft: ResourceFactDraft|null;
  factPending: {request:ContextFactWrite;submittedSeq:number}|null;
  factCheckedMissing:boolean;
  factFailure:CommandFailure|null;
  factRecorded:{key:string;decision:ContextFactDecision}|null;
  locale: string;
  selectedTerm: TermRevision | null;
  termDraft: ResourceTermDraft;
  aliasInput: string;
  termSeq: number;
  newerTerm: boolean;
  selectedUnit: ResourceContextTarget | null;
  contextRevision: ContextRevision | null;
  contextDraft: string;
  contextReason: string;
  contextSeq: number;
  newerContext: boolean;
  /** Explicitly captured evidence, never a mirror of the mutable resource lists. */
  previewCapture: GlossaryCapture | null;
  preview: ResourcePreview | null;
  previewSourceBasis: ResourceSourceBasis | null;
  previewNeedsRefresh: boolean;
  fixedContext: ContextCapture | null;
  pending: ResourcePending | null;
  pendingUncertain: boolean;
  busyMutation: boolean;
  checkingAction: "resource" | "fact" | null;
  notice: ResourceNotice;
  failure: CommandFailure | null;
  completionVersion: number;
}
interface ResourceSession {
  canReceiveMcp: (capture: GlossaryCapture) => boolean;
  openMcpPreview: (capture: GlossaryCapture, before: ResourceDraftState, proof: () => boolean) => Promise<boolean>;
  correctionDirty: () => boolean;
  canReceiveCorrection: (locale: string) => boolean;
  receiveCorrection: (evidence: CorrectionTermEvidence, before: ResourceDraftState, proof: () => boolean) => boolean;
  editCorrection: (patch: Partial<Pick<ResourceCorrectionDraft, "source" | "target" | "protected" | "reason">>) => void;
  discardCorrection: () => void;
  captureCorrection: (proof: () => boolean) => Promise<void>;
  checkPending: () => Promise<void>;
  factDirty:()=>boolean;
  factBlocked:()=>boolean;
  beginFact:(basis:SourceFactBasis,key:string,decision:ContextFactDecision|null,disposition:ContextFactDisposition)=>boolean;
  editFact:(patch:Partial<Pick<ResourceFactDraft,"actor"|"reason"|"disposition">>)=>void;
  discardFact:()=>boolean;
  saveFact:(proof:()=>boolean)=>Promise<void>;
  checkFact:()=>Promise<void>;
  retryFact:()=>Promise<void>;
  tool: PluginToolQuerySession;
  state: ResourceDraftState;
  current: () => ResourceDraftState;
  inFlight: () => boolean;
  termDirty: () => boolean;
  contextDirty: () => boolean;
  localeAvailable: (locale: string) => boolean;
  setLocale: (locale: string) => boolean;
  beginTerm: (term: TermRevision | null) => boolean;
  editTerm: (draft: ResourceTermDraft, aliases?: string) => void;
  discardTerm: () => void;
  beginContext: (row: ContentRow, revision: ContextRevision | null) => boolean;
  canReceiveContext: (locale: string) => boolean;
  receiveContext: (target: ResourceContextTarget, locale: string, revision: ContextRevision | null, before: ResourceDraftState, currentRead: () => boolean) => boolean;
  adoptContext: (revision: ContextRevision | null, expectedRevisionId: string | null, editSeq: number) => boolean;
  editContext: (text: string) => void;
  editContextReason: (reason: string) => void;
  discardContext: () => void;
  discard: () => void;
  saveTerm: (isScopeCurrent?: () => boolean) => Promise<void>;
  saveContext: (isScopeCurrent?: () => boolean) => Promise<void>;
  decide: (entryId: string, expectedRevisionId: string | null, decision: ResourceDecision["decision"], isScopeCurrent?: () => boolean) => Promise<void>;
  captureContext: (isScopeCurrent?: () => boolean) => Promise<void>;
  retryPending: () => Promise<void>;
  chooseFile: (isCurrent?: () => boolean) => Promise<void>;
  canReadCapture: (capture: GlossaryCapture) => boolean;
  openPreview: (capture: GlossaryCapture, isCurrent?: () => boolean) => Promise<void>;
  retryPreview: (isCurrent?: () => boolean) => Promise<void>;
}
const ResourceContext = createContext<ResourceSession | null>(null);
export function useResourceDraftSession() {
  const owner = useContext(ResourceContext);
  if (!owner) throw new Error("Resource drafts require a project session owner");
  return owner;
}
function sameTerm(left: ResourceTermDraft, right: ResourceTermDraft) { return JSON.stringify(resourceTermDraftFor(left)) === JSON.stringify(resourceTermDraftFor(right)); }
function nullable(value: string | null | undefined) { return value ?? null; }
function invalidReceipt() { throw new Error("Invalid resource action acknowledgement"); }

export function ResourceDraftSession({ project, children }: { project: ProjectView; children: ReactNode }) {
  const tool = usePluginToolQuerySession(project);
  const reads = useSessionReads();
  const [state, setState] = useState<ResourceDraftState>(() => ({ correctionDraft:null,correctionReceipt:null,pendingCheckedMissing:false,factDraft:null,factPending:null,factCheckedMissing:false,factFailure:null,factRecorded:null, locale: project.metadata.targetLocales[0] ?? "",
    selectedTerm: null, termDraft: resourceTermDraftFor(null), aliasInput: "", termSeq: 0, newerTerm: false,
    selectedUnit: null, contextRevision: null, contextDraft: "", contextReason: "", contextSeq: 0, newerContext: false,
    previewCapture: null, preview: null, previewSourceBasis: null, previewNeedsRefresh: false, fixedContext: null, pending: null, pendingUncertain: false, busyMutation: false, checkingAction: null, notice: null, failure: null, completionVersion: 0 }));
  const currentState = useRef(state), projectRef = useRef(project);
  const [session] = useState(() => executionContext(project));
  const mounted = useSessionAlive(), running = useRef(false);
  const targetScope = project.metadata.targetLocales.join("\u0000");
  useLayoutEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function current() { return currentState.current; }
  function live() { const value = projectRef.current; return mounted.current && value.sessionToken === session.sessionToken && value.metadata.projectId === session.projectId; }
  function update(change: (before: ResourceDraftState) => ResourceDraftState) {
    if (!live()) return;
    const next = change(current()); currentState.current = next; setState(next);
  }
  function localeAvailable(locale: string) { return live() && !!locale && projectRef.current.metadata.targetLocales.includes(locale); }
  function canReadCapture(capture: GlossaryCapture) {
    return capture.origin.kind === "correction"
      ? live() && capture.origin.basis.projectId === session.projectId && capture.origin.basis.locale === capture.targetLocale
      : capture.origin.kind === "mcp" ? live() && capture.origin.provenance.basis.projectId === session.projectId && capture.origin.provenance.basis.locale === capture.targetLocale
        : localeAvailable(capture.targetLocale);
  }
  function decisionLocaleAvailable(value: ResourceDraftState, decision?: ResourceDecision["decision"]) {
    const capture = value.previewCapture;
    return !!capture && (localeAvailable(capture.targetLocale) || (capture.origin.kind === "correction" || capture.origin.kind === "mcp")
      && (decision === "keep" || decision === "ignore") && canReadCapture(capture));
  }
  function termDirty() { const value = current(); return value.newerTerm || value.aliasInput !== (value.selectedTerm?.aliases.join(", ") ?? "") || !sameTerm(value.termDraft, resourceTermDraftFor(value.selectedTerm)); }
  function contextDirty() { const value = current(); return value.newerContext || value.contextDraft !== (value.contextRevision?.text ?? "") || value.contextReason !== (value.contextRevision?.reason ?? ""); }
  function correctionDirty() { return current().correctionDraft !== null; }
  function factDirty(){return current().factDraft!==null;}
  function factBlocked(){return running.current || current().factPending!==null;}
  function reserved() { return running.current || !!current().pending || !!current().factPending; }
  function resetLocale(before: ResourceDraftState, locale: string): ResourceDraftState {
    return { ...before, locale, correctionDraft:null,correctionReceipt:null,pendingCheckedMissing:false, selectedTerm: null, termDraft: resourceTermDraftFor(null), aliasInput: "", termSeq: before.termSeq + 1, newerTerm: false,
      selectedUnit: null, contextRevision: null, contextDraft: "", contextReason: "", contextSeq: before.contextSeq + 1, newerContext: false,
      previewCapture: null, preview: null, previewSourceBasis: null, previewNeedsRefresh: false, fixedContext: null, notice: null, failure: null };
  }
  useEffect(() => {
    const next = projectRef.current.metadata.targetLocales[0] ?? "";
    if (current().locale !== next && !localeAvailable(current().locale) && !reserved() && !termDirty() && !contextDirty() && !correctionDirty()
      && !current().previewCapture && !current().fixedContext) {
      update(before => resetLocale(before, next));
    }
  }, [targetScope, state.busyMutation, state.pending, state.termSeq, state.contextSeq, state.correctionDraft]);
  function setLocale(locale: string) {
    if (!localeAvailable(locale) || reserved() || termDirty() || contextDirty() || correctionDirty()) return false;
    update(before => resetLocale(before, locale)); return true;
  }
  function beginTerm(term: TermRevision | null) {
    if (reserved() || termDirty() || !localeAvailable(current().locale) || (term && term.locale !== current().locale)) return false;
    update(before => ({ ...before, selectedTerm: term, termDraft: resourceTermDraftFor(term), aliasInput: term?.aliases.join(", ") ?? "", termSeq: before.termSeq + 1, newerTerm: false })); return true;
  }
  function editTerm(termDraft: ResourceTermDraft, aliases?: string) { update(before => ({ ...before, termDraft, aliasInput: aliases ?? before.aliasInput, termSeq: before.termSeq + 1, newerTerm: false })); }
  function discardTerm() { if (!reserved()) update(before => ({ ...before, termDraft: resourceTermDraftFor(before.selectedTerm), aliasInput: before.selectedTerm?.aliases.join(", ") ?? "", termSeq: before.termSeq + 1, newerTerm: false })); }
  function beginContext(row: ContentRow, revision: ContextRevision | null) {
    const locale = current().locale;
    if (reserved() || contextDirty() || !localeAvailable(locale) || !row.unitId || !row.sourceRevisionId
      || (revision && (revision.unitId !== row.unitId || revision.locale !== locale))) return false;
    const target:ResourceContextTarget={unitId:row.unitId,sourceRevisionId:row.sourceRevisionId,occurrence:{key:row.occurrence.key,text:row.occurrence.text}};
    update(before => ({ ...before, selectedUnit: target, contextRevision: revision, contextDraft: revision?.text ?? "", contextReason: revision?.reason ?? "", contextSeq: before.contextSeq + 1, newerContext: false, fixedContext: null })); return true;
  }
  function canReceiveContext(locale: string) {
    const before=current();
    return localeAvailable(locale) && !reserved() && !contextDirty() && !correctionDirty() && !tool.blocked() && !tool.hasDraft()
      && (before.locale===locale || (!termDirty() && !before.previewCapture && !before.fixedContext));
  }
  function receiveContext(target:ResourceContextTarget, locale:string, revision:ContextRevision|null, before:ResourceDraftState, currentRead:()=>boolean) {
    if (current()!==before || !canReceiveContext(locale) || !currentRead() || !target.unitId || !target.sourceRevisionId
      || (revision && (revision.unitId!==target.unitId || revision.locale!==locale))) return false;
    const retained=before.locale===locale ? before : resetLocale(before,locale);
    update(()=>({...retained,selectedUnit:structuredClone(target),contextRevision:revision&&structuredClone(revision),
      contextDraft:revision?.text??"",contextReason:revision?.reason??"",contextSeq:retained.contextSeq+1,newerContext:false,fixedContext:null,notice:null,failure:null}));
    return true;
  }
  function editContext(contextDraft: string) { update(before => ({ ...before, contextDraft, contextSeq: before.contextSeq + 1, newerContext: false })); }
  function adoptContext(revision: ContextRevision | null, expectedRevisionId: string | null, editSeq: number) {
    const value = current(), row = value.selectedUnit;
    if (reserved() || !localeAvailable(value.locale) || !row?.unitId || !row.sourceRevisionId
      || nullable(value.contextRevision?.revisionId) !== expectedRevisionId || value.contextSeq !== editSeq
      || (revision && (revision.unitId !== row.unitId || revision.locale !== value.locale))) return false;
    const keepEdits = contextDirty();
    update(before => ({ ...before, contextRevision: revision,
      contextDraft: keepEdits ? before.contextDraft : revision?.text ?? "",
      contextReason: keepEdits ? before.contextReason : revision?.reason ?? "",
      contextSeq: before.contextSeq + 1, newerContext: keepEdits, fixedContext: null, notice: null, failure: null }));
    return true;
  }
  function editContextReason(contextReason: string) { update(before => ({ ...before, contextReason, contextSeq: before.contextSeq + 1, newerContext: false })); }
  function discardContext() { if (!reserved()) update(before => ({ ...before, contextDraft: before.contextRevision?.text ?? "", contextReason: before.contextRevision?.reason ?? "", contextSeq: before.contextSeq + 1, newerContext: false })); }
  function discard() { discardTerm(); discardContext(); discardFact(); discardCorrection(); }
  function beginFact(basis:SourceFactBasis,key:string,decision:ContextFactDecision|null,disposition:ContextFactDisposition) {
    if (!live() || reserved() || factDirty() || !localeAvailable(basis.scope.locale) || basis.scope.projectId!==session.projectId || decision && jsonIdentity(decision.request.basis)!==jsonIdentity(basis)) return false;
    update(before=>({...before,factDraft:{basis:structuredClone(basis),key,expectedDecisionId:decision?.request.actionId??null,disposition:structuredClone(disposition),actor:"",reason:"",editSeq:0},factFailure:null,factRecorded:null}));return true;
  }
  function editFact(patch:Partial<Pick<ResourceFactDraft,"actor"|"reason"|"disposition">>){update(before=>before.factDraft?{...before,factDraft:{...before.factDraft,...patch,editSeq:before.factDraft.editSeq+1}}:before);}
  function discardFact(){if(reserved())return false;update(before=>({...before,factDraft:null,factFailure:null,factCheckedMissing:false}));return true;}
  function settleFact(request:ContextFactWrite,value:ContextFactDecision){
    confirmContextFact(request,value);const pending=current().factPending;if(!pending || pending.request!==request)return;
    update(before=>({...before,factPending:null,factCheckedMissing:false,factFailure:null,checkingAction:null,factRecorded:{key:before.factDraft?.key??"",decision:value},
      factDraft:before.factDraft?.editSeq===pending.submittedSeq?null:before.factDraft?{...before.factDraft,expectedDecisionId:request.actionId}:null,
      notice:before.factDraft?.editSeq===pending.submittedSeq?"saved":"savedNewer",completionVersion:before.completionVersion+1}));
    reads.invalidate(["resources","review"],false);
  }
  async function lookupFact(pending: NonNullable<ResourceDraftState["factPending"]>) {
    if (!live() || current().factPending !== pending) return;
    update(before => ({ ...before, checkingAction: "fact", factFailure: null, factCheckedMissing: false }));
    try {
      const value = await resourceCommands.factAction({ ...session, actionId: pending.request.actionId });
      if (!live() || current().factPending !== pending) return;
      if (value === null) update(before => ({ ...before, factCheckedMissing: true })); else settleFact(pending.request, value);
    } finally {
      if (live() && current().factPending === pending) update(before => ({ ...before, checkingAction: null }));
    }
  }
  async function dispatchFact(request:ContextFactWrite,recovering=false){
    const pending=current().factPending; if(!live() || !pending || pending.request!==request)return;
    let writeFailure:CommandFailure|null=null;
    try{const value=await resourceCommands.decideFact({...session,decision:request});if(live())settleFact(request,value);return;}
    catch(error){
      if(!live() || current().factPending?.request!==request)return;
      const notSubmitted=isContextFactCasRejection(error);
      const unknown=hasUnknownOutcome(error);writeFailure=commandFailure(error);
      update(before=>before.factPending?.request!==request?before:{...before,
        factPending:unknown||recovering&&!notSubmitted?before.factPending:null,
        factCheckedMissing:false,factFailure:unknown?null:writeFailure});
      // Refresh facts without adopting a new CAS into the retained B draft.
      if(notSubmitted)reads.invalidate(["resources","review"],false);
      if(!unknown)return;
    }
    // Keep the original reservation; a failed read never retries the write.
    try{await lookupFact(pending);if(live()&&current().factPending===pending)update(before=>({...before,factFailure:writeFailure}));}
    catch(error){if(live()&&current().factPending===pending)update(before=>({...before,factFailure:commandFailure(error)}));}
  }
  async function saveFact(proof:()=>boolean){
    const start=current().factDraft;if(!start || !proof() || !localeAvailable(start.basis.scope.locale) || !validContextFactDraft(start) || !reserve())return;
    try{
      const actionId=await executionCommands.identity(session);
      if(!live() || current().factDraft!==start || !proof())return;
      const request:ContextFactWrite={actionId,basis:structuredClone(start.basis),expectedDecisionId:start.expectedDecisionId,disposition:structuredClone(start.disposition),actor:start.actor.trim(),reason:start.reason.trim()};
      update(before=>({...before,factPending:{request,submittedSeq:start.editSeq},factCheckedMissing:false,factFailure:null}));await dispatchFact(request);
    }catch(error){update(before=>({...before,factFailure:commandFailure(error)}));}finally{release();}
  }
  async function checkFact(){
    const pending=current().factPending,previousFailure=current().factFailure;if(!pending || !live() || running.current)return;
    running.current=true;update(before=>({...before,busyMutation:true,factFailure:null,factCheckedMissing:false}));
    try{await lookupFact(pending);if(live()&&current().factPending===pending)update(before=>({...before,factFailure:previousFailure}));}
    catch(error){if(live()&&current().factPending===pending)update(before=>({...before,factFailure:commandFailure(error)}));}finally{release();}
  }
  async function retryFact(){const pending=current().factPending;if(!pending || !current().factCheckedMissing || !live() || running.current)return;
    running.current=true;update(before=>({...before,busyMutation:true,factFailure:null,factCheckedMissing:false}));try{await dispatchFact(pending.request,true);}finally{release();}}
  function fail(error: unknown, notice: ResourceNotice = "error") { update(before => ({ ...before, failure: commandFailure(error), notice })); }
  function reserve() {
    if (!live() || reserved()) return false;
    running.current = true; update(before => ({ ...before, busyMutation: true, failure: null, notice: null })); return true;
  }
  function release() { running.current = false; update(before => ({ ...before, busyMutation: false })); }
  function sameTermTarget(before: ResourceDraftState, start: ResourceDraftState) { return before.locale === start.locale && before.selectedTerm?.termId === start.selectedTerm?.termId && before.selectedTerm?.revisionId === start.selectedTerm?.revisionId; }
  function sameContextTarget(before: ResourceDraftState, start: ResourceDraftState) { return before.locale === start.locale && before.selectedUnit?.unitId === start.selectedUnit?.unitId && before.selectedUnit?.sourceRevisionId === start.selectedUnit?.sourceRevisionId && before.contextRevision?.revisionId === start.contextRevision?.revisionId; }
  function matchingPreview(before: ResourceDraftState, start: ResourceDraftState) { return before.preview === start.preview && before.previewCapture?.captureId === start.previewCapture?.captureId && before.locale === start.locale; }
  function confirmTerm(action: Extract<ResourcePending, { kind: "term" }>, revision: TermRevision) {
    const request = action.request;
    if (!sameTerm(revision, request) || revision.locale !== request.locale || (request.termId != null && revision.termId !== request.termId)
      || revision.previousRevisionId !== nullable(request.expectedRevisionId) || revision.originKind !== "manual" || revision.removed
      || revision.captureId !== null || revision.externalEntryId !== null) invalidReceipt();
    update(before => {
      if (before.pending !== action) return before;
      const unchanged = before.termSeq === action.submittedSeq && sameTerm(before.termDraft, request) && before.aliasInput === action.aliasInput;
      return { ...before, selectedTerm: revision, termDraft: unchanged ? resourceTermDraftFor(revision) : before.termDraft,
        aliasInput: unchanged ? revision.aliases.join(", ") : before.aliasInput, newerTerm: !unchanged, pending: null, pendingUncertain: false, pendingCheckedMissing: false, checkingAction: null,
        notice: unchanged ? "saved" : "savedNewer", failure: null, completionVersion: before.completionVersion + 1 };
    });
  }
  function confirmContext(action: Extract<ResourcePending, { kind: "context" }>, revision: ContextRevision) {
    const request = action.request;
    if (revision.unitId !== request.unitId || revision.locale !== request.locale || revision.text !== request.text || revision.reason !== request.reason
      || revision.previousRevisionId !== nullable(request.expectedRevisionId)) invalidReceipt();
    update(before => {
      if (before.pending !== action) return before;
      const unchanged = before.contextSeq === action.submittedSeq && before.contextDraft === request.text && before.contextReason === request.reason;
      return { ...before, contextRevision: revision, contextDraft: unchanged ? revision.text : before.contextDraft,
        contextReason: unchanged ? revision.reason : before.contextReason, newerContext: !unchanged, pending: null, pendingUncertain: false, pendingCheckedMissing: false, checkingAction: null,
        notice: unchanged ? "saved" : "savedNewer", failure: null, completionVersion: before.completionVersion + 1 };
    });
  }
  function confirmDecision(action: Extract<ResourcePending, { kind: "decision" }>, result: ResourceDecisionResult) {
    if (result.actionId !== action.request.actionId || result.decision !== action.request.decision || jsonIdentity(result.request) !== jsonIdentity(action.request)) invalidReceipt();
    update(before => before.pending === action ? { ...before, pending: null, pendingUncertain: false, pendingCheckedMissing: false, checkingAction: null, previewNeedsRefresh: true, notice: "decisionSaved", failure: null, completionVersion: before.completionVersion + 1 } : before);
  }
  function confirmCapture(action: Extract<ResourcePending, { kind: "capture" }>, capture: ContextCapture) {
    const request = action.request;
    if (capture.unitId !== request.unitId || capture.locale !== request.locale || capture.sourceRevisionId !== request.sourceRevisionId || capture.budgetBytes !== request.budgetBytes) invalidReceipt();
    update(before => before.pending === action ? { ...before, fixedContext: capture, pending: null, pendingUncertain: false, pendingCheckedMissing: false, checkingAction: null, notice: "captureSaved", failure: null, completionVersion: before.completionVersion + 1 } : before);
  }
  function canReceiveCorrection(locale: string) {
    return localeAvailable(locale) && !reserved() && !termDirty() && !contextDirty() && !factDirty() && !correctionDirty()
      && !tool.blocked() && !tool.hasDraft();
  }
  function receiveCorrection(evidence: CorrectionTermEvidence, before: ResourceDraftState, proof: () => boolean) {
    if (current() !== before || !canReceiveCorrection(evidence.basis.locale) || !proof()
      || evidence.basis.projectId !== session.projectId || !evidence.current) return false;
    const retained = before.locale === evidence.basis.locale ? before : resetLocale(before, evidence.basis.locale);
    update(() => ({ ...retained, correctionDraft: { evidence: structuredClone(evidence), source: "", target: "", protected: false, reason: "", editSeq: 0 },
      correctionReceipt: null, notice: null, failure: null }));
    return true;
  }
  function editCorrection(patch: Partial<Pick<ResourceCorrectionDraft, "source" | "target" | "protected" | "reason">>) {
    update(before => before.correctionDraft ? { ...before, correctionDraft: { ...before.correctionDraft, ...patch, editSeq: before.correctionDraft.editSeq + 1 } } : before);
  }
  function discardCorrection() { if (!reserved()) update(before => ({ ...before, correctionDraft: null, notice: null, failure: null })); }
  function confirmCorrection(action: Extract<ResourcePending, { kind: "correction" }>, receipt: CorrectionTermReceipt) {
    confirmCorrectionCapture(action.request, receipt);
    update(before => {
      if (before.pending !== action) return before;
      const unchanged = before.correctionDraft?.editSeq === action.submittedSeq;
      return { ...before, correctionDraft: unchanged ? null : before.correctionDraft, correctionReceipt: receipt,
        previewCapture: receipt.capture, preview: null, previewSourceBasis: null, previewNeedsRefresh: true,
        pending: null, pendingUncertain: false, pendingCheckedMissing: false, checkingAction: null, failure: null,
        notice: unchanged ? "correctionSaved" : "correctionSavedNewer", completionVersion: before.completionVersion + 1 };
    });
    reads.invalidate(["resources"], false);
  }
  async function captureCorrection(proof: () => boolean) {
    const before = current(), draft = before.correctionDraft;
    if (!draft || !localeAvailable(draft.evidence.basis.locale) || !proof() || !draft.source.trim() || !draft.target.trim() || !draft.reason.trim() || !reserve()) return;
    try {
      const actionId = await executionCommands.identity(session);
      if (!live() || current().correctionDraft !== draft || !proof()) return;
      const request: CaptureCorrectionTerm = { actionId, basis: structuredClone(draft.evidence.basis),
        source: draft.source, target: draft.target, protected: draft.protected, reason: draft.reason };
      await dispatch({ kind: "correction", session, request, submittedSeq: draft.editSeq });
    } catch (error) { fail(error); } finally { release(); }
  }
  async function lookupPending(action: ResourcePending) {
    if (!live() || current().pending !== action) return;
    update(before => ({ ...before, checkingAction: "resource", failure: null, notice: null, pendingCheckedMissing: false }));
    try {
      const request = { ...action.session, actionId: action.request.actionId };
      if (action.kind === "correction") {
        const receipt = await resourceCommands.correctionAction(request);
        if (!live() || current().pending !== action) return;
        if (receipt === null) update(before => ({ ...before, pendingCheckedMissing: true })); else confirmCorrection(action, receipt);
      } else if (action.kind === "decision") {
        const receipt = await resourceCommands.decisionAction(request);
        if (!live() || current().pending !== action) return;
        if (receipt === null) update(before => ({ ...before, pendingCheckedMissing: true })); else confirmDecision(action, receipt);
      } else if (action.kind === "term") {
        const value = await resourceCommands.termAction({ ...action.session, term: action.request });
        if (!live() || current().pending !== action) return;
        if (value === null) update(before => ({ ...before, pendingCheckedMissing: true })); else confirmTerm(action, value.receipt);
      } else if (action.kind === "context") {
        const value = await resourceCommands.contextAction({ ...action.session, context: action.request });
        if (!live() || current().pending !== action) return;
        if (value === null) update(before => ({ ...before, pendingCheckedMissing: true })); else confirmContext(action, value.receipt);
      } else {
        const value = await resourceCommands.contextCaptureAction({ ...action.session, capture: action.request });
        if (!live() || current().pending !== action) return;
        if (value === null) update(before => ({ ...before, pendingCheckedMissing: true })); else confirmCapture(action, value.receipt);
      }
    } finally { if (live() && current().pending === action) update(before => ({ ...before, checkingAction: null })); }
  }
  async function checkPending() {
    const action = current().pending, previousFailure = current().failure;
    if (!live() || running.current || !action) return;
    running.current = true; update(before => ({ ...before, busyMutation: true }));
    try {
      await lookupPending(action);
      if (live() && current().pending === action) update(before => ({ ...before, failure: previousFailure, notice: "unknown" }));
    } catch (error) { if (live() && current().pending === action) fail(error, "unknown"); } finally { release(); }
  }
  async function readPreview(capture: GlossaryCapture, isCurrent: () => boolean = live) {
    if (!live() || !isCurrent() || !canReadCapture(capture)) return;
    // The user explicitly accepts a comparison against this source scope. Keep
    // this small immutable basis separate from the current Query projection.
    const sourceKey = reads.key(["resource-source-scope"]);
    const source = await reads.client.fetchQuery<ContentScope>({ queryKey: sourceKey, meta: { scopes: ["source"] }, queryFn: () => sourceCommands.scope(session) });
    if (!live() || !isCurrent()) return;
    if (!source.currentSnapshot && capture.origin.kind === "file") throw { reason: "resource-source" };
    const basis: ResourceSourceBasis = { revision: source.revision, snapshotId: source.currentSnapshot };
    const result = await resourceCommands.preview({ ...session, captureId: capture.captureId });
    if (!live() || !isCurrent()) return;
    if (jsonIdentity(result.capture) !== jsonIdentity(capture)) invalidReceipt();
    const currentSource = reads.client.getQueryData<ContentScope>(sourceKey), sourceState = reads.client.getQueryState(sourceKey);
    if (sourceState?.status !== "success" || sourceState.fetchStatus !== "idle" || sourceState.isInvalidated
      || !currentSource || currentSource.revision !== basis.revision || currentSource.currentSnapshot !== basis.snapshotId) throw { reason: "resource-basis" };
    // An explicit read may establish a new comparison baseline. Seed only its
    // current projection; automatic Query reads never adopt an owner baseline.
    reads.client.setQueryData(reads.key(["resource-preview-current", capture.captureId]), result);
    update(before => before.previewCapture === capture && canReadCapture(capture)
      ? { ...before, preview: result, previewSourceBasis: basis, previewNeedsRefresh: false, notice: "previewReady", failure: null } : before);
  }
  async function dispatch(action: ResourcePending) {
    if (!live()) return;
    update(before => ({ ...before, pending: action, pendingCheckedMissing: false }));
    let writeFailure: CommandFailure | null = null;
    try {
      if (action.kind === "correction") { const result = await resourceCommands.captureCorrection({ ...action.session, capture: action.request }); if (live()) confirmCorrection(action, result); }
      if (action.kind === "term") { const result = await resourceCommands.saveTerm({ ...action.session, term: action.request }); if (live()) confirmTerm(action, result); }
      if (action.kind === "context") { const result = await resourceCommands.saveContext({ ...action.session, context: action.request }); if (live()) confirmContext(action, result); }
      if (action.kind === "capture") { const result = await resourceCommands.captureContext({ ...action.session, capture: action.request }); if (live()) confirmCapture(action, result); }
      if (action.kind === "decision") {
        const result = await resourceCommands.decide({ ...action.session, decision: action.request });
        if (!live()) return;
        confirmDecision(action, result);
      }
      return;
    } catch (error) {
      if (!live() || current().pending !== action) return;
      const notCommitted = current().pending === action && isReceiptFirstRejection(action, error);
      const unknown = hasUnknownOutcome(error);
      writeFailure = commandFailure(error);
      update(before => {
        if (before.pending !== action) return before;
        const uncertain = !notCommitted && (unknown || before.pendingUncertain);
        return { ...before, pending: uncertain ? action : null, pendingUncertain: uncertain, pendingCheckedMissing: false,
          previewNeedsRefresh: before.previewNeedsRefresh || notCommitted && action.kind === "decision",
          notice: unknown ? null : uncertain ? "unknown" : "error", failure: unknown ? null : writeFailure };
      });
      if (notCommitted) reads.invalidate(["source", "translation", "resources"], false);
      if (!unknown) return;
    }
    try {
      await lookupPending(action);
      if (live() && current().pending === action) update(before => ({ ...before, failure: writeFailure, notice: "unknown" }));
    } catch (error) { if (live() && current().pending === action) fail(error, "unknown"); }
  }
  async function fresh(kind: ResourcePending["kind"], entry?: { entryId: string; expectedRevisionId: string | null; decision: ResourceDecision["decision"] }, isScopeCurrent: () => boolean = () => true) {
    const start = current(), locale = kind === "decision" ? start.previewCapture?.targetLocale ?? "" : start.locale;
    if (!(kind === "decision" ? decisionLocaleAvailable(start, entry?.decision) : localeAvailable(locale)) || (kind === "term" && (!start.termDraft.source.trim() || !start.termDraft.target.trim() || !start.termDraft.reason.trim()))
      || ((kind === "context" || kind === "capture") && (!start.selectedUnit?.unitId || !start.selectedUnit.sourceRevisionId))
      || (kind === "context" && !start.contextReason.trim()) || (kind === "decision" && (!entry || !start.preview || start.previewNeedsRefresh || !matchingEntry(start.preview, entry)))) return;
    if (!isScopeCurrent()) { fail({ reason: "resource-basis" }); return; }
    if (!reserve()) return;
    try {
      const actionId = await executionCommands.identity(session);
      const latest = current();
      // Identity allocation is asynchronous. Recheck read evidence without the
      // mutation's own busy reservation, before dispatching a fresh request.
      if (live() && !isScopeCurrent()) { fail({ reason: "resource-basis" }); return; }
      if (!live() || !(kind === "decision" ? decisionLocaleAvailable(start, entry?.decision) : localeAvailable(locale)) || latest.pending
        || (kind === "term" && !sameTermTarget(latest, start))
        || ((kind === "context" || kind === "capture") && !sameContextTarget(latest, start))
        || (kind === "decision" && !matchingPreview(latest, start))) return;
      if (kind === "term") await dispatch({ kind, session, request: { ...start.termDraft, aliases: [...start.termDraft.aliases], projectId: session.projectId, actionId,
        termId: start.selectedTerm?.termId ?? null, locale, expectedRevisionId: start.selectedTerm?.revisionId ?? null }, submittedSeq: start.termSeq, aliasInput: start.aliasInput });
      if (kind === "context") await dispatch({ kind, session, request: { projectId: session.projectId, actionId, unitId: start.selectedUnit!.unitId!, locale,
        sourceRevisionId: start.selectedUnit!.sourceRevisionId!, expectedRevisionId: start.contextRevision?.revisionId ?? null, text: start.contextDraft, reason: start.contextReason }, submittedSeq: start.contextSeq });
      if (kind === "capture") await dispatch({ kind, session, request: { projectId: session.projectId, actionId, unitId: start.selectedUnit!.unitId!, locale, sourceRevisionId: start.selectedUnit!.sourceRevisionId!, budgetBytes: 16 * 1024 } });
      if (kind === "decision") await dispatch({ kind, session, locale, request: { projectId: session.projectId, actionId, captureId: start.previewCapture!.captureId, ...entry! } });
    } catch (error) { fail(error); }
    finally { release(); }
  }
  function matchingEntry(preview: ResourcePreview, entry: { entryId: string; expectedRevisionId: string | null; decision: ResourceDecision["decision"] }) {
    if (preview.mcp && !preview.mcp.current && (entry.decision === "adopt" || entry.decision === "override")) return false;
    const row = preview.rows.find(value => value.entry.id === entry.entryId);
    if (row) return !(preview.correction && (entry.decision === "override" || entry.decision === "adopt" && (!preview.correction.evidence.current || row.current !== null))) && nullable(row.current?.revisionId) === entry.expectedRevisionId && !(entry.decision === "adopt" && (row.kind === "unchanged" || row.kind === "override"));
    return preview.removed.some(value => value.externalEntryId === entry.entryId && value.revisionId === entry.expectedRevisionId);
  }
  async function retryPending() {
    const action = current().pending;
    if (!live() || !action || running.current || current().pendingUncertain && !current().pendingCheckedMissing) return;
    running.current = true; update(before => ({ ...before, busyMutation: true, failure: null, notice: null }));
    try { await dispatch(action); } finally { release(); }
  }
  async function openPreview(capture: GlossaryCapture, isCurrent: () => boolean = live) {
    if (!isCurrent() || !canReadCapture(capture) || !reserve()) return;
    update(before => ({ ...before, previewCapture: capture, preview: null, previewSourceBasis: null, previewNeedsRefresh: true }));
    try { await readPreview(capture, isCurrent); } catch (error) { if (isCurrent()) fail(error); } finally { release(); }
  }
  async function retryPreview(isCurrent?: () => boolean) { const capture = current().previewCapture; if (capture) await openPreview(capture, isCurrent); }
  function canReceiveMcp(capture: GlossaryCapture) {
    return capture.origin.kind === "mcp" && canReadCapture(capture) && !reserved() && !termDirty() && !contextDirty() && !factDirty() && !correctionDirty()
      && !tool.blocked() && !tool.hasDraft();
  }
  async function openMcpPreview(capture: GlossaryCapture, before: ResourceDraftState, proof: () => boolean) {
    if (current() !== before || !canReceiveMcp(capture) || !proof()) return false;
    if (before.locale !== capture.targetLocale && localeAvailable(capture.targetLocale) && !setLocale(capture.targetLocale)) return false;
    const original = current(), sequence = tool.draftSequence.current;
    const unchanged = () => proof() && live() && current().termSeq === original.termSeq && current().contextSeq === original.contextSeq
      && current().correctionDraft === original.correctionDraft && current().factDraft === original.factDraft && current().locale === original.locale
      && tool.draftSequence.current === sequence && !current().pending && !current().factPending;
    await openPreview(capture, unchanged);
    return unchanged() && current().previewCapture?.captureId === capture.captureId && current().preview?.mcp != null && !current().previewNeedsRefresh;
  }
  async function chooseFile(isCurrent: () => boolean = live) {
    const locale = current().locale;
    if (!localeAvailable(locale) || termDirty() || contextDirty() || !reserve()) return;
    let captured = false;
    try {
      const capture = await resourceCommands.chooseFile(session);
      if (!live() || !capture) return;
      captured = true;
      // The picker has already captured input. Keep its identity even if the following read fails.
      update(before => ({ ...before, previewCapture: capture, preview: null, previewSourceBasis: null, previewNeedsRefresh: true, completionVersion: before.completionVersion + 1 }));
      if (isCurrent() && localeAvailable(capture.targetLocale) && current().locale === locale) await readPreview(capture, isCurrent);
    } catch (error) { if (!captured || isCurrent()) fail(error, hasUnknownOutcome(error) && !captured ? "pickerUnknown" : "error"); }
    finally { release(); }
  }
  return <ResourceContext.Provider value={{ canReceiveMcp, openMcpPreview, correctionDirty,canReceiveCorrection,receiveCorrection,editCorrection,discardCorrection,captureCorrection,checkPending, factDirty,factBlocked,beginFact,editFact,discardFact,saveFact,checkFact,retryFact, tool, state, current, inFlight: () => running.current, termDirty, contextDirty, localeAvailable,
    setLocale, beginTerm, editTerm, discardTerm, beginContext, canReceiveContext, receiveContext, adoptContext, editContext, editContextReason, discardContext, discard,
    canReadCapture, saveTerm: proof => fresh("term", undefined, proof), saveContext: proof => fresh("context", undefined, proof), captureContext: proof => fresh("capture", undefined, proof),
    decide: (entryId, expectedRevisionId, decision, proof) => fresh("decision", { entryId, expectedRevisionId, decision }, proof), retryPending, chooseFile, openPreview, retryPreview }}>{children}</ResourceContext.Provider>;
}
