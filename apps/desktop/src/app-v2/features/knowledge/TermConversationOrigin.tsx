import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { conversationCommands } from "../../../conversationCommands";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import type { GlossaryCapture } from "../../../resourceCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { Button } from "../../../design-system/Button";
import { Disclosure } from "../../../design-system/Disclosure";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import styles from "./TermProposalPanel.module.css";

export function TermConversationOrigin({ origin, active = true }: {
  origin: Extract<GlossaryCapture["origin"], { kind: "conversation" }>; active?: boolean;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" }), reads = useSessionReads();
  const [open, setOpen] = useState(false), id = useId();
  const { proposal, modelOrigin } = origin;
  const original = useSessionQuery({ key: ["term-conversation-origin", proposal.conversationId, proposal.proposalId, proposal.revisionId, modelOrigin.attemptId],
    scopes: ["project", "execution"], enabled: active && open && !reads.retired,
    read: async () => {
      const run = await conversationCommands.readPlanning({ ...reads.context, conversationId: proposal.conversationId, attemptId: modelOrigin.attemptId });
      if (!run || run.preview.projectId !== proposal.projectId || run.resultId !== modelOrigin.resultId || run.receipt.inputDigest !== modelOrigin.inputDigest
        || run.preview.purpose !== "terminology" || run.output?.model.kind !== "term-proposal") throw new Error("Original term proposal result is unavailable");
      return run;
    } });
  return <section aria-label={t("proposalConversation")}>
    <h4>{t("proposalConversation")}</h4><Disclosure title={t("details")}><dl className={styles.comparison}>
      <div><dt>{t("proposalOriginConversation")}</dt><dd>{proposal.conversationId}</dd></div>
      <div><dt>{t("proposalOriginProposal")}</dt><dd>{proposal.proposalId}</dd></div>
      <div><dt>{t("proposalOriginRevision")}</dt><dd>{proposal.revisionId}</dd></div>
      <div><dt>{t("proposalOriginAttempt")}</dt><dd>{modelOrigin.attemptId}</dd></div>
      <div><dt>{t("proposalOriginResult")}</dt><dd>{modelOrigin.resultId}</dd></div>
      <div><dt>{t("proposalOriginInputDigest")}</dt><dd>{modelOrigin.inputDigest}</dd></div>
      <div><dt>{t("proposalOriginResultDigest")}</dt><dd>{modelOrigin.resultDigest}</dd></div>
    </dl></Disclosure>
    <Button size="sm" disabled={!active || reads.retired} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{t("proposalOriginalResult")}</Button>
    {open ? <div id={id}>{original.isPending ? <LoadingState label={t("readingSource")}/> : original.isError ? <Banner tone="error">
      <p>{t("originFailed")}</p><CommandFailureDetails failure={commandFailure(original.error)}/>
      <Button size="sm" disabled={!active || original.isFetching} onClick={() => void original.refetch()}>{t("refresh")}</Button>
    </Banner> : <><pre className={styles.text}>{original.data.preview.input}</pre><pre className={styles.text}>{JSON.stringify(original.data.output?.model, null, 2)}</pre></>}</div> : null}
  </section>;
}
