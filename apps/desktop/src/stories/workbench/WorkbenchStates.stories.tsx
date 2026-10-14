import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkbenchStates } from "./WorkbenchStates";

const meta = { title: "Workbench/States", component: WorkbenchStates,
  render: args => <WorkbenchStates key={`${args.view}:${args.state}`} {...args} />,
  args: { view: "editor", state: "ready", theme: "light", locale: "zh-CN", scale: 1 },
  argTypes: { view: { control: "select", options: ["editor", "delivery", "plugins"] },
    state: { control: "select", options: ["ready", "empty", "no-results", "loading", "error", "denied", "dirty", "saving", "conflict", "unknown", "partial"] },
    theme: { control: "select", options: ["light", "dark"] }, locale: { control: "select", options: ["zh-CN", "en-US"] }, scale: { control: "select", options: [1, 2] } },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WorkbenchStates>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EditorReady: Story = {};
export const EditorDirty: Story = { args: { state: "dirty" } };
export const EditorError: Story = { args: { state: "error" } };
export const EditorLoading: Story = { args: { state: "loading" } };
export const EditorEmpty: Story = { args: { state: "empty" } };
export const EditorNoResults: Story = { args: { state: "no-results" } };
export const EditorSaving: Story = { args: { state: "saving" } };
export const EditorConflict: Story = { args: { state: "conflict" } };
export const EditorUnknown: Story = { args: { state: "unknown" } };
export const EditorDark: Story = { args: { state: "dirty", theme: "dark" } };
export const EditorLargeText: Story = { args: { state: "dirty", scale: 2 } };
export const DeliveryReady: Story = { args: { view: "delivery" } };
export const DeliveryBlocked: Story = { args: { view: "delivery", state: "conflict" } };
export const DeliveryPartial: Story = { args: { view: "delivery", state: "partial" } };
export const DeliveryUnknown: Story = { args: { view: "delivery", state: "unknown" } };
export const DeliveryLoading: Story = { args: { view: "delivery", state: "loading" } };
export const DeliveryDark: Story = { args: { view: "delivery", state: "conflict", theme: "dark" } };
export const PluginsReady: Story = { args: { view: "plugins" } };
export const PluginsDenied: Story = { args: { view: "plugins", state: "denied" } };
export const PluginsLoading: Story = { args: { view: "plugins", state: "loading" } };
export const PluginsError: Story = { args: { view: "plugins", state: "error" } };
export const PluginsDirty: Story = { args: { view: "plugins", state: "dirty" } };
export const PluginsDark: Story = { args: { view: "plugins", theme: "dark" } };
