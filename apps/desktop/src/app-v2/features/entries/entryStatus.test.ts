import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement, Profiler } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import type { workbenchEn } from "../../../i18n/workbench";
import type { DraftKey, DraftSummary, DraftValue } from "../../../draftCommands";
import type { SegmentRow } from "../../../segmentCommands";
import type { DraftEntry } from "../editor/translationDrafts";
import EntryStatus, { type EntryStatusProps } from "./EntryStatus";
import { deriveEntryStatus } from "./deriveEntryStatus";

type WorkbenchTextKey = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
const w = (key: WorkbenchTextKey) => i18n.t(`workbenchV2.${key}`);
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(cleanup);

const counts = { passed: 0, findings: 0, missing: 0, unavailable: 0, failed: 0, cancelled: 0,
  unknown: 0, notApplicable: 0, findingCount: 0 };
const key: DraftKey = { projectId: "project", unitId: "unit", locale: "zh-CN" };

function untranslated(): SegmentRow {
  return {
    content: { unitId: key.unitId, locale: key.locale, sourceSnapshotId: "snapshot", sourceRevisionId: "source",
      nativeKey: "greeting", sourcePreview: "Hello, {{name}}", translationPreview: null,
      selectionId: null, revisionId: null, basis: "current-basis", currentDecision: null, currentCheck: null },
    sourceTruncated: false, translationTruncated: false, candidateCount: 0, aiCandidateCount: 0,
    protection: { unitId: key.unitId, locale: key.locale, revision: "0", protected: false },
    qa: { current: false, outcome: null, mandatoryCoverageComplete: null, mandatory: { ...counts }, advisory: { ...counts } },
    terms: { applicableEntryCount: 0, conflictingEntryCount: 0, revisionCount: 0, revisions: [], truncated: false },
    applicability: { selectedSourceRevisionId: null, sourceBasisCurrent: null, capturedBasisCurrent: null,
      resourceImpact: null, resourceReviewRequired: false },
    qualification: { blockerCount: 2, blockers: [{ code: "translation-missing", reference: null },
      { code: "qa-missing-or-stale", reference: null }], exceptionCount: 0, exceptions: [], truncated: false },
  };
}
function selected(): SegmentRow {
  const row = untranslated();
  Object.assign(row.content, { selectionId: "selection", revisionId: "translation", translationPreview: "你好，{{name}}" });
  Object.assign(row.applicability, { selectedSourceRevisionId: "source", sourceBasisCurrent: true, capturedBasisCurrent: true });
  row.qualification.blockers[0] = { code: "approval-missing-or-stale", reference: null };
  return row;
}
function reviewed(): SegmentRow {
  const row = selected();
  row.content.currentDecision = { decisionId: "review", basis: row.content.basis, kind: "approve" };
  blockers(row, "qa-missing-or-stale");
  return row;
}
function blockers(row: SegmentRow, ...codes: string[]) {
  row.qualification = { blockerCount: codes.length, blockers: codes.map(code => ({ code, reference: null })),
    exceptionCount: 0, exceptions: [], truncated: false };
}
function currentCheck(row: SegmentRow) {
  const check: NonNullable<SegmentRow["content"]["currentCheck"]> = {
    runId: "check", basis: row.content.basis, outcome: "completed", hasFindings: false, hasIncomplete: false,
  };
  row.content.currentCheck = check;
  row.qa = { current: true, outcome: "completed", mandatoryCoverageComplete: true,
    mandatory: { ...counts, passed: 1 }, advisory: { ...counts } };
  blockers(row);
  return check;
}
function draft(row: SegmentRow, text: string): DraftEntry & { value: DraftValue } {
  const basis = { sourceRevisionId: row.content.sourceRevisionId, selectionId: row.content.selectionId,
    revisionId: row.content.revisionId, text: row.content.translationPreview };
  return { key, head: { key, revision: "0", value: null, writerId: null },
    value: { basis, text, editSeq: "1", pending: null },
    current: { kind: "current", basis, nativeKey: row.content.nativeKey, sourceText: row.content.sourcePreview },
    durableSeq: null, journalPending: true, busy: false, checking: false, recovery: null,
    replayAllowed: false, failure: null, currentFailure: null, basisCurrent: true, newerInputAfterConfirmation: false };
}

it("keeps missing translation, approval and checks out of the blocking-problem glyph", () => {
  expect(deriveEntryStatus(untranslated())).toMatchObject({ state: "untranslated", labelKey: "entryStatusUntranslated" });
  expect(deriveEntryStatus(selected())).toMatchObject({ state: "translated", labelKey: "entryStatusTranslated" });
  // A review decision is independent of check completion and delivery eligibility.
  expect(deriveEntryStatus(reviewed())).toMatchObject({ state: "reviewed", labelKey: "entryStatusReviewed" });
});

