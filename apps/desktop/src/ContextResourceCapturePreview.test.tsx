import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it } from "vitest";
import aiWire from "../test/fixtures/aiCommands.contract.json";
import { AiPreviewItems } from "./AiPreviewItems";
import { ContextResourceCapturePreview, ContextResourceOmissions } from "./ContextResourceCapturePreview";
import { validateResponsePrepared } from "./generated/ai.validators";
import { i18n } from "./i18n";
import { contextResourceCaptureFixture, contextResourceFixture } from "./testSupport/contextResourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";

beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(cleanup);

it.each([
  ["en-US", "Included · Selected in this scope", "Not included · Conflicting content at the same priority"],
  ["zh-CN", "纳入 · 在此范围选用", "未纳入 · 同一优先级的内容冲突"],
])("shows frozen inclusion, scope limits and readable omissions in %s", async (locale, included, excluded) => {
  await i18n.changeLanguage(locale);
  const selected = contextResourceFixture(), conflict = contextResourceFixture({ revisionId: fixtureIdentity(75005), kind: "style", name: "Tone rule", text: "Conflicting frozen content" });
  const capture = contextResourceCaptureFixture([{ revision: selected, status: "selected", missingPaths: ["missing/another.json"] }, { revision: conflict, status: "conflict", missingPaths: [] }]);
  const user = userEvent.setup();
  render(<><ContextResourceCapturePreview capture={capture}/><ContextResourceOmissions items={[{ kind: "context-resource", label: "A frozen background name", reference: fixtureIdentity(75006), reason: "budget" }]}/></>);
  const region = screen.getByRole("region", { name: i18n.t("knowledge.contextMaterial") });
  expect(within(region).getByText(included)).toBeVisible(); expect(within(region).getByText(excluded)).toBeVisible();
  expect(within(region).getByText("Keep a calm tone.")).toBeVisible(); expect(within(region).getByText("Conflicting frozen content")).toBeVisible();
  expect(within(region).getByText(i18n.t("knowledge.contextMissingOtherFiles"))).toBeVisible();
  expect(within(region).getByText("missing/another.json")).toBeVisible();
  expect(screen.getByText(/A frozen background name/)).toHaveTextContent(i18n.t("knowledge.contextOmission.budget"));
  expect(screen.queryByText(`${fixtureIdentity(75006)} · budget`)).toBeNull();
  expect(screen.queryByText(selected.actor)).toBeNull(); expect(screen.queryByText(selected.reason)).toBeNull();
  await user.click(screen.getByRole("button", { name: i18n.t("knowledge.contextShowReferences") }));
  expect(screen.getByText(`${fixtureIdentity(75006)} · budget`)).toBeVisible();
});

it("uses only the supplied AI capture and removes it when the optional capture is absent", async () => {
  const prepared: unknown = structuredClone(aiWire.responses.prepared);
  if (!validateResponsePrepared(prepared)) throw new Error("A valid synthetic AI preview is required");
  const revision = contextResourceFixture();
  const capture = contextResourceCaptureFixture([{ revision, status: "selected", missingPaths: [] }]);
  const item = { ...prepared.preview.items[0], unitId: capture.scope.unitId, targetLocale: capture.scope.locale,
    sourceSnapshotId: capture.scope.sourceSnapshotId, sourceRevisionId: capture.scope.sourceRevisionId };
  const { rerender } = render(<AiPreviewItems items={[{ ...item, contextResources: capture }]}/>);
  expect(screen.getByRole("region", { name: "Project knowledge in this material" })).toHaveTextContent(revision.text);
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(screen.getByRole("region", { name: "这份材料中的项目资料" })).toHaveTextContent(revision.text);
  rerender(<AiPreviewItems items={[{ ...item, contextResources: undefined }]}/>);
  expect(screen.queryByRole("region", { name: "这份材料中的项目资料" })).toBeNull();
  expect(screen.queryByText(revision.text)).toBeNull();
});
