import { memo, useLayoutEffect, useRef } from "react";
import type { ProjectView } from "../../../projectCommands";
import { useSessionReads } from "../../../SessionReadProvider";
import type { ProjectLifecycle } from "../../platform/projectLifecycle";
import type { TranslationDrafts } from "../editor/translationDrafts";
import { ComparisonSession } from "./ComparisonSession";

export interface ComparisonOwnerHostProps {
  project: ProjectView;
  drafts: TranslationDrafts;
  lifecycle: ProjectLifecycle;
  onOwner: (owner: ComparisonSession | null) => void;
  onReveal: () => void;
}
function ComparisonOwnerHost({ project, drafts, lifecycle, onOwner, onReveal }: ComparisonOwnerHostProps) {
  const reads = useSessionReads(), callbacks = useRef({ onOwner, onReveal }), owner = useRef<ComparisonSession | null>(null);
  useLayoutEffect(() => { callbacks.current = { onOwner, onReveal }; });
  useLayoutEffect(() => {
    const session = new ComparisonSession({ project, drafts, reads }); owner.current = session;
    const unregister = lifecycle.register(session.lifecycleParticipant(() => callbacks.current.onReveal()));
    callbacks.current.onOwner(session);
    return () => { unregister(); owner.current = null; callbacks.current.onOwner(null); session.dispose(); };
  }, [drafts, reads, lifecycle, project.metadata.projectId, project.sessionToken]);
  useLayoutEffect(() => { owner.current?.updateProject(project); });
  return null;
}
export default memo(ComparisonOwnerHost);
