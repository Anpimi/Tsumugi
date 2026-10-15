import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceWorkbench } from "./ResourceWorkbench";
import type { ProjectView } from "./projectCommands";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import resourceFixture from "../test/fixtures/resourceCommands.contract.json";
import errorFixture from "../test/fixtures/commandErrors.contract.json";
import { useResourceDraftSession } from "./ResourceDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands, type ResourceDecisionCommandPayload, type ResourceTranslationCommandPayload } from "./workbenchCommands";
import type { SaveTerm, SaveContext, CaptureContext, ResourceDecision, ResourcePreview } from "./resourceCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const project: ProjectView = {
  sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(405), displayName: "Demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" },
};
const page = sourcePageFixture({
  snapshotId: fixtureIdentity(400), scope: { revision: "2", currentSnapshot: fixtureIdentity(400) },
  rows: [sourceRowFixture({ unitId: fixtureIdentity(401), sourceRevisionId: fixtureIdentity(402) }, { ordinal: 0, key: "barrel", text: "Barrel" })],
});

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_content_scope") return page.scope;
    if (command === "read_source_content") return page;
    if (command === "read_terms") return [];
    if (command === "list_resource_captures") return [];
    if (command === "create_execution_identity") return fixtureIdentity(1);
    if (command === "save_term") return {
      revisionId: fixtureIdentity(406), termId: "term", locale: "zh-CN", source: "Barrel",
      aliases: ["Cask", "Drum"], target: "木桶", protected: false, scopeUnitId: null,
      reason: "Reviewed", originKind: "manual", captureId: null, externalEntryId: null,
      previousRevisionId: null, removed: false,
    };
    if (command === "read_term_history") return [];
    throw new Error(command);
  });
});
afterEach(cleanup);

it("loads source and terms together, then preserves alias entry through save", async () => {
  render(<ResourceWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "read_source_content")).toBe(true));
  await screen.findByRole("option", { name: "barrel" });
  await user.type(screen.getByRole("textbox", { name: "Source term" }), "Barrel");
  await user.type(screen.getByRole("textbox", { name: "Source aliases, separated by commas" }), "Cask, Drum");
  expect(screen.getByRole("textbox", { name: "Source aliases, separated by commas" })).toHaveValue("Cask, Drum");
  await user.type(screen.getByRole("textbox", { name: "Preferred target form" }), "木桶");
  await user.type(screen.getByRole("textbox", { name: "Reason or source note" }), "Reviewed");
  await user.click(screen.getByRole("button", { name: "Save term" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "save_term")).toBe(true));
  const save = invoke.mock.calls.find(([name]) => name === "save_term")?.[1].request.term;
  expect(save).toMatchObject({ aliases: ["Cask", "Drum"], source: "Barrel", target: "木桶" });
});

it("keeps edits made while a term save is pending", async () => {
  let finishSave!: (value: unknown) => void;
  const pendingSave = new Promise(resolve => { finishSave = resolve; });
  const originalInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, request: unknown) =>
    command === "save_term" ? pendingSave : originalInvoke(command, request));
  render(<ResourceWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" });
  await user.type(screen.getByRole("textbox", { name: "Source term" }), "Barrel");
  const target = screen.getByRole("textbox", { name: "Preferred target form" });
  await user.type(target, "A");
  await user.type(screen.getByRole("textbox", { name: "Reason or source note" }), "Reviewed");
  await user.click(screen.getByRole("button", { name: "Save term" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "save_term")).toBe(true));
  await user.type(target, "B");
  await act(async () => finishSave({
    revisionId: fixtureIdentity(406), termId: "term", locale: "zh-CN", source: "Barrel",
    aliases: [], target: "A", protected: false, scopeUnitId: null,
    reason: "Reviewed", originKind: "manual", captureId: null, externalEntryId: null,
    previousRevisionId: null, removed: false,
  }));
  await waitFor(() => expect(target).toHaveValue("AB"));
  expect(screen.getByRole("button", { name: "Save term" })).toBeEnabled();
});

it("keeps newer term edits when checking an uncertain original save", async () => {
  const originalInvoke = invoke.getMockImplementation()!;
  const saved = { ...resourceFixture.responses.term, revisionId: fixtureIdentity(406), termId: "term", source: "Barrel", aliases: [], target: "A", reason: "Reviewed", protected: false, scopeUnitId: null };
  let saves = 0;
  invoke.mockImplementation((command: string, request: unknown) => {
    if (command === "save_term") return Promise.resolve(++saves === 1 ? { ...saved, revisionId: "invalid" } : saved);
    return originalInvoke(command, request);
  });
  render(<ResourceWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" });
  await user.type(screen.getByRole("textbox", { name: "Source term" }), "Barrel");
  const target = screen.getByRole("textbox", { name: "Preferred target form" });
  await user.type(target, "A");
  await user.type(screen.getByRole("textbox", { name: "Reason or source note" }), "Reviewed");
  await user.click(screen.getByRole("button", { name: "Save term" }));
  const retry = await screen.findByRole("button", { name: "Check or retry the same action" });
  await user.type(target, "B");
  await user.click(retry);
  await screen.findByText("Saved. Earlier revisions remain available.");
  expect(target).toHaveValue("AB");
  const requests = invoke.mock.calls.filter(([command]) => command === "save_term").map(([, payload]) => payload.request);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].term.target).toBe("A");
  expect(screen.getByRole("button", { name: "Discard edits" })).toBeEnabled();
});

