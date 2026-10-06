import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { createRef } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslationWorkbench, type TranslationHandle } from "./TranslationWorkbench";
import type { ProjectView } from "./projectCommands";
import type { TranslationHistory, TranslationPreview } from "./translationCommands";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewTargetFixture, reviewSummaryFor, reviewSummaryPageFixture } from "./testSupport/reviewFixture";
import { translationCapture, translationSelection, translationView, translationInventory, translationPackage, translationCheck, translationProjection } from "./testSupport/pluginTranslationFixture";
import type { AttemptDetail } from "./executionCommands";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import errorFixture from "../test/fixtures/commandErrors.contract.json";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled", metadata: { projectId: fixtureIdentity(900), displayName: "Demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const content = sourcePageFixture({ snapshotId: fixtureIdentity(200), attemptId: fixtureIdentity(201), resultId: fixtureIdentity(202), scope: { revision: "2", currentSnapshot: fixtureIdentity(200) }, confirmation: { ...sourcePageFixture().confirmation, resultDigest: "digest", identityPolicy: "native-key", expectedContentRevision: "1", sourceLanguage: "en" }, namespace: "Example.Mod", coverage: [], total: 1, nextOrdinal: null, diagnostics: [], rows: [sourceRowFixture({ occurrenceId: fixtureIdentity(203), unitId: fixtureIdentity(204), sourceRevisionId: fixtureIdentity(205) }, { ordinal: 0, artifactId: fixtureIdentity(206), namespace: "Example.Mod", key: "first", text: "Original", source: { artifactId: fixtureIdentity(206), range: { encoding: "utf8-byte", start: 9, end: 19 } } })] });
const preview: TranslationPreview = { attemptId: fixtureIdentity(210), bundleId: fixtureIdentity(211), fixedSourceSnapshotId: fixtureIdentity(200), currentSourceSnapshotId: fixtureIdentity(200), resultDigest: "all-results", fileDigest: "file-digest", logicalPath: "i18n/zh.json", declaredLocale: "zh", targetLocale: "zh-CN", basis: "basis", total: 1, unique: 1, unmatched: 0, ambiguous: 0, selectedConflicts: 0, sourceChanged: 0, applied: 0, nextOrdinal: null, rows: [{ entry: { ordinal: 0, artifactId: fixtureIdentity(212), nativeKey: "FIRST", text: "你好", keyByteRange: [1, 8], valueByteRange: [9, 19] }, itemId: fixtureIdentity(213), resultId: fixtureIdentity(214), resultDigest: "result-digest", unitId: fixtureIdentity(204), occurrenceId: fixtureIdentity(203), sourceRevisionId: fixtureIdentity(205), sourceText: "Original", currentSelection: null, currentText: null, status: "unique" }] };
const emptyHistory: TranslationHistory = { unitId: fixtureIdentity(204), locale: "zh-CN", total: "0", current: null, currentText: null, rows: [], nextOrdinal: null };
let history: TranslationHistory;
let pluginAttempts: Map<string, AttemptDetail>;
let applied: boolean;
let conflicting: boolean;
let identity: number;
let savedActions: Map<string, ReturnType<typeof saveReceipt>>;
let protection: Map<string, { unitId: string; locale: string; revision: string; protected: boolean }>;
let protectionActions: Map<string, { unitId: string; locale: string; revision: string; protected: boolean }>;
function saveReceipt(request: Record<string, unknown>) {
  const prior = history.current?.unitId === request.unitId ? history.current : null;
  const sequence = (BigInt(prior?.sequence ?? "0") + 1n).toString();
  const actionId = String(request.actionId), unitId = String(request.unitId), locale = String(request.locale);
  const selection = { eventId: fixtureIdentity(600 + Number(sequence)), unitId, locale, sequence,
    revisionId: fixtureIdentity(700 + Number(sequence)), actionId, previousEventId: typeof request.expectedSelectionId === "string" ? request.expectedSelectionId : null };
  const revision = { revisionId: selection.revisionId, unitId, locale, ordinal: sequence, text: String(request.text),
    sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: String(request.sourceRevisionId), originKind: "manual" as const,
    actionId, contributors: [], attemptId: null, resultId: null, itemId: null, artifactId: null,
    logicalPath: null, declaredLocale: null, nativeKey: null, fileDigest: null };
  return { projectId: String(request.projectId), actionId, selection, revision,
    basis: { sourceSnapshotId: revision.sourceSnapshotId, sourceRevisionId: revision.sourceRevisionId, selectionId: selection.eventId } };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  invoke.mockReset(); history = emptyHistory; applied = false; conflicting = false; identity = 0; savedActions = new Map();
  protection = new Map(); protectionActions = new Map(); pluginAttempts = new Map();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision: "2", currentSnapshot: fixtureIdentity(200) };
    if (command === "read_source_content") return content;
    if (command === "read_review_summary_page") return reviewSummaryPageFixture(content.rows.map(row => reviewSummaryFor(reviewTargetFixture({ unitId: row.unitId!, nativeKey: row.occurrence.key, sourceText: row.occurrence.text, sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: row.sourceRevisionId!, selectionId: history.current?.eventId ?? null, revisionId: history.current?.revisionId ?? null, translationText: history.currentText, basis: "basis" }))));
    if (command === "read_review_target") return reviewTargetFixture({ unitId: fixtureIdentity(204), nativeKey: "first", sourceText: "Original", sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205), selectionId: history.current?.eventId ?? null, revisionId: history.current?.revisionId ?? null, translationText: history.currentText, basis: "basis" });
    if (command === "read_review_editor_snapshot") return {
      target: reviewTargetFixture({ unitId: String(args.request.unitId), nativeKey: args.request.unitId === fixtureIdentity(217) ? "second" : "first", sourceText: "Original", sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205), selectionId: history.current?.eventId ?? null, revisionId: history.current?.revisionId ?? null, translationText: history.currentText, basis: "basis" }),
      translations: history,
      terms: { unitId: args.request.unitId, locale: "zh-CN", sourceRevisionId: fixtureIdentity(205), entries: [{ source: "Original", selected: { revisionId: fixtureIdentity(224), termId: "term", locale: "zh-CN", source: "Original", aliases: [], target: "原文", protected: false, scopeUnitId: null, reason: "Project terminology", originKind: "manual", captureId: null, externalEntryId: null, previousRevisionId: null, removed: false }, conflicting: [] }] },
      context: { revisionId: fixtureIdentity(225), unitId: args.request.unitId, locale: "zh-CN", text: "Used in the opening screen", reason: "Translator note", previousRevisionId: null },
      readVersion: "view",
    };
    if (command === "read_review_neighbor") return { unitId: fixtureIdentity(217), afterOrdinal: 1, sourceSnapshotId: fixtureIdentity(200) };
    if (command === "read_translation_history") return history;
    if (command === "read_work_protection") return protection.get(`${args.request.unitId}:${args.request.locale}`)
      ?? { unitId: args.request.unitId, locale: args.request.locale, revision: "0", protected: false };
    if (command === "set_work_protection") {
      const action = String(args.request.actionId), scope = `${args.request.unitId}:${args.request.locale}`;
      if (protectionActions.has(action)) return protectionActions.get(action);
      const current = protection.get(scope);
      if ((current?.revision ?? "0") !== args.request.expectedRevision) throw errorFixture.errors[1];
      const next = { unitId: String(args.request.unitId), locale: String(args.request.locale),
        revision: (BigInt(String(args.request.expectedRevision)) + 1n).toString(), protected: args.request.protected === true };
      protection.set(scope, next); protectionActions.set(action, next); return next;
    }
    if (command === "resolve_terms") return { unitId: fixtureIdentity(204), locale: "zh-CN", sourceRevisionId: fixtureIdentity(205), entries: [{ source: "Original", selected: { revisionId: fixtureIdentity(224), termId: "term", locale: "zh-CN", source: "Original", aliases: [], target: "原文", protected: false, scopeUnitId: null, reason: "Project terminology", originKind: "manual", captureId: null, externalEntryId: null, previousRevisionId: null, removed: false }, conflicting: [] }] };
    if (command === "read_context_revision") return { revisionId: fixtureIdentity(225), unitId: fixtureIdentity(204), locale: "zh-CN", text: "Used in the opening screen", reason: "Translator note", previousRevisionId: null };
    if (command === "read_plugin_inventory") return translationInventory;
    if (command === "read_plugin_package") return translationPackage;
    if (command === "read_plugin_translation") return translationView;
    const source = { ...translationCapture.source, sourceSnapshotId: fixtureIdentity(200) };
    if (command === "read_plugin_translation_source") return source;
    if (command === "select_plugin_translation") return { ...translationSelection, source };
    if (command === "list_plugin_translation_files") return ["zh.json"];
    if (command === "preflight_plugin_translation") return { ...translationCapture, source, attemptId: args.request.attemptId };
    if (command === "create_execution_identity") return fixtureIdentity(++identity);
    if (command === "start_plugin_translation" || command === "start_translation_check" || command === "start_translation_projection") {
      const attemptId = String(args.request.attemptId), operation = command === "start_plugin_translation" ? "translation-extract" : command === "start_translation_check" ? "translation-semantic-check" : "translation-import";
      pluginAttempts.set(attemptId, { ...executionFixture.detail, attemptId, taskId: fixtureIdentity(230 + identity), operation,
        progress: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
        items: [{ scope: { kind: "translation-file", id: "i18n/zh.json", locale: "zh-CN" }, resultId: fixtureIdentity(240 + identity),
          status: { itemId: fixtureIdentity(250 + identity), execution: "succeeded", validation: "pending", adoption: "unapplied", retrySafe: false, cancellationRequested: false, diagnostic: null } }],
        recovery: { attemptId, units: [] }, nextOffset: null });
      return attemptId;
    }
    if (command === "read_execution_attempt") return structuredClone(pluginAttempts.get(String(args.request.attemptId)) ?? null);
    if (command === "prepare_translation_check") return { ...translationCheck, source, translation: translationView, attemptId: args.request.attemptId, translationAttemptId: args.request.translationAttemptId, translationResultId: args.request.translationResultId };
    if (command === "finish_translation_check") { pluginAttempts.get(String(args.request.translationAttemptId))!.items[0].status.validation = "valid"; return null; }
    if (command === "prepare_translation_projection") return { ...translationProjection, source, itemCount: 1, attemptId: args.request.attemptId, translationAttemptId: args.request.translationAttemptId, translationResultId: args.request.translationResultId };
    if (command === "read_translation_preview") return applied ? { ...preview, attemptId: String(args.request.attemptId), unique: 0, applied: 1, rows: [{ ...preview.rows[0], status: "applied" }] } : conflicting ? { ...preview, attemptId: String(args.request.attemptId), unique: 0, selectedConflicts: 1, rows: [{ ...preview.rows[0], status: "selected-conflict", currentText: "旧译文", currentSelection: { eventId: fixtureIdentity(221), unitId: fixtureIdentity(204), locale: "zh-CN", sequence: "1", revisionId: fixtureIdentity(222), actionId: fixtureIdentity(223), previousEventId: null } }] } : { ...preview, attemptId: String(args.request.attemptId) };
    if (command === "prepare_translation_adoption") return { ...executionFixture.action, projectId: args.request.projectId, actionId: args.request.actionId, attemptId: args.request.attemptId, resultIds: [args.request.resultId], unitId: (args.request.confirmation as { targetUnitId: string }).targetUnitId };
    if (command === "adopt_execution") { applied = true; return { ...executionFixture.receipt, actionId: args.request.actionId, changes: [{ kind: "translation-revision", id: "revision", revision: "1" }] }; }
    if (command === "save_translation_revision") {
      const existing = savedActions.get(String(args.request.actionId));
      if (existing) return existing;
      const receipt = saveReceipt(args.request);
      savedActions.set(receipt.actionId, receipt);
      history = { ...emptyHistory, total: receipt.revision.ordinal, current: receipt.selection,
        currentText: receipt.revision.text, rows: [receipt.revision] };
      return receipt;
    }
    if (command === "read_execution_receipt") return null;
    throw new Error(command);
  });
});
afterEach(cleanup);
async function captureDeclaredTranslation(user: ReturnType<typeof userEvent.setup>) {
  const choose = await screen.findByRole("button", { name: "Choose translation folder" });
  await waitFor(() => expect(choose).toBeEnabled()); await user.click(choose);
  await user.click(await screen.findByRole("checkbox", { name: /I confirm that zh.json belongs to zh-CN/ }));
  await user.click(screen.getByRole("button", { name: "Capture translation file" }));
  expect(await screen.findByRole("button", { name: "Import for review" })).toBeDisabled();
}

