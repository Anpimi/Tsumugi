import type { DraftBasis } from "../../../draftCommands";
import type { ReviewDiagnosticLocation, ReviewTarget } from "../../../reviewCommands";
import type { ReviewDiagnosticIntent } from "../../../reviewDiagnosticNavigation";
import type { WorkspaceView } from "../../workspace/workspaceStore";

export interface EntryReviewEditorRequest {
  target: ReviewTarget;
  diagnostic?: { intent: ReviewDiagnosticIntent; location: ReviewDiagnosticLocation };
}
/** A one-time DOM selection, separate from the entity's retained draft. */
export interface EntryDiagnosticFocus {
  id: string;
  unitId: string;
  locale: string;
  sourceText: string;
  translationText: string | null;
  basis: DraftBasis;
  editSeq: string;
  location: ReviewDiagnosticLocation["location"];
  status: "pending" | "applied" | "stale";
}
export type EntryReviewReturn = Pick<WorkspaceView, "focus" | "locale" | "preset" | "query" | "searchInput" | "scroll" | "selection"
  | "queueActive" | "queueAnchor" | "queueScopeId" | "afterOrdinal" | "cursor" | "detailTab" | "dock" | "dockOpen">;
export interface EntryReviewNavigation {
  returnTo: EntryReviewReturn;
  focus: EntryDiagnosticFocus | null;
}
