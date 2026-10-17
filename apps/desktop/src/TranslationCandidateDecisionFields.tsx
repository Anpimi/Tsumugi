import { useTranslation } from "react-i18next";
import { CommandFailureDetails } from "./CommandFailure";
import { useTranslationDraftSession } from "./TranslationDraftSession";

/** Both work areas edit the one session-owned decision draft and original action. */
export function TranslationCandidateDecisionFields({ canCheck, canRetry, onCheck, onRetry }: {
  canCheck: boolean; canRetry: boolean; onCheck: () => void; onRetry: () => void;
}) {
  const { t } = useTranslation(), candidates = useTranslationDraftSession().candidates;
  const state = candidates.state;
  return <>
    <label>{t("candidateDecisions.actor")}<input maxLength={128} value={state.actor} onChange={event => candidates.edit("actor", event.target.value)} /></label>
    <label>{t("candidateDecisions.reason")}<textarea maxLength={1024} value={state.reason} onChange={event => candidates.edit("reason", event.target.value)} /></label>
    {state.recorded ? <p role="status">{t(state.recorded === "rejected" ? "candidateDecisions.rejectedRecorded" : "candidateDecisions.restoredRecorded")}</p> : null}
    {state.failure ? <div role="alert"><p>{t("candidateDecisions.failed")}</p><CommandFailureDetails failure={state.failure} /></div> : null}
    {state.pending ? <div role="status"><p>{t(state.checking ? "candidateDecisions.checking" : "candidateDecisions.unknown", { locale: state.pending.decision.locale })}</p><p>{state.pending.decision.actor}: {state.pending.decision.reason}</p>
      <button className="secondary-button" disabled={!canCheck} onClick={onCheck}>{t("candidateDecisions.check")}</button>
      {state.checkedMissing ? <button className="secondary-button" disabled={!canRetry} onClick={onRetry}>{t("candidateDecisions.retry")}</button> : null}
    </div> : null}
  </>;
}
