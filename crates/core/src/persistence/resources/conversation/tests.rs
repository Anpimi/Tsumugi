use super::*;
use crate::application::*;
use crate::persistence::application::conversations::proposals::tests::completed_profile;
use crate::persistence::{DATABASE_FILENAME, SCHEMA_VERSION};
use std::collections::BTreeMap;

fn fixture() -> (tempfile::TempDir, ProjectStore, Vec<ExecutionId>) {
    let (temp, store, _) = super::super::tests::fixture_project();
    // The import fixture also contains intentionally blank source entries. A
    // terminology fixture selects real nonblank source fragments explicitly.
    let units = store.connection().unwrap().prepare("SELECT o.unit_id FROM source_effective_occurrences o JOIN content_scope s ON s.current_snapshot=o.snapshot_id JOIN source_revisions r ON r.revision_id=o.revision_id WHERE length(trim(r.text))>0 GROUP BY o.unit_id ORDER BY MIN(o.ordinal) LIMIT 10").unwrap()
        .query_map([], |r| r.get::<_,String>(0)).unwrap().map(|r| id(r.unwrap()).unwrap()).collect();
    (temp, store, units)
}
fn model(
    store: &ProjectStore,
    units: &[ExecutionId],
    questions: Vec<String>,
) -> ConversationPlanningModelOutput {
    let c = store.connection().unwrap();
    ConversationPlanningModelOutput::TermProposal {
        summary: "Synthetic terminology suggestions".into(), questions,
        entries: units.iter().take(2).map(|unit| {
            let source: String = c.query_row("SELECT r.text FROM source_effective_occurrences o JOIN content_scope s ON s.current_snapshot=o.snapshot_id JOIN source_revisions r ON r.revision_id=o.revision_id WHERE o.unit_id=?1 ORDER BY o.ordinal LIMIT 1", [unit.to_string()], |r|r.get(0)).unwrap();
            ConversationTermEntry { unit_id: *unit, source: source.chars().take(128).collect(), aliases: vec!["Synthetic alias".into()],
                target: "Original model target".into(), protected: true, reason: "Synthetic reason".into() }
        }).collect(),
    }
}
fn proposal(
    store: &mut ProjectStore,
    units: &[ExecutionId],
    questions: Vec<String>,
) -> (CaptureConversationProposal, ConversationProposalRevision) {
    let output = model(store, units, questions);
    let request = completed_profile(
        store,
        units,
        output,
        true,
        Some(ConversationPlanningPurpose::Terminology),
    );
    let revision = store.capture_conversation_proposal(&request).unwrap();
    (request, revision)
}
fn adopt(revision: &ConversationProposalRevision, index: usize) -> ResourceDecision {
    ResourceDecision {
        project_id: revision.project_id,
        action_id: ExecutionId::new(),
        capture_id: revision.revision_id,
        entry_id: index.to_string(),
        expected_revision_id: None,
        decision: ResourceDecisionKind::Adopt,
        edited_target: Some(format!("Human edited target {index} e\u{301} 👩🏽‍💻")),
    }
}
fn count(c: &Connection, name: &str) -> i64 {
    c.query_row(&format!("SELECT COUNT(*) FROM {name}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn term_batch_uses_original_captures_edits_target_only_and_reopens_exact_receipts() {
    let (_temp, mut store, units) = fixture();
    let (capture_request, revision) = proposal(&mut store, &units[..2], vec![]);
    assert_eq!(
        store
            .capture_conversation_proposal(&capture_request)
            .unwrap(),
        revision
    );
    assert_eq!(count(store.connection().unwrap(), "term_current"), 0);
    assert_eq!(count(store.connection().unwrap(), "resource_captures"), 1);
    let preview = store
        .glossary_preview(revision.project_id, revision.revision_id)
        .unwrap();
    assert!(preview.conversation.as_ref().unwrap().current);
    assert_eq!(preview.rows.len(), 2);
    assert!(
        matches!(&preview.capture.origin, GlossaryCaptureOrigin::Conversation { proposal, model_origin }
        if proposal.revision_id == revision.revision_id && *model_origin == revision.origin)
    );
    let mut saved = Vec::new();
    for index in 0..2 {
        let request = adopt(&revision, index);
        let receipt = store.decide_glossary_entry(&request).unwrap();
        let term = receipt.revision.as_ref().unwrap();
        let original = &preview.rows[index].entry;
        assert_eq!(term.target, request.edited_target.as_deref().unwrap());
        assert_eq!(term.source, original.source);
        assert_eq!(term.aliases, original.aliases);
        assert_eq!(term.protected, original.protected);
        assert_eq!(term.reason, original.reason);
        assert_eq!(term.scope_unit_id, Some(units[index]));
        assert_eq!(term.origin_kind, TermOrigin::External);
        assert_eq!(term.capture_id, Some(revision.revision_id));
        assert_eq!(store.decide_glossary_entry(&request).unwrap(), receipt);
        assert!(
            store
                .glossary_preview(revision.project_id, revision.revision_id)
                .unwrap()
                .conversation
                .unwrap()
                .current
        );
        saved.push((request, receipt));
    }
    let mut conflict = saved[0].0.clone();
    conflict.action_id = ExecutionId::new();
    assert_eq!(
        store.decide_glossary_entry(&conflict).unwrap_err().stage,
        "resource-current"
    );
    assert!(
        store
            .resource_decision_request_observation(&conflict)
            .unwrap()
            .is_none()
    );
    let path = store.directory().to_path_buf();
    drop(store);
    let mut reopened = ProjectStore::open(path).unwrap();
    for (request, receipt) in saved {
        assert_eq!(
            reopened
                .resource_decision_request_observation(&request)
                .unwrap()
                .unwrap()
                .receipt,
            receipt
        );
        assert_eq!(reopened.decide_glossary_entry(&request).unwrap(), receipt);
    }
    assert_eq!(
        reopened
            .conversation_proposal_capture_receipt(&capture_request)
            .unwrap(),
        Some(revision)
    );
}

#[test]
fn term_head_questions_source_and_foreign_bindings_block_adoption_but_keep_history() {
    let (_temp, mut store, units) = fixture();
    let (_, first) = proposal(&mut store, &units[..1], vec!["Which target?".into()]);
    assert!(
        !store
            .glossary_preview(first.project_id, first.revision_id)
            .unwrap()
            .conversation
            .unwrap()
            .current
    );
    assert_eq!(
        store
            .decide_glossary_entry(&adopt(&first, 0))
            .unwrap_err()
            .stage,
        "conversation-term-stale"
    );
    let feed = store
        .decision_page(
            first.project_id,
            &crate::DecisionQuery {
                locale: Some("zh-CN".into()),
                sources: vec![
                    crate::DecisionSource::AgentQuestion,
                    crate::DecisionSource::ResourceProposal,
                ],
            },
            None,
            100,
            |_| false,
        )
        .unwrap();
    assert!(
        feed.items
            .iter()
            .any(|item| item.source == crate::DecisionSource::AgentQuestion)
    );
    assert!(
        feed.items
            .iter()
            .filter(|item| item.source == crate::DecisionSource::ResourceProposal)
            .all(|item| item.state == crate::DecisionState::Stale)
    );
    let mut content = first.content.clone();
    if let ConversationPlanningModelOutput::TermProposal { questions, .. } = &mut content {
        questions.clear();
    }
    let revise = ReviseConversationProposal {
        project_id: first.project_id,
        action_id: ExecutionId::new(),
        conversation_id: first.conversation_id,
        proposal_id: first.proposal_id,
        revision_id: ExecutionId::new(),
        expected_revision_id: first.revision_id,
        content,
    };
    let latest = store.revise_conversation_proposal(&revise).unwrap();
    assert_eq!(store.revise_conversation_proposal(&revise).unwrap(), latest);
    assert_eq!(count(store.connection().unwrap(), "resource_captures"), 2);
    assert!(
        !store
            .glossary_preview(first.project_id, first.revision_id)
            .unwrap()
            .conversation
            .unwrap()
            .current
    );
    assert!(
        store
            .glossary_preview(first.project_id, latest.revision_id)
            .unwrap()
            .conversation
            .unwrap()
            .current
    );
    let foreign = ResourceDecision {
        project_id: ExecutionId::new(),
        ..adopt(&latest, 0)
    };
    assert!(store.decide_glossary_entry(&foreign).is_err());
    crate::persistence::review::tests::adopt_source(&mut store, br#"{"replacement":"New source"}"#);
    assert!(
        !store
            .glossary_preview(first.project_id, latest.revision_id)
            .unwrap()
            .conversation
            .unwrap()
            .current
    );
    assert_eq!(
        store
            .decide_glossary_entry(&adopt(&latest, 0))
            .unwrap_err()
            .stage,
        "conversation-term-stale"
    );
    let feed = store
        .decision_page(
            first.project_id,
            &crate::DecisionQuery {
                locale: Some("zh-CN".into()),
                sources: vec![
                    crate::DecisionSource::AgentQuestion,
                    crate::DecisionSource::ResourceProposal,
                ],
            },
            None,
            100,
            |_| false,
        )
        .unwrap();
    assert!(
        !feed
            .items
            .iter()
            .any(|item| item.source == crate::DecisionSource::AgentQuestion)
    );
    assert!(
        feed.items
            .iter()
            .filter(|item| item.source == crate::DecisionSource::ResourceProposal)
            .all(|item| item.state == crate::DecisionState::Stale)
    );
    let mut keep = adopt(&latest, 0);
    keep.decision = ResourceDecisionKind::Keep;
    keep.edited_target = None;
    assert!(
        store
            .decide_glossary_entry(&keep)
            .unwrap()
            .revision
            .is_none()
    );
    let mut ignore = adopt(&first, 0);
    ignore.decision = ResourceDecisionKind::Ignore;
    ignore.edited_target = None;
    assert!(
        store
            .decide_glossary_entry(&ignore)
            .unwrap()
            .revision
            .is_none()
    );
    assert_eq!(count(store.connection().unwrap(), "term_current"), 0);
    let path = store.directory().to_path_buf();
    drop(store);
    let reopened = ProjectStore::open(path).unwrap();
    assert!(
        reopened
            .conversation_proposal_revision_receipt(&revise)
            .unwrap()
            .is_some()
    );
    assert!(
        reopened
            .resource_decision_request_observation(&keep)
            .unwrap()
            .is_some()
    );
}

#[test]
fn term_capture_requires_original_result_and_rolls_back_with_original_action() {
    let (_temp, mut store, units) = fixture();
    let output = model(&store, &units[..1], vec![]);
    let request = completed_profile(
        &mut store,
        &units[..1],
        output.clone(),
        true,
        Some(ConversationPlanningPurpose::Terminology),
    );
    let other = completed_profile(
        &mut store,
        &units[..1],
        output,
        true,
        Some(ConversationPlanningPurpose::Terminology),
    );
    let wrong = CaptureConversationProposal {
        result_id: other.result_id,
        ..request.clone()
    };
    assert!(store.capture_conversation_proposal(&wrong).is_err());
    let wrong = CaptureConversationProposal {
        project_id: ExecutionId::new(),
        ..request.clone()
    };
    assert!(store.capture_conversation_proposal(&wrong).is_err());
    let before = count(
        store.connection().unwrap(),
        "application_conversation_actions",
    );
    store.connection().unwrap().execute_batch("CREATE TEMP TRIGGER reject_term_capture BEFORE INSERT ON resource_captures WHEN NEW.capture_kind='conversation' BEGIN SELECT RAISE(ABORT,'synthetic capture failure'); END;").unwrap();
    assert!(store.capture_conversation_proposal(&request).is_err());
    assert_eq!(
        count(
            store.connection().unwrap(),
            "application_conversation_proposals"
        ),
        0
    );
    assert_eq!(count(store.connection().unwrap(), "resource_captures"), 0);
    assert_eq!(
        count(
            store.connection().unwrap(),
            "application_conversation_actions"
        ),
        before
    );
    store
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_term_capture")
        .unwrap();
    let revision = store.capture_conversation_proposal(&request).unwrap();
    assert!(
        store
            .glossary_preview(revision.project_id, revision.revision_id)
            .is_ok()
    );
}

#[test]
fn term_manual_override_and_decision_failure_keep_the_original_cas_and_transaction() {
    let (_temp, mut store, units) = fixture();
    let (_, revision) = proposal(&mut store, &units[..1], vec![]);
    let request = adopt(&revision, 0);
    store.connection().unwrap().execute_batch("CREATE TEMP TRIGGER reject_term_decision BEFORE INSERT ON resource_decisions BEGIN SELECT RAISE(ABORT,'synthetic decision failure'); END;").unwrap();
    assert!(store.decide_glossary_entry(&request).is_err());
    assert_eq!(count(store.connection().unwrap(), "term_revisions"), 0);
    assert_eq!(count(store.connection().unwrap(), "term_current"), 0);
    assert_eq!(count(store.connection().unwrap(), "resource_changes"), 0);
    store
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_term_decision")
        .unwrap();
    let original = store
        .decide_glossary_entry(&request)
        .unwrap()
        .revision
        .unwrap();
    let manual = store
        .save_term(&SaveTerm {
            project_id: revision.project_id,
            action_id: ExecutionId::new(),
            term_id: Some(original.term_id.clone()),
            locale: original.locale.clone(),
            source: original.source.clone(),
            aliases: original.aliases.clone(),
            target: "Current manual term".into(),
            protected: original.protected,
            scope_unit_id: original.scope_unit_id,
            expected_revision_id: Some(original.revision_id),
            reason: "Manual follow-up".into(),
        })
        .unwrap();
    let mut override_request = adopt(&revision, 0);
    override_request.expected_revision_id = Some(manual.revision_id);
    assert_eq!(
        store
            .decide_glossary_entry(&override_request)
            .unwrap_err()
            .stage,
        "resource-override"
    );
    override_request.decision = ResourceDecisionKind::Override;
    let receipt = store.decide_glossary_entry(&override_request).unwrap();
    assert_eq!(
        receipt.revision.as_ref().unwrap().previous_revision_id,
        Some(manual.revision_id)
    );
    assert_eq!(receipt.revision.as_ref().unwrap().source, original.source);
    let path = store.directory().to_path_buf();
    drop(store);
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .resource_decision_request_observation(&override_request)
            .unwrap()
            .unwrap()
            .receipt,
        receipt
    );
}

#[test]
fn term_historical_result_can_be_saved_but_never_adopted_after_source_drift() {
    let (_temp, mut store, units) = fixture();
    let output = model(&store, &units[..1], vec![]);
    let request = completed_profile(
        &mut store,
        &units[..1],
        output,
        true,
        Some(ConversationPlanningPurpose::Terminology),
    );
    crate::persistence::review::tests::adopt_source(
        &mut store,
        br#"{"replacement":"Later source"}"#,
    );
    let revision = store.capture_conversation_proposal(&request).unwrap();
    assert!(
        !store
            .glossary_preview(revision.project_id, revision.revision_id)
            .unwrap()
            .conversation
            .unwrap()
            .current
    );
    assert_eq!(
        store
            .decide_glossary_entry(&adopt(&revision, 0))
            .unwrap_err()
            .stage,
        "conversation-term-stale"
    );
    assert_eq!(count(store.connection().unwrap(), "term_current"), 0);
    let path = store.directory().to_path_buf();
    drop(store);
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .conversation_proposal_capture_receipt(&request)
            .unwrap(),
        Some(revision)
    );
}

#[test]
fn term_revision_preserves_original_entries_and_only_resolves_summary_and_questions() {
    let (_temp, mut store, units) = fixture();
    let (_, first) = proposal(
        &mut store,
        &units[..2],
        vec!["Which terminology is intended?".into()],
    );
    let before = rows(store.connection().unwrap());
    for field in [
        "target",
        "source",
        "aliases",
        "unit",
        "protected",
        "reason",
        "order",
    ] {
        let mut content = first.content.clone();
        let ConversationPlanningModelOutput::TermProposal { entries, .. } = &mut content else {
            unreachable!()
        };
        match field {
            "target" => entries[0].target = "A different proposed target".into(),
            "source" => entries[0].source = entries[0].source.chars().take(1).collect(),
            "aliases" => entries[0].aliases.push("Another alias".into()),
            "unit" => entries[0].unit_id = units[1],
            "protected" => entries[0].protected = !entries[0].protected,
            "reason" => entries[0].reason = "A different proposed reason".into(),
            "order" => entries.swap(0, 1),
            _ => unreachable!(),
        }
        assert_ne!(content, first.content, "fixture must change {field}");
        let request = ReviseConversationProposal {
            project_id: first.project_id,
            action_id: ExecutionId::new(),
            conversation_id: first.conversation_id,
            proposal_id: first.proposal_id,
            revision_id: ExecutionId::new(),
            expected_revision_id: first.revision_id,
            content,
        };
        let error = store.revise_conversation_proposal(&request).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{field}");
        assert_eq!(error.stage, "conversation-term-entries", "{field}");
        assert_eq!(
            rows(store.connection().unwrap()),
            before,
            "rejected {field} must not save any proposal, capture or term state"
        );
    }
    let mut content = first.content.clone();
    let ConversationPlanningModelOutput::TermProposal {
        summary, questions, ..
    } = &mut content
    else {
        unreachable!()
    };
    *summary = "Human clarified summary".into();
    questions.clear();
    let request = ReviseConversationProposal {
        project_id: first.project_id,
        action_id: ExecutionId::new(),
        conversation_id: first.conversation_id,
        proposal_id: first.proposal_id,
        revision_id: ExecutionId::new(),
        expected_revision_id: first.revision_id,
        content,
    };
    let latest = store.revise_conversation_proposal(&request).unwrap();
    assert_eq!(
        store.revise_conversation_proposal(&request).unwrap(),
        latest
    );
    let ConversationPlanningModelOutput::TermProposal {
        entries: original, ..
    } = &first.content
    else {
        unreachable!()
    };
    let ConversationPlanningModelOutput::TermProposal {
        entries: revised, ..
    } = &latest.content
    else {
        unreachable!()
    };
    assert_eq!(revised, original);
    assert_eq!(count(store.connection().unwrap(), "resource_captures"), 2);
    assert_eq!(count(store.connection().unwrap(), "term_current"), 0);
    assert!(
        store
            .glossary_preview(latest.project_id, latest.revision_id)
            .unwrap()
            .conversation
            .unwrap()
            .current
    );

    // Historical reads enforce the same immutable entries even if a record's
    // own digest is recomputed. The original model ledger remains the source.
    let mut tampered = latest.clone();
    let ConversationPlanningModelOutput::TermProposal { entries, .. } = &mut tampered.content
    else {
        unreachable!()
    };
    entries[0].target = "Fabricated historical target".into();
    let bytes = codec::encode(&tampered, MAX_RESOURCE_BYTES).unwrap();
    store.connection().unwrap().execute("UPDATE application_conversation_proposals SET record=?1,digest=?2 WHERE revision_id=?3",
        params![bytes,codec::digest(&bytes),latest.revision_id.to_string()]).unwrap();
    assert_eq!(
        store
            .read_conversation_proposal(
                latest.project_id,
                latest.conversation_id,
                latest.proposal_id,
                Some(latest.revision_id)
            )
            .unwrap_err()
            .code,
        ErrorCode::CorruptLedger
    );
    let bytes = codec::encode(&latest, MAX_RESOURCE_BYTES).unwrap();
    store.connection().unwrap().execute("UPDATE application_conversation_proposals SET record=?1,digest=?2 WHERE revision_id=?3",
        params![bytes,codec::digest(&bytes),latest.revision_id.to_string()]).unwrap();
    let path = store.directory().to_path_buf();
    drop(store);
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .read_conversation_proposal(
                latest.project_id,
                latest.conversation_id,
                latest.proposal_id,
                Some(latest.revision_id)
            )
            .unwrap(),
        latest
    );
}

