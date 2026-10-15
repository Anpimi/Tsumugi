#![cfg(not(feature = "execution-test-host"))]
//! Real project/source persistence and request construction; no Provider request is dispatched.
mod support;
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use tsumugi_core::{
    ai::{self, AiConfig, arena::ArenaConfig},
    application::{AuthorizeWorkPlan, PlanOptions},
    content::SourceAdoptionHandler,
    execution::*,
    *,
};
use tsumugi_plugin_sdk as sdk;

fn facts(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    let source = exchange.units[0].occurrences[0].source.clone();
    exchange.domain_blocks = vec![
        (sdk::ContentTarget::Snapshot, true, "shared hypothesis"),
        (
            sdk::ContentTarget::Unit {
                id: exchange.units[0].id.clone(),
            },
            false,
            "captain",
        ),
    ]
    .into_iter()
    .map(|(target, inferred, text)| sdk::DomainBlock {
        target,
        schema: sdk::source_context_facts_contract(),
        handling: sdk::ExtensionHandling::Preserve,
        payload_utf8: serde_json::to_string(&sdk::SourceContextFacts {
            facts: vec![sdk::SourceContextFact {
                id: "same-local-id".into(),
                kind: sdk::SourceContextFactKind::Role,
                text: text.into(),
                origin: if inferred {
                    sdk::SourceContextFactOrigin::Inferred {
                        rationale: "source hypothesis".into(),
                        sources: vec![source.clone()],
                    }
                } else {
                    sdk::SourceContextFactOrigin::Extracted {
                        sources: vec![source.clone()],
                    }
                },
            }],
        })
        .unwrap(),
    })
    .collect();
    exchange
}
fn scope(store: &ProjectStore, row: &content::ContentRow, locale: &str) -> SourceContextRequest {
    SourceContextRequest {
        project_id: ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
            .unwrap(),
        unit_id: row.unit_id.unwrap(),
        source_snapshot_id: store.content_scope().unwrap().current_snapshot.unwrap(),
        source_revision_id: row.source_revision_id.unwrap(),
        locale: locale.into(),
    }
}
fn request(
    store: &ProjectStore,
    scope: &SourceContextRequest,
    block: u32,
    disposition: ContextFactDisposition,
) -> ContextFactWrite {
    ContextFactWrite {
        action_id: ExecutionId::new(),
        basis: SourceFactBasis::from_view(&store.source_context(scope).unwrap(), block, 0).unwrap(),
        expected_decision_id: None,
        disposition,
        actor: "Synthetic reviewer".into(),
        reason: "Local correction reason".into(),
    }
}
fn config(manual: bool, extracted: bool, inferred: bool) -> AiConfig {
    AiConfig {
        endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
        model: "synthetic".into(),
        credential_env: String::new(),
        share_context: manual,
        source_context: SourceContextSelection {
            extracted,
            inferred,
            ..Default::default()
        },
        ..Default::default()
    }
}
fn body(config: &AiConfig, item: &ai::AiItem) -> serde_json::Value {
    let body = ai::request_body(config, item).unwrap();
    serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap()
}

