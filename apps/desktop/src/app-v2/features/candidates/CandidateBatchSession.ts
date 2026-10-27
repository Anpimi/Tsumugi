import type { CandidateAuditCapture, CandidateBasis, CandidateDecisionOutcome, useCandidateDecisionSession } from "../../../CandidateDecisionSession";
import { commandFailure, type CommandFailure } from "../../../CommandFailure";
import { validContentSelection } from "../../../contentSelection";
import { sameDraftBasis, type DraftKey } from "../../../draftCommands";
import { executionContext, type SessionRequest } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import type { SessionReads } from "../../../sessionReads";
import { translationCommands, type CandidateDecisionRequest, type TranslationCandidateSliceRow, type TranslationRevision } from "../../../translationCommands";
import type { LifecycleParticipant } from "../../platform/projectLifecycle";
import { copyWorkspaceSelection, workspaceSelectionIds, type WorkspaceSelection } from "../../workspace/workspaceSelection";
import type { DraftEntry, RevisionStageCapture, TranslationDrafts } from "../editor/translationDrafts";
import { readCandidateSliceRows } from "./candidateBatchReads";

export type CandidateBatchMode = "stage" | "reject" | "restore";
export type CandidateBatchPhase = "idle" | "capturing" | "preview" | "running" | "paused" | "complete" | "retired";
export type CandidateBatchSkipReason = "no-candidate" | "multiple-candidates" | "protected" | "human-selection" | "existing-draft"
  | "draft-input" | "merge" | "pending" | "unavailable" | "basis-changed" | "source-changed" | "ended";
export type CandidateBatchPauseReason = "context-changed" | "audit-changed" | "unknown" | "journal" | "failed" | "requested" | "stale";
export interface CandidateBatchItem {
  id: string;
  key: DraftKey;
  nativeKey: string;
  target: ReviewTarget;
  revision: TranslationRevision | null;
  row: TranslationCandidateSliceRow;
  capture: RevisionStageCapture | null;
  status: "ready" | "skipped" | "running" | "staged" | "recorded" | "pending" | "undurable" | "failed";
  skipReason: CandidateBatchSkipReason | null;
  request: CandidateDecisionRequest | null;
  failure: CommandFailure | null;
}
export interface CandidateBatchSnapshot {
  revision: number;
  captureId: number | null;
  phase: CandidateBatchPhase;
  mode: CandidateBatchMode | null;
  selection: WorkspaceSelection | null;
  locale: string | null;
  sourceSnapshotId: string | null;
  scopeId: string | null;
  excluded: readonly string[];
  audit: CandidateAuditCapture | null;
  items: readonly CandidateBatchItem[];
  failure: CommandFailure | null;
  pauseReason: CandidateBatchPauseReason | null;
  ended: boolean;
}
type Decisions = ReturnType<typeof useCandidateDecisionSession>;
export interface CandidateBatchOptions {
  project: ProjectView;
  reads: SessionReads;
  drafts: Pick<TranslationDrafts, "getSnapshot" | "getEntry" | "openMany" | "stageCandidateBatch" | "flush">;
  decisions: () => Decisions;
  read?: typeof translationCommands.candidateSlice;
}
const sameAudit = (left: CandidateAuditCapture | null, right: CandidateAuditCapture) => !!left
  && left.actor === right.actor && left.reason === right.reason && left.editSeq === right.editSeq;
const basisFor = (target: ReviewTarget) => ({ sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId,
  revisionId: target.revisionId, text: target.translationText });
