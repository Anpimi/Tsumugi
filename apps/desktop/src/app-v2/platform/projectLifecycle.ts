import { executionCommands, executionContext, type ApplicationShutdownRequest, type ApplicationShutdownView, type RuntimeStatus, type SessionRequest } from "../../executionCommands";
import { hasUnknownOutcome, isCommandError, projectCommands, type CloseProjectView, type OpenProjectRequest, type ProjectView, type ReadProjectRequest } from "../../projectCommands";
import { SessionNavigation, type ExitDisposition, type SessionExitPermit } from "../../sessionNavigation";
import { SessionReads } from "../../sessionReads";
import type { WorkspaceArea } from "../../WorkbenchFrame";

export interface ProjectSession {
  project: ProjectView;
  reads: SessionReads;
}

export interface LeaveIntent {
  kind: "navigate" | "close-view" | "language" | "restore" | "open-project" | "close-project" | "close-window";
  viewId?: string;
}

export interface LifecycleParticipant {
  id: string;
  area: WorkspaceArea;
  scope: { kind: "application" } | { kind: "project"; projectId: string; sessionToken: string };
  /** A durable retained draft may allow ordinary navigation while still protecting a destructive exit. */
  inspect: (intent: LeaveIntent) => Pick<ExitDisposition, "status" | "revision">;
  prepareLeave: (intent: LeaveIntent, proof: () => boolean, current: () => boolean) => Promise<boolean>;
  reveal?: () => void;
}

export type LifecycleFailureCode = "leave-blocked" | "leave-changed" | "command-failed" | "read-failed" | "runtime-active"
  | "runtime-pending" | "application-stopping" | "application-unknown" | "unknown-lifecycle" | "recovery-unavailable" | "destroy-failed";
export interface LifecycleFailure { code: LifecycleFailureCode; cause?: unknown; ownerId?: string }

export interface PendingLifecycle {
  kind: "open" | "close" | "runtime" | "application-stop" | "application-resume";
  session: ProjectSession | null;
  locator?: string;
  observation?: "original-session-open" | "original-session-unavailable";
}

export interface ProjectLifecycleState {
  session: ProjectSession | null;
  /** Keep original owners mounted for copying when Core has already replaced or closed their session. */
  retainedSession: ProjectSession | null;
  /** Native close has settled Core, but still needs the original owners until destruction is authorized. */
  closingSession: ProjectSession | null;
  phase: "idle" | "guarding" | "opening" | "reading" | "stopping" | "closing" | "cleanup" | "destroying" | "checking";
  pending: PendingLifecycle | null;
  cleanup: { request: ApplicationShutdownRequest; state: "stopping" | "stopped" | "unknown" } | null;
  failure: LifecycleFailure | null;
}

export interface ProjectLifecyclePorts {
  open: (request: OpenProjectRequest) => Promise<ProjectView>;
  read: (request: ReadProjectRequest) => Promise<ProjectView>;
  close: (request: { sessionToken: string }) => Promise<CloseProjectView>;
  status: (request: SessionRequest) => Promise<RuntimeStatus>;
  quiesce: (request: SessionRequest) => Promise<RuntimeStatus>;
  /** This controlled Host action must report actual application-instance drain. */
  stopCleanup: (request: ApplicationShutdownRequest) => Promise<ApplicationShutdownView>;
  resumeCleanup: (request: ApplicationShutdownRequest) => Promise<ApplicationShutdownView>;
  createReads: (project: ProjectView) => SessionReads;
  actionId: () => string;
  confirmStop?: (project: ProjectView, status: RuntimeStatus, current: () => boolean) => Promise<boolean>;
}

interface Ticket { session: ProjectSession | null; closed: boolean }
interface Registration { participant: LifecycleParticipant; token: symbol }
const sameProject = (left: ProjectView, right: ProjectView) => left.sessionToken === right.sessionToken && left.metadata.projectId === right.metadata.projectId;

