//! The existing review table owns advisory model evidence. Its purpose never
//! changes the mechanical QA union or the meaning of a current CheckRun.
use super::{ProjectStore, review};
use crate::{
    CheckFinding, CheckRuleResult, ReviewBasis,
    ai::{AiConfig, semantic_review::*},
    execution::*,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::{BTreeMap, BTreeSet};
use tsumugi_plugin_sdk as sdk;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedEvidence {
    origin: AiSemanticReviewEvidence,
    diagnostics: Vec<sdk::TextReviewDiagnostic>,
}
const SCOPE_INDEX: &str = "CREATE INDEX review_check_purpose_scope ON review_checks (project_id,unit_id,locale,purpose,basis)";
const RESULT_INDEX: &str = "CREATE UNIQUE INDEX review_semantic_result ON review_checks (json_extract(evidence_json,'$.origin.attemptId'),json_extract(evidence_json,'$.origin.itemId'),json_extract(evidence_json,'$.origin.resultId')) WHERE purpose='ai-semantic'";
pub(super) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(SCOPE_INDEX)?;
    c.execute_batch(RESULT_INDEX)
}

/// Retained local references are proved independently of current selection or
/// mutable defaults. Reading an old attempt does not require its input to be current.
pub(super) fn verify_input_records(
    c: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    let preview = preview_from_input(input)?;
    let project = input.envelope().project_id.to_string();
    for item in &preview.items {
        let source = &item.source;
        let source_exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id JOIN source_snapshots s ON s.snapshot_id=o.snapshot_id JOIN source_units u ON u.unit_id=o.unit_id WHERE o.snapshot_id=?1 AND o.unit_id=?2 AND o.revision_id=?3 AND o.native_key=?4 AND r.text=?5 AND s.source_language=?6 AND s.project_id=?7 AND u.project_id=?7)",
            params![source.source_snapshot_id.to_string(),source.unit_id.to_string(),source.source_revision_id.to_string(),source.native_key,source.source_text,source.source_locale,project],|r|r.get(0)).map_err(super::ledger::sql_error)?;
        let selection_exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM translation_selections s JOIN translation_revisions r ON r.revision_id=s.revision_id WHERE s.event_id=?1 AND s.revision_id=?2 AND s.project_id=?3 AND r.project_id=?3 AND s.unit_id=?4 AND r.unit_id=?4 AND s.locale=?5 AND r.locale=?5 AND r.text=?6)",
            params![item.selection_id.to_string(),item.translation_revision_id.to_string(),project,source.unit_id.to_string(),source.target_locale,item.translation_text],|r|r.get(0)).map_err(super::ledger::sql_error)?;
        if !source_exists || !selection_exists {
            return Err(corrupt());
        }
    }
    Ok(())
}

fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn corrupt() -> ExecutionError {
    fail(ErrorCode::CorruptLedger, "ai-review-evidence")
}
fn encode<T: serde::Serialize>(value: &T) -> Result<String, ExecutionError> {
    serde_json::to_string(value).map_err(|_| corrupt())
}
fn digest<T: serde::Serialize>(value: &T) -> Result<String, ExecutionError> {
    Ok(codec::digest(&codec::encode(value, MAX_INPUT_BYTES)?))
}

