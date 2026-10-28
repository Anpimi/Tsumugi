import type { DecisionClientAction, DecisionClientActivity } from "../../generated/decisions.requests";
export type { DecisionClientAction, DecisionClientActivity } from "../../generated/decisions.requests";

/** A memoized projection of an existing owner's active submissions. */
export class DecisionActivityMemo {
  private encoded = "[]";
  private retired = false;
  private snapshot: DecisionClientActivity;

  constructor(ownerId: string) {
    const actions: DecisionClientAction[] = []; Object.freeze(actions);
    this.snapshot = Object.freeze({ ownerId, revision: "0", actions });
  }
  getSnapshot = () => this.snapshot;

  observe(actions: DecisionClientAction[], retired: boolean) {
    const ordered = actions.sort((left, right) => {
      const a = JSON.stringify(left), b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const encoded = JSON.stringify(ordered);
    if (encoded === this.encoded && retired === this.retired) return;
    this.encoded = encoded; this.retired = retired;
    for (const action of ordered) { Object.freeze(action.key); Object.freeze(action); }
    Object.freeze(ordered);
    this.snapshot = Object.freeze({ ownerId: this.snapshot.ownerId, revision: (BigInt(this.snapshot.revision) + 1n).toString(), actions: ordered });
  }
}
