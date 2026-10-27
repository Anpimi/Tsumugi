import { memo, useLayoutEffect, useRef, type ReactNode } from "react";
import { ExecutionTaskProvider, useExecutionTaskSession } from "../../../ExecutionTaskSession";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import type { ProjectLifecycle, LeaveIntent } from "../../platform/projectLifecycle";
import type { TranslationDrafts } from "../editor/translationDrafts";

interface Props {
  project: ProjectView;
  drafts: TranslationDrafts;
  lifecycle: ProjectLifecycle;
  onReveal: (operation: string | null) => void;
  children: ReactNode;
}
const leavesProject = (intent: LeaveIntent) => intent.kind === "open-project" || intent.kind === "close-project" || intent.kind === "close-window";

function ExecutionOwnerBridge({ project, lifecycle, onReveal }: Omit<Props, "drafts" | "children">) {
  const tasks = useExecutionTaskSession(), context = executionContext(project);
  const current = useRef({ tasks, onReveal });
  useLayoutEffect(() => { current.current = { tasks, onReveal }; });
  useLayoutEffect(() => {
    function inspect(intent: LeaveIntent) {
      // Task recovery remains mounted; the draft coordinator independently
      // retains its original mutation and navigation restrictions.
      if (!leavesProject(intent)) return { status: "ready" as const, revision: "retained-project-session" };
      const owner = current.current.tasks, unresolved = owner.unresolved();
      return { status: unresolved ? "blocked" as const : "ready" as const,
        revision: JSON.stringify([owner.state, owner.currentActivity(), unresolved]) };
    }
    return lifecycle.register({ id: "execution-tasks", area: "tasks", scope: { kind: "project", ...context }, inspect,
      prepareLeave: async (intent, proof, current) => proof() && current() && inspect(intent).status === "ready",
      reveal: () => current.current.onReveal(current.current.tasks.currentActivity()?.intent.operation ?? null) });
  }, [lifecycle, context.projectId, context.sessionToken]);
  return null;
}

/** Retained task consumers share their original requests and the project mutation coordinator. */
function ExecutionOwnerHost({ project, drafts, lifecycle, onReveal, children }: Props) {
  return <ExecutionTaskProvider project={project} mutations={drafts}>
    <ExecutionOwnerBridge project={project} lifecycle={lifecycle} onReveal={onReveal}/>
    {children}
  </ExecutionTaskProvider>;
}
export default memo(ExecutionOwnerHost);