it.each(["delayed", "replayed"] as const)("keeps newer context and reason after a %s save confirmation", async mode => {
  const originalInvoke = invoke.getMockImplementation()!;
  let finishSave!: (value: unknown) => void;
  const pendingSave = new Promise(resolve => { finishSave = resolve; });
  const saved = { ...resourceFixture.responses.savedContext, revisionId: fixtureIdentity(407), unitId: fixtureIdentity(401), text: "A", reason: "Reason A" };
  let saves = 0;
  invoke.mockImplementation((command: string, request: unknown) => {
    if (command === "read_context_revision") return Promise.resolve(null);
    if (command === "resolve_terms") return Promise.resolve({ unitId: fixtureIdentity(401), locale: "zh-CN", sourceRevisionId: fixtureIdentity(402), entries: [] });
    if (command === "tm_suggestions") return Promise.resolve([]);
    if (command === "save_context") {
      saves++;
      return mode === "delayed" ? pendingSave : Promise.resolve(saves === 1 ? { ...saved, revisionId: "invalid" } : saved);
    }
    return originalInvoke(command, request);
  });
  render(<ResourceWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" });
  await user.click(screen.getByRole("tab", { name: "Context and memory" }));
  await user.click(screen.getByRole("button", { name: "barrel" }));
  const context = await screen.findByRole("textbox", { name: "Context you provide" });
  const reason = screen.getByRole("textbox", { name: "Reason or source note" });
  await user.type(context, "A");
  await user.type(reason, "Reason A");
  await user.click(screen.getByRole("button", { name: "Save context" }));
  await waitFor(() => expect(saves).toBe(1));
  if (mode === "replayed") await screen.findByRole("button", { name: "Check or retry the same action" });
  await user.type(context, "B");
  await user.type(reason, "B");
  if (mode === "delayed") await act(async () => finishSave(saved));
  else await user.click(screen.getByRole("button", { name: "Check or retry the same action" }));
  await screen.findByText("Saved. Earlier revisions remain available.");
  expect(context).toHaveValue("AB");
  expect(reason).toHaveValue("Reason AB");
  const requests = invoke.mock.calls.filter(([command]) => command === "save_context").map(([, payload]) => payload.request);
  expect(requests).toHaveLength(mode === "delayed" ? 1 : 2);
  expect(requests[0].context).toMatchObject({ text: "A", reason: "Reason A" });
  if (mode === "replayed") expect(requests[1]).toEqual(requests[0]);
  expect(screen.getByRole("button", { name: "Discard edits" })).toBeEnabled();
});

let resourceOwner: ReturnType<typeof useResourceDraftSession>;
let resourceReads: ReturnType<typeof useSessionReads>;
let resourceRegistry: ReturnType<typeof useWorkbenchCommands>;
function ResourceView({ project: value }: { project: ProjectView }) {
  const owner = useResourceDraftSession(), reads = useSessionReads(), registry = useWorkbenchCommands();
  useEffect(() => { resourceOwner = owner; resourceReads = reads; resourceRegistry = registry; }, [owner, reads, registry]);
  return <ResourceWorkbench project={value} disabled={false} onOpenTranslation={() => true} />;
}
function termAcknowledgement(request: SaveTerm) {
  return { ...resourceFixture.responses.term, revisionId: fixtureIdentity(420), termId: request.termId ?? "new-term",
    locale: request.locale, source: request.source, aliases: request.aliases, target: request.target, protected: request.protected,
    scopeUnitId: request.scopeUnitId ?? null, reason: request.reason, previousRevisionId: request.expectedRevisionId ?? null,
    originKind: "manual", captureId: null, externalEntryId: null, removed: false };
}
function contextAcknowledgement(request: SaveContext) {
  return { revisionId: fixtureIdentity(421), unitId: request.unitId, locale: request.locale, text: request.text,
    reason: request.reason, previousRevisionId: request.expectedRevisionId ?? null };
}
function captureAcknowledgement(request: CaptureContext) {
  return { ...resourceFixture.responses.contextCapture, captureId: fixtureIdentity(422), unitId: request.unitId,
    locale: request.locale, sourceRevisionId: request.sourceRevisionId, budgetBytes: request.budgetBytes,
    included: resourceFixture.responses.contextCapture.included.map(item => item.kind === "source" ? { ...item, revisionId: request.sourceRevisionId } : item) };
}
function installResourceReads() {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_context_revision") return Promise.resolve(null);
    if (command === "resolve_terms") return Promise.resolve({ unitId: payload.request.unitId, locale: payload.request.locale, sourceRevisionId: fixtureIdentity(402), entries: [] });
    if (command === "tm_suggestions") return Promise.resolve([]);
    if (command === "read_resource_preview") return Promise.resolve(resourceFixture.responses.preview);
    return original(command, payload);
  });
}
function editTermA() {
  resourceOwner.editTerm({ source: "Barrel", aliases: ["Cask", "Drum"], target: "A", protected: false, scopeUnitId: null, reason: "Reviewed" }, "Cask,  Drum");
}

it("displays the first impact read after the impact tab is committed", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, payload: unknown) => name === "resource_impacts" ? Promise.resolve(resourceFixture.responses.impacts) : original(name, payload));
  render(<ResourceView project={project} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await user.click(screen.getByRole("tab", { name: "Affected work" }));
  await screen.findByRole("heading", { name: "barrel" });
  expect(screen.getByRole("button", { name: "Open translation" })).toBeEnabled();
  expect(invoke.mock.calls.filter(([name]) => name === "resource_impacts")).toHaveLength(1);
  expect(invoke.mock.calls.find(([name]) => name === "resource_impacts")![1].request).toMatchObject({ locale: "zh-CN", offset: 0, limit: 50 });
});

it("keeps both drafts and raw aliases through full view removal while a save completes", async () => {
  installResourceReads();
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "save_term" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  const view = render(<ResourceView project={project} />), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" });
  act(() => {
    resourceOwner.beginContext(page.rows[0], null); resourceOwner.editContext("Context B"); resourceOwner.editContextReason("Reason B"); editTermA();
  });
  let save!: Promise<void>;
  act(() => { save = resourceOwner.saveTerm(); });
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "save_term")).toBe(true));
  const request = invoke.mock.calls.find(([name]) => name === "save_term")![1].request.term;
  act(() => { resourceOwner.editTerm({ ...resourceOwner.current().termDraft, target: "B" }); resourceOwner.editTerm({ ...resourceOwner.current().termDraft, target: "A" }, "Cask,   Drum"); });
  view.rerender(null);
  expect(resourceOwner.inFlight()).toBe(true);
  await act(async () => { finish(termAcknowledgement(request)); await save; });
  view.rerender(<ResourceView project={project} />);
  expect(screen.getByRole("textbox", { name: "Preferred target form" })).toHaveValue("A");
  expect(screen.getByRole("textbox", { name: "Source aliases, separated by commas" })).toHaveValue("Cask,   Drum");
  expect(screen.getByText("The earlier version was saved. Your newer edits are still here; save them separately when ready.")).toBeVisible();
  expect(resourceOwner.termDirty()).toBe(true);
  await user.click(screen.getByRole("tab", { name: "Context and memory" }));
  expect(screen.getByRole("textbox", { name: "Context you provide" })).toHaveValue("Context B");
  expect(screen.getByRole("textbox", { name: "Reason or source note" })).toHaveValue("Reason B");
  expect(resourceOwner.current().selectedUnit?.sourceRevisionId).toBe(fixtureIdentity(402));
});

it.each(["term", "context"] as const)("retains a newer %s edit sequence even when the input returns to A", async kind => {
  installResourceReads();
  const original = invoke.getMockImplementation()!;
  const command = kind === "term" ? "save_term" : "save_context";
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((name: string, payload: unknown) => name === command ? new Promise(resolve => { finish = resolve; }) : original(name, payload));
  const view = render(<ResourceView project={project} />);
  act(() => { resourceOwner.beginContext(page.rows[0], null); resourceOwner.editContext("A"); resourceOwner.editContextReason("Reason A"); editTermA(); });
  let saving!: Promise<void>;
  act(() => { saving = kind === "term" ? resourceOwner.saveTerm() : resourceOwner.saveContext(); });
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === command)).toBe(true));
  const request = invoke.mock.calls.find(([name]) => name === command)![1].request;
  act(() => {
    if (kind === "term") { resourceOwner.editTerm({ ...resourceOwner.current().termDraft, target: "B" }); resourceOwner.editTerm({ ...resourceOwner.current().termDraft, target: "A" }); }
    else { resourceOwner.editContext("B"); resourceOwner.editContextReason("Reason B"); resourceOwner.editContext("A"); resourceOwner.editContextReason("Reason A"); }
  });
  view.rerender(null);
  await act(async () => { finish(kind === "term" ? termAcknowledgement(request.term) : contextAcknowledgement(request.context)); await saving; });
  view.rerender(<ResourceView project={project} />);
  expect(resourceOwner.current().notice).toBe("savedNewer");
  expect(kind === "term" ? resourceOwner.termDirty() : resourceOwner.contextDirty()).toBe(true);
  expect(resourceOwner.current().termDraft.target).toBe("A");
  expect(resourceOwner.current().aliasInput).toBe("Cask,  Drum");
  expect(resourceOwner.current().contextDraft).toBe("A");
  expect(resourceOwner.current().contextReason).toBe("Reason A");
  const reads = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, payload: unknown) => name === "read_terms" ? Promise.reject(new Error("read unavailable")) : reads(name, payload));
  await userEvent.setup().click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByText(/Current resource information could not be read/);
  expect(resourceOwner.current().termDraft.target).toBe("A");
  expect(resourceOwner.current().contextDraft).toBe("A");
  expect(kind === "term" ? resourceOwner.termDirty() : resourceOwner.contextDirty()).toBe(true);
});

