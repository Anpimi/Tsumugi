import { Group, Panel, Separator, type GroupProps, type PanelProps, type SeparatorProps } from "react-resizable-panels";
import { cx } from "./cx";
import styles from "./SplitView.module.css";

export function SplitView({ className, orientation = "horizontal", ...props }: GroupProps) {
  return <Group {...props} orientation={orientation} className={cx(styles.group, className)} />;
}

export function SplitPanel({ className, ...props }: PanelProps) {
  return <Panel {...props} className={cx(styles.panel, className)} />;
}

export function SplitHandle({ label, className, ...props }: SeparatorProps & { label: string }) {
  return <Separator {...props} aria-label={label} className={cx(styles.handle, className)} />;
}
