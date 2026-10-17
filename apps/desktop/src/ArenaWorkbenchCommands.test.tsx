import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import execution from "../test/fixtures/executionCommands.contract.json";
import { ArenaWorkbench } from "./ArenaWorkbench";
import { useArenaDraftSession } from "./ArenaDraftSession";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands, type ArenaCandidateCommandPayload, type ArenaComparisonCommandPayload,
  type ArenaMergeCommandPayload, type ArenaTranslationCommandPayload } from "./workbenchCommands";
import { defaultArenaConfig, type ArenaConfig, type ArenaPrepared, type ArenaView, type ComparisonView } from "./arenaCommands";
import type { AiItem } from "./aiCommands";
import type { AdoptionAction, PrepareRequest, Receipt } from "./executionCommands";
import type { TranslationHistory, TranslationSelection } from "./translationCommands";
import type { ProjectView } from "./projectCommands";
import { i18n } from "./i18n";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { aiAttempt, aiTask, arenaViewFixture } from "./testSupport/aiFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "arena-command-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(500), displayName: "Arena commands", sourceLocale: "en", targetLocales: ["zh-CN", "ja"], metadataRevision: "1" } };
const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "arena" as const };
const item: AiItem = { unitId: fixtureIdentity(301), sourceRevisionId: fixtureIdentity(302), sourceSnapshotId: fixtureIdentity(300),
  nativeKey: "first", sourceLocale: "en", sourceText: "Hello {name}", targetLocale: "zh-CN", terms: [], context: null, sourceContext: {kind:"not-selected"}, projectContext: {kind:"not-selected" as const},
  omissions: ["terms-not-shared", "context-not-shared"], resourceBaseline: "0" };
