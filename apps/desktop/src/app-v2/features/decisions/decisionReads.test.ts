import { expect, it, vi } from "vitest";
import type { DecisionPageRequest } from "../../../decisionCommands";
import { SessionReads } from "../../../sessionReads";
import { DecisionActivityMemo } from "../../workspace/decisionActivity";
import fixture from "../../../../test/fixtures/decisionCommands.contract.json";
import { validateResponsePage } from "../../../generated/decisions.validators";
import { decisionReadOptions, type DecisionActivityOwner, type DecisionOwners } from "./decisionReads";

function page() {
  const value: unknown = structuredClone(fixture.response);
  if (!validateResponsePage(value)) throw new Error("Invalid decision fixture");
  return value;
}
function owner(id: string) {
  const activity = new DecisionActivityMemo(id);
  return { activity, getDecisionActivity: activity.getSnapshot, subscribe: () => () => {} } satisfies DecisionActivityOwner & { activity: DecisionActivityMemo };
}

it("shares one read between consumers and captures the original owners", async () => {
  const reads = new SessionReads({ projectId: fixture.request.projectId, sessionToken: "synthetic" });
  const owners = [owner("00000000-0000-4000-8000-000000000010"), owner("00000000-0000-4000-8000-000000000011")] as const;
  let finish!: (value: ReturnType<typeof page>) => void;
  const read = vi.fn((_request: DecisionPageRequest) => new Promise<ReturnType<typeof page>>(resolve => { finish = resolve; }));
  const options = () => decisionReadOptions(reads, { locale: null, sources: [] }, null, () => owners, read);
  const inbox = reads.client.fetchQuery(options()), tray = reads.client.fetchQuery(options());
  expect(read).toHaveBeenCalledTimes(1); finish(page());
  expect(await inbox).toEqual(await tray);
  expect(read.mock.calls[0]?.[0]).toMatchObject({ activity: owners.map(owner => owner.getDecisionActivity()) });
  reads.retire();
});

it("discards a response when a submission changes or the original owner is replaced", async () => {
  const reads = new SessionReads({ projectId: fixture.request.projectId, sessionToken: "synthetic" });
  const first = owner("00000000-0000-4000-8000-000000000010"), second = owner("00000000-0000-4000-8000-000000000011");
  let owners: DecisionOwners = [first, second];
  let finish!: (value: ReturnType<typeof page>) => void;
  const read = vi.fn((_request: DecisionPageRequest) => new Promise<ReturnType<typeof page>>(resolve => { finish = resolve; }));
  const options = decisionReadOptions(reads, { locale: null, sources: [] }, null, () => owners, read);
  const waiting = reads.client.fetchQuery(options);
  owners = [owner(first.getDecisionActivity().ownerId), second];
  finish(page());
  await expect(waiting).rejects.toThrow("Decision read changed");
  expect(reads.client.getQueryData(options.queryKey)).toBeUndefined();
  reads.retire();
});

it("keeps lifecycle unavailable until both original owners exist", async () => {
  const reads = new SessionReads({ projectId: fixture.request.projectId, sessionToken: "synthetic" });
  const read = vi.fn(async (_request: DecisionPageRequest) => page());
  await reads.client.fetchQuery(decisionReadOptions(reads, { locale: null, sources: [] }, null, () => [null, null], read));
  expect(read.mock.calls[0]?.[0]).toMatchObject({ activity: null });
  reads.retire();
});
