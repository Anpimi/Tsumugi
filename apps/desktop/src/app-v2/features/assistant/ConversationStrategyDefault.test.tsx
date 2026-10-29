import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { defaultAiConfig } from "../../../aiCommands";
import { validateResponseCorrectionBasis } from "../../../generated/resource.validators";
import { validateResponseCandidate, validateResponseDefault } from "../../../generated/strategy.validators";
import { i18n } from "../../../i18n";
import { conversationEn, conversationZh } from "../../../i18n/conversation";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { strategyKeys, type ContextStrategyCandidate, type ContextStrategyDefaultRevision } from "../../../strategyCommands";
import { connectionFixture } from "../../../testSupport/connectionFixture";
import { conversationWorkPlanFixture } from "../../../testSupport/conversationWorkPlanFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { ConversationSession } from "./ConversationSession";
import { ConversationWorkPlanPanel } from "./ConversationWorkPlanPanel";
import resourceWire from "../../../../test/fixtures/resourceCommands.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: id(39001), sessionToken: "context-default-test" }, conversationId = id(39002);
const disposals: (() => void)[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }

async function harness() {
  const fixture = conversationWorkPlanFixture({ ...context, conversationId });
  const evidence: unknown = structuredClone(resourceWire.responses.correctionBasis);
  if (!validateResponseCorrectionBasis(evidence)) throw new Error("Invalid saved correction fixture");
  evidence.basis.projectId = context.projectId;
  const candidate: ContextStrategyCandidate = { candidateId: id(39003), projectId: context.projectId, locale: "zh-CN", evidence,
    sourceContext: { ...defaultAiConfig.sourceContext, extracted: true }, reason: "Keep the saved scene", exceptions: "Only this project and target language", digest: "a".repeat(64) };
  const adopted: ContextStrategyDefaultRevision = { revisionId: id(39004), actionId: id(39004), projectId: context.projectId,
    locale: "zh-CN", previousRevisionId: null, evaluationId: id(39005), reference: { projectId: context.projectId, revisionId: id(39004), candidateId: candidate.candidateId } };
  if (!validateResponseCandidate(candidate) || !validateResponseDefault(adopted)) throw new Error("Invalid saved context fixtures");
  const state: { adopted: unknown; candidate: unknown; run: unknown; defaultRead: (() => Promise<unknown>) | null; candidateRead: (() => Promise<unknown>) | null } = {
    adopted: structuredClone(adopted), candidate: structuredClone(candidate), run: structuredClone(fixture.run), defaultRead: null, candidateRead: null,
  };
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_conversation_planning") return structuredClone(state.run);
    if (command === "read_context_strategy_default") return state.defaultRead ? state.defaultRead() : structuredClone(state.adopted);
    if (command === "read_context_strategy") return state.candidateRead ? state.candidateRead() : structuredClone(state.candidate);
    if (command === "read_model_connections") return connectionFixture([]);
    if (command === "read_conversation_proposal_work_plans") return { projectId: context.projectId, conversationId, rows: [], nextAfter: null };
    throw new Error(`Unexpected synthetic command: ${command}`);
  });
  const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("entries");
  const owner = new ConversationSession(context, () => reads.invalidate(["project"]), () => {}, {
    read: async request => ({ key: request.key, revision: "0", writerId: null, value: null }),
  });
  await owner.open(conversationId); owner.beginWorkPlan(fixture.revision);
  disposals.push(() => { owner.retire(); reads.retire(); gate.dispose(); });
  const input = () => {
    const value = owner.getSnapshot().inputs.get(conversationId); if (!value) throw new Error("Missing synthetic input"); return value;
  };
  return { ...fixture, owner, reads, gate, candidate, adopted, state, input, current: () => input().workPlan,
    load: () => owner.loadWorkPlanStrategyDefault(conversationId, reads) };
}

it("captures the original target language's exact context reference without changing connection, limits or sharing", async () => {
  const h = await harness(), before = structuredClone(h.current().config);
  await h.load();
  expect(h.current()).toMatchObject({ strategyDefault: "ready", strategyDefaultFailure: null, consent: false, prepared: null });
  expect(h.current().config).toEqual({ ...before, sourceContext: h.candidate.sourceContext, contextStrategy: h.adopted.reference });
  expect(calls("read_context_strategy_default")[0]?.[1]).toEqual({ request: { ...context, locale: "zh-CN" } });
  expect(calls("read_context_strategy")[0]?.[1]).toEqual({ request: { ...context, candidateId: h.candidate.candidateId } });
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_conversation_planning", "read_context_strategy_default", "read_context_strategy"]);
});

