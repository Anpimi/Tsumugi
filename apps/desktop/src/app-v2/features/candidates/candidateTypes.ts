import type { useCandidateDecisionSession } from "../../../CandidateDecisionSession";
import type { DraftKey } from "../../../draftCommands";
import type { CandidateDisposition, TranslationRevision } from "../../../translationCommands";
import type { WorkProtectionSession } from "../../../WorkProtectionSession";
import type { CandidateBatchSession } from "./CandidateBatchSession";

export interface CandidateOwners {
  decisions: ReturnType<typeof useCandidateDecisionSession>;
  protection: WorkProtectionSession;
  batch: CandidateBatchSession;
  decide: (key: DraftKey, revision: TranslationRevision, disposition: CandidateDisposition, proof: () => boolean) => Promise<void>;
}
