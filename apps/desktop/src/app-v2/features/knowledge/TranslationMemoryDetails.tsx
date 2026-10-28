import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import type { ProjectView } from "../../../projectCommands";
import type { TranslationMemoryEntry } from "../../../resourceCommands";
import type { WorkspaceView } from "../../workspace/workspaceStore";
import { useMemoryEntry } from "./translationMemoryReads";
import styles from "./Knowledge.module.css";

export function MemoryEntryEvidence({ entry }: { entry: TranslationMemoryEntry }) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" }), { t: global } = useTranslation();
  const { latestDecision, pastApproval, currentApproval } = entry.quality;
  return <>
    <h2>{entry.sourceLabel.nativeKey}</h2><p className={styles.meta}>{entry.sourceLabel.namespace}</p><p>{t("memoryVersion", { number: entry.revision.ordinal })}</p>
    <p>{t(entry.isCurrentSelection ? "memorySelected" : "memoryHistorical")}</p>
    <p>{t(entry.isCurrentSource ? "memorySourceCurrent" : "memorySourceHistorical")}</p>
    {entry.sourceLabel.occurrenceCount > 1 ? <p>{t("memoryOccurrences", { count: entry.sourceLabel.occurrenceCount })}</p> : null}
    <dl><dt>{t("memoryDonorSource")}</dt><dd><TokenizedText text={entry.sourceText}/></dd>
      <dt>{t("memoryDonorTranslation")}</dt><dd><TokenizedText text={entry.revision.text}/></dd>
      <dt>{t("source")}</dt><dd>{global(entry.revision.originKind === "ai" ? "workbenchV2.candidateAi" : entry.revision.originKind === "import" ? "resource.imported" : "resource.manual")}</dd></dl>
    <section aria-label={t("memoryReview")}><h3>{t("memoryReview")}</h3>
      {latestDecision ? <><p>{t("memoryLatestDecision")}: {t(`memoryDecisions.${latestDecision.kind}`)}</p><p>{t("memoryReviewer", { actor: latestDecision.actor, reason: latestDecision.reason })}</p></> : null}
      {pastApproval ? <><p>{t("memoryPastApproval")}</p><p>{t("memoryReviewer", { actor: pastApproval.actor, reason: pastApproval.reason })}</p></> : <p>{t("memoryNeverApproved")}</p>}
      {currentApproval ? <Banner tone="info">{t("memoryCurrentApproval")}</Banner> : pastApproval ? <p>{t("memoryApprovalNotCurrent")}</p> : null}
      <p className={styles.meta}>{t("memoryApprovalHelp")}</p>
    </section>
  </>;
}

export default function TranslationMemoryDetails({ project, view, visible }: { project: ProjectView; view: WorkspaceView; visible: boolean }) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" });
  const entry = useMemoryEntry(project, view.translationMemory?.donor ?? null, visible);
  if (!view.translationMemory?.donor) return <EmptyState title={t("kinds.memory")} description={t("memoryChoose")}/>;
  return <section className={styles.details} aria-label={t("memoryDetails")}>
    {entry.isFetching ? <LoadingState label={t("memoryReading")}/> : entry.error ? <ErrorState title={t("memoryFailed")} description={<CommandFailureDetails failure={commandFailure(entry.error)}/>} action={<Button onClick={() => void entry.refetch()}>{t("refresh")}</Button>}/>
      : entry.data ? <MemoryEntryEvidence entry={entry.data}/> : null}
  </section>;
}
