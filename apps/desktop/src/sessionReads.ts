import { isCommandError } from "./projectCommands";
import { QueryClient, type QueryKey, type Query } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { validateResponseChanges, validateResponseNotification } from "./generated/validators";
import type { ChangeScope, ProjectChanges, ChangeNotification } from "./generated/responses";
export type { ChangeScope, ProjectChanges, ChangeNotification } from "./generated/responses";
import { listen } from "@tauri-apps/api/event";
import type { RuntimeStatus, SessionRequest } from "./executionCommands";

export interface ReadTransport {
  listen: (receive: (payload: unknown) => void) => Promise<() => void>;
  snapshot: (request: SessionRequest & { afterSequence: string }) => Promise<unknown>;
}
const transport: ReadTransport = {
  listen: receive => listen<unknown>("project-changed", event => receive(event.payload)),
  snapshot: request => invoke<unknown>("read_project_changes", { request }),
};
function contextMatches(value: SessionRequest, context: SessionRequest) { return value.projectId === context.projectId && value.sessionToken === context.sessionToken; }
export function validateChanges(value: unknown, context: SessionRequest): ProjectChanges {
  if (!validateResponseChanges(value) || !contextMatches(value, context) || (value.runtime.error !== null && !isCommandError(value.runtime.error))) throw new Error("Invalid project change snapshot");
  return { projectId: context.projectId, sessionToken: context.sessionToken, epoch: value.epoch, sequence: value.sequence, progressSequence: value.progressSequence, scopes: value.scopes,
    runtime: { active: value.runtime.active, quiescing: value.runtime.quiescing, queryCount: Number(value.runtime.queryCount), error: value.runtime.error } };
}
function notification(value: unknown, context: SessionRequest): ChangeNotification | null {
  if (!validateResponseNotification(value) || !contextMatches(value, context)) return null;
  return { projectId: context.projectId, sessionToken: context.sessionToken, epoch: value.epoch, kind: value.kind, afterSequence: value.afterSequence, sequence: value.sequence, scopes: value.scopes };
}
function depends(query: Query, affected: readonly ChangeScope[]): boolean {
  const dependencies = query.meta?.scopes;
  return affected.includes("project") || (Array.isArray(dependencies) && dependencies.some(scope => affected.includes(scope)));
}

/** One cache and one invalidation bridge per live project session. */
export class SessionReads {
  readonly client = new QueryClient({ defaultOptions: { queries: {
    networkMode: "always", retry: false, staleTime: Infinity, gcTime: 60_000,
    refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: "always",
  } } });
  private life = 0;
  private reconciliation = 0;
  private running = false;
  private epoch: string | null = null;
  private retiredEpochs = new Set<string>();
  private sequence = "0";
  private progress = "0";
  private verified = "0";
  private verifiedProgress = "0";
  private syncFlight: Promise<void> | null = null;
  private syncAgain = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private coalesce: ReturnType<typeof setTimeout> | undefined;
  private unlisten: (() => void) | undefined;
  private uncache: (() => void) | undefined;
  private pending = new Set<string>();
  private affected = new Set<ChangeScope>();
  private failed = false;
  private statusListeners = new Set<() => void>();
  constructor(readonly context: SessionRequest, private readonly wire = transport) {}
  key(key: QueryKey): QueryKey { return [this.context.projectId, this.context.sessionToken, ...key]; }
  status = () => this.failed;
  subscribeStatus = (receive: () => void) => { this.statusListeners.add(receive); return () => { this.statusListeners.delete(receive); }; };
  private report(failed: boolean) { if (this.failed !== failed) { this.failed = failed; this.statusListeners.forEach(receive => receive()); } }

