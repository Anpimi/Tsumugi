import { createRef, useLayoutEffect, useState, type Ref, type RefObject } from "react";
import { act, cleanup, screen, waitFor, within, render as renderUi } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiWorkbench, type AiHandle } from "./AiWorkbench";
import { AiPreparationSession } from "./AiPreparationSession";
import { defaultAiConfig, type AiItem, type AiView } from "./aiCommands";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands } from "./workbenchCommands";
import { i18n } from "./i18n";
import type { ProjectView } from "./projectCommands";
import type { TranslationRevision, TranslationHistory, CandidateDecision, CandidateDecisionRequest } from "./translationCommands";
import type { AdoptionAction, PrepareRequest } from "./executionCommands";
import execution from "../test/fixtures/executionCommands.contract.json";
import translation from "../test/fixtures/translation-commands.json";
import { aiAttempt, aiViewFixture } from "./testSupport/aiFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { reviewTargetFixture, reviewSummaryFor, reviewSummaryPageFixture } from "./testSupport/reviewFixture";
import { ProjectSessionWorkbench, type ProjectSessionHandle } from "./ProjectSessionWorkbench";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "./workbenchCommands";
import { WorkspaceViewMemory, WorkspaceViewProvider, WorkbenchNavigation, type WorkspaceArea } from "./WorkbenchFrame";
import type { SessionExitPermit } from "./sessionNavigation";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const project: ProjectView = { sessionToken: "candidate-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(500), displayName: "Candidate decisions", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const item: AiItem = { unitId: fixtureIdentity(301), sourceRevisionId: fixtureIdentity(302), sourceSnapshotId: fixtureIdentity(300),
  nativeKey: "first", sourceLocale: "en", sourceText: "Hello", targetLocale: "zh-CN", terms: [], context: null, sourceContext: { kind: "not-selected" },
  omissions: ["terms-not-shared", "context-not-shared"], resourceBaseline: "0" };
