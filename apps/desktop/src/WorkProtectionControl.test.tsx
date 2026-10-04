import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkProtectionControl, type WorkProtectionControlProps } from "./WorkProtectionControl";
import { SessionReadProvider } from "./SessionReadProvider";
import { i18n } from "./i18n";
import { enUS } from "./i18n/en-US";
import type { WorkProtection } from "./workPlanCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import errorFixture from "../test/fixtures/commandErrors.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: fixtureIdentity(1), sessionToken: "synthetic-session" };
const target = { unitId: fixtureIdentity(2), sourceRevisionId: fixtureIdentity(3), key: "entry.first" };
const locale = "zh-CN";
const selectionId = fixtureIdentity(4);
type Request = { request: Record<string, unknown> };
let protections: Map<string, WorkProtection>;
let receipts: Map<string, WorkProtection>;
let identity: number;

function key(unitId: string, targetLocale: string) { return `${unitId}:${targetLocale}`; }
function setCurrent(value: WorkProtection) { protections.set(key(value.unitId, value.locale), value); }
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function label(name: keyof typeof enUS.protection) { return i18n.t(`protection.${name}`); }

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  invoke.mockReset(); identity = 100; protections = new Map(); receipts = new Map();
  setCurrent({ unitId: target.unitId, locale, revision: "8", protected: true });
  invoke.mockImplementation(async (command: string, { request }: Request) => {
    if (command === "create_execution_identity") {
      expect(Object.keys(request).sort()).toEqual(["projectId", "sessionToken"]);
      return fixtureIdentity(++identity);
    }
    const unitId = String(request.unitId), targetLocale = String(request.locale);
    const current = protections.get(key(unitId, targetLocale))
      ?? { unitId, locale: targetLocale, revision: "0", protected: false };
    if (command === "read_work_protection") return { ...current };
    if (command === "set_work_protection") {
      const action = String(request.actionId), existing = receipts.get(action);
      if (existing) return { ...existing };
      if (current.revision !== request.expectedRevision) throw errorFixture.errors[1];
      const next = { unitId, locale: targetLocale,
        revision: (BigInt(String(request.expectedRevision)) + 1n).toString(), protected: request.protected === true };
      setCurrent(next); receipts.set(action, next);
      return { ...next };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

function setup(overrides: Partial<WorkProtectionControlProps> = {}) {
  const failures = vi.fn(), onBlockedChange = vi.fn();
  const run: WorkProtectionControlProps["run"] = vi.fn(async (work: Parameters<WorkProtectionControlProps["run"]>[0]) => {
    try { await work(() => true); } catch (error) { failures(error); }
  });
  let props: WorkProtectionControlProps = { context, target, locale, selectionId,
    open: true, disabled: false, draftBlocked: false, run, onBlockedChange, ...overrides };
  const ui = () => <SessionReadProvider context={context} bridge={false}>
    <WorkProtectionControl {...props} />
  </SessionReadProvider>;
  const rendered = render(ui());
  return { ...rendered, failures, onBlockedChange, rerenderControl: (next: Partial<WorkProtectionControlProps>) => {
    props = { ...props, ...next }; rendered.rerender(ui());
  } };
}

async function confirmRelease(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: label("release") }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: label("confirmRelease") }));
}

it("shows current protection and requires confirmation of the captured release scope", async () => {
  setup();
  const user = userEvent.setup();
  expect(await screen.findByText(label("protected"), { exact: true })).toBeVisible();
  expect(screen.getByRole("button", { name: label("protect") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: label("release") }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(target.key, { selector: "code" })).toBeVisible();
  expect(within(dialog).getByText(locale, { selector: "span" })).toBeVisible();
  await user.click(within(dialog).getByText(label("evidence"), { selector: "summary" }));
  expect(within(dialog).getByText(target.sourceRevisionId)).toBeVisible();
  expect(within(dialog).getByText(selectionId)).toBeVisible();
  expect(within(dialog).getByText("8", { selector: "dd" })).toBeVisible();
  expect(calls("set_work_protection")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: label("confirmRelease") }));
  expect(await screen.findByText(label("unprotected"), { exact: true })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("region", { name: label("title") })).toHaveFocus());
  expect(calls("set_work_protection")[0][1].request).toEqual({ ...context, unitId: target.unitId, locale,
    sourceRevisionId: target.sourceRevisionId, selectionId, expectedRevision: "8",
    protected: false, confirmedRelease: true, actionId: fixtureIdentity(101) });
  expect(calls("read_work_protection")).toHaveLength(2);
});

it("blocks release for a dirty draft and when a draft becomes blocked inside the dialog", async () => {
  const view = setup({ draftBlocked: true });
  const user = userEvent.setup();
  await screen.findByText(label("protected"), { exact: true });
  expect(screen.getByRole("button", { name: label("release") })).toBeDisabled();
  expect(screen.getByText(label("draftBlocked"))).toBeVisible();
  view.rerenderControl({ draftBlocked: false });
  await user.click(screen.getByRole("button", { name: label("release") }));
  const dialog = await screen.findByRole("dialog");
  view.rerenderControl({ draftBlocked: true });
  expect(within(dialog).getByRole("button", { name: label("confirmRelease") })).toBeDisabled();
  expect(within(dialog).getByText(label("draftBlocked"))).toBeVisible();
  expect(calls("set_work_protection")).toHaveLength(0);
});

