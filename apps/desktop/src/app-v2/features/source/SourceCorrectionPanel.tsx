import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { useSessionQuery } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import { translationCommands } from "../../../translationCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import type { ProjectView } from "../../../projectCommands";
import type { SourceSession } from "../../../SourceDraftSession";
import type { ContentRow, SourceOccurrence, SourceLineageCorrectionReceipt, SourceLineageSavedWork } from "../../../sourceCommands";
import styles from "./SourceMaintenance.module.css";

function SubmittedCorrection({ request }: { request: SourceLineageCorrectionReceipt["request"] }) {
  const { t } = useTranslation(undefined, { keyPrefix: "sourceMaintenance" });
  const candidate = request.basis.candidates.find(evidence => evidence.old.occurrenceId === request.oldOccurrenceId)?.old.occurrence;
  const entry = candidate ? candidate.nativeIdentity?.display.value || candidate.key || t("entry", { number: candidate.ordinal + 1 }) : t("savedHistorical");
  const decision = t(request.decision === "continue" ? "recoveryContinue" : request.decision === "reject" ? "recoveryReject" : "unresolved");
  return <details><summary>{t("correctionSubmitted")}</summary>
    <p>{t("correctionSubmittedCandidate", { entry })}</p><p>{t("correctionSubmittedDecision", { decision })}</p>
    <p>{t("correctionSubmittedActor", { actor: request.actor })}</p><p>{t("correctionSubmittedReason", { reason: request.reason })}</p>
  </details>;
}

function SavedCorrectionWork({ project, snapshotId, work, label, visible, current }: {
  project: ProjectView; snapshotId: string; work: SourceLineageSavedWork; label: string;
  visible: boolean; current: () => boolean;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "sourceMaintenance" });
  const [expanded, setExpanded] = useState(false), [after, setAfter] = useState("0");
  const context = executionContext(project);
  const history = useSessionQuery({ key: ["source-correction-translations", snapshotId, work.unitId, work.locale, after], scopes: ["source", "translation"], enabled: visible && expanded,
    read: () => translationCommands.history({ ...context, unitId: work.unitId, locale: work.locale, afterOrdinal: after, limit: 20 }) });
  const page = history.data?.unitId === work.unitId && history.data.locale === work.locale && !history.error ? history.data : null;
  return <details onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{label}</summary>
    <div className={styles.body}>
      <p>{t(work.selectionId ? "correctionOriginalSelection" : "correctionNoOriginalSelection")}</p>
      {history.isFetching ? <LoadingState label={t("readingTranslations")}/> : null}
      {history.error || history.isSuccess && !page ? <Banner tone="warning" action={<Button disabled={!current() || history.isFetching} onClick={() => void history.refetch()}>{t("retryRead")}</Button>}>{t("translationsFailed")}</Banner> : null}
      {page ? <>
        <section aria-label={t("correctionSelectedTranslation")}><h3>{t("correctionSelectedTranslation")}</h3>
          {page.currentText !== null ? <p><TokenizedText text={page.currentText}/></p> : <p>{t("correctionNoSelectedTranslation")}</p>}
        </section>
        <section aria-label={t("savedTranslations")}><h3>{t("savedTranslations")}</h3>
          {page.rows.length ? <ul>{page.rows.map(revision => <li key={revision.revisionId}><p><TokenizedText text={revision.text}/></p></li>)}</ul> : <p>{t("noSavedTranslations")}</p>}
          <div className={styles.actions}>
            <Button disabled={!current() || after === "0" || history.isFetching} onClick={() => setAfter("0")}>{t("firstPage")}</Button>
            <Button disabled={!current() || !page.nextOrdinal || history.isFetching} onClick={() => { if (page.nextOrdinal) setAfter(page.nextOrdinal); }}>{t("nextPage")}</Button>
          </div>
        </section>
      </> : null}
    </div>
  </details>;
}