let owner: ReturnType<typeof useArenaDraftSession>, reads: ReturnType<typeof useSessionReads>, registry: ReturnType<typeof useWorkbenchCommands>;
let tasks: ReturnType<typeof useExecutionTaskSession>, prepared: ArenaPrepared, view: ArenaView, comparison: ComparisonView, action: AdoptionAction;
const navigate = vi.fn(async () => true);
function Probe() {
  const arena = useArenaDraftSession(), sessionReads = useSessionReads(), commands = useWorkbenchCommands(), taskOwner = useExecutionTaskSession();
  useLayoutEffect(() => { owner = arena; reads = sessionReads; registry = commands; tasks = taskOwner; });
  return null;
}
function Harness({ project: current = project, mounted = true }: { project?: ProjectView; mounted?: boolean }) {
  return <><Probe />{mounted ? <ArenaWorkbench project={current} disabled={false} onOpenTranslation={navigate} /> : null}</>;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function payloads(command: string) { return calls(command).map(([, payload]) => payload.request); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function actionFor(request: PrepareRequest): AdoptionAction {
  return { ...execution.action, projectId: request.projectId, attemptId: request.attemptId, actionId: request.actionId, unitId: request.unitId,
    operation: "arena-translation", parameters: null, resultIds: [...request.resultIds] };
}
function receiptFor(value = action): Receipt {
  return { ...execution.receipt, projectId: value.projectId, attemptId: value.attemptId, actionId: value.actionId, unitId: value.unitId,
    changes: [{ kind: "translation-revision", id: fixtureIdentity(950), revision: "1" }] };
}
function selectionFor(request: Record<string, unknown>): TranslationSelection {
  return { eventId: fixtureIdentity(951), revisionId: String(request.revisionId ?? fixtureIdentity(952)), actionId: String(request.actionId),
    unitId: String(request.unitId), locale: String(request.locale), previousEventId: request.expectedSelectionId as string | null ?? null,
    sequence: request.expectedSelectionId ? "2" : "1" };
}
function historyFor(): TranslationHistory {
  return { unitId: item.unitId, locale: item.targetLocale, total: "2", nextOrdinal: null, current: null, currentText: null,
    rows: comparison.rows.map((row, index) => ({ revisionId: row.revisionId, sourceRevisionId: row.sourceRevisionId, sourceSnapshotId: item.sourceSnapshotId,
      unitId: item.unitId, locale: item.targetLocale, ordinal: String(index + 1), text: row.text, originKind: row.originKind, contributors: row.contributors,
      actionId: fixtureIdentity(960 + index), attemptId: null, resultId: null, itemId: null, artifactId: null, logicalPath: null,
      declaredLocale: null, nativeKey: null, fileDigest: null })) };
}
function preparationPayload() { const current = owner.current(); return { kind: "arena-preparation" as const, editSeq: current.editSeq, locale: current.locale, unitIds: [...current.selected] }; }
function startPayload() { const current = owner.current(); return { kind: "arena-start" as const, attemptId: current.prepared!.attemptId, editSeq: current.editSeq }; }
function candidatePayload(): ArenaCandidateCommandPayload {
  const row = view.rows[0], unit = view.detail.recovery.units.find(unit => unit.itemIds.includes(row.itemId))!;
  return { kind: "arena-candidate", attemptId: view.detail.attemptId, taskId: view.detail.taskId, itemId: row.itemId, resultId: row.resultId!, recoveryUnitId: unit.unitId,
    translationUnitId: row.item.unitId, locale: row.item.targetLocale, sourceRevisionId: row.item.sourceRevisionId, sourceSnapshotId: row.item.sourceSnapshotId };
}
function translationPayload(): ArenaTranslationCommandPayload {
  const { resultId: _result, recoveryUnitId: _recovery, ...target } = candidatePayload(); return { ...target, kind: "arena-translation-target" };
}
function comparisonPayload(): ArenaComparisonCommandPayload { return { kind: "arena-comparison", comparisonId: comparison.comparisonId!, unitId: comparison.unitId,
  locale: comparison.locale, sourceRevisionId: comparison.sourceRevisionId, selectionId: comparison.selectionId, basis: comparison.basis }; }
function comparePayload() { const current = owner.current(); return { kind: "arena-compare" as const, unitId: current.unit, locale: current.locale,
  revisionIds: [...current.references], blind: current.comparisonBlind, editSeq: current.editSeq }; }
function mergePayload(): ArenaMergeCommandPayload { const draft = owner.current().draft!; return { kind: "arena-merge-draft", comparisonId: draft.basis.comparisonId,
  unitId: draft.basis.unitId, locale: draft.basis.locale, sourceRevisionId: draft.basis.sourceRevisionId, selectionId: draft.basis.selectionId, basis: draft.basis.basis, editSeq: draft.editSeq }; }
function selectPayload() { return { ...comparisonPayload(), kind: "arena-selection" as const, revisionId: comparison.rows[0].revisionId }; }
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); navigate.mockClear();
  prepared = { attemptId: aiAttempt, preview: { config: defaultArenaConfig(), digest: "digest", items: [{ slot: 0, sourceOrder: 0, item }, { slot: 1, sourceOrder: 0, item }] } };
  view = arenaViewFixture(item, prepared.preview.config);
  comparison = { comparisonId: fixtureIdentity(330), unitId: item.unitId, locale: item.targetLocale, sourceRevisionId: item.sourceRevisionId,
    sourceText: item.sourceText, nativeKey: item.nativeKey, selectionId: fixtureIdentity(320), selectedRevisionId: fixtureIdentity(321), selectedText: "First {name}",
    basis: "basis", blind: true, revealed: false, rows: [321, 322].map((id, index) => ({ revisionId: fixtureIdentity(id), text: `${index ? "Second" : "First"} {name}`,
      sourceRevisionId: item.sourceRevisionId, originKind: "manual", contributors: [], model: null, recipe: null, basisCurrent: true, candidateDisposition: null })) };
  let identity = 910;
  invoke.mockReset(); invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    const request = payload.request;
    if (command === "read_content_scope") return { revision: "2", currentSnapshot: item.sourceSnapshotId };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: item.sourceSnapshotId, scope: { revision: "2", currentSnapshot: item.sourceSnapshotId },
      rows: [sourceRowFixture({ unitId: item.unitId, sourceRevisionId: item.sourceRevisionId }, { key: item.nativeKey, text: item.sourceText })] });
    if (command === "list_arena_comparisons") return [{ comparisonId: comparison.comparisonId, nativeKey: comparison.nativeKey, locale: comparison.locale }];
    if (command === "read_translation_history") return historyFor();
    if (command === "preview_arena_translation") { const config = request.config as ArenaConfig;
      prepared = { ...prepared, preview: { ...prepared.preview, config: { ...config, parentAttemptId: config.parentAttemptId ?? null } } };
      view = arenaViewFixture(item, prepared.preview.config); return prepared; }
    if (command === "start_arena_translation") return aiAttempt;
    if (command === "read_arena_translation") return structuredClone(view);
    if (command === "create_arena_comparison") { comparison = { ...comparison, comparisonId: String(request.actionId), blind: Boolean(request.blind), revealed: !request.blind }; return structuredClone(comparison); }
    if (command === "read_arena_comparison") return structuredClone(comparison);
    if (command === "reveal_arena_identity") { comparison = { ...comparison, revealed: true }; view = { ...view, revealed: true, variants: prepared.preview.config.variants }; return null; }
    if (command === "select_translation_revision" || command === "save_arena_merge") return selectionFor(request);
    if (command === "read_translation_action") return null;
    if (command === "read_arena_comparison_action" || command === "read_arena_merge_action" || command === "read_translation_selection_action") return null;
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "prepare_execution_adoption") { action = actionFor(request as unknown as PrepareRequest); return action; }
    if (command === "adopt_execution" || command === "read_execution_receipt") return receiptFor();
    if (command === "read_execution_cancellation_action") return null;
    if (command === "cancel_execution_task") return "5";
    throw new Error(command);
  });
});
afterEach(cleanup);
async function open() {
  const user = userEvent.setup(), rendered = render(<Harness />, project);
  await user.click(screen.getByRole("button", { name: "Arena comparison" }));
  await screen.findByRole("checkbox", { name: "first: Hello {name}" });
  act(() => owner.setSelected([item.unitId]));
  await waitFor(() => expect(registry.describe("arena.preview", scope, preparationPayload())?.availability.enabled).toBe(true));
  return { user, rendered };
}
async function start() {
  await act(async () => { expect(registry.dispatch("arena.preview", scope, preparationPayload())).toBe(true); });
  await waitFor(() => expect(owner.current().prepared).not.toBeNull()); act(() => owner.setConsent(true));
  await act(async () => { expect(registry.dispatch("arena.start", scope, startPayload())).toBe(true); });
  await waitFor(() => expect(registry.describe("arena.adopt-result", scope, candidatePayload())?.availability.enabled).toBe(true));
}
async function compare() {
  act(() => { owner.setUnit(item.unitId); owner.setReferences(comparison.rows.map(row => row.revisionId)); owner.setComparisonBlind(true); });
  await waitFor(() => expect(registry.describe("arena.create-comparison", scope, comparePayload())?.availability.enabled).toBe(true));
  await act(async () => { expect(registry.dispatch("arena.create-comparison", scope, comparePayload())).toBe(true); });
  await waitFor(() => expect(registry.describe("arena.begin-merge", scope, comparisonPayload())?.availability.enabled).toBe(true));
}

