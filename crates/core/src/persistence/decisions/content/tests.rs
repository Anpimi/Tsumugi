use super::*;
use crate::application::{AuthorizeWorkPlan, PlanOptions};
use crate::execution::{AdoptionHandler, AdoptionReceipt, ExecutionState, FixedInput, FixedResult, ResultEnvelope};
use crate::persistence::review::tests::{approve, fixture, translate};
use crate::{CandidateDecisionWrite, CandidateDisposition, CaptureCorrectionTerm, GlossaryEntry, GlossaryFile,
    ResourceDecision, ResourceDecisionKind, ReviewFindingWrite};

fn read(store: &ProjectStore, project: ExecutionId, source: DecisionSource) -> SourceProjection {
    let c = store.connection().unwrap();
    review::read_snapshot(c, |c| super::project(store, c, project, "zh-CN", source)).unwrap()
}

/// Save an original typed synthetic result through the normal ledger and
/// adoption owners. No Runner, Provider transport or external data is used.
fn adopt_output(store: &mut ProjectStore, input: &FixedInput, capability: &str,
    output: serde_json::Value, handler: &dyn AdoptionHandler) -> AdoptionReceipt {
    store.enqueue_execution(input).unwrap();
    let item = input.envelope().items[0].item_id;
    let dispatch = store.dispatch_execution_item(input.envelope().attempt_id, item).unwrap();
    let result = FixedResult::capture(ResultEnvelope {
        plugin: None, project_id: input.envelope().project_id,
        attempt_id: input.envelope().attempt_id, item_id: item, result_id: ExecutionId::new(),
        supersedes: None, dispatch_token: dispatch.dispatch_token,
        capability_id: capability.into(), capability_version: "1".into(),
        outcome: ExecutionState::Succeeded, output: Some(output), diagnostic: None,
    }, input, dispatch.dispatch_token).unwrap();
    store.save_execution_result(&result).unwrap();
    store.validate_execution_result(input.envelope().attempt_id, result.envelope().result_id).unwrap();
    let action = store.prepare_adoption(input.envelope().attempt_id, input.envelope().units[0].unit_id,
        vec![result.envelope().result_id], serde_json::Value::Null).unwrap();
    store.adopt_execution(&action, handler).unwrap()
}

fn config() -> crate::ai::AiConfig {
    crate::ai::AiConfig { endpoint: "https://example.invalid/v1/chat/completions".into(),
        model: "synthetic-decision-projection".into(), credential_env: String::new(),
        ..crate::ai::AiConfig::default() }
}

fn candidate(store: &mut ProjectStore, unit: ExecutionId) -> ExecutionId {
    let plan = store.prepare_work_plan(Some(config()), "zh-CN", &[unit], PlanOptions::default()).unwrap();
    let expires_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 600;
    let grant = store.authorize_work_plan(&plan, &AuthorizeWorkPlan { action_id: ExecutionId::new(),
        plan_digest: plan.digest.clone(), confirmed: true, effects: plan.options.authorization_effects().unwrap(), expires_at }).unwrap();
    let input = FixedInput::capture(grant.input.unwrap()).unwrap();
    let receipt = adopt_output(store, &input, crate::ai::CAPABILITY,
        serde_json::to_value(crate::ai::AiOutput { unit_id: unit, target_locale: "zh-CN".into(),
            text: "Synthetic candidate".into(), usage: None, requests: 1, usage_incomplete: true }).unwrap(),
        &crate::AiAdoptionHandler);
    ExecutionId::parse(&receipt.changes[0].id).unwrap()
}

