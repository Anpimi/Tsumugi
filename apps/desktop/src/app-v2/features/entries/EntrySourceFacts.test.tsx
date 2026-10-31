import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { contextFactQueryKey } from "../../../contextFactQueries";
import { Field, TextArea } from "../../../design-system/Field";
import { ExecutionTaskSession } from "../../../ExecutionTaskSession";
import { executionContext } from "../../../executionCommands";
import { validateRequestContextFact, validateRequestContextFacts } from "../../../generated/resource.validators";
import { i18n } from "../../../i18n";
import type { ProjectView } from "../../../projectCommands";
import { ResourceDraftSession, useResourceDraftSession } from "../../../ResourceDraftSession";
import type { ContextFactDecision, ContextFactWrite, SourceFactBasis } from "../../../resourceCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { sourceContextBlockBasis, type SourceContextBlock, type SourceContextPage } from "../../../sourceCommands";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { installResourceDraftFixture } from "../../../testSupport/resourceDraftFixture";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { TranslationDraftSession, useTranslationDraftSession } from "../../../TranslationDraftSession";
import { InteractionGate } from "../../workspace/interactionGate";
import type { KnowledgeOwner } from "../knowledge/knowledgeTypes";
import EntrySourceFacts from "./EntrySourceFacts";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const target = reviewTargetFixture({ nativeKey: "dialogue.captain", sourceText: "Welcome aboard.", selectionId: null, revisionId: null, translationText: null });
const project: ProjectView = { sessionToken: "synthetic-entry-facts", locator: "/synthetic/entry-facts", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(88100), displayName: "Entry facts", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const context = executionContext(project);
const scope = { projectId: context.projectId, unitId: target.unitId, locale: target.locale, sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId };
const sourceReference = { artifactId: "synthetic-source", range: { encoding: "utf8-byte" as const, start: 0, end: 8 } };
const rawPayload = '{\r\n "literal":"<script>original</script>", "large":18446744073709551615\r\n}';
const block = (index = 0): SourceContextBlock => ({ blockIndex: index, target: { kind: "occurrence", id: "original-local-occurrence" },
  schema: { id: "tsumugi.source-context-facts", schemaVersion: 1, behaviorVersion: 1 }, handling: "preserve", inRevisionBasis: true,
  facts: { facts: [
    { id: "speaker", kind: "speaker", text: "Mira 👩🏽‍🚀", origin: { kind: "extracted", sources: [sourceReference] } },
    { id: "role", kind: "role", text: "captain", origin: { kind: "inferred", rationale: "addressed as captain", sources: [sourceReference] } },
  ] } });
function page(entries: SourceContextPage["entries"] = [{ kind: "block", value: block() }], after = 0, totalEntries = entries.length, nextAfter: number | null = null): SourceContextPage {
  return { scope, contentRevision: "7", sourceAttemptId: fixtureIdentity(88101), sourceResultId: fixtureIdentity(88102), sourceResultDigest: "a".repeat(64),
    sourceLocale: "en", localUnitId: "original-entry", occurrenceCount: 1, entries, after, totalEntries, nextAfter,
    observations: { missingBlocks: false, knownBlocks: 1, knownFacts: 2, emptyBlocks: 0, unknownBlocks: 0, unknownRequiredBlocks: 0, neighborOccurrences: 0, unknownSamples: [] } };
}
let reads: SessionReads, gate: InteractionGate, owner: KnowledgeOwner, translation: ReturnType<typeof useTranslationDraftSession>;
let pages: SourceContextPage[], history: ContextFactDecision[], actions: Map<string, ContextFactDecision>, serial: number;
let source: { revision: string; currentSnapshot: string }, failSource: boolean, failDecisions: boolean;
let save: (request: ContextFactWrite) => Promise<ContextFactDecision>, identity: () => Promise<string>;
let observe: (actionId: string) => Promise<ContextFactDecision | null>;
const k = (key: "value" | "actor" | "reason" | "save" | "replace" | "reject" | "restore" | "check" | "retry" | "discard" | "history") => i18n.t(`contextFacts.${key}`);
function samePosition(left: SourceFactBasis, right: SourceFactBasis) {
  return JSON.stringify(left.scope) === JSON.stringify(right.scope) && left.fact.blockIndex === right.fact.blockIndex && left.fact.factIndex === right.fact.factIndex;
}
function apply(request: ContextFactWrite) {
  const previous = [...history].reverse().find(value => samePosition(value.request.basis, request.basis));
  const existing = actions.get(request.actionId); if (existing) return structuredClone(existing);
  if ((previous?.request.actionId ?? null) !== (request.expectedDecisionId ?? null)) throw { code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", reason: "context-fact-current", recoveryRequired: false };
  const value: ContextFactDecision = { request: { ...structuredClone(request), expectedDecisionId: request.expectedDecisionId ?? null } };
  history.push(value); actions.set(request.actionId, value); return structuredClone(value);
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); reads = new SessionReads(context); gate = new InteractionGate(); gate.setVisibleOwner("entries-facts");
  pages = [page()]; history = []; actions = new Map(); serial = 88200; source = { revision: "7", currentSnapshot: target.sourceSnapshotId }; failSource = false; failDecisions = false;
  save = async request => apply(request); identity = async () => fixtureIdentity(++serial); observe = async actionId => structuredClone(actions.get(actionId) ?? null);
  invoke.mockReset(); invoke.mockImplementation(async (command: string, payload: { request: unknown }) => {
    const request = payload.request;
    if (command === "read_content_scope") { if (failSource) throw new Error("Source scope temporarily unavailable"); return structuredClone(source); }
    if (command === "create_execution_identity") return identity();
    if (command === "read_source_context") {
      if (typeof request !== "object" || !request || !("after" in request)) throw new Error("Expected bounded source request");
      const result = pages.find(value => value.after === request.after); if (!result) throw new Error("No synthetic source page"); return structuredClone(result);
    }
    if (command === "read_source_context_block") {
      if (typeof request !== "object" || !request || !("basis" in request) || !("descriptor" in request)) throw new Error("Expected exact raw record request");
      return { basis: structuredClone(request.basis), descriptor: structuredClone(request.descriptor), payloadUtf8: rawPayload };
    }
    if (command === "read_context_fact_decisions") {
      if (!validateRequestContextFacts(request)) throw new Error("Expected bounded source fact positions");
      if (failDecisions) throw new Error("Decisions temporarily unavailable");
      const latest = new Map<string, ContextFactDecision>();
      for (const value of history) if (JSON.stringify(value.request.basis.scope) === JSON.stringify(request.scope)
        && request.facts.some(position => position.blockIndex === value.request.basis.fact.blockIndex && position.factIndex === value.request.basis.fact.factIndex)) latest.set(`${value.request.basis.fact.blockIndex}:${value.request.basis.fact.factIndex}`, value);
      return structuredClone([...latest.values()]);
    }
    if (command === "read_context_fact_history") {
      if (typeof request !== "object" || !request || !("offset" in request) || !("limit" in request) || !("unitId" in request) || !("locale" in request)) throw new Error("Expected bounded fact history request");
      const all = history.filter(row => row.request.basis.scope.unitId === request.unitId && row.request.basis.scope.locale === request.locale).reverse();
      const offset = Number(request.offset), limit = Number(request.limit); return { rows: structuredClone(all.slice(offset, offset + limit)), nextOffset: all.length > offset + limit ? offset + limit : null };
    }
    if (command === "decide_context_fact") {
      if (!validateRequestContextFact(request)) throw new Error("Expected original fact write"); return save(request.decision);
    }
    if (command === "observe_context_fact_action") {
      if (!validateRequestContextFact(request)) throw new Error("Expected original fact observation"); return observe(request.decision.actionId);
    }
    if (command === "read_context_fact_action") {
      if (typeof request !== "object" || !request || !("actionId" in request)) throw new Error("Expected original action identity"); return structuredClone(actions.get(String(request.actionId)) ?? null);
    }
    throw new Error(`Unexpected synthetic entry-fact command: ${command}`);
  });
  installResourceDraftFixture();
});
afterEach(() => { cleanup(); reads.retire(); gate.dispose(); });

