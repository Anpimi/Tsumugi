import type { ComponentProps, CSSProperties } from "react";
import { cx } from "./cx";
import styles from "./ProgressBar.module.css";

type ProgressBarProps = Omit<ComponentProps<"div">, "children"> & {
  label: string;
  value?: number;
  max?: number;
  indeterminate?: boolean;
  tone?: "accent" | "ai";
};

export function ProgressBar({ label, value, max = 100, indeterminate = value === undefined, tone = "accent", className, style, ...props }: ProgressBarProps) {
  const validMax = Number.isFinite(max) && max > 0 ? max : 100;
  const boundedValue = value !== undefined && Number.isFinite(value) ? Math.min(validMax, Math.max(0, value)) : 0;
  const progressStyle: CSSProperties & { "--progress-value": string } = { ...style, "--progress-value": `${boundedValue / validMax * 100}%` };
  return (
    <div {...props} className={cx(styles.track, className)} style={progressStyle} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={validMax} aria-valuenow={indeterminate ? undefined : boundedValue} data-indeterminate={indeterminate || undefined} data-tone={tone}>
      <div className={styles.fill} />
    </div>
  );
}
