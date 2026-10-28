#![cfg(not(feature = "execution-test-host"))]
//! Typed human knowledge through the real project authority; no Provider calls.
mod support;
use tsumugi_core::{
    ai::{self, AiConfig},
    execution::*,
    *,
};
use tsumugi_plugin_sdk as sdk;

fn source_scope(store: &ProjectStore, row: &content::ContentRow) -> SourceContextRequest {
    SourceContextRequest {
        project_id: ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
            .unwrap(),
        source_snapshot_id: store.content_scope().unwrap().current_snapshot.unwrap(),
        unit_id: row.unit_id.unwrap(),
        source_revision_id: row.source_revision_id.unwrap(),
        locale: "zh-CN".into(),
    }
}
fn save(
    store: &ProjectStore,
    scope: &SourceContextRequest,
    kind: ContextResourceKind,
) -> SaveContextResource {
    SaveContextResource {
        project_id: scope.project_id,
        action_id: ExecutionId::new(),
        context_id: None,
        subject_id: None,
        expected_revision_id: None,
        source_basis: store.content_scope().unwrap(),
        kind,
        locale: scope.locale.clone(),
        scope: ContextResourceScope::Project,
        name: "Synthetic knowledge".into(),
        text: "Human supplied material".into(),
        actor: "Synthetic editor".into(),
        reason: "Explicit human entry".into(),
    }
}
fn config(share: bool) -> AiConfig {
    AiConfig {
        endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
        model: "synthetic".into(),
        credential_env: String::new(),
        share_context: share,
        ..Default::default()
    }
}
fn prompt(config: &AiConfig, item: &ai::AiItem) -> serde_json::Value {
    serde_json::from_str(
        ai::request_body(config, item).unwrap()["messages"][1]["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn types_cas_actions_paging_and_reopen_preserve_original_authority() {
    let (_dir, mut store, rows) = support::source_fixture();
    let scope = source_scope(&store, &rows[0]);
    let mut versions = vec![];
    for kind in [
        ContextResourceKind::Character,
        ContextResourceKind::Style,
        ContextResourceKind::Background,
    ] {
        let request = save(&store, &scope, kind);
        let first = store.save_context_resource(&request).unwrap();
        assert_eq!(store.save_context_resource(&request).unwrap(), first);
        assert_eq!(
            store
                .context_resource_action(scope.project_id, request.action_id)
                .unwrap()
                .unwrap()
                .request,
            ContextResourceAction::Save(request.clone())
        );
        let mut changed = request.clone();
        changed.text = "Forged replay".into();
        assert_eq!(
            store.save_context_resource(&changed).unwrap_err().code,
            ErrorCode::ResultMismatch
        );
        changed.action_id = ExecutionId::new();
        changed.context_id = Some(first.context_id);
        assert_eq!(
            store.save_context_resource(&changed).unwrap_err().code,
            ErrorCode::DependencyConflict
        );
        changed.expected_revision_id = Some(first.revision_id);
        let second = store.save_context_resource(&changed).unwrap();
        assert_eq!(second.subject_id, first.subject_id);
        versions.push(second);
    }
    let page = store
        .list_context_resources(scope.project_id, &scope.locale, None, 0, 1, None)
        .unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.next_offset, Some(1));
    assert!(
        store
            .list_context_resources(scope.project_id, &scope.locale, None, 1, 1, None)
            .is_err()
    );
    assert_eq!(
        store
            .list_context_resources(
                scope.project_id,
                &scope.locale,
                None,
                1,
                1,
                Some(&page.basis)
            )
            .unwrap()
            .rows
            .len(),
        1
    );
    let value = &versions[0];
    let edit = SaveContextResource {
        context_id: Some(value.context_id),
        expected_revision_id: Some(value.revision_id),
        name: value.name.clone(),
        text: value.text.clone(),
        reason: "Only the reason changes".into(),
        ..save(&store, &scope, value.kind)
    };
    store.save_context_resource(&edit).unwrap();
    assert_eq!(
        store
            .list_context_resources(
                scope.project_id,
                &scope.locale,
                None,
                1,
                1,
                Some(&page.basis)
            )
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    let current = store
        .current_context_resource(scope.project_id, value.context_id)
        .unwrap()
        .unwrap();
    let withdrawal = WithdrawContextResource {
        project_id: scope.project_id,
        action_id: ExecutionId::new(),
        context_id: current.context_id,
        expected_revision_id: current.revision_id,
        actor: "Synthetic editor".into(),
        reason: "Stop this scoped material".into(),
    };
    let stopped = store.withdraw_context_resource(&withdrawal).unwrap();
    assert!(stopped.withdrawn);
    assert_eq!(
        store.withdraw_context_resource(&withdrawal).unwrap(),
        stopped
    );
    let project_path = store.directory().to_path_buf();
    drop(store);
    let reopened = ProjectStore::open(project_path).unwrap();
    assert_eq!(
        reopened
            .current_context_resource(scope.project_id, stopped.context_id)
            .unwrap(),
        Some(stopped)
    );
    assert_eq!(
        reopened
            .context_resource_history(scope.project_id, current.context_id, 0, 100, None)
            .unwrap()
            .rows
            .len(),
        4
    );
}

#[test]
fn explicit_subjects_resolve_scopes_conflicts_and_tombstones_without_name_merging() {
    let (_dir, mut store, rows) = support::source_fixture();
    let scope = source_scope(&store, &rows[0]);
    let base = store
        .save_context_resource(&save(&store, &scope, ContextResourceKind::Character))
        .unwrap();
    let override_request = SaveContextResource {
        subject_id: Some(base.subject_id),
        scope: ContextResourceScope::Unit {
            unit_id: scope.unit_id,
        },
        text: "Specific description".into(),
        ..save(&store, &scope, base.kind)
    };
    let narrow = store.save_context_resource(&override_request).unwrap();
    let resolved = store.resolve_context_resources(&scope).unwrap();
    assert_eq!(
        resolved
            .entries
            .iter()
            .find(|e| e.revision.context_id == base.context_id)
            .unwrap()
            .status,
        ContextResourceStatus::Shadowed
    );
    assert_eq!(
        resolved
            .entries
            .iter()
            .find(|e| e.revision.context_id == narrow.context_id)
            .unwrap()
            .status,
        ContextResourceStatus::Selected
    );
    let conflict = store
        .save_context_resource(&SaveContextResource {
            action_id: ExecutionId::new(),
            text: "Different explicit description".into(),
            ..override_request.clone()
        })
        .unwrap();
    assert_eq!(
        store
            .resolve_context_resources(&scope)
            .unwrap()
            .entries
            .iter()
            .filter(|e| e.status == ContextResourceStatus::Conflict)
            .count(),
        2
    );
    for value in [narrow, conflict] {
        store
            .withdraw_context_resource(&WithdrawContextResource {
                project_id: scope.project_id,
                action_id: ExecutionId::new(),
                context_id: value.context_id,
                expected_revision_id: value.revision_id,
                actor: "Synthetic editor".into(),
                reason: "Stop scoped variant".into(),
            })
            .unwrap();
    }
    // Different stopped values still expose a same-rank conflict. Neither can
    // silently reveal the wider project setting or delete its history.
    assert!(
        store
            .resolve_context_resources(&scope)
            .unwrap()
            .entries
            .iter()
            .all(|e| e.revision.context_id != base.context_id
                || e.status == ContextResourceStatus::Shadowed)
    );
    let independent = store
        .save_context_resource(&save(&store, &scope, base.kind))
        .unwrap();
    assert_ne!(independent.subject_id, base.subject_id);
    let other = source_scope(&store, &rows[1]);
    assert_eq!(
        store
            .resolve_context_resources(&other)
            .unwrap()
            .entries
            .iter()
            .filter(|e| e.status == ContextResourceStatus::Selected)
            .count(),
        2
    );
}

#[test]
fn withdrawing_a_specific_variant_masks_wider_material_and_explicit_save_restores_it() {
    let (_dir, mut store, rows) = support::source_fixture();
    let scope = source_scope(&store, &rows[0]);
    let original = save(&store, &scope, ContextResourceKind::Style);
    let project = store.save_context_resource(&original).unwrap();
    let variant_request = SaveContextResource {
        subject_id: Some(project.subject_id),
        scope: ContextResourceScope::Unit {
            unit_id: scope.unit_id,
        },
        ..save(&store, &scope, project.kind)
    };
    let variant = store.save_context_resource(&variant_request).unwrap();
    let stopped = store
        .withdraw_context_resource(&WithdrawContextResource {
            project_id: scope.project_id,
            action_id: ExecutionId::new(),
            context_id: variant.context_id,
            expected_revision_id: variant.revision_id,
            actor: "Synthetic editor".into(),
            reason: "Stop local material".into(),
        })
        .unwrap();
    let resolved = store.resolve_context_resources(&scope).unwrap();
    assert!(
        resolved
            .entries
            .iter()
            .all(|e| e.status != ContextResourceStatus::Selected)
    );
    assert_eq!(
        resolved
            .entries
            .iter()
            .find(|e| e.revision.context_id == variant.context_id)
            .unwrap()
            .status,
        ContextResourceStatus::Withdrawn
    );
    assert!(
        !store
            .current_context_resource(scope.project_id, project.context_id)
            .unwrap()
            .unwrap()
            .withdrawn
    );
    let restored = store
        .save_context_resource(&SaveContextResource {
            action_id: ExecutionId::new(),
            context_id: Some(variant.context_id),
            expected_revision_id: Some(stopped.revision_id),
            ..variant_request
        })
        .unwrap();
    assert!(!restored.withdrawn);
    assert_eq!(
        store
            .resolve_context_resources(&scope)
            .unwrap()
            .entries
            .iter()
            .find(|e| e.revision.context_id == variant.context_id)
            .unwrap()
            .status,
        ContextResourceStatus::Selected
    );
}

#[test]
fn sharing_is_explicit_captured_and_legacy_input_encoding_stays_identical() {
    let (_dir, mut store, rows) = support::source_fixture();
    let scope = source_scope(&store, &rows[0]);
    let off = config(false);
    let before = store
        .preview_ai(off.clone(), &scope.locale, &[scope.unit_id])
        .unwrap();
    let legacy = serde_json::to_value(&before.items[0]).unwrap();
    assert!(legacy.get("contextResources").is_none());
    let decoded: ai::AiItem = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(&decoded).unwrap(), legacy);
    assert_eq!(ai::preview_digest(&off, &[decoded]).unwrap(), before.digest);
    for kind in [
        ContextResourceKind::Character,
        ContextResourceKind::Style,
        ContextResourceKind::Background,
    ] {
        store
            .save_context_resource(&save(&store, &scope, kind))
            .unwrap();
    }
    let preview = store
        .preview_ai(off.clone(), &scope.locale, &[scope.unit_id])
        .unwrap();
    assert!(preview.items[0].context_resources.is_none());
    assert!(
        prompt(&off, &preview.items[0])
            .get("contextResources")
            .is_none()
    );
    let on = config(true);
    let prepared = store
        .preview_ai(on.clone(), &scope.locale, &[scope.unit_id])
        .unwrap();
    assert!(!prepared.items[0].omissions.iter().any(|value|value=="context-missing"));
    let body = prompt(&on, &prepared.items[0]);
    assert_eq!(body["contextResources"].as_array().unwrap().len(), 3);
    let text = serde_json::to_string(&body["contextResources"]).unwrap();
    for private in [
        "Synthetic editor",
        "Explicit human entry",
        "sourceBasis",
        "contextId",
        "logicalPaths",
    ] {
        assert!(!text.contains(private));
    }
    let fixed = prepared.items[0].clone();
    let current = store
        .current_context_resource(
            scope.project_id,
            fixed.context_resources.as_ref().unwrap().entries[0]
                .revision
                .context_id,
        )
        .unwrap()
        .unwrap();
    store
        .save_context_resource(&SaveContextResource {
            context_id: Some(current.context_id),
            expected_revision_id: Some(current.revision_id),
            text: "Later text".into(),
            ..save(&store, &scope, current.kind)
        })
        .unwrap();
    assert_eq!(prompt(&on, &fixed), body);
    let captured = store
        .capture_context(&CaptureContext {
            project_id: scope.project_id,
            action_id: ExecutionId::new(),
            unit_id: scope.unit_id,
            locale: scope.locale.clone(),
            source_revision_id: scope.source_revision_id,
            budget_bytes: 16 * 1024,
        })
        .unwrap();
    assert!(captured.context_resources.is_some());
    assert_eq!(
        store
            .read_context_capture(scope.project_id, captured.capture_id)
            .unwrap(),
        captured
    );
    let source_bytes = captured
        .included
        .iter()
        .find(|i| i.kind == "source")
        .unwrap()
        .text
        .len() as u32;
    let omitted = store
        .capture_context(&CaptureContext {
            project_id: scope.project_id,
            action_id: ExecutionId::new(),
            unit_id: scope.unit_id,
            locale: scope.locale.clone(),
            source_revision_id: scope.source_revision_id,
            budget_bytes: source_bytes,
        })
        .unwrap();
    assert_eq!(
        omitted
            .omitted
            .iter()
            .filter(|i| i.kind == "context-resource"
                && i.reason == "budget"
                && i.label.as_deref() == Some("Synthetic knowledge"))
            .count(),
        3
    );
    assert!(
        omitted
            .omitted
            .iter()
            .all(|i| ExecutionId::parse(&i.reference).is_ok())
    );
    assert_eq!(
        store
            .read_context_capture(scope.project_id, omitted.capture_id)
            .unwrap(),
        omitted
    );
}

#[test]
fn legacy_capture_bytes_do_not_gain_empty_label_or_resource_fields() {
    let capture = ExecutionId::new();
    let unit = ExecutionId::new();
    let source = ExecutionId::new();
    let original = format!(
        r#"{{"captureId":"{capture}","unitId":"{unit}","locale":"zh-CN","sourceRevisionId":"{source}","budgetBytes":16384,"included":[],"omitted":[{{"kind":"term","reference":"original phrase","reason":"conflict"}}]}}"#
    );
    let decoded: ContextCapture = serde_json::from_str(&original).unwrap();
    assert_eq!(decoded.omitted[0].label, None);
    assert!(decoded.context_resources.is_none());
    assert_eq!(serde_json::to_string(&decoded).unwrap(), original);
}

fn shared_occurrence(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    // Keep the fixture's two occurrences, interpreted as one logical unit
    // spanning both captured files rather than adding a third source row.
    let mut second = exchange.units.remove(1);
    let mut occurrence = second.occurrences.remove(0);
    occurrence.source.artifact_id = exchange.artifacts[1].id.clone();
    occurrence.source.range.start = 0;
    occurrence.source.range.end = 4;
    exchange.units[0].occurrences.push(occurrence);
    exchange
}
#[test]
fn file_groups_keep_paths_and_reject_missing_or_partially_covered_units() {
    let (_dir, mut store, rows) = support::source_fixture_with_transform(2, shared_occurrence);
    assert_eq!(rows[0].unit_id, rows[1].unit_id);
    assert_ne!(rows[0].occurrence.artifact_id, rows[1].occurrence.artifact_id);
    let scope = source_scope(&store, &rows[0]);
    let page = store
        .source_content(scope.source_snapshot_id, 0, 100)
        .unwrap();
    let path = page
        .coverage
        .iter()
        .find(|f| f.artifact_id == rows[0].occurrence.artifact_id)
        .unwrap()
        .logical_path
        .clone();
    let request = SaveContextResource {
        scope: ContextResourceScope::FileGroup {
            namespace: rows[0].occurrence.namespace.clone(),
            logical_paths: vec![path],
        },
        ..save(&store, &scope, ContextResourceKind::Background)
    };
    let saved = store.save_context_resource(&request).unwrap();
    assert_eq!(
        store
            .resolve_context_resources(&scope)
            .unwrap()
            .entries
            .iter()
            .find(|e| e.revision.context_id == saved.context_id)
            .unwrap()
            .status,
        ContextResourceStatus::Ambiguous
    );
    let on = config(true);
    let ai = store
        .preview_ai(on.clone(), &scope.locale, &[scope.unit_id])
        .unwrap();
    assert_eq!(
        prompt(&on, &ai.items[0])["contextResources"],
        serde_json::json!([])
    );
    assert!(matches!(
        &saved.scope,
        ContextResourceScope::FileGroup { .. }
    ));
    let missing = SaveContextResource {
        scope: ContextResourceScope::FileGroup {
            namespace: rows[0].occurrence.namespace.clone(),
            logical_paths: vec!["missing.txt".into()],
        },
        ..save(&store, &scope, ContextResourceKind::Style)
    };
    assert_eq!(
        store.save_context_resource(&missing).unwrap_err().stage,
        "context-resource-file-missing"
    );
    let mut paths = page
        .coverage
        .iter()
        .map(|f| f.logical_path.clone())
        .collect::<Vec<_>>();
    paths.sort();
    let all = store
        .save_context_resource(&SaveContextResource {
            scope: ContextResourceScope::FileGroup {
                namespace: rows[0].occurrence.namespace.clone(),
                logical_paths: paths,
            },
            ..save(&store, &scope, ContextResourceKind::Style)
        })
        .unwrap();
    assert_eq!(
        store
            .resolve_context_resources(&scope)
            .unwrap()
            .entries
            .iter()
            .find(|e| e.revision.context_id == all.context_id)
            .unwrap()
            .status,
        ContextResourceStatus::Selected
    );
}

#[test]
fn write_boundary_rejects_changed_source_cross_locale_identity_and_unbounded_fields() {
    let (_dir, mut store, rows) = support::source_fixture_with_transform(2, |e| e);
    let scope = source_scope(&store, &rows[0]);
    let original = save(&store, &scope, ContextResourceKind::Background);
    let mut stale = original.clone();
    stale.source_basis.revision = Revision::new(stale.source_basis.revision.get() + 1).unwrap();
    assert_eq!(
        store.save_context_resource(&stale).unwrap_err().stage,
        "context-resource-source"
    );
    let mut large = original.clone();
    large.text = "x".repeat(16 * 1024 + 1);
    assert!(store.save_context_resource(&large).is_err());
    let mut actor = original.clone();
    actor.actor = " ".into();
    assert!(store.save_context_resource(&actor).is_err());
    let first = store.save_context_resource(&original).unwrap();
    let mut moved = SaveContextResource {
        action_id: ExecutionId::new(),
        context_id: Some(first.context_id),
        expected_revision_id: Some(first.revision_id),
        ..original
    };
    moved.locale = "ja".into();
    assert_eq!(
        store.save_context_resource(&moved).unwrap_err().stage,
        "context-resource-identity"
    );
    moved.locale = "zh-CN".into();
    moved.kind = ContextResourceKind::Character;
    assert_eq!(
        store.save_context_resource(&moved).unwrap_err().stage,
        "context-resource-identity"
    );
    assert_eq!(
        store
            .current_context_resource(scope.project_id, first.context_id)
            .unwrap(),
        Some(first)
    );
}

#[test]
fn scoped_changes_reach_existing_impact_and_locale_qualification_owners() {
    let (_dir, mut store, rows) = support::source_fixture_with_transform(2, |e| e);
    let first = source_scope(&store, &rows[0]);
    let second = source_scope(&store, &rows[1]);
    for (scope, locale) in [(&first, "zh-CN"), (&second, "zh-CN"), (&first, "ja")] {
        store
            .save_translation_edit(&SaveTranslationRevision {
                project_id: scope.project_id,
                action_id: ExecutionId::new(),
                unit_id: scope.unit_id,
                locale: locale.into(),
                source_revision_id: scope.source_revision_id,
                expected_selection_id: None,
                text: "Synthetic selection".into(),
            })
            .unwrap();
    }
    let request = SaveContextResource {
        scope: ContextResourceScope::Unit {
            unit_id: first.unit_id,
        },
        ..save(&store, &first, ContextResourceKind::Style)
    };
    let saved = store.save_context_resource(&request).unwrap();
    let impacts = store
        .resource_impacts(first.project_id, "zh-CN", 0, 100)
        .unwrap();
    assert_eq!(impacts.items.len(), 1);
    assert_eq!(impacts.items[0].unit_id, first.unit_id);
    assert_eq!(
        impacts.items[0].reasons[0].kind,
        ResourceImpactKind::ContextResource
    );
    assert_eq!(
        impacts.items[0].reasons[0].confidence,
        ResourceImpactConfidence::ScopePossible
    );
    assert!(
        store
            .resource_impacts(first.project_id, "ja", 0, 100)
            .unwrap()
            .items
            .is_empty()
    );
    store
        .save_context_resource(&SaveContextResource {
            action_id: ExecutionId::new(),
            context_id: Some(saved.context_id),
            expected_revision_id: Some(saved.revision_id),
            scope: ContextResourceScope::Unit {
                unit_id: second.unit_id,
            },
            ..request
        })
        .unwrap();
    assert_eq!(
        store
            .resource_impacts(first.project_id, "zh-CN", 0, 100)
            .unwrap()
            .items
            .len(),
        2
    );
}

fn restore_legacy_tables(c: &rusqlite::Connection) {
    c.execute_batch("PRAGMA foreign_keys=OFF;
        CREATE TABLE context_revisions_old(revision_id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,unit_id TEXT NOT NULL REFERENCES source_units(unit_id),locale TEXT NOT NULL,text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=16384),reason TEXT NOT NULL,previous_revision_id TEXT REFERENCES context_revisions(revision_id),action_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL CHECK(length(request_digest)=64));
        INSERT INTO context_revisions_old SELECT revision_id,project_id,unit_id,locale,text,reason,previous_revision_id,action_id,request_digest FROM context_revisions;
        CREATE TABLE context_current_old(unit_id TEXT NOT NULL REFERENCES source_units(unit_id),locale TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES context_revisions(revision_id),PRIMARY KEY(unit_id,locale));
        INSERT INTO context_current_old SELECT unit_id,locale,revision_id FROM context_current;
        CREATE TABLE resource_changes_old(change_id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('term','context','context-fact')),locale TEXT NOT NULL,scope_unit_id TEXT REFERENCES source_units(unit_id),old_scope_unit_id TEXT REFERENCES source_units(unit_id),source_phrase TEXT,old_source_phrase TEXT,old_revision_id TEXT,new_revision_id TEXT NOT NULL,action_id TEXT NOT NULL UNIQUE);
        INSERT INTO resource_changes_old(rowid,change_id,project_id,kind,locale,scope_unit_id,old_scope_unit_id,source_phrase,old_source_phrase,old_revision_id,new_revision_id,action_id) SELECT rowid,change_id,project_id,kind,locale,scope_unit_id,old_scope_unit_id,source_phrase,old_source_phrase,old_revision_id,new_revision_id,action_id FROM resource_changes;
        DROP TABLE context_current;DROP TABLE context_revisions;DROP TABLE resource_changes;
        ALTER TABLE context_revisions_old RENAME TO context_revisions;
        ALTER TABLE context_current_old RENAME TO context_current;
        ALTER TABLE resource_changes_old RENAME TO resource_changes;
        PRAGMA user_version=65;").unwrap();
}

