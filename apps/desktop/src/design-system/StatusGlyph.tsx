import { Check, Circle, LockKeyhole, Sparkle, Square, Triangle } from "lucide-react";
import { Tooltip } from "./Tooltip";
import { cx } from "./cx";
import styles from "./StatusGlyph.module.css";

export type StatusGlyphState = "untranslated" | "draft" | "candidate" | "translated" | "reviewed" | "stale" | "blocked";
type StatusGlyphProps = {
  state: StatusGlyphState;
  label: string;
  protected?: boolean;
  protectedLabel?: string;
  className?: string;
};

const icons = { untranslated: Circle, draft: Circle, candidate: Sparkle, translated: Circle, reviewed: Check, stale: Triangle, blocked: Square };

/** Displays a caller-owned status; it does not infer domain state or precedence. */
export function StatusGlyph({ state, label, protected: isProtected = false, protectedLabel, className }: StatusGlyphProps) {
  const Icon = icons[state];
  return (
    <span className={cx(styles.group, className)}>
      <Tooltip content={label}>
        <span className={styles.glyph} data-state={state} role="img" aria-label={label} tabIndex={0}>
          <Icon size="100%" strokeWidth={1.75} aria-hidden="true" />
          {state === "draft" ? <Circle className={styles.half} size="100%" strokeWidth={1.75} aria-hidden="true" /> : null}
        </span>
      </Tooltip>
      {isProtected ? <Tooltip content={protectedLabel ?? label}><span className={styles.protected} role="img" aria-label={protectedLabel ?? label} tabIndex={0}><LockKeyhole size="100%" strokeWidth={1.75} aria-hidden="true" /></span></Tooltip> : null}
    </span>
  );
}
