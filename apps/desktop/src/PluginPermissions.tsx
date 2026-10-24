import { useTranslation } from "react-i18next";
import type { PermissionRequest } from "./pluginCommands";

export function PluginPermissions({ permissions }: { permissions: PermissionRequest[] }) {
  const { t } = useTranslation();
  if (!permissions.length) return <p>{t("plugins.noPermissions")}</p>;
  return <ul>{permissions.map((permission, index) => <li key={index}>{t(`plugins.permissions.${permission.kind}`)}
    {permission.kind === "network" ? <>: <code>{permission.destination}</code></> : null}
    {permission.kind === "process" ? <>: <code>{permission.program}</code></> : null}
    {permission.kind === "project-service" ? <>: <code>{permission.contract.id}</code> ({permission.contract.schemaVersion}/{permission.contract.behaviorVersion})</> : null}
  </li>)}</ul>;
}
