import { useLayoutEffect, useRef, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import type { ReviewSummary, ReviewTarget } from "../../../reviewCommands";
import { executionContext } from "../../../executionCommands";
import { reviewDraftKey } from "../../../ReviewDraftSession";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { Button } from "../../../design-system/Button";
import { TextInput } from "../../../design-system/Field";
import styles from "./EntrySemanticPanel.module.css";
import { Banner } from "../../../design-system/Feedback";
import { copyWorkspaceSelection, workspaceSelectionIds, type WorkspaceSelection } from "../../workspace/workspaceSelection";
import EntrySemanticPanel from "./EntrySemanticPanel";
import { readReviewBatch } from "./reviewBatchReads";
import type { ReviewBatchPanelProps } from "./batchTypes";

export interface SemanticBatchBinding { request: SemanticBatchReadRequest; data: unknown; version: number }
function summary(target: ReviewTarget): ReviewSummary {
  return { ...target, sourcePreview: target.sourceText, translationPreview: target.translationText, currentDecision: target.currentDecision,
    currentCheck: target.currentCheck ? { ...target.currentCheck, hasFindings: target.currentCheck.rules.some(rule => rule.status === "findings"),
      hasIncomplete: target.currentCheck.rules.some(rule => !["passed", "findings", "not-applicable"].includes(rule.status)) } : null };
}
export interface SemanticBatchReadRequest { selection: WorkspaceSelection; locales: string[]; serial: number }

/** The original Review chosen set owns every pair; the query supplies current saved evidence. */
export default function ReviewBatchSemanticPanel({ project, owner, selection, commands, gate, viewId, disabled, open, drafts, request, onRequest, binding, locales, onLocalesChange }: ReviewBatchPanelProps & { request: SemanticBatchReadRequest | null; onRequest: (request: SemanticBatchReadRequest) => void; binding: MutableRefObject<SemanticBatchBinding | null>; locales: readonly string[]; onLocalesChange: (locales: string[]) => void }) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), reads = useSessionReads(), context = executionContext(project);
  const live = useRef(true); useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const present = () => live.current && open && !disabled && !reads.retired && gate.canDispatch({ viewId, source: "button", dialogId: "review-batch" });
  const idle = () => present() && !owner.inFlight() && !owner.current().pending && !owner.current().batchRunning && !owner.current().busyMutation && !owner.semantic.reserved();
  const key = ["review-semantic-batch", request];
  const read = useSessionQuery({ key, scopes: ["source", "translation", "resources", "review"], enabled: open && request !== null,
    structuralSharing: false,
    read: async () => {
      if (!request) throw new Error("No fixed semantic selection");
      const fixed = request, primary = await readReviewBatch({ context, selection: fixed.selection }, () => live.current && !reads.retired);
      const ids = primary.targets.map(target => target.unitId), snapshot = primary.targets[0].sourceSnapshotId;
      const targets = [];
      for (const locale of fixed.locales) {
        const page = locale === primary.targets[0].locale ? primary : await readReviewBatch({ context,
          selection: { kind: "ids", locale, sourceSnapshotId: snapshot, unitIds: ids } }, () => live.current && !reads.retired);
        targets.push(...page.targets);
      }
      if (!live.current || reads.retired) throw new Error("Semantic selection is no longer visible");
      return { targets };
    } });
  const targets = !read.error ? read.data?.targets : undefined;
  function currentRead() {
    const query = reads.client.getQueryState(reads.key(key));
    return !!targets && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null && query.data === read.data;
  }
  function replaceSelection() {
    if (!idle() || read.isFetching) return;
    const fixed = copyWorkspaceSelection(selection), ids = workspaceSelectionIds(fixed);
    if (!fixed || !ids.length || !locales.length || ids.length * locales.length > 100) return;
    // Switching is explicit and never clears a pending approval or AI request.
    if (!owner.endBatch(owner.current().chosen)) return;
    owner.semantic.setMode("chosen");
    onRequest({ selection: fixed, locales: [...locales], serial: (request?.serial ?? 0) + 1 });
  }
  useLayoutEffect(() => {
    if (!targets || !currentRead() || !idle() || owner.semantic.current().mode !== "chosen") return;
    if (!request || binding.current?.request === request && binding.current.data === targets && binding.current.version === read.dataUpdatedAt) return;
    const chosen = Object.values(owner.current().chosen), firstRead = binding.current?.request !== request;
    const keys = new Set(chosen.map(reviewDraftKey));
    binding.current = { request, data: targets, version: read.dataUpdatedAt };
    // A refreshed page updates evidence for the original choices; it never
    // adds a pair that the user explicitly excluded from this fixed capture.
    for (const old of chosen) owner.toggleChosen(old, false);
    for (const target of targets) if (firstRead || keys.has(reviewDraftKey(target))) owner.toggleChosen(summary(target), true);
  }, [targets, read.dataUpdatedAt, owner]);
  const selectedTargets = targets?.filter(target => !!owner.current().chosen[reviewDraftKey(target)]) ?? [];
  const languagesCurrent = !!request && JSON.stringify([...locales].sort()) === JSON.stringify([...request.locales].sort());
  const count = workspaceSelectionIds(selection).length * locales.length;
  return <section className={styles.section} aria-label={t("semanticBatchTitle")}>
    <h3>{t("semanticBatchTitle")}</h3><p>{t("semanticBatchHelp")}</p>
    <fieldset className={styles.configuration} disabled={!idle() || read.isFetching}><legend>{t("semanticBatchLanguages")}</legend>
      {project.metadata.targetLocales.map(locale => <label className={styles.check} key={locale}><TextInput className={styles.checkbox} type="checkbox" checked={locales.includes(locale)}
        onChange={event => { if (idle()) { owner.semantic.setMode("chosen"); onLocalesChange(event.currentTarget.checked ? [...locales, locale] : locales.filter(value => value !== locale)); } }}/>{locale}</label>)}
    </fieldset>
    <p>{t("semanticBatchCount", { count })}</p>
    {count > 100 ? <Banner tone="warning">{t("reviewBatchLimit", { count: 100 })}</Banner> : null}
    <Button disabled={!idle() || read.isFetching || count < 1 || count > 100} onClick={replaceSelection}>{t("semanticBatchCapture")}</Button>
    {read.isFetching ? <p role="status">{t("reviewBatchLoading")}</p> : null}
    {read.error ? <Banner tone="warning" role="alert">{t("reviewBatchReadFailed")}<CommandFailureDetails failure={commandFailure(read.error)}/></Banner> : null}
    {targets?.length ? <fieldset className={styles.configuration} disabled={!idle() || read.isFetching}><legend>{t("semanticBatchPairs")}</legend>
      {targets.map(target => <label className={styles.check} key={reviewDraftKey(target)}><TextInput className={styles.checkbox} type="checkbox" checked={!!owner.current().chosen[reviewDraftKey(target)]}
        onChange={event => { if (idle() && currentRead()) owner.toggleChosen(summary(target), event.target.checked); }}/>{target.nativeKey} → {target.locale}</label>)}
    </fieldset> : null}
    {targets && !languagesCurrent ? <Banner tone="warning">{t("semanticBatchRecapture")}</Banner> : null}
    {selectedTargets.length && drafts ? <EntrySemanticPanel project={project} target={selectedTargets[0]} batchTargets={selectedTargets} owner={owner} drafts={drafts}
      commands={commands} gate={gate} viewId={viewId} disabled={disabled || !languagesCurrent} visible={open} parentDialogId="review-batch" read={{ key, data: read.data }}/>: null}
  </section>;
}
