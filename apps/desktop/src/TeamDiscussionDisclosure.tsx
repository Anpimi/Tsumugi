import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import type { WorkPlanView } from "./workPlanCommands";

/** Display captured policy and Core limits, rather than the current draft. */
export function TeamDiscussionDisclosure({ plan }: { plan: WorkPlanView }) {
  const { t } = useTranslation();
  const limits = plan.teamDiscussionLimits;
  if (!plan.options.teamDiscussions || !plan.preview || !limits) return null;
  return <section aria-label={t("ai.discussions.title")}>
    <h4>{t("ai.discussions.title")}</h4>
    <p>{t("ai.discussions.sharing")}</p>
    <p>{t("ai.discussions.destination", { endpoint: plan.preview.config.endpoint, model: plan.preview.config.model })}</p>
    <p>{t("ai.discussions.members", { defaultValue: enUS.ai.discussions.members, members: limits.maxMembers, versions: limits.maxRoleVersionsPerMember })}</p>
    <p>{t("ai.discussions.posts", { defaultValue: enUS.ai.discussions.posts, posts: limits.maxPosts, bytes: limits.maxPostBytes })}</p>
    <p>{t("ai.discussions.view", { defaultValue: enUS.ai.discussions.view, posts: limits.maxViewPosts, bytes: limits.maxViewBytes })}</p>
    {plan.options.teamDiscussions.profile === "current-plan-2" ? <>
      <p>{t("ai.discussions.artifactSharing")}</p>
      <p>{t("ai.discussions.artifactLimit", { defaultValue: enUS.ai.discussions.artifactLimit, bytes: limits.maxArtifactBytes })}</p>
      <p>{t("ai.discussions.artifactScope")}</p>
    </> : null}
    <p>{t("ai.discussions.bounds")}</p>
  </section>;
}
