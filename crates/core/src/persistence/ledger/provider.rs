//! Durable dispatch evidence lives beside the existing execution ledger.
use super::*;
use crate::ai::{Usage, provider::ProviderRequestCapture};

fn decode_usage(bytes: &[u8]) -> Result<Usage, ExecutionError> {
    let usage: Usage = codec::decode(bytes, 1024)?;
    usage
        .validate()
        .map_err(|_| error(ErrorCode::CorruptLedger, "provider-usage"))?;
    Ok(usage)
}

fn validate_request_capture(input: &FixedInput, item: ExecutionId, capture: &ProviderRequestCapture)
    -> Result<(), ExecutionError> {
    use crate::ai::{self, provider::CompletionPrompt};
    let (config, prompt) = match input.envelope().operation.as_str() {
        ai::team::OPERATION => (ai::team::settings(input)?.config, None),
        ai::OPERATION => {
            let settings = ai::settings(input)?;
            let prompt = if settings.agent.is_none() {
                Some(ai::request_body(&settings.config, &ai::item_payload(input, item)?)?)
            } else { None };
            (settings.config, prompt)
        }
        ai::arena::OPERATION => {
            let settings = ai::arena::settings(input)?;
            let item = ai::arena::item_payload(input, item)?;
            let config = settings.config.request_config(item.slot)?;
            let prompt = ai::request_body(&config, &item.item)?;
            (config, Some(prompt))
        }
        ai::semantic_review::OPERATION => {
            let settings = ai::semantic_review::settings(input)?;
            let item = ai::semantic_review::item_payload(input, item)?;
            let prompt = ai::semantic_review::request_body(&settings.config, &settings.rules, &item)?;
            (settings.config, Some(prompt))
        }
        _ => return Err(error(ErrorCode::Unauthorized, "member-dispatch")),
    };
    capture.validate(&config)?;
    if let Some(prompt) = prompt {
        if !config.is_chatgpt_subscription() {
            return Err(error(ErrorCode::Unauthorized, "ai-completion-profile"));
        }
        capture.validate_completion(&CompletionPrompt::capture(&prompt)?)?;
    }
    Ok(())
}

fn team_budget_limit(input: &FixedInput) -> Result<u32, ExecutionError> {
    let settings = crate::ai::team::settings(input)?;
    Ok(if settings.binding.is_root() {
        settings.root_request_limit
    } else {
        settings.config.max_requests
    })
}

