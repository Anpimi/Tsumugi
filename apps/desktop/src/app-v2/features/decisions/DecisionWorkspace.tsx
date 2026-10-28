import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import type { DecisionItem } from "../../../decisionCommands";
import type { WorkspaceView, ViewPatch } from "../../workspace/workspaceStore";
import DecisionList from "./DecisionList";
import type { useDecisionFeed } from "./useDecisionFeed";
import styles from "./Decisions.module.css";

const DecisionDetails = lazy(() => import("./DecisionDetails"));
type Feed = ReturnType<typeof useDecisionFeed>;

export default function DecisionWorkspace({ view, feed, disabled, patch, onNavigate, current, onOpenEntry }: {
  view: WorkspaceView; feed: Feed; disabled: boolean; patch: (patch: ViewPatch) => void;
  onNavigate: (item: DecisionItem, current: () => boolean) => Promise<boolean>;
  current: () => boolean;
  onOpenEntry: (unitId: string, locale: string) => Promise<boolean>;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const [capture, setCapture] = useState<DecisionItem | null>(null);
  const [failure, setFailure] = useState<{ cause: unknown | null } | null>(null), [opening, setOpening] = useState(false);
  const flight = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null), region = useRef<HTMLDivElement>(null);
  const detailsRegion = useRef<HTMLDivElement>(null);
  const focusRequest = useRef<{ decisionId: string; origin: HTMLElement | null } | null>(null);
  const page = feed.page.data;
  const chosen = view.focus === capture?.decisionId ? capture : page?.items.find(item => item.decisionId === view.focus) ?? null;
  const selected = chosen && !["compare-candidate", "review-translation", "review-finding", "inspect-local-request", "clarify-conversation-proposal"].includes(chosen.action.kind) ? chosen : null;
  const stale = feed.changed || feed.first.isError || feed.page.isError;
  const blocked = disabled || opening || stale || feed.first.isFetching || feed.page.isFetching;
  useLayoutEffect(() => {
    const request = focusRequest.current;
    if (!request || request.decisionId !== selected?.decisionId) return;
    focusRequest.current = null;
    if (current() && (document.activeElement === request.origin || document.activeElement === document.body)) detailsRegion.current?.focus();
  });
  function back() {
    patch({ focus: null }); setFailure(null);
    requestAnimationFrame(() => { const target = returnFocus.current; if (target?.isConnected) target.focus(); else region.current?.focus(); });
  }
  async function select(item: DecisionItem) {
    if (blocked || flight.current || !page || !feed.current(page.basis) || !current()) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFailure(null);
    if (["compare-candidate", "review-translation", "review-finding", "inspect-local-request", "clarify-conversation-proposal"].includes(item.action.kind)) {
      flight.current = true; setOpening(true);
      try { if (!await onNavigate(item, () => current() && feed.current(page.basis))) setFailure({ cause: null }); }
      catch (cause) { if (current()) setFailure({ cause }); }
      finally { flight.current = false; setOpening(false); }
      return;
    }
    focusRequest.current = { decisionId: item.decisionId, origin: returnFocus.current };
    setCapture(item); patch({ focus: item.decisionId });
  }
  return <div ref={region} tabIndex={-1} className={styles.workspace} aria-label={t("decisions")}>
    {failure ? <Banner tone={failure.cause ? "error" : "warning"}>{t(failure.cause ? "decisionNavigationFailed" : "decisionNavigationChanged")}
      {failure.cause ? <CommandFailureDetails failure={commandFailure(failure.cause)}/> : null}</Banner> : null}
    {feed.changed ? <Banner tone="warning" action={<Button disabled={disabled} onClick={() => { patch({ decisionCursor: null, decisionPrevious: [], focus: null }); void feed.refresh(); }}>{t("decisionReadLatest")}</Button>}>{t("decisionPageChanged")}</Banner> : null}
    {view.focus && !selected && !feed.page.isPending ? <Banner tone="warning" action={<Button onClick={back}>{t("decisionReturnList")}</Button>}>{t("decisionSelectionChanged")}</Banner> : null}
    <div hidden={selected !== null}>
      <DecisionList page={page} loading={feed.page.isPending && !feed.changed} refreshing={feed.page.isFetching || feed.first.isFetching} error={feed.page.error ?? feed.first.error}
        selectedId={view.focus} disabled={disabled || opening || feed.changed} hasPrevious={view.decisionPrevious.length > 0}
        onSelect={item => { void select(item); }} onNext={cursor => patch({ decisionPrevious: [...view.decisionPrevious, view.decisionCursor], decisionCursor: cursor, focus: null })}
        onBack={() => { const previous = [...view.decisionPrevious]; const cursor = previous.pop() ?? null; patch({ decisionCursor: cursor, decisionPrevious: previous, focus: null }); }}
        onRefresh={() => { if (!disabled) void feed.refresh(); }}/>
    </div>
    {selected ? <div ref={detailsRegion} tabIndex={-1} role="region" aria-label={t("decisionTargetRegion")} className={styles.detailFocus}>
      <Suspense fallback={<LoadingState label={t("decisionReadingTarget")}/>}><DecisionDetails item={selected} disabled={disabled}
        current={() => current() && view.focus === selected.decisionId} onBack={back} onOpenEntry={onOpenEntry}/></Suspense>
    </div> : null}
  </div>;
}
