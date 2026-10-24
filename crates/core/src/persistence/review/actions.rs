//! Original human review actions, independent of the current workbench target.
use super::*;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewDecisionActionRead {
    pub request: ReviewWrite,
    pub receipt: ReviewDecision,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewWaiverActionRead {
    pub request: WaiverWrite,
    pub receipt: Waiver,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewFallbackActionRead {
    pub request: FallbackWrite,
    pub receipt: FallbackDecision,
}

fn corrupt() -> ExecutionError {
    failure(ErrorCode::CorruptLedger, "review-action-record")
}

fn action_exists(
    c: &Connection,
    table: &str,
    project: ExecutionId,
    action: ExecutionId,
) -> Result<bool, ExecutionError> {
    let owner: Option<String> = c
        .query_row(
            &format!("SELECT project_id FROM {table} WHERE action_id=?1"),
            [action.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?;
    if owner
        .as_ref()
        .is_some_and(|owner| *owner != project.to_string())
    {
        return Err(corrupt());
    }
    Ok(owner.is_some())
}

fn owned(c: &Connection, project: ExecutionId, unit: ExecutionId) -> Result<(), ExecutionError> {
    if !super::super::content::unit_owned_by_project(c, project, unit)? {
        return Err(corrupt());
    }
    Ok(())
}

impl ProjectStore {
    pub(super) fn read_review_action<T>(
        &self,
        project: ExecutionId,
        read: impl FnOnce(&Connection) -> Result<Option<T>, ExecutionError>,
    ) -> Result<Option<T>, ExecutionError> {
        let value = read_snapshot(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?,
            |c| {
                if super::super::read_metadata_from(c)
                    .map_err(|_| corrupt())?
                    .project_id()
                    .to_string()
                    != project.to_string()
                {
                    return Err(failure(ErrorCode::Unauthorized, "review-project"));
                }
                read(c)
            },
        )?;
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(value)
    }

    pub fn review_decision_action_read(
        &self,
        r: &ReviewWrite,
    ) -> Result<Option<ReviewDecisionActionRead>, ExecutionError> {
        self.read_review_action(r.project_id, |c| {
            if !action_exists(c,"review_decisions",r.project_id,r.action_id)? { return Ok(None); }
            let (receipt,saved) = decision_by_action(c,r.project_id,r.action_id)?.ok_or_else(corrupt)?;
            if saved != digest(r)? { return Err(failure(ErrorCode::ResultMismatch,"review-action")); }
            owned(c,r.project_id,r.unit_id)?;
            if receipt.unit_id != r.unit_id || receipt.locale != r.locale || receipt.basis != r.expected_basis
                || receipt.actor != r.actor || receipt.kind != r.kind || receipt.reason != r.reason
                || receipt.basis_evidence.selection_id != Some(receipt.selection_id)
                || receipt.basis_evidence.revision_id != Some(receipt.revision_id)
                || receipt.basis_evidence.source_revision_id != receipt.source_revision_id { return Err(corrupt()); }
            validate_historical_basis(c,r.project_id,r.unit_id,&r.locale,&receipt.basis_evidence)?;
            let previous: Option<String> = c.query_row("SELECT decision_id FROM review_decisions
                WHERE project_id=?1 AND unit_id=?2 AND locale=?3 AND basis=?4
                AND rowid<(SELECT rowid FROM review_decisions WHERE action_id=?5) ORDER BY rowid DESC LIMIT 1",
                params![r.project_id.to_string(),r.unit_id.to_string(),r.locale,r.expected_basis,r.action_id.to_string()],
                |row|row.get(0)).optional().map_err(sql)?;
            if previous.map(parse_id).transpose()? != r.expected_decision_id { return Err(corrupt()); }
            Ok(Some(ReviewDecisionActionRead { request:r.clone(),receipt }))
        })
    }

    pub fn review_waiver_action_read(
        &self,
        r: &WaiverWrite,
    ) -> Result<Option<ReviewWaiverActionRead>, ExecutionError> {
        self.read_review_action(r.project_id, |c| {
            if !action_exists(c,"review_waivers",r.project_id,r.action_id)? { return Ok(None); }
            let (receipt,saved) = waiver_by_action(c,r.project_id,r.action_id)?.ok_or_else(corrupt)?;
            if saved != digest(r)? { return Err(failure(ErrorCode::ResultMismatch,"review-waiver-action")); }
            owned(c,r.project_id,r.unit_id)?;
            if receipt.unit_id != r.unit_id || receipt.locale != r.locale || receipt.basis != r.expected_basis
                || receipt.issue_id != r.issue_id || receipt.grant != r.grant || receipt.previous_waiver_id != r.expected_waiver_id
                || receipt.policy_version != POLICY_VERSION || receipt.actor != r.actor || receipt.reason != r.reason
                || r.grant == r.expected_waiver_id.is_some() { return Err(corrupt()); }
            if let Some(previous) = r.expected_waiver_id {
                let valid: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM review_waivers p JOIN review_waivers n
                    ON n.previous_waiver_id=p.waiver_id WHERE n.action_id=?1 AND p.waiver_id=?2
                    AND p.project_id=n.project_id AND p.unit_id=n.unit_id AND p.locale=n.locale
                    AND p.basis=n.basis AND p.issue_id=n.issue_id AND p.policy_version=n.policy_version
                    AND p.kind='grant' AND p.rowid<n.rowid)",params![r.action_id.to_string(),previous.to_string()],|row|row.get(0)).map_err(sql)?;
                if !valid { return Err(corrupt()); }
            }
            // The stored waiver names an issue and basis, not a changing latest run.
            let action: Option<String> = c.query_row("SELECT action_id FROM review_checks r
                WHERE project_id=?1 AND unit_id=?2 AND locale=?3 AND basis=?4 AND purpose='qa'
                AND EXISTS(SELECT 1 FROM json_each(r.rules_json) rule, json_each(rule.value,'$.findings') finding
                    WHERE json_extract(finding.value,'$.issueId')=?5 AND json_extract(finding.value,'$.waivable')=1)
                ORDER BY rowid DESC LIMIT 1",
                params![r.project_id.to_string(),r.unit_id.to_string(),r.locale,r.expected_basis,r.issue_id],|row|row.get(0))
                .optional().map_err(sql)?;
            let (run,_) = check_by_action(c,r.project_id,parse_id(action.ok_or_else(corrupt)?)?)?.ok_or_else(corrupt)?;
            if !run.rules.iter().flat_map(|rule| &rule.findings).any(|finding|finding.issue_id==r.issue_id && finding.waivable) { return Err(corrupt()); }
            Ok(Some(ReviewWaiverActionRead { request:r.clone(),receipt }))
        })
    }

    pub fn review_fallback_action_read(
        &self,
        r: &FallbackWrite,
    ) -> Result<Option<ReviewFallbackActionRead>, ExecutionError> {
        self.read_review_action(r.project_id, |c| {
            if !action_exists(c,"review_fallbacks",r.project_id,r.action_id)? { return Ok(None); }
            let (receipt,saved) = fallback_by_action(c,r.project_id,r.action_id)?.ok_or_else(corrupt)?;
            if saved != digest(r)? { return Err(failure(ErrorCode::ResultMismatch,"review-fallback-action")); }
            owned(c,r.project_id,r.unit_id)?;
            if receipt.unit_id != r.unit_id || receipt.locale != r.locale || receipt.allow != r.allow
                || receipt.previous_fallback_id != r.expected_fallback_id || receipt.policy_version != POLICY_VERSION
                || receipt.actor != r.actor || receipt.reason != r.reason || r.allow == r.expected_fallback_id.is_some() { return Err(corrupt()); }
            let source: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM source_revisions WHERE unit_id=?1 AND revision_id=?2)",
                params![r.unit_id.to_string(),receipt.source_revision_id.to_string()],|row|row.get(0)).map_err(sql)?;
            if !source { return Err(corrupt()); }
            if let Some(previous) = r.expected_fallback_id {
                let valid: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM review_fallbacks p JOIN review_fallbacks n
                    ON n.previous_fallback_id=p.fallback_id WHERE n.action_id=?1 AND p.fallback_id=?2
                    AND p.project_id=n.project_id AND p.unit_id=n.unit_id AND p.locale=n.locale
                    AND p.source_revision_id=n.source_revision_id AND p.policy_version=n.policy_version
                    AND p.kind='allow' AND p.rowid<n.rowid)",params![r.action_id.to_string(),previous.to_string()],|row|row.get(0)).map_err(sql)?;
                if !valid { return Err(corrupt()); }
            }
            Ok(Some(ReviewFallbackActionRead { request:r.clone(),receipt }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{adopt_source, check, fixture, translate};
    use super::*;

    #[test]
    fn review_human_action_reads_preserve_original_requests_and_historical_receipts() {
        let (directory, mut store, project, units) = fixture();
        let unit = units[0];
        translate(&mut store, project, unit, "zh-CN", "你好 {{name}}");
        store
            .save_term(&crate::SaveTerm {
                project_id: project,
                action_id: ExecutionId::new(),
                term_id: None,
                locale: "zh-CN".into(),
                source: "Hello".into(),
                aliases: vec![],
                target: "欢迎".into(),
                protected: true,
                scope_unit_id: Some(unit),
                expected_revision_id: None,
                reason: "Preferred term".into(),
            })
            .unwrap();
        let run = check(&mut store, project, unit, "zh-CN");
        let issue = run
            .rules
            .iter()
            .flat_map(|r| &r.findings)
            .find(|f| f.code == "protected-form")
            .unwrap()
            .issue_id
            .clone();
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        let decision = ReviewWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis.clone(),
            expected_decision_id: None,
            actor: "Original reviewer".into(),
            kind: ReviewDecisionKind::Approve,
            reason: "Original reason".into(),
        };
        let waiver = WaiverWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis.clone(),
            issue_id: issue,
            grant: true,
            expected_waiver_id: None,
            actor: "Original reviewer".into(),
            reason: "Accepted original issue".into(),
        };
        let fallback_target = store.review_target(project, units[1], "fr-FR").unwrap();
        let fallback = FallbackWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: units[1],
            locale: "fr-FR".into(),
            expected_basis: fallback_target.basis,
            allow: true,
            expected_fallback_id: None,
            actor: "Original reviewer".into(),
            reason: "Use source for this entry".into(),
        };
        assert_eq!(store.review_decision_action_read(&decision).unwrap(), None);
        assert_eq!(store.review_waiver_action_read(&waiver).unwrap(), None);
        assert_eq!(store.review_fallback_action_read(&fallback).unwrap(), None);
        let decision_receipt = store.write_review(&decision).unwrap();
        let waiver_receipt = store.waive_review_issue(&waiver).unwrap();
        let fallback_receipt = store.allow_source_fallback(&fallback).unwrap();
        let next_decision = ReviewWrite {
            action_id: ExecutionId::new(),
            expected_decision_id: Some(decision_receipt.decision_id),
            kind: ReviewDecisionKind::RequestChanges,
            reason: "Later review".into(),
            ..decision.clone()
        };
        let next_waiver = WaiverWrite {
            action_id: ExecutionId::new(),
            grant: false,
            expected_waiver_id: Some(waiver_receipt.waiver_id),
            ..waiver.clone()
        };
        let next_fallback = FallbackWrite {
            action_id: ExecutionId::new(),
            allow: false,
            expected_fallback_id: Some(fallback_receipt.fallback_id),
            ..fallback.clone()
        };
        let next_decision_receipt = store.write_review(&next_decision).unwrap();
        let next_waiver_receipt = store.waive_review_issue(&next_waiver).unwrap();
        let next_fallback_receipt = store.allow_source_fallback(&next_fallback).unwrap();
        let assert_saved = |store: &ProjectStore| {
            for (request, receipt) in [
                (&decision, &decision_receipt),
                (&next_decision, &next_decision_receipt),
            ] {
                assert_eq!(
                    store.review_decision_action_read(request).unwrap(),
                    Some(ReviewDecisionActionRead {
                        request: request.clone(),
                        receipt: receipt.clone()
                    })
                );
            }
            for (request, receipt) in [
                (&waiver, &waiver_receipt),
                (&next_waiver, &next_waiver_receipt),
            ] {
                assert_eq!(
                    store.review_waiver_action_read(request).unwrap(),
                    Some(ReviewWaiverActionRead {
                        request: request.clone(),
                        receipt: receipt.clone()
                    })
                );
            }
            for (request, receipt) in [
                (&fallback, &fallback_receipt),
                (&next_fallback, &next_fallback_receipt),
            ] {
                assert_eq!(
                    store.review_fallback_action_read(request).unwrap(),
                    Some(ReviewFallbackActionRead {
                        request: request.clone(),
                        receipt: receipt.clone()
                    })
                );
            }
        };
        assert_saved(&store);
        let mut wrong = decision.clone();
        wrong.expected_decision_id = Some(ExecutionId::new());
        assert_eq!(
            store.review_decision_action_read(&wrong).unwrap_err().code,
            ErrorCode::ResultMismatch
        );
        let mut wrong = waiver.clone();
        wrong.issue_id = "0".repeat(64);
        assert_eq!(
            store.review_waiver_action_read(&wrong).unwrap_err().code,
            ErrorCode::ResultMismatch
        );
        let mut wrong = fallback.clone();
        wrong.expected_basis = "0".repeat(64);
        assert_eq!(
            store.review_fallback_action_read(&wrong).unwrap_err().code,
            ErrorCode::ResultMismatch
        );
        for index in 0..3 {
            let mut wrong = decision.clone();
            if index == 0 {
                wrong.actor = "Other".into();
            } else if index == 1 {
                wrong.locale = "fr-FR".into();
            } else {
                wrong.unit_id = units[1];
            }
            assert!(store.review_decision_action_read(&wrong).is_err());
        }
        let mut wrong = decision.clone();
        wrong.project_id = ExecutionId::new();
        assert_eq!(
            store.review_decision_action_read(&wrong).unwrap_err().code,
            ErrorCode::Unauthorized
        );
        store
            .execution_unknown
            .store(true, std::sync::atomic::Ordering::Release);
        assert_eq!(
            store.write_review(&decision).unwrap_err().code,
            ErrorCode::OutcomeUnknown
        );
        let c = store.connection().unwrap();
        c.execute(
            "UPDATE review_decisions SET actor='Changed row' WHERE action_id=?1",
            [decision.action_id.to_string()],
        )
        .unwrap();
        assert_eq!(
            store
                .review_decision_action_read(&decision)
                .unwrap_err()
                .code,
            ErrorCode::CorruptLedger
        );
        assert!(store.is_reconciling());
        c.execute(
            "UPDATE review_decisions SET actor=?2 WHERE action_id=?1",
            params![decision.action_id.to_string(), decision.actor],
        )
        .unwrap();
        assert_saved(&store);
        assert!(!store.is_reconciling());
        let c = store.connection().unwrap();
        c.execute(
            "UPDATE review_waivers SET reason='Changed row' WHERE action_id=?1",
            [waiver.action_id.to_string()],
        )
        .unwrap();
        assert_eq!(
            store.review_waiver_action_read(&waiver).unwrap_err().code,
            ErrorCode::CorruptLedger
        );
        c.execute(
            "UPDATE review_waivers SET reason=?2 WHERE action_id=?1",
            params![waiver.action_id.to_string(), waiver.reason],
        )
        .unwrap();
        c.execute(
            "UPDATE review_fallbacks SET request_digest=?2 WHERE action_id=?1",
            params![fallback.action_id.to_string(), "0".repeat(64)],
        )
        .unwrap();
        assert_eq!(
            store
                .review_fallback_action_read(&fallback)
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        c.execute(
            "UPDATE review_fallbacks SET request_digest=?2 WHERE action_id=?1",
            params![fallback.action_id.to_string(), digest(&fallback).unwrap()],
        )
        .unwrap();
        // Later translations, source scope and locale removal cannot invalidate an original action read.
        translate(
            &mut store,
            project,
            unit,
            "zh-CN",
            "New translation {{name}}",
        );
        adopt_source(&mut store, br#"{"replacement":"Changed source"}"#);
        let revision = store.metadata().unwrap().metadata_revision();
        store.set_target_locales(revision, &["ja".into()]).unwrap();
        let sequence = store
            .changes_since(crate::execution::Revision::new(0).unwrap())
            .sequence;
        assert_saved(&store);
        assert_eq!(store.changes_since(sequence).sequence, sequence);
        store.close().unwrap();
        let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
        assert_saved(&reopened);
    }
}