type Presentation = { target?: typeof target; visible?: boolean; disabled?: boolean; onOpenEntry?: (unitId: string, locale: string) => Promise<boolean> };
function Content({ target: value = target, visible = true, disabled = false, onOpenEntry }: Presentation) {
  const resources = useResourceDraftSession(), translations = useTranslationDraftSession();
  useLayoutEffect(() => { owner = resources; translation = translations; });
  return <><Field label="Translation input"><TextArea value={translations.draft?.text ?? ""} onChange={event => translations.edit(event.target.value)}/></Field>
    <Field label="Retained resource input"><TextArea value={resources.state.termDraft.target} onChange={event => resources.editTerm({ ...resources.current().termDraft, target: event.target.value })}/></Field>
    <EntrySourceFacts project={project} target={value} owner={resources} gate={gate} viewId="entries-facts" disabled={disabled} visible={visible} onOpenEntry={onOpenEntry}/></>;
}
function shell(props: Presentation = {}) {
  return <SessionReadProvider context={context} reads={reads} bridge={false}><TranslationDraftSession project={project}><ExecutionTaskSession project={project}>
    <ResourceDraftSession project={project}><Content {...props}/></ResourceDraftSession>
  </ExecutionTaskSession></TranslationDraftSession></SessionReadProvider>;
}
async function open(props: Presentation = {}) {
  const view = render(shell(props)); await waitFor(() => expect(owner.journal.hydration).toBe("ready"));
  const button = await screen.findAllByRole("button", { name: k("replace") }); await waitFor(() => expect(button[0]).toBeEnabled());
  return { ...view, user: userEvent.setup() };
}
function audit(reason = "Checked source A") {
  fireEvent.change(screen.getByRole("textbox", { name: k("actor") }), { target: { value: "Human reviewer" } });
  fireEvent.change(screen.getByRole("textbox", { name: k("reason") }), { target: { value: reason } });
}
async function override() {
  const view = await open(); await view.user.click(screen.getAllByRole("button", { name: k("replace") })[1]); audit();
  fireEvent.change(screen.getByRole("textbox", { name: k("value") }), { target: { value: "Navigator A" } });
  await waitFor(() => expect(screen.getByRole("button", { name: k("save") })).toBeEnabled()); return view;
}

