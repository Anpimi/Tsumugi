import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkPlanTeamMessageRequest } from "./generated/ai.requests";
import * as validators from "./generated/ai.validators";
import { workPlanCommands } from "./workPlanCommands";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import { humanTeamMessageFixture, teamGuidanceFixture } from "./testSupport/teamGuidanceFixture";
import { publishedTeamFixture, teamContext, teamPublishRequestFixture } from "./testSupport/teamDiscussionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const domains = ["message", "publication"] as const;
type Domain = typeof domains[number];
type Kind = "pending" | "recorded" | "fenced-not-applied";
type Reply = Awaited<ReturnType<typeof workPlanCommands.teamMessageSettlement>> | Awaited<ReturnType<typeof workPlanCommands.teamPublicationSettlement>>;
const generation = "9007199254740993", earlier = "9007199254740992", later = "9007199254740994";

function fixture(domain: Domain) {
  if (domain === "message") {
    const { status, view } = teamGuidanceFixture(), member = view.roster[1];
    const request: WorkPlanTeamMessageRequest = { ...teamContext, lease: { ...status.lease, generation }, message: {
      messageId: id(16300), recipientMemberId: member.memberId, expectedRecipientRoleVersionId: member.roleVersionId,
      target: structuredClone(view.works[0].target), body: "  Exact guidance A {{name}} é 👩🏽‍💻  " } };
    if (!validators.validateRequestWorkPlanTeamMessageAction(request)) throw new Error("Invalid original guidance fixture");
    return { domain: "message" as const, request, receipt: humanTeamMessageFixture(request),
      command: "read_work_plan_team_message_settlement", read: () => workPlanCommands.teamMessageSettlement(request),
      valid: validators.validateResponseWorkPlanTeamMessageSettlement };
  }
  const request = teamPublishRequestFixture(); request.lease.generation = generation;
  if (!validators.validateRequestWorkPlanTeamPublicationAction(request)) throw new Error("Invalid original publication fixture");
  return { domain: "publication" as const, request, receipt: publishedTeamFixture(request),
    command: "read_work_plan_team_publication_settlement", read: () => workPlanCommands.teamPublicationSettlement(request),
    valid: validators.validateResponseWorkPlanTeamPublicationSettlement };
}
type Fixture = ReturnType<typeof fixture>;
function proof(f: Fixture, kind: Kind = "recorded", currentGeneration = later, state: "active" | "paused" | "stopped" = "stopped"): Reply {
  const { sessionToken: _token, ...original } = structuredClone(f.request);
  const value: unknown = { request: original, settlement: { projectId: f.request.projectId, planId: f.request.lease.planId,
    lease: { planId: f.request.lease.planId, generation: currentGeneration }, state,
    outcome: kind === "recorded" ? { kind, receipt: structuredClone(f.receipt) } : { kind } } };
  if (f.domain === "message" && validators.validateResponseWorkPlanTeamMessageSettlement(value)) return value;
  if (f.domain === "publication" && validators.validateResponseWorkPlanTeamPublicationSettlement(value)) return value;
  throw new Error("Invalid synthetic team settlement fixture");
}
function humanBinding(reply: Reply) {
  const outcome = reply.settlement.outcome;
  if (outcome.kind !== "recorded") throw new Error("Recorded fixture required");
  const author = "sender" in outcome.receipt ? outcome.receipt.sender : outcome.receipt.author;
  if (author.kind !== "human") throw new Error("Original human fixture required");
  return author;
}
function changedReceipt(reply: Reply, field: "body" | "target" | "identity") {
  const outcome = reply.settlement.outcome;
  if (outcome.kind !== "recorded") throw new Error("Recorded fixture required");
  const receipt = outcome.receipt;
  if ("sender" in receipt) {
    if (field === "body") receipt.body = "Different returned body";
    else if (field === "target") receipt.target.sourceRevisionId = id(16301);
    else receipt.messageId = id(16302);
  } else {
    if (field === "body") receipt.publication.body = "Different returned body";
    else if (field === "target") receipt.publication.target.sourceRevisionId = id(16301);
    else receipt.publication.postId = id(16302);
  }
}
beforeEach(() => { invoke.mockReset(); });
afterEach(() => { expect(invoke.mock.calls.every(([command]) => domains.some(domain => command === `read_work_plan_team_${domain === "message" ? "message" : "publication"}_settlement`))).toBe(true); });

