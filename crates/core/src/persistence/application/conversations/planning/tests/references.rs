use super::*;

#[test]
fn conversation_references_keep_original_terms_files_and_paging_after_newer_changes() {
    let (_temp, mut store, project, _) = fixture();
    adopt_source(&mut store, br#"{"hello":"Hello"}"#);
    let unit = store.review_page(project, "zh-CN", 0, 10).unwrap().rows[0].unit_id;
    term(&mut store, project, unit, "原译名 🙂");
    let mut req = request(&store, project, &[unit]);
    req.config.share_terms = true;
    let capture = store.prepare_conversation_planning(&req).unwrap();
    let prepared = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    let mut runtime = planning_runtime(&store);
    runtime
        .submit_conversation_planning(&mut store, &prepared)
        .unwrap();
    let attempt = prepared.consent.attempt_id;
    let first = readonly(&store, || {
        store
            .conversation_references(project, req.conversation_id, attempt, 0, 1)
            .unwrap()
            .unwrap()
    });
    assert_eq!(first.total, 2);
    assert_eq!(first.next_after, Some(1));
    assert_eq!(first.input_digest, prepared.input().digest());
    let ConversationMaterialReference::Term {
        unit: basis,
        original,
        current,
    } = &first.rows[0]
    else {
        panic!("Original shared term required");
    };
    assert_eq!(original.target, "原译名 🙂");
    assert_eq!(current.as_ref().unwrap(), original);
    assert_eq!(basis.unit_id, unit);
    let old_revision = crate::persistence::resources::term_by_revision(
        store.connection().unwrap(),
        project,
        original.revision_id,
    )
    .unwrap()
    .unwrap();
    store
        .save_term(&SaveTerm {
            project_id: project,
            action_id: ExecutionId::new(),
            term_id: Some(old_revision.term_id.clone()),
            locale: old_revision.locale,
            source: old_revision.source,
            aliases: old_revision.aliases,
            target: "较新 B {{name}}".into(),
            protected: old_revision.protected,
            scope_unit_id: old_revision.scope_unit_id,
            expected_revision_id: Some(original.revision_id),
            reason: "A later explicit term edit".into(),
        })
        .unwrap();
    let reread = readonly(&store, || {
        store
            .conversation_references(project, req.conversation_id, attempt, 0, 1)
            .unwrap()
            .unwrap()
    });
    let ConversationMaterialReference::Term {
        original: same,
        current: newer,
        ..
    } = &reread.rows[0]
    else {
        panic!("Term reference required");
    };
    assert_eq!(same, original);
    assert_eq!(newer.as_ref().unwrap().target, "较新 B {{name}}");
    let file = readonly(&store, || {
        store
            .conversation_references(project, req.conversation_id, attempt, 1, 1)
            .unwrap()
            .unwrap()
    });
    let ConversationMaterialReference::File {
        unit: file_unit,
        logical_path,
        ..
    } = &file.rows[0]
    else {
        panic!("Saved file reference required");
    };
    assert_eq!(file_unit, basis);
    assert!(!logical_path.is_empty());
    assert_eq!(file.next_after, None);
    adopt_source(&mut store, br#"{"hello":"New source"}"#);
    let historical = readonly(&store, || {
        store
            .conversation_references(project, req.conversation_id, attempt, 0, 16)
            .unwrap()
            .unwrap()
    });
    assert_ne!(
        historical.current_snapshot_id,
        Some(basis.source_snapshot_id)
    );
    assert!(
        matches!(&historical.rows[1], ConversationMaterialReference::File { unit: original, .. } if original == basis)
    );
    assert!(
        store
            .conversation_references(project, req.conversation_id, attempt, 3, 1)
            .is_err()
    );
}

#[test]
fn conversation_references_require_original_project_conversation_and_shared_material() {
    let (_temp, mut store, project, units) = fixture();
    let mut req = request(&store, project, &units[..1]);
    req.scope = ConversationPlanningScope::ConversationOnly {};
    let capture = store.prepare_conversation_planning(&req).unwrap();
    let prepared = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    let mut runtime = planning_runtime(&store);
    runtime
        .submit_conversation_planning(&mut store, &prepared)
        .unwrap();
    let attempt = prepared.consent.attempt_id;
    let page = readonly(&store, || {
        store
            .conversation_references(project, req.conversation_id, attempt, 0, 8)
            .unwrap()
            .unwrap()
    });
    assert_eq!(page.total, 0);
    assert!(page.rows.is_empty());
    assert_eq!(page.next_after, None);
    let other = request(&store, project, &units[..1]);
    readonly(&store, || {
        assert!(
            store
                .conversation_references(project, other.conversation_id, attempt, 0, 8)
                .is_err()
        );
        assert!(
            store
                .conversation_references(ExecutionId::new(), req.conversation_id, attempt, 0, 8)
                .is_err()
        );
        assert!(
            store
                .conversation_references(project, req.conversation_id, attempt, 0, 0)
                .is_err()
        );
        assert!(
            store
                .conversation_references(project, req.conversation_id, attempt, 0, 17)
                .is_err()
        );
        assert!(
            store
                .conversation_references(project, req.conversation_id, ExecutionId::new(), 0, 8)
                .unwrap()
                .is_none()
        );
    });
}
