import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { contextFactQueryKey } from "../../../contextFactQueries";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import { Button } from "../../../design-system/Button";
import { Disclosure } from "../../../design-system/Disclosure";
import { Banner, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { executionContext, type SessionRequest } from "../../../executionCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import type { ProjectView } from "../../../projectCommands";
import { isContextFactCasRejection, validContextFactDraft } from "../../../ResourceDraftSession";
import { resourceCommands, type ContextFactDecision, type ContextFactDisposition, type SourceFactBasis } from "../../../resourceCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import { useSessionInfiniteQuery, useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { sourceCommands, sourceContextBlockBasis, type ContentScope, type SourceContextBlock, type SourceContextBlockDescriptor, type SourceContextNeighbor, type SourceContextPage } from "../../../sourceCommands";
import { sourceReads } from "../../../sourceQueries";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { KnowledgeOwner } from "../knowledge/knowledgeTypes";
import styles from "./EntrySourceFacts.module.css";

interface Props {
  project: ProjectView;
  target: Pick<ReviewTarget, "unitId" | "locale" | "sourceSnapshotId" | "sourceRevisionId" | "nativeKey">;
  owner: KnowledgeOwner;
  gate: InteractionGate;
  viewId: string;
  disabled: boolean;
  visible: boolean;
  parentDialogId?: string;
  onOpenEntry?: (unitId: string, locale: string) => Promise<boolean>;
}
const pageLimit = 4;
type Cursor = { after: number; basis: string | null };
type Fact = SourceFactBasis["fact"]["fact"];
function pageBasis(page: SourceContextPage) {
  return JSON.stringify([page.scope, page.contentRevision, page.sourceAttemptId, page.sourceResultId,
    page.sourceResultDigest, page.sourceLocale, page.localUnitId, page.occurrenceCount, page.observations, page.totalEntries]);
}
function factBasis(page: SourceContextPage, block: SourceContextBlock, factIndex: number, fact: Fact): SourceFactBasis {
  return { scope: page.scope, sourceResultId: page.sourceResultId, sourceResultDigest: page.sourceResultDigest,
    fact: { blockIndex: block.blockIndex, factIndex, target: block.target, schema: block.schema, handling: block.handling,
      inRevisionBasis: block.inRevisionBasis, fact } };
}
function currentDecision(values: ContextFactDecision[] | undefined, basis: SourceFactBasis) {
  return values?.find(value => value.request.basis.fact.blockIndex === basis.fact.blockIndex && value.request.basis.fact.factIndex === basis.fact.factIndex) ?? null;
}

function FactOrigin({ fact }: { fact: Fact }) {
  const { t } = useTranslation();
  return <><p className={styles.meta}>{t(`sourceContext.factKinds.${fact.kind}`)} · {t(`sourceContext.origins.${fact.origin.kind}`)}</p>
    {fact.origin.kind === "inferred" ? <p>{t("sourceContext.rationale", { rationale: fact.origin.rationale })}</p> : null}
    <Disclosure title={t("sourceContext.references")}><ul className={styles.references}>{fact.origin.sources.map((reference, index) =>
      <li key={`${reference.artifactId}:${index}`}>{t("sourceContext.referenceRange", { artifact: reference.artifactId, encoding: reference.range.encoding,
        start: String(reference.range.start), end: String(reference.range.end) })}</li>)}</ul></Disclosure></>;
}
function BlockMetadata({ block }: { block: Omit<SourceContextBlockDescriptor, "payloadBytes"> }) {
  const { t } = useTranslation();
  return <Disclosure title={t("sourceContextRead.provenance")}><dl className={styles.metadata}>
    <dt>{t("sourceContextRead.target")}</dt><dd><code>{block.target.kind}{block.target.kind === "snapshot" ? "" : ` · ${block.target.id}`}</code></dd>
    <dt>{t("sourceContextRead.schema")}</dt><dd><code>{block.schema.id} · {block.schema.schemaVersion}/{block.schema.behaviorVersion}</code></dd>
    <dt>{t("sourceContextRead.handling")}</dt><dd>{t(`sourceContextRead.handlingKinds.${block.handling}`)}</dd>
    <dt>{t("sourceContextRead.revisionBasis")}</dt><dd>{t(block.inRevisionBasis ? "sourceContextRead.inRevision" : "sourceContextRead.outsideRevision")}</dd>
  </dl></Disclosure>;
}
function RawRecord({ context, page, descriptor, current, canAct }: { context: SessionRequest; page: SourceContextPage; descriptor: SourceContextBlockDescriptor; current: () => boolean; canAct: () => boolean }) {
  const { t } = useTranslation(), reads = useSessionReads(), id = useId(), [expanded, setExpanded] = useState(false);
  const basis = sourceContextBlockBasis(page), key = ["source-context-block", basis, descriptor];
  const query = useSessionQuery({ key, scopes: ["source", "project"], enabled: expanded && current(),
    read: () => sourceCommands.sourceContextBlock({ ...context, basis, descriptor }) });
  const state = reads.client.getQueryState(reads.key(key));
  const ready = current() && query.isSuccess && !query.isFetching && !query.error && !state?.isInvalidated;
  return <article className={styles.block}>
    <h4>{t("sourceBlockRead.title", { number: String(descriptor.blockIndex + 1) })}</h4><p>{t(`sourceBlockRead.applies.${descriptor.target.kind}`)}</p>
    <BlockMetadata block={descriptor}/><p className={styles.meta}>{t("sourceBlockRead.bytes")}: {descriptor.payloadBytes}</p>
    <Button size="sm" disabled={!canAct()} aria-expanded={expanded} aria-controls={id} onClick={() => { if (canAct()) setExpanded(value => !value); }}>{t(expanded ? "sourceBlockRead.close" : "sourceBlockRead.open")}</Button>
    {expanded ? <section id={id} aria-label={t("sourceBlockRead.record")}>
      {query.isPending || query.isFetching ? <LoadingState label={t("sourceBlockRead.loading")}/> : query.error ? <ErrorState title={t("sourceBlockRead.failed")}
        action={<Button size="sm" disabled={!canAct()} onClick={() => { if (canAct()) void query.refetch(); }}>{t("sourceBlockRead.retry")}</Button>}/> : null}
      {query.error ? <CommandFailureDetails failure={commandFailure(query.error)}/> : null}
      {ready && query.data ? <pre className={styles.raw}>{query.data.payloadUtf8}</pre> : null}
    </section> : null}
  </article>;
}
function Neighbor({ neighbor }: { neighbor: SourceContextNeighbor }) {
  const { t } = useTranslation(), directions = new Set(neighbor.adjacentTo.map(edge => edge.direction));
  const position = directions.size === 2 ? "both" : directions.has("before") ? "before" : "after";
  return <article className={styles.block}><h4>{t(`sourceContext.positions.${position}`)}</h4><p className={styles.text}><TokenizedText text={neighbor.text}/></p>
    <Disclosure title={t("sourceContextRead.provenance")}><p className={styles.meta}>{t("sourceContextRead.occurrence")}: <code>{neighbor.occurrence.localOccurrenceId}</code></p>
      <p>{t("sourceContext.referenceRange", { artifact: neighbor.occurrence.source.artifactId, encoding: neighbor.occurrence.source.range.encoding,
        start: String(neighbor.occurrence.source.range.start), end: String(neighbor.occurrence.source.range.end) })}</p></Disclosure></article>;
}

function FactPage({ context, page, owner, entryKey, current, canAct, onBlocked }: {
  context: SessionRequest; page: SourceContextPage; owner: KnowledgeOwner; entryKey: string; current: () => boolean; canAct: () => boolean; onBlocked: () => void;
}) {
  const { t } = useTranslation(), reads = useSessionReads();
  const bases = page.entries.flatMap(entry => entry.kind === "block" && entry.value.facts ? entry.value.facts.facts.map((fact, index) => factBasis(page, entry.value, index, fact)) : []);
  const positions = bases.map(basis => ({ blockIndex: basis.fact.blockIndex, factIndex: basis.fact.factIndex })), key = contextFactQueryKey(page.scope, positions);
  const decisions = useSessionQuery({ key, scopes: ["source", "resources"], enabled: positions.length > 0,
    read: async () => {
      const values = await resourceCommands.factDecisions({ ...context, scope: page.scope, facts: positions });
      if (values.some(value => !bases.some(basis => jsonIdentity(basis) === jsonIdentity(value.request.basis)))) throw new Error("Source fact decision basis changed");
      return values;
    } });
  function ready() {
    const state = reads.client.getQueryState<ContextFactDecision[]>(reads.key(key));
    return current() && state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated && state.error === null && state.data === decisions.data;
  }
  function begin(basis: SourceFactBasis, disposition: ContextFactDisposition) {
    if (!canAct() || !ready() || !owner.beginFact(basis, entryKey, currentDecision(decisions.data, basis), disposition)) onBlocked();
  }
  return <>
    {positions.length > 0 && !ready() ? decisions.error ? <ErrorState title={t("contextFacts.readFailed")} action={<Button size="sm" disabled={!canAct()} onClick={() => { if (canAct()) void decisions.refetch(); }}>{t("resource.refresh")}</Button>}/>
      : <LoadingState label={t("resource.loading")}/> : null}
    {page.entries.map((entry, index) => entry.kind === "stored-block" ? <RawRecord key={jsonIdentity([sourceContextBlockBasis(page), entry.value])} context={context} page={page} descriptor={entry.value} current={current} canAct={canAct}/>
      : entry.kind === "neighbor" ? <Neighbor key={`neighbor:${index}`} neighbor={entry.value}/>
      : <section className={styles.block} key={`block:${entry.value.blockIndex}`} aria-label={t("sourceContextRead.block", { number: String(entry.value.blockIndex + 1) })}>
        <h4>{t("sourceContextRead.block", { number: String(entry.value.blockIndex + 1) })}</h4><BlockMetadata block={entry.value}/>
        {entry.value.facts === null ? <Banner tone="warning">{t(entry.value.handling === "required" ? "sourceContextRead.unknownRequired" : "sourceContextRead.unknownBlock")}</Banner>
          : entry.value.facts.facts.length === 0 ? <p>{t("sourceContextRead.emptyBlock")}</p>
          : entry.value.facts.facts.map((fact, factIndex) => {
            const basis = factBasis(page, entry.value, factIndex, fact), decision = ready() ? currentDecision(decisions.data, basis) : null;
            const disposition = decision?.request.disposition;
            return <article key={fact.id} className={styles.fact} aria-label={t(`sourceContext.factKinds.${fact.kind}`)}>
              <h5>{t("workbenchV2.entryFactRawValue")}</h5><p className={styles.text}><TokenizedText text={fact.text}/></p><FactOrigin fact={fact}/>
              {ready() ? <div className={styles.effective}><h5>{t("workbenchV2.entryFactEffectiveValue")}</h5>
                {disposition?.kind === "replace" ? <><p className={styles.meta}>{t("contextFacts.manual")}</p><p className={styles.text}><TokenizedText text={disposition.text}/></p></>
                  : disposition?.kind === "reject-inference" ? <p>{t("workbenchV2.entryFactRejected")}</p> : <p>{t("workbenchV2.entryFactOriginalEffective")}</p>}
                {decision ? <>{decision.request.disposition.kind !== "replace" ? <p>{t(`contextFacts.operation.${decision.request.disposition.kind}`)}</p> : null}<p className={styles.text}>{decision.request.actor}: {decision.request.reason}</p></> : null}
              </div> : null}
              <div className={styles.actions}><Button size="sm" disabled={!canAct() || !ready() || owner.factBlocked() || !!owner.state.factDraft} onClick={() => begin(basis, { kind: "replace", text: disposition?.kind === "replace" ? disposition.text : fact.text })}>{t("contextFacts.replace")}</Button>
                {fact.origin.kind === "inferred" ? <Button size="sm" disabled={!canAct() || !ready() || owner.factBlocked() || !!owner.state.factDraft || disposition?.kind === "reject-inference"} onClick={() => begin(basis, { kind: "reject-inference" })}>{t("contextFacts.reject")}</Button> : null}
                {disposition && disposition.kind !== "restore" ? <Button size="sm" disabled={!canAct() || !ready() || owner.factBlocked() || !!owner.state.factDraft} onClick={() => begin(basis, { kind: "restore" })}>{t("contextFacts.restore")}</Button> : null}
              </div>
            </article>;
          })}
      </section>)}
  </>;
}

function FactEditor({ context, target, owner, current, sourceCurrent, refresh, inputAllowed, gate, viewId }: {
  context: SessionRequest; target: Props["target"]; owner: KnowledgeOwner; current: () => boolean; sourceCurrent: (basis: SourceFactBasis) => boolean;
  refresh: () => void; inputAllowed: () => boolean; gate: InteractionGate; viewId: string;
}) {
  const { t } = useTranslation(), reads = useSessionReads(), inputOwner = useId(), heading = useRef<HTMLHeadingElement>(null);
  const state = owner.state, draft = state.factDraft;
  const sameEntry = draft?.basis.scope.projectId === context.projectId && draft.basis.scope.unitId === target.unitId && draft.basis.scope.locale === target.locale;
  const active = sameEntry ? draft : null, pending = active ? state.factPending : null;
  const positions = active ? [{ blockIndex: active.basis.fact.blockIndex, factIndex: active.basis.fact.factIndex }] : [];
  const key = active ? contextFactQueryKey(active.basis.scope, positions) : ["context-fact-decisions", null];
  const decisions = useSessionQuery({ key, scopes: ["source", "resources"], enabled: !!active,
    read: () => { if (!active) throw new Error("No source fact draft"); return resourceCommands.factDecisions({ ...context, scope: active.basis.scope, facts: positions }); } });
  const factIdentity = active ? jsonIdentity([active.basis, active.disposition.kind]) : null;
  useLayoutEffect(() => { if (active && inputAllowed()) heading.current?.focus(); }, [factIdentity]);
  useLayoutEffect(() => () => gate.releaseOwner(inputOwner), [gate, inputOwner]);
  function readProof() {
    if (!active || owner.current().factDraft !== active || !sourceCurrent(active.basis) || !owner.localeAvailable(active.basis.scope.locale)) return false;
    const checked = reads.client.getQueryState<ContextFactDecision[]>(reads.key(key));
    if (checked?.status !== "success" || checked.fetchStatus !== "idle" || checked.isInvalidated || checked.error !== null) return false;
    const decision = currentDecision(checked.data, active.basis);
    return (decision?.request.actionId ?? null) === active.expectedDecisionId && (!decision || jsonIdentity(decision.request.basis) === jsonIdentity(active.basis));
  }
  const proof = () => current() && readProof();
  if (!active) return null;
  const canRecover = current() && !state.busyMutation && !!pending, canSave = !pending && !state.pending && !state.busyMutation && validContextFactDraft(active) && proof();
  const change = (patch: Parameters<KnowledgeOwner["editFact"]>[0]) => { if (inputAllowed() && owner.current().factDraft === active) owner.editFact(patch); };
  return <section className={styles.editor} aria-label={t("contextFacts.editor")} onFocusCapture={() => { if (inputAllowed()) gate.setInputOwner(viewId, inputOwner); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputOwner); }}
    onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
    <h4 ref={heading} tabIndex={-1}>{t("contextFacts.editor")}</h4><p>{t("contextFacts.scope", { key: active.key, locale: active.basis.scope.locale })}</p>
    <p>{t(`contextFacts.${active.disposition.kind === "reject-inference" ? "reject" : active.disposition.kind}`)}</p><p className={styles.text}><TokenizedText text={active.basis.fact.fact.text}/></p><FactOrigin fact={active.basis.fact.fact}/>
    <p className={styles.meta}>{t("contextFacts.fieldLimits")}</p>
    {active.disposition.kind === "replace" ? <Field label={t("contextFacts.value")} required><TextArea rows={3} readOnly={!inputAllowed()} value={active.disposition.text} onChange={event => change({ disposition: { kind: "replace", text: event.target.value } })}/></Field> : null}
    <Field label={t("contextFacts.actor")} required><TextInput readOnly={!inputAllowed()} value={active.actor} onChange={event => change({ actor: event.target.value })}/></Field>
    <Field label={t("contextFacts.reason")} required><TextArea rows={3} readOnly={!inputAllowed()} value={active.reason} onChange={event => change({ reason: event.target.value })}/></Field>
    {!pending && !readProof() ? <Banner tone="warning" role="status">{t("contextFacts.changed")}<Button size="sm" disabled={!current()} onClick={() => { if (current()) { refresh(); void decisions.refetch(); } }}>{t("resource.refresh")}</Button></Banner> : null}
    {state.factRecorded ? <Banner tone="success" role="status">{t("resource.savedNewer")}</Banner> : null}
    {pending ? <Banner tone="warning" role="status">{t(state.checkingAction === "fact" ? "contextFacts.checking" : "contextFacts.unknown")}</Banner> : null}
    {state.factFailure ? <Banner tone="error" role="alert"><p>{t(!pending && isContextFactCasRejection(state.factFailure) ? "contextFacts.notSubmitted" : "contextFacts.failed")}</p><CommandFailureDetails failure={state.factFailure}/></Banner> : null}
    <div className={styles.actions}><Button variant="primary" size="sm" disabled={!canSave} onClick={() => { if (proof()) void owner.saveFact(proof); }}>{t("contextFacts.save")}</Button>
      <Button size="sm" disabled={!current() || !!pending || state.busyMutation} onClick={() => { if (current()) owner.discardFact(); }}>{t("contextFacts.discard")}</Button>
      {pending ? <><Button size="sm" disabled={!canRecover} onClick={() => { if (current() && !owner.current().busyMutation) void owner.checkFact(); }}>{t("contextFacts.check")}</Button>
        {state.factCheckedMissing ? <Button size="sm" disabled={!canRecover} onClick={() => { if (current() && !owner.current().busyMutation && owner.current().factCheckedMissing) void owner.retryFact(); }}>{t("contextFacts.retry")}</Button> : null}</> : null}
    </div>
  </section>;
}

