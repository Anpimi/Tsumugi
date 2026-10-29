import { memo, useLayoutEffect, useRef } from "react";
import { SourceDraftSession, useSourceDraftSession } from "../../../SourceDraftSession";
import { useSessionReads } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import type { LeaveIntent, LifecycleParticipant, ProjectLifecycle } from "../../platform/projectLifecycle";
import type { SourceOwner } from "./sourceTypes";

interface Props {
  project: ProjectView;
  lifecycle: ProjectLifecycle;
  onOwner: (owner: SourceOwner | null) => void;
  onParticipant: (participant: LifecycleParticipant | null) => void;
  onReveal: () => void;
}
function Bridge({ project, onOwner, onParticipant, onReveal }: Props) {
  const owner = useSourceDraftSession(), reads = useSessionReads(), context = executionContext(project);
  const current = useRef(owner), callbacks = useRef({ onOwner, onReveal }), published = useRef<SourceOwner | null>(null);
  const completion = useRef(owner.state.completionVersion);
  useLayoutEffect(() => {
    current.current = owner; callbacks.current = { onOwner, onReveal };
    if (completion.current !== owner.state.completionVersion) {
      completion.current = owner.state.completionVersion; reads.invalidate(["source", "translation", "resources", "review", "execution"]);
    }
    if (published.current?.state === owner.state && published.current?.hook.state === owner.hook.state && published.current?.journal === owner.journal) return;
    published.current = owner; callbacks.current.onOwner(owner);
  });
  useLayoutEffect(() => () => { published.current = null; callbacks.current.onOwner(null); }, []);
  useLayoutEffect(() => {
    function inspect(intent: LeaveIntent) {
      if (!["open-project", "close-project", "close-window"].includes(intent.kind)) return { status: "ready" as const, revision: "retained-source-session" };
      const owner = current.current;
      return { status: owner.blocked() ? "blocked" as const : owner.journal.dirty ? "dirty" as const : "ready" as const,
        revision: JSON.stringify([owner.current(), owner.hook.current(), owner.inFlight()]) };
    }
    const participant: LifecycleParticipant = { id: "source-maintenance", area: "source", scope: { kind: "project", ...context }, inspect,
      prepareLeave: async (_intent, proof, present) => {
        const owner = current.current, before = owner.current(), hook = owner.hook.current();
        return proof() && present() && !owner.blocked() && await owner.flush() && proof() && present()
          && current.current.current() === before && current.current.hook.current() === hook && !current.current.blocked();
      }, reveal: () => callbacks.current.onReveal() };
    onParticipant(participant); return () => onParticipant(null);
  }, [context.projectId, context.sessionToken, onParticipant]);
  return null;
}
function SourceOwnerHost(props: Props) { return <SourceDraftSession project={props.project}><Bridge {...props}/></SourceDraftSession>; }
export default memo(SourceOwnerHost);