it.each([["compare","en-US"],["compare","zh-CN"],["select","en-US"],["select","zh-CN"],["merge","en-US"],["merge","zh-CN"]] as const)("shows the actual %s checking phase in %s and holds the original Registry reservation",async(kind,language)=>{
  await open();
  if(kind==="compare"){
    act(()=>{owner.setUnit(item.unitId);owner.setReferences(comparison.rows.map(row=>row.revisionId));owner.setComparisonBlind(true);});
    await waitFor(()=>expect(registry.describe("arena.create-comparison",scope,comparePayload())?.availability.enabled).toBe(true));
  }else{
    await compare();if(kind==="merge")act(()=>{expect(registry.dispatch("arena.begin-merge",scope,comparisonPayload())).toBe(true);});
  }
  const commands={compare:"create_arena_comparison",select:"select_translation_revision",merge:"save_arena_merge"};
  const lookups={compare:"read_arena_comparison_action",select:"read_translation_selection_action",merge:"read_arena_merge_action"};
  const original=invoke.getMockImplementation()!,write=deferred<unknown>(),read=deferred<unknown>();
  invoke.mockImplementation((command:string,args:unknown)=>command===commands[kind]?write.promise
    :command===lookups[kind]?read.promise:original(command,args));
  await act(async()=>{expect(kind==="compare"?registry.dispatch("arena.create-comparison",scope,comparePayload())
    :kind==="select"?registry.dispatch("arena.select-candidate",scope,selectPayload()):registry.dispatch("arena.save-merge",scope,mergePayload())).toBe(true);});
  await waitFor(()=>expect(calls(commands[kind])).toHaveLength(1));
  const pending=owner.current().pending;if(!pending||pending.kind==="start"||pending.kind==="adopt"||pending.kind==="reveal")throw new Error("Expected original Arena decision");
  const payload={kind:"arena-pending" as const,pendingKind:pending.kind,actionId:pending.request.actionId,unitId:pending.request.unitId,locale:pending.request.locale};
  await act(async()=>{await i18n.changeLanguage(language);});
  const messages={compare:{"en-US":"Checking the saved comparison…","zh-CN":"正在核对保存的比较…"},
    select:{"en-US":"Checking the saved selection…","zh-CN":"正在核对选择结果…"},merge:{"en-US":"Checking the saved merge…","zh-CN":"正在核对合并结果…"}};
  const message=messages[kind][language];expect(screen.queryByText(message)).not.toBeInTheDocument();
  await act(async()=>{write.resolve({});});await screen.findByText(message);
  expect(owner.current().pending).toMatchObject({kind,checking:true,retryAllowed:false});expect(owner.current().failure).toBeNull();
  act(()=>{expect(registry.dispatch("arena.reconcile-pending",scope,payload)).toBe(false);expect(registry.dispatch("arena.retry-pending",scope,payload)).toBe(false);});
  await act(async()=>{read.resolve(null);});await waitFor(()=>expect(owner.current().busy).toBe(false));
  expect(screen.queryByText(message)).not.toBeInTheDocument();expect(registry.describe("arena.retry-pending",scope,payload)?.availability.enabled).toBe(true);
  expect(registry.dispatch("arena.retry-pending",scope,{...payload,actionId:fixtureIdentity(999)})).toBe(false);
  expect(calls(commands[kind])).toHaveLength(1);expect(payloads(lookups[kind])).toEqual([pending.request]);
});

it.each(["en-US","zh-CN"] as const)("exposes the real Arena start checking phase and gates the exact Registry retry in %s",async language=>{
  await open();prepared={...prepared,preview:{...prepared.preview,digest:"d".repeat(64)}};
  await act(async()=>{expect(registry.dispatch("arena.preview",scope,preparationPayload())).toBe(true);});
  await waitFor(()=>expect(owner.current().prepared).not.toBeNull());act(()=>owner.setConsent(true));
  const original=invoke.getMockImplementation()!,write=deferred<string>(),lookup=deferred<unknown>();
  invoke.mockImplementation((command:string,args:unknown)=>command==="start_arena_translation"?write.promise
    :command==="read_arena_start_action"?lookup.promise:original(command,args));
  await act(async()=>{expect(registry.dispatch("arena.start",scope,startPayload())).toBe(true);});
  const entry=owner.current().pending;if(entry?.kind!=="start")throw new Error("Expected original start");
  const payload={kind:"arena-pending" as const,pendingKind:"start" as const,attemptId:entry.request.attemptId};
  await act(async()=>{await i18n.changeLanguage(language);});
  const message=language==="en-US"?"Checking whether this task was started…":"正在核对此次任务是否已启动…";
  expect(screen.queryByText(message)).not.toBeInTheDocument();
  await act(async()=>{write.resolve(fixtureIdentity(999));});await screen.findByText(message);
  act(()=>{expect(registry.dispatch("arena.reconcile-pending",scope,payload)).toBe(false);expect(registry.dispatch("arena.retry-pending",scope,payload)).toBe(false);});
  await act(async()=>{lookup.resolve(null);});await waitFor(()=>expect(owner.current().busy).toBe(false));
  expect(screen.queryByText(message)).not.toBeInTheDocument();
  expect(registry.describe("arena.retry-pending",scope,payload)?.availability.enabled).toBe(true);
  expect(registry.dispatch("arena.retry-pending",scope,{...payload,attemptId:fixtureIdentity(998)})).toBe(false);
  invoke.mockImplementation((command:string,args:unknown)=>command==="read_arena_start_action"?Promise.resolve({projectId:entry.request.projectId,
    attemptId:entry.request.attemptId,taskId:aiTask,digest:entry.request.digest}):original(command,args));
  await act(async()=>{expect(registry.dispatch("arena.reconcile-pending",scope,payload)).toBe(true);});
  await waitFor(()=>expect(owner.current().pending).toBeNull());
  expect(calls("start_arena_translation")).toHaveLength(1);expect(payloads("read_arena_start_action")).toEqual([entry.request,entry.request]);
});

