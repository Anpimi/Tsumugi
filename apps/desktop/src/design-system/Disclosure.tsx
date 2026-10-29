import type { ComponentProps, ReactNode } from "react";

/** Native keyboard and accessibility behavior, shared by feature disclosures. */
export function Disclosure({ title, children, ...props }: Omit<ComponentProps<"details">, "title"> & { title: ReactNode }) {
  return <details {...props}><summary>{title}</summary>{children}</details>;
}
