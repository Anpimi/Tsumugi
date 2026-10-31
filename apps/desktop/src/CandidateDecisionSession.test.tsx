import { installWorkbenchInputJournalFixtures } from "./testSupport/inputJournalFixture";
import { useLayoutEffect } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import type { ProjectView } from "./projectCommands";
import type { TranslationRevision, CandidateDecision, CandidateDecisionRequest } from "./translationCommands";
import type { CandidateAuditCapture, CandidateBasis, CandidateDecisionOutcome } from "./CandidateDecisionSession";
import translation from "../test/fixtures/translation-commands.json";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "candidate-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(500), displayName: "Candidate decisions", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const item = { unitId: fixtureIdentity(301), sourceRevisionId: fixtureIdentity(302), sourceSnapshotId: fixtureIdentity(300) };
let drafts: ReturnType<typeof useTranslationDraftSession>, revision: TranslationRevision;
function Probe() {
  const draft = useTranslationDraftSession();
  useLayoutEffect(() => { drafts = draft; }); return null;
}
function calls(name: string) { return invoke.mock.calls.filter(([command]) => command === name); }
function requests(name: string) { return calls(name).map(([, args]) => args.request); }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function record(request: CandidateDecisionRequest): CandidateDecision {
  const receipt: CandidateDecision = { request: { ...structuredClone(request.decision),
    expectedDecisionId: request.decision.expectedDecisionId ?? null, expectedSelectionId: request.decision.expectedSelectionId ?? null }, sourceSnapshotId: item.sourceSnapshotId };
  revision = { ...revision, candidateDecision: receipt }; return receipt;
}
beforeEach(() => {
  revision = { ...translation.receipt.revision, revisionId: fixtureIdentity(900), actionId: fixtureIdentity(901), originKind: "ai", unitId: item.unitId,
    locale: "zh-CN", sourceRevisionId: item.sourceRevisionId, sourceSnapshotId: item.sourceSnapshotId, ordinal: "1", text: "你好",
    attemptId: fixtureIdentity(910), resultId: fixtureIdentity(911), itemId: fixtureIdentity(912), artifactId: null, logicalPath: null, declaredLocale: null, nativeKey: null, fileDigest: null, contributors: [] };
  let identities = 800;
  invoke.mockReset(); invoke.mockImplementation(async (command: string, { request }: { request: CandidateDecisionRequest }) => {
    if (command === "create_execution_identity") return fixtureIdentity(identities++);
    if (command === "decide_translation_candidate") return record(request);
    if (command === "read_translation_candidate_action") return revision.candidateDecision ?? null;
    throw new Error(command);
  });
});
beforeEach(installWorkbenchInputJournalFixtures);
afterEach(cleanup);

function outcomeOwner() {
  render(<Probe/>, project);
  const owner = drafts.candidates;
  act(() => { owner.edit("actor", "Reviewer A"); owner.edit("reason", "Reason A"); });
  const basis: CandidateBasis = { unitId: item.unitId, locale: "zh-CN", sourceRevisionId: item.sourceRevisionId, baseSelectionId: null, baseRevisionId: null };
  const audit = (): CandidateAuditCapture => {
    const { actor, reason, editSeq } = owner.current(); return { actor, reason, editSeq };
  };
  return { owner, basis, audit };
}

it("returns the actual recorded request and receipt, and never mistakes a prior recorded disposition for a later declined action", async () => {
  const { owner, basis, audit } = outcomeOwner(); let result!: CandidateDecisionOutcome;
  await act(async () => { result = await owner.decide(revision, "rejected", () => true, () => basis, undefined, audit()); });
  expect(result.kind).toBe("recorded"); if (result.kind !== "recorded") throw new Error("Expected the checked original receipt");
  expect(result.request).toBe(requests("decide_translation_candidate")[0]); expect(result.receipt).toEqual(revision.candidateDecision);
  expect(result.receipt.request).toEqual(result.request.decision);
  expect(Object.isFrozen(result.request)).toBe(true); expect(Object.isFrozen(result.request.decision)).toBe(true);
  await act(async () => { expect(await owner.decide(revision, "rejected", () => true, () => basis, undefined, audit())).toEqual({ kind: "declined", request: null }); });
  expect(owner.current().recorded).toBe("rejected"); expect(calls("create_execution_identity")).toHaveLength(1);
  await act(async () => {
    expect(await owner.check()).toEqual({ kind: "declined", request: null });
    expect(await owner.retry()).toEqual({ kind: "declined", request: null });
  });
});

