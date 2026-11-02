import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { composeStory } from "@storybook/react-vite";
import meta, { Selects } from "./Field.stories";

const Examples = composeStory(Selects, meta);

afterEach(cleanup);

it("exposes the required, error and disabled select examples with their field descriptions", () => {
  render(<Examples />);
  const target = screen.getByRole("combobox", { name: "目标语言" });
  expect(target).toBeRequired();
  expect(target).toHaveValue("zh-CN");
  expect(target).toHaveAccessibleDescription("选择这次翻译的目标语言，之后仍可在项目设置中更改。");
  const format = screen.getByRole("combobox", { name: "输出格式" });
  expect(format).toHaveAttribute("aria-invalid", "true");
  expect(format).toHaveAccessibleDescription("请选择与目标平台兼容的格式，当前选择不会修改已有文件。");
  const source = screen.getByRole("combobox", { name: "Source language" });
  expect(source).toBeDisabled();
  expect(source).toHaveValue("en");
});

it("keeps select values and skips the disabled field while moving keyboard focus", async () => {
  const user = userEvent.setup();
  const view = render(<><Examples /><button>Continue</button></>);
  const target = screen.getByRole("combobox", { name: "目标语言" });
  const format = screen.getByRole("combobox", { name: "输出格式" });
  await user.tab();
  expect(target).toHaveFocus();
  await user.selectOptions(target, "en-US");
  await user.tab();
  expect(format).toHaveFocus();
  await user.selectOptions(format, "json");
  await user.tab();
  expect(screen.getByRole("button", { name: "Continue" })).toHaveFocus();
  view.rerender(<><Examples /><button>Continue</button></>);
  expect(target).toHaveValue("en-US");
  expect(format).toHaveValue("json");
  await user.tab({ shift: true });
  expect(format).toHaveFocus();
});
