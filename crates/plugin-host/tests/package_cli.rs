#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::{
    ffi::{CString, OsStr, OsString},
    fs,
    os::unix::{ffi::OsStrExt, ffi::OsStringExt, fs::PermissionsExt},
    path::Path,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};
use tsumugi_plugin_host::PackageImage;
use tsumugi_plugin_sdk::{
    MAX_CAPABILITY_COMPATIBILITY_REQUEST_BYTES, parse_capability_compatibility_request,
};

fn invoke(args: &[&OsStr]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tsumugi-plugin-package"))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("package CLI blocked while inspecting synthetic input");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().unwrap()
}

fn inspect(root: &Path) -> Output {
    invoke(&[OsStr::new("inspect"), root.as_os_str()])
}

fn diagnose(root: &Path, request: &str) -> Output {
    invoke(&[
        OsStr::new("diagnose"),
        root.as_os_str(),
        OsStr::new(request),
    ])
}

fn request() -> serde_json::Value {
    serde_json::json!({
        "contributionId": "query",
        "contract": {"id": "example.query", "schemaVersion": 2, "behaviorVersion": 3},
        "profile": {"id": "example.text", "schemaVersion": 5, "behaviorVersion": 7}
    })
}

fn package(root: &Path, marker: &Path) {
    let manifest = serde_json::json!({
        "protocolVersion": 1,
        "plugin": {"publisher": "org.example", "id": "diagnostic", "version": "0.1.0"},
        "permissions": [{"kind": "captured-input"}],
        "components": [{
            "id": "worker", "scope": "project", "runtime": "native-worker",
            "entrypoint": "worker", "dependencies": [],
            "exit": {"stopTimeoutMs": 100, "cleanupTimeoutMs": 100}
        }],
        "contributions": [{
            "id": "query", "componentId": "worker", "contribution": {
                "kind": "capability", "declaration": {
                    "contract": {"id": "example.query", "schemaVersion": 2, "behaviorVersion": 3},
                    "inputSchema": {"id": "example.input", "schemaVersion": 1, "behaviorVersion": 1},
                    "outputSchema": {"id": "example.output", "schemaVersion": 1, "behaviorVersion": 1},
                    "errorSchema": {"id": "example.error", "schemaVersion": 1, "behaviorVersion": 1},
                    "profiles": [{"id": "example.text", "schemaVersion": 5, "behaviorVersion": 7}],
                    "effect": "read-only", "permissions": [{"kind": "captured-input"}],
                    "limits": {"maxInputBytes": 1024, "maxOutputBytes": 1024,
                        "concurrency": 1, "timeoutMs": 1000}
                }
            }
        }, {
            "id": "reference", "componentId": "worker", "contribution": {
                "kind": "resource", "schema": {"id": "example.reference", "schemaVersion": 1,
                    "behaviorVersion": 1}, "path": "reference.txt"
            }
        }]
    });
    fs::create_dir(root).unwrap();
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    fs::write(root.join("reference.txt"), b"synthetic reference\n").unwrap();
    let marker = marker.to_str().unwrap().replace('\'', "'\\''");
    fs::write(root.join("worker"), format!("#!/bin/sh\n: > '{marker}'\n")).unwrap();
    fs::set_permissions(root.join("worker"), fs::Permissions::from_mode(0o700)).unwrap();
}

fn rejected(output: &Output) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(!output.stderr.is_empty());
}

