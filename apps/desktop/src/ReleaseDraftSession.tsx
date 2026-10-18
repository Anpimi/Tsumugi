import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { validateResponseIdentity } from "./generated/execution.validators";
import { validateRequestArtifactWorkflowPrepare, validateRequestArtifactWorkflowStart } from "./generated/release.validators";
import { executionCommands, confirmExecutionAction, confirmExecutionReceipt, type AttemptDetail, type Receipt } from "./executionCommands";
import { hasUnknownOutcome, projectCommands, type ProjectView } from "./projectCommands";
import { useSessionReads, useSessionAlive } from "./SessionReadProvider";
import { reviewCommands, type Eligibility } from "./reviewCommands";
import { sourceCommands } from "./sourceCommands";
import { pluginCommands, type PluginBuildRequest, type PluginBuildView } from "./pluginCommands";
import type { ContentScope } from "./generated/source.responses";
import type { ReconcileRequest } from "./generated/release.requests";
import { releaseCommands, confirmReleasePreview, confirmReleaseDelivery, sameArtifactWorkflowMaterialization, type ReleasePluginIntent,
  type PluginBuildPrepareRequest, type PluginBuildReview, type ArtifactCheckReview, type PluginStartRequest,
  type ArtifactCheckWorkflowPrepareRequest, type ArtifactCheckWorkflowStartRequest, type ArtifactCheckWorkflowStopRequest,
  type ArtifactCheckWorkflowReadRequest, type ArtifactCheckWorkflowObservation, type ArtifactCheckWorkflowView,
  type ArtifactCheckWorkflowStopReceipt, type ArtifactCheckWorkflowConsent,
  type ExportRequest, type DeliverySelection, type DeliveryPreview, type DeliveryView, type ReleaseView } from "./releaseCommands";

