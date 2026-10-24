#![cfg(not(feature = "execution-test-host"))]
//! Real resource/translation persistence with isolated synthetic source captures.
mod support;
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use tsumugi_core::{
    ai::{self, AiConfig},
    content::SourceAdoptionHandler,
    execution::*,
    *,
};

fn project(store: &ProjectStore) -> ExecutionId {
    ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap()
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
fn correction(store: &mut ProjectStore, row: &content::ContentRow) -> CorrectionTermEvidence {
    let before = save(store, row, None, "Earlier translation");
    let after = save(
        store,
        row,
        Some(before.selection.event_id),
        "人工 e\u{301} 👩🏽‍💻 correction",
    );
    store
        .correction_term_basis(
            project(store),
            row.unit_id.unwrap(),
            "zh-CN",
            after.selection.event_id,
        )
        .unwrap()
}
fn proposal(evidence: &CorrectionTermEvidence) -> CaptureCorrectionTerm {
    CaptureCorrectionTerm {
        action_id: ExecutionId::new(),
        basis: evidence.basis.clone(),
        source: evidence.source_text.clone(),
        target: "e\u{301} 👩🏽‍💻".into(),
        protected: true,
        reason: "Preserve the explicitly chosen wording".into(),
    }
}
fn decision(
    receipt: &CorrectionTermReceipt,
    kind: ResourceDecisionKind,
    expected: Option<ExecutionId>,
) -> ResourceDecision {
    ResourceDecision {
        project_id: receipt.request.basis.project_id,
        action_id: ExecutionId::new(),
        capture_id: receipt.capture.capture_id,
        entry_id: "term".into(),
        expected_revision_id: expected,
        decision: kind,
    }
}
fn config(share_terms: bool) -> AiConfig {
    AiConfig {
        endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
        model: "synthetic".into(),
        credential_env: String::new(),
        share_terms,
        ..Default::default()
    }
}
fn body(config: &AiConfig, item: &ai::AiItem) -> serde_json::Value {
    let wire = ai::request_body(config, item).unwrap();
    serde_json::from_str(wire["messages"][1]["content"].as_str().unwrap()).unwrap()
}

#[test]
fn explicit_proposal_pins_original_unicode_and_does_not_adopt_or_repeat() {
    let (_dir, mut store, rows) = support::source_fixture();
    let evidence = correction(&mut store, &rows[0]);
    let p = project(&store);
    assert!(evidence.current);
    assert_eq!(evidence.before_text, "Earlier translation");
    assert!(
        store.list_glossary_captures(p, 100).unwrap().is_empty(),
        "ordinary saves create no proposals"
    );
    let request = proposal(&evidence);
    let receipt = store.capture_correction_term(&request).unwrap();
    assert_eq!(receipt.request, request);
    assert_eq!(
        receipt.capture.origin,
        GlossaryCaptureOrigin::Correction {
            basis: evidence.basis.clone()
        }
    );
    assert_eq!(receipt.capture.count, 1);
    let preview = store
        .glossary_preview(p, receipt.capture.capture_id)
        .unwrap();
    assert_eq!(preview.correction.as_ref().unwrap().evidence, evidence);
    assert!(preview.correction.unwrap().decision.is_none());
    assert_eq!(preview.rows[0].entry.target, "e\u{301} 👩🏽‍💻");
    assert_eq!(preview.rows[0].scope_unit_id, Some(evidence.basis.unit_id));
    assert!(
        store
            .resolve_terms(p, evidence.basis.unit_id, "zh-CN")
            .unwrap()
            .entries
            .is_empty()
    );
    assert_eq!(store.capture_correction_term(&request).unwrap(), receipt);
    let duplicate = CaptureCorrectionTerm {
        action_id: ExecutionId::new(),
        reason: "Another explicit reason".into(),
        protected: false,
        ..request.clone()
    };
    assert_eq!(
        store.capture_correction_term(&duplicate).unwrap_err().stage,
        "correction-existing"
    );
    assert!(
        store
            .correction_term_capture_action(p, duplicate.action_id)
            .unwrap()
            .is_none()
    );
    let changed = CaptureCorrectionTerm {
        reason: "Different payload under the original action".into(),
        ..request.clone()
    };
    assert_eq!(
        store.capture_correction_term(&changed).unwrap_err().code,
        ErrorCode::ResultMismatch
    );
    assert_eq!(
        store.list_glossary_captures(p, 100).unwrap(),
        vec![receipt.capture]
    );
    let mut previous = evidence.basis.after.selection_id;
    for index in 0..101 {
        previous = save(
            &mut store,
            &rows[0],
            Some(previous),
            &format!("Later saved draft {index}"),
        )
        .selection
        .event_id;
    }
    let historical = store
        .correction_term_basis(
            p,
            evidence.basis.unit_id,
            "zh-CN",
            evidence.basis.after.selection_id,
        )
        .unwrap();
    assert_eq!(historical.basis, evidence.basis);
    assert_eq!(historical.after_text, evidence.after_text);
    assert!(
        !historical.current,
        "exact basis lookup does not depend on the last history page"
    );
}

#[test]
fn only_manual_changed_adjacent_selections_and_exact_words_form_a_basis() {
    let (_dir, mut store, rows) = support::source_fixture_with_scope(2, &["zh-CN", "ja"]);
    let p = project(&store);
    let unit = rows[0].unit_id.unwrap();
    let first = save(&mut store, &rows[0], None, "Same text");
    assert!(
        store
            .correction_term_basis(p, unit, "zh-CN", first.selection.event_id)
            .is_err()
    );
    let unchanged = save(
        &mut store,
        &rows[0],
        Some(first.selection.event_id),
        "Same text",
    );
    assert!(
        store
            .correction_term_basis(p, unit, "zh-CN", unchanged.selection.event_id)
            .is_err()
    );
    let after = save(
        &mut store,
        &rows[0],
        Some(unchanged.selection.event_id),
        "人工 e\u{301} 👩🏽‍💻 correction",
    );
    let evidence = store
        .correction_term_basis(p, unit, "zh-CN", after.selection.event_id)
        .unwrap();
    let request = proposal(&evidence);
    for malformed in [
        CaptureCorrectionTerm {
            source: "not in the original source".into(),
            ..request.clone()
        },
        CaptureCorrectionTerm {
            target: "é 👩🏽‍💻".into(),
            ..request.clone()
        },
        CaptureCorrectionTerm {
            source: " ".into(),
            ..request.clone()
        },
        CaptureCorrectionTerm {
            reason: String::new(),
            ..request.clone()
        },
        CaptureCorrectionTerm {
            basis: CorrectionTermBasis {
                unit_id: rows[1].unit_id.unwrap(),
                ..request.basis.clone()
            },
            ..request.clone()
        },
        CaptureCorrectionTerm {
            basis: CorrectionTermBasis {
                locale: "ja".into(),
                ..request.basis.clone()
            },
            ..request.clone()
        },
        CaptureCorrectionTerm {
            basis: CorrectionTermBasis {
                project_id: ExecutionId::new(),
                ..request.basis.clone()
            },
            ..request.clone()
        },
        CaptureCorrectionTerm {
            basis: CorrectionTermBasis {
                source_revision_id: ExecutionId::new(),
                ..request.basis.clone()
            },
            ..request.clone()
        },
        CaptureCorrectionTerm {
            basis: CorrectionTermBasis {
                before: RevisionSelectionRef {
                    revision_id: first.revision.revision_id,
                    selection_id: first.selection.event_id,
                },
                ..request.basis.clone()
            },
            ..request.clone()
        },
    ] {
        assert!(store.capture_correction_term(&malformed).is_err());
    }
    let selected = store
        .select_translation_revision(&SelectTranslationRevision {
            project_id: p,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: rows[0].source_revision_id.unwrap(),
            expected_selection_id: Some(after.selection.event_id),
            revision_id: first.revision.revision_id,
        })
        .unwrap();
    assert!(
        store
            .correction_term_basis(p, unit, "zh-CN", selected.event_id)
            .is_err(),
        "reselect is not the original manual save"
    );
    assert!(store.list_glossary_captures(p, 100).unwrap().is_empty());
}

#[test]
fn decisions_preserve_exact_receipts_cas_and_stale_history_without_adoption() {
    let (dir, mut store, rows) = support::source_fixture();
    let evidence = correction(&mut store, &rows[0]);
    let p = project(&store);
    let request = proposal(&evidence);
    let capture = store.capture_correction_term(&request).unwrap();
    let ignored = decision(&capture, ResourceDecisionKind::Ignore, None);
    let receipt = store.decide_glossary_entry(&ignored).unwrap();
    assert_eq!(receipt.request, ignored);
    assert!(receipt.revision.is_none());
    assert_eq!(
        store
            .resource_decision_action(&ignored)
            .unwrap(),
        Some(tsumugi_core::ResourceDecisionActionRead { request: ignored.clone(), receipt: receipt.clone() })
    );
    assert_eq!(
        store
            .glossary_preview(p, capture.capture.capture_id)
            .unwrap()
            .correction
            .unwrap()
            .decision,
        Some(receipt.clone())
    );
    let conflict = decision(
        &capture,
        ResourceDecisionKind::Adopt,
        Some(ExecutionId::new()),
    );
    assert!(matches!(
        store.decide_glossary_entry(&conflict).unwrap_err().conflict,
        Some(ConflictEvidence::TermRevision { .. })
    ));
    save(
        &mut store,
        &rows[0],
        Some(evidence.basis.after.selection_id),
        "A later manual edit",
    );
    assert!(
        !store
            .glossary_preview(p, capture.capture.capture_id)
            .unwrap()
            .correction
            .unwrap()
            .evidence
            .current
    );
    assert_eq!(store.capture_correction_term(&request).unwrap(), capture);
    assert_eq!(store.decide_glossary_entry(&ignored).unwrap(), receipt);
    let mismatch = ResourceDecision {
        decision: ResourceDecisionKind::Keep,
        ..ignored.clone()
    };
    assert_eq!(
        store.decide_glossary_entry(&mismatch).unwrap_err().code,
        ErrorCode::ResultMismatch
    );
    let kept = decision(&capture, ResourceDecisionKind::Keep, None);
    let kept_receipt = store.decide_glossary_entry(&kept).unwrap();
    let adopt = decision(&capture, ResourceDecisionKind::Adopt, None);
    assert_eq!(
        store.decide_glossary_entry(&adopt).unwrap_err().stage,
        "correction-stale"
    );
    assert!(
        store
            .resource_decision_action(&adopt)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .resolve_terms(p, evidence.basis.unit_id, "zh-CN")
            .unwrap()
            .entries
            .is_empty()
    );
    store.close().unwrap();
    let mut reopened = ProjectStore::open(dir.path().join("project")).unwrap();
    assert_eq!(reopened.capture_correction_term(&request).unwrap(), capture);
    assert_eq!(reopened.decide_glossary_entry(&ignored).unwrap(), receipt);
    assert_eq!(
        reopened
            .resource_decision_action(&kept)
            .unwrap(),
        Some(tsumugi_core::ResourceDecisionActionRead { request: kept.clone(), receipt: kept_receipt })
    );
    assert!(
        !reopened
            .glossary_preview(p, capture.capture.capture_id)
            .unwrap()
            .correction
            .unwrap()
            .evidence
            .current
    );
}

#[test]
fn adopted_manual_term_is_scoped_and_only_new_shared_inputs_capture_it() {
    let (dir, mut store, rows) = support::source_fixture_with_scope(2, &["zh-CN", "ja"]);
    let evidence = correction(&mut store, &rows[0]);
    let p = project(&store);
    let unit = evidence.basis.unit_id;
    let cfg = config(true);
    let old = store.preview_ai(cfg.clone(), "zh-CN", &[unit]).unwrap();
    let fixed = old
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let original = body(&cfg, &old.items[0]);
    let bytes = fixed.bytes().to_vec();
    store.enqueue_execution(&fixed).unwrap();
    let capture = store.capture_correction_term(&proposal(&evidence)).unwrap();
    let ignored = decision(&capture, ResourceDecisionKind::Ignore, None);
    store.decide_glossary_entry(&ignored).unwrap();
    let adopt = decision(&capture, ResourceDecisionKind::Adopt, None);
    let receipt = store.decide_glossary_entry(&adopt).unwrap();
    let term = receipt.revision.clone().unwrap();
    assert_eq!(term.origin_kind, TermOrigin::Manual);
    assert_eq!(term.capture_id, Some(capture.capture.capture_id));
    assert!(term.external_entry_id.is_none());
    assert_eq!(term.scope_unit_id, Some(unit));
    let raced = decision(&capture, ResourceDecisionKind::Adopt, None);
    assert!(
        matches!(store.decide_glossary_entry(&raced).unwrap_err().conflict,
        Some(ConflictEvidence::TermRevision{expected:None,current:Some(current)}) if current==term.revision_id)
    );
    let override_request = decision(
        &capture,
        ResourceDecisionKind::Override,
        Some(term.revision_id),
    );
    assert_eq!(
        store
            .decide_glossary_entry(&override_request)
            .unwrap_err()
            .stage,
        "correction-adopt"
    );
    assert_eq!(
        store.resolve_terms(p, unit, "zh-CN").unwrap().entries[0].selected,
        Some(term.clone())
    );
    assert!(
        store
            .resolve_terms(p, rows[1].unit_id.unwrap(), "zh-CN")
            .unwrap()
            .entries
            .is_empty()
    );
    assert!(
        store
            .resolve_terms(p, unit, "ja")
            .unwrap()
            .entries
            .is_empty()
    );
    let new = store.preview_ai(cfg.clone(), "zh-CN", &[unit]).unwrap();
    assert!(body(&cfg, &new.items[0]).to_string().contains("é 👩🏽‍💻"));
    let private = config(false);
    let unshared = store.preview_ai(private.clone(), "zh-CN", &[unit]).unwrap();
    assert!(
        !body(&private, &unshared.items[0])
            .to_string()
            .contains("é 👩🏽‍💻")
    );
    save(
        &mut store,
        &rows[0],
        Some(evidence.basis.after.selection_id),
        "Later translation without the proposed term",
    );
    assert_eq!(
        store.resolve_terms(p, unit, "zh-CN").unwrap().entries[0].selected,
        Some(term.clone()),
        "adopted manual authority survives later translation edits"
    );
    let edited = store
        .save_term(&SaveTerm {
            project_id: p,
            action_id: ExecutionId::new(),
            term_id: Some(term.term_id.clone()),
            locale: term.locale.clone(),
            source: term.source.clone(),
            aliases: Vec::new(),
            target: "Later explicit term".into(),
            protected: false,
            scope_unit_id: Some(unit),
            expected_revision_id: Some(term.revision_id),
            reason: "Edit through the original manual owner".into(),
        })
        .unwrap();
    assert!(edited.capture_id.is_none());
    assert_eq!(
        store.term_history(p, &term.term_id, 0, 10).unwrap(),
        vec![term.clone(), edited]
    );
    assert_eq!(store.decide_glossary_entry(&adopt).unwrap(), receipt);
    store.close().unwrap();
    let reopened = ProjectStore::open(dir.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .execution_input(fixed.envelope().attempt_id)
            .unwrap()
            .bytes(),
        bytes
    );
    let saved = reopened
        .execution_input(fixed.envelope().attempt_id)
        .unwrap();
    assert_eq!(
        body(
            &cfg,
            &ai::item_payload(&saved, saved.envelope().items[0].item_id).unwrap()
        ),
        original
    );
    assert_eq!(
        reopened
            .glossary_preview(p, capture.capture.capture_id)
            .unwrap()
            .capture,
        capture.capture
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
    assert!(comparison.confirmation.lineage.is_empty());
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
            reason: "Reviewed this exact source continuation".into(),
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
fn actual_source_replacement_preserves_old_basis_and_before_original_source() {
    let (dir, mut store, rows) = support::source_fixture();
    let p = project(&store);
    let evidence = correction(&mut store, &rows[0]);
    let original = proposal(&evidence);
    let capture = store.capture_correction_term(&original).unwrap();
    let updated = replace_source(&mut store);
    let row = updated
        .iter()
        .find(|r| r.unit_id == rows[0].unit_id)
        .unwrap();
    assert!(
        !store
            .correction_term_basis(
                p,
                evidence.basis.unit_id,
                "zh-CN",
                evidence.basis.after.selection_id
            )
            .unwrap()
            .current
    );
    assert_eq!(
        store
            .decide_glossary_entry(&decision(&capture, ResourceDecisionKind::Adopt, None))
            .unwrap_err()
            .stage,
        "correction-stale"
    );
    assert_eq!(store.capture_correction_term(&original).unwrap(), capture);
    let new = save(
        &mut store,
        row,
        Some(evidence.basis.after.selection_id),
        "New source e\u{301} 👩🏽‍💻 correction",
    );
    let fresh = store
        .correction_term_basis(p, row.unit_id.unwrap(), "zh-CN", new.selection.event_id)
        .unwrap();
    assert!(fresh.current);
    assert_ne!(
        fresh.basis.source_snapshot_id,
        evidence.basis.source_snapshot_id
    );
    assert_eq!(
        fresh.before_source_snapshot_id,
        evidence.basis.source_snapshot_id
    );
    assert_eq!(
        fresh.before_source_revision_id,
        evidence.basis.source_revision_id
    );
    assert_eq!(fresh.before_text, evidence.after_text);
    let new_capture = store.capture_correction_term(&proposal(&fresh)).unwrap();
    store.close().unwrap();
    let reopened = ProjectStore::open(dir.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .glossary_preview(p, new_capture.capture.capture_id)
            .unwrap()
            .correction
            .unwrap()
            .evidence,
        fresh
    );
    assert_eq!(
        reopened
            .correction_term_capture_action(p, original.action_id)
            .unwrap(),
        Some(capture)
    );
}

#[test]
fn reopen_rejects_forged_immutable_basis_and_manual_adoption_links_without_ai_captures() {
    for scenario in ["basis", "decision", "manual", "origin", "orphan"] {
        let (_dir, mut store, rows) = support::source_fixture();
        let evidence = correction(&mut store, &rows[0]);
        let request = proposal(&evidence);
        let capture = store.capture_correction_term(&request).unwrap();
        let adopt = decision(&capture, ResourceDecisionKind::Adopt, None);
        let term = store
            .decide_glossary_entry(&adopt)
            .unwrap()
            .revision
            .unwrap();
        let path = store.directory().to_path_buf();
        store.close().unwrap();
        let c = Connection::open(path.join("project.sqlite3")).unwrap();
        match scenario {
            "basis" => {
                let mut forged = request.clone();
                forged.basis.before.selection_id = forged.basis.after.selection_id;
                let bytes = serde_json::to_vec(&forged).unwrap();
                let digest = format!("{:x}", Sha256::digest(&bytes));
                let key = format!(
                    "{:x}",
                    Sha256::digest(
                        serde_json::to_vec(&(&forged.basis, &forged.source, &forged.target))
                            .unwrap()
                    )
                );
                c.execute("UPDATE resource_captures SET bytes=?2,digest=?3,request_digest=?3,correction_key=?4 WHERE capture_id=?1",params![capture.capture.capture_id.to_string(),bytes,digest,key]).unwrap();
            }
            "decision" => {
                c.execute(
                    "UPDATE resource_decisions SET expected_revision_id=?2 WHERE action_id=?1",
                    params![adopt.action_id.to_string(), term.revision_id.to_string()],
                )
                .unwrap();
            }
            "manual" => {
                c.execute(
                    "UPDATE term_revisions SET target='forged wording' WHERE revision_id=?1",
                    [term.revision_id.to_string()],
                )
                .unwrap();
            }
            "origin" => {
                c.execute("UPDATE term_revisions SET origin_kind='external',external_entry_id='term' WHERE revision_id=?1",[term.revision_id.to_string()]).unwrap();
            }
            "orphan" => {
                c.execute(
                    "DELETE FROM resource_decisions WHERE action_id=?1",
                    [adopt.action_id.to_string()],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        drop(c);
        assert_eq!(
            ProjectStore::open(path).unwrap_err().code(),
            PersistenceErrorCode::CorruptProject,
            "{scenario}"
        );
    }
}

#[test]
fn file_provenance_and_manual_edit_semantics_remain_separate_and_preview_is_required_nullable() {
    let (_dir, mut store, _rows) = support::source_fixture();
    let p = project(&store);
    let bytes = serde_json::to_vec(&GlossaryFile {
        format: "tsumugi-glossary-v1".into(),
        resource_id: "terms".into(),
        revision: "r1".into(),
        license: "Synthetic fixture".into(),
        source_locale: "en".into(),
        target_locale: "zh-CN".into(),
        entries: vec![GlossaryEntry {
            id: "same".into(),
            source: "same".into(),
            aliases: Vec::new(),
            target: "同".into(),
            protected: false,
            native_key: None,
            reason: "File import".into(),
        }],
    })
    .unwrap();
    let capture = store
        .capture_glossary(p, ExecutionId::new(), &bytes)
        .unwrap();
    assert_eq!(
        capture.origin,
        GlossaryCaptureOrigin::File {
            resource_id: "terms".into(),
            revision: "r1".into(),
            license: "Synthetic fixture".into()
        }
    );
    let preview = store.glossary_preview(p, capture.capture_id).unwrap();
    assert!(preview.correction.is_none());
    let mut wire = serde_json::to_value(preview).unwrap();
    assert_eq!(wire["correction"], serde_json::Value::Null);
    assert!(serde_json::from_value::<ResourcePreview>(wire.clone()).is_ok());
    wire.as_object_mut().unwrap().remove("correction");
    assert!(serde_json::from_value::<ResourcePreview>(wire).is_err());
    let receipt = store
        .decide_glossary_entry(&ResourceDecision {
            project_id: p,
            action_id: ExecutionId::new(),
            capture_id: capture.capture_id,
            entry_id: "same".into(),
            expected_revision_id: None,
            decision: ResourceDecisionKind::Adopt,
        })
        .unwrap();
    assert_eq!(
        receipt.revision.as_ref().unwrap().origin_kind,
        TermOrigin::External
    );
    assert_eq!(
        receipt
            .revision
            .as_ref()
            .unwrap()
            .external_entry_id
            .as_deref(),
        Some("same")
    );
    let mut wire = serde_json::to_value(&receipt).unwrap();
    wire.as_object_mut().unwrap().remove("request");
    assert!(serde_json::from_value::<ResourceDecisionResult>(wire).is_err());
}

#[test]
fn decision_action_reads_require_the_complete_original_correction_and_proof_without_writes() {
    let (directory, mut store, rows) = support::source_fixture();
    let evidence = correction(&mut store, &rows[0]);
    let capture = store.capture_correction_term(&proposal(&evidence)).unwrap();
    let original = decision(&capture, ResourceDecisionKind::Adopt, None);
    let receipt = store.decide_glossary_entry(&original).unwrap();
    let expected = ResourceDecisionActionRead { request: original.clone(), receipt: receipt.clone() };
    let database = Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
    let version = || database.query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0)).unwrap();
    let before = version();
    let sequence = store.changes_since(Revision::new(0).unwrap()).sequence;
    assert_eq!(store.resource_decision_action(&original).unwrap(), Some(expected.clone()));
    for field in 0..5 {
        let mut wrong = original.clone();
        match field {
            0 => wrong.project_id = ExecutionId::new(),
            1 => wrong.capture_id = ExecutionId::new(),
            2 => wrong.entry_id = "another-term".into(),
            3 => wrong.expected_revision_id = Some(ExecutionId::new()),
            _ => wrong.decision = ResourceDecisionKind::Keep,
        }
        assert!(store.resource_decision_action(&wrong).is_err());
    }
    let mut missing = original.clone(); missing.action_id = ExecutionId::new();
    assert_eq!(store.resource_decision_action(&missing).unwrap(), None);
    assert_eq!(version(), before);
    assert_eq!(store.changes_since(sequence).sequence, sequence);

    // The exact row and request digest are insufficient when its historical proof was altered.
    let saved_revision = receipt.revision.as_ref().unwrap();
    database.execute("UPDATE term_revisions SET reason='Altered historical proof' WHERE revision_id=?1",
        [saved_revision.revision_id.to_string()]).unwrap();
    let before = version();
    assert_eq!(store.resource_decision_action(&original).unwrap_err().code, ErrorCode::CorruptLedger);
    assert_eq!(version(), before);
    database.execute("UPDATE term_revisions SET reason=?2 WHERE revision_id=?1",
        params![saved_revision.revision_id.to_string(), saved_revision.reason]).unwrap();
    // Later edits and locale removal never rebind the original correction receipt.
    save(&mut store, &rows[0], Some(evidence.basis.after.selection_id), "Later input");
    let revision = store.metadata().unwrap().metadata_revision();
    store.set_target_locales(revision, &["fr-FR".into()]).unwrap();
    let before = version();
    assert_eq!(store.resource_decision_action(&original).unwrap(), Some(expected.clone()));
    assert_eq!(version(), before);
    store.close().unwrap();
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    let before = version();
    assert_eq!(reopened.resource_decision_action(&original).unwrap(), Some(expected));
    assert_eq!(version(), before);
}
