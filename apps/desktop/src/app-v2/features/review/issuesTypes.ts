import type { AdvisoryFinding, ReviewBasis, ReviewFindingDisposition } from "../../../reviewCommands";
import type { EntryReviewPanelProps } from "./reviewTypes";

export interface EntryIssueCapture {
  unitId: string;
  locale: string;
  basis: string;
  sourceSnapshotId: string;
  sourceRevisionId: string;
  selectionId: string | null;
  revisionId: string | null;
  basisEvidence: ReviewBasis;
  actor: string;
  reason: string;
  editSeq: number;
}
export interface EntryIssueWaiverPayload extends EntryIssueCapture {
  kind: "entry-issue-waiver";
  runId: string;
  issueId: string;
  expectedWaiverId: string | null;
  grant: boolean;
}
export interface EntryIssueFindingPayload extends EntryIssueCapture {
  kind: "entry-issue-finding";
  purpose: AdvisoryFinding["purpose"];
  runId: string;
  issueId: string;
  expectedDecisionId: string | null;
  disposition: ReviewFindingDisposition;
  evidence: AdvisoryFinding;
}
export interface EntryIssuesReadPayload {
  kind: "entry-issues-read";
  unitId: string;
  locale: string;
  basis: string;
  offset: number;
  operation: "refresh" | "first" | "next" | "semantic" | "edit";
  semanticAttemptId: string | null;
}
export interface EntryIssuesPanelProps extends EntryReviewPanelProps { onEdit?: () => void }
