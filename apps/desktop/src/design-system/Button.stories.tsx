import type { Meta, StoryObj } from "@storybook/react-vite";
import { Check, MoreHorizontal, Pause, X } from "lucide-react";
import { Button, IconButton } from "./Button";
import { Kbd } from "./Kbd";
import styles from "./Stories.module.css";

const meta = { title: "Design system/Buttons", component: Button, parameters: { layout: "padded" } } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = { render: () => <div className={styles.stack}>
  <div className={styles.row}><Button variant="primary" kbd="⌘↵">确认并下一条</Button><Button variant="secondary">调整范围</Button><Button>稍后决定</Button><Button variant="danger">停止运行</Button><Button variant="link">查看历史</Button></div>
  <div className={styles.row}><Button size="xs">复制</Button><Button size="sm">筛选</Button><Button size="md">采用候选</Button><Button size="lg" variant="secondary">导入源文件…</Button></div>
</div> };

export const PendingAndDisabled: Story = { render: () => <div className={styles.stack}>
  <div className={styles.row}><Button variant="primary" pending>正在确认…</Button><Button pending>正在核对是否已保存…</Button><Button disabled title="请先选择要导出的语言">导出文件</Button></div>
  <Button variant="secondary">Review the translation and preserve the changes made after confirmation started</Button>
</div> };

export const IconActions: Story = { render: () => <div className={styles.row}><IconButton label="确认当前译文"><Check /></IconButton><IconButton label="暂停运行"><Pause /></IconButton><IconButton label="更多操作"><MoreHorizontal /></IconButton><IconButton label="当前没有候选可拒绝" disabled><X /></IconButton><IconButton label="正在拒绝候选…" pending><X /></IconButton></div> };

export const KeyboardHints: Story = { render: () => <div className={styles.row}><Kbd>⌘↵</Kbd><Kbd>Esc</Kbd><Kbd>Ctrl + Shift + Enter</Kbd></div> };
