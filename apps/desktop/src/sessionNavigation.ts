import type { WorkspaceArea } from "./WorkbenchFrame";
import type { EditorTarget } from "./TranslationWorkbench";
import type { ContentSelection } from "./contentSelection";
import type { ContextEditorTarget, CorrectionEditorTarget } from "./workbenchCommands";
import type { ReviewEditorHandoff, ReviewEditorReturn } from "./reviewDiagnosticNavigation";

export interface AiReviewOrigin { attemptId: string; taskId: string; itemId: string; editSeq: number }
export interface ReviewHandoffPresentation { unitId: string; locale: string; basis: string; currentBasis: string; fallbackId: string | null }
/** A read-only destination, carrying no plan, consent or execution authority. */
export interface MaintenanceNoticeTarget { sourceActionId: string; sourceEditSeq: number; aiEditSeq: number }

export type WorkspaceDestination =
  | { kind: "area"; area: WorkspaceArea }
  | { kind: "task"; taskId: string; attemptId: string }
  | { kind: "task-list" }
  | { kind: "translation"; target: EditorTarget; locale: string; suggestedText?: string; returnTo?: "ai" }
  | { kind: "review-edit"; target: EditorTarget; locale: string; handoff: ReviewEditorHandoff }
  | { kind: "review-return"; capture: ReviewEditorReturn }
  | { kind: "review-work" }
  | { kind: "review-target"; target: EditorTarget; locale: string; origin: AiReviewOrigin }
  | { kind: "ai-selection"; selection: ContentSelection; expectedEditSeq: number }
  | ({ kind: "maintenance-notice" } & MaintenanceNoticeTarget)
  | { kind: "arena-comparison"; target: EditorTarget; locale: string; revisionId: string; revisionOrdinal: string; returnTo: "translation" | "ai" }
  | { kind: "saved-build"; attemptId: string }
  | { kind: "tool-query"; text: string }
  | { kind: "resource-correction"; capture: CorrectionEditorTarget }
  | { kind: "resource-correction-return"; capture: CorrectionEditorTarget }
  | { kind: "resource-context"; capture: ContextEditorTarget }
  | { kind: "resource-context-return"; capture: ContextEditorTarget }
  | { kind: "attempt"; area: "source" | "translation" | "ai" | "arena"; attemptId: string };
export interface SessionConsumer {
  allowNavigate: (destination?: WorkspaceDestination) => Promise<boolean>;
  allowLeave: (current?: () => boolean, intentCurrent?: () => boolean) => Promise<boolean>;
}
export interface ExitDisposition { area: WorkspaceArea; status: "ready" | "dirty" | "blocked"; revision: string }
export interface SessionExitPermit { current: () => boolean; release: () => void }
export interface SessionNavigationPorts {
  live: () => boolean;
  area: () => WorkspaceArea;
  show: (area: WorkspaceArea) => void;
  consumer: (area: WorkspaceArea) => Promise<SessionConsumer | null>;
  inspect: () => ExitDisposition[];
  /** A captured handoff can defer its owner update until all asynchronous source guards settle. */
  accept: (destination: WorkspaceDestination, current: () => boolean) => Promise<boolean | (() => boolean)>;
  blocked: (area: WorkspaceArea) => void;
  busy: (value: boolean, kind?: "navigation" | "exit") => void;
  failure: (value: unknown) => void;
}
export function destinationArea(destination: WorkspaceDestination): WorkspaceArea {
  return destination.kind === "area" || destination.kind === "attempt" ? destination.area
    : destination.kind === "translation" || destination.kind === "review-edit" ? "translation" : destination.kind === "ai-selection" || destination.kind === "maintenance-notice" ? "ai" : destination.kind === "saved-build" ? "release"
      : destination.kind === "tool-query" || destination.kind === "resource-context" || destination.kind === "resource-correction" ? "resources" : destination.kind === "resource-context-return" || destination.kind === "resource-correction-return" ? "translation" : destination.kind === "arena-comparison" ? "arena" : destination.kind === "task" || destination.kind === "task-list" ? "tasks" : "review";
}

