import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import resourceWire from "../../../../test/fixtures/resourceCommands.contract.json";
import reviewWire from "../../../../test/fixtures/reviewCommands.contract.json";
import segmentWire from "../../../../test/fixtures/segmentCommands.contract.json";
import { ExecutionTaskSession } from "../../../ExecutionTaskSession";
import { executionContext } from "../../../executionCommands";
import { sourceCommands, type ContentScope } from "../../../sourceCommands";
import { i18n } from "../../../i18n";
import type { knowledgeEn } from "../../../i18n/knowledge";
import type { CommandError, ProjectView } from "../../../projectCommands";
import { validateRequestTerm, validateResponseTerm } from "../../../generated/resource.validators";
import type { SaveTerm, TermRevision } from "../../../resourceCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { TranslationDraftSession } from "../../../TranslationDraftSession";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { sourceContentFixture } from "../../../testSupport/sourceFixture";
import { Button } from "../../../design-system/Button";
import { ProjectLifecycle, type ProjectLifecyclePorts } from "../../platform/projectLifecycle";
import { InteractionGate } from "../../workspace/interactionGate";
import { makeWorkspaceView, type ViewPatch } from "../../workspace/workspaceStore";
import KnowledgeOwnerHost from "./KnowledgeOwnerHost";
import KnowledgeView from "./KnowledgeView";
import KnowledgeDetails from "./KnowledgeDetails";
import type { KnowledgeOwner } from "./knowledgeTypes";
import { knowledgeTermsKey } from "./knowledgeReads";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "synthetic-knowledge", locator: "/synthetic/knowledge", reconciliationState: "settled",
  metadata: { projectId: reviewWire.requests.target.projectId, displayName: "Synthetic knowledge", sourceLocale: "en-US", targetLocales: ["zh-CN", "de-DE"], metadataRevision: "1" } };
const context = executionContext(project);
const initial: TermRevision = { ...resourceWire.responses.term, termId: "manual-term", source: "Barrel", aliases: ["Cask"], target: "木桶", reason: "Reviewed source",
  locale: "zh-CN", originKind: "manual", captureId: null, externalEntryId: null, scopeUnitId: null, previousRevisionId: null, removed: false };