/** Source owns the draft and original request; this panel owns only presentation. */
export default function SourceCorrectionPanel({ project, owner, snapshotId, row, visible, current, disabled = false, onRevealCorrection }: {
  project: ProjectView; owner: SourceSession; snapshotId: string; row: ContentRow; visible: boolean;
  current: () => boolean; disabled?: boolean; onRevealCorrection?: (snapshotId: string, ordinal: number) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "sourceMaintenance" }), { t: old } = useTranslation();
  const [opened, setOpened] = useState<{ snapshotId: string; ordinal: number } | null>(null);
  const [review, setReview] = useState<{ basis: SourceSession["state"]["correctionBasis"]; draft: SourceSession["state"]["correctionDraft"] } | null>(null);
  const [discardFrame, setDiscardFrame] = useState<NonNullable<SourceSession["state"]["correctionDraft"]> | null>(null), [discarding, setDiscarding] = useState(false);
  const state = owner.state, draft = state.correctionDraft;
  const sameTarget = draft?.snapshotId === snapshotId && draft.ordinal === row.occurrence.ordinal;
  const expanded = opened?.snapshotId === snapshotId && opened.ordinal === row.occurrence.ordinal;
  const basis = state.correctionBasis?.snapshotId === snapshotId && state.correctionBasis.ordinal === row.occurrence.ordinal ? state.correctionBasis : null;
  const receipt = state.correctionReceipt?.request.basis.snapshotId === snapshotId && state.correctionReceipt.request.basis.ordinal === row.occurrence.ordinal ? state.correctionReceipt : null;
  const comparison = basis ?? receipt?.request.basis ?? null;
  const reviewed = review !== null && review.basis === basis && review.draft === draft;
  const pending = state.pendingCorrection !== null, busy = owner.inFlight();
  const readOnly = disabled || owner.journal.hydration !== "ready" || owner.journal.retired;
  const actionBlocked = readOnly || !current();
  const discardUnchanged = discardFrame !== null && jsonIdentity(discardFrame) === jsonIdentity(draft);
  const actorHasControl = !!draft && Array.from(draft.actor).some(character => { const code = character.charCodeAt(0); return code <= 31 || code >= 127 && code <= 159; });
  const actorError = draft && draft.actor !== "" && (draft.actor.trim() !== draft.actor || new TextEncoder().encode(draft.actor).byteLength > 128 || actorHasControl) ? t("correctionActorInvalid") : undefined;
  const reasonError = draft && new TextEncoder().encode(draft.reason).byteLength > 4096 ? t("reasonTooLong") : draft?.reason.includes("\0") ? t("correctionReasonInvalid") : undefined;
  const stale = typeof state.correctionFailure === "object" && state.correctionFailure?.code === "dependency-conflict";
  const label = (occurrence: SourceOccurrence) => occurrence.nativeIdentity?.display.value || occurrence.key || t("entry", { number: occurrence.ordinal + 1 });
  const candidates = Array.from(new Map((comparison?.candidates ?? []).flatMap(evidence => evidence.old.occurrenceId ? [[evidence.old.occurrenceId, evidence.old] as const] : [])).values());
  const availableCandidate = candidates.some(candidate => candidate.occurrenceId === draft?.oldOccurrenceId);
  const recorded = receipt?.request;
  const needsRefresh = !!basis && !!receipt && basis.mappingRevision === receipt.request.basis.mappingRevision;
  const newer = !!recorded && sameTarget && !!draft && (draft.oldOccurrenceId !== recorded.oldOccurrenceId || draft.decision !== recorded.decision
    || draft.actor !== recorded.actor || draft.reason !== recorded.reason);
  // A rematch must not hide work on the entry that was current before it.
  const work = Array.from(new Map([...(receipt?.preservedWork ?? []), ...(basis?.savedWork ?? [])].map(saved => [`${saved.unitId}:${saved.locale}`, saved] as const)).values());
  const originalUnits = new Set((receipt?.previousBindings ?? comparison?.bindings ?? []).map(binding => binding.unitId));
  if (!comparison && row.unitId) originalUnits.add(row.unitId);
  function edit(patch: Parameters<SourceSession["editCorrection"]>[0]) {
    if (readOnly || !sameTarget) return;
    setReview(null); owner.editCorrection(patch);
  }
  function open() {
    if (readOnly || !current() || state.correctionLoading) return;
    setOpened({ snapshotId, ordinal: row.occurrence.ordinal }); setReview(null); setDiscardFrame(null);
    void owner.openCorrection(snapshotId, row.occurrence.ordinal);
  }
  async function discard() {
    const expected = discardFrame, latest = owner.current();
    if (!expected || readOnly || !current() || discarding || owner.inFlight() || latest.pendingCorrection
      || owner.journal.busy || owner.journal.failure || owner.journal.conflict || jsonIdentity(expected) !== jsonIdentity(latest.correctionDraft)) return;
    setDiscarding(true);
    try {
      if (await owner.discardCorrection(expected)) {
        setDiscardFrame(before => before === expected ? null : before);
        setOpened(before => before?.snapshotId === expected.snapshotId && before.ordinal === expected.ordinal ? null : before);
      }
    } finally { setDiscarding(false); }
  }
  if (!visible) return null;
  return <section className={styles.body} aria-label={t("correctionTitle")}>
    {!expanded ? <Button disabled={actionBlocked || state.correctionLoading} onClick={open}>{t(sameTarget ? "correctionResume" : "correctionOpen")}</Button> : <>
      <h2>{t("correctionTitle")}</h2><p>{t("correctionHelp")}</p>
      <section aria-label={t("correctionCurrentSource")}><h3>{t("correctionCurrentSource")}</h3><strong>{label(row.occurrence)}</strong>
        <p><TokenizedText text={row.occurrence.text}/></p>{row.occurrence.text === "" ? <p className={styles.meta}>{t("emptyText")}</p> : null}
      </section>
      {draft && !sameTarget ? <Banner tone="warning" action={onRevealCorrection ? <Button disabled={actionBlocked} onClick={() => { if (current()) onRevealCorrection(draft.snapshotId, draft.ordinal); }}>{t("correctionReveal")}</Button> : undefined}>{t("correctionTargetBlocked")}</Banner> : null}
      {state.correctionLoading ? <LoadingState label={t("correctionLoading")}/> : null}
      {state.correctionFailure ? <Banner tone={stale ? "warning" : "error"}>{t(stale ? "correctionStale" : "correctionFailure")}</Banner> : null}
      {state.pendingCorrection ? <Banner tone="warning" role="status" action={<div className={styles.actions}>
        <Button disabled={actionBlocked || busy || state.correctionLoading} onClick={() => { if (current()) void owner.checkCorrection(); }}>{t("correctionCheck")}</Button>
        {owner.canRetryCorrection() ? <Button disabled={actionBlocked || busy || state.correctionLoading} onClick={() => { if (current() && owner.canRetryCorrection()) void owner.retryCorrection(); }}>{t("correctionRetry")}</Button> : null}
        <Button disabled={actionBlocked || busy || state.correctionLoading || owner.journal.busy || !!owner.journal.failure || !!owner.journal.conflict} onClick={() => {
          if (current() && !owner.inFlight() && !owner.journal.busy && !owner.journal.failure && !owner.journal.conflict) void owner.cancelCorrection();
        }}>{t("correctionCancel")}</Button>
      </div>}>
        <p>{t("correctionPending")}</p><SubmittedCorrection request={state.pendingCorrection.correction}/>
        {owner.canRetryCorrection() ? <p>{t("correctionRetryHelp")}</p> : null}
        <p>{t("correctionCancelHelp")}</p>
      </Banner> : null}
      {receipt ? <Banner tone="success" role="status"><p>{t(newer ? "correctionNewerEdits" : "correctionRecorded")}</p><SubmittedCorrection request={receipt.request}/></Banner> : null}
      {sameTarget && draft ? <>
        <Button disabled={actionBlocked || busy || pending || discarding || state.correctionLoading} onClick={() => { if (!current()) return; setReview(null); void owner.refreshCorrection(); }}>{t("correctionRefresh")}</Button>
        {comparison ? <>
          {comparison.originChain.length > 1 ? <p className={styles.meta}>{t("correctionInherited")}</p> : null}
          {comparison.bindings.length > 1 ? <Banner>{t("correctionGroup", { count: comparison.bindings.length })}</Banner> : null}
          <section aria-label={t("correctionCandidates")}><h3>{t("correctionCandidates")}</h3>
            {comparison.candidates.length ? <ul>{comparison.candidates.map(evidence => <li key={`${evidence.oldSnapshotId}:${evidence.old.occurrence.ordinal}:${evidence.actionId}`}>
              <strong>{label(evidence.old.occurrence)}</strong><p><TokenizedText text={evidence.old.occurrence.text}/></p>
              <p>{t("correctionRecordedDecision", { decision: evidence.decision === "unresolved" ? t("unresolved") : old(evidence.decision === "continue" ? "source.evidenceDecision.continue" : evidence.decision === "reject" ? "source.evidenceDecision.reject" : "source.evidenceDecision.candidate") })}</p>
              {evidence.actor ? <p>{t("correctionRecordedActor", { actor: evidence.actor })}</p> : null}
              {evidence.reason ? <p>{t("correctionRecordedReason", { reason: evidence.reason })}</p> : null}
            </li>)}</ul> : <p>{t("correctionEmpty")}</p>}
          </section>
          <Field label={t("correctionCandidate")} required><select disabled={readOnly} value={draft.oldOccurrenceId ?? ""} onChange={event => edit({ oldOccurrenceId: event.target.value || null })}>
            <option value="">{t("correctionChooseCandidate")}</option>
            {candidates.map(candidate => <option key={candidate.occurrenceId} value={candidate.occurrenceId ?? ""}>{label(candidate.occurrence)}</option>)}
            {draft.oldOccurrenceId && !availableCandidate ? <option value={draft.oldOccurrenceId}>{t("savedHistorical")}</option> : null}
          </select></Field>
          {draft.oldOccurrenceId && !availableCandidate ? <Banner tone="warning">{t("correctionUnavailableCandidate")}</Banner> : null}
          <Field label={t("correctionDecision")}><select disabled={readOnly} value={draft.decision} onChange={event => {
            const decision = event.target.value;
            if (decision === "continue" || decision === "reject" || decision === "unresolved") edit({ decision });
          }}><option value="continue">{t("recoveryContinue")}</option><option value="reject">{t("recoveryReject")}</option><option value="unresolved">{t("unresolved")}</option></select></Field>
          <Field label={t("actor")} required error={actorError}><TextInput readOnly={readOnly} value={draft.actor} onChange={event => edit({ actor: event.target.value })}/></Field>
          <Field label={t("correctionReason")} required error={reasonError}><TextArea rows={3} readOnly={readOnly} value={draft.reason} onChange={event => edit({ reason: event.target.value })}/></Field>
          <section className={styles.body} aria-label={t("correctionSavedWork")}><h3>{t("correctionSavedWork")}</h3><p>{t("correctionWorkHelp")}</p>
            {work.length ? work.map((saved, index) => {
              const candidate = candidates.find(candidate => candidate.unitId === saved.unitId);
              const workLabel = originalUnits.has(saved.unitId) ? t("correctionCurrentWork", { locale: saved.locale })
                : candidate ? t("correctionCandidateWork", { entry: label(candidate.occurrence), locale: saved.locale })
                  : t("correctionOtherWork", { number: index + 1, locale: saved.locale });
              return <SavedCorrectionWork key={`${saved.unitId}:${saved.locale}`} project={project} snapshotId={snapshotId} work={saved} label={workLabel} visible={visible && expanded} current={current}/>;
            }) : <p>{t("correctionNoWork")}</p>}
          </section>
          <ul><li>{t("correctionEffectFiles")}</li><li>{t("correctionEffectWork")}</li><li>{t("correctionEffectSelection")}</li></ul>
          <Field label={t("correctionConfirm")}><input type="checkbox" checked={reviewed} disabled={actionBlocked || pending || busy || discarding || !basis || stale || needsRefresh} onChange={event => { if (!readOnly && current()) setReview(event.target.checked ? { basis, draft } : null); }}/></Field>
          <Button variant="primary" pending={busy && pending} disabled={actionBlocked || busy || discarding || owner.hasPending() || pending || owner.journal.busy || !!owner.journal.failure || !!owner.journal.conflict || state.correctionLoading || stale || !basis || !availableCandidate
            || needsRefresh || !!actorError || !!reasonError || !draft.actor.trim() || !draft.reason.trim() || !reviewed} onClick={() => { if (current()) { setReview(null); setDiscardFrame(null); void owner.applyCorrection(); } }}>{t("correctionApply")}</Button>
        </> : !state.correctionLoading && !state.correctionFailure ? <p>{t("correctionEmpty")}</p> : null}
        {!pending ? discardFrame ? <section className={styles.body} aria-label={t("correctionDiscardTitle")}>
          <h3>{t("correctionDiscardTitle")}</h3><p>{t("correctionDiscardHelp")}</p>
          <dl><dt>{t("actor")}</dt><dd>{discardFrame.actor}</dd>
            <dt>{t("correctionReason")}</dt><dd><TokenizedText text={discardFrame.reason}/></dd>
          </dl>
          {!discardUnchanged ? <Banner tone="warning">{t("correctionDiscardChanged")}</Banner> : null}
          <div className={styles.actions}>
            <Button disabled={actionBlocked || discarding} onClick={() => { if (current()) setDiscardFrame(null); }}>{t("correctionKeepEditing")}</Button>
            <Button variant="danger" pending={discarding} disabled={actionBlocked || busy || !discardUnchanged || owner.journal.busy || !!owner.journal.failure || !!owner.journal.conflict} onClick={() => void discard()}>{t("correctionDiscardConfirm")}</Button>
          </div>
        </section> : <Button disabled={actionBlocked || busy || owner.journal.busy || !!owner.journal.failure || !!owner.journal.conflict} onClick={() => {
          if (!readOnly && current() && !owner.inFlight() && !owner.current().pendingCorrection) setDiscardFrame(structuredClone(draft));
        }}>{t("correctionDiscard")}</Button> : null}
      </> : null}
      <p className={styles.meta}>{t("correctionCloseHelp")}</p>
      <Button disabled={actionBlocked || discarding} onClick={() => { if (current()) void owner.closeCorrection().then(closed => {
        if (closed) { setDiscardFrame(null); setOpened(before => before?.snapshotId === snapshotId && before.ordinal === row.occurrence.ordinal ? null : before); }
      }); }}>{t("correctionClose")}</Button>
    </>}
  </section>;
}
