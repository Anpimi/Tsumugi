import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { DecisionPageRequest, DecisionPage } from "../../../decisionCommands";
import type { DecisionCursor } from "../../../generated/decisions.responses";
import { DecisionSourceValues } from "../../../generated/decisions.enums";
import { validateResponsePage } from "../../../generated/decisions.validators";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { DecisionActivityMemo, type DecisionClientAction } from "../../workspace/decisionActivity";
import { decisionReadOptions, type DecisionActivityOwner, type DecisionOwners } from "./decisionReads";
import { useDecisionFeed } from "./useDecisionFeed";

const context = { projectId: id(81000), sessionToken: "synthetic-decision-feed" };
const retained: SessionReads[] = [];
afterEach(() => { cleanup(); retained.splice(0).forEach(reads => reads.retire()); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function owner(ownerId: string) {
  const memo = new DecisionActivityMemo(ownerId), listeners = new Set<() => void>();
  return { getDecisionActivity: memo.getSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    observe(actions: DecisionClientAction[]) { memo.observe(actions, false); listeners.forEach(listener => listener()); },
  } satisfies DecisionActivityOwner & { observe(actions: DecisionClientAction[]): void };
}

/** Fifty-one original synthetic delivery observations exercise actual cursor
 * shape and whole-source counts, rather than inventing a short first page. */
function page(basis: string, cursor: DecisionCursor | null = null, activity: DecisionPageRequest["activity"] = null): DecisionPage {
  const all: DecisionPage["items"] = Array.from({ length: 51 }, (_, index) => {
    const deliveryId = id(82000 + index), releaseId = id(83000), actionId = id(84000 + index);
    return { decisionId: `delivery-unknown:${deliveryId}`, source: "delivery-unknown", state: "awaiting-recheck", locale: "zh-CN",
      targets: [{ kind: "delivery", releaseId, deliveryId }], targetsComplete: true, basis: "e".repeat(64), sourceActionId: actionId,
      action: { kind: "inspect-delivery-outcome", releaseId, deliveryId, actionId },
      evidence: { kind: "delivery-outcome", state: "unknown", locales: ["zh-CN"], fileCount: 1, unknownFileCount: 1 } };
  });
  const start = cursor ? all.findIndex(item => item.decisionId === cursor.afterId) + 1 : 0;
  const items = all.slice(start, start + 50);
  const coverage = DecisionSourceValues.map((source): DecisionPage["coverage"][number] => {
    if (source === "agent-question") return { source, state: "unavailable", knownCount: 0,
      total: null, reason: "source-not-implemented", errorCode: null };
    if (source === "local-action-recovery" && activity == null) return { source, state: "unavailable", knownCount: 0,
      total: null, reason: "lifecycle-unavailable", errorCode: null };
    const count = source === "delivery-unknown" ? all.length : 0;
    return { source, state: "complete", knownCount: count, total: count, reason: null, errorCode: null };
  });
  const last = items.at(-1);
  const value: unknown = { projectId: context.projectId, query: { locale: null, sources: [] }, basis, items,
    next: start + items.length < all.length && last ? { basis, afterId: last.decisionId } : null,
    knownCount: all.length, total: null, coverage, executionActivity: [], deliveryActivity: [],
    localActions: { journalBasis: "f".repeat(64), journalComplete: true, activity: structuredClone(activity ?? null), observations: [] } };
  if (!validateResponsePage(value)) throw new Error("Invalid synthetic decision page");
  return value;
}

interface Presentation { owners: DecisionOwners; cursor: DecisionCursor | null; visible: boolean; enabled: boolean }
function harness(read: (request: DecisionPageRequest) => Promise<DecisionPage>, initial?: Partial<Presentation>) {
  const reads = new SessionReads(context); retained.push(reads);
  const first = owner(id(85000)), second = owner(id(85001));
  let presentation: Presentation = { owners: [first, second], cursor: null, visible: true, enabled: true, ...initial };
  function useConsumers(value: Presentation) {
    const one = useDecisionFeed(reads, value.owners, value.cursor, value.visible, value.enabled, read);
    const two = useDecisionFeed(reads, value.owners, value.cursor, value.visible, value.enabled, read);
    return { one, two };
  }
  const rendered = renderHook(useConsumers, { initialProps: presentation,
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={reads.client}>{children}</QueryClientProvider> });
  return { reads, first, second, ...rendered,
    show(patch: Partial<Presentation>) { presentation = { ...presentation, ...patch }; rendered.rerender(presentation); } };
}

it("shares the first page between the list and multiple consumers, then performs one read for a shared refresh", async () => {
  const original = page("a".repeat(64)), updated = page("b".repeat(64));
  let first = true;
  const read = vi.fn(async (request: DecisionPageRequest) => {
    const basis = first ? original.basis : updated.basis; first = false;
    return page(basis, request.cursor ?? null, request.activity);
  });
  const h = harness(read);
  await waitFor(() => expect(h.result.current.one.page.data?.basis).toBe(original.basis));
  expect(h.result.current.two.first.data).toBe(h.result.current.one.first.data);
  expect(h.result.current.one.page.data).toBe(h.result.current.one.first.data);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenLastCalledWith({ ...context, query: { locale: null, sources: [] }, cursor: null, limit: 50,
    activity: [h.first.getDecisionActivity(), h.second.getDecisionActivity()] });
  await act(async () => { await h.result.current.one.refresh(); });
  await waitFor(() => expect(h.result.current.two.page.data?.basis).toBe(updated.basis));
  expect(read).toHaveBeenCalledTimes(2);
  expect(h.result.current.one.first.data).toBe(h.result.current.two.page.data);
});

it("discards the old response when an original owner reports an actual submission change", async () => {
  const late = deferred<DecisionPage>(), current = page("b".repeat(64));
  const read = vi.fn<(request: DecisionPageRequest) => Promise<DecisionPage>>().mockImplementationOnce(() => late.promise)
    .mockImplementation(async request => page(current.basis, request.cursor ?? null, request.activity));
  const h = harness(read);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const old = page("a".repeat(64), null, read.mock.calls[0]?.[0].activity);
  const originalKey = decisionReadOptions(h.reads, { locale: null, sources: [] }, null, () => [h.first, h.second], read).queryKey;
  const submission: DecisionClientAction = { key: { kind: "translation", unitId: id(86000), locale: "zh-CN" },
    slot: "primary", actionId: id(86001), submittedSeq: "1" };
  act(() => { h.first.observe([submission]); });
  await waitFor(() => expect(h.result.current.one.first.data?.basis).toBe(current.basis));
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => { late.resolve(old); });
  expect(h.reads.client.getQueryData(originalKey)).toBeUndefined();
  expect(h.result.current.two.page.data?.basis).toBe(current.basis);
  expect(h.reads.client.getQueriesData<DecisionPage>({ queryKey: h.reads.key(["workbench-decisions"]) })
    .some(([, data]) => data?.basis === old.basis)).toBe(false);
});

it("rejects a late response after replacement by another owner with the same displayed identity", async () => {
  const late = deferred<DecisionPage>(), current = page("b".repeat(64));
  const read = vi.fn<(request: DecisionPageRequest) => Promise<DecisionPage>>().mockImplementationOnce(() => late.promise)
    .mockImplementation(async request => page(current.basis, request.cursor ?? null, request.activity));
  const h = harness(read);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const old = page("a".repeat(64), null, read.mock.calls[0]?.[0].activity);
  const replacement = owner(h.first.getDecisionActivity().ownerId);
  const originalKey = decisionReadOptions(h.reads, { locale: null, sources: [] }, null, () => [h.first, h.second], read).queryKey;
  expect(replacement.getDecisionActivity()).toEqual(h.first.getDecisionActivity());
  h.show({ owners: [replacement, h.second] });
  await act(async () => { late.resolve(old); });
  await waitFor(() => expect(h.result.current.one.first.data?.basis).toBe(current.basis));
  expect(read).toHaveBeenCalledTimes(2);
  expect(h.reads.client.getQueryData(originalKey)).toBeUndefined();
  expect(h.result.current.two.page.data?.basis).toBe(current.basis);
  expect(h.result.current.one.current(old.basis)).toBe(false);
});

it("marks a retained later cursor as changed when the first page basis advances and refuses its old action basis", async () => {
  const original = page("a".repeat(64)), next = original.next;
  if (!next) throw new Error("Synthetic continuation required");
  let basis = original.basis;
  const read = vi.fn(async (request: DecisionPageRequest) => {
    if (request.cursor && request.cursor.basis !== basis) throw new Error("The captured decision page changed");
    return page(basis, request.cursor ?? null, request.activity);
  });
  const h = harness(read, { cursor: next });
  await waitFor(() => expect(h.result.current.one.page.data?.items).toHaveLength(1));
  expect(h.result.current.one.current(original.basis)).toBe(true);
  expect(h.result.current.one.changed).toBe(false);
  basis = "b".repeat(64);
  await act(async () => { h.reads.invalidate(["release"]); });
  await waitFor(() => expect(h.result.current.one.changed).toBe(true));
  expect(h.result.current.two.changed).toBe(true);
  expect(h.result.current.one.current(original.basis)).toBe(false);
  h.show({ cursor: null });
  await waitFor(() => expect(h.result.current.one.page.data?.basis).toBe(basis));
  expect(h.result.current.one.changed).toBe(false);
});

it("includes a fifth strategy owner and refreshes when its active request finishes", async () => {
  const owners = [owner(id(87000)), owner(id(87001)), owner(id(87002)), owner(id(87003)), owner(id(87004))] as const;
  const read = vi.fn(async (request: DecisionPageRequest) => page("f".repeat(64), request.cursor ?? null, request.activity));
  const h = harness(read, { owners });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  expect(read.mock.calls[0][0].activity).toHaveLength(5);
  const action: DecisionClientAction = { key: { kind: "strategy" }, slot: "strategy", actionId: id(87100), submittedSeq: "3" };
  act(() => owners[4].observe([action]));
  await waitFor(() => expect(read.mock.lastCall?.[0].activity?.[4]?.actions).toEqual([action]));
  act(() => owners[4].observe([]));
  await waitFor(() => expect(read.mock.lastCall?.[0].activity?.[4]?.actions).toEqual([]));
  expect(h.result.current.one.first.data?.localActions?.activity?.[4]?.actions).toEqual([]);
});
