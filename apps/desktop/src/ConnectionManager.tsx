import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { connectionReadOptions, useApplicationQueryClient } from "./ApplicationReadProvider";
import { connectionDirty, useConnectionDraft, type ConnectionNotice } from "./ConnectionDraftSession";
import { CommandFailureDetails, commandFailure, failureReason } from "./CommandFailure";
import type { TranslationKey } from "./i18n/types";
import type { ModelConnectionProfile } from "./connectionCommands";
import type { SessionExitPermit } from "./sessionNavigation";
import { ChatGptConnectionFields } from "./ChatGptConnectionFields";
import { Button } from "./design-system/Button";
import { Dialog } from "./design-system/Dialog";
import { Banner, EmptyState, LoadingState } from "./design-system/Feedback";
import { Field, TextInput } from "./design-system/Field";
import fieldStyles from "./design-system/Field.module.css";
import styles from "./ConnectionManager.module.css";

export interface ConnectionManagerHandle { prepareExit: (current: () => boolean) => Promise<SessionExitPermit | null>; open: (returnTo?: HTMLElement) => void }
const reasons: Partial<Record<string, { field: string; message: TranslationKey }>> = {
  "model-connection-name": { field: "name", message: "connections.errors.name" },
  "ai-endpoint": { field: "endpoint", message: "connections.errors.endpoint" },
  "ai-model": { field: "model", message: "connections.errors.model" },
  "ai-credential": { field: "credentialEnv", message: "connections.errors.credentialEnv" },
  "ai-token-field": { field: "tokenField", message: "connections.errors.tokenField" },
  "ai-subscription-profile": { field: "subscription", message: "ai.errors.ai-subscription-profile" },
  "ai-subscription-account": { field: "subscription", message: "ai.errors.ai-subscription-account" },
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
export interface ConnectionManagerProps {
  disabled: boolean;
  hideTrigger?: boolean;
  presentation?: "dialog" | "embedded";
  visible?: boolean;
  onReveal?: () => void;
  ref?: Ref<ConnectionManagerHandle>;
}
export function ConnectionManager({ disabled, hideTrigger = false, presentation = "dialog", visible = true, onReveal, ref }: ConnectionManagerProps) {
  const { t } = useTranslation(), owner = useConnectionDraft(), client = useApplicationQueryClient();
  const [open, setOpen] = useState(false), [showArchived, setShowArchived] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [switchTarget, setSwitchTarget] = useState<{ profile: ModelConnectionProfile | null; seq: number } | null>(null);
  const embedded = presentation === "embedded";
  const query = useQuery({ ...connectionReadOptions(), enabled: embedded ? visible : open }, client);
  const { state } = owner, { editor } = state;
  const confirmed = owner.currentView();
  const view = query.data;
  const changed = state.conflict || (confirmed ? owner.changed(confirmed) : false);
  const currentProfile = confirmed?.snapshot.profiles.find(profile => profile.id === editor.id);
  const subscription = editor.values.connection.tokenField === "chatgpt_subscription";
  const fieldReason = failureReason(state.failure), issue = fieldReason ? reasons[fieldReason] : undefined, field = issue?.field;
  function fieldError(name: string) { return field === name && issue ? <span role="alert">{t(issue.message)}</span> : undefined; }
  const close = () => { if (owner.current().exitHeld) return; if (owner.current().exitPrompt) owner.answerExit(false); setSwitchTarget(null); setOpen(false); };
  function reveal(returnTo?: HTMLElement) {
    if (embedded) { onReveal?.(); return; }
    if (!open) returnFocus.current = returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setOpen(true);
  }
  useImperativeHandle(ref, () => ({ open: reveal, prepareExit: async current => {
    if (connectionDirty(owner.current().editor) || owner.reserved()) reveal();
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
  const profiles = view?.snapshot.profiles.filter(profile => showArchived || !profile.archived).slice().sort((a, b) => a.name.localeCompare(b.name)) ?? [];
  const content = <div className={styles.manager} aria-busy={state.busy}>
      {state.exitPrompt ? <Banner tone="warning" role="region" aria-label={t("connections.exitTitle")}>
        <h3>{t("connections.exitTitle")}</h3><p>{t("connections.exitHelp")}</p>
        <div className={styles.actions}><Button variant="secondary" onClick={() => owner.answerExit(false)}>{t("connections.continueEditing")}</Button>
        <Button variant="danger" disabled={state.busy || state.pending !== null} onClick={() => { if (owner.answerExit(true) && !embedded) setOpen(false); }}>{t("connections.discardAndExit")}</Button></div>
      </Banner> : null}
      {switchTarget ? <Banner tone="warning" role="region" aria-label={t("connections.switchTitle")}><h3>{t("connections.switchTitle")}</h3><p>{t("connections.switchHelp")}</p>
        <div className={styles.actions}><Button variant="secondary" onClick={() => setSwitchTarget(null)}>{t("connections.keepDraft")}</Button>
        <Button variant="danger" disabled={owner.current().editor.seq !== switchTarget.seq} onClick={switchConfirmed}>{t("connections.discardAndOpen")}</Button></div></Banner> : null}
      <div className={styles.layout}><section className={styles.inventory} aria-label={t("connections.savedProfiles")}><h3>{t("connections.savedProfiles")}</h3>
        <div className={styles.actions}><Button variant="secondary" disabled={!canSelect} onClick={() => pick(null)}>{t("connections.new")}</Button>
          <Button type="button" disabled={state.busy || state.exitHeld || query.isFetching} onClick={() => void owner.refresh().catch(() => {})}>{t("connections.refresh")}</Button></div>
        <label className={styles.toggle}><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)}/>{t("connections.showArchived")}</label>
        {query.isFetching ? <LoadingState label={t("connections.loading")}/> : query.isError ? <Banner tone="error" role="alert"><p>{t("connections.readFailed")}</p><CommandFailureDetails failure={commandFailure(query.error)}/></Banner>
          : view ? <>{profiles.length === 0 ? <EmptyState title={t("connections.empty")}/> : null}
          <ul className={styles.list}>{profiles.map(profile => <li key={profile.id}>
            <Button type="button" className={styles.profile} disabled={!canSelect} aria-pressed={editor.id === profile.id && editor.storeId === view.snapshot.storeId} onClick={() => pick(profile)}>{profile.name}</Button>
            <p>{profile.connection.model}</p>{profile.archived ? <p>{t("connections.archived")}</p> : null}
            <Button type="button" disabled={!canSelect || owner.dirty} onClick={() => void owner.archive(profile, profile.archived, view)}>{t(profile.archived ? "connections.restore" : "connections.archive")}</Button>
          </li>)}</ul><p className={styles.hint}>{t("connections.capacity", { count: view.snapshot.profiles.length })}</p></> : null}
      </section><section className={styles.editor} aria-label={t("connections.editProfile")}><h3>{t("connections.editProfile")}</h3>
        <form className={styles.form} onSubmit={event => { event.preventDefault(); void owner.save(); }}>
          <Field id="connection-name" label={t("connections.name")} description={t("connections.nameHelp", { count: Array.from(editor.values.name).length })} error={fieldError("name") ?? fieldError("duplicate")}>
            <TextInput ref={nameInput} value={editor.values.name} disabled={state.exitHeld} onChange={event => change("name", event.target.value)}/>
          </Field>
          <Field id="connection-authentication" label={t("connections.authentication")}>
            <select className={fieldStyles.input} value={subscription ? "chatgpt" : "api"} disabled={state.exitHeld} onChange={event => {
              const values = owner.current().editor.values;
              owner.edit({ ...values, connection: event.target.value === "chatgpt"
                ? { endpoint: "https://api.openai.com/v1/responses", model: "", credentialEnv: "", tokenField: "chatgpt_subscription", chatgptAccount: null }
                : { endpoint: "https://api.openai.com/v1/chat/completions", model: "", credentialEnv: "OPENAI_API_KEY", tokenField: "max_completion_tokens", chatgptAccount: null } });
            }}><option value="api">{t("connections.api")}</option><option value="chatgpt">{t("connections.chatgpt.connection")}</option></select>
          </Field>
          <ChatGptConnectionFields connection={editor.values.connection} disabled={state.exitHeld || disabled || state.exitPrompt || switchTarget !== null} modelInvalid={field === "model"}
            onChange={connection => owner.edit({ ...owner.current().editor.values, connection })}/>
          {!subscription ? <>
            {(["endpoint", "model", "credentialEnv"] as const).map(key => <Field key={key} id={"connection-" + key} label={t(labels[key])} error={fieldError(key)} description={key === "credentialEnv" ? t("connections.credentialHelp") : undefined}>
              <TextInput value={editor.values.connection[key]} disabled={state.exitHeld} spellCheck={false} autoCapitalize="none" onChange={event => change(key, event.target.value)}/>
            </Field>)}
            <Field id="connection-tokenField" label={t("connections.tokenField")} error={fieldError("tokenField")}>
              <select className={fieldStyles.input} value={editor.values.connection.tokenField} disabled={state.exitHeld} onChange={event => change("tokenField", event.target.value)}>
                <option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option>
              </select>
            </Field>
          </> : <>{field === "model" ? <p id="connection-model-error">{fieldError("model")}</p> : null}{fieldError("subscription")}<p className={styles.hint}>{t("connections.chatgpt.endpoint")}</p></>}
          {editor.baseline?.archived ? <Banner>{t("connections.archivedEdit")}</Banner> : null}
          {fieldError("capacity")}{!issue && state.failure ? <Banner tone="error" role="alert">{t("connections.failed")}</Banner> : null}
          <CommandFailureDetails failure={state.failure}/>
          <div className={styles.saveActions}><Button type="submit" variant="primary" pending={state.busy} disabled={blocked || !owner.dirty}>{t(state.busy ? "connections.saving" : "connections.save")}</Button>
            <Button type="button" disabled={blocked || !owner.dirty} onClick={() => owner.discard()}>{t("connections.discardDraft")}</Button></div>
        </form>
        {changed ? <Banner tone="warning" role="region" aria-label={t("connections.changedTitle")}><h3>{t("connections.changedTitle")}</h3><p>{t("connections.changedHelp")}</p>
          {currentProfile ? <><dl className={styles.details}><dt>{t("connections.savedName")}</dt><dd>{currentProfile.name}</dd><dt>{t("connections.model")}</dt><dd>{currentProfile.connection.model}</dd><dt>{t("connections.endpoint")}</dt><dd>{currentProfile.connection.endpoint}</dd><dt>{t("connections.credentialEnv")}</dt><dd>{currentProfile.connection.credentialEnv || t("connections.noCredential")}</dd><dt>{t("connections.tokenField")}</dt><dd>{currentProfile.connection.tokenField}</dd>
            {currentProfile.connection.chatgptAccount ? <><dt>{t("connections.chatgpt.accountReference")}</dt><dd>{currentProfile.connection.chatgptAccount}</dd></> : null}</dl>
            <div className={styles.actions}><Button variant="secondary" disabled={blocked} onClick={() => confirmed && owner.reviewCurrent(confirmed, true)}>{t("connections.keepAndReview")}</Button>
            <Button disabled={blocked} onClick={() => confirmed && owner.reviewCurrent(confirmed, false)}>{t("connections.useSaved")}</Button></div></> : <><p>{t("connections.unavailable")}</p><Button variant="secondary" disabled={blocked} onClick={() => owner.keepAsNew()}>{t("connections.saveAsNew")}</Button></>}</Banner> : null}
        {state.pending?.uncertain ? <Banner tone="warning" role="region" aria-label={t("connections.recoveryTitle")}><h3>{t("connections.recoveryTitle")}</h3><p>{t("connections.unknown")}</p>
          <div className={styles.actions}><Button variant="secondary" disabled={state.busy || state.exitHeld} onClick={() => void owner.reconcile()}>{t("connections.reconcile")}</Button>
          {state.pending.retryAllowed ? <Button disabled={state.busy || state.exitHeld} onClick={() => void owner.retry()}>{t("connections.retry")}</Button> : null}</div></Banner> : null}
        {state.notice ? <Banner role="status">{t(notices[state.notice])}</Banner> : null}
      </section></div>
  </div>;
  if (embedded) return <section className={styles.embedded} hidden={!visible} aria-label={t("connections.title")}>
    <header className={styles.heading}><h2>{t("connections.title")}</h2><p>{t("connections.description")}</p></header>
    {content}
  </section>;
  return <Dialog open={open} onOpenChange={value => { if (value) setOpen(true); else close(); }} title={t("connections.title")} description={t("connections.description")} closeLabel={t("connections.close")} className={styles.dialog}
    trigger={!hideTrigger ? <Button variant="secondary" disabled={disabled || state.exitHeld}>{t("connections.open")}</Button> : undefined}
    onCloseAutoFocus={event => {
      const target = returnFocus.current; returnFocus.current = null;
      if (target?.isConnected && !target.matches(":disabled")) { event.preventDefault(); target.focus(); }
    }} onEscapeKeyDown={event => { if (state.exitHeld) event.preventDefault(); }} onInteractOutside={event => { if (state.exitHeld) event.preventDefault(); }}>
    {content}
  </Dialog>;
}
