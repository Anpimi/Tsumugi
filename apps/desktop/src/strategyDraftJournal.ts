import { DraftKernel } from "./app-v2/workspace/draftKernel";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { jsonIdentity } from "./pluginToolChoices";
import { strategyDraftCommands, type StrategyDraftHead, type StrategyDraftValue,
  type StrategyDraftPending, type StrategyDraftWriteRequest, type StrategyDraftResolveRequest } from "./strategyDraftCommands";
import type { SessionRequest } from "./executionCommands";

type Input = Omit<StrategyDraftValue, "journalSeq">;
type Disposition = StrategyDraftResolveRequest["resolve"]["disposition"];
type Frame = { kind: "write"; request: StrategyDraftWriteRequest } | { kind: "resolve"; request: StrategyDraftResolveRequest; committed: () => void };
export interface StrategyJournalState { hydrating: boolean; journalBusy: boolean; journalDirty: boolean; journalFailure: CommandFailure | null }
const same = (left: unknown, right: unknown) => jsonIdentity(left) === jsonIdentity(right);
const input = ({ journalSeq: _sequence, ...value }: StrategyDraftValue): Input => value;

/** Serial CAS metadata for the existing Strategy owner, not another draft owner. */
export class StrategyDraftJournal {
  private readonly kernel = new DraftKernel();
  private head: StrategyDraftHead | null = null;
  private latest: StrategyDraftValue;
  private frame: Frame | null = null;
  private failure: CommandFailure | null = null;
  private busy = false;
  private ready = false;
  private loading: Promise<StrategyDraftValue | null | undefined> | null = null;
  constructor(private readonly context: SessionRequest, private readonly writerId: string, initial: Input,
    private readonly changed: (state: StrategyJournalState) => void,
    private readonly ports = strategyDraftCommands) {
    this.latest = { ...structuredClone(initial), journalSeq: "0" };
  }
  get live() { return this.kernel.live; }
  get initialized() { return this.ready; }
  get sequence() { return this.latest.journalSeq; }
  nextSequence() { return (BigInt(this.latest.journalSeq) + 1n).toString(); }
  private dirty() { return this.ready && !same(this.head?.value ?? null, this.latest) && this.latest.journalSeq !== "0"; }
  private publish() { if (this.live) this.changed({ hydrating: !this.ready, journalBusy: this.busy, journalDirty: this.dirty(), journalFailure: this.failure }); }
  load(): Promise<StrategyDraftValue | null | undefined> {
    if (!this.loading) this.loading = this.loadHead().finally(() => { this.loading = null; });
    return this.loading;
  }
  private async loadHead(): Promise<StrategyDraftValue | null | undefined> {
    try {
      this.busy = true; this.publish();
      const head = await this.ports.read({ sessionToken: this.context.sessionToken, key: { projectId: this.context.projectId } });
      if (!this.live) return undefined;
      this.head = head; this.ready = true; this.failure = null;
      if (head.value) this.latest = structuredClone(head.value);
      return structuredClone(head.value);
    } catch (error) { this.failure = commandFailure(error); return undefined; }
    finally { this.busy = false; this.publish(); }
  }
  update(value: Input) {
    if (!this.live || !this.ready || same(input(this.latest), value)) return;
    this.latest = { ...structuredClone(value), journalSeq: this.nextSequence() };
    this.publish(); if (!this.failure) void this.flush();
  }
  flush(): Promise<boolean> {
    return this.kernel.enqueue("strategy", async () => {
      if (!this.ready) return true;
      if (this.failure) return false;
      return this.drain();
    }).catch(() => false);
  }
  private async execute() {
    const frame = this.frame;
    if (!frame) return true;
    this.busy = true; this.publish();
    try {
      const head = frame.kind === "write" ? await this.ports.write(frame.request) : await this.ports.resolve(frame.request);
      if (!this.live) return false;
      this.head = head; this.frame = null; this.failure = null;
      if (frame.kind === "resolve") frame.committed();
      return true;
    } catch (error) { this.failure = commandFailure(error); return false; }
    finally { this.busy = false; this.publish(); }
  }
  private async drain() {
    while (this.live) {
      if (this.frame) { if (!await this.execute()) return false; continue; }
      if (!this.dirty()) return true;
      this.frame = { kind: "write", request: { sessionToken: this.context.sessionToken, write: { key: { projectId: this.context.projectId },
        expectedRevision: this.head?.revision ?? "0", writerId: this.writerId, value: structuredClone(this.latest) } } };
    }
    return false;
  }
  resolve(pending: StrategyDraftPending, desired: () => Input, committed: () => void, disposition: Disposition): Promise<boolean> {
    return this.kernel.enqueue("strategy", async () => {
      if (!this.ready || this.failure || !await this.drain()) return false;
      const value = { ...structuredClone(desired()), journalSeq: this.nextSequence() };
      this.frame = { kind: "resolve", request: { sessionToken: this.context.sessionToken, resolve: { write: { key: { projectId: this.context.projectId },
        expectedRevision: this.head?.revision ?? "0", writerId: this.writerId, value }, pending: structuredClone(pending), disposition } }, committed };
      // No ordinary frame may remove pending. Only its confirmed resolve does.
      if (!await this.execute()) return false;
      return this.drain();
    }).catch(() => false);
  }
  retry(): Promise<boolean> {
    return this.kernel.enqueue("strategy", async () => {
      if (!this.ready) return false;
      this.failure = null; return this.drain();
    }).catch(() => false);
  }
  blocked() { return this.ready && (this.busy || !!this.failure); }
  retire() { this.kernel.retire(); }
}
