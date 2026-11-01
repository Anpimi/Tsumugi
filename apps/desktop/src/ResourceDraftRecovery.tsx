import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Banner, LoadingState } from "./design-system/Feedback";
import { Button } from "./design-system/Button";
import { Field, TextArea } from "./design-system/Field";
import { CommandFailureDetails } from "./CommandFailure";
import { resourceDraftValue } from "./resourceDraftJournal";
import { jsonIdentity } from "./pluginToolChoices";
import type { ResourceDraftValue } from "./resourceDraftCommands";
import type { useResourceDraftSession, ResourceDraftState } from "./ResourceDraftSession";
import styles from "./app-v2/WorkbenchLayout.module.css";

/** Both workbenches borrow the same retained input and the same recovery actions. */
export function ResourceDraftRecovery({ owner, disabled = false }: { owner: ReturnType<typeof useResourceDraftSession>; disabled?: boolean }) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" });
  const journal = owner.journal, state = owner.state, panelId = useId();
  const [expanded, setExpanded] = useState(false), [copied, setCopied] = useState<boolean | null>(null);
  const [sourceText, setSourceText] = useState<string | null>(null), [sourceFailed, setSourceFailed] = useState(false), [sourceBusy, setSourceBusy] = useState(false);
  const [confirm, setConfirm] = useState<ResourceDraftState | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  function summary(value: ResourceDraftValue) {
    const field = (label: string, content: string) => t("recoveryField", { label, value: content });
    const scope = (value: ResourceDraftValue["typedDrafts"][number]["scope"]) => value.kind === "project" ? t("projectScope") : value.kind === "unit" ? t("entryScope") : value.logicalPaths.join("\n");
    const fields = [t("recoveryTerms"), field(t("sourceTerm"), value.termDraft.source), field(t("targetTerm"), value.termDraft.target), field(t("aliases"), value.aliasInput),
      field(t("protected"), t(value.termDraft.protected ? "yes" : "no")), field(t("scope"), t(value.termDraft.scopeUnitId ? "entryScope" : "projectScope")), field(t("reason"), value.termDraft.reason),
      ...(value.selectedUnit || value.contextDraft || value.contextReason ? [t("recoveryContext"), value.selectedUnit?.occurrence.key ?? "", value.contextDraft, field(t("reason"), value.contextReason)] : []),
      ...(value.proposalEditDraft ? [t("proposalEditTitle"), field(t("proposalSource"), value.proposalEditDraft.source),
        field(t("proposalCurrent"), value.proposalEditDraft.currentTarget ?? ""), field(t("proposalProposed"), value.proposalEditDraft.originalTarget),
        field(t("proposalEditedTarget"), value.proposalEditDraft.target)] : []),
      ...(value.correctionDraft ? [t("recoveryCorrection"), field(t("originalSource"), value.correctionDraft.evidence.sourceText), field(t("recoveryBefore"), value.correctionDraft.evidence.beforeText),
        field(t("recoveryAfter"), value.correctionDraft.evidence.afterText), field(t("sourceTerm"), value.correctionDraft.source), field(t("targetTerm"), value.correctionDraft.target),
        field(t("protected"), t(value.correctionDraft.protected ? "yes" : "no")), field(t("reason"), value.correctionDraft.reason)] : []),
      ...(value.factDraft ? [t("recoveryFact"), value.factDraft.key, t(`recoveryDisposition.${value.factDraft.disposition.kind}`), value.factDraft.disposition.kind === "replace" ? value.factDraft.disposition.text : "",
        field(t("contextActor"), value.factDraft.actor), field(t("reason"), value.factDraft.reason)] : []),
      ...value.typedDrafts.flatMap(draft => [t("recoveryResources"), t(`contextKinds.${draft.kind}`), draft.name, draft.text, field(t("contextActor"), draft.actor), field(t("reason"), draft.reason), field(t("scope"), scope(draft.scope))]),
      ...value.knowledgeDrafts.flatMap(draft => [t("recoveryReview"), draft.name, draft.text, field(t("contextActor"), draft.actor), field(t("reason"), draft.reason), ...(draft.scope ? [field(t("scope"), scope(draft.scope))] : [])])];
    return fields.filter(value => value !== "").join("\n\n");
  }
  const local = resourceDraftValue(state, "0"), stored = journal.conflict?.value;
  const differentAction = !!journal.conflict && (jsonIdentity(local.pending) !== jsonIdentity(stored?.pending ?? null)
    || jsonIdentity(local.factPending) !== jsonIdentity(stored?.factPending ?? null));
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(summary(local)); setCopied(true);
    } catch { setCopied(false); text.current?.focus(); text.current?.select(); }
  }
  async function readSource(context: boolean) {
    if (sourceBusy) return;
    setSourceBusy(true); setSourceFailed(false);
    const before = owner.current();
    try {
      const value = context ? await owner.readRetainedContext() : await owner.readRetainedSource();
      if (owner.current() !== before) return;
      if (!value) { setSourceFailed(true); return; }
      setSourceText("included" in value ? value.included.map(item => item.text).join("\n\n")
        : value.rows.flatMap(row => [row.entry.source, row.entry.target, row.entry.reason]).join("\n\n"));
    } catch { if (owner.current() === before) setSourceFailed(true); }
    finally { setSourceBusy(false); }
  }
  const pending = state.pending !== null || state.factPending !== null;
  if (journal.hydration === "idle" || journal.hydration === "loading") return <LoadingState label={t("recoveryLoading")}/>;
  return <section aria-label={t("recoveryTitle")}>
    {journal.hydration === "failed" || journal.failure ? <Banner tone="error" role="alert" action={<Button disabled={journal.busy || disabled}
      onClick={() => { void owner.retryJournal(); }}>{t(journal.hydration === "failed" ? "recoveryReadAgain" : "recoveryRetry")}</Button>}>
      {t(journal.hydration === "failed" ? "recoveryLoadFailed" : "recoveryWriteFailed")}<CommandFailureDetails failure={journal.failure}/></Banner> : null}
    {journal.busy ? <p role="status">{t("recoveryKeeping")}</p> : null}
    {journal.conflict ? <Banner tone="warning"><p>{t("recoveryConflict")}</p>{differentAction ? <p>{t("recoveryDifferentAction")}</p>
      : confirm ? <div className={styles.actions}><Button disabled={disabled || owner.current() !== confirm || journal.busy}
        onClick={() => { const expected = confirm; setConfirm(null); if (expected) void owner.keepLocal(expected); }}>{t("recoveryConfirmLocal")}</Button>
        <Button onClick={() => setConfirm(null)}>{t("recoveryCancelLocal")}</Button></div>
        : <Button disabled={disabled || journal.busy} onClick={() => { setExpanded(true); setConfirm(owner.current()); }}>{t("recoveryKeepLocal")}</Button>}</Banner> : null}
    {state.pickerUnknown ? <Banner tone="warning">{t("recoveryPicker")}</Banner> : null}
    {state.previewCaptureId || state.fixedContextId ? <div className={styles.actions}>
      {state.previewCaptureId ? <Button disabled={sourceBusy} onClick={() => { void readSource(false); }}>{t("recoveryReadSource")}</Button> : null}
      {state.fixedContextId ? <Button disabled={sourceBusy} onClick={() => { void readSource(true); }}>{t("recoveryReadContext")}</Button> : null}
      {sourceFailed ? <p role="alert">{t("recoverySourceFailed")}</p> : null}
      {sourceText !== null ? <Field label={t("originalSource")}><TextArea readOnly rows={6} value={sourceText}/></Field> : null}
    </div> : null}
    {pending ? <Banner tone="warning" action={<div className={styles.actions}><Button disabled={disabled || state.busyMutation || !!state.checkingAction}
      onClick={() => { if (owner.current().factPending) void owner.checkFact(); else void owner.checkPending(); }}>{t("recoveryCheck")}</Button>
      {state.pendingCheckedMissing || state.factCheckedMissing ? <Button disabled={disabled || state.busyMutation || !!state.checkingAction}
        onClick={() => { if (owner.current().factPending) void owner.retryFact(); else void owner.retryPending(); }}>{t("recoveryRetryAction")}</Button> : null}</div>}>{t("recoveryPending")}</Banner> : null}
    {journal.restored || journal.conflict || journal.failure ? <>
      <p>{t("recoveryHelp")}</p><Button aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(value => !value)}>{t(expanded ? "recoveryHide" : "recoveryShow")}</Button>
      <div id={panelId} hidden={!expanded}><Field label={t("recoveryLocal")}><TextArea ref={text} readOnly rows={8} value={summary(local)}/></Field>
        {stored ? <Field label={t("recoveryStored")}><TextArea readOnly rows={8} value={summary(stored)}/></Field> : null}
        <Button onClick={() => { void copy(); }}>{t("recoveryCopy")}</Button>{copied !== null ? <p role="status">{t(copied ? "recoveryCopied" : "recoveryCopyFailed")}</p> : null}
      </div>
    </> : null}
  </section>;
}
