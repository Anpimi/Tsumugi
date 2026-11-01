import KnowledgeExchangePreview from "./KnowledgeExchangePreview";
import { Menu } from "../../../design-system/Menu";
import { Fragment, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "../../../design-system/Button";
import { Field, TextInput } from "../../../design-system/Field";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { CommandFailureDetails } from "../../../CommandFailure";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import type { TermRevision } from "../../../resourceCommands";
import { sourceCommands } from "../../../sourceCommands";
import type { WorkspaceView, ViewPatch } from "../../workspace/workspaceStore";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { TranslationDrafts } from "../editor/translationDrafts";
import { contextKindForKnowledge, knowledgeKinds, type KnowledgeOwner, type KnowledgeKind, type ResourceProposalTarget } from "./knowledgeTypes";
import { knowledgeBlocked } from "./knowledgeState";
import { ResourceDraftRecovery } from "../../../ResourceDraftRecovery";
import { knowledgeCurrentKey, knowledgeTermsKey, useKnowledgeCurrent, useKnowledgeScope, useKnowledgeTerms } from "./knowledgeReads";
import TermScopePicker from "./TermScopePicker";
import TermProposalPanel from "./TermProposalPanel";
import ContextResourcesView from "./ContextResourcesView";
import KnowledgeProposalPanel, { type KnowledgeReviewTarget } from "./KnowledgeProposalPanel";
import TranslationMemoryView from "./TranslationMemoryView";
import styles from "./Knowledge.module.css";

export interface KnowledgeViewProps {
  project: ProjectView; owner: KnowledgeOwner; view: WorkspaceView; disabled: boolean;
  gate: InteractionGate; current: (dialogId?: string) => boolean; patch: (patch: ViewPatch) => void;
  onDetails: () => void;
  reviewTarget?: KnowledgeReviewTarget | null;
  onReviewOpened?: () => void;
  resourceTarget?: ResourceProposalTarget | null;
  onReturnToDecisions?: () => void;
  drafts?: TranslationDrafts | null;
  onEditTranslation?: (unitId: string, locale: string) => Promise<boolean>;
  onRevealTranslationDraft?: (unitId: string, locale: string) => void;
}
export default function KnowledgeView({ project, owner, view, disabled, gate, current, patch, onDetails, reviewTarget = null, onReviewOpened, resourceTarget, onReturnToDecisions, drafts = null, onEditTranslation, onRevealTranslationDraft }: KnowledgeViewProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" }), { t: exchange } = useTranslation(undefined, { keyPrefix: "knowledgeExchange" });
  const { selectedTerm, termDraft, aliasInput, locale, pending, busyMutation, notice, failure } = owner.state;
  const editingDisabled = disabled || owner.journal.hydration !== "ready" || owner.journal.retired;
  const sourceInput = useRef<HTMLInputElement>(null), focusTicket = useRef<{ termId: string | null; origin: HTMLElement | null } | null>(null);
  useLayoutEffect(() => {
    const ticket = focusTicket.current;
    if (!ticket || (selectedTerm?.termId ?? null) !== ticket.termId || !sourceInput.current) return;
    focusTicket.current = null;
    if (!disabled && (document.activeElement === ticket.origin || document.activeElement === document.body)) sourceInput.current.focus();
  });
  const interaction = useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const inputOwner = `knowledge-term-${view.id}`;
  useEffect(() => () => gate.releaseOwner(inputOwner), [gate, inputOwner]);
  const kind: KnowledgeKind = knowledgeKinds.find(kind => kind === view.preset) ?? "terms";
  const reviewDraft = owner.state.knowledgeActiveKey ? owner.state.knowledgeDrafts[owner.state.knowledgeActiveKey] : null;
  const showReview = !!reviewTarget || !!reviewDraft && reviewDraft.locale === view.locale && reviewDraft.entry.kind === contextKindForKnowledge(kind);
  const session = executionContext(project), reads = useSessionReads();
  const localeAvailable = project.metadata.targetLocales.includes(locale), localeMatches = locale === view.locale;
  const active = kind === "terms" && localeAvailable;
  const terms = useKnowledgeTerms(project, locale, active);
  const rows = terms.data?.pages.flat() ?? [];
  const currentTerm = useKnowledgeCurrent(project, locale, selectedTerm?.termId ?? null, active);
  const saved = currentTerm.data;
  const fresh = terms.isSuccess && !terms.isFetching && !terms.error;
  const currentFresh = !selectedTerm || currentTerm.isSuccess && !currentTerm.isFetching && !currentTerm.error;
  const changed = !!selectedTerm && currentFresh && saved?.revisionId !== selectedTerm.revisionId;
  const source = useSessionQuery({ key: ["resource-source-scope"], scopes: ["source"], enabled: active,
    read: () => sourceCommands.scope(session) });
  const scope = useKnowledgeScope(project, locale, termDraft.scopeUnitId ?? null, active);
  const dirty = owner.termDirty(), blocked = knowledgeBlocked(owner), editorVisible = !!selectedTerm || dirty || view.focus === "new";
  const fieldError = (value: string) => new TextEncoder().encode(value).length > 16384 ? t("tooLong") : value.length > 0 && !value.trim() ? t("requiredValue") : undefined;
  const valid = [termDraft.source, termDraft.target, termDraft.reason].every(value => !!value.trim() && !fieldError(value))
    && termDraft.aliases.length <= 16 && termDraft.aliases.every(value => !!value.trim() && !fieldError(value));
  useEffect(() => {
    if (kind === "terms" && !localeMatches && project.metadata.targetLocales.includes(view.locale) && !knowledgeBlocked(owner) && !owner.termDirty() && !owner.contextDirty() && !owner.correctionDirty() && !owner.factDirty() && !owner.tool.hasDraft()) owner.setLocale(view.locale);
  }, [kind, localeMatches, view.locale, owner, project.metadata.targetLocales]);
  function proof() {
    const table = reads.client.getQueryState(reads.key(knowledgeTermsKey(locale)));
    const basis = reads.client.getQueryState(reads.key(["resource-source-scope"]));
    const selected = selectedTerm ? reads.client.getQueryState(reads.key(knowledgeCurrentKey(selectedTerm.termId, locale))) : null;
    return current() && !disabled && localeMatches && localeAvailable && !changed && (!selectedTerm || selected?.status === "success" && !selected.isInvalidated && selected.fetchStatus === "idle") && table?.status === "success" && !table.isInvalidated && table.fetchStatus === "idle"
      && basis?.status === "success" && !basis.isInvalidated && basis.fetchStatus === "idle" && !!source.data?.currentSnapshot;
  }
  const canSave = !disabled && interaction.composingOwners.length === 0 && localeMatches && localeAvailable && dirty && valid && !blocked && fresh && currentFresh && !changed && source.isSuccess && !source.isFetching && !source.error && !!source.data?.currentSnapshot;
  function select(term: TermRevision, details = false) {
    if (!current() || disabled || !fresh || blocked || !localeMatches) return;
    if (owner.current().selectedTerm?.termId !== term.termId || !owner.termDirty()) {
      if (!owner.beginTerm(term)) return;
    }
    if (!details) focusTicket.current = { termId: term.termId, origin: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    patch({ focus: term.termId });
    if (details) onDetails();
  }
  function newTerm() {
    if (!current() || disabled || !owner.beginTerm(null)) return;
    focusTicket.current = { termId: null, origin: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    patch({ focus: "new" });
  }
  function discard() {
    if (!current() || disabled || blocked) return;
    owner.discardTerm();
    if (currentFresh && saved && !saved.removed) owner.beginTerm(saved);
  }
  function values(term: TermRevision | null) {
    const editing = term === null || term.termId === selectedTerm?.termId;
    return <>
      <tr data-selected={editing || undefined}>
        <td>{editing ? <Field label={t("sourceTerm")} required error={fieldError(termDraft.source)}><TextInput ref={sourceInput} readOnly={editingDisabled || !localeMatches || !localeAvailable} value={termDraft.source} onChange={event => owner.editTerm({ ...owner.current().termDraft, source: event.target.value })}/></Field>
          : <Button variant="link" disabled={disabled || blocked || dirty || !fresh || !localeMatches} onClick={() => select(term)}>{term.source}</Button>}</td>
        <td>{editing ? <Field label={t("targetTerm")} required error={fieldError(termDraft.target)}><TextInput readOnly={editingDisabled || !localeMatches || !localeAvailable} value={termDraft.target} onChange={event => owner.editTerm({ ...owner.current().termDraft, target: event.target.value })}/></Field> : term?.target}</td>
        <td>{t((editing ? termDraft.scopeUnitId : term?.scopeUnitId) ? "entryScope" : "projectScope")}</td>
        <td>{term ? <><span>{t(term.originKind === "manual" ? "manual" : "imported")}</span><Button size="xs" disabled={disabled || blocked || !fresh || dirty && !editing || !localeMatches} onClick={() => select(term, true)}>{t("details")}</Button></> : t("newTerm")}</td>
      </tr>
      {editing ? <tr><td colSpan={4}><div className={styles.rowEditor} aria-label={t("termEditor")}>
        <div className={styles.fields}>
          <Field label={t("aliases")} description={t("aliasesHelp")} error={termDraft.aliases.length > 16 ? t("aliasesInvalid") : termDraft.aliases.map(fieldError).find(Boolean)}><TextInput value={aliasInput} readOnly={editingDisabled || !localeMatches || !localeAvailable} onChange={event => { const value = event.target.value; owner.editTerm({ ...owner.current().termDraft, aliases: value.split(",").map(alias => alias.trim()).filter(Boolean) }, value); }}/></Field>
          <Field label={t("protected")} description={t("protectedHelp")}><TextInput type="checkbox" checked={termDraft.protected} disabled={disabled || !localeMatches} onChange={event => owner.editTerm({ ...owner.current().termDraft, protected: event.target.checked })}/></Field>
          <Field label={t("reason")} required error={fieldError(termDraft.reason)}><TextInput value={termDraft.reason} readOnly={editingDisabled || !localeMatches || !localeAvailable} onChange={event => owner.editTerm({ ...owner.current().termDraft, reason: event.target.value })}/></Field>
        </div>
        <p>{t("scope")}: {termDraft.scopeUnitId ? scope.data && !scope.error && !scope.isFetching ? scope.data.nativeKey : t("entryScope") : t("projectScope")}</p>
        {termDraft.scopeUnitId && (scope.error || scope.isFetching) ? <p className={styles.meta}>{t(scope.error ? "scopeUnavailable" : "readingEntries")}</p> : null}
        <div className={styles.actions}>
          <Button disabled={disabled || !localeMatches || !termDraft.scopeUnitId} onClick={() => { if (current()) owner.editTerm({ ...owner.current().termDraft, scopeUnitId: null }); }}>{t("changeScope")}</Button>
          <TermScopePicker project={project} locale={locale} disabled={disabled || !localeMatches} gate={gate} current={current} onSelect={scopeUnitId => owner.editTerm({ ...owner.current().termDraft, scopeUnitId })}/>
        </div>
        <div className={styles.actions}><Button variant="primary" pending={busyMutation && pending?.kind === "term"} disabled={!canSave} onClick={() => { if (proof()) void owner.saveTerm(proof); }}>{t("save")}</Button>
          <Button disabled={disabled || blocked || !dirty} onClick={discard}>{t("discard")}</Button>
          {selectedTerm ? <Button disabled={disabled} onClick={onDetails}>{t("details")}</Button> : null}</div>
        {changed ? <Banner tone="warning" action={<Button onClick={onDetails}>{t("compare")}</Button>}>{t("changed")}</Banner> : null}
      </div></td></tr> : null}
    </>;
  }
  return <div className={styles.workspace}>
    <nav className={styles.categories} aria-label={t("categories")}>{knowledgeKinds.map(item => <Button key={item} aria-current={!view.knowledgeExchange && kind === item ? "page" : undefined} onClick={() => { if (current()) patch({ preset: item, knowledgeExchange: null }); }}>{t(`kinds.${item}`)}</Button>)}
      <Menu label={exchange("menu")} trigger={<Button disabled={disabled}>{exchange("menu")}</Button>} items={(["tmx", "tbx"] as const).map(format => ({ id: format, label: exchange(format), onSelect: () => { if (current()) patch({ knowledgeExchange: format }); } }))}/>
    </nav>
    <section className={styles.body} aria-label={t(`kinds.${kind}`)} onFocusCapture={() => gate.setInputOwner(view.id, inputOwner)}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.setInputOwner(view.id, null); }}
      onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
      <ResourceDraftRecovery owner={owner} disabled={disabled}/>
      {Object.values(owner.state.knowledgeDrafts).length ? <nav className={styles.toolbar} aria-label={t("reviewDrafts")}>{Object.values(owner.state.knowledgeDrafts).map(draft => <Button key={draft.key} aria-current={showReview && reviewDraft?.key === draft.key ? "page" : undefined}
        onClick={() => { if (current()) { owner.knowledgeProposals.activate(draft.key); patch({ locale: draft.locale, preset: draft.entry.kind === "character" ? "characters" : draft.entry.kind }); } }}>{draft.name || draft.entry.name}</Button>)}</nav> : null}
      {showReview ? <KnowledgeProposalPanel project={project} owner={owner} view={view} disabled={editingDisabled} gate={gate} current={current} patch={patch} onDetails={onDetails} target={reviewTarget} onOpened={onReviewOpened}/> : null}
      {view.knowledgeExchange ? <KnowledgeExchangePreview key={`${view.knowledgeExchange}:${view.locale}`} project={project} locale={view.locale} format={view.knowledgeExchange}
        visible disabled={disabled} current={() => current() && !disabled} onClose={() => { if (current()) patch({ knowledgeExchange: null }); }}/>
        : contextKindForKnowledge(kind) ? <ContextResourcesView project={project} owner={owner} view={view} disabled={editingDisabled} gate={gate} current={current} patch={patch} onDetails={onDetails} kind={contextKindForKnowledge(kind)!}/> : kind === "memory" ? <TranslationMemoryView project={project} view={view} drafts={drafts} disabled={disabled} gate={gate} current={current} patch={patch} onDetails={onDetails} onEdit={onEditTranslation} onRevealDraft={onRevealTranslationDraft}/> : <>
        <div className={styles.toolbar}><h1>{t("kinds.terms")}</h1><Button disabled={disabled || blocked || dirty || !localeMatches || !source.data?.currentSnapshot} onClick={newTerm}><Plus/>{t("newTerm")}</Button><Button disabled={terms.isFetching} onClick={() => void terms.refetch()}>{t("refresh")}</Button></div>
        {!localeMatches ? <Banner tone="warning" action={<Button onClick={() => { if (current()) patch({ locale }); }}>{t("returnToLanguage", { locale })}</Button>}>{t("retainedLanguage", { locale })}</Banner> : null}
        {!localeAvailable ? <Banner tone="warning">{t("localeUnavailable", { locale })}</Banner> : null}
        {failure && !owner.state.typedLastActionKey && !owner.state.knowledgeLastActionKey ? <Banner tone="error">{t("saveFailed")}<CommandFailureDetails failure={failure}/></Banner> : null}
        {selectedTerm && currentTerm.error ? <Banner tone="warning" action={<Button onClick={() => void currentTerm.refetch()}>{t("refresh")}</Button>}>{t("currentFailed")}</Banner> : null}
        {notice === "saved" || notice === "savedNewer" || notice === "decisionSaved" ? <Banner tone="success" role="status">{t(notice === "savedNewer" && dirty ? "savedNewer" : notice === "decisionSaved" ? "decisionSaved" : "saved")}</Banner> : null}
        {pending?.kind === "term" ? <Banner tone="warning" role="status" action={<div className={styles.actions}>
          <Button disabled={disabled || busyMutation} onClick={() => { if (current()) void owner.checkPending(); }}>{t("checkAction")}</Button>
          {owner.state.pendingCheckedMissing ? <Button disabled={disabled || busyMutation} onClick={() => { if (current()) void owner.retryPending(); }}>{t("retryAction")}</Button> : null}</div>}>{t(busyMutation ? "saving" : "unknown")}</Banner> : null}
        <div className={styles.scroll}>
          {terms.isPending && terms.isFetching ? <LoadingState label={t("readingTerms")}/> : terms.error ? <ErrorState title={t("termsFailed")} action={<Button onClick={() => void (terms.isFetchNextPageError ? terms.fetchNextPage() : terms.refetch())}>{t("refresh")}</Button>}/> : null}
          {terms.isSuccess || editorVisible ? <table className={styles.table} aria-label={t("termTable")}><thead><tr><th>{t("sourceTerm")}</th><th>{t("targetTerm")}</th><th>{t("scope")}</th><th>{t("source")}</th></tr></thead><tbody>
            {editorVisible && (!selectedTerm || !!terms.error || !rows.some(row => row.termId === selectedTerm.termId && !row.removed)) ? values(selectedTerm) : null}
            {!terms.error ? rows.filter(row => !row.removed).map(row => <Fragment key={row.termId}>{values(row)}</Fragment>) : null}
          </tbody></table> : null}
          {fresh && rows.filter(row => !row.removed).length === 0 && !editorVisible ? <EmptyState title={t("noTerms")} description={t("noTermsHelp")}/> : null}
          <p className={styles.help}>{t("referencesUnknown")}</p>
          {source.isSuccess && !source.data?.currentSnapshot ? <p className={styles.help}>{t("noSource")}</p> : source.error ? <Banner tone="error" action={<Button onClick={() => void source.refetch()}>{t("refresh")}</Button>}>{t("sourceFailed")}</Banner> : null}
          {terms.hasNextPage ? <div className={styles.toolbar}><Button disabled={terms.isFetching} onClick={() => void terms.fetchNextPage()}>{t("moreTerms")}</Button></div> : null}
          <TermProposalPanel project={project} owner={owner} disabled={disabled} gate={gate} viewId={view.id} current={current} target={resourceTarget} onReturnToDecisions={onReturnToDecisions}/>
        </div>
      </>}
      {kind !== "terms" && (dirty || pending && pending.kind !== "typed-context" && pending.kind !== "knowledge-decision") ? <Banner tone="warning" action={<Button onClick={() => { if (current()) patch({ preset: "terms" }); }}>{t("backToDraft")}</Button>}>{t("draftKept")}</Banner> : null}
    </section>
  </div>;
}