#[test]
fn decisions_are_exact_append_only_cas_actions_and_reopen_with_original_sources() {
    let (dir, mut store, rows) = support::source_fixture_with_transform(2, facts);
    let scope = scope(&store, &rows[0], "zh-CN");
    let original = store.source_context(&scope).unwrap();
    let change = request(
        &store,
        &scope,
        0,
        ContextFactDisposition::Replace {
            text: "navigator 👩🏽‍🚀".into(),
        },
    );
    let receipt = store.decide_context_fact(&change).unwrap();
    assert_eq!(store.decide_context_fact(&change).unwrap(), receipt);
    assert_eq!(
        store
            .context_fact_action(scope.project_id, change.action_id)
            .unwrap(),
        Some(receipt.clone())
    );
    let mut altered = change.clone();
    altered.reason = "different request".into();
    assert_eq!(
        store.decide_context_fact(&altered).unwrap_err().code,
        ErrorCode::ResultMismatch
    );
    let mut stale = change.clone();
    stale.action_id = ExecutionId::new();
    assert_eq!(
        store.decide_context_fact(&stale).unwrap_err().stage,
        "context-fact-current"
    );
    let mut forged = stale.clone();
    forged.expected_decision_id = Some(change.action_id);
    forged.basis.fact.fact.text = "tampered source".into();
    assert_eq!(
        store.decide_context_fact(&forged).unwrap_err().stage,
        "context-fact-basis"
    );
    let mut wrong_scope = stale.clone();
    wrong_scope.basis.scope.unit_id = rows[1].unit_id.unwrap();
    assert!(store.decide_context_fact(&wrong_scope).is_err());
    let mut wrong_project = stale.clone();
    wrong_project.basis.scope.project_id = ExecutionId::new();
    assert!(store.decide_context_fact(&wrong_project).is_err());
    assert!(
        store
            .context_fact_action(ExecutionId::new(), change.action_id)
            .is_err()
    );
    assert_eq!(store.source_context(&scope).unwrap(), original);
    let cfg = config(true, true, true);
    let captured = store
        .preview_ai(cfg.clone(), "zh-CN", &[scope.unit_id])
        .unwrap();
    for scenario in 0..4 {
        let mut forged = captured.clone();
        let ProjectFactCapture::Selected { decisions, .. } = &mut forged.items[0].project_context
        else {
            panic!("pinned decision")
        };
        match scenario {
            0 => decisions[0].request.actor = "forged actor".into(),
            1 => decisions[0].request.reason = "forged reason".into(),
            2 => {
                decisions[0].request.disposition = ContextFactDisposition::Replace {
                    text: "forged replacement".into(),
                }
            }
            _ => decisions[0].request.disposition = ContextFactDisposition::RejectInference,
        };
        forged.digest = ai::preview_digest(&cfg, &forged.items).unwrap();
        let input = forged
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        assert_eq!(
            store.enqueue_execution(&input).unwrap_err().stage,
            "context-fact-capture-record"
        );
    }
    store.close().unwrap();
    let store = ProjectStore::open(dir.path().join("project")).unwrap();
    assert_eq!(
        store
            .context_fact_decisions(
                &scope,
                &[ContextFactPosition {
                    block_index: 0,
                    fact_index: 0
                }]
            )
            .unwrap(),
        vec![receipt]
    );
    assert_eq!(
        store
            .context_fact_history(scope.project_id, scope.unit_id, &scope.locale, 0, 1)
            .unwrap()
            .rows
            .len(),
        1
    );
    assert_eq!(store.source_context(&scope).unwrap(), original);
}

#[test]
fn reopening_rejects_forked_and_forward_fact_predecessors_without_ai_captures() {
    for (scenario, target, predecessor) in [
        ("second root", 1_usize, None::<usize>),
        ("skipped predecessor", 2, Some(0)),
        ("future predecessor", 0, Some(2)),
        ("cyclic predecessor", 1, Some(2)),
    ] {
        let (_dir, mut store, rows) = support::source_fixture_with_transform(2, facts);
        let scope = scope(&store, &rows[0], "zh-CN");
        let mut actions: Vec<ContextFactWrite> = Vec::new();
        for text in [
            "First replacement",
            "Second replacement",
            "Third replacement",
        ] {
            let mut change = request(
                &store,
                &scope,
                0,
                ContextFactDisposition::Replace { text: text.into() },
            );
            change.expected_decision_id = actions.last().map(|prior| prior.action_id);
            store.decide_context_fact(&change).unwrap();
            actions.push(change);
        }
        let project = store.directory().to_path_buf();
        store.close().unwrap();
        let connection = Connection::open(project.join("project.sqlite3")).unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        let ai_inputs: i64 = connection
            .query_row(
                "SELECT count(*) FROM execution_tasks WHERE operation IN (?1,?2)",
                params![ai::OPERATION, ai::arena::OPERATION],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            ai_inputs, 0,
            "{scenario}: no captured AI copy may detect this"
        );

        let mut corrupted = actions[target].clone();
        corrupted.expected_decision_id = predecessor.map(|index| actions[index].action_id);
        let bytes = serde_json::to_vec(&corrupted).unwrap();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        // Keep the row, request and hash mutually consistent. Only the causal
        // predecessor order is invalid, not its identity, source or encoding.
        assert_eq!(
            connection
                .execute(
                    "UPDATE context_fact_decisions SET previous_action_id=?2,request=?3,request_digest=?4 WHERE action_id=?1",
                    params![
                        corrupted.action_id.to_string(),
                        corrupted.expected_decision_id.map(|id| id.to_string()),
                        bytes,
                        digest
                    ],
                )
                .unwrap(),
            1
        );
        drop(connection);
        assert_eq!(
            ProjectStore::open(&project).unwrap_err().code(),
            PersistenceErrorCode::CorruptProject,
            "{scenario}"
        );
    }
}

