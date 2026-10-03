import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionReadProvider, useSessionQuery } from "./SessionReadProvider";
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
