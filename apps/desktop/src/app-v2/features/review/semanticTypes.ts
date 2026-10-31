import type { TaskActivity } from "../../../ExecutionTaskSession";
import type { ProjectView } from "../../../projectCommands";
import type { ReviewTarget, ReviewBasis } from "../../../reviewCommands";
import type { WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { EntryReviewPanelProps, ReviewOwner } from "./reviewTypes";

export type EntrySemanticPanelProps = EntryReviewPanelProps & { batchTargets?: readonly ReviewTarget[] };
export type EntrySemanticPreparation = NonNullable<ReviewOwner["semantic"]["state"]["prepared"]>;
export type EntrySemanticPending = NonNullable<ReviewOwner["semantic"]["state"]["pending"]>;
export interface EntrySemanticCapture {
  targets?: string;
  unitId: string;
  locale: string;
  sourceSnapshotId: string;
  sourceRevisionId: string;
  selectionId: string;
  revisionId: string;
  basis: string;
  basisEvidence: ReviewBasis;
  sequence: number;
}
export interface EntrySemanticPreparePayload extends EntrySemanticCapture { kind: "entry-semantic-prepare" }
export interface EntrySemanticStartPayload extends EntrySemanticCapture { kind: "entry-semantic-start"; preparation: EntrySemanticPreparation }
export interface EntrySemanticConsentPayload extends EntrySemanticCapture { kind: "entry-semantic-consent"; preparation: EntrySemanticPreparation; approved: boolean }
export interface EntrySemanticScopePayload { kind: "entry-semantic-scope"; sequence: number }
export interface EntrySemanticReadPayload { kind: "entry-semantic-read"; attemptId: string }
export interface EntrySemanticRecordPayload extends EntrySemanticCapture {
  kind: "entry-semantic-record";
  attemptId: string;
  taskId: string;
  itemId: string;
  resultId: string;
  recoveryUnitId: string;
  queryVersion: number;
}
export interface EntrySemanticPendingPayload { kind: "entry-semantic-pending"; pending: EntrySemanticPending }
export interface EntrySemanticTaskPayload { kind: "entry-semantic-task"; activity: TaskActivity; queryVersion: number | null }
export interface EntrySemanticCancelPayload {
  kind: "entry-semantic-cancel";
  taskId: string;
  attemptId: string;
  requestId: string | null;
  queryVersion: number | null;
}
export interface SemanticRecoveryPanelProps {
  commandPrefix?: "review.entry-semantic" | "review.batch-semantic";
  project: ProjectView;
  owner: ReviewOwner;
  commands: WorkbenchCommands;
  gate: InteractionGate;
  viewId: string | null;
  disabled: boolean;
  visible: boolean;
  parentDialogId?: string;
}
