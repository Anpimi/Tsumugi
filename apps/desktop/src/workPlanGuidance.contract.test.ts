import { beforeEach, expect, it, vi } from "vitest";
import agent from "../test/fixtures/workPlanAgent.contract.json";
import { workPlanToolStatus } from "./testSupport/workPlanToolFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { openWorkPlanAgent } from "./workPlanCommands";
import { validateResponseWorkPlanAgentGuidance, validateResponseWorkPlanAgentSkill } from "./generated/ai.validators.js";
import type { WorkPlanToolSpec, WorkPlanAgentGuidanceView, WorkPlanAgentGuidanceTextView } from "./generated/ai.responses";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const original = workPlanToolStatus.plan.tools!.entries[0];
const scope = { projectId: agent.requests.open.projectId, sessionToken: agent.requests.open.sessionToken, scopeId: agent.responses.scope.scopeId };
const invalid = { outcome: "unknown", reason: "invalid-work-plan-acknowledgement" };
function catalog(tools: WorkPlanToolSpec[] = [original]): WorkPlanAgentGuidanceView {
  const value: unknown = structuredClone({ scopeId: scope.scopeId, parentTask: agent.responses.scope.parentTask, tools });
  if (!validateResponseWorkPlanAgentGuidance(value)) throw new Error("Invalid Agent guidance catalog fixture");
  return value;
}
function skill(text = "# Guidance 👩🏽‍💻 e\u0301\n[No network permission](https://example.test)"): WorkPlanAgentGuidanceTextView {
  return { scopeId: scope.scopeId, parentTask: agent.responses.scope.parentTask, tool: structuredClone(original),
    content: { kind: "skill", contributionId: original.binding.declaration.skill!, text } };
}
function resource(): WorkPlanAgentGuidanceTextView {
  const value = original.binding.resources[0];
  return { ...skill(), content: { kind: "resource", contributionId: value.contributionId, schema: structuredClone(value.schema), text: "Reference\n<script>not executable</script>" } };
}
async function opened(tools = [original]) {
  return openWorkPlanAgent(agent.requests.open, agent.responses.scope.scope, tools);
}
beforeEach(() => {
  invoke.mockReset(); invoke.mockImplementation(async command => {
    if (command === "open_work_plan_agent_scope") return structuredClone(agent.responses.scope);
    if (command === "read_work_plan_agent_guidance") return catalog();
    if (command === "read_work_plan_agent_skill") return skill();
    if (command === "read_work_plan_agent_resource") return resource();
    throw new Error(command);
  });
});

it("reads the exact captured catalog without prefetching content, then reads only original declared members", async () => {
  const consumer = await opened();
  expect(await consumer.readGuidance()).toEqual(catalog());
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["open_work_plan_agent_scope", "read_work_plan_agent_guidance"]);
  expect(await consumer.readSkill(original.handle)).toEqual(skill());
  expect(invoke).toHaveBeenLastCalledWith("read_work_plan_agent_skill", { request: { ...scope, toolHandle: original.handle, skillId: original.binding.declaration.skill } });
  expect(await consumer.readResource(original.handle, original.binding.resources[0].contributionId)).toEqual(resource());
  expect(invoke).toHaveBeenLastCalledWith("read_work_plan_agent_resource", { request: { ...scope, toolHandle: original.handle, resourceId: original.binding.resources[0].contributionId } });
  expect(invoke.mock.calls.every(([command]) => command === "open_work_plan_agent_scope" || command.startsWith("read_work_plan_agent_"))).toBe(true);
});

it("captures trusted tool identities before opening and never accepts permission rewrites from returned catalog DTOs", async () => {
  const tools = structuredClone([original]), opening = opened(tools);
  tools[0].binding.declaration.skill = "different-skill"; tools[0].handle = fixtureIdentity(999);
  const consumer = await opening, value = await consumer.readGuidance();
  value.tools[0].binding.declaration.skill = "../../private";
  value.tools[0].binding.resources[0].schema.id = "different-schema";
  await consumer.readSkill(original.handle); await consumer.readResource(original.handle, original.binding.resources[0].contributionId);
  expect(invoke.mock.calls.at(-2)?.[1].request).toEqual({ ...scope, toolHandle: original.handle, skillId: original.binding.declaration.skill });
  expect(invoke.mock.calls.at(-1)?.[1].request).toEqual({ ...scope, toolHandle: original.handle, resourceId: original.binding.resources[0].contributionId });
});