it.each(["en-US", "zh-CN"])("rejects only an inference and explicitly restores it through the original append-only owner (%s)", async locale => {
  await i18n.changeLanguage(locale); const { user } = await open();
  expect(screen.getAllByRole("button", { name: k("reject") })).toHaveLength(1);
  expect(screen.getByText(i18n.t("sourceContext.rationale", { rationale: "addressed as captain" }))).toBeVisible();
  expect(invoke.mock.calls.filter(([command]) => command === "decide_context_fact")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: k("reject") })); audit("Unconfirmed source inference");
  await user.click(screen.getByRole("button", { name: k("save") }));
  await screen.findByText(i18n.t("workbenchV2.entryFactRejected"));
  expect(history[0].request).toMatchObject({ basis: { scope, fact: { fact: { text: "captain", origin: { kind: "inferred" } } } }, disposition: { kind: "reject-inference" }, actor: "Human reviewer" });
  expect(screen.getByText("captain")).toBeVisible();
  await user.click(screen.getByRole("button", { name: k("restore") })); audit("Confirmed original observation");
  await user.click(screen.getByRole("button", { name: k("save") }));
  await waitFor(() => expect(history).toHaveLength(2));
  expect(history[1].request).toMatchObject({ expectedDecisionId: history[0].request.actionId, disposition: { kind: "restore" } });
  expect(history[0].request.disposition).toEqual({ kind: "reject-inference" });
  await user.click(screen.getByRole("button", { name: k("history") }));
  const recorded = within(screen.getByRole("region", { name: k("history") }));
  expect(await recorded.findByText(/Unconfirmed source inference/)).toBeVisible();
  expect(recorded.getByText(/Confirmed original observation/)).toBeVisible();
});

