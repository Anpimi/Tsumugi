import type { ComponentProps } from "react";
import { cx } from "./cx";
import styles from "./Kbd.module.css";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return <kbd className={cx(styles.kbd, className)} {...props} />;
}
