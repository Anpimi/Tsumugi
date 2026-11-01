import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import styles from "./ConversationPanel.module.css";

/** Plain completed text only: model text is never interpreted as UI or navigation. */
export function ConversationText({ text }: { text: string }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const [expanded, setExpanded] = useState(false), [overflowing, setOverflowing] = useState(false);
  const [copyState, setCopyState] = useState<{ text: string; kind: "copied" | "failed" } | null>(null);
  const body = useRef<HTMLParagraphElement>(null), mounted = useRef(false), id = useId();
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setOverflowing(text.split("\n").length > 6 || Number.isFinite(lineHeight) && element.scrollHeight > lineHeight * 6 + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  async function copy() {
    try { await navigator.clipboard.writeText(text); if (mounted.current) setCopyState({ text, kind: "copied" }); }
    catch { if (mounted.current) setCopyState({ text, kind: "failed" }); }
  }
  return <div>
    <p id={id} ref={body} className={`${styles.text} ${expanded ? "" : styles.collapsedText}`}>{text}</p>
    <div className={styles.actions}>
      {overflowing ? <Button size="sm" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{t(expanded ? "textCollapse" : "textExpand")}</Button> : null}
      <Button size="sm" onClick={() => void copy()}>{t("textCopy")}</Button>
      {copyState?.text === text ? <span role="status">{t(copyState.kind === "copied" ? "textCopied" : "textCopyFailed")}</span> : null}
    </div>
  </div>;
}
