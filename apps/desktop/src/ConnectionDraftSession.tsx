import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { type QueryClient } from "@tanstack/react-query";
import { connectionReadKey, connectionReadOptions, useApplicationQueryClient } from "./ApplicationReadProvider";
import { connectionCommands, confirmConnectionReceipt, sameConnection, type AiConnection, type ConnectionReadView,
  type ModelConnectionChange, type ModelConnectionProfile, type ModelConnectionReceipt } from "./connectionCommands";
import { defaultAiConfig } from "./aiCommands";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { hasUnknownOutcome } from "./projectCommands";
import type { SessionExitPermit } from "./sessionNavigation";

export type ConnectionNotice = "saved" | "saved-newer-draft" | "archive" | "restore" | "edited-during-read" | "changed" | "different-store"
  | "not-applied-changed" | "not-applied" | "draft-retained" | "unavailable" | "exit-blocked" | "exit-edited";
export interface ConnectionDraftValues { name: string; connection: AiConnection }
interface Editor { storeId: string | null; id: string | null; baseline: ModelConnectionProfile | null; values: ConnectionDraftValues; seq: number }
interface Pending { request: ModelConnectionChange; seq: number; target: string; uncertain: boolean; retryAllowed: boolean }
interface Exit { seq: number; current: () => boolean; resolve: (permit: SessionExitPermit | null) => void }
function defaults(): ConnectionDraftValues {
  const { endpoint, model, credentialEnv, tokenField } = defaultAiConfig;
  return { name: "", connection: { endpoint, model, credentialEnv, tokenField } };
}
function sameValues(a: ConnectionDraftValues, b: ConnectionDraftValues) { return a.name === b.name && sameConnection(a.connection, b.connection); }
function profileValues(profile: ModelConnectionProfile): ConnectionDraftValues { return { name: profile.name, connection: structuredClone(profile.connection) }; }
function sameProfile(a: ModelConnectionProfile | null, b: ModelConnectionProfile | undefined) {
  return a !== null && b !== undefined && a.id === b.id && a.revision === b.revision && a.archived === b.archived && sameValues(profileValues(a), profileValues(b));
}
export function connectionDirty(editor: Editor) { return !sameValues(editor.values, editor.baseline ? profileValues(editor.baseline) : defaults()); }

