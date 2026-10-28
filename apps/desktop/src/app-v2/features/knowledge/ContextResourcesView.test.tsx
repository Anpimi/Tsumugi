import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import reviewWire from "../../../../test/fixtures/reviewCommands.contract.json";
import segmentWire from "../../../../test/fixtures/segmentCommands.contract.json";
import { i18n } from "../../../i18n";
import type { knowledgeEn } from "../../../i18n/knowledge";
import { executionContext } from "../../../executionCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { TranslationDraftSession } from "../../../TranslationDraftSession";
import { ExecutionTaskSession } from "../../../ExecutionTaskSession";
import type { ProjectView } from "../../../projectCommands";
import type { ContextResourceAction, ContextResourceRevision, ImpactPage, SaveContextResource, WithdrawContextResource } from "../../../resourceCommands";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { sourceContentFixture } from "../../../testSupport/sourceFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { makeWorkspaceView, type ViewPatch } from "../../workspace/workspaceStore";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import KnowledgeOwnerHost from "./KnowledgeOwnerHost";
import KnowledgeView from "./KnowledgeView";
import ContextResourceDetails from "./ContextResourceDetails";
import type { KnowledgeOwner } from "./knowledgeTypes";
import { Button } from "../../../design-system/Button";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
type MessageKey = { [Key in keyof typeof knowledgeEn]: typeof knowledgeEn[Key] extends string ? Key : never }[keyof typeof knowledgeEn];
const k = (key: MessageKey) => i18n.t(`knowledge.${key}`);
const project: ProjectView = { sessionToken: "synthetic-context-resources", locator: "/synthetic/context-resources", reconciliationState: "settled",
  metadata: { projectId: reviewWire.requests.target.projectId, displayName: "Context resources", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let reads: SessionReads, gate: InteractionGate, lifecycle: ProjectLifecycle, owner: KnowledgeOwner | null;
let source = { revision: "1", currentSnapshot: reviewWire.responses.editor.target.sourceSnapshotId };
let resources: Map<string, ContextResourceRevision>, history: ContextResourceRevision[], receipts: Map<string, { request: ContextResourceAction; receipt: ContextResourceRevision }>;
let save: (request: SaveContextResource) => Promise<ContextResourceRevision>, serial: number, impacts: ImpactPage;
const failed = (reason: string) => ({ code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason, diagnosticId: fixtureIdentity(78000) });
function apply(request: SaveContextResource): ContextResourceRevision {
  const prior = request.contextId ? resources.get(request.contextId) : undefined;
  if (JSON.stringify(source) !== JSON.stringify(request.sourceBasis)) throw failed("context-resource-source");
  if ((prior?.revisionId ?? null) !== (request.expectedRevisionId ?? null)) throw failed("context-resource-current");
  const contextId = request.contextId ?? fixtureIdentity(++serial);
  const revision: ContextResourceRevision = { projectId: request.projectId, actionId: request.actionId, kind: request.kind, locale: request.locale,
    name: request.name, text: request.text, actor: request.actor, reason: request.reason, scope: structuredClone(request.scope),
    sourceBasis: { revision: request.sourceBasis.revision, currentSnapshot: request.sourceBasis.currentSnapshot ?? null },
    contextId, subjectId: request.subjectId ?? prior?.subjectId ?? contextId,
    revisionId: fixtureIdentity(++serial), previousRevisionId: request.expectedRevisionId ?? null, withdrawn: false };
  resources.set(contextId, revision); history.push(revision); receipts.set(request.actionId, { request: { kind: "save", request: structuredClone(request) }, receipt: structuredClone(revision) }); return revision;
}
function stop(request: WithdrawContextResource): ContextResourceRevision {
  const prior = resources.get(request.contextId);
  if (!prior || prior.revisionId !== request.expectedRevisionId) throw failed("context-resource-current");
  const revision: ContextResourceRevision = { ...prior, actionId: request.actionId, actor: request.actor, reason: request.reason,
    previousRevisionId: prior.revisionId, revisionId: fixtureIdentity(++serial), withdrawn: true };
  resources.set(prior.contextId, revision); history.push(revision); receipts.set(request.actionId, { request: { kind: "withdraw", request: structuredClone(request) }, receipt: structuredClone(revision) }); return revision;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); source = { revision: "1", currentSnapshot: reviewWire.responses.editor.target.sourceSnapshotId };
  reads = new SessionReads(executionContext(project)); gate = new InteractionGate(); gate.setVisibleOwner("context-view"); owner = null;
  resources = new Map(); history = []; receipts = new Map(); serial = 77000; save = async request => apply(request);
  impacts = { coverage: "current-selections", items: [], nextOffset: null, totalAffected: 0 };
  lifecycle = new ProjectLifecycle({ open: async () => project, createReads: () => reads, close: async () => ({ closed: true }), status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  await lifecycle.open(project.locator);
  invoke.mockReset(); invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    const request = payload.request;
    if (command === "read_content_scope") return structuredClone(source);
    if (command === "read_source_content") {
      const page = sourceContentFixture(source.currentSnapshot, source);
      page.coverage = ["data/😀.json", "data/\uE000.json"].map((path, index) => ({ ...page.coverage[0], artifactId: index === 0 ? page.coverage[0].artifactId : fixtureIdentity(76001), logicalPath: path })); return page;
    }
    if (command === "read_context_resource_page" || command === "read_context_resource_history") {
      const rows = command.endsWith("history") ? history.filter(value => value.contextId === request.contextId) : [...resources.values()].filter(value => value.locale === request.locale && (request.kind === null || value.kind === request.kind));
      return { basis: `resources-${history.length}`, rows: structuredClone(rows.slice(Number(request.offset), Number(request.offset) + Number(request.limit))), nextOffset: null };
    }
    if (command === "read_context_resource_current") return structuredClone(resources.get(String(request.contextId)) ?? null);
    if (command === "read_review_editor_snapshot") return structuredClone(reviewWire.responses.editor);
    if (command === "read_segment_page") return structuredClone(segmentWire.responses.segmentPage);
    if (command === "resource_impacts") return structuredClone(impacts);
    if (command === "create_execution_identity") return fixtureIdentity(++serial);
    if (command === "save_context_resource") return save(request.resource as SaveContextResource);
    if (command === "withdraw_context_resource") return stop(request.resource as WithdrawContextResource);
    if (command === "read_context_resource_action") return structuredClone(receipts.get(String(request.actionId)) ?? null);
    if (command === "reconcile_context_resource_action") {
      const action = request.action as ContextResourceAction, receipt = receipts.get(action.request.actionId);
      return { request: structuredClone(action), status: receipt ? "recorded" : "retry-allowed", receipt: receipt?.receipt ?? null };
    }
    if (command === "read_terms" || command === "list_resource_captures") return [];
    throw new Error(`Unexpected synthetic resource command: ${command}`);
  });
});
afterEach(() => { cleanup(); lifecycle.dispose(); reads.retire(); gate.dispose(); });
function Shell() {
  const [value, setValue] = useState<KnowledgeOwner | null>(null), [detail, setDetail] = useState(false), [hidden, setHidden] = useState(false);
  const [view, setView] = useState(() => makeWorkspaceView({ kind: "knowledge", locale: "zh-CN", preset: "characters" }, "context-view"));
  const publish = useCallback((next: KnowledgeOwner | null) => { owner = next; setValue(next); }, []), reveal = useCallback(() => setHidden(false), []);
  const current = (dialogId?: string) => gate.canDispatch({ viewId: view.id, source: "button", dialogId });
  return <><KnowledgeOwnerHost project={project} lifecycle={lifecycle} onOwner={publish} onReveal={reveal}/><Button onClick={() => setHidden(value => !value)}>{hidden ? "Return to knowledge" : "Another tab"}</Button>
    {value && !hidden ? <><KnowledgeView project={project} owner={value} view={view} disabled={false} gate={gate} current={current} patch={(patch: ViewPatch) => setView(value => ({ ...value, ...patch }))} onDetails={() => setDetail(true)}/>
      {detail ? <ContextResourceDetails project={project} owner={value} visible disabled={false} current={current} gate={gate} preset={view.preset} locale={view.locale}/> : null}</> : null}</>;
}
function open() {
  render(<SessionReadProvider context={executionContext(project)} reads={reads} bridge={false}><TranslationDraftSession project={project}><ExecutionTaskSession project={project}><Shell/></ExecutionTaskSession></TranslationDraftSession></SessionReadProvider>);
  return userEvent.setup();
}
function fill(name = "Mara", text = "Friendly but direct.") {
  for (const [key, value] of [["contextName", name], ["contextText", text], ["contextActor", "Human reviewer"], ["reason", "Checked against the source"]] as const) fireEvent.change(screen.getByRole("textbox", { name: k(key) }), { target: { value } });
}
async function newDraft() {
  const user = open(), add = await screen.findByRole("button", { name: k("contextNew") });
  await waitFor(() => expect(add).toBeEnabled()); await user.click(add); fill(); return user;
}