it("reads a raw source record only when opened, keeps unsupported required facts distinct, and does not interpret raw text", async () => {
  const original = block(), stored: Extract<SourceContextPage["entries"][number], { kind: "stored-block" }> = { kind: "stored-block", value: {
    blockIndex: 2, target: original.target, schema: original.schema, handling: original.handling, inRevisionBasis: original.inRevisionBasis,
    payloadBytes: new TextEncoder().encode(rawPayload).byteLength,
  } };
  pages = [page([{ kind: "block", value: original }, { kind: "block", value: { ...block(1), facts: null, handling: "required" } }, stored])];
  pages[0].observations.unknownBlocks = 1; pages[0].observations.unknownRequiredBlocks = 1;
  const { user, container } = await open(); expect(invoke.mock.calls.filter(([command]) => command === "read_source_context_block")).toHaveLength(0);
  expect(screen.getByText(i18n.t("sourceContextRead.unknownRequired"))).toBeVisible();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceBlockRead.open") }));
  const record = await screen.findByRole("region", { name: i18n.t("sourceBlockRead.record") });
  await waitFor(() => expect(record.querySelector("pre")?.textContent).toBe(rawPayload)); expect(container.querySelector("script")).toBeNull();
  expect(invoke.mock.calls.find(([command]) => command === "read_source_context_block")?.[1].request).toEqual({ ...context, basis: sourceContextBlockBasis(pages[0]), descriptor: stored.value });
});

it("keeps newer fact B, resource B and manual translation B when the original A acknowledgement returns", async () => {
  let finish: (value: ContextFactDecision) => void = () => { throw new Error("A must be waiting"); }, sent: ContextFactWrite | undefined;
  save = request => { sent = structuredClone(request); return new Promise(resolve => { finish = resolve; }); };
  const { user } = await override();
  act(() => { translation.begin({ unitId: target.unitId, locale: target.locale, sourceRevisionId: target.sourceRevisionId, sourceText: target.sourceText, key: target.nativeKey }, null, null, "Translation A"); });
  await user.click(screen.getByRole("button", { name: k("save") })); await waitFor(() => expect(sent).toBeDefined());
  fireEvent.change(screen.getByRole("textbox", { name: k("value") }), { target: { value: "Navigator B 👩🏽‍🚀" } });
  fireEvent.change(screen.getByRole("textbox", { name: k("actor") }), { target: { value: "Reviewer B" } });
  fireEvent.change(screen.getByRole("textbox", { name: k("reason") }), { target: { value: "Newer reason B" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Translation input" }), { target: { value: "Manual translation B" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Retained resource input" }), { target: { value: "Resource B" } });
  await act(async () => { if (!sent) throw new Error("Expected captured A"); finish(apply(sent)); });
  await screen.findByText(i18n.t("resource.savedNewer"));
  expect(history[0].request).toMatchObject({ disposition: { kind: "replace", text: "Navigator A" }, actor: "Human reviewer", reason: "Checked source A" });
  expect(screen.getByRole("textbox", { name: k("value") })).toHaveValue("Navigator B 👩🏽‍🚀");
  expect(screen.getByRole("textbox", { name: k("actor") })).toHaveValue("Reviewer B"); expect(screen.getByRole("textbox", { name: k("reason") })).toHaveValue("Newer reason B");
  expect(translation.current()?.text).toBe("Manual translation B"); expect(owner.current().termDraft.target).toBe("Resource B");
  expect(owner.current().factDraft?.expectedDecisionId).toBe(history[0].request.actionId); expect(owner.current().factPending).toBeNull();
});

it("rechecks the live source proof after identity allocation and prevents a write on an outdated source", async () => {
  let finish: (value: string) => void = () => { throw new Error("Identity must be waiting"); };
  identity = () => new Promise(resolve => { finish = resolve; });
  const { user } = await override(); await user.click(screen.getByRole("button", { name: k("save") }));
  await waitFor(() => expect(owner.current().busyMutation).toBe(true));
  source = { revision: "8", currentSnapshot: fixtureIdentity(88900) }; await act(async () => { reads.invalidate(["source"]); });
  await screen.findByText(i18n.t("sourceContextRead.sourceChanged"));
  await act(async () => finish(fixtureIdentity(88901)));
  await waitFor(() => expect(owner.current().busyMutation).toBe(false));
  expect(invoke.mock.calls.filter(([command]) => command === "decide_context_fact")).toHaveLength(0);
  expect(screen.getByRole("textbox", { name: k("value") })).toHaveValue("Navigator A"); expect(owner.current().factDraft?.expectedDecisionId).toBeNull();
});

