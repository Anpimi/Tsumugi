import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import type { ApplicationScopeBasis, SessionRequest } from "./executionCommands";
import type { AutomationEffect, WorkPlanControlRequest } from "./generated/ai.requests";
import { enUS } from "./i18n/en-US";
import { PluginPermissions } from "./PluginPermissions";
import { jsonIdentity } from "./pluginToolChoices";
import { ReviewCheckerDetails, checkerIdentity } from "./ReviewCheckers";
import { useWorkPlanApplicationTools, WorkPlanApplicationToolDetails, WorkPlanApplicationToolObservation } from "./workPlanApplicationTools";
import type { WorkPlanView } from "./workPlanCommands";

export interface WorkPlanExecutionConsent {
  checkers: string[];
  tools: string | null;
  applications: string[];
}

function requiresCheckerExecution(plan: WorkPlanView | null): boolean {
  return Boolean(plan?.preview && plan.options.stages.some(choice => choice.stage === "checks" && choice.mode === "assisted"));
}

export function workPlanEffects(plan: WorkPlanView | null): AutomationEffect[] {
  if (!plan) return [];
  return ["save-candidate", ...(requiresCheckerExecution(plan) ? ["run-checks"] as const : []),
    ...(plan.options.selectionPolicy === "candidates-only" ? [] :
      [plan.options.selectionPolicy === "missing-only" ? "select-missing" : "replace-captured-selection"] as const),
    ...(plan.options.teamDiscussions ? ["publish-discussion"] as const : []),
    ...(plan.options.teamExecution ? ["dispatch-team-work", "send-team-message"] as const : []),
    ...(plan.tools?.entries.length || plan.options.mcpTermQuery ? ["query-tools"] as const : [])];
}

/** Consent stays with the caller; this review only observes the captured plan and instances. */
export function useWorkPlanExecutionReview({ context, plan, generation, open, value, onChange }: {
  context: SessionRequest;
  plan: WorkPlanView | null;
  generation: string | null;
  open: boolean;
  value: WorkPlanExecutionConsent;
  onChange: (change: (before: WorkPlanExecutionConsent) => WorkPlanExecutionConsent) => void;
}) {
  const applicationTools = useWorkPlanApplicationTools(plan?.tools?.entries ?? [], open);
  const applicationConsentKey = (group: typeof applicationTools.groups[number]) => jsonIdentity([context.sessionToken, context.projectId,
    plan?.planId, plan?.digest, generation ?? "prepared", group.basis, group.capabilities, group.tools]) ?? "";
  const applicationsConfirmed = applicationTools.groups.every(group => value.applications.includes(applicationConsentKey(group)));
  const applicationToolExecutions = (): ApplicationScopeBasis[] => applicationTools.groups.length && applicationsConfirmed && applicationTools.current()
    ? applicationTools.groups.map(group => structuredClone(group.basis)) : [];
  const checkerRequired = requiresCheckerExecution(plan);
  const checkerConsentKey = (checker: WorkPlanView["checkers"][number]) => JSON.stringify([context.sessionToken, context.projectId,
    plan?.planId, plan?.digest, generation ?? "prepared", checker]);
  const checkerConfirmed = !checkerRequired || Boolean(plan && plan.checkers.length > 0
    && plan.checkers.every(checker => checker.kind === "ready" && value.checkers.includes(checkerConsentKey(checker))));
  const checkerExecutions = (): WorkPlanControlRequest["checkerExecutions"] => checkerRequired && checkerConfirmed
    ? plan?.checkers.map(checker => checker.checker) ?? [] : [];
  const toolsRequired = Boolean(plan?.tools?.entries.length);
  const toolKey = toolsRequired && plan ? JSON.stringify([context.sessionToken, context.projectId, plan.planId, plan.digest, generation ?? "prepared", plan.tools]) : null;
  const toolsConfirmed = !toolsRequired || (toolKey !== null && value.tools === toolKey);
  const confirmed = Boolean(plan) && checkerConfirmed && toolsConfirmed && applicationsConfirmed;
  const current = () => confirmed && applicationTools.current();
  return { plan, applicationTools, applicationConsentKey, checkerConsentKey, toolKey, value, onChange,
    checkerRequired, toolsRequired, confirmed, current, checkerExecutions, toolExecution: toolsRequired && toolsConfirmed, applicationToolExecutions };
}

export type WorkPlanExecutionReviewState = ReturnType<typeof useWorkPlanExecutionReview>;

