import { installWorkbenchInputJournalFixtures } from "./testSupport/inputJournalFixture";
import { useLayoutEffect } from "react";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useReviewDraftSession } from "./ReviewDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { semanticConfig, semanticPreparedFixture, semanticTargetFixture } from "./testSupport/aiSemanticReviewFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { connectionFixture } from "./testSupport/connectionFixture";
import type { ProjectView } from "./projectCommands";
import { i18n } from "./i18n";
import errorWire from "../test/fixtures/commandErrors.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "original-semantic-session", locator: "/synthetic/review", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(3600), displayName: "Review", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const target = semanticTargetFixture(), prepared = semanticPreparedFixture(target, semanticConfig);
let review!: ReturnType<typeof useReviewDraftSession>, reads!: ReturnType<typeof useSessionReads>;
function Probe() { const owner = useReviewDraftSession(), session = useSessionReads(); useLayoutEffect(() => { review = owner; reads = session; }); return null; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function calls(name: string) { return invoke.mock.calls.filter(([command]) => command === name); }
function proof() { return { projectId: project.metadata.projectId, attemptId: prepared.attemptId, taskId: fixtureIdentity(3690), inputDigest: "f".repeat(64), preview: structuredClone(prepared.preview) }; }
async function setup(ready = true) {
  const view = render(<Probe />, project);
  act(() => { review.setSelected(target); review.semantic.setConfig(structuredClone(semanticConfig)); });
  invoke.mockImplementation(async (name: string) => {
    if (name === "read_model_connections") return connectionFixture([]);
    if (name === "prepare_ai_semantic_review") return structuredClone(prepared);
    throw new Error(name);
  });
  if (ready) {
    await act(async () => { await review.semantic.prepare(); }); act(() => review.semantic.setConsent(true));
    expect(review.semantic.current().consent).toBe(true);
  }
  return view;
}
function install(write: (request: unknown) => unknown, read: (request: unknown) => unknown) {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name: string, args: { request: unknown }) => {
    if (name === "start_ai_semantic_review") return write(args.request);
    if (name === "read_ai_semantic_review_start_action") return read(args.request);
    return original(name, args);
  });
}
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("en-US"); });
beforeEach(installWorkbenchInputJournalFixtures);
afterEach(cleanup);