it("shows an empty selected translation as translated and does not infer selection from preview text", () => {
  const row = selected(); row.content.translationPreview = "";
  expect(deriveEntryStatus(row).state).toBe("translated");
});

it("does not let approval hide a changed source or a required resource recheck", () => {
  const source = reviewed();
  Object.assign(source.applicability, { selectedSourceRevisionId: "older-source", sourceBasisCurrent: false, capturedBasisCurrent: false });
  expect(deriveEntryStatus(source)).toMatchObject({ state: "stale", labelKey: "entryStatusSourceChanged" });
  const resources = reviewed();
  Object.assign(resources.applicability, { capturedBasisCurrent: false, resourceReviewRequired: true,
    resourceImpact: { status: "needs-revalidation", reasonCount: 1, changes: [{ changeId: "term-change", kind: "term", confidence: "explicit-unit" }], truncated: false } });
  expect(deriveEntryStatus(resources)).toMatchObject({ state: "stale", labelKey: "entryStatusResourcesChanged" });
});

it("keeps historical resource differences separate from a completed current recheck", () => {
  const row = reviewed(); currentCheck(row);
  Object.assign(row.applicability, { capturedBasisCurrent: false, resourceReviewRequired: false,
    resourceImpact: { status: "needs-revalidation", reasonCount: 1, changes: [{ changeId: "term-change", kind: "term", confidence: "explicit-unit" }], truncated: false } });
  expect(deriveEntryStatus(row).state).toBe("reviewed");
});

it("uses the AI count and does not rename manual or imported history as AI candidates", () => {
  const row = reviewed(); row.candidateCount = 4;
  expect(deriveEntryStatus(row).state).toBe("reviewed");
  row.aiCandidateCount = 1;
  expect(deriveEntryStatus(row)).toMatchObject({ state: "candidate", labelKey: "entryStatusCandidate" });
  const empty = untranslated(); empty.candidateCount = 4; empty.aiCandidateCount = 1;
  expect(deriveEntryStatus(empty).state).toBe("candidate");
});

it.each([untranslated(), selected()])("opening unchanged input does not create a draft glyph", row => {
  const entry = draft(row, row.content.translationPreview ?? "");
  expect(deriveEntryStatus(row, entry)).toEqual(deriveEntryStatus(row));
});

it("shows unconfirmed input after it is durable and without requiring an active editor", () => {
  const row = reviewed(); row.candidateCount = 1; row.aiCandidateCount = 1;
  const entry = draft(row, "Unconfirmed e\u0301 👩🏽‍💻");
  entry.head = { ...entry.head, value: entry.value, revision: "1", writerId: "writer" };
  entry.durableSeq = "1"; entry.journalPending = false;
  expect(deriveEntryStatus(row, entry)).toMatchObject({ state: "draft", labelKey: "entryStatusDraft" });
  expect(deriveEntryStatus(row, draft(row, "")).state).toBe("draft");
});

it("keeps a retained merge unconfirmed when its text matches the selected version", () => {
  const row = selected(), entry = draft(row, row.content.translationPreview ?? "");
  entry.value.merge = { comparisonId: "comparison", contributors: ["parent-a", "parent-b"], expectedBasis: "a".repeat(64) };
  entry.journalPending = false; entry.durableSeq = entry.value.editSeq;
  expect(deriveEntryStatus(row, entry)).toMatchObject({ state: "draft", labelKey: "entryStatusDraft" });
});

it("keeps pending selection and newer input unconfirmed even when text matches the editing basis", () => {
  const row = selected(), entry = draft(row, row.content.translationPreview ?? "");
  const value = entry.value;
  value.pending = { kind: "selection", submittedSeq: "1", text: "Candidate text", request: {
    ...key, actionId: "original-action", revisionId: "candidate", sourceRevisionId: "source", expectedSelectionId: "selection",
  } };
  entry.recovery = "unchecked";
  expect(deriveEntryStatus(row, entry)).toMatchObject({ state: "draft", labelKey: "entryStatusPendingConfirmation" });
  value.pending = null; entry.newerInputAfterConfirmation = true;
  expect(deriveEntryStatus(row, entry)).toMatchObject({ state: "draft", labelKey: "entryStatusNewerDraft" });
});

