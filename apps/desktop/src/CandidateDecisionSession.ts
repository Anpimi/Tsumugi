import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionAlive, useSessionReads } from "./SessionReadProvider";
import { translationCommands, confirmCandidateDecision, type CandidateDecision, type CandidateDecisionRequest, type CandidateDisposition, type TranslationRevision } from "./translationCommands";

export interface CandidateBasis { unitId: string; locale: string; sourceRevisionId: string; baseSelectionId: string | null; baseRevisionId: string | null }
/** Batch confirmation captures exact input; the eventual request trims only its audit text. */
export interface CandidateAuditCapture { actor: string; reason: string; editSeq: number }
export type CandidateDecisionOutcome =
  | { kind: "declined"; request: CandidateDecisionRequest | null }
  | { kind: "recorded"; request: CandidateDecisionRequest; receipt: CandidateDecision }
  | { kind: "pending"; request: CandidateDecisionRequest; failure: CommandFailure | null; cause: unknown }
  | { kind: "failed"; request: CandidateDecisionRequest | null; failure: CommandFailure; cause: unknown };
export interface CandidateDecisionState {
  actor: string; reason: string; editSeq: number; busy: boolean; checking: boolean; pending: CandidateDecisionRequest | null;
  checkedMissing: boolean; failure: CommandFailure | null; recorded: CandidateDisposition | null;
}
/** Human proposal decisions share the existing translation mutation reservation. */
export function useCandidateDecisionSession(project: ProjectView, owner: {
  current: () => CandidateBasis | null; reserve: () => symbol | null; release: (token: symbol) => void;
}) {
  const reads = useSessionReads(), alive = useSessionAlive();
  const projectRef = useRef(project), ownerRef = useRef(owner);
  const [state, setState] = useState<CandidateDecisionState>({ actor: "", reason: "", editSeq: 0, busy: false, checking: false, pending: null, checkedMissing: false, failure: null, recorded: null });
  const currentState = useRef(state), reservation = useRef<symbol | null>(null);
  const settledSequence = useRef(0), pendingSequence = useRef(0);
  const [session] = useState(() => executionContext(project));
  useLayoutEffect(() => { projectRef.current = project; ownerRef.current = owner; });
  useEffect(() => { alive.current = true; return () => { alive.current = false; release(); }; }, []);
  function current() { return currentState.current; }
  function update(change: (before: CandidateDecisionState) => CandidateDecisionState) {
    if (!alive.current) return;
    const next = change(current()); currentState.current = next; setState(next);
  }
  function release() { const token = reservation.current; reservation.current = null; if (token) ownerRef.current.release(token); }
  const declined = (request: CandidateDecisionRequest | null = null): CandidateDecisionOutcome => ({ kind: "declined", request });
  const pending = (request: CandidateDecisionRequest, cause: unknown = null): CandidateDecisionOutcome => ({ kind: "pending", request, failure: current().failure, cause });
  function settle(request: CandidateDecisionRequest, value: CandidateDecision): CandidateDecisionOutcome {
    confirmCandidateDecision(request, value);
    if (current().pending !== request) return declined(request);
    settledSequence.current = pendingSequence.current;
    update(before => ({ ...before, pending: null, checking: false, checkedMissing: false, failure: null, recorded: value.request.disposition }));
    release(); reads.invalidate(["translation", "review"], false);
    return { kind: "recorded", request, receipt: value };
  }
  async function lookup(request: CandidateDecisionRequest): Promise<CandidateDecisionOutcome> {
    if (!alive.current || current().pending !== request) return declined(request);
    update(before => ({ ...before, checking: true }));
    try {
      const { actionId, unitId, locale } = request.decision;
      const receipt = await translationCommands.candidateAction({ ...session, actionId, unitId, locale });
      if (!alive.current) return pending(request);
      if (current().pending !== request) return declined(request);
      if (receipt) return settle(request, receipt);
      update(before => ({ ...before, checkedMissing: true })); return pending(request);
    } finally {
      if (alive.current && current().pending === request) update(before => ({ ...before, checking: false }));
    }
  }
  async function dispatch(request: CandidateDecisionRequest, recovering = false): Promise<CandidateDecisionOutcome> {
    let writeFailure: CommandFailure | null = null;
    let writeCause: unknown = null;
    try { const receipt = await translationCommands.decideCandidate(request); return alive.current ? settle(request, receipt) : pending(request); }
    catch (error) {
      if (!alive.current) return pending(request, error);
      if (current().pending !== request) return declined(request);
      const unknown = hasUnknownOutcome(error);
      writeCause = error; writeFailure = commandFailure(error);
      update(before => ({ ...before, pending: recovering || unknown ? request : null, checkedMissing: false,
        failure: unknown ? null : writeFailure }));
      if (!unknown) {
        if (recovering) return pending(request, error);
        release(); return { kind: "failed", request, failure: writeFailure, cause: error };
      }
    }
    // Read once within the original reservation. A failed read cannot re-enter the write catch.
    try {
      const result = await lookup(request);
      if (alive.current && current().pending === request) update(before => ({ ...before, failure: writeFailure }));
      return result.kind === "pending" ? pending(request, writeCause) : result;
    }
    catch (error) {
      if (alive.current && current().pending === request) update(before => ({ ...before, failure: commandFailure(error) }));
      return pending(request, error);
    }
  }
  async function decide(revision: TranslationRevision, disposition: CandidateDisposition, proof: () => boolean = () => true,
    readBasis: () => CandidateBasis | null = () => ownerRef.current.current(), refreshBasis?: () => Promise<void>, audit?: CandidateAuditCapture): Promise<CandidateDecisionOutcome> {
    const basis = readBasis(), draft = basis ? { ...basis } : null, before = current(), metadata = projectRef.current.metadata;
    const capture = audit ? { ...audit } : { actor: before.actor, reason: before.reason, editSeq: before.editSeq };
    const auditCurrent = () => !audit || current().actor === capture.actor && current().reason === capture.reason && current().editSeq === capture.editSeq;
    const candidate = { revisionId: revision.revisionId, expectedDecisionId: revision.candidateDecision?.request.actionId ?? null };
    if (!alive.current || before.busy || before.pending || !draft || !proof() || !capture.actor.trim() || !capture.reason.trim()
      || !auditCurrent()
      || !metadata.targetLocales.includes(draft.locale) || revision.originKind !== "ai" || revision.unitId !== draft.unitId
      || revision.locale !== draft.locale || revision.sourceRevisionId !== draft.sourceRevisionId || revision.revisionId === draft.baseRevisionId
      || (revision.candidateDecision?.request.disposition ?? "restored") === disposition) return declined();
    const token = ownerRef.current.reserve(); if (!token) return declined(); reservation.current = token;
    update(value => ({ ...value, busy: true, recorded: null, failure: null }));
    try {
      const actionId = await executionCommands.identity(session);
      if (!alive.current || !proof() || !auditCurrent()) return declined();
      if (refreshBasis) await refreshBasis();
      const latest = readBasis();
      if (!alive.current || !proof() || !auditCurrent() || projectRef.current.metadata.sourceLocale !== metadata.sourceLocale || !projectRef.current.metadata.targetLocales.includes(draft.locale) || latest?.unitId !== draft.unitId
        || latest.locale !== draft.locale || latest.sourceRevisionId !== draft.sourceRevisionId || latest.baseSelectionId !== draft.baseSelectionId || latest.baseRevisionId !== draft.baseRevisionId) return declined();
      const request: CandidateDecisionRequest = Object.freeze({ ...session, decision: Object.freeze({ projectId: session.projectId, actionId, unitId: draft.unitId, locale: draft.locale,
        revisionId: candidate.revisionId, sourceRevisionId: draft.sourceRevisionId, expectedSelectionId: draft.baseSelectionId,
        expectedDecisionId: candidate.expectedDecisionId, disposition, actor: capture.actor.trim(), reason: capture.reason.trim() }) });
      pendingSequence.current = capture.editSeq;
      update(value => ({ ...value, pending: request, checkedMissing: false })); return await dispatch(request);
    } catch (error) {
      const failure = commandFailure(error); update(value => ({ ...value, failure }));
      return { kind: "failed", request: null, failure, cause: error };
    }
    finally { if (!current().pending) release(); update(value => ({ ...value, busy: false })); }
  }
  async function check(): Promise<CandidateDecisionOutcome> {
    const request = current().pending; if (!request || current().busy || !alive.current) return declined(request);
    update(value => ({ ...value, busy: true, failure: null, checkedMissing: false }));
    try { return await lookup(request); }
    catch (error) {
      if (alive.current && current().pending === request) update(value => ({ ...value, failure: commandFailure(error) }));
      return pending(request, error);
    }
    finally { update(value => ({ ...value, busy: false })); }
  }
  async function retry(): Promise<CandidateDecisionOutcome> {
    const request = current().pending;
    if (!request || !current().checkedMissing || current().busy || !alive.current) return declined(request);
    update(value => ({ ...value, busy: true, failure: null, checkedMissing: false }));
    try { return await dispatch(request, true); } finally { update(value => ({ ...value, busy: false })); }
  }
  function discardInputs() {
    if (current().busy || current().pending) return false;
    settledSequence.current = current().editSeq + 1;
    update(before => ({ ...before,actor:"",reason:"",editSeq:before.editSeq+1,recorded:null,failure:null })); return true;
  }
  return { state, current, blocked: () => current().busy || !!current().pending,
    hasDraft: () => !!(current().actor.trim() || current().reason.trim()) && current().editSeq !== settledSequence.current, discardInputs,
    edit: (field: "actor" | "reason", value: string) => update(before => ({ ...before, [field]: value, editSeq: before.editSeq + 1 })), decide, check, retry };
}
