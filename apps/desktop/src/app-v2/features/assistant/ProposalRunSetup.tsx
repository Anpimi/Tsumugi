import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Disclosure } from "../../../design-system/Disclosure";
import { Field, TextInput } from "../../../design-system/Field";
import { Banner } from "../../../design-system/Feedback";
import { Menu } from "../../../design-system/Menu";
import type { PlanOptions } from "../../../generated/draft.responses";
import { SelectionPolicyValues } from "../../../generated/ai.enums";
import type { ConversationProposalDraft } from "../../../conversationDraftCommands";
import type { ConversationSession } from "./ConversationSession";
import type { ProposalContent } from "./proposalDraft";
import { applyRunTemplate, proposalTeamProblem } from "./proposalRecipe";
import { TeamMemberFields } from "./TeamMemberFields";
import styles from "./ConversationTeamRecovery.module.css";

export function ProposalRunSetup({ owner, conversationId, draft, content, labels, active, editable }: {
  owner: ConversationSession; conversationId: string; draft: ConversationProposalDraft;
  content: Extract<ProposalContent, { kind: "proposal" }>; labels: ReadonlyMap<string, { key: string; text: string }>;
  active: boolean; editable: () => boolean;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "proposalRunSetup" }), { t: global } = useTranslation();
  const [focusMember, setFocusMember] = useState<string | null>(null), addButton = useRef<HTMLButtonElement>(null);
  const team = content.options.teamExecution, problem = proposalTeamProblem(content.options, content.unitIds);
  const change = (edit: (options: PlanOptions) => PlanOptions) => {
    if (editable()) owner.editProposal(conversationId, draft.proposalId, value => value.kind === "proposal" ? { ...value, options: edit(value.options) } : value);
  };
  const scope = content.unitIds.map((unitId, index) => ({ unitId, nativeKey: labels.get(unitId)?.key ?? global("conversation.proposalEntryNumber", { number: index + 1 }) }));
  const assistedChecks = content.options.stages.some(choice => choice.stage === "checks" && choice.mode === "assisted");
  return <section className={styles.panel} aria-label={t("title")}>
    <h4>{t("title")}</h4><p>{t("help")}</p>
    <Menu label={t("templates")} trigger={<Button size="sm" disabled={!editable()}>{t("templates")}</Button>}
      items={(["translate", "translate-checks"] as const).map(template => ({ id: template, label: t(template), onSelect: () => change(options => applyRunTemplate(options, template)) }))}/>
    <div>{content.options.stages.map(choice => <p key={choice.stage}>{global("conversation.proposalStage", {
      stage: global(`ai.plan.stages.${choice.stage}`), mode: global(`ai.plan.modes.${choice.mode}`),
    })}</p>)}</div>
    <Menu label={t("selection")} trigger={<Button size="sm" disabled={!editable()}>{global(`ai.plan.policies.${content.options.selectionPolicy}`)}</Button>}
      items={SelectionPolicyValues.map(policy => ({ id: policy, label: global(`ai.plan.policies.${policy}`), disabled: policy !== "candidates-only" && !assistedChecks,
        onSelect: () => change(options => ({ ...options, selectionPolicy: policy })) }))}/>
    <p>{t("permission")}</p>
    <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={content.options.teamDiscussions != null} disabled={!editable() || !!team}
      onChange={event => change(options => ({ ...options, teamDiscussions: event.target.checked ? { profile: "current-plan-1" } : null }))}/><span>{global("ai.discussions.enable")}</span></label>
    {content.options.teamDiscussions ? <p>{global("ai.discussions.sharing")}</p> : null}
    <h4>{t("team")}</h4><p>{t("teamHelp")}</p>
    {team ? <>
      <Menu label={global("ai.team.initial")} trigger={<Button size="sm" disabled={!editable()}>{global("ai.team.initial")}: {team.members.find(member => member.memberId === team.initialMemberId)?.displayName || t("unnamed")}</Button>}
        items={team.members.map((member, index) => ({ id: member.memberId, label: member.displayName || global("ai.team.memberNumber", { number: String(index + 1) }),
          onSelect: () => change(options => ({ ...options, teamExecution: options.teamExecution ? { ...options.teamExecution, initialMemberId: member.memberId } : null })) }))}/>
      <Menu label={global("ai.team.initialUnit")} trigger={<Button size="sm" disabled={!editable()}>{global("ai.team.initialUnit")}: {scope.find(unit => unit.unitId === team.initialUnitId)?.nativeKey ?? t("chooseEntry")}</Button>}
        items={scope.map(unit => ({ id: unit.unitId, label: unit.nativeKey, onSelect: () => change(options => ({ ...options,
          teamExecution: options.teamExecution ? { ...options.teamExecution, initialUnitId: unit.unitId } : null })) }))}/>
      <fieldset className={styles.fields} disabled={!editable()}><legend>{t("limits")}</legend>
        {(["maxActivations", "maxConcurrency", "maxNoProgress"] as const).map(field => <Field key={field} label={global(`ai.team.${field}`)} description={team.limits[field]}>
          <TextInput type="range" min={1} max={field === "maxConcurrency" ? 8 : 300} step={1} value={team.limits[field]} onChange={event => {
            const number = event.target.valueAsNumber;
            change(options => ({ ...options, teamExecution: options.teamExecution ? { ...options.teamExecution,
              limits: { ...options.teamExecution.limits, [field]: number } } : null }));
          }}/></Field>)}
      </fieldset>
      {team.members.map((member, index) => <Disclosure key={member.memberId} open={focusMember === member.memberId || undefined} title={member.displayName || global("ai.team.memberNumber", { number: String(index + 1) })}>
        <TeamMemberFields member={member} number={index + 1} scope={scope} tools={[]} editSeq={draft.editSeq} active={active} editable={editable}
          focusName={focusMember === member.memberId}
          current={() => owner.getSnapshot().inputs.get(conversationId)?.value.proposalEdits?.find(value => value.proposalId === draft.proposalId)?.editSeq === draft.editSeq}
          onChange={patch => change(options => ({ ...options, teamExecution: options.teamExecution ? { ...options.teamExecution,
            members: options.teamExecution.members.map(value => value.memberId === member.memberId ? { ...value, ...patch } : value) } : null }))}
          onRemove={() => {
            change(options => {
              const previous = options.teamExecution;
              if (!previous) return options;
              const members = previous.members.filter(value => value.memberId !== member.memberId);
              return { ...options, teamExecution: members.length ? { ...previous, members,
                initialMemberId: previous.initialMemberId === member.memberId ? members[0]?.memberId ?? previous.initialMemberId : previous.initialMemberId } : null,
                teamQuestions: members.length ? options.teamQuestions : null };
            }); setFocusMember(null); addButton.current?.focus();
          }}/>
      </Disclosure>)}
      {problem ? <Banner tone="warning">{problem === "members" ? t("memberProblem") : global(`ai.team.problems.${problem}`)}</Banner> : null}
    </> : <p>{t("solo")}</p>}
    {content.options.mcpTermQuery ? <p>{t("mcp")}</p> : null}
    <Button size="sm" ref={addButton} disabled={!editable() || !!content.options.mcpTermQuery || !content.unitIds.length || (team?.members.length ?? 0) >= 8} onClick={() => {
      if (editable()) setFocusMember(owner.addProposalMember(conversationId, draft.proposalId) ?? null);
    }}>{global("ai.team.add")}</Button>
  </section>;
}