it("returns a definite rejected write with its original request, decoded failure and original cause", async () => {
  const { owner, basis, audit } = outcomeOwner(), original = invoke.getMockImplementation()!;
  const cause = { code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason: "candidate-decision" };
  invoke.mockImplementation((command, args) => command === "decide_translation_candidate" ? Promise.reject(cause) : original(command, args));
  let result!: CandidateDecisionOutcome;
  await act(async () => { result = await owner.decide(revision, "rejected", () => true, () => basis, undefined, audit()); });
  expect(result).toEqual({ kind: "failed", request: requests("decide_translation_candidate")[0], failure: cause, cause });
  if (result.kind !== "failed") throw new Error("Expected definite failure"); expect(result.cause).toBe(cause);
  expect(owner.current().pending).toBeNull(); expect(drafts.mutationReserved).toBe(false); expect(calls("read_translation_candidate_action")).toHaveLength(0);
});

it("returns an identity failure without claiming a candidate request was dispatched", async () => {
  const { owner, basis, audit } = outcomeOwner(), original = invoke.getMockImplementation()!, cause = new Error("Identity unavailable");
  invoke.mockImplementation((command, args) => command === "create_execution_identity" ? Promise.reject(cause) : original(command, args));
  let result!: CandidateDecisionOutcome;
  await act(async () => { result = await owner.decide(revision, "rejected", () => true, () => basis, undefined, audit()); });
  expect(result).toEqual({ kind: "failed", request: null, failure: "failed", cause });
  expect(calls("decide_translation_candidate")).toHaveLength(0); expect(drafts.mutationReserved).toBe(false);
});

it.each(["start", "identity", "refresh"] as const)("declines an explicit frozen audit changed before %s without submitting or clearing newer input", async phase => {
  const { owner, basis, audit } = outcomeOwner(), captured = audit(), original = invoke.getMockImplementation()!;
  const identity = deferred<string>(), refreshed = deferred<void>(), refresh = vi.fn(() => refreshed.promise);
  if (phase === "identity") invoke.mockImplementation((command, args) => command === "create_execution_identity" ? identity.promise : original(command, args));
  if (phase === "start") act(() => owner.edit("actor", "Reviewer B"));
  let operation!: Promise<CandidateDecisionOutcome>;
  act(() => { operation = owner.decide(revision, "rejected", () => true, () => basis, refresh, captured); });
  if (phase === "identity") {
    await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
    act(() => owner.edit("reason", "Reason B")); await act(async () => identity.resolve(fixtureIdentity(888)));
  } else if (phase === "refresh") {
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    act(() => { owner.edit("reason", "Reason B"); owner.edit("reason", captured.reason); });
    await act(async () => refreshed.resolve());
  }
  await act(async () => expect(await operation).toEqual({ kind: "declined", request: null }));
  expect(calls("decide_translation_candidate")).toHaveLength(0); expect(owner.current().editSeq).toBeGreaterThan(captured.editSeq);
  expect(owner.hasDraft()).toBe(true); expect(drafts.mutationReserved).toBe(false);
  if (phase === "start") expect(calls("create_execution_identity")).toHaveLength(0);
});

it("copies the exact candidate and audit capture before identity allocation instead of reading caller-mutated fields later", async () => {
  const { owner, basis, audit } = outcomeOwner(), captured = audit(), candidate = structuredClone(revision), original = invoke.getMockImplementation()!;
  const identity = deferred<string>();
  invoke.mockImplementation((command, args) => command === "create_execution_identity" ? identity.promise : original(command, args));
  let operation!: Promise<CandidateDecisionOutcome>;
  act(() => { operation = owner.decide(candidate, "rejected", () => true, () => basis, undefined, captured); });
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  candidate.revisionId = fixtureIdentity(1777); captured.actor = "Caller-mutated actor"; captured.reason = "Caller-mutated reason"; captured.editSeq++;
  let result!: CandidateDecisionOutcome;
  await act(async () => { identity.resolve(fixtureIdentity(888)); result = await operation; });
  expect(result.kind).toBe("recorded"); expect(requests("decide_translation_candidate")[0].decision).toMatchObject({ revisionId: fixtureIdentity(900), actor: "Reviewer A", reason: "Reason A" });
  expect(owner.current()).toMatchObject({ actor: "Reviewer A", reason: "Reason A" });
});