it.each(["lost", "invalid"])("confirms an original %s ACK once without a new identity, preparation, wide read or model submission", async ack => {
  await setup();
  install(() => { if (ack === "invalid") return fixtureIdentity(3699); throw new Error("Lost ACK"); }, () => proof());
  await act(async () => { await review.semantic.start(); });
  expect(review.semantic.current().pending).toBeNull(); expect(review.semantic.current().notice).toBe("started");
  expect(review.semantic.current().attemptId).toBe(prepared.attemptId); expect(review.semantic.current().consent).toBe(false);
  expect(calls("start_ai_semantic_review")).toHaveLength(1); expect(calls("read_ai_semantic_review_start_action")).toHaveLength(1);
  expect(calls("read_ai_semantic_review_start_action")[0][1]).toEqual(calls("start_ai_semantic_review")[0][1]);
  expect(calls("prepare_ai_semantic_review")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(0); expect(calls("read_ai_semantic_review")).toHaveLength(0);
});

it("keeps the complete original request after a missing observation and a subsequent formal rejection", async () => {
  await setup(); let writes = 0;
  install(() => { if (++writes === 1) throw new Error("Lost ACK"); throw errorWire.errors[1]; }, () => null);
  await act(async () => { await review.semantic.start(); });
  const original = review.semantic.current().pending!.request;
  expect(review.semantic.current().pending?.absent).toBe(true); expect(writes).toBe(1);
  await act(async () => { await review.semantic.retry(); });
  expect(review.semantic.current().pending?.request).toBe(original); expect(review.semantic.current().pending?.absent).toBe(false);
  expect(review.semantic.current().notice).toBe("unknown"); expect(calls("read_ai_semantic_review_start_action")).toHaveLength(1);
  expect(calls("start_ai_semantic_review")[1][1]).toEqual(calls("start_ai_semantic_review")[0][1]);
  await act(async () => { await review.semantic.retry(); }); expect(writes).toBe(2);
});

it("does not query a fresh formal rejection or turn it into an unknown submission", async () => {
  await setup(); install(() => { throw errorWire.errors[1]; }, () => { throw new Error("Must not read"); });
  await act(async () => { await review.semantic.start(); });
  expect(review.semantic.current().pending).toBeNull(); expect(calls("read_ai_semantic_review_start_action")).toHaveLength(0);
});

it.each(["error", "project", "attempt", "digest", "model", "budget", "translation", "basis", "rules", "extra"])("retains unknown on %s proof and shares the exact original manual read", async changed => {
  await setup(); let checking = 0;
  install(() => { throw new Error("Lost ACK"); }, () => {
    const saved = proof();
    if (++checking > 1) return saved;
    if (changed === "error") throw new Error("Read failed");
    if (changed === "project") saved.projectId = fixtureIdentity(3699);
    if (changed === "attempt") saved.attemptId = fixtureIdentity(3699);
    if (changed === "digest") saved.preview.digest = "0".repeat(64);
    if (changed === "model") saved.preview.config.model = "another model";
    if (changed === "budget") saved.preview.config.maxRequests++;
    if (changed === "translation") saved.preview.items[0].translationText = "Substituted translation";
    if (changed === "basis") saved.preview.items[0].reviewBasis.sourceRevisionId = fixtureIdentity(3699);
    if (changed === "rules") saved.preview.rules = ["meaning"];
    if (changed === "extra") return { ...saved, confirmed: true };
    return saved;
  });
  await act(async () => { await review.semantic.start(); });
  expect(review.semantic.current().pending?.absent).toBe(false);
  await act(async () => { await review.semantic.retry(); }); expect(calls("start_ai_semantic_review")).toHaveLength(1);
  await act(async () => { await review.semantic.check(); });
  expect(review.semantic.current().pending).toBeNull(); expect(review.semantic.current().notice).toBe("started");
  expect(calls("read_ai_semantic_review_start_action")).toHaveLength(2);
  expect(calls("read_ai_semantic_review_start_action")[1][1]).toEqual(calls("read_ai_semantic_review_start_action")[0][1]);
  expect(calls("start_ai_semantic_review")).toHaveLength(1);
});

it("holds one automatic flight, settles hidden original enqueue and preserves newer config, rules and selected evidence", async () => {
  const view = await setup(), checking = deferred<unknown>();
  install(() => { throw new Error("Lost ACK"); }, () => checking.promise);
  let work!: Promise<void>; await act(async () => { work = review.semantic.start(); });
  expect(review.semantic.current().busy).toBe("check"); expect(review.semantic.reserved()).toBe(true);
  act(() => { review.semantic.setConfig(value => ({ ...value, model: "Model B" })); review.semantic.setRules(["style"]); });
  await act(async () => { await review.semantic.check(); await review.semantic.retry(); });
  expect(calls("read_ai_semantic_review_start_action")).toHaveLength(1);
  view.rerender(<></>);
  await act(async () => { checking.resolve(proof()); await work; });
  expect(review.semantic.current().pending).toBeNull(); expect(review.semantic.current().attempts).toEqual([prepared.attemptId]);
  expect(review.semantic.current().config.model).toBe("Model B"); expect(review.semantic.current().rules).toEqual(["style"]);
  expect(review.semantic.current().consent).toBe(false); expect(calls("start_ai_semantic_review")).toHaveLength(1);
});

it("does not settle a retired owner from a late pure read", async () => {
  await setup(); const checking = deferred<unknown>(); install(() => { throw new Error("Lost ACK"); }, () => checking.promise);
  let work!: Promise<void>; await act(async () => { work = review.semantic.start(); });
  const pending = review.semantic.current().pending; act(() => reads.retire());
  await act(async () => { checking.resolve(proof()); await work; });
  expect(review.semantic.current().pending).toBe(pending); expect(review.semantic.current().attemptId).toBeNull();
  await act(async () => { await review.semantic.check(); await review.semantic.retry(); }); expect(calls("read_ai_semantic_review_start_action")).toHaveLength(1);
});


it("does not prepare or start from a false current-read proof, even with a valid independently confirmed preview", async () => {
  await setup(false);
  await act(async () => { await review.semantic.prepare(() => false); });
  expect(calls("prepare_ai_semantic_review")).toHaveLength(0);
  expect(review.semantic.current().prepared).toBeNull();
  await act(async () => { await review.semantic.prepare(); });
  act(() => review.semantic.setConsent(true));
  const original = review.semantic.current().prepared;
  if (!original) throw new Error("Confirmed semantic preview required");
  expect(review.semantic.preparationCurrent(original)).toBe(true);
  expect(review.semantic.current().consent).toBe(true);
  install(() => prepared.attemptId, () => proof());
  await act(async () => { await review.semantic.start(() => false); });
  expect(calls("start_ai_semantic_review")).toHaveLength(0);
  expect(review.semantic.current().prepared).toBe(original); expect(review.semantic.current().consent).toBe(true);
  expect(review.semantic.current().pending).toBeNull(); expect(calls("read_ai_semantic_review_start_action")).toHaveLength(0);
});

it.each(["object", "version"] as const)("does not publish a late preview after its parent Query %s changed", async changed => {
  await setup(false);
  const key = ["semantic-proof-parent", target.unitId, target.locale] as const;
  reads.client.setQueryData(reads.key(key), { target });
  const witness = reads.watchExactQuery(key), original = witness.current(), data = original?.state.data, version = original?.state.dataUpdateCount;
  if (!original || data === undefined) throw new Error("Parent Query must be observed");
  const currentRead = () => witness.current() === original && original.state.data === data && original.state.dataUpdateCount === version
    && original.state.status === "success" && original.state.fetchStatus === "idle" && !original.state.isInvalidated && !original.state.error;
  const late = deferred<typeof prepared>(), native = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, args) => name === "prepare_ai_semantic_review" ? late.promise : native(name, args));
  try {
    let work!: Promise<void>; act(() => { work = review.semantic.prepare(currentRead); });
    expect(calls("prepare_ai_semantic_review")).toHaveLength(1);
    await act(async () => {
      reads.client.setQueryData(reads.key(key), changed === "object" ? { target, refreshed: true } : data);
      expect(original.state.dataUpdateCount).not.toBe(version);
      if (changed === "version") expect(original.state.data).toBe(data);
      else expect(original.state.data).not.toBe(data);
      late.resolve(structuredClone(prepared)); await work;
    });
    expect(review.semantic.current().prepared).toBeNull(); expect(review.semantic.current().consent).toBe(false);
    expect(review.semantic.current().notice).toBe("newer"); expect(calls("start_ai_semantic_review")).toHaveLength(0);
  } finally { witness.dispose(); }
});

