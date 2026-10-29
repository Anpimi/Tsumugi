import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executionContext } from "../../../executionCommands";
import { enUS } from "../../../i18n/en-US";
import { zhCN } from "../../../i18n/zh-CN";
import { knowledgeExchangeEn, knowledgeExchangeZh } from "../../../i18n/knowledgeExchange";
import type { ProjectView } from "../../../projectCommands";
import type { TbxFilePreview, TmxFilePreview } from "../../../resourceCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import KnowledgeExchangePreview, { type KnowledgeExchangePreviewProps } from "./KnowledgeExchangePreview";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "synthetic-exchange-session", locator: "/synthetic/exchange", reconciliationState: "settled",
  metadata: { projectId: id(91001), displayName: "Synthetic exchange", sourceLocale: "en-US", targetLocales: ["zh-CN", "fr"], metadataRevision: "1" } };
const provenance = { creationTool: null, creationToolVersion: null, originalTmFormat: null,
  creationId: null, creationDate: null, changeId: null, changeDate: null };
function tmx(count = 1): TmxFilePreview {
  return { projectId: project.metadata.projectId, fileName: "memory.tmx", preview: { profile: "tmx-1.4b-plain-text-preview", digest: "a".repeat(64), byteLen: 123,
    sourceLocale: "en-US", targetLocale: "zh-CN", license: "unknown", header: provenance,
    rows: Array.from({ length: count }, (_, index) => ({ ordinal: index + 1, tuid: `origin-${index + 1}`, sourceText: `Source ${index + 1}\n  {{name}}`, targetText: `译文 ${index + 1}`,
      status: "eligible", reasons: [], effectiveSourceLocale: "en-US", tuProvenance: provenance, sourceProvenance: provenance, targetProvenance: provenance })),
    losses: [{ kind: "unmapped-metadata", field: "note", count: 18, samples: [{ byteOffset: 7, ordinal: 1, path: "/tmx/body/tu[1]/note" }], unlisted: 17 }] } };
}
function tbx(): TbxFilePreview {
  return { projectId: project.metadata.projectId, fileName: "terms.tbx", preview: { profile: "tbx-basic-dca-subset-preview", digest: "b".repeat(64), byteLen: 456,
    sourceLocale: "en-US", targetLocale: "zh-CN", documentLocale: "de-DE", license: "unknown", titles: ["Unverified title"], sourceDescriptions: ["Unverified contributor"],
    rows: [{ ordinal: 1, conceptId: "concept-A", status: "possible-mapping", reasons: [],
      sourceTerms: [{ languageOrdinal: 1, ordinal: 1, termSecId: "source-A", text: "Barrel", usageStatuses: ["preferredTerm-admn-sts"], sources: ["Original source"], reasons: [] }],
      targetTerms: [{ languageOrdinal: 2, ordinal: 1, termSecId: "target-A", text: "木桶 {{name}}", usageStatuses: [], sources: [], reasons: [] }] }],
    losses: [{ kind: "schema-hint", field: "xml-model", count: 2, samples: [{ byteOffset: 23, ordinal: null, path: "/" }], unlisted: 1 }] } };
}
let reads: SessionReads, language = createInstance();
beforeEach(async () => {
  invoke.mockReset(); reads = new SessionReads(executionContext(project)); language = createInstance();
  await language.use(initReactI18next).init({ lng: "en-US", fallbackLng: "en-US", interpolation: { escapeValue: false }, resources: {
    "en-US": { translation: { knowledgeExchange: knowledgeExchangeEn, tmxExchange: enUS.tmxExchange, tbxExchange: enUS.tbxExchange } },
    "zh-CN": { translation: { knowledgeExchange: knowledgeExchangeZh, tmxExchange: zhCN.tmxExchange, tbxExchange: zhCN.tbxExchange } },
  } });
  invoke.mockImplementation(async (command: string) => {
    if (command === "preview_tmx_exchange") return tmx(21);
    if (command === "preview_tbx_exchange") return tbx();
    throw new Error(`Unexpected business command: ${command}`);
  });
});
afterEach(() => { cleanup(); reads.retire(); });
function setup(overrides: Partial<KnowledgeExchangePreviewProps> = {}) {
  let props: KnowledgeExchangePreviewProps = { project, locale: "zh-CN", format: "tmx", visible: true, disabled: false, current: () => true, onClose: vi.fn(), ...overrides };
  const content = () => <I18nextProvider i18n={language}><SessionReadProvider reads={reads} context={executionContext(project)} bridge={false}>
    <KnowledgeExchangePreview {...props}/></SessionReadProvider></I18nextProvider>;
  const view = render(content());
  return { ...view, user: userEvent.setup(), update: (patch: Partial<KnowledgeExchangePreviewProps>) => { props = { ...props, ...patch }; view.rerender(content()); } };
}

