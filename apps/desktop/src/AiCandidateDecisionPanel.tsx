import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CandidateBasis } from "./CandidateDecisionSession";
import { TranslationCandidateDecisionFields } from "./TranslationCandidateDecisionFields";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useSessionAlive, useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { executionContext } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import type { AiView } from "./aiCommands";
import { reviewCommands } from "./reviewCommands";
import { sourceReads } from "./sourceQueries";
import { translationCommands, translationHistoryAfter, type TranslationHistory } from "./translationCommands";
import { useWorkbenchCommands, type AiSavedCandidateCommandPayload, type TranslationCandidateCommandPayload,
  type TranslationCandidatePendingCommandPayload, type CommandAvailability } from "./workbenchCommands";

export function AiCandidateDecisionPanel({ project, disabled, target, currentRow }: {
  project: ProjectView; disabled: boolean; target: AiSavedCandidateCommandPayload | null;
  currentRow: () => { value: AiView; row: AiView["rows"][number] } | null;
}) {
  const { t } = useTranslation(), reads = useSessionReads(), alive = useSessionAlive(), registry = useWorkbenchCommands();
  const draftSession = useTranslationDraftSession(), candidates = draftSession.candidates, context = executionContext(project);
  const committed = useRef({ disabled, currentRow });
  useLayoutEffect(() => { committed.current = { disabled, currentRow }; });
  const [after, setAfter] = useState<string | null>(null), heading = useRef<HTMLHeadingElement>(null);
  const available = !!target && project.metadata.targetLocales.includes(target.locale);
  const sourceOptions = sourceReads.scope(context);
  const sourceRead = useSessionQuery({ ...sourceOptions, enabled: available });
  const editorKey = ["editor-snapshot", target?.translationUnitId ?? null, target?.locale ?? null];
  const editorRead = useSessionQuery({ key: editorKey, scopes: ["source", "translation", "resources", "review"], enabled: available,
    read: () => { if (!target) throw new Error("No candidate target");
      return reviewCommands.editorSnapshot({ ...context, unitId: target.translationUnitId, locale: target.locale }); } });
  const historyKey = ["ai-candidate-history", target?.translationUnitId ?? null, target?.locale ?? null, after];
  const historyRead = useSessionQuery<TranslationHistory>({ key: historyKey, scopes: ["source", "translation"], enabled: available && after !== null,
    read: () => { if (!target || after === null) throw new Error("No candidate history page");
      return translationCommands.history({ ...context, unitId: target.translationUnitId, locale: target.locale, afterOrdinal: after, limit: 100 }); } });
  const snapshot = editorRead.data, history = after === null ? snapshot?.translations : historyRead.data;
  const revision = history?.rows.find(row => row.revisionId === target?.revisionId);
  const scope = { ...context, area: "ai" as const }, unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [alive]);
  useEffect(() => { if (target) heading.current?.focus({ preventScroll: true }); }, [target?.revisionId]);

  function checked(key: readonly unknown[], value: unknown) {
    const query = reads.client.getQueryState(reads.key(key));
    return alive.current && query?.status === "success" && !query.isInvalidated && query.fetchStatus === "idle" && query.error === null && query.data === value;
  }
  function resolve() {
    const original = committed.current.currentRow();
    if (!available || committed.current.disabled || !target || !original || !snapshot || !history || !revision
      || original.row.savedRevisionId !== target.revisionId || original.row.resultId !== target.resultId
      || !checked(editorKey, snapshot) || !checked(sourceOptions.key, sourceRead.data)
      || (after !== null && !checked(historyKey, history)) || !sourceRead.data?.currentSnapshot
      || sourceRead.data.currentSnapshot !== snapshot.target.sourceSnapshotId
      || snapshot.target.unitId !== target.translationUnitId || snapshot.target.locale !== target.locale
      || snapshot.target.sourceRevisionId !== target.sourceRevisionId || history.unitId !== target.translationUnitId || history.locale !== target.locale
      || (history.current?.eventId ?? null) !== (snapshot.translations.current?.eventId ?? null)
      || snapshot.target.selectionId !== (history.current?.eventId ?? null)
      || revision.originKind !== "ai" || revision.unitId !== target.translationUnitId || revision.locale !== target.locale
      || revision.sourceRevisionId !== target.sourceRevisionId || revision.sourceSnapshotId !== target.sourceSnapshotId
      || revision.attemptId !== target.attemptId || revision.itemId !== target.itemId || revision.resultId !== target.resultId) return null;
    const basis: CandidateBasis = { unitId: history.unitId, locale: history.locale, sourceRevisionId: snapshot.target.sourceRevisionId,
      baseSelectionId: history.current?.eventId ?? null, baseRevisionId: history.current?.revisionId ?? null };
    return { revision, basis, original };
  }
  function payload(): TranslationCandidateCommandPayload | undefined {
    const value = resolve(), state = candidates.current();
    return value ? { kind: "translation-candidate", unitId: value.basis.unitId, locale: value.basis.locale,
      sourceRevisionId: value.basis.sourceRevisionId, expectedSelectionId: value.basis.baseSelectionId, editSeq: state.editSeq,
      revisionId: value.revision.revisionId, revisionActionId: value.revision.actionId, revisionOrdinal: value.revision.ordinal,
      revisionSourceRevisionId: value.revision.sourceRevisionId, revisionSourceSnapshotId: value.revision.sourceSnapshotId,
      disposition: value.revision.candidateDecision?.request.disposition === "rejected" ? "restored" : "rejected",
      expectedDecisionId: value.revision.candidateDecision?.request.actionId ?? null, actor: state.actor, reason: state.reason, decisionEditSeq: state.editSeq } : undefined;
  }
  function availability(input?: TranslationCandidateCommandPayload): CommandAvailability {
    const value = resolve(), expected = payload();
    return input && expected && value && !candidates.blocked() && !draftSession.mutationReserved
      && input.actor.trim() && input.reason.trim() && value.revision.revisionId !== value.basis.baseRevisionId
      && Object.entries(expected).every(([key, field]) => input[key as keyof typeof input] === field) ? { enabled: true } : unavailable;
  }
  function pendingPayload(): TranslationCandidatePendingCommandPayload | undefined {
    const request = candidates.current().pending;
    return request ? { kind: "translation-candidate-pending", request: structuredClone(request) } : undefined;
  }
  function recoveryAvailability(input?: TranslationCandidatePendingCommandPayload, retry = false): CommandAvailability {
    const state = candidates.current();
    return alive.current && !disabled && !state.busy && input && state.pending && JSON.stringify(input.request) === JSON.stringify(state.pending)
      && (!retry || state.checkedMissing) ? { enabled: true } : unavailable;
  }
  function decide(input: TranslationCandidateCommandPayload) {
    const value = resolve(); if (!value || !availability(input).enabled || !target) return;
    const keys = [sourceOptions.key, editorKey, ...(after === null ? [] : [historyKey]), ["aiCommands", target.attemptId]];
    const witnesses = keys.map(key => { const query = reads.client.getQueryCache().find({ queryKey: reads.key(key), exact: true });
      return { key, query, version: query?.state.dataUpdateCount }; });
    const proof = () => alive.current && witnesses.every(({ key, query, version }) => !!query && reads.client.getQueryCache().find({ queryKey: reads.key(key), exact: true }) === query && query.state.dataUpdateCount === version && !query.state.isInvalidated
      && query.state.status === "success" && query.state.error === null && query.state.fetchStatus === "idle")
      && resolve()?.revision === value.revision && committed.current.currentRow()?.value === value.original.value;
    // Explicit checked basis leaves any unrelated manual editor draft untouched.
    void candidates.decide(value.revision, input.disposition, proof, () => proof() ? resolve()?.basis ?? null : null);
  }
  useLayoutEffect(() => {
    const metadata = { category: "ai" as const, scope, binding: null, confirmation: "none" as const };
    const remove = [
      registry.register({ ...metadata, id: "ai.decide-candidate", nameKey: "candidateDecisions.title", risk: "writes-translation", payloadKind: "translation-candidate", availability, handler: decide }),
      registry.register({ ...metadata, id: "ai.check-candidate-decision", nameKey: "candidateDecisions.check", risk: "reconciles-execution-action", payloadKind: "translation-candidate-pending",
        availability: input => recoveryAvailability(input), handler: () => { void candidates.check(); } }),
      registry.register({ ...metadata, id: "ai.retry-candidate-decision", nameKey: "candidateDecisions.retry", risk: "retries-execution-action", payloadKind: "translation-candidate-pending",
        availability: input => recoveryAvailability(input, true), handler: () => { void candidates.retry(); } }),
    ];
    return () => remove.forEach(dispose => dispose());
  });
  if (!target && !candidates.state.pending && !candidates.hasDraft()) return null;
  const loading = editorRead.isFetching || after !== null && historyRead.isFetching;
  return <section aria-label={t("candidateDecisions.title")}>
    <h3 ref={heading} tabIndex={-1}>{t("candidateDecisions.title")}</h3><p>{t("candidateDecisions.help")}</p>
    {target ? <><p>{t("candidateDecisions.reviewTarget", { key: currentRow()?.row.item.nativeKey ?? "", locale: target.locale })}</p>
      {loading ? <p role="status">{t("candidateDecisions.loading")}</p> : null}
      {revision ? <><pre className="ai-text">{revision.text}</pre><p>{t("ai.origin")}</p>
        {revision.candidateDecision ? <p role="status">{t(revision.candidateDecision.request.disposition === "rejected" ? "candidateDecisions.rejected" : "candidateDecisions.restored")} · {revision.candidateDecision.request.actor}: {revision.candidateDecision.request.reason}</p> : null}</> : null}
      {!loading && !resolve() ? <p role="status">{t("candidateDecisions.unavailable")}</p> : null}
      {revision && revision.revisionId === history?.current?.revisionId ? <p role="status">{t("candidateDecisions.selected")}</p> : null}
      {history ? <div className="execution-actions">
        <button className="secondary-button" disabled={loading || candidates.blocked() || !history.rows.length || history.rows[0].ordinal === "1"
          || !checked(after === null ? editorKey : historyKey, after === null ? snapshot : history)}
          onClick={() => setAfter(translationHistoryAfter(history.rows[0]?.ordinal ?? "1", 101))}>{t("candidateDecisions.earlierHistory")}</button>
        {history.nextOrdinal !== null ? <button className="secondary-button" disabled={loading || candidates.blocked()
          || !checked(after === null ? editorKey : historyKey, after === null ? snapshot : history)}
          onClick={() => setAfter(history.nextOrdinal)}>{t("candidateDecisions.nextHistory")}</button> : null}
      </div> : null}
      <button className="secondary-button" disabled={loading || candidates.blocked()} onClick={() => { void sourceRead.refetch(); void editorRead.refetch(); if (after !== null) void historyRead.refetch(); }}>{t("candidateDecisions.refresh")}</button>
    </> : null}
    <TranslationCandidateDecisionFields canCheck={recoveryAvailability(pendingPayload()).enabled} canRetry={recoveryAvailability(pendingPayload(), true).enabled}
      onCheck={() => { const input = pendingPayload(); if (input) registry.dispatch("ai.check-candidate-decision", scope, input); }}
      onRetry={() => { const input = pendingPayload(); if (input) registry.dispatch("ai.retry-candidate-decision", scope, input); }} />
    {target ? <button className="secondary-button" disabled={!availability(payload()).enabled} onClick={() => { const input = payload(); if (input) registry.dispatch("ai.decide-candidate", scope, input); }}>{t(revision?.candidateDecision?.request.disposition === "rejected" ? "candidateDecisions.restore" : "candidateDecisions.reject")}</button> : null}
  </section>;
}
