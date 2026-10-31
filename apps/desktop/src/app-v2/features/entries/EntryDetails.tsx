import { lazy, Suspense, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import EntryContextResources from "../knowledge/EntryContextResources";
import { FileText } from "lucide-react";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import type { ProjectView } from "../../../projectCommands";
import type { WorkbenchCommands } from "../../../workbenchCommands";
import { EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { Button } from "../../../design-system/Button";
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from "../../../design-system/Tabs";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ViewPatch, WorkspaceView } from "../../workspace/workspaceStore";
import type { TranslationDrafts } from "../editor/translationDrafts";
import type { KnowledgeOwner } from "../knowledge/knowledgeTypes";
import type { CandidateOwners } from "../candidates/candidateTypes";
import type { EntryReviewEditorRequest } from "../review/navigationTypes";
import type { ReviewOwner } from "../review/reviewTypes";
import type { ComparisonSession } from "../comparison/ComparisonSession";
import type { ComparisonView } from "../../../arenaCommands";
import { readEntryDetails } from "./entryReads";
import styles from "../../WorkbenchLayout.module.css";
import local from "./EntryDetails.module.css";

const EntryContextNotes = lazy(() => import("./EntryContextNotes"));
const EntrySourceFacts = lazy(() => import("./EntrySourceFacts"));
const EntryCorrectionTerm = lazy(() => import("./EntryCorrectionTerm"));
const EntriesCandidates = lazy(() => import("../candidates/EntriesCandidates"));
const EntryProtection = lazy(() => import("../candidates/EntryProtection"));
const ComparisonPanel = lazy(() => import("../comparison/ComparisonPanel"));
const EntryReviewPanel = lazy(() => import("../review/EntryReviewPanel"));
const EntryFallbackPanel = lazy(() => import("../review/EntryFallbackPanel"));
const EntrySemanticPanel = lazy(() => import("../review/EntrySemanticPanel"));
const EntryChecksPanel = lazy(() => import("../review/EntryChecksPanel"));
const EntryIssuesPanel = lazy(() => import("../review/EntryIssuesPanel"));
const EntryReviewHistory = lazy(() => import("../review/EntryReviewHistory"));
const tabs = ["detail", "context", "candidates", "issues", "history"] as const;
interface Props {
  project: ProjectView; view: WorkspaceView | null; locale: string; disabled: boolean; visible: boolean;
  drafts: TranslationDrafts | null; owners: CandidateOwners | null; commands: WorkbenchCommands | null; gate: InteractionGate;
  patch: (patch: ViewPatch) => void; onEdit: (unitId: string, locale: string) => Promise<boolean>;
  parentDialogId?: string; comparisonOwner: ComparisonSession | null; requestComparisons: () => void;
  onOpenComparison: (view: ComparisonView) => Promise<boolean>;
  reviewOwner?: ReviewOwner | null;
  knowledgeOwner?: KnowledgeOwner | null;
  onOpenContext?: (unitId: string, locale: string) => Promise<boolean>;
  onOpenTermCapture?: (captureId: string) => Promise<boolean>;
  onReviewEdit?: (request: EntryReviewEditorRequest, proof: () => boolean) => Promise<boolean>;
  onOpenStrategy?: (unitId: string, locale: string) => Promise<boolean>;
  onPresented: (viewId: string, kind: "candidates" | "protection" | "comparison" | "review", visible: boolean) => void;
}
export default function EntryDetails({ project, view, locale, disabled, visible, drafts, owners, commands, gate, patch, onEdit, parentDialogId,
  comparisonOwner, requestComparisons, onOpenComparison, onPresented, reviewOwner, onReviewEdit, onOpenStrategy, knowledgeOwner, onOpenContext, onOpenTermCapture }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const reads = useSessionReads(), unitId = view?.focus ?? null;
  const comparisonButton = useRef<HTMLButtonElement>(null), previousComparison = useRef({ viewId: view?.id, unitId, open: view?.candidateCompareOpen });
  const query = useSessionQuery({ key: ["workbench-entry-details", unitId, locale], scopes: ["source", "translation", "resources", "review"],
    enabled: !!unitId && !!locale && visible && !disabled, read: () => { if (!unitId) throw new Error("No entry selected"); return readEntryDetails(reads, unitId, locale); } });
  useLayoutEffect(() => {
    const previous = previousComparison.current;
    previousComparison.current = { viewId: view?.id, unitId, open: view?.candidateCompareOpen };
    if (previous.open && !view?.candidateCompareOpen && previous.viewId === view?.id && previous.unitId === unitId
      && view?.detailTab === "candidates" && visible && !disabled && gate.canDispatch({ viewId: view.id, source: "button", dialogId: parentDialogId })) comparisonButton.current?.focus();
  }, [view?.id, view?.candidateCompareOpen, view?.detailTab, unitId, visible, disabled, gate, parentDialogId]);
  useLayoutEffect(() => {
    if (!view) return;
    const ready = visible && !!unitId && !!query.data && !query.isError && !!drafts && !!commands;
    onPresented(view.id, "protection", ready && !!owners && view.detailTab === "detail");
    onPresented(view.id, "candidates", ready && !!owners && ["candidates", "history"].includes(view.detailTab) && !view.candidateCompareOpen);
    onPresented(view.id, "comparison", ready && !!comparisonOwner && view.detailTab === "candidates" && view.candidateCompareOpen);
    onPresented(view.id, "review", ready && !!reviewOwner && ["detail", "issues"].includes(view.detailTab));
    return () => { for (const kind of ["protection", "candidates", "comparison", "review"] as const) onPresented(view.id, kind, false); };
  }, [view?.id, view?.detailTab, view?.candidateCompareOpen, visible, unitId, query.data !== undefined, query.isError, drafts, commands, owners, comparisonOwner, reviewOwner !== null && reviewOwner !== undefined, onPresented]);
  if (!unitId || !view) return <EmptyState icon={<FileText />} title={t("chooseEntry")} description={t("chooseEntryHelp")} />;
  if (query.isError) return <ErrorState title={t("readFailed")} description={t("readFailedHelp")} action={<Button disabled={disabled} onClick={() => void query.refetch()}>{t("refresh")}</Button>} />;
  if (!query.data) return <LoadingState label={t("loadingDetails")} />;
  const { target, context, terms } = query.data, decision = target.currentDecision, check = target.currentCheck;
  const review = !decision ? t("noCurrentReview") : decision.basis !== target.basis ? t("needsReview") : decision.kind === "approve" ? t("approved") : t("changesRequested");
  const checkStatus = !check ? t("noCurrentCheck") : check.basis !== target.basis ? t("checkOutdated") : t(`checkOutcome.${check.outcome}`);
  const candidatePanel = view.detailTab === "candidates" || view.detailTab === "history";
  const savedCorrection = query.data.translations.current?.previousEventId != null && query.data.translations.rows.some(row => row.revisionId === target.revisionId && row.originKind === "manual" && row.actionId === query.data?.translations.current?.actionId);
  return <TabsRoot className={local.root} value={view.detailTab} onValueChange={value => {
    const tab = tabs.find(item => item === value); if (tab) patch({ detailTab: tab, candidateInitialRevisionId: null, decisionFinding: null });
  }}>
    <TabsList className={local.tabs} aria-label={t("entryDetailsTabs")}>{tabs.map(tab => <TabsTrigger key={tab} value={tab}>{t(tab === "context" ? "entryContextTab" : tab)}</TabsTrigger>)}</TabsList>
    <TabsContent value="detail" className={styles.details}>
      <h2>{t("detail")}</h2><span className={styles.key}>{target.nativeKey}</span>
      <dl><div><dt>{t("selectedTranslation")}</dt><dd>{target.selectionId === null ? t("noTranslation") : t("selected")}</dd></div>
        <div><dt>{t("humanReview")}</dt><dd>{review}</dd></div><div><dt>{t("ruleChecks")}</dt><dd>{checkStatus}</dd></div>
        <div><dt>{t("context")}</dt><dd>{target.termConflict ? t("termConflict") : t("noTermConflict")}</dd></div>
        <div><dt>{t("entrySourceRevision")}</dt><dd className={styles.key}>{target.sourceRevisionId}</dd></div></dl>
      <p className={styles.meta}>{t("factsHelp")}</p>
      {reviewOwner !== undefined ? reviewOwner && drafts && commands ? <Suspense fallback={<LoadingState label={t("reviewLoading")} />}><EntryReviewPanel project={project} target={target} owner={reviewOwner} drafts={drafts} commands={commands} gate={gate}
        viewId={view.id} disabled={disabled} visible={visible} parentDialogId={parentDialogId} read={{ key: ["workbench-entry-details", unitId, locale], data: query.data }}/>
        <EntryFallbackPanel project={project} target={target} owner={reviewOwner} drafts={drafts} commands={commands} gate={gate}
          viewId={view.id} disabled={disabled} visible={visible} parentDialogId={parentDialogId} read={{ key: ["workbench-entry-details", unitId, locale], data: query.data }}/></Suspense>
        : <LoadingState label={t("reviewLoading")} /> : null}
      {drafts && owners && commands ? <Suspense fallback={<LoadingState label={t("entryProtectionLoading")} />}><EntryProtection project={project} target={target} drafts={drafts} owners={owners} commands={commands} gate={gate}
        viewId={view.id} disabled={disabled} visible={visible} parentDialogId={parentDialogId}/></Suspense> : null}
      <h3>{t("source", { locale: "" })}</h3><p className={local.text}><TokenizedText text={target.sourceText} /></p>
      <h3>{t("translation", { locale })}</h3><p className={local.text}>{target.translationText === null ? t("noTranslation") : target.translationText === "" ? t("editorEmptySelection") : <TokenizedText text={target.translationText} />}</p>
      {knowledgeOwner && drafts ? <Suspense fallback={<LoadingState label={t("loadingDetails")} />}><EntryCorrectionTerm project={project} target={target} owner={knowledgeOwner}
        drafts={drafts} gate={gate} viewId={view.id} disabled={disabled} visible={visible && view.detailTab === "detail"} parentDialogId={parentDialogId}
        read={{ key: ["workbench-entry-details", unitId, locale], data: query.data }} onOpenCapture={onOpenTermCapture}/></Suspense> : null}
      {onOpenStrategy && savedCorrection ? <Button disabled={disabled || !visible} onClick={() => { if (view && gate.canDispatch({ viewId: view.id, source: "button", dialogId: parentDialogId })) void onOpenStrategy(unitId, locale); }}>{t("strategyEntryOpen")}</Button> : null}
    </TabsContent>
    <TabsContent value="context" className={styles.details}>
      <h2>{t("context")}</h2>
      {knowledgeOwner ? <Suspense fallback={<LoadingState label={t("loadingDetails")} />}>
        <EntryContextNotes project={project} target={target} owner={knowledgeOwner} gate={gate} viewId={view.id} disabled={disabled}
          visible={visible && view.detailTab === "context"} parentDialogId={parentDialogId} onOpenEntry={onOpenContext}/>
        <EntrySourceFacts project={project} target={target} owner={knowledgeOwner} gate={gate} viewId={view.id} disabled={disabled}
          visible={visible && view.detailTab === "context"} parentDialogId={parentDialogId} onOpenEntry={onOpenContext}/>
      </Suspense> : <p className={local.text}>{context ? <TokenizedText text={context.text} /> : t("entryContextEmpty")}</p>}
      <EntryContextResources project={project} target={target} visible={visible && view.detailTab === "context"}/>
      <h3>{t("entryTerms")}</h3>{terms.entries.length ? <dl>{terms.entries.map(term => <div key={term.source}>
        <dt><TokenizedText text={term.source}/></dt><dd>{term.selected ? <TokenizedText text={term.selected.target}/> : t("termConflict")}
          {term.conflicting.map(conflict => <p key={conflict.revisionId}><TokenizedText text={conflict.target}/></p>)}</dd>
      </div>)}</dl> : <p>{t("entryTermsEmpty")}</p>}
    </TabsContent>
    <TabsContent value="issues" className={styles.details}>
      <h2>{t("issues")}</h2><p>{review}</p><p>{checkStatus}</p>
      {decision?.reason ? <p className={local.text}><TokenizedText text={decision.reason}/></p> : null}
      {target.termConflict ? <p>{t("termConflict")}</p> : null}
      {reviewOwner !== undefined ? reviewOwner && drafts && commands ? <Suspense fallback={<LoadingState label={t("reviewLoading")} />}><EntryReviewPanel project={project} target={target} owner={reviewOwner} drafts={drafts} commands={commands} gate={gate}
        viewId={view.id} disabled={disabled} visible={visible} parentDialogId={parentDialogId} read={{ key: ["workbench-entry-details", unitId, locale], data: query.data }}/></Suspense>
        : <LoadingState label={t("reviewLoading")} /> : null}
      {reviewOwner && drafts && commands ? <Suspense fallback={<LoadingState label={t("reviewLoading")} />}>
        <EntryChecksPanel project={project} target={target} owner={reviewOwner} drafts={drafts} commands={commands} gate={gate}
          viewId={view.id} disabled={disabled} visible={visible} parentDialogId={parentDialogId} read={{ key: ["workbench-entry-details", unitId, locale], data: query.data }}/>
        <EntryIssuesPanel project={project} target={target} owner={reviewOwner} drafts={drafts} commands={commands} gate={gate}
          viewId={view.id} disabled={disabled} visible={visible && view.detailTab === "issues"} parentDialogId={parentDialogId} initialFinding={view.decisionFinding}
          read={{ key: ["workbench-entry-details", unitId, locale], data: query.data }} onEdit={() => { void onEdit(unitId, locale); }} onReviewEdit={onReviewEdit}/>
        <EntryFallbackPanel project={project} target={target} owner={reviewOwner} drafts={drafts} commands={commands} gate={gate}
          viewId={view.id} disabled={disabled} visible={visible} parentDialogId={parentDialogId} read={{ key: ["workbench-entry-details", unitId, locale], data: query.data }}/>
        <EntrySemanticPanel project={project} target={target} owner={reviewOwner} drafts={drafts} commands={commands} gate={gate}
          viewId={view.id} disabled={disabled} visible={visible} parentDialogId={parentDialogId} read={{ key: ["workbench-entry-details", unitId, locale], data: query.data }}/>
      </Suspense> : null}
    </TabsContent>
    {candidatePanel ? <TabsContent value={view.detailTab} className={local.candidates}>
      {view.detailTab === "history" && commands ? <Suspense fallback={<LoadingState label={t("reviewLoading")} />}><EntryReviewHistory project={project} target={target} commands={commands} gate={gate}
        viewId={view.id} disabled={disabled || query.isFetching} visible={visible} parentDialogId={parentDialogId} offset={view.reviewHistoryOffset} onOffset={offset => patch({ reviewHistoryOffset: offset })}/></Suspense> : null}
      {view.detailTab === "candidates" && !view.candidateCompareOpen ? <Button ref={comparisonButton} size="sm" disabled={disabled || !gate.canDispatch({ viewId: view.id, source: "button", dialogId: parentDialogId })}
        onClick={() => { requestComparisons(); patch({ candidateCompareOpen: true }); }}>{t("comparisonOpen")}</Button> : null}
      {view.detailTab === "candidates" && view.candidateCompareOpen ? drafts && comparisonOwner && commands ? <Suspense fallback={<LoadingState label={t("comparisonLoading")} />}><ComparisonPanel
        project={project} target={target} drafts={drafts} owner={comparisonOwner} commands={commands} gate={gate} viewId={view.id} disabled={disabled} visible={visible} parentDialogId={parentDialogId}
        comparisonId={view.candidateComparisonId} revisionIds={view.candidateCompareRefs} blind={view.candidateCompareBlind} afterOrdinal={view.candidateAfterOrdinal}
        onReferences={ids => patch({ candidateCompareRefs: ids })} onBlind={blind => patch({ candidateCompareBlind: blind })} onPage={after => patch({ candidateAfterOrdinal: after })}
        onOpenComparison={onOpenComparison} onBack={() => patch({ candidateCompareOpen: false })} onSetup={() => patch({ candidateComparisonId: null })} onEdit={onEdit}/></Suspense>
        : <LoadingState label={t("comparisonLoading")} />
        : drafts && owners && commands ? <Suspense fallback={<LoadingState label={t("candidateLoading")} />}><EntriesCandidates project={project} target={target} drafts={drafts} owners={owners} commands={commands} gate={gate} viewId={view.id}
        disabled={disabled || query.isFetching} visible={visible} mode={view.detailTab === "history" ? "history" : "candidates"} afterOrdinal={view.candidateAfterOrdinal} parentDialogId={parentDialogId}
        onPage={after => patch({ candidateAfterOrdinal: after, candidateInitialRevisionId: null })} onEdit={onEdit} initialRevisionId={view.candidateInitialRevisionId}/></Suspense>
        : <LoadingState label={t("candidateLoading")} />}
    </TabsContent> : null}
  </TabsRoot>;
}
