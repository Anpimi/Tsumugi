import { useTranslation } from "react-i18next";
import type { ExecutionOutputView } from "./executionCommands";

export function ExecutionDiagnosticDetails({ code, sourceFailure }: {
  code?: string | null;
  sourceFailure?: ExecutionOutputView["sourceFailure"];
}) {
  const { t } = useTranslation();
  if (!code && !sourceFailure) return null;
  return <details><summary>{t("execution.diagnostic")}</summary>
    {code ? <code>{code}</code> : null}
    {sourceFailure ? <>
      <p><code>{sourceFailure.code}</code>: {sourceFailure.detail}</p>
      {sourceFailure.artifactId ? <p><code>{sourceFailure.artifactId}</code></p> : null}
    </> : null}
  </details>;
}
