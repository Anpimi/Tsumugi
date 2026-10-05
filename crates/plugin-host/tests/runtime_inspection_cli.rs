#![cfg(all(
    any(target_os = "macos", target_os = "linux"),
    any(target_arch = "aarch64", target_arch = "x86_64")
))]

use std::{
    ffi::CString,
    fs,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn inspect(tool: &Path, host: &Path, request: &Path) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tsumugi-plugin-runtime"))
        .args(["inspect"])
        .args([tool, host, request])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("inspection CLI blocked on its request input");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().unwrap()
}

#[test]
fn cli_derives_complete_observation_without_executing_artifacts() {
    let temporary = tempfile::tempdir().unwrap();
    let tool = temporary.path().join("tool");
    let host = temporary.path().join("host");
    fs::create_dir(&tool).unwrap();
    fs::create_dir(&host).unwrap();
    fs::write(tool.join("node"), b"not executable program bytes").unwrap();
    fs::set_permissions(tool.join("node"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(host.join("main.js"), b"throw new Error('never execute');").unwrap();
    let request = temporary.path().join("request.json");
    fs::write(&request, br#"{"profile":"node-system-libraries-v1","toolVersion":"26.10.0","toolEntrypoint":"node","hostEntrypoint":"main.js"}"#).unwrap();
    let result = inspect(&tool, &host, &request);
    assert!(result.status.success());
    let result: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(result["fileCount"], 2);
    let descriptor: tsumugi_plugin_sdk::RuntimeEnvironmentDescriptor =
        serde_json::from_value(result["environment"].clone()).unwrap();
    assert_eq!(result["environmentDigest"], descriptor.digest().unwrap());
    assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 3);
    fs::write(&request, br#"{"profile":"node-system-libraries-v1","profile":"node-system-libraries-v1","toolVersion":"26.10.0","toolEntrypoint":"node","hostEntrypoint":"main.js"}"#).unwrap();
    assert!(!inspect(&tool, &host, &request).status.success());
    fs::write(&request, vec![b' '; 4097]).unwrap();
    assert!(!inspect(&tool, &host, &request).status.success());
}

#[test]
fn cli_refuses_fifo_and_link_requests_without_waiting_for_a_writer() {
    let temporary = tempfile::tempdir().unwrap();
    let fifo = temporary.path().join("request");
    let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let result = inspect(temporary.path(), temporary.path(), &fifo);
    assert!(!result.status.success());
    assert!(
        String::from_utf8(result.stderr)
            .unwrap()
            .contains("regular file")
    );
    let link = temporary.path().join("linked-request");
    std::os::unix::fs::symlink(&fifo, &link).unwrap();
    assert!(
        !inspect(temporary.path(), temporary.path(), &link)
            .status
            .success()
    );
}