const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "ai" as const };
let drafts: ReturnType<typeof useTranslationDraftSession>, reads: ReturnType<typeof useSessionReads>, commands: ReturnType<typeof useWorkbenchCommands>;
let view: AiView, revision: TranslationRevision, history: TranslationHistory, sourceSnapshot: string, identities: number, action: AdoptionAction;
function Probe() {
  const draft = useTranslationDraftSession(), reader = useSessionReads(), registry = useWorkbenchCommands();
  useLayoutEffect(() => { drafts = draft; reads = reader; commands = registry; }); return null;
}
function Harness({ consumer = true, project: current = project, handle }: { consumer?: boolean; project?: ProjectView; handle?: Ref<AiHandle> }) {
  return <AiPreparationSession initialLocale="zh-CN" targetLocales={current.metadata.targetLocales}><Probe />
    {consumer ? <AiWorkbench project={current} ref={handle} disabled={false} onOpenTranslation={async () => true} /> : null}
  </AiPreparationSession>;
}
function calls(name: string) { return invoke.mock.calls.filter(([command]) => command === name); }
function requests(name: string) { return calls(name).map(([, args]) => args.request); }
function editor() {
  return { target: reviewTargetFixture({ unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, sourceSnapshotId: sourceSnapshot,
    locale: "zh-CN", selectionId: history.current?.eventId ?? null, revisionId: history.current?.revisionId ?? null, translationText: history.currentText }),
  translations: structuredClone(history), terms: { unitId: item.unitId, locale: "zh-CN", sourceRevisionId: item.sourceRevisionId, entries: [] }, context: null, readVersion: "1" };
}
function record(request: CandidateDecisionRequest): CandidateDecision {
  const receipt: CandidateDecision = { request: { ...structuredClone(request.decision),
    expectedDecisionId: request.decision.expectedDecisionId ?? null, expectedSelectionId: request.decision.expectedSelectionId ?? null }, sourceSnapshotId: sourceSnapshot };
  revision = { ...revision, candidateDecision: receipt }; history = { ...history, rows: [revision] };
  view = { ...view, rows: [{ ...view.rows[0], candidateDecision: receipt }] }; return receipt;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); identities = 800; sourceSnapshot = item.sourceSnapshotId;
  view = aiViewFixture(item, defaultAiConfig);
  revision = { ...translation.receipt.revision, revisionId: fixtureIdentity(900), actionId: fixtureIdentity(901), originKind: "ai", unitId: item.unitId,
    locale: "zh-CN", sourceRevisionId: item.sourceRevisionId, sourceSnapshotId: item.sourceSnapshotId, ordinal: "1", text: "你好",
    attemptId: aiAttempt, resultId: view.rows[0].resultId, itemId: view.rows[0].itemId, artifactId: null, logicalPath: null, declaredLocale: null, nativeKey: null, fileDigest: null, contributors: [] };
  view.rows[0].savedRevisionId = revision.revisionId;
  history = { unitId: item.unitId, locale: "zh-CN", current: null, currentText: null, total: "1", rows: [revision], nextOrdinal: null };
  invoke.mockReset(); invoke.mockImplementation(async (command: string, { request }: { request: Record<string, unknown> }) => {
    if (command === "read_project_changes") return { sessionToken: project.sessionToken, projectId: project.metadata.projectId,
      epoch: fixtureIdentity(1000), sequence: "0", progressSequence: "0", scopes: [], runtime: execution.status };
    if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor(editor().target)]);
    if (command === "read_work_protection") return { unitId: request.unitId, locale: request.locale, revision: "1", protected: true };
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: sourceSnapshot };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: sourceSnapshot, scope: { revision: "1", currentSnapshot: sourceSnapshot },
      rows: [sourceRowFixture({ unitId: item.unitId, sourceRevisionId: item.sourceRevisionId }, { key: "first", text: item.sourceText })] });
    if (command === "read_ai_translation") return structuredClone(view);
    if (command === "read_plugin_text_reviews") return { settingsRevision: "1", entries: [] };
    if (command === "read_review_editor_snapshot") return editor();
    if (command === "read_translation_history") return structuredClone(history);
    if (command === "create_execution_identity") return fixtureIdentity(identities++);
    if (command === "decide_translation_candidate") return record(request as unknown as CandidateDecisionRequest);
    if (command === "read_translation_candidate_action") return revision.candidateDecision ?? null;
    if (command === "prepare_execution_adoption") {
      const input = request as unknown as PrepareRequest;
      action = { ...execution.action, projectId: input.projectId, attemptId: input.attemptId, actionId: input.actionId, unitId: input.unitId,
        operation: "ai-translation", parameters: null, resultIds: [...input.resultIds] }; return action;
    }
    if (command === "adopt_execution") {
      view = { ...view, rows: [{ ...view.rows[0], savedRevisionId: revision.revisionId }] };
      return { ...execution.receipt, projectId: action.projectId, attemptId: action.attemptId, actionId: action.actionId, unitId: action.unitId,
        changes: [{ kind: "translation-revision", id: revision.revisionId, revision: "1" }] };
    }
    throw new Error(command);
  });
});
afterEach(cleanup);
async function open() {
  const handle = createRef<AiHandle>(), rendered = render(<Harness project={project} handle={handle} />), user = userEvent.setup();
  act(() => { drafts.begin({ unitId: fixtureIdentity(999), locale: "zh-CN", sourceRevisionId: fixtureIdentity(998), key: "manual", sourceText: "Unrelated" }, null, null, "Manual B 👩🏽‍💻"); handle.current!.showAttempt(aiAttempt); });
  await screen.findByText("你好", { selector: "pre" });
  return { handle, rendered, user };
}
async function inspect() {
  const result = await open();
  await result.user.click(await screen.findByRole("button", { name: i18n.t("candidateDecisions.inspect") }));
  await result.user.type(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.actor") }), "Reviewer A");
  await result.user.type(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.reason") }), "Reason A");
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") })).toBeEnabled());
  return result;
}

it.each(["en-US", "zh-CN"])("rejects and restores the real saved AI candidate in place, preserving manual B (%s)", async language => {
  await i18n.changeLanguage(language); const { user } = await inspect();
  const before = structuredClone(drafts.current());
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") }));
  await screen.findByText(i18n.t("candidateDecisions.rejectedRecorded"));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("candidateDecisions.restore") })).toBeEnabled());
  expect(screen.getByRole("button", { name: i18n.t("ai.workspace.rewrite") })).toBeDisabled();
  expect(screen.getAllByText("你好", { selector: "pre" })).toHaveLength(2);
  expect(drafts.current()).toEqual(before);
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.restore") }));
  await screen.findByText(i18n.t("candidateDecisions.restoredRecorded"));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("ai.workspace.rewrite") })).toBeEnabled());
  const actions = requests("decide_translation_candidate");
  expect(actions).toHaveLength(2); expect(actions[0].decision).toMatchObject({ revisionId: revision.revisionId, disposition: "rejected", expectedSelectionId: null, expectedDecisionId: null, actor: "Reviewer A", reason: "Reason A" });
  expect(actions[1].decision).toMatchObject({ disposition: "restored", expectedDecisionId: actions[0].decision.actionId });
  expect(calls("save_translation_revision")).toHaveLength(0); expect(calls("select_translation_revision")).toHaveLength(0); expect(drafts.current()).toEqual(before);
});