let reads: SessionReads, gate: InteractionGate, lifecycle: ProjectLifecycle, observed: KnowledgeOwner | null;
let savedTerms: TermRevision[], historyRows: TermRevision[], actions: Map<string, { request: SaveTerm; receipt: TermRevision }>;
let save: (request: SaveTerm) => Promise<TermRevision>, identity: number, close: Mock<ProjectLifecyclePorts["close"]>;
type MessageKey = { [Key in keyof typeof knowledgeEn]: typeof knowledgeEn[Key] extends string ? Key : never }[keyof typeof knowledgeEn];
const k = (key: MessageKey) => i18n.t(`knowledge.${key}`);
function receipt(request: SaveTerm): TermRevision {
  const result = { ...request, termId: request.termId ?? "new-term", revisionId: fixtureIdentity(++identity), previousRevisionId: request.expectedRevisionId ?? null,
    originKind: "manual", captureId: null, externalEntryId: null, removed: false };
  const raw: unknown = { revisionId: result.revisionId, termId: result.termId, locale: result.locale, source: result.source, aliases: result.aliases, target: result.target,
    protected: result.protected, scopeUnitId: result.scopeUnitId, reason: result.reason, originKind: result.originKind, captureId: null, externalEntryId: null, previousRevisionId: result.previousRevisionId, removed: false };
  if (!validateResponseTerm(raw)) throw new Error("A valid synthetic term receipt is required");
  savedTerms = [...savedTerms.filter(row => row.termId !== raw.termId), raw].sort((a, b) => a.termId.localeCompare(b.termId)); historyRows.push(raw);
  actions.set(request.actionId, { request: structuredClone(request), receipt: structuredClone(raw) }); return raw;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  reads = new SessionReads(context); gate = new InteractionGate(); gate.setVisibleOwner("knowledge-view"); observed = null; identity = 72000;
  savedTerms = [structuredClone(initial)]; historyRows = [structuredClone(initial)]; actions = new Map(); save = async request => receipt(request);
  close = vi.fn<ProjectLifecyclePorts["close"]>(async () => ({ closed: true }));
  lifecycle = new ProjectLifecycle({ open: async () => project, close, createReads: () => reads,
    status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  await lifecycle.open(project.locator);
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, payload: { request: unknown }) => {
    const request = payload.request as Record<string, unknown>;
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: reviewWire.responses.editor.target.sourceSnapshotId };
    if (command === "read_terms") return structuredClone(savedTerms.filter(row => row.locale === request.locale && row.termId > String(request.afterTermId ?? "")).slice(0, Number(request.limit)));
    if (command === "read_term_current") return structuredClone(savedTerms.find(row => row.termId === request.termId) ?? null);
    if (command === "read_term_history") return structuredClone(historyRows.filter(row => row.termId === request.termId).slice(Number(request.offset), Number(request.offset) + Number(request.limit)));
    if (command === "list_resource_captures") return [];
    if (command === "read_segment_page") return structuredClone(segmentWire.responses.segmentPage);
    if (command === "read_context_resource_page") return { rows: [], nextOffset: null, basis: "synthetic-empty-resources" };
    if (command === "read_source_content") return sourceContentFixture(reviewWire.responses.editor.target.sourceSnapshotId, { revision: "1", currentSnapshot: reviewWire.responses.editor.target.sourceSnapshotId });
    if (command === "read_review_editor_snapshot") return structuredClone(reviewWire.responses.editor);
    if (command === "create_execution_identity") return fixtureIdentity(++identity);
    if (command === "save_term") {
      if (!validateRequestTerm(payload.request)) throw new Error("Invalid original term request");
      return save(payload.request.term);
    }
    if (command === "read_term_save_action") {
      if (!validateRequestTerm(payload.request)) throw new Error("Invalid original term lookup");
      return structuredClone(actions.get(payload.request.term.actionId) ?? null);
    }
    throw new Error(`Unexpected synthetic command: ${command}`);
  });
});
afterEach(() => { cleanup(); lifecycle.dispose(); reads.retire(); gate.dispose(); });

function Shell() {
  const [owner, setOwner] = useState<KnowledgeOwner | null>(null), [details, setDetails] = useState(false), [hidden, setHidden] = useState(false);
  const [view, setView] = useState(() => makeWorkspaceView({ kind: "knowledge", locale: "zh-CN", preset: "terms" }, "knowledge-view"));
  const publish = useCallback((value: KnowledgeOwner | null) => { observed = value; setOwner(value); }, []);
  const reveal = useCallback(() => setHidden(false), []);
  const patch = (patch: ViewPatch) => setView(value => ({ ...value, ...patch }));
  return <>
    <KnowledgeOwnerHost project={project} lifecycle={lifecycle} onOwner={publish} onReveal={reveal}/>
    <Button onClick={() => setHidden(value => !value)}>{hidden ? "Show knowledge" : "Another tab"}</Button>
    {owner && !hidden ? <><KnowledgeView project={project} owner={owner} view={view} disabled={false} gate={gate} current={dialogId => gate.canDispatch({ viewId: view.id, source: "button", dialogId })} patch={patch} onDetails={() => setDetails(true)}/>
      {details ? <KnowledgeDetails project={project} owner={owner} visible disabled={false} current={() => true}/> : null}</> : null}
  </>;
}
function open() {
  render(<SessionReadProvider context={context} reads={reads} bridge={false}><TranslationDraftSession project={project}><ExecutionTaskSession project={project}><Shell/></ExecutionTaskSession></TranslationDraftSession></SessionReadProvider>);
  return userEvent.setup();
}
async function edit() {
  const user = open();
  await user.click(await screen.findByRole("button", { name: "Barrel" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: k("targetTerm") })).toHaveValue("木桶"));
  expect(screen.getByRole("textbox", { name: k("sourceTerm") })).toHaveFocus();
  return user;
}
function input(name: MessageKey, value: string) { fireEvent.change(screen.getByRole("textbox", { name: k(name) }), { target: { value } }); }