  start(): () => void {
    this.running = true;
    const life = ++this.life;
    this.uncache = this.client.getQueryCache().subscribe(event => {
      const query = event.query;
      if (event.type === "updated" && query.state.fetchStatus === "idle" && this.pending.delete(query.queryHash)) {
        query.invalidate();
        if (query.isActive()) void this.client.refetchQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
      }
    });
    void this.wire.listen(value => { if (this.running && this.life === life) this.receive(value); }).then(stop => {
      if (!this.running || this.life !== life) { stop(); return; }
      this.unlisten = stop;
      // Read after registration so changes made while listen was pending are covered.
      void this.synchronize(true);
    }).catch(() => { if (this.running && this.life === life) this.report(true); });
    const beat = async () => {
      await this.synchronize();
      if (this.running && this.life === life) this.timer = setTimeout(() => void beat(), 1500);
    };
    void beat();
    const focus = () => { void this.synchronize(true); };
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("focus", focus);
      if (this.life !== life) return;
      this.running = false; this.life++;
      clearTimeout(this.timer); clearTimeout(this.coalesce);
      this.timer = this.coalesce = undefined;
      this.unlisten?.(); this.unlisten = undefined;
      this.uncache?.(); this.uncache = undefined;
      this.pending.clear(); this.affected.clear();
      this.epoch = null; this.retiredEpochs.clear();
      void this.client.cancelQueries(); this.client.clear();
      this.sequence = this.progress = this.verified = this.verifiedProgress = "0";
    };
  }

  invalidate(affected: readonly ChangeScope[]) {
    const queries = this.client.getQueryCache().findAll({ predicate: query => depends(query, affected) });
    for (const query of queries) {
      if (query.state.fetchStatus === "fetching") this.pending.add(query.queryHash);
      query.invalidate();
    }
    void this.client.refetchQueries({ predicate: query => queries.includes(query) && query.isActive() && query.state.fetchStatus !== "fetching" }, { cancelRefetch: false });
  }
  receive(value: unknown) {
    if (!this.running) return;
    const event = notification(value, this.context);
    if (!event || this.retiredEpochs.has(event.epoch)) return;
    if (event.kind === "resync" || (this.epoch !== null && event.epoch !== this.epoch)) {
      this.reconciliation++;
      this.observeEpoch(event.epoch);
      this.sequence = this.verified = event.sequence;
      this.progress = this.verifiedProgress = "0";
      void this.synchronize(true); return;
    }
    const previous = event.kind === "progress" ? this.progress : this.sequence;
    if (BigInt(event.sequence) <= BigInt(previous)) return;
    const gap = event.afterSequence !== previous;
    if (event.kind === "progress") this.progress = event.sequence; else this.sequence = event.sequence;
    for (const scope of gap ? ["project" as const] : event.scopes) this.affected.add(scope);
    if (!this.coalesce) this.coalesce = setTimeout(() => {
      this.coalesce = undefined;
      this.invalidate([...this.affected]); this.affected.clear();
    }, 50);
    if (gap) void this.synchronize(true);
  }
  private observeEpoch(value: string) {
    if (this.epoch && this.epoch !== value) this.retiredEpochs.add(this.epoch);
    this.epoch = value;
  }
  synchronize(force = false): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.syncFlight) { this.syncAgain ||= force; return this.syncFlight; }
    const life = this.life;
    const after = this.verified;
    const reconciliation = this.reconciliation;
    this.syncFlight = (async () => {
      try {
        const next = validateChanges(await this.wire.snapshot({ ...this.context, afterSequence: after }), this.context);
        if (!this.running || this.life !== life || this.reconciliation !== reconciliation) return;
        // A hint may be newer than this already-running read. Never move the
        // observed cursor backwards; the shared heartbeat checks the newer hint.
        const epochChanged = this.epoch !== null && next.epoch !== this.epoch;
        if (!epochChanged && ((BigInt(next.sequence) < BigInt(this.sequence) && BigInt(next.sequence) >= BigInt(after)) || (BigInt(next.progressSequence) < BigInt(this.progress) && BigInt(next.progressSequence) >= BigInt(this.verifiedProgress)))) { return; }
        const reset = epochChanged || BigInt(next.sequence) < BigInt(after) || BigInt(next.progressSequence) < BigInt(this.verifiedProgress);
        const changed = next.sequence !== this.sequence;
        const progressed = next.progressSequence !== this.progress;
        this.observeEpoch(next.epoch);
        this.sequence = this.verified = next.sequence; this.progress = this.verifiedProgress = next.progressSequence;
        const oldRuntime = this.client.getQueryData<RuntimeStatus>(this.key(["runtime"]));
        this.client.setQueryData(this.key(["runtime"]), next.runtime);
        if (force || reset || this.failed) this.invalidate(["project"]);
        else {
          if (changed) this.invalidate(next.scopes);
          if (progressed || JSON.stringify(oldRuntime) !== JSON.stringify(next.runtime)) this.invalidate(["execution"]);
        }
        // Retry failed active reads only at the shared heartbeat, without replaying mutations.
        void this.client.refetchQueries({ predicate: query => query.isActive() && query.state.status === "error" }, { cancelRefetch: false });
        this.report(false);
      } catch { if (this.running && this.life === life) this.report(true); }
    })().finally(() => {
      this.syncFlight = null;
      if (this.running && this.syncAgain) { this.syncAgain = false; void this.synchronize(true); }
    });
    return this.syncFlight;
  }
}
