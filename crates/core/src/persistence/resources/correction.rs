//! Explicit, project-local terminology proposals from immutable manual corrections.
use super::*;

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionSelectionRef {
    pub revision_id: ExecutionId,
    pub selection_id: ExecutionId,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorrectionTermBasis {
    pub project_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub before: RevisionSelectionRef,
    pub after: RevisionSelectionRef,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorrectionTermEvidence {
    pub basis: CorrectionTermBasis,
    pub source_text: String,
    pub before_text: String,
    pub after_text: String,
    pub before_source_snapshot_id: ExecutionId,
    pub before_source_revision_id: ExecutionId,
    pub current: bool,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureCorrectionTerm {
    pub action_id: ExecutionId,
    pub basis: CorrectionTermBasis,
    pub source: String,
    pub target: String,
    pub protected: bool,
    pub reason: String,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorrectionTermReceipt {
    pub request: CaptureCorrectionTerm,
    pub capture: GlossaryCapture,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GlossaryCaptureOrigin {
    File {
        resource_id: String,
        revision: String,
        license: String,
    },
    Correction {
        basis: CorrectionTermBasis,
    },
    Mcp {
        provenance: crate::application::McpTermProvenance,
    },
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorrectionTermPreview {
    pub evidence: CorrectionTermEvidence,
    #[serde(deserialize_with = "required_decision")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "decision_schema"))]
    pub decision: Option<ResourceDecisionResult>,
}

fn required_decision<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ResourceDecisionResult>, D::Error> {
    Option::deserialize(deserializer)
}

#[cfg(feature = "wire-schema")]
fn decision_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<ResourceDecisionResult> as schemars::JsonSchema>::json_schema(generator)
}

#[cfg(feature = "wire-schema")]
pub(super) fn preview_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<CorrectionTermPreview> as schemars::JsonSchema>::json_schema(generator)
}

pub(super) fn required_preview<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<CorrectionTermPreview>, D::Error> {
    Option::deserialize(deserializer)
}

pub(super) enum CapturedGlossary {
    File(GlossaryFile),
    Correction(CaptureCorrectionTerm),
    Mcp(super::mcp::CapturedMcpTerms),
}

fn historic_source(
    c: &Connection,
    project: ExecutionId,
    unit: ExecutionId,
    snapshot: ExecutionId,
    revision: ExecutionId,
) -> Result<String, ExecutionError> {
    c.query_row(
        "SELECT r.text FROM source_occurrences o JOIN source_units u ON u.unit_id=o.unit_id
         JOIN source_revisions r ON r.unit_id=o.unit_id AND r.revision_id=o.revision_id
         WHERE u.project_id=?1 AND o.unit_id=?2 AND o.snapshot_id=?3 AND o.revision_id=?4
         ORDER BY o.ordinal LIMIT 1",
        params![
            project.to_string(),
            unit.to_string(),
            snapshot.to_string(),
            revision.to_string()
        ],
        |r| r.get(0),
    )
    .optional()
    .map_err(sql)?
    .ok_or_else(|| failure(ErrorCode::DependencyConflict, "correction-source"))
}

pub(super) fn evidence_in(
    c: &Connection,
    project: ExecutionId,
    unit: ExecutionId,
    locale: &str,
    after: ExecutionId,
) -> Result<CorrectionTermEvidence, ExecutionError> {
    let canonical = crate::Locale::parse(locale)
        .map_err(|_| failure(ErrorCode::InvalidInput, "correction-locale"))?;
    if canonical.as_str() != locale {
        return Err(failure(ErrorCode::InvalidInput, "correction-locale"));
    }
    // A later selection of an old manual revision is not the original correction save.
    let row = c
        .query_row(
            "SELECT r.revision_id,r.source_snapshot_id,r.source_revision_id,r.text,
                p.event_id,b.revision_id,b.source_snapshot_id,b.source_revision_id,b.text
         FROM translation_selections s JOIN translation_revisions r ON r.revision_id=s.revision_id
         JOIN translation_selections p ON p.event_id=s.previous_event_id
         JOIN translation_revisions b ON b.revision_id=p.revision_id
         WHERE s.event_id=?1 AND s.project_id=?2 AND s.unit_id=?3 AND s.locale=?4
           AND r.project_id=s.project_id AND r.unit_id=s.unit_id AND r.locale=s.locale
           AND r.origin_kind='manual' AND r.action_id=s.action_id
           AND p.project_id=s.project_id AND p.unit_id=s.unit_id AND p.locale=s.locale
           AND p.sequence+1=s.sequence
           AND b.project_id=p.project_id AND b.unit_id=p.unit_id AND b.locale=p.locale",
            params![
                after.to_string(),
                project.to_string(),
                unit.to_string(),
                locale
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .map_err(sql)?
        .ok_or_else(|| failure(ErrorCode::DependencyConflict, "correction-selection"))?;
    let (
        after_revision,
        snapshot,
        revision,
        after_text,
        before_selection,
        before_revision,
        before_snapshot,
        before_source_revision,
        before_text,
    ) = row;
    if after_text == before_text {
        return Err(failure(ErrorCode::InvalidInput, "correction-unchanged"));
    }
    let basis = CorrectionTermBasis {
        project_id: project,
        unit_id: unit,
        locale: locale.into(),
        source_snapshot_id: id(snapshot)?,
        source_revision_id: id(revision)?,
        before: RevisionSelectionRef {
            revision_id: id(before_revision)?,
            selection_id: id(before_selection)?,
        },
        after: RevisionSelectionRef {
            revision_id: id(after_revision)?,
            selection_id: after,
        },
    };
    let before_source_snapshot_id = id(before_snapshot)?;
    let before_source_revision_id = id(before_source_revision)?;
    let source_text = historic_source(
        c,
        project,
        unit,
        basis.source_snapshot_id,
        basis.source_revision_id,
    )?;
    historic_source(
        c,
        project,
        unit,
        before_source_snapshot_id,
        before_source_revision_id,
    )?;
    let source_current:bool=c.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_occurrences o JOIN content_scope s ON s.current_snapshot=o.snapshot_id
          WHERE o.unit_id=?1 AND o.snapshot_id=?2 AND o.revision_id=?3
            AND o.ordinal=(SELECT MIN(anchor.ordinal) FROM source_occurrences anchor WHERE anchor.unit_id=o.unit_id AND anchor.snapshot_id=o.snapshot_id))",
        params![unit.to_string(),basis.source_snapshot_id.to_string(),basis.source_revision_id.to_string()],|r|r.get(0)).map_err(sql)?;
    let metadata = super::super::read_metadata_from(c)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "correction-project"))?;
    let current = source_current
        && metadata
            .target_locales()
            .iter()
            .any(|l| l.as_str() == locale)
        && super::super::translation::current_selection(c, unit, locale)?
            .is_some_and(|s| s.event_id == after);
    Ok(CorrectionTermEvidence {
        basis,
        source_text,
        before_text,
        after_text,
        before_source_snapshot_id,
        before_source_revision_id,
        current,
    })
}

pub(super) fn validate_request(
    c: &Connection,
    request: &CaptureCorrectionTerm,
) -> Result<CorrectionTermEvidence, ExecutionError> {
    for text in [&request.source, &request.target, &request.reason] {
        validate_text(text, false)?;
    }
    let b = &request.basis;
    let evidence = evidence_in(c, b.project_id, b.unit_id, &b.locale, b.after.selection_id)?;
    if &evidence.basis != b
        || !evidence.source_text.contains(&request.source)
        || !evidence.after_text.contains(&request.target)
    {
        return Err(failure(ErrorCode::DependencyConflict, "correction-basis"));
    }
    Ok(evidence)
}

pub(super) fn entry(request: &CaptureCorrectionTerm) -> GlossaryEntry {
    GlossaryEntry {
        id: "term".into(),
        source: request.source.clone(),
        target: request.target.clone(),
        aliases: Vec::new(),
        protected: request.protected,
        native_key: None,
        reason: request.reason.clone(),
    }
}

fn capture_action_in(
    c: &Connection,
    project: ExecutionId,
    action: ExecutionId,
) -> Result<Option<CorrectionTermReceipt>, ExecutionError> {
    let found:Option<(String,String)>=c.query_row(
        "SELECT capture_id,capture_kind FROM resource_captures WHERE project_id=?1 AND action_id=?2",
        params![project.to_string(),action.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
    let Some((capture_id, kind)) = found else {
        return Ok(None);
    };
    if kind != "correction" {
        return Err(failure(ErrorCode::ResultMismatch, "resource-action"));
    }
    let (capture, data) = capture_by_id(c, project, id(capture_id)?)?;
    let CapturedGlossary::Correction(request) = data else {
        return Err(failure(ErrorCode::CorruptLedger, "correction-capture"));
    };
    Ok(Some(CorrectionTermReceipt { request, capture }))
}

fn proposal_key(request: &CaptureCorrectionTerm) -> Result<String, ExecutionError> {
    digest(&(&request.basis, &request.source, &request.target))
}

pub(super) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    let corrupt = || failure(ErrorCode::CorruptLedger, "correction-links");
    let mut statement = c
        .prepare("SELECT project_id,action_id FROM resource_decisions ORDER BY rowid")
        .map_err(sql)?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(sql)?;
    for row in rows {
        let (project, action) = row.map_err(sql)?;
        let project = id(project)?;
        let action = id(action)?;
        let receipt = decision_action_in(c, project, action)?.ok_or_else(corrupt)?;
        let request = &receipt.request;
        let kind: String = c
            .query_row(
                "SELECT capture_kind FROM resource_captures WHERE project_id=?1 AND capture_id=?2",
                params![project.to_string(), request.capture_id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if kind == "correction" {
            let (_, CapturedGlossary::Correction(capture)) =
                capture_by_id(c, project, request.capture_id)?
            else {
                return Err(corrupt());
            };
            if request.entry_id != "term" {
                return Err(corrupt());
            }
            if let Some(expected) = request.expected_revision_id {
                let prior = term_by_revision(c, project, expected)?.ok_or_else(corrupt)?;
                if prior.term_id != request.capture_id.to_string() {
                    return Err(corrupt());
                }
            }
            if matches!(
                request.decision,
                ResourceDecisionKind::Keep | ResourceDecisionKind::Ignore
            ) {
                if receipt.revision.as_ref().map(|r| r.revision_id) != request.expected_revision_id
                {
                    return Err(corrupt());
                }
            } else {
                let r = receipt.revision.ok_or_else(corrupt)?;
                let exact_action:bool=c.query_row("SELECT action_id=?2 AND request_digest=?3 FROM term_revisions WHERE revision_id=?1",
                    params![r.revision_id.to_string(),action.to_string(),digest(request)?],|r|r.get(0)).map_err(sql)?;
                if request.decision != ResourceDecisionKind::Adopt
                    || request.expected_revision_id.is_some()
                    || !exact_action
                    || r.previous_revision_id.is_some()
                    || r.origin_kind != TermOrigin::Manual
                    || r.term_id != request.capture_id.to_string()
                    || r.capture_id != Some(request.capture_id)
                    || r.external_entry_id.is_some()
                    || r.locale != capture.basis.locale
                    || r.scope_unit_id != Some(capture.basis.unit_id)
                    || r.source != capture.source
                    || r.target != capture.target
                    || r.protected != capture.protected
                    || r.reason != capture.reason
                    || !r.aliases.is_empty()
                    || r.removed
                {
                    return Err(corrupt());
                }
            }
        }
    }
    let mut statement=c.prepare("SELECT r.revision_id,r.project_id,r.origin_kind,r.capture_id,c.capture_kind FROM term_revisions r JOIN resource_captures c ON c.capture_id=r.capture_id").map_err(sql)?;
    for row in statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(sql)?
    {
        let (revision, project, origin, capture, kind) = row.map_err(sql)?;
        if (origin == "manual") != (kind == "correction") {
            return Err(corrupt());
        }
        if kind == "correction" {
            let linked:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM resource_decisions d JOIN resource_captures c ON c.capture_id=d.capture_id WHERE d.result_revision_id=?1 AND d.project_id=?2 AND c.project_id=d.project_id AND d.capture_id=?3 AND d.decision='adopt')",params![revision,project,capture],|r|r.get(0)).map_err(sql)?;
            if !linked {
                return Err(corrupt());
            }
        }
    }
    let mut statement=c.prepare("SELECT project_id,capture_id,correction_key FROM resource_captures WHERE capture_kind='correction'").map_err(sql)?;
    for row in statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(sql)?
    {
        let (project, capture, key) = row.map_err(sql)?;
        let (_, CapturedGlossary::Correction(request)) =
            capture_by_id(c, id(project)?, id(capture)?)?
        else {
            return Err(corrupt());
        };
        if proposal_key(&request)? != key {
            return Err(corrupt());
        }
    }
    Ok(())
}

pub(super) fn preview(
    c: &Connection,
    capture: GlossaryCapture,
    request: CaptureCorrectionTerm,
) -> Result<ResourcePreview, ExecutionError> {
    let evidence = validate_request(c, &request)?;
    let current = current_term(c, request.basis.project_id, &capture.capture_id.to_string())?;
    let decision_action:Option<String>=c.query_row(
        "SELECT action_id FROM resource_decisions WHERE capture_id=?1 ORDER BY rowid DESC LIMIT 1",
        [capture.capture_id.to_string()],|r|r.get(0)).optional().map_err(sql)?;
    let decision = decision_action
        .map(id)
        .transpose()?
        .map(|a| decision_action_in(c, request.basis.project_id, a))
        .transpose()?
        .flatten();
    let kind = match &current {
        None => ResourceChangeKind::Added,
        Some(term)
            if term.source == request.source
                && term.target == request.target
                && term.protected == request.protected
                && term.aliases.is_empty()
                && term.scope_unit_id == Some(request.basis.unit_id)
                && !term.removed =>
        {
            ResourceChangeKind::Unchanged
        }
        Some(_) => ResourceChangeKind::Edited,
    };
    Ok(ResourcePreview {
        capture,
        rows: vec![ResourcePreviewRow {
            entry: entry(&request),
            kind,
            current,
            scope_unit_id: Some(request.basis.unit_id),
        }],
        removed: Vec::new(),
        correction: Some(CorrectionTermPreview { evidence, decision }),
        mcp: None,
    })
}

pub(super) fn decide(
    c: &Connection,
    request: &ResourceDecision,
    capture: &CaptureCorrectionTerm,
    request_digest: &str,
) -> Result<Option<TermRevision>, ExecutionError> {
    if request.entry_id != "term" {
        return Err(failure(ErrorCode::DependencyConflict, "resource-entry"));
    }
    let evidence = validate_request(c, capture)?;
    let current = current_term(c, request.project_id, &request.capture_id.to_string())?;
    if current.as_ref().map(|r| r.revision_id) != request.expected_revision_id {
        return Err(
            failure(ErrorCode::DependencyConflict, "resource-current").with_conflict(
                ConflictEvidence::TermRevision {
                    expected: request.expected_revision_id,
                    current: current.as_ref().map(|r| r.revision_id),
                },
            ),
        );
    }
    if matches!(
        request.decision,
        ResourceDecisionKind::Keep | ResourceDecisionKind::Ignore
    ) {
        return Ok(current);
    }
    if !evidence.current {
        return Err(failure(ErrorCode::DependencyConflict, "correction-stale"));
    }
    // Correction proposals create manual, scoped terms; external Override is not a second adoption path.
    if request.decision != ResourceDecisionKind::Adopt || current.is_some() {
        return Err(failure(ErrorCode::DependencyConflict, "correction-adopt"));
    }
    let b = &capture.basis;
    let revision = insert_term(
        c,
        request.project_id,
        &request.capture_id.to_string(),
        &b.locale,
        &capture.source,
        &[],
        &capture.target,
        capture.protected,
        Some(b.unit_id),
        &capture.reason,
        "manual",
        Some(request.capture_id),
        None,
        None,
        false,
        request.action_id,
        request_digest,
    )?;
    write_change(
        c,
        request.project_id,
        "term",
        &b.locale,
        Some(b.unit_id),
        None,
        Some(&capture.source),
        None,
        None,
        revision.revision_id,
        request.action_id,
    )?;
    Ok(Some(revision))
}

pub(super) fn decision_action_in(
    c: &Connection,
    project: ExecutionId,
    action: ExecutionId,
) -> Result<Option<ResourceDecisionResult>, ExecutionError> {
    let row:Option<(String,String,Option<String>,String,Option<String>,String)>=c.query_row(
        "SELECT capture_id,entry_id,expected_revision_id,decision,result_revision_id,request_digest FROM resource_decisions WHERE project_id=?1 AND action_id=?2",
        params![project.to_string(),action.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(sql)?;
    let Some((capture, entry, expected, decision, result, stored_digest)) = row else {
        return Ok(None);
    };
    let decision = match decision.as_str() {
        "adopt" => ResourceDecisionKind::Adopt,
        "keep" => ResourceDecisionKind::Keep,
        "ignore" => ResourceDecisionKind::Ignore,
        "override" => ResourceDecisionKind::Override,
        _ => return Err(failure(ErrorCode::CorruptLedger, "resource-decision")),
    };
    let request = ResourceDecision {
        project_id: project,
        action_id: action,
        capture_id: id(capture)?,
        entry_id: entry,
        expected_revision_id: expected.map(id).transpose()?,
        decision: decision.clone(),
    };
    if digest(&request)? != stored_digest {
        return Err(failure(ErrorCode::CorruptLedger, "resource-action"));
    }
    let revision = result
        .map(id)
        .transpose()?
        .map(|r| {
            term_by_revision(c, project, r)?
                .ok_or_else(|| failure(ErrorCode::CorruptLedger, "resource-decision"))
        })
        .transpose()?;
    Ok(Some(ResourceDecisionResult {
        request,
        action_id: action,
        decision,
        revision,
    }))
}

impl ProjectStore {
    /// Read the original saved correction, including historical source text.
    /// `current` is advisory; a new capture or adoption checks it again atomically.
    pub fn correction_term_basis(
        &self,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
        after_selection_id: ExecutionId,
    ) -> Result<CorrectionTermEvidence, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "resource-read"))?;
        evidence_in(c, project_id, unit_id, locale, after_selection_id)
    }
    pub fn correction_term_capture_action(
        &self,
        project_id: ExecutionId,
        action_id: ExecutionId,
    ) -> Result<Option<CorrectionTermReceipt>, ExecutionError> {
        capture_action_in(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "resource-read"))?,
            project_id,
            action_id,
        )
    }
    pub fn resource_decision_action(
        &self,
        project_id: ExecutionId,
        action_id: ExecutionId,
    ) -> Result<Option<ResourceDecisionResult>, ExecutionError> {
        decision_action_in(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "resource-read"))?,
            project_id,
            action_id,
        )
    }
    /// Capture only an explicit local proposal. This does not adopt or share a term.
    pub fn capture_correction_term(
        &mut self,
        request: &CaptureCorrectionTerm,
    ) -> Result<CorrectionTermReceipt, ExecutionError> {
        if let Some(prior) =
            self.correction_term_capture_action(request.basis.project_id, request.action_id)?
        {
            return if &prior.request == request {
                Ok(prior)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "resource-action"))
            };
        }
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "resource-session"));
        }
        let clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "resource-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let observer = clock.observe(&tx, super::super::ChangeScope::Resources);
        if let Some(prior) = capture_action_in(&tx, request.basis.project_id, request.action_id)? {
            return if &prior.request == request {
                Ok(prior)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "resource-action"))
            };
        }
        let evidence = validate_request(&tx, request)?;
        if !evidence.current {
            return Err(failure(ErrorCode::DependencyConflict, "correction-stale"));
        }
        let key = proposal_key(request)?;
        if tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM resource_captures WHERE correction_key=?1)",
                [&key],
                |r| r.get::<_, bool>(0),
            )
            .map_err(sql)?
        {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "correction-existing",
            ));
        }
        let source_locale = check_project(&tx, request.basis.project_id, &request.basis.locale)?;
        let bytes = codec::encode(request, MAX_RESOURCE_BYTES)?;
        let capture_id = ExecutionId::new();
        let request_digest = codec::digest(&bytes);
        tx.execute("INSERT INTO resource_captures (capture_id,project_id,capture_kind,correction_key,resource_id,resource_revision,source_locale,target_locale,license,digest,bytes,action_id,request_digest) VALUES (?1,?2,'correction',?8,NULL,NULL,?3,?4,NULL,?5,?6,?7,?5)",
            params![capture_id.to_string(),request.basis.project_id.to_string(),source_locale,request.basis.locale,request_digest,bytes,request.action_id.to_string(),key]).map_err(sql)?;
        let capture = GlossaryCapture {
            capture_id,
            origin: GlossaryCaptureOrigin::Correction {
                basis: request.basis.clone(),
            },
            source_locale,
            target_locale: request.basis.locale.clone(),
            digest: request_digest,
            count: 1,
        };
        observer.commit(tx).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "resource-capture-commit")
        })?;
        Ok(CorrectionTermReceipt {
            request: request.clone(),
            capture,
        })
    }
}