it("requires formal candidate saving before exposing a decision target", async () => {
  view.rows[0].savedRevisionId = null;
  const { user } = await open();
  expect(screen.getByText(i18n.t("candidateDecisions.saveFirst"))).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: i18n.t("candidateDecisions.inspect") })).not.toBeInTheDocument();
  const row = view.rows[0];
  expect(commands.dispatch("ai.inspect-candidate", scope, { kind: "ai-saved-candidate", attemptId: aiAttempt, taskId: view.detail.taskId, itemId: row.itemId,
    translationUnitId: item.unitId, locale: "zh-CN", sourceRevisionId: item.sourceRevisionId, sourceSnapshotId: item.sourceSnapshotId,
    resultId: row.resultId!, revisionId: fixtureIdentity(999) })).toBe(false);
  expect(calls("create_execution_identity")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: i18n.t("ai.saveCandidate") }));
  await screen.findByRole("button", { name: i18n.t("candidateDecisions.inspect") });
  expect(calls("adopt_execution")).toHaveLength(1); expect(calls("decide_translation_candidate")).toHaveLength(0);
});

it.each(["source", "selection", "history", "retire"])("refuses an identity continuation after its checked %s changes", async change => {
  const { user } = await inspect(), original = invoke.getMockImplementation()!;
  let complete!: (value: string) => void;
  invoke.mockImplementation((command, args) => command === "create_execution_identity" ? new Promise<string>(resolve => { complete = resolve; }) : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") }));
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  await act(async () => {
    if (change === "source") { sourceSnapshot = fixtureIdentity(777); reads.invalidate(["source"]); }
    else if (change === "selection") {
      history = { ...history, current: { actionId: fixtureIdentity(771), eventId: fixtureIdentity(772), unitId: item.unitId, locale: "zh-CN", revisionId: fixtureIdentity(773), sequence: "1", previousEventId: null } }; reads.invalidate(["translation"]);
    } else if (change === "history") { history = { ...history, rows: [{ ...revision, text: "Different history response" }] }; reads.invalidate(["translation"]); }
    else reads.retire();
    complete(fixtureIdentity(888));
  });
  if (change !== "retire") await waitFor(() => expect(drafts.candidates.current().busy).toBe(false));
  expect(calls("decide_translation_candidate")).toHaveLength(0); expect(drafts.current()?.text).toBe("Manual B 👩🏽‍💻");
});

it("settles A after consumer removal without replacing newer reason B or the manual draft", async () => {
  const { user, rendered, handle } = await inspect(), original = invoke.getMockImplementation()!;
  let recorded: CandidateDecision | null = null;
  invoke.mockImplementation(async (command, args) => {
    if (command === "decide_translation_candidate") { recorded = record(args.request); throw new Error("Reply lost"); }
    if (command === "read_translation_candidate_action") return recorded;
    return original(command, args);
  });
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") }));
  await screen.findByRole("button", { name: i18n.t("candidateDecisions.check") });
  await user.clear(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.reason") }));
  await user.type(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.reason") }), "Reason B");
  rendered.rerender(<Harness consumer={false} project={project} handle={handle} />);
  expect(commands.list(scope).find(command => command.id === "ai.decide-candidate")).toBeUndefined();
  rendered.rerender(<Harness project={{ ...project, metadata: { ...project.metadata, targetLocales: [] } }} handle={handle} />);
  await user.click(await screen.findByRole("button", { name: i18n.t("candidateDecisions.check") }));
  await screen.findByText(i18n.t("candidateDecisions.rejectedRecorded"));
  expect(drafts.candidates.current().reason).toBe("Reason B"); expect(drafts.candidates.hasDraft()).toBe(true);
  expect(drafts.current()?.text).toBe("Manual B 👩🏽‍💻"); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(requests("read_translation_candidate_action")[0]).toMatchObject({ actionId: requests("decide_translation_candidate")[0].decision.actionId, unitId: item.unitId, locale: "zh-CN" });
});

it("checks absence before retrying the exact original request and keeps B after a later rejection", async () => {
  const { user } = await inspect(), original = invoke.getMockImplementation()!;
  let tries = 0;
  invoke.mockImplementation(async (command, args) => {
    if (command === "decide_translation_candidate") {
      tries++; if (tries === 1) throw new Error("Reply lost");
      if (tries === 2) throw { code: "dependency-conflict", stage: "execution-write", outcome: "rejected", recoveryRequired: false, reason: "candidate-decision" };
      return record(args.request);
    }
    if (command === "read_translation_candidate_action") return null;
    return original(command, args);
  });
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") }));
  await screen.findByRole("button", { name: i18n.t("candidateDecisions.check") });
  expect(screen.queryByRole("button", { name: i18n.t("candidateDecisions.retry") })).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.reason") }), " B");
  for (let n = 0; n < 2; n++) {
    await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.check") }));
    await user.click(await screen.findByRole("button", { name: i18n.t("candidateDecisions.retry") }));
    if (n === 0) await waitFor(() => expect(tries).toBe(2));
  }
  await screen.findByText(i18n.t("candidateDecisions.rejectedRecorded"));
  const actions = requests("decide_translation_candidate"); expect(actions).toHaveLength(3);
  expect(actions[1]).toEqual(actions[0]); expect(actions[2]).toEqual(actions[0]); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(drafts.candidates.current().reason).toBe("Reason A B"); expect(drafts.candidates.hasDraft()).toBe(true);
});

it("finds an older saved candidate beyond the real last-100 snapshot and keeps both history directions safe", async () => {
  const later = Array.from({ length: 100 }, (_, index): TranslationRevision => {
    const ordinal = index + 2;
    return { ...revision, revisionId: fixtureIdentity(2000 + ordinal), actionId: fixtureIdentity(3000 + ordinal), ordinal: String(ordinal),
      text: `Other candidate ${ordinal}`, attemptId: fixtureIdentity(4000 + ordinal), resultId: fixtureIdentity(5000 + ordinal), itemId: fixtureIdentity(6000 + ordinal) };
  });
  history = { ...history, total: "101" };
  const original = invoke.getMockImplementation()!; let historyUnavailable = false;
  function page(after: bigint): TranslationHistory {
    const rows = [revision, ...later].filter(row => BigInt(row.ordinal) > after).slice(0, 100);
    return { ...history, rows, nextOrdinal: rows.length && BigInt(rows.at(-1)!.ordinal) < 101n ? rows.at(-1)!.ordinal : null };
  }
  invoke.mockImplementation((command, args) => {
    if (command === "read_review_editor_snapshot") return Promise.resolve({ ...editor(), translations: page(1n) });
    if (command === "read_translation_history") {
      if (historyUnavailable) return Promise.reject(new Error("History unavailable"));
      return Promise.resolve(page(BigInt(args.request.afterOrdinal)));
    }
    return original(command, args);
  });
  const { user } = await open();
  await user.click(await screen.findByRole("button", { name: i18n.t("candidateDecisions.inspect") }));
  await user.type(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.actor") }), "Reviewer");
  await user.type(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.reason") }), "Reason");
  expect(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") })).toBeDisabled();
  expect(screen.queryByRole("button", { name: i18n.t("candidateDecisions.nextHistory") })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.earlierHistory") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") })).toBeEnabled());
  expect(requests("read_translation_history")[0]).toMatchObject({ unitId: item.unitId, locale: "zh-CN", afterOrdinal: "0", limit: 100 });
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.nextHistory") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") })).toBeDisabled());
  expect(requests("read_translation_history").some(request => request.afterOrdinal === "100")).toBe(true);
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.earlierHistory") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") })).toBeEnabled());
  historyUnavailable = true;
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.refresh") }));
  await screen.findByText(i18n.t("candidateDecisions.unavailable"));
  expect(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") })).toBeDisabled(); expect(calls("decide_translation_candidate")).toHaveLength(0);
  historyUnavailable = false;
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.refresh") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") }));
  await screen.findByText(i18n.t("candidateDecisions.rejectedRecorded"));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("candidateDecisions.restore") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.restore") }));
  await screen.findByText(i18n.t("candidateDecisions.restoredRecorded"));
  const actions = requests("decide_translation_candidate"); expect(actions).toHaveLength(2);
  expect(actions[0].decision).toMatchObject({ revisionId: revision.revisionId, disposition: "rejected" });
  expect(actions[1].decision).toMatchObject({ revisionId: revision.revisionId, disposition: "restored", expectedDecisionId: actions[0].decision.actionId });
  expect(revision.ordinal).toBe("1"); expect(revision.text).toBe("你好");
  history = { ...history, current: { actionId: fixtureIdentity(771), eventId: fixtureIdentity(772), unitId: item.unitId, locale: "zh-CN", revisionId: revision.revisionId, sequence: "1", previousEventId: null } };
  await act(async () => { reads.invalidate(["translation"]); });
  await screen.findByText(i18n.t("candidateDecisions.selected"));
  expect(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") })).toBeDisabled();
});