fn capture_items(
    c: &Connection,
    config: &AiConfig,
    targets: &[AiSemanticReviewTarget],
) -> Result<Vec<AiSemanticReviewItem>, ExecutionError> {
    let metadata = super::read_metadata_from(c).map_err(|_| corrupt())?;
    let project = ExecutionId::parse(&metadata.project_id().to_string())?;
    let mut groups: BTreeMap<&str, Vec<ExecutionId>> = BTreeMap::new();
    for target in targets {
        groups
            .entry(&target.locale)
            .or_default()
            .push(target.unit_id);
    }
    let mut captured = BTreeMap::new();
    for (locale, units) in groups {
        let preview = super::ai::preview_ai_configs_in(c, vec![config.clone()], locale, &units)?
            .pop()
            .ok_or_else(corrupt)?;
        for source in preview.items {
            let target = review::target_in(c, project, source.unit_id, locale)?;
            if target.source_revision_id != source.source_revision_id {
                return Err(fail(ErrorCode::DependencyConflict, "ai-review-basis"));
            }
            let item = AiSemanticReviewItem {
                source,
                selection_id: target
                    .selection_id
                    .ok_or_else(|| fail(ErrorCode::DependencyConflict, "ai-review-selection"))?,
                translation_revision_id: target
                    .revision_id
                    .ok_or_else(|| fail(ErrorCode::DependencyConflict, "ai-review-selection"))?,
                translation_text: target
                    .translation_text
                    .ok_or_else(|| fail(ErrorCode::DependencyConflict, "ai-review-selection"))?,
                review_basis: target.basis_evidence,
                basis: target.basis,
            };
            captured.insert(item.target(), item);
        }
    }
    targets
        .iter()
        .map(|target| captured.remove(target).ok_or_else(corrupt))
        .collect()
}
fn current_item(
    c: &Connection,
    config: &AiConfig,
    item: &AiSemanticReviewItem,
) -> Result<bool, ExecutionError> {
    // The mutation rechecks local references, not a producer or domain format.
    // Captured source/context bodies are immutable; their exact current owners
    // are sufficient to check applicability inside the original transaction.
    let metadata = super::read_metadata_from(c).map_err(|_| corrupt())?;
    let source = &item.source;
    if metadata.source_locale().as_str() != source.source_locale
        || !metadata
            .target_locales()
            .iter()
            .any(|locale| locale.as_str() == source.target_locale)
    {
        return Ok(false);
    }
    let current:Option<(String,String,String,String)>=c.query_row("SELECT o.snapshot_id,o.revision_id,o.native_key,r.text FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id JOIN content_scope s ON s.current_snapshot=o.snapshot_id WHERE o.unit_id=?1 ORDER BY o.ordinal LIMIT 1",
        [source.unit_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(super::ledger::sql_error)?;
    let Some((snapshot, revision, key, text)) = current else {
        return Ok(false);
    };
    if revision != source.source_revision_id.to_string()
        || key != source.native_key
        || text != source.source_text
        || ((config.share_context || config.source_context.is_enabled())
            && snapshot != source.source_snapshot_id.to_string())
    {
        return Ok(false);
    }
    let selection:Option<(String,String,String)>=c.query_row("SELECT s.event_id,s.revision_id,r.text FROM translation_selections s JOIN translation_revisions r ON r.revision_id=s.revision_id WHERE s.unit_id=?1 AND s.locale=?2 ORDER BY s.sequence DESC LIMIT 1",
        params![source.unit_id.to_string(),source.target_locale],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(super::ledger::sql_error)?;
    if selection
        != Some((
            item.selection_id.to_string(),
            item.translation_revision_id.to_string(),
            item.translation_text.clone(),
        ))
    {
        return Ok(false);
    }
    let context: Option<String> = c
        .query_row(
            "SELECT revision_id FROM context_current WHERE unit_id=?1 AND locale=?2",
            params![source.unit_id.to_string(), source.target_locale],
            |r| r.get(0),
        )
        .optional()
        .map_err(super::ledger::sql_error)?;
    if context
        != item
            .review_basis
            .context_revision_id
            .map(|id| id.to_string())
    {
        return Ok(false);
    }
    let project = ExecutionId::parse(&metadata.project_id().to_string())?;
    let terms = super::resources::current_terms_in(c, project, &source.target_locale)?;
    let resolved = super::resources::resolve_terms_from(
        source.unit_id,
        &source.target_locale,
        source.source_revision_id,
        &source.source_text,
        &terms,
    );
    let mut term_ids = resolved
        .entries
        .iter()
        .flat_map(|entry| {
            entry
                .selected
                .iter()
                .chain(entry.conflicting.iter())
                .map(|term| term.revision_id)
        })
        .collect::<Vec<_>>();
    term_ids.sort();
    term_ids.dedup();
    if term_ids != item.review_basis.term_revision_ids {
        return Ok(false);
    }
    if let crate::ProjectFactCapture::Selected { decisions, .. } = &source.project_context {
        let mut statement=c.prepare("SELECT d.action_id FROM context_fact_decisions d WHERE d.unit_id=?1 AND d.locale=?2 AND d.source_snapshot_id=?3 AND NOT EXISTS (SELECT 1 FROM context_fact_decisions n WHERE n.unit_id=d.unit_id AND n.locale=d.locale AND n.source_snapshot_id=d.source_snapshot_id AND n.block_index=d.block_index AND n.fact_id=d.fact_id AND n.rowid>d.rowid) LIMIT 129").map_err(super::ledger::sql_error)?;
        let current = statement
            .query_map(
                params![
                    source.unit_id.to_string(),
                    source.target_locale,
                    source.source_snapshot_id.to_string()
                ],
                |r| r.get::<_, String>(0),
            )
            .map_err(super::ledger::sql_error)?
            .collect::<rusqlite::Result<BTreeSet<_>>>()
            .map_err(super::ledger::sql_error)?;
        if current
            != decisions
                .iter()
                .map(|decision| decision.request.action_id.to_string())
                .collect()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

impl ProjectStore {
    /// Confirm only the original durable enqueue. No currentness check,
    /// preparation, runtime initialization or renewed execution permission.
    pub fn ai_semantic_review_start_action_read(&self, project: ExecutionId,
        attempt: ExecutionId, expected_digest: &str,
    ) -> Result<Option<AiSemanticReviewStartReceipt>, ExecutionError> {
        let found=review::read_snapshot(self.connection().map_err(|_|fail(ErrorCode::StorageFailed,"ai-review-start-read"))?, |c| {
            if super::read_metadata_from(c).map_err(|_|corrupt())?.project_id().to_string()!=project.to_string() {
                return Err(fail(ErrorCode::Unauthorized,"ai-review-project"));
            }
            let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM execution_attempts WHERE attempt_id=?1)",
                [attempt.to_string()],|row|row.get(0)).map_err(super::ledger::sql_error)?;
            if !exists {return Ok(None);}
            // The strict ledger reader also verifies retained semantic input
            // references and the original task/attempt/input associations.
            let input=super::ledger::load_input(c,attempt)?;
            let preview=preview_from_input(&input)?;
            if input.envelope().project_id!=project || preview.digest!=expected_digest {
                return Err(fail(ErrorCode::ResultMismatch,"ai-review-start-request"));
            }
            Ok(Some(AiSemanticReviewStartReceipt {project_id:project,attempt_id:attempt,
                task_id:input.envelope().task_id,input_digest:input.digest().to_owned(),preview}))
        })?;
        if self.is_reconciling() {self.reconcile_execution()?;}
        Ok(found)
    }

    /// Pure preparation of one explicitly selected finite set of unit/locale
    /// pairs. Every item shares the original Task's provider budget.
    pub fn prepare_ai_semantic_review(
        &self,
        config: AiConfig,
        targets: &[AiSemanticReviewTarget],
        rules: &[AiSemanticReviewRule],
    ) -> Result<PreparedAiSemanticReview, ExecutionError> {
        config.validate()?;
        validate_rules(rules)?;
        if targets.is_empty()
            || targets.len() > config.max_items as usize
            || targets.iter().collect::<BTreeSet<_>>().len() != targets.len()
        {
            return Err(fail(ErrorCode::InvalidInput, "ai-review-pairs"));
        }
        for locale in targets.iter().map(|t| &t.locale).collect::<BTreeSet<_>>() {
            super::resources::strategy::verify_config(self, &config, locale)?;
        }
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "ai-review-prepare"))?;
        review::read_snapshot(c, |c| {
            let project = super::read_metadata_from(c)
                .map_err(|_| corrupt())?
                .project_id();
            let mut items = capture_items(c, &config, targets)?;
            items.sort_by_key(AiSemanticReviewItem::target);
            let mut rules = rules.to_vec();
            rules.sort();
            for item in &items {
                request_body(&config, &rules, item)?;
            }
            let preview = AiSemanticReviewPreview {
                digest: preview_digest(&config, &rules, &items)?,
                config: config.clone(),
                recipe: RECIPE.into(),
                rules: rules.clone(),
                items,
            };
            let input_items = preview
                .items
                .iter()
                .map(|item| {
                    Ok(InputItem::new(
                        Scope {
                            kind: "review-unit".into(),
                            id: item.source.unit_id.to_string(),
                            locale: Some(item.source.target_locale.clone()),
                        },
                        serde_json::to_value(item).map_err(|_| corrupt())?,
                        vec![],
                    ))
                })
                .collect::<Result<Vec<_>, ExecutionError>>()?;
            let mut envelope =
                InputEnvelope::new(project, OPERATION, CAPABILITY, "1", input_items)?;
            envelope.settings = serde_json::to_value(Settings {
                recipe: RECIPE.into(),
                config,
                rules,
                preview_digest: preview.digest.clone(),
            })
            .map_err(|_| corrupt())?;
            envelope.limits.timeout_ms = ((preview.config.timeout_seconds * 1000 + 6000)
                * (preview.config.max_retries + 1))
                .min(600_000);
            let input = FixedInput::capture(envelope)?;
            preview_from_input(&input)?;
            Ok(PreparedAiSemanticReview { preview, input })
        })
    }
    pub fn verify_ai_semantic_review(
        &self,
        prepared: &PreparedAiSemanticReview,
    ) -> Result<(), ExecutionError> {
        let expected = preview_from_input(prepared.input())?;
        let current = self.prepare_ai_semantic_review(
            expected.config.clone(),
            &expected
                .items
                .iter()
                .map(|i| i.target())
                .collect::<Vec<_>>(),
            &expected.rules,
        )?;
        if current.preview().digest != expected.digest {
            return Err(fail(ErrorCode::DependencyConflict, "ai-review-basis"));
        }
        Ok(())
    }
    /// Historical reading neither initializes a runtime nor reissues consent.
    pub fn read_ai_semantic_review_item(
        &self,
        attempt: ExecutionId,
        item_id: ExecutionId,
    ) -> Result<AiSemanticReviewItemView, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "ai-review-read"))?;
        review::read_snapshot(c, |c| {
            let input = super::ledger::load_input(c, attempt)?;
            let preview = preview_from_input(&input)?;
            let item = item_payload(&input, item_id)?;
            let result = self
                .execution_current_result(attempt, item_id)?
                .map(|id| super::ledger::load_result(c, &input, id))
                .transpose()?;
            let output = result
                .as_ref()
                .filter(|r| r.envelope().outcome == ExecutionState::Succeeded)
                .map(|r| validate_output(&input, r))
                .transpose()?;
            let run = result
                .as_ref()
                .map(|r| by_result(c, attempt, item_id, r.envelope().result_id))
                .transpose()?
                .flatten();
            let current = current_item(c, &preview.config, &item)?;
            Ok(AiSemanticReviewItemView {
                item_id,
                item,
                output,
                run,
                current,
            })
        })
    }
    pub fn read_ai_semantic_review(
        &self,
        project: ExecutionId,
        unit: ExecutionId,
        locale: &str,
    ) -> Result<Option<AiSemanticReviewRun>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "ai-review-read"))?;
        review::read_snapshot(c, |c| {
            let target = review::target_in(c, project, unit, locale)?;
            current_run(c, project, unit, locale, &target.basis)
        })
    }
}