function FactHistory({ context, target, current }: { context: SessionRequest; target: Props["target"]; current: () => boolean }) {
  const { t } = useTranslation(), reads = useSessionReads(), id = useId(), [expanded, setExpanded] = useState(false), [offset, setOffset] = useState(0);
  const key = ["context-fact-history", target.unitId, target.locale, offset];
  const history = useSessionQuery({ key, scopes: ["resources"], enabled: expanded,
    read: () => resourceCommands.factHistory({ ...context, unitId: target.unitId, locale: target.locale, offset, limit: 10 }) });
  const state = reads.client.getQueryState(reads.key(key)), ready = history.isSuccess && !history.isFetching && !history.error && !state?.isInvalidated;
  const data = ready ? history.data : undefined;
  return <section className={styles.history} aria-label={t("contextFacts.history")}><Button size="sm" disabled={!current()} aria-expanded={expanded} aria-controls={id} onClick={() => { if (current()) setExpanded(value => !value); }}>{t("contextFacts.history")}</Button>
    {expanded ? <div id={id}>{history.isPending || history.isFetching ? <LoadingState label={t("resource.loading")}/> : history.error ? <ErrorState title={t("contextFacts.readFailed")}
      action={<Button size="sm" disabled={!current()} onClick={() => { if (current()) void history.refetch(); }}>{t("resource.retryRead")}</Button>}/> : null}
      {data?.rows.length === 0 ? <p>{t("workbenchV2.entryFactHistoryEmpty")}</p> : null}
      {data ? <ol className={styles.historyList}>{data.rows.map(row => <li key={row.request.actionId}>
        <p>{t(`contextFacts.operation.${row.request.disposition.kind}`)}</p><p className={styles.text}><TokenizedText text={row.request.basis.fact.fact.text}/></p><FactOrigin fact={row.request.basis.fact.fact}/>
        {row.request.disposition.kind === "replace" ? <p className={styles.text}><TokenizedText text={row.request.disposition.text}/></p> : null}
        <p className={styles.text}>{row.request.actor}: {row.request.reason}</p><BlockMetadata block={row.request.basis.fact}/>
        {row.request.basis.scope.sourceSnapshotId !== target.sourceSnapshotId || row.request.basis.scope.sourceRevisionId !== target.sourceRevisionId ? <Banner tone="info">{t("contextFacts.historicalSource")}</Banner> : null}
      </li>)}</ol> : null}
      <div className={styles.actions}>{offset > 0 ? <Button size="sm" disabled={!current() || history.isFetching} onClick={() => { if (current()) setOffset(0); }}>{t("contextFacts.firstPage")}</Button> : null}
        {data && data.nextOffset !== null ? <Button size="sm" disabled={!current()} onClick={() => { const next = data.nextOffset; if (current() && next !== null) setOffset(next); }}>{t("execution.nextPage")}</Button> : null}</div>
    </div> : null}
  </section>;
}

