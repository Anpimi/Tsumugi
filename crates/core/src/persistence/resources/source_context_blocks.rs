//! Exact, local inspection of already adopted domain-block bytes. A descriptor
//! is a read reference, never an interpreter, a capture or sharing authority.

use super::source_context::{SourceContextReader, SourceContextRequest, SourceContextView};
use super::{ProjectStore, failure};
use crate::execution::{ErrorCode, ExecutionError, ExecutionId, Revision, codec};
use serde::{Deserialize, Serialize};
use tsumugi_plugin_sdk as sdk;

/// A single inspected block uses a separate bounded response, not the ordinary
/// source-context page budget. This is a local response limit, not a transport
/// guarantee. The checked exchange already limits encoded payloads to 4 MiB;
/// the existing 8 MiB result ceiling leaves room for the exact read basis.
pub const MAX_SOURCE_CONTEXT_BLOCK_DETAIL_BYTES: usize = crate::execution::MAX_RESULT_BYTES;

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextBlockDescriptor {
    pub block_index: u32,
    pub target: sdk::ContentTarget,
    pub schema: sdk::ContractRef,
    pub handling: sdk::ExtensionHandling,
    pub in_revision_basis: bool,
    pub payload_bytes: u32,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextBlockBasis {
    pub scope: SourceContextRequest,
    pub content_revision: Revision,
    pub source_attempt_id: ExecutionId,
    pub source_result_id: ExecutionId,
    pub source_result_digest: String,
    pub source_locale: String,
    pub local_unit_id: String,
}

impl From<&SourceContextView> for SourceContextBlockBasis {
    fn from(view: &SourceContextView) -> Self {
        Self {
            scope: view.scope.clone(),
            content_revision: view.content_revision,
            source_attempt_id: view.source_attempt_id,
            source_result_id: view.source_result_id,
            source_result_digest: view.source_result_digest.clone(),
            source_locale: view.source_locale.clone(),
            local_unit_id: view.local_unit_id.clone(),
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextBlockRead {
    pub basis: SourceContextBlockBasis,
    pub descriptor: SourceContextBlockDescriptor,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextBlockDetail {
    pub basis: SourceContextBlockBasis,
    pub descriptor: SourceContextBlockDescriptor,
    /// Original UTF-8 text, without parsing, normalization or reserialization.
    pub payload_utf8: String,
}

impl ProjectStore {
    /// Recheck current source/proof/mappings and the complete original read
    /// identity before returning one applicable block. Unknown required blocks
    /// may be inspected; this does not permit operations that interpret them.
    pub fn source_context_block(
        &self,
        request: &SourceContextBlockRead,
    ) -> Result<SourceContextBlockDetail, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-context-read"))?;
        super::super::review::read_snapshot(connection, |connection| {
            let reader = SourceContextReader::read_in(
                connection,
                request.basis.scope.project_id,
                &request.basis.scope.locale,
            )?;
            let view = reader.project(&request.basis.scope)?;
            let basis = SourceContextBlockBasis::from(&view);
            if basis != request.basis {
                return Err(failure(
                    ErrorCode::DependencyConflict,
                    "source-context-block-basis",
                ));
            }
            let descriptor = reader
                .stored_blocks(&view)?
                .into_iter()
                .find(|descriptor| descriptor.block_index == request.descriptor.block_index)
                .filter(|descriptor| descriptor == &request.descriptor)
                .ok_or_else(|| {
                    failure(
                        ErrorCode::DependencyConflict,
                        "source-context-block-descriptor",
                    )
                })?;
            let detail = SourceContextBlockDetail {
                basis,
                descriptor,
                payload_utf8: reader
                    .block_payload(request.descriptor.block_index)?
                    .to_owned(),
            };
            codec::encode(&detail, MAX_SOURCE_CONTEXT_BLOCK_DETAIL_BYTES)
                .map_err(|_| failure(ErrorCode::LimitExceeded, "source-context-block-budget"))?;
            Ok(detail)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detail_budget_counts_full_six_byte_json_escapes_and_refuses_oversize_without_truncation() {
        let mut detail = SourceContextBlockDetail {
            basis: SourceContextBlockBasis {
                scope: SourceContextRequest {
                    project_id: ExecutionId::new(),
                    source_snapshot_id: ExecutionId::new(),
                    unit_id: ExecutionId::new(),
                    source_revision_id: ExecutionId::new(),
                    locale: "zh-CN".into(),
                },
                content_revision: Revision::new(1).unwrap(),
                source_attempt_id: ExecutionId::new(),
                source_result_id: ExecutionId::new(),
                source_result_digest: "a".repeat(64),
                source_locale: "en".into(),
                local_unit_id: "local-unit".into(),
            },
            descriptor: SourceContextBlockDescriptor {
                block_index: 0,
                target: sdk::ContentTarget::Snapshot,
                schema: sdk::ContractRef {
                    id: "example.raw".into(),
                    schema_version: 1,
                    behavior_version: 1,
                },
                handling: sdk::ExtensionHandling::Required,
                in_revision_basis: false,
                payload_bytes: (sdk::MAX_EXCHANGE_BYTES / 4) as u32,
            },
            payload_utf8: "\u{0001}".repeat(sdk::MAX_EXCHANGE_BYTES / 4),
        };
        let encoded = codec::encode(&detail, MAX_SOURCE_CONTEXT_BLOCK_DETAIL_BYTES).unwrap();
        assert!(encoded.len() >= 6 * detail.payload_utf8.len());
        assert_eq!(
            codec::decode::<SourceContextBlockDetail>(
                &encoded,
                MAX_SOURCE_CONTEXT_BLOCK_DETAIL_BYTES
            )
            .unwrap(),
            detail
        );
        // This all-C0 payload cannot pass the original 4 MiB exchange limit.
        // The standalone response encoder must still refuse it explicitly.
        detail.payload_utf8 = "\u{0001}".repeat(sdk::MAX_EXCHANGE_BYTES);
        detail.descriptor.payload_bytes = sdk::MAX_EXCHANGE_BYTES as u32;
        assert!(detail.payload_utf8.len() < MAX_SOURCE_CONTEXT_BLOCK_DETAIL_BYTES);
        assert!(codec::encode(&detail, MAX_SOURCE_CONTEXT_BLOCK_DETAIL_BYTES).is_err());
        assert_eq!(detail.payload_utf8.len(), sdk::MAX_EXCHANGE_BYTES);
    }
}
