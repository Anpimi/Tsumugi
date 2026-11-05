import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ContentPage } from "../../../sourceCommands";
import { sourcePageFixture } from "../../../testSupport/sourceFixture";
import styles from "../../../design-system/Stories.module.css";
import SourceCaptureOverview from "./SourceCaptureOverview";

const page = sourcePageFixture();
const summary = { materials: [{
  source: { artifactId: page.coverage[0].artifactId, range: { encoding: "raw-byte", start: 0, end: 40 } },
  properties: [{ label: "Format", values: ["Synthetic captured records"] }, { label: "Dependencies", values: [] }],
  counts: { items: 10, itemsWithFields: 9, declaredFields: 14, nonEmptyFields: 13 },
  groups: [
    { label: "With declared text", counts: { items: 9, itemsWithFields: 9, declaredFields: 14, nonEmptyFields: 13 } },
    { label: "Without declared text", counts: { items: 1, itemsWithFields: 0, declaredFields: 0, nonEmptyFields: 0 } },
  ],
}] } satisfies NonNullable<ContentPage["captureSummary"]>;

const meta = {
  title: "Workbench/Source capture",
  component: SourceCaptureOverview,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className={styles.stack}><Story /></div>],
  args: { summary, coverage: page.coverage },
} satisfies Meta<typeof SourceCaptureOverview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CapturedScope: Story = {};
export const LongContent: Story = { args: {
  coverage: page.coverage.map(file => ({ ...file, logicalPath: "来源/安装变体/下一版/很长的来源文件名 — 👩🏽‍💻 — source with a long descriptive name.bin" })),
  summary: { materials: [{ ...summary.materials[0], properties: [
    ...summary.materials[0].properties,
    { label: "Literal publisher text", values: ["Synthetic <script>alert('literal')</script> — 世界", "Long metadata stays readable without changing the captured source or interpreting markup."] },
  ] }] },
} };
export const MissingSource: Story = { args: { coverage: [] } };
export const NoSummary: Story = { args: { summary: null } };
