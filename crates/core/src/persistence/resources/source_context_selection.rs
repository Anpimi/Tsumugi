//! Explicit, bounded capture of source observations for one operation. The
//! checked source view is the authority for provenance; a capture's structural
//! validation cannot independently prove the domain's claims.

use super::source_context::{
    SourceContextDirection, SourceContextNeighbor, SourceContextRequest, SourceContextView,
};
use crate::execution::{ErrorCode, ExecutionError, ExecutionId, Revision};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use tsumugi_plugin_sdk as sdk;

const MAX_SELECTED_BYTES: u32 = 16 * 1024;
const MIN_SELECTED_BYTES: u32 = b"{\"facts\":[],\"neighbors\":[]}".len() as u32;
const MAX_SELECTED_ITEMS: u32 = 128;
const MAX_CAPTURE_BYTES: usize = 32 * 1024;
const MAX_BASIS_BYTES: usize = 4096;
const MAX_SUMMARY_BYTES: usize = 4096;
const MAX_OBSERVATION_BYTES: usize = 2048;
const MAX_SAMPLES: usize = 8;

fn invalid() -> ExecutionError {
    ExecutionError::new(ErrorCode::InvalidInput, "source-context-capture")
}

fn encoded_len<T: Serialize>(value: &T) -> Result<usize, ExecutionError> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|_| invalid())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn nonempty_target(target: &sdk::ContentTarget) -> bool {
    match target {
        sdk::ContentTarget::Snapshot => true,
        sdk::ContentTarget::Unit { id } | sdk::ContentTarget::Occurrence { id } => {
            !id.is_empty() && id.len() <= 128
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextSelection {
    pub extracted: bool,
    pub inferred: bool,
    pub neighbors: bool,
    pub max_bytes: u32,
    pub max_items: u32,
}

impl Default for SourceContextSelection {
    fn default() -> Self {
        Self {
            extracted: false,
            inferred: false,
            neighbors: false,
            max_bytes: MAX_SELECTED_BYTES,
            max_items: MAX_SELECTED_ITEMS,
        }
    }
}

impl SourceContextSelection {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        if self.max_bytes < MIN_SELECTED_BYTES
            || self.max_bytes > MAX_SELECTED_BYTES
            || self.max_items == 0
            || self.max_items > MAX_SELECTED_ITEMS
        {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "source-context-budget",
            ));
        }
        Ok(())
    }

    pub fn is_enabled(&self) -> bool {
        self.extracted || self.inferred || self.neighbors
    }
}

/// One whole fact, with the original block target and source references.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedSourceFact {
    pub block_index: u32,
    pub fact_index: u32,
    pub target: sdk::ContentTarget,
    pub schema: sdk::ContractRef,
    pub handling: sdk::ExtensionHandling,
    pub in_revision_basis: bool,
    pub fact: sdk::SourceContextFact,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnknownSourceBlockSample {
    pub block_index: u32,
    pub target: sdk::ContentTarget,
    pub schema: sdk::ContractRef,
    pub handling: sdk::ExtensionHandling,
}

/// Missing, explicitly empty and unknown schema observations are distinct.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextObservations {
    pub missing_blocks: bool,
    pub known_blocks: u32,
    pub known_facts: u32,
    pub empty_blocks: u32,
    pub unknown_blocks: u32,
    pub unknown_required_blocks: u32,
    pub neighbor_occurrences: u32,
    pub unknown_samples: Vec<UnknownSourceBlockSample>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceContextOmissionReason {
    NotSelected,
    ByteBudget,
    ItemLimit,
}

/// A pointer only; omitted text and rationale never enter the capture.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SourceContextOmissionSample {
    Fact {
        #[serde(rename = "blockIndex")]
        block_index: u32,
        #[serde(rename = "factIndex")]
        fact_index: u32,
        reason: SourceContextOmissionReason,
    },
    Neighbor {
        #[serde(rename = "occurrenceId")]
        occurrence_id: ExecutionId,
        reason: SourceContextOmissionReason,
    },
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextOmissions {
    pub extracted: u32,
    pub inferred: u32,
    pub neighbors: u32,
    pub not_selected: u32,
    pub byte_budget: u32,
    pub item_limit: u32,
    pub samples: Vec<SourceContextOmissionSample>,
}