#[test]
fn interleaved_fact_chains_and_restorations_reopen_in_their_exact_scopes() {
    let (_dir, mut store, rows) = support::source_fixture_with_transform(2, facts);
    let first = scope(&store, &rows[0], "zh-CN");
    let targets = [
        (first.clone(), 0),
        (scope(&store, &rows[1], "zh-CN"), 0),
        (scope(&store, &rows[0], "ja"), 0),
        (first, 1),
    ];
    let mut changes = Vec::new();
    for (scope, block) in &targets {
        let change = request(
            &store,
            scope,
            *block,
            ContextFactDisposition::Replace {
                text: "Local replacement".into(),
            },
        );
        store.decide_context_fact(&change).unwrap();
        changes.push(change);
    }
    let mut restored = Vec::new();
    for change in changes {
        let restore = ContextFactWrite {
            action_id: ExecutionId::new(),
            expected_decision_id: Some(change.action_id),
            disposition: ContextFactDisposition::Restore,
            reason: "Restore the original source observation".into(),
            ..change
        };
        restored.push(store.decide_context_fact(&restore).unwrap());
    }
    let project = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(project).unwrap();
    for ((scope, block), receipt) in targets.iter().zip(restored) {
        assert_eq!(
            reopened
                .context_fact_decisions(
                    scope,
                    &[ContextFactPosition {
                        block_index: *block,
                        fact_index: 0,
                    }],
                )
                .unwrap(),
            vec![receipt.clone()]
        );
        let history = reopened
            .context_fact_history(scope.project_id, scope.unit_id, &scope.locale, 0, 10)
            .unwrap();
        let chain = history
            .rows
            .iter()
            .filter(|row| row.request.basis.fact.block_index == *block)
            .collect::<Vec<_>>();
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0], &receipt);
        assert_eq!(
            receipt.request.expected_decision_id,
            Some(chain[1].request.action_id)
        );
    }
}

#[test]
fn manual_replacement_sharing_is_independent_and_never_restores_the_original() {
    let (_dir, mut store, rows) = support::source_fixture_with_transform(2, facts);
    let scope = scope(&store, &rows[0], "zh-CN");
    store
        .decide_context_fact(&request(
            &store,
            &scope,
            1,
            ContextFactDisposition::Replace {
                text: "navigator".into(),
            },
        ))
        .unwrap();
    for manual in [false, true] {
        for extracted in [false, true] {
            for inferred in [false, true] {
                let config = config(manual, extracted, inferred);
                let preview = store
                    .preview_ai(config.clone(), "zh-CN", &[scope.unit_id])
                    .unwrap();
                let body = body(&config, &preview.items[0]);
                let wire = serde_json::to_string(&body).unwrap();
                assert!(!wire.contains("captain"));
                assert!(!wire.contains("Local correction reason"));
                assert!(!wire.contains("same-local-id"));
                assert!(!wire.contains("sourceResult"));
                assert_eq!(body.get("manualContextFacts").is_some(), manual);
                if manual {
                    assert_eq!(body["manualContextFacts"][0]["text"], "navigator");
                    assert_eq!(body["manualContextFacts"][0]["origin"], "manual");
                }
                assert_eq!(wire.contains("shared hypothesis"), inferred);
                let input = preview
                    .fixed_input(store.metadata().unwrap().project_id())
                    .unwrap();
                ai::settings(&input).unwrap();
                let mut missing = serde_json::to_value(&preview.items[0]).unwrap();
                missing.as_object_mut().unwrap().remove("projectContext");
                assert!(serde_json::from_value::<ai::AiItem>(missing).is_err());
            }
        }
    }
    let variants = vec![config(false, true, true), config(true, false, false)];
    let arena = store
        .preview_arena(
            ArenaConfig {
                variants: variants.clone(),
                max_items: 20,
                max_requests: 40,
                concurrency: 1,
                blind: true,
                parent_attempt_id: None,
            },
            "zh-CN",
            &[scope.unit_id],
        )
        .unwrap();
    for item in &arena.items {
        let wire = body(&variants[item.slot], &item.item);
        assert!(!wire.to_string().contains("captain"));
        assert_eq!(wire.get("manualContextFacts").is_some(), item.slot == 1);
    }
}

