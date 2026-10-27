import { arenaCommands, confirmArenaComparison, confirmArenaComparisonAction, type CompareRequest, type ComparisonSummary, type ComparisonView } from "../../../arenaCommands";
import { comparisonBasis, confirmComparisonRead } from "../../../arenaComparison";
import { commandFailure, type CommandFailure } from "../../../CommandFailure";
import { executionCommands, executionContext, type SessionRequest } from "../../../executionCommands";
import { validateResponseIdentity } from "../../../generated/execution.validators";
import { validateResponseComparisons, validateResponseRevealTarget } from "../../../generated/arena.validators";
import type { RevealRequest } from "../../../generated/arena.requests";
import { hasUnknownOutcome, type ProjectView } from "../../../projectCommands";
import type { SessionReads } from "../../../sessionReads";
import type { TranslationRevision } from "../../../translationCommands";
import type { LifecycleParticipant } from "../../platform/projectLifecycle";
import type { RevisionStageCapture, RevisionStageResult, TranslationDrafts } from "../editor/translationDrafts";

export const comparisonListKey = ["workbench-comparisons"] as const;
export const comparisonReadKey = (comparisonId: string) => ["workbench-comparison", comparisonId] as const;
export type ComparisonPending = { kind: "compare"; request: CompareRequest } | { kind: "reveal"; request: RevealRequest };
export interface ComparisonSnapshot {
  revision: number;
  /** Last confirmed creation. Each workspace view retains its own selected comparison. */
  comparisonId: string | null;
  busy: boolean;
  checking: boolean;
  pending: ComparisonPending | null;
  retryAllowed: boolean;
  targetMissing: boolean;
  failure: CommandFailure | null;
  notice: "created" | "creation-confirmed" | "identities-visible" | null;
  retired: boolean;
}
export interface ComparisonPorts {
  identity: typeof executionCommands.identity;
  compare: typeof arenaCommands.compare;
  comparisonAction: typeof arenaCommands.comparisonAction;
  comparison: typeof arenaCommands.comparison;
  comparisons: typeof arenaCommands.comparisons;
  reveal: typeof arenaCommands.reveal;
  revealTarget: typeof arenaCommands.revealTarget;
}
export interface ComparisonOptions {
  project: ProjectView;
  reads: SessionReads;
  drafts: TranslationDrafts;
  ports?: Partial<ComparisonPorts>;
}
export type ComparisonInput = Pick<CompareRequest, "unitId" | "locale" | "revisionIds" | "blind">;
const declined = (): RevisionStageResult => ({ staged: false, durable: false });

/** Existing saved results only. ProjectStore owns comparison order, identity visibility and action recovery. */
export class ComparisonSession {
  private project: ProjectView;
  private readonly context: SessionRequest;
  private readonly ports: ComparisonPorts;
  private readonly listeners = new Set<() => void>();
  private reservation: symbol | null = null;
  private disposed = false;
  private generation = 0;
  private readonly stopChanges: () => void;
  private state: ComparisonSnapshot = { revision: 0, comparisonId: null, busy: false, checking: false, pending: null,
    retryAllowed: false, targetMissing: false, failure: null, notice: null, retired: false };

  constructor(private readonly options: ComparisonOptions) {
    this.project = options.project; this.context = Object.freeze(executionContext(options.project));
    if (options.reads.context.projectId !== this.context.projectId || options.reads.context.sessionToken !== this.context.sessionToken) throw new Error("Comparison reads belong to another session");
    this.ports = { identity: executionCommands.identity, ...arenaCommands, ...options.ports };
    this.stopChanges = options.reads.subscribeChanges(scopes => {
      if (scopes.some(scope => scope === "source" || scope === "project" || scope === "translation" || scope === "resources")) this.generation++;
    });
  }
  getSnapshot = () => this.state;
  current = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private live() { return !this.disposed && !this.options.reads.retired && !this.options.drafts.getSnapshot().retired; }
  private update(patch: Partial<ComparisonSnapshot>) {
    if (!this.live()) return;
    this.state = Object.freeze({ ...this.state, ...patch, revision: this.state.revision + 1 });
    this.listeners.forEach(listener => listener());
  }
  updateProject(project: ProjectView) {
    if (project.metadata.projectId !== this.context.projectId || project.sessionToken !== this.context.sessionToken) throw new Error("Comparison project session changed");
    if (project.metadata.sourceLocale !== this.project.metadata.sourceLocale) this.generation++;
    this.project = project;
  }
  private release() {
    const token = this.reservation; this.reservation = null;
    if (token) this.options.drafts.releaseMutation(token);
  }
  private begin() {
    if (!this.live() || this.state.busy || this.state.pending) return null;
    const token = this.options.drafts.reserveMutation("retained-for-navigation");
    if (token) { this.reservation = token; this.update({ busy: true, failure: null, notice: null }); }
    return token;
  }
  private matches(entry: ComparisonPending) { return this.live() && this.state.pending === entry; }
  private settle(entry: ComparisonPending, notice: ComparisonSnapshot["notice"]) {
    if (!this.matches(entry)) return;
    this.update({ pending: null, checking: false, retryAllowed: false, targetMissing: false, failure: null, notice,
      ...(entry.kind === "compare" ? { comparisonId: entry.request.actionId } : {}) });
    this.release(); this.options.reads.invalidate(["arena"], false);
  }

