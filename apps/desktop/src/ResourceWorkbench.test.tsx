import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceWorkbench } from "./ResourceWorkbench";
import type { ProjectView } from "./projectCommands";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import resourceFixture from "../test/fixtures/resourceCommands.contract.json";

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
  const saved = { ...resourceFixture.responses.term, revisionId: fixtureIdentity(406), termId: "term", source: "Barrel", aliases: [], target: "A", reason: "Reviewed", scopeUnitId: null };
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
