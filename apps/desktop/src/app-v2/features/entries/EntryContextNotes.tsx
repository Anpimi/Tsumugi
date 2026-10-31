import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import { ContextResourceCapturePreview, ContextResourceOmissions } from "../../../ContextResourceCapturePreview";
import { ResourceDraftRecovery } from "../../../ResourceDraftRecovery";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { Button } from "../../../design-system/Button";
import { Disclosure } from "../../../design-system/Disclosure";
import { Field, TextArea } from "../../../design-system/Field";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands } from "../../../resourceCommands";
import { resourceReads } from "../../../resourceQueries";
import type { ReviewTarget } from "../../../reviewCommands";
import { sourceReads } from "../../../sourceQueries";
import type { InteractionGate } from "../../workspace/interactionGate";
import { candidateReadCurrent, candidateReadProof } from "../candidates/candidateReads";
import type { KnowledgeOwner } from "../knowledge/knowledgeTypes";
import styles from "./EntryContextNotes.module.css";

export interface EntryContextNotesProps {
  project: ProjectView;
  target: ReviewTarget;
  owner: KnowledgeOwner;
  gate: InteractionGate;
  viewId: string;
  disabled: boolean;
  visible: boolean;
  parentDialogId?: string;
  onOpenEntry?: (unitId: string, locale: string) => Promise<boolean>;
}