it("shows a draft with an outdated basis as requiring a recheck, ahead of draft and candidate", () => {
  const row = reviewed(); row.aiCandidateCount = 1; row.candidateCount = 1;
  const entry = draft(row, "New input"); entry.basisCurrent = false;
  expect(deriveEntryStatus(row, entry)).toMatchObject({ state: "stale", labelKey: "entryStatusDraftBasisChanged" });
});

it("distinguishes unopened retained input from loaded text and flags a known old source", () => {
  const row = reviewed(), summary: DraftSummary = { key, revision: "1", editSeq: "3", sourceRevisionId: "source", hasPending: false };
  expect(deriveEntryStatus(row, summary)).toMatchObject({ state: "draft", labelKey: "entryStatusRetainedDraft" });
  expect(deriveEntryStatus(row, { ...summary, sourceRevisionId: "older-source" }))
    .toMatchObject({ state: "stale", labelKey: "entryStatusRetainedDraftSourceChanged" });
});

it("keeps current saved QA blockers ahead of a newer draft, candidate and approval", () => {
  const row = reviewed(); currentCheck(row).hasFindings = true;
  row.qa.mandatory = { ...counts, findings: 1, findingCount: 1 };
  blockers(row, "qa-issue");
  row.aiCandidateCount = 1; row.candidateCount = 1; row.applicability.resourceReviewRequired = true;
  expect(deriveEntryStatus(row, draft(row, "Newer B"))).toMatchObject({ state: "blocked", labelKey: "entryStatusQaIssue" });
});

it("does not reuse an absent old QA result to mark newer input blocked or approved", () => {
  const row = reviewed();
  // The current owner read has no valid QA result; no historical QA fields are fabricated.
  expect(row.content.currentCheck).toBeNull(); expect(row.qa.current).toBe(false);
  expect(deriveEntryStatus(row, draft(row, "Newer B"))).toMatchObject({ state: "draft", labelKey: "entryStatusDraft" });
});

it("does not turn advisory or waived findings into a blocking-problem glyph", () => {
  const row = reviewed(); currentCheck(row).hasFindings = true;
  row.qa.advisory = { ...counts, findings: 1, findingCount: 2 };
  row.qa.mandatory = { ...counts, findings: 1, findingCount: 1 };
  row.qualification = { blockerCount: 0, blockers: [], exceptionCount: 1,
    exceptions: [{ code: "issue-waiver", reference: "waived-issue" }], truncated: false };
  expect(deriveEntryStatus(row).state).toBe("reviewed");
});

it.each([
  ["qa-unavailable", "entryStatusQaUnavailable"],
  ["qa-incomplete-coverage", "entryStatusQaIncomplete"],
])("shows an owner-reported %s as a blocking problem", (code, labelKey) => {
  const row = selected(), check = currentCheck(row);
  if (code === "qa-unavailable") {
    check.outcome = "failed"; check.hasIncomplete = true;
    row.qa.outcome = "failed"; row.qa.mandatory = { ...counts, failed: 1 };
  } else {
    row.qa.mandatoryCoverageComplete = false; row.qa.mandatory = { ...counts, missing: 1 };
  }
  blockers(row, code);
  expect(deriveEntryStatus(row)).toMatchObject({ state: "blocked", labelKey });
});

it("shows current requested changes and conflicting terms as blocking problems", () => {
  const row = selected(); row.content.currentDecision = { kind: "request-changes", decisionId: "review", basis: row.content.basis };
  blockers(row, "changes-requested");
  expect(deriveEntryStatus(row)).toMatchObject({ state: "blocked", labelKey: "entryStatusChangesRequested" });
  row.content.currentDecision = null; row.terms.conflictingEntryCount = 1;
  expect(deriveEntryStatus(row)).toMatchObject({ state: "blocked", labelKey: "entryStatusTermConflict" });
});

it("keeps manual protection orthogonal to every main glyph", () => {
  const empty = untranslated(), saved = selected(), approved = reviewed(), ai = selected(), stale = selected(), blocked = selected();
  ai.aiCandidateCount = 1; ai.candidateCount = 1; stale.applicability.sourceBasisCurrent = false;
  blocked.terms.conflictingEntryCount = 1;
  const cases = [deriveEntryStatus(empty), deriveEntryStatus(saved), deriveEntryStatus(approved),
    deriveEntryStatus(ai), deriveEntryStatus(stale), deriveEntryStatus(blocked), deriveEntryStatus(saved, draft(saved, "New input"))];
  for (const row of [empty, saved, approved, ai, stale, blocked]) row.protection.protected = true;
  const protectedCases = [deriveEntryStatus(empty), deriveEntryStatus(saved), deriveEntryStatus(approved),
    deriveEntryStatus(ai), deriveEntryStatus(stale), deriveEntryStatus(blocked), deriveEntryStatus(saved, draft(saved, "New input"))];
  expect(protectedCases).toEqual(cases.map(status => ({ ...status, protected: true })));
});