async function importDeclaredTranslation(user: ReturnType<typeof userEvent.setup>) {
  await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("checkbox", { name: /I allow this exact plugin to extract this captured translation file/ }));
  await user.click(screen.getByRole("button", { name: "Import for review" }));
  await user.click(await screen.findByRole("button", { name: "Review independent translation check" }));
  await user.click(await screen.findByRole("checkbox", { name: /I separately allow this exact checker/ }));
  await user.click(screen.getByRole("button", { name: "Run independent translation check" }));
  await user.click(await screen.findByRole("button", { name: "Record translation check" }));
  await user.click(await screen.findByRole("button", { name: "Prepare checked translation preview" }));
  await user.click(await screen.findByRole("button", { name: "Review checked translation matches" }));
}


it("keeps the rejecting basis beside newer input without replaying the save", async () => {
  const original = invoke.getMockImplementation()!;
  let rejectSave!: (error: unknown) => void;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "save_translation_revision") return new Promise((_, reject) => { rejectSave = reject; });
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "Submitted draft");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(rejectSave).toBeDefined());
  await user.type(editor, " plus newer input");
  await act(async () => rejectSave({ ...errorFixture.errors[1], reason: "translation-selection" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("commandError.recovery.review-current"));
  expect(editor).toHaveValue("Submitted draft plus newer input");
  await user.click(screen.getByText(i18n.t("execution.diagnostic")));
  expect(screen.getByText(errorFixture.errors[1].diagnosticId)).toBeVisible();
  expect(screen.getByText(errorFixture.errors[1].conflict!.current!)).toBeVisible();
  expect(screen.getByText(i18n.t("commandError.none"))).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry the same action" })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1);
});

