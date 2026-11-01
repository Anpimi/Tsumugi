import type { Meta, StoryObj } from "@storybook/react-vite";
import { Disclosure } from "./Disclosure";
import styles from "./Stories.module.css";

const meta = { title: "Design system/Disclosure", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = { render: () => <div className={styles.stack}>
  <Disclosure title="查看来源与上下文"><p>这条源文出现在丰收节的邀请函中。保留占位符 {'{{name}}'}，并根据角色语气调整称呼。</p></Disclosure>
  <Disclosure open title="Translation history and additional context"><p>The current translation was reviewed after the source text changed. Compare the earlier wording and the surrounding dialogue before deciding whether to update it.</p></Disclosure>
</div> };