fn projection(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<
    (
        AiSemanticReviewItem,
        Vec<CheckRuleResult>,
        Vec<sdk::TextReviewDiagnostic>,
        AiSemanticReviewEvidence,
    ),
    ExecutionError,
> {
    let preview = preview_from_input(input)?;
    let item = item_payload(input, result.envelope().item_id)?;
    let output = validate_output(input, result)?;
    let semantic_input_digest = semantic_digest(&preview.config, &preview.rules, &item)?;
    let scope_digest = digest(&(item.target(), &item.basis))?;
    let mut diagnostics = Vec::new();
    let mut rules = Vec::new();
    for result in &output.rules {
        let key = result.rule.key();
        let mut findings = Vec::new();
        for finding in &result.findings {
            let code = format!("ai-{}", &digest(finding)?[..32]);
            let issue_id = digest(&(
                "ai-semantic-finding-1",
                &key,
                &semantic_input_digest,
                &scope_digest,
                finding,
            ))?;
            findings.push(CheckFinding {
                issue_id,
                rule: key.rule.id.clone(),
                code: code.clone(),
                detail: finding.detail.clone(),
                severity: match finding.severity {
                    sdk::FindingSeverity::Error => "error",
                    sdk::FindingSeverity::Warning => "warning",
                }
                .into(),
                waivable: false,
            });
            diagnostics.push(sdk::TextReviewDiagnostic {
                key: key.clone(),
                code,
                target: item.source.unit_id.to_string(),
                location: finding.location.clone(),
                detail: Some(finding.detail.clone()),
                suggestion: finding.suggestion.clone(),
                resource_entry: None,
            });
        }
        rules.push(CheckRuleResult {
            rule: key.rule.id.clone(),
            key,
            mandatory: false,
            status: if findings.is_empty() {
                "passed"
            } else {
                "findings"
            }
            .into(),
            reason: None,
            findings,
        });
    }
    let evidence = AiSemanticReviewEvidence {
        endpoint: preview.config.endpoint,
        model: preview.config.model,
        recipe: RECIPE.into(),
        attempt_id: input.envelope().attempt_id,
        item_id: result.envelope().item_id,
        input_digest: input.digest().into(),
        result_id: result.envelope().result_id,
        result_digest: result.digest().into(),
        semantic_input_digest,
        scope_digest,
    };
    Ok((item, rules, diagnostics, evidence))
}

impl AdoptionHandler for AiSemanticReviewAdoptionHandler {
    fn operation(&self) -> &str {
        OPERATION
    }
    fn prepare(
        &self,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<PreparedMutation, ExecutionError> {
        if results.len() != 1 {
            return Err(fail(ErrorCode::ResultMismatch, "ai-review-adoption"));
        }
        action.validate(input, results)?;
        if !action.parameters.is_null() {
            return Err(fail(ErrorCode::InvalidInput, "ai-review-adoption"));
        }
        let (item, rules, diagnostics, evidence) = projection(input, &results[0])?;
        let preview = preview_from_input(input)?;
        let request_digest = action.request_digest(input)?;
        let action = action.clone();
        Ok(Box::new(move |tx| {
            let c = tx.connection();
            if !current_item(c, &preview.config, &item)? {
                return Err(fail(ErrorCode::DependencyConflict, "ai-review-basis"));
            }
            let project = super::read_metadata_from(c)
                .map_err(|_| corrupt())?
                .project_id();
            if project.to_string() != action.project_id.to_string() {
                return Err(fail(ErrorCode::Unauthorized, "ai-review-project"));
            }
            let id = ExecutionId::new();
            tx.execute("INSERT INTO review_checks (run_id,action_id,project_id,unit_id,locale,basis,basis_json,validator_version,rules_json,qa_basis,evidence_json,request_digest,purpose) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,?10,?11,'ai-semantic')",
                params![id.to_string(),action.action_id.to_string(),action.project_id.to_string(),item.source.unit_id.to_string(),item.source.target_locale,
                    item.basis,encode(&item.review_basis)?,RECIPE,encode(&rules)?,encode(&SavedEvidence { origin:evidence,diagnostics })?,request_digest])?;
            Ok(vec![ChangeReference {
                kind: "review".into(),
                id: id.to_string(),
                revision: Revision::new(1)?,
            }])
        }))
    }
}

pub(super) fn by_action(
    c: &Connection,
    project: ExecutionId,
    action: ExecutionId,
) -> Result<Option<AiSemanticReviewRun>, ExecutionError> {
    let row = c.query_row("SELECT run_id,unit_id,locale,basis,basis_json,validator_version,rules_json,evidence_json,request_digest,created_at,qa_basis FROM review_checks WHERE project_id=?1 AND action_id=?2 AND purpose='ai-semantic'",
        params![project.to_string(),action.to_string()], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,String>(8)?,row.get::<_,String>(9)?,row.get::<_,Option<String>>(10)?)))
        .optional().map_err(super::ledger::sql_error)?;
    row.map(
        |(
            run,
            unit,
            locale,
            basis,
            basis_json,
            version,
            rules_json,
            evidence_json,
            request_digest,
            created_at,
            qa_basis,
        )| {
            let SavedEvidence {
                origin: saved,
                diagnostics,
            } = serde_json::from_str(&evidence_json).map_err(|_| corrupt())?;
            let input = super::ledger::load_input(c, saved.attempt_id)?;
            let result = super::ledger::load_result(c, &input, saved.result_id)?;
            let (item, rules, actual_diagnostics, evidence) = projection(&input, &result)?;
            let basis_evidence: ReviewBasis =
                serde_json::from_str(&basis_json).map_err(|_| corrupt())?;
            let stored_rules: Vec<CheckRuleResult> =
                serde_json::from_str(&rules_json).map_err(|_| corrupt())?;
            if qa_basis.is_some()
                || version != RECIPE
                || saved != evidence
                || diagnostics != actual_diagnostics
                || stored_rules != rules
                || input.envelope().project_id != project
                || item.source.unit_id.to_string() != unit
                || item.source.target_locale != locale
                || item.basis != basis
                || item.review_basis != basis_evidence
                || sdk::validate_package_digest(&request_digest).is_err()
            {
                return Err(corrupt());
            }
            // The durable adoption is the authority for this row, not self-reported
            // origin JSON. Its exact original action must point to this result.
            let receipt = super::ledger::read_receipt(c, action)?.ok_or_else(corrupt)?;
            let (action_bytes, action_digest): (Vec<u8>, String) = c
                .query_row(
                    "SELECT request,digest FROM execution_actions WHERE action_id=?1",
                    [action.to_string()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(super::ledger::sql_error)?;
            let request: AdoptionAction = codec::decode(&action_bytes, MAX_INPUT_BYTES)?;
            request
                .validate(&input, std::slice::from_ref(&result))
                .map_err(|_| corrupt())?;
            if request.action_id != action
                || !request.parameters.is_null()
                || request.request_digest(&input)? != request_digest
                || action_digest != request_digest
                || receipt.request_digest != request_digest
                || receipt.project_id != project
                || receipt.attempt_id != saved.attempt_id
                || receipt.unit_id != request.unit_id
                || receipt.changes
                    != vec![ChangeReference {
                        kind: "review".into(),
                        id: run.clone(),
                        revision: Revision::new(1)?,
                    }]
            {
                return Err(corrupt());
            }
            Ok(AiSemanticReviewRun {
                purpose: ReviewRunPurpose::AiSemantic,
                run_id: ExecutionId::parse(&run)?,
                action_id: action,
                unit_id: item.source.unit_id,
                locale,
                basis,
                basis_evidence,
                validator_version: version,
                rules,
                diagnostics,
                evidence,
                created_at,
            })
        },
    )
    .transpose()
}
fn by_result(
    c: &Connection,
    attempt: ExecutionId,
    item: ExecutionId,
    result: ExecutionId,
) -> Result<Option<AiSemanticReviewRun>, ExecutionError> {
    let identities = c.prepare("SELECT project_id,action_id FROM review_checks WHERE purpose='ai-semantic' AND json_extract(evidence_json,'$.origin.attemptId')=?1 AND json_extract(evidence_json,'$.origin.itemId')=?2 AND json_extract(evidence_json,'$.origin.resultId')=?3 LIMIT 2")
        .map_err(super::ledger::sql_error)?.query_map(params![attempt.to_string(),item.to_string(),result.to_string()], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))
        .map_err(super::ledger::sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(super::ledger::sql_error)?;
    let mut selected = None;
    for (project, action) in identities {
        let run = by_action(
            c,
            ExecutionId::parse(&project)?,
            ExecutionId::parse(&action)?,
        )?
        .ok_or_else(corrupt)?;
        if (
            run.evidence.attempt_id,
            run.evidence.item_id,
            run.evidence.result_id,
        ) == (attempt, item, result)
        {
            if selected.replace(run).is_some() {
                return Err(corrupt());
            }
        }
    }
    Ok(selected)
}
pub(super) fn current_run(
    c: &Connection,
    project: ExecutionId,
    unit: ExecutionId,
    locale: &str,
    basis: &str,
) -> Result<Option<AiSemanticReviewRun>, ExecutionError> {
    let action: Option<String> = c.query_row("SELECT action_id FROM review_checks WHERE purpose='ai-semantic' AND project_id=?1 AND unit_id=?2 AND locale=?3 AND basis=?4 ORDER BY rowid DESC LIMIT 1",
        params![project.to_string(),unit.to_string(),locale,basis], |r| r.get(0)).optional().map_err(super::ledger::sql_error)?;
    let run = action
        .map(|id| by_action(c, project, ExecutionId::parse(&id)?))
        .transpose()?
        .flatten();
    let Some(run) = run else {
        return Ok(None);
    };
    let input = super::ledger::load_input(c, run.evidence.attempt_id)?;
    let preview = preview_from_input(&input)?;
    let item = item_payload(&input, run.evidence.item_id)?;
    Ok(current_item(c, &preview.config, &item)?.then_some(run))
}
pub(super) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    for (name, expected) in [
        ("review_check_purpose_scope", SCOPE_INDEX),
        ("review_semantic_result", RESULT_INDEX),
    ] {
        let actual: String = c
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(super::ledger::sql_error)?;
        if actual != expected {
            return Err(corrupt());
        }
    }
    let mut statement = c
        .prepare("SELECT project_id,action_id FROM review_checks WHERE purpose='ai-semantic'")
        .map_err(super::ledger::sql_error)?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(super::ledger::sql_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(super::ledger::sql_error)?;
    for (project, action) in rows {
        by_action(
            c,
            ExecutionId::parse(&project)?,
            ExecutionId::parse(&action)?,
        )?
        .ok_or_else(corrupt)?;
    }
    Ok(())
}


#[cfg(test)]
mod start_read_tests {
    use super::*;
    use crate::persistence::review::tests::{fixture,translate,adopt_source};

    #[test]
    fn semantic_start_read_confirms_original_input_without_current_authority_or_runtime() {
        let (directory,mut store,project,units)=fixture();let unit=units[0];
        translate(&mut store,project,unit,"zh-CN","Saved original translation");
        let config=AiConfig {endpoint:"https://model.example/v1/chat/completions".into(),model:"synthetic-review".into(),credential_env:String::new(),..Default::default()};
        let prepared=store.prepare_ai_semantic_review(config,&[AiSemanticReviewTarget {unit_id:unit,locale:"zh-CN".into()}],&[AiSemanticReviewRule::Meaning,AiSemanticReviewRule::Style]).unwrap();
        let input=prepared.input();let attempt=input.envelope().attempt_id;let original=&prepared.preview().digest;
        store.execution_unknown.store(true,std::sync::atomic::Ordering::Release);
        assert_eq!(store.ai_semantic_review_start_action_read(project,attempt,original).unwrap(),None);assert!(!store.is_reconciling());
        store.enqueue_execution(input).unwrap();
        let expected=AiSemanticReviewStartReceipt {project_id:project,attempt_id:attempt,task_id:input.envelope().task_id,
            input_digest:input.digest().into(),preview:prepared.preview().clone()};
        assert_eq!(store.ai_semantic_review_start_action_read(project,attempt,original).unwrap(),Some(expected.clone()));
        for (owner,proof) in [(project,"0".repeat(64)),(ExecutionId::new(),original.clone())] {
            store.execution_unknown.store(true,std::sync::atomic::Ordering::Release);
            assert!(store.ai_semantic_review_start_action_read(owner,attempt,&proof).is_err());assert!(store.is_reconciling());
        }
        let c=store.connection().unwrap();
        c.execute("UPDATE execution_attempts SET digest=?2 WHERE attempt_id=?1",params![attempt.to_string(),"0".repeat(64)]).unwrap();
        assert!(store.ai_semantic_review_start_action_read(project,attempt,original).is_err());assert!(store.is_reconciling());
        c.execute("UPDATE execution_attempts SET digest=?2 WHERE attempt_id=?1",params![attempt.to_string(),input.digest()]).unwrap();
        let source_attempt:String=c.query_row("SELECT attempt_id FROM source_snapshots LIMIT 1",[],|row|row.get(0)).unwrap();
        assert!(store.ai_semantic_review_start_action_read(project,ExecutionId::parse(&source_attempt).unwrap(),original).is_err());assert!(store.is_reconciling());
        assert_eq!(store.ai_semantic_review_start_action_read(project,attempt,original).unwrap(),Some(expected.clone()));assert!(!store.is_reconciling());
        translate(&mut store,project,unit,"zh-CN","Newer selected translation");
        adopt_source(&mut store,br#"{"replacement":"Changed source"}"#);
        let revision=store.metadata().unwrap().metadata_revision();store.set_target_locales(revision,&["ja".into()]).unwrap();
        let sequence=store.execution_sequence().unwrap();
        assert_eq!(store.ai_semantic_review_start_action_read(project,attempt,original).unwrap(),Some(expected.clone()));assert_eq!(store.execution_sequence().unwrap(),sequence);
        store.close().unwrap();let reopened=ProjectStore::open(directory.path().join("project")).unwrap();
        assert_eq!(reopened.ai_semantic_review_start_action_read(project,attempt,original).unwrap(),Some(expected));
    }
}