it("registers scoped Arena commands and routes the visible generation and editor actions", async () => {
  const { user } = await open(), dispatch = vi.spyOn(registry, "dispatch");
  expect(registry.list(scope).filter(command => command.category === "arena").map(command => command.id).sort()).toEqual([
    "arena.adopt-result", "arena.begin-merge", "arena.cancel-task", "arena.check-cancellation", "arena.create-comparison", "arena.discard-merge", "arena.new-round", "arena.open-comparison",
    "arena.open-translation", "arena.preview", "arena.reconcile-pending", "arena.refresh-merge-basis", "arena.retry-cancellation", "arena.retry-pending",
    "arena.reveal-identities", "arena.save-merge", "arena.select-candidate", "arena.start",
  ]);
  expect(registry.list(scope).filter(command => command.category === "arena").every(command => command.binding === null)).toBe(true);
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  await screen.findByRole("checkbox", { name: /I confirm sending the shown/ });
  expect(registry.describe("arena.start", scope, startPayload())?.confirmation).toBe("required");
  expect(registry.dispatch("arena.start", scope, startPayload())).toBe(false);
  await user.click(screen.getByRole("checkbox", { name: /I confirm sending the shown/ }));
  await user.click(screen.getByRole("button", { name: "Send and generate candidates" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Compare and select in editor" })).toBeEnabled());
  expect(registry.dispatch("arena.open-translation", scope, { ...translationPayload(), sourceSnapshotId: fixtureIdentity(999) })).toBe(false);
  await user.click(screen.getByRole("button", { name: "Compare and select in editor" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, key: item.nativeKey, sourceText: item.sourceText }, item.targetLocale));
  expect(dispatch.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(["arena.preview", "arena.start", "arena.open-translation"]));
});

it("keeps comparison order, blind capture, merge A/B and explicit basis recovery in the original owner", async () => {
  const { user } = await open(), dispatch = vi.spyOn(registry, "dispatch"); await compare();
  expect(payloads("create_arena_comparison")[0]).toMatchObject({ revisionIds: [fixtureIdentity(321), fixtureIdentity(322)], blind: true });
  expect(registry.dispatch("arena.select-candidate", scope, { ...selectPayload(), basis: "other" })).toBe(false);
  await user.click(screen.getByRole("button", { name: "Reveal candidate identities" }));
  await waitFor(() => expect(owner.current().busy).toBe(false));
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit a manual merge" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Edit a manual merge" }));
  const wrong = { ...mergePayload(), editSeq: mergePayload().editSeq + 1 };
  expect(registry.dispatch("arena.discard-merge", scope, wrong)).toBe(false);
  const save = deferred<TranslationSelection>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: Record<string, unknown> }) => command === "save_arena_merge" ? save.promise : original(command, payload));
  await user.click(screen.getByRole("button", { name: "Save merge and select" }));
  await waitFor(() => expect(calls("save_arena_merge")).toHaveLength(1));
  const request = payloads("save_arena_merge")[0]; act(() => owner.editMerge("Newer B"));
  await act(async () => { save.resolve(selectionFor(request)); });
  await waitFor(() => expect(owner.current().pending).toBeNull());
  expect(owner.current().draft?.text).toBe("Newer B");
  comparison = { ...comparison, basis: "changed-basis", selectionId: fixtureIdentity(999) };
  await user.click(screen.getByRole("button", { name: "Review current basis and keep draft" }));
  await waitFor(() => expect(owner.current().draft?.basis.basis).toBe("changed-basis"));
  expect(owner.current().draft?.text).toBe("Newer B");
  await user.click(screen.getByRole("button", { name: "Discard merge draft" }));
  expect(owner.current().draft).toBeNull();
  expect(dispatch.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(["arena.create-comparison", "arena.reveal-identities", "arena.begin-merge", "arena.save-merge", "arena.refresh-merge-basis", "arena.discard-merge"]));
});

it("reopens only the listed exact comparison and routes selection and a new round without automatic consent", async () => {
  const { user } = await open(), dispatch = vi.spyOn(registry, "dispatch");
  await waitFor(() => expect(screen.getByRole("button", { name: /Reopen comparison: first/ })).toBeEnabled());
  const summary = { kind: "arena-open-comparison" as const, comparisonId: comparison.comparisonId!, nativeKey: comparison.nativeKey, locale: comparison.locale };
  expect(registry.dispatch("arena.open-comparison", scope, { ...summary, comparisonId: fixtureIdentity(999) })).toBe(false);
  await act(async () => { expect(registry.dispatch("arena.open-comparison", scope, summary)).toBe(true); });
  await waitFor(() => expect(registry.describe("arena.select-candidate", scope, selectPayload())?.availability.enabled).toBe(true));
  await user.click(screen.getAllByRole("button", { name: "Use this translation" })[0]);
  await waitFor(() => expect(calls("select_translation_revision")).toHaveLength(1));
  await waitFor(() => expect(owner.current().busy).toBe(false));
  await start();
  await user.click(screen.getByRole("button", { name: "Prepare a new round" }));
  await waitFor(() => expect(owner.current().attempt).toBeNull());
  expect(owner.current().config.parentAttemptId).toBe(aiAttempt);
  expect(owner.current().selected).toEqual([item.unitId]); expect(owner.current().consent).toBe(false); expect(owner.current().prepared).toBeNull();
  expect(dispatch.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(["arena.open-comparison", "arena.select-candidate", "arena.new-round"]));
});

it("blocks fresh source and candidate actions for loading, errors, invalidation and wrong exact identities", async () => {
  await open(); const scopeKey = reads.key(["arena-source-scope", owner.current().sourceGeneration]);
  const source = reads.client.getQueryCache().find({ queryKey: scopeKey, exact: true })!;
  act(() => source.setState({ fetchStatus: "fetching" }));
  expect(registry.describe("arena.preview", scope, preparationPayload())?.availability.enabled).toBe(false);
  expect(registry.dispatch("arena.preview", scope, preparationPayload())).toBe(false);
  act(() => source.setState({ fetchStatus: "idle", status: "success", error: null })); await start();
  const key = reads.key(["arena", aiAttempt]), query = reads.client.getQueryCache().find({ queryKey: key, exact: true })!;
  expect(registry.dispatch("arena.adopt-result", scope, { ...candidatePayload(), recoveryUnitId: fixtureIdentity(999) })).toBe(false);
  expect(registry.dispatch("arena.adopt-result", scope, { ...candidatePayload(), taskId: fixtureIdentity(999) })).toBe(false);
  expect(registry.dispatch("arena.adopt-result", { ...scope, sessionToken: "old" }, candidatePayload())).toBe(false);
  act(() => query.setState({ status: "error", error: new Error("Current read failed") }));
  expect(registry.describe("arena.adopt-result", scope, candidatePayload())?.availability.enabled).toBe(false);
  expect(registry.dispatch("arena.adopt-result", scope, candidatePayload())).toBe(false);
  act(() => query.setState({ status: "success", error: null, isInvalidated: true }));
  expect(registry.dispatch("arena.adopt-result", scope, candidatePayload())).toBe(false); expect(calls("prepare_execution_adoption")).toHaveLength(0);
});

