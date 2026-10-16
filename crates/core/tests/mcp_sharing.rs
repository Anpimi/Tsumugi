#![cfg(not(feature = "execution-test-host"))]
//! Synthetic project facts only: no network, model or external Worker is used.
mod support;

use rusqlite::{Connection, OpenFlags};
use tsumugi_core::{
    application::*,
    content::{self, SourceAdoptionHandler},
    execution::*,
    *,
};
use tsumugi_plugin_sdk as sdk;

fn project(store: &ProjectStore) -> ExecutionId {
    ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap()
}
fn request(store: &ProjectStore, row: &content::ContentRow) -> McpShareRequest {
    McpShareRequest {
        project_id: project(store),
        unit_id: row.unit_id.unwrap(),
        locale: "zh-CN".into(),
        share_terms: false,
        share_context: false,
    }
}
fn save(
    store: &mut ProjectStore,
    row: &content::ContentRow,
    previous: Option<ExecutionId>,
    text: &str,
) -> TranslationSaveReceipt {
    store
        .save_translation_edit(&SaveTranslationRevision {
            project_id: project(store),
            action_id: ExecutionId::new(),
            unit_id: row.unit_id.unwrap(),
            locale: "zh-CN".into(),
            source_revision_id: row.source_revision_id.unwrap(),
            expected_selection_id: previous,
            text: text.into(),
        })
        .unwrap()
}
fn context(
    store: &mut ProjectStore,
    row: &content::ContentRow,
    locale: &str,
    previous: Option<ExecutionId>,
    text: &str,
) -> ContextRevision {
    store
        .save_context(&SaveContext {
            project_id: project(store),
            action_id: ExecutionId::new(),
            unit_id: row.unit_id.unwrap(),
            locale: locale.into(),
            source_revision_id: row.source_revision_id.unwrap(),
            expected_revision_id: previous,
            text: text.into(),
            reason: "Private context editing reason".into(),
        })
        .unwrap()
}
fn term(
    store: &mut ProjectStore,
    row: &content::ContentRow,
    locale: &str,
    source: &str,
    target: &str,
) -> TermRevision {
    store
        .save_term(&SaveTerm {
            project_id: project(store),
            action_id: ExecutionId::new(),
            term_id: None,
            locale: locale.into(),
            source: source.into(),
            aliases: vec![],
            target: target.into(),
            protected: false,
            scope_unit_id: row.unit_id,
            expected_revision_id: None,
            reason: "Private term editing reason".into(),
        })
        .unwrap()
}
fn counts(store: &ProjectStore) -> Vec<i64> {
    let c = Connection::open_with_flags(
        store.directory().join("project.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    [
        "execution_tasks",
        "execution_attempts",
        "execution_actions",
        "adoption_receipts",
        "execution_budgets",
        "execution_provider_requests",
        "plugin_execution_grants",
        "application_plans",
        "application_actions",
    ]
    .into_iter()
    .map(|table| {
        c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    })
    .collect()
}
fn with_private_facts(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    let source = exchange.units[0].occurrences[0].source.clone();
    exchange.domain_blocks = vec![sdk::DomainBlock {
        target: sdk::ContentTarget::Unit {
            id: exchange.units[0].id.clone(),
        },
        schema: sdk::source_context_facts_contract(),
        handling: sdk::ExtensionHandling::Preserve,
        payload_utf8: serde_json::to_string(&sdk::SourceContextFacts {
            facts: vec![sdk::SourceContextFact {
                id: "private-extracted-fact".into(),
                kind: sdk::SourceContextFactKind::Role,
                text: "Never disclose extracted character information".into(),
                origin: sdk::SourceContextFactOrigin::Extracted {
                    sources: vec![source],
                },
            }],
        })
        .unwrap(),
    }];
    exchange
}

#[test]
fn minimal_disclosure_is_exact_unicode_and_excludes_unselected_categories_without_writes() {
    let (_dir, mut store, rows) = support::source_fixture_with_transform(2, with_private_facts);
    let saved = save(&mut store, &rows[0], None, "人工 👩🏽‍💻 e\u{301}");
    context(
        &mut store,
        &rows[0],
        "zh-CN",
        None,
        "Private manual context",
    );
    term(
        &mut store,
        &rows[0],
        "zh-CN",
        "same",
        "Private adopted terminology",
    );
    let before = counts(&store);
    let clock = store.changes_since(Revision::new(0).unwrap());
    let captured = store.prepare_mcp_share(&request(&store, &rows[0])).unwrap();
    let preview = captured.preview();
    assert_eq!(preview.version, MCP_SHARE_PREVIEW_VERSION);
    assert_eq!(preview.payload.unit_id, rows[0].unit_id.unwrap());
    assert_eq!(preview.payload.source.text, "same");
    assert_eq!(
        preview.payload.translation.as_ref().unwrap().text,
        saved.revision.text
    );
    assert_eq!(preview.basis.selection_id, Some(saved.selection.event_id));
    assert_eq!(
        preview.basis.translation_revision_id,
        Some(saved.revision.revision_id)
    );
    assert!(preview.payload.terms.is_none());
    assert!(preview.payload.manual_context.is_none());
    let bytes = serde_json::to_vec(captured.payload()).unwrap();
    assert_eq!(preview.byte_length as usize, bytes.len());
    let wire = String::from_utf8(bytes).unwrap();
    for private in [
        "Production content",
        "Private manual",
        "Private adopted",
        "Private term",
        "Private context",
        "private-extracted-fact",
        "character information",
        "projectId",
        "logicalPath",
        "reason",
        "neighbors",
        "sourceSetId",
    ] {
        assert!(!wire.contains(private), "Unexpected disclosure: {private}");
    }
    let plain = serde_json::to_value(captured.payload()).unwrap();
    for field in ["translation", "terms", "manualContext"] {
        let mut missing = plain.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<McpSharedUnit>(missing).is_err(),
            "Required nullable {field}"
        );
    }
    let mut forged_preview = preview.clone();
    forged_preview.payload.source.text = "Changed outside Core".into();
    assert_ne!(captured.preview(), &forged_preview);
    let mut extra = plain;
    extra["projectPath"] = serde_json::json!("not allowed");
    assert!(serde_json::from_value::<McpSharedUnit>(extra).is_err());
    assert_eq!(
        captured.preview(),
        store
            .prepare_mcp_share(&request(&store, &rows[0]))
            .unwrap()
            .preview()
    );
    store.validate_mcp_share(&captured).unwrap();
    store.check_mcp_share_session(&captured).unwrap();
    assert_eq!(before, counts(&store));
    let after = store.changes_since(Revision::new(0).unwrap());
    assert_eq!(
        (clock.epoch, clock.sequence, clock.progress_sequence),
        (after.epoch, after.sequence, after.progress_sequence)
    );
}