const decisionBasis = (target: ReviewTarget): CandidateBasis => ({ unitId: target.unitId, locale: target.locale,
  sourceRevisionId: target.sourceRevisionId, baseSelectionId: target.selectionId, baseRevisionId: target.revisionId });
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function draftSkip(entry: DraftEntry | undefined, row: TranslationCandidateSliceRow): CandidateBatchSkipReason | null {
  if (!entry?.value || entry.current.kind !== "current" || entry.currentFailure !== null || entry.failure !== null || !entry.basisCurrent) return "unavailable";
  if (entry.busy || entry.journalPending || entry.value.pending) return "pending";
  if (entry.value.merge) return "merge";
  if (entry.value.text !== (entry.value.basis.text ?? "")) return "draft-input";
  if (entry.head.value !== null) return "existing-draft";
  if (!sameDraftBasis(entry.value.basis, basisFor(row.target)) || entry.current.sourceText !== row.target.sourceText) return "basis-changed";
  return null;
}
function sameRevision(left: TranslationRevision, right: TranslationRevision) {
  return left.revisionId === right.revisionId && left.unitId === right.unitId && left.locale === right.locale
    && left.sourceSnapshotId === right.sourceSnapshotId && left.sourceRevisionId === right.sourceRevisionId
    && left.ordinal === right.ordinal && left.text === right.text && left.originKind === right.originKind
    && left.actionId === right.actionId && (left.candidateDecision?.request.actionId ?? null) === (right.candidateDecision?.request.actionId ?? null);
}
function sameTarget(left: ReviewTarget, right: ReviewTarget) {
  return left.unitId === right.unitId && left.locale === right.locale && left.sourceSnapshotId === right.sourceSnapshotId
    && left.sourceRevisionId === right.sourceRevisionId && left.sourceText === right.sourceText && left.basis === right.basis
    && left.selectionId === right.selectionId && left.revisionId === right.revisionId && left.translationText === right.translationText;
}

