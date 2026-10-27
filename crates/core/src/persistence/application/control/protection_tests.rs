use super::*;
use crate::persistence::review::tests::fixture;

fn set_protection(
    store: &mut ProjectStore,
    project: ExecutionId,
    unit: ExecutionId,
    protected: bool,
) -> WorkProtection {
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    let current = store.work_protection(unit, "zh-CN").unwrap();
    store.set_work_protection(&SetWorkProtection {
        action_id: ExecutionId::new(),
        project_id: project,
        unit_id: unit,
        locale: "zh-CN".into(),
        source_revision_id: target.source_revision_id,
        selection_id: target.selection_id,
        expected_revision: current.revision,
        protected,
        confirmed_release: !protected,
    }).unwrap()
}

#[test]
fn protection_summaries_match_single_reads_for_missing_protected_and_released_rows() {
    let (_directory, mut store, project, units) = fixture();
    let missing = protection_summaries(store.connection().unwrap(), project, &units, "zh-CN").unwrap();
    assert_eq!(missing.len(), units.len());
    for unit in &units {
        assert_eq!(missing[unit], store.work_protection(*unit, "zh-CN").unwrap());
        assert_eq!(missing[unit].revision.get(), 0);
        assert!(!missing[unit].protected);
    }
    let protected = set_protection(&mut store, project, units[0], true);
    let batch = protection_summaries(store.connection().unwrap(), project, &units, "zh-CN").unwrap();
    assert_eq!(batch[&units[0]], protected);
    assert_eq!(batch[&units[1]], missing[&units[1]]);
    let released = set_protection(&mut store, project, units[0], false);
    assert!(released.revision > protected.revision);
    let batch = protection_summaries(store.connection().unwrap(), project, &units, "zh-CN").unwrap();
    assert_eq!(batch[&units[0]], released);
    assert_eq!(batch[&units[1]], missing[&units[1]]);
    let french = protection_summaries(store.connection().unwrap(), project, &units, "fr-FR").unwrap();
    assert!(french.values().all(|value| value.revision.get() == 0 && !value.protected));
    let path = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(path).unwrap();
    let reopened_batch = protection_summaries(reopened.connection().unwrap(), project, &units, "zh-CN").unwrap();
    assert_eq!(reopened_batch, batch);
}

#[test]
fn protection_summaries_validate_project_units_and_canonical_locale() {
    let (_directory, store, project, units) = fixture();
    let connection = store.connection().unwrap();
    assert_eq!(protection_summaries(connection, ExecutionId::new(), &units, "zh-CN").unwrap_err().code, ErrorCode::Unauthorized);
    assert_eq!(protection_summaries(connection, project, &[units[0], ExecutionId::new()], "zh-CN").unwrap_err().code, ErrorCode::Unauthorized);
    assert_eq!(protection_summaries(connection, project, &[units[0], units[0]], "zh-CN").unwrap_err().code, ErrorCode::InvalidInput);
    assert!(protection_summaries(connection, project, &units, "zh-cn").is_err());
    assert!(protection_summaries(connection, project, &[], "zh-CN").unwrap().is_empty());
    assert_eq!(protection_summaries(connection, ExecutionId::new(), &[], "zh-CN").unwrap_err().code, ErrorCode::Unauthorized);
}
