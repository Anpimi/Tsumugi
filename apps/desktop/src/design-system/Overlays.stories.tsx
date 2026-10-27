import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";
import { CommandPalette } from "./CommandPalette";
import { Dialog, Sheet } from "./Dialog";
import { Field, TextArea } from "./Field";
import styles from "./Stories.module.css";

const meta = { title: "Design system/Overlays", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function DialogExample() {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen} title="停止翻译第 3 章？" description="已完成的候选会保留。正在处理的条目可能需要核对后才能继续。" closeLabel="关闭停止运行对话框" trigger={<Button variant="danger">停止运行…</Button>} footer={<><Button onClick={() => setOpen(false)}>继续运行</Button><Button variant="danger" onClick={() => setOpen(false)}>停止运行</Button></>}><p className={styles.body}>你可以稍后从运行记录继续处理剩余条目。</p></Dialog>;
}

function SheetExample() {
  const [open, setOpen] = useState(false);
  return <><Button onClick={() => setOpen(true)}>打开 Agent</Button><Sheet open={open} onOpenChange={setOpen} title="Agent" description="本地化负责人" closeLabel="关闭 Agent 面板"><div className={styles.stack}><p className={styles.body}>第 3 章还有 17 条需要复查。源文已经更新，已确认的译文和你的草稿都保留了。</p><Field label="给团队的留言"><TextArea rows={4} placeholder="输入消息，/ 调出命令，@ 指定成员…" /></Field><Button variant="secondary" onClick={() => setOpen(false)}>返回条目</Button></div></Sheet></>;
}

function CommandExample() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("尚未选择命令");
  return <div className={styles.stack}><Button onClick={() => setOpen(true)} kbd="⌘K">搜索或执行命令…</Button><p className={styles.body}>{selected}</p><CommandPalette open={open} onOpenChange={setOpen} title="搜索或执行命令" placeholder="输入命令或条目内容…" emptyLabel="没有找到匹配的命令。试试“确认”或“导出”。" closeLabel="关闭命令搜索" groups={[
    { label: "条目", commands: [{ id: "confirm", label: "确认并下一条", kbd: "⌘↵", keywords: ["confirm", "next"], onSelect: () => setSelected("已选择：确认并下一条") }, { id: "history", label: "查看当前条目的历史", onSelect: () => setSelected("已选择：查看历史") }] },
    { label: "交付", commands: [{ id: "export", label: "导出 zh-CN", disabled: true, onSelect: () => setSelected("已选择：导出") }] },
  ]} /></div>;
}

export const Confirmation: Story = { render: () => <DialogExample /> };
export const SideSheet: Story = { render: () => <SheetExample /> };
export const Commands: Story = { render: () => <CommandExample /> };
