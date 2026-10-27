import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { sameDraftBasis, type DraftBasis, type DraftKey, type DraftValue } from "../../../draftCommands";
import { readExactPaste } from "../../../exactPaste";
import { textareaDisplayText } from "../../../reviewDiagnosticNavigation";
import { Button } from "../../../design-system/Button";
import { Banner, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { Field, TextArea } from "../../../design-system/Field";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { InteractionGate, InteractionIntent } from "../../workspace/interactionGate";
import type { TranslationDrafts } from "./translationDrafts";
import styles from "../../WorkbenchLayout.module.css";

export type EditorCommand = "translation.confirm" | "translation.confirm-next" | "translation.exit-editor";
export interface SegmentEditorHandle { focus: () => void }
export interface SegmentEditorProps {
  drafts: TranslationDrafts;
  draftKey: DraftKey;
  viewId: string | null;
  gate: InteractionGate;
  disabled: boolean;
  nativeKey?: string;
  autoFocus?: boolean;
  allowAdvance?: boolean;
  dispatch: (id: EditorCommand, source: "button" | "keyboard", inputOwner?: string) => boolean;
  ref?: Ref<SegmentEditorHandle>;
}
type PasteFeedback = "editorPasteReading" | "editorPasteCancelled" | "editorPasteUnavailable" | "editorPasteFailed" | "editorPasteChanged" | "editorPasteComposition" | "editorPasteBusy" | "editorPasteUnconfirmed";
interface PasteFlight {
  field: HTMLTextAreaElement;
  key: DraftKey;
  value: DraftValue;
  currentBasis: DraftBasis;
  text: string;
  start: number;
  end: number;
  direction: HTMLTextAreaElement["selectionDirection"];
  intent: InteractionIntent;
  valid: boolean;
  applying: boolean;
}

/** Views borrow the session's entity draft; mounting an editor never owns its lifetime. */
export default function SegmentEditor({ drafts, draftKey, viewId, gate, disabled, nativeKey, autoFocus = true, allowAdvance = true, dispatch, ref }: SegmentEditorProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const snapshot = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  const interaction = useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const entry = drafts.getEntry(draftKey), value = entry?.value;
  const identity = JSON.stringify([draftKey.projectId, draftKey.unitId, draftKey.locale]);
  const ownerId = `segment-editor-${useId()}`;
  const field = useRef<HTMLTextAreaElement>(null), composing = useRef(false), mounted = useRef(false), copySequence = useRef(0);
  const firstLoaded = useRef({ drafts, keys: new Set<string>() });
  const pasteFlight = useRef<PasteFlight | null>(null);
  const [pasteFeedback, setPasteFeedback] = useState<PasteFeedback | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [read, setRead] = useState({ identity, failed: false });
  const [restore, setRestore] = useState<{ identity: string; sequence: string; basis: DraftBasis } | null>(null);
  const [copied, setCopied] = useState<{ identity: string; text: string; result: "copied" | "failed" } | null>(null);

  useEffect(() => {
    let current = true;
    setRead({ identity, failed: false });
    if (!snapshot.retired) void drafts.open({ projectId: draftKey.projectId, unitId: draftKey.unitId, locale: draftKey.locale }).then(result => {
      if (current) setRead({ identity, failed: result === undefined });
    });
    return () => { current = false; };
  }, [drafts, draftKey.projectId, draftKey.unitId, draftKey.locale, identity, readAttempt, snapshot.retired]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => () => {
    copySequence.current++; composing.current = false; gate.releaseOwner(ownerId);
    const flight = pasteFlight.current; pasteFlight.current = null; flight?.intent.release();
  }, [drafts, gate, ownerId, viewId, identity]);
  useImperativeHandle(ref, () => ({ focus: () => field.current?.focus() }), []);
  useLayoutEffect(() => {
    if (firstLoaded.current.drafts !== drafts) firstLoaded.current = { drafts, keys: new Set() };
    if (!entry || firstLoaded.current.keys.has(identity)) return;
    firstLoaded.current.keys.add(identity);
    if (autoFocus && !disabled && !snapshot.retired && gate.getSnapshot().visibleViewId === viewId) field.current?.focus();
  }, [drafts, entry !== undefined, identity, autoFocus, disabled, snapshot.retired, gate, viewId]);
  useLayoutEffect(() => {
    const flight = pasteFlight.current;
    if (flight && !flight.applying && !pasteCurrent(flight)) cancelPaste("editorPasteChanged");
  }, [snapshot.revision, disabled, identity]);

  const readonly = disabled || snapshot.retired;
  const retryRead = () => setReadAttempt(attempt => attempt + 1);
  const exit = <Button size="sm" disabled={disabled} onClick={() => dispatch("translation.exit-editor", "button", ownerId)}>{t("editorExit")}</Button>;
  if (!entry) return <>
    {read.identity === identity && read.failed || snapshot.retired
      ? <ErrorState title={t("editorReadFailed")} description={t(snapshot.retired ? "editorSessionRetired" : "editorReadFailedHelp")} action={!snapshot.retired ? <Button onClick={retryRead}>{t("editorRetryRead")}</Button> : undefined} />
      : <LoadingState label={t("editorLoading")} />}
    <div className={styles.editActions}>{exit}</div>
  </>;

  const pending = value?.pending !== null && value?.pending !== undefined;
  const journalFailed = entry.failure?.kind === "journal";
  const journalConflict = entry.failure?.kind === "journal-conflict";
  const mergeChanged = !!value?.merge && entry.failure?.kind === "basis-conflict";
  const basisChanged = !!value && entry.current.kind === "current" && !entry.basisCurrent;
  const blocked = readonly || snapshot.hydration !== "ready" || snapshot.mutationReserved || interaction.intentOwner !== null;
  const canConfirm = !mergeChanged && !blocked && !!value && entry.basisCurrent && !pending && !entry.busy && entry.currentFailure === null && !journalFailed && !journalConflict;
  const canRestore = !blocked && !!value && !pending && !entry.busy && !journalConflict && entry.current.kind === "current" && entry.currentFailure === null;
  const showRestore = canRestore && (!!value?.merge || value?.text !== (value?.basis.text ?? "") || basisChanged);
  const restoring = restore?.identity === identity && restore.sequence === value?.editSeq
    && entry.current.kind === "current" && sameDraftBasis(restore.basis, entry.current.basis);
  const copyResult = copied?.identity === identity && copied.text === value?.text ? copied.result : null;
  const localStatus = value && !journalFailed && !journalConflict
    ? entry.journalPending ? "editorPreserving"
      : entry.durableSeq === value.editSeq ? "editorPreserved"
        : value.text !== (value.basis.text ?? "") ? "editorNotPreserved" : null
    : null;
  const status = entry.checking ? "editorChecking" : entry.busy ? "editorConfirming" : pending ? "editorPending" : entry.newerInputAfterConfirmation ? "editorNewerInput"
    : localStatus ?? (value && entry.basisCurrent && entry.currentFailure === null && !journalFailed && !journalConflict && !snapshot.retired ? "editorReady" : null);

  function finishPaste(flight: PasteFlight, feedback: PasteFeedback | null) {
    if (pasteFlight.current !== flight) return;
    pasteFlight.current = null; flight.intent.release();
    if (mounted.current) setPasteFeedback(feedback);
  }
  function cancelPaste(feedback: PasteFeedback = "editorPasteCancelled") {
    const flight = pasteFlight.current;
    if (flight) finishPaste(flight, feedback);
  }
  function pasteCurrent(flight: PasteFlight) {
    const current = drafts.getEntry(flight.key), control = flight.field;
    return pasteFlight.current === flight && flight.valid && mounted.current && !drafts.getSnapshot().retired
      && !disabled && flight.intent.current() && control === field.current && control.isConnected && !control.readOnly
      && document.activeElement === control && !composing.current && current?.currentFailure === null
      && current.current.kind === "current" && sameDraftBasis(current.current.basis, flight.currentBasis)
      && current.value?.editSeq === flight.value.editSeq && current.value.text === flight.value.text
      && sameDraftBasis(current.value.basis, flight.value.basis) && control.value === flight.text
      && control.selectionStart === flight.start && control.selectionEnd === flight.end && control.selectionDirection === flight.direction;
  }
  function pasteOriginalText(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!navigator.platform.startsWith("Mac")) return;
    event.preventDefault(); cancelPaste();
    if (composing.current) { setPasteFeedback("editorPasteComposition"); return; }
    const control = event.currentTarget, current = drafts.getEntry(draftKey);
    if (readonly || control.readOnly || !current?.value || current.current.kind !== "current" || current.currentFailure !== null) {
      setPasteFeedback("editorPasteUnavailable"); return;
    }
    // This owns navigation only; a formal confirmation may still be awaiting A.
    const intent = gate.acquireIntent(`${ownerId}-paste`);
    if (!intent) { setPasteFeedback("editorPasteBusy"); return; }
    const flight: PasteFlight = { field: control, key: { ...draftKey }, value: current.value, currentBasis: current.current.basis,
      text: control.value, start: control.selectionStart, end: control.selectionEnd, direction: control.selectionDirection,
      intent, valid: true, applying: false };
    pasteFlight.current = flight; setPasteFeedback("editorPasteReading");
    try {
      const reading = readExactPaste(event.clipboardData);
      if (!reading) { finishPaste(flight, "editorPasteUnavailable"); return; }
      void reading.then(({ text, matches }) => {
        if (pasteFlight.current !== flight) return;
        if (!pasteCurrent(flight) || !matches) { finishPaste(flight, "editorPasteChanged"); return; }
        if (text === "") { finishPaste(flight, null); return; }
        const expected = flight.text.slice(0, flight.start) + textareaDisplayText(text) + flight.text.slice(flight.end);
        let inserted = false;
        flight.applying = true;
        try { inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text); }
        catch { /* Keep actual input and native undo; do not replace the textarea value. */ }
        finally { flight.applying = false; }
        finishPaste(flight, inserted && control.value === expected ? null : "editorPasteUnconfirmed");
      }, () => finishPaste(flight, "editorPasteFailed"));
    } catch { finishPaste(flight, "editorPasteFailed"); }
  }

  async function copyDraft() {
    if (!value) return;
    const text = value.text, ticket = ++copySequence.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (mounted.current && copySequence.current === ticket) setCopied({ identity, text, result: "copied" });
    } catch {
      if (!mounted.current || copySequence.current !== ticket) return;
      setCopied({ identity, text, result: "failed" });
      if (drafts.getEntry(draftKey)?.value?.text === text && !composing.current) { field.current?.focus(); field.current?.select(); }
    }
  }

  const editor = value ? <TextArea ref={field} editor rows={3} aria-label={t("editorLabel", { key: nativeKey ?? (entry.current.kind === "current" ? entry.current.nativeKey : draftKey.unitId) })}
    aria-describedby={`${ownerId}-hint${status ? ` ${ownerId}-status` : ""}`} value={value.text} readOnly={readonly}
    onPaste={pasteOriginalText}
    onChange={event => {
      const flight = pasteFlight.current;
      if (!flight?.applying) {
        if (flight) cancelPaste("editorPasteChanged");
        else setPasteFeedback(null);
      }
      if (!readonly) drafts.edit(draftKey, event.currentTarget.value);
    }}
    onFocus={() => gate.setInputOwner(viewId, ownerId)} onBlur={() => {
      const flight = pasteFlight.current;
      if (flight && !flight.applying) { flight.valid = false; flight.intent.release(); }
      composing.current = false; gate.releaseOwner(ownerId);
    }}
    onCompositionStart={() => { cancelPaste("editorPasteChanged"); composing.current = true; gate.setInputOwner(viewId, ownerId); gate.setComposing(ownerId, true); }}
    onCompositionEnd={() => { composing.current = false; gate.setComposing(ownerId, false); }}
    onSelect={event => {
      const flight = pasteFlight.current, control = event.currentTarget;
      if (flight && !flight.applying && (control.selectionStart !== flight.start || control.selectionEnd !== flight.end || control.selectionDirection !== flight.direction)) cancelPaste("editorPasteChanged");
    }}
    onKeyDown={event => { if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) event.stopPropagation(); }} /> : null;

  return <>
    {snapshot.retired ? <Banner tone="warning">{t("editorSessionRetired")}</Banner> : null}
    {entry.current.kind === "unavailable" ? <Banner tone="warning">{t(entry.current.reason === "source-missing" ? "editorSourceMissing" : "editorLocaleRemoved")}</Banner> : null}
    {entry.currentFailure !== null ? <Banner tone="error" role="alert" action={<Button size="sm" disabled={readonly || entry.busy} onClick={retryRead}>{t("editorRetryRead")}</Button>}>{t("editorReadFailedHelp")}</Banner> : null}
    {value?.merge ? <Banner tone={mergeChanged ? "warning" : "info"} action={<Button size="sm" disabled={blocked || pending || entry.busy || journalConflict} onClick={() => { void drafts.refreshMerge(draftKey); }}>{t("editorMergeRefresh")}</Button>}>{t(mergeChanged ? "editorMergeChanged" : "editorMergeDraft")}</Banner> : null}
    {basisChanged ? <>
      <Banner tone="warning" action={<Button size="sm" disabled={blocked || pending || entry.busy || journalConflict || entry.currentFailure !== null} onClick={() => { void drafts.rebase(draftKey); }}>{t(value?.merge ? "editorMergeRefresh" : "editorRebase")}</Button>}>{t("editorBasisChanged")}</Banner>
      <div role="group" aria-label={t("editorCurrentSelection")}><p className={styles.editHint}>{t("editorCurrentSelection")}</p><div>{entry.current.kind === "current" && entry.current.basis.text !== null
        ? entry.current.basis.text === "" ? t("editorEmptySelection") : <TokenizedText text={entry.current.basis.text} />
        : t("editorNoSelection")}</div></div>
    </> : null}
    {basisChanged ? <Field label={t("editorDraftLabel")}>{editor}</Field> : editor}
    {status ? <p className={styles.editHint} id={`${ownerId}-status`} role="status">{t(status)}</p> : null}
    {pending ? <Banner tone="warning" action={<div className={styles.actions}>
      <Button size="sm" disabled={readonly || entry.busy} onClick={() => { void drafts.recover(draftKey); }}>{t("editorCheckResult")}</Button>
      {entry.replayAllowed ? <Button size="sm" disabled={blocked || entry.busy || journalConflict || journalFailed} onClick={() => { void drafts.replay(draftKey); }}>{t("editorReplay")}</Button> : null}
    </div>}>{t(entry.recovery === "mismatch" ? "editorMismatch" : entry.failure?.kind === "recovery" ? "editorRecoveryFailed" : "editorPendingHelp")}</Banner> : null}
    {journalFailed ? <Banner tone="error" role="alert" action={<Button size="sm" disabled={readonly || entry.busy} onClick={() => { void drafts.flush(draftKey); }}>{t("editorRetryPreserve")}</Button>}>{t("editorJournalFailed")}</Banner> : null}
    {journalConflict ? <Banner tone="error" role="alert" action={<Button size="sm" disabled={readonly || entry.busy} onClick={retryRead}>{t("editorRetryRead")}</Button>}>{t("editorJournalConflict")}</Banner> : null}
    {!pending && entry.failure?.kind === "confirmation" ? <Banner tone="error" role="alert">{t("editorConfirmationFailed")}</Banner> : null}
    {copyResult ? <p className={styles.editHint} role="status">{t(copyResult === "copied" ? "editorCopied" : "editorCopyFailed")}</p> : null}
    {pasteFeedback ? <Banner tone={pasteFeedback === "editorPasteFailed" ? "error" : pasteFeedback === "editorPasteReading" || pasteFeedback === "editorPasteCancelled" ? "info" : "warning"} role="status"
      action={pasteFlight.current ? <Button size="sm" onClick={() => { cancelPaste(); field.current?.focus(); }}>{t("editorPasteCancel")}</Button> : undefined}>{t(pasteFeedback)}</Banner> : null}
    {restoring && canRestore ? <Banner tone="warning" role="alert">
      <p>{t("editorRestoreQuestion")}</p><p>{t("editorRestoreHelp")}</p>
      <div className={styles.actions}><Button size="sm" onClick={() => setRestore(null)}>{t("editorKeepDraft")}</Button><Button size="sm" variant="danger" onClick={() => { setRestore(null); void drafts.discard(draftKey); }}>{t("editorRestoreNow")}</Button></div>
    </Banner> : null}
    <div className={styles.actions}>
      {value ? <Button size="sm" onClick={() => { void copyDraft(); }}>{t("editorCopy")}</Button> : null}
      {showRestore ? <Button size="sm" onClick={() => { if (value && entry.current.kind === "current") setRestore({ identity, sequence: value.editSeq, basis: entry.current.basis }); }}>{t("editorRestore")}</Button> : null}
      {exit}
      <Button size="sm" disabled={!canConfirm} onClick={() => dispatch("translation.confirm", "button", ownerId)}>{t("editorConfirm")}</Button>
      {allowAdvance ? <Button size="sm" variant="primary" disabled={!canConfirm} pending={entry.busy && !entry.checking} onClick={() => dispatch("translation.confirm-next", "button", ownerId)}>{t("confirmNext")}</Button> : null}
    </div>
    <p className={styles.editHint} id={`${ownerId}-hint`}>{t(allowAdvance ? "editorHint" : "editorRecoveryHint", { modifier: navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl" })}</p>
  </>;
}
