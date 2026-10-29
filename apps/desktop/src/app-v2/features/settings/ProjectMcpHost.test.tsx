import { createRef, useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionTaskProvider } from "../../../ExecutionTaskSession";
import { executionCommands } from "../../../executionCommands";
import { i18n } from "../../../i18n";
import type { mcpWorkbenchEn } from "../../../i18n/mcpWorkbench";
import { mcpCommands, type McpShareView } from "../../../mcpCommands";
import { mcpRetrievalCommands } from "../../../mcpRetrievalCommands";
import { ResourceDraftSession, useResourceDraftSession } from "../../../ResourceDraftSession";
import { reviewCommands, type ReviewEditorSnapshot } from "../../../reviewCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { sourceCommands } from "../../../sourceCommands";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { mcpConfiguration, mcpPrepared, mcpProject as project, mcpTarget, mcpView } from "../../../testSupport/mcpSharingFixture";
import { installResourceDraftPortsFixture } from "../../../testSupport/resourceDraftFixture";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { sourcePageFixture, sourceRowFixture } from "../../../testSupport/sourceFixture";
import type { DraftHead, DraftReadView } from "../../../draftCommands";
import { validateResponseWritten } from "../../../generated/draft.validators";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { InteractionGate } from "../../workspace/interactionGate";
import { TranslationDrafts } from "../editor/translationDrafts";
import type { KnowledgeOwner } from "../knowledge/knowledgeTypes";
import ProjectMcpHost, { type ProjectMcpHandle, type ProjectMcpProps } from "./ProjectMcpHost";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const savedSource = mcpPrepared().preview.payload.source.text;
const source = sourcePageFixture({ snapshotId: mcpTarget.sourceSnapshotId, scope: { revision: "2", currentSnapshot: mcpTarget.sourceSnapshotId },
  nextOrdinal: null, rows: [sourceRowFixture({ unitId: mcpTarget.unitId, sourceRevisionId: mcpTarget.sourceRevisionId },
    { ordinal: 0, key: mcpTarget.key, text: savedSource })] });
