import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceWorkbench } from "./ResourceWorkbench";
import { useResourceDraftSession } from "./ResourceDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands, type ResourceContextBasisCommandPayload } from "./workbenchCommands";
import type { ProjectView } from "./projectCommands";
import type { ContextRevision, SaveContext } from "./resourceCommands";
import { resourceReads } from "./resourceQueries";
import { executionContext } from "./executionCommands";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = {
  sessionToken: "resource-context-session", locator: "C:\\isolated\\context", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(801), displayName: "Context", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" },
};
const row = sourceRowFixture({ unitId: fixtureIdentity(802), sourceRevisionId: fixtureIdentity(803) }, { ordinal: 0, key: "context-entry", text: "Original" });
const page = sourcePageFixture({ snapshotId: fixtureIdentity(804), scope: { revision: "1", currentSnapshot: fixtureIdentity(804) }, rows: [row] });
const initial: ContextRevision = { revisionId: fixtureIdentity(805), unitId: fixtureIdentity(802), locale: "zh-CN", text: "Saved A", reason: "Reason A", previousRevisionId: null };
const replacement: ContextRevision = { ...initial, revisionId: fixtureIdentity(806), text: "Saved elsewhere", reason: "External reason", previousRevisionId: initial.revisionId };
const commandScope = { ...executionContext(project), area: "resources" as const };
let owner: ReturnType<typeof useResourceDraftSession>, reads: ReturnType<typeof useSessionReads>, registry: ReturnType<typeof useWorkbenchCommands>;
let saved: ContextRevision | null;
function Probe({ project: value }: { project: ProjectView }) {
  const currentOwner = useResourceDraftSession(), currentReads = useSessionReads(), currentRegistry = useWorkbenchCommands();
  useEffect(() => { owner = currentOwner; reads = currentReads; registry = currentRegistry; }, [currentOwner, currentReads, currentRegistry]);
  return <ResourceWorkbench project={value} disabled={false} onOpenTranslation={() => true} />;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); saved = initial; invoke.mockReset();
  invoke.mockImplementation(async (name: string, payload: { request: { context: SaveContext; unitId: string; locale: string } }) => {
    if (name === "read_content_scope") return page.scope;
    if (name === "read_source_content") return page;
    if (name === "read_terms" || name === "tm_suggestions") return [];
    if (name === "read_context_revision") return saved;
    if (name === "resolve_terms") return { unitId: payload.request.unitId, locale: payload.request.locale, sourceRevisionId: row.sourceRevisionId, entries: [] };
    if (name === "create_execution_identity") return fixtureIdentity(807);
    if (name === "save_context") {
      const request = payload.request.context;
      saved = { revisionId: fixtureIdentity(808), unitId: request.unitId, locale: request.locale, text: request.text, reason: request.reason, previousRevisionId: request.expectedRevisionId ?? null };
      return saved;
    }
    throw new Error(name);
  });
});
afterEach(cleanup);
async function ready() {
  const view = render(<Probe project={project} />), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Glossary and context" }));
  await screen.findByRole("option", { name: "context-entry" });
  await user.click(screen.getByRole("tab", { name: "Context and memory" }));
  await user.click(screen.getByRole("button", { name: "context-entry" }));
  await screen.findByRole("textbox", { name: "Context you provide" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save context" })).toBeEnabled());
  return { view, user };
}
function basisPayload(): ResourceContextBasisCommandPayload {
  const value = owner.current();
  return { kind: "resource-context-basis", unitId: row.unitId!, sourceRevisionId: row.sourceRevisionId!, locale: value.locale,
    expectedRevisionId: value.contextRevision?.revisionId ?? null, editSeq: value.contextSeq, currentRevisionId: saved?.revisionId ?? null };
}
function contextKey() { return reads.key(resourceReads.context(executionContext(project), row.unitId!, "zh-CN", row.sourceRevisionId!).key); }

it("refreshes current context without replacing drafts and explicitly adopts the reviewed save basis", async () => {
  const { user } = await ready();
  const text = screen.getByRole("textbox", { name: "Context you provide" }), reason = screen.getByRole("textbox", { name: "Reason or source note" });
  await user.clear(text); await user.type(text, "My newer text"); await user.clear(reason); await user.type(reason, "My reason");
  saved = replacement; await refreshWorkbenchReads(["resources"]);
  const current = await screen.findByRole("region", { name: "Current saved context" });
  expect(within(current).getByText("Saved elsewhere")).toBeInTheDocument();
  expect(text).toHaveValue("My newer text"); expect(reason).toHaveValue("My reason");
  expect(owner.current().contextRevision).toEqual(initial);
  expect(screen.getByRole("button", { name: "Save context" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Use current context and keep my edits" }));
  expect(owner.current().contextRevision).toEqual(replacement); expect(owner.contextDirty()).toBe(true);
  expect(text).toHaveValue("My newer text"); expect(reason).toHaveValue("My reason");
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Save context" }));
  await screen.findByText("Saved. Earlier revisions remain available.");
  expect(invoke.mock.calls.find(([name]) => name === "save_context")?.[1].request.context).toMatchObject({ expectedRevisionId: replacement.revisionId, text: "My newer text", reason: "My reason" });
  expect(owner.contextDirty()).toBe(false);
});

it("updates clean context only after explicit adoption and preserves an independently edited term", async () => {
  const { user } = await ready();
  act(() => owner.editTerm({ ...owner.current().termDraft, source: "Term A", target: "Term B", reason: "Term note" }));
  saved = replacement; await refreshWorkbenchReads(["resources"]);
  await user.click(await screen.findByRole("button", { name: "Use current context and keep my edits" }));
  expect(screen.getByRole("textbox", { name: "Context you provide" })).toHaveValue(replacement.text);
  expect(screen.getByRole("textbox", { name: "Reason or source note" })).toHaveValue(replacement.reason);
  expect(owner.contextDirty()).toBe(false); expect(owner.current().termDraft.target).toBe("Term B");
  expect(invoke.mock.calls.some(([name]) => name === "save_context" || name === "capture_context")).toBe(false);
});

it("keeps drafts through a failed read and retries the current context without recapturing it", async () => {
  const { user } = await ready(); act(() => { owner.editContext("Draft B"); owner.editContextReason("Reason B"); });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, payload: unknown) => name === "read_context_revision" ? Promise.reject(new Error("read unavailable")) : original(name, payload));
  await refreshWorkbenchReads(["resources"]);
  await screen.findByRole("button", { name: "Retry this read" });
  expect(screen.getByRole("button", { name: "Save context" })).toBeDisabled();
  expect(screen.queryByRole("region", { name: "Current saved context" })).not.toBeInTheDocument();
  expect(owner.current().contextRevision).toEqual(initial);
  saved = replacement; invoke.mockImplementation(original);
  await user.click(screen.getByRole("button", { name: "Retry this read" }));
  await screen.findByText("Saved elsewhere");
  expect(owner.current().contextDraft).toBe("Draft B"); expect(owner.current().contextReason).toBe("Reason B");
  expect(owner.current().contextRevision).toEqual(initial);
});

it("does not present a retained context as current while its replacement read is running", async () => {
  await ready(); act(() => owner.editContext("Local B")); saved = replacement; await refreshWorkbenchReads(["resources"]);
  await screen.findByRole("region", { name: "Current saved context" });
  const original = invoke.getMockImplementation()!; let finish!: (value: ContextRevision) => void;
  invoke.mockImplementation((name: string, payload: unknown) => name === "read_context_revision" ? new Promise<ContextRevision>(resolve => { finish = resolve; }) : original(name, payload));
  await refreshWorkbenchReads(["resources"]);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Current saved context" })).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Save context" })).toBeDisabled();
  expect(owner.current().contextDraft).toBe("Local B"); expect(owner.current().contextRevision).toEqual(initial);
  await act(async () => finish(replacement)); await screen.findByText("Saved elsewhere");
});

