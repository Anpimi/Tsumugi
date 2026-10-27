import type { ComponentProps } from "react";
import { cx } from "./cx";
import styles from "./TokenizedText.module.css";

export type TextToken = { kind: "text" | "placeholder" | "tag" | "newline"; text: string };

// Decoration only: every match retains the exact original characters, including CRLF.
export function tokenizeText(text: string): TextToken[] {
  const pattern = /(\{\{[^{}\r\n]+\}\}|\$\{[^{}\r\n]+\}|\{[A-Za-z_][\w.:-]*\}|<\/?[A-Za-z][^<>\r\n]*>|\r\n|\r|\n)/g;
  const tokens: TextToken[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > offset) tokens.push({ kind: "text", text: text.slice(offset, start) });
    const value = match[0];
    const kind = value === "\r\n" || value === "\r" || value === "\n" ? "newline" : value.startsWith("<") ? "tag" : "placeholder";
    tokens.push({ kind, text: value });
    offset = start + value.length;
  }
  if (offset < text.length) tokens.push({ kind: "text", text: text.slice(offset) });
  return tokens;
}

export function TokenizedText({ text, tone, className, ...props }: Omit<ComponentProps<"span">, "children"> & { text: string; tone?: "default" | "ai" }) {
  const parts = tokenizeText(text);
  return <span {...props} className={cx(styles.text, className)} data-tone={tone}>{parts.map((token, index) => token.kind === "text" ? token.text : <span key={index} className={styles[token.kind]}>{token.text}</span>)}</span>;
}
