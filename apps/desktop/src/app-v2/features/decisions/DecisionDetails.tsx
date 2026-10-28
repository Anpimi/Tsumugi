import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "../../../CommandFailure";
import type { DecisionItem } from "../../../generated/decisions.responses";
import { languageName } from "../../../i18n/languageNames";
import type { GlossaryEntry } from "../../../resourceCommands";
import { reviewReasonKey } from "../../../reviewLabels";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { Badge } from "../../../design-system/Badge";
import { Button } from "../../../design-system/Button";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { decisionTargetKey, DecisionTargetReadError, readDecisionTarget, type DecisionTargetDetails } from "./decisionTargetReads";
import styles from "./DecisionDetails.module.css";

export interface DecisionDetailsProps {
  item: DecisionItem;
  disabled: boolean;
  current: () => boolean;
  onBack: () => void;
  onOpenEntry: (unitId: string, locale: string) => Promise<boolean>;
}

function TextBlock({ label, text }: { label: string; text: string }) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  return <div className={styles.textBlock}><p className={styles.label}>{label}</p>
    <p className={styles.text}>{text === "" ? t("decisionDetailsEmptyText") : <TokenizedText text={text}/>}</p></div>;
}

function TermValues({ term, targetLabel }: { term: Pick<GlossaryEntry, "source" | "target" | "aliases" | "reason" | "protected">; targetLabel: string }) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  return <div className={styles.body}>
    <TextBlock label={t("decisionDetailsSource")} text={term.source}/>
    <TextBlock label={targetLabel} text={term.target}/>
    {term.aliases.length ? <div><p className={styles.label}>{t("decisionDetailsAliases")}</p><ul>{term.aliases.map(alias => <li key={alias}>{alias}</li>)}</ul></div> : null}
    {term.protected ? <p><Badge>{t("decisionDetailsProtected")}</Badge></p> : null}
    {term.reason ? <TextBlock label={t("decisionDetailsReason")} text={term.reason}/> : null}
  </div>;
}

function RecordIdentifiers({ item }: { item: DecisionItem }) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const [expanded, setExpanded] = useState(false), id = useId();
  return <div className={styles.body}><div><Button size="sm" aria-expanded={expanded} aria-controls={id}
    onClick={() => setExpanded(value => !value)}>{t(expanded ? "decisionDetailsHideIdentifiers" : "decisionDetailsShowIdentifiers")}</Button></div>
    {expanded ? <dl id={id} className={styles.identifiers}>{Object.entries(item.action).map(([key, value]) => <div key={key}>
      <dt>{key}</dt><dd><code>{typeof value === "string" || typeof value === "number" ? value : JSON.stringify(value)}</code></dd>
    </div>)}</dl> : null}</div>;
}

function ResourceDetails({ view }: { view: Extract<DecisionTargetDetails, { kind: "resource" }> }) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const { preview, proposal } = view, origin = preview.capture.origin;
  const term = proposal.kind === "row" ? proposal.row.entry : proposal.term;
  const stale = preview.correction?.evidence.current === false || preview.mcp?.current === false;
  return <div className={styles.body}>
    <p>{t("decisionDetailsResourceReadOnly")}</p>
    {stale ? <Banner tone="warning" role="status">{t("decisionDetailsResourceStale")}</Banner> : null}
    <section className={styles.section}>
      <h3>{term.source || t("decisionDetailsUnnamed")}</h3>
      <p><Badge>{t(`decisionDetailsChange.${proposal.kind === "row" ? proposal.row.kind : "removed"}`)}</Badge></p>
      {proposal.kind === "removed" ? <p>{t("decisionDetailsRemoval")}</p> : null}
      <TermValues term={term} targetLabel={t(proposal.kind === "removed" ? "decisionDetailsCurrent" : "decisionDetailsProposed")}/>
      {proposal.kind === "row" && proposal.row.current ? <section className={styles.section}>
        <h4>{t("decisionDetailsCurrent")}</h4><TermValues term={proposal.row.current} targetLabel={t("decisionDetailsCurrent")}/>
      </section> : null}
    </section>
    <section className={styles.section}>
      <h3>{t("decisionDetailsOrigin")}</h3>
      {origin.kind === "file" ? <><p>{t("decisionDetailsOriginFile", { resource: origin.resourceId, version: origin.revision })}</p>
        <p className={styles.meta}>{t("decisionDetailsLicense", { license: origin.license })}</p></> : null}
      {origin.kind === "correction" ? <><p>{t("decisionDetailsOriginCorrection")}</p>
        {preview.correction ? <><TextBlock label={t("decisionDetailsSource")} text={preview.correction.evidence.sourceText}/>
          <TextBlock label={t("decisionDetailsBefore")} text={preview.correction.evidence.beforeText}/>
          <TextBlock label={t("decisionDetailsAfter")} text={preview.correction.evidence.afterText}/></> : null}</> : null}
      {origin.kind === "mcp" ? <><p>{t("decisionDetailsOriginMcp", { server: origin.provenance.tool.serverName, tool: origin.provenance.tool.toolName })}</p>
        <TextBlock label={t("decisionDetailsQuery")} text={origin.provenance.query}/></> : null}
    </section>
  </div>;
}

