//! Check the JSON shape of owned envelopes without cloning their payload trees.
//! Encoding and strict untrusted-byte decoding remain in the codec owner.
use super::*;
use serde::ser::{self, Serialize};

pub(crate) fn validate_serialized_depth<T: ?Sized + Serialize>(
    value: &T,
    serialization_error: impl FnOnce() -> ExecutionError,
) -> Result<(), ExecutionError> {
    value.serialize(Depth(0)).map_err(|error| match error {
        DepthError::TooDeep => ExecutionError::new(ErrorCode::LimitExceeded, "structure"),
        DepthError::Serialization => serialization_error(),
    })
}

#[derive(Debug)]
enum DepthError {
    TooDeep,
    Serialization,
}
impl fmt::Display for DepthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::TooDeep => "JSON structure exceeds the depth limit",
            Self::Serialization => "Value cannot be serialized",
        })
    }
}
impl std::error::Error for DepthError {}
impl ser::Error for DepthError {
    fn custom<T: fmt::Display>(_: T) -> Self {
        Self::Serialization
    }
}

#[derive(Clone, Copy)]
struct Depth(usize);
impl Depth {
    fn check(self) -> Result<(), DepthError> {
        if self.0 > MAX_DEPTH {
            Err(DepthError::TooDeep)
        } else {
            Ok(())
        }
    }
    fn children(self) -> Result<Children, DepthError> {
        self.check()?;
        Ok(Children(Depth(self.0 + 1)))
    }
}

// No primitive, key or display string needs to be formatted or copied to count
// its JSON nesting. Compound values visit only borrowed children.
macro_rules! leaf {
    ($($method:ident($kind:ty)),* $(,)?) => {$(
        fn $method(self, _: $kind) -> Result<(), DepthError> {
            self.check()
        }
    )*};
}
impl ser::Serializer for Depth {
    type Ok = ();
    type Error = DepthError;
    type SerializeSeq = Children;
    type SerializeTuple = Children;
    type SerializeTupleStruct = Children;
    type SerializeTupleVariant = Children;
    type SerializeMap = Children;
    type SerializeStruct = Children;
    type SerializeStructVariant = Children;

    leaf! {
        serialize_bool(bool), serialize_i8(i8), serialize_i16(i16),
        serialize_i32(i32), serialize_i64(i64), serialize_i128(i128),
        serialize_u8(u8), serialize_u16(u16), serialize_u32(u32),
        serialize_u64(u64), serialize_u128(u128), serialize_f32(f32),
        serialize_f64(f64), serialize_char(char), serialize_str(&str),
    }
    fn serialize_bytes(self, bytes: &[u8]) -> Result<(), DepthError> {
        let children = self.children()?;
        if !bytes.is_empty() {
            children.0.check()?;
        }
        Ok(())
    }
    fn serialize_none(self) -> Result<(), DepthError> {
        self.check()
    }
    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<(), DepthError> {
        value.serialize(self)
    }
    fn serialize_unit(self) -> Result<(), DepthError> {
        self.check()
    }
    fn serialize_unit_struct(self, _: &'static str) -> Result<(), DepthError> {
        self.check()
    }
    fn serialize_unit_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
    ) -> Result<(), DepthError> {
        self.check()
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(
        self,
        _: &'static str,
        value: &T,
    ) -> Result<(), DepthError> {
        value.serialize(self)
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        value: &T,
    ) -> Result<(), DepthError> {
        self.children()?.value(value)
    }
    fn serialize_seq(self, _: Option<usize>) -> Result<Children, DepthError> {
        self.children()
    }
    fn serialize_tuple(self, _: usize) -> Result<Children, DepthError> {
        self.children()
    }
    fn serialize_tuple_struct(self, _: &'static str, _: usize) -> Result<Children, DepthError> {
        self.children()
    }
    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Children, DepthError> {
        self.children()?.0.children()
    }
    fn serialize_map(self, _: Option<usize>) -> Result<Children, DepthError> {
        self.children()
    }
    fn serialize_struct(self, _: &'static str, _: usize) -> Result<Children, DepthError> {
        self.children()
    }
    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Children, DepthError> {
        self.children()?.0.children()
    }
    fn collect_str<T: ?Sized + fmt::Display>(self, _: &T) -> Result<(), DepthError> {
        self.check()
    }
}

