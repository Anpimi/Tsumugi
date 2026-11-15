use std::{collections::BTreeSet, fmt, io::{Read, Write}};

use aws_lc_rs::digest::{Digest, SHA256, digest as compute_digest};
use serde::{
    Serialize,
    de::{DeserializeSeed, MapAccess, SeqAccess, Visitor},
};
use serde_json::Value;

use super::{ErrorCode, ExecutionError, MAX_DEPTH};

mod depth;
pub(crate) use depth::{validate_serialized_depth, validate_serialized_depth_at};

pub(crate) fn digest(bytes: &[u8]) -> String {
    digest_hex(compute_digest(&SHA256, bytes))
}

const HEX: &[u8; 16] = b"0123456789abcdef";

pub(crate) fn matches_digest(bytes: &[u8], expected: &str) -> bool {
    let actual = compute_digest(&SHA256, bytes);
    expected.len() == 64
        && actual.as_ref().iter().zip(expected.as_bytes().chunks_exact(2)).all(|(&byte, hex)| {
            hex == [HEX[usize::from(byte >> 4)], HEX[usize::from(byte & 0xf)]]
        })
}

pub(crate) fn digest_hex(digest: Digest) -> String {
    let bytes = digest.as_ref();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0xf)]));
    }
    encoded
}

/// Limit serialization as it happens, before allocating an unbounded buffer.
pub(crate) fn encode<T: Serialize>(value: &T, limit: usize) -> Result<Vec<u8>, ExecutionError> {
    let mut bytes = Vec::new();
    encode_to(value, limit, &mut bytes)?;
    Ok(bytes)
}

pub(crate) fn check_encoded_size<T: Serialize>(
    value: &T,
    limit: usize,
) -> Result<(), ExecutionError> {
    encode_to(value, limit, std::io::sink())
}

pub(crate) fn matches_encoding<T: Serialize>(
    value: &T,
    limit: usize,
    bytes: &[u8],
) -> Result<bool, ExecutionError> {
    struct Comparison<'a> {
        rest: &'a [u8],
        equal: bool,
    }
    impl Write for Comparison<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if let Some(rest) = self.rest.strip_prefix(bytes) {
                self.rest = rest;
            } else {
                self.equal = false;
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut comparison = Comparison { rest: bytes, equal: true };
    encode_to(value, limit, std::io::BufWriter::new(&mut comparison))?;
    Ok(comparison.equal && comparison.rest.is_empty())
}

/// Check an already qualified value against a stored canonical byte stream.
pub(crate) fn matches_stored_encoding<T: Serialize>(
    value: &T,
    limit: usize,
    reader: impl Read,
    digest: &str,
) -> Result<bool, ExecutionError> {
    struct Comparison<R> {
        reader: R,
        hash: aws_lc_rs::digest::Context,
        equal: bool,
        buffer: [u8; 16 * 1024],
    }
    impl<R: Read> Write for Comparison<R> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            for chunk in bytes.chunks(self.buffer.len()) {
                let stored = &mut self.buffer[..chunk.len()];
                if !self.equal {
                    break;
                }
                self.equal = match self.reader.read_exact(stored) {
                    Ok(()) => stored == chunk,
                    Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => false,
                    Err(error) => return Err(error),
                };
            }
            self.hash.update(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut comparison = Comparison {
        reader,
        hash: aws_lc_rs::digest::Context::new(&SHA256),
        equal: true,
        buffer: [0; 16 * 1024],
    };
    encode_to(value, limit, std::io::BufWriter::new(&mut comparison))?;
    Ok(comparison.equal
        && matches!(comparison.reader.read(&mut [0]), Ok(0))
        && digest_hex(comparison.hash.finish()) == digest)
}

pub(crate) fn digest_encoded<T: Serialize>(value: &T, limit: usize) -> Result<String, ExecutionError> {
    struct HashWriter(aws_lc_rs::digest::Context);
    impl Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = HashWriter(aws_lc_rs::digest::Context::new(&SHA256));
    encode_to(value, limit, std::io::BufWriter::new(&mut writer))?;
    Ok(digest_hex(writer.0.finish()))
}

pub(crate) fn encode_to<T: Serialize>(value: &T, limit: usize, writer: impl Write) -> Result<(), ExecutionError> {
    struct BoundedWriter<W> {
        writer: W,
        remaining: usize,
        exceeded: bool,
    }
    impl<W: Write> Write for BoundedWriter<W> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.remaining {
                self.exceeded = true;
                return Err(std::io::Error::other("encoded value exceeds limit"));
            }
            let written = self.writer.write(bytes)?;
            self.remaining -= written;
            Ok(written)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.writer.flush()
        }
    }
    let mut writer = BoundedWriter {
        writer,
        remaining: limit,
        exceeded: false,
    };
    if serde_json::to_writer(&mut writer, value).is_err() || writer.flush().is_err() {
        let stage = if writer.exceeded {
            "limit-exceeded"
        } else {
            "encoding"
        };
        return Err(ExecutionError::new(ErrorCode::LimitExceeded, stage));
    }
    Ok(())
}

