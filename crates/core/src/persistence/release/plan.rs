//! Qualified Core evidence and the minimal plugin build projection. Plans use
//! the existing source, review and execution owners; capture grants no authority.
use super::*;
use crate::{
    ReviewTarget,
    execution::{
        AdoptionUnit, InputEnvelope, InputItem, MAX_RESULT_BYTES, PluginExecutionBinding, Scope,
    },
};
use std::collections::BTreeMap;
use tsumugi_plugin_sdk as sdk;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginBuildLocaleChoice {
    pub locale: String,
    pub output_paths: Vec<String>,
    pub configuration: Vec<sdk::EncodedPayload>,
}

/// Installed immutable metadata supplied by the trusted Host. Constructing this
/// selection neither authenticates package provenance nor authorizes execution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReleaseBuildEnvironment {
    binding: sdk::BuildBinding,
    builder_execution: PluginExecutionBinding,
    checker_execution: PluginExecutionBinding,
}
impl ReleaseBuildEnvironment {
    pub fn new(
        binding: sdk::BuildBinding,
        builder_execution: PluginExecutionBinding,
        checker_execution: PluginExecutionBinding,
    ) -> Result<Self, ExecutionError> {
        let selection = Self {
            binding,
            builder_execution,
            checker_execution,
        };
        selection.validate()?;
        Ok(selection)
    }
    fn validate(&self) -> Result<(), ExecutionError> {
        self.binding.validate().map_err(|_| invalid())?;
        self.builder_execution.validate()?;
        self.checker_execution.validate()?;
        if self.builder_execution.capability != self.binding.builder
            || self.checker_execution.capability != self.binding.checker
            || self.builder_execution.profile.as_ref() != Some(&self.binding.declaration.profile)
            || self.checker_execution.profile.as_ref() != Some(&self.binding.declaration.profile)
            || self.builder_execution.environment != self.checker_execution.environment
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn binding(&self) -> &sdk::BuildBinding {
        &self.binding
    }
    pub fn environment(&self) -> &sdk::ExecutionEnvironmentDescriptor {
        &self.builder_execution.environment
    }
    fn builder(&self) -> PluginExecutionBinding {
        self.builder_execution.clone()
    }
    pub fn checker(&self) -> &PluginExecutionBinding {
        &self.checker_execution
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanTarget {
    local_unit_id: String,
    local_source_revision_id: String,
    review: ReviewTarget,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanLocale {
    choice: PluginBuildLocaleChoice,
    targets: Vec<PlanTarget>,
}

/// The saved Core plan retains current review/QA/waiver/context/term evidence.
/// Only `plugin_input` is sent to a component. Deserialization is data validation,
/// not trusted capture: ledger registration independently recaptures this plan.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleasePlan {
    version: u32,
    project_id: ExecutionId,
    source_snapshot_id: ExecutionId,
    source_attempt_id: ExecutionId,
    source_result_id: ExecutionId,
    source_input_digest: String,
    source_result_digest: String,
    policy_version: String,
    eligibility_basis: String,
    source: sdk::ContentExchange,
    build: ReleaseBuildEnvironment,
    locales: Vec<PlanLocale>,
}
fn invalid() -> ExecutionError {
    failure(ErrorCode::InvalidInput, "release-plan")
}

pub(super) fn decided_text(target: &ReviewTarget) -> Result<&str, ExecutionError> {
    if target.selection_id.is_some() {
        target
            .translation_text
            .as_deref()
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "build-translation"))
    } else if target.current_fallback.as_ref().is_some_and(|f| f.allow) {
        Ok(&target.source_text)
    } else {
        Err(failure(ErrorCode::DependencyConflict, "build-value"))
    }
}

impl ReleasePlan {
    pub(crate) fn artifact_set(
        &self,
        result: &FixedResult,
    ) -> Result<sdk::ArtifactSet, ExecutionError> {
        let invalid = || failure(ErrorCode::OutputInvalid, "release-artifacts");
        let evidence = result.envelope().plugin.as_ref().ok_or_else(invalid)?;
        let sdk::InvocationOutcome::Succeeded { output } = &evidence.result.outcome else {
            return Err(invalid());
        };
        if output.schema != sdk::artifact_set_contract() {
            return Err(invalid());
        }
        let output = sdk::parse_artifact_set(output.utf8.as_bytes()).map_err(|_| invalid())?;
        let input = self.plugin_input(&output.target_language)?;
        self.build
            .binding
            .validate_artifacts(&input, &output)
            .map_err(|_| invalid())?;
        Ok(output)
    }
    pub(super) fn release_summary(&self) -> super::record::ManifestSummary {
        let binding = &self.build.binding;
        let version = |capability: &sdk::CapabilityBinding| {
            let provider = &capability.provider;
            let contract = &capability.declaration.contract;
            format!(
                "{}@{} / {}:{}:{}",
                provider.plugin.id,
                provider.plugin.version,
                contract.id,
                contract.schema_version,
                contract.behavior_version
            )
        };
        let exceptions = self
            .locales
            .iter()
            .flat_map(|locale| {
                locale.targets.iter().flat_map(|target| {
                    let mut exceptions = Vec::new();
                    if target.review.selection_id.is_none()
                        && target
                            .review
                            .current_fallback
                            .as_ref()
                            .is_some_and(|f| f.allow)
                    {
                        exceptions.push(super::ReleaseException {
                            locale: locale.choice.locale.clone(),
                            native_key: target.review.native_key.clone(),
                            kind: super::ReleaseExceptionKind::SourceFallback,
                        });
                    }
                    if !target.review.current_waivers.is_empty() {
                        exceptions.push(super::ReleaseException {
                            locale: locale.choice.locale.clone(),
                            native_key: target.review.native_key.clone(),
                            kind: super::ReleaseExceptionKind::QaWaiver,
                        });
                    }
                    exceptions
                })
            })
            .collect();
        super::record::ManifestSummary {
            project_id: self.project_id,
            source_snapshot_id: self.source_snapshot_id,
            policy_version: self.policy_version.clone(),
            eligibility_basis: self.eligibility_basis.clone(),
            builder_version: version(&binding.builder),
            validator_version: version(&binding.checker),
            source_files: self
                .source
                .artifacts
                .iter()
                .map(|a| BuildSourceFile {
                    logical_path: a.logical_path.clone(),
                    sha256: a.sha256.clone(),
                })
                .collect(),
            exceptions,
        }
    }
    pub fn project_id(&self) -> ExecutionId {
        self.project_id
    }
    pub fn source_snapshot_id(&self) -> ExecutionId {
        self.source_snapshot_id
    }
    pub fn eligibility_basis(&self) -> &str {
        &self.eligibility_basis
    }
    pub fn policy_version(&self) -> &str {
        &self.policy_version
    }
    pub fn build_environment(&self) -> &ReleaseBuildEnvironment {
        &self.build
    }
    pub fn source(&self) -> &sdk::ContentExchange {
        &self.source
    }
    /// Verify frozen references, without recapturing the current source or
    /// invoking any domain parser. Adopted source history needs no live grant.
    pub(in crate::persistence) fn validate_source_reference(
        &self,
        connection: &Connection,
    ) -> Result<(), ExecutionError> {
        let invalid = || failure(ErrorCode::CorruptLedger, "release-source-reference");
        let associated: (String, String, String) = connection
            .query_row(
                "SELECT project_id,attempt_id,result_id FROM source_snapshots WHERE snapshot_id=?1",
                [self.source_snapshot_id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| invalid())?;
        let input = super::super::ledger::load_input(connection, self.source_attempt_id)?;
        if associated
            != (
                self.project_id.to_string(),
                self.source_attempt_id.to_string(),
                self.source_result_id.to_string(),
            )
            || input.envelope().project_id != self.project_id
            || input.digest() != self.source_input_digest
        {
            return Err(invalid());
        }
        let result = super::super::ledger::load_result(connection, &input, self.source_result_id)?;
        if result.digest() != self.source_result_digest {
            return Err(invalid());
        }
        if input.envelope().plugin.is_some() {
            super::super::ledger::validate_source_link(connection, &input, &result, true)?;
        }
        Ok(())
    }
    pub fn choices(&self) -> Vec<PluginBuildLocaleChoice> {
        self.locales.iter().map(|l| l.choice.clone()).collect()
    }
    pub fn plugin_input(&self, locale: &str) -> Result<sdk::BuildInput, ExecutionError> {
        let entry = self
            .locales
            .iter()
            .find(|l| l.choice.locale == locale)
            .ok_or_else(invalid)?;
        let input = sdk::BuildInput {
            source: self.source.clone(),
            target_language: entry.choice.locale.clone(),
            targets: entry
                .targets
                .iter()
                .map(|target| {
                    Ok(sdk::BuildTarget {
                        unit_id: target.local_unit_id.clone(),
                        source_revision_id: target.local_source_revision_id.clone(),
                        text: decided_text(&target.review)?.to_owned(),
                    })
                })
                .collect::<Result<_, ExecutionError>>()?,
            configuration: entry.choice.configuration.clone(),
            output_paths: entry.choice.output_paths.clone(),
            output_limits: self.build.binding.declaration.output_limits.clone(),
        };
        self.build
            .binding
            .validate_input(&input)
            .map_err(|_| invalid())?;
        Ok(input)
    }
    fn validate(&self) -> Result<(), ExecutionError> {
        self.build.validate()?;
        self.source.validate().map_err(|_| invalid())?;
        if self.version != 1
            || self.policy_version != super::super::review::POLICY_VERSION
            || self.locales.is_empty()
            || self.locales.len() > 16
            || [
                &self.source_input_digest,
                &self.source_result_digest,
                &self.eligibility_basis,
            ]
            .iter()
            .any(|d| {
                d.len() != 64
                    || !d
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(invalid());
        }
        let mut seen = BTreeSet::new();
        let units: BTreeMap<_, _> = self.source.units.iter().map(|u| (&u.id, u)).collect();
        for locale in &self.locales {
            let canonical = crate::Locale::parse(&locale.choice.locale).map_err(|_| invalid())?;
            if canonical.as_str() != locale.choice.locale
                || !seen.insert(&locale.choice.locale)
                || locale.targets.len() != self.source.units.len()
            {
                return Err(invalid());
            }
            let mut mapped = BTreeSet::new();
            for target in &locale.targets {
                let unit = units.get(&target.local_unit_id).ok_or_else(invalid)?;
                let review = &target.review;
                if !mapped.insert(review.unit_id)
                    || target.local_source_revision_id != unit.source_revision_id
                    || review.source_text != unit.text
                    || review.source_snapshot_id != self.source_snapshot_id
                    || review.locale != locale.choice.locale
                    || review.basis_evidence.source_snapshot_id != self.source_snapshot_id
                    || review.basis_evidence.source_revision_id != review.source_revision_id
                    || review.current_check.is_none()
                    || !super::super::review::assess(review, false).0.is_empty()
                {
                    return Err(invalid());
                }
            }
            self.plugin_input(&locale.choice.locale)?;
        }
        sdk::validate_build_output_paths(
            self.locales
                .iter()
                .flat_map(|l| l.choice.output_paths.iter().map(String::as_str)),
        )
        .map_err(|_| invalid())?;
        Ok(())
    }
    fn fixed_input(&self, attempt: ExecutionId) -> Result<FixedInput, ExecutionError> {
        self.validate()?;
        let binding = self.build.builder();
        let items = self
            .locales
            .iter()
            .map(|l| {
                Ok(InputItem::new(
                    Scope {
                        kind: "release-build".into(),
                        id: self.source_snapshot_id.to_string(),
                        locale: Some(l.choice.locale.clone()),
                    },
                    serde_json::to_value(self.plugin_input(&l.choice.locale)?)
                        .map_err(|_| invalid())?,
                    vec![],
                ))
            })
            .collect::<Result<Vec<_>, ExecutionError>>()?;
        let ids = items.iter().map(|i| i.item_id).collect();
        let project = self.project_id.to_string().parse().map_err(|_| invalid())?;
        let mut envelope = InputEnvelope::new(
            project,
            BUILD_OPERATION,
            &binding.capability.declaration.contract.id,
            &binding.capability_version(),
            items,
        )?;
        envelope.attempt_id = attempt;
        envelope.units = vec![AdoptionUnit::new(ids)];
        envelope.settings = serde_json::to_value(self).map_err(|_| invalid())?;
        envelope.limits.max_result_bytes = MAX_RESULT_BYTES as u32;
        envelope.limits.timeout_ms = envelope
            .limits
            .timeout_ms
            .min(binding.capability.declaration.limits.timeout_ms);
        envelope.plugin = Some(binding);
        FixedInput::capture(envelope)
    }
    pub fn from_input(input: &FixedInput) -> Result<Self, ExecutionError> {
        let envelope = input.envelope();
        let plan: Self =
            serde_json::from_value(envelope.settings.clone()).map_err(|_| invalid())?;
        plan.validate()?;
        if envelope.operation != BUILD_OPERATION
            || envelope.project_id != plan.project_id
            || envelope.plugin.as_ref() != Some(&plan.build.builder())
            || envelope.units.len() != 1
            || envelope.items.len() != plan.locales.len()
            || envelope.limits.max_result_bytes != MAX_RESULT_BYTES as u32
            || envelope.limits.timeout_ms > plan.build.binding.builder.declaration.limits.timeout_ms
        {
            return Err(invalid());
        }
        let mut seen = BTreeSet::new();
        for item in &envelope.items {
            let locale = item.scope.locale.as_deref().ok_or_else(invalid)?;
            if !seen.insert(locale)
                || item.scope.kind != "release-build"
                || item.scope.id != plan.source_snapshot_id.to_string()
                || !item.dependencies.is_empty()
                || item.payload
                    != serde_json::to_value(plan.plugin_input(locale)?).map_err(|_| invalid())?
            {
                return Err(invalid());
            }
        }
        Ok(plan)
    }
}

pub(super) struct QualifiedRelease {
    pub(super) eligibility: crate::Eligibility,
    pub(super) locales: Vec<Vec<(u32, ReviewTarget)>>,
}
impl ProjectStore {
    /// Called under the existing read snapshot or ledger write transaction.
    pub(super) fn capture_qualified_release(
        &self,
        project: ExecutionId,
        locales: &[String],
        basis: &str,
    ) -> Result<QualifiedRelease, ExecutionError> {
        let eligibility = self.review_eligibility_if_basis(project, locales, basis)?;
        if !eligibility.ready {
            return Err(failure(ErrorCode::DependencyConflict, "build-ineligible"));
        }
        let mut captured = Vec::new();
        for locale in locales {
            let mut after = 0;
            let mut targets = Vec::new();
            loop {
                let page = self.review_page(project, locale, after, 100)?;
                targets.extend(
                    page.rows
                        .into_iter()
                        .enumerate()
                        .map(|(i, t)| (after + i as u32, t)),
                );
                match page.next_ordinal {
                    Some(next) => after = next,
                    None => break,
                }
            }
            captured.push(targets);
        }
        self.review_eligibility_if_basis(project, locales, basis)?;
        Ok(QualifiedRelease {
            eligibility,
            locales: captured,
        })
    }
    fn capture_plugin_release_plan(
        &self,
        project: ExecutionId,
        choices: &[PluginBuildLocaleChoice],
        basis: &str,
        build: &ReleaseBuildEnvironment,
    ) -> Result<ReleasePlan, ExecutionError> {
        build.validate()?;
        let languages: Vec<_> = choices.iter().map(|c| c.locale.clone()).collect();
        let qualified = self.capture_qualified_release(project, &languages, basis)?;
        let source_snapshot_id = qualified.eligibility.source_snapshot_id;
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "build-read"))?;
        let (_, (source_input, result, output, rows)) =
            super::super::content::snapshot_rows(connection, source_snapshot_id, true)?;
        let mut mapping = BTreeMap::new();
        for row in rows {
            let ids = (
                row.unit_id.ok_or_else(invalid)?,
                row.source_revision_id.ok_or_else(invalid)?,
            );
            if mapping
                .insert(row.occurrence.operation_unit_id, ids)
                .is_some_and(|prior| prior != ids)
            {
                return Err(failure(ErrorCode::CorruptLedger, "build-source-mapping"));
            }
        }
        let mut locales = Vec::new();
        for (choice, targets) in choices.iter().zip(qualified.locales) {
            let mut targets: BTreeMap<_, _> =
                targets.into_iter().map(|(_, t)| (t.unit_id, t)).collect();
            let mut mapped = Vec::new();
            for unit in &output.exchange.units {
                let (core_unit, core_revision) = mapping.get(&unit.id).ok_or_else(invalid)?;
                let review = targets.remove(core_unit).ok_or_else(invalid)?;
                if review.source_revision_id != *core_revision {
                    return Err(invalid());
                }
                mapped.push(PlanTarget {
                    local_unit_id: unit.id.clone(),
                    local_source_revision_id: unit.source_revision_id.clone(),
                    review,
                });
            }
            if !targets.is_empty() {
                return Err(invalid());
            }
            locales.push(PlanLocale {
                choice: choice.clone(),
                targets: mapped,
            });
        }
        let plan = ReleasePlan {
            version: 1,
            project_id: project,
            source_snapshot_id,
            source_attempt_id: source_input.envelope().attempt_id,
            source_result_id: result.envelope().result_id,
            source_input_digest: source_input.digest().into(),
            source_result_digest: result.digest().into(),
            policy_version: qualified.eligibility.policy_version,
            eligibility_basis: qualified.eligibility.basis,
            source: output.exchange,
            build: build.clone(),
            locales,
        };
        plan.validate()?;
        Ok(plan)
    }
    /// Reconciliation reads the original accepted input without recapturing newer
    /// selections, approvals, configuration, package bytes or environment choices.
    pub fn find_plugin_build(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        choices: &[PluginBuildLocaleChoice],
        basis: &str,
        build: &ReleaseBuildEnvironment,
    ) -> Result<Option<FixedInput>, ExecutionError> {
        if self
            .metadata()
            .map_err(|_| invalid())?
            .project_id()
            .to_string()
            != project.to_string()
        {
            return Err(failure(ErrorCode::Unauthorized, "build-project"));
        }
        let Some(input) = self.execution_input_if_present(attempt)? else {
            return Ok(None);
        };
        let plan = ReleasePlan::from_input(&input)?;
        if plan.project_id != project
            || plan.eligibility_basis != basis
            || plan.choices() != choices
            || &plan.build != build
        {
            return Err(failure(ErrorCode::ResultMismatch, "build-attempt-request"));
        }
        Ok(Some(input))
    }
    pub fn prepare_plugin_build(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        choices: &[PluginBuildLocaleChoice],
        basis: &str,
        build: &ReleaseBuildEnvironment,
    ) -> Result<FixedInput, ExecutionError> {
        if let Some(input) = self.find_plugin_build(project, attempt, choices, basis, build)? {
            return Ok(input);
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "build-read"))?;
        let snapshot = connection.unchecked_transaction().map_err(sql)?;
        let input = self
            .capture_plugin_release_plan(project, choices, basis, build)?
            .fixed_input(attempt)?;
        snapshot.commit().map_err(sql)?;
        Ok(input)
    }
}

