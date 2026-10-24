//! Human decisions overlay one checked source fact; original exchange bytes stay immutable.
use super::source_context_selection::select_source_context_excluding;
use super::*;
use tsumugi_plugin_sdk as sdk;

const MAX_DECISIONS: usize = 128;
const MAX_CAPTURE: usize = 32 * 1024;
pub(super) const TABLE: (&str, &str) = (
    "context_fact_decisions",
    "CREATE TABLE context_fact_decisions (action_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, unit_id TEXT NOT NULL REFERENCES source_units(unit_id), locale TEXT NOT NULL, source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id), source_revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id), block_index INTEGER NOT NULL CHECK(block_index>=0), fact_id TEXT NOT NULL, previous_action_id TEXT REFERENCES context_fact_decisions(action_id), request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 131072), request_digest TEXT NOT NULL CHECK(length(request_digest)=64))",
);
const INDEX: &str = "CREATE INDEX context_fact_scope ON context_fact_decisions (unit_id,locale,source_snapshot_id,block_index,fact_id)";
pub(super) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(INDEX)
}
fn invalid(stage: &str) -> ExecutionError {
    failure(ErrorCode::InvalidInput, stage)
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextFactPosition {
    pub block_index: u32,
    pub fact_index: u32,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFactBasis {
    pub scope: SourceContextRequest,
    pub source_result_id: ExecutionId,
    pub source_result_digest: String,
    pub fact: SelectedSourceFact,
}
impl SourceFactBasis {
    pub fn from_view(
        view: &SourceContextView,
        block_index: u32,
        fact_index: u32,
    ) -> Result<Self, ExecutionError> {
        let block = view
            .blocks
            .iter()
            .find(|b| b.block_index == block_index)
            .ok_or_else(|| invalid("context-fact-basis"))?;
        let fact = block
            .facts
            .as_ref()
            .and_then(|v| v.facts.get(fact_index as usize))
            .ok_or_else(|| invalid("context-fact-basis"))?;
        Ok(Self {
            scope: view.scope.clone(),
            source_result_id: view.source_result_id,
            source_result_digest: view.source_result_digest.clone(),
            fact: SelectedSourceFact {
                block_index,
                fact_index,
                target: block.target.clone(),
                schema: block.schema.clone(),
                handling: block.handling,
                in_revision_basis: block.in_revision_basis,
                fact: fact.clone(),
            },
        })
    }
    fn valid(&self) -> bool {
        self.source_result_digest.len() == 64
            && self
                .source_result_digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && self.fact.schema == sdk::source_context_facts_contract()
            && self.fact.block_index < sdk::MAX_CONTENT_DOMAIN_BLOCKS as u32
            && self.fact.fact_index < sdk::MAX_SOURCE_CONTEXT_FACTS as u32
            && (sdk::SourceContextFacts {
                facts: vec![self.fact.fact.clone()],
            })
            .validate()
            .is_ok()
            && crate::Locale::parse(&self.scope.locale)
                .is_ok_and(|l| l.as_str() == self.scope.locale)
    }
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ContextFactDisposition {
    Replace { text: String },
    RejectInference,
    Restore,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextFactWrite {
    pub action_id: ExecutionId,
    pub basis: SourceFactBasis,
    pub expected_decision_id: Option<ExecutionId>,
    pub disposition: ContextFactDisposition,
    pub actor: String,
    pub reason: String,
}
impl ContextFactWrite {
    fn valid(&self) -> bool {
        let text = |s: &str, max| !s.trim().is_empty() && s == s.trim() && s.len() <= max;
        self.basis.valid()
            && self.expected_decision_id != Some(self.action_id)
            && text(&self.actor, 512)
            && text(&self.reason, 4096)
            && match &self.disposition {
                ContextFactDisposition::Replace { text: value } => {
                    !value.trim().is_empty() && value.len() <= 4096
                }
                ContextFactDisposition::RejectInference => matches!(
                    self.basis.fact.fact.origin,
                    sdk::SourceContextFactOrigin::Inferred { .. }
                ),
                ContextFactDisposition::Restore => self.expected_decision_id.is_some(),
            }
    }
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextFactDecision {
    pub request: ContextFactWrite,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextFactHistory {
    pub rows: Vec<ContextFactDecision>,
    pub next_offset: Option<u32>,
}

fn load(
    c: &Connection,
    action: ExecutionId,
) -> Result<Option<ContextFactDecision>, ExecutionError> {
    let row: Option<(String,String,String,String,String,u32,String,Option<String>,Vec<u8>,String)> = c.query_row(
        "SELECT project_id,unit_id,locale,source_snapshot_id,source_revision_id,block_index,fact_id,previous_action_id,request,request_digest FROM context_fact_decisions WHERE action_id=?1", [action.to_string()],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?))).optional().map_err(sql)?;
    let Some((project, unit, locale, snapshot, revision, block, fact, previous, bytes, hash)) = row
    else {
        return Ok(None);
    };
    let request: ContextFactWrite = codec::decode(&bytes, 128 * 1024)?;
    let scope = &request.basis.scope;
    if codec::digest(&bytes) != hash
        || !request.valid()
        || request.action_id != action
        || scope.project_id.to_string() != project
        || scope.unit_id.to_string() != unit
        || scope.locale != locale
        || scope.source_snapshot_id.to_string() != snapshot
        || scope.source_revision_id.to_string() != revision
        || request.basis.fact.block_index != block
        || request.basis.fact.fact.id != fact
        || request.expected_decision_id.map(|v| v.to_string()) != previous
    {
        return Err(failure(ErrorCode::CorruptLedger, "context-fact-receipt"));
    }
    Ok(Some(ContextFactDecision { request }))
}
fn latest(
    c: &Connection,
    basis: &SourceFactBasis,
) -> Result<Option<ContextFactDecision>, ExecutionError> {
    let scope = &basis.scope;
    let action: Option<String>=c.query_row("SELECT action_id FROM context_fact_decisions WHERE unit_id=?1 AND locale=?2 AND source_snapshot_id=?3 AND block_index=?4 AND fact_id=?5 ORDER BY rowid DESC LIMIT 1",
        params![scope.unit_id.to_string(),scope.locale,scope.source_snapshot_id.to_string(),basis.fact.block_index,basis.fact.fact.id], |r|r.get(0)).optional().map_err(sql)?;
    let value = action
        .map(|id| {
            load(c, super::id(id)?).and_then(|v| {
                v.ok_or_else(|| failure(ErrorCode::CorruptLedger, "context-fact-receipt"))
            })
        })
        .transpose()?;
    if value.as_ref().is_some_and(|v| v.request.basis != *basis) {
        return Err(failure(ErrorCode::CorruptLedger, "context-fact-basis"));
    }
    Ok(value)
}
pub(in crate::persistence) fn current_in(
    c: &Connection,
    view: &SourceContextView,
) -> Result<Vec<ContextFactDecision>, ExecutionError> {
    let mut query=c.prepare("SELECT d.action_id FROM context_fact_decisions d WHERE d.unit_id=?1 AND d.locale=?2 AND d.source_snapshot_id=?3 AND NOT EXISTS (SELECT 1 FROM context_fact_decisions n WHERE n.unit_id=d.unit_id AND n.locale=d.locale AND n.source_snapshot_id=d.source_snapshot_id AND n.block_index=d.block_index AND n.fact_id=d.fact_id AND n.rowid>d.rowid) ORDER BY d.block_index,d.fact_id LIMIT 129").map_err(sql)?;
    let ids = query
        .query_map(
            params![
                view.scope.unit_id.to_string(),
                view.scope.locale,
                view.scope.source_snapshot_id.to_string()
            ],
            |r| r.get::<_, String>(0),
        )
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    if ids.len() > MAX_DECISIONS {
        return Err(failure(ErrorCode::LimitExceeded, "context-fact-budget"));
    }
    let mut values = ids
        .into_iter()
        .map(|raw| {
            let value = load(c, id(raw)?)?
                .ok_or_else(|| failure(ErrorCode::CorruptLedger, "context-fact-receipt"))?;
            let actual = SourceFactBasis::from_view(
                view,
                value.request.basis.fact.block_index,
                value.request.basis.fact.fact_index,
            )?;
            if actual != value.request.basis {
                return Err(failure(ErrorCode::CorruptLedger, "context-fact-basis"));
            }
            Ok(value)
        })
        .collect::<Result<Vec<_>, ExecutionError>>()?;
    values.sort_by_key(|v| {
        (
            v.request.basis.fact.block_index,
            v.request.basis.fact.fact_index,
        )
    });
    Ok(values)
}
pub(super) fn validate(c: &Connection) -> rusqlite::Result<()> {
    let ddl: String = c.query_row(
        "SELECT sql FROM sqlite_master WHERE name='context_fact_decisions'",
        [],
        |r| r.get(0),
    )?;
    let index: String = c.query_row(
        "SELECT sql FROM sqlite_master WHERE name='context_fact_scope'",
        [],
        |r| r.get(0),
    )?;
    if ddl != TABLE.1 || index != INDEX {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let mut sources = BTreeMap::new();
    let mut latest_decisions = BTreeMap::new();
    let mut q = c.prepare("SELECT action_id FROM context_fact_decisions ORDER BY rowid")?;
    for row in q.query_map([], |r| r.get::<_, String>(0))? {
        let request = load(c, id(row?).map_err(|_| rusqlite::Error::InvalidQuery)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?
            .ok_or(rusqlite::Error::InvalidQuery)?
            .request;
        let scope = &request.basis.scope;
        check_unit(c, scope.project_id, scope.unit_id)
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        let key = (scope.source_snapshot_id.to_string(), scope.locale.clone());
        if !sources.contains_key(&key) {
            sources.insert(
                key.clone(),
                SourceContextReader::historical_in(c, scope)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
            );
        }
        let view = sources
            .get(&key)
            .ok_or(rusqlite::Error::InvalidQuery)?
            .project(scope)
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        if SourceFactBasis::from_view(
            &view,
            request.basis.fact.block_index,
            request.basis.fact.fact_index,
        )
        .map_err(|_| rusqlite::Error::InvalidQuery)?
            != request.basis
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let fact_key = (
            scope.project_id,
            scope.unit_id,
            scope.locale.clone(),
            scope.source_snapshot_id,
            scope.source_revision_id,
            request.basis.fact.block_index,
            request.basis.fact.fact.id.clone(),
        );
        // Reopening must preserve the same per-fact CAS order as writes. A
        // same-basis predecessor alone would also admit forks and forward cycles.
        if latest_decisions.get(&fact_key).copied() != request.expected_decision_id {
            return Err(rusqlite::Error::InvalidQuery);
        }
        latest_decisions.insert(fact_key, request.action_id);
    }
    Ok(())
}
impl ProjectStore {
    pub fn context_fact_action(
        &self,
        project: ExecutionId,
        action: ExecutionId,
    ) -> Result<Option<ContextFactDecision>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "context-fact-read"))?;
        let value = load(c, action)?;
        if value
            .as_ref()
            .is_some_and(|v| v.request.basis.scope.project_id != project)
        {
            return Err(failure(ErrorCode::Unauthorized, "context-fact-project"));
        }
        if self
            .execution_unknown
            .load(std::sync::atomic::Ordering::Acquire)
        {
            self.reconcile_execution()?;
        }
        Ok(value)
    }
    pub fn context_fact_decisions(
        &self,
        scope: &SourceContextRequest,
        facts: &[ContextFactPosition],
    ) -> Result<Vec<ContextFactDecision>, ExecutionError> {
        if facts.len() > 128 || facts.iter().collect::<BTreeSet<_>>().len() != facts.len() {
            return Err(invalid("context-fact-read-page"));
        }
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "context-fact-read"))?;
        super::super::review::read_snapshot(c, |c| {
            let view =
                SourceContextReader::read_in(c, scope.project_id, &scope.locale)?.project(scope)?;
            let mut values = Vec::new();
            for position in facts {
                let basis =
                    SourceFactBasis::from_view(&view, position.block_index, position.fact_index)?;
                if let Some(value) = latest(c, &basis)? {
                    values.push(value);
                }
            }
            Ok(values)
        })
    }
    pub fn context_fact_history(
        &self,
        project: ExecutionId,
        unit: ExecutionId,
        locale: &str,
        offset: u32,
        limit: u32,
    ) -> Result<ContextFactHistory, ExecutionError> {
        if limit == 0 || limit > 100 {
            return Err(invalid("context-fact-page"));
        }
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "context-fact-read"))?;
        super::super::review::read_snapshot(c, |c| {
            check_project(c, project, locale)?;
            check_unit(c, project, unit)?;
            let mut query=c.prepare("SELECT action_id FROM context_fact_decisions WHERE project_id=?1 AND unit_id=?2 AND locale=?3 ORDER BY rowid DESC LIMIT ?4 OFFSET ?5").map_err(sql)?;
            let ids = query
                .query_map(
                    params![
                        project.to_string(),
                        unit.to_string(),
                        locale,
                        limit + 1,
                        offset
                    ],
                    |r| r.get::<_, String>(0),
                )
                .map_err(sql)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql)?;
            let more = ids.len() > limit as usize;
            let rows = ids
                .into_iter()
                .take(limit as usize)
                .map(|raw| {
                    load(c, id(raw)?).and_then(|v| {
                        v.ok_or_else(|| failure(ErrorCode::CorruptLedger, "context-fact-history"))
                    })
                })
                .collect::<Result<_, _>>()?;
            Ok(ContextFactHistory {
                rows,
                next_offset: if more {
                    Some(
                        offset
                            .checked_add(limit)
                            .ok_or_else(|| invalid("context-fact-page"))?,
                    )
                } else {
                    None
                },
            })
        })
    }
    pub fn decide_context_fact(
        &mut self,
        request: &ContextFactWrite,
    ) -> Result<ContextFactDecision, ExecutionError> {
        if !request.valid() {
            return Err(invalid("context-fact-input"));
        }
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "context-fact-session"));
        }
        let bytes = codec::encode(request, 128 * 1024)?;
        let clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "context-fact-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let observer = clock.observe(&tx, super::super::ChangeScope::Resources);
        if let Some(prior) = load(&tx, request.action_id)? {
            if prior.request != *request {
                return Err(failure(ErrorCode::ResultMismatch, "context-fact-action"));
            }
            return Ok(prior);
        }
        let scope = &request.basis.scope;
        let view =
            SourceContextReader::read_in(&tx, scope.project_id, &scope.locale)?.project(scope)?;
        if SourceFactBasis::from_view(
            &view,
            request.basis.fact.block_index,
            request.basis.fact.fact_index,
        )? != request.basis
        {
            return Err(failure(ErrorCode::DependencyConflict, "context-fact-basis"));
        }
        let current = latest(&tx, &request.basis)?;
        if current.as_ref().map(|v| v.request.action_id) != request.expected_decision_id {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "context-fact-current",
            ));
        }
        tx.execute(
            "INSERT INTO context_fact_decisions VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                request.action_id.to_string(),
                scope.project_id.to_string(),
                scope.unit_id.to_string(),
                scope.locale,
                scope.source_snapshot_id.to_string(),
                scope.source_revision_id.to_string(),
                request.basis.fact.block_index,
                request.basis.fact.fact.id,
                request.expected_decision_id.map(|v| v.to_string()),
                bytes,
                codec::digest(&bytes)
            ],
        )
        .map_err(sql)?;
        write_change(
            &tx,
            scope.project_id,
            "context-fact",
            &scope.locale,
            Some(scope.unit_id),
            Some(scope.unit_id),
            None,
            None,
            request.expected_decision_id,
            request.action_id,
            request.action_id,
        )?;
        observer.commit(tx).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "context-fact-commit")
        })?;
        Ok(ContextFactDecision {
            request: request.clone(),
        })
    }
}

