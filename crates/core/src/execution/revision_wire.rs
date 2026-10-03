//! Serde adapters for counters backed by the existing decimal Revision contract.

use super::Revision;
use serde::{Deserialize, Serialize};

pub fn serialize<S: serde::Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    Revision::new(*value)
        .map_err(serde::ser::Error::custom)?
        .serialize(serializer)
}

pub fn deserialize<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    Revision::deserialize(deserializer).map(Revision::get)
}

pub mod optional {
    use super::*;

    pub fn serialize<S: serde::Serializer>(
        value: &Option<u64>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value
            .map(Revision::new)
            .transpose()
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<u64>, D::Error> {
        Option::<Revision>::deserialize(deserializer).map(|value| value.map(Revision::get))
    }
}