#[test]
fn opted_resources_preserve_current_resolution_conflicts_and_only_the_exact_manual_context() {
    let (_dir, mut store, rows) = support::source_fixture_with_scope(2, &["zh-CN", "ja"]);
    let a = term(&mut store, &rows[0], "zh-CN", "same", "同");
    let b = term(&mut store, &rows[0], "zh-CN", "same", "相同");
    let manual = context(
        &mut store,
        &rows[0],
        "zh-CN",
        None,
        "Explicit manual 👩🏽‍💻 context",
    );
    term(
        &mut store,
        &rows[1],
        "zh-CN",
        "same",
        "Different unit secret",
    );
    term(
        &mut store,
        &rows[0],
        "ja",
        "same",
        "Different locale secret",
    );
    context(&mut store, &rows[1], "zh-CN", None, "Neighbor secret");
    context(&mut store, &rows[0], "ja", None, "Other locale context");
    let mut selected = request(&store, &rows[0]);
    selected.share_terms = true;
    selected.share_context = true;
    let captured = store.prepare_mcp_share(&selected).unwrap();
    let terms = captured.payload().terms.as_ref().unwrap();
    assert_eq!(terms.len(), 1);
    assert!(terms[0].selected.is_none());
    let mut revisions: Vec<_> = terms[0].conflicting.iter().map(|t| t.revision_id).collect();
    revisions.sort();
    let mut expected = vec![a.revision_id, b.revision_id];
    expected.sort();
    assert_eq!(revisions, expected);
    assert_eq!(
        captured
            .payload()
            .manual_context
            .as_ref()
            .unwrap()
            .revision_id,
        manual.revision_id
    );
    assert_eq!(
        captured.payload().manual_context.as_ref().unwrap().text,
        manual.text
    );
    let wire = serde_json::to_string(captured.payload()).unwrap();
    assert!(!wire.contains("secret"));
    assert!(!wire.contains("reason"));
    let mut terms_only = selected.clone();
    terms_only.share_context = false;
    assert!(
        store
            .prepare_mcp_share(&terms_only)
            .unwrap()
            .payload()
            .manual_context
            .is_none()
    );
    let mut context_only = selected;
    context_only.share_terms = false;
    assert!(
        store
            .prepare_mcp_share(&context_only)
            .unwrap()
            .payload()
            .terms
            .is_none()
    );
}

