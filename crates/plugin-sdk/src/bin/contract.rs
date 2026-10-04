use std::{
    io::{Read, Write},
    path::PathBuf,
};

use tsumugi_plugin_sdk::{MAX_MANIFEST_BYTES, manifest_schema, parse_manifest};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "schema" {
        serde_json::to_writer_pretty(std::io::stdout().lock(), &manifest_schema())?;
        println!();
        return Ok(());
    }
    if args.len() == 2 && args[0] == "check-schema" {
        let mut bytes = Vec::new();
        std::fs::File::open(PathBuf::from(&args[1]))?
            .take(MAX_MANIFEST_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err("schema input exceeds harness limit".into());
        }
        let actual: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "invalid generated schema")?;
        if actual != serde_json::to_value(manifest_schema())? {
            return Err("generated schema differs from SDK source".into());
        }
        println!("Schema is current.");
        return Ok(());
    }
    if args.len() != 2 || args[0] != "validate" {
        return Err("usage: tsumugi-plugin-contract schema | check-schema <schema.json> | validate <manifest.json>".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(PathBuf::from(&args[1]))?
        .take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    let manifest = parse_manifest(&bytes)?;
    // Print only the validated, explicit declaration, not permission state.
    serde_json::to_writer_pretty(std::io::stdout().lock(), manifest.manifest())?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
