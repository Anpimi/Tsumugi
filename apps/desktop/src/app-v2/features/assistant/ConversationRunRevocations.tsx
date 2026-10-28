import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails } from "../../../CommandFailure";
import { Button } from "../../../design-system/Button";
import type { ConversationInput, ConversationSession } from "./ConversationSession";
import type { ConversationPlanLink } from "./conversationRun";
import styles from "./ConversationRunPanel.module.css";

export function ConversationRunRevocations({ owner, input, link, canRead, onFinished, recovery }: {
  owner: ConversationSession; input: ConversationInput; link: Pick<ConversationPlanLink, "planId" | "conversationId">; canRead: () => boolean; onFinished: (origin: HTMLElement) => void;
  recovery?: { actionId: string; targetRef: Ref<HTMLElement> };
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const slots = (input.value.revocations ?? []).filter(slot => slot.request.planId === link.planId && (!recovery || slot.request.actionId === recovery.actionId));
  const full = !recovery && (input.value.revocations?.length ?? 0) >= 32;
  if (!slots.length && !full) return null;
  const blocked = () => !canRead() || input.journalBusy || input.failure?.kind === "journal";
  return <section className={styles.material} aria-label={t("runRevocationsTitle")}>
    <h5>{t("runRevocationsTitle")}</h5>
    {full ? <p>{t("runRevocationsLimit")}</p> : null}
    {slots.map(slot => {
      const state = input.revocationStates.get(slot.request.actionId), busy = !!state?.busy;
      const title = { pause: "runRevocationPause", stop: "runRevocationStop", "take-over": "runRevocationTakeOver" } as const;
      return <section key={slot.request.actionId} ref={recovery?.targetRef} tabIndex={recovery ? -1 : undefined}
        className={`${styles.material}${recovery ? ` ${styles.recovery}` : ""}`} data-conversation-recovery={recovery ? "revocation" : undefined} aria-label={t(title[slot.request.command])}>
        <h6>{t(title[slot.request.command])}</h6>
        {recovery ? <p>{t("recoveryHelp")}</p> : null}
        <p role="status">{t(busy ? "runRevocationBusy" : state?.outcome === "absent" ? "runRevocationAbsent"
          : state?.outcome === "blocked" ? "runRevocationBlocked" : "runRevocationUnknown")}</p>
        <CommandFailureDetails failure={state?.failure ?? null}/>
        <div className={styles.actions}>
          <Button size="sm" disabled={blocked() || busy} onClick={async event => {
            if (blocked()) return;
            const origin = event.currentTarget;
            try { await owner.checkRevocation(link.conversationId, slot.request.actionId); } finally { onFinished(origin); }
          }}>{t("runRevocationCheck")}</Button>
          {state?.outcome === "absent" ? <Button size="sm" disabled={blocked() || busy} onClick={async event => {
            if (blocked()) return;
            const origin = event.currentTarget;
            try { await owner.retryRevocation(link.conversationId, slot.request.actionId, () => canRead()); } finally { onFinished(origin); }
          }}>{t("runRevocationRetry")}</Button> : null}
        </div>
      </section>;
    })}
  </section>;
}
