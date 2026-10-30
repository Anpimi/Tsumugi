import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { Sheet } from "./Dialog";
import { Menu } from "./Menu";

let originalPointerEvents: string;
beforeEach(() => { originalPointerEvents = document.body.style.pointerEvents; });
afterEach(() => {
  cleanup();
  // A failed ownership assertion must not leak its document lock into another test.
  document.body.style.pointerEvents = originalPointerEvents;
});

it("restores background pointer input after a menu opens and closes a sheet", async () => {
  const user = userEvent.setup(), background = vi.fn();
  function Surface() {
    const [open, setOpen] = useState(false);
    return <>
      <Button onClick={background}>Open entries</Button>
      <Menu label="Project menu" trigger={<Button>Project menu</Button>}
        items={[{ id: "source", label: "Import source content", onSelect: () => setOpen(true) }]}/>
      <Sheet open={open} onOpenChange={setOpen} title="Source content" closeLabel="Close source content">
        <p>Source input remains in its project owner.</p>
      </Sheet>
    </>;
  }
  render(<Surface/>);
  await user.click(screen.getByRole("button", { name: "Project menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "Import source content" }));
  const sheet = await screen.findByRole("dialog", { name: "Source content" });
  expect.soft(document.body.style.pointerEvents).toBe("none");
  await user.click(within(sheet).getByRole("button", { name: "Close source content" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Source content" })).not.toBeInTheDocument());
  expect(document.body.style.pointerEvents).toBe(originalPointerEvents);
  await user.click(screen.getByRole("button", { name: "Open entries" }));
  expect(background).toHaveBeenCalledOnce();
});

it("keeps background input blocked when a nested menu closes before its sheet", async () => {
  const user = userEvent.setup(), background = vi.fn();
  function Surface() {
    const [open, setOpen] = useState(false);
    return <>
      <Button onClick={background}>Open entries</Button>
      <Button onClick={() => setOpen(true)}>Open source content</Button>
      <Sheet open={open} onOpenChange={setOpen} title="Source content" closeLabel="Close source content">
        <Menu label="Source actions" trigger={<Button>Source actions</Button>}
          items={[{ id: "inspect", label: "Inspect current source", onSelect: vi.fn() }]}/>
      </Sheet>
    </>;
  }
  render(<Surface/>);
  const entries = screen.getByRole("button", { name: "Open entries" });
  await user.click(screen.getByRole("button", { name: "Open source content" }));
  const sheet = await screen.findByRole("dialog", { name: "Source content" });
  await user.click(within(sheet).getByRole("button", { name: "Source actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Inspect current source" }));
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  expect(document.body.style.pointerEvents).toBe("none");
  await expect(user.click(entries)).rejects.toThrow(/pointer-events/);
  expect(background).not.toHaveBeenCalled();
  await user.click(within(sheet).getByRole("button", { name: "Close source content" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Source content" })).not.toBeInTheDocument());
  expect(document.body.style.pointerEvents).toBe(originalPointerEvents);
  await user.click(entries);
  expect(background).toHaveBeenCalledOnce();
});
