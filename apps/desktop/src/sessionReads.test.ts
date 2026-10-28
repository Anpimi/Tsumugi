import contract from "../test/fixtures/projectChanges.contract.json";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionReads, validateChanges, type ChangeScope, type ProjectChanges, type ReadTransport } from "./sessionReads";
const epoch = "9d6f18a6-3ae0-4591-a6d1-7b2c47676a38";
const context = { projectId: "cb08ef6f-4511-477c-b1fb-054a43e28460", sessionToken: "session-a" };
const snapshot = (sequence = "0", progressSequence = "0"): ProjectChanges => ({ ...context, epoch, sequence, progressSequence, scopes: ["translation"], runtime: { active: false, quiescing: false, queryCount: 0, error: null } });
const stops: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
async function settle() { for (let n = 0; n < 12; n++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(wireOverride?: Partial<ReadTransport>) {
  let next = snapshot(), receive: (value: unknown) => void = () => {};
  const unlisten = vi.fn();
  const wire = {
    snapshot: vi.fn(async (request: Parameters<ReadTransport["snapshot"]>[0]) => wireOverride?.snapshot ? wireOverride.snapshot(request) : next),
    listen: vi.fn(async (callback: (value: unknown) => void) => { if (wireOverride?.listen) return wireOverride.listen(callback); receive = callback; return unlisten; }),
  };
  const reads = new SessionReads(context, wire);
  const stop = reads.start(); stops.push(stop);
  return { reads, wire, stop, unlisten, set: (value: ProjectChanges) => { next = value; }, emit: (value: unknown) => receive(value) };
}
function observe<T>(reads: SessionReads, key: string, scope: ChangeScope, read: () => Promise<T>, enabled = true) {
  const observer = new QueryObserver(reads.client, { queryKey: reads.key([key]), meta: { scopes: [scope] }, queryFn: read, enabled });
  const stop = observer.subscribe(() => {}); stops.push(stop);
  return observer;
}
it("refreshes delivery readers when a native job ends even while other work and durable versions are unchanged", async () => {
  const fixture = setup(); await settle();
  const read = vi.fn().mockResolvedValue("pending outcomes");
  observe(fixture.reads, "decisions", "execution", read); await settle();
  const live = snapshot(); live.runtime.active = true;
  live.runtime.deliveryActivity = { jobId: "00000000-0000-4000-8000-000000000001", kind: "export",
    releaseId: "00000000-0000-4000-8000-000000000002", actionId: "00000000-0000-4000-8000-000000000003" };
  fixture.set(live); await fixture.reads.synchronize(); await settle();
  expect(fixture.reads.client.getQueryData(fixture.reads.key(["runtime"]))).toMatchObject({ deliveryActivity: live.runtime.deliveryActivity });
  const before = read.mock.calls.length;
  const finished = snapshot(); finished.runtime.active = true;
  fixture.set(finished); await fixture.reads.synchronize(); await settle();
  expect(read).toHaveBeenCalledTimes(before + 1);
  expect(fixture.reads.client.getQueryData(fixture.reads.key(["runtime"]))).not.toHaveProperty("deliveryActivity");
});

it("rejects a runtime delivery descriptor without its original action binding", () => {
  const invalid = snapshot();
  invalid.runtime.deliveryActivity = { jobId: "00000000-0000-4000-8000-000000000001", kind: "export",
    releaseId: "00000000-0000-4000-8000-000000000002", actionId: null };
  expect(() => validateChanges(invalid, context)).toThrow("Invalid project change snapshot");
});
it("deduplicates observers and coalesces invalidations arriving during a slow read", async () => {
  const { reads } = setup(); await settle();
  let finish: (value: number) => void = () => {};
  const read = vi.fn().mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; })).mockResolvedValue(2);
  const first = observe(reads, "attempt", "execution", read), second = observe(reads, "attempt", "execution", read);
  await settle(); expect(read).toHaveBeenCalledTimes(1);
  for (let n = 0; n < 10; n++) reads.invalidate(["execution"]);
  expect(read).toHaveBeenCalledTimes(1);
  finish(1); await settle();
  expect(read).toHaveBeenCalledTimes(2);
  expect(first.getCurrentResult().data).toBe(2); expect(second.getCurrentResult().data).toBe(2);
});
it("ignores duplicates, out-of-order and foreign-session messages and refreshes only affected queries", async () => {
  const fixture = setup(); await settle();
  const translation = vi.fn().mockResolvedValue("translation"), execution = vi.fn().mockResolvedValue("task");
  observe(fixture.reads, "translation", "translation", translation); observe(fixture.reads, "tasks", "execution", execution); await settle();
  const event = { ...context, epoch, kind: "change", afterSequence: "0", sequence: "1", scopes: ["translation"] };
  fixture.emit(event); fixture.emit(event); fixture.emit({ ...event, sequence: "0" }); fixture.emit({ ...event, sessionToken: "other" });
  await vi.advanceTimersByTimeAsync(50); await settle();
  expect(translation).toHaveBeenCalledTimes(2); expect(execution).toHaveBeenCalledTimes(1);
});
it("recovers a gap and a dropped notification from authoritative snapshots", async () => {
  const fixture = setup(); await settle(); const read = vi.fn().mockResolvedValue("facts"); observe(fixture.reads, "facts", "translation", read); await settle();
  fixture.set(snapshot("4")); fixture.emit({ ...context, epoch, kind: "change", afterSequence: "3", sequence: "4", scopes: ["translation"] });
  await settle(); await vi.advanceTimersByTimeAsync(50); await settle();
  const afterGap = read.mock.calls.length; expect(afterGap).toBeGreaterThan(1);
  fixture.set(snapshot("5")); await vi.advanceTimersByTimeAsync(1500); await settle();
  expect(read.mock.calls.length).toBeGreaterThan(afterGap);
  expect(fixture.wire.snapshot).toHaveBeenLastCalledWith({ ...context, afterSequence: "4" });
});
it("ignores slow old-session responses and cleans a listener registered after disposal", async () => {
  let resolveListen: (stop: () => void) => void = () => {}, resolveSnapshot: (value: unknown) => void = () => {};
  const lateStop = vi.fn();
  const fixture = setup({ listen: () => new Promise(resolve => { resolveListen = resolve; }), snapshot: () => new Promise(resolve => { resolveSnapshot = resolve; }) });
  fixture.stop(); resolveListen(lateStop); resolveSnapshot(snapshot("9")); await settle();
  expect(lateStop).toHaveBeenCalledTimes(1); expect(fixture.reads.client.getQueryCache().getAll()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5000); expect(fixture.reads.status()).toBe(false);
});
it("stops hidden reads while the shared heartbeat remains independent of the view", async () => {
  const fixture = setup(); await settle(); const read = vi.fn().mockResolvedValue("results");
  observe(fixture.reads, "hidden-attempt", "execution", read, false);
  fixture.set(snapshot("0", "1")); await vi.advanceTimersByTimeAsync(1500); await settle();
  expect(read).not.toHaveBeenCalled(); expect(fixture.wire.snapshot.mock.calls.length).toBeGreaterThan(1);
});
it("retries a failed read at the shared heartbeat and recovers after a same-session store reset", async () => {
  const fixture = setup(); await settle(); const read = vi.fn().mockRejectedValueOnce(new Error("temporary read failure")).mockResolvedValue("saved");
  const observer = observe(fixture.reads, "results", "execution", read); await settle(); expect(observer.getCurrentResult().isError).toBe(true);
  await vi.advanceTimersByTimeAsync(1500); await settle(); expect(observer.getCurrentResult().data).toBe("saved");
  fixture.set(snapshot("3", "3")); await fixture.reads.synchronize(true); await settle();
  fixture.set(snapshot()); fixture.emit({ ...context, epoch, kind: "resync", afterSequence: "3", sequence: "0", scopes: ["project"] });
  await settle(); expect(fixture.wire.snapshot).toHaveBeenLastCalledWith({ ...context, afterSequence: "0" });
});
it("preserves exact decimal counters and rejects malformed or misattributed snapshots", () => {
  expect(validateChanges(snapshot("9007199254740993", "9223372036854775807"), context).sequence).toBe("9007199254740993");
  for (const sequence of [9, "01", "-1", "9223372036854775808"]) expect(() => validateChanges({ ...snapshot(), sequence }, context)).toThrow();
  expect(() => validateChanges({ ...snapshot(), sessionToken: "old" }, context)).toThrow();
  expect(() => validateChanges({ ...snapshot(), scopes: ["unknown"] }, context)).toThrow();
  expect(() => validateChanges({ ...snapshot(), runtime: {...snapshot().runtime, queryCount: 4294967296} }, context)).toThrow();
  expect(() => validateChanges({ ...snapshot(), runtime: {...snapshot().runtime, error: {code:"busy", outcome:"rejected"}} }, context)).toThrow();
});