struct Children(Depth);
impl Children {
    fn value<T: ?Sized + Serialize>(&self, value: &T) -> Result<(), DepthError> {
        value.serialize(self.0)
    }
}
macro_rules! sequence {
    ($kind:ident, $field:ident) => {
        impl ser::$kind for Children {
            type Ok = ();
            type Error = DepthError;
            fn $field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), DepthError> {
                self.value(value)
            }
            fn end(self) -> Result<(), DepthError> {
                Ok(())
            }
        }
    };
}
sequence!(SerializeSeq, serialize_element);
sequence!(SerializeTuple, serialize_element);
sequence!(SerializeTupleStruct, serialize_field);
sequence!(SerializeTupleVariant, serialize_field);
impl ser::SerializeMap for Children {
    type Ok = ();
    type Error = DepthError;
    fn serialize_key<T: ?Sized + Serialize>(&mut self, _: &T) -> Result<(), DepthError> {
        Ok(())
    }
    fn serialize_value<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), DepthError> {
        self.value(value)
    }
    fn end(self) -> Result<(), DepthError> {
        Ok(())
    }
}
macro_rules! structure {
    ($kind:ident) => {
        impl ser::$kind for Children {
            type Ok = ();
            type Error = DepthError;
            fn serialize_field<T: ?Sized + Serialize>(
                &mut self,
                _: &'static str,
                value: &T,
            ) -> Result<(), DepthError> {
                self.value(value)
            }
            fn end(self) -> Result<(), DepthError> {
                Ok(())
            }
        }
    };
}
structure!(SerializeStruct);
structure!(SerializeStructVariant);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agrees<T: Serialize>(value: &T) {
        // The existing JSON-tree validator is the independent shape oracle;
        // production validation must avoid allocating that duplicate tree.
        let json = serde_json::to_value(value).unwrap();
        let expected = super::super::validate_depth(&json, 0);
        let actual = validate_serialized_depth(value, || {
            ExecutionError::new(ErrorCode::InvalidInput, "encoding")
        });
        assert_eq!(actual.is_ok(), expected.is_ok(), "{json}");
        if let (Err(actual), Err(expected)) = (actual, expected) {
            assert_eq!(actual.code, expected.code);
            assert_eq!(actual.stage, expected.stage);
        }
    }
    #[derive(Serialize)]
    enum Example {
        Unit,
        Newtype(Value),
        Tuple(Value, Value),
        Struct { child: Value },
    }
    #[derive(Serialize)]
    struct Newtype(Value);
    #[derive(Serialize)]
    struct Tuple(Value, Value);
    #[derive(Serialize)]
    #[serde(tag = "kind", content = "value")]
    enum Tagged {
        Item(Value),
    }
    #[derive(Serialize)]
    struct Flattened {
        #[serde(flatten)]
        child: std::collections::BTreeMap<String, Value>,
    }
    #[test]
    fn borrowed_depth_matches_json_shapes_at_the_exact_limit() {
        agrees(&Example::Unit);
        for depth in [0, 1, MAX_DEPTH - 2, MAX_DEPTH - 1, MAX_DEPTH, MAX_DEPTH + 1] {
            let mut child = Value::Null;
            for _ in 0..depth {
                child = json!([child]);
            }
            agrees(&child);
            agrees(&Some(&child));
            agrees(&Newtype(child.clone()));
            agrees(&Tuple(child.clone(), Value::Null));
            agrees(&Example::Newtype(child.clone()));
            agrees(&Example::Tuple(child.clone(), Value::Null));
            agrees(&Example::Struct {
                child: child.clone(),
            });
            agrees(&Tagged::Item(child.clone()));
            agrees(&Flattened {
                child: [("child".into(), child.clone())].into(),
            });
        }
    }
    #[test]
    fn empty_containers_and_large_literals_preserve_depth_semantics() {
        agrees(&json!([]));
        agrees(&json!({}));
        agrees(&json!({"literal": "[{}]\\\"🧵".repeat(100_000)}));
        agrees(&Option::<Value>::None);
        agrees(&(&[0_u8, 255][..], true, 42_u64, 0.25_f64, '🧵'));
    }
}
