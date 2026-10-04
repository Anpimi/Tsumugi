//! Durable dispatch evidence lives beside the existing execution ledger.
use super::*;
use crate::ai::Usage;

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
        "CREATE TABLE execution_provider_requests (request_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES execution_budgets(task_id), attempt_id TEXT NOT NULL, item_id TEXT NOT NULL, dispatch_token TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('unknown','response')), usage BLOB CHECK(usage IS NULL OR length(usage) BETWEEN 1 AND 1024), FOREIGN KEY(attempt_id,item_id,dispatch_token) REFERENCES execution_items(attempt_id,item_id,dispatch_token))",
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
pub(crate) fn migrate(c: &mut Connection) -> rusqlite::Result<()> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    initialize(&tx)?;
    // Old evidence cannot prove that an arbitrary producer is safe to replay.
    tx.execute("INSERT INTO execution_effects SELECT attempt_id,'external-unknown' FROM execution_attempts", [])?;
    let tasks = {
        let mut statement = tx.prepare("SELECT task_id FROM execution_tasks")?;
        statement
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for task in tasks {
        let latest:String=tx.query_row("SELECT attempt_id FROM execution_attempts WHERE task_id=?1 ORDER BY sequence DESC LIMIT 1",[&task],|r|r.get(0))?;
        let input = load_input(
            &tx,
            parse_id(latest).map_err(|_| rusqlite::Error::InvalidQuery)?,
        )
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
        if let Some(limit) = input
            .envelope()
            .settings
            .get("config")
            .and_then(|v| v.get("maxRequests"))
            .and_then(|v| v.as_u64())
            .filter(|n| (1..=300).contains(n))
        {
            let dispatched:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM execution_items i JOIN execution_attempts a USING(attempt_id) WHERE a.task_id=?1 AND i.dispatch_token IS NOT NULL)",[&task],|r|r.get(0))?;
            // Older ledgers did not record each HTTP retry. Hold the full possible
            // remaining exposure instead of inventing an exact dispatch count.
            tx.execute(
                "INSERT INTO execution_budgets VALUES (?1,NULL,?2,?3)",
                params![
                    task,
                    limit as u32,
                    if dispatched { limit as u32 } else { 0 }
                ],
            )?;
            tx.execute(
                "INSERT INTO execution_budget_ancestry VALUES (?1,?1)",
                [task],
            )?;
        }
    }
    tx.pragma_update(None, "user_version", 12)?;
    validate(&tx).map_err(|_| rusqlite::Error::InvalidQuery)?;
    #[cfg(test)]
    super::super::migration_crash_hook("before-provider-migration-commit");
    tx.commit()?;
    #[cfg(test)]
    super::super::migration_crash_hook("after-provider-migration-commit");
    Ok(())
}
#[cfg(test)]
pub(crate) fn drop_for_legacy_fixture(c: &Connection) -> rusqlite::Result<()> {
    for (name, _) in TABLES.iter().rev() {
        c.execute_batch(&format!("DROP TABLE IF EXISTS {name}"))?;
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
        .prepare("SELECT task_id,parent_id,request_limit FROM execution_budgets")
        .map_err(sql_error)?;
    for member in members
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, u32>(2)?,
            ))
        })
        .map_err(sql_error)?
    {
        let (task, parent, limit) = member.map_err(sql_error)?;
        parse_id(task.clone())?;
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
        .prepare("SELECT request_id,usage FROM execution_provider_requests")
        .map_err(sql_error)?;
    for row in statement
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<Vec<u8>>>(1)?))
        })
        .map_err(sql_error)?
    {
        let (id, bytes) = row.map_err(sql_error)?;
        parse_id(id)?;
        if let Some(bytes) = bytes {
            let _: Usage = codec::decode(&bytes, 1024)?;
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
    let limit = e
        .settings
        .get("config")
        .and_then(|v| v.get("maxRequests"))
        .and_then(|v| v.as_u64());
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
        if !inherits_configuration(input, &parent_input)
            || limit > parent_limit as u64
            || cancel_revision(c, parent)?.get() > 0
            || !e.items.iter().all(|i| {
                parent_input.envelope().items.iter().any(|p| {
                    p.scope == i.scope
                        && p.payload.get("item").unwrap_or(&p.payload)
                            == i.payload.get("item").unwrap_or(&i.payload)
                })
            })
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
}
impl ProjectStore {
    pub fn provider_budget(
        &self,
        task: ExecutionId,
    ) -> Result<Option<ProviderBudget>, ExecutionError> {
        let c = self.execution_connection()?;
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
        };
        budget.legacy_held=c.query_row("SELECT COALESCE(SUM(b.legacy_held),0) FROM execution_budgets b JOIN execution_budget_ancestry x ON b.task_id=x.task_id WHERE x.ancestor_id=?1",[task.to_string()],|r|r.get(0)).map_err(sql_error)?;
        let (mut prompt, mut completion) = (0u128, 0u128);
        let mut stmt=c.prepare("SELECT p.state,p.usage FROM execution_provider_requests p JOIN execution_budget_ancestry x ON p.task_id=x.task_id WHERE x.ancestor_id=?1").map_err(sql_error)?;
        for row in stmt
            .query_map([task.to_string()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<Vec<u8>>>(1)?))
            })
            .map_err(sql_error)?
        {
            let (state, bytes) = row.map_err(sql_error)?;
            budget.dispatched += 1;
            if state == "unknown" {
                budget.unresolved += 1;
            }
            if let Some(bytes) = bytes {
                let usage: Usage = codec::decode(&bytes, 1024)?;
                prompt += u128::from(usage.prompt_tokens);
                completion += u128::from(usage.completion_tokens);
            } else {
                budget.usage_unknown += 1;
            }
        }
        budget.prompt_tokens = prompt.to_string();
        budget.completion_tokens = completion.to_string();
        Ok(Some(budget))
    }
    pub(crate) fn reserve_provider_request(
        &mut self,
        request: &DispatchRequest,
        id: ExecutionId,
        limit: u32,
    ) -> Result<(), ExecutionError> {
        let tx = self.execution_write()?;
        let e = request.input.envelope();
        let cancelled:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM execution_budget_ancestry x JOIN execution_cancellations c ON c.task_id=x.ancestor_id WHERE x.task_id=?1)",[e.task_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
        if cancelled {
            return Err(error(ErrorCode::Cancelled, "ai-cancelled"));
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
        let exhausted:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM execution_budget_ancestry x JOIN execution_budgets b ON b.task_id=x.ancestor_id WHERE x.task_id=?1 AND b.request_limit<=b.legacy_held+(SELECT COUNT(*) FROM execution_provider_requests p JOIN execution_budget_ancestry a ON p.task_id=a.task_id WHERE a.ancestor_id=b.task_id))",[e.task_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
        if exhausted {
            return Err(error(ErrorCode::LimitExceeded, "ai-budget"));
        }
        tx.execute(
            "INSERT INTO execution_provider_requests VALUES (?1,?2,?3,?4,?5,'unknown',NULL)",
            params![
                id.to_string(),
                e.task_id.to_string(),
                e.attempt_id.to_string(),
                request.item_id.to_string(),
                request.dispatch_token.to_string()
            ],
        )
        .map_err(sql_error)?;
        commit(tx)
    }
    pub(crate) fn settle_provider_request(
        &mut self,
        request: &DispatchRequest,
        id: ExecutionId,
        usage: Option<Usage>,
    ) -> Result<(), ExecutionError> {
        let tx = self.execution_write()?;
        let bytes = usage.map(|u| codec::encode(&u, 1024)).transpose()?;
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
