import type { Meta, StoryObj } from "@storybook/react-vite";
import { SplitHandle, SplitPanel, SplitView } from "./SplitView";
import styles from "./Stories.module.css";

const meta = { title: "Design system/Split view", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = { render: () => <div className={styles.split}><SplitView orientation="horizontal"><SplitPanel id="content" defaultSize="65%" minSize="35%"><div className={styles.panel}>Welcome back, &#123;&#123;name&#125;&#125;!<p>欢迎回来，&#123;&#123;name&#125;&#125;！</p></div></SplitPanel><SplitHandle label="调整主区和 Agent 面板宽度" /><SplitPanel id="agent" minSize="25%"><div className={styles.panel}>Agent<p>源文已更新。请检查保留的译文。</p></div></SplitPanel></SplitView></div> };
export const Vertical: Story = { render: () => <div className={styles.split}><SplitView orientation="vertical"><SplitPanel id="agent" defaultSize="60%" minSize="25%"><div className={styles.panel}>Agent · 第 3 章翻译</div></SplitPanel><SplitHandle label="调整 Agent 和详情面板高度" /><SplitPanel id="details" minSize="25%"><div className={styles.panel}>详情 · 人工保护已开启</div></SplitPanel></SplitView></div> };