describe.each(["en-US", "zh-CN"])("knowledge manual path in %s", locale => {
  it("saves a new scoped term through the original resource action", async () => {
    await i18n.changeLanguage(locale); const user = open();
    const add = await screen.findByRole("button", { name: k("newTerm") });
    await waitFor(() => expect(add).toBeEnabled()); await user.click(add);
    expect(screen.getByRole("textbox", { name: k("sourceTerm") })).toHaveFocus();
    input("sourceTerm", "Rain ⛈"); input("targetTerm", "雨"); input("reason", "人工核对 — keep this text");
    await user.click(screen.getByRole("button", { name: k("chooseEntry") }));
    const picker = await screen.findByRole("dialog", { name: k("chooseEntry") });
    await user.click(await within(picker).findByRole("button", { name: /wooden-barrel/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: k("save") })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: k("save") }));
    await screen.findByText(k("saved"));
    expect(savedTerms.find(row => row.termId === "new-term")).toMatchObject({ source: "Rain ⛈", target: "雨", scopeUnitId: reviewWire.requests.target.unitId, locale: "zh-CN", reason: "人工核对 — keep this text" });
    expect(invoke.mock.calls.filter(([name]) => name === "save_term")).toHaveLength(1);
    await user.click(within(screen.getByLabelText(k("termEditor"))).getByRole("button", { name: k("details") }));
    expect(await screen.findByRole("region", { name: k("termDetails") })).toBeVisible();
    expect(await screen.findByText(i18n.t("knowledge.historyEntry", { number: 1 }))).toBeVisible();
    expect(screen.getByText(k("unknownCount"))).toBeVisible();
  });
});

it("keeps newer B input when A saves and retains it across tabs and blocked project exit", async () => {
  let finish: ((value: TermRevision) => void) | undefined, sent: SaveTerm | undefined;
  save = request => { sent = structuredClone(request); return new Promise(resolve => { finish = resolve; }); };
  const user = await edit(); input("targetTerm", "Version A");
  await user.click(screen.getByRole("button", { name: k("save") }));
  await waitFor(() => expect(sent).toBeDefined()); input("targetTerm", "Version B");
  await act(async () => { const accepted = receipt(sent!); finish!(accepted); });
  await screen.findByText(k("savedNewer")); expect(screen.getByRole("textbox", { name: k("targetTerm") })).toHaveValue("Version B");
  await user.click(screen.getByRole("button", { name: "Another tab" }));
  await act(async () => { expect(await lifecycle.close()).toBe(false); }); expect(close).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("textbox", { name: k("targetTerm") })).toHaveValue("Version B"));
  await user.click(screen.getByRole("button", { name: k("discard") }));
  await act(async () => { expect(await lifecycle.close()).toBe(true); }); expect(close).toHaveBeenCalledTimes(1);
});

it("compares a newer saved version and changes the CAS basis only after an explicit action", async () => {
  const user = await edit(); input("targetTerm", "My newer input");
  const external = { ...structuredClone(initial), revisionId: fixtureIdentity(73001), target: "Saved elsewhere", reason: "External edit", previousRevisionId: initial.revisionId };
  savedTerms = [external]; historyRows.push(external);
  act(() => reads.invalidate(["resources"]));
  const compare = await screen.findByRole("button", { name: k("compare") });
  expect(screen.getByRole("button", { name: k("save") })).toBeDisabled();
  await user.click(compare); expect(screen.getByText(`${k("newSavedValue")}: Saved elsewhere`)).toBeVisible();
  expect(observed?.state.selectedTerm?.revisionId).toBe(initial.revisionId);
  await user.click(screen.getByRole("button", { name: k("keepEdits") }));
  expect(observed?.state.selectedTerm?.revisionId).toBe(external.revisionId);
  expect(screen.getByRole("textbox", { name: k("targetTerm") })).toHaveValue("My newer input");
  await user.click(screen.getByRole("button", { name: k("save") })); await screen.findByText(k("saved"));
  expect(savedTerms[0]).toMatchObject({ target: "My newer input", previousRevisionId: external.revisionId });
});