/** A retained fixed operation plan. Existing owners remain the only writers and recovery authorities. */
export class CandidateBatchSession {
  private project: ProjectView;
  private readonly context: SessionRequest;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private sequence = 0;
  private paused = false;
  private disposed = false;
  private state: CandidateBatchSnapshot = freeze({ revision: 0, captureId: null, phase: "idle", mode: null, selection: null,
    locale: null, sourceSnapshotId: null, scopeId: null, excluded: [], audit: null, items: [], failure: null, pauseReason: null, ended: false });
  constructor(private readonly options: CandidateBatchOptions) {
    this.project = options.project; this.context = executionContext(options.project);
    if (options.reads.context.projectId !== this.context.projectId || options.reads.context.sessionToken !== this.context.sessionToken) throw new Error("Candidate batch belongs to another project session");
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  current = () => this.state;
  private live() { return !this.disposed && !this.options.reads.retired && !this.options.drafts.getSnapshot().retired; }
  private update(patch: Partial<CandidateBatchSnapshot>) {
    if (!this.live()) return;
    this.state = freeze({ ...this.state, ...patch, revision: this.state.revision + 1 }); this.listeners.forEach(listener => listener());
  }
  private item(id: string, patch: Partial<CandidateBatchItem>) {
    this.update({ items: this.state.items.map(item => item.id === id ? { ...item, ...patch } : item) });
  }
  updateProject(project: ProjectView) {
    if (project.metadata.projectId !== this.context.projectId || project.sessionToken !== this.context.sessionToken) throw new Error("Candidate batch project session changed");
    const changed = this.project.metadata.sourceLocale !== project.metadata.sourceLocale
      || this.state.locale !== null && !project.metadata.targetLocales.includes(this.state.locale);
    this.project = project;
    if (changed && this.state.captureId !== null && this.state.phase !== "complete") { this.paused = true; this.update({ phase: "paused", pauseReason: "stale" }); }
  }
  private audit(): CandidateAuditCapture {
    const { actor, reason, editSeq } = this.options.decisions().current(); return { actor, reason, editSeq };
  }
  private unresolved() { return this.state.items.some(item => item.status === "pending" || item.status === "undurable"); }
  async capture(selection: WorkspaceSelection, mode: CandidateBatchMode, proof: () => boolean): Promise<boolean> {
    if (!this.live() || !proof() || this.state.phase !== "idle" && this.state.phase !== "complete") return false;
    const copied = copyWorkspaceSelection(selection); if (!copied) return false;
    if (copied.kind === "scope" && (!validContentSelection(copied.selection) || copied.selection.projectId !== this.context.projectId
      || copied.selection.sessionToken !== this.context.sessionToken)) return false;
    const locale = copied.kind === "ids" ? copied.locale : copied.selection.capture.locale;
    const sourceSnapshotId = copied.kind === "ids" ? copied.sourceSnapshotId : copied.selection.capture.sourceSnapshotId;
    const unitIds = [...workspaceSelectionIds(copied)], scopeId = copied.kind === "scope" ? copied.selection.capture.scopeId : null;
    if (!unitIds.length || new Set(unitIds).size !== unitIds.length || !this.project.metadata.targetLocales.includes(locale)) return false;
    const generation = ++this.generation, captureId = ++this.sequence;
    const current = () => this.live() && this.generation === generation && !this.paused && proof() && this.project.metadata.targetLocales.includes(locale);
    this.paused = false;
    this.update({ captureId, mode, phase: "capturing", selection: copied, locale, sourceSnapshotId, scopeId,
      excluded: copied.kind === "scope" ? [...copied.selection.excluded] : [], items: [], audit: null, failure: null, pauseReason: null, ended: false });
    try {
      const items: CandidateBatchItem[] = []; let readVersion: string | undefined;
      const bases = new Map(copied.kind === "scope" ? copied.selection.capture.units.map(unit => [unit.unitId, unit.expectedBasis]) : []);
      for (let offset = 0; offset < unitIds.length; offset += 50) {
        const members = unitIds.slice(offset, offset + 50), request = { ...this.context, locale, sourceSnapshotId,
          ...(scopeId ? { scopeId } : {}), unitIds: members, state: mode === "restore" ? "rejected" as const : "available" as const,
          ...(readVersion ? { readVersion } : {}) };
        const page = await this.options.reads.client.fetchQuery({ queryKey: this.options.reads.key(["workbench-candidate-batch", captureId, mode, members, readVersion ?? null]),
          staleTime: 0, retry: false, meta: { scopes: ["source", "translation", "review", "resources"] },
          queryFn: ({ signal }) => readCandidateSliceRows(request, this.options.read, () => current() && !signal.aborted) });
        if (!current()) throw new Error("Candidate batch preview changed");
        readVersion = page.readVersion;
        const keys = page.rows.map(row => ({ projectId: this.context.projectId, unitId: row.target.unitId, locale }));
        const opened = mode === "stage" ? await this.options.drafts.openMany(keys) : [];
        if (!current()) throw new Error("Candidate batch preview changed");
        for (const [index, row] of page.rows.entries()) {
          const key = keys[index], originalBasis = bases.get(key.unitId);
          let reason: CandidateBatchSkipReason | null = originalBasis !== undefined && originalBasis !== row.target.basis ? "basis-changed" : null;
          if (!reason && row.candidateCount === 0) reason = "no-candidate";
          if (mode === "stage") {
            if (!reason && row.candidateCount !== 1) reason = "multiple-candidates";
            if (!reason && row.protection.protected) reason = "protected";
            if (!reason && row.selectedOriginKind !== null && row.selectedOriginKind !== "ai") reason = "human-selection";
            if (!reason) reason = draftSkip(opened[index], row);
          }
          const revisions = mode === "stage" || row.revisions.length === 0 ? [row.revisions[0] ?? null] : row.revisions;
          for (const revision of revisions) items.push({ id: `${key.unitId}:${locale}:${revision?.revisionId ?? "none"}`, key, nativeKey: row.target.nativeKey,
            target: row.target, revision, row, capture: mode === "stage" && opened[index]?.value
              ? { editSeq: opened[index]!.value!.editSeq, basis: { ...opened[index]!.value!.basis } } : null,
            status: reason ? "skipped" : "ready", skipReason: reason, request: null, failure: null });
        }
      }
      if (!current()) throw new Error("Candidate batch preview changed");
      this.update({ phase: "preview", items: structuredClone(items) }); return true;
    } catch (cause) {
      if (this.live() && this.generation === generation) this.update({ phase: "paused", pauseReason: current() ? "failed" : "context-changed", failure: commandFailure(cause) });
      return false;
    }
  }
  confirm(captureId: number, proof: () => boolean): Promise<void> {
    return this.state.phase === "preview" ? this.run(captureId, proof) : Promise.resolve();
  }
  continue(captureId: number, proof: () => boolean): Promise<void> {
    return this.state.phase === "paused" && !this.unresolved() ? this.run(captureId, proof) : Promise.resolve();
  }
  private async run(captureId: number, proof: () => boolean): Promise<void> {
    if (!this.live() || captureId !== this.state.captureId || !proof() || this.unresolved() || !this.state.items.length || !this.state.locale
      || !this.project.metadata.targetLocales.includes(this.state.locale) || this.options.decisions().blocked() || this.options.drafts.getSnapshot().mutationReserved) return;
    const audit = this.state.mode === "stage" ? null : this.audit();
    if (audit && (!audit.actor.trim() || !audit.reason.trim())) return;
    const generation = this.generation;
    this.paused = false; this.update({ phase: "running", audit, failure: null, pauseReason: null });
    const current = () => this.live() && this.generation === generation && this.state.captureId === captureId && !this.paused && proof()
      && !!this.state.locale && this.project.metadata.targetLocales.includes(this.state.locale) && (!audit || sameAudit(audit, this.audit()));
    try {
      while (this.state.items.some(item => item.status === "ready")) {
        if (!current()) break;
        if (this.state.mode === "stage") {
          const items = this.state.items.filter(item => item.status === "ready").slice(0, 50);
          this.update({ items: this.state.items.map(item => items.some(member => member.id === item.id) ? { ...item, status: "running" } : item) });
          const inputs = items.map(item => { if (!item.capture) throw new Error("Missing fixed draft input"); return { row: item.row, capture: item.capture }; });
          const results = await this.options.drafts.stageCandidateBatch(inputs, current);
          if (!this.live() || this.generation !== generation) return;
          if (results.length !== items.length || results.some((result, index) => result.key.projectId !== items[index].key.projectId
            || result.key.unitId !== items[index].key.unitId || result.key.locale !== items[index].key.locale)) throw new Error("Candidate stage results have different members");
          if (!results.some(result => result.staged) && this.options.drafts.getSnapshot().mutationReserved) {
            this.update({ phase: "paused", pauseReason: "context-changed", items: this.state.items.map(item => item.status === "running" ? { ...item, status: "ready" } : item) }); return;
          }
          let undurable = false;
          for (const [index, result] of results.entries()) {
            const item = items[index];
            if (undurable || !result.staged && !current()) { this.item(item.id, { status: "ready" }); continue; }
            this.item(item.id, result.staged ? { status: result.durable ? "staged" : "undurable" }
              : { status: "skipped", skipReason: draftSkip(this.options.drafts.getEntry(item.key), item.row) ?? "unavailable" });
            if (result.staged && !result.durable) undurable = true;
          }
          if (undurable) { this.update({ phase: "paused", pauseReason: "journal" }); return; }
        } else {
          if (!audit || !this.state.sourceSnapshotId) throw new Error("Missing fixed candidate decision");
          const ready = this.state.items.filter(item => item.status === "ready"), unitIds = [...new Set(ready.map(item => item.key.unitId))].slice(0, 50);
          const members = new Set(unitIds), items = ready.filter(item => members.has(item.key.unitId));
          const fresh = await readCandidateSliceRows({ ...this.context, locale: this.state.locale!, sourceSnapshotId: this.state.sourceSnapshotId,
            unitIds, state: this.state.mode === "restore" ? "rejected" : "available" }, this.options.read, current);
          if (!current()) break;
          const rows = new Map(fresh.rows.map(row => [row.target.unitId, row]));
          for (const item of items) {
            if (!current()) break;
            const row = rows.get(item.key.unitId), revision = row?.revisions.find(value => value.revisionId === item.revision?.revisionId);
            if (!item.revision || !row || !revision || !sameTarget(item.target, row.target) || !sameRevision(item.revision, revision)) {
              this.item(item.id, { status: "skipped", skipReason: "basis-changed" }); continue;
            }
            this.item(item.id, { status: "running" });
            let basis: CandidateBasis | null = decisionBasis(row.target);
            const result = await this.options.decisions().decide(item.revision, this.state.mode === "restore" ? "restored" : "rejected", current, () => basis,
              async () => { basis = current() ? decisionBasis(row.target) : null; }, audit);
            if (!this.live() || this.generation !== generation) return;
            this.accept(item.id, result);
            if (result.kind === "pending" || result.kind === "failed") return;
            if (result.kind === "declined") {
              if (this.options.drafts.getSnapshot().mutationReserved) {
                this.item(item.id, { status: "ready" }); this.update({ phase: "paused", pauseReason: "context-changed" }); return;
              }
              this.item(item.id, current() ? { status: "skipped", skipReason: "unavailable" } : { status: "ready" });
              if (!current()) break;
            }
          }
        }
      }
      if (!this.live() || this.generation !== generation) return;
      if (!this.state.items.some(item => item.status === "ready")) this.update({ phase: "complete", pauseReason: null });
      else this.update({ phase: "paused", pauseReason: audit && !sameAudit(audit, this.audit()) ? "audit-changed" : this.paused ? "requested" : "context-changed" });
    } catch (cause) {
      if (this.live() && this.generation === generation) this.update({ phase: "paused", pauseReason: "failed", failure: commandFailure(cause),
        items: this.state.items.map(item => item.status === "running" ? { ...item, status: "ready" } : item) });
    }
  }
  private accept(id: string, outcome: CandidateDecisionOutcome) {
    if (outcome.kind === "declined") return;
    this.item(id, { request: outcome.request, status: outcome.kind, failure: outcome.kind === "recorded" ? null : outcome.failure });
    if (outcome.kind === "pending" || outcome.kind === "failed") this.update({ phase: "paused", pauseReason: outcome.kind === "pending" ? "unknown" : "failed", failure: outcome.failure });
    else this.recovered();
  }
  private recovered() {
    if (this.state.phase !== "paused") return;
    if (this.unresolved() || this.state.items.some(item => item.status === "running")) { this.update({ failure: null }); return; }
    const remaining = this.state.items.some(item => item.status === "ready");
    this.update({ failure: null, phase: remaining ? "paused" : "complete", pauseReason: remaining ? "requested" : null });
  }
  /** Progress projection only; a different original request cannot settle this batch. */
  acceptOutcome(outcome: CandidateDecisionOutcome) {
    if (!this.live() || outcome.kind === "declined" || !outcome.request) return;
    const request = outcome.request;
    const item = this.state.items.find(item => item.request === request || item.status === "running" && !item.request && !!item.revision
      && request.decision.unitId === item.key.unitId && request.decision.locale === item.key.locale && request.decision.revisionId === item.revision.revisionId
      && request.decision.sourceRevisionId === item.target.sourceRevisionId && request.decision.expectedSelectionId === item.target.selectionId
      && request.decision.expectedDecisionId === (item.revision.candidateDecision?.request.actionId ?? null)
      && request.decision.disposition === (this.state.mode === "restore" ? "restored" : "rejected")
      && request.decision.actor === this.state.audit?.actor.trim() && request.decision.reason === this.state.audit?.reason.trim());
    if (item) this.accept(item.id, outcome);
  }
  retryAllowed(itemId: string): boolean {
    const item = this.state.items.find(item => item.id === itemId), decisions = this.options.decisions();
    return this.live() && item?.status === "pending" && !!item.request && decisions.current().pending === item.request
      && !decisions.current().busy && decisions.current().checkedMissing;
  }
  async check(captureId: number, itemId: string): Promise<void> {
    const item = this.state.items.find(item => item.id === itemId);
    if (!this.live() || this.state.captureId !== captureId || this.state.phase !== "paused" || !item) return;
    if (item.status === "undurable") {
      const durable = await this.options.drafts.flush(item.key);
      if (this.live() && this.state.captureId === captureId && durable) { this.item(item.id, { status: "staged", failure: null }); this.recovered(); }
    } else if (item.status === "pending" && item.request && this.options.decisions().current().pending === item.request) {
      this.accept(item.id, await this.options.decisions().check());
    }
  }
  async retry(captureId: number, itemId: string): Promise<void> {
    if (!this.live() || this.state.captureId !== captureId || this.state.phase !== "paused" || !this.retryAllowed(itemId)) return;
    this.accept(itemId, await this.options.decisions().retry());
  }
  pause() { if (this.state.phase === "running") this.paused = true; }
  end(captureId: number): boolean {
    if (!this.live() || this.state.captureId !== captureId || this.state.phase === "running" || this.unresolved()) return false;
    this.generation++; this.paused = true;
    void this.options.reads.client.cancelQueries({ queryKey: this.options.reads.key(["workbench-candidate-batch", captureId]) });
    this.update({ phase: "complete", ended: true, pauseReason: null,
      items: this.state.items.map(item => item.status === "ready" ? { ...item, status: "skipped", skipReason: "ended" } : item) }); return true;
  }
  lifecycleParticipant(onReveal?: () => void): LifecycleParticipant {
    const blocked = () => this.state.phase !== "idle" && this.state.phase !== "complete" || this.unresolved();
    return { id: "candidate-batch", area: "translation", scope: { kind: "project", ...this.context },
      inspect: intent => ({ status: ["open-project", "close-project", "close-window"].includes(intent.kind) && blocked() ? "blocked" : "ready",
        revision: JSON.stringify([this.state.captureId, this.state.phase, this.state.revision]) }),
      prepareLeave: async (intent, proof, current) => proof() && current() && (!["open-project", "close-project", "close-window"].includes(intent.kind) || !blocked()), reveal: onReveal };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    if (this.state.captureId !== null) void this.options.reads.client.cancelQueries({ queryKey: this.options.reads.key(["workbench-candidate-batch", this.state.captureId]) });
    this.state = freeze({ ...this.state, phase: "retired", revision: this.state.revision + 1 }); this.listeners.forEach(listener => listener()); this.listeners.clear();
  }
}
