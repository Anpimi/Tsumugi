import type { ReviewBasis } from "../../../reviewCommands";
import type { EntryReviewPanelProps } from "./reviewTypes";

export type EntryFallbackPanelProps = EntryReviewPanelProps;
export interface EntryFallbackPayload {
  kind: "entry-review-fallback";
  unitId: string;
  locale: string;
  basis: string;
  sourceSnapshotId: string;
  sourceRevisionId: string;
  selectionId: string | null;
  revisionId: string | null;
  basisEvidence: ReviewBasis;
  expectedFallbackId: string | null;
  actor: string;
  reason: string;
  editSeq: number;
  allow: boolean;
}