fn legacy_72(c: &Connection) {
    super::super::make_legacy_capture_schema(c).unwrap();
    c.pragma_update(None, "user_version", 72).unwrap();
}

fn rows(c: &Connection) -> BTreeMap<String, Vec<Vec<rusqlite::types::Value>>> {
    let tables = c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap()
        .query_map([], |r| r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    tables
        .into_iter()
        .map(|name| {
            let mut q = c
                .prepare(&format!("SELECT rowid,* FROM \"{name}\" ORDER BY rowid"))
                .unwrap();
            let count = q.column_count();
            let values = q
                .query_map([], |row| {
                    (0..count)
                        .map(|i| row.get(i))
                        .collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (name, values)
        })
        .collect()
}
fn conversation_capture_ddl(c: &Connection) -> bool {
    c.query_row("SELECT instr(sql, '''conversation''')>0 FROM sqlite_master WHERE type='table' AND name='resource_captures'", [], |r|r.get(0)).unwrap()
}
#[test]
fn term_capture_migration_child() {
    let Ok(path) = std::env::var("TSUMUGI_TERM_CAPTURE_MIGRATION_PROJECT") else {
        return;
    };
    let _ = ProjectStore::open(path).unwrap();
    panic!("migration did not reach its crash hook");
}
#[test]
fn schema_72_capture_upgrade_preserves_rowids_foreign_keys_edited_receipts_and_atomicity() {
    for point in [
        "conversation-before-ddl",
        "conversation-after-ddl",
        "conversation-before-commit",
        "conversation-after-commit",
    ] {
        let (temp, mut store, project) = super::super::tests::fixture_project();
        let capture = store
            .capture_glossary(
                project,
                ExecutionId::new(),
                include_bytes!("../../../../tests/fixtures/resource-updates/g1.json"),
            )
            .unwrap();
        let request = ResourceDecision {
            project_id: project,
            action_id: ExecutionId::new(),
            capture_id: capture.capture_id,
            entry_id: "barrel".into(),
            expected_revision_id: None,
            decision: ResourceDecisionKind::Adopt,
            edited_target: Some("Original edited receipt".into()),
        };
        let receipt = store.decide_glossary_entry(&request).unwrap();
        let path = store.directory().to_path_buf();
        store.close().unwrap();
        let raw = Connection::open(path.join(DATABASE_FILENAME)).unwrap();
        raw.execute_batch(
            "UPDATE resource_captures SET rowid=41; UPDATE resource_changes SET rowid=71",
        )
        .unwrap();
        legacy_72(&raw);
        let before = rows(&raw);
        assert!(!conversation_capture_ddl(&raw));
        drop(raw);
        let marker = temp.path().join("term-capture-migration-hook");
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "persistence::resources::conversation::tests::term_capture_migration_child",
                "--nocapture",
            ])
            .env("TSUMUGI_TERM_CAPTURE_MIGRATION_PROJECT", &path)
            .env("TSUMUGI_MIGRATION_CRASH", point)
            .env("TSUMUGI_MIGRATION_HOOK", &marker)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap_or_else(|error| panic!(
                "missing {point}: {error}; {}",
                String::from_utf8_lossy(&output.stderr)
            )),
            point
        );
        let raw = Connection::open(path.join(DATABASE_FILENAME)).unwrap();
        let committed = point == "conversation-after-commit";
        assert_eq!(
            raw.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            if committed { SCHEMA_VERSION } else { 72 }
        );
        assert_eq!(conversation_capture_ddl(&raw), committed);
        assert_eq!(rows(&raw), before);
        assert!(
            !raw.prepare("PRAGMA foreign_key_check")
                .unwrap()
                .exists([])
                .unwrap()
        );
        drop(raw);
        let store = ProjectStore::open(path).unwrap();
        assert_eq!(
            store
                .connection()
                .unwrap()
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(rows(store.connection().unwrap()), before);
        assert_eq!(
            store
                .resource_decision_request_observation(&request)
                .unwrap()
                .unwrap()
                .receipt,
            receipt
        );
    }
}
