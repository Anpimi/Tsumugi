//! Read-only source context from the original adopted exchange and its checked
//! project mappings. This observation is neither a manual revision nor consent
//! to share any of its contents.

use super::{ProjectStore, check_project, failure};
use crate::execution::{ErrorCode, ExecutionError, ExecutionId, Revision};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use tsumugi_plugin_sdk as sdk;

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextRequest {
    pub project_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub locale: String,
}

/// The block's index and local target retain its identity inside the exact
/// result. `None` facts means an unsupported version; `Some` with an empty list
/// is the domain's explicit empty observation. Missing blocks remain missing.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextBlock {
    pub block_index: u32,
    pub target: sdk::ContentTarget,
    pub schema: sdk::ContractRef,
    pub handling: sdk::ExtensionHandling,
    pub in_revision_basis: bool,
    pub facts: Option<sdk::SourceContextFacts>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextOccurrence {
    pub occurrence_id: ExecutionId,
    pub local_occurrence_id: String,
    pub source: sdk::SourceReference,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceContextDirection {
    Before,
    After,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextAdjacency {
    pub occurrence_id: ExecutionId,
    /// The neighbor's position relative to this selected occurrence.
    pub direction: SourceContextDirection,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextNeighbor {
    pub unit_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub occurrence: SourceContextOccurrence,
    pub text: String,
    pub adjacent_to: Vec<SourceContextAdjacency>,
}

/// Complete source observations for one current unit/locale, before operation
/// selection and budgets. No glossary, manual context, grant or credential is
/// read. Consumers must explicitly select what they capture or share.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextView {
    pub scope: SourceContextRequest,
    pub content_revision: Revision,
    pub source_attempt_id: ExecutionId,
    pub source_result_id: ExecutionId,
    pub source_result_digest: String,
    pub source_locale: String,
    pub local_unit_id: String,
    pub occurrences: Vec<SourceContextOccurrence>,
    pub blocks: Vec<SourceContextBlock>,
    /// Immediate neighbors in the exchange's declared order, once per
    /// occurrence. Other occurrences of the selected unit are already above.
    pub neighbors: Vec<SourceContextNeighbor>,
}

fn corrupt() -> ExecutionError {
    failure(ErrorCode::CorruptLedger, "source-context-evidence")
}

fn occurrence(row: &crate::content::ContentRow) -> Result<SourceContextOccurrence, ExecutionError> {
    Ok(SourceContextOccurrence {
        occurrence_id: row.occurrence_id.ok_or_else(corrupt)?,
        local_occurrence_id: row.occurrence.operation_occurrence_id.clone(),
        source: row.occurrence.source.clone(),
    })
}

fn applies_to(
    target: &sdk::ContentTarget,
    local_unit_id: &str,
    local_occurrences: &BTreeSet<&str>,
) -> bool {
    match target {
        sdk::ContentTarget::Snapshot => true,
        sdk::ContentTarget::Unit { id } => id == local_unit_id,
        sdk::ContentTarget::Occurrence { id } => local_occurrences.contains(id.as_str()),
    }
}

/// A checked, immutable observation owned by one preparation read transaction.
/// Reuse it across units and variants instead of revalidating the source ledger
/// for each projection. It is never a cache or an authorization receipt.
pub(in crate::persistence) struct SourceContextReader {
    project_id: ExecutionId,
    locale: String,
    pub snapshot_id: ExecutionId,
    content_revision: Revision,
    pub source_locale: String,
    source_attempt_id: ExecutionId,
    source_result_id: ExecutionId,
    source_result_digest: String,
    output: crate::content::SourceOutput,
    rows: Vec<crate::content::ContentRow>,
}

impl SourceContextReader {
    pub fn read_in(
        connection: &Connection,
        project_id: ExecutionId,
        locale: &str,
    ) -> Result<Self, ExecutionError> {
        let source_locale = check_project(connection, project_id, locale)?;
        let scope = super::super::content::scope(connection)?;
        let snapshot_id = scope
            .current_snapshot
            .ok_or_else(|| failure(ErrorCode::DependencyConflict, "source-context-snapshot"))?;
        let (_, (input, result, output, rows)) =
            super::super::content::snapshot_rows(connection, snapshot_id, true)?;
        if input.envelope().project_id != project_id || output.source_language != source_locale {
            return Err(corrupt());
        }
        Ok(Self {
            project_id,
            locale: locale.into(),
            snapshot_id,
            content_revision: scope.revision,
            source_locale,
            source_attempt_id: input.envelope().attempt_id,
            source_result_id: result.envelope().result_id,
            source_result_digest: result.digest().to_owned(),
            output,
            rows,
        })
    }

    /// Verify a retained source result without requiring it to remain current.
    pub(in crate::persistence) fn historical_in(
        connection: &Connection,
        scope: &SourceContextRequest,
    ) -> Result<Self, ExecutionError> {
        let metadata = super::super::read_metadata_from(connection).map_err(|_| corrupt())?;
        if metadata.project_id().to_string() != scope.project_id.to_string() {
            return Err(corrupt());
        }
        let (_, (input, result, output, rows)) =
            super::super::content::snapshot_rows(connection, scope.source_snapshot_id, true)?;
        if input.envelope().project_id != scope.project_id
            || output.source_language != metadata.source_locale().as_str()
        {
            return Err(corrupt());
        }
        Ok(Self {
            project_id: scope.project_id,
            locale: scope.locale.clone(),
            snapshot_id: scope.source_snapshot_id,
            content_revision: super::super::content::scope(connection)?.revision,
            source_locale: output.source_language.clone(),
            source_attempt_id: input.envelope().attempt_id,
            source_result_id: result.envelope().result_id,
            source_result_digest: result.digest().to_owned(),
            output,
            rows,
        })
    }

    pub fn source_for_unit(
        &self,
        unit_id: ExecutionId,
    ) -> Result<&crate::content::ContentRow, ExecutionError> {
        let mut selected = self.rows.iter().filter(|row| row.unit_id == Some(unit_id));
        let first = selected
            .next()
            .ok_or_else(|| failure(ErrorCode::DependencyConflict, "source-context-unit"))?;
        if selected.any(|row| {
            row.source_revision_id != first.source_revision_id
                || row.occurrence.operation_unit_id != first.occurrence.operation_unit_id
        }) {
            return Err(corrupt());
        }
        Ok(first)
    }

    pub fn project(
        &self,
        request: &SourceContextRequest,
    ) -> Result<SourceContextView, ExecutionError> {
        if request.project_id != self.project_id || request.locale != self.locale {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "source-context-scope",
            ));
        }
        if request.source_snapshot_id != self.snapshot_id {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "source-context-snapshot",
            ));
        }
        let first = self.source_for_unit(request.unit_id)?;
        let rows = &self.rows;
        let output = &self.output;
        let selected: Vec<_> = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.unit_id == Some(request.unit_id))
            .collect();
        if selected
            .iter()
            .any(|(_, row)| row.source_revision_id != Some(request.source_revision_id))
        {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "source-context-revision",
            ));
        }
        let local_unit_id = first.occurrence.operation_unit_id.clone();
        let local_occurrences: BTreeSet<_> = selected
            .iter()
            .map(|(_, row)| row.occurrence.operation_occurrence_id.as_str())
            .collect();
        let blocks = output
            .exchange
            .domain_blocks
            .iter()
            .enumerate()
            .filter(|(_, block)| {
                block.schema.id == sdk::SOURCE_CONTEXT_FACTS_SCHEMA_ID
                    && applies_to(&block.target, &local_unit_id, &local_occurrences)
            })
            .map(|(index, block)| {
                Ok(SourceContextBlock {
                    block_index: u32::try_from(index).map_err(|_| corrupt())?,
                    target: block.target.clone(),
                    schema: block.schema.clone(),
                    handling: block.handling,
                    in_revision_basis: output
                        .revision_policy
                        .revision_basis
                        .contains(&block.schema),
                    facts: if block.schema == sdk::source_context_facts_contract() {
                        Some(
                            sdk::parse_source_context_block(block, &output.exchange.artifacts)
                                .map_err(|_| corrupt())?,
                        )
                    } else {
                        None
                    },
                })
            })
            .collect::<Result<Vec<_>, ExecutionError>>()?;
        let mut neighbors = BTreeMap::<usize, SourceContextNeighbor>::new();
        for (index, row) in &selected {
            for (position, direction) in [
                (index.checked_sub(1), SourceContextDirection::Before),
                (
                    index.checked_add(1).filter(|next| *next < rows.len()),
                    SourceContextDirection::After,
                ),
            ] {
                let Some(position) = position else { continue };
                let neighbor = &rows[position];
                if neighbor.unit_id == Some(request.unit_id) {
                    continue;
                }
                if let std::collections::btree_map::Entry::Vacant(entry) = neighbors.entry(position)
                {
                    entry.insert(SourceContextNeighbor {
                        unit_id: neighbor.unit_id.ok_or_else(corrupt)?,
                        source_revision_id: neighbor.source_revision_id.ok_or_else(corrupt)?,
                        occurrence: occurrence(neighbor)?,
                        text: neighbor.occurrence.text.clone(),
                        adjacent_to: vec![],
                    });
                }
                neighbors
                    .get_mut(&position)
                    .ok_or_else(corrupt)?
                    .adjacent_to
                    .push(SourceContextAdjacency {
                        occurrence_id: row.occurrence_id.ok_or_else(corrupt)?,
                        direction,
                    });
            }
        }
        Ok(SourceContextView {
            scope: request.clone(),
            content_revision: self.content_revision,
            source_attempt_id: self.source_attempt_id,
            source_result_id: self.source_result_id,
            source_result_digest: self.source_result_digest.clone(),
            source_locale: self.source_locale.clone(),
            local_unit_id,
            occurrences: selected
                .into_iter()
                .map(|(_, row)| occurrence(row))
                .collect::<Result<_, _>>()?,
            blocks,
            neighbors: neighbors.into_values().collect(),
        })
    }

    /// The checked view supplies exact local mappings. All schemas use the same
    /// applicability rule; no domain interpreter or live plugin is consulted.
    pub(super) fn stored_blocks(
        &self,
        view: &SourceContextView,
    ) -> Result<Vec<super::source_context_blocks::SourceContextBlockDescriptor>, ExecutionError>
    {
        let local_occurrences = view
            .occurrences
            .iter()
            .map(|occurrence| occurrence.local_occurrence_id.as_str())
            .collect();
        self.output
            .exchange
            .domain_blocks
            .iter()
            .enumerate()
            .filter(|(_, block)| applies_to(&block.target, &view.local_unit_id, &local_occurrences))
            .map(|(index, block)| {
                Ok(super::source_context_blocks::SourceContextBlockDescriptor {
                    block_index: u32::try_from(index).map_err(|_| corrupt())?,
                    target: block.target.clone(),
                    schema: block.schema.clone(),
                    handling: block.handling,
                    in_revision_basis: self
                        .output
                        .revision_policy
                        .revision_basis
                        .contains(&block.schema),
                    payload_bytes: u32::try_from(block.payload_utf8.len())
                        .map_err(|_| corrupt())?,
                })
            })
            .collect()
    }

    pub(super) fn block_payload(&self, index: u32) -> Result<&str, ExecutionError> {
        self.output
            .exchange
            .domain_blocks
            .get(index as usize)
            .map(|block| block.payload_utf8.as_str())
            .ok_or_else(corrupt)
    }
}

impl ProjectStore {
    /// Observe source facts and immediate ordered neighbors for one current
    /// unit/locale. The exact snapshot/revision must still be current. Original
    /// source, semantic proof and mappings are rechecked within one SQLite read
    /// snapshot; this call creates no project facts, captures or authority.
    /// Unsupported required blocks remain visible, not interpreted as empty.
    /// An operation requiring them must refuse capture without an interpreter.
    pub fn source_context(
        &self,
        request: &SourceContextRequest,
    ) -> Result<SourceContextView, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-context-read"))?;
        super::super::review::read_snapshot(connection, |connection| {
            SourceContextReader::read_in(connection, request.project_id, &request.locale)?
                .project(request)
        })
    }
}