it("confirms a decision after the view is removed without continuing its preview read", async () => {
  installResourceReads();
  const original = invoke.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((name: string, payload: unknown) => name === "decide_resource_entry" ? new Promise(resolve => { finish = resolve; }) : original(name, payload));
  const view = render(<ResourceView project={project} />), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await act(async () => { await resourceOwner.openPreview(resourceFixture.responses.capture); });
  const previewReads = () => invoke.mock.calls.filter(([name]) => name === "read_resource_preview");
  expect(previewReads()).toHaveLength(1);
  await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  await waitFor(() => expect(resourceReads.client.getQueryState(resourceReads.key(["resource-preview-current", resourceFixture.responses.capture.captureId]))).toMatchObject({ status: "success", fetchStatus: "idle", isInvalidated: false }));
  const readsBeforeDecision = previewReads().length;
  expect(readsBeforeDecision).toBe(2);
  await user.click(within(screen.getByRole("row", { name: /Barrel/ })).getByRole("button", { name: "Keep current" }));
  const pending = resourceOwner.current().pending;
  expect(pending?.kind).toBe("decision");
  view.rerender(null);
  await act(async () => { finish({ actionId: pending!.request.actionId, decision: "keep", revision: null }); });
  await waitFor(() => expect(resourceOwner.current().pending).toBeNull());
  expect(resourceOwner.current().previewNeedsRefresh).toBe(true);
  expect(previewReads()).toHaveLength(readsBeforeDecision);
  view.rerender(<ResourceView project={project} />);
  await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  let finishRead!: (value: unknown) => void;
  const reads = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, payload: unknown) => name === "read_resource_preview" ? new Promise(resolve => { finishRead = resolve; }) : reads(name, payload));
  await user.click(screen.getByRole("button", { name: "Read this captured file again" }));
  await waitFor(() => expect(previewReads()).toHaveLength(readsBeforeDecision + 1));
  view.rerender(null);
  await act(async () => { finishRead(resourceFixture.responses.preview); });
  await waitFor(() => expect(resourceOwner.inFlight()).toBe(false));
  expect(resourceOwner.current().preview).toBeNull();
  expect(resourceOwner.current().previewNeedsRefresh).toBe(true);
  expect(resourceOwner.current().previewCapture?.captureId).toBe(resourceFixture.responses.capture.captureId);
  expect(previewReads()).toHaveLength(readsBeforeDecision + 1);
  expect(invoke.mock.calls.filter(([name]) => name === "decide_resource_entry")).toHaveLength(1);
  invoke.mockImplementation(reads);
  view.rerender(<ResourceView project={project} />);
  await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  await user.click(screen.getByRole("button", { name: "Read this captured file again" }));
  await waitFor(() => expect(resourceOwner.current().previewNeedsRefresh).toBe(false));
  expect(previewReads()).toHaveLength(readsBeforeDecision + 2);
  expect(previewReads().every(([, payload]) => payload.request.captureId === resourceFixture.responses.capture.captureId)).toBe(true);
});

it.each([
  ["term", "locale"], ["term", "termId"], ["term", "target"], ["term", "previousRevisionId"],
  ["context", "previousRevisionId"], ["context", "unitId"], ["context", "text"], ["context", "reason"],
  ["decision", "actionId"], ["decision", "decision"],
  ["capture", "sourceRevisionId"], ["capture", "unitId"], ["capture", "locale"], ["capture", "budgetBytes"],
] as const)("retains the exact %s request after a mismatching %s and language removal", async (kind, mismatch) => {
  installResourceReads();
  const original = invoke.getMockImplementation()!;
  const command = { term: "save_term", context: "save_context", decision: "decide_resource_entry", capture: "capture_context" }[kind];
  let calls = 0;
  invoke.mockImplementation((name: string, payload: { request: { term: SaveTerm; context: SaveContext; decision: ResourceDecision; capture: CaptureContext } }) => {
    if (name !== command) return original(name, payload);
    const first = ++calls === 1;
    const wrong = first ? { [mismatch]: ({ locale: "fr", termId: "another-term", target: "Wrong target", previousRevisionId: fixtureIdentity(499),
      unitId: fixtureIdentity(499), text: "Wrong context", reason: "Wrong reason", actionId: fixtureIdentity(499), decision: "ignore",
      sourceRevisionId: fixtureIdentity(499), budgetBytes: 16 * 1024 + 1 } as const)[mismatch] } : {};
    if (kind === "term") return Promise.resolve({ ...termAcknowledgement(payload.request.term), ...wrong });
    if (kind === "context") return Promise.resolve({ ...contextAcknowledgement(payload.request.context), ...wrong });
    if (kind === "decision") return Promise.resolve({ actionId: payload.request.decision.actionId, decision: payload.request.decision.decision, revision: null, ...wrong });
    return Promise.resolve({ ...captureAcknowledgement(payload.request.capture), ...wrong });
  });
  const view = render(<ResourceView project={project} />);
  act(() => {
    if (kind === "term") resourceOwner.beginTerm({ ...resourceFixture.responses.term, termId: "existing-term", originKind: "manual", captureId: null, externalEntryId: null });
    resourceOwner.beginContext(page.rows[0], null); resourceOwner.editContext("A"); resourceOwner.editContextReason("Reason A"); editTermA();
  });
  if (kind === "decision") await act(async () => { await resourceOwner.openPreview(resourceFixture.responses.capture); });
  await act(async () => {
    if (kind === "term") await resourceOwner.saveTerm();
    if (kind === "context") await resourceOwner.saveContext();
    if (kind === "decision") await resourceOwner.decide("barrel", null, "keep");
    if (kind === "capture") await resourceOwner.captureContext();
  });
  const pending = resourceOwner.current().pending;
  expect(pending?.kind).toBe(kind);
  expect(resourceOwner.current().notice).toBe("unknown");
  act(() => { resourceOwner.editTerm({ ...resourceOwner.current().termDraft, target: "B" }, "Cask,    Drum"); resourceOwner.editContext("B"); resourceOwner.editContextReason("Reason B"); });
  const removed = { ...project, metadata: { ...project.metadata, targetLocales: ["fr"] } };
  view.rerender(null, removed);
  expect(resourceOwner.current().pending).toBe(pending);
  view.rerender(<ResourceView project={removed} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Glossary and context" }));
  expect(screen.getByRole("option", { name: "zh-CN (removed from project)" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "New term" })).toBeDisabled();
  const readsBefore = invoke.mock.calls.filter(([name]) => ["read_terms", "read_context_revision", "resolve_terms", "tm_suggestions"].includes(name)).length;
  await act(async () => { await resourceOwner.retryPending(); });
  const requests = invoke.mock.calls.filter(([name]) => name === command).map(([, payload]) => payload.request);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  expect(resourceOwner.current().pending).toBeNull();
  expect(resourceOwner.current().termDraft.target).toBe("B");
  expect(resourceOwner.current().aliasInput).toBe("Cask,    Drum");
  expect(resourceOwner.current().contextDraft).toBe("B");
  expect(resourceOwner.current().contextReason).toBe("Reason B");
  expect(invoke.mock.calls.filter(([name]) => ["read_terms", "read_context_revision", "resolve_terms", "tm_suggestions"].includes(name))).toHaveLength(readsBefore);
  if (kind === "capture") {
    view.rerender(null); view.rerender(<ResourceView project={removed} />);
    expect(resourceOwner.current().fixedContext?.captureId).toBe(fixtureIdentity(422));
  }
});

it("reserves original writes before identity resolves and rejects a removed fresh scope", async () => {
  installResourceReads();
  let finishIdentity!: (value: string) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finishIdentity = resolve; }) : original(command, payload));
  const view = render(<ResourceView project={project} />);
  act(() => { resourceOwner.beginContext(page.rows[0], null); resourceOwner.editContextReason("Reason"); editTermA(); });
  await act(async () => { await resourceOwner.openPreview(resourceFixture.responses.capture); });
  let saving!: Promise<void>;
  act(() => { saving = resourceOwner.saveTerm(); });
  await waitFor(() => expect(resourceOwner.inFlight()).toBe(true));
  await act(async () => { await resourceOwner.saveContext(); await resourceOwner.captureContext(); await resourceOwner.decide("barrel", null, "keep"); await resourceOwner.chooseFile(); });
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  expect(resourceOwner.beginContext({ ...page.rows[0], sourceRevisionId: fixtureIdentity(499) }, null)).toBe(false);
  view.rerender(<ResourceView project={{ ...project, metadata: { ...project.metadata, targetLocales: ["fr"] } }} />);
  await act(async () => { finishIdentity(fixtureIdentity(430)); await saving; });
  expect(invoke.mock.calls.some(([name]) => ["save_term", "save_context", "capture_context", "choose_resource_file"].includes(name))).toBe(false);
  expect(resourceOwner.current().termDraft.target).toBe("A");
  expect(resourceOwner.inFlight()).toBe(false);
});

