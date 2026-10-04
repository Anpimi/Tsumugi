//! Work plans use the existing project and execution authorities.
mod control;
use super::ProjectStore;
use crate::{
    ai::{self, AiConfig},
    application::{PlanOptions, PlanSelectionBasis, WorkPlan},
    execution::{ErrorCode, ExecutionError, ExecutionId},
};
pub(super) use control::{
    allows_cancelled_ancestor, check_enqueue, check_input, initialize, protect_manual_in,
    record_input, stop_execution_plan_in, table_names, validate,
};

impl ProjectStore {
    pub fn prepare_work_plan(
        &self,
        config: Option<AiConfig>,
        locale: &str,
        units: &[ExecutionId],
        options: PlanOptions,
    ) -> Result<WorkPlan, ExecutionError> {
        options.validate()?;
        let connection = self
            .connection()
            .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "work-plan-read"))?;
        super::review::read_snapshot(connection, |_| {
            let project = self
                .metadata()
                .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "work-plan-read"))?
                .project_id();
            let project_id = ExecutionId::parse(&project.to_string())?;
            if units.is_empty()
                || units.len() > 1000
                || units
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != units.len()
            {
                return Err(ExecutionError::new(
                    ErrorCode::LimitExceeded,
                    "work-plan-scope",
                ));
            }
            let mut selection_basis = Vec::with_capacity(units.len());
            for target in super::review::targets_in(connection, project_id, units, locale)? {
                selection_basis.push(PlanSelectionBasis {
                    unit_id: target.unit_id,
                    source_snapshot_id: target.source_snapshot_id,
                    source_revision_id: target.source_revision_id,
                    native_key: target.native_key,
                    selection_id: target.selection_id,
                });
            }
            if options.requests(crate::application::AutomationEffect::SaveCandidate) {
                let config = config.ok_or_else(|| {
                    ExecutionError::new(ErrorCode::InvalidInput, "work-plan-model")
                })?;
                let preview = self.preview_ai(config, locale, units)?;
                WorkPlan::capture(project, preview, selection_basis, options)
            } else {
                if config.is_some() {
                    return Err(ExecutionError::new(
                        ErrorCode::InvalidInput,
                        "work-plan-model-unused",
                    ));
                }
                WorkPlan::capture_manual(project, locale.into(), selection_basis, options)
            }
        })
    }

    /// Compare current evidence. A successful comparison does not grant effects;
    /// an execution/adoption transaction must still check its durable authority.
    pub fn verify_work_plan(&self, plan: &WorkPlan) -> Result<(), ExecutionError> {
        plan.validate()?;
        let connection = self
            .connection()
            .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "work-plan-read"))?;
        super::review::read_snapshot(connection, |_| {
            if self
                .metadata()
                .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "work-plan-read"))?
                .project_id()
                .to_string()
                != plan.project_id.to_string()
            {
                return Err(ExecutionError::new(
                    ErrorCode::Unauthorized,
                    "work-plan-project",
                ));
            }
            if plan.input.is_some() {
                let input = plan.fixed_input()?;
                let settings = ai::settings(&input)?;
                let mut items = input
                    .envelope()
                    .items
                    .iter()
                    .map(|item| ai::item_payload(&input, item.item_id))
                    .collect::<Result<Vec<_>, _>>()?;
                items.sort_by_key(|item| item.unit_id);
                let locale = &items[0].target_locale;
                let units = items.iter().map(|item| item.unit_id).collect::<Vec<_>>();
                let mut current = self.preview_ai(settings.config, locale, &units)?;
                current.items.sort_by_key(|item| item.unit_id);
                for (observed, captured) in current.items.iter_mut().zip(&items) {
                    // Global snapshot/resource clocks can advance for unrelated
                    // work. Actual unit revisions and shared query contents below
                    // remain the authority, including an initially empty query.
                    observed.source_snapshot_id = captured.source_snapshot_id;
                    observed.resource_baseline = captured.resource_baseline;
                }
                if current.items != items {
                    return Err(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "work-plan-evidence",
                    ));
                }
            }
            let units = plan
                .selection_basis
                .iter()
                .map(|basis| basis.unit_id)
                .collect::<Vec<_>>();
            let current =
                super::review::targets_in(connection, plan.project_id, &units, &plan.locale)?;
            for basis in &plan.selection_basis {
                if !current.iter().any(|target| {
                    target.unit_id == basis.unit_id
                        && target.source_revision_id == basis.source_revision_id
                        && target.native_key == basis.native_key
                        && target.selection_id == basis.selection_id
                }) {
                    return Err(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "work-plan-selection",
                    ));
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        SaveContext, SaveTranslationRevision,
        application::{AutomationEffect, SelectionPolicy, StageChoice, StageMode, WorkStage},
    };
    use std::fs;

    fn config() -> AiConfig {
        AiConfig {
            endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
            model: "synthetic-model".into(),
            credential_env: String::new(),
            share_context: true,
            ..AiConfig::default()
        }
    }

    fn fixture() -> (tempfile::TempDir, ProjectStore, Vec<ExecutionId>) {
        let (temp, store, _) = super::super::review::tests::current_release_fixture(false);
        let source = store
            .source_content(
                store.content_scope().unwrap().current_snapshot.unwrap(),
                0,
                10,
            )
            .unwrap();
        let units = source
            .rows
            .into_iter()
            .map(|row| row.unit_id.unwrap())
            .collect();
        (temp, store, units)
    }

    #[test]
    fn work_plan_preparation_is_read_only_and_pins_real_evidence() {
        let (_temp, store, units) = fixture();
        let database = store.directory().join("project.sqlite3");
        let before = fs::read(&database).unwrap();
        let plan = store
            .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
            .unwrap();
        store.verify_work_plan(&plan).unwrap();
        assert_eq!(fs::read(&database).unwrap(), before);
        assert!(store.connection().unwrap().is_autocommit());
        assert_eq!(plan.selection_basis.len(), 2);
        assert!(
            plan.selection_basis
                .iter()
                .all(|basis| basis.selection_id.is_some())
        );
        assert!(plan.options.requests(AutomationEffect::SaveCandidate));
        for effect in [
            AutomationEffect::SelectMissing,
            AutomationEffect::ReplaceCapturedSelection,
            AutomationEffect::AdoptResources,
            AutomationEffect::Deliver,
            AutomationEffect::RunChecks,
        ] {
            assert!(!plan.options.requests(effect));
        }
        assert_eq!(
            plan.fixed_input().unwrap().envelope(),
            plan.execution_input().unwrap()
        );
        assert_eq!(
            plan.fixed_input().unwrap().digest(),
            plan.fixed_input().unwrap().digest()
        );
        let wire = serde_json::to_value(&plan).unwrap();
        assert_eq!(
            serde_json::from_value::<WorkPlan>(wire.clone()).unwrap(),
            plan
        );
        let mut unknown = wire;
        unknown["semanticAnswer"] = serde_json::json!("Yes, that term means hello");
        assert!(serde_json::from_value::<WorkPlan>(unknown).is_err());
    }

    #[test]
    fn work_plan_current_selection_change_and_other_project_are_rejected() {
        let (_temp, mut store, units) = fixture();
        let plan = store
            .prepare_work_plan(Some(config()), "zh-CN", &[units[0]], PlanOptions::default())
            .unwrap();
        let other = tempfile::tempdir().unwrap();
        let other_store = ProjectStore::create(
            other.path().join("project"),
            crate::ProjectMetadata::create("Other", "en", ["zh-CN"]).unwrap(),
        )
        .unwrap();
        assert_eq!(
            other_store.verify_work_plan(&plan).unwrap_err().code,
            ErrorCode::Unauthorized
        );
        let target = store
            .review_target(plan.project_id, units[0], "zh-CN")
            .unwrap();
        store
            .save_translation_revision(&SaveTranslationRevision {
                project_id: plan.project_id,
                action_id: ExecutionId::new(),
                unit_id: units[0],
                locale: "zh-CN".into(),
                source_revision_id: target.source_revision_id,
                expected_selection_id: target.selection_id,
                text: "New manual choice".into(),
            })
            .unwrap();
        let error = store.verify_work_plan(&plan).unwrap_err();
        assert_eq!(error.code, ErrorCode::DependencyConflict);
        assert_eq!(error.stage, "work-plan-selection");
    }

    #[test]
    fn work_plan_empty_shared_query_changes_but_unrelated_edits_do_not_conflict() {
        let (_temp, mut store, units) = fixture();
        let plan = store
            .prepare_work_plan(Some(config()), "zh-CN", &[units[0]], PlanOptions::default())
            .unwrap();
        let metadata = store.metadata().unwrap();
        store
            .rename(metadata.metadata_revision(), "Renamed project")
            .unwrap();
        store.verify_work_plan(&plan).unwrap();
        let unrelated = store
            .review_target(plan.project_id, units[1], "zh-CN")
            .unwrap();
        let related = store
            .review_target(plan.project_id, units[0], "zh-CN")
            .unwrap();
        let request = SaveContext {
            project_id: plan.project_id,
            action_id: ExecutionId::new(),
            unit_id: units[1],
            source_revision_id: unrelated.source_revision_id,
            locale: "zh-CN".into(),
            expected_revision_id: None,
            text: "Unrelated context".into(),
            reason: "Synthetic test".into(),
        };
        store.save_context(&request).unwrap();
        store.verify_work_plan(&plan).unwrap();
        store
            .save_context(&SaveContext {
                action_id: ExecutionId::new(),
                unit_id: units[0],
                source_revision_id: related.source_revision_id,
                text: "New related context".into(),
                ..request
            })
            .unwrap();
        let error = store.verify_work_plan(&plan).unwrap_err();
        assert_eq!(error.code, ErrorCode::DependencyConflict);
        assert_eq!(error.stage, "work-plan-evidence");
    }

    #[test]
    fn work_plan_tampering_and_implicit_effect_expansion_are_refused() {
        let (_temp, store, units) = fixture();
        let plan = store
            .prepare_work_plan(Some(config()), "zh-CN", &[units[0]], PlanOptions::default())
            .unwrap();
        let mut changed = plan.clone();
        changed.options.selection_policy = SelectionPolicy::MissingOnly;
        assert!(changed.validate().is_err());
        let mut changed = plan.clone();
        changed.input.as_mut().unwrap().settings["config"]["endpoint"] =
            serde_json::json!("https://other.example/v1/chat/completions");
        assert!(changed.validate().is_err());
        let mut changed = plan.clone();
        changed.input.as_mut().unwrap().settings["config"]["shareTerms"] = serde_json::json!(true);
        assert!(changed.validate().is_err());
        let mut options = PlanOptions::default();
        options.deliver = true;
        assert!(
            store
                .prepare_work_plan(Some(config()), "zh-CN", &[units[0]], options)
                .is_err()
        );
        let options = PlanOptions {
            stages: vec![StageChoice {
                stage: WorkStage::Generation,
                mode: StageMode::Manual,
            }],
            selection_policy: SelectionPolicy::CandidatesOnly,
            adopt_resources: false,
            deliver: false,
        };
        let manual = store
            .prepare_work_plan(None, "zh-CN", &[units[0]], options)
            .unwrap();
        assert!(!manual.options.requests(AutomationEffect::SaveCandidate));
        assert!(
            store
                .prepare_work_plan(
                    Some(config()),
                    "zh-CN",
                    &[units[0], units[0]],
                    PlanOptions::default()
                )
                .is_err()
        );
    }
    fn consent(plan: &WorkPlan) -> crate::application::AuthorizeWorkPlan {
        crate::application::AuthorizeWorkPlan {
            action_id: ExecutionId::new(),
            plan_digest: plan.digest.clone(),
            confirmed: true,
            effects: vec![AutomationEffect::SaveCandidate],
            expires_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                + 600,
        }
    }
    fn control(
        plan: &WorkPlan,
        generation: u64,
        command: crate::application::WorkPlanCommand,
    ) -> crate::application::ControlWorkPlan {
        let continuing = command == crate::application::WorkPlanCommand::Continue;
        crate::application::ControlWorkPlan {
            action_id: ExecutionId::new(),
            plan_id: plan.plan_id,
            expected_generation: crate::execution::Revision::new(generation).unwrap(),
            command,
            confirmed: continuing,
            expires_at: continuing.then(|| consent(plan).expires_at),
        }
    }
    #[test]
    fn work_plan_authority_is_explicit_bounded_idempotent_and_durable() {
        let (_temp, mut store, units) = fixture();
        let plan = store
            .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
            .unwrap();
        let directory = store.directory().to_path_buf();
        let request = consent(&plan);
        let before = fs::read(directory.join(super::super::DATABASE_FILENAME)).unwrap();
        let mut rejected = request.clone();
        rejected.confirmed = false;
        assert_eq!(
            store
                .authorize_work_plan(&plan, &rejected)
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        rejected = request.clone();
        rejected.effects.push(AutomationEffect::Deliver);
        assert_eq!(
            store
                .authorize_work_plan(&plan, &rejected)
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        rejected = request.clone();
        rejected.expires_at = 1;
        assert_eq!(
            store
                .authorize_work_plan(&plan, &rejected)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            fs::read(directory.join(super::super::DATABASE_FILENAME)).unwrap(),
            before
        );
        let receipt = store.authorize_work_plan(&plan, &request).unwrap();
        let after = fs::read(directory.join(super::super::DATABASE_FILENAME)).unwrap();
        assert_eq!(store.authorize_work_plan(&plan, &request).unwrap(), receipt);
        assert_eq!(
            fs::read(directory.join(super::super::DATABASE_FILENAME)).unwrap(),
            after
        );
        assert_eq!(
            receipt.input.as_ref().unwrap().task_id,
            plan.execution_input().unwrap().task_id
        );
        let fixed = crate::execution::FixedInput::capture(receipt.input.unwrap()).unwrap();
        store.enqueue_execution(&fixed).unwrap();
        assert_eq!(
            store
                .provider_budget(plan.execution_input().unwrap().task_id)
                .unwrap()
                .unwrap()
                .dispatched,
            0
        );
        let pause = control(&plan, 1, crate::application::WorkPlanCommand::Pause);
        let paused = store.control_work_plan(&pause).unwrap();
        assert_eq!(paused.state, crate::application::WorkPlanState::Paused);
        assert_eq!(store.control_work_plan(&pause).unwrap(), paused);
        assert_eq!(
            store.check_work_plan_input(&fixed).unwrap_err().code,
            ErrorCode::Cancelled
        );
        store.close().unwrap();
        let mut reopened = ProjectStore::open(&directory).unwrap();
        assert_eq!(
            reopened.work_plan_status(plan.plan_id).unwrap().lease,
            paused.lease
        );
        assert_eq!(
            reopened.authorize_work_plan(&plan, &request).unwrap().state,
            crate::application::WorkPlanState::Active
        );
        assert_eq!(
            reopened.work_plan_status(plan.plan_id).unwrap().state,
            crate::application::WorkPlanState::Paused
        );
        assert_eq!(
            reopened.check_work_plan_input(&fixed).unwrap_err().code,
            ErrorCode::Cancelled
        );
        reopened.reconcile_execution().unwrap();
    }
    #[test]
    fn work_plan_stop_rejects_new_roots_children_dispatch_and_preserves_unknown_budget() {
        let (_temp, mut store, units) = fixture();
        let plan = store
            .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
            .unwrap();
        let grant = store.authorize_work_plan(&plan, &consent(&plan)).unwrap();
        let fixed = crate::execution::FixedInput::capture(grant.input.unwrap()).unwrap();
        store.enqueue_execution(&fixed).unwrap();
        let item = fixed.envelope().items[0].item_id;
        let dispatch = store
            .dispatch_execution_item(fixed.envelope().attempt_id, item)
            .unwrap();
        store
            .reserve_provider_request(&dispatch, ExecutionId::new(), config().max_requests)
            .unwrap();
        let before = store
            .provider_budget(plan.execution_input().unwrap().task_id)
            .unwrap()
            .unwrap();
        assert_eq!(before.dispatched, 1);
        assert_eq!(before.unresolved, 1);
        let stop = control(&plan, 1, crate::application::WorkPlanCommand::Stop);
        store.control_work_plan(&stop).unwrap();
        assert_eq!(
            store
                .reserve_provider_request(&dispatch, ExecutionId::new(), config().max_requests)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert_eq!(
            store.enqueue_execution(&fixed).unwrap_err().code,
            ErrorCode::Cancelled
        );
        // A late result remains evidence. New action identities cannot regain
        // mutation authority after the stop.
        let payload = crate::ai::item_payload(&fixed, item).unwrap();
        let result = crate::execution::FixedResult::capture(
            crate::execution::ResultEnvelope {
                project_id: plan.project_id,
                attempt_id: fixed.envelope().attempt_id,
                item_id: item,
                result_id: ExecutionId::new(),
                supersedes: None,
                dispatch_token: dispatch.dispatch_token,
                capability_id: crate::ai::CAPABILITY.into(),
                capability_version: "1".into(),
                outcome: crate::execution::ExecutionState::Succeeded,
                output: Some(
                    serde_json::to_value(crate::ai::AiOutput {
                        unit_id: payload.unit_id,
                        target_locale: payload.target_locale,
                        text: payload.source_text,
                        usage: None,
                        requests: 1,
                        usage_incomplete: true,
                    })
                    .unwrap(),
                ),
                diagnostic: None,
            },
            &fixed,
            dispatch.dispatch_token,
        )
        .unwrap();
        assert!(store.save_execution_result(&result).unwrap());
        store
            .validate_execution_result(fixed.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let action = store
            .prepare_adoption(
                fixed.envelope().attempt_id,
                fixed
                    .envelope()
                    .units
                    .iter()
                    .find(|unit| unit.item_ids.contains(&item))
                    .unwrap()
                    .unit_id,
                vec![result.envelope().result_id],
                serde_json::Value::Null,
            )
            .unwrap();
        assert_eq!(
            store
                .adopt_execution(&action, &crate::AiAdoptionHandler)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert_eq!(
            store
                .execution_current_result(fixed.envelope().attempt_id, item)
                .unwrap(),
            Some(result.envelope().result_id)
        );

        let mut child = fixed.envelope().clone();
        child.task_id = ExecutionId::new();
        child.attempt_id = ExecutionId::new();
        let child = crate::execution::FixedInput::capture(child).unwrap();
        assert_eq!(
            store
                .enqueue_execution_with_policy(
                    &child,
                    crate::execution::RecoveryPolicy::ExternalUnknown,
                    Some(plan.execution_input().unwrap().task_id)
                )
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        let resume = control(&plan, 2, crate::application::WorkPlanCommand::Continue);
        let mut denied = resume.clone();
        denied.confirmed = false;
        assert_eq!(
            store.control_work_plan(&denied).unwrap_err().code,
            ErrorCode::Unauthorized
        );
        let receipt = store.control_work_plan(&resume).unwrap();
        assert_eq!(
            receipt.parent_task,
            Some(plan.execution_input().unwrap().task_id)
        );
        let new = crate::execution::FixedInput::capture(receipt.input.unwrap()).unwrap();
        assert_ne!(
            new.envelope().task_id,
            plan.execution_input().unwrap().task_id
        );
        assert_eq!(
            store.enqueue_execution(&new).unwrap_err().code,
            ErrorCode::Unauthorized
        );
        store
            .enqueue_execution_with_policy(
                &new,
                crate::execution::RecoveryPolicy::ExternalUnknown,
                receipt.parent_task,
            )
            .unwrap();
        assert_eq!(
            store
                .provider_budget(plan.execution_input().unwrap().task_id)
                .unwrap()
                .unwrap(),
            before
        );
        assert_eq!(
            store.check_work_plan_input(&fixed).unwrap_err().code,
            ErrorCode::Cancelled
        );
        assert_eq!(store.check_work_plan_input(&new), Ok(()));
        // Removing the stamp cannot create a manually authorized child.
        let mut stripped = new.envelope().clone();
        stripped.automation = None;
        stripped.task_id = ExecutionId::new();
        stripped.attempt_id = ExecutionId::new();
        let stripped = crate::execution::FixedInput::capture(stripped).unwrap();
        assert_eq!(
            store
                .enqueue_execution_with_policy(
                    &stripped,
                    crate::execution::RecoveryPolicy::ExternalUnknown,
                    Some(plan.execution_input().unwrap().task_id)
                )
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        let stale = control(&plan, 1, crate::application::WorkPlanCommand::TakeOver);
        assert_eq!(
            store.control_work_plan(&stale).unwrap_err().code,
            ErrorCode::DependencyConflict
        );
        store.reconcile_execution().unwrap();
        let directory = store.directory().to_path_buf();
        store.close().unwrap();
        let reopened = ProjectStore::open(&directory).unwrap();
        assert_eq!(
            reopened
                .provider_budget(plan.execution_input().unwrap().task_id)
                .unwrap()
                .unwrap(),
            before
        );
        assert_eq!(
            reopened
                .work_plan_status(plan.plan_id)
                .unwrap()
                .lease
                .generation
                .get(),
            3
        );
    }
    #[test]
    fn manual_selection_protection_persists_and_release_rechecks_current_basis() {
        let (_temp, mut store, units) = fixture();
        let unit = units[0];
        let locale = "zh-CN";
        let protected = store.work_protection(unit, locale).unwrap();
        assert!(protected.protected);
        assert_eq!(protected.revision.get(), 1);
        let source = store
            .source_content(
                store.content_scope().unwrap().current_snapshot.unwrap(),
                0,
                10,
            )
            .unwrap()
            .rows
            .into_iter()
            .find(|row| row.unit_id == Some(unit))
            .unwrap();
        let project =
            ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
        let selected = store
            .translation_history(project, unit, locale, 0, 1)
            .unwrap()
            .current
            .unwrap();
        let request = crate::application::SetWorkProtection {
            action_id: ExecutionId::new(),
            project_id: project,
            unit_id: unit,
            locale: locale.into(),
            source_revision_id: source.source_revision_id.unwrap(),
            selection_id: Some(selected.event_id),
            expected_revision: protected.revision,
            protected: false,
            confirmed_release: false,
        };
        assert_eq!(
            store.set_work_protection(&request).unwrap_err().code,
            ErrorCode::Unauthorized
        );
        let mut request = request;
        request.confirmed_release = true;
        let released = store.set_work_protection(&request).unwrap();
        assert!(!released.protected);
        assert_eq!(released.revision.get(), 2);
        assert_eq!(store.set_work_protection(&request).unwrap(), released);
        let saved = store
            .save_translation_revision(&crate::SaveTranslationRevision {
                action_id: ExecutionId::new(),
                project_id: project,
                unit_id: unit,
                locale: locale.into(),
                source_revision_id: source.source_revision_id.unwrap(),
                expected_selection_id: Some(selected.event_id),
                text: "new human text".into(),
            })
            .unwrap();
        assert!(store.work_protection(unit, locale).unwrap().protected);
        assert_eq!(
            store.work_protection(unit, locale).unwrap().revision.get(),
            3
        );
        let mut stale = request.clone();
        stale.action_id = ExecutionId::new();
        assert_eq!(
            store.set_work_protection(&stale).unwrap_err().code,
            ErrorCode::DependencyConflict
        );
        stale.selection_id = Some(saved.event_id);
        assert_eq!(
            store.set_work_protection(&stale).unwrap_err().stage,
            "work-protection-revision"
        );
        // An old acknowledgement reports its historical result without clearing new protection.
        assert_eq!(store.set_work_protection(&request).unwrap(), released);
        assert!(store.work_protection(unit, locale).unwrap().protected);
        store.reconcile_execution().unwrap();
        let directory = store.directory().to_path_buf();
        store.close().unwrap();
        let reopened = ProjectStore::open(&directory).unwrap();
        assert_eq!(
            reopened
                .work_protection(unit, locale)
                .unwrap()
                .revision
                .get(),
            3
        );
        assert!(reopened.work_protection(unit, locale).unwrap().protected);
    }

    #[test]
    fn work_plan_takeover_signals_the_actual_running_worker() {
        use crate::execution::{
            Cancellation, DispatchRequest, ExecutionRuntime, ResultSender, Runner,
        };
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        struct WaitForHuman(Arc<AtomicBool>);
        impl Runner for WaitForHuman {
            fn capability_id(&self) -> &str {
                crate::ai::CAPABILITY
            }
            fn capability_version(&self) -> &str {
                "1"
            }
            fn run(
                &self,
                _request: DispatchRequest,
                cancel: Cancellation,
                _results: ResultSender,
            ) -> Result<(), ExecutionError> {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                while !cancel.is_requested() && std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                self.0.store(cancel.is_requested(), Ordering::Release);
                Ok(())
            }
        }
        let (_temp, mut store, units) = fixture();
        let plan = store
            .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
            .unwrap();
        let receipt = store.authorize_work_plan(&plan, &consent(&plan)).unwrap();
        let fixed = crate::execution::FixedInput::capture(receipt.input.unwrap()).unwrap();
        let observed = Arc::new(AtomicBool::new(false));
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime
            .register(Arc::new(WaitForHuman(observed.clone())))
            .unwrap();
        runtime.submit(&mut store, &fixed).unwrap();
        runtime.tick(&mut store).unwrap();
        assert!(runtime.is_active(fixed.envelope().attempt_id));
        store
            .control_work_plan(&control(
                &plan,
                1,
                crate::application::WorkPlanCommand::TakeOver,
            ))
            .unwrap();
        runtime.tick(&mut store).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while runtime.is_active(fixed.envelope().attempt_id) && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(1));
            runtime.tick(&mut store).unwrap();
        }
        assert!(observed.load(Ordering::Acquire));
        assert!(!runtime.is_active(fixed.envelope().attempt_id));
        assert_eq!(
            store.work_plan_status(plan.plan_id).unwrap().state,
            crate::application::WorkPlanState::TakenOver
        );
        let root = fixed.envelope().task_id;
        let resumed = store
            .control_work_plan(&control(
                &plan,
                2,
                crate::application::WorkPlanCommand::Continue,
            ))
            .unwrap();
        let next = crate::execution::FixedInput::capture(resumed.input.unwrap()).unwrap();
        runtime.submit_child(&mut store, &next, root).unwrap();
        let idle = store
            .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
            .unwrap();
        store.authorize_work_plan(&idle, &consent(&idle)).unwrap();
        observed.store(false, Ordering::Release);
        runtime.tick(&mut store).unwrap();
        assert!(runtime.is_active(next.envelope().attempt_id));
        runtime.begin_quiesce(&mut store).unwrap();
        assert_eq!(
            store.work_plan_status(plan.plan_id).unwrap().state,
            crate::application::WorkPlanState::Paused
        );
        assert_eq!(
            store.work_plan_status(idle.plan_id).unwrap().state,
            crate::application::WorkPlanState::Paused
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match runtime.finish_quiesce(&mut store) {
                Ok(()) => break,
                Err(error)
                    if error.code == ErrorCode::Busy && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(error) => panic!("quiesce failed: {error:?}"),
            }
        }
        assert!(observed.load(Ordering::Acquire));
        assert!(!runtime.is_active(next.envelope().attempt_id));
        assert_eq!(
            super::super::ledger::cancel_revision(store.connection().unwrap(), root)
                .unwrap()
                .get(),
            0
        );
        store.reconcile_execution().unwrap();
        let directory = store.directory().to_path_buf();
        store.close().unwrap();
        let mut reopened = ProjectStore::open(&directory).unwrap();
        let receipt = reopened
            .control_work_plan(&control(
                &plan,
                4,
                crate::application::WorkPlanCommand::Continue,
            ))
            .unwrap();
        assert_eq!(receipt.parent_task, Some(root));
        let input = crate::execution::FixedInput::capture(receipt.input.unwrap()).unwrap();
        reopened
            .enqueue_execution_with_policy(
                &input,
                crate::execution::RecoveryPolicy::ExternalUnknown,
                Some(root),
            )
            .unwrap();
    }
    #[test]
    fn cancelled_root_requires_new_grant_without_refunding_original_budget() {
        use crate::application::{WorkPlanCommand, WorkPlanState};
        use crate::execution::{FixedInput, RecoveryPolicy};
        let (_temp, mut store, units) = fixture();
        let plan = store
            .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
            .unwrap();
        let authorization = consent(&plan);
        let receipt = store.authorize_work_plan(&plan, &authorization).unwrap();
        assert_eq!(store.work_plan(plan.plan_id).unwrap(), plan);
        assert_eq!(
            store.work_plan_receipt(authorization.action_id).unwrap(),
            Some(receipt.clone())
        );
        assert!(
            store
                .work_plan_receipt(ExecutionId::new())
                .unwrap()
                .is_none()
        );
        let input = FixedInput::capture(receipt.input.unwrap()).unwrap();
        store.enqueue_execution(&input).unwrap();
        let item = input.envelope().items[0].item_id;
        let dispatched = store
            .dispatch_execution_item(input.envelope().attempt_id, item)
            .unwrap();
        store
            .reserve_provider_request(&dispatched, ExecutionId::new(), config().max_requests)
            .unwrap();
        let root = input.envelope().task_id;
        let cancel_id = ExecutionId::new();
        assert_eq!(store.cancel_execution(root, cancel_id).unwrap().get(), 1);
        let stopped = store.work_plan_status(plan.plan_id).unwrap();
        assert_eq!(stopped.state, WorkPlanState::Stopped);
        assert_eq!(stopped.lease.generation.get(), 2);
        assert_eq!(store.cancel_execution(root, cancel_id).unwrap().get(), 1);
        assert_eq!(store.work_plan_status(plan.plan_id).unwrap(), stopped);
        assert_eq!(
            store.check_work_plan_input(&input).unwrap_err().code,
            ErrorCode::Cancelled
        );
        let directory = store.directory().to_path_buf();
        store.close().unwrap();
        let mut store = ProjectStore::open(&directory).unwrap();
        let continued = store
            .control_work_plan(&control(&plan, 2, WorkPlanCommand::Continue))
            .unwrap();
        assert_eq!(continued.cancellation_revision.get(), 1);
        assert_eq!(continued.parent_task, Some(root));
        let child = FixedInput::capture(continued.input.unwrap()).unwrap();
        store
            .enqueue_execution_with_policy(&child, RecoveryPolicy::ExternalUnknown, Some(root))
            .unwrap();
        let request = store
            .dispatch_execution_item(
                child.envelope().attempt_id,
                child.envelope().items[0].item_id,
            )
            .unwrap();
        store
            .reserve_provider_request(&request, ExecutionId::new(), config().max_requests)
            .unwrap();
        let budget = store.provider_budget(root).unwrap().unwrap();
        assert_eq!(budget.dispatched, 2);
        assert_eq!(budget.unresolved, 2);
        // Cancelling only a child never reauthorizes that child or stops the
        // unrelated root grant. Its branch remains cancelled.
        store
            .cancel_execution(child.envelope().task_id, ExecutionId::new())
            .unwrap();
        assert_eq!(
            store.work_plan_status(plan.plan_id).unwrap().state,
            WorkPlanState::Active
        );
        assert_eq!(
            store
                .reserve_provider_request(&request, ExecutionId::new(), config().max_requests)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        store.cancel_execution(root, ExecutionId::new()).unwrap();
        assert_eq!(
            store
                .work_plan_status(plan.plan_id)
                .unwrap()
                .lease
                .generation
                .get(),
            4
        );
        assert_eq!(
            store
                .reserve_provider_request(&request, ExecutionId::new(), config().max_requests)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert_eq!(store.provider_budget(root).unwrap().unwrap(), budget);
        store.reconcile_execution().unwrap();
        store.close().unwrap();
        assert_eq!(
            ProjectStore::open(&directory)
                .unwrap()
                .work_plan_status(plan.plan_id)
                .unwrap()
                .state,
            WorkPlanState::Stopped
        );
    }
    #[test]
    fn current_work_plan_authority_and_receipt_damage_are_refused_without_reset() {
        let (_temp, mut store, units) = fixture();
        let plan = store
            .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
            .unwrap();
        store.authorize_work_plan(&plan, &consent(&plan)).unwrap();
        store
            .control_work_plan(&control(
                &plan,
                1,
                crate::application::WorkPlanCommand::Stop,
            ))
            .unwrap();
        let directory = store.directory().to_path_buf();
        store.close().unwrap();
        let path = directory.join(super::super::DATABASE_FILENAME);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE application_plans SET state='active' WHERE plan_id=?1",
                [plan.plan_id.to_string()],
            )
            .unwrap();
        drop(connection);
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            ProjectStore::open(&directory),
            Err(crate::PersistenceError::CorruptProject { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE application_plans SET state='stopped' WHERE plan_id=?1",
                [plan.plan_id.to_string()],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE application_actions SET receipt=X'7B7D' WHERE plan_id=?1",
                [plan.plan_id.to_string()],
            )
            .unwrap();
        drop(connection);
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            ProjectStore::open(&directory),
            Err(crate::PersistenceError::CorruptProject { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    fn manual_options() -> PlanOptions {
        let mut options = PlanOptions::default();
        for choice in &mut options.stages {
            choice.mode = StageMode::Manual;
        }
        options
    }
    #[test]
    fn manual_work_plan_needs_no_model_and_remains_read_only_without_authority() {
        let (_temp, mut store, units) = fixture();
        let directory = store.directory().to_path_buf();
        let before = fs::read(directory.join(super::super::DATABASE_FILENAME)).unwrap();
        let plan = store
            .prepare_work_plan(None, "zh-CN", &units, manual_options())
            .unwrap();
        assert!(plan.input.is_none());
        assert_eq!(plan.locale, "zh-CN");
        assert_eq!(plan.selection_basis.len(), units.len());
        assert!(
            plan.selection_basis
                .iter()
                .all(|basis| !basis.native_key.is_empty() && basis.selection_id.is_some())
        );
        store.verify_work_plan(&plan).unwrap();
        assert_eq!(
            plan.fixed_input().unwrap_err().code,
            ErrorCode::Unauthorized
        );
        assert_eq!(
            store
                .authorize_work_plan(&plan, &consent(&plan))
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        assert!(store.connection().unwrap().is_autocommit());
        assert_eq!(
            fs::read(directory.join(super::super::DATABASE_FILENAME)).unwrap(),
            before
        );
        let wire = serde_json::to_value(&plan).unwrap();
        assert!(wire["input"].is_null());
        assert_eq!(serde_json::from_value::<WorkPlan>(wire).unwrap(), plan);
        assert_eq!(
            store
                .prepare_work_plan(None, "zh-CN", &units, PlanOptions::default())
                .unwrap_err()
                .stage,
            "work-plan-model"
        );
        assert_eq!(
            store
                .prepare_work_plan(Some(config()), "zh-CN", &units, manual_options())
                .unwrap_err()
                .stage,
            "work-plan-model-unused"
        );
    }
    #[test]
    fn manual_work_plan_uses_current_scope_and_refuses_changed_selections_and_tampering() {
        let (_temp, mut store, units) = fixture();
        let plan = store
            .prepare_work_plan(None, "zh-CN", &[units[0]], manual_options())
            .unwrap();
        let wire = serde_json::to_value(&plan).unwrap();
        for field in ["locale", "nativeKey", "sourceRevisionId", "selectionId"] {
            let mut changed = wire.clone();
            if field == "locale" {
                changed[field] = "ja".into();
            } else {
                changed["selectionBasis"][0][field] = if field == "nativeKey" {
                    "different".into()
                } else {
                    ExecutionId::new().to_string().into()
                };
            }
            let changed: WorkPlan = serde_json::from_value(changed).unwrap();
            assert!(changed.validate().is_err(), "{field}");
        }
        let before = fs::read(store.directory().join(super::super::DATABASE_FILENAME)).unwrap();
        assert!(
            store
                .prepare_work_plan(None, "zh-CN", &[ExecutionId::new()], manual_options())
                .is_err()
        );
        assert!(
            store
                .prepare_work_plan(None, "zh-CN", &[units[0], units[0]], manual_options())
                .is_err()
        );
        assert!(
            store
                .prepare_work_plan(None, "fr", &units, manual_options())
                .is_err()
        );
        assert_eq!(
            fs::read(store.directory().join(super::super::DATABASE_FILENAME)).unwrap(),
            before
        );
        let target = store
            .review_target(plan.project_id, units[0], "zh-CN")
            .unwrap();
        store
            .save_translation_revision(&SaveTranslationRevision {
                project_id: plan.project_id,
                action_id: ExecutionId::new(),
                unit_id: units[0],
                locale: "zh-CN".into(),
                source_revision_id: target.source_revision_id,
                expected_selection_id: target.selection_id,
                text: "manual plan edit".into(),
            })
            .unwrap();
        assert_eq!(
            store.verify_work_plan(&plan).unwrap_err().code,
            ErrorCode::DependencyConflict
        );
    }
}
