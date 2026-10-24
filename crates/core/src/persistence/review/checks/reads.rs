//! Durable QA receipts correlated with the complete original checker selection.
use super::*;
use tsumugi_plugin_sdk::{ContractRef, PluginIdentity};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckActionSelection {
    pub plugin: PluginIdentity,
    pub package_digest: String,
    pub resource_id: String,
    pub environment_digest: String,
    pub rules: Vec<ContractRef>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckActionRequest {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub expected_basis: String,
    pub advisory_checks: Vec<ReviewCheckActionSelection>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckActionRead {
    pub request: ReviewCheckActionRequest,
    pub receipt: CheckRun,
}

impl ProjectStore {
    /// Only persisted final QA evidence is confirmed. A missing run says nothing
    /// about an in-memory preparation or a worker still executing it.
    pub fn review_check_action_read(&self, request: &ReviewCheckActionRequest)
        -> Result<Option<ReviewCheckActionRead>, ExecutionError> {
        self.read_review_action(request.project_id, |c| {
            let owner: Option<(String,String)> = c.query_row(
                "SELECT project_id,purpose FROM review_checks WHERE action_id=?1",
                [request.action_id.to_string()], |row| Ok((row.get(0)?,row.get(1)?)))
                .optional().map_err(sql)?;
            let Some((project,purpose)) = owner else { return Ok(None); };
            if project != request.project_id.to_string() || purpose != "qa" {
                return Err(failure(ErrorCode::CorruptLedger,"review-check-action"));
            }
            let (run,saved_digest) = check_by_action(c,request.project_id,request.action_id)?
                .ok_or_else(||failure(ErrorCode::CorruptLedger,"review-check-action"))?;
            let choices = run.evidence.as_ref().map(|e|e.advisory_checks.as_slice()).unwrap_or(&[]);
            if run.action_id != request.action_id || run.unit_id != request.unit_id
                || run.locale != request.locale || run.basis != request.expected_basis
                || choices::request_digest(request.project_id,request.unit_id,&request.locale,
                    &request.expected_basis,request.action_id,choices)? != saved_digest
                || choices.len() != request.advisory_checks.len() {
                return Err(failure(ErrorCode::ResultMismatch,"review-check-action"));
            }
            for (saved,selected) in choices.iter().zip(&request.advisory_checks) {
                if saved.binding.checker.provider.plugin != selected.plugin
                    || saved.binding.checker.provider.package_digest != selected.package_digest
                    || saved.declaration_resource_id != selected.resource_id
                    || saved.execution.environment.digest().map_err(|_|failure(ErrorCode::CorruptLedger,"review-check-environment"))? != selected.environment_digest
                    || saved.rules != selected.rules {
                    return Err(failure(ErrorCode::ResultMismatch,"review-check-action"));
                }
            }
            validate_historical_basis(c,request.project_id,request.unit_id,&request.locale,&run.basis_evidence)?;
            Ok(Some(ReviewCheckActionRead {request:request.clone(),receipt:run}))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::review::tests::{adopt_source, check, fixture, translate};

    #[test]
    fn review_check_action_read_confirms_original_history_and_only_success_reconciles() {
        let (directory, mut store, project, units) = fixture();
        let unit = units[0];
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        let mut request = ReviewCheckActionRequest {
            advisory_checks: Vec::new(),
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis,
        };
        store
            .execution_unknown
            .store(true, std::sync::atomic::Ordering::Release);
        assert_eq!(store.review_check_action_read(&request).unwrap(), None);
        assert!(!store.is_reconciling());
        // A completed check can contain not-applicable coverage without a selection.
        let missing = store
            .run_review_checks(
                project,
                unit,
                "zh-CN",
                &request.expected_basis,
                request.action_id,
            )
            .unwrap();
        assert_eq!(missing.basis_evidence.selection_id, None);
        assert_eq!(
            store
                .review_check_action_read(&request)
                .unwrap()
                .unwrap()
                .receipt,
            missing
        );
        translate(&mut store, project, unit, "zh-CN", "你好 {{name}}");
        let run = check(&mut store, project, unit, "zh-CN");
        request.action_id = run.action_id;
        request.expected_basis = run.basis.clone();
        let expected = ReviewCheckActionRead {
            request: request.clone(),
            receipt: run.clone(),
        };
        assert_eq!(
            store.review_check_action_read(&request).unwrap(),
            Some(expected.clone())
        );
        for field in 0..4 {
            let mut wrong = request.clone();
            match field {
                0 => wrong.expected_basis = "0".repeat(64),
                1 => wrong.unit_id = units[1],
                2 => wrong.locale = "fr-FR".into(),
                _ => wrong.project_id = ExecutionId::new(),
            }
            store
                .execution_unknown
                .store(true, std::sync::atomic::Ordering::Release);
            assert!(store.review_check_action_read(&wrong).is_err());
            assert!(store.is_reconciling());
            assert_eq!(
                check_by_action(store.connection().unwrap(), project, request.action_id)
                    .unwrap()
                    .map(|value| value.0),
                Some(run.clone())
            );
            assert!(store.is_reconciling());
            assert_eq!(
                store.review_check_action_read(&request).unwrap(),
                Some(expected.clone())
            );
            assert!(!store.is_reconciling());
        }
        let c = store.connection().unwrap();
        let original: String = c
            .query_row(
                "SELECT request_digest FROM review_checks WHERE action_id=?1",
                [run.action_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        c.execute(
            "UPDATE review_checks SET request_digest=?2 WHERE action_id=?1",
            params![run.action_id.to_string(), "0".repeat(64)],
        )
        .unwrap();
        store
            .execution_unknown
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(store.review_check_action_read(&request).is_err());
        assert!(store.is_reconciling());
        c.execute(
            "UPDATE review_checks SET request_digest=?2 WHERE action_id=?1",
            params![run.action_id.to_string(), &original],
        )
        .unwrap();
        // Internally consistent JSON and basis digest must still refer to real historical associations.
        let mut forged = run.basis_evidence.clone();
        forged.source_snapshot_id = ExecutionId::new();
        let forged_digest = basis_digest(&forged).unwrap();
        c.execute(
            "UPDATE review_checks SET basis=?2,basis_json=?3,request_digest=?4 WHERE action_id=?1",
            params![
                run.action_id.to_string(),
                forged_digest,
                serde_json::to_string(&forged).unwrap(),
                choices::request_digest(
                    project,
                    unit,
                    "zh-CN",
                    forged_digest.as_str(),
                    run.action_id,
                    &[],
                )
                .unwrap()
            ],
        )
        .unwrap();
        let mut forged_request = request.clone();
        forged_request.expected_basis = forged_digest;
        assert_eq!(
            store
                .review_check_action_read(&forged_request)
                .unwrap_err()
                .code,
            ErrorCode::CorruptLedger
        );
        assert!(store.is_reconciling());
        c.execute(
            "UPDATE review_checks SET basis=?2,basis_json=?3,request_digest=?4 WHERE action_id=?1",
            params![
                run.action_id.to_string(),
                run.basis,
                serde_json::to_string(&run.basis_evidence).unwrap(),
                &original
            ],
        )
        .unwrap();
        store.review_check_action_read(&request).unwrap();
        assert!(!store.is_reconciling());
        translate(&mut store, project, unit, "zh-CN", "Later {{name}}");
        check(&mut store, project, unit, "zh-CN");
        adopt_source(&mut store, br#"{"replacement":"Changed source"}"#);
        let revision = store.metadata().unwrap().metadata_revision();
        store.set_target_locales(revision, &["ja".into()]).unwrap();
        let sequence = store
            .changes_since(crate::execution::Revision::new(0).unwrap())
            .sequence;
        assert_eq!(
            store.review_check_action_read(&request).unwrap(),
            Some(expected.clone())
        );
        assert_eq!(
            store
                .changes_since(crate::execution::Revision::new(0).unwrap())
                .sequence,
            sequence
        );
        store.close().unwrap();
        let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
        assert_eq!(
            reopened.review_check_action_read(&request).unwrap(),
            Some(expected)
        );
    }
}
