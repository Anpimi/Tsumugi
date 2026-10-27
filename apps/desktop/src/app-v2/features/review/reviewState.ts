import type { ReviewOwner } from "./reviewTypes";

export function reviewHasDraft(owner: ReviewOwner): boolean {
  const state = owner.current();
  return Object.values(state.drafts).some(value => value.length > 0) || Object.keys(state.chosen).length > 0
    || !!state.checkReview || state.checkConsent.length > 0 || state.advisoryChecks.length > 0 || owner.semantic.dirty();
}

export function reviewBlocked(owner: ReviewOwner): boolean {
  const state = owner.current();
  return owner.inFlight() || state.busyMutation || state.checkingAction || !!state.pending || state.batchRunning;
}