it.each(["missing", "withdrawn"])("keeps the ordinary configuration when the future default is %s", async kind => {
  const h = await harness(), before = structuredClone(h.current().config);
  h.state.adopted = kind === "missing" ? null : { ...h.adopted, reference: null, evaluationId: null };
  await h.load();
  expect(h.current().strategyDefault).toBe("ready"); expect(h.current().config).toEqual(before);
  expect(calls("read_context_strategy")).toHaveLength(0);
});

it.each(["default-locale", "reference-project", "reference-revision", "candidate-project", "candidate-id", "candidate-locale", "selection", "origin-result"])(
  "rejects a mismatched %s through the original validated readers", async field => {
    const h = await harness(), before = structuredClone(h.current().config);
    if (field === "default-locale") h.state.adopted = { ...h.adopted, locale: "ja" };
    if (field === "reference-project") h.state.adopted = { ...h.adopted, reference: { ...h.adopted.reference!, projectId: id(39999) } };
    if (field === "reference-revision") h.state.adopted = { ...h.adopted, reference: { ...h.adopted.reference!, revisionId: id(39999) } };
    if (field === "candidate-project") h.state.candidate = { ...h.candidate, projectId: id(39999) };
    if (field === "candidate-id") h.state.candidate = { ...h.candidate, candidateId: id(39999) };
    if (field === "candidate-locale") h.state.candidate = { ...h.candidate, locale: "ja" };
    if (field === "selection") h.state.candidate = { ...h.candidate, sourceContext: { ...h.candidate.sourceContext, extracted: "yes" } };
    if (field === "origin-result") h.state.run = { ...h.run, resultId: id(39999) };
    await h.load(); expect(h.current().strategyDefault).toBe("failed"); expect(h.current().strategyDefaultFailure).not.toBeNull();
    expect(h.current().config).toEqual(before); expect(h.current().consent).toBe(false);
  });

it("keeps newer settings B when the original default read A finishes", async () => {
  const h = await harness(), waiting = deferred<unknown>(); h.state.defaultRead = () => waiting.promise;
  const loading = h.load(); await vi.waitFor(() => expect(calls("read_context_strategy_default")).toHaveLength(1));
  h.owner.setWorkPlanConfig(conversationId, before => ({ ...before, endpoint: "http://127.0.0.1:11435/v1/chat/completions", model: "newer-model",
    maxRequests: 13, concurrency: 2, shareTerms: true, sourceContext: { ...before.sourceContext, neighbors: true } }));
  const newer = structuredClone(h.current().config); waiting.resolve(h.adopted); await loading;
  expect(h.current().strategyDefault).toBe("ready"); expect(h.current().config).toEqual(newer); expect(calls("read_context_strategy")).toHaveLength(0);
});

it("preserves newer settings during a failed read and its explicit retry", async () => {
  const h = await harness(), waiting = deferred<unknown>(); h.state.defaultRead = () => waiting.promise;
  const loading = h.load(); await vi.waitFor(() => expect(calls("read_context_strategy_default")).toHaveLength(1));
  h.owner.setWorkPlanConfig(conversationId, before => ({ ...before, model: "B", shareContext: true }));
  const newer = structuredClone(h.current().config); waiting.reject(new Error("Synthetic local read unavailable")); await loading;
  expect(h.current().strategyDefault).toBe("failed"); expect(h.current().config).toEqual(newer);
  h.state.defaultRead = null; await h.load(); expect(h.current().strategyDefault).toBe("ready"); expect(h.current().config).toEqual(newer);
});

it("requires explicit retry after failure and does not create a preparation while unresolved", async () => {
  const h = await harness(); h.owner.setWorkPlanConfig(conversationId, h.config);
  h.state.defaultRead = async () => { throw new Error("Synthetic local read unavailable"); };
  await h.load(); const failed = h.current().config;
  await h.owner.prepareWorkPlan(conversationId); expect(calls("prepare_conversation_proposal_work_plan")).toHaveLength(0);
  expect(h.current().strategyDefault).toBe("failed"); expect(h.current().config).toBe(failed);
  h.state.defaultRead = null; await h.load(); expect(h.current().config).toEqual(failed);
  expect(calls("read_context_strategy_default")).toHaveLength(2);
});

it("captures the default on an explicit retry when the original new plan has not been edited", async () => {
  const h = await harness(); h.state.defaultRead = async () => { throw new Error("Synthetic local read unavailable"); };
  await h.load(); expect(h.current().strategyDefault).toBe("failed");
  h.state.defaultRead = null; await h.load();
  expect(h.current().strategyDefault).toBe("ready"); expect(h.current().config.contextStrategy).toEqual(h.adopted.reference);
});

