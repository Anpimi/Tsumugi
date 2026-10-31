import type { ComponentProps, ReactNode } from "react";
import { Kbd } from "./Kbd";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";
import { cx } from "./cx";
import styles from "./Button.module.css";

export type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "link";
  size?: "xs" | "sm" | "md" | "lg";
  pending?: boolean;
  icon?: ReactNode;
  kbd?: ReactNode;
};

export function Button({ variant = "ghost", size = "md", pending = false, icon, kbd, className, children, disabled, type = "button", ...props }: ButtonProps) {
  return (
    <button {...props} type={type} disabled={disabled || pending} aria-busy={pending || undefined} data-variant={variant} data-size={size} className={cx(styles.button, className)}>
      {pending ? <Spinner /> : icon ? <span className={styles.icon} aria-hidden="true">{icon}</span> : null}
      {children}
      {kbd ? <Kbd className={styles.kbd}>{kbd}</Kbd> : null}
    </button>
  );
}

export type IconButtonProps = Omit<ButtonProps, "kbd" | "aria-label"> & {
  label: string;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  tooltip?: boolean;
};

export function IconButton({ label, tooltipSide, tooltip = true, size = "sm", className, disabled, pending, ...props }: IconButtonProps) {
  const blocked = disabled || pending;
  const button = <Button {...props} size={size} disabled={disabled} pending={pending} aria-label={label} aria-hidden={blocked || undefined} tabIndex={blocked ? -1 : props.tabIndex} title={props.title ?? (disabled ? label : undefined)} className={cx(styles.iconButton, className)} />;
  const trigger = blocked ? <span className={styles.disabledTrigger} tabIndex={0} role="button" aria-disabled="true" aria-label={label}>{button}</span> : button;
  return tooltip ? <Tooltip content={props.title ?? label} side={tooltipSide}>{trigger}</Tooltip> : trigger;
}
