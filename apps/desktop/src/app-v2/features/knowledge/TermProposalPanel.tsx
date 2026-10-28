import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import { resourceCommands, type GlossaryCapture, type ResourceDecision, type ResourcePreview, type ResourcePreviewRow, type TermRevision } from "../../../resourceCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { sourceCommands } from "../../../sourceCommands";
import { Badge } from "../../../design-system/Badge";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Banner, EmptyState, LoadingState } from "../../../design-system/Feedback";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { KnowledgeOwner } from "./knowledgeTypes";
import styles from "./TermProposalPanel.module.css";

interface Props {
  project: ProjectView; owner: KnowledgeOwner; disabled: boolean; current: (dialogId?: string) => boolean;
  gate: InteractionGate; viewId: string | null;
}
type Choice = {
  preview: ResourcePreview;
  entryId: string; revisionId: string | null; decision: ResourceDecision["decision"];
} & ({ removed: false; row: ResourcePreviewRow } | { removed: true; row: TermRevision });

/** Saved captures are evidence. Decisions remain in the original resource owner. */
export default function TermProposalPanel({ project, owner, disabled, current, gate }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" }), { t: global } = useTranslation();
  const reads = useSessionReads(), context = executionContext(project), dialogId = useId();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const mounted = useRef(false), live = useRef({ owner, disabled, current });
  const [confirmation, setConfirmation] = useState<Choice | null>(null), confirmationRef = useRef<Choice | null>(null);
  useLayoutEffect(() => { live.current = { owner, disabled, current }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => confirmation ? gate.pushDialog(dialogId) : undefined, [confirmation, dialogId, gate]);
  const present = (dialog?: string) => mounted.current && !reads.retired && !live.current.disabled && live.current.current(dialog);
  const state = owner.state, capture = state.previewCapture, preview = state.preview;
  const sourceKey = ["resource-source-scope"];
  const source = useSessionQuery({ key: sourceKey, scopes: ["source"], enabled: !disabled && !reads.retired,
    read: () => sourceCommands.scope(context) });
  const captures = useSessionQuery({ key: ["resource-captures", 100], scopes: ["resources"], enabled: !disabled && !reads.retired,
    read: () => resourceCommands.captures({ ...context, limit: 100 }) });
  const previewKey = ["resource-preview-current", capture?.captureId ?? ""];
  const latest = useSessionQuery({ key: previewKey, scopes: ["source", "translation", "resources"],
    enabled: !disabled && !reads.retired && !!capture && !!preview && !state.previewNeedsRefresh && owner.canReadCapture(capture),
    read: async () => {
      if (!capture) throw new Error("Missing term proposal capture");
      const result = await resourceCommands.preview({ ...context, captureId: capture.captureId });
      if (jsonIdentity(result.capture) !== jsonIdentity(capture)) throw new Error("Term proposal capture changed");
      return result;
    } });
  function fresh(key: readonly unknown[], expected: unknown) {
    const value = reads.client.getQueryState(reads.key(key));
    return value?.status === "success" && value.fetchStatus === "idle" && !value.isInvalidated && value.error === null && value.data === expected;
  }
  function matching(choice: Choice, dialog?: string) {
    const value = live.current.owner.current(), observed = latest.data, basis = value.previewSourceBasis;
    if (!present(dialog) || value.preview !== choice.preview || value.previewNeedsRefresh || !observed || !basis
      || !fresh(sourceKey, source.data) || !fresh(previewKey, observed) || !source.data
      || basis.revision !== source.data.revision || basis.snapshotId !== source.data.currentSnapshot
      || jsonIdentity(observed.capture) !== jsonIdentity(choice.preview.capture)) return false;
    const allowed = live.current.owner.localeAvailable(choice.preview.capture.targetLocale)
      || choice.preview.capture.origin.kind !== "file" && live.current.owner.canReadCapture(choice.preview.capture)
      && (choice.decision === "keep" || choice.decision === "ignore");
    if (!allowed) return false;
    if ((observed.mcp && !observed.mcp.current || observed.correction && !observed.correction.evidence.current)
      && (choice.decision === "adopt" || choice.decision === "override")) return false;
    if (choice.removed) {
      return (choice.decision === "adopt" || choice.decision === "keep")
        && observed.removed.some(term => term.externalEntryId === choice.entryId && term.revisionId === choice.revisionId
          && jsonIdentity(term) === jsonIdentity(choice.row));
    }
    const row = observed.rows.find(row => row.entry.id === choice.entryId);
    return !!row && jsonIdentity(row) === jsonIdentity(choice.row)
      && (choice.decision !== "adopt" || row.kind !== "unchanged" && row.kind !== "override")
      && (choice.decision !== "override" || row.kind === "override" && !observed.correction)
      && !(observed.correction && choice.decision === "adopt" && row.current !== null);
  }
  const busy = state.busyMutation || owner.inFlight() || !!state.pending || !!state.factPending || !!state.checkingAction;
  const dirty = owner.termDirty() || owner.contextDirty() || owner.correctionDirty() || owner.factDirty() || owner.tool.hasDraft() || owner.tool.blocked();
  function canChoose(choice: Choice, dialog?: string) { return !busy && !dirty && matching(choice, dialog); }
  function confirm(choice: Choice | null) { confirmationRef.current = choice; setConfirmation(choice); }
  async function apply(choice: Choice, dialog?: string) {
    if (!canChoose(choice, dialog)) return;
    const originalOwner = live.current.owner;
    await originalOwner.decide(choice.entryId, choice.revisionId, choice.decision,
      () => matching(choice, dialog) && (!dialog || confirmationRef.current === choice));
    if (mounted.current && !originalOwner.current().pending && confirmationRef.current === choice) confirm(null);
  }
  function choose(choice: Choice) {
    if (!canChoose(choice)) return;
    if (choice.removed && choice.decision === "adopt" || choice.decision === "override") confirm(choice);
    else void apply(choice);
  }
  function label(value: GlossaryCapture) {
    return value.origin.kind === "file" ? t("proposalFile", { resource: value.origin.resourceId, version: value.origin.revision })
      : value.origin.kind === "correction" ? t("proposalCorrection") : t("proposalMcp", { server: value.origin.provenance.tool.serverName });
  }
  function recovery(dialog?: string) {
    const pending = state.pending;
    if (pending?.kind !== "decision") return null;
    const available = () => present(dialog) && live.current.owner.current().pending === pending
      && !live.current.owner.inFlight() && !live.current.owner.current().busyMutation;
    return <Banner tone="warning" role="status" action={<div className={styles.actions}>
      <Button size="sm" disabled={!available()} onClick={() => { if (available()) void live.current.owner.checkPending(); }}>{t("proposalCheck")}</Button>
      {state.pendingUncertain && state.pendingCheckedMissing ? <Button size="sm" disabled={!available()}
        onClick={() => { if (available()) void live.current.owner.retryPending(); }}>{t("proposalRetry")}</Button> : null}
    </div>}>{t(state.busyMutation ? "proposalBusy" : "proposalUnknown")}</Banner>;
  }
  const readable = captures.data?.filter(value => value.targetLocale === state.locale && owner.canReadCapture(value)) ?? [];
  const changed = !!preview && (state.previewNeedsRefresh || !latest.data || !source.data || !fresh(sourceKey, source.data)
    || !fresh(previewKey, latest.data) || jsonIdentity(preview) !== jsonIdentity(latest.data));
  return <section className={styles.panel} aria-label={t("proposalTitle")}>
    <header className={styles.header}><div><h2>{t("proposalTitle")}</h2><p>{t("proposalHelp")}</p></div>
      <Button size="sm" disabled={!present() || busy || dirty || !owner.localeAvailable(state.locale)}
        onClick={() => { if (present() && !busy && !dirty) void owner.chooseFile(() => present()); }}>{t("proposalChooseFile")}</Button>
    </header>
    {state.notice === "pickerUnknown" ? <Banner tone="warning" role="status" action={<Button size="sm" disabled={!present() || captures.isFetching}
      onClick={() => { if (present()) void captures.refetch(); }}>{t("proposalReadAgain")}</Button>}>{global("resource.pickerUnknown")}</Banner> : null}
    {captures.isPending ? <LoadingState label={global("resource.loading")}/> : null}
    {captures.error ? <Banner tone="error" role="alert" action={<Button size="sm" disabled={!present() || captures.isFetching}
      onClick={() => { if (present()) void captures.refetch(); }}>{t("proposalReadAgain")}</Button>}>
      <p>{t("proposalReadFailed")}</p><CommandFailureDetails failure={commandFailure(captures.error)}/></Banner> : null}
    {readable.length ? <ul className={styles.sources} aria-label={t("proposalSaved")}>{readable.map(value => <li key={value.captureId}>
      <span>{label(value)}</span><Button size="sm" disabled={!present() || busy || dirty || !fresh(["resource-captures", 100], captures.data)}
        onClick={() => { if (present() && !busy && !dirty) void owner.openPreview(value, () => present()); }}>{t("proposalOpen")}</Button>
    </li>)}</ul> : captures.isSuccess && !captures.error ? <p>{t("proposalEmpty")}</p> : null}
    {captures.data?.length === 100 ? <p className={styles.meta}>{t("proposalLimited")}</p> : null}
    {recovery()}
    {capture ? <div className={styles.preview}>
      <header className={styles.header}><div><h3>{label(capture)}</h3><p>{t("proposalLocale", { locale: capture.targetLocale })}</p></div>
        <Button size="sm" disabled={!present() || busy || dirty} onClick={() => { if (present() && !busy && !dirty) void owner.retryPreview(() => present()); }}>{t("proposalReadAgain")}</Button></header>
      {!preview && !state.busyMutation ? <Banner tone="warning">{global("resource.previewUnavailable")}</Banner> : null}
      {source.error || latest.error ? <Banner tone="error" role="alert"><p>{t("proposalReadFailed")}</p>
        <CommandFailureDetails failure={commandFailure(source.error ?? latest.error)}/></Banner> : null}
      {changed ? <Banner tone="warning" role="status">{t("proposalChanged")}</Banner> : null}
      {preview?.mcp && !preview.mcp.current || preview?.correction && !preview.correction.evidence.current ? <Banner tone="warning">{t("proposalStale")}</Banner> : null}
      {preview ? <div className={styles.scroll}><table className={styles.table}><thead><tr>
        <th scope="col">{t("proposalSource")}</th><th scope="col">{t("proposalCurrent")}</th><th scope="col">{t("proposalProposed")}</th><th scope="col">{t("proposalActions")}</th>
      </tr></thead><tbody>{preview.rows.map(row => {
        const make = (decision: ResourceDecision["decision"]): Choice => ({ preview, row, removed: false, entryId: row.entry.id, revisionId: row.current?.revisionId ?? null, decision });
        const action = make(row.kind === "override" && !preview.correction ? "override" : "adopt");
        return <tr key={row.entry.id}><th scope="row">{row.entry.source}<p className={styles.meta}>{row.entry.nativeKey || t(row.scopeUnitId ? "proposalScopeEntry" : "proposalScopeProject")}</p></th>
          <td>{row.current?.target ?? t("proposalMissingValue")}</td><td>{row.entry.target}<p className={styles.meta}>{global(`resource.changeKind.${row.kind}`)}</p>
            {row.entry.protected ? <Badge>{t("proposalProtected")}</Badge> : null}{row.entry.reason ? <p aria-label={t("proposalReason")}>{row.entry.reason}</p> : null}</td>
          <td><div className={styles.actions}><Button size="sm" disabled={!canChoose(action)} onClick={() => choose(action)}>{t(action.decision === "override" ? "proposalOverride" : "proposalAdopt")}</Button>
            <Button size="sm" disabled={!canChoose(make("keep"))} onClick={() => choose(make("keep"))}>{t("proposalKeep")}</Button>
            <Button size="sm" disabled={!canChoose(make("ignore"))} onClick={() => choose(make("ignore"))}>{t("proposalIgnore")}</Button></div></td></tr>;
      })}{preview.removed.map(term => {
        const make = (decision: "adopt" | "keep"): Choice => ({ preview, row: term, removed: true, entryId: term.externalEntryId ?? "", revisionId: term.revisionId, decision });
        return <tr key={`removed:${term.termId}`}><th scope="row">{term.source}<p className={styles.meta}>{t(term.scopeUnitId ? "proposalScopeEntry" : "proposalScopeProject")}</p></th>
          <td>{term.target}</td><td>{t("proposalRemovalHelp")}</td><td><div className={styles.actions}>
            <Button size="sm" disabled={!term.externalEntryId || !canChoose(make("adopt"))} onClick={() => choose(make("adopt"))}>{t("proposalRemove")}</Button>
            <Button size="sm" disabled={!term.externalEntryId || !canChoose(make("keep"))} onClick={() => choose(make("keep"))}>{t("proposalKeep")}</Button></div></td></tr>;
      })}</tbody></table></div> : state.busyMutation ? <LoadingState label={global("resource.loading")}/> : null}
      {preview && !preview.rows.length && !preview.removed.length ? <EmptyState title={t("proposalFinished")}/> : null}
    </div> : null}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open) confirm(null); }} title={t("proposalConfirmTitle")}
      description={t("proposalConfirmHelp")} closeLabel={t("proposalCancel")}
      footer={<><Button onClick={() => confirm(null)}>{t("proposalCancel")}</Button><Button variant="primary"
        disabled={!confirmation || !canChoose(confirmation, dialogId)} onClick={() => { if (confirmation) void apply(confirmation, dialogId); }}>
        {t(confirmation?.removed ? "proposalRemove" : "proposalOverride")}</Button></>}>
      {confirmation ? <p className={styles.text}>{confirmation.removed ? confirmation.row.source : confirmation.row.entry.source}</p> : null}
      {confirmation ? <dl className={styles.comparison}><div><dt>{t("proposalCurrent")}</dt><dd>{confirmation.removed
        ? confirmation.row.target : confirmation.row.current?.target ?? t("proposalMissingValue")}</dd></div>
        <div><dt>{t("proposalProposed")}</dt><dd>{confirmation.removed ? t("proposalRemovalHelp") : confirmation.row.entry.target}</dd></div></dl> : null}
      {confirmation && !matching(confirmation, dialogId) ? <Banner tone="warning" action={<Button size="sm" disabled={!present(dialogId) || busy || dirty}
        onClick={() => { if (present(dialogId) && !busy && !dirty) void owner.retryPreview(() => present(dialogId)); }}>{t("proposalReadAgain")}</Button>}>{t("proposalChanged")}</Banner> : null}
      {state.failure ? <CommandFailureDetails failure={state.failure}/> : null}{recovery(dialogId)}
    </Dialog>
  </section>;
}