it("keeps a confirmed save and allows leaving when the list refresh fails", async () => {
  const ref = createRef<TranslationHandle>();
  const original = invoke.getMockImplementation()!;
  let summaries = 0;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page" && ++summaries === 2) throw new Error("Read unavailable");
    return original(command, args);
  });
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "Committed draft");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Your revision was saved, but the entry list could not refresh");
  expect(screen.queryByRole("button", { name: "Retry the same action" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
  expect(await ref.current!.allowLeave()).toBe(true);
  await user.click(screen.getByRole("button", { name: "Find" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1);
});

it("confirms a save without a second editor or history read and preserves newer input", async () => {
  const original = invoke.getMockImplementation()!;
  let editorReads = 0;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_editor_snapshot" && ++editorReads > 1) throw new Error("Later read unavailable");
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "Confirmed draft");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled());
  expect(editor).toHaveValue("Confirmed draft");
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_editor_snapshot")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "read_translation_history")).toHaveLength(0);
  await user.type(editor, " plus newer input");
  await user.click(screen.getByText("Terms, context and history"));
  await user.click(screen.getByRole("button", { name: "Refresh history" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "read_translation_history")).toHaveLength(2));
  expect(editor).toHaveValue("Confirmed draft plus newer input");
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
});

it("retains the action when a committed save has a malformed acknowledgement", async () => {
  const original = invoke.getMockImplementation()!;
  let malformed = true;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const value = await original(command, args);
    if (command === "save_translation_revision" && malformed) {
      malformed = false;
      return { ...value, actionId: "unrelated-action" };
    }
    return value;
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "Saved once");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await user.click(await screen.findByRole("button", { name: "Retry the same action" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled());
  const saves = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saves).toHaveLength(2);
  expect(saves[1][1].request).toEqual(saves[0][1].request);
});

it.each(["save-and-next", "save-and-continue"])("saves entry 50 and opens entry 51 without manual paging, then reports the end (%s)", async mode => {
  const original = invoke.getMockImplementation()!;
  const saved = new Map<string, string>();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") {
      const after = Number(args.request.afterOrdinal);
      return { rows: Array.from({ length: Math.min(50, 51 - after) }, (_, offset) => {
        const position = after + offset;
        return { unitId: fixtureIdentity(1000 + position), locale: "zh-CN", nativeKey: `entry-${position + 1}`,
          sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(1100 + position),
          sourcePreview: "Source preview", translationPreview: saved.get(fixtureIdentity(1000 + position)) ?? null,
          selectionId: null, revisionId: null, basis: "basis", currentDecision: null, currentCheck: null };
      }), total: 51, nextOrdinal: after + 50 < 51 ? after + 50 : null,
        scopeId: fixtureIdentity(226), sourceSnapshotId: fixtureIdentity(200), readVersion: "view" };
    }
    if (command === "read_review_editor_snapshot") {
      const value = await original(command, args);
      const unitId = String(args.request.unitId);
      const position = Number(unitId.slice(-12)) - 1000;
      const text = saved.get(unitId) ?? null;
      return { ...value, target: { ...value.target, unitId, nativeKey: `entry-${position + 1}`,
        sourceRevisionId: fixtureIdentity(1100 + position), sourceText: "Complete source for editing", translationText: text },
        translations: { ...emptyHistory, unitId, currentText: text } };
    }
    if (command === "save_translation_revision") {
      saved.set(String(args.request.unitId), String(args.request.text));
      return saveReceipt(args.request);
    }
    if (command === "read_review_neighbor") {
      const next = Number(String(args.request.unitId).slice(-12)) - 1000 + Number(args.request.direction);
      return { unitId: next >= 0 && next < 51 ? fixtureIdentity(1000 + next) : null,
        afterOrdinal: next >= 0 && next < 51 ? next : null, sourceSnapshotId: fixtureIdentity(200) };
    }
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "entry-50" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "Fiftieth saved");
  if (mode === "save-and-next") await user.click(screen.getByRole("button", { name: "Save and next" }));
  else {
    await user.click(screen.getByRole("button", { name: "Next entry" }));
    await user.click(await screen.findByRole("button", { name: "Save and continue" }));
  }
  expect(await screen.findByRole("heading", { name: "entry-51" })).toBeInTheDocument();
  expect(saved.get(fixtureIdentity(1049))).toBe("Fiftieth saved");
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveFocus();
  expect(screen.getByRole("button", { name: "entry-51" })).toHaveAttribute("aria-current", "true");
  await user.type(screen.getByRole("textbox", { name: "Your draft" }), "Final saved");
  await user.click(screen.getByRole("button", { name: "Save and next" }));
  expect(await screen.findByText("You have reached the last entry in this list.")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "entry-51" })).toBeInTheDocument();
  expect(saved.get(fixtureIdentity(1050))).toBe("Final saved");
});

