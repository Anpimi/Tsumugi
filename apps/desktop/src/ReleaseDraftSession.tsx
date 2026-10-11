import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionReads } from "./SessionReadProvider";
import { reviewCommands, type Eligibility } from "./reviewCommands";
import { sourceCommands } from "./sourceCommands";
import type { ContentScope, IntegrationDescriptor } from "./generated/source.responses";
import type { ReconcileRequest } from "./generated/release.requests";
import { releaseCommands, confirmReleasePreview, confirmReleaseDelivery, type BuildRequest, type ExportRequest,
  type DeliverySelection, type DeliveryPreview, type DeliveryView, type ReleaseView } from "./releaseCommands";

interface BuildPending { kind: "build"; request: BuildRequest; editSeq: number; version: number; retryAllowed: boolean; uncertain: boolean }
interface ExportPending {
  kind: "export"; request: ExportRequest; preview: DeliveryPreview; selection: DeliverySelection;
  recoverySelection: DeliverySelection | null; receipt: DeliveryView | null;
}
interface ReconcilePending {
  kind: "reconcile"; request: ReconcileRequest; selection: DeliverySelection;
  recoverySelection: DeliverySelection | null; receipt: DeliveryView;
}
type Pending = BuildPending | ExportPending | ReconcilePending;
interface Assessment { editSeq: number; version: number; scope: ContentScope; integration: IntegrationDescriptor; sourceLocale: string; targetLocales: string[] }
interface State {
  languages: string[]; names: Record<string, string>; editedNames: string[]; integration: IntegrationDescriptor | null;
  editSeq: number; buildDirty: boolean; deliveryDirty: boolean; stale: boolean;
  eligibility: Eligibility | null; assessment: Assessment | null;
  chosen: ReleaseView | null; selection: DeliverySelection | null; preview: DeliveryPreview | null; overwrite: boolean;
  attempt: string | null; result: DeliveryView | null; pending: Pending | null; busy: boolean;
  failure: CommandFailure | null; exportMissing: boolean; earlierBuild: boolean;
}
function suggestedFile(locale: string, caption = false) { return caption ? `${locale}.vtt` : locale === "zh-CN" ? "zh.json" : ""; }
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function fixed<T>(value: T): T { return freeze(structuredClone(value)); }
function initial(project: ProjectView, integration: IntegrationDescriptor | null = null): State {
  return { languages: [], names: Object.fromEntries(project.metadata.targetLocales.map(locale => [locale, suggestedFile(locale, integration?.id === "webvtt")])),
    editedNames: [], integration, editSeq: 0, buildDirty: false, deliveryDirty: false, stale: false, eligibility: null, assessment: null,
    chosen: null, selection: null, preview: null, overwrite: false, attempt: null, result: null, pending: null, busy: false,
    failure: null, exportMissing: false, earlierBuild: false };
}
const sameScope = (a: ContentScope, b: ContentScope) => a.revision === b.revision && a.currentSnapshot === b.currentSnapshot;
function invalidAck(): never { throw new Error("Invalid release business acknowledgement"); }