/** One in-flight UI intent. Business state and write reservations stay in the original owners. */
export class SessionNavigation {
  private intent: object | null = null;
  constructor(private readonly ports: SessionNavigationPorts) {}
  private acquire(kind: "navigation" | "exit") {
    if (this.intent || !this.ports.live()) return null;
    const intent = {}; this.intent = intent; this.ports.busy(true, kind); return intent;
  }
  private current(intent: object) { return this.intent === intent && this.ports.live(); }
  private release(intent: object) { if (this.intent === intent) { this.intent = null; this.ports.busy(false); } }
  dispose() { const intent = this.intent; if (intent) this.release(intent); }
  async navigate(destination: WorkspaceDestination): Promise<boolean> {
    if (destination.kind === "area" && destination.area === this.ports.area()) return this.ports.live();
    const intent = this.acquire("navigation"); if (!intent) return false;
    const current = () => this.current(intent);
    // Capture the user target before any asynchronous view or read work.
    const fixed: WorkspaceDestination = Object.freeze(destination.kind === "review-edit" || destination.kind === "review-return" ? freezeNavigation(structuredClone(destination))
      : destination.kind === "resource-context" || destination.kind === "resource-context-return"
      ? {...destination,capture:Object.freeze({...destination.capture,target:Object.freeze({...destination.capture.target})})}
      : destination.kind === "resource-correction" || destination.kind === "resource-correction-return"
      ? {...destination,capture:Object.freeze({...destination.capture,target:Object.freeze({...destination.capture.target})})}
      : destination.kind === "review-target" ? { ...destination, target: Object.freeze({ ...destination.target }), origin: Object.freeze({ ...destination.origin }) }
      : destination.kind === "translation" || destination.kind === "arena-comparison"
      ? { ...destination, target: Object.freeze({ ...destination.target }) } : { ...destination });
    try {
      const from = this.ports.area();
      const consumer = await this.ports.consumer(from);
      if (!current() || (consumer && !await consumer.allowNavigate(fixed)) || !current()) return false;
      const accepted = await this.ports.accept(fixed, current);
      if (!accepted || !current()) return false;
      const latest = await this.ports.consumer(from);
      if (!current() || (latest && !await latest.allowNavigate(fixed)) || !current()) return false;
      if (typeof accepted === "function" && !accepted()) return false;
      this.ports.show(destinationArea(fixed));
      return true;
    } catch (value) { if (current()) this.ports.failure(value); return false; }
    finally { this.release(intent); }
  }
  async prepareExit(): Promise<SessionExitPermit | null> {
    const intent = this.acquire("exit"); if (!intent) return null;
    const current = () => this.current(intent);
    let issued = false;
    try {
      for (;;) {
        if (!current()) return null;
        const next = this.ports.inspect().find(value => value.status !== "ready");
        if (!next) {
          const permit = { current: () => current() && this.ports.inspect().every(value => value.status === "ready"),
            release: () => this.release(intent) };
          if (permit.current()) { issued = true; return permit; }
          return null;
        }
        this.ports.blocked(next.area);
        this.ports.show(next.area);
        if (next.status === "blocked") {
          if (current()) this.ports.failure({ reason: "session-exit-blocked" });
          return null;
        }
        const presentation = await this.ports.consumer(next.area);
        if (!current() || !presentation) return null;
        const proof = () => current() && this.ports.inspect().find(value => value.area === next.area)?.revision === next.revision;
        // A dialog answer is not exit authority: inspect every owner again after it settles.
        if (!proof() || !await presentation.allowLeave(proof, current) || !current()) return null;
        // A successful answer must settle this owner. New input needs a new user intent,
        // and an unchanged dirty owner must not spin through confirmations forever.
        if (this.ports.inspect().some(value => value.area === next.area && value.status !== "ready")) {
          this.ports.failure("navigation-edited");
          return null;
        }
      }
    } catch (value) { if (current()) this.ports.failure(value); return null; }
    finally {
      // A successful permit holds the intent until the caller finishes the lifecycle command.
      if (!issued) this.release(intent);
    }
  }
}

function freezeNavigation<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freezeNavigation); Object.freeze(value); }
  return value;
}
