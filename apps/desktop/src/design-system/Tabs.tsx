import type { ComponentProps, ReactNode } from "react";
import * as Primitive from "@radix-ui/react-tabs";
import { cx } from "./cx";
import styles from "./Tabs.module.css";

export function TabsRoot({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root {...props} className={cx(styles.root, className)} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof Primitive.List>) {
  return <Primitive.List {...props} className={cx(styles.list, className)} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return <Primitive.Trigger {...props} className={cx(styles.trigger, className)} />;
}

export function TabsContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Content {...props} className={cx(styles.content, className)} />;
}

export type TabItem = { value: string; label: ReactNode; content: ReactNode; disabled?: boolean };

export function Tabs({ items, label, ...props }: Omit<ComponentProps<typeof Primitive.Root>, "children"> & { items: TabItem[]; label: string }) {
  return (
    <TabsRoot {...props}>
      <TabsList aria-label={label}>
        {items.map(item => <TabsTrigger key={item.value} value={item.value} disabled={item.disabled}>{item.label}</TabsTrigger>)}
      </TabsList>
      {items.map(item => <TabsContent key={item.value} value={item.value}>{item.content}</TabsContent>)}
    </TabsRoot>
  );
}
