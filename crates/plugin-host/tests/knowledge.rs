use std::collections::BTreeMap;
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk as sdk;

fn contract(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn image(executable: bool) -> PackageImage {
    let manifest = sdk::PluginManifest {
        protocol_version: sdk::MANIFEST_PROTOCOL,
        plugin: sdk::PluginIdentity {
            publisher: "example".into(),
            id: "knowledge".into(),
            version: "0.1.0".into(),
        },
        permissions: vec![],
        components: vec![sdk::ComponentDeclaration {
            id: "reference".into(),
            scope: sdk::ComponentScope::Application,
            runtime: sdk::RuntimeKind::Data,
            entrypoint: None,
            dependencies: vec![],
            exit: sdk::ExitRequirements {
                stop_timeout_ms: 1000,
                cleanup_timeout_ms: 1000,
            },
        }],
        contributions: vec![
            sdk::ContributionDeclaration {
                id: "terms".into(),
                component_id: "reference".into(),
                contribution: sdk::ContributionKind::Resource {
                    schema: contract("example.terms"),
                    path: "terms.bin".into(),
                },
            },
            sdk::ContributionDeclaration {
                id: "guidance".into(),
                component_id: "reference".into(),
                contribution: sdk::ContributionKind::Skill {
                    path: "guidance.md".into(),
                },
            },
        ],
    };
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let files = BTreeMap::from([
        (
            "terms.bin".into(),
            PackageFile {
                bytes: vec![0, 255, 1],
                executable,
            },
        ),
        (
            "guidance.md".into(),
            PackageFile {
                bytes: "Guidance grants no permission.\n".as_bytes().to_vec(),
                executable,
            },
        ),
    ]);
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    PackageImage::capture(manifest, files, &digest).unwrap()
}

#[test]
fn generic_resource_and_skill_read_exact_captured_bytes_without_runtime() {
    let image = image(false);
    assert_eq!(
        image
            .resource_bytes("terms", &contract("example.terms"))
            .unwrap(),
        &[0, 255, 1]
    );
    assert_eq!(
        image.skill_bytes("guidance").unwrap(),
        b"Guidance grants no permission.\n"
    );
    let clone = image.clone();
    drop(image);
    assert_eq!(
        clone
            .resource_bytes("terms", &contract("example.terms"))
            .unwrap(),
        &[0, 255, 1]
    );
    assert_eq!(
        clone.manifest().manifest().components[0].runtime,
        sdk::RuntimeKind::Data
    );
}

#[test]
fn generic_read_refuses_wrong_kind_identity_behavior_and_executable_content() {
    let image = image(false);
    for (id, schema) in [
        ("missing", contract("example.terms")),
        ("guidance", contract("example.terms")),
        ("terms", contract("example.other")),
        (
            "terms",
            sdk::ContractRef {
                behavior_version: 2,
                ..contract("example.terms")
            },
        ),
        (
            "terms",
            sdk::ContractRef {
                schema_version: 2,
                ..contract("example.terms")
            },
        ),
    ] {
        assert_eq!(
            image.resource_bytes(id, &schema),
            Err(HostError::InvalidContract)
        );
    }
    assert_eq!(image.skill_bytes("terms"), Err(HostError::InvalidContract));
    assert_eq!(
        image.skill_bytes("missing"),
        Err(HostError::InvalidContract)
    );
    let executable = self::image(true);
    assert_eq!(
        executable.resource_bytes("terms", &contract("example.terms")),
        Err(HostError::InvalidContract)
    );
    assert_eq!(
        executable.skill_bytes("guidance"),
        Err(HostError::InvalidContract)
    );
}

#[cfg(all(unix, feature = "javascript-conformance"))]
#[path = "support/official.rs"]
mod official;

#[cfg(all(unix, feature = "javascript-conformance"))]
struct OwnedTemporary(tempfile::TempDir);
#[cfg(all(unix, feature = "javascript-conformance"))]
impl OwnedTemporary {
    fn new() -> Self {
        Self(
            tempfile::Builder::new()
                .prefix("tsumugi-knowledge-")
                .tempdir()
                .unwrap(),
        )
    }
    fn path(&self) -> &std::path::Path {
        self.0.path()
    }
}
#[cfg(all(unix, feature = "javascript-conformance"))]
impl Drop for OwnedTemporary {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        // The installation store seals its owned objects. Restore directory
        // write permission only inside this synthetic fixture before TempDir
        // removes it; do not traverse a link or touch a selected package tree.
        fn writable(path: &std::path::Path) {
            let Ok(metadata) = std::fs::symlink_metadata(path) else {
                return;
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return;
            }
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
            for child in std::fs::read_dir(path).unwrap() {
                writable(&child.unwrap().path());
            }
        }
        writable(self.path());
    }
}