const editor: ReviewEditorSnapshot = {
  readVersion: "a".repeat(64), context: null,
  target: reviewTargetFixture({ ...mcpTarget, nativeKey: mcpTarget.key, sourceText: savedSource, revisionId: mcpTarget.translationRevisionId, translationText: "合成你好 {{player}}" }),
  terms: { unitId: mcpTarget.unitId, locale: mcpTarget.locale, sourceRevisionId: mcpTarget.sourceRevisionId, entries: [] },
  translations: { unitId: mcpTarget.unitId, locale: mcpTarget.locale, current: null, currentText: null, total: "0", rows: [], nextOrdinal: null },
};
let observed: KnowledgeOwner | null, canonical: McpShareView | null, serial: number;
const label = (key: keyof typeof mcpWorkbenchEn) => i18n.t(`mcpWorkbench.${key}`);
function Surface(props: Omit<ProjectMcpProps, "knowledgeOwner">) {
  const owner = useResourceDraftSession(); useLayoutEffect(() => { observed = owner; });
  return <ProjectMcpHost {...props} knowledgeOwner={owner}/>;
}
beforeEach(async () => {
  vi.restoreAllMocks(); await i18n.changeLanguage("en-US"); observed = null; canonical = null; serial = 9800;
  invoke.mockReset().mockRejectedValue(new Error("Unexpected synthetic native command"));
  installResourceDraftPortsFixture();
  vi.spyOn(sourceCommands, "scope").mockResolvedValue(source.scope);
  vi.spyOn(sourceCommands, "content").mockResolvedValue(source);
  vi.spyOn(reviewCommands, "editorSnapshot").mockResolvedValue(editor);
  vi.spyOn(executionCommands, "identity").mockImplementation(async () => fixtureIdentity(++serial));
  vi.spyOn(mcpCommands, "session").mockResolvedValue({ kind: "available", ownerId: fixtureIdentity(9020), nextGeneration: "1", current: null });
  vi.spyOn(mcpCommands, "prepare").mockImplementation(async request => { canonical = mcpView(request.preparation); return mcpPrepared(request.preparation); });
  vi.spyOn(mcpCommands, "read").mockImplementation(async () => { if (!canonical) throw new Error("Missing synthetic sharing state"); return structuredClone(canonical); });
  vi.spyOn(mcpCommands, "authorize").mockImplementation(async (request, preparation) => {
    canonical = mcpView(preparation, request.authorization); return { view: canonical, configuration: structuredClone(mcpConfiguration) };
  });
  vi.spyOn(mcpCommands, "revoke").mockImplementation(async request => {
    if (!canonical) throw new Error("Missing synthetic sharing state");
    canonical = { ...canonical, phase: "closing", admissionClosed: true, callbacksDrained: false };
    return { identity: request.identity, actionId: request.actionId, admissionClosed: true, callbacksDrained: false };
  });
  vi.spyOn(mcpRetrievalCommands, "discover");
  vi.spyOn(mcpRetrievalCommands, "start");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function harness() {
  const lifecycle = new ProjectLifecycle({ open: async () => project });
  expect(await lifecycle.open(project.locator)).toBe(true);
  const session = lifecycle.getSnapshot().session; if (!session) throw new Error("Missing synthetic project session");
  const basis = { sourceRevisionId: mcpTarget.sourceRevisionId, selectionId: mcpTarget.selectionId, revisionId: mcpTarget.translationRevisionId, text: "合成你好 {{player}}" };
  let disk: DraftHead = { key: { projectId: project.metadata.projectId, unitId: mcpTarget.unitId, locale: mcpTarget.locale }, revision: "0", writerId: null, value: null };
  const current: DraftReadView["current"] = { kind: "current", basis, nativeKey: mcpTarget.key, sourceText: savedSource };
  const drafts = new TranslationDrafts({ context: session.reads.context, reads: session.reads, ports: {
    list: async () => ({ items: [], next: null }), read: async () => ({ head: structuredClone(disk), current }),
    write: async request => {
      const value: unknown = { key: request.write.key, revision: String(Number(disk.revision) + 1), writerId: request.write.writerId, value: request.write.value };
      if (!validateResponseWritten(value)) throw new Error("Invalid synthetic translation draft head");
      disk = value; return structuredClone(disk);
    },
  } });
  expect(await drafts.initialize()).toBe(true);
  const gate = new InteractionGate(); gate.setVisibleOwner("synthetic-knowledge-view");
  const handle = createRef<ProjectMcpHandle>(), register = vi.spyOn(lifecycle, "register");
  render(<SessionReadProvider context={session.reads.context} reads={session.reads} bridge={false}>
    <ExecutionTaskProvider project={project} mutations={drafts}><ResourceDraftSession project={project}>
      <Surface ref={handle} project={project} lifecycle={lifecycle} gate={gate} drafts={drafts}/>
    </ResourceDraftSession></ExecutionTaskProvider>
  </SessionReadProvider>);
  await waitFor(() => expect(observed?.journal.hydration).toBe("ready"));
  const participant = register.mock.calls.find(([entry]) => entry.id === "project-mcp-sharing")?.[0];
  if (!participant) throw new Error("Missing sharing lifecycle participant");
  return { handle, drafts, gate, lifecycle, session, participant };
}
async function beginShare(handle: ReturnType<typeof createRef<ProjectMcpHandle>>) {
  act(() => handle.current?.open("share"));
  await waitFor(() => expect(screen.getByRole("option", { name: mcpTarget.key })).toBeInTheDocument());
  fireEvent.change(screen.getByRole("combobox", { name: label("savedEntry") }), { target: { value: mcpTarget.unitId } });
  await waitFor(() => expect(screen.getByRole("button", { name: label("beginShare") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: label("beginShare") }));
  fireEvent.change(screen.getByRole("textbox", { name: i18n.t("mcpSharing.recipient") }), { target: { value: "Synthetic recipient B" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("mcpSharing.preview") }));
  await screen.findByRole("region", { name: i18n.t("mcpSharing.previewTitle") });
}

it("keeps the existing query draft across panel closure and preserves composition without discovering a service", async () => {
  const h = await harness();
  expect(mcpCommands.session).not.toHaveBeenCalled(); expect(mcpRetrievalCommands.discover).not.toHaveBeenCalled();
  act(() => h.handle.current?.open("query"));
  const endpoint = await screen.findByRole("textbox", { name: i18n.t("mcpRetrieval.endpoint") });
  fireEvent.change(endpoint, { target: { value: "https://example.invalid/mcp" } });
  const query = screen.getByRole("textbox", { name: i18n.t("mcpRetrieval.query", { position: "1" }) });
  fireEvent.compositionStart(query); fireEvent.change(query, { target: { value: "新输入 B 👩🏽‍💻" } });
  fireEvent.keyDown(query, { key: "Escape", isComposing: true, keyCode: 229 });
  expect(query).toBeVisible(); expect(query).toBeEnabled(); expect(h.gate.getSnapshot().composingOwners).toHaveLength(1);
  fireEvent.compositionEnd(query);
  fireEvent.click(screen.getByRole("button", { name: label("close") }));
  expect(query).not.toBeVisible();
  act(() => expect(h.handle.current?.revealQuery()).toBe(true));
  expect(screen.getByRole("textbox", { name: i18n.t("mcpRetrieval.query", { position: "1" }) })).toHaveValue("新输入 B 👩🏽‍💻");
  expect(screen.getByRole("textbox", { name: i18n.t("mcpRetrieval.endpoint") })).toHaveValue("https://example.invalid/mcp");
  expect(mcpRetrievalCommands.discover).not.toHaveBeenCalled(); expect(mcpRetrievalCommands.start).not.toHaveBeenCalled();
});

it.each([
  ["en-US", "The recipient may retain and forward this content"],
  ["zh-CN", "接收方可能会保留或转发这些内容"],
])("shares the exact saved target and keeps lifecycle recovery until admission and callbacks both close (%s)", async (language, disclosure) => {
  await i18n.changeLanguage(language); const h = await harness(); await beginShare(h.handle);
  expect(screen.getByText(text => text.startsWith(disclosure))).toBeVisible();
  expect(vi.mocked(reviewCommands.editorSnapshot).mock.calls[0]?.[0]).toMatchObject({ unitId: mcpTarget.unitId, locale: mcpTarget.locale });
  expect(mcpCommands.authorize).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: i18n.t("mcpSharing.consent") }));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("mcpSharing.authorize") }));
  await screen.findByRole("button", { name: i18n.t("mcpSharing.showSecret") });
  const original = vi.mocked(mcpCommands.authorize).mock.calls[0]?.[0].authorization;
  fireEvent.click(screen.getByRole("button", { name: label("close") }));
  expect(h.participant.inspect({ kind: "close-project" }).status).toBe("blocked");
  expect(h.participant.inspect({ kind: "close-window" }).status).toBe("blocked");
  expect(h.participant.inspect({ kind: "navigate" }).status).toBe("ready");
  act(() => h.participant.reveal?.());
  fireEvent.click(screen.getByRole("button", { name: i18n.t("mcpSharing.revoke") }));
  await waitFor(() => expect(mcpCommands.revoke).toHaveBeenCalledTimes(1));
  expect(h.participant.inspect({ kind: "close-project" }).status).toBe("blocked");
  expect(h.participant.inspect({ kind: "close-window" }).status).toBe("blocked");
  if (!canonical) throw new Error("Missing synthetic sharing state");
  canonical = { ...canonical, phase: "closed", admissionClosed: true, callbacksDrained: true };
  fireEvent.click(screen.getByRole("button", { name: i18n.t("mcpSharing.check") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("mcpSharing.close") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: i18n.t("mcpSharing.close") }));
  expect(h.participant.inspect({ kind: "close-project" }).status).toBe("ready");
  expect(h.participant.inspect({ kind: "close-window" }).status).toBe("ready");
  expect(screen.getByRole("heading", { name: label("shareTitle") })).toHaveFocus();
  expect(vi.mocked(mcpCommands.authorize).mock.calls[0]?.[0].authorization).toBe(original);
  expect(mcpCommands.authorize).toHaveBeenCalledTimes(1);
});

it("invalidates sharing consent from the real retained translation owner while preserving its newer input", async () => {
  const h = await harness(); await beginShare(h.handle);
  fireEvent.click(screen.getByRole("checkbox", { name: i18n.t("mcpSharing.consent") }));
  expect(screen.getByRole("button", { name: i18n.t("mcpSharing.authorize") })).toBeEnabled();
  const key = { projectId: project.metadata.projectId, unitId: mcpTarget.unitId, locale: mcpTarget.locale };
  await act(async () => { await h.drafts.open(key); expect(h.drafts.edit(key, "New retained draft B")).toBe(true); await h.drafts.flush(key); });
  expect(screen.getByRole("checkbox", { name: i18n.t("mcpSharing.consent") })).not.toBeChecked();
  expect(screen.getByRole("button", { name: i18n.t("mcpSharing.authorize") })).toBeDisabled();
  expect(h.drafts.getEntry(key)?.value?.text).toBe("New retained draft B");
  expect(screen.getByRole("textbox", { name: i18n.t("mcpSharing.recipient") })).toHaveValue("Synthetic recipient B");
  expect(mcpCommands.authorize).not.toHaveBeenCalled();
});
