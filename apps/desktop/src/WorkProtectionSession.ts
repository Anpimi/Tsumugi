import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { executionCommands, executionContext } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionAlive, useSessionReads } from "./SessionReadProvider";
import { workPlanCommands } from "./workPlanCommands";
import { commandFailure, type CommandFailure } from "./CommandFailure";
export type ProtectionRequest = Parameters<typeof workPlanCommands.setProtection>[0];
export interface ProtectionBasis {
  request: Omit<ProtectionRequest, "actionId" | "protected" | "confirmedRelease">;
  key: string;
  sourceText: string | null;
  selectionText: string | null;
}
export interface PendingProtection {
  request: ProtectionRequest;
  key: string;
  phase: "pending" | "unknown";
}

interface State { pending: PendingProtection | null; failure: CommandFailure | null; busy: boolean }
export function protectionKey(unitId: string, locale: string, sourceRevisionId: string, selectionId: string | null) {
  return ["work-protection", unitId, locale, sourceRevisionId, selectionId];
}
/** Protection shares the manual translation reservation and keeps one complete original action. */
export function useWorkProtectionSession(project: ProjectView, ports: { reserve: () => symbol | null; release: (token: symbol) => void }) {
  const [context] = useState(() => executionContext(project)), reads = useSessionReads(), mounted = useSessionAlive();
  const [state, setState] = useState<State>({ pending: null, failure: null, busy: false });
  const projectRef = useRef(project);
  useLayoutEffect(() => { projectRef.current = project; }, [project]);
  const currentState = useRef(state), inFlight = useRef(false), reservation = useRef<symbol | null>(null), attemptedEdit = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; release(); }; }, []);
  function update(patch: Partial<State>) { if (!mounted.current) return; currentState.current = { ...currentState.current, ...patch }; setState(currentState.current); }
  function release() { const token = reservation.current; reservation.current = null; if (token) ports.release(token); }
  function sameContext(request: ProtectionRequest | ProtectionBasis["request"]) {
    return request.projectId === context.projectId && request.sessionToken === context.sessionToken;
  }
  async function submit(request: ProtectionRequest, key: string) {
    const originalUnknown = currentState.current.pending?.request.actionId === request.actionId && currentState.current.pending.phase === "unknown";
    update({ pending: { request, key, phase: "pending" }, failure: null });
    let receipt: Awaited<ReturnType<typeof workPlanCommands.setProtection>>;
    try {
      receipt = await workPlanCommands.setProtection(request);
    } catch(error) {
      if (mounted.current) {
        const uncertain = originalUnknown || hasUnknownOutcome(error);
        update({ pending: uncertain ? { request, key, phase: "unknown" } : null, failure: commandFailure(error) });
        if (!uncertain) release();
      }
      throw error;
    }
    if (!mounted.current) return null;
    update({ pending: null }); release();
    // A subsequent projection failure cannot undo a checked mutation acknowledgement.
    await reads.client.invalidateQueries({ queryKey: reads.key(protectionKey(request.unitId, request.locale, request.sourceRevisionId, request.selectionId ?? null)), exact: true, refetchType: "none" });
    return receipt;
  }
  async function change(basis: ProtectionBasis, protectedValue: boolean, proof: () => boolean) {
    if (!mounted.current || inFlight.current || currentState.current.pending || !sameContext(basis.request) || !projectRef.current.metadata.targetLocales.includes(basis.request.locale) || !proof()) return null;
    const token = ports.reserve(); if (!token) return null;
    reservation.current = token; inFlight.current = true; update({ busy: true, failure: null });
    try {
      const actionId = await executionCommands.identity(context);
      if (!mounted.current || !projectRef.current.metadata.targetLocales.includes(basis.request.locale) || !proof()) return null;
      return await submit(Object.freeze({ ...basis.request, actionId, protected: protectedValue, confirmedRelease: !protectedValue }), basis.key);
    } finally {
      inFlight.current = false; update({ busy: false });
      if (!currentState.current.pending) release();
    }
  }
  async function retry(proof: () => boolean) {
    const original = currentState.current.pending;
    if (!mounted.current || inFlight.current || original?.phase !== "unknown" || !sameContext(original.request) || !proof()) return;
    inFlight.current = true; update({ busy: true });
    try { await submit(original.request, original.key); }
    finally { inFlight.current = false; update({ busy: false }); }
  }
  return { state, current: () => currentState.current, inFlight, attemptedEdit, blocked: () => inFlight.current || !!currentState.current.pending, change, retry };
}
export type WorkProtectionSession = ReturnType<typeof useWorkProtectionSession>;
