import { useTranslation } from "react-i18next";
import { Badge } from "./design-system/Badge";
import type { PermissionRequest, PluginPackageDetailsView } from "./pluginCommands";

type Manifest = PluginPackageDetailsView["manifest"];

/** Exact declaration comparison is only a review aid. The Host remains the
 * authority for approval and execution permission. */
function sameRequest(left: PermissionRequest, right: PermissionRequest) {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "network": return right.kind === "network" && left.destination === right.destination;
    case "process": return right.kind === "process" && left.program === right.program;
    case "project-service": return right.kind === "project-service" && left.contract.id === right.contract.id
      && left.contract.schemaVersion === right.contract.schemaVersion && left.contract.behaviorVersion === right.contract.behaviorVersion;
    case "captured-input":
    case "staged-output": return true;
  }
}

export function PluginPermissions({ permissions, approvedPermissions, review = false }: {
  permissions: PermissionRequest[];
  approvedPermissions?: PermissionRequest[];
  review?: boolean;
}) {
  const { t } = useTranslation();
  if (!permissions.length) return <p>{t("plugins.noPermissions")}</p>;
  return <ul className="plugin-permission-list">{permissions.map((permission, index) => {
    const previous = approvedPermissions?.some(approved => sameRequest(permission, approved)) ?? false;
    return <li key={index} data-new-permission={review && !previous ? "true" : undefined}>
      <span>{t(`plugins.permissions.${permission.kind}`)}
        {permission.kind === "network" ? <>: <code>{permission.destination}</code></> : null}
        {permission.kind === "process" ? <>: <code>{permission.program}</code></> : null}
        {permission.kind === "project-service" ? <>: <code>{permission.contract.id}</code> ({permission.contract.schemaVersion}/{permission.contract.behaviorVersion})</> : null}
      </span>
      {review ? <Badge tone={previous ? "neutral" : "warning"}>{t(previous ? "plugins.permissionPreviouslyApproved" : approvedPermissions ? "plugins.permissionNew" : "plugins.permissionNeedsApproval")}</Badge> : null}
    </li>;
  })}</ul>;
}

/** Declarations are shown independently of approval. A missing trusted baseline
 * marks all requests for review; matching a plugin ID never supplies approval. */
export function PackagePermissionReview({ manifest, approvedManifest, review = false }: {
  manifest: Manifest;
  approvedManifest?: Manifest;
  review?: boolean;
}) {
  const { t } = useTranslation();
  return <section className="plugin-permission-review" aria-label={t("plugins.permissionsTitle")}>
    <h4>{t("plugins.permissionsTitle")}</h4>
    {review ? <p>{approvedManifest ? t("plugins.permissionComparison", { version: approvedManifest.plugin.version }) : t("plugins.permissionReviewAll")}</p> : null}
    <div className="plugin-permission-group" role="group" aria-label={t("plugins.packagePermissions")}>
      <h5>{t("plugins.packagePermissions")}</h5>
      <PluginPermissions permissions={manifest.permissions} approvedPermissions={approvedManifest?.permissions} review={review}/>
    </div>
    {manifest.contributions.map(contribution => {
      if (contribution.contribution.kind !== "capability") return null;
      const previous = approvedManifest?.contributions.find(value => value.id === contribution.id && value.componentId === contribution.componentId);
      const approvedPermissions = previous?.contribution.kind === "capability" ? previous.contribution.declaration.permissions : approvedManifest ? [] : undefined;
      return <div className="plugin-permission-group" key={contribution.id} role="group" aria-label={t("plugins.capability", { name: contribution.id })}>
        <h5>{t("plugins.capability", { name: contribution.id })}</h5>
        <PluginPermissions permissions={contribution.contribution.declaration.permissions} approvedPermissions={approvedPermissions} review={review}/>
      </div>;
    })}
  </section>;
}