#[cfg(all(unix, feature = "javascript-conformance"))]
#[test]
fn actual_knowledge_package_reopens_resources_and_runs_original_query_and_check_workers() {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let temporary = OwnedTemporary::new();
        let image = official::installed(temporary.path(), "philosophy");
        let resource = image.resource_bytes("terminology", &contract("org.tsumugi.examples.terminology-resource")).unwrap();
        let body: serde_json::Value = serde_json::from_slice(resource).unwrap();
        assert_eq!(body["authority"], "unadopted-editorial-suggestion");
        assert!(std::str::from_utf8(image.skill_bytes("concept-review").unwrap()).unwrap().contains("grants no tools"));
        let tool = image.capability_tool("agent-query-tool").unwrap();
        assert_eq!(tool.declaration.capability_id, "query");
        assert_eq!(tool.declaration.supporting_resources, vec!["terminology"]);
        assert_eq!(tool.declaration.skill.as_deref(), Some("concept-review"));
        let pin = serde_json::json!({"id":body["id"], "revision":body["revision"], "sha256":sdk::payload_digest(std::str::from_utf8(resource).unwrap())});
        let query = serde_json::json!({"resource":pin, "sourceLanguage":"en", "targetLanguage":"zh-CN",
            "queries":[{"id":"u-1", "text":"👩🏽‍💻 e\u{301} sound premises", "conceptIds":["soundness", "premise"]}]});
        let mut session = official::launch(&image, "query", temporary.path()).await;
        let binding = tool.capability;
        assert_eq!(binding, sdk::bind_capability(image.manifest(), "query", image.package_digest()).unwrap());
        let first_pid = session.channel().child_pid;
        let output = official::success_payload(official::invoke(&mut session, &binding, "query-1", &query).await);
        let output: serde_json::Value = serde_json::from_str(&output.utf8).unwrap();
        assert_eq!(output["basis"]["resource"], pin);
        assert_eq!(output["results"][0]["entries"][0]["preferredTarget"], "可靠性");
        assert_eq!(output["results"][0]["entries"][1]["preferredTarget"], "前提");
        let mut missing = query.clone(); missing["queries"][0]["text"] = "soundtrack".into();
        let empty = official::success_payload(official::invoke(&mut session, &binding, "query-empty", &missing).await);
        let empty: serde_json::Value = serde_json::from_str(&empty.utf8).unwrap();
        assert_eq!(empty["results"][0]["entries"], serde_json::json!([]));
        assert_ne!(empty["basis"]["querySha256"], output["basis"]["querySha256"]);
        let mut changed = query.clone(); changed["resource"]["revision"] = "other".into();
        let sdk::InvocationOutcome::Failed { error } = official::invoke(&mut session, &binding, "query-replaced", &changed).await else { panic!("replaced resource accepted") };
        assert_eq!(serde_json::from_str::<serde_json::Value>(&error.utf8).unwrap(), serde_json::json!({"code":"resource-mismatch"}));
        let closed = session.close().await;
        assert!(closed.cooperative_acknowledgement && closed.direct_child_reaped);

        let mut checker = official::launch(&image, "check", temporary.path()).await;
        assert_ne!(checker.channel().child_pid, first_pid);
        let binding = sdk::bind_capability(image.manifest(), "check", image.package_digest()).unwrap();
        let input = serde_json::json!({"resource":pin, "sourceLanguage":"en", "targetLanguage":"zh-CN", "items":[
            {"id":"u-1", "sourceText":"sound premises", "translationText":"👩🏽‍💻 前提", "conceptIds":["soundness", "premise"]},
            {"id":"u-2", "sourceText":"sound", "translationText":null, "conceptIds":["soundness"]}
        ]});
        let output = official::success_payload(official::invoke(&mut checker, &binding, "check-1", &input).await);
        let output: serde_json::Value = serde_json::from_str(&output.utf8).unwrap();
        assert_eq!(output["results"][0]["findings"][0]["preferredTarget"], "可靠性");
        assert_eq!(output["results"][0]["findings"][0]["range"], serde_json::json!({"encoding":"utf-16", "start":0, "end":10}));
        assert_eq!(output["results"][1]["status"], "unavailable");
        let closed = checker.close().await;
        assert!(closed.cooperative_acknowledgement && closed.direct_child_reaped);
        assert_eq!(image.resource_bytes("terminology", &contract("org.tsumugi.examples.terminology-resource")).unwrap(), resource);
    });
}
