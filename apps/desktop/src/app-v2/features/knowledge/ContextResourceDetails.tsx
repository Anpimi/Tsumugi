import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { ContextResourceCapturePreview, ContextResourceScopeText } from "../../../ContextResourceCapturePreview";
import { executionContext } from "../../../executionCommands";
import { resourceCommands } from "../../../resourceCommands";
import type { ContentScope } from "../../../sourceCommands";
import type { ProjectView } from "../../../projectCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { KnowledgeOwner } from "./knowledgeTypes";
import { knowledgeBlocked } from "./knowledgeState";
import { resourceCurrentKey, sameContentScope, useContextResourceCurrent, useContextResourcePages, useContextSource } from "./contextResourceReads";
import TermScopePicker from "./TermScopePicker";
import { useKnowledgeScope } from "./knowledgeReads";
import styles from "./Knowledge.module.css";
import ContextResourceImpact from "./ContextResourceImpact";
import type { OpenKnowledgeProposal } from "../assistant/conversationNavigation";

function SourceBasis({ basis, current }: { basis: ContentScope; current: ContentScope | undefined }) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" });
  const [expanded, setExpanded] = useState(false), id = useId();
  return <div><p>{t("contextSourceAtSave")}: {t(!current ? "contextSourceNotChecked" : sameContentScope(basis, current) ? "contextSourceStillCurrent" : "contextSourceEarlier")}</p>
    <Button size="sm" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{t("contextSourceDetails")}</Button>
    <div id={id} hidden={!expanded}><p>{t("contextSourceRevision")}: <code>{basis.revision}</code></p><p>{t("contextSourceSnapshot")}: <code>{basis.currentSnapshot ?? "—"}</code></p></div></div>;
}