#[test]
fn candidate_rejection_and_restoration_recompute_the_same_original_identity() {
    let (_directory, mut store, project, units) = fixture();
    let revision_id = candidate(&mut store, units[0]);
    let pending = read(&store, project, DecisionSource::TranslationCandidate);
    assert!(pending.complete);
    assert_eq!(pending.items.len(), 1);
    assert_eq!(pending.items[0].targets, vec![DecisionTarget::Entry { unit_id: units[0] }]);
    let target = store.review_target(project, units[0], "zh-CN").unwrap();
    let mut request = CandidateDecisionWrite { project_id: project, action_id: ExecutionId::new(),
        unit_id: units[0], locale: "zh-CN".into(), revision_id, source_revision_id: target.source_revision_id,
        expected_selection_id: target.selection_id, expected_decision_id: None,
        disposition: CandidateDisposition::Rejected, actor: "Synthetic reviewer".into(), reason: "Different wording".into() };
    let rejected = store.decide_translation_candidate(&request).unwrap();
    assert!(read(&store, project, DecisionSource::TranslationCandidate).items.is_empty());
    translate(&mut store, project, units[1], "zh-CN", "An unrelated saved edit");
    assert!(read(&store, project, DecisionSource::TranslationCandidate).items.is_empty());
    request.action_id = ExecutionId::new();
    request.expected_decision_id = Some(rejected.request.action_id);
    request.disposition = CandidateDisposition::Restored;
    store.decide_translation_candidate(&request).unwrap();
    let restored = read(&store, project, DecisionSource::TranslationCandidate);
    assert_eq!(restored.items.len(), 1);
    assert_eq!(restored.items[0].decision_id, pending.items[0].decision_id);
    assert_ne!(restored.items[0].basis, pending.items[0].basis);
}

#[test]
fn human_review_requires_a_selected_translation_and_current_approval_resolves_it() {
    let (_directory, mut store, project, units) = fixture();
    assert!(read(&store, project, DecisionSource::HumanReview).items.is_empty());
    translate(&mut store, project, units[0], "zh-CN", "Synthetic translation");
    let pending = read(&store, project, DecisionSource::HumanReview);
    assert_eq!(pending.items.len(), 1);
    approve(&mut store, project, units[0], "zh-CN");
    assert!(read(&store, project, DecisionSource::HumanReview).items.is_empty());
    translate(&mut store, project, units[0], "zh-CN", "A new saved revision");
    let changed = read(&store, project, DecisionSource::HumanReview);
    assert_eq!(changed.items[0].decision_id, pending.items[0].decision_id);
    assert_ne!(changed.items[0].basis, pending.items[0].basis);
}

#[test]
fn resource_keep_ignore_and_stale_correction_use_original_receipts_after_reopen() {
    let (_directory, mut store, project, units) = fixture();
    let file = GlossaryFile { format: "tsumugi-glossary-v1".into(), resource_id: "synthetic".into(),
        revision: "one".into(), license: "Synthetic fixture".into(), source_locale: "en".into(), target_locale: "zh-CN".into(),
        entries: ["first", "second"].into_iter().map(|id| GlossaryEntry { id: id.into(), source: "Hello".into(),
            aliases: vec![], target: "Synthetic term".into(), protected: false, native_key: None, reason: "Synthetic proposal".into() }).collect() };
    let capture = store.capture_glossary(project, ExecutionId::new(), &serde_json::to_vec(&file).unwrap()).unwrap();
    assert_eq!(read(&store, project, DecisionSource::ResourceProposal).items.len(), 2);
    for (entry, decision) in [("first", ResourceDecisionKind::Keep), ("second", ResourceDecisionKind::Ignore)] {
        store.decide_glossary_entry(&ResourceDecision { project_id: project, action_id: ExecutionId::new(),
            capture_id: capture.capture_id, entry_id: entry.into(), expected_revision_id: None, decision }).unwrap();
    }
    assert!(read(&store, project, DecisionSource::ResourceProposal).items.is_empty());
    // Keep/Ignore do not change the preview diff; their saved facts still resolve it.
    assert!(store.glossary_preview(project, capture.capture_id).unwrap().rows.iter().all(|row| row.current.is_none()));
    translate(&mut store, project, units[0], "zh-CN", "Earlier translation");
    translate(&mut store, project, units[0], "zh-CN", "Preferred translation");
    let target = store.review_target(project, units[0], "zh-CN").unwrap();
    let evidence = store.correction_term_basis(project, units[0], "zh-CN", target.selection_id.unwrap()).unwrap();
    let correction = store.capture_correction_term(&CaptureCorrectionTerm { action_id: ExecutionId::new(),
        basis: evidence.basis, source: evidence.source_text, target: "Preferred".into(), protected: false,
        reason: "Local terminology proposal".into() }).unwrap();
    assert_eq!(read(&store, project, DecisionSource::ResourceProposal).items[0].state, DecisionState::Pending);
    translate(&mut store, project, units[0], "zh-CN", "A newer translation");
    let stale = read(&store, project, DecisionSource::ResourceProposal);
    assert_eq!(stale.items.len(), 1);
    assert_eq!(stale.items[0].state, DecisionState::Stale);
    assert!(stale.items[0].targets.contains(&DecisionTarget::Resource { capture_id: correction.capture.capture_id, entry_id: "term".into() }));
    let path = store.directory().to_path_buf();
    drop(store);
    let mut store = ProjectStore::open(&path).unwrap();
    assert_eq!(read(&store, project, DecisionSource::ResourceProposal).items, stale.items);
    store.decide_glossary_entry(&ResourceDecision { project_id: project, action_id: ExecutionId::new(),
        capture_id: correction.capture.capture_id, entry_id: "term".into(), expected_revision_id: None, decision: ResourceDecisionKind::Ignore }).unwrap();
    assert!(read(&store, project, DecisionSource::ResourceProposal).items.is_empty());
}