it("checks an uncertain original action without issuing a replacement save", async () => {
  const lost: CommandError = { code: "outcome-unknown", stage: "execution-adopt", outcome: "unknown", recoveryRequired: true, reason: "resource-save", diagnosticId: fixtureIdentity(73002) };
  let sent: SaveTerm | undefined;
  save = async request => { sent = structuredClone(request); throw lost; };
  const user = await edit(); input("targetTerm", "Version A"); await user.click(screen.getByRole("button", { name: k("save") }));
  await waitFor(() => expect(observed?.state.pendingCheckedMissing).toBe(true)); input("targetTerm", "Version B");
  receipt(sent!);
  await user.click(screen.getByRole("button", { name: k("checkAction") }));
  await screen.findByText(k("savedNewer")); expect(screen.getByRole("textbox", { name: k("targetTerm") })).toHaveValue("Version B");
  expect(invoke.mock.calls.filter(([name]) => name === "save_term")).toHaveLength(1);
  const lookup = invoke.mock.calls.filter(([name]) => name === "read_term_save_action");
  expect(lookup.map(([, payload]) => payload.request.term)).toEqual([sent, sent]);
});

it("settles only an original receipt-first CAS rejection after an uncertain save", async () => {
  const user = await edit();
  let writes = 0;
  save = async () => {
    writes += 1;
    if (writes === 1) throw { code: "outcome-unknown", stage: "execution-adopt", outcome: "unknown", recoveryRequired: true, reason: "resource-save", diagnosticId: fixtureIdentity(73003) };
    throw { code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason: "resource-current", diagnosticId: fixtureIdentity(73004) };
  };
  input("targetTerm", "Version A"); await user.click(screen.getByRole("button", { name: k("save") }));
  await waitFor(() => expect(observed?.state.pendingCheckedMissing).toBe(true)); input("targetTerm", "Version B");
  await user.click(screen.getByRole("button", { name: k("retryAction") }));
  await waitFor(() => expect(observed?.state.pending).toBeNull());
  expect(observed?.state.pendingUncertain).toBe(false); expect(screen.getByRole("textbox", { name: k("targetTerm") })).toHaveValue("Version B");
  const saves = invoke.mock.calls.filter(([name]) => name === "save_term"); expect(saves[0][1]).toEqual(saves[1][1]);
});