impl SourceContextOmissions {
    fn empty() -> Self {
        Self {
            extracted: 0,
            inferred: 0,
            neighbors: 0,
            not_selected: 0,
            byte_budget: 0,
            item_limit: 0,
            samples: Vec::new(),
        }
    }

    fn fact(
        &mut self,
        block_index: u32,
        fact_index: u32,
        inferred: bool,
        reason: SourceContextOmissionReason,
    ) {
        if inferred {
            self.inferred += 1
        } else {
            self.extracted += 1
        }
        self.reason(reason);
        if self.samples.len() < MAX_SAMPLES {
            self.samples.push(SourceContextOmissionSample::Fact {
                block_index,
                fact_index,
                reason,
            });
        }
    }

    fn neighbor(&mut self, occurrence_id: ExecutionId, reason: SourceContextOmissionReason) {
        self.neighbors += 1;
        self.reason(reason);
        if self.samples.len() < MAX_SAMPLES {
            self.samples.push(SourceContextOmissionSample::Neighbor {
                occurrence_id,
                reason,
            });
        }
    }

    fn reason(&mut self, reason: SourceContextOmissionReason) {
        match reason {
            SourceContextOmissionReason::NotSelected => self.not_selected += 1,
            SourceContextOmissionReason::ByteBudget => self.byte_budget += 1,
            SourceContextOmissionReason::ItemLimit => self.item_limit += 1,
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedSourceContext {
    pub scope: SourceContextRequest,
    pub content_revision: Revision,
    pub source_attempt_id: ExecutionId,
    pub source_result_id: ExecutionId,
    pub source_result_digest: String,
    pub source_locale: String,
    pub local_unit_id: String,
    pub selection: SourceContextSelection,
    pub observations: SourceContextObservations,
    pub facts: Vec<SelectedSourceFact>,
    pub neighbors: Vec<SourceContextNeighbor>,
    pub omissions: SourceContextOmissions,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SourceContextCapture {
    NotSelected,
    Selected { value: Box<SelectedSourceContext> },
}

#[derive(Serialize)]
struct SelectedItems<'a> {
    facts: &'a [SelectedSourceFact],
    neighbors: &'a [SourceContextNeighbor],
}

#[derive(Serialize)]
struct Basis<'a> {
    scope: &'a SourceContextRequest,
    content_revision: Revision,
    source_attempt_id: ExecutionId,
    source_result_id: ExecutionId,
    source_result_digest: &'a str,
    source_locale: &'a str,
    local_unit_id: &'a str,
}

impl SelectedSourceContext {
    fn basis(&self) -> Basis<'_> {
        Basis {
            scope: &self.scope,
            content_revision: self.content_revision,
            source_attempt_id: self.source_attempt_id,
            source_result_id: self.source_result_id,
            source_result_digest: &self.source_result_digest,
            source_locale: &self.source_locale,
            local_unit_id: &self.local_unit_id,
        }
    }

    fn validate(
        &self,
        selection: &SourceContextSelection,
        scope: &SourceContextRequest,
    ) -> Result<(), ExecutionError> {
        if !selection.is_enabled() || self.selection != *selection || self.scope != *scope {
            return Err(invalid());
        }
        let known_blocks = u64::from(self.observations.known_blocks);
        let unknown_blocks = u64::from(self.observations.unknown_blocks);
        let known_facts = u64::from(self.observations.known_facts);
        let omitted_facts =
            u64::from(self.omissions.extracted) + u64::from(self.omissions.inferred);
        let omitted_total = omitted_facts + u64::from(self.omissions.neighbors);
        let omitted_by_reason = u64::from(self.omissions.not_selected)
            + u64::from(self.omissions.byte_budget)
            + u64::from(self.omissions.item_limit);
        if !is_sha256(&self.source_result_digest)
            || self.source_locale.is_empty()
            || self.local_unit_id.is_empty()
            || self.scope.locale.is_empty()
            || encoded_len(&self.basis())? > MAX_BASIS_BYTES
            || encoded_len(&self.observations)? > MAX_OBSERVATION_BYTES
            || encoded_len(&(&self.observations, &self.omissions))? > MAX_SUMMARY_BYTES
            || self.observations.unknown_samples.len() > MAX_SAMPLES
            || self.omissions.samples.len() > MAX_SAMPLES
            || known_blocks + unknown_blocks > sdk::MAX_CONTENT_DOMAIN_BLOCKS as u64
            || known_facts > known_blocks * sdk::MAX_SOURCE_CONTEXT_FACTS as u64
            || u64::from(self.observations.neighbor_occurrences) > sdk::MAX_CONTENT_ITEMS as u64
            || self.observations.missing_blocks
                != (self.observations.known_blocks == 0 && self.observations.unknown_blocks == 0)
            || self.observations.empty_blocks > self.observations.known_blocks
            || self.observations.unknown_required_blocks > self.observations.unknown_blocks
            || self.observations.unknown_samples.len() > self.observations.unknown_blocks as usize
            || known_facts != self.facts.len() as u64 + omitted_facts
            || u64::from(self.observations.neighbor_occurrences)
                != self.neighbors.len() as u64 + u64::from(self.omissions.neighbors)
            || omitted_total != omitted_by_reason
        {
            return Err(invalid());
        }
        if (selection.extracted || selection.inferred)
            && self.observations.unknown_required_blocks > 0
        {
            return Err(ExecutionError::new(
                ErrorCode::DependencyConflict,
                "source-context-interpreter",
            ));
        }
        let mut unknown_block_indices = BTreeSet::new();
        let mut sampled_required = 0usize;
        for sample in &self.observations.unknown_samples {
            if sample.schema.id != sdk::SOURCE_CONTEXT_FACTS_SCHEMA_ID
                || sample.schema == sdk::source_context_facts_contract()
                || !nonempty_target(&sample.target)
                || sample.block_index as usize >= sdk::MAX_CONTENT_DOMAIN_BLOCKS
                || !unknown_block_indices.insert(sample.block_index)
            {
                return Err(invalid());
            }
            if sample.handling == sdk::ExtensionHandling::Required {
                sampled_required += 1;
            }
        }
        if sampled_required > self.observations.unknown_required_blocks as usize {
            return Err(invalid());
        }
        let mut fact_positions = BTreeSet::new();
        let mut fact_ids = BTreeSet::new();
        let mut block_metadata = std::collections::BTreeMap::new();
        let mut last_fact_position = None;
        for selected in &self.facts {
            let inferred = matches!(
                &selected.fact.origin,
                sdk::SourceContextFactOrigin::Inferred { .. }
            );
            if !((inferred && selection.inferred) || (!inferred && selection.extracted))
                || selected.schema != sdk::source_context_facts_contract()
                || !nonempty_target(&selected.target)
                || selected.block_index as usize >= sdk::MAX_CONTENT_DOMAIN_BLOCKS
                || selected.fact_index as usize >= sdk::MAX_SOURCE_CONTEXT_FACTS
                || unknown_block_indices.contains(&selected.block_index)
                || !fact_positions.insert((selected.block_index, selected.fact_index))
                || !fact_ids.insert((selected.block_index, selected.fact.id.as_str()))
                || last_fact_position
                    .is_some_and(|last| last >= (selected.block_index, selected.fact_index))
                || (sdk::SourceContextFacts {
                    facts: vec![selected.fact.clone()],
                })
                .validate()
                .is_err()
            {
                return Err(invalid());
            }
            last_fact_position = Some((selected.block_index, selected.fact_index));
            let metadata = (
                &selected.target,
                &selected.schema,
                selected.handling,
                selected.in_revision_basis,
            );
            if block_metadata
                .insert(selected.block_index, metadata.clone())
                .is_some_and(|previous| previous != metadata)
            {
                return Err(invalid());
            }
        }
        let mut neighbors = BTreeSet::new();
        for neighbor in &self.neighbors {
            if !selection.neighbors
                || neighbor.text.is_empty()
                || neighbor.occurrence.local_occurrence_id.is_empty()
                || neighbor.occurrence.source.artifact_id.is_empty()
                || neighbor.occurrence.source.range.start >= neighbor.occurrence.source.range.end
                || !neighbors.insert(neighbor.occurrence.occurrence_id)
                || neighbor.adjacent_to.is_empty()
                || neighbor
                    .adjacent_to
                    .iter()
                    .any(|adjacent| adjacent.occurrence_id == neighbor.occurrence.occurrence_id)
            {
                return Err(invalid());
            }
            let mut directions = BTreeSet::new();
            for adjacent in &neighbor.adjacent_to {
                if !directions.insert((
                    adjacent.occurrence_id,
                    match adjacent.direction {
                        SourceContextDirection::Before => 0u8,
                        SourceContextDirection::After => 1u8,
                    },
                )) {
                    return Err(invalid());
                }
            }
        }
        let mut sampled_facts_seen = BTreeSet::new();
        let mut sampled_neighbors_seen = BTreeSet::new();
        let mut sampled_reasons = [0u32; 3];
        let mut sampled_facts = 0u32;
        let mut sampled_neighbors = 0u32;
        for sample in &self.omissions.samples {
            let reason = match sample {
                SourceContextOmissionSample::Fact {
                    block_index,
                    fact_index,
                    reason,
                } => {
                    sampled_facts += 1;
                    if *block_index as usize >= sdk::MAX_CONTENT_DOMAIN_BLOCKS
                        || *fact_index as usize >= sdk::MAX_SOURCE_CONTEXT_FACTS
                        || fact_positions.contains(&(*block_index, *fact_index))
                        || !sampled_facts_seen.insert((*block_index, *fact_index))
                    {
                        return Err(invalid());
                    }
                    *reason
                }
                SourceContextOmissionSample::Neighbor {
                    occurrence_id,
                    reason,
                } => {
                    sampled_neighbors += 1;
                    if neighbors.contains(occurrence_id)
                        || !sampled_neighbors_seen.insert(*occurrence_id)
                    {
                        return Err(invalid());
                    }
                    *reason
                }
            };
            sampled_reasons[match reason {
                SourceContextOmissionReason::NotSelected => 0,
                SourceContextOmissionReason::ByteBudget => 1,
                SourceContextOmissionReason::ItemLimit => 2,
            }] += 1;
        }
        if u64::from(sampled_facts) > omitted_facts
            || sampled_neighbors > self.omissions.neighbors
            || sampled_reasons[0] > self.omissions.not_selected
            || sampled_reasons[1] > self.omissions.byte_budget
            || sampled_reasons[2] > self.omissions.item_limit
        {
            return Err(invalid());
        }
        let item_count = self.facts.len() + self.neighbors.len();
        if item_count > selection.max_items as usize
            || encoded_len(&SelectedItems {
                facts: &self.facts,
                neighbors: &self.neighbors,
            })? > selection.max_bytes as usize
        {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "source-context-budget",
            ));
        }
        Ok(())
    }
}

