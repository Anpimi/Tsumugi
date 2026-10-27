/** Shared ownership and ordering, without domain actions or a second action ledger. */
export class DraftKernel {
  private reservation: symbol | null = null;
  private readonly queues = new Map<string, Promise<unknown>>();
  private retired = false;

  get live() { return !this.retired; }
  get reserved() { return this.reservation !== null; }

  reserve(): symbol | null {
    if (!this.live || this.reservation) return null;
    const token = Symbol("draft mutation"); this.reservation = token; return token;
  }
  owns(token: symbol) { return this.live && this.reservation === token; }
  release(token: symbol) { if (this.reservation === token) this.reservation = null; }

  /** A failed write does not poison the queue. Retrying is always caller-owned. */
  enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => {
      if (!this.live) throw new Error("Draft owner has retired");
      return operation();
    });
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return result;
  }

  retire() { this.retired = true; this.reservation = null; }
}

export function nextEditSeq(sequence: string): string { return (BigInt(sequence) + 1n).toString(); }