const TABLES: &[(&str, &str)] = &[
    (
        "execution_effects",
        "CREATE TABLE execution_effects (attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_attempts(attempt_id), policy TEXT NOT NULL CHECK(policy IN ('read-only','idempotent-local-write','external-unknown')))",
    ),
    (
        "execution_budgets",
        "CREATE TABLE execution_budgets (task_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_tasks(task_id), parent_id TEXT REFERENCES execution_budgets(task_id), request_limit INTEGER NOT NULL CHECK(request_limit BETWEEN 1 AND 300), legacy_held INTEGER NOT NULL CHECK(legacy_held BETWEEN 0 AND request_limit), CHECK(task_id<>parent_id))",
    ),
    (
        "execution_budget_ancestry",
        "CREATE TABLE execution_budget_ancestry (task_id TEXT NOT NULL REFERENCES execution_budgets(task_id), ancestor_id TEXT NOT NULL REFERENCES execution_budgets(task_id), PRIMARY KEY(task_id,ancestor_id))",
    ),
    (
        "execution_provider_requests",
        "CREATE TABLE execution_provider_requests (request_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES execution_budgets(task_id), attempt_id TEXT NOT NULL, item_id TEXT NOT NULL, dispatch_token TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('unknown','response')), usage BLOB CHECK(usage IS NULL OR length(usage) BETWEEN 1 AND 1024), capture BLOB CHECK(capture IS NULL OR length(capture) BETWEEN 1 AND 131072), capture_digest TEXT CHECK(capture_digest IS NULL OR length(capture_digest)=64), CHECK((capture IS NULL)=(capture_digest IS NULL)), FOREIGN KEY(attempt_id,item_id,dispatch_token) REFERENCES execution_items(attempt_id,item_id,dispatch_token))",
    ),
];
pub(crate) fn table_names() -> impl Iterator<Item = String> {
    TABLES.iter().map(|(n, _)| n.to_string())
}
pub(crate) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    for (_, sql) in TABLES {
        c.execute_batch(sql)?;
    }
    Ok(())
}
pub(crate) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    for (name, expected) in TABLES {
        let actual: String = c
            .query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                r.get(0)
            })
            .map_err(sql_error)?;
        if actual != *expected {
            return Err(error(ErrorCode::CorruptLedger, "provider-schema"));
        }
    }
    let missing: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM execution_attempts a LEFT JOIN execution_effects e USING(attempt_id) WHERE e.attempt_id IS NULL) OR EXISTS(SELECT 1 FROM execution_provider_requests p JOIN execution_attempts a USING(attempt_id) WHERE p.task_id<>a.task_id) OR EXISTS(SELECT 1 FROM execution_budgets b WHERE NOT EXISTS(SELECT 1 FROM execution_budget_ancestry x WHERE x.task_id=b.task_id AND x.ancestor_id=b.task_id)) OR EXISTS(SELECT 1 FROM execution_budget_ancestry x WHERE x.task_id<>x.ancestor_id AND EXISTS(SELECT 1 FROM execution_budget_ancestry y WHERE y.task_id=x.ancestor_id AND y.ancestor_id=x.task_id))", [], |r| r.get(0)).map_err(sql_error)?;
    if missing {
        return Err(error(ErrorCode::CorruptLedger, "provider-association"));
    }
    let mut members = c
        .prepare("SELECT b.task_id,b.parent_id,b.request_limit,t.operation FROM execution_budgets b JOIN execution_tasks t USING(task_id)")
        .map_err(sql_error)?;
    for member in members
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, u32>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(sql_error)?
    {
        let (task, parent, limit, operation) = member.map_err(sql_error)?;
        parse_id(task.clone())?;
        if operation == crate::ai::team::OPERATION {
            let attempt: String = c.query_row(
                "SELECT attempt_id FROM execution_attempts WHERE task_id=?1 ORDER BY sequence DESC LIMIT 1",
                [task.clone()], |row| row.get(0),
            ).map_err(sql_error)?;
            let input = load_input(c, parse_id(attempt)?)?;
            let settings = crate::ai::team::settings(&input)?;
            let own_requests: u32 = c.query_row(
                "SELECT COUNT(*) FROM execution_provider_requests WHERE task_id=?1",
                [task.clone()], |row| row.get(0),
            ).map_err(sql_error)?;
            if limit != team_budget_limit(&input)?
                || settings.config.max_requests > settings.root_request_limit
                || settings.binding.is_root() != parent.is_none()
                || parent.as_ref().is_some_and(|parent| parent != &settings.binding.scope().root_task.to_string())
                || own_requests > settings.config.max_requests
            {
                return Err(error(ErrorCode::CorruptLedger, "provider-team-budget"));
            }
            if let Some(parent) = &parent {
                let attempt: String = c.query_row(
                    "SELECT attempt_id FROM execution_attempts WHERE task_id=?1 ORDER BY sequence DESC LIMIT 1",
                    [parent], |row| row.get(0),
                ).map_err(sql_error)?;
                let original = load_input(c, parse_id(attempt)?)?;
                crate::persistence::application::coordination::validate_provider_parent_history_in(
                    c, &input, &original,
                )?;
            }
        }
        let mut expected = std::collections::BTreeSet::from([task.clone()]);
        let mut next = parent;
        while let Some(parent) = next {
            if expected.len() >= 16 || !expected.insert(parent.clone()) {
                return Err(error(ErrorCode::CorruptLedger, "provider-hierarchy"));
            }
            let (ancestor, ancestor_limit): (Option<String>, u32) = c
                .query_row(
                    "SELECT parent_id,request_limit FROM execution_budgets WHERE task_id=?1",
                    [parent],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(sql_error)?;
            if limit > ancestor_limit {
                return Err(error(ErrorCode::CorruptLedger, "provider-parent-limit"));
            }
            next = ancestor;
        }
        let mut ancestry = c
            .prepare("SELECT ancestor_id FROM execution_budget_ancestry WHERE task_id=?1")
            .map_err(sql_error)?;
        let actual = ancestry
            .query_map([task.clone()], |r| r.get::<_, String>(0))
            .map_err(sql_error)?
            .collect::<rusqlite::Result<std::collections::BTreeSet<_>>>()
            .map_err(sql_error)?;
        if actual != expected {
            return Err(error(ErrorCode::CorruptLedger, "provider-ancestry"));
        }
        let occupied:u32=c.query_row("SELECT b.legacy_held+(SELECT COUNT(*) FROM execution_provider_requests p JOIN execution_budget_ancestry x ON p.task_id=x.task_id WHERE x.ancestor_id=b.task_id) FROM execution_budgets b WHERE b.task_id=?1",[task],|r|r.get(0)).map_err(sql_error)?;
        if occupied > limit {
            return Err(error(ErrorCode::CorruptLedger, "provider-budget"));
        }
    }
    let mut statement = c
        .prepare("SELECT request_id,usage,capture,capture_digest,attempt_id,item_id FROM execution_provider_requests")
        .map_err(sql_error)?;
    for row in statement
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<Vec<u8>>>(1)?, r.get::<_, Option<Vec<u8>>>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?))
        })
        .map_err(sql_error)?
    {
        let (id, bytes, capture, digest, attempt, item) = row.map_err(sql_error)?;
        let item = parse_id(item)?;
        parse_id(id)?;
        if let Some(bytes) = bytes {
            decode_usage(&bytes)?;
        }
        match (capture, digest) {
            (Some(bytes), Some(digest)) => {
                if codec::digest(&bytes) != digest { return Err(error(ErrorCode::CorruptLedger, "provider-request-capture")); }
                let capture: ProviderRequestCapture = codec::decode(&bytes, 131072).map_err(|_| error(ErrorCode::CorruptLedger, "provider-request-capture"))?;
                let input = load_input(c, parse_id(attempt)?)?;
                validate_request_capture(&input, item, &capture)
                    .map_err(|_| error(ErrorCode::CorruptLedger, "provider-request-capture"))?;
                crate::persistence::validate_team_provider_view_history_in(c, &input, item, capture.team_view.as_ref())
                    .map_err(|_| error(ErrorCode::CorruptLedger, "provider-team-view"))?;
                crate::persistence::application::coordination::validate_provider_view_history_in(
                    c, &input, item, capture.team_work_view.as_ref(),
                ).map_err(|_| error(ErrorCode::CorruptLedger, "provider-team-work-view"))?;
            }
            (None, None) => {
                let input = load_input(c, parse_id(attempt)?)?;
                crate::persistence::validate_team_provider_view_history_in(c, &input, item, None)
                    .map_err(|_| error(ErrorCode::CorruptLedger, "provider-team-view"))?;
                crate::persistence::application::coordination::validate_provider_view_history_in(
                    c, &input, item, None,
                ).map_err(|_| error(ErrorCode::CorruptLedger, "provider-team-work-view"))?;
            }
            _ => return Err(error(ErrorCode::CorruptLedger, "provider-request-capture")),
        }
    }
    Ok(())
}
pub(super) fn recovery_policy(
    c: &Connection,
    attempt: ExecutionId,
) -> Result<RecoveryPolicy, ExecutionError> {
    // Older schemas are validated before migration; all missing old policies are conservative.
    let version: i64 = c
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(sql_error)?;
    if version < 12 {
        return Ok(RecoveryPolicy::ExternalUnknown);
    }
    let policy: String = c
        .query_row(
            "SELECT policy FROM execution_effects WHERE attempt_id=?1",
            [attempt.to_string()],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    decode_enum(policy)
}
pub(super) fn matches_parent(
    c: &Connection,
    task: ExecutionId,
    parent: Option<ExecutionId>,
) -> Result<bool, ExecutionError> {
    let value: Option<Option<String>> = c
        .query_row(
            "SELECT parent_id FROM execution_budgets WHERE task_id=?1",
            [task.to_string()],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    Ok(value.flatten() == parent.map(|p| p.to_string()))
}
pub(super) fn record_input(
    c: &Connection,
    input: &FixedInput,
    policy: RecoveryPolicy,
    parent: Option<ExecutionId>,
) -> Result<(), ExecutionError> {
    let e = input.envelope();
    c.execute(
        "INSERT INTO execution_effects VALUES (?1,?2)",
        params![e.attempt_id.to_string(), encode_enum(policy)?],
    )
    .map_err(sql_error)?;
    let limit = if e.operation == crate::ai::team::OPERATION {
        let settings = crate::ai::team::settings(input)?;
        if policy != RecoveryPolicy::ExternalUnknown
            || settings.config.max_requests > settings.root_request_limit
            || settings.binding.is_root() != parent.is_none()
            || parent.is_some_and(|parent| parent != settings.binding.scope().root_task)
        {
            return Err(error(ErrorCode::Unauthorized, "provider-team-parent"));
        }
        Some(u64::from(team_budget_limit(input)?))
    } else { e
        .settings
        .get("config")
        .and_then(|v| v.get("maxRequests"))
        .and_then(|v| v.as_u64()) };
    if policy != RecoveryPolicy::ExternalUnknown || limit.is_none() {
        if parent.is_some() {
            return Err(error(ErrorCode::Unauthorized, "provider-parent"));
        }
        return Ok(());
    }
    let limit = limit
        .filter(|l| (1..=300).contains(l))
        .ok_or_else(|| error(ErrorCode::LimitExceeded, "ai-budget"))?;
    let existing: Option<(Option<String>, u32)> = c
        .query_row(
            "SELECT parent_id,request_limit FROM execution_budgets WHERE task_id=?1",
            [e.task_id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql_error)?;
    if let Some((old_parent, old_limit)) = existing {
        if old_parent != parent.map(|id| id.to_string()) || old_limit != limit as u32 {
            return Err(error(ErrorCode::ResultMismatch, "ai-budget-identity"));
        }
        return Ok(());
    }
    if let Some(parent) = parent {
        let parent_limit: u32 = c
            .query_row(
                "SELECT request_limit FROM execution_budgets WHERE task_id=?1",
                [parent.to_string()],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        let parent_attempt: String = c.query_row("SELECT attempt_id FROM execution_attempts WHERE task_id=?1 ORDER BY sequence DESC LIMIT 1",[parent.to_string()],|r|r.get(0)).map_err(sql_error)?;
        let parent_input = load_input(c, parse_id(parent_attempt)?)?;
        let inherited = if e.operation == crate::ai::team::OPERATION {
            crate::persistence::application::coordination::validate_provider_parent_in(
                c, input, &parent_input,
            )?;
            true
        } else {
            inherits_configuration(input, &parent_input)
                && e.items.iter().all(|i| {
                    parent_input.envelope().items.iter().any(|p| {
                        p.scope == i.scope
                            && p.dependencies == i.dependencies
                            && p.payload.get("item").unwrap_or(&p.payload)
                                == i.payload.get("item").unwrap_or(&i.payload)
                    })
                })
        };
        if !inherited || limit > parent_limit as u64
            || !super::super::application::allows_cancelled_ancestor(c, input, parent)?
        {
            return Err(error(ErrorCode::Unauthorized, "provider-parent-scope"));
        }
        let depth: u32 = c
            .query_row(
                "SELECT COUNT(*) FROM execution_budget_ancestry WHERE task_id=?1",
                [parent.to_string()],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if depth >= 16 {
            return Err(error(ErrorCode::LimitExceeded, "provider-parent-depth"));
        }
    }
    c.execute(
        "INSERT INTO execution_budgets VALUES (?1,?2,?3,0)",
        params![
            e.task_id.to_string(),
            parent.map(|id| id.to_string()),
            limit as u32
        ],
    )
    .map_err(sql_error)?;
    c.execute(
        "INSERT INTO execution_budget_ancestry VALUES (?1,?1)",
        [e.task_id.to_string()],
    )
    .map_err(sql_error)?;
    if let Some(parent) = parent {
        c.execute("INSERT INTO execution_budget_ancestry SELECT ?1,ancestor_id FROM execution_budget_ancestry WHERE task_id=?2",params![e.task_id.to_string(),parent.to_string()]).map_err(sql_error)?;
    }
    Ok(())
}

// This trusted Core boundary keeps the exact operation, connection, recipe and
// sharing configuration. A child may only reduce numeric scheduling limits.
fn inherits_configuration(child: &FixedInput, parent: &FixedInput) -> bool {
    let (child, parent) = (child.envelope(), parent.envelope());
    if child.operation != parent.operation
        || child.capability_id != parent.capability_id
        || child.capability_version != parent.capability_version
        || child.limits.timeout_ms > parent.limits.timeout_ms
        || child.limits.cancel_wait_ms > parent.limits.cancel_wait_ms
        || child.limits.max_result_bytes > parent.limits.max_result_bytes
        || child.limits.max_attempt_result_bytes > parent.limits.max_attempt_result_bytes
    {
        return false;
    }
    let (mut actual, mut allowed) = (child.settings.clone(), parent.settings.clone());
    if child.operation == crate::ai::OPERATION {
        // Agent provenance narrows a caller; it cannot change model, sharing or
        // any ancestor budget. Decode the complete required shape first.
        let (Ok(mut c), Ok(mut p)) = (
            serde_json::from_value::<crate::ai::AiSettings>(actual.clone()),
            serde_json::from_value::<crate::ai::AiSettings>(allowed.clone()),
        ) else {
            return false;
        };
        c.agent = None;
        p.agent = None;
        let (Ok(c), Ok(p)) = (serde_json::to_value(c), serde_json::to_value(p)) else {
            return false;
        };
        actual = c;
        allowed = p;
    }
    for key in ["maxRequests", "maxItems", "concurrency"] {
        let (Some(c), Some(p)) = (
            actual["config"][key].as_u64(),
            allowed["config"][key].as_u64(),
        ) else {
            return false;
        };
        if c > p {
            return false;
        }
        actual["config"][key] = serde_json::Value::Null;
        allowed["config"][key] = serde_json::Value::Null;
    }
    actual == allowed
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReportedTokenTotal {
    /// Sum of the reliably reported portion; unknown requests are not zeros.
    #[cfg_attr(
        feature = "wire-schema",
        schemars(regex(pattern = "^(0|[1-9][0-9]{0,21})$"))
    )]
    pub tokens: String,
    #[cfg_attr(feature = "wire-schema", schemars(range(max = 300)))]
    pub unknown_requests: u32,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ProviderBudget {
    #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 300)))]
    pub limit: u32,
    #[cfg_attr(feature = "wire-schema", schemars(range(max = 300)))]
    pub dispatched: u32,
    #[cfg_attr(feature = "wire-schema", schemars(range(max = 300)))]
    pub legacy_held: u32,
    #[cfg_attr(feature = "wire-schema", schemars(range(max = 300)))]
    pub unresolved: u32,
    #[cfg_attr(feature = "wire-schema", schemars(range(max = 300)))]
    pub usage_unknown: u32,
    #[cfg_attr(
        feature = "wire-schema",
        schemars(regex(pattern = "^(0|[1-9][0-9]{0,21})$"))
    )]
    pub prompt_tokens: String,
    #[cfg_attr(
        feature = "wire-schema",
        schemars(regex(pattern = "^(0|[1-9][0-9]{0,21})$"))
    )]
    pub completion_tokens: String,
    pub cache_read: ReportedTokenTotal,
    pub cache_write: ReportedTokenTotal,
    pub reasoning: ReportedTokenTotal,
}
pub(crate) fn provider_budget_in(
    c: &Connection,
    task: ExecutionId,
) -> Result<Option<ProviderBudget>, ExecutionError> {
    let limit: Option<u32> = c
        .query_row(
            "SELECT request_limit FROM execution_budgets WHERE task_id=?1",
            [task.to_string()],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    let Some(limit) = limit else { return Ok(None) };
    let mut budget = ProviderBudget {
        limit,
        dispatched: 0,
        legacy_held: 0,
        unresolved: 0,
        usage_unknown: 0,
        prompt_tokens: "0".into(),
        completion_tokens: "0".into(),
        cache_read: ReportedTokenTotal {
            tokens: "0".into(),
            unknown_requests: 0,
        },
        cache_write: ReportedTokenTotal {
            tokens: "0".into(),
            unknown_requests: 0,
        },
        reasoning: ReportedTokenTotal {
            tokens: "0".into(),
            unknown_requests: 0,
        },
    };
    budget.legacy_held=c.query_row("SELECT COALESCE(SUM(b.legacy_held),0) FROM execution_budgets b JOIN execution_budget_ancestry x ON b.task_id=x.task_id WHERE x.ancestor_id=?1",[task.to_string()],|r|r.get(0)).map_err(sql_error)?;
    let (mut prompt, mut completion) = (0u128, 0u128);
    // The original budget permits at most 300 u64 reports, all fitting in u128.
    let mut details = [0u128; 3];
    let mut stmt=c.prepare("SELECT p.state,p.usage FROM execution_provider_requests p JOIN execution_budget_ancestry x ON p.task_id=x.task_id WHERE x.ancestor_id=?1").map_err(sql_error)?;
    for row in stmt
        .query_map([task.to_string()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<Vec<u8>>>(1)?))
        })
        .map_err(sql_error)?
    {
        let (state, bytes) = row.map_err(sql_error)?;
        if budget.dispatched >= limit {
            return Err(error(ErrorCode::CorruptLedger, "provider-budget"));
        }
        budget.dispatched += 1;
        if state == "unknown" {
            budget.unresolved += 1;
        }
        let reported = if let Some(bytes) = bytes {
            let usage = decode_usage(&bytes)?;
            prompt += u128::from(usage.prompt_tokens);
            completion += u128::from(usage.completion_tokens);
            [
                usage.cache_read_tokens,
                usage.cache_write_tokens,
                usage.reasoning_tokens,
            ]
        } else {
            budget.usage_unknown += 1;
            [None; 3]
        };
        for ((sum, total), reported) in details
            .iter_mut()
            .zip([
                &mut budget.cache_read,
                &mut budget.cache_write,
                &mut budget.reasoning,
            ])
            .zip(reported)
        {
            if let Some(reported) = reported {
                *sum += u128::from(reported.get());
            } else {
                total.unknown_requests += 1;
            }
        }
    }
    budget.prompt_tokens = prompt.to_string();
    budget.completion_tokens = completion.to_string();
    for (sum, total) in details.into_iter().zip([
        &mut budget.cache_read,
        &mut budget.cache_write,
        &mut budget.reasoning,
    ]) {
        total.tokens = sum.to_string();
    }
    Ok(Some(budget))
}
impl ProjectStore {
    pub fn provider_budget(
        &self,
        task: ExecutionId,
    ) -> Result<Option<ProviderBudget>, ExecutionError> {
        provider_budget_in(self.execution_connection()?, task)
    }
    #[cfg(test)]
    pub(crate) fn reserve_provider_request(
        &mut self,
        request: &DispatchRequest,
        id: ExecutionId,
        limit: u32,
    ) -> Result<(), ExecutionError> {
        self.reserve_provider_request_capture(request, id, limit, None)
    }
    pub(crate) fn reserve_provider_request_capture(
        &mut self, request: &DispatchRequest, id: ExecutionId, limit: u32,
        capture: Option<&ProviderRequestCapture>,
    ) -> Result<(), ExecutionError> {
        let captured = if let Some(capture) = capture {
            validate_request_capture(&request.input, request.item_id, capture)?;
            Some(codec::encode(capture, 131072)?)
        } else { None };
        let digest = captured.as_ref().map(|bytes| codec::digest(bytes));
        let authority = self.plugin_authority.clone();
        let tx = self.execution_write()?;
        super::super::application::check_input(&tx, &request.input)?;
        super::super::application::check_service_input(&tx, &request.input, &authority)?;
        crate::persistence::validate_team_provider_view_in(
            &tx, request, capture.and_then(|capture| capture.team_view.as_ref()),
        )?;
        crate::persistence::application::coordination::validate_provider_view_in(
            &tx, request, capture.and_then(|capture| capture.team_work_view.as_ref()),
        )?;
        let e = request.input.envelope();
        let ancestors = {
            let mut statement = tx.prepare("SELECT DISTINCT x.ancestor_id FROM execution_budget_ancestry x JOIN execution_cancellations c ON c.task_id=x.ancestor_id WHERE x.task_id=?1").map_err(sql_error)?;
            statement
                .query_map([e.task_id.to_string()], |r| r.get::<_, String>(0))
                .map_err(sql_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_error)?
        };
        for ancestor in ancestors {
            if !super::super::application::allows_cancelled_ancestor(
                &tx,
                &request.input,
                parse_id(ancestor)?,
            )? {
                return Err(error(ErrorCode::Cancelled, "ai-cancelled"));
            }
        }
        let state:(String,String)=tx.query_row("SELECT execution,dispatch_token FROM execution_items WHERE attempt_id=?1 AND item_id=?2",params![e.attempt_id.to_string(),request.item_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql_error)?;
        if state != ("dispatched".into(), request.dispatch_token.to_string()) {
            return Err(error(ErrorCode::Unauthorized, "provider-dispatch"));
        }
        let own: u32 = tx
            .query_row(
                "SELECT request_limit FROM execution_budgets WHERE task_id=?1",
                [e.task_id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if own != limit {
            return Err(error(ErrorCode::ResultMismatch, "ai-budget-identity"));
        }
        if e.operation == crate::ai::team::OPERATION {
            let settings = crate::ai::team::settings(&request.input)?;
            let issued: u32 = tx.query_row(
                "SELECT COUNT(*) FROM execution_provider_requests WHERE task_id=?1",
                [e.task_id.to_string()], |row| row.get(0),
            ).map_err(sql_error)?;
            if issued >= settings.config.max_requests {
                return Err(error(ErrorCode::LimitExceeded, "member-request-limit"));
            }
        }
        let exhausted:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM execution_budget_ancestry x JOIN execution_budgets b ON b.task_id=x.ancestor_id WHERE x.task_id=?1 AND b.request_limit<=b.legacy_held+(SELECT COUNT(*) FROM execution_provider_requests p JOIN execution_budget_ancestry a ON p.task_id=a.task_id WHERE a.ancestor_id=b.task_id))",[e.task_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
        if exhausted {
            return Err(error(ErrorCode::LimitExceeded, "ai-budget"));
        }
        tx.execute(
            "INSERT INTO execution_provider_requests VALUES (?1,?2,?3,?4,?5,'unknown',NULL,?6,?7)",
            params![
                id.to_string(),
                e.task_id.to_string(),
                e.attempt_id.to_string(),
                request.item_id.to_string(),
                request.dispatch_token.to_string(),
                captured, digest
            ],
        )
        .map_err(sql_error)?;
        if let Some(view) = capture.and_then(|capture| capture.team_work_view.as_ref()) {
            crate::persistence::application::coordination::record_consumptions_in(
                &tx, request, id, view,
            )?;
        }
        commit(tx)
    }
    pub(crate) fn settle_provider_request(
        &mut self,
        request: &DispatchRequest,
        id: ExecutionId,
        usage: Option<Usage>,
    ) -> Result<(), ExecutionError> {
        if let Some(usage) = &usage {
            usage.validate()?;
        }
        let tx = self.execution_write()?;
        let bytes = usage.map(|u| codec::encode(&u, 1024)).transpose()?;
        let previous: Option<Vec<u8>> = tx.query_row(
            "SELECT usage FROM execution_provider_requests WHERE request_id=?1 AND attempt_id=?2 AND dispatch_token=?3",
            params![id.to_string(), request.input.envelope().attempt_id.to_string(), request.dispatch_token.to_string()], |row| row.get(0)
        ).optional().map_err(sql_error)?.flatten();
        if previous.as_ref().zip(bytes.as_ref()).is_some_and(|(old, new)| old != new) {
            return Err(error(ErrorCode::ResultMismatch, "provider-usage-conflict"));
        }
        let changed=tx.execute("UPDATE execution_provider_requests SET state='response',usage=COALESCE(?4,usage) WHERE request_id=?1 AND attempt_id=?2 AND dispatch_token=?3",params![id.to_string(),request.input.envelope().attempt_id.to_string(),request.dispatch_token.to_string(),bytes]).map_err(sql_error)?;
        if changed != 1 {
            return Err(error(ErrorCode::ResultMismatch, "provider-reservation"));
        }
        commit(tx)
    }
    pub(crate) fn execution_recovery_policy(
        &self,
        attempt: ExecutionId,
    ) -> Result<RecoveryPolicy, ExecutionError> {
        recovery_policy(self.execution_connection()?, attempt)
    }
}
