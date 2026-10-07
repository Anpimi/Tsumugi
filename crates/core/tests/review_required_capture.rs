#![cfg(not(feature = "execution-test-host"))]
//! Normal Core/SQLite capture and policy computation over a synthetic adopted
//! SDK source. Coverage probes do not execute a domain worker or record QA.
mod support;
use sha2::{Digest, Sha256};
use tsumugi_core::{
    ProjectStore, ReviewCheckPlan, ReviewDecisionKind, ReviewWrite, SaveTerm,
    SaveTranslationRevision, execution::*,
};
use tsumugi_plugin_sdk as sdk;

fn project(store: &ProjectStore) -> ExecutionId {
    ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap()
}
fn plan(store: &ProjectStore, unit: ExecutionId) -> ReviewCheckPlan {
    let project = project(store);
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store
        .capture_review_check_plan(project, unit, "zh-CN", &target.basis, &[])
        .unwrap()
}
fn save(store: &mut ProjectStore, unit: ExecutionId, text: &str) {
    let project = project(store);
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: target.source_revision_id,
            expected_selection_id: target.selection_id,
            text: text.into(),
        })
        .unwrap();
}
fn domain_results(plan: &ReviewCheckPlan) -> Vec<sdk::CheckResult> {
    // Deliberately synthetic contract probes, not authenticated execution.
    plan.domain_input()
        .requirements
        .iter()
        .map(|r| sdk::CheckResult {
            key: r.key.clone(),
            input_digest: r.input_digest.clone(),
            scope_digest: r.scope_digest.clone(),
            covered_targets: r.targets.clone(),
            outcome: r
                .not_applicable
                .clone()
                .map_or(sdk::CheckOutcome::Completed { findings: vec![] }, |basis| {
                    sdk::CheckOutcome::NotApplicable { basis }
                }),
        })
        .collect()
}
fn snapshot(path: &std::path::Path) -> String {
    format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))
}
fn rules() -> Vec<sdk::ReviewRuleDeclaration> {
    [
        ("third.qa.source", false),
        ("third.qa.text", true),
        ("third.qa.additional", true),
    ]
    .into_iter()
    .enumerate()
    .map(
        |(index, (id, requires_translation))| sdk::ReviewRuleDeclaration {
            rule: sdk::ContractRef {
                id: id.into(),
                schema_version: 1,
                behavior_version: index as u32 + 1,
            },
            requires_translation,
        },
    )
    .collect()
}

#[test]
fn adopted_capture_preserves_original_source_and_exact_identity_without_writes() {
    let (directory, store, rows) = support::source_fixture_with_review_rules(rules());
    let project = project(&store);
    let unit = rows[1].unit_id.unwrap();
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    let path = directory.path().join("project/project.sqlite3");
    let before = snapshot(&path);
    let changes = serde_json::to_value(store.changes_since(Revision::new(0).unwrap())).unwrap();
    let captured = plan(&store, unit);
    assert_eq!(captured.unit_id(), unit);
    assert_eq!(captured.review_basis(), target.basis);
    assert_ne!(captured.basis(), target.basis);
    let input = captured.domain_input();
    assert_eq!(input.source.artifacts[0].utf8, "same\nsame");
    assert_eq!(input.source.artifacts[1].utf8, "opaque companion");
    assert_eq!(input.source.units.len(), 2);
    assert_eq!(
        input.source.order,
        ["occurrence-first", "occurrence-second"]
    );
    assert_eq!(input.selections.len(), 1);
    // Both units have the same text; association must use the persisted mapping.
    assert_eq!(input.selections[0].unit_id, "unit-second");
    assert_eq!(input.selections[0].source_revision_id, "source-second");
    assert_eq!(input.selections[0].translation_text, None);
    assert_eq!(input.requirements.len(), 3);
    assert_eq!(captured.fixed_checks().set().requirements.len(), 5);
    assert_eq!(captured.binding().declaration.rules, rules());
    let sdk::ExecutionEnvironmentDescriptor::Captured(environment) =
        &captured.binding().checker.environment
    else {
        panic!("captured Node fixture");
    };
    assert_eq!(environment.tool.tree_digest, "b".repeat(64));
    assert_eq!(environment.host.tree_digest, "c".repeat(64));
    for (r, declaration) in input.requirements.iter().zip(rules()) {
        assert_eq!(r.key.rule, declaration.rule);
        assert!(r.mandatory && !r.waivable);
        assert_eq!(r.not_applicable.is_some(), declaration.requires_translation);
        assert_eq!(r.targets, ["unit-second"]);
        let sdk::CheckImplementation::Plugin { provider } = &r.key.implementation else {
            panic!()
        };
        assert_eq!(provider, &captured.binding().checker.capability.provider);
    }
    let prepared = store
        .prepare_review_check(
            project,
            unit,
            "zh-CN",
            &target.basis,
            ExecutionId::new(),
            &[],
        )
        .unwrap();
    assert_eq!(prepared.plan().unwrap().basis(), captured.basis());
    assert_eq!(snapshot(&path), before);
    assert_eq!(
        serde_json::to_value(store.changes_since(Revision::new(0).unwrap())).unwrap(),
        changes
    );
}

