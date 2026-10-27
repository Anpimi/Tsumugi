import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";
import { Banner, EmptyState, ErrorState, LoadingState } from "./Feedback";
import styles from "./Stories.module.css";

const meta = { title: "Design system/Feedback", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Messages: Story = { render: () => <div className={styles.stack}>
  <Banner tone="info">样例内容。这里的操作不会修改项目或调用模型。</Banner>
  <Banner tone="success">文件已导出。你可以在输出文件夹中查看。</Banner>
  <Banner tone="warning" action={<Button size="sm">对比版本</Button>}>源文已更新。你的草稿已保留，请对照后再确认。</Banner>
  <Banner tone="error" action={<Button size="sm">核对</Button>}>无法确认是否已保存。新的输入已保留，请先核对这次操作的结果。</Banner>
</div> };

export const Empty: Story = { render: () => <EmptyState title="没有待你决定的事项" description="新的术语提议和需要你检查的候选会出现在这里。" action={<Button variant="secondary">返回条目</Button>} /> };
export const Error: Story = { render: () => <ErrorState title="暂时无法读取条目" description="已输入的译文仍然保留。检查连接后重试，或先返回其他视图。" action={<Button variant="secondary">重试读取</Button>} /> };
export const Loading: Story = { render: () => <LoadingState label="正在读取条目…" description="这可能需要几秒。你可以继续查看已打开的内容。" action={<Button>返回已打开的内容</Button>} /> };
