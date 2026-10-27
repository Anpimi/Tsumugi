import type { QueryKey } from "@tanstack/react-query";
import type { useReviewDraftSession, ReviewHumanPending, ReviewPending } from "../../../ReviewDraftSession";
import type { ProjectView } from "../../../projectCommands";
import type { ReviewTarget, ReviewWrite } from "../../../reviewCommands";
import type { WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { TranslationDrafts } from "../editor/translationDrafts";

export type ReviewOwner = ReturnType<typeof useReviewDraftSession>;
export interface ReviewEntryTarget {
  unitId: string;
  locale: string;
  basis: string;
  sourceSnapshotId: string;
  sourceRevisionId: string;
  selectionId: string | null;
  revisionId: string | null;
  expectedDecisionId: string | null;
}
export interface ReviewEntryCapture extends ReviewEntryTarget { actor: string; reason: string; editSeq: number }
export interface ReviewEntryDecisionPayload extends ReviewEntryCapture { kind: "entry-review-decision"; decision: ReviewWrite["kind"] }
export interface ReviewEntryBasisPayload extends ReviewEntryCapture { kind: "entry-review-basis"; current: ReviewEntryTarget }
export interface ReviewEntryPendingPayload { kind: "entry-review-pending"; pending: ReviewHumanPending }
export interface RetainedReviewPendingPayload { kind: "retained-review-pending"; pending: ReviewPending }
export interface EntryReviewPanelProps {
  project: ProjectView;
  target: ReviewTarget;
  owner: ReviewOwner;
  drafts: TranslationDrafts;
  commands: WorkbenchCommands;
  gate: InteractionGate;
  viewId: string | null;
  disabled: boolean;
  visible: boolean;
  parentDialogId?: string;
  read: { key: QueryKey; data: unknown };
}
