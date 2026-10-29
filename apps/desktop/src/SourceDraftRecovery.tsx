import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./design-system/Button";
import { Field, TextArea } from "./design-system/Field";
import { Banner, LoadingState } from "./design-system/Feedback";
import { CommandFailureDetails } from "./CommandFailure";
import { jsonIdentity } from "./pluginToolChoices";
import type { SourceDraftValue } from "./sourceDraftCommands";
import type { useSourceDraftSession } from "./SourceDraftSession";
import styles from "./app-v2/features/source/SourceMaintenance.module.css";

export default function SourceDraftRecovery({ owner, disabled = false }: { owner: ReturnType<typeof useSourceDraftSession>; disabled?: boolean }) {
  const { t } = useTranslation(undefined, { keyPrefix: "sourceMaintenance" });
  const journal = owner.journal, state = owner.state, local = owner.draftValue(), stored = journal.conflict?.value;
  const [expanded, setExpanded] = useState(false), [confirmation, setConfirmation] = useState<SourceDraftValue | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null), id = useId(), text = useRef<HTMLTextAreaElement>(null);
  const differentRequest = !!journal.conflict && (jsonIdentity(local.pending) !== jsonIdentity(stored?.pending ?? null)
    || jsonIdentity(local.hookStop) !== jsonIdentity(stored?.hookStop ?? null));
  function summary(value: SourceDraftValue) {
    return [value.selectionLabel, value.sourceLanguage, value.actor, value.filter, value.historicalQuery,
      ...value.lineage.flatMap(choice => [t("entry", { number: choice.newOrdinal + 1 }),
        t(choice.decision === "continue" ? "recoveryContinue" : "recoveryReject"), choice.reason]),
      value.hook.locale ? t("recoveryHookLocale", { locale: value.hook.locale }) : null].filter(value => value !== null && value !== "").join("\n\n");
  }
  async function copy() {
    try { await navigator.clipboard.writeText(summary(local)); setCopied(true); }
    catch { setCopied(false); if (text.current && (document.activeElement === document.body || text.current.contains(document.activeElement))) { text.current.focus(); text.current.select(); } }
  }
  if (journal.hydration === "idle" || journal.hydration === "loading") return <LoadingState label={t("recoveryLoading")}/>;
  return <section className={styles.body} aria-label={t("recoveryTitle")}>
    {journal.hydration === "failed" || journal.failure ? <Banner tone="error" role="alert" action={<Button disabled={disabled || journal.busy}
      onClick={() => { void owner.retryJournal(); }}>{t("recoveryRetry")}</Button>}>
      {t(journal.hydration === "failed" ? "recoveryReadFailed" : "recoveryWriteFailed")}<CommandFailureDetails failure={journal.failure}/>
    </Banner> : null}
    {journal.busy ? <p role="status">{t("recoveryKeeping")}</p> : null}
    {journal.conflict ? <Banner tone="warning"><p>{t("recoveryConflict")}</p>{differentRequest ? <p>{t("recoveryDifferentAction")}</p>
      : confirmation ? <div className={styles.actions}><Button disabled={disabled || journal.busy || jsonIdentity(local) !== jsonIdentity(confirmation)}
        onClick={() => { const expected = confirmation; setConfirmation(null); if (expected) void owner.keepLocal(expected); }}>{t("recoveryConfirmLocal")}</Button>
        <Button onClick={() => setConfirmation(null)}>{t("recoveryCancel")}</Button></div>
        : <Button disabled={disabled || journal.busy} onClick={() => { setExpanded(true); setConfirmation(local); }}>{t("recoveryKeepLocal")}</Button>}</Banner> : null}
    {state.preparationExpired ? <Banner tone="warning">{t("recoveryPreparation")}</Banner> : null}
    {!owner.hasPending() && (state.captureRequest || state.checkPrepareRequest) ? <div className={styles.actions}>
      {state.captureRequest ? <Button disabled={disabled || owner.inFlight()} onClick={() => { void owner.readPreparation("capture"); }}>{t("readPreparation")}</Button> : null}
      {state.checkPrepareRequest ? <Button disabled={disabled || owner.inFlight()} onClick={() => { void owner.readPreparation("prepare-check"); }}>{t("readCheckPreparation")}</Button> : null}
    </div> : null}
    {state.pickerUncertain ? <Banner tone="warning">{t("recoveryPicker")}</Banner> : null}
    {owner.hasPending() ? <Banner tone="warning" action={<div className={styles.actions}>
      <Button disabled={disabled || owner.inFlight() || journal.busy || journal.hydration !== "ready"} onClick={() => { void owner.checkPending(); }}>{t("recoveryCheck")}</Button>
      {state.pendingStart || state.pendingPlugin?.pendingKind === "start-check" ? <div><p>{t("cancelStartHelp")}</p>
        <Button disabled={disabled || owner.inFlight() || journal.busy || journal.hydration !== "ready"} onClick={() => { void owner.cancelPendingStart(); }}>{t("cancelStart")}</Button></div> : null}
      {state.pendingApply && state.receiptChecked && state.pendingObserved?.kind === "adoption-prepared" ? <Button disabled={disabled || owner.inFlight() || journal.busy}
        onClick={() => { void owner.retryApply(); }}>{t("recoveryRetryAction")}</Button> : null}
      {state.pendingPlugin?.pendingKind === "finish-check" && owner.canRetryPlugin() ? <Button disabled={disabled || owner.inFlight() || journal.busy}
        onClick={() => { void owner.retryPlugin(); }}>{t("recoveryFinishCheck")}</Button> : null}
    </div>}>{t(state.pendingObserved && state.pendingObserved.kind !== "pending" ? "recoveryRecordFound" : "recoveryPending")}</Banner> : null}
    {journal.restored || journal.conflict || journal.failure ? <>
      <Button aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{t(expanded ? "recoveryHide" : "recoveryShow")}</Button>
      <div id={id} hidden={!expanded} className={styles.body}><Field label={t("recoveryLocal")}><TextArea ref={text} readOnly rows={7} value={summary(local)}/></Field>
        {stored ? <Field label={t("recoveryStored")}><TextArea readOnly rows={7} value={summary(stored)}/></Field> : null}
        <div className={styles.actions}><Button onClick={() => { void copy(); }}>{t("recoveryCopy")}</Button>{copied !== null ? <p role="status">{t(copied ? "recoveryCopied" : "recoveryCopyFailed")}</p> : null}</div>
      </div>
    </> : null}
  </section>;
}
