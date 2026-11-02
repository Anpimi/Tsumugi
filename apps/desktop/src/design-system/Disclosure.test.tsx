import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { composeStory } from "@storybook/react-vite";
import meta, { States } from "./Disclosure.stories";

const Examples = composeStory(States, meta);

afterEach(cleanup);

it("keeps each native disclosure independent and preserves its content across toggles", async () => {
  const user = userEvent.setup();
  const { container } = render(<Examples />);
  const [closed, open] = Array.from(container.querySelectorAll("details"));
  expect(closed).not.toHaveAttribute("open");
  expect(open).toHaveAttribute("open");
  const originalContent = closed.textContent;
  await user.click(screen.getByText("查看来源与上下文"));
  expect(closed).toHaveAttribute("open");
  expect(open).toHaveAttribute("open");
  await user.click(screen.getByText("Translation history and additional context"));
  expect(open).not.toHaveAttribute("open");
  expect(closed).toHaveAttribute("open");
  await user.click(screen.getByText("查看来源与上下文"));
  expect(closed).not.toHaveAttribute("open");
  expect(closed.textContent).toBe(originalContent);
  expect(closed.textContent).toContain("{{name}}");
});
