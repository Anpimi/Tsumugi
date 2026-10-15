use super::super::tests::{fixture, translate};
use super::*;

#[test]
fn finding_disposition_refuses_core_or_unproven_findings_without_changing_qualification() {
    let (_directory, mut store, project, units) = fixture();
    let target = store.review_target(project, units[0], "zh-CN").unwrap();
    let run = store
        .run_review_checks(
            project,
            target.unit_id,
            "zh-CN",
            &target.basis,
            ExecutionId::new(),
        )
        .unwrap();
    let before = store
        .review_eligibility(project, &["zh-CN".into()])
        .unwrap();
    let issue = run.rules.iter().flat_map(|r| &r.findings).next().unwrap();
    for disposition in [
        ReviewFindingDisposition::Rejected,
        ReviewFindingDisposition::Restored,
        ReviewFindingDisposition::RepairRequested,
    ] {
        let request = ReviewFindingWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: target.unit_id,
            locale: "zh-CN".into(),
            expected_basis: target.basis.clone(),
            run_id: run.run_id,
            issue_id: issue.issue_id.clone(),
            expected_decision_id: None,
            disposition,
            actor: "Synthetic reviewer".into(),
            reason: "Cannot bypass required checks".into(),
        };
        assert_eq!(
            store.write_review_finding(&request).unwrap_err().code,
            ErrorCode::Unauthorized
        );
        assert!(
            store
                .review_finding_action(project, request.action_id)
                .unwrap()
                .is_none()
        );
    }
    assert_eq!(
        store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap(),
        before
    );
    let view = store
        .review_findings(project, target.unit_id, "zh-CN", 0, 10)
        .unwrap();
    assert!(view.findings.is_empty() && view.history.is_empty() && view.repairs.is_empty());
}

#[test]
fn finding_reads_and_writes_check_project_locale_basis_and_page_bounds() {
    let (_directory, mut store, project, units) = fixture();
    translate(
        &mut store,
        project,
        units[0],
        "zh-CN",
        "Synthetic translation",
    );
    let target = store.review_target(project, units[0], "zh-CN").unwrap();
    let mut request = ReviewFindingWrite {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: target.unit_id,
        locale: "zh-CN".into(),
        expected_basis: target.basis.clone(),
        run_id: ExecutionId::new(),
        issue_id: "a".repeat(64),
        expected_decision_id: None,
        disposition: ReviewFindingDisposition::Rejected,
        actor: "Synthetic reviewer".into(),
        reason: "Synthetic reason".into(),
    };
    request.project_id = ExecutionId::new();
    assert_eq!(
        store.write_review_finding(&request).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .review_finding_action(request.project_id, request.action_id)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    request.project_id = project;
    request.expected_basis = "b".repeat(64);
    assert_eq!(
        store.write_review_finding(&request).unwrap_err().code,
        ErrorCode::DependencyConflict
    );
    assert!(
        store
            .review_findings(project, target.unit_id, "zh-CN", 0, 0)
            .is_err()
    );
    assert!(
        store
            .review_findings(project, target.unit_id, "zh-CN", 0, 51)
            .is_err()
    );
    assert!(
        store
            .review_findings(project, target.unit_id, "zh-CN", 10001, 10)
            .unwrap()
            .history
            .is_empty()
    );
    assert!(
        store
            .review_findings(project, target.unit_id, "zh-CN", u32::MAX, 10)
            .unwrap()
            .history
            .is_empty()
    );
    assert!(
        store
            .review_findings(project, target.unit_id, "fr", 0, 10)
            .is_err()
    );
}

#[test]
fn current_schema_reopens_finding_layout_and_refuses_missing_index_without_reset() {
    let (_directory, store, _project, _units) = fixture();
    let path = store.directory().to_path_buf();
    drop(store);
    let store = ProjectStore::open(&path).unwrap();
    drop(store);
    let c = Connection::open(path.join("project.sqlite3")).unwrap();
    c.execute_batch("DROP INDEX review_finding_scope").unwrap();
    drop(c);
    assert!(ProjectStore::open(&path).is_err());
    let c = Connection::open(path.join("project.sqlite3")).unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM review_finding_decisions", [], |r| r
            .get::<_, u32>(
            0
        ))
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        38
    );
}

#[test]
fn finding_transitions_keep_rejection_restoration_and_repair_distinct() {
    use ReviewFindingDisposition::*;
    assert!(transition(None, Rejected));
    assert!(!transition(None, Restored));
    assert!(!transition(Some(Rejected), Rejected));
    assert!(!transition(Some(Rejected), RepairRequested));
    assert!(transition(Some(Rejected), Restored));
    assert!(transition(Some(Restored), RepairRequested));
    assert!(!transition(Some(RepairRequested), RepairRequested));
}
