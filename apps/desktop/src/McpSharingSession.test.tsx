import { useLayoutEffect, type ReactNode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { ProjectSessionOwners } from "./ProjectSessionWorkbench";
import { useMcpSharing, mcpShareStatusKey } from "./McpSharingSession";
import { useSessionReads } from "./SessionReadProvider";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { executionCommands } from "./executionCommands";
import { mcpCommands, type McpShareView, type McpSharePreparation, type McpShareAuthorized } from "./mcpCommands";
import { mcpConfiguration, mcpPrepared, mcpProject, mcpTarget, mcpView } from "./testSupport/mcpSharingFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";

let owner: ReturnType<typeof useMcpSharing>, reads: ReturnType<typeof useSessionReads>, translations: ReturnType<typeof useTranslationDraftSession>;
let canonical: McpShareView | null, sequence: number, generation: number;
function Probe() {
  const sharing = useMcpSharing(), queries = useSessionReads(), draft = useTranslationDraftSession();
  useLayoutEffect(() => { owner = sharing; reads = queries; translations = draft; }); return null;
}
function Harness({ children }: { children?: ReactNode }) {
  return <ApplicationReadProvider><ProjectSessionOwners project={mcpProject} bridge={false}><Probe />{children}</ProjectSessionOwners></ApplicationReadProvider>;
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function begin() {
  act(() => {
    translations.begin({ unitId: mcpTarget.unitId, locale: mcpTarget.locale, key: mcpTarget.key, sourceRevisionId: mcpTarget.sourceRevisionId, sourceText: "Synthetic source" }, null, null);
    expect(owner.begin(mcpTarget)).toBe(true); owner.edit({ recipientLabel: "Synthetic external client" });
  });
}
async function prepare() { await act(async () => { await owner.prepare(); }); await waitFor(() => expect(owner.state.reading).toBe(false)); }
async function authorize() { act(() => owner.setConsent(true)); await act(async () => { await owner.authorize(); }); }
function operation() { const value = owner.current().operation; if (!value) throw new Error("Synthetic operation missing"); return value; }
function currentView() { if (!canonical) throw new Error("Synthetic sharing view missing"); return canonical; }
function closeCanonical() { canonical = { ...currentView(), phase: "closed", admissionClosed: true, callbacksDrained: true }; return canonical; }

beforeEach(() => {
  vi.restoreAllMocks(); canonical = null; sequence = 9100; generation = 1;
  vi.spyOn(executionCommands, "identity").mockImplementation(async () => id(++sequence));
  vi.spyOn(mcpCommands, "session").mockImplementation(async () => ({ kind: "available", ownerId: id(9020), nextGeneration: String(generation++), current: null }));
  vi.spyOn(mcpCommands, "prepare").mockImplementation(async request => { canonical = mcpView(request.preparation); return mcpPrepared(request.preparation); });
  vi.spyOn(mcpCommands, "authorize").mockImplementation(async (request, preparation) => {
    canonical = mcpView(preparation, request.authorization); return { view: canonical, configuration: structuredClone(mcpConfiguration) };
  });
  vi.spyOn(mcpCommands, "read").mockImplementation(async () => structuredClone(currentView()));
  vi.spyOn(mcpCommands, "revoke").mockImplementation(async request => {
    closeCanonical(); return { identity: request.identity, actionId: request.actionId, admissionClosed: true, callbacksDrained: true };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("does not read, create an identity or authorize anything until the user opens and previews a share", () => {
  render(<Harness />);
  expect(owner.state.target).toBeNull(); expect(owner.blocked()).toBe(false);
  expect(mcpCommands.session).not.toHaveBeenCalled(); expect(mcpCommands.read).not.toHaveBeenCalled(); expect(executionCommands.identity).not.toHaveBeenCalled();
  begin(); expect(owner.state.shareTerms).toBe(false); expect(owner.state.shareContext).toBe(false);
  expect(mcpCommands.prepare).not.toHaveBeenCalled(); expect(mcpCommands.authorize).not.toHaveBeenCalled();
});

it("retains exact preview A and newer recipient B when preparation acknowledges late", async () => {
  const delayed = deferred<ReturnType<typeof mcpPrepared>>(); let original!: McpSharePreparation;
  vi.mocked(mcpCommands.prepare).mockImplementation(async request => { original = request.preparation; canonical = mcpView(original); return delayed.promise; });
  render(<Harness />); begin(); let running!: Promise<void>;
  act(() => { running = owner.prepare(); }); await waitFor(() => expect(mcpCommands.prepare).toHaveBeenCalledTimes(1));
  act(() => owner.edit({ recipientLabel: "Newer recipient B", shareTerms: true }));
  await act(async () => { delayed.resolve(mcpPrepared(original)); await running; });
  expect(owner.state.recipientLabel).toBe("Newer recipient B"); expect(owner.state.shareTerms).toBe(true);
  expect(operation().prepared?.preparation.recipientLabel).toBe("Synthetic external client"); expect(operation().prepared?.preparation.selection.shareTerms).toBe(false);
  expect(owner.state.stale).toBe(true); act(() => owner.setConsent(true)); await act(async () => { await owner.authorize(); });
  expect(mcpCommands.authorize).not.toHaveBeenCalled();
});

it("does not dispatch an obsolete preparation when input changes while the identity is pending", async () => {
  const identity = deferred<string>(); vi.mocked(executionCommands.identity).mockReturnValueOnce(identity.promise);
  render(<Harness />); begin(); let running!: Promise<void>; act(() => { running = owner.prepare(); });
  await waitFor(() => expect(executionCommands.identity).toHaveBeenCalledTimes(1));
  act(() => owner.edit({ recipientLabel: "New input B" }));
  await act(async () => { identity.resolve(id(9199)); await running; });
  expect(mcpCommands.prepare).not.toHaveBeenCalled(); expect(owner.state.recipientLabel).toBe("New input B"); expect(owner.state.busy).toBeNull();
});

it("can close a draft during a pre-dispatch read wait without letting its late identity create a share", async () => {
  const identity = deferred<string>(); vi.mocked(executionCommands.identity).mockReturnValueOnce(identity.promise);
  render(<Harness />); begin(); let running!: Promise<void>; act(() => { running = owner.prepare(); });
  await waitFor(() => expect(executionCommands.identity).toHaveBeenCalledTimes(1));
  act(() => { expect(owner.close()).toBe(true); }); expect(owner.blocked()).toBe(false);
  await act(async () => { identity.resolve(id(9198)); await running; });
  expect(mcpCommands.prepare).not.toHaveBeenCalled(); expect(owner.state.target).toBeNull();
});

it("requires a fresh explicit consent after editing the local translation, while the saved preview remains unchanged", async () => {
  render(<Harness />); begin(); await prepare(); act(() => owner.setConsent(true)); expect(owner.state.consent).toBe(true);
  const saved = operation().prepared;
  act(() => translations.edit("New unsaved B 👩🏽‍💻"));
  expect(owner.state.consent).toBe(false); expect(owner.state.stale).toBe(true); expect(operation().prepared).toBe(saved);
  await act(async () => { await owner.authorize(); }); expect(mcpCommands.authorize).not.toHaveBeenCalled();
  expect(translations.current()?.text).toBe("New unsaved B 👩🏽‍💻");
});

it("keeps sharing status in Query and the credential and shared body only in the original local owner", async () => {
  render(<Harness />); begin(); await prepare(); await authorize();
  expect(operation().configuration).toEqual(mcpConfiguration);
  const cache = JSON.stringify(reads.client.getQueryCache().getAll().map(query => query.state.data));
  expect(cache).not.toContain("synthetic-unusable-recipient-credential"); expect(cache).not.toContain("Synthetic Hello"); expect(cache).not.toContain("合成你好");
  expect(reads.client.getQueryData(reads.key(mcpShareStatusKey(operation())))).toEqual(currentView());
});

it("revokes independently while the authorization acknowledgement is pending and ignores its late open result", async () => {
  const delayed = deferred<McpShareAuthorized>(); let accepted!: McpShareAuthorized;
  vi.mocked(mcpCommands.authorize).mockImplementation(async (request, preparation) => {
    canonical = mcpView(preparation, request.authorization); accepted = { view: structuredClone(canonical), configuration: structuredClone(mcpConfiguration) }; return delayed.promise;
  });
  render(<Harness />); begin(); await prepare(); act(() => owner.setConsent(true)); let running!: Promise<void>;
  act(() => { running = owner.authorize(); }); await waitFor(() => expect(mcpCommands.authorize).toHaveBeenCalledTimes(1));
  act(() => owner.edit({ recipientLabel: "Retained B" }));
  await act(async () => { await owner.revoke(); }); expect(mcpCommands.revoke).toHaveBeenCalledTimes(1);
  expect(operation().closed).toBe(true); expect(owner.state.busy).toBeNull();
  await act(async () => { delayed.resolve(accepted); await running; });
  expect(operation().closed).toBe(true); expect(operation().configuration).toBeNull(); expect(owner.state.recipientLabel).toBe("Retained B");
});

it("reconciles an accepted original authorization and recovers only its exact configuration without a new identity", async () => {
  vi.mocked(mcpCommands.authorize).mockImplementationOnce(async (request, preparation) => {
    canonical = mcpView(preparation, request.authorization); throw new Error("Synthetic lost acknowledgement");
  });
  render(<Harness />); begin(); await prepare(); await authorize();
  const original = operation().authorization; expect(original).not.toBeNull(); expect(operation().uncertain).toBe(true);
  const count = vi.mocked(executionCommands.identity).mock.calls.length;
  await act(async () => { await owner.refresh(); }); expect(operation().uncertain).toBe(false); expect(operation().configuration).toBeNull();
  await act(async () => { await owner.authorize(true); });
  expect(vi.mocked(executionCommands.identity).mock.calls).toHaveLength(count);
  expect(vi.mocked(mcpCommands.authorize).mock.calls[1]?.[0].authorization).toEqual(original);
  expect(operation().configuration).toEqual(mcpConfiguration); expect(currentView().expiresAtMs).toBe("1792110000000");
});

it("uses canonical acceptance to end an unresolved UI wait, and never lets the old acknowledgement replace later input", async () => {
  const delayed = deferred<McpShareAuthorized>(); let accepted!: McpShareAuthorized;
  vi.mocked(mcpCommands.authorize).mockImplementationOnce(async (request, preparation) => {
    canonical = mcpView(preparation, request.authorization); accepted = { view: structuredClone(canonical), configuration: structuredClone(mcpConfiguration) }; return delayed.promise;
  });
  render(<Harness />); begin(); await prepare(); act(() => owner.setConsent(true)); let running!: Promise<void>;
  act(() => { running = owner.authorize(); }); await waitFor(() => expect(mcpCommands.authorize).toHaveBeenCalledTimes(1));
  act(() => owner.edit({ recipientLabel: "Later B" })); await act(async () => { await owner.refresh(); });
  expect(owner.state.busy).toBeNull(); expect(operation().configuration).toBeNull();
  await act(async () => { await owner.authorize(true); }); const recovered = operation().configuration;
  await act(async () => { delayed.resolve(accepted); await running; });
  expect(operation().configuration).toBe(recovered); expect(owner.state.recipientLabel).toBe("Later B");
});

it("does not interpret an unaccepted canonical observation as failure or permit replacement authorization", async () => {
  vi.mocked(mcpCommands.authorize).mockRejectedValueOnce(new Error("Synthetic unknown acknowledgement"));
  render(<Harness />); begin(); await prepare(); await authorize(); const original = operation().authorization;
  await act(async () => { await owner.refresh(); });
  expect(operation().uncertain).toBe(true); expect(operation().authorization).toBe(original); expect(operation().closed).toBe(false);
  await act(async () => { await owner.prepare(); }); expect(mcpCommands.prepare).toHaveBeenCalledTimes(1);
  act(() => { expect(owner.close()).toBe(false); });
});

it("retires a hung read wait explicitly, rechecks the same identity, and prevents its late result from reopening closed state or replacing B", async () => {
  render(<Harness />); begin(); await prepare(); await authorize();
  const old = deferred<McpShareView>(), stale = structuredClone(currentView()); vi.mocked(mcpCommands.read).mockReturnValueOnce(old.promise);
  let waiting!: Promise<void>; act(() => { waiting = owner.refresh(); }); await waitFor(() => expect(owner.state.reading).toBe(true));
  act(() => owner.edit({ recipientLabel: "Latest B" })); closeCanonical();
  await act(async () => { await owner.retryRead(); });
  expect(operation().closed).toBe(true); expect(owner.state.reading).toBe(false);
  const requests = vi.mocked(mcpCommands.read).mock.calls.slice(-2).map(([request]) => request);
  expect(requests[0]).toEqual(requests[1]);
  await act(async () => { old.resolve(stale); await waiting; });
  expect(operation().closed).toBe(true); expect(owner.state.recipientLabel).toBe("Latest B");
  expect(reads.client.getQueryData<McpShareView>(reads.key(mcpShareStatusKey(operation())))?.phase).toBe("closed");
  expect(mcpCommands.authorize).toHaveBeenCalledTimes(1);
});

it("reuses the original revocation action after an unknown acknowledgement and waits for real drain", async () => {
  vi.mocked(mcpCommands.revoke).mockRejectedValueOnce(new Error("Synthetic lost revocation"));
  render(<Harness />); begin(); await prepare(); await authorize();
  await act(async () => { await owner.revoke(); }); const original = owner.state.revocation?.request;
  expect(owner.state.revocation?.uncertain).toBe(true); expect(operation().configuration).toBeNull();
  vi.mocked(mcpCommands.revoke).mockImplementationOnce(async request => {
    canonical = { ...currentView(), phase: "closing", admissionClosed: true, callbacksDrained: false };
    return { identity: request.identity, actionId: request.actionId, admissionClosed: true, callbacksDrained: false };
  });
  await act(async () => { await owner.revoke(); });
  expect(vi.mocked(mcpCommands.revoke).mock.calls[1]?.[0]).toEqual(original); expect(operation().closed).toBe(false);
  act(() => { expect(owner.close()).toBe(false); }); closeCanonical();
  await act(async () => { await owner.refresh(); }); act(() => { expect(owner.close()).toBe(true); }); expect(owner.blocked()).toBe(false);
});

it("cannot dispatch from a retired original project session, while retained local input is still available", async () => {
  render(<Harness />); begin(); await prepare(); const retained = owner.current();
  act(() => reads.retire());
  act(() => owner.edit({ recipientLabel: "Stale overwrite" }));
  await act(async () => { await owner.prepare(); await owner.authorize(); await owner.revoke(); await owner.refresh(); });
  expect(owner.current()).toBe(retained); expect(mcpCommands.authorize).not.toHaveBeenCalled(); expect(mcpCommands.revoke).not.toHaveBeenCalled();
});