describe.each(["en-US", "zh-CN"])("typed resources in %s", locale => {
  it("saves readable scoped data and displays its original audit history", async () => {
    await i18n.changeLanguage(locale); const user = await newDraft();
    await user.click(screen.getByRole("button", { name: k("contextChooseFiles") }));
    const picker = await screen.findByRole("dialog", { name: k("contextChooseFiles") });
    await user.click(await within(picker).findByRole("checkbox", { name: "data/😀.json" }));
    await user.click(within(picker).getByRole("checkbox", { name: "data/\uE000.json" }));
    await user.click(within(picker).getByRole("button", { name: k("contextUseFiles") }));
    await user.click(screen.getByRole("button", { name: k("contextSave") })); await screen.findByText(k("contextSaved"));
    expect([...resources.values()][0]).toMatchObject({ name: "Mara", text: "Friendly but direct.", locale: "zh-CN", actor: "Human reviewer", sourceBasis: source,
      scope: { kind: "file-group", logicalPaths: ["data/\uE000.json", "data/😀.json"] } });
    await user.click(within(screen.getByLabelText(k("contextEditor"))).getByRole("button", { name: k("details") }));
    expect(await screen.findByRole("region", { name: k("contextDetails") })).toHaveTextContent("Human reviewer");
    expect(screen.getByText(i18n.t("knowledge.contextHistoryEntry", { number: 1 }))).toBeVisible();
    const saved = [...resources.values()][0], target = reviewWire.responses.editor.target;
    impacts = { coverage: "current-selections", nextOffset: null, totalAffected: 1, items: [{ locale: target.locale, nativeKey: target.nativeKey,
      unitId: target.unitId, sourceRevisionId: target.sourceRevisionId, sourceText: target.sourceText, selectionEventId: target.selectionId,
      translationRevisionId: target.revisionId, status: "needs-revalidation", reasons: [{ kind: "context-resource", confidence: "scope-possible",
        changeId: fixtureIdentity(76002), newRevisionId: saved.revisionId, oldRevisionId: null, oldValue: null, newValue: saved.text, newRemoved: false }] }] };
    await user.click(screen.getByRole("button", { name: k("contextReadImpact") }));
    const impact = screen.getByRole("region", { name: k("contextImpactTitle") });
    expect(await within(impact).findByText(target.nativeKey)).toBeVisible();
    expect(within(impact).getByText(`${i18n.t("resource.reasonKind.context-resource")} · ${i18n.t("resource.confidence.scope-possible")}`)).toBeVisible();
    expect(within(impact).getByText(k("contextImpactHelp"))).toBeVisible();
  });
});

