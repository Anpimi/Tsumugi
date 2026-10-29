//! Rebuildable observations of the original decision owners. No inbox writes.
use super::{ProjectStore, review};
use crate::execution::{codec, ErrorCode, ExecutionError, ExecutionId, Revision};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::{BTreeMap, BTreeSet}};

mod content;
mod recovery;
mod local;
mod delivery;
mod questions;
mod source_pending;
pub use local::*;
#[cfg(test)]
mod tests;

pub(super) const SOURCE_LIMIT: usize = 1_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionSource {
    TranslationCandidate, ResourceProposal, AgentQuestion, SourceMapping,
    ExecutionUnknown, LocalActionRecovery, HumanReview, ReviewFinding, DeliveryBlocker, DeliveryUnknown,
}

impl DecisionSource {
    const ALL: [Self; 10] = [Self::TranslationCandidate, Self::ResourceProposal,
        Self::AgentQuestion, Self::SourceMapping, Self::ExecutionUnknown,
        Self::LocalActionRecovery, Self::HumanReview, Self::ReviewFinding, Self::DeliveryBlocker, Self::DeliveryUnknown];
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionTarget {
    Entry { unit_id: ExecutionId },
    Plan { plan_id: ExecutionId },
    Conversation { conversation_id: ExecutionId },
    ConversationProposal { conversation_id: ExecutionId, proposal_id: ExecutionId },
    SourceOccurrence { snapshot_id: ExecutionId, occurrence_id: ExecutionId },
    SourceResult { attempt_id: ExecutionId, result_id: ExecutionId },
    Resource { capture_id: ExecutionId, entry_id: String },
    Delivery { release_id: ExecutionId, delivery_id: ExecutionId },
    Project,
}

/// These are original read/navigation locators, never permission to mutate.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionAction {
    CompareCandidate { unit_id: ExecutionId, revision_id: ExecutionId,
        source_snapshot_id: ExecutionId, source_revision_id: ExecutionId },
    ReviewTranslation { unit_id: ExecutionId, selection_id: ExecutionId, revision_id: ExecutionId },
    ReviewFinding { unit_id: ExecutionId, run_id: ExecutionId, issue_id: String },
    ReviewResource { capture_id: ExecutionId, entry_id: String },
    ResolveSourceMapping { snapshot_id: ExecutionId, occurrence_id: ExecutionId, ordinal: u32 },
    CompareSourceMapping { attempt_id: ExecutionId, result_id: ExecutionId, previous_snapshot_id: ExecutionId,
        expected_content_revision: Revision },
    ClarifyConversationProposal { conversation_id: ExecutionId, proposal_id: ExecutionId, revision_id: ExecutionId },
    ReviewKnowledgeProposal { proposal:crate::application::ConversationProposalRef, entry_index:u32 },
    InspectExecution { task_id: ExecutionId, attempt_id: ExecutionId, item_id: ExecutionId },
    InspectDelivery { locale: String },
    InspectDeliveryOutcome { release_id: ExecutionId, delivery_id: ExecutionId, action_id: ExecutionId },
    InspectLocalRequest { reference: DecisionLocalRequestRef },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionState { Pending, Stale, AwaitingRecheck }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionEvidence {
    Delivery { blocker_count: u32, reasons: Vec<super::EligibilityReason>, reasons_complete: bool },
    LocalRequest { outcome: DecisionLocalOutcome, error_code: Option<ErrorCode> },
    DeliveryOutcome { state: super::DeliveryState, locales: Vec<String>, file_count: u32, unknown_file_count: u32 },
    SourceComparison { changed_count: u32, ambiguous_count: u32, rename_candidate_count: u32 },
    ProposalQuestions { question_count: u32 },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionItem {
    pub decision_id: String,
    pub source: DecisionSource,
    pub state: DecisionState,
    pub locale: Option<String>,
    pub targets: Vec<DecisionTarget>,
    /// Targets may be a bounded sample; the action always opens the full owner.
    pub targets_complete: bool,
    /// Observation fingerprint. Open the original reader for mutation inputs;
    /// this value is not a review, selection, or resource write basis.
    pub basis: String,
    pub source_action_id: Option<ExecutionId>,
    pub action: DecisionAction,
    pub evidence: Option<DecisionEvidence>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionCoverageState { Complete, Partial, Unavailable }

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionCoverageReason { SourceLimit, SourceUnavailable, SourceNotImplemented, LifecycleUnavailable }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionCoverage {
    pub source: DecisionSource,
    pub state: DecisionCoverageState,
    pub known_count: u32,
    pub total: Option<u32>,
    pub reason: Option<DecisionCoverageReason>,
    pub error_code: Option<ErrorCode>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionQuery {
    /// None reads all current target languages and retains execution unknowns
    /// for removed languages. An explicit language also permits recovery reads
    /// for that removed language; inapplicable owners report unavailable.
    pub locale: Option<String>,
    /// Empty means all registered sources, including unavailable adapters.
    pub sources: Vec<DecisionSource>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionCursor { pub basis: String, pub after_id: String }

/// Runtime observations supplement the single SQLite snapshot. Each attempt is
/// observed once per read; the vector is part of the pagination basis.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionExecutionActivity { pub attempt_id: ExecutionId, pub active: bool }

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionDeliveryJobKind { Preview, Export, Reconcile }

/// The original Host job owns native IO. This observation does not recreate
/// its directory selection or permit access to the destination.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionDeliveryActivity {
    pub job_id: ExecutionId,
    pub kind: DecisionDeliveryJobKind,
    pub release_id: ExecutionId,
    pub action_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionPage {
    pub project_id: ExecutionId,
    pub query: DecisionQuery,
    pub basis: String,
    pub items: Vec<DecisionItem>,
    pub next: Option<DecisionCursor>,
    /// Number of known decisions across the bounded sources, before pagination.
    pub known_count: u32,
    /// Exact only when every requested source was completely read.
    pub total: Option<u32>,
    pub coverage: Vec<DecisionCoverage>,
    pub execution_activity: Vec<DecisionExecutionActivity>,
    pub delivery_activity: Vec<DecisionDeliveryActivity>,
    pub local_actions: Option<DecisionLocalBasis>,
}

pub(super) struct SourceProjection { pub items: Vec<DecisionItem>, pub complete: bool }

fn failure(code: ErrorCode, stage: &str) -> ExecutionError { ExecutionError::new(code, stage) }

impl ProjectStore {
    pub fn decision_page(&self, project: ExecutionId, query: &DecisionQuery,
        cursor: Option<&DecisionCursor>, limit: u32, active: impl Fn(ExecutionId) -> bool,
    ) -> Result<DecisionPage, ExecutionError> {
        self.decision_page_with_host_observations(project, query, cursor, limit, active, &[], |_| Ok(None))
    }

    pub fn decision_page_with_host_observations(&self, project: ExecutionId, query: &DecisionQuery,
        cursor: Option<&DecisionCursor>, limit: u32, active: impl Fn(ExecutionId) -> bool,
        delivery_activity: &[DecisionDeliveryActivity],
        local: impl FnOnce(&ProjectStore) -> Result<Option<DecisionLocalProjection>, ExecutionError>,
    ) -> Result<DecisionPage, ExecutionError> {
        if limit == 0 || limit > 100 || query.sources.len() > DecisionSource::ALL.len()
            || query.sources.iter().collect::<BTreeSet<_>>().len() != query.sources.len()
            || cursor.is_some_and(|c| c.basis.len() != 64 || c.after_id.is_empty())
            || query.locale.as_deref().is_some_and(|locale| crate::Locale::parse(locale).is_err()
                || crate::Locale::parse(locale).is_ok_and(|parsed| parsed.as_str() != locale)) {
            return Err(failure(ErrorCode::InvalidInput, "decision-query"));
        }
        let c = self.connection().map_err(|_| failure(ErrorCode::StorageFailed, "decision-read"))?;
        review::read_snapshot(c, |c| {
            let metadata = super::read_metadata_from(c).map_err(|_| failure(ErrorCode::CorruptLedger, "decision-project"))?;
            if metadata.project_id().to_string() != project.to_string() {
                return Err(failure(ErrorCode::Unauthorized, "decision-project"));
            }
            let mut items = Vec::new();
            let mut coverage = Vec::new();
            let mut local = Some(local);
            let mut local_actions = None;
            let delivery_activity = if query.sources.is_empty() || query.sources.contains(&DecisionSource::DeliveryUnknown) {
                delivery_activity.to_vec()
            } else { Vec::new() };
            let activity = RefCell::new(BTreeMap::new());
            let observe = |attempt| *activity.borrow_mut().entry(attempt).or_insert_with(|| active(attempt));
            for source in DecisionSource::ALL {
                if !query.sources.is_empty() && !query.sources.contains(&source) { continue; }
                let mut local_reason = None;
                let mut local_error = None;
                let projections = match source {
                    DecisionSource::SourceMapping => vec![recovery::project(self, c, project, query.locale.as_deref(), source, &observe),
                        source_pending::project(self, c, project)],
                    DecisionSource::AgentQuestion => {
                        // Proposal questions are observable today. Member-to-human
                        // questions still need an explicit fact in their owner.
                        let projection = questions::project(self, c, project);
                        if projection.is_ok() { local_reason = Some(DecisionCoverageReason::SourceNotImplemented); }
                        vec![projection]
                    }
                    DecisionSource::DeliveryUnknown => vec![delivery::project(self, c, project, query.locale.as_deref(), &delivery_activity)],
                    DecisionSource::LocalActionRecovery => match local.take().expect("one local source")(self) {
                        Ok(Some(projection)) => {
                            local_reason = projection.reason; local_error = projection.error_code;
                            local_actions = Some(projection.basis);
                            vec![Ok(SourceProjection { items: projection.items, complete: projection.complete })]
                        }
                        Ok(None) => {
                            coverage.push(DecisionCoverage { source, state: DecisionCoverageState::Unavailable,
                                known_count: 0, total: None, reason: Some(DecisionCoverageReason::SourceNotImplemented), error_code: None });
                            continue;
                        }
                        Err(error) => vec![Err(error)],
                    },
                    DecisionSource::TranslationCandidate | DecisionSource::ResourceProposal |
                    DecisionSource::HumanReview | DecisionSource::ReviewFinding => {
                        let locales = query.locale.clone().map(|locale| vec![locale]).unwrap_or_else(||
                            metadata.target_locales().iter().map(|locale| locale.as_str().to_owned()).collect());
                        locales.iter().map(|locale| content::project(self, c, project, locale, source)).collect::<Vec<_>>()
                    }
                    _ => vec![recovery::project(self, c, project, query.locale.as_deref(), source, &observe)],
                };
                let mut rows = Vec::new();
                let mut complete = source != DecisionSource::AgentQuestion;
                let mut available = false;
                let mut error_code = local_error;
                for projection in projections {
                    match projection {
                        Ok(projection) => { available = true; complete &= projection.complete; rows.extend(projection.items); }
                        Err(error) => { complete = false; error_code = Some(error.code); }
                    }
                }
                rows.sort_by(|a,b| a.decision_id.cmp(&b.decision_id));
                if rows.windows(2).any(|pair| pair[0].decision_id == pair[1].decision_id && pair[0] != pair[1]) {
                    rows.clear(); available = false; complete = false; error_code = Some(ErrorCode::CorruptLedger);
                }
                rows.dedup_by(|a,b| a.decision_id == b.decision_id);
                if rows.len() > SOURCE_LIMIT { complete = false; rows.truncate(SOURCE_LIMIT); }
                let known_count = rows.len() as u32;
                coverage.push(DecisionCoverage { source,
                    state: if complete { DecisionCoverageState::Complete } else if available { DecisionCoverageState::Partial } else { DecisionCoverageState::Unavailable },
                    known_count, total: complete.then_some(known_count),
                    reason: if local_reason.is_some() { local_reason }
                        else if error_code.is_some() { Some(DecisionCoverageReason::SourceUnavailable) }
                        else { (!complete).then_some(DecisionCoverageReason::SourceLimit) }, error_code });
                items.extend(rows);
            }
            items.sort_by(|a,b| a.decision_id.cmp(&b.decision_id));
            let changes = self.changes_since(Revision::new(0)?);
            let external: i64 = c.query_row("PRAGMA data_version", [], |row| row.get(0)).map_err(super::ledger::sql_error)?;
            let execution_activity = activity.into_inner().into_iter().map(|(attempt_id, active)| DecisionExecutionActivity { attempt_id, active }).collect::<Vec<_>>();
            let basis = codec::digest(&codec::encode(&(project, query, changes.epoch, changes.sequence, external, &items, &coverage, &execution_activity, &delivery_activity, &local_actions), 16 * 1024 * 1024)?);
            if cursor.is_some_and(|cursor| cursor.basis != basis) {
                return Err(failure(ErrorCode::DependencyConflict, "decision-read-changed"));
            }
            let start = if let Some(cursor) = cursor {
                items.iter().position(|item| item.decision_id == cursor.after_id)
                    .ok_or_else(|| failure(ErrorCode::InvalidInput, "decision-cursor"))? + 1
            } else { 0 };
            let known_count = items.len() as u32;
            let complete = coverage.iter().all(|source| source.state == DecisionCoverageState::Complete);
            let end = (start + limit as usize).min(items.len());
            let page = items[start..end].to_vec();
            let next = (end < items.len()).then(|| DecisionCursor { basis: basis.clone(), after_id: page.last().expect("nonempty page").decision_id.clone() });
            Ok(DecisionPage { project_id: project, query: query.clone(), basis, items: page, next,
                known_count, total: complete.then_some(known_count), coverage, execution_activity, delivery_activity, local_actions })
        })
    }
}
