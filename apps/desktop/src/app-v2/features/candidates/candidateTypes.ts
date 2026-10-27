import type { useCandidateDecisionSession } from "../../../CandidateDecisionSession";
import type { DraftKey } from "../../../draftCommands";
import type { CandidateDisposition, TranslationRevision } from "../../../translationCommands";
import type { WorkProtectionSession } from "../../../WorkProtectionSession";

export interface CandidateOwners {
  decisions: ReturnType<typeof useCandidateDecisionSession>;
  protection: WorkProtectionSession;
  decide: (key: DraftKey, revision: TranslationRevision, disposition: CandidateDisposition, proof: () => boolean) => Promise<void>;
}
