import type { ComponentProps } from "react";
import { LoaderCircle } from "lucide-react";
import { cx } from "./cx";
import styles from "./Spinner.module.css";

export function Spinner({ label, className, ...props }: ComponentProps<"span"> & { label?: string }) {
  return (
    <span className={cx(styles.spinner, className)} role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} {...props}>
      <LoaderCircle size="100%" strokeWidth={1.75} />
    </span>
  );
}