it("keeps distinct drafts and newer B metadata when A returns on another category", async () => {
  let release: (value: ContextResourceRevision) => void = () => { throw new Error("A save must be waiting"); }, sent: SaveContextResource | undefined;
  save = request => { sent = structuredClone(request); return new Promise(resolve => { release = resolve; }); };
  const user = await newDraft(); await user.click(screen.getByRole("button", { name: k("contextSave") })); await waitFor(() => expect(sent).toBeDefined());
  fireEvent.change(screen.getByRole("textbox", { name: k("contextText") }), { target: { value: "Newer B" } });
  fireEvent.change(screen.getByRole("textbox", { name: k("contextActor") }), { target: { value: "New actor B" } });
  await user.click(screen.getByRole("button", { name: i18n.t("knowledge.kinds.style") }));
  const addStyle = await screen.findByRole("button", { name: k("contextNew") }); await waitFor(() => expect(addStyle).toBeEnabled()); await user.click(addStyle); fill("Mara", "Style B");
  const styleKey = owner?.current().typedActiveKey;
  await act(async () => { if (!sent) throw new Error("The captured request is required"); release(apply(sent)); });
  expect(owner?.current().typedActiveKey).toBe(styleKey); expect(screen.getByRole("textbox", { name: k("contextText") })).toHaveValue("Style B");
  await user.click(screen.getByRole("button", { name: i18n.t("knowledge.kinds.characters") }));
  const drafts = screen.getByRole("navigation", { name: k("contextDrafts") }); await user.click(within(drafts).getByRole("button", { name: /Mara/ }));
  expect(screen.getByRole("textbox", { name: k("contextText") })).toHaveValue("Newer B"); expect(screen.getByRole("textbox", { name: k("contextActor") })).toHaveValue("New actor B");
  await user.click(screen.getByRole("button", { name: "Another tab" })); await act(async () => { expect(await lifecycle.close()).toBe(false); });
  expect(await screen.findByRole("textbox", { name: k("contextText") })).toHaveValue("Newer B");
});