#[test]
fn reject_and_restore_are_new_decisions_scoped_to_one_fact_unit_and_locale() {
    let (_dir, mut store, rows) = support::source_fixture_with_transform(2, facts);
    let a = scope(&store, &rows[0], "zh-CN");
    let b = scope(&store, &rows[1], "zh-CN");
    let ja = scope(&store, &rows[0], "ja");
    store
        .save_translation_edit(&SaveTranslationRevision {
            project_id: a.project_id,
            action_id: ExecutionId::new(),
            unit_id: a.unit_id,
            locale: a.locale.clone(),
            source_revision_id: a.source_revision_id,
            expected_selection_id: None,
            text: "Existing selected translation".into(),
        })
        .unwrap();
    let rejected = request(&store, &a, 0, ContextFactDisposition::RejectInference);
    store.decide_context_fact(&rejected).unwrap();
    let impacts = store
        .resource_impacts(a.project_id, "zh-CN", 0, 10)
        .unwrap();
    assert_eq!(impacts.items.len(), 1);
    assert_eq!(impacts.items[0].unit_id, a.unit_id);
    assert_eq!(
        impacts.items[0].reasons[0].kind,
        ResourceImpactKind::ContextFact
    );
    assert!(impacts.items[0].reasons[0].new_removed);
    assert_eq!(impacts.items[0].reasons[0].new_value, "shared hypothesis");
    let cfg = config(false, true, true);
    assert!(
        !body(
            &cfg,
            &store
                .preview_ai(cfg.clone(), "zh-CN", &[a.unit_id])
                .unwrap()
                .items[0]
        )
        .to_string()
        .contains("shared hypothesis")
    );
    assert!(
        body(
            &cfg,
            &store
                .preview_ai(cfg.clone(), "zh-CN", &[b.unit_id])
                .unwrap()
                .items[0]
        )
        .to_string()
        .contains("shared hypothesis")
    );
    assert!(
        body(
            &cfg,
            &store
                .preview_ai(cfg.clone(), "ja", &[ja.unit_id])
                .unwrap()
                .items[0]
        )
        .to_string()
        .contains("shared hypothesis")
    );
    let mut restored = request(&store, &a, 0, ContextFactDisposition::Restore);
    restored.expected_decision_id = Some(rejected.action_id);
    store.decide_context_fact(&restored).unwrap();
    let impacts = store
        .resource_impacts(a.project_id, "zh-CN", 0, 10)
        .unwrap();
    let restore_impact = impacts.items[0]
        .reasons
        .iter()
        .find(|r| r.new_revision_id == restored.action_id)
        .unwrap();
    assert!(!restore_impact.new_removed);
    assert_eq!(restore_impact.old_value, None);
    assert_eq!(restore_impact.new_value, "shared hypothesis");
    assert!(
        body(
            &cfg,
            &store
                .preview_ai(cfg.clone(), "zh-CN", &[a.unit_id])
                .unwrap()
                .items[0]
        )
        .to_string()
        .contains("shared hypothesis")
    );
    let cfg = config(true, true, false);
    assert!(
        !body(
            &cfg,
            &store
                .preview_ai(cfg.clone(), "zh-CN", &[a.unit_id])
                .unwrap()
                .items[0]
        )
        .to_string()
        .contains("shared hypothesis")
    );
    let page = store
        .context_fact_history(a.project_id, a.unit_id, "zh-CN", 0, 1)
        .unwrap();
    assert_eq!(page.next_offset, Some(1));
    assert_eq!(page.rows[0].request, restored);
    assert_eq!(
        store
            .context_fact_history(a.project_id, a.unit_id, "zh-CN", 1, 1)
            .unwrap()
            .rows[0]
            .request,
        rejected
    );
    let extracted = request(&store, &a, 1, ContextFactDisposition::RejectInference);
    assert!(store.decide_context_fact(&extracted).is_err());
}

