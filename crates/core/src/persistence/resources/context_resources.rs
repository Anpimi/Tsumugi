//! Typed human context shares the original context revision and current authority.
use super::*;

pub const MAX_CONTEXT_RESOURCE_FILES: usize = 128;
pub const MAX_CONTEXT_RESOURCE_NAME_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ContextResourceKind {
    Character,
    Style,
    Background,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ContextResourceScope {
    Project,
    FileGroup {
        namespace: String,
        logical_paths: Vec<String>,
    },
    Unit {
        unit_id: ExecutionId,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SaveContextResource {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub context_id: Option<ExecutionId>,
    /// Only an explicit scoped variant reuses an existing subject.
    pub subject_id: Option<ExecutionId>,
    pub expected_revision_id: Option<ExecutionId>,
    pub source_basis: crate::content::ContentScope,
    pub kind: ContextResourceKind,
    pub locale: String,
    pub scope: ContextResourceScope,
    pub name: String,
    pub text: String,
    pub actor: String,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WithdrawContextResource {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub context_id: ExecutionId,
    pub expected_revision_id: ExecutionId,
    pub actor: String,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ContextResourceAction {
    Save(SaveContextResource),
    Withdraw(WithdrawContextResource),
    ProposalAdoption(crate::application::ContextResourceProposalAction),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextResourceRevision {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_origin: Option<crate::application::ContextResourceProposalOrigin>,
    pub revision_id: ExecutionId,
    pub context_id: ExecutionId,
    pub subject_id: ExecutionId,
    pub project_id: ExecutionId,
    pub kind: ContextResourceKind,
    pub locale: String,
    pub scope: ContextResourceScope,
    pub name: String,
    pub text: String,
    pub source_basis: crate::content::ContentScope,
    pub withdrawn: bool,
    pub actor: String,
    pub reason: String,
    pub action_id: ExecutionId,
    pub previous_revision_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextResourceActionRead {
    pub request: ContextResourceAction,
    pub receipt: ContextResourceRevision,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ContextResourceRecoveryStatus {
    Recorded,
    RetryAllowed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextResourceRecovery {
    pub request: ContextResourceAction,
    pub status: ContextResourceRecoveryStatus,
    pub receipt: Option<ContextResourceRevision>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextResourcePage {
    pub basis: String,
    pub rows: Vec<ContextResourceRevision>,
    pub next_offset: Option<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ContextResourceStatus {
    Selected,
    Withdrawn,
    Conflict,
    Ambiguous,
    MissingFiles,
    Shadowed,
    OutsideScope,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextResourceResolutionEntry {
    pub revision: ContextResourceRevision,
    pub status: ContextResourceStatus,
    pub missing_paths: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextResourceResolution {
    pub scope: SourceContextRequest,
    pub entries: Vec<ContextResourceResolutionEntry>,
}

/// Historical captures omit this field when empty so old input encoding stays stable.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextResourceCapture {
    pub scope: SourceContextRequest,
    pub entries: Vec<ContextResourceResolutionEntry>,
}

const MAX_RECORD: usize = 64 * 1024;
const MAX_RESOLUTION: usize = 1024 * 1024;
const MAX_CURRENT: usize = 512;

impl ContextResourceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Character => "character",
            Self::Style => "style",
            Self::Background => "background",
        }
    }
}
impl ContextResourceAction {
    fn project(&self) -> ExecutionId {
        match self {
            Self::Save(r) => r.project_id,
            Self::Withdraw(r) => r.project_id,
            Self::ProposalAdoption(r) => r.proposal.project_id,
        }
    }
    fn action(&self) -> ExecutionId {
        match self {
            Self::Save(r) => r.action_id,
            Self::Withdraw(r) => r.action_id,
            Self::ProposalAdoption(r) => r.action_id,
        }
    }
}
impl ContextResourceScope {
    fn rank(&self) -> u8 {
        match self {
            Self::Project => 0,
            Self::FileGroup { .. } => 1,
            Self::Unit { .. } => 2,
        }
    }
    fn valid(&self) -> bool {
        match self {
            Self::Project | Self::Unit { .. } => true,
            Self::FileGroup {
                namespace,
                logical_paths,
            } => {
                !namespace.trim().is_empty()
                    && namespace.len() <= 512
                    && !namespace.contains('\0')
                    && !logical_paths.is_empty()
                    && logical_paths.len() <= MAX_CONTEXT_RESOURCE_FILES
                    && logical_paths.iter().map(String::len).sum::<usize>() <= 8192
                    && logical_paths.windows(2).all(|w| w[0] < w[1])
                    && logical_paths
                        .iter()
                        .all(|p| tsumugi_plugin_sdk::validate_package_path(p).is_ok())
            }
        }
    }
}
fn checked_fields(name: &str, text: &str, actor: &str, reason: &str) -> Result<(), ExecutionError> {
    validate_text(text, false)?;
    for (value, limit) in [
        (name, MAX_CONTEXT_RESOURCE_NAME_BYTES),
        (actor, 512),
        (reason, 4096),
    ] {
        if value.trim().is_empty() || value.len() > limit || value.contains('\0') {
            return Err(failure(ErrorCode::InvalidInput, "context-resource-field"));
        }
    }
    Ok(())
}
fn read_revision(
    c: &Connection,
    revision: ExecutionId,
) -> Result<Option<ContextResourceActionRead>, ExecutionError> {
    let row: Option<(String, String, String, String, String, String, String, String, Option<String>, String)> = c.query_row(
        "SELECT project_id,context_id,subject_id,resource_kind,locale,text,reason,record_json,previous_revision_id,request_digest FROM context_revisions WHERE revision_id=?1 AND context_id IS NOT NULL",
        [revision.to_string()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?)),
    ).optional().map_err(sql)?;
    let Some((project, context, subject, kind, locale, text, reason, record, previous, hash)) = row
    else {
        return Ok(None);
    };
    let value: ContextResourceActionRead = codec::decode(record.as_bytes(), MAX_RECORD)?;
    let v = &value.receipt;
    if v.revision_id != revision
        || v.project_id.to_string() != project
        || v.context_id.to_string() != context
        || v.subject_id.to_string() != subject
        || v.kind.as_str() != kind
        || v.locale != locale
        || v.text != text
        || v.reason != reason
        || v.previous_revision_id.map(|v| v.to_string()) != previous
        || value.request.project() != v.project_id
        || value.request.action() != v.action_id
        || digest(&value.request)? != hash
        || !v.scope.valid()
        || checked_fields(&v.name, &v.text, &v.actor, &v.reason).is_err()
    {
        return Err(failure(ErrorCode::CorruptLedger, "context-resource-record"));
    }
    match &value.request {
        ContextResourceAction::Save(r)
            if r.context_id.is_none_or(|id| id == v.context_id)
                && r.subject_id.is_none_or(|id| id == v.subject_id)
                && r.kind == v.kind
                && r.locale == v.locale
                && r.scope == v.scope
                && r.name == v.name
                && r.text == v.text
                && r.actor == v.actor
                && r.reason == v.reason
                && r.source_basis == v.source_basis
                && r.expected_revision_id == v.previous_revision_id
                && !v.withdrawn => {}
        ContextResourceAction::Withdraw(r)
            if r.context_id == v.context_id
                && Some(r.expected_revision_id) == v.previous_revision_id
                && r.actor == v.actor
                && r.reason == v.reason
                && v.withdrawn => {}
        ContextResourceAction::ProposalAdoption(r)
            if !v.withdrawn
                && v.proposal_origin.as_ref().is_some_and(|o| {
                    o.proposal == r.proposal && o.entry_index == r.entry_index
                }) => {}
        _ => {
            return Err(failure(
                ErrorCode::CorruptLedger,
                "context-resource-request",
            ));
        }
    }
    Ok(Some(value))
}
fn current(
    c: &Connection,
    project: ExecutionId,
    context: ExecutionId,
) -> Result<Option<ContextResourceRevision>, ExecutionError> {
    let raw: Option<String> = c
        .query_row(
            "SELECT revision_id FROM context_current WHERE context_id=?1",
            [context.to_string()],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    let Some(raw) = raw else { return Ok(None) };
    let value = read_revision(c, id(raw)?)?
        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "context-resource-current"))?
        .receipt;
    if value.project_id != project || value.context_id != context {
        return Err(failure(ErrorCode::Unauthorized, "context-resource-project"));
    }
    Ok(Some(value))
}
fn by_action(
    c: &Connection,
    project: ExecutionId,
    action: ExecutionId,
) -> Result<Option<ContextResourceActionRead>, ExecutionError> {
    check_action_project(c, project)?;
    let raw: Option<String> = c.query_row("SELECT revision_id FROM context_revisions WHERE action_id=?1 AND context_id IS NOT NULL",[action.to_string()],|r|r.get(0)).optional().map_err(sql)?;
    let Some(raw) = raw else {
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM context_revisions WHERE action_id=?1)",
                [action.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if exists || other_manual_action(c, action, ManualActionKind::Context)? {
            return Err(failure(
                ErrorCode::ResultMismatch,
                "context-resource-action-kind",
            ));
        }
        return Ok(None);
    };
    let value = read_revision(c, id(raw)?)?
        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "context-resource-action"))?;
    if value.receipt.project_id != project {
        return Err(failure(ErrorCode::Unauthorized, "context-resource-project"));
    }
    Ok(Some(value))
}
pub(in crate::persistence) fn check_scope(
    c: &Connection,
    project: ExecutionId,
    scope: &ContextResourceScope,
) -> Result<(), ExecutionError> {
    if !scope.valid() {
        return Err(failure(ErrorCode::InvalidInput, "context-resource-scope"));
    }
    match scope {
        ContextResourceScope::Project => {}
        ContextResourceScope::Unit { unit_id } => check_unit(c, project, *unit_id)?,
        ContextResourceScope::FileGroup {
            namespace,
            logical_paths,
        } => {
            for path in logical_paths {
                let present = file_present(c, namespace, path)?;
                if !present {
                    return Err(failure(
                        ErrorCode::DependencyConflict,
                        "context-resource-file-missing",
                    ));
                }
            }
        }
    }
    Ok(())
}
pub(in crate::persistence) fn revision_in(
    c: &Connection,
    revision: ExecutionId,
) -> Result<Option<ContextResourceRevision>, ExecutionError> {
    Ok(read_revision(c, revision)?.map(|v| v.receipt))
}
pub(in crate::persistence) fn current_in(
    c: &Connection,
    project: ExecutionId,
    context: ExecutionId,
) -> Result<Option<ContextResourceRevision>, ExecutionError> {
    current(c, project, context)
}
fn file_present(c: &Connection, namespace: &str, path: &str) -> Result<bool, ExecutionError> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM source_files f JOIN source_snapshots n ON n.set_id=f.set_id JOIN content_scope s ON s.current_snapshot=n.snapshot_id WHERE f.logical_path=?2 AND EXISTS(SELECT 1 FROM source_occurrences o WHERE o.snapshot_id=n.snapshot_id AND o.namespace=?1))",params![namespace,path],|r|r.get(0)).map_err(sql)
}
fn append(
    c: &Connection,
    request: ContextResourceAction,
    value: ContextResourceRevision,
    prior: Option<&ContextResourceRevision>,
) -> Result<ContextResourceRevision, ExecutionError> {
    let record = ContextResourceActionRead {
        request,
        receipt: value.clone(),
    };
    let json = String::from_utf8(codec::encode(&record, MAX_RECORD)?)
        .map_err(|_| failure(ErrorCode::InvalidInput, "context-resource-record"))?;
    c.execute("INSERT INTO context_revisions(revision_id,project_id,unit_id,locale,text,reason,previous_revision_id,action_id,request_digest,context_id,subject_id,resource_kind,record_json) VALUES(?1,?2,NULL,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![value.revision_id.to_string(),value.project_id.to_string(),value.locale,value.text,value.reason,value.previous_revision_id.map(|v|v.to_string()),value.action_id.to_string(),digest(&record.request)?,value.context_id.to_string(),value.subject_id.to_string(),value.kind.as_str(),json]).map_err(sql)?;
    c.execute("INSERT INTO context_current(unit_id,locale,revision_id,context_id) VALUES(NULL,?1,?2,?3) ON CONFLICT(context_id) DO UPDATE SET revision_id=excluded.revision_id",params![value.locale,value.revision_id.to_string(),value.context_id.to_string()]).map_err(sql)?;
    if prior.is_none_or(|p| {
        p.text != value.text
            || p.name != value.name
            || p.scope != value.scope
            || p.withdrawn != value.withdrawn
    }) {
        let new_scope = serde_json::to_string(&value.scope)
            .map_err(|_| failure(ErrorCode::InvalidInput, "context-resource-scope"))?;
        let old_scope = prior
            .map(|p| serde_json::to_string(&p.scope))
            .transpose()
            .map_err(|_| failure(ErrorCode::InvalidInput, "context-resource-scope"))?;
        c.execute("INSERT INTO resource_changes(change_id,project_id,kind,locale,old_revision_id,new_revision_id,action_id,scope_json,old_scope_json) VALUES(?1,?2,'context-resource',?3,?4,?5,?6,?7,?8)",
            params![ExecutionId::new().to_string(),value.project_id.to_string(),value.locale,value.previous_revision_id.map(|v|v.to_string()),value.revision_id.to_string(),value.action_id.to_string(),new_scope,old_scope]).map_err(sql)?;
    }
    Ok(value)
}

pub(in crate::persistence) fn save_in(
    c: &Connection,
    request: &SaveContextResource,
    action: ContextResourceAction,
    origin: Option<crate::application::ContextResourceProposalOrigin>,
) -> Result<ContextResourceRevision, ExecutionError> {
    let tx = c;
    checked_fields(
        &request.name,
        &request.text,
        &request.actor,
        &request.reason,
    )?;
    check_project(&tx, request.project_id, &request.locale)?;
    check_save_source(c,request)?;
    check_scope(&tx, request.project_id, &request.scope)?;
    let prior = check_save_current(c,request)?;
    let context_id = request.context_id.unwrap_or_else(ExecutionId::new);
    let subject_id = prior
        .as_ref()
        .map(|v| v.subject_id)
        .or(request.subject_id)
        .unwrap_or(context_id);
    if prior.as_ref().is_some_and(|p| {
        p.kind != request.kind
            || p.locale != request.locale
            || request.subject_id.is_some_and(|s| s != p.subject_id)
    }) {
        return Err(failure(
            ErrorCode::DependencyConflict,
            "context-resource-identity",
        ));
    }
    if subject_id != context_id {
        let subject = current(&tx, request.project_id, subject_id)?
            .ok_or_else(|| failure(ErrorCode::DependencyConflict, "context-resource-subject"))?;
        if subject.subject_id != subject_id
            || subject.kind != request.kind
            || subject.locale != request.locale
        {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "context-resource-subject",
            ));
        }
    }
    let revision = ContextResourceRevision {
        proposal_origin: origin.or_else(|| prior.as_ref().and_then(|v| v.proposal_origin.clone())),
        revision_id: ExecutionId::new(),
        context_id,
        subject_id,
        project_id: request.project_id,
        kind: request.kind,
        locale: request.locale.clone(),
        scope: request.scope.clone(),
        name: request.name.clone(),
        text: request.text.clone(),
        source_basis: request.source_basis.clone(),
        withdrawn: false,
        actor: request.actor.clone(),
        reason: request.reason.clone(),
        action_id: request.action_id,
        previous_revision_id: request.expected_revision_id,
    };
    append(&tx, action, revision, prior.as_ref())
}

fn check_save_source(c:&Connection,request:&SaveContextResource)->Result<(),ExecutionError>{
    let basis = super::super::content::scope(c)?;
    if basis.current_snapshot.is_none() || basis != request.source_basis {
        return Err(failure(
            ErrorCode::DependencyConflict,
            "context-resource-source",
        ));
    }
    Ok(())
}

fn check_save_current(c:&Connection,request:&SaveContextResource)->Result<Option<ContextResourceRevision>,ExecutionError>{
    let prior = request
        .context_id
        .map(|context| current(c, request.project_id, context))
        .transpose()?
        .flatten();
    if request.context_id.is_some() && prior.is_none()
        || prior.as_ref().map(|v| v.revision_id) != request.expected_revision_id
    {
        return Err(failure(
            ErrorCode::DependencyConflict,
            "context-resource-current",
        ));
    }
    Ok(prior)
}

fn check_withdraw_current(c:&Connection,request:&WithdrawContextResource)->Result<ContextResourceRevision,ExecutionError>{
        let prior = current(c, request.project_id, request.context_id)?
            .ok_or_else(|| failure(ErrorCode::DependencyConflict, "context-resource-current"))?;
        if prior.revision_id != request.expected_revision_id {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "context-resource-current",
            ));
        }
        Ok(prior)
}