it("retains input entered while save-and-next waits for the neighboring entry", async () => {
  const original = invoke.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_review_neighbor"
    ? new Promise(resolve => { finish = resolve; }) : original(command, args));
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save and next" }));
  await waitFor(() => expect(finish).toBeDefined());
  await user.type(editor, "B");
  await act(async () => finish({ unitId: fixtureIdentity(217), afterOrdinal: 1, sourceSnapshotId: fixtureIdentity(200) }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
  expect(editor).toHaveValue("AB");
  expect(screen.getByRole("heading", { name: "first" })).toBeInTheDocument();
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Your draft changed while the next entry was loading");
});

it.each([
  ["review-scope-expired", "This result list has expired"],
  ["review-scope-source-changed", "The source range changed"],
])("recovers a stale result scope through a fresh search without losing the draft (%s)", async (field, message) => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") {
      if (args.request.scopeId) throw { code: "dependency-conflict", outcome: "rejected", stage: "execution-read", recoveryRequired: false, reason: field };
      return { ...await original(command, args), nextOrdinal: 1 };
    }
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "Retained input");
  await user.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(editor).toHaveValue("Retained input");
  await user.click(screen.getByRole("button", { name: "Find" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(editor).toHaveValue("Retained input");
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_summary_page").at(-1)?.[1].request.scopeId).toBeNull();
});

it("keeps the editor but disables list navigation when a new search has no matches", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const value = await original(command, args);
    return command === "read_review_summary_page" && args.request.query === "absent"
      ? { ...value, rows: [], total: 0, nextOrdinal: null } : value;
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "Keep this input");
  await user.type(screen.getByRole("textbox", { name: "Find by key, source or translation" }), "absent");
  await user.click(screen.getByRole("button", { name: "Find" }));
  await screen.findByText("0 matching entries");
  expect(editor).toHaveValue("Keep this input");
  expect(screen.getByRole("button", { name: "Previous entry" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next entry" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save and next" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
});

it("requires language mapping and applies only the reviewed unique result", async () => {
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await importDeclaredTranslation(user);
  await screen.findByRole("heading", { name: "Review translation matches" });
  expect(screen.getByText("你好")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Apply 1 unique matches" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "adopt_execution")).toBe(true));
  expect(invoke.mock.calls.find(([name]) => name === "prepare_translation_adoption")?.[1].request.confirmation).toMatchObject({ decision: "candidate-only", resultDigest: "result-digest", targetUnitId: fixtureIdentity(204) });
});

it.each(["escape", "continue"])("returns focus to the retained draft after %s cancels leaving", async (dismissal) => {
  const ref = createRef<TranslationHandle>();
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(draft, "Keep this unsaved input");
  let leaving!: Promise<boolean>;
  act(() => { leaving = ref.current!.allowLeave(); });
  await screen.findByRole("dialog", { name: i18n.t("translation.leaveTitle") });
  if (dismissal === "escape") await user.keyboard("{Escape}");
  else await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(await leaving).toBe(false);
  expect(draft).toHaveValue("Keep this unsaved input");
  await waitFor(() => expect(draft).toHaveFocus());
  expect(invoke.mock.calls.some(([name]) => name === "save_translation_revision")).toBe(false);
});

it.each(["batch", "row"])("refreshes frozen editor summaries after %s import selection", async (mode) => {
  const original = invoke.getMockImplementation()!;
  let adopted = false;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page" && adopted && args.request.scopeId === null) {
      return reviewSummaryPageFixture([reviewSummaryFor(reviewTargetFixture({
        unitId: fixtureIdentity(204), nativeKey: "first", sourceText: "Original",
        sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205),
        selectionId: fixtureIdentity(601), revisionId: fixtureIdentity(701),
        translationText: "你好", basis: "selected-basis",
      }))]);
    }
    const result = await original(command, args);
    if (command === "adopt_execution") adopted = true;
    return result;
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Edit translations" }));
  expect(await screen.findByRole("button", { name: "first" })).toHaveTextContent("No selected translation");
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await importDeclaredTranslation(user);
  await screen.findByRole("heading", { name: "Review translation matches" });
  if (mode === "batch") {
    await user.click(screen.getByRole("checkbox", { name: i18n.t("translation.selectIfEmpty") }));
    await user.click(screen.getByRole("button", { name: "Apply 1 unique matches" }));
  } else {
    await user.click(screen.getByRole("button", { name: "Select imported translation" }));
    await user.click(within(screen.getByRole("dialog", { name: "Select imported translation" })).getByRole("button", { name: "Select imported translation" }));
  }
  await waitFor(() => expect(adopted).toBe(true));
  await user.click(screen.getByRole("button", { name: "Edit translations" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "first" })).toHaveTextContent("你好"));
  expect(screen.getByRole("button", { name: "first" })).toHaveTextContent(i18n.t("workbench.selected"));
});