it("requires explicit adoption when current context is absent and keeps the edited text", async () => {
  const { user } = await ready(); act(() => owner.editContext("Local B")); saved = null; await refreshWorkbenchReads(["resources"]);
  await screen.findByText("There is no saved context for this entry.");
  expect(screen.getByRole("button", { name: "Save context" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Use current context and keep my edits" }));
  expect(owner.current().contextRevision).toBeNull(); expect(owner.current().contextDraft).toBe("Local B");
  expect(owner.current().contextReason).toBe("Reason A"); expect(owner.contextDirty()).toBe(true);
  expect(screen.getByRole("button", { name: "Save context" })).toBeEnabled();
});

it("rechecks exact revisions, edit sequence, live query and workspace at basis adoption dispatch", async () => {
  const { user } = await ready(); saved = replacement; await refreshWorkbenchReads(["resources"]);
  await screen.findByText("Saved elsewhere"); const payload = basisPayload();
  const dispatch = (value: unknown, scope = commandScope) => Reflect.apply(registry.dispatch, registry, ["resource.adopt-context-basis", scope, value]);
  for (const change of [{ unitId: fixtureIdentity(809) }, { locale: "fr" }, { sourceRevisionId: fixtureIdentity(810) },
    { expectedRevisionId: null }, { currentRevisionId: initial.revisionId }, { editSeq: -1 }, { currentRevisionId: undefined }]) expect(dispatch({ ...payload, ...change })).toBe(false);
  expect(dispatch(payload, { ...commandScope, sessionToken: "other" })).toBe(false);
  act(() => owner.editContext("New input")); expect(dispatch(payload)).toBe(false);
  const updated = basisPayload();
  act(() => { reads.client.setQueryData(contextKey(), { ...replacement, text: "Replaced read" });
    expect(dispatch(updated)).toBe(false); });
  await waitFor(() => expect(screen.getByText("Replaced read")).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  expect(dispatch(basisPayload())).toBe(false);
  expect(owner.current().contextRevision).toEqual(initial); expect(owner.current().contextDraft).toBe("New input");
});

it.each(["hidden", "removed"] as const)("cancels the %s context view and rereads on return without replacing its draft", async mode => {
  const { view, user } = await ready(); act(() => owner.editContext("Local B"));
  const original = invoke.getMockImplementation()!; let finish!: (value: ContextRevision) => void;
  invoke.mockImplementation((name: string, payload: unknown) => name === "read_context_revision" ? new Promise<ContextRevision>(resolve => { finish = resolve; }) : original(name, payload));
  await refreshWorkbenchReads(["resources"]); await waitFor(() => expect(finish).toBeDefined());
  if (mode === "hidden") await user.click(screen.getByRole("button", { name: "Back to overview" })); else view.rerender(null);
  expect(reads.client.getQueryCache().find({ queryKey: contextKey(), exact: true })?.isActive()).toBe(false);
  const before = invoke.mock.calls.filter(([name]) => name === "read_context_revision").length;
  await refreshWorkbenchReads(["resources"]); await act(async () => finish(replacement));
  expect(invoke.mock.calls.filter(([name]) => name === "read_context_revision")).toHaveLength(before);
  expect(owner.current().contextDraft).toBe("Local B"); expect(owner.current().contextRevision).toEqual(initial);
  saved = replacement; invoke.mockImplementation(original);
  if (mode === "hidden") await user.click(screen.getByRole("button", { name: "Glossary and context" })); else view.rerender(<Probe project={project} />);
  await screen.findByText("Saved elsewhere");
  expect(screen.getByRole("textbox", { name: "Context you provide" })).toHaveValue("Local B");
});

it("blocks a fresh save when current context changes during identity allocation", async () => {
  await ready(); act(() => { owner.editContext("Submitted A"); owner.editContextReason("My reason"); });
  const original = invoke.getMockImplementation()!; let finish!: (value: string) => void;
  invoke.mockImplementation((name: string, payload: unknown) => name === "create_execution_identity" ? new Promise<string>(resolve => { finish = resolve; }) : original(name, payload));
  await userEvent.setup().click(screen.getByRole("button", { name: "Save context" }));
  await waitFor(() => expect(finish).toBeDefined()); saved = replacement; await refreshWorkbenchReads(["resources"]);
  await act(async () => finish(fixtureIdentity(811)));
  await waitFor(() => expect(owner.inFlight()).toBe(false));
  expect(invoke.mock.calls.some(([name]) => name === "save_context")).toBe(false);
  expect(owner.current().contextDraft).toBe("Submitted A"); expect(owner.current().contextRevision).toEqual(initial);
});

it("retains and retries the original uncertain context write while current context has changed", async () => {
  const { user } = await ready(); act(() => owner.editContext("Submitted A"));
  const original = invoke.getMockImplementation()!; let attempts = 0, originalReceipt: ContextRevision | null = null;
  invoke.mockImplementation(async (name: string, payload: { request: { context: SaveContext } }) => {
    if (name === "save_context") {
      if (++attempts === 1) { originalReceipt = await original(name, payload); throw new Error("reply lost"); }
      return originalReceipt;
    }
    return original(name, payload);
  });
  await user.click(screen.getByRole("button", { name: "Save context" }));
  await screen.findByRole("button", { name: "Check or retry the same action" });
  const pending = owner.current().pending; act(() => { owner.editContext("New B"); owner.editContextReason("Reason B"); });
  saved = replacement; await refreshWorkbenchReads(["resources"]);
  expect(await screen.findByRole("button", { name: "Use current context and keep my edits" })).toBeDisabled();
  expect(registry.dispatch("resource.adopt-context-basis", commandScope, basisPayload())).toBe(false);
  expect(owner.current().pending).toBe(pending);
  await user.click(screen.getByRole("button", { name: "Check or retry the same action" }));
  await screen.findByText("Saved. Earlier revisions remain available.");
  const requests = invoke.mock.calls.filter(([name]) => name === "save_context").map(([, payload]) => payload.request);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].context).toMatchObject({ expectedRevisionId: initial.revisionId, text: "Submitted A" });
  expect(owner.current().contextDraft).toBe("New B"); expect(owner.current().contextReason).toBe("Reason B");
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
});

it("does not adopt context read for another unit and isolates a replacement session", async () => {
  const { view, user } = await ready(); act(() => owner.editContext("Old session draft"));
  saved = { ...replacement, unitId: fixtureIdentity(812) }; await refreshWorkbenchReads(["resources"]);
  await screen.findByRole("button", { name: "Retry this read" });
  expect(owner.current().contextRevision).toEqual(initial); expect(registry.dispatch("resource.adopt-context-basis", commandScope, basisPayload())).toBe(false);
  saved = replacement;
  const next = { ...project, sessionToken: "replacement-context-session" }; view.rerender(<Probe project={next} />);
  await user.click(screen.getByRole("tab", { name: "Context and memory" }));
  await user.click(screen.getByRole("button", { name: "context-entry" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Context you provide" })).toHaveValue(replacement.text));
  expect(owner.current().contextDraft).not.toBe("Old session draft");
  expect(registry.dispatch("resource.adopt-context-basis", commandScope, basisPayload())).toBe(false);
});
