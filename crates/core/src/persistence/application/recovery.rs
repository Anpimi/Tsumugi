//! Fresh human authorization versions use the original application action ledger.
use super::{ProjectStore, control, coordination, team};
use crate::{ai, application::*, execution::*};
use rusqlite::{Connection, OptionalExtension, params};

fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn denied() -> ExecutionError {
    fail(ErrorCode::Unauthorized, "team-recovery")
}
fn corrupt() -> ExecutionError {
    fail(ErrorCode::CorruptLedger, "team-recovery-facts")
}
fn sql(_: rusqlite::Error) -> ExecutionError {
    fail(ErrorCode::StorageFailed, "team-recovery-storage")
}

pub(super) fn action(
    c: &Connection,
    id: ExecutionId,
) -> Result<Option<(control::Request, WorkPlanReceipt)>, ExecutionError> {
    let row:Option<(Vec<u8>,String,Vec<u8>,String)>=c.query_row("SELECT request,request_digest,receipt,receipt_digest FROM application_actions WHERE action_id=?1",[id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(sql)?;
    row.map(|(request, digest, receipt, receipt_digest)| {
        if codec::digest(&request) != digest || codec::digest(&receipt) != receipt_digest {
            return Err(corrupt());
        }
        let request: control::Request = codec::decode(&request, MAX_INPUT_BYTES)?;
        let receipt: WorkPlanReceipt = codec::decode(&receipt, MAX_INPUT_BYTES)?;
        if request.action() != id
            || receipt.action_id != id
            || receipt.lease.plan_id != request.plan()
        {
            return Err(corrupt());
        }
        Ok((request, receipt))
    })
    .transpose()
}
fn records(c: &Connection, plan: ExecutionId) -> Result<Vec<ExecutionId>, ExecutionError> {
    let mut q = c
        .prepare("SELECT action_id FROM application_actions WHERE plan_id=?1")
        .map_err(sql)?;
    q.query_map([plan.to_string()], |r| r.get::<_, String>(0))
        .map_err(sql)?
        .map(|r| ExecutionId::parse(&r.map_err(sql)?))
        .collect()
}
pub(super) fn capture_at(
    c: &Connection,
    plan: ExecutionId,
    generation: Revision,
) -> Result<Option<(TeamRecoveryCapture, WorkPlanReceipt)>, ExecutionError> {
    let mut latest: Option<(TeamRecoveryCapture, WorkPlanReceipt)> = None;
    for id in records(c, plan)? {
        if let Some((control::Request::TeamRecovery { capture, .. }, receipt)) = action(c, id)? {
            if receipt.lease.generation <= generation
                && latest
                    .as_ref()
                    .is_none_or(|(_, r)| r.lease.generation < receipt.lease.generation)
            {
                latest = Some((*capture, receipt));
            }
        }
    }
    Ok(latest)
}
pub(super) fn plan_in(
    c: &Connection,
    plan: ExecutionId,
    generation: Revision,
) -> Result<WorkPlan, ExecutionError> {
    if let Some((capture, _)) = capture_at(c, plan, generation)? {
        return effective_plan(&capture);
    }
    Ok(control::load(c, plan)?.plan)
}
fn effective_plan(capture: &TeamRecoveryCapture) -> Result<WorkPlan, ExecutionError> {
    // The stored base retains its own digest. This projection is constrained by
    // the separate recovery capture, never authorized as a replacement base.
    let root = ai::settings(&capture.plan.fixed_input()?)?.config;
    let mut plan = capture.plan.clone();
    let Some(TeamExecutionPolicy::BoundedTeamV1 { members, .. }) =
        plan.options.team_execution.as_mut()
    else {
        return Err(denied());
    };
    *members = capture.preview.members.clone();
    plan.team_inputs = capture.team_inputs.clone();
    plan.validate_team_members(&root, false)?;
    Ok(plan)
}
pub(super) fn effective_version(
    c: &Connection,
    plan: ExecutionId,
    generation: Revision,
) -> Result<TeamEffectiveVersion, ExecutionError> {
    if let Some((capture, receipt)) = capture_at(c, plan, generation)? {
        return Ok(TeamEffectiveVersion {
            action_id: receipt.action_id,
            lease: receipt.lease,
            digest: capture.preview.digest,
        });
    }
    for id in records(c, plan)? {
        if let Some((control::Request::Authorize { request, .. }, receipt)) = action(c, id)? {
            return Ok(TeamEffectiveVersion {
                action_id: id,
                lease: receipt.lease,
                digest: request.plan_digest,
            });
        }
    }
    Err(corrupt())
}
fn digest(capture: &TeamRecoveryCapture) -> Result<String, ExecutionError> {
    let mut capture = capture.clone();
    capture.preview.digest.clear();
    Ok(codec::digest(&codec::encode(&capture, MAX_INPUT_BYTES)?))
}
pub(super) fn retired(c: &Connection, plan: &WorkPlan) -> Result<Vec<ExecutionId>, ExecutionError> {
    let active = plan
        .options
        .team_execution
        .as_ref()
        .ok_or_else(denied)?
        .members();
    let mut q=c.prepare("SELECT member_id FROM application_team_members WHERE plan_id=?1 ORDER BY member_id LIMIT 9").map_err(sql)?;
    let mut result = Vec::new();
    for id in q
        .query_map([plan.plan_id.to_string()], |r| r.get::<_, String>(0))
        .map_err(sql)?
    {
        let id = ExecutionId::parse(&id.map_err(sql)?)?;
        if !active.iter().any(|m| m.member_id == id) {
            result.push(id);
        }
    }
    Ok(result)
}
fn validate_prior(
    c: &Connection,
    plan: ExecutionId,
    prior: &[TeamWorkReference],
) -> Result<(), ExecutionError> {
    if prior.len() > 16
        || prior
            .iter()
            .enumerate()
            .any(|(i, r)| prior[..i].iter().any(|p| p.attempt_id == r.attempt_id))
    {
        return Err(denied());
    }
    for reference in prior {
        let found:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM application_team_work WHERE plan_id=?1 AND task_id=?2 AND attempt_id=?3)",params![plan.to_string(),reference.task_id.to_string(),reference.attempt_id.to_string()],|r|r.get(0)).map_err(sql)?;
        let input = super::super::ledger::load_input(c, reference.attempt_id)?;
        if !found
            || input.envelope().task_id != reference.task_id
            || input.digest() != reference.input_digest
        {
            return Err(denied());
        }
    }
    Ok(())
}
pub(super) fn unresolved(
    c: &Connection,
    plan: ExecutionId,
) -> Result<Vec<TeamWorkReference>, ExecutionError> {
    let mut q=c.prepare("SELECT w.attempt_id FROM application_team_work w JOIN execution_items i USING(attempt_id) WHERE w.plan_id=?1 AND (i.execution IN ('queued','dispatched','unknown') OR i.validation='pending') ORDER BY w.sequence LIMIT 301").map_err(sql)?;
    let mut result = Vec::new();
    for id in q
        .query_map([plan.to_string()], |r| r.get::<_, String>(0))
        .map_err(sql)?
    {
        let input = super::super::ledger::load_input(c, ExecutionId::parse(&id.map_err(sql)?)?)?;
        result.push(TeamWorkReference {
            task_id: input.envelope().task_id,
            attempt_id: input.envelope().attempt_id,
            input_digest: input.digest().into(),
        });
    }
    Ok(result)
}
fn discussion_previews(
    c: &Connection,
    plan: &WorkPlan,
    inputs: &[TeamMemberInput],
    through: Option<Revision>,
) -> Result<Vec<TeamRecoveryDiscussionPreview>, ExecutionError> {
    let mut posts = team::all_posts(c, plan.plan_id)?;
    if let Some(through) = through {
        posts.retain(|post| post.sequence <= through);
    }
    let mut previews = Vec::new();
    let mut size = 0usize;
    for member in plan
        .options
        .team_execution
        .as_ref()
        .ok_or_else(denied)?
        .members()
    {
        for item in &inputs
            .iter()
            .find(|i| i.member_id == member.member_id)
            .ok_or_else(corrupt)?
            .items
        {
            let target = TeamDiscussionTarget {
                unit_id: item.unit_id,
                locale: item.target_locale.clone(),
                source_snapshot_id: item.source_snapshot_id,
                source_revision_id: item.source_revision_id,
            };
            let mut selected = Vec::new();
            let mut artifacts = Vec::new();
            for post in posts.iter().filter(|p| p.publication.target == target) {
                let bytes = codec::encode(post, 32768)?;
                size = size.checked_add(bytes.len()).ok_or_else(corrupt)?;
                if selected.len() >= 16 || size > MAX_INPUT_BYTES {
                    return Err(fail(ErrorCode::LimitExceeded, "team-recovery-material"));
                }
                team::check_references(c, plan, &target, &post.publication.references)?;
                if matches!(
                    plan.options.team_discussions,
                    Some(TeamDiscussionPolicy::CurrentPlanV2 {})
                ) {
                    for (index, reference) in post.publication.references.iter().enumerate() {
                        let body =
                            team::artifact_in(c, plan, &target, reference, &item.native_key)?;
                        let read = TeamArtifactRead {
                            kind: TeamArtifactReadKind::UntrustedTeamArtifact,
                            post_id: post.publication.post_id,
                            reference_index: index.try_into().map_err(|_| corrupt())?,
                            target: target.clone(),
                            artifact: body,
                        };
                        size = size
                            .checked_add(codec::encode(&read, 32768)?.len())
                            .ok_or_else(corrupt)?;
                        if size > MAX_INPUT_BYTES {
                            return Err(fail(ErrorCode::LimitExceeded, "team-recovery-material"));
                        }
                        artifacts.push(read);
                    }
                }
                selected.push(post.clone());
            }
            codec::encode(
                &selected,
                TeamDiscussionLimits::current_plan().max_view_bytes as usize,
            )?;
            previews.push(TeamRecoveryDiscussionPreview {
                member_id: member.member_id,
                target,
                through_sequence: posts.last().map_or(Revision::new(0)?, |p| p.sequence),
                posts: selected,
                artifacts,
            });
        }
    }
    Ok(previews)
}

impl ProjectStore {
    pub fn read_team_recovery_state(
        &self,
        project: ExecutionId,
        plan: ExecutionId,
    ) -> Result<TeamRecoveryState, ExecutionError> {
        let c = self.connection().map_err(|_| denied())?;
        let stored = control::load(c, plan)?;
        if stored.plan.project_id != project {
            return Err(denied());
        }
        let root = stored.plan.execution_input()?.task_id;
        let (activations, unconfirmed_completions) = coordination::counts(c, plan)?;
        Ok(TeamRecoveryState {
            project_id: project,
            plan_id: plan,
            lease: stored.lease,
            state: stored.state,
            effective_version: effective_version(c, plan, stored.lease.generation)?,
            root_task_id: root,
            expires_at_ms: stored.expires_at.checked_mul(1000).ok_or_else(corrupt)?,
            budget: super::super::ledger::provider::provider_budget_in(c, root)?
                .ok_or_else(denied)?,
            activations,
            unconfirmed_completions,
            unresolved_work: unresolved(c, plan)?,
        })
    }
    pub(crate) fn capture_team_recovery(
        &self,
        request: &PrepareTeamRecovery,
    ) -> Result<TeamRecoveryCapture, ExecutionError> {
        self.capture_team_recovery_input(request, None)
    }
    pub(crate) fn check_team_recovery_capture(
        &self,
        prepared: &PreparedTeamRecovery,
    ) -> Result<(), ExecutionError> {
        let current =
            self.capture_team_recovery_input(&prepared.capture.request, Some(&prepared.capture))?;
        if current != prepared.capture {
            return Err(fail(ErrorCode::DependencyConflict, "team-recovery-capture"));
        }
        Ok(())
    }
    fn capture_team_recovery_input(
        &self,
        request: &PrepareTeamRecovery,
        fixed: Option<&TeamRecoveryCapture>,
    ) -> Result<TeamRecoveryCapture, ExecutionError> {
        let c = self.connection().map_err(|_| denied())?;
        super::super::review::read_snapshot(c, |c| {
            let stored = control::load(c, request.plan_id)?;
            if stored.plan.project_id != request.project_id
                || stored.lease != request.expected_lease
                || !matches!(
                    stored.state,
                    WorkPlanState::Paused | WorkPlanState::TakenOver
                )
                || stored.expires_at <= control::now()?
                || effective_version(c, request.plan_id, stored.lease.generation)?
                    != request.expected_effective_version
            {
                return Err(denied());
            }
            let original = stored.plan.clone();
            let mut plan = plan_in(c, request.plan_id, stored.lease.generation)?;
            let old_members = plan
                .options
                .team_execution
                .as_ref()
                .ok_or_else(denied)?
                .members()
                .to_vec();
            let limits = plan
                .options
                .team_execution
                .as_ref()
                .ok_or_else(denied)?
                .limits();
            let existing: u32 = c
                .query_row(
                    "SELECT COUNT(*) FROM application_team_members WHERE plan_id=?1",
                    [plan.plan_id.to_string()],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            let mut new_count = 0;
            for member in &request.members {
                let owner: Option<String> = c
                    .query_row(
                        "SELECT plan_id FROM application_team_members WHERE member_id=?1",
                        [member.member_id.to_string()],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(sql)?;
                let old = old_members.iter().find(|m| m.member_id == member.member_id);
                if let Some(owner) = owner {
                    if owner != plan.plan_id.to_string() || old.is_none() {
                        return Err(denied());
                    }
                } else {
                    new_count += 1;
                }
                if let Some(old) = old {
                    if old != member && old.role_version_id == member.role_version_id {
                        return Err(fail(ErrorCode::ResultMismatch, "team-role-version"));
                    }
                }
                if old.is_none_or(|old| old.role_version_id != member.role_version_id) {
                    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM application_team_roles WHERE version_id=?1)",[member.role_version_id.to_string()],|r|r.get(0)).map_err(sql)?;
                    let ordinal: u32 = c
                        .query_row(
                            "SELECT COUNT(*) FROM application_team_roles WHERE member_id=?1",
                            [member.member_id.to_string()],
                            |r| r.get(0),
                        )
                        .map_err(sql)?;
                    if exists || ordinal >= 16 {
                        return Err(fail(ErrorCode::LimitExceeded, "team-roles"));
                    }
                }
            }
            if existing + new_count > 8 {
                return Err(fail(ErrorCode::LimitExceeded, "team-members"));
            }
            let Some(TeamExecutionPolicy::BoundedTeamV1 { members, .. }) =
                plan.options.team_execution.as_mut()
            else {
                return Err(denied());
            };
            *members = request.members.clone();
            let mut inputs = Vec::new();
            let mut bytes = 0usize;
            for member in &request.members {
                let preview =
                    self.preview_ai(member.config.clone(), &plan.locale, &member.unit_ids)?;
                bytes = bytes.saturating_add(codec::encode(&preview, MAX_INPUT_BYTES)?.len());
                if bytes > MAX_INPUT_BYTES {
                    return Err(fail(ErrorCode::LimitExceeded, "team-recovery-material"));
                }
                inputs.push(TeamMemberInput {
                    member_id: member.member_id,
                    items: preview.items,
                });
            }
            plan.team_inputs = inputs.clone();
            plan.validate_team_members(&ai::settings(&original.fixed_input()?)?.config, false)?;
            for member in &inputs {
                for item in &member.items {
                    if !original.selection_basis.iter().any(|b| {
                        b.unit_id == item.unit_id
                            && b.source_revision_id == item.source_revision_id
                            && b.source_snapshot_id == item.source_snapshot_id
                    }) {
                        return Err(fail(ErrorCode::DependencyConflict, "team-recovery-source"));
                    }
                }
            }
            let work = &request.work;
            let used: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM application_team_work WHERE intent_id=?1)",
                    [work.work_id.to_string()],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            if used {
                return Err(fail(ErrorCode::ResultMismatch, "team-recovery-work"));
            }
            for id in records(c, plan.plan_id)? {
                if let Some((control::Request::TeamRecovery { capture, .. }, _)) = action(c, id)? {
                    if capture.preview.work.work_id == work.work_id {
                        return Err(fail(ErrorCode::ResultMismatch, "team-recovery-work"));
                    }
                }
            }
            if work.instructions.trim().is_empty()
                || work.instructions.len() > 8192
                || work.post_ids.len() > 16
            {
                return Err(denied());
            }
            validate_prior(c, plan.plan_id, &work.prior_work)?;
            for prior in unresolved(c, plan.plan_id)? {
                if !work.prior_work.contains(&prior) {
                    return Err(fail(ErrorCode::OutcomeUnknown, "team-recovery-unresolved"));
                }
            }
            let selected = request
                .members
                .iter()
                .find(|m| m.member_id == work.member_id)
                .ok_or_else(denied)?;
            if !selected.kinds.contains(&work.kind)
                || !selected.unit_ids.contains(&work.target.unit_id)
            {
                return Err(denied());
            }
            let selected_item = inputs
                .iter()
                .find(|i| i.member_id == work.member_id)
                .and_then(|i| i.items.iter().find(|i| i.unit_id == work.target.unit_id))
                .ok_or_else(denied)?;
            if work.target
                != (TeamDiscussionTarget {
                    unit_id: selected_item.unit_id,
                    locale: selected_item.target_locale.clone(),
                    source_snapshot_id: selected_item.source_snapshot_id,
                    source_revision_id: selected_item.source_revision_id,
                })
            {
                return Err(denied());
            }
            for post in &work.post_ids {
                let post = team::post(c, *post)?.ok_or_else(denied)?;
                if post.plan_id != plan.plan_id || post.publication.target != work.target {
                    return Err(denied());
                }
            }
            let state = self.read_team_recovery_state(request.project_id, request.plan_id)?;
            if state.activations >= limits.max_activations
                || state.unconfirmed_completions >= limits.max_no_progress
                || state
                    .budget
                    .dispatched
                    .saturating_add(state.budget.legacy_held)
                    >= state.budget.limit
            {
                return Err(fail(ErrorCode::LimitExceeded, "team-stopped"));
            }
            let task = fixed.map_or_else(ExecutionId::new, |c| c.preview.task_id);
            let attempt = fixed.map_or_else(ExecutionId::new, |c| c.preview.attempt_id);
            let lease = AutomationLease {
                plan_id: plan.plan_id,
                generation: stored.lease.generation.next()?,
            };
            let scope = if let Some(capture) = fixed {
                ai::team::settings(&FixedInput::capture(capture.input.clone())?)?
                    .binding
                    .scope()
                    .clone()
            } else {
                coordination::scope_for(
                    &plan,
                    lease,
                    selected,
                    ExecutionId::new(),
                    ExecutionId::new(),
                )
            };
            let binding = TeamWorkBinding::HumanContinuation {
                work_id: work.work_id,
                member_id: selected.member_id,
                role_version_id: selected.role_version_id,
                scope,
            };
            let derived = RequestTeamWork {
                intent_id: work.work_id,
                recipient_member_id: work.member_id,
                target: work.target.clone(),
                kind: work.kind,
                instructions: work.instructions.clone(),
                post_ids: work.post_ids.clone(),
                cause_message_id: None,
            };
            let input = coordination::derive(
                &plan,
                &original.fixed_input()?,
                lease,
                selected.member_id,
                work.target.unit_id,
                task,
                attempt,
                binding,
                Some(&derived),
            )?;
            let preview = TeamRecoveryPreview {
                project_id: request.project_id,
                plan_id: plan.plan_id,
                base_lease: stored.lease,
                base_effective_version: request.expected_effective_version.clone(),
                digest: String::new(),
                members: request.members.clone(),
                retired_member_ids: retired(c, &plan)?,
                member_previews: plan.team_member_previews()?,
                discussion_previews: discussion_previews(c, &plan, &inputs, None)?,
                work: work.clone(),
                task_id: task,
                attempt_id: attempt,
                input_digest: input.digest().into(),
                root_task_id: state.root_task_id,
                expires_at_ms: state.expires_at_ms,
                limits,
                budget: state.budget,
                activations: state.activations,
                unconfirmed_completions: state.unconfirmed_completions,
            };
            let mut capture = TeamRecoveryCapture {
                preview,
                request: request.clone(),
                plan: original,
                team_inputs: inputs,
                input: input.envelope().clone(),
            };
            capture.preview.digest = digest(&capture)?;
            codec::encode(&capture, MAX_INPUT_BYTES)?;
            Ok(capture)
        })
    }
    pub fn read_team_recovery_action(
        &self,
        project: ExecutionId,
        request: &AuthorizeTeamRecovery,
    ) -> Result<Option<TeamRecoveryReceipt>, ExecutionError> {
        let c = self.connection().map_err(|_| denied())?;
        let value = super::super::review::read_snapshot(c, |c| {
            if super::super::read_metadata_from(c)
                .map_err(|_| corrupt())?
                .project_id()
                .to_string()
                != project.to_string()
            {
                return Err(denied());
            }
            let Some((record, receipt)) = action(c, request.action_id)? else {
                return Ok(None);
            };
            let control::Request::TeamRecovery {
                request: old,
                capture,
            } = record
            else {
                return Err(fail(ErrorCode::ResultMismatch, "team-recovery-action"));
            };
            if old != *request || capture.plan.project_id != project {
                return Err(fail(ErrorCode::ResultMismatch, "team-recovery-action"));
            }
            validate_receipt(
                &capture,
                request,
                &receipt,
                &control::load(c, capture.plan.plan_id)?,
            )?;
            receipt_view(&capture, &receipt).map(Some)
        })?;
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(value)
    }
    pub fn team_recovery_action_plan(
        &self,
        project: ExecutionId,
        request: &AuthorizeTeamRecovery,
    ) -> Result<Option<WorkPlan>, ExecutionError> {
        if self.read_team_recovery_action(project, request)?.is_none() {
            return Ok(None);
        }
        let Some((control::Request::TeamRecovery { capture, .. }, _)) =
            action(self.connection().map_err(|_| denied())?, request.action_id)?
        else {
            return Err(corrupt());
        };
        Ok(Some(capture.plan))
    }
    pub(crate) fn commit_team_recovery(
        &mut self,
        prepared: &PreparedTeamRecovery,
        authorization: &AuthorizeTeamRecovery,
    ) -> Result<TeamRecoveryReceipt, ExecutionError> {
        let capture = &prepared.capture;
        if let Some(receipt) =
            self.read_team_recovery_action(capture.plan.project_id, authorization)?
        {
            return Ok(receipt);
        }
        if !authorization.confirmed
            || authorization.digest != capture.preview.digest
            || digest(capture)? != capture.preview.digest
            || authorization.effects != capture.plan.authorization_effects()?
        {
            return Err(denied());
        }
        let mut tx = self.execution_write()?;
        let stored = control::load(&tx, capture.plan.plan_id)?;
        if stored.lease != capture.preview.base_lease
            || !matches!(
                stored.state,
                WorkPlanState::Paused | WorkPlanState::TakenOver
            )
            || stored.expires_at <= control::now()?
            || effective_version(&tx, stored.plan.plan_id, stored.lease.generation)?
                != capture.preview.base_effective_version
        {
            return Err(denied());
        }
        let current = self.capture_team_recovery_input(&capture.request, Some(capture))?;
        if current != *capture {
            return Err(fail(ErrorCode::DependencyConflict, "team-recovery-capture"));
        }
        let lease = AutomationLease {
            plan_id: stored.plan.plan_id,
            generation: stored.lease.generation.next()?,
        };
        let cancellation =
            super::super::ledger::cancel_revision(&tx, stored.plan.execution_input()?.task_id)?;
        install_roles(&tx, capture, lease.generation)?;
        tx.execute("UPDATE application_plans SET generation=?2,state='active',cancellation_revision=?3 WHERE plan_id=?1",params![lease.plan_id.to_string(),lease.generation.get() as i64,cancellation.get() as i64]).map_err(sql)?;
        let receipt = WorkPlanReceipt {
            action_id: authorization.action_id,
            cancellation_revision: cancellation,
            lease,
            state: WorkPlanState::Active,
            input: Some(capture.input.clone()),
            parent_task: Some(capture.preview.root_task_id),
        };
        let request = control::Request::TeamRecovery {
            request: authorization.clone(),
            capture: Box::new(capture.clone()),
        };
        control::save(&tx, &request, &receipt)?;
        tx.observer.add_scope(super::super::ChangeScope::Project);
        super::super::ledger::commit(tx)?;
        receipt_view(capture, &receipt)
    }
    pub fn prepare_team_start(
        &self,
        lease: AutomationLease,
        action_id: ExecutionId,
    ) -> Result<PreparedTeamWork, ExecutionError> {
        let c = self.connection().map_err(|_| denied())?;
        match action(c, action_id)?.ok_or_else(denied)?.0 {
            control::Request::Authorize { .. } => self.prepare_team_root(lease, action_id),
            control::Request::TeamRecovery { .. } => self.prepare_team_human_work(lease, action_id),
            _ => Err(denied()),
        }
    }
    pub fn prepare_team_human_work(
        &self,
        lease: AutomationLease,
        action_id: ExecutionId,
    ) -> Result<PreparedTeamWork, ExecutionError> {
        let c = self.connection().map_err(|_| denied())?;
        let Some((control::Request::TeamRecovery { capture, .. }, receipt)) = action(c, action_id)?
        else {
            return Err(denied());
        };
        let current = control::load(c, lease.plan_id)?;
        if receipt.lease != lease
            || current.lease != lease
            || current.state != WorkPlanState::Active
        {
            return Err(denied());
        }
        Ok(PreparedTeamWork {
            scope: None,
            author: None,
            request: None,
            input: FixedInput::capture(capture.input)?,
            receipt: TeamWorkReceipt {
                intent_id: capture.preview.work.work_id,
                plan_id: lease.plan_id,
                member_id: capture.preview.work.member_id,
                role_version_id: ai::team::settings(&FixedInput::capture(
                    receipt.input.clone().ok_or_else(corrupt)?,
                )?)?
                .binding
                .role_version_id(),
                task_id: capture.preview.task_id,
                attempt_id: capture.preview.attempt_id,
                input_digest: capture.preview.input_digest,
            },
            authorization_action: Some(action_id),
        })
    }
    pub(crate) fn team_input_belongs(
        &self,
        input: &FixedInput,
        plan: ExecutionId,
    ) -> Result<bool, ExecutionError> {
        let c = self.connection().map_err(|_| denied())?;
        let root = control::load(c, plan)?.plan.execution_input()?.task_id;
        Ok(input.envelope().automation.is_some_and(|l|l.plan_id==plan) || c.query_row("SELECT EXISTS(SELECT 1 FROM application_executions WHERE attempt_id=?1 AND plan_id=?2) OR EXISTS(SELECT 1 FROM execution_budget_ancestry WHERE task_id=?3 AND ancestor_id=?4)",params![input.envelope().attempt_id.to_string(),plan.to_string(),input.envelope().task_id.to_string(),root.to_string()],|r|r.get(0)).map_err(sql)?)
    }
}
fn install_roles(
    c: &Connection,
    capture: &TeamRecoveryCapture,
    generation: Revision,
) -> Result<(), ExecutionError> {
    let old = plan_in(
        c,
        capture.plan.plan_id,
        capture.preview.base_lease.generation,
    )?;
    for member in &capture.preview.members {
        let prior = old
            .options
            .team_execution
            .as_ref()
            .ok_or_else(denied)?
            .members()
            .iter()
            .find(|m| m.member_id == member.member_id);
        if prior == Some(member) {
            continue;
        }
        c.execute("INSERT INTO application_team_members(member_id,plan_id,task_id) VALUES(?1,?2,NULL) ON CONFLICT(member_id) DO NOTHING",params![member.member_id.to_string(),capture.plan.plan_id.to_string()]).map_err(sql)?;
        let ordinal: u32 = c
            .query_row(
                "SELECT COUNT(*)+1 FROM application_team_roles WHERE member_id=?1",
                [member.member_id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        let role = TeamMemberRole {
            plan_id: capture.plan.plan_id,
            version: Revision::new(ordinal.into())?,
            generation,
            request: TeamMemberRoleWrite {
                member_id: member.member_id,
                role_version_id: member.role_version_id,
                expected_role_version_id: prior.map(|m| m.role_version_id),
                display_name: member.display_name.clone(),
                role: member.role.clone(),
            },
            config: member.config.clone(),
        };
        let bytes = codec::encode(&role, 32768)?;
        c.execute(
            "INSERT INTO application_team_roles VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                member.role_version_id.to_string(),
                member.member_id.to_string(),
                ordinal,
                prior.map(|m| m.role_version_id.to_string()),
                bytes,
                codec::digest(&bytes)
            ],
        )
        .map_err(sql)?;
    }
    Ok(())
}
fn receipt_view(
    capture: &TeamRecoveryCapture,
    receipt: &WorkPlanReceipt,
) -> Result<TeamRecoveryReceipt, ExecutionError> {
    if digest(capture)? != capture.preview.digest {
        return Err(corrupt());
    }
    Ok(TeamRecoveryReceipt {
        action_id: receipt.action_id,
        base_lease: capture.preview.base_lease,
        effective_version: TeamEffectiveVersion {
            action_id: receipt.action_id,
            lease: receipt.lease,
            digest: capture.preview.digest.clone(),
        },
        state: receipt.state,
        cancellation_revision: receipt.cancellation_revision,
        work_id: capture.preview.work.work_id,
        task_id: capture.preview.task_id,
        attempt_id: capture.preview.attempt_id,
        input_digest: capture.preview.input_digest.clone(),
    })
}
pub(super) fn validate_receipt(
    capture: &TeamRecoveryCapture,
    request: &AuthorizeTeamRecovery,
    receipt: &WorkPlanReceipt,
    stored: &control::StoredPlan,
) -> Result<(), ExecutionError> {
    if !request.confirmed
        || request.digest != capture.preview.digest
        || digest(capture)? != request.digest
        || capture.plan != stored.plan
        || request.effects != stored.effects
        || receipt.action_id != request.action_id
        || receipt.lease.plan_id != stored.plan.plan_id
        || receipt.lease.generation != capture.preview.base_lease.generation.next()?
        || receipt.state != WorkPlanState::Active
        || receipt.input.as_ref() != Some(&capture.input)
        || receipt.parent_task != Some(capture.preview.root_task_id)
    {
        return Err(corrupt());
    }
    let input = FixedInput::capture(capture.input.clone())?;
    if input.digest() != capture.preview.input_digest
        || input.envelope().automation != Some(receipt.lease)
        || !matches!(ai::team::settings(&input)?.binding,TeamWorkBinding::HumanContinuation{work_id,..} if work_id==capture.preview.work.work_id)
    {
        return Err(corrupt());
    }
    effective_plan(capture)?;
    Ok(())
}
pub(super) fn acknowledged_unknown(
    c: &Connection,
    plan: ExecutionId,
    attempt: ExecutionId,
) -> Result<bool, ExecutionError> {
    let stored = control::load(c, plan)?;
    Ok(
        capture_at(c, plan, stored.lease.generation)?.is_some_and(|(capture, _)| {
            capture
                .preview
                .work
                .prior_work
                .iter()
                .any(|p| p.attempt_id == attempt)
        }),
    )
}

/// Frozen captures retain their original materials after later posts or controls.
pub(super) fn validate_history_in(
    c: &Connection,
    capture: &TeamRecoveryCapture,
    receipt: &WorkPlanReceipt,
) -> Result<(), ExecutionError> {
    let p = &capture.preview;
    let effective = effective_plan(capture)?;
    if capture.request.project_id != capture.plan.project_id
        || capture.request.plan_id != capture.plan.plan_id
        || capture.request.expected_lease != p.base_lease
        || capture.request.expected_effective_version != p.base_effective_version
        || capture.request.members != p.members
        || capture.request.work != p.work
        || p.project_id != capture.plan.project_id
        || p.plan_id != capture.plan.plan_id
        || p.root_task_id != capture.plan.execution_input()?.task_id
        || p.task_id != capture.input.task_id
        || p.attempt_id != capture.input.attempt_id
        || p.members
            != effective
                .options
                .team_execution
                .as_ref()
                .ok_or_else(corrupt)?
                .members()
        || p.member_previews != effective.team_member_previews()?
        || p.limits
            != effective
                .options
                .team_execution
                .as_ref()
                .ok_or_else(corrupt)?
                .limits()
        || p.base_effective_version != effective_version(c, p.plan_id, p.base_lease.generation)?
        || p.work.instructions.trim().is_empty()
        || p.work.instructions.len() > 8192
        || p.work.post_ids.len() > 16
    {
        return Err(corrupt());
    }
    validate_prior(c, p.plan_id, &p.work.prior_work)?;
    let settings = ai::team::settings(&FixedInput::capture(capture.input.clone())?)?;
    let selected = p
        .members
        .iter()
        .find(|m| m.member_id == p.work.member_id)
        .ok_or_else(corrupt)?;
    let subset = settings.binding.scope();
    let expected_scope = coordination::scope_for(
        &effective,
        receipt.lease,
        selected,
        subset.caller_id,
        subset
            .delegation
            .as_ref()
            .ok_or_else(corrupt)?
            .parent_scope_id,
    );
    if *subset != expected_scope
        || !matches!(settings.binding,TeamWorkBinding::HumanContinuation{work_id,..} if work_id==p.work.work_id)
        || settings.cause_message_id.is_some()
    {
        return Err(corrupt());
    }
    let request = RequestTeamWork {
        intent_id: p.work.work_id,
        recipient_member_id: p.work.member_id,
        target: p.work.target.clone(),
        kind: p.work.kind,
        instructions: p.work.instructions.clone(),
        post_ids: p.work.post_ids.clone(),
        cause_message_id: None,
    };
    let expected = coordination::derive(
        &effective,
        &capture.plan.fixed_input()?,
        receipt.lease,
        p.work.member_id,
        p.work.target.unit_id,
        p.task_id,
        p.attempt_id,
        settings.binding,
        Some(&request),
    )?;
    if expected.envelope() != &capture.input
        || team::target(&expected, expected.envelope().items[0].item_id)? != p.work.target
    {
        return Err(corrupt());
    }
    let through = p
        .discussion_previews
        .first()
        .map(|v| v.through_sequence)
        .ok_or_else(corrupt)?;
    if p.discussion_previews
        .iter()
        .any(|v| v.through_sequence != through)
        || discussion_previews(c, &effective, &capture.team_inputs, Some(through))?
            != p.discussion_previews
    {
        return Err(corrupt());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