#[test]
fn authorization_revalidates_related_opted_facts_while_fixed_payload_never_changes() {
    let (_dir, mut store, rows) = support::source_fixture_with_scope(2, &["zh-CN", "ja"]);
    let original = save(&mut store, &rows[0], None, "Original selected text");
    let off = store.prepare_mcp_share(&request(&store, &rows[0])).unwrap();
    let manual = context(&mut store, &rows[0], "zh-CN", None, "First context");
    term(&mut store, &rows[0], "zh-CN", "same", "同");
    store.validate_mcp_share(&off).unwrap();
    let mut options = request(&store, &rows[0]);
    options.share_context = true;
    options.share_terms = true;
    let captured = store.prepare_mcp_share(&options).unwrap();
    let fixed = captured.preview().clone();
    context(&mut store, &rows[1], "zh-CN", None, "Unrelated");
    term(&mut store, &rows[0], "ja", "same", "Unrelated locale");
    save(&mut store, &rows[1], None, "Unrelated translation");
    store.validate_mcp_share(&captured).unwrap();
    context(
        &mut store,
        &rows[0],
        "zh-CN",
        Some(manual.revision_id),
        "Newer context B",
    );
    assert_eq!(
        store.validate_mcp_share(&captured).unwrap_err().stage,
        "mcp-share-current"
    );
    store.check_mcp_share_session(&captured).unwrap();
    assert_eq!(captured.preview(), &fixed);
    let translated = store.prepare_mcp_share(&request(&store, &rows[0])).unwrap();
    save(
        &mut store,
        &rows[0],
        Some(original.selection.event_id),
        "Newer selected B",
    );
    assert_eq!(
        store.validate_mcp_share(&translated).unwrap_err().stage,
        "mcp-share-current"
    );
    store.check_mcp_share_session(&translated).unwrap();
    assert_eq!(
        translated.payload().translation.as_ref().unwrap().text,
        "Original selected text"
    );
}

#[test]
fn unadopted_glossary_proposals_are_not_disclosed_and_empty_choices_remain_explicit() {
    let (_dir, mut store, rows) = support::source_fixture();
    let p = project(&store);
    let bytes = serde_json::to_vec(&GlossaryFile {
        format: "tsumugi-glossary-v1".into(),
        resource_id: "share-fixture".into(),
        revision: "1".into(),
        license: "Synthetic fixture".into(),
        source_locale: "en".into(),
        target_locale: "zh-CN".into(),
        entries: vec![GlossaryEntry {
            id: "one".into(),
            source: "same".into(),
            aliases: vec![],
            target: "候选术语".into(),
            protected: false,
            native_key: None,
            reason: "Not adopted yet".into(),
        }],
    })
    .unwrap();
    let proposal = store
        .capture_glossary(p, ExecutionId::new(), &bytes)
        .unwrap();
    let mut options = request(&store, &rows[0]);
    options.share_terms = true;
    options.share_context = true;
    let before = store.prepare_mcp_share(&options).unwrap();
    assert_eq!(before.payload().terms, Some(vec![]));
    assert!(before.payload().translation.is_none());
    assert!(before.payload().manual_context.is_none());
    store
        .decide_glossary_entry(&ResourceDecision {
            project_id: p,
            action_id: ExecutionId::new(),
            capture_id: proposal.capture_id,
            entry_id: "one".into(),
            expected_revision_id: None,
            decision: ResourceDecisionKind::Ignore,
        })
        .unwrap();
    store.validate_mcp_share(&before).unwrap();
    let adopted = store
        .decide_glossary_entry(&ResourceDecision {
            project_id: p,
            action_id: ExecutionId::new(),
            capture_id: proposal.capture_id,
            entry_id: "one".into(),
            expected_revision_id: None,
            decision: ResourceDecisionKind::Adopt,
        })
        .unwrap();
    assert_eq!(
        store.validate_mcp_share(&before).unwrap_err().stage,
        "mcp-share-current"
    );
    let current = store.prepare_mcp_share(&options).unwrap();
    assert_eq!(
        current.payload().terms.as_ref().unwrap()[0]
            .selected
            .as_ref()
            .unwrap()
            .revision_id,
        adopted.revision.unwrap().revision_id
    );
}

#[test]
fn exact_project_unit_locale_and_store_epoch_are_required_without_restoring_old_authority() {
    let (dir, store, rows) = support::source_fixture();
    let original = request(&store, &rows[0]);
    let capture = store.prepare_mcp_share(&original).unwrap();
    let fixed = capture.preview().clone();
    for altered in [
        McpShareRequest {
            project_id: ExecutionId::new(),
            ..original.clone()
        },
        McpShareRequest {
            unit_id: ExecutionId::new(),
            ..original.clone()
        },
        McpShareRequest {
            locale: "ja".into(),
            ..original.clone()
        },
        McpShareRequest {
            locale: "zh-cn".into(),
            ..original
        },
    ] {
        assert!(store.prepare_mcp_share(&altered).is_err());
    }
    store.close().unwrap();
    let reopened = ProjectStore::open(dir.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .check_mcp_share_session(&capture)
            .unwrap_err()
            .stage,
        "mcp-share-session"
    );
    assert!(reopened.validate_mcp_share(&capture).is_err());
    assert_eq!(capture.preview(), &fixed);
    let renewed = reopened
        .prepare_mcp_share(&request(&reopened, &rows[0]))
        .unwrap();
    assert_eq!(renewed.preview(), capture.preview());
    reopened.validate_mcp_share(&renewed).unwrap();
}