it("keeps exact known Task cancellation available while a real read refetch is deferred", async () => {
  const { user } = await open(); await start();
  const runningItem = view.rows[0].itemId;
  view = { ...view, rows: view.rows.map(row => row.itemId === runningItem ? { ...row, resultId: null, output: null } : row),
    detail: { ...view.detail, progress: { ...view.detail.progress, running: 1, succeeded: 1 },
      items: view.detail.items.map(detail => detail.status.itemId === runningItem ? { ...detail, resultId: null, status: { ...detail.status, execution: "dispatched", validation: "absent" } } : detail),
      recovery: { ...view.detail.recovery, units: view.detail.recovery.units.map(unit => unit.itemIds.includes(runningItem) ? { ...unit, resultIds: [] } : unit) } } };
  act(() => reads.client.setQueryData(reads.key(["arena", aiAttempt]), structuredClone(view)));
  await screen.findByRole("button", { name: "Cancel remaining work" });
  const response = deferred<ArenaView>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_arena_translation" ? response.promise : original(command, payload));
  let refetch!: Promise<void>; act(() => { refetch = reads.client.refetchQueries({ queryKey: reads.key(["arena", aiAttempt]), exact: true }); });
  const payload = { kind: "execution-cancellation" as const, taskId: aiTask, attemptId: aiAttempt, origin: "arena" as const };
  expect(reads.client.getQueryState(reads.key(["arena", aiAttempt]))?.fetchStatus).toBe("fetching");
  expect(registry.describe("arena.cancel-task", scope, payload)?.availability.enabled).toBe(true);
  expect(screen.getByRole("button", { name: "Cancel remaining work" })).toBeEnabled();
  expect(registry.dispatch("arena.cancel-task", scope, { ...payload, taskId: fixtureIdentity(999) })).toBe(false);
  expect(registry.dispatch("arena.cancel-task", scope, { ...payload, attemptId: fixtureIdentity(999) })).toBe(false);
  await user.click(screen.getByRole("button", { name: "Cancel remaining work" }));
  await waitFor(() => expect(calls("cancel_execution_task")).toHaveLength(1));
  expect(payloads("cancel_execution_task")[0]).toMatchObject({ taskId: aiTask });
  expect(tasks.current(aiTask)?.target).toEqual({ taskId: aiTask, attemptId: aiAttempt, origin: "arena" });
  await act(async () => { response.resolve(view); await refetch; });
});

it("restores the preview button with the target language and keeps configuration validation in the existing capture feedback", async () => {
  const { rendered } = await open();
  const removed = { ...project, metadata: { ...project.metadata, targetLocales: [] } };
  rendered.rerender(<Harness project={removed} />, removed);
  expect(screen.getByRole("button", { name: "Preview what will be sent" })).toBeDisabled();
  rendered.rerender(<Harness project={project} />, project);
  await waitFor(() => expect(screen.getByRole("button", { name: "Preview what will be sent" })).toBeEnabled());
  expect(registry.describe("arena.preview", scope, preparationPayload())?.availability.enabled).toBe(true);
  act(() => owner.setConfig({ ...owner.current().config, maxRequests: 0 }));
  expect(registry.dispatch("arena.preview", scope, preparationPayload())).toBe(true);
  await waitFor(() => expect(owner.current().failure).not.toBeNull()); expect(owner.current().prepared).toBeNull();
});

it("reserves adoption synchronously and keeps a captured operation through full consumer unmount and pure eviction", async () => {
  const { rendered } = await open(); await start();
  const response = deferred<string>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? response.promise : original(command, payload));
  const payload = candidatePayload();
  act(() => { expect(registry.dispatch("arena.adopt-result", scope, payload)).toBe(true); expect(registry.dispatch("arena.adopt-result", scope, payload)).toBe(false); });
  rendered.rerender(<Harness mounted={false} />);
  act(() => reads.client.removeQueries({ queryKey: reads.key(["arena", aiAttempt]), exact: true }));
  expect(registry.describe("arena.adopt-result", scope, payload)).toBeUndefined();
  await act(async () => { response.resolve(fixtureIdentity(990)); });
  await waitFor(() => expect(owner.current().saved[payload.resultId]).toBeDefined());
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("adopt_execution")).toHaveLength(1);
  const previousReads = calls("read_arena_translation").length;
  rendered.rerender(<Harness project={project} />, project);
  await waitFor(() => expect(calls("read_arena_translation").length).toBeGreaterThan(previousReads));
  await waitFor(() => expect(reads.client.getQueryState(reads.key(["arena", aiAttempt]))?.status).toBe("success"));
  expect(owner.current().saved[payload.resultId]).toEqual(receiptFor());
  expect(await screen.findByRole("button", { name: "Candidate saved" })).toBeDisabled();
});

it.each(["error", "contradiction"] as const)("rejects a removed replacement comparison %s after identity and releases its flight witness", async failure => {
  const { rendered } = await open(); await compare();
  const response = deferred<string>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? response.promise : original(command, payload));
  const originalWatch = reads.watchExactQuery.bind(reads), watch = vi.spyOn(reads, "watchExactQuery"), dispose = vi.fn();
  watch.mockImplementation(key => { const witness = originalWatch(key); return { current: witness.current, dispose: () => { dispose(); witness.dispose(); } }; });
  act(() => { expect(registry.dispatch("arena.select-candidate", scope, selectPayload())).toBe(true); });
  rendered.rerender(<Harness mounted={false} />);
  const key = reads.key(["arena-comparison", comparison.comparisonId]);
  act(() => {
    reads.client.removeQueries({ queryKey: key, exact: true });
    reads.client.setQueryData(key, failure === "contradiction" ? { ...comparison, basis: "changed" } : comparison);
    if (failure === "error") reads.client.getQueryCache().find({ queryKey: key, exact: true })!.setState({ status: "error", error: new Error("Replacement failed") });
    reads.client.removeQueries({ queryKey: key, exact: true });
  });
  await act(async () => { response.resolve(fixtureIdentity(990)); });
  await waitFor(() => expect(owner.current().busy).toBe(false));
  expect(calls("select_translation_revision")).toHaveLength(0); expect(owner.current().pending).toBeNull(); expect(dispose).toHaveBeenCalledTimes(1);
});