it("round-trips the shared Rust fixture without narrowing either sequence", () => {
  const next = validateChanges(contract.snapshot, contract.request);
  expect(JSON.parse(JSON.stringify(next))).toEqual(contract.snapshot);
});
it("resynchronizes when an empty store is reopened and ignores a retired epoch", async () => {
  const fixture = setup(); await settle();
  const nextEpoch = "1717ef0a-6f02-4645-95a4-1790d37e708c";
  fixture.set({ ...snapshot(), epoch: nextEpoch });
  fixture.emit({ ...context, epoch: nextEpoch, kind: "resync", afterSequence: "0", sequence: "0", scopes: ["project"] });
  await settle();
  const calls = fixture.wire.snapshot.mock.calls.length;
  fixture.emit({ ...context, epoch, kind: "change", afterSequence: "0", sequence: "1", scopes: ["translation"] });
  await vi.advanceTimersByTimeAsync(50); await settle();
  expect(fixture.wire.snapshot).toHaveBeenCalledTimes(calls);
});
it("reports semantic scopes without revoking preparation for unchanged focus checks", async () => {
  const fixture = setup(); await settle();
  const changes = vi.fn(); const unsubscribe = fixture.reads.subscribeChanges(changes);
  await fixture.reads.synchronize(true); await settle();
  expect(changes).not.toHaveBeenCalled();
  fixture.set({ ...snapshot("1"), scopes: ["resources"] });
  await fixture.reads.synchronize(true); await settle();
  expect(changes).toHaveBeenCalledWith(["project"]);
  changes.mockClear();
  fixture.emit({ ...context, epoch, kind: "change", afterSequence: "1", sequence: "2", scopes: ["source"] });
  await vi.advanceTimersByTimeAsync(50); await settle();
  expect(changes).toHaveBeenCalledWith(["source"]);
  changes.mockClear();
  fixture.emit({ ...context, epoch: "1717ef0a-6f02-4645-95a4-1790d37e708c", kind: "resync", afterSequence: "2", sequence: "0", scopes: ["project"] });
  expect(changes).toHaveBeenCalledWith(["project"]);
  unsubscribe();
});

