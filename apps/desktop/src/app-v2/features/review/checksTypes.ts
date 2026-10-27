import type { PluginTextReviewSelection } from "../../../pluginCommands";
import type { EntryReviewPanelProps, ReviewOwner } from "./reviewTypes";

export type EntryChecksPanelProps = EntryReviewPanelProps;
export type EntryChecksPreparation = NonNullable<ReviewOwner["state"]["checkReview"]>;
export type EntryChecksPending = Extract<NonNullable<ReviewOwner["state"]["pending"]>, { kind: "prepare-check" | "check" }>;
export interface EntryChecksCapture {
  unitId: string;
  locale: string;
  sourceSnapshotId: string;
  sourceRevisionId: string;
  selectionId: string | null;
  revisionId: string | null;
  basis: string;
  currentRunId: string | null;
  advisoryChecks: PluginTextReviewSelection[];
  settingsRevision: string;
}
export interface EntryChecksPreparePayload extends EntryChecksCapture { kind: "entry-checks-prepare" }
export interface EntryChecksRunPayload extends EntryChecksCapture {
  kind: "entry-checks-run";
  preparation: EntryChecksPreparation;
  consent: readonly string[];
}
export interface EntryChecksConsentPayload extends EntryChecksCapture {
  kind: "entry-checks-consent";
  preparation: EntryChecksPreparation;
  attemptId: string;
  inputDigest: string;
  approved: boolean;
}
export interface EntryChecksPendingPayload { kind: "entry-checks-pending"; pending: EntryChecksPending }
export interface EntryChecksDiscoveryPayload { kind: "entry-checks-discovery"; scopeKey: string }
export interface EntryChecksRemovePayload { kind: "entry-checks-remove-advisory"; scopeKey: string; choice: PluginTextReviewSelection }
