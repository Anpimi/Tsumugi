import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogTrigger, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription } from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { connectionReadOptions, useApplicationQueryClient } from "./ApplicationReadProvider";
import { connectionDirty, useConnectionDraft, type ConnectionNotice } from "./ConnectionDraftSession";
import { CommandFailureDetails, commandFailure, failureReason } from "./CommandFailure";
import type { TranslationKey } from "./i18n/types";
import type { ModelConnectionProfile } from "./connectionCommands";
import type { SessionExitPermit } from "./sessionNavigation";
import "./ConnectionManager.css";

export interface ConnectionManagerHandle { prepareExit: (current: () => boolean) => Promise<SessionExitPermit | null>; open: () => void }
const reasons: Partial<Record<string, { field: string; message: TranslationKey }>> = {
  "model-connection-name": { field: "name", message: "connections.errors.name" },
  "ai-endpoint": { field: "endpoint", message: "connections.errors.endpoint" },
  "ai-model": { field: "model", message: "connections.errors.model" },
  "ai-credential": { field: "credentialEnv", message: "connections.errors.credentialEnv" },
  "ai-token-field": { field: "tokenField", message: "connections.errors.tokenField" },
  "model-connection-name-duplicate": { field: "name", message: "connections.errors.duplicate" },
  "model-connections-capacity": { field: "capacity", message: "connections.errors.capacity" },
};
const labels = { endpoint: "connections.endpoint", model: "connections.model", credentialEnv: "connections.credentialEnv" } as const;
const notices: Record<ConnectionNotice, TranslationKey> = {
  "saved": "connections.notices.saved", "saved-newer-draft": "connections.notices.saved-newer-draft", "archive": "connections.notices.archive",
  "restore": "connections.notices.restore", "edited-during-read": "connections.notices.edited-during-read", "changed": "connections.notices.changed",
  "different-store": "connections.notices.different-store", "not-applied-changed": "connections.notices.not-applied-changed",
  "not-applied": "connections.notices.not-applied", "draft-retained": "connections.notices.draft-retained", "unavailable": "connections.notices.unavailable",
  "exit-blocked": "connections.notices.exit-blocked", "exit-edited": "connections.notices.exit-edited",
};
export function ConnectionManager({ disabled, ref }: { disabled: boolean; ref?: Ref<ConnectionManagerHandle> }) {
  const { t } = useTranslation(), owner = useConnectionDraft(), client = useApplicationQueryClient();
  const [open, setOpen] = useState(false), [showArchived, setShowArchived] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [switchTarget, setSwitchTarget] = useState<{ profile: ModelConnectionProfile | null; seq: number } | null>(null);
  const query = useQuery({ ...connectionReadOptions(), enabled: open }, client);
  const { state } = owner, { editor } = state;
  const confirmed = owner.currentView();
  const view = query.data;
  const changed = state.conflict || (confirmed ? owner.changed(confirmed) : false);
  const currentProfile = confirmed?.snapshot.profiles.find(profile => profile.id === editor.id);
  const fieldReason = failureReason(state.failure), issue = fieldReason ? reasons[fieldReason] : undefined, field = issue?.field;
  function fieldError(name: string) { return field === name && issue ? <p id={"connection-" + name + "-error"} role="alert">{t(issue.message)}</p> : null; }
  const close = () => { if (owner.current().exitHeld) return; if (owner.current().exitPrompt) owner.answerExit(false); setSwitchTarget(null); setOpen(false); };
  useImperativeHandle(ref, () => ({ open: () => {
    if (!open) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, prepareExit: async current => {
    if (connectionDirty(owner.current().editor) || owner.reserved()) setOpen(true);
    return owner.prepareExit(current);
  } }));
  const nameInput = useRef<HTMLInputElement>(null);
  function pick(profile: ModelConnectionProfile | null) {
    if (owner.reserved()) return;
    if (owner.dirty) { setSwitchTarget({ profile: profile ? structuredClone(profile) : null, seq: owner.current().editor.seq }); return; }
    if (owner.select(profile, confirmed)) queueMicrotask(() => nameInput.current?.focus());
  }
  function switchConfirmed() {
    const selected = switchTarget; if (!selected || owner.current().editor.seq !== selected.seq) { setSwitchTarget(null); return; }
    if (owner.discard() && owner.select(selected.profile, confirmed)) { setSwitchTarget(null); nameInput.current?.focus(); }
  }
  function change(field: "name" | "endpoint" | "model" | "credentialEnv" | "tokenField", value: string) {
    const values = owner.current().editor.values;
    owner.edit(field === "name" ? { ...values, name: value } : { ...values, connection: { ...values.connection, [field]: value } });
  }
  const blocked = disabled || state.busy || state.pending !== null || state.exitPrompt || state.exitHeld || switchTarget !== null;
  const canSelect = !blocked && confirmed !== undefined;
  return <Dialog open={open} onOpenChange={value => { if (value) setOpen(true); else close(); }}>
    <DialogTrigger asChild><button type="button" className="secondary-button" disabled={disabled || state.exitHeld}>{t("connections.open")}</button></DialogTrigger>
    <DialogPortal><DialogOverlay className="dialog-backdrop"/><DialogContent className="execution-dialog connection-manager" aria-busy={state.busy}
      onCloseAutoFocus={event => {
        const target = returnFocus.current; returnFocus.current = null;
        if (target?.isConnected && !target.matches(":disabled")) { event.preventDefault(); target.focus(); }
      }} onEscapeKeyDown={event => { if (state.exitHeld) event.preventDefault(); }} onInteractOutside={event => { if (state.exitHeld) event.preventDefault(); }}>
      <div className="execution-heading"><div><DialogTitle>{t("connections.title")}</DialogTitle><DialogDescription>{t("connections.description")}</DialogDescription></div>
        <button type="button" className="secondary-button" disabled={state.exitHeld} onClick={close}>{t("connections.close")}</button></div>
      {state.exitPrompt ? <section className="connection-notice" aria-label={t("connections.exitTitle")}>
        <h3>{t("connections.exitTitle")}</h3><p>{t("connections.exitHelp")}</p>
        <button type="button" onClick={() => owner.answerExit(false)}>{t("connections.continueEditing")}</button>
        <button type="button" disabled={state.busy || state.pending !== null} onClick={() => { if (owner.answerExit(true)) setOpen(false); }}>{t("connections.discardAndExit")}</button>
      </section> : null}
      {switchTarget ? <section className="connection-notice" aria-label={t("connections.switchTitle")}><h3>{t("connections.switchTitle")}</h3><p>{t("connections.switchHelp")}</p>
        <button type="button" onClick={() => setSwitchTarget(null)}>{t("connections.keepDraft")}</button>
        <button type="button" disabled={owner.current().editor.seq !== switchTarget.seq} onClick={switchConfirmed}>{t("connections.discardAndOpen")}</button></section> : null}
      <div className="connection-layout"><section className="connection-inventory" aria-label={t("connections.savedProfiles")}>
        <div className="execution-actions"><button type="button" disabled={!canSelect} onClick={() => pick(null)}>{t("connections.new")}</button>
          <button type="button" disabled={state.busy || state.exitHeld || query.isFetching} onClick={() => void owner.refresh().catch(() => {})}>{t("connections.refresh")}</button></div>
        <label className="connection-toggle"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)}/>{t("connections.showArchived")}</label>
        {query.isFetching ? <p role="status">{t("connections.loading")}</p> : query.isError ? <div role="alert"><p>{t("connections.readFailed")}</p><CommandFailureDetails failure={commandFailure(query.error)}/></div>
          : view ? <>{view.snapshot.profiles.filter(profile => showArchived || !profile.archived).length === 0 ? <p>{t("connections.empty")}</p> : null}
          <ul className="connection-list">{view.snapshot.profiles.filter(profile => showArchived || !profile.archived).slice().sort((a,b) => a.name.localeCompare(b.name)).map(profile => <li key={profile.id}>
            <button type="button" disabled={!canSelect} aria-pressed={editor.id === profile.id && editor.storeId === view.snapshot.storeId} onClick={() => pick(profile)}>{profile.name}</button>
            <p>{profile.connection.model}</p>{profile.archived ? <p>{t("connections.archived")}</p> : null}
            <button type="button" disabled={!canSelect || owner.dirty} onClick={() => void owner.archive(profile, profile.archived, view)}>{t(profile.archived ? "connections.restore" : "connections.archive")}</button>
          </li>)}</ul><p>{t("connections.capacity", { count: view.snapshot.profiles.length })}</p></> : null}
      </section><section className="connection-editor" aria-label={t("connections.editProfile")}>
        <form onSubmit={event => { event.preventDefault(); void owner.save(); }}>
          <label htmlFor="connection-name">{t("connections.name")}</label><input id="connection-name" ref={nameInput} value={editor.values.name} disabled={state.exitHeld}
            aria-invalid={field === "name" || field === "duplicate"} aria-describedby={"connection-name-help" + (field === "name" || field === "duplicate" ? " connection-" + field + "-error" : "")} onChange={event => change("name", event.target.value)}/>
          <p id="connection-name-help">{t("connections.nameHelp", { count: Array.from(editor.values.name).length })}</p>
          {fieldError("name")}{fieldError("duplicate")}
          {(["endpoint", "model", "credentialEnv"] as const).map(key => <div key={key}><label htmlFor={"connection-" + key}>{t(labels[key])}</label>
            <input id={"connection-" + key} value={editor.values.connection[key]} disabled={state.exitHeld} spellCheck={false} autoCapitalize="none"
              aria-invalid={field === key} aria-describedby={[key === "credentialEnv" ? "connection-credential-help" : "", field === key ? "connection-" + key + "-error" : ""].filter(Boolean).join(" ") || undefined} onChange={event => change(key, event.target.value)}/>{fieldError(key)}</div>)}
          <p id="connection-credential-help">{t("connections.credentialHelp")}</p>
          <label htmlFor="connection-tokenField">{t("connections.tokenField")}</label><select id="connection-tokenField" value={editor.values.connection.tokenField} disabled={state.exitHeld} aria-invalid={field === "tokenField"} aria-describedby={field === "tokenField" ? "connection-tokenField-error" : undefined} onChange={event => change("tokenField", event.target.value)}>
            <option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select>
          {fieldError("tokenField")}
          {editor.baseline?.archived ? <p>{t("connections.archivedEdit")}</p> : null}
          {fieldError("capacity")}{!issue && state.failure ? <p role="alert">{t("connections.failed")}</p> : null}
          <CommandFailureDetails failure={state.failure}/>
          <div className="execution-actions"><button type="submit" className="primary-button" disabled={blocked || !owner.dirty}>{t(state.busy ? "connections.saving" : "connections.save")}</button>
            <button type="button" disabled={blocked || !owner.dirty} onClick={() => owner.discard()}>{t("connections.discardDraft")}</button></div>
        </form>
        {changed ? <section className="connection-notice"><h3>{t("connections.changedTitle")}</h3><p>{t("connections.changedHelp")}</p>
          {currentProfile ? <><dl><dt>{t("connections.savedName")}</dt><dd>{currentProfile.name}</dd><dt>{t("connections.model")}</dt><dd>{currentProfile.connection.model}</dd><dt>{t("connections.endpoint")}</dt><dd>{currentProfile.connection.endpoint}</dd><dt>{t("connections.credentialEnv")}</dt><dd>{currentProfile.connection.credentialEnv || t("connections.noCredential")}</dd><dt>{t("connections.tokenField")}</dt><dd>{currentProfile.connection.tokenField}</dd></dl>
            <button type="button" disabled={blocked} onClick={() => confirmed && owner.reviewCurrent(confirmed, true)}>{t("connections.keepAndReview")}</button>
            <button type="button" disabled={blocked} onClick={() => confirmed && owner.reviewCurrent(confirmed, false)}>{t("connections.useSaved")}</button></> : <><p>{t("connections.unavailable")}</p><button type="button" disabled={blocked} onClick={() => owner.keepAsNew()}>{t("connections.saveAsNew")}</button></>}</section> : null}
        {state.pending?.uncertain ? <section className="connection-notice" aria-label={t("connections.recoveryTitle")}><h3>{t("connections.recoveryTitle")}</h3><p>{t("connections.unknown")}</p>
          <button type="button" disabled={state.busy || state.exitHeld} onClick={() => void owner.reconcile()}>{t("connections.reconcile")}</button>
          {state.pending.retryAllowed ? <button type="button" disabled={state.busy || state.exitHeld} onClick={() => void owner.retry()}>{t("connections.retry")}</button> : null}</section> : null}
        {state.notice ? <p role="status">{t(notices[state.notice])}</p> : null}
      </section></div>
    </DialogContent></DialogPortal>
  </Dialog>;
}