it("delivers queued semantic hints before confirming a fresh dependent read", async () => {
  const fixture = setup(); await settle();
  const changes = vi.fn(); fixture.reads.subscribeChanges(changes);
  fixture.set(snapshot("1"));
  fixture.emit({ ...context, epoch, kind: "change", afterSequence: "0", sequence: "1", scopes: ["translation"] });
  expect(changes).not.toHaveBeenCalled();
  await fixture.reads.synchronizeFresh(); await settle();
  expect(changes).toHaveBeenCalledExactlyOnceWith(["translation"]);
  await vi.advanceTimersByTimeAsync(50); await settle();
  expect(changes).toHaveBeenCalledOnce();
});

it("starts fresh change confirmation after an older snapshot flight settles", async () => {
  let held = false, sequence = "0", finish!: (value: ProjectChanges) => void;
  const fixture = setup({ snapshot: () => held ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(snapshot(sequence)) });
  await settle();
  const before = fixture.wire.snapshot.mock.calls.length;
  held = true;
  const previous = fixture.reads.synchronize();
  sequence = "1";
  const current = fixture.reads.synchronizeFresh();
  await settle();
  expect(fixture.wire.snapshot).toHaveBeenCalledTimes(before + 1);
  held = false; finish(snapshot("0"));
  await previous; await current; await settle();
  expect(fixture.wire.snapshot).toHaveBeenCalledTimes(before + 2);
  expect(fixture.wire.snapshot).toHaveBeenLastCalledWith({ ...context, afterSequence: "0" });
  fixture.emit({ ...context, epoch, kind: "change", afterSequence: "0", sequence: "1", scopes: ["translation"] });
  const calls = fixture.wire.snapshot.mock.calls.length;
  await vi.advanceTimersByTimeAsync(50); await settle();
  expect(fixture.wire.snapshot).toHaveBeenCalledTimes(calls);
});

