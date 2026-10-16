import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { PluginPermissions } from "./PluginPermissions";
import { reviewRuleLabel } from "./reviewLabels";
import type { CheckRuleResult, CheckRun, ReviewCheckerView } from "./generated/review.responses";
import { contractIdentity, providerIdentity, ruleIdentity } from "./reviewIdentity";
export { checkerIdentity, ruleIdentity } from "./reviewIdentity";
export function capturedRuleLabel(t: TFunction, run: CheckRun, rule: CheckRuleResult): string {
  if (rule.key.implementation.kind === "plugin") {
    const provider = rule.key.implementation.provider;
    const reference = contractIdentity(rule.key.rule);
    const choice = run.evidence?.advisoryChecks.find(choice =>
      providerIdentity(choice.binding.checker.provider) === providerIdentity(provider)
      && choice.binding.declaration.rules.some(declared => contractIdentity(declared.rule) === reference));
    const declaration = choice?.binding.declaration.rules.find(declared => contractIdentity(declared.rule) === reference);
    if (declaration) return declaration.title;
  }
  return reviewRuleLabel(t, rule.rule);
}

export function ReviewCheckerDetails({ view }: { view: ReviewCheckerView }) {
  const { t } = useTranslation();
  const plugin = view.plugin;
  const capability = view.kind === "format" ? view.plugin.checker : view.plugin.binding.checker;
  return <>
    <p>{t(view.kind === "format" ? "review.formatChecks" : "review.advisoryChecks")} · {capability.provider.plugin.publisher}/{capability.provider.plugin.id} {capability.provider.plugin.version}</p>
    <p>{t(plugin.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeDetails" : "sourcePlugin.nativeRuntimeDetails", {
      version: plugin.environment.profile === "node-system-libraries-v1" ? plugin.environment.toolVersion : plugin.environment.hostVersion,
      system: plugin.environment.platform.operatingSystem, architecture: plugin.environment.platform.architecture })}</p>
    {view.kind === "advisory-text" ? <ul>{view.plugin.rules.map(rule => {
      const declared = view.plugin.binding.declaration.rules.find(candidate => candidate.rule.id === rule.id
        && candidate.rule.schemaVersion === rule.schemaVersion && candidate.rule.behaviorVersion === rule.behaviorVersion);
      return <li key={JSON.stringify([rule.id, rule.schemaVersion, rule.behaviorVersion])}>{declared?.title ?? rule.id}</li>;
    })}</ul> : null}
    <PluginPermissions permissions={capability.declaration.permissions} />
    <p>{t("sourcePlugin.unsandboxed")}</p>
  </>;
}

export function ReviewDiagnosticDetails({ run, rule, code }: { run: CheckRun; rule: CheckRuleResult; code: string }) {
  const { t } = useTranslation();
  const identity = ruleIdentity(rule.key);
  // SDK diagnostics retain the input's operation unit IDs. The owning Core
  // UUID is separate; join only this exact rule's captured target scope.
  const targets = new Set(run.evidence?.requiredChecks.requirements.find(requirement => ruleIdentity(requirement.key) === identity)?.targets ?? []);
  const diagnostics = run.evidence?.diagnostics.filter(diagnostic => ruleIdentity(diagnostic.key) === identity
    && diagnostic.code === code && targets.has(diagnostic.target)) ?? [];
  return <>{diagnostics.map((diagnostic, index) => <div key={JSON.stringify([ruleIdentity(diagnostic.key), diagnostic.code, diagnostic.target, diagnostic.location, index])}>
    {diagnostic.detail ? <p>{diagnostic.detail}</p> : null}
    {diagnostic.suggestion ? <p>{t("review.advisorySuggestion", { suggestion: diagnostic.suggestion })}</p> : null}
    {diagnostic.location || diagnostic.resourceEntry ? <details><summary>{t("execution.diagnostic")}</summary>
      {diagnostic.location ? <p>{t("review.diagnosticRange", { field: t(diagnostic.location.field === "source" ? "review.source" : "review.translation"),
        encoding: diagnostic.location.range.encoding, rangeStart: String(diagnostic.location.range.start), rangeEnd: String(diagnostic.location.range.end) })}</p> : null}
      {diagnostic.resourceEntry ? <p>{t("review.diagnosticResource", { resourceId: diagnostic.resourceEntry.contributionId, entry: diagnostic.resourceEntry.entryId })}</p> : null}
    </details> : null}
  </div>)}</>;
}