fn validate_capture(store: &ProjectStore, input: &FixedInput) -> Result<(), ExecutionError> {
    let plan = ReleasePlan::from_input(input)?;
    // A continuation keeps the already qualified frozen plan. Later review
    // edits do not silently recapture it or discard successful locale results.
    let current = if let Some(previous) = input.envelope().previous_attempt_id {
        ReleasePlan::from_input(&store.execution_input(previous)?)?
    } else {
        store.capture_plugin_release_plan(
            plan.project_id,
            &plan.choices(),
            &plan.eligibility_basis,
            &plan.build,
        )?
    };
    if current != plan {
        return Err(failure(ErrorCode::ResultMismatch, "build-plan-capture"));
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct SnapshotStamp {
    data_version: i64,
    total_changes: u64,
}
fn stamp(connection: &Connection) -> Result<SnapshotStamp, ExecutionError> {
    Ok(SnapshotStamp {
        data_version: connection
            .query_row("PRAGMA main.data_version", [], |r| r.get(0))
            .map_err(sql)?,
        total_changes: connection.total_changes(),
    })
}
pub(in crate::persistence) struct PreparedBuildInput {
    input_digest: String,
    snapshot: SnapshotStamp,
}
pub(in crate::persistence) struct VerifiedBuildInput {
    input_digest: String,
}
/// Decode and compare the entire qualified plan in a read snapshot, before the
/// write transaction. No execution, authority renewal or persistent cache occurs.
pub(in crate::persistence) fn prepare_input(
    store: &ProjectStore,
    input: &FixedInput,
) -> Result<Option<PreparedBuildInput>, ExecutionError> {
    if input.envelope().operation != BUILD_OPERATION
        || input.envelope().plugin.is_none()
        || store
            .execution_input_if_present(input.envelope().attempt_id)?
            .is_some()
    {
        return Ok(None);
    }
    let connection = store
        .connection()
        .map_err(|_| failure(ErrorCode::StorageFailed, "build-read"))?;
    let before = stamp(connection)?;
    let read = connection.unchecked_transaction().map_err(sql)?;
    validate_capture(store, input)?;
    read.commit().map_err(sql)?;
    if stamp(connection)? != before {
        return Err(failure(
            ErrorCode::DependencyConflict,
            "build-capture-changed",
        ));
    }
    Ok(Some(PreparedBuildInput {
        input_digest: input.digest().into(),
        snapshot: before,
    }))
}
/// Called immediately after BEGIN IMMEDIATE, before any statement changes data.
/// The same connection's counters detect local writes and other-connection commits
/// between preparation and registration. A changed database conservatively rejects
/// new registration; accepted attempts reconcile from their original ledger data.
pub(in crate::persistence) fn verify_prepared_input(
    connection: &Connection,
    input: &FixedInput,
    prepared: Option<&PreparedBuildInput>,
) -> Result<Option<VerifiedBuildInput>, ExecutionError> {
    let Some(prepared) = prepared else {
        return Ok(None);
    };
    if connection.is_autocommit() || prepared.input_digest != input.digest() {
        return Err(failure(ErrorCode::ResultMismatch, "build-capture-proof"));
    }
    if stamp(connection)? != prepared.snapshot {
        return Err(failure(
            ErrorCode::DependencyConflict,
            "build-capture-changed",
        ));
    }
    Ok(Some(VerifiedBuildInput {
        input_digest: prepared.input_digest.clone(),
    }))
}
pub(super) fn record_input(
    input: &FixedInput,
    verified: Option<&VerifiedBuildInput>,
) -> Result<(), ExecutionError> {
    if verified.is_none_or(|proof| proof.input_digest != input.digest()) {
        return Err(failure(ErrorCode::ResultMismatch, "build-capture-proof"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
