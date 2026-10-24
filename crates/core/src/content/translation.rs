//! Checked plugin translation projections shared by preview and adoption.

use super::*;

pub const TRANSLATION_OPERATION: &str = "translation-import";

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationEntry {
    pub ordinal: u32,
    pub artifact_id: ExecutionId,
    pub native_key: String,
    pub text: String,
    /// Optional half-open UTF-8 byte offsets for the original display evidence.
    pub key_byte_range: Option<[u32; 2]>,
    /// Half-open UTF-8 byte offsets before escape decoding or text normalization.
    pub value_byte_range: [u32; 2],
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationOutput {
    pub version: u32,
    pub bundle_id: ExecutionId,
    pub manifest_digest: String,
    pub file_digest: String,
    pub entry_count: u32,
    pub entry: Option<TranslationEntry>,
}

pub fn validate_translation_output(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<TranslationOutput, ExecutionError> {
    if super::is_translation_projection(input) {
        return super::validate_projected_translation_output(input, result);
    }
    #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
    {
        super::legacy_translation::validate_translation_output(input, result)
    }
    #[cfg(not(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain")))]
    {
        Err(invalid("translation-projection-required"))
    }
}
