//! Read-only external disclosure through the existing project/resource owners.
use super::{ProjectStore, ledger, resources, review, translation};
use crate::{
    application::*,
    execution::{ErrorCode, ExecutionError, ExecutionId, Revision, codec},
};
use rusqlite::{Connection, OptionalExtension, params};

fn failure(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn id(value: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&value).map_err(|_| failure(ErrorCode::CorruptLedger, "mcp-share-basis"))
}
fn term(value: crate::TermRevision) -> McpSharedTerm {
    McpSharedTerm {
        revision_id: value.revision_id,
        source: value.source,
        target: value.target,
    }
}

fn preview_in(
    connection: &Connection,
    request: &McpShareRequest,
) -> Result<McpSharePreview, ExecutionError> {
    let metadata = super::read_metadata_from(connection)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "mcp-share-project"))?;
    if metadata.project_id().to_string() != request.project_id.to_string() {
        return Err(failure(ErrorCode::Unauthorized, "mcp-share-project"));
    }
    let locale = crate::Locale::parse(&request.locale)
        .map_err(|_| failure(ErrorCode::InvalidInput, "mcp-share-locale"))?;
    if locale.as_str() != request.locale || !metadata.target_locales().contains(&locale) {
        return Err(failure(ErrorCode::DependencyConflict, "mcp-share-locale"));
    }
    let source: Option<(String, String, String)> = connection
        .query_row(
            "SELECT o.snapshot_id,o.revision_id,r.text FROM source_occurrences o
         JOIN source_units u ON u.unit_id=o.unit_id AND u.project_id=?1
         JOIN source_revisions r ON r.unit_id=o.unit_id AND r.revision_id=o.revision_id
         JOIN content_scope c ON c.current_snapshot=o.snapshot_id
         WHERE o.unit_id=?2 ORDER BY o.ordinal LIMIT 1",
            params![request.project_id.to_string(), request.unit_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(ledger::sql_error)?;
    let Some((snapshot, source_revision, source_text)) = source else {
        return Err(failure(ErrorCode::DependencyConflict, "mcp-share-unit"));
    };
    let snapshot = id(snapshot)?;
    let source_revision = id(source_revision)?;
    let selection = translation::current_selection(connection, request.unit_id, &request.locale)?;
    let selected = selection
        .as_ref()
        .map(|selection| {
            let (source, text): (String, String) = connection
                .query_row(
                    "SELECT source_revision_id,text FROM translation_revisions
             WHERE project_id=?1 AND unit_id=?2 AND locale=?3 AND revision_id=?4",
                    params![
                        request.project_id.to_string(),
                        request.unit_id.to_string(),
                        request.locale,
                        selection.revision_id.to_string()
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(ledger::sql_error)?;
            if id(source)? != source_revision {
                return Err(failure(
                    ErrorCode::DependencyConflict,
                    "mcp-share-selection-source",
                ));
            }
            Ok(McpSharedTranslation {
                selection_id: selection.event_id,
                revision_id: selection.revision_id,
                text,
            })
        })
        .transpose()?;
    let terms = if request.share_terms {
        let resolution = resources::resolve_terms_in(
            connection,
            request.project_id,
            request.unit_id,
            &request.locale,
        )?;
        if resolution.source_revision_id != source_revision {
            return Err(failure(ErrorCode::CorruptLedger, "mcp-share-terms"));
        }
        Some(
            resolution
                .entries
                .into_iter()
                .map(|entry| McpSharedTermEntry {
                    source: entry.source,
                    selected: entry.selected.map(term),
                    conflicting: entry.conflicting.into_iter().map(term).collect(),
                })
                .collect::<Vec<_>>(),
        )
    } else {
        None
    };
    let context = if request.share_context {
        resources::current_context(
            connection,
            request.project_id,
            request.unit_id,
            &request.locale,
        )?
        .map(|value| McpSharedContext {
            revision_id: value.revision_id,
            text: value.text,
        })
    } else {
        None
    };
    let basis = McpShareBasis {
        project_id: request.project_id,
        unit_id: request.unit_id,
        locale: request.locale.clone(),
        source_snapshot_id: snapshot,
        source_revision_id: source_revision,
        selection_id: selected.as_ref().map(|value| value.selection_id),
        translation_revision_id: selected.as_ref().map(|value| value.revision_id),
        terms_digest: terms
            .as_ref()
            .map(|value| {
                codec::encode(value, MAX_MCP_SHARE_BYTES).map(|bytes| codec::digest(&bytes))
            })
            .transpose()?,
        context_revision_id: context.as_ref().map(|value| value.revision_id),
    };
    let payload = McpSharedUnit {
        unit_id: request.unit_id,
        locale: request.locale.clone(),
        source: McpSharedSource {
            snapshot_id: snapshot,
            revision_id: source_revision,
            text: source_text,
        },
        translation: selected,
        terms,
        manual_context: context,
    };
    let bytes = codec::encode(&payload, MAX_MCP_SHARE_BYTES)?;
    let digest = codec::digest(&codec::encode(
        &(MCP_SHARE_PREVIEW_VERSION, request, &basis, &payload),
        MAX_MCP_SHARE_PREVIEW_BYTES,
    )?);
    let preview = McpSharePreview {
        version: MCP_SHARE_PREVIEW_VERSION,
        basis,
        payload,
        byte_length: u32::try_from(bytes.len())
            .map_err(|_| failure(ErrorCode::LimitExceeded, "mcp-share-bytes"))?,
        digest,
    };
    codec::encode(&preview, MAX_MCP_SHARE_PREVIEW_BYTES)?;
    Ok(preview)
}

impl ProjectStore {
    /// Read all selected facts in one SQLite snapshot. No identity or grant is allocated.
    pub fn prepare_mcp_share(
        &self,
        request: &McpShareRequest,
    ) -> Result<CapturedMcpShare, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "mcp-share-session"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "mcp-share-session"))?;
        let preview =
            review::read_snapshot(connection, |connection| preview_in(connection, request))?;
        Ok(CapturedMcpShare {
            epoch: self.changes_since(Revision::new(0)?).epoch,
            request: request.clone(),
            preview,
        })
    }

    /// Existing disclosure authority remains bound to this exact opened Store.
    /// Later edits never replace or extend the already disclosed payload.
    pub fn check_mcp_share_session(
        &self,
        capture: &CapturedMcpShare,
    ) -> Result<(), ExecutionError> {
        let metadata = self
            .metadata()
            .map_err(|_| failure(ErrorCode::StorageFailed, "mcp-share-session"))?;
        if self.is_reconciling()
            || self.changes_since(Revision::new(0)?).epoch != capture.epoch
            || metadata.project_id().to_string() != capture.request.project_id.to_string()
        {
            return Err(failure(ErrorCode::Unauthorized, "mcp-share-session"));
        }
        Ok(())
    }

    /// Before recipient authorization, compare the exact original related basis
    /// and complete preview. This never refreshes the opaque captured payload.
    pub fn validate_mcp_share(&self, capture: &CapturedMcpShare) -> Result<(), ExecutionError> {
        self.check_mcp_share_session(capture)?;
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "mcp-share-session"))?;
        let current = review::read_snapshot(connection, |connection| {
            preview_in(connection, &capture.request)
        })?;
        if current != capture.preview {
            return Err(failure(ErrorCode::DependencyConflict, "mcp-share-current"));
        }
        Ok(())
    }
}