it("refuses dependent confirmation when the current change snapshot is unavailable", async () => {
  let unavailable = false;
  const fixture = setup({ snapshot: () => unavailable ? Promise.reject(new Error("Snapshot unavailable")) : Promise.resolve(snapshot()) });
  await settle(); unavailable = true;
  await expect(fixture.reads.synchronizeFresh()).rejects.toThrow("Current project changes could not be confirmed");
  expect(fixture.reads.status()).toBe(true);
});

it("permanently retires the bridge and ignores delayed registration, hints and attempts to restart", async () => {
  let registered!: (stop: () => void) => void;
  const fixture = setup({ listen: () => new Promise(resolve => { registered = resolve; }) });
  const changes = vi.fn(), stop = vi.fn(); fixture.reads.subscribeChanges(changes);
  await settle(); const snapshots = fixture.wire.snapshot.mock.calls.length; changes.mockClear();
  fixture.reads.retire(); fixture.reads.retire();
  registered(stop); await settle();
  fixture.reads.invalidate(["source"]);
  fixture.reads.receive({ ...context, epoch, kind: "change", afterSequence: "0", sequence: "1", scopes: ["source"] });
  const cleanup = fixture.reads.start(); await fixture.reads.synchronize(true);
  await vi.advanceTimersByTimeAsync(3000); await settle(); cleanup();
  expect(fixture.reads.retired).toBe(true);
  expect(stop).toHaveBeenCalledOnce(); expect(changes).not.toHaveBeenCalled();
  expect(fixture.wire.listen).toHaveBeenCalledOnce(); expect(fixture.wire.snapshot).toHaveBeenCalledTimes(snapshots);
});

it("retains the latest exact Query witness through replacement, removal and old-record notifications", () => {
  const reads = new SessionReads(context), key = reads.key(["flight", "attempt"]), cache = reads.client.getQueryCache();
  reads.client.setQueryData(key, "original");
  const original = cache.find({ queryKey: key, exact: true })!, witness = reads.watchExactQuery(["flight", "attempt"]);
  expect(witness.current()).toBe(original);
  reads.client.removeQueries({ queryKey: key, exact: true });
  expect(witness.current()).toBe(original);
  reads.client.setQueryData(key, "contradiction");
  const replacement = cache.find({ queryKey: key, exact: true })!;
  replacement.setState({ status: "error", error: new Error("Latest exact read failed") });
  reads.client.removeQueries({ queryKey: key, exact: true });
  original.setData("late original success");
  reads.client.setQueryData(reads.key(["flight", "attempt", "other"]), "prefix neighbor");
  reads.client.setQueryData([context.projectId, "foreign-session", "flight", "attempt"], "foreign");
  expect(witness.current()).toBe(replacement);
  expect(witness.current()?.state.status).toBe("error");
  witness.dispose(); witness.dispose();
  reads.client.setQueryData(key, "after disposal");
  expect(witness.current()).toBe(replacement);
  reads.client.clear();
});