#[test]
fn first_decision_revokes_only_related_unaccepted_plans_and_preserves_fixed_input() {
    let (dir, mut store, rows) = support::source_fixture_with_transform(2, facts);
    let a = scope(&store, &rows[0], "zh-CN");
    let b = scope(&store, &rows[1], "zh-CN");
    let cfg = config(true, true, true);
    let plan = store
        .prepare_work_plan(
            Some(cfg.clone()),
            "zh-CN",
            &[a.unit_id],
            PlanOptions::default(),
        )
        .unwrap();
    let other = store
        .prepare_work_plan(
            Some(cfg.clone()),
            "zh-CN",
            &[b.unit_id],
            PlanOptions::default(),
        )
        .unwrap();
    let ja = store
        .prepare_work_plan(
            Some(cfg.clone()),
            "ja",
            &[a.unit_id],
            PlanOptions::default(),
        )
        .unwrap();
    let manual_only = store
        .prepare_work_plan(
            Some(config(true, false, false)),
            "zh-CN",
            &[a.unit_id],
            PlanOptions::default(),
        )
        .unwrap();
    let unselected = store
        .prepare_work_plan(
            Some(config(false, false, false)),
            "zh-CN",
            &[a.unit_id],
            PlanOptions::default(),
        )
        .unwrap();
    store.verify_work_plan(&plan).unwrap();
    let preview = store
        .preview_ai(cfg.clone(), "zh-CN", &[a.unit_id])
        .unwrap();
    let input = preview
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let bytes = input.bytes().to_vec();
    let original = body(&cfg, &preview.items[0]);
    // Store the fixed input without constructing or dispatching a Provider runner.
    store.enqueue_execution(&input).unwrap();
    store
        .decide_context_fact(&request(
            &store,
            &a,
            0,
            ContextFactDisposition::RejectInference,
        ))
        .unwrap();
    assert_eq!(
        store.verify_work_plan(&plan).unwrap_err().stage,
        "work-plan-evidence"
    );
    assert_eq!(
        store.verify_work_plan(&manual_only).unwrap_err().stage,
        "work-plan-evidence"
    );
    store.verify_work_plan(&unselected).unwrap();
    let authorization = AuthorizeWorkPlan {
        action_id: ExecutionId::new(),
        plan_digest: plan.digest.clone(),
        confirmed: true,
        effects: plan.authorization_effects().unwrap(),
        expires_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 600,
    };
    assert_eq!(
        store
            .authorize_work_plan(&plan, &authorization)
            .unwrap_err()
            .stage,
        "work-plan-evidence"
    );
    assert!(
        store
            .work_plan_receipt(authorization.action_id)
            .unwrap()
            .is_none()
    );
    store.verify_work_plan(&other).unwrap();
    store.verify_work_plan(&ja).unwrap();
    store.close().unwrap();
    let store = ProjectStore::open(dir.path().join("project")).unwrap();
    let saved = store.execution_input(input.envelope().attempt_id).unwrap();
    assert_eq!(saved.bytes(), bytes);
    let item = ai::item_payload(&saved, saved.envelope().items[0].item_id).unwrap();
    assert_eq!(body(&cfg, &item), original);
}