impl SourceContextCapture {
    /// Checks declared scope, categories, size and internal shape. Only a fresh
    /// checked source view can establish that these claims came from the domain.
    pub fn validate_against(
        &self,
        selection: &SourceContextSelection,
        scope: &SourceContextRequest,
    ) -> Result<(), ExecutionError> {
        selection.validate()?;
        match self {
            Self::NotSelected if !selection.is_enabled() => {}
            Self::Selected { value } => value.validate(selection, scope)?,
            _ => return Err(invalid()),
        }
        crate::execution::codec::encode(self, MAX_CAPTURE_BYTES).map_err(|_| {
            ExecutionError::new(ErrorCode::LimitExceeded, "source-context-capture-budget")
        })?;
        Ok(())
    }

    /// A provider-facing semantic projection; never includes source coordinates,
    /// local/artifact IDs, revisions or omitted material.
    pub fn provider_projection(&self) -> Option<SourceContextProviderProjection> {
        let Self::Selected { value } = self else {
            return None;
        };
        Some(SourceContextProviderProjection {
            facts: value
                .facts
                .iter()
                .map(|item| SourceContextProviderFact {
                    kind: item.fact.kind.clone(),
                    text: item.fact.text.clone(),
                    origin: match &item.fact.origin {
                        sdk::SourceContextFactOrigin::Extracted { .. } => {
                            SourceContextProviderOrigin::Extracted
                        }
                        sdk::SourceContextFactOrigin::Inferred { rationale, .. } => {
                            SourceContextProviderOrigin::Inferred {
                                rationale: rationale.clone(),
                            }
                        }
                    },
                })
                .collect(),
            neighbors: value
                .neighbors
                .iter()
                .map(|item| {
                    let directions = [
                        SourceContextDirection::Before,
                        SourceContextDirection::After,
                    ]
                    .into_iter()
                    .filter(|direction| {
                        item.adjacent_to
                            .iter()
                            .any(|adjacent| adjacent.direction == *direction)
                    })
                    .collect();
                    SourceContextProviderNeighbor {
                        text: item.text.clone(),
                        directions,
                    }
                })
                .collect(),
        })
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextProviderProjection {
    pub facts: Vec<SourceContextProviderFact>,
    pub neighbors: Vec<SourceContextProviderNeighbor>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextProviderFact {
    pub kind: sdk::SourceContextFactKind,
    pub text: String,
    pub origin: SourceContextProviderOrigin,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SourceContextProviderOrigin {
    Extracted,
    Inferred { rationale: String },
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextProviderNeighbor {
    pub text: String,
    pub directions: Vec<SourceContextDirection>,
}

/// Select complete entries in original block/fact order, then neighboring
/// occurrences in the view's exchange order. Nothing is sent by this function.
pub fn select_source_context(
    view: &SourceContextView,
    selection: &SourceContextSelection,
) -> Result<SourceContextCapture, ExecutionError> {
    select_source_context_excluding(view, selection, &BTreeSet::new())
}

pub(super) fn select_source_context_excluding(
    view: &SourceContextView,
    selection: &SourceContextSelection,
    excluded: &BTreeSet<(u32, u32)>,
) -> Result<SourceContextCapture, ExecutionError> {
    selection.validate()?;
    if !selection.is_enabled() {
        return Ok(SourceContextCapture::NotSelected);
    }
    let observations = observe_source_context(view)?;
    if (selection.extracted || selection.inferred) && observations.unknown_required_blocks > 0 {
        return Err(ExecutionError::new(
            ErrorCode::DependencyConflict,
            "source-context-interpreter",
        ));
    }
    let mut selected = SelectedSourceContext {
        scope: view.scope.clone(),
        content_revision: view.content_revision,
        source_attempt_id: view.source_attempt_id,
        source_result_id: view.source_result_id,
        source_result_digest: view.source_result_digest.clone(),
        source_locale: view.source_locale.clone(),
        local_unit_id: view.local_unit_id.clone(),
        selection: selection.clone(),
        observations,
        facts: Vec::new(),
        neighbors: Vec::new(),
        omissions: SourceContextOmissions::empty(),
    };
    let mut used = encoded_len(&SelectedItems {
        facts: &[],
        neighbors: &[],
    })?;
    for block in &view.blocks {
        let Some(facts) = &block.facts else { continue };
        for (fact_index, fact) in facts.facts.iter().enumerate() {
            let inferred = matches!(&fact.origin, sdk::SourceContextFactOrigin::Inferred { .. });
            if excluded.contains(&(block.block_index, fact_index as u32))
                || (inferred && !selection.inferred)
                || (!inferred && !selection.extracted)
            {
                selected.omissions.fact(
                    block.block_index,
                    fact_index as u32,
                    inferred,
                    SourceContextOmissionReason::NotSelected,
                );
                continue;
            }
            let item = SelectedSourceFact {
                block_index: block.block_index,
                fact_index: fact_index as u32,
                target: block.target.clone(),
                schema: block.schema.clone(),
                handling: block.handling,
                in_revision_basis: block.in_revision_basis,
                fact: fact.clone(),
            };
            let reason = if selected.facts.len() + selected.neighbors.len()
                >= selection.max_items as usize
            {
                Some(SourceContextOmissionReason::ItemLimit)
            } else {
                let cost = encoded_len(&item)? + usize::from(!selected.facts.is_empty());
                if used + cost > selection.max_bytes as usize {
                    Some(SourceContextOmissionReason::ByteBudget)
                } else {
                    used += cost;
                    None
                }
            };
            if let Some(reason) = reason {
                selected
                    .omissions
                    .fact(block.block_index, fact_index as u32, inferred, reason);
            } else {
                selected.facts.push(item);
            }
        }
    }
    for neighbor in &view.neighbors {
        if !selection.neighbors {
            selected.omissions.neighbor(
                neighbor.occurrence.occurrence_id,
                SourceContextOmissionReason::NotSelected,
            );
            continue;
        }
        let reason =
            if selected.facts.len() + selected.neighbors.len() >= selection.max_items as usize {
                Some(SourceContextOmissionReason::ItemLimit)
            } else {
                let cost = encoded_len(neighbor)? + usize::from(!selected.neighbors.is_empty());
                if used + cost > selection.max_bytes as usize {
                    Some(SourceContextOmissionReason::ByteBudget)
                } else {
                    used += cost;
                    None
                }
            };
        if let Some(reason) = reason {
            selected
                .omissions
                .neighbor(neighbor.occurrence.occurrence_id, reason);
        } else {
            selected.neighbors.push(neighbor.clone());
        }
    }
    let capture = SourceContextCapture::Selected {
        value: Box::new(selected),
    };
    capture.validate_against(selection, &view.scope)?;
    Ok(capture)
}

/// Summarize the checked view without interpreting any source fact version.
/// Reading may report unknown required blocks; only fact selection refuses them.
pub(super) fn observe_source_context(
    view: &SourceContextView,
) -> Result<SourceContextObservations, ExecutionError> {
    if view.blocks.len() > sdk::MAX_CONTENT_DOMAIN_BLOCKS
        || view.neighbors.len() > sdk::MAX_CONTENT_ITEMS
        || view.occurrences.len() > sdk::MAX_CONTENT_ITEMS
    {
        return Err(invalid());
    }
    let mut observations = SourceContextObservations {
        missing_blocks: view.blocks.is_empty(),
        known_blocks: 0,
        known_facts: 0,
        empty_blocks: 0,
        unknown_blocks: 0,
        unknown_required_blocks: 0,
        neighbor_occurrences: view.neighbors.len() as u32,
        unknown_samples: Vec::new(),
    };
    for block in &view.blocks {
        if block.schema.id != sdk::SOURCE_CONTEXT_FACTS_SCHEMA_ID
            || (block.schema == sdk::source_context_facts_contract()) != block.facts.is_some()
            || block.block_index as usize >= sdk::MAX_CONTENT_DOMAIN_BLOCKS
        {
            return Err(invalid());
        }
        if let Some(facts) = &block.facts {
            // The checked reader has validated SDK payloads once for this
            // source snapshot. Observation only needs the count bound here;
            // capture separately validates each included fact.
            if facts.facts.len() > sdk::MAX_SOURCE_CONTEXT_FACTS {
                return Err(invalid());
            }
            observations.known_blocks += 1;
            observations.known_facts += facts.facts.len() as u32;
            if facts.facts.is_empty() {
                observations.empty_blocks += 1;
            }
        } else {
            observations.unknown_blocks += 1;
            if block.handling == sdk::ExtensionHandling::Required {
                observations.unknown_required_blocks += 1;
            }
            if observations.unknown_samples.len() < MAX_SAMPLES {
                observations.unknown_samples.push(UnknownSourceBlockSample {
                    block_index: block.block_index,
                    target: block.target.clone(),
                    schema: block.schema.clone(),
                    handling: block.handling,
                });
                if encoded_len(&observations)? > MAX_OBSERVATION_BYTES {
                    observations.unknown_samples.pop();
                }
            }
        }
    }
    Ok(observations)
}

#[cfg(test)]
#[path = "source_context_selection_tests.rs"]
mod tests;
