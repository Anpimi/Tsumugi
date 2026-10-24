//! Read-only inspection of prebuilt tool/Host trees, not distribution approval.
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    path::PathBuf,
};
use tsumugi_plugin_host::{CapturedRuntime, RuntimeInspectionRequest};

fn absolute(value: &std::ffi::OsStr) -> std::io::Result<PathBuf> {
    // Resolving symlinks here would conceal them from the capture owner.
    let selected = PathBuf::from(value);
    Ok(if selected.is_absolute() {
        selected
    } else {
        std::env::current_dir()?.join(selected)
    })
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 || args[0] != "inspect" {
        return Err("usage: tsumugi-plugin-runtime inspect <tool-directory> <host-directory> <inspection-request.json>".into());
    }
    let mut input = Vec::new();
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Refuse links and open a special file without waiting for its writer.
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_NOCTTY);
    }
    let file = options.open(&args[3])?;
    if !file.metadata()?.is_file() {
        return Err("inspection request must be a regular file".into());
    }
    file.take(4097).read_to_end(&mut input)?;
    if input.len() > 4096 {
        return Err("inspection request exceeds 4096 bytes".into());
    }
    let request: RuntimeInspectionRequest = serde_json::from_slice(&input)?;
    let inspection = CapturedRuntime::inspect_directories(
        &absolute(&args[1])?,
        &absolute(&args[2])?,
        &request,
        || true,
    )?;
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer_pretty(&mut stdout, &inspection)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
