import contract from "../test/fixtures/projectChanges.contract.json";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionReads, validateChanges, type ChangeScope, type ProjectChanges, type ReadTransport } from "./sessionReads";
const epoch = "9d6f18a6-3ae0-4591-a6d1-7b2c47676a38";
const context = { projectId: "project-a", sessionToken: "session-a" };
const snapshot = (sequence = "0", progressSequence = "0"): ProjectChanges => ({ ...context, epoch, sequence, progressSequence, scopes: ["translation"], runtime: { active: false, quiescing: false, queryCount: 0, error: null } });
const stops: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
async function settle() { for (let n = 0; n < 12; n++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); }
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
