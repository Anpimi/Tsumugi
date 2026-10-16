import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands } from "./executionCommands";
import { useSessionAlive, useSessionReads } from "./SessionReadProvider";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { mcpCommands, sameMcpIdentity, sameMcpAuthorization, type McpShareAuthorization, type McpSharePrepared, type McpShareView,
  type McpShareConfiguration, type McpSharePreparation, type McpShareRevokeRequest } from "./mcpCommands";
import type { ProjectView } from "./projectCommands";

/** Local entry context is never part of the external payload or a read cache. */
export interface McpSharingTarget { unitId: string; locale: string; key: string; sourceRevisionId: string; sourceSnapshotId: string; selectionId: string | null; translationRevisionId: string | null }
interface Operation {
  preparation: McpSharePreparation;
  prepared: McpSharePrepared | null;
  editSeq: number;
  authorization: McpShareAuthorization | null;
  configuration: McpShareConfiguration | null;
  uncertain: boolean;
  closed: boolean;
  phase: McpShareView["phase"] | null;
}
interface State {
  target: McpSharingTarget | null;
  recipientLabel: string;
  shareTerms: boolean;
  shareContext: boolean;
  editSeq: number;
  consent: boolean;
  stale: boolean;
  operation: Operation | null;
  busy: "preparing" | "authorizing" | null;
  revocation: { request: McpShareRevokeRequest; pending: boolean; uncertain: boolean } | null;
  reading: boolean;
  readFailed: boolean;
  failure: CommandFailure | null;
}
const initialState = (): State => ({ target: null, recipientLabel: "", shareTerms: false, shareContext: false, editSeq: 0,
  consent: false, stale: false, operation: null, busy: null, revocation: null, reading: false, readFailed: false, failure: null });
function fixed<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown) { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } }
  freeze(copy); return copy;
}
const phaseOrder = { prepared: 0, "awaiting-pairing": 1, connected: 2, closing: 3, closed: 4 } as const;
export function validMcpRecipientLabel(value: string) { return !!value.trim() && new TextEncoder().encode(value).byteLength <= 128 && !/\p{Cc}/u.test(value); }
export const mcpShareStatusKey = (operation: Pick<Operation, "preparation" | "authorization">) => ["mcp-share-status", operation.preparation.identity.ownerId,
  operation.preparation.identity.generation, operation.preparation.identity.shareId, operation.authorization?.actionId ?? null] as const;