/** Owns Core session identity. Views and drafts remain in their existing domain owners. */
export class ProjectLifecycle {
  private state: ProjectLifecycleState = { session: null, retainedSession: null, closingSession: null, phase: "idle", pending: null, cleanup: null, failure: null };
  private readonly listeners = new Set<() => void>();
  private readonly participants = new Map<string, Registration>();
  private intent: Ticket | null = null;
  private disposed = false;
  private readonly ports: ProjectLifecyclePorts;

  constructor(ports: Partial<ProjectLifecyclePorts> = {}) {
    this.ports = {
      open: projectCommands.open, read: projectCommands.read, close: projectCommands.close,
      status: executionCommands.status, quiesce: executionCommands.quiesce,
      stopCleanup: executionCommands.stopApplicationInstances, resumeCleanup: executionCommands.resumeApplicationInstances,
      createReads: project => new SessionReads(executionContext(project)), actionId: () => crypto.randomUUID(), ...ports,
    };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ProjectLifecycleState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.listeners.forEach(listener => listener());
  }
  register(participant: LifecycleParticipant) {
    if (this.disposed) return () => {};
    const token = Symbol(participant.id);
    this.participants.set(participant.id, { participant, token });
    return () => { if (this.participants.get(participant.id)?.token === token) this.participants.delete(participant.id); };
  }
  private registrations(session: ProjectSession | null) {
    return [...this.participants.values()].filter(({ participant: { scope } }) => scope.kind === "application"
      || !!session && scope.projectId === session.project.metadata.projectId && scope.sessionToken === session.project.sessionToken);
  }
  private begin(phase: ProjectLifecycleState["phase"], recovery = false) {
    if (this.disposed || this.intent || !recovery && (this.state.pending || this.state.retainedSession)) return null;
    const ticket: Ticket = { session: this.state.session, closed: false };
    this.intent = ticket; this.update({ phase, failure: null }); return ticket;
  }
  private owns(ticket: Ticket) { return this.intent === ticket; }
  private live(ticket: Ticket) { return !this.disposed && this.owns(ticket) && (this.state.session === ticket.session || ticket.closed && this.state.session === null); }
  private finish(ticket: Ticket) { if (this.owns(ticket)) { this.intent = null; this.update({ phase: "idle" }); } }

