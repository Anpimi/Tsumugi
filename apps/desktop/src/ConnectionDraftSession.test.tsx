import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ApplicationReadProvider, useApplicationQueryClient } from "./ApplicationReadProvider";
import { ConnectionDraftProvider, useConnectionDraft, type ConnectionDraftValues } from "./ConnectionDraftSession";
import type { ConnectionReadView, ModelConnectionChange, ModelConnectionReceipt, ModelConnectionProfile } from "./connectionCommands";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const storeId = "22222222-2222-4222-8222-222222222222", otherStore = "44444444-4444-4444-8444-444444444444";
const profileId = "33333333-3333-4333-8333-333333333333", actionId = "11111111-1111-4111-8111-111111111111";
const values = (name: string): ConnectionDraftValues => ({ name, connection: { endpoint: "https://example.test/v1/chat/completions",
  model: "Synthetic model", credentialEnv: "SYNTHETIC_REFERENCE", tokenField: "max_tokens" } });
function view(profiles: ModelConnectionProfile[] = [], revision = "0", namespace: string | null = revision === "0" ? null : storeId): ConnectionReadView {
  return { snapshot: { storeId: namespace, revision, lastActionId: revision === "0" ? null : actionId, profiles },
    basis: { storeId: namespace, revision, digest: "a".repeat(64) },
    references: profiles.filter(profile => !profile.archived).map(profile => ({ storeId: namespace!, profileId: profile.id, revision: profile.revision, digest: "b".repeat(64) })) };
}
function profile(name = "Saved"): ModelConnectionProfile { return { id: profileId, revision: "1", ...values(name), archived: false }; }
let current: ConnectionReadView, actions: Map<string, ModelConnectionReceipt>;
function commit(request: ModelConnectionChange): ModelConnectionReceipt {
  const revision = String(BigInt(request.expected.revision) + 1n), profiles = structuredClone(current.snapshot.profiles);
  let item = profiles.find(item => item.id === request.edit.profileId);
  if (request.edit.kind === "save") {
    if (!item) { item = { id: request.edit.profileId, revision, name: request.edit.name, connection: structuredClone(request.edit.connection), archived: false }; profiles.push(item); }
    else { item.name = request.edit.name; item.connection = structuredClone(request.edit.connection); item.revision = revision; }
  } else if (item) { item.archived = request.edit.kind === "archive"; item.revision = revision; }
  profiles.sort((a,b) => a.id.localeCompare(b.id)); current = view(profiles, revision, current.snapshot.storeId ?? storeId);
  current.snapshot.lastActionId = request.actionId;
  const receipt: ModelConnectionReceipt = { actionId: request.actionId, requestDigest: "c".repeat(64), snapshot: structuredClone(current.snapshot) };
  actions.set(request.actionId, receipt); return receipt;
}
function wrapper({ children }: { children: ReactNode }) { return <ApplicationReadProvider><ConnectionDraftProvider>{children}</ConnectionDraftProvider></ApplicationReadProvider>; }
function setup() { return renderHook(() => ({ owner: useConnectionDraft(), client: useApplicationQueryClient() }), { wrapper }); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: unknown) => void; const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; }); return { promise,resolve,reject }; }
function rejected(code = "outcome-unknown") { return { code, stage: "model-connections", outcome: code === "outcome-unknown" ? "unknown" : "rejected", recoveryRequired: code === "outcome-unknown" }; }
beforeEach(() => { current = view(); actions = new Map(); invoke.mockReset().mockImplementation(async (command: string, args: { request: ModelConnectionChange & { actionId: string } }) => {
  if (command === "read_model_connections") return structuredClone(current);
  if (command === "change_model_connections") return actions.get(args.request.actionId) ?? commit(args.request);
  if (command === "read_model_connection_action") return actions.get(args.request.actionId) ?? null;
  throw new Error(command);
}); });
afterEach(cleanup);

