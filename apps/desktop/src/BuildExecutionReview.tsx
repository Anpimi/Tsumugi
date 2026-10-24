import { useTranslation } from "react-i18next";
import { PluginPermissions } from "./PluginPermissions";
import { pluginEnvironmentVersion } from "./pluginEnvironments";
import type { PluginBuildView } from "./pluginCommands";

export function BuildExecutionReview({ build, checker }: { build: PluginBuildView; checker: boolean }) {
  const { t } = useTranslation();
  const capability = checker ? build.checker : build.builder;
  return <section aria-label={t(checker ? "releasePlugin.checkReview" : "releasePlugin.buildReview")}>
    <p>{build.declaration.displayName} · {capability.provider.plugin.id} {capability.provider.plugin.version}</p>
    <p>{t(build.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeDetails" : "sourcePlugin.nativeRuntimeDetails", { version: pluginEnvironmentVersion(build.environment), system: build.environment.platform.operatingSystem, architecture: build.environment.platform.architecture })}</p>
    <PluginPermissions permissions={capability.declaration.permissions} />
    <p>{t("sourcePlugin.unsandboxed")}</p>
    <details><summary>{t("sourcePlugin.fixedDetails")}</summary><dl>
      <dt>{t("sourcePlugin.packageDigest")}</dt><dd><code>{capability.provider.packageDigest}</code></dd>
      <dt>{t("sourcePlugin.runtimeDigest")}</dt><dd><code>{build.environmentDigest}</code></dd>
      <dt>{t("sourcePlugin.profile")}</dt><dd><code>{build.declaration.profile.id}</code> ({build.declaration.profile.schemaVersion}/{build.declaration.profile.behaviorVersion})</dd>
    </dl></details>
  </section>;
}