it("retains unknown A and newer B until an explicit check allows retrying the exact original request", async () => {
  const sent: ContextFactWrite[] = [];
  save = async request => { sent.push(structuredClone(request)); if (sent.length === 1) throw new Error("Original acknowledgement unavailable"); return apply(request); };
  observe = async () => null;
  const { user } = await override(); await user.click(screen.getByRole("button", { name: k("save") }));
  await screen.findByText(i18n.t("contextFacts.unknown")); await waitFor(() => expect(owner.current().busyMutation).toBe(false));
  fireEvent.change(screen.getByRole("textbox", { name: k("value") }), { target: { value: "Newer B" } });
  expect(screen.queryByRole("button", { name: k("retry") })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: k("discard") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: k("check") }));
  const retry = await screen.findByRole("button", { name: k("retry") }); await waitFor(() => expect(retry).toBeEnabled());
  expect(sent).toHaveLength(1); await user.click(retry);
  await waitFor(() => expect(owner.current().factPending).toBeNull());
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
  expect(screen.getByRole("textbox", { name: k("value") })).toHaveValue("Newer B"); expect(history[0].request.disposition).toEqual({ kind: "replace", text: "Navigator A" });
});

it("does not trust an invalidated decision query or a new current CAS, and keeps its draft for review", async () => {
  const { user } = await override(), draft = owner.current().factDraft; if (!draft) throw new Error("Expected source fact draft");
  const concurrent: ContextFactDecision = { request: { actionId: fixtureIdentity(88902), basis: structuredClone(draft.basis), expectedDecisionId: null, disposition: { kind: "reject-inference" }, actor: "Another reviewer", reason: "A concurrent decision" } };
  history.push(concurrent); actions.set(concurrent.request.actionId, concurrent);
  await act(async () => { reads.invalidate(["resources"]); });
  await screen.findByText(i18n.t("contextFacts.changed"));
  expect(reads.client.getQueryData<ContextFactDecision[]>(reads.key(contextFactQueryKey(draft.basis.scope, [{ blockIndex: draft.basis.fact.blockIndex, factIndex: draft.basis.fact.factIndex }])))).toEqual([concurrent]);
  expect(screen.getByRole("button", { name: k("save") })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: k("save") }));
  expect(invoke.mock.calls.filter(([command]) => command === "decide_context_fact")).toHaveLength(0); expect(owner.current().factDraft?.expectedDecisionId).toBeNull();
  await user.click(screen.getByRole("button", { name: k("discard") })); expect(owner.current().factDraft).toBeNull();
});

it("keeps source facts visible on a decision read failure and restores only the verified decision controls", async () => {
  failDecisions = true; render(shell());
  await screen.findByText(i18n.t("contextFacts.readFailed")); expect(screen.getByText("captain")).toBeVisible();
  expect(screen.getByRole("button", { name: k("reject") })).toBeDisabled();
  failDecisions = false; await userEvent.setup().click(screen.getByRole("button", { name: i18n.t("resource.refresh") }));
  await waitFor(() => expect(screen.getByRole("button", { name: k("reject") })).toBeEnabled()); expect(history).toHaveLength(0);
});

it("blocks saving during composition or another visible tab and preserves localized B inputs", async () => {
  const { user } = await override(), input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: k("value") });
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: "组合输入 B é" } });
  expect(screen.getByRole("button", { name: k("save") })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: k("save") }));
  fireEvent.compositionEnd(input); await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(screen.getByRole("textbox", { name: k("value") })).toBe(input); expect(input).toHaveValue("组合输入 B é");
  act(() => gate.setVisibleOwner("another-view")); expect(screen.getByRole("button", { name: k("save") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: k("save") })); expect(history).toHaveLength(0);
  act(() => gate.setVisibleOwner("entries-facts")); await waitFor(() => expect(screen.getByRole("button", { name: k("save") })).toBeEnabled());
});

