//! Bounded, read-only pages over one checked source-context observation.
//! Entries retain whole SDK facts and provenance for local inspection.

use super::ProjectStore;
use super::source_context::{
    SourceContextBlock, SourceContextNeighbor, SourceContextRequest, SourceContextView,
};
use super::source_context_selection::{SourceContextObservations, observe_source_context};
use crate::execution::{ErrorCode, ExecutionError, ExecutionId, Revision, codec};
use serde::{Deserialize, Serialize};

pub const MAX_SOURCE_CONTEXT_PAGE_BYTES: usize = 128 * 1024;
const MAX_PAGE_ENTRIES: u32 = 20;

fn invalid_page() -> ExecutionError {
    ExecutionError::new(ErrorCode::InvalidInput, "source-context-page")
}

fn page_budget() -> ExecutionError {
    ExecutionError::new(ErrorCode::LimitExceeded, "source-context-page-budget")
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SourceContextPageEntry {
    Block { value: SourceContextBlock },
    Neighbor { value: SourceContextNeighbor },
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextPage {
    pub scope: SourceContextRequest,
    pub content_revision: Revision,
    pub source_attempt_id: ExecutionId,
    pub source_result_id: ExecutionId,
    pub source_result_digest: String,
    pub source_locale: String,
    pub local_unit_id: String,
    pub occurrence_count: u32,
    pub observations: SourceContextObservations,
    pub entries: Vec<SourceContextPageEntry>,
    pub after: u32,
    pub next_after: Option<u32>,
    pub total_entries: u32,
}

/// Serializes like `SourceContextPageEntry`, while borrowing the checked view.
/// This lets the page account for a candidate before cloning its whole payload.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum BorrowedEntry<'a> {
    Block { value: &'a SourceContextBlock },
    Neighbor { value: &'a SourceContextNeighbor },
}

impl BorrowedEntry<'_> {
    fn owned(&self) -> SourceContextPageEntry {
        match self {
            Self::Block { value } => SourceContextPageEntry::Block {
                value: (**value).clone(),
            },
            Self::Neighbor { value } => SourceContextPageEntry::Neighbor {
                value: (**value).clone(),
            },
        }
    }
}

/// The view has already been checked against the adopted source in one SQLite
/// read snapshot. This pure step neither interprets unknown facts nor shares
/// source text; it only chooses complete local read entries.
pub(super) fn page_from_view(
    view: &SourceContextView,
    after: u32,
    limit: u32,
) -> Result<SourceContextPage, ExecutionError> {
    if !(1..=MAX_PAGE_ENTRIES).contains(&limit) {
        return Err(invalid_page());
    }
    let total = view
        .blocks
        .len()
        .checked_add(view.neighbors.len())
        .and_then(|count| u32::try_from(count).ok())
        .ok_or_else(invalid_page)?;
    if after > total {
        return Err(invalid_page());
    }
    let observations = observe_source_context(view)?;
    let mut page = SourceContextPage {
        scope: view.scope.clone(),
        content_revision: view.content_revision,
        source_attempt_id: view.source_attempt_id,
        source_result_id: view.source_result_id,
        source_result_digest: view.source_result_digest.clone(),
        source_locale: view.source_locale.clone(),
        local_unit_id: view.local_unit_id.clone(),
        occurrence_count: u32::try_from(view.occurrences.len()).map_err(|_| invalid_page())?,
        observations,
        entries: Vec::new(),
        after,
        next_after: None,
        total_entries: total,
    };

    let mut chosen = Vec::with_capacity(limit.min(total - after) as usize);
    let mut entry_bytes = 0usize;
    let mut offset = after;
    while offset < total && chosen.len() < limit as usize {
        let entry = if (offset as usize) < view.blocks.len() {
            BorrowedEntry::Block {
                value: &view.blocks[offset as usize],
            }
        } else {
            BorrowedEntry::Neighbor {
                value: &view.neighbors[offset as usize - view.blocks.len()],
            }
        };
        let encoded_entry = match codec::encode(&entry, MAX_SOURCE_CONTEXT_PAGE_BYTES) {
            Ok(bytes) => bytes.len(),
            Err(error) if error.stage == "limit-exceeded" && !chosen.is_empty() => break,
            Err(_) => return Err(page_budget()),
        };
        let next = offset + 1;
        page.next_after = (next < total).then_some(next);
        let empty_frame = codec::encode(&page, MAX_SOURCE_CONTEXT_PAGE_BYTES)
            .map_err(|_| page_budget())?
            .len();
        // The empty frame already contains `entries:[]`; inserting whole
        // entries adds their encoded bytes and the commas between them.
        let candidate_entries = entry_bytes + encoded_entry + usize::from(!chosen.is_empty());
        if empty_frame + candidate_entries > MAX_SOURCE_CONTEXT_PAGE_BYTES {
            if chosen.is_empty() {
                return Err(page_budget());
            }
            break;
        }
        entry_bytes = candidate_entries;
        chosen.push(entry);
        offset = next;
    }
    page.next_after = (offset < total).then_some(offset);
    page.entries = chosen.iter().map(BorrowedEntry::owned).collect();
    codec::encode(&page, MAX_SOURCE_CONTEXT_PAGE_BYTES).map_err(|_| page_budget())?;
    Ok(page)
}

impl ProjectStore {
    /// Read one bounded page from the current checked source snapshot. Every
    /// call rechecks the source/proof/mappings once, without project writes.
    pub fn source_context_page(
        &self,
        request: &SourceContextRequest,
        after: u32,
        limit: u32,
    ) -> Result<SourceContextPage, ExecutionError> {
        if !(1..=MAX_PAGE_ENTRIES).contains(&limit) {
            return Err(invalid_page());
        }
        let view = self.source_context(request)?;
        page_from_view(&view, after, limit)
    }
}

#[cfg(test)]
#[path = "source_context_page_tests.rs"]
mod tests;
