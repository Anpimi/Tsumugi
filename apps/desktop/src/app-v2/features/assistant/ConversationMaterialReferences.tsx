import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { conversationCommands, type ConversationMaterialReference, type ConversationPlanningRun } from "../../../conversationCommands";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import type { SessionRequest } from "../../../executionCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { OpenConversationEntryReference } from "./ConversationEntryReferences";
import { materialEntryReference, materialReferenceIdentity, referencesMatchPlanning } from "./materialReferenceReads";
import styles from "./ConversationMaterialReferences.module.css";

interface Props {
  context: SessionRequest; run: ConversationPlanningRun; visible: boolean; disabled: boolean;
  gate: InteractionGate; viewId: string | null; parentDialogId?: string; onOpenEntry?: OpenConversationEntryReference;
}

/** References come from the original typed material, not interpreted reply prose. */
export function ConversationMaterialReferences({ context, run, visible, disabled, gate, viewId, parentDialogId, onOpenEntry }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" }), reads = useSessionReads(), id = useId();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const [expanded, setExpanded] = useState(false), [after, setAfter] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  const mounted = useRef(true), flight = useRef<{ dispose: () => void } | null>(null), dialogRelease = useRef<(() => void) | null>(null);
  const region = useRef<HTMLElement>(null), dialogId = `conversation-reference-${id}`;
  const identity = JSON.stringify([context, run.receipt.inputDigest, run.detail.attemptId]);
  const live = useRef({ identity, visible, disabled, onOpenEntry, viewId, parentDialogId });
  useLayoutEffect(() => { live.current = { identity, visible, disabled, onOpenEntry, viewId, parentDialogId }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; flight.current?.dispose(); flight.current = null; dialogRelease.current?.(); }; }, []);
  useLayoutEffect(() => { flight.current?.dispose(); flight.current = null; setBusy(false); }, [identity, visible, disabled]);
  const present = (dialog?: string) => mounted.current && live.current.identity === identity && live.current.visible && !live.current.disabled
    && live.current.viewId === viewId && !reads.retired && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
    && gate.canDispatch({ viewId, source: "button", dialogId: dialog ?? parentDialogId });
  const key = ["conversation-material-references", run.preview.conversationId, run.detail.attemptId, run.receipt.inputDigest, after] as const;
  const read = useSessionQuery({ key, scopes: ["project", "source", "resources", "execution"], enabled: expanded && visible && !disabled,
    structuralSharing: false, read: async () => {
      const page = await conversationCommands.references({ ...context, conversationId: run.preview.conversationId, attemptId: run.detail.attemptId, after, limit: 8 });
      if (!page || !referencesMatchPlanning(page, run)) throw new Error("The original reference material changed");
      return page;
    } });
  const page = !read.error ? read.data ?? null : null;
  function isFresh() {
    const query = reads.client.getQueryState(reads.key(key));
    return !!page && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.data === page;
  }
  const fresh = !read.isStale && isFresh();
  const detail = page?.rows.find(row => materialReferenceIdentity(row) === selected) ?? null;
  function closeDetail() { dialogRelease.current?.(); dialogRelease.current = null; setSelected(null); }
  useLayoutEffect(() => {
    if (!detail || !visible || disabled) { closeDetail(); return; }
    if (!dialogRelease.current) dialogRelease.current = gate.pushDialog(dialogId);
    return () => { dialogRelease.current?.(); dialogRelease.current = null; };
  }, [!!detail, visible, disabled, gate, dialogId]);
  function refresh() { if (present() && !read.isFetching && !flight.current) { setFailed(false); void read.refetch(); } }
  async function locate(row: ConversationMaterialReference, origin: HTMLElement) {
    const callback = onOpenEntry, expected = page;
    if (!callback || !expected || !isFresh() || !present() || flight.current || !expected.rows.includes(row)
      || expected.currentSnapshotId !== row.unit.sourceSnapshotId) return;
    const witness = reads.watchExactQuery(key), original = witness.current(), version = original?.state.dataUpdateCount;
    const action = { dispose: () => witness.dispose() };
    const current = () => flight.current === action && present() && live.current.onOpenEntry === callback
      && witness.current() === original && original?.state.dataUpdateCount === version
      && original?.state.fetchStatus === "idle" && !original.state.isInvalidated && original.state.error === null && original.state.data === expected;
    if (document.activeElement === origin) region.current?.focus();
    flight.current = action; setBusy(true); setFailed(false);
    try { if (current() && !await callback(materialEntryReference(run, row), current) && current()) setFailed(true); }
    catch { if (current()) setFailed(true); }
    finally { action.dispose(); if (flight.current === action) { flight.current = null; if (mounted.current) setBusy(false); } }
  }
  const label = (row: ConversationMaterialReference) => row.kind === "term" ? row.original.source : row.logicalPath;
  return <section ref={region} tabIndex={-1} className={styles.references} hidden={!visible} aria-label={t("materialReferences")}>
    <div><Button size="sm" aria-expanded={expanded} aria-controls={id} disabled={!present() || busy} onClick={() => {
      if (!present() || busy) return; setExpanded(value => !value);
    }}>{t(expanded ? "hideMaterialReferences" : "showMaterialReferences")}</Button></div>
    {expanded ? <div id={id} className={styles.body}>
      <p>{t("materialReferencesHelp")}</p>
      {read.isPending ? <LoadingState label={t("materialReferencesLoading")}/> : null}
      {read.error ? <Banner tone="error" role="alert"><p>{t("materialReferencesFailed")}</p><CommandFailureDetails failure={commandFailure(read.error)}/></Banner> : null}
      {failed ? <Banner tone="warning" role="status">{t("materialReferenceChanged")}</Banner> : null}
      {page ? <><p>{t("materialReferencesCount", { count: page.total })}</p>
        {!fresh ? <p role="status">{t("materialReferencesStale")}</p> : null}
        {page.rows.length ? <ul className={styles.links}>{page.rows.map(row => <li key={materialReferenceIdentity(row)}>
          <span>{t(row.kind === "term" ? "materialTerm" : "materialFile")}</span>
          <Button size="sm" className={styles.referenceLink} aria-label={t("locateMaterialReference", { name: label(row) })}
            disabled={!fresh || !present() || busy || !onOpenEntry || page.currentSnapshotId !== row.unit.sourceSnapshotId}
            onClick={event => void locate(row, event.currentTarget)}><TokenizedText text={label(row)}/></Button>
          <Button size="sm" disabled={!fresh || !present() || busy} aria-label={t("inspectMaterialReference", { name: label(row) })}
            onClick={() => { if (isFresh() && present() && !flight.current) setSelected(materialReferenceIdentity(row)); }}>{t("inspectMaterialReferenceShort")}</Button>
        </li>)}</ul> : <p>{t("materialReferencesEmpty")}</p>}
        {page.currentSnapshotId !== run.preview.units[0]?.sourceSnapshotId && page.rows.length ? <p>{t("materialSourceHistorical")}</p> : null}
        <div className={styles.actions}>
          <Button size="sm" disabled={!present() || busy || read.isFetching || after === 0} onClick={() => { if (present() && !flight.current) { setFailed(false); setAfter(0); } }}>{t("materialReferencesFirst")}</Button>
          {page.nextAfter !== null ? <Button size="sm" disabled={!present() || !fresh || busy} onClick={() => { if (present() && !flight.current && page.nextAfter !== null) { setFailed(false); setAfter(page.nextAfter); } }}>{t("materialReferencesMore")}</Button> : null}
        </div>
      </> : null}
      <Button size="sm" pending={read.isFetching} disabled={!present() || busy || read.isFetching} onClick={refresh}>{t("materialReferencesRefresh")}</Button>
    </div> : null}
    <Dialog open={!!detail && visible} onOpenChange={open => { if (!open) closeDetail(); }} title={t("materialReferenceDetails")} closeLabel={t("materialReferenceClose")}>
      {detail ? <div className={styles.body}>
        {!fresh ? <Banner tone="warning" role="status">{t("materialReferencesStale")}</Banner> : null}
        <Button size="sm" pending={read.isFetching} disabled={!present(dialogId) || read.isFetching} onClick={() => {
          if (present(dialogId) && !read.isFetching) void read.refetch();
        }}>{t("materialReferencesRefresh")}</Button>
        <p><TokenizedText text={label(detail)}/></p>
        {detail.kind === "term" ? <>
          <dl><dt>{t("materialOriginalTarget")}</dt><dd><TokenizedText text={detail.original.target}/></dd>
            <dt>{t("materialCurrentTarget")}</dt><dd>{detail.current ? <TokenizedText text={detail.current.target}/> : t("materialCurrentMissing")}</dd></dl>
          {!detail.current || detail.current.revisionId !== detail.original.revisionId || detail.current.removed ? <p>{t("materialTermHistorical")}</p> : <p>{t("materialTermCurrent")}</p>}
        </> : <p>{t("materialFileEvidence")}</p>}
        {page?.currentSnapshotId !== detail.unit.sourceSnapshotId ? <p>{t("materialSourceHistorical")}</p> : null}
        <p>{t("materialReferenceReadOnly")}</p>
      </div> : null}
    </Dialog>
  </section>;
}
