import { translationCommands, type TranslationCandidateSliceRow } from "../../../translationCommands";

type Request = Omit<Parameters<typeof translationCommands.candidateSlice>[0], "afterOrdinal">;

/** Collect complete versions for a fixed, bounded set of members. A partial
 * unit is a continuation, never evidence that it has a unique candidate. */
export async function readCandidateSliceRows(request: Request, read = translationCommands.candidateSlice, live: () => boolean = () => true) {
  if (!request.unitIds.length || request.unitIds.length > 50 || new Set(request.unitIds).size !== request.unitIds.length) {
    throw new Error("Invalid candidate batch members");
  }
  const rows: TranslationCandidateSliceRow[] = [];
  const seen = new Set<string>();
  let offset = 0, afterOrdinal = "0", readVersion = request.readVersion ?? undefined;
  while (offset < request.unitIds.length) {
    if (!live()) throw new Error("Candidate batch read cancelled");
    const remaining = request.unitIds.slice(offset);
    const page = await read({ ...request, unitIds: remaining, afterOrdinal, ...(readVersion ? { readVersion } : {}) });
    if (!live() || page.projectId !== request.projectId || page.locale !== request.locale
      || page.sourceSnapshotId !== request.sourceSnapshotId || page.scopeId !== (request.scopeId ?? null)
      || readVersion !== undefined && page.readVersion !== readVersion || !page.rows.length || page.rows.length > remaining.length) {
      throw new Error("Candidate batch page changed");
    }
    readVersion = page.readVersion;
    for (const [index, row] of page.rows.entries()) {
      if (row.target.unitId !== remaining[index] || row.target.locale !== request.locale || row.target.sourceSnapshotId !== request.sourceSnapshotId) {
        throw new Error("Candidate batch page has different members");
      }
      const position = offset + index, before = rows[position];
      if (before && JSON.stringify([before.target, before.protection, before.selectedOriginKind, before.candidateCount])
        !== JSON.stringify([row.target, row.protection, row.selectedOriginKind, row.candidateCount])) {
        throw new Error("Candidate batch member changed during continuation");
      }
      let ordinal = index === 0 ? BigInt(afterOrdinal) : 0n;
      for (const revision of row.revisions) {
        if (revision.unitId !== row.target.unitId || revision.locale !== request.locale || revision.sourceRevisionId !== row.target.sourceRevisionId
          || revision.originKind !== "ai" || revision.revisionId === row.target.revisionId || seen.has(revision.revisionId)
          || BigInt(revision.ordinal) <= ordinal
          || (revision.candidateDecision?.request.disposition === "rejected") !== (request.state === "rejected")) {
          throw new Error("Candidate batch contains an ineligible version");
        }
        seen.add(revision.revisionId); ordinal = BigInt(revision.ordinal);
      }
      rows[position] = { ...row, revisions: [...(before?.revisions ?? []), ...row.revisions] };
      if (rows[position].revisions.length > row.candidateCount) throw new Error("Candidate batch count changed");
    }
    if (page.next === null) {
      if (offset + page.rows.length !== request.unitIds.length) throw new Error("Candidate batch omitted members");
      offset = request.unitIds.length;
      break;
    }
    const next = page.next;
    if (!Number.isInteger(next.unitOffset) || next.unitOffset < 0 || next.unitOffset > page.rows.length
      || next.unitOffset >= remaining.length || BigInt(next.afterOrdinal) < 0n
      || next.unitOffset === 0 && BigInt(next.afterOrdinal) <= BigInt(afterOrdinal)
      || next.unitOffset === page.rows.length && next.afterOrdinal !== "0"
      || next.unitOffset < page.rows.length && (next.unitOffset !== page.rows.length - 1
        || page.rows[next.unitOffset].revisions.at(-1)?.ordinal !== next.afterOrdinal)) {
      throw new Error("Candidate batch continuation did not advance");
    }
    offset += next.unitOffset; afterOrdinal = next.afterOrdinal;
  }
  if (!readVersion || rows.length !== request.unitIds.length || rows.some(row => row.revisions.length !== row.candidateCount)) {
    throw new Error("Candidate batch returned an incomplete member");
  }
  return { rows, readVersion };
}