export default function ContextResourceDetails({ project, owner, visible, disabled, current, gate, preset, locale, onOpenProposal }: {
  project: ProjectView; owner: KnowledgeOwner; visible: boolean; disabled: boolean; current: (dialogId?: string) => boolean; gate: InteractionGate; preset: string; locale: string;
  onOpenProposal?: OpenKnowledgeProposal;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" });
  const reads = useSessionReads(), draft = owner.state.typedActiveKey ? owner.state.typedDrafts[owner.state.typedActiveKey] : null;
  const kind = preset === "characters" ? "character" : preset === "style" ? "style" : "background";
  const active = draft?.kind === kind && draft.locale === locale ? draft : null;
  const observed = useContextResourceCurrent(project, active?.contextId ?? null, visible && !!active, { kind, locale });
  const history = useContextResourcePages(project, active?.locale ?? owner.state.locale, kind, visible && !!active?.contextId, active?.contextId ?? undefined);
  const { source } = useContextSource(project, visible && !!active);
  const [sample, setSample] = useState<string | null>(null);
  const [originFailed, setOriginFailed] = useState(false);
  const target = useKnowledgeScope(project, active?.locale ?? owner.state.locale, sample, visible && !!active);
  const resolutionScope = target.data && active ? { projectId: project.metadata.projectId, unitId: target.data.unitId, sourceSnapshotId: target.data.sourceSnapshotId,
    sourceRevisionId: target.data.sourceRevisionId, locale: active.locale } : null;
  const resolved = useSessionQuery({ key: ["knowledge-context-resolution", resolutionScope], scopes: ["source", "resources"], enabled: visible && !!resolutionScope && !target.isFetching && !target.error && source.data?.currentSnapshot === resolutionScope.sourceSnapshotId,
    read: async () => { if (!resolutionScope) throw new Error("A current entry is required"); const value = await resourceCommands.resolveContextResources({ ...executionContext(project), scope: resolutionScope });
      const scope = value.scope;
      if (scope.projectId !== resolutionScope.projectId || scope.unitId !== resolutionScope.unitId || scope.locale !== resolutionScope.locale || scope.sourceRevisionId !== resolutionScope.sourceRevisionId || scope.sourceSnapshotId !== resolutionScope.sourceSnapshotId) throw new Error("Invalid context resolution association");
      return value;
    } });
  if (!active) return <EmptyState title={t("contextChoose")} description={t("contextChooseHelp")}/>;
  const saved = observed.data?.kind === kind && observed.data.locale === locale ? observed.data : null, changed = saved && saved.revisionId !== active.base?.revisionId;
  const checkedSource = !source.isFetching && !source.error ? source.data : undefined;
  function keep() {
    const state = reads.client.getQueryState(reads.key(resourceCurrentKey(active?.contextId ?? null)));
    if (!active?.base || !saved || disabled || !current() || knowledgeBlocked(owner) || observed.isFetching || observed.error || state?.isInvalidated || state?.fetchStatus !== "idle") return;
    owner.contextResources.adoptCurrent(active.key, saved, active.base.revisionId, active.editSeq);
  }
  return <section className={styles.details} aria-label={t("contextDetails")}><h2>{active.name || t("contextUntitled")}</h2><p>{t(`contextKinds.${kind}`)}</p>
    <h3>{t("contextDraft")}</h3><pre className={styles.sourceText}>{active.text}</pre><ContextResourceScopeText scope={active.scope}/>
    <p>{t("contextScopeRules")}</p><p className={styles.meta}>{t("contextFilesHelp")}</p>
    {observed.isFetching ? <LoadingState label={t("contextReading")}/> : observed.error ? <ErrorState title={t("currentFailed")} action={<Button onClick={() => void observed.refetch()}>{t("refresh")}</Button>}/> : null}
    {active.base ? <><h3>{t("savedBasis")}</h3><p>{active.base.name}</p><pre className={styles.sourceText}>{active.base.text}</pre><ContextResourceScopeText scope={active.base.scope}/>
      <p>{t("contextActor")}: {active.base.actor}</p><p>{t("reason")}: {active.base.reason}</p><p>{t(active.base.withdrawn ? "contextStopped" : "contextActive")}</p><SourceBasis basis={active.base.sourceBasis} current={checkedSource}/></> : null}
    {active.base?.proposalOrigin ? <><p>{t("reviewOrigin")}</p>{onOpenProposal ? <Button disabled={disabled} onClick={() => {
      if (!current() || !active.base?.proposalOrigin) return;
      setOriginFailed(false); void onOpenProposal(active.base.proposalOrigin.proposal, current).then(opened => { if (!opened) setOriginFailed(true); }).catch(() => setOriginFailed(true));
    }}>{t("reviewOpenOrigin")}</Button> : null}{originFailed ? <Banner tone="warning">{t("reviewReadFailed")}</Banner> : null}</> : null}
    {changed ? <section className={styles.compare} aria-label={t("comparison")}><h3>{t("contextCurrentChanged")}</h3><p>{saved.name}</p><pre className={styles.sourceText}>{saved.text}</pre><ContextResourceScopeText scope={saved.scope}/>
      <p>{t("contextActor")}: {saved.actor}</p><p>{t("reason")}: {saved.reason}</p>{saved.withdrawn ? <Banner tone="warning">{t("contextStoppedHelp")}</Banner> : null}
      <p>{t("rebaseHelp")}</p><Button disabled={disabled || knowledgeBlocked(owner)} onClick={keep}>{t("keepEdits")}</Button></section> : null}
    <h3>{t("contextCheckEntry")}</h3><p>{t("contextCheckHelp")}</p><TermScopePicker project={project} locale={active.locale} disabled={disabled} gate={gate} current={current} onSelect={setSample}/>
    {sample ? resolved.isFetching || target.isFetching ? <LoadingState label={t("contextReading")}/> : resolved.error || target.error ? <ErrorState title={t("contextReadFailed")} action={<Button onClick={() => { void target.refetch(); void resolved.refetch(); }}>{t("refresh")}</Button>}/>
      : resolved.data ? <><p>{target.data?.nativeKey}</p><ContextResourceCapturePreview capture={resolved.data} mode="read"/></> : null : null}
    {active.contextId ? <><h3>{t("history")}</h3>{history.isFetching && !history.data ? <LoadingState label={t("contextReadingHistory")}/> : history.error ? <ErrorState title={t("contextHistoryFailed")} action={<Button onClick={() => void history.refetch()}>{t("refresh")}</Button>}/> : null}
      <ol className={styles.history}>{history.data?.pages.flatMap(page => page.rows).map((revision, index) => <li key={revision.revisionId}><h3>{t("contextHistoryEntry", { number: index + 1 })}</h3><p>{revision.name}</p><pre className={styles.sourceText}>{revision.text}</pre><ContextResourceScopeText scope={revision.scope}/><p>{revision.actor} · {revision.reason}</p><p>{t(revision.withdrawn ? "contextStopped" : "contextActive")}</p><SourceBasis basis={revision.sourceBasis} current={checkedSource}/></li>)}</ol>
      {history.hasNextPage ? <Button disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>{t("moreHistory")}</Button> : null}</> : null}
    <ContextResourceImpact project={project} locale={active.locale} visible={visible} current={current}/>
    <p className={styles.meta}>{t("contextReferencesUnknown")}</p>
  </section>;
}