impl ProjectStore {
    pub fn context_resource_request_settlement_observation(&self,action:&ContextResourceAction)
        ->Result<Option<ContextResourceActionRead>,ExecutionError>{
        super::super::review::read_snapshot(self.connection().map_err(|_|failure(ErrorCode::StorageFailed,"context-resource-read"))?,|c|{
            let value=by_action(c,action.project(),action.action())?;
            if let Some(value)=&value {
                if value.request!=*action{return Err(failure(ErrorCode::ResultMismatch,"context-resource-action"));}
            }else{
                match action {
                    ContextResourceAction::Save(r)=>{check_save_source(c,r)?;check_save_current(c,r)?;}
                    ContextResourceAction::Withdraw(r)=>{check_withdraw_current(c,r)?;}
                    ContextResourceAction::ProposalAdoption(_)=>return Err(failure(ErrorCode::Unauthorized,"context-resource-proposal-recovery")),
                }
            }Ok(value)
        })
    }
    pub fn save_context_resource(
        &mut self,
        request: &SaveContextResource,
    ) -> Result<ContextResourceRevision, ExecutionError> {
        let action = ContextResourceAction::Save(request.clone());
        let reconciling = self.is_reconciling();
        let clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "context-resource-save"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let observer = clock.observe(&tx, super::super::ChangeScope::Resources);
        if let Some(saved) = by_action(&tx, request.project_id, request.action_id)? {
            return if saved.request == action {
                Ok(saved.receipt)
            } else {
                Err(failure(
                    ErrorCode::ResultMismatch,
                    "context-resource-action",
                ))
            };
        }
        if reconciling {
            return Err(failure(
                ErrorCode::OutcomeUnknown,
                "context-resource-session",
            ));
        }
        let value = save_in(&tx, request, action, None)?;
        observer.commit(tx).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "context-resource-commit")
        })?;
        Ok(value)
    }
    pub fn withdraw_context_resource(
        &mut self,
        request: &WithdrawContextResource,
    ) -> Result<ContextResourceRevision, ExecutionError> {
        let action = ContextResourceAction::Withdraw(request.clone());
        let reconciling = self.is_reconciling();
        let clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "context-resource-withdraw"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let observer = clock.observe(&tx, super::super::ChangeScope::Resources);
        if let Some(saved) = by_action(&tx, request.project_id, request.action_id)? {
            return if saved.request == action {
                Ok(saved.receipt)
            } else {
                Err(failure(
                    ErrorCode::ResultMismatch,
                    "context-resource-action",
                ))
            };
        }
        if reconciling {
            return Err(failure(
                ErrorCode::OutcomeUnknown,
                "context-resource-session",
            ));
        }
        let prior=check_withdraw_current(&tx,request)?;
        checked_fields(&prior.name, &prior.text, &request.actor, &request.reason)?;
        let value = ContextResourceRevision {
            revision_id: ExecutionId::new(),
            action_id: request.action_id,
            previous_revision_id: Some(prior.revision_id),
            withdrawn: true,
            actor: request.actor.clone(),
            reason: request.reason.clone(),
            ..prior.clone()
        };
        let result = append(&tx, action, value, Some(&prior))?;
        observer.commit(tx).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "context-resource-commit")
        })?;
        Ok(result)
    }
    pub fn context_resource_action(
        &self,
        project: ExecutionId,
        action: ExecutionId,
    ) -> Result<Option<ContextResourceActionRead>, ExecutionError> {
        super::super::review::read_snapshot(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "context-resource-read"))?,
            |c| by_action(c, project, action),
        )
    }
    /// Explicit recovery may reconcile the original global transaction state.
    /// A pure lookup returning None is never this permission to retry.
    pub fn recover_context_resource_action(
        &self,
        request: &ContextResourceAction,
    ) -> Result<ContextResourceRecovery, ExecutionError> {
        match request {
            ContextResourceAction::Save(r) => {
                checked_fields(&r.name, &r.text, &r.actor, &r.reason)?;
                if !r.scope.valid() {
                    return Err(failure(ErrorCode::InvalidInput, "context-resource-scope"));
                }
            }
            ContextResourceAction::Withdraw(r) => {
                checked_fields("withdrawal", "withdrawal", &r.actor, &r.reason)?
            }
            ContextResourceAction::ProposalAdoption(_) => {
                return Err(failure(
                    ErrorCode::Unauthorized,
                    "context-resource-conversation-recovery-required",
                ));
            }
        }
        codec::encode(request, MAX_RECORD)?;
        let found = self.context_resource_action(request.project(), request.action())?;
        if found.as_ref().is_some_and(|v| v.request != *request) {
            return Err(failure(
                ErrorCode::ResultMismatch,
                "context-resource-recovery",
            ));
        }
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(ContextResourceRecovery {
            request: request.clone(),
            status: if found.is_some() {
                ContextResourceRecoveryStatus::Recorded
            } else {
                ContextResourceRecoveryStatus::RetryAllowed
            },
            receipt: found.map(|v| v.receipt),
        })
    }
    pub fn current_context_resource(
        &self,
        project: ExecutionId,
        context: ExecutionId,
    ) -> Result<Option<ContextResourceRevision>, ExecutionError> {
        super::super::review::read_snapshot(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "context-resource-read"))?,
            |c| {
                check_action_project(c, project)?;
                current(c, project, context)
            },
        )
    }
    pub fn list_context_resources(
        &self,
        project: ExecutionId,
        locale: &str,
        kind: Option<ContextResourceKind>,
        offset: u32,
        limit: u32,
        expected_basis: Option<&str>,
    ) -> Result<ContextResourcePage, ExecutionError> {
        let epoch = self
            .changes_since(crate::execution::Revision::new(0)?)
            .epoch;
        super::super::review::read_snapshot(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "context-resource-read"))?,
            |c| {
                check_project(c, project, locale)?;
                let basis = page_basis(c, &epoch, &(project, locale, kind))?;
                check_page(offset, limit, expected_basis, &basis)?;
                let mut q=c.prepare("SELECT r.revision_id FROM context_current v JOIN context_revisions r ON r.revision_id=v.revision_id WHERE r.project_id=?1 AND r.locale=?2 AND r.context_id IS NOT NULL AND (?3 IS NULL OR r.resource_kind=?3) ORDER BY r.context_id LIMIT ?4 OFFSET ?5").map_err(sql)?;
                let ids = q
                    .query_map(
                        params![
                            project.to_string(),
                            locale,
                            kind.map(ContextResourceKind::as_str),
                            limit + 1,
                            offset
                        ],
                        |r| r.get::<_, String>(0),
                    )
                    .map_err(sql)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(sql)?;
                make_page(c, ids, offset, limit, basis)
            },
        )
    }
    pub fn context_resource_history(
        &self,
        project: ExecutionId,
        context: ExecutionId,
        offset: u32,
        limit: u32,
        expected_basis: Option<&str>,
    ) -> Result<ContextResourcePage, ExecutionError> {
        let epoch = self
            .changes_since(crate::execution::Revision::new(0)?)
            .epoch;
        super::super::review::read_snapshot(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "context-resource-read"))?,
            |c| {
                check_action_project(c, project)?;
                let basis = page_basis(c, &epoch, &(project, context))?;
                check_page(offset, limit, expected_basis, &basis)?;
                let mut q=c.prepare("SELECT revision_id FROM context_revisions WHERE project_id=?1 AND context_id=?2 ORDER BY rowid LIMIT ?3 OFFSET ?4").map_err(sql)?;
                let ids = q
                    .query_map(
                        params![project.to_string(), context.to_string(), limit + 1, offset],
                        |r| r.get::<_, String>(0),
                    )
                    .map_err(sql)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(sql)?;
                make_page(c, ids, offset, limit, basis)
            },
        )
    }
    pub fn resolve_context_resources(
        &self,
        scope: &SourceContextRequest,
    ) -> Result<ContextResourceResolution, ExecutionError> {
        super::super::review::read_snapshot(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "context-resource-read"))?,
            |c| resolve_in(c, scope),
        )
    }
}
fn page_basis(
    c: &Connection,
    epoch: &str,
    filter: &impl Serialize,
) -> Result<String, ExecutionError> {
    let max: i64 = c
        .query_row(
            "SELECT COALESCE(MAX(rowid),0) FROM context_revisions",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let version: i64 = c
        .query_row("PRAGMA data_version", [], |r| r.get(0))
        .map_err(sql)?;
    digest(&(epoch, max, version, filter))
}
fn check_page(
    offset: u32,
    limit: u32,
    expected: Option<&str>,
    basis: &str,
) -> Result<(), ExecutionError> {
    if limit == 0 || limit > 100 || offset > 100_000 {
        return Err(failure(ErrorCode::InvalidInput, "context-resource-page"));
    }
    if offset > 0 && expected.is_none() || expected.is_some_and(|v| v != basis) {
        return Err(failure(
            ErrorCode::DependencyConflict,
            "context-resource-page-basis",
        ));
    }
    Ok(())
}
fn make_page(
    c: &Connection,
    ids: Vec<String>,
    offset: u32,
    limit: u32,
    basis: String,
) -> Result<ContextResourcePage, ExecutionError> {
    let available = ids.len();
    let mut rows = Vec::new();
    let mut used = 256;
    for raw in ids.into_iter().take(limit as usize) {
        let value = read_revision(c, id(raw)?)?
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "context-resource-page"))?
            .receipt;
        let bytes = codec::encode(&value, MAX_RECORD)?.len();
        if used + bytes > MAX_RESOLUTION {
            break;
        }
        used += bytes;
        rows.push(value);
    }
    let next_offset = (rows.len() < available).then_some(offset + rows.len() as u32);
    Ok(ContextResourcePage {
        basis,
        rows,
        next_offset,
    })
}

