import { executionCommands, executionContext, type AttemptDetail } from "./executionCommands";

/** One complete observation through the session read owner, with exact page
 * identity and coverage. This observation never grants execution or adoption. */
export async function readCompleteAttempt(context: ReturnType<typeof executionContext>, attemptId: string, operation: string): Promise<AttemptDetail | null> {
  let detail: AttemptDetail | null = null;
  let offset = 0;
  const ids = new Set<string>();
  for (;;) {
    const page = await executionCommands.attempt({ ...context, attemptId, offset, limit: 100 });
    if (!page) { if (detail) throw new Error("Missing execution page"); return null; }
    if (page.attemptId !== attemptId || page.operation !== operation || (detail && (page.taskId !== detail.taskId || page.progress.total !== detail.progress.total))) throw new Error("Execution page identity changed");
    for (const item of page.items) {
      if (ids.has(item.status.itemId)) throw new Error("Duplicate execution item");
      ids.add(item.status.itemId);
    }
    detail = detail ? { ...page, items: [...detail.items, ...page.items] } : page;
    if (detail.items.length > detail.progress.total) throw new Error("Execution item coverage changed");
    if (page.nextOffset === null) {
      if (detail.items.length !== detail.progress.total) throw new Error("Incomplete execution coverage");
      return detail;
    }
    if (page.nextOffset <= offset || page.nextOffset >= page.progress.total) throw new Error("Invalid execution cursor");
    offset = page.nextOffset;
  }
}

/** An absent task page is a read-only observation, not a failed detail read or
 * permission to resend. The detail IPC requires an existing execution. */
export async function readRecordedAttempt(context: ReturnType<typeof executionContext>, taskId: string, attemptId: string, operation: string): Promise<AttemptDetail | null> {
  let after = "0";
  const seen = new Set<string>();
  for (;;) {
    const page = await executionCommands.task({ ...context, taskId, after, limit: 100 });
    let found = false;
    for (const item of page) {
      if (seen.has(item.attemptId) || BigInt(item.sequence) <= BigInt(after)) throw new Error("Execution task cursor changed");
      seen.add(item.attemptId); after = item.sequence;
      found ||= item.attemptId === attemptId;
    }
    if (found) {
      const detail = await readCompleteAttempt(context, attemptId, operation);
      if (!detail || detail.taskId !== taskId) throw new Error("Execution task identity changed");
      return detail;
    }
    if (page.length < 100) return null;
  }
}