describe("application connection draft owner", () => {
  it("loads a saved target without browser persistence and holds raw changes separately from Query", async () => {
    current = view([profile()],"1"); const result = setup();
    await act(async () => { await result.result.current.owner.refresh(); });
    act(() => { expect(result.result.current.owner.select(current.snapshot.profiles[0], current)).toBe(true); result.result.current.owner.edit(values("New B")); });
    expect(result.result.current.owner.dirty).toBe(true); expect(current.snapshot.profiles[0].name).toBe("Saved");
    expect(invoke.mock.calls.filter(([command]) => command === "change_model_connections")).toHaveLength(0);
  });
  it("refuses a late preparation read after input B without creating a write request", async () => {
    const read = deferred<ConnectionReadView>(); invoke.mockImplementation(command => command === "read_model_connections" ? read.promise : Promise.reject(new Error(command)));
    const result = setup(); act(() => result.result.current.owner.edit(values("A"))); let save!: Promise<void>;
    act(() => { save = result.result.current.owner.save(); }); await waitFor(() => expect(invoke).toHaveBeenCalled());
    act(() => result.result.current.owner.edit(values("B 日本語 مرحبا 👩🏽‍💻 é")));
    await act(async () => { read.resolve(current); await save; });
    expect(result.result.current.owner.state.editor.values.name).toBe("B 日本語 مرحبا 👩🏽‍💻 é");
    expect(result.result.current.owner.state.notice).toBe("edited-during-read"); expect(invoke.mock.calls).toHaveLength(1);
  });
  it("confirms A without clearing a newer B while retaining the same frozen original request", async () => {
    const write = deferred<ModelConnectionReceipt>(); let request!: ModelConnectionChange;
    invoke.mockImplementation(async (command,args) => { if (command === "read_model_connections") return structuredClone(current);
      if (command === "change_model_connections") { request = args.request; return write.promise; } throw new Error(command); });
    const result = setup(); act(() => result.result.current.owner.edit(values("A"))); let save!: Promise<void>;
    act(() => { save = result.result.current.owner.save(); }); await waitFor(() => expect(request).toBeDefined());
    expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.edit)).toBe(true);
    act(() => result.result.current.owner.edit(values("B"))); await act(async () => { write.resolve(commit(request)); await save; });
    expect(result.result.current.owner.state.editor.values.name).toBe("B"); expect(result.result.current.owner.state.editor.baseline?.name).toBe("A");
    expect(result.result.current.owner.state.editor.id).toBe(request.edit.profileId); expect(result.result.current.owner.dirty).toBe(true);
    expect(result.result.current.owner.state.notice).toBe("saved-newer-draft");
  });
  it("reconciles the original receipt after later settings changes without using it as current Query", async () => {
    const result = setup(); act(() => result.result.current.owner.edit(values("A")));
    invoke.mockImplementation(async (command,args) => { if (command === "read_model_connections") return structuredClone(current);
      if (command === "change_model_connections") { commit(args.request); throw rejected(); }
      if (command === "read_model_connection_action") return actions.get(args.request.actionId); throw new Error(command); });
    await act(async () => { await result.result.current.owner.save(); }); expect(result.result.current.owner.state.pending?.uncertain).toBe(true);
    act(() => result.result.current.owner.edit(values("B"))); current = view(current.snapshot.profiles,"2");
    await act(async () => { await result.result.current.owner.reconcile(); await result.result.current.owner.refresh(); });
    expect(result.result.current.owner.state.pending).toBeNull(); expect(result.result.current.owner.state.editor.values.name).toBe("B");
    expect(result.result.current.owner.currentView()?.snapshot.revision).toBe("2");
    expect(invoke.mock.calls.filter(([command]) => command === "change_model_connections")).toHaveLength(1);
  });
  it("permits an explicit exact retry only after the original action and complete basis are verified absent/current", async () => {
    let writes=0; const result=setup(); invoke.mockImplementation(async (command,args) => {
      if(command === "read_model_connections") return structuredClone(current);
      if(command === "read_model_connection_action") return null;
      if(command === "change_model_connections") { if(++writes===1) throw rejected(); return commit(args.request); } throw new Error(command); });
    act(() => result.result.current.owner.edit(values("A"))); await act(async () => { await result.result.current.owner.save(); });
    await act(async () => { await result.result.current.owner.retry(); }); expect(writes).toBe(1);
    await act(async () => { await result.result.current.owner.reconcile(); }); expect(result.result.current.owner.state.pending?.retryAllowed).toBe(true);
    await act(async () => { await result.result.current.owner.retry(); });
    const calls=invoke.mock.calls.filter(([command])=>command === "change_model_connections");expect(calls).toHaveLength(2);expect(calls[1][1]).toEqual(calls[0][1]);
  });
  it("revokes a proven-missing retry permission when a later outcome query fails", async () => {
    const result=setup(); invoke.mockImplementation(async command => {if(command === "read_model_connections") return current;if(command === "read_model_connection_action") return null;throw rejected();});
    act(()=>result.result.current.owner.edit(values("A")));await act(async()=>{await result.result.current.owner.save();await result.result.current.owner.reconcile();});
    expect(result.result.current.owner.state.pending?.retryAllowed).toBe(true);
    invoke.mockImplementation(async command => {if(command === "read_model_connection_action") throw new Error("read failed");return current;});
    await act(async()=>{await result.result.current.owner.reconcile();});expect(result.result.current.owner.state.pending?.retryAllowed).toBe(false);
  });
  it("retains a missing empty-basis action when the newly published store has no original receipt", async () => {
    const result=setup();invoke.mockImplementation(async command=>{if(command === "read_model_connections")return current;if(command === "read_model_connection_action")return null;throw rejected();});
    act(()=>result.result.current.owner.edit(values("A")));await act(async()=>{await result.result.current.owner.save();});
    current=view([profile("Competing first connection")],"1");await act(async()=>{await result.result.current.owner.reconcile();});
    expect(result.result.current.owner.state.pending?.uncertain).toBe(true);expect(result.result.current.owner.state.editor.values.name).toBe("A");
    expect(result.result.current.owner.state.notice).toBe("different-store");expect(result.result.current.owner.state.pending?.retryAllowed).toBe(false);
  });
  it("does not declare a first save unapplied after it committed and its store was replaced", async () => {
    const result=setup();invoke.mockImplementation(async(command,args)=>{if(command === "read_model_connections")return current;if(command === "read_model_connection_action")return actions.get(args.request.actionId)??null;commit(args.request);throw rejected();});
    act(()=>result.result.current.owner.edit(values("A")));await act(async()=>{await result.result.current.owner.save();});
    const request=structuredClone(result.result.current.owner.state.pending!.request);expect(actions.has(request.actionId)).toBe(true);
    current=view([profile("Replacement")],"1",otherStore);actions.clear();act(()=>result.result.current.owner.edit(values("Newer B")));
    await act(async()=>{await result.result.current.owner.reconcile();await result.result.current.owner.retry();});
    expect(result.result.current.owner.state.pending?.request).toEqual(request);expect(result.result.current.owner.state.pending?.retryAllowed).toBe(false);
    expect(result.result.current.owner.state.editor.values.name).toBe("Newer B");expect(result.result.current.owner.state.notice).toBe("different-store");
    expect(invoke.mock.calls.filter(([command])=>command === "change_model_connections")).toHaveLength(1);
  });
  it("retains an uncertain original request when the store identity changes", async () => {
    current=view([profile()],"1");const result=setup();await act(async()=>{await result.result.current.owner.refresh();});
    act(()=>{result.result.current.owner.select(current.snapshot.profiles[0],current);result.result.current.owner.edit(values("B"));});
    invoke.mockImplementation(async command=>{if(command === "read_model_connections")return current;if(command === "read_model_connection_action")return null;throw rejected();});
    await act(async()=>{await result.result.current.owner.save();});current=view(current.snapshot.profiles,"1",otherStore);
    await act(async()=>{await result.result.current.owner.reconcile();});expect(result.result.current.owner.state.notice).toBe("different-store");expect(result.result.current.owner.state.pending?.retryAllowed).toBe(false);
  });
  it("requires explicit review of a newer selected connection before saving retained B", async () => {
    current=view([profile()],"1");const result=setup();await act(async()=>{await result.result.current.owner.refresh();});
    act(()=>{result.result.current.owner.select(current.snapshot.profiles[0],current);result.result.current.owner.edit(values("B"));});
    current=view([{...profile("C"),revision:"2"}],"2");await act(async()=>{await result.result.current.owner.save();});
    expect(result.result.current.owner.state.conflict).toBe(true);expect(invoke.mock.calls.filter(([name])=>name === "change_model_connections")).toHaveLength(0);
    act(()=>{expect(result.result.current.owner.reviewCurrent(current,true)).toBe(true);});await act(async()=>{await result.result.current.owner.save();});
    expect(current.snapshot.profiles[0].name).toBe("B");
  });
  it("refuses an identical profile copied into a different namespace until explicitly reviewed", async () => {
    current=view([profile()],"1");const result=setup();await act(async()=>{await result.result.current.owner.refresh();});act(()=>{result.result.current.owner.select(current.snapshot.profiles[0],current);result.result.current.owner.edit(values("B"));});
    current=view(current.snapshot.profiles,"1",otherStore);await act(async()=>{await result.result.current.owner.save();});expect(result.result.current.owner.state.conflict).toBe(true);
    expect(invoke.mock.calls.filter(([name])=>name === "change_model_connections")).toHaveLength(0);
  });
  it("aborts an archive read if newer input B arrives before a write is captured", async () => {
    current=view([profile()],"1");const result=setup();await act(async()=>{await result.result.current.owner.refresh();});act(()=>{result.result.current.owner.select(current.snapshot.profiles[0],current);});
    const read=deferred<ConnectionReadView>();invoke.mockImplementation(async command=>command === "read_model_connections"?read.promise:Promise.reject(new Error(command)));let archive!:Promise<void>;
    act(()=>{archive=result.result.current.owner.archive(current.snapshot.profiles[0],false,current);});await waitFor(()=>expect(result.result.current.owner.state.busy).toBe(true));
    act(()=>result.result.current.owner.edit(values("B")));await act(async()=>{read.resolve(current);await archive;});expect(result.result.current.owner.state.editor.values.name).toBe("B");
    expect(result.result.current.owner.state.notice).toBe("edited-during-read");
  });
  it("keeps B when an old window-exit confirmation is answered after another edit", async () => {
    const result=setup();act(()=>result.result.current.owner.edit(values("A")));let exit!:ReturnType<typeof result.result.current.owner.prepareExit>;
    act(()=>{exit=result.result.current.owner.prepareExit(()=>true);});act(()=>result.result.current.owner.edit(values("B")));await act(async()=>{result.result.current.owner.answerExit(true);});
    expect(await exit).toBeNull();expect(result.result.current.owner.state.editor.values.name).toBe("B");expect(result.result.current.owner.state.notice).toBe("exit-edited");
  });
  it("issues a checked exit permit only after explicit discard and holds subsequent edits until release", async () => {
    const result=setup();act(()=>result.result.current.owner.edit(values("A")));let exit!:ReturnType<typeof result.result.current.owner.prepareExit>;
    act(()=>{exit=result.result.current.owner.prepareExit(()=>true);});await act(async()=>result.result.current.owner.answerExit(true));const permit=await exit;expect(permit?.current()).toBe(true);
    act(()=>result.result.current.owner.edit(values("B")));expect(result.result.current.owner.dirty).toBe(false);act(()=>permit?.release());act(()=>result.result.current.owner.edit(values("B")));expect(result.result.current.owner.dirty).toBe(true);
  });
  it("refuses application exit while the original save remains uncertain", async () => {
    const result=setup();invoke.mockImplementation(async command=>{if(command === "read_model_connections")return current;throw rejected();});act(()=>result.result.current.owner.edit(values("A")));await act(async()=>{await result.result.current.owner.save();});
    let permit:unknown;await act(async()=>{permit=await result.result.current.owner.prepareExit(()=>true);});expect(permit).toBeNull();expect(result.result.current.owner.state.pending).not.toBeNull();
  });
});