pub(super) fn scope_membership(
    c: &Connection,
    unit: ExecutionId,
    scope: &ContextResourceScope,
) -> Result<(ContextResourceStatus, Vec<String>), ExecutionError> {
    match scope {
        ContextResourceScope::Project => Ok((ContextResourceStatus::Selected, vec![])),
        ContextResourceScope::Unit { unit_id } => Ok((
            if *unit_id == unit {
                ContextResourceStatus::Selected
            } else {
                ContextResourceStatus::OutsideScope
            },
            vec![],
        )),
        ContextResourceScope::FileGroup {
            namespace,
            logical_paths,
        } => {
            let mut q=c.prepare("SELECT o.namespace,f.logical_path FROM source_occurrences o JOIN source_files f ON f.artifact_id=o.artifact_id JOIN content_scope s ON s.current_snapshot=o.snapshot_id WHERE o.unit_id=?1 ORDER BY o.ordinal").map_err(sql)?;
            let occurrences = q
                .query_map([unit.to_string()], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(sql)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql)?;
            let matching = occurrences
                .iter()
                .filter(|(ns, path)| ns == namespace && logical_paths.binary_search(path).is_ok())
                .count();
            let mut missing = Vec::new();
            for path in logical_paths {
                let exists = file_present(c, namespace, path)?;
                if !exists {
                    missing.push(path.clone());
                }
            }
            let status = if matching == 0 {
                ContextResourceStatus::OutsideScope
            } else if matching != occurrences.len() {
                ContextResourceStatus::Ambiguous
            } else {
                ContextResourceStatus::Selected
            };
            Ok((status, missing))
        }
    }
}
pub(super) fn resolve_in(
    c: &Connection,
    scope: &SourceContextRequest,
) -> Result<ContextResourceResolution, ExecutionError> {
    // Reuse the source owner to check project, snapshot, revision and locale.
    SourceContextReader::read_in(c, scope.project_id, &scope.locale)?.project(scope)?;
    let mut q=c.prepare("SELECT r.revision_id FROM context_current p JOIN context_revisions r ON r.revision_id=p.revision_id WHERE r.context_id IS NOT NULL AND r.project_id=?1 AND r.locale=?2 ORDER BY r.context_id LIMIT ?3").map_err(sql)?;
    let ids = q
        .query_map(
            params![
                scope.project_id.to_string(),
                scope.locale,
                (MAX_CURRENT + 1) as i64
            ],
            |r| r.get::<_, String>(0),
        )
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    if ids.len() > MAX_CURRENT {
        return Err(failure(ErrorCode::LimitExceeded, "context-resource-count"));
    }
    let mut entries = Vec::new();
    let mut used = 0;
    for raw in ids {
        let revision = read_revision(c, id(raw)?)?
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "context-resource-current"))?
            .receipt;
        used += codec::encode(&revision, MAX_RECORD)?.len();
        if used > MAX_RESOLUTION {
            return Err(failure(
                ErrorCode::LimitExceeded,
                "context-resource-resolution",
            ));
        }
        let (status, missing_paths) = scope_membership(c, scope.unit_id, &revision.scope)?;
        entries.push(ContextResourceResolutionEntry {
            revision,
            status,
            missing_paths,
        });
    }
    let subjects = entries
        .iter()
        .map(|e| e.revision.subject_id)
        .collect::<BTreeSet<_>>();
    for subject in subjects {
        let rank = entries
            .iter()
            .filter(|e| {
                e.revision.subject_id == subject && e.status == ContextResourceStatus::Selected
            })
            .map(|e| e.revision.scope.rank())
            .max();
        let Some(rank) = rank else { continue };
        let winning = entries
            .iter()
            .filter(|e| {
                e.revision.subject_id == subject
                    && e.status == ContextResourceStatus::Selected
                    && e.revision.scope.rank() == rank
            })
            .map(|e| (&e.revision.name, &e.revision.text, e.revision.withdrawn))
            .collect::<BTreeSet<_>>();
        let conflict = winning.len() > 1;
        for e in entries.iter_mut().filter(|e| {
            e.revision.subject_id == subject && e.status == ContextResourceStatus::Selected
        }) {
            e.status = if e.revision.scope.rank() != rank {
                ContextResourceStatus::Shadowed
            } else if conflict {
                ContextResourceStatus::Conflict
            } else if e.revision.withdrawn {
                ContextResourceStatus::Withdrawn
            } else {
                ContextResourceStatus::Selected
            };
        }
    }
    Ok(ContextResourceResolution {
        scope: scope.clone(),
        entries,
    })
}
pub(in crate::persistence) fn capture_in(
    c: &Connection,
    scope: &SourceContextRequest,
) -> Result<Option<ContextResourceCapture>, ExecutionError> {
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM context_current p JOIN context_revisions r ON r.revision_id=p.revision_id WHERE r.context_id IS NOT NULL AND r.project_id=?1 AND r.locale=?2)",params![scope.project_id.to_string(),scope.locale],|r|r.get(0)).map_err(sql)?;
    if !exists {
        return Ok(None);
    }
    let resolution = resolve_in(c, scope)?;
    let entries = resolution
        .entries
        .into_iter()
        .filter(|e| {
            !matches!(
                e.status,
                ContextResourceStatus::OutsideScope | ContextResourceStatus::Shadowed
            )
        })
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return Ok(None);
    }
    if entries.len() > 128 {
        return Err(failure(
            ErrorCode::LimitExceeded,
            "context-resource-capture-items",
        ));
    }
    let value = ContextResourceCapture {
        scope: scope.clone(),
        entries,
    };
    codec::encode(&value, 32 * 1024)
        .map_err(|_| failure(ErrorCode::LimitExceeded, "context-resource-capture-bytes"))?;
    Ok(Some(value))
}
impl ContextResourceCapture {
    pub(crate) fn validate(&self) -> Result<(), ExecutionError> {
        if self.entries.len() > 128
            || self.entries.iter().any(|e| {
                e.revision.project_id != self.scope.project_id
                    || e.revision.locale != self.scope.locale
                    || !e.revision.scope.valid()
                    || e.status == ContextResourceStatus::Selected && e.revision.withdrawn
                    || e.status == ContextResourceStatus::Withdrawn && !e.revision.withdrawn
            })
        {
            return Err(failure(ErrorCode::InvalidInput, "context-resource-capture"));
        }
        codec::encode(self, 32 * 1024)
            .map_err(|_| failure(ErrorCode::LimitExceeded, "context-resource-capture-bytes"))?;
        Ok(())
    }
    /// Only semantic, explicitly shared human material enters a provider prompt.
    pub(crate) fn provider_projection(&self) -> Vec<serde_json::Value> {
        let mut seen = BTreeSet::new();
        self.entries.iter().filter(|e|e.status==ContextResourceStatus::Selected&&seen.insert(e.revision.subject_id)).map(|e|serde_json::json!({"kind":e.revision.kind,"name":e.revision.name,"text":e.revision.text})).collect()
    }
}

