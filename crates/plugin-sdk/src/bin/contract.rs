use std::{
    io::{Read, Write},
    path::PathBuf,
};
use tsumugi_plugin_sdk::*;

fn read(path: &std::ffi::OsStr, limit: usize) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    std::fs::File::open(PathBuf::from(path))?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err("input exceeds harness limit".into());
    }
    Ok(bytes)
}
fn print<T: serde::Serialize>(value: &T) -> Result<(), Box<dyn std::error::Error>> {
    serde_json::to_writer_pretty(std::io::stdout().lock(), value)?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let data_schemas: [(&str, fn() -> schemars::Schema); 15] = [
        ("review-check-input", review_check_input_schema),
        ("review-declaration", review_declaration_schema),
        ("review-check-error", review_check_error_schema),
        ("review-types", review_types_schema),
        ("build-input", build_input_schema),
        ("artifact-set", artifact_set_schema),
        ("artifact-check-input", artifact_check_input_schema),
        ("build-declaration", build_declaration_schema),
        ("build-error", build_error_schema),
        ("build-types", build_types_schema),
        (
            "translation-extraction-input",
            translation_extraction_input_schema,
        ),
        ("translation-exchange", translation_exchange_schema),
        (
            "translation-extraction-check-input",
            translation_extraction_check_input_schema,
        ),
        (
            "translation-import-declaration",
            translation_import_declaration_schema,
        ),
        ("translation-types", translation_types_schema),
    ];
    for (kind, schema) in data_schemas {
        if args.len() == 1 && args[0] == format!("schema-{kind}").as_str() {
            return print(&schema());
        }
        if args.len() == 2 && args[0] == format!("check-{kind}-schema").as_str() {
            let actual: serde_json::Value =
                serde_json::from_slice(&read(&args[1], MAX_INVOCATION_PAYLOAD_BYTES)?)?;
            if actual != serde_json::to_value(schema())? {
                return Err("generated schema differs from SDK source".into());
            }
            println!("Schema is current.");
            return Ok(());
        }
    }
    if args.len() == 2 {
        let bytes = |limit| read(&args[1], limit);
        if args[0] == "validate-review-check-input" {
            return print(&parse_review_check_input(&bytes(
                MAX_INVOCATION_PAYLOAD_BYTES,
            )?)?);
        }
        if args[0] == "validate-review-declaration" {
            return print(&parse_review_declaration(&bytes(
                MAX_REVIEW_DECLARATION_BYTES,
            )?)?);
        }
        if args[0] == "validate-review-check-error" {
            return print(&parse_review_check_error(&bytes(
                MAX_REVIEW_DECLARATION_BYTES,
            )?)?);
        }
        if args[0] == "validate-build-input" {
            return print(&parse_build_input(&bytes(MAX_INVOCATION_PAYLOAD_BYTES)?)?);
        }
        if args[0] == "validate-translation-extraction-input" {
            return print(&parse_translation_extraction_input(&bytes(
                MAX_EXCHANGE_BYTES,
            )?)?);
        }
        if args[0] == "validate-translation-exchange" {
            return print(&parse_translation_exchange(&bytes(MAX_EXCHANGE_BYTES)?)?);
        }
        if args[0] == "validate-translation-extraction-check-input" {
            return print(&parse_translation_extraction_check_input(&bytes(
                MAX_INVOCATION_PAYLOAD_BYTES,
            )?)?);
        }
        if args[0] == "validate-translation-import-declaration" {
            return print(&parse_translation_import_declaration(&bytes(
                MAX_TRANSLATION_IMPORT_DECLARATION_BYTES,
            )?)?);
        }
        if args[0] == "validate-artifact-set" {
            return print(&parse_artifact_set(&bytes(MAX_EXCHANGE_BYTES)?)?);
        }
        if args[0] == "validate-artifact-check-input" {
            return print(&parse_artifact_check_input(&bytes(
                MAX_INVOCATION_PAYLOAD_BYTES,
            )?)?);
        }
        if args[0] == "validate-build-declaration" {
            return print(&parse_build_declaration(&bytes(
                MAX_BUILD_DECLARATION_BYTES,
            )?)?);
        }
        if args[0] == "validate-build-error" {
            return print(&parse_build_error(&bytes(MAX_BUILD_DECLARATION_BYTES)?)?);
        }
    }
    if args.len() == 1 && args[0] == "schema" {
        return print(&manifest_schema());
    }
    if args.len() == 1 && args[0] == "schema-exchange" {
        return print(&exchange_schema());
    }
    if args.len() == 1 && args[0] == "schema-process" {
        return print(&process_schema());
    }
    if args.len() == 1 && args[0] == "schema-source-extraction-input" {
        return print(&source_extraction_input_schema());
    }
    if args.len() == 1 && args[0] == "schema-source-import-declaration" {
        return print(&source_import_declaration_schema());
    }
    if args.len() == 1 && args[0] == "schema-source-extraction-error" {
        return print(&source_extraction_error_schema());
    }
    if args.len() == 1 && args[0] == "schema-source-extraction-check-input" {
        return print(&source_extraction_check_input_schema());
    }
    if args.len() == 1 && args[0] == "schema-check-results" {
        return print(&check_results_schema());
    }
    if args.len() == 1 && args[0] == "schema-content-types" {
        return print(&source_extraction_types_schema());
    }
    if args.len() == 1 && args[0] == "profile-process" {
        return print(&process_profile());
    }
    if args.len() == 2 && args[0] == "validate-process" {
        return print(&parse_process_frame(&read(
            &args[1],
            MAX_PROCESS_FRAME_BYTES,
        )?)?);
    }
    if args.len() == 2
        && (args[0] == "check-schema"
            || args[0] == "check-exchange-schema"
            || args[0] == "check-process-schema"
            || args[0] == "check-source-extraction-input-schema"
            || args[0] == "check-source-import-declaration-schema"
            || args[0] == "check-source-extraction-error-schema"
            || args[0] == "check-source-extraction-check-input-schema"
            || args[0] == "check-check-results-schema"
            || args[0] == "check-content-types-schema")
    {
        let actual: serde_json::Value =
            serde_json::from_slice(&read(&args[1], MAX_EXCHANGE_BYTES)?)
                .map_err(|_| "invalid generated schema")?;
        let generated = if args[0] == "check-schema" {
            manifest_schema()
        } else if args[0] == "check-process-schema" {
            process_schema()
        } else if args[0] == "check-source-extraction-input-schema" {
            source_extraction_input_schema()
        } else if args[0] == "check-source-import-declaration-schema" {
            source_import_declaration_schema()
        } else if args[0] == "check-source-extraction-error-schema" {
            source_extraction_error_schema()
        } else if args[0] == "check-source-extraction-check-input-schema" {
            source_extraction_check_input_schema()
        } else if args[0] == "check-check-results-schema" {
            check_results_schema()
        } else if args[0] == "check-content-types-schema" {
            source_extraction_types_schema()
        } else {
            exchange_schema()
        };
        if actual != serde_json::to_value(generated)? {
            return Err("generated schema differs from SDK source".into());
        }
        println!("Schema is current.");
        return Ok(());
    }
    if args.len() == 2 && args[0] == "validate" {
        return print(parse_manifest(&read(&args[1], MAX_MANIFEST_BYTES)?)?.manifest());
    }
    if args.len() == 2 && args[0] == "validate-exchange" {
        return print(parse_exchange(&read(&args[1], MAX_EXCHANGE_BYTES)?)?.document());
    }
    if args.len() == 2 && args[0] == "validate-source-extraction-input" {
        return print(&parse_source_extraction_input(&read(
            &args[1],
            MAX_EXCHANGE_BYTES,
        )?)?);
    }
    if args.len() == 2 && args[0] == "validate-source-import-declaration" {
        return print(&parse_source_import_declaration(&read(
            &args[1],
            MAX_SOURCE_IMPORT_DECLARATION_BYTES,
        )?)?);
    }
    if args.len() == 2 && args[0] == "validate-source-extraction-error" {
        return print(&parse_source_extraction_error(&read(
            &args[1],
            MAX_SOURCE_EXTRACTION_ERROR_BYTES,
        )?)?);
    }
    if args.len() == 2 && args[0] == "validate-source-extraction-check-input" {
        return print(&parse_source_extraction_check_input(&read(
            &args[1],
            MAX_INVOCATION_PAYLOAD_BYTES,
        )?)?);
    }
    if args.len() == 2 && args[0] == "validate-check-results" {
        return print(&parse_check_results(&read(&args[1], MAX_EXCHANGE_BYTES)?)?);
    }
    if args.len() == 3 && args[0] == "match-translation-extraction" {
        let input = parse_translation_extraction_input(&read(&args[1], MAX_EXCHANGE_BYTES)?)?;
        let proposal = parse_translation_exchange(&read(&args[2], MAX_EXCHANGE_BYTES)?)?;
        validate_translation_extraction(&input, &proposal)?;
        return print(&proposal);
    }
    if args.len() == 3 && args[0] == "match-source-extraction" {
        let input = parse_source_extraction_input(&read(&args[1], MAX_EXCHANGE_BYTES)?)?;
        let exchange = parse_exchange(&read(&args[2], MAX_EXCHANGE_BYTES)?)?;
        let ExchangeBody::Content(content) = &exchange.document().body else {
            return Err("expected content exchange fixture".into());
        };
        validate_source_extraction(&input, content)?;
        return print(exchange.document());
    }
    if args.len() == 4 && args[0] == "match-result" {
        let request = parse_exchange(&read(&args[1], MAX_EXCHANGE_BYTES)?)?;
        let ExchangeBody::Request(request) = &request.document().body else {
            return Err("expected request fixture".into());
        };
        // This harness exercises channel association from an independent fixture;
        // it cannot authenticate a real channel or grant runtime authority.
        let channel: ProviderBinding = serde_json::from_slice(&read(&args[3], MAX_MANIFEST_BYTES)?)
            .map_err(|_| "invalid channel binding fixture")?;
        return print(
            receive_invocation_result(
                &read(&args[2], MAX_PROCESS_FRAME_BYTES)?,
                request,
                &channel,
            )?
            .document(),
        );
    }
    if args.len() == 3 && args[0] == "check-coverage" {
        let set = parse_exchange(&read(&args[1], MAX_EXCHANGE_BYTES)?)?;
        let results = parse_exchange(&read(&args[2], MAX_EXCHANGE_BYTES)?)?;
        let ExchangeBody::CheckSet(set) = &set.document().body else {
            return Err("expected captured check set fixture".into());
        };
        let ExchangeBody::CheckResults(results) = &results.document().body else {
            return Err("expected check results fixture".into());
        };
        let (core, domain) = set
            .requirements
            .iter()
            .cloned()
            .partition(|r| matches!(r.key.implementation, CheckImplementation::Core { .. }));
        let captured = capture_required_checks(set.policy.clone(), core, domain)?;
        let coverage = captured.evaluate(results)?;
        return print(
            &serde_json::json!({"coverageComplete": coverage.complete, "entries": coverage.entries.len()}),
        );
    }
    Err("usage: tsumugi-plugin-contract schema-review-check-input | schema-review-declaration | schema-review-check-error | schema-review-types | validate-review-check-input <file> | validate-review-declaration <file> | validate-review-check-error <file> | schema-build-input | schema-artifact-set | schema-artifact-check-input | schema-build-declaration | schema-build-error | schema-build-types | validate-build-input <file> | validate-artifact-set <file> | validate-artifact-check-input <file> | validate-build-declaration <file> | validate-build-error <file> | schema-translation-extraction-input | schema-translation-exchange | schema-translation-extraction-check-input | schema-translation-import-declaration | schema-translation-types | validate-translation-extraction-input <file> | validate-translation-exchange <file> | validate-translation-extraction-check-input <file> | validate-translation-import-declaration <file> | match-translation-extraction <input> <proposal> | check-<build-or-translation-or-review-kind>-schema <file> | schema | schema-exchange | schema-process | schema-source-extraction-input | schema-source-import-declaration | schema-source-extraction-error | schema-source-extraction-check-input | schema-check-results | schema-content-types | profile-process | check-schema <file> | check-exchange-schema <file> | check-process-schema <file> | check-source-extraction-input-schema <file> | check-source-import-declaration-schema <file> | check-source-extraction-error-schema <file> | check-source-extraction-check-input-schema <file> | check-check-results-schema <file> | check-content-types-schema <file> | validate <manifest> | validate-exchange <file> | validate-process <file> | validate-source-extraction-input <file> | validate-source-import-declaration <file> | validate-source-extraction-error <file> | validate-source-extraction-check-input <file> | validate-check-results <file> | match-source-extraction <input> <content-exchange> | match-result <request> <result> <channel-binding> | check-coverage <captured-set> <results>".into())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