#[test]
fn original_inspect_output_keeps_exactly_its_five_fields_and_format() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    let marker = temporary.path().join("executed");
    package(&root, &marker);
    let expected = PackageImage::inspect_directory(&root, || true).unwrap();
    let output = inspect(&root);
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    let mut encoded = serde_json::to_vec_pretty(&expected).unwrap();
    encoded.push(b'\n');
    assert_eq!(output.stdout, encoded);
    let actual: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let fields = actual.as_object().unwrap();
    assert_eq!(fields.len(), 5);
    assert_eq!(actual["plugin"]["publisher"], "org.example");
    assert_eq!(actual["plugin"]["id"], "diagnostic");
    assert_eq!(actual["plugin"]["version"], "0.1.0");
    assert_eq!(actual["packageDigest"], expected.package_digest);
    assert_eq!(actual["manifestSha256"], expected.manifest_sha256);
    assert_eq!(actual["fileCount"].as_u64(), Some(3));
    assert_eq!(actual["byteCount"].as_u64(), Some(expected.byte_count));
    assert!(!marker.exists());
    assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 1);
}

#[test]
fn diagnose_outputs_complete_pinned_reports_and_distinct_compatibility_exit_codes() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    let marker = temporary.path().join("executed");
    package(&root, &marker);
    let compatible = request();
    let mut missing = request();
    missing["contributionId"] = "absent".into();
    let mut resource = request();
    resource["contributionId"] = "reference".into();
    let mut id = request();
    id["contract"]["id"] = "example.other".into();
    let mut schema = request();
    schema["contract"]["schemaVersion"] = 3.into();
    let mut behavior = request();
    behavior["contract"]["behaviorVersion"] = 4.into();
    let mut profile_required = request();
    profile_required["profile"] = serde_json::Value::Null;
    let mut profile = request();
    profile["profile"]["behaviorVersion"] = 8.into();
    for (selection, status) in [
        (compatible, "compatible"),
        (missing, "contribution-missing"),
        (resource, "not-callable"),
        (id, "contract-id-mismatch"),
        (schema, "contract-schema-mismatch"),
        (behavior, "contract-behavior-mismatch"),
        (profile_required, "profile-required"),
        (profile, "profile-unsupported"),
    ] {
        let encoded = serde_json::to_string(&selection).unwrap();
        let requirement = parse_capability_compatibility_request(encoded.as_bytes()).unwrap();
        let expected =
            PackageImage::inspect_directory_compatibility(&root, &requirement, || true).unwrap();
        let output = diagnose(&root, &encoded);
        assert_eq!(
            output.status.code(),
            Some(if status == "compatible" { 0 } else { 2 })
        );
        assert!(output.stderr.is_empty());
        let actual: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(actual, serde_json::to_value(&expected).unwrap());
        assert_eq!(actual.as_object().unwrap().len(), 2);
        assert_eq!(actual["compatibility"]["status"], status);
        assert_eq!(actual["compatibility"]["request"], selection);
        assert!(actual["compatibility"].get("componentId").is_some());
        assert!(actual["compatibility"].get("declaredContract").is_some());
        assert!(actual["compatibility"]["declaredProfiles"].is_array());
    }
    assert!(!marker.exists());
    assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 1);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
}

