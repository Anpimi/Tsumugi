//! External MCP results are immutable resource candidates, never direct terms.
use super::*;
use crate::application::*;
use crate::execution::*;
use std::sync::{Arc, atomic::AtomicBool};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuerySettings {
    request: McpTermQueryRequest,
    basis: McpTermQueryBasis,
    tool_digest: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CapturedMcpTerms {
    pub action: AdoptionAction,
    pub provenance: McpTermProvenance,
    pub output: McpTermQueryOutput,
}

fn now_ms() -> Result<u64, ExecutionError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|v| u64::try_from(v.as_millis()).ok())
        .ok_or_else(|| failure(ErrorCode::Unauthorized, "mcp-query-clock"))
}
fn source_in(
    c: &Connection,
    request: &McpTermQueryRequest,
    current: bool,
) -> Result<(McpTermQueryBasis, String), ExecutionError> {
    let source_locale = check_project(c, request.project_id, &request.locale)?;
    let snapshot = current_snapshot(c)?;
    let found: Option<(String, String)> = c
        .query_row(
            "SELECT o.revision_id,r.text FROM source_occurrences o
          JOIN source_units u ON u.unit_id=o.unit_id
          JOIN source_revisions r ON r.unit_id=o.unit_id AND r.revision_id=o.revision_id
          WHERE u.project_id=?1 AND o.unit_id=?2 AND o.snapshot_id=?3 ORDER BY o.ordinal LIMIT 1",
            params![
                request.project_id.to_string(),
                request.unit_id.to_string(),
                snapshot.to_string()
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    let (revision, text) =
        found.ok_or_else(|| failure(ErrorCode::DependencyConflict, "mcp-query-source"))?;
    if current && !text.contains(&request.query) {
        return Err(failure(ErrorCode::DependencyConflict, "mcp-query-source"));
    }
    Ok((
        McpTermQueryBasis {
            project_id: request.project_id,
            unit_id: request.unit_id,
            locale: request.locale.clone(),
            source_locale,
            source_snapshot_id: snapshot,
            source_revision_id: id(revision)?,
        },
        text,
    ))
}
fn historic_source(c: &Connection, basis: &McpTermQueryBasis) -> Result<String, ExecutionError> {
    let text: Option<String> = c
        .query_row(
            "SELECT r.text FROM source_occurrences o JOIN source_units u ON u.unit_id=o.unit_id
         JOIN source_revisions r ON r.unit_id=o.unit_id AND r.revision_id=o.revision_id
         WHERE u.project_id=?1 AND o.unit_id=?2 AND o.snapshot_id=?3 AND o.revision_id=?4 LIMIT 1",
            params![
                basis.project_id.to_string(),
                basis.unit_id.to_string(),
                basis.source_snapshot_id.to_string(),
                basis.source_revision_id.to_string()
            ],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    text.ok_or_else(|| failure(ErrorCode::CorruptLedger, "mcp-query-source"))
}
fn arguments(settings: &QuerySettings) -> McpTermQueryArguments {
    McpTermQueryArguments {
        query: settings.request.query.clone(),
        source_locale: settings.basis.source_locale.clone(),
        target_locale: settings.basis.locale.clone(),
    }
}
fn settings(input: &FixedInput) -> Result<QuerySettings, ExecutionError> {
    let e = input.envelope();
    let s: QuerySettings = serde_json::from_value(e.settings.clone())
        .map_err(|_| failure(ErrorCode::InvalidInput, "mcp-query-input"))?;
    s.request.tool.validate()?;
    let r = &s.request;
    let b = &s.basis;
    validate_text(&r.query, false)?;
    if r.query.trim().is_empty()
        || r.query.len() > MAX_MCP_QUERY_BYTES
        || r.locale.len() > 128
        || e.operation != MCP_TERM_QUERY_OPERATION
        || e.capability_id != MCP_TERM_QUERY_CAPABILITY
        || e.capability_version != MCP_TERM_QUERY_PROFILE
        || e.plugin.is_some()
        || e.automation.is_some()
        || e.previous_attempt_id.is_some()
        || !e.reused_results.is_empty()
        || e.project_id != r.project_id
        || e.task_id != r.task_id
        || e.attempt_id != r.attempt_id
        || b.project_id != r.project_id
        || b.unit_id != r.unit_id
        || b.locale != r.locale
        || b.source_locale.is_empty()
        || s.tool_digest != r.tool.digest()?
        || e.items.len() != 1
        || e.units.len() != 1
        || e.units[0].item_ids != vec![e.items[0].item_id]
        || e.items[0].scope.kind != "translation-unit"
        || e.items[0].scope.id != r.unit_id.to_string()
        || e.items[0].scope.locale.as_deref() != Some(r.locale.as_str())
        || e.items[0].payload
            != serde_json::to_value(arguments(&s))
                .map_err(|_| failure(ErrorCode::InvalidInput, "mcp-query-input"))?
        || !e.items[0].dependencies.is_empty()
        || e.limits.timeout_ms != MAX_MCP_QUERY_LIFETIME_MS as u32
        || e.limits.cancel_wait_ms != 5000
        || e.limits.max_result_bytes != MAX_MCP_RESULT_FRAME_BYTES as u32
        || e.limits.max_attempt_result_bytes != MAX_MCP_RESULT_FRAME_BYTES as u32
        || r.expires_at_ms == 0
        || r.expires_at_ms > r.tool.discovery_expires_at_ms
    {
        return Err(failure(ErrorCode::ResultMismatch, "mcp-query-input"));
    }
    for locale in [&b.source_locale, &b.locale] {
        if crate::Locale::parse(locale)
            .map_err(|_| failure(ErrorCode::InvalidInput, "mcp-query-locale"))?
            .as_str()
            != locale
        {
            return Err(failure(ErrorCode::InvalidInput, "mcp-query-locale"));
        }
    }
    Ok(s)
}
pub(crate) fn validate_query_input(
    c: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    let s = settings(input)?;
    if !historic_source(c, &s.basis)?.contains(&s.request.query) {
        return Err(failure(ErrorCode::CorruptLedger, "mcp-query-source"));
    }
    Ok(())
}
pub(crate) fn validate_query_output(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<McpTermQueryOutput, ExecutionError> {
    let s = settings(input)?;
    if result.envelope().outcome != ExecutionState::Succeeded
        || result.envelope().plugin.is_some()
        || result.envelope().attempt_id != input.envelope().attempt_id
        || result.envelope().project_id != s.request.project_id
        || result.envelope().capability_id != MCP_TERM_QUERY_CAPABILITY
        || result.envelope().capability_version != MCP_TERM_QUERY_PROFILE
        || result.envelope().item_id != input.envelope().items[0].item_id
    {
        return Err(failure(ErrorCode::OutputInvalid, "mcp-query-result"));
    }
    let value = result
        .envelope()
        .output
        .as_ref()
        .ok_or_else(|| failure(ErrorCode::OutputInvalid, "mcp-query-result"))?;
    let bytes = codec::encode(value, MAX_MCP_TERM_RESULT_BYTES)?;
    let output: McpTermQueryOutput = codec::decode(&bytes, MAX_MCP_TERM_RESULT_BYTES)
        .map_err(|_| failure(ErrorCode::OutputInvalid, "mcp-query-output"))?;
    if output.entries.len() > MAX_MCP_TERM_ENTRIES {
        return Err(failure(ErrorCode::LimitExceeded, "mcp-query-output"));
    }
    let mut ids = BTreeSet::new();
    for entry in &output.entries {
        for text in [&entry.id, &entry.source, &entry.target, &entry.reason] {
            validate_text(text, false)
                .map_err(|_| failure(ErrorCode::OutputInvalid, "mcp-query-entry"))?;
        }
        if entry.id.trim().is_empty()
            || entry.id.len() > 128
            || !ids.insert(&entry.id)
            || entry.source.trim().is_empty()
            || entry.source.len() > MAX_FIELD_BYTES
            || entry.target.trim().is_empty()
            || entry.target.len() > MAX_FIELD_BYTES
            || entry.reason.trim().is_empty()
            || entry.reason.len() > 4096
            || !s.request.query.contains(&entry.source)
        {
            return Err(failure(ErrorCode::OutputInvalid, "mcp-query-entry"));
        }
    }
    Ok(output)
}
pub fn validate_mcp_term_query_preview(preview: &McpTermQueryPreview) -> Result<(), ExecutionError> {
    let r = &preview.request;
    r.tool.validate()?;
    validate_text(&r.query, false)?;
    let digest = |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if r.query.trim().is_empty() || r.query.len() > MAX_MCP_QUERY_BYTES
        || r.expires_at_ms > r.tool.discovery_expires_at_ms
        || preview.basis.project_id != r.project_id || preview.basis.unit_id != r.unit_id
        || preview.basis.locale != r.locale || preview.tool_digest != r.tool.digest()?
        || !digest(&preview.input_digest)
        || preview.arguments != (McpTermQueryArguments { query: r.query.clone(), source_locale: preview.basis.source_locale.clone(), target_locale: r.locale.clone() })
    {
        return Err(failure(ErrorCode::InvalidInput, "mcp-query-preview"));
    }
    crate::Locale::parse(&r.locale).map_err(|_| failure(ErrorCode::InvalidInput, "mcp-query-locale"))?;
    crate::Locale::parse(&preview.basis.source_locale).map_err(|_| failure(ErrorCode::InvalidInput, "mcp-query-locale"))?;
    Ok(())
}

pub(crate) fn check_preview_in(c: &Connection, preview: &McpTermQueryPreview) -> Result<(), ExecutionError> {
    validate_mcp_term_query_preview(preview)?;
    if source_in(c, &preview.request, true)?.0 != preview.basis {
        return Err(failure(ErrorCode::DependencyConflict, "mcp-query-source"));
    }
    Ok(())
}

pub(crate) fn preview_for_input(input: &FixedInput) -> Result<McpTermQueryPreview, ExecutionError> {
    let s = settings(input)?;
    Ok(McpTermQueryPreview { request: s.request.clone(), basis: s.basis.clone(), arguments: arguments(&s), tool_digest: s.tool_digest, input_digest: input.digest().into() })
}

pub fn validate_mcp_term_query_result(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<McpTermQueryOutput, ExecutionError> {
    validate_query_output(input, result)
}

impl ProjectStore {
    pub fn reconcile_mcp_term_query_action(
        &self,
        project: ExecutionId,
        consent: &McpTermQueryConsent,
    ) -> Result<Option<McpTermQueryPreview>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "mcp-query-session"))?;
        let attempt: Option<String> = c
            .query_row(
                "SELECT attempt_id FROM mcp_query_actions WHERE action_id=?1",
                [consent.action_id.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        let Some(attempt) = attempt else {
            return Ok(None);
        };
        self.reconcile_mcp_term_query(project, id(attempt)?, consent)
    }
    /// Historical ACK only. Absence never authorizes a retry or proves that an
    /// already accepted transport call did not run.
    pub fn reconcile_mcp_term_query(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        consent: &McpTermQueryConsent,
    ) -> Result<Option<McpTermQueryPreview>, ExecutionError> {
        let Some(input) = self.execution_input_if_present(attempt)? else {
            return Ok(None);
        };
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "mcp-query-session"))?;
        validate_ledger_input(c, &input)?;
        let s = settings(&input)?;
        if s.request.project_id != project
            || consent.action_id != s.request.action_id
            || consent.input_digest != input.digest()
            || consent.expires_at_ms != s.request.expires_at_ms
            || !consent.share_query
        {
            return Err(failure(ErrorCode::ResultMismatch, "mcp-query-receipt"));
        }
        Ok(Some(McpTermQueryPreview {
            request: s.request.clone(),
            basis: s.basis.clone(),
            arguments: arguments(&s),
            tool_digest: s.tool_digest,
            input_digest: input.digest().into(),
        }))
    }
    pub fn prepare_mcp_term_query(
        &self,
        request: &McpTermQueryRequest,
    ) -> Result<PreparedMcpTermQuery, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "mcp-query-session"));
        }
        request.tool.validate()?;
        validate_text(&request.query, false)?;
        if request.expires_at_ms > request.tool.discovery_expires_at_ms {
            return Err(failure(ErrorCode::Unauthorized, "mcp-query-deadline"));
        }
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "mcp-query-session"))?;
        let accepted: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM mcp_query_actions WHERE action_id=?1)",
                [request.action_id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if accepted {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "mcp-query-already-enqueued",
            ));
        }
        if self
            .execution_input_if_present(request.attempt_id)?
            .is_some()
        {
            return Err(failure(ErrorCode::ResultMismatch, "mcp-query-attempt"));
        }
        if request.query.trim().is_empty() || request.query.len() > MAX_MCP_QUERY_BYTES {
            return Err(failure(ErrorCode::InvalidInput, "mcp-query-text"));
        }
        let remaining = request
            .expires_at_ms
            .checked_sub(now_ms()?)
            .filter(|v| *v > 0 && *v <= MAX_MCP_QUERY_LIFETIME_MS)
            .ok_or_else(|| failure(ErrorCode::Unauthorized, "mcp-query-deadline"))?;
        let deadline = Instant::now() + Duration::from_millis(remaining);
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "mcp-query-session"))?;
        let (basis, _) =
            super::super::review::read_snapshot(connection, |c| source_in(c, request, true))?;
        let s = QuerySettings {
            request: request.clone(),
            basis: basis.clone(),
            tool_digest: request.tool.digest()?,
        };
        let args = arguments(&s);
        let item = InputItem::new(
            Scope {
                kind: "translation-unit".into(),
                id: request.unit_id.to_string(),
                locale: Some(request.locale.clone()),
            },
            serde_json::to_value(&args)
                .map_err(|_| failure(ErrorCode::InvalidInput, "mcp-query-input"))?,
            vec![],
        );
        let project = crate::ProjectId::parse(&request.project_id.to_string())
            .map_err(|_| failure(ErrorCode::InvalidInput, "mcp-query-project"))?;
        let mut envelope = InputEnvelope::new(
            project,
            MCP_TERM_QUERY_OPERATION,
            MCP_TERM_QUERY_CAPABILITY,
            MCP_TERM_QUERY_PROFILE,
            vec![item],
        )?;
        envelope.task_id = request.task_id;
        envelope.attempt_id = request.attempt_id;
        envelope.settings = serde_json::to_value(&s)
            .map_err(|_| failure(ErrorCode::InvalidInput, "mcp-query-input"))?;
        envelope.limits = ExecutionLimits {
            timeout_ms: MAX_MCP_QUERY_LIFETIME_MS as u32,
            cancel_wait_ms: 5000,
            max_result_bytes: MAX_MCP_RESULT_FRAME_BYTES as u32,
            max_attempt_result_bytes: MAX_MCP_RESULT_FRAME_BYTES as u32,
        };
        let input = FixedInput::capture(envelope)?;
        let preview = McpTermQueryPreview {
            request: request.clone(),
            basis,
            arguments: args,
            tool_digest: s.tool_digest,
            input_digest: input.digest().into(),
        };
        Ok(PreparedMcpTermQuery {
            epoch: self.changes_since(Revision::new(0)?).epoch,
            preview,
            input,
            deadline,
            store_live: self.mcp_query_liveness.clone(),
            authorization: Arc::default(),
            member_binding: Arc::default(),
            member_deadline: Arc::default(),
            active: Arc::new(AtomicBool::new(true)),
        })
    }
    pub fn authorize_mcp_term_query(
        &self,
        prepared: &PreparedMcpTermQuery,
        consent: &McpTermQueryConsent,
    ) -> Result<McpTermQueryPermit, ExecutionError> {
        self.check_mcp_term_query(prepared)?;
        if prepared.member_binding.get().is_some() {
            return Err(failure(ErrorCode::Unauthorized, "mcp-query-member-bound"));
        }
        let r = &prepared.preview.request;
        if consent.action_id != r.action_id
            || consent.input_digest != prepared.input.digest()
            || consent.expires_at_ms != r.expires_at_ms
            || !consent.share_query
        {
            return Err(failure(ErrorCode::Unauthorized, "mcp-query-consent"));
        }
        let permit = prepared.authorization.get_or_init(|| McpTermQueryPermit {
            epoch: prepared.epoch.clone(),
            input: prepared.input.clone(),
            deadline: prepared.deadline,
            active: prepared.active.clone(),
            store_live: prepared.store_live.clone(),
            runtime: Arc::default(),
            expires_at_ms: consent.expires_at_ms,
        });
        permit.check_input(prepared.input())?;
        Ok(permit.clone())
    }
    pub(crate) fn check_mcp_term_query(
        &self,
        prepared: &PreparedMcpTermQuery,
    ) -> Result<(), ExecutionError> {
        if !prepared.active.load(std::sync::atomic::Ordering::Acquire)
            || self.is_reconciling()
            || self.changes_since(Revision::new(0)?).epoch != prepared.epoch
            || Instant::now() >= prepared.deadline
            || now_ms().map_or(true, |v| v >= prepared.preview.request.expires_at_ms)
        {
            prepared
                .active
                .store(false, std::sync::atomic::Ordering::Release);
            return Err(failure(ErrorCode::Unauthorized, "mcp-query-session"));
        }
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "mcp-query-session"))?;
        check_prepared_in(c, prepared)
    }
    pub fn mcp_term_capture_receipt(
        &self,
        project: ExecutionId,
        action: ExecutionId,
    ) -> Result<Option<McpTermCaptureReceipt>, ExecutionError> {
        let Some(receipt) = self.adoption_receipt(action)? else {
            return Ok(None);
        };
        let original = self.adoption_action(action)?;
        if original.project_id != project || original.operation != MCP_TERM_QUERY_OPERATION {
            return Err(failure(
                ErrorCode::ResultMismatch,
                "mcp-query-capture-action",
            ));
        }
        let capture = capture_by_id(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "mcp-query-session"))?,
            project,
            action,
        )?
        .0;
        Ok(Some(McpTermCaptureReceipt {
            action: original,
            receipt,
            capture,
        }))
    }
}

