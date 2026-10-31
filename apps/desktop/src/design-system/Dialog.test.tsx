import { useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Button } from "./Button";
import { Dialog, Sheet } from "./Dialog";

afterEach(cleanup);

it.each(["dialog", "sheet"] as const)("closes an automatically focused %s with one Escape and returns to its opener", async kind => {
  function Example() {
    const [open, setOpen] = useState(false), Surface = kind === "dialog" ? Dialog : Sheet;
    return <><Button onClick={() => setOpen(true)}>Open settings</Button>
      <Surface open={open} onOpenChange={setOpen} title="Settings" closeLabel="Close settings"><p>Settings content</p></Surface></>;
  }
  const user = userEvent.setup(); render(<Example/>);
  const opener = screen.getByRole("button", { name: "Open settings" });
  await user.click(opener);
  const surface = await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(within(surface).getByRole("button", { name: "Close settings" })).toHaveFocus());
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
  await waitFor(() => expect(opener).toHaveFocus());
});