it("captures reason A before identity while retaining newer reason B after success", async () => {
  const { user } = await inspect(), original = invoke.getMockImplementation()!;
  let complete!: (value: string) => void;
  invoke.mockImplementation((command, args) => command === "create_execution_identity" ? new Promise<string>(resolve => { complete = resolve; }) : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") }));
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  await user.clear(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.reason") }));
  await user.type(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.reason") }), "Reason B 👩🏽‍💻");
  await act(async () => { complete(fixtureIdentity(888)); });
  await screen.findByText(i18n.t("candidateDecisions.rejectedRecorded"));
  expect(requests("decide_translation_candidate")[0].decision.reason).toBe("Reason A");
  expect(drafts.candidates.current().reason).toBe("Reason B 👩🏽‍💻"); expect(drafts.candidates.hasDraft()).toBe(true);
  expect(drafts.current()?.text).toBe("Manual B 👩🏽‍💻");
});


function ProductionHarness({ handle }: { handle: RefObject<ProjectSessionHandle | null> }) {
  const [area, setArea] = useState<WorkspaceArea>("overview"), [memory] = useState(() => new WorkspaceViewMemory()), [registry] = useState(() => new WorkbenchCommands());
  const [sourceState, setSourceState] = useState("loading");
  const session = handle;
  return <ApplicationReadProvider><WorkbenchCommandsProvider commands={registry}>
    <WorkspaceViewProvider value={{ area, memory, activate: setArea, deactivate: closing => setArea(value => value === closing ? "overview" : value) }}>
      <WorkbenchNavigation area={area} hasProject disabled={false} onNavigate={next => { void session.current?.navigate({ kind: "area", area: next }); }} />
      <output aria-label="Source readiness">{sourceState}</output>
      <ProjectSessionWorkbench onSourceState={value => setSourceState(value.state)} project={project} disabled={false} ref={handle} onActivate={setArea} onCoordinatingChange={() => {}} />
    </WorkspaceViewProvider>
  </WorkbenchCommandsProvider></ApplicationReadProvider>;
}
async function openProduction(manual = false) {
  const handle = createRef<ProjectSessionHandle>(), user = userEvent.setup(); renderUi(<ProductionHarness handle={handle} />);
  await waitFor(() => expect(screen.getByLabelText("Source readiness")).toHaveTextContent("ready"));
  if (manual) await act(async () => { expect(await handle.current!.navigate({ kind: "translation", target: { unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, key: "first", sourceText: "Hello" }, locale: "zh-CN", suggestedText: "Manual B 👩🏽‍💻" })).toBe(true); });
  await act(async () => { expect(await handle.current!.navigate({ kind: "attempt", area: "ai", attemptId: aiAttempt })).toBe(true); });
  await user.click(await screen.findByRole("button", { name: i18n.t("candidateDecisions.inspect") }));
  await user.type(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.actor") }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.reason") }), "Reason A");
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") })).toBeEnabled());
  return { handle, user };
}