it.each(["proposal", "conversation", "close", "retire"])("does not apply a late candidate after %s changes", async change => {
  const h = await harness(), waiting = deferred<unknown>(); h.state.candidateRead = () => waiting.promise;
  const loading = h.load(); await vi.waitFor(() => expect(calls("read_context_strategy")).toHaveLength(1));
  const original = structuredClone(h.current().config);
  if (change === "proposal") h.owner.beginWorkPlan({ ...h.revision, revisionId: id(39998), revision: "2" });
  if (change === "conversation") { await h.owner.open(id(39997)); await h.owner.open(conversationId); }
  if (change === "close") { h.owner.setWorkPlanOpen(conversationId, false); h.owner.setWorkPlanOpen(conversationId, true); }
  if (change === "retire") h.owner.retire();
  waiting.resolve(h.candidate); await loading;
  expect(h.current().config).toEqual(original); expect(h.current().config.contextStrategy).toBeNull(); expect(h.current().consent).toBe(false);
});

it("does not accept a default changed in the shared cache while its candidate is being read", async () => {
  const h = await harness(), waiting = deferred<unknown>(); h.state.candidateRead = () => waiting.promise;
  const loading = h.load(); await vi.waitFor(() => expect(calls("read_context_strategy")).toHaveLength(1));
  h.reads.client.setQueryData(h.reads.key(strategyKeys.default("zh-CN")), { ...h.adopted, reference: null, evaluationId: null });
  waiting.resolve(h.candidate); await loading;
  expect(h.current().strategyDefault).toBe("failed"); expect(h.current().config.contextStrategy).toBeNull();
});

it("retains a captured default after withdrawal and reopening, then captures the new default only for a new proposal", async () => {
  const h = await harness(); await h.load(); const captured = structuredClone(h.current().config);
  h.state.adopted = { ...h.adopted, reference: null, evaluationId: null };
  h.reads.client.setQueryData(h.reads.key(strategyKeys.default("zh-CN")), h.state.adopted);
  h.owner.setWorkPlanOpen(conversationId, false); h.owner.beginWorkPlan(h.revision); await h.load();
  expect(h.current().config).toEqual(captured); expect(calls("read_context_strategy_default")).toHaveLength(1);
  h.owner.beginWorkPlan({ ...h.revision, revisionId: id(39998), revision: "2" }); await h.load();
  expect(h.current().config.contextStrategy).toBeNull(); expect(calls("read_context_strategy_default")).toHaveLength(2);
});

function Panel({ h }: { h: Awaited<ReturnType<typeof harness>> }) {
  const state = useSyncExternalStore(h.owner.subscribe, h.owner.getSnapshot), input = state.inputs.get(conversationId);
  if (!input) return null;
  return <ApplicationReadProvider><SessionReadProvider context={context} reads={h.reads} bridge={false}>
    <ConversationWorkPlanPanel owner={h.owner} input={input} visible disabled={false} gate={h.gate} viewId="entries"/>
  </SessionReadProvider></ApplicationReadProvider>;
}

it.each(["en-US", "zh-CN"])("offers an explicit local-read recovery in %s while preserving edited settings", async language => {
  await i18n.changeLanguage(language);
  const h = await harness(); h.state.defaultRead = async () => { throw new Error("Synthetic local read unavailable"); };
  render(<Panel h={h}/>);
  const retry = await screen.findByRole("button", { name: i18n.t("conversation.planStrategyDefaultRetry") });
  expect(screen.getByText(i18n.t("conversation.planStrategyDefaultFailed"))).toBeVisible();
  expect(screen.getByRole("button", { name: i18n.t("conversation.planPrepare") })).toBeDisabled();
  await act(async () => { h.owner.setWorkPlanConfig(conversationId, before => ({ ...before, model: "newer B" })); });
  h.state.defaultRead = null; fireEvent.click(retry);
  await waitFor(() => expect(h.current().strategyDefault).toBe("ready"));
  expect(h.current().config.model).toBe("newer B"); expect(h.current().config.contextStrategy).toBeNull();
  expect(calls("start_conversation_planning")).toHaveLength(0); expect(calls("prepare_conversation_proposal_work_plan")).toHaveLength(0);
});

it("keeps independent English and Chinese wording anchors for default-context recovery", () => {
  expect(conversationEn.planStrategyDefaultRetry).toBe("Read saved context choice again");
  expect(conversationZh.planStrategyDefaultRetry).toBe("重新读取上下文选择");
  expect(conversationEn.planStrategyDefaultFailed).toBe("The saved context choice could not be read. Read it again before preparing the plan; your current settings are kept.");
  expect(conversationZh.planStrategyDefaultFailed).toBe("无法读取已保存的上下文选择。请重新读取后再准备计划；当前设置会保留。");
});
