import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { conversationCommands } from "../../../conversationCommands";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "../../../CommandFailure";
import { executionContext } from "../../../executionCommands";
import { knowledgeProposalComparison, knowledgeProposalDirty, knowledgeProposalTarget } from "../../../knowledgeProposalDrafts";
import { jsonIdentity } from "../../../pluginToolChoices";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Banner, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { ConversationKnowledgeEntries } from "../assistant/ConversationKnowledgeEntries";
import { planningUnitLabels, validKnowledgeName, validKnowledgeText } from "../assistant/proposalDraft";
import type { ConversationKnowledgeProposalRef } from "../assistant/conversationNavigation";
import type { KnowledgeViewProps } from "./KnowledgeView";
import ContextResourceScope, { ContextScopeText } from "./ContextResourceScope";
import { contextSourceKey, resourceCurrentKey, sameContentScope, useContextResourceCurrent, useContextResourcePages, useContextSource } from "./contextResourceReads";
import { knowledgeBlocked } from "./knowledgeState";
import { useKnowledgeScope } from "./knowledgeReads";
import styles from "./Knowledge.module.css";

export interface KnowledgeReviewTarget { proposal: ConversationKnowledgeProposalRef; entryIndex: number | null }
export default function KnowledgeProposalPanel({ project, owner, view, disabled, gate, current, patch, target, onOpened }: KnowledgeViewProps & {
  target: KnowledgeReviewTarget | null; onOpened?: () => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" }), reads = useSessionReads(), session = executionContext(project);
  const active = owner.state.knowledgeActiveKey ? owner.state.knowledgeDrafts[owner.state.knowledgeActiveKey] : null;
  const proposal = target?.proposal ?? active?.proposal ?? null;
  const revisionKey = ["knowledge-proposal-version", proposal], latestKey = ["knowledge-proposal-head", proposal?.conversationId, proposal?.proposalId];
  const revision = useSessionQuery({ key: revisionKey, scopes: ["project"], enabled: !!proposal,
    read: () => { if (!proposal) throw new Error("A saved knowledge proposal is required"); return conversationCommands.readProposal({ ...session, ...proposal }); } });
  const latest = useSessionQuery({ key: latestKey, scopes: ["project"], enabled: !!proposal,
    read: () => { if (!proposal) throw new Error("A saved knowledge proposal is required"); return conversationCommands.readProposal({ ...session, ...proposal, revisionId: null }); } });
  const origin = revision.data?.origin;
  const original = useSessionQuery({ key: ["knowledge-proposal-origin", proposal?.conversationId, origin?.attemptId], scopes: ["project", "execution"], enabled: !!proposal && !!origin,
    read: async () => { if (!proposal || !origin) throw new Error("A proposal origin is required"); const run = await conversationCommands.readPlanning({ ...session, conversationId: proposal.conversationId, attemptId: origin.attemptId });
      if (!run || run.resultId !== origin.resultId || run.preview.purpose !== "knowledge" || run.preview.scope.kind !== "units") throw new Error("Invalid knowledge proposal origin"); return run; } });
  const draft = active && proposal && jsonIdentity(active.proposal) === jsonIdentity(proposal) ? active : null;
  const kind = draft?.entry.kind ?? "character", locale = draft?.locale ?? view.locale;
  const content = revision.data?.content.kind === "knowledge-proposal" ? revision.data.content : null;
  const scope = original.data?.preview.scope, labels = planningUnitLabels(original.data?.preview.input ?? "");
  const targetTicket = useRef<KnowledgeReviewTarget | null>(null);
  useEffect(() => {
    if (!target || targetTicket.current === target || !revision.data || !content || scope?.kind !== "units") return;
    const index = target.entryIndex ?? 0;
    if (!content.entries[index]) return;
    const key = owner.knowledgeProposals.begin(revision.data, index, scope.locale);
    if (key) { targetTicket.current = target; const entry = content.entries[index]; patch({ preset: entry.kind === "character" ? "characters" : entry.kind, locale: scope.locale }); onOpened?.(); }
  }, [target, revision.data, content, scope, owner, patch, onOpened]);
  const decisionKey = ["knowledge-proposal-decision", draft?.proposal, draft?.entryIndex];
  const decision = useSessionQuery({ key: decisionKey, scopes: ["project", "resources"], enabled: !!draft,
    read: () => { if (!draft) throw new Error("A knowledge proposal entry is required"); return conversationCommands.readKnowledgeDecision({ ...session, proposal: draft.proposal, entryIndex: draft.entryIndex }); } });
  const { source, files } = useContextSource(project, !!proposal);
  const rows = useContextResourcePages(project, locale, kind, !!draft && project.metadata.targetLocales.includes(locale));
  const observed = useContextResourceCurrent(project, draft?.destination === "update" ? draft.target?.contextId ?? null : null, !!draft, { kind, locale });
  const scopeEntry = useKnowledgeScope(project, locale, draft?.scope?.kind === "unit" ? draft.scope.unitId : null, !!draft);
  const [search, setSearch] = useState(""), [comparing, setComparing] = useState(false), [readFailure, setReadFailure] = useState<CommandFailure | null>(null), [originalOpen, setOriginalOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ action: "adopt" | "discard"; key: string; sequence: number } | null>(null);
  const inputOwner = useId(), dialogId = useId(), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; gate.releaseOwner(inputOwner); }; }, [gate, inputOwner]);
  useLayoutEffect(() => confirmation ? gate.pushDialog(dialogId) : undefined, [confirmation, dialogId, gate]);
  function fresh(key: readonly unknown[]) { const state = reads.client.getQueryState(reads.key(key)); return state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated; }
  function sourceFresh() { return source.isSuccess && !source.error && !source.isFetching && fresh(contextSourceKey); }
  function filesFresh() { return sourceFresh() && files.isSuccess && !files.error && !files.isFetching && !!files.data && !!source.data
    && sameContentScope(files.data.scope, source.data) && fresh(["knowledge-context-files", source.data.currentSnapshot, source.data.revision]); }
  const pending = owner.state.pending?.kind === "knowledge-decision" ? owner.state.pending : null;
  const recorded = pending?.draftKey === draft?.key ? draft?.receipt : draft?.receipt ?? decision.data;
  const headChanged = !!revision.data && !!latest.data && revision.data.revisionId !== latest.data.revisionId;
  const currentSource = source.data;
  const sourceChanged = !!currentSource && !!original.data && original.data.preview.units.some(unit => unit.sourceSnapshotId !== currentSource.currentSnapshot);
  const changed = !!draft?.preview && (!source.data || !sameContentScope(source.data, draft.preview.sourceBasis)
    || draft.destination === "update" && observed.isSuccess && observed.data?.revisionId !== draft.preview.current?.revisionId);
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  const validAudit = !!draft && !!draft.actor.trim() && !!draft.reason.trim() && !draft.actor.includes("\0") && !draft.reason.includes("\0") && bytes(draft.actor) <= 512 && bytes(draft.reason) <= 4096;
  const fieldError = (value: string, limit: number) => value && !value.trim() ? t("requiredValue") : value.includes("\0") || bytes(value) > limit ? t("contextFieldLong") : undefined;
  function proof(adopt = false, modal?: string) {
    if (!draft || !live.current || disabled || !current(modal) || recorded || headChanged || !fresh(revisionKey) || !fresh(latestKey) || !fresh(decisionKey)) return false;
    if (!adopt) return true;
    return !!draft.preview && !changed && !sourceChanged && sourceFresh() && !!source.data?.currentSnapshot && !content?.questions.length && validKnowledgeName(draft.name) && validKnowledgeText(draft.text)
      && (draft.destination !== "update" || !!draft.target && fresh(resourceCurrentKey(draft.target.contextId)) && !observed.error && !observed.isFetching)
      && (!draft.preview.requiresWiderConfirmation || draft.confirmWiderScope);
  }
  async function compare() {
    if (!draft || !draft.destination || !draft.scope || draft.destination !== "new" && !draft.target || knowledgeBlocked(owner) || !proof() || !sourceFresh()) return;
    const expected = knowledgeProposalComparison(draft), key = draft.key;
    setComparing(true); setReadFailure(null);
    try {
      const preview = await conversationCommands.prepareKnowledgeAdoption({ ...session, adoption: { proposal: draft.proposal, entryIndex: draft.entryIndex, scope: draft.scope, ...knowledgeProposalTarget(draft) } });
      if (live.current && current()) owner.knowledgeProposals.compare(key, preview, expected);
    } catch (cause) { if (live.current) setReadFailure(commandFailure(cause)); }
    finally { if (live.current) setComparing(false); }
  }
  if (!proposal) return null;
  const select = (index: number) => { if (!current() || !revision.data || !content || scope?.kind !== "units") return; const key = owner.knowledgeProposals.begin(revision.data, index, scope.locale);
    if (key) patch({ preset: content.entries[index].kind === "character" ? "characters" : content.entries[index].kind, locale: scope.locale }); };
  return <section className={styles.rowEditor} aria-label={t("reviewTitle")} onFocusCapture={() => gate.setInputOwner(view.id, inputOwner)}
    onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
    <h2>{t("reviewTitle")}</h2><p>{t("reviewHelp")}</p>
    {revision.error || original.error || latest.error ? <ErrorState title={t("reviewReadFailed")} action={<Button onClick={() => { void revision.refetch(); void latest.refetch(); void original.refetch(); }}>{t("refresh")}</Button>}/>
      : !content || !original.data || !draft ? <LoadingState label={t("reviewReading")}/> : null}
    {content ? <><p>{content.summary}</p><nav className={styles.actions} aria-label={t("reviewItems")}>{content.entries.map((entry, index) => <Button key={index} aria-current={draft?.entryIndex === index ? "page" : undefined}
      onClick={() => select(index)}>{t("reviewItem", { number: index + 1, name: entry.name })}</Button>)}</nav></> : null}
    {headChanged ? <Banner tone="warning">{t("reviewHeadChanged")}</Banner> : null}
    {sourceChanged ? <Banner tone="warning">{t("reviewSourceChanged")}</Banner> : null}
    {content?.questions.length ? <Banner tone="warning">{t("reviewQuestions")}<ul>{content.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></Banner> : null}
    <Button aria-expanded={originalOpen} aria-controls={`${inputOwner}-origin`} onClick={() => setOriginalOpen(value => !value)}>{t("reviewOriginal")}</Button>
    <div id={`${inputOwner}-origin`} hidden={!originalOpen}>{original.data?.output ? <><p>{original.data.output.model.summary}</p>{original.data.output.model.kind === "knowledge-proposal" ? <ConversationKnowledgeEntries entries={original.data.output.model.entries}/> : null}</> : null}</div>
    {draft ? <><h3>{t("reviewProposed")}</h3><p>{draft.entry.name}</p><pre className={styles.sourceText}>{draft.entry.text}</pre>
      <p>{t("reviewEvidence")}</p><ul>{draft.entry.unitIds.map((unitId, index) => <li key={unitId}>{labels.get(unitId)?.key || t("reviewEvidenceNumber", { number: index + 1 })}</li>)}</ul>
      <h3>{t("reviewDestination")}</h3><div className={styles.actions}>{(["new", "update", "variant"] as const).map(destination => <Button key={destination} aria-pressed={draft.destination === destination} disabled={disabled || !!recorded}
        onClick={() => { if (current()) owner.knowledgeProposals.edit(draft.key, { destination, target: null, scope: null }); }}>{t(`reviewDestinationKinds.${destination}`)}</Button>)}</div>
      {draft.destination && draft.destination !== "new" ? <><Field label={t("reviewFindResource")}><TextInput value={search} onChange={event => setSearch(event.target.value)}/></Field>
        {rows.isFetching && !rows.data ? <LoadingState label={t("contextReading")}/> : null}
        {rows.error ? <ErrorState title={t("contextReadFailed")} action={<Button onClick={() => void rows.refetch()}>{t("refresh")}</Button>}/> : null}
        <ul className={styles.scopeResults}>{rows.data?.pages.flatMap(page => page.rows).filter(row => row.name.includes(search)).map(row => <li key={row.contextId}>
          <Button disabled={disabled || !!recorded || rows.isFetching || !!rows.error} aria-pressed={draft.target?.contextId === row.contextId} onClick={() => {
            if (current() && !rows.isFetching && !rows.error && fresh(["knowledge-context-list", locale, kind])) owner.knowledgeProposals.edit(draft.key, { target: row, scope: draft.destination === "update" ? row.scope : null }); }}>{row.name}</Button><ContextScopeText scope={row.scope}/>
        </li>)}</ul>{rows.hasNextPage ? <Button disabled={rows.isFetching} onClick={() => void rows.fetchNextPage()}>{t("contextMore")}</Button> : null}<p>{t("reviewFindHelp")}</p></> : null}
      {source.error || files.error ? <Banner tone="warning" action={<Button onClick={() => { void source.refetch(); void files.refetch(); }}>{t("refresh")}</Button>}>{t("contextSourceFailed")}</Banner> : null}
      {source.data ? <ContextResourceScope project={project} locale={locale} value={draft.scope ?? { kind: "project" }} unselected={!draft.scope} basis={draft.preview?.sourceBasis ?? source.data}
        source={source.data} files={files.data} fresh={filesFresh} failed={!!source.error || !!files.error} onRefresh={() => { void source.refetch(); void files.refetch(); }} disabled={disabled || !!recorded || !draft.destination}
        gate={gate} current={current} onChange={scope => owner.knowledgeProposals.edit(draft.key, { scope })}/> : null}
      {draft.scope?.kind === "unit" ? <p>{scopeEntry.data?.nativeKey ?? t("scopeUnavailable")}</p> : null}
      <div className={styles.fields}><Field label={t("reviewName")} required error={fieldError(draft.name, 512)}><TextInput value={draft.name} readOnly={disabled} onChange={event => owner.knowledgeProposals.edit(draft.key, { name: event.target.value })}/></Field>
        <Field label={t("contextActor")} required error={fieldError(draft.actor, 512)}><TextInput value={draft.actor} readOnly={disabled} onChange={event => owner.knowledgeProposals.edit(draft.key, { actor: event.target.value })}/></Field>
        <Field label={t("reason")} required error={fieldError(draft.reason, 4096)}><TextInput value={draft.reason} readOnly={disabled} onChange={event => owner.knowledgeProposals.edit(draft.key, { reason: event.target.value })}/></Field>
        <Field label={t("reviewText")} required error={fieldError(draft.text, 16384)}><TextArea rows={5} value={draft.text} readOnly={disabled} onChange={event => owner.knowledgeProposals.edit(draft.key, { text: event.target.value })}/></Field></div>
      <Button disabled={disabled || knowledgeBlocked(owner) || comparing || !!recorded || !draft.destination || !draft.scope || draft.destination !== "new" && !draft.target || !proof() || !sourceFresh() || sourceChanged || !!content?.questions.length}
        pending={comparing} onClick={() => { void compare(); }}>{t("reviewCompare")}</Button>
      {draft.preview?.current ? <section className={styles.compare} aria-label={t("comparison")}><h3>{t("reviewCurrent")}</h3><p>{draft.preview.current.name}</p><pre className={styles.sourceText}>{draft.preview.current.text}</pre><ContextScopeText scope={draft.preview.current.scope}/></section> : draft.preview ? <p>{t("reviewNewConfirmed")}</p> : null}
      {changed ? <Banner tone="warning">{t("reviewComparisonChanged")}</Banner> : null}
      {draft.preview?.requiresWiderConfirmation ? <Field label={t("reviewWiderConfirm")} description={t("reviewWiderHelp")}><TextInput type="checkbox" checked={draft.confirmWiderScope} disabled={disabled || !!recorded}
        onChange={event => owner.knowledgeProposals.edit(draft.key, { confirmWiderScope: event.target.checked })}/></Field> : null}
      {recorded ? <Banner tone="success"><p>{t(`reviewDecisions.${recorded.decision}`)}</p><p>{recorded.actor} · {recorded.reason}</p>{recorded.resource ? <><p>{recorded.resource.name}</p><pre className={styles.sourceText}>{recorded.resource.text}</pre><ContextScopeText scope={recorded.resource.scope}/></> : null}
        {knowledgeProposalDirty(draft) ? <p>{t("reviewNewerKept")}</p> : null}</Banner> : null}
      {decision.error ? <ErrorState title={t("reviewReadFailed")} action={<Button onClick={() => void decision.refetch()}>{t("refresh")}</Button>}/> : null}
      {readFailure || draft.failure || owner.state.knowledgeLastActionKey === draft.key && owner.state.failure ? <Banner tone="error"><p>{t("reviewFailed")}</p><CommandFailureDetails failure={readFailure ?? draft.failure ?? owner.state.failure}/></Banner> : null}
      <div className={styles.actions}><Button variant="primary" disabled={knowledgeBlocked(owner) || !validAudit || !proof(true)} onClick={() => setConfirmation({ action: "adopt", key: draft.key, sequence: draft.editSeq })}>{t("reviewAdopt")}</Button>
        <Button disabled={knowledgeBlocked(owner) || !validAudit || !proof()} onClick={() => { if (proof()) void owner.knowledgeProposals.decide(draft.key, "keep", () => proof()); }}>{t("reviewKeep")}</Button>
        <Button disabled={knowledgeBlocked(owner) || !validAudit || !proof()} onClick={() => { if (proof()) void owner.knowledgeProposals.decide(draft.key, "reject", () => proof()); }}>{t("reviewReject")}</Button>
        <Button disabled={knowledgeBlocked(owner)} onClick={() => { if (current()) setConfirmation({ action: "discard", key: draft.key, sequence: draft.editSeq }); }}>{t("reviewDiscard")}</Button></div>
    </> : null}
    {pending ? <Banner tone="warning" action={<div className={styles.actions}><Button disabled={owner.state.busyMutation || disabled} onClick={() => { if (current()) void owner.checkPending(); }}>{t("checkAction")}</Button>
      {owner.state.pendingCheckedMissing ? <Button disabled={owner.state.busyMutation || disabled} onClick={() => { if (current()) void owner.retryPending(); }}>{t("retryAction")}</Button> : null}</div>}>
      {t(owner.state.busyMutation ? "reviewSaving" : owner.state.pendingRecorded ? "contextRecordFound" : "contextUnknown")}</Banner> : null}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }} title={t(confirmation?.action === "discard" ? "reviewDiscardTitle" : "reviewConfirmTitle")} closeLabel={t("close")}
      footer={<><Button onClick={() => setConfirmation(null)}>{t("proposalCancel")}</Button><Button variant={confirmation?.action === "discard" ? "danger" : "primary"}
        disabled={!draft || !confirmation || draft.key !== confirmation.key || draft.editSeq !== confirmation.sequence || knowledgeBlocked(owner)} onClick={() => {
          if (!draft || !confirmation || draft.key !== confirmation.key || draft.editSeq !== confirmation.sequence || !current(dialogId)) return;
          if (confirmation.action === "discard") { owner.knowledgeProposals.discard(draft.key); setConfirmation(null); }
          else if (proof(true, dialogId)) { setConfirmation(null); void owner.knowledgeProposals.decide(draft.key, "adopt", () => proof(true, dialogId)); }
        }}>{t(confirmation?.action === "discard" ? "reviewDiscard" : "reviewAdopt")}</Button></>}>
      <p>{t(confirmation?.action === "discard" ? "reviewDiscardHelp" : "reviewConfirmHelp")}</p><p>{draft?.name}</p>{draft?.scope ? <ContextScopeText scope={draft.scope}/> : null}
    </Dialog>
  </section>;
}
