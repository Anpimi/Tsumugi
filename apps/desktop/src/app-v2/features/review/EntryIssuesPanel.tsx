import { Disclosure } from "../../../design-system/Disclosure";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { matchQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { semanticReviewRead } from "../../../aiSemanticReviewQueries";
import type { AiSemanticReviewView } from "../../../aiSemanticReviewCommands";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import { sameDraftBasis, sameDraftValue } from "../../../draftCommands";
import { executionContext } from "../../../executionCommands";
import { reviewDraftKey } from "../../../ReviewDraftSession";
import { reviewCommands, sameAiOrigin, type AdvisoryFinding, type ReviewFindingDecision, type ReviewFindingView, type ReviewTarget } from "../../../reviewCommands";
import { currentDiagnosticRun, currentSemanticDiagnosticRun, diagnosticIntentMatchesTarget, diagnosticLocationMatchesTarget, diagnosticTextareaSelection,
  reviewDiagnostics, semanticReviewDiagnostics, sameReviewBasis, validDiagnosticSelection, type ReviewDiagnosticIntent } from "../../../reviewDiagnosticNavigation";
import { reviewFindingsRead } from "../../../reviewQueries";
import { ruleIdentity } from "../../../reviewIdentity";
import { reviewFindingLabel, reviewRuleLabel } from "../../../reviewLabels";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import type { CommandAvailability } from "../../../workbenchCommands";
import { Button } from "../../../design-system/Button";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { EntryIssueCapture, EntryIssueFindingPayload, EntryIssueLocatePayload, EntryIssuesPanelProps, EntryIssuesReadPayload, EntryIssueWaiverPayload } from "./issuesTypes";
import styles from "./EntryIssuesPanel.module.css";

const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
type IssuesCursor = { scope: string; identity: string; initial: EntryIssuesPanelProps["initialFinding"]; offset: number; navigation: "requested" | "browsing" | "changed" };
function targetMatches(capture: EntryIssueCapture, target: ReviewTarget) {
  return capture.unitId === target.unitId && capture.locale === target.locale && capture.basis === target.basis
    && capture.sourceSnapshotId === target.sourceSnapshotId && capture.sourceRevisionId === target.sourceRevisionId
    && capture.selectionId === target.selectionId && capture.revisionId === target.revisionId && sameReviewBasis(capture.basisEvidence, target.basisEvidence);
}

/** Current QA and advisory evidence remain distinct; audit input and original actions belong to the shared Review owner. */
export default function EntryIssuesPanel({ project, target, owner, drafts, commands, gate, viewId, disabled, visible, parentDialogId, read, initialFinding, onEdit, onReviewEdit }: EntryIssuesPanelProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), { t: legacy } = useTranslation(), reads = useSessionReads();
  const state = owner.state, shared = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const context = executionContext(project), commandScope = { ...context, area: "translation" as const };
  const scope = JSON.stringify([context.projectId, context.sessionToken, target.unitId, target.locale, viewId]);
  const targetIdentity = JSON.stringify([scope, target.basis, target.basisEvidence, target.sourceText, target.translationText, target.currentCheck?.runId]);
  const [cursor, setCursor] = useState<IssuesCursor>({ scope, identity: targetIdentity, initial: initialFinding, offset: initialFinding?.offset ?? 0,
    navigation: initialFinding ? "requested" : "browsing" });
  const newNavigation = cursor.initial !== initialFinding, changedTarget = cursor.scope !== scope || cursor.identity !== targetIdentity;
  if (newNavigation) setCursor({ scope, identity: targetIdentity, initial: initialFinding, offset: initialFinding?.offset ?? 0, navigation: initialFinding ? "requested" : "browsing" });
  else if (changedTarget) setCursor({ ...cursor, scope, identity: targetIdentity, offset: 0, navigation: initialFinding ? "changed" : "browsing" });
  const offset = newNavigation ? initialFinding?.offset ?? 0 : changedTarget ? 0 : cursor.offset;
  const navigationMode = newNavigation ? initialFinding ? "requested" : "browsing" : changedTarget ? "changed" : cursor.navigation;
  const requestedFinding = navigationMode === "requested" ? initialFinding : null;
  const options = reviewFindingsRead(context, target.unitId, target.locale, offset);
  const findings = useSessionQuery({ ...options, enabled: visible && !disabled && !reads.retired });
  const record = useMemo(() => {
    const filters = { queryKey: reads.key(read.key), exact: true }, cache = reads.client.getQueryCache();
    return { subscribe: (notify: () => void) => cache.subscribe(event => { if (matchQuery(filters, event.query)) notify(); }), snapshot: () => cache.find(filters)?.state };
  }, [reads, JSON.stringify(read.key)]);
  useSyncExternalStore(record.subscribe, record.snapshot, record.snapshot);
  const mounted = useRef(false), flight = useRef(false), live = useRef({ scope, targetIdentity, visible, disabled, parentDialogId });
  const root = useRef<HTMLElement>(null), result = useRef<HTMLDivElement>(null), focus = useRef<{ scope: string; identity: string; origin: HTMLButtonElement } | null>(null);
  const findingCard = useRef<HTMLElement>(null), seenFinding = useRef<{ scope: string; request: EntryIssuesPanelProps["initialFinding"] } | null>(null);
  const findingFocus = useRef<{ scope: string; identity: string; origin: Element | null; moved: boolean; dispose: () => void } | null>(null);
  const [working, setWorking] = useState(false), [feedback, setFeedback] = useState<{ scope: string; kind: "saved" | "changed" | "failed" } | null>(null);
  const [navigation, setNavigation] = useState<{ identity: string; kind: "loading" | "changed" | "failed" } | null>(null);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; findingFocus.current?.dispose(); findingFocus.current = null; }; }, []);
  useLayoutEffect(() => { live.current = { scope, targetIdentity, visible, disabled, parentDialogId }; });
  function present() {
    return mounted.current && visible && !disabled && !reads.retired && !drafts.getSnapshot().retired
      && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
      && live.current.scope === scope && live.current.targetIdentity === targetIdentity && live.current.visible && !live.current.disabled && live.current.parentDialogId === parentDialogId
      && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  }
  useLayoutEffect(() => {
    if (working || !focus.current) return;
    const ticket = focus.current; focus.current = null;
    if (ticket.scope === scope && ticket.identity === targetIdentity && present() && (document.activeElement === document.body || document.activeElement === ticket.origin)) result.current?.focus();
  });
  function parentFresh() {
    const current = reads.client.getQueryCache().find({ queryKey: reads.key(read.key), exact: true });
    return !!current && current.state.status === "success" && current.state.fetchStatus === "idle" && !current.state.error
      && !current.state.isInvalidated && current.state.data === read.data;
  }
  function currentPage() {
    const current = reads.client.getQueryState<ReviewFindingView>(reads.key(options.key)), value = current?.data;
    return parentFresh() && current?.status === "success" && current.fetchStatus === "idle" && !current.error && !current.isInvalidated
      && !!value && value === findings.data && value.unitId === target.unitId && value.locale === target.locale && value.basis === target.basis
      && value.runId === (target.currentCheck?.runId ?? null) ? value : null;
  }
  const page = currentPage();
  const requested = (runId: string, issueId: string) => requestedFinding?.runId === runId && requestedFinding.issueId === issueId;
  const requestedAdvisory = page?.findings.find(item => requested(item.runId, item.finding.issueId) && item.decision?.request.disposition !== "rejected");
  const requestedRepair = !requestedAdvisory ? page?.repairs.find(item => requested(item.recheckRunId ?? item.decision.request.runId, item.decision.request.issueId)
    && (item.status === "awaiting-current-recheck" || item.status === "current-rule-findings")) : undefined;
  const decisionChanged = !!initialFinding && (navigationMode === "changed" || navigationMode === "requested" && !!page && !requestedAdvisory && !requestedRepair);
  useLayoutEffect(() => {
    if (!seenFinding.current || seenFinding.current.scope !== scope || seenFinding.current.request !== initialFinding) {
      findingFocus.current?.dispose(); findingFocus.current = null;
      seenFinding.current = { scope, request: initialFinding };
      if (initialFinding && visible && !disabled) {
        const ticket = { scope, identity: targetIdentity, origin: document.activeElement, moved: false, dispose: () => document.removeEventListener("focusin", moved) };
        const moved = (event: FocusEvent) => { if (event.target !== ticket.origin) ticket.moved = true; };
        document.addEventListener("focusin", moved); findingFocus.current = ticket;
      }
    }
    const ticket = findingFocus.current;
    if (!ticket) return;
    if (ticket.scope !== scope || ticket.identity !== targetIdentity || !visible || disabled || ticket.moved || navigationMode !== "requested") {
      ticket.dispose(); findingFocus.current = null; return;
    }
    if (!page || !present()) return;
    ticket.dispose(); findingFocus.current = null;
    if (document.activeElement === ticket.origin && (requestedAdvisory || requestedRepair)) findingCard.current?.focus();
  });
  const aiOrigin = page?.findings.find(item => item.purpose === "ai-semantic" && item.runId === page.semanticRunId)?.aiOrigin ?? null;
  const semanticOptions = semanticReviewRead(context, aiOrigin?.attemptId ?? null);
  const semantic = useSessionQuery({ ...semanticOptions, enabled: visible && !disabled && !reads.retired && !!aiOrigin });
  function semanticRun(item: AdvisoryFinding) {
    const current = reads.client.getQueryState<AiSemanticReviewView | null>(reads.key(semanticOptions.key));
    return item.aiOrigin && current?.status === "success" && current.fetchStatus === "idle" && !current.error && !current.isInvalidated
      ? currentSemanticDiagnosticRun(target, item.runId, item.aiOrigin, { findings: currentPage(), view: current.data }) : null;
  }
  const completed = useRef(state.completionVersion);
  useEffect(() => {
    if (completed.current === state.completionVersion) return;
    completed.current = state.completionVersion;
    void reads.client.invalidateQueries({ queryKey: reads.key(["review-findings", target.unitId, target.locale]) });
    setCursor(before => ({ ...before, scope, identity: targetIdentity, offset: 0, navigation: "browsing" }));
  }, [state.completionVersion, reads, scope, target.unitId, target.locale]);
  function audit(): EntryIssueCapture | null {
    const current = owner.current(), selected = current.selected;
    if (!selected || selected.unitId !== target.unitId || selected.locale !== target.locale) return null;
    return { unitId: selected.unitId, locale: selected.locale, basis: selected.basis, sourceSnapshotId: selected.sourceSnapshotId,
      sourceRevisionId: selected.sourceRevisionId, selectionId: selected.selectionId, revisionId: selected.revisionId, basisEvidence: selected.basisEvidence,
      actor: current.actor, reason: current.drafts[reviewDraftKey(selected)] ?? "", editSeq: current.editSeq[reviewDraftKey(selected)] ?? 0 };
  }
  function canWrite(payload: EntryIssueCapture | undefined) {
    const current = owner.current(), captured = audit(), shared = drafts.getSnapshot();
    return present() && parentFresh() && project.metadata.targetLocales.includes(target.locale) && !flight.current
      && !owner.inFlight() && !current.busyMutation && !current.pending && !current.batchRunning && shared.hydration === "ready" && !shared.mutationReserved
      && !!payload && !!captured && targetMatches(payload, target) && targetMatches(captured, target)
      && payload.actor === captured.actor && payload.reason === captured.reason && payload.editSeq === captured.editSeq
      && payload.actor.trim() !== "" && payload.reason.trim() !== "";
  }
  function qaRun() { return target.currentCheck && currentDiagnosticRun(target, target.currentCheck) ? target.currentCheck : null; }
  function waiverAvailability(payload: EntryIssueWaiverPayload | undefined): CommandAvailability {
    if (!payload || !canWrite(payload)) return unavailable;
    const run = qaRun(), finding = run?.rules.filter(rule => rule.mandatory).flatMap(rule => rule.findings).find(item => item.issueId === payload.issueId);
    const waiver = target.currentWaivers.find(item => item.issueId === payload.issueId && item.grant && item.basis === target.basis);
    return run?.runId === payload.runId && finding && (payload.grant ? finding.waivable && !waiver && payload.expectedWaiverId === null
      : !!waiver && payload.expectedWaiverId === waiver.waiverId) ? { enabled: true } : unavailable;
  }
  function findingAvailability(payload: EntryIssueFindingPayload | undefined): CommandAvailability {
    if (!payload || !canWrite(payload)) return unavailable;
    const view = currentPage(), item = view?.findings.find(value => value.runId === payload.runId && value.finding.issueId === payload.issueId && value.purpose === payload.purpose);
    if (!item || item.requirement.mandatory || item.requirement.waivable || item.requirement.notApplicable !== null
      || JSON.stringify(item) !== JSON.stringify(payload.evidence) || payload.expectedDecisionId !== (item.decision?.decisionId ?? null)) return unavailable;
    const run = item.purpose === "qa" ? qaRun() : semanticRun(item);
    if (!run || run.runId !== item.runId || item.runId !== (item.purpose === "qa" ? view?.runId : view?.semanticRunId)
      || !run.rules.some(rule => !rule.mandatory && ruleIdentity(rule.key) === ruleIdentity(item.requirement.key)
        && rule.findings.some(finding => finding.issueId === item.finding.issueId))) return unavailable;
    const prior = item.decision?.request.disposition;
    return payload.disposition === "restored" ? prior === "rejected" ? { enabled: true } : unavailable
      : prior !== "rejected" && (payload.disposition !== "repair-requested" || prior !== "repair-requested") ? { enabled: true } : unavailable;
  }
  function proof(keys: readonly (readonly unknown[])[]) {
    const witnesses = keys.map(key => { const witness = reads.watchExactQuery(key), query = witness.current(), version = query?.state.dataUpdateCount;
      return { ...witness, valid: () => witness.current() === query && query !== undefined && query.state.status === "success" && query.state.fetchStatus === "idle"
        && !query.state.error && !query.state.isInvalidated && query.state.dataUpdateCount === version }; });
    return { current: () => present() && project.metadata.targetLocales.includes(target.locale) && parentFresh() && witnesses.every(value => value.valid()),
      dispose: () => witnesses.forEach(value => value.dispose()) };
  }
  function inputProof(field?: "source" | "translation") {
    const key = { projectId: context.projectId, unitId: target.unitId, locale: target.locale };
    const captured = drafts.getEntry(key)?.value ?? null, version = drafts.inputVersion();
    const basis = { sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, text: target.translationText };
    return () => {
      if (drafts.inputVersion() !== version) return false;
      const entry = drafts.getEntry(key), value = entry?.value ?? null;
      if (captured) return value !== null && sameDraftValue(captured, value);
      if (value === null) return true;
      if (!entry || !entry.basisCurrent || value.pending !== null || value.merge != null || !sameDraftBasis(value.basis, basis)) return false;
      // A Host read can reveal pre-existing input without creating a new user
      // intent. Source-only focus and ordinary editing keep that input intact.
      if (field !== "translation" && entry.head.value && sameDraftValue(entry.head.value, value)) return true;
      return entry.head.value === null && value.editSeq === "0" && value.text === (target.translationText ?? "");
    };
  }
  function cleanLocationInput(payload: EntryIssueLocatePayload) {
    const entry = drafts.getEntry({ projectId: context.projectId, unitId: target.unitId, locale: target.locale });
    if (!entry) return true;
    const value = entry.value;
    return value !== null && entry.basisCurrent && value.pending === null && value.merge == null
      && (payload.intent.diagnostic.location?.field === "source" || value.text === (target.translationText ?? ""))
      && sameDraftBasis(value.basis, { sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, text: target.translationText });
  }
  function semanticFacts() {
    const current = reads.client.getQueryState<AiSemanticReviewView | null>(reads.key(semanticOptions.key));
    return { findings: currentPage(), view: current?.status === "success" && current.fetchStatus === "idle" && !current.error && !current.isInvalidated ? current.data : null };
  }
  function locateCurrent(payload: EntryIssueLocatePayload) {
    if (payload.unitId !== target.unitId || payload.locale !== target.locale || payload.basis !== target.basis) return false;
    const intent = payload.intent;
    if (intent.source.purpose === "qa") return diagnosticIntentMatchesTarget(intent, target) && !!qaRun()?.rules.some(rule => ruleIdentity(rule.key) === ruleIdentity(intent.diagnostic.key)
      && rule.findings.some(finding => finding.code === intent.diagnostic.code));
    if (!currentPage() || !diagnosticIntentMatchesTarget(intent, target, semanticFacts())) return false;
    const origin = intent.source.origin;
    return !!currentPage()?.findings.some(item => item.purpose === "ai-semantic" && item.runId === intent.runId && sameAiOrigin(item.aiOrigin, origin)
      && ruleIdentity(item.requirement.key) === ruleIdentity(intent.diagnostic.key) && item.finding.code === intent.diagnostic.code);
  }
  function locateAvailability(payload: EntryIssueLocatePayload | undefined): CommandAvailability {
    return payload && onReviewEdit && present() && project.metadata.targetLocales.includes(target.locale) && !flight.current
      && parentFresh() && cleanLocationInput(payload) && locateCurrent(payload) ? { enabled: true } : unavailable;
  }
  async function openEditor(payload?: EntryIssueLocatePayload) {
    if (payload ? !locateAvailability(payload).enabled : !readAvailability(readPayload("edit")).enabled) return;
    const witness = proof([read.key, ...(payload?.intent.source.purpose === "ai-semantic" ? [options.key, semanticOptions.key] : [])]);
    const unchangedInput = inputProof(payload?.intent.diagnostic.location?.field), current = () => witness.current() && unchangedInput() && (!payload || locateCurrent(payload));
    const origin = document.activeElement instanceof HTMLButtonElement && root.current?.contains(document.activeElement) ? document.activeElement : null;
    let opened = false;
    flight.current = true; setWorking(true); setNavigation({ identity: targetIdentity, kind: "loading" });
    try {
      if (!current()) { setNavigation({ identity: targetIdentity, kind: "changed" }); return; }
      if (payload) {
        const intent = payload.intent;
        const location = await reviewCommands.diagnosticLocation({ ...context, unitId: target.unitId, locale: target.locale, runId: intent.runId, diagnostic: intent.diagnostic });
        const text = location.location.field === "source" ? target.sourceText : target.translationText;
        if (!current() || !diagnosticLocationMatchesTarget(location, intent, target, semanticFacts()) || text === null
          || !validDiagnosticSelection(text, location.location.range) || !diagnosticTextareaSelection(text, location.location.range)) {
          if (present()) setNavigation({ identity: targetIdentity, kind: "changed" }); return;
        }
        if (onReviewEdit) {
          if (origin && document.activeElement === origin) origin.blur();
          opened = await onReviewEdit({ target, diagnostic: { intent, location } }, current);
        }
      } else if (onReviewEdit) {
        if (origin && document.activeElement === origin) origin.blur();
        opened = await onReviewEdit({ target }, current);
      } else if (current() && onEdit) { onEdit(); opened = true; }
      if (present()) setNavigation(opened ? null : { identity: targetIdentity, kind: "changed" });
    } catch {
      if (present()) setNavigation({ identity: targetIdentity, kind: "failed" });
    } finally {
      witness.dispose(); flight.current = false;
      if (mounted.current) {
        setNavigation(before => before?.identity === targetIdentity && before.kind === "loading" ? opened ? null : { identity: targetIdentity, kind: "changed" } : before);
        if (!opened && origin) focus.current = { scope, identity: targetIdentity, origin };
        setWorking(false);
      }
    }
  }
  async function write(payload: EntryIssueFindingPayload | EntryIssueWaiverPayload) {
    const allowed = payload.kind === "entry-issue-waiver" ? waiverAvailability(payload) : findingAvailability(payload);
    if (!allowed.enabled) return;
    const keys = payload.kind === "entry-issue-finding" ? [read.key, options.key, ...(payload.purpose === "ai-semantic" ? [semanticOptions.key] : [])] : [read.key];
    const witness = proof(keys), before = owner.current().completionVersion;
    const origin = document.activeElement instanceof HTMLButtonElement && root.current?.contains(document.activeElement) ? document.activeElement : null;
    // The owner freezes audit A before identity. Editing B and this action's own
    // reservation do not invalidate the immutable query evidence for A.
    flight.current = true; setWorking(true); setFeedback(null);
    try {
      if (payload.kind === "entry-issue-waiver") await owner.waive(payload.issueId, payload.grant, payload.expectedWaiverId, witness.current);
      else await owner.finding({ runId: payload.runId, issueId: payload.issueId, expectedDecisionId: payload.expectedDecisionId,
        disposition: payload.disposition, evidence: payload.evidence }, witness.current);
      if (present() && !owner.current().pending) setFeedback({ scope, kind: owner.current().completionVersion !== before ? "saved"
        : owner.current().notice === "error" ? "failed" : "changed" });
    } finally { witness.dispose(); flight.current = false; if (mounted.current) { if (origin) focus.current = { scope, identity: targetIdentity, origin }; setWorking(false); } }
  }
  function readPayload(operation: EntryIssuesReadPayload["operation"]): EntryIssuesReadPayload {
    return { kind: "entry-issues-read", unitId: target.unitId, locale: target.locale, basis: target.basis, offset, operation, semanticAttemptId: aiOrigin?.attemptId ?? null };
  }
  function readAvailability(payload: EntryIssuesReadPayload | undefined): CommandAvailability {
    if (!payload || !present() || payload.unitId !== target.unitId || payload.locale !== target.locale || payload.basis !== target.basis || payload.offset !== offset
      || payload.semanticAttemptId !== (aiOrigin?.attemptId ?? null)) return unavailable;
    return payload.operation === "edit" ? (onReviewEdit || onEdit) && !flight.current && parentFresh() ? { enabled: true } : unavailable
      : payload.operation === "semantic" ? aiOrigin && !semantic.isFetching ? { enabled: true } : unavailable
      : !findings.isFetching && (payload.operation === "refresh" || payload.operation === "first" && offset > 0
        || payload.operation === "next" && (currentPage()?.nextOffset ?? offset) > offset) ? { enabled: true } : unavailable;
  }
  function readAction(payload: EntryIssuesReadPayload) {
    if (!readAvailability(payload).enabled) return;
    if (payload.operation === "edit") void openEditor();
    else if (payload.operation === "refresh") void findings.refetch();
    else if (payload.operation === "semantic") void semantic.refetch();
    else if (payload.operation === "first") setCursor(before => ({ ...before, scope, identity: targetIdentity, offset: 0, navigation: "browsing" }));
    else { const next = currentPage()?.nextOffset; if (next != null && next > offset) setCursor(before => ({ ...before, scope, identity: targetIdentity, offset: next, navigation: "browsing" })); }
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const metadata = { category: "review" as const, scope: commandScope, binding: null, confirmation: "none" as const };
    const remove = [
      commands.register({ ...metadata, id: "review.entry-grant-waiver", nameKey: "workbenchV2.entryIssuesGrantWaiver", payloadKind: "entry-issue-waiver", risk: "writes-review", availability: value => value?.grant === true ? waiverAvailability(value) : unavailable, handler: value => { void write(value); } }),
      commands.register({ ...metadata, id: "review.entry-revoke-waiver", nameKey: "workbenchV2.entryIssuesRevokeWaiver", payloadKind: "entry-issue-waiver", risk: "writes-review", availability: value => value?.grant === false ? waiverAvailability(value) : unavailable, handler: value => { void write(value); } }),
      commands.register({ ...metadata, id: "review.entry-reject-finding", nameKey: "workbenchV2.entryIssuesReject", payloadKind: "entry-issue-finding", risk: "writes-review", availability: value => value?.disposition === "rejected" ? findingAvailability(value) : unavailable, handler: value => { void write(value); } }),
      commands.register({ ...metadata, id: "review.entry-restore-finding", nameKey: "workbenchV2.entryIssuesRestore", payloadKind: "entry-issue-finding", risk: "writes-review", availability: value => value?.disposition === "restored" ? findingAvailability(value) : unavailable, handler: value => { void write(value); } }),
      commands.register({ ...metadata, id: "review.entry-repair-finding", nameKey: "workbenchV2.entryIssuesRepair", payloadKind: "entry-issue-finding", risk: "writes-review", availability: value => value?.disposition === "repair-requested" ? findingAvailability(value) : unavailable, handler: value => { void write(value); } }),
      commands.register({ ...metadata, id: "review.entry-issues-refresh", nameKey: "workbenchV2.entryIssuesRefresh", payloadKind: "entry-issues-read", risk: "reads-review", availability: value => value?.operation === "refresh" ? readAvailability(value) : unavailable, handler: readAction }),
      commands.register({ ...metadata, id: "review.entry-issues-page", nameKey: "workbenchV2.entryIssuesMoreHistory", payloadKind: "entry-issues-read", risk: "reads-review", availability: value => value?.operation === "first" || value?.operation === "next" ? readAvailability(value) : unavailable, handler: readAction }),
      commands.register({ ...metadata, id: "review.entry-issues-semantic-refresh", nameKey: "workbenchV2.entryIssuesRetrySemantic", payloadKind: "entry-issues-read", risk: "reads-review", availability: value => value?.operation === "semantic" ? readAvailability(value) : unavailable, handler: readAction }),
      commands.register({ ...metadata, id: "review.entry-issues-edit", nameKey: "workbenchV2.entryIssuesEdit", payloadKind: "entry-issues-read", risk: "reads-review", availability: value => value?.operation === "edit" ? readAvailability(value) : unavailable, handler: readAction }),
      commands.register({ ...metadata, id: "review.entry-locate-issue", nameKey: "workbenchV2.entryIssuesLocate", payloadKind: "entry-issue-locate", risk: "reads-review", availability: locateAvailability, handler: value => { void openEditor(value); } }),
    ];
    return () => remove.forEach(dispose => dispose());
  });
  function details(requirement: ReviewFindingDecision["requirement"], runId: string, sourceRevisionId: string) {
    const implementation = requirement.key.implementation;
    return <Disclosure className={styles.evidence} title={<>{legacy("review.advisoryFindings.basis")}</>}><dl>
      <dt>{legacy("review.advisoryFindings.rule")}</dt><dd>{requirement.key.rule.id}</dd>
      <dt>{legacy("review.advisoryFindings.provider")}</dt><dd>{implementation.kind === "plugin" ? `${implementation.provider.plugin.publisher}/${implementation.provider.plugin.id} ${implementation.provider.plugin.version}` : implementation.validator.id}</dd>
      <dt>{legacy("review.advisoryFindings.run")}</dt><dd>{runId}</dd><dt>{legacy("review.advisoryFindings.input")}</dt><dd>{requirement.inputDigest}</dd>
      <dt>{legacy("review.advisoryFindings.scope")}</dt><dd>{requirement.scopeDigest}</dd><dt>{legacy("review.advisoryFindings.source")}</dt><dd>{sourceRevisionId}</dd>
    </dl></Disclosure>;
  }
  function origin(item: Pick<AdvisoryFinding, "aiOrigin">) {
    return item.aiOrigin ? <p className={styles.text}><TokenizedText text={legacy("semanticReview.advisoryOrigin", { model: item.aiOrigin.model, endpoint: item.aiOrigin.endpoint, recipe: item.aiOrigin.recipe })}/></p> : null;
  }
  function decisionText(disposition: ReviewFindingDecision["request"]["disposition"]) {
    return legacy(disposition === "rejected" ? "review.advisoryFindings.rejected" : disposition === "restored" ? "review.advisoryFindings.restored" : "review.advisoryFindings.awaiting");
  }
  function auditDetails(decision: ReviewFindingDecision) { return <>{origin(decision)}{details(decision.requirement, decision.request.runId, decision.basisEvidence.sourceRevisionId)}</>; }
  function diagnosticDetails(intents: ReviewDiagnosticIntent[], current: boolean, detail: string) {
    return intents.map(intent => {
      const diagnostic = intent.diagnostic;
      const payload: EntryIssueLocatePayload = { kind: "entry-issue-locate", unitId: target.unitId, locale: target.locale, basis: target.basis, intent };
      return <div key={JSON.stringify([intent.runId, diagnostic])}>
        {diagnostic.detail && diagnostic.detail !== detail ? <p className={styles.text}><TokenizedText text={diagnostic.detail}/></p> : null}
        {diagnostic.suggestion ? <p className={styles.text}>{legacy("review.advisorySuggestion", { suggestion: diagnostic.suggestion })}</p> : null}
        {diagnostic.location ? <Disclosure className={styles.evidence} title={<>{legacy("execution.diagnostic")}</>}><p>{legacy("review.diagnosticRange", { field: legacy(diagnostic.location.field === "source" ? "review.source" : "review.translation"),
          encoding: diagnostic.location.range.encoding, rangeStart: String(diagnostic.location.range.start), rangeEnd: String(diagnostic.location.range.end) })}</p></Disclosure> : null}
        {onReviewEdit && current && diagnostic.location ? <Button size="sm" disabled={!locateAvailability(payload).enabled}
          onClick={() => commands.dispatch("review.entry-locate-issue", commandScope, payload)}>{legacy(diagnostic.location.field === "source" ? "review.diagnosticNavigation.locateSource" : "review.diagnosticNavigation.locateTranslation")}</Button>
          : onReviewEdit ? <p className={styles.help}>{t("entryIssuesNoExactLocation")}</p> : null}
      </div>;
    });
  }
  const captured = audit(), required = target.currentCheck?.rules.filter(rule => rule.mandatory).flatMap(rule => rule.findings) ?? [];
  const ready = parentFresh(), qaCurrent = qaRun(), message = feedback?.scope === scope ? feedback : null;
  const button = (operation: EntryIssuesReadPayload["operation"], label: string, id: "review.entry-issues-refresh" | "review.entry-issues-page" | "review.entry-issues-semantic-refresh" | "review.entry-issues-edit") => {
    const payload = readPayload(operation); return <Button size="sm" disabled={!readAvailability(payload).enabled} onClick={() => commands.dispatch(id, commandScope, payload)}>{label}</Button>;
  };
  if (!visible) return null;
  return <section ref={root} className={styles.section} aria-label={t("entryIssuesTitle")}>
    <h3 className={styles.title}>{t("entryIssuesTitle")}</h3><p className={styles.help}>{t("entryIssuesHelp")}</p><p className={styles.help}>{t("entryIssuesAuditHelp")}</p>
    {!ready ? <Banner tone="warning" role="status">{t("entryIssuesReadChanged")}</Banner> : null}
    {decisionChanged ? <Banner tone="warning" role="status">{t("decisionFindingChanged")}</Banner> : null}
    <div className={styles.actions}>{button("refresh", t("entryIssuesRefresh"), "review.entry-issues-refresh")}{onReviewEdit || onEdit ? button("edit", t("entryIssuesEdit"), "review.entry-issues-edit") : null}</div>
    <section className={styles.group} aria-label={t("entryIssuesRequired")}><h4>{t("entryIssuesRequired")}</h4>
      {target.currentCheck && !qaCurrent ? <Banner tone="warning" role="status">{t("entryIssuesOutdated")}</Banner> : null}
      {!target.currentCheck ? <p className={styles.help}>{t("entryIssuesNoCheck")}</p> : !required.length ? <p className={styles.help}>{t("entryIssuesNoRequired")}</p> : null}
      {required.map(item => {
        const run = target.currentCheck, rule = run?.rules.find(rule => rule.mandatory && rule.findings.some(finding => finding.issueId === item.issueId));
        const diagnostics: ReviewDiagnosticIntent[] = run && rule ? reviewDiagnostics(run, rule, item.code).map(diagnostic => ({ runId: run.runId, source: { purpose: "qa" }, diagnostic })) : [];
        const waiver = target.currentWaivers.find(value => value.issueId === item.issueId && value.grant && value.basis === target.basis);
        const payload: EntryIssueWaiverPayload | null = captured && target.currentCheck ? { ...captured, kind: "entry-issue-waiver", runId: target.currentCheck.runId,
          issueId: item.issueId, expectedWaiverId: waiver?.waiverId ?? null, grant: !waiver } : null;
        return <article className={styles.card} key={item.issueId}><p><strong>{reviewFindingLabel(legacy, item.rule, item.code)}</strong></p><div className={styles.text}><TokenizedText text={item.detail}/></div>
          {diagnosticDetails(diagnostics, !!qaCurrent, item.detail)}
          {waiver ? <><p>{legacy("review.waived")}</p><p className={styles.text}><TokenizedText text={`${waiver.actor}: ${waiver.reason}`}/></p></> : null}
          {item.waivable || waiver ? <><p className={styles.help}>{t("entryIssuesWaiverHelp")}</p><div className={styles.actions}><Button size="sm" disabled={!payload || !waiverAvailability(payload).enabled}
            onClick={() => { if (payload) commands.dispatch(payload.grant ? "review.entry-grant-waiver" : "review.entry-revoke-waiver", commandScope, payload); }}>{t(waiver ? "entryIssuesRevokeWaiver" : "entryIssuesGrantWaiver")}</Button></div></> : null}
        </article>;
      })}
    </section>
    <section className={styles.group} aria-label={t("entryIssuesAdvisory")}><h4>{t("entryIssuesAdvisory")}</h4>
      {findings.isFetching ? <LoadingState label={legacy("review.currentLoading")}/> : null}
      {findings.error ? <Banner tone="error" role="alert">{legacy("review.advisoryFindings.unavailable")}<CommandFailureDetails failure={commandFailure(findings.error)}/></Banner> : null}
      {!findings.isFetching && !findings.error && findings.data && !page ? <Banner tone="warning" role="status">{t("entryIssuesReadChanged")}</Banner> : null}
      {page?.findings.length === 0 ? <p className={styles.help}>{t("entryIssuesNoAdvisory")}</p> : null}
      {aiOrigin && semantic.isFetching ? <LoadingState label={t("entryIssuesSemanticRead")}/> : null}
      {aiOrigin && (semantic.error || !semantic.isFetching && !page?.findings.some(item => item.purpose === "ai-semantic" && semanticRun(item))) ? <Banner tone="warning" role="status"><p>{t("entryIssuesSemanticUnavailable")}</p>
        {semantic.error ? <CommandFailureDetails failure={commandFailure(semantic.error)}/> : null}{button("semantic", t("entryIssuesRetrySemantic"), "review.entry-issues-semantic-refresh")}</Banner> : null}
      {page?.findings.map(item => {
        const semanticOrigin = item.aiOrigin;
        const qa = item.purpose === "qa" && target.currentCheck?.runId === item.runId ? target.currentCheck : null;
        const rawSemanticRun = semanticOrigin && semantic.data?.detail.attemptId === semanticOrigin.attemptId
          ? semantic.data.rows.find(row => row.itemId === semanticOrigin.itemId && row.run?.runId === item.runId)?.run : null;
        const run = item.purpose === "qa" ? qa : rawSemanticRun;
        const rule = run?.rules.find(rule => ruleIdentity(rule.key) === ruleIdentity(item.requirement.key));
        const diagnostics: ReviewDiagnosticIntent[] = qa && rule ? reviewDiagnostics(qa, rule, item.finding.code).map(diagnostic => ({ runId: qa.runId, source: { purpose: "qa" }, diagnostic }))
          : rawSemanticRun && rule && semanticOrigin ? semanticReviewDiagnostics(rawSemanticRun, rule, item.finding.code).map(diagnostic => ({ runId: rawSemanticRun.runId,
            source: { purpose: "ai-semantic", origin: semanticOrigin }, diagnostic })) : [];
        const rejected = item.decision?.request.disposition === "rejected";
        const payload = (disposition: EntryIssueFindingPayload["disposition"]): EntryIssueFindingPayload | null => captured ? { ...captured, kind: "entry-issue-finding", purpose: item.purpose,
          runId: item.runId, issueId: item.finding.issueId, expectedDecisionId: item.decision?.decisionId ?? null, disposition, evidence: item } : null;
        const toggle = payload(rejected ? "restored" : "rejected"), repair = payload("repair-requested");
        return <article className={styles.card} key={`${item.purpose}:${item.runId}:${item.finding.issueId}`} tabIndex={-1}
          ref={item === requestedAdvisory ? findingCard : undefined} data-decision-finding={item === requestedAdvisory ? "true" : undefined}><p><strong>{item.purpose === "ai-semantic" ? legacy("semanticReview.title") : reviewRuleLabel(legacy, item.finding.rule)}</strong></p>
          <div className={styles.text}><TokenizedText text={item.finding.detail}/></div>{origin(item)}{details(item.requirement, item.runId, target.sourceRevisionId)}
          {diagnosticDetails(diagnostics, !!(item.purpose === "qa" ? qaRun() : semanticRun(item)), item.finding.detail)}
          {item.decision ? <><p>{decisionText(item.decision.request.disposition)}</p><p className={styles.text}><TokenizedText text={`${item.decision.request.actor}: ${item.decision.request.reason}`}/></p></> : null}
          <div className={styles.actions}><Button size="sm" disabled={!toggle || !findingAvailability(toggle).enabled} onClick={() => { if (toggle) commands.dispatch(rejected ? "review.entry-restore-finding" : "review.entry-reject-finding", commandScope, toggle); }}>{t(rejected ? "entryIssuesRestore" : "entryIssuesReject")}</Button>
            <Button size="sm" disabled={!repair || !findingAvailability(repair).enabled} onClick={() => { if (repair) commands.dispatch("review.entry-repair-finding", commandScope, repair); }}>{t("entryIssuesRepair")}</Button></div>
        </article>;
      })}
      {page?.repairs.map(repair => <article className={styles.card} key={repair.decision.decisionId} tabIndex={-1}
        ref={repair === requestedRepair ? findingCard : undefined} data-decision-finding={repair === requestedRepair ? "true" : undefined}><div className={styles.text}><TokenizedText text={repair.decision.finding.detail}/></div>
        <p>{legacy(repair.status === "awaiting-current-recheck" ? "review.advisoryFindings.awaiting" : repair.status === "current-rule-clear" ? "review.advisoryFindings.recheckClear" : repair.status === "superseded" ? "review.advisoryFindings.superseded" : "review.advisoryFindings.recheckFindings")}</p>
        <p className={styles.text}><TokenizedText text={`${repair.decision.request.actor}: ${repair.decision.request.reason}`}/></p>{auditDetails(repair.decision)}</article>)}
      <Disclosure title={<>{t("entryIssuesHistory")}</>}><div className={styles.history}>
        {page?.history.length === 0 ? <p className={styles.help}>{legacy("review.advisoryFindings.historyEmpty")}</p> : null}
        {page?.history.map(decision => <article className={styles.card} key={decision.decisionId}><p>{decision.createdAt} · {decisionText(decision.request.disposition)}</p>
          <p className={styles.text}><TokenizedText text={`${decision.request.actor}: ${decision.request.reason}`}/></p><div className={styles.text}><TokenizedText text={decision.finding.detail}/></div>{auditDetails(decision)}</article>)}
        <div className={styles.actions}>{button("first", t("entryIssuesFirstPage"), "review.entry-issues-page")}{button("next", t("entryIssuesMoreHistory"), "review.entry-issues-page")}</div>
      </div></Disclosure>
    </section>
    <div ref={result} tabIndex={-1} role="group" aria-label={t("entryIssuesResult")} className={styles.feedback}>
      {navigation?.identity === targetIdentity ? <Banner tone={navigation.kind === "loading" ? "info" : navigation.kind === "failed" ? "error" : "warning"}
        role={navigation.kind === "failed" ? "alert" : "status"}>{t(navigation.kind === "loading" ? "entryIssuesOpening" : navigation.kind === "failed" ? "entryIssuesLocationFailed" : "entryIssuesLocationChanged")}</Banner> : null}
      {state.pending ? <Banner tone="warning" role="status">{t(state.pendingUncertain ? "entryIssuesUnknown" : "entryIssuesPending")}</Banner> : null}
      {!state.pending && message ? <Banner tone={message.kind === "saved" ? "success" : message.kind === "failed" ? "error" : "warning"} role={message.kind === "failed" ? "alert" : "status"}>
        {t(message.kind === "saved" ? "entryIssuesSaved" : message.kind === "failed" ? "entryIssuesFailed" : "entryIssuesReadChanged")}
        {message.kind !== "saved" ? <CommandFailureDetails failure={state.reasonValue}/> : null}</Banner> : null}
      {!state.pending && (working || shared.mutationReserved) ? <p className={styles.help}>{t("entryReviewSharedBusy")}</p> : null}
    </div>
  </section>;
}