it("reads additional term pages and preserves drafts while showing unsupported categories", async () => {
  savedTerms = Array.from({ length: 101 }, (_, index) => ({ ...structuredClone(initial), termId: `term-${String(index).padStart(3, "0")}`, source: `Source ${index}` }));
  const user = open();
  expect(await screen.findByRole("button", { name: "Source 99" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Source 100" })).toBeNull();
  await user.click(screen.getByRole("button", { name: k("moreTerms") })); await screen.findByRole("button", { name: "Source 100" });
  await user.click(screen.getByRole("button", { name: "Source 0" })); input("targetTerm", "Retained text");
  await user.click(screen.getByRole("button", { name: i18n.t("knowledge.kinds.characters") }));
  expect(await screen.findByRole("table", { name: k("contextTable") })).toBeVisible();
  expect(await screen.findByText(k("contextEmpty"))).toBeVisible();
  await user.click(screen.getByRole("button", { name: k("backToDraft") }));
  expect(screen.getByRole("textbox", { name: k("targetTerm") })).toHaveValue("Retained text");
  expect(invoke.mock.calls.filter(([name]) => name === "save_term")).toHaveLength(0);
});

it("checks the selected term independently when it is no longer on a loaded list page", async () => {
  savedTerms = Array.from({ length: 101 }, (_, index) => ({ ...structuredClone(initial), termId: `term-${String(index).padStart(3, "0")}`, source: `Source ${index}` }));
  const user = open(); await user.click(await screen.findByRole("button", { name: k("moreTerms") }));
  await user.click(await screen.findByRole("button", { name: "Source 100" })); input("targetTerm", "Retained change");
  const latest = { ...savedTerms[100], revisionId: fixtureIdentity(73009), target: "Changed on another screen", previousRevisionId: savedTerms[100].revisionId };
  savedTerms[100] = latest;
  act(() => {
    reads.client.setQueryData(reads.key(knowledgeTermsKey("zh-CN")), { pages: [savedTerms.slice(0, 100)], pageParams: [{ cursor: null }] });
    reads.invalidate(["resources"]);
  });
  await user.click(await screen.findByRole("button", { name: k("compare") }));
  expect(await screen.findByText(`${k("newSavedValue")}: Changed on another screen`)).toBeVisible();
  expect(screen.getByRole("textbox", { name: k("targetTerm") })).toHaveValue("Retained change");
  expect(invoke.mock.calls.filter(([name, payload]) => name === "read_term_current" && payload.request.termId === latest.termId).length).toBeGreaterThan(0);
});

it("protects composed input and enforces the original sixteen-alias limit", async () => {
  const user = await edit(), target = screen.getByRole("textbox", { name: k("targetTerm") });
  fireEvent.compositionStart(target); input("targetTerm", "正在输入");
  expect(gate.acquireIntent("navigate-away")).toBeNull();
  expect(screen.getByRole("button", { name: k("save") })).toBeDisabled();
  fireEvent.compositionEnd(target);
  input("aliases", Array.from({ length: 17 }, (_, index) => `Alias ${index}`).join(", "));
  expect(screen.getByText(k("aliasesInvalid"))).toBeVisible(); expect(screen.getByRole("button", { name: k("save") })).toBeDisabled();
  input("aliases", Array.from({ length: 16 }, (_, index) => `Alias ${index}`).join(", "));
  expect(screen.queryByText(k("aliasesInvalid"))).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: k("save") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: k("save") })); await screen.findByText(k("saved"));
  expect(savedTerms[0].aliases).toHaveLength(16);
});

it("requires fresh source and page evidence before choosing an entry scope", async () => {
  const user = await edit(); await user.click(screen.getByRole("button", { name: k("chooseEntry") }));
  const picker = await screen.findByRole("dialog", { name: k("chooseEntry") });
  const choice = await within(picker).findByRole("button", { name: /wooden-barrel/ });
  await waitFor(() => expect(choice).toBeEnabled());
  let release: (value: ContentScope) => void = () => { throw new Error("A source read must be waiting"); };
  const pendingSource = new Promise<ContentScope>(resolve => { release = resolve; });
  const reread = vi.spyOn(sourceCommands, "scope").mockReturnValue(pendingSource);
  act(() => reads.invalidate(["source"], false));
  await waitFor(() => expect(reread).toHaveBeenCalled());
  await waitFor(() => expect(within(picker).queryByRole("button", { name: /wooden-barrel/ })).not.toBeInTheDocument());
  expect(observed?.state.termDraft.scopeUnitId).toBeNull();
  const search = within(picker).getByRole("textbox", { name: k("searchEntries") });
  fireEvent.compositionStart(search);
  await user.click(within(picker).getByRole("button", { name: k("search") }));
  expect(within(picker).queryByRole("button", { name: /wooden-barrel/ })).not.toBeInTheDocument(); fireEvent.compositionEnd(search);
  await user.click(within(picker).getByRole("button", { name: k("search") }));
  expect(within(picker).queryByRole("button", { name: /wooden-barrel/ })).not.toBeInTheDocument();
  await act(async () => { release({ revision: "2", currentSnapshot: reviewWire.responses.editor.target.sourceSnapshotId }); });
  await waitFor(() => expect(within(picker).getByRole("button", { name: /wooden-barrel/ })).toBeEnabled());
  await user.click(within(picker).getByRole("button", { name: /wooden-barrel/ }));
  expect(observed?.state.termDraft.scopeUnitId).toBe(reviewWire.requests.target.unitId);
});
