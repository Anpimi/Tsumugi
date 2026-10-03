import { invoke } from "@tauri-apps/api/core";
import type { SessionRequest } from "./executionCommands";
import type { TranslationHistory } from "./translationCommands";
import type { ContextRevision, TermResolution } from "./resourceCommands";

export type DecisionKind = "approve" | "request-changes";
export interface ReviewDecision { decisionId: string; actionId: string; unitId: string; locale: string; basis: string; selectionId: string; revisionId: string; sourceRevisionId: string; actor: string; kind: DecisionKind; reason: string; createdAt: string }
export interface CheckFinding { issueId: string; rule: string; code: string; detail: string; severity: string; waivable: boolean }
export interface CheckRuleResult { rule: string; status: string; reason: string | null; findings: CheckFinding[] }
export interface CheckRun { runId: string; actionId: string; unitId: string; locale: string; basis: string; validatorVersion: string; outcome: "completed" | "failed" | "cancelled"; rules: CheckRuleResult[]; createdAt: string }
export interface Waiver { waiverId: string; actionId: string; unitId: string; locale: string; basis: string; issueId: string; grant: boolean; previousWaiverId: string | null; policyVersion: string; actor: string; reason: string; createdAt: string }
export interface FallbackDecision { fallbackId: string; actionId: string; unitId: string; locale: string; sourceRevisionId: string; allow: boolean; previousFallbackId: string | null; policyVersion: string; actor: string; reason: string; createdAt: string }
export interface ReviewTarget { unitId: string; locale: string; nativeKey: string; sourceSnapshotId: string; sourceRevisionId: string; sourceText: string; selectionId: string | null; revisionId: string | null; translationText: string | null; basis: string; termConflict: boolean; currentDecision: ReviewDecision | null; currentCheck: CheckRun | null; currentFallback: FallbackDecision | null; currentWaivers: Waiver[] }
export interface ReviewPage { rows: ReviewTarget[]; nextOrdinal: number | null; total: number }
export interface ReviewSummary {
  unitId: string; locale: string; nativeKey: string; sourceSnapshotId: string;
  sourceRevisionId: string; sourcePreview: string; translationPreview: string | null;
  selectionId: string | null; revisionId: string | null; basis: string;
  currentDecision: Pick<ReviewDecision, "decisionId" | "basis" | "kind"> | null;
  currentCheck: Pick<CheckRun, "runId" | "basis" | "outcome"> & { hasFindings: boolean } | null;
}
export interface ReviewSummaryPage {
  rows: ReviewSummary[]; nextOrdinal: number | null; total: number;
  scopeId: string; sourceSnapshotId: string; readVersion: string;
}
export interface ReviewEditorSnapshot {
  target: ReviewTarget; translations: TranslationHistory; terms: TermResolution;
  context: ContextRevision | null; readVersion: string;
}
export interface ReviewNeighbor { unitId: string | null; afterOrdinal: number | null; sourceSnapshotId: string }
export interface ReviewScopeCapture {
  scopeId: string; sourceSnapshotId: string; locale: string; query: string;
  units: { unitId: string; expectedBasis: string; expectedDecisionId: string | null }[];
  readVersion: string;
}
export interface ReviewHistoryPage { decisions: ReviewDecision[]; checks: CheckRun[]; waivers: Waiver[]; fallbacks: FallbackDecision[]; nextOffset: number | null }
export interface WorkItem { unitId: string; locale: string; nativeKey: string; reasons: string[]; basis: string }
export interface WorkPage { items: WorkItem[]; total: number; nextOffset: number | null; coverage: string }
export interface EligibilityReason { unitId: string; nativeKey: string; code: string; reference: string | null }
export interface EligibilityLocale { locale: string; ready: boolean; blockers: EligibilityReason[]; exceptions: EligibilityReason[]; checkedUnits: number; blockerCount: number; exceptionCount: number }
export interface Eligibility { policyVersion: string; sourceSnapshotId: string; basis: string; ready: boolean; locales: EligibilityLocale[] }
export interface ReviewWrite { projectId: string; actionId: string; unitId: string; locale: string; expectedBasis: string; expectedDecisionId: string | null; actor: string; kind: DecisionKind; reason: string }
export interface WaiverWrite { projectId: string; actionId: string; unitId: string; locale: string; expectedBasis: string; issueId: string; grant: boolean; expectedWaiverId: string | null; actor: string; reason: string }
export interface FallbackWrite { projectId: string; actionId: string; unitId: string; locale: string; expectedBasis: string; allow: boolean; expectedFallbackId: string | null; actor: string; reason: string }

export const reviewCommands = {
  summaryPage: (request: SessionRequest & { locale: string; query: string; scopeId: string | null; afterOrdinal: number; limit: number }) => invoke<ReviewSummaryPage>("read_review_summary_page", { request }),
  editorSnapshot: (request: SessionRequest & { unitId: string; locale: string }) => invoke<ReviewEditorSnapshot>("read_review_editor_snapshot", { request }),
  neighbor: (request: SessionRequest & { unitId: string; locale: string; scopeId: string; direction: -1 | 1 }) => invoke<ReviewNeighbor>("read_review_neighbor", { request }),
  captureScope: (request: SessionRequest & { locale: string; scopeId: string; excluded: string[] }) => invoke<ReviewScopeCapture>("capture_review_scope", { request }),
  page: (request: SessionRequest & { locale: string; query?: string; afterOrdinal: number; limit: number }) => invoke<ReviewPage>("read_review_page", { request }),
  target: (request: SessionRequest & { unitId: string; locale: string }) => invoke<ReviewTarget>("read_review_target", { request }),
  history: (request: SessionRequest & { unitId: string; locale: string; offset: number; limit: number }) => invoke<ReviewHistoryPage>("read_review_history", { request }),
  decide: (session: SessionRequest, decision: ReviewWrite) => invoke<ReviewDecision>("write_review_decision", { request: { ...session, decision } }),
  check: (request: SessionRequest & { unitId: string; locale: string; expectedBasis: string; actionId: string }) => invoke<CheckRun>("run_review_checks", { request }),
  cancelCheck: (request: SessionRequest & { actionId: string }) => invoke<boolean>("cancel_review_checks", { request }),
  waive: (session: SessionRequest, waiver: WaiverWrite) => invoke<Waiver>("waive_review_issue", { request: { ...session, waiver } }),
  fallback: (session: SessionRequest, fallback: FallbackWrite) => invoke<FallbackDecision>("allow_source_fallback", { request: { ...session, fallback } }),
  work: (request: SessionRequest & { locale: string; offset: number; limit: number }) => invoke<WorkPage>("read_review_work", { request }),
  eligibility: (request: SessionRequest & { locales: string[] }) => invoke<Eligibility>("read_review_eligibility", { request }),
};