it("refuses adoption after a failed replacement is removed during prepare and preserves its exact uncertain request", async () => {
  const { rendered } = await open(); await start();
  const response = deferred<AdoptionAction>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "prepare_execution_adoption" ? response.promise : original(command, payload));
  act(() => { expect(registry.dispatch("arena.adopt-result", scope, candidatePayload())).toBe(true); });
  await waitFor(() => expect(calls("prepare_execution_adoption")).toHaveLength(1));
  const request = payloads("prepare_execution_adoption")[0] as PrepareRequest;
  rendered.rerender(<Harness mounted={false} />);
  const key = reads.key(["arena", aiAttempt]);
  act(() => { reads.client.removeQueries({ queryKey: key, exact: true }); reads.client.setQueryData(key, structuredClone(view));
    reads.client.getQueryCache().find({ queryKey: key, exact: true })!.setState({ status: "error", error: new Error("New read failed") });
    reads.client.removeQueries({ queryKey: key, exact: true }); });
  await act(async () => { response.resolve(actionFor(request)); });
  await waitFor(() => expect(owner.current().busy).toBe(false));
  expect(calls("adopt_execution")).toHaveLength(0); expect(owner.current().pending).toMatchObject({ kind: "adopt", request, action: actionFor(request), uncertain: true, retryAllowed: false });
});

it("recovers an unknown merge using its original request despite changed source, locale, Query and newer text", async () => {
  const { rendered } = await open(); await compare(); act(() => { expect(registry.dispatch("arena.begin-merge", scope, comparisonPayload())).toBe(true); });
  const original = invoke.getMockImplementation()!; let first = true,lookups=0;
  invoke.mockImplementation((command: string, payload: unknown) => command === "save_arena_merge" && first ? (first = false, Promise.reject({ code: "outcome-unknown" }))
    :command==="read_arena_merge_action"&&++lookups===1?Promise.reject(new Error("Automatic lookup unavailable")):original(command, payload));
  act(() => { expect(registry.dispatch("arena.save-merge", scope, mergePayload())).toBe(true); });
  await waitFor(() => expect(owner.current().busy).toBe(false));expect(owner.current().pending?.uncertain).toBe(true);
  const request = payloads("save_arena_merge")[0], identities = calls("create_execution_identity").length;
  act(() => { owner.editMerge("Newer B"); reads.invalidate(["source", "resources"]); });
  const removed = { ...project, metadata: { ...project.metadata, targetLocales: [] } }; rendered.rerender(<Harness project={removed} />, removed);
  const payload = { kind: "arena-pending" as const, pendingKind: "merge" as const, actionId: request.actionId as string, unitId: request.unitId as string, locale: request.locale as string };
  expect(registry.dispatch("arena.retry-pending", scope, payload)).toBe(false);
  expect(registry.dispatch("arena.reconcile-pending", scope, { ...payload, actionId: fixtureIdentity(999) })).toBe(false);
  await act(async () => { expect(registry.dispatch("arena.reconcile-pending", scope, payload)).toBe(true); });
  await waitFor(() => expect(owner.current().pending?.retryAllowed).toBe(true));
  await act(async () => { expect(registry.dispatch("arena.retry-pending", scope, payload)).toBe(true); });
  await waitFor(() => expect(owner.current().pending).toBeNull());
  expect(payloads("save_arena_merge")).toEqual([request, request]); expect(calls("create_execution_identity")).toHaveLength(identities);
  expect(owner.current().draft?.text).toBe("Newer B");
});

it("bridges cancellation feedback using the original cross-origin request and refuses an unrelated replay", async () => {
  const { user } = await open(); await start(); const original = invoke.getMockImplementation()!;
  let lookups=0;
  invoke.mockImplementation((command: string, payload: unknown) => command === "cancel_execution_task" ? Promise.reject({ code: "outcome-unknown" })
    :command==="read_execution_cancellation_action"?++lookups===1?Promise.reject(new Error("Automatic lookup unavailable")):Promise.resolve(null):original(command, payload));
  await act(async () => { await tasks.cancel({ taskId: aiTask, attemptId: aiAttempt, origin: "tasks" }); });
  const entry = tasks.current(aiTask)!;
  expect(entry.phase).toBe("unknown");
  if (entry.phase !== "unknown") throw new Error("The original cancellation must remain unknown");
  const payload = { kind: "execution-cancellation-retry" as const, ...entry.target, requestId: entry.request.requestId };
  expect(payload.origin).toBe("tasks");
  expect(registry.dispatch("arena.retry-cancellation",scope,payload)).toBe(false);
  expect(registry.dispatch("arena.check-cancellation",scope,{...payload,attemptId:fixtureIdentity(998)})).toBe(false);
  const checkDispatch=vi.spyOn(registry,"dispatch");
  await user.click(screen.getByRole("button",{name:i18n.t("execution.checkCancellation")}));
  await waitFor(()=>expect(tasks.current(aiTask)).toMatchObject({phase:"unknown",retryAllowed:true}));
  expect(checkDispatch).toHaveBeenCalledWith("arena.check-cancellation",scope,payload);expect(calls("cancel_execution_task")).toHaveLength(1);
  expect(registry.dispatch("arena.retry-cancellation", scope, { ...payload, requestId: fixtureIdentity(999) })).toBe(false);
  const dispatch = vi.spyOn(registry, "dispatch");
  invoke.mockImplementation((command: string, args: unknown) => command === "cancel_execution_task" ? Promise.resolve("5") : original(command, args));
  await user.click(await screen.findByRole("button", { name: "Retry the original cancellation" }));
  await waitFor(() => expect(tasks.current(aiTask)?.phase).toBe("recorded"));
  expect(dispatch).toHaveBeenCalledWith("arena.retry-cancellation", scope, payload);
  expect(payloads("cancel_execution_task")[0]).toEqual(payloads("cancel_execution_task")[1]);
});