#[test]
fn advisory_rejection_resolves_and_repair_waits_for_the_original_recheck() {
    use crate::ai::semantic_review::*;
    let (_directory, mut store, project, units) = fixture();
    translate(&mut store, project, units[0], "zh-CN", "Synthetic translation");
    let prepared = store.prepare_ai_semantic_review(config(), &[AiSemanticReviewTarget {
        unit_id: units[0], locale: "zh-CN".into() }], &[AiSemanticReviewRule::Meaning]).unwrap();
    adopt_output(&mut store, prepared.input(), CAPABILITY, serde_json::to_value(AiSemanticReviewOutput {
        unit_id: units[0], target_locale: "zh-CN".into(), rules: vec![AiSemanticReviewRuleResult {
            rule: AiSemanticReviewRule::Meaning, findings: vec![AiSemanticReviewFinding { code: "semantic-concern".into(),
                detail: "A synthetic advisory concern".into(), severity: tsumugi_plugin_sdk::FindingSeverity::Warning,
                location: None, suggestion: None }] }], usage: None, requests: 1, usage_incomplete: true }).unwrap(),
        &AiSemanticReviewAdoptionHandler);
    let view = store.review_findings(project, units[0], "zh-CN", 0, 10).unwrap();
    let finding = &view.findings[0];
    let pending = read(&store, project, DecisionSource::ReviewFinding);
    assert_eq!(pending.items.len(), 1);
    let mut request = ReviewFindingWrite { project_id: project, action_id: ExecutionId::new(), unit_id: units[0],
        locale: "zh-CN".into(), expected_basis: view.basis, run_id: finding.run_id,
        issue_id: finding.finding.issue_id.clone(), expected_decision_id: None,
        disposition: ReviewFindingDisposition::Rejected, actor: "Synthetic reviewer".into(), reason: "Known exception".into() };
    let rejected = store.write_review_finding(&request).unwrap();
    assert!(read(&store, project, DecisionSource::ReviewFinding).items.is_empty());
    request.action_id = ExecutionId::new();
    request.expected_decision_id = Some(rejected.decision_id);
    request.disposition = ReviewFindingDisposition::Restored;
    let restored = store.write_review_finding(&request).unwrap();
    request.action_id = ExecutionId::new();
    request.expected_decision_id = Some(restored.decision_id);
    request.disposition = ReviewFindingDisposition::RepairRequested;
    store.write_review_finding(&request).unwrap();
    let repair = read(&store, project, DecisionSource::ReviewFinding);
    assert_eq!(repair.items.len(), 1);
    assert_eq!(repair.items[0].decision_id, pending.items[0].decision_id);
    assert_eq!(repair.items[0].state, DecisionState::AwaitingRecheck);
}