it.each(["scope", "parent", "missing", "duplicate", "binding", "permissions", "resource"])("rejects a %s catalog mismatch", async mismatch => {
  const consumer = await opened(), value = catalog();
  if (mismatch === "scope") value.scopeId = fixtureIdentity(990);
  if (mismatch === "parent") value.parentTask = fixtureIdentity(990);
  if (mismatch === "duplicate") value.tools.push(structuredClone(value.tools[0]));
  if (mismatch === "binding") value.tools[0].binding.capability.provider.packageDigest = "b".repeat(64);
  if (mismatch === "permissions") value.tools[0].binding.capability.declaration.permissions = [{ kind: "network", destination: "https://example.test" }];
  if (mismatch === "resource") value.tools[0].binding.resources[0].schema.behaviorVersion++;
  invoke.mockResolvedValueOnce(mismatch === "missing" ? { ...value, tools: [] } : value);
  await expect(consumer.readGuidance()).rejects.toMatchObject(invalid);
});

it("keeps absent guidance explicit and rejects outside handles, paths, URLs and undeclared references before IPC", async () => {
  const noSkill = structuredClone(original); noSkill.binding.declaration.skill = null;
  noSkill.binding.declaration.supportingResources = []; noSkill.binding.resources = [];
  const consumer = await opened([noSkill]), count = invoke.mock.calls.length;
  await expect(consumer.readSkill(original.handle)).rejects.toThrow("no Skill");
  for (const handle of [fixtureIdentity(999), "../../tool", "https://example.test"])
    await expect(consumer.readSkill(handle)).rejects.toThrow("outside");
  for (const member of ["../../reference", "https://example.test", original.binding.resources[0].contributionId])
    await expect(consumer.readResource(original.handle, member)).rejects.toThrow("outside");
  expect(invoke).toHaveBeenCalledTimes(count);
});

it.each(["scope", "parent", "tool", "kind", "member", "too-large", "surrogate"])("rejects %s Skill content without fallback", async mismatch => {
  const consumer = await opened(), value = skill();
  if (mismatch === "scope") value.scopeId = fixtureIdentity(990);
  if (mismatch === "parent") value.parentTask = fixtureIdentity(990);
  if (mismatch === "tool") {
    value.tool.execution.environment.sdkVersion = "9.9.9";
    expect(validateResponseWorkPlanAgentSkill(value)).toBe(true);
  }
  if (mismatch === "member") value.content.contributionId = "other-skill";
  if (mismatch === "too-large") value.content.text = "é".repeat(32769);
  if (mismatch === "surrogate") value.content.text = "\uD800";
  invoke.mockResolvedValueOnce(mismatch === "kind" ? resource() : value);
  await expect(consumer.readSkill(original.handle)).rejects.toMatchObject(invalid);
  expect(invoke.mock.calls).toHaveLength(2);
});

it("accepts the exact UTF-8 limit without trimming or normalizing guidance", async () => {
  const consumer = await opened(), exact = "e\u0301".repeat(21845) + "x";
  expect(new TextEncoder().encode(exact).length).toBe(65536);
  invoke.mockResolvedValueOnce(skill(exact));
  expect((await consumer.readSkill(original.handle)).content.text).toBe(exact);
});

it("counts Unicode code points at the generated schema's character ceiling", () => {
  expect(validateResponseWorkPlanAgentSkill(skill("😀".repeat(65536)))).toBe(true);
  expect(validateResponseWorkPlanAgentSkill(skill("😀".repeat(65537)))).toBe(false);
  expect(validateResponseWorkPlanAgentSkill(skill("x".repeat(65537)))).toBe(false);
});

it.each(["kind", "member", "contract"])("rejects an unrelated supporting resource %s", async mismatch => {
  const consumer = await opened(), value = resource();
  if (value.content.kind !== "resource") throw new Error("Expected the resource fixture");
  if (mismatch === "member") value.content.contributionId = "other-reference";
  if (mismatch === "contract") value.content.schema.behaviorVersion++;
  invoke.mockResolvedValueOnce(mismatch === "kind" ? skill() : value);
  await expect(consumer.readResource(original.handle, original.binding.resources[0].contributionId)).rejects.toMatchObject(invalid);
});

it("propagates old-scope rejection without opening, renewing, executing, or falling back to project history", async () => {
  const consumer = await opened(), rejection = { code: "permission-denied", stage: "execution-read", outcome: "rejected", reason: "work-plan-agent-session", recoveryRequired: false };
  invoke.mockRejectedValue(rejection);
  await expect(consumer.readGuidance()).rejects.toEqual(rejection);
  await expect(consumer.readSkill(original.handle)).rejects.toEqual(rejection);
  await expect(consumer.readResource(original.handle, original.binding.resources[0].contributionId)).rejects.toEqual(rejection);
  expect(invoke.mock.calls.filter(([command]) => command === "open_work_plan_agent_scope")).toHaveLength(1);
});
