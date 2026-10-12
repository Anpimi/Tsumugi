//! A finite text-query presentation, rather than arbitrary forms, scripts or
//! application state access. Paths address existing values in a fixed template.
use super::*;
use serde_json::Value;

pub const MAX_TOOL_QUERY_OPTIONS: usize = 64;
pub const MAX_TOOL_QUERY_COLUMNS: usize = 8;
pub const MAX_TOOL_QUERY_ENTRIES: u32 = 128;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum ToolQueryPathPart {
    Key(String),
    Index(#[cfg_attr(feature = "schema", schemars(schema_with = "query_index_schema"))] u32),
}
pub type ToolQueryPath = Vec<ToolQueryPathPart>;

#[cfg(feature = "schema")]
fn query_index_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer", "minimum":0, "maximum":1999})
}
#[cfg(feature = "schema")]
fn query_min_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer", "minimum":0, "maximum":MAX_TOOL_QUERY_OPTIONS})
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ToolQueryOption {
    pub value: String,
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ToolQuerySelection {
    pub label: String,
    pub description: String,
    pub path: ToolQueryPath,
    pub options: Vec<ToolQueryOption>,
    #[cfg_attr(feature = "schema", schemars(schema_with = "query_min_schema"))]
    pub min_selected: u32,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub max_selected: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ToolQueryColumn {
    pub label: String,
    pub path: ToolQueryPath,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ToolQueryOutput {
    pub entries_path: ToolQueryPath,
    pub columns: Vec<ToolQueryColumn>,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub max_entries: u32,
    pub empty_description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ToolQueryDeclaration {
    pub input_schema: ContractRef,
    pub output_schema: ContractRef,
    pub input_template: Value,
    pub text_path: ToolQueryPath,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub max_text_bytes: u32,
    /// One explicit target option; no host-side locale or value normalization.
    pub target: ToolQuerySelection,
    /// Explicit senses or categories. Matching text alone does not select them.
    pub selections: ToolQuerySelection,
    pub output: ToolQueryOutput,
}

fn path(value: &ToolQueryPath) -> Result<(), ContractError> {
    if value.is_empty() || value.len() > 8 {
        return Err(invalid("tool.query.path"));
    }
    for part in value {
        match part {
            ToolQueryPathPart::Key(key)
                if !key.is_empty()
                    && key.len() <= 128
                    && !key.chars().any(char::is_control)
                    && !matches!(key.as_str(), "__proto__" | "prototype" | "constructor") => {}
            ToolQueryPathPart::Index(index) if *index < 2000 => {}
            _ => return Err(invalid("tool.query.path")),
        }
    }
    Ok(())
}

fn at<'a>(value: &'a Value, path: &ToolQueryPath) -> Option<&'a Value> {
    path.iter().try_fold(value, |value, part| match part {
        ToolQueryPathPart::Key(key) => value.as_object()?.get(key),
        ToolQueryPathPart::Index(index) => value.as_array()?.get(*index as usize),
    })
}

impl ToolQuerySelection {
    fn validate(&self) -> Result<(), ContractError> {
        display(&self.label, 256, "tool.query.selection.label")?;
        display(&self.description, 1024, "tool.query.selection.description")?;
        path(&self.path)?;
        if self.options.is_empty()
            || self.options.len() > MAX_TOOL_QUERY_OPTIONS
            || self.min_selected > self.max_selected
            || self.max_selected == 0
            || self.max_selected as usize > self.options.len()
        {
            return Err(invalid("tool.query.selection.options"));
        }
        unique(
            self.options.iter().map(|option| &option.value),
            "tool.query.selection.options",
        )?;
        for option in &self.options {
            display(&option.value, 128, "tool.query.selection.value")?;
            display(&option.label, 256, "tool.query.selection.label")?;
            display(
                &option.description,
                1024,
                "tool.query.selection.description",
            )?;
        }
        Ok(())
    }
}

impl ToolQueryDeclaration {
    /// Build only the declared text query. Values are preserved exactly; this
    /// helper neither authenticates a package nor grants execution permission.
    pub fn prepare_payload(
        &self,
        text: &str,
        target: &str,
        selections: &[String],
        max_input_bytes: u32,
    ) -> Result<Value, ContractError> {
        self.validate()?;
        if text.chars().all(|ch| matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')) || text.len() > self.max_text_bytes as usize {
            return Err(invalid("tool.query.text"));
        }
        if !self
            .target
            .options
            .iter()
            .any(|option| option.value == target)
            || selections.len() < self.selections.min_selected as usize
            || selections.len() > self.selections.max_selected as usize
            || selections
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != selections.len()
            || selections.iter().any(|value| {
                !self
                    .selections
                    .options
                    .iter()
                    .any(|option| &option.value == value)
            })
        {
            return Err(invalid("tool.query.selection"));
        }
        fn replace(
            value: &mut Value,
            path: &[ToolQueryPathPart],
            replacement: Value,
        ) -> Result<(), ContractError> {
            let mut current = value;
            for part in path {
                current = match part {
                    ToolQueryPathPart::Key(key) => current
                        .as_object_mut()
                        .and_then(|object| object.get_mut(key)),
                    ToolQueryPathPart::Index(index) => current
                        .as_array_mut()
                        .and_then(|array| array.get_mut(*index as usize)),
                }
                .ok_or_else(|| invalid("tool.query.path"))?;
            }
            *current = replacement;
            Ok(())
        }
        let mut payload = self.input_template.clone();
        replace(&mut payload, &self.text_path, Value::String(text.into()))?;
        replace(
            &mut payload,
            &self.target.path,
            Value::String(target.into()),
        )?;
        replace(
            &mut payload,
            &self.selections.path,
            serde_json::to_value(selections).map_err(|_| invalid("tool.query.selection"))?,
        )?;
        if max_input_bytes == 0
            || serde_json::to_vec(&payload)
                .map_err(|_| invalid("tool.query.input"))?
                .len()
                > max_input_bytes as usize
        {
            return Err(invalid("tool.query.input"));
        }
        Ok(payload)
    }

    pub fn validate(&self) -> Result<(), ContractError> {
        reference(&self.input_schema, "tool.query.inputSchema")?;
        reference(&self.output_schema, "tool.query.outputSchema")?;
        path(&self.text_path)?;
        self.target.validate()?;
        self.selections.validate()?;
        if self.target.min_selected != 1
            || self.target.max_selected != 1
            || self.max_text_bytes == 0
            || self.max_text_bytes > 4 * 1024 * 1024
            || !self.input_template.is_object()
        {
            return Err(invalid("tool.query.input"));
        }
        let paths = [&self.text_path, &self.target.path, &self.selections.path];
        for (i, a) in paths.iter().enumerate() {
            for b in &paths[i + 1..] {
                if a.starts_with(b) || b.starts_with(a) {
                    return Err(invalid("tool.query.overlappingPaths"));
                }
            }
        }
        if at(&self.input_template, &self.text_path)
            .and_then(Value::as_str)
            .is_none_or(|text| text.len() > self.max_text_bytes as usize)
        {
            return Err(invalid("tool.query.text"));
        }
        let target = at(&self.input_template, &self.target.path)
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("tool.query.target"))?;
        if !self
            .target
            .options
            .iter()
            .any(|option| option.value == target)
        {
            return Err(invalid("tool.query.target"));
        }
        let selected = at(&self.input_template, &self.selections.path)
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("tool.query.selections"))?;
        if selected.len() > self.selections.max_selected as usize
            || selected.iter().any(|value| {
                value.as_str().is_none_or(|value| {
                    !self
                        .selections
                        .options
                        .iter()
                        .any(|option| option.value == value)
                })
            })
        {
            return Err(invalid("tool.query.selections"));
        }
        unique(
            selected.iter().filter_map(Value::as_str),
            "tool.query.selections",
        )?;
        path(&self.output.entries_path)?;
        display(
            &self.output.empty_description,
            1024,
            "tool.query.output.emptyDescription",
        )?;
        if self.output.max_entries == 0
            || self.output.max_entries > MAX_TOOL_QUERY_ENTRIES
            || self.output.columns.is_empty()
            || self.output.columns.len() > MAX_TOOL_QUERY_COLUMNS
        {
            return Err(invalid("tool.query.output"));
        }
        for (i, column) in self.output.columns.iter().enumerate() {
            display(&column.label, 256, "tool.query.output.label")?;
            path(&column.path)?;
            if self.output.columns[..i]
                .iter()
                .any(|other| other.path == column.path)
            {
                return Err(invalid("tool.query.output.columns"));
            }
        }
        encoded_limit(self, MAX_TOOL_DECLARATION_BYTES, "tool.query")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query() -> ToolQueryDeclaration {
        serde_json::from_slice::<CapabilityToolDeclaration>(include_bytes!(
            "../../tests/fixtures/tool.query.json"
        ))
        .unwrap()
        .query
        .unwrap()
    }

    #[test]
    fn query_payload_preserves_text_template_and_explicit_options() {
        let query = query();
        let text = "\u{feff}中文\r\n👩🏽‍💻 e\u{301}";
        let payload = query
            .prepare_payload(text, "ja", &["other".into(), "term".into()], 4096)
            .unwrap();
        assert_eq!(payload["rows"][0]["text"], text);
        assert_eq!(
            payload["rows"][0]["selected"],
            serde_json::json!(["other", "term"])
        );
        assert_eq!(payload["rows"][0]["id"], "original-query");
        assert_eq!(payload["basis"], query.input_template["basis"]);
        assert_eq!(query.input_template["rows"][0]["text"], "");
    }

    #[test]
    fn query_payload_refuses_missing_options_utf8_limits_and_path_creation() {
        let mut query = query();
        for (text, target, selected) in [
            (" ", "ja", vec!["term".into()]),
            ("text", "JA", vec!["term".into()]),
            ("text", "ja", Vec::new()),
            ("text", "ja", vec!["term".into(), "term".into()]),
            ("text", "ja", vec!["unknown".into()]),
        ] {
            assert!(
                query
                    .prepare_payload(text, target, &selected, 4096)
                    .is_err()
            );
        }
        query.max_text_bytes = 3;
        assert!(
            query
                .prepare_payload("👩", "ja", &["term".into()], 4096)
                .is_err()
        );
        assert!(
            query
                .prepare_payload("a", "ja", &["term".into()], 1)
                .is_err()
        );
        query.text_path = vec![ToolQueryPathPart::Key("absent".into())];
        assert!(
            query
                .prepare_payload("a", "ja", &["term".into()], 4096)
                .is_err()
        );
    }
}
