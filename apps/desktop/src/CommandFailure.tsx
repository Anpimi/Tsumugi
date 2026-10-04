import { useTranslation } from "react-i18next";
import { isCommandError, type CommandError } from "./projectCommands";

export type CommandFailure = CommandError | string;

/** Keep the decoded error as the same notice used for recovery and diagnostics. */
export function commandFailure(value: unknown, fallback = "failed"): CommandFailure {
  if (isCommandError(value)) return value;
  const error = value as Partial<CommandError> | null;
  if (error?.code === "outcome-unknown") return error.code;
  return typeof error?.reason === "string" ? error.reason : typeof error?.field === "string" ? error.field
    : typeof error?.code === "string" ? error.code : fallback;
}

export function failureReason(value: CommandFailure | null): string | null {
  return typeof value === "string" ? value : value?.code === "outcome-unknown" ? value.code : value?.reason ?? value?.field ?? value?.code ?? null;
}

export function CommandFailureDetails({ failure }: { failure: CommandFailure | null }) {
  const { t } = useTranslation();
  if (!failure || typeof failure === "string") return null;
  const conflict = failure.conflict;
  return <>
    {failure.recoveryGuidance ? <p>{t(`commandError.recovery.${failure.recoveryGuidance}`)}</p> : null}
    <details><summary>{t("execution.diagnostic")}</summary>
      {failure.diagnosticId ? <p>{t("commandError.diagnosticId")} <code>{failure.diagnosticId}</code></p> : null}
      <p>{t("commandError.classification", { code: failure.code, stage: failure.stage, outcome: failure.outcome })}</p>
      {failure.currentRevision ? <p>{t("commandError.currentRevision", { revision: failure.currentRevision })}</p> : null}
      {conflict ? <div><p>{t(`commandError.conflict.${conflict.kind}`)}</p>
        <p>{t("commandError.expected")} <code>{conflict.expected ?? t("commandError.none")}</code></p>
        <p>{t("commandError.current")} <code>{conflict.current ?? t("commandError.none")}</code></p>
      </div> : null}
      {failure.recoveryActions?.length ? <><p>{t("commandError.taskRecovery")}</p>
        <ul>{failure.recoveryActions.map(action => <li key={action}>{t(`execution.actions.${action}`)}</li>)}</ul>
      </> : null}
    </details>
  </>;
}
