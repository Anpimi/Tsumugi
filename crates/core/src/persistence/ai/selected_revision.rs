use super::ProjectStore;
use crate::{
    ai::{error, selected_revision::*},
    application::MAX_CONVERSATION_MESSAGE_BYTES,
    execution::{ErrorCode, ExecutionError},
};

impl ProjectStore {
    pub fn preview_selected_revision(
        &self,
        request: &PrepareSelectedRevision,
    ) -> Result<SelectedRevisionPreview, ExecutionError> {
        request.config.validate()?;
        if request.config.max_requests != 1
            || request.config.max_retries != 0
            || request.config.concurrency != 1
        {
            return Err(error(ErrorCode::LimitExceeded, "selected-revision-limits"));
        }
        if request.instructions.trim().is_empty()
            || request.instructions.len() > MAX_CONVERSATION_MESSAGE_BYTES
        {
            return Err(error(
                ErrorCode::InvalidInput,
                "selected-revision-instructions",
            ));
        }

        let connection = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "selected-revision-project"))?;
        let basis = &request.basis;
        let unit = [basis.unit_id];
        super::super::review::read_snapshot(connection, |connection| {
            let target = super::super::review::targets_in(
                connection,
                request.project_id,
                &unit,
                &basis.locale,
            )?
            .pop()
            .ok_or_else(|| error(ErrorCode::DependencyConflict, "selected-revision-basis"))?;
            if target.source_snapshot_id != basis.source_snapshot_id
                || target.source_revision_id != basis.source_revision_id
                || target.selection_id != Some(basis.selection_id)
                || target.revision_id != Some(basis.translation_revision_id)
            {
                return Err(error(
                    ErrorCode::DependencyConflict,
                    "selected-revision-basis",
                ));
            }
            let text = target
                .translation_text
                .as_deref()
                .ok_or_else(|| error(ErrorCode::CorruptLedger, "selected-revision-basis"))?;
            let item = self
                .preview_ai(request.config.clone(), &basis.locale, &unit)?
                .items
                .pop()
                .ok_or_else(|| error(ErrorCode::CorruptLedger, "selected-revision-source"))?;
            if item.unit_id != basis.unit_id
                || item.target_locale != basis.locale
                || item.source_snapshot_id != basis.source_snapshot_id
                || item.source_revision_id != basis.source_revision_id
            {
                return Err(error(
                    ErrorCode::DependencyConflict,
                    "selected-revision-basis",
                ));
            }
            let preview = SelectedRevisionPreview {
                project_id: request.project_id,
                basis: basis.clone(),
                config: request.config.clone(),
                input: project_input(&request.config, &item, text, &request.instructions)?,
            };
            preview.request_body()?;
            Ok(preview)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ai::AiConfig,
        execution::ExecutionId,
        persistence::review::tests::{fixture, translate},
    };

    fn request(
        store: &ProjectStore,
        project: ExecutionId,
        unit: ExecutionId,
    ) -> PrepareSelectedRevision {
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        PrepareSelectedRevision {
            project_id: project,
            basis: SelectedRevisionBasis {
                unit_id: unit,
                locale: target.locale,
                source_snapshot_id: target.source_snapshot_id,
                source_revision_id: target.source_revision_id,
                selection_id: target.selection_id.unwrap(),
                translation_revision_id: target.revision_id.unwrap(),
            },
            config: AiConfig {
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                model: "synthetic-revision".into(),
                credential_env: String::new(),
                max_requests: 1,
                concurrency: 1,
                max_retries: 0,
                ..AiConfig::default()
            },
            instructions: "  Explain the issue, then propose wording if needed.\n".into(),
        }
    }

    #[test]
    fn selected_revision_uses_exact_saved_text_and_rejects_a_changed_basis() {
        let (_temp, mut store, project, units) = fixture();
        let unit = units[0];
        translate(&mut store, project, unit, "zh-CN", "以前的译文 {{name}}");
        let old = request(&store, project, unit);
        translate(
            &mut store,
            project,
            unit,
            "zh-CN",
            " 当前译文 👩🏽‍💻 {{name}}\n",
        );
        translate(
            &mut store,
            project,
            units[1],
            "zh-CN",
            "Another entry is private",
        );
        let current = request(&store, project, unit);
        let capture = store.preview_selected_revision(&current).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&capture.input).unwrap();
        assert_eq!(payload["selectedTranslation"], " 当前译文 👩🏽‍💻 {{name}}\n");
        assert_eq!(payload["request"], current.instructions);
        assert_eq!(
            payload["unit"]["sourceText"],
            store
                .review_target(project, unit, "zh-CN")
                .unwrap()
                .source_text
        );
        assert_eq!(capture.basis, current.basis);
        assert!(
            !capture
                .input
                .contains(&current.basis.translation_revision_id.to_string())
        );
        assert!(!capture.input.contains("Another entry is private"));
        assert!(!capture.input.contains("以前的译文"));
        assert_eq!(
            capture.request_body().unwrap()["messages"][1]["content"],
            capture.input
        );
        for stale in [
            old,
            PrepareSelectedRevision {
                basis: SelectedRevisionBasis {
                    source_snapshot_id: ExecutionId::new(),
                    ..current.basis.clone()
                },
                ..current.clone()
            },
        ] {
            assert_eq!(
                store.preview_selected_revision(&stale).unwrap_err().code,
                ErrorCode::DependencyConflict
            );
        }
    }

    #[test]
    fn selected_revision_checks_complete_body_with_escaped_translation() {
        let (_temp, mut store, project, units) = fixture();
        let unit = units[0];
        translate(&mut store, project, unit, "zh-CN", &"\"\\\n".repeat(3500));
        let req = request(&store, project, unit);
        let failure = store.preview_selected_revision(&req).unwrap_err();
        assert_eq!(failure.code, ErrorCode::LimitExceeded);
        let (actual, limit) = failure
            .stage
            .strip_prefix("provider-request-bytes:")
            .unwrap()
            .split_once(':')
            .unwrap();
        assert_eq!(limit, "32768");
        assert!(actual.parse::<usize>().unwrap() > 32768);
    }
}