/// Pinned local decisions are separate from raw SDK facts and the provider projection.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ProjectFactCapture {
    NotSelected,
    Selected {
        scope: SourceContextRequest,
        manual: bool,
        decisions: Vec<ContextFactDecision>,
    },
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualContextFact {
    pub kind: sdk::SourceContextFactKind,
    pub text: String,
    pub origin: String,
}
impl ProjectFactCapture {
    pub(in crate::persistence) fn capture(
        view: &SourceContextView,
        decisions: &[ContextFactDecision],
        config: &crate::ai::AiConfig,
    ) -> Result<(Self, SourceContextCapture), ExecutionError> {
        let selected = if config.share_context
            || config.source_context.extracted
            || config.source_context.inferred
        {
            Self::Selected {
                scope: view.scope.clone(),
                manual: config.share_context,
                // Pin the whole exact decision query, including its empty result.
                // Sharing gates only provider projection, never local receipt evidence.
                decisions: decisions.to_vec(),
            }
        } else {
            Self::NotSelected
        };
        if codec::encode(&selected, MAX_CAPTURE).is_err() {
            return Err(failure(
                ErrorCode::LimitExceeded,
                "context-fact-capture-budget",
            ));
        }
        let suppressed = selected
            .decisions()
            .iter()
            .filter(|v| !matches!(v.request.disposition, ContextFactDisposition::Restore))
            .map(|v| {
                (
                    v.request.basis.fact.block_index,
                    v.request.basis.fact.fact_index,
                )
            })
            .collect();
        let raw = select_source_context_excluding(view, &config.source_context, &suppressed)?;
        selected.validate(config, &view.scope, &raw)?;
        Ok((selected, raw))
    }
    fn decisions(&self) -> &[ContextFactDecision] {
        match self {
            Self::NotSelected => &[],
            Self::Selected { decisions, .. } => decisions,
        }
    }
    pub fn manual_projection(&self, share: bool) -> Vec<ManualContextFact> {
        if !share {
            return vec![];
        }
        self.decisions()
            .iter()
            .filter_map(|v| match &v.request.disposition {
                ContextFactDisposition::Replace { text } => Some(ManualContextFact {
                    kind: v.request.basis.fact.fact.kind,
                    text: text.clone(),
                    origin: "manual".into(),
                }),
                _ => None,
            })
            .collect()
    }
    pub fn validate(
        &self,
        config: &crate::ai::AiConfig,
        scope: &SourceContextRequest,
        raw: &SourceContextCapture,
    ) -> Result<(), ExecutionError> {
        let required = config.share_context
            || config.source_context.extracted
            || config.source_context.inferred;
        match self {
            Self::NotSelected if !required => return Ok(()),
            Self::Selected {
                scope: actual,
                manual,
                ..
            } if required && actual == scope && *manual == config.share_context => {}
            _ => return Err(invalid("context-fact-capture")),
        }
        let mut positions = BTreeSet::new();
        let mut previous = None;
        for v in self.decisions() {
            let position = (
                v.request.basis.fact.block_index,
                v.request.basis.fact.fact_index,
            );
            if previous.is_some_and(|last| last >= position) {
                return Err(invalid("context-fact-capture"));
            }
            previous = Some(position);
            if !v.request.valid()
                || v.request.basis.scope != *scope
                || !positions.insert((
                    v.request.basis.fact.block_index,
                    v.request.basis.fact.fact_index,
                ))
            {
                return Err(invalid("context-fact-capture"));
            }
            if !matches!(v.request.disposition, ContextFactDisposition::Restore)
                && matches!(raw,SourceContextCapture::Selected {value} if value.facts.iter().any(|f|f.block_index==v.request.basis.fact.block_index && f.fact_index==v.request.basis.fact.fact_index))
            {
                return Err(invalid("context-fact-capture"));
            }
        }
        if positions.len() > MAX_DECISIONS || codec::encode(self, MAX_CAPTURE).is_err() {
            return Err(failure(
                ErrorCode::LimitExceeded,
                "context-fact-capture-budget",
            ));
        }
        Ok(())
    }
}

/// Validate pinned actions against retained receipts, never against their latest/live state.
pub(in crate::persistence) fn verify_input_records(
    c: &Connection,
    input: &crate::execution::FixedInput,
) -> Result<(), ExecutionError> {
    let arena = input.envelope().operation == crate::ai::arena::OPERATION;
    let semantic = input.envelope().operation == crate::ai::semantic_review::OPERATION;
    if !arena && !semantic && !matches!(input.envelope().operation.as_str(),
        crate::ai::OPERATION | crate::ai::team::OPERATION) {
        return Ok(());
    }
    for slot in &input.envelope().items {
        let item = if arena {
            crate::ai::arena::item_payload(input, slot.item_id)?.item
        } else if semantic {
            crate::ai::semantic_review::item_payload(input, slot.item_id)?.source
        } else {
            crate::ai::item_payload(input, slot.item_id)?
        };
        for captured in item.project_context.decisions() {
            if load(c, captured.request.action_id)?.as_ref() != Some(captured) {
                return Err(failure(
                    ErrorCode::CorruptLedger,
                    "context-fact-capture-record",
                ));
            }
        }
    }
    Ok(())
}