function useConnectionOwner(client: QueryClient) {
  const [state, setState] = useState(() => ({ editor: { storeId: null, id: null, baseline: null, values: defaults(), seq: 0 } as Editor,
    busy: false, pending: null as Pending | null, failure: null as CommandFailure | null, notice: null as ConnectionNotice | null,
    conflict: false, exitPrompt: false, exitHeld: false }));
  const currentState = useRef(state), alive = useRef(true), running = useRef(false), exit = useRef<Exit | null>(null), permit = useRef<object | null>(null);
  useLayoutEffect(() => { alive.current = true; return () => {
    alive.current = false; const previous = exit.current; exit.current = null; previous?.resolve(null); permit.current = null;
  }; }, []);
  function current() { return currentState.current; }
  function update(change: (before: typeof state) => typeof state) {
    if (!alive.current) return; const next = change(currentState.current); currentState.current = next; setState(next);
  }
  function reserved() { return running.current || current().pending !== null || exit.current !== null || permit.current !== null; }
  function edit(values: ConnectionDraftValues) {
    if (permit.current) return;
    update(before => ({ ...before, editor: { ...before.editor, values: structuredClone(values), seq: before.editor.seq + 1 }, failure: null, notice: null }));
  }
  function select(profile: ModelConnectionProfile | null, view?: ConnectionReadView) {
    if (reserved() || connectionDirty(current().editor)) return false;
    if (profile && (!view?.snapshot.storeId || !sameProfile(profile, view.snapshot.profiles.find(value => value.id === profile.id)))) return false;
    update(before => ({ ...before, editor: { storeId: profile ? view!.snapshot.storeId : null, id: profile?.id ?? null, baseline: profile ? structuredClone(profile) : null,
      values: profile ? profileValues(profile) : defaults(), seq: before.editor.seq + 1 }, conflict: false, failure: null, notice: null }));
    return true;
  }
  function discard() {
    if (reserved()) return false;
    update(before => ({ ...before, editor: { ...before.editor, values: before.editor.baseline ? profileValues(before.editor.baseline) : defaults(), seq: before.editor.seq + 1 }, failure: null, notice: null, conflict: false }));
    return true;
  }
  function readCurrent() { return client.fetchQuery(connectionReadOptions()); }
  function currentView(): ConnectionReadView | undefined {
    const value = client.getQueryState(connectionReadKey);
    return value?.status === "success" && value.fetchStatus === "idle" && !value.isInvalidated && value.error === null
      ? client.getQueryData<ConnectionReadView>(connectionReadKey) : undefined;
  }
  function refresh() { return readCurrent(); }
  function changed(view: ConnectionReadView) {
    const editor = current().editor;
    return editor.id !== null && (editor.storeId !== view.snapshot.storeId || !sameProfile(editor.baseline, view.snapshot.profiles.find(profile => profile.id === editor.id)));
  }
  async function operation(work: () => Promise<void>) {
    if (running.current || permit.current || exit.current) return;
    running.current = true; update(before => ({ ...before, busy: true, failure: null, notice: null }));
    try { await work(); } catch (value) { if (alive.current) update(before => ({ ...before, failure: commandFailure(value) })); }
    finally { running.current = false; if (alive.current) update(before => ({ ...before, busy: false })); }
  }
  function settle(original: Pending, receipt: ModelConnectionReceipt) {
    confirmConnectionReceipt(original.request, receipt);
    if (!alive.current || current().pending !== original) return;
    const profile = receipt.snapshot.profiles.find(value => value.id === original.target);
    if (!profile) throw new Error("Invalid connection target acknowledgement");
    update(before => {
      const sameEditor = (before.editor.id === original.target && before.editor.storeId === (original.request.expected.storeId ?? null)) || (before.editor.id === null && original.request.edit.kind === "save");
      const editor = sameEditor ? { ...before.editor, storeId: receipt.snapshot.storeId, id: profile.id, baseline: structuredClone(profile),
        values: before.editor.seq === original.seq ? profileValues(profile) : before.editor.values } : before.editor;
      return { ...before, editor, pending: null, failure: null, conflict: false,
        notice: connectionDirty(editor) ? "saved-newer-draft" : original.request.edit.kind === "save" ? "saved" : original.request.edit.kind };
    });
    // An exact replay can return an old receipt. Read Core for current facts.
    void client.invalidateQueries({ queryKey: connectionReadKey, exact: true });
  }
  async function dispatch(original: Pending) {
    Object.freeze(original.request.expected);
    if (original.request.edit.kind === "save") Object.freeze(original.request.edit.connection);
    Object.freeze(original.request.edit); Object.freeze(original.request);
    try { const receipt = await connectionCommands.change(original.request); settle(original, receipt); }
    catch (value) {
      if (alive.current && current().pending === original) {
        const uncertain = original.uncertain || hasUnknownOutcome(value);
        update(before => ({ ...before, pending: uncertain ? { ...original, uncertain: true, retryAllowed: false } : null }));
      }
      throw value;
    }
  }
  async function save() {
    if (reserved() || !connectionDirty(current().editor)) return;
    await operation(async () => {
      const captured = structuredClone(current().editor);
      const view = await readCurrent();
      if (!alive.current || current().editor.seq !== captured.seq) { update(before => ({ ...before, notice: "edited-during-read" })); return; }
      if (captured.id && (captured.storeId !== view.snapshot.storeId || !sameProfile(captured.baseline, view.snapshot.profiles.find(profile => profile.id === captured.id)))) {
        update(before => ({ ...before, conflict: true, notice: "changed" })); return;
      }
      const id = captured.id ?? crypto.randomUUID();
      const original: Pending = { request: { actionId: crypto.randomUUID(), expected: structuredClone(view.basis),
        edit: { kind: "save", profileId: id, name: captured.values.name, connection: structuredClone(captured.values.connection) } },
        seq: captured.seq, target: id, uncertain: false, retryAllowed: false };
      update(before => ({ ...before, pending: original })); await dispatch(original);
    });
  }
  async function archive(profile: ModelConnectionProfile, restore: boolean, capturedView: ConnectionReadView) {
    if (reserved() || connectionDirty(current().editor)) return;
    const seq = current().editor.seq;
    await operation(async () => {
      const view = await readCurrent(); if (!alive.current) return;
      if (current().editor.seq !== seq) { update(before => ({ ...before, notice: "edited-during-read" })); return; }
      if (view.snapshot.storeId !== capturedView.snapshot.storeId || !sameProfile(profile, view.snapshot.profiles.find(value => value.id === profile.id))) {
        update(before => ({ ...before, conflict: true, notice: "changed" })); return;
      }
      const original: Pending = { request: { actionId: crypto.randomUUID(), expected: structuredClone(view.basis),
        edit: { kind: restore ? "restore" : "archive", profileId: profile.id } },
        seq, target: profile.id, uncertain: false, retryAllowed: false };
      update(before => ({ ...before, pending: original })); await dispatch(original);
    });
  }
  async function reconcile() {
    const original = current().pending; if (!original || !original.uncertain || running.current) return;
    await operation(async () => {
      const held = { ...original, retryAllowed: false }; update(before => ({ ...before, pending: held }));
      const receipt = await connectionCommands.action({ actionId: held.request.actionId });
      if (!alive.current || current().pending !== held) return;
      if (receipt) { settle(held, receipt); return; }
      const view = await readCurrent(); if (!alive.current || current().pending !== held) return;
      const expected = held.request.expected;
      if (view.basis.storeId !== expected.storeId) {
        // A first save has no acknowledged store identity. A newly observed
        // store may be a competing publication or a replacement after the
        // original committed; missing receipts cannot distinguish them.
        update(before => ({ ...before, notice: "different-store" })); return;
      }
      if (view.basis.revision !== expected.revision || view.basis.digest !== expected.digest) {
        update(before => ({ ...before, pending: null, notice: "not-applied-changed", conflict: true })); return;
      }
      update(before => ({ ...before, pending: { ...held, retryAllowed: true }, notice: "not-applied" }));
    });
  }
  async function retry() {
    const original = current().pending;
    if (!original?.uncertain || !original.retryAllowed || running.current) return;
    await operation(async () => {
      const held = { ...original, retryAllowed: false }; update(before => ({ ...before, pending: held })); await dispatch(held);
    });
  }
  function keepAsNew() {
    if (reserved()) return false;
    update(before => ({ ...before, editor: { ...before.editor, storeId: null, id: null, baseline: null, seq: before.editor.seq + 1 }, conflict: false, failure: null, notice: "draft-retained" }));
    return true;
  }
  function reviewCurrent(view: ConnectionReadView, keep: boolean) {
    if (reserved()) return false;
    const before = current(), profile = view.snapshot.profiles.find(value => value.id === before.editor.id);
    if (!profile) { update(value => ({ ...value, notice: "unavailable" })); return false; }
    update(value => ({ ...value, editor: { ...value.editor, storeId: view.snapshot.storeId, baseline: structuredClone(profile), values: keep ? value.editor.values : profileValues(profile),
      seq: value.editor.seq + 1 }, conflict: false, notice: keep ? "draft-retained" : null, failure: null })); return true;
  }
  function issueExit(intentCurrent: () => boolean): SessionExitPermit | null {
    if (!alive.current || !intentCurrent() || running.current || current().pending || connectionDirty(current().editor) || permit.current) return null;
    const held = {}; permit.current = held; const seq = current().editor.seq; update(before => ({ ...before, exitHeld: true, exitPrompt: false }));
    return { current: () => alive.current && permit.current === held && intentCurrent() && current().editor.seq === seq
      && !connectionDirty(current().editor) && !running.current && !current().pending,
      release: () => { if (permit.current === held) { permit.current = null; update(before => ({ ...before, exitHeld: false })); } } };
  }
  function prepareExit(intentCurrent: () => boolean): Promise<SessionExitPermit | null> {
    if (reserved()) { update(before => ({ ...before, notice: "exit-blocked" })); return Promise.resolve(null); }
    if (!connectionDirty(current().editor)) return Promise.resolve(issueExit(intentCurrent));
    return new Promise(resolve => { exit.current = { seq: current().editor.seq, current: intentCurrent, resolve }; update(before => ({ ...before, exitPrompt: true })); });
  }
  function answerExit(discardDraft: boolean) {
    const intent = exit.current; if (!intent) return false; exit.current = null;
    if (!discardDraft || !intent.current() || current().editor.seq !== intent.seq || running.current || current().pending) {
      update(before => ({ ...before, exitPrompt: false, notice: discardDraft ? "exit-edited" : before.notice })); intent.resolve(null); return false;
    }
    update(before => ({ ...before, editor: { ...before.editor, values: before.editor.baseline ? profileValues(before.editor.baseline) : defaults(), seq: before.editor.seq + 1 }, exitPrompt: false }));
    const checked = issueExit(intent.current); intent.resolve(checked); return checked !== null;
  }
  return { state, current, dirty: connectionDirty(state.editor), reserved, edit, select, discard, currentView, refresh, changed,
    save, archive, reconcile, retry, reviewCurrent, keepAsNew, prepareExit, answerExit };
}
const Connections = createContext<ReturnType<typeof useConnectionOwner> | null>(null);
export function ConnectionDraftProvider({ children }: { children: ReactNode }) {
  const owner = useConnectionOwner(useApplicationQueryClient());
  return <Connections.Provider value={owner}>{children}</Connections.Provider>;
}
export function useConnectionDraft() { const owner = useContext(Connections); if (!owner) throw new Error("ConnectionDraftProvider is required"); return owner; }