pub(crate) fn check_prepared_in(
    c: &Connection,
    prepared: &PreparedMcpTermQuery,
) -> Result<(), ExecutionError> {
    let s = settings(&prepared.input)?;
    let (basis, _) = source_in(c, &s.request, true)?;
    if basis != s.basis
        || prepared.preview.request != s.request
        || prepared.preview.basis != s.basis
        || prepared.preview.input_digest != prepared.input.digest()
        || prepared.preview.tool_digest != s.tool_digest
        || prepared.preview.arguments != arguments(&s)
    {
        return Err(failure(ErrorCode::DependencyConflict, "mcp-query-stale"));
    }
    Ok(())
}

#[derive(Default)]
pub struct McpTermQueryAdoptionHandler;
impl AdoptionHandler for McpTermQueryAdoptionHandler {
    fn operation(&self) -> &str {
        MCP_TERM_QUERY_OPERATION
    }
    fn prepare(
        &self,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<PreparedMutation, ExecutionError> {
        if action.operation != MCP_TERM_QUERY_OPERATION
            || action.parameters != serde_json::Value::Null
            || results.len() != 1
        {
            return Err(failure(ErrorCode::InvalidInput, "mcp-query-capture"));
        }
        let s = settings(input)?;
        let result = &results[0];
        let output = validate_query_output(input, result)?;
        let captured = CapturedMcpTerms {
            action: action.clone(),
            provenance: McpTermProvenance {
                basis: s.basis.clone(),
                query: s.request.query.clone(),
                tool: s.request.tool.clone(),
                tool_digest: s.tool_digest,
                query_action_id: s.request.action_id,
                task_id: s.request.task_id,
                attempt_id: s.request.attempt_id,
                input_digest: input.digest().into(),
                item_id: result.envelope().item_id,
                result_id: result.envelope().result_id,
                result_digest: result.digest().into(),
            },
            output,
        };
        let bytes = codec::encode(&captured, MAX_MCP_CAPTURE_BYTES)?;
        let digest = codec::digest(&bytes);
        Ok(Box::new(move |tx| {
            let current: Vec<(String,String)> = tx.query_rows(
                "SELECT o.snapshot_id,o.revision_id FROM source_occurrences o JOIN content_scope c ON c.current_snapshot=o.snapshot_id JOIN source_units u ON u.unit_id=o.unit_id WHERE u.project_id=?1 AND o.unit_id=?2 ORDER BY o.ordinal LIMIT 1",
                params![s.request.project_id.to_string(),s.request.unit_id.to_string()], |r| Ok((r.get(0)?,r.get(1)?)))?;
            if current
                != vec![(
                    s.basis.source_snapshot_id.to_string(),
                    s.basis.source_revision_id.to_string(),
                )]
            {
                return Err(failure(ErrorCode::DependencyConflict, "mcp-query-stale"));
            }
            tx.execute("INSERT INTO resource_captures(capture_id,project_id,capture_kind,correction_key,resource_id,resource_revision,source_locale,target_locale,license,digest,bytes,action_id,request_digest) VALUES(?1,?2,'mcp',NULL,NULL,NULL,?3,?4,NULL,?5,?6,?1,?5)",
                params![captured.action.action_id.to_string(),s.request.project_id.to_string(),s.basis.source_locale,s.basis.locale,digest,bytes])?;
            Ok(vec![ChangeReference {
                kind: "resource-capture".into(),
                id: captured.action.action_id.to_string(),
                revision: Revision::new(1)?,
            }])
        }))
    }
}

pub(crate) fn validate_ledger_input(
    c: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    validate_query_input(c, input)?;
    let s = settings(input)?;
    let saved: Option<(String, String)> = c
        .query_row(
            "SELECT attempt_id,input_digest FROM mcp_query_actions WHERE action_id=?1",
            [s.request.action_id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    if saved != Some((s.request.attempt_id.to_string(), input.digest().into())) {
        return Err(failure(ErrorCode::CorruptLedger, "mcp-query-action"));
    }
    let current: Option<String> = c.query_row(
        "SELECT current_result_id FROM execution_items WHERE attempt_id=?1 AND validation='valid'",
        [input.envelope().attempt_id.to_string()], |r| r.get(0)).optional().map_err(sql)?.flatten();
    if let Some(result) = current {
        let result = super::super::ledger::load_result(c, input, id(result)?)?;
        validate_query_output(input, &result)?;
    }
    Ok(())
}
pub(crate) fn record_input(c: &Connection, input: &FixedInput) -> Result<(), ExecutionError> {
    if input.envelope().operation != MCP_TERM_QUERY_OPERATION
        && input.envelope().capability_id != MCP_TERM_QUERY_CAPABILITY
    {
        return Ok(());
    }
    let s = settings(input)?;
    let prior: Option<(String, String)> = c
        .query_row(
            "SELECT attempt_id,input_digest FROM mcp_query_actions WHERE action_id=?1",
            [s.request.action_id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    if let Some(prior) = prior {
        if prior != (s.request.attempt_id.to_string(), input.digest().into()) {
            return Err(failure(ErrorCode::ResultMismatch, "mcp-query-action"));
        }
        return Ok(());
    }
    c.execute(
        "INSERT INTO mcp_query_actions VALUES(?1,?2,?3)",
        params![
            s.request.action_id.to_string(),
            s.request.attempt_id.to_string(),
            input.digest()
        ],
    )
    .map_err(sql)?;
    Ok(())
}
pub(crate) fn validate_action_links(c: &Connection) -> Result<(), ExecutionError> {
    let mut st = c
        .prepare("SELECT action_id,attempt_id,input_digest FROM mcp_query_actions")
        .map_err(sql)?;
    let rows = st
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(sql)?;
    for row in rows {
        let (action, attempt, digest) = row.map_err(sql)?;
        let input = super::super::ledger::load_input_cached(c, id(attempt)?)?;
        if settings(&input)?.request.action_id.to_string() != action || input.digest() != digest {
            return Err(failure(ErrorCode::CorruptLedger, "mcp-query-action"));
        }
    }
    Ok(())
}

pub(super) fn validate_capture(
    c: &Connection,
    captured: &CapturedMcpTerms,
) -> Result<(), ExecutionError> {
    let p = &captured.provenance;
    let a = &captured.action;
    let input = super::super::ledger::load_input_cached(c, p.attempt_id)?;
    validate_ledger_input(c, &input)?;
    let result = super::super::ledger::load_result(c, &input, p.result_id)?;
    let s = settings(&input)?;
    let saved_action: Vec<u8> = c
        .query_row(
            "SELECT request FROM execution_actions WHERE action_id=?1",
            [a.action_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let saved_action: AdoptionAction = codec::decode(&saved_action, MAX_INPUT_BYTES)?;
    let receipt = super::super::ledger::read_receipt(c, a.action_id)?
        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "mcp-query-capture-receipt"))?;
    let expected = McpTermProvenance {
        basis: s.basis.clone(),
        query: s.request.query.clone(),
        tool: s.request.tool,
        tool_digest: s.tool_digest,
        query_action_id: s.request.action_id,
        task_id: s.request.task_id,
        attempt_id: s.request.attempt_id,
        input_digest: input.digest().into(),
        item_id: result.envelope().item_id,
        result_id: result.envelope().result_id,
        result_digest: result.digest().into(),
    };
    if p != &expected
        || a != &saved_action
        || a.project_id != s.request.project_id
        || a.operation != MCP_TERM_QUERY_OPERATION
        || a.unit_id != input.envelope().units[0].unit_id
        || a.attempt_id != p.attempt_id
        || a.result_ids != vec![p.result_id]
        || a.parameters != serde_json::Value::Null
        || captured.output != validate_query_output(&input, &result)?
        || receipt.project_id != a.project_id
        || receipt.attempt_id != a.attempt_id
        || receipt.unit_id != a.unit_id
        || receipt.request_digest != a.digest(&input, std::slice::from_ref(&result))?
        || receipt.changes
            != vec![ChangeReference {
                kind: "resource-capture".into(),
                id: a.action_id.to_string(),
                revision: Revision::new(1)?,
            }]
    {
        return Err(failure(ErrorCode::CorruptLedger, "mcp-query-capture"));
    }
    Ok(())
}

fn term_id(p: &McpTermProvenance, entry: &str) -> Result<String, ExecutionError> {
    // A query is a proposal batch, not a whole glossary. Reconnection and new
    // result identities do not change a term's identity or remove omitted terms.
    Ok(format!(
        "mcp:{}",
        digest(&(
            &p.tool.endpoint,
            &p.tool.tool_name,
            p.basis.unit_id,
            &p.basis.locale,
            entry
        ))?
    ))
}
fn current(c: &Connection, captured: &CapturedMcpTerms) -> Result<bool, ExecutionError> {
    let b = &captured.provenance.basis;
    let metadata = super::super::read_metadata_from(c)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "mcp-query-project"))?;
    if metadata.project_id().to_string() != b.project_id.to_string()
        || metadata.source_locale().as_str() != b.source_locale
        || !metadata
            .target_locales()
            .iter()
            .any(|l| l.as_str() == b.locale)
    {
        return Ok(false);
    }
    let basis: Option<(String,String)> = c.query_row(
        "SELECT o.snapshot_id,o.revision_id FROM source_occurrences o JOIN content_scope c ON c.current_snapshot=o.snapshot_id JOIN source_units u ON u.unit_id=o.unit_id
          WHERE u.project_id=?1 AND o.unit_id=?2 ORDER BY o.ordinal LIMIT 1",
        params![b.project_id.to_string(), b.unit_id.to_string()], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
    Ok(basis
        == Some((
            b.source_snapshot_id.to_string(),
            b.source_revision_id.to_string(),
        )))
}
fn entry(value: &McpTermEntry) -> GlossaryEntry {
    GlossaryEntry {
        id: value.id.clone(),
        source: value.source.clone(),
        aliases: vec![],
        target: value.target.clone(),
        protected: false,
        native_key: None,
        reason: value.reason.clone(),
    }
}
pub(super) fn preview(
    c: &Connection,
    capture: GlossaryCapture,
    value: CapturedMcpTerms,
) -> Result<ResourcePreview, ExecutionError> {
    let mut rows = Vec::with_capacity(value.output.entries.len());
    for e in &value.output.entries {
        let current = current_term(
            c,
            value.provenance.basis.project_id,
            &term_id(&value.provenance, &e.id)?,
        )?;
        let kind = match &current {
            None => ResourceChangeKind::Added,
            Some(v) if v.origin_kind == TermOrigin::Manual => ResourceChangeKind::Override,
            Some(v)
                if v.source == e.source
                    && v.target == e.target
                    && v.reason == e.reason
                    && !v.removed =>
            {
                ResourceChangeKind::Unchanged
            }
            _ => ResourceChangeKind::Edited,
        };
        rows.push(ResourcePreviewRow {
            entry: entry(e),
            kind,
            current,
            scope_unit_id: Some(value.provenance.basis.unit_id),
        });
    }
    Ok(ResourcePreview {
        capture,
        rows,
        removed: vec![],
        correction: None,
        mcp: Some(McpTermCapturePreview {
            current: current(c, &value)?,
        }),
    })
}
pub(super) fn decide(
    c: &Connection,
    request: &ResourceDecision,
    captured: &CapturedMcpTerms,
    request_digest: &str,
) -> Result<Option<TermRevision>, ExecutionError> {
    let incoming = captured
        .output
        .entries
        .iter()
        .find(|e| e.id == request.entry_id)
        .ok_or_else(|| failure(ErrorCode::DependencyConflict, "resource-entry"))?;
    let term = term_id(&captured.provenance, &request.entry_id)?;
    let old = current_term(c, request.project_id, &term)?;
    if old.as_ref().map(|v| v.revision_id) != request.expected_revision_id {
        return Err(
            failure(ErrorCode::DependencyConflict, "resource-current").with_conflict(
                ConflictEvidence::TermRevision {
                    expected: request.expected_revision_id,
                    current: old.as_ref().map(|v| v.revision_id),
                },
            ),
        );
    }
    if matches!(
        request.decision,
        ResourceDecisionKind::Keep | ResourceDecisionKind::Ignore
    ) {
        return Ok(old);
    }
    if !current(c, captured)? {
        return Err(failure(ErrorCode::DependencyConflict, "mcp-query-stale"));
    }
    if old
        .as_ref()
        .is_some_and(|v| v.origin_kind == TermOrigin::Manual)
        && request.decision != ResourceDecisionKind::Override
    {
        return Err(failure(ErrorCode::DependencyConflict, "resource-override"));
    }
    let p = &captured.provenance;
    let revision = insert_term(
        c,
        request.project_id,
        &term,
        &p.basis.locale,
        &incoming.source,
        &[],
        &incoming.target,
        false,
        Some(p.basis.unit_id),
        &incoming.reason,
        "external",
        Some(request.capture_id),
        Some(&request.entry_id),
        request.expected_revision_id,
        false,
        request.action_id,
        request_digest,
    )?;
    if old.as_ref().is_none_or(|v| {
        v.source != incoming.source
            || v.target != incoming.target
            || v.scope_unit_id != Some(p.basis.unit_id)
            || v.removed
            || !v.aliases.is_empty()
            || v.protected
    }) {
        write_change(
            c,
            request.project_id,
            "term",
            &p.basis.locale,
            Some(p.basis.unit_id),
            old.as_ref().and_then(|v| v.scope_unit_id),
            Some(&incoming.source),
            old.as_ref().map(|v| v.source.as_str()),
            request.expected_revision_id,
            revision.revision_id,
            request.action_id,
        )?;
    }
    Ok(Some(revision))
}

pub(super) fn validate_captures(c: &Connection) -> Result<(), ExecutionError> {
    let orphan: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM term_revisions r JOIN resource_captures c ON c.capture_id=r.capture_id WHERE c.capture_kind='mcp' AND NOT EXISTS(SELECT 1 FROM resource_decisions d WHERE d.action_id=r.action_id AND d.capture_id=r.capture_id AND d.entry_id=r.external_entry_id AND d.project_id=r.project_id AND d.result_revision_id=r.revision_id))", [], |r| r.get(0)).map_err(sql)?;
    if orphan {
        return Err(failure(ErrorCode::CorruptLedger, "mcp-query-term"));
    }
    let mut statement = c.prepare("SELECT d.action_id,d.project_id,d.capture_id FROM resource_decisions d JOIN resource_captures c ON c.capture_id=d.capture_id WHERE c.capture_kind='mcp'").map_err(sql)?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(sql)?;
    for row in rows {
        let (action, project, capture) = row.map_err(sql)?;
        let project = id(project)?;
        let saved = correction::decision_action_in(c, project, id(action)?)?
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "mcp-query-decision"))?;
        let (_, correction::CapturedGlossary::Mcp(value)) =
            capture_by_id(c, project, id(capture)?)?
        else {
            return Err(failure(ErrorCode::CorruptLedger, "mcp-query-decision"));
        };
        let incoming = value
            .output
            .entries
            .iter()
            .find(|e| e.id == saved.request.entry_id)
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "mcp-query-decision"))?;
        let expected_term = term_id(&value.provenance, &incoming.id)?;
        let prior = saved
            .request
            .expected_revision_id
            .map(|r| term_by_revision(c, project, r))
            .transpose()?
            .flatten();
        if saved.request.expected_revision_id.is_some()
            && prior.as_ref().is_none_or(|r| {
                r.term_id != expected_term || r.locale != value.provenance.basis.locale
            })
        {
            return Err(failure(ErrorCode::CorruptLedger, "mcp-query-term"));
        }
        if matches!(
            saved.decision,
            ResourceDecisionKind::Adopt | ResourceDecisionKind::Override
        ) {
            let revision = saved
                .revision
                .ok_or_else(|| failure(ErrorCode::CorruptLedger, "mcp-query-term"))?;
            let exact_action: bool = c.query_row("SELECT action_id=?2 AND request_digest=?3 FROM term_revisions WHERE revision_id=?1",params![revision.revision_id.to_string(),saved.request.action_id.to_string(),digest(&saved.request)?], |r| r.get(0)).map_err(sql)?;
            if revision.term_id != term_id(&value.provenance, &incoming.id)?
                || revision.origin_kind != TermOrigin::External
                || revision.locale != value.provenance.basis.locale
                || revision.scope_unit_id != Some(value.provenance.basis.unit_id)
                || revision.source != incoming.source
                || revision.target != incoming.target
                || !revision.aliases.is_empty()
                || revision.protected
                || revision.removed
                || revision.capture_id != Some(saved.request.capture_id)
                || revision.external_entry_id.as_deref() != Some(incoming.id.as_str())
                || revision.reason != incoming.reason
                || revision.previous_revision_id != saved.request.expected_revision_id
                || !exact_action
                || (prior
                    .as_ref()
                    .is_some_and(|r| r.origin_kind == TermOrigin::Manual)
                    && saved.decision != ResourceDecisionKind::Override)
            {
                return Err(failure(ErrorCode::CorruptLedger, "mcp-query-term"));
            }
        } else if saved.revision.as_ref().map(|r| r.revision_id)
            != saved.request.expected_revision_id
        {
            return Err(failure(ErrorCode::CorruptLedger, "mcp-query-decision"));
        }
    }
    Ok(())
}
