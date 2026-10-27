import type { ComponentProps, ReactNode } from "react";
import { AlertCircle, CheckCircle2, CircleAlert, FileQuestion, Info } from "lucide-react";
import { Spinner } from "./Spinner";
import { cx } from "./cx";
import styles from "./Feedback.module.css";

export { Badge } from "./Badge";
export { Kbd } from "./Kbd";
export { ProgressBar } from "./ProgressBar";
export { Spinner } from "./Spinner";

export type MessageTone = "info" | "success" | "warning" | "error";
const toneIcons = { info: Info, success: CheckCircle2, warning: CircleAlert, error: AlertCircle };

export function Banner({ tone = "info", children, action, className, ...props }: ComponentProps<"div"> & { tone?: MessageTone; action?: ReactNode }) {
  const Icon = toneIcons[tone];
  return (
    <div {...props} className={cx(styles.banner, className)} data-tone={tone}>
      <Icon className={styles.icon} strokeWidth={1.75} aria-hidden="true" />
      <div className={styles.message}>{children}</div>
      {action ? <div className={styles.actions}>{action}</div> : null}
    </div>
  );
}

export type ViewStateProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, action, className, icon = <FileQuestion /> }: ViewStateProps & { icon?: ReactNode }) {
  return <div className={cx(styles.state, className)}><span className={styles.emptyIcon} aria-hidden="true">{icon}</span><h2 className={styles.title}>{title}</h2>{description ? <p className={styles.description}>{description}</p> : null}{action}</div>;
}

export function ErrorState({ title, description, action, className }: ViewStateProps) {
  return <div className={cx(styles.state, className)}><AlertCircle className={cx(styles.emptyIcon, styles.errorIcon)} strokeWidth={1.75} aria-hidden="true" /><h2 className={styles.title}>{title}</h2>{description ? <p className={styles.description}>{description}</p> : null}{action}</div>;
}

export function LoadingState({ title, label, description, action, className }: Omit<ViewStateProps, "title"> & ({ label: string; title?: string } | { label?: string; title: string })) {
  return <div className={cx(styles.state, className)} role="status"><Spinner /><p className={styles.loadingTitle}>{label ?? title}</p>{description ? <p className={styles.description}>{description}</p> : null}{action}</div>;
}