it("does not dispatch late selection after retirement and releases the temporary exact witness", async () => {
  await open(); await compare();
  const response = deferred<string>(), original = invoke.getMockImplementation()!, originalWatch = reads.watchExactQuery.bind(reads), watch = vi.spyOn(reads, "watchExactQuery"), dispose = vi.fn();
  watch.mockImplementation(key => { const witness = originalWatch(key); return { current: witness.current, dispose: () => { dispose(); witness.dispose(); } }; });
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? response.promise : original(command, payload));
  act(() => { expect(registry.dispatch("arena.select-candidate", scope, selectPayload())).toBe(true); reads.retire(); });
  await act(async () => { response.resolve(fixtureIdentity(990)); });
  expect(calls("select_translation_revision")).toHaveLength(0); expect(dispose).toHaveBeenCalledTimes(1);
});

it("blocks every fresh comparison write on failed or invalidated reads while preserving explicit draft recovery", async () => {
  await open(); await compare();
  const key = reads.key(["arena-comparison", comparison.comparisonId]), query = reads.client.getQueryCache().find({ queryKey: key, exact: true })!;
  act(() => query.setState({ status: "error", error: new Error("Current comparison failed") }));
  expect(registry.dispatch("arena.select-candidate", scope, selectPayload())).toBe(false);
  expect(registry.dispatch("arena.begin-merge", scope, comparisonPayload())).toBe(false);
  expect(registry.dispatch("arena.reveal-identities", scope, { kind: "arena-reveal", targetKind: "comparison", targetId: comparison.comparisonId! })).toBe(false);
  act(() => query.setState({ status: "success", error: null, isInvalidated: false, fetchStatus: "idle" }));
  act(() => { expect(registry.dispatch("arena.begin-merge", scope, comparisonPayload())).toBe(true); });
  const original = mergePayload();
  act(() => query.invalidate());
  expect(registry.describe("arena.save-merge", scope, original)?.availability.enabled).toBe(false);
  expect(registry.dispatch("arena.save-merge", scope, original)).toBe(false);
  expect(registry.describe("arena.refresh-merge-basis", scope, original)?.availability.enabled).toBe(true);
  expect(registry.describe("arena.discard-merge", scope, original)?.availability.enabled).toBe(true);
  expect(registry.dispatch("arena.refresh-merge-basis", scope, { ...original, comparisonId: fixtureIdentity(999) })).toBe(false);
  expect(owner.current().draft?.text).toBe("First {name}"); expect(calls("save_arena_merge")).toHaveLength(0);
});

it("keeps a merge's captured contributors and text across consumer eviction during identity", async () => {
  const { rendered } = await open(); await compare();
  act(() => { expect(registry.dispatch("arena.begin-merge", scope, comparisonPayload())).toBe(true); owner.editMerge("Captured A"); });
  const response = deferred<string>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? response.promise : original(command, payload));
  const payload = mergePayload(); act(() => { expect(registry.dispatch("arena.save-merge", scope, payload)).toBe(true); });
  rendered.rerender(<Harness mounted={false} />);
  act(() => reads.client.removeQueries({ queryKey: reads.key(["arena-comparison", comparison.comparisonId]), exact: true }));
  await act(async () => { response.resolve(fixtureIdentity(990)); });
  await waitFor(() => expect(calls("save_arena_merge")).toHaveLength(1));
  expect(payloads("save_arena_merge")[0]).toMatchObject({ actionId: fixtureIdentity(990), text: "Captured A", expectedSelectionId: comparison.selectionId,
    merge: { expectedBasis: comparison.basis, contributors: comparison.rows.map(row => row.revisionId) } });
  await waitFor(() => expect(owner.current().draft).toBeNull());
});

