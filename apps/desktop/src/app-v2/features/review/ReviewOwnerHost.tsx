import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { ReviewDraftProvider, useReviewDraftSession } from "../../../ReviewDraftSession";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { useSessionReads } from "../../../SessionReadProvider";
import type { ProjectLifecycle, LeaveIntent } from "../../platform/projectLifecycle";
import type { TranslationDrafts } from "../editor/translationDrafts";
import type { ReviewOwner } from "./reviewTypes";
import { reviewBlocked, reviewHasDraft } from "./reviewState";

interface Props {
  project: ProjectView;
  drafts: TranslationDrafts;
  lifecycle: ProjectLifecycle;
  onOwner: (owner: ReviewOwner | null) => void;
  onReveal: () => void;
}
const leavesProject = (intent: LeaveIntent) => ["open-project", "close-project", "close-window"].includes(intent.kind);

function ReviewBridge({ project, lifecycle, onOwner, onReveal }: Omit<Props, "drafts">) {
  const review = useReviewDraftSession(), reads = useSessionReads(), owner = useRef(review);
  const callbacks = useRef({ onOwner, onReveal }), published = useRef<{ owner: ReviewOwner; inFlight: boolean } | null>(null);
  const completion = useRef(review.state.completionVersion), context = executionContext(project);
  useLayoutEffect(() => {
    owner.current = review; callbacks.current = { onOwner, onReveal };
    if (completion.current !== review.state.completionVersion) {
      completion.current = review.state.completionVersion; reads.invalidate(["review"]);
    }
    const previous = published.current, inFlight = review.inFlight();
    if (previous?.owner.state === review.state && previous.owner.semantic.state === review.semantic.state && previous.inFlight === inFlight) return;
    published.current = { owner: review, inFlight }; callbacks.current.onOwner(review);
  });
  useLayoutEffect(() => () => { published.current = null; callbacks.current.onOwner(null); }, []);
  useLayoutEffect(() => {
    function inspect(intent: LeaveIntent) {
      if (!leavesProject(intent)) return { status: "ready" as const, revision: "retained-review-session" };
      const current = owner.current;
      return { status: reviewBlocked(current) ? "blocked" as const : reviewHasDraft(current) ? "dirty" as const : "ready" as const,
        revision: JSON.stringify([current.current(), current.semantic.current(), current.inFlight()]) };
    }
    return lifecycle.register({ id: "entry-review", area: "review", scope: { kind: "project", ...context }, inspect,
      prepareLeave: async (intent, proof, current) => proof() && current() && inspect(intent).status === "ready",
      reveal: () => callbacks.current.onReveal() });
  }, [lifecycle, context.projectId, context.sessionToken]);
  return null;
}

function ReviewOwnerHost({ drafts, ...props }: Props) {
  const mutations = useMemo(() => ({ reserveMutation: () => drafts.reserveMutation("retained-for-navigation"),
    releaseMutation: (token: symbol) => drafts.releaseMutation(token) }), [drafts]);
  return <ReviewDraftProvider project={props.project} mutations={mutations}><ReviewBridge {...props}/></ReviewDraftProvider>;
}
export default memo(ReviewOwnerHost);
