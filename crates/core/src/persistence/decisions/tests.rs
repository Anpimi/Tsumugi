use super::*;
use crate::persistence::review::tests::{adopt_source, fixture, translate};

#[test]
fn a_failed_source_keeps_other_decisions_and_leaves_the_total_unknown() {
    let (_directory, mut store, project, units) = fixture();
    translate(&mut store, project, units[0], "zh-CN", "A saved translation");
    // Simulate one unreadable source in this isolated database, after opening.
    store.connection().unwrap().execute_batch("DROP TABLE resource_captures").unwrap();
    let page = store.decision_page(project, &DecisionQuery { locale: Some("zh-CN".into()),
        sources: vec![DecisionSource::HumanReview, DecisionSource::ResourceProposal] }, None, 100, |_| false).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].source, DecisionSource::HumanReview);
    assert_eq!(page.known_count, 1);
    assert_eq!(page.total, None);
    let source = page.coverage.iter().find(|source| source.source == DecisionSource::ResourceProposal).unwrap();
    assert_eq!(source.state, DecisionCoverageState::Unavailable);
    assert_eq!(source.total, None);
    assert_eq!(source.reason, Some(DecisionCoverageReason::SourceUnavailable));
    assert!(source.error_code.is_some());
}

#[test]
fn cursors_accept_original_identities_with_long_valid_language_tags() {
    let locale = format!("en-x-{}", vec!["abcdefgh"; 40].join("-"));
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(directory.path().join("project"),
        crate::ProjectMetadata::create("Long language tag", "en", [&locale]).unwrap()).unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    adopt_source(&mut store, br#"{"first":"First","second":"Second"}"#);
    let units = store.review_page(project, &locale, 0, 10).unwrap().rows;
    for unit in units { translate(&mut store, project, unit.unit_id, &locale, "A saved translation"); }
    let query = DecisionQuery { locale: Some(locale), sources: vec![DecisionSource::HumanReview] };
    let first = store.decision_page(project, &query, None, 1, |_| false).unwrap();
    let cursor = first.next.as_ref().unwrap();
    assert!(cursor.after_id.len() > 300);
    let next = store.decision_page(project, &query, Some(cursor), 1, |_| false).unwrap();
    assert_eq!(next.items.len(), 1);
    assert_ne!(first.items[0].decision_id, next.items[0].decision_id);
    assert_eq!((first.known_count, next.total), (2, Some(2)));
    assert!(next.next.is_none());
}