it("keeps original recovery visible through real session navigation and project exit with no manual draft", async () => {
  const original = invoke.getMockImplementation()!; let receipt: CandidateDecision | null = null;
  invoke.mockImplementation(async (command, args) => {
    if (command === "decide_translation_candidate") { receipt = record(args.request); throw new Error("Reply lost"); }
    if (command === "read_translation_candidate_action") return receipt;
    return original(command, args);
  });
  const { handle, user } = await openProduction();
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") }));
  await screen.findByRole("button", { name: i18n.t("candidateDecisions.check") });
  await user.type(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.reason") }), " B");
  await act(async () => { expect(await handle.current!.navigate({ kind: "area", area: "overview" })).toBe(false); });
  expect(screen.getByRole("heading", { level: 1, name: i18n.t("ai.title") })).toBeInTheDocument();
  await act(async () => { expect(await handle.current!.prepareExit()).toBeNull(); });
  await screen.findByRole("heading", { level: 1, name: i18n.t("translation.title") });
  expect(screen.queryByRole("textbox", { name: i18n.t("translation.draft") })).not.toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: i18n.t("candidateDecisions.check") }));
  await screen.findByText(i18n.t("candidateDecisions.rejectedRecorded"));
  expect(screen.getByRole("textbox", { name: i18n.t("candidateDecisions.reason") })).toHaveValue("Reason A B");
  let closing!: Promise<SessionExitPermit | null>;
  act(() => { closing = handle.current!.prepareExit(); });
  const dialog = await screen.findByRole("dialog", { name: i18n.t("candidateDecisions.leaveTitle") });
  await user.click(within(dialog).getByRole("button", { name: i18n.t("candidateDecisions.discard") }));
  let permit!: SessionExitPermit | null; await act(async () => { permit = await closing; });
  expect(permit).not.toBeNull(); expect(permit!.current()).toBe(true); act(() => permit!.release());
  expect(calls("decide_translation_candidate")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
});