it.each(["en-US", "zh-CN"])("previews TMX through the original typed command without importing, exporting or model calls (%s)", async locale => {
  await language.changeLanguage(locale); const h = setup();
  expect(screen.getByRole("heading", { name: locale === "en-US" ? "Exchange file preview" : "交换文件预览" })).toBeVisible();
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.getByText(locale === "en-US" ? knowledgeExchangeEn.readOnly : knowledgeExchangeZh.readOnly)).toBeVisible();
  await h.user.click(screen.getByRole("button", { name: language.t("tmxExchange.choose") }));
  const text = await screen.findByText("Source 1 {{name}}"); expect(text.textContent).toBe("Source 1\n  {{name}}");
  expect(screen.queryByText("Source 21 {{name}}")).not.toBeInTheDocument();
  await h.user.click(screen.getByRole("button", { name: language.t("tmxExchange.next") }));
  expect(screen.getByText("Source 21 {{name}}")).toBeVisible();
  expect(screen.getByText(language.t("tmxExchange.unlisted", { count: 17 }))).toBeVisible();
  expect(invoke.mock.calls).toEqual([["preview_tmx_exchange", { request: { ...executionContext(project), locale: "zh-CN" } }]]);
});

it("preserves TBX candidates, document metadata and exact losses without choosing preferred terms", async () => {
  const h = setup({ format: "tbx" }); await h.user.click(screen.getByRole("button", { name: "Choose TBX file to preview" }));
  await screen.findByText("terms.tbx");
  await h.user.click(screen.getByRole("button", { name: language.t("tbxExchange.documentMetadata") }));
  expect(screen.getByText("Unverified title")).toBeVisible(); expect(screen.getByText("Unverified contributor")).toBeVisible();
  await h.user.click(screen.getByRole("button", { name: language.t("tbxExchange.showCandidates") }));
  expect(screen.getByText("Barrel")).toBeVisible(); expect(screen.getByText("木桶 {{name}}")).toBeVisible();
  await h.user.click(screen.getAllByRole("button", { name: language.t("tbxExchange.termMetadata") })[0]);
  expect(screen.getByText("Original source")).toBeVisible(); expect(screen.getByText("preferredTerm-admn-sts")).toBeVisible();
  await h.user.click(screen.getByRole("button", { name: language.t("tbxExchange.samples", { count: 1 }) }));
  expect(screen.getByText(language.t("tbxExchange.sample", { path: "/", byteOffset: "23", ordinal: language.t("tbxExchange.noOrdinal") }))).toBeVisible();
  expect(invoke.mock.calls).toEqual([["preview_tbx_exchange", { request: { ...executionContext(project), locale: "zh-CN" } }]]);
});

it("keeps the new format and language while a late chooser result A settles, retaining the shared picker gate", async () => {
  let finish!: (value: TmxFilePreview) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const h = setup(); await h.user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  h.update({ format: "tbx", locale: "fr" });
  expect(screen.getByRole("button", { name: "Choose TBX file to preview" })).toBeDisabled();
  await act(async () => { finish(tmx()); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose TBX file to preview" })).toBeEnabled());
  expect(screen.queryByText("memory.tmx")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Choose TMX file to preview" })).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledOnce();
});

it.each(["project", "target", "source", "profile"])("rejects a mismatched %s identity and retries only after another explicit choice", async mismatch => {
  const wrong = tmx();
  if (mismatch === "project") wrong.projectId = id(91999);
  if (mismatch === "target") wrong.preview.targetLocale = "fr";
  if (mismatch === "source") wrong.preview.sourceLocale = "de";
  if (mismatch === "profile") wrong.preview.profile = "another-profile";
  invoke.mockResolvedValueOnce(wrong); const h = setup();
  await h.user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(language.t("tmxExchange.readFailed"));
  expect(screen.queryByText("memory.tmx")).not.toBeInTheDocument(); expect(invoke).toHaveBeenCalledOnce();
  await h.user.click(screen.getByRole("button", { name: "Choose TMX file to preview" }));
  await screen.findByText("memory.tmx"); expect(invoke).toHaveBeenCalledTimes(2);
});

it("does not reopen a chooser on source invalidation, hidden views or unavailable interaction", async () => {
  const h = setup(); await h.user.click(screen.getByRole("button", { name: "Choose TMX file to preview" })); await screen.findByText("memory.tmx");
  await act(async () => { reads.invalidate(["source"]); });
  expect(screen.queryByText("memory.tmx")).not.toBeInTheDocument(); expect(invoke).toHaveBeenCalledOnce();
  h.update({ disabled: true }); expect(screen.getByRole("button", { name: "Choose TMX file to preview" })).toBeDisabled();
  h.update({ visible: false }); expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  h.update({ visible: true, disabled: false, current: () => false });
  await h.user.click(screen.getByRole("button", { name: "Choose TMX file to preview" })); expect(invoke).toHaveBeenCalledOnce();
});
