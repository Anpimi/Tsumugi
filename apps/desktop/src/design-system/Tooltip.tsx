import type { ReactElement, ReactNode } from "react";
import * as Primitive from "@radix-ui/react-tooltip";
import styles from "./Tooltip.module.css";

export const TooltipProvider = Primitive.Provider;

export function Tooltip({ children, content, side = "top", delayDuration = 500 }: {
  children: ReactElement;
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayDuration?: number;
}) {
  return (
    <Primitive.Provider delayDuration={delayDuration}>
      <Primitive.Root>
        <Primitive.Trigger asChild>{children}</Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content className={styles.content} side={side} sideOffset={6} collisionPadding={12}>
            {content}
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </Primitive.Provider>
  );
}
