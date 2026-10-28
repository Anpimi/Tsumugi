import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/decisionCommands.contract.json";
import { decisionCommands, type DecisionPage, type DecisionPageRequest } from "./decisionCommands";
import { validateRequestPage, validateResponsePage } from "./generated/decisions.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

function request(): DecisionPageRequest {
  const value: unknown = structuredClone(fixture.request);
  if (!validateRequestPage(value)) throw new Error("Invalid request fixture");
  return value;
}
function response(): DecisionPage {
  const value: unknown = structuredClone(fixture.response);
  if (!validateResponsePage(value)) throw new Error("Invalid response fixture");
  return value;
}

it("keeps plan and source targets and unknown totals for unavailable sources", async () => {
  const input = request(), page = response();
  invoke.mockResolvedValueOnce(page);
  expect(await decisionCommands.page(input)).toEqual(page);
  expect(invoke).toHaveBeenCalledWith("read_decision_page", { request: input });
  expect(page.total).toBeNull();
  expect(page.items.map(item => item.targets[0]?.kind)).toEqual(["plan", "source-occurrence"]);
});

it.each(["false-total", "missing-source", "false-source-total", "wrong-project", "wrong-query", "reordered", "wrong-target", "false-continuation", "extra-page"])("rejects %s without presenting an empty inbox", async kind => {
  const page = response();
  if (kind === "false-total") page.total = 0;
  if (kind === "missing-source") page.coverage.pop();
  if (kind === "false-source-total") page.coverage.find(source => source.state === "unavailable")!.total = 0;
  if (kind === "wrong-project") page.projectId = "00000000-0000-4000-8000-000000000099";
  if (kind === "wrong-query") page.query.locale = "ja";
  if (kind === "reordered") page.items.reverse();
  if (kind === "wrong-target") page.items[1]!.targets = [{ kind: "project" }];
  if (kind === "false-continuation") page.next = { basis: "d".repeat(64), afterId: page.items.at(-1)!.decisionId };
  if (kind === "extra-page") page.next = { basis: page.basis, afterId: page.items.at(-1)!.decisionId };
  invoke.mockResolvedValueOnce(page);
  await expect(decisionCommands.page(request())).rejects.toThrow("Invalid IPC response");
});

it("keeps an exact cursor basis and excludes rows before its boundary", async () => {
  const input = request(), page = response();
  input.cursor = { basis: page.basis, afterId: page.items[0]!.decisionId };
  page.items.shift();
  invoke.mockResolvedValueOnce(page);
  expect((await decisionCommands.page(input)).items).toHaveLength(1);
  const changed = response(); changed.basis = "d".repeat(64); changed.items.shift();
  invoke.mockResolvedValueOnce(changed);
  await expect(decisionCommands.page(input)).rejects.toThrow("Invalid IPC response");
});

it("accepts an exact zero only for a completely read selected source", async () => {
  const input = request(), page = response();
  input.query.sources = ["execution-unknown"];
  page.query = { locale: input.query.locale ?? null, sources: [...input.query.sources] };
  page.coverage = [{ source: "execution-unknown", state: "complete", knownCount: 0, total: 0, reason: null, errorCode: null }];
  page.items = []; page.knownCount = 0; page.total = 0;
  invoke.mockResolvedValueOnce(page);
  expect((await decisionCommands.page(input)).total).toBe(0);
});

it("captures nested filters before an awaiting caller changes them", async () => {
  const input = request(), captured = structuredClone(input);
  let finish!: (page: DecisionPage) => void;
  invoke.mockImplementationOnce(() => new Promise<DecisionPage>(resolve => { finish = resolve; }));
  const reading = decisionCommands.page(input);
  input.query.locale = "ja"; input.query.sources.push("human-review");
  finish(response());
  expect(await reading).toEqual(response());
  expect(invoke).toHaveBeenCalledWith("read_decision_page", { request: captured });
});
