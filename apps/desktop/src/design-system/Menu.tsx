import type { ReactElement, ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as Context from "@radix-ui/react-context-menu";
import { Kbd } from "./Kbd";
import styles from "./Menu.module.css";

export type MenuAction = {
  id: string;
  type?: "item";
  label: string;
  icon?: ReactNode;
  kbd?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
};
export type MenuEntry = MenuAction | { id: string; type: "separator" };

function ActionContent({ item }: { item: MenuAction }) {
  return <>{item.icon ? <span className={styles.icon} aria-hidden="true">{item.icon}</span> : null}<span className={styles.label}>{item.label}</span>{item.kbd ? <Kbd>{item.kbd}</Kbd> : null}</>;
}

export function Menu({ trigger, items, label, align = "end" }: { trigger: ReactElement; items: MenuEntry[]; label?: string; align?: "start" | "center" | "end" }) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={styles.content} aria-label={label} align={align} sideOffset={4} collisionPadding={12}>
          {items.map(item => item.type === "separator" ? <Dropdown.Separator key={item.id} className={styles.separator} /> : <Dropdown.Item key={item.id} className={styles.item} data-danger={item.danger || undefined} disabled={item.disabled} onSelect={item.onSelect}><ActionContent item={item} /></Dropdown.Item>)}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function ContextMenu({ children, items, label }: { children: ReactElement; items: MenuEntry[]; label?: string }) {
  return (
    <Context.Root>
      <Context.Trigger asChild>{children}</Context.Trigger>
      <Context.Portal>
        <Context.Content className={styles.content} aria-label={label} collisionPadding={12}>
          {items.map(item => item.type === "separator" ? <Context.Separator key={item.id} className={styles.separator} /> : <Context.Item key={item.id} className={styles.item} data-danger={item.danger || undefined} disabled={item.disabled} onSelect={item.onSelect}><ActionContent item={item} /></Context.Item>)}
        </Context.Content>
      </Context.Portal>
    </Context.Root>
  );
}
