import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useSessionAlive, useSessionReads } from "./SessionReadProvider";
import { strategyCommands, strategyKeys, sameStrategyValue, sameSuiteCaptureRequest, confirmStrategyCandidate, type ContextStrategyCandidate,
  type StrategySuite, type Prepared, type StrategyEvaluationView, type StrategyActionReceipt } from "./strategyCommands";
import { defaultAiConfig, validSourceContextSelection, sameAiConfig, type AiConfig } from "./aiCommands";
import { arenaCommands, type ArenaView } from "./arenaCommands";
import { confirmArenaView } from "./ArenaDraftSession";
import { resourceCommands, type CorrectionTermEvidence } from "./resourceCommands";
import { reviewCommands } from "./reviewCommands";
import { executionCommands, confirmExecutionAction, confirmExecutionReceipt } from "./executionCommands";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { hasUnknownOutcome, isCommandError, type ProjectView } from "./projectCommands";
import { connectionConfigCurrent, useConnectionFacts } from "./ApplicationReadProvider";
import type { ConnectionReadView } from "./connectionCommands";
import type { StrategyCheckCommand, StrategyCheckStartRequest } from "./generated/strategy.requests";
import type { StrategyCheckPreparation, StrategyJudgmentRequest } from "./generated/strategy.responses";
import { useTranslationDraftSession } from "./TranslationDraftSession";

type Request<K extends keyof typeof strategyCommands> = Parameters<(typeof strategyCommands)[K]>[0];
type Mutation = { kind: "candidate"; request: Request<"capture"> } | { kind: "suite"; request: Request<"suite">; candidate: ContextStrategyCandidate }
  | { kind: "prepare"; request: Request<"prepare">; suite: StrategySuite } | { kind: "start"; request: Request<"start"> }
  | { kind: "judgment"; request: Request<"judgment">; draftSeq: number } | { kind: "promote"; request: Request<"promote"> }
  | { kind: "withdraw"; request: Request<"withdraw"> } | { kind: "save-candidate"; request: Request<"saveCandidate">; attemptId: string; unitId: string }
  | { kind: "prepare-check"; request: StrategyCheckCommand; unitId: string; locale: string } | { kind: "check"; request: StrategyCheckStartRequest };
type Pending = Mutation & { editSeq: number; uncertain: boolean; retryAllowed: boolean };
export interface StrategyJudgmentDraft { preference: StrategyJudgmentRequest["preference"] | ""; notes: string; elapsed: string; modified: string; editSeq: number; savedSeq: number }
interface State {
  locale: string; correctionUnit: string; evidence: CorrectionTermEvidence | null; sourceContext: AiConfig["sourceContext"]; reason: string; exceptions: string;
  config: AiConfig; roles: Record<string, "calibration" | "holdout">; candidate: ContextStrategyCandidate | null; suite: StrategySuite | null;
  prepared: Prepared | null; evaluationId: string | null; consent: boolean; stale: boolean; judgments: Record<string, StrategyJudgmentDraft>;
  check: { request: StrategyCheckCommand; preparation: Extract<StrategyCheckPreparation, { kind: "plugin" }> } | null; checkerConsent: string[];
  editSeq: number; busy: boolean; checkingAction: boolean; pending: Pending | null; failure: CommandFailure | null;
  notice: "saved" | "suiteSaved" | "reconciled" | "started" | "judgmentSaved" | "promoted" | "withdrawn" | "checked" | "retryAvailable" | "previewChanged" | "preparationRecorded" | "recordedReadFailed" | null;
  candidateEditSeq: number; candidateSavedSeq: number; suiteEditSeq: number; suiteSavedSeq: number;
}
const fixed = <T,>(value: T): T => structuredClone(value);
const initialJudgment = (): StrategyJudgmentDraft => ({ preference: "", notes: "", elapsed: "", modified: "", editSeq: 0, savedSeq: 0 });
function numericReport(value: string, maximum: number): number | null {
  if (!value.trim()) return null;
  const number = Number(value); if (!Number.isInteger(number) || number < 0 || number > maximum) throw { field: "strategy-report" }; return number;
}
function isReceiptFirstRejection(entry: Pending, error: unknown) {
  if (!isCommandError(error) || error.code !== "dependency-conflict" || error.stage !== "execution-adopt" || error.outcome !== "rejected") return false;
  const reasons: Partial<Record<Pending["kind"], readonly string[]>> = {
    candidate: ["strategy-correction-stale"], suite: ["strategy-correction-stale", "strategy-suite-stale"],
    prepare: ["strategy-correction-stale", "strategy-suite-stale"], judgment: ["strategy-judgment-current", "strategy-suite-stale"],
    promote: ["strategy-default-current", "strategy-correction-stale", "strategy-suite-stale"], withdraw: ["strategy-default-current"],
  };
  return !!error.reason && (reasons[entry.kind]?.includes(error.reason) ?? false);
}
function initialState(locale: string): State {
  return { locale, correctionUnit: "", evidence: null, sourceContext: fixed(defaultAiConfig.sourceContext), reason: "", exceptions: "",
    config: fixed(defaultAiConfig), roles: {}, candidate: null, suite: null, prepared: null, evaluationId: null, consent: false, stale: false,
    judgments: {}, check: null, checkerConsent: [], editSeq: 0, candidateEditSeq: 0, candidateSavedSeq: 0, suiteEditSeq: 0, suiteSavedSeq: 0, busy: false, checkingAction: false, pending: null, failure: null, notice: null };
}

