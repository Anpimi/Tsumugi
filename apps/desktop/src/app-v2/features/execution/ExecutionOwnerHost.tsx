import { memo, useLayoutEffect, useRef, type ReactNode } from "react";
import { ExecutionTaskProvider, useExecutionTaskSession } from "../../../ExecutionTaskSession";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import type { ProjectLifecycle, LeaveIntent, LifecycleParticipant } from "../../platform/projectLifecycle";
import type { TranslationDrafts } from "../editor/translationDrafts";

interface Props {
  project: ProjectView;
  drafts: TranslationDrafts;
  lifecycle: ProjectLifecycle;
  onReveal: (operation: string | null, attemptId: string | null) => void;
  onOwner?: (owner: ReturnType<typeof useExecutionTaskSession> | null) => void;
  onParticipant?: (participant: LifecycleParticipant | null) => void;
  children: ReactNode;
}
const leavesProject = (intent: LeaveIntent) => intent.kind === "open-project" || intent.kind === "close-project" || intent.kind === "close-window";

function ExecutionOwnerBridge({ project, lifecycle, onReveal, onOwner, onParticipant }: Omit<Props, "drafts" | "children">) {
  const tasks = useExecutionTaskSession(), context = executionContext(project);
  const current = useRef({ tasks, onReveal });
  useLayoutEffect(() => { current.current = { tasks, onReveal }; });
  const published = useRef<ReturnType<typeof useExecutionTaskSession> | null>(null);
  useLayoutEffect(() => {
    const previous = published.current;
    if (previous && previous.state === tasks.state && previous.activity === tasks.activity && previous.busy === tasks.busy) return;
    published.current = tasks; onOwner?.(tasks);
  });
  useLayoutEffect(() => () => { published.current = null; onOwner?.(null); }, [onOwner]);
  useLayoutEffect(() => {
    function inspect(intent: LeaveIntent) {
      // Task recovery remains mounted; the draft coordinator independently
      // retains its original mutation and navigation restrictions.
      if (!leavesProject(intent)) return { status: "ready" as const, revision: "retained-project-session" };
      const owner = current.current.tasks, unresolved = owner.unresolved();
      return { status: unresolved ? "blocked" as const : "ready" as const,
        revision: JSON.stringify([owner.state, owner.currentActivity(), unresolved]) };
    }
    const participant: LifecycleParticipant = { id: "execution-tasks", area: "tasks", scope: { kind: "project", ...context }, inspect,
      prepareLeave: async (intent, proof, current) => proof() && current() && inspect(intent).status === "ready",
      reveal: () => {
        const owner = current.current.tasks, latest = owner.currentActivity();
        const activity = latest && !["recorded", "rejected"].includes(latest.phase) ? latest : null;
        const cancellation = Object.values(owner.state).find(value => ["preparing", "pending", "checking", "unknown"].includes(value.phase));
        current.current.onReveal(activity?.intent.operation ?? null, activity?.intent.attemptId ?? cancellation?.target.attemptId ?? null);
      } };
    if (onParticipant) { onParticipant(participant); return () => onParticipant(null); }
    return lifecycle.register(participant);
  }, [lifecycle, context.projectId, context.sessionToken, onParticipant]);
  return null;
}

/** Retained task consumers share their original requests and the project mutation coordinator. */
function ExecutionOwnerHost({ project, drafts, lifecycle, onReveal, onOwner, onParticipant, children }: Props) {
  return <ExecutionTaskProvider project={project} mutations={drafts}>
    <ExecutionOwnerBridge project={project} lifecycle={lifecycle} onReveal={onReveal} onOwner={onOwner} onParticipant={onParticipant}/>
    {children}
  </ExecutionTaskProvider>;
}
export default memo(ExecutionOwnerHost);