it("rebases a clean removed language and recovers a picker uncertainty through an existing capture", async () => {
  installResourceReads();
  const capture = { ...resourceFixture.responses.capture, targetLocale: "fr" };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, payload: unknown) => {
    if (name === "choose_resource_file") return Promise.reject(new Error("picker reply lost"));
    if (name === "list_resource_captures") return Promise.resolve([capture]);
    if (name === "read_resource_preview") return Promise.resolve({ ...resourceFixture.responses.preview, capture });
    return original(name, payload);
  });
  const view = render(<ResourceView project={project} />), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  const next = { ...project, metadata: { ...project.metadata, targetLocales: ["fr"] } };
  view.rerender(<ResourceView project={next} />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("fr"));
  expect(screen.queryByRole("option", { name: "zh-CN (removed from project)" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose glossary file" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Choose glossary file" }));
  await screen.findByText(/The file selection result is uncertain/);
  expect(resourceOwner.current().pending).toBeNull();
  expect(screen.queryByRole("button", { name: "Check or retry the same action" })).not.toBeInTheDocument();
  view.rerender(null); view.rerender(<ResourceView project={next} />);
  await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  await user.click(await screen.findByRole("button", { name: `${capture.resourceId} · ${capture.revision}` }));
  await waitFor(() => expect(resourceOwner.current().preview?.capture.captureId).toBe(capture.captureId));
  expect(invoke.mock.calls.filter(([name]) => name === "choose_resource_file")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(0);
  expect(invoke.mock.calls.filter(([name]) => name === "read_resource_preview")).toHaveLength(1);
});

it("retains the chosen capture after preview failure and uses its actual language for decisions", async () => {
  installResourceReads();
  const capture = { ...resourceFixture.responses.capture, targetLocale: "fr" };
  const preview = { ...resourceFixture.responses.preview, capture };
  const original = invoke.getMockImplementation()!;
  let previews = 0, decisions = 0;
  invoke.mockImplementation((command: string, payload: { request: { decision: ResourceDecision } }) => {
    if (command === "choose_resource_file") return Promise.resolve(capture);
    if (command === "read_resource_preview") return ++previews === 1 ? Promise.reject(new Error("read failed")) : Promise.resolve(preview);
    if (command === "decide_resource_entry") return ++decisions === 1 ? Promise.reject(new Error("reply lost")) : Promise.resolve({ actionId: payload.request.decision.actionId, decision: payload.request.decision.decision, revision: null });
    return original(command, payload);
  });
  const available = { ...project, metadata: { ...project.metadata, targetLocales: ["zh-CN", "fr"] } };
  const view = render(<ResourceView project={available} />), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" });
  await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  await user.click(screen.getByRole("button", { name: "Choose glossary file" }));
  await screen.findByRole("button", { name: "Read this captured file again" });
  view.rerender(null); view.rerender(<ResourceView project={available} />);
  await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  await user.click(screen.getByRole("button", { name: "Read this captured file again" }));
  const row = await screen.findByRole("row", { name: /Barrel/ });
  expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("zh-CN");
  await user.click(within(row).getByRole("button", { name: "Keep current" }));
  await waitFor(() => expect(resourceOwner.current().pending?.kind).toBe("decision"));
  const pending = resourceOwner.current().pending;
  expect(pending?.kind === "decision" && pending.locale).toBe("fr");
  view.rerender(<ResourceView project={project} />);
  expect(within(screen.getByRole("row", { name: /Barrel/ })).getByRole("button", { name: "Keep current" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Check or retry the same action" }));
  await waitFor(() => expect(resourceOwner.current().pending).toBeNull());
  const requests = invoke.mock.calls.filter(([name]) => name === "decide_resource_entry").map(([, payload]) => payload.request);
  expect(requests[1]).toEqual(requests[0]); expect(requests[0].decision.captureId).toBe(capture.captureId);
  expect(requests[0].decision.entryId).toBe("barrel");
  expect(invoke.mock.calls.filter(([name]) => name === "choose_resource_file")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "read_resource_preview")).toHaveLength(2);
});

it("does not continue a decision or an identity allocation after the project owner is replaced", async () => {
  installResourceReads();
  const original = invoke.getMockImplementation()!;
  let finishDecision!: (value: unknown) => void;
  invoke.mockImplementation((command: string, payload: unknown) => command === "decide_resource_entry" ? new Promise(resolve => { finishDecision = resolve; }) : original(command, payload));
  const view = render(<ResourceView project={project} />);
  await act(async () => { await resourceOwner.openPreview(resourceFixture.responses.capture); });
  let decision!: Promise<void>;
  act(() => { decision = resourceOwner.decide("barrel", null, "keep"); });
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "decide_resource_entry")).toBe(true));
  const request = invoke.mock.calls.find(([name]) => name === "decide_resource_entry")![1].request.decision;
  const next = { ...project, sessionToken: "next-session", metadata: { ...project.metadata, projectId: fixtureIdentity(440) } };
  view.rerender(<ResourceView project={next} />);
  await act(async () => { finishDecision({ actionId: request.actionId, decision: request.decision, revision: null }); await decision; });
  expect(resourceOwner.current().preview).toBeNull();
  expect(invoke.mock.calls.filter(([name]) => name === "read_resource_preview")).toHaveLength(1);
  let finishIdentity!: (value: string) => void;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finishIdentity = resolve; }) : original(command, payload));
  act(editTermA);
  let saving!: Promise<void>;
  act(() => { saving = resourceOwner.saveTerm(); });
  view.rerender(null, project);
  await act(async () => { finishIdentity(fixtureIdentity(441)); await saving; });
  expect(invoke.mock.calls.some(([name]) => name === "save_term")).toBe(false);
});

