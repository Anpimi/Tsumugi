import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionReadProvider, useSessionQuery, useSessionReads } from "./SessionReadProvider";
import type { SessionReads } from "./sessionReads";
afterEach(cleanup);
const context = { projectId: "project", sessionToken: "session" };
function Probe({ read, enabled = true }: { read: () => Promise<string | null>; enabled?: boolean }) {
  const query = useSessionQuery({ key: ["same-attempt"], scopes: ["execution"], enabled, read });
  return <><p>{query.data ?? "Loading"}</p><button onClick={() => query.setData(null)}>Reopen attempt</button></>;
}
it("rereads when the same attempt is reopened instead of leaving a cached null", async () => {
  const read = vi.fn().mockResolvedValueOnce("Earlier result").mockResolvedValue("Current result");
  render(<SessionReadProvider context={context} bridge={false}><Probe read={read}/></SessionReadProvider>);
  await screen.findByText("Earlier result"); fireEvent.click(screen.getByRole("button"));
  await screen.findByText("Current result"); expect(read).toHaveBeenCalledTimes(2);
});
it("ignores a pending response after hiding the view and rereads when it is opened", async () => {
  let resolve: (value: string) => void = () => {};
  const read = vi.fn().mockImplementationOnce(() => new Promise<string>(finish => { resolve = finish; })).mockResolvedValue("Reopened result");
  const ui = (enabled: boolean) => <SessionReadProvider context={context} bridge={false}><Probe read={read} enabled={enabled}/></SessionReadProvider>;
  const view = render(ui(true)); view.rerender(ui(false));
  await act(async () => { resolve("Obsolete result"); });
  expect(screen.queryByText("Obsolete result")).not.toBeInTheDocument();
  view.rerender(ui(true)); await screen.findByText("Reopened result");
});

it("keeps a slow project A response out of project B's view and cache", async () => {
  let resolveA!: (value: string) => void;
  const readA = vi.fn(() => new Promise<string>(resolve => { resolveA = resolve; }));
  const readB = vi.fn().mockResolvedValue("Current project B");
  const projectB = { projectId: "project-b", sessionToken: "session-b" };
  const owners: SessionReads[] = [];
  function ObservedProbe({ read }: { read: () => Promise<string> }) {
    const owner = useSessionReads();
    if (!owners.includes(owner)) owners.push(owner);
    return <Probe read={read} />;
  }
  const view = render(<SessionReadProvider key={context.sessionToken} context={context} bridge={false}><ObservedProbe read={readA}/></SessionReadProvider>);
  expect(readA).toHaveBeenCalledTimes(1);
  view.rerender(<SessionReadProvider key={projectB.sessionToken} context={projectB} bridge={false}><ObservedProbe read={readB}/></SessionReadProvider>);
  await screen.findByText("Current project B");
  await act(async () => resolveA("Private late result from project A"));
  expect(screen.queryByText("Private late result from project A")).not.toBeInTheDocument();
  expect(screen.getByText("Current project B")).toBeVisible();
  expect(owners).toHaveLength(2);
  expect(owners[0].client).not.toBe(owners[1].client);
  expect(owners[1].client.getQueryData(owners[1].key(["same-attempt"]))).toBe("Current project B");
  expect(owners[1].client.getQueryCache().getAll().every(query => query.queryKey[0] === projectB.projectId && query.queryKey[1] === projectB.sessionToken)).toBe(true);
  expect(readB).toHaveBeenCalledTimes(1);
});