it("keeps text typed after an earlier save and checks the new selection before saving again", async () => {
  const ref = createRef<TranslationHandle>();
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Edit translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  let complete!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "save_translation_revision"
    ? new Promise(resolve => { complete = () => { const receipt = saveReceipt(args.request); history = { ...emptyHistory, total: "1", current: receipt.selection, currentText: "A", rows: [] }; resolve(receipt); }; })
    : original(command, args));
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  expect(editor).not.toHaveAttribute("readonly");
  await user.type(editor, "B");
  await act(async () => { complete(history.current); });
  await screen.findByText(/Your newer draft is still here/);
  expect(editor).toHaveValue("AB");
  let decision!: Promise<boolean>;
  act(() => { decision = ref.current!.allowLeave(); });
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(await decision).toBe(false);
  expect(editor).toHaveValue("AB");
  invoke.mockImplementation(original);
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(2));
  expect(invoke.mock.calls.at(-3)?.[1]).toBeDefined();
  const saves = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saves[1][1].request).toMatchObject({ text: "AB", expectedSelectionId: fixtureIdentity(601) });
});

it("shows current adopted terms and context beside the editable translation", async () => {
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Edit translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.click(screen.getByText("Terms, context and history"));
  const reference = await screen.findByRole("region", { name: "Terms and context for this translation" });
  expect(reference).toHaveTextContent("Original: 原文 · Manual · Project terminology");
  expect(reference).toHaveTextContent("Used in the opening screen · Translator note");
  expect(screen.getByRole("textbox", { name: "Your draft" })).toBeEnabled();
  expect(invoke.mock.calls.find(([name]) => name === "read_review_editor_snapshot")?.[1].request).toMatchObject({ unitId: fixtureIdentity(204), locale: "zh-CN" });
});

it("queries the complete current scope and retains a filtered position on return", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") return Promise.resolve(reviewSummaryPageFixture([reviewSummaryFor(reviewTargetFixture({ unitId: fixtureIdentity(218), nativeKey: args.request.query ? "later-needle" : "first", sourceText: "Source on page two", sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(219), selectionId: null, revisionId: null, translationText: null, basis: "later-basis" }))], { total: args.request.query ? 1 : 60, nextOrdinal: args.request.query ? null : 50, scopeId: fixtureIdentity(227) }));
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await screen.findByRole("button", { name: "first" });
  await user.type(screen.getByRole("textbox", { name: "Find by key, source or translation" }), "needle");
  await user.click(screen.getByRole("button", { name: "Find" }));
  await screen.findByRole("button", { name: "later-needle" });
  expect(invoke).toHaveBeenCalledWith("read_review_summary_page", { request: expect.objectContaining({ query: "needle", afterOrdinal: 0, limit: 50, locale: "zh-CN" }) });
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await user.click(screen.getByRole("button", { name: "Translations" }));
  expect(await screen.findByRole("button", { name: "later-needle" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Find by key, source or translation" })).toHaveValue("needle");
  expect(invoke.mock.calls.filter(([name]) => name === "read_translation_history")).toHaveLength(0);
});

it("refreshes a clean retained editor against current source and selection on return", async () => {
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await screen.findByRole("textbox", { name: "Your draft" });
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  history = { ...emptyHistory, total: "1", currentText: "External selection" };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    const value = await original(command, args);
    return command === "read_review_editor_snapshot" ? { ...value, target: reviewTargetFixture({ ...value.target, basisEvidence: undefined, sourceRevisionId: fixtureIdentity(228), sourceText: "Updated original" }) } : value;
  });
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("External selection"));
  expect(screen.getByText("Updated original")).toBeInTheDocument();
  await user.clear(screen.getByRole("textbox", { name: "Your draft" }));
  await user.type(screen.getByRole("textbox", { name: "Your draft" }), "New translation");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_translation_revision", { request: expect.objectContaining({ sourceRevisionId: fixtureIdentity(228), text: "New translation" }) }));
});

it("preserves text entered while a retained editor refresh is awaiting current facts", async () => {
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await screen.findByRole("textbox", { name: "Your draft" });
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  let complete!: () => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_review_editor_snapshot"
    ? new Promise(resolve => { complete = async () => resolve(await original(command, args)); }) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await waitFor(() => expect(complete).toBeDefined());
  await user.type(screen.getByRole("textbox", { name: "Your draft" }), "Newer input");
  history = { ...emptyHistory, currentText: "External selection" };
  await act(async () => { complete(); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Back to overview" })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("Newer input");
});

it("keeps the current editor when a neighboring entry is requested with a dirty draft", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    const value = await original(command, args);
    if (command === "read_review_summary_page") return { ...value, rows: [value.rows[0], { ...value.rows[0], unitId: fixtureIdentity(217), nativeKey: "second", sourceRevisionId: fixtureIdentity(220) }], total: 2 };
    return value;
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "Unfinished");
  await user.click(screen.getByRole("button", { name: "Next entry" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("Leave with an unsaved translation?");
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(editor).toHaveValue("Unfinished");
  expect(screen.getByRole("button", { name: "first" })).toHaveAttribute("aria-current", "true");
});

it.each([
  { code: "outcome-unknown", outcome: "unknown", reason: "commit" },
  new Error("IPC response lost"),
  { code: "dependency-conflict", outcome: "rejected" },
  { code: "dependency-conflict", outcome: "rejected", stage: "execution-write", recoveryRequired: false },
])("saves before leaving and retains an uncertain action for a checked retry: %s", async (failure) => {
  const ref = createRef<TranslationHandle>();
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Edit translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "Draft");
  let decision!: Promise<boolean>;
  act(() => { decision = ref.current!.allowLeave(); });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "save_translation_revision"
    ? Promise.reject(failure)
    : original(command, args));
  await user.click(screen.getByRole("button", { name: "Save and continue" }));
  expect(await screen.findByRole("button", { name: "Retry the same action" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Discard draft and continue" })).toBeDisabled();
  invoke.mockImplementation(original);
  await user.click(screen.getByRole("button", { name: "Retry the same action" }));
  expect(await decision).toBe(true);
  const saves = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saves).toHaveLength(2);
  expect(saves[0][1].request.actionId).toBe(saves[1][1].request.actionId);
  expect(saves[1][1].request.text).toBe("Draft");
});

it("requires a separate comparison and confirmation before replacing a selected translation", async () => {
  conflicting = true;
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await importDeclaredTranslation(user);
  await screen.findByRole("heading", { name: "Review translation matches" });
  expect(screen.getByRole("button", { name: "Apply 0 unique matches" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Replace current selection" }));
  const dialog = screen.getByRole("dialog", { name: "Replace current selection" });
  expect(dialog).toHaveTextContent("旧译文");
  expect(dialog).toHaveTextContent("你好");
  expect(invoke.mock.calls.some(([name]) => name === "prepare_translation_adoption")).toBe(false);
  await user.click(dialog.querySelector("button.primary-button")!);
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "adopt_execution")).toBe(true));
  expect(invoke.mock.calls.find(([name]) => name === "prepare_translation_adoption")?.[1].request.confirmation).toMatchObject({ decision: "replace", expectedSelectionId: fixtureIdentity(221) });
});

it("reports a partial batch without treating an uncommitted conflict as applied", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_translation_preview" && !applied) return Promise.resolve({ ...preview, total: 2, unique: 2, rows: [preview.rows[0], { ...preview.rows[0], entry: { ...preview.rows[0].entry, ordinal: 1, nativeKey: "SECOND" }, itemId: fixtureIdentity(215), resultId: fixtureIdentity(216) }] });
    if (command === "prepare_translation_adoption" && args.request.itemId === fixtureIdentity(215)) return Promise.reject({ code: "dependency-conflict", outcome: "rejected", stage: "execution-read", recoveryRequired: false, reason: "translation-selection" });
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await importDeclaredTranslation(user);
  await screen.findByRole("button", { name: "Apply 2 unique matches" });
  await user.click(screen.getByRole("button", { name: "Apply 2 unique matches" }));
  expect(await screen.findByText(/Applied 1; conflicted 1; failed 0; outcome unknown 0/)).toBeInTheDocument();
  await user.click(screen.getByText("Entry results"));
  expect(screen.getByText("SECOND: Conflict; not applied")).toBeInTheDocument();
});

it("shows Chinese import labels and an actionable missing-source state", async () => {
  await i18n.changeLanguage("zh-CN");
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_content_scope" ? Promise.resolve({ revision: "1", currentSnapshot: null }) : original(command, args));
  render(<TranslationWorkbench project={project} disabled={false} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "译文" }));
  expect(await screen.findByText("请先导入源内容，再回来匹配译文。")) .toBeInTheDocument();
});

