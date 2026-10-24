//! Display projections preserve full counters without changing fixed payloads.
use super::*;
use tsumugi_core::{
    ContextRevision,
    ai::{
        AiItem, AiOutput, AiPreview, SharedTerm, Usage,
        arena::{ArenaItem, ArenaPreview},
    },
    execution::UnsignedDecimal,
};

// The legacy Desktop captures only its displayed fixed-completion fields.
// New Core provenance is constructed explicitly and retained in fixed inputs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AiConfig {
    pub endpoint: String,
    pub model: String,
    pub credential_env: String,
    pub token_field: String,
    pub max_items: u32,
    pub concurrency: u32,
    pub max_requests: u32,
    pub max_output_tokens: u32,
    pub max_retries: u32,
    pub timeout_seconds: u32,
    pub share_terms: bool,
    pub share_context: bool,
}
impl From<tsumugi_core::ai::AiConfig> for AiConfig {
    fn from(value: tsumugi_core::ai::AiConfig) -> Self {
        Self {
            endpoint: value.endpoint,
            model: value.model,
            credential_env: value.credential_env,
            token_field: value.token_field,
            max_items: value.max_items,
            concurrency: value.concurrency,
            max_requests: value.max_requests,
            max_output_tokens: value.max_output_tokens,
            max_retries: value.max_retries,
            timeout_seconds: value.timeout_seconds,
            share_terms: value.share_terms,
            share_context: value.share_context,
        }
    }
}
impl From<AiConfig> for tsumugi_core::ai::AiConfig {
    fn from(value: AiConfig) -> Self {
        Self {
            connection_profile: None,
            context_strategy: None,
            source_context: Default::default(),
            endpoint: value.endpoint,
            model: value.model,
            credential_env: value.credential_env,
            token_field: value.token_field,
            max_items: value.max_items,
            concurrency: value.concurrency,
            max_requests: value.max_requests,
            max_output_tokens: value.max_output_tokens,
            max_retries: value.max_retries,
            timeout_seconds: value.timeout_seconds,
            share_terms: value.share_terms,
            share_context: value.share_context,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArenaConfig {
    pub variants: Vec<AiConfig>,
    pub max_items: u32,
    pub max_requests: u32,
    pub concurrency: u32,
    pub blind: bool,
    pub parent_attempt_id: Option<ExecutionId>,
}
impl From<tsumugi_core::ai::arena::ArenaConfig> for ArenaConfig {
    fn from(value: tsumugi_core::ai::arena::ArenaConfig) -> Self {
        Self {
            variants: value.variants.into_iter().map(Into::into).collect(),
            max_items: value.max_items,
            max_requests: value.max_requests,
            concurrency: value.concurrency,
            blind: value.blind,
            parent_attempt_id: value.parent_attempt_id,
        }
    }
}
impl From<ArenaConfig> for tsumugi_core::ai::arena::ArenaConfig {
    fn from(value: ArenaConfig) -> Self {
        Self {
            variants: value.variants.into_iter().map(Into::into).collect(),
            max_items: value.max_items,
            max_requests: value.max_requests,
            concurrency: value.concurrency,
            blind: value.blind,
            parent_attempt_id: value.parent_attempt_id,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
impl From<tsumugi_core::ProviderBudget> for ProviderBudget {
    fn from(value: tsumugi_core::ProviderBudget) -> Self {
        Self {
            limit: value.limit,
            dispatched: value.dispatched,
            legacy_held: value.legacy_held,
            unresolved: value.unresolved,
            usage_unknown: value.usage_unknown,
            prompt_tokens: value.prompt_tokens,
            completion_tokens: value.completion_tokens,
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiItemView {
    pub unit_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub native_key: String,
    pub source_locale: String,
    pub source_text: String,
    pub target_locale: String,
    pub terms: Vec<SharedTerm>,
    pub context: Option<ContextRevision>,
    pub omissions: Vec<String>,
    pub resource_baseline: UnsignedDecimal,
}
impl From<AiItem> for AiItemView {
    fn from(item: AiItem) -> Self {
        let AiItem {
            unit_id,
            source_revision_id,
            source_snapshot_id,
            native_key,
            source_locale,
            source_text,
            target_locale,
            terms,
            context,
            omissions,
            resource_baseline,
            // The existing view has no source/project fact editor. Core retains both.
            source_context: _,
            project_context: _,
        } = item;
        Self {
            unit_id,
            source_revision_id,
            source_snapshot_id,
            native_key,
            source_locale,
            source_text,
            target_locale,
            terms,
            context,
            omissions,
            resource_baseline: resource_baseline.into(),
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiUsageView {
    pub prompt_tokens: UnsignedDecimal,
    pub completion_tokens: UnsignedDecimal,
}
impl From<Usage> for AiUsageView {
    fn from(
        Usage {
            prompt_tokens,
            completion_tokens,
            // This display totals view does not rewrite the original detailed receipt.
            cache_read_tokens: _,
            cache_write_tokens: _,
            reasoning_tokens: _,
        }: Usage,
    ) -> Self {
        Self {
            prompt_tokens: prompt_tokens.into(),
            completion_tokens: completion_tokens.into(),
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiOutputView {
    pub unit_id: ExecutionId,
    pub target_locale: String,
    pub text: String,
    pub usage: Option<AiUsageView>,
    pub requests: u32,
    pub usage_incomplete: bool,
}
impl From<AiOutput> for AiOutputView {
    fn from(
        AiOutput {
            unit_id,
            target_locale,
            text,
            usage,
            requests,
            usage_incomplete,
        }: AiOutput,
    ) -> Self {
        Self {
            unit_id,
            target_locale,
            text,
            usage: usage.map(Into::into),
            requests,
            usage_incomplete,
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiPreviewView {
    pub config: AiConfig,
    pub recipe: String,
    pub items: Vec<AiItemView>,
    pub digest: String,
}
impl From<AiPreview> for AiPreviewView {
    fn from(
        AiPreview {
            config,
            recipe,
            items,
            digest,
        }: AiPreview,
    ) -> Self {
        Self {
            config: config.into(),
            recipe,
            items: items.into_iter().map(Into::into).collect(),
            digest,
        }
    }
}

pub fn index(value: usize) -> Result<u32, ExecutionError> {
    u32::try_from(value)
        .map_err(|_| ExecutionError::new(ErrorCode::CorruptLedger, "arena-wire-index"))
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArenaItemView {
    pub slot: u32,
    pub source_order: u32,
    pub item: AiItemView,
}
impl TryFrom<ArenaItem> for ArenaItemView {
    type Error = ExecutionError;
    fn try_from(
        ArenaItem {
            slot,
            source_order,
            item,
        }: ArenaItem,
    ) -> Result<Self, Self::Error> {
        Ok(Self {
            slot: index(slot)?,
            source_order: index(source_order)?,
            item: item.into(),
        })
    }
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArenaPreviewView {
    pub config: ArenaConfig,
    pub items: Vec<ArenaItemView>,
    pub digest: String,
}
impl TryFrom<ArenaPreview> for ArenaPreviewView {
    type Error = ExecutionError;
    fn try_from(
        ArenaPreview {
            config,
            items,
            digest,
        }: ArenaPreview,
    ) -> Result<Self, Self::Error> {
        Ok(Self {
            config: config.into(),
            items: items
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
            digest,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ComparisonEntry {
    pub revision_id: ExecutionId,
    pub text: String,
    pub source_revision_id: ExecutionId,
    pub origin_kind: tsumugi_core::TranslationOrigin,
    pub contributors: Vec<ExecutionId>,
    pub model: Option<String>,
    pub recipe: Option<String>,
    pub basis_current: bool,
}
impl From<tsumugi_core::ComparisonEntry> for ComparisonEntry {
    fn from(value: tsumugi_core::ComparisonEntry) -> Self {
        Self {
            revision_id: value.revision_id,
            text: value.text,
            source_revision_id: value.source_revision_id,
            origin_kind: value.origin_kind,
            contributors: value.contributors,
            model: value.model,
            recipe: value.recipe,
            basis_current: value.basis_current,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ComparisonView {
    pub comparison_id: Option<ExecutionId>,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub source_text: String,
    pub native_key: String,
    pub selection_id: Option<ExecutionId>,
    pub selected_revision_id: Option<ExecutionId>,
    pub selected_text: Option<String>,
    pub basis: String,
    pub blind: bool,
    pub revealed: bool,
    pub rows: Vec<ComparisonEntry>,
}
impl From<tsumugi_core::ComparisonView> for ComparisonView {
    fn from(value: tsumugi_core::ComparisonView) -> Self {
        Self {
            comparison_id: value.comparison_id,
            unit_id: value.unit_id,
            locale: value.locale,
            source_revision_id: value.source_revision_id,
            source_text: value.source_text,
            native_key: value.native_key,
            selection_id: value.selection_id,
            selected_revision_id: value.selected_revision_id,
            selected_text: value.selected_text,
            basis: value.basis,
            blind: value.blind,
            revealed: value.revealed,
            rows: value.rows.into_iter().map(Into::into).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_display_counters_preserve_fixed_payload_serialization() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/aiCommands.contract.json"
        ))
        .unwrap();
        let wire_item = fixture["responses"]["view"]["rows"][0]["item"].clone();
        let mut stored_item = wire_item.clone();
        stored_item["resourceBaseline"] = serde_json::json!(u64::MAX);
        stored_item["sourceContext"] = serde_json::to_value(tsumugi_core::SourceContextCapture::NotSelected).unwrap();
        stored_item["projectContext"] = serde_json::to_value(tsumugi_core::ProjectFactCapture::NotSelected).unwrap();
        let item: AiItem = serde_json::from_value(stored_item.clone()).unwrap();
        assert_eq!(serde_json::to_value(&item).unwrap(), stored_item);
        assert_eq!(
            serde_json::to_value(AiItemView::from(item)).unwrap(),
            wire_item
        );

        let wire_output = fixture["responses"]["view"]["rows"][0]["output"].clone();
        let mut stored_output = wire_output.clone();
        stored_output["usage"]["promptTokens"] = serde_json::json!(9007199254740993u64);
        stored_output["usage"]["completionTokens"] = serde_json::json!(u64::MAX);
        for field in ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] {
            stored_output["usage"][field] = serde_json::Value::Null;
        }
        let output: AiOutput = serde_json::from_value(stored_output.clone()).unwrap();
        assert_eq!(serde_json::to_value(&output).unwrap(), stored_output);
        assert_eq!(
            serde_json::to_value(AiOutputView::from(output)).unwrap(),
            wire_output
        );
    }

    #[test]
    fn legacy_config_capture_is_explicit_and_cannot_smuggle_new_provenance() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/aiCommands.contract.json"
        )).unwrap();
        let expected = fixture["responses"]["view"]["config"].clone();
        let legacy: AiConfig = serde_json::from_value(expected.clone()).unwrap();
        let captured: tsumugi_core::ai::AiConfig = legacy.into();
        assert_eq!(captured.connection_profile, None);
        assert_eq!(captured.context_strategy, None);
        assert_eq!(captured.source_context, tsumugi_core::SourceContextSelection::default());
        assert_eq!(serde_json::to_value(AiConfig::from(captured)).unwrap(), expected);
        let mut unsupported = expected;
        unsupported["contextStrategy"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<AiConfig>(unsupported).is_err());
    }

    #[test]
    fn arena_wire_indices_are_checked_without_truncation() {
        assert_eq!(index(u32::MAX as usize).unwrap(), u32::MAX);
        if usize::BITS > 32 {
            assert!(index(u32::MAX as usize + 1).is_err());
        }
    }
}