it("captures a first exact Query added during a caller-owned wait and releases its listener once", () => {
  const reads = new SessionReads(context), cache = reads.client.getQueryCache(), subscribe = cache.subscribe;
  const dispose = vi.fn();
  vi.spyOn(cache, "subscribe").mockImplementation(listener => { const stop = subscribe(listener); return () => { dispose(); stop(); }; });
  const witness = reads.watchExactQuery(["comparison", "id"]);
  expect(witness.current()).toBeUndefined();
  reads.client.setQueryData(reads.key(["comparison", "id"]), "checked");
  const query = witness.current(); expect(query?.state.data).toBe("checked");
  witness.dispose(); witness.dispose(); expect(dispose).toHaveBeenCalledTimes(1);
  reads.client.removeQueries({ queryKey: reads.key(["comparison", "id"]), exact: true });
  reads.client.setQueryData(reads.key(["comparison", "id"]), "new");
  expect(witness.current()).toBe(query);
  reads.client.clear();
});

it("retries rejected registration at the shared cadence without denying successful fresh reads", async () => {
  const registered = vi.fn(); let attempts = 0;
  const fixture = setup({ listen: async () => { if (++attempts < 3) throw new Error("Listener unavailable"); return registered; } });
  const statuses: boolean[] = [], unsubscribe = fixture.reads.subscribeStatus(() => statuses.push(fixture.reads.subscriptionUnavailable()));
  stops.push(unsubscribe);
  expect(fixture.reads.subscriptionUnavailable()).toBe(false);
  await settle();
  expect(fixture.reads.subscriptionUnavailable()).toBe(true); expect(fixture.reads.status()).toBe(false);
  expect(fixture.reads.subscriptionFailure()).toMatchObject({ phase: "listen", cause: expect.any(Error) });
  await expect(fixture.reads.synchronizeFresh()).resolves.toBeUndefined();
  expect(fixture.wire.listen).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1499); await settle(); expect(fixture.wire.listen).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); await settle(); expect(fixture.wire.listen).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1499); await settle(); expect(fixture.wire.listen).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); await settle(); expect(fixture.wire.listen).toHaveBeenCalledTimes(3);
  expect(fixture.reads.subscriptionUnavailable()).toBe(false); expect(fixture.reads.subscriptionFailure()).toBeNull();
  expect(statuses).toContain(true); expect(statuses.at(-1)).toBe(false);
  await vi.advanceTimersByTimeAsync(4500); await settle(); expect(fixture.wire.listen).toHaveBeenCalledTimes(3);
  fixture.stop(); await settle(); expect(registered).toHaveBeenCalledOnce();
});

it("covers the registration window with a forced read after an older snapshot flight finishes", async () => {
  const registration = deferred<() => void>(), oldSnapshot = deferred<ProjectChanges>(); let snapshots = 0;
  const fixture = setup({ listen: () => registration.promise,
    snapshot: async () => ++snapshots === 1 ? oldSnapshot.promise : snapshot("3") });
  const read = vi.fn().mockResolvedValue("current"), changes = vi.fn();
  observe(fixture.reads, "registration-window", "translation", read); fixture.reads.subscribeChanges(changes);
  await settle(); expect(fixture.wire.snapshot).toHaveBeenCalledOnce();
  registration.resolve(vi.fn()); await settle(); expect(fixture.wire.snapshot).toHaveBeenCalledOnce();
  oldSnapshot.resolve(snapshot()); await settle();
  expect(fixture.wire.snapshot).toHaveBeenCalledTimes(2);
  expect(changes).toHaveBeenCalledWith(["project"]); expect(read).toHaveBeenCalledTimes(2);
  expect(fixture.wire.snapshot).toHaveBeenLastCalledWith({ ...context, afterSequence: "0" });
  await fixture.reads.synchronize(); expect(fixture.wire.snapshot).toHaveBeenLastCalledWith({ ...context, afterSequence: "3" });
});