const resourceScope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "resources" as const };
function decisionInput(): ResourceDecisionCommandPayload {
  const value = resourceOwner.current().preview!, row = value.rows[0];
  return { kind: "resource-decision", captureId: value.capture.captureId, digest: value.capture.digest, locale: value.capture.targetLocale,
    entryId: row.entry.id, expectedRevisionId: row.current?.revisionId ?? null, decision: "keep", rowKind: row.kind, scopeUnitId: row.scopeUnitId ?? null };
}
it.each(["read_content_scope", "read_source_content", "read_terms"])("keeps %s failures distinct from empty resources and blocks fresh saves", async failing => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, payload: unknown) => name === failing ? Promise.reject(new Error("current read failed")) : original(name, payload));
  render(<ResourceView project={project} />); await userEvent.setup().click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("button", { name: "Retry this read" }); act(editTermA);
  expect(screen.queryByText("Import source content before managing resources.")).not.toBeInTheDocument();
  if (failing === "read_terms") expect(screen.queryByText("No terms have been adopted for this language.")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save term" })).toBeDisabled();
  const value = resourceOwner.current(), input = { kind: "resource-term" as const, locale: value.locale, termId: null, expectedRevisionId: null, editSeq: value.termSeq };
  expect(resourceRegistry.dispatch("resource.save-term", resourceScope, input)).toBe(false);
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity")).toBe(false);
  invoke.mockImplementation(original); await refreshWorkbenchReads(["source", "resources"]);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save term" })).toBeEnabled());
  expect(resourceOwner.current().aliasInput).toBe("Cask,  Drum");
});
it("resets the source cursor for a changed snapshot without changing captured drafts", async () => {
  const original = invoke.getMockImplementation()!;
  let scope = page.scope;
  const later = sourcePageFixture({ ...page, total: 51, rows: [sourceRowFixture(page.rows[0], { ordinal: 50, key: "later", text: "Later" })], nextOrdinal: null });
  const next = sourcePageFixture({ snapshotId: fixtureIdentity(451), scope: { revision: "3", currentSnapshot: fixtureIdentity(451) },
    rows: [sourceRowFixture({ unitId: fixtureIdentity(452), sourceRevisionId: fixtureIdentity(453) }, { ordinal: 0, key: "new source", text: "Changed" })], nextOrdinal: null });
  invoke.mockImplementation((name: string, payload: { request: { after: number; snapshotId: string } }) => {
    if (name === "read_content_scope") return Promise.resolve(scope);
    if (name === "read_source_content") return Promise.resolve(scope === page.scope ? (payload.request.after === 50 ? later : { ...page, total: 51, nextOrdinal: 50 }) : next);
    return original(name, payload);
  });
  render(<ResourceView project={project} />); await userEvent.setup().click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" });
  await userEvent.setup().click(screen.getByRole("button", { name: "Next page" })); await screen.findByRole("option", { name: "later" });
  act(() => { resourceOwner.beginContext(page.rows[0], null); resourceOwner.editContext("Captured context"); resourceOwner.editContextReason("Original reason"); editTermA(); });
  const selected = resourceOwner.current().selectedUnit; scope = next.scope; await refreshWorkbenchReads(["source"]);
  await screen.findByRole("option", { name: "new source" });
  expect(invoke.mock.calls.filter(([name]) => name === "read_source_content").at(-1)![1].request).toMatchObject({ snapshotId: next.snapshotId, after: 0 });
  expect(resourceOwner.current().selectedUnit).toBe(selected); expect(resourceOwner.current().contextDraft).toBe("Captured context");
  expect(resourceOwner.current().aliasInput).toBe("Cask,  Drum"); expect(resourceOwner.contextDirty()).toBe(true);
});
it("loads term and revision pages cumulatively and retries each failed next cursor", async () => {
  const original = invoke.getMockImplementation()!, user = userEvent.setup();
  const terms = Array.from({ length: 201 }, (_, index) => ({ ...resourceFixture.responses.term, termId: `term-${index}`, revisionId: fixtureIdentity(1000 + index),
    source: `Term ${index}`, target: `Target ${index}`, originKind: "manual", captureId: null, externalEntryId: null }));
  let termFailure = true, historyFailure = true;
  invoke.mockImplementation((name: string, payload: { request: { afterTermId: string | null; offset: number } }) => {
    if (name === "read_terms") {
      const cursor = payload.request.afterTermId, offset = cursor ? Number(cursor.split("-")[1]) + 1 : 0;
      if (offset === 100 && termFailure) { termFailure = false; return Promise.reject(new Error("next terms failed")); }
      return Promise.resolve(terms.slice(offset, offset + 100));
    }
    if (name === "read_term_history") {
      const offset = payload.request.offset;
      if (offset === 100 && historyFailure) { historyFailure = false; return Promise.reject(new Error("next history failed")); }
      return Promise.resolve(terms.slice(offset, offset + 100).map(term => ({ ...term, termId: "term-0" })));
    }
    return original(name, payload);
  });
  render(<ResourceView project={project} />); await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("button", { name: "Term 99 → Target 99" });
  await user.click(screen.getAllByRole("button", { name: "Next page" }).find(button => !button.hasAttribute("disabled"))!);
  await user.click(await screen.findByRole("button", { name: "Retry this read" })); await screen.findByRole("button", { name: "Term 199 → Target 199" });
  await user.click(screen.getAllByRole("button", { name: "Next page" }).find(button => !button.hasAttribute("disabled"))!);
  await screen.findByRole("button", { name: "Term 200 → Target 200" });
  expect(screen.getByRole("button", { name: "Term 0 → Target 0" })).toBeVisible();
  expect(invoke.mock.calls.filter(([name]) => name === "read_terms").map(([, payload]) => payload.request.afterTermId)).toEqual([null, "term-99", "term-99", "term-199"]);
  await user.click(screen.getByRole("button", { name: "Term 0 → Target 0" }));
  const history = screen.getByText("Earlier revisions").closest("details")!; await user.click(within(history).getByText("Earlier revisions"));
  await waitFor(() => expect(within(history).getAllByRole("listitem")).toHaveLength(100));
  await user.click(within(history).getByRole("button", { name: "Next page" }));
  await user.click(await within(history).findByRole("button", { name: "Retry this read" }));
  await waitFor(() => expect(within(history).getAllByRole("listitem")).toHaveLength(200));
  await user.click(within(history).getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(within(history).getAllByRole("listitem")).toHaveLength(201));
  expect(invoke.mock.calls.filter(([name]) => name === "read_term_history").map(([, payload]) => payload.request.offset)).toEqual([0, 100, 100, 200]);
});
it("retries the failed impact page and invalidates the first page when returning to it", async () => {
  const original = invoke.getMockImplementation()!; let firstReads = 0, failed = false;
  invoke.mockImplementation((name: string, payload: { request: { offset: number } }) => {
    if (name !== "resource_impacts") return original(name, payload);
    if (payload.request.offset === 50 && !failed) { failed = true; return Promise.reject(new Error("impact page failed")); }
    if (payload.request.offset === 0) firstReads++;
    return Promise.resolve({ ...resourceFixture.responses.impacts, totalAffected: 55, nextOffset: payload.request.offset === 0 ? 50 : null });
  });
  render(<ResourceView project={project} />); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" })); await user.click(screen.getByRole("tab", { name: "Affected work" }));
  await screen.findByRole("heading", { name: "barrel" }); await user.click(screen.getByRole("button", { name: "Next page" }));
  await user.click(await screen.findByRole("button", { name: "Retry this read" })); await screen.findByRole("heading", { name: "barrel" });
  await user.click(screen.getByRole("button", { name: "First page" })); await waitFor(() => expect(firstReads).toBe(2));
  expect(invoke.mock.calls.filter(([name]) => name === "resource_impacts").map(([, payload]) => payload.request.offset)).toEqual([0, 50, 50, 0]);
});
it("refreshes the current comparison without adopting it or changing its original source basis", async () => {
  installResourceReads(); const original = invoke.getMockImplementation()!; let current = resourceFixture.responses.preview as ResourcePreview, scope = page.scope;
  invoke.mockImplementation((name: string, payload: unknown) => name === "read_resource_preview" ? Promise.resolve(current) : name === "read_content_scope" ? Promise.resolve(scope)
    : name === "read_source_content" ? Promise.resolve({ ...page, scope, snapshotId: scope.currentSnapshot }) : original(name, payload));
  render(<ResourceView project={project} />); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" }); await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  await act(async () => { await resourceOwner.openPreview(resourceFixture.responses.capture); });
  const baseline = resourceOwner.current().preview, sourceBasis = resourceOwner.current().previewSourceBasis;
  current = { ...current, rows: current.rows.map(row => ({ ...row, kind: "edited" as const, current: { ...resourceFixture.responses.preview.removed[0], originKind: "external" as const, revisionId: fixtureIdentity(470), termId: "external:contract-glossary:barrel", externalEntryId: "barrel", source: "Barrel", target: "Changed current form" } })) };
  await refreshWorkbenchReads(["resources"]);
  await screen.findByText(/Current source or glossary information differs/);
  await waitFor(() => expect(resourceReads.client.getQueryState(resourceReads.key(["resource-preview-current", current.capture.captureId]))).toMatchObject({ status: "success", fetchStatus: "idle", isInvalidated: false }));
  expect(resourceOwner.current().preview).toBe(baseline); expect(resourceOwner.current().previewSourceBasis).toBe(sourceBasis);
  expect(resourceRegistry.dispatch("resource.decide-entry", resourceScope, decisionInput())).toBe(false);
  await user.click(screen.getByRole("button", { name: "Read this captured file again" }));
  await waitFor(() => expect(resourceOwner.current().preview?.rows[0].current?.revisionId).toBe(fixtureIdentity(470)));
  // A new source scope can leave a project-wide preview row byte-for-byte equal.
  const accepted = resourceOwner.current().preview, acceptedBasis = resourceOwner.current().previewSourceBasis;
  scope = { ...scope, revision: "3", currentSnapshot: fixtureIdentity(454) }; await refreshWorkbenchReads(["source"]);
  await waitFor(() => expect(resourceReads.client.getQueryData(resourceReads.key(["resource-source-scope"]))).toMatchObject(scope));
  await waitFor(() => expect(resourceReads.client.getQueryState(resourceReads.key(["resource-preview-current", current.capture.captureId]))).toMatchObject({ status: "success", fetchStatus: "idle", isInvalidated: false }));
  expect(resourceOwner.current().preview).toBe(accepted); expect(resourceOwner.current().previewSourceBasis).toBe(acceptedBasis);
  expect(resourceRegistry.dispatch("resource.decide-entry", resourceScope, decisionInput())).toBe(false);
  await user.click(screen.getByRole("button", { name: "Read this captured file again" }));
  await waitFor(() => expect(resourceOwner.current().previewSourceBasis).toEqual({ revision: "3", snapshotId: fixtureIdentity(454) }));
  await waitFor(() => expect(resourceRegistry.describe("resource.decide-entry", resourceScope, decisionInput())?.availability.enabled).toBe(true));
});
it("retains fixed evidence, original comparison and edits when automatic reads fail", async () => {
  installResourceReads(); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, payload: { request: { capture: CaptureContext } }) => name === "capture_context" ? Promise.resolve(captureAcknowledgement(payload.request.capture)) : original(name, payload));
  render(<ResourceView project={project} />); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" });
  await act(async () => { resourceOwner.beginContext(page.rows[0], null); await resourceOwner.captureContext(); await resourceOwner.openPreview(resourceFixture.responses.capture); });
  act(editTermA); const value = resourceOwner.current(); await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  invoke.mockImplementation((name: string, payload: unknown) => ["read_resource_preview", "list_resource_captures"].includes(name) ? Promise.reject(new Error("query failure")) : original(name, payload));
  await refreshWorkbenchReads(["resources"]); await screen.findAllByRole("button", { name: "Retry this read" });
  expect(resourceOwner.current().preview).toBe(value.preview); expect(resourceOwner.current().fixedContext).toBe(value.fixedContext);
  expect(resourceOwner.current().previewSourceBasis).toBe(value.previewSourceBasis); expect(resourceOwner.current().aliasInput).toBe("Cask,  Drum");
  expect(resourceRegistry.dispatch("resource.decide-entry", resourceScope, decisionInput())).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "capture_context")).toHaveLength(1);
});
it.each(["source", "resources"] as const)("rejects a fresh decision when %s evidence changes while identity is pending", async affected => {
  installResourceReads(); const original = invoke.getMockImplementation()!; let finish!: (identity: string) => void, scope = page.scope;
  let preview = resourceFixture.responses.preview as ResourcePreview;
  invoke.mockImplementation((name: string, payload: unknown) => name === "create_execution_identity" ? new Promise(resolve => { finish = resolve; })
    : name === "read_content_scope" ? Promise.resolve(scope) : name === "read_source_content" ? Promise.resolve({ ...page, scope, snapshotId: scope.currentSnapshot })
    : name === "read_resource_preview" ? Promise.resolve(preview) : original(name, payload));
  render(<ResourceView project={project} />); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" }); await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  await act(async () => { await resourceOwner.openPreview(resourceFixture.responses.capture); });
  await waitFor(() => expect(resourceRegistry.describe("resource.decide-entry", resourceScope, decisionInput())?.availability.enabled).toBe(true));
  act(() => { expect(resourceRegistry.dispatch("resource.decide-entry", resourceScope, decisionInput())).toBe(true); });
  await waitFor(() => expect(resourceOwner.inFlight()).toBe(true));
  expect(resourceRegistry.dispatch("resource.decide-entry", resourceScope, decisionInput())).toBe(false);
  expect(resourceRegistry.dispatch("resource.choose-file", resourceScope, { kind: "resource-locale", locale: "zh-CN" })).toBe(false);
  if (affected === "source") scope = { ...scope, revision: "3", currentSnapshot: fixtureIdentity(455) };
  else preview = { ...preview, rows: preview.rows.map(row => ({ ...row, scopeUnitId: fixtureIdentity(456) })) };
  await refreshWorkbenchReads([affected]); await act(async () => finish(fixtureIdentity(457)));
  await waitFor(() => expect(resourceOwner.inFlight()).toBe(false));
  expect(invoke.mock.calls.some(([name]) => name === "decide_resource_entry")).toBe(false);
  expect(resourceOwner.current().pending).toBeNull(); expect(resourceOwner.current().failure).toBe("resource-basis");
});
it("rechecks exact decision and translation targets at the actual registry entry points", async () => {
  installResourceReads(); const original = invoke.getMockImplementation()!; const openTranslation = vi.fn(() => true);
  function CommandView({ project: value }: { project: ProjectView }) {
    const owner = useResourceDraftSession(), reads = useSessionReads(), registry = useWorkbenchCommands();
    useEffect(() => { resourceOwner = owner; resourceReads = reads; resourceRegistry = registry; }, [owner, reads, registry]);
    return <ResourceWorkbench project={value} disabled={false} onOpenTranslation={openTranslation}/>;
  }
  invoke.mockImplementation((name: string, payload: unknown) => name === "resource_impacts" ? Promise.resolve(resourceFixture.responses.impacts) : original(name, payload));
  const view = render(<CommandView project={project} />); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" }); await user.click(screen.getByRole("tab", { name: "Resource updates" }));
  await act(async () => { await resourceOwner.openPreview(resourceFixture.responses.capture); }); const input = decisionInput();
  for (const changed of [{ digest: "other" }, { locale: "fr" }, { entryId: "other" }, { rowKind: "removed" as const }, { expectedRevisionId: fixtureIdentity(458) }, { scopeUnitId: fixtureIdentity(458) }]) {
    expect(resourceRegistry.dispatch("resource.decide-entry", resourceScope, { ...input, ...changed })).toBe(false);
  }
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity")).toBe(false);
  await user.click(screen.getByRole("tab", { name: "Affected work" })); await screen.findByRole("heading", { name: "barrel" });
  const item = resourceFixture.responses.impacts.items[0];
  const translation: ResourceTranslationCommandPayload = { kind: "resource-translation", locale: "zh-CN", target: { unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, key: item.nativeKey, sourceText: item.sourceText }, evidenceKind: "impact", evidenceId: item.translationRevisionId, selectionId: item.selectionEventId };
  expect(resourceRegistry.dispatch("resource.open-translation", resourceScope, { ...translation, evidenceId: fixtureIdentity(459) })).toBe(false);
  expect(resourceRegistry.dispatch("resource.open-translation", resourceScope, { ...translation, target: { ...translation.target, unitId: fixtureIdentity(459) } })).toBe(false);
  expect(resourceRegistry.dispatch("resource.open-translation", resourceScope, { ...translation, selectionId: fixtureIdentity(459) })).toBe(false);
  expect(openTranslation).not.toHaveBeenCalled(); await user.click(screen.getByRole("button", { name: "Open translation" }));
  expect(openTranslation).toHaveBeenCalledWith(translation.target, "zh-CN", undefined);
  view.rerender(null); expect(resourceRegistry.dispatch("resource.decide-entry", resourceScope, input)).toBe(false);
});

