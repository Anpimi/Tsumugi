import { expect, it } from "vitest";
import { SessionReads } from "../../../sessionReads";
import { candidateHistoryKey, candidateReadProof } from "./candidateReads";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";

it("revokes an action's read witness after a fresh identical result or replacement of its exact Query record", () => {
  const reads = new SessionReads({ projectId: "synthetic-project", sessionToken: "synthetic-session" });
  const key = candidateHistoryKey(reviewTargetFixture(), "0"), queryKey = reads.key(key), data = { rows: [] };
  reads.client.setQueryData(queryKey, data);
  const identical = candidateReadProof(reads, key, data); expect(identical.current()).toBe(true);
  reads.client.setQueryData(queryKey, data); expect(identical.current()).toBe(false); identical.dispose();
  const replaced = candidateReadProof(reads, key, data); expect(replaced.current()).toBe(true);
  reads.client.removeQueries({ queryKey, exact: true }); reads.client.setQueryData(queryKey, data);
  expect(replaced.current()).toBe(false); replaced.dispose(); reads.retire();
});