it("retains an uncertain protection action while guarding entry, language and project navigation", async () => {
  const original=invoke.getMockImplementation()!,ref=createRef<TranslationHandle>();let lost=true,protectedValue=false;
  invoke.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
    if(command==="read_review_summary_page"){const page=await original(command,args);return {...page,total:2,rows:[...page.rows,reviewSummaryFor(reviewTargetFixture({unitId:fixtureIdentity(217),sourceRevisionId:fixtureIdentity(218),sourceSnapshotId:fixtureIdentity(200),nativeKey:"second",sourceText:"Second"}))]};}
    if(command==="read_work_protection")return {unitId:args.request.unitId,locale:args.request.locale,revision:protectedValue?"1":"0",protected:protectedValue};
    if(command==="set_work_protection"){
      if(lost){lost=false;throw {code:"outcome-unknown"};}
      protectedValue=true;return {unitId:args.request.unitId,locale:args.request.locale,revision:"1",protected:true};
    }
    return original(command,args);
  });
  render(<TranslationWorkbench ref={ref} project={project} disabled={false}/>);const user=userEvent.setup();
  await user.click(screen.getByRole("button",{name:"Translations"}));await user.click(await screen.findByRole("button",{name:"first"}));
  await screen.findByRole("button",{name:"Retry same protection action"});
  expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();
  expect(screen.getByRole("combobox",{name:"Target language"})).toBeDisabled();
  expect(screen.getByRole("button",{name:"second"})).toBeDisabled();
  let leave=true,opened=true;
  await act(async()=>{leave=await ref.current!.allowLeave();opened=ref.current!.openUnit({unitId:fixtureIdentity(217),sourceRevisionId:fixtureIdentity(218),key:"second",sourceText:"Second"},"zh-CN");});
  expect(leave).toBe(false);expect(opened).toBe(false);
  const draft=screen.getByRole("textbox",{name:"Your draft"});
  expect(draft).toHaveAttribute("readonly");await user.type(draft,"Unsafe input");expect(draft).toHaveValue("");
  await user.click(screen.getByRole("button",{name:"Retry same protection action"}));
  await screen.findByText("Protected from automatic selection");
  await waitFor(()=>expect(draft).not.toHaveAttribute("readonly"));await user.type(draft,"Retained manual input");expect(draft).toHaveValue("Retained manual input");
  const mutations=invoke.mock.calls.filter(([name])=>name==="set_work_protection");expect(mutations).toHaveLength(2);expect(mutations[1][1].request).toEqual(mutations[0][1].request);
});

it("accepts no editable draft before protection commits and confirms current state", async () => {
  const original = invoke.getMockImplementation()!;
  let finishProtection!: () => Promise<void>;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "set_work_protection") return new Promise(resolve => {
      finishProtection = async () => resolve(await original(command, args));
    });
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await waitFor(() => expect(finishProtection).toBeDefined());
  expect(draft).toHaveAttribute("readonly");
  await user.type(draft, "Before protection");
  expect(draft).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
  await act(finishProtection);
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.type(draft, "After protection");
  expect(draft).toHaveValue("After protection");
  expect(invoke.mock.calls.filter(([name]) => name === "set_work_protection")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "read_work_protection")).toHaveLength(2);
});

it("keeps unreadable protection read-only and recovers through its existing refresh action", async () => {
  const original = invoke.getMockImplementation()!;
  let failedRead = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_work_protection" && failedRead) return Promise.reject(new Error("Read unavailable"));
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await screen.findByRole("button", { name: "Refresh protection" });
  expect(draft).toHaveAttribute("readonly");
  expect(invoke.mock.calls.filter(([name]) => name === "set_work_protection")).toHaveLength(0);
  failedRead = false;
  await user.click(screen.getByRole("button", { name: "Refresh protection" }));
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.type(draft, "Recovered input");
  expect(draft).toHaveValue("Recovered input");
});