#[test]
fn schema_65_upgrade_preserves_notes_captures_actions_and_change_rowids() {
    let (_dir, mut store, rows) = support::source_fixture();
    let scope = source_scope(&store, &rows[0]);
    let request = SaveContext {
        project_id: scope.project_id,
        action_id: ExecutionId::new(),
        unit_id: scope.unit_id,
        locale: scope.locale.clone(),
        source_revision_id: scope.source_revision_id,
        expected_revision_id: None,
        text: "Existing unit note".into(),
        reason: "Original note reason".into(),
    };
    let note = store.save_context(&request).unwrap();
    let capture_request = CaptureContext {
        project_id: scope.project_id,
        action_id: ExecutionId::new(),
        unit_id: scope.unit_id,
        locale: scope.locale.clone(),
        source_revision_id: scope.source_revision_id,
        budget_bytes: 16384,
    };
    let capture = store.capture_context(&capture_request).unwrap();
    let path = store.directory().to_path_buf();
    drop(store);
    let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    c.execute("UPDATE resource_changes SET rowid=rowid+17", [])
        .unwrap();
    let before: (i64, String) = c
        .query_row(
            "SELECT rowid,change_id FROM resource_changes LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    restore_legacy_tables(&c);
    drop(c);
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .context_revision(scope.project_id, scope.unit_id, &scope.locale)
            .unwrap(),
        Some(note.clone())
    );
    assert_eq!(reopened.save_context(&request).unwrap(), note);
    assert_eq!(
        reopened
            .read_context_capture(scope.project_id, capture.capture_id)
            .unwrap(),
        capture
    );
    assert_eq!(reopened.capture_context(&capture_request).unwrap(), capture);
    assert!(
        reopened
            .list_context_resources(scope.project_id, &scope.locale, None, 0, 100, None)
            .unwrap()
            .rows
            .is_empty()
    );
    drop(reopened);
    let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        67
    );
    let after: (i64, String) = c
        .query_row(
            "SELECT rowid,change_id FROM resource_changes LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(before, after);
}

#[test]
fn invalid_supported_schema_is_rejected_before_migration_writes() {
    let (_dir, mut store, rows) = support::source_fixture();
    let scope = source_scope(&store, &rows[0]);
    store
        .save_context(&SaveContext {
            project_id: scope.project_id,
            action_id: ExecutionId::new(),
            unit_id: scope.unit_id,
            locale: scope.locale.clone(),
            source_revision_id: scope.source_revision_id,
            expected_revision_id: None,
            text: "Existing note".into(),
            reason: "Original reason".into(),
        })
        .unwrap();
    let path = store.directory().to_path_buf();
    drop(store);
    let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    restore_legacy_tables(&c);
    c.execute(
        "UPDATE context_current SET unit_id=?1",
        [rows[1].unit_id.unwrap().to_string()],
    )
    .unwrap();
    drop(c);
    assert!(ProjectStore::open(&path).is_err());
    let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        65
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('context_revisions') WHERE name='context_id'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