interface BuildPending { kind: "build"; intent: ReleasePluginIntent; editSeq: number; version: number; retryAllowed: boolean; uncertain: boolean; sourceSnapshotId: string | null }
interface ExportPending {
  kind: "export"; request: ExportRequest; preview: DeliveryPreview; selection: DeliverySelection;
  recoverySelection: DeliverySelection | null; receipt: DeliveryView | null;
}
interface ReconcilePending {
  kind: "reconcile"; request: ReconcileRequest; selection: DeliverySelection;
  recoverySelection: DeliverySelection | null; receipt: DeliveryView;
}
type Pending = BuildPending | ExportPending | ReconcilePending;
interface Assessment { editSeq: number; version: number; scope: ContentScope; build: PluginBuildView; sourceLocale: string; targetLocales: string[] }
export interface ReleaseReadProof { current: () => boolean; dispose: () => void }
interface WorkflowCapture {
  request: ArtifactCheckWorkflowPrepareRequest;
  review: ArtifactCheckWorkflowView | null;
  approved: string[];
  start: ArtifactCheckWorkflowStartRequest | null;
  stop: ArtifactCheckWorkflowStopRequest | null;
  pending: "prepare" | "start" | null;
  uncertain: boolean;
  stopPending: boolean;
  stopUncertain: boolean;
  safety: Pick<ArtifactCheckWorkflowStopReceipt, "admissionClosed" | "callbacksDrained" | "currentTask"> | null;
  observed: string | null;
}
interface State {
  languages: string[]; names: Record<string, string>; configuration: Record<string, PluginBuildPrepareRequest["choices"][number]["configuration"]>;
  choiceKey: string; runtimeDigest: string; buildChoice: PluginBuildRequest | null;
  editSeq: number; buildDirty: boolean; deliveryDirty: boolean; stale: boolean;
  eligibility: Eligibility | null; assessment: Assessment | null;
  prepared: { request: PluginBuildPrepareRequest; review: PluginBuildReview } | null;
  buildConsent: string | null; checkReview: ArtifactCheckReview | null; checkConsent: string | null; checkAttempt: string | null;
  savedAttempt: string | null; buildReceipt: Receipt | null;
  workflow: WorkflowCapture | null; workflowControlBusy: boolean; workflowStopBusy: boolean;
  chosen: ReleaseView | null; selection: DeliverySelection | null; preview: DeliveryPreview | null; overwrite: boolean;
  attempt: string | null; result: DeliveryView | null; pending: Pending | null; busy: boolean; checkingDelivery: boolean; checkingStart: boolean;
  failure: CommandFailure | null; failureArea: "build" | "delivery" | null; exportMissing: boolean; earlierBuild: boolean;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function fixed<T>(value: T): T { return freeze(structuredClone(value)); }
function initial(): State {
  return { languages: [], names: {}, configuration: {}, choiceKey: "", runtimeDigest: "", buildChoice: null,
    editSeq: 0, buildDirty: false, deliveryDirty: false, stale: false, eligibility: null, assessment: null,
    prepared: null, buildConsent: null, checkReview: null, checkConsent: null, checkAttempt: null, savedAttempt: null, buildReceipt: null, workflow: null, workflowControlBusy: false, workflowStopBusy: false,
    chosen: null, selection: null, preview: null, overwrite: false, attempt: null, result: null, pending: null, busy: false, checkingDelivery: false, checkingStart: false,
    failure: null, failureArea: null, exportMissing: false, earlierBuild: false };
}
const sameScope = (a: ContentScope, b: ContentScope) => a.revision === b.revision && a.currentSnapshot === b.currentSnapshot;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function invalidAck(): never { throw new Error("Invalid release business acknowledgement"); }
function matchesBuild(request: PluginBuildRequest, view: PluginBuildView) {
  return request.resourceId === view.resourceId && request.environmentDigest === view.environmentDigest
    && [view.builder.provider, view.checker.provider].every(provider => provider.packageDigest === request.package.packageDigest
      && same(provider.plugin, request.package.plugin));
}

function useReleaseOwner(project: ProjectView) {
  const reads = useSessionReads();
  const [session] = useState(() => Object.freeze({ ...reads.context }));
  const [state, setState] = useState<State>(() => freeze(initial()));
  const stateRef = useRef(state), projectRef = useRef(project), mounted = useSessionAlive();
  const flight = useRef<object | null>(null), version = useRef(0);
  const workflowPrimaryFlight = useRef<object | null>(null), workflowStopFlight = useRef<object | null>(null), workflowReadFlight = useRef<object | null>(null);
  const readCleanup = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { mounted.current = true; return () => {
    mounted.current = false; flight.current = null; readCleanup.current?.(); readCleanup.current = null;
  }; }, []);
  useLayoutEffect(() => {
    const old = projectRef.current;
    projectRef.current = project;
    if (old.metadata.sourceLocale !== project.metadata.sourceLocale
      || !same(old.metadata.targetLocales, project.metadata.targetLocales)) revoke();
  }, [project]);
  function live() { return mounted.current && projectRef.current.sessionToken === session.sessionToken && projectRef.current.metadata.projectId === session.projectId
    && reads.context.sessionToken === session.sessionToken && reads.context.projectId === session.projectId; }
  function current() { return stateRef.current; }
  function update(change: (before: State) => State) { if (live()) { stateRef.current = freeze(change(current())); setState(stateRef.current); } }
  function reportFailure(failure: CommandFailure | null, area: "build" | "delivery" = "build") { update(before => ({ ...before, failure, failureArea: area })); }
  function workflowWorking() {
    const value = current().workflow;
    return !!value && (!!value.pending || value.stopPending || (!value.review || !!value.start || !!value.stop)
      && !(value.safety?.admissionClosed && value.safety.callbacksDrained));
  }
  function reserved() { return !!flight.current || !!workflowStopFlight.current || !!workflowReadFlight.current || !!current().pending || workflowWorking(); }
  function available() { return current().languages.length > 0 && current().languages.every(locale => projectRef.current.metadata.targetLocales.includes(locale)); }
  function revoke() { version.current++; update(before => ({ ...before, eligibility: null, assessment: null, stale: before.languages.length > 0 || before.stale })); }
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(scope => ["project", "source", "translation", "resources", "review"].includes(scope))) revoke();
  }), [reads]);
  function setBuildSelection(buildChoice: PluginBuildRequest | null, choiceKey: string, runtimeDigest: string) {
    if (!live() || reserved() || current().prepared || current().attempt) return;
    if (same(current().buildChoice, buildChoice) && current().choiceKey === choiceKey && current().runtimeDigest === runtimeDigest) return;
    version.current++;
    update(before => ({ ...before, buildChoice: buildChoice && fixed(buildChoice), choiceKey, runtimeDigest, eligibility: null, assessment: null,
      stale: before.languages.length > 0, buildConsent: null }));
  }
  function setLanguage(locale: string, checked: boolean) {
    if (!live() || (checked && !projectRef.current.metadata.targetLocales.includes(locale))) return;
    update(before => ({ ...before, languages: checked ? [...new Set([...before.languages, locale])] : before.languages.filter(value => value !== locale),
      editSeq: before.editSeq + 1, buildDirty: true, eligibility: null, assessment: null, earlierBuild: false }));
  }
  function setName(locale: string, value: string) {
    update(before => ({ ...before, names: { ...before.names, [locale]: value }, editSeq: before.editSeq + 1,
      buildDirty: true, eligibility: null, assessment: null, earlierBuild: false }));
  }
  function setConfiguration(locale: string, value: PluginBuildPrepareRequest["choices"][number]["configuration"]) {
    update(before => ({ ...before, configuration: { ...before.configuration, [locale]: fixed(value) }, editSeq: before.editSeq + 1,
      buildDirty: true, eligibility: null, assessment: null, earlierBuild: false }));
  }
  function choices() { const before = current(); return before.languages.map(locale => ({ locale,
    outputPaths: (before.names[locale] ?? "").split(/\r?\n/).filter(path => path.length > 0), configuration: before.configuration[locale] ?? [] })); }
  async function run(work: () => Promise<void>, recovery = false, area: "build" | "delivery" = "delivery") {
    if (!live() || flight.current || (!recovery && current().pending)) return;
    const ticket = {}; flight.current = ticket;
    update(before => ({ ...before, busy: true, failure: null, failureArea: area }));
    try { await work(); }
    catch (failure) { if (live()) update(before => {
      const notice = commandFailure(failure, "storage-failed");
      return { ...before, failure: before.pending && hasUnknownOutcome(failure) && typeof notice === "string" ? "outcome-unknown" : notice };
    }); }
    finally { if (live() && flight.current === ticket) { flight.current = null; update(before => ({ ...before, busy: false })); } }
  }
  function runBuild(work: () => Promise<void>, recovery = false) { return run(work,recovery,"build"); }
  async function withReadProof(proof: ReleaseReadProof | undefined, work: () => Promise<void>) {
    if (!live() || flight.current || current().pending || proof?.current() === false) { proof?.dispose(); return; }
    let disposed = false;
    const dispose = () => { if (!disposed) { disposed = true; proof?.dispose(); } };
    readCleanup.current = dispose;
    try { await work(); }
    finally { dispose(); if (readCleanup.current === dispose) readCleanup.current = null; }
  }
  async function assess(build: PluginBuildView, proof?: ReleaseReadProof) {
    const before = current(), generation = version.current, sourceLocale = projectRef.current.metadata.sourceLocale,
      targetLocales = [...projectRef.current.metadata.targetLocales];
    if (!available() || !before.buildChoice || !matchesBuild(before.buildChoice,build)) { proof?.dispose(); return; }
    await withReadProof(proof, () => runBuild(async () => {
      update(value => ({ ...value, eligibility: null, assessment: null }));
      const scope = await sourceCommands.scope(session);
      if (!live() || proof?.current() === false) return;
      const eligibility = await reviewCommands.eligibility({ ...session, locales: [...before.languages] });
      if (!live() || proof?.current() === false || current().editSeq !== before.editSeq || generation !== version.current || !available()
        || sourceLocale !== projectRef.current.metadata.sourceLocale || !same(targetLocales,projectRef.current.metadata.targetLocales)) return;
      if (scope.currentSnapshot !== eligibility.sourceSnapshotId || eligibility.locales.length !== before.languages.length
        || new Set(eligibility.locales.map(value => value.locale)).size !== before.languages.length
        || eligibility.locales.some(value => !before.languages.includes(value.locale))) invalidAck();
      update(value => ({ ...value, eligibility: fixed(eligibility), assessment: fixed({ editSeq: before.editSeq, version: generation,
        scope, build, sourceLocale, targetLocales }), stale: false }));
    }));
  }
  function samePreparation(before: State, assessment: Assessment) {
    return live() && available() && current().editSeq === before.editSeq && version.current === assessment.version
      && current().assessment === assessment && same(current().buildChoice,before.buildChoice)
      && projectRef.current.metadata.sourceLocale === assessment.sourceLocale && same(projectRef.current.metadata.targetLocales,assessment.targetLocales);
  }
  function original(pending: BuildPending) { return live() && current().pending === pending; }
  function acceptBuildStart(sent: BuildPending) {
    if (!original(sent)) return;
    const intent = sent.intent;
    if (intent.kind !== "start-build" && intent.kind !== "start-check") return;
    update(before => ({ ...before, ...(intent.kind === "start-build" ? { attempt: intent.request.attemptId,
      buildDirty: before.editSeq !== sent.editSeq || version.current !== sent.version,
      earlierBuild: before.editSeq !== sent.editSeq || version.current !== sent.version, eligibility: null, assessment: null }
      : { checkAttempt: intent.request.attemptId }), pending: null, failure: null }));
  }
  async function readBuildStart(pending: BuildPending) {
    if (!original(pending) || (pending.intent.kind !== "start-build" && pending.intent.kind !== "start-check")) return;
    const sent = fixed({ ...pending, retryAllowed: false }), intent = pending.intent;
    update(before => ({ ...before, pending: sent, checkingStart: true }));
    try {
      const value = await executionCommands.pluginStartAction({ ...session, attemptId: intent.request.attemptId,
        inputDigest: intent.request.inputDigest, operation: intent.kind === "start-build" ? "locale-build" : "artifact-semantic-check" });
      if (!original(sent)) return;
      if (value) { acceptBuildStart(sent); reads.invalidate(["execution", "release"], false); }
      else update(before => ({ ...before, pending: fixed({ ...sent, retryAllowed: true }) }));
    } finally { if (live()) update(before => ({ ...before, checkingStart: false })); }
  }
  async function submitBuild(pending: BuildPending, proof?: ReleaseReadProof): Promise<void> {
    const sent = fixed({ ...pending, retryAllowed: false });
    update(before => ({ ...before, pending: sent }));
    const intent = sent.intent;
    try {
      switch (intent.kind) {
        case "prepare-build": {
          const review = await releaseCommands.preparePlugin(intent.request);
          if (sent.sourceSnapshotId !== null && review.sourceSnapshotId !== sent.sourceSnapshotId) invalidAck();
          if (original(sent)) update(before => ({ ...before, prepared: fixed({ request: intent.request, review }), buildConsent: null, pending: null,
            buildDirty: true, earlierBuild: before.editSeq !== sent.editSeq || version.current !== sent.version }));
          break;
        }
        case "prepare-check": {
          const review = await releaseCommands.prepareCheck(intent.request);
          if (original(sent)) update(before => ({ ...before, checkReview: fixed(review), checkAttempt: null, checkConsent: null, pending: null }));
          break;
        }
        case "start-build": case "start-check": {
          const id = intent.kind === "start-build" ? await releaseCommands.startPlugin(intent.request) : await releaseCommands.startCheck(intent.request);
          if (id !== intent.request.attemptId) invalidAck();
          acceptBuildStart(sent);
          break;
        }
        case "finish-check": {
          await releaseCommands.finishCheck(intent.request);
          if (original(sent)) update(before => ({ ...before, checkReview: null, checkAttempt: null, checkConsent: null, pending: null }));
          break;
        }
        case "adopt": {
          if (!intent.prepared) {
            const action = await executionCommands.prepare(intent.request);
            confirmExecutionAction(intent.request,"locale-build",action);
            if (!original(sent)) return;
            const next = fixed({ ...sent, intent: { ...intent, prepared: true } });
            update(before => ({ ...before, pending: next }));
            if (proof?.current() === false) { update(before => ({ ...before,pending:fixed({ ...next,uncertain:true }) })); invalidAck(); }
            return submitBuild(next,proof);
          }
          const receipt = await executionCommands.adopt({ ...session, actionId: intent.request.actionId });
          confirmExecutionReceipt(intent.request,receipt);
          if (original(sent)) update(before => ({ ...before, buildReceipt: fixed(receipt), pending: null }));
          break;
        }
      }
    } catch (failure) {
      if (original(sent)) {
        const uncertain = sent.uncertain || hasUnknownOutcome(failure);
        const retained = uncertain ? fixed({ ...sent, uncertain: true }) : null;
        update(before => ({ ...before, pending: retained,
          ...(!uncertain ? intent.kind === "start-build" ? { buildConsent: null } : intent.kind === "start-check" ? { checkConsent: null } : {} : {}) }));
        if (retained && (intent.kind === "start-build" || intent.kind === "start-check")) {
          await readBuildStart(retained);
          if (!live() || !current().pending) return;
        }
      }
      throw failure;
    } finally { if (live()) reads.invalidate(["execution", "release"], false); }
  }
  function pendingFor(intent: ReleasePluginIntent, before = current(), generation = version.current): BuildPending { return fixed({ kind: "build", intent, editSeq: before.editSeq,
    version: generation, retryAllowed: false, uncertain: false, sourceSnapshotId: before.assessment?.scope.currentSnapshot ?? before.prepared?.review.sourceSnapshotId ?? null }); }
  async function build(proof?: ReleaseReadProof) {
    const before = current(), assessment = before.assessment;
    if (before.prepared || before.attempt || !assessment || !before.eligibility?.ready || !before.buildChoice || !samePreparation(before,assessment)
      || choices().some(choice => choice.outputPaths.length === 0)) { proof?.dispose(); return; }
    const capturedAssessment: Assessment = assessment;
    const selected = fixed(before.buildChoice), mapping = fixed(choices()), expectedEligibilityBasis = before.eligibility.basis;
    await withReadProof(proof, () => runBuild(async () => {
      async function recheck() {
        const scope = await sourceCommands.scope(session);
        if (!live() || proof?.current() === false || !samePreparation(before,capturedAssessment)) return false;
        const actual = await pluginCommands.build(selected);
        if (proof?.current() === false || !samePreparation(before,capturedAssessment) || !sameScope(scope,capturedAssessment.scope) || !same(actual,capturedAssessment.build)) { if (live()) revoke(); return false; }
        return true;
      }
      if (!await recheck()) return;
      const attemptId = await executionCommands.identity(session);
      if (!live() || proof?.current() === false || !samePreparation(before,capturedAssessment) || !await recheck()) return;
      await submitBuild(pendingFor({ kind: "prepare-build", request: fixed({ ...session, attemptId, choices: mapping, build: selected, expectedEligibilityBasis }) }));
    }));
  }
  function setConsent(checker: boolean, value: boolean) {
    const before = current(), review = checker ? before.checkReview : before.prepared?.review;
    if (!live() || reserved() || before.workflow || !review || (checker ? before.checkAttempt : before.attempt)) return;
    update(state => ({ ...state, ...(checker ? { checkConsent: value ? review.inputDigest : null } : { buildConsent: value ? review.inputDigest : null }) }));
  }
  async function startBuild(checker = false) {
    const before = current(), review = checker ? before.checkReview : before.prepared?.review;
    if (before.workflow) return;
    if (!review || (checker ? before.checkConsent : before.buildConsent) !== review.inputDigest || (checker ? before.checkAttempt : before.attempt)) return;
    const captured = fixed({ attemptId: review.attemptId, inputDigest: review.inputDigest });
    const expiresAtMs = String(Date.now()+600_000), generation = version.current;
    await runBuild(async () => {
      const grantId = await executionCommands.identity(session);
      if (!live() || (checker ? current().checkReview : current().prepared?.review) !== review
        || (checker ? current().checkConsent : current().buildConsent) !== captured.inputDigest) return;
      const request: PluginStartRequest = fixed({ ...session, ...captured, grantId, expiresAtMs, unsandboxedExecution: true });
      await submitBuild(pendingFor({ kind: checker ? "start-check" : "start-build", request },before,generation));
    });
  }
  async function prepareCheck(buildAttemptId: string, buildResultId: string, proof?: ReleaseReadProof) {
    const before = current(), build = before.prepared?.request.build;
    if (!build || before.attempt !== buildAttemptId || before.checkReview || before.workflow) { proof?.dispose(); return; }
    const captured = fixed({ buildAttemptId, buildResultId, build });
    await withReadProof(proof, () => runBuild(async () => {
      const attemptId = await executionCommands.identity(session);
      if (!live() || proof?.current() === false || current().prepared !== before.prepared || current().attempt !== buildAttemptId) return;
      await submitBuild(pendingFor({ kind: "prepare-check", request: { ...session, ...captured, attemptId } }));
    }));
  }
  async function finishCheck(resultId: string, proof?: ReleaseReadProof) {
    const before = current(); if (!before.checkReview || !before.checkAttempt || before.workflow) { proof?.dispose(); return; }
    const request = fixed({ ...session, attemptId: before.checkAttempt, resultId });
    await withReadProof(proof, () => runBuild(() => submitBuild(pendingFor({ kind: "finish-check", request }))));
  }
  async function recordBuild(detail: AttemptDetail, proof?: ReleaseReadProof) {
    const before = current(), unit = detail.recovery.units.length === 1 ? detail.recovery.units[0] : null;
    if (before.buildReceipt || !before.prepared || before.attempt !== detail.attemptId || detail.operation !== "locale-build" || detail.nextOffset !== null
      || detail.recovery.attemptId !== detail.attemptId || detail.items.length !== detail.progress.total
      || detail.items.length !== before.prepared.review.choices.length || new Set(detail.items.map(item=>item.status.itemId)).size !== detail.items.length
      || before.prepared.review.choices.some(choice=>detail.items.filter(item=>item.scope.locale===choice.locale).length!==1) || !unit?.actions.includes("adopt-result")
      || detail.items.some(item => !item.resultId || item.status.execution !== "succeeded" || item.status.validation !== "valid" || item.status.cancellationRequested)
      || unit.itemIds.length !== detail.items.length || !unit.itemIds.every(id=>detail.items.some(item=>item.status.itemId===id))
      || unit.resultIds.length !== detail.items.length || !unit.resultIds.every(id => detail.items.some(item => item.resultId === id))) { proof?.dispose(); return; }
    const captured = fixed({ attemptId: detail.attemptId, unitId: unit.unitId, resultIds: [...unit.resultIds] });
    await withReadProof(proof, () => runBuild(async () => {
      const actionId = await executionCommands.identity(session);
      if (!live() || proof?.current() === false || current().attempt !== captured.attemptId || current().prepared !== before.prepared) return;
      await submitBuild(pendingFor({ kind: "adopt", request: { ...session, ...captured, actionId }, prepared: false }),proof);
    }));
  }
  function workflowReadRequest(): ArtifactCheckWorkflowReadRequest | null {
    const value = current().workflow;
    return value ? fixed({ ...session, preparation: value.request.preparation, start: value.start?.start ?? null }) : null;
  }
  function workflowReadKey(request: ArtifactCheckWorkflowReadRequest) {
    return ["release-check-workflow", request.preparation, request.start] as const;
  }
  function workflowOriginal(value: WorkflowCapture) { return live() && current().workflow === value; }
  function workflowSafety(value: Pick<ArtifactCheckWorkflowView, "admissionClosed" | "callbacksDrained" | "currentTask">) {
    return { admissionClosed: value.admissionClosed, callbacksDrained: value.callbacksDrained, currentTask: value.currentTask };
  }
  async function sendWorkflow(kind: "prepare" | "start", original: WorkflowCapture) {
    if (!workflowOriginal(original)) return;
    const sent = fixed({ ...original, pending: kind, observed: null });
    workflowPrimaryFlight.current = flight.current;
    update(before => ({ ...before, workflow: sent }));
    try {
      const view = kind === "prepare" ? await releaseCommands.prepareWorkflow(sent.request)
        : sent.start ? await releaseCommands.startWorkflow(sent.start, sent.request.preparation) : invalidAck();
      if (workflowOriginal(sent)) update(before => ({ ...before, workflow: fixed({ ...sent,
        review: sent.review ?? (view.materializationDigest !== null ? view : null), pending: null, uncertain: false, safety: workflowSafety(view) }) }));
    } catch (failure) {
      if (!workflowOriginal(sent)) return;
      if (workflowOriginal(sent)) update(before => ({ ...before, workflow: fixed({ ...sent,
        pending: sent.uncertain || hasUnknownOutcome(failure) ? kind : null,
        uncertain: sent.uncertain || hasUnknownOutcome(failure) }) }));
      throw failure;
    } finally { if (live()) reads.invalidate(["execution", "release"], false); }
  }
  async function prepareWorkflow(detail: AttemptDetail, proof?: ReleaseReadProof) {
    const before = current(), prepared = before.prepared, generation = version.current;
    if (!live() || reserved() || before.workflow || before.checkReview || before.checkAttempt || !prepared || !before.attempt
      || detail.attemptId !== before.attempt || detail.operation !== "locale-build" || detail.nextOffset !== null
      || detail.items.length === 0 || detail.items.length > 16 || detail.items.length !== detail.progress.total
      || detail.items.length !== prepared.review.choices.length || new Set(detail.items.map(item => item.status.itemId)).size !== detail.items.length
      || prepared.review.choices.some(choice => detail.items.filter(item => item.scope.locale === choice.locale).length !== 1)
      || detail.items.some(item => item.scope.kind !== "release-build" || item.scope.id !== prepared.review.sourceSnapshotId
        || !item.resultId || item.status.execution !== "succeeded" || item.status.cancellationRequested)) { proof?.dispose(); return; }
    const captured = fixed({ buildAttemptId: detail.attemptId, buildInputDigest: prepared.review.inputDigest,
      buildResults: detail.items.map(item => { if (!item.resultId) return invalidAck(); return { itemId: item.status.itemId, resultId: item.resultId }; }),
      build: prepared.request.build });
    await withReadProof(proof, () => runBuild(async () => {
      const owner = await releaseCommands.workflowSession(session);
      if (!live() || proof?.current() === false || current().prepared !== prepared || current().attempt !== captured.buildAttemptId
        || current().editSeq !== before.editSeq || version.current !== generation || current().workflow) return;
      if (owner.kind !== "available") throw new Error("Artifact check workflow owner is unavailable");
      const workflowId = await executionCommands.identity(session);
      if (!live() || proof?.current() === false || current().prepared !== prepared || current().attempt !== captured.buildAttemptId
        || current().editSeq !== before.editSeq || version.current !== generation || current().workflow) return;
      const candidate: unknown = fixed({ ...session, preparation: {
        identity: { ownerId: owner.ownerId, generation: owner.nextGeneration, workflowId }, ...captured } });
      if (!validateRequestArtifactWorkflowPrepare(candidate)) return invalidAck();
      const request = candidate;
      const value: WorkflowCapture = fixed({ request, review: null, approved: [], start: null, stop: null,
        pending: null, uncertain: false, stopPending: false, stopUncertain: false, safety: null, observed: null });
      update(state => ({ ...state, workflow: value }));
      await sendWorkflow("prepare", value);
    }));
  }
  function setWorkflowConsent(attemptId: string | null, approved: boolean) {
    const value = current().workflow;
    if (!live() || reserved() || !value?.review || value.review.phase !== "prepared" || value.start || value.stop || value.safety?.admissionClosed) return;
    const selected = attemptId === null ? value.review.steps.map(item => item.step.attemptId)
      : value.review.steps.filter(item => item.step.attemptId === attemptId).map(item => item.step.attemptId);
    if (!selected.length) return;
    update(before => ({ ...before, workflow: fixed({ ...value, approved: approved
      ? [...new Set([...value.approved, ...selected])] : value.approved.filter(id => !selected.includes(id)) }) }));
  }
  async function startWorkflow() {
    const before = current(), value = before.workflow, generation = version.current;
    if (!live() || reserved() || !value?.review || value.review.phase !== "prepared" || !value.review.materializationDigest
      || value.start || value.stop || value.safety?.admissionClosed || value.approved.length === 0) return;
    const steps = fixed(value.review.steps.filter(item => value.approved.includes(item.step.attemptId)).map(item => item.step));
    const materializationDigest = value.review.materializationDigest, expiresAtMs = String(Date.now() + 600_000);
    if (steps.length !== value.approved.length) return;
    await runBuild(async () => {
      const consents: ArtifactCheckWorkflowConsent[] = [];
      for (const step of steps) {
        const grantId = await executionCommands.identity(session);
        if (!workflowOriginal(value) || current().editSeq !== before.editSeq || version.current !== generation) return;
        consents.push({ step, grantId, expiresAtMs, unsandboxedExecution: true });
      }
      const candidate: unknown = fixed({ ...session, start: {
        identity: value.request.preparation.identity, materializationDigest, consents } });
      if (!validateRequestArtifactWorkflowStart(candidate)) return invalidAck();
      const start = candidate;
      const next = fixed({ ...value, start }); update(state => ({ ...state, workflow: next }));
      await sendWorkflow("start", next);
    }, true);
  }
  async function runWorkflowControl(kind: "stop" | "read", work: (current: () => boolean) => Promise<void>) {
    const control = kind === "stop" ? workflowStopFlight : workflowReadFlight;
    if (!live() || kind === "stop" && control.current || current().pending) return;
    // Replacing a read only retires its local waiter. It never changes execution.
    const ticket = {}; control.current = ticket;
    const original = () => live() && control.current === ticket;
    update(before => ({ ...before, workflowControlBusy: true, workflowStopBusy: !!workflowStopFlight.current }));
    try { await work(original); }
    catch (failure) { if (original()) reportFailure(commandFailure(failure, "outcome-unknown")); }
    finally {
      if (original()) { control.current = null; update(before => ({ ...before, workflowControlBusy: !!workflowStopFlight.current || !!workflowReadFlight.current, workflowStopBusy: !!workflowStopFlight.current })); }
    }
  }
  async function stopWorkflow() {
    const value = current().workflow;
    if (!live() || !value || current().pending || workflowStopFlight.current || value.safety?.admissionClosed && value.safety.callbacksDrained) return;
    const request = value.stop ?? fixed({ ...session, identity: value.request.preparation.identity });
    await runWorkflowControl("stop", async () => {
      if (!workflowOriginal(value)) return;
      const next = fixed({ ...value, stop: request, stopPending: true, observed: null });
      update(before => ({ ...before, workflow: next }));
      try {
        const receipt = await releaseCommands.stopWorkflow(request);
        const now = current().workflow;
        if (live() && now && same(now.request, value.request) && same(now.stop, request)) update(before => ({ ...before,
          workflow: fixed({ ...now, stopPending: false, stopUncertain: false,
            safety: now.safety?.admissionClosed && now.safety.callbacksDrained ? now.safety : workflowSafety(receipt) }) }));
      } catch (failure) {
        const now = current().workflow;
        if (now?.safety?.admissionClosed && now.safety.callbacksDrained) return;
        if (live() && now && same(now.request, value.request) && same(now.stop, request)) update(before => ({ ...before,
          workflow: fixed({ ...now, stopPending: next.stopUncertain || hasUnknownOutcome(failure), stopUncertain: next.stopUncertain || hasUnknownOutcome(failure) }) }));
        throw failure;
      } finally { if (live()) reads.invalidate(["execution", "release"], false); }
    });
  }
  /** Accept only an exact fresh read of this owner's original intent; never dispatch from a read. */
  function observeWorkflow(request: ArtifactCheckWorkflowReadRequest, observation: ArtifactCheckWorkflowObservation) {
    const value = current().workflow;
    if (!live() || !value || !same(request, workflowReadRequest())) return;
    if (value.review && observation.view && observation.view.materializationDigest !== null
      && !sameArtifactWorkflowMaterialization(value.review, observation.view)) return;
    const stamp = JSON.stringify([observation.kind, observation.admissionClosed, observation.callbacksDrained, observation.currentTask,
      observation.view?.phase, observation.view?.materializationDigest, observation.view?.start,
      observation.steps.map(item => [item.step, item.outcome, item.execution, item.resultId, item.proof?.checkerResultDigest])]);
    if (value.observed === stamp) return;
    if (value.safety?.admissionClosed && !observation.admissionClosed
      || value.safety?.callbacksDrained && value.safety.admissionClosed && !observation.callbacksDrained) return;
    let pending = value.pending;
    if (pending === "prepare" && observation.view && observation.view.phase !== "preparing") pending = null;
    if (pending === "start" && observation.view?.start && same(observation.view.start, value.start?.start)) pending = null;
    if (observation.admissionClosed && observation.callbacksDrained) pending = null;
    if (value.pending && pending === null && flight.current === workflowPrimaryFlight.current) {
      flight.current = null; workflowPrimaryFlight.current = null;
      update(before => ({ ...before, busy: false }));
    }
    if (value.stopPending && observation.admissionClosed && observation.callbacksDrained && workflowStopFlight.current) {
      workflowStopFlight.current = null;
      update(before => ({ ...before, workflowStopBusy: false, workflowControlBusy: !!workflowReadFlight.current }));
    }
    update(before => ({ ...before, workflow: fixed({ ...value, observed: stamp,
      review: value.review ?? (observation.view?.materializationDigest ? observation.view : null), pending,
      stopPending: value.stopPending && !(observation.admissionClosed && observation.callbacksDrained),
      stopUncertain: value.stopUncertain && !(observation.admissionClosed && observation.callbacksDrained),
      uncertain: pending !== null && value.uncertain, safety: workflowSafety(observation) }) }));
  }
  async function reconcileWorkflow() {
    const request = workflowReadRequest(), value = current().workflow;
    if (!live() || current().pending || !request || !value) return;
    await runWorkflowControl("read", async original => {
      const key = workflowReadKey(request);
      await reads.client.cancelQueries({ queryKey: reads.key(key), exact: true });
      if (!original()) return;
      await reads.client.fetchQuery({ queryKey: reads.key(key), staleTime: 0, meta: { scopes: ["execution", "release"] },
        queryFn: () => releaseCommands.readWorkflow(request) });
      const observation = reads.client.getQueryData<ArtifactCheckWorkflowObservation>(reads.key(key));
      const query = reads.client.getQueryState(reads.key(key));
      if (original() && same(current().workflow?.request, value.request) && same(current().workflow?.start, value.start)
        && observation && query?.status === "success" && !query.isInvalidated && query.fetchStatus === "idle" && !query.error)
        observeWorkflow(request, observation);
    });
  }
  function closeWorkflow() {
    const value = current().workflow;
    if (!live() || flight.current || workflowStopFlight.current || workflowReadFlight.current || !value || value.pending || value.stopPending || !value.safety?.admissionClosed || !value.safety.callbacksDrained) return false;
    update(before => ({ ...before, workflow: null })); return true;
  }
  async function checkBuild() {
    const pending = current().pending; if (pending?.kind !== "build") return;
    await runBuild(async () => {
      if (pending.intent.kind === "start-build" || pending.intent.kind === "start-check") { await readBuildStart(pending); return; }
      if (pending.intent.kind !== "adopt") { await submitBuild(pending); return; }
      const intent = pending.intent;
      const sent = fixed({ ...pending, retryAllowed: false }); update(before => ({ ...before,pending: sent }));
      await projectCommands.read({ sessionToken: session.sessionToken });
      const receipt = await executionCommands.receipt({ ...session, actionId: intent.request.actionId });
      if (!original(sent)) return;
      if (receipt) { confirmExecutionReceipt(intent.request,receipt); update(before => ({ ...before,buildReceipt:fixed(receipt),pending:null })); }
      else update(before => ({ ...before,pending:fixed({ ...sent,retryAllowed:true }) }));
    },true);
  }
  async function retryBuild() { const pending = current().pending;
    if (pending?.kind === "build" && ["adopt", "start-build", "start-check"].includes(pending.intent.kind) && pending.retryAllowed) await runBuild(() => submitBuild(pending),true);
  }
  async function discardBuild(clearDraft = false) {
    const pending = current().pending;
    if (current().workflow && !closeWorkflow()) return false;
    if (pending && (pending.kind !== "build" || !["prepare-build","prepare-check"].includes(pending.intent.kind))) return false;
    let accepted = false;
    await runBuild(async () => {
      const before = current(), generation = version.current; await releaseCommands.cancelPluginPreparation(session);
      if (!live() || current().pending !== before.pending) return;
      const sameDraft = current().editSeq === before.editSeq && version.current === generation;
      update(value => ({ ...value, prepared:null,buildConsent:null,attempt:null,checkReview:null,checkConsent:null,checkAttempt:null,
        eligibility:null,assessment:null,buildReceipt:null,pending:null,savedAttempt:null,
        ...(clearDraft && sameDraft ? {languages:[],names:{},configuration:{},buildDirty:false} : {buildDirty:value.languages.length > 0}) })); accepted = !clearDraft || sameDraft;
    },true); return accepted;
  }
  function showSavedBuild(attemptId: string) {
    const before = current();
    if (!validateResponseIdentity(attemptId) || !live() || reserved() || before.buildDirty || before.deliveryDirty || before.prepared || before.buildConsent || before.checkConsent
      || before.checkReview || before.attempt || before.checkAttempt || before.workflow) return false;
    update(value => ({ ...value,savedAttempt:attemptId })); return true;
  }
  function closeSavedBuild() { if (!reserved()) update(before => ({ ...before,savedAttempt:null })); }
  function chooseRelease(release: ReleaseView) {
    if (reserved()) return;
    update(before => ({ ...before, chosen: fixed(release), selection: null, preview: null, overwrite: false, result: null,
      deliveryDirty: false, exportMissing: false, failure: null }));
  }
  async function chooseFolder(recovery = false) {
    const pending = current().pending;
    if (recovery && (!pending || pending.kind === "build")) return;
    await run(async () => {
      let selection: DeliverySelection | null;
      try { selection = await releaseCommands.choose(session); }
      catch (failure) { update(before => ({ ...before, preview: null, overwrite: false })); throw failure; }
      if (!live() || !selection) return;
      if (recovery && pending && pending.kind !== "build") update(before => ({ ...before, pending: { ...pending, recoverySelection: fixed(selection) } }));
      else update(before => ({ ...before, selection: fixed(selection), preview: null, overwrite: false, result: null,
        deliveryDirty: true, exportMissing: false }));
    }, recovery);
  }
  async function previewFolder() {
    const before = current();
    if (!before.chosen || !before.selection) return;
    await run(async () => {
      // Host replaces the preview lease; the earlier replacement consent cannot authorize it.
      update(value => ({ ...value, preview: null, overwrite: false }));
      const preview = await releaseCommands.preview({ ...session, releaseId: before.chosen!.releaseId, selectionId: before.selection!.selectionId });
      confirmReleasePreview(preview, before.chosen!, before.selection!.selectionId);
      if (!live() || current().chosen !== before.chosen || current().selection !== before.selection) return;
      update(value => ({ ...value, preview: fixed(preview), overwrite: false, result: null, deliveryDirty: true }));
    });
  }
  function setOverwrite(value: boolean) {
    if (reserved() || !current().preview) return;
    update(before => ({ ...before, overwrite: value, deliveryDirty: true }));
  }
  function settleDelivery(pending: ExportPending | ReconcilePending, delivery: DeliveryView) {
    const original = pending.kind === "export" ? pending.request : pending.receipt;
    confirmReleaseDelivery(delivery, original, pending.kind === "export" ? pending.preview.files : pending.receipt.files, pending.receipt);
    if (!live()) return;
    const unresolved = delivery.state === "pending" || delivery.state === "unknown";
    update(before => ({ ...before, result: fixed(delivery), pending: unresolved ? { ...pending, receipt: fixed(delivery) } : null,
      deliveryDirty: unresolved, exportMissing: false }));
  }
  async function lookupDelivery(pending: ExportPending | ReconcilePending) {
    const ticket = flight.current;
    const original = () => {
      const value = current().pending;
      if (!live() || ticket === null || flight.current !== ticket || !value || value.kind === "build"
        || value.request !== pending.request) return null;
      return value;
    };
    if (!original()) return false;
    update(before => ({ ...before, checkingDelivery: true }));
    try {
      const selection = pending.recoverySelection ?? pending.selection;
      const saved = await releaseCommands.deliveryAction({ ...session, actionId: pending.request.actionId, selectionId: selection.selectionId });
      const latest = original();
      if (!latest) return false;
      if (saved) {
        settleDelivery(latest, saved);
        return saved.state !== "pending" && saved.state !== "unknown";
      }
      // A new picker lease cannot prove that an absent action belongs to the original directory.
      if (latest.receipt || latest.recoverySelection) invalidAck();
      update(before => ({ ...before, pending: null, result: null, exportMissing: true, deliveryDirty: false }));
      return true;
    } finally {
      if (live() && flight.current === ticket) update(before => ({ ...before, checkingDelivery: false }));
    }
  }
  async function exportFiles() {
    const before = current();
    if (!before.chosen || !before.selection || !before.preview || (before.preview.files.some(file => file.state === "conflict") && !before.overwrite)) return;
    await run(async () => {
      const ticket = flight.current;
      const actionId = await executionCommands.identity(session);
      if (!live() || flight.current !== ticket || current().chosen !== before.chosen || current().selection !== before.selection
        || current().preview !== before.preview || current().overwrite !== before.overwrite) return;
      confirmReleasePreview(before.preview!, before.chosen!, before.selection!.selectionId);
      const pending: ExportPending = fixed({ kind: "export", request: { ...session, actionId, releaseId: before.chosen!.releaseId,
        selectionId: before.selection!.selectionId, previewId: before.preview!.previewId, overwriteConflicts: before.overwrite },
        preview: before.preview!, selection: before.selection!, recoverySelection: null, receipt: null });
      update(value => ({ ...value, pending, preview: null, overwrite: false, exportMissing: false }));
      try {
        let needsLookup = false, uncertain = false;
        let writeFailure: unknown;
        try {
          const delivery = await releaseCommands.export(pending.request);
          if (!live() || flight.current !== ticket) return;
          settleDelivery(pending, delivery);
          needsLookup = delivery.state === "unknown";
        } catch (failure) {
          if (!live() || flight.current !== ticket) return;
          if (!hasUnknownOutcome(failure)) {
            update(value => ({ ...value, pending: null, deliveryDirty: false }));
            throw failure;
          }
          needsLookup = uncertain = true; writeFailure = failure;
        }
        // The one read is outside the write catch: a failed lookup must not start another lookup.
        const latest = current().pending;
        if (needsLookup && latest?.kind === "export" && latest.request === pending.request) {
          const resolved = await lookupDelivery(latest);
          if (!resolved && uncertain && live() && flight.current === ticket) throw writeFailure;
        }
      } finally { if (live() && flight.current === ticket) reads.invalidate(["release"], false); }
    });
  }
  async function checkExport() {
    const pending = current().pending;
    if (!pending || pending.kind === "build") return;
    await run(async () => {
      const ticket = flight.current;
      await lookupDelivery(pending);
      if (live() && flight.current === ticket) reads.invalidate(["release"], false);
    }, true);
  }
  async function reconcile(delivery: DeliveryView) {
    const before = current(), existing = before.pending;
    if (!before.chosen || !before.selection || (existing && (existing.kind === "build" || existing.request.actionId !== delivery.actionId))) return;
    const pending: ExportPending | ReconcilePending = existing ? existing : fixed({ kind: "reconcile",
      request: { ...session, actionId: delivery.actionId, selectionId: before.selection.selectionId }, selection: before.selection,
      recoverySelection: null, receipt: delivery });
    if (delivery.releaseId !== before.chosen.releaseId) { reportFailure("outcome-unknown","delivery"); return; }
    await run(async () => {
      const ticket = flight.current;
      confirmReleaseDelivery(delivery, delivery, before.chosen!.artifacts.map(file => ({ ...file, expectedSha256: file.sha256 })));
      update(value => ({ ...value, pending }));
      const selection = pending.recoverySelection ?? pending.selection;
      try {
        let needsLookup = false, uncertain = false;
        let writeFailure: unknown;
        try {
          const saved = await releaseCommands.reconcile({ ...session, actionId: pending.request.actionId, selectionId: selection.selectionId });
          if (!live() || flight.current !== ticket) return;
          settleDelivery(pending, saved);
          needsLookup = saved.state === "unknown";
        } catch (failure) {
          if (!live() || flight.current !== ticket) return;
          if (!hasUnknownOutcome(failure)) {
            if (!existing) update(value => ({ ...value, pending: null }));
            throw failure;
          }
          needsLookup = uncertain = true; writeFailure = failure;
        }
        const latest = current().pending;
        if (needsLookup && latest && latest.kind !== "build" && latest.request === pending.request) {
          const resolved = await lookupDelivery(latest);
          if (!resolved && uncertain && live() && flight.current === ticket) throw writeFailure;
        }
      } finally { if (live() && flight.current === ticket) reads.invalidate(["release"], false); }
    }, true);
  }
  function reset() {
    if (!live() || reserved() || current().prepared || current().checkReview || current().attempt || current().checkAttempt || current().workflow) return false;
    version.current++; update(() => initial()); return true;
  }
  return { ...state, current, reserved, available, choices, setBuildSelection, setLanguage, setName, setConfiguration, assess, build,
    setConsent, startBuild, prepareCheck, finishCheck, recordBuild, checkBuild, retryBuild, discardBuild, showSavedBuild, closeSavedBuild,
    workflowWorking, workflowReadRequest, workflowReadKey, prepareWorkflow, setWorkflowConsent, startWorkflow, stopWorkflow,
    observeWorkflow, reconcileWorkflow, closeWorkflow,
    chooseRelease, chooseFolder, previewFolder, setOverwrite, exportFiles, checkExport, reconcile, reportFailure, reset };
}
type ReleaseOwner = ReturnType<typeof useReleaseOwner>;
const ReleaseContext = createContext<ReleaseOwner | null>(null);
/** Own preparation and original actions independently of Release workspace consumers. */
export function ReleaseDraftSession({ project, children }: { project: ProjectView; children: ReactNode }) {
  const owner = useReleaseOwner(project);
  return <ReleaseContext.Provider value={owner}>{children}</ReleaseContext.Provider>;
}
export function useReleaseDraftSession() {
  const owner = useContext(ReleaseContext);
  if (!owner) throw new Error("Release preparation requires a project session owner");
  return owner;
}
