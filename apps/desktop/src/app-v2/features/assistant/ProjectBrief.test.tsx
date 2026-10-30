import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DecisionPage } from "../../../decisionCommands";
import { executionContext } from "../../../executionCommands";
import { projectBriefEn, projectBriefZh } from "../../../i18n/projectBrief";
import type { ProjectView } from "../../../projectCommands";
import type { Eligibility, EligibilityLocale } from "../../../reviewCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import fixture from "../../../../test/fixtures/segmentCommands.contract.json";
import reviewFixture from "../../../../test/fixtures/reviewCommands.contract.json";
import ProjectBrief, { type ProjectBriefProps } from "./ProjectBrief";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const base = fixture.responses.segmentPage;
const project: ProjectView = { sessionToken: "synthetic-project-brief", locator: "/synthetic/brief", reconciliationState: "settled",
  metadata: { projectId: base.projectId, displayName: "Synthetic brief", sourceLocale: "en-US", targetLocales: ["zh-CN", "fr"], metadataRevision: "1" } };
const position = { unitId: base.rows[0].content.unitId, locale: "zh-CN", nativeKey: "greeting.{{name}}" };
let reads: SessionReads, language = createInstance();
let sourceEmpty: boolean, missingLocale: string | null, failReport: boolean;
let reportPatch: Partial<Eligibility>, localePatch: Partial<EligibilityLocale>;
beforeEach(async () => {
  sourceEmpty = false; missingLocale = null; failReport = false; reportPatch = {}; localePatch = {}; invoke.mockReset();
  language = createInstance(); await language.use(initReactI18next).init({ lng: "en-US", fallbackLng: "en-US",
    resources: { "en-US": { translation: { projectBrief: projectBriefEn } }, "zh-CN": { translation: { projectBrief: projectBriefZh } } },
    interpolation: { escapeValue: false } });
  reads = new SessionReads(executionContext(project));
  invoke.mockImplementation(async (command: string, { request }: { request: { projectId: string; sessionToken: string; locales: string[] } }) => {
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: sourceEmpty ? null : base.sourceSnapshotId };
    if (command !== "read_review_eligibility") throw new Error(`Unexpected business command: ${command}`);
    expect(request).toEqual({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, locales: project.metadata.targetLocales });
    if (failReport) throw new Error("Synthetic report read failed");
    const report = structuredClone(reviewFixture.responses.eligibility), entry = report.locales[0];
    return { ...report, sourceSnapshotId: base.sourceSnapshotId, epoch: base.epoch, sequence: base.sequence,
      locales: request.locales.filter(locale => locale !== missingLocale).map(locale => ({ ...entry, locale, checkedUnits: 8, selectedUnits: 6,
        blockingUnits: 1, blockerCount: 2, blockers: [entry.blockers[0], { ...entry.blockers[0], code: "qa-missing", reference: null }], ...localePatch })), ...reportPatch };
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
  expect(screen.getAllByText(locale === "en-US" ? "Entries blocking delivery: 1" : "阻塞交付的条目：1")).toHaveLength(2);
  expect(new Set(invoke.mock.calls.map(([command]) => command))).toEqual(new Set(["read_content_scope", "read_review_eligibility"]));
  expect(invoke.mock.calls.filter(([command]) => command === "read_review_eligibility")).toHaveLength(1);
});

it("keeps reported languages and partial decisions while an omitted language stays unknown", async () => {
  missingLocale = "fr";
  // The omitted locale can keep the complete assessment not ready even when
  // every locale returned in this partial observation is ready.
  localePatch = { ready: true, blockerCount: 0, blockingUnits: 0, blockers: [] };
  const h = setup({ decisions: { page: decisionPage(null), loading: false, error: null } });
  await screen.findByText("Selected translations: 6 / 8");
  expect(screen.getByText("Translation progress is not available.")).toBeVisible();
  expect(screen.getByText("At least 2 decisions are waiting; some sources are incomplete.")).toBeVisible();
  expect(screen.queryByText("Selected translations: 0 / 0")).not.toBeInTheDocument();
  missingLocale = null; localePatch = {}; await h.user.click(screen.getByRole("button", { name: "Refresh project counts" }));
  await waitFor(() => expect(screen.getAllByText("Selected translations: 6 / 8")).toHaveLength(2));
  expect(invoke.mock.calls.filter(([command]) => command === "read_review_eligibility")).toHaveLength(2);
});

it("keeps a report for a different source snapshot unknown", async () => {
  reportPatch = { sourceSnapshotId: "60000000-0000-4000-8000-000000000001" }; setup();
  expect(await screen.findByRole("button", { name: "Refresh project counts" })).toBeEnabled();
  await waitFor(() => expect(screen.getAllByText("Translation progress is not available.")).toHaveLength(2));
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.getAllByText("Delivery blocker count is not available.")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Refresh project counts" })).toBeEnabled();
});

it("keeps the whole atomic report unknown after failure and recovers through one explicit read", async () => {
  failReport = true; const h = setup();
  const refresh = await screen.findByRole("button", { name: "Refresh project counts" });
  await waitFor(() => expect(refresh).toBeEnabled());
  await waitFor(() => expect(screen.getAllByText("Translation progress is not available.")).toHaveLength(2));
  expect(screen.queryByText("Selected translations: 0 / 0")).not.toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.getByText("Waiting for your decision: 2")).toBeVisible();
  failReport = false; await h.user.click(refresh);
  await waitFor(() => expect(screen.getAllByText("Selected translations: 6 / 8")).toHaveLength(2));
  expect(invoke.mock.calls.filter(([command]) => command === "read_review_eligibility")).toHaveLength(2);
});

it.each(["epoch", "sequence", "selected", "blocking", "foreign locale"] as const)("rejects an invalid %s report without inventing progress", async invalid => {
  if (invalid === "epoch") reportPatch = { epoch: "invalid-epoch" };
  if (invalid === "sequence") reportPatch = { sequence: "invalid-sequence" };
  if (invalid === "selected") localePatch = { selectedUnits: 9 };
  if (invalid === "blocking") localePatch = { blockingUnits: 3 };
  if (invalid === "foreign locale") localePatch = { locale: "de-DE" };
  setup();
  await waitFor(() => expect(screen.getAllByText("Translation progress is not available.")).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh project counts" })).toBeEnabled());
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
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
