use std::{collections::BTreeSet, fmt, io::Write};

use aws_lc_rs::digest::{Digest, SHA256, digest as compute_digest};
use serde::{
    Serialize,
    de::{DeserializeSeed, MapAccess, SeqAccess, Visitor},
};
use serde_json::Value;

use super::{ErrorCode, ExecutionError, MAX_DEPTH};

mod depth;
pub(crate) use depth::validate_serialized_depth;

pub(crate) fn digest(bytes: &[u8]) -> String {
    digest_hex(compute_digest(&SHA256, bytes))
}

pub(crate) fn digest_hex(digest: Digest) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
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

fn encode_to<T: Serialize>(value: &T, limit: usize, writer: impl Write) -> Result<(), ExecutionError> {
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

/// Verify the original syntax, depth, and unique object keys when the ledger
/// only needs a digest projection. The domain reader will decode the payload.
pub(crate) fn validate_json(bytes: &[u8], limit: usize) -> Result<(), ExecutionError> {
    read_json::<false>(bytes, limit).map(drop)
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
}