function MappingDetails({ view }: { view: Extract<DecisionTargetDetails, { kind: "mapping" }> }) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const occurrence = view.row.occurrence;
  const file = view.page.coverage.find(file => file.artifactId === occurrence.artifactId);
  return <div className={styles.body}>
    <Banner tone="warning">{t("decisionDetailsMappingKept")}</Banner>
    <section className={styles.section}>
      <h3>{occurrence.nativeIdentity?.display?.value || occurrence.key || t("decisionDetailsUnnamed")}</h3>
      {file ? <p className={styles.meta}>{t("decisionDetailsOriginalFile", { file: file.logicalPath })}</p> : null}
      <TextBlock label={t("decisionDetailsSource")} text={occurrence.text}/>
    </section>
    <section className={styles.section}><h3>{t("decisionDetailsMappingEvidence")}</h3>
      {view.lineage.length === 0 ? <p>{t("decisionDetailsNoEvidence")}</p> : <ul className={styles.list}>
        {view.lineage.map(evidence => <li key={JSON.stringify([evidence.oldSnapshotId, evidence.old.occurrence.ordinal, evidence.actionId])} className={styles.record}>
          <h4>{evidence.old.occurrence.nativeIdentity?.display?.value || evidence.old.occurrence.key || t("decisionDetailsUnnamed")}</h4>
          <TextBlock label={t("decisionDetailsSource")} text={evidence.old.occurrence.text}/>
          <p>{evidence.relationship === "same-key" ? t("decisionDetailsSameKey") : evidence.relationship === "same-text" ? t("decisionDetailsSameText")
            : evidence.relationship === "manual" ? t("decisionDetailsManualMatch") : t("decisionDetailsOtherMatch", { relationship: evidence.relationship })}</p>
          <p>{t(evidence.decision === "continue" ? "decisionDetailsEvidenceContinue" : evidence.decision === "reject" ? "decisionDetailsEvidenceReject" : "decisionDetailsEvidenceRecorded")}</p>
          <p className={styles.meta}>{t(evidence.appliedRelation === null ? "decisionDetailsEvidenceUnapplied" : "decisionDetailsEvidenceApplied")}</p>
          {evidence.actor ? <p className={styles.meta}>{t("decisionDetailsActor", { actor: evidence.actor })}</p> : null}
          {evidence.reason ? <TextBlock label={t("decisionDetailsReason")} text={evidence.reason}/> : null}
        </li>)}
      </ul>}
    </section>
  </div>;
}

function ExecutionDetails({ view, item, blocked, openEntry }: { view: Extract<DecisionTargetDetails, { kind: "execution" }>; item: DecisionItem; blocked: boolean; openEntry: (unitId: string, locale: string) => void }) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const [expanded, setExpanded] = useState(false), id = useId(), status = view.item.status, scope = view.item.scope;
  const canOpen = scope.kind === "translation-unit" && scope.locale !== null
    && item.targets.some(target => target.kind === "entry" && target.unitId === scope.id);
  return <div className={styles.body}>
    <p>{t("decisionDetailsExecutionReadOnly")}</p>
    <section className={styles.section}>
      <h3>{t(`decisionDetailsExecution.${status.execution}`)}</h3>
      <p>{t(`decisionDetailsValidation.${status.validation}`)}</p><p>{t(`decisionDetailsAdoption.${status.adoption}`)}</p>
      {status.cancellationRequested ? <Banner tone="warning">{t("decisionDetailsCancellation")}</Banner> : null}
      {status.diagnostic ? <TextBlock label={t("decisionDetailsDiagnostic")} text={status.diagnostic}/> : null}
      <p>{t(view.item.resultId === null ? "decisionDetailsNoResult" : "decisionDetailsHasResult")}</p>
      {view.output?.diagnostic ? <TextBlock label={t("decisionDetailsDiagnostic")} text={view.output.diagnostic.code}/> : null}
      {view.output ? <div className={styles.body}>
        <div><Button size="sm" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
          {t(expanded ? "decisionDetailsHideOutput" : "decisionDetailsShowOutput")}</Button></div>
        {expanded ? view.output.output === null ? <p id={id}>{t("decisionDetailsEmptyOutput")}</p>
          : <pre id={id} className={styles.output}>{typeof view.output.output === "string" ? view.output.output : JSON.stringify(view.output.output, null, 2)}</pre> : null}
      </div> : null}
      {canOpen && scope.locale !== null ? <div><Button size="sm" disabled={blocked} onClick={() => { if (scope.locale !== null) openEntry(scope.id, scope.locale); }}>{t("decisionDetailsOpenEntry")}</Button></div> : null}
    </section>
  </div>;
}