it("discards only candidate details before separately protecting manual B through the production exit coordinator", async () => {
  const { handle, user } = await openProduction(true);
  await act(async () => { expect(await handle.current!.navigate({ kind: "area", area: "overview" })).toBe(true); });
  let closing!: Promise<SessionExitPermit | null>;
  act(() => { closing = handle.current!.prepareExit(); });
  const candidateDialog = await screen.findByRole("dialog", { name: i18n.t("candidateDecisions.leaveTitle") });
  await user.click(within(candidateDialog).getByRole("button", { name: i18n.t("candidateDecisions.discard") }));
  await act(async () => { expect(await closing).toBeNull(); });
  expect(screen.getByLabelText(i18n.t("translation.draft"))).toHaveValue("Manual B 👩🏽‍💻");
  expect(screen.getByText(i18n.t("candidateDecisions.detailsDiscarded"))).toBeInTheDocument();
  act(() => { closing = handle.current!.prepareExit(); });
  const manualDialog = await screen.findByRole("dialog", { name: i18n.t("translation.leaveTitle") });
  expect(screen.getByLabelText(i18n.t("translation.draft"))).toHaveValue("Manual B 👩🏽‍💻");
  await user.click(within(manualDialog).getByRole("button", { name: i18n.t("translation.stay") }));
  await act(async () => { expect(await closing).toBeNull(); });
  expect(screen.getByLabelText(i18n.t("translation.draft"))).toHaveValue("Manual B 👩🏽‍💻");
  expect(calls("save_translation_revision")).toHaveLength(0); expect(calls("select_translation_revision")).toHaveLength(0);
});