it.each(["term", "context", "decision", "capture"] as const)("reconciles the original %s through its registered command despite failed current queries", async kind => {
  installResourceReads(); const original = invoke.getMockImplementation()!;
  const command = { term: "save_term", context: "save_context", decision: "decide_resource_entry", capture: "capture_context" }[kind];
  let writes = 0;
  invoke.mockImplementation((name: string, payload: { request: { term: SaveTerm; context: SaveContext; decision: ResourceDecision; capture: CaptureContext } }) => {
    if (name !== command) return original(name, payload);
    const mismatch = ++writes === 1;
    if (kind === "term") return Promise.resolve({ ...termAcknowledgement(payload.request.term), ...(mismatch ? { target: "Wrong" } : {}) });
    if (kind === "context") return Promise.resolve({ ...contextAcknowledgement(payload.request.context), ...(mismatch ? { text: "Wrong" } : {}) });
    if (kind === "decision") return Promise.resolve({ actionId: mismatch ? fixtureIdentity(480) : payload.request.decision.actionId, decision: payload.request.decision.decision, revision: null });
    return Promise.resolve({ ...captureAcknowledgement(payload.request.capture), ...(mismatch ? { budgetBytes: 1 } : {}) });
  });
  render(<ResourceView project={project}/>);
  act(() => { resourceOwner.beginContext(page.rows[0], null); resourceOwner.editContext("Original context"); resourceOwner.editContextReason("Original reason"); editTermA(); });
  if (kind === "decision") await act(async () => { await resourceOwner.openPreview(resourceFixture.responses.capture); });
  await act(async () => {
    if (kind === "term") await resourceOwner.saveTerm();
    else if (kind === "context") await resourceOwner.saveContext();
    else if (kind === "decision") await resourceOwner.decide("barrel", null, "keep");
    else await resourceOwner.captureContext();
  });
  const pending = resourceOwner.current().pending!; expect(pending.kind).toBe(kind);
  act(() => { resourceOwner.editTerm({ ...resourceOwner.current().termDraft, target: "New input" }, "Cask,   Drum"); resourceOwner.editContext("New context"); });
  const writeInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, payload: unknown) => ["read_content_scope", "read_source_content", "read_terms"].includes(name) ? Promise.reject(new Error("read unavailable")) : writeInvoke(name, payload));
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Glossary and context" })); await screen.findAllByRole("button", { name: "Retry this read" });
  const input = { kind: "resource-pending" as const, pendingKind: kind, actionId: pending.request.actionId };
  expect(resourceRegistry.dispatch("resource.retry-pending", resourceScope, { ...input, actionId: fixtureIdentity(481) })).toBe(false);
  expect(screen.getByRole("button", { name: "Check or retry the same action" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Check or retry the same action" })); await waitFor(() => expect(resourceOwner.current().pending).toBeNull());
  const requests = invoke.mock.calls.filter(([name]) => name === command).map(([, payload]) => payload.request);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  expect(resourceOwner.current().termDraft.target).toBe("New input"); expect(resourceOwner.current().contextDraft).toBe("New context");
});
it("waits for resolution before showing empty memory or enabling context actions", async () => {
  installResourceReads(); const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void;
  invoke.mockImplementation((name: string, payload: unknown) => name === "resolve_terms" ? new Promise(resolve => { finish = resolve; }) : original(name, payload));
  render(<ResourceView project={project}/>); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" }); await user.click(screen.getByRole("tab", { name: "Context and memory" }));
  await user.click(screen.getByRole("button", { name: "barrel" })); await screen.findByRole("textbox", { name: "Context you provide" });
  await waitFor(() => expect(resourceReads.client.getQueryState(resourceReads.key(["resource-tm", fixtureIdentity(401), "zh-CN", fixtureIdentity(402), 0, 20]))?.status).toBe("success"));
  expect(screen.queryByText("No matching saved translations.")).not.toBeInTheDocument();
  act(() => resourceOwner.editContextReason("Reason")); expect(screen.getByRole("button", { name: "Save context" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Capture current input" })).toBeDisabled();
  await act(async () => finish({ unitId: fixtureIdentity(401), locale: "zh-CN", sourceRevisionId: fixtureIdentity(402), entries: [] }));
  await screen.findByText("No matching saved translations."); expect(screen.getByRole("button", { name: "Save context" })).toBeEnabled();
});
it("opens the explicitly selected memory revision and blocks a stale suggestion", async () => {
  installResourceReads(); const original = invoke.getMockImplementation()!, openTranslation = vi.fn(() => true);
  let suggestions = resourceFixture.responses.suggestions.concat([{ ...resourceFixture.responses.suggestions[0], translationRevisionId: fixtureIdentity(482), translationText: "Second suggestion" }]);
  invoke.mockImplementation((name: string, payload: unknown) => name === "tm_suggestions" ? Promise.resolve(suggestions) : original(name, payload));
  function MemoryView({ project: value }: { project: ProjectView }) {
    const owner = useResourceDraftSession(), registry = useWorkbenchCommands(); useEffect(() => { resourceOwner = owner; resourceRegistry = registry; }, [owner, registry]);
    return <ResourceWorkbench project={value} disabled={false} onOpenTranslation={openTranslation}/>;
  }
  render(<MemoryView project={project}/>); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" }); await user.click(screen.getByRole("tab", { name: "Context and memory" })); await user.click(screen.getByRole("button", { name: "barrel" }));
  await screen.findByText(/Second suggestion/);
  const input: ResourceTranslationCommandPayload = { kind: "resource-translation", locale: "zh-CN", target: { unitId: fixtureIdentity(401), sourceRevisionId: fixtureIdentity(402), key: "barrel", sourceText: "Barrel" }, evidenceKind: "tm", evidenceId: fixtureIdentity(482), selectionId: null };
  suggestions = suggestions.slice(0, 1); await refreshWorkbenchReads(["translation"]);
  await waitFor(() => expect(screen.queryByText(/Second suggestion/)).not.toBeInTheDocument());
  expect(resourceRegistry.dispatch("resource.open-translation", resourceScope, input)).toBe(false); expect(openTranslation).not.toHaveBeenCalled();
  suggestions = suggestions.concat([{ ...suggestions[0], translationRevisionId: fixtureIdentity(482), translationText: "Second suggestion" }]); await refreshWorkbenchReads(["translation"]);
  const freshRow = (await screen.findByText(/Second suggestion/)).closest("li")!;
  await user.click(within(freshRow).getByRole("button", { name: "Use as translation draft" }));
  expect(openTranslation).toHaveBeenCalledWith(input.target, "zh-CN", "Second suggestion");
});
it.each(["hidden", "removed"] as const)("ignores late resource-list results after the view is %s and rereads on return", async mode => {
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void, terms = 0;
  const stale = { ...resourceFixture.responses.term, termId: "stale", source: "Obsolete list term" }, fresh = { ...stale, termId: "fresh", source: "Current list term" };
  invoke.mockImplementation((name: string, payload: unknown) => name === "read_terms" ? (++terms === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([fresh])) : original(name, payload));
  const view = render(<ResourceView project={project}/>), user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "barrel" }); act(editTermA);
  if (mode === "hidden") await user.click(screen.getByRole("button", { name: "Back to overview" })); else view.rerender(null);
  const before = terms; await refreshWorkbenchReads(["resources"]); await act(async () => finish([stale]));
  expect(terms).toBe(before); expect(resourceOwner.current().termDraft.target).toBe("A");
  if (mode === "hidden") await user.click(screen.getByRole("button", { name: "Glossary and context" })); else view.rerender(<ResourceView project={project}/>);
  await screen.findByRole("button", { name: /Current list term/ }); expect(screen.queryByRole("button", { name: /Obsolete list term/ })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Source aliases, separated by commas" })).toHaveValue("Cask,  Drum"); expect(terms).toBe(2);
});
it("starts locale reads from the beginning and ignores a late previous-language page", async () => {
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void;
  invoke.mockImplementation((name: string, payload: { request: { locale: string } }) => name === "read_terms" ? (payload.request.locale === "zh-CN" ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve([{ ...resourceFixture.responses.term, termId: "french", locale: "fr", source: "French term" }])) : original(name, payload));
  render(<ResourceView project={{ ...project, metadata: { ...project.metadata, targetLocales: ["zh-CN", "fr"] } }}/>); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" })); await screen.findByRole("option", { name: "barrel" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Target language" }), "fr"); await screen.findByRole("button", { name: /French term/ });
  await act(async () => finish([{ ...resourceFixture.responses.term, source: "Obsolete Chinese term" }]));
  expect(screen.queryByRole("button", { name: /Obsolete Chinese term/ })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_terms").map(([, payload]) => [payload.request.locale, payload.request.afterTermId])).toEqual([["zh-CN", null], ["fr", null]]);
});


it.each(["term", "context", "decision", "capture"] as const)("retains the original unknown %s after an explicit retry is rejected", async kind => {
  installResourceReads(); const native = invoke.getMockImplementation()!;
  const command = { term: "save_term", context: "save_context", decision: "decide_resource_entry", capture: "capture_context" }[kind];
  let writes = 0;
  invoke.mockImplementation((name: string, payload: { request: { term: SaveTerm; context: SaveContext; decision: ResourceDecision; capture: CaptureContext } }) => {
    if (name !== command) return native(name, payload);
    writes++;
    if (writes === 1) return Promise.reject(new Error("Lost resource response"));
    if (writes === 2) return Promise.reject(errorFixture.errors[1]);
    if (kind === "term") return Promise.resolve(termAcknowledgement(payload.request.term));
    if (kind === "context") return Promise.resolve(contextAcknowledgement(payload.request.context));
    if (kind === "decision") return Promise.resolve({ actionId: payload.request.decision.actionId, decision: payload.request.decision.decision, revision: null });
    return Promise.resolve(captureAcknowledgement(payload.request.capture));
  });
  const view = render(<ResourceView project={project} />);
  act(() => { resourceOwner.beginContext(page.rows[0], null); resourceOwner.editContext("Original context"); resourceOwner.editContextReason("Original reason"); editTermA(); });
  if (kind === "decision") await act(async () => { await resourceOwner.openPreview(resourceFixture.responses.capture); });
  await act(async () => {
    if (kind === "term") await resourceOwner.saveTerm();
    else if (kind === "context") await resourceOwner.saveContext();
    else if (kind === "decision") await resourceOwner.decide("barrel", null, "keep");
    else await resourceOwner.captureContext();
  });
  const original = resourceOwner.current().pending;
  expect(original?.kind).toBe(kind); expect(resourceOwner.current().pendingUncertain).toBe(true);
  act(() => { resourceOwner.editTerm({ ...resourceOwner.current().termDraft, target: "New B" }); resourceOwner.editContext("New context B"); });
  view.rerender(null, project); view.rerender(<ResourceView project={project} />, project);
  await act(async () => { await resourceOwner.retryPending(); });
  expect(resourceOwner.current().pending).toBe(original);
  expect(resourceOwner.current().pendingUncertain).toBe(true);
  await act(async () => { await resourceOwner.saveTerm(); await resourceOwner.saveContext(); });
  expect(writes).toBe(2);
  await act(async () => { await resourceOwner.retryPending(); });
  expect(resourceOwner.current().pending).toBeNull();
  const requests = invoke.mock.calls.filter(([name]) => name === command).map(([, payload]) => payload.request);
  expect(requests).toHaveLength(3); requests.forEach(request => expect(request).toEqual(requests[0]));
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  expect(resourceOwner.current().termDraft.target).toBe("New B"); expect(resourceOwner.current().contextDraft).toBe("New context B");
});
