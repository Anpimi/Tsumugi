//! Public, read-only fingerprinting of prebuilt plugin candidates.
use std::{io::Write, path::PathBuf};
use tsumugi_plugin_host::PackageImage;

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 || args[0] != "inspect" {
        return Err("usage: tsumugi-plugin-package inspect <prebuilt-directory>".into());
    }
    // Canonicalizing would hide selected symlink ancestors. Make a relative
    // selection absolute without resolving it; the capture owner checks it.
    let selected = PathBuf::from(&args[1]);
    let selected = if selected.is_absolute() {
        selected
    } else {
        std::env::current_dir()?.join(selected)
    };
    let inspection = PackageImage::inspect_directory(&selected, || true)?;
    serde_json::to_writer_pretty(std::io::stdout().lock(), &inspection)?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
