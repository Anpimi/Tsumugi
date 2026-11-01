import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { matchQuery } from "@tanstack/react-query";
import { executionContext } from "../../../executionCommands";
import { sameDraftBasis, type DraftBasis } from "../../../draftCommands";
import type { ProjectView } from "../../../projectCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { protectionKey, type ProtectionBasis } from "../../../WorkProtectionSession";
import { workPlanCommands, type WorkProtection } from "../../../workPlanCommands";
import type { WorkbenchCommands, TranslationProtectionCommandPayload, TranslationProtectionPendingCommandPayload, CommandAvailability } from "../../../workbenchCommands";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { DraftEntry, TranslationDrafts } from "../editor/translationDrafts";
import type { CandidateOwners } from "./candidateTypes";
import { candidateReadCurrent, candidateReadProof } from "./candidateReads";
import styles from "./EntryProtection.module.css";

export interface EntryProtectionProps {
  project: ProjectView; target: ReviewTarget; drafts: TranslationDrafts; owners: CandidateOwners;
  commands: WorkbenchCommands; gate: InteractionGate; viewId: string | null; disabled: boolean; visible: boolean;
  parentDialogId?: string;
}
interface InputCapture { editSeq: string; basis: DraftBasis; text: string }
interface ReleaseCapture {
  scope: string; identity: string; basis: ProtectionBasis; input: InputCapture;
  read: ReturnType<typeof candidateReadProof>;
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
function cleanInput(entry: DraftEntry | undefined): InputCapture | null {
  if (!entry?.value || entry.current.kind !== "current" || entry.currentFailure !== null || !entry.basisCurrent
    || entry.value.pending || entry.value.merge != null || entry.busy || entry.checking || entry.journalPending || entry.failure !== null
    || !sameDraftBasis(entry.value.basis, entry.current.basis) || entry.value.text !== (entry.current.basis.text ?? "")) return null;
  return { editSeq: entry.value.editSeq, basis: { ...entry.value.basis }, text: entry.value.text };
}
function sameInput(expected: InputCapture, entry: DraftEntry | undefined): boolean {
  const current = cleanInput(entry);
  return !!current && current.editSeq === expected.editSeq && current.text === expected.text && sameDraftBasis(current.basis, expected.basis);
}
function targetMatches(entry: DraftEntry | undefined, target: ReviewTarget): boolean {
  return entry?.current.kind === "current" && entry.currentFailure === null && entry.current.sourceText === target.sourceText
    && entry.current.basis.sourceRevisionId === target.sourceRevisionId && entry.current.basis.selectionId === target.selectionId
    && entry.current.basis.revisionId === target.revisionId && entry.current.basis.text === target.translationText;
}
function sameProtectionBasis(left: ProtectionBasis, right: ProtectionBasis): boolean {
  return left.key === right.key && left.sourceText === right.sourceText && left.selectionText === right.selectionText
    && left.request.projectId === right.request.projectId && left.request.sessionToken === right.request.sessionToken
    && left.request.unitId === right.request.unitId && left.request.locale === right.request.locale
    && left.request.sourceRevisionId === right.request.sourceRevisionId && (left.request.selectionId ?? null) === (right.request.selectionId ?? null)
    && left.request.expectedRevision === right.request.expectedRevision;
}

/** Views borrow the project's protection owner. Opening this control never changes protection or text. */
export default function EntryProtection({ project, target, drafts, owners, commands, gate, viewId, disabled, visible, parentDialogId }: EntryProtectionProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const reads = useSessionReads(), session = owners.protection, state = session.state;
  const snapshot = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const context = executionContext(project), commandScope = { ...context, area: "translation" as const };
  const key = { projectId: context.projectId, unitId: target.unitId, locale: target.locale };
  const readKey = protectionKey(target.unitId, target.locale, target.sourceRevisionId, target.selectionId);
  const query = useSessionQuery({ key: readKey, scopes: ["source", "translation"], enabled: visible && !reads.retired,
    read: () => workPlanCommands.protection({ ...context, unitId: target.unitId, locale: target.locale }) });
  const protectionRecord = useMemo(() => {
    const cache = reads.client.getQueryCache();
    const filters = { queryKey: reads.key(protectionKey(target.unitId, target.locale, target.sourceRevisionId, target.selectionId)), exact: true };
    return {
      subscribe: (notify: () => void) => cache.subscribe(event => { if (matchQuery(filters, event.query)) notify(); }),
      snapshot: () => reads.client.getQueryState<WorkProtection>(filters.queryKey),
    };
  }, [reads, target.unitId, target.locale, target.sourceRevisionId, target.selectionId]);
  // Query observers batch notifications. A changed record must revoke the
  // visible confirmation immediately, even before the observer supplies new data.
  useSyncExternalStore(protectionRecord.subscribe, protectionRecord.snapshot, protectionRecord.snapshot);
  const scope = JSON.stringify([context.projectId, context.sessionToken, target.unitId, target.locale, viewId]);
  const identity = JSON.stringify([scope, target.sourceSnapshotId, target.sourceRevisionId, target.selectionId, target.revisionId, target.translationText]);
  const dialogId = `entry-protection-release-${useId()}`, compositionOwner = `entry-protection-input-${useId()}`;
  const section = useRef<HTMLElement>(null), releaseButton = useRef<HTMLButtonElement>(null), cancelButton = useRef<HTMLButtonElement>(null);
  const [release, setRelease] = useState<ReleaseCapture | null>(null), releaseRef = useRef<ReleaseCapture | null>(null);
  const [working, setWorking] = useState(false), flight = useRef(false), mounted = useRef(true);
  const [feedback, setFeedback] = useState<{ scope: string; key: "entryProtectionSaved" | "entryProtectionReleased" | "entryProtectionChanged" | "entryProtectionFailed" | "entryProtectionReconciled" | "entryProtectionCheckPending" | "entryProtectionCheckMismatch" } | null>(null);
  const [opening, setOpening] = useState<{ identity: string; failed: boolean; pending: boolean }>({ identity, failed: false, pending: true });
  const live = useRef({ visible, disabled, scope, identity, viewId, parentDialogId });
  const returnFocus = useRef<{ scope: string; trigger: HTMLButtonElement | null } | null>(null), dialogRelease = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { live.current = { visible, disabled, scope, identity, viewId, parentDialogId }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; releaseRef.current?.read.dispose(); releaseRef.current = null; }; }, []);
  const modalOpen = visible && release !== null && release.scope === scope;
  useLayoutEffect(() => {
    if (!modalOpen) return;
    if (!dialogRelease.current) dialogRelease.current = gate.pushDialog(dialogId);
    return () => { dialogRelease.current?.(); dialogRelease.current = null; };
  }, [gate, dialogId, modalOpen]);
  useLayoutEffect(() => () => gate.releaseOwner(compositionOwner), [gate, compositionOwner]);
  useLayoutEffect(() => {
    if (releaseRef.current && (!visible || releaseRef.current.scope !== scope)) {
      releaseRef.current.read.dispose(); releaseRef.current = null; setRelease(null);
    }
  }, [visible, scope]);
  useEffect(() => {
    if (!visible || snapshot.retired || snapshot.hydration !== "ready") return;
    let current = true;
    setOpening({ identity, failed: false, pending: true });
    void drafts.open(key).then(value => { if (current) setOpening({ identity, failed: !value, pending: false }); });
    return () => { current = false; };
  }, [drafts, key.projectId, key.unitId, key.locale, identity, visible, snapshot.retired, snapshot.hydration]);

  const present = () => visible && !disabled && mounted.current && !reads.retired && !drafts.getSnapshot().retired
    && gate.getSnapshot().visibleViewId === viewId && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
    && project.metadata.targetLocales.includes(target.locale);
  const stillPresent = () => present() && live.current.visible && !live.current.disabled && live.current.scope === scope
    && live.current.identity === identity && live.current.viewId === viewId && live.current.parentDialogId === parentDialogId;
  const interactionAllowed = (inside = false) => gate.canDispatch({ viewId, source: "button", dialogId: inside ? dialogId : parentDialogId });
  const entry = drafts.getEntry(key), input = cleanInput(entry);
  const ready = query.data !== undefined && candidateReadCurrent(reads, readKey, query.data) && targetMatches(entry, target)
    && opening.identity === identity && !opening.pending && !opening.failed;
  function capture(): ProtectionBasis | null {
    if (!ready || !query.data || !candidateReadCurrent(reads, readKey, query.data) || !targetMatches(drafts.getEntry(key), target)) return null;
    return { key: target.nativeKey, sourceText: target.sourceText, selectionText: target.translationText, request: { ...context, unitId: target.unitId,
      locale: target.locale, sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, expectedRevision: query.data.revision } };
  }
  const canChange = () => present() && interactionAllowed() && !working && !flight.current && !session.blocked()
    && !owners.decisions.blocked() && snapshot.hydration === "ready" && !snapshot.mutationReserved;
  const canOpenRelease = () => canChange() && ready && query.data?.protected === true && cleanInput(drafts.getEntry(key)) !== null;
  function releaseCurrent(captured = release): boolean {
    const basis = capture();
    return !!captured && captured === releaseRef.current && captured.scope === scope && captured.identity === identity && !!basis
      && captured.read.current() && sameProtectionBasis(captured.basis, basis) && sameInput(captured.input, drafts.getEntry(key));
  }
  function changeAvailability(payload: TranslationProtectionCommandPayload | undefined): CommandAvailability {
    const inside = payload?.protected === false;
    if (!present() || !interactionAllowed(inside) || working || flight.current || session.blocked() || owners.decisions.blocked()
      || snapshot.hydration !== "ready" || snapshot.mutationReserved) return unavailable;
    const basis = capture();
    return !!payload && !!basis && sameProtectionBasis(payload.basis, basis)
      && (payload.protected ? query.data?.protected === false : query.data?.protected === true && releaseCurrent()) ? { enabled: true } : unavailable;
  }
  function closeRelease() {
    const current = releaseRef.current; releaseRef.current = null; current?.read.dispose();
    dialogRelease.current?.(); dialogRelease.current = null; setRelease(null);
  }
  function openRelease() {
    if (!canOpenRelease()) return;
    const basis = capture(), value = cleanInput(drafts.getEntry(key)); if (!basis || !value) return;
    const captured: ReleaseCapture = { scope, identity, basis, input: value, read: candidateReadProof(reads, readKey, query.data) };
    releaseRef.current?.read.dispose(); releaseRef.current = captured;
    returnFocus.current = { scope, trigger: releaseButton.current };
    if (!dialogRelease.current) dialogRelease.current = gate.pushDialog(dialogId);
    setRelease(captured);
  }
  async function change(payload: TranslationProtectionCommandPayload) {
    const captured = payload.protected ? null : releaseRef.current;
    const read = candidateReadProof(reads, readKey, query.data);
    const proof = () => stillPresent() && interactionAllowed(!payload.protected) && read.current() && targetMatches(drafts.getEntry(key), target)
      && (payload.protected || !!captured && releaseRef.current === captured && captured.read.current() && sameInput(captured.input, drafts.getEntry(key)));
    flight.current = true; setWorking(true); setFeedback(null);
    try {
      await drafts.open(key);
      if (!proof()) { if (stillPresent()) setFeedback({ scope, key: "entryProtectionChanged" }); return; }
      const receipt = await session.change(payload.basis, payload.protected, proof);
      if (receipt && stillPresent()) {
        setFeedback({ scope, key: payload.protected ? "entryProtectionSaved" : "entryProtectionReleased" });
        await query.refetch();
      } else if (!receipt && stillPresent()) setFeedback({ scope, key: "entryProtectionChanged" });
      if (captured && releaseRef.current === captured) closeRelease();
    } catch {
      if (stillPresent()) { setFeedback({ scope, key: "entryProtectionFailed" }); await query.refetch(); }
      if (captured && releaseRef.current === captured && session.current().pending) closeRelease();
    } finally { read.dispose(); flight.current = false; if (mounted.current) setWorking(false); }
  }
  const pending = state.pending;
  const pendingPayload: TranslationProtectionPendingCommandPayload | null = pending ? { kind: "translation-protection-pending", request: pending.request, key: pending.key } : null;
  function pendingAvailability(payload: TranslationProtectionPendingCommandPayload | undefined): CommandAvailability {
    const original = session.current().pending;
    return present() && interactionAllowed() && !working && !flight.current && !state.busy && !!payload && original?.phase === "unknown"
      && payload.request === original.request && payload.key === original.key
      ? { enabled: true } : unavailable;
  }
  async function retry(payload: TranslationProtectionPendingCommandPayload) {
    const original = session.current().pending; if (!original || original.request !== payload.request) return;
    // This request may already be recorded. Replaying its exact identity must
    // remain possible while newer local input is retained under its reservation.
    const proof = () => stillPresent() && interactionAllowed() && session.current().pending?.request === original.request;
    flight.current = true; setWorking(true);
    try {
      await session.retry(proof);
      if (stillPresent() && !session.current().pending) { setFeedback({ scope, key: "entryProtectionReconciled" }); await query.refetch(); }
    } catch { if (stillPresent()) setFeedback({ scope, key: "entryProtectionFailed" }); }
    finally { flight.current = false; if (mounted.current) setWorking(false); }
  }
  async function check(payload: TranslationProtectionPendingCommandPayload) {
    const original = session.current().pending; if (!original || original.request !== payload.request) return;
    const proof = () => stillPresent() && interactionAllowed() && session.current().pending?.request === original.request;
    flight.current = true; setWorking(true); setFeedback(null);
    try {
      const recovery = await session.check(proof);
      if (recovery && stillPresent()) {
        setFeedback({ scope, key: recovery.outcome.kind === "recorded" ? "entryProtectionReconciled"
          : recovery.outcome.kind === "mismatch" ? "entryProtectionCheckMismatch" : "entryProtectionCheckPending" });
        if (recovery.outcome.kind === "recorded") await query.refetch();
      }
    } catch { if (stillPresent()) setFeedback({ scope, key: "entryProtectionFailed" }); }
    finally { flight.current = false; if (mounted.current) setWorking(false); }
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const metadata = { category: "translation" as const, scope: commandScope, binding: null, risk: "writes-translation" as const };
    const remove = [
      commands.register({ ...metadata, id: "translation.protect-work", nameKey: "protection.protect", payloadKind: "translation-protection", confirmation: "none", availability: changeAvailability, handler: payload => { void change(payload); } }),
      commands.register({ ...metadata, id: "translation.release-work", nameKey: "protection.confirmRelease", payloadKind: "translation-protection", confirmation: "required", availability: changeAvailability, handler: payload => { void change(payload); } }),
      commands.register({ ...metadata, id: "translation.retry-protection", nameKey: "protection.retry", payloadKind: "translation-protection-pending", confirmation: "none", availability: pendingAvailability, handler: payload => { void retry(payload); } }),
      commands.register({ ...metadata, id: "translation.check-protection", nameKey: "workbenchV2.entryProtectionCheck", risk: "reads-execution", payloadKind: "translation-protection-pending", confirmation: "none", availability: pendingAvailability, handler: payload => { void check(payload); } }),
    ];
    return () => remove.forEach(dispose => dispose());
  });
  async function refresh() {
    const inside = modalOpen;
    if (!present() || !interactionAllowed(inside) || working || state.busy || query.isFetching) return;
    setOpening({ identity, failed: false, pending: true });
    const [, current] = await Promise.all([query.refetch(), drafts.open(key)]);
    if (stillPresent()) setOpening({ identity, failed: !current, pending: false });
  }
  const basis = capture(), protectPayload: TranslationProtectionCommandPayload | null = basis ? { kind: "translation-protection", basis, protected: true } : null;
  const releasePayload: TranslationProtectionCommandPayload | null = release ? { kind: "translation-protection", basis: release.basis, protected: false } : null;
  const message = feedback?.scope === scope ? feedback : null;
  const modalAllowed = present() && interactionAllowed(true);
  const renderText = (text: string | null) => text === null ? t("editorNoSelection") : text === "" ? t("editorEmptySelection") : <TokenizedText text={text}/>;
  const refreshButton = <Button size="sm" disabled={!present() || !interactionAllowed(modalOpen) || working || state.busy || query.isFetching} onClick={() => { void refresh(); }}>{t("entryProtectionRefresh")}</Button>;
  if (!visible) return null;
  return <section ref={section} tabIndex={-1} className={styles.section} aria-label={t("entryProtectionTitle")}
    onCompositionStartCapture={() => gate.setComposing(compositionOwner, true)} onCompositionEndCapture={() => gate.setComposing(compositionOwner, false)}>
    <header className={styles.header}><h3>{t("entryProtectionTitle")}</h3>{refreshButton}</header>
    {query.isPending || query.isFetching || opening.identity === identity && opening.pending ? <LoadingState label={t("entryProtectionLoading")} />
      : query.isError || opening.failed || !targetMatches(entry, target) ? <Banner tone="warning" role="alert">{t("entryProtectionReadFailed")}</Banner>
        : <p className={styles.status} role="status">{t(query.data?.protected ? "entryProtectionProtected" : "entryProtectionUnprotected")}</p>}
    {target.selectionId === null ? <p className={styles.meta}>{t("editorNoSelection")}</p> : null}
    {!input && ready ? <p className={styles.meta}>{t("entryProtectionDraftBlocked")}</p> : null}
    {message ? <Banner tone={message.key === "entryProtectionSaved" || message.key === "entryProtectionReleased" || message.key === "entryProtectionReconciled" ? "success" : "warning"} role="status">{t(message.key)}</Banner> : null}
    {state.failure && message?.key !== "entryProtectionFailed" ? <Banner tone="error" role="alert">{t("entryProtectionFailed")}</Banner> : null}
    {!pending && (working || state.busy) ? <p role="status">{t("entryProtectionPending")}</p> : null}
    {pending ? <Banner tone="warning" role="status" action={pending.phase === "unknown" && pendingPayload ? <div className={styles.actions}>
      <Button disabled={!pendingAvailability(pendingPayload).enabled} onClick={() => commands.dispatch("translation.check-protection", commandScope, pendingPayload)}>{t("entryProtectionCheck")}</Button>
      <Button disabled={!pendingAvailability(pendingPayload).enabled} onClick={() => commands.dispatch("translation.retry-protection", commandScope, pendingPayload)}>{t("entryProtectionRetry")}</Button>
    </div> : undefined}>{t(pending.phase === "unknown" ? pending.request.protected ? "entryProtectionUnknown" : "entryProtectionUnknownRelease" : "entryProtectionPending", { key: pending.key, locale: pending.request.locale })}</Banner> : null}
    <div className={styles.actions}><Button size="sm" disabled={!protectPayload || !changeAvailability(protectPayload).enabled} onClick={() => { if (protectPayload) commands.dispatch("translation.protect-work", commandScope, protectPayload); }}>{t("entryProtectionProtect")}</Button>
      <Dialog open={modalOpen} onOpenChange={open => { if (open) openRelease(); else if (interactionAllowed(true)) closeRelease(); }}
        title={t("entryProtectionReleaseTitle")} description={t("entryProtectionReleaseHelp")} closeLabel={t("entryProtectionClose")}
        trigger={<Button ref={releaseButton} size="sm" disabled={!canOpenRelease()}>{t("entryProtectionRelease")}</Button>}
        onOpenAutoFocus={event => { event.preventDefault(); if (visible && gate.getSnapshot().visibleViewId === viewId && releaseRef.current?.scope === scope) cancelButton.current?.focus(); }}
        onCloseAutoFocus={event => {
          event.preventDefault(); const previous = returnFocus.current; returnFocus.current = null;
          if (!previous || releaseRef.current || previous.scope !== live.current.scope || !live.current.visible || live.current.disabled || !mounted.current
            || !gate.canDispatch({ viewId, source: "button", dialogId: gate.getSnapshot().dialogs.at(-1) === dialogId ? dialogId : parentDialogId })) return;
          const active = document.activeElement;
          if (active instanceof HTMLElement && active !== document.body && active !== previous.trigger && event.target instanceof Node && !event.target.contains(active)) return;
          if (previous.trigger?.isConnected && !previous.trigger.disabled) previous.trigger.focus(); else section.current?.focus();
        }}
        onEscapeKeyDown={event => { if (event.isComposing || event.keyCode === 229 || !modalAllowed) event.preventDefault(); }}
        onInteractOutside={event => { if (!modalAllowed) event.preventDefault(); }}
        footer={<><Button ref={cancelButton} disabled={!modalAllowed} onClick={closeRelease}>{t(working || state.busy ? "entryProtectionClose" : "entryProtectionCancel")}</Button><Button variant="danger" pending={working || state.busy} disabled={!releasePayload || !changeAvailability(releasePayload).enabled} onClick={() => { if (releasePayload) commands.dispatch("translation.release-work", commandScope, releasePayload); }}>{t("entryProtectionConfirmRelease")}</Button></>}>
        {release ? <div className={styles.preview}><p className={styles.target}>{release.basis.key} · {release.basis.request.locale}</p>
          <h4>{t("entryProtectionSource")}</h4><div className={styles.text}><TokenizedText text={release.basis.sourceText ?? ""}/></div>
          <h4>{t("entryProtectionTranslation")}</h4><div className={styles.text}>{renderText(release.basis.selectionText)}</div>
          {!releaseCurrent() ? <Banner tone="warning" role="alert">{t("entryProtectionChanged")}</Banner> : null}
          {!cleanInput(drafts.getEntry(key)) ? <Banner tone="warning">{t("entryProtectionDraftBlocked")}</Banner> : null}
          {query.isError || opening.failed ? <Banner tone="warning">{t("entryProtectionReadFailed")}</Banner> : null}
          {refreshButton}
        </div> : null}
      </Dialog>
    </div>
  </section>;
}
