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
    if args.len() == 1 && args[0] == "schema" {
        return print(&manifest_schema());
    }
    if args.len() == 1 && args[0] == "schema-exchange" {
        return print(&exchange_schema());
    }
    if args.len() == 1 && args[0] == "schema-process" {
        return print(&process_schema());
    }
    if args.len() == 1 && args[0] == "profile-process" {
        return print(&process_profile());
    }
    if args.len() == 2 && args[0] == "validate-process" {
        return print(&parse_process_frame(&read(&args[1], MAX_EXCHANGE_BYTES)?)?);
    }
    if args.len() == 2
        && (args[0] == "check-schema"
            || args[0] == "check-exchange-schema"
            || args[0] == "check-process-schema")
    {
        let actual: serde_json::Value =
            serde_json::from_slice(&read(&args[1], MAX_EXCHANGE_BYTES)?)
                .map_err(|_| "invalid generated schema")?;
        let generated = if args[0] == "check-schema" {
            manifest_schema()
        } else if args[0] == "check-process-schema" {
            process_schema()
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
            receive_invocation_result(&read(&args[2], MAX_EXCHANGE_BYTES)?, request, &channel)?
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
    Err("usage: tsumugi-plugin-contract schema | schema-exchange | schema-process | profile-process | check-schema <file> | check-exchange-schema <file> | check-process-schema <file> | validate <manifest> | validate-exchange <file> | validate-process <file> | match-result <request> <result> <channel-binding> | check-coverage <captured-set> <results>".into())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
