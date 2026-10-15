import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { validateResponseIdentity } from "./generated/execution.validators";
import { executionCommands, confirmExecutionAction, confirmExecutionReceipt, type AttemptDetail, type Receipt } from "./executionCommands";
import { hasUnknownOutcome, projectCommands, type ProjectView } from "./projectCommands";
import { useSessionReads, useSessionAlive } from "./SessionReadProvider";
import { reviewCommands, type Eligibility } from "./reviewCommands";
import { sourceCommands } from "./sourceCommands";
import { pluginCommands, type PluginBuildRequest, type PluginBuildView } from "./pluginCommands";
import type { ContentScope } from "./generated/source.responses";
import type { ReconcileRequest } from "./generated/release.requests";
import { releaseCommands, confirmReleasePreview, confirmReleaseDelivery, type ReleasePluginIntent,
  type PluginBuildPrepareRequest, type PluginBuildReview, type ArtifactCheckReview, type PluginStartRequest,
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
interface State {
  languages: string[]; names: Record<string, string>; configuration: Record<string, PluginBuildPrepareRequest["choices"][number]["configuration"]>;
  choiceKey: string; runtimeDigest: string; buildChoice: PluginBuildRequest | null;
  editSeq: number; buildDirty: boolean; deliveryDirty: boolean; stale: boolean;
  eligibility: Eligibility | null; assessment: Assessment | null;
  prepared: { request: PluginBuildPrepareRequest; review: PluginBuildReview } | null;
  buildConsent: string | null; checkReview: ArtifactCheckReview | null; checkConsent: string | null; checkAttempt: string | null;
  savedAttempt: string | null; buildReceipt: Receipt | null;
  chosen: ReleaseView | null; selection: DeliverySelection | null; preview: DeliveryPreview | null; overwrite: boolean;
  attempt: string | null; result: DeliveryView | null; pending: Pending | null; busy: boolean;
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
    prepared: null, buildConsent: null, checkReview: null, checkConsent: null, checkAttempt: null, savedAttempt: null, buildReceipt: null,
    chosen: null, selection: null, preview: null, overwrite: false, attempt: null, result: null, pending: null, busy: false,
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
  function reserved() { return !!flight.current || !!current().pending; }
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
          if (original(sent)) update(before => ({ ...before, ...(intent.kind === "start-build" ? { attempt: id,
            buildDirty: before.editSeq !== sent.editSeq || version.current !== sent.version,
            earlierBuild: before.editSeq !== sent.editSeq || version.current !== sent.version, eligibility: null, assessment: null } : { checkAttempt: id }), pending: null }));
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
      if (original(sent)) update(before => ({ ...before, pending: sent.uncertain || hasUnknownOutcome(failure) ? fixed({ ...sent, uncertain: true }) : null,
        ...(!sent.uncertain && !hasUnknownOutcome(failure) ? intent.kind === "start-build" ? { buildConsent: null } : intent.kind === "start-check" ? { checkConsent: null } : {} : {}) }));
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
    if (!live() || reserved() || !review || (checker ? before.checkAttempt : before.attempt)) return;
    update(state => ({ ...state, ...(checker ? { checkConsent: value ? review.inputDigest : null } : { buildConsent: value ? review.inputDigest : null }) }));
  }
  async function startBuild(checker = false) {
    const before = current(), review = checker ? before.checkReview : before.prepared?.review;
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
    if (!build || before.attempt !== buildAttemptId || before.checkReview) { proof?.dispose(); return; }
    const captured = fixed({ buildAttemptId, buildResultId, build });
    await withReadProof(proof, () => runBuild(async () => {
      const attemptId = await executionCommands.identity(session);
      if (!live() || proof?.current() === false || current().prepared !== before.prepared || current().attempt !== buildAttemptId) return;
      await submitBuild(pendingFor({ kind: "prepare-check", request: { ...session, ...captured, attemptId } }));
    }));
  }
  async function finishCheck(resultId: string, proof?: ReleaseReadProof) {
    const before = current(); if (!before.checkReview || !before.checkAttempt) { proof?.dispose(); return; }
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
  async function checkBuild() {
    const pending = current().pending; if (pending?.kind !== "build") return;
    await runBuild(async () => {
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
    if (pending?.kind === "build" && pending.intent.kind === "adopt" && pending.retryAllowed) await runBuild(() => submitBuild(pending),true);
  }
  async function discardBuild(clearDraft = false) {
    const pending = current().pending;
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
      || before.checkReview || before.attempt || before.checkAttempt) return false;
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
  async function exportFiles() {
    const before = current();
    if (!before.chosen || !before.selection || !before.preview || (before.preview.files.some(file => file.state === "conflict") && !before.overwrite)) return;
    await run(async () => {
      const actionId = await executionCommands.identity(session);
      if (!live() || current().chosen !== before.chosen || current().selection !== before.selection
        || current().preview !== before.preview || current().overwrite !== before.overwrite) return;
      confirmReleasePreview(before.preview!, before.chosen!, before.selection!.selectionId);
      const pending: ExportPending = fixed({ kind: "export", request: { ...session, actionId, releaseId: before.chosen!.releaseId,
        selectionId: before.selection!.selectionId, previewId: before.preview!.previewId, overwriteConflicts: before.overwrite },
        preview: before.preview!, selection: before.selection!, recoverySelection: null, receipt: null });
      update(value => ({ ...value, pending, preview: null, overwrite: false, exportMissing: false }));
      try { settleDelivery(pending, await releaseCommands.export(pending.request)); }
      catch (failure) { if (live() && !hasUnknownOutcome(failure)) update(value => ({ ...value, pending: null, deliveryDirty: false })); throw failure; }
      finally { if (live()) reads.invalidate(["release"], false); }
    });
  }
  async function checkExport() {
    const pending = current().pending;
    if (!pending || pending.kind === "build") return;
    await run(async () => {
      const selection = pending.recoverySelection ?? pending.selection;
      const saved = await releaseCommands.deliveryAction({ ...session, actionId: pending.request.actionId, selectionId: selection.selectionId });
      if (!live()) return;
      if (saved) settleDelivery(pending, saved);
      else {
        // A new picker lease cannot prove that an absent action belongs to the original directory.
        if (pending.receipt || pending.recoverySelection) invalidAck();
        update(before => ({ ...before, pending: null, result: null, exportMissing: true, deliveryDirty: false }));
      }
      reads.invalidate(["release"], false);
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
      confirmReleaseDelivery(delivery, delivery, before.chosen!.artifacts.map(file => ({ ...file, expectedSha256: file.sha256 })));
      update(value => ({ ...value, pending }));
      const selection = pending.recoverySelection ?? pending.selection;
      try { settleDelivery(pending, await releaseCommands.reconcile({ ...session, actionId: pending.request.actionId, selectionId: selection.selectionId })); }
      catch (failure) { if (live() && !existing && !hasUnknownOutcome(failure)) update(value => ({ ...value, pending: null })); throw failure; }
      finally { if (live()) reads.invalidate(["release"], false); }
    }, true);
  }
  function reset() {
    if (!live() || reserved() || current().prepared || current().checkReview || current().attempt || current().checkAttempt) return false;
    version.current++; update(() => initial()); return true;
  }
  return { ...state, current, reserved, available, choices, setBuildSelection, setLanguage, setName, setConfiguration, assess, build,
    setConsent, startBuild, prepareCheck, finishCheck, recordBuild, checkBuild, retryBuild, discardBuild, showSavedBuild, closeSavedBuild,
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