export function WorkPlanExecutionReview({ review, disabled, consentDisabled = false, showConsent, onOpenExtensions }: {
  review: WorkPlanExecutionReviewState;
  disabled: boolean;
  consentDisabled?: boolean;
  showConsent: boolean;
  onOpenExtensions?: () => void;
}) {
  const { t } = useTranslation();
  const { plan, applicationTools, applicationConsentKey, checkerConsentKey, toolKey, value, onChange, checkerRequired } = review;
  if (!plan) return null;
  return <>
    {plan.tools ? <section aria-label={t("ai.tools.reviewTitle")}>
      <h4>{t("ai.tools.reviewTitle")}</h4><p>{t("ai.tools.limitHelp")}</p><p>{t("ai.tools.fixedLimit", { limit: plan.tools.maxInvocations, defaultValue: enUS.ai.tools.fixedLimit })}</p>
      {plan.tools.entries.map(tool => <article key={tool.handle}>
        <h4>{tool.binding.declaration.title} · {tool.binding.capability.provider.plugin.id} {tool.binding.capability.provider.plugin.version}</h4>
        <p>{tool.binding.declaration.description}</p><PluginPermissions permissions={tool.binding.capability.declaration.permissions} />
        <details><summary>{t("sourcePlugin.fixedDetails")}</summary><pre className="ai-text">{JSON.stringify({ binding: tool.binding, execution: tool.execution,
          applicationCapabilities: tool.applicationCapabilities, packageOrigin: tool.packageOrigin, runtimeOrigin: tool.runtimeOrigin, target: tool.target, selections: tool.selections }, null, 2)}</pre></details>
      </article>)}
      {applicationTools.groups.length ? <section aria-label={t("toolQuery.applicationTitle")}>
        {applicationTools.groups.map(group => <fieldset key={jsonIdentity(group.basis)}>
          <legend>{t("ai.tools.applicationInstance", { name: group.tools[0].binding.declaration.title })}</legend>
          <WorkPlanApplicationToolDetails group={group} />
          {showConsent ? <label className="source-check">
            <input type="checkbox" checked={value.applications.includes(applicationConsentKey(group))}
              disabled={disabled || consentDisabled || !applicationTools.current()} onChange={event => {
                const key = applicationConsentKey(group), checked = event.target.checked;
                onChange(before => ({ ...before, applications: checked
                  ? [...before.applications.filter(value => value !== key), key]
                  : before.applications.filter(value => value !== key) }));
              }} />{t("ai.tools.applicationConsent")}</label> : null}
        </fieldset>)}
        <WorkPlanApplicationToolObservation observation={applicationTools.observation} />
      </section> : null}
      <p>{t("sourcePlugin.unsandboxed")}</p>
      {showConsent ? <label className="source-check">
        <input type="checkbox" checked={toolKey !== null && value.tools === toolKey} disabled={disabled || consentDisabled}
          onChange={event => { const checked = event.target.checked; onChange(before => ({ ...before, tools: checked ? toolKey : null })); }} />{t("ai.tools.consent")}
      </label> : null}
    </section> : null}
    {checkerRequired ? <>
      {plan.checkers.length === 0 ? <p role="alert">{t("ai.plan.checkerUnavailable")}</p> : null}
      {onOpenExtensions && (plan.checkers.length === 0 || plan.checkers.some(checker => checker.kind === "unavailable")) ? <button type="button"
        className="text-button" disabled={disabled} onClick={onOpenExtensions}>{t("review.openExtensions")}</button> : null}
      {plan.checkers.map(checker => checker.kind === "ready" ? <fieldset key={checkerIdentity(checker.checker)}>
        <legend>{t("review.checkerConsentScope", { plugin: `${checker.checker.provider.plugin.publisher}/${checker.checker.provider.plugin.id} ${checker.checker.provider.plugin.version}`, profile: checker.checker.profile.id })}</legend>
        <ReviewCheckerDetails view={checker.plugin} />
        {showConsent ? <label className="source-check">
          <input type="checkbox" checked={value.checkers.includes(checkerConsentKey(checker))} disabled={disabled || consentDisabled}
            onChange={event => {
              const key = checkerConsentKey(checker), checked = event.target.checked;
              onChange(before => ({ ...before, checkers: checked
                ? [...before.checkers.filter(value => value !== key), key]
                : before.checkers.filter(value => value !== key) }));
            }} />{t("ai.plan.checkerConsent")}
        </label> : null}
      </fieldset> : <div key={checkerIdentity(checker.checker)} role="alert"><p>{t("ai.plan.checkerUnavailable")}</p>
        <p>{checker.checker.provider.plugin.publisher}/{checker.checker.provider.plugin.id} {checker.checker.provider.plugin.version}</p>
        <CommandFailureDetails failure={commandFailure(checker.error)} /></div>)}
    </> : null}
  </>;
}