it("requires an explicit new source basis and keeps old input until reviewed", async () => {
  const user = await newDraft(); const original = structuredClone(source);
  source = { revision: "2", currentSnapshot: fixtureIdentity(79000) }; act(() => reads.invalidate(["source"]));
  await screen.findByText(k("contextSourceChanged")); expect(screen.getByRole("textbox", { name: k("contextText") })).toHaveValue("Friendly but direct.");
  expect(screen.getByRole("button", { name: k("contextSave") })).toBeDisabled();
  expect(Object.values(owner?.current().typedDrafts ?? {})[0].sourceBasis).toEqual(original);
  await user.click(screen.getByRole("button", { name: k("contextConfirmSource") }));
  await waitFor(() => expect(screen.getByRole("button", { name: k("contextSave") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: k("contextSave") })); await screen.findByText(k("contextSaved")); expect([...resources.values()][0].sourceBasis).toEqual(source);
});

it("does not treat a pure missing receipt as permission to retry and reuses only the reconciled request", async () => {
  let sent: SaveContextResource | undefined, writes = 0;
  save = async request => { sent = structuredClone(request); writes++; if (writes === 1) throw { outcome: "unknown" }; return apply(request); };
  const user = await newDraft(); await user.click(screen.getByRole("button", { name: k("contextSave") }));
  await waitFor(() => expect(owner?.current().pendingUncertain).toBe(true));
  expect(owner?.current().pendingCheckedMissing).toBe(false); expect(screen.queryByRole("button", { name: k("retryAction") })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: k("contextText") }), { target: { value: "Keep B" } });
  await user.click(screen.getByRole("button", { name: k("checkAction") })); await waitFor(() => expect(owner?.current().pendingCheckedMissing).toBe(true));
  await user.click(screen.getByRole("button", { name: k("retryAction") })); await screen.findByText(k("contextSavedNewer"));
  expect(screen.getByRole("textbox", { name: k("contextText") })).toHaveValue("Keep B");
  const requests = invoke.mock.calls.filter(([name]) => name === "save_context_resource").map(([, payload]) => payload.request.resource);
  expect(requests).toEqual([sent, sent]); expect(writes).toBe(2);
});

