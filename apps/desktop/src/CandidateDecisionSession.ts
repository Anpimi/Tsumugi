import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionAlive, useSessionReads } from "./SessionReadProvider";
import { translationCommands, confirmCandidateDecision, type CandidateDecisionRequest, type CandidateDisposition, type TranslationRevision } from "./translationCommands";

export interface CandidateBasis { unitId: string; locale: string; sourceRevisionId: string; baseSelectionId: string | null; baseRevisionId: string | null }
export interface CandidateDecisionState {
  actor: string; reason: string; editSeq: number; busy: boolean; pending: CandidateDecisionRequest | null;
  checkedMissing: boolean; failure: CommandFailure | null; recorded: CandidateDisposition | null;
}
/** Human proposal decisions share the existing translation mutation reservation. */
export function useCandidateDecisionSession(project: ProjectView, owner: {
  current: () => CandidateBasis | null; reserve: () => symbol | null; release: (token: symbol) => void;
}) {
  const reads = useSessionReads(), alive = useSessionAlive();
  const projectRef = useRef(project), ownerRef = useRef(owner);
  const [state, setState] = useState<CandidateDecisionState>({ actor: "", reason: "", editSeq: 0, busy: false, pending: null, checkedMissing: false, failure: null, recorded: null });
  const currentState = useRef(state), reservation = useRef<symbol | null>(null);
  const settledSequence = useRef(0), pendingSequence = useRef(0);
  const [session] = useState(() => executionContext(project));
  useLayoutEffect(() => { projectRef.current = project; ownerRef.current = owner; });
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function current() { return currentState.current; }
  function update(change: (before: CandidateDecisionState) => CandidateDecisionState) {
    if (!alive.current) return;
    const next = change(current()); currentState.current = next; setState(next);
  }
  function release() { const token = reservation.current; reservation.current = null; if (token) ownerRef.current.release(token); }
  function settle(request: CandidateDecisionRequest, value: Awaited<ReturnType<typeof translationCommands.decideCandidate>>) {
    confirmCandidateDecision(request, value);
    if (current().pending !== request) return;
    settledSequence.current = pendingSequence.current;
    update(before => ({ ...before, pending: null, checkedMissing: false, failure: null, recorded: value.request.disposition }));
    release(); reads.invalidate(["translation", "review"], false);
  }
  async function dispatch(request: CandidateDecisionRequest, recovering = false) {
    try { const receipt = await translationCommands.decideCandidate(request); if (alive.current) settle(request, receipt); }
    catch (error) {
      if (!alive.current || current().pending !== request) return;
      const unknown = recovering || hasUnknownOutcome(error);
      update(before => ({ ...before, pending: unknown ? request : null, checkedMissing: false, failure: commandFailure(error) }));
      if (!unknown) release();
    }
  }
  async function decide(revision: TranslationRevision, disposition: CandidateDisposition, proof: () => boolean = () => true, readBasis: () => CandidateBasis | null = () => ownerRef.current.current()) {
    const draft = readBasis(), before = current(), metadata = projectRef.current.metadata;
    if (!alive.current || before.busy || before.pending || !draft || !proof() || !before.actor.trim() || !before.reason.trim()
      || !metadata.targetLocales.includes(draft.locale) || revision.originKind !== "ai" || revision.unitId !== draft.unitId
      || revision.locale !== draft.locale || revision.sourceRevisionId !== draft.sourceRevisionId || revision.revisionId === draft.baseRevisionId
      || (revision.candidateDecision?.request.disposition ?? "restored") === disposition) return;
    const token = ownerRef.current.reserve(); if (!token) return; reservation.current = token;
    update(value => ({ ...value, busy: true, recorded: null, failure: null }));
    try {
      const actionId = await executionCommands.identity(session), latest = readBasis();
      if (!alive.current || !proof() || projectRef.current.metadata.sourceLocale !== metadata.sourceLocale || !projectRef.current.metadata.targetLocales.includes(draft.locale) || latest?.unitId !== draft.unitId
        || latest.locale !== draft.locale || latest.sourceRevisionId !== draft.sourceRevisionId || latest.baseSelectionId !== draft.baseSelectionId || latest.baseRevisionId !== draft.baseRevisionId) return;
      const request: CandidateDecisionRequest = { ...session, decision: { projectId: session.projectId, actionId, unitId: draft.unitId, locale: draft.locale,
        revisionId: revision.revisionId, sourceRevisionId: draft.sourceRevisionId, expectedSelectionId: draft.baseSelectionId,
        expectedDecisionId: revision.candidateDecision?.request.actionId ?? null, disposition, actor: before.actor.trim(), reason: before.reason.trim() } };
      pendingSequence.current = before.editSeq;
      update(value => ({ ...value, pending: request, checkedMissing: false })); await dispatch(request);
    } catch (error) { update(value => ({ ...value, failure: commandFailure(error) })); }
    finally { if (!current().pending) release(); update(value => ({ ...value, busy: false })); }
  }
  async function check() {
    const request = current().pending; if (!request || current().busy || !alive.current) return;
    update(value => ({ ...value, busy: true, failure: null, checkedMissing: false }));
    try {
      const { actionId, unitId, locale } = request.decision;
      const receipt = await translationCommands.candidateAction({ ...session, actionId, unitId, locale });
      if (!alive.current || current().pending !== request) return;
      if (receipt) settle(request, receipt); else update(value => ({ ...value, checkedMissing: true }));
    } catch (error) { update(value => ({ ...value, failure: commandFailure(error) })); }
    finally { update(value => ({ ...value, busy: false })); }
  }
  async function retry() {
    const request = current().pending;
    if (!request || !current().checkedMissing || current().busy || !alive.current) return;
    update(value => ({ ...value, busy: true }));
    try { await dispatch(request, true); } finally { update(value => ({ ...value, busy: false })); }
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