it("keeps a previous entry's correction in its owner and offers its exact return path without applying it to another entry", async () => {
  const previous = pages[0], nextTarget = reviewTargetFixture({ ...target, unitId: fixtureIdentity(88910), sourceRevisionId: fixtureIdentity(88911), nativeKey: "dialogue.other" });
  const onOpenEntry = vi.fn(async () => true), view = await override();
  pages = [{ ...page(), scope: { ...scope, unitId: nextTarget.unitId, sourceRevisionId: nextTarget.sourceRevisionId } }];
  view.rerender(shell({ target: nextTarget, onOpenEntry }));
  await screen.findByText(i18n.t("workbenchV2.entryFactOtherDraft"));
  expect(screen.queryByRole("textbox", { name: k("value") })).not.toBeInTheDocument();
  await view.user.click(screen.getByRole("button", { name: `${i18n.t("contextFacts.currentEntry")}: ${target.nativeKey}` }));
  expect(onOpenEntry).toHaveBeenCalledExactlyOnceWith(target.unitId, target.locale);
  expect(owner.current().factDraft?.basis.scope).toEqual(scope); expect(owner.current().factDraft?.disposition).toEqual({ kind: "replace", text: "Navigator A" });
  pages = [previous]; view.rerender(shell());
  expect(await screen.findByRole("textbox", { name: k("value") })).toHaveValue("Navigator A");
  await waitFor(() => expect(screen.getByRole("button", { name: k("save") })).toBeEnabled());
  expect(invoke.mock.calls.filter(([command]) => command === "decide_context_fact")).toHaveLength(0);
});

it("loads four source entries per page and bounds each exact decision query to 128 positions", async () => {
  const entries = Array.from({ length: 4 }, (_, blockIndex): SourceContextPage["entries"][number] => ({ kind: "block", value: { ...block(blockIndex), facts: { facts: Array.from({ length: 32 }, (_, index): SourceFactBasis["fact"]["fact"] => ({ id: `fact-${index}`, kind: "note", text: `Fact ${blockIndex}:${index}`, origin: { kind: "extracted", sources: [sourceReference] } })) } } }));
  pages = [page(entries, 0, 5, 4), page([{ kind: "block", value: block(4) }], 4, 5)];
  const { user } = await open(); await user.click(screen.getByRole("button", { name: i18n.t("sourceContextRead.more") }));
  await screen.findByText(i18n.t("sourceContextRead.progress", { loaded: "5", total: "5" }));
  const sourceCalls = invoke.mock.calls.filter(([command]) => command === "read_source_context").map(([, payload]) => payload.request);
  expect(sourceCalls).toEqual([{ ...context, ...scope, after: 0, limit: 4 }, { ...context, ...scope, after: 4, limit: 4 }]);
  for (const [, payload] of invoke.mock.calls.filter(([command]) => command === "read_context_fact_decisions")) expect(payload.request.facts.length).toBeLessThanOrEqual(128);
  expect(invoke.mock.calls.some(([command, payload]) => command === "read_context_fact_decisions" && payload.request.facts.length === 128)).toBe(true);
});

it("pages history in groups of ten and identifies decisions retained from an older source", async () => {
  const value = block(), fact = value.facts?.facts[1]; if (!fact) throw new Error("Expected inferred source fact");
  const basis: SourceFactBasis = { scope, sourceResultId: pages[0].sourceResultId, sourceResultDigest: pages[0].sourceResultDigest,
    fact: { blockIndex: value.blockIndex, factIndex: 1, fact, target: value.target, schema: value.schema, handling: value.handling, inRevisionBasis: value.inRevisionBasis } };
  for (let index = 0; index < 11; index++) {
    const historicBasis = index === 0 ? { ...basis, scope: { ...scope, sourceSnapshotId: fixtureIdentity(88880) } } : basis;
    const decision: ContextFactDecision = { request: { actionId: fixtureIdentity(88800 + index), basis: structuredClone(historicBasis), expectedDecisionId: index > 0 ? fixtureIdentity(88800 + index - 1) : null,
      disposition: { kind: "replace", text: `Historic value ${index}` }, actor: "Human reviewer", reason: `History reason ${index}` } };
    history.push(decision); actions.set(decision.request.actionId, decision);
  }
  const { user } = await open(); await user.click(screen.getByRole("button", { name: k("history") }));
  const recorded = within(screen.getByRole("region", { name: k("history") }));
  await recorded.findByText(/History reason 10/); await user.click(recorded.getByRole("button", { name: i18n.t("execution.nextPage") }));
  await recorded.findByText(/History reason 0/); expect(recorded.getByText(i18n.t("contextFacts.historicalSource"))).toBeVisible();
  expect(invoke.mock.calls.filter(([command]) => command === "read_context_fact_history").map(([, payload]) => payload.request)).toEqual([
    { ...context, unitId: target.unitId, locale: target.locale, offset: 0, limit: 10 },
    { ...context, unitId: target.unitId, locale: target.locale, offset: 10, limit: 10 },
  ]);
});
