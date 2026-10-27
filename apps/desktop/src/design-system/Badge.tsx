import type { ComponentProps } from "react";
import { cx } from "./cx";
import styles from "./Badge.module.css";

export function Badge({ tone = "neutral", kind = "label", className, ...props }: ComponentProps<"span"> & { tone?: "neutral" | "ai" | "success" | "warning" | "danger"; kind?: "label" | "count" }) {
  return <span {...props} data-tone={tone} data-kind={kind} className={cx(styles.badge, className)} />;
}