/** Notes, their CAS basis and original requests stay in the existing resource owner. */
export default function EntryContextNotes(props: EntryContextNotesProps) {
  const { project, target, owner, gate, viewId, disabled, visible, parentDialogId, onOpenEntry } = props;
  const { t } = useTranslation(), reads = useSessionReads(), session = executionContext(project);
  const inputOwner = useId(), state = owner.state;
  const interaction = useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const pending = state.pending?.kind === "context" || state.pending?.kind === "capture" ? state.pending : null;
  // A changed detail selection never rebinds unfinished input or an original request.
  const retained = state.selectedUnit && (owner.contextDirty() || pending) ? state.selectedUnit : null;
  const shown = retained ?? { unitId: target.unitId, sourceRevisionId: target.sourceRevisionId, occurrence: { key: target.nativeKey, text: target.sourceText } };
  const locale = retained ? state.locale : target.locale;
  const active = state.locale === locale && state.selectedUnit?.unitId === shown.unitId && state.selectedUnit.sourceRevisionId === shown.sourceRevisionId;
  const otherEntry = shown.unitId !== target.unitId || locale !== target.locale || shown.sourceRevisionId !== target.sourceRevisionId;
  const committed = useRef({ props, unitId: shown.unitId, sourceRevisionId: shown.sourceRevisionId, locale });
  const mounted = useRef(false), result = useRef<HTMLElement>(null);
  type Feedback = "saved" | "savedNewer" | "captureSaved" | "blocked";
  const scopeIdentity = JSON.stringify([shown.unitId, shown.sourceRevisionId, locale]);
  const [feedback, setFeedback] = useState<{ scope: string; kind: Feedback } | null>(null);
  const notice = feedback?.scope === scopeIdentity ? feedback.kind : null;
  function inform(kind: Feedback | null) { setFeedback(kind ? { scope: scopeIdentity, kind } : null); }
  useLayoutEffect(() => { committed.current = { props, unitId: shown.unitId, sourceRevisionId: shown.sourceRevisionId, locale }; });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; gate.releaseOwner(inputOwner); }; }, [gate, inputOwner]);
  useEffect(() => { if (!visible) gate.releaseOwner(inputOwner); }, [visible, gate, inputOwner]);
  function present() {
    const value = committed.current;
    return mounted.current && value.props.visible && !value.props.disabled && !reads.retired
      && value.props.project.sessionToken === session.sessionToken && value.props.project.metadata.projectId === session.projectId
      && value.unitId === shown.unitId && value.sourceRevisionId === shown.sourceRevisionId && value.locale === locale
      && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  }
  const enabled = visible && !disabled && !reads.retired;
  const scopeOptions = sourceReads.scope(session);
  const scope = useSessionQuery({ ...scopeOptions, enabled });
  const noteOptions = resourceReads.context(session, shown.unitId, locale, shown.sourceRevisionId);
  const note = useSessionQuery({ ...noteOptions, enabled });
  const termsKey = ["resource-resolution", shown.unitId, locale, shown.sourceRevisionId];
  const terms = useSessionQuery({ key: termsKey, scopes: ["source", "resources"], enabled,
    read: async () => {
      const value = await resourceCommands.resolve({ ...session, unitId: shown.unitId, locale });
      if (value.unitId !== shown.unitId || value.locale !== locale || value.sourceRevisionId !== shown.sourceRevisionId) throw new Error("Context source changed");
      return value;
    } });
  const captureId = state.fixedContextId;
  const capture = useSessionQuery({ key: ["entry-context-fixed-input", captureId], scopes: ["resources"], enabled: enabled && !!captureId && !state.fixedContext,
    read: async () => {
      const value = await owner.readRetainedContext();
      if (!value || value.captureId !== captureId) throw new Error("The saved context input is unavailable");
      return value;
    } });
  const fixed = state.fixedContext ?? capture.data;
  const fixedForEntry = fixed?.unitId === shown.unitId && fixed.locale === locale ? fixed : null;
  function fresh() {
    return present() && owner.localeAvailable(locale) && scope.data?.currentSnapshot != null
      && (otherEntry || scope.data.currentSnapshot === target.sourceSnapshotId)
      && candidateReadCurrent(reads, scopeOptions.key, scope.data) && candidateReadCurrent(reads, noteOptions.key, note.data)
      && candidateReadCurrent(reads, termsKey, terms.data);
  }
  const changed = active && note.data !== undefined && (note.data?.revisionId ?? null) !== (state.contextRevision?.revisionId ?? null);
  const busy = state.busyMutation || owner.inFlight();
  const journalReady = owner.journal.hydration === "ready" && !owner.journal.retired;
  // Composition blocks actions, never the text input that owns the composition.
  const editable = active && enabled && journalReady && owner.localeAvailable(locale) && interaction.visibleViewId === viewId
    && !interaction.intentOwner && (!interaction.dialogs.length || interaction.dialogs.at(-1) === parentDialogId);
  const canWrite = active && fresh() && !owner.blocked() && !changed;
  const readError = scope.error ?? note.error ?? terms.error;
  const loading = scope.isFetching || note.isFetching || terms.isFetching;
  async function refresh() {
    if (!present()) return;
    await Promise.all([scope.refetch(), note.refetch(), terms.refetch()]);
  }
  function begin() {
    if (!fresh() || note.data === undefined) return;
    const before = owner.current();
    inform(owner.receiveContext(shown, locale, note.data, before, fresh) ? null : "blocked");
  }
  function proof() {
    const witnesses = [candidateReadProof(reads, scopeOptions.key, scope.data), candidateReadProof(reads, noteOptions.key, note.data), candidateReadProof(reads, termsKey, terms.data)];
    const before = owner.current();
    return { current: () => fresh() && witnesses.every(value => value.current())
      && owner.current().locale === locale && owner.current().selectedUnit?.unitId === shown.unitId
      && owner.current().selectedUnit?.sourceRevisionId === shown.sourceRevisionId
      && (owner.current().contextRevision?.revisionId ?? null) === (before.contextRevision?.revisionId ?? null),
    dispose: () => witnesses.forEach(value => value.dispose()) };
  }
  async function submit(kind: "save" | "capture") {
    if (!canWrite || kind === "save" && !state.contextReason.trim()) return;
    const witness = proof(), origin = document.activeElement;
    inform(null);
    try {
      if (kind === "save") await owner.saveContext(witness.current); else await owner.captureContext(witness.current);
      const after = owner.current();
      if (present() && !after.pending && (after.notice === "saved" || after.notice === "savedNewer" || after.notice === "captureSaved")) {
        inform(after.notice);
        if (origin === document.activeElement || document.activeElement === document.body) result.current?.focus();
      }
    } finally { witness.dispose(); }
  }
  function adopt() {
    const before = owner.current();
    if (!fresh() || !active || owner.blocked() || note.data === undefined) return;
    owner.adoptContext(note.data, before.contextRevision?.revisionId ?? null, before.contextSeq);
    inform(null);
  }
  async function check(retry = false) {
    if (!present() || busy || !pending || owner.current().pending !== pending) return;
    if (retry) { if (owner.current().pendingCheckedMissing) await owner.retryPending(); }
    else await owner.checkPending();
    const after = owner.current();
    if (present() && !after.pending && (after.notice === "saved" || after.notice === "savedNewer" || after.notice === "captureSaved")) inform(after.notice);
  }
  const recovery = owner.journal.hydration !== "ready" || !!owner.journal.failure || !!owner.journal.conflict;
  return <section className={styles.notes} aria-label={t("resource.manualContext")} onFocusCapture={() => gate.setInputOwner(viewId, inputOwner)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.setInputOwner(viewId, null); }}
    onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
    <header><h3>{t("resource.manualContext")}</h3><p>{t("contextFacts.scope", { key: shown.occurrence.key, locale })}</p></header>
    <p>{t("resource.contextEditorHelp")}</p>
    {recovery ? <ResourceDraftRecovery owner={owner} disabled={!present()}/> : null}
    {otherEntry ? <Banner tone="warning"><p>{t("resource.contextEditorBlocked")}</p>
      {onOpenEntry ? <Button disabled={!present()} onClick={() => { if (present()) void onOpenEntry(shown.unitId, locale); }}>{t("resource.returnToEditor", { key: shown.occurrence.key, locale })}</Button> : null}</Banner> : null}
    {!owner.localeAvailable(locale) && journalReady ? <Banner tone="warning">{t("resource.removedTarget", { locale })}</Banner> : null}
    {loading ? <LoadingState label={t("resource.loading")}/> : null}
    {readError ? <Banner tone="error" role="alert" action={<Button disabled={!present() || loading} onClick={() => { void refresh(); }}>{t("resource.retryRead")}</Button>}>
      <p>{t("resource.editorLoadFailed")}</p><CommandFailureDetails failure={commandFailure(readError)}/></Banner> : null}
    {notice === "blocked" ? <Banner tone="warning">{t("resource.contextEditorBlocked")}</Banner> : null}
    {!active ? <><h4>{t("resource.currentContext")}</h4><pre className={styles.text}>{note.data?.text ?? t("resource.noCurrentContext")}</pre>
      <Button disabled={!fresh() || !owner.canReceiveContext(locale)} onClick={begin}>{t("resource.editFromEntry")}</Button></> : <>
      <Field label={t("resource.manualContext")}><TextArea rows={5} value={state.contextDraft} readOnly={!editable} onChange={event => { if (editable) owner.editContext(event.target.value); }}/></Field>
      <Field label={t("resource.reason")} required><TextArea rows={2} value={state.contextReason} readOnly={!editable} onChange={event => { if (editable) owner.editContextReason(event.target.value); }}/></Field>
      {changed ? <Banner tone="warning"><p>{t("resource.contextChanged")}</p><h4>{t("resource.currentContext")}</h4>
        <pre className={styles.text}>{note.data?.text ?? t("resource.noCurrentContext")}</pre>{note.data?.reason ? <p className={styles.text}>{note.data.reason}</p> : null}
        <Button disabled={!fresh() || owner.blocked()} onClick={adopt}>{t("resource.adoptCurrentContext")}</Button></Banner> : null}
      <div className={styles.actions}><Button variant="primary" pending={busy && pending?.kind === "context"} disabled={!canWrite || !state.contextReason.trim()} onClick={() => { void submit("save"); }}>{t("resource.saveContext")}</Button>
        <Button disabled={!present() || owner.blocked() || !owner.contextDirty()} onClick={() => { if (present()) { owner.discardContext(); inform(null); } }}>{t("resource.discardDraft")}</Button>
        <Button pending={busy && pending?.kind === "capture"} disabled={!canWrite} onClick={() => { void submit("capture"); }}>{t("resource.fixInput")}</Button>
        <Button disabled={!present() || loading} onClick={() => { void refresh(); }}>{t("resource.refresh")}</Button></div>
      <p>{t("workbenchV2.entryContextLockHelp")}</p>
    </>}
    {pending && !recovery ? <Banner tone="warning" role="status" action={<div className={styles.actions}>
      <Button disabled={!present() || busy} onClick={() => { void check(); }}>{t("knowledge.recoveryCheck")}</Button>
      {state.pendingCheckedMissing ? <Button disabled={!present() || busy} onClick={() => { void check(true); }}>{t("resource.retry")}</Button> : null}</div>}>{t(busy ? "workbenchV2.entryContextWorking" : "resource.uncertainAction")}</Banner> : null}
    {active && state.failure ? <Banner tone="error" role="alert"><p>{t("resource.actionFailed")}</p><CommandFailureDetails failure={state.failure}/></Banner> : null}
    <section ref={result} tabIndex={-1} aria-live="polite" aria-label={t("resource.currentContext")}>
      {notice && notice !== "blocked" ? <p role="status">{t(`resource.${notice === "saved" && owner.contextDirty() ? "savedNewer" : notice}`)}</p> : null}
    </section>
    {fixedForEntry ? <Disclosure title={t("resource.fixedInput")}><p>{t("resource.captureSaved")}</p>
      <ul className={styles.material}>{fixedForEntry.included.map(item => <li key={`${item.kind}:${item.revisionId}`}><h4>{item.kind === "source" ? t("workbenchV2.source", { locale: project.metadata.sourceLocale }) : t(item.kind === "manual" ? "resource.manualContext" : "resource.applicableTerms")}</h4>
        <pre className={styles.text}>{item.text}</pre><Disclosure title={t("resource.provenance")}><p className={styles.text}>{item.provenance}</p><code>{item.revisionId}</code></Disclosure></li>)}</ul>
      <ContextResourceCapturePreview capture={fixedForEntry.contextResources}/>
      {fixedForEntry.omitted.length ? <><h4>{t("resource.omitted")}</h4><ContextResourceOmissions items={fixedForEntry.omitted}/></> : null}
    </Disclosure> : null}
    {captureId && !state.fixedContext && capture.error ? <Banner tone="error" role="alert" action={<Button disabled={!present() || capture.isFetching} onClick={() => { if (present()) void capture.refetch(); }}>{t("resource.retryRead")}</Button>}>
      <p>{t("knowledge.recoverySourceFailed")}</p><CommandFailureDetails failure={commandFailure(capture.error)}/></Banner> : null}
  </section>;
}
