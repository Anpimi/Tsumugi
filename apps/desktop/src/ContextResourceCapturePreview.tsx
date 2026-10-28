import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ContextOmission, ContextResourceCapture, ContextResourceScope } from "./resourceCommands";
import { Button } from "./design-system/Button";

export function ContextResourceScopeText({ scope }: { scope: ContextResourceScope }) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" });
  return <>{scope.kind === "project" ? t("projectScope") : scope.kind === "unit" ? t("entryScope") : <>{t("contextFilesCount", { count: scope.logicalPaths.length })}<ul>{scope.logicalPaths.map(path => <li key={path}>{path}</li>)}</ul>
    <details><summary>{t("contextSourceDetails")}</summary><p>{t("contextSourceNamespace")}: <code>{scope.namespace}</code></p></details></>}</>;
}

/** Only the actual captured material is shown; reading this component sends nothing. */
export function ContextResourceCapturePreview({ capture, mode = "capture" }: { capture: ContextResourceCapture | null | undefined; mode?: "capture" | "read" }) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" });
  if (!capture) return null;
  return <section aria-label={t("contextMaterial")}><h5>{t("contextMaterial")}</h5><p>{t(mode === "capture" ? "contextMaterialHelp" : "contextResolvedHelp")}</p>
    {capture.entries.map(entry => <article key={entry.revision.revisionId}>
      <h6>{t(`contextKinds.${entry.revision.kind}`)} · {entry.revision.name}</h6>
      <p>{t(entry.status === "selected" ? mode === "read" ? "contextApplicable" : "contextIncluded" : "contextExcluded")} · {t(`contextStatus.${entry.status}`)}</p>
      <pre className="ai-text">{entry.revision.text}</pre>
      {entry.missingPaths.length ? <><p>{t("contextMissingOtherFiles")}</p><ul>{entry.missingPaths.map(path => <li key={path}>{path}</li>)}</ul></> : null}
    </article>)}
    {capture.entries.length === 0 ? <p>{t(mode === "read" ? "contextNoApplicable" : "contextNoMaterial")}</p> : null}
  </section>;
}

export function ContextResourceOmissions({ items }: { items: readonly ContextOmission[] }) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" }), [diagnostics, setDiagnostics] = useState(false);
  const reasons = ["budget", "item-cap", "conflict", "withdrawn", "ambiguous", "missing-files"] as const;
  return <><ul>{items.map((item, index) => { const reason = reasons.find(value => value === item.reason);
    return <li key={index}>{item.kind === "context-resource" ? <>{item.label ?? t("contextUnnamed")} · {reason ? t(`contextOmission.${reason}`) : t("contextOmissionUnknown")}{diagnostics ? <code>{item.reference} · {item.reason}</code> : null}</> : <>{item.kind}: {item.reference} · {item.reason}</>}</li>;
  })}</ul>
    {items.some(item => item.kind === "context-resource") ? <Button onClick={() => setDiagnostics(value => !value)}>{t(diagnostics ? "contextHideReferences" : "contextShowReferences")}</Button> : null}</>;
}
