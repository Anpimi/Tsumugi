import type { Meta, StoryObj } from "@storybook/react-vite";
import { MoreHorizontal } from "lucide-react";
import { Button, IconButton } from "./Button";
import { ContextMenu, Menu } from "./Menu";
import { Tabs } from "./Tabs";
import { Tooltip } from "./Tooltip";
import styles from "./Stories.module.css";

const meta = { title: "Design system/Navigation", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const DetailTabs: Story = { render: () => <Tabs label="条目详情" defaultValue="details" items={[
  { value: "details", label: "详情", content: <div className={styles.panel}>源文已更新。当前译文保留，确认前请对照检查。</div> },
  { value: "terms", label: "术语与上下文", content: <div className={styles.panel}>Pelican Town → 鹈鹕镇</div> },
  { value: "candidates", label: "候选", content: <div className={styles.panel}>候选尚未采用。采用后可以继续修改，再确认译文。</div> },
  { value: "history", label: "历史", content: <div className={styles.panel}>暂无历史记录。</div> },
  { value: "issues", label: "问题", disabled: true, content: null },
]} /> };

const items = [
  { id: "confirm", label: "确认并下一条", kbd: "⌘↵" },
  { id: "compare", label: "对比上一版本" },
  { id: "history", label: "查看历史" },
  { id: "separator", type: "separator" as const },
  { id: "export", label: "导出选中条目…", disabled: true },
  { id: "reject", label: "拒绝这个候选", danger: true },
];

export const ActionMenu: Story = { render: () => <Menu label="条目操作" trigger={<IconButton label="更多条目操作"><MoreHorizontal /></IconButton>} items={items} /> };

export const RowContextMenu: Story = { render: () => <ContextMenu label="条目操作" items={items}><div className={styles.contextTarget} tabIndex={0}>欢迎回来，&#123;&#123;name&#125;&#125;！右键或按菜单键查看操作。</div></ContextMenu> };

export const SupplementalTooltip: Story = { render: () => <Tooltip content="检查当前源文、已确认的译文和阻止交付的问题。检查不会写入项目。"><Button>检查是否可交付</Button></Tooltip> };
