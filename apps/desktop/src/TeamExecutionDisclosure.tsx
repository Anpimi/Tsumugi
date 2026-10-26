import { useTranslation } from "react-i18next";
import { CapturedRequestLimits } from "./ModelConnectionPicker";
import { AiPreviewItems } from "./AiPreviewItems";
import { TeamDiscussionDisclosure } from "./TeamDiscussionDisclosure";
import { ToolGuidanceSharing } from "./ToolGuidanceSharing";
import type { WorkPlanView } from "./workPlanCommands";

/** The original plan owns every member's separately captured source and sharing. */
export function TeamExecutionDisclosure({ plan }: { plan: WorkPlanView }) {
  const { t } = useTranslation(), policy = plan.options.teamExecution;
  if (!policy || !plan.memberPreviews) return null;
  const names = new Map(plan.scope.map(unit => [unit.unitId, unit.nativeKey]));
  return <section aria-label={t("ai.team.capturedTitle")}>
    <h4>{t("ai.team.capturedTitle")}</h4><p>{t("ai.team.capturedHelp")}</p><p>{t("ai.team.sharedBudget")}</p>
    <p>{t("ai.team.capturedLimits", { activations: String(policy.limits.maxActivations), concurrency: String(policy.limits.maxConcurrency), noProgress: String(policy.limits.maxNoProgress) })}</p>
    <p>{t("ai.team.completionLimitHelp")}</p>
    {plan.teamWorkTimeoutMs != null ? <p>{t("ai.team.workTimeout", { seconds: String(plan.teamWorkTimeoutMs / 1000) })}</p> : null}
    <p>{t("ai.team.capturedInitial", { member: policy.members.find(member => member.memberId === policy.initialMemberId)?.displayName ?? "", entry: names.get(policy.initialUnitId) ?? "", locale: plan.locale })}</p>
    <TeamDiscussionDisclosure plan={plan} destinations={policy.members.map(member => ({ name: member.displayName, endpoint: member.config.endpoint, model: member.config.model }))}/>
    {policy.members.map(member => {
      const captured = plan.memberPreviews!.find(value => value.memberId === member.memberId);
      if (!captured) return null;
      return <section key={member.memberId} aria-label={member.displayName}><h5>{member.displayName}</h5><pre className="ai-text">{member.role}</pre>
        <p>{t("ai.discussions.destination", { endpoint: captured.preview.config.endpoint, model: captured.preview.config.model })}</p>
        <CapturedRequestLimits config={member.config} member/>
        <p>{t("ai.team.allowedKinds", { kinds: member.kinds.map(kind => t(`ai.team.workKinds.${kind}`)).join(", ") })}</p>
        <p>{t("ai.team.allowedEntries", { entries: member.unitIds.map(id => names.get(id) ?? "").join(", ") })}</p>
        {member.toolHandles.length ? <ul>{member.toolHandles.map(handle => <li key={handle}>{plan.tools?.entries.find(tool => tool.handle === handle)?.binding.declaration.title}</li>)}</ul> : <p>{t("ai.team.noTools")}</p>}
        <ToolGuidanceSharing plan={plan} config={captured.preview.config} toolHandles={member.toolHandles}/>
        <AiPreviewItems items={captured.preview.items}/>
      </section>;
    })}
  </section>;
}
