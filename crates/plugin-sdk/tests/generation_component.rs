use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;

fn generation() -> GenerationServiceInput {
    GenerationServiceInput {
        task_id: "task-1".into(),
        attempt_id: "attempt-1".into(),
        unit_ids: vec!["unit-1".into()],
    }
}

fn payload(utf8: impl Into<String>) -> EncodedPayload {
    EncodedPayload::capture(
        ContractRef {
            id: "tsumugi.query-tool-input".into(),
            schema_version: 1,
            behavior_version: 1,
        },
        utf8.into(),
    )
    .unwrap()
}

fn prepared(index: usize, utf8: impl Into<String>) -> PreparedToolServiceCall {
    PreparedToolServiceCall {
        handle_id: format!("service-{index}"),
        call_id: format!("call-{index}"),
        tool_handle: format!("tool-{index}"),
        input: payload(utf8),
    }
}

fn component_input(prepared_tools: Vec<PreparedToolServiceCall>) -> GenerationComponentInput {
    GenerationComponentInput {
        generation: generation(),
        prepared_tools,
    }
}

#[test]
fn component_input_round_trips_empty_and_exact_unicode_query_payloads() {
    assert_eq!(
        generation_component_input_contract(),
        ContractRef {
            id: "tsumugi.generation-component-input".into(),
            schema_version: 1,
            behavior_version: 1,
        }
    );
    assert_eq!(
        generation_service_input_contract().id,
        "tsumugi.work-plan-generation-input"
    );

    let empty = component_input(vec![]);
    assert_eq!(
        parse_generation_component_input(&serde_json::to_vec(&empty).unwrap()).unwrap(),
        empty
    );

    let selected = component_input(vec![
        prepared(
            1,
            "Find the name 東京 in this passage: 雨のあとに虹が出た。",
        ),
        prepared(2, "csv\n名前,場所\n葵,札幌\n"),
    ]);
    let bytes = serde_json::to_vec(&selected).unwrap();
    let parsed = parse_generation_component_input(&bytes).unwrap();
    assert_eq!(parsed, selected);
    assert_eq!(parsed.generation, generation());
    assert_eq!(
        parsed.prepared_tools[0].input.utf8,
        "Find the name 東京 in this passage: 雨のあとに虹が出た。"
    );
    assert_eq!(
        parsed.prepared_tools[1].input.utf8,
        "csv\n名前,場所\n葵,札幌\n"
    );
}

#[test]
fn component_input_rejects_duplicate_or_invalid_identities_and_bad_payloads() {
    let base = component_input(vec![prepared(1, "query"), prepared(2, "query")]);
    for field in ["handleId", "callId", "toolHandle"] {
        let mut duplicate = base.clone();
        match field {
            "handleId" => {
                duplicate.prepared_tools[1].handle_id =
                    duplicate.prepared_tools[0].handle_id.clone();
            }
            "callId" => {
                duplicate.prepared_tools[1].call_id = duplicate.prepared_tools[0].call_id.clone();
            }
            _ => {
                duplicate.prepared_tools[1].tool_handle =
                    duplicate.prepared_tools[0].tool_handle.clone();
            }
        }
        assert_eq!(
            duplicate.validate().unwrap_err().code,
            ContractErrorCode::DuplicateIdentity,
            "{field}"
        );
    }

    for field in ["handleId", "callId", "toolHandle"] {
        let mut invalid = base.clone();
        match field {
            "handleId" => invalid.prepared_tools[0].handle_id = "bad id".into(),
            "callId" => invalid.prepared_tools[0].call_id = "bad id".into(),
            _ => invalid.prepared_tools[0].tool_handle = "bad id".into(),
        }
        assert_eq!(
            invalid.validate().unwrap_err().code,
            ContractErrorCode::InvalidDeclaration,
            "{field}"
        );
    }

    let mut bad_digest = component_input(vec![prepared(1, "plain text")]);
    bad_digest.prepared_tools[0].input.sha256 = "0".repeat(64);
    assert_eq!(
        bad_digest.validate().unwrap_err().code,
        ContractErrorCode::ResultMismatch
    );

    let mut bad_schema = component_input(vec![prepared(1, "plain text")]);
    bad_schema.prepared_tools[0].input.schema.schema_version = 0;
    assert_eq!(
        bad_schema.validate().unwrap_err().code,
        ContractErrorCode::InvalidDeclaration
    );

    assert_eq!(
        parse_generation_component_input(&[0xff]).unwrap_err().code,
        ContractErrorCode::InvalidSchema
    );
}