#[test]
fn source_replacement_retains_old_decisions_and_requires_explicit_new_basis() {
    let (_dir, mut store, rows) = support::source_fixture_with_transform(2, facts);
    let scope = scope(&store, &rows[0], "zh-CN");
    let original = request(&store, &scope, 0, ContextFactDisposition::RejectInference);
    let receipt = store.decide_context_fact(&original).unwrap();
    let source = store.source_context(&scope).unwrap();
    let original_input = store.execution_input(source.source_attempt_id).unwrap();
    let mut envelope = support::source_input_with_texts(&store, &["updated", "other"])
        .envelope()
        .clone();
    // The initial facts fixture captures this contract in its revision policy.
    // Updating source text must retain that exact identity-policy family.
    envelope.settings["revisionPolicy"] =
        original_input.envelope().settings["revisionPolicy"].clone();
    let input = FixedInput::capture(envelope).unwrap();
    let mut runtime = support::source_runtime(&store);
    let (_, result) = support::execute(&mut runtime, &mut store, &input);
    let validation = store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check_input = validation.check_input().clone();
    let (_, checked) = support::execute(&mut runtime, &mut store, &check_input);
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
    assert_eq!(comparison.changed, 2);
    assert_eq!(comparison.rows.len(), 2);
    assert!(comparison.confirmation.lineage.is_empty());
    let mut confirmation = comparison.confirmation;
    confirmation.actor = Some("Synthetic source reviewer".into());
    // Review each actual comparison candidate, rather than assuming that a
    // row's position in either read is its source occurrence ordinal.
    for change in comparison.rows {
        assert_eq!(change.kind, content::SourceChangeKind::Changed);
        let new = change.new.unwrap();
        let old = change.old.unwrap();
        assert_eq!(change.candidates.len(), 1);
        assert_eq!(change.candidates[0].occurrence_id, old.occurrence_id);
        assert_eq!(new.key, old.occurrence.key);
        assert!(
            rows.iter()
                .any(|row| row.occurrence_id == old.occurrence_id)
        );
        confirmation.lineage.push(content::LineageChoice {
            new_ordinal: new.ordinal,
            old_occurrence_id: old.occurrence_id.unwrap(),
            decision: content::LineageDecision::Continue,
            reason: "Reviewed the updated text against this original source occurrence".into(),
        });
    }
    let cfg = config(true, true, true);
    let captured = store
        .preview_ai(cfg.clone(), "zh-CN", &[scope.unit_id])
        .unwrap();
    let fixed = captured
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let original_body = body(&cfg, &captured.items[0]);
    store.enqueue_execution(&fixed).unwrap();
    let mut restored = request(&store, &scope, 0, ContextFactDisposition::Restore);
    restored.expected_decision_id = Some(original.action_id);
    store.decide_context_fact(&restored).unwrap();
    // An accepted capture retains its original decision after a later restore.
    assert_eq!(
        store
            .execution_input(fixed.envelope().attempt_id)
            .unwrap()
            .bytes(),
        fixed.bytes()
    );
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
    let current_snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    assert_ne!(current_snapshot, scope.source_snapshot_id);
    let updated = store.source_content(current_snapshot, 0, 2).unwrap();
    for old in &rows {
        let current = updated
            .rows
            .iter()
            .find(|row| row.unit_id == old.unit_id)
            .unwrap();
        assert_ne!(current.source_revision_id, old.source_revision_id);
    }
    let current = store
        .preview_ai(cfg.clone(), "zh-CN", &[scope.unit_id])
        .unwrap();
    let ProjectFactCapture::Selected { decisions, .. } = &current.items[0].project_context else {
        panic!("the new source must have its own explicit decision capture");
    };
    assert!(
        decisions.is_empty(),
        "old source decisions cannot be inherited"
    );
    assert!(
        store
            .context_fact_decisions(
                &scope,
                &[ContextFactPosition {
                    block_index: 0,
                    fact_index: 0
                }]
            )
            .is_err()
    );
    let mut late = original.clone();
    late.action_id = ExecutionId::new();
    late.expected_decision_id = Some(original.action_id);
    assert!(store.decide_context_fact(&late).is_err());
    assert_eq!(store.decide_context_fact(&original).unwrap(), receipt);
    assert_eq!(
        store
            .context_fact_history(scope.project_id, scope.unit_id, &scope.locale, 0, 10)
            .unwrap()
            .rows
            .into_iter()
            .find(|row| row.request.action_id == original.action_id)
            .unwrap(),
        receipt
    );
    let path = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .context_fact_action(scope.project_id, original.action_id)
            .unwrap(),
        Some(receipt)
    );
    let saved = reopened
        .execution_input(fixed.envelope().attempt_id)
        .unwrap();
    assert_eq!(saved.bytes(), fixed.bytes());
    assert_eq!(
        body(
            &cfg,
            &ai::item_payload(&saved, saved.envelope().items[0].item_id).unwrap()
        ),
        original_body
    );
}