it.each(["ACK", "unknown"] as const)("settles the original %s after its view proof expires without sending another start", async outcome => {
  const view = await setup(), sent = deferred<void>(); let current = true;
  install(() => sent.promise.then(() => { if (outcome === "unknown") throw new Error("Lost original start ACK"); return prepared.attemptId; }),
    () => { throw new Error("Original action lookup temporarily unavailable"); });
  let work!: Promise<void>; act(() => { work = review.semantic.start(() => current); });
  expect(calls("start_ai_semantic_review")).toHaveLength(1);
  const original = review.semantic.current().pending?.request;
  if (!original) throw new Error("Original start request required");
  current = false; view.rerender(<></>);
  await act(async () => { sent.resolve(undefined); await work; });
  if (outcome === "unknown") {
    expect(review.semantic.current().pending?.request).toBe(original);
    expect(review.semantic.current().notice).toBe("unknown");
    install(() => { throw new Error("Recovery must not resend"); }, () => proof());
    await act(async () => { await review.semantic.check(); });
    expect(calls("read_ai_semantic_review_start_action")).toHaveLength(2);
    expect(calls("read_ai_semantic_review_start_action")[1][1].request).toEqual(original);
  } else expect(calls("read_ai_semantic_review_start_action")).toHaveLength(0);
  expect(review.semantic.current().pending).toBeNull(); expect(review.semantic.current().attemptId).toBe(original.attemptId);
  expect(review.semantic.current().notice).toBe("started"); expect(calls("start_ai_semantic_review")).toHaveLength(1);
  expect(calls("prepare_ai_semantic_review")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(0);
});

it.each(["recorded", "absent"] as const)("checks an old-locale pending start as %s without reviving its old authorization", async outcome => {
  const view = await setup(); let result: ReturnType<typeof proof> | null | undefined;
  install(() => { throw new Error("Lost start ACK"); }, () => {
    if (result === undefined) throw new Error("Initial action read unavailable");
    return result;
  });
  await act(async () => { await review.semantic.start(); });
  const original = review.semantic.current().pending;
  if (!original) throw new Error("Original unknown start required");
  const localized: ProjectView = { ...project, metadata: { ...project.metadata, targetLocales: ["zh-CN", "ja"], metadataRevision: "2" } };
  view.rerender(<Probe/>, localized);
  act(() => { review.setLocale("ja"); });
  expect(review.current().locale).toBe("ja");
  expect(review.semantic.current().pending?.request).toBe(original.request);
  expect(review.semantic.preparationCurrent(original.preparation)).toBe(false);
  result = outcome === "recorded" ? proof() : null;
  await act(async () => { await review.semantic.check(); });
  expect(calls("read_ai_semantic_review_start_action")).toHaveLength(2);
  expect(calls("read_ai_semantic_review_start_action")[1][1].request).toEqual(original.request);
  if (outcome === "recorded") {
    expect(review.semantic.current().pending).toBeNull(); expect(review.semantic.current().attemptId).toBe(original.request.attemptId);
  } else {
    expect(review.semantic.current().pending?.request).toBe(original.request); expect(review.semantic.current().pending?.absent).toBe(true);
    await act(async () => { await review.semantic.retry(); });
    expect(review.semantic.current().pending?.request).toBe(original.request);
    act(() => { review.semantic.discardAbsent(); });
    expect(review.semantic.current().pending).toBeNull(); expect(review.semantic.current().prepared).toBeNull();
    expect(review.semantic.current().attemptId).toBeNull();
  }
  expect(review.semantic.current().consent).toBe(false);
  expect(calls("start_ai_semantic_review")).toHaveLength(1); expect(calls("prepare_ai_semantic_review")).toHaveLength(1);
  expect(calls("create_execution_identity")).toHaveLength(0);
});