it.each(["en-US", "zh-CN"] as const)("renders translated, protected and changed-source labels with real %s resources", async language => {
  await i18n.changeLanguage(language);
  const row = selected(); row.protection.protected = true;
  const ui = render(createElement(EntryStatus, { row, projectId: key.projectId, drafts: null }));
  expect(screen.getByRole("img", { name: w("entryStatusTranslated") })).toHaveAccessibleName(language === "en-US"
    ? "Translation selected; review approval is still needed." : "已有译文，尚未审阅通过。");
  expect(screen.getByRole("img", { name: w("entryStatusProtected") })).toHaveAccessibleName(language === "en-US"
    ? "Manually protected: automatic selection cannot replace this translation." : "人工保护：自动选择不会替换此译文。");
  const changed = { ...row, applicability: { ...row.applicability, sourceBasisCurrent: false } };
  ui.rerender(createElement(EntryStatus, { row: changed, projectId: key.projectId, drafts: null }));
  expect(screen.getByRole("img", { name: w("entryStatusSourceChanged") })).toHaveAttribute("data-state", "stale");
  expect(screen.queryByRole("img", { name: w("entryStatusTranslated") })).not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: w("entryStatusProtected") })).toBeVisible();
});

it("subscribes to the entity snapshot and leaves an unrelated row notification out of rendering", () => {
  const row = selected(), listeners = new Set<() => void>(), onRender = vi.fn();
  let entry = draft(row, row.content.translationPreview ?? "");
  const drafts: EntryStatusProps["drafts"] = {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getEntry: requested => requested.projectId === key.projectId && requested.unitId === key.unitId && requested.locale === key.locale ? entry : undefined,
    getSnapshot: () => ({ hydration: "ready", revision: 0, failure: null, retired: false, mutationReserved: false, summaries: [] }),
  };
  const props: EntryStatusProps = { row, projectId: key.projectId, drafts };
  const ui = render(createElement(Profiler, { id: "entry-status", onRender }, createElement(EntryStatus, props)));
  expect(screen.getByRole("img", { name: w("entryStatusTranslated") })).toHaveAttribute("data-state", "translated");
  const renders = onRender.mock.calls.length;
  act(() => listeners.forEach(listener => listener()));
  expect(onRender).toHaveBeenCalledTimes(renders);
  act(() => {
    const value: DraftValue = { ...entry.value, text: "Non-active local input", editSeq: "2" };
    entry = { ...entry, value }; listeners.forEach(listener => listener());
  });
  expect(screen.getByRole("img", { name: w("entryStatusDraft") })).toHaveAttribute("data-state", "draft");
  const protectedRow = { ...row, protection: { ...row.protection, protected: true } };
  ui.rerender(createElement(Profiler, { id: "entry-status", onRender }, createElement(EntryStatus, { ...props, row: protectedRow })));
  expect(screen.getByRole("img", { name: w("entryStatusProtected") })).toBeInTheDocument();
  ui.unmount(); expect(listeners.size).toBe(0);
});

it("uses stable retained metadata until the owner loads the entity, without reading each row", () => {
  const row = selected(), listeners = new Set<() => void>(), onRender = vi.fn();
  const summary: DraftSummary = { key, revision: "1", editSeq: "1", sourceRevisionId: "source", hasPending: false };
  let entry: DraftEntry | undefined;
  const drafts: EntryStatusProps["drafts"] = {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getEntry: () => entry,
    getSnapshot: () => ({ hydration: "ready", revision: 1, failure: null, retired: false, mutationReserved: false, summaries: [summary] }),
  };
  render(createElement(Profiler, { id: "retained-status", onRender }, createElement(EntryStatus, { row, projectId: key.projectId, drafts })));
  expect(screen.getByRole("img", { name: w("entryStatusRetainedDraft") })).toHaveAttribute("data-state", "draft");
  const renders = onRender.mock.calls.length;
  act(() => listeners.forEach(listener => listener()));
  expect(onRender).toHaveBeenCalledTimes(renders);
  act(() => { entry = draft(row, row.content.translationPreview ?? ""); listeners.forEach(listener => listener()); });
  expect(screen.getByRole("img", { name: w("entryStatusTranslated") })).toHaveAttribute("data-state", "translated");
});