fn many_facts(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    let occurrence = exchange.units[0].occurrences[0].clone();
    // Group three existing equal-text occurrences into one unit. Keep the four
    // original ordered occurrences expected by the shared source fixture.
    for _ in 0..2 {
        let repeated = exchange.units.remove(1);
        assert_eq!(repeated.text, exchange.units[0].text);
        let mut extra = repeated.occurrences.into_iter().next().unwrap();
        extra.native_identity = occurrence.native_identity.clone();
        exchange.units[0].occurrences.push(extra);
    }
    let targets = vec![
        sdk::ContentTarget::Snapshot,
        sdk::ContentTarget::Unit {
            id: exchange.units[0].id.clone(),
        },
        sdk::ContentTarget::Occurrence {
            id: occurrence.id.clone(),
        },
        sdk::ContentTarget::Occurrence {
            id: exchange.units[0].occurrences[1].id.clone(),
        },
        sdk::ContentTarget::Occurrence {
            id: exchange.units[0].occurrences[2].id.clone(),
        },
    ];
    exchange.domain_blocks = targets
        .into_iter()
        .enumerate()
        .map(|(block_index, target)| sdk::DomainBlock {
            target,
            schema: sdk::source_context_facts_contract(),
            handling: sdk::ExtensionHandling::Preserve,
            payload_utf8: serde_json::to_string(&sdk::SourceContextFacts {
                facts: (0..if block_index == 4 { 1 } else { 32 })
                    .map(|fact_index| sdk::SourceContextFact {
                        id: format!("fact-{fact_index}"),
                        kind: sdk::SourceContextFactKind::Role,
                        text: format!("Observed role {block_index}.{fact_index}"),
                        origin: sdk::SourceContextFactOrigin::Inferred {
                            rationale: "Synthetic hypothesis".into(),
                            sources: vec![occurrence.source.clone()],
                        },
                    })
                    .collect(),
            })
            .unwrap(),
        })
        .collect();
    exchange
}

#[test]
fn ai_capture_limits_never_block_exact_human_reads_history_or_restoration() {
    let (_dir, mut store, rows) = support::source_fixture_with_transform(4, many_facts);
    let scope = scope(&store, &rows[0], "zh-CN");
    let view = store.source_context(&scope).unwrap();
    assert_eq!(view.occurrences.len(), 3);
    assert_eq!(view.blocks.len(), 5);
    let mut actions = Vec::new();
    for block in &view.blocks {
        for fact_index in 0..block.facts.as_ref().unwrap().facts.len() {
            let request = ContextFactWrite {
                action_id: ExecutionId::new(),
                basis: SourceFactBasis::from_view(&view, block.block_index, fact_index as u32)
                    .unwrap(),
                expected_decision_id: None,
                disposition: ContextFactDisposition::RejectInference,
                actor: "Synthetic reviewer".into(),
                reason: "Unconfirmed inference".into(),
            };
            store.decide_context_fact(&request).unwrap();
            actions.push(request);
        }
    }
    assert_eq!(actions.len(), 129);
    let position = ContextFactPosition {
        block_index: 4,
        fact_index: 0,
    };
    let last = store
        .context_fact_decisions(&scope, std::slice::from_ref(&position))
        .unwrap();
    assert_eq!(last[0].request, actions[128]);
    let first = store
        .context_fact_history(scope.project_id, scope.unit_id, &scope.locale, 0, 100)
        .unwrap();
    assert_eq!(first.rows.len(), 100);
    assert_eq!(first.next_offset, Some(100));
    let last = store
        .context_fact_history(scope.project_id, scope.unit_id, &scope.locale, 100, 100)
        .unwrap();
    assert_eq!(last.rows.len(), 29);
    assert_eq!(last.next_offset, None);
    assert_eq!(
        store
            .preview_ai(config(true, true, true), "zh-CN", &[scope.unit_id])
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    for original in &actions {
        store
            .decide_context_fact(&ContextFactWrite {
                action_id: ExecutionId::new(),
                expected_decision_id: Some(original.action_id),
                disposition: ContextFactDisposition::Restore,
                reason: "Restore original observation".into(),
                ..original.clone()
            })
            .unwrap();
    }
    let latest = store
        .context_fact_decisions(&scope, std::slice::from_ref(&position))
        .unwrap();
    assert_eq!(
        latest[0].request.disposition,
        ContextFactDisposition::Restore
    );
    assert_eq!(
        latest[0].request.expected_decision_id,
        Some(actions[128].action_id)
    );
    assert_eq!(
        store
            .context_fact_history(scope.project_id, scope.unit_id, &scope.locale, 200, 100)
            .unwrap()
            .rows
            .len(),
        58
    );
    assert_eq!(
        store
            .preview_ai(config(true, true, true), "zh-CN", &[scope.unit_id])
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    // Restoration preserves history; explicitly disabling the related sharing
    // categories is the supported preparation without this oversized capture.
    let unshared = store
        .preview_ai(config(false, false, false), "zh-CN", &[scope.unit_id])
        .unwrap();
    assert_eq!(
        unshared.items[0].project_context,
        ProjectFactCapture::NotSelected
    );
}