function useStrategyOwner(project: ProjectView) {
  const reads = useSessionReads(), alive = useSessionAlive(), connections = useConnectionFacts(), translation = useTranslationDraftSession();
  const [session] = useState(() => ({ ...reads.context }));
  const [state, setState] = useState(() => initialState(project.metadata.targetLocales[0] ?? ""));
  const ref = useRef(state), projectRef = useRef(project), flight = useRef<object | null>(null), reservation = useRef<symbol | null>(null);
  const evidenceGeneration = useRef(0);
  useLayoutEffect(() => { projectRef.current = project; });
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; if (reservation.current) translation.releaseMutation(reservation.current); }; }, []);
  const live = () => alive.current && reads.context.projectId === session.projectId && reads.context.sessionToken === session.sessionToken;
  const current = () => ref.current;
  function update(change: (value: State) => State) { if (!live()) return; ref.current = change(ref.current); setState(ref.current); }
  const reserved = () => !!flight.current || !!current().pending;
  const available = (locale = current().locale) => !!locale && projectRef.current.metadata.targetLocales.includes(locale);
  const dirty = () => current().candidateEditSeq !== current().candidateSavedSeq || current().suiteEditSeq !== current().suiteSavedSeq
    || Object.values(current().judgments).some(value => value.editSeq !== value.savedSeq);
  function edit<K extends "reason" | "exceptions" | "sourceContext" | "correctionUnit" | "config" | "roles">(key: K, value: State[K]) {
    update(before => ({ ...before, [key]: fixed(value), editSeq: before.editSeq + 1, failure: null, notice: null, consent: false,
      ...(key === "config" || key === "roles" ? { suiteEditSeq: before.editSeq + 1 } : { candidateEditSeq: before.editSeq + 1 }),
      ...(key === "correctionUnit" ? { evidence: null } : {}), ...(key === "config" || key === "roles" ? { suite: null, prepared: null } : {}) }));
  }
  function setLocale(locale: string) {
    if (!live() || reserved() || dirty() || !available(locale)) return false;
    update(before => ({ ...initialState(locale), editSeq: before.editSeq + 1 })); return true;
  }
  function reset() {
    if (!live() || reserved()) return false;
    update(before => ({ ...initialState(available() ? before.locale : projectRef.current.metadata.targetLocales[0] ?? ""), editSeq: before.editSeq + 1 })); return true;
  }
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(scope => ["source", "resources", "project", "translation", "review"].includes(scope))) {
      evidenceGeneration.current++;
      update(before => ({ ...before, stale: true, consent: false, check: before.pending?.kind === "check" ? before.check : null, checkerConsent: [] }));
    }
  }), [reads]);
  useLayoutEffect(() => {
    if (current().prepared && !reserved() && !connectionConfigCurrent(connections.current(), current().config)) {
      update(before => ({ ...before, consent: false, prepared: null, stale: true }));
    }
  }, [connections.state]);
  async function run(work: () => Promise<void>, recovery = false) {
    if (!live() || flight.current || !recovery && current().pending) return;
    const ticket = {}; flight.current = ticket; update(before => ({ ...before, busy: true, failure: null }));
    try { await work(); } catch (error) { update(before => ({ ...before, failure: commandFailure(error, "outcome-unknown") })); }
    finally { if (flight.current === ticket) { flight.current = null; update(before => ({ ...before, busy: false, checkingAction: false })); }
      if (!current().pending && reservation.current) { translation.releaseMutation(reservation.current); reservation.current = null; } }
  }
  const matches = (entry: Pending) => live() && current().pending?.request === entry.request;
  function actionId(entry: Pending) {
    switch (entry.kind) {
      case "candidate": case "suite": case "prepare": return entry.request.capture.actionId;
      case "judgment": return entry.request.judgment.actionId;
      case "promote": return entry.request.promotion.actionId;
      case "withdraw": return entry.request.withdrawal.actionId;
      case "save-candidate": return entry.request.actionId;
      case "prepare-check": return entry.request.check.actionId;
      case "check": return entry.request.check.check.actionId;
      case "start": return entry.request.attemptId;
    }
  }
  function settle(entry: Pending, notice: State["notice"]) {
    if (!matches(entry)) return;
    update(before => ({ ...before, pending: null, checkingAction: false,
      ...(entry.kind === "candidate" ? { candidateSavedSeq: Math.min(before.candidateEditSeq, entry.editSeq) } : entry.kind === "suite" ? { suiteSavedSeq: Math.min(before.suiteEditSeq, entry.editSeq) } : {}),
      notice, failure: null }));
    reads.invalidate(entry.kind === "save-candidate" ? ["arena", "translation"] : entry.kind === "check" ? ["arena", "review"]
      : entry.kind === "start" ? ["arena", "execution"] : ["arena"]);
    for (const prefix of ["context-strategy-candidates", "context-strategy-evaluations", "context-strategy-evaluation", "context-strategy-default", "context-strategy-default-history"]) {
      void reads.client.invalidateQueries({ queryKey: reads.key([prefix]) });
    }
  }
  function confirmSuite(entry: Extract<Pending, { kind: "suite" }>, suite: StrategySuite) {
    const request = entry.request.capture, ids = [...request.calibrationUnitIds, ...request.holdoutUnitIds];
    if (!sameSuiteCaptureRequest(suite.request, request) || suite.suiteId !== request.actionId || suite.projectId !== session.projectId || suite.candidateId !== request.candidateId || suite.locale !== entry.candidate.locale
      || suite.units.length !== ids.length || new Set(suite.units.map(unit => unit.unitId)).size !== ids.length
      || suite.units.some(unit => !ids.includes(unit.unitId) || unit.holdout !== request.holdoutUnitIds.includes(unit.unitId))
      || suite.preview.config.variants.length !== 2 || !suite.preview.config.blind
      || !sameAiConfig(suite.preview.config.variants[0], request.config)
      || !sameAiConfig(suite.preview.config.variants[1], { ...request.config, sourceContext: entry.candidate.sourceContext })
      || suite.preview.items.length !== ids.length * 2 || suite.preview.items.some((row, index) => row.slot !== index % 2 || row.sourceOrder !== Math.floor(index / 2)
        || row.item.unitId !== ids[row.sourceOrder] || row.item.targetLocale !== entry.candidate.locale)) throw new Error("Invalid fixed strategy suite association");
  }
  async function dispatch(entry: Pending, replay = false) {
    if (!live()) return;
    update(before => ({ ...before, pending: { ...entry, retryAllowed: false }, checkingAction: false, notice: null }));
    // Use the actual retained entry so an unknown result cannot be rebound to a new request.
    entry = current().pending!;
    try {
      switch (entry.kind) {
        case "candidate": { const candidate = await strategyCommands.capture(entry.request); if (!matches(entry)) return;
          update(before => ({ ...before, ...(before.editSeq === entry.editSeq ? { candidate: fixed(candidate), suite: null, prepared: null, evaluationId: null } : {}) })); settle(entry, "saved"); break; }
        case "suite": { const suite = await strategyCommands.suite(entry.request); if (!matches(entry)) return;
          confirmSuite(entry, suite);
          update(before => ({ ...before, ...(before.editSeq === entry.editSeq ? { suite: fixed(suite), prepared: null } : {}) })); settle(entry, "suiteSaved"); break; }
        case "prepare": { const prepared = await strategyCommands.prepare(entry.request); if (!matches(entry)) return;
          if (!sameStrategyValue(prepared.preview, entry.suite.preview)) throw new Error("Invalid original strategy preview association");
          const original = entry;
          update(before => ({ ...before, evaluationId: prepared.evaluation.evaluationId,
            ...(before.editSeq === original.editSeq ? { prepared: null, consent: false, stale: true } : {}) }));
          settle(entry, "preparationRecorded");
          try {
            await reads.synchronizeFresh(); if (!live()) return;
            const generation = evidenceGeneration.current;
            const observed = await strategyCommands.evaluation({ ...session, evaluationId: prepared.evaluation.evaluationId });
            if (!live() || current().evaluationId !== prepared.evaluation.evaluationId || current().editSeq !== original.editSeq) return;
            if (!sameStrategyValue(observed.evaluation, prepared.evaluation) || !sameStrategyValue(observed.suite, original.suite)) throw new Error("Invalid current strategy preparation");
            const stillCurrent = observed.current && evidenceGeneration.current === generation;
            update(before => ({ ...before, prepared: stillCurrent ? fixed(prepared) : null, consent: false, stale: !stillCurrent,
              notice: stillCurrent ? "reconciled" : "previewChanged" }));
          } catch (error) {
            if (live() && current().evaluationId === prepared.evaluation.evaluationId) update(before => ({ ...before, failure: commandFailure(error), notice: "recordedReadFailed" }));
          }
          break; }
        case "start": await strategyCommands.start(entry.request); if (matches(entry)) { update(before => ({ ...before, consent: false, prepared: null })); settle(entry, "started"); } break;
        case "judgment": { const judgment = await strategyCommands.judgment(entry.request); if (!matches(entry)) return;
          const unitId = judgment.request.unitId, draftSeq = entry.draftSeq;
          update(before => ({ ...before, judgments: before.judgments[unitId] ? { ...before.judgments, [unitId]: { ...before.judgments[unitId], savedSeq: draftSeq } } : before.judgments })); settle(entry, "judgmentSaved"); break; }
        case "promote": await strategyCommands.promote(entry.request); if (matches(entry)) settle(entry, "promoted"); break;
        case "withdraw": await strategyCommands.withdraw(entry.request); if (matches(entry)) settle(entry, "withdrawn"); break;
        case "save-candidate": { const receipt = await strategyCommands.saveCandidate(entry.request);
          confirmExecutionReceipt({ ...session, actionId: entry.request.actionId, attemptId: entry.attemptId, unitId: entry.unitId, resultIds: [entry.request.resultId] }, receipt);
          if (matches(entry)) settle(entry, "reconciled"); break; }
        case "prepare-check": { const preparation = await strategyCommands.prepareCheck(entry.request); if (!matches(entry)) return;
          if (preparation.kind === "plugin" && (preparation.view.unitId !== entry.unitId || preparation.view.locale !== entry.locale)) throw new Error("Invalid independent checker target");
          const request = entry.request;
          update(before => ({ ...before, check: preparation.kind === "plugin" ? { request: fixed(request), preparation: fixed(preparation) } : null, checkerConsent: [] })); settle(entry, preparation.kind === "recorded" ? "checked" : "reconciled"); break; }
        case "check": await strategyCommands.check(entry.request); if (matches(entry)) { update(before => ({ ...before, check: null, checkerConsent: [] })); settle(entry, "checked"); } break;
      }
    } catch (error) {
      if (!matches(entry)) return;
      const failure = commandFailure(error, "outcome-unknown"), unknown = hasUnknownOutcome(error);
      const uncertain = replay || entry.uncertain;
      // The Host may reject current preparation after recording evaluation.
      // Only this fresh post-record rejection needs an original fact read.
      const notCommitted = isReceiptFirstRejection(entry, error);
      const postRecordRejection = entry.kind === "prepare" && notCommitted;
      const retained = { ...entry, uncertain: true, retryAllowed: false };
      update(before => ({ ...before, ...(isReceiptFirstRejection(entry, error) ? { stale: true } : {}),
        pending: unknown || postRecordRejection || uncertain && !notCommitted ? retained : null, failure }));
      if (unknown || postRecordRejection) await lookupOriginal(retained, failure, postRecordRejection);
    }
  }

  async function fresh(make: (actionId: string) => Mutation, proof: () => boolean = () => true) {
    if (reserved() || !available() || !proof()) return;
    const seq = current().editSeq, locale = current().locale;
    await run(async () => {
      const id = await executionCommands.identity(session);
      if (!live() || current().editSeq !== seq || current().locale !== locale || !available(locale) || !proof()) return;
      await dispatch({ ...make(id), editSeq: seq, uncertain: false, retryAllowed: false });
    });
  }
  async function inspectCorrection() {
    const before = current(), unitId = before.correctionUnit, seq = before.editSeq;
    if (!unitId || reserved() || !available()) return;
    await run(async () => {
      const snapshot = await reviewCommands.editorSnapshot({ ...session, unitId, locale: before.locale });
      if (!live() || current().editSeq !== seq || current().correctionUnit !== unitId || current().locale !== before.locale) return;
      const selection = snapshot.translations.current;
      if (!selection || selection.previousEventId === null) throw { field: "strategy-correction" };
      const evidence = await resourceCommands.correctionBasis({ ...session, unitId, locale: before.locale, afterSelectionId: selection.eventId });
      if (!live() || current().editSeq !== seq || current().correctionUnit !== unitId || current().locale !== before.locale) return;
      if (!evidence.current || evidence.basis.after.revisionId !== selection.revisionId || evidence.basis.sourceRevisionId !== snapshot.target.sourceRevisionId) throw { field: "strategy-correction" };
      update(value => ({ ...value, evidence: fixed(evidence), stale: false }));
    });
  }
  const canCapture = () => !!current().evidence?.current && !current().stale && !!current().reason.trim() && !!current().exceptions.trim()
    && (current().sourceContext.extracted || current().sourceContext.inferred || current().sourceContext.neighbors) && validSourceContextSelection(current().sourceContext);
  async function capture() {
    const before = current(); if (!canCapture() || !before.evidence) return;
    const capture = fixed({ basis: before.evidence.basis, sourceContext: before.sourceContext, reason: before.reason, exceptions: before.exceptions });
    await fresh(actionId => ({ kind: "candidate", request: { ...session, capture: { ...capture, actionId } } }), canCapture);
  }
  function chooseCandidate(candidate: ContextStrategyCandidate) {
    if (reserved() || dirty() || candidate.projectId !== session.projectId || candidate.locale !== current().locale) return false;
    update(before => ({ ...before, candidate: fixed(candidate), suite: null, prepared: null, evaluationId: null, check: null, checkerConsent: [], consent: false, stale: !candidate.evidence.current })); return true;
  }
  function copyConfig(config: AiConfig) {
    if (reserved()) return;
    edit("config", { ...config, contextStrategy: null, shareTerms: false, shareContext: false, sourceContext: fixed(defaultAiConfig.sourceContext) });
  }
  function selectConnection(view: ConnectionReadView | null, id: string, seq: number) {
    if (reserved() || current().editSeq !== seq) return false;
    if (!id) { edit("config", { ...current().config, connectionProfile: null }); return true; }
    if (!view || connections.current() !== view) return false;
    const profile = view.snapshot.profiles.find(row => row.id === id && !row.archived), reference = view.references.find(row => row.profileId === id);
    if (!profile || !reference) return false;
    edit("config", { ...current().config, ...profile.connection, connectionProfile: reference }); return true;
  }
  async function captureSuite() {
    const before = current(), candidate = before.candidate;
    const calibrationUnitIds = Object.keys(before.roles).filter(id => before.roles[id] === "calibration"), holdoutUnitIds = Object.keys(before.roles).filter(id => before.roles[id] === "holdout");
    if (!candidate || !candidate.evidence.current || !calibrationUnitIds.length || !holdoutUnitIds.length || calibrationUnitIds.length + holdoutUnitIds.length > 20
      || holdoutUnitIds.includes(candidate.evidence.basis.unitId) || !connectionConfigCurrent(connections.current(), before.config)) return;
    await fresh(actionId => ({ kind: "suite", candidate: fixed(candidate), request: { ...session, capture: { actionId, projectId: session.projectId, candidateId: candidate.candidateId,
      config: fixed(before.config), calibrationUnitIds, holdoutUnitIds } } }));
  }
  async function prepare() {
    const before = current(); if (!before.candidate || !before.suite) return;
    const candidateId = before.candidate.candidateId, suite = fixed(before.suite), suiteId = suite.suiteId;
    await fresh(actionId => ({ kind: "prepare", suite, request: { ...session, capture: { actionId, projectId: session.projectId, candidateId, suiteId } } }));
  }
  const canStart = () => !!current().prepared?.canStart && current().consent && !current().stale
    && current().prepared?.evaluation.candidateId === current().candidate?.candidateId && connectionConfigCurrent(connections.current(), current().config);
  async function start() { const prepared = current().prepared; if (!prepared || !canStart()) return;
    await run(() => dispatch({ kind: "start", request: { ...session, evaluationId: prepared.evaluation.evaluationId, attemptId: prepared.attemptId, digest: prepared.evaluation.inputDigest, confirmed: true },
      editSeq: current().editSeq, uncertain: false, retryAllowed: false })); }
  function selectEvaluation(id: string) {
    if (reserved() || dirty()) return false;
    update(before => ({ ...before, evaluationId: id, prepared: null, consent: false, check: null, checkerConsent: [], judgments: {} })); return true;
  }
  async function readArena(attemptId: string): Promise<ArenaView> { const view = await arenaCommands.read({ ...session, attemptId }); confirmArenaView(view, attemptId); return view; }
  function evaluationCurrent(view: StrategyEvaluationView) {
    const state = reads.client.getQueryState<StrategyEvaluationView>(reads.key(strategyKeys.evaluation(view.evaluation.evaluationId)));
    return live() && available(view.suite.locale) && current().evaluationId === view.evaluation.evaluationId && state?.status === "success"
      && state.fetchStatus === "idle" && !state.isInvalidated && state.error === null && state.data === view;
  }
  function editJudgment(unitId: string, change: Partial<Omit<StrategyJudgmentDraft, "editSeq" | "savedSeq">>) {
    update(before => { const original = before.judgments[unitId] ?? initialJudgment(); return { ...before,
      judgments: { ...before.judgments, [unitId]: { ...original, ...change, editSeq: original.editSeq + 1 } }, failure: null, notice: null }; });
  }
  async function judge(view: StrategyEvaluationView, unitId: string) {
    const draft = current().judgments[unitId]; if (!draft?.preference || !draft.notes.trim()) return;
    if (!view.suite.units.some(unit => unit.unitId === unitId && unit.holdout)
      || view.slots.filter(slot => slot.unitId === unitId && slot.resultId !== null).length !== 2) return;
    const preference = draft.preference;
    const prior = view.judgments.find(row => row.request.unitId === unitId);
    await fresh(actionId => ({ kind: "judgment", draftSeq: draft.editSeq, request: { ...session, judgment: {
      actionId, projectId: session.projectId, evaluationId: view.evaluation.evaluationId, unitId, expectedJudgmentId: prior?.judgmentId ?? null,
      preference, notes: draft.notes,
      elapsedSeconds: numericReport(draft.elapsed, 31_536_000), modifiedCharacters: numericReport(draft.modified, 10_000_000),
    } } }), () => evaluationCurrent(view) && current().judgments[unitId]?.editSeq === draft.editSeq);
  }
  async function changeDefault(view: StrategyEvaluationView | null, withdraw: boolean, revisionId: string | null, proof: () => boolean) {
    if (!withdraw && (!view || !view.current || !evaluationCurrent(view))) return;
    await fresh(actionId => withdraw ? { kind: "withdraw", request: { ...session, withdrawal: { actionId, projectId: session.projectId, locale: current().locale, expectedRevisionId: revisionId } } }
      : { kind: "promote", request: { ...session, promotion: { actionId, projectId: session.projectId, evaluationId: view!.evaluation.evaluationId, expectedRevisionId: revisionId } } },
    () => proof() && (withdraw || !!view && evaluationCurrent(view) && view.current));
  }
  function candidateUnit(view: StrategyEvaluationView, row: ArenaView["rows"][number], arena: ArenaView) {
    const query = reads.client.getQueryState<ArenaView>(reads.key(["arena", view.evaluation.attemptId]));
    if (query?.status !== "success" || query.fetchStatus !== "idle" || query.error !== null || query.isInvalidated || query.data !== arena) return null;
    try { confirmArenaView(arena, view.evaluation.attemptId); } catch { return null; }
    const original = arena.rows.find(value => value.itemId === row.itemId), detail = arena.detail.items.find(value => value.status.itemId === row.itemId);
    const units = arena.detail.recovery.units.filter(unit => unit.itemIds.includes(row.itemId)), unit = units[0];
    return original && original.resultId === row.resultId && sameStrategyValue(original.item, row.item) && detail?.status.execution === "succeeded"
      && detail.status.validation === "valid" && !detail.status.cancellationRequested && detail.status.adoption !== "committed"
      && units.length === 1 && unit.itemIds.length === 1 && unit.resultIds.length === 1 && unit.resultIds[0] === row.resultId && unit.actions.includes("adopt-result") ? unit.unitId : null;
  }
  async function saveCandidate(view: StrategyEvaluationView, row: ArenaView["rows"][number], arena: ArenaView) {
    if (!row.resultId || reserved() || !available() || !evaluationCurrent(view) || translation.mutationReserved) return;
    if (!view.slots.some(slot => slot.itemId === row.itemId && slot.unitId === row.item.unitId && slot.resultId === row.resultId)) return;
    const unitId = candidateUnit(view, row, arena); if (!unitId) return;
    const token = translation.reserveMutation(); if (!token) return; reservation.current = token;
    const resultId = row.resultId;
    try { await fresh(actionId => ({ kind: "save-candidate", attemptId: view.evaluation.attemptId, unitId,
      request: { ...session, actionId, evaluationId: view.evaluation.evaluationId, itemId: row.itemId, resultId } }), () => evaluationCurrent(view) && candidateUnit(view, row, arena) === unitId); }
    finally { if (!current().pending && reservation.current === token) { translation.releaseMutation(token); reservation.current = null; } }
  }
  async function prepareCheck(view: StrategyEvaluationView, row: ArenaView["rows"][number]) {
    if (!row.resultId || !evaluationCurrent(view)) return;
    if (!view.slots.some(slot => slot.itemId === row.itemId && slot.unitId === row.item.unitId && slot.resultId === row.resultId)) return;
    const resultId = row.resultId;
    await fresh(actionId => ({ kind: "prepare-check", unitId: row.item.unitId, locale: row.item.targetLocale, request: { ...session, check: { actionId, projectId: session.projectId,
      evaluationId: view.evaluation.evaluationId, itemId: row.itemId, resultId } } }), () => evaluationCurrent(view));
  }
  const checkerKey = (slot: Extract<StrategyCheckPreparation, { kind: "plugin" }>["view"]["checkers"][number]) => JSON.stringify([current().check?.request, slot]);
  function setCheckerConsent(attemptId: string, approved: boolean) { if (reserved()) return;
    const slot = current().check?.preparation.view.checkers.find(slot => slot.attemptId === attemptId); if (!slot) return;
    const key = checkerKey(slot); update(before => ({ ...before, checkerConsent: approved ? [...before.checkerConsent.filter(value => value !== key), key] : before.checkerConsent.filter(value => value !== key) })); }
  const checkersConfirmed = () => !!current().check && current().check!.preparation.view.checkers.every(slot => current().checkerConsent.includes(checkerKey(slot)));
  async function check(view: StrategyEvaluationView) {
    const capture = current().check; if (!capture || !checkersConfirmed() || !evaluationCurrent(view)) return;
    await run(async () => {
      const executions: StrategyCheckStartRequest["executions"] = [];
      for (const slot of capture.preparation.view.checkers) {
        const grantId = await executionCommands.identity(session);
        if (!live() || current().check !== capture || !evaluationCurrent(view) || !checkersConfirmed()) return;
        executions.push({ ...session, grantId, attemptId: slot.attemptId, inputDigest: slot.inputDigest, expiresAtMs: String(Date.now() + 600_000), unsandboxedExecution: true });
      }
      await dispatch({ kind: "check", request: { ...session, check: capture.request, executions }, editSeq: current().editSeq, uncertain: false, retryAllowed: false });
    });
  }
  async function cancelCheck() { const entry = current().pending;
    if (!entry || entry.kind !== "check") return;
    try { await reviewCommands.cancelCheck({ ...session, actionId: entry.request.check.check.actionId }); }
    catch (error) { update(before => ({ ...before, failure: commandFailure(error) })); }
  }
  function confirmRecovered(entry: Pending, receipt: StrategyActionReceipt) {
    switch (entry.kind) {
      case "candidate": if (receipt.kind !== "candidate" || !sameStrategyValue(receipt.request, entry.request.capture)) throw new Error("Mismatched strategy action"); confirmStrategyCandidate(entry.request.capture, receipt.candidate); break;
      case "suite": if (receipt.kind !== "suite" || !sameSuiteCaptureRequest(receipt.request, entry.request.capture)) throw new Error("Mismatched strategy action"); break;
      case "prepare": if (receipt.kind !== "evaluation" || !sameStrategyValue(receipt.request, entry.request.capture)) throw new Error("Mismatched strategy action"); break;
      case "judgment": if (receipt.kind !== "judgment" || !sameStrategyValue(receipt.judgment.request, entry.request.judgment)) throw new Error("Mismatched strategy action"); break;
      case "promote": if (receipt.kind !== "promoted" || !sameStrategyValue(receipt.request, entry.request.promotion)) throw new Error("Mismatched strategy action"); break;
      case "withdraw": if (receipt.kind !== "withdrawn" || !sameStrategyValue(receipt.request, entry.request.withdrawal)) throw new Error("Mismatched strategy action"); break;
      case "prepare-check": case "check": if (receipt.kind !== "check" || !sameStrategyValue(receipt.receipt.request, entry.kind === "check" ? entry.request.check.check : entry.request.check)) throw new Error("Mismatched strategy action"); break;
      default: throw new Error("Wrong strategy recovery target");
    }
  }
  async function lookupOriginal(entry: Pending, originalFailure: CommandFailure | null = current().failure, rejectedIfMissing = false) {
    if (!matches(entry)) return;
    const retained = { ...entry, uncertain: true, retryAllowed: false };
    update(before => ({ ...before, pending: retained, checkingAction: true, notice: null, failure: null }));
    const missing = () => {
      if (!matches(retained)) return;
      update(before => ({ ...before, pending: rejectedIfMissing ? null : { ...retained, retryAllowed: true },
        checkingAction: false, notice: rejectedIfMissing ? null : "retryAvailable", failure: originalFailure }));
    };
    try {
      if (entry.kind === "start") {
        const receipt = await strategyCommands.startAction(entry.request); if (!matches(retained)) return;
        if (receipt === null) { missing(); return; }
        update(before => ({ ...before, prepared: null, consent: false })); settle(retained, "started"); return;
      }
      if (entry.kind === "save-candidate") {
        const found = await strategyCommands.saveAction(entry.request); if (!matches(retained)) return;
        if (found === null) { missing(); return; }
        const request = { ...session, actionId: entry.request.actionId, attemptId: entry.attemptId, unitId: entry.unitId, resultIds: [entry.request.resultId] };
        confirmExecutionAction(request, "arena-translation", found.adoption.action);
        if (found.adoption.receipt === null) { missing(); return; }
        confirmExecutionReceipt(request, found.adoption.receipt);
        if (found.adoption.receipt.changes.length !== 1 || found.adoption.receipt.changes[0].kind !== "translation-revision") throw new Error("Invalid Arena save receipt");
        settle(retained, "reconciled"); return;
      }
      const receipt = await strategyCommands.action({ ...session, actionId: actionId(entry) }); if (!matches(retained)) return;
      if (receipt === null) { missing(); return; }
      confirmRecovered(entry, receipt);
      if (entry.kind === "prepare" && receipt.kind === "evaluation") {
        update(before => ({ ...before, evaluationId: receipt.evaluation.evaluationId, prepared: null, consent: false, stale: true }));
        settle(retained, "preparationRecorded"); return;
      }
      if (entry.kind === "candidate" && receipt.kind === "candidate") {
        update(before => ({ ...before, ...(before.editSeq === entry.editSeq ? { candidate: fixed(receipt.candidate), stale: true } : {}) }));
        settle(retained, "reconciled");
        if (current().editSeq !== entry.editSeq) return;
        try {
          await reads.synchronizeFresh(); if (!live()) return;
          const generation = evidenceGeneration.current;
          const candidate = await strategyCommands.candidate({ ...session, candidateId: receipt.candidate.candidateId });
          if (!live() || current().editSeq !== entry.editSeq || current().candidate?.candidateId !== candidate.candidateId) return;
          confirmStrategyCandidate(entry.request.capture, candidate);
          update(before => ({ ...before, candidate: fixed(candidate), stale: !candidate.evidence.current || evidenceGeneration.current !== generation }));
        } catch (error) {
          if (live() && current().candidate?.candidateId === receipt.candidate.candidateId) update(before => ({ ...before, failure: commandFailure(error), notice: "recordedReadFailed" }));
        }
        return;
      }
      if (entry.kind === "suite" && receipt.kind === "suite") { confirmSuite(entry, receipt.suite); update(before => ({ ...before, ...(before.editSeq === entry.editSeq ? { suite: fixed(receipt.suite), prepared: null, consent: false } : {}) })); }
      if (entry.kind === "judgment" && receipt.kind === "judgment") { const unit = receipt.judgment.request.unitId, seq = entry.draftSeq;
        update(before => ({ ...before, judgments: before.judgments[unit] ? { ...before.judgments, [unit]: { ...before.judgments[unit], savedSeq: Math.max(before.judgments[unit].savedSeq, seq) } } : before.judgments })); }
      if (receipt.kind === "check") update(before => ({ ...before, check: null, checkerConsent: [] }));
      settle(retained, "reconciled");
    } catch (error) {
      if (matches(retained)) update(before => ({ ...before, pending: { ...retained, retryAllowed: false }, checkingAction: false, failure: commandFailure(error, "outcome-unknown") }));
    }
  }
  async function reconcile() {
    const entry = current().pending;
    if (entry) await run(() => lookupOriginal(entry), true);
  }
  async function retry() { const entry = current().pending; if (entry?.retryAllowed) await run(() => dispatch(entry, true), true); }
  return { state, current, reserved, dirty, available, reset, setLocale, edit, inspectCorrection, canCapture, capture, chooseCandidate,
    copyConfig, selectConnection, captureSuite, prepare, canStart, start, selectEvaluation, readArena, evaluationCurrent, editJudgment, judge,
    changeDefault, saveCandidate, prepareCheck, checkerKey, setCheckerConsent, checkersConfirmed, check, cancelCheck, reconcile, retry,
    setConsent: (consent: boolean) => { if (!reserved() && current().prepared && !current().stale) update(before => ({ ...before, consent })); } };
}
type Owner = ReturnType<typeof useStrategyOwner>;
const Context = createContext<Owner | null>(null);
export function StrategyDraftSession({ project, children }: { project: ProjectView; children: ReactNode }) {
  return <Context.Provider value={useStrategyOwner(project)}>{children}</Context.Provider>;
}
export function useStrategyDraftSession() { const owner = useContext(Context); if (!owner) throw new Error("Strategies require a project draft owner"); return owner; }
export function useOptionalStrategyDraftSession() { return useContext(Context); }
