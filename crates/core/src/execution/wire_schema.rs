//! Schema descriptions of the existing scalar Serde contracts.
use super::{ExecutionId, Revision};
use schemars::{
    JsonSchema, Schema,
    generate::{Contract, SchemaGenerator},
};
use std::borrow::Cow;

/// JSON Schema has no numeric maximum for string counters. Encode the same
/// bound as Rust without narrowing through a JavaScript number.
pub fn unsigned_decimal(max: u64) -> Schema {
    let digits = max.to_string();
    let mut alternatives = vec!["0".to_owned()];
    if digits.len() > 1 {
        alternatives.push(format!("[1-9][0-9]{{0,{}}}", digits.len() - 2));
    }
    for (index, digit) in digits.bytes().enumerate() {
        let minimum = if index == 0 { b'1' } else { b'0' };
        if digit > minimum {
            alternatives.push(format!(
                "{}[{}-{}][0-9]{{{}}}",
                &digits[..index],
                minimum as char,
                (digit - 1) as char,
                digits.len() - index - 1
            ));
        }
    }
    alternatives.push(digits);
    schemars::json_schema!({"type":"string", "pattern":format!("^({})$", alternatives.join("|"))})
}

impl JsonSchema for Revision {
    fn schema_name() -> Cow<'static, str> {
        "Revision".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        unsigned_decimal(i64::MAX as u64)
    }
}
impl JsonSchema for ExecutionId {
    fn schema_name() -> Cow<'static, str> {
        "ExecutionId".into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        if *generator.contract() == Contract::Serialize {
            schemars::json_schema!({"type":"string", "pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"})
        } else {
            // The existing parser also accepts UUID spelling variants. Parsing,
            // UUID version checks and authorization remain the Rust boundary.
            schemars::json_schema!({"type":"string"})
        }
    }
}
