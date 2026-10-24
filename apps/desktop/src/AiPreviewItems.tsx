import { useTranslation } from "react-i18next";
import { ProjectFactPreview, SourceContextPreview } from "./SourceContextPreparation";
import type { AiItem } from "./aiCommands";

/** Render captured inputs only; destinations must use their own Core preview. */
export function AiPreviewItems({ items }: { items: readonly AiItem[] }) {
  const { t } = useTranslation();
  return <>{items.map(item => <article key={item.unitId}><h4>{item.nativeKey} → {item.targetLocale}</h4><pre className="ai-text">{item.sourceText}</pre>
    {item.terms.map(term => <p key={term.revisionId}>{term.source} → {term.target}</p>)}
    {item.context ? <pre className="ai-text">{item.context.text}</pre> : null}
    <SourceContextPreview capture={item.sourceContext}/><ProjectFactPreview capture={item.projectContext}/>
    {item.omissions.map(reason => <p key={reason}>{reason.startsWith("term-conflict:") ? t("ai.termConflict", { term: reason.slice(14) }) : t(`ai.${reason}`, { defaultValue: reason })}</p>)}
  </article>)}</>;
}
