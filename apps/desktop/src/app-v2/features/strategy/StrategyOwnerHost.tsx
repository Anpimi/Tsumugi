import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { StrategyDraftSession, useStrategyDraftSession, type StrategyOwner, type StrategyTranslationMutation } from "../../../StrategyDraftSession";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import type { LifecycleParticipant, ProjectLifecycle } from "../../platform/projectLifecycle";
import type { TranslationDrafts } from "../editor/translationDrafts";

interface Props {
  project: ProjectView;
  drafts: TranslationDrafts;
  lifecycle: ProjectLifecycle;
  onOwner: (owner: StrategyOwner | null) => void;
  onReveal: () => void;
  onParticipant?: (participant: LifecycleParticipant | null) => void;
}

function Bridge({ project, lifecycle, onOwner, onReveal, onParticipant }: Props) {
  const value = useStrategyDraftSession(), context = executionContext(project);
  const owner = useRef(value), callbacks = useRef({ onOwner, onReveal });
  const revision = useRef({ state: value.current(), journalDirty: value.journalDirty, blocked: value.blocked(), sequence: 0 });
  useLayoutEffect(() => { owner.current = value; callbacks.current = { onOwner, onReveal }; onOwner(value); }, [value, onOwner, onReveal]);
  useLayoutEffect(() => () => callbacks.current.onOwner(null), []);
  useLayoutEffect(() => {
    const participant: LifecycleParticipant = {
      id: "context-strategy-input", area: "ai", scope: { kind: "project", ...context },
      inspect: intent => {
        if (["navigate", "language", "close-view", "restore"].includes(intent.kind)) return { status: "ready", revision: "retained-strategy-presentation" };
        const current = owner.current, state = current.current(), blocked = current.blocked();
        const previous = revision.current;
        if (previous.state !== state || previous.journalDirty !== current.journalDirty || previous.blocked !== blocked)
          revision.current = { state, journalDirty: current.journalDirty, blocked, sequence: previous.sequence + 1 };
        return { status: blocked ? "blocked" : current.journalDirty ? "dirty" : "ready", revision: String(revision.current.sequence) };
      },
      prepareLeave: async (_intent, proof, current) => {
        if (!proof() || !current()) return false;
        const before = owner.current.journalSeq;
        return await owner.current.flush() && current() && owner.current.journalSeq === before && !owner.current.blocked() && !owner.current.journalDirty;
      },
      reveal: () => callbacks.current.onReveal(),
    };
    if (onParticipant) { onParticipant(participant); return () => onParticipant(null); }
    return lifecycle.register(participant);
  }, [lifecycle, context.projectId, context.sessionToken, onParticipant]);
  return null;
}

function StrategyOwnerHost(props: Props) {
  const { drafts } = props;
  const translationMutation = useMemo<StrategyTranslationMutation>(() => ({
    get mutationReserved() { return drafts.getSnapshot().mutationReserved; },
    reserveMutation: () => drafts.reserveMutation("retained-for-navigation"),
    releaseMutation: token => drafts.releaseMutation(token),
  }), [drafts]);
  return <StrategyDraftSession project={props.project} translationMutation={translationMutation}><Bridge {...props}/></StrategyDraftSession>;
}
export default memo(StrategyOwnerHost);