it("records explicit A after dispatch while keeping newer audit B and its unsettled sequence", async () => {
  const { owner, basis, audit } = outcomeOwner(), captured = audit(), original = invoke.getMockImplementation()!, write = deferred<CandidateDecision>();
  invoke.mockImplementation((command, args) => command === "decide_translation_candidate" ? write.promise : original(command, args));
  let operation!: Promise<CandidateDecisionOutcome>;
  act(() => { operation = owner.decide(revision, "rejected", () => true, () => basis, undefined, captured); });
  await waitFor(() => expect(calls("decide_translation_candidate")).toHaveLength(1));
  const request = owner.current().pending; if (!request) throw new Error("Expected dispatched original action");
  act(() => { owner.edit("actor", "Reviewer B"); owner.edit("reason", "Reason B 👩🏽‍💻"); });
  let result!: CandidateDecisionOutcome, receipt!: CandidateDecision;
  await act(async () => { receipt = record(request); write.resolve(receipt); result = await operation; });
  expect(result).toEqual({ kind: "recorded", request, receipt });
  if (result.kind !== "recorded") throw new Error("Expected checked A"); expect(result.request).toBe(request); expect(result.receipt).toBe(receipt);
  expect(request.decision).toMatchObject({ actor: "Reviewer A", reason: "Reason A" });
  expect(owner.current()).toMatchObject({ actor: "Reviewer B", reason: "Reason B 👩🏽‍💻" }); expect(owner.hasDraft()).toBe(true);
});

it("returns exact pending outcomes through failed lookup, checked absence and original rejected retry, then records that same action", async () => {
  const { owner, basis, audit } = outcomeOwner(), original = invoke.getMockImplementation()!;
  const lost = new Error("Lost acknowledgement"), unavailable = new Error("Original action unavailable");
  const rejected = { code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason: "candidate-decision" };
  let writes = 0, lookups = 0;
  invoke.mockImplementation((command, args) => {
    if (command === "decide_translation_candidate") return ++writes === 1 ? Promise.reject(lost) : writes === 2 ? Promise.reject(rejected) : Promise.resolve(record(args.request));
    if (command === "read_translation_candidate_action") return ++lookups === 1 ? Promise.reject(unavailable) : Promise.resolve(null);
    return original(command, args);
  });
  let result!: CandidateDecisionOutcome;
  await act(async () => { result = await owner.decide(revision, "rejected", () => true, () => basis, undefined, audit()); });
  const request = owner.current().pending; if (!request) throw new Error("Expected retained original action");
  expect(result).toEqual({ kind: "pending", request, failure: "failed", cause: unavailable });
  await act(async () => expect(await owner.retry()).toEqual({ kind: "declined", request })); expect(writes).toBe(1);
  act(() => owner.edit("reason", "Newer reason B"));
  await act(async () => expect(await owner.check()).toEqual({ kind: "pending", request, failure: null, cause: null }));
  expect(owner.current().checkedMissing).toBe(true);
  await act(async () => expect(await owner.retry()).toEqual({ kind: "pending", request, failure: rejected, cause: rejected }));
  expect(owner.current().pending).toBe(request); expect(owner.current().checkedMissing).toBe(false);
  await act(async () => expect(await owner.check()).toEqual({ kind: "pending", request, failure: null, cause: null }));
  await act(async () => { result = await owner.retry(); });
  expect(result).toEqual({ kind: "recorded", request, receipt: revision.candidateDecision });
  requests("decide_translation_candidate").forEach(value => expect(value).toBe(request));
  expect(calls("create_execution_identity")).toHaveLength(1); expect(owner.hasDraft()).toBe(true); expect(owner.current().reason).toBe("Newer reason B");
});

it("returns a recorded original receipt from a later check without redispatching or replacing audit B", async () => {
  const { owner, basis, audit } = outcomeOwner(), original = invoke.getMockImplementation()!;
  let receipt: CandidateDecision | null = null, lookups = 0;
  invoke.mockImplementation((command, args) => {
    if (command === "decide_translation_candidate") { receipt = record(args.request); return Promise.reject(new Error("Reply lost")); }
    if (command === "read_translation_candidate_action") return ++lookups === 1 ? Promise.reject(new Error("Read unavailable")) : Promise.resolve(receipt);
    return original(command, args);
  });
  await act(async () => { expect((await owner.decide(revision, "rejected", () => true, () => basis, undefined, audit())).kind).toBe("pending"); });
  const request = owner.current().pending; if (!request) throw new Error("Expected original action");
  act(() => owner.edit("reason", "Reason B")); let result!: CandidateDecisionOutcome;
  await act(async () => { result = await owner.check(); });
  expect(result).toEqual({ kind: "recorded", request, receipt });
  expect(calls("decide_translation_candidate")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(owner.current().reason).toBe("Reason B"); expect(owner.hasDraft()).toBe(true);
});