it("keeps the original uncertain action after a pure recorded read until explicit reconciliation", async () => {
  save = async request => { apply(request); throw { outcome: "unknown" }; };
  const user = await newDraft(); await user.click(screen.getByRole("button", { name: k("contextSave") }));
  await screen.findByText(k("contextRecordFound"));
  await waitFor(() => expect(owner?.current().busyMutation).toBe(false));
  const pending = owner?.current().pending;
  expect(pending?.kind).toBe("typed-context"); expect(owner?.current().pendingUncertain).toBe(true);
  expect(owner?.current().pendingCheckedMissing).toBe(false); expect(Object.values(owner?.current().typedDrafts ?? {})[0].base).toBeNull();
  expect(screen.queryByRole("button", { name: k("retryAction") })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: k("contextText") }), { target: { value: "Keep B after recorded read" } });
  await act(async () => { expect(await lifecycle.close()).toBe(false); });
  expect(owner?.current().pending).toBe(pending);
  expect(invoke.mock.calls.filter(([name]) => name === "reconcile_context_resource_action")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: k("checkAction") })); await screen.findByText(k("contextSavedNewer"));
  expect(owner?.current().pending).toBeNull(); expect(screen.getByRole("textbox", { name: k("contextText") })).toHaveValue("Keep B after recorded read");
  expect(invoke.mock.calls.filter(([name]) => name === "save_context_resource")).toHaveLength(1);
  expect(invoke.mock.calls.find(([name]) => name === "reconcile_context_resource_action")?.[1].request.action).toEqual({ kind: "save", request: pending?.request });
});

