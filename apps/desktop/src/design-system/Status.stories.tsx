import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "./Badge";
import { ProgressBar } from "./ProgressBar";
import { Spinner } from "./Spinner";
import { StatusGlyph, type StatusGlyphState } from "./StatusGlyph";
import { TokenizedText } from "./TokenizedText";
import styles from "./Stories.module.css";

const meta = { title: "Design system/Status and text", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const states: { state: StatusGlyphState; label: string }[] = [
  { state: "untranslated", label: "未翻译" }, { state: "draft", label: "有未确认的草稿" },
  { state: "candidate", label: "有 AI 候选待决定" }, { state: "translated", label: "已有译文，尚未审阅" },
  { state: "reviewed", label: "已审阅通过" }, { state: "stale", label: "需复查：源文已更新" },
  { state: "blocked", label: "无法交付：译文缺少 {{count}} 占位符" },
];

export const TranslationStates: Story = { render: () => <ul className={styles.list}>{states.map(item => <li key={item.state} className={styles.status}><StatusGlyph state={item.state} label={item.label} /><span>{item.label}</span></li>)}<li className={styles.status}><StatusGlyph state="reviewed" label="已审阅通过" protected protectedLabel="已受人工保护，AI 不能改写" /><span>已审阅并受人工保护</span></li></ul> };

export const Badges: Story = { render: () => <div className={styles.row}><Badge kind="count" aria-label="5 项待你决定">5</Badge><Badge tone="ai">AI 候选</Badge><Badge tone="success">已完成</Badge><Badge tone="warning">等待核对</Badge><Badge tone="danger">需要处理</Badge></div> };

export const Progress: Story = { render: () => <div className={styles.stack}><div className={styles.group}><p className={styles.label}>142 / 312 条</p><ProgressBar label="翻译第 3 章" value={142} max={312} tone="ai" /></div><div className={styles.group}><p className={styles.label}>正在检查是否可交付…</p><ProgressBar label="正在检查是否可交付" indeterminate /></div><div className={styles.row}><Spinner label="正在同步…" /><span>正在同步…</span></div></div> };

export const ExactText: Story = { render: () => <div className={styles.stack}><p className={styles.editor}><TokenizedText text={"Welcome back, {{name}}!\r\n<color=blue>The festival begins tomorrow.</color>\nYou have {count} letters. Café · 👩🏽‍🌾 · שלום"} /></p><p className={styles.editor}><TokenizedText tone="ai" text={"欢迎回来，{{name}}！\n<color=blue>丰收节明天开始。</color>\n你收到 {count} 封信。"} /></p></div> };
