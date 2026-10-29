import { memo, useLayoutEffect, useRef } from "react";
import { ResourceDraftSession, useResourceDraftSession } from "../../../ResourceDraftSession";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { useSessionReads } from "../../../SessionReadProvider";
import type { LeaveIntent, LifecycleParticipant, ProjectLifecycle } from "../../platform/projectLifecycle";
import type { KnowledgeOwner } from "./knowledgeTypes";
import { knowledgeBlocked } from "./knowledgeState";

interface Props {
  project: ProjectView;
  lifecycle: ProjectLifecycle;
  onOwner: (owner: KnowledgeOwner | null) => void;
  onReveal: () => void;
  onParticipant?: (participant: LifecycleParticipant | null) => void;
}
function Bridge({ project, lifecycle, onOwner, onReveal, onParticipant }: Props) {
  const value = useResourceDraftSession(), reads = useSessionReads();
  const owner = useRef(value), callbacks = useRef({ onOwner, onReveal });
  const completion = useRef(value.state.completionVersion), published = useRef<KnowledgeOwner | null>(null);
  const context = executionContext(project);
  useLayoutEffect(() => {
    owner.current = value; callbacks.current = { onOwner, onReveal };
    if (completion.current !== value.state.completionVersion) {
      completion.current = value.state.completionVersion;
      reads.invalidate(["resources"]);
    }
    if (published.current?.state === value.state && published.current?.journal === value.journal && published.current?.tool.state === value.tool.state && published.current?.tool.mcp.state === value.tool.mcp.state && published.current?.inFlight() === value.inFlight()) return;
    published.current = value; callbacks.current.onOwner(value);
  });
  useLayoutEffect(() => () => { published.current = null; callbacks.current.onOwner(null); }, []);
  useLayoutEffect(() => {
    function inspect(intent: LeaveIntent) {
      if (!["create-project", "open-project", "close-project", "close-window"].includes(intent.kind)) return { status: "ready" as const, revision: "retained-knowledge-session" };
      const current = owner.current;
      return { status: knowledgeBlocked(current) ? "blocked" as const : current.journal.dirty || current.tool.hasDraft() ? "dirty" as const : "ready" as const,
        revision: JSON.stringify([current.current(), current.inFlight(), current.tool.blocked(), current.tool.hasDraft()]) };
    }
    const participant: LifecycleParticipant = { id: "knowledge-resources", area: "resources", scope: { kind: "project", ...context }, inspect,
      prepareLeave: async (intent, proof, current) => {
        if (!proof() || !current() || owner.current.blocked() || owner.current.tool.hasDraft()) return false;
        const before = owner.current.current();
        return await owner.current.flush() && proof() && current() && owner.current.current() === before && !owner.current.blocked() && !owner.current.tool.hasDraft();
      },
      reveal: () => callbacks.current.onReveal() };
    if (onParticipant) { onParticipant(participant); return () => onParticipant(null); }
    return lifecycle.register(participant);
  }, [lifecycle, context.projectId, context.sessionToken, onParticipant]);
  return null;
}
function KnowledgeOwnerHost(props: Props) {
  return <ResourceDraftSession project={props.project}><Bridge {...props}/></ResourceDraftSession>;
}
export default memo(KnowledgeOwnerHost);