describe("team settlement bridge contract", () => {
  it.each(domains)("reads exact %s tuples for current/future pending and historical recorded/fenced outcomes, freezing input before await", async domain => {
    const f = fixture(domain), original = structuredClone(f.request);
    const observations = [["pending", earlier, "paused"], ["pending", generation, "active"],
      ["recorded", generation, "active"], ["recorded", later, "stopped"], ["fenced-not-applied", later, "stopped"]] as const;
    for (const [kind, current, state] of observations) {
      const value = proof(f, kind, current, state); invoke.mockResolvedValueOnce(value);
      expect(await f.read()).toEqual(value); expect(value.request).not.toHaveProperty("sessionToken");
      expect(invoke).toHaveBeenLastCalledWith(f.command, { request: original });
    }
    const value = proof(f); let answer!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const reading = f.read();
    f.request.sessionToken = "new-session-B"; f.request.projectId = id(16303); f.request.lease.generation = "7";
    if ("message" in f.request) { f.request.message.body = "Newer guidance B"; f.request.message.target.unitId = id(16304); }
    else { f.request.publication.body = "Newer discussion B"; f.request.publication.replyTo = id(16304); }
    answer(value); expect(await reading).toEqual(value);
    expect(invoke).toHaveBeenLastCalledWith(f.command, { request: original }); expect(invoke).toHaveBeenCalledTimes(6);
    expect(value.settlement.outcome).toMatchObject({ kind: "recorded", receipt: f.receipt });
  });

  it.each(domains)("rejects a different original %s tuple, foreign snapshots, zero generations and false fences", async domain => {
    const f = fixture(domain);
    const changes: [string, (value: Reply) => void][] = [
      ["original project", value => { value.request.projectId = id(16305); }],
      ["original plan", value => { value.request.lease.planId = id(16306); }],
      ["original lease", value => { value.request.lease.generation = earlier; }],
      ["original body", value => { if ("message" in value.request) value.request.message.body = "Different original body"; else value.request.publication.body = "Different original body"; }],
      ["snapshot project", value => { value.settlement.projectId = id(16305); }],
      ["snapshot plan", value => { value.settlement.planId = id(16306); }],
      ["snapshot lease plan", value => { value.settlement.lease.planId = id(16306); }],
      ["zero snapshot generation", value => { value.settlement.lease.generation = "0"; }],
      ["recorded snapshot predates request", value => { value.settlement.lease.generation = earlier; }],
    ];
    for (const [label, change] of changes) {
      const value = proof(f); change(value); expect(f.valid(value), label).toBe(true); invoke.mockResolvedValueOnce(value);
      await expect(f.read(), label).rejects.toMatchObject({ outcome: "unknown", reason: "invalid-work-plan-acknowledgement" });
    }
    for (const [kind, snapshot] of [["fenced-not-applied", generation], ["fenced-not-applied", earlier], ["pending", later]] as const) {
      const value = proof(f, kind); value.settlement.lease.generation = snapshot; expect(f.valid(value)).toBe(true); invoke.mockResolvedValueOnce(value);
      await expect(f.read()).rejects.toMatchObject({ outcome: "unknown", reason: "invalid-work-plan-acknowledgement" });
    }
    const calls = invoke.mock.calls.length; f.request.lease.generation = "0";
    await expect(f.read()).rejects.toThrow(); expect(invoke).toHaveBeenCalledTimes(calls);
  });

  it.each(domains)("rejects wrong %s recorded author/content/target identities and missing receipts instead of treating them as absent", async domain => {
    const f = fixture(domain);
    const changes: [string, (value: Reply) => void][] = [
      ["actor", value => { humanBinding(value).actor = "another-user"; }],
      ["author lease", value => { humanBinding(value).binding.lease.generation = later; }],
      ["body", value => changedReceipt(value, "body")],
      ["target", value => changedReceipt(value, "target")],
      ["action identity", value => changedReceipt(value, "identity")],
      ["recorded plan", value => { if (value.settlement.outcome.kind === "recorded") value.settlement.outcome.receipt.planId = id(16307); }],
      ["recipient role or reply", value => {
        const outcome = value.settlement.outcome; if (outcome.kind !== "recorded") throw new Error("Recorded fixture required");
        if ("sender" in outcome.receipt) outcome.receipt.recipientRoleVersionId = id(16308); else outcome.receipt.publication.replyTo = id(16308);
      }],
    ];
    for (const [label, change] of changes) {
      const value = proof(f); change(value); expect(f.valid(value), label).toBe(true); invoke.mockResolvedValueOnce(value);
      await expect(f.read(), label).rejects.toMatchObject({ outcome: "unknown", reason: "invalid-work-plan-acknowledgement" });
    }
    const valid = proof(f);
    for (const malformed of [null, undefined, { ...valid, settlement: null },
      { ...valid, settlement: { ...valid.settlement, outcome: { kind: "recorded", receipt: null } } },
      { ...valid, settlement: { ...valid.settlement, outcome: { kind: "recorded" } } },
      { ...valid, request: { ...valid.request, sessionToken: "must-not-be-in-a-receipt" } }]) {
      expect(f.valid(malformed)).toBe(false); invoke.mockResolvedValueOnce(malformed); await expect(f.read()).rejects.toThrow();
    }
  });
});
