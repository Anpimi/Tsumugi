import { useLayoutEffect, useRef, useState } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { useSessionReads } from "./SessionReadProvider";
import type { SourceAdoptRequest } from "./sourceCommands";
import { sourceMaintenanceHookCommands as commands, sameSourceHookStop, type SourceMaintenanceHookActivation,
  type SourceMaintenanceHookObservation, type SourceMaintenanceHookStopRequest } from "./sourceMaintenanceHookCommands";

export const sourceHookKey = (actionId: string | null) => ["source-maintenance-hook", actionId] as const;
function fixed<T>(value: T): T { const copy = structuredClone(value); function freeze(item: unknown) {
  if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
} freeze(copy); return copy; }
interface State {
  enabled: boolean; locale: string; activation: SourceMaintenanceHookActivation | null; preparing: boolean; preparationFailure: CommandFailure | null;
  sourceActionId: string | null; originalActivation: SourceMaintenanceHookActivation | null; originalRequest: SourceAdoptRequest | null;
  reading: boolean; readFailure: CommandFailure | null; closed: boolean; drained: boolean;
  stopping: boolean;
  stop: { request: SourceMaintenanceHookStopRequest; pending: boolean; unknown: boolean; notKnown: boolean; ended: boolean } | null;
  stopFailure: CommandFailure | null;
  waitEnded: boolean;
}
export function useSourceMaintenanceHook(project: ProjectView, ports: { live: () => boolean; changed: () => void; canSelect: () => boolean }) {
  const reads = useSessionReads(), projectRef = useRef(project), portsRef = useRef(ports), [session] = useState(() => executionContext(project));
  const [state, setState] = useState<State>({ enabled: false, locale: "", activation: null, preparing: false, preparationFailure: null,
    sourceActionId: null, originalActivation: null, originalRequest: null, reading: false, readFailure: null, closed: false, drained: false, stopping: false, stop: null, stopFailure: null, waitEnded: false });
  const stateRef = useRef(state), declarationTicket = useRef<object | null>(null), readTicket = useRef<object | null>(null), stopTicket = useRef<object | null>(null), selectionTicket = useRef<object | null>(null);
  useLayoutEffect(() => { projectRef.current = project; portsRef.current = ports; });
  useLayoutEffect(() => () => { declarationTicket.current = null; readTicket.current = null; stopTicket.current = null; selectionTicket.current = null; }, []);
  function current() { return stateRef.current; }
  function live() { return portsRef.current.live() && !reads.retired; }
  function update(change: (before: State) => State) { if (!live()) return; const next = change(stateRef.current); stateRef.current = next; setState(next); }
  function editLocale(locale: string) {
    if (!live() || locale && !projectRef.current.metadata.targetLocales.includes(locale)) return;
    declarationTicket.current = null;
    update(value => ({ ...value, locale, enabled: false, activation: null, preparing: false, preparationFailure: null })); portsRef.current.changed();
  }
  async function enable(enabled: boolean) {
    const before = current(); if (!live() || enabled && !projectRef.current.metadata.targetLocales.includes(before.locale)) return;
    const ticket = {}; declarationTicket.current = ticket;
    update(value => ({ ...value, enabled, activation: null, preparing: enabled, preparationFailure: null })); portsRef.current.changed();
    if (!enabled) { declarationTicket.current = null; return; }
    try {
      const key = reads.key(["source-maintenance-hook-session"]);
      await reads.client.cancelQueries({ queryKey: key, exact: true });
      if (!live() || declarationTicket.current !== ticket) return;
      const descriptor = await reads.client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: async ({ signal }) => {
        const value = await commands.session(session); if (signal.aborted || declarationTicket.current !== ticket) throw new Error("Notification declaration read retired"); return value;
      } });
      if (!live() || declarationTicket.current !== ticket || current().locale !== before.locale || !current().enabled) return;
      const activation: SourceMaintenanceHookActivation = fixed({ policyVersion: descriptor.policyVersion, sessionEpoch: descriptor.sessionEpoch,
        locale: before.locale, after: 0, limit: descriptor.windowLimit, expiresAtMs: Date.now() + descriptor.defaultLifetimeMs });
      update(value => ({ ...value, activation, preparing: false }));
    } catch (error) { if (declarationTicket.current === ticket) update(value => ({ ...value, preparing: false, preparationFailure: commandFailure(error) })); }
    finally { if (declarationTicket.current === ticket) declarationTicket.current = null; }
  }
  function canPrepare() { const value = current(); return !value.enabled || !value.preparing && value.activation !== null
    && projectRef.current.metadata.targetLocales.includes(value.locale) && value.activation.expiresAtMs > Date.now(); }
  function capture(request: SourceAdoptRequest) {
    const activation = request.confirmation.maintenanceHook;
    if (!activation || !live() || current().sourceActionId === request.actionId) return;
    selectionTicket.current = null;
    readTicket.current = null;
    update(value => ({ ...value, sourceActionId: request.actionId, originalActivation: fixed(activation), originalRequest: request,
      reading: false, readFailure: null, closed: false, drained: false, stopping: false, stop: null, stopFailure: null, waitEnded: false }));
  }
  function discardDraft() { declarationTicket.current = null; update(value => ({ ...value, enabled: false, locale: "", activation: null, preparing: false, preparationFailure: null })); }
  function status() { const id = current().sourceActionId; return id ? reads.client.getQueryData<SourceMaintenanceHookObservation>(reads.key(sourceHookKey(id))) : undefined; }
  function observe(value: SourceMaintenanceHookObservation) {
    const before = current(); if (!live() || value.sourceActionId !== before.sourceActionId) return;
    if (before.closed && value.view && !value.view.admissionClosed) throw new Error("Obsolete notification observation");
    const stopped = value.view?.stop;
    const confirmedStop = !!before.stop && !!stopped && sameSourceHookStop(before.stop.request.stop, stopped.request) && stopped.admissionClosed;
    if (confirmedStop) stopTicket.current = null;
    update(part => ({ ...part, originalActivation: part.originalActivation ?? value.view?.activation ?? null,
      closed: part.closed || value.view?.admissionClosed === true, drained: part.closed && part.drained || value.callbacksDrained,
      stopping: confirmedStop ? false : part.stopping, waitEnded: confirmedStop ? false : part.waitEnded,
      stop: confirmedStop && part.stop ? { ...part.stop, pending: false, unknown: false, notKnown: false, ended: false } : part.stop }));
  }
  async function read(replaceWait = false) {
    const before = current(), id = before.sourceActionId;
    if (!live() || !id || readTicket.current && !replaceWait) return;
    const ticket = {}; readTicket.current = ticket; update(value => ({ ...value, reading: true, readFailure: null }));
    try {
      if (replaceWait) { await reads.client.cancelQueries({ queryKey: reads.key(sourceHookKey(id)), exact: true }); if (readTicket.current !== ticket || current().sourceActionId !== id) return; }
      const value = await reads.client.fetchQuery({ queryKey: reads.key(sourceHookKey(id)), staleTime: 0, meta: { scopes: ["source", "execution"] }, queryFn: async ({ signal }) => {
        const result = await commands.read({ ...session, sourceActionId: id }, before.originalActivation);
        if (signal.aborted || readTicket.current !== ticket || current().sourceActionId !== id) throw new Error("Notification read wait retired");
        if (current().closed && result.view && !result.view.admissionClosed) throw new Error("Obsolete notification observation");
        return result;
      } });
      if (readTicket.current === ticket) observe(value);
    } catch (error) { if (readTicket.current === ticket && current().sourceActionId === id) update(value => ({ ...value, readFailure: commandFailure(error) })); }
    finally { if (readTicket.current === ticket) { readTicket.current = null; update(value => ({ ...value, reading: false })); } }
  }
  async function stop(replaceWait = false) {
    const before = current(), activation = before.originalActivation;
    if (!live() || !before.sourceActionId || !activation || stopTicket.current && !replaceWait || !canStop()) return;
    const ticket = {}; stopTicket.current = ticket;
    update(value => ({ ...value, stopFailure: null, stopping: true }));
    try {
      let request = before.stop?.request;
      if (!request) { const actionId = await executionCommands.identity(session);
        if (!live() || stopTicket.current !== ticket || current().sourceActionId !== before.sourceActionId) return;
        request = fixed({ ...session, stop: { projectId: session.projectId, sourceActionId: before.sourceActionId, actionId, activation } });
      }
      update(value => ({ ...value, stop: { request, pending: true, unknown: false, notKnown: false, ended: false }, waitEnded: false }));
      const result = await commands.stop(request);
      if (!live() || stopTicket.current !== ticket || current().sourceActionId !== before.sourceActionId) return;
      const stopped = result.result.kind === "stopped";
      update(value => ({ ...value, closed: value.closed || stopped, drained: result.callbacksDrained, stopping: false,
        stop: value.stop ? { ...value.stop, pending: false, unknown: false, notKnown: !stopped } : null }));
      void read();
    } catch (error) { if (stopTicket.current === ticket && current().sourceActionId === before.sourceActionId) update(value => ({ ...value,
      stopFailure: commandFailure(error), stopping: false, stop: value.stop ? { ...value.stop, pending: false, unknown: true } : null })); }
    finally { if (stopTicket.current === ticket) { stopTicket.current = null; update(value => ({ ...value, stopping: false })); } }
  }
  async function select(actionId: string) {
    if (!live() || !portsRef.current.canSelect() || stopTicket.current || current().stop?.unknown || current().stop?.pending) return false;
    const ticket = {}; selectionTicket.current = ticket;
    const previous = current().sourceActionId; readTicket.current = null;
    if (previous) await reads.client.cancelQueries({ queryKey: reads.key(sourceHookKey(previous)), exact: true });
    if (!live() || selectionTicket.current !== ticket || !portsRef.current.canSelect()) return false;
    update(value => ({ ...value, sourceActionId: actionId, originalActivation: null, originalRequest: null, reading: false,
      readFailure: null, closed: false, drained: false, stopping: false, stop: null, stopFailure: null, waitEnded: false }));
    selectionTicket.current = null; void read(); return true;
  }
  function blocked() { return !!stopTicket.current || !!current().stop?.pending || !!current().stop?.unknown; }
  function canStop() { const value = current(); return !!value.originalActivation && !value.waitEnded
    && (!value.closed || !!value.stop && (value.stop.pending || value.stop.unknown || value.stop.notKnown)); }
  function canEndWait() { const value = current(), id = value.sourceActionId; if (!id || !blocked()) return false;
    const query = reads.client.getQueryState<SourceMaintenanceHookObservation>(reads.key(sourceHookKey(id)));
    return live() && !value.reading && !value.readFailure && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated
      && query.error === null && query.data?.sourceActionId === id && query.data.view?.admissionClosed === true && query.data.callbacksDrained;
  }
  function endWait() { if (!canEndWait()) return false;
    stopTicket.current = null;
    update(value => ({ ...value, stopping: false, waitEnded: true, stop: value.stop ? { ...value.stop, pending: false, unknown: false, ended: true } : null }));
    return true;
  }
  function revision() { const value = current(); return [value.enabled, value.locale, value.activation, value.preparing, value.sourceActionId,
    value.stopping, value.stop?.request.stop.actionId, value.stop?.pending, value.stop?.unknown, value.stop?.notKnown, value.waitEnded, value.closed, value.drained]; }
  return { state, current, status, editLocale, enable, canPrepare, capture, discardDraft, read, retryRead: () => read(true), stop, retryStop: () => stop(true), select, blocked, revision,
    canStop, canEndWait, endWait, refreshDeadline: () => update(value => ({ ...value })),
    hasDraft: () => current().enabled || current().locale !== "" };
}