it("allows explicit protection while keeping the draft blocked from release", async () => {
  setCurrent({ unitId: target.unitId, locale, revision: "9007199254740993", protected: false });
  setup({ draftBlocked: true });
  const user = userEvent.setup();
  await screen.findByText(label("unprotected"), { exact: true });
  await user.click(screen.getByRole("button", { name: label("protect") }));
  expect(await screen.findByText(label("protected"), { exact: true })).toBeVisible();
  expect(calls("set_work_protection")[0][1].request).toMatchObject({
    expectedRevision: "9007199254740993", protected: true, confirmedRelease: false,
  });
  expect(screen.getByRole("button", { name: label("release") })).toBeDisabled();
});

it("retains an unknown request across hiding and target changes and retries the same action", async () => {
  setCurrent({ unitId: target.unitId, locale, revision: "8", protected: false });
  const original = invoke.getMockImplementation()!;
  let loseResponse = true;
  invoke.mockImplementation(async (command: string, args: Request) => {
    const result = await original(command, args);
    if (command === "set_work_protection" && loseResponse) { loseResponse = false; throw new Error("Lost response"); }
    return result;
  });
  const view = setup();
  const user = userEvent.setup();
  await screen.findByText(label("unprotected"), { exact: true });
  await user.click(screen.getByRole("button", { name: label("protect") }));
  await screen.findByRole("button", { name: label("retry") });
  expect(view.failures).toHaveBeenCalledTimes(1);
  expect(view.onBlockedChange).toHaveBeenLastCalledWith(true);
  const reads = calls("read_work_protection").length;
  view.rerenderControl({ open: false });
  await act(async () => {});
  expect(calls("read_work_protection")).toHaveLength(reads);
  expect(screen.queryByRole("button", { name: label("retry") })).not.toBeInTheDocument();
  expect(view.onBlockedChange).toHaveBeenLastCalledWith(true);
  const second = { ...target, unitId: fixtureIdentity(20), sourceRevisionId: fixtureIdentity(21), key: "entry.second" };
  view.rerenderControl({ open: true, target: second, selectionId: null });
  await screen.findByText(label("unprotected"), { exact: true });
  await user.click(screen.getByRole("button", { name: label("retry") }));
  await waitFor(() => expect(view.onBlockedChange).toHaveBeenLastCalledWith(false));
  const writes = calls("set_work_protection");
  expect(writes).toHaveLength(2);
  expect(writes[1][1].request).toEqual(writes[0][1].request);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(screen.getByText(label("unprotected"), { exact: true })).toBeVisible();
});

it("refreshes current protection after an old release acknowledgement instead of clearing newer manual protection", async () => {
  const original = invoke.getMockImplementation()!;
  let loseResponse = true;
  invoke.mockImplementation(async (command: string, args: Request) => {
    const result = await original(command, args);
    if (command === "set_work_protection" && loseResponse) { loseResponse = false; throw new Error("Lost response"); }
    return result;
  });
  const view = setup();
  const user = userEvent.setup();
  await screen.findByText(label("protected"), { exact: true });
  await confirmRelease(user);
  await screen.findByRole("button", { name: label("retry") });
  setCurrent({ unitId: target.unitId, locale, revision: "10", protected: true });
  view.rerenderControl({ selectionId: fixtureIdentity(30) });
  await screen.findByText(label("protected"), { exact: true });
  const reads = calls("read_work_protection").length;
  await user.click(screen.getByRole("button", { name: label("retry") }));
  await waitFor(() => expect(view.onBlockedChange).toHaveBeenLastCalledWith(false));
  await waitFor(() => expect(calls("read_work_protection")).toHaveLength(reads + 1));
  expect(await screen.findByText(label("protected"), { exact: true })).toBeVisible();
  expect(calls("set_work_protection")[1][1].request).toEqual(calls("set_work_protection")[0][1].request);
  expect(screen.queryByRole("button", { name: label("retry") })).not.toBeInTheDocument();
});

it("does not query a hidden control and does not reuse a changed release basis", async () => {
  const view = setup({ open: false });
  await act(async () => {});
  expect(calls("read_work_protection")).toHaveLength(0);
  view.rerenderControl({ open: true });
  const user = userEvent.setup();
  await screen.findByText(label("protected"), { exact: true });
  await user.click(screen.getByRole("button", { name: label("release") }));
  const dialog = await screen.findByRole("dialog");
  view.rerenderControl({ selectionId: fixtureIdentity(31) });
  expect(await within(dialog).findByText(label("scopeChanged"))).toBeVisible();
  expect(within(dialog).getByRole("button", { name: label("confirmRelease") })).toBeDisabled();
  expect(calls("set_work_protection")).toHaveLength(0);
});

it("clears a known rejection but retains the current protection status", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: Request) => {
    if (command === "set_work_protection") return Promise.reject(errorFixture.errors[1]);
    return original(command, args);
  });
  const view = setup();
  const user = userEvent.setup();
  await screen.findByText(label("protected"), { exact: true });
  await confirmRelease(user);
  await waitFor(() => expect(view.failures).toHaveBeenCalledWith(errorFixture.errors[1]));
  expect(view.onBlockedChange).toHaveBeenLastCalledWith(false);
  expect(screen.queryByRole("button", { name: label("retry") })).not.toBeInTheDocument();
  expect(screen.getByText(label("protected"), { exact: true })).toBeVisible();
});