#[test]
fn encoded_payload_limit_uses_utf8_bytes_and_never_truncates_opted_resources() {
    let (_dir, mut store, rows) = support::source_fixture();
    for index in 0..5 {
        term(
            &mut store,
            &rows[0],
            "zh-CN",
            &format!("term-{index}"),
            &"x".repeat(10_000),
        );
    }
    let mut tail = term(&mut store, &rows[0], "zh-CN", "last", "x");
    let mut options = request(&store, &rows[0]);
    options.share_terms = true;
    let initial = store.prepare_mcp_share(&options).unwrap();
    let fill = MAX_MCP_SHARE_BYTES - initial.preview().byte_length as usize;
    let update = |value: &TermRevision, target: String| SaveTerm {
        project_id: options.project_id,
        action_id: ExecutionId::new(),
        term_id: Some(value.term_id.clone()),
        locale: value.locale.clone(),
        source: value.source.clone(),
        aliases: vec![],
        target,
        protected: false,
        scope_unit_id: rows[0].unit_id,
        expected_revision_id: Some(value.revision_id),
        reason: "Boundary fixture".into(),
    };
    tail = store
        .save_term(&update(&tail, "x".repeat(fill + 1)))
        .unwrap();
    let exact = store.prepare_mcp_share(&options).unwrap();
    assert_eq!(exact.preview().byte_length as usize, MAX_MCP_SHARE_BYTES);
    store
        .save_term(&update(&tail, format!("{}🧭", tail.target)))
        .unwrap();
    assert_eq!(
        store.prepare_mcp_share(&options).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    assert_eq!(
        exact.preview().byte_length as usize,
        serde_json::to_vec(exact.payload()).unwrap().len()
    );
    assert_eq!(
        store
            .prepare_mcp_share(&request(&store, &rows[0]))
            .unwrap()
            .payload()
            .terms,
        None
    );
}

fn replace_source(store: &mut ProjectStore) -> Vec<content::ContentRow> {
    let input = support::source_input_with_texts(store, &["new source", "other source"]);
    let mut runtime = support::source_runtime(store);
    let (_, result) = support::execute(&mut runtime, store, &input);
    let validation = store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let (_, checked) = support::execute(&mut runtime, store, &validation.check_input().clone());
    store
        .commit_source_validation(validation.prepare(checked).unwrap())
        .unwrap();
    let comparison = store
        .source_comparison(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            2,
        )
        .unwrap();
    let mut confirmation = comparison.confirmation;
    confirmation.actor = Some("Synthetic reviewer".into());
    for change in comparison.rows {
        let new = change.new.unwrap();
        let old = change.old.unwrap();
        assert_eq!(change.candidates.len(), 1);
        assert_eq!(change.candidates[0].occurrence_id, old.occurrence_id);
        confirmation.lineage.push(content::LineageChoice {
            new_ordinal: new.ordinal,
            old_occurrence_id: old.occurrence_id.unwrap(),
            decision: content::LineageDecision::Continue,
            reason: "Reviewed exact source continuation".into(),
        });
    }
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::to_value(confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    store
        .source_content(
            store.content_scope().unwrap().current_snapshot.unwrap(),
            0,
            2,
        )
        .unwrap()
        .rows
}

#[test]
fn source_replacement_does_not_pair_new_source_with_an_old_selected_translation() {
    let (_dir, mut store, rows) = support::source_fixture();
    let saved = save(&mut store, &rows[0], None, "Earlier source translation");
    let original = store.prepare_mcp_share(&request(&store, &rows[0])).unwrap();
    let fixed = original.preview().clone();
    let newer = replace_source(&mut store);
    let row = newer
        .iter()
        .find(|row| row.unit_id == rows[0].unit_id)
        .unwrap();
    assert_eq!(
        store
            .prepare_mcp_share(&request(&store, row))
            .unwrap_err()
            .stage,
        "mcp-share-selection-source"
    );
    assert!(store.validate_mcp_share(&original).is_err());
    store.check_mcp_share_session(&original).unwrap();
    assert_eq!(original.preview(), &fixed);
    save(
        &mut store,
        row,
        Some(saved.selection.event_id),
        "Translation reviewed for new source",
    );
    let current = store.prepare_mcp_share(&request(&store, row)).unwrap();
    assert_eq!(
        current.payload().source.revision_id,
        row.source_revision_id.unwrap()
    );
    assert_ne!(
        current.payload().source.snapshot_id,
        fixed.payload.source.snapshot_id
    );
}
