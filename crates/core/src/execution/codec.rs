use std::{collections::BTreeSet, fmt, io::Write};

use serde::{
    Serialize,
    de::{DeserializeSeed, MapAccess, SeqAccess, Visitor},
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{ErrorCode, ExecutionError, MAX_DEPTH};

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Limit serialization as it happens, before allocating an unbounded buffer.
pub(crate) fn encode<T: Serialize>(value: &T, limit: usize) -> Result<Vec<u8>, ExecutionError> {
    struct BoundedWriter {
        bytes: Vec<u8>,
        limit: usize,
        exceeded: bool,
    }
    impl Write for BoundedWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
                self.exceeded = true;
                return Err(std::io::Error::other("encoded value exceeds limit"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = BoundedWriter {
        bytes: Vec::new(),
        limit,
        exceeded: false,
    };
    if serde_json::to_writer(&mut writer, value).is_err() {
        let stage = if writer.exceeded {
            "limit-exceeded"
        } else {
            "encoding"
        };
        return Err(ExecutionError::new(ErrorCode::LimitExceeded, stage));
    }
    Ok(writer.bytes)
}

/// serde_json::Value accepts duplicate map keys by replacing the first value.
/// At a trust boundary that would discard evidence, so reject them while parsing.
pub(crate) fn decode<T: serde::de::DeserializeOwned>(
    bytes: &[u8],
    limit: usize,
) -> Result<T, ExecutionError> {
    if bytes.len() > limit {
        return Err(ExecutionError::new(ErrorCode::LimitExceeded, "decoding"));
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let value = StrictValue(0)
        .deserialize(&mut decoder)
        .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "decoding"))?;
    decoder
        .end()
        .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "decoding"))?;
    serde_json::from_value(value)
        .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "decoding"))
}

struct StrictValue(usize);

impl<'de> DeserializeSeed<'de> for StrictValue {
    type Value = Value;
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if self.0 > MAX_DEPTH {
            return Err(serde::de::Error::custom("structure too deep"));
        }
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for StrictValue {
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
        Ok(Value::String(v.to_owned()))
    }
    fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_none<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = seq.next_element_seed(StrictValue(self.0 + 1))? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = serde_json::Map::new();
        let mut keys = BTreeSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(serde::de::Error::custom("duplicate member"));
            }
            let value = map.next_value_seed(StrictValue(self.0 + 1))?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
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
