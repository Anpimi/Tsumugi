import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
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
import type { CandidateOwners } from "../candidates/candidateTypes";
import { readEntryDetails } from "./entryReads";
import styles from "../../WorkbenchLayout.module.css";
import local from "./EntryDetails.module.css";

const EntriesCandidates = lazy(() => import("../candidates/EntriesCandidates"));
const tabs = ["detail", "context", "candidates", "issues", "history"] as const;
interface Props {
  project: ProjectView; view: WorkspaceView | null; locale: string; disabled: boolean; visible: boolean;
  drafts: TranslationDrafts | null; owners: CandidateOwners | null; commands: WorkbenchCommands | null; gate: InteractionGate;
  patch: (patch: ViewPatch) => void; onEdit: (unitId: string, locale: string) => Promise<boolean>;
}
export default function EntryDetails({ project, view, locale, disabled, visible, drafts, owners, commands, gate, patch, onEdit }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const reads = useSessionReads(), unitId = view?.focus ?? null;
  const query = useSessionQuery({ key: ["workbench-entry-details", unitId, locale], scopes: ["source", "translation", "resources", "review"],
    enabled: !!unitId && !!locale && visible && !disabled, read: () => { if (!unitId) throw new Error("No entry selected"); return readEntryDetails(reads, unitId, locale); } });
  if (!unitId || !view) return <EmptyState icon={<FileText />} title={t("chooseEntry")} description={t("chooseEntryHelp")} />;
  if (query.isError) return <ErrorState title={t("readFailed")} description={t("readFailedHelp")} action={<Button disabled={disabled} onClick={() => void query.refetch()}>{t("refresh")}</Button>} />;
  if (!query.data) return <LoadingState label={t("loadingDetails")} />;
  const { target, context, terms } = query.data, decision = target.currentDecision, check = target.currentCheck;
  const review = !decision ? t("noCurrentReview") : decision.basis !== target.basis ? t("needsReview") : decision.kind === "approve" ? t("approved") : t("changesRequested");
  const checkStatus = !check ? t("noCurrentCheck") : check.basis !== target.basis ? t("checkOutdated") : t(`checkOutcome.${check.outcome}`);
  const candidatePanel = view.detailTab === "candidates" || view.detailTab === "history";
  return <TabsRoot className={local.root} value={view.detailTab} onValueChange={value => {
    const tab = tabs.find(item => item === value); if (tab) patch({ detailTab: tab, candidateInitialRevisionId: null });
  }}>
    <TabsList className={local.tabs} aria-label={t("entryDetailsTabs")}>{tabs.map(tab => <TabsTrigger key={tab} value={tab}>{t(tab === "context" ? "entryContextTab" : tab)}</TabsTrigger>)}</TabsList>
    <TabsContent value="detail" className={styles.details}>
      <h2>{t("detail")}</h2><span className={styles.key}>{target.nativeKey}</span>
      <dl><div><dt>{t("selectedTranslation")}</dt><dd>{target.selectionId === null ? t("noTranslation") : t("selected")}</dd></div>
        <div><dt>{t("humanReview")}</dt><dd>{review}</dd></div><div><dt>{t("ruleChecks")}</dt><dd>{checkStatus}</dd></div>
        <div><dt>{t("context")}</dt><dd>{target.termConflict ? t("termConflict") : t("noTermConflict")}</dd></div>
        <div><dt>{t("entrySourceRevision")}</dt><dd className={styles.key}>{target.sourceRevisionId}</dd></div></dl>
      <p className={styles.meta}>{t("factsHelp")}</p>
      <h3>{t("source", { locale: "" })}</h3><p className={local.text}><TokenizedText text={target.sourceText} /></p>
      <h3>{t("translation", { locale })}</h3><p className={local.text}>{target.translationText === null ? t("noTranslation") : target.translationText === "" ? t("editorEmptySelection") : <TokenizedText text={target.translationText} />}</p>
    </TabsContent>
    <TabsContent value="context" className={styles.details}>
      <h2>{t("context")}</h2><p className={local.text}>{context ? <TokenizedText text={context.text} /> : t("entryContextEmpty")}</p>
      <h3>{t("entryTerms")}</h3>{terms.entries.length ? <dl>{terms.entries.map(term => <div key={term.source}>
        <dt><TokenizedText text={term.source}/></dt><dd>{term.selected ? <TokenizedText text={term.selected.target}/> : t("termConflict")}
          {term.conflicting.map(conflict => <p key={conflict.revisionId}><TokenizedText text={conflict.target}/></p>)}</dd>
      </div>)}</dl> : <p>{t("entryTermsEmpty")}</p>}
    </TabsContent>
    <TabsContent value="issues" className={styles.details}>
      <h2>{t("issues")}</h2><p>{review}</p><p>{checkStatus}</p>
      {decision?.reason ? <p className={local.text}><TokenizedText text={decision.reason}/></p> : null}
      {check ? <ul className={local.findings}>{check.rules.flatMap(rule => rule.findings).map(finding => <li key={finding.issueId} className={local.text}><TokenizedText text={finding.detail}/></li>)}</ul> : null}
      {target.termConflict ? <p>{t("termConflict")}</p> : null}
      <Button disabled={disabled || query.isFetching || !gate.canDispatch({ viewId: view.id, source: "button" })} onClick={() => { void onEdit(unitId, locale); }}>{t("entryFixTranslation")}</Button>
    </TabsContent>
    {candidatePanel ? <TabsContent value={view.detailTab} className={local.candidates}>
      {drafts && owners && commands ? <Suspense fallback={<LoadingState label={t("candidateLoading")} />}><EntriesCandidates project={project} target={target} drafts={drafts} owners={owners} commands={commands} gate={gate} viewId={view.id}
        disabled={disabled || query.isFetching} visible={visible} mode={view.detailTab === "history" ? "history" : "candidates"} afterOrdinal={view.candidateAfterOrdinal}
        onPage={after => patch({ candidateAfterOrdinal: after, candidateInitialRevisionId: null })} onEdit={onEdit} initialRevisionId={view.candidateInitialRevisionId}/></Suspense>
        : <LoadingState label={t("candidateLoading")} />}
    </TabsContent> : null}
  </TabsRoot>;
}
