import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkbenchPreview } from "./WorkbenchPreview";

const meta = {
  title: "Workbench/Workspaces",
  component: WorkbenchPreview,
  argTypes: {
    screen: { control: "select", options: ["entries", "decisions", "delivery", "runs"] },
    state: { control: "select", options: ["normal", "empty", "loading", "error", "conflict", "pending", "unknown"] },
  },
  render: (args) => <WorkbenchPreview key={`${args.screen}-${args.state}`} {...args} />,
} satisfies Meta<typeof WorkbenchPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EntriesAndAgent: Story = { args: { screen: "entries", state: "normal" } };
export const YourDecisions: Story = { args: { screen: "decisions" } };
export const Delivery: Story = { args: { screen: "delivery" } };
export const RunDocument: Story = { args: { screen: "runs" } };
export const Empty: Story = { args: { screen: "entries", state: "empty" } };
export const Loading: Story = { args: { screen: "entries", state: "loading" } };
export const ReadError: Story = { args: { screen: "entries", state: "error" } };
export const SourceConflict: Story = { args: { screen: "entries", state: "conflict" } };
export const ConfirmationPending: Story = { args: { screen: "entries", state: "pending" } };
export const ConfirmationToCheck: Story = { args: { screen: "entries", state: "unknown" } };
