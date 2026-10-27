import { memo, useLayoutEffect, useRef } from "react";
import { useCandidateDecisionSession, type CandidateBasis } from "../../../CandidateDecisionSession";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { useWorkProtectionSession } from "../../../WorkProtectionSession";
import type { ProjectLifecycle, LeaveIntent } from "../../platform/projectLifecycle";
import type { TranslationDrafts } from "../editor/translationDrafts";
import type { CandidateOwners } from "./candidateTypes";

interface Props {
  project: ProjectView;
  drafts: TranslationDrafts;
  lifecycle: ProjectLifecycle;
  onOwners: (value: CandidateOwners | null) => void;
  onReveal: () => void;
}
const leavesProject = (intent: LeaveIntent) => intent.kind === "open-project" || intent.kind === "close-project" || intent.kind === "close-window";

/** The project retains audit input and original unknown requests across all candidate views. */
function CandidateOwnerHost({ project, drafts, lifecycle, onOwners, onReveal }: Props) {
  const decisions = useCandidateDecisionSession(project, { current: () => null,
    reserve: () => drafts.reserveMutation("retained-for-navigation"), release: token => drafts.releaseMutation(token) });
  const protection = useWorkProtectionSession(project, { reserve: () => drafts.reserveMutation("retained-for-navigation"), release: token => drafts.releaseMutation(token) });
  const callbacks = useRef({ onOwners, onReveal }), owner = useRef({ decisions, protection }), published = useRef<CandidateOwners | null>(null);
  useLayoutEffect(() => {
    callbacks.current = { onOwners, onReveal }; owner.current = { decisions, protection };
    if (published.current?.decisions.state === decisions.state && published.current.protection.state === protection.state) return;
    const value: CandidateOwners = { decisions, protection, decide: async (key, revision, disposition, proof) => {
      if (key.projectId !== project.metadata.projectId) return;
      const current = (): CandidateBasis | null => {
        const entry = drafts.getEntry(key);
        if (drafts.getSnapshot().retired || !entry || entry.current.kind !== "current" || entry.currentFailure !== null) return null;
        const basis = entry.current.basis;
        return { unitId: key.unitId, locale: key.locale, sourceRevisionId: basis.sourceRevisionId,
          baseSelectionId: basis.selectionId, baseRevisionId: basis.revisionId };
      };
      await owner.current.decisions.decide(revision, disposition, proof, current, async () => { await drafts.open(key); });
    } };
    published.current = value; callbacks.current.onOwners(value);
  });
  useLayoutEffect(() => () => { published.current = null; callbacks.current.onOwners(null); }, []);
  const context = executionContext(project);
  useLayoutEffect(() => {
    function inspect(intent: LeaveIntent) {
      if (!leavesProject(intent)) return { status: "ready" as const, revision: "retained-project-session" };
      const { decisions: decision, protection: protectedWork } = owner.current;
      return { status: decision.blocked() || protectedWork.blocked() ? "blocked" as const : decision.hasDraft() ? "dirty" as const : "ready" as const,
        revision: JSON.stringify([decision.current(), protectedWork.current()]) };
    }
    return lifecycle.register({ id: "candidate-decisions", area: "translation", scope: { kind: "project", ...context }, inspect,
      // Audit input is retained until the user explicitly discards it or records a decision.
      prepareLeave: async (intent, proof, current) => proof() && current() && inspect(intent).status === "ready",
      reveal: () => callbacks.current.onReveal() });
  }, [lifecycle, context.projectId, context.sessionToken]);
  return null;
}
export default memo(CandidateOwnerHost);