it("keeps a released entry read-only until explicit protection without re-protecting in a loop", async () => {
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.click(screen.getByRole("button", { name: "Release protection" }));
  await user.click(await screen.findByRole("button", { name: "Release for this entry" }));
  await screen.findByText("Automatic selection is not protected");
  expect(draft).toHaveAttribute("readonly");
  await user.type(draft, "Unprotected input");
  expect(draft).toHaveValue("");
  expect(invoke.mock.calls.filter(([name]) => name === "set_work_protection")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Protect from automation" }));
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.type(draft, "Protected input");
  expect(draft).toHaveValue("Protected input");
  expect(invoke.mock.calls.filter(([name]) => name === "set_work_protection")).toHaveLength(3);
});

it("refreshes a conflicting entry basis before protecting it and never saves a blocked suggested draft", async () => {
  const original = invoke.getMockImplementation()!, ref = createRef<TranslationHandle>();
  let firstWrite = true;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "set_work_protection" && firstWrite) {
      firstWrite = false;
      const receipt = saveReceipt({ ...args.request, text: "Another selection", expectedSelectionId: null });
      history = { ...emptyHistory, total: "1", current: receipt.selection, currentText: receipt.revision.text, rows: [receipt.revision] };
      throw errorFixture.errors[1];
    }
    return original(command, args);
  });
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await act(async () => { ref.current!.openUnit({ unitId: fixtureIdentity(204), sourceRevisionId: fixtureIdentity(205), key: "first", sourceText: "Original" }, "zh-CN", "Suggested draft"); });
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await screen.findByRole("alert");
  expect(draft).toHaveAttribute("readonly");
  expect(draft).toHaveValue("Suggested draft");
  let leaving!: Promise<boolean>;
  await act(async () => { leaving = ref.current!.allowLeave(); });
  await screen.findByRole("dialog");
  expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: i18n.t("translation.stay") }));
  expect(await leaving).toBe(false);
  expect(draft).toHaveValue("Suggested draft");
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Discard draft" }));
  await user.click(screen.getByRole("button", { name: "Refresh current entry" }));
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  expect(draft).toHaveValue("Another selection");
  const writes = invoke.mock.calls.filter(([name]) => name === "set_work_protection");
  expect(writes).toHaveLength(2);
  expect(writes[1][1].request.selectionId).toBe(history.current!.eventId);
});

it("does not save or leave during composition and preserves the draft for the next ordinary save", async () => {
  const ref = createRef<TranslationHandle>();
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.type(draft, "Draft");
  fireEvent.compositionStart(draft);
  fireEvent.keyDown(draft, { key: "s", metaKey: true, isComposing: true });
  expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
  expect(await ref.current!.allowLeave()).toBe(false);
  expect(ref.current!.openUnit({ unitId: fixtureIdentity(217), sourceRevisionId: fixtureIdentity(218), key: "second", sourceText: "Second" }, "zh-CN")).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(0);
  expect(draft).toHaveValue("Draft");
  fireEvent.compositionEnd(draft);
  fireEvent.keyDown(draft, { key: "s", metaKey: true, isComposing: true });
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(0);
  fireEvent.keyDown(draft, { key: "s", metaKey: true });
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1));
  expect(draft).toHaveValue("Draft");
});

it.each(["newer-text", "composition"])("preserves %s when a manual selection acknowledgement arrives", async mode => {
  const revision = saveReceipt({ projectId: project.metadata.projectId, actionId: fixtureIdentity(3000),
    unitId: fixtureIdentity(204), locale: "zh-CN", sourceRevisionId: fixtureIdentity(205), text: "Older revision", expectedSelectionId: null }).revision;
  history = { ...emptyHistory, total: "1", rows: [revision] };
  const original = invoke.getMockImplementation()!;
  let complete!: () => void;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "select_translation_revision") return new Promise(resolve => {
      complete = () => {
        const selection = { eventId: fixtureIdentity(3001), unitId: revision.unitId, locale: revision.locale,
          sequence: "1", revisionId: revision.revisionId, actionId: String(args.request.actionId), previousEventId: null };
        history = { ...history, current: selection, currentText: revision.text };
        resolve(selection);
      };
    });
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.click(screen.getByText("Terms, context and history"));
  await user.click(screen.getByRole("button", { name: "Select this revision" }));
  await waitFor(() => expect(complete).toBeDefined());
  if (mode === "newer-text") await user.type(draft, "Newer input");
  else fireEvent.compositionStart(draft);
  await act(async () => { complete(); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Back to overview" })).toBeEnabled());
  expect(draft).not.toHaveAttribute("readonly");
  expect(draft).toHaveValue(mode === "newer-text" ? "Newer input" : "");
  if (mode === "composition") fireEvent.compositionEnd(draft);
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
});


it("reconciles an accepted translation start with the original attempt, grant and expiry", async () => {
  const original = invoke.getMockImplementation()!, ref = createRef<TranslationHandle>(); let lost = true;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const value = await original(command, args);
    if (command === "start_plugin_translation" && lost) { lost = false; throw new Error("Lost accepted acknowledgement"); }
    return value;
  });
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" }));
  await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("checkbox", { name: /I allow this exact plugin to extract this captured translation file/ }));
  await user.click(screen.getByRole("button", { name: "Import for review" }));
  const retry = await screen.findByRole("button", { name: "Reconcile original translation operation" });
  expect(await ref.current!.allowLeave()).toBe(false);
  expect(screen.getByRole("button", { name: "Choose new translation input" })).toBeDisabled();
  await user.click(retry);
  await screen.findByRole("button", { name: "Review independent translation check" });
  const starts = invoke.mock.calls.filter(([name]) => name === "start_plugin_translation");
  expect(starts).toHaveLength(2); expect(starts[1][1]).toEqual(starts[0][1]);
  expect(invoke.mock.calls.some(([name]) => name === "start_translation_check")).toBe(false);
  expect(invoke.mock.calls.some(([name]) => name === "prepare_translation_projection")).toBe(false);
});