  async list(): Promise<ComparisonSummary[]> {
    if (!this.live()) throw new Error("Comparison session has ended");
    const summaries = await this.ports.comparisons(this.context);
    if (!this.live()) throw new Error("Comparison session has ended");
    if (!validateResponseComparisons(summaries) || summaries.length > 100 || new Set(summaries.map(row => row.comparisonId)).size !== summaries.length) throw new Error("Invalid Arena comparison list");
    return summaries;
  }
  async read(comparisonId: string): Promise<ComparisonView> {
    if (!this.live() || !validateResponseIdentity(comparisonId)) throw new Error("Comparison session is unavailable");
    const view = await this.ports.comparison({ ...this.context, comparisonId });
    if (!this.live()) throw new Error("Comparison session has ended");
    confirmComparisonRead(view, comparisonId);
    const previous = this.options.reads.client.getQueryData<ComparisonView>(this.options.reads.key(comparisonReadKey(comparisonId)));
    // Source/selection projections may change; persisted A/B identities cannot.
    if (previous && (previous.unitId !== view.unitId || previous.locale !== view.locale || previous.blind !== view.blind
      || previous.rows.length !== view.rows.length || previous.rows.some((row, index) => row.revisionId !== view.rows[index].revisionId)
      || previous.revealed && !view.revealed)) throw new Error("Arena comparison display positions changed");
    return view;
  }
  async create(input: ComparisonInput, proof: () => boolean): Promise<void> {
    if (!proof() || !this.project.metadata.targetLocales.includes(input.locale) || !validateResponseIdentity(input.unitId)
      || input.revisionIds.length < 2 || input.revisionIds.length > 4 || new Set(input.revisionIds).size !== input.revisionIds.length
      || !input.revisionIds.every(validateResponseIdentity)) return;
    const captured = { ...input, revisionIds: [...input.revisionIds] }, generation = this.generation;
    Object.freeze(captured.revisionIds); Object.freeze(captured);
    const token = this.begin(); if (!token) return;
    try {
      const actionId = await this.ports.identity(this.context);
      if (!this.live() || !this.options.drafts.ownsMutation(token) || !proof() || generation !== this.generation
        || !this.project.metadata.targetLocales.includes(captured.locale)) return;
      const request = Object.freeze({ ...this.context, ...captured, actionId });
      await this.dispatch(Object.freeze({ kind: "compare", request }));
    } catch (error) { this.update({ failure: commandFailure(error) }); }
    finally { if (!this.state.pending) this.release(); this.update({ busy: false }); }
  }
  async reveal(view: ComparisonView, proof: () => boolean): Promise<void> {
    if (!view.comparisonId || !view.blind || view.revealed || !proof()) return;
    confirmComparisonRead(view, view.comparisonId);
    const id = view.comparisonId, basis = comparisonBasis(view), generation = this.generation;
    const token = this.begin(); if (!token) return;
    try {
      const fresh = await this.read(id);
      if (!this.live() || !proof() || comparisonBasis(fresh) !== basis || !fresh.blind || fresh.revealed) return;
      const actionId = await this.ports.identity(this.context);
      if (!this.live() || !this.options.drafts.ownsMutation(token) || !proof() || generation !== this.generation) return;
      await this.dispatch(Object.freeze({ kind: "reveal", request: Object.freeze({ ...this.context, comparisonId: id, actionId }) }));
    } catch (error) { this.update({ failure: commandFailure(error) }); }
    finally { if (!this.state.pending) this.release(); this.update({ busy: false }); }
  }
  private async dispatch(entry: ComparisonPending, replay = false) {
    if (!this.live()) return;
    this.update({ pending: entry, checking: false, retryAllowed: false, targetMissing: false });
    try {
      if (entry.kind === "compare") {
        const view = await this.ports.compare(entry.request);
        if (!this.matches(entry)) return;
        confirmArenaComparison(entry.request, view); confirmComparisonRead(view, entry.request.actionId);
        if (!entry.request.blind && view.rows.some((row, index) => row.revisionId !== entry.request.revisionIds[index])) throw new Error("Arena comparison display positions changed");
        this.options.reads.client.setQueryData(this.options.reads.key(comparisonReadKey(entry.request.actionId)), view);
        this.settle(entry, "created");
      } else { await this.ports.reveal(entry.request); this.settle(entry, "identities-visible"); }
    } catch (error) {
      if (!this.matches(entry)) return;
      this.update({ failure: commandFailure(error) });
      if (!hasUnknownOutcome(error)) {
        if (!replay) { this.update({ pending: null }); this.release(); }
        return;
      }
      await this.lookup(entry);
    }
  }
  private async lookup(entry: ComparisonPending) {
    if (!this.matches(entry)) return;
    this.update({ checking: true, retryAllowed: false, targetMissing: false });
    try {
      if (entry.kind === "compare") {
        const receipt = await this.ports.comparisonAction(entry.request);
        if (!this.matches(entry)) return;
        if (confirmArenaComparisonAction(entry.request, receipt) !== null) { this.settle(entry, "creation-confirmed"); return; }
        this.update({ retryAllowed: true });
      } else {
        const target = await this.ports.revealTarget({ ...this.context, comparisonId: entry.request.comparisonId });
        if (!this.matches(entry)) return;
        if (!validateResponseRevealTarget(target) || target !== null && (target.projectId !== this.context.projectId
          || target.targetId !== entry.request.comparisonId || target.targetKind !== "comparison")) throw new Error("Invalid Arena reveal target");
        // A visible target fulfils the explicit goal, including another action's reveal.
        if (target?.visible) { this.settle(entry, "identities-visible"); return; }
        this.update({ retryAllowed: target !== null, targetMissing: target === null });
      }
    } catch (error) { if (this.matches(entry)) this.update({ failure: commandFailure(error), retryAllowed: false }); }
    finally { if (this.matches(entry)) this.update({ checking: false }); }
  }
  async check(): Promise<void> {
    const pending = this.state.pending; if (!this.live() || !pending || this.state.busy) return;
    this.update({ busy: true, failure: null });
    try { await this.lookup(pending); } finally { this.update({ busy: false }); }
  }
  async retry(): Promise<void> {
    const pending = this.state.pending; if (!this.live() || !pending || this.state.busy || !this.state.retryAllowed) return;
    this.update({ busy: true, failure: null });
    try { await this.dispatch(pending, true); } finally { this.update({ busy: false }); }
  }
  async stage(view: ComparisonView, revision: TranslationRevision, expected: RevisionStageCapture, proof: () => boolean): Promise<RevisionStageResult> {
    if (!this.live() || this.state.busy || this.state.pending || !view.comparisonId || !proof()) return declined();
    confirmComparisonRead(view, view.comparisonId);
    const row = view.rows.find(candidate => candidate.revisionId === revision.revisionId), captured = comparisonBasis(view), generation = this.generation;
    if (!row || row.text !== revision.text || row.sourceRevisionId !== revision.sourceRevisionId || row.sourceRevisionId !== view.sourceRevisionId
      || row.candidateDisposition === "rejected" || revision.unitId !== view.unitId || revision.locale !== view.locale) return declined();
    try {
      const fresh = await this.read(view.comparisonId);
      const current = () => this.live() && !this.state.pending && proof() && this.generation === generation;
      if (!current() || comparisonBasis(fresh) !== captured) return declined();
      return this.options.drafts.stageRevision({ projectId: this.context.projectId, unitId: view.unitId, locale: view.locale }, revision, expected, current);
    } catch (error) { this.update({ failure: commandFailure(error) }); return declined(); }
  }
  lifecycleParticipant(onReveal?: () => void): LifecycleParticipant {
    return { id: "saved-comparisons", area: "translation", scope: { kind: "project", ...this.context },
      inspect: intent => intent.kind === "open-project" || intent.kind === "close-project" || intent.kind === "close-window"
        ? { status: this.state.busy || this.state.pending ? "blocked" : "ready", revision: JSON.stringify(this.state) }
        : { status: "ready", revision: "retained-project-session" },
      prepareLeave: async (_intent, proof, current) => proof() && current() && !this.state.busy && !this.state.pending,
      reveal: onReveal };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.stopChanges(); this.release();
    this.state = Object.freeze({ ...this.state, retired: true, revision: this.state.revision + 1 });
    this.listeners.forEach(listener => listener()); this.listeners.clear();
  }
}