it("compares the exact current revision and rebases explicitly without replacing newer input", async () => {
  const user = await newDraft(); await user.click(screen.getByRole("button", { name: k("contextSave") })); await screen.findByText(k("contextSaved"));
  const saved = [...resources.values()][0];
  fireEvent.change(screen.getByRole("textbox", { name: k("contextText") }), { target: { value: "My retained B" } });
  const latest = apply({ projectId: saved.projectId, actionId: fixtureIdentity(++serial), contextId: saved.contextId, subjectId: saved.subjectId,
    expectedRevisionId: saved.revisionId, sourceBasis: saved.sourceBasis, kind: saved.kind, locale: saved.locale, scope: saved.scope,
    name: saved.name, text: "A different saved version", actor: "Another reviewer", reason: "An independent change" });
  act(() => reads.invalidate(["resources"])); await screen.findByText(k("contextCurrentChanged"));
  expect(screen.getByRole("button", { name: k("contextSave") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: k("compare") }));
  const comparison = await screen.findByRole("region", { name: k("comparison") }); expect(comparison).toHaveTextContent("A different saved version");
  await user.click(within(comparison).getByRole("button", { name: k("keepEdits") }));
  expect(screen.getByRole("textbox", { name: k("contextText") })).toHaveValue("My retained B");
  await waitFor(() => expect(screen.getByRole("button", { name: k("contextSave") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: k("contextSave") })); await screen.findByText(k("contextSaved"));
  expect(resources.get(saved.contextId)).toMatchObject({ previousRevisionId: latest.revisionId, text: "My retained B" });
});

it("creates an explicit entry variant while same names and the three categories stay independent", async () => {
  const user = await newDraft(); await user.click(screen.getByRole("button", { name: k("contextSave") })); await screen.findByText(k("contextSaved"));
  const original = [...resources.values()][0]; await user.click(await screen.findByRole("button", { name: k("contextVariant") })); fill("Mara", "Only in this entry");
  await user.click(screen.getByRole("button", { name: k("chooseEntry") }));
  const picker = await screen.findByRole("dialog", { name: k("chooseEntry") }), entry = await within(picker).findByRole("button", { name: /wooden-barrel/ });
  await waitFor(() => expect(entry).toBeEnabled()); await user.click(entry);
  await user.click(screen.getByRole("button", { name: k("contextSave") })); await screen.findByText(k("contextSaved"));
  const variant = [...resources.values()].find(value => value.contextId !== original.contextId);
  expect(variant).toMatchObject({ subjectId: original.subjectId, scope: { kind: "unit", unitId: reviewWire.requests.target.unitId }, text: "Only in this entry" });
  for (const kind of ["style", "background"] as const) {
    await user.click(screen.getByRole("button", { name: i18n.t(`knowledge.kinds.${kind}`) }));
    const add = await screen.findByRole("button", { name: k("contextNew") }); await waitFor(() => expect(add).toBeEnabled()); await user.click(add); fill("Mara", `${kind} content`);
    await user.click(screen.getByRole("button", { name: k("contextSave") })); await screen.findByText(k("contextSaved"));
    const saved = [...resources.values()].find(value => value.kind === kind); expect(saved?.subjectId).not.toBe(original.subjectId); expect(saved?.scope).toEqual({ kind: "project" });
  }
  expect(resources.size).toBe(4);
});

it("updates mounted draft, details and confirmation labels after a language switch without translating input", async () => {
  const user = await newDraft();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Mara");
  expect(screen.getByRole("button", { name: "Save resource" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: k("contextSave") })); await screen.findByText(k("contextSaved"));
  fireEvent.change(screen.getByRole("textbox", { name: k("contextText") }), { target: { value: "Keep 人工输入 B" } });
  await user.click(within(screen.getByLabelText(k("contextEditor"))).getByRole("button", { name: k("details") }));
  expect(await screen.findByRole("region", { name: "Resource details" })).toHaveTextContent("Keep 人工输入 B");
  await user.click(screen.getByRole("button", { name: k("contextWithdraw") }));
  expect(await screen.findByRole("dialog", { name: "Stop using this saved resource in its scope?" })).toBeVisible();
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  const dialog = await screen.findByRole("dialog", { name: "在已保存范围内停用这份资料？" });
  expect(within(dialog).getByRole("button", { name: "停用这个已保存版本" })).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: k("proposalCancel") }));
  expect(screen.getByRole("textbox", { name: "正文" })).toHaveValue("Keep 人工输入 B");
  expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("Mara");
  expect(screen.getByRole("region", { name: "资料详情" })).toHaveTextContent("Keep 人工输入 B");
  expect(invoke.mock.calls.filter(([name]) => name === "save_context_resource")).toHaveLength(1);
});

it("withdraws only the saved scope and explicitly restores a new version", async () => {
  const user = await newDraft(); await user.click(screen.getByRole("button", { name: k("contextSave") })); await screen.findByText(k("contextSaved"));
  await waitFor(() => expect(screen.getByRole("button", { name: k("contextWithdraw") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: k("contextWithdraw") }));
  const dialog = await screen.findByRole("dialog", { name: k("contextWithdrawTitle") }); expect(dialog).toHaveTextContent(k("contextWithdrawHelp"));
  await user.click(within(dialog).getByRole("button", { name: k("contextWithdrawConfirm") })); await waitFor(() => expect([...resources.values()][0].withdrawn).toBe(true));
  const stopped = [...resources.values()][0];
  await user.click(within(screen.getByRole("table", { name: k("contextTable") })).getByRole("button", { name: "Mara" }));
  await waitFor(() => expect(screen.getByRole("button", { name: k("contextRestoreSave") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: k("contextRestoreSave") })); await waitFor(() => expect([...resources.values()][0].withdrawn).toBe(false));
  expect([...resources.values()][0]).toMatchObject({ contextId: stopped.contextId, subjectId: stopped.subjectId, previousRevisionId: stopped.revisionId }); expect(history).toHaveLength(3);
});
