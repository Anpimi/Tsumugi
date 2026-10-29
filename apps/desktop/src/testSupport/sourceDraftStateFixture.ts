import type { SourceDraftInputs } from "../sourceDraftJournal";

/** Empty original-owner state for isolated local journal scenarios. */
export function sourceDraftStateFixture(): SourceDraftInputs {
  return { source: { domain: "", source: null, selection: null, selectionLabel: null, captureRequest: null, checkPrepareRequest: null,
    comparisonRef: null, receiptRef: null, pickerUncertain: false, preparationExpired: false, submission: null,
    pendingUncertain: false, recoveredPending: false, pendingObserved: null, sourceLanguage: "en", declared: false,
    preflight: null, attempt: null, preview: null, comparison: null, updating: false, lineage: {}, actor: "", filter: "", appliedFilter: "",
    manualOrdinal: null, historicalQuery: "", previewAfter: 0, comparisonAfter: 0, historicalSearch: null, estimate: null, confirmed: false,
    stale: false, editSeq: 0, pendingStart: null, checkingStart: false, startRetryAllowed: false, pendingPlugin: null,
    producerConsent: null, checkReview: null, checkerConsent: null, checkAttempt: null, pendingApply: null, pendingApplyUnitId: null,
    preparedAction: null, receiptChecked: false, checkingReceipt: false, busyMutation: false, failure: null, receipt: null, completionVersion: 0 },
  hook: { enabled: false, locale: "", activation: null, preparing: false, preparationFailure: null, sourceActionId: null,
    originalActivation: null, originalRequest: null, reading: false, readFailure: null, closed: false, drained: false, stopping: false,
    stop: null, stopFailure: null, waitEnded: false } };
}
