//! Read-only work-plan preparation from the existing project authorities.
use super::ProjectStore;
use crate::{
    ai::{self, AiConfig},
    application::{PlanOptions, PlanSelectionBasis, WorkPlan},
    execution::{ErrorCode, ExecutionError, ExecutionId},
};

impl ProjectStore {
    pub fn prepare_work_plan(
        &self,
        config: AiConfig,
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
            let preview = self.preview_ai(config, locale, units)?;
            let project_id = ExecutionId::parse(&project.to_string())?;
            let mut selection_basis = Vec::with_capacity(units.len());
            for &unit_id in units {
                let history = self.translation_history(project_id, unit_id, locale, 0, 1)?;
                selection_basis.push(PlanSelectionBasis {
                    unit_id,
                    selection_id: history.current.map(|current| current.event_id),
                });
            }
            WorkPlan::capture(project, preview, selection_basis, options)
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
            for basis in &plan.selection_basis {
                let current = self
                    .translation_history(plan.project_id, basis.unit_id, locale, 0, 1)?
                    .current
                    .map(|selection| selection.event_id);
                if current != basis.selection_id {
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
            .prepare_work_plan(config(), "zh-CN", &units, PlanOptions::default())
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
        assert_eq!(plan.fixed_input().unwrap().envelope(), &plan.input);
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
            .prepare_work_plan(config(), "zh-CN", &[units[0]], PlanOptions::default())
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
            .prepare_work_plan(config(), "zh-CN", &[units[0]], PlanOptions::default())
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
            .prepare_work_plan(config(), "zh-CN", &[units[0]], PlanOptions::default())
            .unwrap();
        let mut changed = plan.clone();
        changed.options.selection_policy = SelectionPolicy::MissingOnly;
        assert!(changed.validate().is_err());
        let mut changed = plan.clone();
        changed.input.settings["config"]["endpoint"] =
            serde_json::json!("https://other.example/v1/chat/completions");
        assert!(changed.validate().is_err());
        let mut changed = plan.clone();
        changed.input.settings["config"]["shareTerms"] = serde_json::json!(true);
        assert!(changed.validate().is_err());
        let mut options = PlanOptions::default();
        options.deliver = true;
        assert!(
            store
                .prepare_work_plan(config(), "zh-CN", &[units[0]], options)
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
            .prepare_work_plan(config(), "zh-CN", &[units[0]], options)
            .unwrap();
        assert!(!manual.options.requests(AutomationEffect::SaveCandidate));
        assert!(
            store
                .prepare_work_plan(
                    config(),
                    "zh-CN",
                    &[units[0], units[0]],
                    PlanOptions::default()
                )
                .is_err()
        );
    }
}
