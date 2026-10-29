import { useId, useRef, type ComponentProps, type ReactElement, type ReactNode } from "react";
import * as Primitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { IconButton } from "./Button";
import { cx } from "./cx";
import styles from "./Dialog.module.css";

export type DialogProps = Pick<ComponentProps<typeof Primitive.Content>, "onOpenAutoFocus" | "onCloseAutoFocus" | "onEscapeKeyDown" | "onInteractOutside" | "onPointerDownOutside"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  closeLabel: string;
  closeDisabled?: boolean;
  trigger?: ReactElement;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
};

function DialogSurface({ open, onOpenChange, title, description, closeLabel, closeDisabled, trigger, children, footer, className, side, onOpenAutoFocus, onCloseAutoFocus, ...contentProps }: DialogProps & { side?: "left" | "right" }) {
  const descriptionId = useId();
  const previousFocus = useRef<HTMLElement | null>(null);
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Primitive.Trigger asChild>{trigger}</Primitive.Trigger> : null}
      <Primitive.Portal>
        <Primitive.Overlay className={styles.overlay} />
        <Primitive.Content {...contentProps} className={cx(styles.content, side ? styles.sheet : undefined, className)} data-side={side} aria-describedby={description ? descriptionId : undefined} onOpenAutoFocus={event => {
          previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          onOpenAutoFocus?.(event);
        }} onCloseAutoFocus={event => {
          onCloseAutoFocus?.(event);
          const activeElement = document.activeElement;
          const focusMovedOutside = activeElement !== document.body && event.target instanceof Node && activeElement !== null && !event.target.contains(activeElement);
          if (!event.defaultPrevented && !trigger && !focusMovedOutside && previousFocus.current?.isConnected) {
            event.preventDefault();
            previousFocus.current.focus();
          }
        }}>
          <header className={styles.header}>
            <div className={styles.heading}>
              <Primitive.Title className={styles.title}>{title}</Primitive.Title>
              {description ? <Primitive.Description id={descriptionId} className={styles.description}>{description}</Primitive.Description> : null}
            </div>
            <Primitive.Close asChild><IconButton label={closeLabel} disabled={closeDisabled}><X /></IconButton></Primitive.Close>
          </header>
          <div className={styles.body}>{children}</div>
          {footer ? <footer className={styles.footer}>{footer}</footer> : null}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

export function Dialog(props: DialogProps) {
  return <DialogSurface {...props} />;
}

export function Sheet({ side = "right", ...props }: DialogProps & { side?: "left" | "right" }) {
  return <DialogSurface {...props} side={side} />;
}