  private async guard(ticket: Ticket, intent: LeaveIntent, current: () => boolean): Promise<SessionExitPermit | null> {
    const registrations = () => this.registrations(ticket.session);
    const captured = registrations();
    const expected = new Map(captured.map(entry => [entry.token, { ...entry.participant.inspect(intent) }]));
    let valid = true;
    const changed = (settling?: symbol): Registration | undefined => {
      const latest = registrations();
      const added = latest.find(entry => !expected.has(entry.token));
      if (added) return added;
      return captured.find(entry => {
        if (!latest.some(value => value.token === entry.token)) return true;
        if (entry.token === settling) return false;
        const value = entry.participant.inspect(intent), before = expected.get(entry.token);
        return !before || value.status !== before.status || value.revision !== before.revision;
      });
    };
    const invalidate = (entry: Registration) => {
      if (valid) {
        valid = false; entry.participant.reveal?.();
        this.update({ failure: { code: "leave-changed", ownerId: entry.participant.id } });
      }
      return false;
    };
    const unchanged = () => valid && !changed();
    const recheck = (settling?: symbol) => {
      if (!valid) return false;
      const entry = changed(settling); return entry ? invalidate(entry) : true;
    };
    const inspect = (): ExitDisposition[] => {
      if (!recheck()) return [];
      const groups = new Map<WorkspaceArea, Registration[]>();
      for (const registration of registrations()) {
        const area = registration.participant.area;
        groups.set(area, [...groups.get(area) ?? [], registration]);
      }
      return [...groups].map<ExitDisposition>(([area, entries]) => {
        const values = entries.map(({ participant }) => ({ id: participant.id, ...participant.inspect(intent) }));
        return { area, status: values.some(value => value.status === "blocked") ? "blocked" : values.some(value => value.status === "dirty") ? "dirty" : "ready",
          revision: JSON.stringify(values) };
      });
    };
    const original = () => valid && this.live(ticket) && current();
    const unresolved = (area: WorkspaceArea) => {
      const entries = registrations().filter(({ participant }) => participant.area === area);
      return (entries.find(({ participant }) => participant.inspect(intent).status === "blocked")
        ?? entries.find(({ participant }) => participant.inspect(intent).status === "dirty"))?.participant;
    };
    const navigation = new SessionNavigation({
      live: original, area: () => "overview", show: area => unresolved(area)?.reveal?.(),
      inspect, blocked: area => { const owner = unresolved(area); if (owner?.inspect(intent).status === "blocked") this.update({ failure: { code: "leave-blocked", ownerId: owner.id } }); },
      consumer: async area => {
        const queue = captured.filter(entry => entry.participant.area === area && expected.get(entry.token)?.status === "dirty");
        return queue.length ? { allowNavigate: async () => false, allowLeave: async (proof?: () => boolean) => {
          if (!original() || !proof?.() || !recheck()) return false;
          // One legacy area can present several domain owners. Only advance through
          // this captured queue, accepting each owner's own preparation changes.
          for (const entry of queue) {
            if (!original() || !recheck()) return false;
            if (!await entry.participant.prepareLeave(intent, () => original() && unchanged(), original) || !original()) return false;
            if (!recheck(entry.token)) return false;
            const settled = entry.participant.inspect(intent);
            if (settled.status !== "ready") return invalidate(entry);
            expected.set(entry.token, { ...settled });
          }
          return true;
        } } : null;
      },
      accept: async () => false, busy() {},
      failure: cause => this.update({ failure: this.state.failure ?? { code: "leave-changed", cause } }),
    });
    const permit = await navigation.prepareExit();
    if (!permit) return null;
    // The final expected snapshot includes only preparations made by this intent.
    // Later input or registrations cannot be recaptured into its issued permit.
    return { current: () => unchanged() && permit.current(), release: permit.release };
  }

  async prepareLeave(intent: LeaveIntent, current: () => boolean = () => true): Promise<SessionExitPermit | null> {
    const ticket = this.begin("guarding"); if (!ticket) return null;
    try {
      const permit = await this.guard(ticket, intent, current);
      if (!permit) { this.finish(ticket); return null; }
      return { current: permit.current, release: () => { permit.release(); this.finish(ticket); } };
    } catch (cause) { this.update({ failure: { code: "leave-blocked", cause } }); this.finish(ticket); return null; }
  }

  async transition(intent: LeaveIntent, current: () => boolean, commit: () => void) {
    const permit = await this.prepareLeave(intent, current);
    try { if (!permit?.current() || !current()) return false; commit(); return true; }
    finally { permit?.release(); }
  }

  private retain(session: ProjectSession | null) {
    if (!session) return;
    session.reads.retire(); this.update({ retainedSession: session, closingSession: null });
  }

  async open(locator: string) {
    if (!locator.trim()) { this.update({ failure: { code: "command-failed", cause: { field: "locator" } } }); return false; }
    const ticket = this.begin("guarding"); if (!ticket) return false;
    let permit: SessionExitPermit | null = null;
    let dispatched = false;
    try {
      permit = await this.guard(ticket, { kind: "open-project" }, () => true);
      if (!permit?.current()) return false;
      this.update({ phase: "opening" });
      dispatched = true;
      const project = await this.ports.open({ locator });
      // The promise belongs to this exact request. A revoked leave permit cannot discard its Core ACK.
      if (!this.owns(ticket)) return false;
      const canLeave = permit.current(), previous = ticket.session;
      if (previous && sameProject(project, previous.project)) {
        this.update({ session: { ...previous, project } });
      } else {
        previous?.reads.retire();
        if (!canLeave) this.retain(previous);
        const reads = this.ports.createReads(project);
        if (this.disposed) reads.retire();
        this.update({ session: { project, reads } });
      }
      if (!canLeave) this.update({ failure: { code: "leave-changed" } });
      return canLeave;
    } catch (cause) {
      if (this.owns(ticket)) this.update(dispatched && hasUnknownOutcome(cause)
        ? { pending: { kind: "open", session: ticket.session, locator }, failure: { code: "unknown-lifecycle", cause } }
        : { failure: { code: "command-failed", cause } });
      return false;
    } finally { permit?.release(); this.finish(ticket); }
  }