#[test]
fn component_input_rejects_unknown_fields_and_enforces_prepared_tool_count() {
    let valid = component_input(vec![prepared(1, "query")]);
    let mut unknown_top_level = serde_json::to_value(&valid).unwrap();
    unknown_top_level["unexpected"] = json!(true);
    assert_eq!(
        parse_generation_component_input(&serde_json::to_vec(&unknown_top_level).unwrap())
            .unwrap_err()
            .code,
        ContractErrorCode::InvalidSchema
    );

    let mut unknown_entry = serde_json::to_value(&valid).unwrap();
    unknown_entry["preparedTools"][0]["unexpected"] = json!(true);
    assert_eq!(
        parse_generation_component_input(&serde_json::to_vec(&unknown_entry).unwrap())
            .unwrap_err()
            .code,
        ContractErrorCode::InvalidSchema
    );

    let maximum = component_input(
        (0..MAX_PREPARED_TOOL_SERVICE_CALLS)
            .map(|index| prepared(index, "query"))
            .collect(),
    );
    let maximum_bytes = serde_json::to_vec(&maximum).unwrap();
    assert_eq!(
        parse_generation_component_input(&maximum_bytes).unwrap(),
        maximum
    );

    let overflow = component_input(
        (0..=MAX_PREPARED_TOOL_SERVICE_CALLS)
            .map(|index| prepared(index, "query"))
            .collect(),
    );
    assert_eq!(
        parse_generation_component_input(&serde_json::to_vec(&overflow).unwrap())
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
}

fn encoded_input_at_size(size: usize, escaped: bool) -> GenerationComponentInput {
    let empty = component_input(vec![prepared(1, "")]);
    let base_size = serde_json::to_vec(&empty).unwrap().len();
    let additional_size = size - base_size;
    let utf8 = if escaped {
        let escaped_characters = additional_size / 6;
        let ascii_characters = additional_size % 6;
        format!(
            "{}{}",
            "\u{1}".repeat(escaped_characters),
            "x".repeat(ascii_characters)
        )
    } else {
        "x".repeat(additional_size)
    };
    let value = component_input(vec![prepared(1, utf8)]);
    assert_eq!(serde_json::to_vec(&value).unwrap().len(), size);
    value
}

#[test]
fn component_input_counts_escaped_json_bytes_at_the_complete_size_limit() {
    let exact = encoded_input_at_size(MAX_GENERATION_COMPONENT_INPUT_BYTES, true);
    let exact_bytes = serde_json::to_vec(&exact).unwrap();
    assert_eq!(exact_bytes.len(), MAX_GENERATION_COMPONENT_INPUT_BYTES);
    assert_eq!(
        parse_generation_component_input(&exact_bytes).unwrap(),
        exact
    );

    let oversized = encoded_input_at_size(MAX_GENERATION_COMPONENT_INPUT_BYTES + 1, true);
    let oversized_bytes = serde_json::to_vec(&oversized).unwrap();
    assert_eq!(
        oversized_bytes.len(),
        MAX_GENERATION_COMPONENT_INPUT_BYTES + 1
    );
    assert_eq!(
        parse_generation_component_input(&oversized_bytes)
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );

    let ascii_exact = encoded_input_at_size(MAX_GENERATION_COMPONENT_INPUT_BYTES, false);
    let ascii_bytes = serde_json::to_vec(&ascii_exact).unwrap();
    assert_eq!(ascii_bytes.len(), MAX_GENERATION_COMPONENT_INPUT_BYTES);
    assert_eq!(
        parse_generation_component_input(&ascii_bytes).unwrap(),
        ascii_exact
    );
}

#[test]
fn component_input_serializes_with_component_fields_and_keeps_generation_input_separate() {
    let value = component_input(vec![prepared(1, "lookup")]);
    let encoded: Value = serde_json::to_value(&value).unwrap();
    let component = encoded.as_object().unwrap();
    assert_eq!(component.len(), 2);
    assert!(component.contains_key("generation"));
    assert!(component.contains_key("preparedTools"));

    let generation = encoded["generation"].as_object().unwrap();
    assert_eq!(generation.len(), 3);
    for field in ["taskId", "attemptId", "unitIds"] {
        assert!(generation.contains_key(field), "{field}");
    }

    let prepared = encoded["preparedTools"][0].as_object().unwrap();
    assert_eq!(prepared.len(), 4);
    for field in ["handleId", "callId", "toolHandle", "input"] {
        assert!(prepared.contains_key(field), "{field}");
    }
}