pub(super) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    let mut q = c
        .prepare(
            "SELECT revision_id FROM context_revisions WHERE context_id IS NOT NULL ORDER BY rowid",
        )
        .map_err(sql)?;
    let ids = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    let mut last = BTreeMap::new();
    let mut subjects = BTreeMap::new();
    for raw in ids {
        let value = read_revision(c, id(raw)?)?
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "context-resource-record"))?;
        let v = value.receipt;
        if v.proposal_origin.is_some() {
            super::super::application::conversations::proposals::knowledge::validate_context_origin(c,&v)?;
        }
        check_action_project(c, v.project_id)?;
        let snapshot = v
            .source_basis
            .current_snapshot
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "context-resource-source"))?;
        let owned:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM source_snapshots WHERE snapshot_id=?1 AND project_id=?2)",params![snapshot.to_string(),v.project_id.to_string()],|r|r.get(0)).map_err(sql)?;
        if !owned
            || v.source_basis.revision.get() < 2
            || !crate::Locale::parse(&v.locale).is_ok_and(|l| l.as_str() == v.locale)
        {
            return Err(failure(ErrorCode::CorruptLedger, "context-resource-source"));
        }
        if let ContextResourceScope::Unit { unit_id } = &v.scope {
            if !super::super::content::unit_owned_by_project(c, v.project_id, *unit_id)? {
                return Err(failure(ErrorCode::CorruptLedger, "context-resource-unit"));
            }
        }
        if last.get(&v.context_id).copied() != v.previous_revision_id {
            return Err(failure(ErrorCode::CorruptLedger, "context-resource-chain"));
        }
        if let Some((subject, kind, locale)) = subjects.get(&v.context_id) {
            if *subject != v.subject_id || *kind != v.kind || *locale != v.locale {
                return Err(failure(
                    ErrorCode::CorruptLedger,
                    "context-resource-identity",
                ));
            }
        } else {
            if v.subject_id != v.context_id
                && subjects.get(&v.subject_id) != Some(&(v.subject_id, v.kind, v.locale.clone()))
            {
                return Err(failure(
                    ErrorCode::CorruptLedger,
                    "context-resource-subject",
                ));
            }
            subjects.insert(v.context_id, (v.subject_id, v.kind, v.locale.clone()));
        }
        // Withdrawal copies the previous content and scope, including its old
        // source basis; it remains possible after that source has disappeared.
        if v.withdrawn {
            let prior = read_revision(
                c,
                v.previous_revision_id.ok_or_else(|| {
                    failure(ErrorCode::CorruptLedger, "context-resource-withdraw")
                })?,
            )?
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "context-resource-withdraw"))?
            .receipt;
            if prior.proposal_origin != v.proposal_origin {
                return Err(failure(ErrorCode::CorruptLedger, "context-resource-origin"));
            }
            if (prior.scope, prior.name, prior.text, prior.source_basis)
                != (
                    v.scope.clone(),
                    v.name.clone(),
                    v.text.clone(),
                    v.source_basis.clone(),
                )
            {
                return Err(failure(
                    ErrorCode::CorruptLedger,
                    "context-resource-withdraw",
                ));
            }
        }
        if matches!(value.request, ContextResourceAction::Save(_)) {
            let prior_origin = v
                .previous_revision_id
                .map(|id| read_revision(c, id))
                .transpose()?
                .flatten()
                .and_then(|v| v.receipt.proposal_origin);
            if v.proposal_origin != prior_origin {
                return Err(failure(ErrorCode::CorruptLedger, "context-resource-origin"));
            }
        }
        last.insert(v.context_id, v.revision_id);
    }
    for (context, revision) in last {
        let current: Option<String> = c
            .query_row(
                "SELECT revision_id FROM context_current WHERE context_id=?1",
                [context.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        if current != Some(revision.to_string()) {
            return Err(failure(
                ErrorCode::CorruptLedger,
                "context-resource-current",
            ));
        }
    }
    let invalid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM context_current p JOIN context_revisions r ON r.revision_id=p.revision_id WHERE p.context_id IS NOT r.context_id OR p.locale<>r.locale OR p.unit_id IS NOT r.unit_id)",[],|r|r.get(0)).map_err(sql)?;
    if invalid {
        return Err(failure(
            ErrorCode::CorruptLedger,
            "context-resource-current",
        ));
    }
    let invalid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM resource_changes x LEFT JOIN context_revisions r ON r.revision_id=x.new_revision_id WHERE x.kind='context-resource' AND (r.context_id IS NULL OR r.project_id<>x.project_id OR r.locale<>x.locale OR r.action_id<>x.action_id OR r.previous_revision_id IS NOT x.old_revision_id OR x.scope_json IS NULL))",[],|r|r.get(0)).map_err(sql)?;
    if invalid {
        return Err(failure(ErrorCode::CorruptLedger, "context-resource-change"));
    }
    Ok(())
}
pub(super) fn verify_input_records(
    c: &Connection,
    input: &crate::execution::FixedInput,
) -> Result<(), ExecutionError> {
    let operation = input.envelope().operation.as_str();
    if operation == crate::ai::conversation_planning::OPERATION {
        if let Some(material) = crate::ai::conversation_planning::settings(input)?.material {
            for item in material.items {
                verify_capture_records(c, item.context_resources.as_ref())?;
            }
        }
        return Ok(());
    }
    if !matches!(
        operation,
        crate::ai::OPERATION
            | crate::ai::arena::OPERATION
            | crate::ai::semantic_review::OPERATION
            | crate::ai::team::OPERATION
    ) {
        return Ok(());
    }
    for slot in &input.envelope().items {
        let item = if operation == crate::ai::arena::OPERATION {
            crate::ai::arena::item_payload(input, slot.item_id)?.item
        } else if operation == crate::ai::semantic_review::OPERATION {
            crate::ai::semantic_review::item_payload(input, slot.item_id)?.source
        } else {
            crate::ai::item_payload(input, slot.item_id)?
        };
        verify_capture_records(c, item.context_resources.as_ref())?;
    }
    Ok(())
}
fn verify_capture_records(
    c: &Connection,
    capture: Option<&ContextResourceCapture>,
) -> Result<(), ExecutionError> {
    if let Some(capture) = capture {
        capture.validate()?;
        for entry in &capture.entries {
            if read_revision(c, entry.revision.revision_id)?
                .map(|v| v.receipt)
                .as_ref()
                != Some(&entry.revision)
            {
                return Err(failure(
                    ErrorCode::CorruptLedger,
                    "context-resource-capture-record",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_other_file_does_not_remove_coverage_of_the_current_unit() {
        let c = Connection::open_in_memory().unwrap();
        let full = ExecutionId::new();
        let partial = ExecutionId::new();
        let outside = ExecutionId::new();
        c.execute_batch("CREATE TABLE content_scope(current_snapshot TEXT);INSERT INTO content_scope VALUES('snapshot');
            CREATE TABLE source_snapshots(snapshot_id TEXT,set_id TEXT);INSERT INTO source_snapshots VALUES('snapshot','set');
            CREATE TABLE source_files(artifact_id TEXT,set_id TEXT,logical_path TEXT);INSERT INTO source_files VALUES('a','set','a.txt'),('c','set','c.txt');
            CREATE TABLE source_occurrences(snapshot_id TEXT,unit_id TEXT,namespace TEXT,artifact_id TEXT,ordinal INTEGER);").unwrap();
        for (unit, artifact, ordinal) in [
            (full, "a", 0),
            (partial, "a", 1),
            (partial, "c", 2),
            (outside, "c", 3),
        ] {
            c.execute(
                "INSERT INTO source_occurrences VALUES('snapshot',?1,'namespace',?2,?3)",
                params![unit.to_string(), artifact, ordinal],
            )
            .unwrap();
        }
        let scope = ContextResourceScope::FileGroup {
            namespace: "namespace".into(),
            logical_paths: vec!["a.txt".into(), "missing.txt".into()],
        };
        assert_eq!(
            scope_membership(&c, full, &scope).unwrap(),
            (ContextResourceStatus::Selected, vec!["missing.txt".into()])
        );
        assert_eq!(
            scope_membership(&c, partial, &scope).unwrap().0,
            ContextResourceStatus::Ambiguous
        );
        assert_eq!(
            scope_membership(&c, outside, &scope).unwrap().0,
            ContextResourceStatus::OutsideScope
        );
    }

    #[test]
    fn action_lookup_is_pure_and_recovery_is_explicit_and_exact() {
        let (_temp, mut store, project) = super::super::tests::fixture_project();
        let request = SaveContextResource {
            project_id: project,
            action_id: ExecutionId::new(),
            context_id: None,
            subject_id: None,
            expected_revision_id: None,
            source_basis: store.content_scope().unwrap(),
            kind: ContextResourceKind::Character,
            locale: "zh-CN".into(),
            scope: ContextResourceScope::Project,
            name: "Character".into(),
            text: "Human character setting".into(),
            actor: "Synthetic editor".into(),
            reason: "Explicit setting".into(),
        };
        let saved = store.save_context_resource(&request).unwrap();
        store
            .execution_unknown
            .store(true, std::sync::atomic::Ordering::Release);
        let authority = store
            .planning_authority_revision
            .load(std::sync::atomic::Ordering::Acquire);
        let before = store
            .changes_since(crate::execution::Revision::new(0).unwrap())
            .sequence;
        assert_eq!(
            store
                .context_resource_action(project, request.action_id)
                .unwrap()
                .unwrap()
                .receipt,
            saved
        );
        assert!(store.is_reconciling());
        assert_eq!(
            store
                .planning_authority_revision
                .load(std::sync::atomic::Ordering::Acquire),
            authority
        );
        assert_eq!(store.save_context_resource(&request).unwrap(), saved);
        assert!(store.is_reconciling());
        let mut mismatched = request.clone();
        mismatched.text = "Changed after lost response".into();
        assert!(
            store
                .recover_context_resource_action(&ContextResourceAction::Save(mismatched))
                .is_err()
        );
        assert!(store.is_reconciling());
        let absent = ContextResourceAction::Save(SaveContextResource {
            action_id: ExecutionId::new(),
            ..request.clone()
        });
        assert!(
            store
                .context_resource_action(project, absent.action())
                .unwrap()
                .is_none()
        );
        assert!(store.is_reconciling());
        assert_eq!(
            store
                .planning_authority_revision
                .load(std::sync::atomic::Ordering::Acquire),
            authority
        );
        let recovered = store
            .recover_context_resource_action(&ContextResourceAction::Save(request))
            .unwrap();
        assert_eq!(recovered.status, ContextResourceRecoveryStatus::Recorded);
        assert_eq!(recovered.receipt, Some(saved));
        assert!(!store.is_reconciling());
        assert!(
            store
                .planning_authority_revision
                .load(std::sync::atomic::Ordering::Acquire)
                > authority
        );
        store
            .execution_unknown
            .store(true, std::sync::atomic::Ordering::Release);
        let retriable = store.recover_context_resource_action(&absent).unwrap();
        assert_eq!(
            retriable.status,
            ContextResourceRecoveryStatus::RetryAllowed
        );
        assert!(retriable.receipt.is_none());
        assert!(!store.is_reconciling());
        assert!(
            store
                .context_resource_action(project, absent.action())
                .unwrap()
                .is_none()
        );
        assert_eq!(store.changes_since(before).sequence, before);
    }

    #[test]
    fn replacing_supported_context_tables_rolls_back_or_preserves_exact_rowids() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;PRAGMA user_version=65;
            CREATE TABLE source_units(unit_id TEXT PRIMARY KEY);INSERT INTO source_units VALUES('unit');
            CREATE TABLE context_revisions(revision_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,unit_id TEXT NOT NULL REFERENCES source_units(unit_id),locale TEXT NOT NULL,text TEXT NOT NULL,reason TEXT NOT NULL,previous_revision_id TEXT REFERENCES context_revisions(revision_id),action_id TEXT UNIQUE,request_digest TEXT NOT NULL);
            INSERT INTO context_revisions VALUES('first','project','unit','zh-CN','Old note','Old reason',NULL,'first-action',printf('%064d',0));
            INSERT INTO context_revisions VALUES('second','project','unit','zh-CN','New note','New reason','first','second-action',printf('%064d',0));
            CREATE TABLE context_current(unit_id TEXT REFERENCES source_units(unit_id),locale TEXT,revision_id TEXT REFERENCES context_revisions(revision_id),PRIMARY KEY(unit_id,locale));
            INSERT INTO context_current VALUES('unit','zh-CN','second');
            CREATE TABLE resource_changes(change_id TEXT PRIMARY KEY,project_id TEXT,kind TEXT,locale TEXT,scope_unit_id TEXT,old_scope_unit_id TEXT,source_phrase TEXT,old_source_phrase TEXT,old_revision_id TEXT,new_revision_id TEXT,action_id TEXT);
            INSERT INTO resource_changes(rowid,change_id,project_id,kind,locale,scope_unit_id,old_scope_unit_id,new_revision_id,action_id) VALUES(29,'change','project','context','zh-CN','unit','unit','second','second-action');").unwrap();
        {
            let tx = c.transaction().unwrap();
            super::super::migrate_context_resources(&tx).unwrap();
            tx.pragma_update(None, "user_version", 66).unwrap();
            // A failed or interrupted enclosing operation does not commit DDL.
        }
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            65
        );
        assert_eq!(c.query_row("SELECT COUNT(*) FROM pragma_table_info('context_revisions') WHERE name='context_id'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        let tx = c.transaction().unwrap();
        super::super::migrate_context_resources(&tx).unwrap();
        tx.pragma_update(None, "user_version", 66).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            c.query_row(
                "SELECT rowid FROM resource_changes WHERE change_id='change'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            29
        );
        assert_eq!(
            c.query_row("SELECT revision_id FROM context_current", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "second"
        );
        assert_eq!(
            c.query_row(
                "SELECT previous_revision_id FROM context_revisions WHERE revision_id='second'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "first"
        );
        assert!(
            !c.prepare("PRAGMA foreign_key_check")
                .unwrap()
                .exists([])
                .unwrap()
        );
    }
}
