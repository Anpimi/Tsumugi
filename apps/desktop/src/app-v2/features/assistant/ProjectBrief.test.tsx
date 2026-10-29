import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DecisionPage } from "../../../decisionCommands";
import { executionContext } from "../../../executionCommands";
import { projectBriefEn, projectBriefZh } from "../../../i18n/projectBrief";
import type { ProjectView } from "../../../projectCommands";
import type { SegmentPageRequest } from "../../../segmentCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import fixture from "../../../../test/fixtures/segmentCommands.contract.json";
import ProjectBrief, { type ProjectBriefProps } from "./ProjectBrief";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const base = fixture.responses.segmentPage;
const project: ProjectView = { sessionToken: "synthetic-project-brief", locator: "/synthetic/brief", reconciliationState: "settled",
  metadata: { projectId: base.projectId, displayName: "Synthetic brief", sourceLocale: "en-US", targetLocales: ["zh-CN", "fr"], metadataRevision: "1" } };
const position = { unitId: base.rows[0].content.unitId, locale: "zh-CN", nativeKey: "greeting.{{name}}" };
let reads: SessionReads, language = createInstance();
let sourceEmpty: boolean, failLocale: string | null, changedSelection: boolean;
beforeEach(async () => {
  sourceEmpty = false; failLocale = null; changedSelection = false; invoke.mockReset();
  language = createInstance(); await language.use(initReactI18next).init({ lng: "en-US", fallbackLng: "en-US",
    resources: { "en-US": { translation: { projectBrief: projectBriefEn } }, "zh-CN": { translation: { projectBrief: projectBriefZh } } },
    interpolation: { escapeValue: false } });
  reads = new SessionReads(executionContext(project));
  invoke.mockImplementation(async (command: string, { request }: { request: SegmentPageRequest }) => {
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: sourceEmpty ? null : base.sourceSnapshotId };
    if (command !== "read_segment_page") throw new Error(`Unexpected business command: ${command}`);
    expect(request).toMatchObject({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, limit: 1, scopeId: null, cursor: null });
    if (request.locale === failLocale) throw new Error("Synthetic language read failed");
    const selected = request.query.selection === "selected", blocking = request.query.status === "blocking";
    const page = structuredClone(base), row = page.rows[0];
    row.content.locale = request.locale; row.protection.locale = request.locale;
    return { ...page, locale: request.locale, query: request.query, total: blocking ? 1 : selected ? 6 : 8,
      sequence: selected && changedSelection ? "2" : page.sequence };
  });
});
afterEach(() => { cleanup(); reads.retire(); });

function decisionPage(total: number | null = 2): DecisionPage {
  return { projectId: project.metadata.projectId, query: { locale: null, sources: ["translation-candidate"] }, basis: "a".repeat(64),
    total, knownCount: 2, items: [], next: null, coverage: [], deliveryActivity: [], executionActivity: [], localActions: null };
}
function setup(overrides: Partial<ProjectBriefProps> = {}) {
  const props: ProjectBriefProps = { project, visible: true, disabled: false, briefEligible: true, previousPosition: position,
    decisions: { page: decisionPage(), loading: false, error: null }, onContinue: vi.fn(), onEntries: vi.fn(), onImport: vi.fn(), onDecisions: vi.fn(), ...overrides };
  const content = (value: ProjectBriefProps) => <I18nextProvider i18n={language}><SessionReadProvider reads={reads} context={executionContext(project)} bridge={false}>
    <ProjectBrief {...value}/></SessionReadProvider></I18nextProvider>;
  const view = render(content(props)); let current = props;
  return { props, ...view, update: (patch: Partial<ProjectBriefProps>) => { current = { ...current, ...patch }; view.rerender(content(current)); }, user: userEvent.setup() };
}

it.each(["en-US", "zh-CN"])("reads deterministic counts and opens only explicit manual actions (%s)", async locale => {
  await language.changeLanguage(locale); const h = setup();
  const title = locale === "en-US" ? "Project brief" : "项目简报";
  const progress = locale === "en-US" ? "Selected translations: 6 / 8" : "已选译文：6 / 8";
  expect(screen.getByRole("heading", { name: title })).toBeVisible();
  await waitFor(() => expect(screen.getAllByText(progress)).toHaveLength(2));
  expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  expect(screen.getByText(locale === "en-US" ? "Waiting for your decision: 2" : "待你决定：2 项")).toBeVisible();
  expect(screen.getByText(locale === "en-US" ? projectBriefEn.reviewSeparate : projectBriefZh.reviewSeparate)).toBeVisible();
  await h.user.click(screen.getByRole("button", { name: locale === "en-US" ? "Continue greeting.{{name}} · zh-CN" : "继续 greeting.{{name}} · zh-CN" }));
  expect(h.props.onContinue).toHaveBeenCalledWith(position);
  await h.user.click(screen.getByRole("button", { name: locale === "en-US" ? "Open entries" : "打开条目" }));
  expect(h.props.onEntries).toHaveBeenCalledWith("zh-CN", "all");
  await h.user.click(screen.getByRole("button", { name: locale === "en-US" ? "Review waiting decisions" : "查看待决定事项" }));
  expect(h.props.onDecisions).toHaveBeenCalledOnce();
  expect(new Set(invoke.mock.calls.map(([command]) => command))).toEqual(new Set(["read_content_scope", "read_segment_page"]));
  expect(invoke.mock.calls.filter(([command]) => command === "read_segment_page")).toHaveLength(6);
});

it("keeps successful languages and partial decisions while a failed language stays unknown", async () => {
  failLocale = "fr"; const h = setup({ decisions: { page: decisionPage(null), loading: false, error: null } });
  await screen.findByText("Selected translations: 6 / 8");
  expect(screen.getByText("Translation progress is not available.")).toBeVisible();
  expect(screen.getByText("At least 2 decisions are waiting; some sources are incomplete.")).toBeVisible();
  expect(screen.queryByText("Selected translations: 0 / 0")).not.toBeInTheDocument();
  failLocale = null; await h.user.click(screen.getByRole("button", { name: "Refresh project counts" }));
  await waitFor(() => expect(screen.getAllByText("Selected translations: 6 / 8")).toHaveLength(2));
});

it("does not combine counts from different committed observations", async () => {
  changedSelection = true; setup();
  await waitFor(() => expect(screen.getAllByText("8 source entries; selected translation count is not available.")).toHaveLength(2));
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.getAllByText("Entries blocking delivery: 1")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Refresh project counts" })).toBeEnabled();
});

it("shows an import guide for a real empty source without reading segment or model data", async () => {
  sourceEmpty = true; const h = setup();
  await screen.findByText("This project has no source entries yet. Import source content to begin.");
  await h.user.click(screen.getByRole("button", { name: "Import source content" }));
  expect(h.props.onImport).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_content_scope"]);
  expect(screen.queryByRole("button", { name: /Continue/ })).not.toBeInTheDocument();
});

it("does not read or act for an ineligible brief and retains a failed decision count as unknown", async () => {
  const h = setup({ briefEligible: false }); expect(screen.queryByRole("region")).not.toBeInTheDocument(); expect(invoke).not.toHaveBeenCalled();
  h.update({ briefEligible: true, decisions: { page: decisionPage(), loading: false, error: new Error("Synthetic feed failure") } });
  await screen.findByText("Decisions could not be read.");
  h.update({ disabled: true });
  expect(screen.getByRole("button", { name: "Open entries" })).toBeDisabled();
  await act(async () => { reads.retire(); });
});