  async refresh() {
    const ticket = this.begin("reading"); if (!ticket?.session) { if (ticket) this.finish(ticket); return false; }
    try {
      const project = await this.ports.read({ sessionToken: ticket.session.project.sessionToken });
      if (!this.live(ticket) || !sameProject(project, ticket.session.project)) return false;
      this.update({ session: { ...ticket.session, project } }); return true;
    } catch (cause) { if (this.owns(ticket)) this.update({ failure: { code: "read-failed", cause } }); return false; }
    finally { this.finish(ticket); }
  }

  private async stopRuntime(ticket: Ticket, current: () => boolean) {
    const session = ticket.session; if (!session) return true;
    const context = executionContext(session.project), status = await this.ports.status(context);
    if (!current()) return false;
    if (!status.active && !status.quiescing) return true;
    if (!this.ports.confirmStop || !await this.ports.confirmStop(session.project, status, current) || !current()) {
      this.update({ failure: { code: "runtime-active" } }); return false;
    }
    this.update({ phase: "stopping" });
    try {
      const stopped = await this.ports.quiesce(context);
      if (!current()) return false;
      if (stopped.active || stopped.quiescing) { this.update({ failure: { code: "runtime-pending" } }); return false; }
      return true;
    } catch (cause) {
      this.update({ pending: { kind: "runtime", session }, failure: { code: "runtime-pending", cause } }); return false;
    }
  }

  close() { return this.closeWith(null); }
  closeWindow(destroy: () => Promise<void>) { return this.closeWith(destroy); }

  private async closeWith(destroy: (() => Promise<void>) | null) {
    const ticket = this.begin("guarding"); if (!ticket) return false;
    let permit: SessionExitPermit | null = null;
    try {
      permit = await this.guard(ticket, { kind: destroy ? "close-window" : "close-project" }, () => true);
      if (!permit?.current()) return false;
      const current = () => this.live(ticket) && permit?.current() === true;
      if (!await this.stopRuntime(ticket, current) || !current()) return false;
      if (ticket.session) {
        this.update({ phase: "closing" });
        let result: CloseProjectView;
        try { result = await this.ports.close({ sessionToken: ticket.session.project.sessionToken }); }
        catch (cause) {
          // A lost close ACK, invalid session, or storage close failure cannot prove which session Core now owns.
          const rejectedBusy = isCommandError(cause) && cause.outcome === "rejected" && cause.code === "busy";
          this.update(rejectedBusy ? { failure: { code: "command-failed", cause } }
            : { pending: { kind: "close", session: ticket.session }, failure: { code: "unknown-lifecycle", cause } });
          return false;
        }
        if (!result.closed) { this.update({ pending: { kind: "close", session: ticket.session }, failure: { code: "unknown-lifecycle" } }); return false; }
        if (!this.owns(ticket)) return false;
        const allowed = current(); ticket.closed = true; ticket.session.reads.retire();
        this.update({ session: null, closingSession: destroy ? ticket.session : null });
        if (!allowed) { this.retain(ticket.session); this.update({ failure: { code: "leave-changed" } }); return false; }
      }
      if (!destroy) return true;
      if (!current()) { this.retain(ticket.session); return false; }
      if (!await this.cleanupApplication(ticket) || !current()) {
        if (!current()) this.retain(ticket.session);
        return false;
      }
      this.update({ phase: "destroying" });
      try { await destroy(); return true; }
      catch (cause) { this.update({ failure: { code: "destroy-failed", cause } }); return false; }
    } catch (cause) { if (this.owns(ticket)) this.update({ failure: { code: "command-failed", cause } }); return false; }
    finally { permit?.release(); this.update({ closingSession: null }); this.finish(ticket); }
  }