function useSharing(project: ProjectView) {
  const reads = useSessionReads(), mounted = useSessionAlive(), translations = useTranslationDraftSession();
  const [state, setState] = useState<State>(initialState), currentState = useRef(state), projectRef = useRef(project);
  const primary = useRef<object | null>(null), control = useRef<object | null>(null), reading = useRef<object | null>(null);
  const invalidations = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null), focusPending = useRef(false);
  const draftSequence = useRef<string | null>(null);
  const [session] = useState(() => ({ ...reads.context }));
  function live() { return mounted.current && !reads.retired && reads.context.projectId === session.projectId && reads.context.sessionToken === session.sessionToken
    && projectRef.current.metadata.projectId === session.projectId && projectRef.current.sessionToken === session.sessionToken; }
  function current() { return currentState.current; }
  function update(change: (before: State) => State) { if (!live()) return; const next = change(currentState.current); currentState.current = next; setState(next); }
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; primary.current = null; control.current = null; reading.current = null; }; }, []);
  useLayoutEffect(() => {
    projectRef.current = project;
    const value = current(), target = value.target;
    const draft = translations.current();
    const sequence = draft ? JSON.stringify([draft.unitId, draft.locale, draft.sourceRevisionId, draft.editSeq, draft.text, draft.baseSelectionId, draft.baseRevisionId]) : null;
    const previous = draftSequence.current; draftSequence.current = sequence;
    if (target && (previous !== sequence && previous !== null || !project.metadata.targetLocales.includes(target.locale))) invalidate();
  }, [project, translations.draft]);
  useLayoutEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(scope => scope === "source" || scope === "translation" || scope === "resources" || scope === "project")) invalidate();
  }), [reads]);
  useLayoutEffect(() => {
    if (state.target || !focusPending.current) return;
    focusPending.current = false;
    const trigger = returnFocus.current; returnFocus.current = null;
    if (trigger?.isConnected && !trigger.matches(":disabled") && !trigger.closest("[hidden]")) trigger.focus();
    else (document.querySelector<HTMLElement>(".workbench-panel:not([hidden]) .workbench-heading h1")
      ?? document.querySelector<HTMLElement>(".navigation-item[aria-current='page']"))?.focus();
  }, [state.target]);
  function invalidate() { if (current().target) { invalidations.current++; update(value => ({ ...value, stale: true, consent: false })); } }
  function activeOperation(operation: Operation) { return live() && current().operation?.preparation === operation.preparation; }
  function begin(target: McpSharingTarget, trigger?: HTMLElement) {
    if (!live() || current().target || primary.current || control.current || !projectRef.current.metadata.targetLocales.includes(target.locale)) return false;
    returnFocus.current = trigger ?? null;
    update(() => ({ ...initialState(), target: fixed(target) })); return true;
  }
  function edit(change: Partial<Pick<State, "recipientLabel" | "shareTerms" | "shareContext">>) {
    update(value => ({ ...value, ...change, editSeq: value.editSeq + 1, consent: false, stale: value.operation !== null || value.stale }));
  }
  function setConsent(consent: boolean) {
    const value = current();
    if (!value.operation?.prepared || value.busy || value.stale || value.operation.authorization || value.operation.closed
      || value.operation.editSeq !== value.editSeq) return;
    update(before => ({ ...before, consent }));
  }
  function putStatus(operation: Operation, view: McpShareView) {
    if (!activeOperation(operation)) return;
    const before = current().operation;
    if (!before || before.closed && !(view.admissionClosed && view.callbacksDrained)
      || before.phase && phaseOrder[view.phase] < phaseOrder[before.phase]) return;
    if (before.authorization && view.authorization && !sameMcpAuthorization(before.authorization, view.authorization)) throw new Error("Changed sharing authorization");
    const previous = reads.client.getQueryData<McpShareView>(reads.key(mcpShareStatusKey(before)));
    if (previous?.expiresAtMs != null && view.expiresAtMs !== previous.expiresAtMs) throw new Error("Changed sharing expiry");
    const closed = view.admissionClosed && view.callbacksDrained;
    reads.client.setQueryData(reads.key(mcpShareStatusKey(before)), view);
    const authorizationConfirmed = before.authorization !== null && view.authorization !== null;
    if (closed || authorizationConfirmed && current().busy === "authorizing") primary.current = null;
    if (closed) control.current = null;
    update(value => value.operation?.preparation !== operation.preparation ? value : { ...value,
      busy: closed || authorizationConfirmed && value.busy === "authorizing" ? null : value.busy,
      revocation: closed && value.revocation ? { ...value.revocation, pending: false, uncertain: false } : value.revocation,
      operation: { ...value.operation, phase: view.phase, closed, configuration: closed ? null : value.operation.configuration,
        uncertain: closed || view.authorization !== null ? false : value.operation.uncertain } });
  }
  async function refresh(replaceWait = false) {
    const operation = current().operation;
    if (!live() || !operation || reading.current && !replaceWait) return;
    const ticket = {}; reading.current = ticket;
    update(value => ({ ...value, reading: true, readFailed: false, failure: null }));
    try {
      if (replaceWait) {
        // Retire this caller's wait only. The original Host read may still
        // finish, but cannot populate this exact Query after cancellation.
        await reads.client.cancelQueries({ queryKey: reads.key(mcpShareStatusKey(operation)), exact: true });
        if (reading.current !== ticket || !activeOperation(operation)) return;
      }
      const request = { ...session, identity: operation.preparation.identity, authorization: operation.authorization };
      const view = await reads.client.fetchQuery({ queryKey: reads.key(mcpShareStatusKey(operation)), staleTime: 0,
        queryFn: async ({ signal }) => {
          const previous = reads.client.getQueryData<McpShareView>(reads.key(mcpShareStatusKey(operation)));
          const view = await mcpCommands.read(request, operation.preparation, operation.prepared?.preview.digest ?? null);
          if (signal.aborted || reading.current !== ticket) throw new Error("Sharing read wait retired");
          if (previous?.expiresAtMs !== null && previous?.expiresAtMs !== undefined && view.expiresAtMs !== previous.expiresAtMs) throw new Error("Changed sharing expiry");
          const latest = current().operation;
          if (!activeOperation(operation) || !latest || latest.closed && !(view.admissionClosed && view.callbacksDrained)
            || latest.phase && phaseOrder[view.phase] < phaseOrder[latest.phase]) throw new Error("Obsolete sharing status");
          if (latest.authorization && view.authorization && !sameMcpAuthorization(latest.authorization, view.authorization)) throw new Error("Changed sharing authorization");
          return view;
        } });
      if (reading.current === ticket) putStatus(operation, view);
    } catch (error) {
      if (reading.current === ticket && activeOperation(operation)) update(value => ({ ...value, readFailed: true, failure: commandFailure(error) }));
    } finally { if (reading.current === ticket) { reading.current = null; update(value => ({ ...value, reading: false })); } }
  }
  async function prepare() {
    const before = current(), target = before.target;
    if (!live() || !target || primary.current || control.current || before.operation && !before.operation.closed
      || !validMcpRecipientLabel(before.recipientLabel) || !projectRef.current.metadata.targetLocales.includes(target.locale)) return;
    const ticket = {}; primary.current = ticket;
    const version = invalidations.current;
    update(value => ({ ...value, busy: "preparing", consent: false, failure: null }));
    try {
      const sessionView = await mcpCommands.session(session);
      if (primary.current !== ticket || !live()) return;
      if (sessionView.kind !== "available" || sessionView.current !== null && (!before.operation?.closed
        || !sameMcpIdentity(sessionView.current, before.operation.preparation.identity))) throw new Error("Sharing owner is unavailable");
      const shareId = await executionCommands.identity(session);
      if (primary.current !== ticket || !live()) return;
      if (current().editSeq !== before.editSeq || current().target !== target || invalidations.current !== version) { update(value => ({ ...value, busy: null, stale: true })); return; }
      const preparation: McpSharePreparation = fixed({ identity: { ownerId: sessionView.ownerId, generation: sessionView.nextGeneration, shareId },
        recipientLabel: before.recipientLabel, selection: { projectId: session.projectId, unitId: target.unitId, locale: target.locale,
          shareTerms: before.shareTerms, shareContext: before.shareContext } });
      const operation: Operation = { preparation, prepared: null, editSeq: before.editSeq, authorization: null, configuration: null, uncertain: false, closed: false, phase: null };
      update(value => ({ ...value, operation, revocation: null, stale: false }));
      const prepared = await mcpCommands.prepare({ ...session, preparation });
      if (primary.current !== ticket || !activeOperation(operation) || current().operation?.closed) return;
      update(value => value.operation ? { ...value, operation: { ...value.operation, prepared: fixed(prepared) },
        stale: value.stale || value.editSeq !== before.editSeq, busy: null } : value);
      void refresh();
    } catch (error) {
      if (primary.current === ticket) update(value => ({ ...value, busy: null, failure: commandFailure(error),
        operation: value.operation ? { ...value.operation, uncertain: true } : null }));
    } finally { if (primary.current === ticket) { primary.current = null; update(value => ({ ...value, busy: null })); } }
  }
  async function authorize(recover = false) {
    const before = current(), operation = before.operation;
    if (!live() || !operation || !operation.prepared || operation.closed || primary.current || control.current
      || !recover && (!before.consent || before.stale || operation.editSeq !== before.editSeq || operation.authorization)
      || recover && !operation.authorization) return;
    const ticket = {}; primary.current = ticket;
    update(value => ({ ...value, busy: "authorizing", failure: null }));
    try {
      let authorization = operation.authorization;
      if (!authorization) {
        const actionId = await executionCommands.identity(session);
        if (primary.current !== ticket || !activeOperation(operation)) return;
        const latest = current();
        if (!latest.consent || latest.stale || latest.editSeq !== operation.editSeq || latest.operation?.closed || control.current) return;
        authorization = fixed({ identity: operation.preparation.identity, actionId, previewDigest: operation.prepared.preview.digest, validForSeconds: 300, confirmed: true });
        update(value => value.operation ? { ...value, operation: { ...value.operation, authorization } } : value);
      }
      const original = authorization;
      const result = await mcpCommands.authorize({ ...session, authorization: original }, operation.preparation);
      if (primary.current !== ticket || !activeOperation(operation) || current().operation?.closed) return;
      putStatus(operation, result.view);
      update(value => value.operation && !value.operation.closed ? { ...value, operation: { ...value.operation, uncertain: false,
        configuration: value.revocation ? null : fixed(result.configuration) } } : value);
    } catch (error) {
      if (primary.current === ticket && activeOperation(operation)) update(value => value.operation ? { ...value, failure: commandFailure(error),
        operation: { ...value.operation, uncertain: true } } : value);
    } finally { if (primary.current === ticket) { primary.current = null; update(value => ({ ...value, busy: null })); } }
  }
  async function revoke() {
    const operation = current().operation;
    if (!live() || !operation || operation.closed || control.current) return;
    const ticket = {}; control.current = ticket;
    try {
      let request = current().revocation?.request;
      if (!request || !sameMcpIdentity(request.identity, operation.preparation.identity)) {
        const actionId = await executionCommands.identity(session);
        if (control.current !== ticket || !activeOperation(operation)) return;
        request = fixed({ ...session, identity: operation.preparation.identity, actionId });
      }
      update(value => ({ ...value, revocation: { request, pending: true, uncertain: false }, failure: null,
        operation: value.operation ? { ...value.operation, configuration: null } : null }));
      const result = await mcpCommands.revoke(request, operation.preparation);
      if (control.current !== ticket || !activeOperation(operation)) return;
      if (result.admissionClosed && result.callbacksDrained) primary.current = null;
      update(value => ({ ...value, busy: result.callbacksDrained ? null : value.busy,
        operation: value.operation ? { ...value.operation, closed: result.admissionClosed && result.callbacksDrained,
          phase: result.callbacksDrained ? "closed" : "closing", configuration: null, uncertain: false } : null,
        revocation: value.revocation ? { ...value.revocation, pending: false, uncertain: false } : null }));
      void refresh();
    } catch (error) {
      if (control.current === ticket && activeOperation(operation)) update(value => ({ ...value, failure: commandFailure(error),
        revocation: value.revocation ? { ...value.revocation, pending: false, uncertain: true } : null }));
    } finally { if (control.current === ticket) control.current = null; }
  }
  function close() {
    const value = current();
    if (!live() || control.current || value.operation && !value.operation.closed) return false;
    // Before a preparation identity is dispatched, only local read/identity
    // waits exist. Retiring them cannot revoke or create Host authority.
    primary.current = null;
    reading.current = null;
    if (value.operation) void reads.client.cancelQueries({ queryKey: reads.key(mcpShareStatusKey(value.operation)), exact: true });
    focusPending.current = true;
    update(initialState); return true;
  }
  return { state, current, begin, edit, setConsent, prepare, authorize, revoke, refresh, close,
    retryRead: () => refresh(true),
    blocked: () => current().target !== null,
    revision: () => { const value = current(); return [value.editSeq, value.stale, value.busy, value.reading,
      value.operation?.preparation.identity, value.operation?.authorization, value.operation?.closed, value.operation?.uncertain,
      value.revocation?.request.actionId, value.revocation?.pending, value.revocation?.uncertain]; } };
}
type McpSharingOwner = ReturnType<typeof useSharing>;
const Context = createContext<McpSharingOwner | null>(null);
export function McpSharingSession({ project, children }: { project: ProjectView; children: ReactNode }) {
  const owner = useSharing(project); return <Context.Provider value={owner}>{children}</Context.Provider>;
}
export function useMcpSharing() { const owner = useContext(Context); if (!owner) throw new Error("Sharing requires a project session owner"); return owner; }