function DeliveryDetails({ view, blocked, openEntry }: { view: Extract<DecisionTargetDetails, { kind: "delivery" }>; blocked: boolean; openEntry: (unitId: string, locale: string) => void }) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), { t: global } = useTranslation();
  const { locale } = view;
  return <div className={styles.body}>
    <p>{t("decisionDetailsBlockers", { count: locale.blockerCount, checked: locale.checkedUnits })}</p>
    <p>{t("decisionDetailsDeliveryReadOnly")}</p>
    {locale.blockerCount > locale.blockers.length ? <Banner tone="info">{t("decisionDetailsReasonsSample", { shown: locale.blockers.length, total: locale.blockerCount })}</Banner> : null}
    {locale.blockers.length ? <ul className={styles.list}>{locale.blockers.map((reason, index) => <li key={JSON.stringify([reason.unitId, reason.code, reason.reference, index])} className={styles.record}>
      <h3>{reason.nativeKey || (reason.unitId ? t("decisionDetailsUnnamed") : t("decisionDetailsProjectReason"))}</h3>
      <p>{global(reviewReasonKey(reason.code))}</p>
      {reason.unitId ? <div><Button size="sm" disabled={blocked} onClick={() => openEntry(reason.unitId, locale.locale)}>{t("decisionDetailsOpenEntry")}</Button></div> : null}
    </li>)}</ul> : <p>{t("decisionDetailsNoBlockers")}</p>}
  </div>;
}

function DeliveryOutcomeDetails({ view }: { view: Extract<DecisionTargetDetails, { kind: "delivery-outcome" }> }) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), record = view.record;
  if (record === null) return <Banner tone="warning">{t("decisionDetailsDeliveryAbsent")}</Banner>;
  const created = new Date(record.createdAt);
  return <div className={styles.body}>
    <h3>{t(`decisionDetailsDeliveryState.${record.state}`)}</h3>
    <p className={styles.meta}>{Number.isFinite(created.getTime()) ? t("decisionDetailsCreated", {
      created: new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "short" }).format(created),
    }) : t("decisionDetailsCreatedUnknown")}</p>
    <p>{t("decisionDetailsDirectoryHelp")}</p>
    <section className={styles.section}><h4>{t("decisionDetailsFiles")}</h4>
      {record.files.length ? <ul className={styles.list}>{record.files.map(file => <li key={JSON.stringify([file.locale, file.fileName])} className={styles.record}>
        <h4>{file.fileName}</h4><p>{languageName(file.locale, i18n.resolvedLanguage ?? i18n.language)}</p>
        <p>{t(`decisionDetailsFileState.${file.state}`)}</p>
      </li>)}</ul> : <p>{t("decisionDetailsNoFiles")}</p>}
    </section>
  </div>;
}

function matchesEntry(view: DecisionTargetDetails, item: DecisionItem, unitId: string, locale: string) {
  if (view.kind === "execution") return view.item.scope.kind === "translation-unit" && view.item.scope.id === unitId
    && view.item.scope.locale === locale && item.targets.some(target => target.kind === "entry" && target.unitId === unitId);
  return view.kind === "delivery" && view.locale.locale === locale && view.locale.blockers.some(reason => reason.unitId === unitId && unitId !== "");
}

export default function DecisionDetails(props: DecisionDetailsProps) {
  const reads = useSessionReads();
  const identity = JSON.stringify([reads.context, props.item.decisionId, props.item.action, props.item.locale, props.item.basis]);
  return <DetailsRead key={identity} {...props}/>;
}

