import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSessionQuery } from "./SessionReadProvider";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import { workPlanCommands, type WorkPlanStatusView } from "./workPlanCommands";
import { jsonIdentity } from "./pluginToolChoices";
import type { SessionRequest } from "./executionCommands";
import { TeamMemberChoice } from "./TeamMemberChoice";
import { newTeamMember } from "./TeamExecutionDraft";
import { recoveryDraftProblem } from "./TeamRecoveryDraft";
import { teamRecoveryAvailable, type TeamRecoverySession } from "./TeamRecoverySession";
import { TeamRecoveryDisclosure } from "./TeamRecoveryDisclosure";
import { AiProviderBudget } from "./AiUsage";
import { useWorkbenchCommands, type AiTeamRecoveryCommandPayload, type CommandAvailability } from "./workbenchCommands";
import { useWorkPlanApplicationTools, WorkPlanApplicationToolDetails, WorkPlanApplicationToolObservation } from "./workPlanApplicationTools";
import { PluginPermissions } from "./PluginPermissions";
import { ReviewCheckerDetails, checkerIdentity } from "./ReviewCheckers";
import { TeamWorkKindValues } from "./generated/ai.enums";

export function TeamRecoveryControls({ context, status, session, open, disabled, onPlan, onOpenSettings, onOpenTask }: {
  context: SessionRequest; status: WorkPlanStatusView; session: TeamRecoverySession; open: boolean; disabled: boolean;
  onPlan: (planId: string) => void; onOpenSettings?: () => void; onOpenTask?: (taskId: string, attemptId: string) => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation(), registry = useWorkbenchCommands(), plan = status.plan, planId = plan.planId;
  const [after, setAfter] = useState<string | null>(null), [afterWork, setAfterWork] = useState<string | null>(null), [deadlineTick, setDeadlineTick] = useState(0);
  const [toolConsent, setToolConsent] = useState(false), [checkerConsent, setCheckerConsent] = useState<string[]>([]), [applicationsConsent, setApplicationsConsent] = useState<string[]>([]);
  const errorRef = useRef<HTMLDivElement>(null), rowRefs = useRef(new Map<number, HTMLInputElement>()), [focusKey, setFocusKey] = useState<number | null>(null);
  const read = useSessionQuery({ key: ["team-recovery-state", planId], scopes: ["execution", "source", "translation", "resources", "review", "project"], enabled: open,
    read: () => workPlanCommands.teamRecoveryState({ ...context, planId }) });
  const team = useSessionQuery({ key: ["team-execution", planId, afterWork, null], scopes: ["execution", "source", "translation", "project"], enabled: open,
    read: () => workPlanCommands.teamExecution({ ...context, planId, afterWork, afterMessage: null, limit: 16 }) });
  const posts = useSessionQuery({ key: ["team-history", planId, after], scopes: ["execution", "source", "translation", "project"], enabled: open && session.state.draft?.planId === planId,
    read: () => workPlanCommands.teamHistory({ ...context, planId, after, limit: 16 }) });
  const observation = !read.error && !read.isFetching ? read.data : null, view = !team.error && !team.isFetching ? team.data : null;
  const state = session.state, draft = state.draft?.planId === planId ? state.draft : null;
  const capture = state.capture?.value.preview.planId === planId ? state.capture : null;
  const pending = state.pending?.capture.value.preview.planId === planId ? state.pending : null;
  const ready = state.ready?.capture.value.preview.planId === planId ? state.ready : null;
  const reviewedTools = capture?.value.tools ?? plan.tools, reviewedCheckers = capture?.value.checkers ?? plan.checkers;
  const applicationTools = useWorkPlanApplicationTools(reviewedTools?.entries ?? [], open);
  const canPrepare = !!observation && !!view && teamRecoveryAvailable(observation) && jsonIdentity(view.effectiveVersion) === jsonIdentity(observation.state.effectiveVersion);
  const problem = observation && observation.state.unresolvedWork.length > 16 ? "unresolvedLimit" : draft && view
    ? observation?.state.unresolvedWork.some(reference => !draft.priorWork.some(value => jsonIdentity(value) === jsonIdentity(reference))) ? "unresolved" : recoveryDraftProblem(draft, plan, view) : null;
  const basisCurrent = !!capture && !!observation && canPrepare && jsonIdentity(observation.state.lease) === jsonIdentity(capture.value.preview.baseLease)
    && jsonIdentity(observation.state.effectiveVersion) === jsonIdentity(capture.value.preview.baseEffectiveVersion);
  const captureKey = capture ? jsonIdentity([capture.value.preview.digest, capture.value.tools, capture.value.checkers]) : null;
  useEffect(() => { setToolConsent(false); setCheckerConsent([]); setApplicationsConsent([]); }, [captureKey]);
  useEffect(() => { if (capture && (!session.connectionCurrent() || observation && !basisCurrent)) session.invalidateCapture(); });
  useEffect(() => {
    if (!open || !read.data) return;
    const remaining = BigInt(read.data.state.expiresAtMs) - BigInt(Date.now()) + 1n;
    if (remaining <= 0n) return;
    const timer = window.setTimeout(() => setDeadlineTick(value => value + 1), Number(remaining > 2147483647n ? 2147483647n : remaining));
    return () => window.clearTimeout(timer);
  }, [open, read.data?.state.expiresAtMs, deadlineTick]);
  const failure = state.failure ?? (read.error ? commandFailure(read.error) : team.error ? commandFailure(team.error) : posts.error ? commandFailure(posts.error) : null);
  useEffect(() => { if (open && failure) errorRef.current?.focus(); }, [open, failure]);
  useEffect(() => { if (focusKey !== null) { rowRefs.current.get(focusKey)?.focus(); setFocusKey(null); } }, [focusKey, draft?.members.length]);
  const scope = { ...context, area: "ai" as const }, unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
  const payload = (): AiTeamRecoveryCommandPayload => ({ kind: "ai-team-recovery", planId, editSeq: state.editSeq,
    actionId: pending ? pending.kind === "start" ? pending.request.actionId : pending.request.recovery.actionId : ready?.receipt.actionId ?? null });
  const samePayload = (value?: AiTeamRecoveryCommandPayload) => open && !disabled && jsonIdentity(value) === jsonIdentity(payload());
  const checkerRequired = plan.options.stages.some(stage => stage.stage === "checks" && stage.mode === "assisted");
  const checkersReady = !checkerRequired || reviewedCheckers.length > 0 && reviewedCheckers.every(checker => checker.kind === "ready" && checkerConsent.includes(checkerIdentity(checker.checker)));
  const applicationsReady = applicationTools.current() && applicationTools.groups.every(group => applicationsConsent.includes(jsonIdentity(group.basis)!));
  function available(action: "begin" | "prepare" | "authorize" | "start" | "check" | "retry" | "end" | "discard", value?: AiTeamRecoveryCommandPayload): CommandAvailability {
    if (!samePayload(value)) return unavailable;
    const idle = !session.blocked();
    const enabled = action === "begin" ? idle && canPrepare && observation!.state.unresolvedWork.length <= 16 && !draft && !session.hasDraft()
      : action === "prepare" ? idle && canPrepare && !!draft && !problem
      : action === "authorize" ? idle && basisCurrent && state.consent && session.connectionCurrent() && (!reviewedTools || toolConsent) && checkersReady && applicationsReady
      : action === "start" ? !!ready && !pending && !state.preparing && !!observation && observation.runtime?.originalDeadlineAvailable === true && observation.state.state === "active"
        && jsonIdentity(observation.state.effectiveVersion) === jsonIdentity(ready.receipt.effectiveVersion) && BigInt(observation.state.expiresAtMs) > BigInt(Date.now())
      : action === "check" ? pending?.phase === "unknown"
      : action === "retry" ? pending?.phase === "unknown" && (pending.kind === "close" || pending.retryAllowed && !!observation && !session.originalClosed(observation))
      : action === "end" ? (pending?.kind === "authorize" ? pending.phase === "unknown" && pending.retryAllowed
        : pending?.kind !== "close" && !!observation && session.originalClosed(observation) && (!pending || pending.phase === "unknown" && pending.retryAllowed))
      : idle && !!draft;
    return enabled ? { enabled: true } : unavailable;
  }
  useLayoutEffect(() => {
    const metadata = { category: "ai" as const, scope, binding: null, confirmation: "none" as const, payloadKind: "ai-team-recovery" as const };
    const remove = [
      registry.register({ ...metadata, id: "ai.team-recovery.begin", nameKey: "ai.recovery.edit", risk: "reads-execution", availability: value => available("begin", value), handler: () => { if (view) session.begin(plan, view); } }),
      registry.register({ ...metadata, id: "ai.team-recovery.prepare", nameKey: "ai.recovery.prepare", risk: "reads-execution", availability: value => available("prepare", value), handler: () => { if (view && observation) void session.prepare(plan, view, observation, status.effects); } }),
      registry.register({ ...metadata, id: "ai.team-recovery.authorize", nameKey: "ai.recovery.authorize", risk: "runs-ai", confirmation: "required", availability: value => available("authorize", value), handler: () => { void session.authorize({ checkerExecutions: checkerRequired ? reviewedCheckers.map(checker => checker.checker) : [], toolExecution: reviewedTools !== null,
        applicationToolExecutions: applicationTools.groups.map(group => group.basis) }); } }),
      registry.register({ ...metadata, id: "ai.team-recovery.start", nameKey: "ai.recovery.start", risk: "runs-ai", availability: value => available("start", value), handler: () => { void session.start(); } }),
      registry.register({ ...metadata, id: "ai.team-recovery.check", nameKey: "ai.recovery.check", risk: "reads-execution", availability: value => available("check", value), handler: () => { void session.check(); } }),
      registry.register({ ...metadata, id: "ai.team-recovery.retry", nameKey: "ai.recovery.retry", risk: "retries-execution-action", availability: value => available("retry", value), handler: () => { void session.retry(observation ?? undefined); } }),
      registry.register({ ...metadata, id: "ai.team-recovery.end", nameKey: "ai.recovery.endPreparation", risk: "writes-execution", availability: value => available("end", value), handler: () => { void session.end(observation ?? undefined); } }),
      registry.register({ ...metadata, id: "ai.team-recovery.discard", nameKey: "ai.recovery.discard", risk: "reads-execution", availability: value => available("discard", value), handler: () => { session.discard(); } }),
    ]; return () => remove.forEach(dispose => dispose());
  });
  const button = (action: Parameters<typeof available>[0], primary = false) => <button type="button" className={primary ? "primary-button" : "secondary-button"}
    disabled={!available(action, payload()).enabled} onClick={() => registry.dispatch(`ai.team-recovery.${action}`, scope, payload())}>{t(action === "end" && pending?.kind === "authorize" ? "ai.recovery.endPreparation" : action === "retry" && pending?.kind === "close" ? "ai.recovery.retryClose" : `ai.recovery.${action === "begin" ? "edit" : action}`)}</button>;
  const unitNames = new Map(plan.scope.map(unit => [unit.unitId, unit.nativeKey])), tools = plan.tools?.entries ?? [], toolRows = tools.map((_, index) => index);
  const names = new Map(toolRows.map(index => [index, tools[index].binding.declaration.title]));
  const otherPlan = state.draft && state.draft.planId !== planId ? state.draft.planId : session.pendingPlan() !== planId ? session.pendingPlan() : null;
  const expired = observation && BigInt(observation.state.expiresAtMs) <= BigInt(Date.now());
  return <section aria-label={t("ai.recovery.title")}><h3>{t("ai.recovery.title")}</h3><p>{t("ai.recovery.help")}</p>
    <button type="button" className="secondary-button" disabled={read.isFetching || team.isFetching} onClick={() => { void Promise.all([read.refetch(), team.refetch()]); }}>{t("ai.recovery.refresh")}</button>
    {read.isFetching || team.isFetching ? <p role="status">{t("ai.recovery.loading")}</p> : null}
    {failure ? <div ref={errorRef} tabIndex={-1} role="alert"><p>{t("ai.recovery.failed")}</p><CommandFailureDetails failure={failure}/></div> : null}
    {observation ? <><p role="status">{t(expired || observation.state.state === "stopped" || !observation.runtime?.originalDeadlineAvailable ? "ai.recovery.newPlan"
      : observation.state.state === "active" ? "ai.recovery.pauseFirst" : canPrepare ? "ai.recovery.available" : "ai.recovery.draining")}</p>
      <p>{t("ai.recovery.counters", { activations: String(observation.state.activations), completions: String(observation.state.unconfirmedCompletions) })}</p>
      <p>{t("ai.recovery.deadline", { date: new Date(Number(observation.state.expiresAtMs)).toLocaleString(i18n.language) })}</p>
      <AiProviderBudget budget={observation.state.budget}/>
    </> : null}
    {otherPlan ? <p>{t("ai.recovery.otherDraft")} <button type="button" className="text-button" onClick={() => onPlan(otherPlan)}>{t("ai.recovery.returnDraft")}</button></p> : null}
    {observation && observation.state.unresolvedWork.length > 16 ? <p role="alert">{t("ai.recovery.problems.unresolvedLimit")}</p> : null}
    {!draft && !otherPlan ? button("begin") : null}
    {draft ? <><p>{t("ai.recovery.memberHelp", { members: String(plan.teamDiscussionLimits!.maxMembers), versions: String(plan.teamDiscussionLimits!.maxRoleVersionsPerMember) })}</p>{draft.members.map((member, index) => <TeamMemberChoice key={member.key} member={member} number={index + 1}
      selected={plan.scope.map(unit => unit.unitId)} unitNames={unitNames} tools={null} toolRows={toolRows} toolNames={names} disabled={disabled} open={open} editSeq={state.editSeq}
      onEdit={change => session.edit(before => ({ ...before, members: before.members.map(row => row.key === member.key ? { ...row, ...change } : row) }))}
      onConfig={change => session.editConfig(member.key, change)} onConnection={(value, id, seq) => session.selectConnection(member.key, value, id, seq)} onOpenSettings={onOpenSettings}
      nameRef={element => { if (element) rowRefs.current.set(member.key, element); else rowRefs.current.delete(member.key); }}
      onRemove={() => session.edit(before => ({ ...before, members: before.members.filter(row => row.key !== member.key) }))}/>) }
      <button type="button" className="secondary-button" disabled={disabled || draft.members.length >= 8} onClick={() => {
        const key = draft.nextKey;
        session.edit(before => ({ ...before, nextKey: key + 1, members: [...before.members, { ...newTeamMember(key, plan.preview!.config, plan.scope.map(unit => unit.unitId)), original: null }] })); setFocusKey(key);
      }}>{t("ai.team.add")}</button>
      <fieldset disabled={disabled}><legend>{t("ai.recovery.work")}</legend><p>{t("ai.recovery.workHelp")}</p>
        <label className="field">{t("ai.recovery.recipient")}<select value={draft.recipientKey} onChange={event => session.edit(before => ({ ...before, recipientKey: Number(event.target.value) }))}>
          <option value={-1}>{t("ai.recovery.chooseMember")}</option>{draft.members.map((member, index) => <option key={member.key} value={member.key}>{member.displayName || t("ai.team.memberNumber", { number: String(index + 1) })}</option>)}
        </select></label>
        <label className="field">{t("ai.recovery.entry")}<select value={draft.unitId} onChange={event => session.edit(before => ({ ...before, unitId: event.target.value }))}>
          {plan.scope.map(unit => <option key={unit.unitId} value={unit.unitId}>{unit.nativeKey} · {plan.locale}</option>)}
        </select></label><label className="field">{t("ai.recovery.kind")}<select value={draft.kind} onChange={event => {
          const kind = TeamWorkKindValues.find(kind => kind === event.target.value); if (kind) session.edit(before => ({ ...before, kind }));
        }}>{TeamWorkKindValues.map(kind => <option key={kind} value={kind}>{t(`ai.team.workKinds.${kind}`)}</option>)}</select></label>
        <label className="field">{t("ai.recovery.instructions")}<textarea value={draft.instructions} onChange={event => session.edit(before => ({ ...before, instructions: event.target.value }))}/></label>
        <details open={!!observation?.state.unresolvedWork.length}><summary>{t("ai.recovery.attachments")}</summary><p>{t("ai.recovery.attachmentHelp")}</p>
          {posts.data?.posts.filter(post => post.publication.target.unitId === draft.unitId && post.publication.target.locale === plan.locale).map(post => <label key={post.publication.postId} className="source-check"><input type="checkbox" checked={draft.postIds.includes(post.publication.postId)} onChange={event => session.edit(before => ({ ...before,
            postIds: event.target.checked ? [...before.postIds, post.publication.postId] : before.postIds.filter(id => id !== post.publication.postId) }))}/>{unitNames.get(post.publication.target.unitId)} · {post.publication.target.locale}<pre className="ai-text">{post.publication.body}</pre></label>)}
          <button type="button" className="secondary-button" disabled={posts.isFetching || after === null} onClick={() => setAfter(null)}>{t("ai.team.firstPage")}</button>
          <button type="button" className="secondary-button" disabled={posts.isFetching || !posts.data?.nextAfter} onClick={() => setAfter(posts.data?.nextAfter ?? null)}>{t("ai.teamHistory.nextPage")}</button>
          {observation?.state.unresolvedWork.length ? <fieldset><legend>{t("ai.recovery.unresolvedTitle", { count: observation.state.unresolvedWork.length })}</legend><p>{t("ai.recovery.unresolvedHelp")}</p>
            {observation.state.unresolvedWork.map((reference, index) => <div key={reference.attemptId}><label className="source-check"><input type="checkbox"
              checked={draft.priorWork.some(value => jsonIdentity(value) === jsonIdentity(reference))} onChange={event => session.edit(before => ({ ...before,
                priorWork: event.target.checked ? [...before.priorWork, reference] : before.priorWork.filter(value => jsonIdentity(value) !== jsonIdentity(reference)) }))}/>{t("ai.recovery.unresolvedItem", { number: String(index + 1) })}</label>
              {onOpenTask ? <button type="button" className="secondary-button" onClick={() => { void onOpenTask(reference.taskId, reference.attemptId); }}>{t("ai.team.openTask")}</button> : null}
              <details><summary>{t("ai.team.identityDetails")}</summary><pre className="ai-text">{JSON.stringify(reference, null, 2)}</pre></details>
            </div>)}
          </fieldset> : null}
          <h5>{t("ai.recovery.optionalWork")}</h5>
          {view?.works.filter(work => !observation?.state.unresolvedWork.some(reference => reference.attemptId === work.receipt.attemptId)).map(work => { const reference = { taskId: work.receipt.taskId, attemptId: work.receipt.attemptId, inputDigest: work.receipt.inputDigest };
            return <div key={work.receipt.intentId}><label className="source-check"><input type="checkbox" checked={draft.priorWork.some(value => jsonIdentity(value) === jsonIdentity(reference))}
              onChange={event => session.edit(before => ({ ...before, priorWork: event.target.checked ? [...before.priorWork, reference] : before.priorWork.filter(value => jsonIdentity(value) !== jsonIdentity(reference)) }))}/>
              {unitNames.get(work.target.unitId)} · {work.target.locale} · {t(`ai.states.${work.execution}`)}</label>
              <details><summary>{t("ai.team.identityDetails")}</summary><pre className="ai-text">{JSON.stringify(reference, null, 2)}</pre></details>
            </div>; })}
          <button type="button" className="secondary-button" disabled={team.isFetching || afterWork === null} onClick={() => setAfterWork(null)}>{t("ai.team.firstPage")}</button>
          <button type="button" className="secondary-button" disabled={team.isFetching || !view?.nextWorkAfter} onClick={() => setAfterWork(view?.nextWorkAfter ?? null)}>{t("ai.team.nextWorks")}</button>
          <button type="button" className="secondary-button" disabled={!draft.postIds.length} onClick={() => session.edit(before => ({ ...before, postIds: [] }))}>{t("ai.recovery.clearPosts")}</button>
          <p>{t("ai.recovery.selectedAttachments", { posts: String(draft.postIds.length), works: String(draft.priorWork.length) })}</p>
        </details>
      </fieldset>
      {problem ? <p role="status">{t(`ai.recovery.problems.${problem}`)}</p> : null}
      {button("prepare", true)}{button("discard")}
    </> : null}
    {state.preparing ? <p role="status">{t("ai.recovery.preparing")}</p> : null}
    {capture ? <><TeamRecoveryDisclosure plan={plan} preview={capture.value.preview} unresolvedWork={capture.unresolvedWork} onOpenTask={onOpenTask}/>
      {reviewedTools ? <section><h4>{t("ai.tools.reviewTitle")}</h4>{reviewedTools.entries.map(tool => <article key={tool.handle}><h5>{tool.binding.declaration.title}</h5><p>{tool.binding.declaration.description}</p><PluginPermissions permissions={tool.binding.capability.declaration.permissions}/></article>)}
        <p>{t("sourcePlugin.unsandboxed")}</p><label className="source-check"><input type="checkbox" checked={toolConsent} disabled={session.blocked()} onChange={event => setToolConsent(event.target.checked)}/>{t("ai.tools.consent")}</label>
      </section> : null}
      {applicationTools.groups.map(group => { const key = jsonIdentity(group.basis)!; return <fieldset key={key}><legend>{group.tools[0].binding.declaration.title}</legend><WorkPlanApplicationToolDetails group={group}/>
        <label className="source-check"><input type="checkbox" checked={applicationsConsent.includes(key)} disabled={session.blocked() || !applicationTools.current()} onChange={event => setApplicationsConsent(before => event.target.checked ? [...before, key] : before.filter(value => value !== key))}/>{t("ai.tools.applicationConsent")}</label></fieldset>; })}
      {applicationTools.groups.length ? <WorkPlanApplicationToolObservation observation={applicationTools.observation}/> : null}
      {checkerRequired ? reviewedCheckers.map(checker => checker.kind === "ready" ? <fieldset key={checkerIdentity(checker.checker)}><legend>{t("ai.plan.checkerConsent")}</legend><ReviewCheckerDetails view={checker.plugin}/>
        <label className="source-check"><input type="checkbox" checked={checkerConsent.includes(checkerIdentity(checker.checker))} disabled={session.blocked()} onChange={event => setCheckerConsent(before => event.target.checked ? [...before, checkerIdentity(checker.checker)] : before.filter(value => value !== checkerIdentity(checker.checker)))}/>{t("ai.plan.checkerConsent")}</label></fieldset> : <p key={checkerIdentity(checker.checker)} role="alert">{t("ai.plan.checkerUnavailable")}</p>) : null}
      {plan.options.toolGuidance?<p>{t("ai.toolGuidanceSharing.confirmation")}</p>:null}
      <label className="source-check"><input type="checkbox" checked={state.consent} disabled={session.blocked() || !basisCurrent || !session.connectionCurrent()} onChange={event => session.setConsent(event.target.checked)}/>{t(plan.options.teamDiscussions?.profile === "current-plan-2" ? "ai.recovery.artifactConsent" : "ai.recovery.consent")}</label>
      {button("authorize", true)}
    </> : null}
    {ready ? <div role="status"><p>{t("ai.recovery.authorized")}</p>{button("start", true)}{button("end")}</div> : null}
    {pending ? <div role="status"><p>{t(pending.kind === "close" ? pending.phase === "sending" ? "ai.recovery.closing" : pending.phase === "checking" ? "ai.recovery.checkingClose" : "ai.recovery.closeUnknown"
      : pending.phase === "checking" ? "ai.recovery.checking" : pending.phase === "sending" ? "ai.recovery.sending" : "ai.recovery.unknown")}</p>
      {pending.kind === "authorize" && pending.retryAllowed ? <p>{t("ai.recovery.endHelp")}</p> : null}
      {button("check")}{button("retry")}{pending.kind !== "close" ? button("end") : null}</div> : null}
    {state.notice ? <p role="status">{t(`ai.recovery.notices.${state.notice}`)}</p> : null}
  </section>;
}