it("retains newer setup when a new-round read returns late and prevents dirty-navigation reset after an unrelated basis change", async () => {
  const { user } = await open(); await start();
  const response = deferred<ArenaView>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_arena_translation" ? response.promise : original(command, payload));
  const payload = { kind: "arena-round" as const, attemptId: aiAttempt, taskId: aiTask, editSeq: owner.current().editSeq };
  act(() => { expect(registry.dispatch("arena.new-round", scope, payload)).toBe(true); owner.setConfig({ ...owner.current().config, maxRequests: 90 }); });
  await act(async () => { response.resolve(view); });
  await waitFor(() => expect(owner.current().busy).toBe(false));
  expect(owner.current().attempt).toBe(aiAttempt); expect(owner.current().config.maxRequests).toBe(90);
  await waitFor(() => expect(screen.getByRole("button", { name: "Compare and select in editor" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Compare and select in editor" })); await screen.findByText("Keep your Arena draft?");
  act(() => owner.setConfig({ ...owner.current().config, maxRequests: 95 }));
  await user.click(screen.getByRole("button", { name: "Discard draft and leave" }));
  expect(owner.current().config.maxRequests).toBe(95); expect(owner.current().dirty).toBe(true); expect(navigate).not.toHaveBeenCalled();
});

it("does not send an older prepared snapshot when the current checked source scope has changed", async () => {
  await open();
  await act(async () => { expect(registry.dispatch("arena.preview", scope, preparationPayload())).toBe(true); });
  await waitFor(() => expect(owner.current().prepared).not.toBeNull()); act(() => owner.setConsent(true));
  const fixedPreview = owner.current().prepared;
  act(() => reads.client.setQueryData(reads.key(["arena-source-scope", owner.current().sourceGeneration]), { revision: "3", currentSnapshot: fixtureIdentity(999) }));
  expect(registry.describe("arena.start", scope, startPayload())?.availability.enabled).toBe(false);
  expect(registry.dispatch("arena.start", scope, startPayload())).toBe(false);
  expect(owner.current().prepared).toBe(fixedPreview); expect(owner.current().consent).toBe(true); expect(calls("start_arena_translation")).toHaveLength(0);
  expect(await screen.findByText("The source or shared resources changed. Preview the complete selected range again before sending a new round.")).toBeInTheDocument();
});

it("keeps the exact ordered history evidence for comparison across an identity wait", async () => {
  const { rendered } = await open();
  act(() => { owner.setUnit(item.unitId); owner.setReferences(comparison.rows.map(row => row.revisionId)); owner.setComparisonBlind(true); });
  await waitFor(() => expect(registry.describe("arena.create-comparison", scope, comparePayload())?.availability.enabled).toBe(true));
  const response = deferred<string>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? response.promise : original(command, payload));
  act(() => { expect(registry.dispatch("arena.create-comparison", scope, comparePayload())).toBe(true); });
  rendered.rerender(<Harness mounted={false} />);
  const current = owner.current(), key = reads.key(["arena-history", current.unit, current.locale, current.sourceGeneration]), history = historyFor();
  act(() => {
    reads.client.removeQueries({ queryKey: key, exact: true });
    reads.client.setQueryData(key, { pages: [{ ...history, rows: history.rows.map((row, index) => index ? row : { ...row, text: "Contradictory revision" }) }], pageParams: [{ cursor: "0" }] });
    reads.client.removeQueries({ queryKey: key, exact: true });
  });
  await act(async () => { response.resolve(fixtureIdentity(990)); });
  await waitFor(() => expect(owner.current().busy).toBe(false));
  expect(calls("create_arena_comparison")).toHaveLength(0); expect(owner.current().references).toEqual(comparison.rows.map(row => row.revisionId));
});

it("keeps cancellation of the original checked Task available after a real background read failure", async () => {
  const { user } = await open(), original = invoke.getMockImplementation()!;
  let failRead = false;
  invoke.mockImplementation((command: string, payload: unknown) => {
    if (command !== "read_arena_translation") return original(command, payload);
    if (failRead) return Promise.reject(new Error("Background result read failed"));
    const runningItem = view.rows[1].itemId;
    view = { ...view, rows: view.rows.map(row => row.itemId === runningItem ? { ...row, resultId: null, output: null } : row),
      detail: { ...view.detail, progress: { ...view.detail.progress, running: 1, succeeded: 1 },
        items: view.detail.items.map(detail => detail.status.itemId === runningItem ? { ...detail, resultId: null,
          status: { ...detail.status, execution: "dispatched", validation: "absent" } } : detail),
        recovery: { ...view.detail.recovery, units: view.detail.recovery.units.map(unit => unit.itemIds.includes(runningItem) ? { ...unit, resultIds: [] } : unit) } } };
    return Promise.resolve(structuredClone(view));
  });
  await start();
  const button = await screen.findByRole("button", { name: "Cancel remaining work" });
  await waitFor(() => expect(button).toBeEnabled());
  const payload = { kind: "execution-cancellation" as const, taskId: aiTask, attemptId: aiAttempt, origin: "arena" as const };
  expect(owner.current().started?.taskId).toBe(aiTask);
  failRead = true;
  await act(async () => { await reads.client.refetchQueries({ queryKey: reads.key(["arena", aiAttempt]), exact: true }); });
  const state = reads.client.getQueryState<ArenaView>(reads.key(["arena", aiAttempt]));
  expect(state?.status).toBe("error"); expect(state?.error).not.toBeNull();
  expect(state?.data?.detail.taskId).toBe(aiTask); expect(state?.data?.detail.attemptId).toBe(aiAttempt);
  expect(owner.current().started?.taskId).toBe(aiTask); expect(owner.current().attempt).toBe(aiAttempt);
  expect(screen.getByRole("button", { name: "Cancel remaining work" })).toBeEnabled();
  expect(registry.describe("arena.cancel-task", scope, payload)?.availability.enabled).toBe(true);
  expect(registry.dispatch("arena.cancel-task", scope, { ...payload, taskId: fixtureIdentity(999) })).toBe(false);
  expect(registry.dispatch("arena.cancel-task", scope, { ...payload, attemptId: fixtureIdentity(999) })).toBe(false);
  const dispatch = vi.spyOn(registry, "dispatch");
  await user.click(screen.getByRole("button", { name: "Cancel remaining work" }));
  await waitFor(() => expect(calls("cancel_execution_task")).toHaveLength(1));
  expect(dispatch).toHaveBeenCalledWith("arena.cancel-task", scope, payload);
  expect(tasks.current(aiTask)?.target).toEqual({ taskId: aiTask, attemptId: aiAttempt, origin: "arena" });
  expect(payloads("cancel_execution_task")[0]).toMatchObject({ ...reads.context, taskId: aiTask });
});

it("shows rejection in a blind comparison and enables direct use only after a restored read",async()=>{
  await open();comparison={...comparison,selectedRevisionId:comparison.rows[1].revisionId,selectedText:comparison.rows[1].text,rows:comparison.rows.map((row,index)=>({...row,originKind:index===0?"ai" as const:"manual" as const,candidateDisposition:index===0?"rejected" as const:null}))};
  await compare();
  await screen.findByText(i18n.t("candidateDecisions.rejected"));
  const useButtons=screen.getAllByRole("button",{name:i18n.t("arena.use")});expect(useButtons[0]).toBeDisabled();
  expect(screen.getByText(comparison.rows[0].text,{selector:"pre"})).toBeVisible();
  expect(registry.dispatch("arena.select-candidate",scope,selectPayload())).toBe(false);expect(calls("select_translation_revision")).toHaveLength(0);
  comparison={...comparison,rows:comparison.rows.map((row,index)=>({...row,candidateDisposition:index===0?"restored" as const:null}))};
  act(()=>reads.invalidate(["translation"]));
  await screen.findByText(i18n.t("candidateDecisions.restored"));await waitFor(()=>expect(screen.getAllByRole("button",{name:i18n.t("arena.use")})[0]).toBeEnabled());
  expect(calls("reveal_arena_identity")).toHaveLength(0);expect(comparison.revealed).toBe(false);
});