function DetailsRead({ item, disabled, current, onBack, onOpenEntry }: DecisionDetailsProps) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), reads = useSessionReads(), titleId = useId();
  const mounted = useRef(false), live = useRef({ disabled, current, onOpenEntry });
  const result = useRef<HTMLDivElement>(null), navigation = useRef(false);
  const [opening, setOpening] = useState(false), [failure, setFailure] = useState<{ cause: CommandFailure | null } | null>(null);
  useLayoutEffect(() => { live.current = { disabled, current, onOpenEntry }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const present = () => mounted.current && !reads.retired && !live.current.disabled && live.current.current();
  const key = decisionTargetKey(item);
  const query = useSessionQuery({ key, scopes: ["project", "source", "translation", "resources", "review", "execution", "release"],
    enabled: !disabled && !reads.retired && current(), structuralSharing: false,
    read: () => readDecisionTarget(reads.context, item, present) });
  const view = query.error ? null : query.data ?? null;
  function currentView(expected: DecisionTargetDetails) {
    const state = reads.client.getQueryState<DecisionTargetDetails>(reads.key(key));
    return present() && state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated && state.error === null && state.data === expected;
  }
  const fresh = !!view && !query.isFetching && !query.isStale && currentView(view);
  async function openEntry(unitId: string, locale: string) {
    const expected = view, callback = live.current.onOpenEntry;
    if (!expected || !currentView(expected) || navigation.current || !matchesEntry(expected, item, unitId, locale)) return;
    navigation.current = true; setOpening(true); setFailure(null);
    try {
      const opened = await callback(unitId, locale);
      if (currentView(expected) && live.current.onOpenEntry === callback && !opened) { setFailure({ cause: null }); result.current?.focus(); }
    } catch (error) {
      if (currentView(expected) && live.current.onOpenEntry === callback) { setFailure({ cause: commandFailure(error) }); result.current?.focus(); }
    } finally {
      navigation.current = false;
      if (mounted.current) setOpening(false);
    }
  }
  function refresh() {
    if (!present() || query.isFetching || navigation.current) return;
    setFailure(null); void query.refetch();
  }
  return <section className={styles.panel} aria-labelledby={titleId}>
    <div className={styles.header}><h2 id={titleId}>{t(`decisionDetailsTitles.${item.action.kind}`)}</h2>
      <Button size="sm" disabled={disabled} onClick={onBack}>{t("decisionDetailsBack")}</Button></div>
    <p className={styles.meta}>{t("decisionDetailsHelp")}</p>
    {item.locale ? <p className={styles.meta}>{t("decisionDetailsLocale")}: {languageName(item.locale, i18n.resolvedLanguage ?? i18n.language)}</p> : null}
    <div className={styles.actions}><Button size="sm" pending={query.isFetching} disabled={disabled || !current() || reads.retired || opening}
      onClick={refresh}>{t("decisionDetailsRead")}</Button></div>
    {disabled || !current() || reads.retired ? <Banner tone="warning" role="status">{t("decisionDetailsUnavailable")}</Banner> : null}
    {query.isPending && !query.error ? <LoadingState label={t("decisionDetailsLoading")}/> : null}
    {query.error ? <Banner tone="error" role="alert"><p>{t(query.error instanceof DecisionTargetReadError && query.error.reason === "missing" ? "decisionDetailsMissing" : "decisionDetailsReadFailed")}</p>
      <CommandFailureDetails failure={commandFailure(query.error)}/></Banner> : null}
    {view && !fresh ? <Banner tone="warning" role="status">{t("decisionDetailsChanged")}</Banner> : null}
    <div className={styles.body} ref={result} tabIndex={-1}>
      {opening ? <p role="status">{t("decisionDetailsOpening")}</p> : null}
      {failure ? <Banner tone="warning" role="alert"><p>{t("decisionDetailsOpenFailed")}</p><CommandFailureDetails failure={failure.cause}/></Banner> : null}
      {view?.kind === "resource" ? <ResourceDetails view={view}/> : null}
      {view?.kind === "mapping" ? <MappingDetails view={view}/> : null}
      {view?.kind === "execution" ? <ExecutionDetails view={view} item={item} blocked={!fresh || opening} openEntry={(unitId, locale) => void openEntry(unitId, locale)}/> : null}
      {view?.kind === "delivery" ? <DeliveryDetails view={view} blocked={!fresh || opening} openEntry={(unitId, locale) => void openEntry(unitId, locale)}/> : null}
      {view?.kind === "delivery-outcome" ? <DeliveryOutcomeDetails view={view}/> : null}
      {view?.kind === "overview" ? <p>{t(item.action.kind === "compare-candidate" ? "decisionDetailsCandidateOverview"
        : item.action.kind === "review-translation" ? "decisionDetailsReviewOverview" : item.action.kind === "review-finding" ? "decisionDetailsFindingOverview"
        : item.action.kind === "inspect-local-request" ? "decisionDetailsRequestOverview" : "decisionDetailsOverview")}</p> : null}
    </div>
    <RecordIdentifiers item={item}/>
  </section>;
}
