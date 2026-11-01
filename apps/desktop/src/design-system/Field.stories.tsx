import type { Meta, StoryObj } from "@storybook/react-vite";
import { Field, Select, TextArea, TextInput } from "./Field";
import styles from "./Stories.module.css";

const meta = { title: "Design system/Fields", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const TextInputs: Story = { render: () => <div className={styles.stack}>
  <Field label="项目名称" required description="使用一个方便查找的名称。"><TextInput defaultValue="鹈鹕镇 · 秋日来信" /></Field>
  <Field label="输出文件夹" error="该文件夹已被移走。请选择其他位置，已填写的设置会保留。"><TextInput defaultValue="…/projects/pelican-town/i18n" /></Field>
  <Field label="目标语言" description="运行结束后可以更改。"><TextInput defaultValue="简体中文（zh-CN）" disabled title="运行结束后可以更改" /></Field>
  <Field label="查找条目">{props => <TextInput {...props} type="search" placeholder="搜索源文、译文或 key…" />}</Field>
</div> };

export const Editor: Story = { render: () => <div className={styles.stack}>
  <Field label="译文" description="⌘↵ 确认并下一条。Esc 退出编辑，草稿保留。"><TextArea editor defaultValue={"欢迎回来，{{name}}！\n丰收节明天开始。请带上你想分享的收获，也记得给远方的朋友留一封信。"} rows={4} /></Field>
  <Field label="Source text"><TextArea editor readOnly defaultValue={"Welcome back, {{name}}!\nThe harvest festival begins tomorrow. Bring a harvest to share, and leave a letter for the friends who cannot join us."} rows={4} /></Field>
  <Field label="给团队的留言"><TextArea placeholder="输入消息，/ 调出命令，@ 指定成员…" /></Field>
</div> };

export const Selects: Story = { render: () => <div className={styles.stack}>
  <Field label="目标语言" required description="选择这次翻译的目标语言，之后仍可在项目设置中更改。"><Select defaultValue="zh-CN"><option value="zh-CN">简体中文（zh-CN）</option><option value="en-US">English (United States)</option></Select></Field>
  <Field label="输出格式" error="请选择与目标平台兼容的格式，当前选择不会修改已有文件。"><Select defaultValue=""><option value="">选择格式…</option><option value="json">JSON resource file</option></Select></Field>
  <Field label="Source language" description="The source language cannot be changed while this project is open."><Select defaultValue="en" disabled><option value="en">English (United States)</option></Select></Field>
</div> };