#[test]
fn complete_union_requires_core_and_all_declared_domain_versions_and_bases() {
    let (_directory, store, rows) = support::source_fixture_with_review_rules(rules());
    let captured = plan(&store, rows[0].unit_id.unwrap());
    let core = captured
        .compute_core_checks(&Cancellation::default())
        .unwrap();
    let domain = domain_results(&captured);
    assert_eq!(core.len(), 2);
    assert!(!captured.fixed_checks().evaluate(&[]).unwrap().complete);
    assert!(!captured.fixed_checks().evaluate(&core).unwrap().complete);
    assert!(!captured.fixed_checks().evaluate(&domain).unwrap().complete);
    let mut all = core.clone();
    all.extend(domain.clone());
    assert!(captured.fixed_checks().evaluate(&all).unwrap().complete);
    all.pop();
    assert!(!captured.fixed_checks().evaluate(&all).unwrap().complete);
    for case in 0..6 {
        let mut changed = domain.clone();
        match case {
            0 => changed[0].key.rule.behavior_version += 1,
            1 => changed[0].input_digest = "d".repeat(64),
            2 => changed[0].scope_digest = "d".repeat(64),
            3 => changed[0].covered_targets = vec!["unit-second".into()],
            4 => changed.push(changed[0].clone()),
            _ => {
                changed[0].outcome = sdk::CheckOutcome::NotApplicable {
                    basis: sdk::NotApplicableBasis {
                        code: sdk::MISSING_REVIEW_TRANSLATION.into(),
                        basis_digest: domain[0].input_digest.clone(),
                    },
                }
            }
        }
        let mut union = core.clone();
        union.extend(changed);
        assert!(
            captured.fixed_checks().evaluate(&union).is_err(),
            "case {case}"
        );
    }
}

#[test]
fn empty_and_missing_translation_have_different_policy_and_applicability() {
    let (_directory, mut store, rows) = support::source_fixture_with_review_rules(rules());
    let unit = rows[0].unit_id.unwrap();
    let missing = plan(&store, unit);
    let missing_core = missing
        .compute_core_checks(&Cancellation::default())
        .unwrap();
    let sdk::CheckOutcome::Completed { findings } = &missing_core[0].outcome else {
        panic!()
    };
    assert_eq!(findings[0].code, "missing");
    assert!(matches!(
        missing_core[1].outcome,
        sdk::CheckOutcome::NotApplicable { .. }
    ));
    save(&mut store, unit, "");
    let empty = plan(&store, unit);
    assert_eq!(
        empty.domain_input().selections[0]
            .translation_text
            .as_deref(),
        Some("")
    );
    assert_ne!(empty.basis(), missing.basis());
    assert!(
        empty
            .domain_input()
            .requirements
            .iter()
            .all(|r| r.not_applicable.is_none())
    );
    let core = empty.compute_core_checks(&Cancellation::default()).unwrap();
    let sdk::CheckOutcome::Completed { findings } = &core[0].outcome else {
        panic!()
    };
    assert_eq!(findings[0].code, "empty");
    assert!(matches!(
        core[1].outcome,
        sdk::CheckOutcome::Completed { .. }
    ));
}

#[test]
fn owned_core_computation_survives_close_preserves_text_and_cancellation() {
    let (directory, mut store, rows) = support::source_fixture_with_review_rules(rules());
    let unit = rows[0].unit_id.unwrap();
    let text = "é 👩🏽‍💻 {{domain syntax stays opaque";
    save(&mut store, unit, text);
    let captured = plan(&store, unit);
    assert_eq!(
        captured.domain_input().selections[0]
            .translation_text
            .as_deref(),
        Some(text)
    );
    let basis = captured.basis().to_owned();
    store.close().unwrap();
    let core = captured
        .compute_core_checks(&Cancellation::default())
        .unwrap();
    assert!(core.iter().all(
        |r| matches!(&r.outcome, sdk::CheckOutcome::Completed { findings } if findings.is_empty())
    ));
    let cancelled = Cancellation::default();
    cancelled.request();
    assert!(
        captured
            .compute_core_checks(&cancelled)
            .unwrap()
            .iter()
            .all(|r| r.outcome == sdk::CheckOutcome::Cancelled)
    );
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    let fresh = plan(&reopened, unit);
    assert_eq!(fresh.basis(), basis);
    assert_eq!(fresh.domain_input(), captured.domain_input());
    assert_eq!(fresh.fixed_checks().set(), captured.fixed_checks().set());
}

