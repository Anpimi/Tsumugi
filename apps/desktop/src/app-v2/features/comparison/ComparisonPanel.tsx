import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { ComparisonView } from "../../../arenaCommands";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { translationCommands, type TranslationRevision } from "../../../translationCommands";
import { Button } from "../../../design-system/Button";
import { Banner, EmptyState, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { ArenaCompareCommandPayload, ArenaOpenComparisonCommandPayload, ArenaRevealCommandPayload, CommandAvailability, TranslationMergeStageCommandPayload, TranslationStageCommandPayload, WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { TranslationDrafts } from "../editor/translationDrafts";
import { candidateDraftKey, candidateStagePayload, canStageCandidate, sameCandidateCapture } from "../candidates/candidateActions";
import { candidateHistoryKey, candidateReadCurrent, candidateReadProof, useCandidateHistory } from "../candidates/candidateReads";
import { comparisonDraftReady, comparisonRevisionKey, comparisonTargetCurrent, mergeStagePayload, sameMergeStage } from "./comparisonActions";
import ComparisonRecovery from "./ComparisonRecovery";
import { ComparisonSession, comparisonListKey, comparisonReadKey } from "./ComparisonSession";
import styles from "./Comparison.module.css";

export interface ComparisonPanelProps {
  project: ProjectView; target: ReviewTarget; drafts: TranslationDrafts; owner: ComparisonSession; commands: WorkbenchCommands; gate: InteractionGate;
  viewId: string | null; disabled: boolean; visible: boolean; parentDialogId?: string; comparisonId: string | null;
  revisionIds: readonly string[]; blind: boolean; afterOrdinal: string;
  onReferences: (ids: string[]) => void; onBlind: (blind: boolean) => void; onPage: (after: string) => void;
  onOpenComparison: (view: ComparisonView) => Promise<boolean>; onBack: () => void; onSetup: () => void;
  onEdit: (unitId: string, locale: string) => Promise<boolean>;
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
type Feedback = "candidateStaged" | "candidateStageBlocked" | "candidateStageUndurable" | "comparisonActionFailed";

export default function ComparisonPanel({ project, target, drafts, owner, commands, gate, viewId, disabled, visible, parentDialogId,
  comparisonId, revisionIds, blind, afterOrdinal, onReferences, onBlind, onPage, onOpenComparison, onBack, onSetup, onEdit }: ComparisonPanelProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), { t: legacy } = useTranslation(), reads = useSessionReads();
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot), snapshot = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const scope = { ...executionContext(project), area: "translation" as const }, key = candidateDraftKey(scope.projectId, target), entry = drafts.getEntry(key);
  const identity = JSON.stringify([scope.projectId, scope.sessionToken, viewId, target.unitId, target.locale, target.sourceSnapshotId,
    target.sourceRevisionId, target.sourceText, target.selectionId, target.revisionId, target.translationText, target.basis, comparisonId, revisionIds, blind, afterOrdinal]);
  const mounted = useRef(true), live = useRef({ identity, visible, disabled, viewId, parentDialogId });
  const region = useRef<HTMLElement>(null), [busy, setBusy] = useState(false), [editSeq, setEditSeq] = useState(0);
  const [feedback, setFeedback] = useState<{ identity: string; key: Feedback } | null>(null);
  useLayoutEffect(() => { live.current = { identity, visible, disabled, viewId, parentDialogId }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const present = () => visible && !disabled && mounted.current && !reads.retired && !snapshot.retired && !state.retired
    && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const stillPresent = () => present() && live.current.identity === identity && live.current.visible && !live.current.disabled
    && live.current.viewId === viewId && live.current.parentDialogId === parentDialogId;
  const history = useCandidateHistory(target, afterOrdinal, visible && !disabled && comparisonId === null);
  const saved = useSessionQuery({ key: comparisonListKey, scopes: ["arena", "project", "source", "translation"], enabled: visible && !disabled,
    read: () => owner.list(), refetchOnMount: true });
  const comparison = useSessionQuery({ key: comparisonReadKey(comparisonId ?? ""), scopes: ["arena", "source", "translation", "resources", "project"],
    enabled: visible && !disabled && !!comparisonId, read: () => { if (!comparisonId) throw new Error("No comparison selected"); return owner.read(comparisonId); }, refetchOnMount: true });
  const view = comparison.data?.comparisonId === comparisonId ? comparison.data : null;
  const revisionKey = comparisonRevisionKey(view);
  const revisions = useSessionQuery({ key: revisionKey, scopes: ["translation", "source", "review", "arena"],
    enabled: visible && !disabled && !!view && !comparison.isFetching && !comparison.error,
    read: async () => {
      if (!view) throw new Error("No comparison revisions");
      return Promise.all(view.rows.map(row => translationCommands.revision({ ...executionContext(project), unitId: view.unitId, locale: view.locale, revisionId: row.revisionId })));
    }, refetchOnMount: true });
  useEffect(() => {
    if (visible && !disabled && snapshot.hydration === "ready" && !drafts.getEntry(key)) void drafts.open(key);
  }, [drafts, key.projectId, key.unitId, key.locale, visible, disabled, snapshot.hydration]);
  const focusIdentity = JSON.stringify([viewId, comparisonId, target.unitId, target.locale]);
  const focusTicket = useRef({ identity: focusIdentity, input: gate.getSnapshot().inputOwner, seq: entry?.value?.editSeq ?? null, done: false });
  useLayoutEffect(() => {
    if (focusTicket.current.identity !== focusIdentity) focusTicket.current = { identity: focusIdentity, input: gate.getSnapshot().inputOwner,
      seq: drafts.getEntry(key)?.value?.editSeq ?? null, done: false };
    const ticket = focusTicket.current;
    if (ticket.done || !present() || comparisonId !== null && !view) return;
    const seq = drafts.getEntry(key)?.value?.editSeq ?? null;
    ticket.done = true;
    if (!stillPresent() || gate.getSnapshot().inputOwner !== ticket.input || seq !== ticket.seq && !(ticket.seq === null && seq === "0")) return;
    region.current?.focus(); region.current?.scrollIntoView?.({ block: "nearest" });
  }, [focusIdentity, view !== null, visible, disabled]);
  const browse = (): CommandAvailability => present() && !busy ? { enabled: true } : unavailable;
  const mutation = (): CommandAvailability => browse().enabled && !state.busy && !state.pending && snapshot.hydration === "ready" && !snapshot.mutationReserved ? { enabled: true } : unavailable;
  const createInput = (): ArenaCompareCommandPayload => ({ kind: "arena-compare", unitId: target.unitId, locale: target.locale, revisionIds: [...revisionIds], blind, editSeq });
  function createAvailability(input: ArenaCompareCommandPayload | undefined): CommandAvailability {
    const expected = createInput();
    return comparisonId === null && mutation().enabled && !!input && input.unitId === expected.unitId && input.locale === expected.locale
      && input.blind === expected.blind && input.editSeq === expected.editSeq && input.revisionIds.length >= 2 && input.revisionIds.length <= 4
      && new Set(input.revisionIds).size === input.revisionIds.length && input.revisionIds.length === expected.revisionIds.length
      && input.revisionIds.every((id, index) => id === expected.revisionIds[index]) && candidateReadCurrent(reads, candidateHistoryKey(target, afterOrdinal), history.data)
      ? { enabled: true } : unavailable;
  }
  function openAvailability(input: ArenaOpenComparisonCommandPayload | undefined): CommandAvailability {
    return browse().enabled && !!input && candidateReadCurrent(reads, comparisonListKey, saved.data)
      && !!saved.data?.some(row => row.comparisonId === input.comparisonId && row.nativeKey === input.nativeKey && row.locale === input.locale) ? { enabled: true } : unavailable;
  }
  const realRevision = (id: string) => revisions.data?.find(revision => revision.revisionId === id);
  const stageInput = (revision: TranslationRevision) => candidateStagePayload(drafts.getEntry(key), target, { kind: "revision", value: revision });
  function comparisonReady() {
    return mutation().enabled && !!view && comparisonTargetCurrent(view, target) && candidateReadCurrent(reads, comparisonReadKey(comparisonId ?? ""), view)
      && candidateReadCurrent(reads, revisionKey, revisions.data) && !!revisions.data && revisions.data.length === view.rows.length;
  }
  function stageAvailability(input: TranslationStageCommandPayload | undefined): CommandAvailability {
    const revision = input?.evidence.kind === "revision" ? realRevision(input.evidence.revisionId) : undefined;
    const row = revision && view?.rows.find(candidate => candidate.revisionId === revision.revisionId);
    return comparisonReady() && !!revision && !!row && row.text === revision.text && row.sourceRevisionId === target.sourceRevisionId && row.candidateDisposition !== "rejected"
      && sameCandidateCapture(input, stageInput(revision)) && canStageCandidate(drafts.getEntry(key), target, { kind: "revision", value: revision }) ? { enabled: true } : unavailable;
  }
  function mergeInput(id: string): TranslationMergeStageCommandPayload | null {
    const revision = realRevision(id); return view && revision ? mergeStagePayload(stageInput(revision), view, id) : null;
  }
  function mergeAvailability(input: TranslationMergeStageCommandPayload | undefined): CommandAvailability {
    return comparisonReady() && !!view && !!input && sameMergeStage(input, mergeInput(input.initialRevisionId)) && comparisonDraftReady(drafts.getEntry(key), target)
      && view.rows.every(row => row.basisCurrent && row.sourceRevisionId === target.sourceRevisionId && row.candidateDisposition !== "rejected") ? { enabled: true } : unavailable;
  }
  function revealAvailability(input: ArenaRevealCommandPayload | undefined): CommandAvailability {
    return mutation().enabled && !!view && !!input && input.targetKind === "comparison" && input.targetId === view.comparisonId && view.blind && !view.revealed
      && candidateReadCurrent(reads, comparisonReadKey(input.targetId), view) ? { enabled: true } : unavailable;
  }
  async function create(input: ArenaCompareCommandPayload) {
    const proof = candidateReadProof(reads, candidateHistoryKey(target, afterOrdinal), history.data); setBusy(true);
    try {
      await owner.create({ unitId: input.unitId, locale: input.locale, revisionIds: input.revisionIds, blind: input.blind }, () => stillPresent() && proof.current());
      const result = owner.current();
      if (!stillPresent() || !result.comparisonId || result.pending || result.notice !== "created" && result.notice !== "creation-confirmed") return;
      const opened = await owner.read(result.comparisonId);
      if (stillPresent() && !await onOpenComparison(opened) && stillPresent()) setFeedback({ identity, key: "comparisonActionFailed" });
    } catch { if (stillPresent()) setFeedback({ identity, key: "comparisonActionFailed" }); }
    finally { proof.dispose(); if (mounted.current) setBusy(false); }
  }
  async function open(input: ArenaOpenComparisonCommandPayload) {
    setBusy(true);
    try { const opened = await owner.read(input.comparisonId); if (stillPresent() && !await onOpenComparison(opened) && stillPresent()) setFeedback({ identity, key: "comparisonActionFailed" }); }
    catch { if (stillPresent()) setFeedback({ identity, key: "comparisonActionFailed" }); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function stage(input: TranslationStageCommandPayload | TranslationMergeStageCommandPayload) {
    if (!view) return;
    const revisionId = input.kind === "translation-merge-stage" ? input.initialRevisionId : input.evidence.kind === "revision" ? input.evidence.revisionId : null;
    const revision = revisionId ? realRevision(revisionId) : undefined; if (!revision) return;
    const viewProof = candidateReadProof(reads, comparisonReadKey(view.comparisonId!), view), revisionProof = candidateReadProof(reads, revisionKey, revisions.data);
    setBusy(true);
    try {
      const proof = () => stillPresent() && viewProof.current() && revisionProof.current(), expected = { editSeq: input.draftEditSeq, basis: input.draftBasis };
      const result = input.kind === "translation-merge-stage" ? await drafts.stageMerge(key, view, revision.text, expected, proof)
        : await owner.stage(view, revision, expected, proof);
      if (!stillPresent()) return;
      setFeedback({ identity, key: !result.staged ? "candidateStageBlocked" : !result.durable ? "candidateStageUndurable" : "candidateStaged" });
      const current = drafts.getEntry(key)?.value;
      if (result.staged && result.durable && current?.editSeq === (BigInt(input.draftEditSeq) + 1n).toString() && current.text === revision.text
        && !await onEdit(target.unitId, target.locale) && stillPresent()) setFeedback({ identity, key: "comparisonActionFailed" });
    } catch { if (stillPresent()) setFeedback({ identity, key: "comparisonActionFailed" }); }
    finally { viewProof.dispose(); revisionProof.dispose(); if (mounted.current) setBusy(false); }
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const metadata = { category: "translation" as const, scope, binding: null, confirmation: "none" as const };
    const remove = [
      commands.register({ ...metadata, id: "arena.compare-saved", nameKey: "arena.compare", risk: "captures-arena", payloadKind: "arena-compare", availability: createAvailability, handler: input => { void create(input); } }),
      commands.register({ ...metadata, id: "arena.open-saved", nameKey: "arena.reopen", risk: "reads-arena", payloadKind: "arena-open-comparison", availability: openAvailability, handler: input => { void open(input); } }),
      commands.register({ ...metadata, id: "arena.reveal-saved", nameKey: "arena.reveal", risk: "writes-arena", payloadKind: "arena-reveal", availability: revealAvailability, handler: () => {
        if (!view) return; const proof = candidateReadProof(reads, comparisonReadKey(view.comparisonId!), view);
        void owner.reveal(view, () => stillPresent() && proof.current()).catch(() => {
          if (stillPresent()) setFeedback({ identity, key: "comparisonActionFailed" });
        }).finally(proof.dispose);
      } }),
      commands.register({ ...metadata, id: "arena.stage-compared", nameKey: "translation.addCandidate", risk: "writes-translation", payloadKind: "translation-stage", availability: stageAvailability, handler: input => { void stage(input); } }),
      commands.register({ ...metadata, id: "arena.stage-merge", nameKey: "arena.manualMerge", risk: "writes-translation", payloadKind: "translation-merge-stage", availability: mergeAvailability, handler: input => { void stage(input); } }),
      commands.register({ ...metadata, id: "arena.saved-list-refresh", nameKey: "action.refresh", risk: "reads-arena", availability: browse, handler: () => { void Promise.all([saved.refetch(), comparisonId ? comparison.refetch() : history.refetch(), ...(view ? [revisions.refetch()] : []), drafts.open(key)]); } }),
      commands.register({ ...metadata, id: "arena.return-candidates", nameKey: "action.cancel", risk: "changes-view", availability: browse, handler: onBack }),
      commands.register({ ...metadata, id: "arena.setup-saved", nameKey: "arena.chooseCandidates", risk: "changes-view", availability: browse, handler: onSetup }),
      commands.register({ ...metadata, id: "arena.first-saved-page", nameKey: "workbenchV2.firstPage", risk: "changes-view", availability: () => browse().enabled && afterOrdinal !== "0" && comparisonId === null ? { enabled: true } : unavailable, handler: () => onPage("0") }),
      commands.register({ ...metadata, id: "arena.next-saved-page", nameKey: "workbenchV2.nextPage", risk: "changes-view", availability: () => browse().enabled && comparisonId === null && history.data?.nextOrdinal != null && candidateReadCurrent(reads, candidateHistoryKey(target, afterOrdinal), history.data) ? { enabled: true } : unavailable, handler: () => { if (history.data?.nextOrdinal != null) onPage(history.data.nextOrdinal); } }),
    ];
    return () => remove.forEach(dispose => dispose());
  });
  const dispatch = (id: "arena.saved-list-refresh" | "arena.return-candidates" | "arena.setup-saved" | "arena.first-saved-page" | "arena.next-saved-page") => commands.dispatch(id, scope);
  const text = (value: string | null) => value === null ? t("editorNoSelection") : value === "" ? t("editorEmptySelection") : <TokenizedText text={value} />;
  const dirty = !!entry?.value && (!!entry.value.merge || entry.value.text !== (entry.value.basis.text ?? ""));
  return <section ref={region} tabIndex={-1} className={styles.panel} aria-label={t("comparisonTitle")}>
    <header className={styles.header}><h2>{t("comparisonTitle")}</h2><div className={styles.actions}>
      <Button size="sm" disabled={!browse().enabled} onClick={() => dispatch("arena.return-candidates")}>{t("comparisonBack")}</Button>
      <Button size="sm" disabled={!browse().enabled} onClick={() => dispatch("arena.saved-list-refresh")}>{t("comparisonRefresh")}</Button>
    </div></header>
    <ComparisonRecovery project={project} owner={owner} commands={commands} gate={gate} viewId={viewId} disabled={disabled} visible={visible} parentDialogId={parentDialogId} variant="panel" />
    {feedback?.identity === identity ? <Banner tone={feedback.key === "candidateStaged" ? "success" : "warning"} role="status">{t(feedback.key)}</Banner> : null}
    {state.failure ? <Banner tone="error">{t("comparisonActionFailed")}</Banner> : null}
    {dirty ? <Banner>{t("comparisonDirty")}</Banner> : null}
    {comparisonId === null ? <>
      <h3>{t("comparisonSetup")}</h3><p className={styles.meta}>{t("comparisonSetupHelp")}</p>
      <label className={styles.check}><input type="checkbox" checked={blind} disabled={!mutation().enabled} onChange={event => { if (!mutation().enabled) return; setEditSeq(value => value + 1); onBlind(event.currentTarget.checked); }} />{t("comparisonBlind")}</label>
      <p className={styles.meta}>{t("comparisonBlindHelp")}</p>
      <p role="status">{t("comparisonSelectedCount", { count: revisionIds.length })}</p><p className={styles.meta}>{t("comparisonAcrossPages")}</p>
      {history.isError ? <Banner tone="error">{t("comparisonReadFailed")}</Banner> : !history.data ? <LoadingState label={t("candidateLoading")} /> : null}
      {history.data?.rows.length === 0 && !history.isFetching ? <EmptyState title={t("candidateEmpty")} /> : null}
      <ul className={styles.choices}>{history.data?.rows.map((revision, index) => <li className={styles.choice} key={revision.revisionId}>
        <label className={styles.check}><input type="checkbox" checked={revisionIds.includes(revision.revisionId)} disabled={!mutation().enabled || !candidateReadCurrent(reads, candidateHistoryKey(target, afterOrdinal), history.data) || !revisionIds.includes(revision.revisionId) && revisionIds.length >= 4}
          onChange={event => { if (!mutation().enabled) return; setEditSeq(value => value + 1); onReferences(event.currentTarget.checked ? [...revisionIds, revision.revisionId] : revisionIds.filter(id => id !== revision.revisionId)); }} />{t("comparisonChoice", { number: String(index + 1) })}</label>
        <div className={styles.text}>{text(revision.text)}</div>
        {!blind ? <p className={styles.meta}>{legacy(revision.originKind === "ai" ? "ai.origin" : revision.originKind === "manual" ? "translation.manualOrigin" : "resource.imported")}</p> : null}
      </li>)}</ul>
      <div className={styles.actions}><Button variant="primary" pending={state.busy} disabled={!createAvailability(createInput()).enabled} onClick={() => commands.dispatch("arena.compare-saved", scope, createInput())}>{t("comparisonCreate")}</Button>
        {afterOrdinal !== "0" ? <Button disabled={!browse().enabled} onClick={() => dispatch("arena.first-saved-page")}>{t("firstPage")}</Button> : null}
        {history.data?.nextOrdinal != null ? <Button disabled={!browse().enabled || history.isFetching} onClick={() => dispatch("arena.next-saved-page")}>{t("nextPage")}</Button> : null}</div>
    </> : <>
      {!view && !comparison.error ? <LoadingState label={t("candidateLoading")} /> : null}
      {comparison.error ? <Banner tone="error">{t("comparisonReadFailed")}</Banner> : null}
      {view ? <>
        <section className={styles.source}><h3>{t("comparisonSource")}</h3><div className={styles.text}>{text(view.sourceText)}</div>
          <h3>{t("comparisonCurrent")}</h3><div className={styles.text}>{text(view.selectedText)}</div></section>
        {view.blind && !view.revealed ? <div><p className={styles.meta}>{t("comparisonRevealHelp")}</p><Button disabled={!revealAvailability({ kind: "arena-reveal", targetKind: "comparison", targetId: view.comparisonId! }).enabled}
          onClick={() => commands.dispatch("arena.reveal-saved", scope, { kind: "arena-reveal", targetKind: "comparison", targetId: view.comparisonId! })}>{t("comparisonReveal")}</Button></div> : <p role="status" className={styles.meta}>{t("comparisonRevealed")}</p>}
        {revisions.error ? <Banner tone="warning">{t("comparisonRevisionReadFailed")}</Banner> : null}
        <p className={styles.meta}>{t("comparisonMergeHelp")}</p>
        <div className={styles.columns}>{view.rows.map((row, index) => {
          const revision = realRevision(row.revisionId), payload = revision ? stageInput(revision) : null, merge = mergeInput(row.revisionId);
          return <article className={styles.column} key={row.revisionId} data-ai={view.revealed && row.originKind === "ai" || undefined} aria-label={t("comparisonCandidate", { label: String.fromCharCode(65 + index) })}>
            <h4>{t("comparisonCandidate", { label: String.fromCharCode(65 + index) })}</h4><div className={styles.text}>{text(row.text)}</div>
            <p className={styles.meta}>{t(row.basisCurrent ? "comparisonCurrentSource" : "comparisonStaleSource")}</p>
            {row.revisionId === view.selectedRevisionId ? <p className={styles.meta}>{t("candidateCurrent")}</p> : null}
            {row.candidateDisposition === "rejected" ? <p className={styles.meta}>{t("candidateRejected")}</p> : null}
            {view.revealed ? <p className={styles.meta}>{row.model ?? legacy(row.originKind === "ai" ? "ai.origin" : row.originKind === "manual" ? "translation.manualOrigin" : "resource.imported")} {row.recipe}</p> : null}
            <div className={styles.actions}><Button size="sm" disabled={!payload || !stageAvailability(payload).enabled} onClick={() => { if (payload) commands.dispatch("arena.stage-compared", scope, payload); }}>{t("candidateAdopt")}</Button>
              <Button size="sm" disabled={!merge || !mergeAvailability(merge).enabled} onClick={() => { if (merge) commands.dispatch("arena.stage-merge", scope, merge); }}>{t("comparisonStageMerge")}</Button></div>
          </article>;
        })}</div>
      </> : null}
      <Button disabled={!browse().enabled} onClick={() => dispatch("arena.setup-saved")}>{t("comparisonSetup")}</Button>
    </>}
    <section><h3>{t("comparisonSavedList")}</h3>{saved.error ? <Banner tone="error">{t("comparisonReadFailed")}</Banner> : !saved.data ? <LoadingState label={t("candidateLoading")} /> : saved.data.length === 0 ? <EmptyState title={t("comparisonEmpty")} /> : null}
      <ul className={styles.saved}>{saved.data?.map(summary => {
        const input: ArenaOpenComparisonCommandPayload = { ...summary, kind: "arena-open-comparison" };
        return <li key={summary.comparisonId}><Button disabled={!openAvailability(input).enabled} onClick={() => commands.dispatch("arena.open-saved", scope, input)}>{t("comparisonOpenSaved", { name: summary.nativeKey, locale: summary.locale })}</Button></li>;
      })}</ul>
    </section>
  </section>;
}
