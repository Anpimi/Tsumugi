import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { CommandFailureDetails } from "../../../CommandFailure";
import { contextResourceDirty } from "../../../contextResourceDrafts";
import type { ContextResourceKind, ContextResourceRevision } from "../../../resourceCommands";
import { useSessionReads } from "../../../SessionReadProvider";
import type { KnowledgeViewProps } from "./KnowledgeView";
import { knowledgeBlocked } from "./knowledgeState";
import ContextResourceScope, { ContextScopeText } from "./ContextResourceScope";
import { contextSourceKey, resourceCurrentKey, sameContentScope, useContextResourceCurrent, useContextResourcePages, useContextSource } from "./contextResourceReads";
import { useKnowledgeScope } from "./knowledgeReads";
import styles from "./Knowledge.module.css";

export default function ContextResourcesView({ project, owner, view, disabled, gate, current, onDetails, kind }: KnowledgeViewProps & { kind: ContextResourceKind }) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" });
  const reads = useSessionReads(), locale = view.locale, enabled = project.metadata.targetLocales.includes(locale);
  const interaction = useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const drafts = Object.values(owner.state.typedDrafts).filter(draft => draft.kind === kind && draft.locale === locale);
  const chosen = owner.state.typedActiveKey ? owner.state.typedDrafts[owner.state.typedActiveKey] : null;
  const draft = chosen?.kind === kind && chosen.locale === locale ? chosen : null;
  const list = useContextResourcePages(project, locale, kind, enabled);
  const rows = list.data?.pages.flatMap(page => page.rows) ?? [];
  const observed = useContextResourceCurrent(project, draft?.contextId ?? null, !!draft?.contextId, { kind, locale });
  const { source, files } = useContextSource(project, enabled);
  const scopeName = useKnowledgeScope(project, locale, draft?.scope.kind === "unit" ? draft.scope.unitId : null, !!draft);
  const busy = knowledgeBlocked(owner), inputId = useId(), dialogId = useId();
  const nameInput = useRef<HTMLInputElement>(null), focusTicket = useRef<HTMLElement | null | undefined>(undefined);
  const [withdrawal, setWithdrawal] = useState<{ key: string; revision: string; sequence: number } | null>(null);
  useLayoutEffect(() => withdrawal ? gate.pushDialog(dialogId) : undefined, [withdrawal, gate, dialogId]);
  useEffect(() => () => gate.releaseOwner(inputId), [gate, inputId]);
  useLayoutEffect(() => { if (focusTicket.current === undefined || !nameInput.current) return; const origin = focusTicket.current; focusTicket.current = undefined;
    if (document.activeElement === origin || document.activeElement === document.body) nameInput.current.focus(); });
  function fresh(key: readonly unknown[]) { const state = reads.client.getQueryState(reads.key(key)); return state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated; }
  function sourceFresh() { return source.isSuccess && !source.isFetching && !source.error && fresh(contextSourceKey); }
  function filesFresh() { return sourceFresh() && files.isSuccess && !files.isFetching && !files.error && !!files.data && !!source.data
    && sameContentScope(files.data.scope, source.data) && fresh(["knowledge-context-files", source.data.currentSnapshot, source.data.revision]); }
  const sourceChanged = !!draft && (!source.data || !sameContentScope(draft.sourceBasis, source.data));
  const revisionChanged = !!draft?.base && observed.isSuccess && !observed.isFetching && !observed.error && observed.data?.revisionId !== draft.base.revisionId;
  const currentFresh = !draft?.contextId || observed.isSuccess && !observed.isFetching && !observed.error
    && (!observed.data || observed.data.kind === kind && observed.data.locale === locale);
  function begin(revision: ContextResourceRevision | null = null, variant = false) {
    if (!current() || disabled || !enabled || !revision && (!sourceFresh() || !source.data?.currentSnapshot)) return;
    const basis = sourceFresh() && source.data ? source.data : revision?.sourceBasis;
    if (!basis) return;
    focusTicket.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    owner.contextResources.begin(kind, locale, basis, revision, variant);
  }
  const pending = owner.state.pending?.kind === "typed-context" ? owner.state.pending : null;
  const validField = (value: string, limit: number) => !!value.trim() && !value.includes("\0") && new TextEncoder().encode(value).length <= limit;
  const validAudit = !!draft && validField(draft.actor, 512) && validField(draft.reason, 4096);
  const valid = !!draft && validAudit && validField(draft.name, 512) && validField(draft.text, 16384);
  const fieldError = (value: string, limit: number) => value && !value.trim() ? t("requiredValue") : new TextEncoder().encode(value).length > limit || value.includes("\0") ? t("contextFieldLong") : undefined;
  const dirty = !!draft && contextResourceDirty(draft);
  const fileGroup = draft?.scope.kind === "file-group" ? draft.scope : null, currentFiles = filesFresh() ? files.data : undefined;
  const missingPaths = fileGroup && currentFiles ? fileGroup.logicalPaths.filter(path => currentFiles.namespace !== fileGroup.namespace
    || !currentFiles.coverage.some(file => file.role === "source" && file.logicalPath === path)) : [];
  function proof(withdraw = false, modal?: string) {
    if (!draft || disabled || !enabled || !current(modal) || !currentFresh || revisionChanged) return false;
    if (draft.contextId && !fresh(resourceCurrentKey(draft.contextId))) return false;
    return withdraw || sourceFresh() && !!source.data?.currentSnapshot && sameContentScope(draft.sourceBasis, source.data)
      && (draft.scope.kind !== "file-group" || filesFresh() && missingPaths.length === 0);
  }
  function editor() {
    if (!draft) return null;
    return <div className={styles.rowEditor} aria-label={t("contextEditor")} onFocusCapture={() => gate.setInputOwner(view.id, inputId)}
      onCompositionStartCapture={() => gate.setComposing(inputId, true)} onCompositionEndCapture={() => gate.setComposing(inputId, false)}>
      <div className={styles.fields}>
        <Field label={t("contextName")} required error={fieldError(draft.name, 512)}><TextInput ref={nameInput} value={draft.name} readOnly={disabled} onChange={event => owner.contextResources.edit(draft.key, { name: event.target.value })}/></Field>
        <Field label={t("contextActor")} required error={fieldError(draft.actor, 512)}><TextInput value={draft.actor} readOnly={disabled} onChange={event => owner.contextResources.edit(draft.key, { actor: event.target.value })}/></Field>
        <Field label={t("reason")} required error={fieldError(draft.reason, 4096)}><TextInput value={draft.reason} readOnly={disabled} onChange={event => owner.contextResources.edit(draft.key, { reason: event.target.value })}/></Field>
        <Field label={t("contextText")} required error={fieldError(draft.text, 16384)} description={t("contextTextHelp")}><TextArea value={draft.text} readOnly={disabled} rows={5} onChange={event => owner.contextResources.edit(draft.key, { text: event.target.value })}/></Field>
      </div>
      <ContextResourceScope project={project} locale={locale} value={draft.scope} basis={draft.sourceBasis} source={source.data} files={files.data} fresh={filesFresh}
        failed={!!source.error || !!files.error} onRefresh={() => { void source.refetch(); void files.refetch(); }}
        disabled={disabled || sourceChanged} gate={gate} current={current} onChange={scope => owner.contextResources.edit(draft.key, { scope })}/>
      {draft.scope.kind === "unit" ? <p className={styles.meta}>{scopeName.data && !scopeName.error && !scopeName.isFetching ? scopeName.data.nativeKey : t("scopeUnavailable")}</p> : null}
      {sourceChanged ? <Banner tone="warning" action={<Button disabled={!sourceFresh() || !source.data?.currentSnapshot || busy} onClick={() => {
        if (current() && sourceFresh() && source.data) owner.contextResources.adoptSource(draft.key, source.data, draft.editSeq);
      }}>{t("contextConfirmSource")}</Button>}>{t("contextSourceChanged")}</Banner> : null}
      {missingPaths.length ? <Banner tone="warning">{t("contextMissingFiles")}<ul>{missingPaths.map(path => <li key={path}>{path}</li>)}</ul></Banner> : null}
      {revisionChanged ? <Banner tone="warning" action={<Button onClick={onDetails}>{t("compare")}</Button>}>{t("contextCurrentChanged")}</Banner> : null}
      {observed.error ? <Banner tone="warning" action={<Button onClick={() => void observed.refetch()}>{t("refresh")}</Button>}>{t("currentFailed")}</Banner> : null}
      <p className={styles.meta}>{t("contextLimits")}</p>
      <div className={styles.actions}><Button variant="primary" disabled={busy || !valid || !dirty || !proof() || interaction.composingOwners.length > 0} onClick={() => { if (proof()) void owner.contextResources.save(draft.key, () => proof()); }}>{t(draft.base?.withdrawn ? "contextRestoreSave" : "contextSave")}</Button>
        <Button disabled={busy || !dirty} onClick={() => { if (current()) owner.contextResources.discard(draft.key); }}>{t("contextDiscard")}</Button>
        <Button disabled={disabled} onClick={onDetails}>{t("details")}</Button>
        {draft.base && !draft.base.withdrawn ? <Button disabled={busy || !validAudit || !proof(true)} onClick={() => { if (proof(true)) setWithdrawal({ key: draft.key, revision: draft.base!.revisionId, sequence: draft.editSeq }); }}>{t("contextWithdraw")}</Button> : null}
      </div>
      {draft.notice ? <Banner tone="success" role="status">{t(draft.notice === "saved-newer" && dirty ? "contextSavedNewer" : "contextSaved")}</Banner> : null}
      {draft.failure || owner.state.typedLastActionKey === draft.key && owner.state.failure ? <Banner tone="error">{t("contextSaveFailed")}<CommandFailureDetails failure={draft.failure ?? owner.state.failure}/></Banner> : null}
    </div>;
  }
  return <>
    <div className={styles.toolbar}><h1>{t(kind === "character" ? "kinds.characters" : kind === "style" ? "kinds.style" : "kinds.background")}</h1>
      <Button disabled={disabled || !enabled || !sourceFresh() || !source.data?.currentSnapshot} onClick={() => begin()}>{t("contextNew")}</Button>
      <Button disabled={list.isFetching} onClick={() => void list.refetch()}>{t("refresh")}</Button></div>
    {drafts.length > 0 ? <nav className={styles.toolbar} aria-label={t("contextDrafts")}>{drafts.map(value => <Button key={value.key} aria-current={draft?.key === value.key ? "page" : undefined} onClick={() => { if (current()) owner.contextResources.activate(value.key); }}>{value.name || t("contextUntitled")}{contextResourceDirty(value) ? ` · ${t("contextUnsaved")}` : ""}</Button>)}</nav> : null}
    {pending ? <Banner tone="warning" action={<div className={styles.actions}><Button disabled={owner.state.busyMutation || disabled} onClick={() => { if (current()) void owner.checkPending(); }}>{t("checkAction")}</Button>
      {owner.state.pendingCheckedMissing ? <Button disabled={owner.state.busyMutation || disabled} onClick={() => { if (current()) void owner.retryPending(); }}>{t("retryAction")}</Button> : null}</div>}>{t(owner.state.busyMutation ? "contextSaving" : owner.state.pendingRecorded ? "contextRecordFound" : "contextUnknown")}<p>{owner.state.typedDrafts[pending.draftKey]?.name}</p><CommandFailureDetails failure={owner.state.failure}/></Banner> : null}
    <div className={styles.scroll}>
      {source.isSuccess && !source.data.currentSnapshot ? <Banner tone="warning">{t("contextNoSource")}</Banner> : null}
      {source.error || files.error ? <Banner tone="warning" action={<Button onClick={() => { void source.refetch(); void files.refetch(); }}>{t("refresh")}</Button>}>{t("contextSourceFailed")}</Banner> : null}
      {list.isFetching && !list.data ? <LoadingState label={t("contextReading")}/> : list.error ? <ErrorState title={t("contextReadFailed")} action={<Button onClick={() => void list.refetch()}>{t("refresh")}</Button>}/> : null}
      <table className={styles.table} aria-label={t("contextTable")}><thead><tr><th>{t("contextName")}</th><th>{t("contextText")}</th><th>{t("scope")}</th><th>{t("contextState")}</th></tr></thead><tbody>
        {draft && (!draft.contextId || list.error || !rows.some(row => row.contextId === draft.contextId)) ? <tr><td colSpan={4}>{editor()}</td></tr> : null}
        {!list.error ? rows.map(row => <Fragment key={row.contextId}><tr data-selected={draft?.contextId === row.contextId || undefined}>
          <td><Button variant="link" disabled={disabled} onClick={() => begin(row)}>{row.name}</Button></td><td>{row.text}</td><td><ContextScopeText scope={row.scope}/></td><td>{t(row.withdrawn ? "contextStopped" : "contextActive")}<Button size="xs" disabled={disabled} onClick={() => { begin(row); onDetails(); }}>{t("details")}</Button>
            <Button size="xs" disabled={disabled || !sourceFresh() || !source.data?.currentSnapshot} onClick={() => begin(row, true)}>{t("contextVariant")}</Button></td>
        </tr>{draft?.contextId === row.contextId ? <tr><td colSpan={4}>{editor()}</td></tr> : null}</Fragment>) : null}
      </tbody></table>
      {list.isSuccess && rows.length === 0 && !draft ? <EmptyState title={t("contextEmpty")} description={t("contextEmptyHelp")}/> : null}
      {list.hasNextPage ? <Button disabled={list.isFetching} onClick={() => void list.fetchNextPage()}>{t("contextMore")}</Button> : null}
      {!enabled ? <Banner tone="warning">{t("localeUnavailable", { locale })}</Banner> : null}
      <p className={styles.help}>{t("contextReferencesUnknown")}</p>
    </div>
    <Dialog open={!!withdrawal} onOpenChange={open => { if (!open) setWithdrawal(null); }} title={t("contextWithdrawTitle")} description={t("contextWithdrawHelp")} closeLabel={t("close")}
      footer={<><Button onClick={() => setWithdrawal(null)}>{t("proposalCancel")}</Button><Button variant="danger" disabled={!draft || !withdrawal || draft.key !== withdrawal.key || draft.base?.revisionId !== withdrawal.revision || draft.editSeq !== withdrawal.sequence || busy}
        onClick={() => { if (!draft || !withdrawal || draft.key !== withdrawal.key || draft.base?.revisionId !== withdrawal.revision || draft.editSeq !== withdrawal.sequence || !proof(true, dialogId)) return;
          const key = draft.key; setWithdrawal(null); void owner.contextResources.withdraw(key, () => proof(true, dialogId)); }}>{t("contextWithdrawConfirm")}</Button></>}>
      <p>{draft?.base?.name}</p><p>{t("contextWithdrawDraftKept")}</p>{draft?.base ? <ContextScopeText scope={draft.base.scope}/> : null}
    </Dialog>
  </>;
}