it("does not overlap registration attempts while a retry is still waiting, and keeps polling", async () => {
  const registration = deferred<() => void>(); let attempts = 0;
  const fixture = setup({ listen: async () => { if (++attempts === 1) throw new Error("First registration failed"); return registration.promise; } });
  await settle(); await vi.advanceTimersByTimeAsync(1500); await settle();
  expect(fixture.wire.listen).toHaveBeenCalledTimes(2);
  const before = fixture.wire.snapshot.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000); await settle();
  expect(fixture.wire.listen).toHaveBeenCalledTimes(2); expect(fixture.wire.snapshot.mock.calls.length).toBeGreaterThan(before);
  const released = vi.fn(); registration.resolve(released); await settle();
  expect(fixture.reads.subscriptionUnavailable()).toBe(false);
  await vi.advanceTimersByTimeAsync(3000); await settle(); expect(fixture.wire.listen).toHaveBeenCalledTimes(2);
  fixture.stop(); await settle(); expect(released).toHaveBeenCalledOnce();
});

it("shares one bridge across start callers until the last independent release", async () => {
  const fixture = setup(); await settle();
  const snapshots = fixture.wire.snapshot.mock.calls.length, second = fixture.reads.start(); stops.push(second);
  fixture.reads.client.setQueryData(fixture.reads.key(["retained"]), "same cache");
  await settle(); expect(fixture.wire.listen).toHaveBeenCalledOnce(); expect(fixture.wire.snapshot).toHaveBeenCalledTimes(snapshots);
  fixture.stop(); fixture.stop(); await settle();
  expect(fixture.unlisten).not.toHaveBeenCalled(); expect(fixture.reads.client.getQueryData(fixture.reads.key(["retained"]))).toBe("same cache");
  await vi.advanceTimersByTimeAsync(1500); await settle(); expect(fixture.wire.snapshot.mock.calls.length).toBeGreaterThan(snapshots);
  second(); second(); await settle(); const stoppedAt = fixture.wire.snapshot.mock.calls.length;
  expect(fixture.unlisten).toHaveBeenCalledOnce(); expect(fixture.reads.client.getQueryCache().getAll()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(4500); await settle(); expect(fixture.wire.snapshot).toHaveBeenCalledTimes(stoppedAt);
});

it.each(["stop", "retire"] as const)("cancels scheduled registration retries on %s", async mode => {
  const fixture = setup({ listen: async () => { throw new Error("No event bridge"); } });
  await settle(); expect(fixture.reads.subscriptionUnavailable()).toBe(true);
  if (mode === "retire") fixture.reads.retire(); else fixture.stop();
  const snapshots = fixture.wire.snapshot.mock.calls.length;
  await vi.advanceTimersByTimeAsync(9000); await settle();
  expect(fixture.wire.listen).toHaveBeenCalledOnce(); expect(fixture.wire.snapshot).toHaveBeenCalledTimes(snapshots);
});

it.each([false, true])("serializes a restarted bridge behind its prior asynchronous cleanup (late registration: %s)", async late => {
  const registration = deferred<() => Promise<void>>(), cleanup = deferred<void>(), released = vi.fn(() => cleanup.promise), nextRelease = vi.fn();
  const callbacks: ((value: unknown) => void)[] = [];
  const fixture = setup({ listen: async callback => { callbacks.push(callback); return callbacks.length === 1 ? registration.promise : nextRelease; } });
  if (!late) { registration.resolve(released); await settle(); }
  fixture.stop(); const restarted = fixture.reads.start(); stops.push(restarted);
  if (late) registration.resolve(released);
  await settle();
  expect(fixture.wire.listen).toHaveBeenCalledOnce(); expect(released).toHaveBeenCalledOnce();
  const changed = vi.fn(); fixture.reads.subscribeChanges(changed);
  callbacks[0]({ ...context, epoch, kind: "change", afterSequence: "0", sequence: "1", scopes: ["translation"] });
  await vi.advanceTimersByTimeAsync(50); await settle(); expect(changed).not.toHaveBeenCalled();
  cleanup.resolve(); await settle(); expect(fixture.wire.listen).toHaveBeenCalledTimes(2);
  fixture.stop(); await settle(); expect(nextRelease).not.toHaveBeenCalled();
  callbacks[1]({ ...context, epoch, kind: "change", afterSequence: "0", sequence: "1", scopes: ["translation"] });
  await vi.advanceTimersByTimeAsync(50); await settle(); expect(changed).toHaveBeenCalledExactlyOnceWith(["translation"]);
  restarted(); await settle(); expect(nextRelease).toHaveBeenCalledOnce();
});

it("starts only the current bridge after a retired registration attempt rejects", async () => {
  const registration = deferred<() => void>(), nextRelease = vi.fn(); let attempts = 0;
  const fixture = setup({ listen: () => ++attempts === 1 ? registration.promise : Promise.resolve(nextRelease) });
  fixture.stop(); const restarted = fixture.reads.start(); stops.push(restarted);
  expect(fixture.wire.listen).toHaveBeenCalledOnce();
  registration.reject(new Error("Old registration failed")); await settle();
  expect(fixture.wire.listen).toHaveBeenCalledTimes(2); expect(fixture.reads.subscriptionUnavailable()).toBe(false);
  expect(fixture.reads.subscriptionFailure()).toBeNull();
  await vi.advanceTimersByTimeAsync(4500); await settle(); expect(fixture.wire.listen).toHaveBeenCalledTimes(2);
});

it("retains uncertain cleanup diagnostics without multiplying Host listeners, while fresh polling remains usable", async () => {
  const failure = new Error("Host unlisten was not confirmed"), released = vi.fn(async () => { throw failure; });
  let oldCallback: (value: unknown) => void = () => {};
  const fixture = setup({ listen: async callback => { oldCallback = callback; return released; } });
  await settle(); fixture.stop(); const restarted = fixture.reads.start(); stops.push(restarted); await settle();
  expect(fixture.reads.subscriptionUnavailable()).toBe(true);
  expect(fixture.reads.subscriptionFailure()).toEqual({ phase: "unlisten", cause: failure });
  expect(fixture.reads.status()).toBe(false); await expect(fixture.reads.synchronizeFresh()).resolves.toBeUndefined();
  const changed = vi.fn(); fixture.reads.subscribeChanges(changed);
  oldCallback({ ...context, epoch, kind: "change", afterSequence: "0", sequence: "7", scopes: ["source"] });
  await vi.advanceTimersByTimeAsync(50); await settle(); expect(changed).not.toHaveBeenCalled();
  const before = fixture.wire.snapshot.mock.calls.length;
  await vi.advanceTimersByTimeAsync(15_000); await fixture.reads.synchronize(true); await settle();
  expect(fixture.wire.snapshot.mock.calls.length).toBeGreaterThan(before);
  expect(fixture.wire.listen).toHaveBeenCalledOnce(); expect(released).toHaveBeenCalledOnce();
  expect(fixture.reads.subscriptionUnavailable()).toBe(true);
  restarted(); await settle(); expect(fixture.reads.subscriptionFailure()).toEqual({ phase: "unlisten", cause: failure });
});

it("does not clear an authoritative read failure merely because event registration recovers", async () => {
  let attempts = 0;
  const fixture = setup({ listen: async () => { if (++attempts === 1) throw new Error("No listener"); return vi.fn<() => void>(); },
    snapshot: async () => { throw new Error("Snapshot unavailable"); } });
  await settle(); expect(fixture.reads.subscriptionUnavailable()).toBe(true); expect(fixture.reads.status()).toBe(true);
  await vi.advanceTimersByTimeAsync(1500); await settle();
  expect(fixture.reads.subscriptionUnavailable()).toBe(false); expect(fixture.reads.status()).toBe(true);
  await expect(fixture.reads.synchronizeFresh()).rejects.toThrow("Current project changes could not be confirmed");
});
