import type { TranslationDrafts } from "../editor/translationDrafts";
import type { RefObject } from "react";
import type { ProjectView } from "../../../projectCommands";
import type { ReviewDraftState } from "../../../ReviewDraftSession";
import type { ReviewSummary } from "../../../reviewCommands";
import type { WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { WorkspaceSelection } from "../../workspace/workspaceSelection";
import type { ReviewOwner } from "./reviewTypes";

/** A view-owned read intent; the serial is not a business action identity. */
export interface ReviewBatchReadRequest { serial: number; selection: WorkspaceSelection; expected?: readonly ReviewSummary[] }
export interface ReviewBatchReadPayload { kind: "review-batch-read"; chosen: ReviewDraftState["chosen"]; request: ReviewBatchReadRequest | null }
export interface ReviewBatchApprovePayload {
  kind: "review-batch-approve"; chosen: ReviewDraftState["chosen"]; actor: string; request: ReviewBatchReadRequest; queryVersion: number;
}
export interface ReviewBatchControlPayload { kind: "review-batch-control"; chosen: ReviewDraftState["chosen"]; items: ReviewDraftState["batchItems"] }
export interface ReviewBatchPagePayload extends Omit<ReviewBatchControlPayload, "kind"> { kind: "review-batch-page"; offset: number }
export interface ReviewBatchPanelProps {
  drafts?: TranslationDrafts;
  project: ProjectView; owner: ReviewOwner; selection: WorkspaceSelection | null; commands: WorkbenchCommands; gate: InteractionGate;
  viewId: string | null; disabled: boolean; open: boolean; onOpenChange: (open: boolean) => void; parentDialogId?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
}
