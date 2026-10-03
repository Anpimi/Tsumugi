//! Display projections preserve full counters without changing fixed payloads.
use super::*;
use tsumugi_core::{
    ContextRevision,
    ai::{
        AiConfig, AiItem, AiOutput, AiPreview, SharedTerm, Usage,
        arena::{ArenaConfig, ArenaItem, ArenaPreview},
    },
    execution::UnsignedDecimal,
};

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
            config,
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
            config,
            items: items
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
            digest,
        })
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
        let output: AiOutput = serde_json::from_value(stored_output.clone()).unwrap();
        assert_eq!(serde_json::to_value(&output).unwrap(), stored_output);
        assert_eq!(
            serde_json::to_value(AiOutputView::from(output)).unwrap(),
            wire_output
        );
    }

    #[test]
    fn arena_wire_indices_are_checked_without_truncation() {
        assert_eq!(index(u32::MAX as usize).unwrap(), u32::MAX);
        if usize::BITS > 32 {
            assert!(index(u32::MAX as usize + 1).is_err());
        }
    }
}
