use super::*;
use schemars::Schema;
use serde_json::json;

// Schema 1 stays frozen even though the Rust reader also supports schema 2.
#[allow(dead_code)]
#[derive(schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "TranslationImportDeclaration")]
pub(super) struct LegacyTranslationImportDeclaration {
    display_name: String,
    profile: ContractRef,
    material: TranslationMaterialDeclaration,
    extractor: String,
    checker: String,
    semantic_rules: Vec<ContractRef>,
}

pub(super) fn declaration_variants(schema: &mut Schema) {
    schema.insert("oneOf".into(), json!([
            {"required":["material"], "properties":{"material":true,"fileSets":false,"maxTotalBytes":false}},
            {"required":["fileSets","maxTotalBytes"], "properties":{"fileSets":true,"maxTotalBytes":true,"material":false}}
    ]));
}

// Reuse the original definitions and their field coordinates, adding only the
// required paired source. This keeps the schema-2 input and checker unchanged.
pub(super) fn paired_input() -> Schema {
    let mut schema = translation_extraction_input_schema();
    let mut source = schemars::schema_for!(TranslationPairSource).to_value();
    let definitions = source.as_object_mut().unwrap().remove("$defs").unwrap();
    schema
        .as_object_mut()
        .unwrap()
        .get_mut("$defs")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .extend(definitions.as_object().unwrap().clone());
    source.as_object_mut().unwrap().remove("$schema");
    source.as_object_mut().unwrap().remove("title");
    schema
        .as_object_mut()
        .unwrap()
        .get_mut("properties")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .insert("pairedSource".into(), source);
    schema
        .as_object_mut()
        .unwrap()
        .get_mut("required")
        .unwrap()
        .as_array_mut()
        .unwrap()
        .push(json!("pairedSource"));
    schema
}

pub(super) fn paired_declaration() -> Schema {
    let mut schema = schemars::schema_for!(TranslationImportDeclaration);
    let object = schema.as_object_mut().unwrap();
    object.remove("oneOf");
    object
        .get_mut("properties")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("material");
    let required = object.get_mut("required").unwrap().as_array_mut().unwrap();
    required.extend([json!("fileSets"), json!("maxTotalBytes")]);
    object
        .get_mut("$defs")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("TranslationMaterialDeclaration");
    schema
}

fn replace_definition(schema: &mut Schema, name: &str, mut replacement: Schema) {
    let object = replacement.as_object_mut().unwrap();
    let definitions = object.remove("$defs").unwrap_or(json!({}));
    object.remove("$schema");
    object.remove("title");
    let target = schema
        .as_object_mut()
        .unwrap()
        .get_mut("$defs")
        .unwrap()
        .as_object_mut()
        .unwrap();
    target.extend(definitions.as_object().unwrap().clone());
    target.insert(name.into(), replacement.to_value());
}

pub(super) fn paired_check_input() -> Schema {
    let mut schema = translation_extraction_check_input_schema();
    replace_definition(&mut schema, "TranslationExtractionInput", paired_input());
    schema
}

pub(super) fn paired_types() -> Schema {
    let mut schema = translation_types_schema();
    replace_definition(&mut schema, "TranslationExtractionInput", paired_input());
    replace_definition(
        &mut schema,
        "TranslationImportDeclaration",
        paired_declaration(),
    );
    schema
}