/// serde_json::Value accepts duplicate map keys by replacing the first value.
/// At a trust boundary that would discard evidence, so reject them while parsing.
pub(crate) fn decode<T: serde::de::DeserializeOwned>(
    bytes: &[u8],
    limit: usize,
) -> Result<T, ExecutionError> {
    serde_json::from_value(read_json::<true>(bytes, limit)?)
        .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "decoding"))
}

/// Execution envelopes use strict typed fields and the strict visitors below
/// at each open JSON field. Their validators also check whole-envelope depth.
pub(super) fn decode_frame<T: serde::de::DeserializeOwned>(
    bytes: &[u8],
    limit: usize,
) -> Result<T, ExecutionError> {
    if bytes.len() > limit {
        return Err(ExecutionError::new(ErrorCode::LimitExceeded, "decoding"));
    }
    serde_json::from_slice(bytes)
        .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "decoding"))
}

pub(super) fn strict_value<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<Value, D::Error> {
    StrictValue::<true>(0).deserialize(decoder)
}

pub(super) fn strict_optional_value<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Option<Value>, D::Error> {
    let value = strict_value(decoder)?;
    Ok((!value.is_null()).then_some(value))
}

/// Verify the original syntax, depth, and unique object keys when the ledger
/// only needs a digest projection. The domain reader will decode the payload.
pub(crate) fn validate_json(bytes: &[u8], limit: usize) -> Result<(), ExecutionError> {
    read_json::<false>(bytes, limit).map(drop)
}

/// Compare a raw payload to the strict projection already decoded from its
/// envelope. Large JSON strings can be compared directly in the visitor.
pub(crate) fn matches_json(bytes: &[u8], limit: usize, expected: &Value) -> Result<(), ExecutionError> {
    if bytes.len() > limit {
        return Err(ExecutionError::new(ErrorCode::LimitExceeded, "decoding"));
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    JsonComparison { expected, depth: 0 }.deserialize(&mut decoder)
        .and_then(|()| decoder.end())
        .map_err(|_| ExecutionError::new(ErrorCode::ResultMismatch, "plugin-output"))
}

struct JsonComparison<'a> {
    expected: &'a Value,
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for JsonComparison<'_> {
    type Value = ();

    fn deserialize<D: serde::Deserializer<'de>>(self, decoder: D) -> Result<(), D::Error> {
        if self.depth > MAX_DEPTH {
            return Err(serde::de::Error::custom("structure too deep"));
        }
        decoder.deserialize_any(self)
    }
}

impl JsonComparison<'_> {
    fn compare<E: serde::de::Error>(matches: bool) -> Result<(), E> {
        if matches { Ok(()) } else { Err(E::custom("projection mismatch")) }
    }
}

impl<'de> Visitor<'de> for JsonComparison<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the exact projected JSON value")
    }

    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<(), E> {
        Self::compare(self.expected.as_bool() == Some(value))
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<(), E> {
        Self::compare(*self.expected == Value::from(value))
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<(), E> {
        Self::compare(*self.expected == Value::from(value))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<(), E> {
        Self::compare(serde_json::Number::from_f64(value)
            .is_some_and(|number| *self.expected == Value::Number(number)))
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<(), E> {
        Self::compare(self.expected.as_str() == Some(value))
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<(), E> {
        Self::compare(self.expected.is_null())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let expected = self.expected.as_array().ok_or_else(|| serde::de::Error::custom("expected array"))?;
        for item in expected {
            let found = seq.next_element_seed(JsonComparison { expected: item, depth: self.depth + 1 })?;
            Self::compare(found.is_some())?;
        }
        Self::compare(seq.next_element::<serde::de::IgnoredAny>()?.is_none())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let expected = self.expected.as_object().ok_or_else(|| serde::de::Error::custom("expected object"))?;
        let mut seen = BTreeSet::new();
        while let Some(key) = map.next_key::<String>()? {
            let (key, item) = expected.get_key_value(&key)
                .ok_or_else(|| serde::de::Error::custom("unexpected key"))?;
            Self::compare(seen.insert(key))?;
            map.next_value_seed(JsonComparison { expected: item, depth: self.depth + 1 })?;
        }
        Self::compare(seen.len() == expected.len())
    }
}

fn read_json<const KEEP: bool>(bytes: &[u8], limit: usize) -> Result<Value, ExecutionError> {
    if bytes.len() > limit {
        return Err(ExecutionError::new(ErrorCode::LimitExceeded, "decoding"));
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let value = StrictValue::<KEEP>(0)
        .deserialize(&mut decoder)
        .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "decoding"))?;
    decoder
        .end()
        .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "decoding"))?;
    Ok(value)
}

struct StrictValue<const KEEP: bool>(usize);

impl<'de, const KEEP: bool> DeserializeSeed<'de> for StrictValue<KEEP> {
    type Value = Value;
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if self.0 > MAX_DEPTH {
            return Err(serde::de::Error::custom("structure too deep"));
        }
        deserializer.deserialize_any(self)
    }
}