#[test]
fn capture_refuses_wrong_project_language_unit_and_stale_basis_without_writes() {
    let (directory, store, rows) = support::source_fixture();
    let project = project(&store);
    let unit = rows[0].unit_id.unwrap();
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    let path = directory.path().join("project/project.sqlite3");
    let before = snapshot(&path);
    for (p, u, locale, basis) in [
        (ExecutionId::new(), unit, "zh-CN", target.basis.as_str()),
        (project, ExecutionId::new(), "zh-CN", target.basis.as_str()),
        (project, unit, "fr-FR", target.basis.as_str()),
        (project, unit, "zh-CN", "stale"),
    ] {
        assert!(
            store
                .capture_review_check_plan(p, u, locale, basis, &[])
                .is_err()
        );
    }
    assert_eq!(snapshot(&path), before);
}

#[test]
fn unrelated_selection_does_not_expire_target_capture_or_manual_approval() {
    let (_directory, mut store, rows) = support::source_fixture();
    let project = project(&store);
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "translated first");
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    let decision = store
        .write_review(&ReviewWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis,
            expected_decision_id: None,
            actor: "Reviewer".into(),
            kind: ReviewDecisionKind::Approve,
            reason: String::new(),
        })
        .unwrap();
    let captured = plan(&store, unit);
    save(&mut store, rows[1].unit_id.unwrap(), "translated second");
    assert_eq!(plan(&store, unit).basis(), captured.basis());
    assert_eq!(
        store
            .review_target(project, unit, "zh-CN")
            .unwrap()
            .current_decision,
        Some(decision)
    );
    save(&mut store, unit, "changed first");
    assert_ne!(plan(&store, unit).basis(), captured.basis());
    assert!(
        store
            .review_target(project, unit, "zh-CN")
            .unwrap()
            .current_decision
            .is_none()
    );
}

#[test]
fn corrupted_source_mapping_is_rejected_by_the_original_snapshot_owner() {
    let (directory, store, rows) = support::source_fixture();
    let project = project(&store);
    let unit = rows[0].unit_id.unwrap();
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    let path = directory.path().join("project/project.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE source_unit_mappings SET local_revision_id='substituted' WHERE unit_id=?1",
            [unit.to_string()],
        )
        .unwrap();
    let before = snapshot(&path);
    let error = store
        .capture_review_check_plan(project, unit, "zh-CN", &target.basis, &[])
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::CorruptLedger);
    assert_eq!(snapshot(&path), before);
}

#[test]
fn distinct_protected_terms_keep_separate_findings_and_current_resource_basis() {
    let (_directory, mut store, rows) = support::source_fixture();
    let project = project(&store);
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "translated");
    let before = plan(&store, unit);
    for (source, target) in [("same", "one"), ("sam", "two")] {
        store
            .save_term(&SaveTerm {
                project_id: project,
                action_id: ExecutionId::new(),
                term_id: None,
                locale: "zh-CN".into(),
                source: source.into(),
                aliases: vec![],
                target: target.into(),
                protected: true,
                scope_unit_id: Some(unit),
                expected_revision_id: None,
                reason: "Synthetic protected term".into(),
            })
            .unwrap();
    }
    let captured = plan(&store, unit);
    assert_ne!(captured.basis(), before.basis());
    let mut core = captured
        .compute_core_checks(&Cancellation::default())
        .unwrap();
    let sdk::CheckOutcome::Completed { findings } = &core[1].outcome else {
        panic!()
    };
    assert_eq!(findings.len(), 2);
    assert_ne!(findings[0].code, findings[1].code);
    assert!(
        findings
            .iter()
            .all(|f| f.severity == sdk::FindingSeverity::Warning)
    );
    core.extend(domain_results(&captured));
    assert!(captured.fixed_checks().evaluate(&core).unwrap().complete);
    // Complete means that all checks ran, not that blocking findings vanished.
    save(&mut store, unit, "one and two");
    let corrected = plan(&store, unit);
    let core = corrected
        .compute_core_checks(&Cancellation::default())
        .unwrap();
    assert_ne!(corrected.basis(), captured.basis());
    assert!(core.iter().all(
        |r| matches!(&r.outcome, sdk::CheckOutcome::Completed { findings } if findings.is_empty())
    ));
}
