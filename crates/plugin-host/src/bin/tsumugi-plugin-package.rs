//! Public, read-only fingerprints and declaration diagnostics for prebuilt packages.
use std::{
    io::{Read, Write},
    path::PathBuf,
};
use tsumugi_plugin_host::{MAX_PACKAGE_ARCHIVE_BYTES, PackageImage};
use tsumugi_plugin_sdk::parse_capability_compatibility_request;

fn print(value: &impl serde::Serialize) -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    std::io::stdout().lock().write_all(&bytes)?;
    Ok(())
}

fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if matches!(args.as_slice(), [command] if command.as_os_str() == "inspect-archive") {
        let mut bytes = Vec::new();
        std::io::stdin()
            .lock()
            .take((MAX_PACKAGE_ARCHIVE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        print(&PackageImage::inspect_archive(&bytes, || true)?)?;
        return Ok(0);
    }
    let (directory, request) = match args.as_slice() {
        [command, directory] if command.as_os_str() == "inspect" => (directory, None),
        [command, directory, request] if command.as_os_str() == "diagnose" => {
            // The request is a bounded JSON literal, never a path to open. Parse
            // it before package capture so bad input cannot trigger directory IO.
            let request = request
                .to_str()
                .ok_or("compatibility request must be UTF-8 JSON")?;
            (
                directory,
                Some(parse_capability_compatibility_request(request.as_bytes())?),
            )
        }
        _ => {
            return Err("usage: tsumugi-plugin-package inspect <prebuilt-directory> | inspect-archive < <candidate.tar> | diagnose <prebuilt-directory> <request-json>".into());
        }
    };
    // Canonicalizing would hide selected symlink ancestors. Make a relative
    // selection absolute without resolving it; the capture owner checks it.
    let selected = PathBuf::from(directory);
    let selected = if selected.is_absolute() {
        selected
    } else {
        std::env::current_dir()?.join(selected)
    };
    if let Some(request) = request {
        let inspection =
            PackageImage::inspect_directory_compatibility(&selected, &request, || true)?;
        let exit = if inspection.compatibility.is_compatible() {
            0
        } else {
            2
        };
        print(&inspection)?;
        Ok(exit)
    } else {
        print(&PackageImage::inspect_directory(&selected, || true)?)?;
        Ok(0)
    }
}

fn main() {
    match run() {
        Ok(exit) => std::process::exit(exit),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
