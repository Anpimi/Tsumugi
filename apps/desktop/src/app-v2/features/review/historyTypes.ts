import type { ProjectView } from "../../../projectCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import type { WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";

export interface ReviewHistoryCommandPayload {
  kind: "entry-review-history";
  unitId: string;
  locale: string;
  offset: number;
}

export interface EntryReviewHistoryProps {
  project: ProjectView;
  target: ReviewTarget;
  commands: WorkbenchCommands;
  gate: InteractionGate;
  viewId: string | null;
  disabled: boolean;
  visible: boolean;
  parentDialogId?: string;
  offset: number;
  onOffset: (offset: number) => void;
}