it("retains the exact request when a structurally valid acknowledgement names the wrong target", async () => {
  const { user } = await inspect(), original = invoke.getMockImplementation()!; let receipt: CandidateDecision | null = null;
  invoke.mockImplementation(async (command, args) => {
    if (command === "decide_translation_candidate") { receipt = record(args.request); return { ...receipt, request: { ...receipt.request, unitId: fixtureIdentity(1111) } }; }
    if (command === "read_translation_candidate_action") return receipt;
    return original(command, args);
  });
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.reject") }));
  await screen.findByRole("button", { name: i18n.t("candidateDecisions.check") });
  expect(drafts.candidates.current().pending?.decision.unitId).toBe(item.unitId);
  expect(drafts.candidates.current().failure).toBe("invalid-candidate-decision-receipt");
  await user.click(screen.getByRole("button", { name: i18n.t("candidateDecisions.check") }));
  await screen.findByText(i18n.t("candidateDecisions.rejectedRecorded"));
  expect(calls("decide_translation_candidate")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
});

it("opens the exact saved AI revision in offline Arena and preserves the separate manual B draft", async () => {
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command,args)=>command==="list_arena_comparisons"?Promise.resolve([]):original(command,args));
  const {handle,user}=await openProduction(true);
  await user.click(await screen.findByRole("button",{name:i18n.t("arena.openFromEntry")}));
  await screen.findByRole("heading",{name:i18n.t("arena.savedComparison")});
  expect(await screen.findByRole("checkbox",{name:/你好/})).toBeChecked();
  expect(requests("read_translation_history").some(request=>request.unitId===revision.unitId&&request.afterOrdinal==="0"&&request.limit===1)).toBe(true);
  for(const command of ["create_arena_comparison","preview_arena_translation","start_arena_translation","select_translation_revision","save_arena_merge"])expect(calls(command)).toHaveLength(0);
  await user.click(screen.getByRole("button",{name:i18n.t("arena.returnToEntry")}));
  await screen.findByRole("heading",{level:1,name:i18n.t("ai.title")});
  await act(async()=>expect(await handle.current!.navigate({kind:"area",area:"translation"})).toBe(true));
  expect(await screen.findByLabelText(i18n.t("translation.draft"))).toHaveValue("Manual B 👩🏽‍💻");
});

it("rejects a contextual Arena destination if the actual selected revision or source basis disagrees", async()=>{
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command,args)=>command==="list_arena_comparisons"?Promise.resolve([]):original(command,args));
  const {handle}=await openProduction(true);
  const target={unitId:item.unitId,sourceRevisionId:item.sourceRevisionId,key:item.nativeKey,sourceText:item.sourceText};
  for(const invalid of [{revisionId:fixtureIdentity(1800)},{revisionOrdinal:"0"},{target:{...target,sourceRevisionId:fixtureIdentity(1801)}}]){
    await act(async()=>expect(await handle.current!.navigate({kind:"arena-comparison",target,locale:"zh-CN",revisionId:revision.revisionId,revisionOrdinal:revision.ordinal,returnTo:"ai",...invalid})).toBe(false));
  }
  expect(screen.getByRole("heading",{level:1,name:i18n.t("ai.title")})).toBeInTheDocument();
  expect(calls("create_arena_comparison")).toHaveLength(0);expect(calls("create_execution_identity")).toHaveLength(0);
});
