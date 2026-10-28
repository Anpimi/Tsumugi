import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { resourceCommands, type TranslationMemoryReusePreview } from "../../../resourceCommands";
import { reviewCommands } from "../../../reviewCommands";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { sameDraftBasis } from "../../../draftCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Field, TextInput } from "../../../design-system/Field";
import { Menu } from "../../../design-system/Menu";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { InteractionGate } from "../../workspace/interactionGate";
import { emptyTranslationMemoryPresentation, type WorkspaceView, type ViewPatch } from "../../workspace/workspaceStore";
import type { MemoryStageCapture, TranslationDrafts } from "../editor/translationDrafts";
import { candidateReadCurrent, candidateReadProof } from "../candidates/candidateReads";
import TermScopePicker from "./TermScopePicker";
import { MemoryEntryEvidence } from "./TranslationMemoryDetails";
import { memoryEntryKey, memoryPageKey, useMemoryEntry, useTranslationMemory } from "./translationMemoryReads";
import styles from "./Knowledge.module.css";

type OpenEditor = (unitId: string, locale: string) => Promise<boolean>;
export default function TranslationMemoryView({ project, view, drafts, disabled, gate, current, patch, onDetails, onEdit, onRevealDraft }: {
  project: ProjectView; view: WorkspaceView; drafts: TranslationDrafts | null; disabled: boolean; gate: InteractionGate;
  current: (dialogId?: string) => boolean; patch: (patch: ViewPatch) => void; onDetails: () => void; onEdit?: OpenEditor;
  onRevealDraft?: (unitId: string, locale: string) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" }), { t: global } = useTranslation(), reads = useSessionReads();
  const state = view.translationMemory ?? emptyTranslationMemoryPresentation();
  const filter = { ...state.filter, sourceLocale: project.metadata.sourceLocale, targetLocale: view.locale };
  const validSearchField = (value: string) => new TextEncoder().encode(value).length <= 512 && !value.includes("\0");
  const validSourceSearch = validSearchField(state.sourceInput), validTranslationSearch = validSearchField(state.translationInput), validSearch = validSourceSearch && validTranslationSearch;
  const localeAvailable = project.metadata.targetLocales.includes(view.locale), available = !disabled && localeAvailable;
  const page = useTranslationMemory(project, filter, available), donor = useMemoryEntry(project, state.donor, available);
  const pages = page.data?.pages ?? [], rows = pages.flatMap(value => value.rows);
  const pageMatches = pages.length > 0 && pages.every(value => value.basis === pages[0].basis)
    && new Set(rows.map(row => row.revision.revisionId)).size === rows.length;
  const pageCurrent = () => page.isSuccess && !page.isFetching && !page.error && !page.isStale && pageMatches && candidateReadCurrent(reads, memoryPageKey(filter), page.data);
  const pageFresh = pageCurrent();
  const patchMemory = (change: Partial<typeof state>) => patch({ translationMemory: { ...state, ...change } });
  return <>
    <form className={styles.toolbar} onSubmit={event => { event.preventDefault(); if (!current() || !available || !validSearch) return;
      patchMemory({ filter: { ...state.filter, sourceText: state.sourceInput || null, translationText: state.translationInput || null } }); }}>
      <h1>{t("kinds.memory")}</h1>
      <Field label={t("memorySourceSearch")} error={!validSourceSearch ? t("memorySearchLimit") : undefined}><TextInput value={state.sourceInput} readOnly={disabled} onChange={event => patchMemory({ sourceInput: event.target.value })}/></Field>
      <Field label={t("memoryTranslationSearch")} error={!validTranslationSearch ? t("memorySearchLimit") : undefined}><TextInput value={state.translationInput} readOnly={disabled} onChange={event => patchMemory({ translationInput: event.target.value })}/></Field>
      <Menu label={t("memoryOrigin")} trigger={<Button disabled={!available}>{state.filter.origin ? global(state.filter.origin === "ai" ? "workbenchV2.candidateAi" : state.filter.origin === "import" ? "resource.imported" : "resource.manual") : t("memoryAllOrigins")}</Button>}
        items={[{ id: "all", label: t("memoryAllOrigins"), onSelect: () => { if (current()) patchMemory({ filter: { ...state.filter, origin: null } }); } },
          ...(["manual", "ai", "import"] as const).map(origin => ({ id: origin, label: global(origin === "ai" ? "workbenchV2.candidateAi" : origin === "import" ? "resource.imported" : "resource.manual"),
            onSelect: () => { if (current()) patchMemory({ filter: { ...state.filter, origin } }); } }))]}/>
      <Menu label={t("memorySelection")} trigger={<Button disabled={!available}>{t(`memorySelections.${state.filter.selection}`)}</Button>}
        items={(["all", "current", "historical"] as const).map(selection => ({ id: selection, label: t(`memorySelections.${selection}`), onSelect: () => { if (current()) patchMemory({ filter: { ...state.filter, selection } }); } }))}/>
      <Button type="submit" disabled={!available || !validSearch}>{t("search")}</Button><Button disabled={!available || page.isFetching} onClick={() => { if (current()) void page.refetch(); }}>{t("refresh")}</Button>
    </form>
    <p className={styles.help}>{t("memoryHelp")}</p>
    {!localeAvailable ? <Banner tone="warning">{t("localeUnavailable", { locale: view.locale })}</Banner> : null}
    <div className={styles.scroll}>
      {page.isFetching && !page.data ? <LoadingState label={t("memoryReading")}/> : page.error || page.data && !pageMatches ? <ErrorState title={t("memoryFailed")} action={<Button onClick={() => void (page.isFetchNextPageError ? page.fetchNextPage() : page.refetch())}>{t("refresh")}</Button>}/>
        : page.data ? <table className={styles.table} aria-label={t("memoryTable")}><thead><tr><th>{t("memoryDonorSource")}</th><th>{t("memoryDonorTranslation")}</th><th>{t("source")}</th><th>{t("memoryReview")}</th></tr></thead><tbody>
          {rows.map(row => <tr key={row.revision.revisionId} data-selected={state.donor?.revisionId === row.revision.revisionId || undefined}>
            <td><Button variant="link" disabled={!pageFresh || !available} onClick={() => { if (current() && pageCurrent()) patchMemory({ donor: { unitId: row.revision.unitId, locale: row.revision.locale, revisionId: row.revision.revisionId } }); }}>{row.sourceLabel.nativeKey}</Button><p className={styles.meta}>{row.sourceLabel.namespace}</p><p className={styles.sourceText}>{row.sourceText}</p></td>
            <td className={styles.sourceText}>{row.revision.text}</td><td>{t(row.isCurrentSelection ? "memorySelected" : "memoryHistorical")}<p>{t("memoryVersion", { number: row.revision.ordinal })}</p></td>
            <td>{t(row.quality.currentApproval ? "memoryCurrentApproval" : row.quality.pastApproval ? "memoryPastApproval" : "memoryNeverApproved")}<Button size="xs" disabled={!pageFresh || !available} onClick={() => { if (current() && pageCurrent()) { patchMemory({ donor: { unitId: row.revision.unitId, locale: row.revision.locale, revisionId: row.revision.revisionId } }); onDetails(); } }}>{t("details")}</Button></td>
          </tr>)}
        </tbody></table> : null}
      {pageFresh && !rows.length ? <EmptyState title={t("memoryEmpty")}/> : null}
      {page.hasNextPage ? <div className={styles.toolbar}><Button disabled={!pageFresh || !available} onClick={() => { if (current() && pageCurrent()) void page.fetchNextPage(); }}>{t("memoryMore")}</Button></div> : null}
      {state.donor ? <MemoryReuse project={project} view={view} drafts={drafts} disabled={!available} gate={gate} current={current} onEdit={onEdit}
        donor={donor} onTarget={targetUnitId => patchMemory({ targetUnitId })} onRevealDraft={onRevealDraft}/> : <p className={styles.help}>{t("memoryChoose")}</p>}
    </div>
  </>;
}

function MemoryReuse({ project, view, drafts, disabled, gate, current, onEdit, donor, onTarget, onRevealDraft }: {
  project: ProjectView; view: WorkspaceView; drafts: TranslationDrafts | null; disabled: boolean; gate: InteractionGate;
  current: (dialogId?: string) => boolean; onEdit?: OpenEditor; donor: ReturnType<typeof useMemoryEntry>; onTarget: (unitId: string) => void;
  onRevealDraft?: (unitId: string, locale: string) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" }), reads = useSessionReads(), session = executionContext(project), dialogId = useId();
  const draftState = useSyncExternalStore(drafts?.subscribe ?? (() => () => {}), drafts?.getSnapshot ?? (() => null), drafts?.getSnapshot ?? (() => null));
  const targetId = view.translationMemory?.targetUnitId ?? null, donorRef = view.translationMemory?.donor ?? null;
  const targetKey = ["knowledge-memory-target", targetId, view.locale] as const;
  const target = useSessionQuery({ key: targetKey, scopes: ["source", "translation", "review", "resources"], enabled: !disabled && !!targetId,
    read: () => { if (!targetId) throw new Error("A translation target is required"); return reviewCommands.editorSnapshot({ ...session, unitId: targetId, locale: view.locale }); } });
  const key = targetId ? { projectId: session.projectId, unitId: targetId, locale: view.locale } : null;
  const draft = key ? drafts?.getEntry(key) : null;
  useEffect(() => { if (!disabled && drafts && targetId && draftState?.hydration === "ready") void drafts.open({ projectId: session.projectId, unitId: targetId, locale: view.locale }); }, [drafts, draftState?.hydration, disabled, targetId, view.locale, session.projectId]);
  const targetValue = target.data?.target, original = donor.data;
  const previewKey = ["knowledge-memory-comparison", original?.basis, targetValue?.basis, donorRef, targetId, view.locale] as const;
  const preview = useSessionQuery({ key: previewKey, scopes: ["source", "translation", "review", "resources"], enabled: !disabled && !!original && !!targetValue && donorRef?.locale === view.locale,
    read: () => {
      if (!original || !targetValue) throw new Error("An original version and target are required");
      return resourceCommands.prepareTranslationMemoryReuse({ ...session, reuse: { projectId: session.projectId,
        unitId: targetValue.unitId, locale: targetValue.locale, sourceRevisionId: targetValue.sourceRevisionId,
        expectedSelectionId: targetValue.selectionId, donorUnitId: original.revision.unitId, donorRevisionId: original.revision.revisionId, donorBasis: original.basis } });
    } });
  const [confirmation, setConfirmation] = useState<{ identity: string; preview: TranslationMemoryReusePreview; capture: MemoryStageCapture } | null>(null);
  type Feedback = "memoryStageBlocked" | "memoryStageUndurable" | "memoryStaged" | "memoryNavigationFailed";
  const [feedbackState, setFeedbackState] = useState<{ identity: string; message: Feedback } | null>(null), [busy, setBusy] = useState(false);
  const identity = JSON.stringify([view.id, donorRef, targetId, view.locale]), latest = useRef(identity), mounted = useRef(true), releaseDialog = useRef<(() => void) | null>(null);
  const feedback = feedbackState?.identity === identity ? feedbackState.message : null;
  const setFeedback = (message: Feedback | null) => setFeedbackState(message ? { identity, message } : null);
  useLayoutEffect(() => { latest.current = identity; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { if (!confirmation || confirmation.identity !== identity) return; const release = gate.pushDialog(dialogId); releaseDialog.current = release; return () => { release(); if (releaseDialog.current === release) releaseDialog.current = null; }; }, [confirmation, identity, gate, dialogId]);
  const fresh = () => !disabled && !busy && !!onEdit && !!drafts && !!key && !!draft?.value && !draft.value.pending && !draft.busy && !draft.failure && !draft.currentFailure && draft.basisCurrent
    && donorRef?.locale === view.locale && !donor.isStale && !target.isStale && !preview.isStale && !!preview.data && !!targetValue && !!original && sameDraftBasis(draft.value.basis, { sourceRevisionId: targetValue.sourceRevisionId, selectionId: targetValue.selectionId, revisionId: targetValue.revisionId, text: targetValue.translationText })
    && candidateReadCurrent(reads, memoryEntryKey(donorRef), original) && candidateReadCurrent(reads, targetKey, target.data) && candidateReadCurrent(reads, previewKey, preview.data);
  const ready = fresh(), matches = !!preview.data && !!original && !!targetValue && jsonIdentity(preview.data.donor) === jsonIdentity(original) && jsonIdentity(preview.data.target) === jsonIdentity(targetValue);
  async function stage(selected: TranslationMemoryReusePreview, capture: MemoryStageCapture, parentDialogId?: string) {
    if (!drafts || !key || !onEdit || !current(parentDialogId) || !fresh() || !matches) return;
    const proofs = [candidateReadProof(reads, memoryEntryKey(donorRef), original), candidateReadProof(reads, targetKey, target.data), candidateReadProof(reads, previewKey, preview.data)];
    setBusy(true); setFeedback(null);
    const present = () => mounted.current && latest.current === identity && current(parentDialogId) && proofs.every(proof => proof.current());
    try {
      const result = await drafts.stageMemoryReuse(key, selected, capture, present);
      if (!mounted.current || latest.current !== identity) return;
      setFeedback(!result.staged ? "memoryStageBlocked" : !result.durable ? "memoryStageUndurable" : "memoryStaged");
      if (result.staged && result.durable && present()) {
        releaseDialog.current?.(); releaseDialog.current = null; setConfirmation(null);
        if (!await onEdit(key.unitId, key.locale) && mounted.current && latest.current === identity) setFeedback("memoryNavigationFailed");
      }
    } catch { if (mounted.current && latest.current === identity) setFeedback("memoryStageBlocked"); }
    finally { proofs.forEach(proof => proof.dispose()); if (mounted.current) setBusy(false); }
  }
  function requestStage() {
    if (!current() || !fresh() || !matches || !draft?.value || !preview.data) return;
    const capture: MemoryStageCapture = { editSeq: draft.value.editSeq, basis: structuredClone(draft.value.basis), text: draft.value.text,
      reuseOrigin: draft.value.reuseOrigin, merge: draft.value.merge };
    if (capture.text !== (capture.basis.text ?? "") || capture.merge || capture.reuseOrigin) setConfirmation({ identity, preview: structuredClone(preview.data), capture });
    else void stage(preview.data, capture);
  }
  function refresh() { if (!current()) return; void Promise.all([donor.refetch(), target.refetch(), preview.refetch(), ...(drafts && key ? [drafts.open(key)] : [])]); }
  function openDraft() { if (!current() || !key) return; if (onRevealDraft) onRevealDraft(key.unitId, key.locale); else if (onEdit) void onEdit(key.unitId, key.locale); }
  return <section className={styles.details} aria-label={t("memoryComparison")}>
    {donor.error ? <ErrorState title={t("memoryFailed")} action={<Button onClick={() => void donor.refetch()}>{t("refresh")}</Button>}/> : original ? <MemoryEntryEvidence entry={original}/> : <LoadingState label={t("memoryReading")}/>}
    <TermScopePicker project={project} locale={view.locale} disabled={disabled || busy} gate={gate} current={current} onSelect={onTarget} title={t("memoryChooseTarget")} help={t("memoryTargetHelp")}/>
    {!targetId ? <p>{t("memoryNoTarget")}</p> : target.isFetching || preview.isFetching || !draft ? <LoadingState label={t("memoryCompareReading")}/>
      : target.error || preview.error || draft.failure || draft.currentFailure ? <ErrorState title={t("memoryCompareFailed")} description={<CommandFailureDetails failure={commandFailure(target.error ?? preview.error ?? draft.failure?.cause ?? draft.currentFailure)}/>} action={<Button onClick={refresh}>{t("refresh")}</Button>}/>
        : targetValue ? <><h3>{targetValue.nativeKey}</h3><dl><dt>{t("memoryTargetSource")}</dt><dd><TokenizedText text={targetValue.sourceText}/></dd>
          <dt>{t("memoryTargetTranslation")}</dt><dd>{targetValue.translationText === null ? t("memoryNoSelection") : <TokenizedText text={targetValue.translationText}/>}</dd>
          {draft.value && draft.value.text !== (targetValue.translationText ?? "") ? <><dt>{t("memoryTargetDraft")}</dt><dd><TokenizedText text={draft.value.text}/></dd></> : null}</dl>
          {!ready || !matches ? <Banner tone="warning" action={<Button onClick={refresh}>{t("refresh")}</Button>}>{t("memoryChanged")}</Banner> : null}
        </> : null}
    {draft?.value?.pending ? <Banner tone="warning">{t("memoryTargetPending")}</Banner> : null}
    <p>{t("memoryStageHelp")}</p><div className={styles.actions}><Button variant="primary" disabled={!ready || !matches} pending={busy} onClick={requestStage}>{t("memoryStage")}</Button>
      {key && draft?.value && (onEdit || onRevealDraft) ? <Button disabled={disabled || busy} onClick={openDraft}>{t("memoryOpenDraft")}</Button> : null}</div>
    {feedback ? <Banner tone={feedback === "memoryStaged" ? "success" : "warning"} role="status">{t(feedback)}</Banner> : null}
    <Dialog open={confirmation !== null && confirmation.identity === identity} title={t("memoryReplaceTitle")} description={t("memoryReplaceHelp")} closeLabel={t("close")}
      onOpenChange={open => { if (!open && !busy) setConfirmation(null); }} footer={<><Button disabled={busy} onClick={() => setConfirmation(null)}>{t("memoryKeepDraft")}</Button>
        <Button variant="danger" pending={busy} disabled={!ready || !matches || !confirmation || confirmation.identity !== identity || !draft?.value || confirmation.capture.editSeq !== draft.value.editSeq}
          onClick={() => { if (confirmation) void stage(confirmation.preview, confirmation.capture, dialogId); }}>{t("memoryReplace")}</Button></>}>
      <h3>{t("memoryTargetDraft")}</h3>{confirmation ? <TokenizedText text={confirmation.capture.text}/> : null}<h3>{t("memoryDonorTranslation")}</h3>{confirmation ? <TokenizedText text={confirmation.preview.donor.revision.text}/> : null}
      {confirmation && draft?.value && confirmation.capture.editSeq !== draft.value.editSeq ? <Banner tone="warning">{t("memoryStageBlocked")}</Banner> : null}
      {feedback && feedback !== "memoryStaged" ? <Banner tone="warning" role="status">{t(feedback)}</Banner> : null}
    </Dialog>
  </section>;
}
