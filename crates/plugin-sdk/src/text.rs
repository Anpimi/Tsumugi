use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;

use crate::{ContractError, ContractErrorCode, MAX_EXCHANGE_BYTES};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum TextEncoding {
    Utf8Byte,
    Utf16,
    Grapheme,
}

/// Half-open offsets into one exact string, never between different strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextRange {
    pub encoding: TextEncoding,
    #[cfg_attr(feature = "schema", schemars(schema_with = "crate::offset_schema"))]
    pub start: u32,
    #[cfg_attr(feature = "schema", schemars(schema_with = "crate::offset_schema"))]
    pub end: u32,
}

fn invalid() -> ContractError {
    ContractError::at(ContractErrorCode::InvalidRange, "text.range")
}

/// Converts scalar boundaries exactly. UTF-8 code points and UTF-16 surrogate
/// pairs cannot be split. Converting to graphemes also requires exact extended
/// grapheme boundaries; no rounding, normalization or truncation is performed.
pub fn convert_text_range(
    text: &str,
    range: TextRange,
    target: TextEncoding,
) -> Result<TextRange, ContractError> {
    if text.len() > MAX_EXCHANGE_BYTES {
        return Err(ContractError::at(ContractErrorCode::LimitExceeded, "text"));
    }
    if range.start > range.end {
        return Err(invalid());
    }
    fn byte_offset(text: &str, offset: u32, encoding: TextEncoding) -> Option<usize> {
        match encoding {
            TextEncoding::Utf8Byte => {
                let byte = offset as usize;
                text.is_char_boundary(byte).then_some(byte)
            }
            TextEncoding::Utf16 => {
                let mut units = 0u32;
                for (byte, ch) in text.char_indices() {
                    if units == offset {
                        return Some(byte);
                    }
                    units += ch.len_utf16() as u32;
                }
                (units == offset).then_some(text.len())
            }
            TextEncoding::Grapheme => text
                .grapheme_indices(true)
                .map(|(byte, _)| byte)
                .chain(std::iter::once(text.len()))
                .nth(offset as usize),
        }
    }
    fn encoded_offset(text: &str, byte: usize, encoding: TextEncoding) -> Option<u32> {
        match encoding {
            TextEncoding::Utf8Byte => Some(byte as u32),
            TextEncoding::Utf16 => Some(text[..byte].encode_utf16().count() as u32),
            TextEncoding::Grapheme => text
                .grapheme_indices(true)
                .map(|(b, _)| b)
                .chain(std::iter::once(text.len()))
                .position(|b| b == byte)
                .map(|n| n as u32),
        }
    }
    let start = byte_offset(text, range.start, range.encoding).ok_or_else(invalid)?;
    let end = byte_offset(text, range.end, range.encoding).ok_or_else(invalid)?;
    Ok(TextRange {
        encoding: target,
        start: encoded_offset(text, start, target).ok_or_else(invalid)?,
        end: encoded_offset(text, end, target).ok_or_else(invalid)?,
    })
}