it("retains translation preparation across views and explicitly protects project departure", async () => {
  const ref = createRef<TranslationHandle>(), user = userEvent.setup();
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" }));
  await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await user.click(screen.getByRole("button", { name: "Translations" }));
  expect(screen.getByText(/Captured i18n\/zh.json/)).toBeVisible();
  let leaving!: Promise<boolean>; await act(async () => { leaving = ref.current!.allowLeave(); });
  await user.click(await screen.findByRole("button", { name: "Keep editing" }));
  expect(await leaving).toBe(false); expect(screen.getByText(/Captured i18n\/zh.json/)).toBeVisible();
  expect(invoke.mock.calls.some(([name]) => name === "start_plugin_translation")).toBe(false);
});

it("blocks a rejected independent translation check and preserves the original proposal", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const value = await original(command, args);
    if (command === "finish_translation_check") pluginAttempts.get(String(args.request.translationAttemptId))!.items[0].status.validation = "invalid";
    return value;
  });
  const user = userEvent.setup(); render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" }));
  await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("checkbox", { name: /I allow this exact plugin to extract/ })); await user.click(screen.getByRole("button", { name: "Import for review" }));
  await user.click(await screen.findByRole("button", { name: "Review independent translation check" }));
  expect(await screen.findByRole("button", { name: "Run independent translation check" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I separately allow this exact checker/ })); await user.click(screen.getByRole("button", { name: "Run independent translation check" }));
  await user.click(await screen.findByRole("button", { name: "Record translation check" }));
  await screen.findByText(/The mandatory translation check rejected/);
  expect(screen.queryByRole("button", { name: "Prepare checked translation preview" })).not.toBeInTheDocument();
  const producerStart = invoke.mock.calls.find(([name]) => name === "start_plugin_translation")![1].request;
  const checkerStart = invoke.mock.calls.find(([name]) => name === "start_translation_check")![1].request;
  expect(checkerStart.grantId).not.toBe(producerStart.grantId); expect(checkerStart.attemptId).not.toBe(producerStart.attemptId);
  expect(screen.getByText(/Captured i18n\/zh.json/)).toBeVisible();
});

it("derives import availability from declared capabilities while preserving editing", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_source_content"
    ? Promise.resolve({ ...content, namespace: "webvtt:source" }) : command === "read_plugin_inventory"
    ? Promise.resolve({ ...translationInventory, packageDecisions: [] }) : original(command, args));
  const user = userEvent.setup(); render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" }));
  await screen.findByText(/Enable a translation package matching the current source profile/);
  expect(screen.getByRole("button", { name: "Choose translation folder" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Edit translations" })); await user.click(await screen.findByRole("button", { name: "first" }));
  expect(await screen.findByRole("textbox", { name: "Your draft" })).toBeEnabled();
  expect(invoke.mock.calls.some(([name]) => ["select_source", "preflight_translation", "start_translation_import"].includes(name))).toBe(false);
});


it("shows a qualified empty file without a misleading page range or adoption", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_translation_preview"
    ? Promise.resolve({ ...preview, attemptId: args.request.attemptId, total: 0, unique: 0, rows: [] }) : original(command, args));
  const user = userEvent.setup(); render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" })); await importDeclaredTranslation(user);
  expect(await screen.findByText(/The checked file contains no translation entries/)).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Apply 0 unique matches" })).toBeDisabled();
  expect(invoke.mock.calls.some(([name]) => name === "prepare_translation_adoption")).toBe(false);
});

it("reviews a new checker attempt after cancellation without recapturing the producer", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "cancel_execution_task") {
      const detail = [...pluginAttempts.values()].find(value => value.taskId === args.request.taskId)!;
      detail.items[0].status.execution = "cancelled-before-dispatch"; detail.items[0].status.cancellationRequested = true; detail.items[0].resultId = null;
      detail.progress.succeeded = 0; detail.progress.cancelled = 1; return "1";
    }
    const value = await original(command, args);
    if (command === "start_translation_check") {
      const detail = pluginAttempts.get(String(args.request.attemptId))!;
      detail.items[0].status.execution = "queued"; detail.items[0].status.validation = "absent"; detail.items[0].resultId = null;
      detail.progress.succeeded = 0; detail.progress.queued = 1;
    }
    return value;
  });
  const user = userEvent.setup(); render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" })); await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("checkbox", { name: /I allow this exact plugin to extract/ })); await user.click(screen.getByRole("button", { name: "Import for review" }));
  await user.click(await screen.findByRole("button", { name: "Review independent translation check" }));
  await user.click(await screen.findByRole("checkbox", { name: /I separately allow this exact checker/ })); await user.click(screen.getByRole("button", { name: "Run independent translation check" }));
  await user.click(await screen.findByRole("button", { name: i18n.t("execution.cancel") }));
  await user.click(await screen.findByRole("button", { name: "Review independent translation check" }));
  expect(await screen.findByRole("button", { name: "Run independent translation check" })).toBeDisabled();
  const checks = invoke.mock.calls.filter(([name]) => name === "prepare_translation_check");
  expect(checks).toHaveLength(2); expect(checks[1][1].request.attemptId).not.toBe(checks[0][1].request.attemptId);
  expect(checks[1][1].request.translationResultId).toEqual(checks[0][1].request.translationResultId);
  expect(invoke.mock.calls.filter(([name]) => name === "preflight_plugin_translation")).toHaveLength(1);
});


it("preserves captured input when installed settings change and blocks new authorization", async () => {
  const original = invoke.getMockImplementation()!; let revision = "1";
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_plugin_translation"
    ? Promise.resolve({ ...translationView, settingsRevision: revision }) : original(command, args));
  const user = userEvent.setup(), view = render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" })); await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("checkbox", { name: /I allow this exact plugin to extract/ }));
  revision = "2"; view.rerender(<TranslationWorkbench project={project} disabled />); view.rerender(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Refresh installed translation choices" }));
  await screen.findByText(/Extension settings changed after capture/);
  expect(screen.getByText(/Captured i18n\/zh.json/)).toBeVisible(); expect(screen.getByRole("button", { name: "Import for review" })).toBeDisabled();
  expect(invoke.mock.calls.some(([name]) => name === "start_plugin_translation")).toBe(false);
});