function useReleaseOwner(project: ProjectView) {
  const reads = useSessionReads();
  const [session] = useState(() => Object.freeze({ ...reads.context }));
  const [state, setState] = useState<State>(() => freeze(initial(project)));
  const stateRef = useRef(state), projectRef = useRef(project), mounted = useRef(false);
  const flight = useRef<object | null>(null), version = useRef(0);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; flight.current = null; }; }, []);
  useLayoutEffect(() => {
    const old = projectRef.current;
    projectRef.current = project;
    if (old.metadata.sourceLocale !== project.metadata.sourceLocale
      || JSON.stringify(old.metadata.targetLocales) !== JSON.stringify(project.metadata.targetLocales)) revoke();
  }, [project]);
  function live() { return mounted.current && projectRef.current.sessionToken === session.sessionToken && projectRef.current.metadata.projectId === session.projectId
    && reads.context.sessionToken === session.sessionToken && reads.context.projectId === session.projectId; }
  function current() { return stateRef.current; }
  function update(change: (before: State) => State) { if (live()) { stateRef.current = freeze(change(current())); setState(stateRef.current); } }
  function reportFailure(failure: CommandFailure) { update(before => ({ ...before, failure })); }
  function reserved() { return !!flight.current || !!current().pending; }
  function available() { return current().languages.length > 0 && current().languages.every(locale => projectRef.current.metadata.targetLocales.includes(locale)); }
  function revoke() { version.current++; update(before => ({ ...before, eligibility: null, assessment: null, stale: before.languages.length > 0 || before.stale })); }
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(scope => ["project", "source", "translation", "resources", "review"].includes(scope))) revoke();
  }), [reads]);
  function observeIntegration(value: IntegrationDescriptor) {
    if (!live() || JSON.stringify(current().integration) === JSON.stringify(value)) return;
    version.current++;
    update(before => ({ ...before, integration: fixed(value), eligibility: null, assessment: null,
      stale: !!before.integration && before.languages.length > 0,
      names: Object.fromEntries([...new Set([...Object.keys(before.names), ...projectRef.current.metadata.targetLocales])].map(locale =>
        [locale, before.editedNames.includes(locale) ? before.names[locale] : suggestedFile(locale, value.id === "webvtt")])) }));
  }
  function setLanguage(locale: string, checked: boolean) {
    if (!live() || (checked && !projectRef.current.metadata.targetLocales.includes(locale))) return;
    update(before => ({ ...before, languages: checked ? [...new Set([...before.languages, locale])] : before.languages.filter(value => value !== locale),
      editSeq: before.editSeq + 1, buildDirty: true, eligibility: null, assessment: null, earlierBuild: false }));
  }
  function setName(locale: string, value: string) {
    update(before => ({ ...before, names: { ...before.names, [locale]: value }, editedNames: [...new Set([...before.editedNames, locale])],
      editSeq: before.editSeq + 1, buildDirty: true, eligibility: null, assessment: null, earlierBuild: false }));
  }
  async function run(work: () => Promise<void>, recovery = false) {
    if (!live() || flight.current || (!recovery && current().pending)) return;
    const ticket = {}; flight.current = ticket;
    update(before => ({ ...before, busy: true, failure: null }));
    try { await work(); }
    catch (failure) { if (live()) update(before => {
      const notice = commandFailure(failure, "storage-failed");
      return { ...before, failure: before.pending && hasUnknownOutcome(failure) && typeof notice === "string" ? "outcome-unknown" : notice };
    }); }
    finally { if (live() && flight.current === ticket) { flight.current = null; update(before => ({ ...before, busy: false })); } }
  }
  async function assess() {
    if (!available() || !current().integration?.available) return;
    const before = current(), generation = version.current, sourceLocale = projectRef.current.metadata.sourceLocale,
      targetLocales = [...projectRef.current.metadata.targetLocales];
    await run(async () => {
      update(value => ({ ...value, eligibility: null, assessment: null }));
      const [scope, integration, eligibility] = await Promise.all([sourceCommands.scope(session), sourceCommands.integration(session), reviewCommands.eligibility({ ...session, locales: [...before.languages] })]);
      if (!live() || current().editSeq !== before.editSeq || generation !== version.current || !available()
        || sourceLocale !== projectRef.current.metadata.sourceLocale
        || JSON.stringify(targetLocales) !== JSON.stringify(projectRef.current.metadata.targetLocales)) return;
      if (JSON.stringify(integration) !== JSON.stringify(before.integration)) { observeIntegration(integration); return; }
      if (scope.currentSnapshot !== eligibility.sourceSnapshotId || eligibility.locales.length !== before.languages.length
        || new Set(eligibility.locales.map(value => value.locale)).size !== before.languages.length
        || eligibility.locales.some(value => !before.languages.includes(value.locale))) invalidAck();
      update(value => ({ ...value, eligibility: fixed(eligibility), assessment: fixed({ editSeq: before.editSeq, version: generation,
        scope, integration: before.integration!, sourceLocale, targetLocales }), stale: false }));
    });
  }
  function samePreparation(before: State, assessment: Assessment) {
    return live() && available() && current().editSeq === before.editSeq && version.current === assessment.version
      && current().assessment === assessment && !!current().integration?.available
      && projectRef.current.metadata.sourceLocale === assessment.sourceLocale
      && JSON.stringify(projectRef.current.metadata.targetLocales) === JSON.stringify(assessment.targetLocales);
  }
  async function submitBuild(pending: BuildPending) {
    update(before => ({ ...before, pending: { ...pending, retryAllowed: false } }));
    try {
      await releaseCommands.start(pending.request);
      if (!live()) return;
      update(before => ({ ...before, attempt: pending.request.attemptId, pending: null,
        buildDirty: before.editSeq !== pending.editSeq || version.current !== pending.version,
        earlierBuild: before.editSeq !== pending.editSeq || version.current !== pending.version,
        eligibility: null, assessment: null }));
    } catch (failure) {
      if (live()) update(before => ({ ...before, pending: !pending.uncertain && !hasUnknownOutcome(failure) ? null
        : { ...pending, uncertain: true, retryAllowed: false } }));
      throw failure;
    } finally { if (live()) { update(before => ({ ...before, eligibility: null, assessment: null })); reads.invalidate(["execution", "release"], false); } }
  }
  async function build() {
    const before = current(), assessment = before.assessment;
    if (!assessment || !before.eligibility?.ready || !samePreparation(before, assessment) || before.languages.some(locale => !before.names[locale]?.trim())) return;
    const choices = fixed(before.languages.map(locale => ({ locale, fileName: before.integration?.id === "webvtt"
      ? before.names[locale].trim() : `i18n/${before.names[locale].trim()}` })));
    const expectedEligibilityBasis = before.eligibility.basis;
    await run(async () => {
      const [scope, integration] = await Promise.all([sourceCommands.scope(session), sourceCommands.integration(session)]);
      if (!samePreparation(before, assessment) || !sameScope(scope, assessment.scope)
        || JSON.stringify(integration) !== JSON.stringify(assessment.integration)) { if (live()) { observeIntegration(integration); revoke(); } return; }
      const attemptId = await executionCommands.identity(session);
      if (!samePreparation(before, assessment)) return;
      const [latest, latestIntegration] = await Promise.all([sourceCommands.scope(session), sourceCommands.integration(session)]);
      if (!samePreparation(before, assessment) || !sameScope(latest, assessment.scope)
        || JSON.stringify(latestIntegration) !== JSON.stringify(assessment.integration)) { if (live()) { observeIntegration(latestIntegration); revoke(); } return; }
      await submitBuild({ kind: "build", request: fixed({ ...session, attemptId, choices, expectedEligibilityBasis }), editSeq: before.editSeq,
        version: assessment.version, retryAllowed: false, uncertain: false });
    });
  }
  async function checkBuild() {
    const pending = current().pending;
    if (pending?.kind !== "build") return;
    await run(async () => {
      update(before => ({ ...before, pending: { ...pending, retryAllowed: false } }));
      const saved = await releaseCommands.buildAttempt(pending.request);
      if (!live()) return;
      if (saved) update(before => ({ ...before, attempt: pending.request.attemptId, pending: null,
        buildDirty: before.editSeq !== pending.editSeq || version.current !== pending.version,
        earlierBuild: before.editSeq !== pending.editSeq || version.current !== pending.version, eligibility: null, assessment: null }));
      else update(before => ({ ...before, pending: { ...pending, retryAllowed: true } }));
    }, true);
  }
  async function retryBuild() {
    const pending = current().pending;
    if (pending?.kind === "build" && pending.retryAllowed) await run(() => submitBuild(pending), true);
  }
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
    if (delivery.releaseId !== before.chosen.releaseId) { reportFailure("outcome-unknown"); return; }
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
    if (!live() || reserved()) return false;
    version.current++; update(before => initial(projectRef.current, before.integration)); return true;
  }
  return { ...state, current, reserved, available, observeIntegration, setLanguage, setName, assess, build, checkBuild, retryBuild,
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