impl<'de, const KEEP: bool> Visitor<'de> for StrictValue<KEEP> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded JSON without duplicate keys")
    }
    fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Value, E> {
        serde_json::Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| E::custom("non-finite number"))
    }
    fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(if KEEP { Value::String(v.to_owned()) } else { Value::Null })
    }
    fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Value, E> {
        Ok(if KEEP { Value::String(v) } else { Value::Null })
    }
    fn visit_none<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = seq.next_element_seed(StrictValue::<KEEP>(self.0 + 1))? {
            if KEEP {
                values.push(value);
            }
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        if KEEP {
            let mut values = serde_json::Map::new();
            while let Some(key) = map.next_key::<String>()? {
                match values.entry(key) {
                    serde_json::map::Entry::Vacant(entry) => {
                        entry.insert(map.next_value_seed(StrictValue::<KEEP>(self.0 + 1))?);
                    }
                    serde_json::map::Entry::Occupied(_) => {
                        return Err(serde::de::Error::custom("duplicate member"));
                    }
                }
            }
            Ok(Value::Object(values))
        } else {
            let mut keys = BTreeSet::new();
            while let Some(key) = map.next_key::<String>()? {
                if !keys.insert(key) {
                    return Err(serde::de::Error::custom("duplicate member"));
                }
                map.next_value_seed(StrictValue::<KEEP>(self.0 + 1))?;
            }
            Ok(Value::Null)
        }
    }
}

pub(crate) fn validate_depth(value: &Value, depth: usize) -> Result<(), ExecutionError> {
    if depth > MAX_DEPTH {
        return Err(ExecutionError::new(ErrorCode::LimitExceeded, "structure"));
    }
    match value {
        Value::Array(values) => {
            for value in values {
                validate_depth(value, depth + 1)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                validate_depth(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_without_a_projection_checks_nested_members_and_depth() {
        let valid = br#"{"units":[{"text":"\u661f","ranges":[1,2]}]}"#;
        assert!(validate_json(valid, valid.len()).is_ok());
        assert!(validate_json(valid, valid.len() - 1).is_err());
        let duplicates = br#"{"units":[{"text":"a","\u0074ext":"b"}]}"#;
        assert!(validate_json(duplicates, duplicates.len()).is_err());
        let deep = format!("{}0{}", "[".repeat(MAX_DEPTH + 1), "]".repeat(MAX_DEPTH + 1));
        assert!(validate_json(deep.as_bytes(), deep.len()).is_err());
    }

    #[test]
    fn compares_raw_payload_without_discarding_conflicting_evidence() {
        let value = serde_json::json!({"artifacts": [{"text": "星", "size": 12}], "valid": true});
        let reordered = br#"{"valid":true,"artifacts":[{"size":12,"text":"\u661f"}]}"#;
        assert!(matches_json(reordered, reordered.len(), &value).is_ok());
        assert!(matches_json(reordered, reordered.len() - 1, &value).is_err());

        for bytes in [
            br#"{"valid":true,"artifacts":[{"size":12,"text":"\u661f","\u0074ext":"\u661f"}]}"#.as_slice(),
            br#"{"valid":true,"artifacts":[{"size":12.0,"text":"\u661f"}]}"#,
            br#"{"valid":true,"artifacts":[{"size":12,"text":"\u661f"},null]}"#,
            br#"{"valid":true,"artifacts":[{"size":12}]}"#,
            br#"{"valid":true,"artifacts":[{"size":12,"text":"\u661f"}]} null"#,
        ] {
            assert!(matches_json(bytes, bytes.len(), &value).is_err());
        }
    }
}