function EntrySourceFactsView({ project, target, owner, gate, viewId, disabled, visible, parentDialogId, onOpenEntry }: Props) {
  const { t } = useTranslation(), reads = useSessionReads(), context = executionContext(project);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const scope = { projectId: context.projectId, unitId: target.unitId, locale: target.locale, sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId };
  const signature = jsonIdentity([context, scope, viewId, parentDialogId]), latest = useRef({ signature, visible, disabled }), mounted = useRef(true);
  const [blocked, setBlocked] = useState<typeof signature | null>(null);
  useLayoutEffect(() => { latest.current = { signature, visible, disabled }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function available() { return mounted.current && latest.current.signature === signature && latest.current.visible && !latest.current.disabled && !reads.retired
    && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken && project.metadata.targetLocales.includes(target.locale); }
  function current() { return available() && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId }); }
  const sourceOptions = sourceReads.scope(context), source = useSessionQuery({ ...sourceOptions, enabled: visible && !disabled });
  function sourceReady() {
    const state = reads.client.getQueryState<ContentScope>(reads.key(sourceOptions.key));
    return available() && state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated && state.error === null
      && state.data === source.data && state.data?.currentSnapshot === target.sourceSnapshotId;
  }
  const key = ["translation-editor-source-context", context.projectId, target.sourceSnapshotId, target.unitId, target.sourceRevisionId, target.locale, pageLimit];
  const raw = useSessionInfiniteQuery<SourceContextPage, Cursor>({ key, scopes: ["source", "project"], enabled: visible && !disabled && sourceReady(), initialPageParam: { after: 0, basis: null },
    nextPage: (last, pages) => last.nextAfter === null ? undefined : { after: last.nextAfter, basis: pageBasis(pages[0]) },
    read: async cursor => { const page = await sourceCommands.sourceContext({ ...context, ...scope, after: cursor.after, limit: pageLimit });
      if (cursor.basis !== null && cursor.basis !== pageBasis(page)) throw new Error("Source context page basis changed"); return page; } });
  const pages = raw.data?.pages ?? [], consistent = pages.length > 0 && pages.every((page, index) => pageBasis(page) === pageBasis(pages[0])
    && page.contentRevision === source.data?.revision && (index === 0 ? page.after === 0 : page.after === pages[index - 1].nextAfter));
  function rawCurrent() {
    const state = reads.client.getQueryState(reads.key(key));
    return sourceReady() && consistent && state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated && state.error === null && state.data === raw.data;
  }
  function refresh() { if (current()) { void source.refetch(); void reads.client.resetQueries({ queryKey: reads.key(key), exact: true }); } }
  function sourceCurrent(basis: SourceFactBasis) {
    return rawCurrent() && jsonIdentity(basis.scope) === jsonIdentity(scope) && pages.some(page => page.entries.some(entry => entry.kind === "block" && entry.value.facts
      && entry.value.facts.facts.some((fact, index) => jsonIdentity(factBasis(page, entry.value, index, fact)) === jsonIdentity(basis))));
  }
  if (!visible) return null;
  const draft = owner.state.factDraft, other = draft && (draft.basis.scope.unitId !== target.unitId || draft.basis.scope.locale !== target.locale) ? draft : null;
  const recorded = owner.state.factRecorded, recordedScope = recorded?.decision.request.basis.scope, ready = rawCurrent();
  return <section className={styles.section} aria-label={t("contextFacts.title")}>
    <div className={styles.heading}><h3>{t("contextFacts.title")}</h3><Button size="sm" disabled={!current() || source.isFetching || raw.isFetching} onClick={refresh}>{t("sourceContextRead.refresh")}</Button></div>
    <p className={styles.meta}>{t("contextFacts.scope", { key: target.nativeKey, locale: target.locale })}</p><p>{t("contextFacts.help")}</p><p className={styles.meta}>{t("sourceContextRead.help")}</p>
    {other ? <Banner tone="warning" role="status"><p>{t("workbenchV2.entryFactOtherDraft")}</p>{onOpenEntry ? <Button size="sm" disabled={!current()} onClick={() => {
      if (current()) void onOpenEntry(other.basis.scope.unitId, other.basis.scope.locale).then(opened => { if (!opened && mounted.current) setBlocked(signature); }).catch(() => { if (mounted.current) setBlocked(signature); });
    }}>{t("contextFacts.currentEntry")}: {other.key}</Button> : null}</Banner> : null}
    {blocked === signature ? <Banner tone="warning" role="alert">{t("contextFacts.draftBlocked")}</Banner> : null}
    {recorded && recordedScope?.unitId === target.unitId && recordedScope.locale === target.locale && !draft ? <Banner tone="success" role="status">{t("contextFacts.saved", { key: recorded.key, locale: recordedScope.locale })}</Banner> : null}
    <FactEditor context={context} target={target} owner={owner} current={current} sourceCurrent={sourceCurrent} refresh={refresh} gate={gate} viewId={viewId}
      inputAllowed={() => { const interaction = gate.getSnapshot(), dialog = interaction.dialogs.at(-1); return available() && interaction.visibleViewId === viewId && !interaction.intentOwner
        && (!dialog || dialog === parentDialogId) && owner.journal.hydration === "ready" && !owner.journal.retired && owner.localeAvailable(target.locale); }}/>
    {source.isFetching || source.isPending ? <LoadingState label={t("sourceContextRead.loading")}/>
      : source.error ? <ErrorState title={t("sourceContextRead.readFailed")} action={<Button size="sm" disabled={!current()} onClick={refresh}>{t("sourceContextRead.retry")}</Button>}/>
      : !sourceReady() ? <Banner tone="warning" role="status">{t("sourceContextRead.sourceChanged")}</Banner>
      : raw.isFetching || raw.isPending ? <LoadingState label={t("sourceContextRead.loading")}/>
      : !ready ? <ErrorState title={t(raw.error ? "sourceContextRead.readFailed" : "sourceContextRead.basisChanged")} action={<Button size="sm" disabled={!current()} onClick={refresh}>{t("sourceContextRead.retry")}</Button>}/> : null}
    {ready ? <><p className={styles.meta}>{t("sourceContextRead.progress", { loaded: String(pages.reduce((total, page) => total + page.entries.length, 0)), total: String(pages[0].totalEntries) })}</p>
      {pages[0].observations.missingBlocks ? <p>{t("sourceContext.missing")}</p> : null}{pages[0].observations.emptyBlocks ? <p>{t("sourceContext.empty", { count: pages[0].observations.emptyBlocks })}</p> : null}
      {pages[0].observations.unknownBlocks ? <p>{t("sourceContext.unknown", { count: pages[0].observations.unknownBlocks })}</p> : null}
      {pages[0].observations.unknownRequiredBlocks ? <Banner tone="warning">{t("sourceContextRead.requiredUnknownCount", { count: pages[0].observations.unknownRequiredBlocks })}</Banner> : null}
      {pages[0].totalEntries === 0 ? <p>{t("sourceContextRead.noEntries")}</p> : null}
      {pages.map(page => <FactPage key={jsonIdentity([pageBasis(page), page.after])} context={context} page={page} owner={owner} entryKey={target.nativeKey} current={rawCurrent} canAct={() => current() && rawCurrent()} onBlocked={() => setBlocked(signature)}/>)}
      {raw.hasNextPage ? <Button size="sm" disabled={!current() || raw.isFetching} onClick={() => { if (current() && rawCurrent()) void raw.fetchNextPage(); }}>{t("sourceContextRead.more")}</Button> : <p className={styles.meta}>{t("sourceContextRead.complete")}</p>}
    </> : null}
    <FactHistory key={jsonIdentity([context, target.unitId, target.locale])} context={context} target={target} current={current}/>
  </section>;
}

/** Reading controls belong to one exact source; editable intent remains in the project owner. */
export default function EntrySourceFacts(props: Props) {
  const { project, target, viewId, parentDialogId } = props;
  return <EntrySourceFactsView key={jsonIdentity([executionContext(project), target.unitId, target.locale, target.sourceSnapshotId, target.sourceRevisionId, viewId, parentDialogId])} {...props}/>;
}