  private async cleanupApplication(ticket: Ticket) {
    const previous = this.state.cleanup;
    if (previous?.state === "stopped") return true;
    if (previous?.state === "unknown") return false;
    const request = previous?.request ?? Object.freeze({ actionId: this.ports.actionId() });
    this.update({ phase: "cleanup", cleanup: { request, state: "stopping" } });
    try {
      const result = await this.ports.stopCleanup(request);
      if (!this.owns(ticket)) return false;
      if (result.actionId !== request.actionId || result.state === "resumed") throw new Error("Invalid original application shutdown acknowledgement");
      this.update({ cleanup: { request, state: result.state }, failure: result.state === "stopped" ? null : { code: "application-stopping" } });
      return result.state === "stopped";
    } catch (cause) {
      this.update({ cleanup: { request, state: "unknown" }, pending: { kind: "application-stop", session: null }, failure: { code: "application-unknown", cause } });
      return false;
    }
  }

  /** Explicitly restore admission after a known drained shutdown; this restores no execution grants. */
  async resumeApplication() {
    const cleanup = this.state.cleanup;
    if (cleanup?.state !== "stopped") return false;
    const ticket = this.begin("cleanup"); if (!ticket) return false;
    try {
      const result = await this.ports.resumeCleanup(cleanup.request);
      if (!this.live(ticket) || result.actionId !== cleanup.request.actionId || result.state !== "resumed") throw new Error("Invalid application admission acknowledgement");
      this.update({ cleanup: null }); return true;
    } catch (cause) {
      this.update({ pending: { kind: "application-resume", session: null }, failure: { code: "application-unknown", cause } }); return false;
    } finally { this.finish(ticket); }
  }

  /** Observes only. Open/close lack an original-action lookup, so a read cannot invent a missing ACK. */
  async checkPending() {
    const pending = this.state.pending; if (!pending) return false;
    const ticket = this.begin("checking", true); if (!ticket) return false;
    try {
      if (pending.kind === "runtime" && pending.session) {
        const status = await this.ports.status(executionContext(pending.session.project));
        if (!this.live(ticket) || this.state.pending !== pending) return false;
        if (!status.active && !status.quiescing) { this.update({ pending: null, failure: null }); return true; }
        this.update({ failure: { code: "runtime-pending" } }); return false;
      }
      if (!pending.session || pending.kind !== "open" && pending.kind !== "close") {
        this.update({ failure: { code: "recovery-unavailable" } }); return false;
      }
      const project = await this.ports.read({ sessionToken: pending.session.project.sessionToken });
      if (!this.live(ticket) || this.state.pending !== pending) return false;
      if (sameProject(project, pending.session.project)) this.update({ pending: { ...pending, observation: "original-session-open" }, failure: { code: "recovery-unavailable" } });
      return false;
    } catch (cause) {
      if (this.live(ticket) && this.state.pending === pending) this.update({ pending: isCommandError(cause) && cause.code === "session-invalid"
        ? { ...pending, observation: "original-session-unavailable" } : pending, failure: { code: "recovery-unavailable", cause } });
      return false;
    } finally { this.finish(ticket); }
  }

  /** The UI must obtain an explicit discard decision; retirement never discards the original owners. */
  discardRetained() {
    if (this.intent || !this.state.retainedSession) return false;
    this.update({ retainedSession: null, failure: null }); return true;
  }

  dispose() {
    this.disposed = true; this.listeners.clear();
    this.state.session?.reads.retire(); this.state.retainedSession?.reads.retire(); this.state.closingSession?.reads.retire();
  }
}