#[test]
fn request_json_is_strict_bounded_utf8_and_checked_before_package_capture() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("missing-package");
    let mut unknown = request();
    unknown["unexpected"] = true.into();
    let mut invalid_version = request();
    invalid_version["contract"]["schemaVersion"] = 0.into();
    let mut invalid_name = request();
    invalid_name["contributionId"] = "../query".into();
    for encoded in [
        "".to_owned(),
        "not JSON".to_owned(),
        "[]".to_owned(),
        "{}".to_owned(),
        format!("{} trailing", request()),
        r#"{"contributionId":"query","contributionId":"query","contract":{"id":"example.query","schemaVersion":2,"behaviorVersion":3},"profile":null}"#.into(),
        r#"{"contributionId":"query","contract":{"id":"example.query","schemaVersion":2,"schemaVersion":2,"behaviorVersion":3},"profile":null}"#.into(),
        r#"{"contributionId":"query","contract":{"id":"example.query","schemaVersion":2,"behaviorVersion":3},"profile":{"id":"example.text","schemaVersion":5,"behaviorVersion":7,"extra":true}}"#.into(),
        serde_json::to_string(&unknown).unwrap(),
        serde_json::to_string(&invalid_version).unwrap(),
        serde_json::to_string(&invalid_name).unwrap(),
    ] {
        let output = diagnose(&root, &encoded);
        rejected(&output);
        let diagnostic = String::from_utf8(output.stderr).unwrap();
        assert!(diagnostic.contains("compatibility."));
        assert!(!diagnostic.contains("CaptureFailed"));
    }
    let invalid_utf8 = OsString::from_vec(vec![0xff]);
    let output = invoke(&[
        OsStr::new("diagnose"),
        root.as_os_str(),
        invalid_utf8.as_os_str(),
    ]);
    rejected(&output);
    assert!(String::from_utf8(output.stderr).unwrap().contains("UTF-8"));
    let base = serde_json::to_string(&request()).unwrap();
    let oversized = format!(
        "{base}{}",
        " ".repeat(MAX_CAPABILITY_COMPATIBILITY_REQUEST_BYTES + 1 - base.len())
    );
    assert_eq!(oversized.len(), 4097);
    let output = diagnose(&root, &oversized);
    rejected(&output);
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("LimitExceeded")
    );

    let package_root = temporary.path().join("package");
    package(&package_root, &temporary.path().join("executed"));
    let at_limit = format!(
        "{base}{}",
        " ".repeat(MAX_CAPABILITY_COMPATIBILITY_REQUEST_BYTES - base.len())
    );
    let output = diagnose(&package_root, &at_limit);
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
}

#[test]
fn invalid_argument_shapes_have_no_json_stdout() {
    let root = OsStr::new("unused-package");
    let literal = serde_json::to_string(&request()).unwrap();
    for args in [
        vec![],
        vec![OsStr::new("inspect")],
        vec![OsStr::new("inspect"), root, OsStr::new(&literal)],
        vec![OsStr::new("diagnose")],
        vec![OsStr::new("diagnose"), root],
        vec![
            OsStr::new("diagnose"),
            root,
            OsStr::new(&literal),
            OsStr::new("extra"),
        ],
        vec![OsStr::new("unknown"), root],
    ] {
        let output = invoke(&args);
        rejected(&output);
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .starts_with("usage:")
        );
    }
}

#[test]
fn request_argument_is_a_literal_and_never_opens_files_or_fifos() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    package(&root, &temporary.path().join("executed"));
    let file = temporary.path().join("request.json");
    fs::write(&file, serde_json::to_vec(&request()).unwrap()).unwrap();
    let fifo = temporary.path().join("request-fifo");
    let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    for selection in [&file, &fifo] {
        let output = invoke(&[
            OsStr::new("diagnose"),
            root.as_os_str(),
            selection.as_os_str(),
        ]);
        rejected(&output);
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("InvalidSchema")
        );
    }
}

#[test]
fn unsafe_or_invalid_package_capture_fails_without_a_partial_report() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    let marker = temporary.path().join("executed");
    package(&root, &marker);
    let selection = serde_json::to_string(&request()).unwrap();
    let link = temporary.path().join("link");
    std::os::unix::fs::symlink(&root, &link).unwrap();
    for output in [inspect(&link), diagnose(&link, &selection)] {
        rejected(&output);
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("PackagePath")
        );
    }

    let worker = root.join("worker");
    fs::remove_file(&worker).unwrap();
    let name = CString::new(worker.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o700) }, 0);
    for output in [inspect(&root), diagnose(&root, &selection)] {
        rejected(&output);
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("PackagePath")
        );
    }
    fs::remove_file(&worker).unwrap();
    for output in [inspect(&root), diagnose(&root, &selection)] {
        rejected(&output);
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("MissingArtifact")
        );
    }
    fs::write(root.join("manifest.json"), b"{}").unwrap();
    rejected(&diagnose(&root, &selection));
    assert!(!marker.exists());
}
